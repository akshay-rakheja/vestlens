import { describe, expect, it } from "vitest";
import { ACTIVITY_CATEGORIES, categorize } from "./categories.js";

const row = (type: string, symbol: string | null = null, isOption = false) => ({ type, symbol, isOption });

describe("categorize", () => {
  it("lists the three categories", () => {
    expect([...ACTIVITY_CATEGORIES]).toEqual(["investing", "moving_money", "cash"]);
  });

  it.each([
    "BUY", "SELL", "DIVIDEND", "REI", "REINVEST", "INTEREST", "DISTRIBUTION", "FEE", "TAX",
    "WITHHOLDING", "STOCK_DIVIDEND", "SPLIT", "CORPORATE_ACTION",
  ])("%s is investing", (type) => {
    expect(categorize(row(type, "VFV"), "investment")).toBe("investing");
    expect(categorize(row(type), "investment")).toBe("investing");
  });

  it.each([
    "CONTRIBUTION", "DEPOSIT", "WITHDRAWAL", "INTERNAL_CASH_TRANSFER_IN", "INTERNAL_CASH_TRANSFER_OUT",
    "FUNDS_CONVERSION",
  ])("%s is moving_money", (type) => {
    expect(categorize(row(type), "investment")).toBe("moving_money");
  });

  it.each(["SPEND", "CREDIT_CARD_PAYMENT", "REIMBURSEMENT", "CREDIT_CARD"])("%s is cash", (type) => {
    expect(categorize(row(type), "investment")).toBe("cash");
    expect(categorize(row(type), "cash")).toBe("cash");
  });

  it("splits TRANSFER by symbol", () => {
    expect(categorize(row("TRANSFER", "VFV"), "investment")).toBe("investing");
    expect(categorize(row("TRANSFER"), "investment")).toBe("moving_money");
  });

  it("keeps option rows in investing", () => {
    expect(categorize(row("BUY", "VFV", true), "investment")).toBe("investing");
    expect(categorize(row("WEIRD", null, true), "investment")).toBe("investing");
  });

  it("unknown type: investing with a symbol, else moving_money", () => {
    expect(categorize(row("WEIRD", "VFV"), "investment")).toBe("investing");
    expect(categorize(row("WEIRD"), "investment")).toBe("moving_money");
  });

  it("unknown type on a cash or credit account is cash", () => {
    expect(categorize(row("WEIRD"), "cash")).toBe("cash");
    expect(categorize(row("WEIRD", "VFV"), "credit")).toBe("cash");
  });

  it.each([
    ["BUY", "investing"], ["SELL", "investing"], ["DIVIDEND", "investing"], ["FEE", "investing"],
    ["TAX", "investing"], ["INTEREST", "investing"], ["CORPORATE_ACTION", "investing"],
    ["CONTRIBUTION", "moving_money"], ["WITHDRAWAL", "moving_money"],
    ["INTERNAL_CASH_TRANSFER_IN", "moving_money"], ["INTERNAL_CASH_TRANSFER_OUT", "moving_money"],
    ["FUNDS_CONVERSION", "moving_money"], ["TRANSFER", "moving_money"],
    ["SPEND", "cash"], ["CREDIT_CARD_PAYMENT", "cash"], ["CREDIT_CARD", "cash"], ["REIMBURSEMENT", "cash"],
  ] as const)("real type %s (no symbol) is %s", (type, expected) => {
    expect(categorize(row(type), "investment")).toBe(expected);
  });

  it("listed moving-money types stay moving_money on cash and credit accounts", () => {
    expect(categorize(row("DEPOSIT"), "cash")).toBe("moving_money");
    expect(categorize(row("WITHDRAWAL"), "credit")).toBe("moving_money");
  });

  it("is case-insensitive on type", () => {
    expect(categorize(row("buy", "VFV"), "investment")).toBe("investing");
    expect(categorize(row("deposit"), "investment")).toBe("moving_money");
  });

  it("an option row on a cash account stays investing", () => {
    expect(categorize(row("BUY", "VFV", true), "cash")).toBe("investing");
  });
});
