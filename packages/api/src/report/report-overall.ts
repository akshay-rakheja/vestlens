import { withDeadline } from "../mcp/overview-tools.js";
import { buildPerformancePayload, type PerformanceDeps, type PerformancePayload } from "../mcp/performance-tools.js";
import type { PortfolioPresentation } from "../portfolio/portfolio-presentation.js";

/**
 * "Overall": this year's portfolio investment return against the S&P 500, straight from the existing performance
 * engine (the performance view's YTD figures, time-weighted). Present only when the engine gives both numbers for the
 * whole portfolio in CAD; otherwise the report leaves the section out. No new engine.
 */

export interface OverallSection {
  period: "YTD";
  /** The span the engine compared (a later start when the portfolio's history begins this year). */
  from: string;
  to: string;
  returnPct: number;
  sp500Pct: number;
  /** The return is estimated (USD converted, flows missing); the S&P 500 is always converted to CAD (est.). */
  returnEstimated: boolean;
  sp500Estimated: true;
  /** Since the portfolio's history begins, as yearly rates (CAGR); absent under a year or when the engine can't say. */
  sinceStart?: SinceStart;
}

/** The All-period time-weighted return and the S&P 500 over the same dates, each as a compound yearly rate. */
export interface SinceStart { from: string; to: string; years: number; cagrPct: number; sp500CagrPct: number; estimated: boolean }

export const OVERALL_DEADLINE_MS = 8_000;
type Build = (deps: PerformanceDeps, portfolio: PortfolioPresentation, subject: string, input: { period: "YTD" | "ALL"; benchmark: "sp500" }) => Promise<PerformancePayload>;

export function overallFromPayload(p: PerformancePayload | null): OverallSection | null {
  if (!p || p.scope.kind !== "portfolio" || p.scope.currency !== "CAD" || p.benchmark.key !== "sp500") return null;
  const r = p.figures.investmentReturn, b = p.figures.benchmarkReturn;
  if (r.value === null || b.value === null || !Number.isFinite(r.value) || !Number.isFinite(b.value)) return null;
  const round = (n: number) => Math.round(n * 10_000) / 100;
  return {
    period: "YTD", from: p.span.since ?? p.span.start, to: p.span.end,
    returnPct: round(r.value), sp500Pct: round(b.value), returnEstimated: r.estimated, sp500Estimated: true,
  };
}

export function sinceStartFromPayload(p: PerformancePayload | null): SinceStart | null {
  if (!p || p.scope.kind !== "portfolio" || p.scope.currency !== "CAD" || p.benchmark.key !== "sp500") return null;
  const r = p.figures.investmentCagr, b = p.figures.benchmarkCagr;
  if (!r || !b || r.value === null || b.value === null || r.years === undefined || !Number.isFinite(r.value) || !Number.isFinite(b.value)) return null;
  const round = (n: number) => Math.round(n * 10_000) / 100;
  return { from: p.span.start, to: p.span.end, years: r.years, cagrPct: round(r.value), sp500CagrPct: round(b.value), estimated: true };
}

/** The report's `overall` dependency from the performance view's deps; any failure or timeout leaves it out. */
export function performanceOverall(deps: PerformanceDeps, build: Build = buildPerformancePayload, deadlineMs = OVERALL_DEADLINE_MS) {
  const run = (subject: string, portfolio: PortfolioPresentation, period: "YTD" | "ALL") =>
    withDeadline(() => build(deps, portfolio, subject, { period, benchmark: "sp500" }), deadlineMs, () => null).catch(() => null);
  // YTD and the whole history run side by side under the same deadline; the yearly rate is extra, never required.
  return async (subject: string, portfolio: PortfolioPresentation): Promise<OverallSection | null> => {
    const [ytd, all] = await Promise.all([run(subject, portfolio, "YTD"), run(subject, portfolio, "ALL")]);
    const overall = overallFromPayload(ytd);
    const since = sinceStartFromPayload(all);
    return overall && since ? { ...overall, sinceStart: since } : overall;
  };
}
