import { describe, expect, it, vi } from "vitest";

import { inventedFixture } from "../testing/synthetic-fixtures.js";
import { hideDisconnected } from "./disconnect-filter.js";

const credentials = { userId: "portfolio_invented-filter-user", userSecret: inventedFixture("disconnect-filter-test-1") };

function gateway() {
  return {
    listAccounts: vi.fn(async (_credentials: typeof credentials, _options?: { timeout?: number }): Promise<unknown> => [
      { id: "account-gone", brokerage_authorization: "connection-gone" },
      { id: "account-kept", brokerage_authorization: "connection-kept" },
    ]),
    listConnections: vi.fn(async (_credentials: typeof credentials): Promise<unknown> => [{ id: "connection-gone" }, { id: "connection-kept" }]),
    getPositions: vi.fn(async () => ({ results: [] })),
    deleteConnection: vi.fn(async () => "queued" as const),
  };
}

describe("hideDisconnected", () => {
  it("drops accounts and connections of a disconnected authorization from provider listings", async () => {
    const inner = gateway();
    const pending = { disconnectedConnectionIds: vi.fn(async () => new Set(["connection-gone"])) };
    const filtered = hideDisconnected(inner, pending);

    await expect(filtered.listAccounts(credentials, { timeout: 5 })).resolves.toEqual([{ id: "account-kept", brokerage_authorization: "connection-kept" }]);
    await expect(filtered.listConnections(credentials)).resolves.toEqual([{ id: "connection-kept" }]);
    expect(inner.listAccounts).toHaveBeenCalledWith(credentials, { timeout: 5 });
    expect(pending.disconnectedConnectionIds).toHaveBeenCalledWith();
  });

  it("shows a new authorization of the same brokerage normally", async () => {
    const inner = gateway();
    inner.listAccounts.mockResolvedValueOnce([{ id: "account-new", brokerage_authorization: "connection-new" }]);
    const filtered = hideDisconnected(inner, { disconnectedConnectionIds: async () => new Set(["connection-gone"]) });

    await expect(filtered.listAccounts(credentials)).resolves.toEqual([{ id: "account-new", brokerage_authorization: "connection-new" }]);
  });

  it("skips the marker lookup's effect when nothing is pending and passes other calls straight through", async () => {
    const inner = gateway();
    const filtered = hideDisconnected(inner, { disconnectedConnectionIds: async () => new Set() });

    await expect(filtered.listAccounts(credentials)).resolves.toHaveLength(2);
    await expect(filtered.getPositions()).resolves.toEqual({ results: [] });
    await expect(filtered.deleteConnection()).resolves.toBe("queued");
    expect(inner.getPositions).toHaveBeenCalledOnce();
  });

  it("leaves unexpected shapes for the caller's own validation", async () => {
    const inner = gateway();
    inner.listAccounts.mockResolvedValueOnce({ unexpected: true });
    const filtered = hideDisconnected(inner, { disconnectedConnectionIds: async () => new Set(["connection-gone"]) });

    await expect(filtered.listAccounts(credentials)).resolves.toEqual({ unexpected: true });
  });

  it("fails the read rather than showing a disconnected connection when the marker lookup fails", async () => {
    const filtered = hideDisconnected(gateway(), { disconnectedConnectionIds: async () => { throw new Error("synthetic database outage"); } });

    await expect(filtered.listAccounts(credentials)).rejects.toThrow("synthetic database outage");
  });
});
