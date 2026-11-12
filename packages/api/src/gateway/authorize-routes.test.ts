import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loopbackRequest } from "../testing/loopback-request.js";
import {
  AUTHORIZE_PER_IP_PER_HOUR,
  AUTHORIZE_PER_IP_PER_MINUTE,
  BROWSER_BINDING_COOKIE,
  PENDING_TTL_MS,
  authorizeRouter,
  checkBrowserBinding,
} from "./authorize-routes.js";
import { sha256 } from "./crypto.js";
import { CimdResolver } from "./cimd.js";
import { ClientRegistry } from "./clients.js";
import { MemoryGatewayStore } from "./store.js";
import { UpstreamRejectedError, UpstreamUnavailableError, type UpstreamIdp } from "./upstream.js";

const ISSUER = "https://gw.example.test";
const RESOURCE = "https://gw.example.test/mcp";
const HOST_REDIRECT = "https://host.example.test/cb?keep=1";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
/** A CIMD client on a VERIFIED_HOSTS domain: pre-interaction errors may redirect to it. */
const VERIFIED_CIMD = "https://claude.ai/oauth/test-client";

class FakeUpstream implements UpstreamIdp {
  authorizeCalls: Array<{ state: string; nonce: string; codeChallenge: string; redirectUri: string }> = [];
  exchangeCalls: Array<{ code: string; verifier: string; redirectUri: string; nonce: string }> = [];
  result: { subject: string; emailVerified: boolean } | Error = { subject: "subject|abc", emailVerified: true };
  gate: Promise<void> | null = null;
  authorizeUrl(p: { state: string; nonce: string; codeChallenge: string; redirectUri: string }): string {
    this.authorizeCalls.push(p);
    return `https://idp.example.test/authorize?state=${encodeURIComponent(p.state)}`;
  }
  async exchange(p: { code: string; verifier: string; redirectUri: string; nonce: string }) {
    this.exchangeCalls.push(p);
    if (this.gate) await this.gate;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

async function setup(o: { maxLivePendings?: number } = {}) {
  let now = new Date("2026-10-20T12:00:00Z");
  const store = new MemoryGatewayStore();
  const cimd = new CimdResolver({
    store,
    fetch: vi.fn(async () => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    lookup: async () => [{ address: "160.79.104.10", family: 4 }],
  });
  const clients = new ClientRegistry({ store, cimd, now: () => now });
  const reg = await clients.register({ redirect_uris: [HOST_REDIRECT, "http://127.0.0.1:8080/callback"], client_name: "Test" }, "ip");
  const clientId = (reg.body as { client_id: string }).client_id;
  await store.putCimd(VERIFIED_CIMD, {
    document: { client_id: VERIFIED_CIMD, client_name: "Verified", redirect_uris: [HOST_REDIRECT] },
    fetchedAt: now,
    freshUntil: new Date(now.getTime() + 365 * 24 * 3600 * 1000),
    staleUntil: new Date(now.getTime() + 366 * 24 * 3600 * 1000),
  });
  const upstream = new FakeUpstream();
  const logs: unknown[] = [];
  const app = express();
  app.use(
    authorizeRouter({
      store,
      clients,
      upstream,
      issuer: ISSUER,
      resource: RESOURCE,
      now: () => now,
      log: (e) => logs.push(e),
      maxLivePendings: o.maxLivePendings,
    }),
  );
  const req = await loopbackRequest(app);
  return {
    store,
    upstream,
    clientId,
    req,
    logs,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

function params(clientId: string, overrides: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: HOST_REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "host-state",
    scope: "portfolio:read",
    resource: RESOURCE,
    ...overrides,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) if (v !== undefined) q.set(k, v);
  return q.toString();
}

function hostError(location: string | undefined) {
  expect(location).toBeDefined();
  const u = new URL(location!);
  expect(u.origin + u.pathname).toBe("https://host.example.test/cb");
  expect(u.searchParams.get("keep")).toBe("1");
  // RFC 9207: every authorization response names the issuer.
  expect(u.searchParams.get("iss")).toBe(ISSUER);
  return u.searchParams;
}

function expectErrorPage(res: { status: number; headers: Record<string, string>; text: string }, status = 400) {
  expect(res.status).toBe(status);
  expect(res.headers.location).toBeUndefined();
  expect(res.headers["content-type"]).toMatch(/^text\/html/);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.headers["x-frame-options"]).toBe("DENY");
  expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(res.text).toContain("<title>Sign-in problem</title>");
  expect(res.text).not.toMatch(/<script|<link|https?:\/\//i);
}

function bindingCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"] as string[] | undefined;
  const c = raw?.find((v) => v.startsWith(`${BROWSER_BINDING_COOKIE}=`));
  expect(c).toBeDefined();
  return c!.split(";")[0]!;
}

async function startAuthorize(ctx: Awaited<ReturnType<typeof setup>>) {
  const res = await ctx.req.get(`/authorize?${params(ctx.clientId)}`);
  expect(res.status).toBe(302);
  const call = ctx.upstream.authorizeCalls.at(-1)!;
  return { ...call, cookie: bindingCookie(res) };
}

function callback(ctx: Awaited<ReturnType<typeof setup>>, query: string, cookie?: string) {
  const r = ctx.req.get(`/oauth/upstream/callback?${query}`);
  return cookie ? r.set("Cookie", cookie) : r;
}

afterEach(() => vi.restoreAllMocks());

describe("GET /authorize", () => {
  it("stores a pending authorization and redirects to the upstream IdP", async () => {
    const ctx = await setup();
    const res = await ctx.req.get(`/authorize?${params(ctx.clientId)}`);
    expect(res.status).toBe(302);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers.location).toMatch(/^https:\/\/idp\.example\.test\/authorize\?/);
    const call = ctx.upstream.authorizeCalls[0]!;
    expect(call.redirectUri).toBe("https://gw.example.test/oauth/upstream/callback");
    expect(call.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(call.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(call.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(call.codeChallenge).not.toBe(CHALLENGE);

    const pending = (await ctx.store.getPendingByUpstreamState(call.state))!;
    expect(pending).toMatchObject({
      clientKey: ctx.clientId,
      redirectUri: HOST_REDIRECT,
      state: "host-state",
      codeChallenge: CHALLENGE,
      scope: "portfolio:read memory",
      resource: RESOURCE,
      upstreamNonce: call.nonce,
      subject: null,
      consentCsrf: null,
    });
    expect(pending.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending.upstreamVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending.expiresAt.toISOString()).toBe("2026-10-20T12:10:00.000Z");
    expect(PENDING_TTL_MS).toBe(10 * 60 * 1000);
  });

  it("accepts an absent scope, resource and state", async () => {
    const ctx = await setup();
    const res = await ctx.req.get(`/authorize?${params(ctx.clientId, { scope: undefined, resource: undefined, state: undefined })}`);
    expect(res.status).toBe(302);
    const pending = (await ctx.store.getPendingByUpstreamState(ctx.upstream.authorizeCalls[0]!.state))!;
    expect(pending.state).toBeNull();
    expect(pending.scope).toBe("portfolio:read memory");
    expect(pending.resource).toBe(RESOURCE);
  });

  it("accepts a loopback redirect on another port", async () => {
    const ctx = await setup();
    const res = await ctx.req.get(`/authorize?${params(ctx.clientId, { redirect_uri: "http://127.0.0.1:53123/callback" })}`);
    expect(res.status).toBe(302);
  });

  it("shows an error page for an unknown client", async () => {
    const ctx = await setup();
    const res = await ctx.req.get(`/authorize?${params("nope")}`);
    expectErrorPage(res);
    expect(res.text).toContain("This app couldn&#39;t be verified.");
    expect(ctx.upstream.authorizeCalls).toHaveLength(0);
  });

  it("shows an error page for a missing client_id", async () => {
    const ctx = await setup();
    expectErrorPage(await ctx.req.get(`/authorize?${params(ctx.clientId, { client_id: undefined })}`));
  });

  it("shows an error page and never redirects for an unregistered redirect_uri", async () => {
    const ctx = await setup();
    for (const bad of ["https://evil.example.test/cb", "https://host.example.test/cb", "http://127.0.0.1.evil.test/callback", ""]) {
      const res = await ctx.req.get(`/authorize?${params(ctx.clientId, { redirect_uri: bad, response_type: "token" })}`);
      expectErrorPage(res);
    }
    expect(ctx.upstream.authorizeCalls).toHaveLength(0);
  });

  it("shows an error page for a missing redirect_uri", async () => {
    const ctx = await setup();
    expectErrorPage(await ctx.req.get(`/authorize?${params(ctx.clientId, { redirect_uri: undefined })}`));
  });

  it("shows an error page for duplicated client_id or redirect_uri", async () => {
    const ctx = await setup();
    expectErrorPage(await ctx.req.get(`/authorize?${params(ctx.clientId)}&redirect_uri=${encodeURIComponent(HOST_REDIRECT)}`));
    expectErrorPage(await ctx.req.get(`/authorize?${params(ctx.clientId)}&client_id=${ctx.clientId}`));
  });

  it.each([
    ["missing response_type", { response_type: undefined }, "invalid_request"],
    ["wrong response_type", { response_type: "token" }, "unsupported_response_type"],
    ["missing code_challenge", { code_challenge: undefined }, "invalid_request"],
    ["malformed code_challenge", { code_challenge: "short" }, "invalid_request"],
    ["plain PKCE", { code_challenge_method: "plain" }, "invalid_request"],
    ["missing PKCE method", { code_challenge_method: undefined }, "invalid_request"],
    ["extra scope", { scope: "portfolio:read connections:manage" }, "invalid_scope"],
    ["other scope", { scope: "connections:manage" }, "invalid_scope"],
    ["only ignorable scopes", { scope: "openid offline_access" }, "invalid_scope"],
    ["memory without portfolio:read", { scope: "memory" }, "invalid_scope"],
    ["wrong resource", { resource: "https://gw.example.test/api" }, "invalid_target"],
    ["overlong state", { state: "s".repeat(2049) }, "invalid_request"],
  ])("redirects %s back to a verified-host CIMD client as an error", async (_label, overrides, error) => {
    const ctx = await setup();
    const res = await ctx.req.get(`/authorize?${params(VERIFIED_CIMD, overrides)}`);
    expect(res.status).toBe(302);
    const q = hostError(res.headers.location);
    expect(q.get("error")).toBe(error);
    expect(q.get("error_description")).toBeTruthy();
    if (!("state" in overrides)) expect(q.get("state")).toBe("host-state");
    expect(ctx.upstream.authorizeCalls).toHaveLength(0);
  });

  it.each([
    ["missing response_type", { response_type: undefined }, "invalid_request"],
    ["wrong response_type", { response_type: "bad" }, "unsupported_response_type"],
    ["missing code_challenge", { code_challenge: undefined }, "invalid_request"],
    ["plain PKCE", { code_challenge_method: "plain" }, "invalid_request"],
    ["extra scope", { scope: "portfolio:read connections:manage" }, "invalid_scope"],
    ["wrong resource", { resource: "https://gw.example.test/api" }, "invalid_target"],
    ["overlong state", { state: "s".repeat(2049) }, "invalid_request"],
  ])("shows an error page, never a redirect, for %s from an unverified (DCR) client", async (_label, overrides, error) => {
    const ctx = await setup();
    const res = await ctx.req.get(`/authorize?${params(ctx.clientId, overrides)}`);
    expectErrorPage(res);
    expect(res.text).toContain("This sign-in request isn&#39;t valid.");
    expect(ctx.upstream.authorizeCalls).toHaveLength(0);
    expect(ctx.logs.at(-1)).toEqual({ event: "gateway_authorize", clientHost: "host.example.test", result: error });
  });

  it.each([
    "portfolio:read offline_access",
    "openid portfolio:read",
    "portfolio:read portfolio:read",
    "email profile portfolio:read openid offline_access",
    "portfolio:read",
    "portfolio:read memory",
    "memory portfolio:read offline_access",
  ])("accepts scope %j and grants exactly portfolio:read memory", async (scope) => {
    const ctx = await setup();
    const res = await ctx.req.get(`/authorize?${params(ctx.clientId, { scope })}`);
    expect(res.status).toBe(302);
    const pending = (await ctx.store.getPendingByUpstreamState(ctx.upstream.authorizeCalls[0]!.state))!;
    expect(pending.scope).toBe("portfolio:read memory");
  });

  it("checks response_type before PKCE, PKCE before scope, and scope before resource", async () => {
    const ctx = await setup();
    const all = { response_type: "token", code_challenge_method: "plain", scope: "x", resource: "https://x.test/" };
    const r1 = await ctx.req.get(`/authorize?${params(VERIFIED_CIMD, all)}`);
    expect(hostError(r1.headers.location).get("error")).toBe("unsupported_response_type");
    const r2 = await ctx.req.get(`/authorize?${params(VERIFIED_CIMD, { ...all, response_type: "code" })}`);
    expect(hostError(r2.headers.location).get("error")).toBe("invalid_request");
    const r3 = await ctx.req.get(`/authorize?${params(VERIFIED_CIMD, { ...all, response_type: "code", code_challenge_method: "S256" })}`);
    expect(hostError(r3.headers.location).get("error")).toBe("invalid_scope");
  });

  it("omits state from the host error when none was sent", async () => {
    const ctx = await setup();
    const res = await ctx.req.get(`/authorize?${params(VERIFIED_CIMD, { state: undefined, scope: "x" })}`);
    expect(hostError(res.headers.location).has("state")).toBe(false);
  });

  it("logs only event, client host and result", async () => {
    const ctx = await setup();
    await ctx.req.get(`/authorize?${params(ctx.clientId)}`);
    expect(ctx.logs).toEqual([{ event: "gateway_authorize", clientHost: "host.example.test", result: "redirect_upstream" }]);
  });
});

describe("GET /oauth/upstream/callback", () => {
  it("exchanges the code, binds the subject and redirects to consent", async () => {
    const ctx = await setup();
    const call = await startAuthorize(ctx);
    const pending = (await ctx.store.getPendingByUpstreamState(call.state))!;

    const res = await callback(ctx, `code=up-code&state=${encodeURIComponent(call.state)}`, call.cookie);
    expect(res.status).toBe(302);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers.location).toBe(`/oauth/consent?p=${pending.id}`);
    expect(ctx.upstream.exchangeCalls).toEqual([
      { code: "up-code", verifier: pending.upstreamVerifier, redirectUri: "https://gw.example.test/oauth/upstream/callback", nonce: call.nonce },
    ]);
    expect((await ctx.store.getPending(pending.id))!.subject).toBe("subject|abc");
  });

  it("maps an Auth0 error to access_denied on the host redirect", async () => {
    const ctx = await setup();
    const call = await startAuthorize(ctx);
    const pending = (await ctx.store.getPendingByUpstreamState(call.state))!;
    const res = await callback(
      ctx,
      `error=access_denied&error_description=${encodeURIComponent("user not on allow-list <x>")}&state=${encodeURIComponent(call.state)}`,
      call.cookie,
    );
    expect(res.status).toBe(302);
    const q = hostError(res.headers.location);
    expect(q.get("error")).toBe("access_denied");
    expect(q.get("state")).toBe("host-state");
    expect(q.get("error_description")).not.toContain("allow-list");
    expect(ctx.upstream.exchangeCalls).toHaveLength(0);
    expect(await ctx.store.getPending(pending.id)).toBeNull();
  });

  it("redirects access_denied when email is not verified", async () => {
    const ctx = await setup();
    ctx.upstream.result = { subject: "subject|abc", emailVerified: false };
    const call = await startAuthorize(ctx);
    const pending = (await ctx.store.getPendingByUpstreamState(call.state))!;
    const res = await callback(ctx, `code=c&state=${encodeURIComponent(call.state)}`, call.cookie);
    expect(hostError(res.headers.location).get("error")).toBe("access_denied");
    expect(await ctx.store.getPending(pending.id)).toBeNull();
  });

  it("redirects access_denied when the upstream rejects the token (e.g. nonce mismatch)", async () => {
    const ctx = await setup();
    ctx.upstream.result = new UpstreamRejectedError("nonce");
    const call = await startAuthorize(ctx);
    const res = await callback(ctx, `code=c&state=${encodeURIComponent(call.state)}`, call.cookie);
    expect(hostError(res.headers.location).get("error")).toBe("access_denied");
  });

  it("shows a temporarily-unavailable page when the upstream is down", async () => {
    const ctx = await setup();
    ctx.upstream.result = new UpstreamUnavailableError("down");
    const call = await startAuthorize(ctx);
    const res = await callback(ctx, `code=c&state=${encodeURIComponent(call.state)}`, call.cookie);
    expectErrorPage(res, 503);
    expect(res.text).toContain("Sign-in is temporarily unavailable.");
  });

  it("shows an error page, never a redirect, for an unknown state", async () => {
    const ctx = await setup();
    const { cookie } = await startAuthorize(ctx);
    expectErrorPage(await callback(ctx, `code=c&state=unknown`, cookie));
    expectErrorPage(await callback(ctx, `code=c`, cookie));
    expectErrorPage(await callback(ctx, `error=access_denied&state=unknown`, cookie));
    expect(ctx.upstream.exchangeCalls).toHaveLength(0);
  });

  it("expires the pending authorization after 10 minutes and deletes it", async () => {
    const ctx = await setup();
    const call = await startAuthorize(ctx);
    const pending = (await ctx.store.getPendingByUpstreamState(call.state))!;
    ctx.advance(PENDING_TTL_MS + 1);
    expectErrorPage(await callback(ctx, `code=c&state=${encodeURIComponent(call.state)}`, call.cookie));
    expect(ctx.upstream.exchangeCalls).toHaveLength(0);
    expect(await ctx.store.getPending(pending.id)).toBeNull();
  });

  it("still works just under 10 minutes", async () => {
    const ctx = await setup();
    const call = await startAuthorize(ctx);
    ctx.advance(PENDING_TTL_MS - 1000);
    const res = await callback(ctx, `code=c&state=${encodeURIComponent(call.state)}`, call.cookie);
    expect(res.headers.location).toMatch(/^\/oauth\/consent\?p=/);
  });

  it("rejects a replayed callback once the subject is bound", async () => {
    const ctx = await setup();
    const call = await startAuthorize(ctx);
    await callback(ctx, `code=c&state=${encodeURIComponent(call.state)}`, call.cookie);
    expectErrorPage(await callback(ctx, `code=c2&state=${encodeURIComponent(call.state)}`, call.cookie));
    expect(ctx.upstream.exchangeCalls).toHaveLength(1);
  });

  it("shows an error page when the code is missing", async () => {
    const ctx = await setup();
    const call = await startAuthorize(ctx);
    expectErrorPage(await callback(ctx, `state=${encodeURIComponent(call.state)}`, call.cookie));
  });

  it("never logs subjects, codes or state", async () => {
    const ctx = await setup();
    const call = await startAuthorize(ctx);
    await callback(ctx, `code=up-code&state=${encodeURIComponent(call.state)}`, call.cookie);
    const text = JSON.stringify(ctx.logs);
    for (const secret of ["subject|abc", "up-code", call.state, "host-state", call.nonce]) expect(text).not.toContain(secret);
    expect(ctx.logs.at(-1)).toEqual({ event: "gateway_upstream_callback", clientHost: "host.example.test", result: "consent" });
  });

  it("rejects a replay with the error page, even after the subject is bound", async () => {
    const ctx = await setup();
    const call = await startAuthorize(ctx);
    await callback(ctx, `code=c&state=${encodeURIComponent(call.state)}`, call.cookie);
    const pending = (await ctx.store.getPendingByUpstreamState(call.state))!;
    expectErrorPage(await callback(ctx, `code=c2&state=${encodeURIComponent(call.state)}`, call.cookie));
    expect(await ctx.store.getPending(pending.id)).not.toBeNull();
  });

  it("claims the upstream state atomically: a concurrent second callback gets the error page and deletes nothing", async () => {
    const ctx = await setup();
    const call = await startAuthorize(ctx);
    const pending = (await ctx.store.getPendingByUpstreamState(call.state))!;
    let release!: () => void;
    ctx.upstream.gate = new Promise((r) => (release = r));
    const first = callback(ctx, `code=c&state=${encodeURIComponent(call.state)}`, call.cookie).then((r) => r);
    await vi.waitFor(() => expect(ctx.upstream.exchangeCalls).toHaveLength(1));
    const second = await callback(ctx, `code=c&state=${encodeURIComponent(call.state)}`, call.cookie);
    expectErrorPage(second);
    release();
    const res = await first;
    expect(res.headers.location).toBe(`/oauth/consent?p=${pending.id}`);
    expect(ctx.upstream.exchangeCalls).toHaveLength(1);
    expect((await ctx.store.getPending(pending.id))!.subject).toBe("subject|abc");
  });

  it("shows the error page if the pending vanished before the subject could be bound", async () => {
    const ctx = await setup();
    const call = await startAuthorize(ctx);
    const pending = (await ctx.store.getPendingByUpstreamState(call.state))!;
    let release!: () => void;
    ctx.upstream.gate = new Promise((r) => (release = r));
    const first = callback(ctx, `code=c&state=${encodeURIComponent(call.state)}`, call.cookie).then((r) => r);
    await vi.waitFor(() => expect(ctx.upstream.exchangeCalls).toHaveLength(1));
    await ctx.store.deletePending(pending.id);
    release();
    expectErrorPage(await first);
  });
});

describe("browser binding", () => {
  it("sets a __Host- cookie bound to the pending authorization", async () => {
    const ctx = await setup();
    const res = await ctx.req.get(`/authorize?${params(ctx.clientId)}`);
    const raw = (res.headers["set-cookie"] as unknown as string[]).find((v) => v.startsWith(`${BROWSER_BINDING_COOKIE}=`))!;
    expect(BROWSER_BINDING_COOKIE).toBe("__Host-gw_pa");
    const attrs = raw.split(";").map((a) => a.trim().toLowerCase());
    expect(attrs).toEqual(expect.arrayContaining(["httponly", "secure", "samesite=lax", "path=/", "max-age=600"]));
    expect(attrs.some((a) => a.startsWith("domain="))).toBe(false);
    const value = raw.split(";")[0]!.slice(BROWSER_BINDING_COOKIE.length + 1);
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const pending = (await ctx.store.getPendingByUpstreamState(ctx.upstream.authorizeCalls[0]!.state))!;
    expect(pending.browserBindingHash).toBe(sha256(value));
    expect(pending.upstreamClaimedAt).toBeNull();
  });

  it("does not set the cookie when /authorize fails", async () => {
    const ctx = await setup();
    const res = await ctx.req.get(`/authorize?${params(ctx.clientId, { scope: "x" })}`);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects a callback without the cookie and leaves the pending untouched", async () => {
    const ctx = await setup();
    const call = await startAuthorize(ctx);
    const before = (await ctx.store.getPendingByUpstreamState(call.state))!;
    expectErrorPage(await callback(ctx, `code=c&state=${encodeURIComponent(call.state)}`));
    expectErrorPage(await callback(ctx, `error=access_denied&state=${encodeURIComponent(call.state)}`));
    expect(ctx.upstream.exchangeCalls).toHaveLength(0);
    expect(await ctx.store.getPending(before.id)).toEqual(before);
    // the real browser can still finish
    const ok = await callback(ctx, `code=c&state=${encodeURIComponent(call.state)}`, call.cookie);
    expect(ok.headers.location).toBe(`/oauth/consent?p=${before.id}`);
  });

  it("rejects a callback carrying another browser's cookie", async () => {
    const ctx = await setup();
    const victim = await startAuthorize(ctx);
    const attacker = await startAuthorize(ctx);
    const before = (await ctx.store.getPendingByUpstreamState(victim.state))!;
    expectErrorPage(await callback(ctx, `code=c&state=${encodeURIComponent(victim.state)}`, attacker.cookie));
    expectErrorPage(await callback(ctx, `code=c&state=${encodeURIComponent(victim.state)}`, `${BROWSER_BINDING_COOKIE}=garbage`));
    expect(ctx.upstream.exchangeCalls).toHaveLength(0);
    expect(await ctx.store.getPending(before.id)).toEqual(before);
  });

  it("finds the binding cookie among other cookies", async () => {
    const ctx = await setup();
    const call = await startAuthorize(ctx);
    const res = await callback(ctx, `code=c&state=${encodeURIComponent(call.state)}`, `a=1; ${call.cookie}; b=2`);
    expect(res.headers.location).toMatch(/^\/oauth\/consent\?p=/);
  });

  it("checkBrowserBinding compares the cookie hash to the pending", async () => {
    const ctx = await setup();
    const call = await startAuthorize(ctx);
    const pending = (await ctx.store.getPendingByUpstreamState(call.state))!;
    const fakeReq = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } }) as unknown as express.Request;
    expect(checkBrowserBinding(fakeReq(call.cookie), pending)).toBe(true);
    expect(checkBrowserBinding(fakeReq(), pending)).toBe(false);
    expect(checkBrowserBinding(fakeReq(`${BROWSER_BINDING_COOKIE}=nope`), pending)).toBe(false);
    expect(checkBrowserBinding(fakeReq(`${call.cookie}; ${BROWSER_BINDING_COOKIE}=nope`), pending)).toBe(false);
  });
});

describe("/authorize abuse limits", () => {
  it("limits each IP to 20 per minute with an HTML 429", async () => {
    const ctx = await setup();
    expect(AUTHORIZE_PER_IP_PER_MINUTE).toBe(20);
    for (let i = 0; i < 20; i++) expect((await ctx.req.get(`/authorize?${params(ctx.clientId)}`)).status).toBe(302);
    const res = await ctx.req.get(`/authorize?${params(ctx.clientId)}`);
    expectErrorPage(res, 429);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(ctx.upstream.authorizeCalls).toHaveLength(20);
    ctx.advance(60_001);
    expect((await ctx.req.get(`/authorize?${params(ctx.clientId)}`)).status).toBe(302);
  });

  it("limits each IP to 200 per hour", async () => {
    const ctx = await setup();
    expect(AUTHORIZE_PER_IP_PER_HOUR).toBe(200);
    for (let batch = 0; batch < 10; batch++) {
      for (let i = 0; i < 20; i++) expect((await ctx.req.get(`/authorize?${params(ctx.clientId)}`)).status).toBe(302);
      ctx.advance(60_001);
    }
    expectErrorPage(await ctx.req.get(`/authorize?${params(ctx.clientId)}`), 429);
  });

  it("counts invalid requests too, and rate-limits before resolving the client", async () => {
    const ctx = await setup();
    for (let i = 0; i < 20; i++) await ctx.req.get(`/authorize?${params("nope")}`);
    const res = await ctx.req.get(`/authorize?${params(ctx.clientId)}`);
    expect(res.status).toBe(429);
  });

  it("caps live pending authorizations with a 503 page", async () => {
    const ctx = await setup({ maxLivePendings: 2 });
    await startAuthorize(ctx);
    await startAuthorize(ctx);
    const res = await ctx.req.get(`/authorize?${params(ctx.clientId)}`);
    expectErrorPage(res, 503);
    expect(res.text).toContain("Sign-in is temporarily unavailable.");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("sweeps expired pendings opportunistically, at most once a minute", async () => {
    const ctx = await setup({ maxLivePendings: 1 });
    const old = await startAuthorize(ctx);
    const oldId = (await ctx.store.getPendingByUpstreamState(old.state))!.id;
    const sweep = vi.spyOn(ctx.store, "deleteExpiredPendings");
    ctx.advance(PENDING_TTL_MS + 1);
    expect((await ctx.req.get(`/authorize?${params(ctx.clientId)}`)).status).toBe(302);
    expect(await ctx.store.getPending(oldId)).toBeNull();
    await ctx.req.get(`/authorize?${params(ctx.clientId)}`);
    expect(sweep).toHaveBeenCalledTimes(1);
    ctx.advance(60_001);
    await ctx.req.get(`/authorize?${params(ctx.clientId)}`);
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});
