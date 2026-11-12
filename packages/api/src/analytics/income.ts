import { cashDelta } from "../history/sign-rules.js";
import type { StoredActivity } from "../history/stored-activity.js";
import { scopedTransferKeys } from "./flows.js";
import type { HoldingRow } from "./holdings.js";
import { minusMonths } from "./value-series.js";

/** Dividend semantics shared with the Activity totals (activity-tools.ts computeTotals). */
export const DIVIDENDS = new Set(["DIVIDEND", "DISTRIBUTION"]);
export const REINVESTS = new Set(["REI", "REINVEST"]);
export const WITHHOLDING = new Set(["TAX", "WITHHOLDING"]);
/** Withholding tax and reinvestments are matched to a dividend within this many days. */
export const DIVIDEND_MATCH_DAYS = 3;
export const DEPOSITS = new Set(["CONTRIBUTION", "DEPOSIT", "INTERNAL_CASH_TRANSFER_IN"]);
/** A payment this close after the anniversary of a payer's latest one repeats its period (drifting dates), so it is not counted. */
const REPEAT_PERIOD_DAYS = 15;
/** Replayed units may differ from the reported units by at most this fraction (as in the reconstruction check). */
export const UNITS_TOLERANCE = 0.005;

export interface DividendEvent {
  date: string; accountId: string; symbol: string | null; currency: string;
  gross: number;
  /** Positive magnitude withheld; a matched refund makes it smaller. */
  withholding: number;
  /** gross - withholding. */
  net: number;
}

const rowDate = (a: StoredActivity) => a.tradeDate ?? a.settlementDate ?? "";
const dayNo = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
const symOf = (r: StoredActivity) => (r.symbol ?? "").trim().toUpperCase();
const cents = (n: number) => Math.round(n * 100) / 100;
const isValid = (r: StoredActivity) => r.currency !== null && r.amount !== null && Number.isFinite(r.amount);
const minusDays = (iso: string, days: number) => new Date((dayNo(iso) - days) * 86_400_000).toISOString().slice(0, 10);

function sameDividendGroup(d: StoredActivity, r: StoredActivity): boolean {
  return d.snapTradeAccountId === r.snapTradeAccountId && symOf(d) !== "" && symOf(d) === symOf(r)
    && d.currency!.toUpperCase() === r.currency!.toUpperCase() && !!rowDate(r)
    && Math.abs(dayNo(rowDate(d)) - dayNo(rowDate(r))) <= DIVIDEND_MATCH_DAYS;
}

/** Whether `r` has a DIVIDEND/DISTRIBUTION of the same account, symbol and currency within DIVIDEND_MATCH_DAYS. */
export function dividendMatcher(valid: StoredActivity[]): (r: StoredActivity) => boolean {
  const dividends = valid.filter((r) => DIVIDENDS.has(r.type.toUpperCase()) && rowDate(r));
  return (r) => dividends.some((d) => sameDividendGroup(d, r));
}

/**
 * One event per dividend payment. TAX/WITHHOLDING rows reduce the nearest matching dividend (unmatched ones are
 * ignored here; see `unmatchedWithholding`); a REI/REINVEST row is its own event only when no matching dividend exists. Identical to computeTotals.
 */
export function netDividends(rows: StoredActivity[]): DividendEvent[] {
  return analyseDividends(rows).events;
}

/**
 * Withholding rows (dated in `year`) that match no dividend: they are not netted (Activity parity) but are counted
 * per currency so the shortfall is visible. `amount` is the positive magnitude withheld; a refund makes it smaller.
 */
export function unmatchedWithholding(rows: StoredActivity[], year: number): Array<{ currency: string; count: number; amount: number }> {
  return summariseWithholding(unmatchedWithholdingRows(rows, year));
}

/** The withholding rows dated in `year` that match no dividend. */
export function unmatchedWithholdingRows(rows: StoredActivity[], year: number): StoredActivity[] {
  return analyseDividends(rows).unmatched.filter((r) => rowDate(r).startsWith(`${year}-`));
}

/** Withholding rows per currency: how many, and the positive magnitude withheld (a refund makes it smaller). */
export function summariseWithholding(rows: StoredActivity[]): Array<{ currency: string; count: number; amount: number }> {
  const by = new Map<string, { currency: string; count: number; amount: number }>();
  for (const r of rows) {
    const currency = r.currency!.toUpperCase();
    const g = by.get(currency) ?? { currency, count: 0, amount: 0 };
    g.count += 1; g.amount += -cashDelta(r.type, r.amount);
    by.set(currency, g);
  }
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map((g) => ({ ...g, amount: cents(g.amount) }));
}

/**
 * The dividends of a view (a date range, a search, one symbol group), netted as Income nets them. `context` holds the
 * rows read beyond the view, whatever its search or category, so a TAX row posted outside it still nets its dividend,
 * and a TAX row in view whose dividend is just outside belongs to that dividend, not to this view. `unmatched` is the
 * view's withholding that matches no dividend anywhere.
 */
export function dividendsInView(view: StoredActivity[], context: StoredActivity[] = view): { events: DividendEvent[]; unmatched: StoredActivity[] } {
  return analyseDividends(context, new Set(view.map((r) => r.dedupeKey)));
}

function analyseDividends(rows: StoredActivity[], only?: Set<string>): { events: DividendEvent[]; unmatched: StoredActivity[] } {
  const unmatched: StoredActivity[] = [];
  const valid = rows.filter(isValid);
  const near = dividendMatcher(valid);
  const events: Array<DividendEvent & { src: StoredActivity }> = [];
  for (const r of valid) {
    const type = r.type.toUpperCase();
    const date = rowDate(r);
    if (!date) continue;
    const cash = cashDelta(type, r.amount);
    if (DIVIDENDS.has(type)) events.push({ date, accountId: r.snapTradeAccountId, symbol: symOf(r) || null, currency: r.currency!.toUpperCase(), gross: cash, withholding: 0, net: cash, src: r });
    else if (REINVESTS.has(type) && !near(r)) events.push({ date, accountId: r.snapTradeAccountId, symbol: symOf(r) || null, currency: r.currency!.toUpperCase(), gross: Math.abs(cash), withholding: 0, net: Math.abs(cash), src: r });
  }
  for (const r of valid) {
    if (!WITHHOLDING.has(r.type.toUpperCase())) continue;
    if (!rowDate(r)) { unmatched.push(r); continue; }
    let best: (typeof events)[number] | null = null;
    let bestGap = Infinity;
    for (const e of events) {
      if (!DIVIDENDS.has(e.src.type.toUpperCase()) || !sameDividendGroup(e.src, r)) continue;
      const gap = Math.abs(dayNo(e.date) - dayNo(rowDate(r)));
      if (gap < bestGap) { best = e; bestGap = gap; }
    }
    if (best) best.withholding += -cashDelta(r.type, r.amount);
    else unmatched.push(r);
  }
  const sorted = events
    .filter((e) => !only || only.has(e.src.dedupeKey))
    .map(({ src: _src, ...e }) => ({ ...e, gross: cents(e.gross), withholding: cents(e.withholding), net: cents(e.gross - e.withholding) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.accountId.localeCompare(b.accountId) || (a.symbol ?? "").localeCompare(b.symbol ?? ""));
  return { events: sorted, unmatched: only ? unmatched.filter((r) => only.has(r.dedupeKey)) : unmatched };
}

export const MONTH_PAYERS = 10;
export const OTHER_PAYER = "Other";

export interface IncomeMonth { month: string; currency: string; byAccount: Record<string, number>; /** Top payers by net; dividends without a symbol are grouped as "Other". */ payers: Array<{ symbol: string; net: number }>; net: number; gross: number; withholding: number; interest: number }

export function monthlyIncome(events: DividendEvent[], interest: StoredActivity[], year: number): IncomeMonth[] {
  const by = new Map<string, IncomeMonth>();
  const payerNet = new Map<IncomeMonth, Map<string, number>>();
  const slot = (month: string, currency: string) => {
    const key = `${month}|${currency}`;
    let m = by.get(key);
    if (!m) { m = { month, currency, byAccount: {}, payers: [], net: 0, gross: 0, withholding: 0, interest: 0 }; by.set(key, m); payerNet.set(m, new Map()); }
    return m;
  };
  const prefix = `${year}-`;
  for (const e of events) {
    if (!e.date.startsWith(prefix)) continue;
    const m = slot(e.date.slice(0, 7), e.currency);
    m.byAccount[e.accountId] = (m.byAccount[e.accountId] ?? 0) + e.net;
    const pn = payerNet.get(m)!;
    const who = e.symbol ?? OTHER_PAYER;
    pn.set(who, (pn.get(who) ?? 0) + e.net);
    m.net += e.net; m.gross += e.gross; m.withholding += e.withholding;
  }
  for (const r of interest) {
    const date = rowDate(r);
    if (r.type.toUpperCase() !== "INTEREST" || !isValid(r) || !date.startsWith(prefix)) continue;
    slot(date.slice(0, 7), r.currency!.toUpperCase()).interest += cashDelta("INTEREST", r.amount);
  }
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency)).map((m) => ({
    ...m, byAccount: Object.fromEntries(Object.entries(m.byAccount).map(([k, v]) => [k, cents(v)])),
    payers: [...payerNet.get(m)!].map(([symbol, net]) => ({ symbol, net: cents(net) }))
      .sort((a, b) => b.net - a.net || a.symbol.localeCompare(b.symbol)).slice(0, MONTH_PAYERS),
    net: cents(m.net), gross: cents(m.gross), withholding: cents(m.withholding), interest: cents(m.interest),
  }));
}

/** Why a holding has no forward figure: units moved around a payment; the replay doesn't reach the units held; under a year of payments. */
export type ForwardUncoveredReason = "units_changed" | "history_mismatch" | "partial_year";

/** A security's per-share distributions by ex-date (market-data SecurityDistributions). */
export interface MarketDistributions { currency: string | null; events: Array<{ date: string; amount: number }> }

export interface ForwardDetail {
  estimates: Array<{ symbol: string; currency: string; amount: number; estimated: true }>;
  /** Per currency: holdings (symbol, account) with trailing payments or market distributions and current units, and how many could be estimated. */
  coverage: Map<string, { payers: number; covered: number }>;
  uncovered: Array<{ symbol: string; accountId: string; currency: string; reason: ForwardUncoveredReason }>;
  /** `SYMBOL|CURRENCY|accountId` of each holding with a figure. */
  covered: Set<string>;
}

export interface ForwardOptions {
  /** The symbol's market distributions, or null when unavailable. Without it, or in another currency than the payments, the activity path applies. */
  market?: (symbol: string) => MarketDistributions | null;
  /** When the position last opened (the replay going from no units to some): one opened inside the window has a partial year of payments. */
  openedOn?: (symbol: string, accountId: string) => string | null;
  /** Holdings to estimate from market data alone when the account has had no payment yet (a new position), in the holding's currency. */
  holdings?: Array<{ symbol: string; currency: string; accounts: Array<{ accountId: string }> }>;
}

/**
 * Forward 12 months per (symbol, account) with current units. Primary: the market's trailing per-share sum x the units
 * held now x that account's net ratio (trailing net / trailing gross, so withholding stays with the account), when the
 * market currency is the payment currency and the market reports distributions. A holding the account hasn't been paid
 * on yet (options.holdings) has no ratio to read and takes 1.
 * Otherwise from activity: trailing-window net payments, each divided by the units held that day, summed per unit and
 * multiplied by the units held now. A payer is skipped (and counted as uncovered) when any payment's units are unknown
 * or 0, when `replayedUnits` (the activity replay's final units) is unknown or differs from the reported units by more
 * than UNITS_TOLERANCE (splits, partial history), or when the position opened inside the window (a partial year).
 * `currentUnits` is keyed `SYMBOL|accountId`.
 */
/**
 * Symbol payments in the true trailing 12 months (a payment a year ago to the day is out). Quarterly dates drift by a
 * few days, so five can fall in the window: within one (symbol, account, currency) a payment within REPEAT_PERIOD_DAYS
 * after the anniversary of the latest one is left out, so a year holds four quarters.
 */
export function trailingEvents(events: DividendEvent[], today: string): DividendEvent[] {
  const cutoff = minusMonths(today, 12);
  const inWindow = events.filter((e) => e.symbol !== null && e.date > cutoff && e.date <= today);
  const keyOf = (e: DividendEvent) => `${e.symbol}|${e.accountId}|${e.currency}`;
  const latest = new Map<string, string>();
  for (const e of inWindow) if (e.date > (latest.get(keyOf(e)) ?? "")) latest.set(keyOf(e), e.date);
  return inWindow.filter((e) => e.date > minusDays(minusMonths(latest.get(keyOf(e))!, 12), -REPEAT_PERIOD_DAYS));
}

/** The market's per-share sum over the true trailing 12 months, under trailingEvents' repeat-period rule; 0 when there are none. */
export function trailingPerShare(events: MarketDistributions["events"], today: string): number {
  const cutoff = minusMonths(today, 12);
  const inWindow = events.filter((e) => e.date > cutoff && e.date <= today);
  const latest = inWindow.reduce((max, e) => (e.date > max ? e.date : max), "");
  return inWindow.filter((e) => e.date > minusDays(minusMonths(latest, 12), -REPEAT_PERIOD_DAYS)).reduce((sum, e) => sum + e.amount, 0);
}

export function forwardDetail(
  events: DividendEvent[],
  unitsOnDate: (symbol: string, accountId: string, date: string) => number | null,
  currentUnits: Map<string, number>,
  today: string,
  replayedUnits?: (symbol: string, accountId: string) => number | null,
  options: ForwardOptions = {},
): ForwardDetail {
  const groups = new Map<string, { symbol: string; accountId: string; currency: string; perUnit: number; ok: boolean; gross: number; net: number; withholding: number }>();
  for (const e of trailingEvents(events, today)) {
    const symbol = e.symbol!;
    const key = `${symbol}|${e.accountId}|${e.currency}`;
    const g = groups.get(key) ?? { symbol, accountId: e.accountId, currency: e.currency, perUnit: 0, ok: true, gross: 0, net: 0, withholding: 0 };
    groups.set(key, g);
    g.gross += e.gross; g.net += e.net; g.withholding += e.withholding;
    const units = unitsOnDate(symbol, e.accountId, e.date);
    if (units === null || !Number.isFinite(units) || units <= 0) { g.ok = false; continue; }
    g.perUnit += e.net / units;
  }
  const coverage = new Map<string, { payers: number; covered: number }>();
  const out = new Map<string, { symbol: string; currency: string; amount: number }>();
  const uncovered: ForwardDetail["uncovered"] = [];
  const covered = new Set<string>();
  const cutoff = minusMonths(today, 12);
  const slotOf = (currency: string) => {
    const c = coverage.get(currency) ?? { payers: 0, covered: 0 };
    coverage.set(currency, c);
    return c;
  };
  const add = (symbol: string, accountId: string, currency: string, amount: number) => {
    slotOf(currency).covered += 1;
    covered.add(`${symbol}|${currency}|${accountId}`);
    const key = `${symbol}|${currency}`;
    const o = out.get(key) ?? { symbol, currency, amount: 0 };
    o.amount += amount;
    out.set(key, o);
  };
  /** The market's trailing per-share sum in `currency`, or null when it can't be used for that currency. */
  const marketPerShare = (symbol: string, currency: string): number | null => {
    const m = options.market?.(symbol);
    if (!m || m.currency?.trim().toUpperCase() !== currency) return null;
    const sum = trailingPerShare(m.events, today);
    return sum > 0 ? sum : null;
  };
  for (const g of groups.values()) {
    const current = currentUnits.get(`${g.symbol}|${g.accountId}`);
    if (current === undefined || !Number.isFinite(current) || current <= 0) continue;
    slotOf(g.currency).payers += 1;
    const perShare = marketPerShare(g.symbol, g.currency);
    const ratio = g.gross > 0 ? Math.max(0, g.net / g.gross) : g.withholding > 0 ? null : 1;
    if (perShare !== null && ratio !== null) { add(g.symbol, g.accountId, g.currency, perShare * current * ratio); continue; }
    const leftOut = (reason: ForwardUncoveredReason) => uncovered.push({ symbol: g.symbol, accountId: g.accountId, currency: g.currency, reason });
    if (replayedUnits) {
      const replayed = replayedUnits(g.symbol, g.accountId);
      if (replayed === null || !Number.isFinite(replayed) || Math.abs(replayed - current) / current > UNITS_TOLERANCE) { leftOut("history_mismatch"); continue; }
    }
    if (!g.ok) { leftOut("units_changed"); continue; }
    if ((options.openedOn?.(g.symbol, g.accountId) ?? "") > cutoff) { leftOut("partial_year"); continue; }
    add(g.symbol, g.accountId, g.currency, g.perUnit * current);
  }
  // A holding the account hasn't been paid on yet is a payer only if the market says so.
  const paid = new Set([...groups.values()].map((g) => `${g.symbol}|${g.accountId}`));
  for (const h of options.holdings ?? []) {
    for (const { accountId } of h.accounts) {
      const current = currentUnits.get(`${h.symbol}|${accountId}`);
      if (paid.has(`${h.symbol}|${accountId}`) || current === undefined || !Number.isFinite(current) || current <= 0) continue;
      const perShare = marketPerShare(h.symbol, h.currency);
      if (perShare === null) continue;
      slotOf(h.currency).payers += 1;
      add(h.symbol, accountId, h.currency, perShare * current);
    }
  }
  const estimates = [...out.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.currency.localeCompare(b.currency))
    .map((o) => ({ ...o, amount: cents(o.amount), estimated: true as const }));
  return { estimates, coverage, uncovered, covered };
}

export function forwardEstimate(
  events: DividendEvent[],
  unitsOnDate: (symbol: string, accountId: string, date: string) => number | null,
  currentUnits: Map<string, number>,
  today: string,
  replayedUnits?: (symbol: string, accountId: string) => number | null,
): ForwardDetail["estimates"] {
  return forwardDetail(events, unitsOnDate, currentUnits, today, replayedUnits).estimates;
}

const positive = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** `trailingNetBySymbol` is keyed like HoldingRow.key (`SYMBOL|CURRENCY`). Holdings without trailing income are left out. */
export function yields(
  trailingNetBySymbol: Map<string, number>, holdings: HoldingRow[],
): Array<{ symbol: string; currency: string; yieldOnCost: number | null; currentYield: number | null; estimated: true }> {
  const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
  return holdings
    .filter((h) => (trailingNetBySymbol.get(h.key) ?? 0) > 0)
    .sort((a, b) => trailingNetBySymbol.get(b.key)! - trailingNetBySymbol.get(a.key)! || a.symbol.localeCompare(b.symbol))
    .map((h) => {
      const net = trailingNetBySymbol.get(h.key)!;
      return {
        symbol: h.symbol, currency: h.currency,
        yieldOnCost: positive(h.bookCost) ? round6(net / h.bookCost) : null,
        currentYield: positive(h.marketValue) ? round6(net / h.marketValue) : null,
        estimated: true as const,
      };
    });
}

/** Per currency: Σ trailing net ÷ Σ value over the holdings that have each value (cost and market value separately). */
export function overallYields(trailingNetBySymbol: Map<string, number>, holdings: HoldingRow[]): Map<string, { yieldOnCost: number | null; currentYield: number | null }> {
  const acc = new Map<string, { cost: number; costNet: number; value: number; valueNet: number }>();
  for (const h of holdings) {
    const a = acc.get(h.currency) ?? { cost: 0, costNet: 0, value: 0, valueNet: 0 };
    const net = trailingNetBySymbol.get(h.key) ?? 0;
    if (positive(h.bookCost)) { a.cost += h.bookCost; a.costNet += net; }
    if (positive(h.marketValue)) { a.value += h.marketValue; a.valueNet += net; }
    acc.set(h.currency, a);
  }
  const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
  return new Map([...acc].map(([c, a]) => [c, {
    yieldOnCost: a.cost > 0 ? round6(a.costNet / a.cost) : null,
    currentYield: a.value > 0 ? round6(a.valueNet / a.value) : null,
  }]));
}

/**
 * `rate` is null when `unmatched` holds a withholding row of that account type and currency: with tax that matched no
 * dividend the rate would read too low (0% on a US stock in a TFSA), so none is given.
 */
export function withholdingByAccountType(events: DividendEvent[], accountType: (accountId: string) => string, unmatched: StoredActivity[] = []): Array<{ accountType: string; currency: string; gross: number; withholding: number; rate: number | null }> {
  const unknownRate = new Set(unmatched.map((r) => `${accountType(r.snapTradeAccountId)}|${r.currency!.toUpperCase()}`));
  const by = new Map<string, { accountType: string; currency: string; gross: number; withholding: number }>();
  for (const e of events) {
    const type = accountType(e.accountId);
    const key = `${type}|${e.currency}`;
    const g = by.get(key) ?? { accountType: type, currency: e.currency, gross: 0, withholding: 0 };
    g.gross += e.gross; g.withholding += e.withholding;
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => a.accountType.localeCompare(b.accountType) || a.currency.localeCompare(b.currency)).map((g) => ({
    accountType: g.accountType, currency: g.currency, gross: cents(g.gross), withholding: cents(g.withholding),
    rate: g.gross > 0 && !unknownRate.has(`${g.accountType}|${g.currency}`) ? Math.round((g.withholding / g.gross) * 1e6) / 1e6 : null,
  }));
}

/**
 * Activity "deposits" semantics: CONTRIBUTION, DEPOSIT, INTERNAL_CASH_TRANSFER_IN, minus transfer pairs with both legs
 * in the SAME account type: each type's row is the money put into that type, so Cash -> TFSA is a TFSA contribution in
 * every view and all accounts agree with each type's own scope (I3). Per type, the other types' rows and `matchOnly`
 * (other accounts' rows, read only to pair legs) are match-only rows for scopedTransferKeys.
 */
export function contributionsByAccountType(
  rows: StoredActivity[], year: number, accountType: (id: string) => string, matchOnly: StoredActivity[] = [],
): Array<{ accountType: string; currency: string; amount: number }> {
  const byType = new Map<string, StoredActivity[]>();
  for (const r of rows) {
    const t = accountType(r.snapTradeAccountId);
    const list = byType.get(t);
    if (list) list.push(r); else byType.set(t, [r]);
  }
  const skip = new Set<string>();
  for (const [t, typeRows] of byType) {
    const others = rows.filter((r) => accountType(r.snapTradeAccountId) !== t);
    for (const key of scopedTransferKeys(typeRows, [...others, ...matchOnly])) skip.add(key);
  }
  const by = new Map<string, { accountType: string; currency: string; amount: number }>();
  for (const r of rows) {
    const type = r.type.toUpperCase();
    if (!DEPOSITS.has(type) || !isValid(r) || skip.has(r.dedupeKey) || !rowDate(r).startsWith(`${year}-`)) continue;
    const t = accountType(r.snapTradeAccountId);
    const currency = r.currency!.toUpperCase();
    const g = by.get(`${t}|${currency}`) ?? { accountType: t, currency, amount: 0 };
    g.amount += cashDelta(type, r.amount);
    by.set(`${t}|${currency}`, g);
  }
  return [...by.values()].sort((a, b) => a.accountType.localeCompare(b.accountType) || a.currency.localeCompare(b.currency)).map((g) => ({ ...g, amount: cents(g.amount) }));
}
