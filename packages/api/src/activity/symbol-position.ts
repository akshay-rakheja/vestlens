import { dividendsInView, summariseWithholding } from "../analytics/income.js";
import { unitsDelta } from "../history/sign-rules.js";
import type { StoredActivity } from "../history/stored-activity.js";
import type { SplitEvent } from "../market-data/types.js";
import { tradePriceConverter, type ToSecurityCurrency } from "./trade-price.js";

export interface SymbolPositionPoint { date: string; units: number; avgCost: number | null }
export interface SymbolPosition {
  currency: string | null;
  /** One per activity date that changed units. */
  points: SymbolPositionPoint[];
  units: number;
  avgCost: number | null;
  avgCostEstimated: boolean;
  reason?: "inconsistent";
  /** Dividends paid in `currency`, net of matched withholding and counting a DRIP pair once: the Activity totals' figure. */
  dividends: number;
  /** The same net figure for dividends paid in another currency (e.g. CAD dividends on a USD security), per currency. */
  otherDividends: Array<{ currency: string; amount: number }>;
  /** Withholding rows matching no dividend (not deducted), per currency; present only when there are some. */
  unmatchedWithholding?: Array<{ currency: string; count: number; amount: number }>;
  markers: Array<{ date: string; side: "buy" | "sell"; units: number; price: number | null }>;
}

const EPS = 1e-9;

const rowDate = (r: StoredActivity) => r.tradeDate ?? r.settlementDate ?? "";
const positive = (v: number | null): v is number => v !== null && Number.isFinite(v) && v > 0;

/** Signed unit change; REI (not in the shared sign rules) is a share-adding reinvestment like REINVEST. */
export function signedUnits(r: StoredActivity): number {
  const type = r.type.toUpperCase();
  if (type === "REI") return r.units !== null && Number.isFinite(r.units) ? Math.abs(r.units) : 0;
  return unitsDelta(type, r.units);
}

interface AccountReplay {
  points: SymbolPositionPoint[];
  units: number;
  avgCost: number | null;
  estimated: boolean;
  inconsistent: boolean;
  markers: SymbolPosition["markers"];
}

/** Replays the rows of ONE account (one symbol, one currency) with the average-cost method. */
function replayAccount(
  ordered: StoredActivity[], splits: SplitEvent[], marketPrice: (date: string) => number | null,
  groupCurrency: string | null, toSecurityCurrency: ToSecurityCurrency,
): AccountReplay {
  const pendingSplits = [...splits].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let units = 0;
  let avgCost: number | null = null;
  let estimated = false;
  let inconsistent = false;
  let gap = false; // set by an oversell; only a clean close clears it
  const points: SymbolPositionPoint[] = [];
  const markers: SymbolPosition["markers"] = [];

  // Units are tracked already split-adjusted, so a holding is never lost when raw units reach 0.
  const applySplitsThrough = (date: string | null) => {
    while (pendingSplits.length > 0 && (date === null || pendingSplits[0]!.date <= date)) {
      const s = pendingSplits.shift()!;
      if (!(s.ratio > 0) || !Number.isFinite(s.ratio)) continue;
      if (units > EPS) {
        units *= s.ratio;
        if (avgCost !== null) avgCost /= s.ratio;
        estimated = true;
        if (date === null) points.push({ date: s.date, units, avgCost });
      }
    }
  };
  const record = (date: string) => {
    const last = points[points.length - 1];
    const point = { date, units, avgCost };
    if (last && last.date === date) points[points.length - 1] = point;
    else points.push(point);
  };

  for (const r of ordered) {
    const date = rowDate(r);
    applySplitsThrough(date);
    const type = r.type.toUpperCase();
    // The reported price is in the row currency; cost and markers are in the security currency (brief 8).
    const tradePrice = positive(r.price)
      ? toSecurityCurrency(r.price, r.currency, r.securityCurrency ?? groupCurrency, date, r.fxRate)
      : null;

    if ((type === "BUY" || type === "SELL") && r.units !== null && Number.isFinite(r.units) && r.units !== 0) {
      markers.push({ date, side: type === "BUY" ? "buy" : "sell", units: Math.abs(r.units), price: positive(tradePrice) ? tradePrice : null });
    }

    const delta = signedUnits(r);
    if (delta > 0) {
      const before = units;
      // A fresh lot after a clean close starts a new history. After an oversell the zero is a
      // history gap (shares are probably still held), so the new cost stays an estimate.
      if (before <= EPS) {
        inconsistent = false;
        estimated = gap;
        avgCost = null;
      }
      let price: number | null = positive(tradePrice) ? tradePrice : null;
      if (price === null && type === "TRANSFER") {
        const market = marketPrice(date);
        if (positive(market)) {
          price = market;
          estimated = true;
        }
      }
      units = before + delta;
      if (price === null) {
        estimated = true;
        avgCost = null; // cost of the new units is unknown
      } else if (before <= EPS) {
        avgCost = price;
      } else if (avgCost !== null) {
        avgCost = (before * avgCost + delta * price) / units;
      }
      record(date);
    } else if (delta < 0) {
      const before = units;
      units += delta;
      if (units < -EPS) {
        // More sold than recorded: the history has a gap.
        inconsistent = true;
        gap = true;
        avgCost = null;
      } else if (units <= EPS && before > EPS) {
        // A clean close: nothing is held, so there is no cost and no estimate to carry.
        avgCost = null;
        estimated = false;
        gap = false;
      }
      if (units < 0) units = 0;
      if (inconsistent) avgCost = null;
      record(date);
    }
  }
  applySplitsThrough(null);
  return { points, units, avgCost, estimated, inconsistent, markers };
}

const byDate = <T extends { date: string }>(a: T, b: T) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

/** Sums units and cost across accounts at each date: avg = Σ(units·avg)/Σunits, null if any holding account lacks a cost. */
function combine(parts: Array<{ units: number; avgCost: number | null }>): { units: number; avgCost: number | null } {
  let units = 0;
  let cost = 0;
  let unknown = false;
  for (const p of parts) {
    if (p.units <= EPS) continue;
    units += p.units;
    if (p.avgCost === null) unknown = true;
    else cost += p.units * p.avgCost;
  }
  return { units, avgCost: units <= EPS || unknown ? null : cost / units };
}

/**
 * Replays the rows of ONE symbol and ONE currency per account, then sums units and cost across
 * accounts ("All accounts"). `marketPrice(date)` supplies an as-traded close for in-kind
 * receipts that carry no price. Trade prices are reported in the row currency; cost and markers
 * are in the security currency (`securityCurrency ?? currency`, the group `currency`), converted
 * by `toSecurityCurrency` when the two differ (brief 8). Without it, only a reported `fxRate`
 * converts; otherwise a cross-currency price is unknown. Dividends are summed only when paid in it, netted against
 * withholding in `dividendContext` (the symbol's rows beyond this group; default these rows).
 */
export function symbolPosition(
  rows: StoredActivity[],
  splits: SplitEvent[],
  marketPrice: (date: string) => number | null,
  currency?: string | null,
  toSecurityCurrency: ToSecurityCurrency = tradePriceConverter(null),
  dividendContext?: StoredActivity[],
): SymbolPosition {
  // Option BUY/SELL rows can carry the underlying's symbol; they are not shares.
  const ordered = rows.filter((r) => !r.isOption).sort((a, b) => {
    const da = rowDate(a);
    const db = rowDate(b);
    if (da !== db) return da < db ? -1 : 1;
    // Same day: additions before reductions, so a same-day sell is never judged oversold.
    const ba = signedUnits(a) > 0 ? 0 : 1;
    const bb = signedUnits(b) > 0 ? 0 : 1;
    if (ba !== bb) return ba - bb;
    return a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0;
  });
  const first = ordered[0];
  const groupCurrency = currency !== undefined
    ? (currency?.trim().toUpperCase() || null)
    : first ? (first.securityCurrency ?? first.currency ?? null) : null;

  const byAccount = new Map<string, StoredActivity[]>();
  for (const r of ordered) {
    const list = byAccount.get(r.snapTradeAccountId);
    if (list) list.push(r);
    else byAccount.set(r.snapTradeAccountId, [r]);
  }
  const replays = [...byAccount.values()].map((list) => replayAccount(list, splits, marketPrice, groupCurrency, toSecurityCurrency));

  // Units over time: at each date any account changed, each account's latest point (0 before its first).
  const dates = [...new Set(replays.flatMap((x) => x.points.map((p) => p.date)))].sort();
  const cursors = replays.map(() => -1);
  const points: SymbolPositionPoint[] = dates.map((date) => {
    const parts = replays.map((x, i) => {
      while (cursors[i] + 1 < x.points.length && x.points[cursors[i] + 1].date <= date) cursors[i]++;
      return cursors[i] >= 0 ? x.points[cursors[i]] : { units: 0, avgCost: null };
    });
    return { date, ...combine(parts) };
  });

  const inconsistent = replays.some((x) => x.inconsistent);
  const total = combine(replays);
  const paid = dividendsInView(ordered, dividendContext?.filter((r) => !r.isOption) ?? ordered);
  let dividends = 0;
  const other = new Map<string, number>();
  for (const e of paid.events) {
    if (e.currency === groupCurrency) dividends += e.net;
    else other.set(e.currency, (other.get(e.currency) ?? 0) + e.net);
  }
  const unmatched = summariseWithholding(paid.unmatched);

  const result: SymbolPosition = {
    currency: groupCurrency,
    points,
    units: total.units,
    avgCost: inconsistent ? null : total.avgCost,
    avgCostEstimated: replays.some((x) => x.estimated),
    dividends: Math.round(dividends * 100) / 100,
    otherDividends: [...other].sort(([a], [b]) => a.localeCompare(b)).map(([c, amount]) => ({ currency: c, amount: Math.round(amount * 100) / 100 })),
    markers: replays.flatMap((x) => x.markers).sort(byDate),
  };
  if (unmatched.length > 0) result.unmatchedWithholding = unmatched;
  if (inconsistent) result.reason = "inconsistent";
  return result;
}

/** Groups rows by (normalised symbol, currency = securityCurrency ?? currency); symbol-less and option rows are skipped. */
export function groupBySymbolCurrency(rows: StoredActivity[]): Map<string, StoredActivity[]> {
  const groups = new Map<string, StoredActivity[]>();
  for (const r of rows) {
    if (r.isOption) continue;
    const symbol = r.symbol?.trim().toUpperCase();
    if (!symbol) continue;
    const currency = (r.securityCurrency ?? r.currency ?? "").trim().toUpperCase();
    const key = `${symbol}|${currency}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  return groups;
}
