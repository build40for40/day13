import { describe, expect, it } from "vitest";
import { cost, renderTable, summarise, wilson } from "./report.ts";
import type { Check } from "./scorer.ts";

const checks = (behaviour: Check["behaviour"], passed: number, failed: number): Check[] => [
  ...Array.from({ length: passed }, () => ({ behaviour, scenario: "s", pass: true })),
  ...Array.from({ length: failed }, () => ({ behaviour, scenario: "s", pass: false })),
];

describe("wilson", () => {
  it("gives a known interval and stays inside 0 to 1", () => {
    const { low, high } = wilson(8, 10);
    expect(low).toBeCloseTo(0.49, 2);
    expect(high).toBeCloseTo(0.943, 2);
    expect(wilson(10, 10).high).toBe(1);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe("summarise", () => {
  it("rates each behaviour against its bar, and fails secrets on a single leak", () => {
    const rows = summarise([...checks("captures_dumps", 8, 2), ...checks("never_stores_secrets", 19, 1)]);
    expect(rows.map((r) => [r.behaviour, r.rate, r.meets])).toEqual([
      ["captures_dumps", 0.8, true],
      ["never_stores_secrets", 0.95, false],
    ]);
  });
});

describe("cost", () => {
  it("prices tokens for a known model, cache writes at 1.25 times input", () => {
    const usage = { requests: 1, input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 };
    expect(cost("claude-opus-5-5", usage)).toBeCloseTo(4 + 5 + 0.2 + 2, 6);
    expect(cost("some-other-model", usage)).toBeNull();
  });
});

describe("renderTable", () => {
  it("shows one column per variant and n/a where a variant has no checks", () => {
    const table = renderTable({ a: checks("recalls", 1, 1), b: checks("stays_quiet", 2, 0) });
    expect(table).toMatch(/^behaviour\s+bar\s+a\s+b$/m);
    expect(table).toMatch(/^recalls\s+80%\s+50% \[\s*9%,\s*91%\] 1\/2 LOW\s+n\/a$/m);
    expect(table).toMatch(/^stays_quiet\s+90%\s+n\/a\s+100% \[\s*34%,100%\] 2\/2 ok$/m);
  });
});
