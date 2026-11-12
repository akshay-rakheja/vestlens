// Mirrors ACCOUNT_TYPES and ACCOUNT_TYPE_LABELS in packages/api/src/mcp/query-filters.ts (spec 2026-10-29 D3, D4);
// the widgets package cannot import API code.
export const ACCOUNT_TYPE_LABELS = {
  tfsa: "TFSA",
  fhsa: "FHSA",
  rrsp: "RRSP",
  non_registered: "non-registered",
  crypto: "crypto",
  cash_account: "Cash",
} as const;

export type AccountType = keyof typeof ACCOUNT_TYPE_LABELS;

/** The picker's option value while an account-type chip is active; never sent to a tool. */
export const ACCOUNT_TYPE_OPTION = "__accountType";

/** One of the six values, else null: an unknown or missing echo is ignored, so the payload renders as before. */
export function knownAccountType(value: unknown): AccountType | null {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ACCOUNT_TYPE_LABELS, value) ? (value as AccountType) : null;
}

/** Chip and picker text: "TFSA accounts", "Cash accounts", "non-registered accounts". */
export function accountTypeChip(type: AccountType): string {
  return `${ACCOUNT_TYPE_LABELS[type]} accounts`;
}

/** The value tile's label while a type that matched several accounts is in scope: "TFSA accounts value". */
export function accountTypeValueLabel(type: AccountType): string {
  return `${ACCOUNT_TYPE_LABELS[type]} accounts value`;
}

/** "Account value" for one account, "{label} accounts value" for a type of several, else "Total value". */
export function scopeValueLabel(filters: { accountId?: string; accountType?: unknown }): string {
  if (filters.accountId) return "Account value";
  const type = knownAccountType(filters.accountType);
  return type ? accountTypeValueLabel(type) : "Total value";
}
