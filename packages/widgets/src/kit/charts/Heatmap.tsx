import { formatSignedPercent } from "../format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export interface HeatmapMonth { month: string; return: number | null; partial: boolean; estimated: boolean }

// Opacity scales with |return|, saturating at 10%; capped so the text stays readable in both themes.
const tone = (r: number) => {
  const pct = Math.round(12 + Math.min(1, Math.abs(r) / 0.1) * 43);
  return `color-mix(in srgb, var(${r < 0 ? "--down" : "--up"}) ${pct}%, var(${r < 0 ? "--down-bg" : "--up-bg"}))`;
};

/** Rows are years, columns are months. Labels carry percentages only. */
export function Heatmap(props: { months: HeatmapMonth[]; label: string }) {
  const years = new Map<string, Map<number, HeatmapMonth>>();
  for (const m of props.months) {
    const [year, mm] = m.month.split("-");
    const idx = Number(mm) - 1;
    if (!year || !(idx >= 0 && idx < 12)) continue;
    if (!years.has(year)) years.set(year, new Map());
    years.get(year)!.set(idx, m);
  }
  const rows = [...years.entries()].sort(([a], [b]) => a.localeCompare(b));
  const flagged = props.months.some((m) => m.partial || m.estimated);
  return (
    <div>
      <div class="w-heat" role="group" aria-label={props.label}>
        <span />
        {MONTHS.map((name) => <span class="w-heat-head" aria-hidden="true">{name[0]}</span>)}
        {rows.flatMap(([year, cells]) => [
          <span class="w-heat-year" data-year={year}>{year}</span>,
          ...MONTHS.map((name, i) => {
            const cell = cells.get(i);
            if (!cell) return <span class="w-heat-cell" aria-hidden="true" />;
            const r = cell.return !== null && Number.isFinite(cell.return) ? cell.return : null;
            return (
              <span
                class="w-heat-cell"
                data-month={cell.month}
                data-partial={String(cell.partial)}
                data-estimated={String(cell.estimated)}
                role="img"
                aria-label={`${name} ${year}: ${r === null ? "no data" : formatSignedPercent(r, 1)}`}
                title={cell.partial ? "Partial month" : cell.estimated ? "Estimated" : undefined}
                style={r === null ? undefined : { background: tone(r) }}
              >
                {r === null ? "" : formatSignedPercent(r, 0)}
              </span>
            );
          }),
        ])}
      </div>
      {flagged && <div class="w-muted" style={{ marginTop: "4px" }}>Dashed outline: partial or estimated month.</div>}
    </div>
  );
}
