import { describe, expect, it } from "vitest";
import { benchmarkClosesCad, holdingFlows, replayIntoBenchmark, returnSince, shadowBasis } from "./shadow-benchmark.js";
import { homeConverter } from "../fx/home-currency.js";
import type { StoredActivity } from "../history/stored-activity.js";

const act = (over: Partial<StoredActivity>): StoredActivity => ({
  snapTradeAccountId: "acc-1", dedupeKey: `k-${Math.random()}`, type: "BUY", symbol: "SHOP", securityCurrency: "CAD", isOption: false,
  units: null, price: null, amount: null, fee: null, fxRate: null, currency: "CAD", tradeDate: "2026-03-02", settlementDate: null, description: null, ...over,
});

describe("replayIntoBenchmark", () => {
  const series = [
    { date: "2026-03-02", closeCad: 100 },
    { date: "2026-08-03", closeCad: 120 },
    { date: "2026-09-01", closeCad: 125 },
    { date: "2026-10-23", closeCad: 150 },
  ];
  it("replays dated buys into the benchmark (hand-computed)", () => {
    // 2000/100 = 20 units, 1500/120 = 12.5 units; 32.5 × 150 = 4875.
    const r = replayIntoBenchmark([{ date: "2026-03-02", amountCad: -2_000 }, { date: "2026-08-03", amountCad: -1_500 }], series, "2026-10-23");
    expect(r).toEqual({ valueCad: 4_875, investedCad: 3_500, withdrawnCad: 0, estimated: false, uncovered: [], shadowExhausted: false });
  });
  it("a sale withdraws from the shadow", () => {
    // 32.5 − 1000/125 = 24.5 units; × 150 = 3675.
    const r = replayIntoBenchmark([
      { date: "2026-03-02", amountCad: -2_000 }, { date: "2026-08-03", amountCad: -1_500 }, { date: "2026-09-01", amountCad: 1_000 },
    ], series, "2026-10-23");
    expect(r.valueCad).toBeCloseTo(3_675, 9);
    expect(r.withdrawnCad).toBe(1_000);
  });
  it("uses the last close on or before a weekend flow, and ignores flows after asOf", () => {
    const r = replayIntoBenchmark([{ date: "2026-03-07", amountCad: -1_000 }, { date: "2026-10-24", amountCad: -5 }], series, "2026-10-23");
    expect(r.valueCad).toBeCloseTo(1_500, 9);
    expect(r.investedCad).toBe(1_000);
  });
  it("flags (but never clamps) a shadow exhausted by withdrawals larger than its value", () => {
    // 1000/100 = 10 units; 3000/150 = 20 units withdrawn: −10 × 150 = −1500.
    const r = replayIntoBenchmark([{ date: "2026-03-02", amountCad: -1_000 }, { date: "2026-10-23", amountCad: 3_000 }], series, "2026-10-23");
    expect(r.valueCad).toBeCloseTo(-1_500, 9);
    expect(r.shadowExhausted).toBe(true);
  });
  it("flags a shadow exhausted mid-way even when later buys refill it", () => {
    const r = replayIntoBenchmark([
      { date: "2026-03-02", amountCad: -1_000 }, { date: "2026-08-03", amountCad: 2_400 }, { date: "2026-09-01", amountCad: -5_000 },
    ], series, "2026-10-23");
    expect(r.valueCad!).toBeGreaterThan(0);
    expect(r.shadowExhausted).toBe(true);
  });
  it("uses a close exactly 7 days before a flow, but not one 8 days before", () => {
    const s7 = [{ date: "2026-03-02", closeCad: 100 }, { date: "2026-03-20", closeCad: 100 }];
    expect(replayIntoBenchmark([{ date: "2026-03-09", amountCad: -100 }], s7, "2026-03-20")).toMatchObject({ valueCad: 100, uncovered: [] });
    expect(replayIntoBenchmark([{ date: "2026-03-10", amountCad: -100 }], s7, "2026-03-20")).toMatchObject({ valueCad: null, uncovered: ["2026-03-10"] });
    expect(replayIntoBenchmark([{ date: "2026-03-02", amountCad: -100 }], s7, "2026-03-28")).toMatchObject({ valueCad: null, uncovered: ["2026-03-28"] });
    expect(replayIntoBenchmark([{ date: "2026-03-02", amountCad: -100 }], s7, "2026-03-27").valueCad).toBe(100);
  });
  it("carries estimated from a converted close or flow", () => {
    expect(replayIntoBenchmark([{ date: "2026-03-02", amountCad: -100 }], [{ date: "2026-03-02", closeCad: 100, estimated: true }, { date: "2026-03-03", closeCad: 110 }], "2026-03-03").estimated).toBe(true);
    expect(replayIntoBenchmark([{ date: "2026-03-02", amountCad: -100, estimated: true }], series, "2026-10-23").estimated).toBe(true);
  });
  it("is not valued when a flow has no close within 7 days before it", () => {
    const r = replayIntoBenchmark([{ date: "2026-02-01", amountCad: -100 }, { date: "2026-03-02", amountCad: -100 }], series, "2026-10-23");
    expect(r.valueCad).toBeNull();
    expect(r.uncovered).toEqual(["2026-02-01"]);
    expect(replayIntoBenchmark([{ date: "2026-03-02", amountCad: -100 }], series, "2026-12-31")).toMatchObject({ valueCad: null, uncovered: ["2026-12-31"] });
  });
});

describe("benchmarkClosesCad", () => {
  const market = (prices: Array<{ date: string; close: number }>, fx: Array<{ date: string; close: number }> | null) => ({
    calls: [] as string[],
    async history(ticker: string) { this.calls.push(ticker); return prices; },
    async usdCad() { return fx; },
  });
  it("converts the S&P 500 to CAD at each date's BoC rate (nearest previous within 7 days), marked est.", async () => {
    const m = market(
      [{ date: "2026-03-02", close: 5_000 }, { date: "2026-03-06", close: 5_100 }, { date: "2026-03-20", close: 5_200 }],
      [{ date: "2026-03-02", close: 1.4 }, { date: "2026-03-05", close: 1.35 }, { date: "2026-03-12", close: 1.3 }],
    );
    const r = await benchmarkClosesCad(m, "sp500", "2026-03-02", "2026-03-20");
    expect(m.calls).toEqual(["^SP500TR"]);
    expect(r.basis).toBe("total_return");
    expect(r.points).toEqual([
      { date: "2026-03-02", closeCad: 7_000, estimated: true, rateDate: "2026-03-02" },
      { date: "2026-03-06", closeCad: 6_885, estimated: true, rateDate: "2026-03-05" },
    ]);
    // 2026-03-20 is 8 days after the last rate: not converted, listed.
    expect(r.notConverted).toEqual(["2026-03-20"]);
  });
  it("uses the TSX in CAD as is, not estimated", async () => {
    const r = await benchmarkClosesCad(market([{ date: "2026-03-02", close: 25_000 }], null), "tsx", "2026-03-02", "2026-03-02");
    expect(r.points).toEqual([{ date: "2026-03-02", closeCad: 25_000, estimated: false, rateDate: null }]);
    expect(r.notConverted).toEqual([]);
  });
  it("states each series' basis: the S&P 500 reinvests dividends, the TSX is a price index", () => {
    expect(shadowBasis("sp500")).toBe("total_return");
    expect(shadowBasis("tsx")).toBe("price_index");
  });
});

describe("returnSince", () => {
  it("is null with no_start_value when the start value is missing", () => {
    expect(returnSince("2026-03-02", null, [], 1_000, { endDate: "2026-10-23", coverageStart: "2026-01-01" })).toEqual({ pct: null, reason: "no_start_value" });
  });
  it("is null with no_coverage when the start is before stored activity coverage", () => {
    expect(returnSince("2026-03-02", 1_000, [], 1_100, { endDate: "2026-10-23", coverageStart: "2026-04-01" })).toEqual({ pct: null, reason: "no_coverage" });
    expect(returnSince("2026-03-02", 1_000, [], 1_100, { endDate: "2026-10-23", coverageStart: null })).toEqual({ pct: null, reason: "no_coverage" });
  });
  it("requires coverageStart: omitting it is a type error, and null (unknown coverage) is never a number", () => {
    // @ts-expect-error coverageStart is required (Review Focus 2: a caller cannot skip the coverage check).
    expect(returnSince("2026-03-02", 1_000, [], 1_100, { endDate: "2026-10-23" }).pct).toBeNull();
    expect(returnSince("2026-03-02", 1_000, [], 1_100, { endDate: "2026-10-23", coverageStart: null })).toEqual({ pct: null, reason: "no_coverage" });
  });
  it("without flows is the value change", () => {
    expect(returnSince("2026-03-02", 1_000, [], 1_100, { endDate: "2026-10-23", coverageStart: "2026-03-02" }).pct).toBeCloseTo(10, 6);
  });
  it("is money-weighted on the flows after the start only", () => {
    // Start 1000, +1000 bought halfway, end 2200: the period rate r solves -1000 -1000/(1+r)^0.5 + 2200/(1+r) = 0.
    const flows = [{ date: "2026-01-01", amountCad: -999 }, { date: "2026-07-02", amountCad: -1_000 }];
    const r = returnSince("2026-01-01", 1_000, flows, 2_200, { endDate: "2026-12-31", coverageStart: "2025-06-01" });
    const t = (Date.parse("2026-07-02") - Date.parse("2026-01-01")) / (Date.parse("2026-12-31") - Date.parse("2026-01-01"));
    const x = r.pct! / 100;
    expect(-1_000 - 1_000 / (1 + x) ** t + 2_200 / (1 + x)).toBeCloseTo(0, 6);
    expect(r.pct!).toBeGreaterThan(10);
  });
  it("counts proceeds of a full sale (end value 0)", () => {
    const r = returnSince("2026-01-01", 1_000, [{ date: "2026-12-31", amountCad: 1_200 }], 0, { endDate: "2026-12-31", coverageStart: "2026-01-01" });
    expect(r.pct).toBeCloseTo(20, 6);
  });
});

describe("holdingFlows", () => {
  const fx = homeConverter([{ date: "2026-03-02", close: 1.4 }], "2026-10-23");
  it("signs buys negative and sales and dividends positive, in CAD", () => {
    const r = holdingFlows([
      act({ type: "BUY", amount: -2_000, units: 10, price: 200 }),
      act({ type: "SELL", amount: 500, units: -2, price: 250, tradeDate: "2026-05-01" }),
      act({ type: "DIVIDEND", amount: 12, tradeDate: "2026-06-01" }),
      act({ type: "BUY", symbol: "OTHER", amount: -50 }),
      act({ type: "BUY", symbol: "SHOP", isOption: true, amount: -50 }),
    ], "shop", undefined, { fx });
    expect(r.flows.map((f) => [f.date, f.kind, f.amountCad, f.estimated])).toEqual([
      ["2026-03-02", "buy", -2_000, false], ["2026-05-01", "sell", 500, false], ["2026-06-01", "dividend", 12, false],
    ]);
    expect(r.excluded).toEqual([]);
    // Signed units moved by each flow (a dividend moves none).
    expect(r.flows.map((f) => f.units)).toEqual([10, -2, 0]);
  });
  it("marks a trade with no amount or no date, and an untracked transfer out, as moving units", () => {
    const r = holdingFlows([
      act({ type: "SELL", amount: null, units: -3, price: null, tradeDate: "2026-05-01" }),
      act({ type: "BUY", amount: -100, units: 1, tradeDate: null, settlementDate: null }),
      act({ type: "TRANSFER", units: -5, price: null, tradeDate: "2026-06-01" }),
    ], "SHOP", undefined, { fx });
    expect(r.excluded).toEqual([
      { date: "2026-05-01", reason: "no amount", unitsMoved: true },
      { date: null, reason: "no purchase date", unitsMoved: true },
      { date: "2026-06-01", reason: "no purchase date", unitsMoved: true },
    ]);
  });
  it("converts at the activity's fxRate, else at the BoC rate (est.)", () => {
    const r = holdingFlows([
      act({ type: "BUY", currency: "USD", securityCurrency: "USD", amount: -100, fxRate: 1.38 }),
      act({ type: "BUY", currency: "USD", securityCurrency: "USD", amount: -100, tradeDate: "2026-03-03" }),
    ], "SHOP", undefined, { fx });
    expect(r.flows[0]).toMatchObject({ amountCad: -138, estimated: false, rateDate: null, native: { amount: -100, currency: "USD" } });
    expect(r.flows[1]).toMatchObject({ amountCad: -140, estimated: true, rateDate: "2026-03-02" });
  });
  it("lists a USD flow with no rate as not converted, never guessing", () => {
    const r = holdingFlows([act({ type: "BUY", currency: "USD", amount: -100, tradeDate: "2026-04-01" })], "SHOP", undefined, { fx });
    expect(r.flows).toEqual([]);
    expect(r.excluded).toEqual([{ date: "2026-04-01", reason: "not converted", unitsMoved: true }]);
    // A foreign dividend that can't be converted is cash only: no shares moved.
    const d = holdingFlows([act({ type: "DIVIDEND", currency: "USD", amount: 3, tradeDate: "2026-04-01" })], "SHOP", undefined, { fx });
    expect(d.excluded).toEqual([{ date: "2026-04-01", reason: "not converted", unitsMoved: false }]);
  });
  it("excludes and lists a transfer with no date or no cost; values one with both", () => {
    const r = holdingFlows([
      act({ type: "TRANSFER", units: 5, price: null, tradeDate: null, settlementDate: null }),
      act({ type: "TRANSFER", units: 5, price: null, tradeDate: "2026-04-01" }),
      act({ type: "TRANSFER", units: 5, price: 100, tradeDate: "2026-04-02" }),
    ], "SHOP", undefined, { fx });
    expect(r.excluded).toEqual([{ date: null, reason: "no purchase date", unitsMoved: true }, { date: "2026-04-01", reason: "no purchase date", unitsMoved: true }]);
    expect(r.flows).toEqual([expect.objectContaining({ date: "2026-04-02", kind: "transfer_in", amountCad: -500 })]);
  });
  it("lists a dividend with no date as \"no date\", not \"no purchase date\"", () => {
    const r = holdingFlows([act({ type: "DIVIDEND", amount: 12, tradeDate: null, settlementDate: null })], "SHOP", undefined, { fx });
    expect(r).toEqual({ flows: [], excluded: [{ date: null, reason: "no date", unitsMoved: false }] });
  });
  it("keeps only flows on or after `from`, and only the asked listing currency", () => {
    const rows = [
      act({ type: "BUY", amount: -100, tradeDate: "2026-03-01" }),
      act({ type: "BUY", amount: -200, tradeDate: "2026-05-01" }),
      act({ type: "BUY", currency: "USD", securityCurrency: "USD", amount: -300, fxRate: 1.4, tradeDate: "2026-05-01" }),
    ];
    expect(holdingFlows(rows, "SHOP", "2026-04-01", { fx }).flows.map((f) => f.amountCad)).toEqual([-200, -420]);
    expect(holdingFlows(rows, "SHOP", "2026-04-01", { fx, currency: "CAD" }).flows.map((f) => f.amountCad)).toEqual([-200]);
  });
});
