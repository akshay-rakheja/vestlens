import { describe, expect, it, vi } from "vitest";

import { ACCESS_TOKEN_MAX_ACCEPT_MS } from "../gateway/tokens.js";
import { RETENTION, RetentionService, SUBJECT_REVOCATION_MARGIN_MS, SUBJECT_REVOCATION_RETENTION_MS, retentionCutoffs, subjectRevocationCutoff } from "./retention.js";

describe("retention policy", () => {
  it("keeps snapshots 90 days and webhook receipts 30 days", () => {
    expect(RETENTION).toEqual({ snapshotDays: 90, webhookEventDays: 30, pendingDisconnectDays: 30 });
    expect(retentionCutoffs(new Date("2026-10-23T08:00:00.000Z"))).toEqual({
      snapshotsBefore: new Date("2026-07-25T08:00:00.000Z"),
      webhookEventsBefore: new Date("2026-09-23T08:00:00.000Z"),
    });
  });

  it("purges with cutoffs from the injected clock", async () => {
    const store = { purgeExpired: vi.fn(async () => ({ snapshots: 2, webhookEvents: 1 })) };
    const service = new RetentionService({ store, now: () => new Date("2026-10-23T08:00:00.000Z") });

    await expect(service.purge()).resolves.toEqual({ snapshots: 2, webhookEvents: 1 });
    expect(store.purgeExpired).toHaveBeenCalledWith(retentionCutoffs(new Date("2026-10-23T08:00:00.000Z")));
  });

  it("also sweeps pending disconnects, after the expiry purge", async () => {
    const order: string[] = [];
    const store = { purgeExpired: vi.fn(async () => { order.push("expired"); return { snapshots: 0, webhookEvents: 0 }; }) };
    const sweepDisconnects = vi.fn(async () => { order.push("sweep"); return { pending: 2, cleared: 1, expired: 0, failed: 0 }; });
    const service = new RetentionService({ store, sweepDisconnects, now: () => new Date("2026-10-23T08:00:00.000Z") });

    await expect(service.purge()).resolves.toEqual({ snapshots: 0, webhookEvents: 0, disconnects: { pending: 2, cleared: 1, expired: 0, failed: 0 } });
    expect(order).toEqual(["expired", "sweep"]);
  });

  it("still sweeps pending disconnects when the expiry purge fails, then reports the failure", async () => {
    const store = { purgeExpired: vi.fn(async () => { throw new Error("synthetic outage"); }) };
    const sweepDisconnects = vi.fn(async () => ({ pending: 1, cleared: 1, expired: 0, failed: 0 }));

    await expect(new RetentionService({ store, sweepDisconnects }).purge()).rejects.toThrow("synthetic outage");
    expect(sweepDisconnects).toHaveBeenCalledOnce();
  });

  it("keeps the subject-wide revocation marker for the gateway access-token lifetime plus a margin", () => {
    expect(SUBJECT_REVOCATION_MARGIN_MS).toBe(60 * 60 * 1000);
    expect(SUBJECT_REVOCATION_RETENTION_MS).toBe(ACCESS_TOKEN_MAX_ACCEPT_MS + SUBJECT_REVOCATION_MARGIN_MS);
    expect(SUBJECT_REVOCATION_RETENTION_MS).toBeGreaterThan(ACCESS_TOKEN_MAX_ACCEPT_MS);
    expect(subjectRevocationCutoff(new Date("2026-10-23T08:00:00.000Z"))).toEqual(new Date(new Date("2026-10-23T08:00:00.000Z").getTime() - SUBJECT_REVOCATION_RETENTION_MS));
  });

  it("sweeps subject-wide revocation markers in the nightly run, with its cutoff", async () => {
    const at = new Date("2026-10-23T08:00:00.000Z");
    const store = { purgeExpired: vi.fn(async () => ({ snapshots: 0, webhookEvents: 0 })) };
    const sweepSubjectRevocations = vi.fn(async (_before: Date) => 3);
    const sweepDisconnects = vi.fn(async () => ({ pending: 0, cleared: 0, expired: 0, failed: 0 }));

    await expect(new RetentionService({ store, sweepDisconnects, sweepSubjectRevocations, now: () => at }).purge())
      .resolves.toEqual({ snapshots: 0, webhookEvents: 0, subjectRevocations: 3, disconnects: { pending: 0, cleared: 0, expired: 0, failed: 0 } });
    expect(sweepSubjectRevocations).toHaveBeenCalledWith(subjectRevocationCutoff(at));
  });

  it("runs the other steps when the revocation sweep fails, then reports the failure", async () => {
    const store = { purgeExpired: vi.fn(async () => ({ snapshots: 0, webhookEvents: 0 })) };
    const sweepDisconnects = vi.fn(async () => ({ pending: 0, cleared: 0, expired: 0, failed: 0 }));
    const sweepSubjectRevocations = vi.fn(async () => { throw new Error("synthetic outage"); });

    await expect(new RetentionService({ store, sweepDisconnects, sweepSubjectRevocations }).purge()).rejects.toThrow("synthetic outage");
    expect(sweepDisconnects).toHaveBeenCalledOnce();
  });
});
