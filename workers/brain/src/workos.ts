import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const API = "https://api.workos.com";
const USER_ID = /^user_[A-Za-z0-9]+$/;
const keySets = new Map<string, JWTVerifyGetKey>();

export const workosIssuer = (clientId: string) => `${API}/user_management/${clientId}`;
export const workosJwksUrl = (clientId: string) => `${API}/sso/jwks/${clientId}`;
export const workosUserUrl = (userId: string) => `${API}/user_management/users/${encodeURIComponent(userId)}`;
export const workosAuthenticateUrl = `${API}/user_management/authenticate`;

/** Where to send someone to sign in with AuthKit. WorkOS sends them back to `redirectUri` with a `code` and this `state`. */
export function workosAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(`${API}/user_management/authorize`);
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", provider: "authkit", state }).toString();
  return url.href;
}

function keysFor(clientId: string): JWTVerifyGetKey {
  let keys = keySets.get(clientId);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(workosJwksUrl(clientId)));
    keySets.set(clientId, keys);
  }
  return keys;
}

export async function authenticate(request: Request, clientId: string): Promise<string | null> {
  const token = request.headers.get("Authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, keysFor(clientId), {
      issuer: workosIssuer(clientId),
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat"],
    });
    return typeof payload.sub === "string" && USER_ID.test(payload.sub) ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function deleteWorkosUser(userId: string, apiKey: string): Promise<boolean> {
  const response = await fetch(workosUserUrl(userId), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  return response.ok || response.status === 404;
}

/** Trades the code WorkOS sent back after sign-in for the user's id, or null when WorkOS refuses it. */
export async function exchangeWorkosCode(code: string, clientId: string, apiKey: string): Promise<string | null> {
  const response = await fetch(workosAuthenticateUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: apiKey, grant_type: "authorization_code", code }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { user?: { id?: unknown } };
  const id = body.user?.id;
  return typeof id === "string" && USER_ID.test(id) ? id : null;
}
