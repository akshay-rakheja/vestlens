import { ACCOUNT_TYPE_LABELS, accountTypeChip, accountTypeValueLabel, knownAccountType, scopeValueLabel } from "./account-types";

test("the six account-type labels, verbatim", () => {
  expect(ACCOUNT_TYPE_LABELS).toEqual({ tfsa: "TFSA", fhsa: "FHSA", rrsp: "RRSP", non_registered: "non-registered", crypto: "crypto", cash_account: "Cash" });
});

test("chip text is the label plus accounts", () => {
  expect(accountTypeChip("tfsa")).toBe("TFSA accounts");
  expect(accountTypeChip("cash_account")).toBe("Cash accounts");
  expect(accountTypeChip("non_registered")).toBe("non-registered accounts");
});

test("only the six values are known; anything else is ignored", () => {
  expect(knownAccountType("rrsp")).toBe("rrsp");
  expect(knownAccountType("other")).toBeNull();
  expect(knownAccountType("TFSA")).toBeNull();
  expect(knownAccountType(undefined)).toBeNull();
  expect(knownAccountType(7)).toBeNull();
  expect(knownAccountType("toString")).toBeNull();
});

test("value tile label: one account, a type of several accounts, or the total (M2)", () => {
  expect(accountTypeValueLabel("tfsa")).toBe("TFSA accounts value");
  expect(accountTypeValueLabel("non_registered")).toBe("non-registered accounts value");
  expect(scopeValueLabel({ accountType: "tfsa" })).toBe("TFSA accounts value");
  // A type that matched one account echoes its id: that account's value.
  expect(scopeValueLabel({ accountType: "tfsa", accountId: "acct-1" })).toBe("Account value");
  expect(scopeValueLabel({ accountId: "acct-1" })).toBe("Account value");
  expect(scopeValueLabel({})).toBe("Total value");
  expect(scopeValueLabel({ accountType: "other" })).toBe("Total value");
});
