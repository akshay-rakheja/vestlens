import { describe, expect, it } from "vitest";

import { RULES_VERSION, TFSA_ANNUAL_LIMITS, classifyActivity } from "./tfsa-rules.js";

const row = (type: string | null, amount: number | null = 100, tradeDate: string | null = "2026-03-01") => ({ type, amount, tradeDate });

describe("TFSA classification table v1", () => {
  it("is versioned", () => {
    expect(RULES_VERSION).toBe("tfsa-v1");
  });

  it("CONTRIBUTION uses room and WITHDRAWAL is a withdrawal", () => {
    expect(classifyActivity(row("CONTRIBUTION"))).toBe("contribution");
    expect(classifyActivity(row("WITHDRAWAL", -100))).toBe("withdrawal");
    expect(classifyActivity(row(" contribution "))).toBe("contribution");
  });

  it("trades, income, fees, FX, tax and options never use room", () => {
    for (const t of ["BUY", "SELL", "DIVIDEND", "INTEREST", "FEE", "FUNDS_CONVERSION", "TAX", "OPTIONS_EXPIRATION", "OPTIONS_ASSIGNMENT", "OPTIONS_BUY"]) {
      expect(classifyActivity(row(t))).toBe("none");
    }
  });

  it("non-cash events never use room: reinvestments, stock dividends, splits, reorganizations and FX conversions", () => {
    for (const t of ["REI", "STOCK_DIVIDEND", "SPLIT", "REVERSE_SPLIT", "REORG", "CORPORATE_ACTION", "MERGER", "SPINOFF", "FXT", "FX", "rei"]) {
      expect(classifyActivity(row(t, 0)), t).toBe("none");
    }
  });

  it("internal cash transfers, any TRANSFER* type and unknown types are ambiguous", () => {
    for (const t of ["INTERNAL_CASH_TRANSFER_IN", "INTERNAL_CASH_TRANSFER_OUT", "TRANSFER", "TRANSFER_IN", "TRANSFERS_IN_KIND", "SOMETHING_NEW", "STOCK_TRANSFER", "JOURNAL", ""]) {
      expect(classifyActivity(row(t))).toBe("ambiguous");
    }
  });

  it("a $0 row of any non-transfer type cannot affect room; DEPOSIT, REIMBURSEMENT and PROMOTION are named (C5)", () => {
    for (const t of ["OPTIONEXPIRATION", "OPTIONS_SHORT_EXPIRY", "SOMETHING_NEW", "CORPORATE_ACTION"]) {
      expect(classifyActivity(row(t, 0)), t).toBe("none");
    }
    // A $0 TRANSFER row is an in-kind transfer (shares, no cash): it stays a question until it is valued (A2).
    expect(classifyActivity(row("TRANSFER", 0))).toBe("ambiguous");
    expect(classifyActivity(row("INTERNAL_CASH_TRANSFER_IN", 0))).toBe("ambiguous");
    // A non-zero row of an unlisted type is still ambiguous.
    expect(classifyActivity(row("SOMETHING_NEW", 25))).toBe("ambiguous");
    expect(classifyActivity(row("DEPOSIT", 100))).toBe("contribution");
    expect(classifyActivity(row("DEPOSIT", -100))).toBe("ambiguous");
    expect(classifyActivity(row("REIMBURSEMENT", 5))).toBe("none");
    expect(classifyActivity(row("PROMOTION", 25))).toBe("none");
  });

  it("a row missing type, amount or trade date is ambiguous", () => {
    expect(classifyActivity(row(null))).toBe("ambiguous");
    expect(classifyActivity(row("CONTRIBUTION", null))).toBe("ambiguous");
    expect(classifyActivity(row("CONTRIBUTION", Number.NaN))).toBe("ambiguous");
    expect(classifyActivity(row("CONTRIBUTION", 100, null))).toBe("ambiguous");
    expect(classifyActivity(row("BUY", null))).toBe("ambiguous");
  });

  it("a user classification outranks the table", () => {
    expect(classifyActivity(row("INTERNAL_CASH_TRANSFER_IN"), "contribution")).toBe("contribution");
    expect(classifyActivity(row("INTERNAL_CASH_TRANSFER_IN"), "none")).toBe("none");
    expect(classifyActivity(row("CONTRIBUTION"), "none")).toBe("none");
    expect(classifyActivity(row("WITHDRAWAL", -5), "none")).toBe("none");
    expect(classifyActivity(row(null), "contribution")).toBe("contribution");
  });

  it("a sign that contradicts the type is ambiguous", () => {
    expect(classifyActivity(row("CONTRIBUTION", -5000))).toBe("ambiguous");
    expect(classifyActivity(row("WITHDRAWAL", 5000))).toBe("ambiguous");
    expect(classifyActivity(row("INTERNAL_CASH_TRANSFER_IN", -10), "contribution")).toBe("ambiguous");
    expect(classifyActivity(row("CONTRIBUTION", 0))).toBe("contribution");
  });

  it("a user 'contribution' still needs an amount and a date to count", () => {
    expect(classifyActivity(row("INTERNAL_CASH_TRANSFER_IN", null), "contribution")).toBe("ambiguous");
    expect(classifyActivity(row("INTERNAL_CASH_TRANSFER_IN", 100, null), "contribution")).toBe("ambiguous");
  });
});

describe("TFSA annual limits", () => {
  it("holds CRA's published figures", () => {
    expect(TFSA_ANNUAL_LIMITS[2009]).toBe(5000);
    expect(TFSA_ANNUAL_LIMITS[2013]).toBe(5500);
    expect(TFSA_ANNUAL_LIMITS[2015]).toBe(10000);
    expect(TFSA_ANNUAL_LIMITS[2019]).toBe(6000);
    expect(TFSA_ANNUAL_LIMITS[2023]).toBe(6500);
    expect(TFSA_ANNUAL_LIMITS[2024]).toBe(7000);
    expect(TFSA_ANNUAL_LIMITS[2025]).toBe(7000);
    expect(TFSA_ANNUAL_LIMITS[2026]).toBe(7000);
    expect(Object.keys(TFSA_ANNUAL_LIMITS).map(Number)).toEqual(Array.from({ length: 18 }, (_, i) => 2009 + i));
    expect(Object.values(TFSA_ANNUAL_LIMITS).reduce((a, b) => a + b, 0)).toBe(109000);
  });
});
