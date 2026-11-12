import type { ScheduledJob } from "./scheduler.js";

type Log = (event: Record<string, unknown>) => void;

export interface NightlyDeps {
  pipeline?: { runAll(): Promise<{ users: number; synced: number; reconstructed: number; rows: number; failures: number; deferred: number; failureCodes?: Record<string, number> }> };
  snapshots?: { captureAll(): Promise<{ users: number; rows: number; failures: number }> };
  retention?: { purge(): Promise<{ snapshots: number; webhookEvents: number; subjectRevocations?: number; disconnects?: { pending: number; cleared: number; expired: number; failed: number } }> };
  /** Counts-only log sink (default: one JSON line on stderr via console.warn). */
  log?: Log;
}

/**
 * The nightly job: the activity pipeline (or, without one, the plain snapshots), then the retention sweep. Each step
 * runs even if an earlier one failed; a pipeline or snapshot failure is rethrown at the end so the scheduler records it.
 */
export async function runNightly(deps: NightlyDeps): Promise<void> {
  const log = deps.log ?? ((event) => console.warn(JSON.stringify(event)));
  let failure: { error: unknown } | undefined;
  try {
    if (deps.pipeline) {
      const result = await deps.pipeline.runAll();
      log({ event: "nightly_pipeline", users: result.users, synced: result.synced, reconstructed: result.reconstructed, rows: result.rows, failures: result.failures, deferred: result.deferred, failureCodes: result.failureCodes ?? {} });
    } else if (deps.snapshots) {
      const result = await deps.snapshots.captureAll();
      log({ event: "daily_snapshots", users: result.users, rows: result.rows, failures: result.failures });
    }
  } catch (error) {
    failure = { error };
  }
  if (deps.retention) {
    // Best effort: a failed sweep is retried the next night and never fails the run.
    try {
      const purged = await deps.retention.purge();
      log({ event: "retention_purge", snapshots: purged.snapshots, webhookEvents: purged.webhookEvents, ...(purged.subjectRevocations !== undefined ? { subjectRevocations: purged.subjectRevocations } : {}), ...(purged.disconnects ? { disconnects: purged.disconnects } : {}) });
    } catch {
      log({ event: "retention_purge_failed" });
    }
  }
  if (failure) throw failure.error;
}

/** The 10-minute catch-up for people who just linked. Quiet when nobody is due; counts only otherwise. */
export function historyCatchupJob(
  pipeline: { runPending(): Promise<{ users: number; synced: number; reconstructed: number; rows: number; failures: number; deferred: number; failureCodes: Record<string, number> }> },
  log: Log = (event) => console.warn(JSON.stringify(event)),
  /** The same lock function the scheduler uses. With it, the catch-up quietly yields while the nightly job or a manual refresh holds `nightly`. */
  lock?: (name: string, fn: () => Promise<void>) => Promise<boolean>,
): ScheduledJob {
  const work = async () => {
    const result = await pipeline.runPending();
    if (result.users > 0 || result.failures > 0) log({ event: "history_catchup", ...result });
  };
  return {
    name: "history-catchup",
    spec: { kind: "every", minutes: 10 },
    run: lock ? async () => { await lock("nightly", work); } : work,
  };
}
