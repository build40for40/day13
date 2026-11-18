import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserBrain } from "../brain";
import { api, brainFor, callMcp, fakeReflection, aMinuteLater, fakeUser, goneQuiet, mockClaude, mockWorkos, noTaskFields, signInToMcp, type WorkosMock } from "../testing";
import { OPEN_BRAIN_GUIDE } from "@day13/instructions";
import { CAPTURED, NO_SUCH_NOTE, NO_SUCH_TASK, NOTHING_TO_CHANGE } from "./server";

let workos: WorkosMock;
beforeEach(() => {
  workos = mockWorkos();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const callTool = async (token: string, name: string, args: Record<string, unknown> = {}) => (await callMcp(token, "tools/call", { name, arguments: args })).rpc();
const toolText = (rpc: { result?: { content: { text: string }[] } }) => rpc.result!.content[0].text;

describe("the MCP tools", () => {
  it("lists every tool, with only the saving and changing ones able to write", async () => {
    const token = await signInToMcp(fakeUser(), workos);
    const { result } = await (await callMcp(token, "tools/list")).rpc();
    const hints = Object.fromEntries(result.tools.map((t: { name: string; annotations: { readOnlyHint: boolean } }) => [t.name, t.annotations.readOnlyHint]));
    expect(hints).toEqual({ open_brain: true, capture: false, recall: true, read_note: true, add_task: false, list_tasks: true, update_task: false, add_event: false, list_events: true, update_event: false });
  });

  it("opens the signed-in person's own brain", async () => {
    const alice = fakeUser();
    await api("/me", { sub: alice, method: "PATCH", body: { about: "# Fake Alice\n\nKeeps fake bees.\n" } });
    const brief = toolText(await callTool(await signInToMcp(alice, workos), "open_brain"));
    expect(brief.startsWith(OPEN_BRAIN_GUIDE)).toBe(true);
    expect(brief).toContain("Keeps fake bees.");
    expect(toolText(await callTool(await signInToMcp(fakeUser(), workos), "open_brain"))).not.toContain("Keeps fake bees.");
  });

  it("captures into the signed-in person's brain, and files it once things go quiet", async () => {
    const sub = fakeUser();
    const token = await signInToMcp(sub, workos);
    expect(toolText(await callTool(token, "capture", { text: "Build a fake shed cinema" }))).toBe(CAPTURED);
    await callTool(token, "capture", { text: "How long does it take to dry?", context: "fake shed paint", answer: "About two fake hours." });

    const entries = await runInDurableObject(brainFor(sub), (_: UserBrain, state) => state.storage.sql.exec<{ source: string; text: string }>("SELECT source, text FROM entries ORDER BY id").toArray());
    expect(entries).toEqual([
      { source: "app:Fake MCP client", text: "Build a fake shed cinema" },
      { source: "app:Fake MCP client", text: "How long does it take to dry?\n(Context: fake shed paint)\n(The AI they asked answered: About two fake hours.)" },
    ]);

    expect(toolText(await callTool(token, "open_brain"))).toContain("- Build a fake shed cinema");
    expect(toolText(await callTool(token, "recall", { query: "paint dry" }))).toContain("About two fake hours.");
    expect(toolText(await callTool(await signInToMcp(fakeUser(), workos), "recall", { query: "shed cinema" }))).toBe("Nothing in your notes matches that.");

    await goneQuiet(sub);
    const reflection = mockClaude({ content: [{ type: "text", text: JSON.stringify(fakeReflection) }] });
    await runDurableObjectAlarm(brainFor(sub));
    expect(reflection.requests[0].messages[0].content).toContain("Fake MCP client] User: Build a fake shed cinema");
    expect(toolText(await callTool(token, "recall", { query: "shed cinema" }))).toContain("Turn the fake shed into a tiny cinema.");
    expect(toolText(await callTool(token, "open_brain"))).toContain("Nothing waiting.");
  });

  it("only recalls from the signed-in person's brain", async () => {
    const alice = fakeUser();
    await api("/me", { sub: alice, method: "PATCH", body: { about: "# Fake Alice\n\nGrows fake marrows.\n" } });
    expect(toolText(await callTool(await signInToMcp(alice, workos), "recall", { query: "marrows" }))).toContain("Grows fake marrows.");
    expect(toolText(await callTool(await signInToMcp(fakeUser(), workos), "recall", { query: "marrows" }))).toBe("Nothing in your notes matches that.");
  });

  it("refuses an empty capture without saving anything", async () => {
    const sub = fakeUser();
    const token = await signInToMcp(sub, workos);
    await callTool(token, "open_brain");
    const rpc = await callTool(token, "capture", { text: "   " });
    expect(rpc.result?.isError ?? rpc.error).toBeTruthy();
    const entries = await runInDurableObject(brainFor(sub), (_: UserBrain, state) => state.storage.sql.exec("SELECT id FROM entries").toArray());
    expect(entries).toEqual([]);
  });

  it("adds a to-do straight away, lists it soonest first and ticks it off", async () => {
    const token = await signInToMcp(fakeUser(), workos);
    await callTool(token, "add_task", { title: "Paint the fake shed" });
    const added = toolText(await callTool(token, "add_task", { title: "Book the fake MOT", due: "2099-01-30", area: "work", people: ["Sam"], detail: "The garage on the fake high street." }));
    const path = added.match(/tasks\/\S+\.md/)![0];
    expect(path).toMatch(/^tasks\/\d{4}-\d{2}-\d{2}-book-the-fake-mot\.md$/);

    const listed = toolText(await callTool(token, "list_tasks"));
    expect(listed).toContain(`- ${path}: Book the fake MOT. Due 2099-01-30. Who: Sam. work.`);
    expect(listed.indexOf("Book the fake MOT")).toBeLessThan(listed.indexOf("Paint the fake shed"));
    expect(toolText(await callTool(token, "list_tasks", { area: "work" }))).not.toContain("Paint the fake shed");
    expect(toolText(await callTool(token, "recall", { query: "fake shed MOT", area: "work" }))).not.toContain("Paint the fake shed");
    expect(toolText(await callTool(token, "recall", { query: "fake shed MOT", area: "personal" }))).not.toContain("Book the fake MOT");
    expect(toolText(await callTool(token, "recall", { query: "garage high street" }))).toContain("Book the fake MOT");

    await callTool(token, "update_task", { path, due: "2099-02-02" });
    const moved = toolText(await callTool(token, "read_note", { path: path.replace(/\.md$/, "") }));
    expect(moved).toContain("Due 2099-02-02. Who: [[people/sam|Sam]].");
    expect(moved).not.toContain("2099-01-30");
    expect(toolText(await callTool(token, "read_note", { path: "people/sam" }))).toContain(`- [[${path.replace(/\.md$/, "")}|Book the fake MOT]]`);

    expect(toolText(await callTool(token, "update_task", { path, status: "done" }))).toBe(`Updated ${path}.`);
    expect(toolText(await callTool(token, "list_tasks"))).not.toContain("Book the fake MOT");
    expect(toolText(await callTool(token, "list_tasks", { status: "done" }))).toContain("Book the fake MOT");
  });

  it("adds an event, lists what's coming up and moves it", async () => {
    const token = await signInToMcp(fakeUser(), workos);
    const path = toolText(await callTool(token, "add_event", { title: "Fake school concert", start: "2099-03-21T19:30", location: "the fake hall" })).match(/events\/\S+\.md/)![0];
    await callTool(token, "add_event", { title: "Fake dentist", start: "2099-03-02" });
    await callTool(token, "add_event", { title: "A fake thing long ago", start: "2001-01-01" });

    const listed = toolText(await callTool(token, "list_events"));
    expect(listed).toContain(`- ${path}: Fake school concert. When: 2099-03-21 at 19:30. Where: the fake hall. personal.`);
    expect(listed.indexOf("Fake dentist")).toBeLessThan(listed.indexOf("Fake school concert"));
    expect(listed).not.toContain("long ago");
    expect(toolText(await callTool(token, "list_events", { from: "2099-03-10", to: "2099-03-31" }))).not.toContain("Fake dentist");

    await callTool(token, "update_event", { path, start: "2099-03-22T18:00", location: "none" });
    const moved = toolText(await callTool(token, "read_note", { path }));
    expect(moved).toContain("When: 2099-03-22T18:00.");
    expect(moved).not.toContain("the fake hall");
    await callTool(token, "update_event", { path, status: "dropped" });
    expect(toolText(await callTool(token, "list_events"))).not.toContain("Fake school concert");
  });

  it("refuses a change with nothing in it, a to-do that isn't one and another person's notes", async () => {
    const token = await signInToMcp(fakeUser(), workos);
    const task = toolText(await callTool(token, "add_task", { title: "Fake task" })).match(/tasks\/\S+\.md/)![0];
    const event = toolText(await callTool(token, "add_event", { title: "Fake event", start: "2099-03-02" })).match(/events\/\S+\.md/)![0];
    const errorOf = async (who: string, name: string, args: Record<string, unknown>) => {
      const { result } = await callTool(who, name, args);
      return result.isError ? result.content[0].text : "no error";
    };
    expect(await errorOf(token, "update_task", { path: task })).toBe(NOTHING_TO_CHANGE);
    expect(await errorOf(token, "update_task", { path: event, status: "done" })).toBe(NO_SUCH_TASK);
    expect(await errorOf(token, "update_task", { path: "USER.md", status: "done" })).toBe(NO_SUCH_TASK);
    expect(await errorOf(token, "add_task", { title: "Fake", due: "next friday" })).not.toBe("no error");
    expect(await errorOf(token, "add_event", { title: "Fake with no day" })).not.toBe("no error");

    const stranger = await signInToMcp(fakeUser(), workos);
    expect(await errorOf(stranger, "update_task", { path: task, status: "done" })).toBe(NO_SUCH_TASK);
    expect(await errorOf(stranger, "read_note", { path: task })).toBe(NO_SUCH_NOTE);
    expect(toolText(await callTool(stranger, "list_tasks"))).toMatch(/^No open to-dos match\./);
  });

  it("shows what's captured but not filed with the open to-dos, and tells the reflection what's already added", async () => {
    const sub = fakeUser();
    const token = await signInToMcp(sub, workos);
    await callTool(token, "add_task", { title: "Book the fake MOT", due: "2099-01-30" });
    await callTool(token, "capture", { text: "Thinking the fake shed needs a new roof" });
    expect(toolText(await callTool(token, "list_tasks"))).toContain("Captured but not filed yet, so there may be more in here:\n- Thinking the fake shed needs a new roof");

    await aMinuteLater(sub);
    const quick = mockClaude({ content: [{ type: "text", text: JSON.stringify({ summary: "Fake.", items: [{ kind: "task", title: "Fix the fake shed roof", detail: "Fake.", answer: "", topics: ["garden"], ...noTaskFields }] }) }] });
    await runDurableObjectAlarm(brainFor(sub));
    expect(quick.requests[0].messages[0].content).toContain("# Open to-dos and events already filed\n\n- Book the fake MOT. Due 2099-01-30.");

    await goneQuiet(sub);
    const settle = mockClaude({ content: [{ type: "text", text: JSON.stringify(fakeReflection) }] });
    await runDurableObjectAlarm(brainFor(sub));
    const shown = settle.requests[0].messages[0].content as string;
    expect(shown).toContain("# Already filed from this log\n\n- Fix the fake shed roof (task)");
    expect(shown.slice(shown.indexOf("# Open to-dos"), shown.indexOf("# Already filed"))).not.toContain("Fix the fake shed roof");
    expect(toolText(await callTool(token, "list_tasks"))).toContain("Book the fake MOT");
  });
});
