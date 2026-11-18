import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_MINUTES, REFLECTION_RETRY_MINUTES, TURN_FAILED, type NewSession, type SessionView, type UserBrain } from "./brain";
import { OPENING_LINE } from "./prompt";
import { api, brainFor, fakeReflection, fakeUser, mockClaude, mockWorkos, readEvents } from "./testing";
import type { StreamEvent } from "./types";

beforeEach(() => {
  mockWorkos();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const said = (events: StreamEvent[]) => events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
const reflectionReply = (output: unknown = fakeReflection) => ({ content: [{ type: "text" as const, text: JSON.stringify(output) }] });

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
  it("streams replies, then files what was said into notes under topics once it ends", async () => {
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

    const reflection = mockClaude(reflectionReply());
    expect(await runDurableObjectAlarm(brainFor(sub))).toBe(true);
    expect(reflection.requests[0].messages[0].content).toContain("User: I want to turn the shed into a tiny cinema");
    expect(await session(sub, id)).toMatchObject({ reflection_status: "done", reflection: { note: expect.stringMatching(/^sessions\//) } });

    const ideas = (await (await api("/notes?kind=idea", { sub })).json()) as { notes: { path: string; title: string }[] };
    expect(ideas.notes).toEqual([expect.objectContaining({ title: "A fake shed cinema", path: expect.stringMatching(/^ideas\/\d{4}-\d{2}-\d{2}-a-fake-shed-cinema\.md$/) })]);
    const garden = await (await api("/notes/topics/garden.md", { sub })).json();
    expect(garden).toMatchObject({ kind: "topic", title: "garden", linked_from: expect.arrayContaining([ideas.notes[0].path]) });

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
    mockClaude(reflectionReply());
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

describe("captures", () => {
  it("gather in one session until something ends it, like a voice session starting", async () => {
    const sub = fakeUser();
    const brain = brainFor(sub) as unknown as UserBrain;
    await brain.capture("A fake idea");
    await brain.capture("Another fake idea");
    const open = await runInDurableObject(brainFor(sub), (_: UserBrain, state) => state.storage.sql.exec<{ id: string; user_turns: number }>("SELECT id, user_turns FROM sessions").toArray());
    expect(open).toEqual([expect.objectContaining({ user_turns: 2 })]);

    await startSession(sub);
    expect(await session(sub, open[0].id)).toMatchObject({ end_reason: "replaced", reflection_status: "pending", turns: [{ role: "user", text: "A fake idea" }, { role: "user", text: "Another fake idea" }] });
    await brain.capture("A third fake idea");
    const captures = await runInDurableObject(brainFor(sub), (_: UserBrain, state) => state.storage.sql.exec("SELECT id FROM sessions WHERE model = 'capture'").toArray());
    expect(captures).toHaveLength(2);
  });
});

describe("reflection failures", () => {
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
    const retry = await runInDurableObject(brainFor(sub), (_: UserBrain, state) => state.storage.sql.exec<{ reflect_after: string; reflection_attempts: number }>("SELECT reflect_after, reflection_attempts FROM sessions").one());
    expect(retry.reflection_attempts).toBe(1);
    expect(Date.parse(retry.reflect_after)).toBeGreaterThan(Date.now() + (REFLECTION_RETRY_MINUTES[0] * 60_000) / 2);
  });

  it("gives up on output that will never fit", async () => {
    const sub = fakeUser();
    const id = await endedSession(sub);
    mockClaude(reflectionReply({ summary: "No lists." }));
    await runDurableObjectAlarm(brainFor(sub));
    expect(await session(sub, id)).toMatchObject({ reflection_status: "failed" });
  });
});
