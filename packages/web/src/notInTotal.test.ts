import { describe, expect, it } from "vitest";

import { managedNotInTotal, notInTotalNote, type PortfolioAccount } from "./App";

const account = (unifiedType: string, label: string, amount: number | null, included = true) =>
  ({ unifiedType, classification: { label, includedInPortfolioTotal: included }, value: amount === null ? null : { amount, currency: "CAD", source: "brokerage_reported" } }) as unknown as PortfolioAccount;

describe("managedNotInTotal", () => {
  it("names managed portfolios SnapTrade reports without a value, and nothing else", () => {
    const labels = managedNotInTotal([
      account("SELF_DIRECTED_TFSA", "Self-directed TFSA", 1000),
      account("MANAGED_PORTFOLIO_NON_REGISTERED", "Automated portfolio", 0),
      account("MANAGED_TFSA", "Managed TFSA", 2500),
      account("MANAGED_RRSP", "Managed RRSP", null, false),
    ]);
    expect(labels).toEqual(["Automated portfolio"]);
    expect(notInTotalNote(labels)).toBe("Not included: Automated portfolio. SnapTrade doesn't provide the value of Wealthsimple managed portfolios, so this total leaves them out; their value is in the Wealthsimple app.");
  });
});
