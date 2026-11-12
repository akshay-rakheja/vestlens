/**
 * Database side of the data controls: per-connection purge, the pending-disconnect markers and
 * the retention sweep. Every user-scoped query is filtered by appUserId (the read filter, by the owner).
 */

import { ALL_CLIENTS } from "../gateway/store.js";
import { OWNER_SUBJECT } from "../identity/owner-identity.js";

type Count = Promise<{ count: number }>;
type AccountScope = { appUserId: string; snapTradeAccountId: { in: string[] } };

/** Delegates used inside a transaction (also the shape of Prisma's transaction client). */
export interface DataControlTransaction {
  brokerageAccount: {
    findMany(input: {
      where: { appUserId: string; connection: { snapTradeConnectionId: string } };
      select: { snapTradeAccountId: true };
    }): Promise<Array<{ snapTradeAccountId: string }>>;
  };
  brokerageConnection: {
    deleteMany(input: { where: { appUserId: string; snapTradeConnectionId: string } }): Count;
  };
  portfolioSnapshot: { deleteMany(input: { where: AccountScope }): Count };
  activity: { deleteMany(input: { where: AccountScope }): Count };
  activitySyncState: { deleteMany(input: { where: AccountScope }): Count };
  accountHistoryQuality: { deleteMany(input: { where: AccountScope }): Count };
  dailyValue: { deleteMany(input: { where: AccountScope }): Count };
  webhookEvent: {
    deleteMany(input: { where: { appUserId: string; payload: { path: string[]; equals: string } } }): Count;
  };
  pendingDisconnect: {
    findUnique(input: {
      where: { appUserId_snapTradeConnectionId: { appUserId: string; snapTradeConnectionId: string } };
      select: { snapTradeAccountIds: true };
    }): Promise<{ snapTradeAccountIds: string[] } | null>;
    upsert(input: {
      where: { appUserId_snapTradeConnectionId: { appUserId: string; snapTradeConnectionId: string } };
      create: { appUserId: string; snapTradeConnectionId: string; requestedAt: Date; snapTradeAccountIds: string[]; confirmedAt?: Date };
      update: { snapTradeAccountIds: string[]; confirmedAt?: Date };
    }): Promise<unknown>;
    deleteMany(input: { where: { appUserId: string; snapTradeConnectionId?: string } }): Count;
  };
}

type MarkerKey = { appUserId_snapTradeConnectionId: { appUserId: string; snapTradeConnectionId: string } };

type PendingSelect = { appUserId: true; snapTradeConnectionId: true; confirmedAt: true; requestedAt: true };
type PendingRow = {
  appUserId: string;
  snapTradeConnectionId: string;
  confirmedAt: Date | null;
  requestedAt: Date;
};

export interface DataControlPrismaPort {
  appUser: {
    findUnique(input: {
      where: { authSubject: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  webhookEvent: { deleteMany(input: { where: { receivedAt: { lt: Date } } }): Count };
  /** Only the subject-wide ("*") markers are swept here; per-client markers are the gateway sweep's. */
  mcpOAuthClientRevocation: { deleteMany(input: { where: { clientKey: "*"; revokedAt: { lt: Date } } }): Count };
  brokerageConnection: {
    findFirst(input: { where: { appUserId: string; snapTradeConnectionId: string }; select: { id: true } }): Promise<{ id: string } | null>;
  };
  pendingDisconnect: {
    /** Either the read filter's lookup for the owner or one class of the sweep's bounded listing. */
    findMany(input:
      | { where: { appUser: { authSubject: string } }; select: { snapTradeConnectionId: true } }
      | { where: { confirmedAt: { not: null } } | { confirmedAt: null }; select: PendingSelect; orderBy: { requestedAt: "asc" }; take: number },
    ): Promise<Array<{ snapTradeConnectionId: string }>>;
    findUnique(input: { where: MarkerKey; select: { id: true } }): Promise<{ id: string } | null>;
    count(input: { where: { appUserId: string } }): Promise<number>;
  };
  /** Tagged-template raw statement (Prisma's $executeRaw); returns the affected row count. */
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $transaction<T>(fn: (tx: DataControlTransaction) => Promise<T>): Promise<T>;
}

export interface StoredUser {
  appUserId: string;
}

export interface ConnectionPurge {
  accounts: number;
  snapshots: number;
  webhookEvents: number;
}

export interface PendingDisconnect {
  user: StoredUser;
  snapTradeConnectionId: string;
  /** CONNECTION_DELETED (or a provider 404) has been seen; the marker can go once the purge succeeds. */
  confirmed: boolean;
  requestedAt: Date;
}

/**
 * Per-class bound on markers handled per nightly sweep; the rest wait for the next night.
 * Confirmed markers (a purge that still has to succeed) have their own budget, so unconfirmed
 * ones can never starve them.
 */
const PENDING_SWEEP_LIMIT_PER_CLASS = 250;
/** Account ids kept per marker; an authorization has a handful of accounts. */
const MARKER_ACCOUNT_IDS_LIMIT = 100;

export class PrismaDataControlRepository {
  constructor(
    private readonly prisma: DataControlPrismaPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async findUser(authSubject: string): Promise<StoredUser | null> {
    const user = await this.prisma.appUser.findUnique({ where: { authSubject }, select: { id: true } });
    return user ? { appUserId: user.id } : null;
  }

  /** The owner's AppUser id: a verified webhook always belongs to the one owner. */
  async findOwnerAppUserId(): Promise<string | null> {
    return (await this.findUser(OWNER_SUBJECT))?.appUserId ?? null;
  }

  /**
   * Removes one connection, its accounts and everything stored per account, plus (by default)
   * its webhook receipts. Accounts are found through the stored `BrokerageAccount` rows and the
   * account ids already kept on the marker, so a re-purge still reaches activities and sync
   * state that an in-flight sync wrote after those rows were deleted.
   * `pending: "mark"` records the marker (with the account ids) in the same transaction, so
   * reads cannot re-persist the connection after the purge commits; `"mark_confirmed"` does the
   * same with the removal already confirmed (SnapTrade answered 404); `"clear"` removes the
   * marker, only if the purge commits.
   */
  purgeConnection(
    user: StoredUser,
    snapTradeConnectionId: string,
    options: { keepWebhookReceipts?: boolean; pending?: "mark" | "mark_confirmed" | "clear" } = {},
  ): Promise<ConnectionPurge> {
    const { appUserId } = user;
    const key: MarkerKey = { appUserId_snapTradeConnectionId: { appUserId, snapTradeConnectionId } };
    return this.prisma.$transaction(async (tx) => {
      const marker = await tx.pendingDisconnect.findUnique({ where: key, select: { snapTradeAccountIds: true } });
      const stored = await tx.brokerageAccount.findMany({
        where: { appUserId, connection: { snapTradeConnectionId } },
        select: { snapTradeAccountId: true },
      });
      const accountIds = [...new Set([...stored.map((a) => a.snapTradeAccountId), ...(marker?.snapTradeAccountIds ?? [])])]
        .slice(0, MARKER_ACCOUNT_IDS_LIMIT);
      if (options.pending === "mark" || options.pending === "mark_confirmed") {
        const confirmed = options.pending === "mark_confirmed" ? { confirmedAt: this.now() } : {};
        await tx.pendingDisconnect.upsert({
          where: key,
          create: { appUserId, snapTradeConnectionId, requestedAt: this.now(), snapTradeAccountIds: accountIds, ...confirmed },
          update: { snapTradeAccountIds: accountIds, ...confirmed },
        });
      }
      const scope: AccountScope = { appUserId, snapTradeAccountId: { in: accountIds } };
      let snapshots = 0;
      if (accountIds.length > 0) {
        snapshots = (await tx.portfolioSnapshot.deleteMany({ where: scope })).count;
        await tx.activity.deleteMany({ where: scope });
        await tx.activitySyncState.deleteMany({ where: scope });
        await tx.accountHistoryQuality.deleteMany({ where: scope });
        await tx.dailyValue.deleteMany({ where: scope });
      }
      // Cascades to the connection's BrokerageAccount rows.
      await tx.brokerageConnection.deleteMany({ where: { appUserId, snapTradeConnectionId } });
      const webhookEvents = options.keepWebhookReceipts ? 0 : (await tx.webhookEvent.deleteMany({
        where: {
          appUserId,
          payload: { path: ["brokerageAuthorizationId"], equals: snapTradeConnectionId },
        },
      })).count;
      if (options.pending === "clear") {
        await tx.pendingDisconnect.deleteMany({ where: { appUserId, snapTradeConnectionId } });
      }
      return { accounts: accountIds.length, snapshots, webhookEvents };
    });
  }

  /** Nightly: subject-wide ("*") revocation markers written before the cutoff guard no live token any more. */
  async purgeSubjectRevocations(before: Date): Promise<number> {
    return (await this.prisma.mcpOAuthClientRevocation.deleteMany({ where: { clientKey: ALL_CLIENTS, revokedAt: { lt: before } } })).count;
  }

  /** Disconnected authorization ids for the read filter: the owner's, as one owner holds every connection. */
  async disconnectedConnectionIds(): Promise<ReadonlySet<string>> {
    const rows = await this.prisma.pendingDisconnect.findMany({
      where: { appUser: { authSubject: OWNER_SUBJECT } },
      select: { snapTradeConnectionId: true },
    });
    return new Set(rows.map((row) => row.snapTradeConnectionId));
  }

  /** Whether the caller has this authorization locally, and how many markers they already hold. */
  async connectionState(appUserId: string, snapTradeConnectionId: string): Promise<{ stored: boolean; pending: boolean; pendingCount: number }> {
    const [connection, marker, pendingCount] = await Promise.all([
      this.prisma.brokerageConnection.findFirst({ where: { appUserId, snapTradeConnectionId }, select: { id: true } }),
      this.prisma.pendingDisconnect.findUnique({ where: { appUserId_snapTradeConnectionId: { appUserId, snapTradeConnectionId } }, select: { id: true } }),
      this.prisma.pendingDisconnect.count({ where: { appUserId } }),
    ]);
    return { stored: connection !== null, pending: marker !== null, pendingCount };
  }

  /** Confirmed markers first, then unconfirmed, each oldest first with its own bound; ids and timestamps only. */
  async pendingDisconnects(): Promise<PendingDisconnect[]> {
    const select: PendingSelect = { appUserId: true, snapTradeConnectionId: true, confirmedAt: true, requestedAt: true };
    const page = async (where: { confirmedAt: { not: null } } | { confirmedAt: null }) =>
      (await this.prisma.pendingDisconnect.findMany({ where, select, orderBy: { requestedAt: "asc" }, take: PENDING_SWEEP_LIMIT_PER_CLASS })) as PendingRow[];
    const rows = [...await page({ confirmedAt: { not: null } }), ...await page({ confirmedAt: null })];
    return rows.map((row) => ({
      user: { appUserId: row.appUserId },
      snapTradeConnectionId: row.snapTradeConnectionId,
      confirmed: row.confirmedAt !== null,
      requestedAt: row.requestedAt,
    }));
  }

  /**
   * Snapshots older than the cutoff go, except the newest snapshot of each account that still
   * exists: the writer skips a new row when SnapTrade's positionsAsOf has not moved, so that
   * row can be the account's only "last good" fallback. Snapshots of removed accounts go too.
   */
  async purgeExpired(cutoffs: { snapshotsBefore: Date; webhookEventsBefore: Date }): Promise<{ snapshots: number; webhookEvents: number }> {
    const snapshots = await this.prisma.$executeRaw`
      DELETE FROM "PortfolioSnapshot" AS s
      WHERE s."capturedAt" < ${cutoffs.snapshotsBefore}
        AND (
          NOT EXISTS (SELECT 1 FROM "BrokerageAccount" AS a WHERE a."appUserId" = s."appUserId" AND a."snapTradeAccountId" = s."snapTradeAccountId")
          OR EXISTS (SELECT 1 FROM "PortfolioSnapshot" AS n WHERE n."appUserId" = s."appUserId" AND n."snapTradeAccountId" = s."snapTradeAccountId" AND (n."capturedAt" > s."capturedAt" OR (n."capturedAt" = s."capturedAt" AND n."id" > s."id")))
        )`;
    const webhookEvents = (await this.prisma.webhookEvent.deleteMany({ where: { receivedAt: { lt: cutoffs.webhookEventsBefore } } })).count;
    return { snapshots, webhookEvents };
  }
}
