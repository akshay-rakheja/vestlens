import type { HomeAmountView, HomeTotalView } from "../../kit/home-money";
// Mirrors ActivityPage, ActivityRow and SymbolHistory in packages/api (the widgets package cannot import API code).
export type ActivityCategory = "investing" | "moving_money" | "cash";
export type AccountKind = "investment" | "cash" | "credit";
export type BenchmarkKey = "sp500" | "nasdaq100" | "dow" | "tsx" | "xeqt";
export interface PortfolioSettingsView { benchmark: BenchmarkKey; cadView: boolean; privacyDefault: boolean }

export interface ActivityRow {
  id: string; date: string; accountId: string; accountLabel: string; category: ActivityCategory; type: string;
  symbol: string | null; description: string; units: number | null; price: number | null;
  /** Currency of `price`: the security's currency, else the transaction currency. */
  priceCurrency: string | null;
  /** Display amount in `currency`: negative is money out. */
  amount: number | null;
  currency: string | null; estimated?: true;
  /** The direction of `amount` is unknown; render it without a sign. */
  unsigned?: true;
  /** CAD figure for `amount`, following the displayed sign; present when the CAD view is on and amount is not null. */
  home?: HomeAmountView;
}

export interface ActivityPage {
  rows: ActivityRow[];
  nextCursor: string | null;
  restarted: boolean;
  /** `dividends` is net of matched withholding tax (dividendsGross + withholding); feeTransactions are FEE rows only. */
  totals: Array<{ currency: string; bought: number; sold: number; dividends: number; dividendsGross?: number; withholding?: number; deposits: number; withdrawals: number; feeTransactions?: number; unmatchedWithholding?: { count: number; amount: number } }>;
  /** Counts over every filtered row (not just the page); drives the summary text. */
  /** CAD totals over the whole filtered range; present when the CAD view is on. */
  homeTotals?: { bought: HomeTotalView; sold: HomeTotalView; dividends: HomeTotalView };
  counts: { total: number; byType: Record<string, number> };
  /** `accountType` echoes the shared filter; `accountId` is also set when the type matched one account. */
  filters: { accountId?: string; accountType?: string; categories: ActivityCategory[]; symbol?: string; from: string; to: string; query?: string };
  accounts: Array<{ id: string; label: string; kind: AccountKind }>;
  syncing: string[];
  settings: PortfolioSettingsView;
  asOf: string;
}

export interface SymbolPositionPoint { date: string; units: number; avgCost: number | null }
export interface SymbolPosition {
  currency: string | null;
  /** One per activity date that changed units. */
  points: SymbolPositionPoint[];
  units: number;
  avgCost: number | null;
  avgCostEstimated: boolean;
  reason?: "inconsistent";
  /** Dividends paid in `currency`, net of matched withholding: the figure the activity totals give. */
  dividends: number;
  /** The same net figure for dividends paid in another currency, per currency. */
  otherDividends: Array<{ currency: string; amount: number }>;
  /** Withholding rows matching no dividend (not deducted), per currency. */
  unmatchedWithholding?: Array<{ currency: string; count: number; amount: number }>;
  markers: Array<{ date: string; side: "buy" | "sell"; units: number; price: number | null }>;
}

/** Sums over the scope accounts' current positions of the symbol (brokerage cost basis is per unit). */
export interface ReportedFigures {
  units: number | null;
  avgCost: number | null;
  bookCost: number | null;
  marketValue: number | null;
  totalReturn: number | null;
  totalReturnFraction: number | null;
  currency: string | null;
}

export interface SymbolHistory {
  symbol: string; name: string | null; currency: string | null; period: "1Y" | "ALL";
  prices: Array<{ date: string; close: number }>;
  priceUnavailable: boolean;
  position: SymbolPosition;
  /** Units the brokerage reports now in the same accounts and currency; null when unavailable. */
  reportedUnits: number | null;
  /** Brokerage-reported figures for the current holding; null when nothing is held (or holdings are unavailable). */
  reported: ReportedFigures | null;
  /** Whether the replayed average-cost line reconciles with the brokerage's average cost. */
  costHistory: "matches" | "unavailable" | "unverified";
  /** CAD gains (always est.); null or absent when the CAD view is off. */
  homeGains?: { realized: { amount: number; estimated: boolean } | null; unrealized: { amount: number; estimated: boolean } | null; unavailable: boolean } | null;
  otherCurrencies: string[];
  asOf: string;
}
