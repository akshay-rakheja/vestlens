import { describe, expect, it } from "vitest";
import { miniSyntheticAccount } from "../testing/mini-synthetic-fixtures.js";
import { buildPortfolioPresentation } from "./portfolio-presentation.js";
import type { PortfolioQueryResult } from "./portfolio-query-service.js";

const query = (accounts: PortfolioQueryResult["accounts"]): PortfolioQueryResult => ({
  accounts,
  generatedAt: new Date(Date.UTC(2026, 9, 6, 14)).toISOString(),
  connectionRequired: false,
  errors: [],
});

describe("mini generated synthetic portfolio presentation", () => {
  it("uses brokerage totals and keeps normalized currencies separate", () => {
    const result = buildPortfolioPresentation(query([
      miniSyntheticAccount(0, { currency: " cad " }),
      miniSyntheticAccount(1, { currency: "uSd" }),
      miniSyntheticAccount(2, { currency: "CAD" }),
    ]));
    expect(result.totals).toEqual([
      { currency: "CAD", amount: 586, source: "brokerage_reported" },
      { currency: "USD", amount: 293, source: "brokerage_reported" },
    ]);
    expect(result.accounts[0].reconciliation.calculatedByCurrency).toEqual([{ currency: "CAD", amount: 17 }]);
    expect(result.accounts[0].balances[0].currency).toBe("CAD");
    expect(result.accounts[0].positions[0].currency).toBe("CAD");
  });

  it("keeps closed accounts out of totals with their values, and leaves credit products out entirely", () => {
    const result = buildPortfolioPresentation(query([
      miniSyntheticAccount(0),
      miniSyntheticAccount(3, { status: "closed" }),
      miniSyntheticAccount(4, { unifiedType: "CREDIT_CARD" }),
      miniSyntheticAccount(5, { unifiedType: "PORTFOLIO_LINE_OF_CREDIT" }),
    ]));
    expect(result.totals).toEqual([{ currency: "CAD", amount: 156, source: "brokerage_reported" }]);
    expect(result.accounts.map(a => a.id)).toEqual(["MINI-SYNTHETIC-ACCOUNT-0", "MINI-SYNTHETIC-ACCOUNT-3"]);
    expect(result.accounts.filter(a => !a.classification.includedInPortfolioTotal).map(a => a.value?.amount)).toEqual([567]);
  });

  it("does not reconstruct a missing reported total from cash and positions", () => {
    const result = buildPortfolioPresentation(query([miniSyntheticAccount(0, { reported: false })]));
    expect(result.totals).toEqual([]);
    expect(result.accounts[0].value).toBeNull();
    expect(result.accounts[0].reconciliation.calculatedByCurrency).toEqual([{ currency: "CAD", amount: 17 }]);
    expect(result.accounts[0].warnings).toContain("Brokerage-reported total is unavailable; this account is excluded from portfolio totals.");
  });

  it("keeps unfamiliar metadata neutral and uses the classification when the name is blank", () => {
    const result = buildPortfolioPresentation(query([miniSyntheticAccount(0, {
      unifiedType: "MINI_SYNTHETIC_UNRECOGNIZED", rawType: null, name: "  ",
    })]));
    expect(result.accounts[0]).toMatchObject({ name: "Other account", classification: { group: "other", label: "Other account" } });
    expect(result.totals[0].amount).toBe(156);
  });

  it("preserves unknown freshness, incomplete warnings and position counts", () => {
    const source = miniSyntheticAccount(0);
    source.freshness.positionsAsOf = null;
    source.freshness.holdingsUnavailable = true;
    source.positions[0].price = null;
    source.positions[0].marketValue = null;
    const result = buildPortfolioPresentation(query([source]));
    expect(result.accounts[0].freshness).toEqual(source.freshness);
    expect(result.accounts[0].warnings).toEqual(source.warnings);
    expect(result.accounts[0].positionCount).toBe(1);
    expect(result.accounts[0].positions[0].marketValue).toBeNull();
    expect(result.totals[0].amount).toBe(156);
  });

  it("does not include account numbers or connection identifiers in presentation", () => {
    const source = miniSyntheticAccount(0);
    const result = buildPortfolioPresentation(query([source]));
    expect(JSON.stringify(result)).not.toContain(source.account.number);
    expect(JSON.stringify(result)).not.toContain(source.account.connectionId);
    expect(result.accounts[0]).not.toHaveProperty("number");
    expect(result.accounts[0]).not.toHaveProperty("connectionId");
  });

  it("preserves negative brokerage totals without inventing conversion or clamping", () => {
    const source = miniSyntheticAccount(1, { currency: "USD" });
    source.account.reportedTotal!.amount *= -1;
    const result = buildPortfolioPresentation(query([miniSyntheticAccount(0), source]));
    expect(result.totals.map(t => [t.currency, t.amount])).toEqual([["CAD", 156], ["USD", -293]]);
  });

  it("keeps connection-required and partial-error states explicit", () => {
    const input = query([]);
    input.connectionRequired = true;
    input.errors = [{ accountId: "MINI-SYNTHETIC-UNAVAILABLE", code: "account_data_unavailable" }];
    expect(buildPortfolioPresentation(input)).toEqual({ ...input, totals: [] });
  });

  it("sorts account groups without changing the input or its currency spelling", () => {
    const input = query([
      miniSyntheticAccount(0, { status: "closed", currency: " cad " }),
      miniSyntheticAccount(1, { unifiedType: "CREDIT_CARD" }),
      miniSyntheticAccount(2, { unifiedType: "SELF_DIRECTED_NON_REGISTERED_MARGIN" }),
      miniSyntheticAccount(3, { unifiedType: "SELF_DIRECTED_FHSA" }),
      miniSyntheticAccount(4),
    ]);
    const before = structuredClone(input);
    const result = buildPortfolioPresentation(input);
    // The credit card (account 1) is left out of the portfolio.
    expect(result.accounts.map(a => a.id)).toEqual([4, 3, 2, 0].map(i => `MINI-SYNTHETIC-ACCOUNT-${i}`));
    expect(input).toEqual(before);
  });
});
