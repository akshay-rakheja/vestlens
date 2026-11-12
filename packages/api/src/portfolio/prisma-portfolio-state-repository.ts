import type { NormalizedAccountPortfolio } from "./normalize.js";

export interface PortfolioStatePrismaPort {
  appUser: {
    findIdByAuthSubject(authSubject: string): Promise<{ id: string } | null>;
  };
  brokerageConnection: {
    upsert(input: {
      where: {
        appUserId_snapTradeConnectionId: {
          appUserId: string;
          snapTradeConnectionId: string;
        };
      };
      create: {
        appUserId: string;
        snapTradeConnectionId: string;
        brokerageName: string;
      };
      update: { brokerageName: string };
      select: { id: true };
    }): Promise<{ id: string }>;
  };
  brokerageAccount: {
    upsert(input: {
      where: {
        appUserId_snapTradeAccountId: {
          appUserId: string;
          snapTradeAccountId: string;
        };
      };
      create: BrokerageAccountState;
      update: Omit<
        BrokerageAccountState,
        "appUserId" | "snapTradeAccountId"
      >;
      select: { id: true };
    }): Promise<{ id: string }>;
  };
  /** Disconnected authorizations (normal mode); their accounts are never persisted again. */
  pendingDisconnect?: {
    findMany(input: { where: { appUserId: string }; select: { snapTradeConnectionId: true } }): Promise<Array<{ snapTradeConnectionId: string }>>;
  };
  portfolioSnapshot: {
    create(input: {
      data: {
        appUserId: string;
        accountId: string;
        snapTradeAccountId: string;
        positionsAsOf: Date | null;
        payload: Record<string, unknown>;
      };
    }): Promise<unknown>;
  };
}

interface BrokerageAccountState {
  appUserId: string;
  connectionId: string;
  snapTradeAccountId: string;
  displayName: string | null;
  maskedNumber: string;
  institutionName: string;
  rawType: string | null;
  category: string | null;
  status: string | null;
  isPaper: boolean;
  reportedTotal: number | null;
  reportedCurrency: string | null;
  holdingsUnavailable: boolean;
  holdingsLastSyncedAt: Date | null;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

function maskedAccountNumber(number: string): string {
  const compact = number.replace(/\s+/g, "");
  return `••••${compact.slice(-4)}`;
}

function snapshotPayload(account: NormalizedAccountPortfolio) {
  return {
    account: {
      id: account.account.id,
      name: account.account.name,
      institution: account.account.institution,
      type: account.account.type,
      category: account.account.category,
      metaType: account.account.metaType,
      unifiedType: account.account.unifiedType,
      status: account.account.status,
      isPaper: account.account.isPaper,
      reportedTotal: account.account.reportedTotal,
    },
    balances: account.balances,
    positions: account.positions,
    calculatedValueByCurrency: account.calculatedValueByCurrency,
    freshness: account.freshness,
    warnings: account.warnings,
  };
}

export class PrismaPortfolioStateRepository {
  constructor(private readonly prisma: PortfolioStatePrismaPort) {}

  async persistPortfolio(
    authSubject: string,
    accounts: NormalizedAccountPortfolio[],
  ): Promise<void> {
    const owner = await this.prisma.appUser.findIdByAuthSubject(authSubject);
    if (!owner) {
      throw new Error("Authenticated app user does not exist");
    }

    // Last line of defence for a read that was already in flight when the user disconnected.
    const disconnected = new Set(
      (await this.prisma.pendingDisconnect?.findMany({ where: { appUserId: owner.id }, select: { snapTradeConnectionId: true } }) ?? [])
        .map((row) => row.snapTradeConnectionId),
    );

    for (const account of accounts) {
      if (disconnected.has(account.account.connectionId)) continue;
      const connection = await this.prisma.brokerageConnection.upsert({
        where: {
          appUserId_snapTradeConnectionId: {
            appUserId: owner.id,
            snapTradeConnectionId: account.account.connectionId,
          },
        },
        create: {
          appUserId: owner.id,
          snapTradeConnectionId: account.account.connectionId,
          brokerageName: account.account.institution,
        },
        update: { brokerageName: account.account.institution },
        select: { id: true },
      });
      const state: BrokerageAccountState = {
        appUserId: owner.id,
        connectionId: connection.id,
        snapTradeAccountId: account.account.id,
        displayName: account.account.name,
        maskedNumber: maskedAccountNumber(account.account.number),
        institutionName: account.account.institution,
        rawType: account.account.type,
        category: account.account.category,
        status: account.account.status,
        isPaper: account.account.isPaper,
        reportedTotal: account.account.reportedTotal?.amount ?? null,
        reportedCurrency: account.account.reportedTotal?.currency ?? null,
        holdingsUnavailable: account.freshness.holdingsUnavailable,
        holdingsLastSyncedAt: account.freshness.holdingsLastSyncedAt
          ? new Date(account.freshness.holdingsLastSyncedAt)
          : null,
      };
      const storedAccount = await this.prisma.brokerageAccount.upsert({
        where: {
          appUserId_snapTradeAccountId: {
            appUserId: owner.id,
            snapTradeAccountId: account.account.id,
          },
        },
        create: state,
        update: {
          connectionId: state.connectionId,
          displayName: state.displayName,
          maskedNumber: state.maskedNumber,
          institutionName: state.institutionName,
          rawType: state.rawType,
          category: state.category,
          status: state.status,
          isPaper: state.isPaper,
          reportedTotal: state.reportedTotal,
          reportedCurrency: state.reportedCurrency,
          holdingsUnavailable: state.holdingsUnavailable,
          holdingsLastSyncedAt: state.holdingsLastSyncedAt,
        },
        select: { id: true },
      });

      try {
        await this.prisma.portfolioSnapshot.create({
          data: {
            appUserId: owner.id,
            accountId: storedAccount.id,
            snapTradeAccountId: account.account.id,
            positionsAsOf: account.freshness.positionsAsOf ? new Date(account.freshness.positionsAsOf) : null,
            payload: snapshotPayload(account),
          },
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
      }
    }
  }
}
