import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { miniSyntheticAccount } from "../testing/mini-synthetic-fixtures.js";
import { DEFAULT_SETTINGS } from "../settings/settings-service.js";
import { createPortfolioMcpServer, modelPortfolio } from "./portfolio-mcp-server.js";
import { buildPortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import { DATA_FRESHNESS_TEXT, HISTORY_BUILDING_TEXT, buildIntraday, buildOverviewPayload, overviewExtraToolDefinitions, overviewModelCopy, overviewText } from "./overview-tools.js";
import { widgetUri } from "./widget-assets.js";

const SUBJECT = "subject|synthetic-overview";
function deps() {
  return {
    market: {
      quotes: vi.fn(async (_t: string[]): Promise<Map<string, any>> => new Map([["SYNTHETIC0", { ticker: "SYNTHETIC0", currency: "CAD", price: 7, previousClose: 6, asOf: "2026-10-15T15:00:00Z" }]])),
      history: vi.fn(async (_t: string, _f: string, _to: string): Promise<any> => [{ date: "2026-01-02", close: 100 }, { date: "2026-06-01", close: 105 }, { date: "2026-10-14", close: 110 }]),
      usdCad: vi.fn(async (_f: string, _t: string): Promise<any> => [{ date: "2026-01-02", close: 1.4 }]),
    },
    settings: { get: vi.fn(async (_s: string): Promise<any> => ({ ...DEFAULT_SETTINGS })), save: vi.fn(async (_s: string, u: any) => ({ ...DEFAULT_SETTINGS, ...u })) },
    dailyValues: { rows: vi.fn(async (_s: string, _f: string): Promise<any[]> => [{ date: "2026-06-01", accountId: "MINI-SYNTHETIC-ACCOUNT-0", currency: "CAD", value: 140, source: "reported" as const }]), earliest: vi.fn(async (_s: string, _c: string): Promise<string | null> => "2026-06-01") },
    now: () => new Date("2026-10-15T15:00:00Z"),
    marketDeadlineMs: undefined as number | undefined,
  };
}
async function connect(overview = deps(), html: string | null = "<!doctype html><title>overview</title>", accounts = [miniSyntheticAccount(0)]) {
  const portfolio = { getPortfolio: vi.fn(async () => ({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts })) };
  const server = createPortfolioMcpServer({ authSubject: SUBJECT, portfolio, history: { getAccountHistory: vi.fn() }, overview, assets: { html: () => html } } as any);
  const client = new Client({ name: "synthetic-claude", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, overview, portfolio };
}

describe("overview tools", () => {
  it("binds show_portfolio to the content-hashed overview URI and hides the series tool from the model", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const uri = widgetUri("overview", "<!doctype html><title>overview</title>");
    expect(uri).toMatch(/^ui:\/\/portfolio\/overview-[0-9a-f]{10}$/);
    expect(tools.find((t) => t.name === "show_portfolio")?._meta).toMatchObject({ ui: { resourceUri: uri }, "openai/outputTemplate": uri });
    expect(tools.find((t) => t.name === "get_overview_series")?._meta).toMatchObject({ ui: { visibility: ["app"] } });
    expect(tools.find((t) => t.name === "save_portfolio_settings")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    // Only the widgets read or save display settings; hiding them keeps hosts from treating the save as a model write action.
    for (const name of ["get_portfolio_settings", "save_portfolio_settings"]) expect(tools.find((t) => t.name === name)?._meta).toMatchObject({ ui: { visibility: ["app"] } });
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(uri);
    expect(resources.map((r) => r.uri)).not.toContain("ui://portfolio/overview-v5");
    const read = await client.readResource({ uri });
    expect((read.contents[0] as any).text).toContain("<title>overview</title>");
    expect(read.contents[0].uri).toBe(uri);
    // The old fixed URI still reads, serving the current HTML, so old conversations keep working.
    const alias = await client.readResource({ uri: "ui://portfolio/overview-v5" });
    expect((alias.contents[0] as any).text).toContain("<title>overview</title>");
    expect((read.contents[0] as any)._meta.ui).toMatchObject({ prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } });
  });
  it("returns the overview payload with summary, series and the default S&P 500 benchmark", async () => {
    const { client, overview } = await connect();
    const result = await client.callTool({ name: "show_portfolio", arguments: {} });
    const payload = result.structuredContent as any;
    expect(payload.summary.primaryCurrency).toBe("CAD");
    expect(payload.series).toMatchObject({ period: "YTD", currency: "CAD", benchmark: { key: "sp500" } });
    expect(payload.series.points.at(-1)).toMatchObject({ date: "2026-10-15", source: "reported" });
    expect(payload.benchmarks.map((b: any) => b.key)).toEqual(["sp500", "nasdaq100", "dow", "tsx", "xeqt"]);
    expect(overview.market.history).toHaveBeenCalledWith("^SP500TR", "2025-12-22", "2026-10-15");
    expect((result.content as any[])[0].text).toMatch(/S&P 500/);
    expect(JSON.parse((result.content as any[])[1].text).series.period).toBe("YTD");
  });
  it("show_portfolio (overview) names position fields for the model (review M5)", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "show_portfolio", arguments: {} });
    const position = (result.structuredContent as any).portfolio.accounts[0].positions[0];
    expect(position).toMatchObject({ calculatedMarketValue: 14, costBasisPerUnit: null, calculatedUnrealizedGain: null });
    expect(position).not.toHaveProperty("marketValue");
    // The model copy no longer carries positions at all (holdings questions go to show_holdings).
    expect(JSON.parse((result.content as any[])[1].text).accounts[0]).not.toHaveProperty("positions");
  });
  it("serves the series tool for another period and benchmark", async () => {
    const { client, overview } = await connect();
    const result = await client.callTool({ name: "get_overview_series", arguments: { period: "1M", benchmark: "tsx" } });
    expect(result.structuredContent).toMatchObject({ period: "1M", benchmark: { key: "tsx" } });
    expect(overview.market.history).toHaveBeenCalledWith("^GSPTSE", "2026-09-05", "2026-10-15");
  });
  it("saves settings for the authenticated subject only and rejects bad input", async () => {
    const { client, overview } = await connect();
    await client.callTool({ name: "save_portfolio_settings", arguments: { benchmark: "xeqt" } });
    expect(overview.settings.save).toHaveBeenCalledWith(SUBJECT, { benchmark: "xeqt" });
    await expect(client.callTool({ name: "save_portfolio_settings", arguments: { benchmark: "ftse" } })).rejects.toThrow();
  });
  it("still renders totals when market data is unavailable", async () => {
    const offline = deps();
    offline.market.quotes = vi.fn(async () => new Map());
    offline.market.history = vi.fn(async () => null as any);
    const { client } = await connect(offline);
    const payload = (await client.callTool({ name: "show_portfolio", arguments: {} })).structuredContent as any;
    expect(payload.summary.totals.length).toBeGreaterThan(0);
    expect(payload.series.benchmark).toMatchObject({ points: null, unavailableReason: "Benchmark data unavailable" });
    expect(payload.summary.dayChange[0]).toMatchObject({ coverage: 0, fraction: null });
  });
  it("honours refresh on show_portfolio", async () => {
    const { client, portfolio } = await connect();
    await client.callTool({ name: "show_portfolio", arguments: { refresh: true } });
    expect(portfolio.getPortfolio).toHaveBeenCalledWith(SUBJECT, { refresh: true });
  });
  it("falls back to the legacy dashboard when widget assets are missing", async () => {
    const { client } = await connect(deps(), null);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "show_portfolio")?._meta).toMatchObject({ ui: { resourceUri: "ui://portfolio/dashboard-v4" } });
    expect(tools.some((t) => t.name === "save_portfolio_settings")).toBe(false);
  });

  it("compares the portfolio and the benchmark over the same span and says 'since' when it starts late", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "show_portfolio", arguments: {} });
    const series = (result.structuredContent as any).series;
    // Portfolio: first stored snapshot 2026-06-01 (140) to today (156, brokerage reported).
    expect(series).toMatchObject({ period: "YTD", spanStart: "2026-06-01", spanIsPartial: true });
    expect(series.portfolioReturn).toBeCloseTo(156 / 140 - 1, 10);
    // Benchmark clipped to 2026-06-01..today and rebased there.
    expect(series.benchmark.points.map((p: any) => p.date)).toEqual(["2026-06-01", "2026-10-14"]);
    expect(series.benchmark.points[0].returnFraction).toBe(0);
    expect(series.benchmarkReturn).toBeCloseTo(110 / 105 - 1, 10);
    const text = (result.content as any[])[0].text as string;
    expect(text).toContain("Value change since Jun 1: +11.4% (investment accounts, includes deposits). A comparison with S&P 500 needs deposit history.");
    expect(text).not.toMatch(/return/i);
  });
  it("labels a full-period span with the period and no 'since'", async () => {
    const full = deps();
    full.dailyValues.rows = vi.fn(async () => [{ date: "2026-01-01", accountId: "MINI-SYNTHETIC-ACCOUNT-0", currency: "CAD", value: 120, source: "reported" as const }]);
    const { client } = await connect(full);
    const result = await client.callTool({ name: "show_portfolio", arguments: {} });
    const series = (result.structuredContent as any).series;
    expect(series).toMatchObject({ spanStart: "2026-01-01", spanIsPartial: false });
    expect(series.benchmark.points.map((p: any) => p.date)).toEqual(["2026-01-02", "2026-06-01", "2026-10-14"]);
    expect(series.benchmarkReturn).toBeCloseTo(0.1, 10);
    expect((result.content as any[])[0].text).toContain("YTD value change +30.0% (investment accounts, includes deposits).");
  });
  it("F1: fetches the index from ten days before the period start and rebases on the last close on or before the span start", async () => {
    const holiday = deps();
    holiday.dailyValues.rows = vi.fn(async () => [{ date: "2026-01-01", accountId: "MINI-SYNTHETIC-ACCOUNT-0", currency: "CAD", value: 120, source: "reported" as const }]);
    holiday.market.history = vi.fn(async () => [{ date: "2025-12-31", close: 100 }, { date: "2026-01-02", close: 102 }, { date: "2026-10-14", close: 102 }]);
    holiday.market.usdCad = vi.fn(async () => [{ date: "2025-12-31", close: 1.4 }]);
    const { client } = await connect(holiday);
    const series = ((await client.callTool({ name: "show_portfolio", arguments: {} })).structuredContent as any).series;
    expect(holiday.market.history).toHaveBeenCalledWith(expect.any(String), "2025-12-22", "2026-10-15");
    expect(series.benchmark.points[0]).toEqual({ date: "2026-01-01", returnFraction: 0 });
    expect(series.benchmarkReturn).toBeCloseTo(0.02, 10);
  });
  it("reports no span and no comparison on day one", async () => {
    const empty = deps();
    empty.dailyValues.rows = vi.fn(async () => []);
    const { client } = await connect(empty);
    const series = ((await client.callTool({ name: "show_portfolio", arguments: {} })).structuredContent as any).series;
    expect(series).toMatchObject({ spanStart: null, spanIsPartial: false, portfolioReturn: null, benchmarkReturn: null });
  });
  it("marks the benchmark unavailable when fewer than two points overlap the span", async () => {
    const late = deps();
    late.dailyValues.rows = vi.fn(async () => [{ date: "2026-10-14", accountId: "MINI-SYNTHETIC-ACCOUNT-0", currency: "CAD", value: 150, source: "reported" as const }]);
    late.market.history = vi.fn(async () => [{ date: "2026-01-02", close: 100 }, { date: "2026-10-13", close: 110 }]);
    const { client } = await connect(late);
    const series = ((await client.callTool({ name: "show_portfolio", arguments: {} })).structuredContent as any).series;
    expect(series.benchmark).toMatchObject({ points: null, unavailableReason: "Benchmark data unavailable" });
    expect(series.benchmarkReturn).toBeNull();
  });
  it("never claims CAD terms or an index comparison for a USD value change", async () => {
    const usd = deps();
    usd.dailyValues.rows = vi.fn(async () => [{ date: "2026-06-01", accountId: "MINI-SYNTHETIC-ACCOUNT-0", currency: "USD", value: 140, source: "reported" as const }]);
    // The per-currency view: the CAD view turns this series into CAD (tested in "overview charts in CAD").
    usd.settings.get = vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView: false }));
    const { client } = await connect(usd, undefined, [miniSyntheticAccount(0, { currency: "USD" })]);
    const result = await client.callTool({ name: "show_portfolio", arguments: {} });
    const series = (result.structuredContent as any).series;
    expect(series.currency).toBe("USD");
    const text = (result.content as any[])[0].text as string;
    expect(text).not.toContain("CAD terms");
    expect(text).toContain("needs deposit history");
    expect(series.fxNote).not.toMatch(/CAD portfolio/);
    expect(series.fxNote).toMatch(/USD/);
  });
  it("returns brokerage totals within the market-data deadline when market sources hang", async () => {
    const hung = deps();
    hung.marketDeadlineMs = 20;
    hung.market.quotes = vi.fn(() => new Promise<Map<string, any>>(() => {}));
    hung.market.history = vi.fn(() => new Promise<any>(() => {}));
    const { client } = await connect(hung);
    const started = Date.now();
    const result = await client.callTool({ name: "show_portfolio", arguments: {} });
    expect(Date.now() - started).toBeLessThan(2_000);
    const payload = result.structuredContent as any;
    expect(payload.summary.totals).toEqual([{ currency: "CAD", amount: 156 }]);
    expect(payload.summary.dayChange[0]).toMatchObject({ coverage: 0, fraction: null });
    expect(payload.series.benchmark).toMatchObject({ points: null, unavailableReason: "Benchmark data unavailable" });
    const series = await client.callTool({ name: "get_overview_series", arguments: { period: "1M" } });
    expect((series.structuredContent as any).benchmark.unavailableReason).toBe("Benchmark data unavailable");
  });
  it("loads the series without quotes and keeps today's value from brokerage totals", async () => {
    const { client, overview } = await connect();
    const result = await client.callTool({ name: "get_overview_series", arguments: { period: "YTD" } });
    expect(overview.market.quotes).not.toHaveBeenCalled();
    expect((result.structuredContent as any).points.at(-1)).toEqual({ date: "2026-10-15", value: 156, source: "reported" });
  });
  it("falls back to default settings when the settings store fails", async () => {
    const broken = deps();
    broken.settings.get = vi.fn(async () => { throw new Error("synthetic settings outage"); });
    const { client, overview } = await connect(broken);
    const shown = await client.callTool({ name: "show_portfolio", arguments: {} });
    expect(shown.isError).toBeFalsy();
    expect((shown.structuredContent as any).settings).toEqual(DEFAULT_SETTINGS);
    expect((shown.structuredContent as any).series.benchmark.key).toBe("sp500");
    const series = await client.callTool({ name: "get_overview_series", arguments: { period: "1M" } });
    expect(series.isError).toBeFalsy();
    expect((series.structuredContent as any).benchmark.key).toBe("sp500");
    expect(overview.market.history).toHaveBeenCalledWith("^SP500TR", "2026-09-05", "2026-10-15");
  });
  it("says history is still being read while a counted account's first read hasn't finished", async () => {
    const present = (accounts: any[]) => buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts } as any);
    const withState = (state: { backfillCompletedAt: Date | null } | null) => ({
      ...deps(),
      activities: {
        userId: vi.fn(async () => "app-user"),
        syncState: vi.fn(async () => state ? { ...state, lastSyncedAt: null, lastError: null, dirty: false } : null),
        listActivities: vi.fn(async () => []),
        qualities: vi.fn(async () => []),
      },
    });
    const building = await buildOverviewPayload(withState(null) as any, present([miniSyntheticAccount(0)]), SUBJECT, {});
    expect(building.history.building).toBe(true);
    expect(overviewText(building)).toContain(HISTORY_BUILDING_TEXT);
    expect(overviewText(building)).not.toContain("needs deposit history");
    const done = await buildOverviewPayload(withState({ backfillCompletedAt: new Date("2026-10-15T00:00:00Z") }) as any, present([miniSyntheticAccount(0)]), SUBJECT, {});
    expect(done.history.building).toBe(false);
    expect(overviewText(done)).not.toContain(HISTORY_BUILDING_TEXT);
    expect(overviewText(done)).toContain(DATA_FRESHNESS_TEXT);
    // Without an activity store there is nothing to wait for.
    expect((await buildOverviewPayload(deps() as any, present([miniSyntheticAccount(0)]), SUBJECT, {})).history.building).toBe(false);
  });
  it("leaves Cash out of the value line and the return: today's point is the investment accounts, never the total", async () => {
    const present = (accounts: any[]) => buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts } as any);
    const d = deps();
    d.dailyValues.rows = vi.fn(async () => [
      { date: "2026-10-14", accountId: "MINI-SYNTHETIC-ACCOUNT-0", currency: "CAD", value: 150, source: "reported" as const },
      { date: "2026-10-14", accountId: "MINI-SYNTHETIC-ACCOUNT-1", currency: "CAD", value: 290, source: "reported" as const },
    ]);
    const pf = present([miniSyntheticAccount(0), miniSyntheticAccount(1)]);
    // Account 1 is Wealthsimple Cash: in the total, not in returns.
    pf.accounts[1] = { ...pf.accounts[1], classification: { ...pf.accounts[1].classification, bucket: "money_market", bucketLabel: "Cash / money market", label: "Cash / money market" } };
    const payload = await buildOverviewPayload(d as any, pf, SUBJECT, {});
    const values = payload.series.points.map((p) => p.value);
    // Account 0 alone (156 reported today, 150 stored yesterday): no jump the size of the Cash balance.
    expect(values).toEqual([150, 156]);
  });
  it("ALL starts at the earliest stored row and the payload carries history", async () => {
    const all = deps();
    all.dailyValues.rows = vi.fn(async () => [
      { date: "2024-03-04", accountId: "MINI-SYNTHETIC-ACCOUNT-0", currency: "CAD", value: 90, source: "reconstructed" as const },
      { date: "2026-06-01", accountId: "MINI-SYNTHETIC-ACCOUNT-0", currency: "CAD", value: 140, source: "reported" as const },
    ]);
    all.dailyValues.earliest = vi.fn(async () => "2024-03-04");
    (all as any).history = { qualities: vi.fn(async () => [{ accountId: "A", method: "reconstructed", reason: null, driftFraction: 0.01, computedAt: "2026-10-15T00:00:00Z" }]) };
    const { client } = await connect(all);
    const out = (await client.callTool({ name: "show_portfolio", arguments: { period: "ALL" } })).structuredContent as any;
    expect(out.series.points[0]).toEqual({ date: "2024-03-04", value: 90, source: "reconstructed" });
    expect(out.series.spanIsPartial).toBe(false);
    expect(out.history).toEqual({ qualities: [{ accountId: "A", method: "reconstructed", reason: null, driftFraction: 0.01 }], earliest: "2024-03-04", building: false });
    expect(all.market.history).toHaveBeenCalledWith(expect.any(String), "2024-02-23", "2026-10-15");
    expect(all.dailyValues.rows).toHaveBeenCalledWith(SUBJECT, "2024-03-04");
    expect(all.dailyValues.earliest).toHaveBeenCalledWith(SUBJECT, "CAD");
  });
  it("does not scan full history for a bounded period and survives earliest failing", async () => {
    const d = deps();
    d.dailyValues.earliest = vi.fn(async () => { throw new Error("x"); });
    const { client } = await connect(d);
    const out = (await client.callTool({ name: "show_portfolio", arguments: { period: "1M" } })).structuredContent as any;
    expect(d.dailyValues.rows).toHaveBeenCalledWith(SUBJECT, "2026-09-15");
    expect(out.history.earliest).toBeNull();
  });
  it("never fails the overview when history is absent or throws", async () => {
    const { client } = await connect();
    expect(((await client.callTool({ name: "show_portfolio", arguments: {} })).structuredContent as any).history).toEqual({ qualities: [], earliest: "2026-06-01", building: false });
    const broken = deps();
    (broken as any).history = { qualities: vi.fn(async () => { throw new Error("x"); }) };
    const out = (await (await connect(broken)).client.callTool({ name: "show_portfolio", arguments: {} })).structuredContent as any;
    expect(out.history.qualities).toEqual([]);
  });
});

describe("get_intraday", () => {
  const T1 = "2026-10-15T14:30:00.000Z", T2 = "2026-10-15T14:35:00.000Z";
  const present = (accounts = [miniSyntheticAccount(0)]) => buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts } as any);
  const withIntraday = (impl: (t: string, i: "5m" | "1h") => Promise<any>) => {
    const d = deps();
    d.dailyValues.rows = vi.fn(async () => [{ date: "2026-10-14", accountId: "MINI-SYNTHETIC-ACCOUNT-0", currency: "CAD", value: 140, source: "reported" as const }]);
    const intraday = vi.fn(impl);
    return { d: { ...d, market: { ...d.market, intraday } } as any, intraday };
  };
  it("is an app-only, read-only tool with a strict output schema", () => {
    const def = overviewExtraToolDefinitions.find((t) => t.name === "get_intraday") as any;
    expect(def._meta.ui).toEqual({ visibility: ["app"] });
    expect(def.annotations.readOnlyHint).toBe(true);
    expect(def.securitySchemes).toEqual([{ type: "oauth2", scopes: ["portfolio:read"] }]);
    expect(def.outputSchema.additionalProperties).toBe(false);
  });
  it("values today's line from live bars with cash and the stored previous close", async () => {
    const { d, intraday } = withIntraday(async () => ({ points: [{ t: T1, price: 7 }, { t: T2, price: 8 }], sessionDate: "2026-10-15" }));
    const r = await buildIntraday(d, present(), SUBJECT);
    // 2 units + 3 cash
    expect(r.points).toEqual([{ t: T1, value: 17 }, { t: T2, value: 19 }]);
    expect(r).toMatchObject({ drawn: true, coverage: 1, sessionDate: "2026-10-15", label: "Estimated from live prices", fallback: { previousClose: 140, reported: 156 } });
    expect(intraday).toHaveBeenCalledWith("SYNTHETIC0", "5m");
    expect(d.dailyValues.rows).toHaveBeenCalledWith(SUBJECT, "2026-10-05");
  });
  it("returns the previous session on a weekend-like day, labelled with its date", async () => {
    const { d } = withIntraday(async () => ({ points: [{ t: "2026-10-09T14:30:00.000Z", price: 7 }, { t: "2026-10-09T19:55:00.000Z", price: 8 }], sessionDate: "2026-10-09" }));
    const r = await buildIntraday({ ...d, now: () => new Date("2026-10-11T15:00:00Z") }, present(), SUBJECT);
    expect(r.sessionDate).toBe("2026-10-09");
    expect(r.drawn).toBe(true);
  });
  it("uses hourly bars for crypto and skips unmappable symbols as uncovered", async () => {
    const acct = miniSyntheticAccount(0);
    acct.positions = [
      { ...acct.positions[0], kind: "crypto", symbol: "BTC", units: 1, price: 50, marketValue: 50 },
      { ...acct.positions[0], instrumentId: "x", symbol: "BAD SYMBOL!", units: 1, price: 50, marketValue: 50 },
    ];
    const { d, intraday } = withIntraday(async () => ({ points: [{ t: T1, price: 50 }, { t: T2, price: 51 }], sessionDate: "2026-10-15" }));
    const r = await buildIntraday(d, present([acct]), SUBJECT);
    expect(intraday).toHaveBeenCalledTimes(1);
    expect(intraday).toHaveBeenCalledWith("BTC-CAD", "1h");
    expect(r.coverage).toBeCloseTo(0.5);
    expect(r.drawn).toBe(false);
    // cash 3 + BTC 51 + the unmappable holding's reported 50 as a constant
    expect(r.points.map((p) => p.value)).toEqual([103, 104]);
  });
  it("counts a holding with no reported market value as 0 with a warning", async () => {
    const acct = miniSyntheticAccount(0);
    acct.positions = [{ ...acct.positions[0], marketValue: null }];
    const { d, intraday } = withIntraday(async () => ({ points: [{ t: T1, price: 7 }, { t: T2, price: 8 }], sessionDate: "2026-10-15" }));
    const r = await buildIntraday(d, present([acct]), SUBJECT);
    expect(r.warnings).toBe(1);
    expect(intraday).not.toHaveBeenCalled();
    expect(r.drawn).toBe(false);
  });
  it("does not add cash-equivalent positions on top of balance cash", async () => {
    const acct = miniSyntheticAccount(0);
    acct.positions = [acct.positions[0], { ...acct.positions[0], instrumentId: "c", symbol: "CASH", cashEquivalent: true, units: 100, price: 1, marketValue: 100 }];
    const { d, intraday } = withIntraday(async () => ({ points: [{ t: T1, price: 7 }, { t: T2, price: 7 }], sessionDate: "2026-10-15" }));
    const r = await buildIntraday(d, present([acct]), SUBJECT);
    expect(intraday).toHaveBeenCalledTimes(1);
    expect(r.points.map((p) => p.value)).toEqual([17, 17]); // 14 + cash 3 only
  });
  it("converts a USD holding once and warns when there is no rate", async () => {
    const acct = miniSyntheticAccount(0);
    acct.positions = [{ ...acct.positions[0], currency: "USD", units: 2, marketValue: 14 }];
    const { d } = withIntraday(async () => ({ points: [{ t: T1, price: 7 }, { t: T2, price: 7 }], sessionDate: "2026-10-15" }));
    d.market.usdCad = vi.fn(async () => [{ date: "2026-10-14", close: 2 }]);
    const ok = await buildIntraday(d, present([acct]), SUBJECT);
    expect(ok.points.map((p) => p.value)).toEqual([31, 31]); // 3 + 2*7*2
    const noRate = withIntraday(async () => ({ points: [{ t: T1, price: 7 }, { t: T2, price: 7 }], sessionDate: "2026-10-15" }));
    noRate.d.market.usdCad = vi.fn(async () => null);
    const bad = await buildIntraday(noRate.d, present([acct]), SUBJECT);
    expect(bad.warnings).toBe(1);
    expect(bad.drawn).toBe(false);
  });
  describe("with a crypto holding (I7)", () => {
    const withBtc = () => {
      const acct = miniSyntheticAccount(0);
      acct.positions = [acct.positions[0], { ...acct.positions[0], instrumentId: "b", kind: "crypto", symbol: "BTC", units: 1, price: 50, marketValue: 50 }];
      return acct;
    };
    const hours = (day: string, from: number, to: number, price: (h: number) => number) =>
      Array.from({ length: to - from + 1 }, (_, i) => ({ t: `${day}T${String(from + i).padStart(2, "0")}:00:00.000Z`, price: price(from + i) }));
    const stock = (day: string, times: string[], price = 7) => ({ points: times.map((t) => ({ t: `${day}T${t}:00.000Z`, price })), sessionDate: day });

    it("clips crypto to the equity session window and carries its last earlier bar in", async () => {
      // 10:00 Toronto: crypto's UTC day began 20:00 the evening before.
      const { d } = withIntraday(async (t) => t.startsWith("BTC")
        ? { points: hours("2026-10-15", 0, 14, (h) => 40 + h), sessionDate: "2026-10-15" }
        : stock("2026-10-15", ["13:30", "13:35", "14:00", "14:05"]));
      const r = await buildIntraday({ ...d, now: () => new Date("2026-10-15T14:05:00Z") }, present([withBtc()]), SUBJECT);
      expect(r.points[0].t).toBe("2026-10-15T13:30:00.000Z");
      expect(r.points.at(-1)!.t).toBe("2026-10-15T14:05:00.000Z");
      // cash 3 + 2 x 7 + BTC: 13:00 bar (53) carried to 13:30, 14:00 bar (54) from 14:00
      expect(r.points.map((p) => p.value)).toEqual([3 + 14 + 53, 3 + 14 + 53, 3 + 14 + 54, 3 + 14 + 54]);
      expect(r.sessionDate).toBe("2026-10-15");
      expect(r.warnings).toBe(0);
    });

    it("takes the session date from equities in the evening, when crypto's UTC day is tomorrow", async () => {
      const { d } = withIntraday(async (t) => t.startsWith("BTC")
        ? { points: hours("2026-10-16", 0, 1, () => 60), sessionDate: "2026-10-16" }
        : stock("2026-10-15", ["13:30", "19:55"]));
      const r = await buildIntraday({ ...d, now: () => new Date("2026-10-16T01:30:00Z") }, present([withBtc()]), SUBJECT);
      expect(r.sessionDate).toBe("2026-10-15");
      expect(r.warnings).toBe(0);
      expect(r.points.map((p) => p.t)).toEqual(["2026-10-15T13:30:00.000Z", "2026-10-15T19:55:00.000Z"]);
      expect(r.points.map((p) => p.value)).toEqual([3 + 14 + 60, 3 + 14 + 60]);
    });

    it("labels a weekend with the last equity session, not the crypto day", async () => {
      const { d } = withIntraday(async (t) => t.startsWith("BTC")
        ? { points: [{ t: "2026-10-11T10:00:00.000Z", price: 50 }, { t: "2026-10-11T11:00:00.000Z", price: 50 }], sessionDate: "2026-10-11" }
        : { points: [{ t: "2026-10-09T14:30:00.000Z", price: 7 }, { t: "2026-10-09T14:35:00.000Z", price: 7 }], sessionDate: "2026-10-09" });
      const r = await buildIntraday(d, present([withBtc()]), SUBJECT);
      expect(r.sessionDate).toBe("2026-10-09");
      expect(r.points.every((p) => p.t.startsWith("2026-10-09"))).toBe(true);
    });

    it("still warns when equities come from different sessions", async () => {
      const acct = miniSyntheticAccount(0);
      acct.positions = [acct.positions[0], { ...acct.positions[0], instrumentId: "c", symbol: "OTHER", units: 1, price: 7, marketValue: 7 }];
      const { d } = withIntraday(async (t) => (t === "OTHER" ? stock("2026-10-14", ["14:30", "14:35"]) : stock("2026-10-15", ["14:30", "14:35"])));
      const r = await buildIntraday(d, present([acct]), SUBJECT);
      expect(r.warnings).toBe(1);
      expect(r.sessionDate).toBe("2026-10-15");
    });
  });

  it("returns exactly the keys the output schema declares and requires", async () => {
    const { d } = withIntraday(async () => ({ points: [{ t: T1, price: 7 }, { t: T2, price: 8 }], sessionDate: "2026-10-15" }));
    const def = overviewExtraToolDefinitions.find((t) => t.name === "get_intraday") as any;
    const keys = Object.keys(await buildIntraday(d, present(), SUBJECT)).sort();
    expect(keys).toEqual(Object.keys(def.outputSchema.properties).sort());
    expect(keys).toEqual([...def.outputSchema.required].sort());
  });
  it("falls back honestly when the batch misses its deadline and stops taking tickers", async () => {
    const acct = miniSyntheticAccount(0);
    acct.positions = Array.from({ length: 6 }, (_, i) => ({ ...acct.positions[0], instrumentId: `i${i}`, symbol: `S${i}`, units: 1, price: 10, marketValue: 10 }));
    const { d, intraday } = withIntraday(() => new Promise(() => undefined));
    const r = await buildIntraday({ ...d, marketDeadlineMs: 20 }, present([acct]), SUBJECT);
    expect(r).toMatchObject({ drawn: false, points: [], label: "Estimated from live prices", fallback: { previousClose: 140, reported: 156 } });
    expect(intraday).toHaveBeenCalledTimes(4); // concurrency cap; the other two were never started
    await new Promise((r) => setTimeout(r, 30));
    expect(intraday).toHaveBeenCalledTimes(4);
  });
  it("does not draw from a fast ticker alone when the other hangs, unless coverage reaches 0.8", async () => {
    const mk = (fastValue: number, slowValue: number) => {
      const acct = miniSyntheticAccount(0);
      acct.positions = [
        { ...acct.positions[0], instrumentId: "f", symbol: "FAST", units: 1, price: fastValue, marketValue: fastValue },
        { ...acct.positions[0], instrumentId: "s", symbol: "SLOW", units: 1, price: slowValue, marketValue: slowValue },
      ];
      return acct;
    };
    const impl = async (t: string) => (t === "FAST" ? { points: [{ t: T1, price: 10 }, { t: T2, price: 11 }], sessionDate: "2026-10-15" } : new Promise(() => undefined));
    const half = withIntraday(impl);
    const r1 = await buildIntraday({ ...half.d, marketDeadlineMs: 20 }, present([mk(50, 50)]), SUBJECT);
    expect(r1.coverage).toBeCloseTo(0.5);
    expect(r1.drawn).toBe(false);
    const most = withIntraday(impl);
    const r2 = await buildIntraday({ ...most.d, marketDeadlineMs: 20 }, present([mk(90, 10)]), SUBJECT);
    expect(r2.coverage).toBeCloseTo(0.9);
    expect(r2.drawn).toBe(true);
    expect(r2.points.map((p) => p.value)).toEqual([3 + 10 + 10, 3 + 11 + 10]);
  });
  it("is not drawn when market data has no intraday method", async () => {
    const r = await buildIntraday(deps() as any, present(), SUBJECT);
    expect(r.drawn).toBe(false);
    expect(r.fallback.reported).toBe(156);
  });
});

describe("overview in CAD", () => {
  const present = (accounts: any[]) => buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts } as any);
  const usdAccount = () => {
    const acct = miniSyntheticAccount(1, { currency: "USD", unifiedType: "SELF_DIRECTED_NON_REGISTERED_MARGIN", rawType: "Non-registered" });
    acct.positions[0] = { ...acct.positions[0]!, symbol: "SYNTHETICU", units: 10, price: 11, marketValue: 110 };
    return acct;
  };
  const usdDeps = () => {
    const d = deps();
    d.market.usdCad = vi.fn(async () => [{ date: "2026-10-14", close: 1.36 }, { date: "2026-10-15", close: 1.38 }]);
    d.market.quotes = vi.fn(async () => new Map([["SYNTHETICU", { ticker: "SYNTHETICU", currency: "USD", price: 11, previousClose: 10, asOf: "2026-10-15T15:00:00Z" }]]));
    return d;
  };
  it("carries summary.home from one BoC fetch, with the CAD day change of a USD holding", async () => {
    const d = usdDeps();
    const payload = await buildOverviewPayload(d as any, present([miniSyntheticAccount(0), usdAccount()]), SUBJECT, {});
    expect(payload.summary.home!.total).toMatchObject({ amount: Math.round((156 + 293 * 1.38) * 100) / 100, estimated: true, rateDates: ["2026-10-15"] });
    expect(payload.summary.home!.dayChange).toMatchObject({ amount: 15.8, estimated: true });
    // Native fields are kept.
    expect(payload.summary.totals).toEqual([{ currency: "CAD", amount: 156 }, { currency: "USD", amount: 293 }]);
    const fxCalls = d.market.usdCad.mock.calls.filter(([from]) => from === "2026-10-05");
    expect(fxCalls).toHaveLength(1);
  });
  it("a CAD-only portfolio has an exact CAD total and makes no extra BoC fetch", async () => {
    const d = deps();
    const payload = await buildOverviewPayload(d as any, present([miniSyntheticAccount(0)]), SUBJECT, {});
    expect(payload.summary.home!.total).toEqual({ amount: 156, estimated: false, rateDates: [], excluded: [], excludedCount: 0 });
    expect(d.market.usdCad.mock.calls.filter(([from]) => from === "2026-10-05")).toHaveLength(0);
  });
  it("a USD-only portfolio still fetches the rate for its CAD total", async () => {
    const d = usdDeps();
    const payload = await buildOverviewPayload(d as any, present([usdAccount()]), SUBJECT, {});
    expect(payload.summary.home!.total).toMatchObject({ amount: Math.round(293 * 1.38 * 100) / 100, estimated: true });
  });
  it("tells the model the CAD total, the est. note and keeps the native totals", async () => {
    const payload = await buildOverviewPayload(usdDeps() as any, present([miniSyntheticAccount(0), usdAccount()]), SUBJECT, {});
    const text = overviewText(payload);
    expect(text).toContain("Total 560.34 CAD est. (BoC Oct 15)");
    expect(text).toContain("Figures are in CAD; USD amounts are converted at the Bank of Canada rate and marked est.");
    expect(text).toContain("In original currencies: 156.00 CAD + 293.00 USD.");
  });
  it("names unconverted amounts and accounts without a brokerage total in the model text", async () => {
    const d = usdDeps();
    d.market.usdCad = vi.fn(async () => null);
    const text = overviewText(await buildOverviewPayload(d as any, present([miniSyntheticAccount(0), usdAccount(), miniSyntheticAccount(2, { reported: false })]), SUBJECT, {}));
    expect(text).toMatch(/Total [\d,.]+ CAD \(1 amount not converted\)/);
    expect(text).toContain("includes accounts without a brokerage total");
  });

  it("labels the CAD unrealized gain at today's rate in the model text", async () => {
    const acct = usdAccount();
    acct.positions[0] = { ...acct.positions[0]!, costBasis: 9, unrealizedGain: 20 };
    const text = overviewText(await buildOverviewPayload(usdDeps() as any, present([acct]), SUBJECT, {}));
    expect(text).toContain("Unrealized gain (at today's rate) 27.60 CAD est.; excludes currency movement since purchase.");
  });
  it("with cadView off the model text keeps the native totals and has no CAD figure or CAD note", async () => {
    const acct = usdAccount();
    acct.positions[0] = { ...acct.positions[0]!, costBasis: 9, unrealizedGain: 20 };
    const payload = await buildOverviewPayload(usdDeps() as any, present([miniSyntheticAccount(0), acct]), SUBJECT, {});
    const on = overviewText(payload);
    expect(on).toContain("Figures are in CAD");
    const off = overviewText({ ...payload, settings: { ...payload.settings, cadView: false } });
    expect(off).toContain("Total 156.00 CAD + 293.00 USD.");
    expect(off).not.toContain("Figures are in CAD");
    expect(off).not.toContain("est. (BoC");
    expect(off).not.toContain("Unrealized gain (at today's rate)");
    expect(off).not.toContain("In original currencies");
  });
  it("a USD-only portfolio with no rate is not given a CAD total in the model text", async () => {
    const d = usdDeps();
    d.market.usdCad = vi.fn(async () => null);
    const text = overviewText(await buildOverviewPayload(d as any, present([usdAccount()]), SUBJECT, {}));
    expect(text).toContain("Total not converted (no recent Bank of Canada rate).");
    expect(text).not.toContain("0.00 CAD");
    expect(text).toContain("In original currencies: 293.00 USD.");
  });
});


describe("overview charts in CAD (task 11)", () => {
  const present = (accounts: any[]) => buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts } as any);
  const usdAccount = () => {
    const acct = miniSyntheticAccount(1, { currency: "USD", unifiedType: "SELF_DIRECTED_NON_REGISTERED_MARGIN", rawType: "Non-registered" });
    acct.positions[0] = { ...acct.positions[0]!, symbol: "SYNTHETICU", units: 10, price: 11, marketValue: 110 };
    return acct;
  };
  const CAD_ID = "MINI-SYNTHETIC-ACCOUNT-0", USD_ID = "MINI-SYNTHETIC-ACCOUNT-1";
  const days = ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"];
  const rates = (skip: string[] = []) => ["2026-10-01", ...days, "2026-10-15"].filter((d) => !skip.includes(d)).map((date) => ({ date, close: 1.4 }));
  const cadDeps = (cadView: boolean) => {
    const d = deps();
    d.settings.get = vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView }));
    d.market.usdCad = vi.fn(async () => rates());
    d.dailyValues.rows = vi.fn(async () => days.flatMap((date) => [
      { date, accountId: CAD_ID, currency: "CAD", value: 156, source: "reported" as const },
      { date, accountId: USD_ID, currency: "USD", value: 293, source: "reported" as const },
    ]));
    return d;
  };
  const both = () => present([miniSyntheticAccount(0), usdAccount()]);

  it("the value series is in CAD: USD daily values × that day's rate, est.", async () => {
    const payload = await buildOverviewPayload(cadDeps(true) as any, both(), SUBJECT, { period: "1W" });
    expect(payload.series.currency).toBe("CAD");
    expect(payload.series.points[0]).toMatchObject({ date: "2026-10-09", value: 566.2 });
    expect(payload.series.points.at(-1)).toMatchObject({ date: "2026-10-15", value: 566.2 });
    expect(payload.series.home).toEqual({ estimated: true, notConvertedDays: 0, notConvertedAccounts: 0, flowNotConverted: null });
  });
  it("a day without a recent rate is counted and not drawn as a drop", async () => {
    const d = cadDeps(true);
    // Only the Oct 1 rate is older than 7 days for Oct 9; Oct 9 has no rate within 7 days when Oct 2-8 are missing.
    d.market.usdCad = vi.fn(async () => [{ date: "2026-10-01", close: 1.4 }, ...rates(["2026-10-01", "2026-10-09"])]);
    const payload = await buildOverviewPayload(d as any, both(), SUBJECT, { period: "1W" });
    expect(payload.series.home?.notConvertedDays).toBe(1);
    expect(payload.series.points.map((p) => p.date)).not.toContain("2026-10-09");
    expect(payload.series.points.every((p) => p.value === 566.2)).toBe(true);
  });
  it("with no rate at all the series keeps its own currency and says the USD accounts were not converted", async () => {
    const d = cadDeps(true);
    d.market.usdCad = vi.fn(async () => null);
    const payload = await buildOverviewPayload(d as any, both(), SUBJECT, { period: "1W" });
    expect(payload.series.currency).toBe("USD");
    expect(payload.series.points[0].value).toBe(293);
    expect(payload.series.home).toEqual({ estimated: false, notConvertedDays: 0, notConvertedAccounts: 1, flowNotConverted: null });
  });
  it("with cadView off the series stays in the primary currency", async () => {
    const payload = await buildOverviewPayload(cadDeps(false) as any, both(), SUBJECT, { period: "1W" });
    expect(payload.series.currency).toBe("USD");
    expect(payload.series.points[0].value).toBe(293);
    expect(payload.series.home).toBeUndefined();
  });
  it("the allocation bar is in CAD across currencies", async () => {
    const payload = await buildOverviewPayload(cadDeps(true) as any, both(), SUBJECT, {});
    const home = payload.summary.home!;
    expect(home.allocationEstimated).toBe(true);
    // Stocks 14 CAD + 110 USD × 1.4; cash 3 CAD + 4 USD × 1.4.
    const stock = 14 + 154, cash = 3 + 5.6;
    expect(home.allocation.find((s) => s.key === "stock")!.fraction).toBeCloseTo(stock / (stock + cash), 6);
    expect(home.allocation.find((s) => s.key === "cash")!.fraction).toBeCloseTo(cash / (stock + cash), 6);
  });
  it("the intraday line is in CAD with USD holdings converted, and the fallback figures are CAD", async () => {
    const d = cadDeps(true) as any;
    const T1 = "2026-10-15T14:30:00.000Z", T2 = "2026-10-15T14:35:00.000Z";
    d.market.intraday = vi.fn(async (t: string) => ({ points: [{ t: T1, price: t === "SYNTHETICU" ? 11 : 7 }, { t: T2, price: t === "SYNTHETICU" ? 11 : 7 }], sessionDate: "2026-10-15" }));
    const r = await buildIntraday(d, both(), SUBJECT);
    // CAD: 2 × 7 + 3 cash; USD: (10 × 11 + 4 cash) × 1.4
    expect(r.points.map((p) => p.value)).toEqual([176.6, 176.6]);
    expect(r.currency).toBe("CAD");
    expect(r.fallback).toEqual({ previousClose: 566.2, reported: 566.2 });
  });
  it("the intraday line with cadView off stays in the primary currency", async () => {
    const d = cadDeps(false) as any;
    d.market.intraday = vi.fn(async () => ({ points: [{ t: "2026-10-15T14:30:00.000Z", price: 11 }, { t: "2026-10-15T14:35:00.000Z", price: 11 }], sessionDate: "2026-10-15" }));
    const r = await buildIntraday(d, both(), SUBJECT);
    expect(r.fallback.reported).toBe(293);
    expect(r.currency).toBe("USD");
  });
});

describe("overview CAD today point (task 11, fix round 1)", () => {
  it("no today point when an included account has no reported value today, as in Performance", async () => {
    const d = deps();
    d.settings.get = vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView: true }));
    d.market.usdCad = vi.fn(async () => ["2026-10-01", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"].map((date) => ({ date, close: 1.4 })));
    const usd = miniSyntheticAccount(1, { currency: "USD", unifiedType: "SELF_DIRECTED_NON_REGISTERED_MARGIN", rawType: "Non-registered" });
    const unreported = miniSyntheticAccount(2, { reported: false });
    d.dailyValues.rows = vi.fn(async () => ["2026-10-12", "2026-10-13", "2026-10-14"].flatMap((date) => [
      { date, accountId: "MINI-SYNTHETIC-ACCOUNT-0", currency: "CAD", value: 156, source: "reported" as const },
      { date, accountId: "MINI-SYNTHETIC-ACCOUNT-1", currency: "USD", value: 293, source: "reported" as const },
      { date, accountId: "MINI-SYNTHETIC-ACCOUNT-2", currency: "CAD", value: 430, source: "reported" as const },
    ]));
    const pf = buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts: [miniSyntheticAccount(0), usd, unreported] } as any);
    const payload = await buildOverviewPayload(d as any, pf, SUBJECT, { period: "1W" });
    expect(payload.series.currency).toBe("CAD");
    expect(payload.series.points.at(-1)!.date).toBe("2026-10-14");
    expect(payload.series.points.every((p) => p.value === 996.2)).toBe(true);
  });
});

describe("show_portfolio compact model copy (agent query surface, D6)", () => {
  const withPoints = async () => {
    const payload = await buildOverviewPayload(deps() as any, buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts: [miniSyntheticAccount(0), miniSyntheticAccount(1)] } as any), SUBJECT, {});
    const days = Array.from({ length: 365 }, (_, i) => new Date(Date.UTC(2025, 9, 15) + i * 86_400_000).toISOString().slice(0, 10));
    payload.series.points = days.map((date, i) => ({ date, value: 1000 + i, source: "reported" as const }));
    payload.series.benchmark.points = days.map((date, i) => ({ date, returnFraction: i / 1000 }));
    return payload;
  };
  const keys = (v: unknown, out: string[] = []): string[] => {
    if (Array.isArray(v)) v.forEach((x) => keys(x, out));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keys(x, out); }
    return out;
  };
  it("drops per-day arrays and positions but keeps the figures and the account list", async () => {
    const payload = await withPoints();
    const copy = overviewModelCopy(payload) as any;
    expect(keys(copy)).not.toContain("points");
    expect(keys(copy)).not.toContain("positions");
    expect(copy.accounts[0]).toEqual({
      id: payload.portfolio.accounts[0]!.id, name: payload.portfolio.accounts[0]!.name,
      label: payload.portfolio.accounts[0]!.classification.label, bucket: payload.portfolio.accounts[0]!.classification.bucket,
      value: payload.portfolio.accounts[0]!.value, freshness: payload.portfolio.accounts[0]!.freshness,
    });
    expect(copy.accounts[0].id).toBeTruthy();
    expect(copy.summary.totals).toEqual(payload.summary.totals);
    expect(copy.summary.largestHolding).toEqual(payload.summary.largestHolding);
    expect(copy.series).toMatchObject({ period: payload.series.period, currency: "CAD", portfolioReturn: payload.series.portfolioReturn, spanStart: payload.series.spanStart, spanIsPartial: payload.series.spanIsPartial, benchmark: { name: "S&P 500" } });
    expect(copy.history).toEqual({ building: payload.history.building, incompleteAccounts: payload.history.incompleteAccounts });
    expect(copy.settings).toEqual({ cadView: payload.settings.cadView });
    expect(JSON.stringify(copy).length).toBeLessThan(JSON.stringify(payload).length / 2);
  });
  it("keeps the connection and partial-failure signals (connectionRequired true)", async () => {
    const payload = await buildOverviewPayload(deps() as any, buildPortfolioPresentation({ connectionRequired: true, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts: [] } as any), SUBJECT, {});
    const copy = overviewModelCopy(payload);
    expect(copy.portfolio).toEqual({ connectionRequired: true, errors: [], generatedAt: "2026-10-15T15:00:00.000Z" });
    expect(copy.accounts).toEqual([]);
  });
  it("keeps a non-empty errors list so a failed account is not silent", async () => {
    const errors = [{ code: "account_data_unavailable", accountId: "MINI-SYNTHETIC-ACCOUNT-9" }];
    const payload = await buildOverviewPayload(deps() as any, buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors, accounts: [miniSyntheticAccount(0)] } as any), SUBJECT, {});
    expect(payload.portfolio.errors.length).toBe(1);
    expect(overviewModelCopy(payload).portfolio.errors).toEqual(payload.portfolio.errors);
    const { client } = await connect(deps(), undefined, [miniSyntheticAccount(0)]);
    const model = JSON.parse(((await client.callTool({ name: "show_portfolio", arguments: {} })).content as any[])[1].text);
    expect(model.portfolio).toMatchObject({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z" });
  });
  it("keeps the caveat flags next to the figures they qualify", async () => {
    const payload = await withPoints();
    payload.summary.unrealizedCoverage = { withCostBasis: 1, holdings: 3 };
    payload.summary.cashNetOfMargin = true;
    payload.summary.primaryCurrency = "CAD";
    const copy = overviewModelCopy(payload);
    expect(copy.summary.unrealizedCoverage).toEqual({ withCostBasis: 1, holdings: 3 });
    expect(copy.summary.cashNetOfMargin).toBe(true);
    expect(copy.summary.primaryCurrency).toBe("CAD");
    expect(copy.summary.groups).toEqual(payload.summary.groups);
    expect(copy.summary.groups.length).toBeGreaterThan(0);
    expect(copy.summary.groups[0]!.accountIds.length).toBeGreaterThan(0);
  });
  it("show_portfolio sends the compact copy as the model block and leaves structuredContent whole", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "show_portfolio", arguments: {} });
    const structured = result.structuredContent as any;
    const expected = await buildOverviewPayload(deps() as any, buildPortfolioPresentation({ connectionRequired: false, generatedAt: "2026-10-15T15:00:00.000Z", errors: [], accounts: [miniSyntheticAccount(0)] } as any), SUBJECT, {});
    expect(structured).toEqual(JSON.parse(JSON.stringify({ ...expected, portfolio: modelPortfolio(expected.portfolio) })));
    expect(structured.series.points.length).toBeGreaterThan(0);
    expect(structured.portfolio.accounts[0].positions.length).toBeGreaterThan(0);
    const model = JSON.parse((result.content as any[])[1].text);
    expect(keys(model)).not.toContain("points");
    expect(keys(model)).not.toContain("positions");
    expect(model.accounts.map((a: any) => a.id)).toEqual(structured.portfolio.accounts.map((a: any) => a.id));
    expect(model.series.period).toBe(structured.series.period);
  });
});
