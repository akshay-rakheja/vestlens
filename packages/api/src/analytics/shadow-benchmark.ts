import { loadHomeConverter, type HomeConverter } from "../fx/home-currency.js";
import { cashDelta, unitsDelta } from "../history/sign-rules.js";
import type { StoredActivity } from "../history/stored-activity.js";
import { reportedUsdCad } from "../history/valuation.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import type { BenchmarkKey } from "../settings/settings-service.js";
import { BENCHMARKS, benchmarkPrices } from "./benchmarks.js";
import { solveRate } from "./performance.js";
import { benchmarkFetchFrom } from "./value-series.js";

/**
 * "Same money in the market" (spec §8, §11a.4). Every amount is CAD, from the user's side: a buy (or shares
 * arriving by transfer) is negative, a sale, a dividend received or shares leaving are positive. Replayed into a
 * benchmark, a negative flow buys benchmark units on its date and a positive one withdraws them.
 *
 * The benchmarks are the performance view's own series (`benchmarkPrices`). A total-return benchmark reinvests its
 * dividends, so mirroring a holding's dividend as a withdrawal is like for like; a price index earns none and reads
 * low against a holding that pays them.
 */
export type ShadowBenchmarkBasis = "total_return" | "price_index";
export const shadowBasis = (key: BenchmarkKey): ShadowBenchmarkBasis => (BENCHMARKS[key].totalReturn ? "total_return" : "price_index");

/** A close or rate older than this many days before a date is not used (7 is used, 8 is not). */
const MAX_STALE_DAYS = 7;
const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
const cents = (n: number) => Math.round(n * 100) / 100;
const upper = (s: string) => s.trim().toUpperCase();

export interface BenchmarkClose { date: string; closeCad: number; estimated?: boolean; rateDate?: string | null }
export interface ShadowFlow { date: string; amountCad: number; estimated?: boolean }

/**
 * A benchmark's daily closes in CAD. A USD index (S&P 500) converts at each date's Bank of Canada rate, the
 * nearest previous rate within 7 days, and is estimated; a date with no such rate is left out and listed. A CAD
 * index (TSX) is as reported. History is fetched with the performance view's lead days so a flow on the first
 * day has a close on or before it.
 */
export async function benchmarkClosesCad(
  market: Pick<MarketDataService, "history" | "usdCad"> & Partial<Pick<MarketDataService, "distributions">>, key: BenchmarkKey, from: string, to: string,
  /** A converter the caller already loaded (covering the fetched history), so the Bank of Canada series is read once. */
  converter?: HomeConverter,
): Promise<{ key: BenchmarkKey; basis: ShadowBenchmarkBasis; points: Array<Required<BenchmarkClose>>; notConverted: string[] }> {
  const definition = BENCHMARKS[key];
  const prices = (await benchmarkPrices(market, key, benchmarkFetchFrom(from), to)) ?? [];
  const sorted = prices.filter((p) => Number.isFinite(p.close) && p.close > 0).sort((a, b) => a.date.localeCompare(b.date));
  const base = { key, basis: shadowBasis(key) };
  if (definition.currency === "CAD") return { ...base, points: sorted.map((p) => ({ date: p.date, closeCad: p.close, estimated: false, rateDate: null })), notConverted: [] };
  const fx = converter ?? await loadHomeConverter(market, sorted[0]?.date ?? from, to);
  const points: Array<Required<BenchmarkClose>> = [];
  const notConverted: string[] = [];
  for (const p of sorted) {
    const at = fx.at(1, definition.currency, p.date);
    if (at.rate === null) { notConverted.push(p.date); continue; }
    points.push({ date: p.date, closeCad: cents(p.close * at.rate), estimated: true, rateDate: at.rateDate });
  }
  return { ...base, points, notConverted };
}

/**
 * Replays dated CAD flows into a benchmark: each flow on or before `asOf` buys (negative) or withdraws
 * (positive) units at the last close on or before its date (within 7 days), valued at the close on or before
 * `asOf`. Withdrawals may exceed the shadow when the holding outgrew the benchmark: the value is never clamped (a
 * negative value is the known public-market-equivalent artefact) and `shadowExhausted` is set whenever a
 * withdrawal took the shadow below zero, even if later buys refilled it. Consumers never print a negative shadow
 * value. Any flow, or `asOf`, without a close makes the value null and is listed in `uncovered`.
 */
export function replayIntoBenchmark(flows: ShadowFlow[], series: BenchmarkClose[], asOf: string): {
  valueCad: number | null; investedCad: number; withdrawnCad: number; estimated: boolean; uncovered: string[];
  shadowExhausted: boolean;
} {
  const points = series.filter((p) => Number.isFinite(p.closeCad) && p.closeCad > 0).sort((a, b) => a.date.localeCompare(b.date));
  const closeOn = (date: string): BenchmarkClose | null => {
    let found: BenchmarkClose | null = null;
    for (const p of points) { if (p.date <= date) found = p; else break; }
    return found && dayNumber(date) - dayNumber(found.date) <= MAX_STALE_DAYS ? found : null;
  };
  let units = 0, investedCad = 0, withdrawnCad = 0, estimated = false, shadowExhausted = false;
  const uncovered: string[] = [];
  for (const f of [...flows].sort((a, b) => a.date.localeCompare(b.date))) {
    if (f.date > asOf || !Number.isFinite(f.amountCad) || f.amountCad === 0) continue;
    const close = closeOn(f.date);
    if (!close) { uncovered.push(f.date); continue; }
    units -= f.amountCad / close.closeCad;
    if (units < -1e-9) shadowExhausted = true;
    if (f.amountCad < 0) investedCad -= f.amountCad; else withdrawnCad += f.amountCad;
    estimated ||= f.estimated === true || close.estimated === true;
  }
  const end = closeOn(asOf);
  if (!end) uncovered.push(asOf);
  else estimated ||= end.estimated === true;
  return { valueCad: uncovered.length > 0 || !end ? null : units * end.closeCad, investedCad: cents(investedCad), withdrawnCad: cents(withdrawnCad), estimated, uncovered, shadowExhausted };
}

/**
 * Money-weighted return (percent) from `startDate` to `opts.endDate`: the start value goes in, the flows strictly
 * after the start (user-side signs) follow, and the end value comes out. It is the period return over the span
 * (not annualised), solved with the performance view's solver. `opts.coverageStart` is the first date stored
 * activity covers; it is required, and null means coverage is unknown. A start before it, unknown coverage, or no
 * start value is never a number (Review Focus 2).
 */
export function returnSince(
  startDate: string, startValueCad: number | null, flows: ShadowFlow[], endValueCad: number,
  opts: { endDate: string; coverageStart: string | null },
): { pct: number | null; reason?: "no_start_value" | "no_coverage" | "no_solution" } {
  if (startValueCad === null || !Number.isFinite(startValueCad) || startValueCad < 0) return { pct: null, reason: "no_start_value" };
  // Fail closed: a missing value (an untyped caller) is unknown coverage too.
  if (typeof opts.coverageStart !== "string" || opts.coverageStart > startDate) return { pct: null, reason: "no_coverage" };
  const span = dayNumber(opts.endDate) - dayNumber(startDate);
  if (!(span > 0) || !Number.isFinite(endValueCad)) return { pct: null, reason: "no_solution" };
  const terms = [
    { t: 0, a: -startValueCad },
    ...flows.filter((f) => f.date > startDate && f.date <= opts.endDate && Number.isFinite(f.amountCad))
      .map((f) => ({ t: (dayNumber(f.date) - dayNumber(startDate)) / span, a: f.amountCad })),
    { t: 1, a: endValueCad },
  ];
  const r = solveRate(terms);
  return r === null ? { pct: null, reason: "no_solution" } : { pct: r * 100 };
}

export interface HoldingFlow {
  date: string;
  kind: "buy" | "sell" | "dividend" | "transfer_in" | "transfer_out";
  amountCad: number;
  /** Converted at the Bank of Canada rate (rateDate); a CAD row or one converted at its own fxRate is not. */
  estimated: boolean;
  rateDate: string | null;
  native: { amount: number; currency: string };
  /** Signed units this flow moved (in +, out −) as reported; 0 for a dividend, and 0 when a trade reported no units. */
  units: number;
}
/**
 * A row left out of the flows. `unitsMoved` is true when shares arrived or left without a recorded value (a trade
 * with no date, amount or rate, or a transfer with no date or price): the holding's value then holds shares no flow
 * explains, so no return can be worked out. A dividend with no date or no rate is cash only.
 */
export interface ExcludedFlow { date: string | null; reason: "no purchase date" | "no date" | "no amount" | "not converted"; unitsMoved: boolean }

const DIVIDEND_TYPES = new Set(["DIVIDEND", "DISTRIBUTION"]);

/**
 * The dated CAD flows of one holding from stored activity: trades, dividends (DIVIDEND, DISTRIBUTION) and in-kind
 * transfers, on or after `from`. Reinvested dividends and corporate actions move no cash and are not flows.
 * A trade or dividend converts at the activity's own fxRate, else at the Bank of Canada rate (est.); a foreign
 * amount with neither is listed as not converted, never guessed. A transfer without a date or cost is excluded
 * and listed ("can't compare: no purchase date"). `opts.currency` keeps one listing (CAD or US) only.
 */
export function holdingFlows(
  activities: StoredActivity[], symbol: string, from: string | undefined, opts: { fx: HomeConverter; currency?: string },
): { flows: HoldingFlow[]; excluded: ExcludedFlow[] } {
  const want = upper(symbol);
  const listing = opts.currency ? upper(opts.currency) : null;
  const flows: HoldingFlow[] = [];
  const excluded: ExcludedFlow[] = [];
  for (const a of activities) {
    if (a.isOption || !a.symbol || upper(a.symbol) !== want) continue;
    if (listing && upper(a.securityCurrency ?? a.currency ?? "") !== listing) continue;
    const type = a.type.toUpperCase();
    const date = a.tradeDate ?? a.settlementDate;
    if (date && from && date < from) continue;
    let kind: HoldingFlow["kind"];
    let native: number;
    let units = 0;
    if (type === "BUY" || type === "SELL") {
      kind = type === "BUY" ? "buy" : "sell";
      const cash = cashDelta(type, a.amount);
      const u = unitsDelta(type, a.units);
      units = u;
      native = cash !== 0 ? cash : a.price !== null && a.price > 0 && u !== 0 ? -u * a.price : 0;
      if (!date) { excluded.push({ date: null, reason: "no purchase date", unitsMoved: true }); continue; }
      if (native === 0) { excluded.push({ date, reason: "no amount", unitsMoved: true }); continue; }
    } else if (DIVIDEND_TYPES.has(type)) {
      kind = "dividend";
      native = cashDelta(type, a.amount);
      if (native === 0) continue;
      if (!date) { excluded.push({ date: null, reason: "no date", unitsMoved: false }); continue; }
    } else if (type === "TRANSFER") {
      const u = unitsDelta(type, a.units);
      if (u === 0) continue;
      kind = u > 0 ? "transfer_in" : "transfer_out";
      units = u;
      if (!date || a.price === null || !(a.price > 0)) { excluded.push({ date: date ?? null, reason: "no purchase date", unitsMoved: true }); continue; }
      native = -u * a.price;
    } else continue;
    const currency = upper(a.currency ?? a.securityCurrency ?? "");
    const converted = toCad(native, currency, date, a.fxRate, opts.fx);
    if (!converted) { excluded.push({ date, reason: "not converted", unitsMoved: kind !== "dividend" }); continue; }
    flows.push({ date, kind, ...converted, native: { amount: native, currency }, units });
  }
  flows.sort((x, y) => x.date.localeCompare(y.date));
  return { flows, excluded };
}

function toCad(amount: number, currency: string, date: string, fxRate: number | null, fx: HomeConverter): { amountCad: number; estimated: boolean; rateDate: string | null } | null {
  if (currency === "CAD") return { amountCad: cents(amount), estimated: false, rateDate: null };
  if (currency !== "USD") return null;
  const boc = fx.at(amount, currency, date);
  // A foreign row reported at exactly 1 means "no conversion recorded", not a rate (as in the TFSA room).
  if (fxRate !== null && Number.isFinite(fxRate) && fxRate > 0 && fxRate !== 1) {
    const rate = reportedUsdCad(fxRate, boc.rate);
    if (rate !== null) return { amountCad: cents(amount * rate), estimated: false, rateDate: null };
  }
  return boc.amount === null ? null : { amountCad: boc.amount, estimated: true, rateDate: boc.rateDate };
}
