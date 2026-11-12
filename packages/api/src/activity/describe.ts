import type { StoredActivity } from "../history/stored-activity.js";

function titleCase(type: string): string {
  return type
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * A short, value-free label for a row. Units and prices are never part of it: the row carries
 * them in their own fields, so the widget can hide them in privacy mode (final review I4).
 */
export function describe(a: StoredActivity): { text: string; estimated: boolean } {
  const type = a.type.toUpperCase();
  const sym = a.symbol;
  const withSym = (label: string) => (sym ? `${label} ${sym}` : label);
  let estimated = (type === "BUY" || type === "SELL") && a.price === null;
  if (a.amount !== null && a.currency === null) estimated = true;

  let text: string;
  switch (type) {
    case "BUY":
    case "SELL": {
      text = withSym(type === "BUY" ? "Bought" : "Sold");
      break;
    }
    case "DIVIDEND": text = withSym("Dividend"); break;
    case "DISTRIBUTION": text = withSym("Distribution"); break;
    case "REI":
    case "REINVEST": text = withSym("Reinvested dividend"); break;
    case "INTEREST": text = "Interest"; break;
    case "FEE": text = "Fee"; break;
    case "TAX":
    case "WITHHOLDING": text = withSym("Withholding tax"); break;
    case "CONTRIBUTION":
    case "DEPOSIT": text = "Deposit"; break;
    case "WITHDRAWAL": text = "Withdrawal"; break;
    case "INTERNAL_CASH_TRANSFER_IN": text = "Transfer in"; break;
    case "INTERNAL_CASH_TRANSFER_OUT": text = "Transfer out"; break;
    case "FUNDS_CONVERSION": text = "Currency conversion"; break;
    case "TRANSFER":
      if (sym) {
        const dir = a.units === null ? "Transferred" : a.units < 0 ? "Transferred out" : "Transferred in";
        text = `${dir} ${sym}`;
      } else {
        text = "Transfer";
      }
      break;
    case "SPLIT":
    case "CORPORATE_ACTION": text = withSym("Corporate action"); break;
    case "SPEND": text = "Card spending"; break;
    case "CREDIT_CARD_PAYMENT": text = "Card payment"; break;
    case "REIMBURSEMENT": text = "Refund"; break;
    default: text = withSym(titleCase(type) || "Activity");
  }
  return { text, estimated };
}
