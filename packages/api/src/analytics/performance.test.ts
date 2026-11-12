import { describe, expect, it } from "vitest";
import { annualise, computePerformance, twr, xirr } from "./performance.js";
import type { SeriesPoint } from "./value-series.js";

const v = (date: string, value: number, source: SeriesPoint["source"] = "reported"): SeriesPoint => ({ date, value, source });
const flows = (o: Record<string, number>, unknown: string[] = []) => ({ byDate: new Map(Object.entries(o)), unknownDates: new Set(unknown) });
const days = (start: string, n: number, f: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => { const d = new Date(`${start}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return v(d.toISOString().slice(0, 10), f(i)); });
/** n consecutive weekdays from `start` (Sat/Sun skipped). */
const weekdays = (start: string, n: number, f: (i: number) => number) => {
  const out: SeriesPoint[] = [];
  for (const d = new Date(`${start}T00:00:00Z`); out.length < n; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(v(d.toISOString().slice(0, 10), f(out.length)));
  }
  return out;
};

describe("xirr", () => {
  it("one year, invest 1000, get 1100 → 10%", () => {
    expect(xirr([{ date: "2025-01-01", amount: -1000 }, { date: "2026-01-01", amount: 1100 }])!).toBeCloseTo(0.1, 6);
  });
  it("mid-year deposit: -1000 at t0, -1000 at ~0.5y, +2200 at 1y", () => {
    // 183 days = 0.50137y. Solve −1000 − 1000/(1+r)^0.50137 + 2200/(1+r) = 0 → r ≈ 0.13488
    const r = xirr([{ date: "2025-01-01", amount: -1000 }, { date: "2025-07-03", amount: -1000 }, { date: "2026-01-01", amount: 2200 }]);
    expect(r!).toBeCloseTo(0.13488, 3);
  });
  it("no sign change → null", () => {
    expect(xirr([{ date: "2025-01-01", amount: -1000 }, { date: "2026-01-01", amount: -5 }])).toBeNull();
  });
});

describe("xirr fallback", () => {
  it("falls back to bisection when Newton diverges (root near -0.9)", () => {
    // Newton from 0.1 jumps below -0.99 on the first step; bisection finds -0.9.
    expect(xirr([{ date: "2025-01-01", amount: -1000 }, { date: "2026-01-01", amount: 100 }])!).toBeCloseTo(-0.9, 6);
  });
});

describe("twr", () => {
  it("flows at start of day do not count as return", () => {
    // 100 → 110 (+10%), then deposit 100 at start of day 3, value 231 → 231/(110+100) = +10%
    const { index } = twr([v("2026-01-01", 100), v("2026-01-02", 110), v("2026-01-03", 231)], new Map([["2026-01-03", 100]]));
    expect(index.map((p) => +p.value.toFixed(6))).toEqual([1, 1.1, 1.21]);
  });
  it("skips a zero-denominator day", () => {
    const { index } = twr([v("2026-01-01", 100), v("2026-01-02", 0.0), v("2026-01-03", 50)], new Map([["2026-01-02", -100]]));
    expect(index.every((p) => Number.isFinite(p.value) && p.value > 0)).toBe(true);
  });
});

describe("computePerformance", () => {
  it("separates deposits from market gain and compares TWR with the benchmark", () => {
    const values = [v("2026-01-02", 1000), v("2026-01-05", 1100), v("2026-01-06", 1650), v("2026-01-07", 1700), v("2026-01-08", 1760)];
    const r = computePerformance({ values, flows: flows({ "2026-01-06": 500 }), periodStart: "2026-01-01",
      benchmark: [{ date: "2026-01-02", returnFraction: 0 }, { date: "2026-01-08", returnFraction: 0.05 }] });
    expect(r.figures.valueChange.value).toBe(760);
    expect(r.figures.netDeposits.value).toBe(500);
    expect(r.figures.marketGain.value).toBe(260);
    // TWR: 1.1 × (1650/1600) × (1700/1650) × (1760/1700) = 1.1 × 1.1 = 1.21
    expect(r.figures.investmentReturn.value!).toBeCloseTo(0.21, 6);
    expect(r.figures.benchmarkReturn.value!).toBeCloseTo(0.05, 9);
    expect(r.figures.personalReturn.annualised).toBe(false);
    expect(r.span).toEqual({ start: "2026-01-02", end: "2026-01-08", partial: false });
  });

  it("a flow on a date without a value point applies to the next valued day", () => {
    const values = [v("2026-01-02", 1000), v("2026-01-05", 1500), v("2026-01-06", 1500), v("2026-01-07", 1500), v("2026-01-08", 1500)];
    const r = computePerformance({ values, flows: flows({ "2026-01-03": 500 }), periodStart: "2026-01-02", benchmark: null });
    expect(r.figures.netDeposits.value).toBe(500);
    expect(r.figures.investmentReturn.value!).toBeCloseTo(0, 9);
  });

  it("starts at the first positive value when an account opens mid-period", () => {
    const values = [v("2026-01-02", 0), v("2026-01-03", 0), ...days("2026-01-12", 6, (i) => 1000 + i * 10)];
    const r = computePerformance({ values, flows: flows({}), periodStart: "2026-01-01", benchmark: null });
    expect(r.span.start).toBe("2026-01-12");
    expect(r.span.partial).toBe(true);
    expect(Number.isFinite(r.figures.investmentReturn.value!)).toBe(true);
  });

  it("fewer than 5 points → insufficient history, nothing extrapolated", () => {
    const r = computePerformance({ values: [v("2026-01-02", 1000), v("2026-01-05", 1010)], flows: flows({}), periodStart: "2026-01-01", benchmark: null });
    expect(r.figures.investmentReturn).toMatchObject({ value: null, reason: "insufficient_history" });
    expect(r.figures.personalReturn).toMatchObject({ value: null, reason: "insufficient_history" });
    expect(r.figures.valueChange.value).toBe(10);
  });

  it("drawdown is measured on the TWR index, so a big deposit does not hide a fall", () => {
    // Market falls 10% then recovers; a deposit on the fall day would hide it in raw values.
    const values = [v("2026-01-02", 1000), v("2026-01-05", 900), v("2026-01-06", 10900), v("2026-01-07", 11000), v("2026-01-08", 11100)];
    const r = computePerformance({ values, flows: flows({ "2026-01-06": 10000 }), periodStart: "2026-01-02", benchmark: null });
    expect(r.figures.maxDrawdown.value!).toBeCloseTo(-0.1, 6);
    expect(r.figures.maxDrawdown).toMatchObject({ peak: "2026-01-02", trough: "2026-01-05" });
  });

  it("volatility needs 20 returns; annualises with √252", () => {
    // F6: weekday points only, so the 21 points are weekdays.
    const alternating = weekdays("2026-01-01", 21, (i) => (i % 2 === 0 ? 100 : 101));
    const r = computePerformance({ values: alternating, flows: flows({}), periodStart: "2026-01-01", benchmark: null });
    // 20 returns alternating +1% and −0.990099%; deviations ±0.0099505; sample stdev = 0.0099505·√(20/19) ≈ 0.010209 → × √252 ≈ 0.16206
    expect(r.figures.volatility.value!).toBeCloseTo(0.16206, 3);
    const short = computePerformance({ values: alternating.slice(0, 10), flows: flows({}), periodStart: "2026-01-01", benchmark: null });
    expect(short.figures.volatility).toMatchObject({ value: null, reason: "insufficient_history" });
  });

  it("monthly returns chain from the index; partial months are not best/worst", () => {
    const values = [v("2026-01-15", 100), v("2026-01-31", 110), v("2026-02-27", 99), v("2026-03-31", 108.9), v("2026-04-10", 108.9)];
    const r = computePerformance({ values, flows: flows({}), periodStart: "2026-01-01", benchmark: null });
    expect(r.monthly.map((m) => [m.month, m.return === null ? null : +m.return.toFixed(4), m.partial])).toEqual([
      ["2026-01", 0.1, true], ["2026-02", -0.1, false], ["2026-03", 0.1, false], ["2026-04", 0, true],
    ]);
    expect(r.figures.bestMonth).toMatchObject({ month: "2026-03" });
    expect(r.figures.worstMonth).toMatchObject({ month: "2026-02" });
  });

  it("estimated points and unknown flows mark figures estimated; missing flows null the flow-based figures", () => {
    const values = [v("2026-01-02", 1000), v("2026-01-05", 1010, "estimated"), v("2026-01-06", 1020), v("2026-01-07", 1030), v("2026-01-08", 1040)];
    const r = computePerformance({ values, flows: flows({}, ["2026-01-06"]), periodStart: "2026-01-02", benchmark: null });
    expect(r.figures.investmentReturn.estimated).toBe(true);
    expect(r.figures.netDeposits.estimated).toBe(true);
    const none = computePerformance({ values, flows: null, periodStart: "2026-01-02", benchmark: null });
    expect(none.figures.personalReturn).toMatchObject({ value: null, reason: "flows_unavailable" });
    expect(none.figures.investmentReturn.value).not.toBeNull();
  });

  it("a first value within 4 days of the period start is not partial", () => {
    const r = computePerformance({ values: days("2026-01-05", 5, (i) => 1000 + i), flows: flows({}), periodStart: "2026-01-01", benchmark: null });
    expect(r.span.partial).toBe(false);
    expect(r.span.since).toBeUndefined();
  });

  it("an interior zero value is skipped, not a -100% day", () => {
    const r = computePerformance({ values: [v("2026-01-02", 1000), v("2026-01-03", 0), v("2026-01-04", 1000), v("2026-01-05", 1000), v("2026-01-06", 1000)], flows: flows({}), periodStart: "2026-01-02", benchmark: null });
    expect(r.figures.investmentReturn.value!).toBeCloseTo(0, 9);
    expect(r.figures.maxDrawdown.value!).toBeCloseTo(0, 9);
    expect(r.figures.investmentReturn.estimated).toBe(true);
    expect(r.figures.maxDrawdown.estimated).toBe(true);
  });

  it("an unknown flow date marks return, drawdown and its month estimated", () => {
    const r = computePerformance({ values: days("2026-01-29", 6, (i) => 1000 + i), flows: flows({}, ["2026-02-02"]), periodStart: "2026-01-29", benchmark: null });
    expect(r.figures.investmentReturn.estimated).toBe(true);
    expect(r.figures.maxDrawdown.estimated).toBe(true);
    expect(r.monthly.map((m) => [m.month, m.estimated])).toEqual([["2026-01", false], ["2026-02", true]]);
    const clean = computePerformance({ values: days("2026-01-29", 6, (i) => 1000 + i), flows: flows({}), periodStart: "2026-01-29", benchmark: null });
    expect(clean.figures.investmentReturn.estimated).toBe(false);
  });

  it("short span: period return solved directly (7 days, 1000 → 1150)", () => {
    const r = computePerformance({ values: days("2026-01-01", 8, (i) => (i === 7 ? 1150 : 1000 + i * 10)), flows: flows({}), periodStart: "2026-01-01", benchmark: null });
    expect(r.figures.personalReturn.value!).toBeCloseTo(0.15, 6);
    expect(r.figures.personalReturn.annualised).toBe(false);
  });

  it("short span with a mid-span deposit", () => {
    // 8-day span, deposit 500 at day 4 (t = 0.5): 1000·1.21 + 500·1.21^0.5 = 1210 + 550 = 1760 → r = 0.21
    const values = days("2026-01-01", 9, (i) => (i === 8 ? 1760 : 1000 + i * 20));
    const r = computePerformance({ values, flows: flows({ "2026-01-05": 500 }), periodStart: "2026-01-01", benchmark: null });
    expect(r.figures.personalReturn.value!).toBeCloseTo(0.21, 6);
  });

  it("a 365-day span is annualised", () => {
    const values = [v("2025-01-01", 1000), v("2025-04-01", 1020), v("2025-07-01", 1040), v("2025-10-01", 1060), v("2026-01-01", 1100)];
    const r = computePerformance({ values, flows: flows({}), periodStart: "2025-01-01", benchmark: null });
    expect(r.figures.personalReturn.annualised).toBe(true);
    expect(r.figures.personalReturn.value!).toBeCloseTo(0.1, 6);
  });

  it("clips the benchmark to the span and rebases it", () => {
    const bench = [
      { date: "2026-01-01", returnFraction: 0.02 }, { date: "2026-01-02", returnFraction: 0.1 }, { date: "2026-01-05", returnFraction: 0.21 },
      { date: "2026-01-08", returnFraction: 0.331 }, { date: "2026-01-09", returnFraction: 0.5 },
    ];
    const r = computePerformance({ values: days("2026-01-02", 7, (i) => 1000 + i), flows: flows({}), periodStart: "2026-01-02", benchmark: bench });
    expect(r.figures.benchmarkReturn.value!).toBeCloseTo(0.21, 9);
    expect(r.series.benchmarkIndex.map((p) => +p.value.toFixed(6))).toEqual([1, 1.1, 1.21]);
  });

  it("excludes a flow on the start date and ignores one after the end", () => {
    const r = computePerformance({ values: days("2026-01-02", 5, (i) => 1000 + i), flows: flows({ "2026-01-02": 500, "2026-02-01": 900 }), periodStart: "2026-01-02", benchmark: null });
    expect(r.figures.netDeposits.value).toBe(0);
    expect(r.figures.marketGain.value).toBe(4);
  });

  it("missing flows give flows_unavailable on netDeposits and marketGain", () => {
    const r = computePerformance({ values: days("2026-01-02", 5, (i) => 1000 + i), flows: null, periodStart: "2026-01-02", benchmark: null });
    expect(r.figures.netDeposits).toMatchObject({ value: null, reason: "flows_unavailable" });
    expect(r.figures.marketGain).toMatchObject({ value: null, reason: "flows_unavailable" });
  });

  it("all-zero input yields insufficient history everywhere without throwing", () => {
    const r = computePerformance({ values: days("2026-01-02", 6, () => 0), flows: flows({}), periodStart: "2026-01-01", benchmark: [{ date: "2026-01-02", returnFraction: 0 }] });
    for (const f of Object.values(r.figures)) expect(f).toMatchObject({ value: null });
    expect(r.figures.investmentReturn.reason).toBe("insufficient_history");
    expect(r.monthly).toEqual([]);
  });

  it("sorts unsorted input and does not mark January partial for a Jan 2 YTD start", () => {
    const sorted = days("2026-01-02", 40, (i) => 1000 + i);
    const r = computePerformance({ values: [...sorted].reverse(), flows: flows({}), periodStart: "2026-01-01", benchmark: null });
    expect(r.span.start).toBe("2026-01-02");
    expect(r.monthly[0].partial).toBe(false);
  });
});

describe("benchmark baseline (F1)", () => {
  it("a holiday start (Jan 1) compares the same day's move for portfolio and index", () => {
    // Jan 1 row = Dec 31 value; the market and portfolio both rise 2% on Jan 2 then stay flat.
    const values = [v("2026-01-01", 1000), v("2026-01-02", 1020), v("2026-01-05", 1020), v("2026-01-06", 1020), v("2026-01-07", 1020)];
    const benchmark = [{ date: "2025-12-31", returnFraction: 0 }, { date: "2026-01-02", returnFraction: 0.02 }, { date: "2026-01-05", returnFraction: 0.02 }, { date: "2026-01-07", returnFraction: 0.02 }];
    const r = computePerformance({ values, flows: flows({}), periodStart: "2026-01-01", benchmark });
    expect(r.figures.investmentReturn.value!).toBeCloseTo(0.02, 9);
    expect(r.figures.benchmarkReturn.value!).toBeCloseTo(0.02, 9);
    expect(r.series.benchmarkIndex[0]).toEqual({ date: "2026-01-01", value: 1 });
  });
  it("a weekend start rebases on Friday's close", () => {
    const values = days("2026-03-07", 6, (i) => (i < 2 ? 1000 : 1030));
    const benchmark = [{ date: "2026-03-06", returnFraction: 0.5 }, { date: "2026-03-09", returnFraction: 0.545 }, { date: "2026-03-12", returnFraction: 0.545 }];
    const r = computePerformance({ values, flows: flows({}), periodStart: "2026-03-07", benchmark });
    expect(r.figures.investmentReturn.value!).toBeCloseTo(0.03, 9);
    expect(r.figures.benchmarkReturn.value!).toBeCloseTo(0.03, 9);
  });
});

describe("incomplete flows (F4)", () => {
  it("flows known to be incomplete mark every flow-based figure and month estimated", () => {
    const values = days("2026-01-29", 8, (i) => 1000 + i);
    const r = computePerformance({ values, flows: { ...flows({}), incomplete: true }, periodStart: "2026-01-29", benchmark: null });
    for (const k of ["personalReturn", "investmentReturn", "netDeposits", "marketGain", "maxDrawdown"] as const) expect(r.figures[k].estimated).toBe(true);
    expect(r.figures.netDeposits.value).toBe(0);
    expect(r.monthly.every((m) => m.estimated)).toBe(true);
  });
});

describe("weekday-only volatility (F6)", () => {
  it("calendar-daily rows (0% weekends) give the same volatility as the weekday series", () => {
    const wk = weekdays("2026-01-05", 30, (i) => 1000 * (1 + 0.01 * Math.sin(i)));
    // Calendar version: Sat/Sun carry Friday's value, as reconstructed rows do.
    const calendar: SeriesPoint[] = [];
    for (let i = 0; i < wk.length; i++) {
      calendar.push(wk[i]);
      const d = new Date(`${wk[i].date}T00:00:00Z`);
      if (d.getUTCDay() === 5 && i < wk.length - 1) for (const k of [1, 2]) { d.setUTCDate(d.getUTCDate() + 1); calendar.push(v(d.toISOString().slice(0, 10), wk[i].value)); }
    }
    const a = computePerformance({ values: wk, flows: flows({}), periodStart: "2026-01-05", benchmark: null });
    const b = computePerformance({ values: calendar, flows: flows({}), periodStart: "2026-01-05", benchmark: null });
    expect(b.figures.volatility.value!).toBeCloseTo(a.figures.volatility.value!, 12);
    expect(b.figures.investmentReturn.value!).toBeCloseTo(a.figures.investmentReturn.value!, 12);
  });
  it("a weekend flow is folded into the next weekday", () => {
    // 2026-01-10 is a Saturday: 500 deposited, Saturday row already shows it.
    const base = weekdays("2026-01-05", 25, (i) => 1000 * (1 + 0.01 * Math.sin(i)));
    const withFlow = base.map((p) => (p.date >= "2026-01-12" ? { ...p, value: p.value + 500 } : p));
    const calendar = [...withFlow.slice(0, 5), v("2026-01-10", withFlow[4].value + 500), v("2026-01-11", withFlow[4].value + 500), ...withFlow.slice(5)];
    const clean = computePerformance({ values: base, flows: flows({}), periodStart: "2026-01-05", benchmark: null });
    const r = computePerformance({ values: calendar, flows: flows({ "2026-01-10": 500 }), periodStart: "2026-01-05", benchmark: null });
    expect(r.figures.netDeposits.value).toBe(500);
    expect(Number.isFinite(r.figures.volatility.value!)).toBe(true);
    // Return magnitudes differ only through the larger base after the deposit.
    expect(r.figures.volatility.value!).toBeGreaterThan(clean.figures.volatility.value! * 0.5);
    expect(r.figures.volatility.value!).toBeLessThan(clean.figures.volatility.value! * 1.5);
  });
});

describe("deposit lag merge for risk metrics (F7)", () => {
  it("reports the merged-away day so the drawdown chart can match the figure (N2)", () => {
    const values = weekdays("2026-01-05", 6, (i) => (i < 3 ? 10_000 : 20_000)).map((p) => (p.date === "2026-01-07" ? { ...p, value: 10_000 } : p));
    const r = computePerformance({ values, flows: flows({ "2026-01-07": 10_000 }), periodStart: "2026-01-05", benchmark: null });
    expect(r.series.riskMergedDates).toEqual(["2026-01-07"]);
  });
  it("a small flow on a noisy day is not treated as a lag (N4)", () => {
    // 1% deposit; the market dips then recovers by more than half the flow's share.
    const base = [10_000, 10_000, 9_950, 10_200, 10_200, 10_200];
    const values = weekdays("2026-01-05", 6, (i) => base[i]);
    const r = computePerformance({ values, flows: flows({ "2026-01-07": 100 }), periodStart: "2026-01-05", benchmark: null });
    expect(r.series.riskMergedDates).toEqual([]);
    expect(r.figures.maxDrawdown.estimated).toBe(false);
  });
  it("missing flows mark TWR, risk and monthly figures estimated (N1)", () => {
    const values = weekdays("2026-01-05", 6, (i) => 1000 + i);
    const r = computePerformance({ values, flows: null, periodStart: "2026-01-05", benchmark: null });
    expect(r.figures.investmentReturn.estimated).toBe(true);
    expect(r.figures.maxDrawdown.estimated).toBe(true);
    expect(r.monthly.every((m) => m.estimated)).toBe(true);
  });
  it("the review's case: a 10k deposit into a 10k account that shows a day late is not a -50% drawdown", () => {
    // Deposit dated Wed 2026-01-07; the snapshot reflects it only on Thu.
    const values = weekdays("2026-01-05", 6, (i) => (i < 3 ? 10_000 : 20_000)).map((p) => (p.date === "2026-01-07" ? { ...p, value: 10_000 } : p));
    const r = computePerformance({ values, flows: flows({ "2026-01-07": 10_000 }), periodStart: "2026-01-05", benchmark: null });
    expect(r.figures.investmentReturn.value!).toBeCloseTo(0, 12); // total TWR unchanged by the merge
    expect(r.figures.maxDrawdown.value!).toBeCloseTo(0, 12);
    expect(r.figures.maxDrawdown.estimated).toBe(true);
    expect(r.series.twrIndex.find((p) => p.date === "2026-01-07")!.value).toBeCloseTo(0.5, 12); // display index unchanged
  });
  it("a withdrawal that shows a day late is merged too", () => {
    const values = weekdays("2026-01-05", 6, (i) => (i < 3 ? 10_000 : 5_000)).map((p) => (p.date === "2026-01-07" ? { ...p, value: 10_000 } : p));
    const r = computePerformance({ values, flows: flows({ "2026-01-07": -5_000 }), periodStart: "2026-01-05", benchmark: null });
    expect(r.figures.maxDrawdown.value!).toBeCloseTo(0, 12);
    expect(r.figures.maxDrawdown.estimated).toBe(true);
  });
  it("an on-time deposit with ordinary market moves is not merged", () => {
    const values = [v("2026-01-05", 10_000), v("2026-01-06", 10_000), v("2026-01-07", 19_800), v("2026-01-08", 20_100), v("2026-01-09", 20_100)];
    const r = computePerformance({ values, flows: flows({ "2026-01-07": 10_000 }), periodStart: "2026-01-05", benchmark: null });
    expect(r.figures.maxDrawdown.value!).toBeCloseTo(19_800 / 20_000 - 1, 9);
    expect(r.figures.maxDrawdown.estimated).toBe(false);
  });
  it("a reversal with no flow is a real drawdown", () => {
    const values = [v("2026-01-05", 10_000), v("2026-01-06", 10_000), v("2026-01-07", 5_000), v("2026-01-08", 10_000), v("2026-01-09", 10_000)];
    const r = computePerformance({ values, flows: flows({}), periodStart: "2026-01-05", benchmark: null });
    expect(r.figures.maxDrawdown.value!).toBeCloseTo(-0.5, 9);
    expect(r.figures.maxDrawdown.estimated).toBe(false);
  });
});

describe("accounts joining the series are not deposits (brief 9, item 6)", () => {
  // Invented data: an account worth 500 joins on day 3; a real 100 deposit lands on day 4.
  const values = days("2026-03-02", 6, (i) => [1000, 1000, 1000, 1500, 1600, 1610][i]);
  const input = { values, periodStart: "2026-03-02", benchmark: null, flows: { ...flows({ "2026-03-06": 100 }), joins: new Map([["2026-03-05", 500]]) } };
  it("splits the join value out of net deposits and still subtracts it from market gain", () => {
    const r = computePerformance(input);
    expect(r.figures.netDeposits.value).toBeCloseTo(100, 9);
    expect(r.figures.accountsAddedToTracking.value).toBeCloseTo(500, 9);
    expect(r.figures.marketGain.value).toBeCloseTo(10, 9);
    expect(r.figures.investmentReturn.value).toBeCloseTo(1610 / 1600 - 1, 9);
  });
  it("reports zero accounts added when nobody joins", () => {
    const r = computePerformance({ ...input, flows: flows({ "2026-03-06": 100 }) });
    expect(r.figures.accountsAddedToTracking).toMatchObject({ value: 0, estimated: false });
  });
});

describe("internal moves to accounts not yet tracked are not deposits (brief 9, I2)", () => {
  // Invented: 900 leaves the tracked account on day 2 for an account that joins with 950 on day 4.
  const values = days("2026-03-02", 6, (i) => [1000, 100, 100, 1050, 1050, 1050][i]);
  const input = { values, periodStart: "2026-03-02", benchmark: null,
    flows: { ...flows({}), trackingTransfers: new Map([["2026-03-03", -900]]), joins: new Map([["2026-03-05", 950]]), leaves: new Map([["2026-03-07", -10]]), joinLeaveEstimated: true } };
  it("keeps net deposits at zero and breaks down accounts added to tracking", () => {
    const r = computePerformance(input);
    expect(r.figures.netDeposits.value).toBeCloseTo(0, 9);
    expect(r.figures.accountsAddedToTracking).toMatchObject({ joined: 950, movedFromTracked: -900, left: -10, estimated: true });
    expect(r.figures.accountsAddedToTracking.value).toBeCloseTo(40, 9);
    expect(r.figures.marketGain.value).toBeCloseTo(1050 - 1000 - 40, 9);
  });
  it("still treats the moved leg as a flow for the returns", () => {
    const r = computePerformance(input);
    expect(r.figures.maxDrawdown.value!).toBeGreaterThan(-0.01);
    expect(Math.abs(r.figures.investmentReturn.value!)).toBeLessThan(0.02);
  });
});

describe("yearly rate (CAGR)", () => {
  it("annualises a two-year return and leaves spans under a year alone", () => {
    expect(annualise({ value: 0.21, estimated: true }, 730)).toEqual({ value: expect.closeTo(0.1, 9), estimated: true, years: 2 });
    expect(annualise({ value: 0.1, estimated: false }, 364)).toEqual({ value: null, estimated: false, reason: "under_a_year" });
    expect(annualise({ value: null, estimated: false, reason: "insufficient_history" }, 800)).toEqual({ value: null, estimated: false, reason: "insufficient_history" });
    expect(annualise({ value: -1, estimated: false }, 800).value).toBeNull();
  });

  it("deposits don't move it: same growth with a big deposit mid-way gives the same yearly rate as the index over the span", () => {
    // Two years of daily values growing 10% a year; a deposit doubles the balance half-way.
    const daily = (1.1) ** (1 / 365);
    const values = days("2024-01-01", 731, (i) => 1000 * daily ** i * (i >= 365 ? 2 : 1));
    const bench = values.map((p, i) => ({ date: p.date, returnFraction: 1.05 ** (i / 365) - 1 }));
    const r = computePerformance({ values, flows: flows({ [values[365]!.date]: 1000 * daily ** 364 }), periodStart: "2024-01-01", benchmark: bench });
    expect(r.figures.investmentCagr.value!).toBeCloseTo(0.1, 6);
    expect(r.figures.investmentCagr.years).toBe(2);
    expect(r.figures.benchmarkCagr.value!).toBeCloseTo(0.05, 6);
  });

  it("under a year: no yearly rate", () => {
    const r = computePerformance({ values: days("2026-01-01", 200, (i) => 1000 + i), flows: flows({}), periodStart: "2026-01-01", benchmark: null });
    expect(r.figures.investmentCagr).toEqual({ value: null, estimated: false, reason: "under_a_year" });
  });
});

describe("same money in the index (cash-flow-matched benchmark)", () => {
  // Index flat for the first half, then +20%; a portfolio that holds exactly the index.
  const level = (i: number) => (i < 5 ? 1 : 1.2);
  const dates = ["2025-01-01", "2025-02-01", "2025-03-01", "2025-04-01", "2025-06-30", "2025-09-01", "2025-12-31"];
  const bench = dates.map((date, i) => ({ date, returnFraction: level(i) - 1 }));

  it("replays every deposit into the index on its day: an index-tracking portfolio matches it exactly", () => {
    // 1000 at the start, 1000 more on Jun 30 (before the rise): 2000 of index units, worth 2400 at the end.
    const values = dates.map((date, i) => v(date, i < 4 ? 1000 : 2000 * level(i)));
    const r = computePerformance({ values, flows: flows({ "2025-06-30": 1000 }), periodStart: "2025-01-01", benchmark: bench });
    expect(r.figures.investmentReturn.value!).toBeCloseTo(0.2, 6);
    expect(r.figures.benchmarkReturn.value!).toBeCloseTo(0.2, 6);
    expect(r.figures.personalReturn.value!).toBeGreaterThan(0.25);
    expect(r.figures.matchedBenchmarkReturn.value!).toBeCloseTo(r.figures.personalReturn.value!, 6);
    expect(r.figures.matchedBenchmarkReturn.annualised).toBe(r.figures.personalReturn.annualised);
    expect(r.figures.matchedBenchmarkValue.value!).toBeCloseTo(2400, 6);
  });

  it("with no deposits it is the index's own return", () => {
    const values = dates.map((date, i) => v(date, 1000 + i * 10));
    const r = computePerformance({ values, flows: flows({}), periodStart: "2025-01-01", benchmark: bench });
    expect(r.figures.matchedBenchmarkReturn.value!).toBeCloseTo(0.2, 6);
    expect(r.figures.matchedBenchmarkValue.value!).toBeCloseTo(1200, 6);
  });

  it("a withdrawal larger than the index holding is never shown as a number", () => {
    // The portfolio grew 10x while the index stayed flat, then most of it was taken out.
    const flat = dates.map((date) => ({ date, returnFraction: 0 }));
    const values = [v(dates[0], 1000), v(dates[1], 5000), v(dates[2], 10000), v(dates[3], 2000), v(dates[4], 2000), v(dates[5], 2000), v(dates[6], 2000)];
    const r = computePerformance({ values, flows: flows({ "2025-04-01": -8000 }), periodStart: "2025-01-01", benchmark: flat });
    expect(r.figures.matchedBenchmarkReturn).toMatchObject({ value: null, exhausted: true });
    expect(r.figures.matchedBenchmarkValue.value).toBeNull();
  });

  it("is unavailable without a benchmark or without deposits data", () => {
    const values = dates.map((date, i) => v(date, 1000 + i * 10));
    expect(computePerformance({ values, flows: flows({}), periodStart: "2025-01-01", benchmark: null }).figures.matchedBenchmarkReturn)
      .toMatchObject({ value: null, reason: "benchmark_unavailable" });
    expect(computePerformance({ values, flows: null, periodStart: "2025-01-01", benchmark: bench }).figures.matchedBenchmarkReturn)
      .toMatchObject({ value: null, reason: "flows_unavailable" });
  });

  it("is annualised on the same rule as your return", () => {
    const values = dates.map((date, i) => v(date, 1000 * level(i)));
    const r = computePerformance({ values, flows: flows({}), periodStart: "2025-01-01", benchmark: [...bench, { date: "2026-01-01", returnFraction: 0.2 }] });
    const year = computePerformance({ values: [...values, v("2026-01-01", 1200)], flows: flows({}), periodStart: "2025-01-01", benchmark: [...bench, { date: "2026-01-01", returnFraction: 0.2 }] });
    expect(r.figures.matchedBenchmarkReturn.annualised).toBe(false);
    expect(year.figures.matchedBenchmarkReturn.annualised).toBe(true);
    expect(year.figures.matchedBenchmarkReturn.value!).toBeCloseTo(0.2, 6);
  });
});
