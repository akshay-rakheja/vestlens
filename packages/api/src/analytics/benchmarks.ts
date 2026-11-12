import type { PricePoint, SecurityDistributions } from "../market-data/types.js";
import type { BenchmarkKey } from "../settings/settings-service.js";

export interface BenchmarkDefinition {
  key: BenchmarkKey; name: string; ticker: string; currency: "USD" | "CAD"; explainer: string;
  /** What the return includes or leaves out, said wherever it is compared with your (total) return. */
  basis: string;
  /** Dividends (or distributions) reinvested, as your own return counts them. */
  totalReturn: boolean;
  /** The name with its basis, for a figure's label: "S&P 500 (total return)", "S&P/TSX Composite (price)". */
  label: string;
  /** The series is the ticker's market price with its distributions reinvested (an ETF; no total-return index to fetch). */
  reinvestDistributions?: boolean;
}
const PRICE_INDEX = "price index, dividends excluded";
const define = (d: Omit<BenchmarkDefinition, "label">): BenchmarkDefinition => ({ ...d, label: `${d.name} (${d.totalReturn ? "total return" : "price"})` });
export const BENCHMARKS: Record<BenchmarkKey, BenchmarkDefinition> = {
  sp500: define({ key: "sp500", name: "S&P 500", ticker: "^SP500TR", currency: "USD", totalReturn: true, basis: "total return, dividends reinvested", explainer: "S&P 500: 500 large US companies. Total-return index (dividends reinvested), quoted in USD and converted to CAD with the Bank of Canada daily rate so it compares with your CAD portfolio." }),
  nasdaq100: define({ key: "nasdaq100", name: "Nasdaq-100", ticker: "^NDX", currency: "USD", totalReturn: false, basis: PRICE_INDEX, explainer: "Nasdaq-100: the 100 largest non-financial companies on the Nasdaq, tech-heavy. Price index (dividends excluded, so it reads a little low next to your return, which counts dividends), USD converted to CAD with the Bank of Canada daily rate." }),
  dow: define({ key: "dow", name: "Dow Jones", ticker: "^DJI", currency: "USD", totalReturn: false, basis: PRICE_INDEX, explainer: "Dow Jones Industrial Average: 30 large US blue-chip companies, price-weighted. Price index (dividends excluded, so it reads a little low next to your return, which counts dividends), USD converted to CAD with the Bank of Canada daily rate." }),
  tsx: define({ key: "tsx", name: "S&P/TSX Composite", ticker: "^GSPTSE", currency: "CAD", totalReturn: false, basis: PRICE_INDEX, explainer: "S&P/TSX Composite: about 220 of the largest companies on the Toronto Stock Exchange. Price index in CAD (dividends excluded, about 3% a year for the TSX, so it reads low next to your return, which counts dividends)." }),
  xeqt: define({ key: "xeqt", name: "XEQT", ticker: "XEQT.TO", currency: "CAD", totalReturn: true, reinvestDistributions: true, basis: "total return, distributions reinvested", explainer: "iShares Core Equity ETF Portfolio (XEQT): a global all-equity ETF in CAD. Its market price with each distribution reinvested on its ex-date." }),
};

type BenchmarkMarket = { history(ticker: string, from: string, to: string): Promise<PricePoint[] | null> }
  & { distributions?(ticker: string, from: string, to: string): Promise<SecurityDistributions | null> };

/**
 * A benchmark's daily closes in its own currency, the one source every comparison uses. An index is its ticker's
 * series. An ETF marked reinvestDistributions is rebuilt as a total return: each distribution is added back on its
 * ex-date, close(t) = close(t-1) × (price(t) + distribution(t)) / price(t-1). Without its distributions (or in another
 * currency) it is unavailable: a price series is never passed off as a total return.
 */
export async function benchmarkPrices(market: BenchmarkMarket, key: BenchmarkKey, from: string, to: string): Promise<PricePoint[] | null> {
  const definition = BENCHMARKS[key];
  const prices = await market.history(definition.ticker, from, to);
  if (!prices || !definition.reinvestDistributions) return prices;
  const paid = market.distributions ? await market.distributions(definition.ticker, from, to).catch(() => null) : null;
  if (!paid || (paid.currency !== null && paid.currency.toUpperCase() !== definition.currency)) return null;
  const sorted = prices.filter((p) => Number.isFinite(p.close) && p.close > 0).sort((a, b) => a.date.localeCompare(b.date));
  const out: PricePoint[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0) { out.push(sorted[0]); continue; }
    const prev = sorted[i - 1], cur = sorted[i];
    const dist = paid.events.filter((e) => e.date > prev.date && e.date <= cur.date).reduce((s, e) => s + e.amount, 0);
    out.push({ date: cur.date, close: out[i - 1].close * ((cur.close + dist) / prev.close) });
  }
  return out;
}
