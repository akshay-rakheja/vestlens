import { z } from "zod";

import type { SnapTradeCredentials, ProviderReadOptions } from "../snaptrade/gateway.js";
import {
  normalizeActivities,
  normalizeBalanceHistory,
  normalizeOrders,
  summarizeAccountHistory,
} from "./history-normalize.js";

export class PortfolioConnectionRequiredError extends Error {
  constructor() {
    super("A brokerage connection is required");
    this.name = "PortfolioConnectionRequiredError";
  }
}

export class PortfolioAccountNotFoundError extends Error {
  constructor() {
    super("Portfolio account not found");
    this.name = "PortfolioAccountNotFoundError";
  }
}

export interface PortfolioHistoryIdentityProvider {
  getExisting(authSubject: string): Promise<SnapTradeCredentials | null>;
}

export interface PortfolioHistoryGateway {
  listAccounts(credentials: SnapTradeCredentials, options?: ProviderReadOptions): Promise<unknown>;
  getOrders(
    credentials: SnapTradeCredentials,
    accountId: string,
    options?: { state?: "all" | "open" | "executed"; days?: number },
    requestOptions?: ProviderReadOptions,
  ): Promise<unknown>;
  getActivities(
    credentials: SnapTradeCredentials,
    accountId: string,
    options?: { startDate?: string; endDate?: string; limit?: number },
    requestOptions?: ProviderReadOptions,
  ): Promise<unknown>;
  getBalanceHistory(
    credentials: SnapTradeCredentials,
    accountId: string,
    options?: ProviderReadOptions,
  ): Promise<unknown>;
}

const accountListSchema = z.array(z.looseObject({ id: z.string().min(1) }));
// SnapTrade's ReportingDate is a plain YYYY-MM-DD and the SDK sends strings verbatim.
// z.iso.datetime() only accepts the Z form, so the first ten characters are the UTC day.
const activityDaySchema = z.iso.datetime().transform((value) => value.slice(0, 10));
const historyOptionsSchema = z
  .object({
    orders: z
      .object({
        state: z.enum(["all", "open", "executed"]).optional(),
        days: z.number().int().min(1).max(90).optional(),
      })
      .strict()
      .optional(),
    activities: z
      .object({
        startDate: activityDaySchema.optional(),
        endDate: activityDaySchema.optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Status only: an SDK error's message, url and responseBody can carry credentials or account data.
function warnReadFailed(source: "orders" | "activities" | "balanceHistory", reason: unknown): void {
  const status = (reason as { status?: unknown } | null | undefined)?.status;
  console.warn(JSON.stringify({ event: "account_history_read_failed", source, ...(Number.isInteger(status) ? { status } : {}) }));
}

export class PortfolioHistoryService {
  private readonly identity: PortfolioHistoryIdentityProvider;
  private readonly gateway: PortfolioHistoryGateway;
  private readonly now: () => Date;

  constructor(options: {
    identity: PortfolioHistoryIdentityProvider;
    gateway: PortfolioHistoryGateway;
    now?: () => Date;
  }) {
    this.identity = options.identity;
    this.gateway = options.gateway;
    this.now = options.now ?? (() => new Date());
  }

  async getAccountHistory(
    authSubject: string,
    accountId: string,
    input: {
      orders?: { state?: "all" | "open" | "executed"; days?: number };
      activities?: { startDate?: string; endDate?: string; limit?: number };
    } = {},
  ) {
    const parsedAccountId = z.string().trim().min(1).parse(accountId);
    const options = historyOptionsSchema.parse(input);
    const credentials = await this.identity.getExisting(authSubject);
    if (!credentials) throw new PortfolioConnectionRequiredError();

    const accounts = accountListSchema.parse(
      await this.gateway.listAccounts(credentials),
    );
    if (!accounts.some((account) => account.id === parsedAccountId)) {
      throw new PortfolioAccountNotFoundError();
    }

    const [ordersResult, activitiesResult, balanceHistoryResult] =
      await Promise.allSettled([
        this.gateway.getOrders(credentials, parsedAccountId, options.orders),
        this.gateway.getActivities(
          credentials,
          parsedAccountId,
          options.activities,
        ),
        this.gateway.getBalanceHistory(credentials, parsedAccountId),
      ]);
    if (ordersResult.status === "rejected") warnReadFailed("orders", ordersResult.reason);
    if (activitiesResult.status === "rejected") warnReadFailed("activities", activitiesResult.reason);
    if (balanceHistoryResult.status === "rejected") warnReadFailed("balanceHistory", balanceHistoryResult.reason);

    const orders =
      ordersResult.status === "fulfilled"
        ? normalizeOrders(ordersResult.value)
        : [];
    const activities =
      activitiesResult.status === "fulfilled"
        ? normalizeActivities(activitiesResult.value)
        : { items: [], pagination: { offset: 0, limit: 0, total: 0 } };
    // Experimental endpoint: a response we can't parse loses this section, not the whole read.
    let balanceHistory: ReturnType<typeof normalizeBalanceHistory> = { currency: null, points: [] };
    let balanceHistoryAvailable = false;
    if (balanceHistoryResult.status === "fulfilled") {
      try {
        balanceHistory = normalizeBalanceHistory(balanceHistoryResult.value);
        balanceHistoryAvailable = true;
      } catch {
        // Reported below as data_unavailable.
      }
    }
    const errors = [
      ...(ordersResult.status === "rejected"
        ? [{ source: "orders" as const, code: "data_unavailable" as const }]
        : []),
      ...(activitiesResult.status === "rejected"
        ? [
            {
              source: "activities" as const,
              code: "data_unavailable" as const,
            },
          ]
        : []),
      ...(!balanceHistoryAvailable
        ? [
            {
              source: "balanceHistory" as const,
              code: "data_unavailable" as const,
            },
          ]
        : []),
    ];

    return {
      accountId: parsedAccountId,
      generatedAt: this.now().toISOString(),
      orders,
      activities,
      balanceHistory,
      analytics: summarizeAccountHistory({
        orders,
        activities: activities.items,
        balanceHistory,
      }),
      freshness: {
        orders:
          "Brokerage dependent: real-time when enabled, otherwise daily.",
        activities: "Daily SnapTrade data.",
        balanceHistory:
          "Experimental SnapTrade estimate; maximum one-year lookback.",
      },
      errors,
    };
  }
}
