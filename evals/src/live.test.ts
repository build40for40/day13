import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, parseOptions, plan } from "./live.ts";
import { SCENARIOS } from "./scenarios.ts";
import { VARIANTS } from "./variants.ts";

describe("parseOptions", () => {
  it("defaults to the skill variant, every scenario and three trials", () => {
    expect(parseOptions([])).toEqual({
      variants: ["claude-skill"],
      scenarios: SCENARIOS.map((s) => s.id),
      trials: 3,
      model: DEFAULT_MODEL,
      effort: "medium",
      concurrency: 4,
      dryRun: false,
    });
  });

  it("takes comma-separated lists, and all for every variant", () => {
    expect(parseOptions(["--variant", "chatgpt, claude-tools", "--scenario", "idea"])).toMatchObject({ variants: ["chatgpt", "claude-tools"], scenarios: ["idea"] });
    expect(parseOptions(["--variant", "all"]).variants).toEqual(Object.keys(VARIANTS));
  });

  it("rejects unknown names and nonsense numbers", () => {
    expect(() => parseOptions(["--variant", "nope"])).toThrow(/nope/);
    expect(() => parseOptions(["--trials", "0"])).toThrow(/trials/);
    expect(() => parseOptions(["--effort", "lots"])).toThrow(/effort/);
  });
});

describe("plan", () => {
  it("runs every scenario for every variant and trial", () => {
    const specs = plan(parseOptions(["--variant", "chatgpt,claude-skill", "--scenario", "idea,small-talk", "--trials", "2"]));
    expect(specs).toHaveLength(8);
    expect(specs.map((s) => `${s.variant.name}/${s.scenario.id}/${s.trial}`).slice(0, 4)).toEqual(["chatgpt/idea/0", "chatgpt/idea/1", "chatgpt/small-talk/0", "chatgpt/small-talk/1"]);
  });
});
