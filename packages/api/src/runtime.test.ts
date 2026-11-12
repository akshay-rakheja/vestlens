import { inventedAccountNumber, inventedFixture } from "./testing/synthetic-fixtures.js";
import { loopbackRequest } from "./testing/loopback-request.js";
import { sessionCookieFor } from "./testing/owner-session.js";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WebhookIngestionService } from "./snaptrade/webhook-ingestion-service.js";

// Wraps the real class so a test can see whether the runtime built one.
vi.mock("./snaptrade/webhook-ingestion-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./snaptrade/webhook-ingestion-service.js")>();
  return { ...actual, WebhookIngestionService: vi.fn(function (this: unknown, ...args: ConstructorParameters<typeof actual.WebhookIngestionService>) { return new actual.WebhookIngestionService(...args); }) };
});

import type { SelfHostConfig } from "./config.js";
import { createPortfolioRuntime as createRuntime } from "./runtime.js";
import { mcpBearer, runtimeStoreFixtures, syntheticGatewayConfig, syntheticOwnerAuth } from "./testing/runtime-owner-fixtures.js";
import { LOADER_WIDGETS, widgetLoaderHtml, widgetLoaderUri } from "./mcp/widget-loader.js";
import { widgetUri } from "./mcp/widget-assets.js";
import { OWNER_SUBJECT } from "./identity/owner-identity.js";
import { PERSONAL_CREDENTIALS } from "./snaptrade/gateway.js";
import { MemoryNewsStore } from "./news/store.js";
import { MemoryGatewayStore } from "./gateway/store.js";

/** A runtime over an injected database port also needs its stores injected; tests that exercise that rule call createRuntime. */
const createPortfolioRuntime: typeof createRuntime = (appConfig, options = {}) =>
  createRuntime(appConfig, options.prisma ? { ...runtimeStoreFixtures(), ...options } : options);

/** Runs the scheduled nightly job once, directly (no timers): what the scheduler does at 17:30 Toronto. */
async function runNightlyJob(runtime: { jobs: Array<{ name: string; run(): Promise<void> }> }): Promise<void> {
  const job = runtime.jobs.find((j) => j.name === "nightly");
  if (!job) throw new Error("nightly job not composed");
  await job.run();
}

const config: SelfHostConfig = {
  snapTrade: {
    clientId: "test-client",
    consumerKey: inventedFixture("runtime-test-fresh-1"),
  },
  databaseUrl: "postgresql://unused-in-this-test",
  appBaseUrl: "http://localhost:3004",
  mcpResourceUrl: "http://localhost:3004/mcp",
  gateway: syntheticGatewayConfig("http://localhost:3004"),
  owner: syntheticOwnerAuth,
  webhooksEnabled: false,
};

function prismaPort() {
  return {
    appUser: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({ id: "synthetic-owner" })),
    },
    webhookEvent: {
      create: vi.fn(),
    },
    brokerageConnection: {
      upsert: vi.fn(),
    },
    $disconnect: vi.fn(async () => undefined),
  };
}

function snapTradeGateway() {
  return {
    deleteConnection: vi.fn(),
    createConnectionUrl: vi.fn(),
    listConnections: vi.fn(),
    listAccounts: vi.fn(),
    getAccountDetails: vi.fn(),
    getBalances: vi.fn(),
    getPositions: vi.fn(),
    getOrders: vi.fn(),
    getActivities: vi.fn(),
    getBalanceHistory: vi.fn(),
  };
}

/** The dashboard's browser headers: the owner session cookie and this app's own Origin (required on writes). */
async function ownerHeaders(runtime: { ownerSessions: Parameters<typeof sessionCookieFor>[0] }) {
  return { Cookie: await sessionCookieFor(runtime.ownerSessions), Origin: "http://localhost:3004" };
}

describe("createPortfolioRuntime", () => {
  it("creates the owner row at startup, once, without any per-user identity", async () => {
    const prisma = prismaPort();
    const runtime = createPortfolioRuntime(config, { prisma, snapTradeGateway: snapTradeGateway() });

    await expect(runtime.ready).resolves.toBeUndefined();
    expect(prisma.appUser.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.appUser.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { authSubject: OWNER_SUBJECT } }));
    await runtime.close();
  });

  it("reports a failed owner row through ready instead of listening without one", async () => {
    const prisma = prismaPort();
    prisma.appUser.upsert.mockRejectedValueOnce(new Error("synthetic database outage"));
    const runtime = createPortfolioRuntime(config, { prisma, snapTradeGateway: snapTradeGateway() });

    await expect(runtime.ready).rejects.toThrow("synthetic database outage");
    await runtime.close();
  });

  // The owner has no brokerage connection yet: the "not connected" answer.
  it("serves an authenticated connection-required portfolio through the composed services", async () => {
    const prisma = prismaPort();
    const gateway = snapTradeGateway();
    gateway.listConnections.mockResolvedValue([]);
    gateway.listAccounts.mockResolvedValue([]);
    const runtime = createPortfolioRuntime(config, {
      prisma,
      snapTradeGateway: gateway,
      now: () => new Date("2026-08-19T20:00:00Z"),
    });

    const response = await (await loopbackRequest(runtime.app))
      .get("/api/portfolio")
      .set(await ownerHeaders(runtime))
      .expect(200);

    expect(response.body).toEqual({
      connectionRequired: true,
      generatedAt: "2026-08-19T20:00:00.000Z",
      totals: [],
      accounts: [],
      errors: [],
    });

    await runtime.close();
  });
});

describe("createPortfolioRuntime normal-mode cache", () => {
  // Matches the invented signed fixture in snaptrade/webhook-ingestion-service.test.ts.
  const webhookBody = JSON.stringify({
    webhookId: "webhook-123",
    userId: "portfolio_00000000-0000-4000-8000-0000000000c1",
    eventType: "ACCOUNT_HOLDINGS_UPDATED",
    eventTimestamp: "2026-08-19T17:00:00.000Z",
    clientId: "commercial-client",
    webhookSecret: "deprecated-secret-must-not-be-stored",
    accountId: "account-1",
  });
  const webhookSignature = "jY/0IaZbqaajFrkiMDk5ks+zqR90vAOXYhqzpWUNZaY=";
  const subject = OWNER_SUBJECT;
  const cacheConfig: SelfHostConfig = {
    ...config,
    snapTrade: { clientId: "commercial-client", consumerKey: "consumer-secret" },
  };

  function readyIdentityPrisma() {
    const prisma = prismaPort();
    prisma.appUser.findUnique.mockImplementation((async () => ({
      id: "synthetic-app-user",
      authSubject: subject,
    })) as never);
    prisma.webhookEvent.create.mockImplementation((async () => ({ id: "synthetic-event" })) as never);
    return prisma;
  }

  function accountGateway() {
    const gateway = snapTradeGateway();
    gateway.listAccounts.mockResolvedValue([{ id: "account-1" }]);
    gateway.getAccountDetails.mockResolvedValue({
      id: "account-1", brokerage_authorization: "connection-1", name: "Synthetic TFSA",
      number: inventedAccountNumber("runtime-cache-account"), institution_name: "Synthetic brokerage", raw_type: "TFSA",
      account_category: "SYNTHETIC", status: "open", is_paper: true,
      balance: { total: { amount: 10, currency: "CAD" } },
      sync_status: { holdings: { initial_sync_completed: true, last_successful_sync: "2026-08-19T16:00:00Z", holdings_unavailable: false } },
    });
    gateway.getBalances.mockResolvedValue([]);
    gateway.getPositions.mockResolvedValue({ results: [] });
    return gateway;
  }

  it("shares one provider read across calls and evicts it on a verified webhook", async () => {
    const gateway = accountGateway();
    const runtime = createPortfolioRuntime({ ...cacheConfig, webhooksEnabled: true }, {
      prisma: readyIdentityPrisma(),
      snapTradeGateway: gateway,
      now: () => new Date("2026-08-19T17:03:00.000Z"),
    });
    const client = await loopbackRequest(runtime.app);
    const owner = await ownerHeaders(runtime);
    const read = () => client.get("/api/portfolio").set(owner).expect(200);

    const first = await read();
    await read();
    expect(gateway.listAccounts).toHaveBeenCalledTimes(1);
    expect(first.body.accounts).toHaveLength(1);
    expect(first.body.cache).toMatchObject({ source: "provider", stale: false });

    await client.post("/webhooks/snaptrade").set("Content-Type", "application/json")
      .set("Signature", webhookSignature).send(webhookBody).expect(204);

    await read();
    expect(gateway.listAccounts).toHaveBeenCalledTimes(2);
    await runtime.close();
  });
});

describe("createPortfolioRuntime webhooks", () => {
  it("does not mount the webhook route unless WEBHOOKS_ENABLED (404), and mounts it, verified, when enabled", async () => {
    const make = (enabled: boolean) => createPortfolioRuntime(
      { ...config, webhooksEnabled: enabled },
      { prisma: prismaPort(), snapTradeGateway: snapTradeGateway(), now: () => new Date("2026-08-19T17:03:00.000Z") } as never,
    );
    const built = vi.mocked(WebhookIngestionService);
    built.mockClear();
    const off = make(false);
    expect(built).not.toHaveBeenCalled(); // no verifier, no consumer-key use, when webhooks are off
    await (await loopbackRequest(off.app)).post("/webhooks/snaptrade").set("Content-Type", "application/json")
      .set("Signature", "invalid").send("{}").expect(404);
    await off.close();
    const on = make(true);
    expect(built).toHaveBeenCalledTimes(1);
    await (await loopbackRequest(on.app)).post("/webhooks/snaptrade").set("Content-Type", "application/json")
      .set("Signature", "invalid").send("{}").expect(401);
    await on.close();
  });
});

describe("createPortfolioRuntime data controls", () => {
  const subject = OWNER_SUBJECT;
  const snapTradeUserId = "portfolio_00000000-0000-4000-8000-0000000000c1";
  const controlsConfig: SelfHostConfig = { ...config, webhooksEnabled: true, snapTrade: { clientId: "commercial-client", consumerKey: "consumer-secret" } };

  function wiring() {
    const prisma = prismaPort();
    prisma.appUser.findUnique.mockImplementation((async () => ({
      id: "synthetic-app-user", authSubject: subject,
    })) as never);
    prisma.webhookEvent.create.mockImplementation((async () => ({ id: "synthetic-event" })) as never);
    const purged: string[] = [];
    const count = (name: string) => vi.fn(async () => { purged.push(name); return { count: 1 }; });
    const tx = {
      brokerageAccount: { findMany: vi.fn(async () => [{ snapTradeAccountId: "account-1" }]) },
      brokerageConnection: { deleteMany: count("connection") },
      portfolioSnapshot: { deleteMany: count("snapshots") },
      activity: { deleteMany: count("activities") },
      activitySyncState: { deleteMany: count("syncState") },
      accountHistoryQuality: { deleteMany: count("quality") },
      dailyValue: { deleteMany: count("dailyValues") },
      webhookEvent: { deleteMany: count("webhooks") },
      pendingDisconnect: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 0 })) },
    };
    const dataControlPrisma = {
      appUser: { findUnique: vi.fn(async () => ({ id: "synthetic-app-user" })) },
      webhookEvent: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      brokerageConnection: { findFirst: vi.fn(async (_input: unknown): Promise<{ id: string } | null> => ({ id: "stored-connection" })) },
      pendingDisconnect: {
        findMany: vi.fn(async () => [] as Array<{ snapTradeConnectionId: string }>),
        findUnique: vi.fn(async (_input: unknown): Promise<{ id: string } | null> => null),
        count: vi.fn(async (_input: unknown) => 0),
      },
      mcpOAuthClientRevocation: { deleteMany: vi.fn(async (_input: unknown) => ({ count: 0 })) },
      $executeRaw: vi.fn(async () => 0),
      async $transaction<T>(fn: (t: typeof tx) => Promise<T>): Promise<T> { return fn(tx); },
    };
    const gateway = snapTradeGateway();
    gateway.deleteConnection.mockResolvedValue("queued");
    return { prisma, dataControlPrisma, gateway, tx, purged };
  }

  it("serves no sign-in settings, and a bearer token cannot reach the management routes", async () => {
    const w = wiring();
    const runtime = createPortfolioRuntime(controlsConfig, {
      prisma: w.prisma, dataControlPrisma: w.dataControlPrisma, snapTradeGateway: w.gateway,
      now: () => new Date("2026-08-19T17:03:00.000Z"),
    });
    const client = await loopbackRequest(runtime.app);
    expect((await client.get("/api/config")).status).not.toBe(200);
    const bearer = await mcpBearer(controlsConfig, "portfolio:read");
    await client.delete("/api/connections/connection-1").set("Authorization", `Bearer ${bearer}`).expect(401);
    expect(w.gateway.deleteConnection).not.toHaveBeenCalled();
    expect(w.purged).toEqual([]);
    await runtime.close();
  });

  it("disconnects through the composed services with the caller's own identity", async () => {
    const w = wiring();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createPortfolioRuntime(controlsConfig, {
      prisma: w.prisma, dataControlPrisma: w.dataControlPrisma, snapTradeGateway: w.gateway,
      now: () => new Date("2026-08-19T17:03:00.000Z"),
    });
    const client = await loopbackRequest(runtime.app);

    await client.delete("/api/connections/connection-1").set(await ownerHeaders(runtime)).expect(202);
    expect(w.gateway.deleteConnection).toHaveBeenCalledWith(
      PERSONAL_CREDENTIALS, "connection-1",
    );
    expect(w.purged).toEqual(expect.arrayContaining(["snapshots", "activities", "dailyValues", "connection", "webhooks"]));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(subject);
    warn.mockRestore();
    await runtime.close();
  });

  it("purges local state on a verified CONNECTION_DELETED webhook without a provider call", async () => {
    const w = wiring();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createPortfolioRuntime(controlsConfig, {
      prisma: w.prisma, dataControlPrisma: w.dataControlPrisma, snapTradeGateway: w.gateway,
      now: () => new Date("2026-08-19T17:03:00.000Z"),
    });
    const event = {
      brokerageAuthorizationId: "connection-1",
      clientId: "commercial-client",
      eventTimestamp: "2026-08-19T17:00:00.000Z",
      eventType: "CONNECTION_DELETED",
      userId: snapTradeUserId,
      webhookId: "webhook-runtime-deleted",
    };
    const body = JSON.stringify(event);
    const signature = createHmac("sha256", "consumer-secret").update(body).digest("base64");

    await (await loopbackRequest(runtime.app)).post("/webhooks/snaptrade").set("Content-Type", "application/json")
      .set("Signature", signature).send(body).expect(204);

    expect(w.prisma.brokerageConnection.upsert).not.toHaveBeenCalled();
    expect(w.purged).toEqual(expect.arrayContaining(["snapshots", "connection"]));
    expect(w.purged).not.toContain("webhooks");
    expect(w.gateway.deleteConnection).not.toHaveBeenCalled();
    await runtime.close();
  });

  /** In-memory marker table plus recorded portfolio-state writes, shared by every port that touches them. */
  function liveWiring() {
    const w = wiring();
    type Marker = { appUserId: string; snapTradeConnectionId: string; snapTradeAccountIds: string[]; requestedAt: Date; confirmedAt: Date | null };
    const markers: Marker[] = [];
    const marker = (id: string) => markers.find((m) => m.snapTradeConnectionId === id);
    const upsertMarker = async (input: { create: Partial<Marker> & { snapTradeConnectionId: string }; update: Partial<Marker> }) => {
      const found = marker(input.create.snapTradeConnectionId);
      if (found) Object.assign(found, input.update);
      else markers.push({ appUserId: "synthetic-app-user", snapTradeAccountIds: [], requestedAt: new Date(0), confirmedAt: null, ...input.create });
      return {};
    };
    // Stateful stand-ins for the rows a purge must find: stored accounts (by connection), activities and sync state.
    const stored = new Map<string, string>(); // snapTradeAccountId -> snapTradeConnectionId
    const activities: string[] = []; // snapTradeAccountId per Activity row
    const syncStates: string[] = [];
    const inScope = (input: { where: { snapTradeAccountId: { in: string[] } } }, rows: string[], name: string) => {
      w.purged.push(name);
      const before = rows.length;
      rows.splice(0, rows.length, ...rows.filter((id) => !input.where.snapTradeAccountId.in.includes(id)));
      return { count: before - rows.length };
    };
    const tx = {
      ...w.tx,
      brokerageAccount: {
        findMany: vi.fn(async (input: { where: { connection: { snapTradeConnectionId: string } } }) =>
          [...stored].filter(([, c]) => c === input.where.connection.snapTradeConnectionId).map(([snapTradeAccountId]) => ({ snapTradeAccountId }))),
      },
      brokerageConnection: {
        deleteMany: vi.fn(async (input: { where: { snapTradeConnectionId: string } }) => {
          w.purged.push("connection");
          for (const [a, c] of [...stored]) if (c === input.where.snapTradeConnectionId) stored.delete(a);
          return { count: 1 };
        }),
      },
      activity: { deleteMany: vi.fn(async (input: { where: { snapTradeAccountId: { in: string[] } } }) => inScope(input, activities, "activities")) },
      activitySyncState: { deleteMany: vi.fn(async (input: { where: { snapTradeAccountId: { in: string[] } } }) => inScope(input, syncStates, "syncState")) },
      pendingDisconnect: {
        findUnique: vi.fn(async (input: { where: { appUserId_snapTradeConnectionId: { snapTradeConnectionId: string } } }) => {
          const found = marker(input.where.appUserId_snapTradeConnectionId.snapTradeConnectionId);
          return found ? { snapTradeAccountIds: found.snapTradeAccountIds } : null;
        }),
        upsert: vi.fn(upsertMarker),
        deleteMany: vi.fn(async (input: { where: { snapTradeConnectionId: string } }) => {
          const before = markers.length;
          markers.splice(0, markers.length, ...markers.filter((m) => m.snapTradeConnectionId !== input.where.snapTradeConnectionId));
          return { count: before - markers.length };
        }),
      },
    };
    const dataControlPrisma = {
      ...w.dataControlPrisma,
      $executeRaw: vi.fn(async () => 0),
      brokerageConnection: { findFirst: vi.fn(async (input: { where: { snapTradeConnectionId: string } }) => ([...stored.values()].includes(input.where.snapTradeConnectionId) ? { id: "stored" } : null)) },
      pendingDisconnect: {
        count: vi.fn(async () => markers.length),
        findUnique: vi.fn(async (input: { where: { appUserId_snapTradeConnectionId: { snapTradeConnectionId: string } } }) => (marker(input.where.appUserId_snapTradeConnectionId.snapTradeConnectionId) ? { id: "marker" } : null)),
        findMany: vi.fn(async (input: { where?: { confirmedAt?: null | { not: null } }; select: Record<string, unknown> }) => markers
          .filter((m) => !input.where || !("confirmedAt" in input.where) || (input.where.confirmedAt === null ? m.confirmedAt === null : m.confirmedAt !== null))
          .map((m) => ("appUserId" in input.select ? m : { snapTradeConnectionId: m.snapTradeConnectionId }))),
      },
      async $transaction<T>(fn: (t: typeof tx) => Promise<T>): Promise<T> { return fn(tx); },
    };
    const prisma = { ...w.prisma, pendingDisconnect: { upsert: vi.fn(upsertMarker) } };
    const persisted = { connections: [] as string[], snapshots: [] as string[] };
    const portfolioStatePrisma = {
      appUser: { findIdByAuthSubject: vi.fn(async () => ({ id: "synthetic-app-user" })) },
      brokerageConnection: { upsert: vi.fn(async (input: { create: { snapTradeConnectionId: string } }) => { persisted.connections.push(input.create.snapTradeConnectionId); return { id: `stored-${input.create.snapTradeConnectionId}` }; }) },
      brokerageAccount: { upsert: vi.fn(async (input: { create: { connectionId: string; snapTradeAccountId: string } }) => {
        stored.set(input.create.snapTradeAccountId, input.create.connectionId.replace(/^stored-/, ""));
        return { id: "stored-account" };
      }) },
      portfolioSnapshot: { create: vi.fn(async (input: { data: { snapTradeAccountId: string } }) => { persisted.snapshots.push(input.data.snapTradeAccountId); return {}; }) },
      pendingDisconnect: { findMany: vi.fn(async () => markers.map((m) => ({ snapTradeConnectionId: m.snapTradeConnectionId }))) },
    };
    const accounts = [["account-1", "connection-1"], ["account-2", "connection-2"]];
    w.gateway.listAccounts.mockImplementation(async () => accounts.map(([id, connection]) => ({ id, brokerage_authorization: connection })));
    w.gateway.listConnections.mockImplementation(async () => [...new Set(accounts.map(([, connection]) => connection))].map((id) => ({ id, type: "read" })));
    w.gateway.getAccountDetails.mockImplementation((async (_c: unknown, id: string) => ({
      id, brokerage_authorization: accounts.find(([a]) => a === id)?.[1], name: `Synthetic ${id}`,
      number: inventedAccountNumber(`runtime-data-controls-${id}`), institution_name: "Synthetic brokerage", raw_type: "TFSA",
      account_category: "SYNTHETIC", status: "open", is_paper: true,
      balance: { total: { amount: 10, currency: "CAD" } },
      sync_status: { holdings: { initial_sync_completed: true, last_successful_sync: "2026-08-19T16:00:00Z", holdings_unavailable: false } },
    })) as never);
    w.gateway.getBalances.mockResolvedValue([]);
    w.gateway.getPositions.mockResolvedValue({ results: [] });
    return { ...w, prisma, tx, dataControlPrisma, portfolioStatePrisma, persisted, markers, accounts, activities, syncStates };
  }

  it("keeps a disconnected connection out of the immediate reload while SnapTrade still lists it, and shows a reconnect normally", async () => {
    const w = liveWiring();
    let clock = new Date("2026-08-19T17:03:00.000Z");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createPortfolioRuntime(controlsConfig, {
      prisma: w.prisma, dataControlPrisma: w.dataControlPrisma, portfolioStatePrisma: w.portfolioStatePrisma, snapTradeGateway: w.gateway,
      now: () => clock,
    } as never);
    const client = await loopbackRequest(runtime.app);
    const owner = await ownerHeaders(runtime);
    const auth = (r: ReturnType<typeof client.get>) => r.set(owner);

    expect((await auth(client.get("/api/portfolio")).expect(200)).body.accounts).toHaveLength(2);
    await client.delete("/api/connections/connection-1").set(await ownerHeaders(runtime)).expect(202);
    expect(w.markers.map((m) => m.snapTradeConnectionId)).toEqual(["connection-1"]);
    w.persisted.connections.length = 0;
    w.persisted.snapshots.length = 0;
    w.gateway.getAccountDetails.mockClear();

    // SnapTrade has only queued the deletion and still lists connection-1 and account-1.
    const reload = await auth(client.get("/api/portfolio")).expect(200);
    expect(reload.body.accounts.map((a: { id: string }) => a.id)).toEqual(["account-2"]);
    expect(w.persisted.connections).toEqual(["connection-2"]);
    expect(w.persisted.snapshots).toEqual(["account-2"]);
    expect(w.gateway.getAccountDetails).not.toHaveBeenCalledWith(expect.anything(), "account-1", expect.anything());
    const connections = await auth(client.get("/api/connections")).expect(200);
    expect(connections.body.map((c: { id: string }) => c.id)).toEqual(["connection-2"]);

    // Reconnecting the same brokerage creates a new authorization id, which reads and persists normally.
    w.accounts.splice(0, 1, ["account-3", "connection-3"]);
    w.persisted.connections.length = 0;
    // An id the caller has neither stored nor listed at SnapTrade: 404, no provider write, no marker.
    await client.delete("/api/connections/connection-unused").set(await ownerHeaders(runtime)).expect(404);
    expect(w.gateway.deleteConnection).not.toHaveBeenCalledWith(expect.anything(), "connection-unused");
    expect(w.markers.map((m) => m.snapTradeConnectionId)).toEqual(["connection-1"]);
    clock = new Date("2026-08-19T18:03:00.000Z"); // past the cache TTL, as a later visit would be
    const reconnected = await auth(client.get("/api/portfolio")).expect(200);
    expect(reconnected.body.accounts.map((a: { id: string }) => a.id).sort()).toEqual(["account-2", "account-3"]);
    expect(w.persisted.connections).toContain("connection-3");
    warn.mockRestore();
    await runtime.close();
  });

  it("logs a failed CONNECTION_DELETED purge with a constant code and retries it in the nightly sweep", async () => {
    const w = liveWiring();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createPortfolioRuntime(controlsConfig, {
      prisma: w.prisma, dataControlPrisma: w.dataControlPrisma, portfolioStatePrisma: w.portfolioStatePrisma, snapTradeGateway: w.gateway,
      now: () => new Date("2026-08-19T17:03:00.000Z"),
      advisoryLock: async (_name: string, fn: () => Promise<void>) => { await fn(); return true; },
      dailyValuePrisma: { appUser: { findMany: vi.fn(async () => []) }, dailyValue: { upsert: vi.fn(), findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) } },
    } as never);
    w.tx.brokerageAccount.findMany.mockRejectedValueOnce(new Error("synthetic database outage"));
    const body = JSON.stringify({
      brokerageAuthorizationId: "connection-1", clientId: "commercial-client", eventTimestamp: "2026-08-19T17:00:00.000Z",
      eventType: "CONNECTION_DELETED", userId: snapTradeUserId, webhookId: "webhook-runtime-deleted-retry",
    });
    const signature = createHmac("sha256", "consumer-secret").update(body).digest("base64");
    const client = await loopbackRequest(runtime.app);

    await client.post("/webhooks/snaptrade").set("Content-Type", "application/json").set("Signature", signature).send(body).expect(204);
    const logs = () => warn.mock.calls.map((c) => String(c[0]));
    expect(logs()).toContain(JSON.stringify({ event: "connection_purge_failed", source: "webhook", failed: 1 }));
    expect(w.markers).toEqual([expect.objectContaining({ snapTradeConnectionId: "connection-1", confirmedAt: expect.any(Date) })]);
    expect(w.purged).not.toContain("connection");

    await runNightlyJob(runtime);
    expect(w.purged).toContain("connection");
    expect(w.markers).toEqual([]);
    expect(logs().some((l) => l.includes('"event":"retention_purge"') && l.includes('"disconnects":{"pending":1,"cleared":1,"expired":0,"failed":0}'))).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("connection-1");
    warn.mockRestore();
    await runtime.close();
  });

  it("runs the retention and pending-disconnect sweeps alongside the snapshot run", async () => {
    const w = liveWiring();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createPortfolioRuntime(controlsConfig, {
      prisma: w.prisma, dataControlPrisma: w.dataControlPrisma, portfolioStatePrisma: w.portfolioStatePrisma, snapTradeGateway: w.gateway,
      now: () => new Date("2026-08-19T17:03:00.000Z"),
      advisoryLock: async (_name: string, fn: () => Promise<void>) => { await fn(); return true; },
      dailyValuePrisma: { appUser: { findMany: vi.fn(async () => [{ id: "synthetic-app-user", authSubject: subject }]) }, dailyValue: { upsert: vi.fn(), findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) } },
    } as never);
    w.tx.brokerageAccount.findMany.mockRejectedValueOnce(new Error("synthetic database outage"));
    const body = JSON.stringify({
      brokerageAuthorizationId: "connection-1", clientId: "commercial-client", eventTimestamp: "2026-08-19T17:00:00.000Z",
      eventType: "CONNECTION_DELETED", userId: snapTradeUserId, webhookId: "webhook-runtime-deleted-deleted",
    });
    const signature = createHmac("sha256", "consumer-secret").update(body).digest("base64");
    const client = await loopbackRequest(runtime.app);
    await client.post("/webhooks/snaptrade").set("Content-Type", "application/json").set("Signature", signature).send(body).expect(204);
    for (const fn of Object.values(w.gateway)) fn.mockClear();

    await runNightlyJob(runtime);
    const logs = warn.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('"event":"daily_snapshots"') && l.includes('"users":1'))).toBe(true);
    // The data-control sweeps run in the same pass.
    expect(w.purged).toContain("connection");
    expect(w.markers).toEqual([]);
    expect(logs.some((l) => l.includes('"event":"retention_purge"') && l.includes('"cleared":1'))).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(subject);
    warn.mockRestore();
    await runtime.close();
  });

  it("removes activity and sync state an in-flight sync wrote after the disconnect purge, and leaves other accounts alone", async () => {
    const w = liveWiring();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createPortfolioRuntime(controlsConfig, {
      prisma: w.prisma, dataControlPrisma: w.dataControlPrisma, portfolioStatePrisma: w.portfolioStatePrisma, snapTradeGateway: w.gateway,
      now: () => new Date("2026-08-19T17:03:00.000Z"),
      advisoryLock: async (_name: string, fn: () => Promise<void>) => { await fn(); return true; },
      dailyValuePrisma: { appUser: { findMany: vi.fn(async () => []) }, dailyValue: { upsert: vi.fn(), findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) } },
    } as never);
    const client = await loopbackRequest(runtime.app);
    await client.get("/api/portfolio").set(await ownerHeaders(runtime)).expect(200);
    await client.delete("/api/connections/connection-1").set(await ownerHeaders(runtime)).expect(202);
    expect(w.markers[0]?.snapTradeAccountIds).toEqual(["account-1"]);

    // A sync that listed account-1 before the marker committed writes its rows now.
    w.activities.push("account-1", "account-1", "account-2");
    w.syncStates.push("account-1", "account-2");
    await runNightlyJob(runtime);

    expect(w.activities).toEqual(["account-2"]);
    expect(w.syncStates).toEqual(["account-2"]);
    // Unconfirmed and recent: the marker stays, so reads keep hiding the connection.
    expect(w.markers.map((m) => m.snapTradeConnectionId)).toEqual(["connection-1"]);
    warn.mockRestore();
    await runtime.close();
  });

  it("keeps the marker after a successful CONNECTION_DELETED purge so the sweep removes rows a still-running sync writes", async () => {
    const w = liveWiring();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createPortfolioRuntime(controlsConfig, {
      prisma: w.prisma, dataControlPrisma: w.dataControlPrisma, portfolioStatePrisma: w.portfolioStatePrisma, snapTradeGateway: w.gateway,
      now: () => new Date("2026-08-19T17:03:00.000Z"),
      advisoryLock: async (_name: string, fn: () => Promise<void>) => { await fn(); return true; },
      dailyValuePrisma: { appUser: { findMany: vi.fn(async () => []) }, dailyValue: { upsert: vi.fn(), findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) } },
    } as never);
    const client = await loopbackRequest(runtime.app);
    await client.get("/api/portfolio").set(await ownerHeaders(runtime)).expect(200);
    const body = JSON.stringify({
      brokerageAuthorizationId: "connection-1", clientId: "commercial-client", eventTimestamp: "2026-08-19T17:00:00.000Z",
      eventType: "CONNECTION_DELETED", userId: snapTradeUserId, webhookId: "webhook-runtime-deleted-in-flight",
    });
    const signature = createHmac("sha256", "consumer-secret").update(body).digest("base64");
    await client.post("/webhooks/snaptrade").set("Content-Type", "application/json").set("Signature", signature).send(body).expect(204);

    // The purge succeeded, but the confirmed marker (with the purged account ids) stays for the sweep.
    expect(w.purged).toContain("connection");
    expect(w.markers).toEqual([expect.objectContaining({ snapTradeConnectionId: "connection-1", snapTradeAccountIds: ["account-1"], confirmedAt: expect.any(Date) })]);

    // A paged activity sync that listed account-1 earlier writes its rows now.
    w.activities.push("account-1", "account-2");
    w.syncStates.push("account-1");
    await runNightlyJob(runtime);

    expect(w.activities).toEqual(["account-2"]);
    expect(w.syncStates).toEqual([]);
    expect(w.markers).toEqual([]);
    warn.mockRestore();
    await runtime.close();
  });

  it("forgets the cached portfolio on CONNECTION_DELETED, so a provider error cannot serve the removed connection", async () => {
    const w = liveWiring();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createPortfolioRuntime(controlsConfig, {
      prisma: w.prisma, dataControlPrisma: w.dataControlPrisma, portfolioStatePrisma: w.portfolioStatePrisma, snapTradeGateway: w.gateway,
      now: () => new Date("2026-08-19T17:03:00.000Z"),
    } as never);
    const client = await loopbackRequest(runtime.app);
    expect((await client.get("/api/portfolio").set(await ownerHeaders(runtime)).expect(200)).body.accounts).toHaveLength(2);
    const body = JSON.stringify({
      brokerageAuthorizationId: "connection-1", clientId: "commercial-client", eventTimestamp: "2026-08-19T17:00:00.000Z",
      eventType: "CONNECTION_DELETED", userId: snapTradeUserId, webhookId: "webhook-runtime-deleted-forget",
    });
    const signature = createHmac("sha256", "consumer-secret").update(body).digest("base64");
    await client.post("/webhooks/snaptrade").set("Content-Type", "application/json").set("Signature", signature).send(body).expect(204);

    w.gateway.listAccounts.mockRejectedValueOnce(new Error("synthetic outage"));
    const after = await client.get("/api/portfolio").set(await ownerHeaders(runtime));
    expect(JSON.stringify(after.body)).not.toContain("account-1");
    warn.mockRestore();
    await runtime.close();
  });

  it("forgets the cached report card on CONNECTION_DELETED, next to the cached portfolio", async () => {
    const w = liveWiring();
    const reportCards = { get: vi.fn(), forget: vi.fn(), size: vi.fn(() => 0) };
    const runtime = createPortfolioRuntime(controlsConfig, {
      prisma: w.prisma, dataControlPrisma: w.dataControlPrisma, portfolioStatePrisma: w.portfolioStatePrisma, snapTradeGateway: w.gateway,
      now: () => new Date("2026-08-19T17:03:00.000Z"),
      reportCards,
    } as never);
    const client = await loopbackRequest(runtime.app);
    const post = async (eventType: string, webhookId: string) => {
      const body = JSON.stringify({
        brokerageAuthorizationId: "connection-1", clientId: "commercial-client", eventTimestamp: "2026-08-19T17:00:00.000Z",
        eventType, userId: snapTradeUserId, webhookId,
      });
      const signature = createHmac("sha256", "consumer-secret").update(body).digest("base64");
      await client.post("/webhooks/snaptrade").set("Content-Type", "application/json").set("Signature", signature).send(body).expect(204);
    };
    await post("CONNECTION_DELETED", "webhook-runtime-deleted-report");
    expect(reportCards.forget).toHaveBeenCalledWith(subject);
    await runtime.close();
  });

});

describe("createPortfolioRuntime widgets wiring", () => {
  function overviewOptions() {
    return {
      prisma: prismaPort(),
      snapTradeGateway: snapTradeGateway(),
      widgetAssets: { html: () => "<!doctype html><title>overview</title>" },
      market: { history: vi.fn(async () => null), securityHistory: vi.fn(async () => null), usdCad: vi.fn(async () => null), quotes: vi.fn(async () => new Map()), purgeExpiredCache: vi.fn(async () => 0) },
      settingsPrisma: { appUser: { findIdByAuthSubject: vi.fn(async () => null) }, portfolioSettings: { findUnique: vi.fn(async () => null), upsert: vi.fn() } },
      dailyValuePrisma: { appUser: { findMany: vi.fn(async () => []) }, dailyValue: { upsert: vi.fn(), findMany: vi.fn(async () => []) } },
    };
  }
  async function listTools(app: Parameters<typeof loopbackRequest>[0]) {
    const response = await (await loopbackRequest(app)).post("/mcp").set("Authorization", `Bearer ${await mcpBearer(config)}`)
      .set("Accept", "application/json, text/event-stream").send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }).expect(200);
    return response.body.result.tools as Array<{ name: string; _meta?: { ui?: { resourceUri?: string } } }>;
  }
  it("binds show_portfolio to the hashed overview URI in normal mode", async () => {
    const runtime = createPortfolioRuntime(config, overviewOptions() as never);
    const tools = await listTools(runtime.app);
    expect(tools.find((t) => t.name === "show_portfolio")?._meta?.ui?.resourceUri).toBe(widgetUri("overview", "<!doctype html><title>overview</title>"));
    expect(tools.map((t) => t.name)).toContain("get_overview_series");
    await runtime.close();
  });
  it("always binds every wired show tool to its loader URI and serves each widget's own build", async () => {
    const built = (name: string) => `<!doctype html><head><script type="module" crossorigin>console.log(${JSON.stringify(name)})</script><style rel="stylesheet" crossorigin>.${name}{}</style></head><body></body>`;
    const runtime = createPortfolioRuntime(config, { ...overviewOptions(), widgetAssets: { html: built } } as never);
    const tools = await listTools(runtime.app);
    const origin = new URL(config.appBaseUrl).origin;
    const loaderUris = new Set(LOADER_WIDGETS.map((name) => widgetLoaderUri(name, widgetLoaderHtml(name, origin))));
    const rendering = tools.filter((t) => t._meta?.ui?.resourceUri);
    expect(rendering.map((t) => t.name)).toEqual(expect.arrayContaining(["show_portfolio", "show_holdings"]));
    for (const tool of rendering) expect(loaderUris.has(tool._meta!.ui!.resourceUri!), tool.name).toBe(true);
    expect(tools.find((t) => t.name === "show_portfolio")?._meta?.ui?.resourceUri).toBe(widgetLoaderUri("overview", widgetLoaderHtml("overview", origin)));
    const client = await loopbackRequest(runtime.app);
    for (const name of LOADER_WIDGETS) {
      expect((await client.get(`/widgets/${name}.js`).expect(200)).text, name).toBe(`console.log(${JSON.stringify(name)})`);
      expect((await client.get(`/widgets/${name}.css`).expect(200)).text, name).toBe(`.${name}{}`);
    }
    await runtime.close();
  });
  it("serves each widget's scripts with cache headers (cached loaders keep working)", async () => {
    const built = '<!doctype html><head><script type="module" crossorigin>console.log(1)</script><style rel="stylesheet" crossorigin>a{}</style></head><body></body>';
    const runtime = createPortfolioRuntime(config, { ...overviewOptions(), widgetAssets: { html: () => built } } as never);
    const client = await loopbackRequest(runtime.app);
    const js = await client.get("/widgets/holdings.js").expect(200);
    expect(js.text).toBe("console.log(1)");
    expect(js.headers["cache-control"]).toBe("no-cache");
    expect(js.headers["access-control-allow-origin"]).toBe("*");
    expect(js.headers["x-content-type-options"]).toBe("nosniff");
    expect((await client.get("/widgets/holdings.js").set("If-None-Match", js.headers.etag)).status).toBe(304);
    expect((await client.get("/widgets/unknown.js")).status).toBe(404);
    await runtime.close();
  });
});

describe("createPortfolioRuntime history wiring", () => {
  const subject = OWNER_SUBJECT;
  const snapTradeUserId = "portfolio_00000000-0000-4000-8000-0000000000c1";
  const historyConfig: SelfHostConfig = { ...config, webhooksEnabled: true, snapTrade: { clientId: "commercial-client", consumerKey: "consumer-secret" } };

  function historyPrisma() {
    return {
      appUser: { findUnique: vi.fn(async () => ({ id: "synthetic-app-user" })) },
      activity: { upsert: vi.fn(), findMany: vi.fn(async () => []) },
      activitySyncState: { findUnique: vi.fn(async () => null), upsert: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })), findMany: vi.fn(async () => []) },
      accountHistoryQuality: { upsert: vi.fn(), findMany: vi.fn(async () => []) },
      dailyValue: { findMany: vi.fn(async () => []), createMany: vi.fn(), deleteMany: vi.fn() },
    };
  }

  function options(history = historyPrisma()) {
    const prisma = prismaPort();
    prisma.appUser.findUnique.mockImplementation((async () => ({
      id: "synthetic-app-user", authSubject: subject,
    })) as never);
    prisma.webhookEvent.create.mockImplementation((async () => ({ id: "synthetic-event" })) as never);
    const gateway = snapTradeGateway();
    gateway.listAccounts.mockResolvedValue([]);
    return {
      history,
      value: {
        prisma, snapTradeGateway: gateway, historyPrisma: history,
        advisoryLock: async (_name: string, fn: () => Promise<void>) => { await fn(); return true; },
        widgetAssets: { html: () => "<!doctype html><title>overview</title>" },
        market: { history: vi.fn(async () => null), securityHistory: vi.fn(async () => null), usdCad: vi.fn(async () => null), quotes: vi.fn(async () => new Map()), purgeExpiredCache: vi.fn(async () => 0) },
        settingsPrisma: { appUser: { findIdByAuthSubject: vi.fn(async () => null) }, portfolioSettings: { findUnique: vi.fn(async () => null), upsert: vi.fn() } },
        dailyValuePrisma: { appUser: { findMany: vi.fn(async () => []) }, dailyValue: { upsert: vi.fn(), findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) } },
      },
    };
  }

  async function postSnapshots(runtime: Parameters<typeof runNightlyJob>[0]) {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runNightlyJob(runtime);
      return { status: 204, logs: warn.mock.calls.map((c) => String(c[0])) };
    } finally {
      warn.mockRestore();
    }
  }

  function sendWebhook(app: Parameters<typeof loopbackRequest>[0], eventType: string) {
    const body = { accountId: "account-1", clientId: "commercial-client", eventTimestamp: "2026-08-19T17:00:00.000Z", eventType, userId: snapTradeUserId, webhookId: `webhook-${eventType}` };
    const signature = createHmac("sha256", "consumer-secret").update(JSON.stringify(body)).digest("base64");
    return loopbackRequest(app).then((client) => client.post("/webhooks/snaptrade").set("Content-Type", "application/json")
      .set("Signature", signature).send(JSON.stringify(body)));
  }

  it("composes the nightly and history-catchup jobs only when a job lock exists", async () => {
    const { value } = options();
    const { advisoryLock, ...withoutLock } = value;
    const bare = createPortfolioRuntime(historyConfig, withoutLock as never);
    expect(bare.jobs).toEqual([]);
    await (await loopbackRequest(bare.app)).post("/api/refresh").set(await ownerHeaders(bare)).expect(404);
    await bare.close();
    const runtime = createPortfolioRuntime(historyConfig, { ...value, now: () => new Date("2026-08-19T17:03:00.000Z") } as never);
    expect(runtime.jobs.map((j) => ({ name: j.name, spec: j.spec }))).toEqual([
      { name: "nightly", spec: { kind: "daily", hour: 17, minute: 30, weekdaysOnly: true } },
      { name: "history-catchup", spec: { kind: "every", minutes: 10 } },
    ]);
    await runtime.close();
  });

  it("normal mode runs the composed nightly pipeline from the scheduled job", async () => {
    const { value } = options();
    const runtime = createPortfolioRuntime(historyConfig, { ...value, now: () => new Date("2026-08-19T17:03:00.000Z") } as never);
    const result = await postSnapshots(runtime);
    expect(result.status).toBe(204);
    expect(result.logs.some((l) => l.includes('"event":"nightly_pipeline"'))).toBe(true);
    expect(result.logs.some((l) => l.includes('"event":"daily_snapshots"'))).toBe(false);
    await runtime.close();
  });

  describe("TFSA room alert composition", () => {
    async function roomOptions() {
      const { MemoryFactRepository } = await import("./testing/memory-fact-repository.js");
      const { MemoryRoomAlertPrisma } = await import("./testing/memory-room-alert-prisma.js");
      const { value } = options();
      const { MemoryNudgePrisma } = await import("./testing/memory-nudge-prisma.js");
      const alertPrisma = new MemoryRoomAlertPrisma();
      const nudgePrisma = new MemoryNudgePrisma();
      const links = { accountsHoldingSecurity: async () => [], tfsaAccounts: async () => [], accountIds: async () => [], activityDedupeKeys: async () => [] };
      const roomPrisma = { brokerageAccount: { findMany: async () => [] }, activity: { findMany: async () => [] }, activitySyncState: { findMany: async () => [] } };
      const roomNode = { type: "tax_year" as const, key: "2026:tfsa" };
      const reserved = {
        node: roomNode, property: "tax_year.cra_room_jan1", value: { amountCad: 5000 }, text: "Synthetic.", kind: "fact" as const, provenance: "stated" as const,
      };
      return {
        alertPrisma, nudgePrisma, reserved,
        value: {
          ...value, memoryRepository: new MemoryFactRepository(), memoryLinks: links, roomPrisma, roomAlertPrisma: alertPrisma, nudgePrisma,
          now: () => new Date("2026-08-19T17:03:00.000Z"),
        },
      };
    }
    /** The nightly pipeline logs its room step through console.info; the route's own summary uses warn. */
    async function nightlyLogs(runtime: Parameters<typeof runNightlyJob>[0]) {
      const lines: string[] = [];
      const spies = (["info", "warn"] as const).map((level) => vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); }));
      try {
        await runNightlyJob(runtime);
        return { status: 204, logs: lines };
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }
    const toolNames = async (app: Parameters<typeof loopbackRequest>[0]) => {
      const response = await (await loopbackRequest(app)).post("/mcp").set("Authorization", `Bearer ${await mcpBearer(config)}`)
        .set("Accept", "application/json, text/event-stream").send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      return response.status === 200 ? (response.body.result.tools as Array<{ name: string }>).map((t) => t.name) : [];
    };

    it("normal mode composes the alert service, the nightly step and the memory hook", async () => {
      const { value, alertPrisma, reserved } = await roomOptions();
      const runtime = createPortfolioRuntime(historyConfig, value as never);
      expect(await toolNames(runtime.app)).toContain("get_portfolio_alerts");
      const result = await nightlyLogs(runtime);
      expect(result.status).toBe(204);
      expect(result.logs.some((l) => l.includes('"event":"room_alerts"'))).toBe(true);
      // The nudge step runs after the room step, counts only.
      expect(result.logs.some((l) => l.includes('"event":"portfolio_nudges"'))).toBe(true);
      const reads = vi.spyOn(alertPrisma.contributionRoomAlert, "findUnique");
      await runtime.memory!.remember(subject, reserved, undefined, "system");
      expect(reads).toHaveBeenCalled();
      await runtime.close();
    });

    it("a real nightly run raises a nudge from the accounts its snapshot read, and the alerts tool states it", async () => {
      const { value, nudgePrisma } = await roomOptions();
      const gateway = value.snapTradeGateway;
      gateway.listAccounts.mockResolvedValue([{ id: "account-1" }]);
      gateway.getAccountDetails.mockResolvedValue({
        id: "account-1", brokerage_authorization: "connection-1", name: "Synthetic TFSA",
        number: inventedAccountNumber("runtime-nudge-account"), institution_name: "Synthetic brokerage", raw_type: "TFSA",
        account_category: "SYNTHETIC", status: "open", is_paper: true,
        balance: { total: { amount: 1000, currency: "CAD" } },
        sync_status: { holdings: { initial_sync_completed: true, last_successful_sync: "2026-08-19T16:00:00Z", holdings_unavailable: false } },
      });
      gateway.getBalances.mockResolvedValue([]);
      gateway.getPositions.mockResolvedValue({ results: [{ instrument: { id: "i-synx", kind: "stock", symbol: "SYNX" }, units: 10, price: 100, cost_basis: null, currency: "CAD" }], data_freshness: { as_of: "2026-08-19T16:00:00Z" } });
      value.dailyValuePrisma.appUser.findMany.mockResolvedValue([{ id: "synthetic-app-user", authSubject: subject }] as never);
      const runtime = createPortfolioRuntime(historyConfig, value as never);
      await runtime.memory!.remember(subject, {
        node: { type: "rule", key: "single-holding-any" }, property: "rule.concentration_limit", value: { kind: "single_holding", maxPct: 10 },
        text: "Synthetic limit.", kind: "plan", provenance: "stated",
      } as never, undefined, "system");
      const result = await nightlyLogs(runtime);
      expect(result.status).toBe(204);
      expect(result.logs.some((l) => l.includes('"event":"portfolio_nudges"') && l.includes('"raised":1'))).toBe(true);
      expect(nudgePrisma.rows.map((r) => [r.subject, r.kind, r.text, r.clearedAt])).toEqual([
        [subject, "limit", "SYNX is 100% of your portfolio, over your 10% limit.", null],
      ]);
      await runtime.close();
    });

  });

  it("normal mode hands activity qualities to the overview", async () => {
    const { value, history } = options();
    const runtime = createPortfolioRuntime(historyConfig, { ...value, now: () => new Date("2026-08-19T17:03:00.000Z") } as never);
    const gateway = value.snapTradeGateway;
    gateway.listAccounts.mockResolvedValue([{ id: "account-1" }]);
    gateway.getAccountDetails.mockResolvedValue({
      id: "account-1", brokerage_authorization: "connection-1", name: "Synthetic TFSA",
      number: inventedAccountNumber("runtime-history-account"), institution_name: "Synthetic brokerage", raw_type: "TFSA",
      account_category: "SYNTHETIC", status: "open", is_paper: true,
      balance: { total: { amount: 10, currency: "CAD" } },
      sync_status: { holdings: { initial_sync_completed: true, last_successful_sync: "2026-08-19T16:00:00Z", holdings_unavailable: false } },
    });
    gateway.getBalances.mockResolvedValue([]);
    gateway.getPositions.mockResolvedValue({ results: [] });
    await (await loopbackRequest(runtime.app)).post("/mcp").set("Authorization", `Bearer ${await mcpBearer(config)}`)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "show_portfolio", arguments: {} } }).expect(200);
    expect(history.accountHistoryQuality.findMany).toHaveBeenCalled();
    await runtime.close();
  });

  it("composes the performance, activity and holdings tools", async () => {
    const list = async (app: Parameters<typeof loopbackRequest>[0]) => {
      const response = await (await loopbackRequest(app)).post("/mcp").set("Authorization", `Bearer ${await mcpBearer(config)}`)
        .set("Accept", "application/json, text/event-stream").send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }).expect(200);
      return (response.body.result.tools as Array<{ name: string }>).map((t) => t.name);
    };
    const normal = options().value;
    const runtime = createPortfolioRuntime(historyConfig, { ...normal, now: () => new Date("2026-08-19T17:03:00.000Z") } as never);
    expect(await list(runtime.app)).toEqual(expect.arrayContaining(["show_performance", "get_performance", "show_activity", "get_activity_page", "get_symbol_history", "get_intraday", "show_holdings", "get_holdings", "show_allocation", "get_allocation", "show_income", "get_income"]));
    await runtime.close();
  });


  it("marks the user dirty on a history-type webhook and not on others", async () => {
    const { value, history } = options();
    const runtime = createPortfolioRuntime(historyConfig, { ...value, now: () => new Date("2026-08-19T17:03:00.000Z") } as never);
    await sendWebhook(runtime.app, "ACCOUNT_HOLDINGS_UPDATED").then((r) => expect(r.status).toBe(204));
    expect(history.activitySyncState.updateMany).toHaveBeenCalledWith({ where: { appUserId: "synthetic-app-user" }, data: { dirty: true } });
    history.activitySyncState.updateMany.mockClear();
    await sendWebhook(runtime.app, "USER_REGISTERED").then((r) => expect(r.status).toBe(204));
    expect(history.activitySyncState.updateMany).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("keeps webhook ingestion successful when marking dirty fails", async () => {
    const { value, history } = options();
    history.activitySyncState.updateMany.mockRejectedValue(new Error("db down"));
    const runtime = createPortfolioRuntime(historyConfig, { ...value, now: () => new Date("2026-08-19T17:03:00.000Z") } as never);
    await sendWebhook(runtime.app, "ACCOUNT_HOLDINGS_UPDATED").then((r) => expect(r.status).toBe(204));
    await runtime.close();
  });
  describe("news composition", () => {
    const newsConfig: SelfHostConfig = {
      ...historyConfig,
      news: { typesafeApiKey: inventedFixture("runtime-news-ts"), typesafeModel: "jev-1.13.0", marketauxApiKey: inventedFixture("runtime-news-mx"), marketauxDailyBudget: 90, edgarUserAgent: "synthetic-agent test@example.invalid" },
    };
    const NOW = new Date("2026-08-20T03:00:00.000Z");

    function newsOptions() {
      const { value } = options();
      value.dailyValuePrisma.appUser.findMany.mockResolvedValue([{ id: "synthetic-app-user", authSubject: subject }] as never);
      const gateway = value.snapTradeGateway;
      gateway.listAccounts.mockResolvedValue([{ id: "account-1" }]);
      gateway.getAccountDetails.mockResolvedValue({
        id: "account-1", brokerage_authorization: "connection-1", name: "Synthetic TFSA",
        number: inventedAccountNumber("runtime-news-account"), institution_name: "Synthetic brokerage", raw_type: "TFSA",
        account_category: "SYNTHETIC", status: "open", is_paper: true,
        balance: { total: { amount: 1234.56, currency: "USD" } },
        sync_status: { holdings: { initial_sync_completed: true, last_successful_sync: "2026-08-19T16:00:00Z", holdings_unavailable: false } },
      });
      gateway.getBalances.mockResolvedValue([]);
      gateway.getPositions.mockResolvedValue({ results: [{ instrument: { id: "i-1", kind: "stock", symbol: "ZZTEST", description: "Zz Test Synthetic Corp" }, units: 3, price: 411.52, cost_basis: 100, currency: "USD" }] });
      const urls: string[] = [];
      const jevBodies: string[] = [];
      const reply = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
      const newsFetch = vi.fn(async (url: string, init?: { body?: string }) => {
        urls.push(url);
        if (url.startsWith("https://api.typesafe.ai/")) { jevBodies.push(String(init?.body)); return reply({}); }
        if (url.startsWith("https://api.marketaux.com/")) {
          return reply({ data: [{ title: "ZZTEST synthetic headline", snippet: "synthetic snippet", source: "synthetic.example", url: "https://news.example.invalid/zztest/1", published_at: "2026-08-19T20:00:00.000000Z", entities: [{ symbol: "ZZTEST" }] }] });
        }
        return reply({});
      });
      return { value: { ...value, newsStore: new MemoryNewsStore(), newsFetch, now: () => NOW }, urls, jevBodies };
    }

    it("composes the news service when config.news is set and runs it after the nightly snapshots", async () => {
      const { value, urls } = newsOptions();
      const runtime = createPortfolioRuntime(newsConfig, value as never);
      expect(runtime.news).toBeDefined();
      const result = await postSnapshots(runtime);
      expect(result.status).toBe(204);
      const marketaux = urls.filter((u) => u.startsWith("https://api.marketaux.com/"));
      expect(marketaux.length).toBeGreaterThan(0);
      expect(marketaux[0]).toContain("symbols=ZZTEST");
      for (const u of urls) {
        expect(u).not.toContain("1234");
        expect(u).not.toContain("synthetic-app-user");
        expect(u).not.toContain("auth0");
      }
      expect(value.market.history).toHaveBeenCalledWith("ZZTEST", expect.any(String), expect.any(String));
      await runtime.close();
    });

    it("processes a READY user with no consent records", async () => {
      const { value, urls } = newsOptions();
      const runtime = createPortfolioRuntime(newsConfig, value as never);
      const result = await postSnapshots(runtime);
      expect(value.snapTradeGateway.getPositions).toHaveBeenCalledTimes(1);
      expect(urls.some((u) => u.startsWith("https://api.marketaux.com/") && u.includes("symbols=ZZTEST"))).toBe(true);
      expect(JSON.parse(result.logs.find((l) => l.includes('"event":"nightly_pipeline"'))!)).toMatchObject({ users: 1 });
      await runtime.close();
    });

    it("sends TypeSafe only the ticker, company name, article and candidates", async () => {
      const { value, jevBodies } = newsOptions();
      const logs: string[] = [];
      const info = vi.spyOn(console, "info").mockImplementation((m) => { logs.push(String(m)); });
      const runtime = createPortfolioRuntime(newsConfig, value as never);
      try {
        await postSnapshots(runtime);
      } finally {
        info.mockRestore();
      }
      expect(jevBodies.length).toBeGreaterThan(0);
      const body = JSON.parse(jevBodies[0]);
      expect(Object.keys(body.state).sort()).toEqual(["article", "candidates", "company", "ticker"]);
      expect(body.state).toMatchObject({ ticker: "ZZTEST", company: "Zz Test Synthetic Corp", article: { headline: "ZZTEST synthetic headline" } });
      for (const text of [...jevBodies, ...logs]) {
        expect(text).not.toMatch(/1234|411\.52|synthetic-app-user|auth0\||@|account-1|connection-1/);
        expect(text).not.toContain(newsConfig.news!.typesafeApiKey);
      }
      expect(Object.keys(runtime.news!).sort()).toEqual(["service", "store"]);
      // One provider positions read per user per run: the news step reuses the snapshot's read.
      expect(value.snapTradeGateway.getPositions).toHaveBeenCalledTimes(1);
      await runtime.close();
    });

    it("does not compose news without config.news", async () => {
      const plain = createPortfolioRuntime(historyConfig, newsOptions().value as never);
      expect(plain.news).toBeUndefined();
      await plain.close();
    });

    it("composes the news tools and the image route in normal mode only", async () => {
      const mcp = async (app: Parameters<typeof loopbackRequest>[0], method: string, params: object) => {
        const response = await (await loopbackRequest(app)).post("/mcp").set("Authorization", `Bearer ${await mcpBearer(config)}`)
          .set("Accept", "application/json, text/event-stream").send({ jsonrpc: "2.0", id: 1, method, params }).expect(200);
        return response.body.result;
      };
      const unknown = "/api/news/image/00000000-0000-4000-8000-000000000000";
      const runtime = createPortfolioRuntime(newsConfig, newsOptions().value as never);
      const names = ((await mcp(runtime.app, "tools/list", {})).tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["show_news", "get_news", "show_calendar", "get_calendar", "get_portfolio_alerts"]));
      const calendar = await mcp(runtime.app, "tools/call", { name: "show_calendar", arguments: {} });
      expect(calendar.isError).not.toBe(true);
      expect(calendar.structuredContent.range).toBe("1m");
      const resource = await mcp(runtime.app, "resources/read", { uri: "ui://portfolio/news-v1" });
      expect(resource.contents[0]._meta.ui.csp.resourceDomains).toEqual(["http://localhost:3004"]);
      const shown = await mcp(runtime.app, "tools/call", { name: "show_news", arguments: {} });
      expect(shown.isError).not.toBe(true);
      expect(shown.structuredContent.imageOrigin).toBe("http://localhost:3004");
      expect((await (await loopbackRequest(runtime.app)).get(unknown)).body).toEqual({ error: "not_found" });
      await runtime.close();

      const plain = createPortfolioRuntime(historyConfig, newsOptions().value as never);
      const plainNames = ((await mcp(plain.app, "tools/list", {})).tools as Array<{ name: string }>).map((t) => t.name);
      for (const n of ["show_news", "show_calendar", "get_portfolio_alerts"]) expect(plainNames).not.toContain(n);
      expect((await (await loopbackRequest(plain.app)).get(unknown)).body).not.toEqual({ error: "not_found" });
      await plain.close();
    });

    it("requires an injected news store when the database port is injected", () => {
      const { value } = newsOptions();
      expect(() => createPortfolioRuntime(newsConfig, { ...value, newsStore: undefined } as never)).toThrow(/news store/);
    });
  });
});

describe("createPortfolioRuntime gateway wiring", () => {
  const mcpConfig: SelfHostConfig = {
    ...config,
    appBaseUrl: "https://mcp.example.test",
    mcpResourceUrl: "https://mcp.example.test/mcp",
    gateway: syntheticGatewayConfig("https://mcp.example.test"),
  };

  it("always mounts the gateway, derives its issuer and resource from APP_BASE_URL and points /mcp metadata at it", async () => {
    const runtime = createPortfolioRuntime(mcpConfig, { prisma: prismaPort(), snapTradeGateway: snapTradeGateway() });
    const req = await loopbackRequest(runtime.app);
    expect((await req.get("/.well-known/oauth-authorization-server").expect(200)).body.issuer).toBe("https://mcp.example.test");
    expect((await req.get("/.well-known/oauth-protected-resource/mcp").expect(200)).body.authorization_servers)
      .toEqual(["https://mcp.example.test"]);
    expect((await req.get("/.well-known/oauth-protected-resource").expect(200)).body.authorization_servers)
      .toEqual(["https://mcp.example.test"]);
    await runtime.close();
  });

  it("mounts the login page and the local upstream ahead of the gateway, and exposes the one session store", async () => {
    const ownerSessions = runtimeStoreFixtures().ownerSessions;
    const runtime = createPortfolioRuntime(mcpConfig, { prisma: prismaPort(), snapTradeGateway: snapTradeGateway(), ownerSessions });
    expect(runtime.ownerSessions).toBe(ownerSessions);
    const req = await loopbackRequest(runtime.app);
    const login = await req.get("/login").expect(200);
    expect(login.text).toContain("Owner password");
    // Signed out, the local authorize step sends the browser to /login with itself as the way back.
    const callback = encodeURIComponent("https://mcp.example.test/oauth/upstream/callback");
    const local = `/oauth/local/authorize?state=s&nonce=n&code_challenge=${"A".repeat(43)}&redirect_uri=${callback}`;
    const res = await req.get(local).expect(302);
    expect(res.headers.location).toBe(`/login?continue=${encodeURIComponent(local)}`);
    await runtime.close();
  });

  it("sets the session cookie without Secure only for http loopback", async () => {
    const { hashOwnerPassword } = await import("./auth/owner-password.js");
    const owner = { passwordHash: await hashOwnerPassword("synthetic-owner-pass"), sessionSecret: syntheticOwnerAuth.sessionSecret };
    // Directly built configs (not loadable: loadConfig rejects http://example.test); only the cookie decision is under test.
    for (const [base, secure] of [["http://localhost:3004", false], ["http://127.0.0.1:3004", false], ["http://[::1]:3004", false], ["https://mcp.example.test", true], ["http://example.test", true]] as const) {
      const runtime = createPortfolioRuntime(
        { ...config, appBaseUrl: base, mcpResourceUrl: `${base}/mcp`, gateway: syntheticGatewayConfig(base), owner },
        { prisma: prismaPort(), snapTradeGateway: snapTradeGateway() },
      );
      const res = await (await loopbackRequest(runtime.app)).post("/login").type("form")
        .send({ password: "synthetic-owner-pass", continue: "/" }).expect(303);
      const cookie = String(res.headers["set-cookie"]);
      expect(cookie.includes("Secure"), base).toBe(secure);
      await runtime.close();
    }
  });

  it("requires a gateway store and an owner session store when the database port is injected", () => {
    expect(() => createRuntime(mcpConfig, { prisma: prismaPort(), snapTradeGateway: snapTradeGateway() }))
      .toThrow("gateway store");
    expect(() => createRuntime(mcpConfig, { prisma: prismaPort(), snapTradeGateway: snapTradeGateway(), gatewayStore: new MemoryGatewayStore() }))
      .toThrow("owner session store");
  });
});

describe("createPortfolioRuntime memory wiring", () => {
  it("composes memory", async () => {
    const { MemoryFactRepository } = await import("./testing/memory-fact-repository.js");
    const opts = () => ({ prisma: prismaPort(), snapTradeGateway: snapTradeGateway(), memoryRepository: new MemoryFactRepository() });
    const normal = createPortfolioRuntime(config, opts());
    expect(normal.memory).toBeDefined();
    await normal.close();
  });

  it("lists remember (TFSA room inputs) and get_contribution_room at /mcp in normal mode only; recall and forget are parked", async () => {
    const { MemoryFactRepository } = await import("./testing/memory-fact-repository.js");
    const links = { accountsHoldingSecurity: async () => [], tfsaAccounts: async () => [], accountIds: async () => [], activityDedupeKeys: async () => [] };
    const roomPrisma = { brokerageAccount: { findMany: async () => [] }, activity: { findMany: async () => [] }, activitySyncState: { findMany: async () => [] } };
    const opts = () => ({ prisma: prismaPort(), snapTradeGateway: snapTradeGateway(), memoryRepository: new MemoryFactRepository(), memoryLinks: links, roomPrisma });
    const NEW = ["remember", "get_contribution_room"];
    const toolNames = async (app: Parameters<typeof loopbackRequest>[0]) => {
      const response = await (await loopbackRequest(app)).post("/mcp").set("Authorization", `Bearer ${await mcpBearer(config, "portfolio:read memory")}`)
        .set("Accept", "application/json, text/event-stream").send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }).expect(200);
      return (response.body.result.tools as Array<{ name: string }>).map((t) => t.name);
    };
    const normal = createPortfolioRuntime(config, opts());
    const listed = await toolNames(normal.app);
    expect(listed.slice(-2)).toEqual(NEW);
    expect(listed).not.toContain("recall");
    expect(listed).not.toContain("forget");
    await normal.close();
  });
});

describe("createPortfolioRuntime thesis, limit and goal tools", () => {
  it("lists show_thesis and the limit tools at /mcp in normal mode (thesis logging and goals parked)", async () => {
    const { MemoryFactRepository } = await import("./testing/memory-fact-repository.js");
    const links = { accountsHoldingSecurity: async () => [], tfsaAccounts: async () => [], accountIds: async () => [], activityDedupeKeys: async () => [] };
    const empty = { findMany: async () => [] };
    const opts = () => ({
      prisma: prismaPort(), snapTradeGateway: snapTradeGateway(), memoryRepository: new MemoryFactRepository(), memoryLinks: links,
      factPrisma: { activity: empty, activitySyncState: empty, brokerageAccount: empty, portfolioSnapshot: empty } as never,
      market: { history: vi.fn(async () => null), securityHistory: vi.fn(async () => null), usdCad: vi.fn(async () => null), quotes: vi.fn(async () => new Map()), purgeExpiredCache: vi.fn(async () => 0) } as never,
      dailyValuePrisma: { appUser: { findMany: vi.fn(async () => []) }, dailyValue: { upsert: vi.fn(), findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) } } as never,
    });
    const NEW = ["show_thesis", "set_portfolio_limit", "show_limits"];
    const toolNames = async (app: Parameters<typeof loopbackRequest>[0]) => {
      const response = await (await loopbackRequest(app)).post("/mcp").set("Authorization", `Bearer ${await mcpBearer(config, "portfolio:read memory")}`)
        .set("Accept", "application/json, text/event-stream").send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }).expect(200);
      return (response.body.result.tools as Array<{ name: string }>).map((t) => t.name);
    };
    const normal = createPortfolioRuntime(config, opts());
    const listed = await toolNames(normal.app);
    // show_report_card (spec 2026-10-27) is listed after them.
    expect(listed.slice(-4)).toEqual([...NEW, "show_report_card"]);
    for (const parked of ["log_thesis", "set_savings_goal", "show_goal"]) expect(listed).not.toContain(parked);
    await normal.close();
  });
});
