import { describe, expect, it } from "vitest";

import { RATE_LIMITED_TEXT, TOOL_LIMITS, toolRateLimiter } from "./rate-limit.js";

const clock = (start = Date.parse("2026-10-21T20:00:00Z")) => {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
};

describe("TOOL_LIMITS", () => {
  it("pins the exact limits and refresh tools", () => {
    expect(TOOL_LIMITS).toEqual({
      perMinute: 60,
      refreshPerMinute: 10,
      refreshTools: ["get_news", "show_news", "get_allocation", "show_allocation", "get_holdings", "show_holdings"],
    });
    expect(RATE_LIMITED_TEXT).toBe("Too many requests; try again in a minute.");
  });
});

describe("toolRateLimiter", () => {
  it("allows 60 calls a minute and rejects the 61st with a retry hint", () => {
    const c = clock();
    const l = toolRateLimiter({ now: c.now });
    for (let i = 0; i < 60; i++) expect(l.check("alice", "list_portfolio_accounts", false).allowed).toBe(true);
    const over = l.check("alice", "list_portfolio_accounts", false);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSeconds).toBeGreaterThan(0);
    expect(over.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("cached reads never count toward the refresh limit (Review Focus 4)", () => {
    const l = toolRateLimiter({ now: clock().now });
    for (let i = 0; i < 30; i++) expect(l.check("alice", "get_news", false).allowed).toBe(true);
    expect(l.refreshAvailable("alice", "get_news")).toBe(true);
  });

  it("allows 10 refresh-triggering calls a minute; the 11th is refused, ordinary calls still pass", () => {
    const l = toolRateLimiter({ now: clock().now });
    for (let i = 0; i < 10; i++) expect(l.check("alice", TOOL_LIMITS.refreshTools[i % 6], true).allowed).toBe(true);
    expect(l.check("alice", "get_news", true).allowed).toBe(false);
    expect(l.refreshAvailable("alice", "get_holdings")).toBe(false);
    expect(l.check("alice", "get_news", false).allowed).toBe(true);
  });

  it("split use: recordRefresh counts only toward the refresh window", () => {
    const l = toolRateLimiter({ now: clock().now });
    for (let i = 0; i < 10; i++) l.recordRefresh("alice", "show_allocation");
    expect(l.refreshAvailable("alice", "show_allocation")).toBe(false);
    for (let i = 0; i < 60; i++) expect(l.check("alice", "show_allocation", false).allowed).toBe(true);
  });

  it("refresh accounting ignores tools outside the refresh list", () => {
    const l = toolRateLimiter({ now: clock().now });
    for (let i = 0; i < 20; i++) expect(l.check("alice", "show_performance", true).allowed).toBe(true);
    expect(l.refreshAvailable("alice", "get_news")).toBe(true);
    expect(l.refreshAvailable("alice", "show_performance")).toBe(true);
  });

  it("limits are per subject", () => {
    const l = toolRateLimiter({ now: clock().now });
    for (let i = 0; i < 60; i++) l.check("alice", "get_news", false);
    for (let i = 0; i < 10; i++) l.recordRefresh("alice", "get_news");
    expect(l.check("alice", "get_news", false).allowed).toBe(false);
    expect(l.check("bob", "get_news", false).allowed).toBe(true);
    expect(l.refreshAvailable("bob", "get_news")).toBe(true);
  });

  it("the window slides", () => {
    const c = clock();
    const l = toolRateLimiter({ now: c.now });
    for (let i = 0; i < 30; i++) l.check("alice", "get_news", false);
    c.advance(30_000);
    for (let i = 0; i < 30; i++) l.check("alice", "get_news", false);
    expect(l.check("alice", "get_news", false).allowed).toBe(false);
    c.advance(30_001);
    // The first 30 have left the window; the second 30 are still in it.
    for (let i = 0; i < 30; i++) expect(l.check("alice", "get_news", false).allowed).toBe(true);
    expect(l.check("alice", "get_news", false).allowed).toBe(false);
  });

  it("is memory-bounded: subjects expire after the window", () => {
    const c = clock();
    const l = toolRateLimiter({ now: c.now });
    for (let i = 0; i < 200; i++) { l.check(`user-${i}`, "get_news", false); l.recordRefresh(`user-${i}`, "get_news"); }
    expect(l.size()).toBe(400);
    c.advance(2 * 60_000);
    l.check("late", "get_news", false);
    l.recordRefresh("late", "get_news");
    expect(l.size()).toBe(2);
  });
});
