// Mirrors HoldingsPayload (packages/api/src/mcp/holdings-tools.ts), HoldingRow and HoldingsTotals
// (packages/api/src/analytics/holdings.ts); the widgets package cannot import API code.
import type { HomeAmountView, HomeTotalView } from "../../kit/home-money";

export interface PortfolioSettingsView { benchmark: string; cadView: boolean; privacyDefault: boolean }

export interface HoldingRow {
  /** `SYMBOL|CURRENCY`: the same symbol in two currencies is two rows, never summed. */
  key: string;
  symbol: string;
  currency: string;
  kind: string;
  units: number;
  price: number | null;
  marketValue: number | null;
  /** Σ units × costBasis; null when any contributing position lacks a cost basis. */
  bookCost: number | null;
  totalReturn: number | null;
  totalReturnFraction: number | null;
  /** Share of the known market value of the same currency; null when this row's value is unknown. */
  weight: number | null;
  /** Share of the CAD-equivalent value of all rows (USD at the Bank of Canada rate); null without a rate. */
  weightCad: number | null;
  dayChange: { amount: number | null; fraction: number | null; estimated: true; sessionDate?: string } | null;
  /** Empty when trimmed to keep the payload small. */
  accounts: Array<{ accountId: string; label: string; units: number; marketValue: number | null; bookCost: number | null; totalReturn: number | null }>;
  /** USD rows only, when converted: value, gain and day change in CAD (est.), with the original amounts. */
  cad?: { value: HomeAmountView; totalReturn: HomeAmountView | null; dayChange: HomeAmountView | null };
}

export interface HoldingsTotals {
  currency: string;
  marketValue: number;
  bookCost: number | null;
  totalReturn: number | null;
  totalReturnFraction: number | null;
  /** Rows that have a book cost. */
  withCostBasis: number;
  holdings: number;
  cash: number;
}

export type HoldingsSort = "weight" | "value" | "return" | "returnPct" | "today" | "symbol";

export interface HoldingsPayload {
  rows: HoldingRow[];
  totals: HoldingsTotals[];
  accounts: Array<{ id: string; label: string }>;
  currencies: string[];
  /** Smallest rows left out to keep the payload under 60 KB; totals still cover them. */
  omitted: number;
  /** `accountType` and `symbol` (uppercased) echo the shared filter; `accountId` is also set when the type matched one account. */
  filters: { accountId?: string; accountType?: string; symbol?: string; currency?: string; sort: string };
  /** Latest Bank of Canada USD/CAD used for `weightCad`; both null when unavailable. */
  fx: { rate: number | null; date: string | null };
  /** Selected account (or all included accounts), ignoring the currency filter; "reported" is the brokerage's own total. */
  accountValue: AccountValue[];
  /** CAD figures on the shared converter; the same total Overview and Allocation show. */
  home?: HoldingsHome;
  settings: PortfolioSettingsView;
  asOf: string;
  /** The oldest brokerage sync among the accounts shown (SnapTrade, about once a day); null when unknown. */
  pricesAsOf?: string | null;
}

export interface AccountValue { currency: string; amount: number; source: "reported" | "estimated" }

export interface HoldingsHome {
  total: HomeTotalView;
  includesUnreported: boolean;
  /** Rows converted at the BoC rate differ from the brokerage total. */
  rowsDiffer: boolean;
  tiles: { value: HomeTotalView; bookCost: HomeTotalView | null; totalReturn: HomeTotalView | null; totalReturnFraction: number | null; complete: boolean };
}
