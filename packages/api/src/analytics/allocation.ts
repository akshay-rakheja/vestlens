import type { SecurityProfile } from "../market-data/types.js";
import { regionOf } from "./regions.js";

export type Dimension = "assetClass" | "currency" | "accountType" | "sector" | "region";
export interface AllocationItem { holdingKey: string; symbol: string; kind: string; valueCad: number; currency: string; accountLabel: string; profile: SecurityProfile | null }
export interface Slice { key: string; label: string; valueCad: number; fraction: number; estimated: boolean; holdings: Array<{ holdingKey: string; symbol: string; valueCad: number }> }
export interface CashItem { currency: string; accountLabel: string; valueCad: number }
/**
 * Optional look-through lookup supplied by the caller: ticker -> profile of a fund held inside another fund.
 * Only one nested level is ever expanded. Use `nestedFundSymbols` to learn which tickers to fetch.
 */
export type ProfileLookup = Map<string, SecurityProfile | null>;

const UNCLASSIFIED_KEY = "unclassified";
const UNCLASSIFIED_LABEL = "Unclassified (no data)";
const ASSET_CLASS: Record<string, string> = { etf: "ETFs & funds", fund: "ETFs & funds", stock: "Stocks", crypto: "Crypto", cash: "Cash", other: "Other" };

const known = (i: AllocationItem) => Number.isFinite(i.valueCad) && i.valueCad > 0;
const isFund = (i: AllocationItem) => i.kind === "etf" || i.kind === "fund";
const upper = (s: string) => s.toUpperCase();

interface Part { key: string; label: string; holdingKey: string; symbol: string; valueCad: number; estimated: boolean }

function itemParts(i: AllocationItem, dimension: Dimension): Part[] {
  const fx = i.currency.toUpperCase() !== "CAD";
  const whole = (key: string, label: string, estimated = fx): Part[] => [{ key, label, holdingKey: i.holdingKey, symbol: i.symbol, valueCad: i.valueCad, estimated }];
  const unclassified = (value: number, estimated = fx): Part => ({ key: UNCLASSIFIED_KEY, label: UNCLASSIFIED_LABEL, holdingKey: i.holdingKey, symbol: i.symbol, valueCad: value, estimated });
  const distribute = (weights: Record<string, number>, label: (name: string) => string): Part[] => {
    const entries = Object.entries(weights).filter(([, w]) => Number.isFinite(w) && w > 0);
    const total = entries.reduce((a, [, w]) => a + w, 0);
    const scale = total > 1 ? 1 / total : 1;
    const parts = entries.map(([name, w]): Part => ({ key: label(name).toLowerCase(), label: label(name), holdingKey: i.holdingKey, symbol: i.symbol, valueCad: i.valueCad * w * scale, estimated: true }));
    const rest = 1 - Math.min(total, 1);
    if (rest > 1e-9) parts.push(unclassified(i.valueCad * rest, true));
    return parts;
  };
  if (i.kind === "cash" && (dimension === "sector" || dimension === "region")) return [];
  switch (dimension) {
    case "assetClass": {
      const label = ASSET_CLASS[i.kind] ?? "Other";
      return whole(label.toLowerCase(), label);
    }
    case "currency": return whole(i.currency.toUpperCase(), i.currency.toUpperCase());
    case "accountType": return whole(i.accountLabel.toLowerCase(), i.accountLabel);
    case "sector": {
      const p = i.profile;
      if (isFund(i) && p?.sectorWeights) return distribute(p.sectorWeights, (n) => n);
      if (i.kind === "stock" && p?.sector) return whole(p.sector.toLowerCase(), p.sector);
      return [unclassified(i.valueCad)];
    }
    case "region": {
      const p = i.profile;
      if (isFund(i) && p?.countryWeights) {
        const byRegion = new Map<string, number>();
        for (const [country, w] of Object.entries(p.countryWeights)) byRegion.set(regionOf(country), (byRegion.get(regionOf(country)) ?? 0) + w);
        return distribute(Object.fromEntries(byRegion), (n) => n);
      }
      if (i.kind === "stock" && p?.country) { const r = regionOf(p.country); return whole(r.toLowerCase(), r); }
      return [unclassified(i.valueCad)];
    }
  }
}

function cashParts(c: CashItem, dimension: Dimension): Part[] {
  const cur = c.currency.toUpperCase();
  const base = { holdingKey: `cash:${c.accountLabel}:${cur}`, symbol: `Cash (${cur})`, valueCad: c.valueCad, estimated: cur !== "CAD" };
  if (dimension === "assetClass") return [{ ...base, key: "cash", label: "Cash" }];
  if (dimension === "currency") return [{ ...base, key: `cash-${cur}`, label: `Cash (${cur})` }];
  if (dimension === "accountType") return [{ ...base, key: c.accountLabel.toLowerCase(), label: c.accountLabel }];
  return []; // cash is excluded from sector and region
}

/** Groups CAD-equivalent values by `dimension`. Positions with unknown (non-finite or non-positive) value are excluded. */
export function allocate(items: AllocationItem[], cashCad: CashItem[], dimension: Dimension): { slices: Slice[]; unclassifiedFraction: number; estimated: boolean } {
  const parts = [
    ...items.filter(known).flatMap((i) => itemParts(i, dimension)),
    ...cashCad.filter((c) => Number.isFinite(c.valueCad) && c.valueCad > 0).flatMap((c) => cashParts(c, dimension)),
  ].filter((p) => p.valueCad > 0);
  const total = parts.reduce((a, p) => a + p.valueCad, 0);
  if (total <= 0) return { slices: [], unclassifiedFraction: 0, estimated: false };
  const groups = new Map<string, Slice>();
  for (const p of parts) {
    let s = groups.get(p.key);
    if (!s) groups.set(p.key, (s = { key: p.key, label: p.label, valueCad: 0, fraction: 0, estimated: false, holdings: [] }));
    s.valueCad += p.valueCad;
    s.estimated ||= p.estimated;
    const h = s.holdings.find((x) => x.holdingKey === p.holdingKey);
    if (h) h.valueCad += p.valueCad; else s.holdings.push({ holdingKey: p.holdingKey, symbol: p.symbol, valueCad: p.valueCad });
  }
  const slices = [...groups.values()];
  for (const s of slices) { s.fraction = s.valueCad / total; s.holdings.sort((a, b) => b.valueCad - a.valueCad); }
  slices.sort((a, b) => (a.key === UNCLASSIFIED_KEY ? 1 : b.key === UNCLASSIFIED_KEY ? -1 : b.valueCad - a.valueCad || a.label.localeCompare(b.label)));
  return {
    slices,
    unclassifiedFraction: groups.get(UNCLASSIFIED_KEY)?.fraction ?? 0,
    estimated: slices.some((s) => s.estimated),
  };
}

const investable = (items: AllocationItem[]) => items.filter((i) => known(i) && i.kind !== "cash");

/**
 * Every top-holding symbol of held funds that is not held directly (Yahoo lists at most ~10 per fund). The caller may fetch their profiles for one extra look-through
 * level; profiles are cached for 7 days and the caller bounds concurrency. Directly held funds are resolved from the held item.
 */
export function nestedFundSymbols(items: AllocationItem[]): string[] {
  const held = new Set(items.map((i) => upper(i.symbol)));
  const out = new Set<string>();
  for (const i of investable(items)) if (isFund(i)) for (const h of i.profile?.topHoldings ?? []) if (!held.has(upper(h.symbol))) out.add(h.symbol);
  return [...out];
}

// Resolves a symbol's profile: the caller's lookup first, then a directly held item with that symbol.
function resolver(items: AllocationItem[], profiles?: ProfileLookup) {
  const heldProfile = new Map<string, SecurityProfile | null>();
  const heldFund = new Set<string>();
  for (const i of items) {
    if (i.profile && !heldProfile.get(upper(i.symbol))) heldProfile.set(upper(i.symbol), i.profile);
    if (isFund(i)) heldFund.add(upper(i.symbol));
  }
  const profileOf = (symbol: string): SecurityProfile | null =>
    profiles?.get(symbol) ?? profiles?.get(upper(symbol)) ?? heldProfile.get(upper(symbol)) ?? null;
  const isFundSymbol = (symbol: string) => heldFund.has(upper(symbol)) || profileOf(symbol)?.kind === "fund" || !!profileOf(symbol)?.topHoldings?.length;
  // A fund's constituents with weights relative to the fund; a top holding that is itself a fund with known
  // top holdings is replaced by those (scaled by its parent weight). One level only.
  const lookThrough = (i: AllocationItem): Array<{ symbol: string; weight: number; suspect?: true }> | null => {
    const top = i.profile?.topHoldings;
    if (!isFund(i) || !top?.length) return null;
    const out: Array<{ symbol: string; weight: number; suspect?: true }> = [];
    // Safety net: when any constituent is a known fund, an unprofiled sibling may be a fund too, so it is
    // kept out of company rankings (its value still counts in totals).
    const anyKnownFund = top.some((h) => isFundSymbol(h.symbol));
    for (const h of top) {
      const nested = profileOf(h.symbol)?.topHoldings;
      if (nested?.length && upper(h.symbol) !== upper(i.symbol)) for (const n of nested) out.push({ symbol: n.symbol, weight: h.weight * n.weight });
      else out.push(anyKnownFund && !profileOf(h.symbol)?.kind?.match(/stock|fund/) ? { ...h, suspect: true } : h);
    }
    return out;
  };
  return { isFundSymbol, lookThrough };
}

/** top10 and effectiveN use direct holdings only (cash and unknown values excluded). */
export function concentration(items: AllocationItem[], profiles?: ProfileLookup): { top10: number; effectiveN: number; largest: { symbol: string; fraction: number } | null; largestWithLookThrough: { symbol: string; fraction: number; estimated: true } | null; estimated: boolean } {
  const rows = investable(items);
  const total = rows.reduce((a, i) => a + i.valueCad, 0);
  if (!rows.length || total <= 0) return { top10: 0, effectiveN: 0, largest: null, largestWithLookThrough: null, estimated: false };
  const ranked = rows.map((i) => ({ symbol: i.symbol, fraction: i.valueCad / total })).sort((a, b) => b.fraction - a.fraction);
  const hhi = ranked.reduce((a, r) => a + r.fraction ** 2, 0);
  const { isFundSymbol, lookThrough } = resolver(items, profiles);
  // Only company-level exposure is eligible: direct non-fund holdings and leaf constituents.
  const exposure = new Map<string, { symbol: string; value: number }>();
  const add = (symbol: string, v: number) => {
    if (isFundSymbol(symbol)) return;
    const e = exposure.get(upper(symbol)) ?? { symbol, value: 0 };
    e.value += v;
    exposure.set(upper(symbol), e);
  };
  for (const i of rows) {
    const parts = isFund(i) ? lookThrough(i) : null;
    if (!parts) { if (!isFund(i)) add(i.symbol, i.valueCad); continue; }
    for (const p of parts) if (!p.suspect) add(p.symbol, i.valueCad * p.weight);
  }
  const best = [...exposure.values()].sort((a, b) => b.value - a.value)[0];
  return {
    top10: ranked.slice(0, 10).reduce((a, r) => a + r.fraction, 0),
    effectiveN: 1 / hhi,
    largest: ranked[0],
    largestWithLookThrough: best ? { symbol: best.symbol, fraction: best.value / total, estimated: true } : null,
    // Values are CAD-equivalent: converted (so estimated) whenever any counted holding is not in CAD.
    estimated: rows.some((i) => i.currency.toUpperCase() !== "CAD"),
  };
}

/**
 * Company symbols held directly and/or through fund top holdings. A symbol is listed when it is held directly
 * AND through at least one fund, or reached through two or more funds. Fund symbols are never listed.
 * Fractions are of the investable total.
 */
export function overlap(items: AllocationItem[], profiles?: ProfileLookup): Array<{ symbol: string; direct: number; indirect: number; combined: number; estimated: true }> {
  const rows = investable(items);
  const total = rows.reduce((a, i) => a + i.valueCad, 0);
  if (total <= 0) return [];
  const { isFundSymbol, lookThrough } = resolver(items, profiles);
  const map = new Map<string, { symbol: string; direct: number; indirect: number; funds: Set<string> }>();
  const entry = (symbol: string) => {
    let e = map.get(upper(symbol));
    if (!e) map.set(upper(symbol), (e = { symbol, direct: 0, indirect: 0, funds: new Set() }));
    return e;
  };
  for (const i of rows) {
    const parts = isFund(i) ? lookThrough(i) : null;
    if (!parts) { if (!isFund(i)) entry(i.symbol).direct += i.valueCad; continue; }
    for (const p of parts) { if (p.suspect) continue; const e = entry(p.symbol); e.indirect += i.valueCad * p.weight; e.funds.add(i.holdingKey); }
  }
  return [...map.values()]
    .filter((e) => !isFundSymbol(e.symbol) && ((e.direct > 0 && e.indirect > 0) || e.funds.size >= 2))
    .map((e) => ({ symbol: e.symbol, direct: e.direct / total, indirect: e.indirect / total, combined: (e.direct + e.indirect) / total, estimated: true as const }))
    .sort((a, b) => b.combined - a.combined);
}
