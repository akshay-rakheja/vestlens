import type { Express, RequestHandler } from "express";
import { z } from "zod";

import { BENCHMARK_KEYS } from "../settings/settings-service.js";
import { buildPerformancePayload, PERFORMANCE_PERIODS, unrecordedText, type PerformanceDeps, type PerformancePayload } from "../mcp/performance-tools.js";
import type { PortfolioPresentation } from "../portfolio/portfolio-presentation.js";

/**
 * GET /api/performance: the dashboard's return chart. The same computation as show_performance (the
 * time-weighted return with deposits taken out, against a benchmark), trimmed to what the chart and its figures use.
 * Stored data and cached market data only; whole portfolio. Dashboard tokens and current consents only.
 */
export interface DashboardPerformance {
  period: PerformancePayload["period"];
  periods: readonly string[];
  span: PerformancePayload["span"];
  asOf: string;
  /** Currency of the figures; CAD (est.) when the CAD view converted a USD account. */
  currency: string;
  estimated: boolean;
  /** Estimated because a USD account was converted to CAD (the note names the Bank of Canada rate). */
  fxEstimated: boolean;
  benchmark: { key: string; name: string; label: string; basis?: string; note: string | null; unavailableReason: string | null };
  benchmarks: Array<{ key: string; name: string }>;
  /** personalReturn (money-weighted) pairs with matchedBenchmarkReturn (the same money in the index); investmentReturn with benchmarkReturn. */
  figures: Pick<PerformancePayload["figures"], "investmentReturn" | "benchmarkReturn" | "personalReturn" | "matchedBenchmarkReturn" | "matchedBenchmarkValue" | "netDeposits" | "marketGain" | "valueChange">;
  /** Growth of 1 from the span's start: the time-weighted return and the benchmark on the same dates. */
  series: { you: Array<{ date: string; value: number }>; benchmark: Array<{ date: string; value: number }> };
  /** Put in, taken out and per account, adding up to figures.netDeposits; the Cash accounts left out. */
  deposits: PerformancePayload["deposits"];
  /** Accounts left out of every figure, named without amounts (managed portfolios, gaps in value history). */
  notInFigures: PerformancePayload["notInFigures"];
  /** The chat's sentences for value steps SnapTrade's records don't explain (spec 2026-11-04-unrecorded-flow-check), or null. */
  unrecordedNote: string | null;
}

const query = z.object({
  period: z.enum(PERFORMANCE_PERIODS).optional(),
  benchmark: z.enum(BENCHMARK_KEYS).optional(),
});

export function dashboardPerformance(payload: PerformancePayload): DashboardPerformance {
  const { investmentReturn, benchmarkReturn, personalReturn, matchedBenchmarkReturn, matchedBenchmarkValue, netDeposits, marketGain, valueChange } = payload.figures;
  return {
    period: payload.period,
    periods: PERFORMANCE_PERIODS,
    span: payload.span,
    asOf: payload.asOf,
    currency: payload.home?.converted ? "CAD" : payload.scope.currency,
    estimated: Boolean(payload.home?.estimated) || investmentReturn.estimated || benchmarkReturn.estimated,
    fxEstimated: Boolean(payload.home?.estimated),
    benchmark: { key: payload.benchmark.key, name: payload.benchmark.name, label: payload.benchmark.label, basis: payload.benchmark.basis, note: payload.benchmark.note, unavailableReason: payload.benchmark.unavailableReason },
    benchmarks: payload.benchmarks.map(({ key, name }) => ({ key, name })),
    figures: { investmentReturn, benchmarkReturn, personalReturn, matchedBenchmarkReturn, matchedBenchmarkValue, netDeposits, marketGain, valueChange },
    series: { you: payload.series.twrIndex, benchmark: payload.series.benchmarkIndex },
    deposits: payload.deposits,
    notInFigures: payload.notInFigures,
    unrecordedNote: payload.unrecorded?.length ? unrecordedText(payload.unrecorded) : null,
  };
}

export function registerPerformanceRoute(app: Express, deps: {
  guards: RequestHandler[];
  performance: PerformanceDeps;
  portfolio: (subject: string) => Promise<PortfolioPresentation>;
}): void {
  app.get("/api/performance", ...deps.guards, async (request, response) => {
    const parsed = query.safeParse({
      period: typeof request.query.period === "string" ? request.query.period : undefined,
      benchmark: typeof request.query.benchmark === "string" ? request.query.benchmark : undefined,
    });
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      const subject = response.locals.authSubject as string;
      const portfolio = await deps.portfolio(subject);
      if (portfolio.connectionRequired) {
        response.status(409).json({ error: "connection_required" });
        return;
      }
      response.json(dashboardPerformance(await buildPerformancePayload(deps.performance, portfolio, subject, parsed.data)));
    } catch {
      console.warn(JSON.stringify({ event: "dashboard_performance_failed" }));
      response.status(503).json({ error: "performance_unavailable" });
    }
  });
}
