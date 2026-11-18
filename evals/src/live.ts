import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cost, failures, renderTable, summarise } from "./report.ts";
import { HarnessError, runConversation, type ModelClient, type RunSpec, type Usage } from "./runner.ts";
import { SCENARIOS } from "./scenarios.ts";
import { score, type Check } from "./scorer.ts";
import { VARIANTS } from "./variants.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface Options {
  variants: string[];
  scenarios: string[];
  trials: number;
  model: string;
  effort: (typeof EFFORTS)[number];
  concurrency: number;
  dryRun: boolean;
}

const list = (value: string | undefined, all: string[]) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : all);

export function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      variant: { type: "string", default: "claude-skill" },
      scenario: { type: "string" },
      trials: { type: "string", default: "3" },
      model: { type: "string", default: DEFAULT_MODEL },
      effort: { type: "string", default: "medium" },
      concurrency: { type: "string", default: "4" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const options: Options = {
    variants: list(values.variant, Object.keys(VARIANTS)),
    scenarios: list(values.scenario, SCENARIOS.map((s) => s.id)),
    trials: Number(values.trials),
    model: values.model!,
    effort: values.effort as Options["effort"],
    concurrency: Number(values.concurrency),
    dryRun: values["dry-run"]!,
  };
  if (options.variants.includes("all")) options.variants = Object.keys(VARIANTS);
  const unknown = [...options.variants.filter((v) => !VARIANTS[v]), ...options.scenarios.filter((id) => !SCENARIOS.some((s) => s.id === id))];
  if (unknown.length) throw new Error(`Unknown variant or scenario: ${unknown.join(", ")}`);
  if (!Number.isInteger(options.trials) || options.trials < 1) throw new Error("--trials must be a whole number above zero");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("--concurrency must be a whole number above zero");
  if (!EFFORTS.includes(options.effort)) throw new Error(`--effort must be one of ${EFFORTS.join(", ")}`);
  return options;
}

export function plan(options: Options): RunSpec[] {
  const scenarios = SCENARIOS.filter((s) => options.scenarios.includes(s.id));
  return options.variants.flatMap((v) =>
    scenarios.flatMap((scenario) =>
      Array.from({ length: options.trials }, (_, trial) => ({ scenario, variant: VARIANTS[v]!, trial, model: options.model, effort: options.effort })),
    ),
  );
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const specs = plan(options);
  const turns = specs.reduce((n, s) => n + s.scenario.turns.length, 0);
  console.log(`${specs.length} conversations (${turns} turns) on ${options.model} at ${options.effort} effort: ${options.variants.join(", ")}`);
  if (options.dryRun) return;

  const sdk = new Anthropic({ maxRetries: 4, timeout: 180_000 });
  const client: ModelClient = { create: (params) => sdk.messages.create(params) };
  const dir = `results/${new Date().toISOString().replace(/[:.]/g, "-")}`;
  mkdirSync(dir, { recursive: true });

  const checks: Record<string, Check[]> = Object.fromEntries(options.variants.map((v) => [v, []]));
  const usage: Usage = { requests: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const errors: Record<string, number> = {};
  let done = 0;

  await pool(specs, options.concurrency, async (spec) => {
    const id = { scenario: spec.scenario.id, variant: spec.variant.name, trial: spec.trial };
    try {
      const transcript = await runConversation(client, spec);
      for (const key of Object.keys(usage) as (keyof Usage)[]) usage[key] += transcript.usage[key];
      if (transcript.status !== "ok") {
        errors[transcript.status] = (errors[transcript.status] ?? 0) + 1;
        appendFileSync(`${dir}/errors.jsonl`, `${JSON.stringify({ ...id, kind: transcript.status, transcript })}\n`);
      } else {
        const scored = score(spec.scenario, transcript);
        checks[spec.variant.name]!.push(...scored);
        appendFileSync(`${dir}/results.jsonl`, `${JSON.stringify({ ...id, transcript, checks: scored })}\n`);
      }
    } catch (e) {
      const kind = e instanceof HarnessError ? e.kind : e instanceof Anthropic.APIError ? `api_${e.status ?? "connection"}` : "harness";
      errors[kind] = (errors[kind] ?? 0) + 1;
      appendFileSync(`${dir}/errors.jsonl`, `${JSON.stringify({ ...id, kind, message: e instanceof Error ? e.message : String(e) })}\n`);
    }
    done += 1;
    if (done % 10 === 0 || done === specs.length) console.log(`  ${done}/${specs.length}`);
  });

  const all = Object.values(checks).flat();
  const spend = cost(options.model, usage);
  const summary = [
    renderTable(checks),
    "",
    "Failures (variant, scenario, turn, behaviour):",
    ...options.variants.flatMap((v) => failures(checks[v]!).map((c) => `  ${v} ${c.scenario} ${c.turn ?? "-"} ${c.behaviour}${c.detail ? ` (${c.detail})` : ""}`)),
    "",
    `Errors, not scored: ${Object.entries(errors).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`,
    `Usage: ${usage.requests} requests, ${usage.input_tokens} input, ${usage.cache_read_input_tokens} cache read, ${usage.cache_creation_input_tokens} cache write, ${usage.output_tokens} output tokens`,
    `Cost: ${spend === null ? "unknown for this model" : `about $${spend.toFixed(2)}`}`,
    `Transcripts: ${dir}`,
  ].join("\n");
  writeFileSync(`${dir}/summary.txt`, `${summary}\n`);
  console.log(`\n${summary}`);

  const short = options.variants.some((v) => summarise(checks[v]!).some((s) => !s.meets));
  if (short || !all.length) process.exitCode = 1;
}

if (import.meta.main) {
  await main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
