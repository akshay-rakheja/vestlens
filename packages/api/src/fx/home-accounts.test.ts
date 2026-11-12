import { describe, expect, it } from "vitest";
import { homeAccountValues, homeScopeValue } from "./home-accounts.js";
import { homeConverter } from "./home-currency.js";

const TODAY = "2026-10-22";
const conv = homeConverter([{ date: "2026-10-21", close: 1.4 }], TODAY);
const cls = (bucket: string, group: string, included: boolean): any => ({ label: bucket, bucket, group, includedInPortfolioTotal: included, isClosed: group === "closed" });
const pos = (over: Record<string, unknown>): any => ({ instrumentId: "i", kind: "etf", symbol: "VFV", description: null, units: 10, price: 100, costBasis: 80, marketValue: 1000, unrealizedGain: null, currency: "CAD", cashEquivalent: false, ...over });
const reported = (amount: number, currency: string) => ({ amount, currency, source: "brokerage_reported" as const });
const acct = (id: string, over: Record<string, unknown> = {}): any => ({
  id, classification: cls("tfsa", "registered", true), value: null, balances: [], positions: [], ...over,
});
const portfolio = (accounts: any[]): any => ({ connectionRequired: false, generatedAt: TODAY, totals: [], accounts, errors: [] });

describe("homeAccountValues", () => {
  it("a CAD-reporting account uses its reported total, exact", () => {
    const { accounts, total } = homeAccountValues(portfolio([acct("A", { value: reported(1000, "CAD"), positions: [pos({ marketValue: 1000 })] })]), conv);
    expect(accounts).toEqual([{ accountId: "A", value: expect.objectContaining({ amount: 1000, estimated: false }), source: "reported", rowsDiffer: false, parts: expect.any(Array) }]);
    expect(total).toEqual({ amount: 1000, estimated: false, rateDates: [], excluded: [], excludedCount: 0 });
  });

  it("a USD-reporting account converts its reported total at the latest rate, est.", () => {
    const { accounts, total } = homeAccountValues(portfolio([acct("U", { value: reported(1000, "USD") })]), conv);
    expect(accounts[0]).toMatchObject({ source: "converted_reported", value: { amount: 1400, estimated: true, rate: 1.4, rateDate: "2026-10-21", native: { amount: 1000, currency: "USD" } } });
    expect(total).toEqual({ amount: 1400, estimated: true, rateDates: ["2026-10-21"], excluded: [], excludedCount: 0 });
  });

  it("an account without a reported total sums converted positions and cash, est.", () => {
    const a = acct("P", {
      positions: [pos({ currency: "USD", marketValue: 500 }), pos({ symbol: "XEQT", currency: "CAD", marketValue: 300 })],
      balances: [{ currency: "USD", cash: 100, buyingPower: null }, { currency: "CAD", cash: 50, buyingPower: null }],
    });
    const { accounts, total } = homeAccountValues(portfolio([a]), conv);
    expect(accounts[0]).toMatchObject({ source: "converted_positions", rowsDiffer: false, value: { amount: 350 + 840, estimated: true, rateDate: "2026-10-21" } });
    expect(total).toEqual({ amount: 1190, estimated: true, rateDates: ["2026-10-21"], excluded: [], excludedCount: 0 });
  });

  it("rowsDiffer is true when converted rows differ from the reported CAD total by 0.6%, false at 0.4%", () => {
    const at = (reportedCad: number) => homeAccountValues(portfolio([acct("A", { value: reported(reportedCad, "CAD"), positions: [pos({ currency: "USD", marketValue: 1000 })] })]), conv).accounts[0];
    // Rows: 1000 USD × 1.4 = 1400 CAD.
    expect(at(1400 / 1.006).rowsDiffer).toBe(true);
    expect(at(1400 / 1.004).rowsDiffer).toBe(false);
    expect(at(1400 * 1.006).rowsDiffer).toBe(true);
    expect(at(1400).rowsDiffer).toBe(false);
  });

  it("rowsDiffer also compares against a converted USD reported total", () => {
    const a = acct("U", { value: reported(1000, "USD"), positions: [pos({ currency: "USD", marketValue: 1010 })] });
    expect(homeAccountValues(portfolio([a]), conv).accounts[0].rowsDiffer).toBe(true);
  });

  it("a EUR position in an account lacking a reported total is excluded from the total and counted", () => {
    const a = acct("E", { positions: [pos({ currency: "EUR", marketValue: 200 }), pos({ symbol: "XEQT", currency: "CAD", marketValue: 300 })] });
    const { accounts, total } = homeAccountValues(portfolio([a, acct("A", { value: reported(1000, "CAD") })]), conv);
    expect(total).toEqual({ amount: 1300, estimated: false, rateDates: [], excluded: [{ amount: 200, currency: "EUR" }], excludedCount: 1 });
    expect(accounts.find((x) => x.accountId === "E")).toMatchObject({ source: "converted_positions", value: { amount: 300 } });
  });

  it("closed and credit accounts are excluded", () => {
    const { accounts, total } = homeAccountValues(portfolio([
      acct("A", { value: reported(1000, "CAD") }),
      acct("C", { value: reported(500, "CAD"), classification: cls("tfsa", "closed", false) }),
      acct("K", { value: reported(-200, "CAD"), classification: cls("credit_card", "credit_products", false) }),
    ]), conv);
    expect(accounts.map((a) => a.accountId)).toEqual(["A"]);
    expect(total.amount).toBe(1000);
  });

  it("without a rate a USD reported total is not converted and is excluded", () => {
    const { accounts, total } = homeAccountValues(portfolio([acct("U", { value: reported(1000, "USD") })]), homeConverter(null, TODAY));
    expect(accounts[0]).toMatchObject({ source: "converted_reported", value: { amount: null, estimated: false } });
    expect(total).toEqual({ amount: 0, estimated: false, rateDates: [], excluded: [{ amount: 1000, currency: "USD" }], excludedCount: 1 });
  });

  it("an account with no reported total and no holdings has a null value", () => {
    const { accounts, total } = homeAccountValues(portfolio([acct("Z")]), conv);
    expect(accounts[0]).toMatchObject({ source: "converted_positions", value: null, rowsDiffer: false });
    expect(total).toEqual({ amount: 0, estimated: false, rateDates: [], excluded: [], excludedCount: 0 });
  });

  it("includesUnreported is true only when an included account has no reported total", () => {
    const reportedOnly = portfolio([acct("A", { value: reported(1000, "CAD") }), acct("U", { value: reported(10, "USD") })]);
    expect(homeAccountValues(reportedOnly, conv).includesUnreported).toBe(false);
    const withUnreported = portfolio([acct("A", { value: reported(1000, "CAD") }), acct("P", { positions: [pos({})] })]);
    expect(homeAccountValues(withUnreported, conv).includesUnreported).toBe(true);
    const excludedUnreported = portfolio([acct("A", { value: reported(1000, "CAD") }), acct("C", { positions: [pos({})], classification: cls("tfsa", "closed", false) })]);
    expect(homeAccountValues(excludedUnreported, conv).includesUnreported).toBe(false);
  });
});

describe("homeScopeValue", () => {
  const pf = () => portfolio([acct("A", { value: reported(1000, "CAD") }), acct("B", { value: reported(100, "USD") }), acct("C", { value: reported(5, "CAD") })]);

  it("a set of ids sums those accounts; one id in a set equals the string form; null is the portfolio", () => {
    expect(homeScopeValue(pf(), conv, new Set(["A", "B"])).total.amount).toBeCloseTo(1140);
    expect(homeScopeValue(pf(), conv, new Set(["B"]))).toEqual(homeScopeValue(pf(), conv, "B"));
    expect(homeScopeValue(pf(), conv, null)).toEqual(homeScopeValue(pf(), conv));
  });
});
