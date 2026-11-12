import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { ActivityStore, type ActivityStorePort } from "./activity-store.js";
import type { StoredActivity } from "./stored-activity.js";

// Compile-time check: the real PrismaClient satisfies the port.
export const _check: ActivityStorePort = null as unknown as PrismaClient;

type Row = Record<string, any>;

function fakePort() {
  const users: Row[] = [{ id: "u1", authSubject: "subject|a" }, { id: "u2", authSubject: "subject|b" }];
  const activities = new Map<string, Row>();
  const states = new Map<string, Row>();
  const quals = new Map<string, Row>();
  const k = (a: string, b: string) => `${a}|${b}`;
  const port: ActivityStorePort = {
    appUser: { findUnique: async ({ where }) => { const u = users.find((x) => x.authSubject === where.authSubject); return u ? { id: u.id } : null; } },
    activity: {
      upsert: async ({ where, create, update }) => {
        const key = k(where.appUserId_dedupeKey.appUserId, where.appUserId_dedupeKey.dedupeKey);
        const existing = activities.get(key);
        const row = existing ? { ...existing, ...update } : { ...create };
        activities.set(key, row);
        return row as any;
      },
      findMany: async ({ where }: { where: Row }) => [...activities.values()].filter((r) => {
        if (r.appUserId !== where.appUserId) return false;
        const acc = where.snapTradeAccountId;
        if (typeof acc === "string" ? r.snapTradeAccountId !== acc : !acc.in.includes(r.snapTradeAccountId)) return false;
        if (where.type && !where.type.in.includes(r.type)) return false;
        if (where.OR) {
          const inRange = (d: Date | null, c: Row) => d !== null && d >= c.gte && d <= c.lte;
          const ok = where.OR.some((c: Row) => c.tradeDate && "gte" in c.tradeDate
            ? inRange(r.tradeDate, c.tradeDate)
            : r.tradeDate === null && inRange(r.settlementDate, c.settlementDate));
          if (!ok) return false;
        }
        return true;
      }) as any,
      deleteMany: async ({ where }) => {
        let count = 0;
        for (const [key, r] of activities) {
          if (r.appUserId === where.appUserId && r.snapTradeAccountId === where.snapTradeAccountId && where.dedupeKey.in.includes(r.dedupeKey)) { activities.delete(key); count += 1; }
        }
        return { count };
      },
    },
    activitySyncState: {
      findUnique: async ({ where }) => (states.get(k(where.appUserId_snapTradeAccountId.appUserId, where.appUserId_snapTradeAccountId.snapTradeAccountId)) ?? null) as any,
      upsert: async ({ where, create, update }) => {
        const w = where.appUserId_snapTradeAccountId;
        const key = k(w.appUserId, w.snapTradeAccountId);
        const existing = states.get(key);
        const row = existing ? { ...existing, ...update } : { dirty: false, backfillCompletedAt: null, lastSyncedAt: null, ...create };
        states.set(key, row);
        return row as any;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const r of states.values()) if (r.appUserId === where.appUserId) { Object.assign(r, data); count++; }
        return { count };
      },
      findMany: async ({ where }) => [...states.values()].filter((r) => r.appUserId === where.appUserId) as any,
    },
    accountHistoryQuality: {
      upsert: async ({ where, create, update }) => {
        const w = where.appUserId_snapTradeAccountId;
        const key = k(w.appUserId, w.snapTradeAccountId);
        const row = quals.has(key) ? { ...quals.get(key), ...update } : { ...create };
        quals.set(key, row);
        return row as any;
      },
      deleteMany: async ({ where }) => {
        for (const [key, r] of quals) if (r.appUserId === where.appUserId && !where.snapTradeAccountId.notIn.includes(r.snapTradeAccountId)) quals.delete(key);
        return { count: 0 };
      },
      findMany: async ({ where }) => [...quals.values()].filter((r) => r.appUserId === where.appUserId) as any,
    },
  };
  return { port, activities, states, quals };
}

const act = (over: Partial<StoredActivity> = {}): StoredActivity => ({
  snapTradeAccountId: "acc1", dedupeKey: "k1", type: "BUY", symbol: "XEQT", securityCurrency: "CAD", isOption: false,
  units: 2, price: 10.5, amount: -21, fee: 0, fxRate: null, currency: "CAD",
  tradeDate: "2026-01-02", settlementDate: "2026-01-04", description: "d", ...over,
});

const T = new Date("2026-10-15T12:00:00.000Z");

describe("ActivityStore", () => {
  it("resolves user ids", async () => {
    const store = new ActivityStore(fakePort().port);
    expect(await store.userId("subject|a")).toBe("u1");
    expect(await store.userId("nope")).toBeNull();
  });

  it("upserts idempotently by dedupeKey and stamps syncedAt", async () => {
    const f = fakePort();
    const store = new ActivityStore(f.port, () => T);
    expect(await store.upsertActivities("u1", [act(), act({ dedupeKey: "k2" })])).toBe(2);
    expect(await store.upsertActivities("u1", [act({ price: 11 })])).toBe(1);
    expect(f.activities.size).toBe(2);
    const list = await store.listActivities("u1", "acc1");
    expect(list.find((a) => a.dedupeKey === "k1")?.price).toBe(11);
    expect([...f.activities.values()][0].syncedAt).toEqual(T);
    expect(await store.upsertActivities("u1", [])).toBe(0);
  });

  it("round-trips numbers, dates and nulls", async () => {
    const f = fakePort();
    const store = new ActivityStore(f.port, () => T);
    await store.upsertActivities("u1", [act({ fxRate: null, tradeDate: null, settlementDate: "2026-02-03" })]);
    const row = [...f.activities.values()][0];
    expect(row.settlementDate).toEqual(new Date("2026-02-03T00:00:00.000Z"));
    expect(row.tradeDate).toBeNull();
    const [out] = await store.listActivities("u1", "acc1");
    expect(out).toEqual(act({ tradeDate: null, settlementDate: "2026-02-03" }));
  });

  it("converts Decimal-like values to numbers on read", async () => {
    const f = fakePort();
    const store = new ActivityStore(f.port, () => T);
    await store.upsertActivities("u1", [act()]);
    const row = [...f.activities.values()][0];
    row.units = { toString: () => "2.5", valueOf: () => "2.5" };
    row.price = "10.25";
    const [out] = await store.listActivities("u1", "acc1");
    expect(out.units).toBe(2.5);
    expect(out.price).toBe(10.25);
  });

  it("orders by tradeDate ?? settlementDate ascending and scopes by user/account", async () => {
    const f = fakePort();
    const store = new ActivityStore(f.port, () => T);
    await store.upsertActivities("u1", [
      act({ dedupeKey: "c", tradeDate: "2026-03-01", settlementDate: null }),
      act({ dedupeKey: "a", tradeDate: "2026-01-01" }),
      act({ dedupeKey: "b", tradeDate: null, settlementDate: "2026-02-01" }),
      act({ dedupeKey: "other", snapTradeAccountId: "acc2" }),
    ]);
    await store.upsertActivities("u2", [act({ dedupeKey: "x" })]);
    expect((await store.listActivities("u1", "acc1")).map((a) => a.dedupeKey)).toEqual(["a", "b", "c"]);
  });

  it("prunes only that account's rows missing from the full read, on or after its earliest date", async () => {
    const f = fakePort();
    const store = new ActivityStore(f.port, () => T);
    await store.upsertActivities("u1", [
      act({ dedupeKey: "old-before", tradeDate: "2023-03-01" }),
      act({ dedupeKey: "cancelled", tradeDate: "2023-08-21" }),
      act({ dedupeKey: "kept", tradeDate: "2024-01-02" }),
      act({ dedupeKey: "settled-only", tradeDate: null, settlementDate: "2025-05-05" }),
      act({ dedupeKey: "other-account", snapTradeAccountId: "acc2" }),
    ]);
    await store.upsertActivities("u2", [act({ dedupeKey: "cancelled", tradeDate: "2023-08-21" })]);
    expect(await store.pruneActivities("u1", "acc1", new Set(["kept"]), "2023-04-03")).toBe(2); // the settlement-only row counts by its settlement date
    expect((await store.listActivities("u1", "acc1")).map((a) => a.dedupeKey)).toEqual(["old-before", "kept"]);
    expect(await store.listActivities("u1", "acc2")).toHaveLength(1);
    expect(await store.listActivities("u2", "acc1")).toHaveLength(1);
  });

  it("recordSync stamps lastSyncedAt and only sets backfillCompletedAt when asked, never clearing", async () => {
    const f = fakePort();
    let now = T;
    const store = new ActivityStore(f.port, () => now);
    expect(await store.syncState("u1", "acc1")).toBeNull();
    await store.recordSync("u1", "acc1", {});
    let s = await store.syncState("u1", "acc1");
    expect(s).toEqual({ backfillCompletedAt: null, lastSyncedAt: T, lastError: null, dirty: false });
    await store.recordSync("u1", "acc1", { error: "provider_error" });
    expect((await store.syncState("u1", "acc1"))?.lastError).toBe("provider_error");
    await store.recordSync("u1", "acc1", {});
    now = new Date("2026-10-16T00:00:00.000Z");
    await store.recordSync("u1", "acc1", { backfillCompleted: true, activityCount: 3, earliestTradeDate: "2025-01-05" });
    s = await store.syncState("u1", "acc1");
    expect(s?.backfillCompletedAt).toEqual(now);
    expect(f.states.get("u1|acc1")?.activityCount).toBe(3);
    expect(f.states.get("u1|acc1")?.earliestTradeDate).toEqual(new Date("2025-01-05T00:00:00.000Z"));
    const later = new Date("2026-10-17T00:00:00.000Z");
    now = later;
    await store.recordSync("u1", "acc1", { backfillCompleted: false });
    await store.recordSync("u1", "acc1", {});
    s = await store.syncState("u1", "acc1");
    expect(s?.backfillCompletedAt).toEqual(new Date("2026-10-16T00:00:00.000Z"));
    expect(s?.lastSyncedAt).toEqual(later);
  });

  it("recordSync sets and clears lastError and manages dirty", async () => {
    const f = fakePort();
    const store = new ActivityStore(f.port, () => T);
    await store.recordSync("u1", "acc1", {});
    await store.markDirty("u1");
    await store.recordSync("u1", "acc1", { error: "provider_failed" });
    expect(f.states.get("u1|acc1")?.lastError).toBe("provider_failed");
    expect(f.states.get("u1|acc1")?.dirty).toBe(true);
    await store.recordSync("u1", "acc1", { error: null });
    expect(f.states.get("u1|acc1")?.lastError).toBeNull();
    expect(f.states.get("u1|acc1")?.dirty).toBe(false);
  });

  it("markDirty marks only that user's states, and is a no-op without any", async () => {
    const f = fakePort();
    const store = new ActivityStore(f.port, () => T);
    await store.markDirty("u1");
    expect(f.states.size).toBe(0);
    await store.recordSync("u1", "acc1", {});
    await store.recordSync("u1", "acc2", {});
    await store.recordSync("u2", "acc9", {});
    await store.markDirty("u1");
    expect((await store.syncState("u1", "acc1"))?.dirty).toBe(true);
    expect((await store.syncState("u1", "acc2"))?.dirty).toBe(true);
    expect((await store.syncState("u2", "acc9"))?.dirty).toBe(false);
  });

  it("saves and reads qualities scoped to the subject", async () => {
    const f = fakePort();
    const store = new ActivityStore(f.port, () => T);
    await store.saveQuality("u1", "acc1", { method: "reconstructed", reason: null, driftFraction: 0.0123 });
    await store.saveQuality("u1", "acc2", { method: "snapshots_only", reason: "drift", driftFraction: null });
    await store.saveQuality("u2", "accB", { method: "reconstructed", reason: null, driftFraction: 0 });
    await store.saveQuality("u1", "acc1", { method: "snapshots_only", reason: "x", driftFraction: 0.5 });
    f.quals.get("u1|acc2")!.driftFraction = null;
    const q = await store.qualities("subject|a");
    expect(q).toHaveLength(2);
    const a1 = q.find((x) => x.accountId === "acc1")!;
    expect(a1).toEqual({ accountId: "acc1", method: "snapshots_only", reason: "x", driftFraction: 0.5, computedAt: T.toISOString() });
    expect(q.find((x) => x.accountId === "acc2")?.driftFraction).toBeNull();
    expect(await store.qualities("unknown")).toEqual([]);
  });

  it("saves unrecorded flows with the quality, replaces them each run, and drops an unreadable value", async () => {
    const f = fakePort();
    const store = new ActivityStore(f.port, () => T);
    await store.saveQuality("u1", "acc1", { method: "reconstructed", reason: null, driftFraction: 0, unrecordedFlows: [{ date: "2026-03-03", amount: 5000 }] });
    expect((await store.qualities("subject|a"))[0]).toMatchObject({ unrecordedFlows: [{ date: "2026-03-03", amount: 5000 }] });
    await store.saveQuality("u1", "acc1", { method: "reconstructed", reason: null, driftFraction: 0 });
    expect((await store.qualities("subject|a"))[0]).not.toHaveProperty("unrecordedFlows");
    f.quals.get("u1|acc1")!.unrecordedFlows = "{not json";
    expect((await store.qualities("subject|a"))[0]).not.toHaveProperty("unrecordedFlows");
    f.quals.get("u1|acc1")!.unrecordedFlows = JSON.stringify([{ date: "2026-03-03", amount: "x" }, { date: "2026-04-01", amount: -400 }]);
    expect((await store.qualities("subject|a"))[0].unrecordedFlows).toEqual([{ date: "2026-04-01", amount: -400 }]);
  });

  it("M6: deleteQualitiesExcept keeps only the listed accounts for that user", async () => {
    const f = fakePort();
    const store = new ActivityStore(f.port, () => T);
    await store.saveQuality("u1", "acc1", { method: "reconstructed", reason: null, driftFraction: 0 });
    await store.saveQuality("u1", "acc2", { method: "reconstructed", reason: null, driftFraction: 0 });
    await store.saveQuality("u2", "acc3", { method: "reconstructed", reason: null, driftFraction: 0 });
    await store.deleteQualitiesExcept("u1", ["acc1"]);
    expect([...f.quals.keys()].sort()).toEqual(["u1|acc1", "u2|acc3"]);
  });

  it("breaks date ties by dedupeKey and sorts undated rows last", async () => {
    const store = new ActivityStore(fakePort().port, () => T);
    const f = fakePort();
    const s2 = new ActivityStore(f.port, () => T);
    await s2.upsertActivities("u1", [
      act({ dedupeKey: "z", tradeDate: "2026-01-01" }),
      act({ dedupeKey: "m", tradeDate: null, settlementDate: null }),
      act({ dedupeKey: "b", tradeDate: "2026-01-01" }),
      act({ dedupeKey: "a", tradeDate: null, settlementDate: "2026-01-01" }),
    ]);
    expect((await s2.listActivities("u1", "acc1")).map((a) => a.dedupeKey)).toEqual(["a", "b", "z", "m"]);
    void store;
  });

  it("recordSync with no error clears lastError and dirty", async () => {
    const f = fakePort();
    const store = new ActivityStore(f.port, () => T);
    await store.recordSync("u1", "acc1", { error: "boom" });
    await store.markDirty("u1");
    await store.recordSync("u1", "acc1", {});
    expect(f.states.get("u1|acc1")?.lastError).toBeNull();
    expect(f.states.get("u1|acc1")?.dirty).toBe(false);
  });

  it("recordSync maps an empty error to unknown_error and keeps dirty", async () => {
    const f = fakePort();
    const store = new ActivityStore(f.port, () => T);
    await store.recordSync("u1", "acc1", {});
    await store.markDirty("u1");
    await store.recordSync("u1", "acc1", { error: "" });
    expect(f.states.get("u1|acc1")?.lastError).toBe("unknown_error");
    expect(f.states.get("u1|acc1")?.dirty).toBe(true);
  });

  it("keeps the same dedupeKey for two users as separate rows and shares syncedAt per batch", async () => {
    const f = fakePort();
    let n = 0;
    const store = new ActivityStore(f.port, () => new Date(T.getTime() + n++));
    await store.upsertActivities("u1", [act(), act({ dedupeKey: "k2" })]);
    await store.upsertActivities("u2", [act()]);
    expect(f.activities.size).toBe(3);
    const [a, b] = [...f.activities.values()];
    expect(a.syncedAt).toEqual(b.syncedAt);
  });

  describe("queryActivities", () => {
    const seed = async (rows: Array<Partial<StoredActivity>>) => {
      const f = fakePort();
      const store = new ActivityStore(f.port, () => T);
      await store.upsertActivities("u1", rows.map((r) => act(r)));
      return store;
    };
    const base = { accountIds: ["acc1", "acc2"], from: "2026-01-01", to: "2026-12-31" };
    const keys = (rows: StoredActivity[]) => rows.map((r) => r.dedupeKey);

    it("orders by date desc then dedupeKey desc", async () => {
      const store = await seed([
        { dedupeKey: "a", tradeDate: "2026-02-01" },
        { dedupeKey: "b", tradeDate: "2026-03-01" },
        { dedupeKey: "c", tradeDate: "2026-03-01" },
        { dedupeKey: "d", tradeDate: "2026-01-15" },
      ]);
      expect(keys(await store.queryActivities("u1", base))).toEqual(["c", "b", "a", "d"]);
    });

    it("pages with an exclusive tuple cursor across a same-date boundary", async () => {
      const store = await seed([
        { dedupeKey: "a", tradeDate: "2026-03-01" },
        { dedupeKey: "b", tradeDate: "2026-03-01" },
        { dedupeKey: "c", tradeDate: "2026-03-01" },
        { dedupeKey: "d", tradeDate: "2026-02-01" },
        { dedupeKey: "e", tradeDate: "2026-01-01" },
      ]);
      const seen: string[] = [];
      let before: { date: string; key: string } | null = null;
      for (let i = 0; i < 10; i++) {
        const page = await store.queryActivities("u1", { ...base, limit: 2, before });
        if (page.length === 0) break;
        seen.push(...keys(page));
        const last = page[page.length - 1]!;
        before = { date: (last.tradeDate ?? last.settlementDate)!, key: last.dedupeKey };
      }
      expect(seen).toEqual(["c", "b", "a", "d", "e"]);
    });

    it("returns everything when no limit is given", async () => {
      const store = await seed(Array.from({ length: 120 }, (_, i) => ({ dedupeKey: `k${i}`, tradeDate: "2026-05-05" })));
      expect(await store.queryActivities("u1", base)).toHaveLength(120);
    });

    it("filters by account, date range (inclusive), type and symbol", async () => {
      const store = await seed([
        { dedupeKey: "1", snapTradeAccountId: "acc1", tradeDate: "2026-01-01", type: "BUY", symbol: "XEQT" },
        { dedupeKey: "2", snapTradeAccountId: "acc2", tradeDate: "2026-06-01", type: "DIVIDEND", symbol: "VFV" },
        { dedupeKey: "3", snapTradeAccountId: "acc3", tradeDate: "2026-06-01", type: "BUY", symbol: "XEQT" },
        { dedupeKey: "4", snapTradeAccountId: "acc1", tradeDate: "2025-12-31", type: "BUY", symbol: "XEQT" },
        { dedupeKey: "5", snapTradeAccountId: "acc1", tradeDate: "2026-12-31", type: "BUY", symbol: null },
      ]);
      expect(keys(await store.queryActivities("u1", base)).sort()).toEqual(["1", "2", "5"]);
      expect(keys(await store.queryActivities("u1", { ...base, accountIds: ["acc2"] }))).toEqual(["2"]);
      expect(keys(await store.queryActivities("u1", { ...base, types: ["DIVIDEND"] }))).toEqual(["2"]);
      expect(keys(await store.queryActivities("u1", { ...base, symbol: " xeqt " }))).toEqual(["1"]);
      expect(keys(await store.queryActivities("u1", { ...base, accountIds: [] }))).toEqual([]);
    });

    it("matches symbol case-insensitively and exactly (no prefix match)", async () => {
      const store = await seed([
        { dedupeKey: "1", symbol: "xeqt" },
        { dedupeKey: "2", symbol: "XEQT.TO" },
        { dedupeKey: "3", symbol: " XEQT " },
      ]);
      expect(keys(await store.queryActivities("u1", { ...base, symbol: "XEQT" })).sort()).toEqual(["1", "3"]);
    });

    it("excludes undated rows and uses settlementDate when tradeDate is missing", async () => {
      const store = await seed([
        { dedupeKey: "u", tradeDate: null, settlementDate: null },
        { dedupeKey: "s", tradeDate: null, settlementDate: "2026-04-01" },
        { dedupeKey: "t", tradeDate: "2026-05-01", settlementDate: "2026-04-01" },
        { dedupeKey: "o", tradeDate: null, settlementDate: "2027-04-01" },
      ]);
      expect(keys(await store.queryActivities("u1", base))).toEqual(["t", "s"]);
      expect(keys(await store.queryActivities("u1", { ...base, from: "2026-04-01", to: "2026-04-30" }))).toEqual(["s"]);
      expect(keys(await store.queryActivities("u1", { ...base, before: { date: "2026-05-01", key: "t" } }))).toEqual(["s"]);
    });

    it("scopes to the user", async () => {
      const f = fakePort();
      const store = new ActivityStore(f.port, () => T);
      await store.upsertActivities("u2", [act({ dedupeKey: "x" })]);
      expect(await store.queryActivities("u1", base)).toEqual([]);
    });
  });
});
