import { describe, expect, it, vi } from "vitest";

import { findPendingHistoryUsers, NEW_LINK_WINDOW_MS, RETRY_AFTER_MS, type PendingHistoryPort } from "./pending-history.js";

const now = new Date("2026-10-29T16:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
type Row = Awaited<ReturnType<PendingHistoryPort["appUser"]["findMany"]>>[number];
const user = (id: string, over: Partial<Row> = {}): Row => ({
  id, authSubject: `subject|${id}`, brokerageAccounts: [], brokerageConnections: [], activitySyncStates: [], _count: { brokerageAccounts: 0 }, ...over,
});
type FindInput = Parameters<PendingHistoryPort["appUser"]["findMany"]>[0];
const port = (rows: Row[]) => ({ appUser: { findMany: vi.fn(async (_input: FindInput) => rows) } });

describe("findPendingHistoryUsers", () => {
  it("asks only for linked users and recent accounts and connections", async () => {
    const prisma = port([]);
    await findPendingHistoryUsers(prisma, now);
    const input = prisma.appUser.findMany.mock.calls[0]![0];
    expect(input.where).toEqual({ authSubject: "owner", brokerageConnections: { some: { disabled: false } } });
    expect(input.select.brokerageAccounts.where.createdAt.gte).toEqual(ago(NEW_LINK_WINDOW_MS));
    expect(input.select.brokerageConnections.where).toEqual({ createdAt: { gte: ago(NEW_LINK_WINDOW_MS) }, disabled: false });
  });

  it("picks people whose new accounts have no completed first read, retrying a stuck one at most hourly", async () => {
    const rows = [
      user("never-read", { brokerageAccounts: [{ snapTradeAccountId: "a" }], _count: { brokerageAccounts: 1 } }),
      user("done", {
        brokerageAccounts: [{ snapTradeAccountId: "a" }], _count: { brokerageAccounts: 1 },
        activitySyncStates: [{ snapTradeAccountId: "a", backfillCompletedAt: ago(60_000), lastSyncedAt: ago(60_000) }],
      }),
      user("failed-recently", {
        brokerageAccounts: [{ snapTradeAccountId: "a" }], _count: { brokerageAccounts: 1 },
        activitySyncStates: [{ snapTradeAccountId: "a", backfillCompletedAt: null, lastSyncedAt: ago(RETRY_AFTER_MS - 60_000) }],
      }),
      user("failed-an-hour-ago", {
        brokerageAccounts: [{ snapTradeAccountId: "a" }], _count: { brokerageAccounts: 1 },
        activitySyncStates: [{ snapTradeAccountId: "a", backfillCompletedAt: null, lastSyncedAt: ago(RETRY_AFTER_MS) }],
      }),
      user("linked-no-accounts-yet", { brokerageConnections: [{ createdAt: ago(120_000) }] }),
      user("old-link-no-accounts", {}),
      // Stored accounts, none of them recent: the nightly run covers them.
      user("established", { _count: { brokerageAccounts: 3 } }),
    ];
    const pending = await findPendingHistoryUsers(port(rows), now);
    expect(pending.map((u) => u.id)).toEqual(["never-read", "failed-an-hour-ago", "linked-no-accounts-yet"]);
    expect(pending[0]).toEqual({ id: "never-read", authSubject: "subject|never-read" });
  });
});
