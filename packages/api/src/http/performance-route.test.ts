import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loopbackRequest } from "../testing/loopback-request.js";

const build = vi.hoisted(() => vi.fn());
vi.mock("../mcp/performance-tools.js", async (original) => ({
  ...(await original<typeof import("../mcp/performance-tools.js")>()),
  buildPerformancePayload: build,
}));
const { dashboardPerformance, registerPerformanceRoute } = await import("./performance-route.js");

const figure = (value: number | null, estimated = false) => ({ value, estimated });
const payload = {
  scope: { kind: "portfolio", label: "All accounts", currency: "CAD" },
  accounts: [{ id: "a", label: "TFSA", currency: "CAD" }],
  period: "YTD",
  span: { start: "2026-01-02", end: "2026-10-28", partial: false },
  series: {
    value: [{ date: "2026-01-02", value: 100 }],
    netDeposits: [],
    twrIndex: [{ date: "2026-01-02", value: 1 }, { date: "2026-10-28", value: 1.167 }],
    benchmarkIndex: [{ date: "2026-01-02", value: 1 }, { date: "2026-10-28", value: 1.139 }],
    riskMergedDates: [],
  },
  figures: {
    investmentReturn: figure(0.167), benchmarkReturn: figure(0.139, true), netDeposits: figure(15200),
    marketGain: figure(47640.31), valueChange: figure(62840.31), personalReturn: { ...figure(0.1234), annualised: false }, matchedBenchmarkReturn: { ...figure(0.131), annualised: false }, matchedBenchmarkValue: figure(64010),
  },
  monthly: [],
  benchmark: { key: "sp500", name: "S&P 500", explainer: "long text", note: null, unavailableReason: null },
  benchmarks: [{ key: "sp500", name: "S&P 500", explainer: "long" }, { key: "tsx", name: "S&P/TSX", explainer: "long" }],
  settings: {},
  history: { qualities: [], earliest: null },
  otherCurrencies: [],
  asOf: "2026-10-28T20:00:00.000Z",
  home: null,
};

function app(portfolio: { connectionRequired: boolean } = { connectionRequired: false }) {
  const a = express();
  registerPerformanceRoute(a, {
    guards: [(_req, res, next) => { res.locals.authSubject = "subject|synthetic"; next(); }],
    performance: {} as never,
    portfolio: vi.fn(async () => portfolio as never),
  });
  return a;
}

afterEach(() => build.mockReset());

describe("GET /api/performance", () => {
  it("returns the chart's series and figures only, for the requested period and benchmark", async () => {
    build.mockResolvedValue(payload);
    const res = await (await loopbackRequest(app())).get("/api/performance?period=1Y&benchmark=tsx").expect(200);
    expect(build).toHaveBeenCalledWith({}, { connectionRequired: false }, "subject|synthetic", { period: "1Y", benchmark: "tsx" });
    expect(res.body.series).toEqual({ you: payload.series.twrIndex, benchmark: payload.series.benchmarkIndex });
    expect(res.body.figures.marketGain.value).toBe(47640.31);
    // Your money-weighted return now travels with its own comparison (the same money in the index); risk figures stay out.
    expect(res.body.figures.personalReturn).toEqual(payload.figures.personalReturn);
    expect(res.body.figures).toHaveProperty("matchedBenchmarkReturn");
    expect(res.body.figures).not.toHaveProperty("maxDrawdown");
    expect(res.body.benchmarks).toEqual([{ key: "sp500", name: "S&P 500" }, { key: "tsx", name: "S&P/TSX" }]);
    expect(res.body.estimated).toBe(true);
    expect(res.body).not.toHaveProperty("accounts");
  });

  it("refuses an unknown period or benchmark, and says when nothing is linked", async () => {
    await (await loopbackRequest(app())).get("/api/performance?period=5Y").expect(400);
    await (await loopbackRequest(app())).get("/api/performance?benchmark=gold").expect(400);
    await (await loopbackRequest(app({ connectionRequired: true }))).get("/api/performance").expect(409);
    expect(build).not.toHaveBeenCalled();
  });

  it("answers 503 with a counts-only log line when the computation fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    build.mockRejectedValue(new Error("subject|synthetic leaked?"));
    await (await loopbackRequest(app())).get("/api/performance").expect(503);
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: "dashboard_performance_failed" }));
    warn.mockRestore();
  });

  it("labels a CAD view as converted", () => {
    const view = dashboardPerformance({ ...payload, scope: { ...payload.scope, currency: "USD" }, home: { converted: true, estimated: true } } as never);
    expect(view.currency).toBe("CAD");
    expect(view.fxEstimated).toBe(true);
  });

  it("carries the chat's sentence for a value step SnapTrade's records don't explain, and keeps it apart from FX", () => {
    const view = dashboardPerformance({ ...payload, home: null, unrecorded: [{ accountId: "a", label: "TFSA", name: "", date: "2026-03-03", amount: 5000, currency: "CAD" }] } as never);
    expect(view.unrecordedNote).toBe("TFSA's value rose by about 5,000 CAD on Mar 3 with no deposit in SnapTrade's records: if you added money then, SnapTrade hasn't reported it, so these figures count it as investment gain.");
    expect(view.fxEstimated).toBe(false);
    expect(dashboardPerformance({ ...payload, unrecorded: [] } as never).unrecordedNote).toBeNull();
  });
});
