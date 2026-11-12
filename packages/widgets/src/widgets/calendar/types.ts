import type { HomeAmountView, HomeTotalView } from "../../kit/home-money";

// Mirrors CalendarPayload (packages/api/src/mcp/calendar-tools.ts); the widgets package cannot import API code.
export interface PortfolioSettingsView { benchmark: string; cadView: boolean; privacyDefault: boolean }
export type CalendarRange = "2w" | "1m" | "3m";
export type MoodLevel = "strongly_negative" | "negative" | "neutral" | "positive" | "strongly_positive";

export interface CalendarEventView {
  id: string;
  symbol: string;
  kind: "earnings" | "dividend_pay";
  /** YYYY-MM-DD. */
  date: string;
  status: "confirmed" | "expected";
  /** True when the date is projected. */
  estimated: boolean;
  /** Dividends: last payment per unit × units held now (an estimate), native currency. */
  amount: {
    perUnit: number; units: number; total: number; currency: string;
    /** CAD view: the total in CAD at the latest BoC rate (est. for USD); `native` keeps the original total. */
    home?: HomeAmountView;
  } | null;
  /** Past earnings: top earnings article since the day before, with its AI-rated mood. */
  outcome: { headline: string; source: string; mood: MoodLevel } | null;
}

export interface CalendarPayload {
  range: CalendarRange;
  asOf: string;
  /** Monday-start weeks that have events, ascending. */
  weeks: Array<{ weekStart: string; events: CalendarEventView[] }>;
  thisWeek: { earnings: number; dividends: number };
  accounts: Array<{ id: string; label: string }>;
  filters: { range: CalendarRange; accountId?: string };
  settings: PortfolioSettingsView;
  /** CAD view: the projected dividends in the listed weeks, summed in CAD. */
  home?: { dividends: HomeTotalView };
}
