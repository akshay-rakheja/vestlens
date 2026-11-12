import { z } from "zod";

import type { SnapTradeCredentials, ProviderReadOptions } from "../snaptrade/gateway.js";
import {
  normalizeAccountPortfolio,
  type NormalizedAccountPortfolio,
} from "./normalize.js";

export interface PortfolioIdentityProvider {
  getExisting(authSubject: string): Promise<SnapTradeCredentials | null>;
  /** True when a SnapTrade key switch cleared this user's link and they haven't linked again. */
  relinkRequired?(authSubject: string): Promise<boolean>;
}

export interface PortfolioGateway {
  listAccounts(credentials: SnapTradeCredentials, options?: ProviderReadOptions): Promise<unknown>;
  getAccountDetails(
    credentials: SnapTradeCredentials,
    accountId: string,
    options?: ProviderReadOptions,
  ): Promise<unknown>;
  getBalances(
    credentials: SnapTradeCredentials,
    accountId: string,
    options?: ProviderReadOptions,
  ): Promise<unknown>;
  getPositions(
    credentials: SnapTradeCredentials,
    accountId: string,
    options?: ProviderReadOptions,
  ): Promise<unknown>;
}

export interface PortfolioCacheStatus {
  /** provider: read just now; cache: reused in-memory read; last_good: persisted snapshots. */
  source: "provider" | "cache" | "last_good";
  /** When the underlying provider data was read. */
  loadedAt: string;
  stale: boolean;
  staleReason?: "provider_unavailable";
}

export interface PortfolioQueryResult {
  connectionRequired: boolean;
  /** Present only with connectionRequired: VestLens changed SnapTrade keys and this user must link again. */
  relinkRequired?: true;
  generatedAt: string;
  accounts: NormalizedAccountPortfolio[];
  errors: Array<{ accountId: string; code: "account_data_unavailable" }>;
  /** Set only by the cache. */
  cache?: PortfolioCacheStatus;
}

export interface PortfolioStateRepository {
  persistPortfolio(
    authSubject: string,
    accounts: NormalizedAccountPortfolio[],
  ): Promise<void>;
}

const accountListSchema = z.array(z.looseObject({ id: z.string().min(1) }));

export class PortfolioQueryService {
  private readonly identity: PortfolioIdentityProvider;
  private readonly gateway: PortfolioGateway;
  private readonly state?: PortfolioStateRepository;
  private readonly now: () => Date;
  private readonly maxConcurrentAccounts: number;
  private readonly readOptions?: ProviderReadOptions;

  constructor(options: {
    identity: PortfolioIdentityProvider;
    gateway: PortfolioGateway;
    state?: PortfolioStateRepository;
    now?: () => Date;
    /** Accounts read at once; each account read is three provider calls. */
    maxConcurrentAccounts?: number;
    requestTimeoutMs?: number;
  }) {
    this.identity = options.identity;
    this.gateway = options.gateway;
    this.state = options.state;
    this.now = options.now ?? (() => new Date());
    this.maxConcurrentAccounts = Math.max(1, options.maxConcurrentAccounts ?? 3);
    this.readOptions = options.requestTimeoutMs ? { timeout: options.requestTimeoutMs } : undefined;
  }

  private async connectionRequired(authSubject: string, generatedAt: string): Promise<PortfolioQueryResult> {
    const relink = (await this.identity.relinkRequired?.(authSubject)) === true;
    return { connectionRequired: true, ...(relink ? { relinkRequired: true as const } : {}), generatedAt, accounts: [], errors: [] };
  }

  async getPortfolio(authSubject: string): Promise<PortfolioQueryResult> {
    const credentials = await this.identity.getExisting(authSubject);
    const generatedAt = this.now().toISOString();
    if (!credentials) {
      return await this.connectionRequired(authSubject, generatedAt);
    }

    const listedAccounts = accountListSchema.parse(
      await this.gateway.listAccounts(credentials, ...this.optionArgs()),
    );
    if (listedAccounts.length === 0) {
      return await this.connectionRequired(authSubject, generatedAt);
    }

    const results = await mapWithConcurrency(
      listedAccounts,
      this.maxConcurrentAccounts,
      async ({ id: accountId }) => {
        try {
          const [account, balances, positions] = await Promise.all([
            this.gateway.getAccountDetails(credentials, accountId, ...this.optionArgs()),
            this.gateway.getBalances(credentials, accountId, ...this.optionArgs()),
            this.gateway.getPositions(credentials, accountId, ...this.optionArgs()),
          ]);
          return {
            kind: "account" as const,
            value: normalizeAccountPortfolio({ account, balances, positions }),
          };
        } catch {
          return {
            kind: "error" as const,
            value: {
              accountId,
              code: "account_data_unavailable" as const,
            },
          };
        }
      },
    );

    const portfolio = {
      connectionRequired: false,
      generatedAt,
      accounts: results
        .filter((result) => result.kind === "account")
        .map((result) => result.value),
      errors: results
        .filter((result) => result.kind === "error")
        .map((result) => result.value),
    };
    if (this.state && portfolio.accounts.length > 0) {
      await this.state.persistPortfolio(authSubject, portfolio.accounts);
    }
    return portfolio;
  }

  // Omit the argument entirely when unset so existing call shapes are unchanged.
  private optionArgs(): [ProviderReadOptions] | [] {
    return this.readOptions ? [this.readOptions] : [];
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
