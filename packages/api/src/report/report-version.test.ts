import { describe, expect, it, vi } from "vitest";

import { reportDataVersion, type ReportVersionPrismaPort } from "./report-version.js";

// Synthetic subject and dates only.
const port = (connections: number, synced: Date | null, captured: Date | null) => ({
  brokerageConnection: { count: vi.fn(async () => connections) },
  activity: { aggregate: vi.fn(async () => ({ _max: { syncedAt: synced } })) },
  portfolioSnapshot: { aggregate: vi.fn(async () => ({ _max: { capturedAt: captured } })) },
}) satisfies ReportVersionPrismaPort;

describe("reportDataVersion", () => {
  it("is the open connections, the latest activity sync and the latest snapshot, all keyed by the subject", async () => {
    const p = port(2, new Date("2026-10-26T04:00:00Z"), new Date("2026-10-26T04:05:00Z"));
    expect(await reportDataVersion(p, "subject|synthetic")).toBe("2|2026-10-26T04:00:00.000Z|2026-10-26T04:05:00.000Z");
    expect(p.brokerageConnection.count).toHaveBeenCalledWith({ where: { appUser: { authSubject: "subject|synthetic" }, disabled: false } });
    expect(p.activity.aggregate).toHaveBeenCalledWith({ where: { appUser: { authSubject: "subject|synthetic" } }, _max: { syncedAt: true } });
    expect(p.portfolioSnapshot.aggregate).toHaveBeenCalledWith({ where: { appUser: { authSubject: "subject|synthetic" } }, _max: { capturedAt: true } });
  });

  it("changes when a connection goes, a sync lands or a snapshot is taken", async () => {
    const base = await reportDataVersion(port(2, new Date("2026-10-26T04:00:00Z"), null), "s");
    expect(base).toBe("2|2026-10-26T04:00:00.000Z|-");
    expect(await reportDataVersion(port(1, new Date("2026-10-26T04:00:00Z"), null), "s")).not.toBe(base);
    expect(await reportDataVersion(port(2, new Date("2026-10-26T05:00:00Z"), null), "s")).not.toBe(base);
    expect(await reportDataVersion(port(2, new Date("2026-10-26T04:00:00Z"), new Date("2026-10-26T05:00:00Z")), "s")).not.toBe(base);
  });
});
