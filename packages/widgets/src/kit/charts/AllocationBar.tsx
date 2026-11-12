import { assignColors } from "./palette";

export interface AllocationSlice { key: string; label: string; fraction: number }
export function AllocationBar(props: { slices: AllocationSlice[]; label: string }) {
  const finite = props.slices.filter((s) => Number.isFinite(s.fraction));
  const debits = finite.filter((s) => s.fraction < 0);
  const valid = finite.filter((s) => s.fraction >= 0);
  const total = valid.reduce((sum, s) => sum + s.fraction, 0);
  if (valid.length === 0 || total <= 0) return null;
  // A negative slice (a margin debit) can't be drawn, so the legend carries the stated shares and names it.
  const slices = valid.map((s) => ({ ...s, width: s.fraction / total, fraction: debits.length > 0 ? s.fraction : s.fraction / total }));
  // Palette slots in order; never cycled (a ninth slice is the neutral Other).
  const colors = assignColors(slices.map((s) => s.key));
  const pct = (f: number) => `${f < 0 ? "−" : ""}${Math.round(Math.abs(f) * 100)}%`;
  return (
    <div>
      <div role="img" tabIndex={0} aria-label={`${props.label}: ${[...slices, ...debits].map((s) => `${s.label} ${pct(s.fraction)}`).join(", ")}`} style={{ display: "flex", height: "10px", borderRadius: "99px", overflow: "hidden", gap: "2px" }}>
        {slices.map((slice) => <span data-slice={slice.key} style={{ width: pct(slice.width), background: colors.get(slice.key) }} />)}
      </div>
      <div class="w-row w-muted" style={{ marginTop: "8px", gap: "4px 12px" }}>
        {slices.map((slice) => <span><i aria-hidden="true" style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "2px", marginRight: "5px", background: colors.get(slice.key) }} />{`${slice.label} ${pct(slice.fraction)}`}</span>)}
        {debits.map((slice) => <span data-debit={slice.key}>{`${slice.label} ${pct(slice.fraction)} (margin debit, not drawn)`}</span>)}
      </div>
    </div>
  );
}
