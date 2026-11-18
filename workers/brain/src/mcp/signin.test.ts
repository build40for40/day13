import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeUrl, CLIENT_REDIRECT_URI, consentHandle, cookiesFrom, MCP_ORIGIN, mockWorkos, pkce, registerMcpClient, type WorkosMock } from "../testing";

let workos: WorkosMock;
beforeEach(() => {
  workos = mockWorkos();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const post = (consent: Response, handle: string, decision: string) =>
  exports.default.fetch(`${MCP_ORIGIN}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookiesFrom(consent) },
    body: new URLSearchParams({ handle, decision }),
    redirect: "manual",
  });

async function openConsent(): Promise<{ clientId: string; verifier: string; consent: Response; handle: string; html: string }> {
  const clientId = await registerMcpClient();
  const { verifier, challenge } = await pkce();
  const consent = await exports.default.fetch(authorizeUrl(clientId, challenge));
  const html = await consent.text();
  return { clientId, verifier, consent, handle: consentHandle(html), html };
}

describe("sign-in for MCP clients", () => {
  it("asks first, on a page that can't be framed", async () => {
    const { consent, handle, html } = await openConsent();
    expect(consent.status).toBe(200);
    expect(html).toContain("Let Fake MCP client into your Dumpling?");
    expect(html).toContain("<strong>client.example</strong>");
    expect(handle).not.toBe("");
    expect(consent.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("goes through WorkOS and gives the client a token for that person's brain", async () => {
    const { clientId, verifier, consent, handle } = await openConsent();
    const approved = await post(consent, handle, "approve");
    expect(approved.status).toBe(302);
    const workosUrl = new URL(approved.headers.get("Location")!);
    expect(`${workosUrl.origin}${workosUrl.pathname}`).toBe("https://api.workos.com/user_management/authorize");
    expect(Object.fromEntries(workosUrl.searchParams)).toMatchObject({ client_id: env.WORKOS_CLIENT_ID, redirect_uri: `${MCP_ORIGIN}/callback`, provider: "authkit", response_type: "code" });

    workos.codes.set("code_for_alice", "user_fakealice");
    const state = workosUrl.searchParams.get("state")!;
    const callback = await exports.default.fetch(`${MCP_ORIGIN}/callback?code=code_for_alice&state=${state}`, { headers: { Cookie: cookiesFrom(approved) }, redirect: "manual" });
    expect(callback.status).toBe(302);
    const back = new URL(callback.headers.get("Location")!);
    expect(`${back.origin}${back.pathname}`).toBe(CLIENT_REDIRECT_URI);
    expect(back.searchParams.get("state")).toBe("client-state");
    expect(workos.codes.size).toBe(0);

    const token = await exports.default.fetch(`${MCP_ORIGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: CLIENT_REDIRECT_URI, client_id: clientId, code_verifier: verifier, resource: env.MCP_RESOURCE }),
    });
    expect(token.status).toBe(200);
    expect(await token.json()).toMatchObject({ token_type: "bearer", access_token: expect.any(String), refresh_token: expect.any(String) });
  });

  it("sends the client away with access_denied when the person says no", async () => {
    const { consent, handle } = await openConsent();
    const denied = await post(consent, handle, "deny");
    const back = new URL(denied.headers.get("Location")!);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("client-state");
  });

  it("refuses a consent form posted from a browser that never saw the page", async () => {
    const { handle } = await openConsent();
    const forged = await post(new Response(), handle, "approve");
    expect(forged.status).toBe(400);
  });

  it("refuses a callback in a browser that didn't start the sign-in", async () => {
    const { consent, handle } = await openConsent();
    const approved = await post(consent, handle, "approve");
    const state = new URL(approved.headers.get("Location")!).searchParams.get("state")!;
    workos.codes.set("code_for_alice", "user_fakealice");
    const callback = await exports.default.fetch(`${MCP_ORIGIN}/callback?code=code_for_alice&state=${state}`, { redirect: "manual" });
    expect(callback.status).toBe(400);
    expect(workos.codes.size).toBe(1);
  });

  it("tells the client when WorkOS won't take the code", async () => {
    const { consent, handle } = await openConsent();
    const approved = await post(consent, handle, "approve");
    const state = new URL(approved.headers.get("Location")!).searchParams.get("state")!;
    const callback = await exports.default.fetch(`${MCP_ORIGIN}/callback?code=not_a_real_code&state=${state}`, { headers: { Cookie: cookiesFrom(approved) }, redirect: "manual" });
    expect(new URL(callback.headers.get("Location")!).searchParams.get("error")).toBe("server_error");
  });
});
