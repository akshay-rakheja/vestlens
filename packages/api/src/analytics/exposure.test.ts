import { describe, expect, it } from "vitest";
import { assetClassExposure, holdingWeights, investmentTotalCad, sectorExposure, type ExposureCash, type ExposureItem } from "./exposure.js";
import type { SecurityProfile } from "../market-data/types.js";
import type { AccountClassification } from "../portfolio/account-taxonomy.js";

const profile = (p: Partial<SecurityProfile>): SecurityProfile => ({ kind: "unknown", sector: null, country: null, sectorWeights: null, countryWeights: null, topHoldings: null, ...p });
const cls = (over: Partial<AccountClassification> = {}): AccountClassification => ({
  group: "registered", groupLabel: "Registered", bucket: "tfsa", bucketLabel: "TFSA", label: "TFSA", includedInPortfolioTotal: true, isClosed: false, ...over,
} as AccountClassification);
const item = (symbol: string, kind: string, valueCad: number, over: Partial<ExposureItem> = {}): ExposureItem =>
  ({ holdingKey: `${symbol}|CAD`, symbol, kind, valueCad, currency: "CAD", accountLabel: "TFSA", profile: null, ...over });
const cashOf = (valueCad: number, over: Partial<ExposureCash> = {}): ExposureCash => ({ currency: "CAD", accountLabel: "TFSA", valueCad, ...over });

const closed = cls({ group: "closed", isClosed: true });
const credit = cls({ group: "credit_products", bucket: "credit_card" } as Partial<AccountClassification>);

describe("investmentTotalCad", () => {
  it("includes cash and excludes closed and credit accounts", () => {
    const items = [
      item("XEQT", "etf", 600, { classification: cls() }),
      item("OLD", "stock", 1_000, { classification: closed }),
      item("CARD", "stock", 500, { classification: credit }),
      item("NOTSUMMED", "stock", 700, { classification: cls({ includedInPortfolioTotal: false }) }),
    ];
    const cash = [cashOf(400, { classification: cls() }), cashOf(9_000, { classification: credit }), cashOf(50, { classification: closed })];
    expect(investmentTotalCad(items, cash)).toBe(1_000);
  });
  it("ignores unknown and non-positive values, as the allocation view does", () => {
    expect(investmentTotalCad([item("A", "stock", Number.NaN), item("B", "stock", -5), item("C", "stock", 10)], [cashOf(0)])).toBe(10);
  });
});

describe("holdingWeights", () => {
  it("uses the investment total (with cash, without closed/credit accounts) as the denominator", () => {
    const w = holdingWeights([item("XEQT", "etf", 600), item("OLD", "stock", 1_000, { classification: closed })], [cashOf(400), cashOf(5_000, { classification: credit })]);
    expect(w).toEqual([{ symbol: "XEQT", currency: "CAD", key: "XEQT|CAD", valueCad: 600, pct: 60, estimated: false, listings: [], uncombined: [], basis: "portfolio_incl_cash" }]);
  });
  it("sums the same symbol held in two accounts", () => {
    const w = holdingWeights([item("SHOP", "stock", 300, { accountLabel: "TFSA" }), item("SHOP", "stock", 200, { accountLabel: "RRSP" }), item("XEQT", "etf", 500)], []);
    expect(w.map((r) => [r.symbol, r.valueCad, r.pct])).toEqual([["SHOP", 500, 50], ["XEQT", 500, 50]]);
  });
  it("keeps CAD and US listings of one company separate and notes the other listing", () => {
    const w = holdingWeights([
      item("SHOP", "stock", 300),
      item("SHOP", "stock", 700, { currency: "USD", holdingKey: "SHOP|USD" }),
      item("TD.TO", "stock", 100),
      item("TD", "stock", 100, { currency: "USD", holdingKey: "TD|USD" }),
    ], []);
    const by = (k: string) => w.find((r) => r.key === k)!;
    expect(by("SHOP|USD")).toMatchObject({ valueCad: 700, pct: 58.333333, estimated: true, listings: ["SHOP|CAD"] });
    // A CAD row's share is est. too: the denominator holds converted USD (M-5).
    expect(by("SHOP|CAD")).toMatchObject({ valueCad: 300, estimated: true, listings: ["SHOP|USD"] });
    expect(by("TD.TO|CAD").listings).toEqual(["TD|USD"]);
    expect(by("TD|USD").listings).toEqual(["TD.TO|CAD"]);
    expect(by("TD|USD").uncombined).toEqual([]);
  });
  it("one ticker, two companies (names disagree): not combined, and each row names the listing it was not combined with (review 4)", () => {
    const w = holdingWeights([
      item("T.TO", "stock", 800, { name: "TELUS Corp" }),
      item("T", "stock", 700, { currency: "USD", holdingKey: "T|USD", name: "AT&T Inc." }),
    ], []);
    const by = (k: string) => w.find((r) => r.key === k)!;
    expect(by("T.TO|CAD")).toMatchObject({ listings: [], uncombined: ["T|USD"] });
    expect(by("T|USD")).toMatchObject({ listings: [], uncombined: ["T.TO|CAD"] });
    // A leading "The" and punctuation don't make two companies of one.
    const td = holdingWeights([item("TD.TO", "stock", 100, { name: "The Toronto-Dominion Bank" }), item("TD", "stock", 100, { currency: "USD", holdingKey: "TD|USD", name: "TORONTO DOMINION BANK" })], []);
    expect(td.find((r) => r.key === "TD|USD")).toMatchObject({ listings: ["TD.TO|CAD"], uncombined: [] });
  });
  it("is empty when there is nothing to weigh", () => {
    expect(holdingWeights([], [])).toEqual([]);
  });
});

describe("sectorExposure", () => {
  const bank = item("RY", "stock", 200, { profile: profile({ kind: "stock", sector: "Financial Services" }) });
  const fund = item("XIU", "etf", 400, { profile: profile({ kind: "fund", sectorWeights: { "Financial Services": 0.5, Energy: 0.25, Technology: 0.25 } }) });
  const bareFund = item("ZZZ", "etf", 300);
  const bareStock = item("MYST", "stock", 100);

  it("distributes an ETF by its sector weights; a percentage is of the whole investment total", () => {
    const r = sectorExposure([bank, fund], [cashOf(400)]);
    expect(r.sectors).toEqual([
      { sector: "Financial Services", pct: 40, estimated: true },
      { sector: "Energy", pct: 10, estimated: true },
      { sector: "Technology", pct: 10, estimated: true },
    ]);
    expect(r.unclassified).toEqual({ pct: 0, symbols: [] });
    expect(r.basis).toBe("portfolio_incl_cash");
  });
  it("marks a CAD-only sector share est. when the denominator holds converted cash", () => {
    const r = sectorExposure([item("ENB", "stock", 100, { profile: profile({ kind: "stock", sector: "Energy" }) })], [cashOf(100, { currency: "USD" })]);
    expect(r.sectors).toEqual([{ sector: "Energy", pct: 50, estimated: true }]);
  });
  it("puts an ETF without sector weights in unclassified, with its symbol and combined share listed", () => {
    const r = sectorExposure([bank, fund, bareFund, bareStock], [], new Map());
    expect(r.sectors.find((s) => s.sector === "Financial Services")!.pct).toBe(40);
    expect(r.unclassified.pct).toBe(40);
    expect(r.unclassified.symbols).toEqual(["ZZZ", "MYST"]);
  });
  it("fills a missing profile from the lookup, and a stock sector is not estimated in CAD", () => {
    const r = sectorExposure([item("ENB", "stock", 100)], [], new Map([["ENB", profile({ kind: "stock", sector: "Energy" })]]));
    expect(r.sectors).toEqual([{ sector: "Energy", pct: 100, estimated: false }]);
  });
  it("lists a fund's unweighted remainder as unclassified", () => {
    const partial = item("PART", "etf", 100, { profile: profile({ kind: "fund", sectorWeights: { Energy: 0.6 } }) });
    const r = sectorExposure([partial], []);
    expect(r.sectors).toEqual([{ sector: "Energy", pct: 60, estimated: true }]);
    expect(r.unclassified).toEqual({ pct: 40, symbols: ["PART"] });
  });
  it("excludes closed accounts", () => {
    const r = sectorExposure([bank, item("OLD", "stock", 200, { classification: closed, profile: profile({ kind: "stock", sector: "Energy" }) })], []);
    expect(r.sectors).toEqual([{ sector: "Financial Services", pct: 100, estimated: false }]);
  });
});

describe("assetClassExposure", () => {
  it("shares of the investment total, cash included", () => {
    const r = assetClassExposure([item("RY", "stock", 300), item("XEQT", "etf", 500), item("OLD", "stock", 999, { classification: closed })], [cashOf(200)]);
    expect(r).toEqual({ basis: "portfolio_incl_cash", classes: [{ assetClass: "ETFs & funds", pct: 50 }, { assetClass: "Stocks", pct: 30 }, { assetClass: "Cash", pct: 20 }] });
  });
});
