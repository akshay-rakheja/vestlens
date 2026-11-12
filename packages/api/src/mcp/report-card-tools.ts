import { BENCHMARKS } from "../analytics/benchmarks.js";
import type { CantTell } from "../report/report-card.js";
import type { ReportCard } from "../report/report-loader.js";
import type { ReportCardRunner } from "../report/report-routes.js";
import { plain, rejected, type ToolResult } from "./portfolio-fact-tools.js";
import { cad, calendarDate } from "./room-tools.js";

/**
 * show_report_card (spec 2026-10-27-report-card-widget-design.md): the dashboard's report card in chat. The same
 * runner as GET /api/report-card (report-routes.ts createReportCardRunner): same inputs, same 30-minute cache, the
 * same counts-only log line (via "mcp"). structuredContent is the ReportCard exactly as the route returns it; the text
 * is one factual line per section. Facts only: no advice, no judgement of the user as an investor.
 */

/** The report card's base address (packages/widgets report-card); the server rebinds it to the served URI. */
export const REPORT_CARD_WIDGET_URI = "ui://portfolio/report-card-v1";

const readSecurity = [{ type: "oauth2" as const, scopes: ["portfolio:read"] }];

export const reportCardToolDefinitions = [
  {
    name: "show_report_card",
    title: "Show investing report card",
    description:
      "Use this when the user asks how their investing has gone, for a report card or a review of their buys and sells, what happened after they sold, what trading and currency conversion cost them, or how their year compares with the S&P 500: each holding against the same money in the S&P 500 since the first purchase, the price since each sale, conversion and fee costs, and this year's return against the S&P 500, from stored activity (CAD; converted figures est.). Read-only; states facts, not advice.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    securitySchemes: readSecurity,
    _meta: {
      securitySchemes: readSecurity,
      ui: { resourceUri: REPORT_CARD_WIDGET_URI },
      "openai/outputTemplate": REPORT_CARD_WIDGET_URI,
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Working out the report card…",
      "openai/toolInvocation/invoked": "Report card ready.",
    },
  },
] as const;

export const REPORT_CARD_TOOL_NAMES: readonly string[] = reportCardToolDefinitions.map((t) => t.name);

export const REPORT_CARD_UNAVAILABLE_TEXT = "The report card is unavailable right now. Try again in a minute.";

const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "-" : "");
const pct = (n: number) => `${sign(n)}${Math.abs(n).toFixed(1)}%`;
const signedCad = (n: number) => `${n > 0 ? "+" : ""}${cad(n)}`;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const estLabel = (estimated: boolean, rateDate: string | null = null) => (!estimated ? "" : rateDate ? ` (est., Bank of Canada rate ${rateDate})` : " (est.)");
const nativeMoney = (amount: number, currency: string) => {
  const digits = Math.abs(amount).toLocaleString("en-CA", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 });
  return `${amount < 0 ? "-" : ""}${currency === "USD" ? "US$" : `${currency} `}${digits}`;
};
/** " (est., Bank of Canada rate D; includes US$X)" for a converted total, as on the dashboard (packages/web ReportCard.tsx). */
const convertedNote = (estimated: boolean, rateDate: string | null, native: Array<{ currency: string; amount: number }>) => {
  const label = estLabel(estimated, rateDate);
  return label && native.length > 0 ? `${label.slice(0, -1)}; includes ${native.map((n) => nativeMoney(n.amount, n.currency)).join(" and ")})` : label;
};
const cantTell = (c: CantTell, what = "couldn't tell for") => (c.count > 0 ? `; ${what} ${c.count}` : "");

function overallLine(o: ReportCard["overall"]): string {
  if (!o) return "Overall: this year's portfolio return against the S&P 500 isn't available.";
  return `Overall: from ${calendarDate(o.from)} to ${calendarDate(o.to)}, your portfolio ${pct(o.returnPct)}${estLabel(o.returnEstimated)} `
    + `against the S&P 500's ${pct(o.sp500Pct)}${estLabel(o.sp500Estimated)} (time-weighted; ${BENCHMARKS.sp500.basis}).`
    + (o.sinceStart ? ` Per year since ${calendarDate(o.sinceStart.from)} (${o.sinceStart.years.toFixed(1)} years): your portfolio ${pct(o.sinceStart.cagrPct)} a year `
      + `against the S&P 500's ${pct(o.sinceStart.sp500CagrPct)} a year (est., time-weighted, deposits excluded).` : "");
}

function callsLine(calls: ReportCard["calls"]): string {
  const { summary } = calls;
  const head = summary.compared === 0
    ? "none of your holdings could be compared with the S&P 500 yet"
    : `${summary.ahead} of ${summary.compared} ${plural(summary.compared, "holding", "holdings")} came out ahead of the S&P 500 (${BENCHMARKS.sp500.basis}) since your first purchase `
      + `(${summary.ahead} ahead, ${summary.behind} behind${summary.even > 0 ? `, ${summary.even} level` : ""})`;
  return `Your calls against the market: ${head}${cantTell(calls.cantTell)}.`;
}

function afterSoldLine(afterSold: ReportCard["afterSold"]): string {
  const { summary } = afterSold;
  const head = summary.sells === 0
    ? "no sales could be compared with the latest price yet"
    : `since you sold, the price rose after ${summary.rose} of ${summary.sells} ${plural(summary.sells, "sale", "sales")}`;
  const kept = summary.keptVsSoldCad === null ? ""
    : `; kept vs sold, all sales together: ${signedCad(summary.keptVsSoldCad)}${convertedNote(summary.estimated, summary.rateDate, summary.native)}`;
  return `After you sold: ${head}${kept}${cantTell(afterSold.cantTell)}.`;
}

function tradingCostLine(cost: ReportCard["tradingCost"]): string {
  const { conversion, fees } = cost;
  const { estimate } = conversion;
  const head = conversion.rows > 0
    ? `you converted about ${cad(conversion.convertedCad)} between CAD and USD on ${conversion.rows} ${plural(conversion.rows, "trade", "trades")}`
      + convertedNote(conversion.estimated, conversion.rateDate, conversion.native)
    : conversion.cantTell.count > 0 ? "no trades between CAD and USD could be read" : "no trades between CAD and USD found";
  const est = estimate.costCad === null
    ? conversion.rows > 0 ? `; too few trades to estimate the conversion cost (${estimate.rows} of the ${estimate.minRows} needed)` : ""
    : estimate.costCad >= 0
      ? `; estimated conversion cost against the Bank of Canada rate about ${cad(estimate.costCad)} (est.) over ${estimate.rows} trades`
      : `; against the Bank of Canada rate, the conversions came out about ${cad(-estimate.costCad)} ahead (est.) over ${estimate.rows} trades`;
  const fee = fees.rows > 0 ? `; fees ${cad(fees.totalCad)}${convertedNote(fees.estimated, fees.rateDate, fees.native)}`
    : fees.cantTell.count > 0 ? "; no fee amounts could be counted" : "; no fees recorded";
  const unread = conversion.cantTell.count + fees.cantTell.count;
  return `What trading cost you: ${head}${est}${fee}${unread > 0 ? `; couldn't tell for ${unread}` : ""}${cantTell(estimate.cantTell, "left out of the cost estimate:")}.`;
}

/** The model-facing summary: the as-of date, then one factual line per section in the widget's order. */
export function reportCardText(card: ReportCard): string {
  const since = card.activityFrom ? `, from stored activity since ${calendarDate(card.activityFrom)}` : ", from stored activity (none recorded yet)";
  return [
    `Investing report card as of ${calendarDate(card.asOf)}${since}. Facts only, not advice; the card shows the details.`,
    overallLine(card.overall),
    callsLine(card.calls),
    afterSoldLine(card.afterSold),
    tradingCostLine(card.tradingCost),
  ].join("\n");
}

export async function buildShowReportCard(runner: ReportCardRunner, subject: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (Object.keys(args).length > 0) return rejected("show_report_card takes no arguments.");
  let card: ReportCard;
  try {
    card = await runner.load(subject, "mcp");
  } catch {
    return rejected(REPORT_CARD_UNAVAILABLE_TEXT);
  }
  return plain(reportCardText(card), card as unknown as Record<string, unknown>);
}
