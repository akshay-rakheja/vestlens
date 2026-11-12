import { homeConverter, loadHomeConverter, type HomeConverter, type HomeTotal } from "../fx/home-currency.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import { withDeadline } from "./overview-tools.js";

/** Model-copy note for every CAD-view tool. */
export const CAD_NOTE = "Figures are in CAD; USD amounts are converted at the Bank of Canada rate and marked est.";

const DEFAULT_DEADLINE_MS = 5_000;

/** Shared money and BoC-date copy for every tool's text: "1,234.50 CAD", "Oct 15", " est. (BoC Oct 15)". */
export const formatMoney = (amount: number, currency: string) =>
  `${amount.toLocaleString("en-CA", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} ${currency}`;

/** "Oct 15"; the year is added when it differs from `currentYear`. */
export const shortDate = (iso: string, currentYear: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(iso.slice(0, 4) !== currentYear ? { year: "numeric" } : {}), timeZone: "UTC" }).format(d);
};

/** " est. (BoC Oct 15)", " est. (rates by trade date)", plus "(N amounts not converted)"; empty when exact. */
export function homeQualifier(total: HomeTotal, year: string): string {
  let out = "";
  if (total.estimated) out += total.rateDates.length === 1 ? ` est. (BoC ${shortDate(total.rateDates[0], year)})` : total.rateDates.length > 1 ? " est. (rates by trade date)" : " est.";
  const n = total.excludedCount;
  if (n > 0) out += ` (${n} amount${n === 1 ? "" : "s"} not converted)`;
  return out;
}

/**
 * One bounded Bank of Canada fetch from `earliest` (the oldest USD date to convert) to `today`.
 * Without USD dates, without the market service, on failure or timeout, USD stays not converted.
 */
export function homeConverterFor(
  market: Partial<Pick<MarketDataService, "usdCad">> | undefined,
  earliest: string | undefined,
  today: string,
  deadlineMs: number = DEFAULT_DEADLINE_MS,
): Promise<HomeConverter> {
  const usdCad = market?.usdCad?.bind(market);
  if (!usdCad || !earliest) return Promise.resolve(homeConverter(null, today));
  return withDeadline(() => loadHomeConverter({ usdCad }, earliest, today), deadlineMs, () => homeConverter(null, today));
}
