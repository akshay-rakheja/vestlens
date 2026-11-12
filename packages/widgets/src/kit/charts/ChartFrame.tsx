import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { formatMoney, formatPercent, formatSignedMoney, formatSignedPercent } from "../format";

/** Every chart draws into a 300-unit-wide viewBox stretched to the container width. */
export const W = 300;
/** Vertical padding inside the plot: the y-axis max sits at PAD, the min at height - PAD. */
export const PAD = 6;
export const HIDDEN = "••••";

export interface LegendItem { key: string; label: string; color: string; mark?: "line" | "dashed" | "dot" | "ring" }
export interface Tip { title: string; lines: string[]; /** y in px of each series at this point, for the crosshair dots. */ dots: Array<{ y: number; color: string }> }

export interface ChartFrameProps {
  height: number;
  summary: string;
  /** x of each hoverable point in viewBox units, ascending. */
  xs: number[];
  /** Labels at the top (max), middle and bottom (min) gridlines. */
  yTicks: [string, string, string];
  /** Start, middle and end labels; `at` is the x of the middle label in viewBox units. */
  xTicks: { start: string; mid: { at: number; text: string } | null; end: string };
  legend: LegendItem[];
  tip: (index: number) => Tip;
  children: ComponentChildren;
  /** Unscaled layers drawn above the plot (e.g. trade markers). */
  overlay?: ComponentChildren;
  /** Enter or Space on the keyboard-selected point (e.g. open a bar's detail). */
  onActivate?: (index: number) => void;
}

/** y in px for a value in [min, max] on a plot of `height`. */
export const scaleY = (min: number, max: number, height: number) => {
  const span = max - min || 1;
  return (v: number) => PAD + (1 - (v - min) / span) * (height - 2 * PAD);
};

/** Index of the x nearest to `target` in an ascending list (binary search). */
export function nearestIndex(xs: number[], target: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= target) lo = mid; else hi = mid;
  }
  return Math.abs(xs[hi] - target) < Math.abs(xs[lo] - target) ? hi : lo;
}

/** Index of the last item whose `t` is at or before `t`, or -1. */
export function atOrBefore(list: Array<{ t: number }>, t: number): number {
  let found = -1;
  for (let i = 0; i < list.length && list[i].t <= t; i++) found = i;
  return found;
}

/** Index of the point nearest the middle of the time range, for the middle x label. */
export function midIndex(ts: number[]): number {
  return ts.length > 2 ? nearestIndex(ts, (ts[0] + ts[ts.length - 1]) / 2) : -1;
}

export const pct = (fraction: number) => (Math.abs(fraction) < 0.0005 ? formatPercent(0, 1) : formatSignedPercent(fraction, 1));
export const moneyText = (amount: number, currency: string | undefined, privacy: boolean) =>
  privacy ? HIDDEN : currency ? formatMoney(amount, currency) : amount.toFixed(2);
export const signedMoneyText = (amount: number, currency: string | undefined, privacy: boolean) =>
  privacy ? HIDDEN : currency ? formatSignedMoney(amount, currency) : `${amount < 0 ? "−" : "+"}${Math.abs(amount).toFixed(2)}`;

/** Axes, gridlines, legend and a pointer/touch/keyboard crosshair with a tooltip around a chart's SVG paths. */
export function ChartFrame(props: ChartFrameProps) {
  const { height, xs } = props;
  const [active, setActive] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const last = xs.length - 1;
  const current = active !== null && active <= last ? active : null;

  // A tap (or click) outside the chart hides the tooltip.
  useEffect(() => {
    if (current === null) return;
    const away = (e: Event) => { if (!plotRef.current?.contains(e.target as Node)) setActive(null); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [current === null]);

  const track = (e: PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const width = rect.width || W;
    setActive(nearestIndex(xs, ((e.clientX - rect.left) / width) * W));
  };
  // Touch fires pointerleave right after the finger lifts; keep the tooltip until a tap elsewhere.
  const leave = (e: PointerEvent) => { if (e.pointerType !== "touch") setActive(null); };
  const key = (e: KeyboardEvent) => {
    let next: number | null | undefined;
    if (e.key === "ArrowRight") next = current === null ? 0 : Math.min(last, current + 1);
    else if (e.key === "ArrowLeft") next = current === null ? last : Math.max(0, current - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "Escape") next = null;
    else if ((e.key === "Enter" || e.key === " ") && props.onActivate && current !== null) { e.preventDefault(); props.onActivate(current); return; }
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
  };

  const tip = current === null ? null : props.tip(current);
  const frac = current === null ? 0 : xs[current] / W;
  const at = `${(frac * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  const ys = [PAD, height / 2, height - PAD];
  return (
    <div class="w-chart">
      <div class="w-chart-legend" data-chart-legend>
        {props.legend.map((item) => (
          <span key={item.key} data-legend={item.key}><i aria-hidden="true" data-dash={item.mark ?? "line"} style={{ color: item.color }} />{item.label}</span>
        ))}
      </div>
      <div class="w-chart-grid">
        <div class="w-chart-y" data-axis="y" aria-hidden="true" style={{ height: `${height}px` }}>
          {props.yTicks.map((text, i) => <span key={i}>{text}</span>)}
        </div>
        <div ref={plotRef} class="w-chart-plot" data-chart-plot onPointerMove={track} onPointerDown={track} onPointerLeave={leave}>
          <svg viewBox={`0 0 ${W} ${height}`} height={height} width="100%" role="img" tabindex={0} aria-label={props.summary} preserveAspectRatio="none"
            onKeyDown={key} onBlur={() => setActive(null)}>
            {ys.map((y) => <line key={y} data-grid x1="0" x2={W} y1={y} y2={y} stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke" />)}
            {props.children}
            {current !== null && <line data-crosshair x1={xs[current]} x2={xs[current]} y1="0" y2={height} stroke="var(--muted)" stroke-width="1" vector-effect="non-scaling-stroke" />}
          </svg>
          {props.overlay}
          {tip && (
            <>
              <svg aria-hidden="true" height={height} width="100%" class="w-chart-layer">
                {tip.dots.map((d, i) => <circle key={i} data-crosshair-dot cx={at} cy={d.y} r="3.5" fill={d.color} stroke="var(--bg)" stroke-width="1.5" />)}
              </svg>
              {/* left = x% and translateX(-x%) keeps the card inside the plot at every position. */}
              <div class="w-chart-tip" data-chart-tip aria-hidden="true" style={{ left: at, transform: `translateX(-${at})` }}>
                <b>{tip.title}</b>
                {tip.lines.map((line, i) => <div key={i}>{line}</div>)}
              </div>
            </>
          )}
        </div>
        <span />
        <div class="w-chart-x" data-axis="x" aria-hidden="true">
          <span>{props.xTicks.start}</span>
          {props.xTicks.mid && <span class="w-ax-mid" style={{ left: `${((props.xTicks.mid.at / W) * 100).toFixed(2)}%` }}>{props.xTicks.mid.text}</span>}
          <span>{props.xTicks.end}</span>
        </div>
      </div>
      <div class="w-sr" aria-live="polite">{tip ? [tip.title, ...tip.lines].join(". ") : ""}</div>
    </div>
  );
}
