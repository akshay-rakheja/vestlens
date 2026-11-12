import { describe, expect, it } from "vitest";

import { classifyPortfolioAccount } from "./account-taxonomy.js";
import { managedNotInTotal, notInTotalText } from "./portfolio-presentation.js";

// Synthetic accounts only: the product type and a reported value are all the rule reads.
const account = (unifiedType: string, value: number | null, status = "OPEN") => ({
  classification: classifyPortfolioAccount({ unifiedType, rawType: null, metaType: null, status }),
  value: value === null ? null : { amount: value, currency: "CAD", source: "brokerage_reported" as const },
}) as any;

describe("managedNotInTotal", () => {
  it("names a managed portfolio SnapTrade reports at zero or without a value, once", () => {
    const accounts = [account("SELF_DIRECTED_TFSA", 1000), account("MANAGED_PORTFOLIO_NON_REGISTERED", 0), account("MANAGED_PORTFOLIO_NON_REGISTERED", null)];
    expect(managedNotInTotal({ accounts })).toEqual(["Automated portfolio"]);
    expect(notInTotalText({ accounts })).toBe(" Not included in the total: Automated portfolio. SnapTrade doesn't provide the value of Wealthsimple managed portfolios, so the total leaves them out; their value is in the Wealthsimple app.");
  });

  it("says nothing for a managed portfolio SnapTrade does value, a closed one, or self-directed accounts at zero", () => {
    const accounts = [account("MANAGED_TFSA", 2500), account("MANAGED_RRSP", 0, "CLOSED"), account("SELF_DIRECTED_RRSP", 0)];
    expect(managedNotInTotal({ accounts })).toEqual([]);
    expect(notInTotalText({ accounts })).toBe("");
  });
});
