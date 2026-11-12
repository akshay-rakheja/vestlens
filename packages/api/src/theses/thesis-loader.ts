import { z } from "zod";

import { exposureNetOfMargin, holdingWeights, type ExposureCash, type ExposureItem } from "../analytics/exposure.js";
import { isInvestable } from "../analytics/holdings.js";
import { benchmarkClosesCad, holdingFlows, type BenchmarkClose, type HoldingFlow } from "../analytics/shadow-benchmark.js";
import { homeConverter, loadHomeConverter, type HomeConverter } from "../fx/home-currency.js";
import type { StoredActivity } from "../history/stored-activity.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import { accountKey } from "../memory/keys.js";
import type { MemoryService } from "../memory/memory-service.js";
import type { ThesisBaseline } from "../memory/memory-types.js";
import { readTheses, readThesisBaseline, type PortfolioFactsSource } from "../memory/portfolio-facts.js";
import { levelFor, RELEVANT_MIN } from "../news/scoring.js";
import type { NewsStore } from "../news/store.js";
import { managedNotInTotal, type PortfolioPresentation, type PortfolioPresentationAccount } from "../portfolio/portfolio-presentation.js";
import { activitySynced, positionsAsOfDay, positionsAsOfInstant, PRICE_STALE_TRADING_DAYS, torontoDay, tradingDaysBetween } from "../portfolio/data-freshness.js";
import { benchmarkFetchFrom } from "../analytics/value-series.js";
import {
  ACTIVITY_NOT_LOADED, ACTIVITY_NOT_RECORDED, ACTIVITY_STALE_DAYS, activityStaleNote, checkHolding, checkThesis, CHECKED_IN_FULL_VIEW, HOLDING_NEWS_DAYS, UNITS_NOT_REPORTED, type HoldingInput, type ThesisInput,
  type ThesisNewsItem,
} from "./thesis-check.js";
import { unitsDelta } from "../history/sign-rules.js";

/**
 * Reads one thesis check's inputs for one auth subject (spec 2026-10-24 §5.2, §8, §11a.1-4), from stored data and the
 * cached market data the performance view uses; no brokerage read. Every query is keyed by the auth subject.
 *
 * - The holding is the ticker as held (the memory node key), in included, open, non-credit accounts only. Accounts
 *   "involved" are those holding it now or with stored activity in it.
 * - Price, end value and weight come from the latest snapshot positions (`deps.portfolio`), each converted at its own
 *   positions date. The weight needs every counted account's positions date (the oldest is its as-of date) and a
 *   value for every holding position.
 * - The end value needs every involved account's activity synced at least once, with no error. Its age is not a gate
 *   (2026-10-25 owner ruling): the units check below catches a trade missing from the flows, and a shown return
 *   carries "Based on activity up to <date>" (the oldest involved account's last sync). Activity more than
 *   ACTIVITY_STALE_DAYS old is not used (a sync that stopped without an error would miss dividends).
 * - Units reconcile (final review I-2): the start units plus the units every stored activity since moved (buys,
 *   sales, transfers, reinvested dividends, and splits or corporate actions as reported) must equal the units held now,
 *   within 1e-6 relative. Otherwise activity the brokerage posted after the positions is missing, and the end is unknown
 *   ("recent activity hasn't been recorded yet"). A unit-moving row with no units (a split, a corporate action) fails it.
 * - Sold in full is never inferred from absence. With no position left, the end is 0 on the last flow date only when
 *   every involved account's positions are fresh, its activity synced within 48 hours with no error, and the start
 *   units plus the units of the flows since net to zero. Otherwise the end and the weight are unknown.
 * - The start value prefers the server-written `security.thesis_baseline` when it is for this thesis version, its
 *   positions are within PRICE_STALE_TRADING_DAYS Toronto weekdays of writtenAt, it saw every involved account that
 *   existed then, its listing matches, coverage reaches its date, and no holding activity falls between its oldest
 *   positions date and an account's own (newer) one. Otherwise it is the holding's value in the first
 *   snapshot of each involved account whose positions are as of `writtenAt` or later, within 3 trading days; split
 *   days with a move between them, or an involved account without one, give no start value (Review Focus 2).
 *   Snapshots are kept 90 days, which is why the baseline exists.
 * - Flows are the holding's stored activity from the start's date on, with reinvested dividends paired away.
 *   Coverage is the latest first-trade date of the involved accounts, once all their backfills finished. A sync error
 *   (`lastError`) on an involved account is passed as `syncError`; `dirty` is ignored (controller ruling).
 * - USD converts at the Bank of Canada rate on each date (est.).
 */

export type DecimalLike = number | string | { toString(): string } | null;
export type ActivityRow = {
  snapTradeAccountId: string; dedupeKey: string; type: string; symbol: string | null; securityCurrency: string | null; isOption: boolean;
  units: DecimalLike; price: DecimalLike; amount: DecimalLike; fee: DecimalLike; fxRate: DecimalLike; currency: string | null;
  tradeDate: Date | null; settlementDate: Date | null;
};
type SnapshotRow = { snapTradeAccountId: string; positionsAsOf: Date | null; capturedAt: Date; payload: unknown };
type SyncRow = { snapTradeAccountId: string; backfillCompletedAt: Date | null; earliestTradeDate: Date | null; lastSyncedAt: Date | null; lastError: string | null };

export interface ThesisPrismaPort {
  activity: {
    findMany(input: {
      where: { appUser: { authSubject: string }; symbol: { equals: string; mode: "insensitive" } };
      orderBy: Array<{ tradeDate: "asc" } | { dedupeKey: "asc" }>;
      select: {
        snapTradeAccountId: true; dedupeKey: true; type: true; symbol: true; securityCurrency: true; isOption: true; units: true; price: true;
        amount: true; fee: true; fxRate: true; currency: true; tradeDate: true; settlementDate: true;
      };
    }): Promise<ActivityRow[]>;
    /** The distinct symbols of the subject's stored activity in some accounts (resolving a past holding's ticker). */
    findMany(input: {
      where: { appUser: { authSubject: string }; snapTradeAccountId: { in: string[] }; isOption: false };
      distinct: ["symbol"];
      select: { symbol: true };
    }): Promise<Array<{ symbol: string | null }>>;
  };
  activitySyncState: {
    findMany(input: {
      where: { appUser: { authSubject: string } };
      select: { snapTradeAccountId: true; backfillCompletedAt: true; earliestTradeDate: true; lastSyncedAt: true; lastError: true };
    }): Promise<SyncRow[]>;
  };
  /** When each account was connected, to tell an account that did not exist at writtenAt from one a baseline missed. */
  brokerageAccount: {
    findMany(input: { where: { appUser: { authSubject: string } }; select: { snapTradeAccountId: true; createdAt: true } }): Promise<Array<{ snapTradeAccountId: string; createdAt: Date }>>;
  };
  portfolioSnapshot: {
    findMany(input: {
      where: { appUser: { authSubject: string }; capturedAt: { gte: Date; lte: Date } };
      orderBy: { capturedAt: "asc" };
      select: { snapTradeAccountId: true; positionsAsOf: true; capturedAt: true; payload: true };
    }): Promise<SnapshotRow[]>;
  };
}

export interface ThesisLoaderDeps {
  memory: PortfolioFactsSource;
  /** The latest stored portfolio (snapshot positions); never a brokerage refresh. */
  portfolio: (authSubject: string) => Promise<PortfolioPresentation>;
  prisma: ThesisPrismaPort;
  news: Pick<NewsStore, "articlesForSymbols" | "ratingsFor" | "events">;
  market: Pick<MarketDataService, "history" | "usdCad">;
  /**
   * Optional: a Bank of Canada converter and S&P 500 / TSX closes (CAD) the caller already loaded, covering every date
   * this view reads (from before the earliest stored activity to today). Used in place of this view's own reads, so a
   * caller checking many holdings reads each series once (the report card). Without it, behaviour is unchanged.
   */
  shared?: { fx: HomeConverter; benchmarks: { sp500: BenchmarkClose[] | null; tsx: BenchmarkClose[] | null } };
}

export interface ThesisBaselineDeps {
  memory: Pick<MemoryService, "remember">;
  portfolio: (authSubject: string) => Promise<PortfolioPresentation>;
  market: Pick<MarketDataService, "usdCad">;
}

const calendarDay = (d: Date | null): string | null => (d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null);
const upper = (s: string) => s.trim().toUpperCase();
const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const toNumber = (v: DecimalLike): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(typeof v === "number" ? v : v.toString());
  return Number.isFinite(n) ? n : null;
};
const cents = (n: number) => Math.round(n * 100) / 100;
const minDay = (a: string, b: string) => (a < b ? a : b);
/** Calendar days fetched after `writtenAt` for start snapshots: 3 trading days plus a weekend and the UTC/Toronto edge. */
const START_WINDOW_DAYS = 8;
const REINVEST_TOLERANCE = 0.01;
/** Start units plus the units since must match the units held now within this, relative (absolute below one unit). */
const UNITS_EPS = 1e-6;
/** Rows whose units move the position, as reported (sign-rules for trades, transfers and reinvests; others as given). */
const TRADE_UNIT_TYPES = new Set(["BUY", "SELL", "TRANSFER", "REINVEST", "REI"]);
const OTHER_UNIT_TYPES = new Set(["SPLIT", "REVERSE_SPLIT", "STOCK_DIVIDEND", "CORPORATE_ACTION"]);

/**
 * The units this holding's stored activity moved after `startDate` (raw rows: a reinvested dividend's BUY or REINVEST
 * counts its units), or null when a unit-moving row has no date or no units.
 */
function unitsSince(raw: StoredActivity[], symbol: string, listing: string | null, startDate: string): number | null {
  let moved = 0;
  for (const a of raw) {
    if (a.isOption || !a.symbol || upper(a.symbol) !== symbol) continue;
    if (listing && upper(a.securityCurrency ?? a.currency ?? "") !== listing) continue;
    const type = a.type.toUpperCase();
    if (!TRADE_UNIT_TYPES.has(type) && !OTHER_UNIT_TYPES.has(type)) continue;
    const date = dateOf(a);
    if (date !== null && date <= startDate) continue;
    if (date === null || !finite(a.units) || a.units === 0) return null;
    moved += TRADE_UNIT_TYPES.has(type) ? unitsDelta(type === "REI" ? "REINVEST" : type, a.units) : a.units;
  }
  return moved;
}

const unitsMatch = (expected: number, held: number) => Math.abs(expected - held) <= UNITS_EPS * Math.max(1, Math.abs(expected), Math.abs(held));
const DIVIDEND_TYPES = new Set(["DIVIDEND", "DISTRIBUTION"]);
const REINVEST_TYPES = new Set(["REINVEST", "REI"]);

const positionSchema = z.looseObject({
  symbol: z.string(), currency: z.string().nullable().optional(),
  units: z.number().nullable().optional(), price: z.number().nullable().optional(), marketValue: z.number().nullable().optional(),
});
const snapshotPayload = z.looseObject({ positions: z.array(z.unknown()) });

type Position = { symbol: string; currency?: string | null; units?: number | null; price?: number | null; marketValue?: number | null };
const positionValue = (p: Position): number | null =>
  finite(p.marketValue) ? p.marketValue : finite(p.units) && finite(p.price) ? p.units * p.price : null;
/** A position's currency as reported, else `fallback` (the listing known from stored activity), else unknown (M-3). */
const positionCurrency = (p: Position, fallback: string | null = null): string | null => (p.currency ? upper(p.currency) : fallback);

/**
 * Pairs a reinvested dividend so it is counted once (in the holding's value), never as cash received and again as
 * units held. In one account, for one symbol, on one date, a DIVIDEND (or DISTRIBUTION) whose amount matches within a
 * cent either a BUY (both rows dropped: no cash left or entered the account) or a REINVEST row (the dividend is
 * dropped; REINVEST is not a flow) is removed. Each row pairs at most once.
 */
export function withoutReinvestedDividends(activities: StoredActivity[]): StoredActivity[] {
  const dropped = new Set<StoredActivity>();
  const dateOf = (a: StoredActivity) => a.tradeDate ?? a.settlementDate;
  const amountOf = (a: StoredActivity) => (finite(a.amount) ? Math.abs(a.amount) : finite(a.units) && finite(a.price) ? Math.abs(a.units * a.price) : null);
  for (const d of activities) {
    if (!DIVIDEND_TYPES.has(d.type.toUpperCase()) || !d.symbol || !dateOf(d) || !finite(d.amount) || d.amount <= 0) continue;
    const match = activities.find((x) => x !== d && !dropped.has(x)
      && (x.type.toUpperCase() === "BUY" || REINVEST_TYPES.has(x.type.toUpperCase()))
      && x.snapTradeAccountId === d.snapTradeAccountId && !!x.symbol && upper(x.symbol) === upper(d.symbol!) && dateOf(x) === dateOf(d)
      && upper(x.currency ?? "") === upper(d.currency ?? "")
      && amountOf(x) !== null && Math.abs(amountOf(x)! - d.amount!) <= REINVEST_TOLERANCE + 1e-9);
    if (!match) continue;
    dropped.add(d);
    if (match.type.toUpperCase() === "BUY") dropped.add(match);
  }
  return activities.filter((a) => !dropped.has(a));
}

/** A stored Activity row (Prisma decimals and dates) as a StoredActivity. */
export function toStoredActivity(r: ActivityRow): StoredActivity {
  return {
    snapTradeAccountId: r.snapTradeAccountId, dedupeKey: r.dedupeKey, type: r.type, symbol: r.symbol, securityCurrency: r.securityCurrency,
    isOption: r.isOption, units: toNumber(r.units), price: toNumber(r.price), amount: toNumber(r.amount), fee: toNumber(r.fee),
    fxRate: toNumber(r.fxRate), currency: r.currency, tradeDate: calendarDay(r.tradeDate), settlementDate: calendarDay(r.settlementDate), description: null,
  };
}

interface HoldingValue { valueCad: number; estimated: boolean; units: number | null; rateDate?: string | null }

/**
 * One holding's value in CAD across positions, converted on `date`; null when a matching position has no value, no
 * known currency or no rate. `units` is null when a matching position reported none.
 */
function holdingCad(positions: Position[], symbol: string, listing: string | null, fx: HomeConverter, date: string): HoldingValue | null {
  let valueCad = 0, estimated = false, units: number | null = 0;
  let rateDate: string | null = null;
  for (const p of positions) {
    if (upper(p.symbol) !== symbol) continue;
    const cur = positionCurrency(p, listing);
    if (cur === null) return null;
    if (listing !== null && cur !== listing) continue;
    const native = positionValue(p);
    if (native === null) return null;
    const at = fx.at(native, cur, date);
    if (at.amount === null) return null;
    valueCad += at.amount;
    estimated ||= at.estimated;
    if (at.estimated && at.rateDate && (rateDate === null || at.rateDate > rateDate)) rateDate = at.rateDate;
    units = units !== null && finite(p.units) ? units + p.units : null;
  }
  return { valueCad: cents(valueCad), estimated, units, rateDate };
}

const dateOf = (a: StoredActivity) => a.tradeDate ?? a.settlementDate;

/** The start value from snapshots: see the module comment. */
function startFromSnapshots(
  snapshots: SnapshotRow[], involved: Set<string>, symbol: string, listing: string | null, writtenAt: Date,
  activities: StoredActivity[], fx: HomeConverter,
): (NonNullable<ThesisInput["start"]> & { units: number | null }) | null {
  const writtenDay = torontoDay(writtenAt);
  const chosen = new Map<string, { day: string; positions: Position[] }>();
  for (const s of snapshots) {
    if (!involved.has(s.snapTradeAccountId) || chosen.has(s.snapTradeAccountId)) continue;
    const asOf = s.positionsAsOf ?? s.capturedAt;
    if (asOf < writtenAt || s.capturedAt < writtenAt) continue;
    const day = torontoDay(asOf);
    if (day < writtenDay || tradingDaysBetween(writtenDay, day) > PRICE_STALE_TRADING_DAYS) continue;
    const payload = snapshotPayload.safeParse(s.payload);
    if (!payload.success) continue;
    const positions = payload.data.positions.flatMap((p) => { const r = positionSchema.safeParse(p); return r.success ? [r.data as Position] : []; });
    chosen.set(s.snapTradeAccountId, { day, positions });
  }
  if (involved.size === 0) return { date: writtenDay, valueCad: 0, estimated: false, units: 0 };
  if ([...involved].some((id) => !chosen.has(id))) return null;
  const date = [...chosen.values()].map((c) => c.day).sort().at(-1)!;
  let valueCad = 0, estimated = false, units: number | null = 0;
  for (const [accountId, c] of chosen) {
    // The holding moved between this account's snapshot and the start date: its value at the start is not known.
    if (c.day < date && activities.some((a) => a.snapTradeAccountId === accountId && (dateOf(a) ?? "") > c.day && (dateOf(a) ?? "") <= date)) return null;
    const v = holdingCad(c.positions, symbol, listing, fx, c.day);
    if (v === null) return null;
    valueCad += v.valueCad;
    estimated ||= v.estimated;
    units = units !== null && v.units !== null ? units + v.units : null;
  }
  return { date, valueCad: cents(valueCad), estimated, units };
}

/** The baseline as a start, or null when any of the module comment's conditions fails. */
function startFromBaseline(
  b: ThesisBaseline | null, writtenAt: Date, involved: Set<string>, createdAt: Map<string, Date>, listing: string | null,
  coverageStart: string | null, activities: StoredActivity[],
): (NonNullable<ThesisInput["start"]> & { units: number | null }) | null {
  if (!b || Date.parse(b.writtenAt) !== writtenAt.getTime()) return null;
  const day = torontoDay(new Date(b.positionsAsOf));
  const writtenDay = torontoDay(writtenAt);
  const [lo, hi] = day < writtenDay ? [day, writtenDay] : [writtenDay, day];
  if (tradingDaysBetween(lo, hi) > PRICE_STALE_TRADING_DAYS) return null;
  if (b.currency !== null && listing !== null && b.currency !== listing) return null;
  const seen = new Set(b.accountsSeen);
  for (const id of involved) {
    if (seen.has(accountKey(id))) continue;
    const created = createdAt.get(id);
    // Not seen: acceptable only for an account connected after writtenAt with nothing in this holding by the baseline date.
    if (!created || created <= writtenAt) return null;
    if (activities.some((a) => a.snapTradeAccountId === id && (dateOf(a) === null || dateOf(a)! <= day))) return null;
  }
  if (coverageStart === null || coverageStart > day) return null;
  // Each account was valued at its own positions date; holding activity after the oldest date but by an account's own
  // date is already in its value and would be counted again as a flow after the start (R2-I-1).
  for (const id of involved) {
    const own = b.accountsAsOf[accountKey(id)];
    if (!own) continue;
    const ownDay = torontoDay(new Date(own));
    if (ownDay > day && activities.some((a) => a.snapTradeAccountId === id && dateOf(a) !== null && dateOf(a)! > day && dateOf(a)! <= ownDay)) return null;
  }
  return { date: day, valueCad: b.valueCad, estimated: b.currency !== null && b.currency !== "CAD" && b.valueCad > 0, units: b.units };
}

async function benchmark(market: ThesisLoaderDeps["market"], key: "sp500" | "tsx", from: string, to: string, fx: HomeConverter): Promise<BenchmarkClose[] | null> {
  try {
    const r = await benchmarkClosesCad(market, key, from, to, fx);
    return r.points.length > 0 ? r.points : null;
  } catch {
    return null;
  }
}

/** Listings under the ticker from positions (reported currencies) and stored activity. */
function listingsOf(accounts: PortfolioPresentationAccount[], activities: StoredActivity[], symbol: string): { listings: Set<string>; fromActivity: string | null } {
  const fromActivitySet = new Set<string>();
  for (const a of activities) { const c = a.securityCurrency ?? a.currency; if (c) fromActivitySet.add(upper(c)); }
  const listings = new Set(fromActivitySet);
  for (const a of accounts) for (const p of a.positions ?? []) if (upper(p.symbol) === symbol && p.currency) listings.add(upper(p.currency));
  return { listings, fromActivity: fromActivitySet.size === 1 ? [...fromActivitySet][0]! : null };
}

/** Upper-cased symbols of the subject's stored (non-option) activity in included, open, non-credit accounts. */
export async function storedActivitySymbols(prisma: Pick<ThesisPrismaPort, "activity">, subject: string, portfolio: PortfolioPresentation): Promise<string[]> {
  const ids = (portfolio.accounts ?? []).filter(isInvestable).map((a) => a.id);
  if (ids.length === 0) return [];
  const rows = await prisma.activity.findMany({
    where: { appUser: { authSubject: subject }, snapTradeAccountId: { in: ids }, isOption: false }, distinct: ["symbol"], select: { symbol: true },
  });
  return [...new Set(rows.map((r) => (r.symbol ? upper(r.symbol) : "")).filter((x) => x.length > 0))];
}

/** Null when the subject has no current thesis on the ticker. */
export async function loadThesisInput(deps: ThesisLoaderDeps, subject: string, ticker: string, now: Date): Promise<ThesisInput | null> {
  return (await loadHoldingView(deps, subject, ticker, now)).thesis;
}

/** The end value and whether sold in full is verified, from the current positions and the units since `start`. */
function endOf(o: {
  accounts: PortfolioPresentationAccount[]; holders: PortfolioPresentationAccount[]; involved: Set<string>; sync: Map<string, SyncRow>;
  holding: (a: PortfolioPresentationAccount) => Position[]; symbol: string; listing: string | null; fromActivity: string | null;
  raw: StoredActivity[]; start: { date: string; units: number | null } | null; flows: HoldingFlow[]; fx: HomeConverter; today: string; now: Date;
}): { end: ThesisInput["end"] & { rateDate?: string | null } | null; endNote?: string; soldInFull: boolean } {
  const { holders, involved, sync, start, now } = o;
  if ([...involved].some((id) => !sync.get(id)?.lastSyncedAt)) return { end: null, endNote: ACTIVITY_NOT_LOADED, soldInFull: false };
  // Backstop for a sync that stopped without an error: the units would still match while dividends go missing.
  const oldestSync = Math.min(...[...involved].map((id) => sync.get(id)!.lastSyncedAt!.getTime()));
  if (holders.length > 0 && now.getTime() - oldestSync > ACTIVITY_STALE_DAYS * 86_400_000) {
    return { end: null, endNote: activityStaleNote(torontoDay(new Date(oldestSync))), soldInFull: false };
  }
  if (holders.length > 0 && [...involved].every((id) => !sync.get(id)?.lastError)) {
    let valueCad = 0, estimated = false;
    let held: number | null = 0;
    let rateDate: string | null = null;
    const days: string[] = [];
    for (const a of holders) {
      const day = positionsAsOfDay(a);
      const v = day ? holdingCad(o.holding(a), o.symbol, o.listing ?? o.fromActivity, o.fx, day) : null;
      if (!day || !v) return { end: null, soldInFull: false };
      valueCad += v.valueCad; estimated ||= v.estimated; days.push(day);
      if (v.rateDate && (rateDate === null || v.rateDate > rateDate)) rateDate = v.rateDate;
      held = held !== null && v.units !== null ? held + v.units : null;
    }
    // I-2: the end counts only when the activity since the start accounts for every unit held now.
    const moved = start ? unitsSince(o.raw, o.symbol, o.listing, start.date) : null;
    if (start && (start.units === null || held === null)) return { end: null, endNote: UNITS_NOT_REPORTED, soldInFull: false };
    if (start && (moved === null || !unitsMatch(start.units! + moved, held!))) return { end: null, endNote: ACTIVITY_NOT_RECORDED, soldInFull: false };
    return { end: { date: days.sort()[0]!, valueCad: cents(valueCad), estimated, ...(estimated ? { rateDate } : {}) }, soldInFull: false };
  }
  if (holders.length === 0) {
    const soldInFull = verifySoldInFull(o.accounts, involved, sync, start, start ? unitsSince(o.raw, o.symbol, o.listing, start.date) : null, o.today, now);
    if (soldInFull) return { end: { date: o.flows.at(-1)?.date ?? o.today, valueCad: 0, estimated: false }, soldInFull };
  }
  return { end: null, soldInFull: false };
}

const monthStart = (day: string) => `${day.slice(0, 8)}01`;
/** Anything held or recorded in a currency other than CAD (positions, cash, this holding's activity). */
function holdsForeign(accounts: PortfolioPresentationAccount[], raw: StoredActivity[]): boolean {
  const foreign = (c: string | null | undefined) => !!c && upper(c) !== "CAD";
  return accounts.some((a) => (a.positions ?? []).some((p) => foreign(p.currency)) || (a.balances ?? []).some((b) => foreign(b.currency) && finite(b.cash) && b.cash !== 0))
    || raw.some((r) => foreign(r.currency) || foreign(r.securityCurrency));
}

/** Before every date: the holding's units "since" this are all of its stored units. */
const BEGINNING = "";
const HOLDING_NEWS_MS = HOLDING_NEWS_DAYS * 86_400_000;

/**
 * show_thesis for any ticker (thesis optional): one read of the holding's stored data for both the thesis check (when a
 * thesis is saved; its input is exactly loadThesisInput's) and the holding view "since you first bought".
 *
 * The holding view: every dated flow from stored activity, from the beginning; nothing held before the first
 * purchase, so the units held now must equal the units every stored row moved (held-path unit reconciliation from
 * zero), and sold in full nets them to zero, with the same freshness, sync and listing rules as the thesis check.
 * `holding` is null when the ticker was never held here: no position and no stored activity in an included, open,
 * non-credit account. News: since writtenAt with a thesis, else the last HOLDING_NEWS_DAYS days.
 */
export async function loadHoldingView(deps: ThesisLoaderDeps, subject: string, ticker: string, now: Date): Promise<{ holding: HoldingInput | null; thesis: ThesisInput | null }> {
  const symbol = upper(ticker);
  const found = (await readTheses(deps.memory, subject)).find((t) => upper(t.ticker) === symbol) ?? null;
  const writtenAt = found?.writtenAt ?? null;
  const writtenDay = writtenAt ? torontoDay(writtenAt) : null;
  const today = torontoDay(now);
  const where = { appUser: { authSubject: subject } };

  const [portfolio, activityRows, syncRows, accountRows, snapshots, baseline] = await Promise.all([
    deps.portfolio(subject),
    deps.prisma.activity.findMany({
      where: { ...where, symbol: { equals: symbol, mode: "insensitive" } },
      orderBy: [{ tradeDate: "asc" }, { dedupeKey: "asc" }],
      select: {
        snapTradeAccountId: true, dedupeKey: true, type: true, symbol: true, securityCurrency: true, isOption: true, units: true, price: true,
        amount: true, fee: true, fxRate: true, currency: true, tradeDate: true, settlementDate: true,
      },
    }),
    deps.prisma.activitySyncState.findMany({
      where, select: { snapTradeAccountId: true, backfillCompletedAt: true, earliestTradeDate: true, lastSyncedAt: true, lastError: true },
    }),
    // The start snapshots and baseline are the thesis check's only: not read without a thesis.
    writtenAt ? deps.prisma.brokerageAccount.findMany({ where, select: { snapTradeAccountId: true, createdAt: true } }) : Promise.resolve([]),
    writtenAt ? deps.prisma.portfolioSnapshot.findMany({
      where: { ...where, capturedAt: { gte: writtenAt, lte: new Date(writtenAt.getTime() + START_WINDOW_DAYS * 86_400_000) } },
      orderBy: { capturedAt: "asc" },
      select: { snapTradeAccountId: true, positionsAsOf: true, capturedAt: true, payload: true },
    }) : Promise.resolve([]),
    writtenAt ? readThesisBaseline(deps.memory, subject, symbol) : Promise.resolve(null),
  ]);

  const accounts = portfolio.accounts.filter(isInvestable);
  const accountIds = new Set(accounts.map((a) => a.id));
  const raw = activityRows.map(toStoredActivity).filter((a) => accountIds.has(a.snapTradeAccountId) && !a.isOption);
  const activities = withoutReinvestedDividends(raw);
  const holding = (a: PortfolioPresentationAccount) => (a.positions ?? []).filter((p) => upper(p.symbol) === symbol);

  // Listings under this ticker: more than one is never combined.
  const { listings, fromActivity } = listingsOf(accounts, activities, symbol);
  const multipleListings = listings.size > 1;
  const listing = listings.size === 1 ? [...listings][0]! : null;

  // Accounts involved: those holding it now or with stored activity in it.
  const holders = accounts.filter((a) => holding(a).length > 0);
  const involved = new Set<string>([...holders.map((a) => a.id), ...activities.map((a) => a.snapTradeAccountId)]);
  if (!found && involved.size === 0) return { holding: null, thesis: null };

  // Coverage: every involved account's backfill finished; the latest of their first trades. Sync errors are flagged.
  const sync = new Map(syncRows.map((s) => [s.snapTradeAccountId, s]));
  let involvedCoverage: string | null = null;
  if (involved.size > 0) {
    const firsts = [...involved].map((id) => { const s = sync.get(id); return s && s.backfillCompletedAt ? calendarDay(s.earliestTradeDate) : null; });
    involvedCoverage = firsts.every((d) => d !== null) ? (firsts as string[]).sort().at(-1)! : null;
  }
  const syncError = [...involved].some((id) => !!sync.get(id)?.lastError);
  const syncedAt = [...involved].map((id) => sync.get(id)?.lastSyncedAt ?? null);
  const activityAsOf = syncedAt.length > 0 && syncedAt.every((d) => d) ? torontoDay(new Date(Math.min(...syncedAt.map((d) => d!.getTime())))) : null;

  // Market data (M-1). Conversions reach back to the earliest stored activity (the holding view), or the baseline (just
  // before writtenAt); dates snap to the first of the month, less the benchmark lead days, so holdings share cache keys.
  // Nothing foreign held or recorded: no Bank of Canada read until a benchmark (the S&P 500 is USD) is needed.
  const firstActivity = raw.map(dateOf).filter((d): d is string => d !== null).sort()[0] ?? today;
  const baselineDay = baseline ? torontoDay(new Date(baseline.positionsAsOf)) : today;
  const fxFromFor = (day: string) => benchmarkFetchFrom(monthStart(day));
  const earliest = [firstActivity, baselineDay, writtenDay ?? today, today].sort()[0]!;
  let loadedFx: { from: string; fx: HomeConverter } | null = null;
  if (holdsForeign(accounts, raw)) {
    loadedFx = deps.shared ? { from: "", fx: deps.shared.fx } : { from: fxFromFor(earliest), fx: await loadHomeConverter(deps.market, fxFromFor(earliest), today) };
  }
  const fx = loadedFx?.fx ?? homeConverter(null, today);

  // Price: the freshest brokerage-reported price, native currency.
  let price: ThesisInput["price"] = null;
  for (const a of holders) {
    const day = positionsAsOfDay(a);
    if (!day) continue;
    for (const p of holding(a)) {
      const cur = positionCurrency(p, fromActivity);
      if (!finite(p.price) || p.price <= 0 || cur === null) continue;
      if (!price || day > price.asOf) price = { value: p.price, currency: cur, asOf: day };
    }
  }

  const listingOpt = listing ? { currency: listing } : {};
  const common = { accounts, holders, involved, sync, holding, symbol, listing, fromActivity, raw, fx, today, now };

  // The holding view: from the beginning, nothing held before the first stored row.
  let holdingInput: Omit<HoldingInput, "benchmarks" | "news"> | null = null;
  if (involved.size > 0) {
    const all = holdingFlows(activities, symbol, undefined, { fx, ...listingOpt });
    const e = endOf({ ...common, start: { date: BEGINNING, units: 0 }, flows: all.flows });
    holdingInput = {
      ticker: symbol, multipleListings, syncError,
      weight: weightOf(accounts, holders, holding, symbol, listing ?? fromActivity, e.soldInFull, fx),
      flows: all.flows, excluded: all.excluded, coverageStart: involvedCoverage, end: e.end, ...(e.endNote ? { endNote: e.endNote } : {}), activityAsOf,
    };
  }

  // The thesis check, exactly as before.
  let thesisInput: Omit<ThesisInput, "benchmarks" | "news" | "earnings"> | null = null;
  if (found && writtenAt && writtenDay) {
    const coverageStart = involved.size > 0 ? involvedCoverage : writtenDay;
    const createdAt = new Map(accountRows.map((r) => [r.snapTradeAccountId, r.createdAt]));
    const start = startFromBaseline(baseline, writtenAt, involved, createdAt, listing ?? fromActivity, coverageStart, activities)
      ?? startFromSnapshots(snapshots, involved, symbol, listing ?? fromActivity, writtenAt, activities, fx);
    const flowsFrom = start ? minDay(start.date, writtenDay) : writtenDay;
    const { flows, excluded } = holdingFlows(activities, symbol, flowsFrom, { fx, ...listingOpt });
    const e = endOf({ ...common, start, flows });
    // The thesis input's end carries no rate date (unchanged shape).
    const end = e.end ? { date: e.end.date, valueCad: e.end.valueCad, estimated: e.end.estimated } : null;
    thesisInput = {
      ticker: symbol, thesis: found.thesis, writtenAt, multipleListings, price,
      weight: weightOf(accounts, holders, holding, symbol, listing ?? fromActivity, e.soldInFull, fx),
      syncError, start: start ? { date: start.date, valueCad: start.valueCad, estimated: start.estimated } : null,
      end, ...(e.endNote ? { endNote: e.endNote } : {}), activityAsOf, flows, excluded, coverageStart,
    };
  }

  // Benchmarks only when a comparison can still be a number: each check is run first without them (M-1).
  const noBench = { sp500: null, tsx: null };
  const starts: string[] = [];
  if (holdingInput && checkHolding({ ...holdingInput, benchmarks: noBench, news: [] }, now).sinceFirstBought.returnPct !== null) {
    starts.push(holdingInput.flows.map((f) => f.date).reduce((a, b) => (b < a ? b : a))); // the earliest flow (M-8)
  }
  if (thesisInput && thesisInput.start && checkThesis({ ...thesisInput, benchmarks: noBench, news: [], earnings: [] }, now).playedOut.returnPct !== null) {
    starts.push(thesisInput.start.date);
  }
  let benchFx: { from: string; fx: HomeConverter } | null = null;
  if (starts.length > 0) {
    const from = monthStart(starts.sort()[0]!);
    benchFx = deps.shared ? { from: "", fx: deps.shared.fx }
      : loadedFx && loadedFx.from <= benchmarkFetchFrom(from) ? loadedFx : { from: fxFromFor(from), fx: await loadHomeConverter(deps.market, fxFromFor(from), today) };
    starts[0] = from;
  }
  // A thesis: news since writtenAt (its check, and the holding view's window within it); else the last 30 days.
  const newsSince = writtenAt ?? new Date(now.getTime() - HOLDING_NEWS_MS);
  const extra = await marketAndNews(deps, symbol, benchFx ? { from: starts[0]!, fx: benchFx.fx } : null, newsSince, writtenDay, today, now);
  return {
    holding: holdingInput ? { ...holdingInput, benchmarks: extra.benchmarks, news: extra.news } : null,
    thesis: thesisInput ? { ...thesisInput, ...extra } : null,
  };
}


/** C-2: no position left is "sold in full" only on fresh positions, fresh error-free sync and reconciled units. */
function verifySoldInFull(
  accounts: PortfolioPresentationAccount[], involved: Set<string>, sync: Map<string, SyncRow>,
  start: { date: string; units: number | null } | null, moved: number | null, today: string, now: Date,
): boolean {
  for (const id of involved) {
    const a = accounts.find((x) => x.id === id);
    const day = a ? positionsAsOfDay(a) : null;
    if (!day || tradingDaysBetween(day, today) > PRICE_STALE_TRADING_DAYS) return false;
    if (!activitySynced(sync.get(id), now, a ? positionsAsOfInstant(a) : null)) return false;
  }
  if (!start || start.units === null || moved === null) return false;
  return unitsMatch(start.units + moved, 0);
}

/** I-1: the weight needs every counted account's positions date, and a value for every position of the holding. */
function weightOf(
  accounts: PortfolioPresentationAccount[], holders: PortfolioPresentationAccount[],
  holding: (a: PortfolioPresentationAccount) => Array<PortfolioPresentationAccount["positions"][number]>,
  symbol: string, listing: string | null, soldInFull: boolean, fx: HomeConverter,
): ThesisInput["weight"] {
  const items: ExposureItem[] = [];
  const cash: ExposureCash[] = [];
  const days: string[] = [];
  for (const a of accounts) {
    const day = positionsAsOfDay(a);
    if (!day) return null;
    days.push(day);
    for (const p of a.positions ?? []) {
      const isHolding = upper(p.symbol) === symbol;
      const cur = positionCurrency(p, isHolding ? listing : null);
      const native = positionValue(p);
      if (isHolding && (cur === null || native === null)) return null;
      if (cur === null || native === null || native <= 0 || p.cashEquivalent) continue;
      const at = fx.at(native, cur, day);
      if (at.amount === null) { if (isHolding) return null; continue; }
      items.push({ holdingKey: `${upper(p.symbol)}|${cur}`, symbol: p.symbol, kind: p.kind === "mutualfund" ? "fund" : p.kind, valueCad: at.amount, currency: cur, accountLabel: a.id, profile: null, classification: a.classification });
    }
    for (const b of a.balances ?? []) {
      // A negative balance is a margin debit: it stays in, so the total is net equity (exposure.ts).
      if (!b.currency || !finite(b.cash) || b.cash === 0) continue;
      const at = fx.at(b.cash, b.currency, day);
      if (at.amount !== null) cash.push({ currency: upper(b.currency), accountLabel: a.id, valueCad: at.amount, classification: a.classification });
    }
  }
  if (days.length === 0) return null;
  const asOf = days.sort()[0]!;
  const weights = holdingWeights(items, cash);
  const row = weights.find((w) => w.symbol === symbol && (listing === null || w.currency === listing));
  if (row) {
    const notInTotal = managedNotInTotal({ accounts });
    return { pct: row.pct, estimated: row.estimated, asOf, ...(exposureNetOfMargin(items, cash) ? { netOfMargin: true } : {}), ...(notInTotal.length > 0 ? { notInTotal } : {}) };
  }
  // Not in the weights: 0% only when sold in full is verified (or it was never held) and a total exists.
  const total = weights.length > 0 || cash.length > 0;
  return holders.length === 0 && soldInFull && total ? { pct: 0, estimated: false, asOf } : null;
}

async function marketAndNews(
  deps: ThesisLoaderDeps, symbol: string, bench: { from: string; fx: HomeConverter } | null, newsSince: Date, writtenDay: string | null, today: string, now: Date,
): Promise<Pick<ThesisInput, "benchmarks" | "news" | "earnings">> {
  const [sp500, tsx, articles, events] = await Promise.all([
    !bench ? Promise.resolve(null) : deps.shared ? Promise.resolve(deps.shared.benchmarks.sp500) : benchmark(deps.market, "sp500", bench.from, today, bench.fx),
    !bench ? Promise.resolve(null) : deps.shared ? Promise.resolve(deps.shared.benchmarks.tsx) : benchmark(deps.market, "tsx", bench.from, today, bench.fx),
    deps.news.articlesForSymbols([symbol], newsSince).catch(() => []),
    writtenDay ? deps.news.events([symbol], new Date(`${writtenDay}T00:00:00Z`), now).catch(() => []) : Promise.resolve([]),
  ]);
  const ratings = articles.length > 0 ? await deps.news.ratingsFor(articles.map((a) => a.id)).catch(() => []) : [];
  const ratingOf = new Map(ratings.filter((r) => upper(r.symbol) === symbol).map((r) => [r.articleId, r]));
  const news: ThesisNewsItem[] = articles.flatMap((a) => {
    const r = ratingOf.get(a.id);
    if (r && r.duplicateOf !== null) return [];
    const mood = r && r.relevant >= RELEVANT_MIN && finite(r.sentiment) ? levelFor((r.sentiment - 2) / 2) : null;
    return [{ title: a.headline, source: a.source, publishedAt: a.publishedAt, symbols: a.symbols, mood, url: a.url }];
  });
  const earnings = events.filter((e) => e.kind === "earnings" && e.status === "confirmed" && upper(e.symbol) === symbol).map((e) => calendarDay(e.date)!).filter(Boolean);
  return { benchmarks: { sp500, tsx }, news, earnings };
}

/**
 * Records the holding as it stands when a thesis version is saved (Task 5 calls this at save time), as the derived
 * `security.thesis_baseline` fact on `security:<ticker>`. Written only when every included account has a positions
 * date, the ticker has one listing, and every holding position has a value and units; otherwise nothing is written
 * and null is returned. `positionsAsOf` is the oldest positions date; values convert at each account's own date.
 */
export async function captureThesisBaseline(deps: ThesisBaselineDeps, subject: string, ticker: string, writtenAt: Date): Promise<ThesisBaseline | null> {
  const symbol = upper(ticker);
  const portfolio = await deps.portfolio(subject);
  const accounts = (portfolio.accounts ?? []).filter(isInvestable);
  if (accounts.length === 0) return null;
  const instants = accounts.map(positionsAsOfInstant);
  if (instants.some((d) => d === null)) return null;
  const oldest = (instants as Date[]).reduce((a, b) => (a < b ? a : b));
  const holding = (a: PortfolioPresentationAccount) => (a.positions ?? []).filter((p) => upper(p.symbol) === symbol);
  const currencies = new Set<string>();
  for (const a of accounts) for (const p of holding(a)) { if (!p.currency) return null; currencies.add(upper(p.currency)); }
  if (currencies.size > 1) return null;
  const currency = currencies.size === 1 ? [...currencies][0]! : null;
  const fx = await loadHomeConverter(deps.market, torontoDay(oldest), torontoDay(writtenAt));
  let valueCad = 0, units = 0;
  let price: { value: number; at: Date } | null = null;
  for (const a of accounts) {
    if (holding(a).length === 0) continue;
    const at = positionsAsOfInstant(a)!;
    const v = holdingCad(holding(a), symbol, currency, fx, torontoDay(at));
    if (!v || v.units === null) return null;
    valueCad += v.valueCad;
    units += v.units;
    for (const p of holding(a)) if (finite(p.price) && p.price > 0 && (!price || at > price.at)) price = { value: p.price, at };
  }
  const value: ThesisBaseline = {
    writtenAt: writtenAt.toISOString(), positionsAsOf: oldest.toISOString(), valueCad: cents(valueCad), units,
    priceNative: price?.value ?? null, currency, accountsSeen: accounts.map((a) => accountKey(a.id)),
    accountsAsOf: Object.fromEntries(accounts.map((a) => [accountKey(a.id), positionsAsOfInstant(a)!.toISOString()])),
  };
  await deps.memory.remember(subject, {
    node: { type: "security", key: ticker.trim() }, property: "security.thesis_baseline", value,
    text: `Value of ${symbol} recorded when the thesis was saved.`, kind: "fact", provenance: "derived",
  }, undefined, "system");
  return value;
}

/**
 * A cheap thesis input from a portfolio the caller already loaded (spec §11a.10): the status lines on holdings and
 * allocation results. Only price and weight are filled, from the loaded positions; there is no start, end, flow,
 * benchmark, news or activity, so return-based conditions and "played out" are "checked in the full view". No read of
 * its own beyond `fx` (which the caller builds). The full check is `loadThesisInput`.
 */
export function quickThesisInput(
  entry: { ticker: string; thesis: ThesisInput["thesis"]; writtenAt: Date }, portfolio: PortfolioPresentation, fx: HomeConverter,
): ThesisInput {
  const symbol = upper(entry.ticker);
  const accounts = (portfolio.accounts ?? []).filter(isInvestable);
  const holding = (a: PortfolioPresentationAccount) => (a.positions ?? []).filter((p) => upper(p.symbol) === symbol);
  const { listings } = listingsOf(accounts, [], symbol);
  const listing = listings.size === 1 ? [...listings][0]! : null;
  const holders = accounts.filter((a) => holding(a).length > 0);
  let price: ThesisInput["price"] = null;
  for (const a of holders) {
    const day = positionsAsOfDay(a);
    if (!day) continue;
    for (const p of holding(a)) {
      const cur = positionCurrency(p);
      if (!finite(p.price) || p.price <= 0 || cur === null) continue;
      if (!price || day > price.asOf) price = { value: p.price, currency: cur, asOf: day };
    }
  }
  return {
    ticker: symbol, thesis: entry.thesis, writtenAt: entry.writtenAt, multipleListings: listings.size > 1, price,
    weight: holders.length > 0 ? weightOf(accounts, holders, holding, symbol, listing, false, fx) : null,
    syncError: false, start: null, end: null, flows: [], excluded: [], coverageStart: null, returnNote: CHECKED_IN_FULL_VIEW,
    benchmarks: { sp500: null, tsx: null }, news: [], earnings: [],
  };
}
