import { BENCHMARKS } from "../analytics/benchmarks.js";
import type { HoldingFlow } from "../analytics/shadow-benchmark.js";
import type { HomeConverter } from "../fx/home-currency.js";
import type { StoredActivity } from "../history/stored-activity.js";
import type { SecurityHistory } from "../market-data/types.js";
import { freshDay, PRICE_STALE_TRADING_DAYS } from "../portfolio/data-freshness.js";
import {
  ACTIVITY_NOT_LOADED, ACTIVITY_NOT_RECORDED, activityStaleNote, bocNote, CHECK_NOTES, NO_FULL_HISTORY, NO_PURCHASE_RECORDED, noBenchmarkNote,
  SHARES_MOVED_UNVALUED, shadowExhaustedNote, UNITS_NOT_REPORTED, type HoldingCheck,
} from "../theses/thesis-check.js";

/**
 * The report card ("mirror"): a zero-input, facts-only view of the user's own decisions, from stored
 * activity and cached market data. Pure: the loader (report-loader.ts) reads; this works out the three sections.
 *
 * - Calls: each bought symbol's holding check since the first recorded purchase (theses/thesis-check.ts), compared
 *   with the S&P 500 by the same money in the index.
 * - After you sold: each sale against the latest cached close (split-adjusted), and "kept vs sold".
 * - What trading cost you: the value of trades converted between CAD and USD (a fact, from the amounts), an aggregate
 *   estimate of the conversion cost against that day's close at the Bank of Canada rate, and fees.
 *
 * Stored trade prices on a security in another currency are in the account's currency (activity/trade-price.ts; a
 * counts-only production audit on 2026-10-26 confirmed |amount| / (units × price) is near 1 for those rows). Every
 * figure that can't be worked out is counted under "couldn't tell" with its reason; nothing is guessed. Copy states
 * facts only.
 */

export const MAX_REPORT_SYMBOLS = 60;
export const REPORT_CONCURRENCY = 4;
/** A trade whose cash is further than this (relative) from its value at the Bank of Canada rate is a data issue. */
export const FX_GUARD = 0.1;
/** A sale price within this band (relative) of the nearby close; a local band (the shared 0.5–1.5 guard is wider). */
export const SALE_CLOSE_BAND = 0.2;
/** With no amount recorded, the currency reading of a sale price whose close agrees within this band is used. */
export const CURRENCY_READING_BAND = 0.15;
/** The conversion cost estimate is shown only over at least this many trades (single trades are noisy). */
export const MIN_ESTIMATE_ROWS = 20;
/** A close at most this many days before a sale. */
const SALE_CLOSE_DAYS = 7;
/** A close at most this many days before a converted trade, for the cost estimate. */
const TRADE_CLOSE_DAYS = 3;

/** A price history the loader didn't receive within the phase deadline. */
export const TIMED_OUT = "timed_out" as const;
export type HistoryEntry = SecurityHistory | null | typeof TIMED_OUT;

export const REASONS = {
  overCap: `more than ${MAX_REPORT_SYMBOLS} holdings bought; the ${MAX_REPORT_SYMBOLS} bought most recently are checked`,
  overCapSold: `more than ${MAX_REPORT_SYMBOLS} holdings sold; the ${MAX_REPORT_SYMBOLS} sold most recently are checked`,
  overCapTraded: `more than ${MAX_REPORT_SYMBOLS} holdings traded between CAD and USD; the ${MAX_REPORT_SYMBOLS} traded most recently are checked`,
  timedOut: "couldn't read in time",
  readFailed: "this holding's figures couldn't be read",
  notFound: "no purchase in an account counted here",
  saleNotRecorded: "the sale's units, price or date weren't recorded",
  saleCurrency: "the sale's currency wasn't recorded",
  saleCurrencyUnclear: "no amount recorded, and the sale price matches that day's close in neither currency",
  noHistory: "no price history for this symbol",
  noSplits: "the price history has no split information",
  noCloseAtSale: "no closing price within a week of the sale",
  priceMismatch: "the sale price is more than 20% from that day's close",
  staleClose: `the latest close is more than ${PRICE_STALE_TRADING_DAYS} trading days old`,
  noRate: "no Bank of Canada rate for that date",
  otherCurrency: "a currency other than Canadian or US dollars",
  rateOff: "the sale's amount and price disagree by more than 10% in either currency (likely a data issue)",
  tradeNotRecorded: "the trade's amount or date wasn't recorded",
  unitsNotRecorded: "the trade's units weren't recorded",
  noCloseNearTrade: "no closing price within 3 days of the trade",
  gapOff: "the trade is more than 10% from that day's close at the Bank of Canada rate (likely a data issue)",
  feeNotRecorded: "the fee amount wasn't recorded",
  feeCurrency: "the fee's currency wasn't recorded",
} as const;

/**
 * A fixed code per reason, for the log (counts and codes only, never the reason text, symbols or amounts). The code is
 * the log's contract: renaming a REASONS key leaves it alone.
 */
const REPORT_REASON_CODES: Record<keyof typeof REASONS, string> = {
  overCap: "over_cap", overCapSold: "over_cap_sold", overCapTraded: "over_cap_traded", timedOut: "timed_out", readFailed: "read_failed",
  notFound: "not_found", saleNotRecorded: "sale_not_recorded", saleCurrency: "sale_currency_missing", saleCurrencyUnclear: "sale_currency_unclear",
  noHistory: "no_history", noSplits: "no_splits", noCloseAtSale: "no_close_at_sale", priceMismatch: "price_mismatch", staleClose: "stale_close",
  noRate: "no_rate", otherCurrency: "other_currency", rateOff: "rate_off", tradeNotRecorded: "trade_not_recorded", unitsNotRecorded: "units_not_recorded",
  noCloseNearTrade: "no_close_near_trade", gapOff: "gap_off", feeNotRecorded: "fee_not_recorded", feeCurrency: "fee_currency_missing",
};
const stripPrefix = (reason: string) => reason.replace(/^can't (tell|compare):\s*/i, "");
/** The holding check's reasons (theses/thesis-check.ts, thesis-loader.ts), as the calls section passes them on. */
const CHECK_REASON_CODES = new Map<string, string>([
  [NO_PURCHASE_RECORDED, "no_purchase_recorded"],
  [NO_FULL_HISTORY, "no_full_history"],
  [stripPrefix(SHARES_MOVED_UNVALUED), "shares_moved_unvalued"],
  [ACTIVITY_NOT_RECORDED, "activity_not_recorded"],
  [ACTIVITY_NOT_LOADED, "activity_not_loaded"],
  [UNITS_NOT_REPORTED, "units_not_reported"],
  [CHECK_NOTES.noSolution, "not_enough_data"],
  [CHECK_NOTES.listings, "multiple_listings"],
  [CHECK_NOTES.syncError, "sync_error"],
  [CHECK_NOTES.noStart, "no_start_value"],
  [CHECK_NOTES.noEnd, "no_current_value"],
  [CHECK_NOTES.stale, "stale_price"],
  [shadowExhaustedNote(BENCHMARKS.sp500.name), "sales_exceed_index"],
  [noBenchmarkNote(BENCHMARKS.sp500.name), "no_index_close"],
]);
const ACTIVITY_STALE = new RegExp(`^${activityStaleNote("\\d{4}-\\d{2}-\\d{2}").replace(/[.;]/g, "\\$&")}$`);
const CODE_BY_REASON = new Map<string, string>([
  ...(Object.entries(REASONS) as Array<[keyof typeof REASONS, string]>).map(([key, text]) => [text, REPORT_REASON_CODES[key]] as [string, string]),
  ...CHECK_REASON_CODES,
]);
/** "No S&P 500 comparison": the calls section's own fallback when the engine gives no S&P 500 note. */
export const NO_SP500_COMPARISON = "no S&P 500 comparison for this period";
CODE_BY_REASON.set(NO_SP500_COMPARISON, "no_index_comparison");

/** The fixed code of a couldn't-tell reason; "other" for a reason this list doesn't know yet. */
export function reasonCode(reason: string): string {
  const text = stripPrefix(reason);
  return CODE_BY_REASON.get(text) ?? (ACTIVITY_STALE.test(text) ? "activity_stale" : "other");
}

/** A section's couldn't-tell as counts per code (reasons that share a code are summed). */
export function cantTellCodes(cantTell: CantTell): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of cantTell.reasons) { const c = reasonCode(r.reason); out[c] = (out[c] ?? 0) + r.count; }
  return out;
}

export interface CantTell { count: number; reasons: Array<{ reason: string; count: number; symbols: string[] }> }

const upper = (s: string) => s.trim().toUpperCase();
const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const r2 = (n: number) => Math.round(n * 100) / 100;
const cents = r2;
const dateOf = (a: StoredActivity) => a.tradeDate ?? a.settlementDate;
const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
const isTrade = (a: StoredActivity) => !a.isOption && (a.type.toUpperCase() === "BUY" || a.type.toUpperCase() === "SELL");
/** A BUY or SELL in a security whose currency differs from the account's (both known). */
export const isConverted = (a: StoredActivity) =>
  isTrade(a) && !!a.securityCurrency && !!a.currency && upper(a.securityCurrency) !== upper(a.currency);

/** Collects "couldn't tell" rows by reason, in order of first appearance. */
class CantTellCounter {
  private readonly byReason = new Map<string, string[]>();
  add(reason: string, symbol: string | null) {
    const list = this.byReason.get(reason) ?? [];
    list.push(symbol ?? "");
    this.byReason.set(reason, list);
  }
  result(): CantTell {
    const reasons = [...this.byReason].map(([reason, symbols]) => ({ reason, count: symbols.length, symbols: [...new Set(symbols.filter(Boolean))] }));
    return { count: reasons.reduce((a, r) => a + r.count, 0), reasons };
  }
}

/**
 * Upper-cased symbols of the rows that `pick` keeps (options excluded), most recent first, at most `max`; the rest are
 * `overCap` (sorted).
 */
function recentSymbols(rows: StoredActivity[], pick: (a: StoredActivity) => boolean, max: number): { symbols: string[]; overCap: string[] } {
  const latest = new Map<string, string>();
  for (const a of rows) {
    if (a.isOption || !a.symbol || !pick(a)) continue;
    const s = upper(a.symbol);
    if (!s) continue;
    const d = dateOf(a) ?? "";
    if (!latest.has(s) || d > latest.get(s)!) latest.set(s, d);
  }
  const ordered = [...latest].sort(([sa, da], [sb, db]) => (da === db ? sa.localeCompare(sb) : da < db ? 1 : -1)).map(([s]) => s);
  return { symbols: ordered.slice(0, max), overCap: ordered.slice(max).sort() };
}

/** Every symbol bought (BUY rows), the most recently bought first, at most `max`. */
export const boughtSymbols = (rows: StoredActivity[], max = MAX_REPORT_SYMBOLS) => recentSymbols(rows, (a) => a.type.toUpperCase() === "BUY", max);
/** Every symbol sold (SELL rows), the most recently sold first, at most `max`: their price histories are read. */
export const soldSymbols = (rows: StoredActivity[], max = MAX_REPORT_SYMBOLS) => recentSymbols(rows, (a) => a.type.toUpperCase() === "SELL", max);
/** Every symbol traded between CAD and USD, the most recently traded first, at most `max`: their histories are read. */
export const convertedSymbols = (rows: StoredActivity[], max = MAX_REPORT_SYMBOLS) => recentSymbols(rows, isConverted, max);

/* ---------------------------------------------------------------------------------------------------------------
 * Calls against the market
 * ------------------------------------------------------------------------------------------------------------- */

/**
 * `buysBeforeSales`: every purchase in the holding's flows comes before its first sale or dividend. Then, when the
 * engine reports the S&P 500 shadow exhausted (the sales took out more than the same money in the index was worth),
 * the holding came out ahead: the index units the sales and dividends would need exceed the units the purchases
 * bought (a public-market-equivalent ratio above 1). It is counted ahead, without a figure.
 */
export type CallOutcome =
  | { symbol: string; check: HoldingCheck["sinceFirstBought"] | null; buysBeforeSales?: boolean }
  | { symbol: string; failed: true }
  | { symbol: string; timedOut: true };
export interface CallRow {
  symbol: string; returnPct: number; vsSp500Pct: number; vsTsxPct: number | null; startDate: string; endDate: string; estimated: boolean;
  /** The latest Bank of Canada rate date behind a converted figure (est.); null when none was converted. */
  rateDate: string | null;
}
/** Ahead of the S&P 500 by more than the comparison can put a number on (see CallOutcome). */
export type UnmeasuredAhead = Omit<CallRow, "vsSp500Pct" | "vsTsxPct">;
export interface CallsSection {
  /** Symbols checked (outcomes given, the capped ones not included). */
  checked: number;
  /** Every holding with an S&P 500 comparison figure, best first. */
  items: CallRow[];
  summary: {
    /** Holdings with a known direction against the S&P 500 (items plus aheadUnmeasured). */
    compared: number; ahead: number; behind: number; even: number;
    /** Best and worst by vsSp500Pct, among the items with a figure. */
    best: CallRow | null; worst: CallRow | null;
    aheadUnmeasured: UnmeasuredAhead[];
  };
  cantTell: CantTell;
}

/** Every acquiring flow (money in) is on or before the first outgoing one (money out). */
export function buysBeforeSales(flows: HoldingFlow[]): boolean {
  const out = flows.filter((f) => f.amountCad > 0).map((f) => f.date).sort()[0];
  return out === undefined || !flows.some((f) => f.amountCad < 0 && f.date > out);
}

const SP500_EXHAUSTED = shadowExhaustedNote(BENCHMARKS.sp500.name);
/** The rate date of the holding check's own Bank of Canada note, when it carries one. */
function noteRateDate(notes: string[]): string | null {
  for (const n of notes) {
    const d = /(\d{4}-\d{2}-\d{2})\.$/.exec(n)?.[1];
    if (d && n === bocNote(d)) return d;
  }
  return null;
}

export function callsSection(outcomes: CallOutcome[], overCap: string[] = []): CallsSection {
  const items: CallRow[] = [];
  const unmeasured: UnmeasuredAhead[] = [];
  const cant = new CantTellCounter();
  for (const o of outcomes) {
    if ("failed" in o) { cant.add(REASONS.readFailed, o.symbol); continue; }
    if ("timedOut" in o) { cant.add(REASONS.timedOut, o.symbol); continue; }
    const c = o.check;
    if (!c) { cant.add(REASONS.notFound, o.symbol); continue; }
    if (c.returnPct === null || !c.startDate || !c.endDate) { cant.add(stripPrefix(c.reason ?? REASONS.readFailed), o.symbol); continue; }
    const base = { symbol: o.symbol, returnPct: r2(c.returnPct), startDate: c.startDate, endDate: c.endDate, estimated: c.estimated, rateDate: noteRateDate(c.notes) };
    if (c.vsSp500Pct === null && o.buysBeforeSales === true && c.notes.includes(SP500_EXHAUSTED)) { unmeasured.push(base); continue; }
    if (c.vsSp500Pct === null) {
      // The engine's own note says why (no close for every date, or sales larger than the same money in the index).
      cant.add(c.notes.find((n) => n.includes("S&P 500")) ?? NO_SP500_COMPARISON, o.symbol);
      continue;
    }
    items.push({ ...base, vsSp500Pct: r2(c.vsSp500Pct), vsTsxPct: c.vsTsxPct === null ? null : r2(c.vsTsxPct) });
  }
  for (const s of overCap) cant.add(REASONS.overCap, s);
  items.sort((a, b) => b.vsSp500Pct - a.vsSp500Pct || a.symbol.localeCompare(b.symbol));
  return {
    checked: outcomes.length,
    items,
    summary: {
      compared: items.length + unmeasured.length,
      ahead: items.filter((i) => i.vsSp500Pct > 0).length + unmeasured.length,
      behind: items.filter((i) => i.vsSp500Pct < 0).length,
      even: items.filter((i) => i.vsSp500Pct === 0).length,
      best: items[0] ?? null,
      worst: items.at(-1) ?? null,
      aheadUnmeasured: unmeasured.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    },
    cantTell: cant.result(),
  };
}

/* ---------------------------------------------------------------------------------------------------------------
 * Shared: Bank of Canada pair rates and split-adjusted closes
 * ------------------------------------------------------------------------------------------------------------- */

type PairRate = { ok: true; rowPerSecurity: number; usdCad: number; rateDate: string } | { ok: false; reason: string };

/** The Bank of Canada rate on `date` as row-currency units per security-currency unit (USD/CAD pairs only). */
function pairRate(row: string, security: string, date: string, fx: HomeConverter): PairRate {
  if (!((row === "CAD" && security === "USD") || (row === "USD" && security === "CAD"))) return { ok: false, reason: REASONS.otherCurrency };
  const at = fx.at(1, "USD", date);
  if (at.rate === null || at.rateDate === null) return { ok: false, reason: REASONS.noRate };
  return { ok: true, rowPerSecurity: row === "CAD" ? at.rate : 1 / at.rate, usdCad: at.rate, rateDate: at.rateDate };
}

const within = (value: number, target: number, band: number) => Math.abs(value / target - 1) <= band;

/** The cash of a BUY (paid) or SELL (received), net of a reported fee, in the row currency; null when not recorded. */
function netCash(a: StoredActivity, buy: boolean): number | null {
  if (!finite(a.amount) || a.amount === 0) return null;
  const fee = finite(a.fee) ? Math.abs(a.fee) : 0;
  return buy ? Math.abs(a.amount) - fee : Math.abs(a.amount) + fee;
}

interface Closes { points: Array<{ date: string; close: number }>; factorAfter(date: string): number }

/**
 * A security's closes, split-adjusted as market-data securityHistory returns them: a close is worth the product of
 * the later splits' ratios in shares as traded on its date.
 */
function closesOf(h: HistoryEntry | undefined): Closes | { reason: string } {
  if (h === TIMED_OUT) return { reason: REASONS.timedOut };
  const points = (h && !h.notFound ? h.points : []).filter((p) => finite(p.close) && p.close > 0).sort((x, y) => x.date.localeCompare(y.date));
  if (!h || points.length === 0) return { reason: REASONS.noHistory };
  if (h.splits === null) return { reason: REASONS.noSplits };
  const splits = h.splits.filter((s) => finite(s.ratio) && s.ratio > 0);
  return { points, factorAfter: (d) => splits.filter((s) => s.date > d).reduce((acc, s) => acc * s.ratio, 1) };
}

/** The close on or before `date`, at most `maxDays` older, as traded then (split factor applied); null when none. */
function closeAsTraded(c: Closes, date: string, maxDays: number): { date: string; close: number } | null {
  const p = c.points.filter((x) => x.date <= date).at(-1);
  if (!p || dayNumber(date) - dayNumber(p.date) > maxDays) return null;
  return { date: p.date, close: p.close * c.factorAfter(p.date) };
}

/* ---------------------------------------------------------------------------------------------------------------
 * After you sold
 * ------------------------------------------------------------------------------------------------------------- */

export interface SaleRow {
  symbol: string; date: string; units: number;
  /** In the security's currency; estimated when converted from the account currency at `priceRateDate`. */
  salePrice: number; currency: string; estimated: boolean; priceRateDate: string | null;
  /** The price as recorded, when it was in the account's currency and converted. */
  recordedPrice: { amount: number; currency: string } | null;
  latestClose: number; latestCloseDate: string;
  /** With a split since the sale: the latest close on the sale's share basis (latest close × splits since). */
  latestCloseSplitAdjusted?: number;
  /** The price change from the sale price to the latest close, split-adjusted, in percent. */
  changePct: number;
  /** units × (latest close × splits since − sale price), in the security's currency and in CAD. */
  keptVsSold: { native: { amount: number; currency: string }; cad: number | null; estimated: boolean; rateDate: string | null };
}
export interface AfterSoldSection {
  items: SaleRow[];
  summary: {
    sells: number; rose: number; fell: number; unchanged: number;
    /** The sum of the converted kept-vs-sold amounts; null when there are none. */
    keptVsSoldCad: number | null; estimated: boolean; rateDate: string | null;
    /** Sales with a price change but no CAD amount (no rate for the latest close's date). */
    notConverted: number;
    /** Kept vs sold in each non-CAD security currency, before conversion. */
    native: Array<{ currency: string; amount: number }>;
  };
  cantTell: CantTell;
}

type SalePrice = { price: number; currency: string; estimated: boolean; rateDate: string | null; recorded: { amount: number; currency: string } | null };

/**
 * The sale price in the security's currency. Across currencies, the amount says which currency the price is in:
 * near the Bank of Canada rate, the security's; near 1, the account's (the norm), converted at the Bank of Canada rate
 * (est.). With no amount, the reading whose sale-day close agrees within CURRENCY_READING_BAND is used.
 */
function salePriceOf(a: StoredActivity, fx: HomeConverter, units: number, price: number, date: string, atSale: number): SalePrice | { reason: string } {
  const security = a.securityCurrency ? upper(a.securityCurrency) : a.currency ? upper(a.currency) : null;
  if (!security) return { reason: REASONS.saleCurrency };
  const row = a.currency ? upper(a.currency) : security;
  if (row === security) return { price, currency: security, estimated: false, rateDate: null, recorded: null };
  const pair = pairRate(row, security, date, fx);
  if (!pair.ok) return { reason: pair.reason };
  const asSecurity: SalePrice = { price, currency: security, estimated: false, rateDate: null, recorded: null };
  const asRow: SalePrice = { price: price / pair.rowPerSecurity, currency: security, estimated: true, rateDate: pair.rateDate, recorded: { amount: price, currency: row } };
  const cash = netCash(a, false);
  if (cash !== null) {
    const implied = cash / (units * price);
    if (within(implied, 1, FX_GUARD)) return asRow;
    if (within(implied, pair.rowPerSecurity, FX_GUARD)) return asSecurity;
    return { reason: REASONS.rateOff };
  }
  const rowFits = within(atSale, asRow.price, CURRENCY_READING_BAND);
  const securityFits = within(atSale, asSecurity.price, CURRENCY_READING_BAND);
  if (rowFits && securityFits) return Math.abs(atSale / asRow.price - 1) <= Math.abs(atSale / asSecurity.price - 1) ? asRow : asSecurity;
  if (rowFits) return asRow;
  if (securityFits) return asSecurity;
  return { reason: REASONS.saleCurrencyUnclear };
}

/**
 * Each SELL row with a symbol, units, price and date, against the latest close of its symbol's history (keyed by
 * upper-cased symbol). The sale is checked against the as-traded close near its date (within SALE_CLOSE_BAND), and the
 * kept units grow by the splits since. Kept vs sold converts at the Bank of Canada rate on the latest close's date (est.).
 */
export function afterSoldSection(
  rows: StoredActivity[], histories: Map<string, HistoryEntry>, fx: HomeConverter, today: string, overCap: Set<string> = new Set(),
): AfterSoldSection {
  const items: SaleRow[] = [];
  const cant = new CantTellCounter();
  for (const a of rows) {
    if (a.isOption || !a.symbol || a.type.toUpperCase() !== "SELL") continue;
    const symbol = upper(a.symbol);
    if (overCap.has(symbol)) { cant.add(REASONS.overCapSold, symbol); continue; }
    const date = dateOf(a);
    if (!date || !finite(a.units) || a.units === 0 || !finite(a.price) || !(a.price > 0)) { cant.add(REASONS.saleNotRecorded, symbol); continue; }
    const units = Math.abs(a.units);
    const closes = closesOf(histories.get(symbol));
    if ("reason" in closes) { cant.add(closes.reason, symbol); continue; }
    const atSale = closeAsTraded(closes, date, SALE_CLOSE_DAYS);
    if (!atSale) { cant.add(REASONS.noCloseAtSale, symbol); continue; }
    const sale = salePriceOf(a, fx, units, a.price, date, atSale.close);
    if ("reason" in sale) { cant.add(sale.reason, symbol); continue; }
    if (!within(atSale.close, sale.price, SALE_CLOSE_BAND)) { cant.add(REASONS.priceMismatch, symbol); continue; }
    const latest = closes.points.at(-1)!;
    if (!freshDay(latest.date, today)) { cant.add(REASONS.staleClose, symbol); continue; }

    const keptPrice = latest.close * closes.factorAfter(date);
    const converted = fx.at(units * (keptPrice - sale.price), sale.currency, latest.date);
    items.push({
      symbol, date, units, salePrice: sale.price, currency: sale.currency, estimated: sale.estimated, priceRateDate: sale.rateDate, recordedPrice: sale.recorded,
      latestClose: latest.close, latestCloseDate: latest.date, ...(keptPrice !== latest.close ? { latestCloseSplitAdjusted: r2(keptPrice) } : {}), changePct: r2((keptPrice / sale.price - 1) * 100),
      keptVsSold: {
        native: { amount: r2(units * (keptPrice - sale.price)), currency: sale.currency }, cad: converted.amount,
        estimated: converted.estimated || (converted.amount !== null && sale.estimated), rateDate: converted.rateDate ?? sale.rateDate,
      },
    });
  }
  items.sort((x, y) => (x.date === y.date ? x.symbol.localeCompare(y.symbol) : x.date < y.date ? 1 : -1));

  const convertedItems = items.filter((i) => i.keptVsSold.cad !== null);
  const native = new Map<string, number>();
  for (const i of convertedItems) if (i.currency !== "CAD") native.set(i.currency, (native.get(i.currency) ?? 0) + i.keptVsSold.native.amount);
  return {
    items,
    summary: {
      sells: items.length,
      rose: items.filter((i) => i.changePct > 0).length,
      fell: items.filter((i) => i.changePct < 0).length,
      unchanged: items.filter((i) => i.changePct === 0).length,
      keptVsSoldCad: convertedItems.length > 0 ? cents(convertedItems.reduce((s, i) => s + i.keptVsSold.cad!, 0)) : null,
      estimated: convertedItems.some((i) => i.keptVsSold.estimated),
      rateDate: convertedItems.map((i) => i.keptVsSold.rateDate).filter((d): d is string => d !== null).sort().at(-1) ?? null,
      notConverted: items.length - convertedItems.length,
      native: [...native].sort(([x], [y]) => x.localeCompare(y)).map(([currency, amount]) => ({ currency, amount: cents(amount) })),
    },
    cantTell: cant.result(),
  };
}

/* ---------------------------------------------------------------------------------------------------------------
 * What trading cost you
 * ------------------------------------------------------------------------------------------------------------- */

export interface TradingCostSection {
  conversion: {
    /** BUY and SELL rows in a security whose currency differs from the account's, with an amount and date. */
    rows: number;
    /** Their total value in CAD, from the recorded amounts (USD-account amounts converted at the Bank of Canada rate, est.). */
    convertedCad: number;
    estimated: boolean;
    rateDate: string | null;
    /** Amounts recorded in a currency other than CAD, before conversion. */
    native: Array<{ currency: string; amount: number }>;
    /** Converted trades that couldn't be counted. */
    cantTell: CantTell;
    /**
     * The conversion cost against that day's close at the Bank of Canada rate, summed over the usable trades; null
     * below MIN_ESTIMATE_ROWS. Aggregate only: a single trade's figure carries that day's price move.
     */
    estimate: {
      rows: number; minRows: number; costCad: number | null; sharePct: number | null; estimated: true;
      rateDates: { first: string; last: string } | null; cantTell: CantTell;
    };
  };
  fees: {
    /** FEE rows and rows with a non-zero fee. */
    rows: number;
    totalCad: number;
    estimated: boolean;
    rateDate: string | null;
    /** The non-CAD fees before conversion. */
    native: Array<{ currency: string; amount: number }>;
    cantTell: CantTell;
  };
}

export function tradingCostSection(
  rows: StoredActivity[], fx: HomeConverter, histories: Map<string, HistoryEntry> = new Map(), overCap: Set<string> = new Set(),
): TradingCostSection {
  return { conversion: conversionOf(rows, fx, histories, overCap), fees: feesOf(rows, fx) };
}

/**
 * The value: |amount| of each converted trade, in CAD. The estimate, per usable trade: a buy pays cash − units × close
 * × BoC, a sale receives units × close × BoC − cash (cash net of the fee), with that day's as-traded close in the
 * security's currency; trades more than FX_GUARD from that are left out.
 */
function conversionOf(rows: StoredActivity[], fx: HomeConverter, histories: Map<string, HistoryEntry>, overCap: Set<string>): TradingCostSection["conversion"] {
  const cant = new CantTellCounter();
  const estCant = new CantTellCounter();
  let count = 0, value = 0, estimated = false;
  let rateDate: string | null = null;
  const native = new Map<string, number>();
  let usable = 0, cost = 0, compared = 0;
  const dates: string[] = [];
  for (const a of rows) {
    if (!isConverted(a)) continue;
    const security = upper(a.securityCurrency!);
    const row = upper(a.currency!);
    const symbol = a.symbol ? upper(a.symbol) : null;
    const date = dateOf(a);
    if (!date || !finite(a.amount) || a.amount === 0) { cant.add(REASONS.tradeNotRecorded, symbol); continue; }
    const pair = pairRate(row, security, date, fx);
    if (!pair.ok && pair.reason === REASONS.otherCurrency) { cant.add(pair.reason, symbol); continue; }
    const at = fx.at(Math.abs(a.amount), row, date);
    if (at.amount === null) { cant.add(REASONS.noRate, symbol); continue; }
    count++;
    value += at.amount;
    if (at.estimated) {
      estimated = true;
      native.set(row, (native.get(row) ?? 0) + Math.abs(a.amount));
      if (at.rateDate && (rateDate === null || at.rateDate > rateDate)) rateDate = at.rateDate;
    }

    // The estimate, from the security's own close that day.
    if (symbol && overCap.has(symbol)) { estCant.add(REASONS.overCapTraded, symbol); continue; }
    if (!finite(a.units) || a.units === 0) { estCant.add(REASONS.unitsNotRecorded, symbol); continue; }
    if (!pair.ok) { estCant.add(pair.reason, symbol); continue; }
    const closes = closesOf(symbol ? histories.get(symbol) : undefined);
    if ("reason" in closes) { estCant.add(closes.reason, symbol); continue; }
    const close = closeAsTraded(closes, date, TRADE_CLOSE_DAYS);
    if (!close) { estCant.add(REASONS.noCloseNearTrade, symbol); continue; }
    const buy = a.type.toUpperCase() === "BUY";
    const cash = netCash(a, buy)!;
    const atBoc = Math.abs(a.units) * close.close * pair.rowPerSecurity;
    if (!within(cash, atBoc, FX_GUARD)) { estCant.add(REASONS.gapOff, symbol); continue; }
    const toCad = row === "CAD" ? 1 : pair.usdCad;
    usable++;
    cost += (buy ? cash - atBoc : atBoc - cash) * toCad;
    compared += atBoc * toCad;
    dates.push(pair.rateDate);
  }
  dates.sort();
  const shown = usable >= MIN_ESTIMATE_ROWS;
  return {
    rows: count, convertedCad: cents(value), estimated, rateDate,
    native: [...native].sort(([x], [y]) => x.localeCompare(y)).map(([currency, amount]) => ({ currency, amount: cents(amount) })),
    cantTell: cant.result(),
    estimate: {
      rows: usable, minRows: MIN_ESTIMATE_ROWS, costCad: shown ? cents(cost) : null, sharePct: shown && compared > 0 ? (cost / compared) * 100 : null, estimated: true,
      rateDates: dates.length > 0 ? { first: dates[0]!, last: dates.at(-1)! } : null, cantTell: estCant.result(),
    },
  };
}

/** FEE rows (the amount, negative when charged) and any other row's non-zero `fee`, in the row currency. */
function feesOf(rows: StoredActivity[], fx: HomeConverter): TradingCostSection["fees"] {
  const cant = new CantTellCounter();
  let count = 0, total = 0, estimated = false;
  let rateDate: string | null = null;
  const native = new Map<string, number>();
  for (const a of rows) {
    if (a.isOption) continue;
    const symbol = a.symbol ? upper(a.symbol) : null;
    let fee: number;
    if (a.type.toUpperCase() === "FEE") {
      if (finite(a.amount) && a.amount !== 0) fee = -a.amount;
      else if (finite(a.fee) && a.fee !== 0) fee = Math.abs(a.fee);
      else { cant.add(REASONS.feeNotRecorded, symbol); continue; }
    } else if (finite(a.fee) && a.fee !== 0) {
      fee = Math.abs(a.fee);
    } else continue;
    const currency = a.currency ? upper(a.currency) : null;
    if (!currency) { cant.add(REASONS.feeCurrency, symbol); continue; }
    const date = dateOf(a);
    const at = currency === "CAD" ? fx.at(fee, "CAD") : date ? fx.at(fee, currency, date) : null;
    if (!at || at.amount === null) { cant.add(currency === "USD" ? REASONS.noRate : REASONS.otherCurrency, symbol); continue; }
    count++;
    total += at.amount;
    if (at.estimated) {
      estimated = true;
      native.set(currency, (native.get(currency) ?? 0) + fee);
      if (at.rateDate && (rateDate === null || at.rateDate > rateDate)) rateDate = at.rateDate;
    }
  }
  return {
    rows: count, totalCad: cents(total), estimated, rateDate,
    native: [...native].sort(([x], [y]) => x.localeCompare(y)).map(([currency, amount]) => ({ currency, amount: cents(amount) })),
    cantTell: cant.result(),
  };
}
