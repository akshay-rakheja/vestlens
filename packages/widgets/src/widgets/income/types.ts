// Mirrors IncomePayload (packages/api/src/mcp/income-tools.ts) and the shapes of packages/api/src/analytics/income.ts;
// the widgets package cannot import API code.
import type { HomeTotalView } from "../../kit/home-money";

export interface PortfolioSettingsView { benchmark: string; cadView: boolean; privacyDefault: boolean }

export interface IncomeMonth {
  month: string; // YYYY-MM
  currency: string;
  byAccount: Record<string, number>;
  /** Top 10 payers by net; dividends without a symbol are grouped as "Other". */
  payers: Array<{ symbol: string; net: number }>;
  net: number; gross: number;
  /** Positive magnitude. */
  withholding: number;
  interest: number;
}

/** CAD view of the year (mirrors IncomeHome in income-tools.ts): USD amounts converted at the BoC rate on their pay date. */
export interface IncomeHome {
  tiles: { net: HomeTotalView; gross: HomeTotalView; withholding: HomeTotalView; interest: HomeTotalView; forward12m: HomeTotalView };
  /** Every amount in CAD. */
  months: IncomeMonth[];
  topPayers: Array<{ symbol: string; net: number; estimated: boolean; yieldOnCost: number | null }>;
  forwardCoverage: { payers: number; covered: number };
  /** Native percents: present only when income is in a single currency. */
  yields: { yieldOnCost: number | null; currentYield: number | null } | null;
}

export interface ForwardUncovered { symbol: string; account: string; reason: string }

export interface IncomePayload {
  year: number;
  /** Distinct years that have a dividend or interest row, ascending. */
  years: number[];
  currencyTotals: Array<{
    currency: string; net: number; gross: number; withholding: number; interest: number; forward12m: number;
    /** Withholding rows in the year matching no dividend: not netted (as in Activity). `amount` is the positive magnitude. */
    unmatchedWithholding: { count: number; amount: number };
    /** Holdings, one per account, with trailing payments or market distributions and current units, and those the forward estimate could be made for. */
    forwardCoverage: { payers: number; covered: number };
    /** The holdings it leaves out and why. Older payloads omit it. */
    forwardUncovered?: ForwardUncovered[];
    /** Holdings left out of the yields because a yield can't be told for them. */
    yieldsLeftOut?: number;
    /** Holdings whose yield uses dividends paid in another currency, converted at the BoC rate on each pay date (est.). */
    yieldsConverted?: number;
    /** Trailing 12 months of net dividends over book cost / market value (estimates; null without values). */
    yieldOnCost: number | null; currentYield: number | null;
  }>;
  months: IncomeMonth[];
  topPayers: Array<{ symbol: string; currency: string; net: number; yieldOnCost: number | null }>;
  yields: Array<{ symbol: string; currency: string; yieldOnCost: number | null; currentYield: number | null; estimated: true }>;
  withholding: Array<{ accountType: string; currency: string; gross: number; withholding: number; rate: number | null }>;
  /** Deposits (contributions and incoming transfers) in the year, per account type and currency. */
  contributions: Array<{ accountType: string; currency: string; amount: number }>;
  accounts: Array<{ id: string; label: string }>;
  syncing: string[];
  /** `accountType` and `symbol` (uppercased) echo the shared filter; `accountId` is also set when the type matched one account. */
  filters: { accountId?: string; accountType?: string; symbol?: string };
  settings: PortfolioSettingsView;
  asOf: string;
  /** Present only while the CAD view is on. */
  home?: IncomeHome;
}
