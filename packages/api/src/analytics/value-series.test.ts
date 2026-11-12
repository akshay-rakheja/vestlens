import { describe, expect, it, vi } from "vitest";
import { benchmarkSeries, clipBenchmark, mergeDailyPoints, periodStart } from "./value-series.js";

describe("periods", () => {
  it("computes period starts", () => {
    expect(periodStart("YTD", "2026-10-15")).toBe("2026-01-01");
    expect(periodStart("1M", "2026-10-15")).toBe("2026-09-15");
    expect(periodStart("1W", "2026-10-15")).toBe("2026-10-08");
    expect(periodStart("1Y", "2026-10-15")).toBe("2025-10-15");
    expect(periodStart("ALL", "2026-10-15")).toBe("2000-01-01");
  });
  it("clamps month arithmetic to the last day of the target month", () => {
    expect(periodStart("1M", "2026-03-31")).toBe("2026-02-28");
    expect(periodStart("3M", "2026-05-31")).toBe("2026-02-28");
    expect(periodStart("3M", "2028-05-31")).toBe("2028-02-29");
    expect(periodStart("1Y", "2028-02-29")).toBe("2027-02-28");
    expect(periodStart("1M", "2026-01-31")).toBe("2025-12-31");
    expect(periodStart("3M", "2026-02-15")).toBe("2025-11-15");
  });
});

describe("mergeDailyPoints", () => {
  const rows = [
    { date: "2026-10-13", accountId: "A", currency: "CAD", value: 100, source: "reported" as const },
    { date: "2026-10-13", accountId: "B", currency: "CAD", value: 50, source: "reported" as const },
    { date: "2026-10-14", accountId: "C", currency: "CAD", value: 160, source: "estimated" as const },
    { date: "2026-10-14", accountId: "A", currency: "USD", value: 999, source: "reported" as const },
  ];
  it("sums accounts per day in one currency, keeps the weakest source label, appends today", () => {
    expect(mergeDailyPoints(rows, "CAD", "2026-10-01", "2026-10-15", 170)).toEqual([
      { date: "2026-10-13", value: 150, source: "reported" },
      { date: "2026-10-14", value: 160, source: "estimated" },
      { date: "2026-10-15", value: 170, source: "reported" },
    ]);
  });
  it("picks reported over reconstructed per account and day, then sums accounts", () => {
    const mixed = [
      { date: "2026-10-13", accountId: "A", currency: "CAD", value: 90, source: "reconstructed" as const },
      { date: "2026-10-13", accountId: "A", currency: "CAD", value: 100, source: "reported" as const },
      { date: "2026-10-13", accountId: "B", currency: "CAD", value: 50, source: "reconstructed" as const },
      { date: "2026-10-12", accountId: "A", currency: "CAD", value: 70, source: "estimated" as const },
      { date: "2026-10-12", accountId: "A", currency: "CAD", value: 75, source: "reconstructed" as const },
    ];
    expect(mergeDailyPoints(mixed, "CAD", "2026-10-01", "2026-10-15", null)).toEqual([
      { date: "2026-10-12", value: 75, source: "reconstructed" },
      { date: "2026-10-13", value: 150, source: "reconstructed" },
    ]);
  });
  it("carries an account's last value across a gap inside its own window", () => {
    const gap = [
      { date: "2026-10-10", accountId: "A", currency: "CAD", value: 100, source: "reported" as const },
      { date: "2026-10-10", accountId: "B", currency: "CAD", value: 50, source: "reconstructed" as const },
      { date: "2026-10-11", accountId: "A", currency: "CAD", value: 100, source: "reported" as const },
      { date: "2026-10-12", accountId: "A", currency: "CAD", value: 100, source: "reported" as const },
      { date: "2026-10-12", accountId: "B", currency: "CAD", value: 55, source: "reconstructed" as const },
    ];
    expect(mergeDailyPoints(gap, "CAD", "2026-10-01", "2026-10-15", null).map((p) => [p.date, p.value, p.source])).toEqual([
      ["2026-10-10", 150, "reconstructed"], ["2026-10-11", 150, "reconstructed"], ["2026-10-12", 155, "reconstructed"],
    ]);
  });
  it("contributes nothing before an account's first row or after its last row", () => {
    const r = [
      { date: "2026-10-10", accountId: "A", currency: "CAD", value: 100, source: "reported" as const },
      { date: "2026-10-11", accountId: "A", currency: "CAD", value: 100, source: "reported" as const },
      { date: "2026-10-11", accountId: "B", currency: "CAD", value: 50, source: "reported" as const },
      { date: "2026-10-12", accountId: "B", currency: "CAD", value: 50, source: "reported" as const },
    ];
    expect(mergeDailyPoints(r, "CAD", "2026-10-01", "2026-10-15", null).map((p) => p.value)).toEqual([100, 150, 50]);
  });
  it("replaces a stored row dated today with todayValue and ignores later rows", () => {
    const r = [
      { date: "2026-10-14", accountId: "A", currency: "CAD", value: 100, source: "reported" as const },
      { date: "2026-10-15", accountId: "A", currency: "CAD", value: 111, source: "reported" as const },
      { date: "2026-10-16", accountId: "A", currency: "CAD", value: 222, source: "reported" as const },
    ];
    expect(mergeDailyPoints(r, "CAD", "2026-10-01", "2026-10-15", 170)).toEqual([
      { date: "2026-10-14", value: 100, source: "reported" }, { date: "2026-10-15", value: 170, source: "reported" },
    ]);
  });
  it("F1: ignores derived rows on or after an account's first reported row (no weekend sawtooth)", () => {
    // Fri 10-09 and Mon 10-12 reported; Sat/Sun derived at a different level.
    const r = [
      { date: "2026-10-07", accountId: "A", currency: "CAD", value: 90, source: "reconstructed" as const },
      { date: "2026-10-09", accountId: "A", currency: "CAD", value: 100, source: "reported" as const },
      { date: "2026-10-10", accountId: "A", currency: "CAD", value: 130, source: "reconstructed" as const },
      { date: "2026-10-11", accountId: "A", currency: "CAD", value: 70, source: "estimated" as const },
      { date: "2026-10-12", accountId: "A", currency: "CAD", value: 101, source: "reported" as const },
    ];
    expect(mergeDailyPoints(r, "CAD", "2026-10-01", "2026-10-15", null).map((p) => [p.date, p.value, p.source])).toEqual([
      ["2026-10-07", 90, "reconstructed"], ["2026-10-09", 100, "reported"], ["2026-10-12", 101, "reported"],
    ]);
    // A second account keeps the weekend dates in the series; A carries its Friday value across them.
    const withB = [...r, ...["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"].map((date) => ({ date, accountId: "B", currency: "CAD", value: 5, source: "reconstructed" as const }))];
    expect(mergeDailyPoints(withB, "CAD", "2026-10-01", "2026-10-15", null).map((p) => [p.date, p.value])).toEqual([
      ["2026-10-07", 90], ["2026-10-09", 105], ["2026-10-10", 105], ["2026-10-11", 105], ["2026-10-12", 106],
    ]);
  });
  it("returns a single point series on day one", () => {
    expect(mergeDailyPoints([], "CAD", "2026-01-01", "2026-10-15", 170)).toEqual([{ date: "2026-10-15", value: 170, source: "reported" }]);
  });
  it("starts ALL at the earliest row when known", () => {
    expect(periodStart("ALL", "2026-10-15", "2024-03-04")).toBe("2024-03-04");
  });
});

describe("benchmarkSeries", () => {
  it("rebases a USD index to 0% and converts it to CAD", async () => {
    const market = {
      history: vi.fn(async () => [{ date: "2026-10-13", close: 100 }, { date: "2026-10-14", close: 110 }]),
      usdCad: vi.fn(async () => [{ date: "2026-10-13", close: 1.4 }, { date: "2026-10-14", close: 1.33 }]),
    };
    const series = await benchmarkSeries(market, "sp500", "2026-10-13", "2026-10-14");
    expect(market.history).toHaveBeenCalledWith("^SP500TR", "2026-10-13", "2026-10-14");
    expect(series.points).toEqual([{ date: "2026-10-13", returnFraction: 0 }, { date: "2026-10-14", returnFraction: expect.closeTo((110 * 1.33) / (100 * 1.4) - 1, 8) }]);
    expect(series.explainer).toMatch(/Bank of Canada/);
  });
  it("uses CAD benchmarks without FX", async () => {
    const market = { history: vi.fn(async () => [{ date: "2026-10-13", close: 20 }, { date: "2026-10-14", close: 21 }]), usdCad: vi.fn() };
    const series = await benchmarkSeries(market, "tsx", "2026-10-13", "2026-10-14");
    expect(market.usdCad).not.toHaveBeenCalled();
    expect(series.points?.at(-1)?.returnFraction).toBeCloseTo(0.05, 8);
  });
  it("does not convert a USD index for a USD scope", async () => {
    const market = { history: vi.fn(async () => [{ date: "2026-10-13", close: 100 }, { date: "2026-10-14", close: 110 }]), usdCad: vi.fn() };
    const series = await benchmarkSeries(market, "sp500", "2026-10-13", "2026-10-14", "USD");
    expect(market.usdCad).not.toHaveBeenCalled();
    expect(series.points?.at(-1)?.returnFraction).toBeCloseTo(0.1, 8);
  });
  it("divides a CAD index by USD/CAD for a USD scope", async () => {
    const market = {
      history: vi.fn(async () => [{ date: "2026-10-13", close: 20 }, { date: "2026-10-14", close: 21 }]),
      usdCad: vi.fn(async () => [{ date: "2026-10-13", close: 1.25 }, { date: "2026-10-14", close: 1.5 }]),
    };
    const series = await benchmarkSeries(market, "tsx", "2026-10-13", "2026-10-14", "USD");
    expect(series.points?.at(-1)?.returnFraction).toBeCloseTo((21 / 1.5) / (20 / 1.25) - 1, 8);
  });
  it("reports unavailability instead of a flat line", async () => {
    const market = { history: vi.fn(async () => null), usdCad: vi.fn(async () => null) };
    const series = await benchmarkSeries(market, "sp500", "2026-10-13", "2026-10-14");
    expect(series).toMatchObject({ points: null, unavailableReason: "Benchmark data unavailable" });
  });
  it("reports missing FX instead of a USD-only line", async () => {
    const market = { history: vi.fn(async () => [{ date: "2026-10-13", close: 100 }, { date: "2026-10-14", close: 110 }]), usdCad: vi.fn(async () => null) };
    const series = await benchmarkSeries(market, "sp500", "2026-10-13", "2026-10-14");
    expect(series).toMatchObject({ points: null, unavailableReason: "Exchange rate unavailable" });
  });
  it("drops points before the first FX observation when two or more remain", async () => {
    const market = {
      history: vi.fn(async () => [{ date: "2026-10-12", close: 90 }, { date: "2026-10-13", close: 100 }, { date: "2026-10-14", close: 110 }]),
      usdCad: vi.fn(async () => [{ date: "2026-10-13", close: 1.4 }, { date: "2026-10-14", close: 1.4 }]),
    };
    const series = await benchmarkSeries(market, "sp500", "2026-10-12", "2026-10-14");
    expect(series.points?.map((p) => p.date)).toEqual(["2026-10-13", "2026-10-14"]);
    expect(series.points?.[0].returnFraction).toBe(0);
  });
  it("falls back to the first FX rate when dropping would leave fewer than two points", async () => {
    const market = {
      history: vi.fn(async () => [{ date: "2026-10-12", close: 100 }, { date: "2026-10-13", close: 110 }]),
      usdCad: vi.fn(async () => [{ date: "2026-10-14", close: 1.4 }]),
    };
    const series = await benchmarkSeries(market, "sp500", "2026-10-12", "2026-10-14");
    expect(series.points).toHaveLength(2);
    expect(series.points?.[1].returnFraction).toBeCloseTo(0.1, 8);
  });
});

describe("clipBenchmark baseline (F1)", () => {
  const bench = (points: Array<[string, number]>) => ({ key: "sp500" as const, name: "S&P 500", explainer: "", unavailableReason: null,
    points: points.map(([date, close]) => ({ date, returnFraction: close / points[0][1] - 1 })) });
  it("rebases on the last close before a holiday start, so the first market day counts", () => {
    // Span starts Jan 1 (holiday, portfolio carries Dec 31); the index rises 2% on Jan 2.
    const clipped = clipBenchmark(bench([["2025-12-30", 99], ["2025-12-31", 100], ["2026-01-02", 102], ["2026-01-05", 102]]), "2026-01-01", "2026-01-05");
    expect(clipped.points!.map((p) => p.date)).toEqual(["2026-01-01", "2026-01-02", "2026-01-05"]);
    expect(clipped.points![0].returnFraction).toBe(0);
    expect(clipped.points!.at(-1)!.returnFraction).toBeCloseTo(0.02, 12);
  });
  it("rebases on Friday's close for a Saturday start", () => {
    const clipped = clipBenchmark(bench([["2026-03-05", 90], ["2026-03-06", 100], ["2026-03-09", 103], ["2026-03-10", 103]]), "2026-03-07", "2026-03-10");
    expect(clipped.points!.at(-1)!.returnFraction).toBeCloseTo(0.03, 12);
  });
  it("falls back to the first close in the span when the index has nothing on or before the start", () => {
    const clipped = clipBenchmark(bench([["2026-01-02", 100], ["2026-01-05", 110]]), "2026-01-01", "2026-01-05");
    expect(clipped.points!.map((p) => p.date)).toEqual(["2026-01-02", "2026-01-05"]);
    expect(clipped.points!.at(-1)!.returnFraction).toBeCloseTo(0.1, 12);
  });
});

describe("valuedScope (brief 6)", () => {
  it("adds join and leave flows from the merged precedence values and scopes flows to valued days", async () => {
    const { valuedScope } = await import("./value-series.js");
    const d = (i: number) => `2026-03-${String(i).padStart(2, "0")}`;
    const rows = [
      ...[1, 2, 3, 4, 5, 6].map((i) => ({ date: d(i), accountId: "T", currency: "CAD", value: 100, source: "reported" as const })),
      { date: d(3), accountId: "C", currency: "CAD", value: 40, source: "reconstructed" as const },
      { date: d(3), accountId: "C", currency: "CAD", value: 50, source: "reported" as const },
      { date: d(4), accountId: "C", currency: "CAD", value: 60, source: "reported" as const },
    ];
    const s = valuedScope(rows, "CAD", d(1), d(7), new Map([["T", 100]]));
    expect(Object.fromEntries(s.joinLeave)).toEqual({ [d(3)]: 50, [d(5)]: -60 });
    expect(s.inScope("C", d(2))).toBe(false);
    expect(s.inScope("C", d(3))).toBe(false); // the join value already includes the day's flows
    expect(s.inScope("C", d(4))).toBe(true);
    expect(s.inScope("C", d(5))).toBe(false);
    expect(s.inScope("T", d(7))).toBe(true);
    expect(s.inScope("X", d(4))).toBe(false);
  });

  it("joinCovers: a flow outside the window is in the join value only when the account is first valued soon after", async () => {
    const { valuedScope, JOIN_GRACE_DAYS } = await import("./value-series.js");
    const d = (i: number) => `2026-03-${String(i).padStart(2, "0")}`;
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => ({ date: d(i + 1), accountId: "T", currency: "CAD", value: 100, source: "reported" as const })),
      ...[12, 13, 14, 15].map((i) => ({ date: d(i), accountId: "N", currency: "CAD", value: 10, source: "reported" as const })),
    ];
    const s = valuedScope(rows, "CAD", d(1), d(20), null);
    expect(s.joinCovers("N", d(12))).toBe(true); // on the join date
    expect(s.joinCovers("N", d(12 - JOIN_GRACE_DAYS))).toBe(true);
    expect(s.joinCovers("N", d(11 - JOIN_GRACE_DAYS))).toBe(false); // too long before its first value
    expect(s.joinCovers("N", d(17))).toBe(false); // after it stopped being valued: no join follows
    expect(s.joinCovers("X", d(5))).toBe(false); // never valued
  });
});

describe("valuedScope join sources (brief 9, I3/M3)", () => {
  const d = (i: number) => `2026-03-${String(i).padStart(2, "0")}`;
  it("splits joins from leaves and flags a join valued from a non-reported row", async () => {
    const { valuedScope } = await import("./value-series.js");
    const rows = [
      ...[1, 2, 3, 4, 5, 6].map((i) => ({ date: d(i), accountId: "T", currency: "CAD", value: 100, source: "reported" as const })),
      { date: d(3), accountId: "C", currency: "CAD", value: 40, source: "reconstructed" as const },
      { date: d(4), accountId: "C", currency: "CAD", value: 60, source: "reconstructed" as const },
    ];
    const s = valuedScope(rows, "CAD", d(1), d(7), new Map([["T", 100]]));
    expect(Object.fromEntries(s.joins)).toEqual({ [d(3)]: 40 });
    expect(Object.fromEntries(s.leaves)).toEqual({ [d(5)]: -60 });
    expect(s.joinLeaveEstimated).toBe(true);
    const reported = valuedScope(rows.map((r) => ({ ...r, source: "reported" as const })), "CAD", d(1), d(7), new Map([["T", 100]]));
    expect(reported.joinLeaveEstimated).toBe(false);
  });
});
