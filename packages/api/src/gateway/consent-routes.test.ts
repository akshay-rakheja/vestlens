import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loopbackRequest } from "../testing/loopback-request.js";
import { BROWSER_BINDING_COOKIE } from "./authorize-routes.js";
import { CimdResolver } from "./cimd.js";
import { ClientRegistry } from "./clients.js";
import { CODE_TTL_MS, CONSENT_ACCESS_COPY, CONSENT_MEMORY_COPY, CSRF_COOKIE, consentRouter } from "./consent-routes.js";
import { sha256 } from "./crypto.js";
import { MemoryGatewayStore, type PendingAuthorization } from "./store.js";

const ISSUER = "https://gw.example.test";
const RESOURCE = "https://gw.example.test/mcp";
const HOST_REDIRECT = "https://host.example.test/cb?keep=1";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const SUBJECT = "subject|abc";
const BINDING = "binding-value-1";
const CIMD_URL = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CIMD_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";
const pageCsp = (origin: string | null) =>
  `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${origin ? ` ${origin}` : ""}; frame-ancestors 'none'; base-uri 'none'`;

type Res = { status: number; headers: Record<string, unknown>; text: string };

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
    freshUntil: new Date(now.getTime() + 3_600_000),
    staleUntil: new Date(now.getTime() + 7_200_000),
  });
  const clients = new ClientRegistry({ store, cimd, now: () => now });
  const register = async (name: string, redirects = [HOST_REDIRECT]) => {
    const reg = await clients.register({ redirect_uris: redirects, client_name: name }, "ip");
    return (reg.body as { client_id: string }).client_id;
  };
  const clientA = await register("Client A");
  const clientB = await register("Client B");
  const logs: unknown[] = [];
  const app = express();
  // As in the app: one trusted proxy hop, so req.ip is the X-Forwarded-For client.
  app.set("trust proxy", 1);
  app.use(consentRouter({ store, clients, issuer: ISSUER, now: () => now, log: (e) => logs.push(e) }));
  const req = await loopbackRequest(app);
  let n = 0;
  const addPending = async (over: Partial<PendingAuthorization> = {}) => {
    n += 1;
    const p: PendingAuthorization = {
      id: `pending-${n}`,
      clientKey: clientA,
      redirectUri: HOST_REDIRECT,
      state: "host-state",
      codeChallenge: CHALLENGE,
      scope: "portfolio:read memory",
      resource: RESOURCE,
      upstreamState: `us-${n}`,
      upstreamNonce: `nonce-${n}`,
      upstreamVerifier: `verifier-${n}`,
      subject: SUBJECT,
      consentCsrf: null,
      browserBindingHash: sha256(BINDING),
      upstreamClaimedAt: now,
      expiresAt: new Date(now.getTime() + 600_000),
      ...over,
    };
    await store.createPending(p);
    return p;
  };
  return {
    store,
    clients,
    req,
    logs,
    clientA,
    clientB,
    register,
    addPending,
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const bindingCookie = `${BROWSER_BINDING_COOKIE}=${BINDING}`;

function setCookies(res: Res): string[] {
  return (res.headers["set-cookie"] as string[] | undefined) ?? [];
}

function csrfFrom(res: Res): string {
  const m = /name="csrf" value="([^"]+)"/.exec(res.text);
  expect(m).not.toBeNull();
  return m![1]!;
}

function getConsent(ctx: Ctx, id: string, cookie: string | null = bindingCookie) {
  const r = ctx.req.get(`/oauth/consent?p=${encodeURIComponent(id)}`);
  return cookie === null ? r : r.set("Cookie", cookie);
}

function postConsent(ctx: Ctx, form: Record<string, string>, cookie: string | null) {
  const r = ctx.req.post("/oauth/consent").type("form").send(new URLSearchParams(form).toString());
  return cookie === null ? r : r.set("Cookie", cookie);
}

/** GET the page, then POST with matching CSRF in form and cookie. */
async function consent(ctx: Ctx, id: string, action: "allow" | "deny") {
  const page = await getConsent(ctx, id);
  expect(page.status).toBe(200);
  const csrf = csrfFrom(page);
  return postConsent(ctx, { p: id, csrf, action }, `${bindingCookie}; ${CSRF_COOKIE}=${csrf}`);
}

function hostParams(location: unknown, expectedBase = "https://host.example.test/cb") {
  expect(typeof location).toBe("string");
  const u = new URL(location as string);
  expect(u.origin + u.pathname).toBe(expectedBase);
  // RFC 9207: every authorization response names the issuer.
  expect(u.searchParams.get("iss")).toBe(ISSUER);
  return u.searchParams;
}

function expectErrorPage(res: Res, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers.location).toBeUndefined();
  expect(res.headers["content-type"]).toMatch(/^text\/html/);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.headers["x-frame-options"]).toBe("DENY");
  expect(res.text).toContain("<title>Sign-in problem</title>");
}

function expectClearedCookies(res: Res) {
  const cookies = setCookies(res);
  for (const name of [BROWSER_BINDING_COOKIE, CSRF_COOKIE]) {
    const c = cookies.find((v) => v.startsWith(`${name}=`));
    expect(c, name).toBeDefined();
    expect(c).toMatch(/Max-Age=0/);
    expect(c).toMatch(/Path=\//);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/Secure/);
    expect(c).toMatch(/SameSite=Lax/);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("GET /oauth/consent", () => {
  it("renders the consent page with client name, redirect host, copy, CSRF field and cookie", async () => {
    const ctx = await setup();
    const p = await ctx.addPending();
    const res = await getConsent(ctx, p.id);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.text).toContain("Client A");
    expect(res.text).toContain("host.example.test");
    expect(res.text).toContain(CONSENT_ACCESS_COPY);
    expect(CONSENT_ACCESS_COPY).toBe("Read your portfolio: balances, holdings, activity. No trading or money movement.");
    // The memory scope is part of the standard grant: a plain statement, never a checkbox.
    expect(CONSENT_MEMORY_COPY).toBe("Save the TFSA and FHSA room details and the limits you give it, so VestLens can check them for you.");
    expect(res.text).toContain(`<p>${CONSENT_MEMORY_COPY}</p>`);
    expect(res.text).not.toMatch(/<input[^>]*type="checkbox"/);
    expect(res.text).toMatch(/<button[^>]*name="action"[^>]*value="allow"/);
    expect(res.text).toMatch(/<button[^>]*name="action"[^>]*value="deny"/);
    expect(res.text).toContain("Unverified app");
    expect(res.text).not.toContain("Verified:");
    expect(res.text).toContain("prefers-color-scheme: dark");
    expect(res.text).not.toMatch(/<script|<link|<img|src=/i);
    const csrf = csrfFrom(res);
    expect(csrf.length).toBeGreaterThanOrEqual(43);
    expect((await ctx.store.getPending(p.id))?.consentCsrf).toBe(csrf);
    const cookie = setCookies(res).find((c) => c.startsWith(`${CSRF_COOKIE}=`));
    expect(cookie).toBe(`${CSRF_COOKIE}=${csrf}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`);
    expect(res.text).toContain(`name="p" value="${p.id}"`);
  });

  it("sends no-store, frame denial and the strict CSP", async () => {
    const ctx = await setup();
    const p = await ctx.addPending();
    const res = await getConsent(ctx, p.id);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    // form-action covers our own origin and, because browsers apply it to the
    // post-submit redirect, the redirect_uri's origin.
    expect(csp).toContain("form-action 'self' https://host.example.test;");
  });

  it("page CSP is exact, adds only an LDH redirect origin and sets base-uri 'none'", async () => {
    const ctx = await setup();
    const p = await ctx.addPending();
    expect((await getConsent(ctx, p.id)).headers["content-security-policy"]).toBe(pageCsp("https://host.example.test"));
  });

  it("page CSP adds loopback origins with their port", async () => {
    const ctx = await setup();
    const loop = await ctx.register("Loop", ["http://127.0.0.1:8080/callback", "http://localhost:8080/cb"]);
    const a = await ctx.addPending({ clientKey: loop, redirectUri: "http://127.0.0.1:53123/callback" });
    expect((await getConsent(ctx, a.id)).headers["content-security-policy"]).toBe(pageCsp("http://127.0.0.1:53123"));
    const b = await ctx.addPending({ clientKey: loop, redirectUri: "http://localhost:8080/cb" });
    expect((await getConsent(ctx, b.id)).headers["content-security-policy"]).toBe(pageCsp("http://localhost:8080"));
  });

  it("page CSP falls back to the base form-action for a non-LDH redirect host", async () => {
    const ctx = await setup();
    const odd = "https://a;b.com/cb";
    const p = await ctx.addPending({ redirectUri: odd });
    const real = ctx.clients.resolve.bind(ctx.clients);
    vi.spyOn(ctx.clients, "resolve").mockImplementation(async (id) => {
      const c = await real(id);
      return c ? { ...c, redirectUris: [odd] } : c;
    });
    const res = await getConsent(ctx, p.id);
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toBe(pageCsp(null));
  });

  it("a stored consent never issues a code on GET: the page is shown, noting the earlier approval", async () => {
    const ctx = await setup();
    await ctx.store.putConsent(SUBJECT, ctx.clientA, "portfolio:read", ctx.now());
    const p = await ctx.addPending();
    const createCode = vi.spyOn(ctx.store, "createCode");
    expectErrorPage(await getConsent(ctx, p.id, null), 400);
    expectErrorPage(await getConsent(ctx, p.id, `${BROWSER_BINDING_COOKIE}=wrong`), 400);
    const page = await getConsent(ctx, p.id);
    expect(page.status).toBe(200);
    expect(page.headers.location).toBeUndefined();
    expect(page.text).toContain("You approved this app before.");
    expect(createCode).not.toHaveBeenCalled();
    expect((await ctx.store.getPending(p.id))?.subject).toBe(SUBJECT);
  });

  it("does not note an earlier approval on first use", async () => {
    const ctx = await setup();
    const res = await getConsent(ctx, (await ctx.addPending()).id);
    expect(res.text).not.toContain("You approved this app before.");
  });

  it("escapes a client name containing <script>", async () => {
    const ctx = await setup();
    const evil = await ctx.register(`<script>alert("x")</script>&'`);
    const p = await ctx.addPending({ clientKey: evil });
    const res = await getConsent(ctx, p.id);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("<script>");
    expect(res.text).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
  });

  it("shows the verified badge for a CIMD client on a known host", async () => {
    const ctx = await setup();
    const p = await ctx.addPending({ clientKey: CIMD_URL, redirectUri: CIMD_REDIRECT });
    const res = await getConsent(ctx, p.id);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Claude");
    expect(res.text).toContain("Verified: claude.ai");
    expect(res.text).not.toContain("Unverified app");
  });

  it("gives an error page for a pending without a subject, leaving it untouched", async () => {
    const ctx = await setup();
    const p = await ctx.addPending({ subject: null });
    const res = await getConsent(ctx, p.id);
    expectErrorPage(res, 400);
    expect(await ctx.store.getPending(p.id)).toEqual(p);
  });

  it("gives an error page for a missing or unknown pending", async () => {
    const ctx = await setup();
    expectErrorPage(await ctx.req.get("/oauth/consent"), 400);
    expectErrorPage(await getConsent(ctx, "nope"), 400);
    expectErrorPage(await ctx.req.get("/oauth/consent?p=a&p=b").set("Cookie", bindingCookie), 400);
  });

  it("gives an error page for an expired pending", async () => {
    const ctx = await setup();
    const p = await ctx.addPending();
    ctx.advance(600_000);
    expectErrorPage(await getConsent(ctx, p.id), 400);
  });

  it("requires the browser binding cookie and leaves the pending untouched", async () => {
    const ctx = await setup();
    const p = await ctx.addPending();
    expectErrorPage(await getConsent(ctx, p.id, null), 400);
    expectErrorPage(await getConsent(ctx, p.id, `${BROWSER_BINDING_COOKIE}=other`), 400);
    expectErrorPage(await getConsent(ctx, p.id, `${bindingCookie}; ${bindingCookie}`), 400);
    expect(await ctx.store.getPending(p.id)).toEqual(p);
  });

  it("re-resolves the client: a deleted client or a no-longer-allowed redirect gives an error page", async () => {
    const ctx = await setup();
    const gone = await ctx.addPending({ clientKey: "deleted-client" });
    expectErrorPage(await getConsent(ctx, gone.id), 400);
    const moved = await ctx.addPending({ redirectUri: "https://host.example.test/other" });
    expectErrorPage(await getConsent(ctx, moved.id), 400);
    expect(await ctx.store.getPending(moved.id)).toEqual(moved);
  });
});

describe("POST /oauth/consent", () => {
  it("allow: stores consent, issues a hashed 60 s code bound to the request, deletes the pending, redirects", async () => {
    const ctx = await setup();
    const p = await ctx.addPending();
    const res = await consent(ctx, p.id, "allow");
    expect(res.status).toBe(303);
    expect(res.headers["cache-control"]).toBe("no-store");
    const q = hostParams(res.headers.location);
    expect(q.get("keep")).toBe("1");
    expect(q.get("state")).toBe("host-state");
    const code = q.get("code")!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await ctx.store.hasConsent(SUBJECT, ctx.clientA)).toBe(true);
    expect(await ctx.store.getPending(p.id)).toBeNull();
    expect(await ctx.store.consumeCode(code, ctx.now())).toBeNull(); // raw code is never the key
    const stored = await ctx.store.consumeCode(sha256(code), ctx.now());
    expect(stored).toMatchObject({
      codeHash: sha256(code),
      clientKey: ctx.clientA,
      redirectUri: HOST_REDIRECT,
      codeChallenge: CHALLENGE,
      subject: SUBJECT,
      scope: "portfolio:read memory",
      resource: RESOURCE,
      expiresAt: new Date(ctx.now().getTime() + CODE_TTL_MS),
    });
    expect(CODE_TTL_MS).toBe(60_000);
    expect(typeof (stored as { familyId: string }).familyId).toBe("string");
    expectClearedCookies(res);
    for (const e of ctx.logs) expect(Object.keys(e as object).sort()).toEqual(["clientHost", "event", "result"]);
    expect(JSON.stringify(ctx.logs)).not.toContain(SUBJECT);
    expect(JSON.stringify(ctx.logs)).not.toContain(code);
  });

  it("omits state when the pending has none", async () => {
    const ctx = await setup();
    const p = await ctx.addPending({ state: null });
    const res = await consent(ctx, p.id, "allow");
    const q = hostParams(res.headers.location);
    expect(q.has("state")).toBe(false);
    expect(q.get("code")).toBeTruthy();
  });

  it("consent is shown on every authorization (Ruling R3): the second one is approved with one POST", async () => {
    const ctx = await setup();
    const first = await ctx.addPending();
    expect((await consent(ctx, first.id, "allow")).status).toBe(303);

    const second = await ctx.addPending({ state: "second-state" });
    const page = await getConsent(ctx, second.id);
    expect(page.status).toBe(200);
    expect(page.text).toContain("You approved this app before.");
    expect(await ctx.store.getPending(second.id)).not.toBeNull();
    const csrf = csrfFrom(page);
    const res = await postConsent(ctx, { p: second.id, csrf, action: "allow" }, `${bindingCookie}; ${CSRF_COOKIE}=${csrf}`);
    expect(res.status).toBe(303);
    expect(res.headers["cache-control"]).toBe("no-store");
    const q = hostParams(res.headers.location);
    expect(q.get("state")).toBe("second-state");
    const code = q.get("code")!;
    expect(await ctx.store.consumeCode(sha256(code), ctx.now())).toMatchObject({ clientKey: ctx.clientA, subject: SUBJECT });
    expect(await ctx.store.getPending(second.id)).toBeNull();
    const binding = setCookies(res).find((c) => c.startsWith(`${BROWSER_BINDING_COOKIE}=`));
    expect(binding).toMatch(/Max-Age=0/);
  });

  it("issues a new familyId for each code", async () => {
    const ctx = await setup();
    const a = await consent(ctx, (await ctx.addPending()).id, "allow");
    const b = await consent(ctx, (await ctx.addPending()).id, "allow");
    const ca = await ctx.store.consumeCode(sha256(hostParams(a.headers.location).get("code")!), ctx.now());
    const cb = await ctx.store.consumeCode(sha256(hostParams(b.headers.location).get("code")!), ctx.now());
    expect((ca as { familyId: string }).familyId).not.toBe((cb as { familyId: string }).familyId);
  });

  it("consent for client A does not satisfy client B (confused deputy)", async () => {
    const ctx = await setup();
    expect((await consent(ctx, (await ctx.addPending()).id, "allow")).status).toBe(303);
    const forB = await ctx.addPending({ clientKey: ctx.clientB });
    const res = await getConsent(ctx, forB.id);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Client B");
    expect(await ctx.store.hasConsent(SUBJECT, ctx.clientB)).toBe(false);
    // A different subject doesn't inherit client A's consent either.
    const other = await ctx.addPending({ subject: "subject|other" });
    expect((await getConsent(ctx, other.id)).status).toBe(200);
  });

  it("deny maps to access_denied and stores no consent", async () => {
    const ctx = await setup();
    const p = await ctx.addPending();
    const res = await consent(ctx, p.id, "deny");
    expect(res.status).toBe(303);
    const q = hostParams(res.headers.location);
    expect(q.get("error")).toBe("access_denied");
    expect(q.get("state")).toBe("host-state");
    expect(q.get("keep")).toBe("1");
    expect(q.has("code")).toBe(false);
    expect(await ctx.store.hasConsent(SUBJECT, ctx.clientA)).toBe(false);
    expect(await ctx.store.getPending(p.id)).toBeNull();
    expectClearedCookies(res);
  });

  describe("CSRF", () => {
    async function prepared(ctx: Ctx) {
      const p = await ctx.addPending();
      const csrf = csrfFrom(await getConsent(ctx, p.id));
      return { p, csrf };
    }

    it("a missing CSRF form value gives 403", async () => {
      const ctx = await setup();
      const { p, csrf } = await prepared(ctx);
      const res = await postConsent(ctx, { p: p.id, action: "allow" }, `${bindingCookie}; ${CSRF_COOKIE}=${csrf}`);
      expectErrorPage(res, 403);
      expect(await ctx.store.getPending(p.id)).not.toBeNull();
      expect(await ctx.store.hasConsent(SUBJECT, ctx.clientA)).toBe(false);
    });

    it("a missing CSRF cookie gives 403", async () => {
      const ctx = await setup();
      const { p, csrf } = await prepared(ctx);
      expectErrorPage(await postConsent(ctx, { p: p.id, csrf, action: "allow" }, bindingCookie), 403);
    });

    it("a mismatched form value or cookie gives 403", async () => {
      const ctx = await setup();
      const { p, csrf } = await prepared(ctx);
      const forged = "x".repeat(csrf.length);
      expectErrorPage(await postConsent(ctx, { p: p.id, csrf: forged, action: "allow" }, `${bindingCookie}; ${CSRF_COOKIE}=${csrf}`), 403);
      expectErrorPage(await postConsent(ctx, { p: p.id, csrf, action: "allow" }, `${bindingCookie}; ${CSRF_COOKIE}=${forged}`), 403);
      // Form and cookie agree but differ from the stored token.
      expectErrorPage(await postConsent(ctx, { p: p.id, csrf: forged, action: "allow" }, `${bindingCookie}; ${CSRF_COOKIE}=${forged}`), 403);
      expect(await ctx.store.getPending(p.id)).not.toBeNull();
    });

    it("a pending that never rendered the page (no stored token) gives 403", async () => {
      const ctx = await setup();
      const p = await ctx.addPending();
      expectErrorPage(await postConsent(ctx, { p: p.id, csrf: "", action: "allow" }, `${bindingCookie}; ${CSRF_COOKIE}=`), 403);
    });
  });

  it("POST requires the browser binding, an unexpired pending with a subject", async () => {
    const ctx = await setup();
    const p = await ctx.addPending();
    const csrf = csrfFrom(await getConsent(ctx, p.id));
    const withCsrf = `${CSRF_COOKIE}=${csrf}`;
    expectErrorPage(await postConsent(ctx, { p: p.id, csrf, action: "allow" }, withCsrf), 400);
    expectErrorPage(await postConsent(ctx, { p: p.id, csrf, action: "allow" }, `${BROWSER_BINDING_COOKIE}=other; ${withCsrf}`), 400);
    expect(await ctx.store.getPending(p.id)).not.toBeNull();

    const noSubject = await ctx.addPending({ subject: null, consentCsrf: csrf });
    expectErrorPage(await postConsent(ctx, { p: noSubject.id, csrf, action: "allow" }, `${bindingCookie}; ${withCsrf}`), 400);

    ctx.advance(600_000);
    expectErrorPage(await postConsent(ctx, { p: p.id, csrf, action: "allow" }, `${bindingCookie}; ${withCsrf}`), 400);
    expect(await ctx.store.hasConsent(SUBJECT, ctx.clientA)).toBe(false);
  });

  it("rejects an unknown action, an unknown pending and an oversize body", async () => {
    const ctx = await setup();
    const p = await ctx.addPending();
    const csrf = csrfFrom(await getConsent(ctx, p.id));
    const cookies = `${bindingCookie}; ${CSRF_COOKIE}=${csrf}`;
    expectErrorPage(await postConsent(ctx, { p: p.id, csrf, action: "maybe" }, cookies), 400);
    expectErrorPage(await postConsent(ctx, { p: "nope", csrf, action: "allow" }, cookies), 400);
    const big = await postConsent(ctx, { p: p.id, csrf, action: "allow", pad: "x".repeat(5000) }, cookies);
    expect(big.status).toBe(413);
    expect(await ctx.store.getPending(p.id)).not.toBeNull();
  });

  it("re-resolves the client at POST time", async () => {
    const ctx = await setup();
    const p = await ctx.addPending();
    const csrf = csrfFrom(await getConsent(ctx, p.id));
    vi.spyOn(ctx.clients, "resolve").mockResolvedValue(null);
    const res = await postConsent(ctx, { p: p.id, csrf, action: "allow" }, `${bindingCookie}; ${CSRF_COOKIE}=${csrf}`);
    expectErrorPage(res, 400);
    expect(await ctx.store.hasConsent(SUBJECT, ctx.clientA)).toBe(false);
  });

  it("a second allow for the same pending does not issue another code", async () => {
    const ctx = await setup();
    const p = await ctx.addPending();
    const page = await getConsent(ctx, p.id);
    const csrf = csrfFrom(page);
    const cookies = `${bindingCookie}; ${CSRF_COOKIE}=${csrf}`;
    const [a, b] = await Promise.all([
      postConsent(ctx, { p: p.id, csrf, action: "allow" }, cookies),
      postConsent(ctx, { p: p.id, csrf, action: "allow" }, cookies),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([303, 400]);
  });

  it("sends the consent headers on redirects", async () => {
    const ctx = await setup();
    const res = await consent(ctx, (await ctx.addPending()).id, "allow");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toBe(CSP);
  });
});
