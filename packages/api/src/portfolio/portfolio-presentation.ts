import {
  classifyPortfolioAccount,
  isManagedPortfolio,
  type AccountClassification,
  type AccountGroup,
} from "./account-taxonomy.js";
import type { NormalizedAccountPortfolio } from "./normalize.js";
import type { PortfolioQueryResult } from "./portfolio-query-service.js";

export interface PortfolioCurrencyValue {
  currency: string;
  amount: number;
}

export interface PortfolioReportedValue extends PortfolioCurrencyValue {
  source: "brokerage_reported";
}

export interface PortfolioPresentationAccount {
  id: string;
  name: string;
  institution: string;
  rawType: string | null;
  metaType: string | null;
  unifiedType: string | null;
  status: string | null;
  isPaper: boolean;
  classification: AccountClassification;
  value: PortfolioReportedValue | null;
  balances: NormalizedAccountPortfolio["balances"];
  positions: NormalizedAccountPortfolio["positions"];
  positionCount: number;
  reconciliation: {
    calculatedByCurrency: PortfolioCurrencyValue[];
  };
  freshness: NormalizedAccountPortfolio["freshness"];
  warnings: string[];
}

export interface PortfolioPresentation {
  connectionRequired: boolean;
  relinkRequired?: true;
  generatedAt: string;
  totals: PortfolioReportedValue[];
  accounts: PortfolioPresentationAccount[];
  errors: PortfolioQueryResult["errors"];
  cache?: PortfolioQueryResult["cache"];
}

const GROUP_ORDER: Record<AccountGroup, number> = {
  registered: 0,
  non_registered: 1,
  digital_assets: 2,
  other: 3,
  credit_products: 4,
  closed: 5,
};

const BUCKET_ORDER: Record<AccountClassification["bucket"], number> = {
  tfsa: 0,
  fhsa: 1,
  rrsp: 2,
  margin: 3,
  automated_portfolio: 4,
  custom_portfolio: 5,
  predictions: 6,
  money_market: 7,
  crypto: 8,
  other: 9,
  credit_card: 10,
  line_of_credit: 11,
};

function normalizedCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

function addCurrencyValue(
  values: Map<string, number>,
  currency: string,
  amount: number,
): void {
  const code = normalizedCurrency(currency);
  values.set(code, (values.get(code) ?? 0) + amount);
}

function currencyValues(values: Map<string, number>): PortfolioCurrencyValue[] {
  return Array.from(values, ([currency, amount]) => ({ currency, amount })).sort(
    (left, right) => left.currency.localeCompare(right.currency),
  );
}

function reconciliationValues(
  calculated: Record<string, number>,
): PortfolioCurrencyValue[] {
  const values = new Map<string, number>();
  for (const [currency, amount] of Object.entries(calculated)) {
    addCurrencyValue(values, currency, amount);
  }
  return currencyValues(values);
}

function presentAccount(
  source: NormalizedAccountPortfolio,
): PortfolioPresentationAccount {
  const classification = classifyPortfolioAccount({
    unifiedType: source.account.unifiedType,
    rawType: source.account.type,
    metaType: source.account.metaType,
    status: source.account.status,
  });
  const reported = source.account.reportedTotal;
  const warnings = [...source.warnings];
  if (!reported && classification.includedInPortfolioTotal) {
    warnings.push(
      "Brokerage-reported total is unavailable; this account is excluded from portfolio totals.",
    );
  }

  return {
    id: source.account.id,
    name: source.account.name?.trim() || classification.label,
    institution: source.account.institution,
    rawType: source.account.type,
    metaType: source.account.metaType,
    unifiedType: source.account.unifiedType,
    status: source.account.status,
    isPaper: source.account.isPaper,
    classification,
    value: reported
      ? {
          amount: reported.amount,
          currency: normalizedCurrency(reported.currency),
          source: "brokerage_reported",
        }
      : null,
    balances: source.balances.map((balance) => ({
      ...balance,
      currency: normalizedCurrency(balance.currency),
    })),
    positions: source.positions.map((position) => ({
      ...position,
      currency: position.currency
        ? normalizedCurrency(position.currency)
        : null,
    })),
    positionCount: source.positions.length,
    reconciliation: {
      calculatedByCurrency: reconciliationValues(
        source.calculatedValueByCurrency,
      ),
    },
    freshness: source.freshness,
    warnings,
  };
}

function compareAccounts(
  left: PortfolioPresentationAccount,
  right: PortfolioPresentationAccount,
): number {
  return (
    GROUP_ORDER[left.classification.group] -
      GROUP_ORDER[right.classification.group] ||
    BUCKET_ORDER[left.classification.bucket] -
      BUCKET_ORDER[right.classification.bucket] ||
    left.classification.label.localeCompare(right.classification.label) ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}

const isCreditProduct = (a: { classification: { group: string; bucket: string } }) =>
  a.classification.group === "credit_products" || a.classification.bucket === "credit_card" || a.classification.bucket === "line_of_credit";

/**
 * Managed portfolios the total can't include: SnapTrade reports no value (or zero) for them, because it doesn't cover
 * Wealthsimple's managed accounts (owner, 2026-10-29: the account has money in it). Their labels, once each. A managed
 * account SnapTrade does value is in the total and not listed.
 */
export function managedNotInTotal(portfolio: Pick<PortfolioPresentation, "accounts">): string[] {
  return [...new Set(portfolio.accounts
    .filter((a) => a.classification.includedInPortfolioTotal && isManagedPortfolio(a.classification) && !(a.value && a.value.amount !== 0))
    .map((a) => a.classification.label))];
}

/** The chat line for managedNotInTotal; the dashboard and the widgets say the same. Empty when there is none. */
export function notInTotalText(portfolio: Pick<PortfolioPresentation, "accounts">): string {
  const labels = managedNotInTotal(portfolio);
  return labels.length
    ? ` Not included in the total: ${labels.join(", ")}. SnapTrade doesn't provide the value of Wealthsimple managed portfolios, so the total leaves them out; their value is in the Wealthsimple app.`
    : "";
}

export function buildPortfolioPresentation(
  result: PortfolioQueryResult,
): PortfolioPresentation {
  // Credit cards and lines of credit aren't investments and the brokerage doesn't report their balances usefully
  // (owner, 2026-10-28): they are left out of the portfolio everywhere, open or closed.
  const accounts = result.accounts.map(presentAccount).filter((a) => !isCreditProduct(a)).sort(compareAccounts);
  const totals = new Map<string, number>();

  for (const account of accounts) {
    if (account.classification.includedInPortfolioTotal && account.value) {
      addCurrencyValue(totals, account.value.currency, account.value.amount);
    }
  }

  return {
    connectionRequired: result.connectionRequired,
    ...(result.relinkRequired ? { relinkRequired: true as const } : {}),
    generatedAt: result.generatedAt,
    totals: currencyValues(totals).map((total) => ({
      ...total,
      source: "brokerage_reported" as const,
    })),
    accounts,
    errors: result.errors,
    ...(result.cache ? { cache: result.cache } : {}),
  };
}
