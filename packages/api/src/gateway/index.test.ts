import express from "express";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { GatewayConfig } from "../config.js";
import { loopbackRequest } from "../testing/loopback-request.js";
import {
  createGateway,
  SWEEP_MAX_INTERVAL_MS,
  CLIENT_IDLE_RETENTION_MS,
  CLIENT_NEVER_USED_RETENTION_MS,
  REVOKED_FAMILY_MARKER_RETENTION_MS,
  CLIENT_REVOCATION_RETENTION_MS,
} from "./index.js";
import { CODE_REUSE_REVOKE_GRACE_MS } from "./token-routes.js";
import { MemoryGatewayStore } from "./store.js";
import type { UpstreamIdp } from "./upstream.js";

const ISSUER = "https://gw.example.test";
const RESOURCE = "https://gw.example.test/mcp";

let signingKey: JWK;
beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signingKey = { ...(await exportJWK(pair.privateKey)), kid: "k1" };
});

const upstream: UpstreamIdp = {
  authorizeUrl: () => "https://idp.example.test/authorize",
  exchange: async () => ({ subject: "subject|abc", emailVerified: true }),
};

function config(): GatewayConfig {
  return { issuer: ISSUER, signingKey };
}

const noNetwork = vi.fn(async () => {
  throw new Error("no network in tests");
}) as unknown as typeof fetch;

const open: Array<{ close(): void }> = [];
afterEach(() => {
  for (const g of open.splice(0)) g.close();
  vi.useRealTimers();
});

function build(o: { store?: MemoryGatewayStore; now?: () => Date; sweepIntervalMs?: number; sweepLog?: (e: Record<string, unknown>) => void } = {}) {
  const gateway = createGateway({
    config: config(),
    resource: RESOURCE,
    store: o.store ?? new MemoryGatewayStore(),
    upstream,
    cimdFetch: noNetwork,
    cimdLookup: async () => [{ address: "160.79.104.10", family: 4 }],
    now: o.now,
    sweepIntervalMs: o.sweepIntervalMs,
    sweepLog: o.sweepLog,
    log: () => undefined,
  });
  open.push(gateway);
  const app = express();
  app.use(gateway.router);
  return { gateway, app };
}

describe("createGateway", () => {
  it("exposes the normalized issuer and serves metadata and JWKS with public CORS", async () => {
    const { gateway, app } = build();
    expect(gateway.issuer).toBe(ISSUER);
    const req = await loopbackRequest(app);
    const meta = await req.get("/.well-known/oauth-authorization-server").expect(200);
    expect(meta.body.issuer).toBe(ISSUER);
    expect(meta.headers["access-control-allow-origin"]).toBe("*");
    const jwks = await req.get("/.well-known/jwks.json").expect(200);
    expect(jwks.body.keys[0].kid).toBe("k1");
    expect(jwks.body.keys[0].d).toBeUndefined();
    expect(jwks.headers["access-control-allow-origin"]).toBe("*");
    const preflight = await req.options("/.well-known/jwks.json").set("Origin", "https://x.example.test").expect(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");
    expect(preflight.headers["access-control-allow-methods"]).toContain("GET");
  });

  it("sends no CORS headers on /token, /register or /revoke", async () => {
    const { app } = build();
    const req = await loopbackRequest(app);
    for (const path of ["/token", "/register", "/revoke"]) {
      const res = await req.post(path).set("Origin", "https://x.example.test").send({});
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("mounts /authorize, /oauth/consent and /token", async () => {
    const { app } = build();
    const req = await loopbackRequest(app);
    expect((await req.get("/authorize")).status).toBe(400);
    expect((await req.get("/oauth/consent")).status).toBe(400);
    const token = await req.post("/token").type("form").send({ grant_type: "password" });
    expect(token.status).toBeGreaterThanOrEqual(400);
    expect(typeof token.body.error).toBe("string");
  });

  it("renders unexpected browser-route errors as an HTML page without a stack", async () => {
    const store = new MemoryGatewayStore();
    store.getPending = async () => {
      throw new Error("boom-secret-detail");
    };
    const { app } = build({ store });
    const res = await (await loopbackRequest(app)).get("/oauth/consent?p=abc").expect(500);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).not.toContain("boom-secret-detail");
    expect(res.text).not.toMatch(/at .*\.ts/);
  });

  it("sweeps expired pendings, clients, CIMD entries, codes, refresh rows and markers, logging counts only", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-10-20T12:00:00Z");
    const store = new MemoryGatewayStore();
    const pendings = vi.spyOn(store, "deleteExpiredPendings").mockResolvedValue(3);
    const clients = vi.spyOn(store, "deleteClientsUnusedSince").mockResolvedValue(1);
    const neverUsed = vi.spyOn(store, "deleteNeverUsedClientsCreatedBefore").mockResolvedValue(2);
    const cimd = vi.spyOn(store, "deleteExpiredCimd").mockResolvedValue(4);
    const codes = vi.spyOn(store, "deleteExpiredCodes").mockResolvedValue(5);
    const refresh = vi.spyOn(store, "deleteExpiredRefreshTokens").mockResolvedValue(6);
    const markers = vi.spyOn(store, "deleteRevokedFamilyMarkersBefore").mockResolvedValue(7);
    const accessMarkers = vi.spyOn(store, "deleteClientRevocationsBefore").mockResolvedValue(8);
    const logs: Array<Record<string, unknown>> = [];
    const { gateway } = build({ store, now: () => now, sweepIntervalMs: 60_000, sweepLog: (e) => logs.push(e) });

    expect(pendings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    const ago = (ms: number) => new Date(now.getTime() - ms);
    expect(pendings).toHaveBeenCalledWith(now);
    expect(clients).toHaveBeenCalledWith(ago(CLIENT_IDLE_RETENTION_MS));
    expect(CLIENT_IDLE_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
    expect(neverUsed).toHaveBeenCalledWith(ago(CLIENT_NEVER_USED_RETENTION_MS));
    expect(CLIENT_NEVER_USED_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
    expect(cimd).toHaveBeenCalledWith(now);
    expect(codes).toHaveBeenCalledWith(ago(CODE_REUSE_REVOKE_GRACE_MS));
    expect(refresh).toHaveBeenCalledWith(now);
    expect(markers).toHaveBeenCalledWith(ago(REVOKED_FAMILY_MARKER_RETENTION_MS));
    expect(REVOKED_FAMILY_MARKER_RETENTION_MS).toBe(31 * 24 * 60 * 60 * 1000);
    // Access-token markers outlive every token they could refuse (1 h + 30 s skew).
    expect(accessMarkers).toHaveBeenCalledWith(ago(CLIENT_REVOCATION_RETENTION_MS));
    expect(CLIENT_REVOCATION_RETENTION_MS).toBe(2 * 60 * 60 * 1000);
    expect(logs).toEqual([
      { event: "gateway_sweep", result: "ok", pendings: 3, clients: 3, cimd: 4, codes: 5, refreshTokens: 6, revokedFamilies: 7, clientRevocations: 8 },
    ]);

    gateway.close();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(pendings).toHaveBeenCalledTimes(1);
  });

  it("caps the sweep interval at 10 minutes and survives store failures", async () => {
    vi.useFakeTimers();
    expect(SWEEP_MAX_INTERVAL_MS).toBe(10 * 60 * 1000);
    const store = new MemoryGatewayStore();
    const pendings = vi.spyOn(store, "deleteExpiredPendings").mockRejectedValue(new Error("db down secret"));
    const logs: Array<Record<string, unknown>> = [];
    build({ store, sweepIntervalMs: 24 * 60 * 60 * 1000, sweepLog: (e) => logs.push(e) });
    await vi.advanceTimersByTimeAsync(SWEEP_MAX_INTERVAL_MS);
    expect(pendings).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([{ event: "gateway_sweep", result: "failed" }]);
    await vi.advanceTimersByTimeAsync(SWEEP_MAX_INTERVAL_MS);
    expect(pendings).toHaveBeenCalledTimes(2);
  });
});
