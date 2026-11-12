import { describe, expect, it } from "vitest";

import {
  normalizeActivities,
  normalizeBalanceHistory,
  normalizeOrders,
  summarizeAccountHistory,
} from "./history-normalize.js";

describe("portfolio history normalization", () => {
  it("normalizes read-only orders without brokerage-specific payload fields", () => {
    const orders = normalizeOrders([
      {
        brokerage_order_id: "order-1",
        status: "EXECUTED",
        universal_symbol: {
          id: "symbol-vfv",
          symbol: "VFV.TO",
          description: "Vanguard S&P 500 Index ETF",
        },
        action: "BUY",
        total_quantity: "10",
        open_quantity: "0",
        canceled_quantity: "0",
        filled_quantity: "10",
        execution_price: "100.25",
        limit_price: null,
        stop_price: null,
        order_type: "Market",
        time_in_force: "Day",
        time_placed: "2026-08-18T14:00:00Z",
        time_updated: "2026-08-18T14:01:00Z",
        time_executed: "2026-08-18T14:01:00Z",
      },
    ]);

    expect(orders).toEqual([
      {
        id: "order-1",
        status: "EXECUTED",
        symbol: "VFV.TO",
        description: "Vanguard S&P 500 Index ETF",
        action: "BUY",
        totalQuantity: 10,
        openQuantity: 0,
        canceledQuantity: 0,
        filledQuantity: 10,
        executionPrice: 100.25,
        limitPrice: null,
        stopPrice: null,
        orderType: "Market",
        timeInForce: "Day",
        placedAt: "2026-08-18T14:00:00.000Z",
        updatedAt: "2026-08-18T14:01:00.000Z",
        executedAt: "2026-08-18T14:01:00.000Z",
      },
    ]);
  });

  it("normalizes paginated activities and groups currency-aware analytics", () => {
    const activities = normalizeActivities({
      data: [
        {
          id: "activity-1",
          symbol: {
            id: "symbol-vfv",
            symbol: "VFV.TO",
            description: "Vanguard S&P 500 Index ETF",
          },
          price: 100,
          units: 10,
          amount: -1002.5,
          currency: { code: "CAD" },
          type: "BUY",
          description: "Bought VFV",
          trade_date: "2026-08-18T14:01:00Z",
          settlement_date: "2026-08-20T00:00:00Z",
          fee: 2.5,
          fx_rate: null,
          external_reference_id: "broker-private-reference",
        },
      ],
      pagination: { offset: 0, limit: 100, total: 1 },
    });

    expect(activities).toEqual({
      items: [
        {
          id: "activity-1",
          type: "BUY",
          symbol: "VFV.TO",
          description: "Bought VFV",
          price: 100,
          units: 10,
          amount: -1002.5,
          currency: "CAD",
          fee: 2.5,
          fxRate: null,
          tradeDate: "2026-08-18T14:01:00.000Z",
          settlementDate: "2026-08-20T00:00:00.000Z",
        },
      ],
      pagination: { offset: 0, limit: 100, total: 1 },
    });
    expect(
      summarizeAccountHistory({
        orders: [],
        activities: activities.items,
        balanceHistory: {
          currency: "CAD",
          points: [
            { date: "2026-08-01", totalValue: 1000 },
            { date: "2026-08-18", totalValue: 1100 },
          ],
        },
      }),
    ).toEqual({
      orderStatusCounts: {},
      pageActivityTotals: [
        { type: "BUY", currency: "CAD", count: 1, amount: -1002.5 },
      ],
      balanceChangeIncludingDeposits: {
        currency: "CAD",
        startDate: "2026-08-01",
        endDate: "2026-08-18",
        startValue: 1000,
        endValue: 1100,
        absoluteChange: 100,
        percentChange: 10,
        estimated: true,
        includesDeposits: true,
      },
      note: expect.stringMatching(/returned page only.*gross.*includes deposits/s),
    });
  });

  it("normalizes balance history while retaining its source currency", () => {
    expect(
      normalizeBalanceHistory({
        currency: "USD",
        history: [
          { date: "2026-08-01", total_value: "250.25" },
          { date: "2026-08-02", total_value: "260.5" },
        ],
      }),
    ).toEqual({
      currency: "USD",
      points: [
        { date: "2026-08-01", totalValue: 250.25 },
        { date: "2026-08-02", totalValue: 260.5 },
      ],
    });
  });
});

describe("15: account history analytics say what they cover", () => {
  it("labels dividend totals as gross", () => {
    const out = summarizeAccountHistory({
      orders: [],
      activities: [{ type: "DIVIDEND", currency: "USD", amount: 100 } as never, { type: "TAX", currency: "USD", amount: -15 } as never],
      balanceHistory: { currency: "CAD", points: [] },
    });
    expect(out.pageActivityTotals.find((t) => t.type === "DIVIDEND")).toMatchObject({ amount: 100, amountBasis: "gross" });
    expect(out.pageActivityTotals.find((t) => t.type === "TAX")).not.toHaveProperty("amountBasis");
    expect(out.balanceChangeIncludingDeposits).toBeNull();
  });
});
