import { priceOutOfRange } from "../market-data/ticker-map.js";
import type { PortfolioPresentationAccount } from "../portfolio/portfolio-presentation.js";

const torontoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });

export interface HoldingRow {
  /** `SYMBOL|CURRENCY`: the same symbol in two currencies is two rows, never summed. */
  key: string;
  symbol: string;
  currency: string;
  kind: string;
  units: number;
  price: number | null;
  marketValue: number | null;
  /** Σ units × costBasis; null when any contributing position lacks a cost basis. */
  bookCost: number | null;
  totalReturn: number | null;
  totalReturnFraction: number | null;
  /** Share of the known market value of the same currency; null when this row's value is unknown. */
  weight: number | null;
  /** Share of the CAD-equivalent value of all rows (USD at the Bank of Canada rate); null without a rate. */
  weightCad: number | null;
  /** `sessionDate`: the Toronto date of the quote's session, when it can be read. */
  dayChange: { amount: number | null; fraction: number | null; estimated: true; sessionDate?: string } | null;
  accounts: Array<{ accountId: string; label: string; units: number; marketValue: number | null; bookCost: number | null; totalReturn: number | null }>;
}

export interface HoldingsTotals {
  currency: string;
  marketValue: number;
  bookCost: number | null;
  totalReturn: number | null;
  totalReturnFraction: number | null;
  /** Rows that have a book cost. */
  withCostBasis: number;
  holdings: number;
  cash: number;
}

const UNITS_EPS = 1e-9;
const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** CLAUDE.md investment-total rule: included in the portfolio total, open, and not a credit product. */
export function isInvestableClassification(c: PortfolioPresentationAccount["classification"]): boolean {
  if (!c.includedInPortfolioTotal || c.isClosed || c.group === "closed") return false;
  return !(c.bucket === "credit_card" || c.bucket === "line_of_credit" || c.group === "credit_products");
}

export function isInvestable(a: PortfolioPresentationAccount): boolean {
  return isInvestableClassification(a.classification);
}

interface Acc { units: number; book: number; costKnown: boolean; value: number; valueKnown: boolean }
const newAcc = (): Acc => ({ units: 0, book: 0, costKnown: true, value: 0, valueKnown: false });

/**
 * Aggregates the brokerage-reported positions of included, open, non-credit accounts into one row per
 * SYMBOL|CURRENCY. Options and cash-equivalents are skipped; cash comes from balances.
 */
export function aggregateHoldings(
  accounts: PortfolioPresentationAccount[],
  scope: { accountId?: string; currency?: string },
  labelOf: (account: PortfolioPresentationAccount) => string = (a) => a.classification.label,
): { rows: HoldingRow[]; totals: HoldingsTotals[] } {
  const wantCurrency = scope.currency?.trim().toUpperCase() || undefined;
  const rows = new Map<string, { row: HoldingRow; total: Acc; kinds: string; byAccount: Map<string, { label: string; acc: Acc }>; priceFrom: number | null }>();
  const cash = new Map<string, number>();

  for (const account of accounts) {
    if (!isInvestable(account)) continue;
    if (scope.accountId !== undefined && account.id !== scope.accountId) continue;
    const label = labelOf(account);
    for (const b of account.balances ?? []) {
      const currency = b.currency?.trim().toUpperCase();
      if (!currency || !finite(b.cash) || (wantCurrency && currency !== wantCurrency)) continue;
      cash.set(currency, (cash.get(currency) ?? 0) + b.cash);
    }
    for (const p of account.positions ?? []) {
      if (p.cashEquivalent || (p.kind ?? "").toLowerCase().includes("option")) continue;
      if (!finite(p.units) || Math.abs(p.units) <= UNITS_EPS) continue;
      const symbol = p.symbol.trim().toUpperCase();
      const currency = p.currency?.trim().toUpperCase();
      if (!symbol || !currency || (wantCurrency && currency !== wantCurrency)) continue;
      const key = `${symbol}|${currency}`;
      let entry = rows.get(key);
      if (!entry) {
        entry = {
          row: { key, symbol, currency, kind: (p.kind ?? "").trim().toLowerCase(), units: 0, price: null, marketValue: null, bookCost: null, totalReturn: null, totalReturnFraction: null, weight: null, weightCad: null, dayChange: null, accounts: [] },
          total: newAcc(), kinds: "", byAccount: new Map(), priceFrom: null,
        };
        rows.set(key, entry);
      }
      let mine = entry.byAccount.get(account.id);
      if (!mine) { mine = { label, acc: newAcc() }; entry.byAccount.set(account.id, mine); }
      const value = finite(p.marketValue) ? p.marketValue : finite(p.price) ? p.units * p.price : null;
      for (const acc of [entry.total, mine.acc]) {
        acc.units += p.units;
        if (finite(p.costBasis)) acc.book += p.units * p.costBasis; else acc.costKnown = false;
        if (value !== null) { acc.value += value; acc.valueKnown = true; }
      }
      if (entry.priceFrom === null && finite(p.price)) entry.priceFrom = p.price;
    }
  }

  const out: HoldingRow[] = [];
  for (const { row, total, byAccount, priceFrom } of rows.values()) {
    row.units = total.units;
    row.price = priceFrom;
    row.marketValue = total.valueKnown ? total.value : null;
    row.bookCost = total.costKnown ? total.book : null;
    if (row.bookCost !== null && row.marketValue !== null) {
      row.totalReturn = row.marketValue - row.bookCost;
      row.totalReturnFraction = row.bookCost > 0 ? row.totalReturn / row.bookCost : null;
    }
    row.accounts = [...byAccount.entries()].map(([accountId, { label, acc }]) => {
      const bookCost = acc.costKnown ? acc.book : null;
      const marketValue = acc.valueKnown ? acc.value : null;
      return { accountId, label, units: acc.units, marketValue, bookCost, totalReturn: bookCost !== null && marketValue !== null ? marketValue - bookCost : null };
    });
    out.push(row);
  }

  const byCurrency = new Map<string, HoldingRow[]>();
  for (const r of out) byCurrency.set(r.currency, [...(byCurrency.get(r.currency) ?? []), r]);
  const totals: HoldingsTotals[] = [];
  for (const currency of new Set([...byCurrency.keys(), ...cash.keys()])) {
    const list = byCurrency.get(currency) ?? [];
    const denominator = list.reduce((s, r) => s + (r.marketValue ?? 0), 0);
    for (const r of list) r.weight = r.marketValue !== null && denominator > 0 ? r.marketValue / denominator : null;
    const withCost = list.filter((r) => r.bookCost !== null);
    const both = withCost.filter((r) => r.marketValue !== null);
    const book = both.reduce((s, r) => s + r.bookCost!, 0);
    const ret = both.reduce((s, r) => s + (r.marketValue! - r.bookCost!), 0);
    totals.push({
      currency, marketValue: denominator,
      bookCost: withCost.length > 0 ? withCost.reduce((s, r) => s + r.bookCost!, 0) : null,
      totalReturn: both.length > 0 ? ret : null,
      totalReturnFraction: both.length > 0 && book > 0 ? ret / book : null,
      withCostBasis: withCost.length, holdings: list.length, cash: cash.get(currency) ?? 0,
    });
  }
  totals.sort((a, b) => a.currency.localeCompare(b.currency));
  out.sort((a, b) => a.currency.localeCompare(b.currency) || (b.marketValue ?? -Infinity) - (a.marketValue ?? -Infinity) || a.symbol.localeCompare(b.symbol));
  return { rows: out, totals };
}

/**
 * Estimated day change from live quotes: units × (price − previous close). A row without a quote, whose quote has no
 * matching currency, or whose quote price is out of range of the reported price, has none; a quote without a previous close gives null figures.
 */
export function applyDayChange(
  rows: HoldingRow[],
  quotes: Map<string, { price: number; previousClose: number | null; currency?: string | null; asOf?: string }>,
  tickerOf: (r: HoldingRow) => string | null,
): HoldingRow[] {
  return rows.map((r) => {
    const ticker = tickerOf(r);
    const q = ticker === null ? undefined : quotes.get(ticker);
    if (!q || !finite(q.price)) return { ...r, dayChange: null };
    // A quote must name the row's currency and be near the reported price, or it belongs to another listing.
    if (!q.currency || q.currency.trim().toUpperCase() !== r.currency) return { ...r, dayChange: null };
    if (finite(r.price) && r.price > 0 && priceOutOfRange(q.price / r.price)) return { ...r, dayChange: null };
    if (!finite(q.previousClose) || q.previousClose <= 0) return { ...r, dayChange: { amount: null, fraction: null, estimated: true } };
    const diff = q.price - q.previousClose;
    const t = q.asOf ? Date.parse(q.asOf) : Number.NaN;
    return { ...r, dayChange: { amount: r.units * diff, fraction: diff / q.previousClose, estimated: true, ...(Number.isFinite(t) ? { sessionDate: torontoDate.format(new Date(t)) } : {}) } };
  });
}
