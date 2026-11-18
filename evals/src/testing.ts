import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "./runner.ts";

export type FakeBlock = { type: "text"; text: string } | { type: "tool_use"; name: string; input: Record<string, unknown> };

export interface FakeReply {
  content: FakeBlock[];
  stop_reason?: Anthropic.StopReason;
  model?: string;
}

/** Stands in for the Messages API. `reply` sees every request, already copied, and returns what the model "said". */
export function fakeClient(reply: (params: Anthropic.MessageCreateParamsNonStreaming, call: number) => FakeReply): ModelClient & { requests: Anthropic.MessageCreateParamsNonStreaming[] } {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let ids = 0;
  return {
    requests,
    async create(params) {
      const copy = structuredClone(params);
      requests.push(copy);
      const { content, stop_reason, model } = reply(copy, requests.length - 1);
      const blocks = content.map((b) => (b.type === "text" ? { type: "text", text: b.text, citations: null } : { type: "tool_use", id: `toolu_fake_${++ids}`, name: b.name, input: b.input }));
      return {
        id: `msg_fake_${requests.length}`,
        type: "message",
        role: "assistant",
        model: model ?? params.model,
        content: blocks,
        stop_reason: stop_reason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
      } as unknown as Anthropic.Message;
    },
  };
}

/** A fake that answers each user message with the given blocks, then a closing line once its tools have results. */
export function scriptedClient(perTurn: (userText: string, turn: number) => FakeBlock[], closing = "Sounds good."): ReturnType<typeof fakeClient> {
  return fakeClient((params) => {
    const last = params.messages.at(-1)!;
    if (typeof last.content !== "string") return { content: [{ type: "text", text: closing }] };
    const turn = params.messages.filter((m) => typeof m.content === "string").length - 1;
    return { content: perTurn(last.content, turn) };
  });
}
