import { describe, expect, it } from "vitest";
import { replay, type DayState } from "./replay.js";
import type { StoredActivity } from "./stored-activity.js";
import { valueAccount } from "./valuation.js";

type Pt = { date: string; close: number };
const pts = (o: Record<string, number>): Pt[] => Object.entries(o).map(([date, close]) => ({ date, close }));
const state = (date: string, units: Record<string, number> = {}, cash: Record<string, number> = {}, conversions: DayState["conversions"] = []): DayState => ({
  date, units: new Map(Object.entries(units)), cash: new Map(Object.entries(cash)), conversions,
});
const calls: string[] = [];
const fromArgs: string[] = [];
type Split = { date: string; ratio: number };
function market(history: Record<string, Pt[] | null>, fx: Pt[] | null = null, track?: { cur: number; max: number }, splits: Record<string, Split[] | null> = {}) {
  return {
    async securityHistory(t: string, from?: string) {
      calls.push(t); fromArgs.push(from ?? "");
      if (track) { track.cur++; track.max = Math.max(track.max, track.cur); await new Promise((r) => setTimeout(r, 5)); track.cur--; }
      const h = history[t] ?? null;
      return (h ? { points: h.filter((p) => !from || p.date >= from), splits: t in splits ? splits[t] : [] } : null) as never;
    },
    async usdCad(from?: string) { fromArgs.push(from ?? ""); return (fx ? fx.filter((p) => !from || p.date >= from) : null) as never; },
  };
}
const tickerFor = (s: string) => (s.includes(" ") ? null : s);
const base = { tickerFor };

describe("valueAccount", () => {
  it("returns the last day's holdings and cash components, summing to the total", async () => {
    const r = await valueAccount({
      ...base, states: [state("2026-01-05", { A: 2, U: 1 }, { CAD: 5, USD: 10 }), state("2026-01-06", { A: 2, U: 1 }, { CAD: 5, USD: 10 })],
      reportingCurrency: "CAD", securityCurrencies: new Map([["A", "CAD"], ["U", "USD"]]),
      market: market({ A: pts({ "2026-01-05": 10, "2026-01-06": 11 }), U: pts({ "2026-01-05": 20, "2026-01-06": 20 }) }, pts({ "2026-01-05": 1.5, "2026-01-06": 1.5 })),
    });
    const lastDay = r.days[r.days.length - 1]!;
    expect(r.last.holdings).toBeCloseTo(2 * 11 + 20 * 1.5, 6);
    expect(r.last.cash).toBeCloseTo(5 + 10 * 1.5, 6);
    expect(r.last.holdings + r.last.cash).toBeCloseTo(lastDay.value, 6);
    expect(r.last.usdCad).toBe(1.5);
    expect(r.splitsApplied).toBe(false);
  });

  it("exposes the last day's as-traded close, assumed currency and mapped flag per held symbol", async () => {
    const r = await valueAccount({
      ...base,
      states: [state("2026-01-05", { A: 2, U: 1, "X Y": 3, F: 1 }), state("2026-01-06", { A: 2, U: 1, "X Y": 3, F: 1 })],
      reportingCurrency: "CAD", securityCurrencies: new Map([["A", "CAD"], ["U", "USD"], ["X Y", "CAD"], ["F", "CAD"]]),
      market: market({ A: pts({ "2026-01-05": 10, "2026-01-06": 11 }), U: pts({ "2026-01-06": 20 }), F: null }, pts({ "2026-01-06": 1.5 })),
    });
    expect(r.lastPrices.get("A")).toEqual({ close: 11, currency: "CAD", mapped: true });
    expect(r.lastPrices.get("U")).toEqual({ close: 20, currency: "USD", mapped: true });
    expect(r.lastPrices.get("X Y")).toEqual({ close: null, currency: "CAD", mapped: false });
    expect(r.lastPrices.get("F")).toEqual({ close: null, currency: "CAD", mapped: false });
  });

  it("lastPrices closes are as-traded (scaled back for a split after the last day)", async () => {
    const r = await valueAccount({
      ...base, states: [state("2026-01-05", { A: 2 }), state("2026-01-06", { A: 2 })],
      reportingCurrency: "CAD", securityCurrencies: new Map([["A", "CAD"]]),
      market: market({ A: pts({ "2026-01-05": 10, "2026-01-06": 10 }) }, null, undefined, { A: [{ date: "2026-01-20", ratio: 2 }] }),
    });
    expect(r.lastPrices.get("A")!.close).toBe(20);
  });

  it("reports whether a split was applied", async () => {
    const r = await valueAccount({
      ...base, states: [state("2026-01-05", { A: 2 }), state("2026-01-07", { A: 2 })],
      reportingCurrency: "CAD", securityCurrencies: new Map([["A", "CAD"]]),
      market: market({ A: pts({ "2026-01-05": 10, "2026-01-07": 5 }) }, null, undefined, { A: [{ date: "2026-01-06", ratio: 2 }] }),
    });
    expect(r.splitsApplied).toBe(true);
  });

  it("values units and cash from closes", async () => {
    const r = await valueAccount({
      ...base, states: [state("2026-01-05", { A: 2 }, { CAD: 5 }), state("2026-01-06", { A: 2 }, { CAD: 5 })],
      reportingCurrency: "CAD", securityCurrencies: new Map([["A", "CAD"]]),
      market: market({ A: pts({ "2026-01-05": 10, "2026-01-06": 11 }) }),
    });
    expect(r.days).toEqual([
      { date: "2026-01-05", currency: "CAD", value: 25, source: "reconstructed" },
      { date: "2026-01-06", currency: "CAD", value: 27, source: "reconstructed" },
    ]);
    expect(r.missingSymbols).toEqual([]);
  });

  it("converts USD security into CAD", async () => {
    const r = await valueAccount({
      ...base, states: [state("2026-01-05", { AAPL: 1 })], reportingCurrency: "CAD", securityCurrencies: new Map([["AAPL", null]]),
      market: market({ AAPL: pts({ "2026-01-05": 100 }) }, pts({ "2026-01-05": 1.4 })),
    });
    expect(r.days[0]).toMatchObject({ value: 140, source: "reconstructed" });
  });

  it("H5 debits CAD counterpart of USD conversion credit", async () => {
    const r = await valueAccount({
      ...base,
      states: [state("2026-01-05", {}, { CAD: 2000 }), state("2026-01-06", {}, { CAD: 2000, USD: 1000 }, [{ currency: "USD", amount: 1000 }]), state("2026-01-07", {}, { CAD: 2000, USD: 1000 })],
      reportingCurrency: "CAD", securityCurrencies: new Map(),
      market: market({}, pts({ "2026-01-05": 1.3, "2026-01-06": 1.37, "2026-01-07": 1.5 })),
    });
    expect(r.days.map((d) => d.value)).toEqual([2000, 2000, 2000 - 1370 + 1500]);
    expect(r.days.every((d) => d.source === "reconstructed")).toBe(true);
  });

  it("H5 CAD credit debits USD", async () => {
    const r = await valueAccount({
      ...base, states: [state("2026-01-05", {}, { USD: 100 }), state("2026-01-06", {}, { USD: 100, CAD: 140 }, [{ currency: "CAD", amount: 140 }])],
      reportingCurrency: "USD", securityCurrencies: new Map(),
      market: market({}, pts({ "2026-01-05": 1.4, "2026-01-06": 1.4 })),
    });
    expect(r.days.map((d) => d.value)).toEqual([100, 100]);
  });

  it("marks stale closes estimated but uses last close", async () => {
    const r = await valueAccount({
      ...base, states: [state("2026-01-05", { A: 1 }), state("2026-01-14", { A: 1 })], reportingCurrency: "CAD", securityCurrencies: new Map([["A", "CAD"]]),
      market: market({ A: pts({ "2026-01-05": 9 }) }),
    });
    expect(r.days[0].source).toBe("reconstructed");
    expect(r.days[1]).toMatchObject({ value: 9, source: "estimated" });
  });

  it("reports unmapped symbols", async () => {
    const r = await valueAccount({
      ...base, states: [state("2026-01-05", { "XYZ 2026-12 C": 1 }, { CAD: 3 })], reportingCurrency: "CAD", securityCurrencies: new Map(),
      market: market({}),
    });
    expect(r.missingSymbols).toEqual(["XYZ 2026-12 C"]);
    expect(r.days[0]).toMatchObject({ value: 3, source: "estimated" });
  });

  it("F2: null history for a held symbol is fetch-failed, not unmappable", async () => {
    const r = await valueAccount({
      ...base, states: [state("2026-01-05", { A: 1 })], reportingCurrency: "CAD", securityCurrencies: new Map([["A", "CAD"]]),
      market: market({ A: null }),
    });
    expect(r.missingSymbols).toEqual([]);
    expect(r.fetchFailed).toEqual(["A"]);
    expect(r.fxFailed).toBe(false);
    expect(r.days[0]).toMatchObject({ value: 0, source: "estimated" });
  });

  it("F3: history without split information (fallback provider) is fetch-failed", async () => {
    const r = await valueAccount({
      ...base, states: [state("2026-01-05", { A: 1 })], reportingCurrency: "CAD", securityCurrencies: new Map([["A", "CAD"]]),
      market: market({ A: pts({ "2026-01-05": 5 }) }, null, undefined, { A: null }),
    });
    expect(r.fetchFailed).toEqual(["A"]);
  });

  it("a ticker the provider reports as not found is unmappable (estimated), not fetch-failed", async () => {
    const m = market({});
    const r = await valueAccount({
      ...base, states: [state("2026-01-05", { GONE: 1 })], reportingCurrency: "CAD", securityCurrencies: new Map([["GONE", "CAD"]]),
      market: { ...m, securityHistory: async () => ({ points: [], splits: [], notFound: true }) } as never,
    });
    expect(r.fetchFailed).toEqual([]);
    expect(r.missingSymbols).toEqual(["GONE"]);
    expect(r.days[0].source).toBe("estimated");
  });

  it("F2: FX needed but unavailable is fxFailed; FX not needed is not", async () => {
    const usd = await valueAccount({
      ...base, states: [state("2026-01-05", { AAPL: 1 })], reportingCurrency: "CAD", securityCurrencies: new Map([["AAPL", "USD"]]),
      market: market({ AAPL: pts({ "2026-01-05": 100 }) }, null),
    });
    expect(usd.fxFailed).toBe(true);
    const cashOnly = await valueAccount({
      ...base, states: [state("2026-01-05", {}, { USD: 5 })], reportingCurrency: "CAD", securityCurrencies: new Map(), market: market({}, null),
    });
    expect(cashOnly.fxFailed).toBe(true);
    const cad = await valueAccount({
      ...base, states: [state("2026-01-05", { A: 1 }, { CAD: 5 })], reportingCurrency: "CAD", securityCurrencies: new Map([["A", "CAD"]]),
      market: market({ A: pts({ "2026-01-05": 5 }) }, null),
    });
    expect(cad.fxFailed).toBe(false);
    expect(cad.fetchFailed).toEqual([]);
  });

  it("F3: a holding survives a post-split sale that zeroes the raw units", async () => {
    // Raw (as-traded) replay units: buy 10, then 2:1 split on 10-12, then sell 10 post-split shares -> 10 held.
    const states = [
      state("2026-10-10", { AAA: 10 }),
      state("2026-10-11", { AAA: 10 }),
      state("2026-10-12", { AAA: 10 }),
      state("2026-10-13", {}), // raw 10 - 10 = 0, but 10 split-adjusted shares remain
      state("2026-10-14", {}),
    ];
    const closes = pts({ "2026-10-10": 5, "2026-10-11": 5, "2026-10-12": 5, "2026-10-13": 5, "2026-10-14": 5 });
    const r = await valueAccount({ states, reportingCurrency: "CAD", tickerFor: (s: string) => s, securityCurrencies: new Map([["AAA", "CAD"]]), market: market({ AAA: closes }, null, undefined, { AAA: [{ date: "2026-10-12", ratio: 2 }] }) } as never);
    expect(r.days.map((d) => d.value)).toEqual([100, 100, 100, 50, 50]);
    expect(r.finalUnits.get("AAA")).toBe(10);
  });

  it("F3 hand-worked split: buy 10, 10:1 split, sell 50 -> 50 units; values right on both sides", async () => {
    let k = 0;
    const a = (p: Partial<StoredActivity> & { type: string; tradeDate: string }): StoredActivity => ({
      snapTradeAccountId: "S", dedupeKey: `k${k++}`, symbol: null, securityCurrency: null, isOption: false, units: null, price: null,
      amount: null, fee: null, fxRate: null, currency: "CAD", settlementDate: null, description: null, ...p,
    });
    const activities = [
      a({ type: "CONTRIBUTION", tradeDate: "2026-03-02", amount: 900 }),
      a({ type: "BUY", tradeDate: "2026-03-02", symbol: "SYN", securityCurrency: "CAD", units: 10, price: 90, amount: -900 }),
      a({ type: "SELL", tradeDate: "2026-03-05", symbol: "SYN", securityCurrency: "CAD", units: -50, price: 10, amount: 500 }),
    ];
    // Split-adjusted closes (raw pre-split closes were 90, 110, then 12 and 10 post-split).
    const closes = pts({ "2026-03-02": 9, "2026-03-03": 11, "2026-03-04": 12, "2026-03-05": 10 });
    const r = await valueAccount({
      ...base, states: replay(activities, "0000-01-01", "2026-03-05"), reportingCurrency: "CAD", securityCurrencies: new Map([["SYN", "CAD"]]),
      market: market({ SYN: closes }, null, undefined, { SYN: [{ date: "2026-03-04", ratio: 10 }] }),
    });
    expect(r.days.map((d) => [d.date, d.value, d.source])).toEqual([
      ["2026-03-02", 900, "reconstructed"], // 10 units x raw 90
      ["2026-03-03", 1100, "reconstructed"], // 10 units x raw 110
      ["2026-03-04", 1200, "reconstructed"], // 100 units x 12
      ["2026-03-05", 1000, "reconstructed"], // 50 units x 10 + 500 cash
    ]);
    expect(r.finalUnits.get("SYN")).toBe(50);
    expect(r.fetchFailed).toEqual([]);
  });

  describe("opening-position inference", () => {
    let k = 0;
    const a = (p: Partial<StoredActivity> & { type: string; tradeDate: string }): StoredActivity => ({
      snapTradeAccountId: "S", dedupeKey: `o${String(k++).padStart(4, "0")}`, symbol: null, securityCurrency: null, isOption: false, units: null, price: null,
      amount: null, fee: null, fxRate: null, currency: "CAD", settlementDate: null, description: null, ...p,
    });
    const flat = (days: string[], close: number) => pts(Object.fromEntries(days.map((d) => [d, close])));

    it("sell 10 with no buy infers an opening lot of 10 held until the sale (estimated)", async () => {
      const activities = [
        a({ type: "DIVIDEND", tradeDate: "2026-03-02", amount: 5 }),
        a({ type: "SELL", tradeDate: "2026-03-04", symbol: "SYN", securityCurrency: "CAD", units: -10, price: 50, amount: 500 }),
      ];
      const r = await valueAccount({
        ...base, states: replay(activities, "0000-01-01", "2026-03-05"), reportingCurrency: "CAD", securityCurrencies: new Map([["SYN", "CAD"]]),
        market: market({ SYN: flat(["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"], 50) }),
      });
      expect(r.inferredSymbols).toBe(1);
      expect(r.days.map((d) => [d.value, d.source])).toEqual([
        [505, "estimated"], // 10 inferred shares x 50 + 5 cash
        [505, "estimated"],
        [505, "reconstructed"], // shares sold: 505 cash, no inferred lot held
        [505, "reconstructed"],
      ]);
      expect(r.finalUnits.has("SYN")).toBe(false);
      // a reported total that matches leaves no drift
      expect(Math.abs(r.days[r.days.length - 1]!.value - 505) / 505).toBeCloseTo(0, 9);
    });

    it("a 2:1 split before an oversell of 20 infers 10 at start (20 after the split)", async () => {
      const activities = [
        a({ type: "DIVIDEND", tradeDate: "2026-03-02", amount: 5 }),
        a({ type: "SELL", tradeDate: "2026-03-04", symbol: "SYN", securityCurrency: "CAD", units: -20, price: 5, amount: 100 }),
      ];
      // Split-adjusted closes: as-traded 10 before the 03-03 split, 5 after.
      const r = await valueAccount({
        ...base, states: replay(activities, "0000-01-01", "2026-03-04"), reportingCurrency: "CAD", securityCurrencies: new Map([["SYN", "CAD"]]),
        market: market({ SYN: flat(["2026-03-02", "2026-03-03", "2026-03-04"], 5) }, null, undefined, { SYN: [{ date: "2026-03-03", ratio: 2 }] }),
      });
      expect(r.inferredSymbols).toBe(1);
      expect(r.days.map((d) => [d.value, d.source])).toEqual([
        [105, "estimated"], // 10 as-traded units x 10 + 5
        [105, "estimated"], // 20 post-split units x 5 + 5
        [105, "reconstructed"], // sold: 5 + 100 cash
      ]);
      expect(r.finalUnits.has("SYN")).toBe(false);
    });

    it("a later buy keeps the inferred lot in the final units", async () => {
      const activities = [
        a({ type: "SELL", tradeDate: "2026-03-02", symbol: "SYN", securityCurrency: "CAD", units: -5, price: 10, amount: 50 }),
        a({ type: "BUY", tradeDate: "2026-03-03", symbol: "SYN", securityCurrency: "CAD", units: 10, price: 10, amount: -100 }),
      ];
      const r = await valueAccount({
        ...base, states: replay(activities, "0000-01-01", "2026-03-03"), reportingCurrency: "CAD", securityCurrencies: new Map([["SYN", "CAD"]]),
        market: market({ SYN: flat(["2026-03-02", "2026-03-03"], 10) }),
      });
      expect(r.inferredSymbols).toBe(1);
      expect(r.finalUnits.get("SYN")).toBe(10);
      expect(r.days.map((d) => d.value)).toEqual([50, 50]);
    });

    it("no inference when units never go negative", async () => {
      const activities = [
        a({ type: "BUY", tradeDate: "2026-03-02", symbol: "SYN", securityCurrency: "CAD", units: 10, price: 10, amount: -100 }),
        a({ type: "SELL", tradeDate: "2026-03-03", symbol: "SYN", securityCurrency: "CAD", units: -10, price: 10, amount: 100 }),
      ];
      const r = await valueAccount({
        ...base, states: replay(activities, "0000-01-01", "2026-03-03"), reportingCurrency: "CAD", securityCurrencies: new Map([["SYN", "CAD"]]),
        market: market({ SYN: flat(["2026-03-02", "2026-03-03"], 10) }),
      });
      expect(r.inferredSymbols).toBe(0);
      expect(r.days.map((d) => [d.value, d.source])).toEqual([[0, "reconstructed"], [0, "reconstructed"]]);
    });

    it("an option row never triggers inference", async () => {
      const activities = [
        a({ type: "SELL", tradeDate: "2026-03-02", symbol: "SYN 2026-12 C", isOption: true, units: -1, amount: 30 }),
        a({ type: "OPTIONEXPIRATION", tradeDate: "2026-03-03", symbol: "SYN 2026-12 C", units: 1, amount: 0 }),
      ];
      const r = await valueAccount({
        ...base, states: replay(activities, "0000-01-01", "2026-03-03"), reportingCurrency: "CAD", securityCurrencies: new Map(), market: market({}),
      });
      expect(r.inferredSymbols).toBe(0);
      expect(r.finalUnits.size).toBe(0);
    });
  });

  describe("cash by type", () => {
    let k = 0;
    const a = (p: Partial<StoredActivity> & { type: string; tradeDate: string }): StoredActivity => ({
      snapTradeAccountId: "S", dedupeKey: `c${String(k++).padStart(4, "0")}`, symbol: null, securityCurrency: null, isOption: false, units: null, price: null,
      amount: null, fee: null, fxRate: null, currency: "CAD", settlementDate: null, description: null, ...p,
    });

    it("sums replayed cash deltas per type in reporting currency at each day's FX", async () => {
      const activities = [
        a({ type: "CONTRIBUTION", tradeDate: "2026-03-02", amount: 1000 }),
        a({ type: "CONTRIBUTION", tradeDate: "2026-03-03", amount: 200 }),
        a({ type: "DIVIDEND", tradeDate: "2026-03-02", amount: 10, currency: "USD" }),
        a({ type: "DIVIDEND", tradeDate: "2026-03-03", amount: 10, currency: "USD" }),
        a({ type: "SELL", tradeDate: "2026-03-03", symbol: "X 2026-12 C", isOption: true, units: -1, amount: 30 }),
        a({ type: "OPTIONEXPIRATION", tradeDate: "2026-03-03", symbol: "X 2026-12 C", units: 1, amount: 0 }),
        a({ type: "weird type/x@y", tradeDate: "2026-03-03", amount: 7 }),
        a({ type: "CREDIT_CARD", tradeDate: "2026-03-03", amount: 99 }),
      ];
      const r = await valueAccount({
        ...base, states: replay(activities, "0000-01-01", "2026-03-03"), reportingCurrency: "CAD", securityCurrencies: new Map(),
        market: market({}, pts({ "2026-03-02": 1.4, "2026-03-03": 1.5 })),
      });
      expect(Object.fromEntries(r.cashByType)).toEqual({
        CONTRIBUTION: 1200,
        DIVIDEND: 10 * 1.4 + 10 * 1.5,
        "OPTION:SELL": 30,
        OTHER: 7,
      });
    });

    it("conversion credits and synthetic counterpart debits get separate keys", async () => {
      const activities = [
        a({ type: "CONTRIBUTION", tradeDate: "2026-03-02", amount: 2000 }),
        a({ type: "FUNDS_CONVERSION", tradeDate: "2026-03-03", amount: 1000, currency: "USD" }),
      ];
      const r = await valueAccount({
        ...base, states: replay(activities, "0000-01-01", "2026-03-03"), reportingCurrency: "CAD", securityCurrencies: new Map(),
        market: market({}, pts({ "2026-03-02": 1.37, "2026-03-03": 1.37 })),
      });
      expect(r.cashByType.get("FUNDS_CONVERSION")).toBeCloseTo(1370, 6);
      expect(r.cashByType.get("FUNDS_CONVERSION_COUNTERPART")).toBeCloseTo(-1370, 6);
      expect(r.cashByType.get("CONTRIBUTION")).toBe(2000);
    });
  });

  it("F4: an explicit range overrides the per-account fetch window", async () => {
    calls.length = 0; fromArgs.length = 0;
    await valueAccount({
      ...base, states: [state("2026-01-05", { AAPL: 1 })], reportingCurrency: "CAD", securityCurrencies: new Map([["AAPL", "USD"]]),
      market: market({ AAPL: pts({ "2026-01-05": 1 }) }, pts({ "2026-01-05": 1.4 })), range: { from: "2025-06-01", to: "2026-01-05" },
    });
    expect(fromArgs).toEqual(["2025-06-01", "2025-06-01"]);
  });

  it("M1: FUNDS_CONVERSION debits at the activity's fxRate (either quoting direction) when present", async () => {
    for (const fxRate of [1.39, 1 / 1.39]) {
      const r = await valueAccount({
        ...base,
        states: [state("2026-01-05", {}, { CAD: 2000 }), state("2026-01-06", {}, { CAD: 2000, USD: 1000 }, [{ currency: "USD", amount: 1000, fxRate }])],
        reportingCurrency: "CAD", securityCurrencies: new Map(),
        market: market({}, pts({ "2026-01-05": 1.37, "2026-01-06": 1.37 })),
      });
      expect(r.days[1].value).toBeCloseTo(2000 - 1390 + 1370, 6);
    }
  });

  it("M2: two-sided conversion accounts get no synthetic counterpart debit", async () => {
    const r = await valueAccount({
      ...base, twoSidedConversions: true,
      states: [state("2026-01-06", {}, { CAD: 630, USD: 1000 }, [{ currency: "USD", amount: 1000 }])],
      reportingCurrency: "CAD", securityCurrencies: new Map(),
      market: market({}, pts({ "2026-01-06": 1.37 })),
    });
    expect(r.days[0].value).toBeCloseTo(630 + 1370, 6);
  });

  it("limits history concurrency to 4", async () => {
    const units: Record<string, number> = {}; const h: Record<string, Pt[]> = {};
    for (let i = 0; i < 10; i++) { units[`S${i}`] = 1; h[`S${i}`] = pts({ "2026-01-05": 1 }); }
    const track = { cur: 0, max: 0 };
    const r = await valueAccount({
      ...base, states: [state("2026-01-05", units)], reportingCurrency: "CAD",
      securityCurrencies: new Map(Object.keys(units).map((s) => [s, "CAD"])), market: market(h, null, track),
    });
    expect(track.max).toBeLessThanOrEqual(4);
    expect(track.max).toBeGreaterThan(1);
    expect(r.days[0].value).toBe(10);
  });

  it("looks back 10 days so a Sunday start finds Friday's close and FX", async () => {
    calls.length = 0; fromArgs.length = 0;
    const r = await valueAccount({
      ...base, states: [state("2026-01-04", { AAPL: 1 })], reportingCurrency: "CAD", securityCurrencies: new Map([["AAPL", "USD"]]),
      market: market({ AAPL: pts({ "2026-01-02": 100 }) }, pts({ "2026-01-02": 1.4 })),
    });
    expect(fromArgs).toEqual(["2025-12-25", "2025-12-25"]);
    expect(r.days[0]).toMatchObject({ value: 140, source: "reconstructed" });
  });

  it("3-day weekend gap stays reconstructed", async () => {
    const r = await valueAccount({
      ...base, states: [state("2026-01-05", { A: 1 })], reportingCurrency: "CAD", securityCurrencies: new Map([["A", "CAD"]]),
      market: market({ A: pts({ "2026-01-02": 7 }) }),
    });
    expect(r.days[0]).toMatchObject({ value: 7, source: "reconstructed" });
  });

  it("stale FX (>7 days) is estimated", async () => {
    const r = await valueAccount({
      ...base, states: [state("2026-01-05", { AAPL: 1 }), state("2026-01-14", { AAPL: 1 })], reportingCurrency: "CAD", securityCurrencies: new Map([["AAPL", "USD"]]),
      market: market({ AAPL: pts({ "2026-01-05": 10, "2026-01-14": 10 }) }, pts({ "2026-01-05": 1.5 })),
    });
    expect(r.days[0].source).toBe("reconstructed");
    expect(r.days[1]).toMatchObject({ value: 15, source: "estimated" });
  });

  it("conversion before any FX uses first rate, estimated, and stays sticky", async () => {
    const cash = { CAD: 5000, USD: 1500 };
    const run = (convDay: number) => valueAccount({
      ...base,
      states: [
        state("2026-01-12", {}, cash, convDay === 1 ? [{ currency: "USD", amount: 1000 }] : []),
        state("2026-01-13", {}, cash),
        state("2026-01-14", {}, cash, convDay === 3 ? [{ currency: "USD", amount: 1000 }] : []),
        state("2026-01-15", { H: 1 }, cash),
      ],
      reportingCurrency: "CAD", securityCurrencies: new Map([["H", "CAD"]]),
      market: market({ H: pts({ "2026-01-15": 10 }) }, pts({ "2026-01-14": 1.4, "2026-01-15": 1.4 })),
    });
    const early = await run(1);
    expect(early.days[0]).toMatchObject({ value: 5700, source: "estimated" });
    expect(early.days[3]).toMatchObject({ value: 5710, source: "estimated" });
    const control = await run(3);
    expect(control.days[2]).toMatchObject({ value: 5700, source: "reconstructed" });
    expect(control.days[3]).toMatchObject({ value: 5710, source: "reconstructed" });
  });

  it("fetches a shared ticker once", async () => {
    calls.length = 0;
    await valueAccount({
      ...base, states: [state("2026-01-05", { A: 1, B: 1 })], reportingCurrency: "CAD", securityCurrencies: new Map([["A", "CAD"], ["B", "CAD"]]),
      market: market({ T: pts({ "2026-01-05": 1 }) }), tickerFor: () => "T",
    });
    expect(calls).toEqual(["T"]);
  });

  it("USD account holding CAD security divides by FX", async () => {
    const r = await valueAccount({
      ...base, states: [state("2026-01-05", { X: 1 })], reportingCurrency: "USD", securityCurrencies: new Map([["X", "CAD"]]),
      market: market({ X: pts({ "2026-01-05": 140 }) }, pts({ "2026-01-05": 1.4 })),
    });
    expect(r.days[0]).toMatchObject({ value: 100, source: "reconstructed" });
  });

  describe("price overrides (sanity guard)", () => {
    it("values an overridden symbol at the given price, constant, every held day estimated, without fetching", async () => {
      calls.length = 0;
      const r = await valueAccount({
        ...base,
        states: [state("2026-01-05", { A: 2, B: 3 }, { CAD: 5 }), state("2026-01-06", { A: 2, B: 3 }, { CAD: 5 }), state("2026-01-07", { A: 2 }, { CAD: 305 })],
        reportingCurrency: "CAD", securityCurrencies: new Map([["A", "CAD"], ["B", "CAD"]]),
        market: market({ A: pts({ "2026-01-05": 10, "2026-01-06": 10, "2026-01-07": 10 }), B: pts({ "2026-01-05": 0.7 }) }, null, undefined, { B: [{ date: "2026-01-06", ratio: 4 }] }),
        priceOverrides: new Map([["B", { price: 100, currency: "CAD" }]]),
      });
      expect(r.days).toEqual([
        { date: "2026-01-05", currency: "CAD", value: 20 + 300 + 5, source: "estimated" },
        { date: "2026-01-06", currency: "CAD", value: 20 + 300 + 5, source: "estimated" },
        { date: "2026-01-07", currency: "CAD", value: 20 + 305, source: "reconstructed" },
      ]);
      expect(calls).not.toContain("B");
      expect(r.fetchFailed).toEqual([]);
      expect(r.missingSymbols).toEqual([]);
      expect(r.splitsApplied).toBe(false);
    });

    it("an overridden symbol is not fetch-failed even when its history would fail", async () => {
      const r = await valueAccount({
        ...base, states: [state("2026-01-05", { B: 1 })], reportingCurrency: "CAD", securityCurrencies: new Map([["B", "CAD"]]),
        market: market({ B: null }), priceOverrides: new Map([["B", { price: 99, currency: "CAD" }]]),
      });
      expect(r.fetchFailed).toEqual([]);
      expect(r.days[0]).toMatchObject({ value: 99, source: "estimated" });
      expect(r.last.holdings).toBe(99);
    });

    it("converts an override in another currency at the day's FX", async () => {
      const r = await valueAccount({
        ...base, states: [state("2026-01-05", { B: 2 })], reportingCurrency: "CAD", securityCurrencies: new Map([["B", "CAD"]]),
        market: market({}, pts({ "2026-01-05": 1.5 })), priceOverrides: new Map([["B", { price: 10, currency: "USD" }]]),
      });
      expect(r.days[0]).toMatchObject({ value: 30, source: "estimated" });
    });
  });
});
