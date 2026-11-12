import { exportJWK, generateKeyPair, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { GatewayConfig } from "../config.js";
import { createGateway } from "../gateway/index.js";
import { MemoryGatewayStore } from "../gateway/store.js";
import { GatewayTokenService } from "../gateway/tokens.js";
import type { UpstreamIdp } from "../gateway/upstream.js";
import { OWNER_SUBJECT } from "../identity/owner-identity.js";
import { loopbackRequest } from "../testing/loopback-request.js";
import { memoryOwnerSessions } from "../testing/owner-session-prisma.js";
import { sessionCookieFor } from "../testing/owner-session.js";
import { createPortfolioApi } from "./app.js";

// Synthetic identities and clients only.
const APP = "https://mcp.example.test";
const RESOURCE = "https://mcp.example.test/mcp";
const GW_ISSUER = "https://mcp.example.test";
// Every /api caller is the owner; a second subject exists only as store rows that must stay untouched.
const ME = OWNER_SUBJECT;
const OTHER = "synthetic-other-subject";
const CIMD = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const DCR = "dcr-client-synthetic-0001";
const OTHERS_DCR = "dcr-client-synthetic-0002";
const T0 = new Date("2026-10-23T12:00:00.250Z");
const DAY = 24 * 60 * 60 * 1000;

let signingKey: JWK;
beforeAll(async () => {
  const es = await generateKeyPair("ES256", { extractable: true });
  signingKey = { ...(await exportJWK(es.privateKey)), kid: "gw1" };
});

const upstream: UpstreamIdp = {
  authorizeUrl: () => "https://idp.example.test/authorize",
  exchange: async () => ({ subject: ME, emailVerified: true }),
};

const open: Array<{ close(): void }> = [];
afterEach(() => {
  for (const g of open.splice(0)) g.close();
  vi.restoreAllMocks();
});

async function build(o: { gateway?: boolean } = {}) {
  let now = T0;
  const clock = () => now;
  const store = new MemoryGatewayStore();
  const sessions = memoryOwnerSessions();
  const config: GatewayConfig = { issuer: GW_ISSUER, signingKey };
  const gateway = o.gateway === false ? undefined : createGateway({
    config, resource: RESOURCE, store, upstream,
    cimdFetch: (async () => { throw new Error("no network"); }) as unknown as typeof fetch,
    cimdLookup: async () => [{ address: "160.79.104.10", family: 4 }],
    now: clock, log: () => undefined,
  });
  if (gateway) open.push(gateway);
  const app = createPortfolioApi({
    sessions,
    portfolio: { getPortfolio: vi.fn(async () => ({ connectionRequired: false, generatedAt: T0.toISOString(), accounts: [], errors: [] })) },
    history: { getAccountHistory: vi.fn(async () => ({})) },
    connections: { getConnections: vi.fn(async () => []), createConnectionPortal: vi.fn(async () => "https://x.invalid") },
    webhooks: { ingest: vi.fn(async () => ({ duplicate: false })) },
    appBaseUrl: APP,
    mcpResourceUrl: RESOURCE,
    ...(gateway ? { gateway } : {}),
  } as never);
  const tokens = new GatewayTokenService({ issuer: GW_ISSUER, audience: RESOURCE, signingKey, now: clock });

  await store.createClient({
    clientId: DCR, clientSecretHash: null, redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    clientName: "<img src=x onerror=alert(1)>ChatGPT", tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"], createdAt: T0, lastUsedAt: T0,
  });
  await store.createClient({
    clientId: OTHERS_DCR, clientSecretHash: null, redirectUris: ["https://other.example.test/cb"],
    clientName: "Other person's app", tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code"], createdAt: T0, lastUsedAt: T0,
  });
  await store.putCimd(CIMD, {
    document: { client_id: CIMD, client_name: "Claude‮", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] },
    fetchedAt: T0, freshUntil: new Date(T0.getTime() + DAY), staleUntil: new Date(T0.getTime() + 2 * DAY),
  });
  await store.putConsent(ME, CIMD, "portfolio:read", new Date("2026-10-21T09:00:00.000Z"));
  await store.putConsent(ME, DCR, "portfolio:read", new Date("2026-10-22T09:00:00.000Z"));
  await store.putConsent(OTHER, OTHERS_DCR, "portfolio:read", new Date("2026-10-22T10:00:00.000Z"));
  await store.createRefresh({
    tokenHash: "a".repeat(64), familyId: "fam-cimd", clientKey: CIMD, subject: ME, scope: "portfolio:read", resource: RESOURCE,
    parentHash: null, expiresAt: new Date(T0.getTime() + DAY), familyExpiresAt: new Date(T0.getTime() + DAY), rotatedAt: null, revokedAt: null,
  });
  await store.createRefresh({
    tokenHash: "b".repeat(64), familyId: "fam-dcr", clientKey: DCR, subject: ME, scope: "portfolio:read", resource: RESOURCE,
    parentHash: null, expiresAt: new Date(T0.getTime() + DAY), familyExpiresAt: new Date(T0.getTime() + DAY), rotatedAt: null, revokedAt: null,
  });

  const req = await loopbackRequest(app);
  const access = async (clientKey: string, subject = ME) =>
    (await tokens.issueAccess({ subject, clientKey, scope: "portfolio:read" })).token;
  // GET /mcp answers 405 only after the bearer token is accepted.
  const mcpStatus = async (token: string) => (await req.get("/mcp").set("Authorization", `Bearer ${token}`)).status;
  const cookie = await sessionCookieFor(sessions);
  // Revoke is a write: the dashboard sends its own Origin.
  const owner = { Cookie: cookie, Origin: APP };
  return { req, store, access, mcpStatus, cookie, owner, setNow: (d: Date) => (now = d), now: clock };
}

const revokePath = (clientKey: string) => `/api/ai-apps/${encodeURIComponent(clientKey)}/revoke`;

describe("GET /api/ai-apps", () => {
  it("lists only the owner's apps, newest grant first, with untrusted names returned as plain data", async () => {
    const { req, owner } = await build();
    const res = await req.get("/api/ai-apps").set(owner).expect(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual([
      { clientKey: DCR, name: "<img src=x onerror=alert(1)>ChatGPT", host: "chatgpt.com", grantedAt: "2026-10-22T09:00:00.000Z" },
      { clientKey: CIMD, name: "Claude", host: "claude.ai", grantedAt: "2026-10-21T09:00:00.000Z" },
    ]);
    // The other subject's grant is in the store but never in the owner's list.
    expect(res.body.map((a: { clientKey: string }) => a.clientKey)).not.toContain(OTHERS_DCR);
  });

  it("returns null name and host for an app whose registration has aged out", async () => {
    const { req, store, owner } = await build();
    await store.putConsent(ME, "dcr-gone", "portfolio:read", new Date("2026-10-23T00:00:00.000Z"));
    const res = await req.get("/api/ai-apps").set(owner).expect(200);
    expect(res.body[0]).toEqual({ clientKey: "dcr-gone", name: null, host: null, grantedAt: "2026-10-23T00:00:00.000Z" });
  });
});

describe("dashboard-only auth on the AI-app routes", () => {
  it("requires the owner session and refuses gateway-issued AI tokens", async () => {
    const { req, access } = await build();
    await req.get("/api/ai-apps").expect(401);
    await req.post(revokePath(DCR)).expect(401);
    const aiToken = await access(DCR);
    const listed = await req.get("/api/ai-apps").set("Authorization", `Bearer ${aiToken}`).expect(401);
    expect(listed.body).toEqual({ error: "authentication_required" });
    await req.post(revokePath(DCR)).set("Authorization", `Bearer ${aiToken}`).expect(401);
  });

  it("is not mounted without the gateway", async () => {
    const { req, owner } = await build({ gateway: false });
    await req.get("/api/ai-apps").set(owner).expect(404);
    await req.post(revokePath(DCR)).set(owner).expect(404);
  });
});

describe("POST /api/ai-apps/:clientKey/revoke", () => {
  it("cuts the app's existing access token off at /mcp at once; other apps keep working", async () => {
    const { req, store, access, mcpStatus, owner } = await build();
    const claudeToken = await access(CIMD);
    const chatgptToken = await access(DCR);
    expect(await mcpStatus(claudeToken)).toBe(405);
    expect(await mcpStatus(chatgptToken)).toBe(405);

    await req.post(revokePath(CIMD)).set(owner).expect(204);

    expect(await mcpStatus(claudeToken)).toBe(401);
    expect(await mcpStatus(chatgptToken)).toBe(405);
    expect(await store.hasConsent(ME, CIMD)).toBe(false);
    expect(await store.hasConsent(ME, DCR)).toBe(true);
    expect(await store.rotateRefresh("a".repeat(64), T0)).toBeNull();
    expect(await store.isFamilyRevoked("fam-dcr")).toBe(false);
    const listed = await req.get("/api/ai-apps").set(owner).expect(200);
    expect(listed.body.map((a: { clientKey: string }) => a.clientKey)).toEqual([DCR]);
  });

  it("re-authorising after a revoke works, even within the same second", async () => {
    const { req, store, access, mcpStatus, setNow, owner } = await build();
    const old = await access(CIMD);
    await req.post(revokePath(CIMD)).set(owner).expect(204);
    setNow(new Date(T0.getTime() + 1)); // same iat second as the revoke
    await store.putConsent(ME, CIMD, "portfolio:read", new Date(T0.getTime() + 1));
    const fresh = await access(CIMD);
    expect(await mcpStatus(fresh)).toBe(405);
    expect(await mcpStatus(old)).toBe(401);
    setNow(new Date(T0.getTime() + 30 * 60 * 1000));
    expect(await mcpStatus(fresh)).toBe(405);
    expect(await mcpStatus(old)).toBe(401);
  });

  it("answers 404 for an unknown app and for another subject's app, without touching it", async () => {
    const { req, store, access, mcpStatus, owner } = await build();
    const othersToken = await access(OTHERS_DCR, OTHER);
    const unknown = await req.post(revokePath("dcr-never-registered")).set(owner).expect(404);
    const foreign = await req.post(revokePath(OTHERS_DCR)).set(owner).expect(404);
    expect(unknown.body).toEqual({ error: "not_found" });
    expect(foreign.body).toEqual(unknown.body);
    await req.post(revokePath("x".repeat(2049))).set(owner).expect(404);
    expect(await mcpStatus(othersToken)).toBe(405);
    expect(await store.hasConsent(OTHER, OTHERS_DCR)).toBe(true);
    expect(await store.accessRevokedAt(OTHER, OTHERS_DCR)).toBeNull();
    expect(await store.accessRevokedAt(ME, OTHERS_DCR)).toBeNull();
    // Revoking twice: the second call finds nothing of the caller's left.
    await req.post(revokePath(DCR)).set(owner).expect(204);
    await req.post(revokePath(DCR)).set(owner).expect(404);
  });

  it("logs counts and constant codes only, never subjects, client keys or names", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    }
    const { req, owner } = await build();
    await req.get("/api/ai-apps").set(owner).expect(200);
    await req.post(revokePath(CIMD)).set(owner).expect(204);
    await req.post(revokePath(OTHERS_DCR)).set(owner).expect(404);
    const all = lines.join("\n");
    expect(all).toContain("ai_app_revoke");
    for (const secret of [ME, OTHER, CIMD, DCR, OTHERS_DCR, "Claude", "ChatGPT", "claude.ai"]) expect(all).not.toContain(secret);
  });
});

describe("subject-wide revocation (for account deletion)", () => {
  it("cuts off every app's existing access token at /mcp at once", async () => {
    const { store, access, mcpStatus, setNow } = await build();
    const a = await access(CIMD);
    const b = await access(DCR);
    const stranger = await access(OTHERS_DCR, OTHER);
    await store.revokeAllForSubject(ME, () => T0);
    expect(await mcpStatus(a)).toBe(401);
    expect(await mcpStatus(b)).toBe(401);
    expect(await mcpStatus(stranger)).toBe(405);
    setNow(new Date(T0.getTime() + 1));
    expect(await mcpStatus(await access(DCR))).toBe(405);
  });
});
