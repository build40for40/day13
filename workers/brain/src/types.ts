import type { JsonValue } from "./profile";

/** A tool the assistant ran during a turn. */
export interface ToolCall {
  id: string;
  name: "note" | "recall";
  input: { [key: string]: JsonValue };
}

/** One line of the transcript the reflection reads. Raw Claude messages are stored separately. */
export type Turn = { role: "user"; at: string; text: string } | { role: "assistant"; at: string; text?: string; tool_calls?: ToolCall[] };

/** What a turn streams back, one server-sent event each. `session_ended` means the next turn needs a new session. */
export type StreamEvent = { type: "text"; delta: string } | { type: "done"; session_ended: boolean } | { type: "error"; message: string };
