import { createHash } from "node:crypto";
import { z } from "zod";
import { categorize, ACTIVITY_CATEGORIES, type ActivityCategory } from "../activity/categories.js";
import { cursorKey, decodeCursor, encodeCursor } from "../activity/cursor.js";
import { describe } from "../activity/describe.js";
import { homeCostReplay } from "../activity/home-cost.js";
import { groupBySymbolCurrency, symbolPosition, type SymbolPosition, type SymbolPositionPoint } from "../activity/symbol-position.js";
import { tradePriceConverter, type ToSecurityCurrency } from "../activity/trade-price.js";
import { scopedTransferKeys } from "../analytics/flows.js";
import { DEPOSITS, DIVIDEND_MATCH_DAYS, DIVIDENDS, dividendsInView, REINVESTS, summariseWithholding, WITHHOLDING } from "../analytics/income.js";
import { loadHomeConverter, homeConverter, sumHome, type HomeAmount, type HomeConverter, type HomeTotal } from "../fx/home-currency.js";
import { minusMonths } from "../analytics/value-series.js";
import type { ActivityStore } from "../history/activity-store.js";
import { cashDelta, SIGN_RULES } from "../history/sign-rules.js";
import type { StoredActivity } from "../history/stored-activity.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import { isTrustedPriceKind, priceOutOfRange, providerTicker } from "../market-data/ticker-map.js";
import type { PortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import type { PortfolioSettingsView, SettingsService } from "../settings/settings-service.js";
import { loadSettings, withDeadline } from "./overview-tools.js";
import { CAD_NOTE, formatMoney, shortDate } from "./home-fx.js";
import {
  accountFilterProperties, accountFilterShape, resolveAccountFilter, symbolMatches, symbolProperty, symbolShape, type AccountType, type ResolvedAccountFilter,
} from "./query-filters.js";

export const ACTIVITY_WIDGET_URI = "ui://portfolio/activity-v1";
export const ACTIVITY_PAGE_SIZE = 50;
const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_MARKET_DEADLINE_MS = 5_000;
const ALL_TIME_FROM = "2000-01-01";
/** Rows read beyond the range to net dividends: a withholding row just outside it, and the dividends that row could match. */
const WITHHOLDING_READ_DAYS = DIVIDEND_MATCH_DAYS * 2;

const realDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine(
  (s) => { const t = Date.parse(`${s}T00:00:00Z`); return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s; },
  "Not a real calendar date",
);
const filterShape = {
  ...accountFilterShape,
  categories: z.array(z.enum(ACTIVITY_CATEGORIES as [ActivityCategory, ...ActivityCategory[]])).min(1).max(ACTIVITY_CATEGORIES.length).optional(),
  symbol: symbolShape,
  from: realDate.optional(),
  to: realDate.optional(),
  query: z.string().max(1000).optional(),
};
const ordered = (v: { from?: string; to?: string }) => !(v.from && v.to && v.from > v.to);
const orderedMessage = { message: "from must not be after to", path: ["from"] };

export const activityFiltersInput = z.object(filterShape).strict().refine(ordered, orderedMessage);
/** Longest search text show_activity keeps. Rows hold short labels; a model's whole question there matches nothing. */
const MAX_SEARCH_WORDS = 4;

/** show_activity's filters, without search text that is really a sentence. */
export function parseShowActivity(args: unknown): ActivityFiltersInput {
  const input = activityFiltersInput.parse(args);
  if (input.query === undefined || input.query.trim().split(/\s+/).length <= MAX_SEARCH_WORDS) return input;
  const { query: _query, ...filters } = input;
  return filters;
}
export const activityPageInput = z.object({ ...filterShape, cursor: z.string().max(1024).optional() }).strict().refine(ordered, orderedMessage);
export const symbolHistoryInput = z.object({
  symbol: z.string().trim().min(1).max(40),
  accountId: z.string().min(1).optional(),
  period: z.enum(["1Y", "ALL"]).optional(),
}).strict();

export type ActivityFiltersInput = z.infer<typeof activityFiltersInput>;
export type ActivityPageInput = z.infer<typeof activityPageInput>;
export type SymbolHistoryInput = z.infer<typeof symbolHistoryInput>;

export interface ActivityDeps {
  activities: Pick<ActivityStore, "userId" | "syncState" | "queryActivities">;
  /** `usdCad` converts row-currency trade prices of foreign securities (brief 8); without it they are unknown. */
  market: Pick<MarketDataService, "securityHistory"> & Partial<Pick<MarketDataService, "usdCad">>;
  settings: Pick<SettingsService, "get">;
  cursorSecret: Buffer;
  now?: () => Date;
  /** Budget for the market-data call. Default 5000 ms. */
  marketDeadlineMs?: number;
}

export interface ActivityRow {
  id: string; date: string; accountId: string; accountLabel: string; category: ActivityCategory; type: string;
  symbol: string | null; description: string; units: number | null; price: number | null;
  /** Currency of `price`: SnapTrade reports trade prices in the row (transaction) currency, else the security's (brief 8). */
  priceCurrency: string | null;
  /** Display amount in `currency`: negative is money out (SPEND and card payments are reported positive and flipped). */
  amount: number | null;
  currency: string | null; estimated?: true;
  /** The direction of `amount` is unknown (CREDIT_CARD rows); render it without a sign. */
  unsigned?: true;
  /** `amount` in CAD (signed like `amount`), converted at the row's own date; absent when `amount` is null. */
  home?: HomeAmount;
}

export interface ActivityHomeTotals { bought: HomeTotal; sold: HomeTotal; dividends: HomeTotal }

export type AccountKind = "investment" | "cash" | "credit";

export interface ActivityPage {
  rows: ActivityRow[];
  nextCursor: string | null;
  restarted: boolean;
  /**
   * Over every filtered row (not just the page). `dividends` is net of matched withholding tax
   * (`dividendsGross` + `withholding`), matched over rows read beyond the range and search; `unmatchedWithholding` (only
   * when there is some) is the withholding in view that matches no dividend and is not deducted. Across all accounts and in a scope of several accounts, deposits and
   * withdrawals exclude internal transfers whose two legs are both in scope (one account keeps both legs);
   * `feeTransactions` counts FEE rows only (FX spreads are not included).
   */
  totals: Array<{ currency: string; bought: number; sold: number; dividends: number; dividendsGross: number; withholding: number; deposits: number; withdrawals: number; feeTransactions: number; unmatchedWithholding?: { count: number; amount: number } }>;
  /** CAD sums of exactly the rows `totals` uses for bought, sold and dividends (net of withholding). */
  homeTotals: ActivityHomeTotals;
  /** Counts over every filtered row (not just the page); drives the summary text. */
  counts: { total: number; byType: Record<string, number> };
  /** `accountId` is also set when `accountType` matched exactly one account. */
  filters: { accountId?: string; accountType?: AccountType; categories: ActivityCategory[]; symbol?: string; from: string; to: string; query?: string };
  accounts: Array<{ id: string; label: string; kind: AccountKind }>;
  /** Accounts whose history is still backfilling: the scope's, and for a multi-account scope the other listed accounts read to pair transfer legs. */
  syncing: string[];
  settings: PortfolioSettingsView;
  asOf: string;
}

export interface SymbolHistory {
  symbol: string; name: string | null; currency: string | null; period: "1Y" | "ALL";
  prices: Array<{ date: string; close: number }>;
  priceUnavailable: boolean;
  position: Omit<SymbolPosition, "points"> & { points: SymbolPositionPoint[] };
  /** Units the brokerage reports now for this symbol in the same accounts and currency; null when holdings are unavailable. */
  reportedUnits: number | null;
  /** Brokerage-reported figures for the current holding; null when nothing is held or holdings are unavailable. */
  reported: ReportedFigures | null;
  /**
   * Whether the replayed average-cost line reconciles with the brokerage's average cost:
   * "matches" (within 1%), "unavailable" (it does not; every point's avgCost is nulled) or
   * "unverified" (no reported average to compare with).
   */
  costHistory: "matches" | "unavailable" | "unverified";
  /**
   * Gains in CAD (spec 6.4): realized (average cost per account, always est.) and unrealized (CAD
   * market value minus CAD cost) summed over the in-scope accounts. `unavailable` when any of
   * those accounts fails the gate (then both are null: never a partial sum). `unrealized` is null
   * when nothing is held. Null when the CAD view is off.
   */
  homeGains: { realized: HomeAmountLike | null; unrealized: HomeAmountLike | null; unavailable: boolean } | null;
  otherCurrencies: string[];
  asOf: string;
}

export interface HomeAmountLike { amount: number; estimated: boolean }

/** Sums over the scope accounts' current positions of the symbol in the group currency. costBasis is per unit. */
export interface ReportedFigures {
  units: number | null;
  /** Σ(units × costBasis) / Σ units. */
  avgCost: number | null;
  /** Σ(units × costBasis). */
  bookCost: number | null;
  /** Σ(units × price). */
  marketValue: number | null;
  /** marketValue − bookCost. */
  totalReturn: number | null;
  totalReturnFraction: number | null;
  currency: string | null;
}

/** The replayed average may differ from the brokerage's by at most this fraction to be shown as history. */
export const COST_HISTORY_TOLERANCE = 0.01;
/** Gains gate (spec 6.4): replayed units within 0.5% of reported. */
export const GAINS_UNITS_TOLERANCE = 0.005;
/** Branch B: replayed CAD average within 3% of the reported (CAD) cost basis. */
export const GAINS_CAD_COST_TOLERANCE = 0.03;
/** Book-cost currency per account: reported cost basis ÷ replayed USD average within 5% of 1 (USD) or of USD/CAD (CAD). */
export const COST_BASIS_CURRENCY_BAND = 0.05;
const UNITS_EPS = 1e-9;

export type ActivityScopeCode = Extract<ResolvedAccountFilter, { ok: false }>["code"];
const UNKNOWN_ACCOUNT_TEXT = "Unknown or excluded account. Use list_portfolio_accounts to pick an account.";

/** An account filter that cannot be served; `text` is the resolver's copy for the person. */
export class ActivityScopeError extends Error {
  constructor(readonly code: ActivityScopeCode, readonly text: string) { super(code); this.name = "ActivityScopeError"; }
}

const torontoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });
const minusDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
const cents = (n: number) => Math.round(n * 100) / 100;
const rowDate = (a: StoredActivity) => a.tradeDate ?? a.settlementDate ?? "";
const rowId = (dedupeKey: string) => createHash("sha256").update(dedupeKey).digest("hex").slice(0, 16);

export interface ListedAccount { id: string; label: string; kind: AccountKind }

/** Closed accounts and uncategorised excluded accounts are never listed; labels are de-duplicated like Performance. */
export function listAccounts(portfolio: PortfolioPresentation): ListedAccount[] {
  const candidates: Array<{ id: string; base: string; kind: AccountKind }> = [];
  for (const a of portfolio.accounts) {
    const c = a.classification;
    if (c.isClosed || c.group === "closed") continue;
    if (c.bucket === "credit_card" || c.bucket === "line_of_credit" || c.group === "credit_products") {
      candidates.push({ id: a.id, base: c.label, kind: "credit" });
    } else if (c.includedInPortfolioTotal) {
      candidates.push({ id: a.id, base: c.label, kind: c.bucket === "money_market" ? "cash" : "investment" });
    }
  }
  const total = new Map<string, number>();
  for (const c of candidates) total.set(c.base, (total.get(c.base) ?? 0) + 1);
  const seen = new Map<string, number>();
  return candidates.map((c) => {
    const ordinal = (seen.get(c.base) ?? 0) + 1;
    seen.set(c.base, ordinal);
    return { id: c.id, kind: c.kind, label: (total.get(c.base) ?? 1) > 1 && ordinal > 1 ? `${c.base} ${ordinal}` : c.base };
  });
}

const BOUGHT = new Set(["BUY"]);
const SOLD = new Set(["SELL"]);
const WITHDRAWALS = new Set(["WITHDRAWAL", "INTERNAL_CASH_TRANSFER_OUT"]);
const FEES = new Set(["FEE"]);
/** Money out of a Cash account that Performance counts, but "withdrawals" does not. */
const SPENDING = new Set(["SPEND", "CREDIT_CARD_PAYMENT"]);

type Totals = ActivityPage["totals"][number];

/** Credit-account rows are always Cash & spending, whatever their SnapTrade type. */
const categoryOf = (a: StoredActivity, kind: AccountKind): ActivityCategory => (kind === "credit" ? "cash" : categorize(a, kind));

/**
 * Totals per currency. Dividends are netted against TAX/WITHHOLDING rows of the same account,
 * symbol and currency within DIVIDEND_MATCH_DAYS, found in `context` (the rows read beyond the range
 * and search); a REI/REINVEST row counts as dividend cash only when no such dividend exists (its
 * units are not cash). With `netTransfers`, matched internal
 * transfer pairs whose two legs are both in `rows` are neither deposits nor withdrawals
 * (scopedTransferKeys); `matchOnly` rows (listed accounts outside a multi-account scope) are read only
 * to pair legs, so money routed through Cash still counts. `flows` counts deposit and withdrawal rows
 * left out of the totals, for the text.
 */
function computeTotals(
  rows: StoredActivity[], options: { netTransfers: boolean; matchOnly?: StoredActivity[]; home: HomeConverter; context: StoredActivity[] },
): { totals: Totals[]; homeTotals: ActivityHomeTotals; flows: Omit<ActivityFlowFacts, "credit"> } {
  const parts: Record<keyof ActivityHomeTotals, HomeAmount[]> = { bought: [], sold: [], dividends: [] };
  const by = new Map<string, Totals>();
  const flows = { netted: 0, unknownDeposits: 0, unknownWithdrawals: 0 };
  const skip = options.netTransfers ? scopedTransferKeys(rows, options.matchOnly) : new Set<string>();
  const usable = (r: StoredActivity) => r.currency !== null && r.amount !== null && Number.isFinite(r.amount);
  const valid = rows.filter(usable);
  for (const r of rows) {
    if (usable(r)) continue;
    const type = r.type.toUpperCase();
    if (DEPOSITS.has(type)) flows.unknownDeposits++;
    else if (WITHDRAWALS.has(type)) flows.unknownWithdrawals++;
  }
  const slot = (currency: string) => {
    let t = by.get(currency);
    if (!t) { t = { currency, bought: 0, sold: 0, dividends: 0, dividendsGross: 0, withholding: 0, deposits: 0, withdrawals: 0, feeTransactions: 0 }; by.set(currency, t); }
    return t;
  };
  for (const r of valid) {
    const currency = r.currency!.toUpperCase();
    const t = slot(currency);
    const type = r.type.toUpperCase();
    const amount = r.amount!;
    const cash = cashDelta(type, amount);
    const homeOf = (n: number) => options.home.at(n, currency, rowDate(r));
    if (BOUGHT.has(type)) { t.bought += Math.abs(amount); parts.bought.push(homeOf(Math.abs(amount))); }
    else if (SOLD.has(type)) { t.sold += cash; parts.sold.push(homeOf(cash)); }
    else if (DIVIDENDS.has(type) || REINVESTS.has(type) || WITHHOLDING.has(type)) continue;
    else if (skip.has(r.dedupeKey)) { if (DEPOSITS.has(type) || WITHDRAWALS.has(type)) flows.netted++; continue; }
    else if (DEPOSITS.has(type)) t.deposits += cash;
    else if (WITHDRAWALS.has(type)) t.withdrawals += cash;
    else if (FEES.has(type)) t.feeTransactions += cash;
  }
  const dividends = dividendsInView(valid, options.context);
  for (const e of dividends.events) {
    const t = slot(e.currency);
    t.dividendsGross += e.gross;
    t.withholding -= e.withholding;
    parts.dividends.push(options.home.at(e.gross, e.currency, e.date));
    if (e.withholding !== 0) parts.dividends.push(options.home.at(-e.withholding, e.currency, e.date));
  }
  for (const u of summariseWithholding(dividends.unmatched)) slot(u.currency).unmatchedWithholding = { count: u.count, amount: u.amount };
  const totals = [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map((t) => ({
    currency: t.currency, bought: cents(t.bought), sold: cents(t.sold),
    dividends: cents(t.dividendsGross + t.withholding), dividendsGross: cents(t.dividendsGross), withholding: cents(t.withholding),
    deposits: cents(t.deposits), withdrawals: cents(t.withdrawals), feeTransactions: cents(t.feeTransactions),
    ...(t.unmatchedWithholding ? { unmatchedWithholding: t.unmatchedWithholding } : {}),
  }));
  return { totals, homeTotals: { bought: sumHome(parts.bought), sold: sumHome(parts.sold), dividends: sumHome(parts.dividends) }, flows };
}

const EMPTY_HOME_TOTAL: HomeTotal = { amount: 0, estimated: false, rateDates: [], excluded: [], excludedCount: 0 };
const emptyHomeTotals = (): ActivityHomeTotals => ({ bought: { ...EMPTY_HOME_TOTAL }, sold: { ...EMPTY_HOME_TOTAL }, dividends: { ...EMPTY_HOME_TOTAL } });

/** What the text needs beyond the payload: the scope words and the deposit and withdrawal rows left out of `totals`. */
export interface ActivityFlowFacts {
  /** Deposit and withdrawal rows of transfers whose two legs are both in scope (netted out). */
  netted: number;
  /** Deposit and withdrawal rows without a usable amount or currency. */
  unknownDeposits: number; unknownWithdrawals: number;
  /** Deposit and withdrawal rows in credit accounts (never in the totals). */
  credit: number;
  /** Spending and card payments out of non-credit accounts in the date range, per currency: money out that "withdrawals" leaves out. */
  spending?: Array<{ amount: number; currency: string }>;
}
export interface ActivityTextFacts extends ActivityFlowFacts {
  /** The resolver's scope words: "in your TFSAs", "in {account name}" or "across all accounts". */
  scope: string;
}

export async function buildActivityPage(
  deps: ActivityDeps, portfolio: PortfolioPresentation, authSubject: string,
  input: ActivityPageInput | (ActivityFiltersInput & { cursor?: string }),
): Promise<ActivityPage> {
  return (await buildActivityResult(deps, portfolio, authSubject, input)).page;
}

export async function buildActivityResult(
  deps: ActivityDeps, portfolio: PortfolioPresentation, authSubject: string,
  input: ActivityPageInput | (ActivityFiltersInput & { cursor?: string }),
): Promise<{ page: ActivityPage; facts: ActivityTextFacts }> {
  const today = torontoDate.format((deps.now ?? (() => new Date()))());
  const categories = [...new Set(input.categories ?? ["investing"])].sort() as ActivityCategory[];
  const wantsCash = categories.includes("cash");
  const symbol = input.symbol?.trim().toUpperCase() || undefined;
  // A symbol question ("my history with HOOD") means the whole history unless a range is given;
  // a 90-day default came back empty for older trades and made the model call again.
  const from = input.from ?? (symbol ? ALL_TIME_FROM : minusDays(today, DEFAULT_WINDOW_DAYS));
  const to = input.to ?? today;
  const query = input.query?.trim() || undefined;

  const listed = listAccounts(portfolio);
  const listedIds = new Set(listed.map((a) => a.id));
  // Only listed accounts can be named, by id or by type (credit accounts by id only: they match no type).
  const resolved = resolveAccountFilter(
    { accounts: portfolio.accounts.filter((a) => listedIds.has(a.id)) },
    { accountId: input.accountId, accountType: input.accountType },
  );
  if (!resolved.ok) throw new ActivityScopeError(resolved.code, resolved.text);
  const ids = resolved.ids;
  // Cash and credit accounts are read only for Cash & spending; cash accounts also hold deposits, so they stay in scope.
  const inScope = listed.filter((a) => (ids === null || ids.has(a.id)) && (a.kind !== "credit" || wantsCash));
  const kindOf = new Map(listed.map((a) => [a.id, a]));

  const filters: ActivityPage["filters"] = { categories, from, to };
  if (resolved.singleId !== undefined) filters.accountId = resolved.singleId;
  if (resolved.accountType !== undefined) filters.accountType = resolved.accountType;
  if (symbol) filters.symbol = symbol;
  if (query) filters.query = query;
  // The cursor is bound to the user as well as to the normalised filters.
  const bound = { sub: authSubject, ...filters };
  const key = cursorKey(deps.cursorSecret);
  const { before, restarted } = decodeCursor(key, bound, (input as { cursor?: string }).cursor);

  const settings = await loadSettings(deps as Parameters<typeof loadSettings>[0], authSubject);
  const base = { restarted, accounts: listed, settings, asOf: portfolio.generatedAt, filters };
  const userId = await deps.activities.userId(authSubject);
  const noFlows = { netted: 0, unknownDeposits: 0, unknownWithdrawals: 0, credit: 0 };
  if (!userId) {
    const page: ActivityPage = { ...base, rows: [], nextCursor: null, totals: [], homeTotals: emptyHomeTotals(), counts: { total: 0, byType: {} }, syncing: inScope.map((a) => a.id) };
    return { page, facts: { scope: resolved.scope, ...noFlows } };
  }

  // Transfers net out across the whole portfolio and inside a scope of several accounts (accountType), never for one
  // account. A scope of several accounts also reads the other listed non-credit accounts, Cash included, only to pair
  // transfer legs: TFSA1 -> Cash -> TFSA2 is a withdrawal and a deposit, not a transfer between the TFSAs. Only cash
  // transfers change deposits and withdrawals, and they are money movement, so the read is skipped when that is not in view.
  const netTransfers = ids === null || ids.size > 1;
  const outside = ids !== null && ids.size > 1 && categories.includes("moving_money")
    ? listed.filter((a) => !ids.has(a.id) && a.kind !== "credit") : [];
  // The symbol is matched here with symbolMatches, as holdings and income do (XEQT matches XEQT.TO), not by the
  // store's exact match, which get_symbol_history keeps (a bare symbol there reads its one listing in scope).
  const span = { from, to };
  const bySymbol = (list: StoredActivity[]) => (symbol ? list.filter((a) => symbolMatches(a.symbol ?? "", symbol)) : list);
  const readSpan = { from: minusDays(from, WITHHOLDING_READ_DAYS), to: minusDays(to, -WITHHOLDING_READ_DAYS) };
  const [read, states, matchOnly, outsideStates] = await Promise.all([
    inScope.length === 0 ? Promise.resolve([] as StoredActivity[])
      : deps.activities.queryActivities(userId, { accountIds: inScope.map((a) => a.id), ...readSpan }).then(bySymbol),
    Promise.all(inScope.map((a) => deps.activities.syncState(userId, a.id).catch(() => null))),
    outside.length === 0 ? Promise.resolve([] as StoredActivity[])
      : deps.activities.queryActivities(userId, { accountIds: outside.map((a) => a.id), ...span }).then(bySymbol),
    Promise.all(outside.map((a) => deps.activities.syncState(userId, a.id).catch(() => null))),
  ]);
  // A match-only account still backfilling may be missing the legs that keep routed money from netting, so it is
  // reported as syncing with the scope's own accounts (outside is empty for one account and for all accounts).
  const backfilling = (list: typeof inScope, st: typeof states) => list.filter((_, i) => !st[i] || st[i]!.backfillCompletedAt === null).map((a) => a.id);
  const syncing = [...backfilling(inScope, states), ...backfilling(outside, outsideStates)];

  const stored = read.filter((a) => rowDate(a) >= from && rowDate(a) <= to);
  const q = query?.toLowerCase();
  const described = new Map<StoredActivity, ReturnType<typeof describe>>();
  const matched = stored.filter((a) => {
    const account = kindOf.get(a.snapTradeAccountId);
    if (!account || !categories.includes(categoryOf(a, account.kind))) return false;
    const d = describe(a);
    described.set(a, d);
    if (!q) return true;
    return (a.symbol ?? "").toUpperCase().startsWith(q.toUpperCase()) || d.text.toLowerCase().includes(q);
  });

  const byType: Record<string, number> = {};
  for (const a of matched) { const t = a.type.toUpperCase(); byType[t] = (byType[t] ?? 0) + 1; }

  const remaining = before
    ? matched.filter((a) => { const d = rowDate(a); return d < before.date || (d === before.date && a.dedupeKey < before.key); })
    : matched;
  const pageRows = remaining.slice(0, ACTIVITY_PAGE_SIZE);
  const last = pageRows[pageRows.length - 1];
  const nextCursor = remaining.length > ACTIVITY_PAGE_SIZE && last ? encodeCursor(key, bound, { date: rowDate(last), key: last.dedupeKey }) : null;

  // One BoC fetch per page build, from the earliest USD row, bounded like the other market calls.
  const usdDates = matched.filter((a) => a.currency?.toUpperCase() === "USD" && a.amount !== null).map(rowDate).filter((d) => d !== "").sort();
  const usdCad = deps.market.usdCad?.bind(deps.market);
  const home: HomeConverter = usdDates.length === 0 || !usdCad
    ? homeConverter(null, today)
    : await withDeadline(
        () => loadHomeConverter({ usdCad }, usdDates[0], today),
        deps.marketDeadlineMs ?? DEFAULT_MARKET_DEADLINE_MS,
        () => homeConverter(null, today),
      );

  const rows: ActivityRow[] = pageRows.map((a) => {
    const account = kindOf.get(a.snapTradeAccountId)!;
    const d = described.get(a)!;
    const sign = SIGN_RULES.cashSign[a.type.toUpperCase()];
    const row: ActivityRow = {
      id: rowId(a.dedupeKey), date: rowDate(a), accountId: a.snapTradeAccountId, accountLabel: account.label,
      category: categoryOf(a, account.kind), type: a.type, symbol: a.symbol, description: d.text,
      units: a.units, price: a.price, priceCurrency: a.currency ?? a.securityCurrency,
      amount: a.amount === null || sign !== -1 ? a.amount : cashDelta(a.type, a.amount), currency: a.currency,
    };
    if (d.estimated) row.estimated = true;
    if (sign === 0) row.unsigned = true;
    if (row.amount !== null && Number.isFinite(row.amount) && row.currency !== null) row.home = home.at(row.amount, row.currency, row.date);
    return row;
  });

  const isCredit = (a: StoredActivity) => kindOf.get(a.snapTradeAccountId)?.kind === "credit";
  const { totals, homeTotals, flows } = computeTotals(matched.filter((a) => !isCredit(a)), { netTransfers, matchOnly, home, context: read.filter((a) => !isCredit(a)) });
  const credit = matched.filter((a) => isCredit(a) && (DEPOSITS.has(a.type.toUpperCase()) || WITHDRAWALS.has(a.type.toUpperCase()))).length;
  const page: ActivityPage = { ...base, rows, nextCursor, totals, homeTotals, counts: { total: matched.length, byType }, syncing };
  const spent = new Map<string, number>();
  for (const a of stored) {
    if (isCredit(a) || !SPENDING.has(a.type.toUpperCase()) || a.currency === null) continue;
    const currency = a.currency.toUpperCase();
    spent.set(currency, (spent.get(currency) ?? 0) - cashDelta(a.type, a.amount));
  }
  const spending = [...spent].filter(([, amount]) => amount > 0).sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ amount: cents(amount), currency }));
  return { page, facts: { scope: resolved.scope, ...flows, credit, ...(spending.length > 0 ? { spending } : {}) } };
}

/** Current brokerage units of `symbol` in `currency` across the given accounts (spec section 4 reconciliation). */
function reportedUnits(portfolio: PortfolioPresentation, accountIds: string[], symbol: string, currency: string | null): number | null {
  let units = 0;
  for (const a of portfolio.accounts) {
    if (!accountIds.includes(a.id)) continue;
    if (a.freshness?.holdingsUnavailable) return null;
    for (const p of a.positions ?? []) {
      if (p.cashEquivalent || p.units === null || !Number.isFinite(p.units)) continue;
      if (p.symbol.trim().toUpperCase() !== symbol) continue;
      if (currency !== null && (p.currency ?? "").toUpperCase() !== currency) continue;
      units += p.units;
    }
  }
  return units;
}

const finite = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

/**
 * Brokerage-reported figures for `symbol` in `currency` across the given accounts. Null when an
 * in-scope account's holdings are unavailable or nothing is held. A position without a cost basis
 * nulls the cost figures; one without a market value or price nulls the market value and return.
 */
function reportedFigures(portfolio: PortfolioPresentation, accountIds: string[], symbol: string, currency: string | null): ReportedFigures | null {
  let units = 0;
  let book = 0;
  let value = 0;
  let costKnown = true;
  let priceKnown = true;
  let held: string | null = null;
  let seen = false;
  for (const a of portfolio.accounts) {
    if (!accountIds.includes(a.id)) continue;
    if (a.freshness?.holdingsUnavailable) return null;
    for (const p of a.positions ?? []) {
      if (p.cashEquivalent || !finite(p.units) || Math.abs(p.units) <= UNITS_EPS) continue;
      if (p.symbol.trim().toUpperCase() !== symbol) continue;
      const own = p.currency?.trim().toUpperCase() || null;
      if (currency !== null && own !== currency) continue;
      // Without a group currency, the first matching position's currency decides: never sum mixed currencies.
      if (currency === null && seen && own !== held) continue;
      if (!seen) { seen = true; held = own; }
      units += p.units;
      if (finite(p.costBasis)) book += p.units * p.costBasis; else costKnown = false;
      // The brokerage's market value wins; otherwise units × price.
      if (finite(p.marketValue)) value += p.marketValue;
      else if (finite(p.price)) value += p.units * p.price;
      else priceKnown = false;
    }
  }
  if (units <= UNITS_EPS) return null;
  const bookCost = costKnown ? book : null;
  const marketValue = priceKnown ? value : null;
  const totalReturn = bookCost !== null && marketValue !== null ? marketValue - bookCost : null;
  return {
    units,
    avgCost: bookCost === null ? null : bookCost / units,
    bookCost,
    marketValue,
    totalReturn,
    totalReturnFraction: totalReturn !== null && bookCost !== null && bookCost > 0 ? totalReturn / bookCost : null,
    currency: held ?? currency,
  };
}

/** Cost-history gate: the replayed line is shown only when today's replayed average reconciles with the reported one. */
function gateCostHistory(position: SymbolPosition, reported: ReportedFigures | null): { position: SymbolPosition; costHistory: SymbolHistory["costHistory"] } {
  const target = reported?.avgCost ?? null;
  if (target === null || !(target > 0)) return { position, costHistory: "unverified" };
  const today = position.points.length > 0 ? position.points[position.points.length - 1].avgCost : null;
  if (today !== null && Math.abs(today - target) / target <= COST_HISTORY_TOLERANCE) return { position, costHistory: "matches" };
  return { position: { ...position, points: position.points.map((p) => ({ ...p, avgCost: null })) }, costHistory: "unavailable" };
}

/**
 * Price sanity guard inputs: whether any current in-scope position of `symbol` (in `currency` when
 * known) has a kind outside stock/ETF/crypto, and the first usable reported price in that currency.
 */
function reportedPriceInfo(portfolio: PortfolioPresentation, accountIds: string[], symbol: string, currency: string | null): { untrustedKind: boolean; price: number | null } {
  let untrustedKind = false;
  let price: number | null = null;
  for (const a of portfolio.accounts) {
    if (!accountIds.includes(a.id)) continue;
    for (const p of a.positions ?? []) {
      if (p.cashEquivalent || p.symbol.trim().toUpperCase() !== symbol) continue;
      if (currency !== null && (p.currency ?? "").toUpperCase() !== currency) continue;
      if (p.units === null || !(p.units > 0)) continue;
      if (!isTrustedPriceKind(p.kind ?? "")) untrustedKind = true;
      if (price === null && p.price !== null && p.price !== undefined && Number.isFinite(p.price) && p.price > 0) price = p.price;
    }
  }
  return { untrustedKind, price };
}

/**
 * The symbol get_symbol_history reads: as given when it was traded or is held in scope, else the one other form of it
 * traded or held there, by symbolMatches as show_activity matches it (XEQT -> XEQT.TO, or XEQT.TO -> a bare XEQT).
 * With none, or several (XEQT.TO and XEQT.NE), the symbol stays as given.
 */
async function resolveListing(
  deps: ActivityDeps, portfolio: PortfolioPresentation, userId: string | null, accountIds: string[], symbol: string, to: string,
  exact: StoredActivity[],
): Promise<{ symbol: string; stored: StoredActivity[] }> {
  const upper = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();
  const held = portfolio.accounts.filter((a) => accountIds.includes(a.id)).flatMap((a) => (a.positions ?? []).map((p) => upper(p.symbol)));
  if (exact.length > 0 || held.includes(symbol)) return { symbol, stored: exact };
  const traded = userId && accountIds.length > 0
    ? await deps.activities.queryActivities(userId, { accountIds, from: ALL_TIME_FROM, to })
    : [];
  const listings = [...new Set([...held, ...traded.map((a) => upper(a.symbol))])].filter((s) => s !== symbol && symbolMatches(s, symbol));
  if (listings.length !== 1) return { symbol, stored: exact };
  return { symbol: listings[0]!, stored: traded.filter((a) => upper(a.symbol) === listings[0]) };
}

export async function buildSymbolHistory(
  deps: ActivityDeps, portfolio: PortfolioPresentation, authSubject: string, input: SymbolHistoryInput,
): Promise<SymbolHistory> {
  const today = torontoDate.format((deps.now ?? (() => new Date()))());
  const period = input.period ?? "ALL";
  const asGiven = input.symbol.trim().toUpperCase();
  const listed = listAccounts(portfolio);
  if (input.accountId !== undefined && !listed.some((a) => a.id === input.accountId)) throw new ActivityScopeError("unknown_account", UNKNOWN_ACCOUNT_TEXT);
  const inScope = listed.filter((a) => (input.accountId === undefined ? a.kind !== "credit" : a.id === input.accountId));

  const userId = await deps.activities.userId(authSubject);
  const exact = userId && inScope.length > 0
    ? await deps.activities.queryActivities(userId, { accountIds: inScope.map((a) => a.id), from: ALL_TIME_FROM, to: today, symbol: asGiven })
    : [];
  const { symbol, stored } = await resolveListing(deps, portfolio, userId, inScope.map((a) => a.id), asGiven, today, exact);

  const groups = [...groupBySymbolCurrency(stored).entries()].filter(([k]) => k.split("|")[0] === symbol).map(([k, rows]) => ({ currency: k.split("|")[1] || null, rows }));
  groups.sort((a, b) => b.rows.length - a.rows.length || (a.currency ?? "").localeCompare(b.currency ?? ""));
  const chosen = groups[0];
  const otherCurrencies = [...new Set(groups.slice(1).map((g) => g.currency).filter((c): c is string => !!c && c !== chosen?.currency))].sort();
  const rows = chosen?.rows ?? [];

  let prices: SymbolHistory["prices"] = [];
  let allPrices: SymbolHistory["prices"] = [];
  let splits: Array<{ date: string; ratio: number }> = [];
  let priceUnavailable = true;
  const ticker = rows.length > 0 ? providerTicker({ symbol, kind: "stock", currency: chosen!.currency }) : null;
  if (ticker) {
    const firstDate = rows.map(rowDate).filter(Boolean).sort()[0] ?? today;
    // Always from the first activity so every split in the holding span is known.
    const fetchFrom = minusDays(firstDate, 10);
    const history = await withDeadline(() => deps.market.securityHistory(ticker, fetchFrom, today), deps.marketDeadlineMs ?? DEFAULT_MARKET_DEADLINE_MS, () => null);
    // Without a split list the closes cannot be trusted to be split-adjusted, so no price line.
    if (history && !history.notFound && history.splits && history.points.length > 0) {
      const list = history.splits.filter((s) => s.ratio > 0 && Number.isFinite(s.ratio));
      splits = list;
      allPrices = history.points.map((p) => ({
        date: p.date,
        close: p.close * list.filter((s) => s.date > p.date).reduce((acc, s) => acc * s.ratio, 1),
      })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      prices = period === "1Y" ? allPrices.filter((p) => p.date >= minusMonths(today, 12)) : allPrices;
      priceUnavailable = false;
    }
  }
  const marketPrice = (date: string): number | null => {
    let lo = 0;
    let hi = allPrices.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (allPrices[mid].date <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found < 0 ? null : allPrices[found].close;
  };
  const currency = chosen?.currency ?? null;
  // Price sanity guard: a non-trusted kind, or a latest close more than 50% off the reported price,
  // means the provider history belongs to another security. No price line; transfers use the reported price.
  const reportedInfo = reportedPriceInfo(portfolio, inScope.map((a) => a.id), symbol, currency);
  const latestClose = allPrices.length > 0 ? allPrices[allPrices.length - 1].close : null;
  const guarded = rows.length > 0 && (reportedInfo.untrustedKind
    || (latestClose !== null && reportedInfo.price !== null && priceOutOfRange(latestClose / reportedInfo.price)));
  if (guarded) { prices = []; priceUnavailable = true; }
  // Trade prices are in the row currency: convert those of another currency at the day's USD/CAD (brief 8).
  const crossCurrency = rows.some((r) => {
    const own = r.currency?.trim().toUpperCase() || null;
    const sec = (r.securityCurrency ?? currency)?.trim().toUpperCase() || null;
    return own !== null && sec !== null && own !== sec && r.price !== null;
  });
  const settings = await loadSettings(deps as Parameters<typeof loadSettings>[0], authSubject);
  const wantsUsd = settings.cadView && rows.some((r) => [r.currency, r.securityCurrency ?? currency].some((c) => c?.trim().toUpperCase() === "USD"));
  let fx: Array<{ date: string; close: number }> | null = null;
  if ((crossCurrency || wantsUsd) && deps.market.usdCad) {
    const firstDate = rows.map(rowDate).filter(Boolean).sort()[0] ?? today;
    const usdCad = deps.market.usdCad.bind(deps.market);
    fx = await withDeadline(() => usdCad(minusDays(firstDate, 10), today), deps.marketDeadlineMs ?? DEFAULT_MARKET_DEADLINE_MS, () => null).catch(() => null);
  }
  const priceAt = guarded ? () => reportedInfo.price : marketPrice;
  const toSecurity = tradePriceConverter(fx);
  // Dividends are netted over all of the symbol's rows: a TAX row can land in another currency group than its dividend.
  const replayed = symbolPosition(rows, splits, priceAt, currency, toSecurity, stored);
  const groupCurrency = currency ?? replayed.currency;
  const scopeIds = inScope.map((a) => a.id);
  const reported = reportedFigures(portfolio, scopeIds, symbol, groupCurrency);
  const { position, costHistory } = gateCostHistory(replayed, reported);
  const homeGains = settings.cadView
    ? computeHomeGains({ rows, splits, priceAt, toSecurity, home: homeConverter(fx, today), portfolio, scopeIds, symbol, currency: groupCurrency })
    : null;

  return {
    symbol, name: null, currency: groupCurrency, period, prices, priceUnavailable,
    position, reportedUnits: reportedUnits(portfolio, scopeIds, symbol, groupCurrency), reported, costHistory, homeGains, otherCurrencies, asOf: portfolio.generatedAt,
  };
}

interface GainsInput {
  rows: StoredActivity[]; splits: Array<{ date: string; ratio: number }>; priceAt: (date: string) => number | null;
  toSecurity: ToSecurityCurrency; home: HomeConverter; portfolio: PortfolioPresentation; scopeIds: string[]; symbol: string; currency: string | null;
}
type AccountGains = { realized: number; unrealized: { amount: number; estimated: boolean } | null } | null;

/**
 * One account's CAD gains, or null when the gate fails (spec 6.4). Open position: replayed units
 * within 0.5% of reported; for a USD security the book-cost currency is decided here, per account,
 * from reported cost basis ÷ replayed USD average (provider-probe method): near 1 → branch A (CAD
 * cost = CAD replay), near today's USD/CAD → branch B (CAD cost = reported cost basis × units,
 * exact, with the CAD replay within 3%), otherwise unavailable. Fully sold: replayed units reach
 * zero with a complete history (no cost-less transfer-in); the branch does not matter.
 */
function accountHomeGains(input: GainsInput, accountId: string): AccountGains {
  const { rows, splits, home, portfolio, symbol, currency } = input;
  const replay = homeCostReplay(rows, splits, home, accountId, symbol);
  const held = reportedUnits(portfolio, [accountId], symbol, currency);
  if (held === null || !replay.complete) return null;
  if (held <= UNITS_EPS) return replay.units <= UNITS_EPS ? { realized: replay.realizedCad, unrealized: null } : null;
  if (Math.abs(replay.units - held) / held > GAINS_UNITS_TOLERANCE) return null;
  const rep = reportedFigures(portfolio, [accountId], symbol, currency);
  if (!rep || rep.marketValue === null || rep.avgCost === null || rep.bookCost === null || replay.costCad === null || replay.avgCostCad === null) return null;
  const securityCurrency = (currency ?? rep.currency)?.trim().toUpperCase() ?? "";
  const value = home.at(rep.marketValue, securityCurrency);
  if (value.amount === null) return null;

  let cost: number;
  let costEstimated: boolean;
  if (securityCurrency === "USD") {
    const own = rows.filter((r) => r.snapTradeAccountId === accountId);
    const usdAvg = symbolPosition(own, splits, input.priceAt, securityCurrency, input.toSecurity).avgCost;
    if (usdAvg === null || !(usdAvg > 0)) return null;
    const ratio = rep.avgCost / usdAvg;
    const usdCad = home.latest?.rate ?? null;
    if (Math.abs(ratio - 1) <= COST_BASIS_CURRENCY_BAND) {
      cost = replay.costCad;
      costEstimated = replay.estimated;
    } else if (usdCad !== null && Math.abs(ratio / usdCad - 1) <= COST_BASIS_CURRENCY_BAND) {
      if (Math.abs(replay.avgCostCad - rep.avgCost) / rep.avgCost > GAINS_CAD_COST_TOLERANCE) return null;
      cost = cents(rep.bookCost);
      costEstimated = false;
    } else {
      return null;
    }
  } else {
    cost = replay.costCad;
    costEstimated = replay.estimated;
  }
  return { realized: replay.realizedCad, unrealized: { amount: cents(value.amount - cost), estimated: value.estimated || costEstimated } };
}

/** Sums per-account CAD gains; any failing account makes the combined figure unavailable. */
function computeHomeGains(input: GainsInput): NonNullable<SymbolHistory["homeGains"]> {
  const withRows = new Set(input.rows.map((r) => r.snapTradeAccountId));
  const accounts = input.scopeIds.filter((id) => withRows.has(id) || (reportedUnits(input.portfolio, [id], input.symbol, input.currency) ?? 0) > UNITS_EPS);
  let realized: number | null = null;
  let unrealized = 0;
  let unrealizedEstimated = false;
  let anyHeld = false;
  for (const id of accounts) {
    const g = accountHomeGains(input, id);
    if (g === null) return { realized: null, unrealized: null, unavailable: true };
    realized = cents((realized ?? 0) + g.realized);
    if (g.unrealized) {
      anyHeld = true;
      unrealized = cents(unrealized + g.unrealized.amount);
      if (g.unrealized.estimated) unrealizedEstimated = true;
    }
  }
  return {
    realized: realized === null ? null : { amount: realized, estimated: true },
    unrealized: anyHeld ? { amount: unrealized, estimated: unrealizedEstimated } : null,
    unavailable: false,
  };
}

const CATEGORY_NAMES: Record<ActivityCategory, string> = { investing: "investing", moving_money: "money movement", cash: "cash and spending" };
const CATEGORY_ORDER: ActivityCategory[] = ["investing", "moving_money", "cash"];
function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
const SUMMARY_GROUPS: Array<{ label: [string, string]; types: string[] }> = [
  { label: ["buy", "buys"], types: ["BUY"] },
  { label: ["sell", "sells"], types: ["SELL"] },
  { label: ["dividend", "dividends"], types: ["DIVIDEND", "DISTRIBUTION", "REI", "REINVEST"] },
  { label: ["deposit", "deposits"], types: ["CONTRIBUTION", "DEPOSIT", "INTERNAL_CASH_TRANSFER_IN"] },
  { label: ["withdrawal", "withdrawals"], types: ["WITHDRAWAL", "INTERNAL_CASH_TRANSFER_OUT"] },
  { label: ["fee transaction", "fee transactions"], types: ["FEE"] },
];

const FIRST_SENTENCE_MAX = 300;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const moneyList = (items: Array<{ amount: number; currency: string }>) => items.map((i) => formatMoney(i.amount, i.currency)).join(" + ");

/** Scope words when the caller has no resolver facts: the payload's own filters. */
function fallbackScope(page: ActivityPage): string {
  const { accountId, accountType } = page.filters;
  if (accountType !== undefined) return accountId !== undefined ? "in one account" : "in several accounts";
  return accountId !== undefined ? `in ${page.accounts.find((a) => a.id === accountId)?.label ?? "one account"}` : "across all accounts";
}

/**
 * "; deposits {X}, withdrawals {Y}" from the payload's per-currency totals: native amounts as reported, never converted
 * (homeTotals carries no CAD deposits or withdrawals). Withdrawals read as positive amounts out. Rows left out of the
 * totals (transfers netted inside the scope, unknown amounts, credit accounts) are named in the same sentence, and so
 * are spending and card payments, which leave the account but aren't withdrawals, whenever withdrawals or cash rows are in view.
 */
function flowClause(page: ActivityPage, facts: ActivityFlowFacts): string {
  const deposits = page.totals.filter((t) => t.deposits !== 0).map((t) => ({ amount: t.deposits, currency: t.currency }));
  const withdrawals = page.totals.filter((t) => t.withdrawals !== 0).map((t) => ({ amount: cents(-t.withdrawals), currency: t.currency }));
  const notes: string[] = [];
  if (facts.unknownDeposits > 0) notes.push(`${plural(facts.unknownDeposits, "deposit amount", "deposit amounts")} unknown`);
  if (facts.unknownWithdrawals > 0) notes.push(`${plural(facts.unknownWithdrawals, "withdrawal amount", "withdrawal amounts")} unknown`);
  if (facts.credit > 0) notes.push(`${plural(facts.credit, "credit-account row", "credit-account rows")} left out`);
  if (facts.netted > 0) notes.push("transfers between these accounts left out");
  if (facts.spending && (withdrawals.length > 0 || page.filters.categories.includes("cash"))) notes.push(`${moneyList(facts.spending)} of spending and card payments not counted as withdrawals`);
  if (deposits.length === 0 && withdrawals.length === 0 && notes.length === 0) return "";
  const sides = [
    ...(deposits.length > 0 ? [`deposits ${moneyList(deposits)}`] : []),
    ...(withdrawals.length > 0 ? [`withdrawals ${moneyList(withdrawals)}`] : []),
  ];
  return `; ${sides.length > 0 ? sides.join(", ") : "no deposit or withdrawal amounts"}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
}

/**
 * Answer first (spec D5): the count and scope ("in your TFSAs", "in {account name}", "across all accounts", plus
 * "for {SYMBOL}"), the date range, the counts by kind, then deposits and withdrawals when the totals carry them. No ids.
 * The counts by kind are dropped when the first sentence would reach 300 characters. `facts` comes from
 * buildActivityResult; without it the scope is read from the payload's filters.
 */
export function activityText(page: ActivityPage, options: { show?: boolean; facts?: ActivityTextFacts } = {}): string {
  const { filters, counts } = page;
  const facts = options.facts ?? { scope: fallbackScope(page), netted: 0, unknownDeposits: 0, unknownWithdrawals: 0, credit: 0 };
  const year = page.asOf.slice(0, 4);
  const names = joinNames(CATEGORY_ORDER.filter((c) => filters.categories.includes(c)).map((c) => CATEGORY_NAMES[c]));
  const where = `${facts.scope}${filters.symbol ? ` for ${filters.symbol}` : ""}`;
  const range = `from ${shortDate(filters.from, year)} to ${shortDate(filters.to, year)}`;
  let text: string;
  if (counts.total === 0) {
    text = `No ${names} activities ${where} ${range}.`;
  } else {
    const parts: string[] = [];
    for (const g of SUMMARY_GROUPS) {
      const n = g.types.reduce((s, t) => s + (counts.byType[t] ?? 0), 0);
      if (n > 0) parts.push(`${n} ${g.label[n === 1 ? 0 : 1]}`);
    }
    const head = `${counts.total} ${names} ${counts.total === 1 ? "activity" : "activities"} ${where} ${range}`;
    const money = flowClause(page, facts);
    text = `${head}${parts.length ? `: ${parts.join(", ")}` : ""}${money}.`;
    if (text.length >= FIRST_SENTENCE_MAX) text = `${head}${money}.`;
  }
  const unmatched = page.totals.filter((t) => t.unmatchedWithholding && t.unmatchedWithholding.amount > 0);
  if (unmatched.length > 0) text += ` ${moneyList(unmatched.map((t) => ({ amount: t.unmatchedWithholding!.amount, currency: t.currency })))} of withholding tax matches no dividend and is not deducted.`;
  return options.show ? `${text} Showing the activity widget.` : text;
}

/** Compact copy for the model: filters, totals, counts and the ten most recent descriptions with dates. */
export function activityModelCopy(page: ActivityPage) {
  const { accountId, ...rest } = page.filters;
  const accountLabel = accountId === undefined ? undefined : page.accounts.find((a) => a.id === accountId)?.label;
  // CAD figures and the CAD note follow the switch: with it off the screen shows native currencies.
  const cad = page.settings.cadView;
  return {
    filters: { ...rest, ...(accountLabel ? { accountLabel } : {}) },
    totals: page.totals,
    ...(cad ? { homeTotals: page.homeTotals } : {}),
    notes: {
      ...(cad ? { cad: CAD_NOTE } : {}),
      dividends: "dividends is net of withholding tax (TAX/WITHHOLDING rows of the same account and symbol within 3 days, read beyond the date range and search): dividendsGross + withholding. unmatchedWithholding is withholding that matches no dividend and is not deducted.",
      transfers: "deposits and withdrawals exclude internal transfers between two of your accounts in this view.",
      withdrawals: "withdrawals counts WITHDRAWAL rows and outgoing internal transfers only. Spending and credit card payments out of a Cash account are not in it, though they are money out and Performance counts them.",
      feeTransactions: "feeTransactions counts FEE rows only; FX conversion spreads and other built-in costs are not included.",
    },
    counts: page.counts,
    recent: page.rows.slice(0, 10).map((r) => ({
      date: r.date, description: r.description,
      ...(r.units !== null ? { units: Math.abs(r.units) } : {}),
      ...(r.price !== null ? { price: r.price, priceCurrency: r.priceCurrency } : {}),
    })),
    hasMore: page.nextCursor !== null,
  };
}

/** Text for get_symbol_history: counts buy/sell trades only. */
export function symbolHistoryText(h: SymbolHistory): string {
  const n = h.position.markers.length;
  return `Loaded ${h.symbol} history: ${n} ${n === 1 ? "trade" : "trades"}.`;
}

/**
 * Compact copy for the model (F5): the tiles' figures and a trade count; no daily prices, points or
 * markers. Brokerage-reported figures win; the replayed average is offered only as an estimate when
 * nothing is reported. Dividends are from activity, net of withholding as in show_activity.
 */
export function symbolHistoryModelCopy(h: SymbolHistory) {
  const p = h.position;
  return {
    symbol: h.symbol, currency: h.currency, period: h.period, units: h.reported?.units ?? p.units, reportedUnits: h.reportedUnits,
    // The brokerage's average cost when reported; otherwise the replayed one, which is an estimate.
    avgCost: h.reported ? h.reported.avgCost : p.avgCost, avgCostEstimated: h.reported ? false : p.avgCostEstimated,
    reported: h.reported, costHistory: h.costHistory,
    ...(h.homeGains ? { homeGains: h.homeGains } : {}),
    notes: {
      dividends: "dividends and otherDividends are net of withholding tax with a reinvested dividend counted once, the figure show_activity gives for this symbol. unmatchedWithholding is withholding that matches no dividend and is not deducted.",
      ...(h.homeGains ? {
        homeGains: "homeGains are in CAD and est.: an average-cost replay per account, with USD amounts converted at the Bank of Canada rate on each trade date and market value at the latest rate. Unrealized includes currency movement since purchase. When unavailable, the activity history does not reconcile with the brokerage (realized gain unavailable: history incomplete). The brokerage-reported figures in reported stay in their own currency.",
      } : {}),
    },
    dividends: p.dividends, otherDividends: p.otherDividends, ...(p.unmatchedWithholding ? { unmatchedWithholding: p.unmatchedWithholding } : {}),
    trades: p.markers.length, priceUnavailable: h.priceUnavailable,
  };
}

const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const security = [{ type: "oauth2" as const, scopes: ["portfolio:read"] }];

const QUERY_NOTE = "A word or short phrase to find in a row's symbol or description, such as a payee. Never the user's question or a summary of it.";
const dateProperty = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;
const filterProperties = {
  ...accountFilterProperties,
  categories: { type: "array", items: { type: "string", enum: [...ACTIVITY_CATEGORIES] }, minItems: 1, maxItems: ACTIVITY_CATEGORIES.length },
  symbol: symbolProperty,
  from: dateProperty,
  to: dateProperty,
  query: { type: "string", maxLength: 1000, description: QUERY_NOTE },
} as const;

const pageOutputSchema = {
  type: "object",
  properties: {
    rows: { type: "array" }, nextCursor: { type: ["string", "null"] }, restarted: { type: "boolean" }, totals: { type: "array" }, homeTotals: { type: "object" },
    counts: { type: "object" }, filters: { type: "object" }, accounts: { type: "array" }, syncing: { type: "array" },
    settings: { type: "object" }, asOf: { type: "string" },
  },
  required: ["rows", "nextCursor", "restarted", "totals", "homeTotals", "counts", "filters", "accounts", "syncing", "settings", "asOf"],
  additionalProperties: false,
} as const;

const symbolOutputSchema = {
  type: "object",
  properties: {
    symbol: { type: "string" }, name: { type: ["string", "null"] }, currency: { type: ["string", "null"] }, period: { type: "string", enum: ["1Y", "ALL"] },
    prices: { type: "array" }, priceUnavailable: { type: "boolean" }, position: { type: "object" }, reportedUnits: { type: ["number", "null"] },
    reported: {
      type: ["object", "null"],
      properties: {
        units: { type: ["number", "null"] }, avgCost: { type: ["number", "null"] }, bookCost: { type: ["number", "null"] },
        marketValue: { type: ["number", "null"] }, totalReturn: { type: ["number", "null"] }, totalReturnFraction: { type: ["number", "null"] },
        currency: { type: ["string", "null"] },
      },
      required: ["units", "avgCost", "bookCost", "marketValue", "totalReturn", "totalReturnFraction", "currency"],
      additionalProperties: false,
    },
    costHistory: { type: "string", enum: ["matches", "unavailable", "unverified"] },
    homeGains: { type: ["object", "null"] },
    otherCurrencies: { type: "array" }, asOf: { type: "string" },
  },
  required: ["symbol", "name", "currency", "period", "prices", "priceUnavailable", "position", "reportedUnits", "reported", "costHistory", "homeGains", "otherCurrencies", "asOf"],
  additionalProperties: false,
} as const;

const SCOPE_NOTE = "Covers investing, money movement and cash and spending activity for the user's accounts. Read-only.";

export const activityToolDefinitions = [
  {
    name: "show_activity",
    title: "Show activity",
    description: "Use this when the user asks to see their trades, transactions, dividends, deposits, account activity or history, or what they did with a specific symbol (for example \"show my history with ATZ\"): it renders the interactive activity feed and returns a summary. Call it once per question. With a symbol and no from date it covers the full history; without a symbol it covers the last 90 days. For how much the user has contributed to or withdrawn from a TFSA over time, use get_contribution_room instead. Filter with accountType or accountId, symbol, categories and from/to dates. Read-only.",
    inputSchema: { type: "object", properties: filterProperties, additionalProperties: false },
    outputSchema: pageOutputSchema,
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    _meta: {
      securitySchemes: security, ui: { resourceUri: ACTIVITY_WIDGET_URI }, "openai/outputTemplate": ACTIVITY_WIDGET_URI,
      "openai/widgetAccessible": true, "openai/toolInvocation/invoking": "Loading activity…", "openai/toolInvocation/invoked": "Activity ready.",
    },
  },
  {
    name: "get_activity_page",
    title: "Get activity page",
    description: `Used by the activity widget to filter, search and page through activity. ${SCOPE_NOTE}`,
    inputSchema: { type: "object", properties: { ...filterProperties, cursor: { type: "string", maxLength: 1024 } }, additionalProperties: false },
    outputSchema: pageOutputSchema,
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    _meta: { securitySchemes: security, ui: { visibility: ["app"] } },
  },
  {
    name: "get_symbol_history",
    title: "Get symbol history",
    description: `Used by the activity widget for one symbol: price history and trades from the user's activity, with brokerage-reported units, average cost, book cost and total return. Read-only.`,
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", minLength: 1, maxLength: 40 }, accountId: { type: "string", minLength: 1 }, period: { type: "string", enum: ["1Y", "ALL"] } },
      required: ["symbol"],
      additionalProperties: false,
    },
    outputSchema: symbolOutputSchema,
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    _meta: { securitySchemes: security, ui: { visibility: ["app"] } },
  },
] as const;
