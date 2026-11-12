import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPortfolioApi } from "../http/app.js";
import { McpTokenVerifier } from "../gateway/mcp-token-verifier.js";
import { GatewayTokenService } from "../gateway/tokens.js";
import { connectFacts, FACT_SUBJECT, TFSA_ID } from "../testing/fact-tools-harness.js";
import { loopbackRequest } from "../testing/loopback-request.js";
import { memoryOwnerSessions } from "../testing/owner-session-prisma.js";
import { sessionCookieFor } from "../testing/owner-session.js";
import { mcpBearer, syntheticGatewayConfig } from "../testing/runtime-owner-fixtures.js";
import { createReportCardCache } from "./report-cache.js";

// Synthetic identities, accounts, symbols, prices and amounts only. Nothing reaches a provider or a database.
const APP = "https://mcp.example.test";
const RESOURCE = "https://mcp.example.test/mcp";
const gatewayConfig = syntheticGatewayConfig(APP);
const sessions = memoryOwnerSessions();
afterEach(() => vi.restoreAllMocks());

/** The dashboard's browser headers: the owner session cookie and this app's own Origin (required on writes). */
const owner = async () => ({ Cookie: await sessionCookieFor(sessions), Origin: APP });
/** A gateway-issued bearer for /mcp. */
const mcpToken = () => mcpBearer({ gateway: gatewayConfig, mcpResourceUrl: RESOURCE });

const day = (d: string) => new Date(`${d}T00:00:00Z`);
const trade = (dedupeKey: string, over: Record<string, unknown>) => ({ snapTradeAccountId: TFSA_ID, dedupeKey, currency: "CAD", securityCurrency: "CAD", ...over });

// The TFSA holds SHOP.TO (10 at 120, bought at 100). ABC and DEF were bought and sold in full; USX is a US-dollar buy in
// the CAD account (price recorded in CAD) at 1.365 against a 1.35 Bank of Canada rate and a US$100 close. The indices are flat (every close 100).
const ACTIVITIES = [
  trade("b-shop", { type: "BUY", symbol: "SHOP.TO", units: 10, price: 100, amount: -1000, tradeDate: day("2025-01-02") }),
  trade("b-abc", { type: "BUY", symbol: "ABC", units: 5, price: 20, amount: -100, tradeDate: day("2025-02-03") }),
  trade("s-abc", { type: "SELL", symbol: "ABC", units: -5, price: 30, amount: 150, tradeDate: day("2026-03-02") }),
  trade("b-def", { type: "BUY", symbol: "DEF", units: 10, price: 10, amount: -100, tradeDate: day("2025-03-03") }),
  trade("s-def", { type: "SELL", symbol: "DEF", units: -10, price: 8, amount: 80, tradeDate: day("2026-04-01") }),
  trade("b-usx", { type: "BUY", symbol: "USX", securityCurrency: "USD", units: 10, price: 136.5, amount: -1365, tradeDate: day("2026-05-01") }),
  trade("fee-1", { type: "FEE", symbol: null, securityCurrency: null, amount: -4.99, tradeDate: day("2026-06-01") }),
];

const dates = (from: string, to: string) => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
// Split-adjusted closes: at the sale price on and before each sale, then the latest price.
const CLOSES: Record<string, { saleDate: string; sale: number; after: number }> = {
  ABC: { saleDate: "2026-03-02", sale: 30, after: 33 },
  DEF: { saleDate: "2026-04-01", sale: 8, after: 10 },
  USX: { saleDate: "2026-05-01", sale: 100, after: 100 },
};

async function build(o: { securityHistory?: (ticker: string, from: string, to: string) => Promise<unknown>; reportCards?: unknown } = {}) {
  const harness = await connectFacts({ activities: ACTIVITIES });
  const securityHistory = vi.fn(o.securityHistory ?? (async (ticker: string, from: string, to: string) => {
    const c = CLOSES[ticker];
    if (!c) return null;
    return { points: dates(from, to).map((date) => ({ date, close: date <= c.saleDate ? c.sale : c.after })), splits: [] };
  }));
  const dataControls = {
    disconnect: vi.fn(async () => ({ status: "disconnected" as const, providerDeletion: "requested" })),
  };
  const facts = { ...harness.facts, market: { ...harness.facts.market, securityHistory } };
  const app = createPortfolioApi({
    sessions,
    portfolio: harness.portfolio,
    history: { getAccountHistory: vi.fn(async () => ({})) },
    connections: { getConnections: vi.fn(async () => []), createConnectionPortal: vi.fn(async () => "https://x.invalid") },
    webhooks: { ingest: vi.fn(async () => ({ duplicate: false })) },
    appBaseUrl: APP, mcpResourceUrl: RESOURCE,
    gateway: {
      router: express.Router(), issuer: APP,
      mcpVerifier: new McpTokenVerifier({
        gateway: new GatewayTokenService({ issuer: APP, audience: RESOURCE, signingKey: gatewayConfig.signingKey }),
        revocations: { accessRevokedAt: async () => null },
      }),
    },
    memory: { service: harness.service, links: { accountsHoldingSecurity: async () => [], tfsaAccounts: async () => [TFSA_ID], accountIds: async () => [TFSA_ID], activityDedupeKeys: async () => [] } },
    portfolioFacts: facts, dataControls, ...(o.reportCards ? { reportCards: o.reportCards } : {}),
  } as never);
  return { req: await loopbackRequest(app), securityHistory, dataControls, ...harness };
}

describe("GET /api/report-card", () => {
  it("answers 401 without a session", async () => {
    const { req } = await build();
    await req.get("/api/report-card").expect(401);
  });

  it("returns the three sections from stored activity and cached market data", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { req, securityHistory } = await build();
    const res = await req.get("/api/report-card").set(await owner()).expect(200);
    const card = res.body;
    expect(card.asOf).toBe("2026-10-23");
    expect(card.activityFrom).toBe("2025-01-02");

    // Calls: SHOP.TO +20% and ABC ahead of the flat S&P 500, DEF behind; USX is still held but not in the positions.
    expect(card.calls.checked).toBe(4);
    expect(card.calls.summary).toMatchObject({ compared: 3, ahead: 2, behind: 1 });
    expect(card.calls.summary.worst.symbol).toBe("DEF");
    // ABC (+50%, sold in full) beat the flat index by more than the comparison can put a number on: ahead, no figure.
    expect(card.calls.summary.aheadUnmeasured.map((a: { symbol: string }) => a.symbol)).toEqual(["ABC"]);
    const shop = card.calls.items.find((i: { symbol: string }) => i.symbol === "SHOP.TO");
    expect(shop.returnPct).toBeCloseTo(20, 1);
    expect(shop.vsSp500Pct).toBeCloseTo(20, 1);
    expect(card.calls.cantTell.count).toBe(1);
    expect(card.calls.cantTell.reasons[0].symbols).toEqual(["USX"]);

    // After you sold: ABC 30 → 33 (+10%, kept 15) and DEF 8 → 10 (+25%, kept 20).
    expect(card.afterSold.summary).toMatchObject({ sells: 2, rose: 2, fell: 0, keptVsSoldCad: 35, estimated: false });
    expect(securityHistory.mock.calls.map((c) => c[0]).sort()).toEqual(["ABC", "DEF", "USX"]);

    // What trading cost you: CAD 1,365 converted on the USX buy (a fact); one trade is too few for a cost estimate.
    expect(card.tradingCost.conversion).toMatchObject({ rows: 1, convertedCad: 1365, estimated: false });
    expect(card.tradingCost.conversion.estimate).toMatchObject({ rows: 1, minRows: 20, costCad: null });
    expect(card.tradingCost.fees).toMatchObject({ rows: 1, totalCad: 4.99, estimated: false });
    expect(card.overall).toBeNull();

    // Logs carry counts and codes only.
    const logged = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("report_card"));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toMatchObject({ event: "report_card", via: "web", calls: 4, compared: 3, sells: 2, conversions: 1, estimateRows: 1, fees: 1, overall: false, cache: "computed" });
    for (const secret of [FACT_SUBJECT, TFSA_ID, "SHOP", "ABC", "1365", "4.99"]) expect(logged[0]).not.toContain(secret);
    expect(JSON.stringify(card)).not.toContain(FACT_SUBJECT);
  });

  it("answers 503 with a fixed error when the stored data can't be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { req, facts } = await build();
    (facts.prisma.activity.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(new Error(`boom ${FACT_SUBJECT}`));
    const res = await req.get("/api/report-card").set(await owner()).expect(503);
    expect(res.body).toEqual({ error: "report_unavailable" });
    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).not.toContain(FACT_SUBJECT);
  });

  it("logs couldn't-tell counts per fixed reason code and the duration: codes and counts only", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { req } = await build({ securityHistory: async () => null });
    await req.get("/api/report-card").set(await owner()).expect(200);
    const line = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes("report_card"))!;
    const event = JSON.parse(line);
    // USX has no current value (not in the positions); ABC and DEF have no price history, so their sales and the USX trade can't be compared.
    expect(event.callsCantTellBy).toEqual({ no_current_value: 1 });
    expect(event.sellsCantTellBy).toEqual({ no_history: 2 });
    expect(event.estimateCantTellBy).toEqual({ no_history: 1 });
    expect(event.durationMs).toEqual(expect.any(Number));
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    // Every value is a count, a flag or a fixed word; every map key is a snake_case code.
    const leaves: Array<[string, unknown]> = [];
    const walk = (o: Record<string, unknown>, path: string) => {
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === "object") { expect(k).toMatch(/^[a-zA-Z]+$/); walk(v as Record<string, unknown>, `${path}.${k}`); } else leaves.push([`${path}.${k}`, v]);
      }
    };
    walk(event, "");
    for (const [path, v] of leaves) {
      if (typeof v === "string") expect(["event", "via", "cache", "env"].map((k) => `.${k}`), path).toContain(path);
      else if (typeof v === "number") expect(Number.isInteger(v), path).toBe(true);
      else expect(typeof v, path).toBe("boolean");
      if (path.split(".").length > 2) expect(path.split(".").at(-1)).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    for (const secret of [FACT_SUBJECT, TFSA_ID, "USX", "ABC", "price history", "1365"]) expect(line).not.toContain(secret);
  });

  it("a second request within 30 minutes is answered from memory, without reading again", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { req, securityHistory, facts } = await build();
    const first = await req.get("/api/report-card").set(await owner()).expect(200);
    const reads = securityHistory.mock.calls.length;
    const findMany = (facts.prisma.activity.findMany as ReturnType<typeof vi.fn>).mock.calls.length;
    const second = await req.get("/api/report-card").set(await owner()).expect(200);
    expect(second.body).toEqual(first.body);
    expect(securityHistory.mock.calls.length).toBe(reads);
    expect((facts.prisma.activity.findMany as ReturnType<typeof vi.fn>).mock.calls.length).toBe(findMany);
    const sources = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("report_card")).map((l) => JSON.parse(l).cache);
    expect(sources).toEqual(["computed", "cached"]);
  });

  it("concurrent requests share one computation", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { req, securityHistory } = await build();
    const auth = await owner();
    const [a, b] = await Promise.all([req.get("/api/report-card").set(auth), req.get("/api/report-card").set(auth)]);
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(securityHistory.mock.calls.map((c) => c[0]).sort()).toEqual(["ABC", "DEF", "USX"]);
  });

  it("disconnecting a connection drops the stored report", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { req, securityHistory } = await build();
    const auth = await owner();
    await req.get("/api/report-card").set(auth).expect(200);
    await req.delete("/api/connections/synthetic-connection").set(auth).expect(202);
    await req.get("/api/report-card").set(auth).expect(200);
    expect(securityHistory.mock.calls).toHaveLength(6);
  });

  it("re-reads the data-version marker on a hit: unchanged stays cached, changed recomputes", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    let marker = "1|2026-10-22T04:00:00.000Z|-";
    const version = vi.fn(async () => marker);
    const { req, securityHistory } = await build({ reportCards: createReportCardCache({ version }) });
    const auth = await owner();
    await req.get("/api/report-card").set(auth).expect(200);
    await req.get("/api/report-card").set(auth).expect(200);
    expect(securityHistory.mock.calls).toHaveLength(3);
    expect(version).toHaveBeenCalledWith(FACT_SUBJECT);
    // Another instance deleted a connection: the marker changes here too.
    marker = "0|2026-10-22T04:00:00.000Z|-";
    await req.get("/api/report-card").set(auth).expect(200);
    expect(securityHistory.mock.calls).toHaveLength(6);
  });

  it("a delete that fails partway still drops the stored report", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { req, securityHistory, dataControls } = await build();
    const auth = await owner();
    // The report is read again while the delete runs (so it is stored), then the delete fails.
    dataControls.disconnect.mockImplementationOnce(async () => {
      await req.get("/api/report-card").set(auth).expect(200);
      throw new Error("synthetic partial delete");
    });
    await req.delete("/api/connections/synthetic-connection").set(auth);
    expect(securityHistory.mock.calls).toHaveLength(3);
    await req.get("/api/report-card").set(auth).expect(200);
    expect(securityHistory.mock.calls).toHaveLength(6);
  });
});

describe("show_report_card over /mcp (spec 2026-10-27)", () => {
  const call = (args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "show_report_card", arguments: args } });
  const mcp = async (req: Awaited<ReturnType<typeof build>>["req"], body: unknown) =>
    (await req.post("/mcp").set("Authorization", `Bearer ${await mcpToken()}`).set("Accept", "application/json, text/event-stream").send(body as object).expect(200)).body;
  const reportLines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("\"report_card"));

  it("is listed on the focused surface /mcp serves, read-only, with a strict empty input", async () => {
    const { req } = await build();
    const tools = (await mcp(req, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).result.tools as Array<Record<string, any>>;
    const tool = tools.find((t) => t.name === "show_report_card")!;
    expect(tool).toBeDefined();
    expect(tool.title).toBe("Show investing report card");
    expect(tool.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool.securitySchemes).toEqual([{ type: "oauth2", scopes: ["portfolio:read"] }]);
    expect(tool.description).toMatch(/states facts, not advice\.$/);
  });

  it("returns the same ReportCard as GET /api/report-card, from the same cached computation, logged with via", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { req, securityHistory } = await build();
    const web = await req.get("/api/report-card").set(await owner()).expect(200);
    const reads = securityHistory.mock.calls.length;
    const body = await mcp(req, call());
    expect(body.result.isError).not.toBe(true);
    expect(body.result.structuredContent).toEqual(web.body);
    // One computation for both: the chat call reads nothing again.
    expect(securityHistory.mock.calls.length).toBe(reads);
    const events = reportLines(info).map((l) => JSON.parse(l));
    expect(events.map((e) => [e.via, e.cache])).toEqual([["web", "computed"], ["mcp", "cached"]]);
    expect(events[1]).toMatchObject({ event: "report_card", calls: 4, compared: 3, sells: 2, conversions: 1, fees: 1, overall: false });
    for (const secret of [FACT_SUBJECT, TFSA_ID, "SHOP", "ABC", "USX", "1365", "4.99"]) expect(reportLines(info)[1]).not.toContain(secret);
    // The text is the short summary; the model copy is the card itself.
    const text = body.result.content[0].text as string;
    expect(text.split("\n")).toHaveLength(5);
    expect(text).toMatch(/^Investing report card as of /);
    expect(JSON.parse(body.result.content[1].text)).toEqual(web.body);
  });

  it("a chat call computes once, and the dashboard then reads it from memory; a disconnect forgets it for both", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { req, securityHistory } = await build();
    await mcp(req, call());
    expect(securityHistory.mock.calls).toHaveLength(3);
    await req.get("/api/report-card").set(await owner()).expect(200);
    expect(securityHistory.mock.calls).toHaveLength(3);
    await req.delete("/api/connections/synthetic-connection").set(await owner()).expect(202);
    await mcp(req, call());
    expect(securityHistory.mock.calls).toHaveLength(6);
    expect(reportLines(info).map((l) => JSON.parse(l)).map((e) => [e.via, e.cache])).toEqual([["mcp", "computed"], ["web", "cached"], ["mcp", "computed"]]);
  });

  it("takes no arguments: any argument is a correctable error and nothing is read", async () => {
    const { req, facts } = await build();
    const body = await mcp(req, call({ year: 2026 }));
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe("show_report_card takes no arguments.");
    expect(facts.prisma.activity.findMany).not.toHaveBeenCalled();
  });

  it("a failure is a fixed line, logged as a code with via", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { req, facts } = await build();
    (facts.prisma.activity.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(new Error(`boom ${FACT_SUBJECT}`));
    const body = await mcp(req, call());
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe("The report card is unavailable right now. Try again in a minute.");
    const failed = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("report_card_failed"));
    expect(failed.map((l) => JSON.parse(l))).toEqual([{ event: "report_card_failed", via: "mcp", code: "unavailable" }]);
    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).not.toContain(FACT_SUBJECT);
  });
});
