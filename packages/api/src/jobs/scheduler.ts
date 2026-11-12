export type ScheduleSpec =
  | { kind: "daily"; hour: number; minute: number; weekdaysOnly: boolean }
  | { kind: "every"; minutes: number };

const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

function zonedParts(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Offset of the zone from UTC at an instant, in ms (negative west of Greenwich). */
function offsetAt(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
}

/** The instant at which the zone's wall clock reads the given date and time (day overflow is normalised by Date.UTC). */
function wallClockToInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  let instant = asUtc - offsetAt(asUtc, timeZone);
  // The offset can differ at the corrected instant (a DST change between the guess and the answer): correct once more.
  instant = asUtc - offsetAt(instant, timeZone);
  return instant;
}

/**
 * The first run strictly after `after`.
 *
 * A daily time that does not exist on a spring-forward day (for example 02:30 on 2026-03-08) resolves to the instant
 * before the gap (06:30Z, 01:30 EST), so it runs once that day, an hour early. A time that occurs twice on a fall-back
 * day runs at its first occurrence only.
 */
export function nextRun(spec: ScheduleSpec, after: Date, timeZone: "America/Toronto"): Date {
  const afterMs = after.getTime();
  if (spec.kind === "every") {
    const step = spec.minutes * 60_000;
    return new Date((Math.floor(afterMs / step) + 1) * step);
  }
  const today = zonedParts(afterMs, timeZone);
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = wallClockToInstant(today.year, today.month, today.day + offset, spec.hour, spec.minute, timeZone);
    if (candidate <= afterMs) continue;
    if (spec.weekdaysOnly) {
      const p = zonedParts(candidate, timeZone);
      const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
    }
    return new Date(candidate);
  }
  throw new Error("no_next_run");
}

export interface ScheduledJob { name: string; spec: ScheduleSpec; run(): Promise<void> }

export interface SchedulerOptions {
  jobs: ScheduledJob[];
  /** Runs `fn` under the named cross-process lock; false (and `fn` not run) when someone else holds it. */
  lock: (name: string, fn: () => Promise<void>) => Promise<boolean>;
  now?: () => Date;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  /** Structured log sink: counts and codes only. */
  log?: (event: Record<string, unknown>) => void;
}

/** A short, data-free label for a failure: its string `code` (such as a database error code) or its class name. */
function failureLabel(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) return code;
  const name = (error as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  return typeof name === "string" && /^[A-Za-z0-9_$]{1,64}$/.test(name) ? name : "unknown";
}

const isInt = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;

function validateSpec(spec: ScheduleSpec): void {
  const ok = spec.kind === "every"
    ? isInt(spec.minutes, 1, Number.MAX_SAFE_INTEGER)
    : spec.kind === "daily" && isInt(spec.hour, 0, 23) && isInt(spec.minute, 0, 59);
  if (!ok) throw new Error("invalid_schedule");
}

export function startScheduler(options: SchedulerOptions): { stop(): Promise<void> } {
  for (const job of options.jobs) validateSpec(job.spec);
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const sink = options.log ?? ((event) => console.warn(JSON.stringify(event)));
  // A broken log sink must never turn into an unhandled rejection.
  const log = (event: Record<string, unknown>) => { try { sink(event); } catch { /* nothing else to do */ } };
  let stopped = false;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<Promise<void>>();

  const arm = (job: ScheduledJob): void => {
    if (stopped) return;
    try {
      const due = nextRun(job.spec, now(), "America/Toronto");
      const delay = Math.min(Math.max(due.getTime() - now().getTime(), 1), MAX_TIMER_MS);
      timers.set(job.name, setTimer(() => { track(fire(job, due)); }, delay));
    } catch (error) {
      log({ event: "job_failed", job: job.name, error: failureLabel(error) });
    }
  };

  const track = (run: Promise<void>): void => {
    inFlight.add(run);
    void run.finally(() => inFlight.delete(run));
  };

  const fire = async (job: ScheduledJob, due: Date): Promise<void> => {
    timers.delete(job.name);
    if (stopped) return;
    // A capped (or early) timer: not due yet, wait again without running.
    if (now().getTime() < due.getTime()) {
      arm(job);
      return;
    }
    try {
      const ran = await options.lock(job.name, job.run);
      if (!ran) log({ event: "job_skipped_locked", job: job.name });
    } catch (error) {
      log({ event: "job_failed", job: job.name, error: failureLabel(error) });
    }
    arm(job);
  };

  for (const job of options.jobs) arm(job);

  return {
    /** Clears the timers and starts no new run; settles once any run already in progress has finished. */
    async stop() {
      stopped = true;
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
      await Promise.allSettled([...inFlight]);
    },
  };
}
