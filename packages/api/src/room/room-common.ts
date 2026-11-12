import type { MemoryFact, Provenance } from "../memory/memory-types.js";
import { PROPERTY_REGISTRY } from "../memory/memory-types.js";
import type { LedgerMove } from "./tfsa-ledger.js";
import { classifyActivity, isTransferType, type RoomEffect, type UserRoomEffect } from "./tfsa-rules.js";

/**
 * What the TFSA and FHSA room engines share (pure, no DB, no network, no clock): dates, CAD conversion, the 7-day
 * freshness rule, the coverage gate, transfer matching, the `answerable` rule and the classification of a year's
 * activity in a set of accounts. Each engine keeps its own room rule and its own ledger options.
 */

/**
 * Coverage meaning "from the account's very start". Once an account's full activity backfill has completed, its
 * stored activity is its complete history, so an account first funded after 1 January has no gap to fill: its first
 * stored trade is its first trade ever (owner ruling 2026-10-26). The loader passes this instead of the earliest trade.
 */
export const COVERS_FROM_START = "0001-01-01";

/** A transfer pairs with the other side of the move only within this many days (owner ruling 2026-10-26). */
export const MATCH_WINDOW_DAYS = 3;

/**
 * The New Year check (owner ruling 2026-11-03). SnapTrade gives one timestamp per row, stored as its UTC day, while a
 * brokerage may record a contribution made in the last days of December in the next year (a transfer settling after
 * the holidays), and one made after 7 p.m. Toronto time on 31 December is stored as 1 January. So a contribution dated
 * 27–31 December or 1 January may count, at the brokerage and at CRA, in the neighbouring year. It is named, never
 * moved: the room still counts it by its stored date.
 */
export const NEW_YEAR_DECEMBER_FROM = 27;

/** 27–31 December of the year before `year`: the stored rows the New Year check reads from last year. */
export const priorDecember = (year: number): RoomPeriod => ({ from: `${year - 1}-12-${NEW_YEAR_DECEMBER_FROM}`, to: `${year - 1}-12-31` });

/** A contribution near New Year: the year VestLens counts it in, and the one the brokerage may record it in instead. */
export interface NewYearRow {
  date: string; label: string; amountCad: number; estimated: boolean; rateDate: string | null;
  native: { amount: number; currency: string } | null; countedIn: number; mayCountIn: number;
}

/**
 * The contributions near New Year, oldest first: last year's 27–31 December ones (from `lastDecember`, a tally over
 * priorDecember(year)), then this year's 1 January and 27–31 December ones (from this year's tally). Only rows that
 * count as a contribution with a CAD amount: a move between the user's own accounts uses no room in either year.
 */
export function newYearRows(year: number, thisYear: readonly LedgerMove[], lastDecember: readonly LedgerMove[]): NewYearRow[] {
  const row = (m: LedgerMove, countedIn: number, mayCountIn: number): NewYearRow =>
    ({ date: m.date!, label: m.label, amountCad: m.amountCad!, estimated: m.estimated, rateDate: m.rateDate, native: m.native, countedIn, mayCountIn });
  const contribution = (m: LedgerMove) => m.kind === "contribution" && m.activityKey !== undefined && m.date !== null && m.amountCad !== null;
  const { from, to } = priorDecember(year);
  const december = `${year}-12-${NEW_YEAR_DECEMBER_FROM}`;
  return [
    ...lastDecember.filter((m) => contribution(m) && m.date! >= from && m.date! <= to).map((m) => row(m, year - 1, year)),
    ...thisYear.filter((m) => contribution(m) && m.date === `${year}-01-01`).map((m) => row(m, year, year - 1)),
    ...thisYear.filter((m) => contribution(m) && m.date! >= december && m.date! <= `${year}-12-31`).map((m) => row(m, year, year + 1)),
  ].sort((a, b) => a.date.localeCompare(b.date));
}

/** A connected account's activity must have synced within this many days for a number to be shown (owner ruling 2026-10-26). */
export const MAX_ACTIVITY_AGE_DAYS = 7;
const MAX_ACTIVITY_AGE_MS = MAX_ACTIVITY_AGE_DAYS * 24 * 3_600_000;

export const MAX_AMBIGUOUS_ROWS = 5;
/**
 * A broker fxRate is trusted only while its CAD value is within this fraction of the Bank of Canada value: a real
 * settlement spread, not a stale or mis-reported rate (A10). Anything further off is converted at the Bank of Canada
 * rate and marked est. with its date.
 */
const BROKER_RATE_TOLERANCE = 0.02;

/** A transfer row in any of the user's connected accounts (in the set or not), for matching; labels follow the loader's rule. */
export interface RoomCounterpart {
  accountKey: string;
  label: string;
  activityKey: string;
  type: string | null;
  amount: number | null;
  currency: string | null;
  tradeDate: string | null;
}

/**
 * One stored activity row in an account the room considers. `units`, `price`, `symbol` and `securityCurrency` value a
 * TRANSFER row of shares moved in kind (amount 0, the shares in units), as SnapTrade reports it (A2).
 */
export interface RoomActivity {
  accountKey: string; activityKey: string; type: string | null; amount: number | null; currency: string | null; fxRate: number | null; tradeDate: string | null;
  units?: number | null; price?: number | null; symbol?: string | null; securityCurrency?: string | null;
}

/** Bank of Canada conversion for a trade date; `rateDate` is the date of the close used (an earlier day on a holiday). */
export interface RoomFxPort { toCad(amount: number, currency: string, date: string): { cad: number; estimated: boolean; rateDate?: string | null } | null }

/** A security's close on or before a date, in its own currency, for an in-kind row with no reported price (A2). */
export interface RoomPricePort { closeOn(row: RoomActivity, date: string): { price: number; currency: string } | null }

/** A TRANSFER row of shares moved in kind: units with no cash amount. */
export function isInKind(row: RoomActivity): boolean {
  return isTransferType(row.type) && typeof row.units === "number" && Number.isFinite(row.units) && row.units !== 0 && (row.amount === null || row.amount === 0);
}

/**
 * The row the tally classifies and converts. An in-kind TRANSFER row is valued at units × the row's price (in the row
 * currency, as SnapTrade reports it), else units × that day's close (est.); with neither it has no amount at all, so it
 * stays a question and an answer of "contribution" can never add $0 (A2). Any other row is itself.
 */
export function valuedRow(row: RoomActivity, prices: RoomPricePort | undefined, date: string | null): { row: RoomActivity; inKind: boolean; fromClose: boolean } {
  if (!isInKind(row)) return { row, inKind: false, fromClose: false };
  const units = row.units!;
  if (typeof row.price === "number" && Number.isFinite(row.price) && row.price > 0) {
    return { row: { ...row, amount: cents(units * row.price), currency: row.currency ?? row.securityCurrency ?? null }, inKind: true, fromClose: false };
  }
  const close = date === null ? null : prices?.closeOn(row, date) ?? null;
  if (close && Number.isFinite(close.price) && close.price > 0) return { row: { ...row, amount: cents(units * close.price), currency: close.currency }, inKind: true, fromClose: true };
  return { row: { ...row, amount: null }, inKind: true, fromClose: false };
}

/** accountKey → its activity sync state; an account with no entry has never synced. lastSyncedAt is an ISO instant. */
export type RoomSync = Map<string, { lastSyncedAt: string | null; lastError: boolean; dirty: boolean }>;

/** How a CAD total was reached from foreign rows: Bank of Canada rate dates used (est.) and native amounts per currency. */
export interface FxSummary {
  estimated: boolean;
  rateDates: string[];
  /** Foreign rows' magnitudes summed per currency (broker-rate and Bank of Canada conversions alike), by currency. */
  native: Array<{ amount: number; currency: string }>;
}

export interface AmbiguousRow {
  activityKey: string;
  /** YYYY-MM-DD, or "unknown". */
  date: string;
  amountCad: number | null;
  /** True when amountCad uses a Bank of Canada rate (rateDate) rather than the broker's own. */
  estimated: boolean;
  rateDate: string | null;
  /** The row's own amount and currency (signed), or null without both. */
  native: { amount: number; currency: string } | null;
  /** The activity type as stored, or "UNKNOWN". */
  type: string;
  label: string;
  /**
   * Shares moved in kind with no reported price and no close: the row has no amount, so an answer alone can't give it
   * one; the account's stated year-to-date figure as of a later date stands in for it (`inKindFigures`). `accountKey`
   * is the account to state that figure on.
   */
  inKind?: true;
  accountKey?: string;
}

export type StaleItem = { kind: "stale_activity"; label: string; accountKey: string; lastSyncedAt: string | null };
export type CoverageItem = { kind: "coverage"; label: string; accountKey: string };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TORONTO_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });
/** The Toronto calendar date (YYYY-MM-DD) of an instant. */
export const torontoDate = (at: Date) => TORONTO_DAY.format(at);

/** The year of a real YYYY-MM-DD calendar date, or null. */
export function yearOf(date: string | null): number | null {
  if (typeof date !== "string") return null;
  const m = DAY.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // setUTCFullYear, not Date.UTC: Date.UTC reads years 0-99 as 1900-1999, which would reject COVERS_FROM_START.
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? y : null;
}

/** An inclusive range of Toronto calendar dates (YYYY-MM-DD) a room is tallied over: a TFSA/FHSA year, an RRSP tax year. */
export type RoomPeriod = { from: string; to: string };

/** True when a real YYYY-MM-DD date falls in the period; a number is that calendar year. A missing or invalid date is in none. */
export function inPeriod(date: string | null, period: number | RoomPeriod): boolean {
  const y = yearOf(date);
  if (y === null) return false;
  return typeof period === "number" ? y === period : date! >= period.from && date! <= period.to;
}

/** Whole days between two real YYYY-MM-DD dates. */
function daysBetween(a: string, b: string): number {
  const at = (ymd: string) => {
    const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
    const t = new Date(0);
    t.setUTCFullYear(y, m - 1, d);
    return t.getTime();
  };
  return Math.round(Math.abs(at(a) - at(b)) / 86_400_000);
}

/** The calendar day before a YYYY-MM-DD date. */
export function dayBefore(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

export const cents = (n: number) => Math.round(n * 100) / 100;
export const money = (n: number) =>
  `$${n.toLocaleString("en-CA", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
/** A native amount: US$1,000 for USD, otherwise "<code> 1,000". */
/** "INTERNAL_CASH_TRANSFER_IN" reads as "transfer in": broker type codes never reach the user verbatim. */
export function activityTypeLabel(type: string): string {
  const t = type.toUpperCase();
  if (/^(INTERNAL_CASH_)?TRANSFER_IN/.test(t)) return "transfer in";
  if (/^(INTERNAL_CASH_)?TRANSFER_OUT/.test(t)) return "transfer out";
  return t.replace(/_/g, " ").toLowerCase();
}

export function nativeMoney(amount: number, currency: string): string {
  const sign = amount < 0 ? "-" : "";
  const digits = Math.abs(amount).toLocaleString("en-CA", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 });
  return currency === "USD" ? `${sign}US$${digits}` : `${sign}${currency} ${digits}`;
}

/**
 * A converted amount: "$1,350 (est., BoC 2026-03-02; US$1,000)", or "$1,370 (US$1,000 at the broker's rate)". CAD is
 * plain, or "(est.)" when the CAD value is itself an estimate (shares valued at a day's close, A2).
 */
export function convertedMoney(cad: string, c: { estimated: boolean; rateDate: string | null; native: { amount: number; currency: string } | null }): string {
  if (!c.native || c.native.currency === "CAD") return c.estimated ? `${cad} (est.)` : cad;
  const native = nativeMoney(c.native.amount, c.native.currency);
  return c.estimated ? `${cad} (est., BoC ${c.rateDate ?? "date unknown"}; ${native})` : `${cad} (${native} at the broker's rate)`;
}

export class FxTally {
  private estimated = false;
  private readonly dates = new Set<string>();
  private readonly native = new Map<string, number>();
  add(currency: string, magnitude: number, conversion: { estimated: boolean; rateDate: string | null }): void {
    if (currency === "CAD") return;
    this.native.set(currency, cents((this.native.get(currency) ?? 0) + magnitude));
    if (conversion.estimated) {
      this.estimated = true;
      if (conversion.rateDate) this.dates.add(conversion.rateDate);
    }
  }
  summary(): FxSummary {
    return {
      estimated: this.estimated,
      rateDates: [...this.dates].sort(),
      native: [...this.native].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([currency, amount]) => ({ amount, currency })),
    };
  }
}

/** Conversions behind contributedCad and withdrawnCad; fxDates is every Bank of Canada rate date used. */
export type RoomFx = { fx: { contributions: FxSummary; withdrawals: FxSummary }; fxDates: string[] };
export function fxInfo(contributionFx: FxTally, withdrawalFx: FxTally): RoomFx {
  const contributions = contributionFx.summary();
  const withdrawals = withdrawalFx.summary();
  return { fx: { contributions, withdrawals }, fxDates: [...new Set([...contributions.rateDates, ...withdrawals.rateDates])].sort() };
}

export const said = (p: Provenance) => (p === "imported" ? "imported" : p === "derived" ? "from your brokerage data" : "you said");

export function usable(f: MemoryFact | null | undefined, property: string, nodeType: string, key: string | null, provenances: Provenance[]): f is MemoryFact {
  return !!f && f.supersededAt === null && f.property === property && f.node.type === nodeType && (key === null || f.node.key === key)
    && provenances.includes(f.provenance);
}

export const FEEDS: Provenance[] = ["stated", "imported", "derived"];

/**
 * Signed CAD for a money row (the sign is the row's own). A foreign row needs a Bank of Canada value from the port:
 * the broker rate is used (exact) only when it agrees with it, otherwise the Bank of Canada value (estimated).
 * With no Bank of Canada value a foreign row is null (ambiguous), whatever its broker rate.
 */
export type Conversion = { cad: number; estimated: boolean; rateDate: string | null; currency: string };
export function toCad(row: RoomActivity, fx: RoomFxPort, date: string): Conversion | null {
  if (typeof row.amount !== "number" || !Number.isFinite(row.amount)) return null;
  const amount = row.amount;
  const currency = typeof row.currency === "string" ? row.currency.trim().toUpperCase() : "";
  if (currency.length === 0) return null;
  if (currency === "CAD") return { cad: amount, estimated: false, rateDate: null, currency };
  const sign = amount < 0 ? -1 : 1;
  const magnitude = Math.abs(amount);
  const reference = fx.toCad(magnitude, currency, date);
  // A non-zero amount needs a positive Bank of Canada value; zero, negative or NaN is no rate at all.
  const usableBoc = reference !== null && Number.isFinite(reference.cad) && (magnitude === 0 ? reference.cad >= 0 : reference.cad > 0);
  const boc = usableBoc ? { cad: sign * reference.cad, estimated: true, rateDate: reference.rateDate ?? null, currency } : null;
  const rate = row.fxRate;
  // A foreign row reported at exactly 1 almost always means "no conversion recorded", not a real rate.
  if (typeof rate === "number" && Number.isFinite(rate) && rate > 0 && rate !== 1) {
    const broker = magnitude * rate;
    if (boc) {
      const ref = Math.abs(boc.cad);
      if (ref > 0 && Math.abs(broker - ref) / ref <= BROKER_RATE_TOLERANCE) return { cad: sign * broker, estimated: false, rateDate: null, currency };
    }
  }
  return boc;
}

/**
 * The one rule for which rows take an answer (activity.room_effect): the row's table classification, ignoring any
 * stored answer, is ambiguous (unclear and transfer types, a missing amount, date or type, a sign mismatch), or it is
 * a contribution or withdrawal that can't be converted to CAD. A stored answer on any other row is ignored entirely.
 * The engine, the ledger's `answered` flag, the step-4 queue and the dashboard's PUT and DELETE all use this rule.
 */
export function answerable(row: RoomActivity, fx: RoomFxPort): boolean {
  const date = yearOf(row.tradeDate) === null ? null : row.tradeDate;
  const table = classifyActivity({ ...row, tradeDate: date });
  if (table === "ambiguous") return true;
  return (table === "contribution" || table === "withdrawal") && toCad(row, fx, date!) === null;
}

/**
 * Freshness: every open account in the set synced within MAX_ACTIVITY_AGE_DAYS, without error. A closed one is exempt.
 * `dirty` is not a gate: any webhook sets it on every account, and the as-of line already says how current it is.
 * Returns the stale items in the set's order and the oldest sync time of the fresh ones.
 */
export function freshness(
  set: ReadonlyMap<string, string>, accounts: ReadonlyArray<{ accountKey: string; closed?: boolean }>, sync: RoomSync, nowMs: number, ignore = false,
): { stale: StaleItem[]; activityAsOfMs: number | null } {
  const stale: StaleItem[] = [];
  let activityAsOfMs: number | null = null;
  const closed = new Set(accounts.filter((a) => a.closed === true).map((a) => a.accountKey));
  for (const [key, label] of ignore ? [] : set) {
    if (closed.has(key)) continue;
    const s = sync.get(key);
    const at = s?.lastSyncedAt ? Date.parse(s.lastSyncedAt) : Number.NaN;
    const lastSyncedAt = Number.isFinite(at) ? new Date(at).toISOString() : null;
    if (!s || s.lastError || lastSyncedAt === null || nowMs - at > MAX_ACTIVITY_AGE_MS) {
      stale.push({ kind: "stale_activity", label, accountKey: key, lastSyncedAt });
      continue;
    }
    if (activityAsOfMs === null || at < activityAsOfMs) activityAsOfMs = at;
  }
  return { stale, activityAsOfMs };
}

const OUTSIDE_SCHEMA = PROPERTY_REGISTRY["account.ytd_contributions"]!.schema!;

/** The newest usable year-to-date figure (account.ytd_contributions) for this year on an account node. */
export function ytdFigure(facts: readonly MemoryFact[], key: string, provenances: Provenance[], year: number):
  { f: MemoryFact; amountCad: number; asOf: string } | undefined {
  const best = facts
    .filter((f) => usable(f, "account.ytd_contributions", "account", key, provenances))
    .map((f) => ({ f, v: OUTSIDE_SCHEMA.safeParse(f.value) }))
    .filter((x) => x.v.success && (x.v.data as { year: number }).year === year)
    .sort((a, b) => b.f.recordedAt.getTime() - a.f.recordedAt.getTime())[0];
  if (!best) return undefined;
  const v = best.v.data as { amountCad: number; asOf: string };
  return { f: best.f, amountCad: v.amountCad, asOf: v.asOf };
}

/**
 * The newest stated or imported year-to-date figure on a key that can speak for the year so far: its asOf is within the
 * year, on or before today and on or before the Toronto date it was recorded. Used for an account whose activity the
 * room can't read at all: one no longer connected, or a managed portfolio (SnapTrade gives no activity for it, A9).
 */
export function credibleYtd(facts: readonly MemoryFact[], key: string, year: number, today: string):
  { amountCad: number; asOf: string; provenance: Provenance } | undefined {
  const figure = ytdFigure(facts, key, ["stated", "imported"], year);
  if (!figure) return undefined;
  const { asOf } = figure;
  if (yearOf(asOf) !== year || asOf > today || asOf > torontoDate(figure.f.recordedAt)) return undefined;
  return { amountCad: figure.amountCad, asOf, provenance: figure.f.provenance };
}

/** A managed portfolio's basis line: its activity isn't visible, so it is never a "Connected" account (A9). */
export const managedBasis = (program: string, label: string) => `Managed ${program}: ${label}; contributions to it aren't visible through SnapTrade`;
/** A managed account with no saved figure: named beside a number computed without it (owner ruling 2026-10-31). */
export type NotCounted = { accountKey: string; label: string };
/** "A ••1111 and ••2222": labels told apart only by their last 4 are shortened after the first. */
function notCountedNames(items: ReadonlyArray<{ label: string }>): string {
  const base = (label: string) => label.split(" ••")[0]!;
  const names = items.map((a, i) => (i > 0 && a.label.includes(" ••") && base(a.label) === base(items[i - 1]!.label) ? `••${a.label.split(" ••")[1]}` : a.label));
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
/**
 * The line under a room number that leaves out managed accounts. We can't assume a $0 managed account is empty (SnapTrade
 * can report 0 for one that holds money), so it says so for every one of them. Mirrored in web roomFormat.ts and the card's format.ts.
 */
export function notCountedLine(items: ReadonlyArray<{ label: string }>, over = false): string {
  const them = items.length === 1 ? "it" : "them";
  const effect = over ? "the amount over is higher than this" : "your room is lower than this";
  return `Not counted: ${notCountedNames(items)}. Contributions to ${them} aren't visible through SnapTrade. If you contributed to ${them} this year, ${effect}.`;
}
/** The alert row's words for the same accounts: "(not counting A, so it could be more)". */
export function notCountedNote(items: ReadonlyArray<{ label: string }>): string {
  const names = notCountedNames(items);
  // The alert row's note column is 400 characters, shared with the conversion note.
  return `(not counting ${names.length <= 150 ? names : "your managed accounts"}, so it could be more)`;
}

/** The basis line for a managed portfolio's stated year-to-date figure, which stands in for its invisible activity. */
export const managedFigureBasis = (label: string, amountCad: number, asOf: string, provenance: Provenance) =>
  `${label}: ${money(amountCad)} contributed this year as of ${asOf} (${said(provenance)}; contributions to it aren't visible through SnapTrade)`;

/**
 * Coverage from 1 January for each account in the set, or that account's stated (or imported) year-to-date figure as of
 * a date the stored activity reaches (no gap between them). The figure can only speak for days already past when it was
 * given: its asOf must be within its year, on or before today and on or before the Toronto date it was recorded. Then it
 * must reach the stored activity: as of the day before that starts or later (or today, when coverage is unknown).
 */
export function coverageGate(
  set: ReadonlyMap<string, string>, coverage: Map<string, { coversFrom: string | null }>, facts: readonly MemoryFact[], today: string,
): { missing: CoverageItem[]; figures: RoomFigure[] } {
  const year = yearOf(today)!;
  const jan1 = `${year}-01-01`;
  const missing: CoverageItem[] = [];
  const figures: RoomFigure[] = [];
  for (const [key, label] of set) {
    const raw = coverage.get(key)?.coversFrom ?? null;
    const from = raw !== null && yearOf(raw) !== null ? raw : null;
    if (from !== null && from <= jan1) continue;
    const figure = ytdFigure(facts, key, ["stated", "imported"], year);
    const asOf = figure?.asOf ?? null;
    const credible = asOf !== null && yearOf(asOf) === year && asOf <= today && asOf <= torontoDate(figure!.f.recordedAt);
    const bridged = credible && (from !== null ? asOf! >= dayBefore(from) : asOf! >= today);
    if (!figure || !bridged) {
      missing.push({ kind: "coverage", label, accountKey: key });
      continue;
    }
    const gap = from !== null ? `stored activity starts ${from}` : "stored activity does not reach 1 January";
    figures.push({ key, label, amountCad: figure.amountCad, asOf: asOf!, provenance: figure.f.provenance, gap });
  }
  return { missing, figures };
}

/** A coverage-style figure: the account's stated year-to-date contributions, standing for its rows before `asOf`. */
export type RoomFigure = { key: string; label: string; amountCad: number; asOf: string; provenance: Provenance; gap: string };

/**
 * The way out of shares moved in kind with no reported price and no close (review 3): such a row has no amount, so an
 * answer alone can never add one. For each set account not already standing on a figure, the account's credible stated
 * (or imported) year-to-date figure dated on or after the row stands in for it, exactly as a coverage figure does: the
 * figure counts, rows before its asOf only report withdrawals. A priced or close-valued row never needs it.
 */
export function inKindFigures(
  set: ReadonlyMap<string, string>, activities: readonly RoomActivity[], period: number | RoomPeriod, prices: RoomPricePort | undefined,
  facts: readonly MemoryFact[], today: string, already: ReadonlySet<string>,
): RoomFigure[] {
  const year = yearOf(today)!;
  const unvalued = new Map<string, string>(); // accountKey → the latest such row's date
  for (const row of activities) {
    if (!set.has(row.accountKey) || already.has(row.accountKey) || !inPeriod(row.tradeDate, period) || !isInKind(row)) continue;
    if (valuedRow(row, prices, row.tradeDate).row.amount !== null) continue;
    const latest = unvalued.get(row.accountKey);
    if (latest === undefined || row.tradeDate! > latest) unvalued.set(row.accountKey, row.tradeDate!);
  }
  const figures: RoomFigure[] = [];
  for (const [key, date] of unvalued) {
    const figure = credibleYtd(facts, key, year, today);
    if (!figure || figure.asOf < date) continue;
    figures.push({ key, label: set.get(key)!, ...figure, gap: `stands in for shares moved in kind on ${date} with no price` });
  }
  return figures;
}

/** The other side of a matched transfer, and whether it is in the room's own set of accounts (a move within the set). */
export type TransferMatch = { label: string; date: string; betweenSet: boolean; accountKey: string };

/** One transfer leg in the matching: an unanswered set row (`candidate`), a counterpart (`pooled`), or both. */
interface Leg { key: string; accountKey: string; amount: number; currency: string; tradeDate: string; label: string; index: number; candidate: boolean; pooled: boolean }

/**
 * Pairs each unanswered transfer in the set with the other side of the move: a transfer row in a different account of the
 * same user, with the opposite sign, the same currency and magnitude to the cent, dated within MATCH_WINDOW_DAYS.
 * The pairing is a maximum matching of out legs to in legs (augmenting paths, as analytics/flows.ts pairs them), so as
 * many legs pair as the rows allow, whatever order they come in: TFSA1 -> Cash -> TFSA2 on one day pairs each TFSA leg
 * with a Cash leg (a withdrawal and a contribution, as CRA treats money that passes through a non-registered account),
 * never the two TFSA legs with each other and the Cash legs with nothing (A1); a direct TFSA1 -> TFSA2 beside a same-day
 * Cash -> TFSA1 of the same size pairs all four legs, one contribution and one move within the set, never two
 * contributions. Legs are visited by date, then input order, and an out leg tries the closest in leg first: this only
 * breaks ties between equally large matchings. A set row pairs with a counterpart (the loader lists every account's
 * transfers, the set's own included); two counterparts outside the set never pair with each other. A row the user
 * answered is never matched (their answer wins), though it can still be the other side of a match: answered `none`, the
 * pairing stands; answered `contribution` or `withdrawal`, the pair is released and the unanswered side stays ambiguous
 * (calling it a move within the set would contradict the answer, and either other reading is a guess). Nothing here is stored.
 */
export function matchTransfers(
  activities: readonly RoomActivity[], counterparts: readonly RoomCounterpart[] | undefined, set: ReadonlyMap<string, string>, period: number | RoomPeriod,
  classifications: ReadonlyMap<string, UserRoomEffect>,
): Map<string, TransferMatch> {
  const currencyOf = (c: string | null) => (typeof c === "string" ? c.trim().toUpperCase() : "");
  const centsOf = (n: number) => Math.round(n * 100);
  const usableRow = (r: { type: string | null; amount: number | null; currency: string | null; tradeDate: string | null }) =>
    isTransferType(r.type) && typeof r.amount === "number" && Number.isFinite(r.amount) && centsOf(r.amount) !== 0
    && currencyOf(r.currency).length > 0 && yearOf(r.tradeDate) !== null;
  const seen = new Set<string>();
  const candidates = activities.filter((r) => {
    if (!set.has(r.accountKey) || seen.has(r.activityKey)) return false;
    seen.add(r.activityKey);
    return inPeriod(r.tradeDate, period) && !classifications.has(r.activityKey) && usableRow(r);
  });
  const candidateKeys = new Set(candidates.map((r) => r.activityKey));
  const legs = new Map<string, Leg>();
  for (const c of counterparts ?? []) {
    if (legs.has(c.activityKey) || !usableRow(c)) continue;
    legs.set(c.activityKey, { key: c.activityKey, accountKey: c.accountKey, amount: c.amount!, currency: currencyOf(c.currency), tradeDate: c.tradeDate!, label: c.label, index: legs.size, candidate: candidateKeys.has(c.activityKey), pooled: true });
  }
  for (const r of candidates) {
    if (legs.has(r.activityKey)) continue;
    legs.set(r.activityKey, { key: r.activityKey, accountKey: r.accountKey, amount: r.amount!, currency: currencyOf(r.currency), tradeDate: r.tradeDate!, label: set.get(r.accountKey)!, index: legs.size, candidate: true, pooled: false });
  }
  const gap = (a: Leg, b: Leg) => daysBetween(a.tradeDate, b.tradeDate);
  // Two legs of one move: at least one is a set row to pair, and the other side is a listed counterpart.
  const pairable = (x: Leg, y: Leg) =>
    x.accountKey !== y.accountKey && x.currency === y.currency && centsOf(x.amount) === -centsOf(y.amount) && gap(x, y) <= MATCH_WINDOW_DAYS
    && ((x.candidate && y.pooled) || (y.candidate && x.pooled));
  const byDate = (a: Leg, b: Leg) => (a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : a.index - b.index);
  const outs = [...legs.values()].filter((l) => l.amount < 0).sort(byDate);
  const ins = [...legs.values()].filter((l) => l.amount > 0).sort(byDate);
  const partnerOf = new Map<Leg, Leg>(); // in leg → its out leg
  // Greedy first, closest dates first (then the earlier legs), so the closest date wins a tie...
  const edges = outs.flatMap((out) => ins.filter((into) => pairable(out, into)).map((into) => ({ out, into })));
  edges.sort((a, b) => gap(a.out, a.into) - gap(b.out, b.into) || byDate(a.out, b.out) || byDate(a.into, b.into));
  const matchedOuts = new Set<Leg>();
  for (const { out, into } of edges) {
    if (matchedOuts.has(out) || partnerOf.has(into)) continue;
    partnerOf.set(into, out);
    matchedOuts.add(out);
  }
  // ...then augmenting paths for the legs left over, which only rearrange pairs when that pairs more legs.
  const assign = (out: Leg, visited: Set<Leg>): boolean => {
    const options = ins.filter((into) => !visited.has(into) && pairable(out, into)).sort((a, b) => gap(out, a) - gap(out, b) || byDate(a, b));
    for (const into of options) {
      visited.add(into);
      const current = partnerOf.get(into);
      if (current === undefined || assign(current, visited)) { partnerOf.set(into, out); return true; }
    }
    return false;
  };
  for (const out of outs) if (!matchedOuts.has(out)) assign(out, new Set());
  const matches = new Map<string, TransferMatch>();
  for (const [into, out] of partnerOf) {
    for (const [row, other] of [[out, into], [into, out]] as const) {
      if (!row.candidate) continue;
      const answer = set.has(other.accountKey) ? classifications.get(other.key) : undefined;
      if (answer === "contribution" || answer === "withdrawal") continue; // released: this side waits for its own answer
      matches.set(row.key, { label: other.label, date: other.tradeDate, betweenSet: set.has(other.accountKey), accountKey: other.accountKey });
    }
  }
  return matches;
}

/** What tallyActivity needs: the set's rows, the other sides of transfers, the user's answers, the FX port and closes for in-kind rows. */
export interface ActivitySource {
  activities: readonly RoomActivity[];
  counterparts?: readonly RoomCounterpart[];
  classifications: ReadonlyMap<string, UserRoomEffect>;
  fx: RoomFxPort;
  prices?: RoomPricePort;
}

export interface ActivityTally {
  moves: LedgerMove[];
  ambiguous: AmbiguousRow[];
  contributedCad: number;
  withdrawnCad: number;
  estimated: boolean;
  contributionFx: FxTally;
  withdrawalFx: FxTally;
  /** Answer lines in row order, then the assumed and matched lines. */
  basis: string[];
}

/**
 * This year's activity in the set's accounts, classified and summed (gate 3 and the sums). A stored answer applies only
 * to a row that is unclear by the rules (answerable). An unanswered transfer matched to the other side of the move: into
 * the set from outside it is a contribution, out of it to outside a withdrawal, and within the set no effect. An
 * unmatched, unanswered transfer with a CAD value and a date this year is assumed (owner ruling 2026-10-26): in, a
 * contribution; out, no room back. Anything else unclear withholds the number. `figureAsOf` names accounts whose stated
 * year-to-date figure stands for their rows before its date: those rows only report a withdrawal. `noteFor` adds an
 * engine's own note to a matched row. Shares moved in kind are valued first (valuedRow) and are never assumed: they
 * stay a question until answered (A2).
 */
export function tallyActivity(
  src: ActivitySource, set: ReadonlyMap<string, string>, period: number | RoomPeriod, figureAsOf: ReadonlyMap<string, string>,
  options: {
    noteFor?: (row: RoomActivity, match: TransferMatch, effect: RoomEffect) => string | undefined;
    /** An engine's own effect for a matched row (FHSA: a move out to an RRSP has none); undefined keeps the default. */
    matchEffect?: (row: RoomActivity, match: TransferMatch) => RoomEffect | undefined;
  } = {},
): ActivityTally {
  let contributedCad = 0;
  let withdrawnCad = 0;
  let estimated = false;
  const contributionFx = new FxTally();
  const withdrawalFx = new FxTally();
  const moves: LedgerMove[] = [];
  const basis: string[] = [];
  /** The row's own signed amount and currency, for display. */
  const nativeOf = (row: RoomActivity) => {
    const currency = typeof row.currency === "string" ? row.currency.trim().toUpperCase() : "";
    return typeof row.amount === "number" && Number.isFinite(row.amount) && currency.length > 0 ? { amount: row.amount, currency } : null;
  };
  const ambiguous: AmbiguousRow[] = [];
  const seen = new Set<string>();
  const matches = matchTransfers(src.activities, src.counterparts, set, period, src.classifications);
  let assumedIn = 0;
  let assumedOut = 0;
  /**
   * An answered transfer that, with its answer cleared, would be matched and classified again (the undo's wording
   * depends on it): a match to outside the set also needs a CAD value, or the row would only be unclear again.
   */
  const wouldMatch = (key: string, hasCad: boolean): boolean => {
    const without = new Map(src.classifications);
    without.delete(key);
    const m = matchTransfers(src.activities, src.counterparts, set, period, without).get(key);
    return m !== undefined && (m.betweenSet || hasCad);
  };
  for (const stored of src.activities) {
    const label = set.get(stored.accountKey);
    if (label === undefined || seen.has(stored.activityKey)) continue;
    seen.add(stored.activityKey);
    const rowYear = yearOf(stored.tradeDate);
    if (rowYear !== null && !inPeriod(stored.tradeDate, period)) continue;
    // Shares moved in kind carry their value as the amount from here on; a close-valued one is an estimate.
    const { row, inKind, fromClose } = valuedRow(stored, src.prices, rowYear === null ? null : stored.tradeDate);
    const converted = rowYear === null ? null : toCad(row, src.fx, row.tradeDate!);
    const cad = converted && fromClose ? { ...converted, estimated: true } : converted;
    const userClass = answerable(stored, src.fx) ? src.classifications.get(row.activityKey) : undefined;
    let effect = classifyActivity({ ...row, tradeDate: rowYear === null ? null : row.tradeDate }, userClass);
    const match = userClass === undefined && effect === "ambiguous" ? matches.get(row.activityKey) : undefined;
    if (match) effect = options.matchEffect?.(row, match) ?? (match.betweenSet ? "none" : row.amount! > 0 ? "contribution" : "withdrawal");
    if ((effect === "contribution" || effect === "withdrawal") && cad === null) effect = "ambiguous";
    const assumed = effect === "ambiguous" && userClass === undefined && !match && !inKind && isTransferType(row.type) && cad !== null && rowYear !== null
      && typeof row.amount === "number" && Number.isFinite(row.amount) && row.amount !== 0;
    if (assumed) {
      effect = row.amount! > 0 ? "contribution" : "none";
      if (row.amount! > 0) assumedIn += 1; else assumedOut += 1;
    }
    // Every applied answer is editable on the dashboard: the route takes exactly the answerable rows.
    const editable = userClass !== undefined;
    const note = match && effect !== "ambiguous" ? options.noteFor?.(row, match, effect) : undefined;
    /** The row as a ledger move, with its signed CAD and conversion. */
    const ledgerMove = (kind: LedgerMove["kind"]): LedgerMove => ({
      date: rowYear === null ? null : row.tradeDate!, kind, label, amountCad: cad ? cents(cad.cad) : null,
      estimated: cad?.estimated ?? false, rateDate: cad?.rateDate ?? null, native: nativeOf(row), activityKey: row.activityKey, accountKey: row.accountKey,
      ...(match && kind !== "ambiguous" ? { matchedWith: { label: match.label, date: match.date }, inferred: true as const } : {}),
      ...(note !== undefined && kind !== "ambiguous" ? { note } : {}),
      ...(assumed ? { assumed: true as const } : {}),
      ...(editable ? { answered: true as const, ...(isTransferType(row.type) && wouldMatch(row.activityKey, cad !== null) ? { automaticMatch: true as const } : {}) } : {}),
    });
    const asOf = figureAsOf.get(row.accountKey);
    if (asOf !== undefined && rowYear !== null && row.tradeDate! < asOf) {
      // The stated figure already holds this row's contribution, if any; it only reports a withdrawal. Rows on the
      // asOf day itself count as after it: a double count can only lower the room.
      if (effect === "withdrawal") {
        withdrawnCad = cents(withdrawnCad + Math.abs(cad!.cad));
        withdrawalFx.add(cad!.currency, Math.abs(row.amount!), cad!);
        moves.push(ledgerMove("withdrawal"));
      }
      continue;
    }
    const type = typeof row.type === "string" && row.type.trim().length > 0 ? row.type.trim() : "UNKNOWN";
    if (effect === "ambiguous") {
      ambiguous.push({
        activityKey: row.activityKey, date: rowYear === null ? "unknown" : row.tradeDate!, amountCad: cad ? cents(cad.cad) : null,
        estimated: cad?.estimated ?? false, rateDate: cad?.rateDate ?? null, native: nativeOf(row), type, label,
        ...(inKind && cad === null ? { inKind: true as const, accountKey: row.accountKey } : {}),
      });
      moves.push(ledgerMove("ambiguous"));
      continue;
    }
    if (userClass) {
      const native = nativeOf(row);
      const amount = cad
        ? ` of ${convertedMoney(money(cents(Math.abs(cad.cad))), { ...cad, native: native && { ...native, amount: Math.abs(native.amount) } })}`
        : "";
      const answer = userClass === "contribution" ? "a contribution" : userClass === "withdrawal" ? "a withdrawal" : "not a contribution";
      basis.push(`You said the ${activityTypeLabel(type)}${amount} on ${row.tradeDate} (${label}) was ${answer}`);
    }
    // classifyActivity has checked the sign against the type, so magnitudes are safe to add here.
    if (effect === "contribution") {
      contributedCad = cents(contributedCad + Math.abs(cad!.cad));
      estimated ||= cad!.estimated;
      contributionFx.add(cad!.currency, Math.abs(row.amount!), cad!);
      moves.push(ledgerMove("contribution"));
    } else if (effect === "withdrawal") {
      withdrawnCad = cents(withdrawnCad + Math.abs(cad!.cad));
      withdrawalFx.add(cad!.currency, Math.abs(row.amount!), cad!);
      moves.push(ledgerMove("withdrawal"));
    } else if (userClass === "none" || (match && effect === "none") || (assumed && effect === "none")) {
      // The user said (or the match shows) it moved within the set: listed, with no effect on room.
      moves.push(ledgerMove("none"));
    }
  }
  const assumedCount = assumedIn + assumedOut;
  if (assumedCount === 1) {
    basis.push(`1 transfer couldn't be matched to your other accounts; it's assumed to ${assumedIn === 1 ? "be a contribution" : "give no room back"} until you change it`);
  } else if (assumedCount > 1) {
    basis.push(`${assumedCount} transfers couldn't be matched to your other accounts; they're assumed to be contributions (in) and to give no room back (out) until you change them`);
  }
  const matched = moves.filter((m) => m.inferred === true).length;
  if (matched > 0) basis.push(`Matched ${matched} ${matched === 1 ? "transfer" : "transfers"} to your other accounts (same amount within ${MATCH_WINDOW_DAYS} days)`);
  ambiguous.sort((a, b) => (a.date === b.date ? 0 : a.date === "unknown" ? 1 : b.date === "unknown" ? -1 : a.date < b.date ? -1 : 1));
  return { moves, ambiguous, contributedCad, withdrawnCad, estimated, contributionFx, withdrawalFx, basis };
}
