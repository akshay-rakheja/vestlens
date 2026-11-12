import { symbolPosition } from "../activity/symbol-position.js";
import { tradePriceConverter } from "../activity/trade-price.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import type { PricePoint, SecurityHistory } from "../market-data/types.js";
import { isTrustedPriceKind, priceOutOfRange, providerTicker } from "../market-data/ticker-map.js";
import { buildPortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import type { PortfolioQueryResult } from "../portfolio/portfolio-query-service.js";
import type { ActivityStore } from "./activity-store.js";
import { providerMetadataProbe } from "./provider-probe.js";
import { classifyAccount, replay } from "./replay.js";
import { unitsDelta } from "./sign-rules.js";
import type { StoredActivity } from "./stored-activity.js";
import { findUnrecordedFlows } from "./unrecorded-flows.js";
import { inferCurrency, valueAccount } from "./valuation.js";

const DERIVED = ["reconstructed", "estimated"];
/** Rebuilt history further than this from the brokerage total is not shown: snapshots only. */
export const DRIFT_FALLBACK = 0.10;
/**
 * A cash account's gap accumulates over time, so a constant opening-cash anchor above this share of
 * the reported total is not a credible opening balance: the account stays snapshots only.
 */
export const CASH_ACCOUNT_ANCHOR_MAX = 0.10;
/** An opening cash anchor above this share of the reported total labels every day estimated (`opening_cash`). */
export const ANCHOR_LABEL_MIN = 0.02;
const MAX_UNIT_RATIOS = 20;
const MAX_PRICE_CHECKS = 20;
const MAX_TRADE_PRICE_GROUPS = 10;
/** A close or FX rate older than this many days before the trade is not used for a trade-price ratio. */
const TRADE_PRICE_MAX_STALE_DAYS = 7;
const TRADE_PRICE_NEAR = 0.03;
/** Overall budget for one account's trade-price check; on timeout it is empty. */
export const TRADE_PRICE_BUDGET_MS = 10_000;
const TRADE_PRICE_CONCURRENCY = 4;

export interface ReconstructedValuePort {
  dailyValue: {
    findMany(input: { where: { appUserId: string; snapTradeAccountId: string }; select: { date: true; source: true; value: true; currency: true } }): Promise<Array<{ date: Date; source: string; value: { toString(): string } | number | null; currency: string }>>;
    createMany(input: {
      data: Array<{ appUserId: string; date: Date; snapTradeAccountId: string; currency: string; value: number; source: string }>;
      skipDuplicates: boolean;
    }): Promise<unknown>;
    deleteMany(input: { where: { appUserId: string; snapTradeAccountId: string | { notIn: string[] }; source: { in: string[] } } }): Promise<unknown>;
  };
}

const torontoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });
const utcDay = (d: string) => new Date(`${d}T00:00:00.000Z`);
const EPS = 1e-6;
const CHUNK = 500;
const normSymbol = (s: string) => s.trim().toUpperCase();
/** Relative share-count tolerance for broker fractional rounding. */
const REL_TOL = 0.005;
const LOOKBACK_DAYS = 10;
const DEFAULT_VALUATION_DEADLINE_MS = 60_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const MAX_TYPE_KEYS = 30;
const ratio = (rebuilt: number, reported: number) => (Math.abs(reported) > 0 && Number.isFinite(rebuilt / reported) ? round2(rebuilt / reported) : null);
const shiftDay = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const dateOf = (a: StoredActivity) => a.tradeDate ?? a.settlementDate;

/** Valuation could not complete (market data, FX or deadline): keep the stored history untouched (ruling F2). */
class KeepExisting extends Error {}
/** How long a market-data failure may keep previously rebuilt history before degrading to estimated. */
const KEEP_EXISTING_MAX_MS = 7 * 24 * 60 * 60 * 1000;

type Account = ReturnType<typeof buildPortfolioPresentation>["accounts"][number];
type RunMarket = Pick<MarketDataService, "securityHistory" | "usdCad">;

interface HoldingsComparison {
  mismatched: number; extra: number; missing: number;
  /** Replayed over reported units per mismatched symbol (diagnostics only; never logged with symbols). */
  unitRatios: Array<number | null>;
}

function compareHoldings(replayed: Map<string, number>, positions: Array<{ symbol: string; units: number | null; kind: string }>): HoldingsComparison {
  const reported = new Map<string, number>();
  for (const p of positions) {
    if (p.kind.toLowerCase().includes("option")) continue;
    const units = p.units ?? 0;
    if (Math.abs(units) > EPS) reported.set(normSymbol(p.symbol), (reported.get(normSymbol(p.symbol)) ?? 0) + units);
  }
  const mine = new Map<string, number>();
  for (const [s, u] of replayed) if (Math.abs(u) > EPS) mine.set(normSymbol(s), (mine.get(normSymbol(s)) ?? 0) + u);
  const result: HoldingsComparison = { mismatched: 0, extra: 0, missing: 0, unitRatios: [] };
  for (const s of new Set([...mine.keys(), ...reported.keys()])) {
    const a = mine.get(s);
    const b = reported.get(s);
    if (a === undefined) result.missing += 1;
    else if (b === undefined) result.extra += 1;
    else if (Math.abs(a - b) > Math.max(EPS, REL_TOL * Math.abs(b))) {
      result.mismatched += 1;
      result.unitRatios.push(Math.abs(b) > 0 && Number.isFinite(a / b) ? round2(a / b) : null);
    }
  }
  return result;
}


interface PriceCheck { ratio: number | null; weight: number | null; currencyMatch: boolean; mapped: boolean; kind: string; cashEquivalent: boolean }

/** Brokerage instrument kind as a short lowercase word; anything else is "other" (never a name or symbol). */
const kindLabel = (kind: string): string => {
  const k = kind.trim().toLowerCase();
  return /^[a-z _-]{1,24}$/.test(k) ? k : "other";
};

/**
 * Per reported position with positive units: rebuilt last close over reported price (both in
 * reporting currency at the valuation's last-day FX), the position's share of reported holdings,
 * whether the assumed security currency matches, and whether the symbol was mapped. Fractions and
 * booleans only; sorted by |ratio - 1| descending (unknown ratios last), at most 20.
 */
function priceChecks(
  positions: Array<{ symbol: string; kind: string; units: number | null; price: number | null; marketValue: number | null; currency: string | null; cashEquivalent?: boolean }>,
  lastPrices: Map<string, { close: number | null; currency: string; mapped: boolean }>,
  convert: (ccy: string | null, amount: number) => number | null,
  reportedHoldings: number,
): PriceCheck[] {
  const rebuilt = new Map<string, { close: number | null; currency: string; mapped: boolean }>();
  for (const [s, v] of lastPrices) rebuilt.set(normSymbol(s), v);
  const checks: PriceCheck[] = [];
  for (const p of positions) {
    if (p.kind.toLowerCase().includes("option") || p.units === null || !(p.units > 0)) continue;
    const r = rebuilt.get(normSymbol(p.symbol));
    const reportedPrice = p.price === null ? null : convert(p.currency, p.price);
    const close = r?.close === null || r === undefined ? null : convert(r.currency, r.close);
    const rawRatio = close !== null && reportedPrice !== null && reportedPrice !== 0 ? close / reportedPrice : null;
    const mv = p.marketValue === null ? null : convert(p.currency, p.marketValue);
    const rawWeight = mv !== null && reportedHoldings !== 0 ? mv / reportedHoldings : null;
    checks.push({
      ratio: rawRatio !== null && Number.isFinite(rawRatio) ? round3(rawRatio) : null,
      weight: rawWeight !== null && Number.isFinite(rawWeight) ? round2(rawWeight) : null,
      currencyMatch: r !== undefined && p.currency !== null && r.currency.toUpperCase() === p.currency.trim().toUpperCase(),
      mapped: r?.mapped ?? false,
      kind: kindLabel(p.kind),
      cashEquivalent: p.cashEquivalent === true,
    });
  }
  const dev = (c: PriceCheck) => (c.ratio === null ? -1 : Math.abs(c.ratio - 1));
  return checks.sort((x, y) => dev(y) - dev(x)).slice(0, MAX_PRICE_CHECKS);
}

export interface TradePriceCheck {
  rowCurrency: string; securityCurrency: string; hasFxRate: boolean;
  count: number; median: number; p10: number; p90: number;
  /** Share of rows whose ratio is within ±3% of 1. */
  nearOne: number;
  /** Share of rows whose ratio is within ±3% of that day's USD/CAD rate or its inverse; null without FX. */
  nearFx: number | null;
}

/** Three-letter currency code, else OTHER: never free text. */
const currencyLabel = (c: string | null | undefined): string => {
  const v = (c ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(v) ? v : "OTHER";
};
const dayNum = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

/** Last point on or before `date`, no more than seven days old (series sorted ascending). */
function pointAt(series: Array<{ date: string; close: number }>, date: string): number | null {
  let lo = 0;
  let hi = series.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found < 0 || dayNum(date) - dayNum(series[found].date) > TRADE_PRICE_MAX_STALE_DAYS) return null;
  const close = series[found].close;
  return Number.isFinite(close) && close > 0 ? close : null;
}

const sortedByDate = (points: Array<{ date: string; close: number }>) => [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

/** Linear-interpolated quantile of an ascending list. */
function quantile(sorted: number[], q: number): number {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const withTimeout = <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Trade-price currency diagnostic: for BUY/SELL rows of mappable symbols, the row price over the
 * as-traded close on the row date (in the security currency), grouped by row currency, security
 * currency and whether the row carries an FX rate. A ratio near the USD/CAD rate means the price was
 * reported in the other currency. Ratios, counts and currency codes only; at most 10 groups.
 * Uses the run's shared (cached) market data.
 */
export async function tradePriceChecks(
  activities: StoredActivity[],
  tickerFor: (symbol: string, securityCurrency: string) => string | null,
  securityCurrencyOf: (row: StoredActivity) => string,
  market: RunMarket,
  range: { from: string; to: string },
  /** Set once the caller's budget has expired: no further market calls are issued. */
  cancelled: () => boolean = () => false,
): Promise<TradePriceCheck[]> {
  const trades: Array<{ row: StoredActivity; date: string; ticker: string; securityCurrency: string }> = [];
  for (const row of activities) {
    const type = row.type.toUpperCase();
    if ((type !== "BUY" && type !== "SELL") || row.isOption || !row.symbol) continue;
    const date = dateOf(row);
    if (!date || row.price === null || !Number.isFinite(row.price) || !(row.price > 0)) continue;
    const securityCurrency = securityCurrencyOf(row);
    const ticker = tickerFor(row.symbol, securityCurrency);
    if (ticker) trades.push({ row, date, ticker, securityCurrency });
  }
  if (trades.length === 0) return [];

  // The run market caches each ticker and FX for the run, so these are cache hits after valuation.
  const histories = new Map<string, { points: Array<{ date: string; close: number }>; splits: Array<{ date: string; ratio: number }> } | null>();
  const tickers = [...new Set(trades.map((t) => t.ticker))];
  let next = 0;
  const worker = async () => {
    while (next < tickers.length && !cancelled()) {
      const ticker = tickers[next++];
      const h = await market.securityHistory(ticker, range.from, range.to).catch(() => null);
      histories.set(ticker, h && !h.notFound && h.splits && h.points.length > 0
        ? { points: sortedByDate(h.points), splits: h.splits.filter((s) => s.ratio > 0 && Number.isFinite(s.ratio)) }
        : null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(TRADE_PRICE_CONCURRENCY, tickers.length) }, worker));
  if (cancelled()) return [];
  const fxRaw = await market.usdCad(range.from, range.to).catch(() => null);
  const fx = fxRaw && fxRaw.length > 0 ? sortedByDate(fxRaw) : null;

  const groups = new Map<string, { rowCurrency: string; securityCurrency: string; hasFxRate: boolean; ratios: number[]; fxRows: number; nearFx: number }>();
  for (const t of trades) {
    const h = histories.get(t.ticker);
    if (!h) continue;
    const close = pointAt(h.points, t.date);
    if (close === null) continue;
    // Provider closes are split-adjusted; scale back to as-traded terms on the trade date.
    const asTraded = close * h.splits.filter((s) => s.date > t.date).reduce((acc, s) => acc * s.ratio, 1);
    const r = t.row.price! / asTraded;
    if (!Number.isFinite(r) || !(r > 0)) continue;
    const rowCurrency = currencyLabel(t.row.currency);
    const securityCurrency = currencyLabel(t.securityCurrency);
    const hasFxRate = t.row.fxRate !== null && t.row.fxRate !== undefined;
    const key = `${rowCurrency}|${securityCurrency}|${hasFxRate}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { rowCurrency, securityCurrency, hasFxRate, ratios: [], fxRows: 0, nearFx: 0 }));
    g.ratios.push(r);
    const rate = fx ? pointAt(fx, t.date) : null;
    if (rate === null) continue;
    g.fxRows += 1;
    if (Math.abs(r / rate - 1) <= TRADE_PRICE_NEAR || Math.abs(r * rate - 1) <= TRADE_PRICE_NEAR) g.nearFx += 1;
  }
  return [...groups.values()]
    .sort((a, b) => b.ratios.length - a.ratios.length || `${a.rowCurrency}|${a.securityCurrency}|${a.hasFxRate}`.localeCompare(`${b.rowCurrency}|${b.securityCurrency}|${b.hasFxRate}`))
    .slice(0, MAX_TRADE_PRICE_GROUPS)
    .map((g) => {
      const sorted = [...g.ratios].sort((x, y) => x - y);
      const count = sorted.length;
      return {
        rowCurrency: g.rowCurrency, securityCurrency: g.securityCurrency, hasFxRate: g.hasFxRate, count,
        median: round3(quantile(sorted, 0.5)), p10: round3(quantile(sorted, 0.1)), p90: round3(quantile(sorted, 0.9)),
        nearOne: round2(sorted.filter((x) => Math.abs(x - 1) <= TRADE_PRICE_NEAR).length / count),
        // Over the rows that had a USD/CAD rate within seven days of the trade.
        nearFx: g.fxRows > 0 ? round2(g.nearFx / g.fxRows) : null,
      };
    });
}

export interface CostBasisCurrencyCounts { usd: number; cad: number; neither: number; noCost: number }
/** A reported cost basis within this share of a replayed average matches it. */
const COST_BASIS_NEAR = 0.02;

/**
 * Replayed CAD average cost of ONE symbol's rows: CAD-row additions at |amount| as reported,
 * USD-row additions at |amount| × the BoC USD/CAD close on or before the trade date (at most 7
 * days older); reductions keep the average. Null when any addition's CAD cost is unknown, the
 * history oversells, or nothing is held.
 */
function replayedCadAverage(rows: StoredActivity[], splits: Array<{ date: string; ratio: number }>, fx: Array<{ date: string; close: number }>): number | null {
  const delta = (r: StoredActivity) => (r.type.toUpperCase() === "REI" ? Math.abs(r.units ?? 0) : unitsDelta(r.type.toUpperCase(), r.units));
  const ordered = rows.filter((r) => !r.isOption && dateOf(r)).sort((a, b) => {
    const da = dateOf(a)!;
    const db = dateOf(b)!;
    if (da !== db) return da < db ? -1 : 1;
    const ba = delta(a) > 0 ? 0 : 1;
    const bb = delta(b) > 0 ? 0 : 1;
    return ba !== bb ? ba - bb : a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0;
  });
  const pending = [...splits].filter((s) => s.ratio > 0 && Number.isFinite(s.ratio)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let units = 0;
  let cost: number | null = 0;
  const splitThrough = (date: string | null) => {
    while (pending.length > 0 && (date === null || pending[0]!.date <= date)) units *= pending.shift()!.ratio;
  };
  for (const r of ordered) {
    const date = dateOf(r)!;
    splitThrough(date);
    const d = delta(r);
    if (d > 0) {
      const amount = r.amount !== null && Number.isFinite(r.amount) && r.amount !== 0 ? Math.abs(r.amount) : null;
      const row = (r.currency ?? "").trim().toUpperCase();
      const rate = row === "USD" ? pointAt(fx, date) : null;
      const cad = amount === null ? null : row === "CAD" ? amount : rate !== null ? amount * rate : null;
      if (units <= EPS) cost = 0;
      units += d;
      cost = cost === null || cad === null ? null : cost + cad;
    } else if (d < 0) {
      const before = units;
      units += d;
      if (units < -EPS) return null;
      if (units <= EPS) { units = 0; cost = 0; } else if (cost !== null) cost *= units / before;
    }
  }
  splitThrough(null);
  return cost !== null && units > EPS ? cost / units : null;
}

/**
 * Book-cost currency diagnostic (spec 6.4 step 0): for open positions whose security currency is
 * USD, whether the reported per-unit cost basis is within 2% of the replayed USD average
 * (symbolPosition with the BoC converter) or the replayed CAD average. A position whose averages
 * cannot both be replayed (a missing rate, an unpriced receipt, an oversell) is `neither`. Counts only.
 */
export async function costBasisCurrencyCounts(
  positions: Account["positions"],
  activities: StoredActivity[],
  securityCurrencyOf: (symbol: string, positionCurrency: string | null) => string,
  tickerFor: (symbol: string, ccy: string) => string | null,
  market: RunMarket,
  range: { from: string; to: string },
): Promise<CostBasisCurrencyCounts> {
  const counts: CostBasisCurrencyCounts = { usd: 0, cad: 0, neither: 0, noCost: 0 };
  const usd = positions.filter((p) => !p.kind.toLowerCase().includes("option") && !p.cashEquivalent && p.units !== null && p.units > EPS
    && securityCurrencyOf(p.symbol, p.currency) === "USD");
  if (usd.length === 0) return counts;
  const fxRaw = await market.usdCad(range.from, range.to).catch(() => null);
  const fx = fxRaw && fxRaw.length > 0 ? sortedByDate(fxRaw) : [];
  const toSecurity = tradePriceConverter(fx.length > 0 ? fx : null);
  const near = (a: number, b: number | null) => b !== null && b > 0 && Math.abs(a / b - 1) <= COST_BASIS_NEAR;
  for (const p of usd) {
    if (p.costBasis === null || !Number.isFinite(p.costBasis) || !(p.costBasis > 0)) { counts.noCost += 1; continue; }
    const rows = activities.filter((r) => !r.isOption && r.symbol && normSymbol(r.symbol) === normSymbol(p.symbol)
      && (r.securityCurrency ?? "USD").trim().toUpperCase() === "USD");
    const ticker = tickerFor(p.symbol, "USD");
    const h = ticker ? await market.securityHistory(ticker, range.from, range.to).catch(() => null) : null;
    const splits = h && !h.notFound && h.splits ? h.splits.filter((s) => s.ratio > 0 && Number.isFinite(s.ratio)) : [];
    const replayed = rows.length > 0 ? symbolPosition(rows, splits, () => null, "USD", toSecurity) : null;
    const usdAvg = replayed?.avgCost ?? null;
    const cadAvg = rows.length > 0 ? replayedCadAverage(rows, splits, fx) : null;
    // Both averages must replay (every needed rate present) for the comparison to decide.
    if (usdAvg === null || cadAvg === null) counts.neither += 1;
    else if (near(p.costBasis, usdAvg)) counts.usd += 1;
    else if (near(p.costBasis, cadAvg)) counts.cad += 1;
    else counts.neither += 1;
  }
  return counts;
}

/** Converts a brokerage-reported amount to the reporting currency at the valuation's last-day USD/CAD rate. */
function converter(reportingCurrency: string, rate: number | null) {
  return (ccy: string | null, amount: number): number | null => {
    if (ccy === null || ccy === reportingCurrency) return amount;
    if (rate === null || rate <= 0) return null;
    if (ccy === "USD" && reportingCurrency === "CAD") return amount * rate;
    if (ccy === "CAD" && reportingCurrency === "USD") return amount / rate;
    return null;
  };
}

/**
 * Today's reported balance cash in reporting currency, or null when unknown: no balances, a balance
 * without cash, or a foreign balance that cannot be converted (FX missing).
 */
function reportedCashStrict(account: Account, rate: number | null): number | null {
  if (account.balances.length === 0) return null;
  const convert = converter(account.value!.currency, rate);
  let total = 0;
  for (const b of account.balances) {
    if (b.cash === null || !Number.isFinite(b.cash)) return null;
    const v = convert(b.currency, b.cash);
    if (v === null) return null;
    total += v;
  }
  return total;
}

export class ReconstructionService {
  private readonly now: () => Date;
  private readonly driftThreshold: number;
  private readonly driftFallback: number;
  private readonly valuationDeadlineMs: number;

  constructor(private readonly options: {
    store: Pick<ActivityStore, "userId" | "listActivities" | "saveQuality" | "deleteQualitiesExcept" | "qualities">;
    portfolio: { getPortfolio(subject: string): Promise<PortfolioQueryResult> };
    market: RunMarket;
    dailyValues: ReconstructedValuePort;
    now?: () => Date;
    driftThreshold?: number;
    /** Drift above which rebuilt history is dropped for snapshots only (default 10%). */
    driftFallback?: number;
    /** Per-account valuation deadline (ruling F2 / spec section 8). */
    valuationDeadlineMs?: number;
    /** One shared budget for the per-account trade-price check and provider probe (default 10 s). */
    tradePriceBudgetMs?: number;
    /** Emit the `provider_metadata_probe` line (default true); turn off once it has been read. */
    providerProbe?: boolean;
  }) {
    this.now = options.now ?? (() => new Date());
    this.driftThreshold = options.driftThreshold ?? 0.02;
    this.driftFallback = options.driftFallback ?? DRIFT_FALLBACK;
    this.valuationDeadlineMs = options.valuationDeadlineMs ?? DEFAULT_VALUATION_DEADLINE_MS;
  }

  async reconstructUser(authSubject: string): Promise<{ accounts: number; failures: number; codes?: Record<string, number> }> {
    const appUserId = await this.options.store.userId(authSubject);
    if (!appUserId) return { accounts: 0, failures: 0 };
    const presentation = buildPortfolioPresentation(await this.options.portfolio.getPortfolio(authSubject));
    // Reconcile only against a fresh, complete brokerage read; stale or partial totals would mislabel quality.
    if (presentation.cache?.stale || presentation.errors.length > 0) return { accounts: 0, failures: 1, codes: { stale_read: 1 } };
    const included = presentation.accounts.filter(
      (a) => a.classification.includedInPortfolioTotal && a.value !== null && Number.isFinite(a.value.amount),
    );
    const today = torontoDate.format(this.now());
    let failures = 0;
    const codes: Record<string, number> = {};
    const fail = (code: string) => { failures += 1; codes[code] = (codes[code] ?? 0) + 1; };

    // M6: accounts that left the included set keep no derived rows or quality.
    try {
      // A null reported total is a transient, error-free state: keep that account's history.
      const keep = presentation.accounts.filter((a) => a.classification.includedInPortfolioTotal).map((a) => a.id);
      await this.options.dailyValues.dailyValue.deleteMany({ where: { appUserId, snapTradeAccountId: { notIn: keep }, source: { in: DERIVED } } });
      await this.options.store.deleteQualitiesExcept(appUserId, keep);
    } catch {
      fail("prune_failed");
    }

    const loaded = new Map<string, StoredActivity[] | Error>();
    for (const account of included) {
      try {
        loaded.set(account.id, await this.options.store.listActivities(appUserId, account.id));
      } catch (error) {
        loaded.set(account.id, error instanceof Error ? error : new Error("load_failed"));
      }
    }
    const market = this.runMarket(loaded, today);
    // Ruling F2 bound: keep existing history on a market-data failure only while it was rebuilt
    // recently; a ticker that stays unavailable (delisted, never listed) degrades to estimated.
    let freshUntil = new Map<string, number>();
    try {
      freshUntil = new Map((await this.options.store.qualities(authSubject))
        .filter((q) => q.method === "reconstructed")
        .map((q) => [q.accountId, Date.parse(q.computedAt) + KEEP_EXISTING_MAX_MS]));
    } catch {
      // unknown prior state: treat as not fresh
    }

    for (const account of included) {
      try {
        const activities = loaded.get(account.id);
        if (!activities || activities instanceof Error) throw activities ?? new Error("load_failed");
        await this.reconstructAccount(appUserId, account, activities, today, market, (freshUntil.get(account.id) ?? 0) > this.now().getTime());
      } catch (error) {
        fail(error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : "error");
        if (error instanceof KeepExisting) continue;
        try {
          await this.deleteDerived(appUserId, account.id);
        } catch {
          // best-effort cleanup
        }
        try {
          await this.options.store.saveQuality(appUserId, account.id, { method: "snapshots_only", reason: "error", driftFraction: null });
        } catch {
          // quality is best-effort once the account has already failed
        }
      }
    }
    return { accounts: included.length, failures, ...(failures ? { codes } : {}) };
  }

  /**
   * Ruling F4: one fetch per ticker (and one FX fetch) per run over a common window from the
   * user's earliest activity − 10 days to today, shared across accounts.
   */
  private runMarket(loaded: Map<string, StoredActivity[] | Error>, today: string): { market: RunMarket; range: { from: string; to: string } } {
    let earliest: string | null = null;
    for (const list of loaded.values()) {
      if (list instanceof Error) continue;
      for (const a of list) {
        const d = dateOf(a);
        if (d && (earliest === null || d < earliest)) earliest = d;
      }
    }
    const range = { from: shiftDay(earliest ?? today, -LOOKBACK_DAYS), to: today };
    const securities = new Map<string, Promise<SecurityHistory | null>>();
    let fx: Promise<PricePoint[] | null> | undefined;
    const upstream = this.options.market;
    const market: RunMarket = {
      securityHistory: (ticker) => {
        let p = securities.get(ticker);
        if (!p) securities.set(ticker, (p = upstream.securityHistory(ticker, range.from, range.to)));
        return p;
      },
      usdCad: () => (fx ??= upstream.usdCad(range.from, range.to)),
    };
    return { market, range };
  }

  private deleteDerived(appUserId: string, accountId: string) {
    return this.options.dailyValues.dailyValue.deleteMany({ where: { appUserId, snapTradeAccountId: accountId, source: { in: DERIVED } } });
  }

  private withDeadline<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new KeepExisting("valuation_deadline")), this.valuationDeadlineMs);
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
  }

  private async reconstructAccount(
    appUserId: string,
    account: Account,
    activities: StoredActivity[],
    today: string,
    run: { market: RunMarket; range: { from: string; to: string } },
    keepOnFetchFailure = false,
  ): Promise<void> {
    const { store, dailyValues } = this.options;
    const accountId = account.id;
    const reported = account.value!;
    const classification = classifyAccount(activities);
    const del = () => this.deleteDerived(appUserId, accountId);

    if (classification.method === "snapshots_only") {
      await del();
      await store.saveQuality(appUserId, accountId, { method: "snapshots_only", reason: classification.reason, driftFraction: null });
      return;
    }

    const states = replay(activities, "0000-01-01", today);
    if (states.length === 0) {
      await del();
      await store.saveQuality(appUserId, accountId, { method: "snapshots_only", reason: "no_activity", driftFraction: null });
      return;
    }

    const securityCurrencies = new Map<string, string | null>();
    for (const a of activities) {
      if (a.symbol && a.securityCurrency && !securityCurrencies.get(a.symbol)) securityCurrencies.set(a.symbol, a.securityCurrency);
    }
    // M5: crypto is not priced as a same-named stock; those holdings stay unmappable (estimated).
    const crypto = new Set(account.positions.filter((p) => p.kind.toLowerCase() === "crypto").map((p) => normSymbol(p.symbol)));
    // Price sanity guard: a holding at the reconciliation date whose reported kind is not a trusted
    // kind, or whose provider close is more than 50% off the reported price, is valued at the
    // reported price (held constant, estimated). Without a reported price it is unmappable.
    const reportedBySymbol = new Map<string, Account["positions"]>();
    for (const p of account.positions) {
      if (p.kind.toLowerCase().includes("option") || p.units === null || !(p.units > 0)) continue;
      const key = normSymbol(p.symbol);
      reportedBySymbol.set(key, [...(reportedBySymbol.get(key) ?? []), p]);
    }
    const reportedPrice = (symbol: string): { price: number; currency: string } | null => {
      const p = (reportedBySymbol.get(normSymbol(symbol)) ?? []).find((x) => x.price !== null && Number.isFinite(x.price) && x.price > 0);
      return p ? { price: p.price!, currency: (p.currency ?? reported.currency).trim().toUpperCase() } : null;
    };
    const priceOverrides = new Map<string, { price: number; currency: string }>();
    const unmappable = new Set<string>();
    for (const [symbol, u] of states[states.length - 1].units) {
      if (Math.abs(u) < EPS) continue;
      const held = reportedBySymbol.get(normSymbol(symbol));
      if (!held || held.every((p) => isTrustedPriceKind(p.kind))) continue;
      const price = reportedPrice(symbol);
      if (price) priceOverrides.set(symbol, price);
      else unmappable.add(normSymbol(symbol));
    }
    const tickerFor = (symbol: string, ccy: string | null) => (account.classification.bucket === "crypto" || crypto.has(normSymbol(symbol)) || unmappable.has(normSymbol(symbol)) ? null : providerTicker({ symbol, kind: "stock", currency: ccy }));
    const value = () => valueAccount({
      states,
      reportingCurrency: reported.currency,
      tickerFor,
      securityCurrencies,
      market: run.market,
      range: run.range,
      twoSidedConversions: classification.warnings.includes("fx_conversion_two_sided"),
      priceOverrides,
    });
    const valued = await this.withDeadline((async () => {
      const first = await value();
      const convert = converter(reported.currency, first.last.usdCad);
      let added = false;
      for (const [symbol, lp] of first.lastPrices) {
        if (priceOverrides.has(symbol) || !lp.mapped || lp.close === null) continue;
        const price = reportedPrice(symbol);
        if (!price) continue;
        const close = convert(lp.currency, lp.close);
        const reportedValue = convert(price.currency, price.price);
        if (close === null || reportedValue === null || !(reportedValue > 0)) continue;
        if (priceOutOfRange(close / reportedValue)) { priceOverrides.set(symbol, price); added = true; }
      }
      // Histories are cached for the run, so the second pass fetches nothing new.
      return added ? value() : first;
    })());
    // Ruling F2: a transient market-data or FX failure must not rewrite good history.
    if ((valued.fetchFailed.length > 0 || valued.fxFailed) && keepOnFetchFailure) throw new KeepExisting(valued.fxFailed ? "fx_unavailable" : "history_unavailable");

    const todayValued = [...valued.days].reverse().find((d) => d.date <= today);
    const reportedAbs = Math.abs(reported.amount);
    const driftOf = (value: number) => Math.abs(value - reported.amount) / reportedAbs;
    // Opening cash anchor: an unknown cash balance from before the history began (for example a
    // margin loan or early withdrawals) is the constant that makes today's rebuilt cash match the
    // brokerage's. Skipped when reported cash is unknown or FX for the rebuild failed.
    let offset = 0;
    let anchorShare: number | null = null;
    const reportedCash = reportedCashStrict(account, valued.last.usdCad);
    if (todayValued && reportedAbs > 0 && reportedCash !== null && !valued.fxFailed) {
      offset = reportedCash - valued.last.cash;
      anchorShare = Math.abs(offset) / reportedAbs;
    }
    // A constant opening balance that takes any rebuilt day to zero or below is implausible (and
    // would break returns): do not anchor; the unanchored drift guard decides.
    const anchorRejected = offset !== 0 && valued.days.some((d) => d.value + offset <= 0);
    if (anchorRejected) offset = 0;
    const comparison = compareHoldings(valued.finalUnits, account.positions);
    const mismatch = comparison.mismatched + comparison.extra + comparison.missing > 0;
    // Book-cost currency diagnostic (counts only): FX and histories are cached for the run.
    let costBasisCurrency: CostBasisCurrencyCounts | null = null;
    try {
      const securityCurrencyOf = (symbol: string, positionCurrency: string | null) => {
        for (const [s, c] of securityCurrencies) if (c && normSymbol(s) === normSymbol(symbol)) return c.trim().toUpperCase();
        return (positionCurrency ?? inferCurrency(symbol)).trim().toUpperCase();
      };
      costBasisCurrency = await withTimeout(
        costBasisCurrencyCounts(account.positions, activities, securityCurrencyOf, tickerFor, run.market, run.range).catch(() => null),
        this.options.tradePriceBudgetMs ?? TRADE_PRICE_BUDGET_MS, null,
      );
    } catch {
      // diagnostics must never affect reconstruction
    }
    const log = (drift: number | null, outcome: "estimated" | "snapshots_only", rebuiltTotal: number) =>
      this.logDiagnostic(account, activities, valued, comparison, rebuiltTotal, drift, anchorShare, anchorRejected, outcome, priceOverrides.size, costBasisCurrency);
    // Every valued account logs its trade-price check and provider probe (counts, ratios and
    // currency codes only), under one shared budget.
    await this.logPriceDiagnostics(account, activities, (symbol, ccy) => (priceOverrides.has(symbol) ? null : tickerFor(symbol, ccy)), securityCurrencies, run, valued.last.usdCad, today);

    // Cash-account rule: a cash account's gap accumulates over time, so a large constant anchor is
    // not a credible opening balance. Keep snapshots only, with the unanchored drift.
    if (!anchorRejected && account.classification.bucket === "money_market" && anchorShare !== null && anchorShare > CASH_ACCOUNT_ANCHOR_MAX) {
      const rawDrift = driftOf(todayValued!.value);
      log(rawDrift, "snapshots_only", todayValued!.value);
      await del();
      await store.saveQuality(appUserId, accountId, { method: "snapshots_only", reason: "drift_too_large", driftFraction: rawDrift });
      return;
    }

    const todayValue = todayValued ? todayValued.value + offset : null;
    const drift = todayValue !== null && reportedAbs > 0 ? driftOf(todayValue) : null;
    const anchored = !anchorRejected && anchorShare !== null && anchorShare > ANCHOR_LABEL_MIN;
    let reason: string | null = null;
    if (mismatch) reason = "holdings_mismatch";
    else if (drift !== null && drift > this.driftThreshold) reason = "drift";
    else if (anchored) reason = "opening_cash";
    const estimatedAll = reason !== null;
    const guarded = drift !== null && drift > this.driftFallback;
    if ((drift !== null && drift > this.driftThreshold) || mismatch || anchored || anchorRejected || priceOverrides.size > 0) {
      log(drift, guarded ? "snapshots_only" : "estimated", todayValue ?? 0);
    }
    if (guarded) {
      await del();
      await store.saveQuality(appUserId, accountId, { method: "snapshots_only", reason: "drift_too_large", driftFraction: drift });
      return;
    }

    const existing = await dailyValues.dailyValue.findMany({
      where: { appUserId, snapTradeAccountId: accountId },
      select: { date: true, source: true, value: true, currency: true },
    });
    // Ruling F1: derived rows only before the account's first reported row.
    const firstReported = existing
      .filter((r) => r.source === "reported")
      .map((r) => r.date.toISOString().slice(0, 10))
      .reduce<string | null>((min, d) => (min === null || d < min ? d : min), null);
    // Flows the activities miss show as steps between the reported and rebuilt values, but only when the rebuild moves
    // with the market: every held symbol priced from its own history, units matching (spec 2026-11-04-unrecorded-flow-check).
    const marketNeutral = !mismatch && priceOverrides.size === 0 && valued.missingSymbols.length === 0 && valued.fetchFailed.length === 0 && !valued.fxFailed;
    const unrecordedFlows = marketNeutral
      ? findUnrecordedFlows(
        existing.filter((r) => r.source === "reported" && r.currency === reported.currency && r.value !== null)
          .map((r) => ({ date: r.date.toISOString().slice(0, 10), value: Number(r.value) })),
        valued.days.filter((d) => d.source === "reconstructed" && d.currency === reported.currency),
      )
      : [];
    // Counts only, so production can show how often the check fires before it is trusted further.
    if (unrecordedFlows.length) console.log(JSON.stringify({ event: "unrecorded_flows", bucket: account.classification.bucket, count: unrecordedFlows.length }));

    const rows: Array<{ appUserId: string; date: Date; snapTradeAccountId: string; currency: string; value: number; source: string }> = [];
    for (const day of valued.days) {
      if (day.date >= today || (firstReported !== null && day.date >= firstReported)) continue;
      rows.push({
        appUserId, date: utcDay(day.date), snapTradeAccountId: accountId, currency: day.currency, value: day.value + offset,
        source: estimatedAll ? "estimated" : day.source,
      });
    }
    await del();
    for (let i = 0; i < rows.length; i += CHUNK) {
      await dailyValues.dailyValue.createMany({ data: rows.slice(i, i + CHUNK), skipDuplicates: true });
    }
    await store.saveQuality(appUserId, accountId, { method: "reconstructed", reason, driftFraction: drift, ...(unrecordedFlows.length ? { unrecordedFlows } : {}) });
  }

  /**
   * One `trade_price_check` line, then (unless `providerProbe` is off) one `provider_metadata_probe`
   * line (brief 8), per valued account: the bucket and counts, ratios and currency codes only.
   * Both run under ONE budget (default 10 s); once it expires the probe issues no further market
   * calls, a check that did not finish logs [] and an unfinished probe logs nothing. Never throws.
   */
  private async logPriceDiagnostics(
    account: Account,
    activities: StoredActivity[],
    tickerFor: (symbol: string, ccy: string) => string | null,
    securityCurrencies: Map<string, string | null>,
    run: { market: RunMarket; range: { from: string; to: string } },
    usdCad: number | null,
    today: string,
  ): Promise<void> {
    try {
      let cancelled = false;
      let checks: TradePriceCheck[] | null = null;
      let probe: Awaited<ReturnType<typeof providerMetadataProbe>> | null = null;
      const securityCurrencyOf = (symbol: string) => {
        const exact = securityCurrencies.get(symbol);
        if (exact) return exact.trim().toUpperCase();
        for (const [s, c] of securityCurrencies) if (c && normSymbol(s) === normSymbol(symbol)) return c.trim().toUpperCase();
        return inferCurrency(symbol);
      };
      const work = (async () => {
        const found = await tradePriceChecks(
          activities, tickerFor,
          (row) => (row.securityCurrency ?? securityCurrencies.get(row.symbol!) ?? inferCurrency(row.symbol!)).trim().toUpperCase(),
          run.market, run.range, () => cancelled,
        ).catch(() => [] as TradePriceCheck[]);
        if (cancelled) return;
        checks = found;
        if (this.options.providerProbe === false) return;
        const result = await providerMetadataProbe({
          reportingCurrency: account.value!.currency, reportedTotal: account.value!.amount, balances: account.balances,
          positions: account.positions, activities, securityCurrencyOf, tickerFor, market: run.market, range: run.range, usdCad, today,
          cancelled: () => cancelled,
        }).catch(() => null);
        if (!cancelled) probe = result;
      })();
      await withTimeout(work, this.options.tradePriceBudgetMs ?? TRADE_PRICE_BUDGET_MS, undefined);
      cancelled = true;
      const bucket = account.classification.bucket;
      console.log(JSON.stringify({ event: "trade_price_check", bucket, tradePriceChecks: checks ?? [] }));
      if (probe) console.log(JSON.stringify({ event: "provider_metadata_probe", bucket, ...(probe as object) }));
    } catch {
      // diagnostics must never affect reconstruction
    }
  }

  /** One counts-and-ratios line per flagged account: no ids, labels, symbols, units, prices or amounts. */
  private logDiagnostic(
    account: Account,
    activities: StoredActivity[],
    valued: Awaited<ReturnType<typeof valueAccount>>,
    comparison: HoldingsComparison,
    rebuiltTotal: number,
    drift: number | null,
    anchorShare: number | null,
    anchorRejected: boolean,
    outcome: "estimated" | "snapshots_only",
    priceOverridden: number,
    costBasisCurrency: CostBasisCurrencyCounts | null,
  ): void {
    try {
      const convert = converter(account.value!.currency, valued.last.usdCad);
      let reportedHoldings = 0;
      for (const p of account.positions) {
        if (p.kind.toLowerCase().includes("option") || p.marketValue === null) continue;
        const v = convert(p.currency, p.marketValue);
        if (v !== null) reportedHoldings += v;
      }
      // Deliberately lenient (unlike reportedCashStrict, which gates the anchor): a best-effort ratio
      // that skips null or unconvertible balances, so a diagnostic line is still useful.
      let reportedCash = 0;
      for (const b of account.balances) {
        if (b.cash === null) continue;
        const v = convert(b.currency, b.cash);
        if (v !== null) reportedCash += v;
      }
      const activityTypes: Record<string, number> = {};
      let corporateActionRows = 0;
      let transferOutRows = 0;
      for (const a of activities) {
        // Provider enum names only; anything else (or past 30 distinct keys) is counted as OTHER.
        const raw = a.type.toUpperCase();
        const type = /^[A-Z_]{1,40}$/.test(raw) && (raw in activityTypes || Object.keys(activityTypes).length < 30) ? raw : "OTHER";
        activityTypes[type] = (activityTypes[type] ?? 0) + 1;
        if (type === "CORPORATE_ACTION" && a.units !== null && a.units !== 0) corporateActionRows += 1;
        if (type === "WITHDRAWAL" || type === "INTERNAL_CASH_TRANSFER_OUT" || (type === "TRANSFER" && ((a.units ?? 0) < 0 || (a.amount ?? 0) < 0))) transferOutRows += 1;
      }
      // Ratios of cash applied per type over |reported total|; at most 30 keys (overflow joins OTHER).
      const cashSums = new Map<string, number>();
      for (const [key, amount] of valued.cashByType) {
        const k = cashSums.has(key) || cashSums.size < MAX_TYPE_KEYS - 1 ? key : "OTHER";
        cashSums.set(k, (cashSums.get(k) ?? 0) + amount);
      }
      const reportedAbs = Math.abs(account.value!.amount);
      const cashByType: Record<string, number | null> = {};
      for (const [key, amount] of cashSums) {
        const r = amount / reportedAbs;
        cashByType[key] = reportedAbs > 0 && Number.isFinite(r) ? round3(r) : null;
      }
      console.log(JSON.stringify({
        event: "reconstruction_diagnostic",
        bucket: account.classification.bucket,
        direction: rebuiltTotal > account.value!.amount ? "high" : "low",
        driftFraction: drift === null ? null : round2(drift),
        holdingsRatio: ratio(valued.last.holdings, reportedHoldings),
        // Raw rebuild before the opening cash anchor (after it, cash matches by construction).
        cashRatio: ratio(valued.last.cash, reportedCash),
        anchorShare: anchorShare === null ? null : round2(anchorShare),
        anchorRejected,
        mismatchedSymbols: comparison.mismatched,
        // Ratios only (no symbols or units): ascending, nulls last, at most 20.
        priceChecks: priceChecks(account.positions, valued.lastPrices, convert, reportedHoldings),
        // Count of held symbols valued at the reported price by the price sanity guard.
        priceOverridden,
        unitRatios: [...comparison.unitRatios]
          .sort((x, y) => (x === null ? (y === null ? 0 : 1) : y === null ? -1 : x - y))
          .slice(0, MAX_UNIT_RATIOS),
        extraSymbols: comparison.extra,
        missingSymbols: comparison.missing,
        splitAdjusted: valued.splitsApplied,
        corporateActionRows,
        transferOutRows,
        activityTypes,
        inferredSymbols: valued.inferredSymbols,
        cashByType,
        // USD-security positions by whether reported cost basis matches the replayed USD or CAD
        // average (spec 6.4 step 0); null when the check could not run in time.
        costBasisCurrency,
        outcome,
      }));
    } catch {
      // diagnostics must never affect reconstruction
    }
  }
}
