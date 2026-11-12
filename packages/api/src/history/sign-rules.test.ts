import { expect, it } from "vitest";
import { cashDelta, unitsDelta } from "./sign-rules.js";

it("buys reduce cash (amount already negative) and increase units", () => {
  expect(cashDelta("BUY", -100)).toBe(-100);
  expect(unitsDelta("BUY", 2)).toBe(2);
  expect(unitsDelta("BUY", -2)).toBe(2);
});
it("sells increase cash (amount positive) and decrease units", () => {
  expect(cashDelta("SELL", 250)).toBe(250);
  expect(unitsDelta("SELL", 3)).toBe(-3);
  expect(unitsDelta("SELL", -3)).toBe(-3);
});
it("contributions add cash", () => {
  expect(cashDelta("CONTRIBUTION", 500)).toBe(500);
});
it("withdrawals, fees, taxes and cash-transfer-outs arrive negative and are applied as reported", () => {
  expect(cashDelta("WITHDRAWAL", -200)).toBe(-200);
  expect(cashDelta("FEE", -5)).toBe(-5);
  expect(cashDelta("TAX", -7)).toBe(-7);
  expect(cashDelta("INTERNAL_CASH_TRANSFER_OUT", -40)).toBe(-40);
});
it("spend and credit card payments arrive positive and remove cash", () => {
  expect(cashDelta("SPEND", 12)).toBe(-12);
  expect(cashDelta("CREDIT_CARD_PAYMENT", 90)).toBe(-90);
});
it("income-like inflows add cash and have no position effect", () => {
  expect(cashDelta("DIVIDEND", 3)).toBe(3);
  expect(cashDelta("INTEREST", 2)).toBe(2);
  expect(cashDelta("INTERNAL_CASH_TRANSFER_IN", 40)).toBe(40);
  expect(unitsDelta("DIVIDEND", 5)).toBe(0);
});
it("transfers move units as reported", () => {
  expect(unitsDelta("TRANSFER", 4)).toBe(4);
  expect(unitsDelta("TRANSFER", -4)).toBe(-4);
});
it("credit card activity is excluded from cash", () => {
  expect(cashDelta("CREDIT_CARD", 40)).toBe(0);
});
it("types are matched case-insensitively", () => {
  expect(cashDelta("spend", 12)).toBe(-12);
});
it("null amounts and units have no effect", () => {
  expect(cashDelta("SOMETHING_NEW", null)).toBe(0);
  expect(cashDelta("BUY", null)).toBe(0);
  expect(unitsDelta("BUY", null)).toBe(0);
});
it("unknown types apply the amount as reported and have no position effect", () => {
  expect(cashDelta("SOMETHING_NEW", 9)).toBe(9);
  expect(unitsDelta("SOMETHING_NEW", 9)).toBe(0);
});
it("M4: REINVEST adds units (abs+) and applies the cash debit as reported", () => {
  expect(unitsDelta("REINVEST", 0.25)).toBe(0.25);
  expect(unitsDelta("REINVEST", -0.25)).toBe(0.25);
  expect(cashDelta("REINVEST", -5)).toBe(-5);
});
it("PROMOTION is a cash credit applied as reported, with no position effect", () => {
  expect(cashDelta("PROMOTION", 25)).toBe(25);
  expect(unitsDelta("PROMOTION", 3)).toBe(0);
});
