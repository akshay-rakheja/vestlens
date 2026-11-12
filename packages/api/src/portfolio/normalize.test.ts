import { describe, expect, it } from "vitest";

import { normalizeAccountPortfolio } from "./normalize.js";

const account = {
  id: "account-1",
  brokerage_authorization: "connection-1",
  name: "TFSA",
  number: "***1234",
  institution_name: "Wealthsimple",
  raw_type: "TFSA",
  account_category: "INVESTMENT",
  status: "open",
  is_paper: false,
  meta: {
    type: "tfsa",
    unifiedAccountType: "SELF_DIRECTED_TFSA",
  },
  balance: { total: { amount: 2500, currency: "CAD" } },
  sync_status: {
    holdings: {
      initial_sync_completed: true,
      last_successful_sync: "2026-08-19T14:00:00Z",
      holdings_unavailable: false,
    },
  },
};

describe("normalizeAccountPortfolio", () => {
  it("does not assume share-price multiplication for option contracts", () => {
    const result = normalizeAccountPortfolio({ account, balances: [], positions: {
      results: [{ instrument: { id: "invented-option", kind: "option", symbol: "INVENTED-OPTION" }, units: 2, price: 5, cost_basis: 3, currency: "CAD" }],
      data_freshness: { as_of: "2026-10-01T16:00:00Z" },
    } });
    expect(result.positions[0].marketValue).toBeNull();
    expect(result.positions[0].unrealizedGain).toBeNull();
    expect(result.calculatedValueByCurrency).toEqual({});
    expect(result.account.reportedTotal).toEqual({ amount: 2500, currency: "CAD" });
    expect(result.warnings.join(" ")).toMatch(/valuation/i);
  });
  it("normalizes decimal strings, negative cash, and multiple currencies", () => {
    const result = normalizeAccountPortfolio({
      account,
      balances: [
        { currency: { code: "CAD" }, cash: 500, buying_power: 500 },
        { currency: { code: "USD" }, cash: -20, buying_power: null },
      ],
      positions: {
        results: [
          {
            instrument: {
              id: "instrument-aapl",
              kind: "stock",
              symbol: "AAPL",
              raw_symbol: "AAPL",
              description: "Apple Inc.",
            },
            units: "10.5",
            price: "100",
            cost_basis: "80",
            currency: "USD",
            cash_equivalent: false,
          },
          {
            instrument: {
              id: "instrument-cash",
              kind: "mutualfund",
              symbol: "CASH-EQ",
              raw_symbol: "CASH-EQ",
              description: "Cash equivalent fund",
            },
            units: "100",
            price: "1",
            cost_basis: "1",
            currency: "CAD",
            cash_equivalent: true,
          },
        ],
        data_freshness: { as_of: "2026-08-19T13:55:00Z" },
      },
    });

    expect(result.account).toMatchObject({
      id: "account-1",
      connectionId: "connection-1",
      institution: "Wealthsimple",
      type: "TFSA",
      category: "INVESTMENT",
      metaType: "tfsa",
      unifiedType: "SELF_DIRECTED_TFSA",
      reportedTotal: { amount: 2500, currency: "CAD" },
    });
    expect(result.positions[0]).toMatchObject({
      symbol: "AAPL",
      units: 10.5,
      price: 100,
      costBasis: 80,
      marketValue: 1050,
      unrealizedGain: 210,
      currency: "USD",
      cashEquivalent: false,
    });
    expect(result.balances[1]).toEqual({
      currency: "USD",
      cash: -20,
      buyingPower: null,
    });
    expect(result.calculatedValueByCurrency).toEqual({ CAD: 500, USD: 1030 });
    expect(result.freshness).toEqual({
      positionsAsOf: "2026-08-19T13:55:00.000Z",
      holdingsLastSyncedAt: "2026-08-19T14:00:00.000Z",
      initialSyncCompleted: true,
      holdingsUnavailable: false,
    });
  });

  it("uses the brokerage-reported total when holdings are unavailable", () => {
    const result = normalizeAccountPortfolio({
      account: {
        ...account,
        balance: { total: { amount: 12345, currency: "CAD" } },
        sync_status: {
          holdings: {
            initial_sync_completed: true,
            last_successful_sync: "2026-08-19T14:00:00Z",
            holdings_unavailable: true,
          },
        },
      },
      balances: [],
      positions: {
        results: [],
        data_freshness: { as_of: "2026-08-19T13:55:00Z" },
      },
    });

    expect(result.account.reportedTotal).toEqual({
      amount: 12345,
      currency: "CAD",
    });
    expect(result.freshness.holdingsUnavailable).toBe(true);
    expect(result.warnings).toContain(
      "This brokerage account does not expose holdings; use its reported total value.",
    );
  });

  it("keeps incomplete position values explicit instead of inventing prices", () => {
    const result = normalizeAccountPortfolio({
      account,
      balances: [],
      positions: {
        results: [
          {
            instrument: {
              id: "instrument-private",
              kind: "other",
              symbol: "PRIVATE",
            },
            units: "4",
            price: null,
            cost_basis: null,
            currency: "CAD",
          },
        ],
        data_freshness: { as_of: "2026-08-19T13:55:00Z" },
      },
    });

    expect(result.positions[0]).toMatchObject({
      units: 4,
      price: null,
      costBasis: null,
      marketValue: null,
      unrealizedGain: null,
    });
    expect(result.calculatedValueByCurrency).toEqual({});
    expect(result.warnings).toContain(
      "One or more positions are missing a current price.",
    );
  });
});
