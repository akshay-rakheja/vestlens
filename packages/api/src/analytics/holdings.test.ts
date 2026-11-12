import { describe, expect, it } from "vitest";
import { aggregateHoldings, applyDayChange } from "./holdings.js";

const cls = (bucket: string, group: string, included: boolean, label: string): any => ({ label, bucket, group, includedInPortfolioTotal: included, isClosed: group === "closed" });
const pos = (over: Record<string, unknown>): any => ({ instrumentId: "i", kind: "etf", symbol: "VFV", description: null, units: 10, price: 100, costBasis: 80, marketValue: 1000, unrealizedGain: null, currency: "CAD", cashEquivalent: false, ...over });
const acct = (id: string, positions: any[], over: Record<string, unknown> = {}): any => ({
  id, classification: cls("tfsa", "registered", true, id), value: null, balances: [], positions, ...over,
});

describe("aggregateHoldings", () => {
  it("sums units, market value and book cost of the same SYMBOL|CURRENCY across accounts", () => {
    const { rows, totals } = aggregateHoldings([
      acct("A", [pos({ units: 10, costBasis: 80, marketValue: 1000 })]),
      acct("B", [pos({ symbol: " vfv ", units: 5, costBasis: 90, marketValue: 520 })]),
    ], {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "VFV|CAD", units: 15, marketValue: 1520, bookCost: 1250, totalReturn: 270 });
    expect(rows[0].totalReturnFraction).toBeCloseTo(270 / 1250);
    expect(rows[0].accounts.map((a) => [a.accountId, a.units, a.bookCost])).toEqual([["A", 10, 800], ["B", 5, 450]]);
    expect(totals[0]).toMatchObject({ currency: "CAD", marketValue: 1520, bookCost: 1250, holdings: 1, withCostBasis: 1 });
  });

  it("keeps the same ticker in CAD and USD as two rows with separate weight bases", () => {
    const { rows, totals } = aggregateHoldings([
      acct("A", [pos({ symbol: "XYZ", currency: "CAD", marketValue: 300 }), pos({ symbol: "XYZ", currency: "USD", marketValue: 700 }), pos({ symbol: "ABC", currency: "USD", marketValue: 300 })]),
    ], {});
    expect(rows.map((r) => r.key).sort()).toEqual(["ABC|USD", "XYZ|CAD", "XYZ|USD"]);
    expect(rows.find((r) => r.key === "XYZ|CAD")!.weight).toBe(1);
    expect(rows.find((r) => r.key === "XYZ|USD")!.weight).toBeCloseTo(0.7);
    expect(totals.map((t) => [t.currency, t.marketValue])).toEqual([["CAD", 300], ["USD", 1000]]);
  });

  it("a missing cost basis nulls book cost and return but keeps the value", () => {
    const { rows, totals } = aggregateHoldings([
      acct("A", [pos({ symbol: "AAA", costBasis: null, marketValue: 100 }), pos({ symbol: "BBB", costBasis: 10, units: 10, marketValue: 150 })]),
      acct("B", [pos({ symbol: "BBB", costBasis: null, marketValue: 50 })]),
    ], {});
    const aaa = rows.find((r) => r.symbol === "AAA")!;
    expect(aaa).toMatchObject({ bookCost: null, totalReturn: null, totalReturnFraction: null, marketValue: 100 });
    // BBB loses its cost in one account, so the row has none; the other account still does.
    const bbb = rows.find((r) => r.symbol === "BBB")!;
    expect(bbb.bookCost).toBeNull();
    expect(bbb.accounts.find((a) => a.accountId === "A")!.bookCost).toBe(100);
    expect(bbb.accounts.find((a) => a.accountId === "B")!.bookCost).toBeNull();
    expect(totals[0]).toMatchObject({ holdings: 2, withCostBasis: 0, bookCost: null, totalReturn: null, totalReturnFraction: null, marketValue: 300 });
  });

  it("withCostBasis < holdings when only some rows have a cost; the return covers those rows only", () => {
    const { totals } = aggregateHoldings([
      acct("A", [pos({ symbol: "AAA", costBasis: null, marketValue: 100 }), pos({ symbol: "BBB", costBasis: 10, units: 10, marketValue: 150 })]),
    ], {});
    expect(totals[0]).toMatchObject({ holdings: 2, withCostBasis: 1, bookCost: 100, totalReturn: 50, marketValue: 250 });
    expect(totals[0].totalReturnFraction).toBeCloseTo(0.5);
  });

  it("an unknown market value gives a null weight and leaves the denominator", () => {
    const { rows } = aggregateHoldings([
      acct("A", [pos({ symbol: "AAA", marketValue: 100 }), pos({ symbol: "BBB", marketValue: 300 }), pos({ symbol: "CCC", marketValue: null, price: null })]),
    ], {});
    const by = (s: string) => rows.find((r) => r.symbol === s)!;
    expect(by("CCC")).toMatchObject({ marketValue: null, weight: null, totalReturn: null });
    expect(by("AAA").weight).toBeCloseTo(0.25);
    expect(by("BBB").weight).toBeCloseTo(0.75);
  });

  it("falls back to units x price when the reported market value is missing", () => {
    const { rows } = aggregateHoldings([acct("A", [pos({ marketValue: null, units: 4, price: 25 })])], {});
    expect(rows[0].marketValue).toBe(100);
  });

  it("ignores excluded, closed and credit accounts", () => {
    const { rows } = aggregateHoldings([
      acct("A", [pos({ symbol: "AAA" })]),
      acct("X", [pos({ symbol: "XXX" })], { classification: cls("other", "other", false, "Odd") }),
      acct("C", [pos({ symbol: "CCC" })], { classification: cls("tfsa", "closed", false, "Old") }),
      acct("D", [pos({ symbol: "DDD" })], { classification: cls("credit_card", "credit_products", false, "Card") }),
    ], {});
    expect(rows.map((r) => r.symbol)).toEqual(["AAA"]);
  });

  it("excludes options and cash-equivalents, and puts cash in the currency totals", () => {
    const { rows, totals } = aggregateHoldings([
      acct("A", [pos({ symbol: "AAA" }), pos({ symbol: "OPT", kind: "option" }), pos({ symbol: "CSH", cashEquivalent: true })], {}),
      acct("B", [], { balances: [{ currency: "CAD", cash: 50, buyingPower: null }, { currency: "usd", cash: 20, buyingPower: null }, { currency: "CAD", cash: null, buyingPower: null }] }),
    ].map((a, i) => (i === 0 ? { ...a, balances: [{ currency: "CAD", cash: 25, buyingPower: null }] } : a)), {});
    expect(rows.map((r) => r.symbol)).toEqual(["AAA"]);
    expect(totals.map((t) => [t.currency, t.cash, t.holdings])).toEqual([["CAD", 75, 1], ["USD", 20, 0]]);
  });

  it("scopes by account and currency", () => {
    const accounts = [acct("A", [pos({ symbol: "AAA" })]), acct("B", [pos({ symbol: "BBB", currency: "USD" })])];
    expect(aggregateHoldings(accounts, { accountId: "B" }).rows.map((r) => r.symbol)).toEqual(["BBB"]);
    const usd = aggregateHoldings(accounts, { currency: "usd" });
    expect(usd.rows.map((r) => r.symbol)).toEqual(["BBB"]);
    expect(usd.totals.map((t) => t.currency)).toEqual(["USD"]);
  });
});

describe("applyDayChange", () => {
  const rows = () => aggregateHoldings([acct("A", [pos({ symbol: "AAA", units: 10 }), pos({ symbol: "BBB" }), pos({ symbol: "CCC" })])], {}).rows;
  it("estimates units x (price - previous close); no quote gives null", () => {
    const quotes = new Map([["AAA", { price: 110, previousClose: 100, currency: "CAD" }], ["CCC", { price: 100, previousClose: null, currency: "CAD" }]]);
    const out = applyDayChange(rows(), quotes, (r) => r.symbol);
    const by = (s: string) => out.find((r) => r.symbol === s)!;
    expect(by("AAA").dayChange).toEqual({ amount: 100, fraction: 0.1, estimated: true });
    expect(by("BBB").dayChange).toBeNull();
    expect(by("CCC").dayChange).toEqual({ amount: null, fraction: null, estimated: true });
  });
  it("ignores a quote with no currency, and one far from the reported price", () => {
    const base = aggregateHoldings([acct("A", [pos({ symbol: "AAA", price: 100 })])], {}).rows;
    const dc = (q: any) => applyDayChange(base, new Map([["AAA", q]]), () => "AAA")[0].dayChange;
    expect(dc({ price: 110, previousClose: 100 })).toBeNull();
    expect(dc({ price: 110, previousClose: 100, currency: null })).toBeNull();
    expect(dc({ price: 300, previousClose: 290, currency: "CAD" })).toBeNull();
    expect(dc({ price: 20, previousClose: 19, currency: "CAD" })).toBeNull();
    expect(dc({ price: 101, previousClose: 100, currency: "cad" })).toMatchObject({ estimated: true, fraction: 0.01 });
  });
  it("carries the quote's session as a Toronto date, so a weekend quote can be labelled with its session (B3)", () => {
    const base = aggregateHoldings([acct("A", [pos({ symbol: "AAA", price: 100 })])], {}).rows;
    const dc = (q: any) => applyDayChange(base, new Map([["AAA", q]]), () => "AAA")[0].dayChange;
    // 21:00Z on a Friday is 17:00 Toronto the same day.
    expect(dc({ price: 101, previousClose: 100, currency: "CAD", asOf: "2026-10-16T21:00:00.000Z" })).toMatchObject({ sessionDate: "2026-10-16" });
    // 02:00Z is the evening before in Toronto.
    expect(dc({ price: 101, previousClose: 100, currency: "CAD", asOf: "2026-10-17T02:00:00.000Z" })).toMatchObject({ sessionDate: "2026-10-16" });
    expect(dc({ price: 101, previousClose: 100, currency: "CAD" })).not.toHaveProperty("sessionDate");
    expect(dc({ price: 101, previousClose: 100, currency: "CAD", asOf: "not a date" })).not.toHaveProperty("sessionDate");
  });
  it("ignores a quote in another currency and unmapped tickers", () => {
    const quotes = new Map([["AAA", { price: 110, previousClose: 100, currency: "USD" }]]);
    const out = applyDayChange(rows(), quotes, (r) => (r.symbol === "AAA" ? "AAA" : null));
    expect(out.every((r) => r.dayChange === null)).toBe(true);
  });
});
