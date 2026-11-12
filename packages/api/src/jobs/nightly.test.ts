import { describe, expect, it, vi } from "vitest";

import { runNightly, historyCatchupJob } from "./nightly.js";

const counts = { users: 1, synced: 1, reconstructed: 1, rows: 3, failures: 0, deferred: 0, failureCodes: {} as Record<string, number> };

describe("runNightly", () => {
  it("logs the nightly_pipeline and retention_purge events, counts only", async () => {
    const log = vi.fn();
    await runNightly({
      pipeline: { runAll: vi.fn(async () => ({ ...counts, failures: 2, failureCodes: { sync_account: 2 } })) },
      retention: { purge: vi.fn(async () => ({ snapshots: 4, webhookEvents: 2 })) },
      log,
    });
    expect(log).toHaveBeenCalledWith({ event: "nightly_pipeline", users: 1, synced: 1, reconstructed: 1, rows: 3, failures: 2, deferred: 0, failureCodes: { sync_account: 2 } });
    expect(log).toHaveBeenCalledWith({ event: "retention_purge", snapshots: 4, webhookEvents: 2 });
  });

  it("uses snapshots alone when there is no pipeline and logs daily_snapshots", async () => {
    const log = vi.fn();
    const captureAll = vi.fn(async () => ({ users: 1, rows: 2, failures: 0 }));
    await runNightly({ snapshots: { captureAll }, log });
    expect(log).toHaveBeenCalledWith({ event: "daily_snapshots", users: 1, rows: 2, failures: 0 });
  });

  it("prefers the pipeline over snapshots", async () => {
    const captureAll = vi.fn();
    await runNightly({ pipeline: { runAll: vi.fn(async () => counts) }, snapshots: { captureAll }, log: () => {} });
    expect(captureAll).not.toHaveBeenCalled();
  });

  it("logs optional retention fields only when present", async () => {
    const log = vi.fn();
    await runNightly({ retention: { purge: async () => ({ snapshots: 1, webhookEvents: 0, subjectRevocations: 3, disconnects: { pending: 1, cleared: 0, expired: 0, failed: 0 } }) }, log });
    expect(log).toHaveBeenCalledWith({ event: "retention_purge", snapshots: 1, webhookEvents: 0, subjectRevocations: 3, disconnects: { pending: 1, cleared: 0, expired: 0, failed: 0 } });
  });

  it("runNightly continues after a failed retention purge", async () => {
    const log = vi.fn();
    const pipeline = { runAll: vi.fn(async () => counts) };
    const retention = { purge: vi.fn(async () => { throw new Error("synthetic database outage"); }) };
    await expect(runNightly({ pipeline, retention, log })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith({ event: "retention_purge_failed" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic database outage");
  });

  it("runs retention even when the pipeline failed, then reports the failure", async () => {
    const log = vi.fn();
    const retention = { purge: vi.fn(async () => ({ snapshots: 0, webhookEvents: 0 })) };
    await expect(runNightly({ pipeline: { runAll: async () => { throw new Error("private details"); } }, retention, log })).rejects.toThrow("private details");
    expect(retention.purge).toHaveBeenCalledOnce();
  });
});

describe("historyCatchupJob", () => {
  it("runs pending catch-up every 10 minutes, quiet when nobody is due", async () => {
    const log = vi.fn();
    const runPending = vi.fn(async () => ({ ...counts, users: 0, synced: 0, reconstructed: 0, rows: 0 }));
    const job = historyCatchupJob({ runPending }, log);
    expect(job.name).toBe("history-catchup");
    expect(job.spec).toEqual({ kind: "every", minutes: 10 });
    await job.run();
    expect(runPending).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    runPending.mockResolvedValueOnce({ ...counts, users: 2, failures: 1, failureCodes: { sync_account: 1 } });
    await job.run();
    expect(log).toHaveBeenCalledWith({ event: "history_catchup", users: 2, synced: 1, reconstructed: 1, rows: 3, failures: 1, deferred: 0, failureCodes: { sync_account: 1 } });
  });

  it("does nothing, quietly, while the nightly lock is held (nightly run or manual refresh)", async () => {
    const runPending = vi.fn(async () => ({ ...counts, users: 2 }));
    const log = vi.fn();
    const held = historyCatchupJob({ runPending }, log, async () => false);
    await held.run();
    expect(runPending).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    const names: string[] = [];
    const free = historyCatchupJob({ runPending }, log, async (name, fn) => { names.push(name); await fn(); return true; });
    await free.run();
    expect(names).toEqual(["nightly"]);
    expect(runPending).toHaveBeenCalledOnce();
  });
});
