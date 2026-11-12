/**
 * Pure calendar projection (no I/O). Calendar dates are date-only values represented as UTC midnight
 * (YYYY-MM-DDT00:00:00Z); "today" is the Toronto calendar day of `now`.
 *   earnings: next = last filing + median of the last ≤ 4 gaps (≥ 2 filings); "confirmed" when an article
 *             date is within ±3 days (the closest article date is used), else "expected". Projected
 *             values are estimates and must be labelled "est." by callers.
 *   dividend: cadence from the median of the last ≤ 6 gaps: ≤ 45 d monthly, ≤ 120 d quarterly, ≤ 240 d semi-annual, else annual.
 * Both return null when the next date is more than a day before `now` (stale history).
 */
import type { CalendarEvent } from "./store.js";

const DAY_MS = 86_400_000;
const EARNINGS_GAPS = 4;
const DIVIDEND_GAPS = 5; // last ≤ 6 payments
const CONFIRM_WINDOW_DAYS = 3;
const STALE_MS = DAY_MS;
const EXTRACT_HORIZON_DAYS = 120;
const torontoDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });

/** UTC-midnight date for the calendar day of a Date (UTC). */
const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
/** Today in Toronto, as UTC midnight. */
export const torontoToday = (now: Date) => Date.parse(`${torontoDay.format(now)}T00:00:00Z`);
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Sorted distinct UTC days (ms) from valid dates. */
function days(dates: Date[]): number[] {
  return [...new Set(dates.filter((d) => !Number.isNaN(d.getTime())).map(utcDay))].sort((a, b) => a - b);
}

function lastGaps(sorted: number[], n: number): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) gaps.push(sorted[i] - sorted[i - 1]);
  return gaps.slice(-n);
}

export function projectEarnings(symbol: string, filingDates: Date[], articleDates: Date[], now: Date): CalendarEvent | null {
  const filings = days(filingDates);
  if (filings.length < 2) return null;
  const gapDays = Math.round(median(lastGaps(filings, EARNINGS_GAPS)) / DAY_MS);
  const projected = filings[filings.length - 1] + gapDays * DAY_MS;
  let best: number | null = null;
  for (const a of days(articleDates)) {
    const dist = Math.abs(a - projected);
    if (dist > CONFIRM_WINDOW_DAYS * DAY_MS) continue;
    // closest wins; ties go to the later date
    if (best === null || dist < Math.abs(best - projected) || (dist === Math.abs(best - projected) && a > best)) best = a;
  }
  const date = new Date(best ?? projected);
  if (date.getTime() < now.getTime() - STALE_MS) return null;
  return {
    id: `earnings:${symbol}:${isoDay(date)}`,
    symbol,
    kind: "earnings",
    date,
    status: best === null ? "expected" : "confirmed",
    source: best === null ? "edgar" : "article",
    amountPerUnit: null,
    currency: null,
  };
}

// ---------------------------------------------------------------- date extraction

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};
const MONTH_NAMES = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
/** Month name, matched case-insensitively; callers keep only capitalised ones (see `capitalised`). */
const MONTH = `(${MONTH_NAMES})\\.?`;
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)";
const YEAR = "(\\d{4})(?!\\d)";
/** "Oct 30", "October 30, 2026", "Nov. 4th" */
const MONTH_FIRST = new RegExp(`\\b${MONTH}\\s+${DAY}(?:,?\\s+${YEAR})?`, "gi");
/** "30 Oct", "30 October 2026" */
const DAY_FIRST = new RegExp(`(?<![\\d/])\\b${DAY}\\s+${MONTH}(?![a-zA-Z])(?:,?\\s+${YEAR})?`, "gi");
/** "10/30", "10/30/2026" (US month/day); yearless only after an earnings keyword (see NUMERIC_CONTEXT). */
const NUMERIC = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?![\d/])/g;
const NUMERIC_CONTEXT_CHARS = 30;
const NUMERIC_CONTEXT = /\b(?:earnings|results|report\w*|Q[1-4]|call|dividend|payable)\b/i;

function validDate(y: number, m: number, d: number): number | null {
  if (m < 0 || m > 11 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, m, d);
  return new Date(t).getUTCDate() === d ? t : null;
}

/** Explicit year as given; otherwise the next occurrence on or after today. */
function resolve(m: number, d: number, year: string | undefined, today: number): number | null {
  if (year !== undefined) return validDate(Number(year), m, d);
  const y = new Date(today).getUTCFullYear();
  for (const candidate of [y, y + 1, y + 2, y + 3, y + 4]) {
    const t = validDate(candidate, m, d);
    if (t !== null && t >= today) return t;
  }
  return null;
}

/**
 * Code-only date patterns from headline/snippet text. Weekday-only references ("on Thursday") are ignored;
 * month names must be capitalised; numeric m/d needs a 4-digit year or an earnings keyword
 * (earnings|results|report…|Q1-4|call|dividend|payable) within 30 characters before it.
 * Returns sorted, deduped UTC-midnight dates within [today, today + 120 d] (Toronto today).
 */
export function extractDates(text: string, now: Date): Date[] {
  const today = torontoToday(now);
  const end = today + EXTRACT_HORIZON_DAYS * DAY_MS;
  const found = new Set<number>();
  const add = (t: number | null) => {
    if (t !== null && t >= today && t <= end) found.add(t);
  };
  // "Oct", "OCT", "October" count; lower-case words such as the verb "may" never do
  const capitalised = (name: string) => name[0] >= "A" && name[0] <= "Z";
  for (const m of text.matchAll(MONTH_FIRST)) if (capitalised(m[1])) add(resolve(MONTHS[m[1].toLowerCase()], Number(m[2]), m[3], today));
  for (const m of text.matchAll(DAY_FIRST)) if (capitalised(m[2])) add(resolve(MONTHS[m[2].toLowerCase()], Number(m[1]), m[3], today));
  for (const m of text.matchAll(NUMERIC)) {
    // fractions and ratings ("3/4 of a cent", "4/5 stars") are skipped unless a year or an earnings keyword anchors them
    const before = text.slice(Math.max(0, m.index - NUMERIC_CONTEXT_CHARS), m.index);
    if (m[3] === undefined && !NUMERIC_CONTEXT.test(before)) continue;
    add(resolve(Number(m[1]) - 1, Number(m[2]), m[3], today));
  }
  return [...found].sort((a, b) => a - b).map((t) => new Date(t));
}

// ---------------------------------------------------------------- dividends

/** Adds calendar months in UTC, clamping to the last day of the target month. */
function addMonths(t: number, months: number): number {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay));
}

/**
 * Next projected pay date from past payments (any order). `units` is accepted for callers that show an
 * estimated total; the event itself carries only the per-unit amount (last payment's) and currency. A last
 * payment with no per-unit figure (units changed around it) leaves the amount null, unless another account
 * was paid that day with one.
 */
export function projectDividendPay(
  symbol: string,
  payments: Array<{ date: Date; perUnit: number | null; currency: string }>,
  units: number,
  now: Date,
): CalendarEvent | null {
  void units;
  const valid = payments.filter((p) => !Number.isNaN(p.date.getTime())).sort((a, b) => a.date.getTime() - b.date.getTime());
  const sorted = days(valid.map((p) => p.date));
  if (sorted.length < 2) return null;
  const gapDays = median(lastGaps(sorted, DIVIDEND_GAPS)) / DAY_MS;
  const months = gapDays <= 45 ? 1 : gapDays <= 120 ? 3 : gapDays <= 240 ? 6 : 12;
  const date = new Date(addMonths(sorted[sorted.length - 1], months));
  if (date.getTime() < now.getTime() - STALE_MS) return null;
  const last = valid[valid.length - 1];
  const priced = valid.filter((p) => utcDay(p.date) === utcDay(last.date) && p.perUnit !== null).pop();
  return {
    id: `dividend_pay:${symbol}:${isoDay(date)}`,
    symbol,
    kind: "dividend_pay",
    date,
    status: "expected",
    source: "projection",
    amountPerUnit: priced?.perUnit ?? null,
    currency: last.currency,
  };
}

/**
 * One projected pay date per symbol from one user's own past payments (read time; never stored or shared).
 * A symbol paid in several currencies is projected once, from the payments in the latest payment's currency.
 */
export function projectDividends(
  payments: Array<{ symbol: string; date: Date; perUnit: number | null; currency: string }>,
  symbols: ReadonlySet<string>,
  now: Date,
): CalendarEvent[] {
  const bySymbol = new Map<string, typeof payments>();
  for (const p of payments) if (symbols.has(p.symbol)) bySymbol.set(p.symbol, [...(bySymbol.get(p.symbol) ?? []), p]);
  const out: CalendarEvent[] = [];
  for (const [symbol, paid] of bySymbol) {
    const latest = paid.reduce((a, b) => (b.date > a.date ? b : a));
    const event = projectDividendPay(symbol, paid.filter((p) => p.currency === latest.currency), 0, now);
    if (event) out.push(event);
  }
  return out;
}
