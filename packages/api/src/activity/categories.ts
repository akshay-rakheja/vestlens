import type { StoredActivity } from "../history/stored-activity.js";

export type ActivityCategory = "investing" | "moving_money" | "cash";
export const ACTIVITY_CATEGORIES: readonly ActivityCategory[] = ["investing", "moving_money", "cash"];

const INVESTING = new Set([
  "BUY", "SELL", "DIVIDEND", "REI", "REINVEST", "INTEREST", "DISTRIBUTION", "FEE", "TAX",
  "WITHHOLDING", "STOCK_DIVIDEND", "SPLIT", "CORPORATE_ACTION",
]);
const MOVING_MONEY = new Set([
  "CONTRIBUTION", "DEPOSIT", "WITHDRAWAL", "INTERNAL_CASH_TRANSFER_IN", "INTERNAL_CASH_TRANSFER_OUT",
  "FUNDS_CONVERSION",
]);
const CASH = new Set(["SPEND", "CREDIT_CARD_PAYMENT", "REIMBURSEMENT", "CREDIT_CARD"]);

/** accountKind is derived from the account classification by the caller. */
export function categorize(
  a: Pick<StoredActivity, "type" | "symbol" | "isOption">,
  accountKind: "investment" | "cash" | "credit",
): ActivityCategory {
  if (a.isOption) return "investing";
  const type = a.type.toUpperCase();
  if (INVESTING.has(type)) return "investing";
  if (MOVING_MONEY.has(type)) return "moving_money";
  if (CASH.has(type)) return "cash";
  if (type === "TRANSFER") return a.symbol ? "investing" : "moving_money";
  if (accountKind === "cash" || accountKind === "credit") return "cash";
  return a.symbol ? "investing" : "moving_money";
}
