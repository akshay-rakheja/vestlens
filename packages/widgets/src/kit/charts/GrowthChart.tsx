import { useId } from "preact/hooks";
import { formatCompactMoney, formatShortDate, formatSignedPercent } from "../format";
import type { ChartPoint } from "./AreaChart";
import { ChartFrame, HIDDEN, W, midIndex, moneyText, pct, scaleY, signedMoneyText, type LegendItem } from "./ChartFrame";

/** Value area in absolute terms plus a step line of baseline + cumulative deposits, on one y-scale. */
export function GrowthChart(props: { value: ChartPoint[]; /** Shown instead of the chart when there are fewer than two points. */ emptyText?: string; /** null = deposits unknown: no money-put-in line and no mention of it. */ deposits: Array<{ date: string; value: number }> | null; baseline: number; height?: number; label: string;
  /** The money-put-in line also carries accounts added to tracking. */ includesTracking?: boolean; currency?: string; privacy?: boolean }) {
  const gradientId = `w-growth-${useId()}`;
  const height = props.height ?? 110;
  const privacy = !!props.privacy;
  const pts = props.value
    .map((p) => ({ t: Date.parse(p.date), v: p.value, date: p.date, source: p.source }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) {
    return <div class="w-muted" style={{ height: `${height}px`, display: "grid", placeItems: "center" }}>{props.emptyText ?? "Not enough value history for this period yet."}</div>;
  }
  const head = pts[0];
  const tail = pts[pts.length - 1];
  const t0 = head.t;
  const t1 = tail.t === t0 ? t0 + 1 : tail.t;
  const flows = (props.deposits ?? [])
    .map((d) => ({ t: Date.parse(d.date), v: d.value }))
    .filter((d) => Number.isFinite(d.t) && Number.isFinite(d.v) && d.t > t0 && d.t <= t1)
    .sort((a, b) => a.t - b.t);
  // Step line: baseline, then a vertical step at each deposit date, held to the end.
  const steps: Array<{ t: number; v: number }> = [{ t: t0, v: props.baseline }];
  let running = props.baseline;
  for (const flow of flows) {
    steps.push({ t: flow.t, v: running });
    running += flow.v;
    steps.push({ t: flow.t, v: running });
  }
  steps.push({ t: t1, v: running });
  const all = [...pts.map((p) => p.v), ...(props.deposits ? steps.map((s) => s.v) : [])];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
  const y = scaleY(min, max, height);
  const line = (list: Array<{ t: number; v: number }>) => list.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const valuePath = line(pts);
  const change = head.v > 0 ? `: value ${formatSignedPercent(tail.v / head.v - 1, 1)}` : "";
  const summary = `${props.label}${change} (${head.date} to ${tail.date})${props.deposits ? `; dashed line shows money put in${props.includesTracking ? ", plus accounts added to tracking" : ""}` : ""}`;

  const year = tail.date.slice(0, 4);
  const tick = (v: number) => (privacy ? HIDDEN : props.currency ? formatCompactMoney(v, props.currency) : v.toFixed(0));
  const legend: LegendItem[] = [{ key: "value", label: "Your portfolio value", color: "var(--accent)" }];
  if (props.deposits) legend.push({ key: "deposits", label: props.includesTracking ? "Money you put in, plus accounts added to tracking" : "Money you put in", color: "var(--deposit)", mark: "dashed" });
  // Money in as of t: the baseline plus every deposit dated on or before t.
  const moneyIn = (t: number) => flows.reduce((sum, f) => (f.t <= t ? sum + f.v : sum), props.baseline);
  const mid = midIndex(pts.map((p) => p.t));
  const tip = (i: number) => {
    const p = pts[i];
    const lines = [`Value ${moneyText(p.v, props.currency, privacy)}${p.source !== "reported" ? " est." : ""}`];
    const dots = [{ y: y(p.v), color: "var(--accent)" }];
    if (props.deposits) {
      const putIn = moneyIn(p.t);
      lines.push(`Money put in ${moneyText(putIn, props.currency, privacy)}`, `Market gain ${signedMoneyText(p.v - putIn, props.currency, privacy)}`);
      dots.push({ y: y(putIn), color: "var(--deposit)" });
    }
    if (head.v > 0) lines.push(`Since start ${pct(p.v / head.v - 1)}`);
    return { title: formatShortDate(p.date, year), lines, dots };
  };
  return (
    <ChartFrame height={height} summary={summary} xs={pts.map((p) => x(p.t))} legend={legend} tip={tip}
      yTicks={[tick(max), tick((min + max) / 2), tick(min)]}
      xTicks={{ start: formatShortDate(head.date, year), mid: mid >= 0 ? { at: x(pts[mid].t), text: formatShortDate(pts[mid].date, year) } : null, end: formatShortDate(tail.date, year) }}>
      <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".24" /><stop offset="1" stop-color="var(--accent)" stop-opacity="0" /></linearGradient></defs>
      <path d={`${valuePath} L${x(tail.t).toFixed(1)},${height} L0,${height} Z`} fill={`url(#${gradientId})`} />
      {props.deposits && <path data-series="deposits" d={line(steps)} fill="none" stroke="var(--deposit)" stroke-width="1.6" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" />}
      <path data-series="value" d={valuePath} fill="none" stroke="var(--accent)" stroke-width="2.4" vector-effect="non-scaling-stroke" />
    </ChartFrame>
  );
}
