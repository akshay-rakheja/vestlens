import { assetClassExposure, exposureEstimated, exposureNetOfMargin, holdingWeights, investmentTotalCad, sectorExposure, type ExposureCash, type ExposureItem, type HoldingWeight } from "../analytics/exposure.js";
import type { ConcentrationLimit } from "../memory/memory-types.js";
import { freshDay, POSITIONS_STALE_NOTE, torontoDay } from "../portfolio/data-freshness.js";
import { oneLineUserText } from "../mcp/user-text.js";

/**
 * Concentration limit check (spec 2026-10-24 §6, §11a.6-7): a pure evaluation of each limit against the scope the
 * loader built. It states facts only. A limit's number needs fresh positions (PRICE_STALE_TRADING_DAYS), every account
 * in its subset still connected, a reported value for every holding in scope, and every value converted to CAD;
 * otherwise it is `cant_tell` with no number. Closed or credit accounts named in a subset are not counted, and noted.
 *
 * - Every percentage is of the scope's investment total, cash included (`basis: "portfolio_incl_cash"`); the `note`
 *   says so ("of your portfolio, cash included" or "of the chosen accounts, cash included"). The `line` keeps the
 *   verbatim templates; the basis is never put inside it.
 * - A limit with a `target` is evaluated for that holding, sector or asset class. Without one ("no single holding above
 *   X%"), each holding, sector or class over the limit gets a row; when none is over, the largest gets one row.
 * - A company held under several exchange listings (SHOP in CAD and USD, TD.TO and TD) is evaluated on one combined row;
 *   its listing rows follow, `informational`, carrying the combined status and no verdict of their own. Share classes
 *   (CTC, CTC.A) are different securities and are never combined.
 * - With a margin debit in scope the total is net equity (the brokerage total), so a share can exceed 100%; the note says so.
 * - Sector shares are of the classified value; unclassified holdings are listed with their combined share (Review
 *   Focus 3). A share at or under the limit that the unclassified share could take over it is `cant_tell`.
 *
 * Every string is VestLens copy except the user's own target (the label), kept to one line with control and format
 * characters removed.
 */

export interface LimitScope {
  /** Positions and cash of the scope's included, open, non-credit accounts, in CAD. */
  items: ExposureItem[];
  cash: ExposureCash[];
  /** The oldest positions date (Toronto) across the scope's accounts; null when any is unknown. */
  positionsAsOf: string | null;
  /** Accounts named in the limit's subset that are no longer connected. */
  missingAccounts: number;
  /** Accounts named in the limit's subset that are closed or credit products (not counted). */
  excludedAccounts: number;
  /** Symbols of holdings with no reported value (not counted). */
  unvalued: string[];
  /** Currencies of values that could not be converted to CAD. */
  notConverted: string[];
  /** The limit names a subset of accounts. */
  subset: boolean;
  /** The Bank of Canada rate date (latest) of any USD amount converted into this scope; null/absent when none was. */
  fxDate?: string | null;
  /** Managed accounts in the scope with no value from the brokerage: their labels (managedNotInTotal). */
  notInTotal?: string[];
}

export interface LimitInput {
  limits: Array<{ slug: string; limit: ConcentrationLimit; scope: LimitScope }>;
}

export type LimitStatus = "within" | "over" | "cant_tell";

export interface LimitCheck {
  slug: string;
  label: string;
  kind: ConcentrationLimit["kind"];
  maxPct: number;
  currentPct: number | null;
  status: LimitStatus;
  line: string;
  unclassifiedPct?: number;
  note?: string;
  /** Present when a USD amount in the scope was converted at the Bank of Canada rate of this date. */
  fxDate?: string;
  /** The figure holds a converted amount or a fund's estimated weights. Absent on a row with no figure. */
  estimated?: boolean;
  /** One listing of a company evaluated on its combined row: a breakdown, with no verdict of its own (never a nudge). */
  informational?: true;
  /**
   * A stable key for the row's group, unlike `label`: the listing ("SYMBOL|CURRENCY") for a holding, "COMPANY|ALL" for a
   * combined company, else the sector or class name, or "*" for a whole-limit can't tell. Internal (nudge keys); not part
   * of the shown result.
   */
  groupKey?: string;
}

const NOTE = {
  portfolioBasis: "Share of your portfolio, cash included",
  subsetBasis: "Share of the chosen accounts, cash included",
  disconnected: "an account in this limit is no longer connected",
  noPositionsDate: "latest positions date is unknown",
  nothing: "no holdings or cash to measure",
  notConverted: (currencies: string[]) => `values in ${currencies.join(", ")} could not be converted to CAD`,
  unvalued: (symbols: string[]) => `a holding in this limit has no reported value (${symbols.join(", ")})`,
  excluded: (n: number) => n === 1 ? "1 account in this limit is closed or a credit product and is not counted"
    : `${n} accounts in this limit are closed or credit products and are not counted`,
  converted: (date: string) => `USD converted at the Bank of Canada rate of ${date}`,
  margin: "net of a margin debit (the brokerage total), so a share can be over 100%",
  uncombined: "other listings not combined",
  notInTotal: (labels: string[]) => `Not included in the total: ${labels.join(", ")}. SnapTrade doesn't provide the value of Wealthsimple managed portfolios`,
  unclassified: (pct: string, symbols: string[]) => `${pct}% is not in any sector (no sector data): ${symbols.join(", ")}`,
  noSector: (target: string, held: string[]) => held.length > 0
    ? `no holding is classified as ${target}; sectors held: ${held.join(", ")}`
    : `no holding is classified as ${target}`,
  noClass: (target: string, held: string[]) => `no holding is in ${target}; asset classes held: ${held.join(", ")}`,
};

/** A percentage for copy: one decimal at most, no trailing ".0". */
export const formatPct = (n: number): string => String(Math.round(n * 10) / 10);

const estTag = (estimated: boolean) => (estimated ? " (est.)" : "");
export const overLine = (label: string, pct: number, max: number, estimated = true) => `${label} ${formatPct(pct)}%${estTag(estimated)}, over your ${formatPct(max)}% limit`;
export const withinLine = (label: string, pct: number, max: number, estimated = true) => `${label} ${formatPct(pct)}%${estTag(estimated)} of your ${formatPct(max)}% limit`;
const listingLine = (label: string, pct: number, combined: string, estimated: boolean) => `${label} ${formatPct(pct)}%${estTag(estimated)}, counted in ${combined}`;
const cantTellLine = (label: string, max: number) => `${label}: can't tell against your ${formatPct(max)}% limit`;
const partialLine = (label: string, pct: number, unclassified: number, max: number, estimated = true) =>
  `${label} ${formatPct(pct)}%${estTag(estimated)} classified, ${formatPct(unclassified)}% unclassified: can't tell against your ${formatPct(max)}% limit`;

const upper = (s: string) => s.trim().toUpperCase();
const LISTING_SUFFIX = /\.(TO|V|NE|NEO|CN)$/;
const company = (symbol: string) => upper(symbol).replace(LISTING_SUFFIX, "");
const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Common names of the allocation view's asset classes. */
const CLASS_ALIASES: Record<string, string> = {
  stock: "stocks", stocks: "stocks", equities: "stocks", equity: "stocks", shares: "stocks",
  etf: "etfs funds", etfs: "etfs funds", fund: "etfs funds", funds: "etfs funds", "etfs and funds": "etfs funds",
  cash: "cash", crypto: "crypto", cryptocurrency: "crypto", other: "other",
};
const classMatches = (target: string, label: string) => {
  const t = norm(target);
  return norm(label) === t || CLASS_ALIASES[t] === norm(label);
};

interface Group { label: string; pct: number }
/** One company: its listing rows, largest first, and their combined share (one row when it has one listing). */
interface Company { name: string; key: string; pct: number; estimated: boolean; listings: HoldingWeight[] }

function companiesOf(weights: HoldingWeight[]): Company[] {
  const out: Company[] = [];
  for (const w of weights) {
    const found = out.find((c) => c.listings.some((l) => w.listings.includes(l.key)));
    if (found) {
      found.listings.push(w);
      found.pct += w.pct;
      found.estimated ||= w.estimated;
    } else {
      out.push({ name: company(w.symbol), key: w.key, pct: w.pct, estimated: w.estimated, listings: [w] });
    }
  }
  return out;
}

function evaluate(slug: string, saved: ConcentrationLimit, scope: LimitScope, today: string): LimitCheck[] {
  // The target is the user's own text, placed inside VestLens's lines: one line, no control or format characters (I-1).
  const target0 = saved.target ? oneLineUserText(saved.target) : "";
  const limit: ConcentrationLimit = { ...saved, ...(target0 ? { target: target0 } : {}) };
  if (!target0) delete limit.target;
  const { kind, maxPct } = limit;
  const notes: string[] = [scope.subset ? NOTE.subsetBasis : NOTE.portfolioBasis];
  const fallbackLabel = limit.target?.trim() || (kind === "single_holding" ? "Largest holding" : kind === "sector" ? "Largest sector" : "Largest asset class");
  const cantTell = (reason: string, label = fallbackLabel): LimitCheck[] => [{
    slug, label, kind, maxPct, currentPct: null, status: "cant_tell", line: cantTellLine(label, maxPct), note: [...notes, reason].join("; "), groupKey: "*",
  }];

  if (scope.fxDate) notes.push(NOTE.converted(scope.fxDate));
  if (scope.excludedAccounts > 0) notes.push(NOTE.excluded(scope.excludedAccounts));
  if (exposureNetOfMargin(scope.items, scope.cash)) notes.push(NOTE.margin);
  if (scope.notInTotal && scope.notInTotal.length > 0) notes.push(NOTE.notInTotal(scope.notInTotal));
  if (scope.missingAccounts > 0) return cantTell(NOTE.disconnected);
  if (scope.positionsAsOf === null) return cantTell(NOTE.noPositionsDate);
  if (!freshDay(scope.positionsAsOf, today)) return cantTell(POSITIONS_STALE_NOTE);
  if (scope.notConverted.length > 0) return cantTell(NOTE.notConverted([...new Set(scope.notConverted)].sort()));
  if (investmentTotalCad(scope.items, scope.cash) <= 0) return cantTell(NOTE.nothing);
  // An unvalued holding could be the one over the limit, and is missing from every denominator (I-1).
  if (scope.unvalued.length > 0) return cantTell(NOTE.unvalued([...new Set(scope.unvalued)].sort()));

  const totalEstimated = exposureEstimated(scope.items, scope.cash);
  const row = (rawLabel: string, pct: number, extra: string[] = [], unclassifiedPct?: number, groupKey: string = rawLabel, estimated = totalEstimated): LimitCheck => {
    const label = oneLineUserText(rawLabel);
    const unclassified = unclassifiedPct ?? 0;
    const status: LimitStatus = pct > maxPct ? "over" : pct + unclassified > maxPct ? "cant_tell" : "within";
    const line = status === "over" ? overLine(label, pct, maxPct, estimated) : status === "within" ? withinLine(label, pct, maxPct, estimated) : partialLine(label, pct, unclassified, maxPct, estimated);
    return {
      slug, label, kind, maxPct, currentPct: pct, status, line, estimated,
      ...(unclassifiedPct !== undefined ? { unclassifiedPct } : {}),
      note: [...notes, ...extra].join("; "),
      groupKey,
    };
  };
  /** With a target: that one group. Without: each group over the limit, or the largest when none is. */
  const pick = (groups: Group[], threshold: (g: Group) => boolean): Group[] => {
    const sorted = [...groups].sort((a, b) => b.pct - a.pct || a.label.localeCompare(b.label));
    const over = sorted.filter(threshold);
    return over.length > 0 ? over : sorted.slice(0, 1);
  };

  if (kind === "single_holding") {
    const weights = holdingWeights(scope.items, scope.cash);
    const sameSymbol = (w: { symbol: string }) => weights.filter((o) => o.symbol === w.symbol).length > 1;
    const labelOf = (w: { symbol: string; currency: string }) => (sameSymbol(w) ? `${w.symbol} (${w.currency})` : w.symbol);
    const companies = companiesOf(weights);
    const target = limit.target?.trim();
    const named = target ? companies.filter((c) => c.name === company(target)) : [];
    // Two companies can share a ticker across exchanges: the listing named is the one meant.
    const exact = target ? named.filter((c) => c.listings.some((l) => l.symbol === upper(target))) : [];
    const chosen = target
      ? (exact.length > 0 ? exact : named)
      : pick(companies.map((c) => ({ label: c.key, pct: c.pct })), (g) => g.pct > maxPct).map((g) => companies.find((c) => c.key === g.label)!);
    if (chosen.length === 0) {
      if (target) return [row(target, 0)];
      return cantTell(NOTE.nothing);
    }
    return chosen.flatMap((c) => {
      // Another row under this ticker with a different company name is a different company: said, never summed (review 4).
      if (c.listings.length === 1) { const w = c.listings[0]!; return [row(labelOf(w), w.pct, w.uncombined.length > 0 ? [NOTE.uncombined] : [], undefined, w.key, w.estimated)]; }
      const label = `${c.name} (all listings)`;
      const combined = row(label, c.pct, [], undefined, `${c.name}|ALL`, c.estimated);
      return [combined, ...c.listings.map((w): LimitCheck => ({
        ...row(labelOf(w), w.pct, [], undefined, w.key, w.estimated), status: combined.status, line: listingLine(labelOf(w), w.pct, label, w.estimated), informational: true,
      }))];
    });
  }

  if (kind === "sector") {
    const exposure = sectorExposure(scope.items, scope.cash);
    const unclassifiedPct = exposure.unclassified.pct;
    const extra = unclassifiedPct > 0 ? [NOTE.unclassified(formatPct(unclassifiedPct), exposure.unclassified.symbols)] : [];
    const groups: Group[] = exposure.sectors.map((s) => ({ label: s.sector, pct: s.pct }));
    const estimatedOf = (label: string) => exposure.sectors.find((s) => s.sector === label)?.estimated ?? totalEstimated;
    const target = limit.target?.trim();
    if (target) {
      const match = groups.find((g) => norm(g.label) === norm(target));
      if (!match) return [row(target, 0, [...extra, NOTE.noSector(target, groups.map((g) => g.label).sort())], unclassifiedPct)];
      return [row(match.label, match.pct, extra, unclassifiedPct, match.label, estimatedOf(match.label))];
    }
    if (groups.length === 0) return [row("Largest sector", 0, extra, unclassifiedPct)];
    return pick(groups, (g) => g.pct + unclassifiedPct > maxPct).map((g) => row(g.label, g.pct, extra, unclassifiedPct, g.label, estimatedOf(g.label)));
  }

  const classes: Group[] = assetClassExposure(scope.items, scope.cash).classes.map((c) => ({ label: c.assetClass, pct: c.pct }));
  const target = limit.target?.trim();
  if (target) {
    const match = classes.find((c) => classMatches(target, c.label));
    return match ? [row(match.label, match.pct)] : [row(target, 0, [NOTE.noClass(target, classes.map((c) => c.label).sort())])];
  }
  return pick(classes, (g) => g.pct > maxPct).map((g) => row(g.label, g.pct));
}

export function checkLimits(input: LimitInput, now: Date): LimitCheck[] {
  const today = torontoDay(now);
  return input.limits.flatMap(({ slug, limit, scope }) => evaluate(slug, limit, scope, today).map((r) => (scope.fxDate ? { ...r, fxDate: scope.fxDate } : r)));
}

/**
 * The limits that touch one holding (show_thesis's holding view), each as its own line, from the same scopes:
 * - single holding: a limit on this ticker or another listing of its company, or on any one holding (then evaluated for
 *   this one). A company under several listings gives its combined row and this listing's informational row;
 * - sector: a limit on a sector the holding is in (a stock's sector, a fund's weighted sectors), or on any sector when the
 *   holding is in exactly one (then evaluated for that sector);
 * - asset class: a limit on the holding's class, or on any class (then evaluated for its class).
 * A limit whose scope doesn't hold it is not shown; a whole-limit can't tell (stale, disconnected, unvalued) is.
 */
export function limitsTouchingHolding(input: LimitInput, symbol: string, now: Date): LimitCheck[] {
  const want = upper(symbol);
  const out: LimitCheck[] = [];
  const evalOne = (entry: LimitInput["limits"][number], limit: ConcentrationLimit, keep: (r: LimitCheck) => boolean) =>
    out.push(...checkLimits({ limits: [{ ...entry, limit }] }, now).filter((r) => r.groupKey === "*" || keep(r)));
  for (const entry of input.limits) {
    const { limit, scope } = entry;
    const mine = scope.items.filter((i) => upper(i.symbol) === want);
    const inScope = mine.length > 0 || scope.unvalued.some((u) => upper(u) === want);
    const target = limit.target ? oneLineUserText(limit.target) : "";
    if (limit.kind === "single_holding") {
      if (target && company(target) !== company(want)) continue;
      if (!inScope && !(target && upper(target) === want)) continue;
      const ofMine = (r: LimitCheck) => {
        const [group, currency] = (r.groupKey ?? "").split("|");
        return group === want || upper(r.label) === want || (currency === "ALL" && group === company(want));
      };
      evalOne(entry, target ? limit : { ...limit, target: want }, ofMine);
      continue;
    }
    if (!inScope) continue;
    if (mine.length === 0) { evalOne(entry, limit, () => false); continue; } // unvalued here: only the whole-limit can't tell
    if (limit.kind === "sector") {
      const sectors = sectorExposure(mine, []).sectors.map((x) => x.sector);
      if (target) {
        if (sectors.some((x) => norm(x) === norm(target))) evalOne(entry, limit, () => true);
      } else if (sectors.length === 1) {
        evalOne(entry, { ...limit, target: sectors[0]! }, () => true);
      }
      continue;
    }
    const cls = assetClassExposure(mine, []).classes[0]?.assetClass;
    if (!cls) continue;
    if (target) { if (classMatches(target, cls)) evalOne(entry, limit, () => true); }
    else evalOne(entry, { ...limit, target: cls }, () => true);
  }
  return out;
}
