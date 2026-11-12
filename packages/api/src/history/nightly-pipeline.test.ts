import { describe, expect, it, vi } from "vitest";
import { NightlyPipeline } from "./nightly-pipeline.js";

const users = [1, 2, 3].map((n) => ({ id: `u-${n}`, authSubject: `subject|synthetic-${n}` }));

describe("NightlyPipeline", () => {
  it("isolates per-user sync and reconstruct failures and still snapshots every user", async () => {
    const order: string[] = [];
    const sync = { syncUser: vi.fn(async (s: string) => { order.push(`sync:${s}`); if (s.endsWith("2")) throw new Error("synthetic"); return { accounts: 1, written: 1, failures: 0, skipped: false }; }) };
    const reconstruct = { reconstructUser: vi.fn(async (s: string) => { order.push(`rec:${s}`); if (s.endsWith("3")) throw new Error("synthetic"); return { accounts: 1, failures: 0 }; }) };
    const snapshot = { captureFor: vi.fn(async (u: { id: string }) => { order.push(`snap:${u.id}`); return { rows: 2, failed: false }; }) };
    const result = await new NightlyPipeline({ users: async () => users, sync, reconstruct, snapshot }).runAll();
    expect(result).toMatchObject({ users: 3, synced: 2, reconstructed: 2, rows: 6, failures: 2, deferred: 0 });
    expect(result.failureCodes).toEqual({ sync_error: 1, reconstruct_error: 1 });
    expect(snapshot.captureFor).toHaveBeenCalledTimes(3);
    expect(order.slice(0, 3)).toEqual(["sync:subject|synthetic-1", "snap:u-1", "rec:subject|synthetic-1"]);
  });
  it("does not count skipped syncs and counts snapshot failures", async () => {
    const sync = { syncUser: vi.fn(async () => ({ accounts: 0, written: 0, failures: 0, skipped: true })) };
    const reconstruct = { reconstructUser: vi.fn(async () => ({ accounts: 0, failures: 0 })) };
    const snapshot = { captureFor: vi.fn(async (u: { id: string }) => { if (u.id === "u-1") throw new Error("x"); return { rows: 0, failed: u.id === "u-2" }; }) };
    const result = await new NightlyPipeline({ users: async () => users, sync, reconstruct, snapshot }).runAll();
    expect(result).toMatchObject({ users: 3, synced: 0, reconstructed: 3, rows: 0, failures: 2, deferred: 0 });
  });
  it("defers remaining users once the time budget is exhausted", async () => {
    let t = 0;
    const sync = { syncUser: vi.fn(async () => { t += 300_000; return { accounts: 1, written: 0, failures: 0, skipped: false }; }) };
    const reconstruct = { reconstructUser: vi.fn(async () => ({ accounts: 1, failures: 0 })) };
    const snapshot = { captureFor: vi.fn(async () => ({ rows: 1, failed: false })) };
    const result = await new NightlyPipeline({ users: async () => users, sync, reconstruct, snapshot, now: () => t, budgetMs: 240_000 }).runAll();
    expect(result).toMatchObject({ users: 3, synced: 1, reconstructed: 1, rows: 1, failures: 0, deferred: 2 });
    expect(snapshot.captureFor).toHaveBeenCalledTimes(1);
  });
  it("adds account-level failures without un-counting the user", async () => {
    const sync = { syncUser: vi.fn(async () => ({ accounts: 2, written: 0, failures: 2, skipped: false })) };
    const reconstruct = { reconstructUser: vi.fn(async () => ({ accounts: 2, failures: 1 })) };
    const snapshot = { captureFor: vi.fn(async () => ({ rows: 0, failed: false })) };
    const result = await new NightlyPipeline({ users: async () => [users[0]], sync, reconstruct, snapshot }).runAll();
    expect(result).toMatchObject({ synced: 1, reconstructed: 1, failures: 3 });
  });
  it("F4: purges expired market-data cache rows once at the end, best-effort", async () => {
    const order: string[] = [];
    const sync = { syncUser: vi.fn(async () => ({ accounts: 1, written: 0, failures: 0, skipped: false })) };
    const reconstruct = { reconstructUser: vi.fn(async () => { order.push("rec"); return { accounts: 1, failures: 0 }; }) };
    const snapshot = { captureFor: vi.fn(async () => ({ rows: 1, failed: false })) };
    const purgeCache = vi.fn(async () => { order.push("purge"); return 5; });
    const result = await new NightlyPipeline({ users: async () => users, sync, reconstruct, snapshot, purgeCache }).runAll();
    expect(purgeCache).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["rec", "rec", "rec", "purge"]);
    expect(result).toMatchObject({ users: 3, synced: 3, reconstructed: 3, rows: 3, failures: 0, deferred: 0 });
    const failing = vi.fn(async () => { throw new Error("db down"); });
    await expect(new NightlyPipeline({ users: async () => [users[0]], sync, reconstruct, snapshot, purgeCache: failing }).runAll())
      .resolves.toMatchObject({ failures: 0 });
    expect(failing).toHaveBeenCalledTimes(1);
  });
  describe("news step", () => {
    const account = (symbol: string) => ({
      id: `acct-${symbol}`,
      classification: { includedInPortfolioTotal: true, isClosed: false, group: "registered", bucket: "tfsa", label: "TFSA" },
      balances: [],
      positions: [{ instrumentId: symbol, kind: "stock", symbol, description: null, units: 1, price: 1, costBasis: 1, marketValue: 1, unrealizedGain: 0, currency: "USD", cashEquivalent: false }],
    });
    const ok = () => ({
      sync: { syncUser: vi.fn(async () => ({ accounts: 1, written: 0, failures: 0, skipped: false })) },
      reconstruct: { reconstructUser: vi.fn(async () => ({ accounts: 1, failures: 0 })) },
      snapshot: { captureFor: vi.fn(async (u: { id: string }, _o?: { keepAccounts?: boolean }) => ({ rows: 1, failed: false, accounts: [account(`ZZ${u.id.slice(2)}`)] as never })) },
    });
    const newsResult = { users: 3, symbols: 4, fetched: 5, rated: 6, skipped: 0, failures: 0, budgetLeft: 70 };
    type Loader = () => Promise<Array<{ symbols: Array<{ symbol: string }> }>>;

    it("runs after the snapshots with symbols from the portfolios the snapshots read, and the remaining time budget", async () => {
      const order: string[] = [];
      const deps = ok();
      const capture = deps.snapshot.captureFor.getMockImplementation()!;
      deps.snapshot.captureFor.mockImplementation(async (u, o) => { order.push("snap"); return capture(u, o); });
      let t = 0;
      deps.sync.syncUser.mockImplementation(async () => { t += 10_000; return { accounts: 1, written: 0, failures: 0, skipped: false }; });
      let loaded: Awaited<ReturnType<Loader>> = [];
      const refreshAll = vi.fn(async (users: Loader, _o: { budgetMs: number }) => { order.push("news"); loaded = await users(); return newsResult; });
      const purgeCache = vi.fn(async () => { order.push("purge"); });
      const result = await new NightlyPipeline({ users: async () => users, ...deps, news: { refreshAll }, purgeCache, now: () => t, budgetMs: 240_000 }).runAll();
      expect(order).toEqual(["snap", "snap", "snap", "news", "purge"]);
      expect(deps.snapshot.captureFor).toHaveBeenCalledWith(users[0], { keepAccounts: true });
      expect(loaded.map((u) => u.symbols.map((s) => s.symbol))).toEqual([["ZZ1"], ["ZZ2"], ["ZZ3"]]);
      expect(refreshAll.mock.calls[0][1]).toEqual({ budgetMs: 210_000 });
      expect(result.news).toEqual({ symbols: 4, fetched: 5, rated: 6, failures: 0, budgetLeft: 70 });
      expect(result.failures).toBe(0);
    });

    it("counts users whose symbols cannot be derived instead of re-reading them", async () => {
      const deps = ok();
      deps.snapshot.captureFor.mockImplementation(async (u) => (u.id === "u-2" ? { rows: 1, failed: false, accounts: undefined as never } : { rows: 1, failed: false, accounts: [account("ZZ1")] as never }));
      let loaded: Awaited<ReturnType<Loader>> = [];
      const refreshAll = vi.fn(async (l: Loader) => { loaded = await l(); return newsResult; });
      const result = await new NightlyPipeline({ users: async () => users, ...deps, news: { refreshAll } }).runAll();
      expect(loaded).toHaveLength(2);
      expect(result).toMatchObject({ failures: 1, failureCodes: { news_symbols_failed: 1 } });
    });

    it("does not ask the snapshot for accounts without a news step", async () => {
      const deps = ok();
      await new NightlyPipeline({ users: async () => users, ...deps }).runAll();
      expect(deps.snapshot.captureFor).toHaveBeenCalledWith(users[0], { keepAccounts: false });
    });

    it("counts news failures and a thrown step without failing the run", async () => {
      const counted = await new NightlyPipeline({ users: async () => users, ...ok(), news: { refreshAll: vi.fn(async () => ({ ...newsResult, failures: 2 })) } }).runAll();
      expect(counted).toMatchObject({ failures: 2, failureCodes: { news_failed: 2 }, news: { failures: 2 } });
      const thrown = await new NightlyPipeline({ users: async () => users, ...ok(), news: { refreshAll: vi.fn(async () => { throw new Error("synthetic"); }) } }).runAll();
      expect(thrown).toMatchObject({ failures: 1, failureCodes: { news_error: 1 } });
      expect(thrown.news).toBeUndefined();
    });

    it("skips the step once the time budget is exhausted", async () => {
      let t = 0;
      const deps = ok();
      deps.sync.syncUser.mockImplementation(async () => { t += 300_000; return { accounts: 1, written: 0, failures: 0, skipped: false }; });
      const refreshAll = vi.fn(async () => newsResult);
      const log = vi.fn();
      const result = await new NightlyPipeline({ users: async () => users, ...deps, news: { refreshAll }, now: () => t, budgetMs: 240_000, log }).runAll();
      expect(refreshAll).not.toHaveBeenCalled();
      expect(result.news).toBeUndefined();
      expect(result.deferred).toBe(2);
      // M9: the skip is logged (counts only) and shows in the run result
      expect(log).toHaveBeenCalledWith({ event: "news_skipped", reason: "no_time", users: 1, deferred: 2 });
      expect(result.failureCodes).toMatchObject({ news_skipped: 1 });
      expect(result.failures).toBe(0);
    });

    it("leaves the result unchanged without a news step", async () => {
      const result = await new NightlyPipeline({ users: async () => users, ...ok() }).runAll();
      expect(result).not.toHaveProperty("news");
    });
  });
});

describe("NightlyPipeline room alert step", () => {
  const deps = (order: string[] = []) => ({
    sync: { syncUser: vi.fn(async (s: string) => { order.push(`sync:${s}`); return { accounts: 1, written: 0, failures: 0, skipped: false }; }) },
    reconstruct: { reconstructUser: vi.fn(async (s: string) => { order.push(`rec:${s}`); return { accounts: 1, failures: 0 }; }) },
    snapshot: { captureFor: vi.fn(async (u: { id: string }) => { order.push(`snap:${u.id}`); return { rows: 1, failed: false }; }) },
  });

  it("evaluates every user, after their sync and snapshot, and logs counts only", async () => {
    const order: string[] = [];
    const outcomes = { [users[0]!.authSubject]: "raised", [users[1]!.authSubject]: "cleared", [users[2]!.authSubject]: "updated" } as const;
    const evaluate = vi.fn(async (s: string) => { order.push(`room:${s}`); return outcomes[s]!; });
    const events: unknown[] = [];
    const result = await new NightlyPipeline({
      users: async () => users, ...deps(order), roomAlerts: { evaluate },
      log: (e) => events.push(e),
    }).runAll();
    expect(evaluate.mock.calls).toEqual(users.map((u) => [u.authSubject]));
    expect(order.slice(0, 4)).toEqual([`sync:${users[0]!.authSubject}`, "snap:u-1", `rec:${users[0]!.authSubject}`, `room:${users[0]!.authSubject}`]);
    expect(result.room).toEqual({ evaluated: 3, raised: 1, updated: 1, cleared: 1, failed: 0 });
    expect(events).toEqual([{ event: "room_alerts", evaluated: 3, raised: 1, updated: 1, cleared: 1, failed: 0 }]);
    expect(JSON.stringify(events)).not.toMatch(/synthetic|auth0/);
  });

  it("one user's failure never fails the run: it is counted and the next user is still evaluated", async () => {
    const evaluate = vi.fn(async (s: string) => { if (s === users[0]!.authSubject) throw new Error(`synthetic ${s}`); return "none" as const; });
    const events: unknown[] = [];
    const result = await new NightlyPipeline({ users: async () => users, ...deps(), roomAlerts: { evaluate }, log: (e) => events.push(e) }).runAll();
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(result.room).toEqual({ evaluated: 2, raised: 0, updated: 0, cleared: 0, failed: 1 });
    expect(result.failureCodes).toEqual({ room_alert_error: 1 });
    expect(result.failures).toBe(1);
    expect(JSON.stringify(events)).not.toContain("synthetic");
  });

  it("without the step composed, nothing is evaluated or logged", async () => {
    const events: unknown[] = [];
    const result = await new NightlyPipeline({ users: async () => users, ...deps(), log: (e) => events.push(e) }).runAll();
    expect(result.room).toBeUndefined();
    expect(events).toEqual([]);
  });
});

describe("NightlyPipeline nudge step", () => {
  const ACCOUNTS = [{ id: "synthetic-acct" }] as never;
  const deps = (order: string[] = [], snap: (u: { id: string }) => { rows: number; failed: boolean; accounts?: never } = () => ({ rows: 1, failed: false, accounts: ACCOUNTS })) => ({
    sync: { syncUser: vi.fn(async (s: string) => { order.push(`sync:${s}`); return { accounts: 1, written: 0, failures: 0, skipped: false }; }) },
    reconstruct: { reconstructUser: vi.fn(async (s: string) => { order.push(`rec:${s}`); return { accounts: 1, failures: 0 }; }) },
    snapshot: { captureFor: vi.fn(async (u: { id: string }, _o?: { keepAccounts?: boolean }) => { order.push(`snap:${u.id}`); return snap(u); }) },
  });

  it("evaluates every user, after the room alert, from the accounts the snapshot read, and logs counts only", async () => {
    const order: string[] = [];
    const evaluate = vi.fn(async (s: string, _p: { accounts: unknown }) => { order.push(`nudge:${s}`); return { raised: 2, cleared: 1, failed: 0 }; });
    const room = vi.fn(async (s: string) => { order.push(`room:${s}`); return "none" as const; });
    const events: unknown[] = [];
    const d = deps(order);
    const result = await new NightlyPipeline({
      users: async () => users, ...d, roomAlerts: { evaluate: room }, nudges: { evaluate },
      log: (e) => events.push(e),
    }).runAll();
    expect(evaluate.mock.calls.map((c) => c[0])).toEqual(users.map((u) => u.authSubject));
    expect(evaluate.mock.calls[0]![1]).toEqual({ accounts: ACCOUNTS });
    expect(d.snapshot.captureFor).toHaveBeenCalledWith(users[0], { keepAccounts: true });
    expect(order.slice(0, 5)).toEqual([`sync:${users[0]!.authSubject}`, "snap:u-1", `rec:${users[0]!.authSubject}`, `room:${users[0]!.authSubject}`, `nudge:${users[0]!.authSubject}`]);
    expect(result.nudges).toEqual({ evaluated: 3, raised: 6, cleared: 3, failed: 0 });
    expect(events).toContainEqual({ event: "portfolio_nudges", evaluated: 3, raised: 6, cleared: 3, failed: 0 });
    expect(JSON.stringify(events)).not.toMatch(/synthetic|auth0/);
    // No news step: keeping the accounts for nudges never counts missing news symbols.
    expect(result.failureCodes).toEqual({});
  });

  it("one user's failure never stops the others; part failures are counted too", async () => {
    const evaluate = vi.fn(async (s: string) => {
      if (s === users[0]!.authSubject) throw new Error(`synthetic ${s}`);
      return { raised: 0, cleared: 0, failed: s === users[1]!.authSubject ? 1 : 0 };
    });
    const events: unknown[] = [];
    const result = await new NightlyPipeline({ users: async () => users, ...deps(), nudges: { evaluate }, log: (e) => events.push(e) }).runAll();
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(result.nudges).toEqual({ evaluated: 2, raised: 0, cleared: 0, failed: 2 });
    expect(result.failureCodes).toEqual({ nudge_error: 2 });
    expect(result.failures).toBe(2);
    expect(JSON.stringify(events)).not.toContain("synthetic");
  });

  it("skips a user whose snapshot read failed or was partial, leaving their nudges alone", async () => {
    const evaluate = vi.fn(async () => ({ raised: 0, cleared: 0, failed: 0 }));
    const snap = (u: { id: string }) => u.id === "u-1" ? { rows: 0, failed: true, accounts: ACCOUNTS } : u.id === "u-2" ? { rows: 0, failed: true } : { rows: 1, failed: false, accounts: ACCOUNTS };
    const result = await new NightlyPipeline({ users: async () => users, ...deps([], snap), nudges: { evaluate }, log: () => {} }).runAll();
    expect(evaluate.mock.calls.map((c) => (c as unknown[])[0])).toEqual([users[2]!.authSubject]);
    expect(result.nudges).toEqual({ evaluated: 1, raised: 0, cleared: 0, failed: 2 });
    expect(result.failureCodes).toEqual({ snapshot_failed: 2 });
  });

  it("without the step composed, nothing is evaluated or logged", async () => {
    const events: unknown[] = [];
    const result = await new NightlyPipeline({ users: async () => users, ...deps(), log: (e) => events.push(e) }).runAll();
    expect(result.nudges).toBeUndefined();
    expect(events).toEqual([]);
  });

  describe("runPending (history catch-up)", () => {
    const steps = () => ({
      sync: { syncUser: vi.fn(async () => ({ accounts: 1, written: 4, failures: 0, skipped: false })) },
      reconstruct: { reconstructUser: vi.fn(async () => ({ accounts: 1, failures: 0 })) },
      snapshot: { captureFor: vi.fn(async (_u: { id: string }, _o: { keepAccounts: boolean }) => ({ rows: 2, failed: false })) },
    });

    it("runs sync, snapshot and reconstruction for the pending users only, and nothing else", async () => {
      const s = steps();
      const news = { refreshAll: vi.fn() };
      const roomAlerts = { evaluate: vi.fn() };
      const purgeCache = vi.fn();
      const all = vi.fn(async () => users);
      const result = await new NightlyPipeline({ users: all, pending: async () => [users[1]], ...s, news, roomAlerts, purgeCache }).runPending();
      expect(result).toEqual({ users: 1, synced: 1, reconstructed: 1, rows: 2, failures: 0, deferred: 0, failureCodes: {} });
      expect(s.sync.syncUser).toHaveBeenCalledWith("subject|synthetic-2");
      expect(s.snapshot.captureFor).toHaveBeenCalledWith(users[1], { keepAccounts: false });
      expect(all).not.toHaveBeenCalled();
      for (const untouched of [news.refreshAll, roomAlerts.evaluate, purgeCache]) expect(untouched).not.toHaveBeenCalled();
    });

    it("does nothing without pending users or a pending source", async () => {
      const s = steps();
      await expect(new NightlyPipeline({ users: async () => users, ...s }).runPending()).resolves.toMatchObject({ users: 0, failures: 0 });
      await expect(new NightlyPipeline({ users: async () => users, pending: async () => [], ...s }).runPending()).resolves.toMatchObject({ users: 0 });
      expect(s.sync.syncUser).not.toHaveBeenCalled();
    });

    it("counts each step's failures by code and keeps going", async () => {
      const s = steps();
      s.sync.syncUser.mockResolvedValueOnce({ accounts: 2, written: 0, failures: 2, skipped: false, codes: { sync_account: 2 } } as never);
      s.snapshot.captureFor.mockRejectedValueOnce(new Error("x"));
      s.reconstruct.reconstructUser.mockRejectedValueOnce(new Error("x"));
      const result = await new NightlyPipeline({ users: async () => users, pending: async () => users.slice(0, 2), ...s }).runPending();
      expect(result).toMatchObject({ users: 2, synced: 2, reconstructed: 1, rows: 2, failures: 4 });
      expect(result.failureCodes).toEqual({ sync_account: 2, snapshot_error: 1, reconstruct_error: 1 });
    });
  });
});

describe("NightlyPipeline refreshUsers", () => {
  const steps = () => ({
    sync: { syncUser: vi.fn(async () => ({ accounts: 1, written: 0, failures: 0, skipped: false })) },
    reconstruct: { reconstructUser: vi.fn(async () => ({ accounts: 1, failures: 0 })) },
    snapshot: { captureFor: vi.fn(async (_u: { id: string }, _o: { keepAccounts: boolean }) => ({ rows: 2, failed: false })) },
  });

  it("syncs, snapshots and reconstructs every user, and touches no news, alert, nudge or purge step", async () => {
    const s = steps();
    const news = { refreshAll: vi.fn() };
    const roomAlerts = { evaluate: vi.fn() };
    const nudges = { evaluate: vi.fn() };
    const purgeCache = vi.fn();
    const pending = vi.fn(async () => []);
    const result = await new NightlyPipeline({ users: async () => users.slice(0, 2), pending, ...s, news, roomAlerts, nudges, purgeCache }).refreshUsers();
    expect(result).toEqual({ users: 2, synced: 2, reconstructed: 2, rows: 4, failures: 0, deferred: 0, failureCodes: {} });
    expect(s.sync.syncUser).toHaveBeenCalledTimes(2);
    expect(s.snapshot.captureFor).toHaveBeenCalledWith(users[0], { keepAccounts: false });
    for (const untouched of [news.refreshAll, roomAlerts.evaluate, nudges.evaluate, purgeCache, pending]) expect(untouched).toHaveBeenCalledTimes(0);
  });

  it("counts failures by code and stops at the time budget", async () => {
    const s = steps();
    s.snapshot.captureFor.mockRejectedValueOnce(new Error("x"));
    const result = await new NightlyPipeline({ users: async () => users, ...s }).refreshUsers();
    expect(result).toMatchObject({ users: 3, failures: 1, failureCodes: { snapshot_error: 1 } });
    let t = 0;
    const slow = await new NightlyPipeline({ users: async () => users, ...steps(), budgetMs: 10, now: () => (t += 10) }).refreshUsers();
    expect(slow.deferred).toBeGreaterThan(0);
  });
});
