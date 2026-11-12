import { PROPERTY_REGISTRY, type MemoryFact } from "../memory/memory-types.js";
import {
  cents, coverageGate, credibleYtd, freshness, fxInfo, inKindFigures, managedBasis, managedFigureBasis, MAX_AMBIGUOUS_ROWS, money, newYearRows, priorDecember, said, tallyActivity,
  usable, yearOf, type NewYearRow,
  type AmbiguousRow, type CoverageItem, type NotCounted, type RoomActivity, type RoomCounterpart, type RoomFx, type RoomFxPort, type RoomPricePort, type RoomSync, type StaleItem,
} from "./room-common.js";
import { buildFhsaLedger, withoutRunningValues, type LedgerMove, type RoomLedger } from "./tfsa-ledger.js";
import type { UserRoomEffect } from "./tfsa-rules.js";

/**
 * The FHSA participation room engine: pure, no DB, no network, no clock, the TFSA engine's pieces (room-common.ts)
 * with the FHSA rule. The one question is the year's FHSA participation room as CRA reports it (CRA My Account or the
 * notice of assessment). That figure already includes the carry-forward and the lifetime limit, so neither is modelled.
 *   - The FHSAs are every connected account the broker labels FHSA. With none, the result is `{ status: "none" }`. A
 *     managed FHSA is named but not counted (SnapTrade gives no activity for it): its stated year-to-date figure stands
 *     in, and until then the number is computed without it and `notCounted` names it (owner ruling 2026-10-31).
 *   - Contributions this year use room; a transfer in from the user's RRSP uses room too; a move between their FHSAs
 *     doesn't. A transfer is matched to its other side as for the TFSA: from outside the FHSAs (an RRSP, a
 *     non-registered account) it is a contribution, FHSA to FHSA none, FHSA out to another account a withdrawal.
 *   - The excess follows CRA's formula ("What happens if you contribute or transfer too much to your FHSAs"):
 *     max(0, contributions so far − participation room − taxable withdrawals so far in the year). Room left is
 *     max(0, participation room − contributions so far): a withdrawal never raises it, and nothing returns next year.
 *   - The activity data can't tell a taxable withdrawal from a qualifying (home purchase) one, so every FHSA withdrawal
 *     counts as taxable, and the basis says so (FHSA_TAXABLE_BASIS).
 * Freshness (7 days), coverage (or a stated year-to-date figure on the FHSA's key), the `answerable` rule, assumed
 * unmatched transfers and CAD conversion (est. with the Bank of Canada rate date) are the TFSA engine's.
 */

export const FHSA_ROOM_LABEL = "FHSA participation room from CRA (you entered)";
export const FHSA_HEADLINE_BASIS = "Based on your connected FHSAs";
export const FHSA_RRSP_NOTE = "transfer from your RRSP uses FHSA room";
/** A matched move out of an FHSA into the user's RRSP: no effect here (only a designated transfer reduces an excess). */
export const FHSA_RRSP_OUT_NOTE = "transfer to your RRSP; doesn't change your FHSA room or the amount over unless you designated it";
/** Last year's excess carries into this year's formula, but VestLens doesn't model it (ruling 2026-10-26): always said. */
export const FHSA_LAST_YEAR_BASIS = "An amount over from last year isn't included; CRA My Account shows it.";
export const FHSA_TAXABLE_BASIS = "Withdrawals are counted as taxable withdrawals";
/** The penalty fact, in the TFSA style. */
export const FHSA_CRA_FACT = "CRA charges 1% a month on the highest amount over in each month. Check your figures in CRA My Account.";

export interface FhsaRoomInput {
  /** Toronto date, YYYY-MM-DD. */
  today: string;
  /** The instant of the read (ISO), for activity freshness. */
  now: string;
  /**
   * participationRoom: the current `tax_year.fhsa_room` fact on `<year>:fhsa`; outside: every current
   * `account.ytd_contributions` fact (a stated figure for an FHSA whose stored activity doesn't reach 1 January).
   */
  memory: { participationRoom: MemoryFact | null; outside: MemoryFact[]; classifications: Map<string, UserRoomEffect> };
  /** The connected FHSAs (closed ones included; a closed one skips the freshness gate; a managed one is not counted). */
  accounts: Array<{
    accountKey: string; label: string; bucket: string | null; neutral?: boolean; closed?: boolean; managed?: boolean;
    maskedNumber?: string | null; value?: { amount: number; currency: string } | null;
  }>;
  /** Every connected RRSP's key: a matched transfer from one says it uses FHSA room. */
  rrspAccountKeys: string[];
  activities: RoomActivity[];
  /** The same accounts' rows dated 27–31 December last year, for the New Year check only: never counted this year. */
  priorDecember?: RoomActivity[];
  /** Transfer rows from every connected account, 24 December last year through this year +MATCH_WINDOW_DAYS. */
  counterparts?: RoomCounterpart[];
  coverage: Map<string, { coversFrom: string | null }>;
  sync: RoomSync;
  fx: RoomFxPort;
  /** Closes for shares moved in kind with no reported price (A2). */
  prices?: RoomPricePort;
}

export type FhsaMissingItem =
  | { kind: "fhsa_room" }
  // No longer raised (a managed FHSA goes in notCounted, owner ruling 2026-10-31); kept so hosts' cached shapes still read.
  | { kind: "managed_account"; label: string; accountKey: string }
  | CoverageItem | StaleItem | { kind: "ambiguous"; count: number; rows: AmbiguousRow[] };

export type FhsaRoomResult =
  | { status: "none" }
  | ({
    status: "known"; year: number; roomLeftCad: number; contributedCad: number; participationRoomCad: number; withdrawnCad: number;
    estimated: boolean; basis: string[]; overLimitCad: number; activityAsOf: string | null; ledger: RoomLedger; headlineBasis: typeof FHSA_HEADLINE_BASIS;
    notCounted?: NotCounted[];
  } & RoomFx & FhsaNewYear)
  | ({ status: "missing"; year: number; missing: FhsaMissingItem[]; withdrawnCad: number; basis: string[]; ledger: RoomLedger } & RoomFx & FhsaNewYear);

/** Contributions near New Year that the brokerage may record in the neighbouring year (newYearRows); absent when none. */
type FhsaNewYear = { newYear?: NewYearRow[] };

const ROOM_SCHEMA = PROPERTY_REGISTRY["tax_year.fhsa_room"]!.schema!;

/** The FHSAs the engine counts: every connected account the broker labels FHSA that isn't a managed portfolio (accountKey → label). */
export function countedFhsas(input: Pick<FhsaRoomInput, "accounts">): Map<string, string> {
  return new Map(input.accounts.filter((a) => a.bucket === "fhsa" && a.managed !== true).map((a) => [a.accountKey, a.label]));
}

export function computeFhsaRoom(input: FhsaRoomInput, options: { ignoreFreshness?: boolean } = {}): FhsaRoomResult {
  const year = yearOf(input.today);
  if (year === null) throw new Error("computeFhsaRoom: today must be a Toronto calendar date, YYYY-MM-DD");
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) throw new Error("computeFhsaRoom: now must be an ISO instant");
  const fhsas = countedFhsas(input);
  const managed = input.accounts.filter((a) => a.bucket === "fhsa" && a.managed === true);
  if (fhsas.size === 0 && managed.length === 0) return { status: "none" };

  const missing: FhsaMissingItem[] = [];
  const basis: string[] = [];

  // The one question: this year's participation room, as CRA reports it, said by the user (or imported).
  const fact = input.memory.participationRoom;
  const parsed = usable(fact, "tax_year.fhsa_room", "tax_year", `${year}:fhsa`, ["stated", "imported"]) ? ROOM_SCHEMA.safeParse(fact.value) : null;
  const roomCad = parsed?.success ? (parsed.data as { amountCad: number }).amountCad : null;
  if (roomCad === null) missing.push({ kind: "fhsa_room" });
  else basis.push(`FHSA participation room for ${year}: ${money(roomCad)} (${said(fact!.provenance)})`);
  for (const label of fhsas.values()) basis.push(`Connected FHSA: ${label}`);
  for (const a of managed) basis.push(managedBasis("FHSA", a.label));

  const { stale, activityAsOfMs } = freshness(fhsas, input.accounts, input.sync, nowMs, options.ignoreFreshness === true);
  missing.push(...stale);

  let usedCad = 0;
  const moves: LedgerMove[] = [];
  const figureAsOf = new Map<string, string>();
  const covered = coverageGate(fhsas, input.coverage, input.memory.outside, input.today);
  missing.push(...covered.missing);
  for (const { key, label, amountCad, asOf, provenance, gap } of covered.figures) {
    figureAsOf.set(key, asOf);
    usedCad = cents(usedCad + amountCad);
    moves.push({ date: asOf, kind: "outside_total", label, amountCad, estimated: false, rateDate: null, native: null, accountKey: key, undated: true });
    basis.push(`${label}: ${money(amountCad)} contributed this year (${said(provenance)}; ${gap})`);
  }
  // Shares moved in kind with no price and no close: the account's stated figure as of a later date stands in (review 3).
  for (const { key, label, amountCad, asOf, provenance, gap } of inKindFigures(fhsas, input.activities, year, input.prices, input.memory.outside, input.today, new Set(figureAsOf.keys()))) {
    figureAsOf.set(key, asOf);
    usedCad = cents(usedCad + amountCad);
    moves.push({ date: asOf, kind: "outside_total", label, amountCad, estimated: false, rateDate: null, native: null, accountKey: key, undated: true });
    basis.push(`${label}: ${money(amountCad)} contributed this year as of ${asOf} (${said(provenance)}; ${gap})`);
  }
  // A managed FHSA: its stated year-to-date figure stands in for the activity SnapTrade doesn't give; without one the
  // number is computed from what's visible and says what it leaves out (owner ruling 2026-10-31).
  const notCounted: NotCounted[] = [];
  for (const { accountKey: key, label } of managed) {
    const figure = credibleYtd(input.memory.outside, key, year, input.today);
    if (!figure) {
      notCounted.push({ accountKey: key, label });
      continue;
    }
    usedCad = cents(usedCad + figure.amountCad);
    moves.push({ date: figure.asOf, kind: "outside_total", label, amountCad: figure.amountCad, estimated: false, rateDate: null, native: null, accountKey: key, undated: true });
    basis.push(managedFigureBasis(label, figure.amountCad, figure.asOf, figure.provenance));
  }

  const rrsps = new Set(input.rrspAccountKeys);
  const src = (activities: RoomActivity[]) =>
    ({ activities, counterparts: input.counterparts, classifications: input.memory.classifications, fx: input.fx, prices: input.prices });
  const tallyOptions: Parameters<typeof tallyActivity>[4] = {
    // Out to the user's RRSP: no effect on FHSA room or the excess (a designated transfer, which would reduce it, can't be seen).
    matchEffect: (row, match) => ((row.amount ?? 0) < 0 && rrsps.has(match.accountKey) ? "none" : undefined),
    noteFor: (row, match, effect) => {
      if (!rrsps.has(match.accountKey)) return undefined;
      if (effect === "contribution" && (row.amount ?? 0) > 0) return FHSA_RRSP_NOTE;
      return effect === "none" && (row.amount ?? 0) < 0 ? FHSA_RRSP_OUT_NOTE : undefined;
    },
  };
  const tally = tallyActivity(src(input.activities), fhsas, year, figureAsOf, tallyOptions);
  // The New Year check: last December's rows go through the same tally and options, only to be named.
  const lastDecember = input.priorDecember?.length ? tallyActivity(src(input.priorDecember), fhsas, priorDecember(year), new Map(), tallyOptions).moves : [];
  const nearNewYear = newYearRows(year, tally.moves, lastDecember);
  const newYear: FhsaNewYear = nearNewYear.length > 0 ? { newYear: nearNewYear } : {};
  moves.push(...tally.moves);
  basis.push(...tally.basis);
  if (tally.ambiguous.length > 0) missing.push({ kind: "ambiguous", count: tally.ambiguous.length, rows: tally.ambiguous.slice(0, MAX_AMBIGUOUS_ROWS) });

  const order: Record<FhsaMissingItem["kind"], number> = { fhsa_room: 0, managed_account: 1, coverage: 2, stale_activity: 3, ambiguous: 4 };
  missing.sort((a, b) => order[a.kind] - order[b.kind]);
  if (moves.some((m) => m.kind === "withdrawal")) basis.push(FHSA_TAXABLE_BASIS);
  basis.push(FHSA_LAST_YEAR_BASIS);
  const ledger = buildFhsaLedger(roomCad, year, moves, FHSA_ROOM_LABEL);
  const fx = fxInfo(tally.contributionFx, tally.withdrawalFx);

  if (missing.length > 0 || roomCad === null) {
    // Any missing input other than the room or an unclear row means moves may be absent: no running value holds.
    const incomplete = missing.some((m) => m.kind !== "fhsa_room" && m.kind !== "ambiguous");
    return { status: "missing", year, missing, withdrawnCad: tally.withdrawnCad, basis, ...fx, ledger: incomplete ? withoutRunningValues(ledger) : ledger, ...newYear };
  }

  const final = ledger.rows.at(-1)!;
  return {
    status: "known", year, roomLeftCad: final.roomLeftCad!, contributedCad: cents(usedCad + tally.contributedCad), participationRoomCad: roomCad,
    withdrawnCad: tally.withdrawnCad, estimated: tally.estimated, basis, overLimitCad: final.excessCad!, ledger,
    activityAsOf: activityAsOfMs === null ? null : new Date(activityAsOfMs).toISOString(), headlineBasis: FHSA_HEADLINE_BASIS, ...fx,
    ...(notCounted.length > 0 ? { notCounted } : {}), ...newYear,
  };
}
