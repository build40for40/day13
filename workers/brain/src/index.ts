import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { BASE_PATH, error, HttpError, isPlainObject, json, readJson } from "./http";
import { mcpHandler } from "./mcp/server";
import { AUTHORIZE_PATH, revokeMcpGrants, signIn, type SignInEnv } from "./mcp/signin";
import { parseProfilePatch } from "./profile";
import { NOTE_KINDS, type NoteKind } from "./vault";
import { authenticate, deleteWorkosUser } from "./workos";

import type { UserBrain } from "./brain";
import type { Rpc } from "./types";

export { UserBrain } from "./brain";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TURN_CHARS = 8_000;

type Brain = Rpc<Pick<UserBrain, "getProfile" | "updateProfile" | "wipe" | "createSession" | "takeTurn" | "finishSession" | "getSession" | "listNotes" | "getNote" | "listVersions" | "restoreVersion">>;

/** The voice API at `/day13/api`, signed in with a WorkOS access token. */
const api = {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== BASE_PATH && !pathname.startsWith(`${BASE_PATH}/`)) return error(404, "not_found");

    const userId = await authenticate(request, env.WORKOS_CLIENT_ID);
    if (!userId) return error(401, "sign_in_required", undefined, { "WWW-Authenticate": 'Bearer realm="day13"' });

    const brain = env.USER_BRAIN.get(env.USER_BRAIN.idFromName(userId)) as unknown as Brain;
    try {
      return await route(request, pathname.slice(BASE_PATH.length), userId, brain, env);
    } catch (e) {
      if (e instanceof HttpError) return e.toResponse();
      throw e;
    }
  },
} satisfies ExportedHandler<Env>;

const mcpResource = new URL(env.MCP_RESOURCE);
const PROTECTED_RESOURCE_METADATA = "/.well-known/oauth-protected-resource";

/**
 * MCP clients connect to `MCP_RESOURCE`, signing in through `/authorize` and `/callback`. The provider owns discovery, `/token`
 * and `/register`, checks the token on every MCP request, and hands everything else to the voice API unchanged.
 */
const provider = new OAuthProvider<Env>({
  apiRoute: env.MCP_RESOURCE,
  apiHandler: { fetch: mcpHandler },
  defaultHandler: {
    async fetch(request, env) {
      return (await signIn(request, env as SignInEnv)) ?? api.fetch(request, env);
    },
  },
  authorizeEndpoint: AUTHORIZE_PATH,
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: { resource: env.MCP_RESOURCE },
});

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Claude looks for the resource metadata at the root rather than under the resource's path (claude-ai-mcp#1277).
    if (url.origin === mcpResource.origin && url.pathname === PROTECTED_RESOURCE_METADATA) {
      return provider.fetch(new Request(new URL(`${PROTECTED_RESOURCE_METADATA}${mcpResource.pathname}`, url), request), env, ctx);
    }
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, path: string, userId: string, brain: Brain, env: Env): Promise<Response> {
  const { method } = request;
  const url = new URL(request.url);

  if (path === "/me") {
    if (method === "GET") return json({ id: userId, ...(await brain.getProfile()) });
    if (method === "PATCH") return json({ id: userId, ...(await brain.updateProfile(parseProfilePatch(await readJson(request, MAX_BODY_BYTES)))) });
    if (method === "DELETE") return deleteAccount(userId, brain, env);
    return methodNotAllowed("GET, PATCH, DELETE");
  }

  if (path === "/sessions") {
    if (method !== "POST") return methodNotAllowed("POST");
    if (!env.ANTHROPIC_API_KEY) return error(503, "live_sessions_unavailable");
    return json(await brain.createSession(), 201);
  }

  const session = path.match(/^\/sessions\/([A-Za-z0-9-]+)(?:\/(turns|end))?$/);
  if (session) {
    const [, sessionId, action] = session;
    if (action === "turns") {
      if (method !== "POST") return methodNotAllowed("POST");
      return brain.takeTurn(sessionId, parseTurn(await readJson(request, MAX_BODY_BYTES)));
    }
    if (action === "end") {
      if (method !== "POST") return methodNotAllowed("POST");
      const ended = await brain.finishSession(sessionId);
      if (ended === "dropped") return new Response(null, { status: 204 });
      if (typeof ended === "string") return error(ended === "session_not_found" ? 404 : 409, ended);
      return json(ended, 202);
    }
    if (method !== "GET") return methodNotAllowed("GET");
    const view = await brain.getSession(sessionId);
    return view ? json(view) : error(404, "session_not_found");
  }

  if (path === "/notes") {
    if (method !== "GET") return methodNotAllowed("GET");
    const kind = url.searchParams.get("kind");
    if (kind !== null && !NOTE_KINDS.includes(kind as NoteKind)) return error(400, "invalid_kind", { kinds: NOTE_KINDS });
    return json({ notes: await brain.listNotes((kind as NoteKind | null) ?? undefined) });
  }

  if (path.startsWith("/notes/")) {
    if (method !== "GET") return methodNotAllowed("GET");
    const notePath = decodeURIComponent(path.slice("/notes/".length));
    const note = await brain.getNote(notePath);
    return note ? json(note) : error(404, "note_not_found");
  }

  if (path === "/versions") {
    if (method !== "GET") return methodNotAllowed("GET");
    const notePath = url.searchParams.get("path");
    if (!notePath) return error(400, "path_required");
    return json({ versions: await brain.listVersions(notePath) });
  }

  const restore = path.match(/^\/versions\/(\d+)\/restore$/);
  if (restore) {
    if (method !== "POST") return methodNotAllowed("POST");
    const restored = await brain.restoreVersion(Number(restore[1]));
    return restored ? json({ path: restored }) : error(404, "version_not_found");
  }

  return error(404, "not_found");
}

/** A turn is `{text}`: what the person said, already transcribed. */
function parseTurn(input: unknown): string {
  const text = isPlainObject(input) && Object.keys(input).length === 1 && typeof input.text === "string" ? input.text.trim() : "";
  if (!text || text.length > MAX_TURN_CHARS) throw new HttpError(400, "invalid_turn", { message: `Send {text}: what they said, up to ${MAX_TURN_CHARS} characters.` });
  return text;
}

async function deleteAccount(userId: string, brain: Brain, env: Env): Promise<Response> {
  if (!env.WORKOS_API_KEY) return error(503, "account_deletion_unavailable");
  await revokeMcpGrants((env as SignInEnv).OAUTH_PROVIDER, userId);
  await brain.wipe();
  if (!(await deleteWorkosUser(userId, env.WORKOS_API_KEY))) return error(502, "account_deletion_failed");
  return new Response(null, { status: 204 });
}

function methodNotAllowed(allow: string): Response {
  return error(405, "method_not_allowed", undefined, { Allow: allow });
}
