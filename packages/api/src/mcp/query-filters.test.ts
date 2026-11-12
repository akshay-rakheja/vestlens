import { describe, expect, it } from "vitest";
import { classifyPortfolioAccount } from "../portfolio/account-taxonomy.js";
import type { PortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABELS,
  accountFilterProperties,
  accountFilterShape,
  accountTypeOf,
  resolveAccountFilter,
  symbolMatches,
  symbolProperty,
  symbolShape,
} from "./query-filters.js";

type Account = PortfolioPresentation["accounts"][number];

function classify(unifiedType: string | null, status = "open", rawType: string | null = null) {
  return classifyPortfolioAccount({ unifiedType, rawType, metaType: null, status });
}

function account(id: string, name: string, unifiedType: string | null, status = "open"): Account {
  return {
    id,
    name,
    classification: classify(unifiedType, status),
    value: { currency: "CAD", amount: 100, source: "brokerage_reported" },
  } as unknown as Account;
}

const portfolioOf = (accounts: Account[]) => ({ accounts });

describe("accountTypeOf", () => {
  it.each([
    ["SELF_DIRECTED_TFSA", "tfsa"],
    ["MANAGED_TFSA", "tfsa"],
    ["SELF_DIRECTED_FHSA", "fhsa"],
    ["SELF_DIRECTED_RRSP", "rrsp"],
    ["SELF_DIRECTED_NON_REGISTERED_MARGIN", "non_registered"],
    ["MANAGED_PORTFOLIO_NON_REGISTERED", "non_registered"],
    ["CUSTOM_PORTFOLIO_NON_REGISTERED", "non_registered"],
    ["SELF_DIRECTED_NON_REGISTERED_PREDICTIONS", "non_registered"],
    ["SELF_DIRECTED_CRYPTO", "crypto"],
    ["CASH", "cash_account"],
  ] as const)("maps %s to %s", (unifiedType, expected) => {
    expect(accountTypeOf(classify(unifiedType))).toBe(expected);
  });

  it("maps no value for credit products, closed accounts or unrecognised types", () => {
    expect(accountTypeOf(classify("CREDIT_CARD"))).toBeNull();
    expect(accountTypeOf(classify("SELF_DIRECTED_TFSA", "CLOSED"))).toBeNull();
    const unknown = classify("SOMETHING_NEW");
    expect(unknown.group).toBe("other");
    expect(accountTypeOf(unknown)).toBeNull();
  });

  it("has a label for every value", () => {
    expect(ACCOUNT_TYPES.map((t) => ACCOUNT_TYPE_LABELS[t])).toEqual(["TFSA", "FHSA", "RRSP", "non-registered", "crypto", "Cash"]);
  });
});

describe("resolveAccountFilter", () => {
  const oneTfsa = portfolioOf([account("t1", "TFSA main", "SELF_DIRECTED_TFSA"), account("r1", "RRSP", "SELF_DIRECTED_RRSP")]);

  it("resolves no filter to all accounts", () => {
    expect(resolveAccountFilter(oneTfsa, {})).toMatchObject({ ok: true, ids: null, scope: "across all accounts", excluded: [] });
  });

  it("resolves one account of a type", () => {
    const r = resolveAccountFilter(oneTfsa, { accountType: "tfsa" });
    expect(r).toMatchObject({ ok: true, scope: "in your TFSA", accountType: "tfsa", singleId: "t1", excluded: [] });
    expect(r.ok && r.ids && [...r.ids]).toEqual(["t1"]);
  });

  it("resolves several accounts of a type with a plural scope and no singleId", () => {
    const two = portfolioOf([account("t1", "A", "SELF_DIRECTED_TFSA"), account("t2", "B", "MANAGED_TFSA")]);
    const r = resolveAccountFilter(two, { accountType: "tfsa" });
    expect(r).toMatchObject({ ok: true, scope: "in your TFSAs" });
    expect(r.ok && r.singleId).toBeUndefined();
    expect(r.ok && r.ids && [...r.ids].sort()).toEqual(["t1", "t2"]);
  });

  it("words the Cash account scope", () => {
    const p = portfolioOf([account("c1", "Cash", "CASH")]);
    expect(resolveAccountFilter(p, { accountType: "cash_account" })).toMatchObject({ ok: true, scope: "in your Cash account" });
    const two = portfolioOf([account("c1", "Cash", "CASH"), account("c2", "Cash USD", "CASH_USD")]);
    expect(resolveAccountFilter(two, { accountType: "cash_account" })).toMatchObject({ ok: true, scope: "in your Cash accounts" });
  });

  it("does not match closed or credit accounts", () => {
    const p = portfolioOf([account("t1", "Old", "SELF_DIRECTED_TFSA", "CLOSED"), account("cc", "Card", "CREDIT_CARD")]);
    expect(resolveAccountFilter(p, { accountType: "tfsa" })).toMatchObject({ ok: false, code: "no_accounts_of_type" });
  });

  it("errors when no account has the type", () => {
    expect(resolveAccountFilter(oneTfsa, { accountType: "fhsa" })).toEqual({
      ok: false,
      code: "no_accounts_of_type",
      text: "No connected FHSA accounts. Use list_portfolio_accounts to see what is connected.",
    });
  });

  it("errors when both filters are given", () => {
    expect(resolveAccountFilter(oneTfsa, { accountId: "t1", accountType: "tfsa" })).toEqual({
      ok: false,
      code: "both_filters",
      text: "Give accountId or accountType, not both.",
    });
  });

  it("errors on an unknown accountId", () => {
    expect(resolveAccountFilter(oneTfsa, { accountId: "nope" })).toEqual({
      ok: false,
      code: "unknown_account",
      text: "Unknown or excluded account. Use list_portfolio_accounts to pick an account.",
    });
  });

  it("scopes an accountId by the account name", () => {
    const r = resolveAccountFilter(oneTfsa, { accountId: "t1" });
    expect(r).toMatchObject({ ok: true, scope: "in TFSA main", singleId: "t1", excluded: [] });
    expect(r.ok && r.ids && [...r.ids]).toEqual(["t1"]);
  });

  describe("single", () => {
    const eligible = (a: Account) => a.id === "r1";
    const rrsps = portfolioOf([account("r1", "Self RRSP", "SELF_DIRECTED_RRSP"), account("r2", "Managed RRSP", "MANAGED_RRSP")]);

    it("answers for the one eligible account and names the others as excluded", () => {
      const r = resolveAccountFilter(rrsps, { accountType: "rrsp" }, { eligible, single: true });
      expect(r).toMatchObject({ ok: true, singleId: "r1", excluded: [{ id: "r2", name: "Managed RRSP" }] });
      expect(r.ok && r.ids && [...r.ids]).toEqual(["r1"]);
    });

    it("lists the accounts when several are eligible", () => {
      const r = resolveAccountFilter(rrsps, { accountType: "rrsp" }, { single: true });
      expect(r).toEqual({
        ok: false,
        code: "several_accounts",
        text: "You have 2 RRSP accounts: Self RRSP (r1), Managed RRSP (r2). Ask about one with accountId, or about all accounts.",
        matches: [{ id: "r1", name: "Self RRSP" }, { id: "r2", name: "Managed RRSP" }],
      });
    });

    it("keeps the matched but ineligible accounts visible when none is eligible", () => {
      const r = resolveAccountFilter(rrsps, { accountType: "rrsp" }, { eligible: () => false, single: true });
      expect(r).toMatchObject({ ok: false, code: "no_accounts_of_type", matches: [{ id: "r1" }, { id: "r2" }] });
    });
  });
});

describe("symbolMatches", () => {
  it.each([
    ["XEQT", "xeqt", true],
    ["XEQT.TO", "xeqt", true],
    ["XEQT.TO", "XEQT.TO", true],
    ["XEQTX", "xeqt", false],
    ["XEQT.TO", "XEQT.NE", false],
    // A bare row matches a listing query (I2): the same security named without its exchange suffix.
    ["XEQT", "XEQT.TO", true],
    ["xeqt", " xeqt.to ", true],
    ["XEQT", "XEQTX.TO", false],
    ["XEQTX", "XEQT.TO", false],
    ["XEQT.NE", "XEQT.TO", false],
    ["XEQT", "XEQTX", false],
    ["", "XEQT", false],
    ["XEQT", " ", false],
    // Only exchange suffixes name a listing; a share-class suffix is another security (CTC.A is not CTC).
    ["XEQT.V", "XEQT", true],
    ["XEQT.NEO", "XEQT", true],
    ["XEQT", "XEQT.CN", true],
    ["CTC.A", "CTC", false],
    ["CTC", "CTC.A", false],
    ["BRK.B", "BRK", false],
    ["BRK", "BRK.B", false],
    ["CTC.A", "CTC.A", true],
    ["CTC.A.TO", "CTC.A", true],
  ])("(%s, %s) is %s", (row, query, expected) => {
    expect(symbolMatches(row, query)).toBe(expected);
  });
});

describe("schema fragments", () => {
  it("validates with zod", () => {
    expect(accountFilterShape.accountType.safeParse("tfsa").success).toBe(true);
    expect(accountFilterShape.accountType.safeParse("savings").success).toBe(false);
    expect(accountFilterShape.accountId.safeParse("").success).toBe(false);
    expect(symbolShape.parse("  XEQT ")).toBe("XEQT");
    expect(symbolShape.safeParse("").success).toBe(false);
    expect(symbolShape.safeParse("X".repeat(41)).success).toBe(false);
  });

  it("carries the verbatim descriptions", () => {
    expect(accountFilterProperties.accountId.description).toBe("One account's id from list_portfolio_accounts.");
    expect(accountFilterProperties.accountType.description).toBe(
      "All of the user's accounts of one type, e.g. tfsa for 'my TFSA'. Use instead of accountId, not with it.",
    );
    expect(accountFilterProperties.accountType.enum).toEqual([...ACCOUNT_TYPES]);
    expect(symbolProperty.description).toBe("A stock or ETF symbol, e.g. XEQT; matches listings like XEQT.TO.");
  });
});
