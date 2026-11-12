type Synced = { classification: { includedInPortfolioTotal: boolean }; freshness: { holdingsLastSyncedAt: string | null } };

/**
 * How old the dashboard's values are: the oldest brokerage sync among the accounts in the total. SnapTrade syncs
 * the brokerage about once a day, so this can be hours before VestLens read SnapTrade (`generatedAt`).
 */
export function pricesAsOf(accounts: readonly Synced[]): string | null {
  return accounts
    .filter((a) => a.classification.includedInPortfolioTotal)
    .map((a) => a.freshness.holdingsLastSyncedAt)
    .filter((v): v is string => !!v)
    .sort()[0] ?? null;
}
