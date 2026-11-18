import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TURN_FAILED } from "./brain";
import { BASE_PATH } from "./http";
import { api, fakeUser, mockClaude, mockWorkos } from "./testing";
import { VOICE_TURN_PATH } from "./voice";

beforeEach(() => {
  mockWorkos();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function startCall(sub: string): Promise<{ id: string; call_token: string }> {
  const response = await api("/voice/calls", { sub, method: "POST" });
  expect(response.status).toBe(201);
  return response.json();
}

/** A turn as the voice agent sends it: no sign-in, the call token in its system prompt. */
function agentTurn(token: string, said: string): Promise<Response> {
  const messages = [
    { role: "system", content: `You are a fake voice agent.\nDUMPLING_CALL=${token}` },
    { role: "assistant", content: "Hello." },
    { role: "user", content: said },
  ];
  return exports.default.fetch(`https://build40for40.com${BASE_PATH}${VOICE_TURN_PATH}`, { method: "POST", body: JSON.stringify({ model: "dumpling", stream: true, messages }) });
}

async function spoken(response: Response): Promise<string> {
  const frames = (await response.text()).split("\n\n").filter(Boolean).map((frame) => frame.replace(/^data: /, ""));
  expect(frames.at(-1)).toBe("[DONE]");
  const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame) as { choices: [{ delta: { content?: string }; finish_reason: string | null }] });
  expect(chunks.at(-1)?.choices[0].finish_reason).toBe("stop");
  return chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join("");
}

describe("voice calls", () => {
  it("answers the agent from the caller's own brain as Chat Completions chunks", async () => {
    const sub = fakeUser();
    const { id, call_token } = await startCall(sub);
    const claude = mockClaude({ content: [{ type: "text", text: "A fake shed cinema, lovely." }] });

    const response = await agentTurn(call_token, "I want a cinema in the fake shed");
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(await spoken(response)).toBe("A fake shed cinema, lovely.");
    expect(claude.requests[0].messages.at(-1).content).toEqual(expect.arrayContaining([expect.objectContaining({ text: "I want a cinema in the fake shed" })]));

    const session = (await (await api(`/sessions/${id}`, { sub })).json()) as { user_turns: number };
    expect(session.user_turns).toBe(1);
  });

  it("refuses a turn without the call's own token", async () => {
    const alice = await startCall(fakeUser());
    const bob = fakeUser();
    await startCall(bob);
    const secret = alice.call_token.split(".")[1];

    expect((await agentTurn(`${bob}.${secret}`, "Hello")).status).toBe(401);
    expect((await agentTurn("not-a-token", "Hello")).status).toBe(401);
  });

  it("stops answering an earlier call once a new one starts", async () => {
    const sub = fakeUser();
    const first = await startCall(sub);
    await startCall(sub);
    expect((await agentTurn(first.call_token, "Hello")).status).toBe(401);
  });

  it("speaks the apology when a turn fails", async () => {
    const { call_token } = await startCall(fakeUser());
    mockClaude({ status: 500, message: "fake outage" });
    expect(await spoken(await agentTurn(call_token, "Hello"))).toBe(TURN_FAILED);
  });
});
