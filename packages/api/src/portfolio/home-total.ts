import { HOME_CURRENCY, loadHomeConverter, sumHome } from "../fx/home-currency.js";
import type { PortfolioPresentation } from "./portfolio-presentation.js";

/**
 * The dashboard's combined total in CAD (owner, 2026-10-28: the site says "in Canadian dollars", as the widgets show):
 * the brokerage-reported value of every account counted in the portfolio, with USD converted at the Bank of Canada
 * rate (est., with its date) through the same converter the widgets use (fx/home-currency.ts). If anything can't be
 * converted (no recent Bank of Canada rate, or a currency other than CAD and USD), there is no combined total. Only when the portfolio holds more than one currency; one currency needs no total.
 */
export interface DashboardHomeTotal {
  currency: "CAD";
  amount: number;
  estimated: boolean;
  /** The latest Bank of Canada rate date used; null when nothing was converted. */
  rateDate: string | null;
  notConverted: Array<{ amount: number; currency: string }>;
}

type UsdCad = { usdCad(from: string, to: string): Promise<Array<{ date: string; close: number }> | null> };

export async function dashboardHomeTotal(portfolio: PortfolioPresentation, market: UsdCad, today: string): Promise<DashboardHomeTotal | null> {
  const values = portfolio.accounts
    .filter((a) => a.classification.includedInPortfolioTotal && a.value && Number.isFinite(a.value.amount))
    .map((a) => a.value!);
  const currencies = new Set(values.map((v) => v.currency.trim().toUpperCase()));
  if (currencies.size < 2 || !currencies.has(HOME_CURRENCY)) return null;
  const converter = await loadHomeConverter(market, today, today);
  const total = sumHome(values.map((v) => converter.at(v.amount, v.currency, today)));
  // A total that leaves something out isn't a total: without every part converted, show the currencies only.
  if (total.excludedCount > 0) return null;
  return {
    currency: "CAD",
    amount: total.amount,
    estimated: total.estimated,
    rateDate: total.rateDates.at(-1) ?? null,
    notConverted: total.excluded,
  };
}
