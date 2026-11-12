import type { MarketDataService } from "../market-data/market-data-service.js";
import type { PricePoint } from "../market-data/types.js";
import type { BenchmarkKey } from "../settings/settings-service.js";
import { BENCHMARKS, benchmarkPrices } from "./benchmarks.js";

export const PERIODS = ["1D", "1W", "1M", "3M", "YTD", "1Y", "ALL"] as const;
export type Period = (typeof PERIODS)[number];
export interface SeriesPoint { date: string; value: number; source: "reported" | "reconstructed" | "estimated" }
export interface ReturnFigure { value: number | null; estimated: boolean; reason?: string }
export interface OverviewSeries {
  period: Period; currency: string; points: SeriesPoint[];
  benchmark: { key: BenchmarkKey; name: string; explainer: string; basis?: string; points: Array<{ date: string; returnFraction: number }> | null; unavailableReason: string | null };
  /** Value change over [spanStart, today] (deposits not separated until Phase 2). */
  portfolioReturn: number | null;
  /** Benchmark change over the same span as portfolioReturn. */
  benchmarkReturn: number | null;
  fxNote: string | null;
  /** Time-weighted investment return over the same span (excludes deposits); null with a reason when unavailable. */
  investmentReturn: ReturnFigure;
  /** Benchmark return rebased on the span the time-weighted return covers. */
  benchmarkReturnTwr: ReturnFigure;
  /** Span the time-weighted return covers (it can start later than the value series); null when not computed. */
  returnSpan: { partial: boolean; since: string | null } | null;
  /** First portfolio point when the series has at least two points, else null. */
  spanStart: string | null;
  /** True when the first portfolio point is after the period start (history starts late). */
  spanIsPartial: boolean;
  /**
   * CAD view with a USD account included: the series and returns are in CAD (USD × that day's BoC rate).
   * `notConvertedDays`: days left out of `points` (a USD account had no rate within 7 days);
   * `notConvertedAccounts`: accounts never converted in the span; `flowNotConverted`: first date of a USD
   * deposit or withdrawal with no rate, for which the time-weighted return is withheld.
   */
  home?: { estimated: boolean; notConvertedDays: number; notConvertedAccounts: number; flowNotConverted: string | null };
}

// Calendar arithmetic on ISO dates; a day past the target month's end clamps to its last day
// (Mar 31 − 1M = Feb 28, Feb 29 − 1Y = Feb 28).
export function minusMonths(today: string, months: number): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) - months;
  const year = Math.floor(index / 12);
  const month = index - year * 12; // 0-based
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}
function minusDays(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
/** `earliest` is the first stored row date; ALL begins there when known. */
export function periodStart(period: Period, today: string, earliest?: string | null): string {
  switch (period) {
    case "1D": return minusDays(today, 1);
    case "1W": return minusDays(today, 7);
    case "1M": return minusMonths(today, 1);
    case "3M": return minusMonths(today, 3);
    case "YTD": return `${today.slice(0, 4)}-01-01`;
    case "1Y": return minusMonths(today, 12);
    case "ALL": return earliest && earliest <= today ? earliest : "2000-01-01";
  }
}

const RANK: Record<SeriesPoint["source"], number> = { reported: 0, reconstructed: 1, estimated: 2 };
export interface DailyRow { date: string; accountId: string; currency: string; value: number; source: SeriesPoint["source"] }
/**
 * One row per (account, date) by precedence reported > reconstructed > estimated; derived rows
 * on or after an account's first reported row are ignored. An account
 * with no row on a day inside its own [first, last] row window carries its last value (and
 * source) forward; it contributes nothing outside that window. Accounts are then summed, and a
 * date's source is the weakest source among its contributions.
 */
export function mergeDailyPoints(rows: DailyRow[], currency: string, from: string, today: string, todayValue: number | null): SeriesPoint[] {
  const { ordered, perAccount } = presence(rows, currency, from, today);
  const byDate = new Map<string, SeriesPoint>();
  for (const days of perAccount.values()) {
    for (const [date, carried] of days) {
      const existing = byDate.get(date);
      byDate.set(date, existing
        ? { date, value: existing.value + carried.value, source: RANK[carried.source] > RANK[existing.source] ? carried.source : existing.source }
        : { date, value: carried.value, source: carried.source });
    }
  }
  const points = ordered.map((d) => byDate.get(d)!);
  if (todayValue !== null) points.push({ date: today, value: todayValue, source: "reported" });
  return points;
}

/**
 * The series dates before today and, per account, the row it contributes on each of them (the
 * chosen row by precedence, carried forward inside the account's own [first, last] window).
 */
export interface Presence<R extends DailyRow = DailyRow> { ordered: string[]; perAccount: Map<string, Map<string, R>> }
export function presence<R extends DailyRow>(rows: R[], currency: string, from: string, today: string): Presence<R> {
  const chosenByAccount = new Map<string, Map<string, R>>();
  const dates = new Set<string>();
  // Derived rows only stand in for days before an account's first reported row (ruling F1);
  // after that, carry-forward bridges weekends and missed snapshots with the reported value.
  const firstReported = new Map<string, string>();
  for (const row of rows) {
    if (row.currency !== currency || row.source !== "reported") continue;
    const seen = firstReported.get(row.accountId);
    if (!seen || row.date < seen) firstReported.set(row.accountId, row.date);
  }
  for (const row of rows) {
    if (row.currency !== currency || row.date < from || row.date >= today) continue;
    const cutoff = firstReported.get(row.accountId);
    if (row.source !== "reported" && cutoff !== undefined && row.date >= cutoff) continue;
    let byDate = chosenByAccount.get(row.accountId);
    if (!byDate) chosenByAccount.set(row.accountId, (byDate = new Map()));
    const existing = byDate.get(row.date);
    if (!existing || RANK[row.source] < RANK[existing.source]) byDate.set(row.date, row);
    dates.add(row.date);
  }
  const ordered = [...dates].sort();
  const perAccount = new Map<string, Map<string, R>>();
  for (const [accountId, chosen] of chosenByAccount) {
    const first = [...chosen.keys()].reduce((a, b) => (a < b ? a : b));
    const last = [...chosen.keys()].reduce((a, b) => (a > b ? a : b));
    const days = new Map<string, R>();
    let carried: R | null = null;
    for (const date of ordered) {
      if (date < first || date > last) continue;
      carried = chosen.get(date) ?? carried;
      if (carried) days.set(date, carried);
    }
    perAccount.set(accountId, days);
  }
  return { ordered, perAccount };
}

export interface ValuedScope {
  /** Whether an account's flow dated `date` belongs in the portfolio series (valued before and on the day it lands). */
  inScope(accountId: string, date: string): boolean;
  /** Join (+first value) and leave (−last value, on the next series date) flows by date. */
  joinLeave: Map<string, number>;
  /** The same flows split: joins (+) and leaves (−). */
  joins: Map<string, number>;
  leaves: Map<string, number>;
  /** Some join or leave value comes from a row that is not brokerage-reported (brief 9, I3). */
  joinLeaveEstimated: boolean;
  /**
   * Whether a flow outside the valued window is already in the account's next join value: the account is first valued
   * within JOIN_GRACE_DAYS after it (a new account's first deposit, or one booked a day before the first row). Any
   * other flow outside the window is a gap in the account's history (spec 2026-10-29-incomplete-history).
   */
  joinCovers(accountId: string, date: string): boolean;
}

/** Days between a flow and the account's first valued date for the join value to be taken to include it. */
export const JOIN_GRACE_DAYS = 5;

/**
 * Portfolio scope (brief 6): each account is in the value series only on the dates it is valued
 * (its merged [first, last] row window, plus today when it has a value today and the series has a
 * today point). Joining after the span start is an inflow of its first value; leaving before the
 * span end is an outflow of its last value on the next series date. A flow lands on the first
 * series date on or after it (as computePerformance aligns it) and is in scope only when the
 * account is valued on that date and on the date before it: on a join date the join value already
 * includes that day's flows. `todayValues` holds the accounts valued today; pass null when the
 * series has no today point. Join and leave flows are only produced for `scopeIds` when given
 * (rows of other accounts still shape the series dates, as in mergeDailyPoints).
 */
export function valuedScope(rows: DailyRow[], currency: string, from: string, today: string, todayValues: Map<string, number> | null, scopeIds?: Set<string>): ValuedScope {
  return valuedScopeOf(presence(rows, currency, from, today), today, todayValues, scopeIds);
}

/** `valuedScope` over an already merged presence (the home-currency series builds its own in CAD). */
export function valuedScopeOf({ ordered, perAccount }: Presence, today: string, todayValues: Map<string, number> | null, scopeIds?: Set<string>): ValuedScope {
  const dates = todayValues ? [...ordered, today] : ordered;
  const valueOn = (accountId: string, date: string): number | null =>
    date === today ? todayValues?.get(accountId) ?? null : perAccount.get(accountId)?.get(date)?.value ?? null;
  // Today's values are the brokerage-reported totals.
  const reportedOn = (accountId: string, date: string): boolean =>
    date === today ? true : perAccount.get(accountId)?.get(date)?.source === "reported";
  const ids = [...new Set([...perAccount.keys(), ...(todayValues?.keys() ?? [])])].filter((id) => !scopeIds || scopeIds.has(id));
  const joinLeave = new Map<string, number>();
  const joins = new Map<string, number>();
  const leaves = new Map<string, number>();
  let joinLeaveEstimated = false;
  const add = (map: Map<string, number>, date: string, v: number) => {
    map.set(date, (map.get(date) ?? 0) + v);
    joinLeave.set(date, (joinLeave.get(date) ?? 0) + v);
  };
  for (const id of ids) {
    for (let i = 1; i < dates.length; i++) {
      const before = valueOn(id, dates[i - 1]), now = valueOn(id, dates[i]);
      if (before === null && now !== null) { add(joins, dates[i], now); if (!reportedOn(id, dates[i])) joinLeaveEstimated = true; }
      else if (before !== null && now === null) { add(leaves, dates[i], -before); if (!reportedOn(id, dates[i - 1])) joinLeaveEstimated = true; }
    }
  }
  const inScope = (accountId: string, date: string): boolean => {
    const i = dates.findIndex((d) => d >= date);
    if (i <= 0) return false; // on or before the span start, or after its end: never aligned
    return valueOn(accountId, dates[i - 1]) !== null && valueOn(accountId, dates[i]) !== null;
  };
  const graceEnd = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + JOIN_GRACE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const joinCovers = (accountId: string, date: string): boolean => {
    const limit = graceEnd(date);
    for (let i = dates.findIndex((d) => d >= date); i >= 0 && i < dates.length && dates[i] <= limit; i++) {
      if (valueOn(accountId, dates[i]) === null) continue;
      return i === 0 || valueOn(accountId, dates[i - 1]) === null;
    }
    return false;
  };
  return { inScope, joinLeave, joins, leaves, joinLeaveEstimated, joinCovers };
}

function asOf(series: PricePoint[], date: string): number | null {
  let value: number | null = null;
  for (const point of series) { if (point.date <= date) value = point.close; else break; }
  return value;
}

export async function benchmarkSeries(market: Pick<MarketDataService, "history" | "usdCad"> & Partial<Pick<MarketDataService, "distributions">>, key: BenchmarkKey, from: string, to: string, scopeCurrency = "CAD"): Promise<OverviewSeries["benchmark"]> {
  const definition = BENCHMARKS[key];
  const base = { key, name: definition.name, explainer: definition.explainer, basis: definition.basis };
  const prices = await benchmarkPrices(market, key, from, to);
  if (!prices || prices.length < 2) return { ...base, points: null, unavailableReason: "Benchmark data unavailable" };
  let cad: Array<{ date: string; value: number }> = prices.map((p) => ({ date: p.date, value: p.close }));
  if (definition.currency !== scopeCurrency) {
    // Only USD<->CAD is supported; any other scope currency has no comparable index here.
    if (!(scopeCurrency === "CAD" || scopeCurrency === "USD")) return { ...base, points: null, unavailableReason: "Exchange rate unavailable" };
    const fx = await market.usdCad(from, to);
    if (!fx || !fx.length) return { ...base, points: null, unavailableReason: "Exchange rate unavailable" };
    // Index points dated before the first Bank of Canada observation have no rate on or before
    // their date. Drop them when at least two points remain; otherwise fall back to the first
    // available rate so a short series is still shown.
    const covered = cad.filter((p) => p.date >= fx[0].date);
    if (covered.length >= 2) cad = covered;
    const toCad = definition.currency === "USD";
    cad = cad.map((p) => {
      const rate = asOf(fx, p.date) ?? fx[0].close;
      return { date: p.date, value: toCad ? p.value * rate : p.value / rate };
    });
  }
  const start = cad[0].value;
  return { ...base, points: cad.map((p) => ({ date: p.date, returnFraction: p.value / start - 1 })), unavailableReason: null };
}

/** Days of index history fetched before a period start so a baseline on or before it exists (F1). */
export const BENCHMARK_LEAD_DAYS = 10;
export const benchmarkFetchFrom = (from: string) => minusDays(from, BENCHMARK_LEAD_DAYS);

/**
 * Rebases index points onto a span (F1). The baseline is the last close on or before `start`, the
 * same close the portfolio's start value carries on a weekend or holiday; it is dated `start`.
 * Closes in (start, end] follow. With no close on or before `start`, the first close in the span
 * is the baseline. Returns null when fewer than two points remain.
 */
export function rebaseOnSpan<T extends { date: string; returnFraction: number }>(points: T[], start: string, end: string): Array<{ date: string; returnFraction: number }> | null {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const before = sorted.filter((p) => p.date <= start);
  const after = sorted.filter((p) => p.date > start && p.date <= end);
  const base = before.at(-1);
  const kept = base ? [{ date: start, returnFraction: base.returnFraction }, ...after] : after;
  if (kept.length < 2) return null;
  const level = 1 + kept[0].returnFraction;
  return kept.map((p) => ({ date: p.date, returnFraction: (1 + p.returnFraction) / level - 1 }));
}

/**
 * Restricts a benchmark series to the span [start, end], rebased on the last close on or before
 * `start` (see rebaseOnSpan). Fewer than two points means there is nothing to compare over that span.
 */
export function clipBenchmark(bench: OverviewSeries["benchmark"], start: string, end: string): OverviewSeries["benchmark"] {
  if (!bench.points) return bench;
  const points = rebaseOnSpan(bench.points, start, end);
  if (!points) return { ...bench, points: null, unavailableReason: bench.unavailableReason ?? "Benchmark data unavailable" };
  return { ...bench, points };
}
