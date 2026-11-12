const HISTORY_CHANGE_EVENTS = new Set([
  "ACCOUNT_TRANSACTIONS_INITIAL_UPDATE",
  "ACCOUNT_TRANSACTIONS_UPDATED",
  "ACCOUNT_HOLDINGS_UPDATED",
  "NEW_ACCOUNT_AVAILABLE",
  "CONNECTION_ADDED",
  "CONNECTION_FIXED",
]);

/** True for SnapTrade webhook event types that imply activity or holdings changed. */
export function isHistoryChangeEvent(eventType: string): boolean {
  if (typeof eventType !== "string") return false;
  return HISTORY_CHANGE_EVENTS.has(eventType.toUpperCase());
}
