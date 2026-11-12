import type { SavingsGoal } from "../memory/memory-types.js";
import { OUTSIDE_VALUE_STALE_DAYS } from "../memory/portfolio-facts.js";
import { freshDay, PRICE_STALE_TRADING_DAYS, torontoDay } from "../portfolio/data-freshness.js";
import { oneLineUserText } from "../mcp/user-text.js";

/**
 * Savings goal check (spec 2026-10-24 §7, §11a.8): a pure evaluation of one goal against figures the loader read. It
 * states facts only and never suggests an amount; "what it takes" is arithmetic on the user's own target.
 *
 * - Saved so far: the current brokerage-reported values of the linked connected accounts (CAD, est. where converted)
 *   plus the user's stated outside values. It is null when any linked account is disconnected, has stale or unknown
 *   positions, no value, or a value not converted, or when an outside account has no stated value; the notes say
 *   which. A closed account or credit product is not counted. A stale outside value is counted and noted.
 * - Months left: fractional, by Toronto calendar month (whole months, then the days left over that month's length).
 *   Under one month is `under_month`; a date before today is `passed`, with no per-month figure and no projections.
 * - Remaining: max(0, target − saved). Needed per month, flat: remaining / months left; null when the date has passed
 *   or under a month is left (a "per month" figure larger than the gap reads wrong; `remainingCad` is shown instead).
 * - Recent pace: net contributions over the last PACE_WINDOW_MONTHS months from stored activity, per month. Null with
 *   a note when a linked account is disconnected, without connected accounts, a finished backfill and known first
 *   activity for every counted account, a recent error-free sync, or a CAD value for every flow. Outside accounts
 *   have no activity: the pace counts connected accounts only.
 *   When the earliest first activity across the counted accounts is after the window start, every account opened
 *   inside the window: the pace is prorated over the months since that date ("pace since <date>"), and needs at
 *   least one month of it. ASSUMPTION: a finished backfill means the account has no history before its first
 *   recorded activity (the sync fetches unbounded history and errors on truncation; the room guard relies on
 *   `earliestTradeDate` the same way). A provider history horizon shorter than the window would break this.
 * - Projections, no growth: saved + pace × months left. With the user's own `growthRatePct` (only when set): saved
 *   compounded monthly at rate/12, plus the pace each month (an ordinary annuity). Labelled "(your assumption)" in
 *   the text layer (Task 5).
 * - Series: daily values summed across the linked connected accounts, at most one point per week (the last of each
 *   Monday-to-Sunday week), empty with fewer than two points.
 *
 * Every string is VestLens copy except the user's goal name, kept to one line with control and format characters removed.
 */

export const PACE_WINDOW_MONTHS = 6;
export const TARGET_DATE_PASSED = "target date passed";
export const UNDER_MONTH = "less than a month left";
const MIN_SERIES_POINTS = 2;

export type GoalAccountInput =
  | {
    key: string; kind: "connected"; label: string;
    /** False for a closed account or a credit product: listed, not counted. */
    counted: boolean;
    valueCad: number | null; estimated: boolean;
    /** Bank of Canada rate date of the conversion, when it was converted. */
    rateDate?: string | null;
    /** Positions date (Toronto); null when unknown. */
    positionsAsOf: string | null;
    problem: "no_value" | "not_converted" | "managed" | null;
  }
  | { key: string; kind: "disconnected" }
  | { key: string; kind: "outside"; amountCad: number; asOf: string; stale: boolean }
  | { key: string; kind: "outside_missing" };

export interface GoalContributions {
  /** Linked connected accounts the pace is computed over. */
  connectedAccounts: number;
  /** Every one has a finished backfill. */
  backfilled: boolean;
  /** The earliest first recorded activity (calendar date) across them; null when any is unknown or not backfilled. */
  firstActivity: string | null;
  /** Every one synced within 48 hours with no error. */
  synced: boolean;
  /** Dates in the window of flows with no CAD value. */
  unvaluedDates: string[];
  /** Net contributions in the window, CAD (deposits in, withdrawals out). */
  netCad: number;
  estimated: boolean;
  /** Bank of Canada rate dates of the converted flows. */
  rateDates?: string[];
}

export interface GoalInput {
  slug: string;
  goal: SavingsGoal;
  accounts: GoalAccountInput[];
  contributions: GoalContributions;
  /** Summed daily values of the linked connected accounts (CAD), ascending; dates with every account valued only. */
  daily: Array<{ date: string; valueCad: number }>;
  /** The daily values could not be read. */
  dailyUnavailable?: boolean;
}

export interface GoalCheck {
  slug: string;
  name: string;
  targetCad: number;
  targetDate: string;
  savedCad: number | null;
  /**
   * Set when `savedCad` is a lower bound: a linked managed portfolio has no value from SnapTrade (the notes name it), so
   * the known values are "at least" the total; no percentage of the target, remaining, needed-per-month or projection
   * is claimed beyond it (review 7).
   */
  savedAtLeast?: true;
  savedPct: number | null;
  /** max(0, target − saved); null when saved is unknown or a lower bound. */
  remainingCad: number | null;
  estimated: boolean;
  /** Latest Bank of Canada rate date behind the saved total (and what is derived from it); null when it was not converted. */
  savedFxDate: string | null;
  /** The recent pace is shown and rests on converted flows. */
  paceEstimated: boolean;
  /** Latest Bank of Canada rate date behind the pace; null when it is not estimated. */
  paceFxDate: string | null;
  monthsLeft: number;
  dateStatus: "future" | "under_month" | "passed";
  neededPerMonthFlatCad: number | null;
  recentPacePerMonthCad: number | null;
  /** The pace is prorated from this date, because every counted account opened inside the 6-month window. */
  paceSince?: string;
  projectedAtPaceCad: number | null;
  projectedWithRateCad: number | null;
  growthRatePct: number | null;
  series: Array<{ date: string; valueCad: number }>;
  notes: string[];
}

const outsideName = (key: string) => key.replace(/^outside:/, "");
const cents = (n: number) => Math.round(n * 100) / 100;
const NOTE = {
  disconnected: "an account in this goal is no longer connected, so saved so far can't be totalled",
  stale: (label: string) => `latest positions for ${label} are more than ${PRICE_STALE_TRADING_DAYS} trading days old`,
  noPositionsDate: (label: string) => `the latest positions date for ${label} is unknown`,
  noValue: (label: string) => `${label} has no reported value`,
  managed: (label: string) => `Not included in the total: ${label}. SnapTrade doesn't provide the value of Wealthsimple managed portfolios, so saved so far is a lower bound`,
  notConverted: (label: string) => `${label}'s value could not be converted to CAD`,
  notCounted: (label: string) => `${label} is closed or a credit product and is not counted`,
  outsideMissing: (key: string) => `no stated value for ${outsideName(key)}`,
  outsideStale: (key: string, asOf: string) => `your stated value for ${outsideName(key)} is from ${asOf}, more than ${OUTSIDE_VALUE_STALE_DAYS} days ago`,
  noConnected: "no connected accounts in this goal, so there is no recent pace",
  notCovered: "stored activity history isn't complete for every linked account, so there is no recent pace",
  disconnectedPace: (keys: string[]) => `account ${keys.join(", ")} in this goal is no longer connected, so there is no recent pace`,
  shortHistory: "less than a month of activity history, so there is no recent pace",
  paceSince: (date: string) => `pace since ${date}`,
  noDaily: "chart data couldn't be loaded",
  notSynced: "activity for a linked account hasn't synced in the last 48 hours or reported an error, so there is no recent pace",
  unvalued: (dates: string[]) => `a deposit or transfer on ${dates.join(", ")} has no value in CAD, so there is no recent pace`,
  paceConnectedOnly: "the recent pace counts connected accounts only",
  seriesConnectedOnly: "the chart covers connected accounts only",
  noSeries: "not enough daily values for a chart",
};

const parse = (d: string) => d.split("-").map(Number) as [number, number, number];
const fmt = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
/** `from` plus `k` calendar months; a day past the month's end clamps to its last day. */
export function addMonths(from: string, k: number): string {
  const [y, m, d] = parse(from);
  const index = y * 12 + (m - 1) + k;
  const year = Math.floor(index / 12), month = index - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return fmt(year, month, Math.min(d, last));
}

/** Fractional calendar months from `from` to `to` (0 when `to` is not after `from`). */
export function monthsBetween(from: string, to: string): number {
  if (to <= from) return 0;
  let k = 0;
  while (addMonths(from, k + 1) <= to) k++;
  const base = addMonths(from, k), next = addMonths(from, k + 1);
  return k + (dayNumber(to) - dayNumber(base)) / (dayNumber(next) - dayNumber(base));
}

/** The last point of each Monday-to-Sunday week; empty with fewer than two weeks. */
export function weeklySeries(daily: Array<{ date: string; valueCad: number }>): Array<{ date: string; valueCad: number }> {
  const byWeek = new Map<number, { date: string; valueCad: number }>();
  for (const p of [...daily].sort((a, b) => a.date.localeCompare(b.date))) {
    const n = dayNumber(p.date);
    const weekday = (new Date(n * 86_400_000).getUTCDay() + 6) % 7; // Monday 0
    byWeek.set(n - weekday, { date: p.date, valueCad: cents(p.valueCad) });
  }
  const out = [...byWeek.values()];
  return out.length >= MIN_SERIES_POINTS ? out : [];
}

function saved(accounts: GoalAccountInput[], today: string, notes: string[]): { savedCad: number | null; atLeast: boolean; estimated: boolean; rateDates: string[] } {
  let total = 0, estimated = false, known = true, atLeast = false;
  const rateDates: string[] = [];
  for (const a of accounts) {
    switch (a.kind) {
      case "disconnected": known = false; notes.push(NOTE.disconnected); break;
      case "outside_missing": known = false; notes.push(NOTE.outsideMissing(a.key)); break;
      case "outside":
        total += a.amountCad;
        if (a.stale) notes.push(NOTE.outsideStale(a.key, a.asOf));
        break;
      case "connected": {
        if (!a.counted) { notes.push(NOTE.notCounted(a.label)); break; }
        if (a.positionsAsOf === null) { known = false; notes.push(NOTE.noPositionsDate(a.label)); break; }
        if (!freshDay(a.positionsAsOf, today)) { known = false; notes.push(NOTE.stale(a.label)); break; }
        // A managed portfolio's value is unknown, not $0: the other values still make a lower bound (review 7).
        if (a.valueCad === null && a.problem === "managed") { atLeast = true; notes.push(NOTE.managed(a.label)); break; }
        if (a.valueCad === null) { known = false; notes.push(a.problem === "not_converted" ? NOTE.notConverted(a.label) : NOTE.noValue(a.label)); break; }
        total += a.valueCad;
        estimated ||= a.estimated;
        if (a.estimated && a.rateDate) rateDates.push(a.rateDate);
        break;
      }
    }
  }
  return { savedCad: known ? cents(total) : null, atLeast: known && atLeast, estimated, rateDates };
}

function pace(c: GoalContributions, accounts: GoalAccountInput[], today: string, notes: string[]): number | null {
  const disconnected = accounts.filter((a) => a.kind === "disconnected").map((a) => a.key);
  if (disconnected.length > 0) { notes.push(NOTE.disconnectedPace(disconnected)); return null; }
  if (c.connectedAccounts === 0) { notes.push(NOTE.noConnected); return null; }
  if (!c.backfilled || c.firstActivity === null) { notes.push(NOTE.notCovered); return null; }
  if (!c.synced) { notes.push(NOTE.notSynced); return null; }
  if (c.unvaluedDates.length > 0) { notes.push(NOTE.unvalued([...new Set(c.unvaluedDates)].sort())); return null; }
  const windowStart = addMonths(today, -PACE_WINDOW_MONTHS);
  let months = PACE_WINDOW_MONTHS;
  if (c.firstActivity > windowStart) {
    // Every counted account opened inside the window (see the module comment's assumption).
    months = monthsBetween(c.firstActivity, today);
    if (months < 1) { notes.push(NOTE.shortHistory); return null; }
    notes.push(NOTE.paceSince(c.firstActivity));
  }
  if (accounts.some((a) => a.kind === "outside" || a.kind === "outside_missing")) notes.push(NOTE.paceConnectedOnly);
  return cents(c.netCad / months);
}

export function checkGoal(input: GoalInput, now: Date): GoalCheck {
  const { goal } = input;
  const today = torontoDay(now);
  const notes: string[] = [];
  const passed = goal.targetDate < today;
  const monthsLeft = passed ? 0 : monthsBetween(today, goal.targetDate);
  const dateStatus: GoalCheck["dateStatus"] = passed ? "passed" : monthsLeft < 1 ? "under_month" : "future";
  if (dateStatus === "passed") notes.push(TARGET_DATE_PASSED);
  if (dateStatus === "under_month") notes.push(UNDER_MONTH);

  const { savedCad, atLeast, estimated, rateDates } = saved(input.accounts, today, notes);
  const hasOutside = input.accounts.some((a) => a.kind === "outside" || a.kind === "outside_missing");
  const recentPacePerMonthCad = pace(input.contributions, input.accounts, today, notes);
  const paceProrated = recentPacePerMonthCad !== null && input.contributions.firstActivity !== null && input.contributions.firstActivity > addMonths(today, -PACE_WINDOW_MONTHS);

  // A lower bound supports no claim beyond itself: no remaining, needed-per-month, percentage or projection (review 7).
  const remainingCad = savedCad === null || atLeast ? null : cents(Math.max(0, goal.targetCad - savedCad));
  const neededPerMonthFlatCad = remainingCad === null || dateStatus !== "future" ? null : remainingCad / monthsLeft;
  const canProject = savedCad !== null && !atLeast && recentPacePerMonthCad !== null && !passed;
  const projectedAtPaceCad = canProject ? cents(savedCad + recentPacePerMonthCad * monthsLeft) : null;
  const growthRatePct = goal.growthRatePct ?? null;
  let projectedWithRateCad: number | null = null;
  if (canProject && growthRatePct !== null) {
    const r = growthRatePct / 100 / 12;
    const f = (1 + r) ** monthsLeft;
    projectedWithRateCad = r === 0 ? projectedAtPaceCad : cents(savedCad * f + recentPacePerMonthCad * ((f - 1) / r));
  }

  const series = weeklySeries(input.daily);
  if (input.dailyUnavailable) notes.push(NOTE.noDaily);
  else if (input.contributions.connectedAccounts > 0 && series.length === 0) notes.push(NOTE.noSeries);
  if (series.length > 0 && hasOutside) notes.push(NOTE.seriesConnectedOnly);

  const latest = (dates: string[]) => (dates.length > 0 ? [...dates].sort().at(-1)! : null);
  const savedFxDate = savedCad !== null && estimated ? latest(rateDates) : null;
  const paceEstimated = recentPacePerMonthCad !== null && input.contributions.estimated;
  const paceFxDate = paceEstimated ? latest(input.contributions.rateDates ?? []) : null;

  return {
    slug: input.slug, name: oneLineUserText(goal.name), targetCad: goal.targetCad, targetDate: goal.targetDate,
    savedCad, ...(atLeast ? { savedAtLeast: true as const } : {}), savedPct: savedCad === null || atLeast ? null : Math.round((savedCad / goal.targetCad) * 100 * 1e6) / 1e6, remainingCad, estimated,
    savedFxDate, paceEstimated, paceFxDate,
    monthsLeft, dateStatus, neededPerMonthFlatCad, recentPacePerMonthCad, ...(paceProrated ? { paceSince: input.contributions.firstActivity! } : {}), projectedAtPaceCad, projectedWithRateCad, growthRatePct,
    series, notes: [...new Set(notes)],
  };
}
