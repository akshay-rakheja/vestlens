import { z } from "zod";

import type { LastGoodPortfolioStore } from "./cached-portfolio-service.js";
import type { NormalizedAccountPortfolio } from "./normalize.js";
import type { PortfolioQueryResult } from "./portfolio-query-service.js";

export interface LastGoodAccountRow {
  snapTradeAccountId: string;
  maskedNumber: string | null;
  connection: { snapTradeConnectionId: string; disabled: boolean };
  snapshots: Array<{ payload: unknown; capturedAt: Date }>;
}

export interface LastGoodPrismaPort {
  brokerageAccount: {
    findMany(input: {
      where: { appUser: { authSubject: string } };
      orderBy: { snapTradeAccountId: "asc" };
      select: {
        snapTradeAccountId: true;
        maskedNumber: true;
        connection: { select: { snapTradeConnectionId: true; disabled: true } };
        snapshots: {
          orderBy: { capturedAt: "desc" };
          take: 1;
          select: { payload: true; capturedAt: true };
        };
      };
    }): Promise<LastGoodAccountRow[]>;
  };
}

const nullableString = z.string().nullable();
const currencyAmount = z.object({ currency: z.string(), amount: z.number() });

// Matches snapshotPayload() in prisma-portfolio-state-repository.ts.
const snapshotPayloadSchema = z.looseObject({
  account: z.looseObject({
    id: z.string().min(1),
    name: nullableString,
    institution: z.string(),
    type: nullableString,
    category: nullableString,
    metaType: nullableString,
    unifiedType: nullableString,
    status: nullableString,
    isPaper: z.boolean(),
    reportedTotal: currencyAmount.nullable(),
  }),
  balances: z.array(z.looseObject({ currency: z.string() })),
  positions: z.array(z.looseObject({ instrumentId: z.string() })),
  calculatedValueByCurrency: z.record(z.string(), z.number()),
  freshness: z.looseObject({
    positionsAsOf: nullableString,
    holdingsLastSyncedAt: nullableString,
    initialSyncCompleted: z.boolean(),
    holdingsUnavailable: z.boolean(),
  }),
  warnings: z.array(z.string()),
});

const SNAPSHOT_WARNING = "Showing the last saved snapshot because the brokerage could not be reached.";

/** Rebuilds a portfolio from each account's most recent persisted snapshot. */
export class PrismaLastGoodPortfolioStore implements LastGoodPortfolioStore {
  constructor(private readonly prisma: LastGoodPrismaPort) {}

  async load(authSubject: string): Promise<PortfolioQueryResult | null> {
    const rows = await this.prisma.brokerageAccount.findMany({
      where: { appUser: { authSubject } },
      orderBy: { snapTradeAccountId: "asc" },
      select: {
        snapTradeAccountId: true,
        maskedNumber: true,
        connection: { select: { snapTradeConnectionId: true, disabled: true } },
        snapshots: {
          orderBy: { capturedAt: "desc" },
          take: 1,
          select: { payload: true, capturedAt: true },
        },
      },
    });

    const accounts: NormalizedAccountPortfolio[] = [];
    let oldestCapture: Date | null = null;
    for (const row of rows) {
      const snapshot = row.snapshots[0];
      if (row.connection.disabled || !snapshot) continue;
      const parsed = snapshotPayloadSchema.safeParse(snapshot.payload);
      if (!parsed.success || parsed.data.account.id !== row.snapTradeAccountId) continue;
      const payload = parsed.data;
      accounts.push({
        account: {
          ...payload.account,
          connectionId: row.connection.snapTradeConnectionId,
          number: row.maskedNumber ?? "",
        },
        balances: payload.balances as NormalizedAccountPortfolio["balances"],
        positions: payload.positions as NormalizedAccountPortfolio["positions"],
        calculatedValueByCurrency: payload.calculatedValueByCurrency,
        freshness: payload.freshness as NormalizedAccountPortfolio["freshness"],
        warnings: [...payload.warnings, SNAPSHOT_WARNING],
      } as NormalizedAccountPortfolio);
      if (!oldestCapture || snapshot.capturedAt < oldestCapture) oldestCapture = snapshot.capturedAt;
    }

    if (accounts.length === 0 || !oldestCapture) return null;
    return {
      connectionRequired: false,
      generatedAt: oldestCapture.toISOString(),
      accounts,
      errors: [],
    };
  }
}
