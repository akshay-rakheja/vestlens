import { inventedFixture } from "../testing/synthetic-fixtures.js";
import { describe, expect, it, vi } from "vitest";

import { ConnectionService } from "./connection-service.js";

const credentials = {
  userId: "portfolio_00000000-0000-4000-8000-0000000000c1",
  userSecret: inventedFixture("connection-service-test-fresh-1"),
};

describe("ConnectionService", () => {
  it("opens the portal for any brokerage", async () => {
    const identity = { getOrCreate: vi.fn(async () => credentials) };
    const gateway = {
      createConnectionUrl: vi.fn(async (_credentials: unknown, _options: Record<string, unknown>) => "https://connect.snaptrade.com/abc"),
    };
    const service = new ConnectionService({
      identity,
      gateway,
      appBaseUrl: "https://portfolio.example.com",
    });

    await expect(
      service.createConnectionPortal("subject|user-123"),
    ).resolves.toBe("https://connect.snaptrade.com/abc");
    expect(identity.getOrCreate).toHaveBeenCalledWith("subject|user-123");
    expect(gateway.createConnectionUrl).toHaveBeenCalledWith(credentials, {
      customRedirect: "https://portfolio.example.com/connections/complete",
    });
    expect(gateway.createConnectionUrl.mock.calls[0]![1]).not.toHaveProperty("broker");
  });

  it("passes a validated connection ID for a read-only reconnect", async () => {
    const identity = { getOrCreate: vi.fn(async () => credentials) };
    const gateway = {
      createConnectionUrl: vi.fn(async () => "https://connect.snaptrade.com/reconnect"),
    };
    const service = new ConnectionService({
      identity,
      gateway,
      appBaseUrl: "https://portfolio.example.com",
    });
    const reconnect = "00000000-0000-4000-8000-0000000000c2";

    await service.createConnectionPortal("subject|user-123", { reconnect });

    expect(gateway.createConnectionUrl).toHaveBeenCalledWith(credentials, {
      customRedirect: "https://portfolio.example.com/connections/complete",
      reconnect,
    });
  });

  it("rejects an invalid reconnect ID before calling SnapTrade", async () => {
    const identity = { getOrCreate: vi.fn(async () => credentials) };
    const gateway = { createConnectionUrl: vi.fn() };
    const service = new ConnectionService({
      identity,
      gateway,
      appBaseUrl: "https://portfolio.example.com",
    });

    await expect(
      service.createConnectionPortal("subject|user-123", {
        reconnect: "not-a-uuid",
      }),
    ).rejects.toThrow();
    expect(identity.getOrCreate).not.toHaveBeenCalled();
    expect(gateway.createConnectionUrl).not.toHaveBeenCalled();
  });
});
