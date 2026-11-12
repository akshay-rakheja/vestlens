import { describe, expect, it } from "vitest";

import { SlidingWindowLimiter } from "./sliding-window.js";
import { SlidingWindowLimiter as GatewayLimiter } from "../gateway/rate-limit.js";

const MIN = 60_000;

describe("SlidingWindowLimiter", () => {
  it("is the same class the gateway uses (one shared implementation)", () => {
    expect(GatewayLimiter).toBe(SlidingWindowLimiter);
  });

  it("allows up to max hits per window, records nothing on rejection, and slides", () => {
    const l = new SlidingWindowLimiter([{ ms: MIN, max: 3 }]);
    expect([l.take("k", 0), l.take("k", 10), l.take("k", 20), l.take("k", 30)]).toEqual([true, true, true, false]);
    // The rejected hit at 30 was not recorded: the first slot frees at 0 + MIN.
    expect(l.take("k", MIN - 1)).toBe(false);
    expect(l.take("k", MIN + 1)).toBe(true);
  });

  it("enforces every window", () => {
    const l = new SlidingWindowLimiter([{ ms: 1_000, max: 2 }, { ms: MIN, max: 3 }]);
    expect([l.take("k", 0), l.take("k", 1), l.take("k", 2)]).toEqual([true, true, false]);
    expect(l.take("k", 1_500)).toBe(true);
    expect(l.take("k", 3_000)).toBe(false);
  });

  it("peek reports whether a take would pass without recording a hit", () => {
    const l = new SlidingWindowLimiter([{ ms: MIN, max: 1 }]);
    expect(l.peek("k", 0)).toBe(true);
    expect(l.peek("k", 0)).toBe(true);
    expect(l.take("k", 0)).toBe(true);
    expect(l.peek("k", 1)).toBe(false);
    expect(l.peek("k", MIN + 1)).toBe(true);
  });

  it("retryAfterMs is zero when allowed, else the time until a slot frees", () => {
    const l = new SlidingWindowLimiter([{ ms: MIN, max: 2 }]);
    expect(l.retryAfterMs("k", 0)).toBe(0);
    l.take("k", 1_000);
    l.take("k", 5_000);
    expect(l.retryAfterMs("k", 10_000)).toBe(MIN + 1_000 - 10_000);
    expect(l.retryAfterMs("k", MIN + 1_001)).toBe(0);
  });

  it("is memory-bounded: expired keys are swept lazily and the key count is capped", () => {
    const l = new SlidingWindowLimiter([{ ms: MIN, max: 5 }]);
    for (let i = 0; i < 100; i++) l.take(`k${i}`, 0);
    expect(l.size).toBe(100);
    l.take("late", 2 * MIN);
    expect(l.size).toBe(1);
    const capped = new SlidingWindowLimiter([{ ms: MIN, max: 5 }], 10);
    for (let i = 0; i < 25; i++) capped.take(`k${i}`, i);
    expect(capped.size).toBe(10);
  });
});
