// Mirrors AllocationPayload (packages/api/src/mcp/allocation-tools.ts) and the Slice, concentration and overlap
// shapes of packages/api/src/analytics/allocation.ts; the widgets package cannot import API code.
import type { HomeTotalView } from "../../kit/home-money";

export interface PortfolioSettingsView { benchmark: string; cadView: boolean; privacyDefault: boolean }

export type Dimension = "assetClass" | "currency" | "accountType" | "sector" | "region";

export interface Slice {
  key: string;
  label: string;
  /** CAD-equivalent value (USD at the Bank of Canada rate). */
  valueCad: number;
  fraction: number;
  estimated: boolean;
  holdings: Array<{ holdingKey: string; symbol: string; valueCad: number }>;
  /** Holdings left out of `holdings` to keep the payload small. */
  moreHoldings: number;
}

export interface AllocationPayload {
  dimension: Dimension;
  slices: Slice[];
  unclassifiedFraction: number;
  estimated: boolean;
  fx: { rate: number | null; date: string | null };
  /** USD holdings were left out because no exchange rate was available. */
  usdExcluded: boolean;
  /** Currencies other than CAD and USD left out (no exchange rate). */
  excludedCurrencies: string[];
  /** Positions without a reported value, left out of every figure. */
  unvalued: number;
  concentration: {
    top10: number;
    effectiveN: number;
    /** True when any counted holding was converted to CAD. */
    estimated: boolean;
    largest: { symbol: string; fraction: number } | null;
    /** Null unless the dimension is sector or region. */
    largestWithLookThrough: { symbol: string; fraction: number; estimated: true } | null;
  };
  overlap: Array<{ symbol: string; direct: number; indirect: number; combined: number; estimated: true }>;
  accounts: Array<{ id: string; label: string }>;
  /** `accountType` echoes the shared filter; `accountId` is also set when the type matched one account. */
  filters: { accountId?: string; accountType?: string };
  /** The portfolio's (or selected account's) CAD total: the same figure Overview and Holdings show. */
  home?: { total: HomeTotalView; includesUnreported: boolean; rowsDiffer: boolean; marginDebit?: { amountCad: number; estimated: boolean; netBasis: boolean } };
  settings: PortfolioSettingsView;
  asOf: string;
}
