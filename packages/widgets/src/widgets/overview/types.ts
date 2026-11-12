import type { HomeTotalView } from "../../kit/home-money";
export type Period = "1D" | "1W" | "1M" | "3M" | "YTD" | "1Y" | "ALL";
export interface CurrencyAmount { currency: string; amount: number }
export interface ReturnFigure { value: number | null; estimated: boolean; reason?: string }
export interface OverviewSeries {
  period: Period; currency: string; points: Array<{ date: string; value: number; source: "reported" | "reconstructed" | "estimated" }>;
  benchmark: { key: string; name: string; explainer: string; basis?: string; points: Array<{ date: string; returnFraction: number }> | null; unavailableReason: string | null };
  /** Value change over [spanStart, today]; deposits are not separated yet, so it is not a return. */
  portfolioReturn: number | null; benchmarkReturn: number | null; fxNote: string | null;
  /** Time-weighted return (excludes deposits) and the benchmark over the same span; absent on older payloads. */
  investmentReturn?: ReturnFigure; benchmarkReturnTwr?: ReturnFigure;
  /** Span the time-weighted return covers; can start later than the value series. */
  returnSpan?: { partial: boolean; since: string | null } | null;
  spanStart: string | null; spanIsPartial: boolean;
  /** CAD view with a USD account: points and returns in CAD (USD × each day's BoC rate); days not converted are left out. */
  home?: { estimated: boolean; notConvertedDays: number; notConvertedAccounts: number; flowNotConverted: string | null };
}
/** `get_intraday` result: a live estimate line, drawn only when enough holdings are priced. */
export interface IntradayPayload {
  points: Array<{ t: string; value: number }>; coverage: number; sessionDate: string | null; drawn: boolean;
  warnings?: string[]; label: string; fallback: { previousClose: number | null; reported: number | null };
  /** Currency of the line; absent on older payloads (then the primary currency). */
  currency?: string;
}
export interface OverviewPayload {
  portfolio: { connectionRequired: boolean; generatedAt: string; totals: CurrencyAmount[]; accounts: Array<{ id?: string; unifiedType?: string | null; classification?: { label: string; includedInPortfolioTotal?: boolean }; value?: { amount: number; currency: string } | null; freshness?: { holdingsLastSyncedAt: string | null } }>; errors: unknown[]; cache?: { stale: boolean; loadedAt: string } };
  summary: {
    primaryCurrency: string | null; totals: CurrencyAmount[];
    /** Estimated from market quotes, per holding currency. */
    dayChange: Array<{ currency: string; amount: number; fraction: number | null; coverage: number; estimated?: boolean }>;
    /** The session the day change's quotes belong to (Toronto date); absent on older payloads. */
    dayChangeSession?: string;
    unrealizedGain: CurrencyAmount[];
    /** Holdings with a cost basis out of all holdings; absent on older payloads. */
    unrealizedCoverage?: { withCostBasis: number; holdings: number };
    cash: CurrencyAmount[];
    cashNetOfMargin?: boolean;
    /** Share of the reported total; estimated when foreign values were converted. */
    largestHolding: { symbol: string; fraction: number; estimated?: boolean; basis?: string } | null;
    allocation: Array<{ key: string; label: string; fraction: number }>;
    groups: Array<{ key: string; label: string; currency: string; value: number; accountCount: number; unavailableCount?: number; holdingCount: number; dayChangeFraction: number | null; dayChangeCoverage?: number; accountIds: string[] }>;
    allocationCurrency: string | null;
    /** Figures in CAD (mirrors `OverviewHome` in the API); absent on older payloads. */
    home?: {
      total: HomeTotalView; includesUnreported: boolean;
      dayChange: HomeTotalView; dayChangeIncludesFx?: boolean; dayChangeFraction: number | null; dayChangeCoverage: number;
      unrealizedGain: HomeTotalView; cash: HomeTotalView;
      groups: Array<{ key: string; value: HomeTotalView }>;
      /** Asset classes of all holdings and cash in CAD (USD at the latest rate); absent on older payloads. */
      allocation?: Array<{ key: string; label: string; fraction: number }>;
      allocationEstimated?: boolean;
      allocationNotConverted?: number;
    };
  };
  series: OverviewSeries;
  settings: { benchmark: string; cadView: boolean; privacyDefault: boolean };
  benchmarks: Array<{ key: string; name: string; explainer: string }>;
  /** building: a newly linked account's first history read hasn't finished (history/pending-history.ts). */
  history?: { qualities: Array<{ accountId: string; method: string; reason: string | null; driftFraction: number | null }>; earliest: string | null; building?: boolean };
}
