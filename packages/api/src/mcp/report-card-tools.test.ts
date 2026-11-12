import { describe, expect, it, vi } from "vitest";

import type { ReportCard } from "../report/report-loader.js";
import { connectFacts, FACT_SUBJECT, firstText, texts } from "../testing/fact-tools-harness.js";
import { ADVICE } from "../testing/copy-rules.js";
import { REPORT_CARD_UNAVAILABLE_TEXT, REPORT_CARD_WIDGET_URI, reportCardText } from "./report-card-tools.js";

// Synthetic symbols, dates, prices and amounts only (the shape of the dashboard test's card).
const none = { count: 0, reasons: [] };
const call = (symbol: string, vs: number, over: Record<string, unknown> = {}) => ({
  symbol, returnPct: vs + 5, vsSp500Pct: vs, vsTsxPct: vs + 1, startDate: "2025-01-02", endDate: "2026-10-22", estimated: false, rateDate: null as string | null, ...over,
});
const card = (over: Partial<ReportCard> = {}): ReportCard => ({
  asOf: "2026-10-23",
  activityFrom: "2025-01-02",
  calls: {
    checked: 5,
    items: [call("AAA", 12.5), call("BBB", -15)],
    summary: { compared: 4, ahead: 3, behind: 1, even: 0, best: call("AAA", 12.5), worst: call("BBB", -15), aheadUnmeasured: [] },
    cantTell: { count: 1, reasons: [{ reason: "no price history for this symbol", count: 1, symbols: ["DDD"] }] },
  },
  afterSold: {
    items: [],
    summary: { sells: 2, rose: 1, fell: 1, unchanged: 0, keptVsSoldCad: 115, estimated: true, rateDate: "2026-10-22", notConverted: 0, native: [{ currency: "USD", amount: 100 }] },
    cantTell: none,
  },
  tradingCost: {
    conversion: {
      rows: 25, convertedCad: 27000, estimated: false, rateDate: null, native: [], cantTell: { count: 1, reasons: [{ reason: "the trade's amount or date wasn't recorded", count: 1, symbols: ["NOA"] }] },
      estimate: { rows: 20, minRows: 20, costCad: 300, sharePct: 1.1111, estimated: true, rateDates: { first: "2025-01-02", last: "2026-01-05" }, cantTell: { count: 2, reasons: [{ reason: "no closing price within 3 days of the trade", count: 2, symbols: ["GAP"] }] } },
    },
    fees: { rows: 3, totalCad: 8.7, estimated: true, rateDate: "2026-03-02", native: [{ currency: "USD", amount: 2 }], cantTell: none },
  },
  overall: { period: "YTD", from: "2026-01-01", to: "2026-10-22", returnPct: 8.4, sp500Pct: 12.1, returnEstimated: false, sp500Estimated: true },
  ...over,
});
const empty = (): ReportCard => card({
  activityFrom: null, overall: null,
  calls: { checked: 0, items: [], summary: { compared: 0, ahead: 0, behind: 0, even: 0, best: null, worst: null, aheadUnmeasured: [] }, cantTell: none },
  afterSold: { items: [], summary: { sells: 0, rose: 0, fell: 0, unchanged: 0, keptVsSoldCad: null, estimated: false, rateDate: null, notConverted: 0, native: [] }, cantTell: none },
  tradingCost: {
    conversion: { rows: 0, convertedCad: 0, estimated: false, rateDate: null, native: [], cantTell: none, estimate: { rows: 0, minRows: 20, costCad: null, sharePct: null, estimated: true, rateDates: null, cantTell: none } },
    fees: { rows: 0, totalCad: 0, estimated: false, rateDate: null, native: [], cantTell: none },
  },
});

describe("reportCardText", () => {
  it("one factual line per section, after the as-of date, in the widget's order", () => {
    expect(reportCardText(card()).split("\n")).toEqual([
      "Investing report card as of 23 October 2026, from stored activity since 2 January 2025. Facts only, not advice; the card shows the details.",
      "Overall: from 1 January 2026 to 22 October 2026, your portfolio +8.4% against the S&P 500's +12.1% (est.) (time-weighted; total return, dividends reinvested).",
      "Your calls against the market: 3 of 4 holdings came out ahead of the S&P 500 (total return, dividends reinvested) since your first purchase (3 ahead, 1 behind); couldn't tell for 1.",
      "After you sold: since you sold, the price rose after 1 of 2 sales; kept vs sold, all sales together: +$115 (est., Bank of Canada rate 2026-10-22; includes US$100).",
      "What trading cost you: you converted about $27,000 between CAD and USD on 25 trades; estimated conversion cost against the Bank of Canada rate about $300 (est.) over 20 trades; fees $8.70 (est., Bank of Canada rate 2026-03-02; includes US$2); couldn't tell for 1; left out of the cost estimate: 2.",
    ]);
  });

  it("adds the yearly rate since the history began when there is one", () => {
    const overall = { ...card().overall!, sinceStart: { from: "2023-01-02", to: "2026-10-22", years: 3.8, cagrPct: 11.23, sp500CagrPct: 9.31, estimated: true } };
    expect(reportCardText(card({ overall })).split("\n")[1]).toBe("Overall: from 1 January 2026 to 22 October 2026, your portfolio +8.4% against the S&P 500's +12.1% (est.) (time-weighted; total return, dividends reinvested). "
      + "Per year since 2 January 2023 (3.8 years): your portfolio +11.2% a year against the S&P 500's +9.3% a year (est., time-weighted, deposits excluded).");
  });

  it("says plainly when a section has nothing to show", () => {
    expect(reportCardText(empty()).split("\n")).toEqual([
      "Investing report card as of 23 October 2026, from stored activity (none recorded yet). Facts only, not advice; the card shows the details.",
      "Overall: this year's portfolio return against the S&P 500 isn't available.",
      "Your calls against the market: none of your holdings could be compared with the S&P 500 yet.",
      "After you sold: no sales could be compared with the latest price yet.",
      "What trading cost you: no trades between CAD and USD found; no fees recorded.",
    ]);
  });

  it("a conversion that came out ahead, too few trades to estimate, and unread trades and fees", () => {
    const base = card();
    const ahead = { ...base.tradingCost, conversion: { ...base.tradingCost.conversion, estimate: { ...base.tradingCost.conversion.estimate, costCad: -40, cantTell: none } } };
    expect(reportCardText(card({ tradingCost: ahead }))).toContain("against the Bank of Canada rate, the conversions came out about $40 ahead (est.) over 20 trades");
    const few = { ...base.tradingCost, conversion: { ...base.tradingCost.conversion, estimate: { ...base.tradingCost.conversion.estimate, rows: 7, costCad: null, sharePct: null, cantTell: none } } };
    expect(reportCardText(card({ tradingCost: few }))).toContain("too few trades to estimate the conversion cost (7 of the 20 needed)");
    const unread = { count: 2, reasons: [{ reason: "the fee amount wasn't recorded", count: 2, symbols: [] }] };
    const e = empty();
    const text = reportCardText({ ...e, tradingCost: { conversion: { ...e.tradingCost.conversion, cantTell: unread }, fees: { ...e.tradingCost.fees, cantTell: unread } } });
    expect(text).toContain("What trading cost you: no trades between CAD and USD could be read; no fee amounts could be counted; couldn't tell for 4.");
  });

  it("states facts only, and never names the reasons' symbols or text", () => {
    for (const c of [card(), empty()]) {
      const text = reportCardText(c);
      expect(text).not.toMatch(ADVICE);
      for (const s of ["DDD", "NOA", "GAP", "AAA", "BBB", "price history"]) expect(text).not.toContain(s);
    }
  });
});

const widgetHtml = (name: string) => `<!doctype html><title>${name}</title>`;

describe("show_report_card through the MCP server", () => {
  const runner = (c: ReportCard | Error = card()) => ({ load: vi.fn(async () => { if (c instanceof Error) throw c; return c; }) });

  it("returns the runner's ReportCard as structuredContent, asked for via mcp, with the summary and the model copy", async () => {
    const r = runner();
    const { client } = await connectFacts({ reportCard: r });
    const result = await client.callTool({ name: "show_report_card", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(card());
    expect(r.load).toHaveBeenCalledWith(FACT_SUBJECT, "mcp");
    expect(firstText(result)).toBe(reportCardText(card()));
    expect(JSON.parse(texts(result)[1]!)).toEqual(card());
  });

  it("is strict about arguments and reads nothing then", async () => {
    const r = runner();
    const { client } = await connectFacts({ reportCard: r });
    const result = await client.callTool({ name: "show_report_card", arguments: { symbol: "AAA" } });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe("show_report_card takes no arguments.");
    expect(r.load).not.toHaveBeenCalled();
  });

  it("a failed report is a fixed line", async () => {
    const { client } = await connectFacts({ reportCard: runner(new Error("synthetic subject|secret")) });
    const result = await client.callTool({ name: "show_report_card", arguments: {} });
    expect(result.isError).toBe(true);
    expect(texts(result)).toEqual([REPORT_CARD_UNAVAILABLE_TEXT]);
  });

  it("is listed last on the focused surface, not parked, and points at the served report card widget", async () => {
    const { client } = await connectFacts({ reportCard: runner(), widgets: true, html: widgetHtml, surface: "focused" });
    const tools = (await client.listTools()).tools;
    expect(tools.at(-1)!.name).toBe("show_report_card");
    const meta = tools.at(-1)!._meta as Record<string, any>;
    expect(meta.ui.resourceUri).toMatch(/^ui:\/\/portfolio\/report-card-[0-9a-f]{10}$/);
    expect(meta["openai/outputTemplate"]).toBe(meta.ui.resourceUri);
    const resources = (await client.listResources()).resources;
    const resource = resources.find((x) => x.name === "report-card")!;
    expect(resource.uri).toBe(meta.ui.resourceUri);
    expect(resource.title).toBe("Investing report card");
    const read = await client.readResource({ uri: resource.uri });
    expect((read.contents[0] as { text: string }).text).toBe(widgetHtml("report-card"));
    // The fixed legacy address stays readable.
    expect((await client.readResource({ uri: REPORT_CARD_WIDGET_URI })).contents).toHaveLength(1);
  });

  it("without the widget build the tool is still listed, with no widget reference", async () => {
    const { client } = await connectFacts({ reportCard: runner(), widgets: true, html: (name) => (name === "report-card" ? null : widgetHtml(name)) });
    const tool = (await client.listTools()).tools.find((t) => t.name === "show_report_card")!;
    expect(tool._meta).toEqual({ securitySchemes: [{ type: "oauth2", scopes: ["portfolio:read"] }] });
    expect((await client.listResources()).resources.map((x) => x.name)).not.toContain("report-card");
  });

  it("is not listed without the runner", async () => {
    const without = await connectFacts({ widgets: true, html: widgetHtml });
    expect((await without.client.listTools()).tools.map((t) => t.name)).not.toContain("show_report_card");
    expect((await without.client.listResources()).resources.map((x) => x.name)).not.toContain("report-card");
  });
});
