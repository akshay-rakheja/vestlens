import { z } from "zod";

import { homeConverter, loadHomeConverter } from "../fx/home-currency.js";
import type { StoredActivity } from "../history/stored-activity.js";
import { accountKey, activityKey } from "../memory/keys.js";
import type { MemoryRepository } from "../memory/memory-service.js";
import { PROPERTY_REGISTRY, outsideLabelCollision, toMemoryFact, type MemoryFact, type Provenance, type StoredFact } from "../memory/memory-types.js";
import type { SecurityHistory } from "../market-data/types.js";
import { providerTicker } from "../market-data/ticker-map.js";
import { classifyPortfolioAccount, isManagedPortfolio } from "../portfolio/account-taxonomy.js";
import { isInKind, priorDecember, type RoomPeriod, type RoomPricePort } from "./room-common.js";
import { COVERS_FROM_START, MATCH_WINDOW_DAYS, type RoomInput } from "./tfsa-room.js";
import type { FhsaRoomInput } from "./fhsa-room.js";
import { computeTfsaLifetime, type TfsaLifetime } from "./tfsa-lifetime.js";
import { openTaxYears } from "./rrsp-calendar.js";
import type { RrspRoomInput } from "./rrsp-room.js";
import type { UserRoomEffect } from "./tfsa-rules.js";

/**
 * Reads the TFSA room engine's inputs for one auth subject (spec §6.1, §9a), from stored data only: no brokerage
 * read. Every query is keyed by the auth subject. It passes:
 *   - every account the taxonomy puts in the TFSA bucket (closed ones included) and every account it leaves neutral;
 *   - those accounts' Activity rows traded this Toronto year (plus rows with no trade date settled this year or
 *     with no date at all, which the engine treats as ambiguous); no description text is read;
 *   - transfer rows from every connected account, whatever its type, traded this year ±MATCH_WINDOW_DAYS: the other
 *     side of each TFSA transfer, for the engine to match;
 *   - coverage from ActivitySyncState: once the full backfill completed, stored activity counts as reaching this
 *     year's start (COVERS_FROM_START), not as the account's whole life; otherwise coverage is unknown;
 *   - each account's label (its name, with " ••<last 4>" when another connected account has the same one), the last 4
 *     of its masked number and its brokerage-reported total, so accounts can be told apart;
 *   - each account's sync freshness (lastSyncedAt, lastError, dirty) and the read's instant, for the freshness gate;
 *   - every connected account's key, so the engine can tell a confirmed TFSA that is gone from one that is not a TFSA;
 *   - the current reserved TFSA facts, never inferred ones;
 *   - a Bank of Canada converter (nearest previous rate, at most a week old) for rows with no usable broker rate.
 * Dates are Toronto calendar dates as YYYY-MM-DD strings. loadFhsaRoomInput reads the FHSA room's inputs through the
 * same account, activity, transfer, coverage and sync read (loadRoomBase), with the FHSA bucket in place of TFSAs.
 */

type DecimalLike = number | string | { toString(): string } | null;

type AccountRow = {
  snapTradeAccountId: string;
  displayName: string | null;
  institutionName: string;
  rawType: string | null;
  status: string | null;
  maskedNumber?: string | null;
  reportedTotal?: DecimalLike;
  reportedCurrency?: string | null;
  snapshots: Array<{ payload: unknown }>;
};
type ActivityRow = {
  snapTradeAccountId: string;
  dedupeKey: string;
  type: string | null;
  amount: DecimalLike;
  currency: string | null;
  fxRate: DecimalLike;
  tradeDate: Date | null;
  /** Shares moved in kind (A2); absent on a counterpart row, which is matched on its cash amount only. */
  units?: DecimalLike;
  price?: DecimalLike;
  symbol?: string | null;
  securityCurrency?: string | null;
  /** On a lifetime row only. */
  isOption?: boolean;
  fee?: DecimalLike;
  settlementDate?: Date | null;
};
type SyncRow = {
  snapTradeAccountId: string; backfillCompletedAt: Date | null;
  lastSyncedAt: Date | null; lastError: string | null; dirty: boolean;
};
type DateRange = { gte: Date; lt: Date };
type ActivitySelect = { snapTradeAccountId: true; dedupeKey: true; type: true; amount: true; currency: true; fxRate: true; tradeDate: true };
/** The room's own rows also carry what values shares moved in kind (A2); never the description. */
type RoomActivitySelect = ActivitySelect & { units: true; price: true; symbol: true; securityCurrency: true };
/** Every stored activity row in the TFSAs, for what went in and out over time. */
interface LifetimeQuery {
  where: { appUser: { authSubject: string }; snapTradeAccountId: { in: string[] } };
  orderBy: Array<{ tradeDate: "asc" } | { dedupeKey: "asc" }>;
  select: ActivitySelect & { units: true; price: true; symbol: true; securityCurrency: true; isOption: true; fee: true; settlementDate: true };
}

/** This year's activity in the TFSA and neutral accounts. */
export type RoomActivityQuery = {
  where: {
    appUser: { authSubject: string };
    snapTradeAccountId: { in: string[] };
    OR: Array<{ tradeDate: DateRange } | { tradeDate: null; settlementDate: DateRange } | { tradeDate: null; settlementDate: null }>;
  };
  orderBy: Array<{ tradeDate: "asc" } | { dedupeKey: "asc" }>;
  select: RoomActivitySelect;
};
/** Transfer rows in every connected account, from MATCH_WINDOW_DAYS before last 27 December through this year +MATCH_WINDOW_DAYS: the other side of each transfer. */
export type CounterpartQuery = {
  where: {
    appUser: { authSubject: string };
    snapTradeAccountId: { in: string[] };
    tradeDate: DateRange;
    OR: Array<{ type: { in: string[] } } | { type: { startsWith: string } }>;
  };
  orderBy: Array<{ tradeDate: "asc" } | { dedupeKey: "asc" }>;
  select: ActivitySelect;
};

/** The New Year check's read: the room accounts' rows dated 27–31 December last year. */
export type PriorDecemberQuery = {
  where: { appUser: { authSubject: string }; snapTradeAccountId: { in: string[] }; tradeDate: DateRange };
  orderBy: Array<{ tradeDate: "asc" } | { dedupeKey: "asc" }>;
  select: RoomActivitySelect;
};

export interface RoomPrismaPort {
  brokerageAccount: {
    findMany(input: {
      where: { appUser: { authSubject: string } };
      orderBy: { snapTradeAccountId: "asc" };
      select: {
        snapTradeAccountId: true; displayName: true; institutionName: true; rawType: true; status: true;
        maskedNumber: true; reportedTotal: true; reportedCurrency: true;
        snapshots: { orderBy: { capturedAt: "desc" }; take: 1; select: { payload: true } };
      };
    }): Promise<AccountRow[]>;
  };
  activity: {
    findMany(input: RoomActivityQuery | CounterpartQuery | PriorDecemberQuery | LifetimeQuery): Promise<ActivityRow[]>;
  };
  activitySyncState: {
    findMany(input: {
      where: { appUser: { authSubject: string }; snapTradeAccountId: { in: string[] } };
      select: { snapTradeAccountId: true; backfillCompletedAt: true; lastSyncedAt: true; lastError: true; dirty: true };
    }): Promise<SyncRow[]>;
  };
}

export interface RoomLoaderDeps {
  prisma: RoomPrismaPort;
  memory: MemoryRepository;
  /**
   * Bank of Canada USD/CAD closes (MarketDataService.usdCad); without it, foreign rows have no rate. `securityHistory`
   * (MarketDataService.securityHistory) values shares moved in kind with no reported price at that day's close (A2);
   * without it such a row stays a question.
   */
  market?: {
    usdCad(from: string, to: string): Promise<Array<{ date: string; close: number }> | null>;
    securityHistory?(ticker: string, from: string, to: string): Promise<SecurityHistory | null>;
  };
}

const TORONTO_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });
/** The Toronto calendar date (YYYY-MM-DD) of an instant. */
export const torontoToday = (now: Date): string => TORONTO_DAY.format(now);

/** A @db.Date column (UTC midnight of the calendar date) as YYYY-MM-DD. */
const calendarDay = (d: Date | null): string | null => (d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null);
const toNumber = (v: DecimalLike): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(typeof v === "number" ? v : v.toString());
  return Number.isFinite(n) ? n : null;
};

const nullableString = z.string().nullable().optional();
const snapshotAccount = z.looseObject({
  account: z.looseObject({ type: nullableString, metaType: nullableString, unifiedType: nullableString, status: nullableString }),
});

/** The final taxonomy fallback: an account the taxonomy cannot place stays neutral (never silently excluded). */
const NEUTRAL_LABEL = "Other account";
/** The transfer types the engine matches (tfsa-rules AMBIGUOUS_TYPES). */
const TRANSFER_TYPES = ["INTERNAL_CASH_TRANSFER_IN", "INTERNAL_CASH_TRANSFER_OUT"];
const TRANSFER_PREFIX = "TRANSFER";

/** The last 4 letters or digits of a masked account number, or null when it has none. */
function lastFour(masked: string | null | undefined): string | null {
  const plain = typeof masked === "string" ? masked.replace(/[^0-9A-Za-z]/g, "") : "";
  return plain.length > 0 ? plain.slice(-4) : null;
}

/** The engine's FX port over the Bank of Canada converter: USD only, nearest previous close within a week, est. */
export async function roomFx(market: RoomLoaderDeps["market"], today: string, needed: boolean): Promise<RoomInput["fx"]> {
  if (!market || !needed) return { toCad: () => null };
  // From 1 January: loadHomeConverter reaches 10 days further back, so a 1 January holiday has the last December close.
  const converter = await loadHomeConverter(market, `${today.slice(0, 4)}-01-01`, today);
  return {
    toCad(amount, currency, date) {
      const converted = converter.at(amount, currency, date);
      return converted.amount === null || !converted.estimated ? null : { cad: converted.amount, estimated: true, rateDate: converted.rateDate };
    },
  };
}

/**
 * Closes for the in-kind TRANSFER rows with no reported price (A2), read once per ticker over the room's period: the
 * engine values such a row at units × the close on or before its trade date, split-adjusted, in the security's currency.
 * A series without split information is not trusted (as the performance engine), so the row stays a question.
 */
async function roomPrices(market: RoomLoaderDeps["market"], rows: RoomInput["activities"], from: string, to: string): Promise<RoomPricePort | undefined> {
  const history = market?.securityHistory?.bind(market);
  if (!history) return undefined;
  const tickerOf = (r: RoomInput["activities"][number]) =>
    (r.symbol ? providerTicker({ symbol: r.symbol, kind: "stock", currency: r.securityCurrency ?? r.currency ?? "CAD" }) : null);
  const tickers = new Set(rows.filter((r) => isInKind(r) && !(typeof r.price === "number" && r.price > 0)).map(tickerOf).filter((t): t is string => t !== null));
  if (tickers.size === 0) return undefined;
  const histories = new Map<string, SecurityHistory | null>();
  await Promise.all([...tickers].map(async (t) => histories.set(t, await history(t, from, to).catch(() => null))));
  return {
    closeOn(row, date) {
      const t = tickerOf(row);
      const h = t ? histories.get(t) : undefined;
      if (!h || h.notFound || !h.splits) return null;
      let close: number | null = null;
      for (const p of h.points) { if (p.date <= date) close = p.close; else break; }
      if (close === null || !(close > 0)) return null;
      const factor = h.splits.filter((s) => s.date > date).reduce((p, s) => p * s.ratio, 1);
      return { price: close * factor, currency: (row.securityCurrency ?? row.currency ?? "CAD").trim().toUpperCase() };
    },
  };
}

const FEEDS: readonly Provenance[] = ["stated", "imported", "derived"];
const feeds = (row: StoredFact) => FEEDS.includes(row.provenance as Provenance);
const EFFECT = PROPERTY_REGISTRY["activity.room_effect"]!.schema!;
/** Enough for one user's facts of one property; the repository returns newest first. */
const MAX_FACTS = 1000;

async function currentFact(repo: MemoryRepository, subject: string, key: string, property: string): Promise<MemoryFact | null> {
  const rows = await repo.find(subject, { nodes: [{ type: "tax_year", key }], property, take: 50 });
  const row = rows.find((r) => r.property === property && r.supersededAt === null);
  return row && feeds(row) ? toMemoryFact(row) : null;
}

const SET_SCHEMA = PROPERTY_REGISTRY["tax_year.account_set"]!.schema!;

/**
 * The latest current account set the user stated (or VestLens imported) for a year before this one: its overrides carry
 * forward while this year has none (owner ruling 2026-10-26). Ties in a year go to the newest recorded. A set that is
 * malformed, or whose outside labels share a key, is skipped, so the next older valid one is used.
 */
function latestEarlierSet(rows: StoredFact[], year: number): MemoryFact | null {
  let best: { row: StoredFact; year: number } | null = null;
  for (const r of rows) {
    const m = /^(\d{4}):tfsa$/.exec(r.nodeKey);
    const y = m ? Number(m[1]) : Number.NaN;
    if (r.property !== "tax_year.account_set" || r.nodeType !== "tax_year" || r.supersededAt !== null || !(y < year)) continue;
    if (r.provenance !== "stated" && r.provenance !== "imported") continue;
    const parsed = SET_SCHEMA.safeParse(r.value);
    if (!parsed.success || outsideLabelCollision((parsed.data as { outside: Array<{ label: string }> }).outside) !== null) continue;
    if (!best || y > best.year || (y === best.year && r.recordedAt.getTime() > best.row.recordedAt.getTime())) best = { row: r, year: y };
  }
  return best ? toMemoryFact(best.row) : null;
}

/** Which classified accounts a room considers: the TFSA room takes TFSAs and neutral accounts, the FHSA room FHSAs. */
export type Include = (c: { bucket: string }, neutral: boolean) => boolean;

/**
 * The stored accounts, activity, transfers, coverage and sync state one room reads (shared by the TFSA and FHSA rooms):
 * every connected account classified and labelled once; the included accounts' activity this year; transfer rows from
 * every connected account, this year ±MATCH_WINDOW_DAYS; coverage and sync for the included accounts.
 */
export async function loadRoomBase(deps: RoomLoaderDeps, authSubject: string, today: string, include: Include, period?: RoomPeriod) {
  // The activity range is [first day, day after the last); without a period it is the Toronto calendar year of `today`.
  const year = Number(today.slice(0, 4));
  const at = (ymd: string, offsetDays: number) => {
    const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
    return new Date(Date.UTC(y, m - 1, d + offsetDays));
  };
  const jan1 = period ? at(period.from, 0) : new Date(Date.UTC(year, 0, 1));
  const nextJan1 = period ? at(period.to, 1) : new Date(Date.UTC(year + 1, 0, 1));
  const rows = await deps.prisma.brokerageAccount.findMany({
    where: { appUser: { authSubject } },
    orderBy: { snapTradeAccountId: "asc" },
    select: {
      snapTradeAccountId: true, displayName: true, institutionName: true, rawType: true, status: true,
      maskedNumber: true, reportedTotal: true, reportedCurrency: true,
      snapshots: { orderBy: { capturedAt: "desc" }, take: 1, select: { payload: true } },
    },
  });
  // Every connected account, classified and labelled once: the room's own accounts and the other side of transfers.
  const classified = rows.map((row) => {
    const parsed = row.snapshots[0] ? snapshotAccount.safeParse(row.snapshots[0].payload) : undefined;
    const account = parsed?.success ? parsed.data.account : undefined;
    const c = classifyPortfolioAccount({
      unifiedType: account?.unifiedType ?? null,
      rawType: account?.type ?? row.rawType,
      metaType: account?.metaType ?? null,
      status: account?.status ?? row.status,
    });
    return { row, c, base: row.displayName?.trim() || `${row.institutionName} ${c.label}`, last4: lastFour(row.maskedNumber) };
  });
  const sharing = new Map<string, number>();
  for (const { base } of classified) sharing.set(base, (sharing.get(base) ?? 0) + 1);
  // Two accounts with one name are told apart by the last 4 of their masked numbers, everywhere the label appears.
  const labelOf = new Map(classified.map(({ row, base, last4 }) =>
    [row.snapTradeAccountId, (sharing.get(base) ?? 0) > 1 && last4 ? `${base} ••${last4}` : base]));
  const accounts: Array<RoomInput["accounts"][number] & { id: string; managed: boolean }> = [];
  for (const { row, c, last4 } of classified) {
    const neutral = c.bucket === "other" && c.label === NEUTRAL_LABEL;
    if (!include(c, neutral)) continue;
    const total = toNumber(row.reportedTotal ?? null);
    const currency = typeof row.reportedCurrency === "string" && row.reportedCurrency.trim() !== "" ? row.reportedCurrency.trim().toUpperCase() : null;
    // `managed` comes from the taxonomy alone (isManagedPortfolio): a managed portfolio has no activity through SnapTrade
    // whether it reports its value as 0 or not at all (A9).
    accounts.push({
      id: row.snapTradeAccountId, accountKey: accountKey(row.snapTradeAccountId), label: labelOf.get(row.snapTradeAccountId)!,
      bucket: c.bucket, neutral, closed: c.isClosed, managed: isManagedPortfolio(c),
      maskedNumber: last4, value: total !== null && currency !== null ? { amount: Math.round(total * 100) / 100, currency } : null,
    });
  }
  const ids = accounts.map((a) => a.id);
  const allIds = rows.map((r) => r.snapTradeAccountId);
  const keyOf = new Map(accounts.map((a) => [a.id, a.accountKey]));

  // Without a period, from MATCH_WINDOW_DAYS before last 27 December: the New Year check matches last December's
  // transfers too. A counterpart that early can't pair with a row of this year (more than MATCH_WINDOW_DAYS apart).
  const lastDecember = priorDecember(year);
  const windowStart = period ? at(period.from, -MATCH_WINDOW_DAYS) : at(lastDecember.from, -MATCH_WINDOW_DAYS);
  const windowEnd = period ? at(period.to, 1 + MATCH_WINDOW_DAYS) : new Date(Date.UTC(year + 1, 0, 1 + MATCH_WINDOW_DAYS));
  const activitySelect = {
    snapTradeAccountId: true, dedupeKey: true, type: true, amount: true, currency: true, fxRate: true, tradeDate: true, units: true, price: true, symbol: true, securityCurrency: true,
  } as const;
  const [activityRows, syncRows, transferRows, decemberRows] = ids.length === 0 ? [[], [], [], []] : await Promise.all([
    deps.prisma.activity.findMany({
      where: {
        appUser: { authSubject },
        snapTradeAccountId: { in: ids },
        // tradeDate is a calendar date (no time zone), so the Toronto year is [1 January, next 1 January).
        OR: [
          { tradeDate: { gte: jan1, lt: nextJan1 } },
          { tradeDate: null, settlementDate: { gte: jan1, lt: nextJan1 } },
          { tradeDate: null, settlementDate: null },
        ],
      },
      orderBy: [{ tradeDate: "asc" }, { dedupeKey: "asc" }],
      select: activitySelect,
    }),
    deps.prisma.activitySyncState.findMany({
      where: { appUser: { authSubject }, snapTradeAccountId: { in: ids } },
      select: { snapTradeAccountId: true, backfillCompletedAt: true, lastSyncedAt: true, lastError: true, dirty: true },
    }),
    deps.prisma.activity.findMany({
      where: {
        appUser: { authSubject },
        snapTradeAccountId: { in: allIds },
        // A transfer within MATCH_WINDOW_DAYS of this year can be the other side of one in it.
        tradeDate: { gte: windowStart, lt: windowEnd },
        OR: [{ type: { in: TRANSFER_TYPES } }, { type: { startsWith: TRANSFER_PREFIX } }],
      },
      orderBy: [{ tradeDate: "asc" }, { dedupeKey: "asc" }],
      select: { snapTradeAccountId: true, dedupeKey: true, type: true, amount: true, currency: true, fxRate: true, tradeDate: true },
    }),
    // The New Year check (no period only): the same accounts' rows dated 27–31 December last year, named, never counted.
    period ? Promise.resolve([]) : deps.prisma.activity.findMany({
      where: { appUser: { authSubject }, snapTradeAccountId: { in: ids }, tradeDate: { gte: at(lastDecember.from, 0), lt: jan1 } },
      orderBy: [{ tradeDate: "asc" }, { dedupeKey: "asc" }],
      select: activitySelect,
    }),
  ]);

  const toRoomActivities = (found: typeof activityRows): RoomInput["activities"] => found.flatMap((r) => {
    const key = keyOf.get(r.snapTradeAccountId);
    return key === undefined ? [] : [{
      accountKey: key, activityKey: activityKey(r.dedupeKey), type: r.type, amount: toNumber(r.amount),
      currency: r.currency, fxRate: toNumber(r.fxRate), tradeDate: calendarDay(r.tradeDate),
      units: toNumber(r.units ?? null), price: toNumber(r.price ?? null), symbol: r.symbol ?? null, securityCurrency: r.securityCurrency ?? null,
    }];
  });
  const activities = toRoomActivities(activityRows);
  const priorDecemberRows = toRoomActivities(decemberRows);
  // Closes for shares moved in kind without a reported price: the period (10 days earlier for a holiday) through today.
  const prices = await roomPrices(deps.market, activities, calendarDay(at(period?.from ?? `${year}-01-01`, -10))!, today);

  // Only rows in an account still connected: the other side is named by that account's label.
  const counterparts: NonNullable<RoomInput["counterparts"]> = transferRows.flatMap((r) => {
    const label = labelOf.get(r.snapTradeAccountId);
    return label === undefined ? [] : [{
      accountKey: accountKey(r.snapTradeAccountId), label, activityKey: activityKey(r.dedupeKey), type: r.type, amount: toNumber(r.amount),
      currency: r.currency, tradeDate: calendarDay(r.tradeDate),
    }];
  });

  const coverage: RoomInput["coverage"] = new Map(accounts.map((a) => [a.accountKey, { coversFrom: null as string | null }]));
  for (const s of syncRows) {
    const key = keyOf.get(s.snapTradeAccountId);
    // SnapTrade's Wealthsimple cutoff is a fixed date in April 2023, set by Wealthsimple and not a rolling
    // window (SnapTrade support, 2026-11-04), so an account first funded after 1 January has no gap this year.
    if (key !== undefined && s.backfillCompletedAt) coverage.set(key, { coversFrom: COVERS_FROM_START });
  }
  const sync: RoomInput["sync"] = new Map();
  for (const s of syncRows) {
    const key = keyOf.get(s.snapTradeAccountId);
    const at = s.lastSyncedAt && !Number.isNaN(s.lastSyncedAt.getTime()) ? s.lastSyncedAt.toISOString() : null;
    // Unknown values fail closed: an error or a pending change unless plainly absent.
    if (key !== undefined) sync.set(key, { lastSyncedAt: at, lastError: s.lastError !== null && s.lastError !== undefined, dirty: s.dirty !== false });
  }

  return { rows, classified, accounts, activities, priorDecember: priorDecemberRows, counterparts, coverage, sync, prices };
}

/** Each activity's current answer (activity.room_effect), newest first: stated, imported or derived only. */
function classificationsOf(effectRows: StoredFact[]): Map<string, UserRoomEffect> {
  const classifications = new Map<string, UserRoomEffect>();
  for (const r of effectRows) {
    if (r.property !== "activity.room_effect" || r.supersededAt !== null || !feeds(r) || classifications.has(r.nodeKey)) continue;
    const v = EFFECT.safeParse(r.value);
    if (v.success) classifications.set(r.nodeKey, (v.data as { effect: UserRoomEffect }).effect);
  }
  return classifications;
}

/** Current facts of one property that may feed numbers (stated, imported or derived). */
const current = (rows: StoredFact[], property: string) => rows.filter((r) => r.property === property && r.supersededAt === null && feeds(r)).map(toMemoryFact);

/** A rate is fetched only when a foreign row exists (the engine asks for one even when a broker rate is present); an in-kind row's security currency counts. */
const needsFx = (activities: RoomInput["activities"]) =>
  activities.some((a) => [a.currency, a.securityCurrency].some((c) => typeof c === "string" && c.trim() !== "" && c.trim().toUpperCase() !== "CAD"));

/** `today` is the Toronto date of `now`, the instant of the read. */
export async function loadRoomInput(deps: RoomLoaderDeps, authSubject: string, today: string, now: Date): Promise<RoomInput> {
  const year = Number(today.slice(0, 4));
  const { rows, accounts, activities, priorDecember: lastDecember, counterparts, coverage, sync, prices } = await loadRoomBase(deps, authSubject, today, (c, neutral) => c.bucket === "tfsa" || neutral);

  const node = `${year}:tfsa`;
  const [craRoom, accountSet, setRows, ytdRows, movesRows, effectRows] = await Promise.all([
    currentFact(deps.memory, authSubject, node, "tax_year.cra_room_jan1"),
    currentFact(deps.memory, authSubject, node, "tax_year.account_set"),
    deps.memory.find(authSubject, { nodeType: "tax_year", property: "tax_year.account_set", take: MAX_FACTS }),
    deps.memory.find(authSubject, { nodeType: "account", property: "account.ytd_contributions", take: MAX_FACTS }),
    deps.memory.find(authSubject, { nodeType: "account", property: "account.tfsa_moves", take: MAX_FACTS }),
    deps.memory.find(authSubject, { nodeType: "activity", property: "activity.room_effect", take: MAX_FACTS }),
  ]);
  const outside = current(ytdRows, "account.ytd_contributions");
  const outsideMoves = current(movesRows, "account.tfsa_moves");
  const classifications = classificationsOf(effectRows);
  const fx = await roomFx(deps.market, today, needsFx([...activities, ...lastDecember]));

  return {
    today,
    memory: { craRoom, accountSet, outside, outsideMoves, classifications },
    previousAccountSet: latestEarlierSet(setRows, year),
    accounts: accounts.map(({ id: _id, ...rest }) => rest),
    activities,
    priorDecember: lastDecember,
    counterparts,
    coverage,
    now: now.toISOString(),
    sync,
    connectedAccountKeys: rows.map((r) => accountKey(r.snapTradeAccountId)),
    fx,
    ...(prices ? { prices } : {}),
  };
}

/**
 * Reads the FHSA room engine's inputs for one auth subject, the same way: every account the taxonomy puts in the FHSA
 * bucket (closed ones included), their activity this year, transfer rows from every connected account, coverage and
 * sync, every connected RRSP's key, this year's `tax_year.fhsa_room` on `<year>:fhsa`, the year-to-date figures on
 * account nodes and the stored transfer answers. `today` is the Toronto date of `now`.
 */
export async function loadFhsaRoomInput(deps: RoomLoaderDeps, authSubject: string, today: string, now: Date): Promise<FhsaRoomInput> {
  const year = Number(today.slice(0, 4));
  const { classified, accounts, activities, priorDecember: lastDecember, counterparts, coverage, sync, prices } = await loadRoomBase(deps, authSubject, today, (c) => c.bucket === "fhsa");
  const base = {
    today, now: now.toISOString(), accounts: accounts.map(({ id: _id, ...rest }) => rest),
    rrspAccountKeys: classified.filter(({ c }) => c.bucket === "rrsp").map(({ row }) => accountKey(row.snapTradeAccountId)),
    activities, priorDecember: lastDecember, counterparts, coverage, sync, ...(prices ? { prices } : {}),
  };
  // No FHSA: the engine answers "none" without memory or a rate.
  if (accounts.length === 0) return { ...base, memory: { participationRoom: null, outside: [], classifications: new Map() }, fx: { toCad: () => null } };
  const [participationRoom, ytdRows, effectRows] = await Promise.all([
    currentFact(deps.memory, authSubject, `${year}:fhsa`, "tax_year.fhsa_room"),
    deps.memory.find(authSubject, { nodeType: "account", property: "account.ytd_contributions", take: MAX_FACTS }),
    deps.memory.find(authSubject, { nodeType: "activity", property: "activity.room_effect", take: MAX_FACTS }),
  ]);
  return {
    ...base,
    memory: { participationRoom, outside: current(ytdRows, "account.ytd_contributions"), classifications: classificationsOf(effectRows) },
    fx: await roomFx(deps.market, today, needsFx([...activities, ...lastDecember])),
  };
}

/**
 * Reads the RRSP room engine's inputs the same way: every account the taxonomy puts in the RRSP bucket (closed and
 * managed ones included, `managed` from loadRoomBase), their activity from the first open tax year's window start
 * through today, transfer rows from every connected account across that period ±MATCH_WINDOW_DAYS, coverage and sync,
 * every connected FHSA's key, each open year's three facts on `<Y>:rrsp` and the stored transfer answers. `today` is
 * the Toronto date of `now`.
 */
export async function loadRrspRoomInput(deps: RoomLoaderDeps, authSubject: string, today: string, now: Date): Promise<RrspRoomInput> {
  const windows = openTaxYears(today);
  const empty = {
    today, now: now.toISOString(), accounts: [], fhsaAccountKeys: [], activities: [], counterparts: [],
    coverage: new Map(), sync: new Map(), memory: { byYear: new Map(), classifications: new Map() }, fx: { toCad: () => null },
  } satisfies RrspRoomInput;
  // No window is open (before CRA's published table): nothing to read.
  if (windows.length === 0) return empty;
  const period = { from: windows[0]!.from, to: today };
  const { classified, accounts, activities, counterparts, coverage, sync, prices } = await loadRoomBase(deps, authSubject, today, (c) => c.bucket === "rrsp", period);
  const fhsaAccountKeys = classified.filter(({ c }) => c.bucket === "fhsa").map(({ row }) => accountKey(row.snapTradeAccountId));
  // No RRSP: the engine answers "none" without memory or a rate.
  if (accounts.length === 0) return { ...empty, fhsaAccountKeys };
  const [byYear, effectRows] = await Promise.all([
    Promise.all(windows.map(async (w) => {
      const node = `${w.taxYear}:rrsp`;
      const [limit, unused, elsewhere] = await Promise.all([
        currentFact(deps.memory, authSubject, node, "tax_year.rrsp_deduction_limit"),
        currentFact(deps.memory, authSubject, node, "tax_year.rrsp_unused_contributions"),
        currentFact(deps.memory, authSubject, node, "tax_year.rrsp_elsewhere"),
      ]);
      return [w.taxYear, { limit, unused, elsewhere }] as const;
    })),
    deps.memory.find(authSubject, { nodeType: "activity", property: "activity.room_effect", take: MAX_FACTS }),
  ]);
  return {
    today, now: now.toISOString(),
    accounts: accounts.map(({ id: _id, ...rest }) => rest),
    fhsaAccountKeys, activities, counterparts, coverage, sync, ...(prices ? { prices } : {}),
    memory: { byYear: new Map(byYear), classifications: classificationsOf(effectRows) },
    fx: await roomFx(deps.market, today, needsFx(activities)),
  };
}

/** What went in and out of each broker-labelled TFSA over its whole stored history (tfsa-lifetime.ts). */
export async function loadTfsaLifetime(deps: RoomLoaderDeps, authSubject: string, today: string): Promise<TfsaLifetime> {
  const { accounts, coverage } = await loadRoomBase(deps, authSubject, today, (c) => c.bucket === "tfsa");
  const ids = accounts.map((a) => a.id);
  const rows = ids.length === 0 ? [] : await deps.prisma.activity.findMany({
    where: { appUser: { authSubject }, snapTradeAccountId: { in: ids } },
    orderBy: [{ tradeDate: "asc" }, { dedupeKey: "asc" }],
    select: {
      snapTradeAccountId: true, dedupeKey: true, type: true, amount: true, currency: true, fxRate: true, tradeDate: true,
      units: true, price: true, symbol: true, securityCurrency: true, isOption: true, fee: true, settlementDate: true,
    },
  });
  const stored = rows.flatMap((r): StoredActivity[] => (r.type === null ? [] : [{
    snapTradeAccountId: r.snapTradeAccountId, dedupeKey: r.dedupeKey, type: r.type, symbol: r.symbol ?? null, securityCurrency: r.securityCurrency ?? null,
    isOption: r.isOption === true, units: toNumber(r.units ?? null), price: toNumber(r.price ?? null), amount: toNumber(r.amount), fee: toNumber(r.fee ?? null),
    fxRate: toNumber(r.fxRate), currency: r.currency, tradeDate: calendarDay(r.tradeDate), settlementDate: calendarDay(r.settlementDate ?? null), description: null,
  }]));
  const earliest = stored.map((r) => r.tradeDate ?? r.settlementDate).filter((d): d is string => d !== null).sort()[0] ?? today;
  const foreign = stored.some((r) => r.currency && r.currency.trim().toUpperCase() !== "CAD");
  const fx = foreign && deps.market ? await loadHomeConverter(deps.market, earliest, today) : homeConverter(null, today);
  return computeTfsaLifetime(
    accounts.map((a) => ({ id: a.id, label: a.label, managed: a.managed, backfilled: coverage.get(a.accountKey)?.coversFrom === COVERS_FROM_START })),
    stored,
    (amount, currency, date) => { const at = fx.at(amount, currency, date); return { cad: at.amount, estimated: at.estimated }; },
  );
}
