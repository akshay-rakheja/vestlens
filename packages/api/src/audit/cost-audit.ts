/**
 * Counts-only cost-base audit: how many held positions the CAD cost replay can
 * confirm against the broker's book cost, and how many taxable sales in the tax year have a computable gain. Decides
 * whether the Tax Pass cost-base promise holds. Output is counts and fixed reason labels only: never amounts, symbols,
 * account ids, dates, descriptions, or user identifiers.
 */
import { homeCostReplay } from "../activity/home-cost.js";
import type { HomeConverter } from "../fx/home-currency.js";
import type { StoredActivity } from "../history/stored-activity.js";

export interface CostAuditAccount { appUserId: string; snapTradeAccountId: string; rawType: string | null }
export interface CostAuditPosition {
  appUserId: string; snapTradeAccountId: string; symbol: string; kind: string;
  units: number | null; costBasis: number | null; currency: string | null; cashEquivalent: boolean;
}
export interface CostAuditActivity extends StoredActivity { appUserId: string }
export interface CostAuditInput {
  taxYear: string;
  accounts: CostAuditAccount[];
  positions: CostAuditPosition[];
  activities: CostAuditActivity[];
  /** USD → CAD at the Bank of Canada rate on a date (the converter the gains code uses). */
  conv: HomeConverter;
}

/** Same tolerances as the gains gate in mcp/activity-tools.ts. */
export const UNITS_TOLERANCE = 0.005;
export const COST_TOLERANCE = 0.03;
const SPLIT_TOLERANCE = 0.01;
const EPS = 1e-9;
const REPURCHASE_DAYS = 30;

const REGISTERED = /TFSA|RRSP|FHSA|RESP|RRIF|LIRA|LIF|RDSP|LRSP|PRPP/;
const NOT_INVESTMENT = /^(CARD|LOC|CREDIT)/;
export type AccountGroup = "taxable" | "registered";
export function accountGroup(rawType: string | null): AccountGroup | null {
  const t = (rawType ?? "").trim().toUpperCase();
  if (NOT_INVESTMENT.test(t)) return null;
  return REGISTERED.test(t) ? "registered" : "taxable";
}

export type HoldingReason =
  | "confirmed" | "no_activity" | "units_short" | "units_over" | "split_like" | "cost_incomplete" | "no_broker_cost" | "cost_mismatch";

const key = (...parts: string[]) => parts.join("\u0000");
const rowDate = (r: StoredActivity) => r.tradeDate ?? r.settlementDate ?? "";
const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
const near = (a: number, b: number, tol: number) => b !== 0 && Math.abs(a / b - 1) <= tol;

/** A unit ratio like 2, 3, 4 or 1/2, 1/3: the replay probably missed a split the stored rows don't carry. */
function splitLike(ratio: number): boolean {
  if (!(ratio > 0)) return false;
  const r = ratio >= 1 ? ratio : 1 / ratio;
  const n = Math.round(r);
  return n >= 2 && Math.abs(r / n - 1) <= SPLIT_TOLERANCE;
}

/** The same converter turned around: amounts to USD, CAD rows divided by that day's USD/CAD. */
export function usdConverter(conv: HomeConverter): HomeConverter {
  return {
    latest: conv.latest,
    at(amount, currency, date) {
      const code = currency.trim().toUpperCase();
      const native = { amount, currency: code };
      if (code === "USD") return { amount, estimated: false, rate: null, rateDate: null, native };
      const rate = code === "CAD" ? conv.at(1, "USD", date).rate : null;
      if (!rate) return { amount: null, estimated: false, rate: null, rateDate: null, native };
      return { amount: amount / rate, estimated: true, rate, rateDate: conv.at(1, "USD", date).rateDate, native };
    },
  };
}

export function mismatchBucket(diff: number): string {
  return diff <= 0.1 ? "3-10%" : diff <= 0.25 ? "10-25%" : ">25%";
}

function holdingReason(rows: StoredActivity[], p: CostAuditPosition, conv: HomeConverter, usd: HomeConverter): { reason: HoldingReason; diff?: number; branch?: "cad" | "usd" } {
  const held = p.units ?? 0;
  if (rows.length === 0) return { reason: "no_activity" };
  const cad = homeCostReplay(rows, [], conv, p.snapTradeAccountId, p.symbol);
  if (!near(cad.units, held, UNITS_TOLERANCE)) {
    if (cad.units <= EPS) return { reason: "units_short" };
    if (splitLike(held / cad.units)) return { reason: "split_like" };
    return { reason: cad.units < held ? "units_short" : "units_over" };
  }
  if (!cad.complete || cad.avgCostCad === null) return { reason: "cost_incomplete" };
  if (p.costBasis === null || !(p.costBasis > 0)) return { reason: "no_broker_cost" };
  const currency = (p.currency ?? "CAD").trim().toUpperCase();
  const cadDiff = Math.abs(p.costBasis / cad.avgCostCad - 1);
  if (cadDiff <= COST_TOLERANCE) return { reason: "confirmed", branch: currency === "USD" ? "cad" : undefined };
  if (currency !== "USD") return { reason: "cost_mismatch", diff: cadDiff };
  const native = homeCostReplay(rows, [], usd, p.snapTradeAccountId, p.symbol);
  if (!native.complete || native.avgCostCad === null) return { reason: "cost_incomplete" };
  const usdDiff = Math.abs(p.costBasis / native.avgCostCad - 1);
  if (usdDiff <= COST_TOLERANCE) return { reason: "confirmed", branch: "usd" };
  return { reason: "cost_mismatch", diff: Math.min(cadDiff, usdDiff) };
}

const tally = (into: Record<string, number>, k: string) => { into[k] = (into[k] ?? 0) + 1; };
const emptyHoldings = () => ({ total: 0, byReason: {} as Record<string, number>, mismatchSize: {} as Record<string, number>, usdBookCostIn: {} as Record<string, number> });

/** Why a sale's gain can't be computed: sold more than the stored buys hold, or a buy/transfer-in without a CAD cost. */
function incompleteSaleReason(before: StoredActivity[], sell: StoredActivity, conv: HomeConverter, accountId: string, symbol: string): string {
  const prior = homeCostReplay(before, [], conv, accountId, symbol);
  const sold = Math.abs(sell.units ?? 0);
  if (prior.units + EPS < sold) return prior.units <= EPS ? "no_buys_recorded" : "sold_more_than_recorded";
  return "cost_missing";
}

export function costAudit(input: CostAuditInput) {
  const { conv, taxYear } = input;
  const usd = usdConverter(conv);
  const groupOf = new Map<string, AccountGroup | null>();
  const rawTypeOf = new Map<string, string>();
  for (const a of input.accounts) {
    groupOf.set(key(a.appUserId, a.snapTradeAccountId), accountGroup(a.rawType));
    rawTypeOf.set(key(a.appUserId, a.snapTradeAccountId), (a.rawType ?? "").trim().toUpperCase());
  }

  const rowsBy = new Map<string, CostAuditActivity[]>();
  for (const r of input.activities) {
    if (r.isOption || !r.symbol) continue;
    const k = key(r.appUserId, r.snapTradeAccountId, r.symbol.trim().toUpperCase());
    const list = rowsBy.get(k);
    if (list) list.push(r); else rowsBy.set(k, [r]);
  }

  // 1. Held positions: does the replay reproduce units and the broker's book cost?
  const holdings: Record<AccountGroup, ReturnType<typeof emptyHoldings>> = { taxable: emptyHoldings(), registered: emptyHoldings() };
  const positionKinds: Record<string, number> = {};
  for (const p of input.positions) {
    const group = groupOf.get(key(p.appUserId, p.snapTradeAccountId));
    if (!group || p.cashEquivalent || !(p.units !== null && p.units > EPS)) continue;
    const kind = p.kind.trim().toLowerCase();
    if (kind === "option") continue;
    tally(positionKinds, /^[a-z_]{1,20}$/.test(kind) ? kind : "other");
    const rows = rowsBy.get(key(p.appUserId, p.snapTradeAccountId, p.symbol.trim().toUpperCase())) ?? [];
    const out = holdingReason(rows, { ...p, symbol: p.symbol.trim().toUpperCase() }, conv, usd);
    const h = holdings[group];
    h.total += 1;
    tally(h.byReason, out.reason);
    if (out.diff !== undefined) tally(h.mismatchSize, mismatchBucket(out.diff));
    if (out.branch) tally(h.usdBookCostIn, out.branch);
  }

  // 2. Taxable sales in the tax year: is each sale's CAD gain computable, and is it a loss?
  // 3. Of those losses, how many have a buy of the same symbol within 30 days either side (any account, same user)?
  const buysBy = new Map<string, Array<{ day: number; group: AccountGroup | null; account: string }>>();
  for (const r of input.activities) {
    if (r.isOption || !r.symbol || r.type.toUpperCase() !== "BUY" || !rowDate(r)) continue;
    const k = key(r.appUserId, r.symbol.trim().toUpperCase());
    const entry = { day: dayNumber(rowDate(r)), group: groupOf.get(key(r.appUserId, r.snapTradeAccountId)) ?? null, account: r.snapTradeAccountId };
    const list = buysBy.get(k);
    if (list) list.push(entry); else buysBy.set(k, [entry]);
  }
  const sales = { total: 0, computable: 0, incomplete: 0, atLoss: 0, atGain: 0, incompleteReason: {} as Record<string, number>, incompleteInCryptoAccount: 0 };
  const lossRepurchase = { any: 0, sameAccount: 0, registeredAccount: 0, otherTaxableAccount: 0 };
  for (const [k, rows] of rowsBy) {
    const [appUserId, accountId, symbol] = k.split("\u0000") as [string, string, string];
    if (groupOf.get(key(appUserId, accountId)) !== "taxable") continue;
    const sells = rows.filter((r) => r.type.toUpperCase() === "SELL" && rowDate(r).startsWith(`${taxYear}-`));
    for (const sell of sells) {
      sales.total += 1;
      const through = rowDate(sell);
      // The replay orders same-day additions before sells, and sells by dedupe key: keep everything up to this sell.
      const sameDayFirst = (r: StoredActivity) => rowDate(r) === through && (r.type.toUpperCase() !== "SELL" || r.dedupeKey <= sell.dedupeKey);
      const upTo = rows.filter((r) => rowDate(r) < through || sameDayFirst(r));
      const before = upTo.filter((r) => r !== sell);
      const after = homeCostReplay(upTo, [], conv, accountId, symbol);
      if (!after.complete) {
        sales.incomplete += 1;
        tally(sales.incompleteReason, incompleteSaleReason(before, sell, conv, accountId, symbol));
        if (rawTypeOf.get(key(appUserId, accountId)) === "CRYPTO") sales.incompleteInCryptoAccount += 1;
        continue;
      }
      sales.computable += 1;
      const gain = after.realizedCad - homeCostReplay(before, [], conv, accountId, symbol).realizedCad;
      if (gain >= 0) { sales.atGain += 1; continue; }
      sales.atLoss += 1;
      const day = dayNumber(through);
      const window = (buysBy.get(key(appUserId, symbol)) ?? []).filter((b) => Math.abs(b.day - day) <= REPURCHASE_DAYS);
      if (window.length === 0) continue;
      lossRepurchase.any += 1;
      if (window.some((b) => b.account === accountId)) lossRepurchase.sameAccount += 1;
      if (window.some((b) => b.group === "registered")) lossRepurchase.registeredAccount += 1;
      if (window.some((b) => b.group === "taxable" && b.account !== accountId)) lossRepurchase.otherTaxableAccount += 1;
    }
  }

  return { taxYear, holdings, positionKinds, sales, lossRepurchase };
}
