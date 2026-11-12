/**
 * In-memory sliding-window rate limiter keyed by an opaque string (the gateway passes an already hashed IP key,
 * see `rateLimitKeyForIp` in ../gateway/ip.ts; the MCP tool limiter passes the authenticated subject).
 * Resets on restart. Expired keys are swept at most once a minute; the map is capped at `maxKeys` by evicting
 * the least recently used key (Map order = last access).
 */
const SWEEP_INTERVAL_MS = 60 * 1000;

export interface RateWindow {
  ms: number;
  max: number;
}

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly longest: number;
  private lastSweepMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly windows: readonly RateWindow[],
    private readonly maxKeys = 50_000,
  ) {
    this.longest = Math.max(...windows.map((w) => w.ms));
  }

  /** Records a hit and returns true when every window is under its budget; otherwise records nothing. */
  take(key: string, nowMs: number): boolean {
    const cutoff = nowMs - this.longest;
    if (nowMs - this.lastSweepMs >= SWEEP_INTERVAL_MS) {
      this.lastSweepMs = nowMs;
      for (const [k, ts] of this.hits) if (!ts.some((t) => t > cutoff)) this.hits.delete(k);
    }
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    this.hits.delete(key);
    const allowed = this.windows.every((w) => recent.filter((t) => t > nowMs - w.ms).length < w.max);
    if (allowed) recent.push(nowMs);
    while (this.hits.size >= this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
    this.hits.set(key, recent);
    return allowed;
  }

  /** Whether `take` would pass now. Read-only: records nothing, sweeps nothing, keeps the key's LRU position. */
  peek(key: string, nowMs: number): boolean {
    const recent = this.hits.get(key) ?? [];
    return this.windows.every((w) => recent.filter((t) => t > nowMs - w.ms).length < w.max);
  }

  /** Milliseconds until `take` would pass (0 when it would pass now). Read-only. */
  retryAfterMs(key: string, nowMs: number): number {
    const recent = this.hits.get(key) ?? [];
    let wait = 0;
    for (const w of this.windows) {
      const inWindow = recent.filter((t) => t > nowMs - w.ms);
      if (inWindow.length < w.max) continue;
      // Hits are appended in time order: the window frees a slot once the (n - max + 1)-th oldest hit leaves it.
      const freeing = inWindow[inWindow.length - w.max];
      wait = Math.max(wait, freeing + w.ms - nowMs);
    }
    return wait;
  }

  /** Keys currently held (for memory-bound checks). */
  get size(): number {
    return this.hits.size;
  }
}
