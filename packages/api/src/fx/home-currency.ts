/**
 * One home currency (CAD) for every money figure a user reads (spec 6.1-6.2). CAD amounts are
 * exact; USD amounts convert at the BoC FXUSDCAD close on or before their date, at most 7 days
 * older (7 converts, 8 does not), and are estimated. Anything else is not converted, never guessed.
 */
export const HOME_CURRENCY = "CAD";

export interface HomeAmount {
  amount: number | null;
  estimated: boolean;
  rate: number | null;
  rateDate: string | null;
  native: { amount: number; currency: string };
}

export interface HomeTotal {
  amount: number;
  estimated: boolean;
  rateDates: string[];
  /** Unconverted amounts, one entry per currency (summed to cents, sorted by currency code). */
  excluded: Array<{ amount: number; currency: string }>;
  /** How many parts were not converted (`excluded` is grouped by currency, so its length is not this). */
  excludedCount: number;
}

export interface HomeConverter {
  at(amount: number, currency: string, date?: string): HomeAmount;
  latest: { rate: number; date: string } | null;
}

/** Same staleness rule as activity/trade-price.ts. */
const MAX_STALE_DAYS = 7;
/** Days fetched before the earliest date so a rate from the preceding week is available. */
const LOOKBACK_DAYS = 10;
const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
const cents = (n: number) => Math.round(n * 100) / 100;
/** A real calendar date in YYYY-MM-DD form (rejects "2026-02-30", timestamps and garbage). */
const isCalendarDate = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
};
/** The calendar date of a YYYY-MM-DD date or a full ISO timestamp; null for anything else. */
const calendarDate = (d: string): string | null => {
  const day = d.slice(0, 10);
  if (!isCalendarDate(day)) return null;
  return d.length === 10 || d[10] === "T" ? day : null;
};

export function homeConverter(series: Array<{ date: string; close: number }> | null, today: string): HomeConverter {
  const points = (series ?? [])
    .filter((p) => Number.isFinite(p.close) && p.close > 0 && typeof p.date === "string" && isCalendarDate(p.date))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const rateOn = (input: string): { rate: number; date: string } | null => {
    const date = calendarDate(input);
    if (date === null) return null;
    let lo = 0;
    let hi = points.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].date <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (found < 0) return null;
    // A non-finite difference counts as stale: never a guess.
    if (!(dayNumber(date) - dayNumber(points[found].date) <= MAX_STALE_DAYS)) return null;
    return { rate: points[found].close, date: points[found].date };
  };
  return {
    at(amount, currency, date = today) {
      const code = currency.trim().toUpperCase();
      const native = { amount, currency: code };
      if (code === HOME_CURRENCY) return { amount: cents(amount), estimated: false, rate: null, rateDate: null, native };
      const found = code === "USD" ? rateOn(date) : null;
      if (!found) return { amount: null, estimated: false, rate: null, rateDate: null, native };
      return { amount: cents(amount * found.rate), estimated: true, rate: found.rate, rateDate: found.date, native };
    },
    latest: rateOn(today),
  };
}

/** Adds the rounded CAD parts; parts that could not be converted are listed, never dropped silently. */
export function sumHome(parts: HomeAmount[]): HomeTotal {
  let amount = 0;
  let estimated = false;
  const dates = new Set<string>();
  const excludedBy = new Map<string, number>();
  let excludedCount = 0;
  for (const part of parts) {
    if (part.amount === null) { excludedBy.set(part.native.currency, (excludedBy.get(part.native.currency) ?? 0) + part.native.amount); excludedCount++; continue; }
    amount += part.amount;
    if (part.estimated) estimated = true;
    if (part.rateDate) dates.add(part.rateDate);
  }
  const excluded = [...excludedBy].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([currency, sum]) => ({ amount: cents(sum), currency }));
  return { amount: cents(amount), estimated, rateDates: [...dates].sort(), excluded, excludedCount };
}

const minusDays = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** One BoC fetch covering `from − 10 days` to `today`; an unavailable series leaves USD not converted. */
export async function loadHomeConverter(
  market: { usdCad(from: string, to: string): Promise<Array<{ date: string; close: number }> | null> },
  from: string,
  today: string,
): Promise<HomeConverter> {
  let series: Array<{ date: string; close: number }> | null = null;
  try {
    series = await market.usdCad(minusDays(from, LOOKBACK_DAYS), today);
  } catch {
    series = null;
  }
  return homeConverter(series, today);
}
