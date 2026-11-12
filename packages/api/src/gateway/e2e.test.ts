/**
 * End-to-end sign-in through the MCP gateway, driven by the official MCP SDK
 * client: `auth()` with an OAuthClientProvider, then StreamableHTTPClientTransport
 * against `/mcp`.
 *
 * The real Express app (createPortfolioApi + createGateway, MemoryGatewayStore)
 * listens on 127.0.0.1, with the owner routers mounted ahead of the gateway the
 * way the runtime mounts them: the login page (real scrypt hash, real
 * OwnerSessionStore over an in-memory table) and the local upstream. The
 * configured origin stays https (`https://mcp.example.test`, as production
 * config requires); a test-only fetch rewrites that origin to the loopback
 * listener, so no production config is loosened. The browser legs
 * (/authorize → /oauth/local/authorize → /login → consent) are driven by hand
 * with a cookie jar that forwards Set-Cookie values (the Secure cookies are
 * never sent over plain http by a real jar; there is no real browser here).
 *
 * Synthetic data only; nothing leaves the loopback interface.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loginRouter } from "../auth/login-routes.js";
import { hashOwnerPassword } from "../auth/owner-password.js";
import type { GatewayConfig } from "../config.js";
import { createPortfolioApi } from "../http/app.js";
import { OWNER_SUBJECT } from "../identity/owner-identity.js";
import { SlidingWindowLimiter } from "../security/sliding-window.js";
import { memoryOwnerSessions } from "../testing/owner-session-prisma.js";
import { sessionCookieFor } from "../testing/owner-session.js";
import { CONSENT_ACCESS_COPY, CONSENT_MEMORY_COPY } from "./consent-routes.js";
import { createGateway, type Gateway } from "./index.js";
import { localOwnerUpstream } from "./local-upstream.js";
import { MemoryGatewayStore } from "./store.js";

const ORIGIN = "https://mcp.example.test";
const RESOURCE = `${ORIGIN}/mcp`;
const FOREIGN_ISSUER = "https://tenant.example.test/";
const PASSWORD = "synthetic-owner-password";
const CIMD_URL = "https://client.example.test/oauth/client-metadata.json";
const CIMD_REDIRECT = "https://client.example.test/oauth/callback";
const DCR_REDIRECT = "http://127.0.0.1:53123/callback";

let gatewayKey: JWK;
let foreignKey: Awaited<ReturnType<typeof generateKeyPair>>;
let sessions: ReturnType<typeof memoryOwnerSessions>;
let server: Server;
let gateway: Gateway;
let base: string;
const getPortfolio = vi.fn(async (_subject: string) => ({
  connectionRequired: false,
  generatedAt: "2026-10-20T12:00:00.000Z",
  accounts: [],
  errors: [],
}));

/** CIMD document host, served through the resolver's injected fetch. */
let cimdFetches = 0;
async function cimdFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url !== CIMD_URL) return new Response("not found", { status: 404 });
  cimdFetches += 1;
  return new Response(
    JSON.stringify({
      client_id: CIMD_URL,
      client_name: "E2E Metadata Client",
      redirect_uris: [CIMD_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    { status: 200, headers: { "content-type": "application/json", "cache-control": "max-age=600" } },
  );
}

/** Test-only: routes the https origin to the loopback listener. */
const toLoopback = (input: string | URL): string => {
  const u = new URL(String(input));
  if (u.origin !== ORIGIN) throw new Error(`unexpected fetch to ${u.origin}`);
  return `${base}${u.pathname}${u.search}`;
};
const loopbackFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (input instanceof Request) return fetch(new Request(toLoopback(input.url), input), init);
  return fetch(toLoopback(input), init);
}) as typeof fetch;

beforeAll(async () => {
  const es = await generateKeyPair("ES256", { extractable: true });
  gatewayKey = { ...(await exportJWK(es.privateKey)), kid: "gw-e2e" };
  // A key some other issuer holds: nothing here trusts it.
  foreignKey = await generateKeyPair("RS256");

  const config: GatewayConfig = { issuer: ORIGIN, signingKey: gatewayKey };
  sessions = memoryOwnerSessions();
  const local = localOwnerUpstream({ sessions, issuer: ORIGIN });
  gateway = createGateway({
    config,
    resource: RESOURCE,
    store: new MemoryGatewayStore(),
    upstream: local.upstream,
    cimdFetch: cimdFetch as typeof fetch,
    cimdLookup: async () => [{ address: "160.79.104.10", family: 4 }],
    log: () => undefined,
  });
  const app = createPortfolioApi({
    portfolio: { getPortfolio },
    history: { getAccountHistory: vi.fn(async () => ({})) },
    connections: { getConnections: vi.fn(async () => []), createConnectionPortal: vi.fn(async () => "https://x.invalid") },
    webhooks: { ingest: vi.fn(async () => ({ duplicate: false })) },
    sessions,
    appBaseUrl: ORIGIN,
    mcpResourceUrl: RESOURCE,
    gateway,
    ownerRouters: [
      loginRouter({
        sessions,
        passwordHash: await hashOwnerPassword(PASSWORD),
        limiter: new SlidingWindowLimiter([{ ms: 15 * 60_000, max: 100 }]),
        secureCookies: true,
        expectedOrigin: ORIGIN,
      }),
      local.router,
    ],
  });
  server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  gateway?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

/** An in-memory OAuthClientProvider, like a host's. */
class HostProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  private info: OAuthClientInformationMixed | undefined;
  private saved: OAuthTokens | undefined;
  private verifier = "";
  constructor(readonly redirectUrl: string, readonly clientMetadataUrl?: string) {}
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "E2E Registered Client",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state() { return "host-state-123"; }
  clientInformation() { return this.info; }
  saveClientInformation(i: OAuthClientInformationMixed) { this.info = i; }
  tokens() { return this.saved; }
  saveTokens(t: OAuthTokens) { this.saved = t; }
  forgetTokens() { this.saved = undefined; }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
}

/** A minimal browser: one cookie jar, manual redirects. */
class Browser {
  private readonly jar = new Map<string, string>();
  private absorb(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (/;\s*Max-Age=0/i.test(line) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  private headers(extra: Record<string, string> = {}) {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    return { ...(cookie ? { cookie } : {}), ...extra };
  }
  async get(url: string): Promise<Response> {
    const res = await loopbackFetch(new URL(url, ORIGIN).href, { redirect: "manual", headers: this.headers() });
    this.absorb(res);
    return res;
  }
  /** `origin` overrides the Origin header (default: the public origin, as the consent form's own check expects). */
  async postForm(url: string, form: Record<string, string> | Array<[string, string]>, o: { origin?: string } = {}): Promise<Response> {
    const res = await loopbackFetch(new URL(url, ORIGIN).href, {
      method: "POST",
      redirect: "manual",
      headers: this.headers({ "content-type": "application/x-www-form-urlencoded", origin: o.origin ?? ORIGIN }),
      body: new URLSearchParams(form).toString(),
    });
    this.absorb(res);
    return res;
  }
}

function hidden(html: string, name: string): string {
  const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`)) ?? html.match(new RegExp(`value="([^"]*)"[^>]*name="${name}"`));
  if (!m) throw new Error(`no hidden field ${name}`);
  return m[1]!.replace(/&amp;/g, "&");
}

/**
 * The user's browser walks /authorize → /oauth/local/authorize → /login (signed
 * out) → back to /oauth/local/authorize → callback → consent and lands on the
 * host redirect. Consent is always shown (one click, Ruling R3).
 * Returns the code and whether the page noted an earlier approval.
 */
async function signInInBrowser(browser: Browser, authorizationUrl: URL, redirectUri: string) {
  const authorize = await browser.get(authorizationUrl.href);
  expect(authorize.status).toBe(302);
  const toLocal = authorize.headers.get("location")!;
  expect(toLocal.startsWith("/oauth/local/authorize?")).toBe(true);
  const localParams = new URL(toLocal, ORIGIN).searchParams;
  expect(localParams.get("redirect_uri")).toBe(`${ORIGIN}/oauth/upstream/callback`);

  // Signed out: the local upstream sends the browser to the login page, which returns it here.
  const signedOut = await browser.get(toLocal);
  expect(signedOut.status).toBe(302);
  const toLogin = signedOut.headers.get("location")!;
  expect(toLogin.startsWith("/login?continue=")).toBe(true);
  const loginPage = await browser.get(toLogin);
  expect(loginPage.status).toBe(200);
  const loginHtml = await loginPage.text();
  const wrong = await browser.postForm("/login", { password: "not-the-password", continue: hidden(loginHtml, "continue") }, { origin: ORIGIN });
  expect(wrong.status).toBe(401);
  const login = await browser.postForm("/login", { password: PASSWORD, continue: hidden(loginHtml, "continue") }, { origin: ORIGIN });
  expect(login.status).toBe(303);
  expect(login.headers.get("location")).toBe(toLocal);
  expect(login.headers.getSetCookie().join("\n")).toMatch(/^vl_session=/);

  // Signed in: a one-time code goes straight back to the gateway's callback.
  const callback = await browser.get(login.headers.get("location")!);
  expect(callback.status).toBe(302);
  const callbackUrl = new URL(callback.headers.get("location")!);
  expect(`${callbackUrl.origin}${callbackUrl.pathname}`).toBe(`${ORIGIN}/oauth/upstream/callback`);
  const finish = await browser.get(callbackUrl.href);
  expect(finish.status).toBe(302);
  const consentUrl = finish.headers.get("location")!;
  expect(consentUrl).toMatch(/^\/oauth\/consent\?p=/);

  const consent = await browser.get(consentUrl);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  expect(html).toContain(CONSENT_ACCESS_COPY);
  expect(html).toContain(CONSENT_MEMORY_COPY);
  expect(consent.headers.get("x-frame-options")).toBe("DENY");
  expect(consent.headers.get("cache-control")).toBe("no-store");
  const approvedBefore = html.includes("You approved this app before.");
  expect(html).not.toContain('type="checkbox"');
  const landing = await browser.postForm("/oauth/consent", [
    ["p", hidden(html, "p")],
    ["csrf", hidden(html, "csrf")],
    ["action", "allow"],
  ]);
  expect(landing.status).toBe(303);
  const back = new URL(landing.headers.get("location")!);
  expect(`${back.origin}${back.pathname}`).toBe(redirectUri);
  expect(back.searchParams.get("state")).toBe("host-state-123");
  expect(back.searchParams.get("iss")).toBe(ORIGIN);
  expect(back.searchParams.get("error")).toBeNull();
  return { code: back.searchParams.get("code")!, approvedBefore };
}

async function listTools(provider: HostProvider) {
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), { authProvider: provider, fetch: loopbackFetch });
  const client = new Client({ name: "e2e-host", version: "1.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const snapshot = await client.callTool({ name: "get_portfolio_snapshot", arguments: {} });
    expect(snapshot.isError ?? false).toBe(false);
    return tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

const EXPECTED_TOOLS = [
  "get_account_history",
  "get_account_positions",
  "get_portfolio_snapshot",
  "list_portfolio_accounts",
  "show_portfolio",
];

async function fullFlow(provider: HostProvider, redirectUri: string) {
  const browser = new Browser();
  expect(await auth(provider, { serverUrl: RESOURCE, fetchFn: loopbackFetch })).toBe("REDIRECT");
  const authorizationUrl = provider.authorizationUrl!;
  expect(authorizationUrl.origin).toBe(ORIGIN);
  expect(authorizationUrl.pathname).toBe("/authorize");
  expect(authorizationUrl.searchParams.get("resource")).toBe(RESOURCE);
  expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");

  const first = await signInInBrowser(browser, authorizationUrl, redirectUri);
  expect(first.approvedBefore).toBe(false);
  expect(await auth(provider, { serverUrl: RESOURCE, authorizationCode: first.code, fetchFn: loopbackFetch })).toBe("AUTHORIZED");
  const tokens = provider.tokens()!;
  expect(tokens.token_type.toLowerCase()).toBe("bearer");
  expect(tokens.scope).toBe("portfolio:read memory");
  expect(typeof tokens.refresh_token).toBe("string");

  getPortfolio.mockClear();
  expect(await listTools(provider)).toEqual(EXPECTED_TOOLS);
  expect(getPortfolio).toHaveBeenCalledWith(OWNER_SUBJECT);

  // A gateway token never authenticates REST.
  const rest = await loopbackFetch(`${ORIGIN}/api/portfolio`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  expect(rest.status).toBe(401);

  // Refresh (rotation), then /mcp again with the new access token.
  expect(await auth(provider, { serverUrl: RESOURCE, fetchFn: loopbackFetch })).toBe("AUTHORIZED");
  const refreshed = provider.tokens()!;
  expect(refreshed.access_token).not.toBe(tokens.access_token);
  expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
  expect(refreshed.scope).toBe("portfolio:read memory");
  expect(await listTools(provider)).toEqual(EXPECTED_TOOLS);

  // Second authorization for the same client: the consent page is shown again
  // (noting the earlier approval) and one POST approves it.
  provider.forgetTokens();
  expect(await auth(provider, { serverUrl: RESOURCE, fetchFn: loopbackFetch })).toBe("REDIRECT");
  const second = await signInInBrowser(new Browser(), provider.authorizationUrl!, redirectUri);
  expect(second.approvedBefore).toBe(true);
  expect(await auth(provider, { serverUrl: RESOURCE, authorizationCode: second.code, fetchFn: loopbackFetch })).toBe("AUTHORIZED");
  expect(await listTools(provider)).toEqual(EXPECTED_TOOLS);
  return provider;
}

describe("MCP gateway end to end with the MCP SDK client", () => {
  it("completes DCR → authorize → login → consent → token → /mcp tools/list", async () => {
    const provider = new HostProvider(DCR_REDIRECT);
    await fullFlow(provider, DCR_REDIRECT);
    const info = provider.clientInformation()!;
    expect(info.client_id).not.toBe(CIMD_URL);
    expect(info.client_id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("a CIMD client (URL client_id, document served by the injected fetch) signs in, calls /mcp and refreshes", async () => {
    cimdFetches = 0;
    const provider = new HostProvider(CIMD_REDIRECT, CIMD_URL);
    await fullFlow(provider, CIMD_REDIRECT);
    expect(provider.clientInformation()!.client_id).toBe(CIMD_URL);
    expect(cimdFetches).toBeGreaterThanOrEqual(1);
  });

  it("consent for one client does not carry over to another client", async () => {
    // The DCR and CIMD clients above share a subject; their approvals are not noted for a new client.
    const provider = new HostProvider("http://localhost:61000/cb");
    expect(await auth(provider, { serverUrl: RESOURCE, fetchFn: loopbackFetch })).toBe("REDIRECT");
    const result = await signInInBrowser(new Browser(), provider.authorizationUrl!, "http://localhost:61000/cb");
    expect(result.approvedBefore).toBe(false);
  });

  it("rejects a token from another issuer on /mcp, and /api takes only the session cookie", async () => {
    const foreignToken = await new SignJWT({ scope: "portfolio:read" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(FOREIGN_ISSUER)
      .setAudience(RESOURCE)
      .setSubject("someone-else")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(foreignKey.privateKey);
    const headers = { authorization: `Bearer ${foreignToken}` };

    // REST ignores a bearer token; the owner's session cookie is what it accepts.
    expect((await loopbackFetch(`${ORIGIN}/api/portfolio`, { headers })).status).toBe(401);
    const session = await loopbackFetch(`${ORIGIN}/api/portfolio`, { headers: { cookie: await sessionCookieFor(sessions) } });
    expect(session.status).toBe(200);

    const mcp = await loopbackFetch(RESOURCE, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
    );
  });
});
