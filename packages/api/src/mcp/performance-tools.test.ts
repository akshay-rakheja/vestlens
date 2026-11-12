import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings/settings-service.js";
import { minusMonths } from "../analytics/value-series.js";
import { PERFORMANCE_WIDGET_URI, PerformanceScopeError, buildPerformancePayload, performanceModelCopy, performanceText, performanceToolDefinitions, performanceInput, displaySeries } from "./performance-tools.js";

const acct = (id: string, label: string, currency: string, included: boolean, amount: number | null = 1000): any => ({
  id, classification: { label, includedInPortfolioTotal: included, bucket: "other" }, value: amount === null ? null : { amount, currency }, positions: [], balances: [],
});
const portfolio = (over: Record<string, any> = {}): any => ({
  connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [],
  totals: [{ currency: "CAD", amount: 3000, source: "brokerage_reported" }, { currency: "USD", amount: 500, source: "brokerage_reported" }],
  accounts: [acct("A", "TFSA", "CAD", true, 1000), acct("B", "RRSP", "CAD", true, 2000), acct("U", "Non-registered", "USD", true, 500), acct("X", "Credit card", "CAD", false, 50)],
  ...over,
});
const dates = (n: number, start = "2026-09-01") => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
const rowsFor = (id: string, currency: string, v: number, n = 12) => dates(n).map((date) => ({ date, accountId: id, currency, value: v, source: "reported" as const }));
const act = (over: Record<string, any>): any => ({ snapTradeAccountId: "A", dedupeKey: Math.random().toString(), type: "DEPOSIT", symbol: null, securityCurrency: null, isOption: false, units: null, price: null, amount: null, fee: null, fxRate: null, currency: "CAD", tradeDate: null, settlementDate: null, description: null, ...over });

const synced = { backfillCompletedAt: new Date("2026-09-01T00:00:00Z"), lastSyncedAt: new Date("2026-10-15T00:00:00Z"), lastError: null, dirty: false };

function deps(over: Record<string, any> = {}): any {
  return {
    market: {
      history: vi.fn(async (): Promise<any> => [{ date: "2026-09-01", close: 100 }, { date: "2026-10-14", close: 110 }]),
      usdCad: vi.fn(async (): Promise<any> => [{ date: "2026-08-01", close: 1.4 }]),
      securityHistory: vi.fn(async (): Promise<any> => null),
    },
    // These fixtures predate the CAD view: they pin it off (the CAD view has its own tests below).
    settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView: false })), save: vi.fn() },
    dailyValues: {
      rows: vi.fn(async (): Promise<any[]> => [...rowsFor("A", "CAD", 1000), ...rowsFor("B", "CAD", 2000), ...rowsFor("X", "CAD", 777), ...rowsFor("U", "USD", 500)]),
      earliest: vi.fn(async (): Promise<string | null> => "2026-09-01"),
    },
    activities: {
      userId: vi.fn(async () => "user-1"),
      listActivities: vi.fn(async (): Promise<any[]> => []),
      syncState: vi.fn(async (): Promise<any> => synced),
      qualities: vi.fn(async () => [{ accountId: "A", method: "ledger", reason: null, driftFraction: 0.01, computedAt: new Date() }, { accountId: "U", method: "x", reason: "r", driftFraction: null, computedAt: new Date() }]),
    },
    now: () => new Date("2026-10-15T15:00:00Z"),
    ...over,
  };
}

describe("buildPerformancePayload", () => {
  it("leaves an account with a gap in its history out of the figures and names it, without amounts", async () => {
    const margin = { ...acct("M", "Margin account", "CAD", true, 1500), classification: { label: "Margin account", includedInPortfolioTotal: true, bucket: "margin" } };
    const pf = portfolio({ accounts: [acct("A", "TFSA", "CAD", true, 1000), margin, acct("N", "FHSA", "CAD", true, 300)] });
    const d = deps();
    const from = (id: string, v: number, start: string) => dates(12).filter((x) => x >= start).map((date) => ({ date, accountId: id, currency: "CAD", value: v, source: "reported" as const }));
    // M existed before the span (a deposit in August) but its values only start on Sep 6; N is new, opened Sep 3.
    d.dailyValues.rows = vi.fn(async () => [...rowsFor("A", "CAD", 1000), ...from("M", 1500, "2026-09-06"), ...from("N", 300, "2026-09-06")]);
    d.activities.listActivities = vi.fn(async (_u: string, id: string) => id === "M"
      ? [act({ snapTradeAccountId: "M", type: "DEPOSIT", amount: 900, tradeDate: "2026-08-20" }),
         act({ snapTradeAccountId: "M", type: "DEPOSIT", amount: 600, tradeDate: "2026-09-03" }),
         act({ snapTradeAccountId: "M", type: "DEPOSIT", amount: 400, tradeDate: "2026-09-08" })]
      : id === "A" ? [act({ snapTradeAccountId: "A", type: "DEPOSIT", amount: 100, tradeDate: "2026-09-04" })]
      : id === "N" ? [act({ snapTradeAccountId: "N", type: "DEPOSIT", amount: 300, tradeDate: "2026-09-03" })] : []);
    const p = await buildPerformancePayload(d, pf, "sub", { period: "ALL" });
    // M is out of the figures: the value line and the deposits are A's and N's only.
    expect(p.notInFigures).toEqual([{ accountId: "M", label: "Margin account", name: "", reason: "history_gaps" }]);
    expect(p.deposits!.byAccount.map((r) => r.accountId)).not.toContain("M");
    expect(p.series.value.at(-1)!.value).toBe(1300);
    // N is a new account whose first deposit its join value includes, not a gap: it stays in.
    expect(p.history.qualities.map((q) => q.accountId)).toEqual(["A"]);
    const text = performanceText(p);
    expect(text).toContain("(total return, dividends reinvested)");
    expect(text).toContain("Left out for this period: Margin account (gaps in its value history).");
    expect(text).not.toContain("1,500");
  });

  it("a flow SnapTrade's records miss inside the span marks the figures estimated and is explained in the text", async () => {
    const d = deps();
    d.activities.qualities = vi.fn(async () => [
      { accountId: "A", method: "reconstructed", reason: null, driftFraction: 0, computedAt: new Date(), unrecordedFlows: [{ date: "2026-09-05", amount: 5000 }, { date: "2026-07-01", amount: 900 }] },
      { accountId: "B", method: "reconstructed", reason: null, driftFraction: 0, computedAt: new Date(), unrecordedFlows: [{ date: "2026-09-08", amount: -400 }] },
      // USD account: outside this CAD scope, so never named.
      { accountId: "U", method: "reconstructed", reason: null, driftFraction: 0, computedAt: new Date(), unrecordedFlows: [{ date: "2026-09-06", amount: 300 }] },
    ]);
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.unrecorded).toEqual([
      { accountId: "A", label: "TFSA", name: "", date: "2026-09-05", amount: 5000, currency: "CAD" },
      { accountId: "B", label: "RRSP", name: "", date: "2026-09-08", amount: -400, currency: "CAD" },
    ]);
    expect(p.figures.investmentReturn.estimated).toBe(true);
    expect(p.figures.personalReturn.estimated).toBe(true);
    const text = performanceText(p);
    expect(text).toContain("TFSA's value rose by about 5,000 CAD on Sep 5 with no deposit in SnapTrade's records: if you added money then, SnapTrade hasn't reported it, so these figures count it as investment gain.");
    expect(text).toContain("RRSP's value fell by about 400 CAD on Sep 8 with no withdrawal in SnapTrade's records: if money left then, or a recorded deposit never arrived, these figures count it as an investment loss.");
    expect(text).not.toContain("900");
  });

  it("no flow inside the span: nothing named and the figures stay as they are", async () => {
    const d = deps();
    d.activities.qualities = vi.fn(async () => [{ accountId: "A", method: "reconstructed", reason: null, driftFraction: 0, computedAt: new Date(), unrecordedFlows: [{ date: "2026-07-01", amount: 900 }] }]);
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.unrecorded).toEqual([]);
    expect(p.figures.investmentReturn.estimated).toBe(false);
    expect(performanceText(p)).not.toContain("SnapTrade's records");
  });

  it("flags a new account whose values start well after its deposits (positions history missing)", async () => {
    const pf = portfolio({ accounts: [acct("A", "TFSA", "CAD", true, 1000), acct("L", "FHSA", "CAD", true, 300)] });
    const d = deps();
    // L opens Sep 3 (after the span starts) but is valued only from Sep 10: its deposit isn't in any join value.
    d.dailyValues.rows = vi.fn(async () => [...rowsFor("A", "CAD", 1000), ...dates(12).filter((x) => x >= "2026-09-10").map((date) => ({ date, accountId: "L", currency: "CAD", value: 300, source: "reported" as const }))]);
    d.activities.listActivities = vi.fn(async (_u: string, id: string) => id === "L" ? [act({ snapTradeAccountId: "L", type: "DEPOSIT", amount: 300, tradeDate: "2026-09-03" })] : []);
    const p = await buildPerformancePayload(d, pf, "sub", { period: "ALL" });
    expect(p.notInFigures.map((a) => [a.accountId, a.reason])).toEqual([["L", "history_gaps"]]);
    expect(p.series.value.at(-1)!.value).toBe(1000);
  });

  it("leaves managed portfolios out of every figure and names them; asking for one says why", async () => {
    const managed = { ...acct("M", "Automated portfolio", "CAD", true, 0), name: "Wealthsimple Trade PERSONAL", classification: { label: "Automated portfolio", includedInPortfolioTotal: true, bucket: "automated_portfolio" } };
    const pf = portfolio({ accounts: [acct("A", "TFSA", "CAD", true, 1000), managed] });
    const d = deps();
    d.dailyValues.rows = vi.fn(async () => [...rowsFor("A", "CAD", 1000), ...rowsFor("M", "CAD", 0)]);
    d.activities.listActivities = vi.fn(async (_u: string, id: string) => id === "M" ? [act({ snapTradeAccountId: "M", type: "DEPOSIT", amount: 1300, tradeDate: "2026-09-04" })] : []);
    const p = await buildPerformancePayload(d, pf, "sub", { period: "ALL" });
    expect(p.notInFigures).toEqual([{ accountId: "M", label: "Automated portfolio", name: "Wealthsimple Trade PERSONAL", reason: "managed" }]);
    expect(p.accounts.map((a) => a.id)).not.toContain("M");
    expect(p.deposits!.byAccount.map((r) => r.accountId)).not.toContain("M");
    expect(p.deposits!.leftOut).toEqual([]);
    expect(performanceText(p)).toContain("Left out: Automated portfolio (managed; SnapTrade doesn't provide its holdings history).");
    await expect(buildPerformancePayload(d, pf, "sub", { accountId: "M" })).rejects.toMatchObject({ code: "managed_account" });
  });

  it("says a Cash account is not covered by returns rather than calling it unknown", async () => {
    const cash = { ...acct("C", "Cash / money market", "CAD", true, 4000), classification: { label: "Cash / money market", includedInPortfolioTotal: true, bucket: "money_market" } };
    const pf = portfolio({ accounts: [acct("A", "TFSA", "CAD", true, 1000), cash] });
    await expect(buildPerformancePayload(deps(), pf, "sub", { accountId: "C" })).rejects.toMatchObject({ code: "cash_account" });
    await expect(buildPerformancePayload(deps(), pf, "sub", { accountId: "nope" })).rejects.toMatchObject({ code: "unknown_account" });
  });

  it("never pairs two investment legs routed through Cash: money out of one is taken out, money into the other is put in", async () => {
    const cash = { ...acct("C", "Cash / money market", "CAD", true, 4000), classification: { label: "Cash / money market", includedInPortfolioTotal: true, bucket: "money_market" } };
    const pf = portfolio({ accounts: [acct("A", "TFSA", "CAD", true, 1000), acct("B", "Non-registered", "CAD", true, 2000), cash] });
    const d = deps();
    d.dailyValues.rows = vi.fn(async () => [...rowsFor("A", "CAD", 1000), ...rowsFor("B", "CAD", 2000), ...rowsFor("C", "CAD", 4000)]);
    d.activities.listActivities = vi.fn(async (_u: string, id: string) => id === "B"
      ? [act({ snapTradeAccountId: "B", type: "INTERNAL_CASH_TRANSFER_OUT", amount: -500, tradeDate: "2026-09-07" })]
      : id === "C" ? [
          act({ snapTradeAccountId: "C", type: "INTERNAL_CASH_TRANSFER_IN", amount: 500, tradeDate: "2026-09-07" }),
          act({ snapTradeAccountId: "C", type: "INTERNAL_CASH_TRANSFER_OUT", amount: -500, tradeDate: "2026-09-09" }),
        ]
      : id === "A" ? [act({ snapTradeAccountId: "A", type: "INTERNAL_CASH_TRANSFER_IN", amount: 500, tradeDate: "2026-09-09" })] : []);
    const p = await buildPerformancePayload(d, pf, "sub", { period: "ALL" });
    expect(p.deposits).toMatchObject({ putIn: 500, takenOut: -500 });
    expect(p.figures.netDeposits.value).toBe(0);
    expect(p.deposits!.byAccount).toMatchObject([
      { accountId: "A", label: "TFSA", putIn: 500, takenOut: 0 },
      { accountId: "B", label: "Non-registered", putIn: 0, takenOut: -500 },
    ]);
  });

  it("leaves the Cash account out of returns: a transfer from Cash into the TFSA is money put in, pay and spending are not", async () => {
    const cash = { ...acct("C", "Cash / money market", "CAD", true, 4000), classification: { label: "Cash / money market", includedInPortfolioTotal: true, bucket: "money_market" } };
    const pf = portfolio({ accounts: [acct("A", "TFSA", "CAD", true, 1000), acct("B", "RRSP", "CAD", true, 2000), cash] });
    const d = deps();
    d.dailyValues.rows = vi.fn(async () => [...rowsFor("A", "CAD", 1000), ...rowsFor("B", "CAD", 2000), ...rowsFor("C", "CAD", 4000)]);
    d.activities.listActivities = vi.fn(async (_u: string, id: string) => id === "C"
      ? [act({ snapTradeAccountId: "C", type: "DEPOSIT", amount: 3000, tradeDate: "2026-09-03" }),
         act({ snapTradeAccountId: "C", type: "SPEND", amount: -2500, tradeDate: "2026-09-04" }),
         act({ snapTradeAccountId: "C", type: "INTERNAL_CASH_TRANSFER_OUT", amount: -1000, tradeDate: "2026-09-05" })]
      : id === "A" ? [act({ snapTradeAccountId: "A", type: "INTERNAL_CASH_TRANSFER_IN", amount: 1000, tradeDate: "2026-09-05" })]
      : id === "B" ? [act({ snapTradeAccountId: "B", type: "WITHDRAWAL", amount: -200, tradeDate: "2026-09-08" })] : []);
    const p = await buildPerformancePayload(d, pf, "sub", { period: "ALL" });
    expect(p.accounts.map((a) => a.id)).toEqual(["A", "B"]);
    // Cash is read only to pair transfer legs; its pay, spending and balance never enter the figures.
    expect(p.figures.netDeposits.value).toBe(800);
    expect(p.deposits).toMatchObject({ putIn: 1000, takenOut: -200, leftOut: ["Cash / money market"] });
    expect(p.deposits!.byAccount).toMatchObject([
      { accountId: "A", label: "TFSA", putIn: 1000, takenOut: 0, value: { amount: 1000, currency: "CAD" } },
      { accountId: "B", label: "RRSP", putIn: 0, takenOut: -200, value: { amount: 2000, currency: "CAD" } },
    ]);
    expect(p.deposits!.putIn + p.deposits!.takenOut).toBe(p.figures.netDeposits.value);
    const text = performanceText(p);
    expect(text).toContain("put in +1,000.00 CAD, taken out -200.00 CAD, net deposits +800.00 CAD");
    expect(text).toContain("Cash / money market is left out");
  });

  it("sums only included scope accounts at portfolio scope and lists other currencies", async () => {
    const d = deps();
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.scope).toMatchObject({ kind: "portfolio", currency: "CAD", label: "All accounts" });
    // F3 (spec §2): other-currency accounts are listed in the dropdown too.
    expect(p.accounts.map((a) => a.id)).toEqual(["A", "B", "U"]);
    expect(p.otherCurrencies).toEqual(["USD"]);
    expect(p.series.value[0].value).toBe(3000);
    expect(p.series.value.at(-1)).toMatchObject({ date: "2026-10-15", value: 3000 });
    expect(p.asOf).toBe("2026-10-15T15:00:00.000Z");
    expect(p.history.qualities.map((q) => q.accountId)).toEqual(["A"]);
    expect(p.history.earliest).toBe("2026-09-01");
  });
  it("account scope in USD passes USD to the benchmark and has no note for the S&P 500", async () => {
    const d = deps();
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL", accountId: "U" });
    expect(p.scope).toMatchObject({ kind: "account", accountId: "U", currency: "USD", label: "Non-registered" });
    expect(d.market.usdCad).not.toHaveBeenCalled();
    expect(p.benchmark.note).toBeNull();
    expect(p.series.value[0].value).toBe(500);
  });
  it("converts a CAD index for a USD scope and says so", async () => {
    const p = await buildPerformancePayload(deps(), portfolio(), "sub", { period: "ALL", accountId: "U", benchmark: "tsx" });
    expect(p.benchmark.note).toMatch(/CAD index converted to USD/);
  });
  it("rejects unknown and excluded accounts", async () => {
    for (const accountId of ["nope", "X"]) {
      const err = await buildPerformancePayload(deps(), portfolio(), "sub", { accountId }).catch((e) => e);
      expect(err).toBeInstanceOf(PerformanceScopeError);
      expect(err.code).toBe("unknown_account");
    }
  });
  it("falls back to DailyValue currency when the account value is null, and drops accounts with neither", async () => {
    const pf = portfolio({ accounts: [acct("A", "TFSA", "CAD", true, null), acct("Z", "Empty", "CAD", true, null)] });
    const p = await buildPerformancePayload(deps(), pf, "sub", { period: "ALL" });
    expect(p.accounts.map((a) => a.id)).toEqual(["A"]);
    // today's value unknown -> stored rows only, no point on today
    expect(p.series.value.at(-1)?.date).not.toBe("2026-10-15");
  });
  it("flows unavailable keeps the investment return", async () => {
    const d = deps();
    d.activities.listActivities = vi.fn(async () => { throw new Error("db"); });
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.figures.personalReturn.reason).toBe("flows_unavailable");
    expect(p.figures.investmentReturn.value).not.toBeNull();
  });
  it("a benchmark that never settles degrades to unavailable", async () => {
    const d = deps({ marketDeadlineMs: 20 });
    d.market.history = vi.fn(() => new Promise(() => {}));
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.benchmark.unavailableReason).toBeTruthy();
    expect(p.figures.benchmarkReturn.reason).toBe("benchmark_unavailable");
  });
  it("uses the settings benchmark and lets input override it", async () => {
    const d = deps();
    d.settings.get = vi.fn(async () => ({ ...DEFAULT_SETTINGS, benchmark: "tsx" }));
    expect((await buildPerformancePayload(d, portfolio(), "sub", {})).benchmark.key).toBe("tsx");
    expect((await buildPerformancePayload(d, portfolio(), "sub", { benchmark: "dow" })).benchmark.key).toBe("dow");
    expect((await buildPerformancePayload(d, portfolio(), "sub", {})).period).toBe("YTD");
  });
  it("derives period starts from earliest() for ALL and minusMonths for 3Y", async () => {
    const d = deps();
    await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(d.dailyValues.earliest).toHaveBeenCalledWith("sub", "CAD");
    expect(d.dailyValues.rows).toHaveBeenLastCalledWith("sub", "2026-09-01");
    await buildPerformancePayload(d, portfolio(), "sub", { period: "3Y" });
    expect(d.dailyValues.rows).toHaveBeenLastCalledWith("sub", minusMonths("2026-10-15", 36));
  });
  it("nets internal transfers at portfolio scope but not at account scope", async () => {
    const d = deps();
    d.activities.listActivities = vi.fn(async (_u: string, id: string) => id === "A"
      ? [act({ snapTradeAccountId: "A", type: "INTERNAL_CASH_TRANSFER_OUT", amount: -500, tradeDate: "2026-09-05" })]
      : [act({ snapTradeAccountId: "B", type: "INTERNAL_CASH_TRANSFER_IN", amount: 500, tradeDate: "2026-09-07" })]);
    const port = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(port.figures.netDeposits.value).toBe(0);
    const accountA = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL", accountId: "A" });
    expect(accountA.figures.netDeposits.value).toBe(-500);
  });
  it("prices in-kind transfers from split-adjusted history without fetching priced ones", async () => {
    const d = deps();
    d.market.securityHistory = vi.fn(async () => ({ points: [{ date: "2026-09-01", close: 10 }], splits: [{ date: "2026-09-08", ratio: 2 }] }));
    d.activities.listActivities = vi.fn(async (_u: string, id: string) => id === "A" ? [
      act({ type: "TRANSFER", symbol: "ZZZ", units: 10, price: null, currency: "CAD", tradeDate: "2026-09-05" }),
      act({ type: "TRANSFER", symbol: "PPP", units: 1, price: 5, currency: "CAD", tradeDate: "2026-09-05" }),
    ] : []);
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(d.market.securityHistory).toHaveBeenCalledTimes(1);
    expect(p.figures.netDeposits.value).toBe(10 * 10 * 2 + 5);
  });
  it("treats unpriceable in-kind symbols as unknown flows", async () => {
    const d = deps();
    d.market.securityHistory = vi.fn(async () => ({ points: [], splits: null, notFound: true }));
    d.activities.listActivities = vi.fn(async (_u: string, id: string) => id === "A" ? [act({ type: "TRANSFER", symbol: "ZZZ", units: 10, price: null, tradeDate: "2026-09-05" })] : []);
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.figures.netDeposits.estimated).toBe(true);
  });
});

describe("performanceText", () => {
  it("is one line without ids or symbols, with since and n/a", async () => {
    const d = deps();
    d.dailyValues.rows = vi.fn(async () => rowsFor("A", "CAD", 1000, 3));
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "YTD" });
    const text = performanceText(p);
    expect(text).toContain("since");
    expect(text).toContain("n/a");
    expect(text).not.toMatch(/\bA\b|\bB\b|\bU\b|TFSA/);
    expect(text.includes("\n")).toBe(false);
  });
  it("formats the full example", async () => {
    const p = await buildPerformancePayload(deps(), portfolio(), "sub", { period: "ALL" });
    expect(performanceText(p)).toMatch(/^ALL \(All accounts, CAD\): your return /);
    expect(performanceText(p)).toMatch(/vs S&P 500/);
    expect(performanceText(p)).not.toMatch(/Showing/);
  });
  it("adds the yearly rate (CAGR) for 3Y and All, and says so when there's under a year", async () => {
    const p = await buildPerformancePayload(deps(), portfolio(), "sub", { period: "ALL" });
    const withYears = { ...p, span: { ...p.span, start: "2023-01-02" }, figures: { ...p.figures,
      investmentCagr: { value: 0.123, estimated: true, years: 3.8 }, benchmarkCagr: { value: 0.101, estimated: false, years: 3.8 } } };
    expect(performanceText(withYears)).toContain("Per year since Jan 2, 2023 (3.8 years): your investments +12.3% (est.) a year (time-weighted, deposits excluded) against the S&P 500's +10.1% a year.");
    const short = { ...p, figures: { ...p.figures, investmentCagr: { value: null, estimated: false, reason: "under_a_year" as const } } };
    expect(performanceText(short)).toContain("Under a year of history, so no yearly rate yet.");
    expect(performanceText({ ...withYears, period: "1Y" })).not.toMatch(/Per year/);
    const noBench = { ...withYears, figures: { ...withYears.figures, investmentCagr: { value: 0.123, estimated: true, years: 2 }, benchmarkCagr: { value: null, estimated: false, reason: "benchmark_unavailable" as const } } };
    expect(performanceText(noBench)).toContain("(2.0 years): your investments +12.3% (est.) a year (time-weighted, deposits excluded).");
  });
});

describe("tool definitions and input", () => {
  it("has the exact names and _meta", () => {
    const [show, get] = performanceToolDefinitions;
    expect(show.name).toBe("show_performance");
    expect(get.name).toBe("get_performance");
    expect(show._meta).toMatchObject({ ui: { resourceUri: PERFORMANCE_WIDGET_URI }, "openai/outputTemplate": PERFORMANCE_WIDGET_URI, "openai/widgetAccessible": true, "openai/toolInvocation/invoking": "Loading performance…", "openai/toolInvocation/invoked": "Performance ready." });
    expect(show._meta.securitySchemes).toEqual([{ type: "oauth2", scopes: ["portfolio:read"] }]);
    expect(get._meta).toMatchObject({ ui: { visibility: ["app"] } });
    expect(get.inputSchema.required).toEqual(["period"]);
    expect(show.inputSchema.additionalProperties).toBe(false);
    expect(get.annotations.readOnlyHint).toBe(true);
    expect(show.description).toMatch(/read-only/i);
    expect(show.description).toMatch(/returns net of deposits/i);
    expect(PERFORMANCE_WIDGET_URI).toBe("ui://portfolio/performance-v1");
  });
  it("declares a strict outputSchema matching the payload keys", () => {
    const keys = ["scope", "accounts", "period", "span", "series", "figures", "monthly", "benchmark", "benchmarks", "settings", "history", "otherCurrencies", "asOf", "home"];
    for (const def of performanceToolDefinitions) {
      expect(def.outputSchema.type).toBe("object");
      expect(def.outputSchema.additionalProperties).toBe(false);
      expect([...def.outputSchema.required].sort()).toEqual([...keys].sort());
      expect(Object.keys(def.outputSchema.properties).sort()).toEqual([...keys].sort());
    }
  });
  it("parses strictly", () => {
    expect(performanceInput.parse({ period: "1M" })).toEqual({ period: "1M" });
    expect(() => performanceInput.parse({ extra: 1 })).toThrow();
    expect(() => performanceInput.parse({ accountId: "" })).toThrow();
  });
});

describe("fix round 1", () => {
  const one = (id: string, activities: any[]) => (_u: string, a: string) => Promise.resolve(a === id ? activities : []);
  it("converts a USD deposit into a CAD scope (multiply)", async () => {
    const d = deps();
    d.market.usdCad = vi.fn(async () => [{ date: "2026-08-27", close: 1.4 }]);
    d.activities.listActivities = vi.fn(one("A", [act({ type: "DEPOSIT", amount: 100, currency: "USD", tradeDate: "2026-09-05" })]));
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.figures.netDeposits.value).toBeCloseTo(140, 8);
  });
  it("converts a CAD deposit into a USD scope (divide)", async () => {
    const d = deps();
    d.market.usdCad = vi.fn(async () => [{ date: "2026-08-27", close: 1.4 }]);
    d.activities.listActivities = vi.fn(one("U", [act({ snapTradeAccountId: "U", type: "DEPOSIT", amount: 140, currency: "CAD", tradeDate: "2026-09-05" })]));
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL", accountId: "U" });
    expect(p.figures.netDeposits.value).toBeCloseTo(100, 8);
  });
  it("converts an in-kind USD security price into the CAD scope", async () => {
    const d = deps();
    d.market.usdCad = vi.fn(async () => [{ date: "2026-08-27", close: 1.4 }]);
    d.market.securityHistory = vi.fn(async () => ({ points: [{ date: "2026-09-01", close: 10 }], splits: [] }));
    d.activities.listActivities = vi.fn(one("A", [act({ type: "TRANSFER", symbol: "ZZZ", securityCurrency: "USD", currency: "USD", units: 10, price: null, tradeDate: "2026-09-05" })]));
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.figures.netDeposits.value).toBeCloseTo(140, 8);
  });
  it("ALL starts at the scope's first row, not an excluded account's", async () => {
    const d = deps();
    d.dailyValues.earliest = vi.fn(async () => "2026-08-20");
    d.dailyValues.rows = vi.fn(async () => [...rowsFor("X", "CAD", 5, 3).map((r) => ({ ...r, date: "2026-08-20" })), ...rowsFor("A", "CAD", 1000), ...rowsFor("B", "CAD", 2000)]);
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.series.value[0].date).toBe("2026-09-01");
    expect(p.history.earliest).toBe("2026-09-01");
  });
  it("has no benchmark note when benchmark points are unavailable", async () => {
    const d = deps();
    d.market.history = vi.fn(async () => null);
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.benchmark.unavailableReason).toBeTruthy();
    expect(p.benchmark.note).toBeNull();
  });
  it("starts YTD on January 1 and uses the Toronto date", async () => {
    const d = deps({ now: () => new Date("2026-10-16T02:00:00Z") });
    await buildPerformancePayload(d, portfolio(), "sub", { period: "YTD" });
    expect(d.dailyValues.rows).toHaveBeenLastCalledWith("sub", "2026-01-01");
    // F1: the index is fetched from ten days earlier so it can be rebased on the last close on or before Jan 1.
    expect(d.market.history).toHaveBeenLastCalledWith("^SP500TR", "2025-12-22", "2026-10-15");
  });
  it("adds estimated and show text", async () => {
    const d = deps();
    d.dailyValues.rows = vi.fn(async () => rowsFor("A", "CAD", 1000).map((r) => ({ ...r, source: "estimated" as const })));
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(performanceText(p)).toContain("Includes estimated values.");
    expect(performanceText(p, { show: true })).toMatch(/Showing the performance widget\.$/);
    expect(performanceText(p)).not.toContain("Showing");
  });
  it("ignores a split dated before the flow and skips pre-period transfers", async () => {
    const d = deps();
    d.market.securityHistory = vi.fn(async () => ({ points: [{ date: "2026-09-01", close: 10 }], splits: [{ date: "2026-09-02", ratio: 3 }, { date: "2026-09-08", ratio: 2 }] }));
    d.activities.listActivities = vi.fn(one("A", [
      act({ type: "TRANSFER", symbol: "ZZZ", units: 10, price: null, tradeDate: "2026-09-05" }),
      act({ type: "TRANSFER", symbol: "OLD", units: 10, price: null, tradeDate: "2026-08-01" }),
    ]));
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.figures.netDeposits.value).toBe(200);
    expect(d.market.securityHistory).toHaveBeenCalledTimes(1);
    expect(d.market.securityHistory).toHaveBeenCalledWith("ZZZ", expect.any(String), "2026-10-15");
  });
  it("disambiguates duplicate labels with ordinals", async () => {
    const pf = portfolio({ accounts: [acct("A", "Self-directed TFSA", "CAD", true), acct("B", "Self-directed TFSA", "CAD", true), acct("C", "RRSP", "CAD", true)] });
    const p = await buildPerformancePayload(deps(), pf, "sub", { period: "ALL" });
    expect(p.accounts.map((a) => a.label)).toEqual(["Self-directed TFSA", "Self-directed TFSA 2", "RRSP"]);
    const second = await buildPerformancePayload(deps(), pf, "sub", { period: "ALL", accountId: "B" });
    expect(second.scope.label).toBe("Self-directed TFSA 2");
  });
});

describe("final fix wave", () => {
  it("F3: the account list is the same in every scope, so one account can switch to another", async () => {
    const expected = [{ id: "A", label: "TFSA", currency: "CAD" }, { id: "B", label: "RRSP", currency: "CAD" }, { id: "U", label: "Non-registered", currency: "USD" }];
    for (const accountId of [undefined, "A", "U"]) {
      const p = await buildPerformancePayload(deps(), portfolio(), "sub", { period: "ALL", ...(accountId ? { accountId } : {}) });
      expect(p.accounts).toEqual(expected);
    }
    const a = await buildPerformancePayload(deps(), portfolio(), "sub", { period: "ALL", accountId: "A" });
    expect(a.history.qualities.map((q) => q.accountId)).toEqual(["A"]);
  });
  describe("F4: accounts without a successful activity sync", () => {
    const unsyncedCases: Array<[string, any]> = [
      ["no sync state", null],
      ["backfill not completed", { backfillCompletedAt: null, lastSyncedAt: new Date(), lastError: null, dirty: true }],
      ["an error and no prior success", { backfillCompletedAt: null, lastSyncedAt: new Date(), lastError: "provider_error", dirty: false }],
    ];
    for (const [name, state] of unsyncedCases) {
      it(`account scope: ${name} -> flows unavailable, never zero deposits`, async () => {
        const d = deps();
        d.activities.syncState = vi.fn(async () => state);
        const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL", accountId: "A" });
        expect(p.figures.netDeposits).toMatchObject({ value: null, reason: "flows_unavailable" });
        expect(p.figures.personalReturn).toMatchObject({ value: null, reason: "flows_unavailable" });
        expect(p.figures.marketGain).toMatchObject({ value: null, reason: "flows_unavailable" });
        expect(p.figures.investmentReturn.value).not.toBeNull();
        // Computed without the unknown deposits, so never presented as exact (N1).
        expect(p.figures.investmentReturn.estimated).toBe(true);
        expect(p.monthly.every((m) => m.estimated)).toBe(true);
      });
    }
    it("account scope: a no_activity quality -> flows unavailable", async () => {
      const d = deps();
      d.activities.qualities = vi.fn(async () => [{ accountId: "A", method: "snapshots_only", reason: "no_activity", driftFraction: null, computedAt: new Date() }]);
      const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL", accountId: "A" });
      expect(p.figures.netDeposits).toMatchObject({ value: null, reason: "flows_unavailable" });
    });
    it("account scope: a later error after a completed backfill keeps the stored flows", async () => {
      const d = deps();
      d.activities.syncState = vi.fn(async () => ({ ...synced, lastError: "provider_error" }));
      d.activities.listActivities = vi.fn(async (_u: string, id: string) => (id === "A" ? [act({ type: "DEPOSIT", amount: 100, tradeDate: "2026-09-05" })] : []));
      const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL", accountId: "A" });
      expect(p.figures.netDeposits).toEqual({ value: 100, estimated: false });
    });
    it("portfolio scope: one unsynced account marks the flow-based figures estimated", async () => {
      const d = deps();
      d.activities.syncState = vi.fn(async (_u: string, id: string) => (id === "B" ? null : synced));
      d.activities.listActivities = vi.fn(async (_u: string, id: string) => (id === "A" ? [act({ type: "DEPOSIT", amount: 100, tradeDate: "2026-09-05" })] : []));
      const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
      expect(p.figures.netDeposits).toMatchObject({ value: 100, estimated: true });
      expect(p.figures.marketGain.estimated).toBe(true);
      expect(p.figures.personalReturn.estimated).toBe(true);
      expect(p.figures.investmentReturn.estimated).toBe(true);
      expect(performanceText(p)).toContain("Includes estimated values.");
      const clean = await buildPerformancePayload(deps(), portfolio(), "sub", { period: "ALL" });
      expect(clean.figures.netDeposits.estimated).toBe(false);
    });
    it("a sync-state read failure -> flows unavailable", async () => {
      const d = deps();
      d.activities.syncState = vi.fn(async () => { throw new Error("db"); });
      const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
      expect(p.figures.netDeposits.reason).toBe("flows_unavailable");
    });
  });
  describe("F5: payload size", () => {
    const span = (from: string, to: string) => { const out: string[] = []; for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
    const threeYears = span("2023-10-15", "2026-10-14");
    function bigDeps() {
      const d = deps();
      // Calendar-daily reconstructed rows with long decimals, weekly deposits into A, a daily index.
      d.dailyValues.rows = vi.fn(async () => threeYears.flatMap((date, i) => [
        { date, accountId: "A", currency: "CAD", value: 1000 + i * 3.3333333 + 40 * Math.sin(i / 9), source: "reconstructed" as const },
        { date, accountId: "B", currency: "CAD", value: 2000 + 70 * Math.cos(i / 13) + 0.123456789, source: "reconstructed" as const },
      ]));
      d.dailyValues.earliest = vi.fn(async () => "2023-10-15");
      d.activities.listActivities = vi.fn(async (_u: string, id: string) => id === "A" ? threeYears.filter((_, i) => i % 7 === 3).map((date) => act({ type: "CONTRIBUTION", amount: 3.3333333 * 7, tradeDate: date })) : []);
      d.market.history = vi.fn(async () => span("2023-10-05", "2026-10-14").map((date, i) => ({ date, close: 4000 + i * 1.7 + 30 * Math.sin(i / 5) })));
      return d;
    }
    it("a 3Y calendar-daily payload stays under 80 KB with at most 400 points per series", async () => {
      // A CAD index (no FX trimming) so the benchmark series is calendar-daily too.
      const p = await buildPerformancePayload(bigDeps(), portfolio(), "sub", { period: "3Y", benchmark: "tsx" });
      expect(p.series.benchmarkIndex.length).toBe(400);
      expect(JSON.stringify(p).length).toBeLessThan(80_000);
      for (const s of [p.series.value, p.series.netDeposits, p.series.twrIndex, p.series.benchmarkIndex]) expect(s.length).toBeLessThanOrEqual(400);
    });
    it("downsampling keeps first, last, month-ends and the drawdown dates; figures come from the full series", async () => {
      const p = await buildPerformancePayload(bigDeps(), portfolio(), "sub", { period: "3Y" });
      const dates = p.series.value.map((x) => x.date);
      expect(dates[0]).toBe("2023-10-15");
      expect(dates.at(-1)).toBe("2026-10-15");
      for (const m of ["2024-01-31", "2024-02-29", "2025-06-30", "2026-09-30"]) expect(dates).toContain(m);
      expect(dates).toContain(p.figures.maxDrawdown.peak);
      expect(dates).toContain(p.figures.maxDrawdown.trough);
      expect(p.series.twrIndex.map((x) => x.date)).toEqual(dates);
      expect(p.series.netDeposits.map((x) => x.date)).toEqual(dates);
      expect(p.series.twrIndex.at(-1)!.value).toBeCloseTo(1 + p.figures.investmentReturn.value!, 6);
      expect(p.series.netDeposits.at(-1)!.value).toBeCloseTo(p.figures.netDeposits.value!, 2);
      expect(p.monthly.length).toBe(37);
    });
    it("rounds values to cents and index values to 6 dp", async () => {
      const p = await buildPerformancePayload(bigDeps(), portfolio(), "sub", { period: "1M" });
      const decimals = (n: number) => (String(n).split(".")[1] ?? "").length;
      expect(Math.max(...p.series.value.map((x) => decimals(x.value)))).toBeLessThanOrEqual(2);
      expect(Math.max(...p.series.netDeposits.map((x) => decimals(x.value)))).toBeLessThanOrEqual(2);
      expect(Math.max(...p.series.twrIndex.map((x) => decimals(x.value)))).toBeLessThanOrEqual(6);
      expect(Math.max(...p.series.benchmarkIndex.map((x) => decimals(x.value)))).toBeLessThanOrEqual(6);
      // Short spans are not downsampled.
      expect(p.series.value.length).toBe(31);
    });
  });
});

describe("displaySeries keeps estimated stretches (N6)", () => {
  it("a short estimated stretch survives downsampling of a long series", () => {
    const value = Array.from({ length: 1200 }, (_, i) => {
      const d = new Date(Date.UTC(2023, 0, 1 + i)).toISOString().slice(0, 10);
      return { date: d, value: 1000 + i, source: (i >= 601 && i <= 602 ? "estimated" : "reconstructed") as "estimated" | "reconstructed" };
    });
    const index = value.map((p) => ({ date: p.date, value: 1 }));
    const result: any = { span: {}, figures: { maxDrawdown: { value: 0, estimated: false } }, monthly: [], series: { value, netDeposits: index.map((p) => ({ ...p, value: 0 })), twrIndex: index, benchmarkIndex: [], riskMergedDates: [] } };
    const out = displaySeries(result);
    expect(out.value.length).toBeLessThanOrEqual(400);
    expect(out.value.some((p) => p.source === "estimated")).toBe(true);
    expect(out.riskMergedDates).toEqual([]);
  });
});

describe("portfolio flows follow each account's valued window (brief 6)", () => {
  // Invented data. T is valued all period; C (cash) only from day 20; 900 moves T → C on day 5.
  const days30 = dates(30);
  const pf = (accounts: any[]): any => ({ ...portfolio(), accounts });
  const tRows = () => days30.map((date) => ({ date, accountId: "T", currency: "CAD", value: date >= "2026-09-05" ? 100 : 1000, source: "reported" as const }));
  const cRows = (v = 950, from = "2026-09-20") => days30.filter((d) => d >= from).map((date) => ({ date, accountId: "C", currency: "CAD", value: v, source: "reported" as const }));
  const transfer = (id: string) => id === "T"
    ? [act({ snapTradeAccountId: "T", type: "INTERNAL_CASH_TRANSFER_OUT", amount: -900, tradeDate: "2026-09-05" })]
    : id === "C" ? [act({ snapTradeAccountId: "C", type: "INTERNAL_CASH_TRANSFER_IN", amount: 900, tradeDate: "2026-09-05" })] : [];
  const setup = (rows: any[], listFor: (id: string) => any[] = transfer) => {
    const d = deps();
    d.dailyValues.rows = vi.fn(async () => rows);
    d.activities.listActivities = vi.fn(async (_u: string, id: string) => listFor(id));
    return d;
  };
  const near0 = (v: number | null) => { expect(v).not.toBeNull(); expect(Math.abs(v!)).toBeLessThan(0.005); };

  it("A: a transfer into an account not yet valued is a withdrawal, and the account's join is added to tracking", async () => {
    const d = setup([...tRows(), ...cRows()]);
    const p = await buildPerformancePayload(d, pf([acct("T", "TFSA", "CAD", true, 100), acct("C", "Cash", "CAD", true, 950)]), "sub", { period: "ALL" });
    expect(p.figures.maxDrawdown.value!).toBeGreaterThan(-0.01);
    near0(p.figures.investmentReturn.value);
    // Brief 9: the join value is not a deposit, and neither is the move into the joining account.
    near0(p.figures.netDeposits.value);
    expect(p.figures.accountsAddedToTracking).toMatchObject({ value: 50, joined: 950, movedFromTracked: -900, left: 0, estimated: false });
    near0(p.figures.marketGain.value);
    near0(p.figures.personalReturn.value);
  });
  it("A (owner case): a snapshots-only account valued only today joins today", async () => {
    const d = setup(tRows());
    const p = await buildPerformancePayload(d, pf([acct("T", "TFSA", "CAD", true, 100), acct("C", "Cash", "CAD", true, 950)]), "sub", { period: "ALL" });
    expect(p.figures.maxDrawdown.value!).toBeGreaterThan(-0.01);
    near0(p.figures.investmentReturn.value);
    near0(p.figures.netDeposits.value);
    expect(p.figures.accountsAddedToTracking.value).toBeCloseTo(50, 6);
  });
  it("B: both accounts valued all period still net the transfer out", async () => {
    const c = days30.map((date) => ({ date, accountId: "C", currency: "CAD", value: date >= "2026-09-05" ? 950 : 50, source: "reported" as const }));
    const d = setup([...tRows(), ...c]);
    const p = await buildPerformancePayload(d, pf([acct("T", "TFSA", "CAD", true, 100), acct("C", "Cash", "CAD", true, 950)]), "sub", { period: "ALL" });
    expect(p.figures.netDeposits.value).toBe(0);
    near0(p.figures.investmentReturn.value);
  });
  it("C: an account that stops being valued leaves with an outflow on the next valued date", async () => {
    const t = days30.map((date) => ({ date, accountId: "T", currency: "CAD", value: 1000, source: "reported" as const }));
    const l = days30.slice(0, 10).map((date) => ({ date, accountId: "L", currency: "CAD", value: 500, source: "reported" as const }));
    const d = setup([...t, ...l], () => []);
    const p = await buildPerformancePayload(d, pf([acct("T", "TFSA", "CAD", true, 1000), acct("L", "RRSP", "CAD", true, null)]), "sub", { period: "ALL" });
    expect(p.figures.maxDrawdown.value!).toBeGreaterThan(-0.01);
    near0(p.figures.investmentReturn.value);
    expect(p.figures.netDeposits.value).toBeCloseTo(0, 6);
    expect(p.figures.accountsAddedToTracking).toMatchObject({ value: -500, joined: 0, left: -500 });
    expect(performanceText(p)).toContain("accounts no longer tracked -500.00 CAD (not withdrawals)");
    expect(p.series.netDeposits.find((x) => x.value !== 0)?.date).toBe("2026-09-11");
  });
  it("D: a deposit just before an account's first value is in its join value", async () => {
    const d = setup([...tRows(), ...cRows(1000)], (id) => id === "C"
      ? [...transfer("C"), act({ snapTradeAccountId: "C", type: "CONTRIBUTION", amount: 50, tradeDate: "2026-09-17" })]
      : transfer(id));
    const p = await buildPerformancePayload(d, pf([acct("T", "TFSA", "CAD", true, 100), acct("C", "Cash", "CAD", true, 1000)]), "sub", { period: "ALL" });
    expect(p.notInFigures).toEqual([]);
    near0(p.figures.investmentReturn.value);
    near0(p.figures.netDeposits.value);
    expect(p.figures.accountsAddedToTracking).toMatchObject({ value: 100, joined: 1000, movedFromTracked: -900 });
    expect(p.figures.maxDrawdown.value!).toBeGreaterThan(-0.01);
  });
  it("D2: a deposit long before an account's first value is a gap: the account leaves the figures", async () => {
    const d = setup([...tRows(), ...cRows(1000)], (id) => id === "C"
      ? [...transfer("C"), act({ snapTradeAccountId: "C", type: "CONTRIBUTION", amount: 50, tradeDate: "2026-09-10" })]
      : transfer(id));
    const p = await buildPerformancePayload(d, pf([acct("T", "TFSA", "CAD", true, 100), acct("C", "Cash", "CAD", true, 1000)]), "sub", { period: "ALL" });
    expect(p.notInFigures.map((a) => [a.accountId, a.reason])).toEqual([["C", "history_gaps"]]);
    near0(p.figures.investmentReturn.value);
    expect(p.figures.netDeposits.value).toBeCloseTo(-900, 6);
  });
  it("the model text names accounts added to tracking apart from net deposits and marks estimated figures", async () => {
    const d = setup([...tRows(), ...cRows()]);
    const p = await buildPerformancePayload(d, pf([acct("T", "TFSA", "CAD", true, 100), acct("C", "Cash", "CAD", true, 950)]), "sub", { period: "ALL" });
    const text = performanceText(p);
    expect(text).toContain("net deposits +0.00 CAD");
    expect(text).toContain("accounts added to tracking +950.00 CAD (900.00 CAD of it moved from your other accounts; not deposits)");
    const est = performanceText({ ...p, figures: { ...p.figures, marketGain: { ...p.figures.marketGain, estimated: true } } });
    expect(est).toMatch(/market gain [+-][\d.,]+ CAD \(est\.\)/);
  });
  it("I3: a join valued from a reconstructed row marks accounts added to tracking est.", async () => {
    const d = setup([...tRows(), ...cRows().map((r) => ({ ...r, source: "reconstructed" as const }))]);
    const p = await buildPerformancePayload(d, pf([acct("T", "TFSA", "CAD", true, 100), acct("C", "Cash", "CAD", true, null)]), "sub", { period: "ALL" });
    expect(p.figures.accountsAddedToTracking.estimated).toBe(true);
  });
  it("account scope is unchanged: the transfer is the account's withdrawal", async () => {
    const d = setup([...tRows(), ...cRows()]);
    const p = await buildPerformancePayload(d, pf([acct("T", "TFSA", "CAD", true, 100), acct("C", "Cash", "CAD", true, 950)]), "sub", { period: "ALL", accountId: "T" });
    expect(p.figures.netDeposits.value).toBe(-900);
    near0(p.figures.investmentReturn.value);
  });
});

describe("CAD view: one combined CAD series and returns (task 11)", () => {
  const cadOn = (over: Record<string, any> = {}) => {
    const d = deps(over);
    d.settings.get = vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView: true }));
    return d;
  };
  const days = (from: string, to: string) => { const out: string[] = []; for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
  const daily = (from: string, to: string, rate: (d: string) => number = () => 1.4) => days(from, to).map((date) => ({ date, close: rate(date) }));

  it("combines CAD and USD accounts into one CAD series; the time-weighted return is on CAD values and est.", async () => {
    const d = cadOn();
    d.market.usdCad = vi.fn(async () => daily("2026-08-20", "2026-10-15"));
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.scope).toMatchObject({ kind: "portfolio", currency: "CAD" });
    expect(p.otherCurrencies).toEqual([]);
    // 1000 + 2000 CAD + 500 USD × 1.4
    expect(p.series.value[0].value).toBe(3700);
    expect(p.series.value.at(-1)).toMatchObject({ date: "2026-10-15", value: 3700 });
    expect(p.home).toMatchObject({ currency: "CAD", converted: true, estimated: true, notConvertedDays: 0, notConvertedAccounts: 0, flowNotConverted: null });
    expect(p.figures.investmentReturn).toMatchObject({ estimated: true });
    expect(Math.abs(p.figures.investmentReturn.value!)).toBeLessThan(1e-9);
    expect(performanceText(p)).toContain("(All accounts, CAD)");
    expect(performanceText(p)).toContain("Figures are in CAD; USD amounts are converted at the Bank of Canada rate and marked est.");
    expect(performanceModelCopy(p)).toMatchObject({ note: "Figures are in CAD; USD amounts are converted at the Bank of Canada rate and marked est.", home: { estimated: true, notConvertedDays: 0 } });
  });

  it("a USD deposit converts at its own date's rate", async () => {
    const d = cadOn();
    d.market.usdCad = vi.fn(async () => daily("2026-08-20", "2026-10-15", (x) => (x === "2026-09-05" ? 1.5 : 1.4)));
    d.dailyValues.rows = vi.fn(async () => [...rowsFor("A", "CAD", 1000), ...rowsFor("B", "CAD", 2000), ...dates(12).map((date) => ({ date, accountId: "U", currency: "USD", value: date >= "2026-09-05" ? 500 : 400, source: "reported" as const }))]);
    d.activities.listActivities = vi.fn(async (_u: string, id: string) => id === "U" ? [act({ snapTradeAccountId: "U", type: "DEPOSIT", amount: 100, currency: "USD", tradeDate: "2026-09-05" })] : []);
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.figures.netDeposits.value).toBeCloseTo(150, 6);
    expect(p.figures.netDeposits.estimated).toBe(true);
  });

  it("one USD account shows CAD with the native figures kept", async () => {
    const d = cadOn();
    d.market.usdCad = vi.fn(async () => daily("2026-08-20", "2026-10-15"));
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL", accountId: "U" });
    expect(p.scope).toMatchObject({ kind: "account", accountId: "U", currency: "CAD" });
    expect(p.series.value[0].value).toBe(700);
    expect(p.home?.native).toMatchObject({ currency: "USD", value: 500 });
    expect(p.home?.native?.marketGain.value).toBeCloseTo(0, 6);
  });

  it("days without a rate within 7 days drop the USD account, are counted and are not drawn as a drop", async () => {
    const d = cadOn();
    // Rates up to Sep 1, then again from Sep 12: Sep 9–11 have none within 7 days.
    d.market.usdCad = vi.fn(async () => [...daily("2026-08-20", "2026-09-01"), ...daily("2026-09-12", "2026-10-15")]);
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.home?.notConvertedDays).toBe(3);
    expect(p.series.value.map((x) => x.date)).not.toContain("2026-09-10");
    expect(p.series.value.every((x) => x.value === 3700)).toBe(true);
    expect(Math.abs(p.figures.investmentReturn.value!)).toBeLessThan(1e-9);
    expect(performanceText(p)).toContain("3 days not converted (no recent Bank of Canada rate); those days are left out.");
  });

  it("with no rate at all (fetch fails or times out), USD accounts are named not converted, never silently dropped", async () => {
    for (const fail of ["null", "timeout"] as const) {
      const d = cadOn({ marketDeadlineMs: 30 });
      d.market.usdCad = fail === "null" ? vi.fn(async () => null) : vi.fn(() => new Promise(() => {}));
      const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
      expect(p.home).toMatchObject({ converted: false, estimated: false, notConvertedDays: 0, notConvertedAccounts: 1 });
      // The not-converted rule: USD stays in its own currency, listed apart; CAD figures are the CAD accounts'.
      expect(p.otherCurrencies).toEqual(["USD"]);
      expect(p.series.value[0].value).toBe(3000);
      const text = performanceText(p);
      expect(text).not.toContain("USD amounts are converted");
      expect(text).toContain("Not converted (no recent Bank of Canada rate): 1 USD account is shown separately in its own currency.");
      expect(text).not.toContain("days are left out");
      expect(performanceModelCopy(p)).not.toHaveProperty("note");
    }
  });

  it("the not-converted fallback never reports a USD account as having gaps (its rows are in USD)", async () => {
    const d = cadOn();
    let calls = 0;
    // The series' rate fetch fails; a later one (the flows' conversion) succeeds.
    d.market.usdCad = vi.fn(async () => (calls++ === 0 ? null : daily("2026-08-01", "2026-10-15")));
    d.activities.listActivities = vi.fn(async (_u: string, id: string) => id === "U"
      ? [act({ snapTradeAccountId: "U", currency: "USD", type: "DEPOSIT", amount: 50, tradeDate: "2026-08-10" }), act({ snapTradeAccountId: "U", currency: "USD", type: "DEPOSIT", amount: 100, tradeDate: "2026-09-05" })]
      : []);
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.home).toMatchObject({ converted: false, notConvertedAccounts: 1 });
    expect(p.notInFigures).toEqual([]);
  });

  it("cadView off keeps today's per-currency scope: USD accounts shown separately, no CAD block", async () => {
    const d = deps();
    d.market.usdCad = vi.fn(async () => daily("2026-08-20", "2026-10-15"));
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.otherCurrencies).toEqual(["USD"]);
    expect(p.series.value[0].value).toBe(3000);
    expect(p.home).toBeNull();
    expect(performanceText(p)).not.toContain("Figures are in CAD");
    const u = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL", accountId: "U" });
    expect(u.scope.currency).toBe("USD");
  });
});

describe("CAD view: a USD flow on a day without a rate (task 11, fix round 1)", () => {
  const cadOn = () => { const d = deps(); d.settings.get = vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView: true })); return d; };
  const days = (from: string, to: string) => { const out: string[] = []; for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
  const daily = (from: string, to: string) => days(from, to).map((date) => ({ date, close: 1.4 }));
  const deposit = (date: string) => vi.fn(async (_u: string, id: string) => id === "U" ? [act({ snapTradeAccountId: "U", type: "DEPOSIT", amount: 100, currency: "USD", tradeDate: date })] : []);

  it("withholds the CAD return when a USD deposit has no rate within 7 days; the values chart is still drawn", async () => {
    const d = cadOn();
    d.market.usdCad = vi.fn(async () => [...daily("2026-08-20", "2026-09-01"), ...daily("2026-09-12", "2026-10-15")]);
    d.activities.listActivities = deposit("2026-09-10");
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.home?.flowNotConverted).toBe("2026-09-10");
    for (const f of [p.figures.investmentReturn, p.figures.personalReturn, p.figures.marketGain, p.figures.netDeposits]) expect(f).toMatchObject({ value: null, reason: "flow_not_converted" });
    expect(p.series.value.length).toBeGreaterThan(2);
    expect(p.series.twrIndex).toEqual([]);
    expect(performanceText(p)).toContain("Return unavailable: a USD deposit or withdrawal on Sep 10 could not be converted.");
  });

  it("the same deposit on a day with a rate is converted and is not counted as gain", async () => {
    const d = cadOn();
    d.market.usdCad = vi.fn(async () => daily("2026-08-20", "2026-10-15"));
    d.activities.listActivities = deposit("2026-09-05");
    d.dailyValues.rows = vi.fn(async () => [...rowsFor("A", "CAD", 1000), ...rowsFor("B", "CAD", 2000), ...dates(12).map((date) => ({ date, accountId: "U", currency: "USD", value: date >= "2026-09-05" ? 500 : 400, source: "reported" as const }))]);
    const p = await buildPerformancePayload(d, portfolio(), "sub", { period: "ALL" });
    expect(p.home?.flowNotConverted).toBeNull();
    expect(p.figures.netDeposits.value).toBeCloseTo(140, 6);
    expect(p.figures.marketGain.value).toBeCloseTo(0, 6);
    expect(Math.abs(p.figures.investmentReturn.value!)).toBeLessThan(1e-9);
  });
});

describe("accountType resolves to one eligible account (agent query surface, D2)", () => {
  const typed = (id: string, name: string, label: string, bucket: string, group: string, amount = 1000): any => ({
    ...acct(id, label, "CAD", true, amount), name, classification: { label, includedInPortfolioTotal: true, bucket, group },
  });
  const selfRrsp = typed("R1", "Synthetic RRSP", "Self-directed RRSP", "rrsp", "registered", 2000);
  const managedRrsp = typed("R2", "Synthetic managed RRSP", "Managed RRSP", "rrsp", "registered", 900);
  const tfsa = (id: string, name: string) => typed(id, name, "Self-directed TFSA", "tfsa", "registered");
  const cash = typed("C", "Synthetic cash", "Cash / money market", "money_market", "non_registered", 4000);
  const pfOf = (...accounts: any[]) => portfolio({ accounts });
  const withRows = () => {
    const d = deps();
    d.dailyValues.rows = vi.fn(async () => [...rowsFor("R1", "CAD", 2000), ...rowsFor("R2", "CAD", 900), ...rowsFor("T1", "CAD", 1000), ...rowsFor("T2", "CAD", 1000), ...rowsFor("C", "CAD", 4000)]);
    d.activities.listActivities = vi.fn(async (_u: string, id: string) => id === "R1" ? [act({ snapTradeAccountId: "R1", type: "DEPOSIT", amount: 250, tradeDate: "2026-09-04" })] : []);
    return d;
  };

  it("answers for the self-directed RRSP beside a managed one, exactly as its accountId, and names the managed one", async () => {
    const pf = pfOf(tfsa("T1", "Synthetic TFSA"), selfRrsp, managedRrsp);
    const byType = await buildPerformancePayload(withRows(), pf, "sub", { period: "ALL", accountType: "rrsp" });
    const byId = await buildPerformancePayload(withRows(), pf, "sub", { period: "ALL", accountId: "R1" });
    expect(byType.scope).toEqual({ kind: "account", accountId: "R1", label: "Self-directed RRSP", currency: "CAD" });
    expect(byType.figures).toEqual(byId.figures);
    expect(byType.series).toEqual(byId.series);
    const { excluded, ...rest } = byType;
    expect(excluded).toEqual([{ accountId: "R2", name: "Synthetic managed RRSP", reason: "managed" }]);
    expect(rest).toEqual(byId);
    expect(byId.excluded).toBeUndefined();
    const text = performanceText(byType, { show: true });
    expect(text).toContain("Synthetic managed RRSP isn't included: SnapTrade doesn't provide its history.");
    // Named once (R7): the scoped sentence carries its name, so the generic "Left out" line skips it.
    expect(text).not.toContain("Left out: Managed RRSP");
    expect(text).not.toContain("Only accounts whose numbers SnapTrade provides in full are counted.");
    expect(text).not.toContain("R2");
    // The accountId answer keeps the generic line, unchanged.
    expect(performanceText(byId)).toContain(" Left out: Managed RRSP (managed; SnapTrade doesn't provide its holdings history).");
    expect(text.endsWith("Showing the performance widget.")).toBe(true);
    expect(performanceText(byId)).not.toContain("isn't included");
  });

  it("a managed portfolio of another type stays on the generic line while the scoped one is named once (R7)", async () => {
    const managedTfsa = typed("T9", "Synthetic managed TFSA", "Managed TFSA", "tfsa", "registered", 700);
    const pf = pfOf(tfsa("T1", "Synthetic TFSA"), selfRrsp, managedRrsp, managedTfsa);
    const text = performanceText(await buildPerformancePayload(withRows(), pf, "sub", { period: "ALL", accountType: "rrsp" }));
    expect(text).toContain(" Only accounts whose numbers SnapTrade provides in full are counted. Left out: Managed TFSA (managed; SnapTrade doesn't provide its holdings history).");
    expect(text.match(/Managed RRSP|Synthetic managed RRSP/g)).toEqual(["Synthetic managed RRSP"]);
  });

  it("a type whose only accounts have no known currency yet: the unknown-or-excluded copy, not 'No connected' (M1)", async () => {
    const pending = { ...typed("F1", "Synthetic FHSA", "Self-directed FHSA", "fhsa", "registered"), value: null };
    const err = await buildPerformancePayload(withRows(), pfOf(selfRrsp, pending), "sub", { accountType: "fhsa" }).catch((e) => e);
    expect(err).toBeInstanceOf(PerformanceScopeError);
    expect(err).toMatchObject({ code: "no_accounts_of_type", text: "Unknown or excluded account. Use list_portfolio_accounts to pick an account." });
    expect(err.text).not.toContain("No connected");
  });

  it("two self-directed TFSAs: several_accounts listing them", async () => {
    const pf = pfOf(tfsa("T1", "Synthetic TFSA one"), tfsa("T2", "Synthetic TFSA two"), selfRrsp);
    const err = await buildPerformancePayload(withRows(), pf, "sub", { accountType: "tfsa" }).catch((e) => e);
    expect(err).toBeInstanceOf(PerformanceScopeError);
    expect(err).toMatchObject({
      code: "several_accounts",
      text: "You have 2 TFSA accounts: Synthetic TFSA one (T1), Synthetic TFSA two (T2). Ask about one with accountId, or about all accounts.",
    });
  });

  it("no FHSA: no_accounts_of_type", async () => {
    const err = await buildPerformancePayload(withRows(), pfOf(selfRrsp), "sub", { accountType: "fhsa" }).catch((e) => e);
    expect(err).toBeInstanceOf(PerformanceScopeError);
    expect(err).toMatchObject({ code: "no_accounts_of_type", text: "No connected FHSA accounts. Use list_portfolio_accounts to see what is connected." });
  });

  it("only a managed RRSP, or a Cash account: performance's existing managed / Cash errors, not 'no connected'", async () => {
    const managedOnly = await buildPerformancePayload(withRows(), pfOf(tfsa("T1", "Synthetic TFSA"), managedRrsp), "sub", { accountType: "rrsp" }).catch((e) => e);
    expect(managedOnly).toBeInstanceOf(PerformanceScopeError);
    expect(managedOnly.code).toBe("managed_account");
    const cashOnly = await buildPerformancePayload(withRows(), pfOf(tfsa("T1", "Synthetic TFSA"), cash), "sub", { accountType: "cash_account" }).catch((e) => e);
    expect(cashOnly).toBeInstanceOf(PerformanceScopeError);
    expect(cashOnly.code).toBe("cash_account");
  });

  it("both filters: both_filters", async () => {
    const err = await buildPerformancePayload(withRows(), pfOf(selfRrsp), "sub", { accountId: "R1", accountType: "rrsp" }).catch((e) => e);
    expect(err).toMatchObject({ code: "both_filters", text: "Give accountId or accountType, not both." });
  });

  it("an explicit accountId keeps its managed / Cash / unknown errors", async () => {
    const pf = pfOf(selfRrsp, managedRrsp, cash);
    for (const [accountId, code] of [["R2", "managed_account"], ["C", "cash_account"], ["nope", "unknown_account"]]) {
      await expect(buildPerformancePayload(withRows(), pf, "sub", { accountId })).rejects.toMatchObject({ code });
    }
  });

  it("names a Cash exclusion with its own copy", async () => {
    const p = await buildPerformancePayload(withRows(), pfOf(selfRrsp), "sub", { period: "ALL", accountId: "R1" });
    expect(performanceText({ ...p, excluded: [{ accountId: "C", name: "Synthetic cash", reason: "cash" }] })).toContain("Synthetic cash is a Cash account and isn't in returns.");
  });

  it("parses accountType and declares it", () => {
    expect(performanceInput.parse({ accountType: "rrsp" })).toEqual({ accountType: "rrsp" });
    expect(() => performanceInput.parse({ accountType: "rrif" })).toThrow();
    const [show, get] = performanceToolDefinitions;
    expect(show.inputSchema.properties.accountType.enum).toEqual(["tfsa", "fhsa", "rrsp", "non_registered", "crypto", "cash_account"]);
    expect(get.inputSchema.properties).toHaveProperty("accountType");
    expect(show.description).toContain("Filter with accountType (for example rrsp) or accountId. Read-only.");
  });
});
