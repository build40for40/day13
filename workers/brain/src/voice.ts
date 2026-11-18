import { error, HttpError, isPlainObject, readJson } from "./http";
import type { UserBrain } from "./brain";
import type { Rpc, StreamEvent } from "./types";

export const VOICE_TURN_PATH = "/voice/v1/chat/completions";
const CALL_TOKEN = /(?:^|\s)DUMPLING_CALL=(user_[A-Za-z0-9]+)\.([A-Za-z0-9_-]{43})(?=\s|$)/;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_TURN_CHARS = 8_000;

export const callToken = (userId: string, secret: string) => `${userId}.${secret}`;

/**
 * The voice agent's Custom LLM: an OpenAI Chat Completions endpoint that answers from the caller's own brain. The agent's
 * system prompt carries `DUMPLING_CALL=<token>`, which names the person and proves the call is theirs. Only the latest user
 * message is read, since the brain keeps the conversation itself.
 */
export async function voiceTurn(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return error(405, "method_not_allowed", undefined, { Allow: "POST" });
  const body = await readJson(request, MAX_BODY_BYTES);
  const messages = isPlainObject(body) && Array.isArray(body.messages) ? body.messages.filter(isPlainObject) : [];
  const text = (role: string) => messages.filter((message) => message.role === role).flatMap((message) => (typeof message.content === "string" ? [message.content] : []));
  const token = text("system").map((content) => content.match(CALL_TOKEN)).find(Boolean);
  if (!token) return error(401, "call_not_found");
  const said = text("user").at(-1)?.trim() ?? "";
  if (!said || said.length > MAX_TURN_CHARS) throw new HttpError(400, "invalid_turn");

  const [, userId, secret] = token;
  const brain = env.USER_BRAIN.get(env.USER_BRAIN.idFromName(userId)) as unknown as Rpc<Pick<UserBrain, "takeCallTurn">>;
  const turn = await brain.takeCallTurn(secret, said);
  if (!turn.ok || !turn.body) return turn;
  return new Response(turn.body.pipeThrough(new TextDecoderStream()).pipeThrough(toChatCompletion()).pipeThrough(new TextEncoderStream()), {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
  });
}

/** Rewrites the brain's own events as Chat Completions chunks. A failed turn is spoken as its apology. */
function toChatCompletion(): TransformStream<string, string> {
  const fields = { id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "dumpling" };
  const chunk = (delta: Record<string, string>, finish_reason: "stop" | null = null) => `data: ${JSON.stringify({ ...fields, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  let pending = "";
  let started = false;
  return new TransformStream({
    transform(part, controller) {
      pending += part;
      for (let end = pending.indexOf("\n\n"); end !== -1; end = pending.indexOf("\n\n")) {
        const data = pending.slice(0, end).split("\n").find((line) => line.startsWith("data: "));
        pending = pending.slice(end + 2);
        if (!data) continue;
        const event = JSON.parse(data.slice(6)) as StreamEvent;
        if (event.type === "done") controller.enqueue(`${chunk({}, "stop")}data: [DONE]\n\n`);
        else {
          const content = event.type === "text" ? event.delta : event.message;
          controller.enqueue(chunk(started ? { content } : { role: "assistant", content }));
          started = true;
          if (event.type === "error") controller.enqueue(`${chunk({}, "stop")}data: [DONE]\n\n`);
        }
      }
    },
  });
}
