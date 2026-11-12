import { shortSymbol } from "../../kit/components";
import { cad, calendarDate, estLabel, nativeMoney } from "../tfsa-room/format";
import type { AfterSoldSection, CallRow, CallsSection, NativePart, OverallSection, SaleRow, TradingCostSection } from "./types";

/**
 * The dashboard's report card wording (packages/web/src/ReportCard.tsx), ported so the chat card and the dashboard
 * say the same thing: section titles, headlines, the list lines and the notes. Formatting only; every figure comes
 * from show_report_card. With amounts hidden, every money amount, price and share count becomes HIDDEN (the card
 * draws it as a blurred mark); percentages and counts stay.
 */

export const TITLES = {
  overall: "Overall",
  calls: "Your calls against the market",
  afterSold: "After you sold",
  tradingCost: "What trading cost you",
} as const;

export const METHOD_NOTE = "How this is worked out: from your stored activity and cached market closes only. Each holding is money-weighted from your first recorded purchase against the same money in the S&P 500 (total return, dividends reinvested) and the TSX (a price index, dividends not included); holdings count their dividends, before withholding, so the TSX comparison favours holdings slightly. US-dollar figures use the Bank of Canada rate (est.). Facts only, not advice.";
export const LOADING_COPY = "Crunching your trades. The first time takes about 20 seconds.";
export const OVERALL_CAPTION = "Time-weighted, as on the performance view; the S&P 500 is its total-return index, dividends reinvested, converted to CAD at the Bank of Canada rate.";
export const OVERALL_MISSING = "This year's portfolio return against the S&P 500 isn't available";

/** Stands in for a hidden amount inside a line; the card splits on it and draws the blurred mark. */
export const HIDDEN = "⁣•⁣";

export interface Fmt { cad(n: number): string; signedCad(n: number): string; native(n: number, currency: string): string; units(n: number): string }
export const SHOWN: Fmt = { cad, signedCad: (n) => `${n > 0 ? "+" : ""}${cad(n)}`, native: nativeMoney, units: (n) => String(n) };
export const HIDDEN_FMT: Fmt = { cad: () => HIDDEN, signedCad: () => HIDDEN, native: () => HIDDEN, units: () => HIDDEN };

const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "-" : "");
export const pct = (n: number) => `${sign(n)}${Math.abs(n).toFixed(1)}%`;
export const points = (n: number) => `${sign(n)}${Math.abs(n).toFixed(1)} points`;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const est = (estimated: boolean, rateDate: string | null = null) => estLabel(estimated, rateDate);
const price = (f: Fmt, amount: number, currency: string) => (currency === "CAD" ? f.cad(amount) : f.native(amount, currency));
const span = (from: string, to: string) => `from ${calendarDate(from)} to ${calendarDate(to)}`;
const nativeList = (f: Fmt, native: NativePart[]) => native.map((n) => f.native(n.amount, n.currency)).join(" and ");
/** " (est., Bank of Canada rate D; includes US$X)" for a converted total; the estLabel alone without native parts. */
export const convertedNote = (f: Fmt, estimated: boolean, rateDate: string | null, native: NativePart[]) => {
  const label = estLabel(estimated, rateDate);
  return label && native.length > 0 ? `${label.slice(0, -1)}; includes ${nativeList(f, native)})` : label;
};
/** The dashboard's convertedMoney (roomFormat.ts), with the native amount through `f`. */
const convertedMoney = (f: Fmt, amount: string, c: { estimated: boolean; rateDate: string | null; native: { amount: number; currency: string } | null }) => {
  if (!c.native || c.native.currency === "CAD") return amount;
  const native = f.native(c.native.amount, c.native.currency);
  return c.estimated ? `${amount} (est., BoC ${c.rateDate ?? "date unknown"}; ${native})` : `${amount} (${native} at the broker's rate)`;
};

/* Overall ------------------------------------------------------------------------------------------------------ */

export const overallHeadline = (o: OverallSection) =>
  `From ${calendarDate(o.from)} to ${calendarDate(o.to)}: your portfolio ${pct(o.returnPct)}${est(o.returnEstimated)} `
  + `against the S&P 500's ${pct(o.sp500Pct)}${est(o.sp500Estimated)}`;

/* Your calls against the market -------------------------------------------------------------------------------- */

export const callsHeadline = (calls: CallsSection) => calls.summary.compared === 0
  ? "None of your holdings could be compared with the S&P 500 yet"
  : `${calls.summary.ahead} of ${calls.summary.compared} ${plural(calls.summary.compared, "holding", "holdings")} came out ahead of the S&P 500 since your first purchase`;

export const callsCounts = (calls: CallsSection) => {
  const { summary } = calls;
  return `${summary.ahead} ahead, ${summary.behind} behind${summary.even > 0 ? `, ${summary.even} level` : ""}, ${calls.cantTell.count} couldn't tell`;
};

const ends = (r: Pick<CallRow, "returnPct" | "startDate" | "endDate">) => `${pct(r.returnPct)} ${span(r.startDate, r.endDate)}`;

/** Highest and lowest against the S&P 500, when there are two or more figures (short symbols, as in the rows). */
export function bestWorstLines(calls: CallsSection): string[] {
  const { best, worst } = calls.summary;
  if (!best || !worst || calls.items.length < 2) return [];
  // Holdings ahead without a figure may be further ahead than any with one: the best line says it is the best with a figure.
  const bestLabel = calls.summary.aheadUnmeasured.length > 0 ? "Highest with a figure against the S&P 500" : "Highest against the S&P 500";
  return [
    `${bestLabel}: ${shortSymbol(best.symbol)}, ${points(best.vsSp500Pct)} (${ends(best)})${est(best.estimated, best.rateDate)}`,
    `Lowest against the S&P 500: ${shortSymbol(worst.symbol)}, ${points(worst.vsSp500Pct)} (${ends(worst)})${est(worst.estimated, worst.rateDate)}`,
  ];
}

export interface ListRow { symbol: string; detail: string; figure: string }

/** One row per holding: the dashboard line after "SYMBOL: ", and the figure against the S&P 500. */
export function callRows(calls: CallsSection): ListRow[] {
  return [
    ...calls.items.map((i) => ({
      symbol: i.symbol, figure: points(i.vsSp500Pct),
      detail: `${ends(i)}; ${points(i.vsSp500Pct)} against the S&P 500${i.vsTsxPct === null ? "" : `, ${points(i.vsTsxPct)} against the TSX`}${est(i.estimated, i.rateDate)}`,
    })),
    ...calls.summary.aheadUnmeasured.map((i) => ({
      symbol: i.symbol, figure: "Ahead",
      detail: `${ends(i)}; ahead of the S&P 500 by more than this comparison can put a number on (the sales brought in more than the same money in the index was worth)${est(i.estimated, i.rateDate)}`,
    })),
  ];
}
/** The dashboard's line: "SYMBOL: detail". */
export const callLine = (r: ListRow) => `${r.symbol}: ${r.detail}`;

/* After you sold ----------------------------------------------------------------------------------------------- */

export const afterSoldHeadline = (s: AfterSoldSection) => s.summary.sells === 0
  ? "No sales could be compared with the latest price yet"
  : `Since you sold, the price rose after ${s.summary.rose} of ${s.summary.sells} ${plural(s.summary.sells, "sale", "sales")}`;

export function keptVsSoldNote(s: AfterSoldSection, f: Fmt = SHOWN): string | null {
  const { summary } = s;
  if (summary.keptVsSoldCad === null) return null;
  return `Kept vs sold, all sales together: ${f.signedCad(summary.keptVsSoldCad)}${convertedNote(f, summary.estimated, summary.rateDate, summary.native)}. `
    + "That is the shares' value at the latest close, splits included, minus what the sales brought in (before fees)."
    + (summary.notConverted > 0 ? ` ${summary.notConverted} ${plural(summary.notConverted, "sale isn't", "sales aren't")} in this total: no Bank of Canada rate to convert.` : "");
}

/** One row per sale: the dashboard line after "SYMBOL, ", and the price change since. */
export function saleRow(i: SaleRow, f: Fmt = SHOWN): ListRow {
  const kept = i.keptVsSold.cad === null
    ? `${i.keptVsSold.native.amount > 0 && f === SHOWN ? "+" : ""}${f.native(i.keptVsSold.native.amount, i.keptVsSold.native.currency)} (not converted: no Bank of Canada rate)`
    : convertedMoney(f, f.signedCad(i.keptVsSold.cad), { estimated: i.keptVsSold.estimated, rateDate: i.keptVsSold.rateDate, native: i.keptVsSold.native });
  const recorded = i.recordedPrice ? `; ${price(f, i.recordedPrice.amount, i.recordedPrice.currency)} as recorded` : "";
  const salePrice = `${price(f, i.salePrice, i.currency)}${i.estimated ? ` (est., Bank of Canada rate ${i.priceRateDate ?? "date unknown"}${recorded})` : ""}`;
  return {
    symbol: i.symbol, figure: pct(i.changePct),
    detail: `sold ${calendarDate(i.date)} at ${salePrice} (${f.units(i.units)} ${plural(i.units, "share", "shares")}): `
      + `latest close ${price(f, i.latestClose, i.currency)} on ${calendarDate(i.latestCloseDate)}${i.latestCloseSplitAdjusted === undefined ? "" : ` (${price(f, i.latestCloseSplitAdjusted, i.currency)} with the splits since the sale)`}, ${pct(i.changePct)}; kept vs sold ${kept}`,
  };
}
/** The dashboard's line: "SYMBOL, detail". */
export const saleLine = (r: ListRow) => `${r.symbol}, ${r.detail}`;

/* What trading cost you ---------------------------------------------------------------------------------------- */

export function tradingCostHeadline(cost: TradingCostSection, f: Fmt = SHOWN): string {
  const { conversion } = cost;
  return conversion.rows > 0
    ? `You converted about ${f.cad(conversion.convertedCad)} between CAD and USD on trades${convertedNote(f, conversion.estimated, conversion.rateDate, conversion.native)}`
    : conversion.cantTell.count > 0
      ? `${conversion.cantTell.count} ${plural(conversion.cantTell.count, "trade", "trades")} between CAD and USD couldn't be read`
      : "No trades between CAD and USD found";
}

export const storedSinceNote = (activityFrom: string | null) => (activityFrom ? `In your stored activity since ${calendarDate(activityFrom)}.` : null);

export const acrossTradesNote = (cost: TradingCostSection) => cost.conversion.rows > 0
  ? `Across ${cost.conversion.rows} ${plural(cost.conversion.rows, "trade", "trades")} in a security whose currency differs from the account's, from the amounts recorded.`
  : null;

export function estimateLine(cost: TradingCostSection, f: Fmt = SHOWN): string | null {
  const { conversion } = cost;
  const { estimate } = conversion;
  const dates = estimate.rateDates ? `, Bank of Canada rates from ${calendarDate(estimate.rateDates.first)} to ${calendarDate(estimate.rateDates.last)}` : "";
  const noisy = "(est.; compares each trade with that day's closing price, so single trades are noisy)";
  if (estimate.costCad === null) {
    return conversion.rows > 0 ? `Too few trades with a closing price that day to estimate what the conversion cost (${estimate.rows} of the ${estimate.minRows} needed).` : null;
  }
  return `${estimate.costCad >= 0 ? `Estimated cost against the Bank of Canada rate: about ${f.cad(estimate.costCad)}` : `Against the Bank of Canada rate, the conversions came out about ${f.cad(-estimate.costCad)} ahead`} ${noisy}`
    + `${estimate.sharePct === null ? "" : `, ${estimate.sharePct.toFixed(2)}% of the value compared`}, over ${estimate.rows} trades${dates}.`;
}

export function feesLine(cost: TradingCostSection, f: Fmt = SHOWN): string {
  const { fees } = cost;
  const unread = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"} couldn't be read`;
  return fees.rows > 0
    ? `Fees: ${f.cad(fees.totalCad)}${convertedNote(f, fees.estimated, fees.rateDate, fees.native)}`
    : fees.cantTell.count > 0 ? `No fee amounts could be counted: ${unread(fees.cantTell.count, "fee row")}` : "No fees recorded";
}
