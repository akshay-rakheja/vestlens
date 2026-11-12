/**
 * TFSA room rules as versioned data (spec §6.2, §6.6, §9a.6). Fail-safe: anything the table does not name, and any
 * row missing its type, amount or trade date, is ambiguous and withholds the number until the user resolves it. The
 * one exception is a $0 row of a non-transfer type: no cash moved, so it cannot affect room (C5).
 * A user's resolution (keyed by activityKey) outranks the table.
 */

export const RULES_VERSION = "tfsa-v1";

export type RoomEffect = "contribution" | "withdrawal" | "none" | "ambiguous";
/** The user's answer for one activity: new money in, money taken out of their TFSAs, or a move between TFSAs. */
export type UserRoomEffect = "contribution" | "withdrawal" | "none";

/** Exact SnapTrade activity types and their effect on this year's room. */
const EXACT: Readonly<Record<string, Exclude<RoomEffect, "ambiguous">>> = {
  CONTRIBUTION: "contribution",
  DEPOSIT: "contribution", // the same event under SnapTrade's other name (activity DEPOSITS)
  // Room used by a withdrawal returns on 1 January next year, never this year.
  WITHDRAWAL: "withdrawal",
  // Paid into the account by the issuer, not by the holder: neither is a contribution (ITA 207.01(1) "contribution"
  // is an amount the holder pays in). Both appear in the 2026-10-15 probe (history/sign-rules.ts).
  REIMBURSEMENT: "none", // a fee or charge the issuer refunds
  PROMOTION: "none", // a promotional incentive the issuer pays
  BUY: "none",
  SELL: "none",
  DIVIDEND: "none",
  INTEREST: "none",
  FEE: "none",
  FUNDS_CONVERSION: "none",
  TAX: "none",
  // Non-cash events: none moves cash in from outside the TFSA, so none uses room.
  REI: "none", // a dividend reinvested in the same account: growth inside the TFSA
  STOCK_DIVIDEND: "none", // shares issued in place of cash by the issuer: growth inside the TFSA
  SPLIT: "none", // more shares, same holding: no money moves
  REVERSE_SPLIT: "none", // fewer shares, same holding: no money moves
  REORG: "none", // corporate reorganization exchanges holdings in place
  CORPORATE_ACTION: "none", // issuer-driven change to a holding, not a deposit
  MERGER: "none", // shares exchanged for the acquirer's, inside the account
  SPINOFF: "none", // new shares distributed on an existing holding, inside the account
  FXT: "none", // currency conversion between the account's own cash balances
  FX: "none", // currency conversion between the account's own cash balances
};

/** Type prefixes with no room effect. */
const NONE_PREFIXES = ["OPTIONS_"];

/**
 * Explicitly ambiguous (listed for the record; unlisted types are ambiguous too): internal cash transfers may be
 * a contribution from the user's bank or a move between their own accounts, and institution transfers use no room.
 */
export const AMBIGUOUS_TYPES = ["INTERNAL_CASH_TRANSFER_IN", "INTERNAL_CASH_TRANSFER_OUT", "TRANSFER*"] as const;

/** A transfer type (AMBIGUOUS_TYPES): the room engine pairs these with the other side of the move when it can. */
export function isTransferType(type: string | null): boolean {
  const t = typeof type === "string" ? type.trim().toUpperCase() : "";
  return t.startsWith("TRANSFER") || t.startsWith("INTERNAL_CASH_TRANSFER");
}

export interface ClassifiableRow {
  type: string | null;
  amount: number | null;
  tradeDate: string | null;
}

/**
 * The table's effect for a row, with the user's classification taking precedence. Stored activity signs cash
 * into the account positive and out negative (CONTRIBUTION > 0, WITHDRAWAL < 0), so a contribution with a
 * negative amount (a reversal or correction) or a withdrawal with a positive one is ambiguous, never counted
 * by its absolute value.
 */
export function classifyActivity(row: ClassifiableRow, userClass?: UserRoomEffect): RoomEffect {
  if (userClass === "none") return "none";
  const complete = typeof row.amount === "number" && Number.isFinite(row.amount) && typeof row.tradeDate === "string" && row.tradeDate.length > 0;
  const signed = (effect: RoomEffect): RoomEffect =>
    (effect === "contribution" && row.amount! < 0) || (effect === "withdrawal" && row.amount! > 0) ? "ambiguous" : effect;
  // The same sign guard as the table: a user's withdrawal with a positive amount (or contribution with a negative one) is ambiguous.
  if (userClass === "contribution" || userClass === "withdrawal") return complete ? signed(userClass) : "ambiguous";
  const type = typeof row.type === "string" ? row.type.trim().toUpperCase() : "";
  if (!complete || type.length === 0) return "ambiguous";
  if (isTransferType(type)) return "ambiguous";
  const exact = EXACT[type];
  if (exact) return signed(exact);
  if (NONE_PREFIXES.some((p) => type.startsWith(p))) return "none";
  // No cash moved, so no room used or returned, whatever the type (an option expiry, an unlisted event); transfer
  // types were handled above, since a $0 TRANSFER row can be shares moved in kind (C5).
  if (row.amount === 0) return "none";
  return "ambiguous";
}

/**
 * TFSA dollar limit per year, CAD, as published by the Canada Revenue Agency. Used only to explain room to the
 * user, never to compute it: the user's CRA figure for 1 January already includes them (spec §6.6).
 *
 * Sources:
 * - 2009–2025: CRA guide RC4466, "Tax-Free Savings Account (TFSA), Guide for Individuals" (TFSA dollar limit),
 *   https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/rc4466/tax-free-savings-account-tfsa-guide-individuals.html
 * - 2026: CRA, "Calculate your TFSA contribution room" ("The TFSA dollar limit for 2026 is $7,000"),
 *   https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/tax-free-savings-account/contributing/calculate-room.html
 *   (resolves the spec's §9 open question on the 2026 limit; checked 2026-10-24).
 * Add a year only once CRA publishes it.
 */
export const TFSA_ANNUAL_LIMITS: Readonly<Record<number, number>> = {
  2009: 5000, // CRA RC4466
  2010: 5000, // CRA RC4466
  2011: 5000, // CRA RC4466
  2012: 5000, // CRA RC4466
  2013: 5500, // CRA RC4466
  2014: 5500, // CRA RC4466
  2015: 10000, // CRA RC4466
  2016: 5500, // CRA RC4466
  2017: 5500, // CRA RC4466
  2018: 5500, // CRA RC4466
  2019: 6000, // CRA RC4466
  2020: 6000, // CRA RC4466
  2021: 6000, // CRA RC4466
  2022: 6000, // CRA RC4466
  2023: 6500, // CRA RC4466
  2024: 7000, // CRA RC4466
  2025: 7000, // CRA RC4466
  2026: 7000, // CRA, Calculate your TFSA contribution room
};
