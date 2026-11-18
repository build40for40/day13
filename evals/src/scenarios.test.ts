import { describe, expect, it } from "vitest";
import { SCENARIOS } from "./scenarios.ts";

const phrasings = (say: string | readonly string[]) => (typeof say === "string" ? [say] : [...say]);
const squash = (text: string) => text.toLowerCase().replace(/[\s-]/g, "");

describe("SCENARIOS", () => {
  it("have unique ids", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("say every word a capture must keep, in every phrasing", () => {
    for (const s of SCENARIOS)
      for (const turn of s.turns)
        for (const say of phrasings(turn.say)) for (const word of turn.captureIncludes ?? []) expect(say.toLowerCase(), `${s.id}: ${word}`).toContain(word);
  });

  it("say every secret they check for, in every phrasing, so the check means something", () => {
    for (const s of SCENARIOS)
      for (const secret of s.secrets ?? []) expect(phrasings(s.turns[0]!.say).every((say) => squash(say).includes(squash(secret))), `${s.id}: ${secret}`).toBe(true);
  });

  it("test both directions: things to capture and things to leave", () => {
    const expects = SCENARIOS.flatMap((s) => s.turns.map((t) => t.capture));
    expect(expects.filter((e) => e === "must").length).toBeGreaterThan(5);
    expect(expects.filter((e) => e === "never").length).toBeGreaterThan(3);
  });
});
