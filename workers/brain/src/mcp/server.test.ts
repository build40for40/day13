import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_MINUTES, type UserBrain } from "../brain";
import { api, brainFor, callMcp, fakeReflection, fakeUser, mockClaude, mockWorkos, signInToMcp, type WorkosMock } from "../testing";
import { OPEN_BRAIN_GUIDE } from "@day13/instructions";
import { CAPTURED } from "./server";

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
  it("lists open_brain, capture and recall, with only capture able to write", async () => {
    const token = await signInToMcp(fakeUser(), workos);
    const { result } = await (await callMcp(token, "tools/list")).rpc();
    const hints = Object.fromEntries(result.tools.map((t: { name: string; annotations: { readOnlyHint: boolean } }) => [t.name, t.annotations.readOnlyHint]));
    expect(hints).toEqual({ open_brain: true, capture: false, recall: true });
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

    const turns = await runInDurableObject(brainFor(sub), (_: UserBrain, state) => state.storage.sql.exec<{ turns: string }>("SELECT turns FROM sessions WHERE ended_at IS NULL").toArray());
    expect(turns.map((row) => JSON.parse(row.turns).map((t: { text: string }) => t.text))).toEqual([["Build a fake shed cinema", "How long does it take to dry?\n(Context: fake shed paint)\n(The AI they asked answered: About two fake hours.)"]]);

    const quiet = new Date(Date.now() - (IDLE_MINUTES + 1) * 60_000).toISOString();
    await runInDurableObject(brainFor(sub), (_: UserBrain, state) => state.storage.sql.exec("UPDATE sessions SET last_message_at = ?", quiet));
    const reflection = mockClaude({ content: [{ type: "text", text: JSON.stringify(fakeReflection) }] });
    await runDurableObjectAlarm(brainFor(sub));
    expect(reflection.requests[0].messages[0].content).toContain("User: Build a fake shed cinema");
    expect(toolText(await callTool(token, "recall", { query: "shed cinema" }))).toContain("Turn the fake shed into a tiny cinema.");
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
    const sessions = await runInDurableObject(brainFor(sub), (_: UserBrain, state) => state.storage.sql.exec("SELECT id FROM sessions").toArray());
    expect(sessions).toEqual([]);
  });
});
