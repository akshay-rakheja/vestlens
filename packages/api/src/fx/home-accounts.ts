import { aggregateHoldings, isInvestable } from "../analytics/holdings.js";
import type { PortfolioPresentation, PortfolioPresentationAccount } from "../portfolio/portfolio-presentation.js";
import { HOME_CURRENCY, sumHome, type HomeAmount, type HomeConverter, type HomeTotal } from "./home-currency.js";

/** Converted rows may differ from the brokerage total by this fraction before the gap note shows. */
const ROWS_DIFFER_FRACTION = 0.005;

/**
 * One included account's CAD value. Callers take an account's breakdown from `parts` and the portfolio
 * figure from `homeAccountValues(...).total`; never re-sum account `value`s through `sumHome`: a mixed-currency
 * account's `value.native` is a CAD sum, and an account with no converted part has native `{ 0, CAD }`.
 */
export interface HomeAccountValue {
  accountId: string;
  /** The account's CAD value; null when it reports no total and holds nothing. */
  value: HomeAmount | null;
  source: "reported" | "converted_reported" | "converted_positions";
  /**
   * True when the account's positions + cash, converted at the BoC rate, differ from its reported total
   * by more than 0.5%: "Rows converted at the BoC rate; the brokerage total uses its own rate."
   */
  rowsDiffer: boolean;
  /** What `value` is made of: the reported total, or one part per currency of positions + cash. */
  parts: HomeAmount[];
}

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** Positions + cash per currency (same rows as Holdings), each converted at the latest rate. */
function rowParts(account: PortfolioPresentationAccount, conv: HomeConverter): HomeAmount[] {
  return aggregateHoldings([account], {}).totals
    .map((t) => ({ currency: t.currency, amount: t.marketValue + t.cash }))
    .filter((t) => finite(t.amount))
    .map((t) => conv.at(t.amount, t.currency));
}

/** One account value from several currency parts; the breakdown stays in `parts`. */
function combine(parts: HomeAmount[]): HomeAmount | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  const total = sumHome(parts);
  const converted = parts.filter((p) => p.amount !== null);
  const rated = converted.filter((p) => p.rate !== null);
  const single = total.rateDates.length === 1 ? rated[0] : null;
  const amount = converted.length > 0 ? total.amount : null;
  return {
    amount,
    estimated: total.estimated,
    rate: single ? single.rate : null,
    rateDate: single ? single.rateDate : null,
    native: { amount: amount ?? 0, currency: HOME_CURRENCY },
  };
}

function rowsDiffer(reportedCad: number | null, rows: HomeAmount[]): boolean {
  if (reportedCad === null || reportedCad === 0 || rows.length === 0) return false;
  // Rows with an unconverted currency differ for another reason; the rate note would mislead.
  if (rows.some((r) => r.amount === null)) return false;
  const rowsCad = rows.reduce((s, r) => s + r.amount!, 0);
  return Math.abs(rowsCad - reportedCad) / Math.abs(reportedCad) > ROWS_DIFFER_FRACTION;
}

/**
 * The one source of account and portfolio CAD values for Overview, Holdings and Allocation (spec 6.1).
 * A brokerage-reported CAD total is exact; a reported USD total converts at the latest rate (est.);
 * without a reported total the account is the sum of its converted positions and cash. Only accounts
 * eligible for `portfolio.totals` (open, non-credit, included) are returned and summed. Unlike the native
 * `portfolio.totals`, which sums reported totals only, the CAD `total` also counts accounts with no reported
 * total (via converted positions), so the two can disagree by design; `includesUnreported` says when.
 */
export function homeAccountValues(
  portfolio: PortfolioPresentation, conv: HomeConverter,
): { accounts: HomeAccountValue[]; total: HomeTotal; includesUnreported: boolean } {
  const accounts: HomeAccountValue[] = [];
  const all: HomeAmount[] = [];
  for (const account of portfolio.accounts) {
    if (!isInvestable(account)) continue;
    const rows = rowParts(account, conv);
    const reported = account.value && finite(account.value.amount) ? account.value : null;
    if (reported) {
      const value = conv.at(reported.amount, reported.currency);
      const source = value.native.currency === HOME_CURRENCY ? "reported" : "converted_reported";
      accounts.push({ accountId: account.id, value, source, rowsDiffer: rowsDiffer(value.amount, rows), parts: [value] });
      all.push(value);
    } else {
      accounts.push({ accountId: account.id, value: combine(rows), source: "converted_positions", rowsDiffer: false, parts: rows });
      all.push(...rows);
    }
  }
  const includesUnreported = accounts.some((a) => a.source === "converted_positions");
  return { accounts, total: sumHome(all), includesUnreported };
}

/** The CAD value of the whole portfolio, or of one account, as Holdings and Allocation show it. */
export interface HomeScopeValue {
  total: HomeTotal;
  includesUnreported: boolean;
  /** Some account's rows, converted at the BoC rate, differ from its brokerage total. */
  rowsDiffer: boolean;
}

/**
 * `homeAccountValues` narrowed to one account id or a set of ids (all accounts when undefined or null); the
 * all-accounts total is the portfolio total.
 */
export function homeScopeValue(
  portfolio: PortfolioPresentation, conv: HomeConverter, scope?: string | ReadonlySet<string> | null,
): HomeScopeValue {
  const values = homeAccountValues(portfolio, conv);
  const ids = typeof scope === "string" ? new Set([scope]) : scope ?? null;
  const scoped = ids === null ? values.accounts : values.accounts.filter((a) => ids.has(a.accountId));
  return {
    total: ids === null ? values.total : sumHome(scoped.flatMap((a) => a.parts)),
    includesUnreported: scoped.some((a) => a.source === "converted_positions"),
    rowsDiffer: scoped.some((a) => a.rowsDiffer),
  };
}
