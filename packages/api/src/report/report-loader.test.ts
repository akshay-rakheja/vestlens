import { describe, expect, it, vi } from "vitest";

import { benchmarkClosesCad } from "../analytics/shadow-benchmark.js";
import { benchmarkFetchFrom } from "../analytics/value-series.js";
import { loadHomeConverter } from "../fx/home-currency.js";
import { buildPortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import { connectFacts, FACT_NOW, FACT_SUBJECT, TFSA_ID } from "../testing/fact-tools-harness.js";
import { checkHolding } from "../theses/thesis-check.js";
import { loadHoldingView } from "../theses/thesis-loader.js";
import { REASONS } from "./report-card.js";
import { loadReportCard, type ReportCardDeps } from "./report-loader.js";

// Synthetic accounts, symbols, prices and amounts only. The harness TFSA holds SHOP.TO; ABC and DEF were sold in full.
const day = (d: string) => new Date(`${d}T00:00:00Z`);
const trade = (dedupeKey: string, over: Record<string, unknown>) => ({ snapTradeAccountId: TFSA_ID, dedupeKey, currency: "CAD", securityCurrency: "CAD", ...over });
const ACTIVITIES = [
  trade("b-shop", { type: "BUY", symbol: "SHOP.TO", units: 10, price: 100, amount: -1000, tradeDate: day("2025-01-02") }),
  trade("b-abc", { type: "BUY", symbol: "ABC", units: 5, price: 20, amount: -100, tradeDate: day("2025-02-03") }),
  trade("s-abc", { type: "SELL", symbol: "ABC", units: -5, price: 30, amount: 150, tradeDate: day("2026-03-02") }),
  trade("b-def", { type: "BUY", symbol: "DEF", units: 10, price: 10, amount: -100, tradeDate: day("2025-03-03") }),
  trade("s-def", { type: "SELL", symbol: "DEF", units: -10, price: 8, amount: 80, tradeDate: day("2026-04-01") }),
];
const never = () => new Promise<never>(() => undefined);

async function world(over: Partial<ReportCardDeps> = {}, market: Record<string, unknown> = {}) {
  const h = await connectFacts({ activities: ACTIVITIES });
  const presentation = buildPortfolioPresentation(await h.portfolio.getPortfolio());
  const deps: ReportCardDeps = {
    prisma: h.facts.prisma, memory: h.service, portfolio: async () => presentation,
    market: { ...h.facts.market, securityHistory: vi.fn(async () => null), ...market } as ReportCardDeps["market"],
    ...over,
  };
  return { h, deps, presentation };
}

describe("loadReportCard: page-load cost", () => {
  it("reads one Bank of Canada series and one range of each index for every holding view", async () => {
    const { h, deps } = await world();
    const card = await loadReportCard(deps, FACT_SUBJECT, FACT_NOW);
    expect(card.calls.checked).toBe(3);
    expect(h.marketCalls.filter((c) => c === "usdCad")).toHaveLength(1);
    expect(h.marketCalls.filter((c) => c === "history:^SP500TR")).toHaveLength(1);
    expect(h.marketCalls.filter((c) => c === "history:^GSPTSE")).toHaveLength(1);
  });

  it("the shared series give each holding view the same result as its own reads", async () => {
    const { h, presentation } = await world();
    const base = { memory: h.service, portfolio: async () => presentation, prisma: h.facts.prisma, market: h.facts.market, news: { articlesForSymbols: async () => [], ratingsFor: async () => [], events: async () => [] } };
    const fx = await loadHomeConverter(h.facts.market, benchmarkFetchFrom("2025-01-01"), "2026-10-23");
    const series = async (key: "sp500" | "tsx") => (await benchmarkClosesCad(h.facts.market, key, "2025-01-01", "2026-10-23", fx)).points;
    const shared = { fx, benchmarks: { sp500: await series("sp500"), tsx: await series("tsx") } };
    for (const symbol of ["SHOP.TO", "ABC", "DEF"]) {
      const own = await loadHoldingView(base, FACT_SUBJECT, symbol, FACT_NOW);
      const viaShared = await loadHoldingView({ ...base, shared }, FACT_SUBJECT, symbol, FACT_NOW);
      expect(checkHolding(viaShared.holding!, FACT_NOW).sinceFirstBought, symbol).toEqual(checkHolding(own.holding!, FACT_NOW).sinceFirstBought);
    }
  });

  it("a slow price history is counted as not read in time, not as no price history", async () => {
    const { deps } = await world({ deadlines: { historiesMs: 30 } }, { securityHistory: vi.fn(never) });
    const card = await loadReportCard(deps, FACT_SUBJECT, FACT_NOW);
    expect(card.afterSold.cantTell.reasons).toEqual([{ reason: REASONS.timedOut, count: 2, symbols: ["ABC", "DEF"] }]);
    expect(JSON.stringify(card.afterSold)).not.toContain(REASONS.noHistory);
  });

  it("slow index closes leave every holding not read in time", async () => {
    const { deps } = await world({ deadlines: { callsMs: 30 } }, { history: vi.fn(never) });
    const card = await loadReportCard(deps, FACT_SUBJECT, FACT_NOW);
    expect(card.calls.summary.compared).toBe(0);
    expect(card.calls.cantTell.reasons).toEqual([{ reason: REASONS.timedOut, count: 3, symbols: ["DEF", "ABC", "SHOP.TO"] }]);
  });

  it("starts Overall before reading the activity", async () => {
    const overall = vi.fn(async () => null);
    const { h, deps } = await world({ overall });
    await loadReportCard(deps, FACT_SUBJECT, FACT_NOW);
    const findMany = h.facts.prisma.activity.findMany as unknown as ReturnType<typeof vi.fn>;
    expect(overall.mock.invocationCallOrder[0]!).toBeLessThan(findMany.mock.invocationCallOrder[0]!);
  });
});
