import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import type { PortfolioQueryResult } from "../portfolio/portfolio-query-service.js";
import { SnapTradeKeyRejectedError } from "../snaptrade/gateway.js";
import { miniSyntheticAccount } from "../testing/mini-synthetic-fixtures.js";
import { createPortfolioMcpServer } from "./portfolio-mcp-server.js";
import { widgetUri } from "./widget-assets.js";
import { createWidgetLoader, widgetLoaderHtml, widgetLoaderUri } from "./widget-loader.js";
import { MemoryNewsStore } from "../news/store.js";
import { summarizeAccountHistory } from "../portfolio/history-normalize.js";
import { toolRateLimiter } from "./rate-limit.js";
import { MarketDataService, MemoryMarketDataCache } from "../market-data/market-data-service.js";

const SUBJECT = "subject|synthetic-mcp-subject";

function syntheticPortfolio(): PortfolioQueryResult {
  return {
    connectionRequired: false,
    generatedAt: "2026-10-14T12:00:00.000Z",
    accounts: [miniSyntheticAccount(0), miniSyntheticAccount(1, { currency: "USD" })],
    errors: [],
  };
}

async function connect(options: Partial<Parameters<typeof createPortfolioMcpServer>[0]> = {}) {
  const portfolio = { getPortfolio: vi.fn(async () => syntheticPortfolio()) };
  const history = { getAccountHistory: vi.fn(async () => ({})) };
  const server = createPortfolioMcpServer({ authSubject: SUBJECT, portfolio, history, ...options });
  const client = new Client({ name: "synthetic-claude-host", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, portfolio };
}

type TextBlock = { type: string; text: string };

function textBlocks(result: unknown): TextBlock[] {
  return ((result as { content?: TextBlock[] }).content ?? []).filter((block) => block.type === "text");
}

describe("portfolio MCP results for model-facing hosts", () => {
  it("answers a rejected SnapTrade key with an error naming the settings to check, not a generic failure", async () => {
    const { client } = await connect({ portfolio: { getPortfolio: vi.fn(async () => { throw new SnapTradeKeyRejectedError(); }) } });
    for (const name of ["get_portfolio_snapshot", "show_portfolio", "list_portfolio_accounts"]) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBe(true);
      const text = textBlocks(result).map((b) => b.text).join(" ");
      expect(text).toContain("SnapTrade rejected this instance's API key");
      expect(text).toContain("restart the app (for Docker: docker compose up -d)");
      expect(text).toContain("SNAPTRADE_CLIENT_ID");
    }
  });

  for (const tool of ["get_portfolio_snapshot", "show_portfolio", "list_portfolio_accounts"]) {
    it(`${tool} serializes its structured content as text so the model can read it`, async () => {
      const { client } = await connect();
      const result = await client.callTool({ name: tool, arguments: {} });
      expect(result.isError).not.toBe(true);
      const blocks = textBlocks(result);
      expect(blocks.length).toBe(2);
      expect(JSON.parse(blocks[1].text)).toEqual(result.structuredContent);
    });
  }

  it("get_account_positions serializes the selected account's positions", async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: "get_account_positions",
      arguments: { accountId: "MINI-SYNTHETIC-ACCOUNT-1" },
    });
    const blocks = textBlocks(result);
    expect(JSON.parse(blocks[1].text)).toEqual(result.structuredContent);
    expect(JSON.parse(blocks[1].text).positions[0].symbol).toBe("SYNTHETIC1");
  });

  it("14: position payloads name computed fields as calculated and the cost basis as per unit (real keys)", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const result = await client.callTool({ name: "get_account_positions", arguments: { accountId: "MINI-SYNTHETIC-ACCOUNT-1" } });
    const position = (result.structuredContent as any).positions[0];
    const schema = (tools.find((t) => t.name === "get_account_positions")!.outputSchema as any).properties.positions.items;
    expect(Object.keys(position).sort()).toEqual([...schema.required].sort());
    expect(Object.keys(schema.properties).sort()).toEqual([...schema.required].sort());
    expect(position).toMatchObject({ costBasisPerUnit: null, calculatedMarketValue: 3 * 8, calculatedUnrealizedGain: null });
    for (const old of ["costBasis", "marketValue", "unrealizedGain"]) expect(position).not.toHaveProperty(old);
    const snapshot = await client.callTool({ name: "get_portfolio_snapshot", arguments: {} });
    const p = (snapshot.structuredContent as any).accounts[0].positions[0];
    expect(p).toHaveProperty("calculatedMarketValue");
    expect(p).not.toHaveProperty("marketValue");
  });

  it("error results do not carry serialized data", async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: "get_account_positions",
      arguments: { accountId: "MINI-SYNTHETIC-ACCOUNT-unknown" },
    });
    expect(result.isError).toBe(true);
    expect(textBlocks(result)).toHaveLength(1);
  });

  it("the dashboard tool keeps its widget binding for MCP Apps hosts", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const show = tools.find((tool) => tool.name === "show_portfolio");
    expect(show?._meta).toMatchObject({ ui: { resourceUri: "ui://portfolio/dashboard-v4" } });
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });
});

describe("normal-mode cache metadata and refresh", () => {
  it("passes cache status through to the structured portfolio", async () => {
    const { client, portfolio } = await connect();
    portfolio.getPortfolio.mockResolvedValueOnce({
      ...syntheticPortfolio(),
      cache: { source: "cache", loadedAt: "2026-10-14T11:59:00.000Z", stale: true, staleReason: "provider_unavailable" },
    });
    const result = await client.callTool({ name: "get_portfolio_snapshot", arguments: {} });
    expect(result.structuredContent).toMatchObject({
      cache: { source: "cache", stale: true, staleReason: "provider_unavailable" },
    });
    expect(textBlocks(result)[0].text).toMatch(/stale/i);
  });

  for (const tool of ["get_portfolio_snapshot", "show_portfolio"]) {
    it(`${tool} forwards an explicit refresh request`, async () => {
      const { client, portfolio } = await connect();
      await client.callTool({ name: tool, arguments: { refresh: true } });
      expect(portfolio.getPortfolio).toHaveBeenCalledWith(SUBJECT, { refresh: true });
      await client.callTool({ name: tool, arguments: {} });
      expect(portfolio.getPortfolio).toHaveBeenLastCalledWith(SUBJECT);
    });
  }

  it("advertises the optional refresh argument in normal mode", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const name of ["get_portfolio_snapshot", "show_portfolio"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.inputSchema.properties).toHaveProperty("refresh");
    }
  });

  it("rejects non-boolean refresh values", async () => {
    const { client } = await connect();
    await expect(client.callTool({ name: "get_portfolio_snapshot", arguments: { refresh: "yes" } })).rejects.toThrow();
  });
});

describe("performance tools and resource", () => {
  const PERF_HTML = "<!doctype html><title>performance</title>";
  const OVERVIEW_HTML = "<!doctype html><title>overview</title>";
  const days = Array.from({ length: 12 }, (_, i) => new Date(Date.parse("2026-09-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10));
  function performanceDeps() {
    return {
      market: {
        history: vi.fn(async (): Promise<any> => [{ date: "2026-09-01", close: 100 }, { date: "2026-10-14", close: 110 }]),
        usdCad: vi.fn(async (): Promise<any> => null),
        securityHistory: vi.fn(async (): Promise<any> => null),
      },
      settings: { get: vi.fn(async () => ({ benchmark: "sp500", cadView: false, privacyDefault: false })), save: vi.fn() },
      dailyValues: {
        rows: vi.fn(async (): Promise<any[]> => days.map((date) => ({ date, accountId: "MINI-SYNTHETIC-ACCOUNT-0", currency: "CAD", value: 156, source: "reported" }))),
        earliest: vi.fn(async (): Promise<string | null> => "2026-09-01"),
      },
      activities: { userId: vi.fn(async () => "user-1"), listActivities: vi.fn(async (): Promise<any[]> => []), syncState: vi.fn(async () => ({ backfillCompletedAt: new Date("2026-09-01T00:00:00Z"), lastSyncedAt: new Date("2026-10-15T00:00:00Z"), lastError: null, dirty: false })), qualities: vi.fn(async (): Promise<any[]> => []) },
      now: () => new Date("2026-10-15T15:00:00Z"),
    };
  }
  const assets = (perf: string | null = PERF_HTML) => ({ html: (name: string) => (name === "performance" ? perf : OVERVIEW_HTML) });
  const overviewDeps = () => ({ market: performanceDeps().market, settings: performanceDeps().settings, dailyValues: performanceDeps().dailyValues });
  const wired = (over: Record<string, unknown> = {}) => connect({ overview: overviewDeps() as never, performance: performanceDeps() as never, assets: assets(), ...over } as never);

  it("lists both tools and the resource and reads the static HTML", async () => {
    const { client } = await wired();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["show_performance", "get_performance"]));
    const { resources } = await client.listResources();
    const uri = widgetUri("performance", PERF_HTML);
    expect(tools.find((t) => t.name === "show_performance")?._meta).toMatchObject({ ui: { resourceUri: uri }, "openai/outputTemplate": uri });
    expect(resources.map((r) => r.uri)).not.toContain("ui://portfolio/performance-v1");
    expect(resources.find((r) => r.uri === uri)).toMatchObject({
      name: "portfolio-performance", title: "Portfolio performance", mimeType: "text/html;profile=mcp-app",
      description: "Authenticated read-only performance: returns net of deposits, benchmark, monthly returns and risk.",
    });
    const read = await client.readResource({ uri });
    expect((read.contents[0] as { text: string }).text).toBe(PERF_HTML);
    const alias = await client.readResource({ uri: "ui://portfolio/performance-v1" });
    expect((alias.contents[0] as { text: string }).text).toBe(PERF_HTML);
    expect(read.contents[0]._meta).toMatchObject({ ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } });
    expect(typeof (read.contents[0]._meta as any)["openai/widgetDescription"]).toBe("string");
  });

  it("show_performance returns structured content, a message and a compact JSON copy without series (F5)", async () => {
    const { client } = await wired();
    const result = await client.callTool({ name: "show_performance", arguments: { period: "1M", accountId: "MINI-SYNTHETIC-ACCOUNT-0" } });
    expect(result.isError).not.toBe(true);
    const blocks = textBlocks(result);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain("Showing the performance widget.");
    const sc = result.structuredContent as any;
    const copy = JSON.parse(blocks[1].text);
    expect(Object.keys(copy).sort()).toEqual(["benchmark", "figures", "monthly", "otherCurrencies", "scope", "span"]);
    expect(copy).toEqual({ scope: sc.scope, span: sc.span, figures: sc.figures, monthly: sc.monthly, benchmark: { key: sc.benchmark.key, name: sc.benchmark.name, basis: sc.benchmark.basis }, otherCurrencies: sc.otherCurrencies });
    expect(sc).toMatchObject({ period: "1M", scope: { kind: "account" } });
    expect(sc.series.value.length).toBeGreaterThan(0);
  });
  it("get_performance also carries the compact copy; the overview keeps its full copy", async () => {
    const { client } = await wired();
    const perf = await client.callTool({ name: "get_performance", arguments: { period: "3M" } });
    expect(JSON.parse(textBlocks(perf)[1].text).series).toBeUndefined();
    const overview = await client.callTool({ name: "get_overview_series", arguments: { period: "1M" } });
    expect(JSON.parse(textBlocks(overview)[1].text)).toEqual(overview.structuredContent);
  });
  it("structuredContent keys equal the outputSchema's required keys (real payload)", async () => {
    const { client } = await wired();
    const { tools } = await client.listTools();
    for (const name of ["show_performance", "get_performance"]) {
      const result = await client.callTool({ name, arguments: { period: "1M" } });
      const schema = tools.find((t) => t.name === name)!.outputSchema as any;
      expect(Object.keys(result.structuredContent as object).sort()).toEqual([...schema.required].sort());
      expect(Object.keys(schema.properties).sort()).toEqual([...schema.required].sort());
    }
  });

  it("get_performance has no widget message", async () => {
    const { client } = await wired();
    const result = await client.callTool({ name: "get_performance", arguments: { period: "3M" } });
    expect(result.isError).not.toBe(true);
    expect(textBlocks(result)).toHaveLength(2);
    expect(textBlocks(result)[0].text).not.toContain("Showing the performance widget.");
  });

  it("adds the stale note", async () => {
    const { client, portfolio } = await wired();
    portfolio.getPortfolio.mockResolvedValueOnce({ ...syntheticPortfolio(), cache: { source: "cache", loadedAt: "2026-10-14T11:59:00.000Z", stale: true, staleReason: "provider_unavailable" } });
    const result = await client.callTool({ name: "get_performance", arguments: { period: "1M" } });
    expect(textBlocks(result)[0].text).toMatch(/stale data last read/);
  });

  it("an unknown account is an error result with guidance", async () => {
    const { client } = await wired();
    const result = await client.callTool({ name: "show_performance", arguments: { accountId: "nope" } });
    expect(result.isError).toBe(true);
    expect(textBlocks(result)).toHaveLength(1);
    expect(textBlocks(result)[0].text).toBe("Unknown or excluded account. Use list_portfolio_accounts to pick an included account.");
  });

  it("accountType: both filters are invalid params; no account, several or only managed are error results", async () => {
    const { client, portfolio } = await wired();
    for (const name of ["show_performance", "get_performance"]) {
      const both = client.callTool({ name, arguments: { period: "1M", accountId: "MINI-SYNTHETIC-ACCOUNT-0", accountType: "tfsa" } });
      await expect(both).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(both).rejects.toThrow(/Give accountId or accountType, not both\./);
      const none = await client.callTool({ name, arguments: { period: "1M", accountType: "fhsa" } });
      expect(none.isError).toBe(true);
      expect(textBlocks(none)).toEqual([{ type: "text", text: "No connected FHSA accounts. Use list_portfolio_accounts to see what is connected." }]);
      const several = await client.callTool({ name, arguments: { period: "1M", accountType: "tfsa" } });
      expect(several.isError).toBe(true);
      expect(textBlocks(several)).toEqual([{ type: "text", text: "You have 2 TFSA accounts: Synthetic account 0 (MINI-SYNTHETIC-ACCOUNT-0), Synthetic account 1 (MINI-SYNTHETIC-ACCOUNT-1). Ask about one with accountId, or about all accounts." }]);
    }
    portfolio.getPortfolio.mockResolvedValueOnce({ ...syntheticPortfolio(), accounts: [miniSyntheticAccount(0), miniSyntheticAccount(1, { unifiedType: "MANAGED_RRSP", rawType: "RRSP" })] });
    const managed = await client.callTool({ name: "show_performance", arguments: { accountType: "rrsp" } });
    expect(managed.isError).toBe(true);
    expect(textBlocks(managed)[0].text).toMatch(/^That is a managed portfolio\. SnapTrade doesn't provide its holdings history/);
  });

  it("accountType with one eligible account answers for it, names the managed one in text only", async () => {
    const { client, portfolio } = await wired();
    const accounts = [miniSyntheticAccount(0), miniSyntheticAccount(1, { unifiedType: "MANAGED_TFSA", name: "Synthetic managed TFSA" })];
    portfolio.getPortfolio.mockResolvedValueOnce({ ...syntheticPortfolio(), accounts });
    const typed = await client.callTool({ name: "show_performance", arguments: { period: "1M", accountType: "tfsa" } });
    portfolio.getPortfolio.mockResolvedValueOnce({ ...syntheticPortfolio(), accounts });
    const byId = await client.callTool({ name: "show_performance", arguments: { period: "1M", accountId: "MINI-SYNTHETIC-ACCOUNT-0" } });
    expect(typed.isError).not.toBe(true);
    expect(typed.structuredContent).toEqual(byId.structuredContent);
    expect((typed.structuredContent as any).scope).toMatchObject({ kind: "account", accountId: "MINI-SYNTHETIC-ACCOUNT-0" });
    expect(textBlocks(typed)[0].text).toContain("Synthetic managed TFSA isn't included: SnapTrade doesn't provide its history.");
    expect(textBlocks(typed)[0].text).not.toContain("MINI-SYNTHETIC-ACCOUNT");
  });

  it("malformed input is invalid params, like other tools", async () => {
    const { client } = await wired();
    await expect(client.callTool({ name: "get_performance", arguments: { period: "5Y" } })).rejects.toThrow(/Invalid portfolio tool arguments/);
    await expect(client.callTool({ name: "show_performance", arguments: { extra: 1 } })).rejects.toThrow(/Invalid portfolio tool arguments/);
  });

  it("registers nothing without the performance asset or dependencies", async () => {
    for (const over of [{ assets: assets(null) }, { performance: undefined }]) {
      const { client } = await wired(over);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).not.toContain("show_performance");
      expect(tools.map((t) => t.name)).not.toContain("get_performance");
      expect((await client.listResources()).resources.map((r) => r.uri)).not.toContain("ui://portfolio/performance-v1");
      await expect(client.readResource({ uri: "ui://portfolio/performance-v1" })).rejects.toThrow();
      await expect(client.callTool({ name: "get_performance", arguments: { period: "1M" } })).rejects.toThrow();
    }
  });

  it("registers nothing when the overview is disabled", async () => {
    const { client } = await wired({ overview: undefined });
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("show_performance");
  });

});

describe("activity tools, intraday and resource", () => {
  const ACT_HTML = "<!doctype html><title>activity</title>";
  const OVERVIEW_HTML = "<!doctype html><title>overview</title>";
  const settings = { get: vi.fn(async () => ({ benchmark: "sp500", cadView: false, privacyDefault: false })), save: vi.fn() };
  const overviewDeps = () => ({
    market: { history: vi.fn(async (): Promise<any> => null), usdCad: vi.fn(async (): Promise<any> => null), quotes: vi.fn(async (): Promise<any> => new Map()) },
    settings,
    dailyValues: { rows: vi.fn(async (): Promise<any[]> => []), earliest: vi.fn(async (): Promise<string | null> => null) },
    now: () => new Date("2026-10-15T15:00:00Z"),
  });
  const activityDeps = () => ({
    activities: { userId: vi.fn(async () => "user-1"), syncState: vi.fn(async () => null), queryActivities: vi.fn(async (): Promise<any[]> => []) },
    market: { securityHistory: vi.fn(async (): Promise<any> => null) },
    settings,
    cursorSecret: Buffer.alloc(32, 9),
    now: () => new Date("2026-10-15T15:00:00Z"),
  });
  const assets = (activity: string | null = ACT_HTML) => ({ html: (name: string) => (name === "activity" ? activity : OVERVIEW_HTML) });
  const wired = (over: Record<string, unknown> = {}) => connect({ overview: overviewDeps() as never, activity: activityDeps() as never, assets: assets(), ...over } as never);
  const ACTIVITY_TOOLS = ["show_activity", "get_activity_page", "get_symbol_history"];

  it("lists the tools and resource and reads the static HTML", async () => {
    const { client } = await wired();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([...ACTIVITY_TOOLS, "get_intraday"]));
    const { resources } = await client.listResources();
    const uri = widgetUri("activity", ACT_HTML);
    expect((await client.listTools()).tools.find((t) => t.name === "show_activity")?._meta).toMatchObject({ ui: { resourceUri: uri }, "openai/outputTemplate": uri });
    expect(resources.map((r) => r.uri)).not.toContain("ui://portfolio/activity-v1");
    expect(resources.find((r) => r.uri === uri)).toMatchObject({ name: "portfolio-activity", mimeType: "text/html;profile=mcp-app" });
    const read = await client.readResource({ uri });
    expect((read.contents[0] as { text: string }).text).toBe(ACT_HTML);
    const alias = await client.readResource({ uri: "ui://portfolio/activity-v1" });
    expect((alias.contents[0] as { text: string }).text).toBe(ACT_HTML);
    // 2026-10-22: Claude kept a tool list naming the previous deploy's hash (activity-0ed970e3c6)
    // across an app restart; refusing it showed "Unable to reach VestLens". Any earlier hash of a
    // known widget serves the current HTML; other names and malformed hashes are still refused.
    const previous = await client.readResource({ uri: "ui://portfolio/activity-0ed970e3c6" });
    expect((previous.contents[0] as { uri: string; text: string })).toMatchObject({ uri: "ui://portfolio/activity-0ed970e3c6", text: ACT_HTML });
    for (const bad of ["ui://portfolio/activity-0ED970E3C6", "ui://portfolio/activity-0ed970e3c", "ui://portfolio/activity-0ed970e3c6x", "ui://portfolio/secret-0ed970e3c6", "ui://other/activity-0ed970e3c6"]) {
      await expect(client.readResource({ uri: bad }), bad).rejects.toThrow();
    }
    expect(read.contents[0]._meta).toMatchObject({ ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } });
    expect((read.contents[0]._meta as any)["openai/widgetDescription"]).toBe("A read-only activity feed with filters, search and a per-symbol view.");
  });

  // 2026-10-23: for "show my history for ATZ" Claude picked get_account_history (titled
  // "Get account history and analytics", no widget) four times instead of show_activity.
  it("routes history questions to show_activity: the raw tool points there and drops 'history' from its title", async () => {
    const { client } = await wired();
    const { tools } = await client.listTools();
    const raw = tools.find((t) => t.name === "get_account_history")!;
    const feed = tools.find((t) => t.name === "show_activity")!;
    expect(raw.title).toBe("Get raw account orders and activities");
    expect(raw.description).toContain("use show_activity");
    expect(raw.description).toMatch(/history/i);
    expect(feed.description).toMatch(/history/i);
  });

  it("routes 'show me my portfolio' to show_portfolio: it leads with when to use it and the text tool points to it", async () => {
    const { client } = await wired();
    const { tools } = await client.listTools();
    const show = tools.find((t) => t.name === "show_portfolio")!;
    const snapshot = tools.find((t) => t.name === "get_portfolio_snapshot")!;
    expect(show.description).toMatch(/^Use this when the user asks to (see|show)/);
    expect(show.description).toMatch(/portfolio/i);
    expect(snapshot.description).toContain("use show_portfolio");
  });

  it("show_activity returns structured content, the message and the compact copy", async () => {
    const { client } = await wired();
    const result = await client.callTool({ name: "show_activity", arguments: {} });
    expect(result.isError).not.toBe(true);
    const blocks = textBlocks(result);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain("Showing");
    expect(Array.isArray((result.structuredContent as any).rows)).toBe(true);
    expect(JSON.parse(blocks[1].text).rows).toBeUndefined();
  });

  it("get_activity_page has no Showing message; get_symbol_history and get_intraday have their texts", async () => {
    const { client } = await wired();
    const page = await client.callTool({ name: "get_activity_page", arguments: {} });
    expect(textBlocks(page)[0].text).not.toContain("Showing");
    const history = await client.callTool({ name: "get_symbol_history", arguments: { symbol: "vfv" } });
    expect(history.isError).not.toBe(true);
    expect(textBlocks(history)[0].text).toBe("Loaded VFV history: 0 trades.");
    const intraday = await client.callTool({ name: "get_intraday", arguments: {} });
    expect(intraday.isError).not.toBe(true);
    expect(textBlocks(intraday)[0].text).toBe("Loaded today's estimated intraday line.");
    expect((intraday.structuredContent as any).label).toBe("Estimated from live prices");
  });

  it("get_symbol_history and get_intraday give the model a compact copy without daily prices or points (I8)", async () => {
    const activity = activityDeps();
    const accountId = syntheticPortfolio().accounts[0].account.id;
    activity.activities.queryActivities = vi.fn(async (): Promise<any[]> => [
      { snapTradeAccountId: accountId, dedupeKey: "k1", type: "BUY", symbol: "VFV", securityCurrency: "CAD", isOption: false, units: 2, price: 100, amount: -200, fee: null, fxRate: null, currency: "CAD", tradeDate: "2026-01-05", settlementDate: "2026-01-05", description: null },
    ]);
    activity.market.securityHistory = vi.fn(async (): Promise<any> => ({ points: [{ date: "2026-01-02", close: 99 }, { date: "2026-02-02", close: 101 }], splits: [] }));
    const { client } = await wired({ activity });
    const history = await client.callTool({ name: "get_symbol_history", arguments: { symbol: "VFV" } });
    expect(textBlocks(history)[0].text).toBe("Loaded VFV history: 1 trade.");
    expect((history.structuredContent as any).prices).toHaveLength(2);
    const copy = JSON.parse(textBlocks(history)[1].text);
    expect(Object.keys(copy).sort()).toEqual(["avgCost", "avgCostEstimated", "costHistory", "currency", "dividends", "notes", "otherDividends", "period", "priceUnavailable", "reported", "reportedUnits", "symbol", "trades", "units"]);
    expect(copy).toMatchObject({ symbol: "VFV", currency: "CAD", period: "ALL", units: 2, avgCost: 100, trades: 1, priceUnavailable: false });
    expect(textBlocks(history)[1].text).not.toMatch(/prices|points|markers/);

    const intraday = await client.callTool({ name: "get_intraday", arguments: {} });
    const icopy = JSON.parse(textBlocks(intraday)[1].text);
    expect(Object.keys(icopy).sort()).toEqual(["coverage", "drawn", "points", "sessionDate"]);
    expect(typeof icopy.points).toBe("number");
  });

  it("adds the stale note", async () => {
    const { client, portfolio } = await wired();
    portfolio.getPortfolio.mockResolvedValueOnce({ ...syntheticPortfolio(), cache: { source: "cache", loadedAt: "2026-10-14T11:59:00.000Z", stale: true, staleReason: "provider_unavailable" } });
    expect(textBlocks(await client.callTool({ name: "get_activity_page", arguments: {} }))[0].text).toMatch(/stale data last read/);
  });

  it("an unknown account is an error result with guidance", async () => {
    const { client } = await wired();
    for (const [name, args] of [["show_activity", { accountId: "nope" }], ["get_activity_page", { accountId: "nope" }], ["get_symbol_history", { symbol: "VFV", accountId: "nope" }]] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(textBlocks(result)).toEqual([{ type: "text", text: "Unknown or excluded account. Use list_portfolio_accounts to pick an account." }]);
    }
  });

  it("accountType and accountId together are invalid params; a type with no account is an error result (activity)", async () => {
    const { client } = await wired();
    for (const name of ["show_activity", "get_activity_page"]) {
      const both = client.callTool({ name, arguments: { accountId: "MINI-SYNTHETIC-ACCOUNT-1", accountType: "tfsa" } });
      await expect(both).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(both).rejects.toThrow(/Give accountId or accountType, not both\./);
      const none = await client.callTool({ name, arguments: { accountType: "fhsa" } });
      expect(none.isError).toBe(true);
      expect(textBlocks(none)).toEqual([{ type: "text", text: "No connected FHSA accounts. Use list_portfolio_accounts to see what is connected." }]);
    }
    const typed = await client.callTool({ name: "show_activity", arguments: { accountType: "tfsa" } });
    expect(typed.isError).not.toBe(true);
    expect(textBlocks(typed)[0].text).toMatch(/^No investing activities in your TFSAs? from .*\. Showing the activity widget\.$/);
    expect((typed.structuredContent as any).filters).toMatchObject({ accountType: "tfsa" });
  });

  it("malformed input is invalid params", async () => {
    const { client } = await wired();
    await expect(client.callTool({ name: "show_activity", arguments: { extra: 1 } })).rejects.toThrow(/Invalid portfolio tool arguments/);
    await expect(client.callTool({ name: "get_symbol_history", arguments: {} })).rejects.toThrow(/Invalid portfolio tool arguments/);
  });

  it("registers no activity tools without the asset or dependencies, but keeps get_intraday", async () => {
    for (const over of [{ assets: assets(null) }, { activity: undefined }]) {
      const { client } = await wired(over);
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const n of ACTIVITY_TOOLS) expect(names).not.toContain(n);
      expect(names).toContain("get_intraday");
      expect((await client.listResources()).resources.map((r) => r.uri)).not.toContain("ui://portfolio/activity-v1");
      await expect(client.callTool({ name: "show_activity", arguments: {} })).rejects.toThrow();
    }
  });

  it("registers nothing when the overview is disabled", async () => {
      for (const over of [{ overview: undefined }]) {
      const { client } = await wired(over);
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const n of [...ACTIVITY_TOOLS, "get_intraday"]) expect(names).not.toContain(n);
      expect((await client.listResources()).resources.map((r) => r.uri)).not.toContain("ui://portfolio/activity-v1");
    }
  });
});

describe("holdings tools and resource", () => {
  const HOLD_HTML = "<!doctype html><title>holdings</title>";
  const OVERVIEW_HTML = "<!doctype html><title>overview</title>";
  const settings = { get: vi.fn(async () => ({ benchmark: "sp500", cadView: false, privacyDefault: false })), save: vi.fn() };
  const overviewDeps = () => ({
    market: { history: vi.fn(async (): Promise<any> => null), usdCad: vi.fn(async (): Promise<any> => null), quotes: vi.fn(async (): Promise<any> => new Map()) },
    settings,
    dailyValues: { rows: vi.fn(async (): Promise<any[]> => []), earliest: vi.fn(async (): Promise<string | null> => null) },
    now: () => new Date("2026-10-15T15:00:00Z"),
  });
  const holdingsDeps = () => ({
    market: { quotes: vi.fn(async (): Promise<any> => new Map()), usdCad: vi.fn(async (): Promise<any> => [{ date: "2026-10-14", close: 1.4 }]) },
    settings,
    now: () => new Date("2026-10-15T15:00:00Z"),
  });
  const assets = (holdings: string | null = HOLD_HTML) => ({ html: (name: string) => (name === "holdings" ? holdings : OVERVIEW_HTML) });
  const wired = (over: Record<string, unknown> = {}) => connect({ overview: overviewDeps() as never, holdings: holdingsDeps() as never, assets: assets(), ...over } as never);
  const HOLDINGS_TOOLS = ["show_holdings", "get_holdings"];

  it("lists the tools and resource and reads the static HTML at the hashed and legacy URIs", async () => {
    const { client } = await wired();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(HOLDINGS_TOOLS));
    const uri = widgetUri("holdings", HOLD_HTML);
    expect(tools.find((t) => t.name === "show_holdings")?._meta).toMatchObject({ ui: { resourceUri: uri }, "openai/outputTemplate": uri });
    expect(tools.find((t) => t.name === "get_holdings")?._meta).toMatchObject({ ui: { visibility: ["app"] } });
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).not.toContain("ui://portfolio/holdings-v1");
    expect(resources.find((r) => r.uri === uri)).toMatchObject({ name: "portfolio-holdings", mimeType: "text/html;profile=mcp-app" });
    expect(((await client.readResource({ uri })).contents[0] as { text: string }).text).toBe(HOLD_HTML);
    expect(((await client.readResource({ uri: "ui://portfolio/holdings-v1" })).contents[0] as { text: string }).text).toBe(HOLD_HTML);
  });

  it("show_holdings returns structured content, the message and the compact copy; get_holdings has no Showing message", async () => {
    const { client } = await wired();
    const result = await client.callTool({ name: "show_holdings", arguments: {} });
    expect(result.isError).not.toBe(true);
    const blocks = textBlocks(result);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain("Showing the holdings widget.");
    expect(Array.isArray((result.structuredContent as any).rows)).toBe(true);
    expect(Object.keys(result.structuredContent as object).sort()).toEqual(["accountValue", "accounts", "asOf", "currencies", "filters", "fx", "home", "omitted", "pricesAsOf", "rows", "settings", "totals"]);
    const copy = JSON.parse(blocks[1].text);
    expect(copy.rows).toBeUndefined();
    expect(copy.top.length).toBeGreaterThan(0);
    const page = await client.callTool({ name: "get_holdings", arguments: { sort: "symbol" } });
    expect(textBlocks(page)[0].text).not.toContain("Showing");
  });

  it("an unknown account is an error result; malformed input is invalid params", async () => {
    const { client } = await wired();
    for (const name of HOLDINGS_TOOLS) {
      const result = await client.callTool({ name, arguments: { accountId: "nope" } });
      expect(result.isError).toBe(true);
      expect(textBlocks(result)).toEqual([{ type: "text", text: "Unknown or excluded account. Use list_portfolio_accounts to pick an account." }]);
      await expect(client.callTool({ name, arguments: { extra: 1 } })).rejects.toThrow(/Invalid portfolio tool arguments/);
    }
  });

  it("accountType and accountId together are invalid params; a type with no account is an error result", async () => {
    const { client } = await wired();
    for (const name of HOLDINGS_TOOLS) {
      const both = client.callTool({ name, arguments: { accountId: "MINI-SYNTHETIC-ACCOUNT-1", accountType: "tfsa" } });
      await expect(both).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(both).rejects.toThrow(/Give accountId or accountType, not both\./);
      const none = await client.callTool({ name, arguments: { accountType: "fhsa" } });
      expect(none.isError).toBe(true);
      expect(textBlocks(none)).toEqual([{ type: "text", text: "No connected FHSA accounts. Use list_portfolio_accounts to see what is connected." }]);
    }
    const typed = await client.callTool({ name: "show_holdings", arguments: { accountType: "tfsa" } });
    expect(typed.isError).not.toBe(true);
    expect(textBlocks(typed)[0].text).toMatch(/^\d+ holdings? in your TFSAs /);
    expect((typed.structuredContent as any).filters).toMatchObject({ accountType: "tfsa" });
  });

  it("registers nothing without the asset or dependencies, with the overview off", async () => {
      for (const over of [{ assets: assets(null) }, { holdings: undefined }, { overview: undefined }]) {
      const { client } = await wired(over);
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const n of HOLDINGS_TOOLS) expect(names).not.toContain(n);
      expect((await client.listResources()).resources.map((r) => r.uri)).not.toContain("ui://portfolio/holdings-v1");
      await expect(client.callTool({ name: "show_holdings", arguments: {} })).rejects.toThrow();
    }
  });

  describe("with the live loader (holdings listed)", () => {
    const ORIGIN = "https://vestlens.example";
    const BUILT = '<!doctype html><head><script type="module" crossorigin>console.log(1)</script><style rel="stylesheet" crossorigin>a{}</style></head><body><div id="app"></div></body>';
    const builtAssets = (html: string) => ({ html: (name: string) => (name === "holdings" ? html : OVERVIEW_HTML) });
    const loaderFor = (html: string) => createWidgetLoader({ names: ["holdings"], origin: ORIGIN, assets: builtAssets(html) });
    const LOADER_HTML = widgetLoaderHtml("holdings", ORIGIN);
    const LOADER_URI = widgetLoaderUri("holdings", LOADER_HTML);

    it("points show_holdings at the loader URI, lists it, and serves the loader with the app origin as the only resource domain", async () => {
      const { client } = await wired({ assets: builtAssets(BUILT), widgetLoader: loaderFor(BUILT) });
      expect(LOADER_URI).toMatch(/^ui:\/\/portfolio\/holdings-loader1-[0-9a-f]{10}$/);
      const { tools } = await client.listTools();
      expect(tools.find((t) => t.name === "show_holdings")?._meta).toMatchObject({ ui: { resourceUri: LOADER_URI }, "openai/outputTemplate": LOADER_URI });
      const uris = (await client.listResources()).resources.map((r) => r.uri);
      expect(uris).toContain(LOADER_URI);
      expect(uris).not.toContain(widgetUri("holdings", BUILT));
      // The loader address, the inline hash of this build, an earlier deploy's hash and the legacy URI all serve the loader.
      for (const uri of [LOADER_URI, widgetUri("holdings", BUILT), "ui://portfolio/holdings-0ed970e3c6", "ui://portfolio/holdings-v1", "ui://portfolio/holdings-loader1-0123456789"]) {
        const content = (await client.readResource({ uri })).contents[0] as { uri: string; text: string; _meta: Record<string, unknown> };
        expect(content.uri, uri).toBe(uri);
        expect(content.text, uri).toBe(LOADER_HTML);
        expect(content._meta, uri).toMatchObject({
          ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [ORIGIN] } },
          "openai/widgetCSP": { connect_domains: [], resource_domains: [ORIGIN] },
        });
        expect((content._meta as any)["openai/widgetDescription"]).toBe("A read-only holdings table by symbol and currency with weight, return and day change.");
      }
      // Other widgets are unchanged.
      const overview = (await client.readResource({ uri: "ui://portfolio/overview-v5" })).contents[0] as { text: string; _meta: Record<string, unknown> };
      expect(overview.text).toBe(OVERVIEW_HTML);
      expect(overview._meta).toMatchObject({ ui: { csp: { connectDomains: [], resourceDomains: [] } } });
      expect((overview._meta as any)["openai/widgetCSP"]).toBeUndefined();
    });

    it("keeps the same loader URI across builds with different widget code", async () => {
      const other = BUILT.replace("console.log(1)", "console.log(2)");
      const a = await wired({ assets: builtAssets(BUILT), widgetLoader: loaderFor(BUILT) });
      const b = await wired({ assets: builtAssets(other), widgetLoader: loaderFor(other) });
      const meta = async (c: typeof a) => (await c.client.listTools()).tools.find((t) => t.name === "show_holdings")?._meta as any;
      expect((await meta(a)).ui.resourceUri).toBe((await meta(b)).ui.resourceUri);
    });

    it("stays inline (today's behaviour) when the loader disabled holdings or is absent", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const malformed = `${BUILT}<style>b{}</style>`;
        for (const over of [{ assets: builtAssets(malformed), widgetLoader: loaderFor(malformed) }, { assets: builtAssets(BUILT) }]) {
          const html = over.assets.html("holdings");
          const { client } = await wired(over);
          const uri = widgetUri("holdings", html);
          expect((await client.listTools()).tools.find((t) => t.name === "show_holdings")?._meta).toMatchObject({ ui: { resourceUri: uri } });
          const content = (await client.readResource({ uri: "ui://portfolio/holdings-v1" })).contents[0] as { text: string; _meta: Record<string, unknown> };
          expect(content.text).toBe(html);
          expect(content._meta).toMatchObject({ ui: { csp: { connectDomains: [], resourceDomains: [] } } });
          expect((content._meta as any)["openai/widgetCSP"]).toBeUndefined();
          // A host holding a loader address after a rollback gets the inline HTML.
          expect(((await client.readResource({ uri: LOADER_URI })).contents[0] as { text: string }).text).toBe(html);
        }
      } finally {
        warn.mockRestore();
      }
    });

  });
});

describe("news tools and resource", () => {
  const NEWS_HTML = "<!doctype html><title>news</title>";
  const OVERVIEW_HTML = "<!doctype html><title>overview</title>";
  const settings = { get: vi.fn(async () => ({ benchmark: "sp500", cadView: false, privacyDefault: false })), save: vi.fn() };
  const overviewDeps = () => ({
    market: { history: vi.fn(async (): Promise<any> => null), usdCad: vi.fn(async (): Promise<any> => null), quotes: vi.fn(async (): Promise<any> => new Map()) },
    settings,
    dailyValues: { rows: vi.fn(async (): Promise<any[]> => []), earliest: vi.fn(async (): Promise<string | null> => null) },
    now: () => new Date("2026-10-21T20:00:00Z"),
  });
  const newsDeps = () => ({
    store: new MemoryNewsStore(),
    market: { quotes: vi.fn(async (): Promise<any> => new Map()), history: vi.fn(async (): Promise<any> => null), profile: vi.fn(async (): Promise<any> => null) },
    settings,
    budget: 90,
    publicOrigin: "https://portfolio.example.invalid",
    now: () => new Date("2026-10-21T20:00:00Z"),
  });
  const assets = (news: string | null = NEWS_HTML) => ({ html: (name: string) => (name === "news" ? news : OVERVIEW_HTML) });
  const wired = (over: Record<string, unknown> = {}) => connect({ overview: overviewDeps() as never, news: newsDeps() as never, assets: assets(), ...over } as never);
  const NEWS_TOOLS = ["show_news", "get_news"];

  it("lists the tools and resource; the resource allows images from this server's own origin only", async () => {
    const { client } = await wired();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(NEWS_TOOLS));
    const uri = widgetUri("news", NEWS_HTML);
    expect(tools.find((t) => t.name === "show_news")?._meta).toMatchObject({ ui: { resourceUri: uri }, "openai/outputTemplate": uri });
    expect(tools.find((t) => t.name === "get_news")?._meta).toMatchObject({ ui: { visibility: ["app"] } });
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).not.toContain("ui://portfolio/news-v1");
    expect(resources.find((r) => r.uri === uri)).toMatchObject({ name: "portfolio-news", mimeType: "text/html;profile=mcp-app" });
    for (const u of [uri, "ui://portfolio/news-v1"]) {
      const content = (await client.readResource({ uri: u })).contents[0] as { text: string; _meta: any };
      expect(content.text).toBe(NEWS_HTML);
      expect(content._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: ["https://portfolio.example.invalid"] });
    }
  });

  it("show_news returns the payload, the message and the compact copy; get_news has no Showing message", async () => {
    const { client } = await wired();
    const result = await client.callTool({ name: "show_news", arguments: {} });
    expect(result.isError).not.toBe(true);
    const blocks = textBlocks(result);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain("Showing the news widget.");
    expect(blocks[0].text).toContain("not investment advice");
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "show_news")!.outputSchema as any;
    expect(Object.keys(result.structuredContent as object).sort()).toEqual([...schema.required].sort());
    const copy = JSON.parse(blocks[1].text);
    expect(copy.notes.ratings).toContain("AI-rated");
    const page = await client.callTool({ name: "get_news", arguments: { window: "24h" } });
    expect(textBlocks(page)[0].text).not.toContain("Showing");
    expect((page.structuredContent as any).window).toBe("24h");
  });

  it("an unknown account or symbol is an error result; malformed input is invalid params", async () => {
    const { client } = await wired();
    for (const name of NEWS_TOOLS) {
      const result = await client.callTool({ name, arguments: { accountId: "nope" } });
      expect(result.isError).toBe(true);
      expect(textBlocks(result)).toEqual([{ type: "text", text: "Unknown or excluded account. Use list_portfolio_accounts to pick an account." }]);
      const sym = await client.callTool({ name, arguments: { symbol: "ZZNOPE" } });
      if (name === "show_news") {
        // show_news never errors on an unheld symbol: an unfiltered view that says so.
        expect(sym.isError).toBeFalsy();
        expect((sym.structuredContent as any).filters.symbolNotHeld).toBe("ZZNOPE");
        expect(textBlocks(sym)[0].text).toContain("ZZNOPE isn't in your holdings; showing all.");
      } else {
        expect(sym.isError).toBe(true);
        expect(textBlocks(sym)[0].text).toBe("That symbol is not a stock or ETF holding in this scope.");
      }
      await expect(client.callTool({ name, arguments: { extra: 1 } })).rejects.toThrow(/Invalid portfolio tool arguments/);
    }
  });

  it("registers nothing without the asset or dependencies, with the overview off", async () => {
      for (const over of [{ assets: assets(null) }, { news: undefined }, { overview: undefined }]) {
      const { client } = await wired(over);
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const n of NEWS_TOOLS) expect(names).not.toContain(n);
      expect((await client.listResources()).resources.map((r) => r.uri)).not.toContain(widgetUri("news", NEWS_HTML));
      await expect(client.readResource({ uri: "ui://portfolio/news-v1" })).rejects.toThrow();
      await expect(client.callTool({ name: "show_news", arguments: {} })).rejects.toThrow();
    }
  });
});

describe("calendar and alerts tools", () => {
  const CAL_HTML = "<!doctype html><title>calendar</title>";
  const OVERVIEW_HTML = "<!doctype html><title>overview</title>";
  const NOW = new Date("2026-10-21T20:00:00Z");
  const settings = { get: vi.fn(async () => ({ benchmark: "sp500", cadView: false, privacyDefault: false })), save: vi.fn() };
  const overviewDeps = () => ({
    market: { history: vi.fn(async (): Promise<any> => null), usdCad: vi.fn(async (): Promise<any> => null), quotes: vi.fn(async (): Promise<any> => new Map()) },
    settings,
    dailyValues: { rows: vi.fn(async (): Promise<any[]> => []), earliest: vi.fn(async (): Promise<string | null> => null) },
    now: () => NOW,
  });
  const store = new MemoryNewsStore();
  const calendarDeps = () => ({ store, settings, now: () => NOW });
  const alertsDeps = () => ({ store, market: { quotes: vi.fn(async (): Promise<any> => new Map()) }, appUserId: vi.fn(async () => "00000000-0000-4000-8000-0000000000aa"), now: () => NOW });
  const assets = (calendar: string | null = CAL_HTML) => ({ html: (name: string) => (name === "calendar" ? calendar : OVERVIEW_HTML) });
  const wired = (over: Record<string, unknown> = {}) =>
    connect({ overview: overviewDeps() as never, calendar: calendarDeps() as never, alerts: alertsDeps() as never, clientKey: "client-a", assets: assets(), ...over } as never);
  const CAL_TOOLS = ["show_calendar", "get_calendar"];

  it("lists show_calendar (widget), app-only get_calendar, the resource, and model-visible get_portfolio_alerts", async () => {
    const { client } = await wired();
    const { tools } = await client.listTools();
    const uri = widgetUri("calendar", CAL_HTML);
    expect(tools.find((t) => t.name === "show_calendar")?._meta).toMatchObject({ ui: { resourceUri: uri }, "openai/outputTemplate": uri });
    expect(tools.find((t) => t.name === "get_calendar")?._meta).toMatchObject({ ui: { visibility: ["app"] } });
    const alerts = tools.find((t) => t.name === "get_portfolio_alerts")!;
    expect(alerts.annotations).toMatchObject({ readOnlyHint: true });
    expect(JSON.stringify(alerts._meta ?? {})).not.toContain("visibility");
    const { resources } = await client.listResources();
    expect(resources.find((r) => r.uri === uri)).toMatchObject({ name: "portfolio-calendar", mimeType: "text/html;profile=mcp-app" });
    for (const u of [uri, "ui://portfolio/calendar-v1"]) {
      const content = (await client.readResource({ uri: u })).contents[0] as { text: string; _meta: any };
      expect(content.text).toBe(CAL_HTML);
      expect(content._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [] });
    }
  });

  it("show_calendar returns the payload with its message; get_calendar has none; unknown accounts are errors", async () => {
    const { client } = await wired();
    const result = await client.callTool({ name: "show_calendar", arguments: {} });
    expect(result.isError).not.toBe(true);
    const blocks = textBlocks(result);
    expect(blocks[0].text).toContain("Showing the calendar widget.");
    expect(JSON.parse(blocks[1].text).notes.estimates).toContain("est.");
    const page = await client.callTool({ name: "get_calendar", arguments: { range: "3m" } });
    expect(textBlocks(page)[0].text).not.toContain("Showing");
    expect((page.structuredContent as any).range).toBe("3m");
    const bad = await client.callTool({ name: "get_calendar", arguments: { accountId: "nope" } });
    expect(textBlocks(bad)).toEqual([{ type: "text", text: "Unknown or excluded account. Use list_portfolio_accounts to pick an account." }]);
    await expect(client.callTool({ name: "show_calendar", arguments: { range: "1y" } })).rejects.toThrow(/Invalid portfolio tool arguments/);
  });

  it("get_portfolio_alerts ledgers per client key: each client once, then quiet", async () => {
    const shared = new MemoryNewsStore();
    await shared.putEvents([{ id: "earnings:SYNTHETIC1:2026-10-22", symbol: "SYNTHETIC1", kind: "earnings", date: new Date("2026-10-22T00:00:00Z"), status: "expected", source: "edgar", amountPerUnit: null, currency: null }]);
    const deps = { ...alertsDeps(), store: shared };
    const call = async (clientKey: string) => {
      const { client } = await wired({ alerts: deps, clientKey });
      return client.callTool({ name: "get_portfolio_alerts", arguments: {} });
    };
    const a = await call("client-a");
    const sc = a.structuredContent as any;
    expect(Object.keys(sc).sort()).toEqual(["alerts", "generatedAt", "next", "quiet", "since"]);
    expect(sc.quiet).toBe(false);
    expect(JSON.parse(textBlocks(a)[1].text)).toEqual(sc);
    expect(((await call("client-b")).structuredContent as any).quiet).toBe(false);
    const again = await call("client-a");
    expect((again.structuredContent as any).quiet).toBe(true);
    expect(textBlocks(again)[0].text).toBe("Nothing material since the last check. Informational, not advice.");
    await expect((await wired({ alerts: deps })).client.callTool({ name: "get_portfolio_alerts", arguments: { since: "soon" } })).rejects.toThrow(/Invalid portfolio tool arguments/);
  });

  it("registers nothing without the asset or dependencies, with the overview off", async () => {
      for (const over of [{ assets: assets(null) }, { calendar: undefined }, { overview: undefined }]) {
      const { client } = await wired(over);
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const n of CAL_TOOLS) expect(names).not.toContain(n);
      await expect(client.readResource({ uri: "ui://portfolio/calendar-v1" })).rejects.toThrow();
    }
    for (const over of [{ alerts: undefined }, { overview: undefined }]) {
      const { client } = await wired(over);
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("get_portfolio_alerts");
      await expect(client.callTool({ name: "get_portfolio_alerts", arguments: {} })).rejects.toThrow();
    }
  });
});

describe("allocation tools and resource", () => {
  const ALLOC_HTML = "<!doctype html><title>allocation</title>";
  const OVERVIEW_HTML = "<!doctype html><title>overview</title>";
  const settings = { get: vi.fn(async () => ({ benchmark: "sp500", cadView: false, privacyDefault: false })), save: vi.fn() };
  const overviewDeps = () => ({
    market: { history: vi.fn(async (): Promise<any> => null), usdCad: vi.fn(async (): Promise<any> => null), quotes: vi.fn(async (): Promise<any> => new Map()) },
    settings,
    dailyValues: { rows: vi.fn(async (): Promise<any[]> => []), earliest: vi.fn(async (): Promise<string | null> => null) },
    now: () => new Date("2026-10-15T15:00:00Z"),
  });
  const allocationDeps = () => ({
    market: { usdCad: vi.fn(async (): Promise<any> => [{ date: "2026-10-14", close: 1.4 }]), profile: vi.fn(async (): Promise<any> => null) },
    settings,
    now: () => new Date("2026-10-15T15:00:00Z"),
  });
  const assets = (allocation: string | null = ALLOC_HTML) => ({ html: (name: string) => (name === "allocation" ? allocation : OVERVIEW_HTML) });
  const wired = (over: Record<string, unknown> = {}) => connect({ overview: overviewDeps() as never, allocation: allocationDeps() as never, assets: assets(), ...over } as never);
  const ALLOCATION_TOOLS = ["show_allocation", "get_allocation"];

  it("lists the tools and resource and reads the static HTML at the hashed and legacy URIs", async () => {
    const { client } = await wired();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(ALLOCATION_TOOLS));
    const uri = widgetUri("allocation", ALLOC_HTML);
    expect(tools.find((t) => t.name === "show_allocation")?._meta).toMatchObject({ ui: { resourceUri: uri }, "openai/outputTemplate": uri });
    expect(tools.find((t) => t.name === "get_allocation")?._meta).toMatchObject({ ui: { visibility: ["app"] } });
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).not.toContain("ui://portfolio/allocation-v1");
    expect(resources.find((r) => r.uri === uri)).toMatchObject({ name: "portfolio-allocation", mimeType: "text/html;profile=mcp-app" });
    expect(((await client.readResource({ uri })).contents[0] as { text: string }).text).toBe(ALLOC_HTML);
    expect(((await client.readResource({ uri: "ui://portfolio/allocation-v1" })).contents[0] as { text: string }).text).toBe(ALLOC_HTML);
  });

  it("show_allocation returns structured content, the message and the compact copy; get_allocation has no Showing message", async () => {
    const { client } = await wired();
    const result = await client.callTool({ name: "show_allocation", arguments: {} });
    expect(result.isError).not.toBe(true);
    const blocks = textBlocks(result);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain("Showing the allocation widget.");
    expect(Object.keys(result.structuredContent as object).sort()).toEqual(["accounts", "asOf", "concentration", "dimension", "estimated", "excludedCurrencies", "filters", "fx", "home", "overlap", "settings", "slices", "unclassifiedFraction", "unvalued", "usdExcluded"]);
    const copy = JSON.parse(blocks[1].text);
    expect(copy.slices).toBeDefined();
    expect(copy.dimension).toBe("assetClass");
    const page = await client.callTool({ name: "get_allocation", arguments: { dimension: "currency" } });
    expect(textBlocks(page)[0].text).not.toContain("Showing");
  });

  it("an unknown account is an error result; malformed input is invalid params", async () => {
    const { client } = await wired();
    for (const name of ALLOCATION_TOOLS) {
      const result = await client.callTool({ name, arguments: { accountId: "nope" } });
      expect(result.isError).toBe(true);
      expect(textBlocks(result)).toEqual([{ type: "text", text: "Unknown or excluded account. Use list_portfolio_accounts to pick an account." }]);
      await expect(client.callTool({ name, arguments: { dimension: "colour" } })).rejects.toThrow(/Invalid portfolio tool arguments/);
    }
  });

  it("accountType and accountId together are invalid params; a type with no account is an error result", async () => {
    const { client } = await wired();
    for (const name of ALLOCATION_TOOLS) {
      const both = client.callTool({ name, arguments: { accountId: "MINI-SYNTHETIC-ACCOUNT-1", accountType: "tfsa" } });
      await expect(both).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(both).rejects.toThrow(/Give accountId or accountType, not both\./);
      const none = await client.callTool({ name, arguments: { accountType: "fhsa" } });
      expect(none.isError).toBe(true);
      expect(textBlocks(none)).toEqual([{ type: "text", text: "No connected FHSA accounts. Use list_portfolio_accounts to see what is connected." }]);
    }
    const typed = await client.callTool({ name: "show_allocation", arguments: { accountType: "tfsa" } });
    expect(typed.isError).not.toBe(true);
    expect(textBlocks(typed)[0].text).toMatch(/^Largest asset class in your TFSAs?: /);
    expect((typed.structuredContent as any).filters).toMatchObject({ accountType: "tfsa" });
  });

  it("registers nothing without the asset or dependencies, with the overview off", async () => {
      for (const over of [{ assets: assets(null) }, { allocation: undefined }, { overview: undefined }]) {
      const { client } = await wired(over);
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const n of ALLOCATION_TOOLS) expect(names).not.toContain(n);
      expect((await client.listResources()).resources.map((r) => r.uri)).not.toContain("ui://portfolio/allocation-v1");
      await expect(client.callTool({ name: "show_allocation", arguments: {} })).rejects.toThrow();
    }
  });
});

describe("income tools and resource", () => {
  const INCOME_HTML = "<!doctype html><title>income</title>";
  const OVERVIEW_HTML = "<!doctype html><title>overview</title>";
  const settings = { get: vi.fn(async () => ({ benchmark: "sp500", cadView: false, privacyDefault: false })), save: vi.fn() };
  const overviewDeps = () => ({
    market: { history: vi.fn(async (): Promise<any> => null), usdCad: vi.fn(async (): Promise<any> => null), quotes: vi.fn(async (): Promise<any> => new Map()) },
    settings,
    dailyValues: { rows: vi.fn(async (): Promise<any[]> => []), earliest: vi.fn(async (): Promise<string | null> => null) },
    now: () => new Date("2026-10-15T15:00:00Z"),
  });
  const incomeDeps = () => ({
    activities: { userId: vi.fn(async (): Promise<string | null> => null), syncState: vi.fn(async (): Promise<any> => null), queryActivities: vi.fn(async (): Promise<any[]> => []) },
    settings,
    now: () => new Date("2026-10-15T15:00:00Z"),
  });
  const assets = (income: string | null = INCOME_HTML) => ({ html: (name: string) => (name === "income" ? income : OVERVIEW_HTML) });
  const wired = (over: Record<string, unknown> = {}) => connect({ overview: overviewDeps() as never, income: incomeDeps() as never, assets: assets(), ...over } as never);
  const INCOME_TOOLS = ["show_income", "get_income"];

  it("lists the tools and resource and reads the static HTML at the hashed and legacy URIs", async () => {
    const { client } = await wired();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(INCOME_TOOLS));
    const uri = widgetUri("income", INCOME_HTML);
    expect(tools.find((t) => t.name === "show_income")?._meta).toMatchObject({ ui: { resourceUri: uri }, "openai/outputTemplate": uri });
    expect(tools.find((t) => t.name === "get_income")?._meta).toMatchObject({ ui: { visibility: ["app"] } });
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).not.toContain("ui://portfolio/income-v1");
    expect(resources.find((r) => r.uri === uri)).toMatchObject({ name: "portfolio-income", mimeType: "text/html;profile=mcp-app" });
    expect(((await client.readResource({ uri })).contents[0] as { text: string }).text).toBe(INCOME_HTML);
    expect(((await client.readResource({ uri: "ui://portfolio/income-v1" })).contents[0] as { text: string }).text).toBe(INCOME_HTML);
  });

  it("show_income returns structured content, the message and the compact copy; get_income has no Showing message", async () => {
    const { client } = await wired();
    const result = await client.callTool({ name: "show_income", arguments: {} });
    expect(result.isError).not.toBe(true);
    const blocks = textBlocks(result);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain("Showing the income widget.");
    expect(Object.keys(result.structuredContent as object).sort()).toEqual(["accounts", "asOf", "contributions", "currencyTotals", "filters", "months", "settings", "syncing", "topPayers", "withholding", "year", "years", "yields"]);
    expect(JSON.parse(blocks[1].text).note).toBe("Estimates for information only, not tax or investment advice.");
    const page = await client.callTool({ name: "get_income", arguments: { year: 2025 } });
    expect(textBlocks(page)[0].text).not.toContain("Showing");
  });

  it("an unknown account is an error result; malformed input is invalid params", async () => {
    const { client } = await wired();
    for (const name of INCOME_TOOLS) {
      const result = await client.callTool({ name, arguments: { accountId: "nope" } });
      expect(result.isError).toBe(true);
      expect(textBlocks(result)).toEqual([{ type: "text", text: "Unknown or excluded account. Use list_portfolio_accounts to pick an account." }]);
      await expect(client.callTool({ name, arguments: { year: "x" } })).rejects.toThrow(/Invalid portfolio tool arguments/);
    }
  });

  it("accountType and accountId together are invalid params; a type with no account is an error result", async () => {
    const { client } = await wired();
    for (const name of INCOME_TOOLS) {
      const both = client.callTool({ name, arguments: { accountId: "MINI-SYNTHETIC-ACCOUNT-1", accountType: "tfsa" } });
      await expect(both).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(both).rejects.toThrow(/Give accountId or accountType, not both\./);
      const none = await client.callTool({ name, arguments: { accountType: "fhsa" } });
      expect(none.isError).toBe(true);
      expect(textBlocks(none)).toEqual([{ type: "text", text: "No connected FHSA accounts. Use list_portfolio_accounts to see what is connected." }]);
    }
    const typed = await client.callTool({ name: "show_income", arguments: { accountType: "tfsa", symbol: "xeqt" } });
    expect(typed.isError).not.toBe(true);
    expect(textBlocks(typed)[0].text).toMatch(/^No dividends from XEQT recorded for 2026 in your TFSAs?\./);
    expect((typed.structuredContent as any).filters).toMatchObject({ accountType: "tfsa", symbol: "XEQT" });
  });

  it("registers nothing without the asset or dependencies, with the overview off", async () => {
      for (const over of [{ assets: assets(null) }, { income: undefined }, { overview: undefined }]) {
      const { client } = await wired(over);
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const n of INCOME_TOOLS) expect(names).not.toContain(n);
      expect((await client.listResources()).resources.map((r) => r.uri)).not.toContain("ui://portfolio/income-v1");
      await expect(client.callTool({ name: "show_income", arguments: {} })).rejects.toThrow();
    }
  });
});

describe("live loader for all eight widgets (all listed)", () => {
  const ORIGIN = "https://vestlens.example";
  const EIGHT = ["overview", "performance", "activity", "holdings", "allocation", "income", "news", "calendar"] as const;
  type Name = (typeof EIGHT)[number];
  const SHOW_TOOL: Record<Name, string> = {
    overview: "show_portfolio", performance: "show_performance", activity: "show_activity", holdings: "show_holdings",
    allocation: "show_allocation", income: "show_income", news: "show_news", calendar: "show_calendar",
  };
  const TITLE: Record<Name, string> = {
    overview: "Portfolio overview", performance: "Portfolio performance", activity: "Portfolio activity", holdings: "Portfolio holdings",
    allocation: "Portfolio allocation", income: "Portfolio income", news: "Portfolio news", calendar: "Portfolio calendar",
  };
  const built = (name: string) => `<!doctype html><head><script type="module" crossorigin>console.log(${JSON.stringify(name)})</script><style rel="stylesheet" crossorigin>.${name}{}</style></head><body><div id="app"></div></body>`;
  const assets = { html: (name: string) => built(name) };
  // Tool and resource registration only needs the dependencies to be present; no tool is called here.
  const deps = { overview: {}, performance: {}, activity: {}, holdings: {}, allocation: {}, income: {}, news: { publicOrigin: ORIGIN }, calendar: {}, alerts: {} };
  const wiredAll = (over: Record<string, unknown> = {}) => connect({ ...deps, assets, ...over } as never);
  const loaderFor = (names: readonly Name[]) => createWidgetLoader({ names, origin: ORIGIN, assets });
  const loaderUri = (name: Name) => widgetLoaderUri(name, widgetLoaderHtml(name, ORIGIN));
  const read = async (client: Client, uri: string) => (await client.readResource({ uri })).contents[0] as { uri: string; text: string; _meta: Record<string, any> };

  it("every tool that renders a widget points at that widget's loader URI", async () => {
    const off = await wiredAll();
    const on = await wiredAll({ widgetLoader: loaderFor(EIGHT) });
    const offTools = (await off.client.listTools()).tools;
    const onTools = (await on.client.listTools()).tools;
    expect(onTools.map((t) => t.name)).toEqual(offTools.map((t) => t.name));
    let rendering = 0;
    for (const tool of offTools) {
      const before = (tool._meta as any)?.ui?.resourceUri as string | undefined;
      const after = onTools.find((t) => t.name === tool.name)!._meta as any;
      if (!before) { expect(after?.ui?.resourceUri, tool.name).toBeUndefined(); continue; }
      const name = EIGHT.find((n) => before === widgetUri(n, built(n)));
      expect(name, tool.name).toBeDefined();
      expect(after, tool.name).toMatchObject({ ui: { resourceUri: loaderUri(name!) }, "openai/outputTemplate": loaderUri(name!) });
      rendering += 1;
    }
    expect(rendering).toBe(EIGHT.length);
    for (const name of EIGHT) {
      expect(onTools.find((t) => t.name === SHOW_TOOL[name])?._meta, name).toMatchObject({ ui: { resourceUri: loaderUri(name) }, "openai/outputTemplate": loaderUri(name) });
    }
  });

  it.each(EIGHT)("%s: lists the loader URI and serves the loader with the app origin at the loader URI and every earlier alias", async (name) => {
    const off = await wiredAll();
    const { client } = await wiredAll({ widgetLoader: loaderFor(EIGHT) });
    const uri = loaderUri(name);
    const resources = (await client.listResources()).resources;
    const offResources = (await off.client.listResources()).resources;
    const listed = resources.find((r) => r.uri === uri);
    const offListed = offResources.find((r) => r.uri === widgetUri(name, built(name)))!;
    expect(listed).toEqual({ ...offListed, uri });
    expect(resources.map((r) => r.uri)).not.toContain(widgetUri(name, built(name)));
    const inline = await read(off.client, widgetUri(name, built(name)));
    const legacy = { overview: "ui://portfolio/overview-v5" }[name as string] ?? `ui://portfolio/${name}-v1`;
    for (const alias of [uri, widgetUri(name, built(name)), `ui://portfolio/${name}-0ed970e3c6`, legacy, `ui://portfolio/${name}-loader1-0123456789`]) {
      const content = await read(client, alias);
      expect(content.uri, alias).toBe(alias);
      expect(content.text, alias).toBe(widgetLoaderHtml(name, ORIGIN));
      expect(content.text, alias).toContain(`<title>${TITLE[name]}</title>`);
      expect(content.text, alias).toContain(`${ORIGIN}/widgets/${name}.js`);
      const { ui, ...rest } = content._meta;
      const { ui: inlineUi, ...inlineRest } = inline._meta;
      expect(ui, alias).toEqual({ ...inlineUi, csp: { connectDomains: [], resourceDomains: [ORIGIN] } });
      expect(rest, alias).toEqual({ ...inlineRest, "openai/widgetCSP": { connect_domains: [], resource_domains: [ORIGIN] } });
    }
  });

  it("the news loader's resource domains are exactly the loader origin, never a different news publicOrigin", async () => {
    const OTHER = "https://images.other.example";
    const { client } = await wiredAll({ news: { publicOrigin: OTHER }, widgetLoader: loaderFor(EIGHT) });
    const content = await read(client, loaderUri("news"));
    expect(content._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [ORIGIN] });
    expect(content._meta["openai/widgetCSP"]).toEqual({ connect_domains: [], resource_domains: [ORIGIN] });
    expect(JSON.stringify(content)).not.toContain(OTHER);
  });

  it("a partial list moves only the listed widgets; the others stay inline", async () => {
    const { client } = await wiredAll({ widgetLoader: loaderFor(["news", "overview"]) });
    const tools = (await client.listTools()).tools;
    for (const name of EIGHT) {
      const expected = name === "news" || name === "overview" ? loaderUri(name) : widgetUri(name, built(name));
      expect((tools.find((t) => t.name === SHOW_TOOL[name])?._meta as any).ui.resourceUri, name).toBe(expected);
      const content = await read(client, expected);
      expect(content.text, name).toBe(name === "news" || name === "overview" ? widgetLoaderHtml(name, ORIGIN) : built(name));
    }
  });

  it("with the flag off every widget serves its inline build at its loader address (rollback)", async () => {
    for (const over of [{}, { widgetLoader: loaderFor([]) }]) {
      const { client } = await wiredAll(over);
      for (const name of EIGHT) {
        expect(((await client.listTools()).tools.find((t) => t.name === SHOW_TOOL[name])?._meta as any).ui.resourceUri, name).toBe(widgetUri(name, built(name)));
      }
    }
    const { client } = await wiredAll({ widgetLoader: loaderFor([]) });
    for (const name of EIGHT) {
      const content = await read(client, loaderUri(name));
      expect(content.text, name).toBe(built(name));
      expect(content._meta["openai/widgetCSP"], name).toBeUndefined();
    }
  });

});

describe("loader-off snapshot (no widget listed)", () => {
  // Synthetic builds and stub dependencies: registration only, no tool is called. The fixture was
  // generated from the pre-refactor commit b3f1944, so it pins today's flag-off output byte for byte.
  const SNAPSHOT_ORIGIN = "https://vestlens.example";
  const SNAPSHOT_WIDGETS = ["overview", "performance", "activity", "holdings", "allocation", "income", "news", "calendar"];
  const LEGACY: Record<string, string> = {
    overview: "ui://portfolio/overview-v5", performance: "ui://portfolio/performance-v1", activity: "ui://portfolio/activity-v1",
    holdings: "ui://portfolio/holdings-v1", allocation: "ui://portfolio/allocation-v1", income: "ui://portfolio/income-v1",
    news: "ui://portfolio/news-v1", calendar: "ui://portfolio/calendar-v1",
  };
  const snapshotBuild = (name: string) => `<!doctype html><head><script type="module" crossorigin>console.log(${JSON.stringify(name)})</script><style rel="stylesheet" crossorigin>.${name}{}</style></head><body><div id="app"></div></body>`;
  // memory and room (Task 4) only add remember, recall, forget, get_contribution_room and the TFSA room resource.
  // portfolioFacts (theses, limits and goals, Task 5) only adds log_thesis, show_thesis, set_portfolio_limit,
  // show_limits, set_savings_goal, show_goal, the thesis, limits and goal resources, and one instructions sentence.
  const snapshotDeps = { overview: {}, performance: {}, activity: {}, holdings: {}, allocation: {}, income: {}, news: { publicOrigin: SNAPSHOT_ORIGIN }, calendar: {}, alerts: {}, memory: {}, room: {}, portfolioFacts: {} };

  async function dump(over: Record<string, unknown> = {}) {
    const { client } = await connect({ ...snapshotDeps, assets: { html: snapshotBuild }, ...over } as never);
    const tools = await client.listTools();
    const resources = await client.listResources();
    const uris = [
      ...resources.resources.map((r) => r.uri),
      ...SNAPSHOT_WIDGETS.flatMap((name) => [`ui://portfolio/${name}-0ed970e3c6`, LEGACY[name]]),
      "ui://portfolio/unknown-widget",
    ];
    const reads: Record<string, unknown> = {};
    for (const uri of uris) {
      try { reads[uri] = await client.readResource({ uri }); } catch (error) { reads[uri] = { error: String(error) }; }
    }
    return `${JSON.stringify({ tools, resources, reads, instructions: client.getInstructions() }, null, 2)}\n`;
  }

  it("tools/list, resources/list and resources/read match the committed fixture", async () => {
    await expect(await dump()).toMatchFileSnapshot("./__fixtures__/portfolio-mcp-flag-off.json");
  });

  it("is the same with a loader that lists no widget (a loader that serves builds only)", async () => {
    const loader = createWidgetLoader({ names: [], origin: SNAPSHOT_ORIGIN, assets: { html: snapshotBuild } });
    await expect(await dump({ widgetLoader: loader })).toMatchFileSnapshot("./__fixtures__/portfolio-mcp-flag-off.json");
  });
});

describe("model-facing names at the MCP level (review M5)", () => {
  const renamed = (p: Record<string, unknown>) => {
    expect(p).toHaveProperty("calculatedMarketValue");
    expect(p).toHaveProperty("costBasisPerUnit");
    for (const old of ["costBasis", "marketValue", "unrealizedGain"]) expect(p).not.toHaveProperty(old);
  };
  it("legacy show_portfolio structuredContent and its model copy carry the renamed position fields", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "show_portfolio", arguments: {} });
    renamed((result.structuredContent as any).accounts[0].positions[0]);
    renamed(JSON.parse(textBlocks(result)[1].text).accounts[0].positions[0]);
  });
  it("get_account_history analytics expose the labelled keys", async () => {
    const analytics = summarizeAccountHistory({
      orders: [], activities: [{ type: "DIVIDEND", currency: "CAD", amount: 5 } as never],
      balanceHistory: { currency: "CAD", points: [{ date: "2026-08-01", totalValue: 100 }, { date: "2026-08-02", totalValue: 110 }] },
    });
    const history = { getAccountHistory: vi.fn(async () => ({ accountId: "A", generatedAt: "2026-10-14T12:00:00.000Z", orders: [], activities: { items: [] }, balanceHistory: {}, analytics, freshness: {}, errors: [] })) };
    const { client } = await connect({ history } as never);
    const result = await client.callTool({ name: "get_account_history", arguments: { accountId: "A" } });
    const a = (result.structuredContent as any).analytics;
    expect(Object.keys(a).sort()).toEqual(["balanceChangeIncludingDeposits", "note", "orderStatusCounts", "pageActivityTotals"]);
    expect(a.balanceChangeIncludingDeposits).toMatchObject({ estimated: true, includesDeposits: true });
    expect(a.pageActivityTotals[0]).toMatchObject({ type: "DIVIDEND", amountBasis: "gross" });
  });
});

describe("per-subject tool rate limits", () => {
  const LIMITED = "Too many requests; try again in a minute.";
  const OVERVIEW_HTML = "<!doctype html><title>overview</title>";
  const settings = { get: vi.fn(async () => ({ benchmark: "sp500", cadView: false, privacyDefault: false })), save: vi.fn() };
  const overviewDeps = () => ({
    market: { history: vi.fn(async (): Promise<any> => null), usdCad: vi.fn(async (): Promise<any> => null), quotes: vi.fn(async (): Promise<any> => new Map()) },
    settings,
    dailyValues: { rows: vi.fn(async (): Promise<any[]> => []), earliest: vi.fn(async (): Promise<string | null> => null) },
    now: () => new Date("2026-10-21T20:00:00Z"),
  });
  const holdingsDeps = () => ({
    market: { quotes: vi.fn(async (): Promise<any> => new Map()), usdCad: vi.fn(async (): Promise<any> => [{ date: "2026-10-14", close: 1.4 }]) },
    settings,
    now: () => new Date("2026-10-21T20:00:00Z"),
  });
  const newsDeps = () => ({
    store: new MemoryNewsStore(),
    market: { quotes: vi.fn(async (): Promise<any> => new Map()), history: vi.fn(async (): Promise<any> => null), profile: vi.fn(async (): Promise<any> => null) },
    settings,
    budget: 90,
    publicOrigin: "https://portfolio.example.invalid",
    now: () => new Date("2026-10-21T20:00:00Z"),
  });
  const clock = () => { let t = Date.parse("2026-10-21T20:00:00Z"); return { now: () => new Date(t), advance: (ms: number) => { t += ms; } }; };

  it("the 61st call in a minute is an isError result with the exact text, never a thrown error", async () => {
    const c = clock();
    const toolLimiter = toolRateLimiter({ now: c.now });
    const { client, portfolio } = await connect({ toolLimiter } as never);
    for (let i = 0; i < 60; i++) {
      const ok = await client.callTool({ name: "list_portfolio_accounts", arguments: {} });
      expect(ok.isError).not.toBe(true);
    }
    const reads = portfolio.getPortfolio.mock.calls.length;
    const over = await client.callTool({ name: "list_portfolio_accounts", arguments: {} });
    expect(over).toMatchObject({ isError: true, content: [{ type: "text", text: LIMITED }] });
    expect(textBlocks(over)).toEqual([{ type: "text", text: LIMITED }]);
    // Counted before the handler: a flood is rejected without touching the portfolio.
    expect(portfolio.getPortfolio.mock.calls.length).toBe(reads);
    c.advance(60_001);
    expect((await client.callTool({ name: "list_portfolio_accounts", arguments: {} })).isError).not.toBe(true);
  });

  it("limits are per subject", async () => {
    const toolLimiter = toolRateLimiter({ now: clock().now });
    const alice = await connect({ toolLimiter, authSubject: "subject|alice" } as never);
    const bob = await connect({ toolLimiter, authSubject: "subject|bob" } as never);
    for (let i = 0; i < 60; i++) await alice.client.callTool({ name: "list_portfolio_accounts", arguments: {} });
    expect((await alice.client.callTool({ name: "list_portfolio_accounts", arguments: {} })).isError).toBe(true);
    expect((await bob.client.callTool({ name: "list_portfolio_accounts", arguments: {} })).isError).not.toBe(true);
  });

  it("cached get_news reads never spend the refresh limit; a real refresh is counted once (Review Focus 4)", async () => {
    const now = new Date("2026-10-21T20:00:00Z");
    const toolLimiter = toolRateLimiter({ now: clock().now });
    const record = vi.spyOn(toolLimiter, "recordRefresh");
    const news = newsDeps();
    const refreshSymbols = vi.fn(async (symbols: Array<{ symbol: string }>) => {
      for (const sym of symbols) await news.store.markFetched(sym.symbol, now);
      return { fetched: symbols.length, rated: 0, skipped: 0, failures: 0, budgetLeft: 80 };
    });
    // Both held symbols fresh (fetched an hour ago): a working refresh path must not fire.
    for (const sym of ["SYNTHETIC0", "SYNTHETIC1"]) await news.store.markFetched(sym, new Date(now.getTime() - 3_600_000));
    const { client } = await connect({ toolLimiter, overview: overviewDeps(), news: { ...news, refresh: { refreshSymbols } }, assets: { html: () => OVERVIEW_HTML } } as never);
    for (let i = 0; i < 15; i++) {
      const r = await client.callTool({ name: "get_news", arguments: {} });
      expect(r.isError).not.toBe(true);
    }
    expect(refreshSymbols).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    // One symbol goes stale: the next call refreshes it and is counted once; the following cached calls are not.
    await news.store.markFetched("SYNTHETIC1", new Date(now.getTime() - 7 * 3_600_000));
    for (let i = 0; i < 5; i++) await client.callTool({ name: "get_news", arguments: {} });
    expect(refreshSymbols).toHaveBeenCalledTimes(1);
    expect(refreshSymbols.mock.calls[0][0].map((x: { symbol: string }) => x.symbol)).toEqual(["SYNTHETIC1"]);
    expect(record).toHaveBeenCalledTimes(1);
    expect(toolLimiter.refreshAvailable(SUBJECT, "get_news")).toBe(true);
  });

  it("a ticker whose provider fails is not re-counted as a refresh on every call (holdings and allocation)", async () => {
    const fixed = () => new Date("2026-10-21T20:00:00Z");
    const quote = vi.fn(async () => { throw new Error("unquotable"); });
    const profile = vi.fn(async () => null);
    const market = new MarketDataService({
      history: [{ name: "yahoo", history: vi.fn(async () => null), profile } as any], quotes: { name: "q", quote } as any,
      fx: { usdCad: vi.fn(async () => [{ date: "2026-10-20", close: 1.4 }]) } as any,
      cache: new MemoryMarketDataCache(), now: fixed, retryDelayMs: 0,
    });
    for (const [tool, args] of [["get_holdings", {}], ["get_allocation", { dimension: "sector" }]] as const) {
      const toolLimiter = toolRateLimiter({ now: clock().now });
      const record = vi.spyOn(toolLimiter, "recordRefresh");
      const { client } = await connect({
        toolLimiter, overview: overviewDeps(), assets: { html: () => OVERVIEW_HTML },
        holdings: { market, settings, now: fixed }, allocation: { market, settings, now: fixed },
      } as never);
      for (let i = 0; i < 11; i++) expect((await client.callTool({ name: tool, arguments: args })).isError).not.toBe(true);
      // Only the first call reached the provider; the known failures afterwards are resolved misses.
      expect(record).toHaveBeenCalledTimes(1);
      expect(toolLimiter.refreshAvailable(SUBJECT, tool)).toBe(true);
    }
    expect(profile).toHaveBeenCalledTimes(2);
  });

  it("over the refresh limit, holdings are served without a provider refresh (no error)", async () => {
    const toolLimiter = toolRateLimiter({ now: clock().now });
    const holdings = holdingsDeps();
    const { client } = await connect({ toolLimiter, overview: overviewDeps(), holdings, assets: { html: () => OVERVIEW_HTML } } as never);
    for (let i = 0; i < 10; i++) expect((await client.callTool({ name: "get_holdings", arguments: {} })).isError).not.toBe(true);
    expect(holdings.market.quotes).toHaveBeenCalledTimes(10);
    expect(toolLimiter.refreshAvailable(SUBJECT, "get_holdings")).toBe(false);
    const eleventh = await client.callTool({ name: "show_holdings", arguments: {} });
    expect(eleventh.isError).not.toBe(true);
    expect(holdings.market.quotes).toHaveBeenCalledTimes(10);
    expect((eleventh.structuredContent as any).rows.every((r: any) => r.dayChange === null)).toBe(true);
  });

});
