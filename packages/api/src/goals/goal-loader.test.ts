import { describe, expect, it } from "vitest";
import type { StoredActivity } from "../history/stored-activity.js";
import { accountKey } from "../memory/keys.js";
import { MemoryService } from "../memory/memory-service.js";
import { MemoryFactRepository } from "../testing/memory-fact-repository.js";
import { checkGoal } from "./goal-check.js";
import { loadGoalInputs, type GoalLoaderDeps } from "./goal-loader.js";

// Synthetic subjects, accounts and amounts only.
const ME = "subject|synthetic-goal-me";
const OTHER = "subject|synthetic-goal-other";
const NOW = new Date("2026-10-23T16:00:00Z");
const FRESH = "2026-10-22T21:00:00.000Z";

const cls = (bucket: string, group: string, included: boolean, closed = false): any => ({ label: bucket.toUpperCase(), bucket, group, includedInPortfolioTotal: included, isClosed: closed, groupLabel: group, bucketLabel: bucket });
const acct = (id: string, amount: number | null, currency = "CAD", over: Record<string, unknown> = {}): any => ({
  id, name: id, classification: cls("tfsa", "registered", true), value: amount === null ? null : { currency, amount, source: "brokerage_reported" }, balances: [], positions: [],
  freshness: { positionsAsOf: FRESH, holdingsLastSyncedAt: null, initialSyncCompleted: true, holdingsUnavailable: false }, ...over,
});
type ActivityRec = Omit<StoredActivity, "description"> & { subject: string };
const act = (over: Partial<ActivityRec>): ActivityRec => ({
  subject: ME, snapTradeAccountId: "A", dedupeKey: `k-${Math.random()}`, type: "CONTRIBUTION", symbol: null, securityCurrency: null, isOption: false,
  units: null, price: null, amount: null, fee: null, fxRate: null, currency: "CAD", tradeDate: "2026-06-01", settlementDate: null, ...over,
});
type SyncRec = { subject: string; snapTradeAccountId: string; backfillCompletedAt: Date | null; earliestTradeDate: Date | null; lastSyncedAt: Date | null; lastError: string | null };
const synced = (account: string, over: Partial<SyncRec> = {}): SyncRec => ({
  subject: ME, snapTradeAccountId: account, backfillCompletedAt: new Date("2026-01-01T00:00:00Z"), earliestTradeDate: new Date("2024-01-02T00:00:00Z"),
  lastSyncedAt: new Date(NOW.getTime() - 3_600_000), lastError: null, ...over,
});
const dv = (date: string, accountId: string, value: number, currency = "CAD") => ({ date, accountId, currency, value, source: "reported" as const });

interface World {
  accounts: any[];
  goalAccounts: string[];
  growthRatePct?: number;
  outside?: Array<{ key: string; amountCad: number; asOf: string }>;
  activities?: ActivityRec[];
  sync?: SyncRec[];
  daily?: ReturnType<typeof dv>[];
  usdCad?: (from: string, to: string) => Promise<Array<{ date: string; close: number }> | null>;
}

const dates = (from: string, to: string) => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

async function setup(w: World) {
  const repository = new MemoryFactRepository();
  const memory = new MemoryService({ repository, now: () => NOW, log: () => undefined });
  const goal = (subject: string) => memory.remember(subject, {
    node: { type: "goal", key: "house" }, property: "goal.savings_target",
    value: { name: "House", targetCad: 100_000, targetDate: "2028-10-23", accounts: w.goalAccounts, ...(w.growthRatePct !== undefined ? { growthRatePct: w.growthRatePct } : {}) },
    text: "Goal.", kind: "plan", provenance: "stated",
  }, NOW);
  await goal(ME);
  await goal(OTHER);
  for (const o of w.outside ?? []) {
    await memory.remember(ME, { node: { type: "account", key: o.key }, property: "account.value", value: { amountCad: o.amountCad, asOf: o.asOf }, text: "Value.", kind: "fact", provenance: "stated" }, NOW);
  }
  const calls = { activityWhere: [] as any[], syncWhere: [] as any[], dailySubjects: [] as string[], portfolio: 0 };
  const deps: GoalLoaderDeps = {
    memory,
    portfolio: async (subject) => { expect(subject).toBe(ME); calls.portfolio++; return { connectionRequired: false, generatedAt: NOW.toISOString(), totals: [], accounts: w.accounts, errors: [] } as any; },
    prisma: {
      activity: {
        findMany: async (input) => {
          calls.activityWhere.push(input.where);
          return (w.activities ?? []).filter((a) => a.subject === input.where.appUser.authSubject && input.where.snapTradeAccountId.in.includes(a.snapTradeAccountId)).map((a) => ({
            ...a, tradeDate: a.tradeDate ? new Date(`${a.tradeDate}T00:00:00Z`) : null, settlementDate: a.settlementDate ? new Date(`${a.settlementDate}T00:00:00Z`) : null,
          }));
        },
      },
      activitySyncState: { findMany: async (input) => { calls.syncWhere.push(input.where); return (w.sync ?? []).filter((s) => s.subject === input.where.appUser.authSubject); } },
    },
    dailyValues: { rows: async (subject, from) => { calls.dailySubjects.push(subject); return (w.daily ?? []).filter((r) => r.date >= from); } },
    market: { usdCad: w.usdCad ?? (async (from, to) => dates(from, to).map((date) => ({ date, close: 1.4 }))) },
  };
  return { deps, calls };
}

describe("loadGoalInputs", () => {
  const base = (): World => ({
    accounts: [acct("A", 20_000), acct("B", 1_000, "USD"), acct("C", 99_999)],
    goalAccounts: [accountKey("A"), accountKey("B"), "outside:other-bank"],
    outside: [{ key: "outside:other-bank", amountCad: 5_000, asOf: "2026-09-30" }],
    activities: [
      act({ tradeDate: "2026-03-01", amount: 9_000 }), // before the window (starts 2026-04-23)
      act({ tradeDate: "2026-06-01", amount: 3_000 }),
      act({ tradeDate: "2026-09-01", amount: 3_500 }),
      act({ tradeDate: "2026-09-15", type: "WITHDRAWAL", amount: -500 }),
      act({ tradeDate: "2026-07-01", type: "DIVIDEND", amount: 200 }),
      // Between two linked accounts: nets out.
      act({ tradeDate: "2026-08-03", type: "INTERNAL_CASH_TRANSFER_OUT", amount: -1_000 }),
      act({ snapTradeAccountId: "B", tradeDate: "2026-08-03", type: "INTERNAL_CASH_TRANSFER_IN", amount: 1_000 }),
      act({ subject: OTHER, tradeDate: "2026-06-01", amount: 1_000_000 }),
    ],
    sync: [synced("A"), synced("B"), { ...synced("A"), subject: OTHER }],
  });

  it("saved = linked accounts (USD at BoC, est.) + outside values; pace = net contributions over 6 months", async () => {
    const { deps, calls } = await setup(base());
    const [input] = await loadGoalInputs(deps, ME, NOW);
    const g = checkGoal(input!, NOW);
    expect(g).toMatchObject({ slug: "house", savedCad: 26_400, estimated: true, recentPacePerMonthCad: 1_000, projectedAtPaceCad: 50_400 });
    expect(g.savedFxDate).toMatch(/^2026-\d{2}-\d{2}$/);
    for (const where of [...calls.activityWhere, ...calls.syncWhere]) expect(where.appUser.authSubject).toBe(ME);
    // Linked accounts plus the other listed accounts (C), read only to pair transfer legs.
    expect(calls.activityWhere[0].snapTradeAccountId.in.sort()).toEqual(["A", "B", "C"]);
    expect(calls.dailySubjects).toEqual([ME]);
  });

  it("a USD contribution converts at the BoC rate on its date (est.)", async () => {
    const w = base();
    w.activities = [act({ snapTradeAccountId: "B", tradeDate: "2026-06-01", amount: 1_000, currency: "USD" })];
    const { deps } = await setup(w);
    const [input] = await loadGoalInputs(deps, ME, NOW);
    expect(input!.contributions).toMatchObject({ netCad: 1_400, estimated: true, unvaluedDates: [] });
    expect(input!.contributions.rateDates).toEqual(["2026-06-01"]);
  });

  it("a flow with no CAD value is listed; the pace is null", async () => {
    const w = base();
    w.activities = [act({ tradeDate: "2026-06-01", amount: 1_000, currency: "EUR" })];
    const { deps } = await setup(w);
    const [input] = await loadGoalInputs(deps, ME, NOW);
    expect(input!.contributions.unvaluedDates).toEqual(["2026-06-01"]);
    expect(checkGoal(input!, NOW).recentPacePerMonthCad).toBeNull();
  });

  it("coverage that starts inside the window, a missing backfill or a sync error leaves no pace", async () => {
    for (const sync of [
      [synced("A", { backfillCompletedAt: null }), synced("B")],
      [synced("A")],
      [synced("A", { earliestTradeDate: null }), synced("B")],
    ]) {
      const { deps } = await setup({ ...base(), sync });
      const [input] = await loadGoalInputs(deps, ME, NOW);
      expect(input!.contributions.backfilled && input!.contributions.firstActivity !== null).toBe(false);
      expect(checkGoal(input!, NOW).recentPacePerMonthCad).toBeNull();
    }
    for (const sync of [
      [synced("A", { lastError: "sync_failed" }), synced("B")],
      [synced("A", { lastSyncedAt: new Date(NOW.getTime() - 49 * 3_600_000) }), synced("B")],
    ]) {
      const { deps } = await setup({ ...base(), sync });
      const [input] = await loadGoalInputs(deps, ME, NOW);
      expect(input!.contributions.synced).toBe(false);
      expect(checkGoal(input!, NOW).recentPacePerMonthCad).toBeNull();
    }
  });

  it("one account opened inside the window and one older: the full 6 months (I-3)", async () => {
    const { deps } = await setup({ ...base(), sync: [synced("A", { earliestTradeDate: new Date("2026-06-01T00:00:00Z") }), synced("B")] });
    const [input] = await loadGoalInputs(deps, ME, NOW);
    expect(input!.contributions.firstActivity).toBe("2024-01-02");
    expect(checkGoal(input!, NOW).recentPacePerMonthCad).toBe(1_000);
  });

  it("every account opened inside the window: prorated since the earliest first activity (I-3)", async () => {
    const sync = [synced("A", { earliestTradeDate: new Date("2026-07-23T00:00:00Z") }), synced("B", { earliestTradeDate: new Date("2026-08-03T00:00:00Z") })];
    const w = { ...base(), sync, activities: [act({ tradeDate: "2026-07-23", amount: 3_000 }), act({ snapTradeAccountId: "B", tradeDate: "2026-09-01", amount: 1_500 })] };
    const [input] = await loadGoalInputs((await setup(w)).deps, ME, NOW);
    expect(input!.contributions.firstActivity).toBe("2026-07-23");
    const g = checkGoal(input!, NOW);
    expect(g.recentPacePerMonthCad).toBe(1_500); // 4,500 over 3 months
    expect(g.notes).toContain("pace since 2026-07-23");
    expect(g.paceSince).toBe("2026-07-23");
  });

  it("a disconnected linked account leaves no pace (I-2)", async () => {
    const { deps } = await setup({ ...base(), goalAccounts: [accountKey("A"), accountKey("GONE")] });
    const g = checkGoal((await loadGoalInputs(deps, ME, NOW))[0]!, NOW);
    expect(g.recentPacePerMonthCad).toBeNull();
    expect(g.notes.join(" | ")).toContain(accountKey("GONE"));
  });

  it("a managed account reporting zero is value unknown, and said so; a reported value counts (A9)", async () => {
    const managed = { classification: { ...cls("rrsp", "registered", true), label: "Managed RRSP" } };
    const withB = async (b: any) => {
      const w = base();
      w.accounts = [w.accounts.find((x: any) => x.id === "A"), b];
      const [input] = await loadGoalInputs((await setup(w)).deps, ME, NOW);
      return checkGoal(input!, NOW);
    };
    const zero = await withB(acct("B", 0, "CAD", managed));
    // The other values make a lower bound ("at least"), never $0 for the managed account (review 7).
    expect(zero).toMatchObject({ savedAtLeast: true, savedPct: null });
    expect(zero.savedCad).toBe((await withB(acct("B", 0))).savedCad);
    expect(zero.notes.join(" ")).toContain("Not included in the total: Managed RRSP. SnapTrade doesn't provide the value of Wealthsimple managed portfolios");
    const none = await withB(acct("B", null, "CAD", managed));
    expect(none.notes.join(" ")).toContain("Not included in the total: Managed RRSP.");
    const valued = await withB(acct("B", 5_000, "CAD", managed));
    const empty = await withB(acct("B", 0));
    // A managed account with a value counts; a self-directed account at zero is a real zero.
    expect(valued.savedCad).toBe(empty.savedCad! + 5_000);
    expect(empty.savedCad).not.toBeNull();
  });

  it("a failed daily-values read is noted as such (M-3)", async () => {
    const { deps } = await setup(base());
    deps.dailyValues = { rows: async () => { throw new Error("synthetic"); } };
    const g = checkGoal((await loadGoalInputs(deps, ME, NOW))[0]!, NOW);
    expect(g.notes).toContain("chart data couldn't be loaded");
  });

  it("a transfer out of a closed linked account into an open one is not a contribution (M-4)", async () => {
    const w = base();
    w.accounts[0] = acct("A", 20_000, "CAD", { classification: cls("tfsa", "closed", true, true) });
    w.activities = [
      act({ tradeDate: "2026-08-03", type: "INTERNAL_CASH_TRANSFER_OUT", amount: -1_000 }),
      act({ snapTradeAccountId: "B", tradeDate: "2026-08-03", type: "INTERNAL_CASH_TRANSFER_IN", amount: 1_000 }),
      act({ snapTradeAccountId: "B", tradeDate: "2026-09-01", amount: 600 }),
    ];
    const [input] = await loadGoalInputs((await setup(w)).deps, ME, NOW);
    expect(input!.contributions.netCad).toBe(600);
  });

  it("TFSA1 -> Cash -> TFSA2 between two linked TFSAs is two real flows; a direct TFSA1 -> TFSA2 still nets", async () => {
    // The pace window starts after 2026-04-23. Paired legs are -x and +x, so netting only changes the pace when they
    // straddle the window start: the routed 1000 left before the window and came back inside it.
    const w = base();
    w.accounts.push(acct("CASH", 400, "CAD", { classification: cls("money_market", "cash", true) }));
    w.activities = [
      act({ tradeDate: "2026-04-22", type: "INTERNAL_CASH_TRANSFER_OUT", amount: -1_000 }),
      act({ snapTradeAccountId: "CASH", tradeDate: "2026-04-22", type: "INTERNAL_CASH_TRANSFER_IN", amount: 1_000 }),
      act({ snapTradeAccountId: "CASH", tradeDate: "2026-04-24", type: "INTERNAL_CASH_TRANSFER_OUT", amount: -1_000 }),
      act({ snapTradeAccountId: "B", tradeDate: "2026-04-24", type: "INTERNAL_CASH_TRANSFER_IN", amount: 1_000 }),
      // Direct, same straddle, no Cash leg of that size: nets (counted, it would add 500).
      act({ tradeDate: "2026-04-22", type: "INTERNAL_CASH_TRANSFER_OUT", amount: -500 }),
      act({ snapTradeAccountId: "B", tradeDate: "2026-04-24", type: "INTERNAL_CASH_TRANSFER_IN", amount: 500 }),
      act({ snapTradeAccountId: "B", tradeDate: "2026-09-01", amount: 600 }),
    ];
    const { deps, calls } = await setup(w);
    const [input] = await loadGoalInputs(deps, ME, NOW);
    // 600 + the 1000 put back into B inside the window. Before: 600 (A's out leg and B's in leg paired directly).
    expect(input!.contributions.netCad).toBe(1_600);
    expect(calls.activityWhere[0].snapTradeAccountId.in.sort()).toEqual(["A", "B", "C", "CASH"]);
  });

  it("a disconnected account, stale positions, or a missing or stale outside value", async () => {
    const gone = await setup({ ...base(), goalAccounts: [accountKey("A"), accountKey("GONE")] });
    expect(checkGoal((await loadGoalInputs(gone.deps, ME, NOW))[0]!, NOW).savedCad).toBeNull();

    const stale = base();
    stale.accounts[0] = acct("A", 20_000, "CAD", { freshness: { positionsAsOf: "2026-10-14T21:00:00.000Z" } });
    const g = checkGoal((await loadGoalInputs((await setup(stale)).deps, ME, NOW))[0]!, NOW);
    expect(g.savedCad).toBeNull();
    expect(g.notes.join(" | ")).toContain("more than 3 trading days old");

    const noOutside = await setup({ ...base(), outside: [] });
    expect(checkGoal((await loadGoalInputs(noOutside.deps, ME, NOW))[0]!, NOW).savedCad).toBeNull();

    const old = await setup({ ...base(), outside: [{ key: "outside:other-bank", amountCad: 5_000, asOf: "2026-06-01" }] });
    const og = checkGoal((await loadGoalInputs(old.deps, ME, NOW))[0]!, NOW);
    expect(og.savedCad).toBe(26_400);
    expect(og.notes.join(" | ")).toContain("more than 90 days ago");
  });

  it("USD without a rate is not converted: saved unknown", async () => {
    const { deps } = await setup({ ...base(), usdCad: async () => null });
    const g = checkGoal((await loadGoalInputs(deps, ME, NOW))[0]!, NOW);
    expect(g.savedCad).toBeNull();
    expect(g.notes.join(" | ")).toContain("could not be converted to CAD");
  });

  it("a closed linked account is listed and not counted", async () => {
    const w = base();
    w.accounts[0] = acct("A", 20_000, "CAD", { classification: cls("tfsa", "closed", true, true) });
    const g = checkGoal((await loadGoalInputs((await setup(w)).deps, ME, NOW))[0]!, NOW);
    expect(g.savedCad).toBe(6_400);
    expect(g.notes.join(" | ")).toContain("closed or a credit product");
  });

  it("daily values summed across linked accounts, dates with every account valued only, weekly", async () => {
    const w = base();
    w.daily = [
      dv("2026-10-05", "A", 100), dv("2026-10-05", "B", 10, "USD"),
      dv("2026-10-09", "A", 200), dv("2026-10-09", "B", 20, "USD"),
      dv("2026-10-16", "A", 300), // B missing: skipped
      dv("2026-10-14", "A", 400), dv("2026-10-14", "B", 40, "USD"),
      dv("2026-10-21", "A", 500), dv("2026-10-21", "B", 50, "USD"), dv("2026-10-21", "C", 1_000_000),
    ];
    const [input] = await loadGoalInputs((await setup(w)).deps, ME, NOW);
    expect(checkGoal(input!, NOW).series).toEqual([{ date: "2026-10-09", valueCad: 228 }, { date: "2026-10-14", valueCad: 456 }, { date: "2026-10-21", valueCad: 570 }]);
  });

  it("one goal by slug; no goals means no reads", async () => {
    const { deps } = await setup(base());
    expect(await loadGoalInputs(deps, ME, NOW, { slug: "nope" })).toEqual([]);
    expect((await loadGoalInputs(deps, ME, NOW, { slug: "house" })).map((g) => g.slug)).toEqual(["house"]);
    const empty = await setup({ ...base(), goalAccounts: [accountKey("A")] });
    const none = await loadGoalInputs(empty.deps, "subject|synthetic-nobody", NOW);
    expect(none).toEqual([]);
  });
});
