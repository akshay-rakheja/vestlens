/** Tiny axis-less line: stroke is --ink at 60% opacity, last point dotted. Renders nothing under two values. */
export function Sparkline(props: { values: number[]; width?: number; height?: number; label: string }) {
  const values = props.values.filter((v) => Number.isFinite(v));
  if (values.length < 2) return null;
  const w = props.width ?? 64, h = props.height ?? 20, pad = 2;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const xy = values.map((v, i) => [pad + (i / (values.length - 1)) * (w - 2 * pad), h - pad - ((v - min) / span) * (h - 2 * pad)] as const);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg class="w-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={props.label}>
      <path d={d} fill="none" stroke="var(--ink)" stroke-opacity="0.6" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
      <circle cx={lx} cy={ly} r="2" fill="var(--ink)" />
    </svg>
  );
}
