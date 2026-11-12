import { createHash } from "node:crypto";

import express from "express";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { loopbackRequest } from "../testing/loopback-request.js";
import { CimdResolver } from "./cimd.js";
import { ClientRegistry } from "./clients.js";
import { sha256 } from "./crypto.js";
import { MemoryGatewayStore, type AuthorizationCode } from "./store.js";
import { REFRESH_TTL_MS, tokenRouter } from "./token-routes.js";
import { GatewayTokenService } from "./tokens.js";

const ISSUER = "https://gw.example.test";
const RESOURCE = "https://gw.example.test/mcp";
const REDIRECT = "https://host.example.test/cb";
const SUBJECT = "subject|abc";
const VERIFIER = "v".repeat(20) + "-._~" + "A1".repeat(12);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const CIMD_URL = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CIMD_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CIMD_CODE_ONLY = "https://codeonly.example.test/client.json";
const DAY = 24 * 60 * 60 * 1000;

let signingKey: JWK;
beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signingKey = { ...(await exportJWK(pair.privateKey)), kid: "k1" };
});

type TokenBody = {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  error?: string;
};

async function setup() {
  let now = new Date("2026-10-20T12:00:00Z");
  const store = new MemoryGatewayStore();
  const cimd = new CimdResolver({
    store,
    fetch: vi.fn(async () => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    lookup: async () => [{ address: "160.79.104.10", family: 4 }],
    now: () => now,
  });
  await store.putCimd(CIMD_URL, {
    document: { client_id: CIMD_URL, client_name: "Claude", redirect_uris: [CIMD_REDIRECT] },
    fetchedAt: now,
    freshUntil: new Date(now.getTime() + 365 * DAY),
    staleUntil: new Date(now.getTime() + 366 * DAY),
  });
  await store.putCimd(CIMD_CODE_ONLY, {
    document: { client_id: CIMD_CODE_ONLY, redirect_uris: [REDIRECT], grant_types: ["authorization_code"] },
    fetchedAt: now,
    freshUntil: new Date(now.getTime() + 365 * DAY),
    staleUntil: new Date(now.getTime() + 366 * DAY),
  });
  const clients = new ClientRegistry({ store, cimd, now: () => now });
  const tokens = new GatewayTokenService({ issuer: ISSUER, audience: RESOURCE, signingKey, now: () => now });
  const register = async (body: Record<string, unknown> = {}) => {
    const reg = await clients.register({ redirect_uris: [REDIRECT], client_name: "Host", ...body }, "ip");
    return reg.body as { client_id: string; client_secret?: string };
  };
  const pub = await register();
  const other = await register({ client_name: "Other" });
  const conf = await register({ token_endpoint_auth_method: "client_secret_post" });
  const codeOnly = await register({ grant_types: ["authorization_code"] });
  const logs: Array<Record<string, unknown>> = [];
  const app = express();
  app.set("trust proxy", false);
  app.use(tokenRouter({ store, clients, tokens, resource: RESOURCE, now: () => now, log: (e) => logs.push(e) }));
  const req = await loopbackRequest(app);
  let n = 0;
  const addCode = async (over: Partial<AuthorizationCode> = {}) => {
    n += 1;
    const raw = `code-${n}-${"x".repeat(20)}`;
    // A code is only ever issued after the user approved the client (consent POST).
    await store.putConsent(over.subject ?? SUBJECT, over.clientKey ?? pub.client_id, "portfolio:read", now);
    await store.createCode({
      codeHash: sha256(raw),
      clientKey: pub.client_id,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      subject: SUBJECT,
      scope: "portfolio:read",
      resource: RESOURCE,
      expiresAt: new Date(now.getTime() + 60_000),
      usedAt: null,
      familyId: `family-${n}`,
      ...over,
    });
    return { raw, familyId: `family-${n}` };
  };
  const post = (path: string, form: Record<string, string>) =>
    req.post(path).type("form").send(new URLSearchParams(form).toString());
  const exchange = (code: string, over: Record<string, string> = {}) =>
    post("/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      client_id: pub.client_id,
      ...over,
    });
  const refresh = (token: string, over: Record<string, string> = {}) =>
    post("/token", { grant_type: "refresh_token", refresh_token: token, client_id: pub.client_id, ...over });
  return {
    store,
    clients,
    tokens,
    req,
    logs,
    pub,
    other,
    conf,
    codeOnly,
    addCode,
    post,
    exchange,
    refresh,
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

function expectNoStore(res: { headers: Record<string, unknown> }) {
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.headers["pragma"]).toBe("no-cache");
}

function expectGrantError(res: { status: number; body: unknown; headers: Record<string, unknown> }, error = "invalid_grant") {
  expect(res.status).toBe(error === "invalid_client" ? 401 : 400);
  expect((res.body as { error: string }).error).toBe(error);
  expect(res.body).not.toHaveProperty("access_token");
  expectNoStore(res);
}

describe("POST /token authorization_code", () => {
  it("exchanges a code for an access and refresh token", async () => {
    const ctx = await setup();
    const { raw, familyId } = await ctx.addCode();
    const res = await ctx.exchange(raw);
    expect(res.status).toBe(200);
    expectNoStore(res);
    const body = res.body as TokenBody;
    expect(Object.keys(body).sort()).toEqual(["access_token", "expires_in", "refresh_token", "scope", "token_type"]);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    expect(body.scope).toBe("portfolio:read");
    const identity = await ctx.tokens.verifyAccess(body.access_token, ["portfolio:read"]);
    expect(identity.subject).toBe(SUBJECT);
    const stored = await ctx.store.getRefresh(sha256(body.refresh_token));
    expect(stored).toMatchObject({
      familyId,
      clientKey: ctx.pub.client_id,
      subject: SUBJECT,
      scope: "portfolio:read",
      resource: RESOURCE,
      parentHash: null,
      rotatedAt: null,
      revokedAt: null,
    });
    expect(stored!.expiresAt).toEqual(new Date(ctx.now().getTime() + REFRESH_TTL_MS));
    expect(stored!.familyExpiresAt).toEqual(new Date(ctx.now().getTime() + 30 * DAY));
    expect(await ctx.store.getRefresh(body.refresh_token)).toBeNull(); // hashed at rest
    expect(ctx.logs.at(-1)).toEqual({ event: "gateway_token", clientHost: "host.example.test", result: "issued" });
    expect((await ctx.store.getClient(ctx.pub.client_id))?.lastUsedAt).toEqual(ctx.now());
  });

  it("accepts a JSON body for tolerance", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    const res = await ctx.req.post("/token").send({
      grant_type: "authorization_code",
      code: raw,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      client_id: ctx.pub.client_id,
    });
    expect(res.status).toBe(200);
  });

  it("accepts a matching resource parameter", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    expect((await ctx.exchange(raw, { resource: RESOURCE })).status).toBe(200);
  });

  it.each([
    ["wrong PKCE verifier", { code_verifier: "w".repeat(43) }],
    ["wrong redirect", { redirect_uri: "https://host.example.test/cb2" }],
    ["redirect differing only by query", { redirect_uri: `${REDIRECT}?x=1` }],
  ])("%s gives invalid_grant", async (_name, over) => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    expectGrantError(await ctx.exchange(raw, over));
  });

  it("a wrong resource parameter is invalid_target and leaves the code unused", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    expectGrantError(await ctx.exchange(raw, { resource: "https://gw.example.test/other" }), "invalid_target");
    expect((await ctx.exchange(raw)).status).toBe(200);
  });

  it("scope parameters are checked the same way on both grants", async () => {
    const ctx = await setup();
    const a = await ctx.addCode();
    expectGrantError(await ctx.exchange(a.raw, { scope: "portfolio:read connections:manage" }), "invalid_scope");
    const ok = await ctx.exchange(a.raw, { scope: "portfolio:read portfolio:read" });
    expect(ok.status).toBe(200);
    const rt = (ok.body as TokenBody).refresh_token;
    expectGrantError(await ctx.refresh(rt, { scope: "portfolio:read connections:manage" }), "invalid_scope");
    expectGrantError(await ctx.refresh(rt, { scope: "openid offline_access" }), "invalid_scope");
    const r = await ctx.refresh(rt, { scope: "portfolio:read portfolio:read" });
    expect(r.status).toBe(200);
    // OpenID and refresh scopes are accepted alongside portfolio:read and dropped.
    const r2 = await ctx.refresh((r.body as TokenBody).refresh_token, { scope: "openid portfolio:read offline_access email profile" });
    expect(r2.status).toBe(200);
    expect((r2.body as TokenBody).scope).toBe("portfolio:read");
    const b = await ctx.addCode();
    const ok2 = await ctx.exchange(b.raw, { scope: "portfolio:read offline_access" });
    expect(ok2.status).toBe(200);
    expect((ok2.body as TokenBody).scope).toBe("portfolio:read");
  });

  it("a family revoked before the refresh row is written yields invalid_grant and no tokens", async () => {
    const ctx = await setup();
    const { raw, familyId } = await ctx.addCode();
    // A concurrent reuse revoked the family between consumeCode and createRefresh.
    await ctx.store.revokeFamily(familyId, ctx.now());
    const res = await ctx.exchange(raw);
    expectGrantError(res);
    expect(ctx.logs.at(-1)).toEqual({ event: "gateway_token", clientHost: "host.example.test", result: "family_revoked" });
  });

  it("a code-only client's exchange is refused when the code's family was revoked", async () => {
    const ctx = await setup();
    const { raw, familyId } = await ctx.addCode({ clientKey: ctx.codeOnly.client_id });
    await ctx.store.revokeFamily(familyId, ctx.now());
    const res = await ctx.exchange(raw, { client_id: ctx.codeOnly.client_id });
    expectGrantError(res);
    expect(ctx.logs.at(-1)).toEqual({ event: "gateway_token", clientHost: "host.example.test", result: "family_revoked" });
  });

  it("mints the access token before the final family check, so a later revocation marker always covers it", async () => {
    for (const kind of ["refresh", "codeOnly"] as const) {
      const ctx = await setup();
      const clientId = kind === "refresh" ? ctx.pub.client_id : ctx.codeOnly.client_id;
      const { raw } = await ctx.addCode({ clientKey: clientId });
      const minted = ctx.now().getTime();
      const method = kind === "refresh" ? "createRefresh" : "isFamilyRevoked";
      const original = (ctx.store[method] as (...a: unknown[]) => Promise<unknown>).bind(ctx.store);
      vi.spyOn(ctx.store, method).mockImplementation((async (...args: unknown[]) => {
        const result = await original(...args);
        ctx.advance(50); // the check finishes later than the mint
        return result;
      }) as never);
      const res = await ctx.exchange(raw, { client_id: clientId });
      expect(res.status, kind).toBe(200);
      const identity = await ctx.tokens.verifyAccess((res.body as TokenBody).access_token, ["portfolio:read"]);
      expect(identity.issuedAtMs, kind).toBe(minted);
    }
  });

  it("a used code replayed by another client does not revoke the family", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    const rt = ((await ctx.exchange(raw)).body as TokenBody).refresh_token;
    expectGrantError(await ctx.exchange(raw, { client_id: ctx.other.client_id }));
    expect((await ctx.store.getRefresh(sha256(rt)))?.revokedAt).toBeNull();
  });

  it("a used code replayed more than 10 minutes after its expiry does not revoke the family", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    const rt = ((await ctx.exchange(raw)).body as TokenBody).refresh_token;
    ctx.advance(60_000 + 10 * 60_000 + 1);
    expectGrantError(await ctx.exchange(raw));
    expect((await ctx.store.getRefresh(sha256(rt)))?.revokedAt).toBeNull();
  });

  it("a used code replayed within the grace window still revokes", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    const rt = ((await ctx.exchange(raw)).body as TokenBody).refresh_token;
    ctx.advance(60_000 + 10 * 60_000);
    expectGrantError(await ctx.exchange(raw));
    expect((await ctx.store.getRefresh(sha256(rt)))?.revokedAt).toEqual(ctx.now());
  });

  it("a failed client touch never fails the exchange", async () => {
    const ctx = await setup();
    vi.spyOn(ctx.store, "touchClient").mockRejectedValue(new Error("db down"));
    const { raw } = await ctx.addCode();
    const res = await ctx.exchange(raw);
    expect(res.status).toBe(200);
    expect(ctx.logs).toContainEqual({ event: "gateway_token", clientHost: "host.example.test", result: "touch_failed" });
  });

  it("unexpected errors return a JSON server_error without details", async () => {
    const ctx = await setup();
    vi.spyOn(ctx.store, "consumeCode").mockRejectedValue(new Error("secret detail at /srv/x.ts:1"));
    const { raw } = await ctx.addCode();
    const res = await ctx.exchange(raw);
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.body).toEqual({ error: "server_error" });
    expect(res.text).not.toContain("secret detail");
    expectNoStore(res);
    expect(ctx.logs.at(-1)).toEqual({ event: "gateway_token", clientHost: "unknown", result: "server_error" });
  });

  it("clients registered without refresh_token get no refresh token and cannot refresh", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode({ clientKey: ctx.codeOnly.client_id });
    const res = await ctx.exchange(raw, { client_id: ctx.codeOnly.client_id });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body as object).sort()).toEqual(["access_token", "expires_in", "scope", "token_type"]);
    expectGrantError(await ctx.refresh("anything", { client_id: ctx.codeOnly.client_id }));
    // A refresh row for such a client (e.g. registered before) is refused by grant type.
    const stray = "stray-refresh-token";
    await ctx.store.createRefresh({
      tokenHash: sha256(stray),
      familyId: "stray",
      clientKey: ctx.codeOnly.client_id,
      subject: SUBJECT,
      scope: "portfolio:read",
      resource: RESOURCE,
      parentHash: null,
      expiresAt: new Date(ctx.now().getTime() + DAY),
      familyExpiresAt: new Date(ctx.now().getTime() + DAY),
      rotatedAt: null,
      revokedAt: null,
    });
    expectGrantError(await ctx.refresh(stray, { client_id: ctx.codeOnly.client_id }), "unauthorized_client");
  });

  it("CIMD clients get refresh tokens only when their document allows refresh_token", async () => {
    const ctx = await setup();
    const a = await ctx.addCode({ clientKey: CIMD_CODE_ONLY });
    const res = await ctx.exchange(a.raw, { client_id: CIMD_CODE_ONLY });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("refresh_token");
    expectGrantError(await ctx.refresh("anything", { client_id: CIMD_CODE_ONLY }));
    const b = await ctx.addCode({ clientKey: CIMD_URL, redirectUri: CIMD_REDIRECT });
    const ok = await ctx.exchange(b.raw, { client_id: CIMD_URL, redirect_uri: CIMD_REDIRECT });
    expect(ok.body).toHaveProperty("refresh_token");
  });

  it("a missing verifier is invalid_request and leaves the code unused", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    expectGrantError(await ctx.exchange(raw, { code_verifier: "" }), "invalid_request");
    expect((await ctx.exchange(raw)).status).toBe(200);
  });

  it("a code issued to another client gives invalid_grant", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    expectGrantError(await ctx.exchange(raw, { client_id: ctx.other.client_id }));
  });

  it("a code bound to another resource gives invalid_grant", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode({ resource: "https://elsewhere.example.test/mcp" });
    expectGrantError(await ctx.exchange(raw));
  });

  it("an expired or unknown code gives invalid_grant", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    ctx.advance(60_000);
    expectGrantError(await ctx.exchange(raw));
    expectGrantError(await ctx.exchange("never-issued"));
  });

  it("a second use of a code revokes its family (Review Focus 3)", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    const first = await ctx.exchange(raw);
    expect(first.status).toBe(200);
    const refreshToken = (first.body as TokenBody).refresh_token;
    // Host retries after a network blip.
    const second = await ctx.exchange(raw);
    expectGrantError(second);
    expect((await ctx.store.getRefresh(sha256(refreshToken)))?.revokedAt).toEqual(ctx.now());
    expectGrantError(await ctx.refresh(refreshToken));
    expect(ctx.logs.at(-2)).toEqual({ event: "gateway_token", clientHost: "host.example.test", result: "code_reused" });
  });

  it("logs never contain the code, tokens, subject or IP", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    const res = await ctx.exchange(raw);
    await ctx.exchange(raw);
    const text = JSON.stringify(ctx.logs);
    for (const secret of [raw, (res.body as TokenBody).access_token, (res.body as TokenBody).refresh_token, SUBJECT, "127.0.0.1"]) {
      expect(text).not.toContain(secret);
    }
    for (const e of ctx.logs) expect(Object.keys(e).sort()).toEqual(["clientHost", "event", "result"]);
  });
});

describe("POST /token client authentication", () => {
  it("requires client_id", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    const res = await ctx.post("/token", { grant_type: "authorization_code", code: raw, redirect_uri: REDIRECT, code_verifier: VERIFIER });
    expectGrantError(res, "invalid_client");
  });

  it("a code bound to a client that no longer resolves is invalid_client", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode({ clientKey: "unknown-client" });
    expectGrantError(await ctx.exchange(raw, { client_id: "unknown-client" }), "invalid_client");
  });

  it("a real code presented with another client_id is invalid_grant and stays unused", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    expectGrantError(await ctx.exchange(raw, { client_id: "unknown-client" }));
    expect((await ctx.exchange(raw)).status).toBe(200);
  });

  it("unknown codes and refresh tokens never resolve the client (no CIMD fetch for bogus grants)", async () => {
    const ctx = await setup();
    const spy = vi.spyOn(ctx.clients, "resolve");
    const attacker = "https://attacker.example.test/x1";
    expectGrantError(await ctx.exchange("never-issued", { client_id: attacker }));
    expectGrantError(await ctx.refresh("never-issued", { client_id: attacker }));
    const { raw } = await ctx.addCode();
    expectGrantError(await ctx.exchange(raw, { client_id: attacker }));
    expect((await ctx.post("/revoke", { token: "never-issued", client_id: attacker })).status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it("/token and /revoke share a per-IP limit of 60 requests a minute", async () => {
    const ctx = await setup();
    for (let i = 0; i < 59; i += 1) expectGrantError(await ctx.exchange(`bogus-${i}`));
    expect((await ctx.post("/revoke", { token: "bogus", client_id: ctx.pub.client_id })).status).toBe(200);
    const limited = await ctx.exchange("bogus-60");
    expect(limited.status).toBe(429);
    expect((limited.body as { error: string }).error).toBe("temporarily_unavailable");
    expect(limited.headers["retry-after"]).toBe("60");
    expectNoStore(limited);
    expect((await ctx.post("/revoke", { token: "bogus", client_id: ctx.pub.client_id })).status).toBe(429);
    expect(ctx.logs.at(-1)).toEqual({ event: "gateway_revoke", clientHost: "unknown", result: "rate_limited" });
    ctx.advance(60_000);
    const { raw } = await ctx.addCode();
    expect((await ctx.exchange(raw)).status).toBe(200);
  });

  it("client_secret_post requires the right secret", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode({ clientKey: ctx.conf.client_id });
    expectGrantError(await ctx.exchange(raw, { client_id: ctx.conf.client_id }), "invalid_client");
    expectGrantError(await ctx.exchange(raw, { client_id: ctx.conf.client_id, client_secret: "wrong" }), "invalid_client");
    const ok = await ctx.exchange(raw, { client_id: ctx.conf.client_id, client_secret: ctx.conf.client_secret! });
    expect(ok.status).toBe(200);
  });

  it("a public client may not present a secret", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    expectGrantError(await ctx.exchange(raw, { client_secret: "anything" }), "invalid_client");
  });

  it("CIMD clients authenticate as public clients", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode({ clientKey: CIMD_URL, redirectUri: CIMD_REDIRECT });
    const res = await ctx.exchange(raw, { client_id: CIMD_URL, redirect_uri: CIMD_REDIRECT });
    expect(res.status).toBe(200);
    expect(ctx.logs.at(-1)).toEqual({ event: "gateway_token", clientHost: "claude.ai", result: "issued" });
  });

  it("rejects unsupported and missing grant types", async () => {
    const ctx = await setup();
    expectGrantError(await ctx.post("/token", { grant_type: "password", client_id: ctx.pub.client_id }), "unsupported_grant_type");
    expectGrantError(await ctx.post("/token", { client_id: ctx.pub.client_id }), "invalid_request");
  });

  it("rejects duplicated parameters", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    const res = await ctx.req
      .post("/token")
      .type("form")
      .send(`grant_type=authorization_code&code=${raw}&code=${raw}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_verifier=${VERIFIER}&client_id=${ctx.pub.client_id}`);
    expectGrantError(res, "invalid_request");
  });

  it("rejects bodies over 8kb", async () => {
    const ctx = await setup();
    const res = await ctx.post("/token", { grant_type: "authorization_code", client_id: ctx.pub.client_id, pad: "a".repeat(9000) });
    expect(res.status).toBe(413);
    expect((res.body as { error: string }).error).toBe("invalid_request");
    expectNoStore(res);
  });
});

describe("POST /token refresh_token", () => {
  async function issued() {
    const ctx = await setup();
    const { raw, familyId } = await ctx.addCode();
    const res = await ctx.exchange(raw);
    return { ctx, familyId, first: res.body as TokenBody };
  }

  it("rotates the refresh token", async () => {
    const { ctx, familyId, first } = await issued();
    const familyExpiresAt = (await ctx.store.getRefresh(sha256(first.refresh_token)))!.familyExpiresAt;
    ctx.advance(DAY);
    const res = await ctx.refresh(first.refresh_token);
    expect(res.status).toBe(200);
    expectNoStore(res);
    const body = res.body as TokenBody;
    expect(Object.keys(body).sort()).toEqual(["access_token", "expires_in", "refresh_token", "scope", "token_type"]);
    expect(body.refresh_token).not.toBe(first.refresh_token);
    expect(body.scope).toBe("portfolio:read");
    expect((await ctx.tokens.verifyAccess(body.access_token, ["portfolio:read"])).subject).toBe(SUBJECT);
    const next = await ctx.store.getRefresh(sha256(body.refresh_token));
    expect(next).toMatchObject({ familyId, parentHash: sha256(first.refresh_token), familyExpiresAt, revokedAt: null });
    // Sliding 30 d from now would pass the family's absolute end, so it is clamped.
    expect(next!.expiresAt).toEqual(familyExpiresAt);
    expect((await ctx.store.getRefresh(sha256(first.refresh_token)))?.rotatedAt).toEqual(ctx.now());
  });

  it("reuse of a rotated token revokes the family", async () => {
    const { ctx, first } = await issued();
    const second = (await ctx.refresh(first.refresh_token)).body as TokenBody;
    expectGrantError(await ctx.refresh(first.refresh_token));
    expect((await ctx.store.getRefresh(sha256(second.refresh_token)))?.revokedAt).toEqual(ctx.now());
    expectGrantError(await ctx.refresh(second.refresh_token));
  });

  it("the family ends 30 days after the code exchange, despite sliding renewals", async () => {
    const { ctx, first } = await issued();
    let token = first.refresh_token;
    for (let i = 0; i < 3; i += 1) {
      ctx.advance(9 * DAY);
      const res = await ctx.refresh(token);
      expect(res.status).toBe(200);
      token = (res.body as TokenBody).refresh_token;
    }
    // 27 days in: the newest token's sliding expiry is clamped to the family's end.
    expect((await ctx.store.getRefresh(sha256(token)))!.expiresAt).toEqual(new Date(ctx.now().getTime() + 3 * DAY));
    ctx.advance(3 * DAY - 1);
    const lastOk = await ctx.refresh(token);
    expect(lastOk.status).toBe(200);
    ctx.advance(1);
    expectGrantError(await ctx.refresh((lastOk.body as TokenBody).refresh_token));
  });

  it("a token past its sliding expiry gives invalid_grant", async () => {
    const { ctx, first } = await issued();
    ctx.advance(REFRESH_TTL_MS);
    expectGrantError(await ctx.refresh(first.refresh_token));
  });

  it("another client cannot use the token and does not burn it", async () => {
    const { ctx, first } = await issued();
    expectGrantError(await ctx.refresh(first.refresh_token, { client_id: ctx.other.client_id }));
    expect((await ctx.store.getRefresh(sha256(first.refresh_token)))?.rotatedAt).toBeNull();
    expect((await ctx.refresh(first.refresh_token)).status).toBe(200);
  });

  it("a different scope or resource is refused", async () => {
    const { ctx, first } = await issued();
    expectGrantError(await ctx.refresh(first.refresh_token, { scope: "connections:manage" }), "invalid_scope");
    expectGrantError(await ctx.refresh(first.refresh_token, { resource: "https://gw.example.test/other" }), "invalid_target");
    expect((await ctx.refresh(first.refresh_token, { scope: "portfolio:read", resource: RESOURCE })).status).toBe(200);
  });

  it("re-checks the user's consent: without it the family is revoked and refresh is invalid_grant", async () => {
    const { ctx, familyId, first } = await issued();
    expect(await ctx.store.deleteConsents(SUBJECT)).toBe(1);
    expectGrantError(await ctx.refresh(first.refresh_token));
    expect(ctx.logs.at(-1)).toEqual({ event: "gateway_token", clientHost: "host.example.test", result: "consent_missing" });
    const row = await ctx.store.getRefresh(sha256(first.refresh_token));
    expect(row?.familyId).toBe(familyId);
    expect(row?.revokedAt).toEqual(ctx.now());
    expect(row?.rotatedAt).toBeNull();
    // Consenting again does not revive the revoked family.
    await ctx.store.putConsent(SUBJECT, ctx.pub.client_id, "portfolio:read", ctx.now());
    expectGrantError(await ctx.refresh(first.refresh_token));
  });

  it("unknown or missing refresh tokens give invalid_grant", async () => {
    const { ctx } = await issued();
    expectGrantError(await ctx.refresh("not-a-token"));
    expectGrantError(await ctx.post("/token", { grant_type: "refresh_token", client_id: ctx.pub.client_id }), "invalid_request");
  });
});

describe("POST /revoke", () => {
  it("revokes the refresh token's family", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    const tok = (await ctx.exchange(raw)).body as TokenBody;
    const res = await ctx.post("/revoke", { token: tok.refresh_token, token_type_hint: "refresh_token", client_id: ctx.pub.client_id });
    expect(res.status).toBe(200);
    expectNoStore(res);
    expect((await ctx.store.getRefresh(sha256(tok.refresh_token)))?.revokedAt).toEqual(ctx.now());
    expectGrantError(await ctx.refresh(tok.refresh_token));
  });

  it("returns 200 for unknown tokens, access tokens and other clients' tokens without revoking", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode();
    const tok = (await ctx.exchange(raw)).body as TokenBody;
    expect((await ctx.post("/revoke", { token: "unknown", client_id: ctx.pub.client_id })).status).toBe(200);
    expect((await ctx.post("/revoke", { token: tok.access_token, client_id: ctx.pub.client_id })).status).toBe(200);
    expect((await ctx.post("/revoke", { token: tok.refresh_token, client_id: ctx.other.client_id })).status).toBe(200);
    expect((await ctx.store.getRefresh(sha256(tok.refresh_token)))?.revokedAt).toBeNull();
  });

  it("requires client authentication and a token", async () => {
    const ctx = await setup();
    expectGrantError(await ctx.post("/revoke", { token: "x" }), "invalid_client");
    const { raw } = await ctx.addCode({ clientKey: ctx.conf.client_id });
    const tok = (await ctx.exchange(raw, { client_id: ctx.conf.client_id, client_secret: ctx.conf.client_secret! })).body as TokenBody;
    expectGrantError(await ctx.post("/revoke", { token: tok.refresh_token, client_id: ctx.conf.client_id }), "invalid_client");
    expectGrantError(
      await ctx.post("/revoke", { token: tok.refresh_token, client_id: ctx.conf.client_id, client_secret: "wrong" }),
      "invalid_client",
    );
    expect((await ctx.store.getRefresh(sha256(tok.refresh_token)))?.revokedAt).toBeNull();
    expectGrantError(await ctx.post("/revoke", { client_id: ctx.pub.client_id }), "invalid_request");
  });
});

describe("POST /register", () => {
  it("passes through to ClientRegistry", async () => {
    const ctx = await setup();
    const spy = vi.spyOn(ctx.clients, "register");
    const res = await ctx.req.post("/register").send({ redirect_uris: [REDIRECT], client_name: "New host" });
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.body as { client_id: string; client_name: string };
    expect(body.client_name).toBe("New host");
    expect((await ctx.clients.resolve(body.client_id))?.name).toBe("New host");
    expect(spy).toHaveBeenCalledTimes(1);
    const ipHash = spy.mock.calls[0]![1];
    expect(ipHash).toBe(sha256("127.0.0.1").slice(0, 32));
    expect(spy.mock.calls[0]![2]).toBeNull(); // IPv4: no /48 key
  });

  it("passes through validation errors", async () => {
    const ctx = await setup();
    const res = await ctx.req.post("/register").send({ redirect_uris: ["http://evil.example.test/cb"] });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("invalid_redirect_uri");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("returns a JSON server_error when registration throws", async () => {
    const ctx = await setup();
    vi.spyOn(ctx.clients, "register").mockRejectedValue(new Error("db down"));
    const res = await ctx.req.post("/register").send({ redirect_uris: [REDIRECT] });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "server_error" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(ctx.logs.at(-1)).toEqual({ event: "gateway_register", clientHost: "unknown", result: "server_error" });
  });

  it("rejects bodies over 16kb", async () => {
    const ctx = await setup();
    const res = await ctx.req.post("/register").send({ redirect_uris: [REDIRECT], client_name: "a".repeat(17_000) });
    expect(res.status).toBe(413);
    expect((res.body as { error: string }).error).toBe("invalid_client_metadata");
  });
});

describe("the memory scope (new authorizations only; refresh never escalates)", () => {
  const GRANTED = "portfolio:read memory";

  it("a code from a new authorization issues portfolio:read memory, on the token and its refresh family", async () => {
    const ctx = await setup();
    const { raw, familyId } = await ctx.addCode({ scope: GRANTED });
    const res = await ctx.exchange(raw);
    expect(res.status).toBe(200);
    const body = res.body as TokenBody;
    expect(body.scope).toBe(GRANTED);
    const identity = await ctx.tokens.verifyAccess(body.access_token, ["portfolio:read"]);
    expect([...identity.scopes].sort()).toEqual(["memory", "portfolio:read"]);
    expect(await ctx.store.getRefresh(sha256(body.refresh_token))).toMatchObject({ familyId, scope: GRANTED });

    const next = await ctx.refresh(body.refresh_token);
    expect(next.status).toBe(200);
    expect((next.body as TokenBody).scope).toBe(GRANTED);
    const nextIdentity = await ctx.tokens.verifyAccess((next.body as TokenBody).access_token, ["portfolio:read", "memory"]);
    expect(nextIdentity.subject).toBe(SUBJECT);
    expect((await ctx.store.getRefresh(sha256((next.body as TokenBody).refresh_token)))?.scope).toBe(GRANTED);
  });

  it("a code issued before the change (portfolio:read) still exchanges, for portfolio:read only", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode({ scope: "portfolio:read" });
    const res = await ctx.exchange(raw, { scope: "portfolio:read memory" });
    expect(res.status).toBe(200);
    expect((res.body as TokenBody).scope).toBe("portfolio:read");
    const identity = await ctx.tokens.verifyAccess((res.body as TokenBody).access_token, ["portfolio:read"]);
    expect([...identity.scopes]).toEqual(["portfolio:read"]);
  });

  it("a refresh family created before the change keeps portfolio:read, whatever scope the refresh asks for", async () => {
    const ctx = await setup();
    const { raw, familyId } = await ctx.addCode({ scope: "portfolio:read" });
    let token = ((await ctx.exchange(raw)).body as TokenBody).refresh_token;
    for (const scope of [undefined, "portfolio:read", "portfolio:read memory", "memory portfolio:read offline_access"]) {
      const res = await ctx.refresh(token, scope === undefined ? {} : { scope });
      expect(res.status).toBe(200);
      const body = res.body as TokenBody;
      expect(body.scope).toBe("portfolio:read");
      const identity = await ctx.tokens.verifyAccess(body.access_token, ["portfolio:read"]);
      expect(identity.scopes.has("memory")).toBe(false);
      await expect(ctx.tokens.verifyAccess(body.access_token, ["memory"])).rejects.toThrow();
      expect(await ctx.store.getRefresh(sha256(body.refresh_token))).toMatchObject({ familyId, scope: "portfolio:read" });
      token = body.refresh_token;
    }
  });

  it("a refresh asking for memory alone is invalid_scope and does not burn the token", async () => {
    const ctx = await setup();
    const { raw } = await ctx.addCode({ scope: GRANTED });
    const rt = ((await ctx.exchange(raw)).body as TokenBody).refresh_token;
    expectGrantError(await ctx.refresh(rt, { scope: "memory" }), "invalid_scope");
    expectGrantError(await ctx.exchange("unused", { scope: "memory" }), "invalid_grant");
    expect((await ctx.refresh(rt)).status).toBe(200);
  });

  it.each(["memory", "portfolio:read connections:manage", "memory portfolio:read", ""])(
    "a stored grant %j that is not a known grant is refused as wrong_scope",
    async (scope) => {
      const ctx = await setup();
      const { raw } = await ctx.addCode({ scope });
      expectGrantError(await ctx.exchange(raw));
      expect(ctx.logs.at(-1)).toEqual({ event: "gateway_token", clientHost: "host.example.test", result: "wrong_scope" });

      const { raw: ok } = await ctx.addCode({ scope: GRANTED });
      const rt = ((await ctx.exchange(ok)).body as TokenBody).refresh_token;
      const row = (await ctx.store.getRefresh(sha256(rt)))!;
      await ctx.store.createRefresh({ ...row, tokenHash: sha256("tampered-refresh"), scope, parentHash: null });
      expectGrantError(await ctx.refresh("tampered-refresh"));
      expect(ctx.logs.at(-1)).toEqual({ event: "gateway_token", clientHost: "host.example.test", result: "wrong_scope" });
    },
  );
});
