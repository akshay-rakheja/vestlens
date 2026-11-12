import { inventedFixture } from "../testing/synthetic-fixtures.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";

import { SnapTradeGateway, type SnapTradeCredentials } from "../snaptrade/gateway.js";
import { createPersonalSnapTradeClient } from "../snaptrade/sdk-client.js";
import {
  PortfolioAccountNotFoundError,
  PortfolioConnectionRequiredError,
  PortfolioHistoryService,
  type PortfolioHistoryGateway,
} from "./portfolio-history-service.js";

const credentials: SnapTradeCredentials = {
  userId: "portfolio_00000000-0000-4000-8000-0000000000c1",
  userSecret: inventedFixture("portfolio-history-service-test-fresh-1"),
};

function gateway(
  overrides: Partial<PortfolioHistoryGateway> = {},
): PortfolioHistoryGateway {
  return {
    listAccounts: vi.fn(async () => [{ id: "account-1" }]),
    getOrders: vi.fn(async () => []),
    getActivities: vi.fn(async () => ({
      data: [],
      pagination: { offset: 0, limit: 100, total: 0 },
    })),
    getBalanceHistory: vi.fn(async () => ({
      currency: "CAD",
      history: [],
    })),
    ...overrides,
  };
}

describe("PortfolioHistoryService", () => {
  it("does not provision an identity during a read", async () => {
    const snapTrade = gateway();
    const service = new PortfolioHistoryService({
      identity: { getExisting: vi.fn(async () => null) },
      gateway: snapTrade,
    });

    await expect(
      service.getAccountHistory("subject|user-123", "account-1"),
    ).rejects.toBeInstanceOf(PortfolioConnectionRequiredError);
    expect(snapTrade.listAccounts).not.toHaveBeenCalled();
  });

  it("rejects an account outside the authenticated user's account list", async () => {
    const snapTrade = gateway();
    const service = new PortfolioHistoryService({
      identity: { getExisting: vi.fn(async () => credentials) },
      gateway: snapTrade,
    });

    await expect(
      service.getAccountHistory("subject|user-a", "account-from-user-b"),
    ).rejects.toBeInstanceOf(PortfolioAccountNotFoundError);
    expect(snapTrade.getOrders).not.toHaveBeenCalled();
    expect(snapTrade.getActivities).not.toHaveBeenCalled();
    expect(snapTrade.getBalanceHistory).not.toHaveBeenCalled();
  });

  it("keeps orders and activities when the balance history response is malformed", async () => {
    const service = new PortfolioHistoryService({
      identity: { getExisting: vi.fn(async () => credentials) },
      gateway: gateway({
        getOrders: vi.fn(async () => [
          { brokerage_order_id: "order-1", status: "EXECUTED" },
        ]),
        getBalanceHistory: vi.fn(async () => ({
          currency: "CAD",
          history: [{ date: "not-a-date", total_value: "1000" }],
        })),
      }),
    });

    const history = await service.getAccountHistory("subject|user-123", "account-1");

    expect(history.orders).toHaveLength(1);
    expect(history.balanceHistory).toEqual({ currency: null, points: [] });
    expect(history.errors).toEqual([
      { source: "balanceHistory", code: "data_unavailable" },
    ]);
  });

  it("fetches normalized history only after ownership validation", async () => {
    const snapTrade = gateway({
      getOrders: vi.fn(async () => [
        { brokerage_order_id: "order-1", status: "EXECUTED" },
      ]),
      getActivities: vi.fn(async () => ({
        data: [
          {
            id: "activity-1",
            type: "DIVIDEND",
            amount: 12.5,
            currency: { code: "CAD" },
            trade_date: "2026-08-18T00:00:00Z",
          },
        ],
        pagination: { offset: 0, limit: 50, total: 1 },
      })),
      getBalanceHistory: vi.fn(async () => ({
        currency: "CAD",
        history: [
          { date: "2026-08-01", total_value: "1000" },
          { date: "2026-08-18", total_value: "1100" },
        ],
      })),
    });
    const service = new PortfolioHistoryService({
      identity: { getExisting: vi.fn(async () => credentials) },
      gateway: snapTrade,
      now: () => new Date("2026-08-20T16:00:00Z"),
    });

    const result = await service.getAccountHistory(
      "subject|user-123",
      "account-1",
      {
        orders: { state: "all", days: 30 },
        activities: {
          startDate: "2026-08-01T00:00:00.000Z",
          endDate: "2026-08-20T00:00:00.000Z",
          limit: 50,
        },
      },
    );

    expect(result).toMatchObject({
      accountId: "account-1",
      generatedAt: "2026-08-20T16:00:00.000Z",
      orders: [{ id: "order-1", status: "EXECUTED" }],
      activities: { pagination: { total: 1 } },
      balanceHistory: { currency: "CAD" },
      analytics: {
        orderStatusCounts: { EXECUTED: 1 },
        pageActivityTotals: [
          { type: "DIVIDEND", currency: "CAD", count: 1, amount: 12.5 },
        ],
      },
      freshness: {
        orders: "Brokerage dependent: real-time when enabled, otherwise daily.",
        activities: "Daily SnapTrade data.",
        balanceHistory: "Experimental SnapTrade estimate; maximum one-year lookback.",
      },
    });
    expect(snapTrade.getOrders).toHaveBeenCalledWith(credentials, "account-1", {
      state: "all",
      days: 30,
    });
    expect(snapTrade.getActivities).toHaveBeenCalledWith(
      credentials,
      "account-1",
      {
        startDate: "2026-08-01",
        endDate: "2026-08-20",
        limit: 50,
      },
    );
  });

  it("sends activity bounds through the actual SDK as the plain days SnapTrade documents", async () => {
    const activityQueries: URLSearchParams[] = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname.endsWith("/activities")) activityQueries.push(url.searchParams);
      const body = url.pathname === "/accounts"
        ? [{ id: "account-1" }]
        : url.pathname.endsWith("/activities")
          ? { data: [], pagination: { offset: 0, limit: 50, total: 0 } }
          : url.pathname.endsWith("/orders")
            ? []
            : { currency: "CAD", history: [] };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Synthetic listener unavailable");
    try {
      const service = new PortfolioHistoryService({
        identity: { getExisting: vi.fn(async () => credentials) },
        gateway: new SnapTradeGateway(createPersonalSnapTradeClient(
          { clientId: "test-client-id", consumerKey: inventedFixture("portfolio-history-service-test-fresh-2") },
          { basePath: `http://127.0.0.1:${address.port}` },
        )),
      });

      const result = await service.getAccountHistory("subject|user-123", "account-1", {
        activities: { startDate: "2026-08-01T00:00:00.000Z", endDate: "2026-08-20T23:59:59.000Z" },
      });

      expect(result.errors).toEqual([]);
      expect(activityQueries).toHaveLength(1);
      expect(activityQueries[0].get("startDate")).toBe("2026-08-01");
      expect(activityQueries[0].get("endDate")).toBe("2026-08-20");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("warns with only the section and provider status when a read fails", async () => {
    const secret = inventedFixture("portfolio-history-service-test-fresh-3");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const service = new PortfolioHistoryService({
        identity: { getExisting: vi.fn(async () => credentials) },
        gateway: gateway({
          getActivities: vi.fn(async () => {
            throw Object.assign(new Error(`invented failure ${secret}`), {
              status: 400,
              url: `/accounts/account-1/activities?userSecret=${secret}`,
              responseBody: secret,
            });
          }),
          getOrders: vi.fn(async () => {
            throw new Error(`invented failure ${secret}`);
          }),
        }),
      });

      const result = await service.getAccountHistory("subject|user-123", "account-1");

      expect(result.errors).toEqual([
        { source: "orders", code: "data_unavailable" },
        { source: "activities", code: "data_unavailable" },
      ]);
      expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        { event: "account_history_read_failed", source: "orders" },
        { event: "account_history_read_failed", source: "activities", status: 400 },
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });
});
