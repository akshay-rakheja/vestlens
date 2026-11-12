import { describe, expect, it } from "vitest";
import { isHistoryChangeEvent } from "./webhook-events.js";

describe("isHistoryChangeEvent", () => {
  it.each(["ACCOUNT_TRANSACTIONS_INITIAL_UPDATE", "ACCOUNT_TRANSACTIONS_UPDATED", "ACCOUNT_HOLDINGS_UPDATED", "NEW_ACCOUNT_AVAILABLE", "CONNECTION_ADDED", "CONNECTION_FIXED", "account_holdings_updated"])("flags %s", (type) => {
    expect(isHistoryChangeEvent(type)).toBe(true);
  });
  it.each(["CONNECTION_DELETED", "CONNECTION_BROKEN", "USER_REGISTERED", ""])("ignores %s", (type) => {
    expect(isHistoryChangeEvent(type)).toBe(false);
  });
  it("returns false for non-string input", () => {
    expect(isHistoryChangeEvent(undefined as any)).toBe(false);
    expect(isHistoryChangeEvent(5 as any)).toBe(false);
  });
});
