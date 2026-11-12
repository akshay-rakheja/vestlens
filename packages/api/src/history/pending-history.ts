import { OWNER_SUBJECT } from "../identity/owner-identity.js";

/**
 * Who the history catch-up should read now: people who linked recently and whose first
 * activity read hasn't finished, so their chart, returns and TFSA room fill in minutes after linking instead of at the
 * next weekday's nightly run. Bounded so a stuck account can't make the 10-minute sweep re-read SnapTrade forever:
 *   - only accounts (or, before any account is stored, connections) created in the last NEW_LINK_WINDOW_MS;
 *   - an account whose last attempt failed or stopped short is retried at most once per RETRY_AFTER_MS.
 * Stored data only; counts never identities in logs.
 */
export const NEW_LINK_WINDOW_MS = 7 * 86_400_000;
export const RETRY_AFTER_MS = 3_600_000;

type Since = { gte: Date };
export interface PendingHistoryPort {
  appUser: {
    findMany(input: {
      where: { authSubject: string; brokerageConnections: { some: { disabled: false } } };
      select: {
        id: true;
        authSubject: true;
        brokerageAccounts: { where: { createdAt: Since }; select: { snapTradeAccountId: true } };
        brokerageConnections: { where: { createdAt: Since; disabled: false }; select: { createdAt: true } };
        activitySyncStates: { select: { snapTradeAccountId: true; backfillCompletedAt: true; lastSyncedAt: true } };
        _count: { select: { brokerageAccounts: true } };
      };
    }): Promise<Array<{
      id: string;
      authSubject: string;
      brokerageAccounts: Array<{ snapTradeAccountId: string }>;
      brokerageConnections: Array<{ createdAt: Date }>;
      activitySyncStates: Array<{ snapTradeAccountId: string; backfillCompletedAt: Date | null; lastSyncedAt: Date | null }>;
      _count: { brokerageAccounts: number };
    }>>;
  };
}

export async function findPendingHistoryUsers(prisma: PendingHistoryPort, now: Date): Promise<Array<{ id: string; authSubject: string }>> {
  const since = { gte: new Date(now.getTime() - NEW_LINK_WINDOW_MS) };
  const users = await prisma.appUser.findMany({
    where: { authSubject: OWNER_SUBJECT, brokerageConnections: { some: { disabled: false } } },
    select: {
      id: true,
      authSubject: true,
      brokerageAccounts: { where: { createdAt: since }, select: { snapTradeAccountId: true } },
      brokerageConnections: { where: { createdAt: since, disabled: false }, select: { createdAt: true } },
      activitySyncStates: { select: { snapTradeAccountId: true, backfillCompletedAt: true, lastSyncedAt: true } },
      _count: { select: { brokerageAccounts: true } },
    },
  });
  const retryBefore = now.getTime() - RETRY_AFTER_MS;
  return users
    .filter((user) => {
      // Linked, but no account stored yet (nobody has opened the portfolio): the sync lists accounts itself.
      if (user._count.brokerageAccounts === 0) return user.brokerageConnections.length > 0;
      const states = new Map(user.activitySyncStates.map((s) => [s.snapTradeAccountId, s]));
      return user.brokerageAccounts.some(({ snapTradeAccountId }) => {
        const state = states.get(snapTradeAccountId);
        if (!state) return true;
        if (state.backfillCompletedAt) return false;
        return !state.lastSyncedAt || state.lastSyncedAt.getTime() <= retryBefore;
      });
    })
    .map(({ id, authSubject }) => ({ id, authSubject }));
}
