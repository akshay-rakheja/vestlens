import { inventedFixture } from "../testing/synthetic-fixtures.js";
import { describe, expect, it, vi } from "vitest";

import type { SnapTradeCredentials } from "../snaptrade/gateway.js";
import { ConnectionStatusService } from "./connection-status-service.js";

const credentials: SnapTradeCredentials = {
  userId: "portfolio_00000000-0000-4000-8000-0000000000c1",
  userSecret: inventedFixture("connection-status-service-test-fresh-1"),
};

describe("ConnectionStatusService", () => {
  it("returns no connections without provisioning during a read", async () => {
    const gateway = { listConnections: vi.fn() };
    const service = new ConnectionStatusService({
      identity: { getExisting: vi.fn(async () => null) },
      gateway,
    });

    await expect(service.getConnections("subject|new-user")).resolves.toEqual([]);
    expect(gateway.listConnections).not.toHaveBeenCalled();
  });

  it("normalizes health, degraded state, and freshness mode", async () => {
    const gateway = {
      listConnections: vi.fn(async () => [
        {
          id: "00000000-0000-4000-8000-0000000000c2",
          name: "Primary Wealthsimple",
          type: "read",
          disabled: true,
          disabled_date: "2026-08-20T14:00:00Z",
          data_freshness_mode: "delayed",
          brokerage: {
            slug: "WEALTHSIMPLETRADE",
            display_name: "Wealthsimple",
            is_degraded: true,
            maintenance_mode: false,
          },
        },
      ]),
    };
    const service = new ConnectionStatusService({
      identity: { getExisting: vi.fn(async () => credentials) },
      gateway,
    });

    await expect(service.getConnections("subject|user-123")).resolves.toEqual([
      {
        id: "00000000-0000-4000-8000-0000000000c2",
        name: "Primary Wealthsimple",
        brokerageSlug: "WEALTHSIMPLETRADE",
        brokerageName: "Wealthsimple",
        readOnly: true,
        disabled: true,
        disabledAt: "2026-08-20T14:00:00.000Z",
        degraded: true,
        maintenance: false,
        dataFreshnessMode: "delayed",
      },
    ]);
    expect(gateway.listConnections).toHaveBeenCalledWith(credentials);
  });
});

describe("ConnectionStatusService provider identifiers", () => {
  it("accepts opaque connection ids that are not RFC-strict UUIDs", async () => {
    const service = new ConnectionStatusService({
      identity: { getExisting: vi.fn(async () => credentials) },
      gateway: { listConnections: vi.fn(async () => [{ id: "00000000-0000-0000-0000-0000000000c3", type: "read" }]) },
    });
    await expect(service.getConnections("subject|user-123")).resolves.toMatchObject([
      { id: "00000000-0000-0000-0000-0000000000c3", readOnly: true },
    ]);
  });

  it("still rejects a missing id", async () => {
    const service = new ConnectionStatusService({
      identity: { getExisting: vi.fn(async () => credentials) },
      gateway: { listConnections: vi.fn(async () => [{ id: "" }]) },
    });
    await expect(service.getConnections("subject|user-123")).rejects.toThrow();
  });
});

describe("ConnectionStatusService freshness mode shapes", () => {
  for (const [label, value, expected] of [
    ["string", "delayed", "delayed"],
    ["object with mode", { mode: "realtime" }, "realtime"],
    ["number", 15, null],
    ["unrecognized object", { other: true }, null],
  ] as const) {
    it(`tolerates a ${label} data_freshness_mode`, async () => {
      const service = new ConnectionStatusService({
        identity: { getExisting: vi.fn(async () => credentials) },
        gateway: { listConnections: vi.fn(async () => [{ id: "connection-1", data_freshness_mode: value }]) },
      });
      await expect(service.getConnections("subject|user-123")).resolves.toMatchObject([
        { id: "connection-1", dataFreshnessMode: expected },
      ]);
    });
  }
});
