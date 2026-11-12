import { Fragment } from "preact";

/**
 * Two or three figures on one scale, as horizontal bars with the figure at the right: the report card's "so far" race
 * and the performance view's per-year rates. Bars grow once on load (not under reduced motion). With a negative figure
 * the bars meet at a centre zero line. `tone` picks the brand colour: "you" teal, "index" neutral grey.
 */
export interface CompareRow { label: string; value: number; figure: string; tone: "you" | "index" }

export function compareGeometry(value: number, max: number, centred: boolean): { left: number; width: number } {
  if (!centred) return { left: 0, width: (Math.abs(value) / max) * 100 };
  const width = Math.min(Math.abs(value) / max, 1) * 50;
  return { left: value >= 0 ? 50 : 50 - width, width };
}

export function CompareBars({ rows, label }: { rows: CompareRow[]; label: string }) {
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1e-9);
  const centred = rows.some((r) => r.value < 0);
  return (
    <div class="w-cmp" role="img" aria-label={label}>
      {rows.map((r) => {
        const g = compareGeometry(r.value, max, centred);
        return (
          <Fragment key={r.label}>
            <span class="w-cmp-n">{r.label}</span>
            <span class="w-cmp-t">
              {centred && <span class="w-cmp-z" />}
              <span class={`w-cmp-f w-cmp-${r.tone}${r.value < 0 ? " w-cmp-neg" : ""}`} style={{ left: `${g.left}%`, width: `max(${g.width}%, 2px)` }} />
            </span>
            <span class="w-cmp-v">{r.figure}</span>
          </Fragment>
        );
      })}
    </div>
  );
}
