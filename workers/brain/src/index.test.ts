import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_PATH } from "./http";
import { api, callMcp, fakeUser, MCP_ORIGIN, mockWorkos, signInToMcp, signToken, type WorkosMock } from "./testing";

let workos: WorkosMock;
beforeEach(() => {
  workos = mockWorkos();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("sign-in", () => {
  it("answers 404 outside its own path, before checking anything", async () => {
    const response = await api("/../../elsewhere", { sub: null });
    expect(response.status).toBe(404);
  });

  it("needs a valid WorkOS token", async () => {
    const response = await api("/me", { sub: null });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "sign_in_required" });
    expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="day13"');
  });

  it("gives each user their own brain, named by the token's sub", async () => {
    const alice = fakeUser();
    await api("/me", { sub: alice, method: "PATCH", body: { about: "# Fake Alice\n" } });
    const bob = await api("/me", { sub: fakeUser() });
    expect((await bob.json()) as { about: string }).not.toMatchObject({ about: "# Fake Alice\n" });
  });

  it("refuses a user id in the body rather than reading it", async () => {
    const response = await api("/sessions/x/turns", { method: "POST", body: { text: "hi", user_id: "user_someone_else" } });
    expect(response.status).toBe(400);
  });

  it("rejects an expired token", async () => {
    const expired = await signToken({ expiresAt: Math.floor(Date.now() / 1000) - 10 });
    const response = await exports.default.fetch(`https://build40for40.com${BASE_PATH}/me`, { headers: { Authorization: `Bearer ${expired}` } });
    expect(response.status).toBe(401);
  });
});

describe("/me", () => {
  it("shows the starter profile", async () => {
    const sub = fakeUser();
    const response = await api("/me", { sub });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: sub, preferences: {}, learned: [], about: expect.stringContaining("# About this person") });
  });

  it("lets people rewrite their own text and preferences", async () => {
    const sub = fakeUser();
    const response = await api("/me", { sub, method: "PATCH", body: { about: "# Fake me\n\nLikes lists.\n", preferences: { voice: "slow" } } });
    expect(await response.json()).toMatchObject({ about: "# Fake me\n\nLikes lists.\n", preferences: { voice: "slow" } });
  });

  it("rejects a patch it doesn't understand", async () => {
    for (const body of [{}, { name: "Fake" }, { about: 42 }, { preferences: [] }, "not json"]) {
      const response = await api("/me", { method: "PATCH", body });
      expect(response.status).toBe(400);
    }
  });

  it("deletes the brain and then the WorkOS user", async () => {
    const sub = fakeUser();
    await api("/me", { sub, method: "PATCH", body: { about: "# Fake me\n" } });
    const response = await api("/me", { sub, method: "DELETE" });
    expect(response.status).toBe(204);
    expect(workos.deletedUsers).toEqual([sub]);
    expect(await (await api("/me", { sub })).json()).toMatchObject({ about: expect.stringContaining("# About this person") });
  });

  it("signs MCP clients out of the brain it deletes", async () => {
    const sub = fakeUser();
    const token = await signInToMcp(sub, workos);
    expect((await api("/me", { sub, method: "DELETE" })).status).toBe(204);
    expect((await callMcp(token, "tools/list")).status).toBe(401);
  });

  it("reports a WorkOS failure after wiping, so it's safe to retry", async () => {
    workos.deleteStatus = 500;
    const response = await api("/me", { sub: fakeUser(), method: "DELETE" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "account_deletion_failed" });
  });
});

describe("validation", () => {
  it("wants a turn as {text}", async () => {
    for (const body of [{}, { text: "" }, { text: "   " }, { text: 4 }, { text: "x".repeat(8_001) }]) {
      const response = await api("/sessions/any/turns", { method: "POST", body });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_turn" });
    }
  });

  it("only lists notes of a kind it knows", async () => {
    const response = await api("/notes?kind=secrets");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_kind" });
  });

  it("answers 404 for a missing note, session or version, and 405 for the wrong method", async () => {
    expect((await api("/notes/ideas/nothing.md")).status).toBe(404);
    expect((await api("/sessions/nothing")).status).toBe(404);
    expect((await api("/versions/999999/restore", { method: "POST" })).status).toBe(404);
    expect((await api("/versions")).status).toBe(400);
    const wrong = await api("/sessions", { method: "GET" });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("Allow")).toBe("POST");
  });
});

describe("MCP discovery", () => {
  const metadataUrl = `${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`;

  it("challenges an MCP request without a token, pointing at the resource metadata", async () => {
    const response = await callMcp(null, "tools/list");
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${metadataUrl}"`);
  });

  it("serves the resource metadata under the resource's path and at the root", async () => {
    const atPath = await exports.default.fetch(metadataUrl);
    const atRoot = await exports.default.fetch(`${MCP_ORIGIN}/.well-known/oauth-protected-resource`);
    const metadata = await atPath.json();
    expect(metadata).toMatchObject({ resource: env.MCP_RESOURCE, authorization_servers: [MCP_ORIGIN] });
    expect(atRoot.status).toBe(200);
    expect(await atRoot.json()).toEqual(metadata);
  });

  it("advertises sign-in with both client metadata documents and dynamic registration", async () => {
    const response = await exports.default.fetch(`${MCP_ORIGIN}/.well-known/oauth-authorization-server`);
    expect(await response.json()).toMatchObject({
      issuer: MCP_ORIGIN,
      authorization_endpoint: `${MCP_ORIGIN}/authorize`,
      token_endpoint: `${MCP_ORIGIN}/token`,
      registration_endpoint: `${MCP_ORIGIN}/register`,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("keeps the voice API on WorkOS tokens, so an MCP token doesn't open it", async () => {
    const token = await signInToMcp(fakeUser(), workos);
    const response = await exports.default.fetch(`https://build40for40.com${BASE_PATH}/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(401);
  });
});
