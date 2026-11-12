import type { Express, RequestHandler } from "express";

import type { PortfolioFactDeps } from "../mcp/portfolio-fact-tools.js";
import type { PerformanceDeps } from "../mcp/performance-tools.js";
import type { PortfolioFactsSource } from "../memory/portfolio-facts.js";
import type { PortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import { createReportCardCache, type ReportCacheSource, type ReportCardCache } from "./report-cache.js";
import { cantTellCodes } from "./report-card.js";
import { loadReportCard, type ReportCard } from "./report-loader.js";
import { performanceOverall } from "./report-overall.js";

/** Where a report was asked for: the dashboard (GET /api/report-card) or the chat tool (show_report_card). */
export type ReportCardVia = "web" | "mcp";

export type ReportCardLogEvent =
  | {
    event: "report_card"; via: ReportCardVia; calls: number; compared: number; callsCantTell: number; sells: number; sellsCantTell: number;
    conversions: number; conversionsCantTell: number; estimateRows: number; estimateCantTell: number; fees: number; feesCantTell: number; overall: boolean;
    /** Couldn't-tell counts per fixed reason code (report-card.ts reasonCode); never reason text, symbols or amounts. */
    callsCantTellBy: Record<string, number>; sellsCantTellBy: Record<string, number>; estimateCantTellBy: Record<string, number>;
    cache: ReportCacheSource; durationMs: number;
  }
  | { event: "report_card_failed"; via: ReportCardVia; code: "unavailable" };

export interface ReportCardRunnerDeps {
  /** The fact tools' stored data and cached market data (normal mode only). */
  facts: Pick<PortfolioFactDeps, "prisma" | "market" | "now">;
  memory: PortfolioFactsSource;
  portfolio: (authSubject: string) => Promise<PortfolioPresentation>;
  /** The performance view's deps, for "Overall"; without them the section is left out. */
  performance?: PerformanceDeps;
  /** Counts and constant codes only. */
  log: (event: ReportCardLogEvent) => void;
  /** Each subject's report for 30 minutes (in memory); app.ts shares it with the data-deletion routes. */
  cache?: ReportCardCache<ReportCard>;
  /** Milliseconds, for durationMs. */
  clock?: () => number;
}

export interface ReportCardRoutesDeps {
  /** authenticateManage(). */
  guards: RequestHandler[];
  /** The runner app.ts shares with show_report_card (createReportCardRunner). */
  runner: ReportCardRunner;
}

/** One subject's report card, through the shared cache, logged (counts only) with where it was asked for. */
export interface ReportCardRunner {
  /** Throws after logging report_card_failed when the report can't be worked out. */
  load(subject: string, via: ReportCardVia): Promise<ReportCard>;
}

const counts = (card: ReportCard, via: ReportCardVia, cache: ReportCacheSource, durationMs: number): ReportCardLogEvent => ({
  event: "report_card", via,
  calls: card.calls.checked, compared: card.calls.summary.compared, callsCantTell: card.calls.cantTell.count,
  sells: card.afterSold.summary.sells, sellsCantTell: card.afterSold.cantTell.count,
  conversions: card.tradingCost.conversion.rows, conversionsCantTell: card.tradingCost.conversion.cantTell.count,
  estimateRows: card.tradingCost.conversion.estimate.rows, estimateCantTell: card.tradingCost.conversion.estimate.cantTell.count,
  fees: card.tradingCost.fees.rows, feesCantTell: card.tradingCost.fees.cantTell.count, overall: card.overall !== null,
  callsCantTellBy: cantTellCodes(card.calls.cantTell), sellsCantTellBy: cantTellCodes(card.afterSold.cantTell),
  estimateCantTellBy: cantTellCodes(card.tradingCost.conversion.estimate.cantTell),
  cache, durationMs,
});

/**
 * The report card for one subject: the same loadReportCard inputs for the dashboard and the chat tool, one cache (a
 * report is kept in memory per subject for 30 minutes, and concurrent requests share one computation;
 * report-cache.ts), and the same counts-only log line. Stored data only (no brokerage read).
 */
export function createReportCardRunner(deps: ReportCardRunnerDeps): ReportCardRunner {
  const overall = deps.performance ? performanceOverall(deps.performance) : undefined;
  const cache = deps.cache ?? createReportCardCache<ReportCard>();
  const clock = deps.clock ?? Date.now;
  return {
    async load(subject, via) {
      const started = clock();
      try {
        const { value: card, source } = await cache.get(subject, () => loadReportCard({
          prisma: deps.facts.prisma, market: deps.facts.market, memory: deps.memory, portfolio: deps.portfolio, ...(overall ? { overall } : {}),
        }, subject, (deps.facts.now ?? (() => new Date()))()));
        deps.log(counts(card, via, source, Math.max(0, Math.round(clock() - started))));
        return card;
      } catch (error) {
        deps.log({ event: "report_card_failed", via, code: "unavailable" });
        throw error;
      }
    },
  };
}

/** GET /api/report-card: the caller's report card from stored data only (no brokerage read). */
export function registerReportCardRoutes(app: Express, deps: ReportCardRoutesDeps): void {
  const { runner } = deps;
  app.get("/api/report-card", ...deps.guards, async (_request, response) => {
    try {
      response.json(await runner.load(response.locals.authSubject, "web"));
    } catch {
      response.status(503).json({ error: "report_unavailable" });
    }
  });
}
