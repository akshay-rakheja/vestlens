import { describe, expect, it } from "vitest";
import type { StoredActivity } from "../history/stored-activity.js";
import { groupBySymbolCurrency, symbolPosition } from "./symbol-position.js";
import { tradePriceConverter } from "./trade-price.js";

let n = 0;
const row = (type: string, date: string, o: Partial<StoredActivity> = {}): StoredActivity => ({
  snapTradeAccountId: "A", dedupeKey: `k${String(++n).padStart(4, "0")}`, type, symbol: "VFV", securityCurrency: "CAD",
  isOption: false, units: null, price: null, amount: null, fee: null, fxRate: null, currency: "CAD",
  tradeDate: date, settlementDate: date, description: null, ...o,
});
const buy = (date: string, units: number, price: number | null, o: Partial<StoredActivity> = {}) =>
  row("BUY", date, { units, price, amount: price === null ? null : -units * price, ...o });
const sell = (date: string, units: number, price: number | null, o: Partial<StoredActivity> = {}) =>
  row("SELL", date, { units: -units, price, amount: price === null ? null : units * price, ...o });
const noPrice = () => null;

describe("symbolPosition", () => {
  it("averages cost across buys", () => {
    const p = symbolPosition([buy("2026-01-01", 10, 100), buy("2026-02-01", 10, 120)], [], noPrice);
    expect(p.units).toBe(20);
    expect(p.avgCost).toBeCloseTo(110);
    expect(p.avgCostEstimated).toBe(false);
    expect(p.reason).toBeUndefined();
    expect(p.currency).toBe("CAD");
    expect(p.points).toEqual([
      { date: "2026-01-01", units: 10, avgCost: 100 },
      { date: "2026-02-01", units: 20, avgCost: expect.closeTo(110) },
    ]);
  });

  it("keeps avgCost on a sell", () => {
    const p = symbolPosition([buy("2026-01-01", 10, 100), buy("2026-02-01", 10, 120), sell("2026-03-01", 5, 130)], [], noPrice);
    expect(p.units).toBe(15);
    expect(p.avgCost).toBeCloseTo(110);
  });

  it("applies a split before a later sell", () => {
    const p = symbolPosition(
      [buy("2026-01-01", 10, 100), buy("2026-02-01", 10, 120), sell("2026-02-15", 5, 130), sell("2026-04-01", 10, 60)],
      [{ date: "2026-03-01", ratio: 2 }], noPrice,
    );
    // 20 -> sell 5 = 15 -> split 2:1 = 30 -> sell 10 = 20
    expect(p.units).toBe(20);
    expect(p.avgCost).toBeCloseTo(55);
    expect(p.avgCostEstimated).toBe(true);
  });

  it("applies splits dated after the last row to the final holding", () => {
    const p = symbolPosition([buy("2026-01-01", 10, 100)], [{ date: "2026-03-01", ratio: 2 }], noPrice);
    expect(p.units).toBe(20);
    expect(p.avgCost).toBeCloseTo(50);
    expect(p.avgCostEstimated).toBe(true);
  });

  it("does not flag a split that predates any holding", () => {
    const p = symbolPosition([buy("2026-02-01", 10, 100)], [{ date: "2026-01-01", ratio: 2 }], noPrice);
    expect(p.units).toBe(10);
    expect(p.avgCost).toBe(100);
    expect(p.avgCostEstimated).toBe(false);
  });

  it("keeps the holding when raw units reach zero only after a split (case A)", () => {
    const p = symbolPosition([buy("2026-01-01", 10, 100), sell("2026-03-01", 20, 60)], [{ date: "2026-02-01", ratio: 2 }], noPrice);
    expect(p.units).toBe(0);
    expect(p.reason).toBeUndefined();
  });

  it("restarts cost at the new lot after raw units hit zero then a split (case B)", () => {
    const p = symbolPosition(
      [buy("2026-01-01", 10, 100), sell("2026-02-01", 10, 110), buy("2026-04-01", 5, 40)],
      [{ date: "2026-03-01", ratio: 2 }], noPrice,
    );
    expect(p.units).toBe(5);
    expect(p.avgCost).toBe(40);
    expect(p.reason).toBeUndefined();
  });

  it("excludes option rows from position, markers and grouping", () => {
    const opt = buy("2026-01-05", 3, 2, { isOption: true });
    const optSell = sell("2026-01-06", 3, 3, { isOption: true });
    const p = symbolPosition([buy("2026-01-01", 10, 100), opt, optSell], [], noPrice);
    expect(p.units).toBe(10);
    expect(p.avgCost).toBe(100);
    expect(p.reason).toBeUndefined();
    expect(p.markers).toHaveLength(1);
    expect(p.points).toHaveLength(1);
    expect(symbolPosition([opt], [], noPrice).currency).toBeNull();
    const g = groupBySymbolCurrency([opt, buy("2026-01-01", 1, 1)]);
    expect(g.get("VFV|CAD")).toHaveLength(1);
    expect(groupBySymbolCurrency([opt]).size).toBe(0);
  });

  it("does not use marketPrice for CORPORATE_ACTION receipts", () => {
    const p = symbolPosition([row("CORPORATE_ACTION", "2026-01-01", { units: 5 })], [], () => 50);
    expect(p.units).toBe(5);
    expect(p.avgCost).toBeNull();
    expect(p.avgCostEstimated).toBe(true);
  });

  it("processes same-day buys before sells regardless of dedupeKey", () => {
    const s1 = sell("2026-02-01", 10, 100, { dedupeKey: "a-sell" });
    const b1 = buy("2026-02-01", 10, 100, { dedupeKey: "z-buy" });
    const p = symbolPosition([s1, buy("2026-01-01", 10, 100), b1], [], noPrice);
    expect(p.units).toBe(10);
    expect(p.reason).toBeUndefined();
    const q = symbolPosition([b1, s1], [], noPrice);
    expect(q.units).toBe(0);
    expect(q.reason).toBeUndefined();
  });

  it("treats a SELL reported with positive units as a sell", () => {
    const p = symbolPosition([buy("2026-01-01", 10, 100), row("SELL", "2026-02-01", { units: 4, price: 110, amount: 440 })], [], noPrice);
    expect(p.units).toBe(6);
    expect(p.avgCost).toBe(100);
    expect(p.markers[1]).toEqual({ date: "2026-02-01", side: "sell", units: 4, price: 110 });
  });

  it("keeps avgCost null through a partial sell", () => {
    const p = symbolPosition([buy("2026-01-01", 10, null), sell("2026-02-01", 4, 100)], [], noPrice);
    expect(p.units).toBe(6);
    expect(p.avgCost).toBeNull();
    expect(p.avgCostEstimated).toBe(true);
    expect(p.reason).toBeUndefined();
  });

  it("applies a reverse split", () => {
    const p = symbolPosition([buy("2026-01-01", 10, 10)], [{ date: "2026-02-01", ratio: 0.5 }], noPrice);
    expect(p.units).toBe(5);
    expect(p.avgCost).toBeCloseTo(20);
    expect(p.avgCostEstimated).toBe(true);
  });

  it("applies a split before a row dated on the split date", () => {
    const p = symbolPosition([buy("2026-01-01", 10, 100), sell("2026-02-01", 20, 60)], [{ date: "2026-02-01", ratio: 2 }], noPrice);
    expect(p.units).toBe(0);
    expect(p.reason).toBeUndefined();
  });

  it("flags an oversell as inconsistent", () => {
    const p = symbolPosition([buy("2026-01-01", 10, 100), sell("2026-02-01", 15, 100)], [], noPrice);
    expect(p.reason).toBe("inconsistent");
    expect(p.avgCost).toBeNull();
    expect(p.units).toBe(0);
  });

  it("uses marketPrice for an unpriced in-kind transfer", () => {
    const p = symbolPosition([row("TRANSFER", "2026-01-01", { units: 5 })], [], (d) => (d === "2026-01-01" ? 50 : null));
    expect(p.units).toBe(5);
    expect(p.avgCost).toBe(50);
    expect(p.avgCostEstimated).toBe(true);
  });

  it("uses a transfer's own price without estimating", () => {
    const p = symbolPosition([row("TRANSFER", "2026-01-01", { units: 5, price: 40 })], [], () => 50);
    expect(p.avgCost).toBe(40);
    expect(p.avgCostEstimated).toBe(false);
  });

  it("leaves cost unknown for an unpriced transfer with no market price", () => {
    const p = symbolPosition([row("TRANSFER", "2026-01-01", { units: 5 })], [], noPrice);
    expect(p.units).toBe(5);
    expect(p.avgCost).toBeNull();
    expect(p.avgCostEstimated).toBe(true);
  });

  it("gives null estimated avgCost for a BUY with no price, and stays null while held", () => {
    const p = symbolPosition([buy("2026-01-01", 10, null), buy("2026-02-01", 10, 120)], [], noPrice);
    expect(p.units).toBe(20);
    expect(p.avgCost).toBeNull();
    expect(p.avgCostEstimated).toBe(true);
  });

  it("recomputes cost after the holding returns to zero", () => {
    const p = symbolPosition([buy("2026-01-01", 10, null), sell("2026-02-01", 10, 5), buy("2026-03-01", 4, 20)], [], noPrice);
    expect(p.units).toBe(4);
    expect(p.avgCost).toBe(20);
  });

  it("treats REINVEST as a priced buy", () => {
    const p = symbolPosition([buy("2026-01-01", 10, 100), row("REINVEST", "2026-02-01", { units: 1, price: 120, amount: -120 })], [], noPrice);
    expect(p.units).toBe(11);
    expect(p.avgCost).toBeCloseTo((1000 + 120) / 11);
  });

  it("sums positive dividend-like cash", () => {
    const p = symbolPosition(
      [
        buy("2026-01-01", 10, 100),
        row("DIVIDEND", "2026-02-01", { amount: 12.5 }),
        row("DISTRIBUTION", "2026-03-01", { amount: 2.5 }),
        row("REI", "2026-04-01", { amount: 1 }),
        row("FEE", "2026-04-02", { amount: -1 }),
      ],
      [], noPrice,
    );
    expect(p.dividends).toBeCloseTo(16);
  });

  it("emits markers for BUY and SELL only", () => {
    const p = symbolPosition(
      [buy("2026-01-01", 10, 100), row("DIVIDEND", "2026-01-15", { amount: 1 }), sell("2026-02-01", 4, null)],
      [], noPrice,
    );
    expect(p.markers).toEqual([
      { date: "2026-01-01", side: "buy", units: 10, price: 100 },
      { date: "2026-02-01", side: "sell", units: 4, price: null },
    ]);
  });

  it("orders same-day rows by dedupeKey and input order does not matter", () => {
    const a = buy("2026-01-01", 10, 100, { dedupeKey: "a" });
    const b = sell("2026-01-01", 10, 100, { dedupeKey: "b" });
    expect(symbolPosition([b, a], [], noPrice).reason).toBeUndefined();
    expect(symbolPosition([a, b], [], noPrice).units).toBe(0);
  });

  it("handles an empty row set", () => {
    const p = symbolPosition([], [], noPrice);
    expect(p).toMatchObject({ currency: null, units: 0, avgCost: null, dividends: 0, points: [], markers: [] });
  });
});

describe("symbolPosition per account (I1)", () => {
  it("replays each account separately and combines units and cost", () => {
    const p = symbolPosition([
      buy("2026-01-01", 10, 100, { snapTradeAccountId: "TFSA" }),
      buy("2026-02-01", 10, 200, { snapTradeAccountId: "RRSP" }),
      sell("2026-03-01", 10, 150, { snapTradeAccountId: "TFSA" }),
    ], [], noPrice);
    expect(p.units).toBe(10);
    expect(p.avgCost).toBeCloseTo(200);
    expect(p.reason).toBeUndefined();
    expect(p.points.map((x) => [x.date, x.units, x.avgCost])).toEqual([
      ["2026-01-01", 10, 100], ["2026-02-01", 20, 150], ["2026-03-01", 10, 200],
    ]);
    expect(p.markers.map((m) => m.date)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });

  it("flags a sell in an account with no recorded units even when another account holds units", () => {
    const p = symbolPosition([
      buy("2026-01-01", 10, 100, { snapTradeAccountId: "RRSP" }),
      sell("2026-02-01", 5, 120, { snapTradeAccountId: "TFSA" }),
    ], [], noPrice);
    expect(p.units).toBe(10);
    expect(p.reason).toBe("inconsistent");
    expect(p.avgCost).toBeNull();
  });

  it("nulls the combined average when an account holding units has no cost", () => {
    const p = symbolPosition([
      buy("2026-01-01", 10, 100, { snapTradeAccountId: "RRSP" }),
      row("TRANSFER", "2026-02-01", { snapTradeAccountId: "TFSA", units: 5 }),
    ], [], noPrice);
    expect(p.units).toBe(15);
    expect(p.avgCost).toBeNull();
    expect(p.avgCostEstimated).toBe(true);
  });
});

describe("symbolPosition resets after a position closes (I9)", () => {
  it("after an oversell, a fresh buy gives an estimated cost (history gap, shares likely still held)", () => {
    const p = symbolPosition([buy("2026-01-01", 10, 100), sell("2026-02-01", 15, 100), buy("2026-03-01", 5, 50)], [], noPrice);
    expect(p.units).toBe(5);
    expect(p.avgCost).toBe(50);
    expect(p.reason).toBeUndefined();
    expect(p.avgCostEstimated).toBe(true);
  });

  it("a clean close after an oversell clears the gap for the next lot", () => {
    const p = symbolPosition([
      buy("2026-01-01", 10, 100), sell("2026-02-01", 15, 100), buy("2026-03-01", 5, 50), sell("2026-04-01", 5, 60), buy("2026-05-01", 2, 70),
    ], [], noPrice);
    expect(p.avgCost).toBe(70);
    expect(p.avgCostEstimated).toBe(false);
  });

  it("resets estimated after the holding returns to zero", () => {
    const p = symbolPosition([buy("2026-01-01", 10, null), sell("2026-02-01", 10, 5), buy("2026-03-01", 4, 20)], [], noPrice);
    expect(p.avgCostEstimated).toBe(false);
  });

  it("has no average cost once the position is closed", () => {
    const p = symbolPosition([buy("2026-01-01", 10, 100), sell("2026-02-01", 10, 120)], [], noPrice);
    expect(p.units).toBe(0);
    expect(p.avgCost).toBeNull();
    expect(p.points.at(-1)).toEqual({ date: "2026-02-01", units: 0, avgCost: null });
  });
});

describe("symbolPosition dividends per currency (I3)", () => {
  it("sums only dividends paid in the group currency and lists the rest separately", () => {
    const p = symbolPosition([
      buy("2026-01-01", 10, 200, { securityCurrency: "USD", currency: "CAD", fxRate: 1.38, amount: -2000 }),
      row("DIVIDEND", "2026-02-01", { securityCurrency: "USD", currency: "CAD", amount: 6.9 }),
      row("DIVIDEND", "2026-03-01", { securityCurrency: "USD", currency: "USD", amount: 5 }),
      row("DIVIDEND", "2026-04-01", { securityCurrency: "USD", currency: "CAD", amount: 7.1 }),
    ], [], noPrice, "USD");
    expect(p.currency).toBe("USD");
    expect(p.dividends).toBeCloseTo(5);
    expect(p.otherDividends).toEqual([{ currency: "CAD", amount: 14 }]);
    // The trade price is in the row currency (CAD); without a converter the reported rate applies.
    expect(p.avgCost).toBeCloseTo(200 / 1.38, 6);
  });

  it("has no other-currency dividends in the common case", () => {
    const p = symbolPosition([buy("2026-01-01", 1, 1), row("DIVIDEND", "2026-02-01", { amount: 2 })], [], noPrice);
    expect(p.otherDividends).toEqual([]);
  });
});

describe("groupBySymbolCurrency", () => {
  it("separates currencies, normalises symbols and skips symbol-less rows", () => {
    const g = groupBySymbolCurrency([
      buy("2026-01-01", 1, 1, { symbol: " vfv ", securityCurrency: "CAD" }),
      buy("2026-01-01", 1, 1, { symbol: "VFV", securityCurrency: "USD" }),
      buy("2026-01-01", 1, 1, { symbol: "VFV", securityCurrency: null, currency: "CAD" }),
      row("DEPOSIT", "2026-01-01", { symbol: null, amount: 5 }),
    ]);
    expect([...g.keys()].sort()).toEqual(["VFV|CAD", "VFV|USD"]);
    expect(g.get("VFV|CAD")).toHaveLength(2);
  });
});

describe("symbolPosition trade prices in the row currency (brief 8)", () => {
  const usdCad = (rate: number | null) => (price: number, rowCurrency: string | null, securityCurrency: string | null) => {
    if (!rowCurrency || !securityCurrency || rowCurrency === securityCurrency) return price;
    if (rate === null) return null;
    return rowCurrency === "CAD" ? price / rate : price * rate;
  };

  it("a CAD-row BUY of a USD security at CA$29.85 with USD/CAD 1.40 costs US$21.32, and so does its marker", () => {
    const p = symbolPosition([buy("2026-01-05", 10, 29.85, { symbol: "XUS", securityCurrency: "USD", currency: "CAD" })], [], noPrice, "USD", usdCad(1.4));
    expect(p.avgCost).toBeCloseTo(21.32, 2);
    expect(p.avgCostEstimated).toBe(false);
    expect(p.markers).toEqual([{ date: "2026-01-05", side: "buy", units: 10, price: expect.closeTo(21.32, 2) }]);
    expect(p.points.at(-1)!.avgCost).toBeCloseTo(21.32, 2);
  });

  it("passes the row and security currencies, date and fxRate to the converter", () => {
    const calls: unknown[][] = [];
    const to = (...args: [number, string | null, string | null, string, (number | null)?]) => { calls.push(args); return args[0]; };
    symbolPosition([buy("2026-01-05", 10, 29.85, { securityCurrency: "USD", currency: "CAD", fxRate: 1.39 })], [], noPrice, "USD", to);
    expect(calls).toContainEqual([29.85, "CAD", "USD", "2026-01-05", 1.39]);
  });

  it("leaves a USD/USD trade unchanged", () => {
    const p = symbolPosition([buy("2026-01-05", 10, 21, { securityCurrency: "USD", currency: "USD" })], [], noPrice, "USD", usdCad(1.4));
    expect(p.avgCost).toBe(21);
    expect(p.markers[0]!.price).toBe(21);
  });

  it("without FX the price is unknown: null cost, estimated, null marker price", () => {
    const p = symbolPosition([buy("2026-01-05", 10, 29.85, { securityCurrency: "USD", currency: "CAD" })], [], noPrice, "USD", usdCad(null));
    expect(p.avgCost).toBeNull();
    expect(p.avgCostEstimated).toBe(true);
    expect(p.markers[0]!.price).toBeNull();
  });

  it("with no BoC series, the reported fxRate is the only rate, in either quoting direction", () => {
    const noSeries = tradePriceConverter(null);
    for (const fxRate of [1.38, 1 / 1.38]) {
      const p = symbolPosition([buy("2026-01-05", 10, 200, { securityCurrency: "USD", currency: "CAD", fxRate, amount: -2000 })], [], noPrice, "USD", noSeries);
      expect(p.avgCost).toBeCloseTo(200 / 1.38, 6);
      expect(p.avgCostEstimated).toBe(false);
      expect(p.markers[0]!.price).toBeCloseTo(200 / 1.38, 6);
    }
  });

  it("a SELL marker carries the converted price", () => {
    const p = symbolPosition([
      buy("2026-01-05", 10, 28, { securityCurrency: "USD", currency: "CAD" }),
      sell("2026-02-05", 4, 35, { securityCurrency: "USD", currency: "CAD" }),
    ], [], noPrice, "USD", usdCad(1.4));
    expect(p.markers.map((m) => [m.side, m.units, m.price])).toEqual([["buy", 10, expect.closeTo(20, 6)], ["sell", 4, expect.closeTo(25, 6)]]);
    expect(p.avgCost).toBeCloseTo(20, 6);
  });

  it("without a converter or reported rate, a cross-currency price is unknown", () => {
    const p = symbolPosition([buy("2026-01-05", 10, 29.85, { securityCurrency: "USD", currency: "CAD" })], [], noPrice, "USD");
    expect(p.avgCost).toBeNull();
    expect(p.avgCostEstimated).toBe(true);
  });
});

describe("symbolPosition dividends agree with the Activity totals (A6)", () => {
  const usd = { symbol: "USX", securityCurrency: "USD", currency: "USD" };
  it("a DIVIDEND and its REI the same day count once", () => {
    const p = symbolPosition([row("DIVIDEND", "2026-03-01", { amount: 50 }), row("REI", "2026-03-01", { amount: 50, units: 1 })], [], noPrice);
    expect(p.dividends).toBe(50);
  });
  it("is net of matched withholding", () => {
    const p = symbolPosition([row("DIVIDEND", "2026-03-01", { ...usd, amount: 100 }), row("TAX", "2026-03-02", { ...usd, amount: -15 })], [], noPrice, "USD");
    expect(p.dividends).toBe(85);
    expect(p.unmatchedWithholding).toBeUndefined();
  });
  it("nets withholding in another currency group through the context rows", () => {
    const paid = row("DIVIDEND", "2026-03-01", { ...usd, currency: "CAD", amount: 100 });
    const tax = row("TAX", "2026-03-02", { symbol: "USX", securityCurrency: null, currency: "CAD", amount: -15 });
    expect(symbolPosition([paid], [], noPrice, "USD", undefined, [paid, tax]).otherDividends).toEqual([{ currency: "CAD", amount: 85 }]);
  });
});
