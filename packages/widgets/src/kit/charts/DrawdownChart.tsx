import { useId } from "preact/hooks";
import { formatPercent, formatShortDate, formatSignedPercent } from "../format";
import { ChartFrame, W, midIndex, pct, scaleY } from "./ChartFrame";

/** Area from 0 down to the drawdown from the running peak. Display only; the headline figure is the server's. */
export function DrawdownChart(props: { index: Array<{ date: string; value: number }>; height?: number; label: string }) {
  const gradientId = `w-dd-${useId()}`;
  const height = props.height ?? 80;
  const pts = props.index
    .map((p) => ({ t: Date.parse(p.date), v: p.value, date: p.date }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > 0)
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) {
    return <div class="w-muted" style={{ height: `${height}px`, display: "grid", placeItems: "center" }}>Drawdown will appear once there is enough history.</div>;
  }
  let peak = pts[0].v;
  const dd = pts.map((p) => {
    peak = Math.max(peak, p.v);
    return { t: p.t, date: p.date, d: p.v / peak - 1 };
  });
  const t0 = dd[0].t;
  const t1 = dd[dd.length - 1].t === t0 ? t0 + 1 : dd[dd.length - 1].t;
  const deepest = dd.reduce((m, p) => (p.d < m.d ? p : m), dd[0]);
  const floor = Math.min(deepest.d, -0.01);
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
  const y = scaleY(floor, 0, height);
  const path = dd.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.d).toFixed(1)}`).join(" ");
  const depth = deepest.d < 0 ? formatSignedPercent(deepest.d, 1) : formatPercent(0, 1);
  const summary = `${props.label}: deepest drawdown ${depth}${deepest.d < 0 ? ` on ${deepest.date}` : ""} (${dd[0].date} to ${dd[dd.length - 1].date})`;
  const last = dd[dd.length - 1];
  const year = last.date.slice(0, 4);
  const mid = midIndex(dd.map((p) => p.t));
  const tip = (i: number) => ({ title: formatShortDate(dd[i].date, year), lines: [`Drawdown ${pct(dd[i].d)}`], dots: [{ y: y(dd[i].d), color: "var(--down)" }] });
  return (
    <ChartFrame height={height} summary={summary} xs={dd.map((p) => x(p.t))} tip={tip}
      legend={[{ key: "drawdown", label: "Drop from the previous high", color: "var(--down)" }]}
      yTicks={[pct(0), pct(floor / 2), pct(floor)]}
      xTicks={{ start: formatShortDate(dd[0].date, year), mid: mid >= 0 ? { at: x(dd[mid].t), text: formatShortDate(dd[mid].date, year) } : null, end: formatShortDate(last.date, year) }}>
      <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--down)" stop-opacity=".05" /><stop offset="1" stop-color="var(--down)" stop-opacity=".3" /></linearGradient></defs>
      <path d={`${path} L${x(last.t).toFixed(1)},${y(0)} L0,${y(0)} Z`} fill={`url(#${gradientId})`} />
      <path data-series="drawdown" d={path} fill="none" stroke="var(--down)" stroke-width="1.8" vector-effect="non-scaling-stroke" />
    </ChartFrame>
  );
}
