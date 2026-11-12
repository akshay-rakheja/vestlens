import type { HomeConverter } from "../fx/home-currency.js";
import { unitsDelta } from "../history/sign-rules.js";
import type { StoredActivity } from "../history/stored-activity.js";
import type { SplitEvent } from "../market-data/types.js";

/**
 * CAD average-cost replay of ONE symbol in ONE account (spec 6.4). CAD-paid buys cost their exact
 * CAD amount; USD-paid buys and sells convert at the BoC rate on the trade date (est.). Realized
 * gain is, for each sell, CAD proceeds minus the average CAD cost per unit at that moment × units
 * sold. Splits change units, never the CAD cost.
 *
 * `complete` is false when any addition has no CAD cost (a cost-less transfer-in, or a USD amount
 * with no rate within 7 days), a sell's proceeds cannot be converted, or more is sold than was
 * recorded. Then `avgCostCad` and `costCad` are null and `realizedCad` must not be shown.
 */
export interface HomeCostResult {
  accountId: string;
  units: number;
  avgCostCad: number | null;
  costCad: number | null;
  realizedCad: number;
  estimated: boolean;
  complete: boolean;
}

const EPS = 1e-9;
const cents = (n: number) => Math.round(n * 100) / 100;
const rowDate = (r: StoredActivity) => r.tradeDate ?? r.settlementDate ?? "";
const finite = (v: number | null): v is number => v !== null && Number.isFinite(v);

/** Signed unit change; REI (not in the shared sign rules) adds shares like REINVEST. */
function signedUnits(r: StoredActivity): number {
  const type = r.type.toUpperCase();
  if (type === "REI") return finite(r.units) ? Math.abs(r.units) : 0;
  return unitsDelta(type, r.units);
}

/** The row's absolute cash value in its own currency: the amount, else units × price; null when neither is known. */
function cashValue(r: StoredActivity): number | null {
  if (finite(r.amount) && Math.abs(r.amount) > EPS) return Math.abs(r.amount);
  if (finite(r.units) && finite(r.price) && r.price > 0 && Math.abs(r.units) > EPS) return Math.abs(r.units * r.price);
  return null;
}

export function homeCostReplay(
  rows: StoredActivity[], splits: SplitEvent[], conv: HomeConverter, accountId: string, symbol: string,
): HomeCostResult {
  const wanted = symbol.trim().toUpperCase();
  // Same order as symbolPosition: by date, additions before reductions on the same day.
  const ordered = rows
    .filter((r) => !r.isOption && r.snapTradeAccountId === accountId && (r.symbol ?? "").trim().toUpperCase() === wanted)
    .sort((a, b) => {
      const da = rowDate(a);
      const db = rowDate(b);
      if (da !== db) return da < db ? -1 : 1;
      const ba = signedUnits(a) > 0 ? 0 : 1;
      const bb = signedUnits(b) > 0 ? 0 : 1;
      if (ba !== bb) return ba - bb;
      return a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0;
    });
  const pending = splits.filter((s) => s.ratio > 0 && Number.isFinite(s.ratio)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let units = 0;
  let cost = 0;
  let realized = 0;
  let estimated = false;
  let complete = true;

  const applySplitsThrough = (date: string | null) => {
    while (pending.length > 0 && (date === null || pending[0]!.date <= date)) {
      const s = pending.shift()!;
      if (units > EPS) units *= s.ratio;
    }
  };
  const toCad = (r: StoredActivity, value: number): number | null => {
    const home = conv.at(value, r.currency ?? r.securityCurrency ?? "", rowDate(r));
    if (home.amount === null) return null;
    if (home.estimated) estimated = true;
    return home.amount;
  };

  for (const r of ordered) {
    const date = rowDate(r);
    applySplitsThrough(date);
    const delta = signedUnits(r);
    if (delta > 0) {
      const value = cashValue(r);
      const cad = value === null ? null : toCad(r, value);
      if (cad === null) complete = false;
      else cost += cad;
      units += delta;
    } else if (delta < 0) {
      const sold = -delta;
      if (units + EPS < sold) {
        complete = false;
        units = 0;
        cost = 0;
        continue;
      }
      const value = cashValue(r);
      const proceeds = value === null ? null : toCad(r, value);
      const avg = units > EPS ? cost / units : 0;
      if (proceeds === null) complete = false;
      else realized += proceeds - sold * avg;
      units -= sold;
      cost -= sold * avg;
      if (units <= EPS) { units = 0; cost = 0; }
    }
  }
  applySplitsThrough(null);

  const held = units > EPS;
  return {
    accountId,
    units,
    avgCostCad: complete && held ? cost / units : null,
    costCad: complete && held ? cents(cost) : null,
    realizedCad: cents(realized),
    estimated,
    complete,
  };
}
