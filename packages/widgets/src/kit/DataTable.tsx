import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Pager, usePager } from "./pager";
import { hasGroups, nextSortDir, sortRows, type SortDir } from "./sort";

export interface Column<R> {
  key: string;
  label: string;
  align?: "left" | "right";
  sortValue?: (r: R) => number | string | null;
  /**
   * For a value that only compares within a unit (a native price in CAD against one in USD). Sorting by this column keeps
   * the rows in groups (ascending by `by`) and sorts inside each; `note` is shown when the rows span more than one group.
   */
  within?: { by: (r: R) => string; note: string };
  render: (r: R) => ComponentChildren;
  /** Narrow containers: "hidden" columns are not rendered; "primary" is the lead cell; "secondary" (default) is shown smaller. */
  mobile?: "primary" | "secondary" | "hidden";
}

/** A sort choice that has no column of its own (the percent inside a combined cell); offered in the sort control. */
export type SortOption<R> = Pick<Column<R>, "key" | "label" | "sortValue" | "within">;

export const NARROW_BELOW = 400;

type Sort = { key: string; dir: SortDir };

/** True when the event came from a button, link or form control inside the row (not the row itself). */
function fromInteractive(e: Event): boolean {
  const hit = (e.target as Element | null)?.closest?.("button, a, input, select, textarea, [role='button']");
  return !!hit && hit !== e.currentTarget && (e.currentTarget as Element).contains(hit);
}

export function DataTable<R>(p: {
  rows: R[]; columns: Column<R>[]; rowKey: (r: R) => string; initialSort?: Sort; onRowClick?: (r: R) => void; expand?: (r: R) => ComponentChildren; label: string;
  /** Force the narrow layout (otherwise it follows the container width, below 400 px). */
  narrow?: boolean;
  /** Called after a header click changes the sort (the table still sorts what it has). */
  onSortChange?: (key: string, dir: "asc" | "desc") => void;
  /** Rows for which this returns false get no expand button. Default: every row expands. */
  canExpand?: (r: R) => boolean;
  /** More sort keys for the sort control, beyond the sortable columns. A table with any shows the control at every width. */
  extraSorts?: SortOption<R>[];
  /** Rows with equal sort values fall back to this key (ascending, whichever the direction), then to the incoming order. */
  tieBreak?: (r: R) => string;
  /** Show this many sorted rows per page with Prev/Next; a sort change or new rows return to page 1. */
  pageSize?: number;
}): JSX.Element {
  const [sort, setSort] = useState<Sort | null>(p.initialSort ?? null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [measured, setMeasured] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el || p.narrow !== undefined) return;
    const measure = () => { const w = el.getBoundingClientRect().width; setMeasured(w > 0 && w < NARROW_BELOW); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [p.narrow]);
  const narrow = p.narrow ?? measured;

  const columns = narrow ? p.columns.filter((c) => c.mobile !== "hidden") : p.columns;
  const options: SortOption<R>[] = [...p.columns.filter((c) => c.sortValue), ...(p.extraSorts ?? [])];
  const sortColumn = sort ? options.find((c) => c.key === sort.key) : undefined;
  const rows = sort && sortColumn?.sortValue
    ? sortRows(p.rows, { value: sortColumn.sortValue, dir: sort.dir, group: sortColumn.within?.by, tieBreak: p.tieBreak })
    : p.rows;
  const withinNote = sortColumn?.within && hasGroups(p.rows, sortColumn.within.by) ? sortColumn.within.note : null;
  // A narrow table drops its hidden columns, and with them their headers: a compact control keeps every sort reachable.
  const sortControl = options.length > 0 && ((p.extraSorts?.length ?? 0) > 0 || (narrow && p.columns.some((c) => c.sortValue && c.mobile === "hidden")));
  const pager = usePager(rows, false, async () => {}, `${sort?.key ?? ""}|${sort?.dir ?? ""}|${p.rows.length}`, false, p.pageSize ?? Math.max(1, rows.length));
  const shownRows = p.pageSize ? pager.visible : rows;
  const choose = (key: string, dir: SortDir) => { setSort({ key, dir }); p.onSortChange?.(key, dir); };
  // A new key starts highest first when its values are numbers (price, value, gain), A to Z when they're text.
  const firstDir = (key: string): SortDir => {
    const value = options.find((c) => c.key === key)?.sortValue;
    const sample = value ? p.rows.map(value).find((v) => v != null) : undefined;
    return typeof sample === "number" ? "desc" : "asc";
  };
  const toggleSort = (key: string) => choose(key, nextSortDir(sort, key, firstDir(key)));
  const toggleOpen = (id: string) => setOpen((cur) => { const next = new Set(cur); if (!next.delete(id)) next.add(id); return next; });
  const span = columns.length + (p.expand ? 1 : 0);

  return (
    <div ref={wrap} class="w-table-wrap" data-narrow={narrow ? "true" : "false"}>
      {sortControl && (
        <div class="w-row w-sortbar">
          <select aria-label="Sort by" value={sort?.key ?? ""} onChange={(e) => { const key = (e.target as HTMLSelectElement).value; if (key && key !== sort?.key) choose(key, nextSortDir(sort, key, firstDir(key))); }}>
            {!sort && <option value="">Sort by…</option>}
            {options.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          {sort && (
            <button type="button" class="w-chip w-toggle" aria-label={`Sort order: ${sort.dir === "asc" ? "ascending" : "descending"}. Switch to ${sort.dir === "asc" ? "descending" : "ascending"}`}
              onClick={() => choose(sort.key, sort.dir === "asc" ? "desc" : "asc")}>{sort.dir === "asc" ? "▲ Ascending" : "▼ Descending"}</button>
          )}
        </div>
      )}
      <table class="w-table" aria-label={p.label}>
        <thead>
          <tr>
            {p.expand && <th scope="col"><span class="w-sr">Details</span></th>}
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th key={c.key} scope="col" data-align={c.align ?? "left"} aria-sort={c.sortValue ? (active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none") : undefined}>
                  {c.sortValue
                    ? <button type="button" class="w-th-btn" onClick={() => toggleSort(c.key)}>{c.label}<span aria-hidden="true">{active ? (sort!.dir === "asc" ? " ▲" : " ▼") : ""}</span></button>
                    : c.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {shownRows.map((r) => {
            const id = p.rowKey(r);
            const expanded = open.has(id);
            const activate = p.onRowClick;
            return [
              <tr key={id} data-row={id} class={activate ? "w-row-click" : undefined} tabIndex={activate ? 0 : undefined}
                onClick={activate ? (e) => { if (!fromInteractive(e)) activate(r); } : undefined}
                onKeyDown={activate ? (e) => { if ((e.key === "Enter" || e.key === " ") && !fromInteractive(e)) { e.preventDefault(); activate(r); } } : undefined}>
                {p.expand && (
                  <td class="w-chev-cell">
                    {(p.canExpand ? p.canExpand(r) : true) && <button type="button" class="w-chev" aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "Show"} details`}
                      onClick={(e) => { e.stopPropagation(); toggleOpen(id); }} onKeyDown={(e) => e.stopPropagation()}>
                      <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                    </button>}
                  </td>
                )}
                {columns.map((c) => <td key={c.key} data-align={c.align ?? "left"} data-mobile={c.mobile ?? "secondary"}>{c.render(r)}</td>)}
              </tr>,
              expanded && p.expand && (p.canExpand ? p.canExpand(r) : true) ? <tr key={`${id}:x`} class="w-expand"><td colSpan={span}>{p.expand(r)}</td></tr> : null,
            ];
          })}
        </tbody>
      </table>
      {withinNote && <small class="w-muted">{withinNote}</small>}
      {p.pageSize && <Pager pager={pager} />}
    </div>
  );
}
