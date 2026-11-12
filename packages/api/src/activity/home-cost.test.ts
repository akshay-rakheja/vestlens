import { describe, expect, it } from "vitest";
import { homeConverter } from "../fx/home-currency.js";
import type { StoredActivity } from "../history/stored-activity.js";
import { homeCostReplay } from "./home-cost.js";

let n = 0;
const act = (over: Partial<StoredActivity>): StoredActivity => ({
  snapTradeAccountId: "RRSP", dedupeKey: `k${String(++n).padStart(5, "0")}`, type: "BUY", symbol: "ASTS", securityCurrency: "USD", isOption: false,
  units: 10, price: null, amount: null, fee: null, fxRate: null, currency: "CAD", tradeDate: "2026-03-02", settlementDate: "2026-03-02", description: null, ...over,
});
const conv = homeConverter([
  { date: "2026-04-01", close: 1.4 },
  { date: "2026-05-26", close: 1.3712 },
  { date: "2026-10-16", close: 1.38 },
], "2026-10-16");

// Owner's ASTS case, hand-computed (brief Step 1).
const asts = () => [
  act({ tradeDate: "2026-03-02", units: 10, price: 96.39, amount: -963.9, currency: "CAD" }),
  act({ tradeDate: "2026-03-09", units: 10, price: 119.067, amount: -1190.67, currency: "CAD" }),
  act({ tradeDate: "2026-04-01", units: 10, price: 81.9, amount: -819, currency: "USD" }),
  act({ type: "SELL", tradeDate: "2026-05-26", units: -20, price: 116, amount: 2320, currency: "USD" }),
];

describe("homeCostReplay", () => {
  it("replays the ASTS case: CAD buys exact, USD buy and sell at the BoC rate", () => {
    const r = homeCostReplay(asts(), [], conv, "RRSP", "ASTS");
    expect(r.accountId).toBe("RRSP");
    expect(r.units).toBe(10);
    expect(r.avgCostCad).toBeCloseTo(110.039, 4);
    expect(r.costCad).toBe(1100.39);
    expect(r.realizedCad).toBe(980.4);
    expect(r.estimated).toBe(true);
    expect(r.complete).toBe(true);
  });

  it("is exact when every amount is in CAD", () => {
    const rows = [
      act({ securityCurrency: "CAD", symbol: "VFV", units: 10, amount: -1000 }),
      act({ securityCurrency: "CAD", symbol: "VFV", type: "SELL", tradeDate: "2026-04-01", units: -4, amount: 480 }),
    ];
    const r = homeCostReplay(rows, [], conv, "RRSP", "vfv");
    expect(r).toMatchObject({ units: 6, costCad: 600, realizedCad: 80, estimated: false, complete: true });
  });

  it("only reads the given account and symbol, and skips option rows", () => {
    const rows = [...asts(), act({ snapTradeAccountId: "TFSA", units: 99, amount: -5000 }), act({ symbol: "HOOD", units: 5, amount: -500 }), act({ isOption: true, units: 3, amount: -30 })];
    const r = homeCostReplay(rows, [], conv, "RRSP", "ASTS");
    expect(r.units).toBe(10);
    expect(r.realizedCad).toBe(980.4);
  });

  it("treats REI as a buy at its amount", () => {
    const rows = [
      act({ securityCurrency: "CAD", symbol: "VFV", units: 10, amount: -1000 }),
      act({ securityCurrency: "CAD", symbol: "VFV", type: "REI", units: 1, amount: 120 }),
    ];
    const r = homeCostReplay(rows, [], conv, "RRSP", "VFV");
    expect(r).toMatchObject({ units: 11, costCad: 1120, complete: true });
  });

  it("splits change units, not CAD cost", () => {
    const rows = [
      act({ securityCurrency: "CAD", symbol: "VFV", tradeDate: "2026-01-05", units: 10, amount: -1000 }),
      act({ securityCurrency: "CAD", symbol: "VFV", type: "SELL", tradeDate: "2026-06-01", units: -10, amount: 600 }),
    ];
    const r = homeCostReplay(rows, [{ date: "2026-03-01", ratio: 2 }], conv, "RRSP", "VFV");
    expect(r).toMatchObject({ units: 10, costCad: 500, realizedCad: 100, complete: true });
    expect(r.avgCostCad).toBeCloseTo(50);
  });

  it("a fully sold symbol whose only buy is a transfer-in with no cost is incomplete", () => {
    const rows = [
      act({ type: "TRANSFER", units: 10, price: null, amount: 0, currency: "USD" }),
      act({ type: "SELL", tradeDate: "2026-05-26", units: -10, price: 116, amount: 1160, currency: "USD" }),
    ];
    const r = homeCostReplay(rows, [], conv, "RRSP", "ASTS");
    expect(r.complete).toBe(false);
    expect(r.units).toBe(0);
    expect(r.costCad).toBeNull();
  });

  it("a USD buy with no rate within 7 days makes the history incomplete", () => {
    const rows = [act({ tradeDate: "2026-04-20", units: 10, amount: -819, currency: "USD" })];
    const r = homeCostReplay(rows, [], conv, "RRSP", "ASTS");
    expect(r).toMatchObject({ complete: false, avgCostCad: null, costCad: null });
  });

  it("an oversell is incomplete", () => {
    const rows = [act({ units: 5, amount: -500 }), act({ type: "SELL", tradeDate: "2026-04-01", units: -10, amount: 1000 })];
    expect(homeCostReplay(rows, [], conv, "RRSP", "ASTS").complete).toBe(false);
  });

  it("falls back to units × price when the amount is missing", () => {
    const rows = [act({ securityCurrency: "CAD", symbol: "VFV", units: 10, price: 100, amount: null })];
    expect(homeCostReplay(rows, [], conv, "RRSP", "VFV")).toMatchObject({ costCad: 1000, complete: true });
  });

  it("no rows: nothing held, complete", () => {
    expect(homeCostReplay([], [], conv, "RRSP", "ASTS")).toEqual({ accountId: "RRSP", units: 0, avgCostCad: null, costCad: null, realizedCad: 0, estimated: false, complete: true });
  });
});
