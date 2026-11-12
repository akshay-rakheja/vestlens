import { z } from "zod";
import { BENCHMARKS } from "../analytics/benchmarks.js";
import { externalFlows, type FlowResult } from "../analytics/flows.js";
import { buildOverviewSummary } from "../analytics/overview-summary.js";
import { computePerformance, type Figure, type PerformanceResult } from "../analytics/performance.js";
import { HOME_CURRENCY } from "../fx/home-currency.js";
import { benchmarkFetchFrom, benchmarkSeries, mergeDailyPoints, minusMonths, valuedScope, type ValuedScope, type DailyRow, type OverviewSeries, type SeriesPoint } from "../analytics/value-series.js";
import type { ActivityStore } from "../history/activity-store.js";
import type { StoredActivity } from "../history/stored-activity.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import { providerTicker } from "../market-data/ticker-map.js";
import type { PricePoint, SecurityHistory } from "../market-data/types.js";
import type { PortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import { BENCHMARK_KEYS, type BenchmarkKey, type PortfolioSettingsView, type SettingsService } from "../settings/settings-service.js";
import type { DailySnapshotService } from "../snapshots/daily-snapshot-service.js";
import { loadSettings, withDeadline } from "./overview-tools.js";
import type { HomeConverter } from "../fx/home-currency.js";
import { homeDailySeries, type HomeSeries } from "../fx/home-series.js";
import { CAD_NOTE, homeConverterFor } from "./home-fx.js";
import { countsTowardReturns, isCashAccount, isManagedPortfolio } from "../portfolio/account-taxonomy.js";
import { accountFilterProperties, accountFilterShape, resolveAccountFilter, type AccountType } from "./query-filters.js";

export const PERFORMANCE_WIDGET_URI = "ui://portfolio/performance-v1";
export const PERFORMANCE_PERIODS = ["1M", "3M", "YTD", "1Y", "3Y", "ALL"] as const;
export type PerformancePeriod = (typeof PERFORMANCE_PERIODS)[number];
/** Periods long enough to show a yearly rate (CAGR) when the span reaches a year. */
export const YEARLY_PERIODS: readonly PerformancePeriod[] = ["3Y", "ALL"];

export const performanceInput = z.object({
  period: z.enum(PERFORMANCE_PERIODS).optional(),
  ...accountFilterShape,
  benchmark: z.enum(BENCHMARK_KEYS).optional(),
}).strict();

export interface PerformanceDeps {
  market: Pick<MarketDataService, "history" | "usdCad" | "securityHistory">;
  settings: Pick<SettingsService, "get" | "save">;
  dailyValues: Pick<DailySnapshotService, "rows" | "earliest">;
  activities: Pick<ActivityStore, "userId" | "listActivities" | "syncState" | "qualities">;
  now?: () => Date;
  /** Budget for each market-data stage. Default 5000 ms. */
  marketDeadlineMs?: number;
}

export interface PerformancePayload {
  scope: { kind: "portfolio" | "account"; accountId?: string; label: string; currency: string };
  accounts: Array<{ id: string; label: string; currency: string }>;
  period: PerformancePeriod;
  span: PerformanceResult["span"];
  series: PerformanceResult["series"];
  figures: PerformanceResult["figures"];
  monthly: PerformanceResult["monthly"];
  benchmark: { key: BenchmarkKey; name: string; label: string; explainer: string; basis: string; note: string | null; unavailableReason: string | null };
  benchmarks: Array<{ key: BenchmarkKey; name: string; explainer: string }>;
  settings: PortfolioSettingsView;
  history: { qualities: Array<{ accountId: string; method: string; reason: string | null; driftFraction: number | null }>; earliest: string | null };
  otherCurrencies: string[];
  asOf: string;
  /**
   * CAD view (settings.cadView) with a USD account in scope: series and figures are in CAD (USD daily values
   * and flows × that day's BoC rate, est.). Null with the CAD view off or without USD in scope.
   */
  home: PerformanceHome | null;
  /**
   * The working behind figures.netDeposits (spec 2026-10-29-investment-scope-and-deposits-design.md): put in, taken out
   * and per account, plus the Cash accounts left out of returns. For the dashboard and the text line only: hosts cache
   * show_performance's closed output schema, so the MCP server strips it from structuredContent.
   */
  deposits: PerformanceDeposits | null;
  /**
   * Investment accounts left out of every figure because VestLens can't get their numbers right (spec
   * 2026-10-29-incomplete-history): managed portfolios (SnapTrade gives no holdings history) and, in the portfolio
   * scope, accounts with a gap in their value history this period. Named only, never with amounts. Stripped from
   * structuredContent with deposits.
   */
  notInFigures: NotInFigures[];
  /**
   * accountType resolved to one account: the other accounts of the type that performance can't report on, named in the
   * text (agent query surface spec, D2). Set only then, so the payload otherwise equals the accountId one. Stripped
   * from structuredContent with deposits.
   */
  excluded?: ExcludedAccount[];
  /**
   * Steps in an account's value inside the span that SnapTrade's records have no deposit or withdrawal for (spec
   * 2026-11-04-unrecorded-flow-check): the flow-based figures are marked estimated and the text explains each one.
   * amount: in the account's own currency, + money in, − money out. Stripped from structuredContent with deposits.
   */
  unrecorded: UnrecordedInFigures[];
}

export interface UnrecordedInFigures { accountId: string; label: string; name: string; date: string; amount: number; currency: string }

/** The scope accounts' unrecorded flows dated inside the span (after its first day, as for flows). */
function unrecordedInSpan(qualities: readonly Quality[], ids: ReadonlySet<string>, span: { start: string; end: string }) {
  return qualities.filter((q) => ids.has(q.accountId))
    .flatMap((q) => (q.unrecordedFlows ?? []).filter((e) => e.date > span.start && e.date <= span.end).map((e) => ({ accountId: q.accountId, ...e })))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** `accountId` lets the text skip the generic "Left out" line for an account this sentence already names; never in the text. */
export interface ExcludedAccount { accountId: string; name: string; reason: "managed" | "cash" }

export interface NotInFigures { accountId: string; label: string; name: string; reason: "managed" | "history_gaps" }

export interface PerformanceDeposits {
  putIn: number;
  /** Negative, or zero. */
  takenOut: number;
  estimated: boolean;
  /** label: the account type as VestLens groups it; name and value: the brokerage's own name and today's value, to match. */
  byAccount: Array<{ accountId: string; label: string; name: string; bucket: string; value: { amount: number; currency: string } | null; putIn: number; takenOut: number }>;
  /** Labels of Cash / money market accounts in the total but not in returns (countsTowardReturns). */
  leftOut: string[];
}

/**
 * Accounts, among `eligible`, with an external flow inside the span that their value history misses: their deposits
 * would be dropped from put in, so the caller leaves them out of the figures. A flow outside the history is a gap
 * unless the account is new in the span and its join value, a few days later, includes it (a first deposit). An
 * account that existed before the span but is valued only from partway through it has a gap whatever the distance.
 */
function incompleteHistory(flows: FlowResult | null | undefined, span: { start: string; end: string }, eligible: ReadonlySet<string>): string[] {
  if (!flows?.outsideHistory?.length) return [];
  const existedBefore = (id: string) => (flows.firstActivity?.get(id) ?? span.end) <= span.start;
  return [...new Set(flows.outsideHistory
    .filter((e) => e.date > span.start && e.date <= span.end && eligible.has(e.accountId) && (!e.joinCovered || existedBefore(e.accountId)))
    .map((e) => e.accountId))];
}

export interface PerformanceHome {
  currency: "CAD";
  /** False when nothing in scope could be converted: the payload is then in the scope's own currency. */
  converted: boolean;
  /** Some figure was converted from USD; the returns are then labelled est. */
  estimated: boolean;
  /** Days left out of the series (and the return) because a USD account had no BoC rate within 7 days. */
  notConvertedDays: number;
  /** Scope accounts never converted in the span (e.g. the BoC fetch failed): not in the CAD figures. */
  notConvertedAccounts: number;
  /** First date of a USD deposit or withdrawal with no rate within 7 days: the CAD return is withheld. */
  flowNotConverted: string | null;
  /** One USD account: its figures in its own currency, shown under the CAD ones. */
  native: { currency: string; value: number | null; valueChange: Figure; netDeposits: Figure; marketGain: Figure } | null;
}

/** What the flow loader needs; the overview supplies the same shape. */
export interface FlowDeps {
  market: Pick<MarketDataService, "usdCad" | "securityHistory">;
  activities: PerformanceDeps["activities"];
}

export type PerformanceScopeCode =
  | "unknown_account" | "cash_account" | "managed_account"
  | "both_filters" | "no_accounts_of_type" | "several_accounts";

export class PerformanceScopeError extends Error {
  /**
   * cash_account: a Cash / money market account; managed_account: a managed portfolio. Both are in the total but not
   * covered by returns (countsTowardReturns); the server holds their copy. both_filters, no_accounts_of_type and
   * several_accounts come from resolveAccountFilter and carry its text.
   */
  constructor(readonly code: PerformanceScopeCode, readonly text = "") { super(code); this.name = "PerformanceScopeError"; }
}

const torontoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });
const DEFAULT_MARKET_DEADLINE_MS = 5_000;
/** The resolver's unknown-or-excluded copy, for a type whose only accounts performance can't read yet (no known currency). */
const UNKNOWN_OR_EXCLUDED_TEXT = "Unknown or excluded account. Use list_portfolio_accounts to pick an account.";
const FALLBACK_START = "2000-01-01";
const minusDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

function startOf(period: PerformancePeriod, today: string, earliest: string | null): string {
  switch (period) {
    case "1M": return minusMonths(today, 1);
    case "3M": return minusMonths(today, 3);
    case "YTD": return `${today.slice(0, 4)}-01-01`;
    case "1Y": return minusMonths(today, 12);
    case "3Y": return minusMonths(today, 36);
    case "ALL": return earliest && earliest <= today ? earliest : FALLBACK_START;
  }
}

function asOf(series: PricePoint[], date: string): number | null {
  let value: number | null = null;
  for (const point of series) { if (point.date <= date) value = point.close; else break; }
  return value;
}

const activityDate = (a: StoredActivity) => a.tradeDate ?? a.settlementDate;
const isInKind = (a: StoredActivity) => a.type.toUpperCase() === "TRANSFER" && !a.isOption && !!a.symbol;
const needsPrice = (a: StoredActivity) => a.price === null || !(a.price > 0);
const inKindTicker = (a: StoredActivity, scopeCurrency: string) =>
  providerTicker({ symbol: a.symbol ?? "", kind: "stock", currency: a.securityCurrency ?? a.currency ?? scopeCurrency });

function comparisonNote(scopeCurrency: string, key: BenchmarkKey): string | null {
  const indexCurrency = BENCHMARKS[key].currency;
  if (indexCurrency === scopeCurrency) return null;
  if (scopeCurrency === "CAD") return "USD index converted to CAD with the Bank of Canada daily rate.";
  if (scopeCurrency === "USD") return "CAD index converted to USD with the Bank of Canada daily rate.";
  return null;
}

const unavailable = (key: BenchmarkKey): OverviewSeries["benchmark"] => ({ key, name: BENCHMARKS[key].name, explainer: BENCHMARKS[key].explainer, basis: BENCHMARKS[key].basis, points: null, unavailableReason: "Benchmark data unavailable" });

interface ScopeAccount { id: string; label: string; currency: string; value: number | null }

type Quality = Awaited<ReturnType<ActivityStore["qualities"]>>[number];

/**
 * F4: an account's stored activities are complete only after a successful backfill (a first-sync
 * error or a deferred first sync leaves none), and a no_activity reconstruction means none were seen.
 */
const activitiesComplete = (state: Awaited<ReturnType<ActivityStore["syncState"]>>, quality: Quality | undefined) =>
  !!state && state.backfillCompletedAt !== null && quality?.reason !== "no_activity";

async function loadFlows(deps: FlowDeps, authSubject: string, ids: string[], kind: "portfolio" | "account", scopeCurrency: string, from: string, today: string, deadline: number, qualities: Promise<Quality[]>, valued: ValuedScope | null, home?: HomeConverter, matchOnlyIds: string[] = []): Promise<FlowResult | null> {
  let activities: StoredActivity[];
  let matchOnly: StoredActivity[] = [];
  let incomplete: boolean;
  try {
    const userId = await deps.activities.userId(authSubject);
    if (!userId) return null;
    const [lists, states, quality, extra] = await Promise.all([
      Promise.all(ids.map((id) => deps.activities.listActivities(userId, id))),
      Promise.all(ids.map((id) => deps.activities.syncState(userId, id))),
      qualities,
      // Cash legs only pair transfers (externalFlows matchOnly); a failed read just loses that pairing.
      kind === "portfolio" ? Promise.all(matchOnlyIds.map((id) => deps.activities.listActivities(userId, id).catch(() => []))) : Promise.resolve([]),
    ]);
    activities = lists.flat();
    matchOnly = extra.flat();
    incomplete = ids.some((id, i) => !activitiesComplete(states[i], quality.find((q) => q.accountId === id)));
  } catch {
    return null;
  }
  // One account's flows unknown: nothing to show for it. Part of a portfolio: estimates.
  if (incomplete && kind === "account") return null;
  const inSpan = (a: StoredActivity) => { const d = activityDate(a); return d !== null && d > from && d <= today; };
  const relevant = activities.filter(inSpan);
  const foreign = relevant.some((a) => [a.currency, a.securityCurrency].some((c) => c && c.toUpperCase() !== scopeCurrency));
  // The CAD view converts flows with the same converter (and 7-day rule) as the daily values.
  const fxPromise: Promise<PricePoint[] | null> = !home && foreign && (scopeCurrency === "USD" || scopeCurrency === "CAD")
    ? withDeadline(() => deps.market.usdCad(minusDays(from, 10), today), deadline, () => null)
    : Promise.resolve(null);
  const tickers = new Set<string>();
  for (const a of relevant) {
    if (!isInKind(a) || !needsPrice(a)) continue;
    const t = inKindTicker(a, scopeCurrency);
    if (t) tickers.add(t);
  }
  const histories = new Map<string, SecurityHistory | null>();
  const [fx] = await Promise.all([
    fxPromise,
    ...[...tickers].map(async (t) => {
      const h = await withDeadline(() => deps.market.securityHistory(t, minusDays(from, 10), today), deadline, () => null);
      histories.set(t, h);
    }),
  ]);

  const unconverted = new Set<string>();
  const toScope = (amount: number, currency: string, date: string): number | null => {
    if (currency === scopeCurrency) return amount;
    if (home) {
      const v = scopeCurrency === "CAD" ? home.at(amount, currency, date).amount : null;
      if (v === null && currency === "USD" && date > from && date <= today) unconverted.add(date);
      return v;
    }
    if (!fx || !fx.length) return null;
    const pair = new Set([currency, scopeCurrency]);
    if (!(pair.has("USD") && pair.has("CAD"))) return null;
    const rate = asOf(fx, date);
    if (rate === null || !(rate > 0)) return null;
    return currency === "USD" ? amount * rate : amount / rate;
  };
  const priceInKind = (a: StoredActivity, date: string): number | null => {
    const t = inKindTicker(a, scopeCurrency);
    const h = t ? histories.get(t) : null;
    // No split list means the closes cannot be trusted to be split-adjusted: unpriceable.
    if (!h || h.notFound || !h.splits) return null;
    const close = asOf(h.points, date);
    if (close === null || !(close > 0)) return null;
    const factor = h.splits.filter((s) => s.date > date).reduce((p, s) => p * s.ratio, 1);
    const currency = (a.securityCurrency ?? a.currency ?? scopeCurrency).toUpperCase();
    return toScope(close * factor, currency, date);
  };
  const result = externalFlows({ activities, scope: kind, scopeCurrency, toScope, priceInKind, ...(valued ? { inScope: valued.inScope, joinCovers: valued.joinCovers } : {}), ...(matchOnly.length ? { matchOnly } : {}) });
  // Accounts joining or leaving the value series move their value in or out of it (brief 6); they
  // are kept apart from deposits (brief 9).
  const withJoins: FlowResult = valued && valued.joinLeave.size > 0
    ? { ...result, joins: valued.joins, leaves: valued.leaves, joinLeaveEstimated: valued.joinLeaveEstimated }
    : result;
  const withHome: FlowResult = unconverted.size > 0 ? { ...withJoins, homeUnconverted: [...unconverted].sort() } : withJoins;
  return incomplete ? { ...withHome, incomplete } : withHome;
}

export interface ScopedPerformanceInput {
  ids: string[]; kind: "portfolio" | "account"; currency: string; from: string; today: string;
  values: SeriesPoint[]; deadline: number;
  /**
   * Portfolio scope: the rows `values` was merged from (same currency, from and today) and the
   * accounts valued today (null without a today point). With them, flows follow each account's
   * valued window and accounts joining or leaving the series are flows (brief 6).
   */
  valued?: { rows: DailyRow[]; todayValues: Map<string, number> | null } | { scope: ValuedScope };
  /** CAD view: converts the scope's USD flows on their own dates (scope currency CAD). */
  home?: HomeConverter;
  /** Already started by the caller so it runs alongside the flow loading. */
  benchmark: Promise<OverviewSeries["benchmark"]>;
  /** Portfolio scope: Cash accounts left out of returns, read only to pair transfers (cashAccountIds). */
  matchOnlyIds?: string[];
}

/** Accounts in the total but outside returns (Cash, managed portfolios): their legs pair transfers, nothing more. */
export const cashAccountIds = (portfolio: PortfolioPresentation) =>
  portfolio.accounts.filter((a) => a.classification.includedInPortfolioTotal && !countsTowardReturns(a.classification)).map((a) => a.id);

/** Shared core: load the scope's external flows and run computePerformance on a merged value series. */
export async function scopedPerformance(deps: FlowDeps, authSubject: string, input: ScopedPerformanceInput) {
  const qualitiesPromise = deps.activities.qualities(authSubject).catch(() => [] as Quality[]);
  const valued = input.kind === "portfolio" && input.valued
    ? ("scope" in input.valued ? input.valued.scope : valuedScope(input.valued.rows, input.currency, input.from, input.today, input.valued.todayValues, new Set(input.ids)))
    : null;
  const [flows, rawBench, qualities] = await Promise.all([
    loadFlows(deps, authSubject, input.ids, input.kind, input.currency, input.from, input.today, input.deadline, qualitiesPromise, valued, input.home, input.matchOnlyIds),
    input.benchmark,
    qualitiesPromise,
  ]);
  const result = computePerformance({ values: input.values, flows, periodStart: input.from, benchmark: rawBench.points });
  return { result, rawBench, qualities, flows };
}

/**
 * Time-weighted investment return and the benchmark over the same span, for the portfolio scope
 * (included accounts in one currency). Without a flow history the return is withheld rather than
 * presented as a value change.
 */
export async function portfolioReturns(deps: FlowDeps, authSubject: string, input: Omit<ScopedPerformanceInput, "kind">): Promise<{ investmentReturn: Figure; benchmarkReturn: Figure; span: { partial: boolean; since: string | null } | null; flowNotConverted?: string; incomplete?: string[] }> {
  const { result, flows, qualities } = await scopedPerformance(deps, authSubject, { ...input, kind: "portfolio" });
  const { benchmarkReturn } = result.figures;
  // A value step SnapTrade's records don't explain is in the return as gain or loss: an estimate (spec 2026-11-04).
  const unexplained = unrecordedInSpan(qualities, new Set(input.ids), result.span).length > 0;
  const investmentReturn = unexplained && result.figures.investmentReturn.value !== null ? { ...result.figures.investmentReturn, estimated: true } : result.figures.investmentReturn;
  const span = { partial: result.span.partial, since: result.span.since ?? null };
  // Accounts with a gap in their history: the caller reruns without them (spec 2026-10-29-incomplete-history).
  const gapped = result.span.start ? incompleteHistory(flows, result.span, new Set(input.ids)) : [];
  const incomplete = gapped.length ? { incomplete: gapped } : {};
  if (!flows) return { investmentReturn: { value: null, estimated: false, reason: "flows_unavailable" }, benchmarkReturn, span, ...incomplete };
  const unconverted = flows.homeUnconverted?.[0];
  if (unconverted) return { investmentReturn: { value: null, estimated: false, reason: "flow_not_converted" }, benchmarkReturn, span, flowNotConverted: unconverted, ...incomplete };
  return { investmentReturn, benchmarkReturn, span, ...incomplete };
}

export async function buildPerformancePayload(
  deps: PerformanceDeps, portfolio: PortfolioPresentation, authSubject: string,
  input: { period?: PerformancePeriod; accountId?: string; accountType?: AccountType; benchmark?: BenchmarkKey },
): Promise<PerformancePayload> {
  const today = torontoDate.format((deps.now ?? (() => new Date()))());
  const deadline = deps.marketDeadlineMs ?? DEFAULT_MARKET_DEADLINE_MS;
  const period = input.period ?? "YTD";
  const settings = await loadSettings(deps, authSubject);
  const key = input.benchmark ?? settings.benchmark;
  const primary = buildOverviewSummary(portfolio, new Map()).primaryCurrency ?? "CAD";
  // Investment accounts only: Cash and managed portfolios are left out of returns and deposits (countsTowardReturns).
  const included = portfolio.accounts.filter((a) => countsTowardReturns(a.classification));

  // Accounts without a reported value take their currency from stored daily rows.
  let fallbackRows: DailyRow[] | null = null;
  if (included.some((a) => !a.value)) fallbackRows = await deps.dailyValues.rows(authSubject, FALLBACK_START).catch(() => []);
  const known: ScopeAccount[] = [];
  const labelCount = new Map<string, number>();
  for (const a of included) labelCount.set(a.classification.label, (labelCount.get(a.classification.label) ?? 0) + 1);
  const labelSeen = new Map<string, number>();
  for (const a of included) {
    const base = a.classification.label;
    const ordinal = (labelSeen.get(base) ?? 0) + 1;
    labelSeen.set(base, ordinal);
    const label = (labelCount.get(base) ?? 1) > 1 && ordinal > 1 ? `${base} ${ordinal}` : base;
    let currency = a.value?.currency ?? null;
    if (!currency && fallbackRows) {
      const mine = fallbackRows.filter((r) => r.accountId === a.id).sort((x, y) => x.date.localeCompare(y.date));
      currency = mine.at(-1)?.currency ?? null;
    }
    if (currency) known.push({ id: a.id, label, currency, value: a.value?.amount ?? null });
  }

  // accountType resolves to the one account performance can report on (in `known`), then runs exactly as its accountId.
  let accountId = input.accountId;
  let excluded: ExcludedAccount[] = [];
  if (input.accountType !== undefined) {
    const knownIds = new Set(known.map((a) => a.id));
    const resolved = resolveAccountFilter(portfolio, { accountId: input.accountId, accountType: input.accountType }, { eligible: (a) => knownIds.has(a.id), single: true });
    const classes = new Map(portfolio.accounts.map((a) => [a.id, a.classification]));
    // Managed and Cash are named; an account left out only for an unknown currency is not (no copy for it).
    const reasonOf = (id: string): ExcludedAccount["reason"] | null => {
      const c = classes.get(id);
      return !c ? null : isManagedPortfolio(c) ? "managed" : isCashAccount(c) ? "cash" : null;
    };
    if (!resolved.ok) {
      // Accounts of the type exist but none counts toward returns: performance's own managed / Cash copy, not "no connected".
      const reasons = resolved.code === "no_accounts_of_type" ? (resolved.matches ?? []).map((m) => reasonOf(m.id)) : [];
      if (reasons.includes("managed")) throw new PerformanceScopeError("managed_account");
      if (reasons.includes("cash")) throw new PerformanceScopeError("cash_account");
      // Accounts of the type exist but none has a known currency yet: they are connected, so not "no connected".
      if (reasons.length > 0) throw new PerformanceScopeError("no_accounts_of_type", UNKNOWN_OR_EXCLUDED_TEXT);
      throw new PerformanceScopeError(resolved.code, resolved.text);
    }
    accountId = resolved.singleId;
    excluded = resolved.excluded.flatMap((m): ExcludedAccount[] => {
      const reason = reasonOf(m.id);
      return reason ? [{ accountId: m.id, name: m.name, reason }] : [];
    });
  }

  let scopeAccounts: ScopeAccount[];
  let scope: PerformancePayload["scope"];
  if (accountId !== undefined) {
    const one = known.find((a) => a.id === accountId);
    if (!one) {
      const picked = portfolio.accounts.find((a) => a.id === accountId);
      const outside = picked && picked.classification.includedInPortfolioTotal && !countsTowardReturns(picked.classification);
      throw new PerformanceScopeError(!outside ? "unknown_account" : isManagedPortfolio(picked.classification) ? "managed_account" : "cash_account");
    }
    scopeAccounts = [one];
    scope = { kind: "account", accountId: one.id, label: one.label, currency: one.currency };
  } else if (settings.cadView && known.some((a) => a.currency === "USD")) {
    // CAD view: CAD and USD accounts in one CAD series; other currencies are not converted.
    scopeAccounts = known.filter((a) => HOME_SCOPE.includes(a.currency));
    scope = { kind: "portfolio", label: "All accounts", currency: primary };
  } else {
    scopeAccounts = known.filter((a) => a.currency === primary);
    scope = { kind: "portfolio", label: "All accounts", currency: primary };
  }
  let homeMode = settings.cadView && scopeAccounts.some((a) => a.currency === "USD");
  const nativeCurrency = scope.currency;
  let ids = scopeAccounts.map((a) => a.id);
  let idSet = new Set(ids);
  const loadRows = (from: string) => fallbackRows ? Promise.resolve(fallbackRows.filter((r) => r.date >= from)) : deps.dailyValues.rows(authSubject, from).catch(() => [] as DailyRow[]);
  let allValued = scopeAccounts.length > 0 && scopeAccounts.every((a) => a.value !== null);

  /** One scope run: in its own currency (native) or combined in CAD (home). */
  async function run(mode: "native" | "home") {
    const currencies = mode === "home" ? HOME_SCOPE : [nativeCurrency];
    const earliests = await Promise.all(currencies.map((c) => deps.dailyValues.earliest(authSubject, c).catch(() => null)));
    const earliest = earliests.filter((e): e is string => !!e).sort()[0] ?? null;
    const fetchFrom = startOf(period, today, earliest);
    const rows = (await loadRows(fetchFrom)).filter((r) => idSet.has(r.accountId) && currencies.includes(r.currency));
    // ALL begins at the first stored row of the scope itself, not of excluded accounts.
    const scopedEarliest = rows.length > 0 ? rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date) : earliest;
    const from = period === "ALL" ? (scopedEarliest && scopedEarliest <= today ? scopedEarliest : FALLBACK_START) : fetchFrom;
    let values: SeriesPoint[];
    let valued: ScopedPerformanceInput["valued"];
    let conv: HomeConverter | undefined;
    let home: HomeSeries | null = null;
    if (mode === "native") {
      const todayValue = allValued ? scopeAccounts.reduce((s, a) => s + a.value!, 0) : null;
      values = mergeDailyPoints(rows, nativeCurrency, from, today, todayValue);
      valued = { rows, todayValues: todayValue === null ? null : new Map(scopeAccounts.map((a) => [a.id, a.value!])) };
    } else {
      conv = await homeConverterFor(deps.market, from, today, deadline);
      home = homeDailySeries(rows, conv, from, today, allValued ? new Map(scopeAccounts.map((a) => [a.id, { amount: a.value!, currency: a.currency }])) : null, idSet);
      values = home.complete;
      valued = { scope: home.valued };
    }
    const currency = mode === "home" ? HOME_CURRENCY : nativeCurrency;
    const scoped = await scopedPerformance(deps, authSubject, {
      ids, kind: scope.kind, currency, from, today, values, deadline, valued, home: conv,
      ...(scope.kind === "portfolio" ? { matchOnlyIds: cashAccountIds(portfolio) } : {}),
      // The benchmark is the index's own return in the scope currency, as for any CAD scope.
      benchmark: withDeadline(() => benchmarkSeries(deps.market, key, benchmarkFetchFrom(from), today, currency), deadline, () => unavailable(key)),
    });
    return { ...scoped, currency, currencies, earliest, scopedEarliest, home };
  }

  const scopeAsChosen = { ...scope };
  /** Runs the scope as it stands (native, or the CAD view with its not-converted fallback). */
  async function resolve() {
    let main = await run(homeMode ? "home" : "native");
    let home: PerformanceHome | undefined;
    if (homeMode) {
      const series = main.home!;
      // No USD value converted at all (e.g. the BoC fetch failed): the not-converted rule, in the scope's own
      // currency with USD accounts shown separately, never silently dropped from a CAD total.
      const converted = series.estimated;
      const native = scope.kind === "account" || !converted ? await run("native") : null;
      if (!converted) main = native!;
      else scope = { ...scope, currency: HOME_CURRENCY };
      const nativeFigures = scope.kind === "account" && converted && native
        ? { currency: nativeCurrency, value: native.result.series.value.at(-1)?.value ?? null, valueChange: native.result.figures.valueChange, netDeposits: native.result.figures.netDeposits, marketGain: native.result.figures.marketGain }
        : null;
      const flowNotConverted = converted ? main.flows?.homeUnconverted?.[0] ?? null : null;
      // No USD value at all (no rows, no reported value): nothing was converted or left out; as with the view off.
      home = !converted && series.notConvertedAccounts.length === 0 ? undefined : {
        currency: HOME_CURRENCY, converted, estimated: converted, notConvertedDays: series.notConvertedDays,
        notConvertedAccounts: series.notConvertedAccounts.length, flowNotConverted, native: nativeFigures,
      };
    }
    return { main, home };
  }
  let { main, home } = await resolve();
  // Accounts with a gap in their value history during the period (spec 2026-10-29-incomplete-history): their deposits
  // would be dropped from put in, so they leave this period's figures entirely and are named, without amounts. Removing
  // one can move the span's start, so the check repeats until no more are found. Only accounts in the run's own
  // currencies are checked: a not-converted fallback run has no rows for the USD accounts it lists separately.
  const gapped = new Set<string>();
  while (scope.kind === "portfolio") {
    const eligible = new Set(scopeAccounts.filter((a) => main.currencies.includes(a.currency)).map((a) => a.id));
    const found = incompleteHistory(main.flows, main.result.span, eligible).filter((id) => !gapped.has(id));
    if (found.length === 0) break;
    for (const id of found) gapped.add(id);
    scopeAccounts = scopeAccounts.filter((a) => !gapped.has(a.id));
    ids = scopeAccounts.map((a) => a.id);
    idSet = new Set(ids);
    allValued = scopeAccounts.length > 0 && scopeAccounts.every((a) => a.value !== null);
    homeMode = settings.cadView && scopeAccounts.some((a) => a.currency === "USD");
    scope = { ...scopeAsChosen };
    ({ main, home } = await resolve());
  }
  const named = (a: PortfolioPresentation["accounts"][number], reason: NotInFigures["reason"]): NotInFigures =>
    ({ accountId: a.id, label: known.find((k) => k.id === a.id)?.label ?? a.classification.label, name: a.name ?? "", reason });
  const notInFigures: NotInFigures[] = [
    ...portfolio.accounts.filter((a) => a.classification.includedInPortfolioTotal && isManagedPortfolio(a.classification)).map((a) => named(a, "managed")),
    ...portfolio.accounts.filter((a) => gapped.has(a.id)).map((a) => named(a, "history_gaps")),
  ];
  const { result: raw, rawBench, qualities } = main;
  const unrecorded: UnrecordedInFigures[] = unrecordedInSpan(qualities, idSet, raw.span).map((e) => {
    const account = portfolio.accounts.find((a) => a.id === e.accountId);
    const k = known.find((a) => a.id === e.accountId);
    return { accountId: e.accountId, label: k?.label ?? account?.classification.label ?? "Account", name: account?.name ?? "", date: e.date, amount: e.amount, currency: k?.currency ?? scope.currency };
  });
  const marked = home?.estimated || unrecorded.length > 0 ? markEstimated(raw) : raw;
  const result = home?.flowNotConverted ? withholdReturns(marked) : marked;
  const scopeCurrency = main.currency;
  const otherCurrencies = [...new Set(known.map((a) => a.currency).filter((c) => (home?.converted ? !HOME_SCOPE.includes(c) : c !== scopeCurrency)))].sort();
  const benchmarkInfo = {
    key, name: BENCHMARKS[key].name, label: BENCHMARKS[key].label, explainer: BENCHMARKS[key].explainer, basis: BENCHMARKS[key].basis,
    note: rawBench.points ? comparisonNote(scopeCurrency, key) : null,
    unavailableReason: rawBench.points ? null : rawBench.unavailableReason ?? "Benchmark data unavailable",
  };
  return {
    scope,
    // F3 (spec §2): every included account with a known currency, in every scope.
    accounts: known.map(({ id, label, currency }) => ({ id, label, currency })),
    period, span: result.span, series: displaySeries(result), figures: result.figures, monthly: result.monthly,
    benchmark: benchmarkInfo,
    benchmarks: BENCHMARK_KEYS.map((k) => ({ key: k, name: BENCHMARKS[k].name, explainer: BENCHMARKS[k].explainer })),
    settings,
    history: {
      qualities: qualities.filter((q) => idSet.has(q.accountId)).map((q) => ({ accountId: q.accountId, method: q.method, reason: q.reason, driftFraction: q.driftFraction })),
      earliest: period === "ALL" ? main.scopedEarliest : main.earliest,
    },
    otherCurrencies,
    asOf: portfolio.generatedAt,
    home: home ?? null,
    deposits: result.deposits && result.figures.netDeposits.value !== null ? {
      putIn: cents(result.deposits.putIn),
      takenOut: cents(result.deposits.takenOut),
      estimated: result.figures.netDeposits.estimated,
      byAccount: result.deposits.byAccount.map((r) => {
        const account = portfolio.accounts.find((a) => a.id === r.accountId);
        return {
          accountId: r.accountId, label: known.find((a) => a.id === r.accountId)?.label ?? "Account",
          name: account?.name ?? "", bucket: account?.classification.bucket ?? "other",
          value: account?.value ? { amount: account.value.amount, currency: account.value.currency } : null,
          putIn: cents(r.putIn), takenOut: cents(r.takenOut),
        };
      }),
      leftOut: portfolio.accounts.filter((a) => a.classification.includedInPortfolioTotal && isCashAccount(a.classification)).map((a) => a.classification.label),
    } : null,
    notInFigures,
    ...(excluded.length > 0 ? { excluded } : {}),
    unrecorded,
  };
}

/** One sentence per value step SnapTrade's records don't explain (spec 2026-11-04-unrecorded-flow-check). */
export function unrecordedText(all: readonly UnrecordedInFigures[]): string {
  return all.map((e) => {
    const about = `about ${Math.abs(e.amount).toLocaleString("en-CA", { maximumFractionDigits: 0 })} ${e.currency} on ${shortDay(e.date)}`;
    return e.amount > 0
      ? `${e.label}'s value rose by ${about} with no deposit in SnapTrade's records: if you added money then, SnapTrade hasn't reported it, so these figures count it as investment gain.`
      : `${e.label}'s value fell by ${about} with no withdrawal in SnapTrade's records: if money left then, or a recorded deposit never arrived, these figures count it as an investment loss.`;
  }).join(" ");
}

/** The chat sentences for accounts of the asked type left out of a one-account answer: names only. */
function excludedText(excluded: readonly ExcludedAccount[] | undefined): string {
  return (excluded ?? []).map((a) => a.reason === "managed"
    ? `${a.name} isn't included: SnapTrade doesn't provide its history.`
    : `${a.name} is a Cash account and isn't in returns.`).join(" ");
}

/**
 * The chat line for accounts left out of the figures: names and reasons, never amounts. `named`: account ids a scoped
 * sentence already names (excludedText, under accountType), left out here so no account is named twice.
 */
export function notInFiguresText(all: readonly NotInFigures[], named: ReadonlySet<string> = new Set()): string {
  const left = all.filter((a) => !named.has(a.accountId));
  if (left.length === 0) return "";
  const managed = [...new Set(left.filter((a) => a.reason === "managed").map((a) => a.label))];
  const gaps = [...new Set(left.filter((a) => a.reason === "history_gaps").map((a) => a.label))];
  return " Only accounts whose numbers SnapTrade provides in full are counted."
    + (managed.length ? ` Left out: ${managed.join(", ")} (managed; SnapTrade doesn't provide its holdings history).` : "")
    + (gaps.length ? ` Left out for this period: ${gaps.join(", ")} (gaps in its value history).` : "");
}

/**
 * A USD deposit or withdrawal in the span could not be converted (no rate within 7 days): every flow-based
 * figure for the span is withheld rather than converted at a guessed rate; the values chart stays.
 */
function withholdReturns(result: PerformanceResult): PerformanceResult {
  const none = { value: null, estimated: false, reason: "flow_not_converted" as const };
  const f = result.figures;
  return {
    ...result,
    figures: {
      ...f,
      personalReturn: { ...none, annualised: false }, matchedBenchmarkReturn: { ...none, annualised: false }, matchedBenchmarkValue: none,
      investmentReturn: none, investmentCagr: none, netDeposits: none, marketGain: none,
      accountsAddedToTracking: none, maxDrawdown: none, volatility: none, bestMonth: none, worstMonth: none,
    },
    monthly: [],
    series: { ...result.series, netDeposits: [], twrIndex: [] },
    deposits: null,
  };
}

/** Currencies the CAD view combines (only USD converts; CAD is exact). */
const HOME_SCOPE = [HOME_CURRENCY, "USD"];

/** CAD values converted from USD: every figure except the index's own return is an estimate. */
function markEstimated(result: PerformanceResult): PerformanceResult {
  const mark = <T extends Figure>(f: T): T => (f.value === null ? f : { ...f, estimated: true });
  const f = result.figures;
  return {
    ...result,
    figures: {
      ...f,
      personalReturn: mark(f.personalReturn), matchedBenchmarkReturn: mark(f.matchedBenchmarkReturn), matchedBenchmarkValue: mark(f.matchedBenchmarkValue), investmentReturn: mark(f.investmentReturn), investmentCagr: mark(f.investmentCagr), valueChange: mark(f.valueChange),
      netDeposits: mark(f.netDeposits), marketGain: mark(f.marketGain), maxDrawdown: mark(f.maxDrawdown), volatility: mark(f.volatility),
      bestMonth: mark(f.bestMonth), worstMonth: mark(f.worstMonth),
      accountsAddedToTracking: mark(f.accountsAddedToTracking),
    },
    monthly: result.monthly.map((m) => (m.return === null ? m : { ...m, estimated: true })),
  };
}

/** F5: display series at most this many points; figures always come from the full series. */
export const MAX_SERIES_POINTS = 400;
const cents = (n: number) => Math.round(n * 100) / 100;
const sixDp = (n: number) => Math.round(n * 1e6) / 1e6;

/** Evenly spaced picks of `items`, at most `n`, including the first and last. */
function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  if (n <= 0) return [];
  if (n === 1) return [items[items.length - 1]];
  return Array.from({ length: n }, (_, k) => items[Math.round((k * (items.length - 1)) / (n - 1))]);
}

/**
 * Display series for the payload (F5). Spans longer than MAX_SERIES_POINTS keep the first and
 * last points, every month-end, the drawdown peak and trough, then flow dates, then evenly
 * spaced points up to the limit; value, net deposits and the index share those dates. The
 * benchmark keeps its first and last points plus evenly spaced ones. Money is rounded to cents
 * and index levels to 6 dp.
 */
export function displaySeries(result: PerformanceResult): PerformanceResult["series"] {
  const { series, figures } = result;
  const dates = series.value.map((p) => p.date);
  let keep: Set<string> | null = null;
  if (dates.length > MAX_SERIES_POINTS) {
    keep = new Set([dates[0], dates[dates.length - 1]]);
    dates.forEach((d, i) => { if (i + 1 < dates.length && dates[i + 1].slice(0, 7) !== d.slice(0, 7)) keep!.add(d); });
    for (const d of [figures.maxDrawdown.peak, figures.maxDrawdown.trough]) if (d) keep.add(d);
    const flowDates = series.netDeposits.filter((p, i) => i > 0 && p.value !== series.netDeposits[i - 1].value).map((p) => p.date).filter((d) => !keep!.has(d));
    for (const d of spread(flowDates, MAX_SERIES_POINTS - keep.size)) keep.add(d);
    // Source changes (e.g. estimated stretches) survive so notes and chart styling stay true.
    const sourceEdges = series.value.filter((p, i) => i > 0 && p.source !== series.value[i - 1].source).map((p) => p.date).filter((d) => !keep!.has(d));
    for (const d of spread(sourceEdges, MAX_SERIES_POINTS - keep.size)) keep.add(d);
    const rest = dates.filter((d) => !keep!.has(d));
    for (const d of spread(rest, MAX_SERIES_POINTS - keep.size)) keep.add(d);
  }
  const kept = <T extends { date: string }>(points: T[]) => (keep ? points.filter((p) => keep!.has(p.date)) : points);
  const bench = series.benchmarkIndex.length > MAX_SERIES_POINTS
    ? [series.benchmarkIndex[0], ...spread(series.benchmarkIndex.slice(1, -1), MAX_SERIES_POINTS - 2), series.benchmarkIndex[series.benchmarkIndex.length - 1]]
    : series.benchmarkIndex;
  return {
    value: kept(series.value).map((p) => ({ ...p, value: cents(p.value) })),
    netDeposits: kept(series.netDeposits).map((p) => ({ ...p, value: cents(p.value) })),
    twrIndex: kept(series.twrIndex).map((p) => ({ ...p, value: sixDp(p.value) })),
    benchmarkIndex: bench.map((p) => ({ ...p, value: sixDp(p.value) })),
    riskMergedDates: series.riskMergedDates,
  };
}

/** F5: what the model reads as JSON alongside the text line; the series stay in structuredContent only. */
export function performanceModelCopy(payload: PerformancePayload) {
  return {
    scope: payload.scope, span: payload.span, figures: payload.figures, monthly: payload.monthly,
    benchmark: { key: payload.benchmark.key, name: payload.benchmark.name, basis: payload.benchmark.basis }, otherCurrencies: payload.otherCurrencies,
    ...(payload.home ? { home: payload.home, ...(payload.home.converted ? { note: CAD_NOTE } : {}) } : {}),
  };
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const shortDay = (iso: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
const shortDate = (iso: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

/** The same money in the index: the comparison for "your return" (money-weighted on both sides). */
function matchedText(payload: PerformancePayload, pct: (f: Figure) => string): string {
  const m = payload.figures.matchedBenchmarkReturn;
  if (!m) return "";
  const name = `${payload.benchmark.name} (${payload.benchmark.basis})`;
  if (m.exhausted) return `; the same money in the ${name} can't be put as a number: withdrawals took more than that index holding had`;
  if (m.value === null) return "";
  const annual = m.annualised ? " annualised" : "";
  const worth = payload.figures.matchedBenchmarkValue?.value;
  const value = worth == null ? "" : `, worth ${worth.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${payload.scope.currency}${payload.figures.matchedBenchmarkValue.estimated ? " (est.)" : ""} at the end`;
  return ` vs ${pct(m)}${annual} had every dollar (your starting value and each deposit and withdrawal) gone into the ${name} on the same day${value}`;
}

export function performanceText(payload: PerformancePayload, options: { show?: boolean } = {}): string {
  const { figures, span, scope } = payload;
  const reason = (r?: string) => (r ?? "unavailable").replace(/_/g, " ");
  type F = { value: number | null; estimated?: boolean; reason?: string };
  const est = (f: F) => (f.value !== null && f.estimated ? " (est.)" : "");
  const pct = (f: F) => f.value === null ? `n/a (${reason(f.reason)})` : `${f.value < 0 ? "-" : "+"}${(Math.abs(f.value) * 100).toFixed(1)}%${est(f)}`;
  const money = (f: F) => f.value === null ? `n/a (${reason(f.reason)})`
    : `${f.value < 0 ? "-" : "+"}${Math.abs(f.value).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${scope.currency}${est(f)}`;
  const added = figures.accountsAddedToTracking;
  // Accounts entering or leaving the series, and moves to them, are never deposits (brief 9).
  const amount = (v: number, signed = true) => `${signed ? (v < 0 ? "-" : "+") : ""}${Math.abs(v).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${scope.currency}`;
  const trackingText = () => {
    if (!added || added.value === null) return "";
    const joined = added.joined ?? 0, left = added.left ?? 0, moved = added.movedFromTracked ?? 0;
    const tag = added.estimated ? " (est.)" : "";
    const out: string[] = [];
    if (joined !== 0) out.push(`; accounts added to tracking ${amount(joined)}${moved < 0 ? ` (${amount(moved, false)} of it moved from your other accounts; not deposits)` : " (not deposits)"}${tag}`);
    if (moved > 0 || (moved < 0 && joined === 0)) out.push(`; ${amount(moved, false)} moved ${moved > 0 ? "in from" : "out to"} accounts not tracked then (not ${moved > 0 ? "deposits" : "withdrawals"})`);
    if (left !== 0) out.push(`; accounts no longer tracked ${amount(left)} (not withdrawals)${tag}`);
    return out.join("");
  };
  const head = span.partial && span.since ? `${payload.period} since ${shortDate(span.since)}` : payload.period;
  const annual = figures.personalReturn.annualised && figures.personalReturn.value !== null ? " annualised" : "";
  const estimated = Object.values(figures).some((f) => (f as { estimated?: boolean }).estimated);
  const parts = [
    `${head} (${scope.label}, ${scope.currency}): your return ${pct(figures.personalReturn)}${annual} (money-weighted)`,
    matchedText(payload, pct),
    `, investment return ${pct(figures.investmentReturn)} vs ${payload.benchmark.name} (${payload.benchmark.basis}) ${pct(figures.benchmarkReturn)}`,
    payload.deposits
      ? `; put in ${money({ value: payload.deposits.putIn, estimated: payload.deposits.estimated })}, taken out ${money({ value: payload.deposits.takenOut, estimated: payload.deposits.estimated })}, net deposits ${money(figures.netDeposits)} after the first day in these figures (money already in by then is the starting value, not put in)`
      : `; net deposits ${money(figures.netDeposits)}`,
    trackingText(),
    `; market gain ${money(figures.marketGain)}.`,
    payload.deposits?.leftOut.length
      ? ` Investment accounts only: ${[...new Set(payload.deposits.leftOut)].join(", ")} is left out, so money moved from it into these accounts counts as put in.`
      : "",
    notInFiguresText(payload.notInFigures, new Set((payload.excluded ?? []).map((a) => a.accountId))),
  ].join("");
  const cagr = figures.investmentCagr;
  const yearly = !YEARLY_PERIODS.includes(payload.period) || !cagr ? ""
    : cagr.value !== null
      ? `Per year since ${shortDate(span.start)} (${(cagr.years ?? 0).toFixed(1)} years): your investments ${pct(cagr)} a year (time-weighted, deposits excluded)`
        + (figures.benchmarkCagr?.value != null ? ` against the ${payload.benchmark.name}'s ${pct(figures.benchmarkCagr)} a year.` : ".")
      : cagr.reason === "under_a_year" ? "Under a year of history, so no yearly rate yet." : "";
  const home = payload.home;
  const nativeFigures = home?.native;
  const nativeMoney = (f: F, currency: string) => f.value === null ? `n/a (${reason(f.reason)})`
    : `${f.value < 0 ? "-" : "+"}${Math.abs(f.value).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  const homeText = !home ? []
    : home.converted
      ? [
        CAD_NOTE,
        home.estimated ? "Returns are computed on CAD values (est.); the benchmark is the index's own return." : "",
        nativeFigures ? `In ${nativeFigures.currency}: net deposits ${nativeMoney(nativeFigures.netDeposits, nativeFigures.currency)}; market gain ${nativeMoney(nativeFigures.marketGain, nativeFigures.currency)}.` : "",
        home.flowNotConverted ? `Return unavailable: a USD deposit or withdrawal on ${shortDay(home.flowNotConverted)} could not be converted.` : "",
        home.notConvertedDays > 0 ? `${count(home.notConvertedDays, "day")} not converted (no recent Bank of Canada rate); those days are left out.` : "",
        home.notConvertedAccounts > 0 ? `${count(home.notConvertedAccounts, "account")} not converted (no recent Bank of Canada rate); left out of the CAD figures.` : "",
      ]
      : [scope.kind === "account"
        ? "Not converted (no recent Bank of Canada rate): figures are in the account's own currency."
        : `Not converted (no recent Bank of Canada rate): ${count(home.notConvertedAccounts, "USD account")} ${home.notConvertedAccounts === 1 ? "is shown separately in its own currency" : "are shown separately in their own currency"}.`];
  return [parts, yearly, estimated ? "Includes estimated values." : "", unrecordedText(payload.unrecorded ?? []), ...homeText, excludedText(payload.excluded), options.show ? "Showing the performance widget." : ""].filter(Boolean).join(" ");
}

const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const security = [{ type: "oauth2" as const, scopes: ["portfolio:read"] }];
const properties = {
  period: { type: "string", enum: [...PERFORMANCE_PERIODS] },
  ...accountFilterProperties,
  benchmark: { type: "string", enum: [...BENCHMARK_KEYS] },
} as const;
const description = (lead: string, filters = "") => `${lead} Shows returns net of deposits (money-weighted and time-weighted), net deposits vs market gain, risk and monthly returns against a benchmark, for all accounts or one account. With the CAD view on (the default), CAD and USD accounts combine in CAD (USD converted at the Bank of Canada rate, est.).${filters} Read-only.`;

const outputSchema = {
  type: "object",
  properties: {
    scope: { type: "object" }, accounts: { type: "array" }, period: { type: "string" }, span: { type: "object" }, series: { type: "object" },
    figures: { type: "object" }, monthly: { type: "array" }, benchmark: { type: "object" }, benchmarks: { type: "array" }, settings: { type: "object" },
    history: { type: "object" }, otherCurrencies: { type: "array" }, asOf: { type: "string" }, home: { type: ["object", "null"] },
  },
  required: ["scope", "accounts", "period", "span", "series", "figures", "monthly", "benchmark", "benchmarks", "settings", "history", "otherCurrencies", "asOf", "home"],
  additionalProperties: false,
} as const;

export const performanceToolDefinitions = [
  {
    name: "show_performance",
    title: "Show performance",
    description: description("Use this when the user asks to see their portfolio performance, returns, gains, drawdown or how they did over a period: it renders the interactive performance widget and returns the figures as text, so it also answers follow-up questions.", " Filter with accountType (for example rrsp) or accountId."),
    inputSchema: { type: "object", properties, additionalProperties: false },
    outputSchema,
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    _meta: {
      securitySchemes: security, ui: { resourceUri: PERFORMANCE_WIDGET_URI }, "openai/outputTemplate": PERFORMANCE_WIDGET_URI,
      "openai/widgetAccessible": true, "openai/toolInvocation/invoking": "Loading performance…", "openai/toolInvocation/invoked": "Performance ready.",
    },
  },
  {
    name: "get_performance",
    title: "Get performance",
    description: description("Used by the performance widget to switch account, period or benchmark."),
    inputSchema: { type: "object", properties, required: ["period"], additionalProperties: false },
    outputSchema,
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    // App-only, like get_overview_series: the model always uses show_performance so a widget renders.
    _meta: { securitySchemes: security, ui: { visibility: ["app"] } },
  },
] as const;
