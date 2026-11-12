import { describe, expect, it, vi } from "vitest";
import { SnapTradeKeyRejectedError } from "../snaptrade/gateway.js";
import { ActivityStore, type ActivityStorePort } from "./activity-store.js";
import { ActivitySyncService, createSnapTradeActivityProvider, type ActivityProvider } from "./activity-sync-service.js";

type Row = Record<string, any>;
const creds = { userId: "u", userSecret: "s" };

function fakePort() {
  const activities = new Map<string, Row>();
  const states = new Map<string, Row>();
  const k = (a: string, b: string) => `${a}|${b}`;
  const port = {
    appUser: { findUnique: async ({ where }: any) => (where.authSubject === "subject|a" ? { id: "u1" } : null) },
    activity: {
      upsert: async ({ where, create, update }: any) => {
        const key = k(where.appUserId_dedupeKey.appUserId, where.appUserId_dedupeKey.dedupeKey);
        activities.set(key, activities.has(key) ? { ...activities.get(key), ...update } : { ...create });
      },
      findMany: async ({ where }: any) => [...activities.values()].filter((r) => r.appUserId === where.appUserId && r.snapTradeAccountId === where.snapTradeAccountId),
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (const key of where.dedupeKey.in) if (activities.delete(k(where.appUserId, key))) count += 1;
        return { count };
      },
    },
    activitySyncState: {
      findUnique: async ({ where }: any) => states.get(k(where.appUserId_snapTradeAccountId.appUserId, where.appUserId_snapTradeAccountId.snapTradeAccountId)) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const w = where.appUserId_snapTradeAccountId;
        const key = k(w.appUserId, w.snapTradeAccountId);
        states.set(key, states.has(key) ? { ...states.get(key), ...update } : { dirty: false, backfillCompletedAt: null, lastSyncedAt: null, ...create });
      },
      updateMany: async ({ where, data }: any) => { for (const r of states.values()) if (r.appUserId === where.appUserId) Object.assign(r, data); },
      findMany: async () => [],
    },
    accountHistoryQuality: { upsert: async () => undefined, findMany: async () => [] },
  } as unknown as ActivityStorePort;
  return { port, activities, states };
}

const rawAct = (i: number) => ({
  id: `INV-${i}`, type: "buy", symbol: { symbol: "SYN.EQ", currency: { code: "CAD" } }, units: 1, price: 10, amount: -10,
  currency: { code: "CAD" }, trade_date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`, settlement_date: null, description: "x", fee: 0, fx_rate: null,
});

function fakeProvider(data: Record<string, unknown[]>, failFor?: string) {
  const calls: Array<{ accountId: string; offset: number; limit: number; startDate?: string }> = [];
  const provider: ActivityProvider = {
    listAccountIds: async () => Object.keys(data),
    activitiesPage: async (_c, accountId, page) => {
      calls.push({ accountId, ...page });
      if (accountId === failFor) throw new Error("boom");
      const rows = page.startDate ? data[accountId].slice(0, 5) : data[accountId];
      return { data: rows.slice(page.offset, page.offset + page.limit), pagination: { offset: page.offset, limit: page.limit, total: rows.length } };
    },
  };
  return { provider, calls };
}

function setup(data: Record<string, unknown[]>, failFor?: string) {
  const clock = { t: new Date("2026-10-15T12:00:00Z") };
  const f = fakePort();
  const store = new ActivityStore(f.port, () => clock.t);
  const p = fakeProvider(data, failFor);
  const svc = new ActivitySyncService({
    identity: { getExisting: async (s) => (s === "subject|a" ? creds : null) },
    provider: p.provider, store, now: () => clock.t,
  });
  return { clock, svc, store, ...f, ...p };
}

const big = () => ({ A: Array.from({ length: 2350 }, (_, i) => rawAct(i)), B: [rawAct(9001), rawAct(9002), rawAct(9003)] });

describe("ActivitySyncService", () => {
  it("backfills in pages of 1000 and records state", async () => {
    const s = setup(big());
    const r = await s.svc.syncUser("subject|a");
    expect(r).toMatchObject({ accounts: 2, written: 2353, failures: 0, skipped: false });
    expect(s.calls.filter((c) => c.accountId === "A").map((c) => c.offset)).toEqual([0, 1000, 2000]);
    expect(s.calls.every((c) => c.startDate === undefined && c.limit === 1000)).toBe(true);
    expect(s.activities.size).toBe(2353);
    const st = s.states.get("u1|A")!;
    expect(st.backfillCompletedAt).toEqual(s.clock.t);
    expect(st.activityCount).toBe(2350);
    expect(st.earliestTradeDate).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(st.lastError).toBeNull();
  });

  it("classifies a rejected SnapTrade key as snaptrade_key_rejected, not a generic list failure", async () => {
    const s = setup(big());
    s.provider.listAccountIds = async () => { throw new SnapTradeKeyRejectedError(); };
    expect(await s.svc.syncUser("subject|a")).toMatchObject({ failures: 1, codes: { snaptrade_key_rejected: 1 } });
    s.provider.listAccountIds = async () => { throw new Error("network"); };
    expect(await s.svc.syncUser("subject|a")).toMatchObject({ failures: 1, codes: { sync_list_accounts: 1 } });
  });

  it("skips within the interval, then runs 30-day windows once stale, idempotently", async () => {
    const s = setup(big());
    await s.svc.syncUser("subject|a");
    s.calls.length = 0;
    s.clock.t = new Date(s.clock.t.getTime() + 5 * 60_000);
    expect(await s.svc.syncUser("subject|a")).toMatchObject({ accounts: 0, written: 0, failures: 0, skipped: true });
    expect(s.calls).toHaveLength(0);
    s.clock.t = new Date("2026-10-15T12:11:00Z");
    const r = await s.svc.syncUser("subject|a");
    expect(r.skipped).toBe(false);
    expect(s.calls).toHaveLength(2);
    expect(s.calls.every((c) => c.startDate === "2026-09-15" && c.offset === 0)).toBe(true);
    expect(s.activities.size).toBe(2353);
  });

  it("uses the Toronto calendar date for the window", async () => {
    const s = setup({ A: [rawAct(1)] });
    await s.svc.syncUser("subject|a");
    s.calls.length = 0;
    s.clock.t = new Date("2026-10-16T02:00:00Z"); // still Oct 15 in Toronto
    await s.svc.syncUser("subject|a");
    expect(s.calls[0].startDate).toBe("2026-09-15");
  });

  it("isolates a failing account and records provider_error", async () => {
    const s = setup(big(), "B");
    const r = await s.svc.syncUser("subject|a");
    expect(r).toMatchObject({ accounts: 2, written: 2350, failures: 1, skipped: false });
    expect(s.states.get("u1|B")!.lastError).toBe("provider_error");
    expect(s.states.get("u1|B")!.backfillCompletedAt).toBeNull();
    expect(s.states.get("u1|A")!.lastError).toBeNull();
  });

  it("runs a 30-day window after a failed sync while the last full read is under a week old", async () => {
    const s = setup({ A: [rawAct(1)] });
    s.states.set("u1|A", { appUserId: "u1", snapTradeAccountId: "A", dirty: false, lastError: "provider_error", backfillCompletedAt: new Date("2026-10-12T12:00:00Z"), lastSyncedAt: new Date("2026-10-15T11:59:00Z") });
    await s.svc.syncUser("subject|a");
    expect(s.calls[0].startDate).toBe("2026-09-15");
  });

  it("rereads the whole history once the last full read is over a week old, failed or not", async () => {
    for (const lastError of [null, "provider_error"]) {
      const s = setup({ A: [rawAct(1)] });
      s.states.set("u1|A", { appUserId: "u1", snapTradeAccountId: "A", dirty: false, lastError, backfillCompletedAt: new Date("2026-10-07T12:00:00Z"), lastSyncedAt: new Date("2026-10-15T11:00:00Z") });
      await s.svc.syncUser("subject|a");
      expect(s.calls[0].startDate).toBeUndefined();
      expect(s.states.get("u1|A")!.backfillCompletedAt).toEqual(s.clock.t);
      expect(s.states.get("u1|A")!.lastError).toBeNull();
    }
  });

  describe("rows SnapTrade stops returning", () => {
    const tenAt = (prefix: string) => Array.from({ length: 10 }, (_, i) => ({ ...rawAct(i), id: `${prefix}-${i}` }));
    const ids = (s: ReturnType<typeof setup>) => [...s.activities.values()].map((r) => r.dedupeKey).sort();
    const weekLater = (s: ReturnType<typeof setup>) => { s.clock.t = new Date(s.clock.t.getTime() + 8 * 86_400_000); };

    it("the weekly full read drops a cancelled row and rows whose ids SnapTrade changed", async () => {
      const data: Record<string, unknown[]> = { A: tenAt("OLD") };
      const s = setup(data);
      await s.svc.syncUser("subject|a");
      data.A = tenAt("NEW").filter((_, i) => i !== 4); // reprocessed: new ids, the cancelled deposit gone
      weekLater(s);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await s.svc.syncUser("subject|a");
      expect(s.activities.size).toBe(9);
      const fresh = setup({ A: data.A });
      await fresh.svc.syncUser("subject|a");
      expect(ids(s)).toEqual(ids(fresh));
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "activity_prune", removed: 10 }));
      log.mockRestore();
    });

    it("a 30-day window replaces rows reissued inside it at once and leaves older rows alone", async () => {
      const on = (prefix: string, i: number, date: string) => ({ ...rawAct(i), id: `${prefix}-${i}`, trade_date: `${date}T04:00:00Z` });
      const rows = (prefix: string) => [on(prefix, 1, "2026-01-05"), on(prefix, 2, "2026-03-05"), on(prefix, 3, "2026-09-16"), on(prefix, 4, "2026-10-01"), on(prefix, 5, "2026-10-14")];
      let current = rows("OLD");
      const s = setup({ A: [] });
      const svc = new ActivitySyncService({
        identity: { getExisting: async () => creds },
        provider: {
          listAccountIds: async () => ["A"],
          // The endpoint honours startDate: only rows on or after it come back.
          activitiesPage: async (_c, _a, page) => ({ data: current.filter((r) => !page.startDate || r.trade_date.slice(0, 10) >= page.startDate) }),
        },
        store: s.store, now: () => s.clock.t,
      });
      await svc.syncUser("subject|a");
      current = rows("NEW");
      s.clock.t = new Date("2026-10-16T12:00:00Z"); // window starts 2026-09-16; the margin day itself is left for the weekly read
      await svc.syncUser("subject|a");
      const keys = [...s.activities.values()].map((r) => `${r.tradeDate.toISOString().slice(0, 10)}`).sort();
      expect(keys).toEqual(["2026-01-05", "2026-03-05", "2026-09-16", "2026-09-16", "2026-10-01", "2026-10-14"]);
    });

    it("keeps everything when a full read returns much less than is stored", async () => {
      const data: Record<string, unknown[]> = { A: tenAt("OLD") };
      const s = setup(data);
      await s.svc.syncUser("subject|a");
      data.A = tenAt("OLD").slice(0, 8);
      weekLater(s);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await s.svc.syncUser("subject|a");
      expect(s.activities.size).toBe(10);
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "activity_prune_skipped", stored: 10, returned: 8 }));
      data.A = [];
      await s.svc.syncUser("subject|a"); // an empty answer never empties the account
      expect(s.activities.size).toBe(10);
      log.mockRestore();
    });

    it("keeps rows older than the earliest one SnapTrade still returns", async () => {
      const data: Record<string, unknown[]> = { A: tenAt("OLD") };
      const s = setup(data);
      await s.svc.syncUser("subject|a");
      data.A = tenAt("OLD").slice(1); // the oldest row (Jan 1) is no longer returned
      weekLater(s);
      await s.svc.syncUser("subject|a");
      expect(s.activities.size).toBe(10);
    });

    it("a reprocess that also stops returning the oldest rows still replaces the reissued ones", async () => {
      const twentyAt = (prefix: string) => Array.from({ length: 20 }, (_, i) => ({ ...rawAct(i), id: `${prefix}-${i}` }));
      const data: Record<string, unknown[]> = { A: twentyAt("OLD") };
      const s = setup(data);
      await s.svc.syncUser("subject|a");
      data.A = twentyAt("NEW").filter((_, i) => i >= 4 && i !== 5); // Jan 1-4 no longer returned, the Jan 6 row cancelled, new ids
      weekLater(s);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await s.svc.syncUser("subject|a");
      const days = [...s.activities.values()].map((r) => r.tradeDate.toISOString().slice(0, 10)).sort();
      const jan = (d: number) => `2026-01-${String(d).padStart(2, "0")}`;
      expect(days).toEqual([1, 2, 3, 4, 5, ...Array.from({ length: 14 }, (_, i) => i + 7)].map(jan));
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "activity_prune", removed: 16 }));
      log.mockRestore();
    });

    it("a truncated full read drops nothing", async () => {
      const data: Record<string, unknown[]> = { A: tenAt("OLD") };
      const s = setup(data);
      await s.svc.syncUser("subject|a");
      const svc = new ActivitySyncService({
        identity: { getExisting: async () => creds },
        provider: {
          listAccountIds: async () => ["A"],
          activitiesPage: async (_c, _a, page) => ({ data: Array.from({ length: 1000 }, (_, i) => ({ ...rawAct(i), id: `X-${page.offset + i}` })), pagination: { total: 999999 } }),
        },
        store: s.store, now: () => s.clock.t,
      });
      weekLater(s);
      await svc.syncUser("subject|a");
      expect(s.activities.size).toBe(50_010);
      expect(s.states.get("u1|A")!.lastError).toBe("backfill_truncated");
    });
  });

  it("errored account bypasses the freshness gate", async () => {
    const s = setup({ A: [rawAct(1)] }, "A");
    await s.svc.syncUser("subject|a");
    s.calls.length = 0;
    s.clock.t = new Date(s.clock.t.getTime() + 60_000);
    const r = await s.svc.syncUser("subject|a");
    expect(r.skipped).toBe(false);
    expect(s.calls).toHaveLength(1);
  });

  it("markDirty forces a run inside the interval", async () => {
    const s = setup({ A: [rawAct(1)], B: [rawAct(2)] });
    await s.svc.syncUser("subject|a");
    s.calls.length = 0;
    await s.store.markDirty("u1");
    const r = await s.svc.syncUser("subject|a");
    expect(r.skipped).toBe(false);
    expect(s.calls).toHaveLength(2);
    expect(s.states.get("u1|A")!.dirty).toBe(false);
  });

  it("skips without identity or user, and counts listAccountIds failure", async () => {
    const s = setup({ A: [rawAct(1)] });
    expect(await s.svc.syncUser("subject|none")).toMatchObject({ accounts: 0, written: 0, failures: 0, skipped: true });
    const svc = new ActivitySyncService({
      identity: { getExisting: async () => creds },
      provider: { listAccountIds: async () => { throw new Error("x"); }, activitiesPage: async () => ({}) },
      store: s.store,
    });
    expect(await svc.syncUser("subject|a")).toMatchObject({ accounts: 0, written: 0, failures: 1, skipped: false });
  });

  it("M3: a missing pagination.total with a full first page continues to page 2", async () => {
    const calls: number[] = [];
    const s = setup({ A: [] });
    const rows = Array.from({ length: 1500 }, (_, i) => rawAct(i));
    const svc = new ActivitySyncService({
      identity: { getExisting: async () => creds },
      provider: {
        listAccountIds: async () => ["A"],
        activitiesPage: async (_c, _a, page) => { calls.push(page.offset); return { data: rows.slice(page.offset, page.offset + page.limit) }; },
      },
      store: s.store,
    });
    await svc.syncUser("subject|a");
    expect(calls).toEqual([0, 1000]);
    expect(s.states.get("u1|A")!.activityCount).toBe(1500);
  });

  it("stops after 50 pages", async () => {
    const calls: number[] = [];
    const s = setup({ A: [] });
    const svc = new ActivitySyncService({
      identity: { getExisting: async () => creds },
      provider: {
        listAccountIds: async () => ["A"],
        activitiesPage: async (_c, _a, page) => {
          calls.push(page.offset);
          return { data: Array.from({ length: 1000 }, (_, i) => rawAct(page.offset + i)), pagination: { total: 999999 } };
        },
      },
      store: s.store,
    });
    await svc.syncUser("subject|a");
    expect(calls).toHaveLength(50);
    const st = s.states.get("u1|A")!;
    expect(st.backfillCompletedAt).toBeNull();
    expect(st.lastError).toBe("backfill_truncated");
  });
});

describe("createSnapTradeActivityProvider", () => {
  it("maps accounts and passes paging params with a 15s timeout", async () => {
    const seen: unknown[] = [];
    const gateway = {
      listAccounts: async () => [{ id: "A1" }, { id: "A2" }, { nope: 1 }],
      getActivities: async (...args: unknown[]) => { seen.push(args); return { data: [] }; },
    };
    const p = createSnapTradeActivityProvider(gateway as any);
    expect(await p.listAccountIds(creds)).toEqual(["A1", "A2"]);
    await p.activitiesPage(creds, "A1", { offset: 1000, limit: 1000, startDate: "2026-09-15" });
    expect(seen[0]).toEqual([creds, "A1", { offset: 1000, limit: 1000, startDate: "2026-09-15" }, { timeout: 15_000 }]);
  });
});
