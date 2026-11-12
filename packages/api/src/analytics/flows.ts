import type { StoredActivity } from "../history/stored-activity.js";
import { cashDelta, unitsDelta } from "../history/sign-rules.js";

export interface FlowResult {
  byDate: Map<string, number>; unknownDates: Set<string>;
  /** Each external flow in `byDate`, by account and date (scope currency), for the put-in / taken-out breakdown. */
  entries?: Array<{ date: string; accountId: string; value: number }>;
  /**
   * Portfolio scope: external flows left out because the account had no value either side that day. `joinCovered`: the
   * account's next join value, soon after, includes it (ValuedScope.joinCovers), as for a new account's first deposit.
   */
  outsideHistory?: Array<{ date: string; accountId: string; value: number; joinCovered: boolean }>;
  /** Portfolio scope: each account's first dated activity, to tell an account that existed before a period from a new one. */
  firstActivity?: Map<string, string>;
  /** Some scope account's activities are not known to be complete (F4): flow-based figures are estimates. */
  incomplete?: boolean;
  /**
   * Portfolio scope: accounts joining (+ first value) or leaving (− last value) the value series
   * (brief 6). They are flows for the returns but not deposits (brief 9).
   */
  joins?: Map<string, number>;
  leaves?: Map<string, number>;
  /** Some join or leave value comes from a non-reported row. */
  joinLeaveEstimated?: boolean;
  /**
   * Portfolio scope: legs of your own transfers whose other leg is in an account outside the
   * valued window (not yet or no longer tracked). Flows for the returns, never deposits (brief 9, I2).
   */
  trackingTransfers?: Map<string, number>;
  /**
   * CAD view: dates in the span of USD flows with no BoC rate within 7 days. Never converted at a guessed
   * rate; the caller withholds the CAD return for the span instead.
   */
  homeUnconverted?: string[];
}
export interface FlowInputs {
  activities: StoredActivity[];
  scope: "portfolio" | "account";
  scopeCurrency: string;
  toScope(amount: number, currency: string, date: string): number | null;
  priceInKind(activity: StoredActivity, date: string): number | null;
  /**
   * Portfolio scope only: whether an account's activity on `date` is inside the value series.
   * Activities outside it are neither matched as transfer legs nor counted (brief 6).
   */
  inScope?(accountId: string, date: string): boolean;
  /** Portfolio scope only: whether a flow outside the window is in the account's next join value (ValuedScope.joinCovers). */
  joinCovers?(accountId: string, date: string): boolean;
  /**
   * Portfolio scope only: activities of accounts in the total but outside returns (Cash, countsTowardReturns), used
   * only to pair transfer legs. A scope leg whose partner is one of these is a real flow (money put in or taken out),
   * and two scope legs routed through Cash never pair with each other by accident.
   */
  matchOnly?: StoredActivity[];
}

// SPEND and CREDIT_CARD_PAYMENT leave the included Cash account for spending or the excluded
// card: outflows, signed by cashDelta (F2). REIMBURSEMENT stays return.
const CASH_FLOW_TYPES = new Set(["CONTRIBUTION", "DEPOSIT", "WITHDRAWAL", "INTERNAL_CASH_TRANSFER_IN", "INTERNAL_CASH_TRANSFER_OUT", "SPEND", "CREDIT_CARD_PAYMENT"]);
const MATCH_DAYS = 3;
const dateOf = (a: StoredActivity) => a.tradeDate ?? a.settlementDate;
const dayNumber = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
const norm = (s: string) => s.trim().toUpperCase();

interface Candidate { a: StoredActivity; date: string; kind: "cash" | "inkind"; sign: number; key: string; size: number }

function candidates(rows: StoredActivity[]): Candidate[] {
  const out: Candidate[] = [];
  for (const a of rows) {
    const date = dateOf(a);
    if (!date) continue;
    const type = a.type.toUpperCase();
    if (type === "INTERNAL_CASH_TRANSFER_IN" || type === "INTERNAL_CASH_TRANSFER_OUT") {
      const d = cashDelta(type, a.amount);
      if (d !== 0 && a.currency) out.push({ a, date, kind: "cash", sign: Math.sign(d), key: a.currency.toUpperCase(), size: Math.abs(d) });
    } else if (type === "TRANSFER" && !a.isOption && a.symbol) {
      const u = unitsDelta(type, a.units);
      if (u !== 0) out.push({ a, date, kind: "inkind", sign: Math.sign(u), key: norm(a.symbol), size: Math.abs(u) });
    }
  }
  return out.sort((x, y) => x.date.localeCompare(y.date) || x.a.dedupeKey.localeCompare(y.a.dedupeKey));
}

/**
 * Pairs of the owner's own transfers (both legs in scope) that net out at portfolio level: the
 * dedupe keys of both legs. The activity totals reach it through `scopedTransferKeys` (brief 9).
 */
export function matchedTransferKeys(rows: StoredActivity[]): Set<string> {
  return new Set(matchedTransferPairs(rows).flat());
}

/**
 * The dedupe keys of `scopeRows` transfer legs that net out: transfers inside the scope set (two TFSAs under
 * accountType tfsa) net, while a leg that could have moved money through an account outside the scope (`matchOnlyRows`:
 * Cash and the other listed accounts, read for matching only) stays a real flow. Without match-only rows it is
 * exactly `matchedTransferKeys(scopeRows)`. Used by income contributions and by the activity totals
 * (activity-tools.ts computeTotals) for a multi-account scope.
 *
 * Pairing is `matchedTransferPairs` unchanged (a maximum matching). A pair of two scope legs nets only when NEITHER leg
 * had an eligible match-only partner (`pairable`: opposite direction, same currency or symbol, same size, another
 * account, within MATCH_DAYS), whether or not that partner was taken by another pair. So a same-day TFSA1 -> Cash ->
 * TFSA2 never nets, even when only one Cash leg has synced, and a direct TFSA1 -> TFSA2 with no such Cash leg still
 * does. When in doubt the flows are counted, never hidden.
 */
export function scopedTransferKeys(scopeRows: StoredActivity[], matchOnlyRows: StoredActivity[] = []): Set<string> {
  if (matchOnlyRows.length === 0) return matchedTransferKeys(scopeRows);
  const scopeKeys = new Set(scopeRows.map((a) => a.dedupeKey));
  const scopeLegs = new Map(candidates(scopeRows).map((c) => [c.a.dedupeKey, c]));
  const outside = candidates(matchOnlyRows);
  const routable = (key: string) => {
    const leg = scopeLegs.get(key);
    return leg !== undefined && outside.some((c) => pairable(leg, c));
  };
  const out = new Set<string>();
  for (const [o, i] of matchedTransferPairs([...scopeRows, ...matchOnlyRows])) {
    if (scopeKeys.has(o) && scopeKeys.has(i) && !routable(o) && !routable(i)) { out.add(o); out.add(i); }
  }
  return out;
}

/** Whether two legs could be one transfer: the partner test of `matchedTransferPairs`, without its `used` set. */
function pairable(x: Candidate, y: Candidate): boolean {
  const tolerance = x.kind === "cash" ? 0.01 : 1e-6;
  return x.sign === -y.sign && x.kind === y.kind && x.key === y.key && x.a.snapTradeAccountId !== y.a.snapTradeAccountId
    && Math.abs(x.size - y.size) <= tolerance && Math.abs(dayNumber(x.date) - dayNumber(y.date)) <= MATCH_DAYS;
}

/**
 * The matched pairs themselves (out leg, in leg), by dedupe key: a maximum matching of out legs to `pairable` in legs
 * (augmenting paths), so as many legs pair as the rows allow. First fit by date and dedupe key could pair TFSA1's out
 * leg with TFSA2's in leg on a day the money went through Cash, leaving Cash's two legs unpairable (same account) and
 * inventing a deposit and a withdrawal; the maximum matching pairs each TFSA leg with a Cash leg, whatever the keys'
 * order (A1). Legs are visited by date, then dedupe key, which only breaks ties between equally large matchings.
 */
export function matchedTransferPairs(rows: StoredActivity[]): Array<[string, string]> {
  const list = candidates(rows);
  const outs = list.filter((c) => c.sign < 0);
  const ins = list.filter((c) => c.sign > 0);
  const partnerOf = new Map<Candidate, Candidate>(); // in leg → its out leg
  const assign = (out: Candidate, visited: Set<Candidate>): boolean => {
    for (const into of ins) {
      if (visited.has(into) || !pairable(out, into)) continue;
      visited.add(into);
      const current = partnerOf.get(into);
      if (current === undefined || assign(current, visited)) { partnerOf.set(into, out); return true; }
    }
    return false;
  };
  for (const out of outs) assign(out, new Set());
  const pairs: Array<[string, string]> = [];
  for (const out of outs) {
    const into = ins.find((c) => partnerOf.get(c) === out);
    if (into) pairs.push([out.a.dedupeKey, into.a.dedupeKey]);
  }
  return pairs;
}

export function externalFlows(input: FlowInputs): FlowResult {
  const byDate = new Map<string, number>();
  const unknownDates = new Set<string>();
  const scoped = input.scope === "portfolio" && input.inScope
    ? input.activities.filter((a) => { const d = dateOf(a); return d === null || input.inScope!(a.snapTradeAccountId, d); })
    : input.activities;
  // Pairs over the scope and the Cash legs together; only a pair with both legs in scope nets out.
  const skip = new Set<string>();
  if (input.scope === "portfolio") {
    const inScopeKeys = new Set(scoped.map((a) => a.dedupeKey));
    for (const [out, into] of matchedTransferPairs(input.matchOnly?.length ? [...scoped, ...input.matchOnly] : scoped)) {
      if (inScopeKeys.has(out) && inScopeKeys.has(into)) { skip.add(out); skip.add(into); }
    }
  }
  // Pairs matched over all scope accounts, ignoring the valued windows: a leg that pairs only
  // there moves money to or from an account not tracked on that day (brief 9, I2).
  const crossTracking = new Set<string>();
  if (input.scope === "portfolio" && input.inScope) {
    const scopeKeys = new Set(input.activities.map((a) => a.dedupeKey));
    for (const [out, into] of matchedTransferPairs(input.matchOnly?.length ? [...input.activities, ...input.matchOnly] : input.activities)) {
      if (scopeKeys.has(out) && scopeKeys.has(into)) { crossTracking.add(out); crossTracking.add(into); }
    }
  }
  const trackingTransfers = new Map<string, number>();
  const entries: NonNullable<FlowResult["entries"]> = [];
  let current = byDate;
  let accountId = "";
  const add = (date: string, v: number) => {
    current.set(date, (current.get(date) ?? 0) + v);
    if (current === byDate) entries.push({ date, accountId, value: v });
  };
  /** A row's external-flow value in the scope currency: undefined when it is not a flow, null when it can't be valued. */
  const flowValue = (a: StoredActivity, date: string): number | null | undefined => {
    const type = a.type.toUpperCase();
    if (CASH_FLOW_TYPES.has(type)) {
      const d = cashDelta(type, a.amount);
      if (d === 0) return undefined;
      // A flow with no currency cannot be valued: unknown, never silently dropped.
      if (!a.currency) return null;
      return a.currency.toUpperCase() === input.scopeCurrency ? d : input.toScope(d, a.currency.toUpperCase(), date);
    }
    if (type === "TRANSFER" && !a.isOption && a.symbol) {
      const u = unitsDelta(type, a.units);
      if (u === 0) return undefined;
      // SnapTrade reports the price in the row currency, which wins when it differs from the security's
      // (brief 8). It is converted to the scope currency with `toScope` (the day's scope rate); a
      // row's reported fxRate is not used here, since the scope currency may be neither leg.
      const priceCurrency = (a.currency ?? a.securityCurrency ?? input.scopeCurrency).trim().toUpperCase();
      const reported = a.price !== null && a.price > 0
        ? (priceCurrency === input.scopeCurrency ? a.price : input.toScope(a.price, priceCurrency, date))
        : null;
      const price = reported ?? input.priceInKind(a, date);
      return price === null ? null : u * price;
    }
    return undefined;
  };
  for (const a of scoped) {
    const date = dateOf(a);
    if (!date || skip.has(a.dedupeKey)) continue;
    current = crossTracking.has(a.dedupeKey) ? trackingTransfers : byDate;
    accountId = a.snapTradeAccountId;
    const v = flowValue(a, date);
    if (v === undefined) continue;
    if (v === null) unknownDates.add(date); else add(date, v);
  }
  // Portfolio scope: real flows on days an account has no value either side (a possible gap in its history). The
  // caller decides which make the account incomplete for the period (spec 2026-10-29-incomplete-history).
  const outsideHistory: NonNullable<FlowResult["outsideHistory"]> = [];
  const firstActivity = new Map<string, string>();
  for (const a of input.activities) {
    const date = dateOf(a);
    if (!date) continue;
    const seen = firstActivity.get(a.snapTradeAccountId);
    if (!seen || date < seen) firstActivity.set(a.snapTradeAccountId, date);
  }
  if (input.scope === "portfolio" && input.inScope) {
    const inside = new Set(scoped.map((a) => a.dedupeKey));
    for (const a of input.activities) {
      const date = dateOf(a);
      if (!date || inside.has(a.dedupeKey) || crossTracking.has(a.dedupeKey)) continue;
      const v = flowValue(a, date);
      if (typeof v === "number" && v !== 0) outsideHistory.push({ date, accountId: a.snapTradeAccountId, value: v, joinCovered: input.joinCovers?.(a.snapTradeAccountId, date) ?? false });
    }
  }
  const base = { byDate, unknownDates, entries, ...(outsideHistory.length ? { outsideHistory, firstActivity } : {}) };
  return trackingTransfers.size > 0 ? { ...base, trackingTransfers } : base;
}
