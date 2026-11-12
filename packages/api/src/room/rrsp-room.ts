import { PROPERTY_REGISTRY, type MemoryFact } from "../memory/memory-types.js";
import {
  cents, freshness, fxInfo, MAX_AMBIGUOUS_ROWS, money, said, tallyActivity, usable, yearOf,
  type AmbiguousRow, type CoverageItem, type RoomActivity, type RoomCounterpart, type RoomFx, type RoomFxPort, type RoomPeriod, type RoomPricePort, type RoomSync, type StaleItem,
} from "./room-common.js";
import { openTaxYears, type RrspWindow } from "./rrsp-calendar.js";
import { buildRrspLedger, withoutRunningValues, type LedgerMove, type RoomLedger } from "./tfsa-ledger.js";
import type { UserRoomEffect } from "./tfsa-rules.js";

/**
 * The RRSP deduction room engine: pure, no DB, no network, no clock, the TFSA and FHSA engines' pieces (room-common.ts)
 * with the RRSP rule. Contributions count by CRA's tax-year windows (rrsp-calendar.ts), not calendar years: tax year Y
 * runs from the day after year Y-1's deadline through year Y's, so from 1 January to last year's deadline two years are
 * open and both are shown, oldest first. A window whose deadline CRA hasn't published counts everything to today.
 *   - The RRSPs counted are the connected accounts the broker labels RRSP, managed portfolios excepted: SnapTrade gives
 *     no activity for those. Any managed RRSP, open or closed (it may have taken contributions in the window before it
 *     closed), means each year's room left waits for that year's "contributions not in VestLens" (0 counts).
 *     With no RRSP at all, the result is `{ status: "none" }`.
 *   - A deposit, or a matched transfer in from any non-RRSP account (Cash, TFSA, non-registered), is a contribution. A
 *     move between the user's own RRSPs (counted or managed) is none; so is a transfer to or from their FHSA (it doesn't
 *     use RRSP room).
 *   - The deduction limit is optional and each year reads only its own `<Y>:rrsp` facts. Without the limit only the
 *     contributions show, and the limit is the only ask. With it, room left needs all three figures stated (0 counts):
 *     the limit, the unused contributions CRA shows and the contributions not in VestLens. Each one not stated is an
 *     item (`unused_contributions`, `elsewhere`); with a managed RRSP connected, `managed_rrsp` asks for elsewhere
 *     instead. Then room = limit − unused contributions carried forward, and the ledger takes the window's
 *     contributions and the "elsewhere" figure from it: room left = max(0, room − contributed), over = the rest.
 *     Withdrawals never raise room left.
 *   - Room left and the amount over show only with all three figures and nothing missing. A coverage, freshness or
 *     unclear-row item also withholds the contributions (moves may be missing); a missing figure or a managed RRSP
 *     doesn't.
 * Freshness (7 days), the `answerable` rule, assumed unmatched transfers and CAD conversion (est. with the Bank of
 * Canada rate date) are the TFSA engine's. Coverage must reach the window's start; there is no year-to-date bridge.
 */

export const RRSP_LIMIT_PROMPT = "Enter your RRSP deduction limit from CRA My Account or your notice of assessment to see room left.";
export const RRSP_DEDUCT_LATER = "Unused contributions can be deducted in a later year; VestLens doesn't choose the year for you.";
/** The over-contribution fact: only with the limit entered and an amount over above 0. */
export const RRSP_CRA_FACT = "CRA charges 1% a month on contributions more than $2,000 over your RRSP deduction limit. Check your figures in CRA My Account.";
export const RRSP_FHSA_NOTE = "transfer from your FHSA; doesn't use RRSP room";
/** The ledger's opening row: the entered limit less the unused contributions carried forward. */
export const RRSP_ROOM_LABEL = "RRSP deduction limit less unused contributions (you entered)";
export const RRSP_ELSEWHERE_LABEL = "Contributions not in VestLens (you entered)";
export const RRSP_HBP_LLP_BASIS = "VestLens counts Home Buyers' Plan and Lifelong Learning Plan repayments as contributions";
export const RRSP_SPOUSAL_BASIS = "A contribution to a spousal RRSP counts against the limit of the spouse who made it";
const UNPUBLISHED = "CRA's deadline (not yet published)";
/** The `unused_contributions` item's question for tax year Y (asked only once the limit is entered). */
export const RRSP_UNUSED_QUESTION = (year: number): string =>
  `What unused RRSP contributions does CRA show for ${year}? It's next to your deduction limit on your notice of assessment and in CRA My Account; enter 0 if there are none.`;
/** The `elsewhere` item's question for tax year Y (asked only once the limit is entered, and only with no managed RRSP). */
export const RRSP_ELSEWHERE_QUESTION = (year: number): string =>
  `Did you contribute to an RRSP VestLens doesn't see for the ${year} tax year, such as a group RRSP at work, an account at another institution, or a spousal RRSP for your spouse? Enter the total, or 0 if none.`;

/**
 * The `managed_rrsp` item's question for tax year Y (owner, 2026-10-29): it replaces the `elsewhere` question when a
 * managed RRSP is connected, so it asks for the whole total VestLens can't see, not only the managed account's.
 */
export const RRSP_MANAGED_QUESTION = (labels: string, year: number): string =>
  `Contributions to ${labels} aren't visible through SnapTrade. Add them, plus any other RRSP contributions VestLens doesn't see for the ${year} tax year (a group RRSP at work, an account at another institution, a spousal RRSP for your spouse), to 'Contributions not in VestLens'; enter 0 if there are none.`;

export interface RrspRoomInput {
  /** Toronto date, YYYY-MM-DD. */
  today: string;
  /** The instant of the read (ISO), for activity freshness. */
  now: string;
  /** Per tax year shown: that year's three facts (current, stated or imported), or null. */
  memory: {
    byYear: Map<number, { limit: MemoryFact | null; unused: MemoryFact | null; elsewhere: MemoryFact | null }>;
    classifications: Map<string, UserRoomEffect>;
  };
  /**
   * Every connected account (any bucket; closed and managed ones included). Only the `rrsp` bucket is read: the
   * non-managed RRSPs are counted (a closed one skips the freshness gate), the managed ones raise `managed_rrsp`.
   */
  accounts: Array<{
    accountKey: string; label: string; bucket: string | null; managed: boolean; closed?: boolean;
    maskedNumber?: string | null; value?: { amount: number; currency: string } | null;
  }>;
  /** Every connected FHSA's key: a matched transfer with one doesn't use RRSP room. */
  fhsaAccountKeys: string[];
  activities: RoomActivity[];
  /** Transfer rows from every connected account, across the open windows ±MATCH_WINDOW_DAYS. */
  counterparts?: RoomCounterpart[];
  coverage: Map<string, { coversFrom: string | null }>;
  sync: RoomSync;
  fx: RoomFxPort;
  /** Closes for shares moved in kind with no reported price (A2). */
  prices?: RoomPricePort;
}

export type RrspMissingItem =
  | { kind: "deduction_limit" } | { kind: "unused_contributions" } | { kind: "elsewhere" } | CoverageItem | StaleItem
  | { kind: "ambiguous"; count: number; rows: AmbiguousRow[] }
  | { kind: "managed_rrsp"; labels: string[] };

export interface RrspYear extends RoomFx {
  window: RrspWindow;
  /** Null when a coverage, freshness or unclear-row item means moves may be missing. */
  contributedCad: number | null;
  limitCad: number | null; unusedCad: number | null; elsewhereCad: number | null;
  /** Only with the limit, unused contributions and contributions not in VestLens all stated (0 counts) and nothing missing. */
  roomLeftCad: number | null; overLimitCad: number | null;
  estimated: boolean; missing: RrspMissingItem[]; basis: string[]; ledger: RoomLedger;
}

export type RrspRoomResult = { status: "none" } | { status: "shown"; years: RrspYear[]; activityAsOf: string | null };

/** The RRSPs the engine counts (accountKey → label): the broker-labelled RRSPs that aren't managed portfolios. */
export function countedRrsps(input: Pick<RrspRoomInput, "accounts">): Map<string, string> {
  return new Map(input.accounts.filter((a) => a.bucket === "rrsp" && !a.managed).map((a) => [a.accountKey, a.label]));
}

/** One of a year's facts, as CAD, when it is current, stated or imported, and on that year's own `<Y>:rrsp` key. */
function amountOf(f: MemoryFact | null | undefined, property: string, taxYear: number): { cad: number; fact: MemoryFact } | null {
  if (!usable(f, property, "tax_year", `${taxYear}:rrsp`, ["stated", "imported"])) return null;
  const parsed = PROPERTY_REGISTRY[property]!.schema!.safeParse(f.value);
  return parsed.success ? { cad: (parsed.data as { amountCad: number }).amountCad, fact: f } : null;
}

const ORDER: Record<RrspMissingItem["kind"], number> = {
  deduction_limit: 0, unused_contributions: 1, elsewhere: 2, managed_rrsp: 3, coverage: 4, stale_activity: 5, ambiguous: 6,
};
/** The year's own figures: while only these are missing, the contributions still show. */
export const RRSP_FIGURE_KINDS: ReadonlySet<RrspMissingItem["kind"]> = new Set(["deduction_limit", "unused_contributions", "elsewhere"]);

export function computeRrspRoom(input: RrspRoomInput, options: { ignoreFreshness?: boolean } = {}): RrspRoomResult {
  if (yearOf(input.today) === null) throw new Error("computeRrspRoom: today must be a Toronto calendar date, YYYY-MM-DD");
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) throw new Error("computeRrspRoom: now must be an ISO instant");
  if (!input.accounts.some((a) => a.bucket === "rrsp")) return { status: "none" };

  const rrsps = countedRrsps(input);
  // Every managed RRSP, closed ones too: the input has no closing date, so one may have taken contributions this window.
  const managed = input.accounts.filter((a) => a.bucket === "rrsp" && a.managed).map((a) => a.label);
  const fhsas = new Set(input.fhsaAccountKeys);
  const rrspKeys = new Set(input.accounts.filter((a) => a.bucket === "rrsp").map((a) => a.accountKey));
  const { stale, activityAsOfMs } = freshness(rrsps, input.accounts, input.sync, nowMs, options.ignoreFreshness === true);

  const years = openTaxYears(input.today).map((window): RrspYear => {
    const Y = window.taxYear;
    const missing: RrspMissingItem[] = [];
    const to = window.to ?? UNPUBLISHED;
    const basis: string[] = [`Contributions for ${Y}: ${window.from} to ${to}`];

    // Only this year's own facts: a limit saved for another year never feeds this one.
    const facts = input.memory.byYear.get(Y);
    const limit = amountOf(facts?.limit, "tax_year.rrsp_deduction_limit", Y);
    const unused = amountOf(facts?.unused, "tax_year.rrsp_unused_contributions", Y);
    const elsewhere = amountOf(facts?.elsewhere, "tax_year.rrsp_elsewhere", Y);
    if (limit === null) missing.push({ kind: "deduction_limit" });
    else basis.push(`RRSP deduction limit for ${Y}: ${money(limit.cad)} (${said(limit.fact.provenance)})`);
    if (unused) basis.push(`Unused RRSP contributions for ${Y}: ${money(unused.cad)} (${said(unused.fact.provenance)})`);
    if (elsewhere) basis.push(`Contributions not in VestLens for ${Y}: ${money(elsewhere.cad)} (${said(elsewhere.fact.provenance)})`);
    // Room left needs all three figures. Without the limit it alone is asked; a managed RRSP's item asks for elsewhere.
    if (limit !== null && unused === null) missing.push({ kind: "unused_contributions" });
    if (elsewhere === null) {
      if (managed.length > 0) missing.push({ kind: "managed_rrsp", labels: managed });
      else if (limit !== null) missing.push({ kind: "elsewhere" });
    }

    // Stored activity must reach the window's start: a missing or later coversFrom is a gap.
    for (const [key, label] of rrsps) {
      const from = input.coverage.get(key)?.coversFrom ?? null;
      if (from === null || yearOf(from) === null || from > window.from) missing.push({ kind: "coverage", label, accountKey: key });
    }
    missing.push(...stale);

    const moves: LedgerMove[] = [];
    if (elsewhere) {
      moves.push({ date: window.from, kind: "outside_total", label: RRSP_ELSEWHERE_LABEL, amountCad: elsewhere.cad, estimated: false, rateDate: null, native: null, undated: true });
    }
    // An unpublished deadline: the window runs to today.
    const period: RoomPeriod = { from: window.from, to: window.to ?? input.today };
    const tally = tallyActivity(
      { activities: input.activities, counterparts: input.counterparts, classifications: input.memory.classifications, fx: input.fx, prices: input.prices }, rrsps, period, new Map(),
      {
        // Between the user's own RRSPs (managed ones too) or to or from their FHSA: no effect on RRSP room either way.
        matchEffect: (_row, match) => (fhsas.has(match.accountKey) || rrspKeys.has(match.accountKey) ? "none" : undefined),
        noteFor: (row, match) => (fhsas.has(match.accountKey) && (row.amount ?? 0) > 0 ? RRSP_FHSA_NOTE : undefined),
      },
    );
    moves.push(...tally.moves);
    basis.push(...tally.basis);
    if (tally.ambiguous.length > 0) missing.push({ kind: "ambiguous", count: tally.ambiguous.length, rows: tally.ambiguous.slice(0, MAX_AMBIGUOUS_ROWS) });
    missing.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);

    // No room figure at all until the three are stated: a partial one would overstate room left.
    const stated = limit !== null && unused !== null && elsewhere !== null;
    const roomCad = stated ? cents(limit.cad - unused.cad) : null;
    const built = buildRrspLedger(roomCad, window.from, moves, RRSP_ROOM_LABEL);
    // Moves may be absent (a coverage gap, stale activity, a managed RRSP's contributions): no running value holds.
    const incomplete = missing.some((m) => m.kind === "coverage" || m.kind === "stale_activity" || m.kind === "managed_rrsp");
    const ledger = incomplete ? withoutRunningValues(built) : built;
    const withheld = missing.some((m) => m.kind === "coverage" || m.kind === "stale_activity" || m.kind === "ambiguous");
    const final = ledger.rows.at(-1)!;
    const answered = stated && missing.length === 0;
    const overLimitCad = answered ? final.excessCad : null;

    basis.push(RRSP_HBP_LLP_BASIS);
    if (rrsps.size > 0) basis.push(RRSP_SPOUSAL_BASIS);
    if (overLimitCad !== null && overLimitCad > 0) basis.push(RRSP_CRA_FACT);
    basis.push(RRSP_DEDUCT_LATER);

    return {
      window, contributedCad: withheld ? null : tally.contributedCad,
      limitCad: limit?.cad ?? null, unusedCad: unused?.cad ?? null, elsewhereCad: elsewhere?.cad ?? null,
      roomLeftCad: answered ? final.roomLeftCad : null, overLimitCad,
      estimated: tally.estimated, missing, basis, ledger, ...fxInfo(tally.contributionFx, tally.withdrawalFx),
    };
  });

  return { status: "shown", years, activityAsOf: activityAsOfMs === null ? null : new Date(activityAsOfMs).toISOString() };
}
