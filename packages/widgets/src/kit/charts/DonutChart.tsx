import { useEffect, useId, useRef, useState } from "preact/hooks";
import { formatPercent } from "../format";
import { moneyText } from "./ChartFrame";
import { UNCLASSIFIED_COLOR, assignColors } from "./palette";

export interface DonutSlice {
  key: string; label: string; fraction: number; value?: number | null; currency?: string; estimated?: boolean;
  /** A palette colour (palette.ts). Without one, slices take slots in order and "unclassified" is the hatched neutral. */
  color?: string;
}

const SIZE = 100;
const C = SIZE / 2;
const R_OUT = 48;
/** Ring thickness is 28% of the outer radius. */
const R_IN = R_OUT * 0.72;

const point = (r: number, angle: number) => `${(C + r * Math.sin(angle)).toFixed(3)},${(C - r * Math.cos(angle)).toFixed(3)}`;

/** Annular sector from angle a0 to a1 (radians clockwise from 12 o'clock). */
function arc(a0: number, a1: number): string {
  // A full ring cannot be one arc (start equals end), so stop a hair short.
  const end = Math.min(a1, a0 + Math.PI * 2 - 1e-4);
  const large = end - a0 > Math.PI ? 1 : 0;
  return `M${point(R_OUT, a0)} A${R_OUT},${R_OUT} 0 ${large} 1 ${point(R_OUT, end)} L${point(R_IN, end)} A${R_IN},${R_IN} 0 ${large} 0 ${point(R_IN, a0)} Z`;
}

/**
 * Donut with a centre label and pointer/touch/keyboard read-out. The centre shows the hovered slice (label, percent,
 * value), else the `selected` slice, else the largest slice; never a bare 100%. `legend={false}` when a list beside it
 * names the slices.
 */
export function DonutChart(props: {
  slices: DonutSlice[]; privacy: boolean; label: string; onSlice?: (key: string) => void;
  selected?: string | null; legend?: boolean;
  /** How the centre writes a share (default one decimal), so it can match a list beside the chart. */
  percent?: (fraction: number) => string;
  /** Slices are drawn as parts of a whole; the labels multiply back by this when the stated shares don't add up to 100%. */
  fractionScale?: number;
}) {
  const [active, setActive] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const hatchId = `${useId()}-hatch`.replace(/[^\w-]/g, "");
  useEffect(() => {
    if (active === null) return;
    const away = (e: Event) => { if (!hostRef.current?.contains(e.target as Node)) setActive(null); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [active === null]);

  const valid = props.slices.filter((s) => Number.isFinite(s.fraction) && s.fraction > 0);
  const total = valid.reduce((sum, s) => sum + s.fraction, 0);
  if (valid.length === 0 || total <= 0) return <div class="w-muted">Nothing to chart yet.</div>;
  const fallback = assignColors(valid.map((s) => s.key), (k) => (k === "unclassified" ? "unclassified" : undefined));
  let angle = 0;
  const slices = valid.map((s) => {
    const fraction = s.fraction / total;
    const a0 = angle;
    angle += fraction * Math.PI * 2;
    return { ...s, fraction, color: s.color ?? fallback.get(s.key)!, d: arc(a0, angle) };
  });
  const fill = (color: string) => (color === UNCLASSIFIED_COLOR ? `url(#${hatchId})` : color);
  const pctText = (f: number) => formatPercent(f * (props.fractionScale ?? 1), 1);
  const focus = slices.find((s) => s.key === active) ?? null;
  const picked = slices.find((s) => s.key === props.selected) ?? null;
  const lit = focus ?? picked;
  const largest = slices.reduce((a, s) => (s.fraction > a.fraction ? s : a), slices[0]);
  const shown = picked ?? largest;
  const tipLines = focus ? [
    pctText(focus.fraction),
    ...(focus.value === undefined || focus.value === null ? [] : [`${moneyText(focus.value, focus.currency, props.privacy)}${focus.estimated ? " est." : ""}`]),
    ...((focus.value === undefined || focus.value === null) && focus.estimated ? ["est."] : []),
  ] : [];
  const summary = `${props.label}: ${slices.map((s) => `${s.label} ${pctText(s.fraction)}`).join(", ")}`;
  const gap = slices.length > 1;

  return (
    <div class="w-chart w-donut" ref={hostRef}>
      <div class="w-donut-plot">
        <svg class="w-donut-svg" viewBox={`0 0 ${SIZE} ${SIZE}`} role="group" aria-label={summary}>
          {slices.some((s) => s.color === UNCLASSIFIED_COLOR) && (
            <defs>
              <pattern id={hatchId} patternUnits="userSpaceOnUse" width="2.6" height="2.6" patternTransform="rotate(45)">
                <rect width="2.6" height="2.6" fill="var(--c-unclassified)" />
                <rect width="0.8" height="2.6" fill="var(--c-other)" />
              </pattern>
            </defs>
          )}
          {slices.map((s) => (
            <path key={s.key} data-slice={s.key} data-fraction={s.fraction} data-color={s.color} d={s.d} fill={fill(s.color)}
              stroke={gap ? "var(--bg)" : "none"} stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"
              tabindex={props.onSlice ? 0 : undefined}
              role={props.onSlice ? "button" : undefined} aria-label={props.onSlice ? `${s.label} ${pctText(s.fraction)}` : undefined}
              aria-pressed={props.onSlice && props.selected !== undefined ? props.selected === s.key : undefined}
              style={{ cursor: props.onSlice ? "pointer" : "default", outline: "none", opacity: lit && lit.key !== s.key ? 0.4 : 1 }}
              onPointerEnter={() => setActive(s.key)} onPointerDown={() => setActive(s.key)}
              onPointerLeave={(e) => { if ((e as PointerEvent).pointerType !== "touch") setActive(null); }}
              onFocus={() => setActive(s.key)} onBlur={() => setActive(null)}
              onClick={() => props.onSlice?.(s.key)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setActive(null);
                else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onSlice?.(s.key); }
              }} />
          ))}
        </svg>
        {focus ? (
          <div class="w-donut-center" data-chart-tip aria-hidden="true">
            <b class="c-lbl">{focus.label}</b>
            <span class="c-pct">{props.percent ? props.percent(focus.fraction) : tipLines[0]}</span>
            {tipLines.slice(1).map((line, i) => <span key={i} class="c-sub">{line}</span>)}
          </div>
        ) : (
          <div class="w-donut-center" data-donut-center aria-hidden="true">
            <span class="c-lbl">{shown.label}</span>
            <span class="c-pct">{(props.percent ?? pctText)(shown.fraction)}</span>
          </div>
        )}
      </div>
      {props.legend !== false && (
        <div class="w-chart-legend" data-chart-legend>
          {slices.map((s) => <span key={s.key} data-legend={s.key}><i aria-hidden="true" data-dash="dot" style={{ color: s.color }} />{`${s.label} ${pctText(s.fraction)}`}</span>)}
        </div>
      )}
      <div class="w-sr" aria-live="polite">{focus ? [focus.label, ...tipLines].join(". ") : ""}</div>
    </div>
  );
}
