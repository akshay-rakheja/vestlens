import { inventedFixture } from "../testing/synthetic-fixtures.js";
import { describe, expect, it, vi } from "vitest";

import type { SnapTradeCredentials } from "../snaptrade/gateway.js";
import {
  PortfolioQueryService,
  type PortfolioGateway,
} from "./portfolio-query-service.js";

const credentials: SnapTradeCredentials = {
  userId: "portfolio_00000000-0000-4000-8000-0000000000c1",
  userSecret: inventedFixture("portfolio-query-service-test-fresh-1"),
};

const accountDetails = {
  id: "account-1",
  brokerage_authorization: "connection-1",
  name: "TFSA",
  number: "***1234",
  institution_name: "Wealthsimple",
  raw_type: "TFSA",
  account_category: "INVESTMENT",
  status: "open",
  is_paper: false,
  balance: { total: { amount: 1250, currency: "CAD" } },
  sync_status: {
    holdings: {
      initial_sync_completed: true,
      last_successful_sync: "2026-08-19T14:00:00Z",
      holdings_unavailable: false,
    },
  },
};

function gateway(overrides: Partial<PortfolioGateway> = {}): PortfolioGateway {
  return {
    listAccounts: vi.fn(async () => [{ id: "account-1" }]),
    getAccountDetails: vi.fn(async () => accountDetails),
    getBalances: vi.fn(async () => [
      { currency: { code: "CAD" }, cash: 250, buying_power: 250 },
    ]),
    getPositions: vi.fn(async () => ({
      results: [
        {
          instrument: {
            id: "instrument-vfv",
            kind: "etf",
            symbol: "VFV.TO",
            description: "Vanguard S&P 500 Index ETF",
          },
          units: "10",
          price: "100",
          cost_basis: "90",
          currency: "CAD",
        },
      ],
      data_freshness: { as_of: "2026-08-19T13:55:00Z" },
    })),
    ...overrides,
  };
}

describe("PortfolioQueryService", () => {
  it("returns connection-required without provisioning on a read", async () => {
    const identity = { getExisting: vi.fn(async () => null) };
    const snapTrade = gateway();
    const service = new PortfolioQueryService({
      identity,
      gateway: snapTrade,
      now: () => new Date("2026-08-19T15:00:00Z"),
    });

    await expect(service.getPortfolio("subject|user-123")).resolves.toEqual({
      connectionRequired: true,
      generatedAt: "2026-08-19T15:00:00.000Z",
      accounts: [],
      errors: [],
    });
    expect(snapTrade.listAccounts).not.toHaveBeenCalled();
  });

  it("returns connection-required when a provisioned user has no brokerage accounts", async () => {
    const identity = { getExisting: vi.fn(async () => credentials) };
    const snapTrade = gateway({
      listAccounts: vi.fn(async () => []),
    });
    const service = new PortfolioQueryService({
      identity,
      gateway: snapTrade,
      now: () => new Date("2026-08-19T15:00:00Z"),
    });

    await expect(service.getPortfolio("subject|user-123")).resolves.toEqual({
      connectionRequired: true,
      generatedAt: "2026-08-19T15:00:00.000Z",
      accounts: [],
      errors: [],
    });
    expect(snapTrade.getAccountDetails).not.toHaveBeenCalled();
    expect(snapTrade.getBalances).not.toHaveBeenCalled();
    expect(snapTrade.getPositions).not.toHaveBeenCalled();
  });

  it("fetches and normalizes each account under server-held credentials", async () => {
    const identity = { getExisting: vi.fn(async () => credentials) };
    const snapTrade = gateway();
    const service = new PortfolioQueryService({
      identity,
      gateway: snapTrade,
      now: () => new Date("2026-08-19T15:00:00Z"),
    });

    const portfolio = await service.getPortfolio("subject|user-123");

    expect(portfolio.connectionRequired).toBe(false);
    expect(portfolio.accounts).toHaveLength(1);
    expect(portfolio.accounts[0]).toMatchObject({
      account: { id: "account-1", institution: "Wealthsimple" },
      calculatedValueByCurrency: { CAD: 1250 },
    });
    expect(snapTrade.listAccounts).toHaveBeenCalledWith(credentials);
    expect(snapTrade.getAccountDetails).toHaveBeenCalledWith(
      credentials,
      "account-1",
    );
    expect(snapTrade.getBalances).toHaveBeenCalledWith(
      credentials,
      "account-1",
    );
    expect(snapTrade.getPositions).toHaveBeenCalledWith(
      credentials,
      "account-1",
    );
  });

  it("persists only the authenticated user's normalized portfolio state", async () => {
    const identity = { getExisting: vi.fn(async () => credentials) };
    const snapTrade = gateway();
    const state = { persistPortfolio: vi.fn(async () => undefined) };
    const service = new PortfolioQueryService({
      identity,
      gateway: snapTrade,
      state,
      now: () => new Date("2026-08-19T15:00:00Z"),
    });

    const portfolio = await service.getPortfolio("subject|user-123");

    expect(state.persistPortfolio).toHaveBeenCalledWith(
      "subject|user-123",
      portfolio.accounts,
    );
  });

  it("returns a safe per-account error while retaining healthy accounts", async () => {
    const identity = { getExisting: vi.fn(async () => credentials) };
    const snapTrade = gateway({
      listAccounts: vi.fn(async () => [
        { id: "account-1" },
        { id: "account-2" },
      ]),
      getAccountDetails: vi.fn(async (_credentials, accountId) => {
        if (accountId === "account-2") throw new Error("broker detail");
        return accountDetails;
      }),
    });
    const service = new PortfolioQueryService({
      identity,
      gateway: snapTrade,
      now: () => new Date("2026-08-19T15:00:00Z"),
    });

    const portfolio = await service.getPortfolio("subject|user-123");

    expect(portfolio.accounts).toHaveLength(1);
    expect(portfolio.errors).toEqual([
      { accountId: "account-2", code: "account_data_unavailable" },
    ]);
  });
});

describe("PortfolioQueryService provider fan-out", () => {
  it("limits how many accounts are read at once and passes a request timeout", async () => {
    let active = 0;
    let peak = 0;
    const tracked = <T,>(value: T) => async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return value;
    };
    const ids = Array.from({ length: 7 }, (_, index) => ({ id: `account-${index}` }));
    const snapTrade = gateway({
      listAccounts: vi.fn(async () => ids),
      getAccountDetails: vi.fn(tracked(accountDetails)),
      getBalances: vi.fn(tracked([])),
      getPositions: vi.fn(tracked({ results: [] })),
    });
    const service = new PortfolioQueryService({
      identity: { getExisting: vi.fn(async () => credentials) },
      gateway: snapTrade,
      maxConcurrentAccounts: 2,
      requestTimeoutMs: 12_000,
    });

    const result = await service.getPortfolio("subject|user-123");

    expect(result.accounts).toHaveLength(7);
    expect(peak).toBeLessThanOrEqual(2 * 3);
    expect(peak).toBeGreaterThan(0);
    expect(snapTrade.listAccounts).toHaveBeenCalledWith(credentials, { timeout: 12_000 });
    expect(snapTrade.getPositions).toHaveBeenCalledWith(credentials, "account-6", { timeout: 12_000 });
  });

  it("keeps account order stable under bounded concurrency", async () => {
    const ids = Array.from({ length: 5 }, (_, index) => ({ id: `account-${index}` }));
    const snapTrade = gateway({
      listAccounts: vi.fn(async () => ids),
      getAccountDetails: vi.fn(async (_credentials: SnapTradeCredentials, accountId: string) => {
        await new Promise((resolve) => setTimeout(resolve, 5 - Number(accountId.slice(-1))));
        return { ...accountDetails, id: accountId };
      }),
    });
    const service = new PortfolioQueryService({
      identity: { getExisting: vi.fn(async () => credentials) },
      gateway: snapTrade,
      maxConcurrentAccounts: 2,
    });
    const result = await service.getPortfolio("subject|user-123");
    expect(result.accounts.map((account) => account.account.id)).toEqual(ids.map(({ id }) => id));
  });

  describe("after a SnapTrade key switch", () => {
    it("flags relinkRequired with connectionRequired when the identity says so", async () => {
      const service = new PortfolioQueryService({
        identity: { getExisting: vi.fn(async () => null), relinkRequired: vi.fn(async () => true) },
        gateway: gateway(),
      });
      await expect(service.getPortfolio("subject|user")).resolves.toMatchObject({ connectionRequired: true, relinkRequired: true });
    });

    it("keeps flagging while new credentials exist but nothing is linked yet", async () => {
      const service = new PortfolioQueryService({
        identity: { getExisting: vi.fn(async () => credentials), relinkRequired: vi.fn(async () => true) },
        gateway: gateway({ listAccounts: vi.fn(async () => []) }),
      });
      await expect(service.getPortfolio("subject|user")).resolves.toMatchObject({ connectionRequired: true, relinkRequired: true });
    });

    it("omits the flag for a first-time connection", async () => {
      const service = new PortfolioQueryService({
        identity: { getExisting: vi.fn(async () => null), relinkRequired: vi.fn(async () => false) },
        gateway: gateway(),
      });
      const result = await service.getPortfolio("subject|user");
      expect(result.connectionRequired).toBe(true);
      expect(result).not.toHaveProperty("relinkRequired");
    });
  });
});
