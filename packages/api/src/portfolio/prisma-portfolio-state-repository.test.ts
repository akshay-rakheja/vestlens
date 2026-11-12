import { inventedAccountNumber } from "../testing/synthetic-fixtures.js";
import { describe, expect, it, vi } from "vitest";

import type { NormalizedAccountPortfolio } from "./normalize.js";
import { PrismaPortfolioStateRepository } from "./prisma-portfolio-state-repository.js";

const account: NormalizedAccountPortfolio = {
  account: {
    id: "account-1",
    connectionId: "connection-1",
    name: "TFSA",
    number: inventedAccountNumber("prisma-portfolio-state-repository-test-fresh-1"),
    institution: "Wealthsimple",
    type: "TFSA",
    category: "INVESTMENT",
    metaType: "tfsa",
    unifiedType: "SELF_DIRECTED_TFSA",
    status: "open",
    isPaper: false,
    reportedTotal: { amount: 1250, currency: "CAD" },
  },
  balances: [{ currency: "CAD", cash: 250, buyingPower: 250 }],
  positions: [
    {
      instrumentId: "instrument-vfv",
      kind: "etf",
      symbol: "VFV.TO",
      description: "Vanguard S&P 500 Index ETF",
      units: 10,
      price: 100,
      costBasis: 90,
      marketValue: 1000,
      unrealizedGain: 100,
      currency: "CAD",
      cashEquivalent: false,
    },
  ],
  calculatedValueByCurrency: { CAD: 1250 },
  freshness: {
    positionsAsOf: "2026-08-20T15:00:00.000Z",
    holdingsLastSyncedAt: "2026-08-20T14:55:00.000Z",
    initialSyncCompleted: true,
    holdingsUnavailable: false,
  },
  warnings: [],
};

function client() {
  return {
    appUser: {
      findIdByAuthSubject: vi.fn(async () => ({ id: "app-user-1" })),
    },
    brokerageConnection: {
      upsert: vi.fn(async () => ({ id: "stored-connection-1" })),
    },
    brokerageAccount: {
      upsert: vi.fn(async () => ({ id: "stored-account-1" })),
    },
    portfolioSnapshot: { create: vi.fn(async () => ({ id: "snapshot-1" })) },
  };
}

describe("PrismaPortfolioStateRepository", () => {
  it("upserts connection/account state and writes a sanitized snapshot", async () => {
    const prisma = client();
    const repository = new PrismaPortfolioStateRepository(prisma);

    await repository.persistPortfolio("subject|user-123", [account]);

    expect(prisma.brokerageConnection.upsert).toHaveBeenCalledWith({
      where: {
        appUserId_snapTradeConnectionId: {
          appUserId: "app-user-1",
          snapTradeConnectionId: "connection-1",
        },
      },
      create: {
        appUserId: "app-user-1",
        snapTradeConnectionId: "connection-1",
        brokerageName: "Wealthsimple",
      },
      update: { brokerageName: "Wealthsimple" },
      select: { id: true },
    });
    expect(prisma.brokerageAccount.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          maskedNumber: "••••" + account.account.number?.slice(-4),
          snapTradeAccountId: "account-1",
          connectionId: "stored-connection-1",
        }),
        update: expect.objectContaining({ maskedNumber: "••••" + account.account.number?.slice(-4) }),
      }),
    );
    expect(prisma.portfolioSnapshot.create).toHaveBeenCalledWith({
      data: {
        appUserId: "app-user-1",
        accountId: "stored-account-1",
        snapTradeAccountId: "account-1",
        positionsAsOf: new Date("2026-08-20T15:00:00.000Z"),
        payload: {
          account: {
            id: "account-1",
            name: "TFSA",
            institution: "Wealthsimple",
            type: "TFSA",
            category: "INVESTMENT",
            metaType: "tfsa",
            unifiedType: "SELF_DIRECTED_TFSA",
            status: "open",
            isPaper: false,
            reportedTotal: { amount: 1250, currency: "CAD" },
          },
          balances: account.balances,
          positions: account.positions,
          calculatedValueByCurrency: { CAD: 1250 },
          freshness: account.freshness,
          warnings: [],
        },
      },
    });
  });

  it("treats a duplicate source-freshness snapshot as already persisted", async () => {
    const prisma = client();
    prisma.portfolioSnapshot.create.mockRejectedValueOnce({ code: "P2002" });
    const repository = new PrismaPortfolioStateRepository(prisma);

    await expect(
      repository.persistPortfolio("subject|user-123", [account]),
    ).resolves.toBeUndefined();
  });

  it("never persists an account of a connection the user disconnected", async () => {
    const prisma = {
      ...client(),
      pendingDisconnect: { findMany: vi.fn(async () => [{ snapTradeConnectionId: "connection-1" }]) },
    };
    const repository = new PrismaPortfolioStateRepository(prisma);
    const reconnected = { ...account, account: { ...account.account, id: "account-2", connectionId: "connection-2" } };

    await repository.persistPortfolio("subject|user-123", [account, reconnected]);

    expect(prisma.pendingDisconnect.findMany).toHaveBeenCalledWith({ where: { appUserId: "app-user-1" }, select: { snapTradeConnectionId: true } });
    expect(prisma.brokerageConnection.upsert).toHaveBeenCalledOnce();
    expect(prisma.brokerageConnection.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ snapTradeConnectionId: "connection-2" }),
    }));
    expect(prisma.brokerageAccount.upsert).toHaveBeenCalledOnce();
    expect(prisma.portfolioSnapshot.create).toHaveBeenCalledOnce();
    expect(prisma.portfolioSnapshot.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ snapTradeAccountId: "account-2" }) }));
  });

  describe("a read in flight during account deletion", () => {
    it("writes nothing once the AppUser is gone, and never re-creates it", async () => {
      const prisma = client();
      prisma.appUser.findIdByAuthSubject.mockResolvedValueOnce(null as never);
      const repository = new PrismaPortfolioStateRepository(prisma);

      await expect(repository.persistPortfolio("subject|user-123", [account])).rejects.toThrow("Authenticated app user does not exist");
      expect(prisma.brokerageConnection.upsert).not.toHaveBeenCalled();
      expect(prisma.brokerageAccount.upsert).not.toHaveBeenCalled();
      expect(prisma.portfolioSnapshot.create).not.toHaveBeenCalled();
      // The port can only look the user up; there is no create or upsert to re-create a deleted user.
      expect(Object.keys(prisma.appUser)).toEqual(["findIdByAuthSubject"]);
    });

    it("fails on the foreign key when the purge commits between the lookup and the write, leaving no rows", async () => {
      const prisma = client();
      // Postgres refuses the insert: the AppUser row the lookup saw has been deleted.
      prisma.brokerageConnection.upsert.mockRejectedValueOnce({ code: "P2003" } as never);
      const repository = new PrismaPortfolioStateRepository(prisma);

      await expect(repository.persistPortfolio("subject|user-123", [account])).rejects.toMatchObject({ code: "P2003" });
      expect(prisma.brokerageAccount.upsert).not.toHaveBeenCalled();
      expect(prisma.portfolioSnapshot.create).not.toHaveBeenCalled();
    });

    it("does not swallow a foreign-key failure on the snapshot the way it treats a duplicate", async () => {
      const prisma = client();
      prisma.portfolioSnapshot.create.mockRejectedValueOnce({ code: "P2003" });
      const repository = new PrismaPortfolioStateRepository(prisma);

      await expect(repository.persistPortfolio("subject|user-123", [account])).rejects.toMatchObject({ code: "P2003" });
    });
  });
});
