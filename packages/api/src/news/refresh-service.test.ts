import { describe, expect, it, vi } from "vitest";
import type { NewArticle, NewsFetcher, NewsFetchResult } from "./marketaux.js";
import { MemoryNewsStore } from "./store.js";
import { NewsRefreshService, newsSymbolsFromAccounts, torontoMarketOpen, type NewsSymbol } from "./refresh-service.js";

// 2026-10-21 is a Wednesday; 03:00 UTC is 23:00 the previous evening in Toronto (market closed).
const NOW = new Date("2026-10-21T03:00:00.000Z");
const TODAY = "2026-10-20"; // Toronto date of NOW
const hash = (s: string) => s.padEnd(64, "0").slice(0, 64);

const sym = (symbol: string, over: Partial<NewsSymbol> = {}): NewsSymbol => ({
  symbol, currency: "USD", isMover: false, isConstituent: false, usListed: false, ...over,
});

const article = (symbol: string, n: number): NewArticle => ({
  urlHash: hash(`${symbol}${n}`), url: `https://news.example/${symbol}/${n}`, headline: `${symbol} synthetic ${n}`,
  snippet: null, source: "synthetic.example", imageUrl: null, publishedAt: new Date(NOW.getTime() - n * 3_600_000),
  symbols: [symbol], fetchedAt: NOW,
});

function fakeFetcher(impl: (symbol: string, since: Date) => NewsFetchResult | Promise<NewsFetchResult> = (s) => ({ articles: [article(s, 1)], rateLimited: false, requests: 1 })) {
  const fetchForSymbol = vi.fn(async (symbol: string, since: Date, _o?: { pageSize?: number; maxPages?: number }) => impl(symbol, since));
  return { fetcher: { fetchForSymbol } as NewsFetcher, fetchForSymbol };
}

function closes(n: number) {
  return Array.from({ length: n }, (_, i) => ({ date: new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString().slice(0, 10), close: 10 + (i % 3) }));
}

function setup(over: { budget?: number; now?: () => Date; marketaux?: NewsFetcher; edgar?: NewsFetcher; store?: MemoryNewsStore } = {}) {
  const store = over.store ?? new MemoryNewsStore();
  const marketaux = over.marketaux ? { fetcher: over.marketaux, fetchForSymbol: over.marketaux.fetchForSymbol as ReturnType<typeof fakeFetcher>["fetchForSymbol"] } : fakeFetcher();
  const edgar = over.edgar ? { fetcher: over.edgar, fetchForSymbol: over.edgar.fetchForSymbol as ReturnType<typeof fakeFetcher>["fetchForSymbol"] } : fakeFetcher(() => ({ articles: [], rateLimited: false }));
  const rateUnrated = vi.fn(async (_o: { symbols: string[]; companyName: (s: string) => string; deadline: Date; maxPerRun: number }) => ({ rated: 2, failed: 0 }));
  const history = vi.fn(async (_t: string, _from: string, _to: string) => closes(40));
  const logs: object[] = [];
  const budget = over.budget ?? 90;
  const service = new NewsRefreshService({
    store, marketaux: marketaux.fetcher, edgar: edgar.fetcher, rater: { rateUnrated }, market: { history },
    budget, freeTier: budget <= 100, now: over.now ?? (() => NOW), log: (e) => logs.push(e),
  });
  return { service, store, marketaux, edgar, rateUnrated, history, logs };
}

describe("torontoMarketOpen", () => {
  it("is open on a Toronto weekday from 09:30 to 16:00 only", () => {
    expect(torontoMarketOpen(new Date("2026-10-21T13:29:00Z"))).toBe(false); // 09:29 EDT
    expect(torontoMarketOpen(new Date("2026-10-21T13:30:00Z"))).toBe(true); // 09:30 EDT
    expect(torontoMarketOpen(new Date("2026-10-21T19:59:00Z"))).toBe(true); // 15:59 EDT
    expect(torontoMarketOpen(new Date("2026-10-21T20:00:00Z"))).toBe(false); // 16:00 EDT
    expect(torontoMarketOpen(new Date("2026-10-24T15:00:00Z"))).toBe(false); // Saturday
  });
});

describe("NewsRefreshService.refreshSymbols", () => {
  it("fetches several symbols at once so slow providers leave time to rate (live run: 32 sequential fetches ate the 60 s)", async () => {
    let t = NOW.getTime();
    let inFlight = 0; let peak = 0;
    // Each fetch "takes" 3 s of the injected clock; sequential fetching of 8 symbols would need 24 s.
    const marketaux = fakeFetcher(async (s) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await Promise.resolve(); t += 3_000; inFlight -= 1;
      return { articles: [article(s, 1)], rateLimited: false, requests: 1 };
    });
    const { service, rateUnrated } = setup({ marketaux: marketaux.fetcher, now: () => new Date(t) });
    const r = await service.refreshSymbols(Array.from({ length: 8 }, (_, i) => sym(`ZZ${i}`)));
    expect(peak).toBeGreaterThanOrEqual(4);
    expect(r.fetched).toBe(8);
    expect(rateUnrated).toHaveBeenCalledTimes(1);
  });
  it("plans, fetches, upserts, marks fetched, charges the budget with actual requests and rates", async () => {
    const marketaux = fakeFetcher((s) => ({ articles: [article(s, 1), article(s, 2)], rateLimited: false, requests: 2 }));
    const { service, store, rateUnrated } = setup({ marketaux: marketaux.fetcher });
    const r = await service.refreshSymbols([sym("ZZTEST"), sym("ZZALT", { currency: "CAD" })]);
    expect(r).toEqual({ fetched: 4, rated: 2, skipped: 0, failures: 0, budgetLeft: 86 });
    expect(await store.budgetSpent(TODAY)).toBe(4);
    expect(await store.latestFetch("ZZTEST")).toEqual(NOW);
    expect((await store.articlesForSymbols(["ZZTEST"], new Date(0))).length).toBe(2);
    expect(rateUnrated).toHaveBeenCalledTimes(1);
    expect(rateUnrated.mock.calls[0][0].symbols.sort()).toEqual(["ZZALT", "ZZTEST"]);
    // free tier: 7-day window
    expect(marketaux.fetchForSymbol.mock.calls[0][1]).toEqual(new Date(NOW.getTime() - 7 * 86_400_000));
  });

  it("falls back to the plan estimate when the fetcher reports no request count", async () => {
    const marketaux = fakeFetcher((s) => ({ articles: [article(s, 1)], rateLimited: false }));
    const { service, store } = setup({ marketaux: marketaux.fetcher });
    await service.refreshSymbols([sym("ZZTEST.TO", { currency: "CAD" })]);
    expect(await store.budgetSpent(TODAY)).toBe(1); // free tier: 1 page × 1 alias
  });

  it("uses EDGAR for US-listed symbols only", async () => {
    const edgar = fakeFetcher((s) => ({ articles: [{ ...article(s, 9), source: "SEC EDGAR" }], rateLimited: false }));
    const { service, store } = setup({ edgar: edgar.fetcher });
    const r = await service.refreshSymbols([sym("ZZUS", { usListed: true }), sym("ZZCA.TO", { currency: "CAD" })]);
    expect(edgar.fetchForSymbol).toHaveBeenCalledTimes(1);
    expect(edgar.fetchForSymbol.mock.calls[0][0]).toBe("ZZUS");
    expect(r.fetched).toBe(3);
    expect((await store.articlesForSymbols(["ZZUS"], new Date(0))).length).toBe(2);
  });

  it("stops fetching once the day's budget is spent but still rates cached unrated articles", async () => {
    const store = new MemoryNewsStore();
    await store.spendBudget(TODAY, 90);
    await store.upsertArticles([article("ZZTEST", 3)]);
    const { service, marketaux, edgar, rateUnrated } = setup({ store });
    const r = await service.refreshSymbols([sym("ZZTEST", { usListed: true })]);
    expect(marketaux.fetchForSymbol).not.toHaveBeenCalled();
    expect(edgar.fetchForSymbol).not.toHaveBeenCalled();
    expect(rateUnrated).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ fetched: 0, rated: 2, skipped: 1, budgetLeft: 0 });
  });

  it("stops planning further fetches when the running total reaches the budget mid-run", async () => {
    const marketaux = fakeFetcher((s) => ({ articles: [article(s, 1)], rateLimited: false, requests: 3 }));
    const { service, store } = setup({ budget: 4, marketaux: marketaux.fetcher });
    const r = await service.refreshSymbols([sym("ZZA"), sym("ZZB"), sym("ZZC")]);
    // With fetches in flight, the budget check runs per worker: no NEW fetch starts once the total reaches the
    // budget, but the ones already started finish. Over-spend is bounded by the in-flight count.
    expect(marketaux.fetchForSymbol.mock.calls.length).toBeLessThanOrEqual(3);
    expect(await store.budgetSpent(TODAY)).toBeGreaterThanOrEqual(4);
    expect(r.budgetLeft).toBe(0);
  });

  it("passes the planned page size and page count to the fetcher (free tier: 1 page; paid: 3)", async () => {
    const free = setup();
    await free.service.refreshSymbols([sym("ZZA")]);
    expect(free.marketaux.fetchForSymbol.mock.calls[0][2]).toEqual({ pageSize: 3, maxPages: 1 });
    const paid = setup({ budget: 500 });
    await paid.service.refreshSymbols([sym("ZZA")]);
    expect(paid.marketaux.fetchForSymbol.mock.calls[0][2]).toEqual({ pageSize: 20, maxPages: 3 });
  });

  it("a throttle stops this run's fetching without consuming the day's budget", async () => {
    const marketaux = fakeFetcher(() => ({ articles: [], rateLimited: true, limit: "throttle", requests: 1 }));
    const { service, store } = setup({ marketaux: marketaux.fetcher });
    const r = await service.refreshSymbols([sym("ZZA"), sym("ZZB")]);
    // Both symbols may start together; neither is marked fetched after a throttle and the day is not burned.
    expect(marketaux.fetchForSymbol.mock.calls.length).toBeLessThanOrEqual(2);
    expect(await store.budgetSpent(TODAY)).toBeLessThanOrEqual(2);
    expect(await store.latestFetch("ZZA")).toBeNull();
    expect(await store.latestFetch("ZZB")).toBeNull();
    expect(r.budgetLeft).toBeGreaterThanOrEqual(88);
  });

  it("daily exhaustion consumes the rest of the day's budget and does not mark the symbol fetched", async () => {
    const marketaux = fakeFetcher(() => ({ articles: [], rateLimited: true, limit: "daily", requests: 1 }));
    const { service, store } = setup({ marketaux: marketaux.fetcher });
    const r = await service.refreshSymbols([sym("ZZA"), sym("ZZB")]);
    expect(marketaux.fetchForSymbol.mock.calls.length).toBeLessThanOrEqual(2);
    expect(await store.latestFetch("ZZA")).toBeNull();
    expect(r.budgetLeft).toBe(0);
  });

  it("counts a failing symbol, charges the estimate and continues", async () => {
    const marketaux = fakeFetcher((s) => { if (s === "ZZA") throw new Error("synthetic"); return { articles: [article(s, 1)], rateLimited: false, requests: 1 }; });
    const { service, store } = setup({ marketaux: marketaux.fetcher });
    const r = await service.refreshSymbols([sym("ZZA"), sym("ZZB")]);
    expect(r).toMatchObject({ fetched: 1, failures: 1 });
    expect(await store.budgetSpent(TODAY)).toBe(2);
  });

  it("refreshes symbol stats from 90 days of history for every symbol, budget or not", async () => {
    const store = new MemoryNewsStore();
    await store.spendBudget(TODAY, 90);
    const { service, history } = setup({ store });
    await service.refreshSymbols([sym("ZZTEST"), sym("ZZTEST", { currency: "CAD", kind: "stock" }), sym("ZZCOIN", { currency: "CAD", kind: "crypto" })]);
    expect(history).toHaveBeenCalledWith("ZZTEST", "2026-07-22", TODAY);
    expect(history).toHaveBeenCalledWith("ZZCOIN-CAD", "2026-07-22", TODAY);
    const stats = await store.stats(["ZZTEST", "ZZCOIN"]);
    expect(stats.map((s) => `${s.symbol}|${s.currency}`).sort()).toEqual(["ZZCOIN|CAD", "ZZTEST|CAD", "ZZTEST|USD"]);
    expect(stats.find((s) => s.symbol === "ZZTEST")).toMatchObject({ closes: 40, updatedAt: NOW });
  });

  it("skips stats for ETF constituents (fetched for news only)", async () => {
    const { service, history, store } = setup();
    await service.refreshSymbols([sym("ZZTEST"), sym("ZZCON", { isConstituent: true })]);
    expect(history).toHaveBeenCalledWith("ZZTEST", expect.any(String), expect.any(String));
    expect(history).not.toHaveBeenCalledWith("ZZCON", expect.anything(), expect.anything());
    expect(await store.stats(["ZZCON"])).toEqual([]);
  });

  it("bounds the rater by the deadline, not a per-call estimate: on demand up to 20, nightly up to 200", async () => {
    const { service, rateUnrated } = setup();
    await service.refreshSymbols([sym("ZZA")], { budgetMs: 5_000 });
    expect(rateUnrated.mock.calls[0][0]).toMatchObject({ deadline: new Date(NOW.getTime() + 5_000), maxPerRun: 20 });
    await service.refreshAll(async () => [{ symbols: [sym("ZZA")] }]);
    expect(rateUnrated.mock.calls[1][0]).toMatchObject({ deadline: new Date(NOW.getTime() + 50_000), maxPerRun: 200 });
  });

  it("rates a 40-article backlog fully within one nightly run when Jev answers in 200 ms", async () => {
    const store = new MemoryNewsStore();
    await store.upsertArticles(Array.from({ length: 40 }, (_, i) => article("ZZA", i + 101))); // distinct url hashes
    let t = NOW.getTime();
    const now = () => new Date(t);
    const jev = { model: "jev-test", rate: vi.fn(async () => { t += 200; await Promise.resolve(); return { relevant: 0.9, sentiment: { score: 2, confidence: 0.8 }, materiality: { score: 1, confidence: 0.8 }, eventType: { choice: "other", confidence: 0.8 }, credible: 0.9, clickbait: 0.1, duplicates: {} }; }) };
    const { rateUnrated: real } = await import("./rater.js");
    const marketaux = fakeFetcher(() => ({ articles: [], rateLimited: false, requests: 1 }));
    const service = new NewsRefreshService({
      store, marketaux: marketaux.fetcher, edgar: fakeFetcher(() => ({ articles: [], rateLimited: false })).fetcher,
      rater: { rateUnrated: (o) => real({ store, jev, now, log: () => {}, ...o }) },
      market: { history: async () => closes(40) }, budget: 90, freeTier: true, now, log: () => {},
    });
    const r = await service.refreshAll(async () => [{ symbols: [sym("ZZA")] }]);
    expect(r.rated).toBe(40);
    expect(jev.rate).toHaveBeenCalledTimes(40);
    expect(await store.unratedFor(["ZZA"], new Date(0))).toEqual([]);
  });

  it("orders the work fetch → rate → stats", async () => {
    const order: string[] = [];
    const marketaux = fakeFetcher((s) => { order.push("fetch"); return { articles: [article(s, 1)], rateLimited: false, requests: 1 }; });
    const { service, rateUnrated, history } = setup({ marketaux: marketaux.fetcher });
    rateUnrated.mockImplementation(async () => { order.push("rate"); return { rated: 0, failed: 0 }; });
    history.mockImplementation(async () => { order.push("stats"); return closes(40); });
    await service.refreshSymbols([sym("ZZA")]);
    expect(order).toEqual(["fetch", "rate", "stats"]);
  });

  it("passes holdings names to the rater and falls back to the symbol", async () => {
    const { service, rateUnrated } = setup();
    await service.refreshSymbols([sym("ZZA", { name: "Zz Alpha Synthetic Inc" }), sym("ZZB")]);
    const { companyName } = rateUnrated.mock.calls[0][0];
    expect(companyName("ZZA")).toBe("Zz Alpha Synthetic Inc");
    expect(companyName("ZZB")).toBe("ZZB");
  });

  it("logs only counts, latency and budget state", async () => {
    const { service, logs } = setup();
    await service.refreshSymbols([sym("ZZA", { name: "Zz Alpha Synthetic Inc" })]);
    const text = JSON.stringify(logs);
    expect(text).toContain('"event":"news_refresh"');
    expect(text).not.toContain("Zz Alpha");
    expect(text).not.toContain("synthetic 1");
  });
});

describe("NewsRefreshService.refreshAll", () => {
  it("dedupes symbols across users", async () => {
    const { service, marketaux, history } = setup();
    const r = await service.refreshAll(async () => [
      { symbols: [sym("ZZA"), sym("ZZB")] },
      { symbols: [sym("ZZA", { isMover: true }), sym("ZZC")] },
    ]);
    expect(r).toMatchObject({ users: 2, symbols: 3, failures: 0 });
    expect(marketaux.fetchForSymbol).toHaveBeenCalledTimes(3);
    expect(marketaux.fetchForSymbol.mock.calls[0][0]).toBe("ZZA"); // the mover goes first
    expect(history).toHaveBeenCalledTimes(3);
  });

  it("adds ETF constituents from cached profiles only (no profile fetch), after held symbols and within the cap (M10)", async () => {
    const store = new MemoryNewsStore();
    const marketaux = fakeFetcher((s) => ({ articles: [article(s, 1)], rateLimited: false, requests: 1 }));
    const cachedProfile = vi.fn(async (t: string) => (t === "ZZETF"
      ? { kind: "fund" as const, sector: null, country: null, sectorWeights: null, countryWeights: null, topHoldings: [{ symbol: "zzcon", name: null, weight: 0.4 }, { symbol: "ZZA", name: null, weight: 0.3 }, { symbol: "ZZETF", name: null, weight: 0.1 }] }
      : null));
    const rateUnrated = vi.fn(async (_o: { symbols: string[] }) => ({ rated: 0, failed: 0 }));
    const history = vi.fn(async (_t: string, _from: string, _to: string) => closes(40));
    const service = new NewsRefreshService({
      store, marketaux: marketaux.fetcher, edgar: fakeFetcher(() => ({ articles: [], rateLimited: false })).fetcher, rater: { rateUnrated },
      market: { history, cachedProfile }, budget: 90, freeTier: true, now: () => NOW, log: () => {},
    });
    const r = await service.refreshAll(async () => [{ symbols: [sym("ZZA"), sym("ZZETF", { currency: "CAD", kind: "etf" })] }]);
    expect(cachedProfile).toHaveBeenCalledWith("ZZETF"); // the same ticker the news view reads profiles under
    expect(r.symbols).toBe(3);
    expect(marketaux.fetchForSymbol.mock.calls.map((c) => c[0]).sort()).toEqual(["ZZA", "ZZCON", "ZZETF"]);
    expect(rateUnrated.mock.calls[0][0].symbols.sort()).toEqual(["ZZA", "ZZCON", "ZZETF"]);
    expect(history.mock.calls.map((c) => c[0])).not.toContain("ZZCON"); // constituents: news only
    // the cap keeps held symbols first
    cachedProfile.mockClear();
    const many = Array.from({ length: 199 }, (_, i) => sym(`ZZ${String(i).padStart(3, "0")}`));
    const capped = await service.refreshAll(async () => [{ symbols: [...many, sym("ZZETF", { currency: "CAD", kind: "etf" })] }]);
    expect(capped.symbols).toBe(200);
    expect(rateUnrated.mock.calls[1][0].symbols).not.toContain("ZZCON");
  });

  it("caps the run at 200 symbols", async () => {
    const { service, history } = setup({ budget: 10_000 });
    const many = Array.from({ length: 250 }, (_, i) => sym(`ZZ${String(i).padStart(3, "0")}`));
    const r = await service.refreshAll(async () => [{ symbols: many }]);
    expect(r.symbols).toBe(200);
    expect(history).toHaveBeenCalledTimes(200);
  });

  it("stops starting new fetches past the 60 s deadline", async () => {
    let t = NOW.getTime();
    const marketaux = fakeFetcher((s) => { t += 25_000; return { articles: [article(s, 1)], rateLimited: false, requests: 1 }; });
    const { service, rateUnrated } = setup({ marketaux: marketaux.fetcher, now: () => new Date(t) });
    const r = await service.refreshAll(async () => [{ symbols: [sym("ZZA"), sym("ZZB"), sym("ZZC"), sym("ZZD")] }]);
    expect(marketaux.fetchForSymbol).toHaveBeenCalledTimes(3); // 0, 25, 50 s start; 75 s is past
    expect(r).toMatchObject({ fetched: 3, skipped: 1 });
    expect(rateUnrated).not.toHaveBeenCalled(); // past the deadline nothing new starts
    expect(r.failures).toBe(0);
  });

  it("skips stats when no time is left", async () => {
    let t = NOW.getTime();
    const marketaux = fakeFetcher((s) => { t += 70_000; return { articles: [article(s, 1)], rateLimited: false, requests: 1 }; });
    const { service, history } = setup({ marketaux: marketaux.fetcher, now: () => new Date(t) });
    await service.refreshSymbols([sym("ZZA")]);
    expect(history).not.toHaveBeenCalled();
  });

  it("fills the 200 cap by movers first, then holder count, then stalest fetch", async () => {
    const store = new MemoryNewsStore();
    const fresh = new Date(NOW.getTime() - 3_600_000);
    const stale = new Date(NOW.getTime() - 48 * 3_600_000);
    const filler = Array.from({ length: 197 }, (_, i) => sym(`ZZF${String(i).padStart(3, "0")}`));
    for (const f of filler) await store.markFetched(f.symbol, fresh);
    await store.markFetched("ZZOLD", stale);
    await store.markFetched("ZZNEW", fresh);
    const { service, history } = setup({ store, budget: 10_000 });
    const r = await service.refreshAll(async () => [
      { symbols: [...filler, sym("ZZNEW"), sym("ZZOLD"), sym("ZZPOP")] },
      { symbols: [sym("ZZPOP"), sym("ZZMOVE", { isMover: true })] },
    ]);
    expect(r.symbols).toBe(200);
    const tickers = history.mock.calls.map((c) => c[0]);
    expect(tickers).toEqual(expect.arrayContaining(["ZZMOVE", "ZZPOP", "ZZOLD"]));
    expect(tickers).not.toContain("ZZNEW");
  });

  it("honours a tighter caller budget", async () => {
    let t = NOW.getTime();
    const marketaux = fakeFetcher((s) => { t += 10_000; return { articles: [article(s, 1)], rateLimited: false, requests: 1 }; });
    const { service } = setup({ marketaux: marketaux.fetcher, now: () => new Date(t) });
    await service.refreshAll(async () => [{ symbols: [sym("ZZA"), sym("ZZB"), sym("ZZC")] }], { budgetMs: 15_000 });
    expect(marketaux.fetchForSymbol).toHaveBeenCalledTimes(2);
  });

  it("runs the retention sweep after the step and logs only its counts (on-demand refreshes never sweep)", async () => {
    const store = new MemoryNewsStore();
    await store.upsertArticles([{ ...article("ZZOLD", 1), publishedAt: new Date(NOW.getTime() - 91 * 86_400_000) }]);
    const sweep = vi.spyOn(store, "sweep");
    const { service, logs } = setup({ store });
    await service.refreshSymbols([sym("ZZA")]);
    expect(sweep).not.toHaveBeenCalled();
    await service.refreshAll(async () => [{ symbols: [sym("ZZA")] }]);
    expect(sweep).toHaveBeenCalledWith(NOW);
    expect(logs).toContainEqual({ event: "news_sweep", articles: 1, deliveries: 0, events: 0 });
    expect(await store.articlesForSymbols(["ZZOLD"], new Date(0))).toEqual([]);
    sweep.mockRejectedValueOnce(new Error("synthetic"));
    expect((await service.refreshAll(async () => [{ symbols: [sym("ZZA")] }])).failures).toBe(1);
  });

  // 2026-10-22: every nightly run reported 2–3 news failures with no way to tell which step
  // failed, and the new nightly-failures alert emailed on each. The log names the step (counts
  // only, never tickers) and the named counts add up to the total.
  it("logs which step each failure came from, counts only, adding up to the total", async () => {
    const { service, rateUnrated, history, logs } = setup();
    history.mockResolvedValueOnce([]);
    history.mockRejectedValueOnce(new Error("synthetic"));
    rateUnrated.mockRejectedValueOnce(new Error("synthetic"));
    const r = await service.refreshSymbols([sym("ZZA"), sym("ZZB"), sym("ZZC")]);
    const entry = logs.find((e: any) => e.event === "news_refresh") as any;
    expect(entry.failureCodes).toEqual({ stats_error: 1, rating_error: 1 });
    expect(entry.statsNoHistory).toBe(1);
    expect(Object.values(entry.failureCodes as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(r.failures);
    expect(JSON.stringify(entry)).not.toMatch(/ZZ[ABC]/);
    const clean = setup();
    await clean.service.refreshSymbols([sym("ZZA")]);
    expect((clean.logs.find((e: any) => e.event === "news_refresh") as any).failureCodes).toEqual({});
  });

  it("treats a few symbols without price history as expected, and every symbol missing as an outage", async () => {
    const some = setup();
    some.history.mockResolvedValueOnce([]);
    const partial = await some.service.refreshSymbols([sym("ZZA"), sym("ZZB")]);
    expect(partial.failures).toBe(0);
    const all = setup();
    all.history.mockResolvedValue(null as never);
    const outage = await all.service.refreshSymbols([sym("ZZA"), sym("ZZB")]);
    expect(outage.failures).toBe(1);
    expect((all.logs.find((e: any) => e.event === "news_refresh") as any).failureCodes).toEqual({ stats_unavailable: 1 });
  });

  it("counts failures instead of throwing", async () => {
    const { service, rateUnrated, history } = setup();
    history.mockRejectedValueOnce(new Error("synthetic"));
    rateUnrated.mockRejectedValueOnce(new Error("synthetic"));
    const r = await service.refreshAll(async () => [{ symbols: [sym("ZZA")] }]);
    expect(r.failures).toBe(2);
    const bad = await setup().service.refreshAll(async () => { throw new Error("synthetic"); });
    expect(bad).toMatchObject({ users: 0, symbols: 0, failures: 1 });
  });
});

describe("newsSymbolsFromAccounts", () => {
  const account = (id: string, positions: Array<{ symbol: string; kind: string; currency: string; description?: string | null; units?: number }>, over: Record<string, unknown> = {}) => ({
    id,
    classification: { includedInPortfolioTotal: true, isClosed: false, group: "registered", bucket: "tfsa", label: "TFSA" },
    balances: [],
    positions: positions.map((p) => ({ instrumentId: p.symbol, kind: p.kind, symbol: p.symbol, description: p.description ?? null, units: p.units ?? 1, price: 1, costBasis: 1, marketValue: 1, unrealizedGain: 0, currency: p.currency, cashEquivalent: false })),
    ...over,
  });

  it("aggregates stock-like holdings per symbol and currency with names and US listing", () => {
    const rows = newsSymbolsFromAccounts([
      account("a1", [{ symbol: "ZZUS", kind: "stock", currency: "USD", description: "Zz US Synthetic Corp" }, { symbol: "ZZCA.TO", kind: "etf", currency: "CAD" }]),
      account("a2", [{ symbol: "ZZUS", kind: "stock", currency: "USD" }, { symbol: "ZZOPT", kind: "option", currency: "USD" }, { symbol: "ZZFUND", kind: "mutualfund", currency: "CAD" }]),
      account("closed", [{ symbol: "ZZGONE", kind: "stock", currency: "USD" }], { classification: { includedInPortfolioTotal: false, isClosed: true, group: "closed", bucket: "tfsa", label: "x" } }),
    ] as never);
    expect(rows.sort((a, b) => a.symbol.localeCompare(b.symbol))).toEqual([
      { symbol: "ZZCA.TO", currency: "CAD", kind: "etf", name: null, isMover: false, isConstituent: false, usListed: false },
      { symbol: "ZZUS", currency: "USD", kind: "stock", name: "Zz US Synthetic Corp", isMover: false, isConstituent: false, usListed: true },
    ]);
  });
});

describe("NewsRefreshService calendar projection (nightly only)", () => {
  const rating = (articleId: string, symbol: string, over: Record<string, unknown> = {}) => ({
    articleId, symbol, model: "jev-test", ratedAt: NOW, relevant: 0.9, sentiment: 2, sentimentConfidence: 0.8, materiality: 2,
    eventType: "earnings", eventConfidence: 0.8, credible: 0.9, clickbait: 0.1, duplicateOf: null, ...over,
  });
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const withFilings = (filingDates: (s: string) => Promise<Date[]>) => {
    const base = fakeFetcher(() => ({ articles: [], rateLimited: false }));
    const fn = vi.fn(filingDates);
    return { edgar: { ...base.fetcher, filingDates: fn }, filingDates: fn };
  };
  async function seedArticle(store: MemoryNewsStore, symbol: string, headline: string, over: Record<string, unknown> = {}) {
    const [a] = await store.upsertArticles([{ ...article(symbol, 5), urlHash: hash(`${symbol}${headline}`), headline }]);
    await store.putRatings([rating(a!.id, symbol, over) as never]);
    return a!;
  }
  const all = (store: MemoryNewsStore, symbols: string[]) => store.events(symbols, day("2025-01-01"), day("2027-12-31"));

  it("US names: next earnings from 10-Q/10-K dates, confirmed by an earnings article date; TSX names: article dates only, expected", async () => {
    const store = new MemoryNewsStore();
    await seedArticle(store, "ZZUS", "ZZUS to post Q3 results on Nov 4");
    await seedArticle(store, "ZZCA.TO", "ZZCA third-quarter results on November 12, 2026");
    await seedArticle(store, "ZZCA.TO", "ZZCA may 12 percent rally on Nov 20", { eventType: "other" });
    const { edgar, filingDates } = withFilings(async () => [day("2026-02-05"), day("2026-05-07"), day("2026-08-06")]);
    const { service } = setup({ store, edgar: edgar as never });
    const r = await service.refreshAll(async () => [{ symbols: [sym("ZZUS", { usListed: true }), sym("ZZCA.TO", { currency: "CAD" })] }]);
    expect(r.failures).toBe(0);
    expect(filingDates.mock.calls.map((c) => c[0])).toEqual(["ZZUS"]);
    expect(await all(store, ["ZZUS", "ZZCA.TO"])).toEqual([
      { id: "earnings:ZZUS:2026-11-04", symbol: "ZZUS", kind: "earnings", date: day("2026-11-04"), status: "confirmed", source: "article", amountPerUnit: null, currency: null },
      { id: "earnings:ZZCA.TO:2026-11-12", symbol: "ZZCA.TO", kind: "earnings", date: day("2026-11-12"), status: "expected", source: "article", amountPerUnit: null, currency: null },
    ]);
  });

  it("never projects or stores dividend events: those are per user, built at read time (I2)", async () => {
    const { service, store } = setup();
    await service.refreshAll(async () => [{ symbols: [sym("ZZDIV", { currency: "CAD" })] }, { symbols: [sym("ZZDIV", { currency: "CAD" })] }]);
    expect((await all(store, ["ZZDIV"])).filter((e) => e.kind === "dividend_pay")).toEqual([]);
  });

  it("confirmed needs an earnings-typed article (confidence >= 0.5) whose date is within 3 days of the filing projection (I4)", async () => {
    const filings = async () => [day("2026-02-05"), day("2026-05-07"), day("2026-08-06")]; // projects 2026-11-05
    const run = async (seedFn: (store: MemoryNewsStore) => Promise<unknown>, symbols = [sym("ZZUS", { usListed: true })], edgarFilings = filings) => {
      const store = new MemoryNewsStore();
      await seedFn(store);
      const { edgar } = withFilings(edgarFilings);
      await setup({ store, edgar: edgar as never }).service.refreshAll(async () => [{ symbols }]);
      return (await all(store, symbols.map((s) => s.symbol))).map((e) => [e.id, e.status, e.source]);
    };
    // a low-confidence earnings label is not evidence
    expect(await run((st) => seedArticle(st, "ZZUS", "ZZUS results on Nov 4", { eventConfidence: 0.4 }))).toEqual([["earnings:ZZUS:2026-11-05", "expected", "edgar"]]);
    // an article date more than 3 days from the projection does not confirm it
    expect(await run((st) => seedArticle(st, "ZZUS", "ZZUS results on Nov 12"))).toEqual([["earnings:ZZUS:2026-11-05", "expected", "edgar"]]);
    // within 3 days, at confidence 0.5: confirmed on the article's date
    expect(await run((st) => seedArticle(st, "ZZUS", "ZZUS results on Nov 3", { eventConfidence: 0.5 }))).toEqual([["earnings:ZZUS:2026-11-03", "confirmed", "article"]]);
    // an article date alone (no filing projection) is est. for a US name exactly as for a TSX name
    expect(await run((st) => seedArticle(st, "ZZUS", "ZZUS results on Nov 3"), [sym("ZZUS", { usListed: true })], async () => [])).toEqual([["earnings:ZZUS:2026-11-03", "expected", "article"]]);
  });

  it("replaces a symbol's future events of the same kind, keeps past ones, and keeps everything when EDGAR fails", async () => {
    const store = new MemoryNewsStore();
    const ev = (id: string, date: string) => ({ id, symbol: "ZZUS", kind: "earnings" as const, date: day(date), status: "expected" as const, source: "edgar", amountPerUnit: null, currency: null });
    await store.putEvents([ev("earnings:ZZUS:2026-08-06", "2026-08-06"), ev("earnings:ZZUS:2026-11-20", "2026-11-20")]);
    const failing = withFilings(async () => { throw new Error("synthetic"); });
    const bad = await setup({ store, edgar: failing.edgar as never }).service.refreshAll(async () => [{ symbols: [sym("ZZUS", { usListed: true })] }]);
    expect(bad.failures).toBe(1);
    expect((await all(store, ["ZZUS"])).map((e) => e.id)).toEqual(["earnings:ZZUS:2026-08-06", "earnings:ZZUS:2026-11-20"]);
    const ok = withFilings(async () => [day("2026-02-05"), day("2026-05-07"), day("2026-08-06")]);
    await setup({ store, edgar: ok.edgar as never }).service.refreshAll(async () => [{ symbols: [sym("ZZUS", { usListed: true })] }]);
    expect((await all(store, ["ZZUS"])).map((e) => [e.id, e.status])).toEqual([["earnings:ZZUS:2026-08-06", "expected"], ["earnings:ZZUS:2026-11-05", "expected"]]);
  });

  it("runs after rating, leaves the rater a 10 s reserve, and never runs for on-demand refreshes", async () => {
    const order: string[] = [];
    const { edgar, filingDates } = withFilings(async () => { order.push("calendar"); return []; });
    const { service, rateUnrated, history } = setup({ edgar: edgar as never });
    rateUnrated.mockImplementation(async () => { order.push("rate"); return { rated: 0, failed: 0 }; });
    history.mockImplementation(async () => { order.push("stats"); return closes(40); });
    await service.refreshAll(async () => [{ symbols: [sym("ZZUS", { usListed: true })] }]);
    expect(order).toEqual(["rate", "stats", "calendar"]);
    expect(rateUnrated.mock.calls[0][0].deadline).toEqual(new Date(NOW.getTime() + 50_000));
    filingDates.mockClear();
    await service.refreshSymbols([sym("ZZUS", { usListed: true })]);
    expect(filingDates).not.toHaveBeenCalled();
  });

  it("starts no EDGAR read past the deadline", async () => {
    let t = NOW.getTime();
    const { edgar, filingDates } = withFilings(async () => { t += 30_000; return []; });
    const { service } = setup({ edgar: edgar as never, now: () => new Date(t) });
    await service.refreshAll(async () => [{ symbols: [sym("ZZA", { usListed: true }), sym("ZZB", { usListed: true }), sym("ZZC", { usListed: true })] }]);
    expect(filingDates).toHaveBeenCalledTimes(2); // 0 s and 30 s start; 60 s is past
  });
});
