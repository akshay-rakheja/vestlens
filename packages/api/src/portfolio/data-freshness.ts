import type { PortfolioPresentationAccount } from "./portfolio-presentation.js";

/**
 * Freshness and sync checks shared by the thesis, limit and goal checks (spec 2026-10-24 §11a.1, §11a.8). Dates are
 * Toronto calendar dates; trading days are weekdays (public holidays are not excluded, so a holiday week can flag
 * data stale one day early).
 */

/** Positions or a price older than this many Toronto weekdays are not used (§11a.1). */
export const PRICE_STALE_TRADING_DAYS = 3;
/** Stored activity must have synced this recently to be trusted as complete. */
export const SYNC_FRESH_MS = 48 * 3_600_000;
export const POSITIONS_STALE_NOTE = `latest positions are more than ${PRICE_STALE_TRADING_DAYS} trading days old`;

const TORONTO_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });
export const torontoDay = (d: Date): string => TORONTO_DAY.format(d);
const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

/** Weekdays after `from` up to and including `to` (Toronto calendar dates; public holidays are not excluded). */
export function tradingDaysBetween(from: string, to: string): number {
  let n = 0;
  for (let d = dayNumber(from) + 1; d <= dayNumber(to); d++) {
    const weekday = new Date(d * 86_400_000).getUTCDay();
    if (weekday !== 0 && weekday !== 6) n++;
  }
  return n;
}

/** A Toronto date no more than PRICE_STALE_TRADING_DAYS weekdays before `today`. */
export const freshDay = (asOf: string, today: string): boolean => tradingDaysBetween(asOf, today) <= PRICE_STALE_TRADING_DAYS;

/** The account's brokerage positions instant, or null when unknown or invalid. */
export function positionsAsOfInstant(a: Pick<PortfolioPresentationAccount, "freshness">): Date | null {
  const at = a.freshness?.positionsAsOf ?? null;
  const d = at ? new Date(at) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/** The account's positions date (Toronto), or null when unknown. */
export function positionsAsOfDay(a: Pick<PortfolioPresentationAccount, "freshness">): string | null {
  const d = positionsAsOfInstant(a);
  return d ? torontoDay(d) : null;
}

export interface SyncStateLike { lastSyncedAt: Date | null; lastError: string | null }

/**
 * An account's stored activity is complete enough to use: no sync error, synced within 48 hours, and (when given) not
 * before the positions instant, else a trade already in the positions may be missing from the activity.
 */
export function activitySynced(s: SyncStateLike | undefined, now: Date, positionsAsOf: Date | null = null): boolean {
  if (!s || s.lastError || !s.lastSyncedAt) return false;
  if (now.getTime() - s.lastSyncedAt.getTime() > SYNC_FRESH_MS) return false;
  return !positionsAsOf || s.lastSyncedAt >= positionsAsOf;
}
