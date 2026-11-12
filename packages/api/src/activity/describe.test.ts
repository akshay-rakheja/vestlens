import { describe as suite, expect, it } from "vitest";
import type { StoredActivity } from "../history/stored-activity.js";
import { describe } from "./describe.js";

const base: StoredActivity = {
  snapTradeAccountId: "A", dedupeKey: "k", type: "BUY", symbol: "VFV", securityCurrency: "CAD",
  isOption: false, units: 10, price: 112.4, amount: -1124, fee: null, fxRate: null, currency: "CAD",
  tradeDate: "2026-09-01", settlementDate: null, description: null,
};
const mk = (o: Partial<StoredActivity>): StoredActivity => ({ ...base, ...o });

suite("describe", () => {
  it("describes trades without units or prices, which the row's own fields carry (I4: privacy)", () => {
    expect(describe(mk({})).text).toBe("Bought VFV");
    expect(describe(mk({ price: null })).text).toBe("Bought VFV");
    expect(describe(mk({ units: null, price: null })).text).toBe("Bought VFV");
    expect(describe(mk({ type: "SELL" })).text).toBe("Sold VFV");
    expect(describe(mk({ type: "SELL", units: null, price: null })).text).toBe("Sold VFV");
    expect(describe(mk({ symbol: null })).text).toBe("Bought");
  });

  it("never puts a unit count or a price in any description", () => {
    for (const type of ["BUY", "SELL", "TRANSFER", "REINVEST", "DIVIDEND", "FOO_BAR"]) {
      for (const units of [10.5, -3, 0.12345678]) {
        const text = describe(mk({ type, units, price: 112.4, currency: "USD", securityCurrency: "USD" })).text;
        expect(text).not.toMatch(/\d/);
      }
    }
  });

  it("describes income and cost rows", () => {
    expect(describe(mk({ type: "DIVIDEND" })).text).toBe("Dividend VFV");
    expect(describe(mk({ type: "DISTRIBUTION" })).text).toBe("Distribution VFV");
    expect(describe(mk({ type: "REI" })).text).toBe("Reinvested dividend VFV");
    expect(describe(mk({ type: "REINVEST" })).text).toBe("Reinvested dividend VFV");
    expect(describe(mk({ type: "INTEREST", symbol: null })).text).toBe("Interest");
    expect(describe(mk({ type: "FEE", symbol: null })).text).toBe("Fee");
    expect(describe(mk({ type: "TAX" })).text).toBe("Withholding tax VFV");
    expect(describe(mk({ type: "WITHHOLDING", symbol: null })).text).toBe("Withholding tax");
  });

  it("describes money movement", () => {
    expect(describe(mk({ type: "CONTRIBUTION", symbol: null })).text).toBe("Deposit");
    expect(describe(mk({ type: "DEPOSIT", symbol: null })).text).toBe("Deposit");
    expect(describe(mk({ type: "WITHDRAWAL", symbol: null })).text).toBe("Withdrawal");
    expect(describe(mk({ type: "INTERNAL_CASH_TRANSFER_IN", symbol: null })).text).toBe("Transfer in");
    expect(describe(mk({ type: "INTERNAL_CASH_TRANSFER_OUT", symbol: null })).text).toBe("Transfer out");
    expect(describe(mk({ type: "FUNDS_CONVERSION", symbol: null })).text).toBe("Currency conversion");
  });

  it("describes security transfers by unit sign", () => {
    expect(describe(mk({ type: "TRANSFER", units: 5 })).text).toBe("Transferred in VFV");
    expect(describe(mk({ type: "TRANSFER", units: -5 })).text).toBe("Transferred out VFV");
    expect(describe(mk({ type: "TRANSFER", units: null })).text).toBe("Transferred VFV");
  });

  it("describes corporate actions and card rows", () => {
    expect(describe(mk({ type: "SPLIT" })).text).toBe("Corporate action VFV");
    expect(describe(mk({ type: "CORPORATE_ACTION" })).text).toBe("Corporate action VFV");
    expect(describe(mk({ type: "SPEND", symbol: null })).text).toBe("Card spending");
    expect(describe(mk({ type: "CREDIT_CARD_PAYMENT", symbol: null })).text).toBe("Card payment");
    expect(describe(mk({ type: "REIMBURSEMENT", symbol: null })).text).toBe("Refund");
  });

  it("title-cases unknown types and appends the symbol only when present", () => {
    expect(describe(mk({ type: "FOO_BAR" })).text).toBe("Foo Bar VFV");
    expect(describe(mk({ type: "FOO_BAR", symbol: null })).text).toBe("Foo Bar");
  });

  it("flags estimates", () => {
    expect(describe(mk({})).estimated).toBe(false);
    expect(describe(mk({ price: null })).estimated).toBe(true);
    expect(describe(mk({ type: "SELL", price: null })).estimated).toBe(true);
    expect(describe(mk({ type: "DEPOSIT", symbol: null, amount: 100, currency: null })).estimated).toBe(true);
    expect(describe(mk({ type: "DEPOSIT", symbol: null, amount: null, currency: null })).estimated).toBe(false);
    expect(describe(mk({ type: "DEPOSIT", symbol: null, amount: 100, currency: "CAD" })).estimated).toBe(false);
  });
});
