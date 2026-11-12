import { z } from "zod";
import { intradayLine, type IntradayHolding, type IntradayResult } from "../analytics/intraday.js";
import { providerTicker } from "../market-data/ticker-map.js";
import { buildOverviewSummary, quoteTickers, summaryNeedsFx, type OverviewSummary } from "../analytics/overview-summary.js";
import { BENCHMARKS } from "../analytics/benchmarks.js";
import { benchmarkFetchFrom, benchmarkSeries, clipBenchmark, mergeDailyPoints, PERIODS, periodStart, type OverviewSeries, type Period, type ReturnFigure } from "../analytics/value-series.js";
import type { ActivityStore } from "../history/activity-store.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import { cashAccountIds, portfolioReturns, type FlowDeps } from "./performance-tools.js";
import { notInTotalText, type PortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import { BENCHMARK_KEYS, DEFAULT_SETTINGS, type BenchmarkKey, type PortfolioSettingsView, type SettingsService } from "../settings/settings-service.js";
import type { DailySnapshotService } from "../snapshots/daily-snapshot-service.js";
import { HOME_CURRENCY, homeConverter, sumHome, type HomeTotal } from "../fx/home-currency.js";
import { isInvestable } from "../analytics/holdings.js";
import { homeDailySeries } from "../fx/home-series.js";
import { formatMoney, homeConverterFor, homeQualifier, shortDate } from "./home-fx.js";
import { countsTowardReturns, isManagedPortfolio } from "../portfolio/account-taxonomy.js";

/** Currencies the CAD view combines (only USD converts; CAD is exact). */
const HOME_SCOPE = [HOME_CURRENCY, "USD"];

export const OVERVIEW_WIDGET_URI = "ui://portfolio/overview-v5";
export interface OverviewDeps {
  /** securityHistory is optional: with `activities` it enables the time-weighted return. */
  market: Pick<MarketDataService, "history" | "usdCad" | "quotes"> & Partial<Pick<MarketDataService, "securityHistory" | "intraday">>;
  settings: Pick<SettingsService, "get" | "save">;
  dailyValues: Pick<DailySnapshotService, "rows" | "earliest">;
  /** Optional: history quality notes. Absence or failure never fails the overview. */
  history?: Pick<ActivityStore, "qualities">;
  /** Optional: stored activities for the time-weighted return. Absence or failure falls back to the value change. */
  activities?: Pick<ActivityStore, "userId" | "listActivities" | "syncState" | "qualities">;
  now?: () => Date;
  /** Budget for each market-data stage (quotes; benchmark series incl. FX). Default 5000 ms. */
  marketDeadlineMs?: number;
}
export interface OverviewPayload {
  portfolio: PortfolioPresentation; summary: OverviewSummary; series: OverviewSeries;
  settings: PortfolioSettingsView; benchmarks: Array<{ key: BenchmarkKey; name: string; explainer: string }>;
  history: OverviewHistory;
}
export interface OverviewHistory {
  qualities: Array<{ accountId: string; method: string; reason: string | null; driftFraction: number | null }>;
  earliest: string | null;
  /** A newly linked account's first activity read hasn't finished (the 10-minute catch-up, history/pending-history.ts). */
  building: boolean;
  /** Accounts left out of this period's return and value line: gaps in their history (spec 2026-10-29-incomplete-history). */
  incompleteAccounts?: string[];
}

/** Said while `building`; the widgets' HISTORY_BUILDING (packages/widgets/src/kit/history-notes.ts) says the same. */
export const HISTORY_BUILDING_TEXT = "VestLens is still reading this person's history from Wealthsimple (usually about 10 minutes after linking); the chart, returns and comparisons fill in then.";
/** On the Daily SnapTrade plan, holdings and balances refresh once a day; today's change uses market prices. */
export const DATA_FRESHNESS_TEXT = "Holdings and balances update once a day through SnapTrade; today's change uses market prices, and new trades and deposits appear the next day.";

/** True when an account counted in the totals has no completed first history read. Never fails the overview. */
async function historyBuilding(deps: OverviewDeps, portfolio: PortfolioPresentation, authSubject: string): Promise<boolean> {
  if (!deps.activities) return false;
  try {
    const appUserId = await deps.activities.userId(authSubject);
    if (!appUserId) return false;
    for (const account of portfolio.accounts) {
      if (!countsTowardReturns(account.classification)) continue;
      if (!(await deps.activities.syncState(appUserId, account.id))?.backfillCompletedAt) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export const showPortfolioInput = z.object({ refresh: z.boolean().optional(), period: z.enum(PERIODS).optional(), benchmark: z.enum(BENCHMARK_KEYS).optional() }).strict();
export const seriesInput = z.object({ period: z.enum(PERIODS), benchmark: z.enum(BENCHMARK_KEYS).optional() }).strict();

const torontoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });
const today = (deps: OverviewDeps) => torontoDate.format((deps.now ?? (() => new Date()))());
const DEFAULT_MARKET_DEADLINE_MS = 5_000;

/** Resolves with `fallback` when `work` rejects or does not settle within `ms`. */
export function withDeadline<T>(work: () => Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback()), ms);
    let started: Promise<T>;
    try { started = work(); } catch { started = Promise.reject(new Error("failed")); }
    started.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback()); },
    );
  });
}

async function loadQualities(deps: OverviewDeps, authSubject: string): Promise<OverviewHistory["qualities"]> {
  if (!deps.history) return [];
  try {
    return (await deps.history.qualities(authSubject)).map((q) => ({ accountId: q.accountId, method: q.method, reason: q.reason, driftFraction: q.driftFraction }));
  } catch {
    return [];
  }
}

/** Display settings never block the overview: a store failure falls back to defaults. */
export async function loadSettings(deps: Pick<OverviewDeps, "settings">, authSubject: string): Promise<PortfolioSettingsView> {
  try {
    return await deps.settings.get(authSubject);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const unavailableBenchmark = (key: BenchmarkKey): OverviewSeries["benchmark"] => ({ key, name: BENCHMARKS[key].name, explainer: BENCHMARKS[key].explainer, basis: BENCHMARKS[key].basis, points: null, unavailableReason: "Benchmark data unavailable" });

function comparisonNote(currency: string, benchmark: BenchmarkKey): string | null {
  const indexCurrency = BENCHMARKS[benchmark].currency;
  if (currency === "CAD") return indexCurrency === "USD" ? "USD index converted to CAD with the Bank of Canada daily rate." : null;
  return indexCurrency === "USD"
    ? `USD index converted to CAD with the Bank of Canada daily rate; your portfolio series is in ${currency}, so this compares a ${currency} portfolio with a CAD-converted index.`
    : `The index is in CAD; your portfolio series is in ${currency}.`;
}

type TwrResult = { investmentReturn: ReturnFigure; benchmarkReturn: ReturnFigure; span: OverviewSeries["returnSpan"]; flowNotConverted?: string; incomplete?: string[] };
const toReturn = (f: { value: number | null; estimated: boolean; reason?: string }): ReturnFigure => (f.reason ? { value: f.value, estimated: f.estimated, reason: f.reason } : { value: f.value, estimated: f.estimated });

/** incomplete: accounts the return found gaps in; the caller rebuilds without them (seriesWithoutGaps). */
interface SeriesBuild { series: OverviewSeries; earliest: string | null; incomplete?: string[] }

/** Included accounts' currency: the reported one, else the first balance's (the CAD view needs USD among them). */
const includedCurrency = (a: PortfolioPresentation["accounts"][number]) => a.value?.currency ?? a.balances[0]?.currency ?? null;
/** The CAD view combines charts across currencies only when a USD account is included; otherwise they are as before. */
export const homeCharts = (portfolio: PortfolioPresentation, cadView: boolean) =>
  cadView && portfolio.accounts.some((a) => countsTowardReturns(a.classification) && includedCurrency(a) === "USD");

/**
 * The series without accounts whose history has a gap in the period (spec 2026-10-29-incomplete-history): built once,
 * and again without them when the return finds any, so the value line, the return and the comparison cover the same,
 * complete accounts. `incomplete` names the ones left out.
 */
async function seriesWithoutGaps(deps: OverviewDeps, portfolio: PortfolioPresentation, summary: Pick<OverviewSummary, "primaryCurrency" | "totals">, authSubject: string, period: Period, benchmark: BenchmarkKey, cadView = false): Promise<SeriesBuild> {
  const excluded = new Set<string>();
  // Removing an account can move the span's start, so this repeats until no more are found.
  for (;;) {
    const built = await buildSeriesWithEarliest(deps, portfolio, summary, authSubject, period, benchmark, cadView, excluded);
    const found = (built.incomplete ?? []).filter((id) => !excluded.has(id));
    if (found.length === 0) return excluded.size ? { ...built, incomplete: [...excluded] } : built;
    for (const id of found) excluded.add(id);
  }
}

async function buildSeriesWithEarliest(deps: OverviewDeps, portfolio: PortfolioPresentation, summary: Pick<OverviewSummary, "primaryCurrency" | "totals">, authSubject: string, period: Period, benchmark: BenchmarkKey, cadView = false, excluded: ReadonlySet<string> = new Set()): Promise<SeriesBuild> {
  if (homeCharts(portfolio, cadView)) return buildHomeSeries(deps, portfolio, authSubject, period, benchmark, excluded);
  const to = today(deps);
  const currency = summary.primaryCurrency ?? "CAD";
  const deadline = deps.marketDeadlineMs ?? DEFAULT_MARKET_DEADLINE_MS;
  const earliest = await deps.dailyValues.earliest(authSubject, currency).catch(() => null);
  const from = periodStart(period, to, earliest);
  // Started now so the benchmark (and the time-weighted return that shares it) overlaps the rows read.
  const benchPromise = withDeadline(() => benchmarkSeries(deps.market, benchmark, benchmarkFetchFrom(from), to), deadline, () => unavailableBenchmark(benchmark));
  // The time-weighted comparison uses the portfolio's currency, as Performance does. For CAD that is the same fetch.
  const twrBenchPromise = currency === "CAD" ? benchPromise
    : withDeadline(() => benchmarkSeries(deps.market, benchmark, benchmarkFetchFrom(from), to, currency), deadline, () => unavailableBenchmark(benchmark));
  const rowsPromise = deps.dailyValues.rows(authSubject, from).catch(() => [] as Awaited<ReturnType<OverviewDeps["dailyValues"]["rows"]>>);
  // One scope for the value line and the return (Performance's rule): investment accounts (countsTowardReturns) in the
  // primary currency, the currency coming from the reported value or, without one, the account's latest stored row.
  // Today's point is those accounts' reported values, only when every one reports: never the brokerage total, which
  // includes Cash and would draw a jump the size of the Cash balance.
  const scopePromise = rowsPromise.then((rows) => {
    const rowCurrency = new Map<string, { date: string; currency: string }>();
    for (const r of rows) { const seen = rowCurrency.get(r.accountId); if (!seen || r.date >= seen.date) rowCurrency.set(r.accountId, { date: r.date, currency: r.currency }); }
    const accounts = portfolio.accounts.filter((a) => countsTowardReturns(a.classification) && !excluded.has(a.id) && (a.value?.currency ?? rowCurrency.get(a.id)?.currency) === currency);
    const ids = accounts.map((a) => a.id);
    const idSet = new Set(ids);
    const reported = accounts.filter((a) => a.value && a.value.currency === currency);
    const todayValue = ids.length > 0 && reported.length === ids.length ? reported.reduce((sum, a) => sum + a.value!.amount, 0) : null;
    const todayValues = todayValue === null ? null : new Map(reported.map((a) => [a.id, a.value!.amount] as [string, number]));
    // Only scope accounts' rows: stored rows of closed, excluded or Cash accounts would leave the series with no matching flow.
    const scoped = rows.filter((r) => idSet.has(r.accountId) && r.currency === currency);
    return { ids, scoped, todayValue, todayValues };
  });
  const pointsPromise = scopePromise.then(({ scoped, todayValue }) => mergeDailyPoints(scoped, currency, from, to, todayValue));
  const flowDeps: FlowDeps | null = deps.activities && deps.market.securityHistory
    ? { activities: deps.activities, market: { usdCad: deps.market.usdCad, securityHistory: deps.market.securityHistory } }
    : null;
  const failed = (reason: string): TwrResult => ({ investmentReturn: { value: null, estimated: false, reason }, benchmarkReturn: { value: null, estimated: false, reason }, span: null });
  // The deadline starts with the benchmark, not after the rows, so the worst case stays about one budget.
  const returnsPromise: Promise<TwrResult> = flowDeps
    ? withDeadline<TwrResult>(async () => {
        try {
          const { ids, scoped, todayValue, todayValues } = await scopePromise;
          const values = mergeDailyPoints(scoped, currency, from, to, todayValue);
          return await portfolioReturns(flowDeps, authSubject, { ids, currency, from, today: to, values, deadline, benchmark: twrBenchPromise, valued: { rows: scoped, todayValues }, matchOnlyIds: cashAccountIds(portfolio) });
        } catch {
          return failed("error");
        }
      }, deadline, () => failed("timeout"))
    : Promise.resolve(failed("flows_unavailable"));
  const [rawBench, points, twr] = await Promise.all([benchPromise, pointsPromise, returnsPromise]);
  const spanStart = points.length > 1 ? points[0].date : null;
  const spanIsPartial = spanStart !== null && spanStart > from;
  // Compare like with like: the benchmark covers exactly the portfolio's span.
  // F1: the index is fetched from before `from`; with no span it is still clipped to the period.
  const bench = clipBenchmark(rawBench, spanStart ?? from, to);
  const portfolioReturn = spanStart !== null && points[0].value !== 0 ? points[points.length - 1].value / points[0].value - 1 : null;
  const benchmarkReturn = spanStart !== null && bench.points && bench.points.length > 1 ? bench.points[bench.points.length - 1].returnFraction : null;
  return { series: { period, currency, points, benchmark: bench, portfolioReturn, benchmarkReturn, fxNote: comparisonNote(currency, benchmark), investmentReturn: toReturn(twr.investmentReturn), benchmarkReturnTwr: toReturn(twr.benchmarkReturn), returnSpan: twr.span, spanStart, spanIsPartial }, earliest, ...(twr.incomplete?.length ? { incomplete: twr.incomplete } : {}) };
}

/**
 * CAD view (spec 6.5, task 11): included CAD and USD accounts in one CAD series, USD daily values × that day's
 * BoC rate (est.), with the time-weighted return on those CAD values (flows converted on their own dates).
 * A day an account cannot be converted is counted and left out of the chart and the return (no fake drop).
 */
async function buildHomeSeries(deps: OverviewDeps, portfolio: PortfolioPresentation, authSubject: string, period: Period, benchmark: BenchmarkKey, excluded: ReadonlySet<string> = new Set()): Promise<SeriesBuild> {
  const to = today(deps);
  const deadline = deps.marketDeadlineMs ?? DEFAULT_MARKET_DEADLINE_MS;
  const earliests = await Promise.all(HOME_SCOPE.map((c) => deps.dailyValues.earliest(authSubject, c).catch(() => null)));
  const earliest = earliests.filter((e): e is string => !!e).sort()[0] ?? null;
  const from = periodStart(period, to, earliest);
  const benchPromise = withDeadline(() => benchmarkSeries(deps.market, benchmark, benchmarkFetchFrom(from), to), deadline, () => unavailableBenchmark(benchmark));
  const [rows, conv] = await Promise.all([
    deps.dailyValues.rows(authSubject, from).catch(() => [] as Awaited<ReturnType<OverviewDeps["dailyValues"]["rows"]>>),
    homeConverterFor(deps.market, from, to, deadline),
  ]);
  const rowCurrency = new Map<string, { date: string; currency: string }>();
  for (const r of rows) { const seen = rowCurrency.get(r.accountId); if (!seen || r.date >= seen.date) rowCurrency.set(r.accountId, { date: r.date, currency: r.currency }); }
  const scopeAccounts = portfolio.accounts.filter((a) => countsTowardReturns(a.classification) && !excluded.has(a.id) && HOME_SCOPE.includes(a.value?.currency ?? rowCurrency.get(a.id)?.currency ?? ""));
  const ids = scopeAccounts.map((a) => a.id);
  const idSet = new Set(ids);
  // Today's point: the brokerage-reported totals at today's rate, only when every scope account reports one
  // (Performance's rule); a partial today would draw a false drop.
  const allValued = scopeAccounts.length > 0 && scopeAccounts.every((a) => a.value && HOME_SCOPE.includes(a.value.currency));
  const todayValues = allValued ? new Map(scopeAccounts.map((a) => [a.id, { amount: a.value!.amount, currency: a.value!.currency }])) : null;
  const home = homeDailySeries(rows.filter((r) => idSet.has(r.accountId)), conv, from, to, todayValues, idSet);
  if (!home.estimated) {
    // No USD value converted (e.g. the BoC fetch failed): the not-converted rule, the series in its own
    // currency as with the CAD view off, marked so the widget says the USD accounts were not converted.
    const native = await buildSeriesWithEarliest(deps, portfolio, buildOverviewSummary(portfolio, new Map()), authSubject, period, benchmark, false, excluded);
    if (home.notConvertedAccounts.length === 0) return native; // no USD value to convert: nothing to say
    return { ...native, series: { ...native.series, home: { estimated: false, notConvertedDays: 0, notConvertedAccounts: home.notConvertedAccounts.length, flowNotConverted: null } } };
  }
  const points = home.complete;
  const flowDeps: FlowDeps | null = deps.activities && deps.market.securityHistory
    ? { activities: deps.activities, market: { usdCad: deps.market.usdCad, securityHistory: deps.market.securityHistory } }
    : null;
  const failed = (reason: string): TwrResult => ({ investmentReturn: { value: null, estimated: false, reason }, benchmarkReturn: { value: null, estimated: false, reason }, span: null });
  const returnsPromise: Promise<TwrResult> = flowDeps
    ? withDeadline<TwrResult>(async () => {
        try {
          return await portfolioReturns(flowDeps, authSubject, { ids, currency: HOME_CURRENCY, from, today: to, values: points, deadline, benchmark: benchPromise, valued: { scope: home.valued }, home: conv, matchOnlyIds: cashAccountIds(portfolio) });
        } catch {
          return failed("error");
        }
      }, deadline, () => failed("timeout"))
    : Promise.resolve(failed("flows_unavailable"));
  const [rawBench, twr] = await Promise.all([benchPromise, returnsPromise]);
  const investmentReturn = home.estimated && twr.investmentReturn.value !== null ? { ...twr.investmentReturn, estimated: true } : twr.investmentReturn;
  const spanStart = points.length > 1 ? points[0].date : null;
  const spanIsPartial = spanStart !== null && spanStart > from;
  const bench = clipBenchmark(rawBench, spanStart ?? from, to);
  const portfolioReturn = spanStart !== null && points[0].value !== 0 ? points[points.length - 1].value / points[0].value - 1 : null;
  const benchmarkReturn = spanStart !== null && bench.points && bench.points.length > 1 ? bench.points[bench.points.length - 1].returnFraction : null;
  return {
    series: {
      period, currency: HOME_CURRENCY, points, benchmark: bench, portfolioReturn, benchmarkReturn, fxNote: comparisonNote(HOME_CURRENCY, benchmark),
      investmentReturn: toReturn(investmentReturn), benchmarkReturnTwr: toReturn(twr.benchmarkReturn), returnSpan: twr.span, spanStart, spanIsPartial,
      home: { estimated: home.estimated, notConvertedDays: home.notConvertedDays, notConvertedAccounts: home.notConvertedAccounts.length, flowNotConverted: twr.flowNotConverted ?? null },
    },
    earliest,
    ...(twr.incomplete?.length ? { incomplete: twr.incomplete } : {}),
  };
}

/**
 * Value series for the primary currency plus a benchmark over the same span. Today's value is
 * the brokerage-reported total, so quotes are not needed here.
 */
export async function buildOverviewSeries(deps: OverviewDeps, portfolio: PortfolioPresentation, summary: Pick<OverviewSummary, "primaryCurrency" | "totals">, authSubject: string, period: Period, benchmark: BenchmarkKey, cadView = false): Promise<OverviewSeries> {
  return (await seriesWithoutGaps(deps, portfolio, summary, authSubject, period, benchmark, cadView)).series;
}

/** Series for the widget's period/benchmark switch: brokerage totals only, no quotes. */
/** `leftOut` is the chat line naming the accounts left out of the line and the return (leftOutText). */
export async function buildOverviewSeriesForTool(deps: OverviewDeps, portfolio: PortfolioPresentation, authSubject: string, input: { period: Period; benchmark?: BenchmarkKey }): Promise<{ series: OverviewSeries; leftOut: string }> {
  const settings = await loadSettings(deps, authSubject);
  const built = await seriesWithoutGaps(deps, portfolio, buildOverviewSummary(portfolio, new Map()), authSubject, input.period, input.benchmark ?? settings.benchmark, settings.cadView);
  return { series: built.series, leftOut: leftOutText(portfolio, incompleteLabels(portfolio, built.incomplete)) };
}

const incompleteLabels = (portfolio: PortfolioPresentation, ids: string[] | undefined) =>
  (ids ?? []).map((id) => portfolio.accounts.find((a) => a.id === id)?.classification.label ?? "Account");

/**
 * Accounts left out of the value line and the return, named without amounts (spec 2026-10-29-incomplete-history):
 * managed portfolios always, and accounts with a gap in their value history this period.
 */
export function leftOutText(portfolio: Pick<PortfolioPresentation, "accounts">, gaps: readonly string[]): string {
  const managed = [...new Set(portfolio.accounts.filter((a) => a.classification.includedInPortfolioTotal && isManagedPortfolio(a.classification)).map((a) => a.classification.label))];
  const gapped = [...new Set(gaps)];
  if (managed.length === 0 && gapped.length === 0) return "";
  return " The chart and return count only accounts whose numbers SnapTrade provides in full."
    + (managed.length ? ` Left out: ${managed.join(", ")} (managed; SnapTrade doesn't provide its holdings history).` : "")
    + (gapped.length ? ` Left out for this period: ${gapped.join(", ")} (gaps in its value history).` : "");
}

export async function buildOverviewPayload(deps: OverviewDeps, portfolio: PortfolioPresentation, authSubject: string, input: { period?: Period; benchmark?: BenchmarkKey }): Promise<OverviewPayload> {
  const settings = await loadSettings(deps, authSubject);
  const deadline = deps.marketDeadlineMs ?? DEFAULT_MARKET_DEADLINE_MS;
  const to = today(deps);
  // One Bank of Canada fetch: its latest close converts foreign holdings for the largest holding and group
  // day changes (as before); the same series feeds the CAD figures (today's and the previous trading day's rate).
  type FxSeries = Array<{ date: string; close: number }> | null;
  const fxPromise: Promise<FxSeries> = summaryNeedsFx(portfolio) || holdsForeignCurrency(portfolio)
    ? withDeadline(async () => (await deps.market.usdCad(daysBefore(to, 10), to)) ?? null, deadline, () => null)
    : Promise.resolve(null);
  const [quotes, built, qualities, fx, building] = await Promise.all([
    withDeadline(() => deps.market.quotes(quoteTickers(portfolio)), deadline, () => new Map()),
    seriesWithoutGaps(deps, portfolio, buildOverviewSummary(portfolio, new Map()), authSubject, input.period ?? "YTD", input.benchmark ?? settings.benchmark, settings.cadView),
    loadQualities(deps, authSubject),
    fxPromise,
    withDeadline(() => historyBuilding(deps, portfolio, authSubject), deadline, () => false),
  ]);
  const { series, earliest } = built;
  const incompleteAccounts = incompleteLabels(portfolio, built.incomplete);
  const usdCad = summaryNeedsFx(portfolio) ? fx?.at(-1)?.close ?? null : null;
  const summary = buildOverviewSummary(portfolio, quotes, { usdCad, home: homeConverter(fx, to) });
  return { portfolio, summary, series, settings, benchmarks: BENCHMARK_KEYS.map((key) => ({ key, name: BENCHMARKS[key].name, explainer: BENCHMARKS[key].explainer })), history: { qualities, earliest, building, ...(incompleteAccounts.length ? { incompleteAccounts } : {}) } };
}

/** Whether any investable account has an amount outside the home currency (its CAD figures want a rate). */
/** Whether any investable account has a total, cash or position in `currency` (its CAD figures want that rate). */
export function holdsCurrency(portfolio: PortfolioPresentation, currency: string): boolean {
  const is = (c: string | null | undefined) => !!c && c.trim().toUpperCase() === currency;
  return portfolio.accounts.filter(isInvestable).some((a) => is(a.value?.currency) || a.balances.some((b) => is(b.currency)) || a.positions.some((p) => is(p.currency)));
}

export function holdsForeignCurrency(portfolio: PortfolioPresentation): boolean {
  return portfolio.accounts.filter(isInvestable).some((a) =>
    (a.value && a.value.currency !== HOME_CURRENCY)
    || a.balances.some((b) => b.currency !== HOME_CURRENCY)
    || a.positions.some((p) => !!p.currency && p.currency !== HOME_CURRENCY));
}

export interface IntradayPayload extends IntradayResult {
  label: "Estimated from live prices";
  /** Holdings that could not be valued (no reported market value, or cash in a currency without a rate). */
  warnings: number;
  fallback: { previousClose: number | null; reported: number | null };
  /** Currency of the line and the fallback figures: CAD in the CAD view with a USD account, else the primary one. */
  currency: string;
}

const INTRADAY_CONCURRENCY = 4;

/**
 * Keeps the bars inside [start, end] and carries the last earlier bar in at `start`. When no bar
 * is at or before the end (crypto's UTC day already moved on), its earliest bar is held flat.
 */
function clipToWindow(points: Array<{ t: string; price: number }>, window: { start: number; end: number }): Array<{ t: string; price: number }> {
  const sorted = points.map((p) => ({ ms: Date.parse(p.t), price: p.price })).filter((p) => Number.isFinite(p.ms)).sort((a, b) => a.ms - b.ms);
  if (!sorted.length) return [];
  const inside = sorted.filter((p) => p.ms >= window.start && p.ms <= window.end);
  const before = sorted.filter((p) => p.ms < window.start).at(-1);
  const carry = before ?? (inside.length ? undefined : sorted[0]);
  const out = inside.map((p) => ({ t: new Date(p.ms).toISOString(), price: p.price }));
  if (carry && !(inside[0]?.ms === window.start)) out.unshift({ t: new Date(window.start).toISOString(), price: carry.price });
  return out;
}
const daysBefore = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

/**
 * Today's estimated portfolio line for the primary currency from live intraday bars. It reuses
 * the already-loaded portfolio (no provider read) and always carries the stored/reported
 * fallback figures so the widget can show them when the line is not drawn.
 */
export async function buildIntraday(deps: OverviewDeps, portfolio: PortfolioPresentation, authSubject: string): Promise<IntradayPayload> {
  const to = today(deps);
  const deadline = deps.marketDeadlineMs ?? DEFAULT_MARKET_DEADLINE_MS;
  const summary = buildOverviewSummary(portfolio, new Map());
  const settings = await loadSettings(deps, authSubject);
  // CAD view with a USD account: one CAD line over CAD and USD accounts, at the latest BoC rate (est.).
  const home = homeCharts(portfolio, settings.cadView);
  const currency = home ? HOME_CURRENCY : summary.primaryCurrency ?? "CAD";
  const from = daysBefore(to, 10);
  // Same scope as the overview: included accounts whose reported currency is the line's (CAD and USD in the CAD view).
  const accounts = portfolio.accounts.filter((a) => {
    const c = a.value?.currency ?? a.balances[0]?.currency ?? currency;
    return countsTowardReturns(a.classification) && (home ? HOME_SCOPE.includes(c) : c === currency);
  });
  const conv = home ? await homeConverterFor(deps.market, from, to, deadline) : null;
  let reported: number | null;
  let previousClose: number | null;
  if (conv) {
    const parts = accounts.filter((a) => a.value).map((a) => conv.at(a.value!.amount, a.value!.currency));
    const total = sumHome(parts);
    reported = parts.length && total.excludedCount === 0 ? total.amount : null;
    const ids = new Set(accounts.map((a) => a.id));
    previousClose = await deps.dailyValues.rows(authSubject, from)
      .then((rows) => homeDailySeries(rows.filter((r) => ids.has(r.accountId)), conv, from, to, null, ids).complete.at(-1)?.value ?? null)
      .catch(() => null);
  } else {
    reported = summary.totals.find((t) => t.currency === currency)?.amount ?? null;
    previousClose = await deps.dailyValues.rows(authSubject, from)
      .then((rows) => mergeDailyPoints(rows, currency, from, to, null).at(-1)?.value ?? null)
      .catch(() => null);
  }
  const label = "Estimated from live prices" as const;
  const fallback = { previousClose, reported };

  const needsFx = accounts.some((a) => a.balances.some((b) => b.cash !== null && b.currency !== currency) || a.positions.some((p) => !p.cashEquivalent && p.currency && p.currency !== currency));

  // Positions as the overview summary sees them: cash-equivalent positions are not holdings and
  // add nothing on top of the balance cash (no double count).
  const positions = accounts.flatMap((a) => a.positions.filter((p) => !p.cashEquivalent && p.units).map((p) => ({ p, ticker: p.marketValue === null || !p.currency ? null : providerTicker({ symbol: p.symbol, kind: p.kind, currency: p.currency }) })));
  const wanted = new Map<string, "5m" | "1h">();
  for (const { p, ticker } of positions) if (ticker) wanted.set(ticker, p.kind.toLowerCase() === "crypto" ? "1h" : "5m");

  const fetched = new Map<string, { points: Array<{ t: string; price: number }>; sessionDate: string | null }>();
  const intraday = deps.market.intraday?.bind(deps.market);
  // Stops the workers once the batch deadline has fired.
  let cancelled = false;
  const barsPromise = !intraday || !wanted.size ? Promise.resolve(true) : withDeadline(async () => {
    const queue = [...wanted];
    let next = 0;
    const worker = async () => {
      while (!cancelled && next < queue.length) {
        const [ticker, interval] = queue[next++];
        try {
          const bars = await intraday(ticker, interval);
          if (bars && !cancelled) fetched.set(ticker, bars);
        } catch {
          // A failed ticker is simply uncovered.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(INTRADAY_CONCURRENCY, queue.length) }, worker));
    return true;
  }, deadline, () => { cancelled = true; return false; });
  // The rate and the bars are fetched together, so the whole call stays within about one deadline.
  const fxPromise: Promise<number | null> = conv ? Promise.resolve(conv.latest?.rate ?? null) : needsFx
    ? withDeadline(async () => (await deps.market.usdCad(from, to))?.at(-1)?.close ?? null, deadline, () => null)
    : Promise.resolve(null);
  const [fx] = await Promise.all([fxPromise, barsPromise]);
  cancelled = true;

  // Convert once; an amount that cannot be converted contributes 0 and is counted as a warning.
  const convert = (amount: number, source: string): number | null => {
    if (source === currency) return amount;
    if (fx === null || !(fx > 0)) return null;
    if (source === "USD" && currency === "CAD") return amount * fx;
    if (source === "CAD" && currency === "USD") return amount / fx;
    return null;
  };
  let cash = 0; let warnings = 0;
  for (const account of accounts) for (const b of account.balances) {
    if (b.cash === null) continue;
    const converted = convert(b.cash, b.currency);
    if (converted === null) warnings++; else cash += converted;
  }
  const holdings: IntradayHolding[] = [];
  for (const { p, ticker } of positions) {
    const converted = p.marketValue === null || !p.currency ? null : convert(p.marketValue, p.currency);
    if (converted === null) warnings++;
    holdings.push({ ticker: ticker ?? "", units: p.units!, currency: p.currency ?? currency, value: converted ?? 0 });
  }

  // Crypto trades around the clock and its `range=1d` bars cover the UTC day. With any equity bars,
  // the axis is the equity session: crypto is clipped to it and the session date is the equities'.
  const isCrypto = (ticker: string) => wanted.get(ticker) === "1h";
  const equities = [...fetched].filter(([ticker, b]) => !isCrypto(ticker) && b.points.length > 0);
  const window = equities.length === 0 ? null : (() => {
    const ms = equities.flatMap(([, b]) => b.points.map((p) => Date.parse(p.t))).filter(Number.isFinite);
    return ms.length ? { start: Math.min(...ms), end: Math.max(...ms) } : null;
  })();
  const bars = new Map([...fetched].map(([ticker, b]) => [ticker, window && isCrypto(ticker) ? clipToWindow(b.points, window) : b.points]));
  const sessionSource = window ? equities.map(([, b]) => b) : [...fetched.values()];
  const sessionDates = new Set(sessionSource.flatMap((b) => (b.sessionDate ? [b.sessionDate] : [])));
  // Bars from different sessions are mixed on one axis.
  if (sessionDates.size > 1) warnings++;
  const sessionDate = [...sessionDates].sort().at(-1) ?? null;
  const line = intradayLine({ holdings, cash, scopeCurrency: currency, fx, bars, sessionDate });
  return { ...line, label, warnings, fallback, currency };
}

/** Compact copy for the model (F5): no 5-minute points, only their count. */
export function intradayModelCopy(p: IntradayPayload) {
  return { drawn: p.drawn, coverage: p.coverage, sessionDate: p.sessionDate, points: p.points.length };
}

const NOT_CONVERTED = "not converted (no recent Bank of Canada rate)";
/** Every part was excluded: the CAD amount is 0 from nothing and must not be shown as a figure. */
const notConverted = (t: HomeTotal) => t.excluded.length > 0 && t.amount === 0 && !t.estimated && t.rateDates.length === 0;
const lastDateYear = (payload: OverviewPayload) => (payload.series.points.at(-1)?.date ?? payload.portfolio.generatedAt).slice(0, 4);
export function overviewText(payload: OverviewPayload): string {
  const gapNote = notInTotalText(payload.portfolio) + leftOutText(payload.portfolio, payload.history.incompleteAccounts ?? []);
  const { summary, series } = payload;
  const native = summary.totals.map((t) => formatMoney(t.amount, t.currency)).join(" + ") || "unavailable";
  // CAD figures and the CAD note follow the switch: with it off the screen shows native currencies.
  const home = payload.settings.cadView ? summary.home : undefined;
  const year = lastDateYear(payload);
  const totals = !home ? native
    : notConverted(home.total) ? NOT_CONVERTED
    : `${formatMoney(home.total.amount, HOME_CURRENCY)}${homeQualifier(home.total, year)}`;
  const gain = home && (home.unrealizedGain.excluded.length > 0 || summary.unrealizedGain.length > 0) && !notConverted(home.unrealizedGain)
    ? ` Unrealized gain (at today's rate) ${formatMoney(home.unrealizedGain.amount, HOME_CURRENCY)}${home.unrealizedGain.estimated ? " est." : ""}; excludes currency movement since purchase.`
    : "";
  const homeNote = home
    ? ` Figures are in CAD; USD amounts are converted at the Bank of Canada rate and marked est.${home.includesUnreported ? " The CAD total includes accounts without a brokerage total, valued from their holdings." : ""}${gain} In original currencies: ${native}.`
    : "";
  const pct = (f: number | null) => (f === null ? "n/a" : `${f < 0 ? "-" : "+"}${(Math.abs(f) * 100).toFixed(1)}%`);
  const lastDate = series.points.at(-1)?.date ?? payload.portfolio.generatedAt.slice(0, 10);
  const twr = series.investmentReturn?.value ?? null;
  const est = series.investmentReturn?.estimated ? " (estimated)" : "";
  const head = series.returnSpan?.partial && series.returnSpan.since ? `Return since ${shortDate(series.returnSpan.since, lastDate.slice(0, 4))}` : `${series.period} return`;
  const span = series.spanIsPartial && series.spanStart ? `Value change since ${shortDate(series.spanStart, lastDate.slice(0, 4))}:` : `${series.period} value change`;
  if (twr !== null) {
    return `Total ${totals}. ${head} ${pct(twr)} vs ${series.benchmark.name}${series.benchmark.basis ? ` (${series.benchmark.basis})` : ""} ${pct(series.benchmarkReturnTwr?.value ?? null)} (time-weighted, investment accounts only, excludes money you added)${est}.${homeNote}${gapNote} ${DATA_FRESHNESS_TEXT} Showing the overview widget.`;
  }
  // Without a time-weighted return there is no fair comparison: a value change includes deposits.
  if (payload.history.building) return `Total ${totals}. ${HISTORY_BUILDING_TEXT}${homeNote}${gapNote} ${DATA_FRESHNESS_TEXT} Showing the overview widget.`;
  return `Total ${totals}. ${span} ${pct(series.portfolioReturn)} (investment accounts, includes deposits). A comparison with ${series.benchmark.name} needs deposit history.${homeNote}${gapNote} ${DATA_FRESHNESS_TEXT} Showing the overview widget.`;
}

type SummaryFigures = Pick<OverviewSummary, "primaryCurrency" | "totals" | "home" | "dayChange" | "dayChangeSession" | "largestHolding" | "allocation" | "allocationCurrency" | "unrealizedGain" | "unrealizedCoverage" | "cash" | "cashNetOfMargin" | "groups">;
type SeriesFigures = Pick<OverviewSeries, "period" | "currency" | "portfolioReturn" | "investmentReturn" | "benchmarkReturnTwr" | "returnSpan" | "spanStart" | "spanIsPartial" | "home"> & { benchmark: Pick<OverviewSeries["benchmark"], "name" | "basis"> };
type ModelAccount = Pick<PortfolioPresentation["accounts"][number], "id" | "name" | "value" | "freshness"> & { label: string; bucket: string };
export interface OverviewModelCopy {
  portfolio: Pick<PortfolioPresentation, "connectionRequired" | "errors" | "generatedAt">;
  summary: SummaryFigures;
  series: SeriesFigures;
  history: Pick<OverviewHistory, "building" | "incompleteAccounts">;
  accounts: ModelAccount[];
  settings: Pick<PortfolioSettingsView, "cadView">;
}

/**
 * Compact copy for the model (spec D6, R8): the figures with the flags that qualify them, the connection and
 * partial-failure signals, and the account list (so it can chain an accountId), without per-day arrays or positions.
 * Only existing fields are copied; nothing new is computed. structuredContent is separate.
 */
export function overviewModelCopy(payload: OverviewPayload): OverviewModelCopy {
  const { summary, series, history, settings, portfolio } = payload;
  return {
    portfolio: { connectionRequired: portfolio.connectionRequired, errors: portfolio.errors, generatedAt: portfolio.generatedAt },
    summary: {
      primaryCurrency: summary.primaryCurrency, totals: summary.totals, home: summary.home, dayChange: summary.dayChange, dayChangeSession: summary.dayChangeSession,
      largestHolding: summary.largestHolding, allocation: summary.allocation, allocationCurrency: summary.allocationCurrency,
      unrealizedGain: summary.unrealizedGain, unrealizedCoverage: summary.unrealizedCoverage,
      cash: summary.cash, cashNetOfMargin: summary.cashNetOfMargin, groups: summary.groups,
    },
    series: {
      period: series.period, currency: series.currency, portfolioReturn: series.portfolioReturn, investmentReturn: series.investmentReturn,
      benchmarkReturnTwr: series.benchmarkReturnTwr, returnSpan: series.returnSpan, spanStart: series.spanStart,
      spanIsPartial: series.spanIsPartial, benchmark: { name: series.benchmark.name, basis: series.benchmark.basis }, home: series.home,
    },
    history: { building: history.building, incompleteAccounts: history.incompleteAccounts },
    accounts: portfolio.accounts.map((a) => ({
      id: a.id, name: a.name, label: a.classification.label, bucket: a.classification.bucket, value: a.value, freshness: a.freshness,
    })),
    settings: { cadView: settings.cadView },
  };
}

const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const security = [{ type: "oauth2" as const, scopes: ["portfolio:read"] }];
const periodSchema = { type: "string", enum: [...PERIODS] } as const;
const benchmarkSchema = { type: "string", enum: [...BENCHMARK_KEYS] } as const;

// show_portfolio is redefined by the server (it needs the refresh schema); the others live here.
export const overviewExtraToolDefinitions = [
  {
    name: "get_overview_series",
    title: "Get overview value series",
    description: "Load the portfolio value series for a period against a benchmark. Used by the portfolio overview widget; read-only.",
    inputSchema: { type: "object", properties: { period: periodSchema, benchmark: benchmarkSchema }, required: ["period"], additionalProperties: false },
    outputSchema: { type: "object", properties: { period: { type: "string" }, currency: { type: "string" }, points: { type: "array" }, benchmark: { type: "object" }, portfolioReturn: { type: ["number", "null"] }, benchmarkReturn: { type: ["number", "null"] }, investmentReturn: { type: "object" }, benchmarkReturnTwr: { type: "object" }, returnSpan: { type: ["object", "null"] }, fxNote: { type: ["string", "null"] }, spanStart: { type: ["string", "null"] }, spanIsPartial: { type: "boolean" } }, required: ["period", "currency", "points", "benchmark", "portfolioReturn", "benchmarkReturn", "investmentReturn", "benchmarkReturnTwr", "returnSpan", "fxNote", "spanStart", "spanIsPartial"], additionalProperties: false },
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    _meta: { securitySchemes: security, ui: { visibility: ["app"] } },
  },
  {
    name: "get_intraday",
    title: "Get today's estimated portfolio line",
    description: "Estimate today's portfolio value line from live prices for the widget. Read-only; no brokerage call.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", properties: { points: { type: "array" }, coverage: { type: "number" }, sessionDate: { type: ["string", "null"] }, drawn: { type: "boolean" }, label: { type: "string" }, warnings: { type: "number" }, fallback: { type: "object" }, currency: { type: "string" } }, required: ["points", "coverage", "sessionDate", "drawn", "label", "warnings", "fallback", "currency"], additionalProperties: false },
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    _meta: { securitySchemes: security, ui: { visibility: ["app"] } },
  },
  {
    name: "get_portfolio_settings",
    title: "Get portfolio display settings",
    description: "Get this app's saved display preferences (benchmark, CAD view, privacy default). Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    _meta: { securitySchemes: security, ui: { visibility: ["app"] } },
  },
  {
    name: "save_portfolio_settings",
    title: "Save portfolio display settings",
    description: "Save display preferences (benchmark, CAD view, privacy default). It only stores display preferences in this app; nothing at the brokerage changes.",
    inputSchema: { type: "object", properties: { benchmark: benchmarkSchema, cadView: { type: "boolean" }, privacyDefault: { type: "boolean" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    securitySchemes: security,
    _meta: { securitySchemes: security, ui: { visibility: ["app"] } },
  },
] as const;

export function overviewShowPortfolioDefinition(base: Record<string, unknown>, refreshSchema: unknown) {
  return {
    ...base,
    description: "Use this when the user asks to see, show or open their portfolio, an overview, their accounts or their total value: renders the interactive portfolio dashboard. Read-only.",
    inputSchema: { type: "object", properties: { refresh: refreshSchema, period: periodSchema, benchmark: benchmarkSchema }, additionalProperties: false },
    outputSchema: { type: "object", properties: { portfolio: { type: "object" }, summary: { type: "object" }, series: { type: "object" }, settings: { type: "object" }, benchmarks: { type: "array" }, history: { type: "object" } }, required: ["portfolio", "summary", "series", "settings", "benchmarks", "history"], additionalProperties: false },
    _meta: { securitySchemes: security, ui: { resourceUri: OVERVIEW_WIDGET_URI }, "openai/outputTemplate": OVERVIEW_WIDGET_URI,
      "openai/widgetAccessible": true, "openai/toolInvocation/invoking": "Loading portfolio…", "openai/toolInvocation/invoked": "Portfolio ready." },
  };
}
