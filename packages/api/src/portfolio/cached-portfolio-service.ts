import { SnapTradeKeyRejectedError } from "../snaptrade/gateway.js";
import type { PortfolioCacheStatus, PortfolioQueryResult } from "./portfolio-query-service.js";

export interface PortfolioSource {
  getPortfolio(authSubject: string): Promise<PortfolioQueryResult>;
}

/** Persisted fallback for when the provider is unavailable and nothing is in memory. */
export interface LastGoodPortfolioStore {
  load(authSubject: string): Promise<PortfolioQueryResult | null>;
}

export interface PortfolioReadOptions {
  /** Bypass the TTL, subject to the minimum refresh interval. */
  refresh?: boolean;
}

interface CacheEntry {
  result: PortfolioQueryResult;
  loadedAtMs: number;
  invalidated: boolean;
}

export const PORTFOLIO_CACHE_DEFAULTS = {
  ttlMs: 60_000,
  minRefreshIntervalMs: 15_000,
  maxStaleMs: 24 * 60 * 60_000,
  maxEntries: 1_000,
} as const;

/**
 * Normal-mode portfolio reads for chat hosts, which call several tools per
 * turn. Fresh reads are shared per user (TTL + single-flight), account
 * drill-down reuses the same read, and a provider failure falls back to the
 * last good data, labelled stale.
 */
export class CachedPortfolioService {
  private readonly source: PortfolioSource;
  private readonly lastGood?: LastGoodPortfolioStore;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly minRefreshIntervalMs: number;
  private readonly maxStaleMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<PortfolioQueryResult>>();
  /** Bumped by forget(); a load that started under an older generation is never cached. */
  private readonly generations = new Map<string, number>();

  constructor(options: {
    source: PortfolioSource;
    lastGood?: LastGoodPortfolioStore;
    now?: () => Date;
    ttlMs?: number;
    minRefreshIntervalMs?: number;
    maxStaleMs?: number;
    maxEntries?: number;
  }) {
    this.source = options.source;
    this.lastGood = options.lastGood;
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? PORTFOLIO_CACHE_DEFAULTS.ttlMs;
    this.minRefreshIntervalMs = options.minRefreshIntervalMs ?? PORTFOLIO_CACHE_DEFAULTS.minRefreshIntervalMs;
    this.maxStaleMs = options.maxStaleMs ?? PORTFOLIO_CACHE_DEFAULTS.maxStaleMs;
    this.maxEntries = options.maxEntries ?? PORTFOLIO_CACHE_DEFAULTS.maxEntries;
  }

  async getPortfolio(authSubject: string, options: PortfolioReadOptions = {}): Promise<PortfolioQueryResult> {
    const entry = this.entries.get(authSubject);
    if (entry && this.isReusable(entry, options.refresh === true)) {
      return withCache(entry.result, { source: "cache", loadedAt: entry.result.generatedAt, stale: false });
    }
    const pending = this.inFlight.get(authSubject);
    if (pending) return pending;

    const load: Promise<PortfolioQueryResult> = this.load(authSubject, this.generations.get(authSubject) ?? 0)
      .finally(() => { if (this.inFlight.get(authSubject) === load) this.inFlight.delete(authSubject); });
    this.inFlight.set(authSubject, load);
    return load;
  }

  async getAccountPortfolio(authSubject: string, accountId: string): Promise<PortfolioQueryResult> {
    const portfolio = await this.getPortfolio(authSubject);
    return {
      ...portfolio,
      accounts: portfolio.accounts.filter((account) => account.account.id === accountId),
      errors: portfolio.errors.filter((error) => error.accountId === accountId),
    };
  }

  /** Forces the next read to hit the provider; the entry remains a stale fallback. */
  invalidate(authSubject: string): void {
    const entry = this.entries.get(authSubject);
    if (entry) entry.invalidated = true;
  }

  /**
   * Drops everything held for the subject (after a disconnect or delete-my-data): no stale
   * fallback remains, and a read already in flight is neither shared nor cached.
   */
  forget(authSubject: string): void {
    this.entries.delete(authSubject);
    this.inFlight.delete(authSubject);
    this.generations.set(authSubject, (this.generations.get(authSubject) ?? 0) + 1);
  }

  private isReusable(entry: CacheEntry, refresh: boolean): boolean {
    if (entry.invalidated) return false;
    const age = this.now().getTime() - entry.loadedAtMs;
    if (refresh) return age < this.minRefreshIntervalMs;
    return age < this.ttlMs;
  }

  private async load(authSubject: string, generation: number): Promise<PortfolioQueryResult> {
    let result: PortfolioQueryResult;
    try {
      result = await this.source.getPortfolio(authSubject);
    } catch (error) {
      if (error instanceof SnapTradeKeyRejectedError) {
        // A wrong or revoked key is the owner's to fix: stale data would hide it, so no fallback. The line carries no value.
        console.warn(JSON.stringify({ event: "snaptrade_key_rejected" }));
        throw error;
      }
      const fallback = await this.fallback(authSubject);
      if (fallback) return fallback;
      throw error;
    }
    if (result.connectionRequired) {
      // A user who is mid-connection must see their new accounts promptly.
      this.entries.delete(authSubject);
      return result;
    }
    if ((this.generations.get(authSubject) ?? 0) === generation) {
      this.store(authSubject, { result, loadedAtMs: this.now().getTime(), invalidated: false });
    }
    return withCache(result, { source: "provider", loadedAt: result.generatedAt, stale: false });
  }

  private async fallback(authSubject: string): Promise<PortfolioQueryResult | null> {
    const entry = this.entries.get(authSubject);
    if (entry && this.now().getTime() - entry.loadedAtMs <= this.maxStaleMs) {
      return withCache(entry.result, staleStatus("cache", entry.result.generatedAt));
    }
    if (!this.lastGood) return null;
    try {
      const persisted = await this.lastGood.load(authSubject);
      if (!persisted || persisted.accounts.length === 0) return null;
      return withCache(persisted, staleStatus("last_good", persisted.generatedAt));
    } catch {
      // The provider error is the meaningful one for the caller.
      return null;
    }
  }

  private store(authSubject: string, entry: CacheEntry): void {
    this.entries.delete(authSubject);
    this.entries.set(authSubject, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

function staleStatus(source: PortfolioCacheStatus["source"], loadedAt: string): PortfolioCacheStatus {
  return { source, loadedAt, stale: true, staleReason: "provider_unavailable" };
}

function withCache(result: PortfolioQueryResult, cache: PortfolioCacheStatus): PortfolioQueryResult {
  return { ...result, cache };
}
