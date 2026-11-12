import { createHash } from "node:crypto";
import express from "express";
import { describe, expect, it } from "vitest";

import { OWNER_SUBJECT } from "../identity/owner-identity.js";
import { loopbackRequest } from "../testing/loopback-request.js";
import type { OwnerSessionStore } from "../auth/owner-session.js";
import { localOwnerUpstream, LOCAL_AUTHORIZE_PATH } from "./local-upstream.js";

const ISSUER = "https://vestlens.example.test";
const CALLBACK = `${ISSUER}/oauth/upstream/callback`;
const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const GOOD = "good-session-token";
const sessions = { resolve: async (t: string) => t === GOOD } as unknown as OwnerSessionStore;

function build(clock: { now: Date } = { now: new Date("2026-11-11T12:00:00Z") }) {
  const local = localOwnerUpstream({ sessions, issuer: ISSUER, now: () => clock.now });
  const app = express();
  app.use(local.router);
  return { ...local, app, clock };
}

function authorizeUrl(local: ReturnType<typeof build>, over: Partial<{ state: string; nonce: string; redirectUri: string }> = {}) {
  return local.upstream.authorizeUrl({
    state: over.state ?? "state-1",
    nonce: over.nonce ?? "nonce-1",
    codeChallenge: CHALLENGE,
    redirectUri: over.redirectUri ?? CALLBACK,
  });
}

async function codeFor(local: ReturnType<typeof build>, over: Parameters<typeof authorizeUrl>[1] = {}) {
  const res = await (await loopbackRequest(local.app)).get(authorizeUrl(local, over)).set("Cookie", `vl_session=${GOOD}`);
  expect(res.status).toBe(302);
  const back = new URL(res.headers.location!);
  return { code: back.searchParams.get("code")!, back };
}

const exchangeArgs = (code: string, over: Record<string, string> = {}) => ({
  code, verifier: VERIFIER, redirectUri: CALLBACK, nonce: "nonce-1", ...over,
});

describe("localOwnerUpstream", () => {
  it("returns a path-only authorize URL carrying state, nonce, challenge and redirect_uri", () => {
    const url = authorizeUrl(build());
    expect(url.startsWith("/oauth/local/authorize?")).toBe(true);
    const q = new URL(url, "https://x.invalid").searchParams;
    expect(q.get("state")).toBe("state-1");
    expect(q.get("nonce")).toBe("nonce-1");
    expect(q.get("code_challenge")).toBe(CHALLENGE);
    expect(q.get("redirect_uri")).toBe(CALLBACK);
  });

  it("sends a signed-out browser to /login and back", async () => {
    const local = build();
    const url = authorizeUrl(local);
    const req = await loopbackRequest(local.app);
    for (const cookie of [undefined, "vl_session=stale-token"]) {
      const res = cookie ? await req.get(url).set("Cookie", cookie) : await req.get(url);
      expect(res.status).toBe(302);
      const location = res.headers.location!;
      expect(location.startsWith("/login?continue=")).toBe(true);
      const cont = new URL(location, "https://x.invalid").searchParams.get("continue")!;
      expect(cont).toBe(url);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    // Signed in: straight back to the gateway callback with a code and the same state.
    const { back, code } = await codeFor(local);
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get("state")).toBe("state-1");
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("issues a one-time code that exchanges once with the right verifier", async () => {
    const local = build();
    const { code } = await codeFor(local);
    await expect(local.upstream.exchange(exchangeArgs(code))).resolves.toEqual({ subject: OWNER_SUBJECT, emailVerified: true });
    await expect(local.upstream.exchange(exchangeArgs(code))).rejects.toThrow("invalid_grant");

    // A wrong verifier burns the code too.
    const second = await codeFor(local);
    await expect(local.upstream.exchange(exchangeArgs(second.code, { verifier: "w".repeat(43) }))).rejects.toThrow("invalid_grant");
    await expect(local.upstream.exchange(exchangeArgs(second.code))).rejects.toThrow("invalid_grant");
  });

  it("rejects a wrong nonce, a wrong redirect_uri and an unknown code", async () => {
    const local = build();
    const a = await codeFor(local);
    await expect(local.upstream.exchange(exchangeArgs(a.code, { nonce: "other" }))).rejects.toThrow("invalid_grant");
    const b = await codeFor(local);
    await expect(local.upstream.exchange(exchangeArgs(b.code, { redirectUri: `${ISSUER}/elsewhere` }))).rejects.toThrow("invalid_grant");
    await expect(local.upstream.exchange(exchangeArgs("nope"))).rejects.toThrow("invalid_grant");
  });

  it("rejects a foreign redirect_uri", async () => {
    const local = build();
    const req = await loopbackRequest(local.app);
    for (const redirectUri of ["https://evil.example.test/oauth/upstream/callback", `${CALLBACK}/`, `${CALLBACK}?x=1`, ""]) {
      const res = await req.get(authorizeUrl(local, { redirectUri })).set("Cookie", `vl_session=${GOOD}`);
      expect(res.status, redirectUri).toBe(400);
      expect(res.headers.location).toBeUndefined();
    }
    // Rejected before the sign-in check, so a signed-out browser learns nothing either.
    expect((await req.get(authorizeUrl(local, { redirectUri: "https://evil.example.test/cb" }))).status).toBe(400);
  });

  it("rejects a malformed challenge or missing state", async () => {
    const local = build();
    const req = await loopbackRequest(local.app);
    const bad = `/oauth/local/authorize?state=s&nonce=n&code_challenge=short&redirect_uri=${encodeURIComponent(CALLBACK)}`;
    expect((await req.get(bad).set("Cookie", `vl_session=${GOOD}`)).status).toBe(400);
    const noState = `/oauth/local/authorize?nonce=n&code_challenge=${CHALLENGE}&redirect_uri=${encodeURIComponent(CALLBACK)}`;
    expect((await req.get(noState).set("Cookie", `vl_session=${GOOD}`)).status).toBe(400);
  });

  it("rejects a missing nonce or a missing code_challenge", async () => {
    const local = build();
    const req = await loopbackRequest(local.app);
    const cb = encodeURIComponent(CALLBACK);
    const noNonce = `${LOCAL_AUTHORIZE_PATH}?state=s&code_challenge=${CHALLENGE}&redirect_uri=${cb}`;
    const noChallenge = `${LOCAL_AUTHORIZE_PATH}?state=s&nonce=n&redirect_uri=${cb}`;
    for (const url of [noNonce, noChallenge]) {
      const res = await req.get(url).set("Cookie", `vl_session=${GOOD}`);
      expect(res.status, url).toBe(400);
      expect(res.headers.location).toBeUndefined();
    }
  });

  it("rejects duplicate or array query parameters", async () => {
    const local = build();
    const req = await loopbackRequest(local.app);
    const cb = encodeURIComponent(CALLBACK);
    const base = `state=s&nonce=n&code_challenge=${CHALLENGE}&redirect_uri=${cb}`;
    for (const extra of ["state=t", "nonce=m", `code_challenge=${CHALLENGE}`, `redirect_uri=${cb}`, "state[]=t", "state[a]=t"]) {
      const res = await req.get(`${LOCAL_AUTHORIZE_PATH}?${base}&${extra}`).set("Cookie", `vl_session=${GOOD}`);
      expect(res.status, extra).toBe(400);
      expect(res.headers.location).toBeUndefined();
    }
  });

  it("treats more than one vl_session cookie as signed out", async () => {
    const local = build();
    const res = await (await loopbackRequest(local.app)).get(authorizeUrl(local)).set("Cookie", `vl_session=${GOOD}; vl_session=${GOOD}`);
    expect(res.status).toBe(302);
    expect(res.headers.location!.startsWith("/login?continue=")).toBe(true);
  });

  it("answers 503 when the session lookup throws", async () => {
    const throwing = { resolve: async () => { throw new Error("db down"); } } as unknown as OwnerSessionStore;
    const local = localOwnerUpstream({ sessions: throwing, issuer: ISSUER });
    const app = express();
    app.use(local.router);
    const url = local.upstream.authorizeUrl({ state: "s", nonce: "n", codeChallenge: CHALLENGE, redirectUri: CALLBACK });
    const res = await (await loopbackRequest(app)).get(url).set("Cookie", `vl_session=${GOOD}`);
    expect(res.status).toBe(503);
    expect(res.headers.location).toBeUndefined();
  });

  it("answers 503 at the 1000-code cap, and recovers once codes expire", async () => {
    const local = build();
    const req = await loopbackRequest(local.app);
    const url = authorizeUrl(local);
    for (let i = 0; i < 1000; i += 1) {
      expect((await req.get(url).set("Cookie", `vl_session=${GOOD}`)).status).toBe(302);
    }
    expect((await req.get(url).set("Cookie", `vl_session=${GOOD}`)).status).toBe(503);
    local.clock.now = new Date(local.clock.now.getTime() + 5 * 60_000);
    expect((await req.get(url).set("Cookie", `vl_session=${GOOD}`)).status).toBe(302);
  });

  it("sets Referrer-Policy: no-referrer on the code redirect", async () => {
    const local = build();
    const res = await (await loopbackRequest(local.app)).get(authorizeUrl(local)).set("Cookie", `vl_session=${GOOD}`);
    expect(res.status).toBe(302);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("rejects a code after 5 minutes", async () => {
    const local = build();
    const fresh = await codeFor(local);
    local.clock.now = new Date(local.clock.now.getTime() + 5 * 60_000 - 1);
    await expect(local.upstream.exchange(exchangeArgs(fresh.code))).resolves.toMatchObject({ subject: OWNER_SUBJECT });

    local.clock.now = new Date("2026-11-11T12:00:00Z");
    const stale = await codeFor(local);
    local.clock.now = new Date(local.clock.now.getTime() + 5 * 60_000);
    await expect(local.upstream.exchange(exchangeArgs(stale.code))).rejects.toThrow("invalid_grant");
  });
});
