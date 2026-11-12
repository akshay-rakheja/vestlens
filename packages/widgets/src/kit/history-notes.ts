export const REASON_PHRASES: Record<string, string> = {
  no_activity: "no activity history found",
  portfolio_rebalancing: "automatic rebalancing is not rebuilt",
  missing_units: "some activity is missing share counts",
  missing_currency: "some activity is missing its currency",
  error: "history could not be rebuilt",
  holdings_mismatch: "rebuilt holdings differ from reported",
  drift: "rebuilt value differs from reported",
  drift_too_large: "rebuilt history didn't match the brokerage, so only snapshots are shown",
  opening_cash: "includes an estimated starting cash balance from before your activity history",
};
export const reasonPhrase = (reason: string | null) => (reason && REASON_PHRASES[reason]) || "history from snapshots only";

/** Rounded drift as a whole percentage (a fraction only, never a value); null below 1%. */
export const driftPhrase = (fraction: number | null) => {
  if (fraction === null || !Number.isFinite(fraction)) return null;
  const pct = Math.round(Math.abs(fraction) * 100);
  return pct >= 1 ? `differs from reported by about ${pct}%` : null;
};

export interface HistoryQuality { accountId: string; method: string; reason: string | null; driftFraction: number | null }

export interface HistoryNotesInput {
  qualities: HistoryQuality[];
  earliest: string | null;
  accounts: Array<{ id: string; label?: string }>;
  points: Array<{ source: string }>;
  currentYear: string;
}

/** Quality notes use account-type labels and short reasons only; never values. */
export function historyNotes(input: HistoryNotesInput) {
  const { qualities, earliest, points, currentYear } = input;
  const labels = new Map(input.accounts.map((a) => [a.id, a.label] as const));
  const rebuilt = qualities.some((q) => q.method === "reconstructed");
  const snapshotsOnly = qualities.some((q) => q.method === "snapshots_only");
  const estimatedAccounts = qualities.filter((q) => q.method === "reconstructed" && q.reason !== null);
  // Point-level estimates (stale closes or FX) also count, even when no account is flagged.
  const estimated = estimatedAccounts.length > 0 || points.some((p) => p.source === "estimated");
  const limited = qualities.filter((q) => q.method === "snapshots_only" || (q.method === "reconstructed" && q.reason !== null));
  const estimatedDetail = (q: HistoryQuality) => {
    const pct = driftPhrase(q.driftFraction);
    return q.reason === "drift" && pct ? `estimated, rebuilt value ${pct}` : `estimated, ${reasonPhrase(q.reason)}`;
  };
  const details = limited.map((q) => `${labels.get(q.accountId) ?? "Account"}: ${q.method === "snapshots_only" ? reasonPhrase(q.reason) : estimatedDetail(q)}`).join("; ");
  const maxDrift = estimatedAccounts.reduce<number | null>((m, q) => (q.driftFraction === null ? m : Math.max(m ?? 0, Math.abs(q.driftFraction))), null);
  return { earliest: rebuilt && earliest ? earliest : null, details, limited: limited.length > 0, snapshotsOnly, estimated, drift: driftPhrase(maxDrift), currentYear };
}

/** While a just-linked account's first history read runs (the server's 10-minute catch-up). Keep in step with HISTORY_BUILDING_TEXT in packages/api. */
export const HISTORY_BUILDING = "Building your history from Wealthsimple. This usually takes about 10 minutes after you link.";
