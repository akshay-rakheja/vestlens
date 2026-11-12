import { describe, expect, it, vi } from "vitest";
import type { StoredActivity } from "../history/stored-activity.js";
import { buildActivityPage } from "./activity-tools.js";
import { DEFAULT_SETTINGS } from "../settings/settings-service.js";
import {
  buildIncomePayload, buildIncomeResult, dividendPayments, incomeInput, incomeModelCopy, IncomeScopeError, incomeText, incomeToolDefinitions, INCOME_WIDGET, INCOME_WIDGET_URI,
} from "./income-tools.js";

const cls = (bucket: string, group: string, included: boolean, label: string): any => ({ label, bucket, group, includedInPortfolioTotal: included, isClosed: group === "closed" });
const pos = (over: Record<string, unknown>): any => ({ instrumentId: "i", kind: "etf", symbol: "AAA", description: null, units: 120, price: 10, costBasis: 5, marketValue: 1200, unrealizedGain: null, currency: "CAD", cashEquivalent: false, ...over });
const portfolio = (positionsA: any[] = [pos({})]): any => ({
  generatedAt: "2026-10-16T15:00:00.000Z",
  accounts: [
    { id: "TFSA", name: "TFSA", classification: cls("tfsa", "registered", true, "TFSA"), value: null, balances: [], positions: positionsA },
    { id: "RRSP", name: "RRSP", classification: cls("rrsp", "registered", true, "RRSP"), value: null, balances: [], positions: [] },
    { id: "CASH", name: "Cash", classification: cls("money_market", "cash", true, "Cash"), value: null, balances: [], positions: [] },
    { id: "CARD", name: "Card", classification: cls("credit_card", "credit_products", false, "Credit card"), value: null, balances: [], positions: [] },
    { id: "OLD", name: "Old", classification: cls("tfsa", "closed", false, "Closed TFSA"), value: null, balances: [], positions: [] },
  ],
});

let n = 0;
const act = (over: Partial<StoredActivity>): StoredActivity => ({
  snapTradeAccountId: "TFSA", dedupeKey: `k${n++}`, type: "DIVIDEND", symbol: "AAA", securityCurrency: "CAD", isOption: false, units: null, price: null,
  amount: 50, fee: null, fxRate: null, currency: "CAD", tradeDate: "2026-02-15", settlementDate: null, description: null, ...over,
});
const buy = act({ type: "BUY", units: 100, price: 5, amount: -500, tradeDate: "2025-01-02" });
const topUp = act({ type: "BUY", units: 20, price: 8, amount: -160, tradeDate: "2026-09-01" });
const cents = (n: number) => Math.round(n * 100) / 100;
const quarterly = ["2025-11-15", "2026-02-15", "2026-05-15", "2026-08-15"].map((tradeDate) => act({ tradeDate }));

function deps(rows: StoredActivity[] = [buy, topUp, ...quarterly], over: Record<string, any> = {}): any {
  return {
    activities: {
      userId: vi.fn(async () => "u1"),
      syncState: vi.fn(async () => ({ backfillCompletedAt: new Date(), lastSyncedAt: new Date(), lastError: null, dirty: false })),
      queryActivities: vi.fn(async (_u: string, q: { accountIds: string[] }) => rows.filter((r) => q.accountIds.includes(r.snapTradeAccountId))),
    },
    settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })) },
    now: () => new Date("2026-10-16T15:00:00Z"),
    ...over,
  };
}

describe("buildIncomePayload", () => {
  it("returns months, totals, years and accounts for the current Toronto year; credit and closed accounts are excluded, cash accounts are included", async () => {
    const d = deps();
    const p = await buildIncomePayload(d, portfolio(), "sub", {});
    expect(p.year).toBe(2026);
    expect(p.years).toEqual([2025, 2026]);
    expect(p.accounts).toEqual([{ id: "TFSA", label: "TFSA" }, { id: "RRSP", label: "RRSP" }, { id: "CASH", label: "Cash" }]);
    expect(d.activities.queryActivities.mock.calls[0][1].accountIds).toEqual(["TFSA", "RRSP", "CASH"]);
    expect(p.months.map((m) => [m.month, m.currency, m.net])).toEqual([["2026-02", "CAD", 50], ["2026-05", "CAD", 50], ["2026-08", "CAD", 50]]);
    expect(p.months[0]!.byAccount).toEqual({ TFSA: 50 });
    expect(p.months[0]!.payers).toEqual([{ symbol: "AAA", net: 50 }]);
    expect(p.currencyTotals[0]).toMatchObject({ currency: "CAD", net: 150, gross: 150, withholding: 0, interest: 0 });
    expect(p.filters).toEqual({});
    expect(p.syncing).toEqual([]);
    expect(p.asOf).toBe("2026-10-16T15:00:00.000Z");
    expect(p.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("counts interest earned in a Cash account and can scope to it", async () => {
    const interest = act({ type: "INTEREST", amount: 7, symbol: null, snapTradeAccountId: "CASH", tradeDate: "2026-04-30" });
    const p = await buildIncomePayload(deps([...quarterly, interest]), portfolio(), "sub", {});
    expect(p.currencyTotals[0]).toMatchObject({ interest: 7 });
    expect(p.months.find((m) => m.month === "2026-04")!.interest).toBe(7);
    const one = await buildIncomePayload(deps([interest]), portfolio(), "sub", { accountId: "CASH" });
    expect(one.currencyTotals[0]).toMatchObject({ interest: 7, net: 0 });
  });

  it("reports unmatched withholding rows per currency without netting them", async () => {
    const rows = [act({ amount: 100, tradeDate: "2026-03-10" }), act({ type: "TAX", amount: -9, tradeDate: "2026-06-10" }), act({ type: "TAX", amount: -3, symbol: null, tradeDate: "2026-06-11" })];
    const p = await buildIncomePayload(deps(rows), portfolio(), "sub", {});
    expect(p.currencyTotals[0]).toMatchObject({ net: 100, withholding: 0, unmatchedWithholding: { count: 2, amount: 12 } });
    const quiet = await buildIncomePayload(deps(), portfolio(), "sub", {});
    expect(quiet.currencyTotals[0]!.unmatchedWithholding).toEqual({ count: 0, amount: 0 });
    expect(incomeModelCopy(p).currencyTotals[0]!.unmatchedWithholding).toEqual({ count: 2, amount: 12 });
  });

  it("forward 12 months uses units on each payment date and the units held now ($0.50/unit x 4 x 120 = 240)", async () => {
    const p = await buildIncomePayload(deps(), portfolio(), "sub", {});
    expect(p.currencyTotals[0]!.forward12m).toBe(240);
  });

  it("forward estimate is 0 and uncovered when units on the payment dates are unknown (no purchase history)", async () => {
    const p = await buildIncomePayload(deps(quarterly), portfolio(), "sub", {});
    expect(p.currencyTotals[0]).toMatchObject({ forward12m: 0, forwardCoverage: { payers: 1, covered: 0 } });
  });

  it("reports coverage 1 of 1 when the replay reconciles with the reported units", async () => {
    const p = await buildIncomePayload(deps(), portfolio(), "sub", {});
    expect(p.currencyTotals[0]!.forwardCoverage).toEqual({ payers: 1, covered: 1 });
  });

  it("skips a payer after a 4:1 split (reported units 4x the replay) and with partial history", async () => {
    const split = await buildIncomePayload(deps(), portfolio([pos({ units: 480 })]), "sub", {});
    expect(split.currencyTotals[0]).toMatchObject({ forward12m: 0, forwardCoverage: { payers: 1, covered: 0 } });
    // 100 units were held before the history starts: the replay only sees 20.
    const partial = [act({ type: "BUY", units: 20, price: 5, amount: -100, tradeDate: "2025-01-02" }), ...quarterly];
    const p = await buildIncomePayload(deps(partial), portfolio(), "sub", {});
    expect(p.currencyTotals[0]).toMatchObject({ forward12m: 0, forwardCoverage: { payers: 1, covered: 0 } });
  });

  it("Income net/gross/withholding equal the Activity dividend totals for the same in-window rows", async () => {
    const rows = [
      buy, act({ tradeDate: "2026-03-10", amount: 100 }), act({ type: "TAX", tradeDate: "2026-03-11", amount: -15 }),
      act({ tradeDate: "2026-04-10", amount: 20, symbol: "UUU", currency: "USD", securityCurrency: "USD" }), act({ type: "TAX", tradeDate: "2026-04-10", amount: -3, symbol: "UUU", currency: "USD", securityCurrency: "USD" }),
      act({ type: "TAX", tradeDate: "2026-05-01", amount: -9 }),
      act({ type: "DISTRIBUTION", tradeDate: "2026-06-10", amount: 12, snapTradeAccountId: "RRSP" }),
      act({ type: "REI", tradeDate: "2026-06-11", amount: -12, units: 1, snapTradeAccountId: "RRSP" }),
      act({ type: "REI", tradeDate: "2026-07-11", amount: -5, units: 1 }),
    ];
    const d = deps(rows);
    const income = await buildIncomePayload(d, portfolio(), "sub", { year: 2026 });
    const page = await buildActivityPage({ ...d, market: {}, cursorSecret: Buffer.alloc(32, 1) }, portfolio(), "sub", { categories: ["investing"], from: "2026-01-01", to: "2026-12-31" } as never);
    expect(income.currencyTotals.length).toBeGreaterThan(1);
    for (const t of income.currencyTotals) {
      const a = page.totals.find((x) => x.currency === t.currency)!;
      expect([t.net, t.gross, t.withholding]).toEqual([a.dividends, a.dividendsGross, Math.abs(a.withholding)]);
    }
  });

  it("nets tax across the year boundary and files it under the dividend's year", async () => {
    const rows = [act({ tradeDate: "2025-12-31", amount: 100 }), act({ type: "TAX", tradeDate: "2026-01-02", amount: -15 })];
    const y25 = await buildIncomePayload(deps(rows), portfolio(), "sub", { year: 2025 });
    expect(y25.currencyTotals[0]).toMatchObject({ net: 85, gross: 100, withholding: 15 });
    const y26 = await buildIncomePayload(deps(rows), portfolio(), "sub", { year: 2026 });
    expect(y26.months).toEqual([]);
    expect(y26.currencyTotals.every((c) => c.withholding === 0 && c.net === 0)).toBe(true);
  });

  it("uses the trailing 12 months for forward and yields (five drifting quarterly payments count four)", async () => {
    const drift = ["2025-10-20", "2026-01-19", "2026-04-20", "2026-07-19", "2026-10-15"].map((tradeDate) => act({ tradeDate }));
    const p = await buildIncomePayload(deps([buy, ...drift]), portfolio([pos({ units: 100 })]), "sub", {});
    expect(p.currencyTotals[0]!.forward12m).toBe(0.5 * 4 * 100);
    expect(p.yields[0]!.currentYield).toBe(Math.round((200 / 1200) * 1e6) / 1e6);
  });

  it("yields use the forward figure over the reported book cost and market value; top payers carry yield on cost", async () => {
    const p = await buildIncomePayload(deps(), portfolio(), "sub", {});
    // The forward run-rate: 240 on cost 600 and value 1200.
    expect(p.yields).toEqual([{ symbol: "AAA", currency: "CAD", yieldOnCost: 0.4, currentYield: 0.2, estimated: true }]);
    expect(p.topPayers).toEqual([{ symbol: "AAA", currency: "CAD", net: 150, yieldOnCost: p.yields[0]!.yieldOnCost }]);
    expect(p.currencyTotals[0]).toMatchObject({ yieldOnCost: p.yields[0]!.yieldOnCost, currentYield: p.yields[0]!.currentYield });
  });

  it("an account type with withholding that matches no dividend has no rate to show, not 0% (B12)", async () => {
    const rows = [buy, act({ tradeDate: "2026-09-01", amount: 100 }), act({ type: "TAX", amount: -15, tradeDate: "2026-09-05" })];
    const p = await buildIncomePayload(deps(rows), portfolio(), "sub", {});
    expect(p.withholding).toEqual([{ accountType: "TFSA", currency: "CAD", gross: 100, withholding: 0, rate: null }]);
    expect(p.currencyTotals[0]!.unmatchedWithholding).toEqual({ count: 1, amount: 15 });
  });

  it("nets withholding by account type and counts deposits for the year", async () => {
    const rows = [
      act({ amount: 100, tradeDate: "2026-03-10" }), act({ type: "TAX", amount: -15, tradeDate: "2026-03-10" }),
      act({ type: "CONTRIBUTION", amount: 700, tradeDate: "2026-01-05", symbol: null }), act({ type: "INTEREST", amount: 4, tradeDate: "2026-04-30", symbol: null, snapTradeAccountId: "RRSP" }),
    ];
    const p = await buildIncomePayload(deps(rows), portfolio(), "sub", {});
    expect(p.withholding).toEqual([{ accountType: "TFSA", currency: "CAD", gross: 100, withholding: 15, rate: 0.15 }]);
    expect(p.contributions).toEqual([{ accountType: "TFSA", currency: "CAD", amount: 700 }]);
    expect(p.currencyTotals[0]).toMatchObject({ net: 85, gross: 100, withholding: 15, interest: 4 });
    expect(p.months.find((m) => m.month === "2026-04")!.interest).toBe(4);
  });

  it("a year with no income has empty months and the text says none", async () => {
    const p = await buildIncomePayload(deps(), portfolio(), "sub", { year: 2023 });
    expect(p.year).toBe(2023);
    expect(p.months).toEqual([]);
    expect(p.currencyTotals.every((c) => c.net === 0)).toBe(true);
    expect(incomeText(p, "across all accounts")).toBe("No dividend or interest income recorded for 2023 across all accounts.");
  });

  it("lists accounts that are still syncing; a user without activity data lists all and nothing throws", async () => {
    const d = deps(); d.activities.syncState = vi.fn(async (_u: string, id: string) => (id === "RRSP" ? null : { backfillCompletedAt: new Date(), lastSyncedAt: null, lastError: null, dirty: false }));
    expect((await buildIncomePayload(d, portfolio(), "sub", {})).syncing).toEqual(["RRSP"]);
    const none = deps([], { }); none.activities.userId = vi.fn(async () => null);
    const p = await buildIncomePayload(none, portfolio(), "sub", {});
    expect(p.syncing).toEqual(["TFSA", "RRSP", "CASH"]);
    expect(p.months).toEqual([]);
    expect(incomeText(p, "across all accounts")).toContain("still syncing");
  });

  it("scopes to one account and rejects unknown, credit and closed accounts", async () => {
    const d = deps();
    const p = await buildIncomePayload(d, portfolio(), "sub", { accountId: "RRSP" });
    expect(d.activities.queryActivities.mock.calls[0][1].accountIds).toEqual(["RRSP"]);
    expect(p.filters).toEqual({ accountId: "RRSP" });
    expect(p.months).toEqual([]);
    for (const accountId of ["nope", "CARD", "OLD"]) await expect(buildIncomePayload(deps(), portfolio(), "sub", { accountId })).rejects.toBeInstanceOf(IncomeScopeError);
  });

  it("the default year follows America/Toronto", async () => {
    const p = await buildIncomePayload(deps(quarterly, { now: () => new Date("2026-01-01T03:00:00Z") }), portfolio(), "sub", {});
    expect(p.year).toBe(2025);
  });

  it("keeps currencies apart and caps the payload under 60 KB", async () => {
    const rows = [act({ amount: 10 }), act({ amount: 7, currency: "USD", securityCurrency: "USD", symbol: "UUU" })];
    const p = await buildIncomePayload(deps(rows), portfolio(), "sub", {});
    expect(p.currencyTotals.map((c) => [c.currency, c.net])).toEqual([["CAD", 10], ["USD", 7]]);
    const many = Array.from({ length: 400 }, (_, i) => act({ symbol: `S${i}`, amount: 1 + i, tradeDate: `2026-${String((i % 12) + 1).padStart(2, "0")}-10` }));
    const big = await buildIncomePayload(deps(many), portfolio(many.map((r) => pos({ symbol: r.symbol }))), "sub", {});
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThan(60_000);
  });
});

describe("a payer whose units changed around a payment is left out, not estimated (A4)", () => {
  const paid = (tradeDate: string, amount = 50) => act({ tradeDate, amount });
  const held = (units: number) => portfolio([pos({ units, costBasis: 5, marketValue: units * 10 })]);
  const year = ["2025-11-15", "2026-02-15", "2026-05-15"].map((d) => paid(d));

  it("50 of 100 units sold 5 days before the pay date: forward uncovered, no yield, and the count says so", async () => {
    const sale = act({ type: "SELL", units: -50, price: 8, amount: 400, tradeDate: "2026-09-10" });
    const p = await buildIncomePayload(deps([buy, ...year, sale, paid("2026-09-15")]), held(50), "sub", {});
    const t = p.currencyTotals[0]!;
    expect(t.forward12m).toBe(0);
    expect(t.forwardCoverage).toEqual({ payers: 1, covered: 0 });
    expect(p.yields).toEqual([{ symbol: "AAA", currency: "CAD", yieldOnCost: null, currentYield: null, estimated: true }]);
    expect(t).toMatchObject({ yieldOnCost: null, currentYield: null, yieldsLeftOut: 1 });
    expect(p.topPayers[0]!.yieldOnCost).toBeNull();
  });

  it("a purchase in the window is left out too", async () => {
    const more = act({ type: "BUY", units: 100, price: 8, amount: -800, tradeDate: "2026-09-01" });
    const p = await buildIncomePayload(deps([buy, ...year, more, paid("2026-09-15", 100)]), held(200), "sub", {});
    expect(p.currencyTotals[0]!.forwardCoverage).toEqual({ payers: 1, covered: 0 });
  });

  it("a 2:1 split as a CORPORATE_ACTION row with units passes the replay gate but is left out, not a pre-split rate on post-split units", async () => {
    const split = act({ type: "CORPORATE_ACTION", units: 100, amount: 0, tradeDate: "2026-03-01" });
    const p = await buildIncomePayload(deps([buy, paid("2025-11-15"), paid("2026-02-15"), split, paid("2026-05-15"), paid("2026-08-15")]), held(200), "sub", {});
    expect(p.currencyTotals[0]!).toMatchObject({ forward12m: 0, forwardCoverage: { payers: 1, covered: 0 }, yieldsLeftOut: 1 });
  });

  it("stays covered: trades after the pay date, trades before the window, a change within 0.5%, and reinvested dividends", async () => {
    const before = act({ type: "BUY", units: 20, price: 8, amount: -160, tradeDate: "2026-07-01" });
    const after = act({ type: "BUY", units: 20, price: 8, amount: -160, tradeDate: "2026-09-01" });
    const q = (await buildIncomePayload(deps([buy, ...year, before, paid("2026-08-15", 60), after]), held(140), "sub", {})).currencyTotals[0]!;
    expect(q.forwardCoverage).toEqual({ payers: 1, covered: 1 });
    expect(q.yieldsLeftOut).toBeUndefined();
    const small = act({ type: "BUY", units: 0.4, price: 8, amount: -3.2, tradeDate: "2026-08-10" });
    expect((await buildIncomePayload(deps([buy, ...year, small, paid("2026-08-15")]), held(100.4), "sub", {})).currencyTotals[0]!.forwardCoverage).toEqual({ payers: 1, covered: 1 });
    const drip = ["2026-07-15", "2026-08-15", "2026-09-15"].flatMap((tradeDate) => [paid(tradeDate), act({ type: "REI", units: 5, amount: 50, tradeDate })]);
    expect((await buildIncomePayload(deps([buy, ...drip]), held(115), "sub", {})).currencyTotals[0]!.forwardCoverage).toEqual({ payers: 1, covered: 1 });
  });

  /** Months from 2025-01 to 2026-10 as [year, month]. */
  const months = Array.from({ length: 22 }, (_, i) => [2025 + Math.floor(i / 12), (i % 12) + 1] as const);
  const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  it("monthly buys of 10 units on a 100-unit base keep a monthly payer covered, within 4% of the true run-rate (review 1)", async () => {
    // 10 units bought on the 1st of each month; $0.10 a unit paid on the 15th on the units held at the ex-date two weeks before (the buy is entitled).
    const rows: StoredActivity[] = [act({ type: "BUY", units: 100, price: 5, amount: -500, tradeDate: "2024-06-03" })];
    let units = 100;
    for (const [y, m] of months) {
      rows.push(act({ type: "BUY", units: 10, price: 5, amount: -50, tradeDate: ymd(y, m, 1) }));
      units += 10;
      if (ymd(y, m, 15) <= "2026-10-16") rows.push(paid(ymd(y, m, 15), units * 0.1));
    }
    const t = (await buildIncomePayload(deps(rows), held(units), "sub", {})).currencyTotals[0]!;
    expect(t.forwardCoverage).toEqual({ payers: 1, covered: 1 });
    const trueForward = units * 1.2;
    expect(Math.abs(t.forward12m - trueForward) / trueForward).toBeLessThan(0.04);
    expect(t.yieldsLeftOut).toBeUndefined();
  });

  it("a once-a-quarter buyer is covered: 25 units on the 20th of Jan/Apr/Jul/Oct, $0.30 a unit on 15 Feb/May/Aug/Nov (true 450)", async () => {
    const rows: StoredActivity[] = [act({ type: "BUY", units: 200, price: 5, amount: -1000, tradeDate: "2024-06-03" })];
    let units = 200;
    for (const [y, m] of months) {
      if (m % 3 === 1 && ymd(y, m, 20) <= "2026-10-16") { rows.push(act({ type: "BUY", units: 25, price: 5, amount: -125, tradeDate: ymd(y, m, 20) })); units += 25; }
      if (m % 3 === 2 && ymd(y, m, 15) <= "2026-10-16") rows.push(paid(ymd(y, m, 15), units * 0.3));
    }
    const t = (await buildIncomePayload(deps(rows), held(units), "sub", {})).currencyTotals[0]!;
    expect(units).toBe(375);
    expect(t.forwardCoverage).toEqual({ payers: 1, covered: 1 });
    expect(t.forward12m).toBe(450);
    // The calendar's per-unit figure follows the same rule (the same trailing payments; 25 on 200 in early 2025 is over 10%).
    const pays = await dividendPayments(deps(rows).activities, "u1", held(units).accounts, "2026-10-16");
    expect(pays.filter((x) => x.date.toISOString().slice(0, 10) > "2025-10-16").map((x) => x.perUnit)).toEqual([0.3, 0.3, 0.3, 0.3]);
  });

  it("a DRIP reported as DIVIDEND plus a same-day BUY stays covered for a 4% yielder", async () => {
    const rows: StoredActivity[] = [act({ type: "BUY", units: 1000, price: 20, amount: -20000, tradeDate: "2024-06-03" })];
    let units = 1000;
    for (const d of ["2025-02-15", "2025-05-15", "2025-08-15", "2025-11-15", "2026-02-15", "2026-05-15", "2026-08-15"]) {
      const amount = Math.round(units * 0.2 * 100) / 100;
      rows.push(paid(d, amount), act({ type: "BUY", units: amount / 20, price: 20, amount: -amount, tradeDate: d }));
      units += amount / 20;
    }
    const t = (await buildIncomePayload(deps(rows), held(units), "sub", {})).currencyTotals[0]!;
    expect(t.forwardCoverage).toEqual({ payers: 1, covered: 1 });
    expect(t.forward12m).toBeCloseTo(units * 0.8, 0);
  });

  it("units that fell by more than 10% between 30 days before the pay date and the pay date make the payer uncovered: 50 of 100 sold between ex-date and pay date is never $50 for a $25 payment", async () => {
    const sale = act({ type: "SELL", units: -50, price: 8, amount: 400, tradeDate: "2026-09-10" });
    const p = await buildIncomePayload(deps([buy, ...year, sale, paid("2026-09-15", 25)]), held(50), "sub", {});
    expect(p.currencyTotals[0]!).toMatchObject({ forward12m: 0, forwardCoverage: { payers: 1, covered: 0 } });
    const pays = await dividendPayments(deps([buy, ...year, sale, paid("2026-09-15", 25)]).activities, "u1", held(50).accounts, "2026-10-16");
    expect(pays.find((x) => x.date.toISOString().startsWith("2026-09-15"))!.perUnit).toBeNull();
  });
});

describe("a USD holding paid in CAD (A7)", () => {
  const usx = (over: Record<string, unknown> = {}) => pos({ symbol: "USX", currency: "USD", units: 100, price: 20, costBasis: 10, marketValue: 2000, ...over });
  const usy = pos({ instrumentId: "y", symbol: "USY", currency: "USD", units: 10, price: 100, costBasis: 100, marketValue: 1000 });
  const rows = () => [
    act({ type: "BUY", symbol: "USX", securityCurrency: "USD", currency: "USD", units: 100, price: 10, amount: -1000, tradeDate: "2025-01-02" }),
    ...["2026-02-15", "2026-05-15", "2026-08-15"].map((tradeDate) => act({ symbol: "USX", securityCurrency: "USD", currency: "CAD", amount: 27, tradeDate })),
  ];
  const usdCad = vi.fn(async () => [{ date: "2026-02-13", close: 1.35 }, { date: "2026-05-15", close: 1.35 }, { date: "2026-08-14", close: 1.35 }, { date: "2026-10-16", close: 1.35 }]);

  it("yields use the CAD dividends converted at the pay-date rate; the payer row shows the yield; the USD total counts it", async () => {
    const p = await buildIncomePayload(deps(rows(), { market: { usdCad } }), portfolio([usx()]), "sub", {});
    // 81 CAD / 1.35 = 60 USD on 1,000 cost and 2,000 value.
    expect(p.yields).toEqual([{ symbol: "USX", currency: "USD", yieldOnCost: 0.06, currentYield: 0.03, estimated: true }]);
    expect(p.topPayers).toEqual([{ symbol: "USX", currency: "CAD", net: 81, yieldOnCost: 0.06 }]);
    expect(p.currencyTotals.find((t) => t.currency === "USD")).toMatchObject({ yieldOnCost: 0.06, currentYield: 0.03, net: 0, yieldsConverted: 1 });
    expect(p.currencyTotals.find((t) => t.currency === "CAD")).toMatchObject({ net: 81, yieldOnCost: null, currentYield: null });
  });

  it("the CAD view's payer row carries the same yield", async () => {
    const settings = { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView: true })) };
    const p = await buildIncomePayload(deps(rows(), { market: { usdCad }, settings }), portfolio([usx()]), "sub", {});
    expect(p.home!.topPayers[0]).toMatchObject({ symbol: "USX", net: 81, yieldOnCost: 0.06 });
  });

  it("without a rate: no yield, left out of the USD totals rather than a zero diluting them, and counted", async () => {
    const paid = act({ symbol: "USY", securityCurrency: "USD", currency: "USD", amount: 50, tradeDate: "2026-08-15" });
    const p = await buildIncomePayload(deps([...rows(), paid]), portfolio([usx(), usy]), "sub", {});
    expect(p.yields).toContainEqual({ symbol: "USX", currency: "USD", yieldOnCost: null, currentYield: null, estimated: true });
    // USY alone: 50 on 1,000; USX's 3,000 of cost and value is not in the denominator.
    expect(p.currencyTotals.find((t) => t.currency === "USD")).toMatchObject({ yieldOnCost: 0.05, currentYield: 0.05, yieldsLeftOut: 1 });
    expect(p.topPayers.find((t) => t.symbol === "USX")!.yieldOnCost).toBeNull();
  });

  it("income in a third currency beside two listings can't be attributed: left out, never guessed", async () => {
    const eur = act({ symbol: "USX", securityCurrency: "EUR", currency: "EUR", amount: 10, tradeDate: "2026-08-15" });
    const p = await buildIncomePayload(deps([...rows(), eur], { market: { usdCad } }), portfolio([usx(), usx({ instrumentId: "c", currency: "CAD", marketValue: 500, units: 25 })]), "sub", {});
    expect(p.yields.filter((y) => y.symbol === "USX").map((y) => y.yieldOnCost)).toEqual([null, null]);
  });

  it("the year's text stays on what was received, with no USD figure from the yield slot", async () => {
    const r = await buildIncomeResult(deps(rows(), { market: { usdCad } }), portfolio([usx()]), "sub", {});
    expect(incomeText(r.payload, r.scope)).toMatch(/^81\.00 CAD of net income/);
  });
});

describe("income text and model copy", () => {
  it("answer first: the year's income in the scope and the top payer; the widget sentence stays last", async () => {
    const p = await buildIncomePayload(deps(), portfolio(), "sub", {});
    expect(incomeText(p, "across all accounts", { show: true })).toBe("150.00 CAD of net income (after withholding, incl. interest) in 2026 across all accounts; top payer AAA (150.00 CAD). Showing the income widget.");
    expect(incomeText(p, "across all accounts")).not.toContain("Showing");
  });

  it("model copy is compact with top payers (at most 20), no ids and the estimate note", async () => {
    const many = Array.from({ length: 30 }, (_, i) => act({ symbol: `S${i}`, amount: 1 + i }));
    const p = await buildIncomePayload(deps(many), portfolio(), "sub", { accountId: "TFSA" });
    const copy = incomeModelCopy(p);
    expect(copy.topPayers).toHaveLength(20);
    expect(copy.topPayers[0]).toMatchObject({ symbol: "S29" });
    expect(copy.filters).toEqual({ accountLabel: "TFSA" });
    expect(JSON.stringify(copy)).not.toContain('"id"');
    expect(copy.note).toBe("Estimates for information only, not tax or investment advice.");
    expect(JSON.stringify(copy).length).toBeLessThan(6_000);
  });
});

describe("income query filters: accountType, symbol and answer-first text", () => {
  const reported = (amount: number): any => ({ amount, currency: "CAD", source: "brokerage_reported" });
  const typed = (): any => ({
    generatedAt: "2026-10-16T15:00:00.000Z",
    accounts: [
      { id: "T1", name: "Main TFSA", classification: cls("tfsa", "registered", true, "TFSA"), value: reported(5000), balances: [], positions: [pos({ symbol: "XEQT.TO", units: 100 }), pos({ symbol: "VFV", units: 10 })] },
      { id: "T2", name: "Second TFSA", classification: cls("tfsa", "registered", true, "TFSA"), value: reported(2000), balances: [], positions: [] },
      { id: "RRSP", name: "RRSP", classification: cls("rrsp", "registered", true, "RRSP"), value: reported(900), balances: [], positions: [] },
      { id: "CASH", name: "Cash", classification: cls("money_market", "cash", true, "Cash"), value: reported(400), balances: [], positions: [] },
      { id: "CARD", name: "Card", classification: cls("credit_card", "credit_products", false, "Credit card"), value: null, balances: [], positions: [] },
    ],
  });
  const rows = [
    act({ snapTradeAccountId: "T1", symbol: "XEQT.TO", amount: 40, tradeDate: "2026-03-20" }),
    act({ snapTradeAccountId: "T1", symbol: "VFV", amount: 30, tradeDate: "2026-06-20" }),
    act({ snapTradeAccountId: "T1", symbol: "VFV", type: "TAX", amount: -4.5, tradeDate: "2026-06-20" }),
    act({ snapTradeAccountId: "T2", symbol: "XEQT.TO", amount: 20, tradeDate: "2026-06-20" }),
    act({ snapTradeAccountId: "RRSP", symbol: "AAA", amount: 100, tradeDate: "2026-04-10" }),
    act({ snapTradeAccountId: "CASH", type: "INTEREST", symbol: null, amount: 7, tradeDate: "2026-04-30" }),
    act({ snapTradeAccountId: "T1", type: "INTEREST", symbol: null, amount: 2, tradeDate: "2026-05-31" }),
    // TFSA to TFSA: not a contribution to the TFSA set. Cash to TFSA: money put into the TFSAs.
    act({ snapTradeAccountId: "T1", type: "INTERNAL_CASH_TRANSFER_OUT", symbol: null, amount: -500, tradeDate: "2026-02-01" }),
    act({ snapTradeAccountId: "T2", type: "INTERNAL_CASH_TRANSFER_IN", symbol: null, amount: 500, tradeDate: "2026-02-01" }),
    act({ snapTradeAccountId: "CASH", type: "INTERNAL_CASH_TRANSFER_OUT", symbol: null, amount: -300, tradeDate: "2026-07-01" }),
    act({ snapTradeAccountId: "T1", type: "INTERNAL_CASH_TRANSFER_IN", symbol: null, amount: 300, tradeDate: "2026-07-01" }),
    act({ snapTradeAccountId: "T2", type: "CONTRIBUTION", symbol: null, amount: 1000, tradeDate: "2026-01-10" }),
  ];

  it("accountType tfsa covers both TFSAs only and echoes the type without an accountId", async () => {
    const d = deps(rows);
    const { payload: p, scope } = await buildIncomeResult(d, typed(), "sub", { accountType: "tfsa" });
    expect(d.activities.queryActivities.mock.calls[0][1].accountIds).toEqual(["T1", "T2"]);
    expect(scope).toBe("in your TFSAs");
    expect(p.filters).toEqual({ accountType: "tfsa" });
    expect(p.accounts.map((a) => a.id)).toEqual(["T1", "T2", "RRSP", "CASH"]);
    expect(p.currencyTotals[0]).toMatchObject({ currency: "CAD", net: 85.5, gross: 90, withholding: 4.5, interest: 2 });
    expect(p.topPayers.map((t) => [t.symbol, t.net])).toEqual([["XEQT.TO", 60], ["VFV", 25.5]]);
    expect(p.withholding).toEqual([{ accountType: "TFSA", currency: "CAD", gross: 90, withholding: 4.5, rate: 0.05 }]);
  });

  it("contributions net transfers whose two legs are in the same account type; money from Cash still counts", async () => {
    const tfsa = await buildIncomePayload(deps(rows), typed(), "sub", { accountType: "tfsa" });
    expect(tfsa.contributions).toEqual([{ accountType: "TFSA", currency: "CAD", amount: 1300 }]);
    // All accounts agree with the tfsa view: the Cash -> TFSA 300 is a TFSA contribution (it was 1000 before I3).
    const all = await buildIncomePayload(deps(rows), typed(), "sub", {});
    expect(all.contributions).toEqual(tfsa.contributions);
    // One account: today's accountId path, where the other leg is outside the scope and counts.
    const t2 = await buildIncomePayload(deps(rows), typed(), "sub", { accountId: "T2" });
    expect(t2.contributions).toEqual([{ accountType: "TFSA", currency: "CAD", amount: 1500 }]);
  });

  it("TFSA1 -> Cash then Cash -> TFSA2 under accountType tfsa: the 1000 put into TFSA2 still counts (Cash legs read for matching only)", async () => {
    const via = [
      ...rows,
      act({ snapTradeAccountId: "T1", type: "INTERNAL_CASH_TRANSFER_OUT", symbol: null, amount: -1000, tradeDate: "2026-08-01" }),
      act({ snapTradeAccountId: "CASH", type: "INTERNAL_CASH_TRANSFER_IN", symbol: null, amount: 1000, tradeDate: "2026-08-01" }),
      act({ snapTradeAccountId: "CASH", type: "INTERNAL_CASH_TRANSFER_OUT", symbol: null, amount: -1000, tradeDate: "2026-08-02" }),
      act({ snapTradeAccountId: "T2", type: "INTERNAL_CASH_TRANSFER_IN", symbol: null, amount: 1000, tradeDate: "2026-08-02" }),
    ];
    const d = deps(via);
    const tfsa = await buildIncomePayload(d, typed(), "sub", { accountType: "tfsa" });
    expect(tfsa.contributions).toEqual([{ accountType: "TFSA", currency: "CAD", amount: 2300 }]);
    expect(d.activities.queryActivities.mock.calls.map((c: any[]) => c[1].accountIds)).toEqual([["T1", "T2"], ["RRSP", "CASH"]]);
    // Whole portfolio and one account: a single read, as before.
    const all = deps(via);
    // All accounts: the TFSA row matches the tfsa view (it was 1000 before I3), and Cash shows the 1000 in from TFSA1.
    expect((await buildIncomePayload(all, typed(), "sub", {})).contributions).toEqual([
      { accountType: "Cash", currency: "CAD", amount: 1000 }, { accountType: "TFSA", currency: "CAD", amount: 2300 },
    ]);
    expect(all.activities.queryActivities).toHaveBeenCalledTimes(1);
    const one = deps(via);
    await buildIncomePayload(one, typed(), "sub", { accountType: "rrsp" });
    await buildIncomePayload(one, typed(), "sub", { accountId: "T1" });
    expect(one.activities.queryActivities).toHaveBeenCalledTimes(2);
    // A symbol leaves contributions out, so no matching read either.
    const sym = deps(via);
    await buildIncomePayload(sym, typed(), "sub", { accountType: "tfsa", symbol: "XEQT" });
    expect(sym.activities.queryActivities).toHaveBeenCalledTimes(1);
  });

  it("a match-only account still backfilling counts as syncing for a multi-account scope, and the text says so (T5)", async () => {
    const d = deps(rows);
    d.activities.syncState = vi.fn(async (_u: string, id: string) => ({ backfillCompletedAt: id === "CASH" ? null : new Date(), lastSyncedAt: null, lastError: null, dirty: false }));
    const r = await buildIncomeResult(d, typed(), "sub", { accountType: "tfsa" });
    expect(r.payload.syncing).toEqual(["CASH"]);
    expect(d.activities.syncState.mock.calls.map((c: any[]) => c[1])).toEqual(["T1", "T2", "RRSP", "CASH"]);
    expect(incomeText(r.payload, r.scope)).toContain(" Some accounts are still syncing.");
    // One account, a symbol, or all accounts: no outside read, so only their own accounts' state counts.
    const again = () => { const x = deps(rows); x.activities.syncState = d.activities.syncState; return x; };
    expect((await buildIncomePayload(again(), typed(), "sub", { accountId: "T1" })).syncing).toEqual([]);
    expect((await buildIncomePayload(again(), typed(), "sub", { accountType: "tfsa", symbol: "XEQT" })).syncing).toEqual([]);
    expect((await buildIncomePayload(again(), typed(), "sub", {})).syncing).toEqual(["CASH"]);
  });

  it("an accountType with one account echoes its accountId too; accountId alone is unchanged", async () => {
    const { payload: rrsp, scope } = await buildIncomeResult(deps(rows), typed(), "sub", { accountType: "rrsp" });
    expect(rrsp.filters).toEqual({ accountId: "RRSP", accountType: "rrsp" });
    expect(scope).toBe("in your RRSP");
    const byId = await buildIncomeResult(deps(rows), typed(), "sub", { accountId: "RRSP" });
    expect(byId.payload.filters).toEqual({ accountId: "RRSP" });
    expect(byId.scope).toBe("in RRSP");
    const { filters: _a, ...typedRest } = rrsp;
    const { filters: _b, ...idRest } = byId.payload;
    expect(typedRest).toEqual(idRest);
  });

  it("rejects both filters and a type with no connected account with the shared copy", async () => {
    await expect(buildIncomePayload(deps(rows), typed(), "sub", { accountId: "T1", accountType: "tfsa" }))
      .rejects.toMatchObject({ name: "IncomeScopeError", code: "both_filters", text: "Give accountId or accountType, not both." });
    await expect(buildIncomePayload(deps(rows), typed(), "sub", { accountType: "fhsa" }))
      .rejects.toMatchObject({ code: "no_accounts_of_type", text: "No connected FHSA accounts. Use list_portfolio_accounts to see what is connected." });
    await expect(buildIncomePayload(deps(rows), typed(), "sub", { accountId: "CARD" }))
      .rejects.toMatchObject({ code: "unknown_account", text: "Unknown or excluded account. Use list_portfolio_accounts to pick an account." });
  });

  it("symbol keeps only that symbol's dividends; interest and contributions leave; totals, months, payers and withholding follow", async () => {
    const all = await buildIncomePayload(deps(rows), typed(), "sub", {});
    expect(all.currencyTotals[0]!.forwardCoverage).toEqual({ payers: 2, covered: 0 });
    const p = await buildIncomePayload(deps(rows), typed(), "sub", { symbol: " xeqt " });
    expect(p.filters).toEqual({ symbol: "XEQT" });
    expect(p.months.map((m) => [m.month, m.net, m.interest])).toEqual([["2026-03", 40, 0], ["2026-06", 20, 0]]);
    expect(p.months.flatMap((m) => m.payers.map((x) => x.symbol))).toEqual(["XEQT.TO", "XEQT.TO"]);
    expect(p.currencyTotals).toHaveLength(1);
    expect(p.currencyTotals[0]).toMatchObject({ currency: "CAD", net: 60, gross: 60, withholding: 0, interest: 0, unmatchedWithholding: { count: 0, amount: 0 }, forwardCoverage: { payers: 1, covered: 0 } });
    expect(p.topPayers.map((t) => t.symbol)).toEqual(["XEQT.TO"]);
    expect(p.withholding).toEqual([{ accountType: "TFSA", currency: "CAD", gross: 60, withholding: 0, rate: 0 }]);
    expect(p.contributions).toEqual([]);
    expect(p.yields.map((y) => y.symbol)).toEqual(["XEQT.TO"]);
    // The overall yield is the symbol's own, not its income over every holding's cost.
    expect(p.currencyTotals[0]!.yieldOnCost).toBe(p.yields[0]!.yieldOnCost);
    expect(p.years).toEqual([2026]);
    const vfv = await buildIncomePayload(deps(rows), typed(), "sub", { symbol: "VFV" });
    expect(vfv.currencyTotals[0]).toMatchObject({ net: 25.5, gross: 30, withholding: 4.5 });
  });

  it("symbol and accountType combine", async () => {
    const r = await buildIncomeResult(deps(rows), typed(), "sub", { accountType: "rrsp", symbol: "XEQT" });
    expect(r.payload.months).toEqual([]);
    expect(r.payload.filters).toEqual({ accountId: "RRSP", accountType: "rrsp", symbol: "XEQT" });
    expect(incomeText(r.payload, r.scope)).toBe("No dividends from XEQT recorded for 2026 in your RRSP.");
  });

  it("the first sentence states the total, scope and top payer, then the withholding deducted; no ids", async () => {
    const r = await buildIncomeResult(deps(rows), typed(), "sub", { accountType: "tfsa" });
    expect(incomeText(r.payload, r.scope, { show: true })).toBe(
      "87.50 CAD of net income (after withholding, incl. interest) in 2026 in your TFSAs; top payer XEQT.TO (60.00 CAD). 4.50 CAD of withholding tax was deducted. Forward estimate from 0 of 2 holdings (a holding in each account counts once). Left out: XEQT.TO in TFSA (its activity doesn't add up to the units held), VFV in TFSA (its activity doesn't add up to the units held). Showing the income widget.",
    );
    const one = await buildIncomeResult(deps(rows), typed(), "sub", { accountId: "T1" });
    const text = incomeText(one.payload, one.scope);
    expect(text).toBe("67.50 CAD of net income (after withholding, incl. interest) in 2026 in Main TFSA; top payer XEQT.TO (40.00 CAD). 4.50 CAD of withholding tax was deducted. Forward estimate from 0 of 2 holdings (a holding in each account counts once). Left out: XEQT.TO in TFSA (its activity doesn't add up to the units held), VFV in TFSA (its activity doesn't add up to the units held).");
    for (const t of [text, incomeText(r.payload, r.scope)]) {
      expect(t).not.toMatch(/\bT[12]\b/);
      expect(t.split(". ")[0]!.length).toBeLessThan(300);
    }
  });

  it("with a symbol the text says dividends from it; no match says none", async () => {
    const r = await buildIncomeResult(deps(rows), typed(), "sub", { symbol: "xeqt" });
    expect(incomeText(r.payload, r.scope)).toBe("60.00 CAD of net dividends from XEQT (after withholding) in 2026 across all accounts. Forward estimate from 0 of 1 holdings (a holding in each account counts once). Left out: XEQT.TO in TFSA (its activity doesn't add up to the units held).");
    const none = await buildIncomeResult(deps(rows), typed(), "sub", { symbol: "ZZZ" });
    expect(incomeText(none.payload, none.scope)).toBe("No dividends from ZZZ recorded for 2026 across all accounts.");
  });

  it("interest-only income has no top payer; unmatched withholding is named, not deducted, with 'Another' only beside a deducted figure", async () => {
    const cash = await buildIncomeResult(deps(rows), typed(), "sub", { accountType: "cash_account" });
    expect(incomeText(cash.payload, cash.scope)).toBe("7.00 CAD of net income (after withholding, incl. interest) in 2026 in your Cash account.");
    const unmatched = [act({ amount: 100, tradeDate: "2026-03-10" }), act({ type: "TAX", amount: -9, tradeDate: "2026-06-10" }), act({ type: "TAX", amount: -3, symbol: null, tradeDate: "2026-06-11" })];
    const p = await buildIncomePayload(deps(unmatched), portfolio(), "sub", {});
    expect(incomeText(p, "across all accounts")).toBe(
      "100.00 CAD of net income (after withholding, incl. interest) in 2026 across all accounts; top payer AAA (100.00 CAD). 12.00 CAD of withholding tax matches no dividend and is not deducted. Forward estimate from 0 of 1 holdings (a holding in each account counts once). Left out: AAA in TFSA (its activity doesn't add up to the units held).",
    );
    const both = await buildIncomePayload(deps([...unmatched, act({ type: "TAX", amount: -15, tradeDate: "2026-03-10" })]), portfolio(), "sub", {});
    expect(incomeText(both, "across all accounts")).toBe(
      "85.00 CAD of net income (after withholding, incl. interest) in 2026 across all accounts; top payer AAA (85.00 CAD). 15.00 CAD of withholding tax was deducted. Another 12.00 CAD of withholding tax matches no dividend and is not deducted. Forward estimate from 0 of 1 holdings (a holding in each account counts once). Left out: AAA in TFSA (its activity doesn't add up to the units held).",
    );
  });

  it("validates the new inputs", () => {
    expect(incomeInput.parse({ accountType: "tfsa", symbol: " xeqt " })).toEqual({ accountType: "tfsa", symbol: "xeqt" });
    expect(() => incomeInput.parse({ accountType: "margin" })).toThrow();
    expect(() => incomeInput.parse({ symbol: "" })).toThrow();
  });

  it("the model copy carries the type and symbol, never ids", async () => {
    const p = await buildIncomePayload(deps(rows), typed(), "sub", { accountType: "tfsa", symbol: "XEQT" });
    const copy = incomeModelCopy(p);
    expect(copy.filters).toEqual({ accountType: "tfsa", symbol: "XEQT" });
    expect(JSON.stringify(copy)).not.toMatch(/"T[12]"/);
  });
});

describe("forward and yields are stated as after withholding (B5)", () => {
  it("the model copy says so", async () => {
    const p = await buildIncomePayload(deps(), portfolio(), "sub", {});
    expect(incomeModelCopy(p).notes.forward12m).toMatch(/after withholding/);
  });
});

describe("income tool definitions", () => {
  it("validates input", () => {
    expect(incomeInput.parse({ year: 2025, accountId: "x" })).toEqual({ year: 2025, accountId: "x" });
    expect(() => incomeInput.parse({ year: 1800 })).toThrow();
    expect(() => incomeInput.parse({ year: 2025.5 })).toThrow();
    expect(() => incomeInput.parse({ extra: 1 })).toThrow();
  });

  it("show_income is model-visible with widget metadata; get_income is app-only; schemas use real keys", async () => {
    const [show, get] = incomeToolDefinitions;
    expect(INCOME_WIDGET).toBe("income");
    expect(INCOME_WIDGET_URI).toBe("ui://portfolio/income-v1");
    expect(show.name).toBe("show_income");
    expect(show.description).toBe("Use this when the user asks about dividends, income, distributions, interest, withholding tax or yield: renders the interactive income view. Filter with accountType or accountId, and symbol. Read-only.");
    expect(show._meta).toEqual({
      ui: { resourceUri: INCOME_WIDGET_URI }, "openai/outputTemplate": INCOME_WIDGET_URI, "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Loading income…", "openai/toolInvocation/invoked": "Income ready.",
      securitySchemes: [{ type: "oauth2", scopes: ["portfolio:read"] }],
    });
    expect(get.name).toBe("get_income");
    expect((get._meta as any).ui).toEqual({ visibility: ["app"] });
    for (const t of incomeToolDefinitions) {
      expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(t.securitySchemes).toEqual([{ type: "oauth2", scopes: ["portfolio:read"] }]);
      expect(t.outputSchema.additionalProperties).toBe(false);
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
    const required = ["year", "years", "currencyTotals", "months", "topPayers", "yields", "withholding", "contributions", "accounts", "syncing", "filters", "settings", "asOf"];
    expect(show.outputSchema.required).toEqual(required);
    expect(Object.keys(show.outputSchema.properties).sort()).toEqual([...required, "home"].sort());
    const p = await buildIncomePayload(deps(), portfolio(), "sub", {});
    expect(Object.keys(p).sort()).toEqual([...required, "home"].sort());
  });
});

describe("dividendPayments (calendar projection input)", () => {
  it("gives each dividend's gross per unit held that day, per symbol, from investable accounts only", async () => {
    const d = deps([buy, topUp, ...quarterly, act({ tradeDate: "2026-09-15", amount: 60 }), act({ snapTradeAccountId: "CARD", symbol: "ZZCARD", tradeDate: "2026-09-15" })]);
    const out = await dividendPayments(d.activities, "u1", portfolio().accounts, "2026-10-16");
    expect(d.activities.queryActivities.mock.calls[0][1].accountIds).toEqual(["TFSA", "RRSP", "CASH"]);
    expect(out.map((p) => [p.symbol, p.date.toISOString().slice(0, 10), p.perUnit, p.currency])).toEqual([
      ["AAA", "2025-11-15", 0.5, "CAD"], ["AAA", "2026-02-15", 0.5, "CAD"], ["AAA", "2026-05-15", 0.5, "CAD"], ["AAA", "2026-08-15", 0.5, "CAD"],
      // 20 units were bought two weeks before this payment: its per-unit amount is left out (A4).
      ["AAA", "2026-09-15", null, "CAD"],
    ]);
  });

  it("replays units from all history but keeps only payments from the last 1,100 days", async () => {
    const oldBuy = act({ type: "BUY", units: 400, price: 5, amount: -2000, tradeDate: "2019-03-01" });
    const ancient = act({ tradeDate: "2022-06-15", amount: 100 }); // older than 1,100 days before 2026-10-16
    const recent = ["2026-02-15", "2026-05-15", "2026-08-15"].map((tradeDate) => act({ tradeDate, amount: 100 }));
    const d = deps([oldBuy, ancient, ...recent]);
    const out = await dividendPayments(d.activities, "u1", portfolio([pos({ units: 400 })]).accounts, "2026-10-16");
    expect(d.activities.queryActivities.mock.calls[0][1].from).toBe("2000-01-01");
    expect(out.map((p) => [p.date.toISOString().slice(0, 10), p.perUnit])).toEqual([["2026-02-15", 0.25], ["2026-05-15", 0.25], ["2026-08-15", 0.25]]);
  });

  it("gives no per-unit amount for a payment whose units changed around it, or before a split, keeping its date for the cadence (A4)", async () => {
    const sale = act({ type: "SELL", units: -50, price: 8, amount: 400, tradeDate: "2026-09-10" });
    const sold = await dividendPayments(deps([buy, act({ tradeDate: "2026-06-15" }), sale, act({ tradeDate: "2026-09-15" })]).activities, "u1", portfolio([pos({ units: 50 })]).accounts, "2026-10-16");
    expect(sold.map((p) => [p.date.toISOString().slice(0, 10), p.perUnit])).toEqual([["2026-06-15", 0.5], ["2026-09-15", null]]);
    const split = act({ type: "CORPORATE_ACTION", units: 100, amount: 0, tradeDate: "2026-07-01" });
    const after = await dividendPayments(deps([buy, act({ tradeDate: "2026-06-15" }), split]).activities, "u1", portfolio([pos({ units: 200 })]).accounts, "2026-10-16");
    expect(after.map((p) => p.perUnit)).toEqual([null]);
  });

  it("gives no per-unit amount when the replay does not reconcile with the reported units, as after a SPLIT row (A4)", async () => {
    const split = act({ type: "SPLIT", units: null, amount: null, tradeDate: "2026-07-01" });
    const out = await dividendPayments(deps([buy, act({ tradeDate: "2026-06-15" }), split]).activities, "u1", portfolio([pos({ units: 200 })]).accounts, "2026-10-16");
    expect(out.map((p) => p.perUnit)).toEqual([null]);
  });

  it("skips payments whose units on the day are unknown", async () => {
    const out = await dividendPayments(deps(quarterly).activities, "u1", portfolio().accounts, "2026-10-16");
    expect(out).toEqual([]);
  });
});

describe("buildIncomePayload in CAD", () => {
  const usdAct = (over: Partial<StoredActivity>) => act({ symbol: "UUU", currency: "USD", securityCurrency: "USD", ...over });
  const rates = [{ date: "2026-02-13", close: 1.4 }, { date: "2026-05-14", close: 1.3 }];
  const market = () => ({ usdCad: vi.fn(async () => rates) });
  const rows = [
    buy, topUp,
    act({ tradeDate: "2026-02-15", amount: 100 }),
    usdAct({ tradeDate: "2026-02-15", amount: 100 }),
    usdAct({ type: "TAX", tradeDate: "2026-02-15", amount: -15 }),
    usdAct({ tradeDate: "2026-05-15", amount: 50 }),
    act({ type: "INTEREST", amount: 10, symbol: null, snapTradeAccountId: "CASH", tradeDate: "2026-04-30" }),
  ];

  it("one set of CAD tiles and one monthly series: USD dividends convert at the rate on their pay date (est.)", async () => {
    const m = market();
    const p = await buildIncomePayload(deps(rows, { market: m }), portfolio(), "sub", {});
    const home = p.home!;
    // Feb: 100 CAD + (100 - 15) USD x 1.4 = 119 ; May: 50 USD x 1.3 = 65 -> net 100 + 119 + 65 = 284
    expect(home.tiles.net).toMatchObject({ amount: 284, estimated: true, excludedCount: 0, excluded: [] });
    expect(home.tiles.gross.amount).toBe(100 + 140 + 65);
    expect(home.tiles.withholding.amount).toBe(21);
    expect(home.tiles.interest).toMatchObject({ amount: 10, estimated: false });
    expect(home.months.map((x) => [x.month, x.currency, x.net])).toEqual([["2026-02", "CAD", 219], ["2026-04", "CAD", 0], ["2026-05", "CAD", 65]]);
    expect(home.months[0]!.byAccount).toEqual({ TFSA: 219 });
    expect(home.topPayers.map((t) => [t.symbol, t.net])).toEqual([["AAA", 100], ["UUU", 184]].sort((a, b) => (b[1] as number) - (a[1] as number)));
    expect(m.usdCad).toHaveBeenCalledTimes(1);
  });

  it("keeps the native per-currency totals and the withholding breakdown per currency", async () => {
    const p = await buildIncomePayload(deps(rows, { market: market() }), portfolio(), "sub", {});
    expect(p.currencyTotals.map((c) => [c.currency, c.net])).toEqual([["CAD", 100], ["USD", 135]]);
    expect(p.withholding.some((w) => w.currency === "USD")).toBe(true);
    expect(p.months.some((x) => x.currency === "USD")).toBe(true);
  });

  it("without a rate USD is not converted: listed and counted, never a CAD figure from nothing", async () => {
    const p = await buildIncomePayload(deps(rows, { market: { usdCad: vi.fn(async () => null) } }), portfolio(), "sub", {});
    expect(p.home!.tiles.net).toMatchObject({ amount: 100, estimated: false, excludedCount: 2, excluded: [{ amount: 135, currency: "USD" }] });
    const only = await buildIncomePayload(deps([buy, usdAct({ tradeDate: "2026-02-15", amount: 100 })], { market: { usdCad: vi.fn(async () => null) } }), portfolio(), "sub", {});
    expect(only.home!.tiles.net).toMatchObject({ amount: 0, estimated: false, excludedCount: 1, excluded: [{ amount: 100, currency: "USD" }] });
    expect(only.home!.months).toEqual([]);
  });

  it("is absent with cadView off", async () => {
    const d = deps(rows, { market: market(), settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView: false })) } });
    const p = await buildIncomePayload(d, portfolio(), "sub", {});
    expect(p.home).toBeUndefined();
  });

  it("model copy: CAD totals and the CAD note replace 'currencies are never mixed'", async () => {
    const p = await buildIncomePayload(deps(rows, { market: market() }), portfolio(), "sub", {});
    const copy = incomeModelCopy(p) as any;
    expect(copy.homeTotals.net).toEqual({ amount: 284, estimated: true, notConverted: 0 });
    expect(copy.notes.currency).toBe("Figures are in CAD; USD amounts are converted at the Bank of Canada rate and marked est.");
    expect(JSON.stringify(copy)).not.toContain("never mixed");
    expect(copy.currencyTotals).toHaveLength(2);
  });

  it("text: a CAD total from the payload's own conversion, est. with the rate dates used, beside the native amounts", async () => {
    const pf = portfolio();
    pf.accounts[0].value = { amount: 9999, currency: "CAD", source: "brokerage_reported" };
    pf.accounts[1].value = { amount: 1234, currency: "CAD", source: "brokerage_reported" };
    const p = await buildIncomePayload(deps(rows, { market: market() }), pf, "sub", {});
    expect(incomeText(p, "across all accounts")).toBe(
      "294.00 CAD of net income (after withholding, incl. interest) in 2026 across all accounts (est., BoC rates by pay date; 110.00 CAD + 135.00 USD as reported); top payer UUU (184.00 CAD est., BoC rates by pay date). 15.00 USD of withholding tax was deducted.",
    );
    const one = [buy, act({ tradeDate: "2026-02-15", amount: 100 }), usdAct({ tradeDate: "2026-05-15", amount: 50 })];
    const single = await buildIncomePayload(deps(one, { market: market() }), pf, "sub", {});
    expect(incomeText(single, "across all accounts")).toBe(
      "165.00 CAD of net income (after withholding, incl. interest) in 2026 across all accounts (est., BoC May 14; 100.00 CAD + 50.00 USD as reported); top payer AAA (100.00 CAD). Forward estimate from 0 of 1 holdings (a holding in each account counts once). Left out: AAA in TFSA (its activity doesn't add up to the units held).",
    );
  });

  it("text: without a rate, or with the CAD view off, native amounts per currency and no est.", async () => {
    const noRate = await buildIncomePayload(deps(rows, { market: { usdCad: vi.fn(async () => null) } }), portfolio(), "sub", {});
    const off = await buildIncomePayload(deps(rows, { market: market(), settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView: false })) } }), portfolio(), "sub", {});
    for (const p of [noRate, off]) {
      expect(incomeText(p, "across all accounts")).toBe(
        "110.00 CAD + 135.00 USD of net income (after withholding, incl. interest) in 2026 across all accounts; top payers AAA (100.00 CAD), UUU (135.00 USD). 15.00 USD of withholding tax was deducted.",
      );
    }
  });

  it("a single-currency year keeps its yields and coverage", async () => {
    const p = await buildIncomePayload(deps(), portfolio(), "sub", {});
    expect(p.home!.forwardCoverage).toEqual({ payers: 1, covered: 1 });
    expect(p.home!.yields).not.toBeNull();
    expect(p.home!.tiles.forward12m).toMatchObject({ amount: 240, estimated: false });
  });
});

describe("forward dividends and yields from market per-share distributions", () => {
  const accountsOf = (positions: Record<string, any[]>): any => ({
    generatedAt: "2026-10-16T15:00:00.000Z",
    accounts: Object.entries(positions).map(([id, list]) => ({ id, name: id, classification: cls(id.toLowerCase(), "registered", true, id), value: null, balances: [], positions: list })),
  });
  const dist = (currency: string | null, events: Array<[string, number]>) => ({ currency, events: events.map(([date, amount]) => ({ date, amount })) });
  const quarters = (amount: number) => dist("CAD", [["2025-11-01", amount], ["2026-02-01", amount], ["2026-05-01", amount], ["2026-08-01", amount]]);
  const monthlyDates = ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
  const market = (byTicker: Record<string, unknown> | unknown) => ({ distributions: vi.fn(async (ticker: string) => ((byTicker as any)?.currency !== undefined ? byTicker : (byTicker as any)[ticker] ?? null)) });
  const paid = (tradeDate: string, amount = 50, over: Partial<StoredActivity> = {}) => act({ tradeDate, amount, ...over });
  const held = (units: number, over: Record<string, unknown> = {}) => portfolio([pos({ units, costBasis: 5, marketValue: units * 10, ...over })]);

  it("a weekly buyer with DRIP in three small accounts is covered in all of them and exact (1 of 3 before)", async () => {
    const rows: StoredActivity[] = [];
    const positions: Record<string, any[]> = {};
    for (const [i, id] of ["TFSA", "RRSP", "FHSA"].entries()) {
      let units = 10 + i;
      rows.push(act({ snapTradeAccountId: id, type: "BUY", units, price: 10, amount: -units * 10, tradeDate: "2024-06-03" }));
      for (const month of monthlyDates) {
        for (const day of ["02", "09", "16", "23"]) { if (`${month}-${day}` > "2026-10-16") continue; rows.push(act({ snapTradeAccountId: id, type: "BUY", units: 2, price: 10, amount: -20, tradeDate: `${month}-${day}` })); units += 2; }
        if (`${month}-15` > "2026-10-16") continue;
        const amount = cents(units * 0.1);
        rows.push(paid(`${month}-15`, amount, { snapTradeAccountId: id }), act({ snapTradeAccountId: id, type: "REI", units: amount / 10, amount: -amount, tradeDate: `${month}-15` }));
        units += amount / 10;
      }
      positions[id] = [pos({ units, costBasis: 10, marketValue: units * 11 })];
    }
    const per = dist("CAD", monthlyDates.map((m) => [`${m}-10`, 0.1] as [string, number]));
    const p = await buildIncomePayload(deps(rows, { market: market(per) }), accountsOf(positions), "sub", {});
    const t = p.currencyTotals[0]!;
    expect(t.forwardCoverage).toEqual({ payers: 3, covered: 3 });
    const units = Object.values(positions).reduce((sum, [h]) => sum + h.units, 0);
    expect(t.forward12m).toBeCloseTo(units * 1.2, 2);
    expect(t.yieldsLeftOut).toBeUndefined();
    expect(p.yields[0]!.currentYield).toBeCloseTo(1.2 / 11, 5);
    expect(t.forwardUncovered).toBeUndefined();
  });

  it("a quarterly stock held 3 months gives four quarters, not one; without market data it is uncovered and named", async () => {
    const rows = [act({ type: "BUY", units: 100, price: 8, amount: -800, tradeDate: "2026-07-15" }), paid("2026-08-15")];
    const p = await buildIncomePayload(deps(rows, { market: market(quarters(0.5)) }), held(100), "sub", {});
    expect(p.currencyTotals[0]).toMatchObject({ forward12m: 200, forwardCoverage: { payers: 1, covered: 1 } });
    // Yields run off the same forward figure: 200 on 500 cost and 1,000 value.
    expect(p.yields[0]).toMatchObject({ yieldOnCost: 0.4, currentYield: 0.2 });
    const bare = await buildIncomePayload(deps(rows), held(100), "sub", {});
    expect(bare.currencyTotals[0]).toMatchObject({ forward12m: 0, forwardCoverage: { payers: 1, covered: 0 }, yieldsLeftOut: 1, forwardUncovered: [{ symbol: "AAA", account: "TFSA", reason: "partial_year" }] });
    expect(bare.yields[0]).toMatchObject({ yieldOnCost: null, currentYield: null });
    const text = incomeText(bare, "across all accounts");
    expect(text).toContain("Forward estimate from 0 of 1 holdings (a holding in each account counts once).");
    expect(text).toContain("Left out: AAA in TFSA (held under a year).");
    expect(incomeModelCopy(bare).currencyTotals[0]!.forwardUncovered).toEqual([{ symbol: "AAA", account: "TFSA", reason: "partial_year" }]);
  });

  it("a partial sale between the ex-date and the pay date: the right figure from market data, uncovered without it", async () => {
    const rows = [buy, ...["2025-11-15", "2026-02-15", "2026-05-15"].map((d) => paid(d)), act({ type: "SELL", units: -50, price: 8, amount: 400, tradeDate: "2026-08-10" }), paid("2026-08-15")];
    const p = await buildIncomePayload(deps(rows, { market: market(quarters(0.5)) }), held(50), "sub", {});
    expect(p.currencyTotals[0]).toMatchObject({ forward12m: 100, forwardCoverage: { payers: 1, covered: 1 } });
    const bare = await buildIncomePayload(deps(rows), held(50), "sub", {});
    expect(bare.currencyTotals[0]).toMatchObject({ forward12m: 0, forwardCoverage: { payers: 1, covered: 0 }, forwardUncovered: [{ symbol: "AAA", account: "TFSA", reason: "units_changed" }] });
  });

  it("a split as a CORPORATE_ACTION row: split-adjusted market figures on today's units", async () => {
    const split = act({ type: "CORPORATE_ACTION", units: 100, amount: 0, tradeDate: "2026-03-01" });
    const rows = [buy, paid("2025-11-15"), paid("2026-02-15"), split, paid("2026-05-15", 50), paid("2026-08-15", 50)];
    const p = await buildIncomePayload(deps(rows, { market: market(quarters(0.25)) }), held(200), "sub", {});
    expect(p.currencyTotals[0]).toMatchObject({ forward12m: 200, forwardCoverage: { payers: 1, covered: 1 } });
    expect(p.currencyTotals[0]!.yieldsLeftOut).toBeUndefined();
  });

  it("a USD listing paid in CAD falls back to the account's payments, and says so in CAD, never a USD figure as CAD", async () => {
    const rows = [
      act({ type: "BUY", symbol: "USX", securityCurrency: "USD", currency: "USD", units: 100, price: 10, amount: -1000, tradeDate: "2025-01-02" }),
      ...["2025-11-15", "2026-02-15", "2026-05-15", "2026-08-15"].map((tradeDate) => act({ symbol: "USX", securityCurrency: "USD", currency: "CAD", amount: 27, tradeDate })),
    ];
    const positions = portfolio([pos({ symbol: "USX", currency: "USD", units: 100, price: 20, costBasis: 10, marketValue: 2000 })]);
    const p = await buildIncomePayload(deps(rows, { market: { ...market(dist("USD", [["2026-05-01", 0.5]])), usdCad: vi.fn(async () => null) } }), positions, "sub", {});
    expect(p.currencyTotals.find((t) => t.currency === "CAD")).toMatchObject({ forward12m: 108, forwardCoverage: { payers: 1, covered: 1 } });
    expect(p.currencyTotals.find((t) => t.currency === "USD")?.forward12m ?? 0).toBe(0);
  });

  it("a US stock is net of the 15% withheld in the TFSA and gross in the RRSP", async () => {
    const usd = { symbol: "USS", currency: "USD", securityCurrency: "USD" };
    const line = (id: string, withheld: boolean) => [
      act({ ...usd, snapTradeAccountId: id, type: "BUY", units: 100, price: 10, amount: -1000, tradeDate: "2025-01-02" }),
      act({ ...usd, snapTradeAccountId: id, amount: 25, tradeDate: "2026-08-15" }),
      ...(withheld ? [act({ ...usd, snapTradeAccountId: id, type: "TAX", amount: -3.75, tradeDate: "2026-08-15" })] : []),
    ];
    const h = pos({ symbol: "USS", currency: "USD", units: 100, price: 20, costBasis: 10, marketValue: 2000 });
    const m = dist("USD", [["2025-11-01", 0.25], ["2026-02-01", 0.25], ["2026-05-01", 0.25], ["2026-08-01", 0.25]]);
    const p = await buildIncomePayload(deps([...line("TFSA", true), ...line("RRSP", false)], { market: market(m) }), accountsOf({ TFSA: [h], RRSP: [h] }), "sub", {});
    expect(p.currencyTotals[0]).toMatchObject({ currency: "USD", forward12m: 85 + 100, forwardCoverage: { payers: 2, covered: 2 } });
  });

  it("market failure never fails the income view: a rejection, a hang and a missing provider all use the activity path", async () => {
    const rows = [buy, topUp, ...quarterly];
    const rejecting = { distributions: vi.fn(async () => { throw new Error("boom"); }) };
    const hanging = { distributions: vi.fn(() => new Promise(() => undefined)) };
    for (const m of [rejecting, hanging, {}]) {
      const p = await buildIncomePayload(deps(rows, { market: m, marketDeadlineMs: 5 }), portfolio(), "sub", {});
      expect(p.currencyTotals[0]).toMatchObject({ forward12m: 240, forwardCoverage: { payers: 1, covered: 1 } });
    }
  });

  it("market data saying no distributions in 12 months while the account received some falls back to activity", async () => {
    const p = await buildIncomePayload(deps([buy, topUp, ...quarterly], { market: market(dist("CAD", [])) }), portfolio(), "sub", {});
    expect(p.currencyTotals[0]).toMatchObject({ forward12m: 240, forwardCoverage: { payers: 1, covered: 1 } });
  });

  it("five drifting market quarters count four; a year-old one is out", async () => {
    const m = dist("CAD", [["2025-10-20", 0.6], ["2026-01-19", 0.6], ["2026-04-20", 0.6], ["2026-07-19", 0.6], ["2026-10-15", 0.6]]);
    const p = await buildIncomePayload(deps([buy, topUp, ...quarterly], { market: market(m) }), held(120), "sub", {});
    expect(p.currencyTotals[0]!.forward12m).toBe(288);
  });

  it("a holding with no payment yet counts from market data; a holding that pays nothing is not a payer", async () => {
    const rows = [act({ type: "BUY", units: 100, price: 8, amount: -800, tradeDate: "2026-10-01" })];
    const paying = await buildIncomePayload(deps(rows, { market: market(quarters(0.5)) }), held(100), "sub", {});
    expect(paying.currencyTotals[0]).toMatchObject({ forward12m: 200, forwardCoverage: { payers: 1, covered: 1 } });
    const none = await buildIncomePayload(deps(rows, { market: market(dist("CAD", [])) }), held(100), "sub", {});
    expect(none.currencyTotals.map((t) => t.forwardCoverage)).toEqual([]);
  });

  it("each ticker is read once, at most four at a time, for the window of the true trailing year", async () => {
    let active = 0; let peak = 0;
    const distributions = vi.fn(async () => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 1)); active -= 1; return quarters(0.5); });
    const holdings = Array.from({ length: 12 }, (_, i) => pos({ symbol: `S${i}`, units: 10 }));
    await buildIncomePayload(deps([], { market: { distributions } }), accountsOf({ TFSA: holdings, RRSP: holdings }), "sub", {});
    expect(distributions).toHaveBeenCalledTimes(12);
    expect(distributions).toHaveBeenCalledWith("S0", "2025-10-16", "2026-10-16");
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("a partly covered symbol has no yield rather than a low one; the rest keep theirs", async () => {
    const line = (id: string) => act({ snapTradeAccountId: id, type: "BUY", units: 100, price: 8, amount: -800, tradeDate: id === "TFSA" ? "2025-01-02" : "2026-08-01" });
    const rows = [line("TFSA"), line("RRSP"), ...quarterly, paid("2026-08-15", 50, { snapTradeAccountId: "RRSP" })];
    const h = pos({ units: 100, costBasis: 8, marketValue: 1000 });
    const p = await buildIncomePayload(deps(rows), accountsOf({ TFSA: [h], RRSP: [h] }), "sub", {});
    expect(p.currencyTotals[0]).toMatchObject({ forward12m: 200, forwardCoverage: { payers: 2, covered: 1 }, yieldsLeftOut: 1 });
    expect(p.yields[0]).toMatchObject({ yieldOnCost: null, currentYield: null });
    expect(incomeText(p, "across all accounts")).toContain("Forward estimate from 1 of 2 holdings");
  });
});

describe("dividendPayments with market per-share figures", () => {
  it("a blank amount only because of the units check takes the market's per-share figure in the same currency", async () => {
    const sale = act({ type: "SELL", units: -50, price: 8, amount: 400, tradeDate: "2026-09-10" });
    const rows = [buy, act({ tradeDate: "2026-06-15" }), sale, act({ tradeDate: "2026-09-15", amount: 25 })];
    const accounts = portfolio([pos({ units: 50 })]).accounts;
    const distributions = vi.fn(async () => ({ currency: "CAD", events: [{ date: "2026-06-01", amount: 0.5 }, { date: "2026-09-01", amount: 0.55 }] }));
    const pays = await dividendPayments(deps(rows).activities, "u1", accounts, "2026-10-16", { market: { distributions } });
    expect(pays.find((x) => x.date.toISOString().startsWith("2026-09-15"))!.perUnit).toBe(0.55);
    const usd = vi.fn(async () => ({ currency: "USD", events: [{ date: "2026-09-01", amount: 0.55 }] }));
    expect((await dividendPayments(deps(rows).activities, "u1", accounts, "2026-10-16", { market: { distributions: usd } })).find((x) => x.date.toISOString().startsWith("2026-09-15"))!.perUnit).toBeNull();
    const failing = vi.fn(async () => { throw new Error("boom"); });
    expect((await dividendPayments(deps(rows).activities, "u1", accounts, "2026-10-16", { market: { distributions: failing } })).find((x) => x.date.toISOString().startsWith("2026-09-15"))!.perUnit).toBeNull();
  });
});
