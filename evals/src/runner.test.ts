import type Anthropic from "@anthropic-ai/sdk";
import { OPEN_BRAIN_GUIDE, SKILL_BODY, SKILL_NAME } from "@day13/instructions";
import { describe, expect, it } from "vitest";
import { HarnessError, fakeResult, phrasing, runConversation, type RunSpec } from "./runner.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";
import { fakeClient, scriptedClient } from "./testing.ts";
import { VARIANTS } from "./variants.ts";

const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!;
const spec = (s: Scenario, variant = "claude-tools", trial = 0): RunSpec => ({ scenario: s, variant: VARIANTS[variant]!, trial, model: "claude-opus-5-5", effort: "medium" });

describe("runConversation", () => {
  it("plays each turn, answers every tool call with its fake, and records what was called", async () => {
    const client = scriptedClient((text, turn) =>
      turn === 0 ? [{ type: "tool_use", name: "open_brain", input: {} }] : [{ type: "tool_use", name: "capture", input: { text } }],
    );
    const transcript = await runConversation(client, spec(scenario("mid-conversation")));

    expect(transcript.status).toBe("ok");
    expect(transcript.turns.map((t) => t.calls.map((c) => c.role))).toEqual([["open"], ["capture"]]);
    expect(transcript.turns[1]!.calls[0]!.input).toEqual({ text: "ta. oh and remind me to book the MOT before the 30th" });
    expect(transcript.turns.map((t) => t.text)).toEqual(["Sounds good.", "Sounds good."]);
    expect(transcript.usage.requests).toBe(4);

    const toolResult = client.requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(toolResult[0]!.content).toContain(OPEN_BRAIN_GUIDE);
  });

  it("sends the model, effort and the variant's tools on every request", async () => {
    const client = scriptedClient(() => [{ type: "text", text: "Morning!" }]);
    await runConversation(client, spec(scenario("small-talk"), "claude-skill"));
    for (const request of client.requests) {
      expect(request.model).toBe("claude-opus-5-5");
      expect(request.output_config).toEqual({ effort: "medium" });
      expect(request.tools!.map((t) => ("name" in t ? t.name : t.type))).toEqual(["open_brain", "capture", "recall", "Skill"]);
    }
  });

  it("picks the phrasing for the trial", async () => {
    const client = scriptedClient(() => [{ type: "text", text: "ok" }]);
    const transcript = await runConversation(client, spec(scenario("todo-dump"), "claude-tools", 4));
    expect(transcript.turns[0]!.user).toBe(phrasing(scenario("todo-dump").turns[0]!.say, 4));
    expect(transcript.turns[0]!.user).toMatch(/^ugh/);
  });

  it("stops the conversation and marks it when the model refuses or runs out of room", async () => {
    const refused = await runConversation(fakeClient(() => ({ content: [], stop_reason: "refusal" })), spec(scenario("small-talk")));
    expect(refused.status).toBe("refusal");
    expect(refused.turns).toHaveLength(1);

    const clipped = await runConversation(fakeClient(() => ({ content: [{ type: "text", text: "Part of a reply" }], stop_reason: "max_tokens" })), spec(scenario("small-talk")));
    expect(clipped.status).toBe("truncated");
  });

  it("throws rather than scoring when another model answered or the tools loop forever", async () => {
    await expect(runConversation(fakeClient(() => ({ content: [{ type: "text", text: "hi" }], model: "claude-opus-5" })), spec(scenario("small-talk")))).rejects.toThrow(HarnessError);
    const looping = fakeClient(() => ({ content: [{ type: "tool_use", name: "recall", input: { query: "x" } }] }));
    await expect(runConversation(looping, spec(scenario("small-talk")))).rejects.toMatchObject({ kind: "tool_loop" });
  });
});

describe("fakeResult", () => {
  it("returns the scenario's recall result, or nothing found", () => {
    expect(fakeResult("recall", {}, scenario("refer-back")).content).toMatch(/pottery/);
    expect(fakeResult("recall", {}, scenario("small-talk")).content).toBe("Nothing found.");
  });

  it("loads the skill and errors on anything else", () => {
    expect(fakeResult("skill", { name: SKILL_NAME }, scenario("idea"))).toEqual({ content: SKILL_BODY });
    expect(fakeResult("skill", { name: "other" }, scenario("idea")).is_error).toBe(true);
    expect(fakeResult("unknown", {}, scenario("idea")).is_error).toBe(true);
  });
});
