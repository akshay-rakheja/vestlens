const MINUS = "−";

// Node's ICU may emit U+00A0 or U+202F as group/space separators; normalize to plain spaces.
const normalizeSpaces = (text: string) => text.replace(/[  ]/g, " ");

export function formatMoney(amount: number, currency: string, locale = "en-CA"): string {
  try {
    return normalizeSpaces(
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        currencyDisplay: "symbol",
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      }).format(amount),
    );
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatSignedMoney(amount: number, currency: string, locale = "en-CA"): string {
  const body = formatMoney(Math.abs(amount), currency, locale);
  return amount < 0 ? `${MINUS}${body}` : `+${body}`;
}

export function formatPercent(fraction: number, digits = 2): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatSignedPercent(fraction: number, digits = 2): string {
  const body = formatPercent(Math.abs(fraction), digits);
  return fraction < 0 ? `${MINUS}${body}` : `+${body}`;
}

export function formatPoints(fractionDiff: number): string {
  const body = (Math.abs(fractionDiff) * 100).toFixed(1);
  return `${fractionDiff < 0 ? MINUS : "+"}${body} pts`;
}

export function formatDateTime(iso: string, locale = "en-CA", timeZone?: string): string {
  try {
    return normalizeSpaces(
      new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(iso)),
    );
  } catch {
    return iso;
  }
}

/** "Jun 1" for an ISO calendar date; adds the year when it differs from `referenceYear`. */
export function formatShortDate(isoDate: string, referenceYear: string, locale = "en-CA"): string {
  try {
    const sameYear = isoDate.slice(0, 4) === referenceYear;
    return normalizeSpaces(
      new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(new Date(`${isoDate}T00:00:00Z`)),
    );
  } catch {
    return isoDate;
  }
}

/** Share/unit counts: no trailing zeros, at most 6 decimals, true minus sign. */
export function formatUnits(units: number, locale = "en-CA"): string {
  const body = normalizeSpaces(new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(Math.abs(units)));
  return units < 0 ? `${MINUS}${body}` : body;
}

/** Axis labels: "$150k", "$1.2M"; under 1,000 the full amount. True minus sign. */
export function formatCompactMoney(amount: number, currency: string, locale = "en-CA"): string {
  if (Math.abs(amount) < 1000) return amount < 0 ? `${MINUS}${formatMoney(-amount, currency, locale)}` : formatMoney(amount, currency, locale);
  try {
    const body = normalizeSpaces(new Intl.NumberFormat(locale, { style: "currency", currency, notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(Math.abs(amount))).replace(/K$/, "k");
    return amount < 0 ? `${MINUS}${body}` : body;
  } catch {
    return `${amount < 0 ? MINUS : ""}${Math.round(Math.abs(amount))} ${currency}`;
  }
}

/** "10:30 a.m." in market (Toronto) time. */
export function formatTime(iso: string, timeZone = "America/Toronto", locale = "en-CA"): string {
  try {
    return normalizeSpaces(new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso)));
  } catch {
    return iso;
  }
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" relative to `now`; the ISO string itself when unparseable. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const minutes = Math.max(0, Math.floor((now - t) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** BoC rate date label: "May 26" (en-US short month, no year, UTC). */
export function formatRateDate(date: string): string {
  try {
    return normalizeSpaces(
      new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`)),
    );
  } catch {
    return date;
  }
}
