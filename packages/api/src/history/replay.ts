import { cashDelta, unitsDelta } from "./sign-rules.js";
import type { StoredActivity } from "./stored-activity.js";

export type HistoryMethod = "reconstructed" | "snapshots_only";

export interface DayState {
  date: string;
  units: Map<string, number>;
  /**
   * Cumulative cash by currency. Excludes the counterpart debit of
   * FUNDS_CONVERSION (only the credited leg is reported); see `conversions`
   * and ruling H5. `amount` is assumed to already include `fee`.
   */
  cash: Map<string, number>;
  /**
   * FUNDS_CONVERSION credits that occurred ON this day (not cumulative); valuation debits the
   * counterpart (ruling H5), at the activity's reported `fxRate` when present (M1).
   */
  conversions: Array<{ currency: string; amount: number; fxRate?: number | null }>;
  /**
   * Non-zero cash deltas applied ON this day (not cumulative), keyed by `cashTypeKey`, for the
   * privacy-safe cash-by-type diagnostic. Optional so hand-built states need not carry it.
   */
  cashDeltas?: Array<{ key: string; currency: string; amount: number }>;
}

const TYPE_NAME = /^[A-Z_]{1,40}$/;
/** Diagnostic key for a cash delta: provider enum name (else OTHER), prefixed `OPTION:` for option rows. */
export function cashTypeKey(type: string, option: boolean): string {
  const t = type.toUpperCase();
  const name = TYPE_NAME.test(t) ? t : "OTHER";
  return option ? `OPTION:${name}` : name;
}

const EPS = 1e-9;
const REBALANCING = new Set(["PORTFOLIO_INVESTMENT", "PORTFOLIO_REBALANCING", "FUNDS_INVESTED"]);

const isOptionRow = (a: StoredActivity) => a.isOption || a.type.toUpperCase().startsWith("OPTION");
const dateOf = (a: StoredActivity) => a.tradeDate ?? a.settlementDate;

export function classifyAccount(
  activities: StoredActivity[],
): { method: HistoryMethod; reason: string | null; warnings: string[] } {
  const warnings: string[] = [];
  if (activities.length === 0) return { method: "snapshots_only", reason: "no_activity", warnings };

  let rebalancing = false;
  let missingUnits = false;
  let missingCurrency = false;
  let options = false;
  let fxUnsupported = false;
  let fxTwoSided = false;
  for (const a of activities) {
    const type = a.type.toUpperCase();
    const option = isOptionRow(a);
    if (REBALANCING.has(type)) rebalancing = true;
    if (option) options = true;
    if (type === "FUNDS_CONVERSION") {
      if (a.currency !== "CAD" && a.currency !== "USD") fxUnsupported = true;
      if (cashDelta(type, a.amount) < 0) fxTwoSided = true;
    }
    if (option) continue;
    if (type === "BUY" || type === "SELL" || type === "REINVEST") {
      if (a.units === null || a.units === 0 || !a.symbol) missingUnits = true;
      // Without a currency the cash leg cannot be applied (M9).
      if (type !== "REINVEST" && !a.currency) missingCurrency = true;
    } else if ((type === "TRANSFER" || type === "CORPORATE_ACTION") && a.symbol && a.units === null) {
      missingUnits = true;
    }
  }
  if (options) warnings.push("options_excluded");
  if (fxUnsupported) warnings.push("fx_conversion_unsupported");
  if (fxTwoSided) warnings.push("fx_conversion_two_sided");
  if (rebalancing) return { method: "snapshots_only", reason: "portfolio_rebalancing", warnings };
  if (missingUnits) return { method: "snapshots_only", reason: "missing_units", warnings };
  if (missingCurrency) return { method: "snapshots_only", reason: "missing_currency", warnings };
  return { method: "reconstructed", reason: null, warnings };
}

function sortedCopy(activities: StoredActivity[]): StoredActivity[] {
  return activities
    .filter((a) => dateOf(a) !== null)
    .sort((x, y) => {
      const dx = dateOf(x)!;
      const dy = dateOf(y)!;
      if (dx !== dy) return dx < dy ? -1 : 1;
      return x.dedupeKey < y.dedupeKey ? -1 : x.dedupeKey > y.dedupeKey ? 1 : 0;
    });
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function add(map: Map<string, number>, key: string, delta: number) {
  map.set(key, (map.get(key) ?? 0) + delta);
}

/**
 * Cumulative per-day state. Output starts at the first activity date
 * regardless of `from` (days before it are absent) and ends at `to`.
 * Returns [] when there are no dated activities or the first date is after `to`.
 */
export function replay(activities: StoredActivity[], from: string, to: string): DayState[] {
  const sorted = sortedCopy(activities);
  if (sorted.length === 0) return [];
  const first = dateOf(sorted[0]!)!;
  if (first > to) return [];

  const units = new Map<string, number>();
  const cash = new Map<string, number>();
  const out: DayState[] = [];
  let i = 0;
  const start = first; // always begins at the first activity date, even if `from` is earlier
  for (let day = start; day <= to; day = nextDay(day)) {
    const conversions: DayState["conversions"] = [];
    const cashDeltas: NonNullable<DayState["cashDeltas"]> = [];
    while (i < sorted.length && dateOf(sorted[i]!)! <= day) {
      const a = sorted[i]!;
      i += 1;
      const type = a.type.toUpperCase();
      if (a.currency) {
        const delta = cashDelta(type, a.amount);
        if (delta !== 0) {
          add(cash, a.currency, delta);
          cashDeltas.push({ key: cashTypeKey(type, isOptionRow(a)), currency: a.currency, amount: delta });
        }
        if (type === "FUNDS_CONVERSION" && delta > 0) conversions.push(a.fxRate ? { currency: a.currency, amount: delta, fxRate: a.fxRate } : { currency: a.currency, amount: delta });
      }
      if (a.symbol && !isOptionRow(a)) {
        const du = unitsDelta(type, a.units);
        if (du !== 0) {
          add(units, a.symbol, du);
          if (Math.abs(units.get(a.symbol)!) < EPS) units.delete(a.symbol);
        }
      }
    }
    out.push({ date: day, units: new Map(units), cash: new Map(cash), conversions, cashDeltas });
  }
  return out;
}

const DEPOSIT_TYPES = new Set(["CONTRIBUTION", "WITHDRAWAL", "INTERNAL_CASH_TRANSFER_IN", "INTERNAL_CASH_TRANSFER_OUT"]);

/*
 * In-kind TRANSFER-in carries zero cash, so nothing is recorded here; its
 * market value at transfer time is a valuation-time concern (later task).
 */
export function netDeposits(activities: StoredActivity[]): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  for (const a of activities) {
    const type = a.type.toUpperCase();
    const date = dateOf(a);
    if (!DEPOSIT_TYPES.has(type) || !date || !a.currency) continue;
    const delta = cashDelta(type, a.amount);
    if (delta === 0) continue;
    let byCur = result.get(date);
    if (!byCur) result.set(date, (byCur = new Map()));
    add(byCur, a.currency, delta);
  }
  return result;
}
