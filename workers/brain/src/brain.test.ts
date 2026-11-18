import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_MINUTES, REFLECTION_RETRY_MINUTES, TURN_FAILED, type NewSession, type NoteSummary, type SessionView, type UserBrain } from "./brain";
import { BATCH_ENTRY_CAP, QUIET_SECONDS } from "./log";
import { OPENING_LINE } from "./prompt";
import { aMinuteLater, api, brainFor, fakeDraft, fakeReflection, fakeUser, goneQuiet, mockClaude, mockWorkos, noTaskFields, readEvents } from "./testing";
import type { StreamEvent } from "./types";

beforeEach(() => {
  mockWorkos();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const said = (events: StreamEvent[]) => events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
const reflectionReply = (output: unknown = fakeReflection) => ({ content: [{ type: "text" as const, text: JSON.stringify(output) }] });
const draftReply = (output: unknown = fakeDraft) => reflectionReply(output);
const task = (title: string, due = "") => ({ kind: "task", title, detail: "Fake detail.", answer: "", topics: ["health"], ...noTaskFields, due });
const batches = (sub: string) => runInDurableObject(brainFor(sub), (_: UserBrain, state) => state.storage.sql.exec<{ id: string; user_entries: number; closed_at: string | null; close_reason: string | null; attempts: number; file_after: string; settled_at: string | null }>("SELECT * FROM batches ORDER BY started_at").toArray());

async function startSession(sub: string): Promise<NewSession> {
  const response = await api("/sessions", { sub, method: "POST" });
  expect(response.status).toBe(201);
  return response.json();
}

async function say(sub: string, sessionId: string, text: string): Promise<{ status: number; events: StreamEvent[] }> {
  const response = await api(`/sessions/${sessionId}/turns`, { sub, method: "POST", body: { text } });
  return { status: response.status, events: response.ok ? await readEvents<StreamEvent>(response) : [] };
}

const session = async (sub: string, id: string) => (await (await api(`/sessions/${id}`, { sub })).json()) as SessionView;

describe("a dump, start to finish", () => {
  it("streams replies, files what was said as soon as the call ends, and settles it once things go quiet", async () => {
    const sub = fakeUser();
    const { id, opening_line } = await startSession(sub);
    expect(opening_line).toBe(OPENING_LINE);

    const claude = mockClaude({ content: [{ type: "text", text: "Love that. What else?" }] });
    const turn = await say(sub, id, "I want to turn the shed into a tiny cinema");
    expect(said(turn.events)).toBe("Love that. What else?");
    expect(turn.events.at(-1)).toEqual({ type: "done", session_ended: false });
    expect(claude.requests[0].system[1].text).toContain("# Topics their notes are filed under\n\nNone yet.");

    const ended = await api(`/sessions/${id}/end`, { sub, method: "POST" });
    expect(ended.status).toBe(202);
    expect(await ended.json()).toMatchObject({ end_reason: "ended", reflection_status: "pending", user_turns: 1 });

    const quick = mockClaude(draftReply());
    expect(await runDurableObjectAlarm(brainFor(sub))).toBe(true);
    expect(quick.requests[0].model).toBe("claude-sonnet-5-5");
    expect(quick.requests[0].messages[0].content).toMatch(/\[\d\d:\d\d, voice call [0-9a-f]{8}\] User: I want to turn the shed into a tiny cinema/);
    expect(await session(sub, id)).toMatchObject({ reflection_status: "done", reflection: { note: expect.stringMatching(/^sessions\//) } });

    const ideas = (await (await api("/notes?kind=idea", { sub })).json()) as { notes: { path: string; title: string }[] };
    expect(ideas.notes).toEqual([expect.objectContaining({ title: "A fake shed cinema", path: expect.stringMatching(/^ideas\/\d{4}-\d{2}-\d{2}-a-fake-shed-cinema\.md$/) })]);
    const garden = await (await api("/notes/topics/garden.md", { sub })).json();
    expect(garden).toMatchObject({ kind: "topic", title: "garden", linked_from: expect.arrayContaining([ideas.notes[0].path]) });
    expect(((await (await api("/me", { sub })).json()) as { learned: string[] }).learned).toEqual([]);

    await goneQuiet(sub);
    const settle = mockClaude(reflectionReply());
    await runDurableObjectAlarm(brainFor(sub));
    expect(settle.requests[0].model).toBe("claude-opus-5-5");
    expect(settle.requests[0].messages[0].content).toContain("# Already filed from this log\n\n- A fake shed cinema (idea)");
    expect(((await (await api("/me", { sub })).json()) as { learned: string[] }).learned).toEqual(["Has a fake shed"]);
    expect(await batches(sub)).toEqual([expect.objectContaining({ close_reason: "idle", settled_at: expect.any(String) })]);

    const next = await startSession(sub);
    const later = mockClaude({ content: [{ type: "text", text: "Hello again." }] });
    await say(sub, next.id, "Hiya");
    expect(later.requests[0].system[1].text).toContain("- topics/garden.md (2 items)");
    expect(later.requests[0].system[1].text).toContain("A fake shed cinema");
  });

  it("finds earlier dumps with recall", async () => {
    const sub = fakeUser();
    const first = await startSession(sub);
    mockClaude({ content: [{ type: "text", text: "Noted." }] });
    await say(sub, first.id, "Shed cinema idea");
    await api(`/sessions/${first.id}/end`, { sub, method: "POST" });
    mockClaude(draftReply());
    await runDurableObjectAlarm(brainFor(sub));

    const second = await startSession(sub);
    const claude = mockClaude({ content: [{ type: "tool_use", id: "toolu_recall", name: "recall", input: { query: "shed cinema" } }] }, { content: [{ type: "text", text: "You wanted a shed cinema." }] });
    await say(sub, second.id, "What was my shed idea?");
    expect(claude.requests[1].messages.at(-1).content[0].content).toContain("Turn the fake shed into a tiny cinema.");
  });
});

describe("sessions", () => {
  it("drops a session nobody said anything in", async () => {
    const sub = fakeUser();
    const { id } = await startSession(sub);
    expect((await api(`/sessions/${id}/end`, { sub, method: "POST" })).status).toBe(204);
    expect((await api(`/sessions/${id}`, { sub })).status).toBe(404);
  });

  it("refuses a turn on a session that has ended", async () => {
    const sub = fakeUser();
    const { id } = await startSession(sub);
    mockClaude({ content: [{ type: "text", text: "Noted." }] });
    await say(sub, id, "One thing");
    await api(`/sessions/${id}/end`, { sub, method: "POST" });
    const response = await api(`/sessions/${id}/turns`, { sub, method: "POST", body: { text: "Another" } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "session_ended" });
  });

  it("ends the open session when a new one starts", async () => {
    const sub = fakeUser();
    const { id } = await startSession(sub);
    mockClaude({ content: [{ type: "text", text: "Noted." }] });
    await say(sub, id, "One thing");
    await startSession(sub);
    expect(await session(sub, id)).toMatchObject({ end_reason: "replaced", reflection_status: "pending" });
  });

  it("ends a session the client forgot about once it's been idle", async () => {
    const sub = fakeUser();
    const { id } = await startSession(sub);
    mockClaude({ content: [{ type: "text", text: "Noted." }] });
    await say(sub, id, "One thing");
    const quiet = new Date(Date.now() - (IDLE_MINUTES + 1) * 60_000).toISOString();
    await runInDurableObject(brainFor(sub), (_: UserBrain, state) => state.storage.sql.exec("UPDATE sessions SET last_message_at = ?", quiet));
    await goneQuiet(sub);
    mockClaude(reflectionReply());
    await runDurableObjectAlarm(brainFor(sub));
    expect(await session(sub, id)).toMatchObject({ end_reason: "idle", reflection_status: "done" });
  });

  it("saves nothing from a turn that fails, so the same words can be sent again", async () => {
    const sub = fakeUser();
    const { id } = await startSession(sub);
    mockClaude({ status: 400, message: "Bad request" });
    const turn = await say(sub, id, "One thing");
    expect(turn.events).toEqual([{ type: "error", message: TURN_FAILED }]);
    expect(await session(sub, id)).toMatchObject({ user_turns: 0, turns: [{ role: "assistant", text: OPENING_LINE }] });
  });
});

describe("the log", () => {
  it("keeps captures and voice turns in one batch, whichever app they came from and whatever starts in between", async () => {
    const sub = fakeUser();
    const brain = brainFor(sub) as unknown as UserBrain;
    await brain.capture("A fake idea", "Fake Chat");
    const { id } = await startSession(sub);
    mockClaude({ content: [{ type: "text", text: "Noted." }] });
    await say(sub, id, "A fake thought, out loud");
    await brain.capture("Another fake idea");
    expect(await batches(sub)).toEqual([expect.objectContaining({ user_entries: 3, closed_at: null })]);

    await aMinuteLater(sub);
    const quick = mockClaude(draftReply());
    await runDurableObjectAlarm(brainFor(sub));
    const log = quick.requests[0].messages[0].content as string;
    expect(log).toMatch(/\[\d\d:\d\d, Fake Chat\] User: A fake idea\n\[\d\d:\d\d, voice call [0-9a-f]{8}\] User: A fake thought, out loud\n\[\d\d:\d\d, voice call [0-9a-f]{8}\] Assistant: Noted\.\n\[\d\d:\d\d, another app\] User: Another fake idea/);
  });

  it("shows what isn't filed yet to recall, but not a voice session's own words back to it", async () => {
    const sub = fakeUser();
    const brain = brainFor(sub) as unknown as UserBrain;
    await brain.capture("Fake marrows need watering");
    const { id } = await startSession(sub);
    mockClaude({ content: [{ type: "text", text: "Noted." }] });
    await say(sub, id, "Fake marrows are doing well");
    const claude = mockClaude({ content: [{ type: "tool_use", id: "toolu_recall", name: "recall", input: { query: "fake marrows" } }] }, { content: [{ type: "text", text: "They need watering." }] });
    await say(sub, id, "What did I say about them?");
    const recalled = claude.requests[1].messages.at(-1).content[0].content as string;
    expect(recalled).toContain("Fake marrows need watering");
    expect(recalled).not.toContain("doing well");
    expect(await brain.recall("fake marrows")).toContain("Fake marrows are doing well");
  });

  it("closes a batch once it's full, and starts the next one", async () => {
    const sub = fakeUser();
    const brain = brainFor(sub) as unknown as UserBrain;
    for (let n = 1; n <= BATCH_ENTRY_CAP + 1; n++) await brain.capture(`Fake thing ${n}`);
    expect(await batches(sub)).toEqual([expect.objectContaining({ user_entries: BATCH_ENTRY_CAP, close_reason: "entry_cap" }), expect.objectContaining({ user_entries: 1, closed_at: null })]);
  });
});

describe("filing a batch that's still open", () => {
  const tasks = async (sub: string) => ((await (await api("/notes?kind=task", { sub })).json()) as { notes: NoteSummary[] }).notes;

  it("waits a minute after the last thing said", async () => {
    const sub = fakeUser();
    await (brainFor(sub) as unknown as UserBrain).capture("Book the fake dentist for Friday");
    const quick = mockClaude(draftReply());
    await runDurableObjectAlarm(brainFor(sub));
    expect(quick.requests).toEqual([]);
    const [batch] = await batches(sub);
    expect(Date.parse(batch.file_after)).toBeGreaterThan(Date.now() + (QUIET_SECONDS * 1000) / 2);
  });

  it("files it again when they change their mind, replacing what the first pass wrote", async () => {
    const sub = fakeUser();
    const brain = brainFor(sub) as unknown as UserBrain;
    await brain.capture("Book the fake dentist for Friday");
    await aMinuteLater(sub);
    mockClaude(draftReply({ summary: "Fake.", items: [task("Book the fake dentist for Friday", "2026-11-20"), task("Buy fake floss")] }));
    await runDurableObjectAlarm(brainFor(sub));
    expect((await tasks(sub)).map((t) => t.title).sort()).toEqual(["Book the fake dentist for Friday", "Buy fake floss"]);
    expect(await brain.recall("dentist")).not.toContain("Not filed yet");

    await brain.capture("Actually make the dentist Thursday, and forget the floss");
    expect(await brain.recall("dentist floss")).toContain("Not filed yet");
    await aMinuteLater(sub);
    const again = mockClaude(draftReply({ summary: "Fake.", items: [task("Book the fake dentist for Thursday", "2026-11-19")] }));
    await runDurableObjectAlarm(brainFor(sub));
    expect(again.requests[0].messages[0].content).toContain("- Book the fake dentist for Friday (task)");
    expect(await tasks(sub)).toEqual([expect.objectContaining({ title: "Book the fake dentist for Thursday", fields: expect.objectContaining({ due: "2026-11-19" }) })]);
    const health = (await (await api("/notes/topics/health.md", { sub })).json()) as { body: string };
    expect(health.body.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
  });

  it("leaves a task alone once the person has ticked it off", async () => {
    const sub = fakeUser();
    const brain = brainFor(sub) as unknown as UserBrain;
    await brain.capture("Buy fake floss");
    await aMinuteLater(sub);
    mockClaude(draftReply({ summary: "Fake.", items: [task("Buy fake floss")] }));
    await runDurableObjectAlarm(brainFor(sub));
    const [floss] = await tasks(sub);
    await api(`/notes/${floss.path}`, { sub, method: "PATCH", body: { status: "done" } });

    await brain.capture("Book the fake dentist");
    await aMinuteLater(sub);
    const again = mockClaude(draftReply({ summary: "Fake.", items: [task("Book the fake dentist")] }));
    await runDurableObjectAlarm(brainFor(sub));
    expect(again.requests[0].messages[0].content).toContain("- Buy fake floss (task): they've since changed this one themselves, so leave it out");
    expect((await tasks(sub)).map((t) => [t.title, t.fields.status]).sort()).toEqual([["Book the fake dentist", "open"], ["Buy fake floss", "done"]]);
    const health = (await (await api("/notes/topics/health.md", { sub })).json()) as { body: string };
    expect(health.body).toContain("Buy fake floss");
  });
});

describe("filing failures", () => {
  async function endedSession(sub: string): Promise<string> {
    const { id } = await startSession(sub);
    mockClaude({ content: [{ type: "text", text: "Noted." }] });
    await say(sub, id, "One thing");
    await api(`/sessions/${id}/end`, { sub, method: "POST" });
    return id;
  }

  it("tries again later when Claude is down", async () => {
    const sub = fakeUser();
    const id = await endedSession(sub);
    mockClaude({ status: 529, message: "Overloaded" }, { status: 529, message: "Overloaded" });
    await runDurableObjectAlarm(brainFor(sub));
    expect(await session(sub, id)).toMatchObject({ reflection_status: "pending" });
    const [batch] = await batches(sub);
    expect(batch.attempts).toBe(1);
    expect(Date.parse(batch.file_after)).toBeGreaterThan(Date.now() + (REFLECTION_RETRY_MINUTES[0] * 60_000) / 2);
  });

  it("drops a quick pass that will never fit, and gives up on the batch only when settling it fails too", async () => {
    const sub = fakeUser();
    const id = await endedSession(sub);
    mockClaude(draftReply({ summary: "No lists." }));
    await runDurableObjectAlarm(brainFor(sub));
    expect(await session(sub, id)).toMatchObject({ reflection_status: "pending" });
    const again = mockClaude(draftReply());
    await runDurableObjectAlarm(brainFor(sub));
    expect(again.requests).toEqual([]);

    await goneQuiet(sub);
    mockClaude(reflectionReply({ summary: "No lists." }));
    await runDurableObjectAlarm(brainFor(sub));
    expect(await session(sub, id)).toMatchObject({ reflection_status: "failed" });
  });
});
