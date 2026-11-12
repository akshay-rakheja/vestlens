import { describe, expect, it, vi } from "vitest";

import { createReportCardCache, REPORT_CACHE_MAX, REPORT_CACHE_TTL_MS } from "./report-cache.js";

// Synthetic subjects and values only.
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe("report card cache", () => {
  it("keeps a subject's report for 30 minutes, at most 200 subjects", () => {
    expect(REPORT_CACHE_TTL_MS).toBe(30 * 60_000);
    expect(REPORT_CACHE_MAX).toBe(200);
  });

  it("a second request within the TTL returns the stored report without computing", async () => {
    let t = 0;
    const cache = createReportCardCache<string>({ clock: () => t });
    const compute = vi.fn(async () => "card-1");
    expect(await cache.get("subject-a", compute)).toEqual({ value: "card-1", source: "computed" });
    t += REPORT_CACHE_TTL_MS - 1;
    expect(await cache.get("subject-a", compute)).toEqual({ value: "card-1", source: "cached" });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("computes again once the TTL has passed", async () => {
    let t = 0;
    const cache = createReportCardCache<string>({ clock: () => t });
    const compute = vi.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("new");
    await cache.get("subject-a", compute);
    t += REPORT_CACHE_TTL_MS;
    expect(await cache.get("subject-a", compute)).toEqual({ value: "new", source: "computed" });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("keeps subjects apart", async () => {
    const cache = createReportCardCache<string>();
    await cache.get("subject-a", async () => "a");
    expect(await cache.get("subject-b", async () => "b")).toEqual({ value: "b", source: "computed" });
    expect((await cache.get("subject-a", async () => "x")).value).toBe("a");
  });

  it("concurrent requests for one subject share one computation", async () => {
    const cache = createReportCardCache<string>();
    const d = deferred<string>();
    const compute = vi.fn(() => d.promise);
    const first = cache.get("subject-a", compute);
    const second = cache.get("subject-a", compute);
    d.resolve("card");
    expect(await first).toEqual({ value: "card", source: "computed" });
    expect(await second).toEqual({ value: "card", source: "shared" });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("a failed computation is not kept: both waiters see it fail, and the next request computes again", async () => {
    const cache = createReportCardCache<string>();
    const d = deferred<string>();
    const first = cache.get("subject-a", () => d.promise);
    const second = cache.get("subject-a", () => d.promise);
    d.reject(new Error("synthetic"));
    await expect(first).rejects.toThrow("synthetic");
    await expect(second).rejects.toThrow("synthetic");
    expect(await cache.get("subject-a", async () => "fresh")).toEqual({ value: "fresh", source: "computed" });
  });

  it("forget drops a subject's report, and an in-flight one isn't stored afterwards", async () => {
    const cache = createReportCardCache<string>();
    await cache.get("subject-a", async () => "a");
    cache.forget("subject-a");
    expect((await cache.get("subject-a", async () => "a2")).source).toBe("computed");
    const d = deferred<string>();
    const pending = cache.get("subject-b", () => d.promise);
    cache.forget("subject-b");
    d.resolve("b");
    await pending;
    expect((await cache.get("subject-b", async () => "b2")).value).toBe("b2");
  });

  it("holds at most the cap, dropping the oldest", async () => {
    const cache = createReportCardCache<string>({ max: 2 });
    for (const s of ["s1", "s2", "s3"]) await cache.get(s, async () => s);
    expect(cache.size()).toBe(2);
    expect((await cache.get("s1", async () => "again")).source).toBe("computed");
    expect((await cache.get("s3", async () => "again")).source).toBe("cached");
  });

  it("an unchanged data-version marker keeps the report; the marker is read on every hit", async () => {
    const version = vi.fn(async () => "2|2026-10-26T04:00:00.000Z|2026-10-26T04:05:00.000Z");
    const cache = createReportCardCache<string>({ version });
    const compute = vi.fn(async () => "card");
    await cache.get("subject-a", compute);
    expect(await cache.get("subject-a", compute)).toEqual({ value: "card", source: "cached" });
    expect(await cache.get("subject-a", compute)).toEqual({ value: "card", source: "cached" });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(version).toHaveBeenCalledTimes(3);
    expect(version).toHaveBeenCalledWith("subject-a");
  });

  it("a changed marker on a hit recomputes (another instance's delete, a sync, a new snapshot)", async () => {
    let marker = "2|a|s";
    const cache = createReportCardCache<string>({ version: async () => marker });
    const compute = vi.fn().mockResolvedValueOnce("before").mockResolvedValueOnce("after");
    await cache.get("subject-a", compute);
    marker = "1|a|s";
    expect(await cache.get("subject-a", compute)).toEqual({ value: "after", source: "computed" });
    expect(await cache.get("subject-a", compute)).toEqual({ value: "after", source: "cached" });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("a marker that can't be read is never trusted", async () => {
    const version = vi.fn().mockResolvedValueOnce("m").mockRejectedValueOnce(new Error("synthetic")).mockResolvedValue("m");
    const cache = createReportCardCache<string>({ version });
    const compute = vi.fn().mockResolvedValueOnce("one").mockResolvedValueOnce("two");
    await cache.get("subject-a", compute);
    expect(await cache.get("subject-a", compute)).toEqual({ value: "two", source: "computed" });
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

