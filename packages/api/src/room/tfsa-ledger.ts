/**
 * The TFSA room ledger (spec §5): pure, no DB, no network, no clock. Every move that affects room this year, in date
 * order, with a running room left and running excess, following the Income Tax Act definition of "excess TFSA amount"
 * (s. 207.01(1), A − B − C − D − E):
 *   available = 1 January room − contributions so far + qualifying portions of withdrawals so far;
 *   a withdrawal's qualifying portion is the lesser of its amount and the excess at the time it is made;
 *   room left = available (negative while over); excess = max(0, −available).
 * Any other withdrawal adds no room until 1 January of the next year.
 *
 * Within one date the order of moves is unknown, so the builder takes the reading that never understates the
 * excess: unclear rows first (everything after them is unknown), then withdrawals, then contributions.
 */

export type LedgerKind = "cra_room" | "contribution" | "withdrawal" | "none" | "ambiguous" | "outside_total";

export interface LedgerRow {
  /** YYYY-MM-DD; null for an unknown date (ambiguous only). */
  date: string | null;
  kind: LedgerKind;
  /** The account label, or CRA_ROOM_LABEL for the cra_room row. */
  label: string;
  /** Signed CAD: + into the TFSA, − out. */
  amountCad: number | null;
  estimated: boolean;
  rateDate: string | null;
  native: { amount: number; currency: string } | null;
  activityKey?: string;
  accountKey?: string;
  /**
   * Withdrawals only: the qualifying portion (the part that reduced an excess existing when it was made; ITA
   * 207.01(1)), which is never added back next year, and the rest, which is. Null when the running excess is unknown.
   */
  qualifyingCad?: number | null;
  returnsCad?: number | null;
  /** Withdrawals whose returnsCad is above 0: the day that room returns, "<next year>-01-01". */
  returnsOn?: string;
  /** A transfer matched to the other side of the move in another of the user's accounts: that account and its date. */
  matchedWith?: { label: string; date: string };
  /** Present (true) only on a matched transfer: its kind comes from the match, not from the user or the table. */
  inferred?: true;
  /** Present (true) only on a row the user answered (activity.room_effect): its kind is their answer. */
  answered?: true;
  /** On an answered row: clearing the answer would match it automatically again. */
  automaticMatch?: true;
  /** An unmatched, unanswered transfer whose kind is assumed (in: a contribution; out: none, no room back). */
  assumed?: true;
  /** FHSA withdrawals: made while not over (or beyond the excess then), it lowers a later excess this year. */
  offsetsLater?: true;
  /** A fixed note from the engine (FHSA: a transfer from, or to, an RRSP). */
  note?: string;
  /** Null is "?": unknown from the first gap onward. */
  roomLeftCad: number | null;
  excessCad: number | null;
  /** This row raised the excess from 0. */
  wentOver: boolean;
}

export interface RoomLedger {
  rows: LedgerRow[];
  /** The date the current excess last rose from 0; null when not over, unknown, or resting on an undated total. */
  overSince: string | null;
  /** The final excess is above 0 and depends on a total whose deposits have no dates. */
  undatedExcess: boolean;
}

export interface LedgerMove {
  date: string | null;
  kind: Exclude<LedgerKind, "cra_room">;
  label: string;
  amountCad: number | null;
  estimated: boolean;
  rateDate: string | null;
  native: { amount: number; currency: string } | null;
  activityKey?: string;
  accountKey?: string;
  /** A total placed at its as-of date; its own deposits' dates are unknown. */
  undated?: boolean;
  matchedWith?: { label: string; date: string };
  inferred?: true;
  answered?: true;
  automaticMatch?: true;
  assumed?: true;
  note?: string;
}

export const CRA_ROOM_LABEL = "Room from CRA My Account (you entered)";

const cents = (n: number) => Math.round(n * 100) / 100;

/** TFSA order within one date: unclear rows first, then withdrawals before contributions (never understates the excess). */
const SAME_DAY: Record<LedgerMove["kind"], number> = { ambiguous: 0, withdrawal: 1, none: 2, contribution: 3, outside_total: 4 };
/**
 * FHSA order within one date: unclear rows first, then contributions before withdrawals. Under CRA's formula a
 * withdrawal placed first would understate the day's highest excess (the 1% tax is on the highest excess in the month).
 */
const FHSA_SAME_DAY: Record<LedgerMove["kind"], number> = { ambiguous: 0, contribution: 1, outside_total: 2, none: 3, withdrawal: 4 };

/** Moves in date order (undated last), and within one date by the given order, then as given. */
function sortMoves(moves: LedgerMove[], order: Record<LedgerMove["kind"], number> = SAME_DAY): LedgerMove[] {
  return moves
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const da = a.m.date;
      const db = b.m.date;
      if (da !== db) {
        if (da === null) return 1;
        if (db === null) return -1;
        return da < db ? -1 : 1;
      }
      return order[a.m.kind] - order[b.m.kind] || a.i - b.i;
    })
    .map(({ m }) => m);
}

/** A move's own fields as they appear on its ledger row (everything but the running values and a withdrawal's split). */
function moveFields(m: LedgerMove) {
  return {
    date: m.date, kind: m.kind, label: m.label, amountCad: m.amountCad, estimated: m.estimated, rateDate: m.rateDate, native: m.native,
    ...(m.activityKey !== undefined ? { activityKey: m.activityKey } : {}),
    ...(m.accountKey !== undefined ? { accountKey: m.accountKey } : {}),
    ...(m.matchedWith !== undefined ? { matchedWith: m.matchedWith, inferred: true as const } : {}),
    ...(m.answered ? { answered: true as const } : {}),
    ...(m.automaticMatch ? { automaticMatch: true as const } : {}),
    ...(m.assumed ? { assumed: true as const } : {}),
    ...(m.note ? { note: m.note } : {}),
  };
}

/** The opening row: the room as entered. */
const openingRow = (roomCad: number | null, date: string, label: string): LedgerRow => ({
  date, kind: "cra_room", label, amountCad: roomCad, estimated: false, rateDate: null, native: null,
  roomLeftCad: roomCad, excessCad: roomCad === null ? null : Math.max(0, cents(-roomCad)), wentOver: false,
});

/**
 * The end of either ledger: with an unknown running value, no row went over and no date is told. A total placed at its
 * as-of date may hold deposits from any earlier day: with one in the year, the date the excess began can't be told,
 * only its amount.
 */
function finish(rows: LedgerRow[], sorted: LedgerMove[], known: boolean, final: number, overSince: string | null, overByUndated: boolean): RoomLedger {
  if (!known) return { rows: rows.map((r, i) => (i === 0 ? r : { ...r, wentOver: false })), overSince: null, undatedExcess: false };
  const undatedExcess = final > 0 && (overByUndated || sorted.some((m) => m.undated === true && m.amountCad !== 0));
  if (undatedExcess) return { rows: rows.map((r) => ({ ...r, wentOver: false })), overSince: null, undatedExcess };
  return { rows, overSince: final > 0 ? overSince : null, undatedExcess: false };
}

export function buildLedger(craRoomCad: number | null, year: number, moves: LedgerMove[]): RoomLedger {
  const jan1 = `${year}-01-01`;
  const returnsOn = `${year + 1}-01-01`;
  const sorted = sortMoves(moves);

  // An unclear row with no date could fall on any day, so no move's running value can be told.
  let known = craRoomCad !== null && !sorted.some((m) => m.kind === "ambiguous" && m.date === null);
  let available = craRoomCad ?? 0;
  let overSince: string | null = null;
  let overByUndated = false;

  const rows: LedgerRow[] = [openingRow(craRoomCad, jan1, CRA_ROOM_LABEL)];
  if (craRoomCad !== null && craRoomCad < 0) overSince = jan1;

  for (const m of sorted) {
    // A none row (moved from another TFSA) has zero effect, so it never makes the running values unknown, whatever
    // its amount or date; it keeps its place and shows with zero effect.
    if (m.kind === "ambiguous" || (m.kind !== "none" && m.amountCad === null)) known = false;
    const before = Math.max(0, -available);
    let split: { qualifyingCad: number | null; returnsCad: number | null } | null = m.kind === "withdrawal" ? { qualifyingCad: null, returnsCad: null } : null;
    if (known) {
      const magnitude = Math.abs(m.amountCad ?? 0);
      if (m.kind === "contribution" || m.kind === "outside_total") available = cents(available - magnitude);
      else if (m.kind === "withdrawal") {
        const qualifying = cents(Math.min(magnitude, before));
        available = cents(available + qualifying);
        split = { qualifyingCad: qualifying, returnsCad: cents(magnitude - qualifying) };
      }
    }
    const excess = known ? Math.max(0, cents(-available)) : null;
    const wentOver = known && before === 0 && excess! > 0;
    if (known) {
      if (wentOver) {
        overSince = m.date;
        overByUndated = m.undated === true;
      } else if (excess === 0) {
        overSince = null;
        overByUndated = false;
      }
    }
    rows.push({
      ...moveFields(m),
      ...(split ? split : {}),
      ...(split && split.returnsCad !== null && split.returnsCad > 0 ? { returnsOn } : {}),
      roomLeftCad: known ? available : null, excessCad: excess, wentOver,
    });
  }
  return finish(rows, sorted, known, Math.max(0, -available), overSince, overByUndated);
}

/**
 * The FHSA ledger, following CRA's formula for the excess FHSA amount at a time ("What happens if you contribute or
 * transfer too much to your FHSAs"): contributions (RRSP transfers included) so far in the year, less all taxable
 * withdrawals so far in the year, less the year's participation room:
 *   excess = max(0, contributions so far − participation room − taxable withdrawals so far);
 *   room left = max(0, participation room − contributions so far): a withdrawal never raises it.
 * A withdrawal row's qualifyingCad is how much it lowered an excess existing when it was made; `offsetsLater` marks one
 * made while not over (or larger than the excess then) that lowers a later excess. FHSA↔FHSA moves (none) have no
 * effect. Within one date contributions come before withdrawals (FHSA_SAME_DAY), so the day's highest excess shows.
 */
export function buildFhsaLedger(roomCad: number | null, year: number, moves: LedgerMove[], roomLabel: string): RoomLedger {
  const sorted = sortMoves(moves, FHSA_SAME_DAY);
  let known = roomCad !== null && !sorted.some((m) => m.kind === "ambiguous" && m.date === null);
  const room = roomCad ?? 0;
  let contributed = 0;
  let withdrawn = 0;
  const excessOf = (c: number, w: number) => Math.max(0, cents(c - room - w));
  let overSince: string | null = null;
  let overByUndated = false;
  const rows: LedgerRow[] = [openingRow(roomCad, `${year}-01-01`, roomLabel)];
  /** Each known withdrawal's row index, amount, and the running sums just after it. */
  const withdrawals: Array<{ index: number; magnitude: number; remainder: number }> = [];
  const after: Array<{ contributed: number; withdrawn: number }> = [];

  for (const m of sorted) {
    if (m.kind === "ambiguous" || (m.kind !== "none" && m.amountCad === null)) known = false;
    const before = excessOf(contributed, withdrawn);
    let qualifyingCad: number | null = null;
    if (known) {
      const magnitude = Math.abs(m.amountCad ?? 0);
      if (m.kind === "contribution" || m.kind === "outside_total") contributed = cents(contributed + magnitude);
      else if (m.kind === "withdrawal") {
        withdrawn = cents(withdrawn + magnitude);
        qualifyingCad = cents(Math.min(magnitude, before));
        withdrawals.push({ index: rows.length, magnitude, remainder: cents(magnitude - qualifyingCad) });
      }
    }
    const excess = known ? excessOf(contributed, withdrawn) : null;
    const wentOver = known && before === 0 && excess! > 0;
    if (known) {
      if (wentOver) {
        overSince = m.date;
        overByUndated = m.undated === true;
      } else if (excess === 0) {
        overSince = null;
        overByUndated = false;
      }
    }
    rows.push({
      ...moveFields(m),
      ...(m.kind === "withdrawal" ? { qualifyingCad } : {}),
      roomLeftCad: known ? Math.max(0, cents(room - contributed)) : null, excessCad: excess, wentOver,
    });
    after.push({ contributed, withdrawn });
  }

  // A withdrawal not wholly used against the excess when it was made lowers a later excess when, at some later row, the
  // excess without it would be higher (CRA counts every taxable withdrawal so far). Told only when every value is known.
  if (known) {
    for (const w of withdrawals) {
      if (w.remainder <= 0) continue;
      const later = after.slice(w.index); // the sums after each later row (after[k] follows row k + 1)
      if (later.some((a) => excessOf(a.contributed, a.withdrawn - w.magnitude) > excessOf(a.contributed, a.withdrawn))) {
        rows[w.index] = { ...rows[w.index]!, offsetsLater: true };
      }
    }
  }
  return finish(rows, sorted, known, excessOf(contributed, withdrawn), overSince, overByUndated);
}

/**
 * The RRSP ledger: the deduction limit as entered less unused contributions carried forward (the caller folds those
 * into `roomCad`), then each contribution in the tax year's window, in date order. Contributions made elsewhere are not
 * in `roomCad`: the engine passes them as an `outside_total` move dated the window's start.
 *   room left = max(0, room − contributed); excess = max(0, contributed − room).
 * A withdrawal never raises room and never lowers an excess, so withdrawals and `none` moves (moves between the user's
 * own RRSPs, a transfer from the FHSA) are listed with no effect. `outside_total` counts as contributed. The opening
 * row is dated `openingDate`, the window's first day. Within one date contributions come before withdrawals.
 */
export function buildRrspLedger(roomCad: number | null, openingDate: string, moves: LedgerMove[], roomLabel: string): RoomLedger {
  const sorted = sortMoves(moves, FHSA_SAME_DAY);
  let known = roomCad !== null && !sorted.some((m) => m.kind === "ambiguous" && m.date === null);
  const room = roomCad ?? 0;
  let contributed = 0;
  const excessOf = (c: number) => Math.max(0, cents(c - room));
  let overSince: string | null = null;
  let overByUndated = false;
  // A room below zero (the limit less unused contributions carried forward) opens already over:
  // the row keeps the entered figure, but room left never shows below 0 and the excess began on the opening date.
  const opening = openingRow(roomCad, openingDate, roomLabel);
  const rows: LedgerRow[] = [roomCad !== null && roomCad < 0 ? { ...opening, roomLeftCad: 0 } : opening];
  if (roomCad !== null && roomCad < 0) overSince = openingDate;

  for (const m of sorted) {
    if (m.kind === "ambiguous" || (m.kind !== "none" && m.amountCad === null)) known = false;
    const before = excessOf(contributed);
    if (known && (m.kind === "contribution" || m.kind === "outside_total")) contributed = cents(contributed + Math.abs(m.amountCad ?? 0));
    const excess = known ? excessOf(contributed) : null;
    const wentOver = known && before === 0 && excess! > 0;
    if (known) {
      if (wentOver) {
        overSince = m.date;
        overByUndated = m.undated === true;
      } else if (excess === 0) {
        overSince = null;
        overByUndated = false;
      }
    }
    rows.push({ ...moveFields(m), roomLeftCad: known ? Math.max(0, cents(room - contributed)) : null, excessCad: excess, wentOver });
  }
  return finish(rows, sorted, known, excessOf(contributed), overSince, overByUndated);
}

/**
 * The ledger with every running value unknown ("?") after the opening row: used when an input other than the room or an
 * unclear row is missing, so moves may be absent and no running value holds. A withdrawal's split becomes unknown too.
 */
export function withoutRunningValues(ledger: RoomLedger): RoomLedger {
  return {
    rows: ledger.rows.map((r) => {
      if (r.kind === "cra_room") return r;
      const { returnsOn: _returnsOn, ...rest } = r;
      const { offsetsLater: _offsetsLater, ...plain } = rest;
      return {
        ...plain, roomLeftCad: null, excessCad: null, wentOver: false,
        ...(r.kind === "withdrawal" && "qualifyingCad" in r ? { qualifyingCad: null } : {}), ...(r.kind === "withdrawal" && "returnsCad" in r ? { returnsCad: null } : {}),
      };
    }),
    overSince: null, undatedExcess: false,
  };
}
