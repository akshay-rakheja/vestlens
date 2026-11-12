import { presence, valuedScopeOf, type DailyRow, type SeriesPoint, type ValuedScope } from "../analytics/value-series.js";
import { HOME_CURRENCY, type HomeConverter } from "./home-currency.js";

export interface HomeSeriesPoint extends SeriesPoint {
  /** Accounts left out of this day's value because their amount could not be converted. */
  notConverted?: number;
}

export interface HomeSeries {
  /** Every series date in CAD. A day missing an account that converts on other days carries `notConverted`. */
  points: HomeSeriesPoint[];
  /**
   * The days with every account that converts anywhere in the span converted: what charts and returns use,
   * so a missing rate never draws a drop. Accounts that never convert in the span are left out of every day.
   */
  complete: SeriesPoint[];
  /** Portfolio scope over `complete`, in CAD, for the flow loader (same rules as `valuedScope`). */
  valued: ValuedScope;
  /** Some contribution was converted from USD. */
  estimated: boolean;
  /** Days left out of `complete` because an account that converts on other days had no rate within 7 days. */
  notConvertedDays: number;
  /** Accounts never converted in the span (no rate at all, or a currency that does not convert): out of every day. */
  notConvertedAccounts: string[];
}

type Row = DailyRow & { native: string };
const RANK: Record<SeriesPoint["source"], number> = { reported: 0, reconstructed: 1, estimated: 2 };
const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * One CAD daily series from per-account rows in their own currencies (spec 6.5): CAD values are exact,
 * USD values × that day's BoC rate (on or before, at most 7 days old) are estimated, and a value that
 * cannot be converted is left out of the day and counted, never guessed. Merging (precedence,
 * carry-forward inside an account's window) is `mergeDailyPoints`'s. `todayValues` are the reported
 * totals in their own currency (null: no today point).
 */
export function homeDailySeries(
  rows: DailyRow[], conv: HomeConverter, from: string, today: string,
  todayValues: Map<string, { amount: number; currency: string }> | null, scopeIds?: Set<string>,
): HomeSeries {
  const tagged: Row[] = rows
    .filter((r) => !scopeIds || scopeIds.has(r.accountId))
    .map((r) => ({ ...r, currency: "*", native: r.currency.trim().toUpperCase() }));
  const { ordered, perAccount } = presence(tagged, "*", from, today);

  type Cell = { value: number | null; source: SeriesPoint["source"]; estimated: boolean };
  const cells = new Map<string, Map<string, Cell>>();
  const put = (id: string, date: string, cell: Cell) => { let m = cells.get(id); if (!m) cells.set(id, (m = new Map())); m.set(date, cell); };
  for (const [id, days] of perAccount) {
    for (const [date, row] of days) {
      const c = conv.at(row.value, row.native, date);
      put(id, date, { value: c.amount, source: row.source, estimated: c.estimated });
    }
  }
  const dates = [...ordered];
  if (todayValues) {
    for (const [id, v] of todayValues) {
      if (scopeIds && !scopeIds.has(id)) continue;
      const c = conv.at(v.amount, v.currency);
      put(id, today, { value: c.amount, source: "reported", estimated: c.estimated });
    }
    dates.push(today);
  }
  // An account that never converts in the span is out of every day; one that converts on some days marks the others.
  const converts = new Set([...cells].filter(([, m]) => [...m.values()].some((c) => c.value !== null)).map(([id]) => id));

  const points: HomeSeriesPoint[] = [];
  const completeDates = new Set<string>();
  let estimated = false;
  let notConvertedDays = 0;
  for (const date of dates) {
    let value = 0; let source: SeriesPoint["source"] = "reported"; let dropped = 0; let any = false;
    for (const [id, m] of cells) {
      const cell = m.get(date);
      if (!cell) continue;
      if (cell.value === null) { if (converts.has(id)) dropped++; continue; }
      any = true;
      value += cell.value;
      if (cell.estimated) estimated = true;
      if (RANK[cell.source] > RANK[source]) source = cell.source;
    }
    if (dropped > 0) notConvertedDays++;
    if (!any) continue; // nothing converted that day: no CAD point (never a CAD 0)
    const point: HomeSeriesPoint = { date, value: cents(value), source: date === today ? "reported" : source };
    if (dropped > 0) point.notConverted = dropped;
    else completeDates.add(date);
    points.push(point);
  }
  const complete = points.filter((p) => !p.notConverted).map(({ date, value, source }) => ({ date, value, source }));

  // The flow scope sees only complete days, in CAD, so a missing rate is neither a leave nor a join.
  const cadPerAccount = new Map<string, Map<string, DailyRow>>();
  for (const [id, m] of cells) {
    if (!converts.has(id)) continue;
    const days = new Map<string, DailyRow>();
    for (const [date, cell] of m) if (date !== today && completeDates.has(date) && cell.value !== null) days.set(date, { date, accountId: id, currency: HOME_CURRENCY, value: cell.value, source: cell.source });
    if (days.size) cadPerAccount.set(id, days);
  }
  const todayComplete = completeDates.has(today);
  const todayCad = todayValues && todayComplete
    ? new Map([...cells].flatMap(([id, m]) => { const c = m.get(today); return c && c.value !== null ? [[id, c.value] as [string, number]] : []; }))
    : null;
  const valued = valuedScopeOf({ ordered: ordered.filter((d) => completeDates.has(d)), perAccount: cadPerAccount }, today, todayCad, scopeIds);
  const notConvertedAccounts = [...cells.keys()].filter((id) => !converts.has(id));
  return { points, complete, valued, estimated, notConvertedDays, notConvertedAccounts };
}
