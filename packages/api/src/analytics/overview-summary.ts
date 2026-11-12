import { providerTicker } from "../market-data/ticker-map.js";
import type { Quote } from "../market-data/types.js";
import type { PortfolioPresentation, PortfolioPresentationAccount } from "../portfolio/portfolio-presentation.js";
import { isInvestable } from "./holdings.js";
import { homeAccountValues } from "../fx/home-accounts.js";
import { homeDayChange, previousTradingDay } from "../fx/day-change.js";
import { sumHome, type HomeAmount, type HomeConverter, type HomeTotal } from "../fx/home-currency.js";

export interface CurrencyAmount { currency: string; amount: number }
/**
 * Estimated from market quotes (SnapTrade reports no day change): Σ units × (price − previous close)
 * over the holdings priced in `currency`, whatever the account currency. `fraction` is against
 * Σ units × previous close of the same holdings; `coverage` is the lower of the quoted share of
 * value and of holdings in that currency, so an unpriced holding always shows as partial.
 */
export interface DayChange { currency: string; amount: number; fraction: number | null; coverage: number; estimated: true }
/**
 * `value` sums only the brokerage-reported totals; `unavailableCount` accounts have none. The day
 * change is converted to the group currency (BoC rate) and is null below GROUP_MIN_COVERAGE.
 */
export interface AccountTypeGroup { key: string; label: string; currency: string; value: number; accountCount: number; unavailableCount: number; holdingCount: number; dayChangeFraction: number | null; dayChangeCoverage: number; accountIds: string[] }
export interface OverviewSummary {
  primaryCurrency: string | null;
  totals: CurrencyAmount[];
  dayChange: DayChange[];
  /** The session the day change's stock and fund quotes belong to (Toronto date); differs from today on a non-trading day. */
  dayChangeSession?: string;
  /** Σ units × (price − costBasis) per security currency (both brokerage-reported, costBasis per unit). */
  unrealizedGain: CurrencyAmount[];
  /** Holdings with a cost basis out of all holdings: below all, the gain is partial. */
  unrealizedCoverage: { withCostBasis: number; holdings: number };
  /** Reported cash of the accounts counted in `totals`. */
  cash: CurrencyAmount[];
  /** Some balance is negative (a margin debit), so the cash is net of it. */
  cashNetOfMargin: boolean;
  /**
   * Share of the reported total; `estimated` when foreign holdings or totals were converted at the BoC rate. `basis`
   * is the caption: with a margin debit the reported total is net equity, so the share can exceed 100%.
   */
  largestHolding: { symbol: string; fraction: number; estimated: boolean; basis: string } | null;
  allocation: Array<{ key: string; label: string; fraction: number }>;
  allocationCurrency: string | null;
  groups: AccountTypeGroup[];
  /** The same figures in the home currency (CAD); present when the summary was built with a converter. */
  home?: OverviewHome;
}
/**
 * Overview figures in CAD (spec 6.1, 6.5). `total` is `homeAccountValues(...).total`, so Overview,
 * Holdings and Allocation agree. Parts that could not be converted are listed in each `excluded`.
 */
export interface OverviewHome {
  total: HomeTotal;
  /** The CAD total counts accounts with no brokerage total (converted from holdings, est.). */
  includesUnreported: boolean;
  /**
   * Estimated from market quotes. USD holdings: units × price × today's rate − units × previous close ×
   * the rate on or before the previous trading day, so it includes currency movement. CAD holdings exact.
   */
  dayChange: HomeTotal;
  /** A converted holding is in `dayChange`, so the CAD figure includes the day's currency move. */
  dayChangeIncludesFx: boolean;
  /** `dayChange` against yesterday's CAD value of the covered holdings; null without coverage. */
  dayChangeFraction: number | null;
  /** Lower of the quoted-and-converted share of CAD value and of holdings. */
  dayChangeCoverage: number;
  /** Brokerage-reported unrealized gain per holding, USD converted at the latest rate (est.). */
  unrealizedGain: HomeTotal;
  cash: HomeTotal;
  /** One CAD value per `groups` entry, summed from its accounts' `homeAccountValues` parts. */
  groups: Array<{ key: string; value: HomeTotal }>;
  /**
   * Asset-class shares of the reported accounts' holdings and cash in every currency, USD converted at the
   * latest rate (the native `allocation` covers primary-currency holdings only). Unconverted parts are left out.
   */
  allocation: Array<{ key: string; label: string; fraction: number }>;
  allocationEstimated: boolean;
  allocationNotConverted: number;
}
export interface SummaryOptions {
  /** Latest Bank of Canada USD/CAD rate; without it nothing is converted. */
  usdCad?: number | null;
  /** Home-currency converter; with it the summary carries `home`. */
  home?: HomeConverter;
}
const BASIS_TOTAL = "of total value, cash included";
const BASIS_NET_OF_MARGIN = "of net value after a margin debit (the brokerage total), so it can be over 100%";
/** Below this coverage a group's day change is not shown. */
export const GROUP_MIN_COVERAGE = 0.8;

const ASSET_CLASS: Record<string, [string, string]> = {
  etf: ["etf", "ETFs"], stock: ["stock", "Stocks"], equity: ["stock", "Stocks"], cs: ["stock", "Stocks"],
  crypto: ["crypto", "Crypto"], mutualfund: ["fund", "Funds"],
};
const investable = (p: PortfolioPresentation) => p.accounts.filter((a) => a.classification.includedInPortfolioTotal);
const add = (map: Map<string, number>, key: string, amount: number) => map.set(key, (map.get(key) ?? 0) + amount);
const list = (map: Map<string, number>) => [...map].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => a.currency.localeCompare(b.currency));
function tickerOf(position: PortfolioPresentationAccount["positions"][number]) {
  return providerTicker({ symbol: position.symbol, kind: position.kind, currency: position.currency });
}

export function quoteTickers(portfolio: PortfolioPresentation): string[] {
  return [...new Set(investable(portfolio).flatMap((a) => a.positions.flatMap((p) => (tickerOf(p) && p.units ? [tickerOf(p)!] : []))))];
}

/** Whether any included holding or total is in another currency than the primary one (the summary then wants a rate). */
export function summaryNeedsFx(portfolio: PortfolioPresentation): boolean {
  const currencies = new Set<string>();
  for (const a of investable(portfolio)) {
    if (a.value) currencies.add(a.value.currency);
    for (const p of a.positions) if (p.currency && !p.cashEquivalent) currencies.add(p.currency);
  }
  return currencies.size > 1;
}

function converter(rate: number | null | undefined) {
  return (amount: number, from: string, to: string): number | null => {
    if (from === to) return amount;
    if (!rate || !(rate > 0)) return null;
    if (from === "USD" && to === "CAD") return amount * rate;
    if (from === "CAD" && to === "USD") return amount / rate;
    return null;
  };
}

export function buildOverviewSummary(portfolio: PortfolioPresentation, quotes: Map<string, Quote>, options: SummaryOptions = {}): OverviewSummary {
  const accounts = investable(portfolio);
  const convert = converter(options.usdCad);
  const totals = portfolio.totals.map((t) => ({ currency: t.currency, amount: t.amount }));
  const primary = [...totals].sort((a, b) => b.amount - a.amount || (a.currency === "CAD" ? -1 : b.currency === "CAD" ? 1 : a.currency.localeCompare(b.currency)))[0]?.currency ?? null;

  // Day change, per holding currency.
  const change = new Map<string, number>(); const base = new Map<string, number>();
  const coveredValue = new Map<string, number>(); const pricedValue = new Map<string, number>();
  const coveredCount = new Map<string, number>(); const holdingCount = new Map<string, number>();
  const unrealized = new Map<string, number>(); let withCostBasis = 0; let holdingsTotal = 0;
  const cash = new Map<string, number>(); let netOfMargin = false;
  const bySymbol = new Map<string, number>(); let symbolsUnconvertible = false; let converted = false;
  const classes = new Map<string, number>(); const classLabels = new Map<string, string>();
  const groups = new Map<string, AccountTypeGroup>();
  const groupStats = new Map<string, { delta: number; base: number; covered: number; priced: number; coveredCount: number; count: number }>();
  let dayChangeSession: string | undefined; let cryptoSession: string | undefined;

  for (const account of accounts) {
    const currency = account.value?.currency ?? account.balances[0]?.currency ?? primary ?? "CAD";
    const groupKey = `${account.classification.bucket}:${currency}`;
    const hasGroup = !!account.value || account.balances.length > 0;
    const reported = !!account.value;
    if (hasGroup) {
      const group = groups.get(groupKey) ?? { key: groupKey, label: account.classification.bucketLabel, currency, value: 0, accountCount: 0, unavailableCount: 0, holdingCount: 0, dayChangeFraction: null, dayChangeCoverage: 0, accountIds: [] };
      if (account.value) group.value += account.value.amount; else group.unavailableCount += 1;
      group.accountCount += 1; group.holdingCount += account.positions.length; group.accountIds.push(account.id);
      groups.set(groupKey, group);
    }
    const stats = groupStats.get(groupKey) ?? { delta: 0, base: 0, covered: 0, priced: 0, coveredCount: 0, count: 0 };
    if (hasGroup) groupStats.set(groupKey, stats);

    // Cash follows the reported totals' scope (accounts without a total are not in the big number).
    if (reported) for (const balance of account.balances) if (balance.cash !== null) {
      add(cash, balance.currency, balance.cash);
      if (balance.cash < 0) netOfMargin = true;
      if (balance.currency === primary) { add(classes, "cash", balance.cash); classLabels.set("cash", "Cash"); }
    }
    for (const position of account.positions) {
      if (position.cashEquivalent) continue;
      const holdingCurrency = position.currency ?? currency;
      add(holdingCount, holdingCurrency, 1);
      if (hasGroup) stats.count += 1;
      // Unrealized gain follows the reported totals' scope.
      if (reported) {
        holdingsTotal += 1;
        if (position.unrealizedGain !== null && position.currency) { add(unrealized, position.currency, position.unrealizedGain); withCostBasis += 1; }
      }
      if (position.marketValue === null || !position.currency) continue;
      add(pricedValue, position.currency, position.marketValue);
      const inGroup = hasGroup ? convert(position.marketValue, position.currency, currency) : null;
      if (inGroup !== null) stats.priced += inGroup;
      if (reported && primary) {
        const value = convert(position.marketValue, position.currency, primary);
        if (value === null) symbolsUnconvertible = true;
        else { add(bySymbol, position.symbol, value); if (position.currency !== primary) converted = true; }
      }
      if (reported && position.currency === primary) {
        const [key, label] = ASSET_CLASS[position.kind.toLowerCase()] ?? ["other", "Other"];
        add(classes, key, position.marketValue); classLabels.set(key, label);
      }
      const ticker = tickerOf(position);
      const found = ticker ? quotes.get(ticker) : undefined;
      // A quote in another currency would mix currencies in the day change; treat it as missing.
      const quote = found && (!found.currency || found.currency.toUpperCase() === position.currency.toUpperCase()) ? found : undefined;
      if (quote && quote.previousClose !== null && quote.previousClose > 0 && position.units !== null) {
        const session = quoteDate(quote.asOf);
        // Crypto trades every day: it doesn't say the stock market traded today.
        if (session && position.kind.toLowerCase() === "crypto") { if (!cryptoSession || session > cryptoSession) cryptoSession = session; }
        else if (session && (!dayChangeSession || session > dayChangeSession)) dayChangeSession = session;
        const delta = position.units * (quote.price - quote.previousClose);
        const prior = position.units * quote.previousClose;
        add(change, position.currency, delta); add(base, position.currency, prior);
        add(coveredValue, position.currency, position.marketValue); add(coveredCount, position.currency, 1);
        const d = hasGroup ? convert(delta, position.currency, currency) : null;
        const b = hasGroup ? convert(prior, position.currency, currency) : null;
        if (d !== null && b !== null && inGroup !== null) { stats.delta += d; stats.base += b; stats.covered += inGroup; stats.coveredCount += 1; }
      }
    }
  }

  const coverageOf = (covered: number, priced: number, nCovered: number, n: number) =>
    n === 0 || priced <= 0 ? 0 : Math.min(covered / priced, nCovered / n);
  const currencies = [...totals.map((t) => t.currency), ...[...holdingCount.keys()].filter((c) => !totals.some((t) => t.currency === c)).sort()];
  const dayChange: DayChange[] = currencies.map((currency) => {
    const amount = change.get(currency) ?? 0;
    const prior = base.get(currency) ?? 0;
    const coverage = coverageOf(coveredValue.get(currency) ?? 0, pricedValue.get(currency) ?? 0, coveredCount.get(currency) ?? 0, holdingCount.get(currency) ?? 0);
    return { currency, amount, coverage, fraction: coverage > 0 && prior > 0 ? amount / prior : null, estimated: true };
  });
  for (const [key, group] of groups) {
    const st = groupStats.get(key)!;
    group.dayChangeCoverage = coverageOf(st.covered, st.priced, st.coveredCount, st.count);
    group.dayChangeFraction = group.dayChangeCoverage >= GROUP_MIN_COVERAGE && st.base > 0 ? st.delta / st.base : null;
  }

  // Largest holding: a share of the reported total (other currencies converted at the BoC rate).
  let portfolioTotal: number | null = null;
  if (primary) {
    portfolioTotal = 0;
    for (const t of totals) {
      const v = convert(t.amount, t.currency, primary);
      if (v === null) { portfolioTotal = null; break; }
      if (t.currency !== primary) converted = true;
      portfolioTotal += v;
    }
  }
  const [topSymbol, topValue] = [...bySymbol].sort((a, b) => b[1] - a[1])[0] ?? [];
  const largestHolding = topSymbol && !symbolsUnconvertible && portfolioTotal !== null && portfolioTotal > 0
    ? { symbol: topSymbol, fraction: topValue! / portfolioTotal, estimated: converted, basis: netOfMargin ? BASIS_NET_OF_MARGIN : BASIS_TOTAL }
    : null;
  const classTotal = [...classes.values()].reduce((s, v) => s + v, 0);
  return {
    primaryCurrency: primary,
    totals,
    dayChange,
    ...(dayChangeSession ?? cryptoSession ? { dayChangeSession: dayChangeSession ?? cryptoSession } : {}),
    unrealizedGain: list(unrealized),
    unrealizedCoverage: { withCostBasis, holdings: holdingsTotal },
    cash: list(cash),
    cashNetOfMargin: netOfMargin,
    largestHolding,
    allocation: classTotal > 0 ? [...classes].sort((a, b) => b[1] - a[1]).map(([key, value]) => ({ key, label: classLabels.get(key)!, fraction: value / classTotal })) : [],
    allocationCurrency: classTotal > 0 ? primary : null,
    groups: [...groups.values()],
    ...(options.home ? { home: buildHome(portfolio, quotes, options.home, [...groups.values()]) } : {}),
  };
}

const torontoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });
export { previousTradingDay };
/** Toronto calendar date the quote's price refers to; undefined (converter's today) when unreadable. */
function quoteDate(asOf: string | undefined): string | undefined {
  const t = asOf ? Date.parse(asOf) : NaN;
  return Number.isFinite(t) ? torontoDate.format(new Date(t)) : undefined;
}
function buildHome(portfolio: PortfolioPresentation, quotes: Map<string, Quote>, conv: HomeConverter, groups: AccountTypeGroup[]): OverviewHome {
  const values = homeAccountValues(portfolio, conv);
  const accounts = portfolio.accounts.filter(isInvestable);
  const change: HomeAmount[] = []; const gain: HomeAmount[] = []; const cash: HomeAmount[] = [];
  const classes = new Map<string, HomeAmount[]>(); const classLabels = new Map<string, string>();
  const addClass = (key: string, label: string, part: HomeAmount) => { classes.set(key, [...(classes.get(key) ?? []), part]); classLabels.set(key, label); };
  let base = 0; let covered = 0; let priced = 0; let coveredCount = 0; let count = 0;
  for (const account of accounts) {
    const currency = account.value?.currency ?? account.balances[0]?.currency ?? "CAD";
    const reported = !!account.value;
    if (reported) for (const b of account.balances) if (b.cash !== null) { const part = conv.at(b.cash, b.currency); cash.push(part); addClass("cash", "Cash", part); }
    for (const position of account.positions) {
      if (position.cashEquivalent) continue;
      count += 1;
      if (reported && position.unrealizedGain !== null && position.currency) gain.push(conv.at(position.unrealizedGain, position.currency));
      const holdingCurrency = position.currency ?? currency;
      if (position.marketValue === null || !position.currency) continue;
      const value = conv.at(position.marketValue, holdingCurrency);
      if (value.amount !== null) priced += value.amount;
      if (reported) { const [key, label] = ASSET_CLASS[position.kind.toLowerCase()] ?? ["other", "Other"]; addClass(key, label, value); }
      const ticker = tickerOf(position);
      const found = ticker ? quotes.get(ticker) : undefined;
      const quote = found && (!found.currency || found.currency.toUpperCase() === position.currency.toUpperCase()) ? found : undefined;
      if (!quote || quote.previousClose === null || !(quote.previousClose > 0) || position.units === null) continue;
      const day = quoteDate(quote.asOf);
      const dayChangePart = homeDayChange(conv, { currency: position.currency, units: position.units, price: quote.price, previousClose: quote.previousClose, day, fallbackDay: torontoDate.format(new Date()) });
      change.push(dayChangePart);
      if (dayChangePart.amount === null) continue;
      const before = conv.at(position.units * quote.previousClose, position.currency, previousTradingDay(day ?? torontoDate.format(new Date())));
      base += before.amount ?? 0;
      if (value.amount !== null) { covered += value.amount; coveredCount += 1; }
    }
  }
  const dayChange = sumHome(change);
  const coverage = count === 0 || priced <= 0 ? 0 : Math.min(covered / priced, coveredCount / count);
  const byId = new Map(values.accounts.map((a) => [a.accountId, a]));
  const classTotals = [...classes].map(([key, parts]) => ({ key, total: sumHome(parts) }));
  const classSum = classTotals.reduce((s, c) => s + c.total.amount, 0);
  return {
    allocation: classSum > 0 ? classTotals.filter((c) => c.total.amount !== 0).sort((a, b) => b.total.amount - a.total.amount).map((c) => ({ key: c.key, label: classLabels.get(c.key)!, fraction: c.total.amount / classSum })) : [],
    allocationEstimated: classTotals.some((c) => c.total.estimated),
    allocationNotConverted: classTotals.reduce((n, c) => n + c.total.excludedCount, 0),
    total: values.total,
    includesUnreported: values.includesUnreported,
    dayChange,
    dayChangeIncludesFx: change.some((c) => c.estimated),
    dayChangeFraction: coverage > 0 && base > 0 ? dayChange.amount / base : null,
    dayChangeCoverage: coverage,
    unrealizedGain: sumHome(gain),
    cash: sumHome(cash),
    groups: groups.map((g) => ({ key: g.key, value: sumHome(g.accountIds.flatMap((id) => byId.get(id)?.parts ?? [])) })),
  };
}
