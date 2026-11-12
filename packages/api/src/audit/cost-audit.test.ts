import { describe, expect, it } from "vitest";

import { homeConverter } from "../fx/home-currency.js";
import { accountGroup, costAudit, mismatchBucket, type CostAuditActivity, type CostAuditInput, type CostAuditPosition } from "./cost-audit.js";

// Synthetic accounts, symbols, amounts and rates only. USD/CAD is a flat 1.40 every day of 2026.
const series = Array.from({ length: 300 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), close: 1.4 }));
const conv = homeConverter(series, "2026-10-27");
let n = 0;
const act = (over: Partial<CostAuditActivity>): CostAuditActivity => ({
  appUserId: "u1", snapTradeAccountId: "cash", dedupeKey: `k${String(n++).padStart(4, "0")}`, type: "BUY", symbol: "AAA", securityCurrency: "CAD",
  isOption: false, units: 10, price: 10, amount: -100, fee: 0, fxRate: null, currency: "CAD", tradeDate: "2026-02-02", settlementDate: null, description: null, ...over,
});
const pos = (over: Partial<CostAuditPosition>): CostAuditPosition => ({
  appUserId: "u1", snapTradeAccountId: "cash", symbol: "AAA", kind: "stock", units: 10, costBasis: 10, currency: "CAD", cashEquivalent: false, ...over,
});
const input = (positions: CostAuditPosition[], activities: CostAuditActivity[]): CostAuditInput => ({
  taxYear: "2026", conv, positions, activities,
  accounts: [
    { appUserId: "u1", snapTradeAccountId: "cash", rawType: "PERSONAL" },
    { appUserId: "u1", snapTradeAccountId: "tfsa", rawType: "TFSA" },
    { appUserId: "u1", snapTradeAccountId: "card", rawType: "CARD" },
  ],
});

describe("counts-only cost-base audit", () => {
  it("classifies accounts", () => {
    expect(accountGroup("PERSONAL")).toBe("taxable");
    expect(accountGroup("CRYPTO")).toBe("taxable");
    expect(accountGroup("TFSA")).toBe("registered");
    expect(accountGroup("Group RRSP")).toBe("registered");
    expect(accountGroup("CARD")).toBeNull();
    expect(accountGroup("LOC")).toBeNull();
  });

  it("confirms a matching holding and names why the others can't be confirmed", () => {
    const out = costAudit(input(
      [
        pos({}),
        pos({ symbol: "BBB" }),
        pos({ symbol: "CCC", units: 20 }),
        pos({ symbol: "DDD", units: 15 }),
        pos({ symbol: "EEE", costBasis: 12 }),
        pos({ symbol: "FFF", costBasis: null }),
        pos({ symbol: "GGG", snapTradeAccountId: "card" }),
        pos({ symbol: "CASH", cashEquivalent: true }),
      ],
      [
        act({}),
        act({ symbol: "CCC" }),
        act({ symbol: "DDD" }),
        act({ symbol: "EEE" }),
        act({ symbol: "FFF" }),
      ],
    ));
    expect(out.holdings.taxable.total).toBe(6);
    expect(out.holdings.taxable.byReason).toEqual({ confirmed: 1, no_activity: 1, split_like: 1, units_short: 1, cost_mismatch: 1, no_broker_cost: 1 });
    expect(out.holdings.taxable.mismatchSize).toEqual({ "10-25%": 1 });
    expect(out.holdings.registered.total).toBe(0);
  });

  it("a cost-less transfer-in leaves the cost incomplete", () => {
    const out = costAudit(input([pos({ units: 20 })], [act({}), act({ type: "TRANSFER", amount: null, price: null })]));
    expect(out.holdings.taxable.byReason).toEqual({ cost_incomplete: 1 });
  });

  it("finds whether a USD holding's book cost is kept in CAD or in USD", () => {
    // Bought in a CAD account: 10 units for C$140 (US$10 a unit at 1.40).
    const bought = act({ symbol: "USA", securityCurrency: "USD", currency: "CAD", price: 14, amount: -140 });
    const inCad = costAudit(input([pos({ symbol: "USA", currency: "USD", costBasis: 14 })], [bought]));
    const inUsd = costAudit(input([pos({ symbol: "USA", currency: "USD", costBasis: 10 })], [bought]));
    expect(inCad.holdings.taxable.usdBookCostIn).toEqual({ cad: 1 });
    expect(inUsd.holdings.taxable.usdBookCostIn).toEqual({ usd: 1 });
    expect(inUsd.holdings.taxable.byReason).toEqual({ confirmed: 1 });
  });

  it("counts taxable sales, losses, and losses with a buy-back in a TFSA within 30 days", () => {
    const out = costAudit(input([], [
      act({ tradeDate: "2026-01-15" }), // 46 days before the loss: outside the window
      act({ type: "SELL", units: -5, amount: 40, tradeDate: "2026-03-02" }), // loss of 10
      act({ snapTradeAccountId: "tfsa", tradeDate: "2026-03-20" }), // buy-back in the TFSA, 18 days later
      act({ type: "SELL", units: -5, amount: 70, tradeDate: "2026-06-01" }), // gain of 20
      act({ symbol: "ZZZ", type: "SELL", units: -1, amount: 5, tradeDate: "2026-04-01" }), // nothing recorded before it
      act({ snapTradeAccountId: "tfsa", type: "SELL", units: -10, amount: 50, tradeDate: "2026-05-01" }), // registered: not counted
      act({ symbol: "OLD", tradeDate: "2025-11-03" }),
      act({ symbol: "OLD", type: "SELL", units: -1, amount: 5, tradeDate: "2025-12-01" }), // other tax year
    ]));
    expect(out.sales).toEqual({ total: 3, computable: 2, incomplete: 1, atLoss: 1, atGain: 1, incompleteReason: { no_buys_recorded: 1 }, incompleteInCryptoAccount: 0 });
    expect(out.lossRepurchase).toEqual({ any: 1, sameAccount: 0, registeredAccount: 1, otherTaxableAccount: 0 });
  });

  it("never emits amounts, account ids, symbols, dates or user ids", () => {
    const text = JSON.stringify(costAudit(input(
      [pos({ symbol: "SECRETSYM", costBasis: 987.65, units: 4321 }), pos({ kind: "a long free text kind", symbol: "X2" })],
      [act({ symbol: "SECRETSYM", units: 4321, amount: -123456.78, tradeDate: "2026-05-17" })],
    )));
    for (const leak of ["SECRETSYM", "4321", "123456", "987", "2026-05-17", "u1", "\"cash\"", "free text"]) expect(text).not.toContain(leak);
  });

  it("buckets mismatch size", () => {
    expect(mismatchBucket(0.05)).toBe("3-10%");
    expect(mismatchBucket(0.2)).toBe("10-25%");
    expect(mismatchBucket(0.6)).toBe(">25%");
  });
});
