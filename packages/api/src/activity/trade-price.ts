import { reportedUsdCad } from "../history/valuation.js";

/**
 * Converts a trade price into the security currency, or null when it cannot be. SnapTrade reports
 * a trade's `price` in the row (transaction) currency: when the row and security currencies are
 * both known and differ, the price is converted (brief 8). Same or unknown currencies: as reported.
 */
export type ToSecurityCurrency = (
  price: number, rowCurrency: string | null, securityCurrency: string | null, date: string, fxRate?: number | null,
) => number | null;

/** The BoC USD/CAD rate used is at most this many days older than the trade (7 converts, 8 is unknown). */
const MAX_STALE_DAYS = 7;
const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
const norm = (c: string | null) => c?.trim().toUpperCase() || null;

/**
 * `fx`: the BoC USD/CAD series (any order), or null when unavailable. The rate is the one on or
 * before the trade date, at most 7 days older than it. A reported `fxRate` takes precedence, in the quoting
 * direction nearest the BoC rate (the M1 helper). Only USD/CAD pairs convert; others are unknown.
 */
export function tradePriceConverter(fx: Array<{ date: string; close: number }> | null): ToSecurityCurrency {
  const series = (fx ?? []).filter((p) => Number.isFinite(p.close) && p.close > 0).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const bocAt = (date: string): number | null => {
    let lo = 0;
    let hi = series.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid].date <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (found < 0 || dayNumber(date) - dayNumber(series[found].date) > MAX_STALE_DAYS) return null;
    return series[found].close;
  };
  return (price, rowCurrency, securityCurrency, date, fxRate) => {
    const row = norm(rowCurrency);
    const security = norm(securityCurrency);
    if (row === null || security === null || row === security) return price;
    if (!((row === "CAD" && security === "USD") || (row === "USD" && security === "CAD"))) return null;
    const boc = bocAt(date);
    const rate = reportedUsdCad(fxRate, boc) ?? boc;
    if (rate === null || !(rate > 0)) return null;
    return row === "CAD" ? price / rate : price * rate;
  };
}
