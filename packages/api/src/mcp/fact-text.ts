import { formatPct } from "../limits/limit-check.js";
import { MAX_TEXT_LENGTH, collapseWhitespace } from "../memory/memory-types.js";
import { dollars } from "./portfolio-fact-tools.js";
import { oneLineUserText } from "./user-text.js";

/**
 * The stored text of a thesis, limit or goal, one builder per property. The tools (assistant saves) and the typed
 * dashboard edit routes both use these, so an entry's text can never disagree with its value.
 */

/** "Thesis on SHOP.TO: <reasons>", whitespace collapsed and cut to the memory text limit. */
export function thesisFactText(ticker: string, reasons: string): string {
  const summary = collapseWhitespace(`Thesis on ${ticker}: ${reasons}`);
  return summary.length > MAX_TEXT_LENGTH ? `${summary.slice(0, MAX_TEXT_LENGTH - 1).trimEnd()}…` : summary;
}

/** "Limit: no more than 10% in SHOP.TO." (label as limitLabel gives it). */
export const limitFactText = (maxPct: number, label: string): string => `Limit: no more than ${formatPct(maxPct)}% in ${oneLineUserText(label)}.`;

/** "Goal: House, $50,000 by 2028-06-30." (the name one line, control and format characters removed); "an amount" when the target is not a number (a rejected save). */
export const goalFactText = (name: string, targetCad: unknown, targetDate: unknown): string =>
  `Goal: ${oneLineUserText(name)}, ${typeof targetCad === "number" ? dollars(targetCad) : "an amount"} by ${String(targetDate)}.`;
