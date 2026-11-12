import { useEffect, useRef, useState } from "preact/hooks";
import { formatCompactMoney } from "../format";
import { ChartFrame, HIDDEN, PAD, W, moneyText, scaleY, type LegendItem } from "./ChartFrame";
import { assignColors } from "./palette";

/** Bars fill at most this share of their band, and never more than MAX_BAR_PX on screen. */
const BAND_FILL = 0.6;
const MAX_BAR_PX = 28;
/** Surface gap between stacked segments and the radius of the top segment's corners, in px. */
const GAP_PX = 2;
const RADIUS_PX = 4;

/** A bar segment with only its top corners rounded. x is in viewBox units, y in px; rx/ry keep the corner round after the x stretch. */
function topRounded(x: number, y: number, w: number, h: number, rx: number, ry: number): string {
  const ax = Math.min(rx, w / 2);
  const ay = Math.min(ry, h);
  const f = (n: number) => n.toFixed(3);
  return `M${f(x)},${f(y + h)} V${f(y + ay)} A${f(ax)},${f(ay)} 0 0 1 ${f(x + ax)},${f(y)} H${f(x + w - ax)} A${f(ax)},${f(ay)} 0 0 1 ${f(x + w)},${f(y + ay)} V${f(y + h)} Z`;
}

/**
 * One stacked column per bar on a zero-based y-scale; tooltip, axes and legend come from ChartFrame. Series keep the
 * colour they are given (palette.ts), else take slots in order. `selected` keeps one bar opaque and dims the rest.
 */
export function StackedBarChart(props: {
  bars: Array<{ key: string; label: string; parts: Array<{ series: string; value: number }> }>;
  series: Array<{ key: string; label: string; color?: string }>; currency: string; privacy: boolean; label: string;
  onBar?: (key: string) => void; selected?: string | null; height?: number;
}) {
  const height = props.height ?? 120;
  const wrap = useRef<HTMLDivElement>(null);
  const [plotPx, setPlotPx] = useState(0);
  useEffect(() => {
    const plot = wrap.current?.querySelector("[data-chart-plot]");
    if (!plot) return;
    const measure = () => setPlotPx(plot.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(plot);
    return () => observer.disconnect();
  }, [props.bars.length > 0]);

  const bars = props.bars.map((b) => {
    const parts = props.series
      .map((s) => ({ series: s.key, label: s.label, value: b.parts.filter((p) => p.series === s.key).reduce((sum, p) => sum + (Number.isFinite(p.value) && p.value > 0 ? p.value : 0), 0) }))
      .filter((p) => p.value > 0);
    return { key: b.key, label: b.label, parts, total: parts.reduce((sum, p) => sum + p.value, 0) };
  });
  const max = Math.max(0, ...bars.map((b) => b.total));
  if (bars.length === 0 || max <= 0) return <div class="w-muted" style={{ height: `${height}px`, display: "grid", placeItems: "center" }}>Nothing to chart yet.</div>;

  // viewBox x units per screen px (the plot stretches 300 units across its width); unknown until measured.
  const unit = plotPx > 0 ? W / plotPx : null;
  const slot = W / bars.length;
  const barW = Math.min(slot * BAND_FILL, unit ? MAX_BAR_PX * unit : Infinity);
  const rx = unit ? RADIUS_PX * unit : barW / 6;
  const centers = bars.map((_, i) => slot * (i + 0.5));
  const y = scaleY(0, max, height);
  const fallback = assignColors(props.series.map((s) => s.key));
  const colorOf = (key: string) => props.series.find((s) => s.key === key)?.color ?? fallback.get(key) ?? "var(--c-other)";
  const tick = (v: number) => (props.privacy ? HIDDEN : formatCompactMoney(v, props.currency));
  const legend: LegendItem[] = props.series.map((s) => ({ key: s.key, label: s.label, color: colorOf(s.key), mark: "dot" }));
  const picked = bars.find((b) => b.key === props.selected) ?? null;
  const summary = `${props.label}: ${bars.map((b) => `${b.label} ${props.privacy ? HIDDEN : moneyText(b.total, props.currency, false)}`).join(", ")}${picked ? `. Selected: ${picked.label}` : ""}`;
  const midI = bars.length > 2 ? Math.floor((bars.length - 1) / 2) : -1;

  return (
    <div ref={wrap}>
      <ChartFrame height={height} summary={summary} xs={centers} legend={legend}
        yTicks={[tick(max), tick(max / 2), tick(0)]}
        xTicks={{ start: bars[0].label, mid: midI >= 0 ? { at: centers[midI], text: bars[midI].label } : null, end: bars[bars.length - 1].label }}
        onActivate={props.onBar ? (i) => props.onBar!(bars[i].key) : undefined}
        tip={(i) => ({
          title: bars[i].label,
          lines: [...bars[i].parts.map((p) => `${p.label} ${moneyText(p.value, props.currency, props.privacy)}`), `Total ${moneyText(bars[i].total, props.currency, props.privacy)}`],
          dots: [],
        })}>
        {bars.map((b, i) => {
          let top = y(0);
          const x = centers[i] - barW / 2;
          return (
            <g key={b.key} data-bar={b.key} data-width={barW} data-selected={picked?.key === b.key ? "true" : undefined}
              opacity={picked && picked.key !== b.key ? "0.4" : "1"}
              style={{ cursor: props.onBar ? "pointer" : undefined }} onClick={props.onBar ? () => props.onBar!(b.key) : undefined}>
              <rect x={slot * i} y="0" width={slot} height={height} fill="transparent" />
              {b.parts.map((p, j) => {
                const h = (p.value / max) * (height - 2 * PAD);
                top -= h;
                const last = j === b.parts.length - 1;
                // Segments above the first give up their bottom GAP_PX so the surface shows between them.
                const drawn = j > 0 ? Math.max(h - GAP_PX, 0.5) : h;
                const d = last ? topRounded(x, top, barW, drawn, rx, RADIUS_PX) : `M${x.toFixed(3)},${top.toFixed(3)} h${barW.toFixed(3)} v${drawn.toFixed(3)} h${(-barW).toFixed(3)} Z`;
                return <path key={p.series} data-series={p.series} data-height={h.toFixed(4)} data-top={last ? "true" : undefined} d={d} fill={colorOf(p.series)} />;
              })}
            </g>
          );
        })}
      </ChartFrame>
    </div>
  );
}
