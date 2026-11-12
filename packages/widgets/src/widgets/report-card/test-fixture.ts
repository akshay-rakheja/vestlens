import type { ReportCardPayload } from "./types";

// Synthetic symbols, dates, prices and amounts only: the dashboard test's card (packages/web/src/ReportCard.test.tsx).
export const call = (symbol: string, vs: number, over: Record<string, unknown> = {}) => ({
  symbol, returnPct: vs + 5, vsSp500Pct: vs, vsTsxPct: vs + 1 as number | null, startDate: "2025-01-02", endDate: "2026-10-22", estimated: false, rateDate: null as string | null, ...over,
});
export const none = { count: 0, reasons: [] };

export const card = (over: Partial<ReportCardPayload> = {}): ReportCardPayload => ({
  asOf: "2026-10-23",
  activityFrom: "2025-01-02",
  calls: {
    checked: 5,
    items: [call("AAA", 12.5), call("CCC", 2, { estimated: true, rateDate: "2026-10-22" }), call("BBB", -15)],
    summary: {
      compared: 4, ahead: 3, behind: 1, even: 0, best: call("AAA", 12.5), worst: call("BBB", -15),
      aheadUnmeasured: [{ symbol: "WIN", returnPct: 50, startDate: "2025-02-03", endDate: "2026-03-02", estimated: false, rateDate: null }],
    },
    cantTell: { count: 1, reasons: [{ reason: "stored activity doesn't cover this holding's full history", count: 1, symbols: ["DDD"] }] },
  },
  afterSold: {
    items: [
      {
        symbol: "USX", date: "2026-04-01", units: 10, salePrice: 100, currency: "USD", estimated: true, priceRateDate: "2026-04-01",
        recordedPrice: { amount: 135, currency: "CAD" }, latestClose: 110, latestCloseDate: "2026-10-22",
        changePct: 10, keptVsSold: { native: { amount: 100, currency: "USD" }, cad: 135, estimated: true, rateDate: "2026-10-22" },
      },
      {
        symbol: "DWN", date: "2026-02-02", units: 4, salePrice: 20, currency: "CAD", estimated: false, priceRateDate: null, recordedPrice: null,
        latestClose: 15, latestCloseDate: "2026-10-22",
        changePct: -25, keptVsSold: { native: { amount: -20, currency: "CAD" }, cad: -20, estimated: false, rateDate: null },
      },
    ],
    summary: { sells: 2, rose: 1, fell: 1, unchanged: 0, keptVsSoldCad: 115, estimated: true, rateDate: "2026-10-22", notConverted: 0, native: [{ currency: "USD", amount: 100 }] },
    cantTell: { count: 1, reasons: [{ reason: "no price history for this symbol", count: 1, symbols: ["NOH"] }] },
  },
  tradingCost: {
    conversion: {
      rows: 25, convertedCad: 27000, estimated: false, rateDate: null, native: [], cantTell: { count: 1, reasons: [{ reason: "the trade's amount or date wasn't recorded", count: 1, symbols: ["NOA"] }] },
      estimate: {
        rows: 20, minRows: 20, costCad: 300, sharePct: 1.1111, estimated: true, rateDates: { first: "2025-01-02", last: "2026-01-05" },
        cantTell: { count: 1, reasons: [{ reason: "no closing price within 3 days of the trade", count: 1, symbols: ["GAP"] }] },
      },
    },
    fees: { rows: 3, totalCad: 8.7, estimated: true, rateDate: "2026-03-02", native: [{ currency: "USD", amount: 2 }], cantTell: none },
  },
  overall: null,
  ...over,
});

export const OVERALL = { period: "YTD" as const, from: "2026-01-01", to: "2026-10-22", returnPct: 8.4, sp500Pct: 12.1, returnEstimated: false, sp500Estimated: true };

/** No activity: every section empty. */
export const emptyCard = (): ReportCardPayload => {
  const base = card();
  return {
    ...base,
    activityFrom: null,
    calls: { checked: 0, items: [], summary: { compared: 0, ahead: 0, behind: 0, even: 0, best: null, worst: null, aheadUnmeasured: [] }, cantTell: none },
    afterSold: { items: [], summary: { sells: 0, rose: 0, fell: 0, unchanged: 0, keptVsSoldCad: null, estimated: false, rateDate: null, notConverted: 0, native: [] }, cantTell: none },
    tradingCost: {
      conversion: { ...base.tradingCost.conversion, rows: 0, convertedCad: 0, cantTell: none, estimate: { ...base.tradingCost.conversion.estimate, rows: 0, costCad: null, sharePct: null, rateDates: null, cantTell: none } },
      fees: { rows: 0, totalCad: 0, estimated: false, rateDate: null, native: [], cantTell: none },
    },
  };
};
