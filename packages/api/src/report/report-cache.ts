/**
 * The report card's in-process cache: each subject's computed report for REPORT_CACHE_TTL_MS, at most REPORT_CACHE_MAX
 * subjects, and one shared computation while a report is being worked out. Memory only: nothing is persisted, and a
 * restart or another instance starts empty. A failed computation is never kept.
 *
 * Several instances serve the API, and a delete or a webhook on one can't clear another's memory. So each report keeps
 * the subject's data-version marker read when it was computed (report-version.ts), and every hit re-reads the marker:
 * a different marker, or one that can't be read, recomputes.
 */

export const REPORT_CACHE_TTL_MS = 30 * 60_000;
export const REPORT_CACHE_MAX = 200;

/** "computed": this request worked it out; "shared": it waited on one already running; "cached": stored, still current. */
export type ReportCacheSource = "computed" | "shared" | "cached";

export interface ReportCardCache<T> {
  get(subject: string, compute: () => Promise<T>): Promise<{ value: T; source: ReportCacheSource }>;
  /** Drops the subject's report; a computation still running for it is not stored when it finishes. */
  forget(subject: string): void;
  size(): number;
}

export interface ReportCacheOptions {
  ttlMs?: number;
  max?: number;
  clock?: () => number;
  /** The subject's data-version marker; without it, a report is trusted for the whole TTL (one instance only). */
  version?: (subject: string) => Promise<string>;
}

/** A marker that never matches: the read failed. */
const UNREAD: unique symbol = Symbol("unread");
type Version = string | typeof UNREAD;
interface Entry<T> { value?: { report: T; at: number; version: Version }; pending?: Promise<T> }

export function createReportCardCache<T>(opts: ReportCacheOptions = {}): ReportCardCache<T> {
  const ttl = opts.ttlMs ?? REPORT_CACHE_TTL_MS;
  const max = Math.max(1, opts.max ?? REPORT_CACHE_MAX);
  const clock = opts.clock ?? Date.now;
  const readVersion = async (subject: string): Promise<Version> => {
    if (!opts.version) return "";
    try {
      return await opts.version(subject);
    } catch {
      return UNREAD;
    }
  };
  const entries = new Map<string, Entry<T>>();
  const fresh = (e: Entry<T> | undefined, now: number): e is Entry<T> & { value: NonNullable<Entry<T>["value"]> } =>
    !!e?.value && now - e.value.at < ttl;

  const prune = (now: number) => {
    for (const [subject, e] of entries) if (e.value && now - e.value.at >= ttl) entries.delete(subject);
    // Map order is insertion order: the oldest computation goes first.
    for (const subject of entries.keys()) {
      if (entries.size <= max) break;
      entries.delete(subject);
    }
  };

  const start = (subject: string, compute: () => Promise<T>): Promise<T> => {
    const entry: Entry<T> = {};
    // The marker is read before the report: data that changes while it is worked out shows as a new marker next time.
    const pending = readVersion(subject).then((version) => compute().then((report) => ({ report, version: version as Version }))).then(
      ({ report, version }) => {
        if (entries.get(subject) === entry) {
          // Re-inserted so the order follows when each report was worked out.
          entries.delete(subject);
          entries.set(subject, { value: { report, at: clock(), version } });
          prune(clock());
        }
        return report;
      },
      (error: unknown) => {
        if (entries.get(subject) === entry) entries.delete(subject);
        throw error;
      },
    );
    entry.pending = pending;
    entries.delete(subject);
    entries.set(subject, entry);
    prune(clock());
    return pending;
  };

  return {
    async get(subject, compute) {
      const existing = entries.get(subject);
      if (fresh(existing, clock()) && existing.value.version !== UNREAD) {
        const current = await readVersion(subject);
        if (current !== UNREAD && current === existing.value.version) return { value: existing.value.report, source: "cached" };
        // Changed (or unreadable): drop it, unless another request already replaced it while the marker was read.
        if (entries.get(subject) === existing) entries.delete(subject);
      }
      const now = entries.get(subject);
      if (now?.pending) return { value: await now.pending, source: "shared" };
      if (fresh(now, clock()) && now !== existing) return { value: now.value.report, source: "cached" };
      return { value: await start(subject, compute), source: "computed" };
    },
    forget(subject) {
      entries.delete(subject);
    },
    size: () => entries.size,
  };
}
