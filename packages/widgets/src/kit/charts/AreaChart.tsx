import { useId } from "preact/hooks";
import { formatCompactMoney, formatShortDate, formatSignedPercent } from "../format";
import { ChartFrame, HIDDEN, W, atOrBefore, midIndex, moneyText, pct, scaleY, signedMoneyText, type LegendItem } from "./ChartFrame";

export interface ChartPoint { date: string; value: number; source: "reported" | "reconstructed" | "estimated" }
export interface BenchmarkPoint { date: string; returnFraction: number }

const MAX_MARKERS = 12;
const LEGEND: Array<{ kind: ChartPoint["source"]; text: string }> = [
  { kind: "reconstructed", text: "○ reconstructed" },
  { kind: "estimated", text: "◌ estimated" },
];

interface TimedPoint extends ChartPoint { t: number }

// Sorts by date and drops rows whose date does not parse or whose value is not finite.
function timedPoints(points: ChartPoint[]): TimedPoint[] {
  return points
    .map((point) => ({ ...point, t: Date.parse(point.date) }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.value))
    .sort((a, b) => a.t - b.t);
}

// Keeps benchmark points inside [t0, t1] and rebases so the first kept point is zero.
function benchmarkSeries(points: BenchmarkPoint[] | undefined, t0: number, t1: number) {
  if (!points) return undefined;
  const inRange = points
    .map((point) => ({ t: Date.parse(point.date), f: point.returnFraction }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.f) && point.t >= t0 && point.t <= t1)
    .sort((a, b) => a.t - b.t);
  if (inRange.length < 2) return undefined;
  const base = 1 + inRange[0].f;
  if (base <= 0) return undefined;
  return inRange.map((point) => ({ t: point.t, r: (1 + point.f) / base - 1 }));
}

export interface AreaChartProps {
  /** Shown instead of the chart when there are fewer than two points. */
  emptyText?: string;
  points: ChartPoint[];
  benchmark?: BenchmarkPoint[];
  height?: number;
  label: string;
  /** "value": money axis and tooltip; "return": the points are an index, shown as % return since the start. */
  mode?: "value" | "return";
  currency?: string;
  privacy?: boolean;
  seriesLabel?: string;
  benchmarkLabel?: string;
}

export function AreaChart(props: AreaChartProps) {
  const gradientId = `w-area-${useId()}`;
  const height = props.height ?? 92;
  const mode = props.mode ?? "value";
  const privacy = !!props.privacy;
  const cleaned = timedPoints(props.points);
  if (cleaned.length < 2 || cleaned[0].value <= 0) {
    return <div class="w-muted" style={{ height: `${height}px`, display: "grid", placeItems: "center" }}>{props.emptyText ?? "Not enough value history for this period yet."}</div>;
  }
  const head = cleaned[0];
  const tail = cleaned[cleaned.length - 1];
  const t0 = head.t;
  const t1 = tail.t === t0 ? t0 + 1 : tail.t;
  const portfolio = cleaned.map((point) => ({ ...point, r: point.value / head.value - 1 }));
  const bench = benchmarkSeries(props.benchmark, t0, tail.t);
  const all = [...portfolio.map((p) => p.r), ...(bench?.map((b) => b.r) ?? [])];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
  const y = scaleY(min, max, height);
  const line = (pts: Array<{ t: number; r: number }>) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.r).toFixed(1)}`).join(" ");
  const portfolioPath = line(portfolio);
  const benchPath = bench ? line(bench) : null;
  const last = portfolio[portfolio.length - 1];
  const benchLast = bench?.[bench.length - 1];
  const hasEstimates = portfolio.some((p) => p.source !== "reported");
  // Per-point markers only for a few rebuilt days; long rebuilt history would turn the line into noise.
  const rebuilt = portfolio.filter((p) => p.source !== "reported");
  const markers = rebuilt.length <= MAX_MARKERS ? rebuilt : [];
  const legendKinds = LEGEND.filter(({ kind }) => portfolio.some((p) => p.source === kind));
  const summary = `${props.label}: ${formatSignedPercent(last.r, 1)}${benchLast ? `, benchmark ${formatSignedPercent(benchLast.r, 1)}` : ""} (${head.date} to ${tail.date})${hasEstimates ? "; includes reconstructed or estimated points" : ""}`;

  const year = tail.date.slice(0, 4);
  const tick = (r: number) => {
    const v = head.value * (1 + r);
    return mode === "return" ? pct(r) : privacy ? HIDDEN : props.currency ? formatCompactMoney(v, props.currency) : v.toFixed(0);
  };
  const seriesLabel = props.seriesLabel ?? (mode === "return" ? "Your investment return" : "Your portfolio value");
  const benchLabel = props.benchmarkLabel ?? "Benchmark";
  const legend: LegendItem[] = [{ key: "series", label: seriesLabel, color: "var(--accent)" }];
  if (bench) legend.push({ key: "benchmark", label: benchLabel, color: "var(--muted)", mark: "dashed" });
  const mid = midIndex(portfolio.map((p) => p.t));
  const tip = (i: number) => {
    const p = portfolio[i];
    const est = p.source !== "reported" ? " est." : "";
    const b = bench ? bench[atOrBefore(bench, p.t)] : undefined;
    const lines = mode === "return"
      ? [`${seriesLabel} ${pct(p.r)}${est}`]
      : [`Value ${moneyText(p.value, props.currency, privacy)}${est}`, `Since start ${pct(p.r)}${privacy ? "" : ` (${signedMoneyText(p.value - head.value, props.currency, false)})`}`];
    if (b) lines.push(`${benchLabel} ${pct(b.r)}`);
    const dots = [{ y: y(p.r), color: "var(--accent)" }];
    if (b) dots.push({ y: y(b.r), color: "var(--muted)" });
    return { title: formatShortDate(p.date, year), lines, dots };
  };
  return (
    <div>
      <ChartFrame height={height} summary={summary} xs={portfolio.map((p) => x(p.t))} legend={legend} tip={tip}
        yTicks={[tick(max), tick((min + max) / 2), tick(min)]}
        xTicks={{ start: formatShortDate(head.date, year), mid: mid >= 0 ? { at: x(portfolio[mid].t), text: formatShortDate(portfolio[mid].date, year) } : null, end: formatShortDate(tail.date, year) }}>
        <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".24" /><stop offset="1" stop-color="var(--accent)" stop-opacity="0" /></linearGradient></defs>
        <path d={`${portfolioPath} L${W},${height} L0,${height} Z`} fill={`url(#${gradientId})`} />
        {benchPath && <path data-series="benchmark" d={benchPath} fill="none" stroke="var(--muted)" stroke-width="1.3" stroke-dasharray="4 4" vector-effect="non-scaling-stroke" />}
        <path data-series="portfolio" d={portfolioPath} fill="none" stroke="var(--accent)" stroke-width="2.4" vector-effect="non-scaling-stroke" />
        {markers.map((p) => (
          <circle data-source={p.source} cx={x(p.t)} cy={y(p.r)} r="2" fill="var(--bg)" stroke="var(--muted)" stroke-dasharray={p.source === "estimated" ? "2 2" : undefined} />
        ))}
        {tail.source === "reported" && <circle cx={x(last.t)} cy={y(last.r)} r="3.5" fill="var(--accent)" />}
      </ChartFrame>
      {legendKinds.length > 0 && (
        <div class="w-muted" style={{ marginTop: "4px", fontSize: "11px" }}>
          {`${legendKinds.map((item) => item.text).join("  ")} — values rebuilt from activity/prices, not brokerage-reported.`}
        </div>
      )}
    </div>
  );
}
