import type Anthropic from "@anthropic-ai/sdk";
import { SKILL_BODY, SKILL_NAME, openBrainText } from "@day13/instructions";
import { NOTHING_FOUND, OPEN_SUMMARY, type Scenario } from "./scenarios.ts";
import { buildSurface, type Role, type Variant } from "./variants.ts";

/** The one call the runner makes. Live runs wrap the SDK; tests script the replies. */
export interface ModelClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export interface RunSpec {
  scenario: Scenario;
  variant: Variant;
  trial: number;
  model: Anthropic.Model;
  effort: NonNullable<Anthropic.OutputConfig["effort"]>;
}

export interface ToolCall {
  name: string;
  role: Role | "unknown";
  input: Record<string, unknown>;
}

export interface TurnRecord {
  user: string;
  text: string;
  calls: ToolCall[];
}

export type Status = "ok" | "refusal" | "truncated";

export interface Transcript {
  scenario: string;
  variant: string;
  trial: number;
  model: string;
  status: Status;
  turns: TurnRecord[];
  usage: Usage;
}

export interface Usage {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** A run that never produced anything to score. It goes in the errors file, never in the results. */
export class HarnessError extends Error {
  readonly kind: "tool_loop" | "model_mismatch";
  constructor(kind: "tool_loop" | "model_mismatch", message: string) {
    super(message);
    this.kind = kind;
  }
}

export const MAX_TOKENS = 16_000;
const MAX_ROUNDS_PER_TURN = 8;

export function phrasing(say: string | readonly string[], trial: number): string {
  return typeof say === "string" ? say : say[trial % say.length]!;
}

/** What each fake tool hands back. Nothing here calls out. */
export function fakeResult(role: Role | "unknown", input: Record<string, unknown>, scenario: Scenario): { content: string; is_error?: boolean } {
  switch (role) {
    case "open":
      return { content: openBrainText(OPEN_SUMMARY) };
    case "capture":
      return { content: "Saved." };
    case "recall":
      return { content: scenario.recallResult ?? NOTHING_FOUND };
    case "memory":
      return { content: "Remembered." };
    case "skill":
      return input.name === SKILL_NAME ? { content: SKILL_BODY } : { content: `No skill called ${String(input.name)}.`, is_error: true };
    case "unknown":
      return { content: "Unknown tool.", is_error: true };
  }
}

export async function runConversation(client: ModelClient, spec: RunSpec): Promise<Transcript> {
  const { scenario, variant, trial, model, effort } = spec;
  const { system, tools, roles } = buildSurface(variant);
  const messages: Anthropic.MessageParam[] = [];
  const usage: Usage = { requests: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const turns: TurnRecord[] = [];
  let status: Status = "ok";

  for (const turn of scenario.turns) {
    const record: TurnRecord = { user: phrasing(turn.say, trial), text: "", calls: [] };
    turns.push(record);
    messages.push({ role: "user", content: record.user });

    for (let round = 0; ; round++) {
      if (round === MAX_ROUNDS_PER_TURN) throw new HarnessError("tool_loop", `${scenario.id}: more than ${MAX_ROUNDS_PER_TURN} rounds in one turn`);
      const response = await client.create({
        model,
        max_tokens: MAX_TOKENS,
        system,
        tools,
        messages,
        output_config: { effort },
        cache_control: { type: "ephemeral" },
      });
      if (response.model !== model) throw new HarnessError("model_mismatch", `asked for ${model}, served by ${response.model}`);
      addUsage(usage, response.usage);
      messages.push({ role: "assistant", content: response.content });

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "text") record.text += block.text;
        if (block.type !== "tool_use") continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        const role = roles[block.name] ?? "unknown";
        record.calls.push({ name: block.name, role, input });
        results.push({ type: "tool_result", tool_use_id: block.id, ...fakeResult(role, input, scenario) });
      }

      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason === "tool_use" && results.length) {
        messages.push({ role: "user", content: results });
        continue;
      }
      if (response.stop_reason === "refusal") status = "refusal";
      if (response.stop_reason === "max_tokens") status = "truncated";
      break;
    }
    if (status !== "ok") break;
  }

  return { scenario: scenario.id, variant: variant.name, trial, model, status, turns, usage };
}

function addUsage(total: Usage, u: Anthropic.Usage): void {
  total.requests += 1;
  total.input_tokens += u.input_tokens;
  total.output_tokens += u.output_tokens;
  total.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
  total.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
}
