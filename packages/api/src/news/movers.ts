import type { HoldingRow } from "../analytics/holdings.js";
import { providerTicker } from "../market-data/ticker-map.js";
import type { PricePoint, Quote } from "../market-data/types.js";
import type { SymbolStats } from "./store.js";

const TYPICAL_WINDOW_DAYS = 60;
const MIN_CLOSES = 30;
const RETURN_FLOOR = 0.015;
const TYPICAL_MULTIPLE = 2;
const DOLLAR_FLOOR = 50;
const DOLLAR_PORTFOLIO_FRACTION = 0.0025;
/** Relative tolerance so a value that is exactly on a threshold in decimal arithmetic still flags. */
const REL_TOL = 1e-9;
const QUOTE_MAX_AGE_MS = 24 * 3_600_000;
/** A last close older than this many Toronto trading days (weekends skipped; holidays not modelled) is stale. */
const MAX_CLOSE_AGE_TRADING_DAYS = 2;
const torontoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });
const validDay = (d: unknown): d is string =>
  typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) &&
  new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

const good = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** The YYYY-MM-DD date `n` weekdays before `day` (weekends skipped). */
export function tradingDaysBefore(day: string, n: number): string {
  let t = Date.parse(`${day}T00:00:00Z`);
  for (let left = n; left > 0;) {
    t -= 86_400_000;
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return new Date(t).toISOString().slice(0, 10);
}

/** Median absolute daily return over the last 60 trading days (61 closes); null with fewer than 30 closes. */
export function typicalMove(closes: number[]): number | null {
  const usable = closes.filter(good).slice(-(TYPICAL_WINDOW_DAYS + 1));
  if (usable.length < MIN_CLOSES) return null;
  const abs: number[] = [];
  for (let i = 1; i < usable.length; i += 1) abs.push(Math.abs(usable[i] / usable[i - 1] - 1));
  abs.sort((a, b) => a - b);
  const mid = abs.length >> 1;
  return abs.length % 2 ? abs[mid] : (abs[mid - 1] + abs[mid]) / 2;
}

/**
 * Daily stats from provider closes (any order). Dates are compared with the Toronto trading day of `now`:
 * while the market is open, today's (partial) bar and anything later is dropped so `lastClose` is the last
 * completed session; otherwise only future-dated points are dropped. Duplicate dates keep the last point.
 */
export function buildStats(symbol: string, currency: string, points: PricePoint[], now: Date, marketOpen: boolean): SymbolStats {
  const today = torontoDate.format(now);
  const byDate = new Map<string, number>();
  for (const p of points) {
    if (!validDay(p.date) || !good(p.close)) continue;
    if (marketOpen ? p.date >= today : p.date > today) continue;
    byDate.delete(p.date); // last one wins
    byDate.set(p.date, p.close);
  }
  const dates = [...byDate.keys()].sort();
  const closes = dates.map((d) => byDate.get(d) as number);
  return {
    symbol,
    currency,
    closes: closes.length,
    typicalMove: typicalMove(closes),
    lastClose: closes.length ? closes[closes.length - 1] : null,
    prevClose: closes.length > 1 ? closes[closes.length - 2] : null,
    lastCloseDate: dates.length ? dates[dates.length - 1] : null,
    updatedAt: now,
  };
}

export interface Mover {
  symbol: string;
  currency: string;
  returnFraction: number;
  dollarMove: number;
  /** The price and previous close behind `dollarMove` (native currency). */
  price: number;
  previousClose: number;
  estimated: boolean;
  flagged: boolean;
  limitedHistory: boolean;
  units: number;
  marketValue: number | null;
  /**
   * Toronto date (YYYY-MM-DD) of the session the move ends on: the stored last close's date when the market is
   * closed, Toronto today while it is open (a live quote). Alerts are keyed and worded by it.
   */
  sessionDate: string;
}

/**
 * One Mover per (symbol, currency), aggregated across accounts. `stats` is keyed `SYMBOL|CURRENCY`
 * (HoldingRow.key); `quotes` by provider ticker; `portfolioTotals` by currency. Market open: live quote vs
 * `lastClose` (last completed session, estimated); closed: `lastClose` vs `prevClose`. Quotes older than 24 h
 * are ignored, and so are stats whose last close is more than 2 Toronto trading days old (a missed nightly run must
 * not turn an old move, or a two-day return, into today's). Symbols without usable prices are returned in `unpriced`
 * rather than guessed.
 */
export function classifyMovers(
  rows: HoldingRow[],
  stats: Map<string, SymbolStats>,
  quotes: Map<string, Quote>,
  portfolioTotals: Map<string, number>,
  marketOpen: boolean,
  now: Date = new Date(),
): { movers: Mover[]; unpriced: Array<{ symbol: string; currency: string }> } {
  const agg = new Map<string, { symbol: string; currency: string; kind: string; units: number; value: number | null }>();
  for (const r of rows) {
    const key = `${r.symbol}|${r.currency}`;
    const a = agg.get(key);
    if (!a) agg.set(key, { symbol: r.symbol, currency: r.currency, kind: r.kind, units: r.units, value: r.marketValue });
    else {
      a.units += r.units;
      a.value = a.value === null || r.marketValue === null ? null : a.value + r.marketValue;
    }
  }
  const movers: Mover[] = [];
  const unpriced: Array<{ symbol: string; currency: string }> = [];
  const today = torontoDate.format(now);
  const oldest = tradingDaysBefore(today, MAX_CLOSE_AGE_TRADING_DAYS);
  for (const [key, a] of agg) {
    const found = stats.get(key);
    const s = found && validDay(found.lastCloseDate) && found.lastCloseDate >= oldest ? found : undefined;
    let price: number | null | undefined;
    let base: number | null | undefined;
    if (marketOpen) {
      const t = providerTicker({ symbol: a.symbol, kind: a.kind, currency: a.currency });
      const q = t ? quotes.get(t) : undefined;
      const age = q ? now.getTime() - Date.parse(q.asOf) : Number.NaN;
      price = q && age <= QUOTE_MAX_AGE_MS ? q.price : undefined;
      base = s?.lastClose;
    } else {
      price = s?.lastClose;
      base = s?.prevClose;
    }
    if (!s || !good(base) || !good(price)) {
      unpriced.push({ symbol: a.symbol, currency: a.currency });
      continue;
    }
    const prev = base;
    const returnFraction = price / prev - 1;
    const dollarMove = a.units * (price - prev);
    const limitedHistory = s.typicalMove === null;
    const returnThreshold = Math.max(limitedHistory ? 0 : TYPICAL_MULTIPLE * (s.typicalMove as number), RETURN_FLOOR);
    const dollarThreshold = Math.max(DOLLAR_FLOOR, DOLLAR_PORTFOLIO_FRACTION * (portfolioTotals.get(a.currency) ?? 0));
    const flagged = Math.abs(returnFraction) >= returnThreshold * (1 - REL_TOL) && Math.abs(dollarMove) >= dollarThreshold * (1 - REL_TOL);
    const sessionDate = marketOpen ? today : (s.lastCloseDate as string);
    movers.push({ symbol: a.symbol, currency: a.currency, returnFraction, dollarMove, price, previousClose: prev, estimated: marketOpen, flagged, limitedHistory, units: a.units, marketValue: a.value, sessionDate });
  }
  return { movers, unpriced };
}
