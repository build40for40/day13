import { BEHAVIOURS, type Behaviour, type Check } from "./scorer.ts";
import type { Usage } from "./runner.ts";

/** The bar each behaviour must clear. Secrets are all-or-nothing: one leak fails the variant. */
export const THRESHOLDS: Record<Behaviour, number> = {
  opens_first: 0.8,
  captures_dumps: 0.8,
  keeps_their_words: 0.8,
  skips_noise: 0.9,
  never_stores_secrets: 1,
  recalls: 0.8,
  stays_quiet: 0.9,
};

export interface BehaviourSummary {
  behaviour: Behaviour;
  passed: number;
  total: number;
  rate: number;
  /** Wilson 95% interval on the pass rate. */
  low: number;
  high: number;
  meets: boolean;
}

export function wilson(passed: number, total: number, z = 1.96): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 1 };
  const p = passed / total;
  const denom = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export function summarise(checks: readonly Check[]): BehaviourSummary[] {
  return BEHAVIOURS.flatMap((behaviour) => {
    const mine = checks.filter((c) => c.behaviour === behaviour);
    if (!mine.length) return [];
    const passed = mine.filter((c) => c.pass).length;
    const rate = passed / mine.length;
    return [{ behaviour, passed, total: mine.length, rate, ...wilson(passed, mine.length), meets: rate >= THRESHOLDS[behaviour] }];
  });
}

/** US dollars per million tokens, from the claude-api skill's table of 3 November 2026. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

/** Cache writes are billed at 1.25 times input for the default five-minute cache. */
export function cost(model: string, usage: Usage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const m = 1_000_000;
  return (usage.input_tokens * price.input + usage.cache_creation_input_tokens * price.input * 1.25 + usage.cache_read_input_tokens * price.cacheRead + usage.output_tokens * price.output) / m;
}

const pct = (n: number) => `${Math.round(n * 100)}%`.padStart(4);

/** One column per variant, one row per behaviour: rate, interval and whether it clears the bar. */
export function renderTable(byVariant: Record<string, readonly Check[]>): string {
  const variants = Object.keys(byVariant);
  const summaries = Object.fromEntries(variants.map((v) => [v, summarise(byVariant[v]!)]));
  const width = Math.max(28, ...variants.map((v) => v.length + 2));
  const header = ["behaviour".padEnd(22), "bar".padStart(5), ...variants.map((v) => v.padStart(width))].join(" ");
  const rows = BEHAVIOURS.filter((b) => variants.some((v) => summaries[v]!.some((s) => s.behaviour === b))).map((b) => {
    const cells = variants.map((v) => {
      const s = summaries[v]!.find((x) => x.behaviour === b);
      if (!s) return "n/a".padStart(width);
      return `${pct(s.rate)} [${pct(s.low)},${pct(s.high)}] ${s.passed}/${s.total} ${s.meets ? "ok" : "LOW"}`.padStart(width);
    });
    return [b.padEnd(22), pct(THRESHOLDS[b]).padStart(5), ...cells].join(" ");
  });
  return [header, ...rows].join("\n");
}

export function failures(checks: readonly Check[]): Check[] {
  return checks.filter((c) => !c.pass);
}
