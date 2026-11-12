import { describe, expect, it } from "vitest";
import { buildPortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import { miniSyntheticAccount } from "../testing/mini-synthetic-fixtures.js";
import { buildOverviewSummary, quoteTickers } from "./overview-summary.js";
import { homeConverter } from "../fx/home-currency.js";
import { homeAccountValues } from "../fx/home-accounts.js";

const portfolio = buildPortfolioPresentation({
  connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [],
  accounts: [
    miniSyntheticAccount(0),                                    // CAD TFSA: SYNTHETIC0 2u @7, cash 3, reported 156
    miniSyntheticAccount(1, { currency: "USD", unifiedType: "SELF_DIRECTED_NON_REGISTERED_MARGIN", rawType: "Non-registered" }),
    miniSyntheticAccount(2, { unifiedType: "SELF_DIRECTED_RRSP", rawType: "RRSP" }),
    miniSyntheticAccount(3, { unifiedType: "CREDIT_CARD", rawType: "Credit card" }),
  ],
});
const quote = (ticker: string, price: number, previousClose: number | null) =>
  [ticker, { ticker, currency: "CAD", price, previousClose, asOf: "2026-10-15T15:00:00Z" }] as const;

describe("buildOverviewSummary", () => {
  it("picks the primary currency by the largest reported total and excludes credit products", () => {
    const summary = buildOverviewSummary(portfolio, new Map());
    expect(summary.primaryCurrency).toBe("CAD");
    expect(summary.totals.find((t) => t.currency === "CAD")?.amount).toBe(156 + 430);
    expect(summary.groups.map((g) => g.key)).not.toContain("credit_card");
  });
  it("computes day change only from quoted positions and reports partial coverage", () => {
    const summary = buildOverviewSummary(portfolio, new Map([quote("SYNTHETIC0", 7, 6)]));
    const cad = summary.dayChange.find((d) => d.currency === "CAD")!;
    expect(cad.amount).toBe(2 * (7 - 6));
    expect(cad.coverage).toBeCloseTo(14 / (14 + 36), 5);
    expect(summary.dayChange.find((d) => d.currency === "USD")?.coverage).toBe(0);
  });
  it("never invents a day change without a previous close", () => {
    const summary = buildOverviewSummary(portfolio, new Map([quote("SYNTHETIC0", 7, null)]));
    expect(summary.dayChange.find((d) => d.currency === "CAD")).toMatchObject({ amount: 0, coverage: 0, fraction: null });
  });
  it("reports cash, unrealized gain, largest holding and asset-class allocation", () => {
    const summary = buildOverviewSummary(portfolio, new Map(), { usdCad: 1.4 });
    expect(summary.cash).toEqual([{ currency: "CAD", amount: 3 + 5 }, { currency: "USD", amount: 4 }]);
    expect(summary.largestHolding?.symbol).toBe("SYNTHETIC2");
    const total = summary.allocation.reduce((s, a) => s + a.fraction, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(summary.allocation.map((a) => a.label)).toEqual(expect.arrayContaining(["Stocks", "Cash"]));
  });
  it("lists quote tickers for priced positions only", () => {
    expect(quoteTickers(portfolio).sort()).toEqual(["SYNTHETIC0", "SYNTHETIC1", "SYNTHETIC2"]);
  });

  it("computes the day-change fraction against covered value only", () => {
    const acct = miniSyntheticAccount(0);
    acct.positions.push({ ...acct.positions[0]!, instrumentId: "X", symbol: "SYNTHETICX", units: 1, price: 36, marketValue: 36 });
    const p = buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts: [acct] });
    const cad = buildOverviewSummary(p, new Map([quote("SYNTHETIC0", 7, 6)])).dayChange.find((d) => d.currency === "CAD")!;
    expect(cad.amount).toBe(2);
    expect(cad.fraction).toBeCloseTo(2 / (14 - 2), 6);
  });
  it("leaves a group's day change out when its other-currency holdings cannot be converted", () => {
    const acct = miniSyntheticAccount(0);
    acct.positions.push({ ...acct.positions[0]!, instrumentId: "U", symbol: "SYNTHETICU", units: 10, price: 5, marketValue: 50, currency: "USD" });
    const p = buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts: [acct] });
    const s = buildOverviewSummary(p, new Map([quote("SYNTHETIC0", 7, 6), quote("SYNTHETICU", 5, 1)]));
    const group = s.groups.find((g) => g.currency === "CAD")!;
    expect(group.dayChangeFraction).toBeNull();
    const fx = buildOverviewSummary(p, new Map([q("SYNTHETIC0", "CAD", 7, 6), q("SYNTHETICU", "USD", 5, 1)]), { usdCad: 2 });
    expect(fx.groups[0]!.dayChangeFraction).toBeCloseTo((2 + 40 * 2) / (12 + 10 * 2), 6);
  });
  it("aggregates the same symbol across accounts for the largest holding", () => {
    const a = miniSyntheticAccount(0);
    const b = miniSyntheticAccount(1);
    b.positions[0] = { ...b.positions[0]!, symbol: "SYNTHETIC0", currency: "CAD" };
    b.balances = [{ currency: "CAD", cash: 0, buyingPower: null }];
    b.account.reportedTotal = { currency: "CAD", amount: 293 };
    const c = miniSyntheticAccount(2);
    const p = buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts: [a, b, c] });
    expect(buildOverviewSummary(p, new Map()).largestHolding?.symbol).toBe("SYNTHETIC0");
  });
  it("reports the allocation currency", () => {
    expect(buildOverviewSummary(portfolio, new Map()).allocationCurrency).toBe("CAD");
    const empty = buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts: [] });
    expect(buildOverviewSummary(empty, new Map()).allocationCurrency).toBeNull();
  });
  it("creates no group for an account without value or balances", () => {
    const acct = miniSyntheticAccount(0, { reported: false });
    acct.balances = [];
    acct.positions = [];
    const p = buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts: [acct] });
    expect(buildOverviewSummary(p, new Map()).groups).toEqual([]);
  });
  it("keeps positions of an included account with no value and no balances, without a group", () => {
    const keep = miniSyntheticAccount(0);
    const bare = miniSyntheticAccount(2, { reported: false });
    bare.balances = [];
    const p = buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts: [keep, bare] });
    const presented = p.accounts.find((a) => a.id === bare.account.id)!;
    expect(presented.classification.includedInPortfolioTotal).toBe(true);
    const s = buildOverviewSummary(p, new Map());
    // The largest holding is a share of the reported total, so it follows that scope.
    expect(s.largestHolding?.symbol).toBe("SYNTHETIC0");
    expect(s.allocation.find((a) => a.key === "stock")?.fraction).toBeCloseTo(14 / 17, 6); // reported accounts only (M2)
    expect(s.groups.flatMap((g) => g.accountIds)).not.toContain(bare.account.id);
  });
  it("does not let a groupless account contaminate a same-bucket group's day change", () => {
    const rrsp = { unifiedType: "SELF_DIRECTED_RRSP", rawType: "RRSP" };
    const a = miniSyntheticAccount(0, rrsp);
    const b = miniSyntheticAccount(2, { ...rrsp, reported: false });
    b.balances = [];
    const p = buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts: [a, b] });
    expect(p.accounts.every((x) => x.classification.includedInPortfolioTotal)).toBe(true);
    const s = buildOverviewSummary(p, new Map([quote("SYNTHETIC0", 7, 6), quote("SYNTHETIC2", 9, 1)]));
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]!.dayChangeFraction).toBeCloseTo(2 / (14 - 2), 6);
    expect(s.largestHolding?.symbol).toBe("SYNTHETIC0");
    expect(s.allocation.find((x) => x.key === "stock")?.fraction).toBeCloseTo(14 / 17, 6); // reported accounts only (M2)
  });
  it("ignores a quote whose currency differs from the position currency", () => {
    const usdQuote = ["SYNTHETIC0", { ticker: "SYNTHETIC0", currency: "usd", price: 7, previousClose: 6, asOf: "2026-10-15T15:00:00Z" }] as const;
    const cad = buildOverviewSummary(portfolio, new Map([usdQuote])).dayChange.find((d) => d.currency === "CAD")!;
    expect(cad).toMatchObject({ amount: 0, coverage: 0, fraction: null });
    const sameCase = ["SYNTHETIC0", { ticker: "SYNTHETIC0", currency: "cad", price: 7, previousClose: 6, asOf: "2026-10-15T15:00:00Z" }] as const;
    expect(buildOverviewSummary(portfolio, new Map([sameCase])).dayChange.find((d) => d.currency === "CAD")!.amount).toBe(2);
  });
  it("labels ETFs neutrally and keys groups by bucket and currency", () => {
    const etf = miniSyntheticAccount(0);
    etf.positions[0] = { ...etf.positions[0]!, kind: "etf" };
    const usd = miniSyntheticAccount(0, { currency: "USD" }); // ties with CAD, so CAD stays primary
    const p = buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts: [etf, usd] });
    const s = buildOverviewSummary(p, new Map());
    expect(s.allocation.find((a) => a.key === "etf")?.label).toBe("ETFs");
    expect(s.groups.map((g) => g.key).sort()).toEqual(["tfsa:CAD", "tfsa:USD"]);
    expect(s.groups.every((g) => g.label === "TFSA")).toBe(true);
  });
});

// Audit fix round (brief 9): a CAD TFSA full of US stocks.
const at = "2026-10-15T15:00:00.000Z";
const q = (ticker: string, currency: string, price: number, previousClose: number | null) =>
  [ticker, { ticker, currency, price, previousClose, asOf: "2026-10-15T15:00:00Z" }] as const;
function usInCad(options: { costBasis?: boolean } = {}) {
  const acct = miniSyntheticAccount(0); // SYNTHETIC0 2u @7 CAD, cash 3
  acct.positions[0] = { ...acct.positions[0]!, costBasis: 5, unrealizedGain: 2 * (7 - 5) };
  acct.positions.push({ ...acct.positions[0]!, instrumentId: "U", symbol: "SYNTHETICU", units: 10, price: 5, marketValue: 50, currency: "USD",
    costBasis: options.costBasis === false ? null : 4, unrealizedGain: options.costBasis === false ? null : 10 * (5 - 4) });
  acct.account.reportedTotal = { currency: "CAD", amount: 14 + 50 * 1.4 + 3 };
  return acct;
}
const present = (...accounts: ReturnType<typeof miniSyntheticAccount>[]) => buildPortfolioPresentation({ connectionRequired: false, generatedAt: at, errors: [], accounts });

describe("buildOverviewSummary: every figure reported, reconciled or est. (brief 9)", () => {
  it("1: day change is per currency, keeps USD holdings of a CAD account on a USD line, and is estimated", () => {
    const s = buildOverviewSummary(present(usInCad()), new Map([q("SYNTHETIC0", "CAD", 7, 6), q("SYNTHETICU", "USD", 5, 4)]));
    const cad = s.dayChange.find((d) => d.currency === "CAD")!;
    const usd = s.dayChange.find((d) => d.currency === "USD")!;
    expect(cad).toMatchObject({ amount: 2, coverage: 1, estimated: true });
    expect(cad.fraction).toBeCloseTo(2 / (2 * 6), 9);
    expect(usd).toMatchObject({ amount: 10, coverage: 1, estimated: true });
    expect(usd.fraction).toBeCloseTo(10 / (10 * 4), 9);
  });
  it("1: the base is units × previous close, not the synced price", () => {
    const acct = miniSyntheticAccount(0);
    acct.positions[0] = { ...acct.positions[0]!, price: 6, marketValue: 12 }; // synced at yesterday's close
    const cad = buildOverviewSummary(present(acct), new Map([q("SYNTHETIC0", "CAD", 7, 6)])).dayChange.find((d) => d.currency === "CAD")!;
    expect(cad.fraction).toBeCloseTo(2 / 12, 9);
  });
  it("1: coverage counts every holding, including one with no market value", () => {
    const acct = miniSyntheticAccount(0);
    acct.positions.push({ ...acct.positions[0]!, instrumentId: "O", symbol: "SYNTHETICOPT", kind: "option", price: null, marketValue: null });
    const cad = buildOverviewSummary(present(acct), new Map([q("SYNTHETIC0", "CAD", 7, 6)])).dayChange.find((d) => d.currency === "CAD")!;
    expect(cad.coverage).toBeLessThan(1);
    const usd = buildOverviewSummary(present(usInCad()), new Map([q("SYNTHETIC0", "CAD", 7, 6)])).dayChange.find((d) => d.currency === "USD")!;
    expect(usd).toMatchObject({ coverage: 0, fraction: null });
  });
  it("2: a group's day change converts its foreign holdings, or shows nothing below 80% coverage", () => {
    const quotes = new Map([q("SYNTHETIC0", "CAD", 7, 6), q("SYNTHETICU", "USD", 5, 4)]);
    const withFx = buildOverviewSummary(present(usInCad()), quotes, { usdCad: 1.4 }).groups[0]!;
    expect(withFx.dayChangeFraction).toBeCloseTo((2 + 10 * 1.4) / (12 + 40 * 1.4), 9);
    expect(withFx.dayChangeCoverage).toBeCloseTo(1, 9);
    const noFx = buildOverviewSummary(present(usInCad()), quotes).groups[0]!;
    expect(noFx.dayChangeFraction).toBeNull();
    expect(noFx.dayChangeCoverage).toBeLessThan(0.8);
  });
  it("3: unrealized gain is per currency, includes USD holdings of a CAD account and reports cost-basis coverage", () => {
    const s = buildOverviewSummary(present(usInCad()), new Map());
    expect(s.unrealizedGain).toEqual([{ currency: "CAD", amount: 4 }, { currency: "USD", amount: 10 }]);
    expect(s.unrealizedCoverage).toEqual({ withCostBasis: 2, holdings: 2 });
    const partial = buildOverviewSummary(present(usInCad({ costBasis: false })), new Map());
    expect(partial.unrealizedGain).toEqual([{ currency: "CAD", amount: 4 }]);
    expect(partial.unrealizedCoverage).toEqual({ withCostBasis: 1, holdings: 2 });
  });
  it("4: the largest holding is a share of the reported total, converting foreign holdings at the BoC rate (est.)", () => {
    const s = buildOverviewSummary(present(usInCad()), new Map(), { usdCad: 1.4 });
    expect(s.largestHolding).toMatchObject({ symbol: "SYNTHETICU", estimated: true });
    expect(s.largestHolding!.fraction).toBeCloseTo((50 * 1.4) / (14 + 50 * 1.4 + 3), 9);
    expect(buildOverviewSummary(present(usInCad()), new Map()).largestHolding).toBeNull();
    const cadOnly = buildOverviewSummary(present(miniSyntheticAccount(0)), new Map());
    expect(cadOnly.largestHolding).toMatchObject({ symbol: "SYNTHETIC0", estimated: false });
    expect(cadOnly.largestHolding!.fraction).toBeCloseTo(14 / 156, 9);
  });
  it("12: a group excludes an account with no reported total and counts it as unavailable", () => {
    const a = miniSyntheticAccount(0);
    const b = miniSyntheticAccount(2, { reported: false });
    const group = buildOverviewSummary(present(a, b), new Map()).groups[0]!;
    expect(group).toMatchObject({ value: 156, accountCount: 2, unavailableCount: 1 });
  });
  it("13: cash covers only accounts in the reported totals and flags a margin debit", () => {
    const a = miniSyntheticAccount(0);
    const b = miniSyntheticAccount(2, { reported: false });
    const s = buildOverviewSummary(present(a, b), new Map());
    expect(s.cash).toEqual([{ currency: "CAD", amount: 3 }]);
    expect(s.cashNetOfMargin).toBe(false);
    const margin = miniSyntheticAccount(1, { unifiedType: "SELF_DIRECTED_NON_REGISTERED_MARGIN", rawType: "Non-registered" });
    margin.balances = [{ currency: "CAD", cash: -10, buyingPower: null }];
    const m = buildOverviewSummary(present(a, margin), new Map());
    expect(m.cash).toEqual([{ currency: "CAD", amount: 3 - 10 }]);
    expect(m.cashNetOfMargin).toBe(true);
  });
});

describe("unrealized gain and allocation follow the reported totals (review e, M2)", () => {
  it("counts unrealized gain and allocation holdings only for accounts with a reported total", () => {
    const reported = usInCad();
    const unreported = miniSyntheticAccount(2, { reported: false });
    unreported.positions[0] = { ...unreported.positions[0]!, costBasis: 1, unrealizedGain: 4 * (9 - 1) };
    const s = buildOverviewSummary(present(reported, unreported), new Map());
    expect(s.unrealizedGain).toEqual([{ currency: "CAD", amount: 4 }, { currency: "USD", amount: 10 }]);
    expect(s.unrealizedCoverage).toEqual({ withCostBasis: 2, holdings: 2 });
    // Allocation: SYNTHETIC0 14 stock + 3 cash; the unreported account's 36 is not included.
    expect(s.allocation.find((a) => a.key === "stock")?.fraction).toBeCloseTo(14 / 17, 9);
  });
});

describe("buildOverviewSummary: home currency (CAD)", () => {
  // Thursday Oct 15; the quote's previous close is Wednesday Oct 14.
  const rates = [{ date: "2026-10-13", close: 1.3 }, { date: "2026-10-14", close: 1.36 }, { date: "2026-10-15", close: 1.38 }];
  const conv = homeConverter(rates, "2026-10-15");
  const usdHolding = () => {
    const acct = miniSyntheticAccount(1, { currency: "USD", unifiedType: "SELF_DIRECTED_NON_REGISTERED_MARGIN", rawType: "Non-registered" });
    acct.positions[0] = { ...acct.positions[0]!, symbol: "SYNTHETICU", units: 10, price: 11, marketValue: 110, costBasis: 9, unrealizedGain: 20 };
    return acct;
  };

  it("the headline is homeAccountValues(...).total", () => {
    const p = present(usInCad(), usdHolding(), miniSyntheticAccount(2, { reported: false }));
    const s = buildOverviewSummary(p, new Map(), { home: conv });
    const expected = homeAccountValues(p, conv);
    expect(s.home!.total).toEqual(expected.total);
    expect(s.home!.total.amount).toBe(expected.total.amount);
    expect(s.home!.includesUnreported).toBe(true);
    expect(buildOverviewSummary(present(usInCad()), new Map(), { home: conv }).home!.includesUnreported).toBe(false);
  });
  it("CAD day change of a USD holding: today's USD × today's rate − yesterday's USD × yesterday's rate (100 → 110 USD, 1.36 → 1.38 = 15.80)", () => {
    const s = buildOverviewSummary(present(usdHolding()), new Map([q("SYNTHETICU", "USD", 11, 10)]), { home: conv });
    expect(s.home!.dayChange).toEqual({ amount: 15.8, estimated: true, rateDates: ["2026-10-15"], excluded: [], excludedCount: 0 });
    expect(s.home!.dayChangeFraction).toBeCloseTo(15.8 / 136, 9);
    expect(s.home!.dayChangeCoverage).toBe(1);
    // The native USD line is unchanged.
    expect(s.dayChange.find((d) => d.currency === "USD")).toMatchObject({ amount: 10 });
  });
  it("yesterday's rate is the one on or before the previous trading day (Monday's quote uses Friday's rate)", () => {
    const monday = homeConverter([{ date: "2026-10-15", close: 1.2 }, { date: "2026-10-16", close: 1.36 }, { date: "2026-10-19", close: 1.38 }], "2026-10-19");
    const quotes = new Map([["SYNTHETICU", { ticker: "SYNTHETICU", currency: "USD", price: 11, previousClose: 10, asOf: "2026-10-19T15:00:00Z" }]] as const);
    expect(buildOverviewSummary(present(usdHolding()), quotes, { home: monday }).home!.dayChange.amount).toBe(15.8);
  });
  it("a CAD holding's day change is exact and adds to the USD one", () => {
    const s = buildOverviewSummary(present(usInCad()), new Map([q("SYNTHETIC0", "CAD", 7, 6), q("SYNTHETICU", "USD", 5, 4)]), { home: conv });
    // CAD: 2 × (7 − 6) = 2; USD: 50 × 1.38 − 40 × 1.36 = 69 − 54.40 = 14.60.
    expect(s.home!.dayChange).toMatchObject({ amount: 16.6, estimated: true, excluded: [] });
    const cadOnly = buildOverviewSummary(present(miniSyntheticAccount(0)), new Map([q("SYNTHETIC0", "CAD", 7, 6)]), { home: conv });
    expect(cadOnly.home!.dayChange).toEqual({ amount: 2, estimated: false, rateDates: [], excluded: [], excludedCount: 0 });
  });
  it("without a rate the USD day change is not converted: excluded and counted, never guessed", () => {
    const none = homeConverter(null, "2026-10-15");
    const s = buildOverviewSummary(present(usInCad()), new Map([q("SYNTHETIC0", "CAD", 7, 6), q("SYNTHETICU", "USD", 5, 4)]), { home: none });
    expect(s.home!.dayChange).toEqual({ amount: 2, estimated: false, rateDates: [], excluded: [{ amount: 10, currency: "USD" }], excludedCount: 1 });
    expect(s.home!.dayChangeCoverage).toBeLessThan(1);
  });
  it("unrealized gain and cash are in CAD, USD parts est. at the latest rate", () => {
    const s = buildOverviewSummary(present(usInCad(), usdHolding()), new Map(), { home: conv });
    // CAD 4 + USD (10 + 20) × 1.38 = 4 + 41.40.
    expect(s.home!.unrealizedGain).toEqual({ amount: 45.4, estimated: true, rateDates: ["2026-10-15"], excluded: [], excludedCount: 0 });
    // Cash: CAD 3 + USD 4 × 1.38 = 5.52.
    expect(s.home!.cash).toEqual({ amount: 8.52, estimated: true, rateDates: ["2026-10-15"], excluded: [], excludedCount: 0 });
  });
  it("groups carry a CAD value made of their accounts' parts", () => {
    const s = buildOverviewSummary(present(miniSyntheticAccount(0), usdHolding()), new Map(), { home: conv });
    const usdGroup = s.groups.find((g) => g.currency === "USD")!;
    const home = s.home!.groups.find((g) => g.key === usdGroup.key)!;
    expect(home.value).toMatchObject({ amount: Math.round(293 * 1.38 * 100) / 100, estimated: true });
    expect(s.home!.groups.find((g) => g.key === s.groups.find((x) => x.currency === "CAD")!.key)!.value).toMatchObject({ amount: 156, estimated: false });
  });
  it("leaves home out without a converter", () => {
    expect(buildOverviewSummary(present(usInCad()), new Map()).home).toBeUndefined();
  });

  describe("basis captions and a margin debit (B1, A13)", () => {
    const margin = () => {
      const p = buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts: [miniSyntheticAccount(0)] });
      const a = p.accounts[0]!;
      a.positions = [{ ...a.positions[0]!, marketValue: 100_000 }];
      a.balances = [{ currency: "CAD", cash: -40_000, buyingPower: null }];
      a.value = { currency: "CAD", amount: 60_000, source: "brokerage_reported" };
      p.totals = [{ currency: "CAD", amount: 60_000, source: "brokerage_reported" }];
      return p;
    };
    it("the largest holding states its basis", () => {
      const cadOnly = margin();
      cadOnly.accounts[0]!.balances = [{ currency: "CAD", cash: 10, buyingPower: null }];
      expect(buildOverviewSummary(cadOnly, new Map()).largestHolding!.basis).toBe("of total value, cash included");
    });
    it("a margin account: the share is of net value, over 100%, and says so; the debit stays a negative cash slice", () => {
      const s = buildOverviewSummary(margin(), new Map());
      expect(s.largestHolding!.fraction).toBeCloseTo(100_000 / 60_000, 9);
      expect(s.largestHolding!.basis).toContain("of net value after a margin debit (the brokerage total), so it can be over 100%");
      expect(s.allocation.find((c) => c.key === "cash")!.fraction).toBeCloseTo(-40_000 / 60_000, 9);
    });
  });

  describe("the day change's labels (B2, B3)", () => {
    it("carries the quotes' session date, stocks over crypto", () => {
      const p = buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts: [miniSyntheticAccount(0)] });
      expect(buildOverviewSummary(p, new Map([["SYNTHETIC0", { ticker: "SYNTHETIC0", currency: "CAD", price: 7, previousClose: 6, asOf: "2026-10-23T20:00:00Z" }]])).dayChangeSession).toBe("2026-10-23");
      p.accounts[0]!.positions = [...p.accounts[0]!.positions, { ...p.accounts[0]!.positions[0]!, symbol: "BTC", kind: "crypto" }];
      // Saturday: crypto has a quote from today; the stock's last session is Friday.
      const cryptoTicker = quoteTickers(p).find((t) => t !== "SYNTHETIC0")!;
      const quotes = new Map([
        ["SYNTHETIC0", { ticker: "SYNTHETIC0", currency: "CAD", price: 7, previousClose: 6, asOf: "2026-10-23T20:00:00Z" }],
        [cryptoTicker, { ticker: cryptoTicker, currency: "CAD", price: 7, previousClose: 6, asOf: "2026-10-24T15:00:00Z" }],
      ]);
      expect(buildOverviewSummary(p, quotes).dayChangeSession).toBe("2026-10-23");
      expect(buildOverviewSummary(p, new Map()).dayChangeSession).toBeUndefined();
    });
    it("flags a CAD day change that holds a converted holding, and not an all-CAD one", () => {
      const fx = homeConverter([{ date: "2026-10-14", close: 1.36 }, { date: "2026-10-15", close: 1.4 }], "2026-10-15");
      const usd = buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts: [miniSyntheticAccount(1, { currency: "USD" })] });
      const ticker = usd.accounts[0]!.positions[0]!.symbol;
      const withUsd = buildOverviewSummary(usd, new Map([[ticker, { ticker, currency: "USD", price: 90, previousClose: 91, asOf: "2026-10-15T15:00:00Z" }]]), { home: fx });
      expect(withUsd.home!.dayChangeIncludesFx).toBe(true);
      const cad = buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts: [miniSyntheticAccount(0)] });
      const onlyCad = buildOverviewSummary(cad, new Map([quote("SYNTHETIC0", 7, 6)]), { home: fx });
      expect(onlyCad.home!.dayChangeIncludesFx).toBe(false);
    });
  });
});
