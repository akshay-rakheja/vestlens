import { SlidingWindowLimiter } from "../security/sliding-window.js";

/**
 * Per authenticated subject. Exact values: global constraints, "Rate limits (exact)".
 *
 * Accepted limitations: the limiter is in memory, so limits apply per server instance (several instances
 * would each keep their own counts) and reset on restart. The refresh limit is peeked before a handler and recorded after
 * it, so concurrent in-flight calls from one subject can exceed `refreshPerMinute` by the number in flight;
 * `perMinute` is exact (checked and counted before the handler).
 */
export const TOOL_LIMITS = {
  perMinute: 60,
  refreshPerMinute: 10,
  refreshTools: ["get_news", "show_news", "get_allocation", "show_allocation", "get_holdings", "show_holdings"],
} as const;

export const RATE_LIMITED_TEXT = "Too many requests; try again in a minute.";

const MINUTE_MS = 60_000;
const REFRESH_TOOLS: ReadonlySet<string> = new Set(TOOL_LIMITS.refreshTools);

export interface ToolRateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface ToolRateLimiter {
  /**
   * Counts one call toward the per-minute limit and, when `triggersRefresh` is true for a refresh tool, one
   * refresh toward the refresh limit. Refused calls record nothing.
   */
  check(subject: string, tool: string, triggersRefresh: boolean): ToolRateDecision;
  /** Whether a refresh tool may hit a provider now. Read-only; always true for tools outside the refresh list. */
  refreshAvailable(subject: string, tool: string): boolean;
  /** Records a provider refresh that already happened (refresh tools only). */
  recordRefresh(subject: string, tool: string): void;
  /** Subjects held across both windows (memory-bound checks). */
  size(): number;
}

/**
 * In-memory, per-process limiter keyed by the authenticated subject. Entries expire after the one-minute window
 * and are swept lazily (see SlidingWindowLimiter). Cached reads never count toward the refresh limit.
 */
export function toolRateLimiter(o: { now?: () => Date } = {}): ToolRateLimiter {
  const now = () => (o.now ?? (() => new Date()))().getTime();
  const calls = new SlidingWindowLimiter([{ ms: MINUTE_MS, max: TOOL_LIMITS.perMinute }]);
  const refreshes = new SlidingWindowLimiter([{ ms: MINUTE_MS, max: TOOL_LIMITS.refreshPerMinute }]);
  const refused = (limiter: SlidingWindowLimiter, subject: string, t: number): ToolRateDecision =>
    ({ allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(limiter.retryAfterMs(subject, t) / 1000)) });
  return {
    check(subject, tool, triggersRefresh) {
      const t = now();
      const refresh = triggersRefresh && REFRESH_TOOLS.has(tool);
      // Both budgets are checked before either is spent, so a refusal records nothing.
      if (!calls.peek(subject, t)) return refused(calls, subject, t);
      if (refresh && !refreshes.peek(subject, t)) return refused(refreshes, subject, t);
      calls.take(subject, t);
      if (refresh) refreshes.take(subject, t);
      return { allowed: true, retryAfterSeconds: 0 };
    },
    refreshAvailable(subject, tool) {
      return !REFRESH_TOOLS.has(tool) || refreshes.peek(subject, now());
    },
    recordRefresh(subject, tool) {
      if (REFRESH_TOOLS.has(tool)) refreshes.take(subject, now());
    },
    size() {
      return calls.size + refreshes.size;
    },
  };
}

/** The process-wide limiter used by the HTTP /mcp route (one per server process; resets on restart). */
export const sharedToolRateLimiter: ToolRateLimiter = toolRateLimiter();
