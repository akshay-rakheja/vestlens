import { describe, expect, it, vi } from "vitest";
import { MarketDataService, MemoryMarketDataCache } from "./market-data-service.js";
import { MarketDataUnavailableError } from "./types.js";

const now = () => new Date("2026-10-15T15:00:00Z");
const points = [{ date: "2026-10-14", close: 10 }];
function setup(over: Partial<{ yahoo: any; stooq: any; quotes: any; fx: any }> = {}) {
  const yahoo = over.yahoo ?? { name: "yahoo", history: vi.fn(async () => points) };
  const stooq = over.stooq ?? { name: "stooq", history: vi.fn(async () => points) };
  const quotes = over.quotes ?? { name: "yahoo", quote: vi.fn(async (t: string) => ({ ticker: t, currency: "CAD", price: 11, previousClose: 10, asOf: "2026-10-15T15:00:00Z" })) };
  const fx = over.fx ?? { usdCad: vi.fn(async () => [{ date: "2026-10-14", close: 1.37 }]) };
  const service = new MarketDataService({ history: [yahoo, stooq], quotes, fx, cache: new MemoryMarketDataCache(), now, retryDelayMs: 0 });
  return { service, yahoo, stooq, quotes, fx };
}

describe("MarketDataService", () => {
  it("caches history for repeat calls", async () => {
    const { service, yahoo } = setup();
    await service.history("^GSPC", "2026-01-01", "2026-10-14");
    await service.history("^GSPC", "2026-01-01", "2026-10-14");
    expect(yahoo.history).toHaveBeenCalledTimes(1);
  });
  it("falls back to Stooq for indices after retrying Yahoo", async () => {
    const yahoo = { name: "yahoo", history: vi.fn(async () => { throw new MarketDataUnavailableError("yahoo", "http_429"); }) };
    const { service, stooq } = setup({ yahoo });
    await expect(service.history("^GSPC", "2026-01-01", "2026-10-14")).resolves.toEqual(points);
    expect(yahoo.history).toHaveBeenCalledTimes(2);
    expect(stooq.history).toHaveBeenCalledWith("^spx", "2026-01-01", "2026-10-14");
  });
  it("F3: securityHistory returns closes with Yahoo split events, cached", async () => {
    const yahoo = { name: "yahoo", history: vi.fn(), historyWithSplits: vi.fn(async () => ({ points, splits: [{ date: "2026-06-10", ratio: 10 }] })) };
    const { service } = setup({ yahoo });
    const r1 = await service.securityHistory("SYN", "2026-01-01", "2026-10-14");
    const r2 = await service.securityHistory("SYN", "2026-01-01", "2026-10-14");
    expect(r1).toEqual({ points, splits: [{ date: "2026-06-10", ratio: 10 }] });
    expect(r2).toEqual(r1);
    expect(yahoo.historyWithSplits).toHaveBeenCalledTimes(1);
    expect(yahoo.history).not.toHaveBeenCalled();
  });
  it("distributions are cached for a day under their own key; a non-payer's empty list is an answer; failures read as null, never a throw", async () => {
    const answer = { currency: "CAD", events: [{ date: "2026-06-10", amount: 0.5 }] };
    const yahoo = { name: "yahoo", history: vi.fn(async () => points), distributions: vi.fn(async () => answer) };
    const { service } = setup({ yahoo });
    await expect(service.distributions("SYN.TO", "2025-10-15", "2026-10-15")).resolves.toEqual(answer);
    await expect(service.distributions("SYN.TO", "2025-10-15", "2026-10-15")).resolves.toEqual(answer);
    expect(yahoo.distributions).toHaveBeenCalledTimes(1);
    // Not the price-history entry for the same range.
    await service.securityHistory("SYN.TO", "2025-10-15", "2026-10-15");
    expect(yahoo.history).toHaveBeenCalled();
    const empty = { name: "yahoo", history: vi.fn(), distributions: vi.fn(async () => ({ currency: "CAD", events: [] })) };
    await expect(setup({ yahoo: empty }).service.distributions("NONE", "2025-10-15", "2026-10-15")).resolves.toEqual({ currency: "CAD", events: [] });
    const failing = { name: "yahoo", history: vi.fn(), distributions: vi.fn(async () => { throw new MarketDataUnavailableError("yahoo", "timeout"); }) };
    await expect(setup({ yahoo: failing }).service.distributions("SYN", "2025-10-15", "2026-10-15")).resolves.toBeNull();
    expect(failing.distributions).toHaveBeenCalledTimes(2);
    await expect(setup().service.distributions("SYN", "2025-10-15", "2026-10-15")).resolves.toBeNull();
  });
  it("F3: a provider without split information yields splits null", async () => {
    const yahoo = { name: "yahoo", history: vi.fn(), historyWithSplits: vi.fn(async () => { throw new MarketDataUnavailableError("yahoo", "http_429"); }) };
    const { service } = setup({ yahoo });
    await expect(service.securityHistory("^GSPC", "2026-01-01", "2026-10-14")).resolves.toEqual({ points, splits: null });
  });
  it("a Yahoo 404 is reported as notFound (permanent) without trying the split-less fallback", async () => {
    const yahoo = { name: "yahoo", history: vi.fn(), historyWithSplits: vi.fn(async () => { throw new MarketDataUnavailableError("yahoo", "http_404"); }) };
    const { service } = setup({ yahoo });
    await expect(service.securityHistory("^GSPC", "2026-01-01", "2026-10-14")).resolves.toEqual({ points: [], splits: [], notFound: true });
  });
  it("an empty Yahoo series is reported as notFound", async () => {
    const yahoo = { name: "yahoo", history: vi.fn(), historyWithSplits: vi.fn(async () => ({ points: [], splits: [] })) };
    const { service } = setup({ yahoo });
    await expect(service.securityHistory("^GSPC", "2026-01-01", "2026-10-14")).resolves.toEqual({ points: [], splits: [], notFound: true });
  });
  it("F4: purgeExpiredCache delegates to the cache and never throws", async () => {
    const purgeExpired = vi.fn(async () => 3);
    const cache = Object.assign(new MemoryMarketDataCache(), { purgeExpired });
    const service = new MarketDataService({ history: [], quotes: { name: "q", quote: vi.fn() } as any, fx: { usdCad: vi.fn() } as any, cache, now, retryDelayMs: 0 });
    await expect(service.purgeExpiredCache()).resolves.toBe(3);
    expect(purgeExpired).toHaveBeenCalledWith(now());
    purgeExpired.mockRejectedValueOnce(new Error("db down"));
    await expect(service.purgeExpiredCache()).resolves.toBe(0);
  });
  it("returns null when every provider fails, without throwing", async () => {
    const fail = { name: "x", history: vi.fn(async () => { throw new MarketDataUnavailableError("x", "network"); }) };
    const { service } = setup({ yahoo: fail, stooq: fail });
    await expect(service.history("XEQT.TO", "2026-01-01", "2026-10-14")).resolves.toBeNull();
  });
  it("returns available quotes and omits failures", async () => {
    const quotes = { name: "yahoo", quote: vi.fn(async (t: string) => { if (t === "BAD") throw new MarketDataUnavailableError("yahoo", "malformed"); return { ticker: t, currency: "CAD", price: 2, previousClose: 1, asOf: "x" }; }) };
    const { service } = setup({ quotes });
    const result = await service.quotes(["VFV.TO", "BAD", "VFV.TO"]);
    expect([...result.keys()]).toEqual(["VFV.TO"]);
    expect(quotes.quote).toHaveBeenCalledTimes(1 + 2);
  });
  it("returns null FX when the Bank of Canada is unavailable", async () => {
    const fx = { usdCad: vi.fn(async () => { throw new MarketDataUnavailableError("bank_of_canada", "network"); }) };
    const { service } = setup({ fx });
    await expect(service.usdCad("2026-01-01", "2026-10-14")).resolves.toBeNull();
  });
});

const series = [{ date: "2026-10-14", close: 1.37 }];
function clockAt() {
  const clock = { t: new Date("2026-10-15T15:00:00Z") };
  return { now: () => clock.t, advance: (ms: number) => { clock.t = new Date(clock.t.getTime() + ms); } };
}
const okHistory = (name: string) => ({ name, history: vi.fn(async () => points) });
const failHistory = (name: string) => ({ name, history: vi.fn(async () => { throw new MarketDataUnavailableError(name, "network"); }) });
const okQuote = (t: string) => ({ ticker: t, currency: "CAD", price: 11, previousClose: 10, asOf: "x" });
function build(o: { history?: any[]; quotes?: any; fx?: any; cache?: any; failureTtlMs?: number } = {}) {
  const clock = clockAt();
  const quotes = o.quotes ?? { name: "yahoo", quote: vi.fn(async (t: string) => okQuote(t)) };
  const fx = o.fx ?? { usdCad: vi.fn(async () => series) };
  const cache = o.cache ?? new MemoryMarketDataCache();
  const service = new MarketDataService({
    history: o.history ?? [okHistory("yahoo"), okHistory("stooq")],
    quotes, fx, cache, now: clock.now, retryDelayMs: 0, failureTtlMs: o.failureTtlMs,
  });
  return { service, clock, quotes, fx, cache };
}

describe("MarketDataService hardening", () => {
  it("treats an empty FX series as unavailable and does not cache it", async () => {
    const fx = { usdCad: vi.fn(async () => []) as any };
    const { service, clock } = build({ fx });
    await expect(service.usdCad("2026-10-01", "2026-10-14")).resolves.toBeNull();
    fx.usdCad.mockImplementation(async () => series);
    clock.advance(60_001);
    await expect(service.usdCad("2026-10-01", "2026-10-14")).resolves.toEqual(series);
    expect(fx.usdCad).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["async get rejects", { get: async () => { throw new Error("db down"); }, set: async () => undefined }],
    ["get throws synchronously", { get: () => { throw new Error("db down"); }, set: async () => undefined }],
    ["async set rejects", { get: async () => null, set: async () => { throw new Error("db down"); } }],
    ["set throws synchronously", { get: async () => null, set: () => { throw new Error("db down"); } }],
  ])("tolerates a cache port where %s", async (_label, cache) => {
    const { service } = build({ cache });
    await expect(service.history("^GSPC", "2026-01-01", "2026-10-14")).resolves.toEqual(points);
    const quotes = await service.quotes(["VFV.TO"]);
    expect([...quotes.keys()]).toEqual(["VFV.TO"]);
    await expect(service.usdCad("2026-01-01", "2026-10-14")).resolves.toEqual(series);
  });

  it("refetches a quote after 5 minutes", async () => {
    const { service, quotes, clock } = build();
    await service.quotes(["VFV.TO"]);
    clock.advance(5 * 60_000 - 1);
    await service.quotes(["VFV.TO"]);
    expect(quotes.quote).toHaveBeenCalledTimes(1);
    clock.advance(1);
    await service.quotes(["VFV.TO"]);
    expect(quotes.quote).toHaveBeenCalledTimes(2);
  });

  it("keeps history for 24 hours and refetches after", async () => {
    const yahoo = okHistory("yahoo");
    const { service, clock } = build({ history: [yahoo] });
    await service.history("XEQT.TO", "2026-01-01", "2026-10-14");
    clock.advance(23 * 3_600_000);
    await service.history("XEQT.TO", "2026-01-01", "2026-10-14");
    expect(yahoo.history).toHaveBeenCalledTimes(1);
    clock.advance(3_600_000);
    await service.history("XEQT.TO", "2026-01-01", "2026-10-14");
    expect(yahoo.history).toHaveBeenCalledTimes(2);
  });

  it("never exceeds four concurrent quote requests", async () => {
    let active = 0;
    let max = 0;
    const quote = vi.fn(async (t: string) => {
      active++;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return okQuote(t);
    });
    const { service } = build({ quotes: { name: "yahoo", quote } });
    const tickers = Array.from({ length: 10 }, (_, i) => `T${i}.TO`);
    const result = await service.quotes(tickers);
    expect(result.size).toBe(10);
    expect(quote).toHaveBeenCalledTimes(10);
    expect(max).toBeLessThanOrEqual(4);
    expect(max).toBeGreaterThan(1);
  });

  it("never calls Stooq for a ticker with no Stooq mapping", async () => {
    const yahoo = { name: "yahoo", history: vi.fn(async () => { throw new MarketDataUnavailableError("yahoo", "http_500"); }) };
    const stooq = okHistory("stooq");
    const { service } = build({ history: [yahoo, stooq] });
    await expect(service.history("XEQT.TO", "2026-01-01", "2026-10-14")).resolves.toBeNull();
    expect(stooq.history).not.toHaveBeenCalled();
  });

  it("shares one provider call across concurrent identical history requests", async () => {
    const yahoo = okHistory("yahoo");
    const { service } = build({ history: [yahoo] });
    const [a, b] = await Promise.all([
      service.history("XEQT.TO", "2026-01-01", "2026-10-14"),
      service.history("XEQT.TO", "2026-01-01", "2026-10-14"),
    ]);
    expect(a).toEqual(points);
    expect(b).toEqual(points);
    expect(yahoo.history).toHaveBeenCalledTimes(1);
  });

  it("shares one quote call and one FX call across concurrent identical requests", async () => {
    const { service, quotes, fx } = build();
    await Promise.all([service.quotes(["VFV.TO"]), service.quotes(["VFV.TO"])]);
    await Promise.all([service.usdCad("a", "b"), service.usdCad("a", "b")]);
    expect(quotes.quote).toHaveBeenCalledTimes(1);
    expect(fx.usdCad).toHaveBeenCalledTimes(1);
  });

  it("suppresses repeat history loads for 60 seconds after a failure, then retries", async () => {
    const yahoo = failHistory("yahoo");
    const stooq = failHistory("stooq");
    const { service, clock } = build({ history: [yahoo, stooq] });
    await expect(service.history("^GSPC", "2026-01-01", "2026-10-14")).resolves.toBeNull();
    expect(yahoo.history).toHaveBeenCalledTimes(2);
    await expect(service.history("^GSPC", "2026-01-01", "2026-10-14")).resolves.toBeNull();
    expect(yahoo.history).toHaveBeenCalledTimes(2);
    clock.advance(59_999);
    await service.history("^GSPC", "2026-01-01", "2026-10-14");
    expect(yahoo.history).toHaveBeenCalledTimes(2);
    clock.advance(1);
    await service.history("^GSPC", "2026-01-01", "2026-10-14");
    expect(yahoo.history).toHaveBeenCalledTimes(4);
  });

  it("honours an injected failureTtlMs", async () => {
    const yahoo = failHistory("yahoo");
    const { service, clock } = build({ history: [yahoo], failureTtlMs: 1_000 });
    await service.history("XEQT.TO", "2026-01-01", "2026-10-14");
    clock.advance(1_000);
    await service.history("XEQT.TO", "2026-01-01", "2026-10-14");
    expect(yahoo.history).toHaveBeenCalledTimes(4);
  });

  it("never persists a failure marker to the cache", async () => {
    const cache = new MemoryMarketDataCache();
    const failing = build({ history: [failHistory("yahoo")], cache });
    await failing.service.history("XEQT.TO", "2026-01-01", "2026-10-14");
    const healthy = okHistory("yahoo");
    const { service } = build({ history: [healthy], cache });
    await expect(service.history("XEQT.TO", "2026-01-01", "2026-10-14")).resolves.toEqual(points);
    expect(healthy.history).toHaveBeenCalledTimes(1);
  });

  it("caches a range that includes today (Toronto) for 15 minutes only", async () => {
    const yahoo = okHistory("yahoo");
    const { service, clock, fx } = build({ history: [yahoo] });
    // 15:00Z is 11:00 in Toronto on 2026-10-15.
    await service.history("^GSPC", "2026-01-01", "2026-10-15");
    await service.usdCad("2026-01-01", "2026-10-15");
    clock.advance(15 * 60_000 - 1);
    await service.history("^GSPC", "2026-01-01", "2026-10-15");
    await service.usdCad("2026-01-01", "2026-10-15");
    expect(yahoo.history).toHaveBeenCalledTimes(1);
    expect(fx.usdCad).toHaveBeenCalledTimes(1);
    clock.advance(1);
    await service.history("^GSPC", "2026-01-01", "2026-10-15");
    await service.usdCad("2026-01-01", "2026-10-15");
    expect(yahoo.history).toHaveBeenCalledTimes(2);
    expect(fx.usdCad).toHaveBeenCalledTimes(2);
  });

  it("uses the Toronto date, not UTC, to decide whether a range includes today", async () => {
    const yahoo = okHistory("yahoo");
    const cache = new MemoryMarketDataCache();
    // 2026-10-16T02:00Z is still 2026-10-15 in Toronto, so a range ending 10-15 is "today".
    const service = new MarketDataService({ history: [yahoo], quotes: { name: "yahoo", quote: vi.fn() } as any, fx: { usdCad: vi.fn() } as any, cache, now: () => new Date("2026-10-16T02:00:00Z"), retryDelayMs: 0 });
    const set = vi.spyOn(cache, "set");
    await service.history("^GSPC", "2026-01-01", "2026-10-15");
    const [, , fetchedAt, expiresAt] = set.mock.calls[0]!;
    expect(expiresAt.getTime() - fetchedAt.getTime()).toBe(15 * 60_000);
  });
});

describe("MarketDataService.intraday", () => {
  const result = { points: [{ t: "2026-10-15T14:30:00.000Z", price: 10 }], sessionDate: "2026-10-15" };
  it("caches for 5 minutes per ticker and interval, with no Stooq fallback", async () => {
    let clock = now();
    const yahoo = { name: "yahoo", history: vi.fn(), intraday: vi.fn(async () => result) };
    const stooq = { name: "stooq", history: vi.fn(async () => points) };
    const service = new MarketDataService({ history: [yahoo, stooq], quotes: {} as any, fx: {} as any, cache: new MemoryMarketDataCache(), now: () => clock, retryDelayMs: 0 });
    await expect(service.intraday("SYN", "5m")).resolves.toEqual(result);
    await service.intraday("SYN", "5m");
    expect(yahoo.intraday).toHaveBeenCalledTimes(1);
    await service.intraday("SYN", "1h");
    expect(yahoo.intraday).toHaveBeenCalledTimes(2);
    clock = new Date(clock.getTime() + 5 * 60_000 + 1);
    await service.intraday("SYN", "5m");
    expect(yahoo.intraday).toHaveBeenCalledTimes(3);
    expect(stooq.history).not.toHaveBeenCalled();
  });
  it("returns null when the provider fails or has no bars", async () => {
    const failing = { name: "yahoo", history: vi.fn(), intraday: vi.fn(async () => { throw new MarketDataUnavailableError("yahoo", "http_429"); }) };
    const s1 = new MarketDataService({ history: [failing], quotes: {} as any, fx: {} as any, cache: new MemoryMarketDataCache(), now, retryDelayMs: 0 });
    await expect(s1.intraday("SYN", "5m")).resolves.toBeNull();
    const none = { name: "yahoo", history: vi.fn(), intraday: vi.fn(async () => ({ points: [], sessionDate: null })) };
    const s2 = new MarketDataService({ history: [none], quotes: {} as any, fx: {} as any, cache: new MemoryMarketDataCache(), now, retryDelayMs: 0 });
    await expect(s2.intraday("SYN", "5m")).resolves.toBeNull();
    const absent = new MarketDataService({ history: [{ name: "stooq", history: vi.fn() }], quotes: {} as any, fx: {} as any, cache: new MemoryMarketDataCache(), now, retryDelayMs: 0 });
    await expect(absent.intraday("SYN", "5m")).resolves.toBeNull();
  });

  it("profile is cached for 7 days under profile:<ticker>, failures return null", async () => {
    const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
    const profile = { kind: "stock" as const, sector: "Technology", country: "United States", sectorWeights: null, countryWeights: null, topHoldings: null };
    const yahoo = { name: "yahoo", history: vi.fn(), profile: vi.fn(async () => profile) };
    const mk = (y: any, c: any) => new MarketDataService({ history: [y], quotes: {} as any, fx: {} as any, cache: c, now, retryDelayMs: 0 });
    await expect(mk(yahoo, cache).profile("AAPL")).resolves.toEqual(profile);
    const [key, , fetchedAt, expiresAt] = cache.set.mock.calls[0] as unknown as [string, unknown, Date, Date];
    expect(key).toBe("profile:AAPL");
    expect(expiresAt.getTime() - fetchedAt.getTime()).toBe(7 * 24 * 3_600_000);
    const failing = { name: "yahoo", history: vi.fn(), profile: vi.fn(async () => null) };
    const memory = new MemoryMarketDataCache();
    await expect(mk(failing, memory).profile("ZZZ")).resolves.toBeNull();
    const none = { name: "stooq", history: vi.fn() };
    await expect(mk(none, memory).profile("ZZZ")).resolves.toBeNull();
  });
  it("cachedProfile reads the profile cache only and never calls a provider", async () => {
    const profile = { kind: "fund" as const, sector: null, country: null, sectorWeights: null, countryWeights: null, topHoldings: [{ symbol: "ZZCON", name: null, weight: 0.4 }] };
    const yahoo = { name: "yahoo", history: vi.fn(), profile: vi.fn(async () => profile) };
    const memory = new MemoryMarketDataCache();
    const svc = new MarketDataService({ history: [yahoo as any], quotes: {} as any, fx: {} as any, cache: memory, now, retryDelayMs: 0 });
    await expect(svc.cachedProfile("ZZETF")).resolves.toBeNull();
    expect(yahoo.profile).not.toHaveBeenCalled();
    await svc.profile("ZZETF");
    await expect(svc.cachedProfile("ZZETF")).resolves.toEqual(profile);
    expect(yahoo.profile).toHaveBeenCalledTimes(1);
  });
  it("an empty unknown profile is cached for 1 hour, not 7 days", async () => {
    const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
    const unknown = { kind: "unknown" as const, sector: null, country: null, sectorWeights: null, countryWeights: null, topHoldings: null };
    const svc = new MarketDataService({ history: [{ name: "yahoo", history: vi.fn(), profile: vi.fn(async () => unknown) } as any], quotes: {} as any, fx: {} as any, cache, now, retryDelayMs: 0 });
    await svc.profile("ZZZ");
    const [, , fetchedAt, expiresAt] = cache.set.mock.calls[0] as unknown as [string, unknown, Date, Date];
    expect(expiresAt.getTime() - fetchedAt.getTime()).toBe(3_600_000);
  });
});

describe("MarketDataService.cachedQuotes", () => {
  it("returns cached, unexpired quotes without calling the provider", async () => {
    const { service, quotes, clock } = build();
    await service.quotes(["VFV.TO"]);
    expect(quotes.quote).toHaveBeenCalledTimes(1);
    const hit = await service.cachedQuotes(["VFV.TO", "VFV.TO"]);
    expect([...hit.entries()]).toEqual([["VFV.TO", okQuote("VFV.TO")]]);
    clock.advance(5 * 60_000);
    expect((await service.cachedQuotes(["VFV.TO"])).size).toBe(0);
    expect(quotes.quote).toHaveBeenCalledTimes(1);
  });

  it("a miss returns nothing and never calls the provider or joins an in-flight load", async () => {
    let release!: () => void;
    const quotes = { name: "yahoo", quote: vi.fn(() => new Promise((resolve) => { release = () => resolve(okQuote("XEQT.TO")); })) };
    const { service } = build({ quotes });
    expect((await service.cachedQuotes(["VFV.TO"])).size).toBe(0);
    expect(quotes.quote).not.toHaveBeenCalled();
    const loading = service.quotes(["XEQT.TO"]);
    await vi.waitFor(() => expect(quotes.quote).toHaveBeenCalledTimes(1));
    expect((await service.cachedQuotes(["XEQT.TO"])).size).toBe(0);
    release();
    await loading;
    expect(quotes.quote).toHaveBeenCalledTimes(1);
  });

  it("tolerates a failing cache port (reads as a miss)", async () => {
    const { service, quotes } = build({ cache: { get: async () => { throw new Error("db down"); }, set: async () => undefined } });
    expect((await service.cachedQuotes(["VFV.TO"])).size).toBe(0);
    expect(quotes.quote).not.toHaveBeenCalled();
  });
});

describe("cache-only readers report known failures (rate-limit accounting)", () => {
  it("cachedQuotes maps a recently failed ticker to null (known: no fetch would happen) until the failure TTL ends", async () => {
    const quotes = { name: "yahoo", quote: vi.fn(async (t: string) => { if (t === "BAD") throw new Error("down"); return okQuote(t); }) };
    const { service, clock } = build({ quotes, failureTtlMs: 60_000 });
    await service.quotes(["BAD", "VFV.TO"]);
    const calls = quotes.quote.mock.calls.length;
    const known = await service.cachedQuotes(["BAD", "VFV.TO", "NEW"]);
    expect([...known.entries()]).toEqual([["BAD", null], ["VFV.TO", okQuote("VFV.TO")]]);
    clock.advance(60_001);
    expect((await service.cachedQuotes(["BAD"])).has("BAD")).toBe(false);
    expect(quotes.quote).toHaveBeenCalledTimes(calls);
  });

  it("cachedProfileLookup: hit, known failure (no provider data) and plain miss", async () => {
    const good = { kind: "fund" as const, sector: null, country: null, sectorWeights: { Tech: 1 }, countryWeights: null, topHoldings: null };
    const profile = vi.fn(async (t: string) => (t === "GOOD" ? good : null));
    const { service } = build({ history: [{ name: "yahoo", history: vi.fn(), profile }] });
    await service.profile("GOOD");
    await service.profile("NODATA");
    expect(await service.cachedProfileLookup("GOOD")).toEqual({ known: true, profile: good });
    expect(await service.cachedProfileLookup("NODATA")).toEqual({ known: true, profile: null });
    expect(await service.cachedProfileLookup("NEW")).toEqual({ known: false, profile: null });
    expect(profile).toHaveBeenCalledTimes(2);
    // The nightly reader keeps its contract: null on any miss.
    await expect(service.cachedProfile("NODATA")).resolves.toBeNull();
  });
});
