import { useId } from "preact/hooks";
import { formatCompactMoney, formatSignedPercent, formatTime } from "../format";
import { ChartFrame, HIDDEN, W, midIndex, moneyText, pct, scaleY, signedMoneyText } from "./ChartFrame";

/** Area line over time, scaled to its own range. The text alternative gives the percentage change only. */
export function IntradayChart(props: { points: Array<{ t: string; value: number }>; height?: number; label: string; currency?: string; privacy?: boolean }) {
  const gradientId = `w-intraday-${useId()}`;
  const height = props.height ?? 92;
  const privacy = !!props.privacy;
  const pts = props.points
    .map((p) => ({ t: Date.parse(p.t), v: p.value, iso: p.t }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) {
    return <div class="w-muted" style={{ height: `${height}px`, display: "grid", placeItems: "center" }}>Live prices are not available right now.</div>;
  }
  const head = pts[0];
  const tail = pts[pts.length - 1];
  const t0 = head.t;
  const t1 = tail.t === t0 ? t0 + 1 : tail.t;
  const min = Math.min(...pts.map((p) => p.v));
  const max = Math.max(...pts.map((p) => p.v));
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
  const y = scaleY(min, max, height);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const change = head.v > 0 ? `: ${formatSignedPercent(tail.v / head.v - 1, 1)}` : "";
  const tick = (v: number) => (privacy ? HIDDEN : props.currency ? formatCompactMoney(v, props.currency) : v.toFixed(0));
  const mid = midIndex(pts.map((p) => p.t));
  const tip = (i: number) => {
    const p = pts[i];
    const lines = [`Est. value ${moneyText(p.v, props.currency, privacy)}`];
    if (head.v > 0) lines.push(`Since open ${pct(p.v / head.v - 1)}${privacy ? "" : ` (${signedMoneyText(p.v - head.v, props.currency, false)})`}`);
    return { title: formatTime(p.iso), lines, dots: [{ y: y(p.v), color: "var(--accent)" }] };
  };
  return (
    <ChartFrame height={height} summary={`${props.label}${change}`} xs={pts.map((p) => x(p.t))} tip={tip}
      legend={[{ key: "intraday", label: "Your portfolio value (estimated)", color: "var(--accent)" }]}
      yTicks={[tick(max), tick((min + max) / 2), tick(min)]}
      xTicks={{ start: formatTime(head.iso), mid: mid >= 0 ? { at: x(pts[mid].t), text: formatTime(pts[mid].iso) } : null, end: formatTime(tail.iso) }}>
      <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".24" /><stop offset="1" stop-color="var(--accent)" stop-opacity="0" /></linearGradient></defs>
      <path d={`${path} L${W},${height} L0,${height} Z`} fill={`url(#${gradientId})`} />
      <path data-series="intraday" d={path} fill="none" stroke="var(--accent)" stroke-width="2.4" vector-effect="non-scaling-stroke" />
    </ChartFrame>
  );
}
