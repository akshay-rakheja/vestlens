import { z } from "zod";
import type { AccountClassification } from "../portfolio/account-taxonomy.js";
import type { PortfolioPresentation } from "../portfolio/portfolio-presentation.js";

/** The filter vocabulary shared by the portfolio tools (spec 2026-10-29-agent-query-surface-design.md, D1, D2, D4b). */
export const ACCOUNT_TYPES = ["tfsa", "fhsa", "rrsp", "non_registered", "crypto", "cash_account"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  tfsa: "TFSA",
  fhsa: "FHSA",
  rrsp: "RRSP",
  non_registered: "non-registered",
  crypto: "crypto",
  cash_account: "Cash",
};

/**
 * The account type a classified account answers to, or null. Only accounts in the portfolio total match, so closed
 * accounts and credit products never do, and an unrecognised type (group "other") matches no value.
 */
export function accountTypeOf(
  c: Pick<AccountClassification, "group" | "bucket" | "includedInPortfolioTotal">,
): AccountType | null {
  if (!c.includedInPortfolioTotal) return null;
  switch (c.bucket) {
    case "tfsa": return "tfsa";
    case "fhsa": return "fhsa";
    case "rrsp": return "rrsp";
    case "crypto": return "crypto";
    case "money_market": return "cash_account";
    default: return c.group === "non_registered" ? "non_registered" : null;
  }
}

export type AccountFilterInput = { accountId?: string; accountType?: AccountType };
type PortfolioAccount = PortfolioPresentation["accounts"][number];
type NamedAccount = { id: string; name: string };

export type ResolvedAccountFilter =
  | {
      ok: true;
      /** The account ids in scope; null means all accounts. */
      ids: ReadonlySet<string> | null;
      /** "in your TFSA", "in your TFSAs", "in {account name}" or "across all accounts". */
      scope: string;
      accountType?: AccountType;
      /** Set when exactly one account is in scope by accountId or accountType. */
      singleId?: string;
      /** Accounts of the type the tool cannot report on (ineligible), for the text to name. */
      excluded: NamedAccount[];
    }
  | {
      ok: false;
      code: "both_filters" | "unknown_account" | "no_accounts_of_type" | "several_accounts";
      text: string;
      /**
       * several_accounts: the eligible matches. no_accounts_of_type: the matches the tool cannot report on, when
       * accounts of the type exist but none is eligible (the text then reads as if none were connected).
       */
      matches?: NamedAccount[];
    };

export interface ResolveOptions {
  /** The accounts the tool can report on. Only these count toward the match; the rest of the matches are `excluded`. */
  eligible?: (account: PortfolioAccount) => boolean;
  /** The tool scopes exactly one account: several eligible matches is an error that lists them. */
  single?: boolean;
}

const named = (a: PortfolioAccount): NamedAccount => ({ id: a.id, name: a.name });

function typeScope(type: AccountType, count: number): string {
  const label = ACCOUNT_TYPE_LABELS[type];
  if (type === "tfsa" || type === "fhsa" || type === "rrsp") return `in your ${label}${count === 1 ? "" : "s"}`;
  return `in your ${label} ${count === 1 ? "account" : "accounts"}`;
}

export function resolveAccountFilter(
  portfolio: Pick<PortfolioPresentation, "accounts">,
  input: AccountFilterInput,
  options: ResolveOptions = {},
): ResolvedAccountFilter {
  const { accountId, accountType } = input;
  if (accountId !== undefined && accountType !== undefined) {
    return { ok: false, code: "both_filters", text: "Give accountId or accountType, not both." };
  }

  if (accountId !== undefined) {
    // An explicit accountId bypasses `eligible`: tools report their own Cash/managed scope errors.
    const found = portfolio.accounts.find((a) => a.id === accountId);
    if (!found) return { ok: false, code: "unknown_account", text: "Unknown or excluded account. Use list_portfolio_accounts to pick an account." };
    return { ok: true, ids: new Set([found.id]), scope: `in ${found.name}`, singleId: found.id, excluded: [] };
  }

  if (accountType === undefined) return { ok: true, ids: null, scope: "across all accounts", excluded: [] };

  const label = ACCOUNT_TYPE_LABELS[accountType];
  const matched = portfolio.accounts.filter((a) => accountTypeOf(a.classification) === accountType);
  const isEligible = options.eligible;
  const eligible = isEligible ? matched.filter(isEligible) : matched;
  const excluded = isEligible ? matched.filter((a) => !isEligible(a)).map(named) : [];

  if (eligible.length === 0) {
    return {
      ok: false,
      code: "no_accounts_of_type",
      text: `No connected ${label} accounts. Use list_portfolio_accounts to see what is connected.`,
      ...(excluded.length > 0 ? { matches: excluded } : {}),
    };
  }
  if (options.single && eligible.length > 1) {
    const list = eligible.map((a) => `${a.name} (${a.id})`).join(", ");
    return {
      ok: false,
      code: "several_accounts",
      text: `You have ${eligible.length} ${label} accounts: ${list}. Ask about one with accountId, or about all accounts.`,
      matches: eligible.map(named),
    };
  }
  return {
    ok: true,
    ids: new Set(eligible.map((a) => a.id)),
    scope: typeScope(accountType, eligible.length),
    accountType,
    ...(eligible.length === 1 ? { singleId: eligible[0]!.id } : {}),
    excluded,
  };
}

/** Exchange suffixes, as limit-check, exposure and portfolio-fact-tools strip them. Share classes (.A, .B) are not. */
const LISTING_SUFFIX = /\.(TO|V|NE|NEO|CN)$/;

/**
 * Whether a row's symbol is the queried one: equal ignoring case, or one side is a bare symbol and the other an
 * exchange listing of it (query XEQT matches row XEQT.TO, and query XEQT.TO matches a bare row XEQT). Two listings must
 * be equal (XEQT.NE does not match XEQT.TO), a longer symbol is another one (XEQTX does not match XEQT), and a
 * share-class suffix is another security (CTC.A does not match CTC, BRK.B does not match BRK).
 */
export function symbolMatches(rowSymbol: string, query: string): boolean {
  const row = rowSymbol.trim().toUpperCase();
  const q = query.trim().toUpperCase();
  if (q === "" || row === "") return false;
  const listedAs = (listing: string, bare: string) =>
    LISTING_SUFFIX.test(listing) && !LISTING_SUFFIX.test(bare) && listing.replace(LISTING_SUFFIX, "") === bare;
  return row === q || listedAs(row, q) || listedAs(q, row);
}

export const accountFilterShape = {
  accountId: z.string().min(1).optional(),
  accountType: z.enum(ACCOUNT_TYPES).optional(),
};

export const accountFilterProperties = {
  accountId: {
    type: "string",
    minLength: 1,
    description: "One account's id from list_portfolio_accounts.",
  },
  accountType: {
    type: "string",
    enum: [...ACCOUNT_TYPES],
    description: "All of the user's accounts of one type, e.g. tfsa for 'my TFSA'. Use instead of accountId, not with it.",
  },
} as const;

export const symbolShape = z.string().trim().min(1).max(40).optional();

export const symbolProperty = {
  type: "string",
  minLength: 1,
  maxLength: 40,
  description: "A stock or ETF symbol, e.g. XEQT; matches listings like XEQT.TO.",
} as const;
