import type Anthropic from "@anthropic-ai/sdk";
import { liveRequest } from "./claude";
import type { StreamEvent, ToolCall, Turn } from "./types";

export const MAX_ROUNDS = 4;

export interface TurnInput {
  client: Anthropic;
  model: string;
  context: string;
  /** The history, ending with the user's new message. */
  messages: Anthropic.MessageParam[];
  /** Looks something up in the person's notes and the reference notes, for the `recall` tool. */
  recall: (query: string) => string;
  /** Sends a stream event to the client as soon as it happens. */
  emit: (event: StreamEvent) => void;
  now?: () => string;
}

export interface TurnOutcome {
  /** The history to store, raw: thinking blocks go back to Claude unchanged. */
  messages: Anthropic.MessageParam[];
  turns: Turn[];
  facts: string[];
  timings: { first_text_ms: number | null; total_ms: number; rounds: number };
  usage: Pick<Anthropic.Usage, "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens">[];
}

export class TurnError extends Error {}

interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** Adds what the user just said to the history. If the last message is still theirs (a silent reply, or tool results waiting), it joins that one. */
export function appendUserText(messages: Anthropic.MessageParam[], text: string): Anthropic.MessageParam[] {
  const block: Anthropic.TextBlockParam = { type: "text", text };
  const last = messages.at(-1);
  if (last?.role === "user") return [...messages.slice(0, -1), { role: "user", content: [...blocks(last), block] }];
  return [...messages, { role: "user", content: [block] }];
}

/** Runs one turn: streams Claude's reply out as it comes, runs its tools here and goes round again until it has finished replying. */
export async function runTurn({ client, model, context, messages: history, recall, emit, now = () => new Date().toISOString() }: TurnInput): Promise<TurnOutcome> {
  const started = Date.now();
  let firstText: number | null = null;
  let spoke = false;
  const messages = [...history];
  const turns: Turn[] = [];
  const facts: string[] = [];
  const state: ToolState = { facts, recall };
  const usage: TurnOutcome["usage"] = [];
  const outcome = (rounds: number): TurnOutcome => ({ messages, turns, facts, timings: { first_text_ms: firstText, total_ms: Date.now() - started, rounds }, usage });

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const stream = client.messages.stream(liveRequest(model, context, messages));
    for await (const event of stream) {
      if (event.type === "content_block_start" && event.content_block.type === "text" && spoke) emit({ type: "text", delta: " " });
      if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
        firstText ??= Date.now() - started;
        spoke = true;
        emit({ type: "text", delta: event.delta.text });
      }
    }
    const message = await stream.finalMessage();
    usage.push(message.usage);
    if (message.stop_reason === "refusal") throw new TurnError("Claude declined to reply.");
    if (message.stop_reason === "max_tokens") throw new TurnError("The reply ran out of room.");

    const text = message.content
      .flatMap((b) => (b.type === "text" ? [b.text.trim()] : []))
      .filter(Boolean)
      .join(" ");
    const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    // The API rejects an empty assistant message, so a silent reply isn't stored and the user's next words join their open message.
    if (!text && !toolUses.length) return outcome(round);

    messages.push({ role: "assistant", content: message.content as Anthropic.ContentBlockParam[] });
    const recorded: ToolCall[] = [];
    const results = toolUses.map((use) => runTool(use, state, recorded));
    turns.push({ role: "assistant", at: now(), ...(text ? { text } : {}), ...(recorded.length ? { tool_calls: recorded } : {}) });

    if (!results.length) return outcome(round);
    // Every tool_use needs its result in the very next user message, all together.
    messages.push({ role: "user", content: results.map((r): Anthropic.ToolResultBlockParam => ({ type: "tool_result", ...r })) });
    if (message.stop_reason !== "tool_use") return outcome(round);
  }
  throw new TurnError(`Still calling tools after ${MAX_ROUNDS} rounds.`);
}

interface ToolState {
  facts: string[];
  recall: (query: string) => string;
}

/** Runs one tool call here in the Durable Object. A bad call goes back to Claude as an error result, so it can try again. */
function runTool(use: Anthropic.ToolUseBlock, state: ToolState, recorded: ToolCall[]): ToolResult {
  const failed = (content: string): ToolResult => ({ tool_use_id: use.id, content, is_error: true });
  if (use.name === "note") {
    const fact = (use.input as { fact?: unknown } | null)?.fact;
    if (typeof fact !== "string" || !fact.trim()) return failed("note needs {fact}: one short fact, never empty.");
    state.facts.push(fact.trim());
    recorded.push({ id: use.id, name: "note", input: { fact: fact.trim() } });
    return { tool_use_id: use.id, content: "saved" };
  }
  if (use.name === "recall") {
    const query = (use.input as { query?: unknown } | null)?.query;
    if (typeof query !== "string" || !query.trim()) return failed("recall needs {query}: a few plain words, never empty.");
    recorded.push({ id: use.id, name: "recall", input: { query: query.trim() } });
    return { tool_use_id: use.id, content: state.recall(query.trim()) };
  }
  return failed(`There's no tool called ${use.name}.`);
}

function blocks(message: Anthropic.MessageParam): Anthropic.ContentBlockParam[] {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}
