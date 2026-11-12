import { outsideAccountKey } from "../memory/keys.js";
import { PROPERTY_REGISTRY, outsideLabelCollision, type MemoryFact } from "../memory/memory-types.js";
import {
  cents, coverageGate, credibleYtd, FEEDS, freshness, fxInfo, inKindFigures, managedBasis, managedFigureBasis, money, newYearRows, priorDecember, said, tallyActivity, usable,
  ytdFigure, yearOf, MAX_AMBIGUOUS_ROWS, type AmbiguousRow, type NewYearRow, type NotCounted, type RoomActivity, type RoomCounterpart, type RoomFx, type RoomFxPort, type RoomPricePort, type RoomSync,
} from "./room-common.js";
import { buildLedger, withoutRunningValues, type LedgerMove, type RoomLedger } from "./tfsa-ledger.js";
import type { UserRoomEffect } from "./tfsa-rules.js";

// The shared pieces (room-common.ts), exported here as before.
export {
  answerable, convertedMoney, COVERS_FROM_START, MATCH_WINDOW_DAYS, MAX_ACTIVITY_AGE_DAYS, MAX_AMBIGUOUS_ROWS, nativeMoney,
  type AmbiguousRow, type FxSummary, type NewYearRow, type RoomCounterpart,
} from "./room-common.js";

/**
 * The TFSA room engine (spec §6, §9a): pure, no DB, no network, no clock. It shows a number only when all four
 * gates hold, and otherwise lists what is missing:
 *   1. a stated or imported CRA room on 1 January of the current Toronto year;
 *   2. (never a question; countedTfsas) the TFSAs are every connected account the broker labels TFSA, adjusted only
 *      by this year's confirmed set when there is one: its `notTfsa` keys are excluded, and its `connected` neutral
 *      keys and `outside` labels are added; a managed TFSA (`managed`) is named but not counted, since SnapTrade gives
 *      no activity for it: its stated year-to-date figure stands in, and until then the number is computed without it and
 *      `notCounted` names it (owner ruling 2026-10-31);
 *   3. no unresolved ambiguous activity in a TFSA this year;
 *   (and every connected TFSA's activity is fresh: synced within MAX_ACTIVITY_AGE_DAYS with no error; a pending
 *   change (`dirty`) does not withhold it; a known result carries `activityAsOf`, the oldest of those sync times);
 *   4. every TFSA's stored activity covers 1 January, or the user stated (or VestLens imported) that account's
 *      year-to-date contributions as of a date the stored activity reaches: the figure then stands for the
 *      account's contributions before its asOf, and rows from asOf on count and are gated as usual; and every declared
 *      outside TFSA has this year's figure: its dated deposits and withdrawals (account.tfsa_moves), else its total.
 * A confirmed TFSA that is no longer connected at all (spec §9a.4) needs the user's stated year-to-date figure on its
 * key, which then counts like an outside account's.
 * room_left and the excess come from the ledger (tfsa-ledger.ts): cra_room − Σ contributions this year (connected and
 * declared outside) + Σ qualifying portions of withdrawals (the part of a withdrawal that reduces an excess existing
 * when it is made). Any other withdrawal is reported, never added back this year.
 *
 * Dates are Toronto calendar dates: `today` and each `tradeDate` are YYYY-MM-DD strings and their year is read
 * from the string itself, never through a UTC conversion. Anything else is ambiguous.
 *
 * A TFSA transfer the table leaves ambiguous is matched, when it can be, to the other side of the move in another of
 * the user's accounts (matchTransfers): recomputed on every read, never stored, and always outranked by the user's
 * own answer for that row.
 */

export interface RoomInput {
  /** Toronto date, YYYY-MM-DD. */
  today: string;
  /**
   * The loader passes only provenance stated | imported | derived; the engine checks again. `outside` holds every
   * current `account.ytd_contributions` fact: on outside:<slug> nodes and on connected accountKey nodes.
   * `outsideMoves` holds every current `account.tfsa_moves` fact (dated deposits and withdrawals on outside:<slug> nodes).
   */
  memory: { craRoom: MemoryFact | null; accountSet: MemoryFact | null; outside: MemoryFact[]; outsideMoves: MemoryFact[]; classifications: Map<string, UserRoomEffect> };
  /**
   * The latest current account set from an earlier year (stated or imported), whether or not this year has one. While
   * this year has none, its overrides carry forward (owner ruling 2026-10-26); its outside labels also tell a TFSA
   * carried from an earlier year from one first declared this year.
   */
  previousAccountSet?: MemoryFact | null;
  /**
   * `closed`: the brokerage reports the account closed; its activity can't change, so it skips the freshness gate.
   * `managed`: a managed portfolio (isManagedPortfolio), whose activity SnapTrade doesn't provide, whether or not it
   * reports a value. `maskedNumber` is the last 4 characters of the brokerage's masked account number, and `value` the
   * brokerage-reported total in its currency: both only tell accounts apart on screen, and the engine never reads them.
   */
  accounts: Array<{
    accountKey: string; label: string; bucket: string | null; neutral: boolean; closed?: boolean; managed?: boolean;
    maskedNumber?: string | null; value?: { amount: number; currency: string } | null;
  }>;
  activities: RoomActivity[];
  /** The same accounts' rows dated 27–31 December last year, for the New Year check only: never counted this year. */
  priorDecember?: RoomActivity[];
  /** Transfer rows from every connected account (TFSAs included), 24 December last year through this year +MATCH_WINDOW_DAYS. None means no matching. */
  counterparts?: RoomCounterpart[];
  /** accountKey → earliest covered Toronto date (YYYY-MM-DD), or null when unknown. */
  coverage: Map<string, { coversFrom: string | null }>;
  /** The instant of the read (ISO), for activity freshness. */
  now: string;
  /** accountKey → its activity sync state; a TFSA with no entry has never synced. lastSyncedAt is an ISO instant; dirty is informational only. */
  sync: RoomSync;
  /** Every connected brokerage account's key, whatever its type: tells a confirmed key that is gone from one that is not a TFSA. */
  connectedAccountKeys: string[];
  /** Bank of Canada conversion for a trade date; `rateDate` is the date of the close used (an earlier day on a holiday). */
  fx: RoomFxPort;
  /** Closes for shares moved in kind with no reported price (A2). Without it such a row stays a question. */
  prices?: RoomPricePort;
}

export type MissingItem =
  | { kind: "cra_room" }
  // accountKey lets an assistant answer with remember: a connected account's key, or outside:<slug> for an outside one.
  | { kind: "coverage"; label: string; accountKey: string }
  | { kind: "outside_contributions"; label: string; accountKey: string }
  // The account's activity is out of date (sync error, or not synced within MAX_ACTIVITY_AGE_DAYS).
  | { kind: "stale_activity"; label: string; accountKey: string; lastSyncedAt: string | null }
  // A key in this year's confirmed set that is no longer connected; its stated year-to-date figure answers it.
  | { kind: "disconnected_account"; accountKey: string }
  // No longer raised (a managed TFSA goes in notCounted, owner ruling 2026-10-31); kept so hosts' cached shapes still read.
  | { kind: "managed_account"; label: string; accountKey: string }
  // A year-to-date total (placed at its as-of date) after a dated withdrawal, with an excess: the withdrawal may have
  // reduced an excess the total's real deposit dates would show, so the amount over is a guess until dates are given.
  | { kind: "dated_entries"; label: string; accountKey: string }
  | { kind: "ambiguous"; count: number; rows: AmbiguousRow[] };

/**
 * Every move this year with its running room left and excess. On a known result its final row equals roomLeftCad and
 * overLimitCad; on a missing one, running values are null ("?") wherever an input is missing.
 */
type RoomLedgerField = { ledger: RoomLedger };

/** Contributions near New Year that the brokerage may record in the neighbouring year (newYearRows); absent when none. */
type NewYearField = { newYear?: NewYearRow[] };

/**
 * withdrawnCad is every withdrawal this year; returningCad only the parts whose room comes back next 1 January (each
 * withdrawal less its qualifying portion). On a missing result it is null when any withdrawal's split can't be told.
 */
export type RoomResult =
  | ({ status: "known"; year: number; roomLeftCad: number; contributedCad: number; craRoomCad: number; withdrawnCad: number; returningCad: number; estimated: boolean; basis: string[]; overLimitCad: number; activityAsOf: string | null; notCounted?: NotCounted[] } & RoomFx & RoomLedgerField & HeadlineBasis & NewYearField)
  | ({ status: "missing"; year: number; missing: MissingItem[]; withdrawnCad: number; returningCad: number | null; basis: string[] } & RoomFx & RoomLedgerField & NewYearField);

/**
 * What every number rests on, shown under the headline (owner ruling 2026-10-26): the connected TFSAs, and also what the
 * user entered while an outside TFSA carried from an earlier year has no figure this year.
 */
export const HEADLINE_BASIS_CONNECTED = "Based on your connected TFSAs";
export const HEADLINE_BASIS_ENTERED = "Based on your connected TFSAs and what you entered";
type HeadlineBasis = { headlineBasis: typeof HEADLINE_BASIS_CONNECTED | typeof HEADLINE_BASIS_ENTERED };

/** The sum of withdrawal rows' returning parts, or null when any is unknown. */
function returningOf(ledger: RoomLedger): number | null {
  let sum = 0;
  for (const r of ledger.rows) {
    if (r.kind !== "withdrawal") continue;
    if (r.returnsCad === null || r.returnsCad === undefined) return null;
    sum = cents(sum + r.returnsCad);
  }
  return sum;
}

const CRA_SCHEMA = PROPERTY_REGISTRY["tax_year.cra_room_jan1"]!.schema!;
const SET_SCHEMA = PROPERTY_REGISTRY["tax_year.account_set"]!.schema!;
const MOVES_SCHEMA = PROPERTY_REGISTRY["account.tfsa_moves"]!.schema!;
type OutsideEntry = { date: string; amountCad: number; kind: "deposit" | "withdrawal" };

export interface RoomOptions {
  /**
   * Compute as if every TFSA's activity were fresh. Only the alert path uses it, to check an open alert against
   * stated corrections while activity is out of date; it is never shown to the user as a number.
   */
  ignoreFreshness?: boolean;
}

type AccountSetValue = { connected: string[]; outside: Array<{ label: string }>; confirmedAt: string; notTfsa: string[] };

/**
 * The TFSAs the engine counts (owner ruling 2026-10-26: the only question is the 1 January room). Every connected
 * account the broker labels TFSA counts. This year's confirmed set (stated or imported, never derived) is only an
 * override: its `notTfsa` keys are excluded, and its `connected` neutral keys and `outside` labels are added. With no
 * such set the broker-labelled TFSAs alone count, and nothing is missing. A neutral account not added is reported on
 * a basis line, never asked about. A confirmed key that is no longer connected at all is returned as `disconnected`
 * (its year-to-date figure still counts); one still connected but no longer a TFSA or neutral account is not counted.
 */
export function countedTfsas(input: RoomInput): {
  set: AccountSetValue | null; setFact: MemoryFact | null; tfsas: Map<string, string>; disconnected: string[]; basis: string[];
  /** Managed TFSAs: named, not counted; a stated year-to-date figure counts for one. */
  managed: Array<{ accountKey: string; label: string }>;
  /** outside account key → the earlier year whose set listed it (carried, so it never blocks without a figure). */
  carriedOutside: Map<string, number>;
  /** True when this year's own set applies; false when none does or an earlier one is carried forward. */
  current: boolean;
} {
  const year = yearOf(input.today)!;
  const basis: string[] = [];
  const current = accountSetOf(input.memory.accountSet, year);
  const earlier = earlierAccountSet(input.previousAccountSet ?? null, year);
  // This year's set wins; without one, the latest earlier set's overrides carry forward.
  const set = current?.set ?? earlier?.set ?? null;
  const setFact = current?.fact ?? earlier?.fact ?? null;
  const carried = current === null && earlier !== null;
  const carriedOutside = new Map((earlier?.set.outside ?? []).map((o) => [outsideAccountKey(o.label), earlier!.year] as const));
  const confirmed = new Set(set?.connected ?? []);
  // A key in both lists counts as a TFSA: counting too much activity can only lower the number.
  const notTfsa = new Set((set?.notTfsa ?? []).filter((k) => !confirmed.has(k)));
  const known = new Set(input.accounts.map((a) => a.accountKey));
  const stillConnected = new Set(input.connectedAccountKeys);
  const gone = [...confirmed].filter((k) => !known.has(k) && !stillConnected.has(k));
  // A carried key that is gone is not asked about (only this year's confirmation says it was a TFSA this year), but it
  // is said, so a number that leaves it out isn't silent about it.
  const disconnected = carried ? [] : gone;
  if (set && carried) basis.push(`Your TFSAs as confirmed for ${earlier!.year} on ${set.confirmedAt.slice(0, 10)} (${said(setFact!.provenance)}), carried forward`);
  else if (set) basis.push(`Your TFSAs for ${year}, confirmed ${set.confirmedAt.slice(0, 10)} (${said(setFact!.provenance)})`);
  if (carried && gone.length > 0) {
    basis.push(gone.length === 1
      ? `1 account in your ${earlier!.year} TFSAs is no longer connected and isn't counted`
      : `${gone.length} accounts in your ${earlier!.year} TFSAs are no longer connected and aren't counted`);
  }

  const tfsas = new Map<string, string>(); // accountKey → label
  const managed: Array<{ accountKey: string; label: string }> = [];
  let uncounted = 0;
  for (const a of input.accounts) {
    if (a.bucket !== "tfsa" && !a.neutral) continue;
    if (notTfsa.has(a.accountKey)) {
      basis.push(`Not a TFSA: ${a.label} (${said(setFact!.provenance)})`);
    } else if (a.bucket === "tfsa" && a.managed === true) {
      managed.push({ accountKey: a.accountKey, label: a.label });
      basis.push(managedBasis("TFSA", a.label));
    } else if (a.bucket === "tfsa") {
      tfsas.set(a.accountKey, a.label);
      basis.push(`Connected TFSA: ${a.label}`);
    } else if (confirmed.has(a.accountKey)) {
      tfsas.set(a.accountKey, a.label);
      basis.push(`Connected TFSA: ${a.label} (you said it is a TFSA)`);
    } else {
      uncounted += 1;
    }
  }
  if (uncounted > 0) {
    basis.push(uncounted === 1
      ? "1 connected account of unknown type isn't counted; add it if it's a TFSA"
      : `${uncounted} connected accounts of unknown type aren't counted; add them if they're TFSAs`);
  }
  return { set, setFact, tfsas, disconnected, basis, managed, carriedOutside, current: current !== null };
}

/** A usable account set on `<year>:tfsa` (stated or imported, well formed, outside labels with distinct keys), or null. */
function accountSetOf(fact: MemoryFact | null | undefined, year: number): { fact: MemoryFact; set: AccountSetValue } | null {
  if (!usable(fact, "tax_year.account_set", "tax_year", `${year}:tfsa`, ["stated", "imported"])) return null;
  const parsed = SET_SCHEMA.safeParse(fact.value);
  // Two outside labels sharing a key would share one figure: such a set (refused on write) is not applied.
  if (!parsed.success || outsideLabelCollision((parsed.data as AccountSetValue).outside) !== null) return null;
  return { fact, set: parsed.data as AccountSetValue };
}

/** The earlier year's set, when the fact is a usable set on a `<year>:tfsa` node before this one. */
function earlierAccountSet(fact: MemoryFact | null, year: number): { fact: MemoryFact; set: AccountSetValue; year: number } | null {
  const m = fact?.node.type === "tax_year" ? /^(\d{4}):tfsa$/.exec(fact.node.key) : null;
  const from = m ? Number(m[1]) : Number.NaN;
  if (!(from < year)) return null;
  const parsed = accountSetOf(fact, from);
  return parsed && { ...parsed, year: from };
}

export function computeTfsaRoom(input: RoomInput, options: RoomOptions = {}): RoomResult {
  const year = yearOf(input.today);
  if (year === null) throw new Error("computeTfsaRoom: today must be a Toronto calendar date, YYYY-MM-DD");
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) throw new Error("computeTfsaRoom: now must be an ISO instant");
  const node = `${year}:tfsa`;
  const missing: MissingItem[] = [];
  const basis: string[] = [];

  // Gate 1: CRA room on 1 January of this year, said by the user or imported.
  const craFact = input.memory.craRoom;
  const craParsed = usable(craFact, "tax_year.cra_room_jan1", "tax_year", node, ["stated", "imported"]) ? CRA_SCHEMA.safeParse(craFact.value) : null;
  const craRoomCad = craParsed?.success ? (craParsed.data as { amountCad: number }).amountCad : null;
  if (craRoomCad === null) missing.push({ kind: "cra_room" });
  else basis.push(`CRA room on 1 January ${year}: ${money(craRoomCad)} (${said(craFact!.provenance)})`);

  // Gate 2 is no question: the broker-labelled TFSAs count, adjusted only by this year's confirmed set (an override).
  const { set, tfsas, disconnected, managed, basis: accountBasis, carriedOutside } = countedTfsas(input);
  let enteredOnly = false;
  basis.push(...accountBasis);

  // Freshness: every open connected TFSA's activity synced recently, without error. A closed one is exempt.
  const { stale, activityAsOfMs } = freshness(tfsas, input.accounts, input.sync, nowMs, options.ignoreFreshness === true);
  missing.push(...stale);

  /** The newest usable dated moves for this year on an outside account node. */
  const outsideMovesFact = (key: string) =>
    input.memory.outsideMoves
      .filter((f) => usable(f, "account.tfsa_moves", "account", key, FEEDS))
      .map((f) => ({ f, v: MOVES_SCHEMA.safeParse(f.value) }))
      .filter((x) => x.v.success && (x.v.data as { year: number }).year === year)
      .map((x) => ({ f: x.f, entries: (x.v.data as { entries: OutsideEntry[] }).entries.filter((e) => yearOf(e.date) === year) }))
      .sort((a, b) => b.f.recordedAt.getTime() - a.f.recordedAt.getTime())[0];

  // Gate 4: coverage from 1 January for each TFSA, or that account's stated year-to-date figure as of a date the
  // stored activity reaches (no gap between them); this year's figure for each declared outside TFSA.
  let outsideCad = 0;
  let withdrawnCad = 0;
  const moves: LedgerMove[] = [];
  /** A year-to-date total: one undated row at its as-of date (its deposits' own dates are unknown). */
  const totalMove = (label: string, accountKey: string, amountCad: number, asOf: string): LedgerMove =>
    ({ date: asOf, kind: "outside_total", label, amountCad, estimated: false, rateDate: null, native: null, accountKey, undated: true });
  const figureAsOf = new Map<string, string>(); // TFSA accountKey → asOf of the figure that stands in for its early rows
  const covered = coverageGate(tfsas, input.coverage, input.memory.outside, input.today);
  missing.push(...covered.missing);
  for (const { key, label, amountCad: amount, asOf, provenance, gap } of covered.figures) {
    figureAsOf.set(key, asOf);
    outsideCad = cents(outsideCad + amount);
    moves.push(totalMove(label, key, amount, asOf));
    basis.push(`${label}: ${money(amount)} contributed this year (${said(provenance)}; ${gap})`);
  }
  // Shares moved in kind with no price and no close: the account's stated figure as of a later date stands in (review 3).
  for (const { key, label, amountCad: amount, asOf, provenance, gap } of inKindFigures(tfsas, input.activities, year, input.prices, input.memory.outside, input.today, new Set(figureAsOf.keys()))) {
    figureAsOf.set(key, asOf);
    outsideCad = cents(outsideCad + amount);
    moves.push(totalMove(label, key, amount, asOf));
    basis.push(`${label}: ${money(amount)} contributed this year as of ${asOf} (${said(provenance)}; ${gap})`);
  }
  for (const key of disconnected) {
    // As for a coverage figure: it can only speak for days already past when it was given.
    const figure = credibleYtd(input.memory.outside, key, year, input.today);
    if (!figure) {
      missing.push({ kind: "disconnected_account", accountKey: key });
      continue;
    }
    outsideCad = cents(outsideCad + figure.amountCad);
    moves.push(totalMove("A TFSA no longer connected", key, figure.amountCad, figure.asOf));
    basis.push(`A TFSA no longer connected (account key ${key}): ${money(figure.amountCad)} contributed this year (${said(figure.provenance)})`);
  }
  // A managed TFSA: SnapTrade gives no activity for it, so its stated year-to-date figure stands in; without one the
  // number is computed from what's visible and says what it leaves out (owner ruling 2026-10-31).
  const notCounted: NotCounted[] = [];
  for (const { accountKey: key, label } of managed) {
    const figure = credibleYtd(input.memory.outside, key, year, input.today);
    if (!figure) {
      notCounted.push({ accountKey: key, label });
      continue;
    }
    outsideCad = cents(outsideCad + figure.amountCad);
    moves.push(totalMove(label, key, figure.amountCad, figure.asOf));
    basis.push(managedFigureBasis(label, figure.amountCad, figure.asOf, figure.provenance));
  }
  for (const { label } of set?.outside ?? []) {
    const key = outsideAccountKey(label);
    // Dated deposits and withdrawals, when given, replace the year-to-date total (never both: no double count).
    const dated = outsideMovesFact(key);
    if (dated) {
      let deposited = 0;
      let withdrawn = 0;
      for (const e of dated.entries) {
        const amount = cents(e.amountCad);
        if (e.kind === "deposit") deposited = cents(deposited + amount);
        else withdrawn = cents(withdrawn + amount);
        moves.push({
          date: e.date, kind: e.kind === "deposit" ? "contribution" : "withdrawal", label, amountCad: e.kind === "deposit" ? amount : -amount,
          estimated: false, rateDate: null, native: null, accountKey: key,
        });
      }
      outsideCad = cents(outsideCad + deposited);
      withdrawnCad = cents(withdrawnCad + withdrawn);
      basis.push(`${label}: ${money(deposited)} deposited and ${money(withdrawn)} withdrawn this year, on the dates entered (${said(dated.f.provenance)})`);
      continue;
    }
    const figure = ytdFigure(input.memory.outside, key, FEEDS, year);
    if (!figure) {
      // One carried from an earlier year never blocks; one first declared this year still needs its figure.
      const from = carriedOutside.get(key);
      if (from === undefined) {
        missing.push({ kind: "outside_contributions", label, accountKey: key });
      } else {
        enteredOnly = true;
        basis.push(`${label} is listed as a TFSA at another institution from ${from}; add this year's deposits there if any`);
      }
      continue;
    }
    const amount = figure.amountCad;
    outsideCad = cents(outsideCad + amount);
    moves.push(totalMove(label, key, amount, figure.asOf));
    basis.push(`${label}: ${money(amount)} contributed this year (${said(figure.f.provenance)})`);
  }

  // Gate 3 and the sums: this year's activity in TFSAs.
  const tally = tallyActivity(
    { activities: input.activities, counterparts: input.counterparts, classifications: input.memory.classifications, fx: input.fx, prices: input.prices }, tfsas, year, figureAsOf,
  );
  const { contributedCad, estimated, contributionFx, withdrawalFx, ambiguous } = tally;
  withdrawnCad = cents(withdrawnCad + tally.withdrawnCad);
  moves.push(...tally.moves);
  basis.push(...tally.basis);
  if (ambiguous.length > 0) missing.push({ kind: "ambiguous", count: ambiguous.length, rows: ambiguous.slice(0, MAX_AMBIGUOUS_ROWS) });
  // The New Year check: last December's rows go through the same tally (transfers matched the same way), only to be named.
  const lastDecember = input.priorDecember?.length
    ? tallyActivity({ activities: input.priorDecember, counterparts: input.counterparts, classifications: input.memory.classifications, fx: input.fx, prices: input.prices }, tfsas, priorDecember(year), new Map()).moves
    : [];
  const nearNewYear = newYearRows(year, tally.moves, lastDecember);
  const newYear: NewYearField = nearNewYear.length > 0 ? { newYear: nearNewYear } : {};

  const order: Record<MissingItem["kind"], number> = {
    cra_room: 0, disconnected_account: 1, managed_account: 2, coverage: 3, stale_activity: 4, outside_contributions: 5, dated_entries: 6, ambiguous: 7,
  };
  const ledger = buildLedger(craRoomCad, year, moves);
  // An undated total sits at its as-of date, the latest its deposits could be. A dated withdrawal on or before that
  // date then reads as made while not over; had the deposits come first, part of it would have reduced the excess.
  // So an excess resting on that order is a guess: ask for the total's dated deposits instead.
  const finalRow = ledger.rows.at(-1)!;
  if (missing.length === 0 && finalRow.excessCad !== null && finalRow.excessCad > 0) {
    const withdrawalDates = moves.filter((m) => m.kind === "withdrawal" && m.date !== null).map((m) => m.date!);
    for (const m of moves) {
      if (m.kind !== "outside_total" || m.undated !== true || m.amountCad === 0 || m.date === null) continue;
      if (withdrawalDates.some((d) => d <= m.date!)) missing.push({ kind: "dated_entries", label: m.label, accountKey: m.accountKey! });
    }
  }
  missing.sort((a, b) => order[a.kind] - order[b.kind]);
  const headline: HeadlineBasis = { headlineBasis: enteredOnly ? HEADLINE_BASIS_ENTERED : HEADLINE_BASIS_CONNECTED };
  const fxInfoValue: RoomFx = fxInfo(contributionFx, withdrawalFx);
  if (missing.length > 0 || craRoomCad === null) {
    // buildLedger already shows "?" from a missing CRA room or the first unclear row. Any other missing input (an
    // account, its coverage, an outside figure, stale activity) means moves may be absent, so no running value holds.
    const incomplete = missing.some((m) => m.kind !== "cra_room" && m.kind !== "ambiguous");
    const shown: RoomLedger = incomplete ? withoutRunningValues(ledger) : ledger;
    return { status: "missing", year, missing, withdrawnCad, returningCad: returningOf(shown), basis, ...fxInfoValue, ledger: shown, ...newYear };
  }

  const totalContributed = cents(contributedCad + outsideCad);
  // The headline is the ledger's final row (every running value is known here: no missing input).
  const final = ledger.rows.at(-1)!;
  const roomLeftCad = final.roomLeftCad!;
  return {
    status: "known", year, roomLeftCad, contributedCad: totalContributed, craRoomCad, withdrawnCad, returningCad: returningOf(ledger)!, estimated, basis,
    overLimitCad: final.excessCad!, ledger,
    activityAsOf: activityAsOfMs === null ? null : new Date(activityAsOfMs).toISOString(), ...fxInfoValue, ...headline,
    ...(notCounted.length > 0 ? { notCounted } : {}), ...newYear,
  };
}
