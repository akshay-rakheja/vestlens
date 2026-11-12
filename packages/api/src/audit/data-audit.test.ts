import { describe, expect, it } from "vitest";

import { auditCounts, historyBucket, safeLabel, type AuditActivity, type AuditInput } from "./data-audit.js";

// Synthetic accounts, amounts and text only.
const act = (over: Partial<AuditActivity>): AuditActivity => ({
  appUserId: "u1", snapTradeAccountId: "tfsa", type: "BUY", symbolPresent: true, securityCurrency: "CAD", currency: "CAD",
  units: 1, price: 10, amount: -10, fee: 0, fxRate: null, tradeDate: "2026-03-02", description: null, ...over,
});
const input = (activities: AuditActivity[]): AuditInput => ({
  today: "2026-10-26", users: 1, snapshotCount: 4, dailyValueDaysPerUser: [40],
  accounts: [
    { appUserId: "u1", snapTradeAccountId: "tfsa", institutionName: "Synthetic Broker", rawType: "TFSA", category: "registered", status: "open" },
    { appUserId: "u1", snapTradeAccountId: "cash", institutionName: "Synthetic Broker", rawType: "Cash", category: null, status: "open" },
  ],
  sync: [{ appUserId: "u1", snapTradeAccountId: "tfsa", backfillCompleted: true, lastSyncedAt: "2026-10-25T00:00:00Z", lastError: false, earliestTradeDate: "2026-02-01" }],
  activities,
});

describe("counts-only data audit", () => {
  it("pairs a cash-to-TFSA transfer and leaves a lone transfer unpaired", () => {
    const out = auditCounts(input([
      act({ type: "INTERNAL_CASH_TRANSFER_IN", amount: 500, tradeDate: "2026-01-05" }),
      act({ snapTradeAccountId: "cash", type: "INTERNAL_CASH_TRANSFER_OUT", amount: -500, tradeDate: "2026-01-06" }),
      act({ type: "INTERNAL_CASH_TRANSFER_IN", amount: 250, tradeDate: "2026-02-05" }),
    ]));
    expect(out.transfers).toMatchObject({ total: 3, usable: 3, inPaired: 1, inUnpaired: 1, inPairedFromNonTfsaIntoTfsa: 1, inPairedTfsaToTfsa: 0 });
  });

  it("counts fields, foreign trades, USD dividends with a same-day tax row, and description keywords", () => {
    const out = auditCounts(input([
      act({ type: "BUY", securityCurrency: "USD", currency: "CAD", fxRate: 1.38, amount: -13.8 }),
      act({ type: "DIVIDEND", currency: "USD", tradeDate: "2026-04-01", amount: 3 }),
      act({ type: "TAX", currency: "USD", tradeDate: "2026-04-01", amount: -0.45, description: "Non-resident tax withholding" }),
    ]));
    expect(out.activities.foreignSecurityTrades).toEqual({ total: 1, withFxRate: 1, priceRatio: { "1.35-1.40": 1 } });
    expect(out.activities.dividends).toEqual({ total: 1, usd: 1, usdWithTaxRowSameDay: 1 });
    expect(out.activities.descriptionMentions.withholding).toBe(1);
    expect(out.activities.fieldsFilled.fxRate).toBe(1);
  });

  it("never emits amounts, account ids, symbols, dates or description text", () => {
    const text = JSON.stringify(auditCounts(input([
      act({ description: "Secret memo 4242 for ACCT-SECRET", amount: 123456.78, tradeDate: "2026-05-17" }),
      act({ type: "a very long free text type that should not leak through the label filter at all" }),
    ])));
    for (const leak of ["123456", "Secret", "4242", "ACCT", "2026-05-17", "tfsa\"", "u1", "free text"]) expect(text).not.toContain(leak);
  });

  it("buckets history and labels", () => {
    expect(historyBucket("2026-10-01", "2026-10-26")).toBe("≤1 month");
    expect(historyBucket("2024-01-01", "2026-10-26")).toBe("2–5 years");
    expect(historyBucket(null, "2026-10-26")).toBe("none");
    expect(safeLabel("TFSA")).toBe("TFSA");
    expect(safeLabel("x".repeat(60))).toBe("OTHER");
    expect(safeLabel(null)).toBe("NONE");
  });
});
