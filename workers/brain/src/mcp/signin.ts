import { AuthorizationError, authorizationErrorRedirect, CimdFetchError, type ConsentDescription, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { exchangeWorkosCode, workosAuthorizeUrl } from "../workos";
import type { McpProps } from "./server";

export const AUTHORIZE_PATH = "/authorize";
export const CALLBACK_PATH = "/callback";

export type SignInEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

/**
 * Signs someone in for an MCP client: asks whether this client may use their brain, sends them to WorkOS, and on the way back
 * issues the client a code for a token that carries their WorkOS user id. Answers null for anything but the two sign-in routes.
 */
export async function signIn(request: Request, env: SignInEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.origin !== new URL(env.MCP_RESOURCE).origin) return null;
  if (url.pathname !== AUTHORIZE_PATH && url.pathname !== CALLBACK_PATH) return null;
  if (!env.WORKOS_API_KEY) return page(503, "Sign-in isn't switched on yet", "Try again a bit later.");
  try {
    if (url.pathname === CALLBACK_PATH) return request.method === "GET" ? await finish(request, env) : methodNotAllowed("GET");
    if (request.method === "GET") return await askForConsent(request, env.OAUTH_PROVIDER);
    if (request.method === "POST") return await decide(request, env);
    return methodNotAllowed("GET, POST");
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return redirect(e.redirectTo);
    if (e instanceof AuthorizationError) return page(400, "That sign-in didn't work", `Head back to the app and connect again. (${e.description})`);
    if (e instanceof CimdFetchError) return page(400, "That sign-in didn't work", "We couldn't check which app is asking. Head back to it and connect again.");
    throw e;
  }
}

async function askForConsent(request: Request, oauth: OAuthHelpers): Promise<Response> {
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

async function decide(request: Request, env: SignInEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle);
  const { state, headers } = await oauth.beginUpstream(approved.request, { headers: approved.headers });
  headers.set("Location", workosAuthorizeUrl(env.WORKOS_CLIENT_ID, new URL(CALLBACK_PATH, env.MCP_RESOURCE).href, state));
  return new Response(null, { status: 302, headers });
}

async function finish(request: Request, env: SignInEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, headers } = await oauth.finishUpstream(request);
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
    return new Response(null, { status: 302, headers });
  }
  const sub = await exchangeWorkosCode(code, env.WORKOS_CLIENT_ID, env.WORKOS_API_KEY).catch(() => null);
  if (!sub) {
    console.error(JSON.stringify({ event: "mcp_sign_in_failed", client_id: original.clientId }));
    headers.set("Location", authorizationErrorRedirect(original, "server_error", "Signing in with WorkOS failed"));
    return new Response(null, { status: 302, headers });
  }
  const props: McpProps = { sub };
  const { redirectTo } = await oauth.completeAuthorization({ request: original, userId: sub, metadata: {}, scope: original.scope, props });
  console.log(JSON.stringify({ event: "mcp_sign_in", client_id: original.clientId }));
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

/** Signs every MCP client out of this person's brain, so nothing can reach it once their account is deleted. */
export async function revokeMcpGrants(oauth: OAuthHelpers, userId: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(userId, { cursor });
    await Promise.all(page.items.map((grant) => oauth.revokeGrant(grant.id, userId)));
    cursor = page.cursor;
  } while (cursor);
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE = `body{font:17px/1.5 system-ui,sans-serif;max-width:32rem;margin:0 auto;padding:32px 16px;color:#1a1a1a;background:#fff}
h1{font-size:1.5rem;line-height:1.25}.warn{background:#fff4e5;padding:12px;border-radius:8px}
form{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}button{font:inherit;padding:12px 20px;border-radius:10px;border:1px solid #1a1a1a;background:#fff;color:#1a1a1a}
button[value=approve]{background:#1a1a1a;color:#fff}`;

function html(title: string, body: string): string {
  return `<!doctype html><html lang="en-GB"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style><body>${body}</body></html>`;
}

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  const who = details.clientDomain ? `It comes from <strong>${escape(details.clientDomain)}</strong>.` : "It picked its own name, so we can't vouch for it.";
  const local = details.redirectIsLoopback ? `<p class="warn">This hands access to an app on your computer. Only carry on if you just started connecting from it.</p>` : "";
  return html(
    `Connect ${details.clientName} to Dumpling`,
    `<h1>Let ${name} into your Dumpling?</h1>
<p>${who} It'll be able to read what's in your Dumpling and add to it. Access goes to <strong>${escape(details.redirectHost)}</strong>.</p>
${local}<p>Next you'll sign in, so it opens the right Dumpling.</p>
<form method="post" action="${AUTHORIZE_PATH}"><input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">Allow</button><button name="decision" value="deny">No thanks</button></form>`,
  );
}

function page(status: number, title: string, message: string): Response {
  return new Response(html(title, `<h1>${escape(title)}</h1><p>${escape(message)}</p>`), { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
}

function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { Allow: allow } });
}
