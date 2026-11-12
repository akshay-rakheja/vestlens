import { describe, expect, it, vi } from "vitest";

import type { PerformanceDeps, PerformancePayload } from "../mcp/performance-tools.js";
import type { PortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import { overallFromPayload, performanceOverall, sinceStartFromPayload } from "./report-overall.js";

// Synthetic figures only: the performance engine's YTD payload, reduced to what Overall reads.
const payload = (over: Record<string, unknown> = {}) => ({
  scope: { kind: "portfolio", label: "Portfolio", currency: "CAD" },
  benchmark: { key: "sp500" },
  span: { start: "2026-01-01", end: "2026-10-22", partial: false },
  figures: { investmentReturn: { value: 0.084, estimated: false }, benchmarkReturn: { value: 0.121, estimated: true } },
  ...over,
}) as unknown as PerformancePayload;

describe("overall: this year against the S&P 500, from the performance engine", () => {
  it("both figures, in percent, the S&P 500 always est.", () => {
    expect(overallFromPayload(payload())).toEqual({
      period: "YTD", from: "2026-01-01", to: "2026-10-22", returnPct: 8.4, sp500Pct: 12.1, returnEstimated: false, sp500Estimated: true,
    });
  });

  it("a history that starts this year compares from its start", () => {
    expect(overallFromPayload(payload({ span: { start: "2026-03-02", end: "2026-10-22", partial: true, since: "2026-03-02" } }))!.from).toBe("2026-03-02");
  });

  it("left out without both figures, for a USD scope, or with no payload", () => {
    expect(overallFromPayload(payload({ figures: { investmentReturn: { value: null, estimated: false }, benchmarkReturn: { value: 0.1, estimated: true } } }))).toBeNull();
    expect(overallFromPayload(payload({ scope: { kind: "portfolio", label: "Portfolio", currency: "USD" } }))).toBeNull();
    expect(overallFromPayload(null)).toBeNull();
  });

  it("asks the engine for YTD against the S&P 500; a failure leaves the section out", async () => {
    const build = vi.fn(async () => payload());
    const portfolio = { accounts: [] } as unknown as PortfolioPresentation;
    expect(await performanceOverall({} as PerformanceDeps, build)("subject|synthetic", portfolio)).toMatchObject({ returnPct: 8.4 });
    expect(build).toHaveBeenCalledWith({}, portfolio, "subject|synthetic", { period: "YTD", benchmark: "sp500" });
    expect(build).toHaveBeenCalledWith({}, portfolio, "subject|synthetic", { period: "ALL", benchmark: "sp500" });
    expect(await performanceOverall({} as PerformanceDeps, async () => { throw new Error("boom"); })("subject|synthetic", portfolio)).toBeNull();
  });

  it("adds the yearly rate since the history began when the whole history is a year or more", async () => {
    const all = payload({ span: { start: "2023-01-02", end: "2026-10-22", partial: false },
      figures: { investmentReturn: { value: 0.5, estimated: false }, benchmarkReturn: { value: 0.4, estimated: true },
        investmentCagr: { value: 0.1123, estimated: false, years: 3.8 }, benchmarkCagr: { value: 0.0931, estimated: true, years: 3.8 } } });
    expect(sinceStartFromPayload(all)).toEqual({ from: "2023-01-02", to: "2026-10-22", years: 3.8, cagrPct: 11.23, sp500CagrPct: 9.31, estimated: true });
    const build = vi.fn(async (_d: unknown, _p: unknown, _s: unknown, input: { period: string }) => (input.period === "ALL" ? all : payload()));
    const portfolio = { accounts: [] } as unknown as PortfolioPresentation;
    expect((await performanceOverall({} as PerformanceDeps, build)("subject|synthetic", portfolio))!.sinceStart).toMatchObject({ cagrPct: 11.23 });
  });

  it("no yearly rate under a year, or when the whole-history call fails; this year still shows", async () => {
    expect(sinceStartFromPayload(payload({ figures: { investmentReturn: { value: 0.1, estimated: false }, benchmarkReturn: { value: 0.1, estimated: true },
      investmentCagr: { value: null, estimated: false, reason: "under_a_year" }, benchmarkCagr: { value: null, estimated: false, reason: "under_a_year" } } }))).toBeNull();
    const build = vi.fn(async (_d: unknown, _p: unknown, _s: unknown, input: { period: string }) => { if (input.period === "ALL") throw new Error("boom"); return payload(); });
    const out = await performanceOverall({} as PerformanceDeps, build)("subject|synthetic", { accounts: [] } as unknown as PortfolioPresentation);
    expect(out).toMatchObject({ returnPct: 8.4 });
    expect(out!.sinceStart).toBeUndefined();
  });
});
