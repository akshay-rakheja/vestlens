import { z } from "zod";
import { signedUnits, symbolPosition } from "../activity/symbol-position.js";
import { aggregateHoldings, isInvestable, type HoldingRow } from "../analytics/holdings.js";
import {
  contributionsByAccountType, forwardDetail, monthlyIncome, netDividends, overallYields, REINVESTS, trailingEvents, UNITS_TOLERANCE, unmatchedWithholding, unmatchedWithholdingRows, withholdingByAccountType, yields,
  type DividendEvent, type ForwardUncoveredReason,
} from "../analytics/income.js";
import { minusMonths } from "../analytics/value-series.js";
import { providerTicker } from "../market-data/ticker-map.js";
import type { SecurityDistributions } from "../market-data/types.js";
import { HOME_CURRENCY, sumHome, type HomeAmount, type HomeConverter, type HomeTotal } from "../fx/home-currency.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import { cashDelta } from "../history/sign-rules.js";
import type { ActivityStore } from "../history/activity-store.js";
import type { StoredActivity } from "../history/stored-activity.js";
import type { PortfolioPresentation, PortfolioPresentationAccount } from "../portfolio/portfolio-presentation.js";
import type { PortfolioSettingsView, SettingsService } from "../settings/settings-service.js";
import { listAccounts } from "./activity-tools.js";
import { CAD_NOTE, formatMoney, homeConverterFor, shortDate } from "./home-fx.js";
import { loadSettings, withDeadline } from "./overview-tools.js";
import {
  accountFilterProperties, accountFilterShape, resolveAccountFilter, symbolMatches, symbolProperty, symbolShape,
  type AccountType, type ResolvedAccountFilter,
} from "./query-filters.js";

export const INCOME_WIDGET = "income";
export const INCOME_WIDGET_URI = "ui://portfolio/income-v1";
const ALL_TIME_FROM = "2000-01-01";
const MODEL_PAYERS = 20;
const PAYLOAD_PAYERS = 50;
const PAYLOAD_YIELDS = 50;
const FORWARD_UNCOVERED_LISTED = 20;
const INCOME_NOTE = "Estimates for information only, not tax or investment advice.";

export const incomeInput = z.object({
  year: z.number().int().min(2000).max(2100).optional(),
  ...accountFilterShape,
  symbol: symbolShape,
}).strict();
export type IncomeInput = z.infer<typeof incomeInput>;

export interface IncomeDeps {
  activities: Pick<ActivityStore, "userId" | "syncState" | "queryActivities">;
  settings: Pick<SettingsService, "get">;
  /** Bank of Canada USD/CAD rates for the CAD view (without them USD amounts stay not converted), and per-share distributions for the forward estimate (without them it uses the account's payments). */
  market?: Partial<Pick<MarketDataService, "usdCad" | "distributions">>;
  marketDeadlineMs?: number;
  now?: () => Date;
}

/**
 * The CAD view of the year (spec 6.1): USD dividends and interest convert at the BoC rate on their pay date (est.),
 * the forward estimate at the latest rate. Withholding by account type and deposits stay per currency in the payload.
 */
export interface IncomeHome {
  tiles: { net: HomeTotal; gross: HomeTotal; withholding: HomeTotal; interest: HomeTotal; forward12m: HomeTotal };
  /** One entry per month with income, every amount in CAD (payments that could not be converted are left out). */
  months: ReturnType<typeof monthlyIncome>;
  /** By symbol across currencies, CAD net; `yieldOnCost` only for a symbol that pays in one currency (native percent). */
  topPayers: Array<{ symbol: string; net: number; estimated: boolean; yieldOnCost: number | null }>;
  /** Forward estimate coverage summed over currencies. */
  forwardCoverage: { payers: number; covered: number };
  /** Yields are native percents, so they show only when income is in a single currency. */
  yields: { yieldOnCost: number | null; currentYield: number | null } | null;
}

export interface IncomePayload {
  year: number;
  /** Distinct years that have a dividend or interest row, ascending. */
  years: number[];
  currencyTotals: Array<{
    currency: string; net: number; gross: number; withholding: number; interest: number; forward12m: number;
    /** Withholding rows in the year that match no dividend: not netted (as in Activity), reported here. `amount` is the positive magnitude. */
    unmatchedWithholding: { count: number; amount: number };
    /** Forward estimate coverage: holdings, one per account, with trailing payments or market distributions and current units, and those it could be estimated for ("est. from N of M holdings"). */
    forwardCoverage: { payers: number; covered: number };
    /** The holdings forwardCoverage leaves out and why (the first FORWARD_UNCOVERED_LISTED). Only when there are some. */
    forwardUncovered?: Array<{ symbol: string; account: string; reason: ForwardUncoveredReason }>;
    /** The forward estimate where there is one for the whole holding, else trailing 12 months of net dividends, after withholding, over book cost / market value (estimates; null without values). */
    yieldOnCost: number | null; currentYield: number | null;
    /** Holdings left out of the yields because a yield can't be told: no forward figure for every account holding it, or dividends in another currency with no rate. Only when there are some. */
    yieldsLeftOut?: number;
    /** Holdings whose yield uses dividends paid in another currency, converted at the Bank of Canada rate on each pay date (est.). Only when there are some. */
    yieldsConverted?: number;
  }>;
  months: ReturnType<typeof monthlyIncome>;
  topPayers: Array<{ symbol: string; currency: string; net: number; yieldOnCost: number | null }>;
  yields: ReturnType<typeof yields>;
  withholding: ReturnType<typeof withholdingByAccountType>;
  /**
   * Deposits (contributions and incoming transfers) in the year, per account type and currency. A transfer nets out
   * only when both matched legs are in the same account type (two TFSAs), so Cash -> TFSA counts as a TFSA deposit in
   * every view; legs are paired against the other listed accounts too, so money routed through Cash still counts.
   * Empty while a symbol is set.
   */
  contributions: ReturnType<typeof contributionsByAccountType>;
  accounts: Array<{ id: string; label: string }>;
  /** Accounts whose history is still backfilling: the scope's, and for a multi-account scope the other listed accounts read to pair transfer legs. */
  syncing: string[];
  /**
   * `accountId` is also set when `accountType` matched exactly one account. `symbol` keeps only that symbol's dividends
   * and distributions (months, totals, payers, withholding, yields, forward); interest and contributions are left out.
   */
  filters: { accountId?: string; accountType?: AccountType; symbol?: string };
  settings: PortfolioSettingsView;
  asOf: string;
  /** Present only while the CAD view is on. */
  home?: IncomeHome;
}

export type IncomeScopeCode = Extract<ResolvedAccountFilter, { ok: false }>["code"];

/** An account filter that cannot be served; `text` is the resolver's copy for the person. */
export class IncomeScopeError extends Error {
  constructor(readonly code: IncomeScopeCode, readonly text: string) { super(code); this.name = "IncomeScopeError"; }
}

const torontoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });
const minusDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
const rowDate = (a: StoredActivity) => a.tradeDate ?? a.settlementDate ?? "";
const symOf = (a: StoredActivity) => (a.symbol ?? "").trim().toUpperCase();
const cents = (n: number) => Math.round(n * 100) / 100;

/** An amount in another currency through CAD at the rate on `date`; null when there is no rate, never a guess. */
function convertBetween(conv: HomeConverter, amount: number, from: string, to: string, date: string): number | null {
  const cad = conv.at(amount, from, date).amount;
  if (cad === null) return null;
  if (to === HOME_CURRENCY) return cad;
  const rate = conv.at(1, to, date).rate;
  return rate === null ? null : cad / rate;
}

/** Units held now, keyed `SYMBOL|accountId`. */
function unitsByAccount(rows: HoldingRow[]): Map<string, number> {
  const units = new Map<string, number>();
  for (const h of rows) for (const a of h.accounts) {
    const key = `${h.symbol.toUpperCase()}|${a.accountId}`;
    units.set(key, (units.get(key) ?? 0) + a.units);
  }
  return units;
}

const DISTRIBUTION_WORKERS = 4;
const DEFAULT_MARKET_DEADLINE_MS = 5_000;

/**
 * Trailing-year distributions per ticker, at most DISTRIBUTION_WORKERS at a time, under one deadline. Never throws: a
 * failed ticker is absent, and the deadline returns what has arrived (the rest still fill the cache for the next read).
 */
async function loadDistributions(
  market: IncomeDeps["market"], tickers: string[], today: string, deadlineMs = DEFAULT_MARKET_DEADLINE_MS,
): Promise<Map<string, SecurityDistributions>> {
  const out = new Map<string, SecurityDistributions>();
  const read = market?.distributions?.bind(market);
  if (!read || tickers.length === 0) return out;
  const from = minusMonths(today, 12);
  let next = 0;
  const worker = async () => {
    while (next < tickers.length) {
      const ticker = tickers[next++]!;
      const found = await read(ticker, from, today).catch(() => null);
      if (found) out.set(ticker, found);
    }
  };
  return withDeadline(async () => { await Promise.all(Array.from({ length: Math.min(DISTRIBUTION_WORKERS, tickers.length) }, worker)); return out; }, deadlineMs, () => out);
}

/** symbol -> its market distributions, for the holdings that have a provider ticker. */
async function distributionsBySymbol(market: IncomeDeps["market"], rows: HoldingRow[], today: string, deadlineMs?: number): Promise<(symbol: string) => SecurityDistributions | null> {
  const tickerOf = new Map(rows.flatMap((r) => { const t = providerTicker({ symbol: r.symbol, kind: r.kind, currency: r.currency }); return t ? [[r.symbol, t] as const] : []; }));
  const found = await loadDistributions(market, [...new Set(tickerOf.values())], today, deadlineMs);
  return (symbol) => found.get(tickerOf.get(symbol) ?? "") ?? null;
}

export async function buildIncomePayload(
  deps: IncomeDeps, portfolio: PortfolioPresentation, authSubject: string, input: IncomeInput,
): Promise<IncomePayload> {
  return (await buildIncomeResult(deps, portfolio, authSubject, input)).payload;
}

/** `scope`: the resolver's scope words for the text ("in your TFSAs", "in {account name}", "across all accounts"). */
export async function buildIncomeResult(
  deps: IncomeDeps, portfolio: PortfolioPresentation, authSubject: string, input: IncomeInput,
): Promise<{ payload: IncomePayload; scope: string }> {
  const today = torontoDate.format((deps.now ?? (() => new Date()))());
  const year = input.year ?? Number(today.slice(0, 4));
  // Investment and Cash / money-market accounts (their interest counts); credit products are excluded, closed ones are never listed.
  const listed = listAccounts(portfolio).filter((a) => a.kind !== "credit");
  const listedIds = new Set(listed.map((a) => a.id));
  // Only listed accounts can be named, by id or by type.
  const resolved = resolveAccountFilter(
    { accounts: portfolio.accounts.filter((a) => listedIds.has(a.id)) },
    { accountId: input.accountId, accountType: input.accountType },
  );
  if (!resolved.ok) throw new IncomeScopeError(resolved.code, resolved.text);
  const ids = resolved.ids;
  const symbol = input.symbol?.trim().toUpperCase() || undefined;
  const inScope = listed.filter((a) => ids === null || ids.has(a.id));
  const labels = new Map(listed.map((a) => [a.id, a.label]));
  const typeLabel = new Map(portfolio.accounts.map((a) => [a.id, a.classification.label]));
  const accountType = (id: string) => typeLabel.get(id) ?? labels.get(id) ?? "Account";

  const settings = await loadSettings(deps as Parameters<typeof loadSettings>[0], authSubject);
  const base = {
    accounts: listed.map((a) => ({ id: a.id, label: a.label })),
    filters: {
      ...(resolved.singleId !== undefined ? { accountId: resolved.singleId } : {}),
      ...(resolved.accountType !== undefined ? { accountType: resolved.accountType } : {}),
      ...(symbol !== undefined ? { symbol } : {}),
    },
    settings, asOf: portfolio.generatedAt, year,
  };
  const empty = (syncing: string[]): IncomePayload => ({
    ...base, years: [], currencyTotals: [], months: [], topPayers: [], yields: [], withholding: [], contributions: [], syncing,
  });
  const userId = await deps.activities.userId(authSubject);
  if (!userId) return { payload: empty(inScope.map((a) => a.id)), scope: resolved.scope };

  // A scope of several accounts (accountType) also reads the other listed accounts, Cash included, only to pair transfer
  // legs: TFSA1 -> Cash -> TFSA2 is money put into TFSA2, not a transfer between the TFSAs. One account and the whole
  // portfolio need no extra read (the latter already has every leg); nor does a symbol (no contributions).
  const outside = ids !== null && ids.size > 1 && symbol === undefined ? listed.filter((a) => !ids.has(a.id)) : [];
  const [allRows, states, matchOnly, outsideStates] = await Promise.all([
    inScope.length === 0 ? Promise.resolve([] as StoredActivity[])
      : deps.activities.queryActivities(userId, { accountIds: inScope.map((a) => a.id), from: ALL_TIME_FROM, to: today }),
    Promise.all(inScope.map((a) => deps.activities.syncState(userId, a.id).catch(() => null))),
    outside.length === 0 ? Promise.resolve([] as StoredActivity[])
      : deps.activities.queryActivities(userId, { accountIds: outside.map((a) => a.id), from: ALL_TIME_FROM, to: today }),
    Promise.all(outside.map((a) => deps.activities.syncState(userId, a.id).catch(() => null))),
  ]);
  // A match-only account still backfilling may be missing the legs that keep routed money from netting in the
  // contributions, so it counts as syncing too (outside is empty for one account, all accounts and a symbol).
  const backfilling = (list: typeof inScope, st: typeof states) => list.filter((_, i) => !st[i] || st[i]!.backfillCompletedAt === null).map((a) => a.id);
  const syncing = [...backfilling(inScope, states), ...backfilling(outside, outsideStates)];

  // With a symbol, only that symbol's rows (dividends, their withholding and reinvestments, and the trades the unit
  // replay needs); interest and contributions carry no symbol and leave the result.
  const rows = symbol === undefined ? allRows : allRows.filter((r) => symbolMatches(symOf(r), symbol));
  const events = netDividends(rows);
  const interestRows = symbol === undefined ? rows.filter((r) => r.type.toUpperCase() === "INTEREST") : [];
  const years = [...new Set([
    ...events.map((e) => Number(e.date.slice(0, 4))),
    ...interestRows.map((r) => Number(rowDate(r).slice(0, 4))),
  ])].filter((y) => Number.isFinite(y) && y > 0).sort((a, b) => a - b);

  const prefix = `${year}-`;
  const yearEvents = events.filter((e) => e.date.startsWith(prefix));
  const months = monthlyIncome(events, interestRows, year);

  // Current holdings: units per (symbol, account), book cost and market value per symbol and currency.
  const held = aggregateHoldings(ids === null ? portfolio.accounts : portfolio.accounts.filter((a) => ids.has(a.id)), {}, (a) => labels.get(a.id) ?? a.classification.label);
  // Yields are of the symbol's own holdings when a symbol is set, so a currency's overall yield is not diluted.
  const heldRows = symbol === undefined ? held.rows : held.rows.filter((h) => symbolMatches(h.symbol, symbol));
  const currentUnits = unitsByAccount(held.rows);

  // Units on a payment date come from the activity replay of that symbol in that account (strictly before the date).
  // A payer whose units changed around a payment is uncovered: which of those units were paid isn't known.
  const { unitsOnDate, payoutUnits, replayedUnits, openedOn } = unitsReplay(rows);
  const market = await distributionsBySymbol(deps.market, heldRows, today, deps.marketDeadlineMs);
  const forward = forwardDetail(events, payoutUnits, currentUnits, today, replayedUnits, { market, openedOn, holdings: heldRows });

  const trailing = new Map<string, number>();
  // The income of a symbol whose units changed around a payment says nothing about today's holding, and income that can't
  // be put in the holding's currency can't be compared with it: no yield, and no zero in the totals.
  const leftOut = new Set<string>();
  const trailingRows = trailingEvents(events, today);
  const heldKeys = new Set(heldRows.map((h) => h.key));
  const rowsOf = (symbol: string) => heldRows.filter((h) => h.symbol === symbol);
  // A holding in one currency paid in another (a USD stock paying CAD into a CAD account): converted at the pay-date rate.
  const isCross = (e: DividendEvent) => !heldKeys.has(`${e.symbol}|${e.currency}`) && rowsOf(e.symbol!).length > 0;
  const crossDates = trailingRows.filter(isCross).map((e) => e.date).sort();
  const crossConv = crossDates.length > 0 ? await homeConverterFor(deps.market, crossDates[0], today, deps.marketDeadlineMs) : null;
  const crossPayers = new Map<string, string>();
  for (const e of trailingRows) {
    const key = `${e.symbol}|${e.currency}`;
    if (crossConv && isCross(e)) {
      const [only, ...more] = rowsOf(e.symbol!);
      const converted = more.length === 0 ? convertBetween(crossConv, e.net, e.currency, only!.currency, e.date) : null;
      if (converted === null) leftOut.add(e.symbol!);
      else { trailing.set(only!.key, (trailing.get(only!.key) ?? 0) + converted); crossPayers.set(key, only!.key); }
    } else trailing.set(key, (trailing.get(key) ?? 0) + e.net);
    if (payoutUnits(e.symbol!, e.accountId, e.date) === null && (unitsOnDate(e.symbol!, e.accountId, e.date) ?? 0) > 0) leftOut.add(e.symbol!);
  }
  // A forward figure for every account holding it is the run-rate its yields use. A symbol held under a year with no such
  // figure would read low from its payments alone, so it has no yield; units changing around a payment was caught above.
  const forwardBy = new Map(forward.estimates.map((f) => [`${f.symbol}|${f.currency}`, f.amount]));
  const forwardWhole = (h: HoldingRow) => forwardBy.has(h.key) && h.accounts.every((a) => forward.covered.has(`${h.symbol}|${h.currency}|${a.accountId}`));
  for (const u of forward.uncovered) if (u.reason === "partial_year") leftOut.add(u.symbol);
  for (const h of heldRows) if (forwardWhole(h)) trailing.set(h.key, forwardBy.get(h.key)!);
  const leftOutRows = heldRows.filter((h) => leftOut.has(h.symbol) && !forwardWhole(h));
  const yieldRows = heldRows.filter((h) => !leftOut.has(h.symbol) || forwardWhole(h));
  const allYields = [
    ...yields(trailing, yieldRows),
    ...leftOutRows.map((h) => ({ symbol: h.symbol, currency: h.currency, yieldOnCost: null, currentYield: null, estimated: true as const })),
  ];
  const overall = overallYields(trailing, yieldRows);

  const totals = new Map<string, IncomePayload["currencyTotals"][number]>();
  const slot = (currency: string) => {
    let t = totals.get(currency);
    if (!t) {
      const o = overall.get(currency);
      t = { currency, net: 0, gross: 0, withholding: 0, interest: 0, forward12m: 0, unmatchedWithholding: { count: 0, amount: 0 }, forwardCoverage: { payers: 0, covered: 0 }, yieldOnCost: o?.yieldOnCost ?? null, currentYield: o?.currentYield ?? null };
      totals.set(currency, t);
    }
    return t;
  };
  for (const e of yearEvents) { const t = slot(e.currency); t.net += e.net; t.gross += e.gross; t.withholding += e.withholding; }
  for (const m of months) slot(m.currency).interest += m.interest;
  for (const f of forward.estimates) slot(f.currency).forward12m += f.amount;
  for (const u of unmatchedWithholding(rows, year)) slot(u.currency).unmatchedWithholding = { count: u.count, amount: u.amount };
  for (const [currency, c] of forward.coverage) slot(currency).forwardCoverage = c;
  for (const u of forward.uncovered) {
    const t = slot(u.currency);
    if ((t.forwardUncovered?.length ?? 0) < FORWARD_UNCOVERED_LISTED) (t.forwardUncovered ??= []).push({ symbol: u.symbol, account: labels.get(u.accountId) ?? "an account", reason: u.reason });
  }
  for (const h of leftOutRows) { const t = slot(h.currency); t.yieldsLeftOut = (t.yieldsLeftOut ?? 0) + 1; }
  for (const h of yieldRows) if ([...crossPayers.values()].includes(h.key)) { const t = slot(h.currency); t.yieldsConverted = (t.yieldsConverted ?? 0) + 1; }
  const currencyTotals = [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency))
    .map((t) => ({ ...t, net: cents(t.net), gross: cents(t.gross), withholding: cents(t.withholding), interest: cents(t.interest), forward12m: cents(t.forward12m) }));

  const yieldOf = new Map(allYields.map((y) => [`${y.symbol}|${y.currency}`, y.yieldOnCost]));
  for (const [payer, holding] of crossPayers) yieldOf.set(payer, yieldOf.get(holding) ?? null);
  const payers = new Map<string, { symbol: string; currency: string; net: number }>();
  for (const e of yearEvents as DividendEvent[]) {
    if (e.symbol === null) continue;
    const key = `${e.symbol}|${e.currency}`;
    const p = payers.get(key) ?? { symbol: e.symbol, currency: e.currency, net: 0 };
    p.net += e.net;
    payers.set(key, p);
  }
  const topPayers = [...payers.entries()]
    .sort(([, a], [, b]) => b.net - a.net || a.symbol.localeCompare(b.symbol))
    .slice(0, PAYLOAD_PAYERS)
    .map(([key, p]) => ({ symbol: p.symbol, currency: p.currency, net: cents(p.net), yieldOnCost: yieldOf.get(key) ?? null }));

  const yearInterest = interestRows.filter((r) => rowDate(r).startsWith(prefix) && r.currency !== null && r.amount !== null && Number.isFinite(r.amount));
  const home = settings.cadView
    ? await buildHome(deps, { today, year, yearEvents, yearInterest, forward, currencyTotals, yieldOf })
    : undefined;
  const payload: IncomePayload = {
    ...base, years, currencyTotals, months, topPayers,
    yields: allYields.slice(0, PAYLOAD_YIELDS),
    withholding: withholdingByAccountType(yearEvents, accountType, unmatchedWithholdingRows(rows, year)),
    // A transfer nets out only when both of its matched legs are in the same account type (contributionsByAccountType).
    contributions: symbol === undefined ? contributionsByAccountType(rows, year, accountType, matchOnly) : [],
    syncing,
    ...(home ? { home } : {}),
  };
  return { payload, scope: resolved.scope };
}

async function buildHome(
  deps: IncomeDeps,
  input: {
    today: string; year: number; yearEvents: DividendEvent[]; yearInterest: StoredActivity[]; forward: ReturnType<typeof forwardDetail>;
    currencyTotals: IncomePayload["currencyTotals"]; yieldOf: Map<string, number | null>;
  },
): Promise<IncomeHome> {
  const { today, yearEvents, yearInterest, forward, currencyTotals, yieldOf } = input;
  const usd = (c: string | null) => c?.trim().toUpperCase() === "USD";
  const usdDates = [
    ...yearEvents.filter((e) => usd(e.currency)).map((e) => e.date),
    ...yearInterest.filter((r) => usd(r.currency)).map(rowDate),
    ...(forward.estimates.some((f) => usd(f.currency)) ? [today] : []),
  ].filter((d) => d !== "").sort();
  const conv: HomeConverter = await homeConverterFor(deps.market, usdDates[0], today, deps.marketDeadlineMs);

  // Each payment converts at the rate on its own date; one that cannot be converted is listed in the totals and left out of the chart.
  const cadEvents: DividendEvent[] = [];
  const parts = { net: [] as HomeAmount[], gross: [] as HomeAmount[], withholding: [] as HomeAmount[], interest: [] as HomeAmount[] };
  const netByPayer = new Map<string, { net: number; estimated: boolean; currencies: Set<string> }>();
  for (const e of yearEvents) {
    const net = conv.at(e.net, e.currency, e.date);
    const gross = conv.at(e.gross, e.currency, e.date);
    const withheld = conv.at(e.withholding, e.currency, e.date);
    parts.net.push(net); parts.gross.push(gross); parts.withholding.push(withheld);
    if (net.amount === null || gross.amount === null || withheld.amount === null) continue;
    cadEvents.push({ ...e, currency: "CAD", net: net.amount, gross: gross.amount, withholding: withheld.amount });
    if (e.symbol !== null) {
      const p = netByPayer.get(e.symbol) ?? { net: 0, estimated: false, currencies: new Set<string>() };
      p.net += net.amount; p.estimated ||= net.estimated; p.currencies.add(e.currency);
      netByPayer.set(e.symbol, p);
    }
  }
  const cadInterest: StoredActivity[] = [];
  for (const r of yearInterest) {
    const amount = cashDelta("INTEREST", r.amount);
    const converted = conv.at(amount, r.currency!, rowDate(r));
    parts.interest.push(converted);
    if (converted.amount !== null) cadInterest.push({ ...r, currency: "CAD", amount: converted.amount });
  }
  const months = monthlyIncome(cadEvents, cadInterest, input.year);
  const forwardParts = forward.estimates.map((f) => conv.at(f.amount, f.currency));
  const topPayers = [...netByPayer.entries()]
    .sort(([sa, a], [sb, b]) => b.net - a.net || sa.localeCompare(sb))
    .slice(0, PAYLOAD_PAYERS)
    .map(([symbol, p]) => ({
      symbol, net: cents(p.net), estimated: p.estimated,
      yieldOnCost: p.currencies.size === 1 ? yieldOf.get(`${symbol}|${[...p.currencies][0]}`) ?? null : null,
    }));
  const single = currencyTotals.length === 1 ? currencyTotals[0] : null;
  return {
    tiles: { net: sumHome(parts.net), gross: sumHome(parts.gross), withholding: sumHome(parts.withholding), interest: sumHome(parts.interest), forward12m: sumHome(forwardParts) },
    months, topPayers,
    forwardCoverage: currencyTotals.reduce((t, c) => ({ payers: t.payers + c.forwardCoverage.payers, covered: t.covered + c.forwardCoverage.covered }), { payers: 0, covered: 0 }),
    yields: single ? { yieldOnCost: single.yieldOnCost, currentYield: single.currentYield } : null,
  };
}

/** The ex-date isn't reported: the units held this long before a pay date stand for the units it was paid on (ex-date to pay date is rarely longer). */
const PAYOUT_WINDOW_BEFORE_DAYS = 30;
/**
 * A per-unit figure from the units at the pay date is kept while they agree with the units 30 days before within this
 * fraction (inclusive): a monthly or quarterly buyer's small top-ups and a reinvested dividend pass; half a position
 * sold between the ex-date and the pay date does not (a $25 payment on 50 units is not $0.50 a unit on 100).
 */
const PAYOUT_UNITS_DRIFT = 0.1;
const TRADES = new Set(["BUY", "SELL"]);

/**
 * Whether the units before a payment are the units it was paid on: the units at the pay date and those 30 days before
 * agree within PAYOUT_UNITS_DRIFT of the larger, and no non-trade row (a CORPORATE_ACTION split, a transfer in kind)
 * changed units from 30 days before the pay date on, since a per-unit figure from before it can't be applied to today's
 * units. A reinvested dividend doesn't count as such a row: it only adds what the payment bought.
 */
function unitsSettled(list: StoredActivity[], date: string, units: number, unitsBefore: number | null): boolean {
  const from = minusDays(date, PAYOUT_WINDOW_BEFORE_DAYS);
  for (const r of list) {
    const delta = signedUnits(r);
    const type = r.type.toUpperCase();
    if (delta === 0 || REINVESTS.has(type) || rowDate(r) < from) continue;
    if (!TRADES.has(type)) return false;
  }
  const before = unitsBefore ?? 0;
  return Math.abs(units - before) <= PAYOUT_UNITS_DRIFT * Math.max(units, before);
}

/**
 * Units per (symbol, account) from the activity replay: on a date (strictly before it), the same but null when they
 * can't be trusted for a payment on that date (`unitsSettled`, against the units 30 days before), and finally (null
 * when inconsistent).
 */
function unitsReplay(rows: StoredActivity[]) {
  const byAccountSymbol = new Map<string, StoredActivity[]>();
  for (const r of rows) {
    if (r.isOption || !symOf(r)) continue;
    const key = `${symOf(r)}|${r.snapTradeAccountId}`;
    const list = byAccountSymbol.get(key);
    if (list) list.push(r); else byAccountSymbol.set(key, [r]);
  }
  const replays = new Map<string, { points: Array<{ date: string; units: number }>; units: number | null }>();
  const replayOf = (symbol: string, accountId: string) => {
    const key = `${symbol}|${accountId}`;
    let r = replays.get(key);
    if (!r) {
      const list = byAccountSymbol.get(key);
      const pos = list ? symbolPosition(list, [], () => null) : null;
      r = { points: pos?.points ?? [], units: pos && pos.reason !== "inconsistent" ? pos.units : null };
      replays.set(key, r);
    }
    return r;
  };
  const unitsOnDate = (symbol: string, accountId: string, date: string): number | null => {
    let units: number | null = null;
    for (const p of replayOf(symbol, accountId).points) { if (p.date < date) units = p.units; else break; }
    return units;
  };
  const payoutUnits = (symbol: string, accountId: string, date: string): number | null => {
    const units = unitsOnDate(symbol, accountId, date);
    if (units === null || units <= 0) return units;
    const before = unitsOnDate(symbol, accountId, minusDays(date, PAYOUT_WINDOW_BEFORE_DAYS));
    return unitsSettled(byAccountSymbol.get(`${symbol}|${accountId}`) ?? [], date, units, before) ? units : null;
  };
  /** The date the position last went from no units to some, or null. */
  const openedOn = (symbol: string, accountId: string): string | null => {
    let opened: string | null = null;
    let before = 0;
    for (const p of replayOf(symbol, accountId).points) {
      if (before <= 1e-9 && p.units > 1e-9) opened = p.date;
      before = p.units;
    }
    return opened;
  };
  return { unitsOnDate, payoutUnits, openedOn, replayedUnits: (symbol: string, accountId: string) => replayOf(symbol, accountId).units };
}

/** A market ex-date this close before a pay date is taken to be that payment's. */
const EX_DATE_BEFORE_PAY_DAYS = 45;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
/** Payments kept for the dividend projection: long enough for two annual payments plus slack. */
const PAYMENT_HISTORY_DAYS = 1_100;

/**
 * Past dividend payments per symbol for the calendar projection (investable accounts only): gross per unit held
 * that day (the activity replay), in the payment currency. Payments whose units are unknown are skipped. `perUnit` is
 * null (the date still sets the cadence) when units changed around the payment, or when the replay doesn't reach the
 * units reported now (a SPLIT row, partial history): the same payers the forward estimate leaves out. For a symbol whose
 * latest payment is blank that way, `options.market`'s per-share figure in the same currency (the latest ex-date within
 * EX_DATE_BEFORE_PAY_DAYS before the pay date) fills it, so the projection still has an amount.
 */
export async function dividendPayments(
  activities: Pick<ActivityStore, "queryActivities">, appUserId: string, accounts: PortfolioPresentationAccount[], today: string,
  options: { market?: IncomeDeps["market"]; marketDeadlineMs?: number } = {},
): Promise<Array<{ symbol: string; date: Date; perUnit: number | null; currency: string }>> {
  const accountIds = accounts.filter(isInvestable).map((a) => a.id);
  if (accountIds.length === 0) return [];
  // Units are replayed from all history (positions opened before the window), as the income view does.
  const rows = await activities.queryActivities(appUserId, { accountIds, from: ALL_TIME_FROM, to: today });
  const { unitsOnDate, payoutUnits, replayedUnits } = unitsReplay(rows);
  const heldRows = aggregateHoldings(accounts.filter(isInvestable), {}).rows;
  const reported = unitsByAccount(heldRows);
  const reconciled = (symbol: string, accountId: string) => {
    const replayed = replayedUnits(symbol, accountId);
    const now = reported.get(`${symbol}|${accountId}`) ?? 0;
    return replayed !== null && Math.abs(replayed - now) <= Math.max(UNITS_TOLERANCE * now, 1e-9);
  };
  const from = minusDays(today, PAYMENT_HISTORY_DAYS);
  const out: Array<{ symbol: string; date: Date; perUnit: number | null; currency: string }> = [];
  for (const e of netDividends(rows)) {
    if (e.symbol === null || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || e.date < from) continue;
    const units = unitsOnDate(e.symbol, e.accountId, e.date);
    if (units === null || !Number.isFinite(units) || units <= 0 || !Number.isFinite(e.gross) || e.gross <= 0) continue;
    const trusted = payoutUnits(e.symbol, e.accountId, e.date) !== null && reconciled(e.symbol, e.accountId);
    out.push({ symbol: e.symbol, date: new Date(`${e.date}T00:00:00Z`), perUnit: trusted ? Math.round((e.gross / units) * 1e6) / 1e6 : null, currency: e.currency });
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.date.getTime() - b.date.getTime());
  const latest = new Map(out.map((p) => [p.symbol, p]));
  const blank = [...latest.values()].filter((p) => p.perUnit === null);
  const heldBlank = heldRows.filter((h) => blank.some((p) => p.symbol === h.symbol));
  if (heldBlank.length > 0 && options.market?.distributions) {
    const market = await distributionsBySymbol(options.market, heldBlank, today, options.marketDeadlineMs);
    for (const p of blank) {
      const m = market(p.symbol);
      if (m?.currency?.trim().toUpperCase() !== p.currency) continue;
      const paidOn = isoDay(p.date);
      const exDate = m.events.filter((e) => e.date <= paidOn && e.date >= minusDays(paidOn, EX_DATE_BEFORE_PAY_DAYS)).at(-1);
      if (exDate) p.perUnit = exDate.amount;
    }
  }
  return out;
}

/** The CAD tiles' net dividends plus interest: already converted by the payload, so a sum, not a new conversion. */
function homeIncome(home: IncomeHome): Pick<HomeTotal, "amount" | "estimated" | "rateDates" | "excludedCount"> {
  const { net, interest } = home.tiles;
  return {
    amount: cents(net.amount + interest.amount), estimated: net.estimated || interest.estimated,
    rateDates: [...new Set([...net.rateDates, ...interest.rateDates])].sort(), excludedCount: net.excludedCount + interest.excludedCount,
  };
}

const FORWARD_REASONS: Record<ForwardUncoveredReason, string> = {
  units_changed: "units changed around a payment",
  history_mismatch: "its activity doesn't add up to the units held",
  partial_year: "held under a year",
};
/** When the forward estimate leaves holdings out: how many it covers, per account, and which it leaves out and why. */
function forwardText(p: IncomePayload): string | null {
  const partial = p.currencyTotals.filter((t) => t.forwardCoverage.covered < t.forwardCoverage.payers);
  if (partial.length === 0) return null;
  const covered = partial.reduce((n, t) => n + t.forwardCoverage.covered, 0);
  const holdings = partial.reduce((n, t) => n + t.forwardCoverage.payers, 0);
  const listed = partial.flatMap((t) => t.forwardUncovered ?? []);
  const named = listed.map((u) => `${u.symbol} in ${u.account} (${FORWARD_REASONS[u.reason]})`).join(", ");
  return `Forward estimate from ${covered} of ${holdings} holdings (a holding in each account counts once).${named ? ` Left out: ${named}.` : ""}`;
}

const moneyList = (items: Array<{ amount: number; currency: string }>) => items.map((i) => formatMoney(i.amount, i.currency)).join(" + ");

/**
 * Answer first (spec D5): the year's net income (net dividends plus interest) in the scope, then the top payer; no account
 * ids. `scope` is the resolver's scope words from `buildIncomeResult`. Native amounts per currency, as reported. With
 * the CAD view on and more than CAD received, the payload's own CAD tiles lead, marked est. with the Bank of Canada
 * date of the rates those payments converted at ("rates by pay date" when several); only when every amount converted,
 * otherwise the native amounts stand alone. Withholding deducted, and withholding that matches no dividend (not
 * deducted), follow. With a symbol: "net dividends from {SYMBOL}", no top payer.
 */
export function incomeText(p: IncomePayload, scope: string, options: { show?: boolean } = {}): string {
  const year = p.asOf.slice(0, 4);
  const sym = p.filters.symbol;
  const shown = p.currencyTotals.filter((t) => p.months.some((m) => m.currency === t.currency));
  let text: string;
  if (shown.length === 0) {
    text = sym ? `No dividends from ${sym} recorded for ${p.year} ${scope}.` : `No dividend or interest income recorded for ${p.year} ${scope}.`;
  } else {
    const native = moneyList(shown.map((t) => ({ amount: cents(t.net + t.interest), currency: t.currency })));
    const cad = p.home && shown.some((t) => t.currency !== HOME_CURRENCY) ? homeIncome(p.home) : null;
    const useCad = cad !== null && cad.excludedCount === 0 && cad.estimated && cad.rateDates.length > 0;
    const rates = useCad ? (cad.rateDates.length === 1 ? `BoC ${shortDate(cad.rateDates[0]!, year)}` : "BoC rates by pay date") : "";
    // The one total is net of withholding and, without a symbol, includes interest: the widget's Net dividends plus Interest tiles.
    const what = sym ? `net dividends from ${sym} (after withholding)` : "net income (after withholding, incl. interest)";
    const head = useCad
      ? `${formatMoney(cad.amount, HOME_CURRENCY)} of ${what} in ${p.year} ${scope} (est., ${rates}; ${native} as reported)`
      : `${native} of ${what} in ${p.year} ${scope}`;
    let payers: string[] = [];
    if (!sym && useCad) {
      const top = p.home!.topPayers[0];
      if (top) payers = [`${top.symbol} (${formatMoney(top.net, HOME_CURRENCY)}${top.estimated ? ` est., ${rates}` : ""})`];
    } else if (!sym) {
      // topPayers is sorted by net within the payload; the first of each currency is that currency's top payer.
      payers = shown.flatMap((t) => {
        const top = p.topPayers.find((x) => x.currency === t.currency);
        return top ? [`${top.symbol} (${formatMoney(top.net, top.currency)})`] : [];
      });
    }
    text = payers.length === 0 ? `${head}.` : `${head}; top ${payers.length === 1 ? "payer" : "payers"} ${payers.join(", ")}.`;
    const withheld = p.currencyTotals.filter((t) => t.withholding > 0);
    if (withheld.length > 0) text += ` ${moneyList(withheld.map((t) => ({ amount: t.withholding, currency: t.currency })))} of withholding tax was deducted.`;
    const unmatched = p.currencyTotals.filter((t) => t.unmatchedWithholding.count > 0 && t.unmatchedWithholding.amount > 0);
    if (unmatched.length > 0) {
      text += ` ${withheld.length > 0 ? "Another " : ""}${moneyList(unmatched.map((t) => ({ amount: t.unmatchedWithholding.amount, currency: t.currency })))} of withholding tax matches no dividend and is not deducted.`;
    }
  }
  const forward = forwardText(p);
  if (forward) text += ` ${forward}`;
  if (p.syncing.length > 0) text += " Some accounts are still syncing.";
  return options.show ? `${text} Showing the income widget.` : text;
}

const r4 = (v: number | null) => (v === null ? null : Math.round(v * 10_000) / 10_000);

/** Compact copy for the model: yearly totals per currency, the top 20 payers and withholding rates; no ids. */
const homeFigure = (t: HomeTotal) => ({ amount: t.amount, estimated: t.estimated, notConverted: t.excludedCount });

export function incomeModelCopy(p: IncomePayload) {
  const accountLabel = p.filters.accountId === undefined ? undefined : p.accounts.find((a) => a.id === p.filters.accountId)?.label;
  return {
    year: p.year,
    years: p.years,
    filters: {
      ...(accountLabel ? { accountLabel } : {}),
      ...(p.filters.accountType ? { accountType: p.filters.accountType } : {}), ...(p.filters.symbol ? { symbol: p.filters.symbol } : {}),
    },
    monthsWithIncome: p.months.length,
    ...(p.home ? { homeTotals: {
      net: homeFigure(p.home.tiles.net), gross: homeFigure(p.home.tiles.gross), withholding: homeFigure(p.home.tiles.withholding),
      interest: homeFigure(p.home.tiles.interest), forward12m: homeFigure(p.home.tiles.forward12m),
    } } : {}),
    currencyTotals: p.currencyTotals.map((c) => ({ ...c, yieldOnCost: r4(c.yieldOnCost), currentYield: r4(c.currentYield) })),
    topPayers: p.topPayers.slice(0, MODEL_PAYERS).map((t) => ({ symbol: t.symbol, currency: t.currency, net: t.net, yieldOnCost: r4(t.yieldOnCost) })),
    hasMore: p.topPayers.length > MODEL_PAYERS,
    withholding: p.withholding.map((w) => ({ accountType: w.accountType, currency: w.currency, rate: r4(w.rate) })),
    syncingAccounts: p.syncing.length,
    notes: {
      forward12m: "forward12m and yields are estimates, after withholding, of the next 12 months at today's holdings: the market's per-share distributions over the last 12 months where available, else the account's own payments (so the same stock can yield less in a TFSA than in an RRSP). forwardCoverage counts holdings, one per account, in `payers` and those it could be estimated for in `covered`; forwardUncovered names the rest with a reason: units_changed (units changed around a payment), history_mismatch (activity doesn't add up to the units held), partial_year (held under a year). yieldsLeftOut counts holdings the yields skip because a yield can't be told (one of those, or dividends in another currency with no rate). yieldsConverted counts holdings whose yield uses dividends paid in another currency, converted at the Bank of Canada rate on each pay date (est.).",
      withholding: p.home ? "net = gross - withholding." : "net = gross - withholding; amounts are in their own currency.",
      ...(p.home ? { currency: CAD_NOTE } : {}),
    },
    note: INCOME_NOTE,
  };
}

const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const security = [{ type: "oauth2" as const, scopes: ["portfolio:read"] }];

const inputSchema = {
  type: "object",
  properties: {
    year: { type: "integer", minimum: 2000, maximum: 2100 },
    ...accountFilterProperties,
    symbol: symbolProperty,
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  properties: {
    home: { type: "object" }, year: { type: "integer" }, years: { type: "array" }, currencyTotals: { type: "array" }, months: { type: "array" }, topPayers: { type: "array" },
    yields: { type: "array" }, withholding: { type: "array" }, contributions: { type: "array" }, accounts: { type: "array" }, syncing: { type: "array" },
    filters: { type: "object" }, settings: { type: "object" }, asOf: { type: "string" },
  },
  required: ["year", "years", "currencyTotals", "months", "topPayers", "yields", "withholding", "contributions", "accounts", "syncing", "filters", "settings", "asOf"],
  additionalProperties: false,
} as const;

export const incomeToolDefinitions = [
  {
    name: "show_income",
    title: "Show income",
    description: "Use this when the user asks about dividends, income, distributions, interest, withholding tax or yield: renders the interactive income view. Filter with accountType or accountId, and symbol. Read-only.",
    inputSchema,
    outputSchema,
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    _meta: {
      securitySchemes: security, ui: { resourceUri: INCOME_WIDGET_URI }, "openai/outputTemplate": INCOME_WIDGET_URI,
      "openai/widgetAccessible": true, "openai/toolInvocation/invoking": "Loading income…", "openai/toolInvocation/invoked": "Income ready.",
    },
  },
  {
    name: "get_income",
    title: "Get income",
    description: "Used by the income widget to switch year and account. Covers the user's investment accounts. Read-only.",
    inputSchema,
    outputSchema,
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    _meta: { securitySchemes: security, ui: { visibility: ["app"] } },
  },
] as const;
