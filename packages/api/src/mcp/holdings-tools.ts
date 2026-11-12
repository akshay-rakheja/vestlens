import { z } from "zod";
import { aggregateHoldings, applyDayChange, isInvestable, type HoldingRow, type HoldingsTotals } from "../analytics/holdings.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import type { Quote } from "../market-data/types.js";
import { providerTicker } from "../market-data/ticker-map.js";
import type { PortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import type { PortfolioSettingsView, SettingsService } from "../settings/settings-service.js";
import { listAccounts } from "./activity-tools.js";
import { holdsCurrency, loadSettings, withDeadline } from "./overview-tools.js";
import { CAD_NOTE, formatMoney, homeQualifier, shortDate } from "./home-fx.js";
import { homeScopeValue } from "../fx/home-accounts.js";
import { HOME_CURRENCY, homeConverter, sumHome, type HomeAmount, type HomeTotal } from "../fx/home-currency.js";
import {
  accountFilterProperties, accountFilterShape, resolveAccountFilter, symbolMatches, symbolProperty, symbolShape,
  type AccountType, type ResolvedAccountFilter,
} from "./query-filters.js";
import { homeDayChange } from "../fx/day-change.js";
import { torontoDay } from "../news/refresh-service.js";

export const HOLDINGS_WIDGET = "holdings";
export const HOLDINGS_WIDGET_URI = "ui://portfolio/holdings-v1";
const DEFAULT_MARKET_DEADLINE_MS = 5_000;
const FX_WINDOW_DAYS = 7;
const MODEL_ROWS = 20;
/** The whole payload must stay under 60 KB; the rows get most of it. */
const ROWS_BUDGET_BYTES = 52_000;
export const HOLDINGS_SORTS = ["weight", "value", "return", "returnPct", "today", "symbol"] as const;
export type HoldingsSort = (typeof HOLDINGS_SORTS)[number];

export const holdingsInput = z.object({
  ...accountFilterShape,
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, "Use a three-letter currency code").transform((s) => s.toUpperCase()).optional(),
  sort: z.enum(HOLDINGS_SORTS).optional(),
  symbol: symbolShape,
}).strict();
export type HoldingsInput = z.infer<typeof holdingsInput>;

export interface HoldingsDeps {
  market: Pick<MarketDataService, "quotes" | "usdCad"> & {
    /**
     * Cache-only quotes (no provider call); null marks a known failure. When present, only absent tickers are
     * fetched, so a call whose tickers are all cached or known-failed is not a refresh.
     */
    cachedQuotes?: (tickers: string[]) => Promise<Map<string, Quote | null>>;
  };
  settings: Pick<SettingsService, "get">;
  now?: () => Date;
  /** Budget for each market-data call. Default 5000 ms. */
  marketDeadlineMs?: number;
}

/**
 * A USD row's figures in CAD (est.): value and the brokerage's native gain at today's rate; the day change is
 * today's USD at today's rate minus the previous close at the previous trading day's rate (as News and Overview).
 * Only for converted USD rows.
 */
export interface RowCad { value: HomeAmount; totalReturn: HomeAmount | null; dayChange: HomeAmount | null }
export type CadHoldingRow = HoldingRow & { cad?: RowCad };

/** The portfolio's (or selected account's) CAD figures; the same total Overview and Allocation show. */
export interface HoldingsHome {
  total: HomeTotal;
  includesUnreported: boolean;
  /** "Rows converted at the BoC rate; the brokerage total uses its own rate." */
  rowsDiffer: boolean;
  /** CAD tiles over every holding in scope, ignoring the currency filter. Gains are the brokerage's native figures at today's rate. */
  tiles: { value: HomeTotal; bookCost: HomeTotal | null; totalReturn: HomeTotal | null; totalReturnFraction: number | null; complete: boolean };
}

export interface HoldingsPayload {
  rows: CadHoldingRow[];
  totals: HoldingsTotals[];
  accounts: Array<{ id: string; label: string }>;
  currencies: string[];
  /** Smallest rows left out to keep the payload under 60 KB; totals still cover them. */
  omitted: number;
  /**
   * `accountId` is also set when `accountType` matched exactly one account. `symbol` narrows `rows` and `totals`;
   * weights stay against the whole scope, and `accountValue` and `home` still describe the accounts in scope.
   */
  filters: { accountId?: string; accountType?: AccountType; currency?: string; symbol?: string; sort: string };
  /** Latest Bank of Canada USD/CAD used for `weightCad`; both null when unavailable. */
  fx: { rate: number | null; date: string | null };
  /**
   * Total value of the selected account, or of all included accounts, ignoring the currency filter. "reported" is
   * the sum of brokerage-reported account totals; "estimated" is computed (holdings plus cash, USD converted at `fx`).
   */
  accountValue: AccountValue[];
  /** CAD figures on the shared converter. */
  home: HoldingsHome;
  settings: PortfolioSettingsView;
  /** When this view was built (VestLens read SnapTrade). */
  asOf: string;
  /**
   * How old the prices and values are: the oldest brokerage sync among the accounts shown (SnapTrade syncs
   * Wealthsimple about once a day). The brokerage's own app prices live, so its total can differ. Null when unknown.
   */
  pricesAsOf: string | null;
}

export interface AccountValue { currency: string; amount: number; source: "reported" | "estimated" }

/** The oldest brokerage sync among these accounts (ISO strings sort by time), or null when none is known. */
export function oldestSync(accounts: ReadonlyArray<{ freshness?: { holdingsLastSyncedAt: string | null } | null }>): string | null {
  return accounts.map((a) => a.freshness?.holdingsLastSyncedAt).filter((v): v is string => !!v).sort()[0] ?? null;
}

export type HoldingsScopeCode = Extract<ResolvedAccountFilter, { ok: false }>["code"];

/** An account filter that cannot be served; `text` is the resolver's copy for the person. */
export class HoldingsScopeError extends Error {
  constructor(readonly code: HoldingsScopeCode, readonly text: string) { super(code); this.name = "HoldingsScopeError"; }
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

export interface HoldingsBuildOptions {
  /** Serve cached quotes only (the refresh rate limit is spent): uncached day changes are null. */
  noRefresh?: boolean;
}

export async function buildHoldingsPayload(
  deps: HoldingsDeps, portfolio: PortfolioPresentation, authSubject: string, input: HoldingsInput, options: HoldingsBuildOptions = {},
): Promise<HoldingsPayload> {
  return (await buildHoldingsResult(deps, portfolio, authSubject, input, options)).payload;
}

/**
 * `refreshed`: quotes were requested from the market service this call (may reach the provider), not served from cache only.
 * `scope`: the resolver's scope words for the text ("in your TFSAs", "in {account name}", "across all accounts").
 */
export async function buildHoldingsResult(
  deps: HoldingsDeps, portfolio: PortfolioPresentation, authSubject: string, input: HoldingsInput, options: HoldingsBuildOptions = {},
): Promise<{ payload: HoldingsPayload; refreshed: boolean; scope: string }> {
  const listed = listAccounts(portfolio).filter((a) => a.kind !== "credit");
  const listedIds = new Set(listed.map((a) => a.id));
  // Only listed accounts (open, non-credit, in the total) can be named, by id or by type.
  const resolved = resolveAccountFilter(
    { accounts: portfolio.accounts.filter((a) => listedIds.has(a.id)) },
    { accountId: input.accountId, accountType: input.accountType },
  );
  if (!resolved.ok) throw new HoldingsScopeError(resolved.code, resolved.text);
  const ids = resolved.ids;
  const labels = new Map(listed.map((a) => [a.id, a.label]));
  const sort: HoldingsSort = input.sort ?? "weight";
  const currency = input.currency?.trim().toUpperCase() || undefined;
  const symbol = input.symbol?.trim().toUpperCase() || undefined;
  const inScope = ids === null ? portfolio.accounts : portfolio.accounts.filter((a) => ids.has(a.id));
  const labelOf = (a: { id: string; classification: { label: string } }) => labels.get(a.id) ?? a.classification.label;

  // The CAD-equivalent weight needs every currency, so the currency and symbol filters are applied afterwards.
  const all = aggregateHoldings(inScope, {}, labelOf);
  const currencies = [...new Set([...all.rows.map((r) => r.currency), ...all.totals.map((t) => t.currency)])].sort();

  const deadline = deps.marketDeadlineMs ?? DEFAULT_MARKET_DEADLINE_MS;
  const today = (deps.now ?? (() => new Date()))();
  const tickerOf = (r: HoldingRow) => providerTicker({ symbol: r.symbol, kind: r.kind, currency: r.currency });
  const tickers = [...new Set(all.rows.map(tickerOf).filter((t): t is string => t !== null))];
  // "Today" is the Toronto date, as in Overview, Activity, Income and News.
  const todayDay = torontoDay(today);
  const fxFrom = isoDay(new Date(today.getTime() - FX_WINDOW_DAYS * 86_400_000));
  let refreshed = false;
  const loadQuotes = async (): Promise<Map<string, Quote>> => {
    const known = deps.market.cachedQuotes
      ? await deps.market.cachedQuotes(tickers).catch(() => new Map<string, Quote | null>())
      : new Map<string, Quote | null>();
    const cached = new Map([...known].filter((e): e is [string, Quote] => e[1] !== null));
    const missing = tickers.filter((t) => !known.has(t));
    if (missing.length === 0 || options.noRefresh) return cached;
    refreshed = true;
    return new Map([...cached, ...await deps.market.quotes(missing)]);
  };
  const [quotes, fxPoints, settings] = await Promise.all([
    tickers.length === 0 ? Promise.resolve(new Map<string, Quote>()) : withDeadline(loadQuotes, deadline, () => new Map<string, Quote>()),
    all.rows.length === 0 && !holdsCurrency(portfolio, "USD") ? Promise.resolve(null) : withDeadline(() => deps.market.usdCad(fxFrom, todayDay), deadline, () => null),
    loadSettings(deps as Parameters<typeof loadSettings>[0], authSubject),
  ]);

  const conv = homeConverter(fxPoints, todayDay);
  const rate = conv.latest?.rate ?? null;
  const fx = { rate, date: conv.latest?.date ?? null };

  const accountValue = computeAccountValue(portfolio, ids, rate, labelOf);
  const cadOf = (r: HoldingRow): number | null => {
    if (r.marketValue === null || rate === null) return null;
    return r.currency === "CAD" ? r.marketValue : r.currency === "USD" ? r.marketValue * rate : null;
  };
  const cadTotal = all.rows.reduce((s, r) => s + (cadOf(r) ?? 0), 0);
  // The quote `applyDayChange` used: a row has a day-change amount only when that quote was accepted.
  const rowHomeDayChange = (r: HoldingRow): HomeAmount | null => {
    const ticker = tickerOf(r);
    const q = ticker === null ? undefined : quotes.get(ticker);
    if (!q || r.dayChange?.amount == null || !finite(q.previousClose)) return null;
    const asOf = new Date(q.asOf);
    const day = Number.isNaN(asOf.getTime()) ? undefined : torontoDay(asOf);
    return homeDayChange(conv, { currency: "USD", units: r.units, price: q.price, previousClose: q.previousClose, day, fallbackDay: todayDay });
  };
  const withDay: CadHoldingRow[] = applyDayChange(all.rows, quotes, tickerOf).map((r) => {
    const cad = cadOf(r);
    const out: CadHoldingRow = { ...r, weightCad: cad !== null && cadTotal > 0 ? cad / cadTotal : null };
    const value = r.currency === "USD" && r.marketValue !== null ? conv.at(r.marketValue, "USD") : null;
    if (value && value.amount !== null) {
      const at = (v: number | null | undefined) => (v === null || v === undefined ? null : conv.at(v, "USD"));
      out.cad = { value, totalReturn: at(r.totalReturn), dayChange: rowHomeDayChange(r) };
    }
    return out;
  });
  const scopeValue = homeScopeValue(portfolio, conv, ids);
  const tiles = homeTiles(all.totals, conv);

  const shown = withDay.filter((r) => (!currency || r.currency === currency) && (!symbol || symbolMatches(r.symbol, symbol)));
  const { rows, omitted } = fitBudget(sortRows(shown, sort, rate).map(roundRow), rate);
  // With a symbol, the totals are that symbol's holdings only (no cash), aggregated the same way as the rows.
  const scopeTotals = symbol === undefined ? all.totals : aggregateHoldings(
    inScope.map((a) => ({ ...a, balances: [], positions: (a.positions ?? []).filter((p) => symbolMatches(p.symbol, symbol)) })), {}, labelOf,
  ).totals;
  const totals = scopeTotals.filter((t) => !currency || t.currency === currency);
  const payload: HoldingsPayload = {
    rows, totals, accounts: listed.map((a) => ({ id: a.id, label: a.label })), currencies,
    filters: {
      ...(resolved.singleId !== undefined ? { accountId: resolved.singleId } : {}),
      ...(resolved.accountType !== undefined ? { accountType: resolved.accountType } : {}),
      ...(currency ? { currency } : {}), ...(symbol ? { symbol } : {}), sort,
    },
    omitted, fx, accountValue, home: { ...scopeValue, tiles }, settings, asOf: portfolio.generatedAt,
    pricesAsOf: oldestSync(portfolio.accounts.filter((a) => isInvestable(a) && (ids === null || ids.has(a.id)))),
  };
  return { payload, refreshed, scope: resolved.scope };
}

/**
 * Brokerage-reported account totals win. If every in-scope account reports one, they are summed per currency.
 * Otherwise the result is an estimate: reported totals plus holdings and cash for the accounts that report none,
 * with USD converted to CAD at the Bank of Canada rate; without a rate each currency stays separate.
 */
function computeAccountValue(
  portfolio: PortfolioPresentation, ids: ReadonlySet<string> | null, rate: number | null,
  labelOf: (a: PortfolioPresentation["accounts"][number]) => string,
): AccountValue[] {
  const inScope = portfolio.accounts.filter((a) => isInvestable(a) && (ids === null || ids.has(a.id)));
  if (inScope.length === 0) return [];
  const sums = new Map<string, number>();
  const add = (currency: string, amount: number) => sums.set(currency, (sums.get(currency) ?? 0) + amount);
  let estimated = false;
  for (const a of inScope) {
    if (a.value && finite(a.value.amount)) { add(a.value.currency.trim().toUpperCase(), a.value.amount); continue; }
    estimated = true;
    for (const t of aggregateHoldings([a], {}, labelOf).totals) add(t.currency, t.marketValue + t.cash);
  }
  const source = estimated ? "estimated" : "reported";
  if (estimated && rate !== null && sums.has("USD")) {
    add("CAD", sums.get("USD")! * rate);
    sums.delete("USD");
  }
  return [...sums.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([currency, amount]) => ({ currency, amount: round(amount, 2)!, source }));
}

/** Value, book cost and gain over the in-scope per-currency totals, each currency converted at the latest rate. */
function homeTiles(totals: HoldingsTotals[], conv: ReturnType<typeof homeConverter>): HoldingsHome["tiles"] {
  const sum = (pick: (t: HoldingsTotals) => number) => sumHome(totals.map((t) => conv.at(pick(t), t.currency)));
  const known = (pick: (t: HoldingsTotals) => number | null) => (totals.length > 0 && totals.every((t) => pick(t) !== null) ? sum((t) => pick(t)!) : null);
  const bookCost = known((t) => t.bookCost);
  const totalReturn = known((t) => t.totalReturn);
  const complete = totals.every((t) => t.withCostBasis === t.holdings);
  const fraction = totalReturn && bookCost && bookCost.amount > 0 && complete && bookCost.excludedCount === 0 && totalReturn.excludedCount === 0
    ? round(totalReturn.amount / bookCost.amount, 6) : null;
  return { value: sum((t) => t.marketValue), bookCost, totalReturn, totalReturnFraction: fraction, complete };
}

const round = (v: number | null, places: number) => (v === null ? null : Math.round(v * 10 ** places) / 10 ** places);
/** Money to four decimals, units and ratios to six: enough to reconcile, small enough for the payload budget. */
function roundRow(r: CadHoldingRow): CadHoldingRow {
  return {
    ...r,
    units: round(r.units, 6)!, price: round(r.price, 4), marketValue: round(r.marketValue, 4), bookCost: round(r.bookCost, 4), totalReturn: round(r.totalReturn, 4),
    totalReturnFraction: round(r.totalReturnFraction, 6), weight: round(r.weight, 6), weightCad: round(r.weightCad, 6),
    dayChange: r.dayChange && { ...r.dayChange, amount: round(r.dayChange.amount, 4), fraction: round(r.dayChange.fraction, 6) },
    accounts: r.accounts.map((a) => ({ ...a, units: round(a.units, 6)!, marketValue: round(a.marketValue, 4), bookCost: round(a.bookCost, 4), totalReturn: round(a.totalReturn, 4) })),
  };
}

/**
 * Keeps the row list under the payload budget. Past it, the per-account breakdown is omitted (an empty
 * `accounts` array, never the case for a held row) from the smallest rows first; if the rows still do not
 * fit, the smallest rows are left out and counted in `omitted`. Totals always cover every holding, and
 * the widget narrows by account or currency to see the rest.
 */
function fitBudget(rows: CadHoldingRow[], rate: number | null): { rows: CadHoldingRow[]; omitted: number } {
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  let size = bytes(rows);
  if (size <= ROWS_BUDGET_BYTES) return { rows, omitted: 0 };
  const out = [...rows];
  // Smallest known value first (in CAD when a rate exists); unknown-value rows are the "—" rows and go last.
  const worth = (r: HoldingRow) => (r.marketValue === null ? null : r.currency === "USD" && rate !== null ? r.marketValue * rate : r.marketValue);
  const bySmallest = out.map((_, i) => i).sort((a, b) => {
    const wa = worth(out[a]); const wb = worth(out[b]);
    if (wa === wb) return 0;
    if (wa === null) return 1;
    if (wb === null) return -1;
    return wa - wb;
  });
  for (const i of bySmallest) {
    if (size <= ROWS_BUDGET_BYTES) break;
    size -= bytes(out[i].accounts) - 2;
    out[i] = { ...out[i], accounts: [] };
  }
  const drop = new Set<number>();
  for (const i of bySmallest) {
    if (size <= ROWS_BUDGET_BYTES) break;
    size -= bytes(out[i]) + 1;
    drop.add(i);
  }
  return { rows: out.filter((_, i) => !drop.has(i)), omitted: drop.size };
}

/** Values are compared in CAD when a rate is known, so USD and CAD rows order together; unknown values sort last. */
function sortRows(rows: HoldingRow[], sort: HoldingsSort, rate: number | null): HoldingRow[] {
  const cad = (r: HoldingRow, v: number | null) => (v === null ? null : r.currency === "USD" && rate !== null ? v * rate : v);
  const key = (r: HoldingRow): number | null => {
    switch (sort) {
      case "weight": return r.weightCad ?? r.weight;
      case "value": return cad(r, r.marketValue);
      case "return": return cad(r, r.totalReturn);
      case "returnPct": return r.totalReturnFraction;
      case "today": return r.dayChange?.amount == null ? null : cad(r, r.dayChange.amount);
      case "symbol": return null;
    }
  };
  return [...rows].sort((a, b) => {
    if (sort !== "symbol") {
      const ka = key(a); const kb = key(b);
      if (ka !== kb) { if (ka === null) return 1; if (kb === null) return -1; return kb - ka; }
    }
    return a.symbol.localeCompare(b.symbol) || a.currency.localeCompare(b.currency);
  });
}

const percent = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

/**
 * What the holdings in scope are worth, or null when no holding has a reported value. Native totals per currency, as
 * reported. With the CAD view on and more than CAD held, the payload's CAD figure (`home.tiles.value`, est. with its
 * BoC date) leads, followed by the native totals; it is skipped under a symbol or currency filter (it covers the
 * whole scope) or when any part is unconverted. Totals sum known values only, so unknown rows are counted alongside.
 */
function holdingsWorth(p: HoldingsPayload): string | null {
  const unknown = p.rows.filter((r) => r.marketValue === null).length;
  // Omitted rows always have a known value: fitBudget drops unknown-value rows last.
  if (unknown === p.rows.length && p.omitted === 0) return null;
  const held = p.totals.filter((t) => t.holdings > 0);
  const native = held.map((t) => formatMoney(t.marketValue, t.currency)).join(" + ");
  const cad = p.home.tiles.value;
  const showCad = p.settings.cadView && !p.filters.symbol && !p.filters.currency && cad.excludedCount === 0
    && held.some((t) => t.currency !== HOME_CURRENCY);
  const value = showCad ? `${formatMoney(cad.amount, HOME_CURRENCY)}${homeQualifier(cad, p.asOf.slice(0, 4))} (${native})` : native;
  return unknown > 0 ? `${value} (${unknown} with no reported value)` : value;
}

/**
 * The largest row's share of the scope (or, with a symbol, that symbol's share). One holdings currency in scope: its
 * weight. Several, with the CAD view on: its share of the CAD total (est., BoC date). Otherwise the largest per currency.
 */
function shareText(p: HoldingsPayload, scope: string): string {
  const bySymbol = Boolean(p.filters.symbol);
  const known = p.rows.filter((r) => r.weight !== null);
  if (known.length === 0) return "";
  // Only currencies with a known holding value count (cash-only currencies don't). Under a symbol or currency filter
  // the rows are a subset of the scope, so only a scope with one currency in all counts as single-currency.
  const single = bySymbol || p.filters.currency
    ? p.currencies.length === 1
    : new Set([...known.map((r) => r.currency), ...p.totals.filter((t) => t.marketValue !== 0).map((t) => t.currency)]).size === 1;
  const top = (rows: CadHoldingRow[], key: (r: CadHoldingRow) => number) => rows.reduce((best, r) => (key(r) > key(best) ? r : best));
  if (single) {
    const r = top(known, (x) => x.weight!);
    return bySymbol ? ` ${r.symbol} is ${percent(r.weight!)} of the holdings ${scope}, cash excluded.` : ` Largest: ${r.symbol} at ${percent(r.weight!)} of holdings, cash excluded.`;
  }
  if (p.settings.cadView && p.fx.date !== null && known.every((r) => r.weightCad !== null)) {
    const r = top(known, (x) => x.weightCad!);
    const note = `(est., BoC ${shortDate(p.fx.date, p.asOf.slice(0, 4))})`;
    return bySymbol
      ? ` ${r.symbol} is ${percent(r.weightCad!)} of holdings ${scope}, cash excluded ${note}.`
      : ` Largest: ${r.symbol} at ${percent(r.weightCad!)} of holdings, cash excluded ${note}.`;
  }
  const parts = [...new Set(known.map((r) => r.currency))].sort().map((c) => {
    const r = top(known.filter((x) => x.currency === c), (x) => x.weight!);
    return `${r.symbol} ${bySymbol ? "is" : "at"} ${percent(r.weight!)} of ${c} holdings, cash excluded`;
  });
  return bySymbol ? ` ${parts.join(", ")} ${scope}.` : ` Largest: ${parts.join(", ")}.`;
}

/**
 * The cash in scope per currency, native and as reported ("2,000.00 CAD and -500.00 USD"; three read "A, B and C"),
 * or null when there is none. The totals carry each currency's cash balance (already narrowed by a currency filter,
 * and empty under a symbol filter); cash is never converted here, and a debit keeps its sign.
 */
function cashText(p: HoldingsPayload): string | null {
  const held = p.totals.filter((t) => Number.isFinite(t.cash) && Math.round(t.cash * 100) !== 0);
  const amounts = held.map((t) => formatMoney(t.cash, t.currency));
  return amounts.length <= 1 ? amounts[0] ?? null : `${amounts.slice(0, -1).join(", ")} and ${amounts.at(-1)}`;
}

/**
 * Answer first (spec D5): the count, scope and value, then the cash held in scope, then the largest holding's share;
 * no account ids. `scope` is the resolver's scope words from `buildHoldingsResult`; a currency filter is named with
 * the count ("1 USD holding"). The value covers positions only, so the cash is listed beside it per currency in the
 * Cash-account form ("; cash 2,000.00 CAD and -500.00 USD"), never added to it.
 */
export function holdingsText(p: HoldingsPayload, scope: string, options: { show?: boolean } = {}): string {
  const n = p.rows.length + p.omitted;
  const where = p.filters.symbol ? `${scope} for ${p.filters.symbol}` : scope;
  const kind = p.filters.currency ? `${p.filters.currency} ` : "";
  const worth = n === 0 ? null : holdingsWorth(p);
  const cash = cashText(p);
  const withCash = cash === null ? "" : `; cash ${cash}`;
  let text = n === 0
    ? cash === null ? `No ${kind}holdings ${where}.` : `No ${kind}holdings ${where}; cash ${cash}.`
    : worth === null
      ? `${n} ${kind}${n === 1 ? "holding" : "holdings"} ${where} (none with a reported value)${withCash}.`
      : `${n} ${kind}${n === 1 ? "holding" : "holdings"} ${where} worth ${worth}${withCash}.${shareText(p, scope)}`;
  if (p.omitted > 0) text += ` The table lists the largest ${p.rows.length}; narrow by account or currency to see the rest.`;
  return options.show ? `${text} Showing the holdings widget.` : text;
}

export const PRICES_AS_OF_NOTE = "pricesAsOf is when SnapTrade last synced the brokerage (about once a day); values and prices are from then. The brokerage's own app prices live, so its total can differ during market hours.";

const r4 = (v: number | null) => (v === null ? null : Math.round(v * 10_000) / 10_000);

/** Compact copy for the model: totals and the top 20 rows by weight (symbol, currency, weight, return %). */
export function holdingsModelCopy(p: HoldingsPayload) {
  const top = [...p.rows].sort((a, b) => (b.weightCad ?? b.weight ?? -1) - (a.weightCad ?? a.weight ?? -1));
  const accountLabel = p.filters.accountId === undefined ? undefined : p.accounts.find((a) => a.id === p.filters.accountId)?.label;
  const cad = p.settings.cadView;
  return {
    filters: {
      ...(p.filters.currency ? { currency: p.filters.currency } : {}), ...(accountLabel ? { accountLabel } : {}),
      ...(p.filters.accountType ? { accountType: p.filters.accountType } : {}), ...(p.filters.symbol ? { symbol: p.filters.symbol } : {}), sort: p.filters.sort,
    },
    totals: p.totals,
    // CAD figures and the CAD note follow the switch: with it off the screen shows native currencies.
    ...(cad ? { home: { total: { amount: p.home.total.amount, estimated: p.home.total.estimated, notConverted: p.home.total.excludedCount } } } : {}),
    accountValue: p.accountValue,
    pricesAsOf: p.pricesAsOf,
    holdings: p.rows.length + p.omitted,
    top: top.slice(0, MODEL_ROWS).map((r) => ({ symbol: r.symbol, currency: r.currency, weight: r4(r.weight), returnPct: r4(r.totalReturnFraction) })),
    hasMore: p.rows.length + p.omitted > MODEL_ROWS,
    notes: { pricesAsOf: PRICES_AS_OF_NOTE, returns: "totalReturn and returnPct are market value against book cost, the 'Gain vs book cost' on screen. Dividends aren't included, and reinvested dividends add to book cost.", ...(cad ? { currency: CAD_NOTE, dayChange: "A converted holding's CAD day change includes the day's currency move; its percent is the price move." } : {}), weight: "weight is the share of the known market value of holdings in the same currency, cash excluded; weightCad is the share of all holdings in CAD, cash excluded, with USD converted at the Bank of Canada rate (est.).", returnPct: "returnPct is null when the brokerage reports no cost basis." },
  };
}

const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const security = [{ type: "oauth2" as const, scopes: ["portfolio:read"] }];

const inputSchema = {
  type: "object",
  properties: {
    ...accountFilterProperties,
    currency: { type: "string", pattern: "^[A-Za-z]{3}$" },
    sort: { type: "string", enum: [...HOLDINGS_SORTS] },
    symbol: symbolProperty,
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  properties: {
    rows: { type: "array" }, totals: { type: "array" }, accounts: { type: "array" }, currencies: { type: "array" }, omitted: { type: "integer" },
    filters: { type: "object" }, fx: { type: "object" }, accountValue: { type: "array" }, home: { type: "object" }, settings: { type: "object" }, asOf: { type: "string" }, pricesAsOf: { type: ["string", "null"] },
  },
  required: ["rows", "totals", "accounts", "currencies", "omitted", "filters", "fx", "accountValue", "home", "settings", "asOf", "pricesAsOf"],
  additionalProperties: false,
} as const;

export const holdingsToolDefinitions = [
  {
    name: "show_holdings",
    title: "Show holdings",
    description:
      "Use this when the user asks what they own, or wants the full list of holdings or positions across their accounts: renders the interactive holdings table. Filter with accountType (for example tfsa) or accountId, and symbol. Read-only.",
    inputSchema,
    outputSchema,
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    _meta: {
      securitySchemes: security, ui: { resourceUri: HOLDINGS_WIDGET_URI }, "openai/outputTemplate": HOLDINGS_WIDGET_URI,
      "openai/widgetAccessible": true, "openai/toolInvocation/invoking": "Loading holdings…", "openai/toolInvocation/invoked": "Holdings ready.",
    },
  },
  {
    name: "get_holdings",
    title: "Get holdings",
    description: "Used by the holdings widget to filter and sort holdings by account and currency. Covers the user's investment accounts. Read-only.",
    inputSchema,
    outputSchema,
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    _meta: { securitySchemes: security, ui: { visibility: ["app"] } },
  },
] as const;
