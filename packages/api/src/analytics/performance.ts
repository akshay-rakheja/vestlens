import type { FlowResult } from "./flows.js";
import { rebaseOnSpan, type SeriesPoint } from "./value-series.js";

const DAY_MS = 86_400_000;
const MIN_POINTS = 5;
const MIN_RETURNS_FOR_VOL = 20;
/** A flow below this share of the balance is never treated as a snapshot lag (F7). */
const LAG_MIN_SHARE = 0.02;
const PARTIAL_GRACE_DAYS = 4;

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const yearsBetween = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS / 365;

export interface Figure { value: number | null; estimated: boolean; reason?: "insufficient_history" | "no_solution" | "flows_unavailable" | "benchmark_unavailable" | "flow_not_converted" | "under_a_year" }
/** A return as a yearly rate (CAGR) over `years`; reason under_a_year when the span is shorter than 365 days. */
export type YearlyFigure = Figure & { years?: number };

/**
 * A period return as a compound yearly rate: (1 + R) ^ (365 / days) - 1, the same 365-day year as xirr(). Spans under
 * 365 days stay unannualised (annualising a short span exaggerates it): null with reason under_a_year.
 */
export function annualise(f: Figure, days: number): YearlyFigure {
  if (f.value === null) return f;
  if (days < 365) return { value: null, estimated: false, reason: "under_a_year" };
  if (f.value <= -1) return { value: null, estimated: f.estimated, reason: "no_solution" };
  const years = days / 365;
  return { value: (1 + f.value) ** (1 / years) - 1, estimated: f.estimated, years: Math.round(years * 100) / 100 };
}
/**
 * value = joined + left + movedFromTracked: accounts entering (+) or leaving (−) the series, and
 * your own transfers between a tracked account and one not tracked that day (− when money left
 * a tracked account for a joining one). None of it is a deposit.
 */
export type TrackingFigure = Figure & { joined?: number; left?: number; movedFromTracked?: number };
export interface IndexPoint { date: string; value: number }
export interface MonthlyReturn { month: string; return: number | null; partial: boolean; estimated: boolean }
export interface DepositBreakdown { putIn: number; takenOut: number; byAccount: Array<{ accountId: string; putIn: number; takenOut: number }> }
export interface PerformanceResult {
  span: { start: string; end: string; partial: boolean; since?: string };
  figures: {
    personalReturn: Figure & { annualised: boolean }; investmentReturn: Figure; benchmarkReturn: Figure;
    /**
     * Same money in the index: every flow behind personalReturn replayed into the benchmark on its day (start value
     * included), then the same money-weighted solve. Compares with personalReturn as benchmarkReturn does with
     * investmentReturn. exhausted: a withdrawal took more than the index holding had, so no number is given.
     */
    matchedBenchmarkReturn: Figure & { annualised: boolean; exhausted?: boolean };
    /** What the index holding of matchedBenchmarkReturn is worth at the span end, in the scope currency. */
    matchedBenchmarkValue: Figure;
    /** investmentReturn and benchmarkReturn as yearly rates over the same span (CAGR). */
    investmentCagr: YearlyFigure; benchmarkCagr: YearlyFigure;
    valueChange: Figure;
    /** Real external flows only (deposits, withdrawals, in-kind transfers). */
    netDeposits: Figure;
    /** Values of accounts joining (+) or leaving (−) the series: not money you added. */
    accountsAddedToTracking: TrackingFigure;
    marketGain: Figure;
    maxDrawdown: Figure & { peak?: string; trough?: string }; volatility: Figure;
    bestMonth: Figure & { month?: string }; worstMonth: Figure & { month?: string };
  };
  monthly: MonthlyReturn[];
  /** riskMergedDates: days merged away by the deposit-lag rule (F7); the drawdown chart omits them. */
  series: { value: SeriesPoint[]; netDeposits: IndexPoint[]; twrIndex: IndexPoint[]; benchmarkIndex: IndexPoint[]; riskMergedDates: string[] };
  /**
   * The flows behind figures.netDeposits over the same span: put in (positive flows) and taken out (negative, as a
   * negative number), in total and per account, so putIn + takenOut equals netDeposits. Null without flows or two points.
   */
  deposits: DepositBreakdown | null;
}

export function xirr(cashflows: Array<{ date: string; amount: number }>): number | null {
  if (cashflows.length < 2) return null;
  const t0 = cashflows[0].date;
  return solveRate(cashflows.map((c) => ({ t: yearsBetween(t0, c.date), a: c.amount })));
}

/** Root of Σ a/(1+r)^t on [-0.99, 10]: Newton from 0.1, then bisection when signs differ. */
export function solveRate(terms: Array<{ t: number; a: number }>): number | null {
  if (!terms.some((x) => x.a > 0) || !terms.some((x) => x.a < 0)) return null;
  const npv = (r: number) => terms.reduce((s, x) => s + x.a / (1 + r) ** x.t, 0);
  const dnpv = (r: number) => terms.reduce((s, x) => s - (x.t * x.a) / (1 + r) ** (x.t + 1), 0);
  let r = 0.1;
  for (let i = 0; i < 50; i++) {
    const f = npv(r), d = dnpv(r);
    if (!Number.isFinite(f) || !Number.isFinite(d) || d === 0) break;
    const next = r - f / d;
    if (!Number.isFinite(next) || next <= -0.99 || next > 10) break;
    if (Math.abs(next - r) < 1e-9) return next;
    r = next;
  }
  let lo = -0.99, hi = 10, flo = npv(lo);
  const fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || Math.sign(flo) === Math.sign(fhi)) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (Math.abs(fm) < 1e-9 || hi - lo < 1e-10) return mid;
    if (Math.sign(fm) === Math.sign(flo)) { lo = mid; flo = fm; } else { hi = mid; }
  }
  return (lo + hi) / 2;
}

export function twr(values: SeriesPoint[], flows: Map<string, number>): { index: IndexPoint[]; dailyReturns: number[]; skipped: number } {
  if (values.length === 0) return { index: [], dailyReturns: [], skipped: 0 };
  const index: IndexPoint[] = [{ date: values[0].date, value: 1 }];
  const dailyReturns: number[] = [];
  let level = 1, skipped = 0;
  for (let i = 1; i < values.length; i++) {
    const denom = values[i - 1].value + (flows.get(values[i].date) ?? 0);
    if (denom > 0 && values[i].value > 0 && Number.isFinite(values[i].value)) {
      const r = values[i].value / denom - 1;
      level *= 1 + r;
      dailyReturns.push(r);
    } else skipped++;
    index.push({ date: values[i].date, value: level });
  }
  return { index, dailyReturns, skipped };
}

/** Assign each flow after the span start (and up to the last value date) to the first value date on or after it. */
function alignFlows(byDate: Map<string, number>, dates: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const start = dates[0], end = dates[dates.length - 1];
  for (const [d, amount] of byDate) {
    if (d <= start || d > end) continue;
    const target = dates.find((x) => x >= d);
    if (target) out.set(target, (out.get(target) ?? 0) + amount);
  }
  return out;
}

const isWeekday = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`).getUTCDay(); return d !== 0 && d !== 6; };

/** F6: Sat/Sun points dropped; a flow aligned to a dropped day moves to the next weekday point. */
function weekdaySeries(values: SeriesPoint[], flows: Map<string, number>): { values: SeriesPoint[]; flows: Map<string, number> } {
  const kept = values.filter((p) => isWeekday(p.date));
  const folded = new Map<string, number>();
  for (const [d, amount] of flows) {
    const target = kept.find((p) => p.date >= d);
    if (target) folded.set(target.date, (folded.get(target.date) ?? 0) + amount);
  }
  return { values: kept, flows: folded };
}

/**
 * Index and step returns for the risk metrics (F7). A flow day whose return is reversed the next
 * day, both steps larger than half the flow's share of the balance, is the snapshot showing the
 * flow a day late: the two days are merged into one sub-period with the flow at its start. The
 * share is measured against the larger of the balances before and after the flow, so a deposit at
 * least as large as the account is still caught. Skipped steps (P2) carry the index as in twr().
 */
function riskSeries(values: SeriesPoint[], flows: Map<string, number>): { index: IndexPoint[]; returns: number[]; merged: boolean; mergedDates: string[] } {
  if (values.length === 0) return { index: [], returns: [], merged: false, mergedDates: [] };
  const flowAt = (i: number) => flows.get(values[i].date) ?? 0;
  const step = (from: number, to: number, flow: number): number | null => {
    const denom = values[from].value + flow;
    const v = values[to].value;
    return denom > 0 && v > 0 && Number.isFinite(v) ? v / denom - 1 : null;
  };
  const index: IndexPoint[] = [{ date: values[0].date, value: 1 }];
  const returns: number[] = [];
  let level = 1, merged = false;
  const mergedDates: string[] = [];
  for (let i = 1; i < values.length; i++) {
    const f = flowAt(i);
    const r = step(i - 1, i, f);
    if (f !== 0 && r !== null && i + 1 < values.length) {
      const next = step(i, i + 1, flowAt(i + 1));
      const share = Math.abs(f) / (values[i - 1].value + Math.max(f, 0));
      const threshold = 0.5 * share;
      // Materiality floor: small flows on noisy days are not a snapshot lag.
      if (next !== null && share >= LAG_MIN_SHARE && r * next < 0 && Math.abs(r) > threshold && Math.abs(next) > threshold) {
        const combined = step(i - 1, i + 1, f + flowAt(i + 1));
        if (combined !== null) {
          level *= 1 + combined;
          returns.push(combined);
          index.push({ date: values[i + 1].date, value: level });
          merged = true;
          mergedDates.push(values[i].date);
          i++;
          continue;
        }
      }
    }
    if (r !== null) { level *= 1 + r; returns.push(r); }
    index.push({ date: values[i].date, value: level });
  }
  return { index, returns, merged, mergedDates };
}

function stdev(xs: number[]): number {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
}

function drawdown(index: IndexPoint[]): { value: number; peak?: string; trough?: string } {
  let peak = index[0], worst = 0, worstPeak: IndexPoint | undefined, worstTrough: IndexPoint | undefined;
  for (const p of index) {
    if (p.value > peak.value) peak = p;
    const dd = p.value / peak.value - 1;
    if (dd < worst) { worst = dd; worstPeak = peak; worstTrough = p; }
  }
  return worst === 0 ? { value: 0 } : { value: worst, peak: worstPeak!.date, trough: worstTrough!.date };
}

function monthlyGrid(points: SeriesPoint[], index: IndexPoint[], unknownDates: string[]): MonthlyReturn[] {
  const months: string[] = [];
  for (const p of index) { const m = p.date.slice(0, 7); if (months[months.length - 1] !== m) months.push(m); }
  const first = index[0].date, last = index[index.length - 1].date;
  return months.map((month, mi) => {
    const inMonth = index.map((p, i) => ({ p, i })).filter(({ p }) => p.date.startsWith(month));
    const end = inMonth[inMonth.length - 1];
    const base = mi === 0 ? index[0].value : index[inMonth[0].i - 1].value;
    const ret = base > 0 ? end.p.value / base - 1 : null;
    const [y, mo] = month.split("-").map(Number);
    const monthLastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const partial = (mi === 0 && daysBetween(`${month}-01`, first) > PARTIAL_GRACE_DAYS) || (mi === months.length - 1 && Number(last.slice(8, 10)) < monthLastDay);
    const estimated = inMonth.some(({ i }) => points[i].source === "estimated") || unknownDates.some((d) => d.startsWith(month));
    return { month, return: ret, partial, estimated };
  });
}

export function computePerformance(input: {
  values: SeriesPoint[]; flows: FlowResult | null; periodStart: string;
  benchmark: Array<{ date: string; returnFraction: number }> | null;
}): PerformanceResult {
  const sortedValues = [...input.values].sort((a, b) => a.date.localeCompare(b.date));
  const firstPos = sortedValues.findIndex((p) => p.value > 0);
  let lastPos = -1;
  sortedValues.forEach((p, i) => { if (p.value > 0) lastPos = i; });
  const pts = firstPos < 0 ? [] : sortedValues.slice(firstPos, lastPos + 1);

  const insufficient = (extra: object = {}): Figure => ({ value: null, estimated: false, reason: "insufficient_history", ...extra });
  if (pts.length === 0) {
    return {
      span: { start: input.periodStart, end: input.periodStart, partial: false },
      figures: {
        personalReturn: { ...insufficient(), annualised: false }, investmentReturn: insufficient(), benchmarkReturn: { value: null, estimated: false, reason: "benchmark_unavailable" },
        matchedBenchmarkReturn: { ...insufficient(), annualised: false }, matchedBenchmarkValue: insufficient(),
        investmentCagr: insufficient(), benchmarkCagr: { value: null, estimated: false, reason: "benchmark_unavailable" },
        valueChange: insufficient(), netDeposits: insufficient(), accountsAddedToTracking: insufficient(), marketGain: insufficient(), maxDrawdown: insufficient(), volatility: insufficient(),
        bestMonth: insufficient(), worstMonth: insufficient(),
      },
      monthly: [], series: { value: [], netDeposits: [], twrIndex: [], benchmarkIndex: [], riskMergedDates: [] }, deposits: null,
    };
  }

  const dates = pts.map((p) => p.date);
  const start = dates[0], end = dates[dates.length - 1];
  const partial = daysBetween(input.periodStart, start) > PARTIAL_GRACE_DAYS;
  const span: PerformanceResult["span"] = partial ? { start, end, partial, since: start } : { start, end, partial };
  const enough = pts.length >= MIN_POINTS;
  const hasTwoPoints = pts.length >= 2;
  const anyEstimated = pts.some((p) => p.source === "estimated");
  const unknownList = input.flows ? [...input.flows.unknownDates].filter((d) => d > start && d <= end) : [];
  const incomplete = input.flows?.incomplete === true;
  // Missing flows are unknown flows: TWR, risk and monthly figures computed without them are estimates.
  const flowsUnknown = !input.flows || incomplete;
  const unknownInSpan = unknownList.length > 0 || flowsUnknown;

  const external = input.flows ? alignFlows(input.flows.byDate, dates) : new Map<string, number>();
  const alignOr = (m?: Map<string, number>) => (m ? alignFlows(m, dates) : new Map<string, number>());
  const joins = alignOr(input.flows?.joins), leaves = alignOr(input.flows?.leaves), moved = alignOr(input.flows?.trackingTransfers);
  // Returns treat joins, leaves and moves to untracked accounts as flows; the figures keep them apart from deposits.
  const aligned = new Map(external);
  for (const m of [joins, leaves, moved]) for (const [d, x] of m) aligned.set(d, (aligned.get(d) ?? 0) + x);
  const vStart = pts[0].value, vEnd = pts[pts.length - 1].value;
  const { index, skipped } = twr(pts, aligned);
  const returnsEstimated = anyEstimated || unknownInSpan || skipped > 0;

  const ret = (value: number | null, estimated: boolean): Figure => (value === null ? insufficient() : { value, estimated });
  const valueChange: Figure = hasTwoPoints ? { value: vEnd - vStart, estimated: anyEstimated } : insufficient();
  const netTotal = [...external.values()].reduce((s, x) => s + x, 0);
  const sum = (m: Map<string, number>) => [...m.values()].reduce((s, x) => s + x, 0);
  const joined = sum(joins), left = sum(leaves), movedFromTracked = sum(moved);
  const joinTotal = joined + left + movedFromTracked;
  const flowsMissing: Figure = { value: null, estimated: false, reason: "flows_unavailable" };
  const netDeposits: Figure = !input.flows ? flowsMissing : hasTwoPoints ? { value: netTotal, estimated: unknownInSpan } : insufficient();
  // Same window as alignFlows (after the first point, up to the last), so the parts add up to netTotal.
  const deposits: DepositBreakdown | null = input.flows?.entries && hasTwoPoints
    ? (() => {
        const per = new Map<string, { accountId: string; putIn: number; takenOut: number }>();
        let putIn = 0, takenOut = 0;
        for (const e of input.flows!.entries!) {
          if (e.date <= start || e.date > end || e.value === 0) continue;
          const row = per.get(e.accountId) ?? { accountId: e.accountId, putIn: 0, takenOut: 0 };
          if (e.value > 0) { row.putIn += e.value; putIn += e.value; } else { row.takenOut += e.value; takenOut += e.value; }
          per.set(e.accountId, row);
        }
        return { putIn, takenOut, byAccount: [...per.values()].sort((a, b) => b.putIn - a.putIn) };
      })()
    : null;
  const accountsAddedToTracking: TrackingFigure = !input.flows ? flowsMissing : hasTwoPoints
    ? { value: joinTotal, estimated: input.flows.joinLeaveEstimated === true, joined, left, movedFromTracked } : insufficient();
  const marketGain: Figure = !input.flows ? flowsMissing : hasTwoPoints ? { value: vEnd - vStart - netTotal - joinTotal, estimated: anyEstimated || unknownInSpan } : insufficient();
  const investmentReturn = enough ? ret(index[index.length - 1].value - 1, returnsEstimated) : insufficient();

  const spanDays = daysBetween(start, end);
  const flowCfs = [...aligned].sort(([a], [b]) => a.localeCompare(b)).map(([date, amount]) => ({ date, amount: -amount }));
  const flowsEstimated = anyEstimated || unknownInSpan;
  /** Money-weighted return of the start value and the flows ending at `endValue`; spans under a year solve the period return. */
  const moneyWeighted = (endValue: number): Figure & { annualised: boolean } => {
    if (!input.flows) return { ...flowsMissing, annualised: false };
    if (!enough || spanDays <= 0) return { ...insufficient(), annualised: false };
    const cfs = [{ date: start, amount: -vStart }, ...flowCfs, { date: end, amount: endValue }];
    // Spans under a year solve for the period return directly (t = fraction of the span).
    const r = spanDays >= 365 ? xirr(cfs) : solveRate(cfs.map((c) => ({ t: daysBetween(start, c.date) / spanDays, a: c.amount })));
    if (r === null) return { value: null, estimated: flowsEstimated, reason: "no_solution", annualised: false };
    return { value: r, estimated: flowsEstimated, annualised: spanDays >= 365 };
  };
  const personalReturn = moneyWeighted(vEnd);

  // F1: rebased on the last close on or before the span start (a weekend/holiday start carries it).
  const kept = input.benchmark ? rebaseOnSpan(input.benchmark, start, end) : null;
  let benchmarkReturn: Figure = { value: null, estimated: false, reason: "benchmark_unavailable" };
  let benchmarkIndex: IndexPoint[] = [];
  if (kept) {
    benchmarkIndex = kept.map((b) => ({ date: b.date, value: 1 + b.returnFraction }));
    benchmarkReturn = enough ? { value: benchmarkIndex[benchmarkIndex.length - 1].value - 1, estimated: false } : insufficient();
  }

  // Same money in the index: the start value buys index units at the start, each flow buys (or sells) at its day's level.
  const unavailable: Figure = { value: null, estimated: false, reason: "benchmark_unavailable" };
  let matchedBenchmarkReturn: Figure & { annualised: boolean; exhausted?: boolean } = { ...unavailable, annualised: false };
  let matchedBenchmarkValue: Figure = unavailable;
  if (!input.flows) {
    matchedBenchmarkReturn = { ...flowsMissing, annualised: false };
    matchedBenchmarkValue = flowsMissing;
  } else if (kept) {
    const levelOn = (date: string) => { let l = benchmarkIndex[0].value; for (const p of benchmarkIndex) { if (p.date <= date) l = p.value; else break; } return l; };
    let units = vStart / levelOn(start), exhausted = false;
    for (const p of pts.slice(1)) {
      units += (aligned.get(p.date) ?? 0) / levelOn(p.date);
      if (units < -1e-9) exhausted = true;
    }
    const endValue = units * levelOn(end);
    if (exhausted) {
      matchedBenchmarkReturn = { value: null, estimated: false, reason: "no_solution", annualised: false, exhausted: true };
      matchedBenchmarkValue = { value: null, estimated: false, reason: "no_solution" };
    } else {
      matchedBenchmarkReturn = moneyWeighted(endValue);
      matchedBenchmarkValue = enough ? { value: endValue, estimated: flowsEstimated } : insufficient();
    }
  }

  const monthly = enough ? monthlyGrid(pts, index, unknownList).map((m) => (flowsUnknown ? { ...m, estimated: true } : m)) : [];
  const full = monthly.filter((m) => !m.partial && m.return !== null);
  const pick = (cmp: (a: number, b: number) => boolean): Figure & { month?: string } => {
    if (!enough) return insufficient();
    if (full.length === 0) return insufficient();
    const m = full.reduce((a, b) => (cmp(b.return!, a.return!) ? b : a));
    return { value: m.return, estimated: m.estimated, month: m.month };
  };

  // Risk metrics: deposit-lag days merged (F7); volatility on weekday points only (F6).
  const risk = riskSeries(pts, aligned);
  const wk = weekdaySeries(pts, aligned);
  const wkRisk = riskSeries(wk.values, wk.flows);
  const riskEstimated = returnsEstimated || risk.merged || wkRisk.merged;
  const dd = enough ? drawdown(risk.index) : null;
  const maxDrawdown: Figure & { peak?: string; trough?: string } = dd ? { value: dd.value, estimated: riskEstimated, ...(dd.peak ? { peak: dd.peak, trough: dd.trough } : {}) } : insufficient();
  const volatility: Figure = wkRisk.returns.length >= MIN_RETURNS_FOR_VOL ? { value: stdev(wkRisk.returns) * Math.sqrt(252), estimated: riskEstimated } : insufficient();

  let cum = 0;
  const netSeries: IndexPoint[] = input.flows && hasTwoPoints ? pts.map((p) => { cum += aligned.get(p.date) ?? 0; return { date: p.date, value: cum }; }) : [];

  return {
    span,
    figures: {
      personalReturn, investmentReturn, benchmarkReturn, matchedBenchmarkReturn, matchedBenchmarkValue,
      investmentCagr: annualise(investmentReturn, spanDays), benchmarkCagr: annualise(benchmarkReturn, spanDays),
      valueChange, netDeposits, accountsAddedToTracking, marketGain, maxDrawdown, volatility,
      bestMonth: pick((a, b) => a > b), worstMonth: pick((a, b) => a < b),
    },
    monthly,
    series: { value: pts, netDeposits: netSeries, twrIndex: hasTwoPoints ? index : [], benchmarkIndex, riskMergedDates: enough ? risk.mergedDates : [] },
    deposits,
  };
}
