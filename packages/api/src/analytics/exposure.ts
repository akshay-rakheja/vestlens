import type { AccountClassification } from "../portfolio/account-taxonomy.js";
import { allocate, type AllocationItem, type CashItem, type ProfileLookup } from "./allocation.js";
import { isInvestableClassification } from "./holdings.js";

/**
 * Portfolio weights and exposure for limits and theses. Every percentage (0-100) is of the investment total:
 * the CAD value of positions and cash in included, open, non-credit accounts (CLAUDE.md), less any margin debit (a
 * negative cash line: the total is then net equity and a share can exceed 100%), so every output carries
 * `basis: "portfolio_incl_cash"` and consumers label it "of your portfolio, cash included". Values are CAD
 * equivalents; a share is estimated when its numerator or the total holds a converted amount.
 *
 * The classification is the allocation view's own (`allocate`), but the basis is not always its basis: asset-class
 * and holding shares match the allocation card, while the card's sector fractions are of non-cash value only. A
 * sector percentage here is therefore lower than the card's whenever cash is held; never show the two side by side
 * without the basis.
 *
 * An item or cash line may carry its account's classification; one whose account is closed, excluded from the
 * portfolio total or a credit product is left out. Lines without a classification are taken as already scoped
 * (the allocation tool builds them from investable accounts only).
 */
export type ExposureItem = AllocationItem & {
  classification?: AccountClassification;
  /** The security's name as the brokerage reports it: two companies can share a ticker across exchanges (T.TO, T). */
  name?: string | null;
};
export type ExposureCash = CashItem & { classification?: AccountClassification };

/** Every percentage is of the investment total, cash included ("of your portfolio, cash included"). */
export const EXPOSURE_BASIS = "portfolio_incl_cash" as const;
export type ExposureBasis = typeof EXPOSURE_BASIS;

export interface HoldingWeight {
  symbol: string;
  currency: string;
  /** `SYMBOL|CURRENCY`: a CAD and a US listing of one company are two rows, never summed. */
  key: string;
  valueCad: number;
  pct: number;
  estimated: boolean;
  /** Keys of other exchange listings of the same company held separately; empty when none. Share classes are not listings. */
  listings: string[];
  /** Keys of other rows under this ticker whose reported names disagree (two companies, so not combined); consumers say "other listings not combined". */
  uncombined: string[];
  basis: ExposureBasis;
}
export interface SectorExposure {
  sectors: Array<{ sector: string; pct: number; estimated: boolean }>;
  /** Holdings (or the unweighted part of a fund) with no sector data: not in any sector percentage, listed here. */
  unclassified: { pct: number; symbols: string[] };
  basis: ExposureBasis;
}

const PCT_PLACES = 6;
const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100 * 10 ** PCT_PLACES) / 10 ** PCT_PLACES : 0);
const counted = (x: { classification?: AccountClassification }) => !x.classification || isInvestableClassification(x.classification);
const upper = (s: string) => s.trim().toUpperCase();
/** Exchange suffixes of Canadian listings (TD.TO and TD are listings of one company). */
const LISTING_SUFFIX = /\.(TO|V|NE|NEO|CN)$/;
const company = (symbol: string) => upper(symbol).replace(LISTING_SUFFIX, "");

/** The name's first word, for comparing "Toronto-Dominion Bank" with "THE TORONTO DOMINION BANK". */
const firstNameWord = (name: string) => name.toLowerCase().replace(/&/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/^the /, "").split(" ")[0] ?? "";
/** Reported names that disagree mean two companies under one ticker; a missing name doesn't rule a listing out. */
const namesAgree = (a: string | null | undefined, b: string | null | undefined) => !a || !b || firstNameWord(a) === firstNameWord(b);

function scoped(items: ExposureItem[], cash: ExposureCash[]): { items: ExposureItem[]; cash: CashItem[] } {
  return { items: items.filter(counted), cash: cash.filter(counted) };
}

/** A margin debit in scope, as a positive CAD amount; 0 when none. */
const marginDebit = (cash: CashItem[]) => cash.reduce((sum, c) => (Number.isFinite(c.valueCad) && c.valueCad < 0 ? sum - c.valueCad : sum), 0);

/** A negative cash balance is called a margin debit only from this share of the positions' value (review 5). */
export const MARGIN_DEBIT_MIN_SHARE = 0.01;
/**
 * Whether a negative cash balance is worth naming as a margin debit: at least MARGIN_DEBIT_MIN_SHARE of the positions'
 * CAD value. A few dollars of negative cash (a fee posted before a deposit settled) still nets out of the total, but no
 * surface calls the total "net of a margin debit" over it.
 */
export const marginDebitMatters = (debitCad: number, positionsCad: number) => debitCad > 0 && debitCad >= MARGIN_DEBIT_MIN_SHARE * positionsCad;
/** The positions' positive CAD value (cash lines excluded). */
const positionsValue = (items: AllocationItem[]) => items.reduce((sum, i) => (i.kind !== "cash" && Number.isFinite(i.valueCad) && i.valueCad > 0 ? sum + i.valueCad : sum), 0);

/** The total holds a converted amount (any counted non-CAD position or cash), so every share of it is est. */
function totalEstimated(s: { items: AllocationItem[]; cash: CashItem[] }): boolean {
  return allocate(s.items, s.cash, "assetClass").estimated || s.cash.some((c) => c.valueCad < 0 && upper(c.currency) !== "CAD");
}

/** Every share of this scope's total is an estimate: the total holds a converted amount. */
export function exposureEstimated(items: ExposureItem[], cash: ExposureCash[]): boolean {
  return totalEstimated(scoped(items, cash));
}

/** The scope carries a margin debit worth naming (marginDebitMatters), so its total is net equity and a share can exceed 100%. */
export function exposureNetOfMargin(items: ExposureItem[], cash: ExposureCash[]): boolean {
  const s = scoped(items, cash);
  return marginDebitMatters(marginDebit(s.cash), positionsValue(s.items));
}

/**
 * The investment total in CAD: positions and cash with a known positive value, as the allocation view counts them,
 * less any margin debit. With a debit it is net equity, the brokerage total, so a share of it can exceed 100%.
 */
export function investmentTotalCad(items: ExposureItem[], cash: ExposureCash[]): number {
  const s = scoped(items, cash);
  return allocate(s.items, s.cash, "assetClass").slices.reduce((a, x) => a + x.valueCad, 0) - marginDebit(s.cash);
}

/** One row per listing (SYMBOL|CURRENCY), summed across accounts, largest first. */
export function holdingWeights(items: ExposureItem[], cash: ExposureCash[]): HoldingWeight[] {
  const s = scoped(items, cash);
  const total = investmentTotalCad(s.items, s.cash);
  if (total <= 0) return [];
  const denominatorEstimated = totalEstimated(s);
  const rows = new Map<string, HoldingWeight>();
  const names = new Map<string, string>();
  for (const i of s.items) {
    if (!Number.isFinite(i.valueCad) || i.valueCad <= 0 || i.kind === "cash") continue;
    const symbol = upper(i.symbol), currency = upper(i.currency), key = `${symbol}|${currency}`;
    let row = rows.get(key);
    if (!row) rows.set(key, (row = { symbol, currency, key, valueCad: 0, pct: 0, estimated: currency !== "CAD" || denominatorEstimated, listings: [], uncombined: [], basis: EXPOSURE_BASIS }));
    row.valueCad += i.valueCad;
    if (i.name && !names.has(key)) names.set(key, i.name);
  }
  const out = [...rows.values()];
  for (const r of out) {
    r.pct = pct(r.valueCad, total);
    const sameTicker = out.filter((o) => o.key !== r.key && company(o.symbol) === company(r.symbol));
    r.listings = sameTicker.filter((o) => namesAgree(names.get(o.key), names.get(r.key))).map((o) => o.key).sort();
    r.uncombined = sameTicker.filter((o) => !namesAgree(names.get(o.key), names.get(r.key))).map((o) => o.key).sort();
  }
  return out.sort((a, b) => b.valueCad - a.valueCad || a.key.localeCompare(b.key));
}

/**
 * Sector shares of the investment total. Stocks use the market-data `sector`; ETFs and funds are distributed by
 * `sectorWeights` (estimated). `profiles` fills an item's missing profile by symbol.
 */
export function sectorExposure(items: ExposureItem[], cash: ExposureCash[], profiles?: ProfileLookup): SectorExposure {
  const s = scoped(items, cash);
  const total = investmentTotalCad(s.items, s.cash);
  const withProfiles = s.items.map((i) => (i.profile || !profiles ? i : { ...i, profile: profiles.get(i.symbol) ?? profiles.get(upper(i.symbol)) ?? null }));
  const { slices } = allocate(withProfiles, s.cash, "sector");
  const unclassified = slices.find((x) => x.key === "unclassified");
  const denominatorEstimated = totalEstimated(s);
  return {
    sectors: slices.filter((x) => x !== unclassified).map((x) => ({ sector: x.label, pct: pct(x.valueCad, total), estimated: x.estimated || denominatorEstimated })),
    unclassified: { pct: unclassified ? pct(unclassified.valueCad, total) : 0, symbols: [...new Set(unclassified?.holdings.map((h) => h.symbol) ?? [])] },
    basis: EXPOSURE_BASIS,
  };
}

/** Asset-class shares of the investment total (cash included), in the allocation view's classes. */
export function assetClassExposure(items: ExposureItem[], cash: ExposureCash[]): { basis: ExposureBasis; classes: Array<{ assetClass: string; pct: number }> } {
  const s = scoped(items, cash);
  const { slices } = allocate(s.items, s.cash, "assetClass");
  const total = investmentTotalCad(s.items, s.cash);
  return { basis: EXPOSURE_BASIS, classes: slices.map((x) => ({ assetClass: x.label, pct: pct(x.valueCad, total) })) };
}
