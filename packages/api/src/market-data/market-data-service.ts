import { stooqTicker } from "./ticker-map.js";
import { MarketDataUnavailableError, type FxProvider, type IntradayBars, type PricePoint, type PriceHistoryProvider, type Quote, type QuoteProvider, type SecurityDistributions, type SecurityHistory, type SecurityProfile } from "./types.js";

export interface MarketDataCachePort {
  get(key: string, now: Date): Promise<unknown | null>;
  set(key: string, payload: unknown, fetchedAt: Date, expiresAt: Date): Promise<void>;
  /** Optional: delete entries that expired before `now`; returns how many were removed. */
  purgeExpired?(now: Date): Promise<number>;
}

// Copies on the way in and out so callers can never mutate cached payloads.
export class MemoryMarketDataCache implements MarketDataCachePort {
  private readonly entries = new Map<string, { payload: unknown; expiresAt: number }>();
  async get(key: string, now: Date) {
    const entry = this.entries.get(key);
    return entry && entry.expiresAt > now.getTime() ? structuredClone(entry.payload) : null;
  }
  async set(key: string, payload: unknown, _fetchedAt: Date, expiresAt: Date) {
    this.entries.set(key, { payload: structuredClone(payload), expiresAt: expiresAt.getTime() });
  }
}

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DEFAULT_FAILURE_TTL_MS = MINUTE;
// A range ending today holds a partial (intraday or not-yet-published) bar; keep it briefly.
const OPEN_RANGE_TTL_MS = 15 * MINUTE;
const torontoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });

export class MarketDataService {
  private readonly now: () => Date;
  private readonly retryDelayMs: number;
  private readonly failureTtlMs: number;
  // Concurrent identical cache misses share one load; entries are removed when the load settles.
  private readonly inflight = new Map<string, Promise<unknown>>();
  // In-memory only: key -> epoch ms until which a failed load is not retried. Never persisted.
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly options: {
      history: PriceHistoryProvider[];
      quotes: QuoteProvider;
      fx: FxProvider;
      cache: MarketDataCachePort;
      now?: () => Date;
      retryDelayMs?: number;
      failureTtlMs?: number;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
  }

  private rangeTtl(to: string): number {
    return to >= torontoDate.format(this.now()) ? OPEN_RANGE_TTL_MS : 24 * HOUR;
  }

  private failed(key: string): boolean {
    const until = this.failures.get(key);
    if (until === undefined) return false;
    if (until > this.now().getTime()) return true;
    this.failures.delete(key);
    return false;
  }

  // Cache failures (sync throws included) read as a miss and never reach callers.
  private async readCache(key: string, now: Date): Promise<unknown | null> {
    try {
      return (await this.options.cache.get(key, now)) ?? null;
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, value: unknown, now: Date, ttlMs: number): Promise<void> {
    try {
      await this.options.cache.set(key, value, now, new Date(now.getTime() + ttlMs));
    } catch {
      // A failed write only costs a future refetch.
    }
  }

  private async cached<T>(key: string, ttlMs: number | ((value: T) => number), load: () => Promise<T | null>): Promise<T | null> {
    if (this.failed(key)) return null;
    const now = this.now();
    const hit = await this.readCache(key, now);
    if (hit !== null) return hit as T;
    // Re-check after the await: a concurrent caller may have started a load or recorded a failure.
    if (this.failed(key)) return null;
    const shared = this.inflight.get(key);
    if (shared) return shared as Promise<T | null>;

    const pending = (async (): Promise<T | null> => {
      const value = await load();
      if (value === null) {
        this.failures.set(key, this.now().getTime() + this.failureTtlMs);
      } else {
        await this.writeCache(key, value, now, typeof ttlMs === "function" ? ttlMs(value) : ttlMs);
      }
      return value;
    })();
    this.inflight.set(key, pending);
    void pending
      .finally(() => {
        if (this.inflight.get(key) === pending) this.inflight.delete(key);
      })
      .catch(() => undefined);
    return pending;
  }

  // One provider call, retried once after retryDelayMs. Returns null instead of throwing.
  private async attempt<T>(call: () => Promise<T>): Promise<T | null> {
    for (let i = 0; i < 2; i++) {
      try {
        return await call();
      } catch {
        if (i === 0 && this.retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
        }
      }
    }
    return null;
  }

  history(ticker: string, from: string, to: string): Promise<PricePoint[] | null> {
    return this.cached(`history:${ticker}:${from}:${to}`, this.rangeTtl(to), async () => {
      for (const provider of this.options.history) {
        const symbol = provider.name === "stooq" ? stooqTicker(ticker) : ticker;
        if (!symbol) continue;
        const points = await this.attempt(() => provider.history(symbol, from, to));
        if (points && points.length) return points;
      }
      return null;
    });
  }

  /**
   * Closes plus split events for a held security (ruling F3). `splits` is null when the series
   * came from a provider without split information; callers must not value units against it.
   */
  securityHistory(ticker: string, from: string, to: string): Promise<SecurityHistory | null> {
    return this.cached(`security:${ticker}:${from}:${to}`, this.rangeTtl(to), async (): Promise<SecurityHistory | null> => {
      for (const provider of this.options.history) {
        const symbol = provider.name === "stooq" ? stooqTicker(ticker) : ticker;
        if (!symbol) continue;
        if (provider.historyWithSplits) {
          const withSplits = provider.historyWithSplits.bind(provider);
          let notFound = false;
          const r = await this.attempt(async () => {
            try {
              return await withSplits(symbol, from, to);
            } catch (error) {
              notFound = error instanceof MarketDataUnavailableError && error.reason === "http_404";
              throw error;
            }
          });
          if (r && r.points.length) return { points: r.points, splits: r.splits };
          // A definitive "no such ticker" (or an empty series) is permanent: a split-less fallback
          // series cannot be valued safely, so report it rather than an outage.
          if (notFound || (r && r.points.length === 0)) return { points: [], splits: [], notFound: true };
        } else {
          const points = await this.attempt(() => provider.history(symbol, from, to));
          if (points && points.length) return { points, splits: null };
        }
      }
      return null;
    });
  }

  /** Per-share distributions in range, cached a day; Yahoo only. Null when unavailable; a non-payer is an empty list. */
  distributions(ticker: string, from: string, to: string): Promise<SecurityDistributions | null> {
    return this.cached(`distributions:${ticker}:${from}:${to}`, 24 * HOUR, async () => {
      const provider = this.options.history.find((p) => p.distributions);
      return provider ? this.attempt(() => provider.distributions!(ticker, from, to)) : null;
    });
  }

  /** Latest-session bars for a ticker, cached 5 minutes; Yahoo only (no Stooq fallback). */
  intraday(ticker: string, interval: "5m" | "1h"): Promise<IntradayBars | null> {
    return this.cached(`intraday:${ticker}:${interval}`, 5 * MINUTE, async () => {
      const provider = this.options.history.find((p) => p.intraday);
      if (!provider) return null;
      const bars = await this.attempt(() => provider.intraday!(ticker, interval));
      return bars && bars.points.length ? bars : null;
    });
  }

  /** Public-security profile, cached 7 days; null (Unclassified) when no provider can supply it. */
  profile(ticker: string): Promise<SecurityProfile | null> {
    // An all-empty "unknown" profile may be a partial response: keep it for an hour, not a week.
    const empty = (p: SecurityProfile) => p.kind === "unknown" && !p.sector && !p.country && !p.sectorWeights && !p.countryWeights && !p.topHoldings;
    return this.cached<SecurityProfile>(`profile:${ticker}`, (p) => (empty(p) ? HOUR : 7 * 24 * HOUR), async () => {
      const provider = this.options.history.find((p) => p.profile);
      if (!provider) return null;
      try {
        return (await provider.profile!(ticker)) ?? null;
      } catch {
        return null;
      }
    });
  }

  /** The cached profile only (no provider call); null on a miss. The nightly news step uses it for ETF constituents. */
  async cachedProfile(ticker: string): Promise<SecurityProfile | null> {
    return (await this.readCache(`profile:${ticker}`, this.now())) as SecurityProfile | null;
  }

  /**
   * Cache-only profile read for rate-limit accounting. `known` is true on a hit, and also while the ticker's last
   * load failed or found no provider data (it sits in the failure map, so `profile()` would not call a provider).
   */
  async cachedProfileLookup(ticker: string): Promise<{ known: boolean; profile: SecurityProfile | null }> {
    const key = `profile:${ticker}`;
    if (this.failed(key)) return { known: true, profile: null };
    const hit = (await this.readCache(key, this.now())) as SecurityProfile | null;
    return hit ? { known: true, profile: hit } : { known: false, profile: null };
  }

  /** Best-effort purge of expired cache rows (ruling F4). Never throws; returns a count only. */
  async purgeExpiredCache(): Promise<number> {
    try {
      return (await this.options.cache.purgeExpired?.(this.now())) ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Cached, unexpired quotes only: no provider call and no join of an in-flight load. A ticker whose last load
   * failed (still in the failure map, so `quotes()` would not call the provider) maps to null: a known miss.
   * Plain misses (and cache-port failures) are absent. The holdings tool reads this first and fetches only absent
   * tickers, so a call counts as a refresh only when a provider is actually asked.
   */
  async cachedQuotes(tickers: string[]): Promise<Map<string, Quote | null>> {
    const now = this.now();
    const result = new Map<string, Quote | null>();
    for (const ticker of new Set(tickers)) {
      const key = `quote:${ticker}`;
      if (this.failed(key)) { result.set(ticker, null); continue; }
      const hit = (await this.readCache(key, now)) as Quote | null;
      if (hit) result.set(ticker, hit);
    }
    return result;
  }

  async quotes(tickers: string[]): Promise<Map<string, Quote>> {
    const unique = [...new Set(tickers)];
    const result = new Map<string, Quote>();
    let next = 0;
    const worker = async () => {
      while (next < unique.length) {
        const ticker = unique[next++];
        const quote = await this.cached(`quote:${ticker}`, 5 * MINUTE, () =>
          this.attempt(() => this.options.quotes.quote(ticker)),
        );
        if (quote) result.set(ticker, quote);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, unique.length) }, worker));
    return new Map(unique.filter((ticker) => result.has(ticker)).map((ticker) => [ticker, result.get(ticker)!]));
  }

  usdCad(from: string, to: string): Promise<PricePoint[] | null> {
    return this.cached(`fx:USDCAD:${from}:${to}`, this.rangeTtl(to), async () => {
      const points = await this.attempt(() => this.options.fx.usdCad(from, to));
      return points && points.length ? points : null;
    });
  }
}
