import { symbolPosition } from "../activity/symbol-position.js";
import { tradePriceConverter } from "../activity/trade-price.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import type { NormalizedAccountPortfolio } from "../portfolio/normalize.js";
import type { StoredActivity } from "./stored-activity.js";

type RunMarket = Pick<MarketDataService, "securityHistory" | "usdCad">;
type Position = NormalizedAccountPortfolio["positions"][number];

export interface ProbeDistribution { count: number; median: number | null; p10: number | null; p90: number | null }
/**
 * Provider metadata probe (brief 8): counts and ratios only, never symbols, identities or values.
 * - costBasisCurrency: reported costBasis over the replayed average cost in the security currency,
 *   for positions whose (inferred) security currency differs from the reporting currency. Near 1:
 *   costBasis is in the security currency; near USD/CAD (or its inverse): the account currency.
 * - cashEquivalentInBalance: r1 = (reported total − Σ non-cash-equivalent market value − Σ balance
 *   cash) / Σ cash-equivalent market value, in reporting currency. Near 0: inside balance cash;
 *   near 1: additional. Null when there are none, or when any amount is unknown or in a pair
 *   other than USD/CAD (it cannot be converted).
 * - positionPriceLiveness: position price over the latest and previous provider close.
 */
export interface ProviderMetadataProbe {
  costBasisCurrency: ProbeDistribution;
  cashEquivalentInBalance: { count: number; r1: number | null };
  positionPriceLiveness: { count: number; latest: ProbeDistribution; previous: ProbeDistribution; nearLatest: number | null; nearPrevious: number | null };
}
export interface ProbeInput {
  reportingCurrency: string;
  reportedTotal: number;
  balances: NormalizedAccountPortfolio["balances"];
  positions: Position[];
  activities: StoredActivity[];
  /** Reported security currency of a symbol, else the inferred one. */
  securityCurrencyOf(symbol: string): string;
  tickerFor(symbol: string, securityCurrency: string): string | null;
  market: RunMarket;
  range: { from: string; to: string };
  /** The valuation's last-day USD/CAD, for converting reported amounts to reporting currency. */
  usdCad: number | null;
  today: string;
  /** Set once the caller's budget has expired: no further market calls are issued. */
  cancelled?: () => boolean;
}

const LIVENESS_NEAR = 0.003;
const EPS = 1e-9;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const norm = (s: string) => s.trim().toUpperCase();
const finite = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const rowDate = (r: StoredActivity) => r.tradeDate ?? r.settlementDate ?? "";
const byDate = <T extends { date: string }>(a: T, b: T) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

function quantile(sorted: number[], q: number): number {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function distribution(values: number[]): ProbeDistribution {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, median: null, p10: null, p90: null };
  return { count: sorted.length, median: round3(quantile(sorted, 0.5)), p10: round3(quantile(sorted, 0.1)), p90: round3(quantile(sorted, 0.9)) };
}

function converter(reportingCurrency: string, rate: number | null) {
  return (ccy: string | null, amount: number): number | null => {
    const c = ccy === null ? reportingCurrency : norm(ccy);
    if (c === reportingCurrency) return amount;
    if (rate === null || !(rate > 0)) return null;
    if (c === "USD" && reportingCurrency === "CAD") return amount * rate;
    if (c === "CAD" && reportingCurrency === "USD") return amount / rate;
    return null;
  };
}

type History = { points: Array<{ date: string; close: number }>; splits: Array<{ date: string; ratio: number }> } | null;

export async function providerMetadataProbe(input: ProbeInput): Promise<ProviderMetadataProbe> {
  const reporting = norm(input.reportingCurrency);
  const convert = converter(reporting, input.usdCad);
  const histories = new Map<string, Promise<History>>();
  const cancelled = input.cancelled ?? (() => false);
  const historyOf = (ticker: string): Promise<History> => {
    let h = histories.get(ticker);
    if (!h) {
      if (cancelled()) return Promise.resolve(null);
      h = input.market.securityHistory(ticker, input.range.from, input.range.to).then(
        (r) => (r && !r.notFound && r.splits && r.points.length > 0
          ? { points: [...r.points].sort(byDate), splits: r.splits.filter((s) => s.ratio > 0 && Number.isFinite(s.ratio)) }
          : null),
        () => null,
      );
      histories.set(ticker, h);
    }
    return h;
  };
  const held = input.positions.filter((p) => !p.kind.toLowerCase().includes("option") && finite(p.units) && p.units > EPS);

  // costBasisCurrency: replays the account's rows of the symbol with symbolPosition (after the
  // row-currency price fix), in the inferred security currency, with as-traded closes for unpriced
  // in-kind receipts and the provider's splits when the symbol is mapped.
  const costRatios: number[] = [];
  const foreign = held.filter((p) => !p.cashEquivalent && finite(p.costBasis) && p.costBasis > 0 && norm(input.securityCurrencyOf(p.symbol)) !== reporting);
  if (foreign.length > 0) {
    const fx = cancelled() ? null : await input.market.usdCad(input.range.from, input.range.to).catch(() => null);
    const toSecurity = tradePriceConverter(fx);
    for (const p of foreign) {
      const sec = norm(input.securityCurrencyOf(p.symbol));
      const rows = input.activities.filter((r) => !r.isOption && r.symbol && norm(r.symbol) === norm(p.symbol) && norm(r.securityCurrency ?? sec) === sec);
      if (rows.length === 0) continue;
      const ticker = input.tickerFor(p.symbol, sec);
      const h = ticker ? await historyOf(ticker) : null;
      const asTraded = (date: string): number | null => {
        if (!h) return null;
        let found: { date: string; close: number } | null = null;
        for (const pt of h.points) { if (pt.date <= date) found = pt; else break; }
        return found ? found.close * h.splits.filter((s) => s.date > found!.date).reduce((acc, s) => acc * s.ratio, 1) : null;
      };
      const replayed = symbolPosition(rows, h?.splits ?? [], asTraded, sec, toSecurity);
      if (replayed.avgCost !== null && replayed.avgCost > 0) costRatios.push(p.costBasis! / replayed.avgCost);
    }
  }

  // cashEquivalentInBalance
  const cashEq = held.filter((p) => p.cashEquivalent);
  let r1: number | null = null;
  if (cashEq.length > 0) {
    let known = true;
    const sum = (list: Position[]) => list.reduce((acc, p) => {
      const mv = finite(p.marketValue) ? p.marketValue : finite(p.price) ? p.units! * p.price : null;
      const v = mv === null ? null : convert(p.currency, mv);
      if (v === null) { known = false; return acc; }
      return acc + v;
    }, 0);
    const others = sum(input.positions.filter((p) => !p.cashEquivalent && finite(p.units) && Math.abs(p.units) > EPS));
    const ce = sum(cashEq);
    let cash = 0;
    for (const b of input.balances) {
      const v = finite(b.cash) ? convert(b.currency, b.cash) : null;
      if (v === null) known = false; else cash += v;
    }
    const r = (input.reportedTotal - others - cash) / ce;
    if (known && Math.abs(ce) > EPS && Number.isFinite(r)) r1 = round3(r);
  }

  // positionPriceLiveness: priced stock/ETF positions quoted in their security currency.
  const latest: number[] = [];
  const previous: number[] = [];
  for (const p of held) {
    const kind = p.kind.trim().toLowerCase();
    if (p.cashEquivalent || (kind !== "stock" && kind !== "etf") || !finite(p.price) || !(p.price > 0)) continue;
    const sec = norm(input.securityCurrencyOf(p.symbol));
    if (p.currency !== null && norm(p.currency) !== sec) continue;
    const ticker = input.tickerFor(p.symbol, sec);
    const h = ticker ? await historyOf(ticker) : null;
    if (!h) continue;
    const upTo = h.points.filter((pt) => pt.date <= input.today && Number.isFinite(pt.close) && pt.close > 0);
    const last = upTo[upTo.length - 1];
    if (!last) continue;
    latest.push(p.price / last.close);
    const prev = upTo[upTo.length - 2];
    if (prev) previous.push(p.price / prev.close);
  }
  const share = (list: number[]) => (list.length === 0 ? null : round2(list.filter((r) => Math.abs(r - 1) <= LIVENESS_NEAR).length / list.length));

  return {
    costBasisCurrency: distribution(costRatios),
    cashEquivalentInBalance: { count: cashEq.length, r1 },
    positionPriceLiveness: { count: latest.length, latest: distribution(latest), previous: distribution(previous), nearLatest: share(latest), nearPrevious: share(previous) },
  };
}
