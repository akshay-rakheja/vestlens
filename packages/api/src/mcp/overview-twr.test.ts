import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings/settings-service.js";
import { buildOverviewPayload, overviewText } from "./overview-tools.js";
import { buildPerformancePayload } from "./performance-tools.js";

const acct = (id: string, label: string, currency: string, amount: number): any => ({
  id, classification: { label, includedInPortfolioTotal: true, bucket: "other" }, value: { amount, currency }, positions: [], balances: [],
});
const portfolio = (): any => ({
  connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [],
  totals: [{ currency: "CAD", amount: 3500, source: "brokerage_reported" }],
  accounts: [acct("A", "TFSA", "CAD", 1500), acct("B", "RRSP", "CAD", 2000)],
});
const days = (n: number, start: string) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
// Weekdays and weekends both present; the deposit on 2026-10-05 lifts the value without being a return.
const rows = (): any[] => days(14, "2026-10-01").flatMap((date) => [
  { date, accountId: "A", currency: "CAD", value: date >= "2026-10-05" ? 1500 : 1000, source: "reported" },
  { date, accountId: "B", currency: "CAD", value: 2000, source: "reported" },
]);
const synced = { backfillCompletedAt: new Date("2026-09-01T00:00:00Z"), lastSyncedAt: new Date("2026-10-15T00:00:00Z"), lastError: null, dirty: false };

function deps(over: Record<string, any> = {}): any {
  return {
    market: {
      quotes: vi.fn(async () => new Map()),
      history: vi.fn(async (): Promise<any> => [{ date: "2025-12-30", close: 100 }, { date: "2026-10-01", close: 100 }, { date: "2026-10-14", close: 110 }]),
      usdCad: vi.fn(async (): Promise<any> => [{ date: "2026-01-01", close: 1.4 }]),
      securityHistory: vi.fn(async (): Promise<any> => null),
    },
    settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })), save: vi.fn() },
    dailyValues: { rows: vi.fn(async (): Promise<any[]> => rows()), earliest: vi.fn(async (): Promise<string | null> => "2026-10-01") },
    activities: {
      userId: vi.fn(async () => "user-1"),
      listActivities: vi.fn(async (_u: string, id: string): Promise<any[]> => id === "A"
        ? [{ snapTradeAccountId: "A", dedupeKey: "d1", type: "DEPOSIT", symbol: null, securityCurrency: null, isOption: false, units: null, price: null, amount: 500, fee: null, fxRate: null, currency: "CAD", tradeDate: "2026-10-05", settlementDate: "2026-10-05", description: null }]
        : []),
      syncState: vi.fn(async (): Promise<any> => synced),
      qualities: vi.fn(async () => []),
    },
    now: () => new Date("2026-10-15T15:00:00Z"),
    ...over,
  };
}

describe("overview time-weighted return", () => {
  it("agrees with Performance when an account has a gap in its history: both leave it out and the text says so", async () => {
    const pf = portfolio();
    pf.accounts.push({ ...acct("M", "Margin account", "CAD", 800), classification: { label: "Margin account", includedInPortfolioTotal: true, bucket: "margin" } });
    const act = (id: string, key: string, amount: number, date: string) => ({ snapTradeAccountId: id, dedupeKey: key, type: "DEPOSIT", symbol: null, securityCurrency: null, isOption: false, units: null, price: null, amount, fee: null, fxRate: null, currency: "CAD", tradeDate: date, settlementDate: date, description: null });
    const d = deps({
      dailyValues: {
        // M existed before the period but its values only start on Oct 9; a deposit on Oct 6 falls in the gap.
        rows: vi.fn(async () => [...rows(), ...days(6, "2026-10-09").map((date) => ({ date, accountId: "M", currency: "CAD", value: 800, source: "reported" }))]),
        earliest: vi.fn(async () => "2026-10-01"),
      },
    });
    d.activities.listActivities = vi.fn(async (_u: string, id: string) => id === "A" ? [act("A", "d1", 500, "2026-10-05")]
      : id === "M" ? [act("M", "m0", 300, "2025-06-02"), act("M", "m1", 200, "2026-10-06")] : []);
    const perf = await buildPerformancePayload(d, pf, "sub", { period: "YTD" });
    const overview = await buildOverviewPayload(d, pf, "sub", { period: "YTD" });
    expect(perf.notInFigures.map((a) => a.accountId)).toEqual(["M"]);
    expect(overview.history.incompleteAccounts).toEqual(["Margin account"]);
    expect(overview.series.investmentReturn.value).toBe(perf.figures.investmentReturn.value);
    expect(overview.series.points.at(-1)!.value).toBe(3500);
    expect(overviewText(overview)).toContain("Left out for this period: Margin account (gaps in its value history).");
  });

  it("matches the Performance widget's investment return and benchmark on the same data (YTD)", async () => {
    const d = deps();
    const perf = await buildPerformancePayload(d, portfolio(), "sub", { period: "YTD" });
    const overview = await buildOverviewPayload(d, portfolio(), "sub", { period: "YTD" });
    expect(perf.figures.investmentReturn.value).not.toBeNull();
    expect(overview.series.investmentReturn.value).toBe(perf.figures.investmentReturn.value);
    expect(overview.series.investmentReturn.estimated).toBe(perf.figures.investmentReturn.estimated);
    expect(overview.series.benchmarkReturnTwr.value).toBe(perf.figures.benchmarkReturn.value);
    // The deposit inflates the value change but not the investment return.
    expect(overview.series.portfolioReturn!).toBeGreaterThan(overview.series.investmentReturn.value! + 0.1);
  });
  it("agrees with Performance that a value step SnapTrade's records don't explain makes the return an estimate", async () => {
    const d = deps();
    d.activities.qualities = vi.fn(async () => [{ accountId: "B", method: "reconstructed", reason: null, driftFraction: 0, computedAt: "2026-10-15T00:00:00Z", unrecordedFlows: [{ date: "2026-10-08", amount: 700 }] }]);
    const perf = await buildPerformancePayload(d, portfolio(), "sub", { period: "YTD" });
    const overview = await buildOverviewPayload(d, portfolio(), "sub", { period: "YTD" });
    expect(perf.figures.investmentReturn.estimated).toBe(true);
    expect(overview.series.investmentReturn.value).toBe(perf.figures.investmentReturn.value);
    expect(overview.series.investmentReturn.estimated).toBe(true);
  });
  it("falls back with insufficient_history when 1W has fewer than five points", async () => {
    const d = deps({ dailyValues: { rows: vi.fn(async () => rows().filter((r) => r.date >= "2026-10-12")), earliest: vi.fn(async () => "2026-10-12") } });
    const o = await buildOverviewPayload(d, portfolio(), "sub", { period: "1W" });
    expect(o.series.points.length).toBeLessThan(5);
    expect(o.series.investmentReturn).toMatchObject({ value: null, reason: "insufficient_history" });
    expect(o.series.portfolioReturn).not.toBeNull();
  });
  it("reports flows_unavailable when the activities dependency is absent", async () => {
    const d = deps(); delete d.activities;
    const o = await buildOverviewPayload(d, portfolio(), "sub", { period: "YTD" });
    expect(o.series.investmentReturn).toEqual({ value: null, estimated: false, reason: "flows_unavailable" });
    expect(o.series.portfolioReturn).not.toBeNull();
  });
  it("reports flows_unavailable without securityHistory or when the user has no stored activity", async () => {
    const noSec = deps(); delete noSec.market.securityHistory;
    expect((await buildOverviewPayload(noSec, portfolio(), "sub", {})).series.investmentReturn.reason).toBe("flows_unavailable");
    const noUser = deps(); noUser.activities.userId = vi.fn(async () => null);
    expect((await buildOverviewPayload(noUser, portfolio(), "sub", {})).series.investmentReturn).toMatchObject({ value: null, reason: "flows_unavailable" });
  });
  it("still returns the overview when the helper throws", async () => {
    const d = deps();
    d.activities.qualities = vi.fn(() => { throw new Error("boom"); });
    d.activities.userId = vi.fn(() => { throw new Error("boom"); });
    const o = await buildOverviewPayload(d, portfolio(), "sub", {});
    expect(o.series.investmentReturn).toMatchObject({ value: null, reason: "error" });
    expect(o.series.points.length).toBeGreaterThan(1);
    expect(o.series.portfolioReturn).not.toBeNull();
  });
  it("still returns the overview within the deadline when the flow sources hang", async () => {
    const d = deps({ marketDeadlineMs: 30 });
    d.activities.userId = vi.fn(() => new Promise(() => {}));
    const started = Date.now();
    const o = await buildOverviewPayload(d, portfolio(), "sub", {});
    expect(Date.now() - started).toBeLessThan(1000);
    expect(o.series.investmentReturn).toMatchObject({ value: null, reason: "timeout" });
    expect(o.series.portfolioReturn).not.toBeNull();
  });
  it("overviewText says 'return ... (time-weighted ...)' with the TWR and 'value change' when falling back", async () => {
    const d = deps();
    const withTwr = overviewText(await buildOverviewPayload(d, portfolio(), "sub", { period: "1W" }));
    expect(withTwr).toMatch(/1W return [+-]\d+\.\d% vs S&P 500 \(total return, dividends reinvested\) [+-]\d+\.\d% \(time-weighted, investment accounts only, excludes money you added\)/);
    expect(withTwr).not.toMatch(/value change/);
    expect(overviewText(await buildOverviewPayload(d, portfolio(), "sub", { period: "YTD" }))).toMatch(/Return since Oct 1 [+-]\d+\.\d% vs S&P 500/);
    const noAct = deps(); delete noAct.activities;
    expect(overviewText(await buildOverviewPayload(noAct, portfolio(), "sub", { period: "1W" }))).toMatch(/1W value change/);
    const base = await buildOverviewPayload(d, portfolio(), "sub", { period: "YTD" });
    const est = overviewText({ ...base, series: { ...base.series, investmentReturn: { value: 0.05, estimated: true } } });
    expect(est).toContain("(estimated)");
  });
  it("fetches the benchmark history once on the CAD path", async () => {
    const d = deps();
    await buildOverviewPayload(d, portfolio(), "sub", { period: "YTD" });
    expect(d.market.history).toHaveBeenCalledTimes(1);
  });
  it("uses Performance's currency-aware benchmark for a USD primary currency", async () => {
    const usdPortfolio = (): any => ({ ...portfolio(), totals: [{ currency: "USD", amount: 3500, source: "brokerage_reported" }], accounts: [acct("A", "TFSA", "USD", 1500), acct("B", "RRSP", "USD", 2000)] });
    const d = deps({ dailyValues: { rows: vi.fn(async () => rows().map((r) => ({ ...r, currency: "USD" }))), earliest: vi.fn(async () => "2026-10-01") } });
    d.market.usdCad = vi.fn(async () => [{ date: "2025-12-01", close: 1.3 }, { date: "2026-10-10", close: 1.5 }]);
    // The per-currency view (the CAD view's agreement has its own test below).
    d.settings.get = vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView: false }));
    d.activities.listActivities = vi.fn(async (_u: string, id: string) => (id === "A" ? [{ snapTradeAccountId: "A", dedupeKey: "d1", type: "DEPOSIT", symbol: null, securityCurrency: null, isOption: false, units: null, price: null, amount: 500, fee: null, fxRate: null, currency: "USD", tradeDate: "2026-10-05", settlementDate: "2026-10-05", description: null }] : []));
    const perf = await buildPerformancePayload(d, usdPortfolio(), "sub", { period: "YTD", benchmark: "tsx" });
    const o = await buildOverviewPayload(d, usdPortfolio(), "sub", { period: "YTD", benchmark: "tsx" });
    expect(perf.scope.currency).toBe("USD");
    expect(perf.figures.benchmarkReturn.value).not.toBeNull();
    expect(o.series.benchmarkReturnTwr.value).toBe(perf.figures.benchmarkReturn.value);
    expect(o.series.investmentReturn.value).toBe(perf.figures.investmentReturn.value);
  });
  it("includes an account with stored rows but no current value in the flow scope", async () => {
    const d = deps();
    const pf = { ...portfolio(), accounts: [acct("A", "TFSA", "CAD", 1500), { ...acct("C", "RESP", "CAD", 0), value: null }] };
    d.dailyValues.rows = vi.fn(async () => [...rows(), ...days(14, "2026-10-01").map((date) => ({ date, accountId: "C", currency: "CAD", value: 100, source: "reported" }))]);
    await buildOverviewPayload(d, pf, "sub", { period: "YTD" });
    expect(d.activities.listActivities.mock.calls.map((c: any[]) => c[1]).sort()).toEqual(["A", "C"]);
  });
  it("returns the span the time-weighted return covers", async () => {
    const o = await buildOverviewPayload(deps(), portfolio(), "sub", { period: "YTD" });
    expect(o.series.returnSpan).toEqual({ partial: true, since: "2026-10-01" });
  });
  it("get_overview_series path carries the same fields", async () => {
    const { buildOverviewSeriesForTool } = await import("./overview-tools.js");
    const { series: s, leftOut } = await buildOverviewSeriesForTool(deps(), portfolio(), "sub", { period: "YTD" });
    expect(s.investmentReturn.value).not.toBeNull();
    expect(leftOut).toBe("");
  });
});

describe("overview time-weighted return follows valued windows (brief 6)", () => {
  it("a transfer into a not-yet-valued account is no loss in the overview either", async () => {
    const d = deps();
    const pf = { ...portfolio(), totals: [{ currency: "CAD", amount: 1050, source: "brokerage_reported" }], accounts: [acct("T", "TFSA", "CAD", 100), acct("C", "Cash", "CAD", 950)] };
    d.dailyValues.rows = vi.fn(async () => days(14, "2026-10-01").flatMap((date) => [
      { date, accountId: "T", currency: "CAD", value: date >= "2026-10-05" ? 100 : 1000, source: "reported" },
      ...(date >= "2026-10-10" ? [{ date, accountId: "C", currency: "CAD", value: 950, source: "reported" }] : []),
    ]));
    const leg = (id: string, type: string, amount: number) => ({ snapTradeAccountId: id, dedupeKey: `${id}-leg`, type, symbol: null, securityCurrency: null, isOption: false, units: null, price: null, amount, fee: null, fxRate: null, currency: "CAD", tradeDate: "2026-10-05", settlementDate: "2026-10-05", description: null });
    d.activities.listActivities = vi.fn(async (_u: string, id: string) => (id === "T" ? [leg("T", "INTERNAL_CASH_TRANSFER_OUT", -900)] : [leg("C", "INTERNAL_CASH_TRANSFER_IN", 900)]));
    const o = await buildOverviewPayload(d, pf, "sub", { period: "YTD" });
    expect(o.series.investmentReturn.value).not.toBeNull();
    expect(Math.abs(o.series.investmentReturn.value!)).toBeLessThan(0.005);
    const perf = await buildPerformancePayload(d, pf, "sub", { period: "YTD" });
    expect(o.series.investmentReturn.value).toBe(perf.figures.investmentReturn.value);
  });
  it("stored rows of a now-closed account do not distort the overview return", async () => {
    const d = deps();
    const closed = { ...acct("X", "Closed TFSA", "CAD", 0), classification: { label: "Closed TFSA", includedInPortfolioTotal: false, bucket: "tfsa" }, value: null };
    const pf = { ...portfolio(), totals: [{ currency: "CAD", amount: 1100, source: "brokerage_reported" }], accounts: [acct("T", "TFSA", "CAD", 1100), closed] };
    d.dailyValues.rows = vi.fn(async () => days(14, "2026-10-01").flatMap((date) => [
      { date, accountId: "T", currency: "CAD", value: date >= "2026-10-05" ? 1100 : 100, source: "reported" },
      ...(date < "2026-10-05" ? [{ date, accountId: "X", currency: "CAD", value: 1000, source: "reported" }] : []),
    ]));
    const leg = { snapTradeAccountId: "T", dedupeKey: "T-in", type: "CONTRIBUTION", symbol: null, securityCurrency: null, isOption: false, units: null, price: null, amount: 1000, fee: null, fxRate: null, currency: "CAD", tradeDate: "2026-10-05", settlementDate: "2026-10-05", description: null };
    d.activities.listActivities = vi.fn(async (_u: string, id: string) => (id === "T" ? [leg] : []));
    const o = await buildOverviewPayload(d, pf, "sub", { period: "YTD" });
    expect(Math.abs(o.series.investmentReturn.value!)).toBeLessThan(0.005);
    const perf = await buildPerformancePayload(d, pf, "sub", { period: "YTD" });
    expect(o.series.investmentReturn.value).toBe(perf.figures.investmentReturn.value);
  });
});

describe("overview figures follow the brokerage (brief 9)", () => {
  const usInCad = (): any => ({
    ...portfolio(),
    totals: [{ currency: "CAD", amount: 100, source: "brokerage_reported" }],
    accounts: [{ ...acct("A", "TFSA", "CAD", 100), positions: [
      { instrumentId: "U", kind: "stock", symbol: "SYNTHETICU", description: null, units: 10, price: 5, costBasis: 4, marketValue: 50, unrealizedGain: 10, currency: "USD", cashEquivalent: false },
    ] }],
  });
  it("4: converts foreign holdings for the largest holding with the latest BoC rate", async () => {
    const d = deps();
    d.market.usdCad = vi.fn(async () => [{ date: "2026-10-10", close: 1.3 }, { date: "2026-10-14", close: 1.4 }]);
    const o = await buildOverviewPayload(d, usInCad(), "sub", { period: "YTD" });
    expect(o.summary.largestHolding).toMatchObject({ symbol: "SYNTHETICU", estimated: true });
    expect(o.summary.largestHolding!.fraction).toBeCloseTo(70 / 100, 9);
  });
  it("5: the fallback text never compares a value change with an index", async () => {
    const noAct = deps(); delete noAct.activities;
    const text = overviewText(await buildOverviewPayload(noAct, portfolio(), "sub", { period: "1W" }));
    expect(text).toMatch(/1W value change [+-]\d+\.\d% \(investment accounts, includes deposits\)/);
    expect(text).toMatch(/needs deposit history/);
    expect(text).not.toMatch(/vs S&P 500 [+-]/);
  });
});

describe("CAD view: Overview and Performance agree (task 11)", () => {
  it("one CAD return over CAD and USD accounts, the same in both widgets", async () => {
    const mixed = (): any => ({ ...portfolio(), totals: [{ currency: "CAD", amount: 1500, source: "brokerage_reported" }, { currency: "USD", amount: 2000, source: "brokerage_reported" }], accounts: [acct("A", "TFSA", "CAD", 1500), acct("B", "Non-registered", "USD", 2000)] });
    const d = deps({ dailyValues: { rows: vi.fn(async () => rows().map((r) => (r.accountId === "B" ? { ...r, currency: "USD" } : r))), earliest: vi.fn(async () => "2026-10-01") } });
    d.market.usdCad = vi.fn(async () => days(30, "2025-12-20").concat(days(30, "2026-09-25")).map((date) => ({ date, close: date >= "2026-10-08" ? 1.45 : 1.4 })));
    const perf = await buildPerformancePayload(d, mixed(), "sub", { period: "YTD" });
    const o = await buildOverviewPayload(d, mixed(), "sub", { period: "YTD" });
    expect(perf.scope.currency).toBe("CAD");
    expect(o.series.currency).toBe("CAD");
    expect(perf.figures.investmentReturn.value).not.toBeNull();
    // The USD account's CAD value moves with the rate: that is part of a CAD return.
    expect(perf.figures.investmentReturn.value!).toBeGreaterThan(0.01);
    expect(o.series.investmentReturn.value).toBe(perf.figures.investmentReturn.value);
    expect(o.series.investmentReturn.estimated).toBe(true);
    expect(perf.figures.investmentReturn.estimated).toBe(true);
    expect(o.series.points.map((p) => p.value)).toEqual(perf.series.value.map((p) => p.value));
  });
});

describe("CAD view: a USD flow without a rate withholds the return in both widgets (fix round 1)", () => {
  it("Overview and Performance both say the deposit could not be converted", async () => {
    const mixed = (): any => ({ ...portfolio(), totals: [{ currency: "CAD", amount: 1500, source: "brokerage_reported" }, { currency: "USD", amount: 2000, source: "brokerage_reported" }], accounts: [acct("A", "TFSA", "CAD", 1500), acct("B", "Non-registered", "USD", 2000)] });
    const d = deps({ dailyValues: { rows: vi.fn(async () => rows().map((r) => (r.accountId === "B" ? { ...r, currency: "USD" } : r))), earliest: vi.fn(async () => "2026-10-01") } });
    // No rate within 7 days of Oct 10 (rates end Sep 30, resume Oct 11).
    d.market.usdCad = vi.fn(async () => days(30, "2025-12-20").concat(days(11, "2026-09-20"), days(5, "2026-10-11")).map((date) => ({ date, close: 1.4 })));
    d.activities.listActivities = vi.fn(async (_u: string, id: string) => (id === "B" ? [{ snapTradeAccountId: "B", dedupeKey: "u1", type: "DEPOSIT", symbol: null, securityCurrency: null, isOption: false, units: null, price: null, amount: 50, fee: null, fxRate: null, currency: "USD", tradeDate: "2026-10-10", settlementDate: "2026-10-10", description: null }] : []));
    const perf = await buildPerformancePayload(d, mixed(), "sub", { period: "YTD" });
    const o = await buildOverviewPayload(d, mixed(), "sub", { period: "YTD" });
    expect(perf.figures.investmentReturn).toMatchObject({ value: null, reason: "flow_not_converted" });
    expect(o.series.investmentReturn).toMatchObject({ value: null, reason: "flow_not_converted" });
    expect(o.series.home?.flowNotConverted).toBe("2026-10-10");
    expect(o.series.points.length).toBeGreaterThan(2);
  });
});
