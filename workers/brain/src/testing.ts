import { env, exports } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { vi } from "vitest";
import { BASE_PATH } from "./http";
import { workosAuthenticateUrl, workosIssuer, workosJwksUrl, workosUserUrl } from "./workos";

const KID = "test-key";
const keyPair = generateKeyPair("RS256", { extractable: true });
const jwks = keyPair.then(async ({ publicKey }) => ({ keys: [{ ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" }] }));

export const otherKey = generateKeyPair("RS256").then((pair) => pair.privateKey);

export interface TokenOptions {
  sub?: string;
  issuer?: string;
  expiresAt?: number;
  key?: CryptoKey;
}

/** A WorkOS access token signed with the test key, which `mockWorkos` serves as the JWKS. */
export async function signToken({ sub = "user_alice", issuer, expiresAt, key }: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: "session_fake" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setSubject(sub)
    .setIssuer(issuer ?? workosIssuer(env.WORKOS_CLIENT_ID))
    .setIssuedAt(now - 60)
    .setExpirationTime(expiresAt ?? now + 300)
    .sign(key ?? (await keyPair).privateKey);
}

export interface WorkosMock {
  deletedUsers: string[];
  deleteStatus: number;
  /** Sign-in codes WorkOS will accept, each for the user id it signs in. */
  codes: Map<string, string>;
}

export type ClaudeBlock = { type: "text"; text: string } | { type: "tool_use"; id?: string; name: string; input: unknown };

/** One scripted Messages API response: a streamed reply (held back until `after` settles, if given), an HTTP error, or a stream that breaks partway. */
export type ClaudeReply =
  | { content: ClaudeBlock[]; stop_reason?: "end_turn" | "tool_use" | "max_tokens" | "refusal"; after?: Promise<unknown> }
  | { status: number; message: string }
  | { breakAfter: ClaudeBlock[] };

export interface ClaudeMock {
  /** The JSON bodies sent to the Messages API, in order. */
  requests: Record<string, any>[];
  replies: ClaudeReply[];
}

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
let claudeMock: ClaudeMock | null = null;
let workosMock: WorkosMock | null = null;
let toolUseCount = 0;

function installFetchMock(): void {
  if (vi.isMockFunction(globalThis.fetch)) return;
  claudeMock = null;
  workosMock = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith(ANTHROPIC_MESSAGES_URL) && claudeMock) return claudeResponse(claudeMock, request);
    if (workosMock) {
      if (request.method === "GET" && request.url === workosJwksUrl(env.WORKOS_CLIENT_ID)) return Response.json(await jwks);
      if (request.method === "POST" && request.url === workosAuthenticateUrl) return workosAuthenticate(workosMock, request);
      const userId = decodeURIComponent(request.url.split("/").pop() ?? "");
      if (request.method === "DELETE" && request.url === workosUserUrl(userId)) {
        if (request.headers.get("Authorization") !== `Bearer ${env.WORKOS_API_KEY}`) return new Response(null, { status: 401 });
        workosMock.deletedUsers.push(userId);
        return new Response(null, { status: workosMock.deleteStatus });
      }
    }
    throw new Error(`Unexpected fetch: ${request.method} ${request.url}`);
  });
}

/** Stands in for the Claude Messages API, answering each request with the next scripted reply as a stream. */
export function mockClaude(...replies: ClaudeReply[]): ClaudeMock {
  installFetchMock();
  claudeMock = { requests: [], replies };
  return claudeMock;
}

/** Stands in for WorkOS: serves the test JWKS, trades sign-in codes, records user deletions and fails on any other outbound request. */
export function mockWorkos(): WorkosMock {
  installFetchMock();
  workosMock = { deletedUsers: [], deleteStatus: 202, codes: new Map() };
  return workosMock;
}

async function workosAuthenticate(mock: WorkosMock, request: Request): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  if (body.client_id !== env.WORKOS_CLIENT_ID || body.client_secret !== env.WORKOS_API_KEY) return Response.json({ error: "invalid_client" }, { status: 401 });
  const id = body.grant_type === "authorization_code" && typeof body.code === "string" ? mock.codes.get(body.code) : undefined;
  if (!id) return Response.json({ error: "invalid_grant", error_description: "The code is invalid." }, { status: 400 });
  mock.codes.delete(body.code as string);
  return Response.json({ user: { object: "user", id, first_name: "Fake" }, access_token: "fake-workos-access-token", refresh_token: "fake-workos-refresh-token" });
}

async function claudeResponse(mock: ClaudeMock, request: Request): Promise<Response> {
  const key = request.headers.get("x-api-key") ?? request.headers.get("Authorization")?.replace(/^Bearer /, "");
  if (key !== env.ANTHROPIC_API_KEY) return Response.json(apiError("authentication_error", "bad key"), { status: 401 });
  mock.requests.push(await request.json());
  const reply = mock.replies.shift();
  if (!reply) return Response.json(apiError("invalid_request_error", "No scripted reply left"), { status: 400 });
  if ("status" in reply) return Response.json(apiError("api_error", reply.message), { status: reply.status });
  if ("after" in reply) await reply.after;

  const blocks = "breakAfter" in reply ? reply.breakAfter : reply.content;
  const events: [string, unknown][] = [
    ["message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }],
  ];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      const middle = Math.ceil(block.text.length / 2);
      for (const text of [block.text.slice(0, middle), block.text.slice(middle)]) {
        if (text) events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }]);
      }
    } else {
      const id = block.id ?? `toolu_fake_${++toolUseCount}`;
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name: block.name, input: {} } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  if ("breakAfter" in reply) {
    events.push(["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]);
  } else {
    const stop_reason = reply.stop_reason ?? (blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
    events.push(["message_delta", { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } }]);
    events.push(["message_stop", { type: "message_stop" }]);
  }
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function apiError(type: string, message: string) {
  return { type: "error", error: { type, message } };
}

/** A raw reflection as Opus might return it, untidy on purpose. */
export const fakeReflection = {
  summary: "  Dumped a few fake things.   Ended happy. ",
  items: [
    { kind: "idea", title: "  A fake shed cinema ", detail: "Turn the fake shed into a tiny cinema.", answer: "should be dropped", topics: ["Garden", "garden", " Weekend Projects "] },
    { kind: "question", title: "How long does fake paint take to dry?", detail: "Asked about drying times.", answer: "About four fake hours.", topics: ["garden"] },
    { kind: "task", title: " ", detail: "No title, so it's dropped.", answer: "", topics: [] },
  ],
  facts: ["Has a fake shed", "Has a fake shed", " "],
  lessons: ["Short answers land best", " "],
};

let userCount = 0;

/** A new fake WorkOS user id. Storage isn't reset between tests, so each test that touches a brain makes its own user. */
export const fakeUser = () => `user_fake${++userCount}${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

/** Calls the Worker as a signed-in user, or signed out with `sub: null`. */
export async function api(path: string, { sub = "user_alice", method = "GET", body }: { sub?: string | null; method?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = sub === null ? {} : { Authorization: `Bearer ${await signToken({ sub })}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return exports.default.fetch(`https://build40for40.com${BASE_PATH}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
}

export const brainFor = (sub: string) => env.USER_BRAIN.get(env.USER_BRAIN.idFromName(sub));

/** Reads a server-sent event stream into its events' data. */
export async function readEvents<T = unknown>(response: Response): Promise<T[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const [eventLine, dataLine] = chunk.split("\n");
      const data = JSON.parse(dataLine.replace(/^data: /, "")) as { type: string };
      if (eventLine !== `event: ${data.type}`) throw new Error(`Event name ${eventLine} doesn't match ${data.type}`);
      return data as T;
    });
}

export const MCP_ORIGIN = new URL(env.MCP_RESOURCE).origin;
export const CLIENT_REDIRECT_URI = "https://client.example/callback";

/** The `name=value` pairs a response sets, ready to send back as a Cookie header. */
export function cookiesFrom(...responses: Response[]): string {
  return responses
    .flatMap((r) => r.headers.getSetCookie())
    .map((cookie) => cookie.split(";")[0])
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

/** Registers a fake public MCP client through dynamic client registration and returns its id. */
export async function registerMcpClient(): Promise<string> {
  const response = await exports.default.fetch(`${MCP_ORIGIN}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Fake MCP client", redirect_uris: [CLIENT_REDIRECT_URI], token_endpoint_auth_method: "none" }),
  });
  if (response.status !== 201) throw new Error(`Registration failed with ${response.status}`);
  return ((await response.json()) as { client_id: string }).client_id;
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return { verifier, challenge };
}

export function authorizeUrl(clientId: string, challenge: string): string {
  const params = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CLIENT_REDIRECT_URI, state: "client-state", code_challenge: challenge, code_challenge_method: "S256", resource: env.MCP_RESOURCE });
  return `${MCP_ORIGIN}/authorize?${params}`;
}

export const consentHandle = (html: string) => html.match(/name="handle" value="([^"]+)"/)?.[1] ?? "";

/** Signs a WorkOS user in to the MCP server the way Claude would, from registration to token, and returns the access token. */
export async function signInToMcp(sub: string, workos: WorkosMock): Promise<string> {
  const clientId = await registerMcpClient();
  const { verifier, challenge } = await pkce();
  const consent = await exports.default.fetch(authorizeUrl(clientId, challenge));
  const approved = await exports.default.fetch(`${MCP_ORIGIN}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookiesFrom(consent) },
    body: new URLSearchParams({ handle: consentHandle(await consent.text()), decision: "approve" }),
    redirect: "manual",
  });
  const state = new URL(approved.headers.get("Location")!).searchParams.get("state")!;
  workos.codes.set("fake-workos-code", sub);
  const callback = await exports.default.fetch(`${MCP_ORIGIN}/callback?code=fake-workos-code&state=${state}`, { headers: { Cookie: cookiesFrom(approved) }, redirect: "manual" });
  const code = new URL(callback.headers.get("Location")!).searchParams.get("code")!;
  const token = await exports.default.fetch(`${MCP_ORIGIN}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CLIENT_REDIRECT_URI, client_id: clientId, code_verifier: verifier, resource: env.MCP_RESOURCE }),
  });
  if (!token.ok) throw new Error(`Token exchange failed with ${token.status}`);
  return ((await token.json()) as { access_token: string }).access_token;
}

export interface JsonRpcResponse {
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

/** Sends one JSON-RPC request to the MCP endpoint and returns its response, whether it came back as JSON or a stream. */
export async function callMcp(token: string | null, method: string, params: Record<string, unknown> = {}): Promise<Response & { rpc: () => Promise<JsonRpcResponse> }> {
  // Real requests always carry Host, which the MCP handler checks against allowedHostnames. A test fetch doesn't add one.
  const headers: Record<string, string> = { Host: new URL(env.MCP_RESOURCE).host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await exports.default.fetch(env.MCP_RESOURCE, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const rpc = async (): Promise<JsonRpcResponse> => {
    const text = await response.text();
    if (!response.headers.get("Content-Type")?.includes("text/event-stream")) return JSON.parse(text);
    const messages = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice("data: ".length)) as JsonRpcResponse);
    return messages.find((m) => m.id === 1)!;
  };
  return Object.assign(response, { rpc });
}
