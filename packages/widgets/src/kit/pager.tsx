import { useEffect, useRef, useState } from "preact/hooks";

/** Rows shown per page in long widget lists (owner request 2026-10-23: less scrolling). */
export const PAGE_SIZE = 10;

export interface PagerState<T> {
  visible: T[];
  label: string;
  canPrev: boolean;
  canNext: boolean;
  busy: boolean;
  show: boolean;
  prev(): void;
  next(): void;
}

/**
 * Client-side pages of PAGE_SIZE over the rows loaded so far. Next past the loaded rows calls
 * `fetchMore` (the server still pages in larger batches) and advances once they arrive.
 * A new `resetKey` (filters, symbol, account) returns to the first page. `blocked` disables fetching
 * more (for example while the list itself is reloading); paging through loaded rows still works.
 */
export function usePager<T>(rows: T[], hasMore: boolean, fetchMore: () => Promise<unknown>, resetKey: string, blocked = false, size = PAGE_SIZE): PagerState<T> {
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const wantNext = useRef(false);
  const key = useRef(resetKey);
  if (key.current !== resetKey) { key.current = resetKey; wantNext.current = false; if (page !== 0) setPage(0); }

  const loadedPages = Math.max(1, Math.ceil(rows.length / size));
  useEffect(() => {
    if (wantNext.current && (page + 1) * size < rows.length) { wantNext.current = false; setPage(page + 1); }
    else if (page >= loadedPages) setPage(loadedPages - 1);
  }, [rows.length]);

  const start = page * size;
  const visible = rows.slice(start, start + size);
  const end = start + visible.length;
  const canNext = end < rows.length || hasMore;
  return {
    visible,
    label: rows.length === 0 ? "" : `${start + 1}–${end} of ${rows.length}${hasMore ? "+" : ""}`,
    canPrev: page > 0,
    canNext: canNext && !busy && !(blocked && end >= rows.length),
    busy,
    show: rows.length > size || hasMore,
    prev: () => { wantNext.current = false; setPage((p) => Math.max(0, p - 1)); },
    next: () => {
      if (end < rows.length) { setPage(page + 1); return; }
      if (!hasMore || busy || blocked) return;
      wantNext.current = true;
      setBusy(true);
      void fetchMore().finally(() => setBusy(false));
    },
  };
}

export function Pager<T>(props: { pager: PagerState<T> }) {
  const p = props.pager;
  if (!p.show) return null;
  return (
    <nav class="w-pager" aria-label="Pages">
      <button type="button" class="w-chip" aria-label="Previous page" disabled={!p.canPrev} onClick={p.prev}>‹ Prev</button>
      <span class="w-muted" aria-live="polite">{p.busy ? "Loading…" : p.label}</span>
      <button type="button" class="w-chip" aria-label="Next page" disabled={!p.canNext} onClick={p.next}>Next ›</button>
    </nav>
  );
}
