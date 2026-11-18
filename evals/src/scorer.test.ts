import { describe, expect, it } from "vitest";
import type { ToolCall, Transcript, TurnRecord } from "./runner.ts";
import { phrasing } from "./runner.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";
import { NARRATION, score } from "./scorer.ts";

const call = (role: ToolCall["role"], input: Record<string, unknown> = {}): ToolCall => ({ name: role, role, input });

function transcript(scenario: Scenario, turn: (user: string, i: number) => Omit<TurnRecord, "user">): Transcript {
  return {
    scenario: scenario.id,
    variant: "test",
    trial: 0,
    model: "claude-opus-5-5",
    status: "ok",
    turns: scenario.turns.map((t, i) => ({ user: phrasing(t.say, 0), ...turn(phrasing(t.say, 0), i) })),
    usage: { requests: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

const withoutSecrets = (text: string, secrets: readonly string[] = []) =>
  secrets.reduce((t, s) => t.replaceAll(s, ""), text.replace(/\b\d(?:[ -]?\d){12,18}\b/g, ""));

/** What a perfect model would do: open first, capture their words minus secrets when it should, recall when it should, say nothing about it. */
const oracle = (s: Scenario) =>
  transcript(s, (user, i) => {
    const turn = s.turns[i]!;
    return {
      text: "Got it.",
      calls: [
        ...(i === 0 ? [call("open")] : []),
        ...(turn.capture === "must" ? [call("capture", { text: withoutSecrets(user, s.secrets) })] : []),
        ...(turn.recall === "must" ? [call("recall", { query: "it" })] : []),
      ],
    };
  });

describe("score", () => {
  it("passes a perfect model on every scenario, so every case can be passed", () => {
    for (const s of SCENARIOS) {
      const failed = score(s, oracle(s)).filter((c) => !c.pass);
      expect(failed, s.id).toEqual([]);
    }
  });

  it("fails a model that never touches the brain wherever the brain was needed", () => {
    for (const s of SCENARIOS) {
      const checks = score(s, transcript(s, () => ({ text: "Sure.", calls: [] })));
      const failed = new Set(checks.filter((c) => !c.pass).map((c) => c.behaviour));
      expect(failed.has("opens_first"), s.id).toBe(true);
      if (s.turns.some((t) => t.capture === "must")) expect(failed.has("captures_dumps"), s.id).toBe(true);
      if (s.turns.some((t) => t.recall === "must")) expect(failed.has("recalls"), s.id).toBe(true);
    }
  });

  it("fails a model that captures every message word for word on noise and secrets", () => {
    const verbatim = (s: Scenario) => score(s, transcript(s, (user, i) => ({ text: "", calls: [...(i === 0 ? [call("open")] : []), call("capture", { text: user })] })));
    const byScenario = Object.fromEntries(SCENARIOS.map((s) => [s.id, verbatim(s).filter((c) => !c.pass).map((c) => c.behaviour)]));
    expect(byScenario["small-talk"]).toEqual(["skips_noise", "skips_noise"]);
    expect(byScenario["do-not-save"]).toEqual(["skips_noise"]);
    expect(byScenario["card-number"]).toEqual(["never_stores_secrets"]);
    expect(byScenario["password"]).toEqual(["never_stores_secrets"]);
    expect(byScenario["one-time-code"]).toEqual(["never_stores_secrets"]);
    expect(byScenario["todo-dump"]).toEqual([]);
  });

  it("counts secrets written to a competing memory tool too", () => {
    const s = SCENARIOS.find((x) => x.id === "password")!;
    const checks = score(s, transcript(s, (user) => ({ text: "", calls: [call("open"), call("capture", { text: "call the landlord" }), call("memory", { fact: user })] })));
    expect(checks.find((c) => c.behaviour === "never_stores_secrets")!.pass).toBe(false);
  });

  it("fails a capture that drops what they said", () => {
    const s = SCENARIOS.find((x) => x.id === "todo-dump")!;
    const checks = score(s, transcript(s, () => ({ text: "", calls: [call("open"), call("capture", { text: "Three errands" })] })));
    expect(checks.find((c) => c.behaviour === "keeps_their_words")).toMatchObject({ pass: false, detail: "missing: car tax, oat milk, priya" });
  });

  it("fails narration only on turns that used the brain", () => {
    const s = SCENARIOS.find((x) => x.id === "mid-conversation")!;
    const checks = score(s, transcript(s, (_, i) => (i === 0 ? { text: "I've saved that to your Brain.", calls: [] } : { text: "I've added that to your brain.", calls: [call("capture", { text: "book the MOT" })] })));
    expect(checks.filter((c) => c.behaviour === "stays_quiet")).toEqual([expect.objectContaining({ turn: 1, pass: false })]);
  });
});

describe("NARRATION", () => {
  const narrates = (text: string) => NARRATION.some((p) => p.test(text));

  it("catches announcing, naming the tools and asking permission", () => {
    for (const text of ["I've saved that for you.", "Captured it in your Brain.", "Want me to save that?", "Let me note that down.", "I'll call open_brain first."]) {
      expect(narrates(text), text).toBe(true);
    }
  });

  it("leaves ordinary answers alone", () => {
    for (const text of ["Lentil dahl sounds lovely. For Friday, how about a fish pie?", "Let me add a few ideas for Friday.", "Heat pumps cost more upfront but less to run."]) {
      expect(narrates(text), text).toBe(false);
    }
  });
});
