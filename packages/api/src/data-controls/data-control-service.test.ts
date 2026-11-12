import { describe, expect, it, vi } from "vitest";

import { inventedFixture } from "../testing/synthetic-fixtures.js";
import { SnapTradeKeyRejectedError } from "../snaptrade/gateway.js";
import { DataControlError, DataControlService, type DataControlEvent } from "./data-control-service.js";

const appUserId = "3f0c2a8e-6d1b-4c7a-9e5f-2b8d4a6c1e90";
const subject = "subject|invented-data-control-user";
const sweepNow = new Date("2026-10-23T08:00:00.000Z");
const credentials = { userId: `portfolio_${appUserId}`, userSecret: inventedFixture("data-control-service-test-1") };


function setup(overrides: { user?: boolean; credentials?: boolean} = {}) {
  const order: string[] = [];
  const events: DataControlEvent[] = [];
  const user = overrides.user === false ? null : { appUserId };
  const identity = { getExisting: vi.fn(async () => (overrides.credentials === false ? null : credentials)) };
  const gateway = {
    deleteConnection: vi.fn(async (): Promise<"queued" | "not_found"> => { order.push("provider"); return "queued"; }),
    listConnections: vi.fn(async (_credentials: unknown): Promise<unknown> => []),
  };
  const repository = {
    findUser: vi.fn(async () => user),
    findOwnerAppUserId: vi.fn(async () => appUserId as string | null),
    purgeConnection: vi.fn(async (_user: unknown, _id: string, _options?: unknown) => { order.push("purge"); return { accounts: 2, snapshots: 5, webhookEvents: 1 }; }),
    pendingDisconnects: vi.fn(async (): Promise<Array<{ user: { appUserId: string }; snapTradeConnectionId: string; confirmed: boolean; requestedAt: Date }>> => []),
    connectionState: vi.fn(async (_appUserId: string, _id: string) => ({ stored: true, pending: false, pendingCount: 0 })),
  };
  const evict = vi.fn(() => { order.push("evict"); });
  const service = new DataControlService({
    identity, gateway, repository, evict, log: (e) => events.push(e), now: () => sweepNow,
  });
  return { service, identity, gateway, repository, evict, order, events };
}

describe("DataControlService.disconnect", () => {
  it("lets a rejected SnapTrade key reach the caller from the delete and the ownership check", async () => {
    const del = setup();
    del.gateway.deleteConnection.mockRejectedValueOnce(new SnapTradeKeyRejectedError());
    await expect(del.service.disconnect(subject, "invented-connection-1")).rejects.toBeInstanceOf(SnapTradeKeyRejectedError);
    expect(del.repository.purgeConnection).not.toHaveBeenCalled();

    const list = setup();
    list.repository.connectionState.mockResolvedValueOnce({ stored: false, pending: false, pendingCount: 0 });
    list.gateway.listConnections.mockRejectedValueOnce(new SnapTradeKeyRejectedError());
    await expect(list.service.disconnect(subject, "invented-connection-1")).rejects.toBeInstanceOf(SnapTradeKeyRejectedError);
    expect(list.gateway.deleteConnection).not.toHaveBeenCalled();
  });

  it("revokes at SnapTrade first, then purges local state and evicts the cache", async () => {
    const s = setup();

    await expect(s.service.disconnect(subject, "invented-connection-1")).resolves.toEqual({ status: "disconnected", providerDeletion: "queued" });

    expect(s.gateway.deleteConnection).toHaveBeenCalledWith(credentials, "invented-connection-1");
    // The marker that keeps reads from re-persisting the connection is written with the purge.
    expect(s.repository.purgeConnection).toHaveBeenCalledWith({ appUserId }, "invented-connection-1", { pending: "mark" });
    expect(s.order).toEqual(["provider", "purge", "evict"]);
    expect(s.events).toEqual([{ event: "connection_disconnected", provider: "queued", accounts: 2, snapshots: 5, webhookEvents: 1 }]);
  });

  it("still purges locally when SnapTrade reports the connection already gone, with the marker already confirmed", async () => {
    const s = setup();
    s.gateway.deleteConnection.mockResolvedValueOnce("not_found");

    await expect(s.service.disconnect(subject, "invented-connection-2")).resolves.toMatchObject({ providerDeletion: "not_found" });
    expect(s.repository.purgeConnection).toHaveBeenCalledWith(expect.anything(), "invented-connection-2", { pending: "mark_confirmed" });
  });

  it("returns connection_not_found with no provider write and no marker for an id the caller does not have", async () => {
    const s = setup();
    s.repository.connectionState.mockResolvedValueOnce({ stored: false, pending: false, pendingCount: 0 });
    s.gateway.listConnections.mockResolvedValueOnce([{ id: "invented-own-connection" }]);

    await expect(s.service.disconnect(subject, "invented-foreign-connection")).rejects.toMatchObject({ code: "connection_not_found", status: 404 });
    expect(s.gateway.listConnections).toHaveBeenCalledWith(credentials);
    expect(s.gateway.deleteConnection).not.toHaveBeenCalled();
    expect(s.repository.purgeConnection).not.toHaveBeenCalled();
  });

  it("accepts a connection SnapTrade lists for the caller even when nothing is stored locally yet", async () => {
    const s = setup();
    s.repository.connectionState.mockResolvedValueOnce({ stored: false, pending: false, pendingCount: 0 });
    s.gateway.listConnections.mockResolvedValueOnce([{ id: "invented-listed-connection" }]);

    await expect(s.service.disconnect(subject, "invented-listed-connection")).resolves.toMatchObject({ status: "disconnected" });
    expect(s.repository.purgeConnection).toHaveBeenCalledWith(expect.anything(), "invented-listed-connection", { pending: "mark" });
  });

  it("retries an already-pending disconnect without a listing call", async () => {
    const s = setup();
    s.repository.connectionState.mockResolvedValueOnce({ stored: false, pending: true, pendingCount: 20 });

    await expect(s.service.disconnect(subject, "invented-pending-connection")).resolves.toMatchObject({ status: "disconnected" });
    expect(s.gateway.listConnections).not.toHaveBeenCalled();
  });

  it("refuses a new marker once the caller holds the per-user cap", async () => {
    const s = setup();
    s.repository.connectionState.mockResolvedValueOnce({ stored: true, pending: false, pendingCount: 20 });

    await expect(s.service.disconnect(subject, "invented-connection-cap")).rejects.toMatchObject({ code: "too_many_pending", status: 429 });
    expect(s.gateway.deleteConnection).not.toHaveBeenCalled();
    expect(s.repository.purgeConnection).not.toHaveBeenCalled();
  });

  it("reports provider_unavailable when the ownership listing fails", async () => {
    const s = setup();
    s.repository.connectionState.mockResolvedValueOnce({ stored: false, pending: false, pendingCount: 0 });
    s.gateway.listConnections.mockRejectedValueOnce(new Error("synthetic outage"));

    await expect(s.service.disconnect(subject, "invented-connection-9")).rejects.toMatchObject({ code: "provider_unavailable", status: 502 });
    expect(s.gateway.deleteConnection).not.toHaveBeenCalled();
  });

  it("keeps local state and reports provider_unavailable when SnapTrade fails", async () => {
    const s = setup();
    s.gateway.deleteConnection.mockRejectedValueOnce(new Error("synthetic outage"));

    await expect(s.service.disconnect(subject, "invented-connection-3")).rejects.toMatchObject({ code: "provider_unavailable", status: 502 });
    expect(s.repository.purgeConnection).not.toHaveBeenCalled();
    expect(s.evict).not.toHaveBeenCalled();
    expect(s.events).toEqual([{ event: "data_control_provider_failed", action: "disconnect" }]);
  });

  it("returns connection_not_found without a provider call for a user with no identity", async () => {
    for (const s of [setup({ credentials: false }), setup({ user: false })]) {
      await expect(s.service.disconnect(subject, "invented-connection-4")).rejects.toBeInstanceOf(DataControlError);
      expect(s.gateway.deleteConnection).not.toHaveBeenCalled();
      expect(s.repository.purgeConnection).not.toHaveBeenCalled();
    }
  });

  it("rejects an empty or oversized connection id before any lookup", async () => {
    const s = setup();
    await expect(s.service.disconnect(subject, "  ")).rejects.toThrow();
    await expect(s.service.disconnect(subject, "x".repeat(65))).rejects.toThrow();
    expect(s.identity.getExisting).not.toHaveBeenCalled();
  });

  it("never logs subjects, ids or secrets", async () => {
    const s = setup();
    await s.service.disconnect(subject, "invented-connection-5");
    const logged = JSON.stringify(s.events);
    for (const secret of [subject, appUserId, credentials.userSecret, "invented-connection-5"]) expect(logged).not.toContain(secret);
  });
});

describe("DataControlService.purgeDeletedConnection", () => {
  it("purges the owner's connection, keeps its marker confirmed for the nightly final purge and keeps the receipt", async () => {
    const s = setup();

    await expect(s.service.purgeDeletedConnection("invented-connection-6")).resolves.toBe("purged");
    // Not "clear": a paged activity sync may still write rows; the sweep does the final purge and clears.
    expect(s.repository.purgeConnection).toHaveBeenCalledWith(
      { appUserId }, "invented-connection-6", { keepWebhookReceipts: true, pending: "mark_confirmed" },
    );
    expect(s.gateway.deleteConnection).not.toHaveBeenCalled();
    expect(s.events).toEqual([{ event: "connection_purged", source: "webhook", accounts: 2, snapshots: 5 }]);
  });

  it("does nothing for an unknown SnapTrade user", async () => {
    const s = setup();
    s.repository.findOwnerAppUserId.mockResolvedValueOnce(null);

    await expect(s.service.purgeDeletedConnection("invented-connection-7")).resolves.toBe("unknown_user");
    expect(s.repository.purgeConnection).not.toHaveBeenCalled();
  });

  it("logs a constant code with counts when the purge fails, leaving the marker for the nightly retry", async () => {
    const s = setup();
    s.repository.purgeConnection.mockRejectedValueOnce(new Error("synthetic database outage invented-connection-8"));

    await expect(s.service.purgeDeletedConnection("invented-connection-8")).resolves.toBe("failed");
    expect(s.events).toEqual([{ event: "connection_purge_failed", source: "webhook", failed: 1 }]);
    expect(JSON.stringify(s.events)).not.toContain("invented-connection-8");
  });
});

describe("DataControlService.sweepPendingDisconnects", () => {
  it("re-purges every pending disconnect, clears confirmed ones, ages out old unconfirmed ones and counts failures", async () => {
    const s = setup();
    const user = { appUserId };
    const recent = new Date("2026-10-20T00:00:00.000Z");
    const old = new Date("2026-09-22T00:00:00.000Z"); // 31 days before sweepNow
    s.repository.pendingDisconnects.mockResolvedValueOnce([
      { user, snapTradeConnectionId: "connection-confirmed", confirmed: true, requestedAt: recent },
      { user, snapTradeConnectionId: "connection-failing", confirmed: true, requestedAt: recent },
      { user, snapTradeConnectionId: "connection-queued", confirmed: false, requestedAt: recent },
      { user, snapTradeConnectionId: "connection-aged", confirmed: false, requestedAt: old },
    ]);
    s.repository.purgeConnection.mockImplementation(async (_u: unknown, id: string) => {
      if (id === "connection-failing") throw new Error("synthetic outage");
      return { accounts: 1, snapshots: 2, webhookEvents: 0 };
    });

    await expect(s.service.sweepPendingDisconnects()).resolves.toEqual({ pending: 4, cleared: 1, expired: 1, failed: 1 });
    expect(s.repository.purgeConnection).toHaveBeenCalledWith(user, "connection-confirmed", { keepWebhookReceipts: true, pending: "clear" });
    expect(s.repository.purgeConnection).toHaveBeenCalledWith(user, "connection-queued", { keepWebhookReceipts: true });
    expect(s.repository.purgeConnection).toHaveBeenCalledWith(user, "connection-aged", { keepWebhookReceipts: true, pending: "clear" });
    expect(s.events).toEqual([{ event: "pending_disconnect_sweep", pending: 4, cleared: 1, expired: 1, failed: 1 }]);
  });

  it("reports a failed listing as one failure without throwing", async () => {
    const s = setup();
    s.repository.pendingDisconnects.mockRejectedValueOnce(new Error("synthetic outage"));

    await expect(s.service.sweepPendingDisconnects()).resolves.toEqual({ pending: 0, cleared: 0, expired: 0, failed: 1 });
    expect(s.events).toEqual([{ event: "pending_disconnect_sweep_failed" }]);
  });
});
