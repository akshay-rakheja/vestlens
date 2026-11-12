/*
 * Activity sign conventions: the sign SnapTrade reports for `amount` and `units`
 * on each activity type, and the multipliers that turn them into cash and
 * position changes for the account.
 *
 *   type                        amount        units     cashSign  unitsSign
 *   BUY                         neg           pos          1      1 (abs+)
 *   SELL                        pos           neg          1      abs-
 *   CONTRIBUTION                pos           zero         1      -
 *   DIVIDEND                    pos           zero         1      -
 *   INTEREST                    pos           zero         1      -
 *   REIMBURSEMENT               pos           zero         1      -
 *   PROMOTION                   pos           zero         1      -
 *   INTERNAL_CASH_TRANSFER_IN   pos           zero         1      -
 *   WITHDRAWAL                  neg           zero         1      -   (already negative)
 *   FEE                         neg           zero         1      -   (already negative)
 *   TAX                         neg           zero         1      -   (already negative)
 *   INTERNAL_CASH_TRANSFER_OUT  neg           zero         1      -   (already negative)
 *   SPEND                       pos           zero        -1      -   (positive outflow)
 *   CREDIT_CARD_PAYMENT         pos           zero        -1      -   (positive outflow)
 *   FUNDS_CONVERSION            pos           zero         1      -   (only the credited leg is reported; the counterpart debit is applied during valuation at the BoC rate)
 *   TRANSFER                    zero          pos          1      1   (units as reported)
 *   CORPORATE_ACTION            pos or zero   zero         1      1   (units as reported)
 *   OPTIONS_MULTILEG            pos           zero         1      -
 *   OPTIONS_SHORT_EXPIRY        zero          pos          1      -
 *   OPTIONEXPIRATION            zero          pos          1      -
 *   PORTFOLIO_INVESTMENT        pos           zero         1      -
 *   PORTFOLIO_REBALANCING       pos           zero         1      -
 *   FUNDS_INVESTED              pos           zero         1      -
 *   CREDIT_CARD                 pos           zero         0      -   (not an investment cash flow)
 *   REINVEST                    (not seen)                 1      abs+ (DRIP: adds shares, cash as reported)
 *
 * Unknown types apply `amount` as reported (sign 1) and have no position effect.
 */
export type Sign = 1 | -1;
export interface SignRules {
  /** Multiplier applied to `amount` to get the cash change for the account (in `currency`). */
  cashSign: Record<string, Sign | 0>;
  /** Multiplier applied to `units` to get the position change; absent = no position effect. */
  unitsSign: Record<string, Sign | "abs+" | "abs-">;
}

export const SIGN_RULES: SignRules = {
  cashSign: {
    BUY: 1,
    SELL: 1,
    CONTRIBUTION: 1,
    DIVIDEND: 1,
    INTEREST: 1,
    REIMBURSEMENT: 1,
    PROMOTION: 1,
    INTERNAL_CASH_TRANSFER_IN: 1,
    WITHDRAWAL: 1,
    FEE: 1,
    TAX: 1,
    INTERNAL_CASH_TRANSFER_OUT: 1,
    SPEND: -1,
    CREDIT_CARD_PAYMENT: -1,
    FUNDS_CONVERSION: 1,
    TRANSFER: 1,
    CORPORATE_ACTION: 1,
    OPTIONS_MULTILEG: 1,
    OPTIONS_SHORT_EXPIRY: 1,
    OPTIONEXPIRATION: 1,
    PORTFOLIO_INVESTMENT: 1,
    PORTFOLIO_REBALANCING: 1,
    FUNDS_INVESTED: 1,
    CREDIT_CARD: 0,
  },
  unitsSign: {
    BUY: "abs+",
    SELL: "abs-",
    REINVEST: "abs+",
    TRANSFER: 1,
    CORPORATE_ACTION: 1,
  },
};

const DEFAULT_CASH_SIGN: Sign = 1;

export function cashDelta(type: string, amount: number | null): number {
  if (amount === null || !Number.isFinite(amount)) return 0;
  const sign = SIGN_RULES.cashSign[type.toUpperCase()] ?? DEFAULT_CASH_SIGN;
  return sign * amount;
}

export function unitsDelta(type: string, units: number | null): number {
  if (units === null || !Number.isFinite(units)) return 0;
  const rule = SIGN_RULES.unitsSign[type.toUpperCase()];
  if (rule === undefined) return 0;
  if (rule === "abs+") return Math.abs(units);
  if (rule === "abs-") return -Math.abs(units);
  return rule * units;
}
