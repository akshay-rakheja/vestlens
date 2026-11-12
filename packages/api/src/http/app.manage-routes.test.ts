import express from "express";
import { describe, expect, it, vi } from "vitest";

import { InvalidAccessTokenError } from "../auth/token-types.js";
import { loopbackRequest } from "../testing/loopback-request.js";
import { memoryOwnerSessions } from "../testing/owner-session-prisma.js";
import { sessionCookieFor } from "../testing/owner-session.js";
import { createPortfolioApi } from "./app.js";

const APP = "https://portfolio.example.com";

function build() {
  const sessions = memoryOwnerSessions();
  const mcpVerifier = { verify: vi.fn(async () => { throw new InvalidAccessTokenError(); }) };
  const connections = {
    getConnections: vi.fn(async () => []),
    createConnectionPortal: vi.fn(async () => "https://connect.snaptrade.example/session"),
  };
  const dataControls = {
    disconnect: vi.fn(async () => ({ status: "disconnected" as const, providerDeletion: "queued" })),
  };
  const accountExport = { stream: vi.fn(async (_s: string, write: (c: string) => Promise<void>) => { await write("{}"); return {}; }) };
  const aiApps = { list: vi.fn(async () => []), revoke: vi.fn(async () => true) };
  const portfolio = { getPortfolio: vi.fn(async () => ({ connectionRequired: false, generatedAt: "2026-10-23T00:00:00.000Z", accounts: [], errors: [] })) };
  const app = createPortfolioApi({
    sessions,
    portfolio,
    history: { getAccountHistory: vi.fn() },
    connections,
    webhooks: { ingest: vi.fn(async () => ({ duplicate: false })) },
    appBaseUrl: APP,
    dataControls,
    accountExport,
    gateway: { router: express.Router(), mcpVerifier, issuer: APP, aiApps },
  } as never);
  return { app, sessions, handlers: { connections, dataControls, accountExport, aiApps, portfolio } };
}

const manageRoutes = [
  { name: "connection session", method: "post", path: "/api/connections/session", handler: (h: ReturnType<typeof build>["handlers"]) => h.connections.createConnectionPortal },
  { name: "disconnect", method: "delete", path: "/api/connections/connection-1", handler: (h: ReturnType<typeof build>["handlers"]) => h.dataControls.disconnect },
  { name: "export", method: "get", path: "/api/account/export", handler: (h: ReturnType<typeof build>["handlers"]) => h.accountExport.stream },
  { name: "AI apps list", method: "get", path: "/api/ai-apps", handler: (h: ReturnType<typeof build>["handlers"]) => h.aiApps.list },
  { name: "AI app revoke", method: "post", path: "/api/ai-apps/client-key/revoke", handler: (h: ReturnType<typeof build>["handlers"]) => h.aiApps.revoke },
] as const;

describe("connections:manage routes belong to the owner session", () => {
  for (const route of manageRoutes) {
    it(`${route.name}: the owner session reaches the handler`, async () => {
      const { app, sessions, handlers } = build();
      const response = await (await loopbackRequest(app))[route.method](route.path)
        .set("Cookie", await sessionCookieFor(sessions)).set("Origin", APP).send({});
      expect(response.status).toBeLessThan(300);
      expect(route.handler(handlers)).toHaveBeenCalledOnce();
    });

    it(`${route.name}: a bearer token alone gets 401 and never reaches the handler`, async () => {
      const { app, handlers } = build();
      const response = await (await loopbackRequest(app))[route.method](route.path).set("Authorization", "Bearer anything").send({});
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "authentication_required" });
      expect(route.handler(handlers)).not.toHaveBeenCalled();
    });
  }

  it("serves the portfolio routes to the session too", async () => {
    const { app, sessions, handlers } = build();
    const client = await loopbackRequest(app);
    const cookie = await sessionCookieFor(sessions);
    await client.get("/api/portfolio").set("Cookie", cookie).expect(200);
    await client.get("/api/connections").set("Cookie", cookie).expect(200);
    expect(handlers.portfolio.getPortfolio).toHaveBeenCalledTimes(1);
  });

  it("answers a missing session with 401", async () => {
    const { app } = build();
    await (await loopbackRequest(app)).delete("/api/connections/connection-1").expect(401);
  });
});
