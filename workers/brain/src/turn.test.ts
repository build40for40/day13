import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, liveRequest, thinkingFor } from "./claude";
import { LIVE_PROMPT } from "./prompt";
import { mockClaude } from "./testing";
import { appendUserText, MAX_ROUNDS, runTurn, TurnError } from "./turn";
import type { StreamEvent } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
});

function run(...replies: Parameters<typeof mockClaude>) {
  const claude = mockClaude(...replies);
  const events: StreamEvent[] = [];
  const outcome = runTurn({
    client: createClient(env.ANTHROPIC_API_KEY),
    model: "claude-sonnet-5-5",
    context: "context",
    messages: [{ role: "user", content: [{ type: "text", text: "Hiya there." }] }],
    recall: (query) => `notes about ${query}`,
    emit: (event) => events.push(event),
    now: () => "2026-11-10T18:00:00Z",
  });
  const said = () => events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
  return { claude, outcome, events, said };
}

describe("liveRequest", () => {
  it("sends tools, then the prompt and the cached context, then the conversation", () => {
    const request = liveRequest("claude-sonnet-5-5", "the context", [{ role: "user", content: "hi" }]);
    expect(request.system).toEqual([
      { type: "text", text: LIVE_PROMPT },
      { type: "text", text: "the context", cache_control: { type: "ephemeral" } },
    ]);
    expect(request.tools).toMatchObject([
      { name: "note", strict: true },
      { name: "recall", strict: true },
    ]);
    expect(request).toMatchObject({ model: "claude-sonnet-5-5", cache_control: { type: "ephemeral" }, output_config: { effort: "low" }, thinking: { type: "between_tools" } });
    expect(request).not.toHaveProperty("tool_choice");
  });

  it("picks the thinking setting each model accepts", () => {
    expect(thinkingFor("claude-sonnet-5-5")).toEqual({ type: "between_tools" });
    expect(thinkingFor("claude-haiku-5-5")).toEqual({ type: "disabled" });
    expect(thinkingFor("claude-opus-5-5")).toBeUndefined();
  });
});

describe("appendUserText", () => {
  it("starts a new user message after an assistant reply", () => {
    expect(appendUserText([{ role: "assistant", content: [{ type: "text", text: "Hi." }] }], "Hiya")).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Hi." }] },
      { role: "user", content: [{ type: "text", text: "Hiya" }] },
    ]);
  });

  it("joins a user message that's still open, after any tool results", () => {
    const open = [{ role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "toolu_1", content: "saved" }] }];
    expect(appendUserText(open, "And another thing")).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "saved" },
          { type: "text", text: "And another thing" },
        ],
      },
    ]);
  });
});

describe("runTurn", () => {
  it("streams the reply out as it comes and keeps it for the history", async () => {
    const { outcome, events, said } = run({ content: [{ type: "text", text: "Hiya back." }] });
    const result = await outcome;
    expect(events).toEqual([
      { type: "text", delta: "Hiya " },
      { type: "text", delta: "back." },
    ]);
    expect(said()).toBe("Hiya back.");
    expect(result.timings.first_text_ms).not.toBeNull();
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Hiya back." }] });
    expect(result.turns).toEqual([{ role: "assistant", at: "2026-11-10T18:00:00Z", text: "Hiya back." }]);
    expect(result.timings.rounds).toBe(1);
    expect(result.usage).toHaveLength(1);
  });

  it("runs note itself, hands the result back and carries on to the reply", async () => {
    const { claude, outcome, said } = run(
      {
        content: [
          { type: "text", text: "Noted." },
          { type: "tool_use", id: "toolu_note", name: "note", input: { fact: "  Works nights " } },
        ],
      },
      { content: [{ type: "text", text: "What else?" }] },
    );
    const result = await outcome;
    expect(result.facts).toEqual(["Works nights"]);
    expect(said()).toBe("Noted. What else?");
    expect(claude.requests).toHaveLength(2);
    expect(claude.requests[1].messages.at(-1)).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_note", content: "saved" }] });
    expect(result.turns).toEqual([
      { role: "assistant", at: "2026-11-10T18:00:00Z", text: "Noted.", tool_calls: [{ id: "toolu_note", name: "note", input: { fact: "Works nights" } }] },
      { role: "assistant", at: "2026-11-10T18:00:00Z", text: "What else?" },
    ]);
  });

  it("tells Claude what was wrong with a bad or unknown tool call instead of running it", async () => {
    const { claude, outcome, said } = run(
      {
        content: [
          { type: "tool_use", id: "bad_note", name: "note", input: { fact: "  " } },
          { type: "tool_use", id: "no_tool", name: "send_money", input: {} },
        ],
      },
      { content: [{ type: "text", text: "Sorry about that." }] },
    );
    const result = await outcome;
    expect(result.facts).toEqual([]);
    expect(claude.requests[1].messages.at(-1).content).toEqual([
      { type: "tool_result", tool_use_id: "bad_note", content: expect.stringContaining("never empty"), is_error: true },
      { type: "tool_result", tool_use_id: "no_tool", content: "There's no tool called send_money.", is_error: true },
    ]);
    expect(said()).toBe("Sorry about that.");
  });

  it("looks things up with recall and hands Claude what it found", async () => {
    const { claude, outcome, said } = run({ content: [{ type: "tool_use", id: "toolu_recall", name: "recall", input: { query: " fake trains " } }] }, { content: [{ type: "text", text: "You like fake trains." }] });
    const result = await outcome;
    expect(claude.requests[1].messages.at(-1)).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_recall", content: "notes about fake trains" }] });
    expect(result.turns[0]).toMatchObject({ tool_calls: [{ id: "toolu_recall", name: "recall", input: { query: "fake trains" } }] });
    expect(said()).toBe("You like fake trains.");
  });

  it("keeps a silent reply out of the history", async () => {
    const { outcome, said } = run({ content: [] });
    const result = await outcome;
    expect(said()).toBe("");
    expect(result.turns).toEqual([]);
    expect(result.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Hiya there." }] }]);
  });

  it("gives up on a refusal, a reply that ran out of room and endless tool calls", async () => {
    await expect(run({ content: [], stop_reason: "refusal" }).outcome).rejects.toThrow(TurnError);
    vi.restoreAllMocks();
    await expect(run({ content: [{ type: "text", text: "Too lo" }], stop_reason: "max_tokens" }).outcome).rejects.toThrow(TurnError);
    vi.restoreAllMocks();
    const forever = Array.from({ length: MAX_ROUNDS }, () => ({ content: [{ type: "tool_use" as const, name: "note", input: { fact: "again" } }] }));
    await expect(run(...forever).outcome).rejects.toThrow(`Still calling tools after ${MAX_ROUNDS} rounds.`);
  });

  it("fails when Claude is down or the stream breaks", async () => {
    await expect(run({ status: 529, message: "Overloaded" }, { status: 529, message: "Overloaded" }).outcome).rejects.toThrow();
    vi.restoreAllMocks();
    await expect(run({ breakAfter: [{ type: "text", text: "Hel" }] }).outcome).rejects.toThrow();
  });
});
