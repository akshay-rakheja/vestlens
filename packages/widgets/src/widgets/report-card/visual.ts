import { shortSymbol } from "../../kit/components";
import { calendarDate } from "../tfsa-room/format";
import { callRows, convertedNote, pct, saleRow, SHOWN, type Fmt } from "./headlines";
import type { AfterSoldSection, CallsSection, OverallSection, ReportCardPayload, TradingCostSection } from "./types";

/**
 * The chart-first card's view model. Every figure
 * still comes from show_report_card; this only orders, scales and words it. The long dashboard lines from headlines.ts
 * become each row's tap-for-detail line, so nothing the dashboard says is lost.
 */

export type Bench = "S&P 500" | "TSX";
export const BENCHES: readonly Bench[] = ["S&P 500", "TSX"];
export const TAP_HINT = "Tap a bar for the details.";

/** One chart row: `value` null draws no bar unless `unmeasured` (ahead by more than can be measured: a full, faded bar). */
export interface BarRow { symbol: string; value: number | null; figure: string; detail: string; unmeasured?: boolean }
export type Mark = "ahead" | "behind" | "level";

const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "-" : "");
const pts = (n: number) => `${sign(n)}${Math.abs(n).toFixed(1)} pts`;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const mark = (v: number): Mark => (v > 0 ? "ahead" : v < 0 ? "behind" : "level");
/** Highest first; unmeasured-ahead rows lead, rows without a figure trail. */
const byValue = (a: BarRow, b: BarRow) => (b.unmeasured ? 1 : 0) - (a.unmeasured ? 1 : 0) || (b.value ?? -Infinity) - (a.value ?? -Infinity);

export function callBars(calls: CallsSection, bench: Bench): BarRow[] {
  const lines = callRows(calls).map((r) => `${shortSymbol(r.symbol)}: ${r.detail}`);
  const measured = calls.items.map((i, n) => {
    const v = bench === "S&P 500" ? i.vsSp500Pct : i.vsTsxPct;
    return { symbol: i.symbol, value: v, figure: v === null ? "No figure" : pts(v), detail: lines[n]! };
  });
  const unmeasured = calls.summary.aheadUnmeasured.map((i, n) => (bench === "S&P 500"
    ? { symbol: i.symbol, value: null, figure: "Ahead", detail: lines[calls.items.length + n]!, unmeasured: true }
    : { symbol: i.symbol, value: null, figure: "No figure", detail: lines[calls.items.length + n]! }));
  return [...measured, ...unmeasured].sort(byValue);
}

/** "A of N came out ahead" and one mark per compared holding. The S&P 500 uses the server's counts. */
export function callTally(calls: CallsSection, bench: Bench): { ahead: number; total: number; marks: Mark[] } {
  const rows = callBars(calls, bench);
  const marks = rows.filter((r) => r.value !== null || r.unmeasured).map((r) => (r.unmeasured ? "ahead" : mark(r.value!)));
  if (bench === "S&P 500") return { ahead: calls.summary.ahead, total: calls.summary.compared, marks };
  return { ahead: marks.filter((m) => m === "ahead").length, total: marks.length, marks };
}

export const saleBars = (s: AfterSoldSection, f: Fmt = SHOWN): BarRow[] =>
  s.items.map((i) => ({ symbol: i.symbol, value: i.changePct, figure: pct(i.changePct), detail: (({ detail }) => `${shortSymbol(i.symbol)}, ${detail}`)(saleRow(i, f)) })).sort(byValue);

/** The axis end for a set of figures: the largest magnitude, never below 5 so small figures don't fill the chart. */
export const scaleMax = (values: Array<number | null>) => Math.max(5, ...values.map((v) => Math.abs(v ?? 0)));

/** A bar's left edge and width in percent of the track, around a centre zero line. */
export function barGeometry(value: number, max: number): { left: number; width: number } {
  const width = Math.min(Math.abs(value) / max, 1) * 50;
  return { left: value >= 0 ? 50 : 50 - width, width };
}

export const overallYear = (p: ReportCardPayload) => (p.overall ? p.overall.from : p.asOf).slice(0, 4);

export function overallGap(o: OverallSection): string {
  const d = Math.round((o.returnPct - o.sp500Pct) * 10) / 10;
  const est = o.returnEstimated || o.sp500Estimated ? " (est.)" : "";
  if (d === 0) return `Level with the S&P 500${est}`;
  return `${Math.abs(d).toFixed(1)} ${Math.abs(d) === 1 ? "point" : "points"} ${d > 0 ? "ahead of" : "behind"} the S&P 500${est}`;
}

/** The kept-vs-sold total in one line; what it means moves to "How this is worked out". */
export function keptVsSoldLine(s: AfterSoldSection, f: Fmt = SHOWN): string | null {
  const { summary } = s;
  if (summary.keptVsSoldCad === null) return null;
  const left = summary.notConverted > 0 ? ` ${summary.notConverted} ${plural(summary.notConverted, "sale isn't", "sales aren't")} in it: no Bank of Canada rate to convert.` : "";
  return `Kept vs sold, all together: ${f.signedCad(summary.keptVsSoldCad)}${convertedNote(f, summary.estimated, summary.rateDate, summary.native)}.${left}`;
}
/** How each section is worked out, behind its title's info icon. Facts only. */
export const INFO = {
  overall: "Time-weighted return, as on the performance view: how your investments did, with deposits and withdrawals taken out. The S&P 500 is its total-return index (dividends reinvested) in CAD at the Bank of Canada rate, so it is an estimate.\n\nPer year is the compound annual growth rate since your history begins: the same return spread evenly over the years. It shows once there is a year or more of history.",
  calls: "Each holding is money-weighted from your first recorded purchase, against the same money put into the index on the same days. The S&P 500 is its total-return index (dividends reinvested). The TSX is a price index (dividends not included); holdings count their dividends, before withholding, which favours them slightly against it.\n\nFrom your stored activity and cached market closes only.",
  sold: "Each sale's price against the latest close, splits included. Kept vs sold is the shares' value at the latest close minus what the sales brought in, before fees. US-dollar figures use the Bank of Canada rate (est.).",
  cost: "Currency conversion compares each trade in a security whose currency differs from the account's with that day's close at the Bank of Canada rate. Single trades are noisy; the total over many trades is the useful figure.\n\nFees are as your brokerage recorded them.",
} as const;


export interface CostTile { label: string; value: string; sub: string }

/** The two tiles: the conversion cost estimate and the fees, amounts through `f` so Hide amounts blurs them. */
export function costTiles(cost: TradingCostSection, f: Fmt = SHOWN): [CostTile, CostTile] {
  const { conversion, fees } = cost;
  const { estimate } = conversion;
  const fx: CostTile = conversion.rows === 0
    ? { label: "Currency conversion", value: "None", sub: conversion.cantTell.count > 0 ? `${conversion.cantTell.count} ${plural(conversion.cantTell.count, "trade", "trades")} between CAD and USD couldn't be read` : "No trades between CAD and USD found" }
    : estimate.costCad === null
      ? { label: "Currency conversion", value: "Not enough trades", sub: `${estimate.rows} of the ${estimate.minRows} needed for an estimate` }
      : estimate.costCad >= 0
        ? { label: "Currency conversion", value: `about ${f.cad(Math.round(estimate.costCad))}`, sub: estimate.sharePct === null ? "est." : `${estimate.sharePct.toFixed(2)}% of the value compared (est.)` }
        : { label: "Currency conversion", value: `about ${f.cad(Math.round(-estimate.costCad))} ahead`, sub: "against the Bank of Canada rate (est.)" };
  const fee: CostTile = fees.rows > 0
    ? { label: "Fees", value: f.cad(fees.totalCad), sub: `${fees.rows} ${plural(fees.rows, "fee", "fees")}${convertedNote(f, fees.estimated, fees.rateDate, fees.native)}` }
    : { label: "Fees", value: "None", sub: fees.cantTell.count > 0 ? `${fees.cantTell.count} fee ${plural(fees.cantTell.count, "row", "rows")} couldn't be read` : "No fees recorded" };
  return [fx, fee];
}

/** The per-$100 meter: only when there is a cost (not a gain) with a share. */
export function costMeter(cost: TradingCostSection): { share: number; line: string } | null {
  const { costCad, sharePct } = cost.conversion.estimate;
  if (costCad === null || costCad < 0 || sharePct === null) return null;
  return { share: sharePct, line: `Every $100 converted cost about $${sharePct.toFixed(2)} against the Bank of Canada rate` };
}

/** The estimate's span: trades counted and the Bank of Canada dates. */
export function costBasisLine(cost: TradingCostSection): string | null {
  const { estimate } = cost.conversion;
  if (estimate.costCad === null) return null;
  const dates = estimate.rateDates ? `, Bank of Canada rates from ${calendarDate(estimate.rateDates.first)} to ${calendarDate(estimate.rateDates.last)}` : "";
  return `Estimated over ${estimate.rows} trades against each day's close${dates}; single trades are noisy.`;
}

/* Share card -------------------------------------------------------------------------------------------------- */

export interface ShareFigure { value: string; label: string }

/** Up to three figures for the share card: percentages and counts only, never amounts or symbols. */
export function shareFigures(p: ReportCardPayload): ShareFigure[] {
  const out: ShareFigure[] = [];
  if (p.overall) out.push({ value: pct(p.overall.returnPct), label: `vs S&P 500 total return ${pct(p.overall.sp500Pct)}` });
  if (p.calls.summary.compared > 0) out.push({ value: `${p.calls.summary.ahead}/${p.calls.summary.compared}`, label: "holdings ahead of the S&P 500 total return" });
  const meter = costMeter(p.tradingCost);
  if (meter) out.push({ value: `${meter.share.toFixed(2)}%`, label: "conversion cost (est.)" });
  return out;
}

export const shareTitle = (p: ReportCardPayload) => `My ${overallYear(p)} investing`;
export const SHARE_FOOTER = "Estimates from my own trades. Read-only. Not advice. vestlens.com";

export function shareText(p: ReportCardPayload): string | null {
  const figs = shareFigures(p);
  if (figs.length === 0) return null;
  return [`${shareTitle(p)}, so far:`, ...figs.map((f) => `${f.value} ${f.label}`), SHARE_FOOTER].join("\n");
}
