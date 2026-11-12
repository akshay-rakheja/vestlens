import { describe, expect, it } from "vitest";

import { classifyPortfolioAccount } from "./account-taxonomy.js";
import { countsTowardReturns, isManagedPortfolio } from "./account-taxonomy.js";

describe("classifyPortfolioAccount", () => {
  it.each([
    [
      "SELF_DIRECTED_TFSA",
      "registered",
      "tfsa",
      "Self-directed TFSA",
      true,
    ],
    ["MANAGED_TFSA", "registered", "tfsa", "Managed TFSA", true],
    [
      "SELF_DIRECTED_FHSA",
      "registered",
      "fhsa",
      "Self-directed FHSA",
      true,
    ],
    [
      "SELF_DIRECTED_RRSP",
      "registered",
      "rrsp",
      "Self-directed RRSP",
      true,
    ],
    [
      "MANAGED_PORTFOLIO_RRSP",
      "registered",
      "rrsp",
      "Managed RRSP",
      true,
    ],
    [
      "SELF_DIRECTED_NON_REGISTERED_MARGIN",
      "non_registered",
      "margin",
      "Margin account",
      true,
    ],
    [
      "MANAGED_PORTFOLIO_NON_REGISTERED",
      "non_registered",
      "automated_portfolio",
      "Automated portfolio",
      true,
    ],
    [
      "CUSTOM_PORTFOLIO_NON_REGISTERED",
      "non_registered",
      "custom_portfolio",
      "Custom portfolio",
      true,
    ],
    [
      "SELF_DIRECTED_NON_REGISTERED_PREDICTIONS",
      "non_registered",
      "predictions",
      "Predictions",
      true,
    ],
    [
      "CASH",
      "non_registered",
      "money_market",
      "Cash / money market (CAD)",
      true,
    ],
    [
      "CASH_USD",
      "non_registered",
      "money_market",
      "Cash / money market (USD)",
      true,
    ],
    [
      "SELF_DIRECTED_CRYPTO",
      "digital_assets",
      "crypto",
      "Crypto",
      true,
    ],
    [
      "CREDIT_CARD",
      "credit_products",
      "credit_card",
      "Credit card",
      false,
    ],
    [
      "PORTFOLIO_LINE_OF_CREDIT",
      "credit_products",
      "line_of_credit",
      "Portfolio line of credit",
      false,
    ],
  ] as const)(
    "classifies %s",
    (unifiedType, group, bucket, label, includedInPortfolioTotal) => {
      expect(
        classifyPortfolioAccount({
          unifiedType,
          rawType: null,
          metaType: null,
          status: "open",
        }),
      ).toMatchObject({
        group,
        bucket,
        label,
        includedInPortfolioTotal,
        isClosed: false,
      });
    },
  );

  it("moves a closed account out of active totals without losing its product label", () => {
    expect(
      classifyPortfolioAccount({
        unifiedType: "MANAGED_TFSA",
        rawType: "TFSA",
        metaType: "tfsa",
        status: "closed",
      }),
    ).toEqual({
      group: "closed",
      groupLabel: "Closed accounts",
      bucket: "tfsa",
      bucketLabel: "TFSA",
      label: "Managed TFSA",
      includedInPortfolioTotal: false,
      isClosed: true,
    });
  });

  it("uses a neutral fallback for an unknown future account type", () => {
    expect(
      classifyPortfolioAccount({
        unifiedType: "FUTURE_WEALTH_PRODUCT",
        rawType: "FUTURE",
        metaType: "future_product",
        status: "open",
      }),
    ).toEqual({
      group: "other",
      groupLabel: "Other accounts",
      bucket: "other",
      bucketLabel: "Other",
      label: "Other account",
      includedInPortfolioTotal: true,
      isClosed: false,
    });
  });

  it("falls back conservatively when unified metadata is absent", () => {
    expect(
      classifyPortfolioAccount({
        unifiedType: null,
        rawType: "RRSP",
        metaType: "rrsp",
        status: "open",
      }),
    ).toEqual({
      group: "registered",
      groupLabel: "Registered",
      bucket: "rrsp",
      bucketLabel: "RRSP",
      label: "RRSP",
      includedInPortfolioTotal: true,
      isClosed: false,
    });
  });

  it("counts investment accounts toward returns, never Cash / money market or excluded accounts", () => {
    const base = { includedInPortfolioTotal: true };
    expect(countsTowardReturns({ ...base, bucket: "tfsa", label: "Self-directed TFSA" })).toBe(true);
    expect(countsTowardReturns({ ...base, bucket: "rrsp", label: "RRSP" })).toBe(true);
    expect(countsTowardReturns({ ...base, bucket: "money_market", label: "Cash / money market (CAD)" })).toBe(false);
    expect(countsTowardReturns({ includedInPortfolioTotal: false, bucket: "credit_card", label: "Credit card" })).toBe(false);
  });

  it("leaves every managed portfolio out of returns: SnapTrade gives no holdings history for them", () => {
    for (const unifiedType of ["MANAGED_TFSA", "MANAGED_PORTFOLIO_TFSA", "MANAGED_FHSA", "MANAGED_PORTFOLIO_FHSA", "MANAGED_RRSP", "MANAGED_PORTFOLIO_RRSP", "MANAGED_PORTFOLIO_NON_REGISTERED"]) {
      const c = classifyPortfolioAccount({ unifiedType, rawType: null, metaType: null, status: "OPEN" });
      expect(isManagedPortfolio(c)).toBe(true);
      expect(countsTowardReturns(c)).toBe(false);
      expect(c.includedInPortfolioTotal).toBe(true);
    }
    for (const unifiedType of ["SELF_DIRECTED_TFSA", "SELF_DIRECTED_RRSP", "SELF_DIRECTED_NON_REGISTERED_MARGIN", "CUSTOM_PORTFOLIO_NON_REGISTERED"]) {
      const c = classifyPortfolioAccount({ unifiedType, rawType: null, metaType: null, status: "OPEN" });
      expect(isManagedPortfolio(c)).toBe(false);
      expect(countsTowardReturns(c)).toBe(true);
    }
  });
});
