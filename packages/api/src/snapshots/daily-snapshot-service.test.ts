import { describe, expect, it, vi } from "vitest";
import { miniSyntheticAccount } from "../testing/mini-synthetic-fixtures.js";
import { DailySnapshotService } from "./daily-snapshot-service.js";

function prisma() {
  const upserts: any[] = [];
  return {
    upserts,
    appUser: { findMany: vi.fn(async () => [{ id: "u-a", authSubject: "subject|synthetic-a" }, { id: "u-b", authSubject: "subject|synthetic-b" }]) },
    dailyValue: { upsert: vi.fn(async (input: any) => { upserts.push(input); }), findMany: vi.fn(async (_input?: any) => [{ date: new Date("2026-10-14T00:00:00Z"), snapTradeAccountId: "ACC-1", currency: "CAD", value: "156", source: "reported" }, { date: new Date("2026-10-13T00:00:00Z"), snapTradeAccountId: "ACC-1", currency: "CAD", value: "150", source: "reconstructed" }, { date: new Date("2026-10-12T00:00:00Z"), snapTradeAccountId: "ACC-1", currency: "CAD", value: "1", source: "bogus" }]) },
  };
}

describe("DailySnapshotService", () => {
  it("stores one reported row per account and currency for today, refreshing each user once", async () => {
    const db = prisma();
    const portfolio = { getPortfolio: vi.fn(async (subject: string) => ({ connectionRequired: false, generatedAt: "x", errors: [], accounts: subject.endsWith("a") ? [miniSyntheticAccount(0), miniSyntheticAccount(3, { unifiedType: "CREDIT_CARD" })] : [miniSyntheticAccount(1, { reported: false })] })) };
    const service = new DailySnapshotService({ prisma: db as any, portfolio: portfolio as any, now: () => new Date("2026-10-15T21:30:00Z") });
    await expect(service.captureAll()).resolves.toEqual({ users: 2, rows: 1, failures: 0 });
    expect(portfolio.getPortfolio).toHaveBeenCalledWith("subject|synthetic-a", { refresh: true });
    expect(db.upserts[0].create).toMatchObject({ appUserId: "u-a", snapTradeAccountId: "MINI-SYNTHETIC-ACCOUNT-0", currency: "CAD", value: 156, source: "reported" });
    expect(db.upserts[0].create.date.toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });
  it("uses the America/Toronto calendar date, not the UTC date", async () => {
    const db = prisma();
    const portfolio = { getPortfolio: vi.fn(async () => ({ connectionRequired: false, generatedAt: "x", errors: [], accounts: [miniSyntheticAccount(0)] })) };
    const service = new DailySnapshotService({ prisma: db as any, portfolio: portfolio as any, now: () => new Date("2026-10-16T02:00:00Z") });
    await service.captureAll();
    expect(db.upserts[0].create.date.toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });
  it("counts a failing user and continues", async () => {
    const db = prisma();
    const portfolio = { getPortfolio: vi.fn(async (s: string) => { if (s.endsWith("a")) throw new Error("synthetic outage"); return { connectionRequired: false, generatedAt: "x", errors: [], accounts: [miniSyntheticAccount(2)] }; }) };
    await expect(new DailySnapshotService({ prisma: db as any, portfolio: portfolio as any }).captureAll()).resolves.toMatchObject({ users: 2, failures: 1, rows: 1 });
  });
  it("captureFor stores rows for one user and flags stale reads as failed", async () => {
    const db = prisma();
    const portfolio = { getPortfolio: vi.fn(async (s: string) => ({ connectionRequired: false, generatedAt: "x", errors: [], ...(s.endsWith("b") ? { cache: { stale: true } } : {}), accounts: [miniSyntheticAccount(0)] })) };
    const service = new DailySnapshotService({ prisma: db as any, portfolio: portfolio as any, now: () => new Date("2026-10-15T21:30:00Z") });
    await expect(service.captureFor({ id: "u-a", authSubject: "subject|synthetic-a" })).resolves.toEqual({ rows: 1, failed: false });
    await expect(service.captureFor({ id: "u-b", authSubject: "subject|synthetic-b" })).resolves.toEqual({ rows: 0, failed: true });
  });
  it("captureFor hands back the presentation accounts it read when asked, without a second read", async () => {
    const db = prisma();
    const portfolio = { getPortfolio: vi.fn(async (s: string) => ({ connectionRequired: false, generatedAt: "x", errors: [], ...(s.endsWith("b") ? { cache: { stale: true } } : {}), accounts: [miniSyntheticAccount(0)] })) };
    const service = new DailySnapshotService({ prisma: db as any, portfolio: portfolio as any, now: () => new Date("2026-10-15T21:30:00Z") });
    const a = await service.captureFor({ id: "u-a", authSubject: "subject|synthetic-a" }, { keepAccounts: true });
    expect(a).toMatchObject({ rows: 1, failed: false });
    expect(a.accounts?.map((x) => x.id)).toEqual(["MINI-SYNTHETIC-ACCOUNT-0"]);
    const b = await service.captureFor({ id: "u-b", authSubject: "subject|synthetic-b" }, { keepAccounts: true });
    expect(b).toMatchObject({ rows: 0, failed: true });
    expect(b.accounts).toHaveLength(1); // stale holdings still name the symbols
    expect(portfolio.getPortfolio).toHaveBeenCalledTimes(2);
  });
  it("reads rows for one subject as numbers", async () => {
    const db = prisma();
    const service = new DailySnapshotService({ prisma: db as any, portfolio: { getPortfolio: vi.fn() } });
    await expect(service.rows("subject|synthetic-a", "2026-10-01")).resolves.toEqual([{ date: "2026-10-14", accountId: "ACC-1", currency: "CAD", value: 156, source: "reported" }, { date: "2026-10-13", accountId: "ACC-1", currency: "CAD", value: 150, source: "reconstructed" }]);
    expect(db.dailyValue.findMany.mock.calls[0][0].where.appUser).toEqual({ authSubject: "subject|synthetic-a" });
  });
  it("finds the earliest row date for one currency with a single ordered lookup", async () => {
    const db = prisma() as any;
    db.dailyValue.findFirst = vi.fn(async () => ({ date: new Date("2024-03-04T00:00:00Z") }));
    const service = new DailySnapshotService({ prisma: db, portfolio: { getPortfolio: vi.fn() } });
    await expect(service.earliest("subject|synthetic-a", "CAD")).resolves.toBe("2024-03-04");
    expect(db.dailyValue.findFirst).toHaveBeenCalledWith({ where: { appUser: { authSubject: "subject|synthetic-a" }, currency: "CAD" }, orderBy: { date: "asc" }, select: { date: true } });
    db.dailyValue.findFirst = vi.fn(async () => null);
    await expect(service.earliest("subject|synthetic-a", "CAD")).resolves.toBeNull();
  });
  it("skips a user whose read is stale or partial and counts it as a failure", async () => {
    const db = prisma();
    const portfolio = { getPortfolio: vi.fn(async (s: string) => s.endsWith("a")
      ? { connectionRequired: false, generatedAt: "x", errors: [], accounts: [miniSyntheticAccount(0)], cache: { source: "last_good", loadedAt: "2026-10-14T21:30:00.000Z", stale: true, staleReason: "provider_unavailable" } }
      : { connectionRequired: false, generatedAt: "x", errors: [{ accountId: "MINI-SYNTHETIC-ACCOUNT-5", code: "account_data_unavailable" }], accounts: [miniSyntheticAccount(2)] }) };
    const service = new DailySnapshotService({ prisma: db as any, portfolio: portfolio as any, now: () => new Date("2026-10-15T21:30:00Z") });
    await expect(service.captureAll()).resolves.toEqual({ users: 2, rows: 0, failures: 2 });
    expect(db.upserts).toEqual([]);
  });
  it("skips an account whose reported value is not finite", async () => {
    const db = prisma();
    const bad = miniSyntheticAccount(1);
    bad.account.reportedTotal = { currency: "CAD", amount: Number.NaN };
    const portfolio = { getPortfolio: vi.fn(async () => ({ connectionRequired: false, generatedAt: "x", errors: [], accounts: [miniSyntheticAccount(0), bad] })) };
    db.appUser.findMany = vi.fn(async () => [{ id: "u-a", authSubject: "subject|synthetic-a" }]);
    const service = new DailySnapshotService({ prisma: db as any, portfolio: portfolio as any, now: () => new Date("2026-10-15T21:30:00Z") });
    await expect(service.captureAll()).resolves.toEqual({ users: 1, rows: 1, failures: 0 });
    expect(db.upserts.map((u) => u.create.snapTradeAccountId)).toEqual(["MINI-SYNTHETIC-ACCOUNT-0"]);
  });
});
