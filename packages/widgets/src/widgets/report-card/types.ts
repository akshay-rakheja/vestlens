/**
 * show_report_card's structuredContent: the ReportCard exactly as GET /api/report-card returns it
 * (packages/api/src/report/report-loader.ts ReportCard; the dashboard's ReportCardView, packages/web/src/ReportCard.tsx).
 */
export interface CantTell { count: number; reasons: Array<{ reason: string; count: number; symbols: string[] }> }
export interface CallRow { symbol: string; returnPct: number; vsSp500Pct: number; vsTsxPct: number | null; startDate: string; endDate: string; estimated: boolean; rateDate: string | null }
export type UnmeasuredAhead = Omit<CallRow, "vsSp500Pct" | "vsTsxPct">;
export interface NativePart { currency: string; amount: number }
export interface SaleRow {
  symbol: string; date: string; units: number; salePrice: number; currency: string; estimated: boolean; priceRateDate: string | null;
  recordedPrice: { amount: number; currency: string } | null; latestClose: number; latestCloseDate: string; latestCloseSplitAdjusted?: number;
  changePct: number; keptVsSold: { native: { amount: number; currency: string }; cad: number | null; estimated: boolean; rateDate: string | null };
}
export interface CallsSection {
  checked: number;
  items: CallRow[];
  summary: { compared: number; ahead: number; behind: number; even: number; best: CallRow | null; worst: CallRow | null; aheadUnmeasured: UnmeasuredAhead[] };
  cantTell: CantTell;
}
export interface AfterSoldSection {
  items: SaleRow[];
  summary: {
    sells: number; rose: number; fell: number; unchanged: number; keptVsSoldCad: number | null; estimated: boolean; rateDate: string | null;
    notConverted: number; native: NativePart[];
  };
  cantTell: CantTell;
}
export interface TradingCostSection {
  conversion: {
    rows: number; convertedCad: number; estimated: boolean; rateDate: string | null; native: NativePart[]; cantTell: CantTell;
    estimate: { rows: number; minRows: number; costCad: number | null; sharePct: number | null; estimated: true; rateDates: { first: string; last: string } | null; cantTell: CantTell };
  };
  fees: { rows: number; totalCad: number; estimated: boolean; rateDate: string | null; native: NativePart[]; cantTell: CantTell };
}
export interface SinceStart { from: string; to: string; years: number; cagrPct: number; sp500CagrPct: number; estimated: boolean }
export interface OverallSection { period: "YTD"; from: string; to: string; returnPct: number; sp500Pct: number; returnEstimated: boolean; sp500Estimated: boolean; sinceStart?: SinceStart }
export interface ReportCardPayload {
  asOf: string;
  activityFrom: string | null;
  calls: CallsSection;
  afterSold: AfterSoldSection;
  tradingCost: TradingCostSection;
  overall: OverallSection | null;
}
