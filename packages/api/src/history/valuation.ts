import type { MarketDataService } from "../market-data/market-data-service.js";
import type { SplitEvent } from "../market-data/types.js";
import type { DayState } from "./replay.js";

export interface ValuedDay { date: string; currency: string; value: number; source: "reconstructed" | "estimated" }
export interface Valuation {
  days: ValuedDay[];
  /** Held symbols with no provider ticker (options, crypto, unknown forms): those days are estimated. */
  missingSymbols: string[];
  /** Held symbols whose history (or split information) could not be fetched (ruling F2). */
  fetchFailed: string[];
  /** FX was needed (non-reporting-currency exposure) but unavailable (ruling F2). */
  fxFailed: boolean;
  /** Units on the last day after applying split ratios (ruling F3); reconciliation compares these. */
  finalUnits: Map<string, number>;
  /**
   * The last day's components in reporting currency (same conversions as that day's total), for
   * privacy-safe diagnostics. `usdCad` is that day's rate, or null when none was needed/available.
   */
  last: { holdings: number; cash: number; usdCad: number | null };
  /** True when at least one split ratio was applied to the replayed units. */
  splitsApplied: boolean;
  /** Count of symbols given an inferred opening lot (shares held before the activity history began). */
  inferredSymbols: number;
  /**
   * Cash applied by replay per diagnostic type key (see `cashTypeKey`), summed in reporting currency
   * at each day's FX, plus `FUNDS_CONVERSION_COUNTERPART` for synthesized conversion debits (H5).
   * For privacy-safe diagnostics only (callers log ratios, never these amounts).
   */
  cashByType: Map<string, number>;
  /**
   * Per held symbol on the last valued day: the close used (as-traded, in the assumed security
   * currency; null when none), that assumed currency, and whether the symbol was mapped with history
   * found. For privacy-safe price diagnostics only.
   */
  lastPrices: Map<string, { close: number | null; currency: string; mapped: boolean }>;
}

const EPS = 1e-9;
/** Broker fractional-share rounding can leave tiny negatives; only real shortfalls infer an opening lot. */
const INFER_TOLERANCE = 1e-6;
const MAX_STALE_DAYS = 7;
const CONCURRENCY = 4;
type Series = Array<{ date: string; close: number }>;

const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
/** Assumed security currency for a symbol with no reported one: Canadian listings are CAD, the rest USD. */
export const inferCurrency = (symbol: string) => (/\.(TO|V|NE|CN)$/i.test(symbol) ? "CAD" : "USD");

const LOOKBACK_DAYS = 10;
const shiftDate = (d: string, days: number) => new Date((dayNumber(d) + days) * 86_400_000).toISOString().slice(0, 10);

/** `at(date)`: last point on or before `date` (cursor advances; dates must ascend). `first`: earliest point. */
function makeLookup(series: Series) {
  const sorted = [...series].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let i = -1;
  const at = (date: string): { date: string; close: number } | null => {
    while (i + 1 < sorted.length && sorted[i + 1].date <= date) i++;
    return i >= 0 ? sorted[i] : null;
  };
  return { at, first: sorted[0] };
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Applies split ratios to replayed units on each ex-date (ruling F3). Activity units are
 * as-traded, so a day's own activity delta is added after that day's splits.
 */
export function applySplits(states: DayState[], splits: Map<string, SplitEvent[]>): DayState[] {
  if (splits.size === 0) return states;
  let prevRaw = new Map<string, number>();
  let prevAdj = new Map<string, number>();
  let prevDate: string | null = null;
  return states.map((s) => {
    const units = new Map<string, number>();
    // prevAdj too: raw units can reach 0 while split-adjusted units are still held.
    for (const symbol of new Set([...prevAdj.keys(), ...prevRaw.keys(), ...s.units.keys()])) {
      let carried = prevAdj.get(symbol) ?? 0;
      for (const e of splits.get(symbol) ?? []) if ((prevDate === null || e.date > prevDate) && e.date <= s.date) carried *= e.ratio;
      const v = carried + (s.units.get(symbol) ?? 0) - (prevRaw.get(symbol) ?? 0);
      if (Math.abs(v) >= EPS) units.set(symbol, v);
    }
    prevRaw = s.units;
    prevAdj = units;
    prevDate = s.date;
    return { ...s, units };
  });
}

/**
 * Opening-position inference. A symbol whose split-adjusted units go negative was held before the
 * activity history began. The smallest as-traded opening lot O at the first day keeping units >= 0 is
 * O = max(0, max_d(-units_d / factor_d)), with factor_d the product of split ratios with ex-date in
 * (start, d]; O x factor_d is added on every day. Cash is unchanged (no debit for shares that predate
 * the history). Option rows never reach `units` (excluded in replay), so they never trigger this.
 */
export function inferOpeningLots(states: DayState[], splits: Map<string, SplitEvent[]>): { states: DayState[]; inferred: Set<string> } {
  const inferred = new Set<string>();
  if (states.length === 0) return { states, inferred };
  const start = states[0].date;
  const factor = (symbol: string, date: string) => {
    let f = 1;
    for (const e of splits.get(symbol) ?? []) if (e.date > start && e.date <= date) f *= e.ratio;
    return f;
  };
  const lots = new Map<string, number>();
  for (const s of states) {
    for (const [symbol, u] of s.units) {
      if (u >= -INFER_TOLERANCE) continue;
      const o = -u / factor(symbol, s.date);
      if (o > (lots.get(symbol) ?? 0)) lots.set(symbol, o);
    }
  }
  for (const [symbol, o] of lots) if (o > INFER_TOLERANCE) inferred.add(symbol);
  if (inferred.size === 0) return { states, inferred };
  return {
    inferred,
    states: states.map((s) => {
      const units = new Map(s.units);
      for (const symbol of inferred) {
        const v = (units.get(symbol) ?? 0) + lots.get(symbol)! * factor(symbol, s.date);
        if (Math.abs(v) < EPS) units.delete(symbol);
        else units.set(symbol, v);
      }
      return { ...s, units };
    }),
  };
}

/** Reported conversion rate as USD/CAD, picking the quoting direction nearest the reference (M1). */
export function reportedUsdCad(fxRate: number | null | undefined, reference: number | null): number | null {
  if (fxRate === null || fxRate === undefined || !Number.isFinite(fxRate) || fxRate <= 0) return null;
  const inverse = 1 / fxRate;
  if (reference !== null) return Math.abs(fxRate - reference) <= Math.abs(inverse - reference) ? fxRate : inverse;
  return fxRate >= 1 ? fxRate : inverse;
}

export async function valueAccount(input: {
  states: DayState[];
  reportingCurrency: string;
  tickerFor(symbol: string, securityCurrency: string | null): string | null;
  securityCurrencies: Map<string, string | null>;
  market: Pick<MarketDataService, "securityHistory" | "usdCad">;
  /** Fetch window shared across accounts (ruling F4); defaults to first state − 10 days .. last state. */
  range?: { from: string; to: string };
  /** The account reports both conversion legs, so no counterpart debit is synthesized (M2). */
  twoSidedConversions?: boolean;
  /**
   * Price sanity guard: symbols valued at this brokerage-reported price (in `currency`), held
   * constant on every held day and marked estimated. No history is fetched and no split
   * de-adjustment applies; an overridden symbol is neither fetch-failed nor missing.
   */
  priceOverrides?: Map<string, { price: number; currency: string }>;
}): Promise<Valuation> {
  const { reportingCurrency, market } = input;
  const overrides = input.priceOverrides ?? new Map<string, { price: number; currency: string }>();
  const raw = input.states;
  if (raw.length === 0) return { days: [], missingSymbols: [], fetchFailed: [], fxFailed: false, finalUnits: new Map(), last: { holdings: 0, cash: 0, usdCad: null }, splitsApplied: false, inferredSymbols: 0, cashByType: new Map(), lastPrices: new Map() };
  const from = input.range?.from ?? shiftDate(raw[0].date, -LOOKBACK_DAYS);
  const to = input.range?.to ?? raw[raw.length - 1].date;

  const symbols = new Set<string>();
  for (const s of raw) for (const [k, u] of s.units) if (Math.abs(u) >= EPS) symbols.add(k);
  const secCur = (symbol: string) => input.securityCurrencies.get(symbol) ?? inferCurrency(symbol);

  const tickerOf = new Map<string, string>();
  const missing = new Set<string>();
  for (const symbol of symbols) {
    if (overrides.has(symbol)) continue;
    const t = input.tickerFor(symbol, secCur(symbol));
    if (t) tickerOf.set(symbol, t);
    else missing.add(symbol);
  }

  const byTicker = new Map<string, { points: Series; splits: SplitEvent[] } | null>();
  const notFound = new Set<string>(); // tickers the provider says do not exist: unmappable, not an outage
  const tickers = [...new Set(tickerOf.values())];
  await mapLimit(tickers, CONCURRENCY, async (t) => {
    const r = await market.securityHistory(t, from, to);
    if (r?.notFound) { notFound.add(t); return; }
    // No split information (fallback provider) cannot be valued against as-traded units (F3).
    byTicker.set(t, r && r.points.length && r.splits ? { points: r.points as Series, splits: r.splits } : null);
  });
  const lookups = new Map<string, ReturnType<typeof makeLookup>>(); // by symbol
  const splitsOf = new Map<string, SplitEvent[]>();
  const failed = new Set<string>();
  for (const [symbol, t] of tickerOf) {
    if (notFound.has(t)) { missing.add(symbol); continue; }
    const h = byTicker.get(t) ?? null;
    if (!h) { failed.add(symbol); continue; }
    lookups.set(symbol, makeLookup(h.points));
    if (h.splits.length) splitsOf.set(symbol, h.splits);
  }
  const { states, inferred } = inferOpeningLots(applySplits(raw, splitsOf), splitsOf);
  /** Yahoo closes are split-adjusted; scale back to as-traded terms for days before later splits. */
  const priceFactor = (symbol: string, date: string) => {
    let f = 1;
    for (const e of splitsOf.get(symbol) ?? []) if (e.date > date) f *= e.ratio;
    return f;
  };

  let fxNeeded = false;
  for (const s of states) {
    if (s.conversions.length) fxNeeded = true;
    for (const [symbol, u] of s.units) if (Math.abs(u) >= EPS && (overrides.get(symbol)?.currency ?? secCur(symbol)) !== reportingCurrency) fxNeeded = true;
    for (const [cur, amount] of s.cash) if (Math.abs(amount) >= EPS && cur !== reportingCurrency) fxNeeded = true;
    if (fxNeeded) break;
  }
  const fxSeries = fxNeeded ? ((await market.usdCad(from, to)) as Series | null) : null;
  const fxLookup = fxSeries && fxSeries.length ? makeLookup(fxSeries) : null;
  const fxFailed = fxNeeded && !fxLookup;
  /** USD/CAD for the day; `exact` false when only a later/absent rate was available. */
  const fxAt = (date: string): { rate: number | null; exact: boolean } => {
    if (!fxLookup) return { rate: null, exact: false };
    const p = fxLookup.at(date);
    if (!p) return { rate: fxLookup.first.close, exact: false };
    return { rate: p.close, exact: dayNumber(date) - dayNumber(p.date) <= MAX_STALE_DAYS };
  };

  const toReporting = (currency: string, amount: number, fx: { rate: number | null }): number | null => {
    if (currency === reportingCurrency) return amount;
    if (fx.rate === null) return null;
    if (currency === "USD" && reportingCurrency === "CAD") return amount * fx.rate;
    if (currency === "CAD" && reportingCurrency === "USD") return amount / fx.rate;
    return null;
  };

  const cashByType = new Map<string, number>();
  const addCashType = (key: string, currency: string, amount: number, fx: { rate: number | null }) => {
    const v = toReporting(currency, amount, fx);
    if (v !== null) cashByType.set(key, (cashByType.get(key) ?? 0) + v);
  };
  const adjustments = new Map<string, number>();
  let adjustmentEstimated = false;
  const days: ValuedDay[] = [];
  let last = { holdings: 0, cash: 0, usdCad: null as number | null };

  for (const s of states) {
    let estimated = adjustmentEstimated;
    const fx = fxAt(s.date);
    for (const d of s.cashDeltas ?? []) addCashType(d.key, d.currency, d.amount, fx);

    for (const c of input.twoSidedConversions ? [] : s.conversions) {
      const other = c.currency === "USD" ? "CAD" : c.currency === "CAD" ? "USD" : null;
      if (!other) continue;
      const reported = reportedUsdCad(c.fxRate, fx.rate);
      let rate: number;
      if (reported !== null) rate = reported;
      else {
        if (fx.rate === null) { estimated = true; adjustmentEstimated = true; continue; }
        if (!fx.exact) { estimated = true; adjustmentEstimated = true; }
        rate = fx.rate;
      }
      const debit = c.currency === "USD" ? c.amount * rate : c.amount / rate;
      adjustments.set(other, (adjustments.get(other) ?? 0) - debit);
      addCashType("FUNDS_CONVERSION_COUNTERPART", other, -debit, fx);
    }

    let total = 0;
    let holdings = 0;
    let cashValue = 0;
    const addValue = (currency: string, amount: number, part: "holdings" | "cash") => {
      const v = toReporting(currency, amount, fx);
      if (v === null) { estimated = true; return; }
      if (currency !== reportingCurrency && !fx.exact) estimated = true;
      total += v;
      if (part === "holdings") holdings += v; else cashValue += v;
    };

    for (const [symbol, units] of s.units) {
      if (Math.abs(units) < EPS) continue;
      if (inferred.has(symbol)) estimated = true; // includes shares held before the history began
      const override = overrides.get(symbol);
      if (override) { estimated = true; addValue(override.currency, units * override.price, "holdings"); continue; }
      const lookup = lookups.get(symbol);
      if (!lookup) { estimated = true; continue; }
      const p = lookup.at(s.date);
      if (!p) { estimated = true; continue; }
      if (dayNumber(s.date) - dayNumber(p.date) > MAX_STALE_DAYS) estimated = true;
      addValue(secCur(symbol), units * p.close * priceFactor(symbol, s.date), "holdings");
    }

    const currencies = new Set([...s.cash.keys(), ...adjustments.keys()]);
    for (const cur of currencies) {
      const amount = (s.cash.get(cur) ?? 0) + (adjustments.get(cur) ?? 0);
      if (Math.abs(amount) < EPS) continue;
      addValue(cur, amount, "cash");
    }

    days.push({ date: s.date, currency: reportingCurrency, value: total, source: estimated ? "estimated" : "reconstructed" });
    last = { holdings, cash: cashValue, usdCad: fx.rate };
  }

  const lastState = states[states.length - 1];
  const lastPrices = new Map<string, { close: number | null; currency: string; mapped: boolean }>();
  for (const [symbol, units] of lastState.units) {
    if (Math.abs(units) < EPS) continue;
    const override = overrides.get(symbol);
    if (override) { lastPrices.set(symbol, { close: override.price, currency: override.currency, mapped: false }); continue; }
    const lookup = lookups.get(symbol);
    const p = lookup ? lookup.at(lastState.date) : null;
    lastPrices.set(symbol, { close: p ? p.close * priceFactor(symbol, lastState.date) : null, currency: secCur(symbol), mapped: lookup !== undefined });
  }

  return {
    days,
    missingSymbols: [...missing].sort(),
    fetchFailed: [...failed].sort(),
    fxFailed,
    finalUnits: new Map(states[states.length - 1].units),
    last,
    splitsApplied: [...splitsOf.values()].some((list) => list.some((e) => e.date <= states[states.length - 1].date)),
    inferredSymbols: inferred.size,
    cashByType,
    lastPrices,
  };
}
