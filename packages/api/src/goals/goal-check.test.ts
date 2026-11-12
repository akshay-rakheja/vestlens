import { describe, expect, it } from "vitest";
import type { SavingsGoal } from "../memory/memory-types.js";
import { checkGoal, monthsBetween, weeklySeries, type GoalAccountInput, type GoalCheck, type GoalContributions, type GoalInput } from "./goal-check.js";

// Synthetic accounts and amounts only.
const NOW = new Date("2026-10-23T16:00:00Z"); // Friday, Toronto 2026-10-23
const KEY_A = "0123456789abcdef";
const KEY_B = "fedcba9876543210";

const goal = (over: Partial<SavingsGoal> = {}): SavingsGoal => ({ name: "House", targetCad: 100_000, targetDate: "2028-10-23", accounts: [KEY_A, "outside:other-bank"], ...over });
const connected = (over: Partial<Extract<GoalAccountInput, { kind: "connected" }>> = {}): GoalAccountInput =>
  ({ key: KEY_A, kind: "connected", label: "TFSA", counted: true, valueCad: 20_000, estimated: false, positionsAsOf: "2026-10-22", problem: null, ...over });
const outside = (over: Partial<Extract<GoalAccountInput, { kind: "outside" }>> = {}): GoalAccountInput =>
  ({ key: "outside:other-bank", kind: "outside", amountCad: 5_000, asOf: "2026-09-30", stale: false, ...over });
const contributions = (over: Partial<GoalContributions> = {}): GoalContributions =>
  ({ connectedAccounts: 1, backfilled: true, firstActivity: "2024-01-02", synced: true, unvaluedDates: [], netCad: 6_000, estimated: false, ...over });
const input = (over: Partial<GoalInput> = {}): GoalInput => ({
  slug: "house", goal: goal(), accounts: [connected(), outside()], contributions: contributions(), daily: [], ...over,
});

describe("saved so far", () => {
  it("is the linked accounts' current values plus outside values", () => {
    const g = checkGoal(input(), NOW);
    expect(g).toMatchObject({ slug: "house", name: "House", targetCad: 100_000, targetDate: "2028-10-23", savedCad: 25_000, savedPct: 25, estimated: false });
  });

  it("a stale outside value is still counted, with a note", () => {
    const g = checkGoal(input({ accounts: [connected(), outside({ asOf: "2026-06-01", stale: true })] }), NOW);
    expect(g.savedCad).toBe(25_000);
    expect(g.notes.join(" | ")).toContain("your stated value for other-bank is from 2026-06-01, more than 90 days ago");
  });

  it("a linked account with stale positions leaves saved unknown and says which", () => {
    const g = checkGoal(input({ accounts: [connected({ positionsAsOf: "2026-10-16" }), outside()] }), NOW);
    expect(g).toMatchObject({ savedCad: null, savedPct: null, neededPerMonthFlatCad: null, projectedAtPaceCad: null });
    expect(g.notes.join(" | ")).toContain("latest positions for TFSA are more than 3 trading days old");
  });

  it("a disconnected account, an unknown value or a missing outside value leave saved unknown", () => {
    for (const accounts of [
      [{ key: KEY_B, kind: "disconnected" } as GoalAccountInput, connected()],
      [connected({ valueCad: null, problem: "no_value" })],
      [connected({ valueCad: null, problem: "not_converted" })],
      [connected(), { key: "outside:other-bank", kind: "outside_missing" } as GoalAccountInput],
      [connected({ positionsAsOf: null })],
    ]) {
      const g = checkGoal(input({ accounts }), NOW);
      expect(g.savedCad).toBeNull();
      expect(g.notes.length).toBeGreaterThan(0);
    }
  });

  it("a managed account with no value leaves a lower bound: the rest, marked at least, with no percentage, remaining or projection (review 7)", () => {
    const managed = connected({ key: KEY_B, label: "Managed RRSP", valueCad: null, problem: "managed" });
    const g = checkGoal(input({ accounts: [connected({ valueCad: 40_000 }), managed] }), NOW);
    expect(g).toMatchObject({ savedCad: 40_000, savedAtLeast: true, savedPct: null, remainingCad: null, neededPerMonthFlatCad: null, projectedAtPaceCad: null, projectedWithRateCad: null });
    expect(g.recentPacePerMonthCad).toBe(1_000);
    expect(g.notes.join(" | ")).toContain("Not included in the total: Managed RRSP. SnapTrade doesn't provide the value of Wealthsimple managed portfolios, so saved so far is a lower bound");
    // Another unknown beside it still leaves saved unknown; a valued goal carries no savedAtLeast.
    expect(checkGoal(input({ accounts: [connected({ valueCad: null, problem: "no_value" }), managed] }), NOW).savedCad).toBeNull();
    expect(checkGoal(input(), NOW).savedAtLeast).toBeUndefined();
  });

  it("a closed or credit account is not counted, and that is noted", () => {
    const g = checkGoal(input({ accounts: [connected(), connected({ key: KEY_B, label: "Card", counted: false, valueCad: 999 })] }), NOW);
    expect(g.savedCad).toBe(20_000);
    expect(g.notes.join(" | ")).toContain("Card is closed or a credit product and is not counted");
  });

  it("a converted value is est.", () => {
    expect(checkGoal(input({ accounts: [connected({ estimated: true })] }), NOW).estimated).toBe(true);
    const dates = (i: Partial<GoalInput>) => { const g = checkGoal(input(i), NOW); return [g.savedFxDate, g.paceEstimated, g.paceFxDate]; };
    expect(dates({ accounts: [connected({ estimated: true })] })).toEqual([null, false, null]);
    expect(dates({ accounts: [connected({ estimated: true, rateDate: "2026-10-21" }), connected({ key: KEY_B, estimated: true, rateDate: "2026-10-22" })] })).toEqual(["2026-10-22", false, null]);
    // The pace keeps its own date; the saved total is not estimated.
    expect(dates({ accounts: [connected()], contributions: contributions({ estimated: true, rateDates: ["2026-09-01", "2026-08-01"] }) })).toEqual([null, true, "2026-09-01"]);
    expect(dates({ accounts: [connected({ estimated: true, rateDate: "2026-10-22" })], contributions: contributions({ estimated: true, rateDates: ["2026-09-01"] }) })).toEqual(["2026-10-22", true, "2026-09-01"]);
    expect(dates({ accounts: [connected({ rateDate: "2026-10-22" })] })).toEqual([null, false, null]); // not estimated: no date shown
    // No pace (not synced): the pace is not estimated, whatever the flows were.
    expect(dates({ contributions: contributions({ estimated: true, rateDates: ["2026-09-01"], synced: false }) })).toEqual([null, false, null]);
  });
});

describe("pace", () => {
  it("is net contributions over the last 6 months, per month", () => {
    const g = checkGoal(input(), NOW);
    expect(g.recentPacePerMonthCad).toBe(1_000);
    expect(g.notes.join(" | ")).toContain("connected accounts only");
  });

  it("insufficient coverage gives a null pace with a note; the rest still shows", () => {
    const g = checkGoal(input({ contributions: contributions({ backfilled: false }) }), NOW);
    expect(g).toMatchObject({ recentPacePerMonthCad: null, projectedAtPaceCad: null, savedCad: 25_000 });
    expect(g.neededPerMonthFlatCad).not.toBeNull();
    expect(g.notes.join(" | ")).toContain("history isn't complete");
  });

  it("an unsynced account, an unvalued flow or no connected accounts give a null pace with a note", () => {
    for (const c of [contributions({ synced: false }), contributions({ unvaluedDates: ["2026-08-04"] }), contributions({ connectedAccounts: 0 })]) {
      const g = checkGoal(input({ contributions: c }), NOW);
      expect(g.recentPacePerMonthCad).toBeNull();
      expect(g.notes.length).toBeGreaterThan(0);
    }
    expect(checkGoal(input({ contributions: contributions({ unvaluedDates: ["2026-08-04"] }) }), NOW).notes.join(" | ")).toContain("2026-08-04");
  });

  it("net withdrawals give a negative pace, shown as is", () => {
    expect(checkGoal(input({ contributions: contributions({ netCad: -3_000 }) }), NOW).recentPacePerMonthCad).toBe(-500);
  });
});

describe("pace with accounts opened inside the window (I-3)", () => {
  it("prorates over the months since the earliest first activity, and says since when", () => {
    const g = checkGoal(input({ contributions: contributions({ firstActivity: "2026-07-23", netCad: 3_000 }) }), NOW);
    expect(g.recentPacePerMonthCad).toBe(1_000);
    expect(g.notes).toContain("pace since 2026-07-23");
  });

  it("less than a month of history gives no pace", () => {
    const g = checkGoal(input({ contributions: contributions({ firstActivity: "2026-10-01", netCad: 3_000 }) }), NOW);
    expect(g.recentPacePerMonthCad).toBeNull();
    expect(g.notes.join(" | ")).toContain("less than a month of activity");
  });

  it("history before the window start keeps the full 6 months, with no since note", () => {
    const g = checkGoal(input({ contributions: contributions({ firstActivity: "2026-04-23" }) }), NOW);
    expect(g.recentPacePerMonthCad).toBe(1_000);
    expect(g.notes.join(" | ")).not.toContain("pace since");
  });

  it("no known first activity gives no pace", () => {
    expect(checkGoal(input({ contributions: contributions({ firstActivity: null }) }), NOW).recentPacePerMonthCad).toBeNull();
  });
});

describe("pace with a disconnected linked account (I-2)", () => {
  it("is null, with a note naming the account", () => {
    const g = checkGoal(input({ accounts: [connected(), { key: KEY_B, kind: "disconnected" }, outside()] }), NOW);
    expect(g.recentPacePerMonthCad).toBeNull();
    expect(g.notes.join(" | ")).toContain(KEY_B);
  });
});

describe("chart data", () => {
  it("a failed read has its own note (M-3)", () => {
    const g = checkGoal(input({ daily: [], dailyUnavailable: true }), NOW);
    expect(g.notes).toContain("chart data couldn't be loaded");
    expect(g.notes.join(" | ")).not.toContain("not enough daily values");
  });
});

describe("projections", () => {
  it("at pace, no growth: saved + pace x months left", () => {
    const g = checkGoal(input(), NOW);
    expect(g.monthsLeft).toBe(24);
    expect(g.dateStatus).toBe("future");
    expect(g.neededPerMonthFlatCad).toBeCloseTo(75_000 / 24, 6);
    expect(g.projectedAtPaceCad).toBe(49_000);
    expect(g.projectedWithRateCad).toBeNull();
    expect(g.growthRatePct).toBeNull();
  });

  it("with the user's rate only when set: monthly compounding of saved plus the pace", () => {
    const g = checkGoal(input({ goal: goal({ growthRatePct: 5 }) }), NOW);
    const r = 0.05 / 12;
    const f = (1 + r) ** 24;
    expect(g.growthRatePct).toBe(5);
    expect(g.projectedWithRateCad).toBeCloseTo(25_000 * f + 1_000 * ((f - 1) / r), 2);
  });

  it("a 0% rate equals the projection at pace", () => {
    const g = checkGoal(input({ goal: goal({ growthRatePct: 0 }) }), NOW);
    expect(g.projectedWithRateCad).toBe(g.projectedAtPaceCad);
  });

  it("no pace: no projections, but the flat figure remains", () => {
    const g = checkGoal(input({ goal: goal({ growthRatePct: 5 }), contributions: contributions({ backfilled: false }) }), NOW);
    expect(g).toMatchObject({ projectedAtPaceCad: null, projectedWithRateCad: null });
    expect(g.neededPerMonthFlatCad).not.toBeNull();
  });

  it("saved already over the target needs 0 a month, never negative", () => {
    expect(checkGoal(input({ goal: goal({ targetCad: 10_000 }) }), NOW)).toMatchObject({ neededPerMonthFlatCad: 0, remainingCad: 0 });
  });
});

describe("dates (Review Focus 4)", () => {
  it("a past date: passed, no per-month figure, no projections, pace still shown", () => {
    const g = checkGoal(input({ goal: goal({ targetDate: "2026-09-01", growthRatePct: 5 }) }), NOW);
    expect(g).toMatchObject({ dateStatus: "passed", monthsLeft: 0, neededPerMonthFlatCad: null, projectedAtPaceCad: null, projectedWithRateCad: null, recentPacePerMonthCad: 1_000 });
    expect(g.notes).toContain("target date passed");
  });

  it("under a month: under_month, with the per-month figure over the fraction left", () => {
    const g = checkGoal(input({ goal: goal({ targetDate: "2026-11-10" }) }), NOW);
    expect(g.dateStatus).toBe("under_month");
    expect(g.monthsLeft).toBeCloseTo(18 / 31, 9);
    expect(g.neededPerMonthFlatCad).toBeNull();
    expect(g.remainingCad).toBe(75_000);
    expect(g.notes).toContain("less than a month left");
  });

  it("the target date today: under_month, no division by zero", () => {
    const g = checkGoal(input({ goal: goal({ targetDate: "2026-10-23" }) }), NOW);
    expect(g).toMatchObject({ dateStatus: "under_month", monthsLeft: 0, neededPerMonthFlatCad: null });
  });

  it("uses the Toronto date (late evening UTC is still the day before in Toronto)", () => {
    const lateEvening = new Date("2026-10-24T02:00:00Z"); // 2026-10-23 22:00 Toronto
    expect(checkGoal(input(), lateEvening).monthsLeft).toBe(24);
  });

  it("monthsBetween is fractional by calendar month", () => {
    expect(monthsBetween("2026-10-23", "2027-01-08")).toBeCloseTo(2 + 16 / 31, 9);
    expect(monthsBetween("2026-01-31", "2026-02-28")).toBe(1);
    expect(monthsBetween("2026-10-23", "2026-10-23")).toBe(0);
    expect(monthsBetween("2026-10-23", "2026-10-01")).toBe(0);
  });
});

describe("series", () => {
  it("at most one point per week (the last in each), empty with fewer than two", () => {
    const daily = ["2026-10-05", "2026-10-07", "2026-10-09", "2026-10-13", "2026-10-19", "2026-10-22"].map((date, i) => ({ date, valueCad: 1_000 + i }));
    expect(weeklySeries(daily)).toEqual([{ date: "2026-10-09", valueCad: 1_002 }, { date: "2026-10-13", valueCad: 1_003 }, { date: "2026-10-22", valueCad: 1_005 }]);
    expect(weeklySeries([{ date: "2026-10-05", valueCad: 1 }, { date: "2026-10-06", valueCad: 2 }])).toEqual([]);
    const g = checkGoal(input({ daily }), NOW);
    expect(g.series).toHaveLength(3);
    const empty = checkGoal(input({ daily: [] }), NOW);
    expect(empty.series).toEqual([]);
    expect(empty.notes.join(" | ")).toContain("not enough daily values");
  });
});

describe("copy", () => {
  it("no advice words in any VestLens string; the user's goal name passes through", () => {
    const banned = /should|sell|buy|recommend|consider/i;
    const cases: GoalCheck[] = [
      checkGoal(input(), NOW),
      checkGoal(input({ goal: goal({ targetDate: "2026-09-01", growthRatePct: 5 }) }), NOW),
      checkGoal(input({ goal: goal({ targetDate: "2026-11-10" }) }), NOW),
      checkGoal(input({ accounts: [connected({ positionsAsOf: "2026-01-01" }), outside({ stale: true }), { key: KEY_B, kind: "disconnected" }, { key: "outside:x", kind: "outside_missing" }, connected({ counted: false, label: "Card" }), connected({ valueCad: null, problem: "not_converted" }), connected({ valueCad: null, problem: "no_value" })] }), NOW),
      checkGoal(input({ contributions: contributions({ backfilled: false, synced: false, unvaluedDates: ["2026-08-04"] }) }), NOW),
      checkGoal(input({ contributions: contributions({ connectedAccounts: 0 }) }), NOW),
      checkGoal(input({ contributions: contributions({ firstActivity: "2026-07-23" }), daily: [], dailyUnavailable: true }), NOW),
      checkGoal(input({ contributions: contributions({ firstActivity: "2026-10-20" }) }), NOW),
    ];
    for (const g of cases) for (const n of g.notes) expect(n).not.toMatch(banned);
    expect(checkGoal(input({ goal: goal({ name: "Should buy a house" }) }), NOW).name).toBe("Should buy a house");
  });
});
