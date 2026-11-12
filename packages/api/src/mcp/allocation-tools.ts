import { z } from "zod";
import { allocate, concentration, nestedFundSymbols, overlap, type AllocationItem, type CashItem, type Dimension, type ProfileLookup, type Slice } from "../analytics/allocation.js";
import { marginDebitMatters } from "../analytics/exposure.js";
import { aggregateHoldings, isInvestableClassification, type HoldingRow } from "../analytics/holdings.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import { providerTicker } from "../market-data/ticker-map.js";
import type { SecurityProfile } from "../market-data/types.js";
import type { PortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import type { PortfolioSettingsView, SettingsService } from "../settings/settings-service.js";
import { listAccounts } from "./activity-tools.js";
import { holdsCurrency, loadSettings, withDeadline } from "./overview-tools.js";
import { homeScopeValue, type HomeScopeValue } from "../fx/home-accounts.js";
import { HOME_CURRENCY, homeConverter } from "../fx/home-currency.js";
import { torontoDay } from "../news/refresh-service.js";
import { formatMoney, shortDate } from "./home-fx.js";
import { accountFilterProperties, accountFilterShape, resolveAccountFilter, type AccountType, type ResolvedAccountFilter } from "./query-filters.js";

export const ALLOCATION_WIDGET = "allocation";
export const ALLOCATION_WIDGET_URI = "ui://portfolio/allocation-v1";
const DEFAULT_MARKET_DEADLINE_MS = 5_000;
const FX_WINDOW_DAYS = 7;
const PROFILE_CONCURRENCY = 4;
const MODEL_SLICES = 20;
/** The whole payload must stay under 60 KB; the per-slice holding lists get most of it. */
const SLICES_BUDGET_BYTES = 48_000;
const HOLDINGS_PER_SLICE = [25, 10, 5, 0] as const;
export const ALLOCATION_DIMENSIONS = ["assetClass", "currency", "accountType", "sector", "region"] as const;
const DIMENSION_NAMES: Record<Dimension, string> = { assetClass: "asset class", currency: "currency", accountType: "account", sector: "sector", region: "region" };

export const allocationInput = z.object({
  dimension: z.enum(ALLOCATION_DIMENSIONS).optional(),
  ...accountFilterShape,
}).strict();
export type AllocationInput = z.infer<typeof allocationInput>;

export interface AllocationDeps {
  market: Pick<MarketDataService, "usdCad" | "profile"> & Partial<Pick<MarketDataService, "cachedProfile" | "cachedProfileLookup">>;
  settings: Pick<SettingsService, "get">;
  now?: () => Date;
  /** Budget for each market-data stage (FX; the whole profile phase). Default 5000 ms. */
  marketDeadlineMs?: number;
}

export interface PayloadSlice extends Slice {
  /** Holdings left out of `holdings` to keep the payload small; the slice value still covers them. */
  moreHoldings: number;
}

export interface AllocationPayload {
  dimension: Dimension;
  slices: PayloadSlice[];
  unclassifiedFraction: number;
  estimated: boolean;
  /** Latest Bank of Canada USD/CAD used for CAD-equivalent values; both null when unavailable. */
  fx: { rate: number | null; date: string | null };
  /** True when USD holdings were left out because no exchange rate was available. */
  usdExcluded: boolean;
  /** Currencies other than CAD and USD whose positions or cash were left out (no exchange rate). */
  excludedCurrencies: string[];
  /** Positions without a reported value, left out of every figure. */
  unvalued: number;
  /** Direct figures are always computed. The look-through fields are null / empty unless the dimension is sector or region. */
  concentration: ReturnType<typeof concentration>;
  overlap: ReturnType<typeof overlap>;
  accounts: Array<{ id: string; label: string }>;
  /** `accountId` is also set when `accountType` matched exactly one account. */
  filters: { accountId?: string; accountType?: AccountType };
  /** The portfolio's (or selected account's) CAD total: the same figure Overview and Holdings show. Slices cover positions and cash only. */
  home: HomeScopeValue & { marginDebit?: { amountCad: number; estimated: boolean; netBasis: boolean } };
  settings: PortfolioSettingsView;
  asOf: string;
}

export type AllocationScopeCode = Extract<ResolvedAccountFilter, { ok: false }>["code"];

/** An account filter that cannot be served; `text` is the resolver's copy for the person. */
export class AllocationScopeError extends Error {
  constructor(readonly code: AllocationScopeCode, readonly text: string) { super(code); this.name = "AllocationScopeError"; }
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const itemKind = (kind: string) => (kind === "mutualfund" ? "fund" : kind);

/**
 * Fetches profiles for `tickers`, four at a time, until the shared deadline. Whatever has not finished by then is
 * absent from the result (Unclassified); late results are ignored. Never throws.
 */
async function fetchProfiles(
  fetchOne: (ticker: string) => Promise<SecurityProfile | null>,
  tickers: string[],
  into: ProfileLookup,
  deadlineAt: number,
  now: () => number,
): Promise<void> {
  const queue = [...new Set(tickers)].filter((t) => !into.has(t));
  if (queue.length === 0) return;
  let open = true;
  const worker = async () => {
    while (open && now() < deadlineAt) {
      const ticker = queue.shift();
      if (ticker === undefined) return;
      try {
        const p = await fetchOne(ticker);
        if (open) into.set(ticker, p ?? null);
      } catch { if (open) into.set(ticker, null); }
    }
  };
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, deadlineAt - now()));
    void Promise.all(Array.from({ length: Math.min(PROFILE_CONCURRENCY, queue.length) }, worker)).then(() => { clearTimeout(timer); resolve(); });
  });
  open = false;
}

export interface AllocationBuildOptions {
  /** Serve cached profiles only (the refresh rate limit is spent): uncached holdings are Unclassified. */
  noRefresh?: boolean;
}

export async function buildAllocationPayload(
  deps: AllocationDeps, portfolio: PortfolioPresentation, authSubject: string, input: AllocationInput, options: AllocationBuildOptions = {},
): Promise<AllocationPayload> {
  return (await buildAllocationResult(deps, portfolio, authSubject, input, options)).payload;
}

/**
 * `refreshed`: at least one profile was requested from the market service this call (may reach the provider).
 * When the service offers `cachedProfileLookup` (or `cachedProfile`), cached profiles and known failures are read first
 * and only true misses are fetched.
 */
export async function buildAllocationResult(
  deps: AllocationDeps, portfolio: PortfolioPresentation, authSubject: string, input: AllocationInput, options: AllocationBuildOptions = {},
): Promise<{ payload: AllocationPayload; refreshed: boolean; scope: string; fxConverted: boolean }> {
  const listed = listAccounts(portfolio).filter((a) => a.kind !== "credit");
  const listedIds = new Set(listed.map((a) => a.id));
  // Only listed accounts (open, non-credit, in the total) can be named, by id or by type.
  const resolved = resolveAccountFilter(
    { accounts: portfolio.accounts.filter((a) => listedIds.has(a.id)) },
    { accountId: input.accountId, accountType: input.accountType },
  );
  if (!resolved.ok) throw new AllocationScopeError(resolved.code, resolved.text);
  const ids = resolved.ids;
  const labels = new Map(listed.map((a) => [a.id, a.label]));
  const dimension: Dimension = input.dimension ?? "assetClass";
  const inScope = ids === null ? portfolio.accounts : portfolio.accounts.filter((a) => ids.has(a.id));
  const labelOf = (a: { id: string; classification: { label: string } }) => labels.get(a.id) ?? a.classification.label;
  const all = aggregateHoldings(inScope, {}, labelOf);

  const deadline = deps.marketDeadlineMs ?? DEFAULT_MARKET_DEADLINE_MS;
  const today = (deps.now ?? (() => new Date()))();
  // "Today" is the Toronto date, as in Overview, Activity, Income and News.
  const todayDay = torontoDay(today);
  const fxFrom = isoDay(new Date(today.getTime() - FX_WINDOW_DAYS * 86_400_000));
  // FX is only needed for USD; other currencies have no rate here and are reported as excluded.
  const needsFx = all.rows.some((r) => r.currency === "USD") || all.totals.some((t) => t.currency === "USD" && t.cash > 0);
  const wantsProfiles = dimension === "sector" || dimension === "region";
  const profiles: ProfileLookup = new Map();
  const supported = (c: string) => c === "CAD" || c === "USD";
  const valued = all.rows.filter((r) => r.marketValue !== null && finite(r.marketValue) && r.marketValue > 0);
  const usable = valued.filter((r) => supported(r.currency));
  const tickerOf = (r: HoldingRow) => providerTicker({ symbol: r.symbol, kind: r.kind, currency: r.currency });
  const profiled = (r: HoldingRow) => ["stock", "etf", "fund", "mutualfund"].includes(r.kind);
  // Wall clock on purpose: the deadline is real elapsed time, independent of the injected `now` (a calendar date).
  const clock = () => Date.now();
  const deadlineAt = clock() + deadline;
  let refreshed = false;
  const fetchOne = async (t: string): Promise<SecurityProfile | null> => {
    // Prefer the lookup that also knows recent failures (a known "no data" ticker is not fetched, so not a refresh).
    if (deps.market.cachedProfileLookup) {
      const hit = await deps.market.cachedProfileLookup(t).catch(() => ({ known: false, profile: null }));
      if (hit.known) return hit.profile;
    } else if (deps.market.cachedProfile) {
      const hit = await deps.market.cachedProfile(t).catch(() => null);
      if (hit) return hit;
    }
    if (options.noRefresh) return null;
    refreshed = true;
    return deps.market.profile(t);
  };
  // The FX fetch and the first profile pass start together; both share the one deadline.
  const firstPass = wantsProfiles
    ? fetchProfiles(fetchOne, usable.filter(profiled).map(tickerOf).filter((t): t is string => t !== null), profiles, deadlineAt, clock)
    : Promise.resolve();
  const [fxPoints, settings] = await Promise.all([
    needsFx || holdsCurrency(portfolio, "USD") ? withDeadline(() => deps.market.usdCad(fxFrom, todayDay), deadline, () => null) : Promise.resolve(null),
    loadSettings(deps as Parameters<typeof loadSettings>[0], authSubject),
  ]);
  const conv = homeConverter(fxPoints, todayDay);
  const rate = conv.latest?.rate ?? null;
  const fx = { rate, date: conv.latest?.date ?? null };
  const toCad = (value: number, currency: string): number | null => (currency === "CAD" ? value : currency === "USD" && rate !== null ? value * rate : null);

  // Rows with an unknown value, or a currency without a rate, are excluded. USD without a rate is the case the widget names.
  const unvalued = all.rows.length - valued.length;
  const excludedCurrencies = [...new Set([
    ...valued.filter((r) => !supported(r.currency)).map((r) => r.currency),
    ...all.totals.filter((t) => !supported(t.currency) && t.cash > 0).map((t) => t.currency),
  ])].sort();
  const holdsUsd = usable.some((r) => r.currency === "USD") || all.totals.some((t) => t.currency === "USD" && t.cash > 0);
  const usdExcluded = rate === null && holdsUsd;
  // USD in scope was converted at `fx.rate` / `fx.date`, whatever the accounts' own reported totals are.
  const fxConverted = rate !== null && holdsUsd;

  const positionItemsOf = (list: HoldingRow[]): AllocationItem[] => list.flatMap((r) => {
    const cad = toCad(r.marketValue!, r.currency);
    if (cad === null) return [];
    const t = tickerOf(r);
    return [{ holdingKey: r.key, symbol: r.symbol, kind: itemKind(r.kind), valueCad: cad, currency: r.currency, accountLabel: "", profile: t && wantsProfiles ? profiles.get(t) ?? null : null }];
  });
  if (wantsProfiles) {
    await firstPass;
    // One more bounded pass inside the same deadline: constituents that are themselves funds (needs the rate).
    await fetchProfiles(fetchOne, nestedFundSymbols(positionItemsOf(usable)), profiles, deadlineAt, clock);
  }
  const profileOf = (r: HoldingRow) => { const t = tickerOf(r); return wantsProfiles && t !== null ? profiles.get(t) ?? null : null; };

  const holdingItems: AllocationItem[] = [];
  const positionItems = positionItemsOf(usable);
  for (const r of usable) {
    const kind = itemKind(r.kind);
    const profile = profileOf(r);
    if (toCad(r.marketValue!, r.currency) === null) continue;
    for (const a of r.accounts) {
      const cad = a.marketValue === null ? null : toCad(a.marketValue, r.currency);
      if (cad !== null && cad > 0) holdingItems.push({ holdingKey: r.key, symbol: r.symbol, kind, valueCad: cad, currency: r.currency, accountLabel: a.label, profile });
    }
  }

  // Cash of included, open, non-credit accounts only (the accounts aggregateHoldings counts).
  const cashKept: CashItem[] = [];
  let marginDebit = 0;
  let marginEstimated = false;
  for (const account of inScope) {
    const counted = labels.has(account.id) && isInvestableClassification(account.classification);
    if (!counted) continue;
    for (const b of account.balances ?? []) {
      const currency = b.currency?.trim().toUpperCase();
      if (!currency || !finite(b.cash) || b.cash === 0) continue;
      const cad = toCad(b.cash, currency);
      if (cad === null) continue;
      if (b.cash > 0) cashKept.push({ currency, accountLabel: labels.get(account.id)!, valueCad: cad });
      else { marginDebit += -cad; if (currency !== "CAD") marginEstimated = true; }
    }
  }

  const result = allocate(holdingItems, cashKept, dimension);
  // A margin debit: shares that include cash are of net value (the brokerage total), so they can add up to over 100%.
  // A negative balance under 1% of the positions is not called one (review 5): the shares are of the positive values.
  const gross = result.slices.reduce((s, x) => s + x.valueCad, 0);
  const debitMatters = marginDebitMatters(marginDebit, holdingItems.reduce((s, i) => s + i.valueCad, 0));
  const netBasis = debitMatters && gross - marginDebit > 0 && !wantsProfiles;
  const slicesOnBasis = netBasis ? result.slices.map((s) => ({ ...s, fraction: s.valueCad / (gross - marginDebit) })) : result.slices;
  const conc = concentration(positionItems, wantsProfiles ? profiles : undefined);
  const concentrationOut = wantsProfiles ? conc : { ...conc, largestWithLookThrough: null };
  const overlapOut = wantsProfiles ? overlap(positionItems, profiles) : [];

  const payload: AllocationPayload = {
    dimension,
    slices: fitBudget(slicesOnBasis),
    unclassifiedFraction: round(result.unclassifiedFraction, 6),
    estimated: result.estimated,
    fx, usdExcluded, excludedCurrencies, unvalued,
    concentration: roundConcentration(concentrationOut),
    overlap: overlapOut.slice(0, 20).map((o) => ({ ...o, direct: round(o.direct, 6), indirect: round(o.indirect, 6), combined: round(o.combined, 6) })),
    accounts: listed.map((a) => ({ id: a.id, label: a.label })),
    filters: {
      ...(resolved.singleId !== undefined ? { accountId: resolved.singleId } : {}),
      ...(resolved.accountType !== undefined ? { accountType: resolved.accountType } : {}),
    },
    home: { ...homeScopeValue(portfolio, conv, ids), ...(debitMatters ? { marginDebit: { amountCad: round(marginDebit, 2), estimated: marginEstimated, netBasis } } : {}) },
    settings, asOf: portfolio.generatedAt,
  };
  return { payload, refreshed, scope: resolved.scope, fxConverted };
}

function round(v: number, places: number) { return Math.round(v * 10 ** places) / 10 ** places; }
function roundConcentration(c: ReturnType<typeof concentration>): ReturnType<typeof concentration> {
  return {
    top10: round(c.top10, 6), effectiveN: round(c.effectiveN, 4), estimated: c.estimated,
    largest: c.largest && { ...c.largest, fraction: round(c.largest.fraction, 6) },
    largestWithLookThrough: c.largestWithLookThrough && { ...c.largestWithLookThrough, fraction: round(c.largestWithLookThrough.fraction, 6) },
  };
}

/** Rounds, then shortens each slice's holding list (25, 10, 5, 0) until the slices fit the payload budget. */
function fitBudget(slices: Slice[]): PayloadSlice[] {
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  const build = (cap: number): PayloadSlice[] => slices.map((s) => ({
    ...s, valueCad: round(s.valueCad, 2), fraction: round(s.fraction, 6),
    holdings: s.holdings.slice(0, cap).map((h) => ({ ...h, valueCad: round(h.valueCad, 2) })),
    moreHoldings: Math.max(0, s.holdings.length - cap),
  }));
  let out!: PayloadSlice[];
  for (const cap of HOLDINGS_PER_SLICE) { out = build(cap); if (bytes(out) <= SLICES_BUDGET_BYTES) break; }
  return out;
}

/**
 * What the shares leave out, or "" when they cover everything: positions with no reported value, and USD or other
 * currencies held without an exchange rate (positions and cash). Shares are of the known, convertible value only.
 */
function leftOut(p: AllocationPayload): string[] {
  return [
    ...(p.unvalued > 0 ? [`${p.unvalued} ${p.unvalued === 1 ? "holding has" : "holdings have"} no reported value`] : []),
    ...(p.usdExcluded ? ["USD amounts are left out (no exchange rate)"] : []),
    ...(p.excludedCurrencies.length > 0 ? [`${p.excludedCurrencies.join(", ")} amounts are left out (no exchange rate)`] : []),
  ];
}

/** What the slice shares are of; sector and region leave cash out, and a margin debit makes the total net value. */
function allocationBasis(p: AllocationPayload): string {
  if (p.dimension === "sector" || p.dimension === "region") return "of holdings, cash excluded";
  const debit = p.home.marginDebit;
  if (!debit) return "of total value, cash included";
  const amount = `${formatMoney(debit.amountCad, HOME_CURRENCY)}${debit.estimated ? " est." : ""}`;
  return debit.netBasis
    ? `of net value after a margin debit of ${amount} (the brokerage total), so they can add up to over 100%`
    : `of holdings and positive cash; a margin debit of ${amount} is not in them`;
}

/**
 * Answer first (spec D5): the largest group in the scope, its share and the group count, then what the shares leave
 * out. `scope` and `fxConverted` come from `buildAllocationResult`. Shares carry no amounts. "est." is marked when the
 * payload is estimated, with the Bank of Canada date only when USD was converted in scope (look-through estimates alone
 * have no date). When anything is left out, the first sentence says the share is of known values, so it is not quoted
 * as definite.
 */
export function allocationText(p: AllocationPayload, scope: string, options: { show?: boolean; fxConverted?: boolean } = {}): string {
  const n = p.slices.length;
  const left = leftOut(p);
  const caveat = left.length === 0 ? "" : ` Shares count known values only; ${left.join("; ")}.`;
  let text: string;
  if (n === 0) {
    text = `Nothing to allocate ${scope}.${caveat}`;
  } else {
    const top = p.slices.reduce((best, s) => (s.fraction > best.fraction ? s : best));
    const known = left.length > 0 ? " of known values" : "";
    const estimate = !p.estimated ? ""
      : options.fxConverted && p.fx.date !== null ? ` (est., BoC ${shortDate(p.fx.date, p.asOf.slice(0, 4))})` : " (est.)";
    text = `Largest ${DIMENSION_NAMES[p.dimension]} ${scope}: ${top.label} at ${(top.fraction * 100).toFixed(1)}%${known}${estimate}, among ${n} ${n === 1 ? "group" : "groups"}. Shares are ${allocationBasis(p)}.${caveat}`;
  }
  return options.show ? `${text} Showing the allocation widget.` : text;
}

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** Compact copy for the model: top 20 slices (label, share), concentration and overlap counts; no ids or amounts. */
export function allocationModelCopy(p: AllocationPayload) {
  const accountLabel = p.filters.accountId === undefined ? undefined : p.accounts.find((a) => a.id === p.filters.accountId)?.label;
  return {
    dimension: p.dimension,
    filters: { ...(accountLabel ? { accountLabel } : {}), ...(p.filters.accountType ? { accountType: p.filters.accountType } : {}) },
    slices: p.slices.slice(0, MODEL_SLICES).map((s) => ({ label: s.label, share: r4(s.fraction), holdings: s.holdings.length + s.moreHoldings })),
    hasMore: p.slices.length > MODEL_SLICES,
    unclassifiedShare: r4(p.unclassifiedFraction),
    concentration: {
      estimated: p.concentration.estimated,
      top10: r4(p.concentration.top10), effectiveHoldings: r4(p.concentration.effectiveN),
      largest: p.concentration.largest && { symbol: p.concentration.largest.symbol, share: r4(p.concentration.largest.fraction) },
      largestWithLookThrough: p.concentration.largestWithLookThrough && { symbol: p.concentration.largestWithLookThrough.symbol, share: r4(p.concentration.largestWithLookThrough.fraction), estimated: true },
    },
    overlap: p.overlap.slice(0, 10).map((o) => ({ symbol: o.symbol, combinedShare: r4(o.combined) })),
    notes: {
      share: `share ${allocationBasis(p)}; USD is converted at the Bank of Canada rate and is an estimate.`,
      concentration: "top10, effectiveHoldings and largest are of holdings, cash excluded.",
      lookThrough: "Sector and region shares of ETFs and funds use Yahoo Finance data and are estimates; missing data is Unclassified. Look-through concentration and overlap are only computed for the sector and region views.",
    },
    ...(p.usdExcluded ? { usdHoldingsExcluded: true } : {}),
    excludedCurrencies: p.excludedCurrencies,
    unvalued: p.unvalued,
  };
}

const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const security = [{ type: "oauth2" as const, scopes: ["portfolio:read"] }];

const inputSchema = {
  type: "object",
  properties: {
    dimension: { type: "string", enum: [...ALLOCATION_DIMENSIONS] },
    ...accountFilterProperties,
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  properties: {
    dimension: { type: "string" }, slices: { type: "array" }, unclassifiedFraction: { type: "number" }, estimated: { type: "boolean" },
    fx: { type: "object" }, usdExcluded: { type: "boolean" }, excludedCurrencies: { type: "array" }, unvalued: { type: "integer" }, concentration: { type: "object" }, overlap: { type: "array" },
    accounts: { type: "array" }, filters: { type: "object" }, home: { type: "object" }, settings: { type: "object" }, asOf: { type: "string" },
  },
  required: ["dimension", "slices", "unclassifiedFraction", "estimated", "fx", "usdExcluded", "excludedCurrencies", "unvalued", "concentration", "overlap", "accounts", "filters", "home", "settings", "asOf"],
  additionalProperties: false,
} as const;

export const allocationToolDefinitions = [
  {
    name: "show_allocation",
    title: "Show allocation",
    description: "Use this when the user asks about their allocation, diversification, exposure by sector/region/currency/account, or concentration: renders the interactive allocation view. Filter with accountType or accountId. Read-only.",
    inputSchema,
    outputSchema,
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    _meta: {
      securitySchemes: security, ui: { resourceUri: ALLOCATION_WIDGET_URI }, "openai/outputTemplate": ALLOCATION_WIDGET_URI,
      "openai/widgetAccessible": true, "openai/toolInvocation/invoking": "Loading allocation…", "openai/toolInvocation/invoked": "Allocation ready.",
    },
  },
  {
    name: "get_allocation",
    title: "Get allocation",
    description: "Used by the allocation widget to regroup holdings by asset class, currency, account, sector or region. Covers the user's investment accounts. Read-only.",
    inputSchema,
    outputSchema,
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    _meta: { securitySchemes: security, ui: { visibility: ["app"] } },
  },
] as const;
