import { runtimeStoreFixtures, syntheticGatewayConfig, syntheticOwnerAuth } from "../testing/runtime-owner-fixtures.js";
import { inventedFixture } from "../testing/synthetic-fixtures.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";

import type { SelfHostConfig } from "../config.js";
import { createPortfolioRuntime } from "../runtime.js";
import { OWNER_SUBJECT } from "../identity/owner-identity.js";
import { sessionCookieFor } from "../testing/owner-session.js";
import { loopbackRequest } from "../testing/loopback-request.js";
import { ActivitySyncService, createSnapTradeActivityProvider } from "../history/activity-sync-service.js";
import type { ActivityStore } from "../history/activity-store.js";

import { SnapTradeGateway, PERSONAL_CREDENTIALS, type SnapTradeClientPort } from "./gateway.js";
import {
  createPersonalSnapTradeClient,
  createSnapTradeGateway,
} from "./sdk-client.js";

const credentials = {
  clientId: "test-client-id",
  consumerKey: inventedFixture("sdk-client-test-fresh-1"),
};

function minimalClient(): SnapTradeClientPort {
  return {
    authentication: {
      loginSnapTradeUser: vi.fn(),
    },
    connections: {
      listBrokerageAuthorizations: vi.fn(),
      detailBrokerageAuthorization: vi.fn(),
      deleteConnection: vi.fn(),
    },
    accountInformation: {
      listUserAccounts: vi.fn(),
      getUserAccountDetails: vi.fn(),
      getUserAccountBalance: vi.fn(),
      getAllAccountPositions: vi.fn(),
      getUserAccountOrders: vi.fn(),
      getAccountActivities: vi.fn(),
      getAccountBalanceHistory: vi.fn(),
    },
    referenceData: {
      getPartnerInfo: vi.fn(),
    },
  };
}

describe("SnapTrade SDK composition", () => {
  it("constructs a production client exposing only the gateway port", () => {
    const client = createPersonalSnapTradeClient(credentials);

    expect(Object.keys(client).sort()).toEqual([
      "accountInformation",
      "authentication",
      "connections",
      "referenceData",
    ]);
    expect(client).not.toHaveProperty("trading");
  });

  it("injects Personal credentials through the server-side factory", () => {
    const client = minimalClient();
    const factory = vi.fn(() => client);

    const gateway = createSnapTradeGateway(credentials, factory);

    expect(gateway).toBeInstanceOf(SnapTradeGateway);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(credentials);
  });

  it("forwards cancellation through every actual SDK read adapter before network dispatch", async () => {
    const gateway = createSnapTradeGateway(credentials);
    const controller = new AbortController(); controller.abort();
    const options = { signal: controller.signal, timeout: 10 };
    const user = { userId: "invented-sdk-user", userSecret: inventedFixture("sdk-client-test-fresh-2") };
    for (const call of [
      () => gateway.listConnections(user, options), () => gateway.listAccounts(user, options),
      () => gateway.getAccountDetails(user, "invented-sdk-account", options),
      () => gateway.getBalances(user, "invented-sdk-account", options),
      () => gateway.getPositions(user, "invented-sdk-account", options),
      () => gateway.getOrders(user, "invented-sdk-account", { state: "all", days: 30 }, options),
      () => gateway.getActivities(user, "invented-sdk-account", { limit: 50 }, options),
      () => gateway.getBalanceHistory(user, "invented-sdk-account", options),
    ]) await expect(call()).rejects.toMatchObject({ code: "ERR_CANCELED" });
  });

  it("does not let the actual SDK retry guarded rate-limit responses outside the application budget", async () => {
    let requests = 0;
    const server = createServer((_request, response) => { requests++; response.writeHead(429, { "Content-Type": "application/json" }); response.end('{"error":"invented-rate-limit"}'); }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Synthetic listener unavailable");
    const gateway = new SnapTradeGateway(createPersonalSnapTradeClient(credentials, { basePath: `http://127.0.0.1:${address.port}` }));
    // Accelerate only the SDK's known backoff in the expected-failure run.
    const originalTimeout = global.setTimeout;
    const timer = vi.spyOn(global, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => originalTimeout(args[0], (args[1] ?? 0) >= 5000 ? 0 : args[1], ...args.slice(2))) as typeof setTimeout);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = { userId: "invented-rate-user", userSecret: inventedFixture("sdk-client-test-fresh-3") };
      const options = { signal: new AbortController().signal, timeout: 100 };
      const reads = [
        () => gateway.listConnections(user, options), () => gateway.listAccounts(user, options),
        () => gateway.getAccountDetails(user, "invented-rate-account", options),
        () => gateway.getBalances(user, "invented-rate-account", options),
        () => gateway.getPositions(user, "invented-rate-account", options),
        () => gateway.getOrders(user, "invented-rate-account", { state: "all", days: 30 }, options),
        () => gateway.getActivities(user, "invented-rate-account", { limit: 50 }, options),
        () => gateway.getBalanceHistory(user, "invented-rate-account", options),
      ];
      for (const [index, call] of reads.entries()) {
        await expect(call()).rejects.toThrow("Provider read unavailable");
        expect(requests).toBe(index + 1);
      }
      expect(log).not.toHaveBeenCalled();
    } finally { timer.mockRestore(); log.mockRestore(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("sends the actual SDK connection delete to the documented endpoint and maps a 404 to not_found", async () => {
    const seen: Array<{ method?: string; path: string }> = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      seen.push({ method: request.method, path: url.pathname });
      const gone = url.pathname.includes("invented-gone");
      response.writeHead(gone ? 404 : 200, { "Content-Type": "application/json" });
      response.end(gone ? '{"detail":"invented-not-found"}' : '{"detail":"invented-queued"}');
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Synthetic listener unavailable");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const gateway = new SnapTradeGateway(createPersonalSnapTradeClient(credentials, { basePath: `http://127.0.0.1:${address.port}` }));
      const user = { userId: "invented-delete-user", userSecret: inventedFixture("sdk-client-test-fresh-4") };
      await expect(gateway.deleteConnection(user, "invented-connection")).resolves.toBe("queued");
      await expect(gateway.deleteConnection(user, "invented-gone")).resolves.toBe("not_found");
      expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
        "DELETE /connection/invented-connection",
        "DELETE /connection/invented-gone",
      ]);
    } finally { log.mockRestore(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("signs requests with the Personal key and never sends userSecret", async () => {
    const seen: Array<{ url: URL; headers: Record<string, unknown> }> = [];
    const server = createServer((request, response) => {
      seen.push({ url: new URL(request.url ?? "/", "http://127.0.0.1"), headers: request.headers });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("[]");
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Synthetic listener unavailable");
    try {
      const gateway = new SnapTradeGateway(createPersonalSnapTradeClient(credentials, { basePath: `http://127.0.0.1:${address.port}` }));
      await gateway.listAccounts(PERSONAL_CREDENTIALS);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url.searchParams.has("userSecret")).toBe(false);
      expect(seen[0]!.url.searchParams.has("userId")).toBe(false);
      expect(String(seen[0]!.headers["signature"] ?? "").length).toBeGreaterThan(0);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("sends no userId or userSecret on the wire from any client method", async () => {
    const seen: Array<{ query: string; body: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({ query: new URL(request.url ?? "/", "http://127.0.0.1").search, body: Buffer.concat(chunks).toString("utf8") });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
      });
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Synthetic listener unavailable");
    try {
      const client = createPersonalSnapTradeClient(credentials, { basePath: `http://127.0.0.1:${address.port}` });
      const user = PERSONAL_CREDENTIALS;
      const account = { ...user, accountId: "invented-account" };
      const calls: Array<[string, () => Promise<unknown>]> = [
        ["loginSnapTradeUser", () => client.authentication.loginSnapTradeUser({ ...user, connectionType: "read" })],
        ["listBrokerageAuthorizations", () => client.connections.listBrokerageAuthorizations(user)],
        ["detailBrokerageAuthorization", () => client.connections.detailBrokerageAuthorization({ ...user, authorizationId: "invented-auth" })],
        ["deleteConnection", () => client.connections.deleteConnection({ ...user, connectionId: "invented-connection" })],
        ["listUserAccounts", () => client.accountInformation.listUserAccounts(user)],
        ["getUserAccountDetails", () => client.accountInformation.getUserAccountDetails(account)],
        ["getUserAccountBalance", () => client.accountInformation.getUserAccountBalance(account)],
        ["getAllAccountPositions", () => client.accountInformation.getAllAccountPositions(account)],
        ["getUserAccountOrders", () => client.accountInformation.getUserAccountOrders({ ...account, state: "all", days: 30 })],
        ["getAccountActivities", () => client.accountInformation.getAccountActivities({ ...account, limit: 10, offset: 0 })],
        ["getAccountBalanceHistory", () => client.accountInformation.getAccountBalanceHistory(account)],
        ["getPartnerInfo", () => client.referenceData.getPartnerInfo()],
      ];
      for (const [name, call] of calls) {
        const before = seen.length;
        await call();
        expect(seen.length, name).toBe(before + 1);
        const wire = seen[before]!;
        expect(wire.query, name).not.toMatch(/userId|userSecret/);
        expect(wire.body, name).not.toMatch(/userId|userSecret/);
      }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

describe("a rejected Personal key", () => {
  async function rejectingStub(accountsStatus: number, otherStatus: number) {
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const status = path === "/accounts" ? accountsStatus : otherStatus;
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(status === 200 ? (path === "/accounts" ? '[{"id":"account-1"}]' : "{}") : '{"detail":"invented-rejected"}');
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Synthetic listener unavailable");
    return { server, basePath: `http://127.0.0.1:${address.port}` };
  }

  it.each([401, 403])("maps a %i from SnapTrade to snaptrade_key_rejected", async (status) => {
    const { server, basePath } = await rejectingStub(status, status);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const gateway = new SnapTradeGateway(createPersonalSnapTradeClient(credentials, { basePath }));
      const runtime = createPortfolioRuntime({
        snapTrade: credentials,
        databaseUrl: "postgresql://unused-in-this-test", appBaseUrl: "http://localhost:3004",
        mcpResourceUrl: "http://localhost:3004/mcp", gateway: syntheticGatewayConfig("http://localhost:3004"), owner: syntheticOwnerAuth,
      } as SelfHostConfig, {
        ...runtimeStoreFixtures(),
        prisma: readyPrisma(),
        snapTradeGateway: gateway,
        now: () => new Date("2026-08-19T20:00:00Z"),
      });
      const response = await (await loopbackRequest(runtime.app)).get("/api/portfolio").set("Cookie", await sessionCookieFor(runtime.ownerSessions)).expect(502);
      expect(response.body).toEqual({ error: "snaptrade_key_rejected" });
      await runtime.close();
    } finally { log.mockRestore(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("records provider_error in the activity sync state when SnapTrade answers 403", async () => {
    const { server, basePath } = await rejectingStub(200, 403);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const gateway = new SnapTradeGateway(createPersonalSnapTradeClient(credentials, { basePath }));
      const recorded: unknown[] = [];
      const store = {
        userId: async () => "app-user",
        syncState: async () => null,
        recordSync: async (_user: string, _account: string, state: unknown) => { recorded.push(state); },
      } as unknown as ActivityStore;
      const service = new ActivitySyncService({
        identity: { getExisting: async () => PERSONAL_CREDENTIALS },
        provider: createSnapTradeActivityProvider(gateway),
        store,
      });
      const result = await service.syncUser(OWNER_SUBJECT);
      expect(result.failures).toBe(1);
      expect(recorded).toEqual([{ error: "provider_error" }]);
    } finally { log.mockRestore(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

function readyPrisma() {
  return {
    appUser: { findUnique: vi.fn(async () => ({ id: "synthetic-app-user" })), upsert: vi.fn(async () => ({ id: "synthetic-app-user" })) },
    webhookEvent: { create: vi.fn() },
    brokerageConnection: { upsert: vi.fn() },
    $disconnect: vi.fn(async () => undefined),
  } as never;
}
