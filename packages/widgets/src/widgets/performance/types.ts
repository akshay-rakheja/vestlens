// Mirrors PerformancePayload in packages/api (the widgets package cannot import API code).
export type PerformancePeriod = "1M" | "3M" | "YTD" | "1Y" | "3Y" | "ALL";
export type BenchmarkKey = "sp500" | "nasdaq100" | "dow" | "tsx" | "xeqt";
export type FigureReason = "insufficient_history" | "no_solution" | "flows_unavailable" | "benchmark_unavailable" | "flow_not_converted" | "under_a_year";
export type SeriesSource = "reported" | "reconstructed" | "estimated";

export interface Figure { value: number | null; estimated: boolean; reason?: FigureReason }
export interface IndexPoint { date: string; value: number }
export interface SeriesPoint { date: string; value: number; source: SeriesSource }
export interface MonthlyReturn { month: string; return: number | null; partial: boolean; estimated: boolean }
export interface PortfolioSettingsView { benchmark: BenchmarkKey; cadView: boolean; privacyDefault: boolean }

export interface PerformanceResult {
  span: { start: string; end: string; partial: boolean; since?: string };
  figures: {
    personalReturn: Figure & { annualised: boolean }; investmentReturn: Figure; benchmarkReturn: Figure;
    /** Same money in the index: the start value and every flow replayed into it; compares with personalReturn. Absent on older payloads. */
    matchedBenchmarkReturn?: Figure & { annualised: boolean; exhausted?: boolean };
    /** What that index holding is worth at the span end. Absent on older payloads. */
    matchedBenchmarkValue?: Figure;
    /** The two returns as compound yearly rates (CAGR) over the span; absent on older payloads. */
    investmentCagr?: Figure & { years?: number }; benchmarkCagr?: Figure & { years?: number };
    valueChange: Figure; netDeposits: Figure; marketGain: Figure;
    /** Values of accounts joining (+) or leaving (−) the series; not deposits. Absent on older payloads. */
    accountsAddedToTracking?: Figure & { joined?: number; left?: number; movedFromTracked?: number };
    maxDrawdown: Figure & { peak?: string; trough?: string }; volatility: Figure;
    bestMonth: Figure & { month?: string }; worstMonth: Figure & { month?: string };
  };
  monthly: MonthlyReturn[];
  /** riskMergedDates: days merged away by the deposit-lag rule; the drawdown chart omits them. */
  series: { value: SeriesPoint[]; netDeposits: IndexPoint[]; twrIndex: IndexPoint[]; benchmarkIndex: IndexPoint[]; riskMergedDates?: string[] };
}

export interface PerformancePayload {
  scope: { kind: "portfolio" | "account"; accountId?: string; label: string; currency: string };
  accounts: Array<{ id: string; label: string; currency: string }>;
  period: PerformancePeriod;
  span: PerformanceResult["span"];
  series: PerformanceResult["series"];
  figures: PerformanceResult["figures"];
  monthly: PerformanceResult["monthly"];
  /** label: the name with its basis ("S&P 500 (total return)"); absent on older payloads. */
  benchmark: { key: BenchmarkKey; name: string; label?: string; explainer: string; basis?: string; note: string | null; unavailableReason: string | null };
  benchmarks: Array<{ key: BenchmarkKey; name: string; explainer: string }>;
  settings: PortfolioSettingsView;
  history: { qualities: Array<{ accountId: string; method: string; reason: string | null; driftFraction: number | null }>; earliest: string | null };
  otherCurrencies: string[];
  asOf: string;
  /** CAD view with a USD account in scope (mirrors PerformanceHome in the API); null or absent otherwise. */
  home?: PerformanceHome | null;
}

export interface PerformanceHome {
  currency: "CAD";
  /** False: nothing could be converted and the payload is in the scope's own currency. */
  converted: boolean;
  estimated: boolean;
  /** Days left out of the series (a USD account had no rate within 7 days). */
  notConvertedDays: number;
  /** Accounts never converted in the span (e.g. no rate at all). */
  notConvertedAccounts: number;
  /** First date of a USD deposit or withdrawal with no rate: the return is withheld. */
  flowNotConverted: string | null;
  /** One USD account: its own-currency figures. */
  native: { currency: string; value: number | null; valueChange: Figure; netDeposits: Figure; marketGain: Figure } | null;
}
