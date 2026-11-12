import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportJWK, generateKeyPair, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { GatewayConfig } from "../config.js";
import { createGateway } from "../gateway/index.js";
import { MemoryGatewayStore } from "../gateway/store.js";
import { GatewayTokenService } from "../gateway/tokens.js";
import type { UpstreamIdp } from "../gateway/upstream.js";
import { handlePortfolioMcpRequest } from "../mcp/portfolio-mcp-server.js";
import { OWNER_SUBJECT } from "../identity/owner-identity.js";
import { loopbackRequest } from "../testing/loopback-request.js";
import { memoryOwnerSessions } from "../testing/owner-session-prisma.js";
import { sessionCookieFor } from "../testing/owner-session.js";
import { createPortfolioApi } from "./app.js";

// A transparent wrapper, so a test can read the options /mcp hands the MCP server.
vi.mock("../mcp/portfolio-mcp-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/portfolio-mcp-server.js")>();
  return { ...actual, handlePortfolioMcpRequest: vi.fn(actual.handlePortfolioMcpRequest) };
});

const APP = "https://mcp.example.test";
const RESOURCE = "https://mcp.example.test/mcp";
const GW_ISSUER = "https://mcp.example.test";
const MCP_PRM = "https://mcp.example.test/.well-known/oauth-protected-resource/mcp";

let signingKey: JWK;
beforeAll(async () => {
  const es = await generateKeyPair("ES256", { extractable: true });
  signingKey = { ...(await exportJWK(es.privateKey)), kid: "gw1" };
});

const upstream: UpstreamIdp = {
  authorizeUrl: () => "https://idp.example.test/authorize",
  exchange: async () => ({ subject: "owner", emailVerified: true }),
};

function services() {
  return {
    portfolio: {
      getPortfolio: vi.fn(async () => ({ connectionRequired: false, generatedAt: "2026-10-20T12:00:00.000Z", accounts: [], errors: [] })),
    },
    history: { getAccountHistory: vi.fn(async () => ({})) },
    connections: { getConnections: vi.fn(async () => []), createConnectionPortal: vi.fn(async () => "https://x.invalid") },
    webhooks: { ingest: vi.fn(async () => ({ duplicate: false })) },
  };
}

const open: Array<{ close(): void }> = [];
afterEach(() => {
  for (const g of open.splice(0)) g.close();
});

function build(o: { at?: Date; staticAssetsDirectory?: string; trustProxy?: number } = {}) {
  let now = o.at ?? new Date("2026-10-20T12:00:00Z");
  const clock = () => now;
  const sessions = memoryOwnerSessions();
  const gatewayConfig: GatewayConfig = { issuer: GW_ISSUER, signingKey };
  const gateway = createGateway({
    config: gatewayConfig,
    resource: RESOURCE,
    store: new MemoryGatewayStore(),
    upstream,
    cimdFetch: (async () => { throw new Error("no network"); }) as unknown as typeof fetch,
    cimdLookup: async () => [{ address: "160.79.104.10", family: 4 }],
    now: clock,
    log: () => undefined,
  });
  open.push(gateway);
  const app = createPortfolioApi({
    ...services(),
    sessions,
    appBaseUrl: APP,
    mcpResourceUrl: RESOURCE,
    ...(o.staticAssetsDirectory ? { staticAssetsDirectory: o.staticAssetsDirectory } : {}),
    gateway,
    ...(o.trustProxy !== undefined ? { trustProxy: o.trustProxy } : {}),
  });
  const tokens = new GatewayTokenService({ issuer: GW_ISSUER, audience: RESOURCE, signingKey, now: clock });
  return { app, tokens, sessions, setNow: (d: Date) => (now = d) };
}

async function gatewayToken(tokens: GatewayTokenService) {
  return (await tokens.issueAccess({ subject: OWNER_SUBJECT, clientKey: "client-1", scope: "portfolio:read" })).token;
}

describe("gateway: route separation (Review Focus 4)", () => {
  it("accepts a gateway token on /mcp and ignores it on /api/portfolio", async () => {
    const { app, tokens } = build();
    const req = await loopbackRequest(app);
    const token = await gatewayToken(tokens);
    // GET /mcp reaches the handler (405) only after authentication succeeds.
    await req.get("/mcp").set("Authorization", `Bearer ${token}`).expect(405);
    const rest = await req.get("/api/portfolio").set("Authorization", `Bearer ${token}`).expect(401);
    expect(rest.body).toEqual({ error: "authentication_required" });
  });

  it("rejects a foreign bearer token on /mcp, pointing at gateway metadata, while REST takes the session cookie", async () => {
    const { app, sessions } = build();
    const req = await loopbackRequest(app);
    const res = await req.get("/mcp").set("Authorization", "Bearer not.a.gateway-token").expect(401);
    expect(res.body).toEqual({ error: "invalid_token" });
    expect(res.headers["www-authenticate"]).toBe(`Bearer resource_metadata="${MCP_PRM}", error="invalid_token"`);
    const prm = await req.get("/.well-known/oauth-protected-resource/mcp").expect(200);
    expect(prm.body.authorization_servers).toEqual([GW_ISSUER]);

    await req.get("/api/portfolio").set("Cookie", await sessionCookieFor(sessions)).expect(200);
  });

  it("keeps the /mcp challenge naming the /mcp metadata when no token is sent", async () => {
    const { app } = build();
    const res = await (await loopbackRequest(app)).post("/mcp").send({}).expect(401);
    expect(res.headers["www-authenticate"]).toContain(`resource_metadata="${MCP_PRM}"`);
  });

  it("lists the gateway issuer for /mcp, names the same issuer in the root metadata, and serves both with public CORS", async () => {
    const { app } = build();
    const req = await loopbackRequest(app);
    const mcp = await req.get("/.well-known/oauth-protected-resource/mcp").expect(200);
    expect(mcp.body).toEqual({
      resource: RESOURCE,
      authorization_servers: [GW_ISSUER],
      // The gateway grants memory alongside portfolio:read (Task 2); /mcp advertises both.
      scopes_supported: ["portfolio:read", "memory"],
      bearer_methods_supported: ["header"],
    });
    expect(mcp.headers["access-control-allow-origin"]).toBe("*");
    const root = await req.get("/.well-known/oauth-protected-resource").expect(200);
    expect(root.body.authorization_servers).toEqual([GW_ISSUER]);
    // The root document mirrors the /mcp one: the same resource and scopes (this instance has one resource, /mcp).
    expect(root.body).toEqual(mcp.body);
    expect(root.headers["access-control-allow-origin"]).toBe("*");
    const as = await req.get("/.well-known/oauth-authorization-server").expect(200);
    expect(as.body.issuer).toBe(GW_ISSUER);
    expect(as.headers["access-control-allow-origin"]).toBe("*");
    const token = await req.post("/token").set("Origin", "https://evil.example.test").type("form").send({ grant_type: "password" });
    expect(token.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("keeps gateway paths out of the SPA fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "portfolio-web-"));
    await writeFile(join(directory, "index.html"), "<!doctype html><main>SPA</main>");
    const { app } = build({ staticAssetsDirectory: directory });
    const req = await loopbackRequest(app);
    for (const path of ["/oauth/unknown", "/authorize/extra", "/token", "/register", "/revoke"]) {
      const res = await req.get(path).set("Accept", "text/html");
      expect(res.status, path).toBe(404);
      expect(res.text).not.toContain("SPA");
    }
    // Other paths still reach the SPA.
    expect((await req.get("/dashboard").set("Accept", "text/html").expect(200)).text).toContain("SPA");
  });
});

describe("gateway: the memory scope", () => {
  async function callSnapshot(req: Awaited<ReturnType<typeof loopbackRequest>>, token: string) {
    return req.post("/mcp").set("Authorization", `Bearer ${token}`).set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_portfolio_snapshot", arguments: {} } });
  }
  const lastScopes = () => vi.mocked(handlePortfolioMcpRequest).mock.calls.at(-1)?.[2].scopes;

  it.each([
    ["portfolio:read", ["portfolio:read"]],
    ["portfolio:read memory", ["portfolio:read", "memory"]],
  ])("read tools work with a gateway token scoped %j, and the granted scopes reach the MCP server", async (scope, expected) => {
    const { app, tokens } = build();
    const req = await loopbackRequest(app);
    const token = (await tokens.issueAccess({ subject: OWNER_SUBJECT, clientKey: "client-1", scope })).token;
    const res = await callSnapshot(req, token);
    expect(res.status).toBe(200);
    expect(res.body.result.isError ?? false).toBe(false);
    expect(lastScopes()).toEqual(expected);
  });

  it("the dashboard's session path needs no memory scope and gateway metadata only advertises it for /authorize", async () => {
    const { app, sessions } = build();
    const req = await loopbackRequest(app);
    await req.get("/api/portfolio").set("Cookie", await sessionCookieFor(sessions)).expect(200);
    const asMeta = await req.get("/.well-known/oauth-authorization-server").expect(200);
    expect(asMeta.body.scopes_supported).toEqual(["portfolio:read", "memory"]);
    const root = await req.get("/.well-known/oauth-protected-resource").expect(200);
    expect(root.body.scopes_supported).toEqual(["portfolio:read", "memory"]);
  });
});

describe("gateway: client IPs behind one proxy hop (TRUST_PROXY=1)", () => {
  it("keys /authorize rate limits by the proxy-reported client IP, ignoring spoofed leading entries", async () => {
    const { app } = build({ trustProxy: 1 });
    const req = await loopbackRequest(app);
    for (let i = 0; i < 20; i += 1) {
      await req.get("/authorize").set("X-Forwarded-For", "203.0.113.10").expect(400);
    }
    await req.get("/authorize").set("X-Forwarded-For", "203.0.113.10").expect(429);
    await req.get("/authorize").set("X-Forwarded-For", "198.51.100.77, 203.0.113.10").expect(429);
    await req.get("/authorize").set("X-Forwarded-For", "203.0.113.11").expect(400);
  });

  it("keys /register rate limits by the proxy-reported client IP, ignoring spoofed leading entries", async () => {
    const { app } = build({ trustProxy: 1 });
    const req = await loopbackRequest(app);
    const body = { redirect_uris: ["https://host.example.test/cb"], client_name: "Host" };
    for (let i = 0; i < 20; i += 1) {
      await req.post("/register").set("X-Forwarded-For", "203.0.113.20").send(body).expect(201);
    }
    await req.post("/register").set("X-Forwarded-For", "203.0.113.20").send(body).expect(429);
    await req.post("/register").set("X-Forwarded-For", "198.51.100.77, 203.0.113.20").send(body).expect(429);
    await req.post("/register").set("X-Forwarded-For", "203.0.113.21").send(body).expect(201);
  });
});

describe("gateway: TRUST_PROXY unset trusts nothing", () => {
  it("ignores X-Forwarded-For, so rotating it cannot escape a per-IP limit", async () => {
    const { app } = build();
    expect(app.get("trust proxy")).toBeFalsy();
    const req = await loopbackRequest(app);
    for (let i = 0; i < 20; i += 1) {
      await req.get("/authorize").set("X-Forwarded-For", `203.0.113.${i + 1}`).expect(400);
    }
    // Every spoofed address shared the one real peer address, so the budget is spent.
    await req.get("/authorize").set("X-Forwarded-For", "203.0.113.200").expect(429);
  });
});
