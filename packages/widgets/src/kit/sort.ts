/** Shared sorting for the widgets' tables: missing values last, a stable tie-break, optional groups. */

export type SortDir = "asc" | "desc";
export type SortValue = number | string | null | undefined;

const collator = new Intl.Collator("en-CA");

/** A number that can be ordered; NaN and infinities count as missing. */
const missing = (v: SortValue): v is null | undefined => v == null || (typeof v === "number" && !Number.isFinite(v));

/** Orders two values in `dir`. A missing value sorts after any real one in both directions. */
export function compareSortValues(a: SortValue, b: SortValue, dir: SortDir): number {
  const ma = missing(a); const mb = missing(b);
  if (ma && mb) return 0;
  if (ma) return 1;
  if (mb) return -1;
  const order = typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
  return dir === "asc" ? order : -order;
}

export interface SortSpec<R> {
  value: (r: R) => SortValue;
  dir: SortDir;
  /**
   * For a value that only compares within a unit (a native price in CAD against one in USD): rows are kept in groups,
   * ordered by this key (ascending, whichever the direction), and sorted by `value` inside each group.
   */
  group?: (r: R) => string;
  /** Equal values fall back to this key, always ascending, then to the incoming order. */
  tieBreak?: (r: R) => string;
}

/** A sorted copy of `rows`. Ties keep a stable order: `tieBreak` ascending, then the order the rows came in. */
export function sortRows<R>(rows: readonly R[], spec: SortSpec<R>): R[] {
  const { value, dir, group, tieBreak } = spec;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => {
      if (group) {
        const g = collator.compare(group(x.row), group(y.row));
        if (g !== 0) return g;
      }
      const v = compareSortValues(value(x.row), value(y.row), dir);
      if (v !== 0) return v;
      if (tieBreak) {
        const t = collator.compare(tieBreak(x.row), tieBreak(y.row));
        if (t !== 0) return t;
      }
      return x.index - y.index;
    })
    .map((x) => x.row);
}

/** The direction after choosing `key`: the other direction when it is already the sort, else `first`. */
export function nextSortDir(current: { key: string; dir: SortDir } | null, key: string, first: SortDir = "asc"): SortDir {
  return current?.key === key ? (current.dir === "asc" ? "desc" : "asc") : first;
}

/** Whether the rows span more than one group (so a within-group sort is worth announcing). */
export function hasGroups<R>(rows: readonly R[], group: (r: R) => string): boolean {
  const first = rows.length > 0 ? group(rows[0]) : null;
  return rows.some((r) => group(r) !== first);
}
