import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { PrismaDataControlRepository, type DataControlTransaction } from "./prisma-data-control-repository.js";

const appUserId = "8a2e4c6f-1b3d-4e5f-9a7b-0c2d4e6f8a1b";
const now = new Date("2026-10-23T08:00:00.000Z");

function client(accounts: string[] = ["invented-account-1", "invented-account-2"]) {
  const calls: string[] = [];
  const count = (name: string, n = 1) => vi.fn(async () => { calls.push(name); return { count: n }; });
  const tx = {
    brokerageAccount: { findMany: vi.fn(async () => { calls.push("accounts"); return accounts.map((snapTradeAccountId) => ({ snapTradeAccountId })); }) },
    brokerageConnection: { deleteMany: count("connection") },
    portfolioSnapshot: { deleteMany: count("snapshots", 4) },
    activity: { deleteMany: count("activities") },
    activitySyncState: { deleteMany: count("syncState") },
    accountHistoryQuality: { deleteMany: count("quality") },
    dailyValue: { deleteMany: count("dailyValues") },
    webhookEvent: { deleteMany: count("webhooks", 2) },
    pendingDisconnect: {
      findUnique: vi.fn(async (_input: unknown): Promise<{ snapTradeAccountIds: string[] } | null> => { calls.push("readPending"); return null; }),
      upsert: vi.fn(async (_input: unknown) => { calls.push("markPending"); return {}; }),
      deleteMany: count("clearPending"),
    },
  } satisfies DataControlTransaction;
  const prisma = {
    appUser: {
      findUnique: vi.fn(async (_input: unknown): Promise<{ id: string } | null> => ({ id: appUserId })),
    },
    webhookEvent: { deleteMany: vi.fn(async () => ({ count: 3 })) },
    brokerageConnection: { findFirst: vi.fn(async (_input: unknown): Promise<{ id: string } | null> => ({ id: "stored-connection" })) },
    pendingDisconnect: {
      count: vi.fn(async (_input: unknown) => 3),
      findUnique: vi.fn(async (_input: unknown): Promise<{ id: string } | null> => null),
      findMany: vi.fn(async (_input: unknown): Promise<Array<{ snapTradeConnectionId: string; [key: string]: unknown }>> => [{ snapTradeConnectionId: "connection-gone" }]),
    },
    mcpOAuthClientRevocation: { deleteMany: vi.fn(async (_input: unknown) => ({ count: 0 })) },
    $executeRaw: vi.fn(async (..._args: unknown[]) => 7),
    async $transaction<T>(fn: (t: DataControlTransaction) => Promise<T>): Promise<T> { calls.push("begin"); const r = await fn(tx); calls.push("commit"); return r; },
  };
  return { prisma, tx, calls };
}

/** An in-memory model of the subject-wide ("*") revocation markers the nightly sweep ages out. */
function revocationTables() {
  const revocations: Array<{ subject: string; clientKey: string; revokedAt: Date }> = [];
  const prisma = {
    ...client().prisma,
    mcpOAuthClientRevocation: {
      deleteMany: vi.fn(async ({ where }: { where: { clientKey: string; revokedAt: { lt: Date } } }) => {
        const before = revocations.length;
        const kept = revocations.filter((r) => !(r.clientKey === where.clientKey && r.revokedAt.getTime() < where.revokedAt.lt.getTime()));
        revocations.splice(0, revocations.length, ...kept);
        return { count: before - kept.length };
      }),
    },
  };
  return { prisma, revocations };
}

describe("PrismaDataControlRepository", () => {
  it("finds the app user for a subject, and the owner's id for a webhook", async () => {
    const { prisma } = client();
    const repository = new PrismaDataControlRepository(prisma, () => now);

    await expect(repository.findUser("subject|invented")).resolves.toEqual({ appUserId });
    expect(prisma.appUser.findUnique).toHaveBeenCalledWith({ where: { authSubject: "subject|invented" }, select: { id: true } });

    await expect(repository.findOwnerAppUserId()).resolves.toBe(appUserId);
    expect(prisma.appUser.findUnique).toHaveBeenLastCalledWith({ where: { authSubject: "owner" }, select: { id: true } });

    prisma.appUser.findUnique.mockResolvedValueOnce(null);
    await expect(repository.findUser("subject|unknown")).resolves.toBeNull();
    prisma.appUser.findUnique.mockResolvedValueOnce(null);
    await expect(repository.findOwnerAppUserId()).resolves.toBeNull();
  });

  it("purges one connection inside a transaction, scoped to the owner and its accounts", async () => {
    const { prisma, tx, calls } = client();
    const repository = new PrismaDataControlRepository(prisma, () => now);

    await expect(repository.purgeConnection({ appUserId }, "invented-connection")).resolves.toEqual({ accounts: 2, snapshots: 4, webhookEvents: 2 });

    const scope = { appUserId, snapTradeAccountId: { in: ["invented-account-1", "invented-account-2"] } };
    expect(tx.brokerageAccount.findMany).toHaveBeenCalledWith({
      where: { appUserId, connection: { snapTradeConnectionId: "invented-connection" } },
      select: { snapTradeAccountId: true },
    });
    for (const table of [tx.portfolioSnapshot, tx.activity, tx.activitySyncState, tx.accountHistoryQuality, tx.dailyValue]) {
      expect(table.deleteMany).toHaveBeenCalledWith({ where: scope });
    }
    expect(tx.brokerageConnection.deleteMany).toHaveBeenCalledWith({ where: { appUserId, snapTradeConnectionId: "invented-connection" } });
    expect(tx.webhookEvent.deleteMany).toHaveBeenCalledWith({
      where: {
        appUserId,
        payload: { path: ["brokerageAuthorizationId"], equals: "invented-connection" },
      },
    });
    expect(calls[0]).toBe("begin");
    expect(calls.at(-1)).toBe("commit");
  });

  it("skips per-account deletes for a connection with no stored accounts and can keep receipts", async () => {
    const { prisma, tx } = client([]);
    const repository = new PrismaDataControlRepository(prisma, () => now);

    await expect(repository.purgeConnection({ appUserId }, "invented-connection", { keepWebhookReceipts: true }))
      .resolves.toEqual({ accounts: 0, snapshots: 0, webhookEvents: 0 });
    expect(tx.portfolioSnapshot.deleteMany).not.toHaveBeenCalled();
    expect(tx.dailyValue.deleteMany).not.toHaveBeenCalled();
    expect(tx.brokerageConnection.deleteMany).toHaveBeenCalledOnce();
    expect(tx.webhookEvent.deleteMany).not.toHaveBeenCalled();
  });

  it("sweeps subject-wide revocation markers older than the cutoff, and only those", async () => {
    const tables = revocationTables();
    const repository = new PrismaDataControlRepository(tables.prisma, () => now);
    tables.revocations.push(
      { subject: "subject|a", clientKey: "*", revokedAt: new Date("2026-10-23T05:00:00.000Z") },
      { subject: "subject|b", clientKey: "*", revokedAt: new Date("2026-10-23T07:30:00.000Z") },
      { subject: "subject|c", clientKey: "https://client.example.test/meta.json", revokedAt: new Date("2026-10-23T05:00:00.000Z") },
    );

    await expect(repository.purgeSubjectRevocations(new Date("2026-10-23T06:00:00.000Z"))).resolves.toBe(1);
    expect(tables.revocations.map((r) => r.subject)).toEqual(["subject|b", "subject|c"]);
  });

  it("purges expired receipts by timestamp and expired snapshots except the newest of each existing account", async () => {
    const { prisma } = client();
    const snapshotsBefore = new Date("2026-07-25T00:00:00.000Z");
    const webhookEventsBefore = new Date("2026-09-23T00:00:00.000Z");

    await expect(new PrismaDataControlRepository(prisma, () => now).purgeExpired({ snapshotsBefore, webhookEventsBefore }))
      .resolves.toEqual({ snapshots: 7, webhookEvents: 3 });
    const [strings, ...values] = prisma.$executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join("?").replace(/\s+/g, " ");
    expect(values).toEqual([snapshotsBefore]);
    expect(sql).toContain('DELETE FROM "PortfolioSnapshot" AS s WHERE s."capturedAt" < ?');
    // Keeps the newest snapshot of every account that still exists; older ones and orphans go.
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "BrokerageAccount" AS a WHERE a."appUserId" = s."appUserId" AND a."snapTradeAccountId" = s."snapTradeAccountId")');
    expect(sql).toContain('EXISTS (SELECT 1 FROM "PortfolioSnapshot" AS n WHERE n."appUserId" = s."appUserId" AND n."snapTradeAccountId" = s."snapTradeAccountId" AND (n."capturedAt" > s."capturedAt" OR (n."capturedAt" = s."capturedAt" AND n."id" > s."id")))');
    expect(prisma.webhookEvent.deleteMany).toHaveBeenCalledWith({ where: { receivedAt: { lt: webhookEventsBefore } } });
  });

  it("records the pending-disconnect marker in the same transaction as the purge", async () => {
    const { prisma, tx, calls } = client();
    await new PrismaDataControlRepository(prisma, () => now).purgeConnection({ appUserId }, "invented-connection", { pending: "mark" });

    // The purged account ids are kept on the marker so the sweep can still find stray rows.
    const accountIds = ["invented-account-1", "invented-account-2"];
    expect(tx.pendingDisconnect.upsert).toHaveBeenCalledWith({
      where: { appUserId_snapTradeConnectionId: { appUserId, snapTradeConnectionId: "invented-connection" } },
      create: { appUserId, snapTradeConnectionId: "invented-connection", requestedAt: now, snapTradeAccountIds: accountIds },
      update: { snapTradeAccountIds: accountIds },
    });
    expect(calls.slice(0, 4)).toEqual(["begin", "readPending", "accounts", "markPending"]);
    expect(calls.at(-1)).toBe("commit");
    expect(tx.pendingDisconnect.deleteMany).not.toHaveBeenCalled();
  });

  it("marks a provider-confirmed removal as confirmed straight away", async () => {
    const { prisma, tx } = client();
    await new PrismaDataControlRepository(prisma, () => now).purgeConnection({ appUserId }, "invented-connection", { pending: "mark_confirmed" });

    expect(tx.pendingDisconnect.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ confirmedAt: now }),
      update: expect.objectContaining({ confirmedAt: now }),
    }));
  });

  it("re-purges activity and sync state by the marker's account ids once the account rows are gone", async () => {
    const { prisma, tx } = client([]);
    tx.pendingDisconnect.findUnique.mockResolvedValueOnce({ snapTradeAccountIds: ["invented-account-gone"] });

    await expect(new PrismaDataControlRepository(prisma, () => now).purgeConnection({ appUserId }, "invented-connection", { keepWebhookReceipts: true }))
      .resolves.toMatchObject({ accounts: 1 });
    const scope = { appUserId, snapTradeAccountId: { in: ["invented-account-gone"] } };
    for (const table of [tx.activity, tx.activitySyncState, tx.portfolioSnapshot, tx.accountHistoryQuality, tx.dailyValue]) {
      expect(table.deleteMany).toHaveBeenCalledWith({ where: scope });
    }
    expect(tx.pendingDisconnect.findUnique).toHaveBeenCalledWith({
      where: { appUserId_snapTradeConnectionId: { appUserId, snapTradeConnectionId: "invented-connection" } },
      select: { snapTradeAccountIds: true },
    });
  });

  it("reports whether the caller has the connection locally and how many markers they hold", async () => {
    const { prisma } = client();
    const repository = new PrismaDataControlRepository(prisma, () => now);

    await expect(repository.connectionState(appUserId, "invented-connection")).resolves.toEqual({ stored: true, pending: false, pendingCount: 3 });
    expect(prisma.brokerageConnection.findFirst).toHaveBeenCalledWith({ where: { appUserId, snapTradeConnectionId: "invented-connection" }, select: { id: true } });
    expect(prisma.pendingDisconnect.count).toHaveBeenCalledWith({ where: { appUserId } });

    prisma.brokerageConnection.findFirst.mockResolvedValueOnce(null);
    prisma.pendingDisconnect.findUnique.mockResolvedValueOnce({ id: "marker" });
    await expect(repository.connectionState(appUserId, "invented-connection")).resolves.toEqual({ stored: false, pending: true, pendingCount: 3 });
  });

  it("clears the marker only together with a successful purge", async () => {
    const { prisma, tx, calls } = client();
    await new PrismaDataControlRepository(prisma, () => now).purgeConnection({ appUserId }, "invented-connection", { pending: "clear", keepWebhookReceipts: true });

    expect(tx.pendingDisconnect.deleteMany).toHaveBeenCalledWith({ where: { appUserId, snapTradeConnectionId: "invented-connection" } });
    expect(calls.at(-2)).toBe("clearPending");
    expect(tx.pendingDisconnect.upsert).not.toHaveBeenCalled();
  });

  it("looks up the owner's disconnected authorization ids", async () => {
    const { prisma } = client();
    await expect(new PrismaDataControlRepository(prisma, () => now).disconnectedConnectionIds())
      .resolves.toEqual(new Set(["connection-gone"]));
    expect(prisma.pendingDisconnect.findMany).toHaveBeenCalledWith({
      where: { appUser: { authSubject: "owner" } },
      select: { snapTradeConnectionId: true },
    });
  });

  it("lists confirmed markers before unconfirmed ones, each class bounded separately", async () => {
    const { prisma } = client();
    const earlier = new Date("2026-09-01T00:00:00.000Z");
    prisma.pendingDisconnect.findMany
      .mockResolvedValueOnce([{ appUserId, snapTradeConnectionId: "connection-a", confirmedAt: now, requestedAt: earlier }])
      .mockResolvedValueOnce([{ appUserId, snapTradeConnectionId: "connection-b", confirmedAt: null, requestedAt: earlier }]);
    await expect(new PrismaDataControlRepository(prisma, () => now).pendingDisconnects()).resolves.toEqual([
      { user: { appUserId }, snapTradeConnectionId: "connection-a", confirmed: true, requestedAt: earlier },
      { user: { appUserId }, snapTradeConnectionId: "connection-b", confirmed: false, requestedAt: earlier },
    ]);
    const select = { appUserId: true, snapTradeConnectionId: true, confirmedAt: true, requestedAt: true };
    expect(prisma.pendingDisconnect.findMany).toHaveBeenNthCalledWith(1, { where: { confirmedAt: { not: null } }, select, orderBy: { requestedAt: "asc" }, take: 250 });
    expect(prisma.pendingDisconnect.findMany).toHaveBeenNthCalledWith(2, { where: { confirmedAt: null }, select, orderBy: { requestedAt: "asc" }, take: 250 });
  });
});

describe("PendingDisconnect schema and migration", () => {
  const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../../prisma/migrations/0001_baseline/migration.sql", import.meta.url), "utf8");

  it("holds ids and timestamps only, unique per user and authorization, and goes with the user", () => {
    const model = /model PendingDisconnect \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
    const fields = [...model.matchAll(/^\s+(\w+)\s+\S/gm)].map((m) => m[1]).filter((f) => !f.startsWith("@@"));
    expect(fields).toEqual(["id", "appUserId", "appUser", "snapTradeConnectionId", "snapTradeAccountIds", "requestedAt", "confirmedAt"]);
    expect(model).toContain("onDelete: Cascade");
    expect(model).toContain("@@unique([appUserId, snapTradeConnectionId])");
    expect(migration).toContain('CREATE TABLE "PendingDisconnect"');
    expect(migration).toContain("ON DELETE CASCADE");
    expect(migration).toContain('"snapTradeAccountIds" VARCHAR(64)[]');
  });
});
