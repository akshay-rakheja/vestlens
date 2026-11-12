import { isInvestable } from "../analytics/holdings.js";
import { benchmarkClosesCad, type BenchmarkClose } from "../analytics/shadow-benchmark.js";
import { benchmarkFetchFrom } from "../analytics/value-series.js";
import { homeConverter, loadHomeConverter, type HomeConverter } from "../fx/home-currency.js";
import type { GoalPrismaPort } from "../goals/goal-loader.js";
import type { StoredActivity } from "../history/stored-activity.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import { withDeadline } from "../mcp/overview-tools.js";
import { providerTicker } from "../market-data/ticker-map.js";
import type { PortfolioFactsSource } from "../memory/portfolio-facts.js";
import type { PortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import { torontoDay } from "../portfolio/data-freshness.js";
import { checkHolding } from "../theses/thesis-check.js";
import { loadHoldingView, toStoredActivity, type ThesisLoaderDeps, type ThesisPrismaPort } from "../theses/thesis-loader.js";
import {
  afterSoldSection, boughtSymbols, buysBeforeSales, callsSection, convertedSymbols, isConverted, REPORT_CONCURRENCY, soldSymbols, TIMED_OUT,
  tradingCostSection, type AfterSoldSection, type CallOutcome, type CallsSection, type HistoryEntry, type TradingCostSection,
} from "./report-card.js";
import type { OverallSection } from "./report-overall.js";

/**
 * Reads the report card's inputs for one auth subject: the latest stored portfolio, the subject's stored activity in
 * included, open, non-credit accounts, each bought symbol's holding view (the show_thesis engine), cached closes for
 * sold and converted symbols, and the Bank of Canada series. No brokerage read; every query is keyed by the subject.
 *
 * Page-load cost: one Bank of Canada series and one S&P 500 / TSX range, from the earliest stored activity, are read
 * once and passed to every holding view. Each phase has a deadline (calls, then price histories); symbols not finished
 * by it are counted "couldn't read in time". Overall starts at the same time as the other phases.
 */

export const CALLS_DEADLINE_MS = 20_000;
export const HISTORIES_DEADLINE_MS = 15_000;

export interface ReportCardDeps {
  /** The fact tools' stored-data port: the per-symbol holding queries and the all-activity query. */
  prisma: ThesisPrismaPort & Pick<GoalPrismaPort, "activity">;
  market: Pick<MarketDataService, "history" | "usdCad"> & Partial<Pick<MarketDataService, "securityHistory">>;
  memory: PortfolioFactsSource;
  /** The latest stored portfolio; never a brokerage refresh. Read once per report. */
  portfolio: (authSubject: string) => Promise<PortfolioPresentation>;
  /** This year's portfolio return against the S&P 500 from the performance engine, when it has one. */
  overall?: (authSubject: string, portfolio: PortfolioPresentation) => Promise<OverallSection | null>;
  concurrency?: number;
  deadlines?: { callsMs?: number; historiesMs?: number };
}

export interface ReportCard {
  /** Toronto date the report was worked out. */
  asOf: string;
  /** The earliest stored activity date it reads; null with none. */
  activityFrom: string | null;
  calls: CallsSection;
  afterSold: AfterSoldSection;
  tradingCost: TradingCostSection;
  overall: OverallSection | null;
}

/** The holding view needs no news here. */
const NO_NEWS = { articlesForSymbols: async () => [], ratingsFor: async () => [], events: async () => [] };
const dateOf = (a: StoredActivity) => a.tradeDate ?? a.settlementDate;
const minusDays = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
const monthStart = (day: string) => `${day.slice(0, 8)}01`;
const upper = (s: string) => s.trim().toUpperCase();

/**
 * Runs `work` over `items`, at most `limit` at a time, after `before` settles, until `ms` passes. Returns the results
 * that finished in time; an item missing from the map didn't. `work` must not throw.
 */
export async function pooledWithin<T, R>(items: T[], limit: number, ms: number, work: (item: T) => Promise<R>, before: Promise<unknown> = Promise.resolve()): Promise<Map<T, R>> {
  const out = new Map<T, R>();
  let open = true;
  let next = 0;
  const run = async () => {
    await before;
    const worker = async () => {
      while (open && next < items.length) {
        const item = items[next++]!;
        const r = await work(item);
        if (open) out.set(item, r);
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([run().catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
  open = false;
  return out;
}

async function benchmarkSeries(market: ReportCardDeps["market"], key: "sp500" | "tsx", from: string, today: string, fx: HomeConverter): Promise<BenchmarkClose[] | null> {
  try {
    const r = await benchmarkClosesCad(market, key, from, today, fx);
    return r.points.length > 0 ? r.points : null;
  } catch {
    return null;
  }
}

export async function loadReportCard(deps: ReportCardDeps, subject: string, now: Date): Promise<ReportCard> {
  const today = torontoDay(now);
  const limit = deps.concurrency ?? REPORT_CONCURRENCY;
  const callsMs = deps.deadlines?.callsMs ?? CALLS_DEADLINE_MS;
  const historiesMs = deps.deadlines?.historiesMs ?? HISTORIES_DEADLINE_MS;
  const portfolio = await deps.portfolio(subject);
  // Overall runs alongside everything below.
  const overallPromise = deps.overall ? deps.overall(subject, portfolio).catch(() => null) : Promise.resolve(null);

  const ids = portfolio.accounts.filter(isInvestable).map((a) => a.id);
  const idSet = new Set(ids);
  const activityRows = ids.length === 0 ? [] : await deps.prisma.activity.findMany({
    where: { appUser: { authSubject: subject }, snapTradeAccountId: { in: ids } },
    orderBy: [{ tradeDate: "asc" }, { dedupeKey: "asc" }],
    select: {
      snapTradeAccountId: true, dedupeKey: true, type: true, symbol: true, securityCurrency: true, isOption: true, units: true, price: true,
      amount: true, fee: true, fxRate: true, currency: true, tradeDate: true, settlementDate: true,
    },
  });
  const rows = activityRows.map(toStoredActivity).filter((a) => idSet.has(a.snapTradeAccountId) && !a.isOption);
  const activityFrom = rows.map(dateOf).filter((d): d is string => d !== null).sort()[0] ?? null;

  // One Bank of Canada series and one range of each index, from the month of the earliest activity (the holding
  // views snap their own reads the same way), shared by every holding view and the other sections.
  const seriesFrom = monthStart(activityFrom ?? today);
  const fxPromise = loadHomeConverter(deps.market, benchmarkFetchFrom(seriesFrom), today);
  const sharedPromise: Promise<NonNullable<ThesisLoaderDeps["shared"]>> = fxPromise.then(async (fx) => {
    const [sp500, tsx] = await Promise.all([benchmarkSeries(deps.market, "sp500", seriesFrom, today, fx), benchmarkSeries(deps.market, "tsx", seriesFrom, today, fx)]);
    return { fx, benchmarks: { sp500, tsx } };
  });

  // Calls: the holding view of each bought symbol, from the portfolio and series read above.
  const bought = boughtSymbols(rows);
  let shared: NonNullable<ThesisLoaderDeps["shared"]> | null = null;
  const callsPromise = pooledWithin(bought.symbols, limit, callsMs, async (symbol): Promise<CallOutcome> => {
    try {
      const view = await loadHoldingView({ memory: deps.memory, portfolio: async () => portfolio, prisma: deps.prisma, market: deps.market, news: NO_NEWS, shared: shared! }, subject, symbol, now);
      if (!view.holding) return { symbol, check: null };
      return { symbol, check: checkHolding(view.holding, now).sinceFirstBought, buysBeforeSales: buysBeforeSales(view.holding.flows) };
    } catch {
      return { symbol, failed: true };
    }
  }, sharedPromise.then((s) => { shared = s; }));

  // Price histories: one split-aware series per sold or converted symbol, from just before its first such row.
  const sold = soldSymbols(rows);
  const converted = convertedSymbols(rows);
  const historySymbols = [...new Set([...sold.symbols, ...converted.symbols])];
  const securityHistory = deps.market.securityHistory?.bind(deps.market);
  const historiesPromise = pooledWithin(historySymbols, limit, historiesMs, async (symbol): Promise<HistoryEntry> => {
    const mine = rows.filter((a) => a.symbol && upper(a.symbol) === symbol && (a.type.toUpperCase() === "SELL" || isConverted(a)));
    const first = mine.map(dateOf).filter((d): d is string => d !== null).sort()[0];
    const currency = mine.map((a) => a.securityCurrency ?? a.currency).find((c): c is string => !!c) ?? null;
    const ticker = providerTicker({ symbol, kind: "stock", currency });
    if (!first || !ticker || !securityHistory) return null;
    return securityHistory(ticker, minusDays(first, 10), today).catch(() => null);
  });

  const [callResults, historyResults] = await Promise.all([callsPromise, historiesPromise]);
  const outcomes: CallOutcome[] = bought.symbols.map((symbol) => callResults.get(symbol) ?? { symbol, timedOut: true });
  const histories = new Map<string, HistoryEntry>(historySymbols.map((s) => [s, historyResults.has(s) ? historyResults.get(s)! : TIMED_OUT]));
  // Already settled for the calls; on its own a Bank of Canada read is cached and bounded by the market service.
  const fx: HomeConverter = await withDeadline(() => fxPromise, historiesMs, () => homeConverter(null, today));

  return {
    asOf: today,
    activityFrom,
    calls: callsSection(outcomes, bought.overCap),
    afterSold: afterSoldSection(rows, histories, fx, today, new Set(sold.overCap)),
    tradingCost: tradingCostSection(rows, fx, histories, new Set(converted.overCap)),
    overall: await overallPromise,
  };
}
