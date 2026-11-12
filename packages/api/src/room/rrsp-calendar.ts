import { yearOf } from "./room-common.js";

/**
 * RRSP contribution years as CRA publishes them (pure, no clock): tax year Y runs from the day after year Y-1's deadline
 * through year Y's deadline. Deadlines are CRA's published dates, never computed; a year with no entry has no published date.
 */

/**
 * Tax year -> the last day contributions count for it (YYYY-MM-DD). Source: canada.ca, e.g. "from March 4, 2025 to
 * March 2, 2026 qualify" for 2025 (https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/about-your-tax-return/tax-return/completing-a-tax-return/deductions-credits-expenses/line-20800-rrsp-deduction.html).
 * 2026 is absent: checked 2026-10-29, canada.ca pages (line 20800; "Contribution year" for the RRSP receipt return) stop at
 * the 2025 tax year and give no 2027 date. Add it when CRA publishes it.
 */
export const RRSP_DEADLINES: Readonly<Record<number, string>> = {
  2023: "2024-02-29",
  2024: "2025-03-03",
  2025: "2026-03-02",
};

/** One tax year's window; `to` is null while CRA hasn't published that year's deadline (the window has no end yet). */
export type RrspWindow = { taxYear: number; from: string; to: string | null };

/** The calendar day after a YYYY-MM-DD date. */
function dayAfter(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** The window for a tax year, or null when year Y-1's deadline (where it starts) isn't in the table. */
export function rrspWindow(taxYear: number): RrspWindow | null {
  const before = RRSP_DEADLINES[taxYear - 1];
  if (before === undefined) return null;
  return { taxYear, from: dayAfter(before), to: RRSP_DEADLINES[taxYear] ?? null };
}

/** The tax year whose window contains a real YYYY-MM-DD date, or null (no such date, or outside every known window). */
export function taxYearOf(date: string): number | null {
  const y = yearOf(date);
  if (y === null) return null;
  // A date in year y falls in y-1's window (up to its March deadline) or in y's (after it).
  for (const taxYear of [y - 1, y]) {
    const w = rrspWindow(taxYear);
    if (w && date >= w.from && (w.to === null || date <= w.to)) return taxYear;
  }
  return null;
}

/**
 * The windows open on a Toronto calendar date, oldest first. From 1 January to last year's deadline both are open. Without
 * last year's deadline CRA hasn't said when this year begins, so only last year's is returned, with no end.
 */
export function openTaxYears(today: string): RrspWindow[] {
  const y = yearOf(today);
  if (y === null) return [];
  const previous = rrspWindow(y - 1);
  const deadline = RRSP_DEADLINES[y - 1];
  if (deadline === undefined) return previous ? [previous] : [];
  const current = rrspWindow(y)!;
  return previous && today <= deadline ? [previous, current] : [current];
}
