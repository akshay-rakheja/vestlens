import http from "node:http";
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

// Synthetic identities only.
const APP = "https://mcp.example.test";
const RESOURCE = "https://mcp.example.test/mcp";
const ME = OWNER_SUBJECT;
const T0 = new Date("2026-10-24T02:30:00.000Z"); // 22:30 on 23 Oct in Toronto, already 24 Oct UTC

let signingKey: JWK;
beforeAll(async () => {
  const es = await generateKeyPair("ES256", { extractable: true });
  signingKey = { ...(await exportJWK(es.privateKey)), kid: "gw1" };
});

const upstream: UpstreamIdp = { authorizeUrl: () => "https://idp.example.test/authorize", exchange: async () => ({ subject: ME, emailVerified: true }) };
const open: Array<{ close(): void }> = [];
afterEach(() => { for (const g of open.splice(0)) g.close(); vi.restoreAllMocks(); });

type Stream = (subject: string, write: (chunk: string) => Promise<void>) => Promise<Record<string, number>>;

async function build(stream: Stream) {
  const sessions = memoryOwnerSessions();
  const config: GatewayConfig = { issuer: APP, signingKey };
  const gateway = createGateway({
    config, resource: RESOURCE, store: new MemoryGatewayStore(), upstream,
    cimdFetch: (async () => { throw new Error("no network"); }) as unknown as typeof fetch,
    cimdLookup: async () => [{ address: "160.79.104.10", family: 4 }],
    now: () => T0, log: () => undefined,
  });
  open.push(gateway);
  const exporter = { stream: vi.fn(stream) };
  const base = {
    sessions,
    portfolio: { getPortfolio: vi.fn(async () => ({ connectionRequired: false, generatedAt: T0.toISOString(), accounts: [], errors: [] })) },
    history: { getAccountHistory: vi.fn(async () => ({})) },
    connections: { getConnections: vi.fn(async () => []), createConnectionPortal: vi.fn(async () => "https://x.invalid") },
    webhooks: { ingest: vi.fn(async () => ({ duplicate: false })) },
    appBaseUrl: APP, mcpResourceUrl: RESOURCE, now: () => T0,
  };
  const make = () => createPortfolioApi({
    ...base, accountExport: exporter, gateway,
  } as never);
  const app = make();
  const tokens = new GatewayTokenService({ issuer: APP, audience: RESOURCE, signingKey, now: () => T0 });
  return { req: await loopbackRequest(app), exporter, tokens, cookie: await sessionCookieFor(sessions) };
}

const okStream: Stream = async (subject, write) => {
  await write('{"exportedAt":"x","format":"vestlens-export-v1"');
  await write(`,"for":${JSON.stringify(subject)}}`);
  return { activities: 0 };
};

describe("GET /api/account/export", () => {
  it("streams the caller's export as a no-store JSON attachment named for the Toronto date", async () => {
    const { req, exporter, cookie } = await build(okStream);
    const res = await req.get("/api/account/export").set("Cookie", cookie).expect(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="vestlens-export-2026-10-23.json"');
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(res.text)).toEqual({ exportedAt: "x", format: "vestlens-export-v1", for: ME });
    expect(exporter.stream).toHaveBeenCalledTimes(1);
    expect(exporter.stream.mock.calls[0]![0]).toBe(ME);
  });

  it("requires the owner session and refuses gateway-issued AI tokens", async () => {
    const { req, tokens, exporter } = await build(okStream);
    await req.get("/api/account/export").expect(401);
    const ai = (await tokens.issueAccess({ subject: ME, clientKey: "dcr-client-synthetic-0001", scope: "portfolio:read" })).token;
    const res = await req.get("/api/account/export").set("Authorization", `Bearer ${ai}`).expect(401);
    expect(res.body).toEqual({ error: "authentication_required" });
    expect(exporter.stream).not.toHaveBeenCalled();
  });

  it("aborts the connection on a mid-stream failure so the download is truncated, never valid-looking JSON", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { req, cookie } = await build(async (_s, write) => {
      await write('{"exportedAt":"x","activities":[{"a":1}');
      throw new Error("synthetic secret-bearing failure");
    });
    const pending = req.get("/api/account/export").set("Cookie", cookie).buffer(true);
    await expect(Promise.resolve(pending)).rejects.toThrow();
    const logged = [...warn.mock.calls, ...log.mock.calls].flat().join(" ");
    expect(logged).toContain("account_export_failed");
    expect(logged).not.toContain("secret-bearing");
    expect(logged).not.toContain(ME);
  });

  it("settles and logs once when the client disconnects between writes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    let settled!: () => void;
    const done = new Promise<void>((r) => { settled = r; });
    let outcome = "";
    const { req, cookie } = await build(async (_s, write) => {
      await write('{"a":1');
      await new Promise((r) => setTimeout(r, 300)); // the client hangs up during this gap
      try { await write(',"b":2'); outcome = "wrote"; } catch { outcome = "rejected"; throw new Error("x"); } finally { settled(); }
      return {};
    });
    const url = new URL(req.get("/x").url);
    await new Promise<void>((resolve) => {
      const clientReq = http.get({ host: url.hostname, port: url.port, path: "/api/account/export", headers: { Cookie: cookie }, agent: false }, (res) => {
        res.once("data", () => { clientReq.destroy(); res.destroy(); resolve(); });
      });
      clientReq.on("error", () => undefined);
    });
    await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("write() hung")), 3000))]);
    expect(outcome).toBe("rejected");
    await new Promise((r) => setTimeout(r, 50));
    expect(warn.mock.calls.flat().filter((l) => String(l).includes("account_export_failed"))).toHaveLength(1);
  });

  it("answers a normal error, without the attachment header, when it fails before any byte is written", async () => {
    const { req, cookie } = await build(async () => { throw new Error("synthetic"); });
    const res = await req.get("/api/account/export").set("Cookie", cookie).expect(500);
    expect(res.body).toEqual({ error: "internal_error" });
    expect(res.headers["content-disposition"]).toBeUndefined();
  });

});
