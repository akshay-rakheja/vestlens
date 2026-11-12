export type AccountGroup =
  | "registered"
  | "non_registered"
  | "digital_assets"
  | "credit_products"
  | "closed"
  | "other";

export type AccountBucket =
  | "tfsa"
  | "fhsa"
  | "rrsp"
  | "margin"
  | "automated_portfolio"
  | "custom_portfolio"
  | "predictions"
  | "money_market"
  | "crypto"
  | "credit_card"
  | "line_of_credit"
  | "other";

export interface AccountTaxonomyInput {
  unifiedType: string | null;
  rawType: string | null;
  metaType: string | null;
  status: string | null;
}

export interface AccountClassification {
  group: AccountGroup;
  groupLabel: string;
  bucket: AccountBucket;
  bucketLabel: string;
  label: string;
  includedInPortfolioTotal: boolean;
  isClosed: boolean;
}

/**
 * Whether an account counts toward returns, deposits and market gain (spec 2026-10-29-investment-scope-and-deposits-design.md):
 * in the total, not a Cash / money market account and not a managed portfolio. Wealthsimple Cash is where pay lands and
 * spending leaves, so moving money from it into an investment account is money put in, not an internal transfer.
 * Managed portfolios are left out because SnapTrade does not provide their holdings history (spec
 * 2026-10-29-incomplete-history): money moved from one into a counted account is put in, as from Cash. Totals include
 * Cash; a managed portfolio is in the total only when SnapTrade reports a value for it, otherwise the total leaves it
 * out and the text names it (managedNotInTotal in portfolio-presentation.ts).
 */
export function countsTowardReturns(classification: Pick<AccountClassification, "includedInPortfolioTotal" | "bucket" | "label">): boolean {
  return classification.includedInPortfolioTotal && !isCashAccount(classification) && !isManagedPortfolio(classification);
}

/** A Cash / money market account: where pay lands and spending leaves. */
export function isCashAccount(classification: Pick<AccountClassification, "bucket">): boolean {
  return classification.bucket === "money_market";
}

/** A Wealthsimple managed portfolio (any MANAGED_* product): SnapTrade does not provide its holdings history. */
export function isManagedPortfolio(classification: Pick<AccountClassification, "label">): boolean {
  return MANAGED_LABELS.has(classification.label);
}

type ActiveClassification = Omit<
  AccountClassification,
  "groupLabel" | "isClosed"
>;

const GROUP_LABELS: Record<AccountGroup, string> = {
  registered: "Registered",
  non_registered: "Non-registered",
  digital_assets: "Digital assets",
  credit_products: "Credit products",
  closed: "Closed accounts",
  other: "Other accounts",
};

const PRODUCTS: Record<string, ActiveClassification> = {
  SELF_DIRECTED_TFSA: {
    group: "registered",
    bucket: "tfsa",
    bucketLabel: "TFSA",
    label: "Self-directed TFSA",
    includedInPortfolioTotal: true,
  },
  MANAGED_TFSA: {
    group: "registered",
    bucket: "tfsa",
    bucketLabel: "TFSA",
    label: "Managed TFSA",
    includedInPortfolioTotal: true,
  },
  MANAGED_PORTFOLIO_TFSA: {
    group: "registered",
    bucket: "tfsa",
    bucketLabel: "TFSA",
    label: "Managed TFSA",
    includedInPortfolioTotal: true,
  },
  SELF_DIRECTED_FHSA: {
    group: "registered",
    bucket: "fhsa",
    bucketLabel: "FHSA",
    label: "Self-directed FHSA",
    includedInPortfolioTotal: true,
  },
  MANAGED_FHSA: {
    group: "registered",
    bucket: "fhsa",
    bucketLabel: "FHSA",
    label: "Managed FHSA",
    includedInPortfolioTotal: true,
  },
  MANAGED_PORTFOLIO_FHSA: {
    group: "registered",
    bucket: "fhsa",
    bucketLabel: "FHSA",
    label: "Managed FHSA",
    includedInPortfolioTotal: true,
  },
  SELF_DIRECTED_RRSP: {
    group: "registered",
    bucket: "rrsp",
    bucketLabel: "RRSP",
    label: "Self-directed RRSP",
    includedInPortfolioTotal: true,
  },
  MANAGED_RRSP: {
    group: "registered",
    bucket: "rrsp",
    bucketLabel: "RRSP",
    label: "Managed RRSP",
    includedInPortfolioTotal: true,
  },
  MANAGED_PORTFOLIO_RRSP: {
    group: "registered",
    bucket: "rrsp",
    bucketLabel: "RRSP",
    label: "Managed RRSP",
    includedInPortfolioTotal: true,
  },
  SELF_DIRECTED_NON_REGISTERED_MARGIN: {
    group: "non_registered",
    bucket: "margin",
    bucketLabel: "Margin",
    label: "Margin account",
    includedInPortfolioTotal: true,
  },
  MANAGED_PORTFOLIO_NON_REGISTERED: {
    group: "non_registered",
    bucket: "automated_portfolio",
    bucketLabel: "Automated portfolio",
    label: "Automated portfolio",
    includedInPortfolioTotal: true,
  },
  CUSTOM_PORTFOLIO_NON_REGISTERED: {
    group: "non_registered",
    bucket: "custom_portfolio",
    bucketLabel: "Custom portfolio",
    label: "Custom portfolio",
    includedInPortfolioTotal: true,
  },
  SELF_DIRECTED_NON_REGISTERED_PREDICTIONS: {
    group: "non_registered",
    bucket: "predictions",
    bucketLabel: "Predictions",
    label: "Predictions",
    includedInPortfolioTotal: true,
  },
  CASH: {
    group: "non_registered",
    bucket: "money_market",
    bucketLabel: "Cash / money market",
    label: "Cash / money market (CAD)",
    includedInPortfolioTotal: true,
  },
  CASH_USD: {
    group: "non_registered",
    bucket: "money_market",
    bucketLabel: "Cash / money market",
    label: "Cash / money market (USD)",
    includedInPortfolioTotal: true,
  },
  SELF_DIRECTED_CRYPTO: {
    group: "digital_assets",
    bucket: "crypto",
    bucketLabel: "Crypto",
    label: "Crypto",
    includedInPortfolioTotal: true,
  },
  CREDIT_CARD: {
    group: "credit_products",
    bucket: "credit_card",
    bucketLabel: "Credit card",
    label: "Credit card",
    includedInPortfolioTotal: false,
  },
  PORTFOLIO_LINE_OF_CREDIT: {
    group: "credit_products",
    bucket: "line_of_credit",
    bucketLabel: "Line of credit",
    label: "Portfolio line of credit",
    includedInPortfolioTotal: false,
  },
};

/** Labels of the managed products (labels are unique to them: no self-directed product shares one). */
const MANAGED_LABELS: ReadonlySet<string> = new Set(
  Object.entries(PRODUCTS).filter(([key]) => key.startsWith("MANAGED_")).map(([, product]) => product.label),
);

function normalized(value: string | null): string {
  return value?.trim().toUpperCase() ?? "";
}

function fallbackClassification(
  input: AccountTaxonomyInput,
): ActiveClassification {
  const rawType = normalized(input.rawType);
  const metaType = normalized(input.metaType);

  if (rawType === "TFSA" || metaType === "TFSA") {
    return {
      group: "registered",
      bucket: "tfsa",
      bucketLabel: "TFSA",
      label: "TFSA",
      includedInPortfolioTotal: true,
    };
  }
  if (rawType === "FHSA" || metaType === "FHSA") {
    return {
      group: "registered",
      bucket: "fhsa",
      bucketLabel: "FHSA",
      label: "FHSA",
      includedInPortfolioTotal: true,
    };
  }
  if (rawType === "RRSP" || metaType === "RRSP") {
    return {
      group: "registered",
      bucket: "rrsp",
      bucketLabel: "RRSP",
      label: "RRSP",
      includedInPortfolioTotal: true,
    };
  }
  if (rawType === "MSB" || metaType === "CA_CASH_MSB") {
    return {
      group: "non_registered",
      bucket: "money_market",
      bucketLabel: "Cash / money market",
      label: "Cash / money market",
      includedInPortfolioTotal: true,
    };
  }
  if (rawType === "CRYPTO" || metaType === "NON_REGISTERED_CRYPTO") {
    return {
      group: "digital_assets",
      bucket: "crypto",
      bucketLabel: "Crypto",
      label: "Crypto",
      includedInPortfolioTotal: true,
    };
  }
  if (rawType === "CARD" || metaType === "CA_CREDIT_CARD") {
    return {
      group: "credit_products",
      bucket: "credit_card",
      bucketLabel: "Credit card",
      label: "Credit card",
      includedInPortfolioTotal: false,
    };
  }
  if (rawType === "PERSONAL" || metaType === "NON_REGISTERED") {
    return {
      group: "non_registered",
      bucket: "other",
      bucketLabel: "Other",
      label: "Non-registered account",
      includedInPortfolioTotal: true,
    };
  }
  return {
    group: "other",
    bucket: "other",
    bucketLabel: "Other",
    label: "Other account",
    includedInPortfolioTotal: true,
  };
}

export function classifyPortfolioAccount(
  input: AccountTaxonomyInput,
): AccountClassification {
  const product =
    PRODUCTS[normalized(input.unifiedType)] ?? fallbackClassification(input);
  const isClosed = normalized(input.status) === "CLOSED";
  const group = isClosed ? "closed" : product.group;

  return {
    ...product,
    group,
    groupLabel: GROUP_LABELS[group],
    includedInPortfolioTotal:
      !isClosed && product.includedInPortfolioTotal,
    isClosed,
  };
}
