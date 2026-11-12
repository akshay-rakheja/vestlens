import { describe, expect, it, vi } from "vitest";

import { rank } from "../news/scoring.js";
import type { NewsSymbol } from "../news/refresh-service.js";
import { MemoryNewsStore, type ArticleRating, type StoredArticle } from "../news/store.js";
import { DEFAULT_SETTINGS } from "../settings/settings-service.js";
import {
  buildNewsPayload, NEWS_WIDGET, NEWS_WIDGET_URI, newsInput, newsModelCopy, NewsScopeError, newsText, newsToolDefinitions, type NewsDeps,
} from "./news-tools.js";
import { buildNewsResult, portfolioTotals } from "./news-tools.js";
import { buildHoldingsPayload } from "./holdings-tools.js";

// 16:00 Toronto on a Wednesday: the market is closed, so movers compare the last two closes.
const NOW = new Date("2026-10-21T20:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const cls = (bucket: string, group: string, included: boolean, label: string): any => ({ label, bucket, group, includedInPortfolioTotal: included, isClosed: group === "closed" });
const pos = (symbol: string, over: Record<string, unknown> = {}): any => ({
  instrumentId: `i-${symbol}`, kind: "stock", symbol, description: `${symbol} Synthetic Corp`, units: 100, price: 50, costBasis: 40, marketValue: 5000, unrealizedGain: null, currency: "CAD", cashEquivalent: false, ...over,
});
const portfolio = (): any => ({
  generatedAt: "2026-10-21T19:55:00.000Z",
  accounts: [
    { id: "TFSA", classification: cls("tfsa", "registered", true, "TFSA"), value: { amount: 20_000, currency: "CAD", source: "brokerage_reported" }, balances: [], positions: [
      pos("ZZTEST"),
      pos("ZZETF", { kind: "etf", units: 100, price: 100, marketValue: 10_000 }),
      pos("ZZCALM", { units: 10, price: 100, marketValue: 1000 }),
    ] },
    { id: "RRSP", classification: cls("rrsp", "registered", true, "RRSP"), value: { amount: 10_000, currency: "USD", source: "brokerage_reported" }, balances: [], positions: [
      pos("ZZUSD", { units: 20, price: 100, marketValue: 2000, currency: "USD" }),
    ] },
    { id: "CARD", classification: cls("credit_card", "credit_products", false, "Credit card"), value: null, balances: [], positions: [] },
  ],
});

const stat = (symbol: string, currency: string, lastClose: number, prevClose: number) => ({
  symbol, currency, closes: 61, typicalMove: 0.01, lastClose, prevClose, lastCloseDate: "2026-10-21", updatedAt: NOW,
});

const rating = (articleId: string, symbol: string, over: Partial<ArticleRating> = {}): ArticleRating => ({
  articleId, symbol, model: "jev-test", ratedAt: NOW, relevant: 0.9, sentiment: 3, sentimentConfidence: 0.8, materiality: 2,
  eventType: "earnings", eventConfidence: 0.8, credible: 0.9, clickbait: 0.1, duplicateOf: null, ...over,
});

let n = 0;
const article = (symbols: string[], h: number, over: Partial<Omit<StoredArticle, "id">> = {}): Omit<StoredArticle, "id"> => {
  n += 1;
  return {
    urlHash: String(n).padStart(64, "0"), url: `https://news.example.invalid/a/${n}`, headline: `Invented headline ${String.fromCharCode(64 + (n % 26) + 1)}`,
    snippet: "Invented snippet", source: "synthetic.example", imageUrl: null, publishedAt: hoursAgo(h), symbols, fetchedAt: NOW, ...over,
  };
};

async function seed(store = new MemoryNewsStore()) {
  const [a1, a2, a3, a4, a5, a6] = await store.upsertArticles([
    article(["ZZTEST"], 2, { headline: "ZZTEST wins invented contract", imageUrl: "https://img.example.invalid/zz.png" }),
    article(["ZZTEST"], 5, { headline: "ZZTEST invented contract echo", source: "other.example" }),
    article(["ZZTEST"], 30, { headline: "ZZTEST invented minor note" }),
    article(["ZZCON"], 3, { headline: "ZZCON invented recall" }),
    article(["ZZCON"], 10, { headline: "ZZCON invented supplier worry" }),
    article(["ZZTEST"], 1, { headline: "Invented sector round-up" }),
  ]);
  await store.putRatings([
    rating(a1!.id, "ZZTEST", { sentiment: 4, materiality: 3 }),
    rating(a2!.id, "ZZTEST", { sentiment: 4, materiality: 3, duplicateOf: a1!.id }),
    rating(a3!.id, "ZZTEST", { sentiment: 3, materiality: 1, eventConfidence: 0.2 }),
    rating(a4!.id, "ZZCON", { sentiment: 0, materiality: 2 }),
    rating(a5!.id, "ZZCON", { sentiment: 1, materiality: 1 }),
    rating(a6!.id, "ZZTEST", { relevant: 0.3 }),
  ]);
  await store.putStats([
    stat("ZZTEST", "CAD", 50, 45),
    stat("ZZETF", "CAD", 100, 99),
    stat("ZZCALM", "CAD", 100, 100),
    stat("ZZUSD", "USD", 100, 90),
  ]);
  for (const s of ["ZZTEST", "ZZETF", "ZZCALM", "ZZUSD", "ZZCON"]) await store.markFetched(s, hoursAgo(1));
  return { store, ids: { a1: a1!.id, a2: a2!.id, a3: a3!.id, a4: a4!.id, a5: a5!.id, a6: a6!.id } };
}

const closes = (count: number) => Array.from({ length: count }, (_, i) => ({ date: `2026-${String(7 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, close: 100 + i }));

function deps(store: MemoryNewsStore, over: Partial<NewsDeps> = {}): NewsDeps & { market: any; refresh: any } {
  return {
    store,
    refresh: { refreshSymbols: vi.fn(async () => ({ fetched: 0, rated: 0, skipped: 0, failures: 0, budgetLeft: 10 })) },
    market: {
      quotes: vi.fn(async () => new Map()),
      history: vi.fn(async () => closes(40)),
      profile: vi.fn(async (t: string) => (t === "ZZETF" ? { kind: "fund", sector: null, country: null, sectorWeights: null, countryWeights: null, topHoldings: [{ symbol: "ZZCON", weight: 0.5 }] } : null)),
    },
    settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })) },
    budget: 90,
    publicOrigin: "https://portfolio.example.invalid",
    now: () => NOW,
    ...over,
  } as never;
}

const ratingsById = async (store: MemoryNewsStore, ids: string[]) => new Map((await store.ratingsFor(ids)).map((r) => [r.articleId, r]));

describe("portfolioTotals (A8)", () => {
  const twoListings = (): any => ({
    generatedAt: "2026-10-21T19:55:00.000Z",
    accounts: [{ id: "TFSA", classification: cls("tfsa", "registered", true, "TFSA"), value: { amount: 100_000, currency: "CAD", source: "brokerage_reported" }, balances: [], positions: [
      pos("CADCO", { units: 37, price: 100, marketValue: 3_700 }),
      pos("USCO", { units: 37, price: 100, marketValue: 3_700, currency: "USD" }),
    ] }],
  });

  it("gives a USD holding the same portfolio-wide threshold as a CAD one when accounts report CAD totals", () => {
    const totals = portfolioTotals(twoListings(), undefined);
    expect(totals.get("CAD")).toBe(100_000);
    expect(totals.get("USD")).toBe(100_000);
  });

  it("two equal moves in a CAD-reporting account get the same verdict whatever the currency", async () => {
    const store = new MemoryNewsStore();
    await store.putStats([{ ...stat("CADCO", "CAD", 101.6, 100), typicalMove: 0.005 }, { ...stat("USCO", "USD", 101.6, 100), typicalMove: 0.005 }]);
    for (const s of ["CADCO", "USCO"]) await store.markFetched(s, hoursAgo(1));
    const p = await buildNewsPayload(deps(store), twoListings(), "sub", {});
    expect(p.movers).toEqual([]);
    expect(p.asUsual).toBe(2);
  });

  it("sums accounts in both currencies into one total, one account's scope when asked", () => {
    const totals = portfolioTotals(portfolio(), undefined);
    expect(totals.get("CAD")).toBe(30_000);
    expect(totals.get("USD")).toBe(30_000);
    expect(portfolioTotals(portfolio(), "RRSP").get("USD")).toBe(10_000);
  });
});

describe("buildNewsPayload", () => {
  it("returns the documented shape with listed accounts, filters and settings", async () => {
    const { store } = await seed();
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", {});
    expect(Object.keys(p).sort()).toEqual(["accounts", "asOf", "asUsual", "budgetExhausted", "feed", "filters", "imageOrigin", "movers", "newsAsOf", "omitted", "portfolioMood", "settings", "symbols", "unfetched", "unpriced", "window"]);
    expect(p.window).toBe("7d");
    expect(p.filters).toEqual({ window: "7d" });
    expect(p.accounts).toEqual([{ id: "TFSA", label: "TFSA" }, { id: "RRSP", label: "RRSP" }]);
    expect(p.asOf).toBe("2026-10-21T19:55:00.000Z");
    expect(p.settings).toEqual(DEFAULT_SETTINGS);
    expect(p.imageOrigin).toBe("https://portfolio.example.invalid");
    expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(60_000);
  });

  // 2026-10-22: to decide whether an open-news backfill is worth building, count how often a
  // served news view is empty or thin. Counts only: no symbols, headlines or account ids.
  it("logs a counts-only news_served line: shown symbols, those with no or few articles, feed size", async () => {
    const { store } = await seed();
    const logs: any[] = [];
    const p = await buildNewsPayload(deps(store, { log: (e) => logs.push(e) }), portfolio(), "sub", {});
    const entry = logs.find((e) => e.event === "news_served");
    expect(entry).toEqual({
      event: "news_served", window: "7d", scoped: false, symbols: p.symbols.length,
      noNews: p.symbols.filter((s) => s.mood.articles === 0).length,
      thin: p.symbols.filter((s) => s.mood.articles > 0 && s.mood.articles < 3).length,
      notEnoughNews: p.symbols.filter((s) => s.mood.level === "not_enough_news").length,
      feed: p.feed.length, emptyFeed: p.feed.length === 0, refreshed: false, budgetExhausted: p.budgetExhausted, unfetched: p.unfetched,
    });
    const text = JSON.stringify(logs);
    for (const s of p.symbols) expect(text).not.toContain(`"${s.symbol}"`);
    for (const c of p.feed) expect(text).not.toContain(c.headline);
    await buildNewsPayload(deps(store, { log: (e) => logs.push(e) }), portfolio(), "sub", { symbol: p.symbols[0].symbol });
    expect(logs.at(-1)).toMatchObject({ event: "news_served", scoped: true });
  });

  it("ranks flagged movers by |dollarMove| and counts the rest as usual", async () => {
    const { store } = await seed();
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", {});
    expect(p.movers.map((m) => `${m.symbol}|${m.currency}`)).toEqual(["ZZTEST|CAD", "ZZUSD|USD"]);
    expect(p.movers[0]).toMatchObject({ dollarMove: 500, flagged: true, estimated: false });
    expect(p.asUsual).toBe(2);
    expect(p.unpriced).toBe(0);
  });

  describe("CAD movers", () => {
    const rates = [{ date: "2026-10-20", close: 1.3 }, { date: "2026-10-21", close: 1.4 }];
    const withRates = async (series: any, over: Partial<NewsDeps> = {}) => {
      const { store } = await seed();
      const d = deps(store, over);
      d.market.usdCad = vi.fn(async () => series);
      return { d, p: await buildNewsPayload(d, portfolio(), "sub", {}) };
    };

    it("a USD mover's dollar move in CAD is today's USD at today's rate minus yesterday's at yesterday's rate (est.); percent stays native", async () => {
      const { d, p } = await withRates(rates);
      const usd = p.movers.find((m) => m.symbol === "ZZUSD")!;
      // 20 x 100 x 1.4 - 20 x 90 x 1.3 = 460 ; a plain native move x today's rate would be 280
      expect(usd.home).toMatchObject({ amount: 460, estimated: true, native: { amount: 200, currency: "USD" } });
      expect(usd.dollarMove).toBe(200);
      expect(usd.returnFraction).toBeCloseTo(100 / 90 - 1, 6);
      const cad = p.movers.find((m) => m.symbol === "ZZTEST")!;
      expect(cad.home).toMatchObject({ amount: 500, estimated: false });
      expect(d.market.usdCad).toHaveBeenCalledTimes(1);
    });

    it("a USD holding's CAD day change is the same in Holdings and News", async () => {
      const { p } = await withRates(rates);
      const news = p.movers.find((m) => m.symbol === "ZZUSD")!.home!;
      const quote = { ticker: "ZZUSD", currency: "USD", price: 100, previousClose: 90, asOf: "2026-10-21T20:00:00.000Z" };
      const holdingsDeps: any = {
        market: { quotes: vi.fn(async (ts: string[]) => new Map(ts.map((t) => [t, { ...quote, ticker: t }]))), usdCad: vi.fn(async () => rates) },
        settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })) },
        now: () => NOW,
      };
      const holdings = await buildHoldingsPayload(holdingsDeps, portfolio(), "sub", {});
      const row = holdings.rows.find((r) => r.symbol === "ZZUSD")!;
      expect(news.amount).toBe(460);
      expect(row.cad!.dayChange).toMatchObject({ amount: news.amount, estimated: true, native: { amount: 200, currency: "USD" } });
    });

    it("without a rate the USD move is not converted (amount null, native kept)", async () => {
      const { p } = await withRates(null);
      expect(p.movers.find((m) => m.symbol === "ZZUSD")!.home).toMatchObject({ amount: null, native: { amount: 200, currency: "USD" } });
    });

    it("is absent with cadView off, and then no rate is fetched", async () => {
      const { store } = await seed();
      const d = deps(store, { settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView: false })) } as any });
      d.market.usdCad = vi.fn(async () => rates);
      const p = await buildNewsPayload(d, portfolio(), "sub", {});
      expect(p.movers.every((m) => m.home === undefined)).toBe(true);
      expect(d.market.usdCad).not.toHaveBeenCalled();
    });

    it("model copy carries the CAD move and the CAD note", async () => {
      const { p } = await withRates(rates);
      const copy = newsModelCopy(p) as any;
      expect(copy.movers.find((m: any) => m.symbol === "ZZUSD")).toMatchObject({ moveCad: 460, moveCadEstimated: true });
      expect(copy.notes.currency).toBe("Figures are in CAD; USD amounts are converted at the Bank of Canada rate and marked est.");
      // The CAD move carries the day's currency move; the model is told so (B2).
      expect(copy.notes.moveCad).toBe("A USD holding's moveCad includes the day's currency move; returnPct is the price move.");
    });

    it("model copy has no moveCad note while nothing is converted (cadView off)", async () => {
      const { store } = await seed();
      const d = deps(store, { settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView: false })) } as any });
      d.market.usdCad = vi.fn(async () => rates);
      const copy = newsModelCopy(await buildNewsPayload(d, portfolio(), "sub", {})) as any;
      expect(copy.notes.moveCad).toBeUndefined();
      expect(copy.notes.currency).toBeUndefined();
    });

    it("stays under 60 KB with 60 USD movers carrying CAD amounts", async () => {
      const store = new MemoryNewsStore();
      const list = Array.from({ length: 200 }, (_, i) => `ZZU${String(i).padStart(3, "0")}`);
      const big: any = portfolio();
      big.accounts[0].positions = [];
      big.accounts[1].positions = list.map((s, i) => pos(s, { currency: "USD", units: 100 + i, marketValue: 5000 + i, description: `${s} Synthetic Corp with a long invented name` }));
      await store.putStats(list.map((s, i) => stat(s, "USD", i < 60 ? 60 : 50.1, 50)));
      const rows = await store.upsertArticles(list.flatMap((s, i) => [0, 1].map((k) => article([s], 1 + k + (i % 20), { headline: `${s} invented headline that is long enough to look like a real one ${k}`, snippet: "Invented snippet ".repeat(11).slice(0, 200), imageUrl: "https://img.example.invalid/zz.png" }))));
      await store.putRatings(rows.map((a) => rating(a.id, a.symbols[0]!, { materiality: 3 })));
      for (const s of list) await store.markFetched(s, hoursAgo(1));
      const d = deps(store);
      d.market.usdCad = vi.fn(async () => rates);
      const p = await buildNewsPayload(d, big, "sub", {});
      expect(p.movers.length).toBeGreaterThan(20);
      expect(p.movers.some((m) => m.home?.amount !== null && m.home !== undefined)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(60_000);
    });
  });

  it("explains a flagged mover with its top material article, or says no clear news", async () => {
    const { store, ids } = await seed();
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", {});
    const zz = p.movers.find((m) => m.symbol === "ZZTEST")!;
    expect(zz.reason.kind).toBe("article");
    expect(zz.reason.card?.articleId).toBe(ids.a1);
    expect(zz.reason.card?.alsoReportedBy).toEqual(["other.example"]);
    const usd = p.movers.find((m) => m.symbol === "ZZUSD")!;
    expect(usd.reason).toEqual({ kind: "no_clear_news", card: null, via: null, lookThrough: false });
    expect(usd.mood.level).toBe("not_enough_news");
    expect(usd.mood.value).toBeNull();
  });

  it("sorts the feed by rank, gates irrelevant articles and collapses duplicates into alsoReportedBy", async () => {
    const { store, ids } = await seed();
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", {});
    const feedIds = p.feed.map((c) => c.articleId);
    expect(feedIds).not.toContain(ids.a2);
    expect(feedIds).not.toContain(ids.a6);
    expect(new Set(feedIds)).toEqual(new Set([ids.a1, ids.a3, ids.a4, ids.a5]));
    const r = await ratingsById(store, feedIds);
    const ranks = p.feed.map((c) => rank(r.get(c.articleId)!, NOW, new Date(c.publishedAt)));
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
    expect(p.feed.find((c) => c.articleId === ids.a1)!.alsoReportedBy).toEqual(["other.example"]);
  });

  it("ETF look-through cards name the ETF and carry the constituent in via", async () => {
    const { store, ids } = await seed();
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", {});
    const card = p.feed.find((c) => c.articleId === ids.a4)!;
    expect(card.symbols).toEqual(["ZZETF"]);
    expect(card.via).toBe("ZZCON");
    expect(p.feed.find((c) => c.articleId === ids.a1)!.via).toBeNull();
    const etf = p.symbols.find((s) => s.symbol === "ZZETF")!;
    expect(etf.mood.level).not.toBe("not_enough_news");
    expect(etf.mood.value!).toBeLessThan(0);
  });

  it("an ETF mood and reason from top holdings carry lookThrough and the constituent (I5)", async () => {
    const { store, ids } = await seed();
    await store.putStats([stat("ZZETF", "CAD", 90, 100)]); // a flagged 10% fall
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", {});
    const etf = p.symbols.find((s) => s.symbol === "ZZETF")!;
    expect(etf.mood).toMatchObject({ lookThrough: true, lookThroughMissing: false });
    expect(p.symbols.find((s) => s.symbol === "ZZTEST")!.mood).toMatchObject({ lookThrough: false, lookThroughMissing: false });
    const m = p.movers.find((x) => x.symbol === "ZZETF")!;
    expect(m.reason).toMatchObject({ kind: "article", via: "ZZCON", lookThrough: true });
    expect(m.reason.card?.articleId).toBe(ids.a4);
    expect(m.mood.lookThrough).toBe(true);
    expect(newsText(p)).toContain("ZZETF moved more than usual: ZZCON: ZZCON invented recall (synthetic.example");
    expect((newsModelCopy(p) as any).movers.find((x: any) => x.symbol === "ZZETF")).toMatchObject({ via: "ZZCON", lookThrough: true });
    expect(p.movers.find((x) => x.symbol === "ZZTEST")!.reason).toMatchObject({ via: null, lookThrough: false });
  });

  it("a fund with no look-through data says so instead of a mood (I5)", async () => {
    const { store } = await seed();
    const d = deps(store);
    d.market.profile = vi.fn(async () => ({ kind: "fund", sector: null, country: null, sectorWeights: null, countryWeights: null, topHoldings: null }));
    const p = await buildNewsPayload(d, portfolio(), "sub", {});
    const etf = p.symbols.find((s) => s.symbol === "ZZETF")!;
    expect(etf.mood).toMatchObject({ level: "not_enough_news", value: null, lookThrough: false, lookThroughMissing: true });
    expect(p.symbols.find((s) => s.symbol === "ZZTEST")!.mood.lookThroughMissing).toBe(false);
  });

  it("cards expose the proxied image path and never the publisher image URL; tags follow the gates", async () => {
    const { store, ids } = await seed();
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", {});
    const a1 = p.feed.find((c) => c.articleId === ids.a1)!;
    expect(a1.imageUrl).toBe(`/api/news/image/${ids.a1}`);
    expect(JSON.stringify(p)).not.toContain("img.example.invalid");
    expect(p.feed.find((c) => c.articleId === ids.a3)!.imageUrl).toBeNull();
    expect(Object.keys(a1).sort()).toEqual(["alsoReportedBy", "articleId", "headline", "imageUrl", "publishedAt", "snippet", "source", "symbols", "tags", "url", "via"]);
    expect(a1.tags).toEqual({ eventType: "earnings", impactLevel: 3, mood: "strongly_positive", credible: true });
    expect(p.feed.find((c) => c.articleId === ids.a3)!.tags!.eventType).toBeNull();
  });

  it("shows unrated articles as \"not yet rated\" cards, outside mood and reason (C1)", async () => {
    const { store, ids } = await seed();
    const [u1, u2] = await store.upsertArticles([
      article(["ZZUSD"], 4, { headline: "ZZUSD invented filing awaiting rating" }),
      article(["ZZTEST"], 1, { headline: "ZZTEST invented note awaiting rating" }),
    ]);
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", {});
    const pending = p.feed.find((c) => c.articleId === u1!.id)!;
    expect(pending).toMatchObject({ symbols: ["ZZUSD"], tags: null, via: null });
    expect(p.feed.find((c) => c.articleId === u2!.id)!.tags).toBeNull();
    // rated cards come first; unrated ones follow, newest first
    expect(p.feed.slice(-2).map((c) => c.articleId)).toEqual([u2!.id, u1!.id]);
    const usd = p.movers.find((m) => m.symbol === "ZZUSD")!;
    expect(usd.reason).toEqual({ kind: "news_not_rated", card: null, via: null, lookThrough: false });
    expect(usd.mood.level).toBe("not_enough_news");
    const zz = p.movers.find((m) => m.symbol === "ZZTEST")!;
    expect(zz.reason.card?.articleId).toBe(ids.a1);
    expect(p.symbols.find((x) => x.symbol === "ZZUSD")!.mood.articles).toBe(0);
    expect(newsText(p)).toContain("ZZUSD moved more than usual; news found, not yet rated.");
    expect((newsModelCopy(p) as any).feed.find((c: any) => c.headline === "ZZUSD invented filing awaiting rating")).toMatchObject({ rated: false, mood: null, eventType: null });
  });

  it("a flagged mover with only unrated articles never shows \"no clear news\"", async () => {
    const { store } = await seed();
    await store.upsertArticles([article(["ZZUSD"], 40, { headline: "ZZUSD invented update awaiting rating" })]);
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", {});
    expect(p.movers.find((m) => m.symbol === "ZZUSD")!.reason.kind).toBe("news_not_rated");
    expect(newsText(p)).not.toContain("ZZUSD moved more than usual; no clear news.");
  });

  it("weights the portfolio mood within each currency and counts unknown moods", async () => {
    const { store } = await seed();
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", {});
    expect(p.portfolioMood.spread.unknown).toBe(2); // ZZCALM and ZZUSD have no news
    expect(p.portfolioMood.spread.positive + p.portfolioMood.spread.negative + p.portfolioMood.spread.neutral).toBe(2);
    expect(p.portfolioMood.level).not.toBe("not_enough_news");
  });

  it("sparklines are the last 30 closes for symbols in the response", async () => {
    const { store } = await seed();
    const d = deps(store);
    const p = await buildNewsPayload(d, portfolio(), "sub", {});
    const s = p.symbols.find((x) => x.symbol === "ZZTEST")!;
    expect(s.sparkline).toHaveLength(30);
    expect(s.sparkline[29]).toBe(139);
    expect(s.sparkline[0]).toBe(110);
    expect(p.symbols.map((x) => x.symbol)).toEqual(["ZZCALM", "ZZETF", "ZZTEST", "ZZUSD"]);
    expect(d.market.history).toHaveBeenCalledWith("ZZTEST", "2026-07-23", "2026-10-21");
    expect(d.market.history).not.toHaveBeenCalledWith("ZZCON", expect.anything(), expect.anything());
  });

  it("filters by account and symbol, and rejects unknown ones", async () => {
    const { store } = await seed();
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", { accountId: "RRSP" });
    expect(p.symbols.map((s) => s.symbol)).toEqual(["ZZUSD"]);
    expect(p.feed).toEqual([]);
    expect(p.filters).toEqual({ window: "7d", accountId: "RRSP" });
    const one = await buildNewsPayload(deps(store), portfolio(), "sub", { symbol: "ZZTEST", window: "24h" });
    expect(one.movers.map((m) => m.symbol)).toEqual(["ZZTEST"]);
    expect(one.symbols.map((s) => s.symbol)).toEqual(["ZZTEST"]);
    expect(one.feed.every((c) => c.symbols.includes("ZZTEST"))).toBe(true);
    expect(one.feed.every((c) => Date.parse(c.publishedAt) >= NOW.getTime() - 24 * 3_600_000)).toBe(true);
    await expect(buildNewsPayload(deps(store), portfolio(), "sub", { accountId: "CARD" })).rejects.toBeInstanceOf(NewsScopeError);
    await expect(buildNewsPayload(deps(store), portfolio(), "sub", { symbol: "ZZNOPE" })).rejects.toBeInstanceOf(NewsScopeError);
  });

  it("reports the oldest fetch and does not refresh when every symbol is fresh", async () => {
    const { store } = await seed();
    await store.markFetched("ZZCALM", hoursAgo(3));
    const d = deps(store);
    const p = await buildNewsPayload(d, portfolio(), "sub", {});
    expect(p.newsAsOf).toBe(hoursAgo(3).toISOString());
    expect(p.unfetched).toBe(0);
    expect(p.budgetExhausted).toBe(false);
    expect(d.refresh.refreshSymbols).not.toHaveBeenCalled();
  });

  it("refreshes only symbols older than 6 h, movers flagged, within the budget", async () => {
    const { store } = await seed();
    await store.markFetched("ZZTEST", hoursAgo(7));
    const d = deps(store);
    d.refresh.refreshSymbols.mockImplementation(async () => { await store.markFetched("ZZTEST", NOW); return { fetched: 1, rated: 0, skipped: 0, failures: 0, budgetLeft: 80 }; });
    const p = await buildNewsPayload(d, portfolio(), "sub", {});
    expect(d.refresh.refreshSymbols).toHaveBeenCalledTimes(1);
    const [symbols, options] = d.refresh.refreshSymbols.mock.calls[0];
    expect(symbols.map((s: { symbol: string }) => s.symbol)).toEqual(["ZZTEST"]);
    expect(symbols[0]).toMatchObject({ isMover: true, currency: "CAD" });
    expect(options.budgetMs).toBeLessThanOrEqual(5_000);
    expect(p.newsAsOf).toBe(hoursAgo(1).toISOString());
  });

  it("serves the cache without any refresh when the daily budget is exhausted (Review Focus 4)", async () => {
    const { store } = await seed();
    await store.markFetched("ZZTEST", hoursAgo(20));
    await store.spendBudget("2026-10-21", 90);
    const d = deps(store);
    const p = await buildNewsPayload(d, portfolio(), "sub", {});
    expect(d.refresh.refreshSymbols).not.toHaveBeenCalled();
    expect(p.budgetExhausted).toBe(true);
    expect(p.newsAsOf).toBe(hoursAgo(20).toISOString());
    expect(p.feed.length).toBeGreaterThan(0);
    expect(p.movers.length).toBe(2);
  });

  it("serves the cache when the on-demand refresh is slow", async () => {
    const { store } = await seed();
    await store.markFetched("ZZTEST", hoursAgo(7));
    const d = deps(store, { refreshDeadlineMs: 30 });
    d.refresh.refreshSymbols.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    const p = await buildNewsPayload(d, portfolio(), "sub", {});
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(p.newsAsOf).toBe(hoursAgo(7).toISOString());
    expect(p.feed.length).toBeGreaterThan(0);
  });

  it("counts never-fetched symbols and keeps market failures out of the payload", async () => {
    const store = new MemoryNewsStore();
    const d = deps(store, { budget: 0 });
    d.market.history = vi.fn(async () => { throw new Error("down"); });
    d.market.profile = vi.fn(async () => { throw new Error("down"); });
    const p = await buildNewsPayload(d, portfolio(), "sub", {});
    expect(p.newsAsOf).toBeNull();
    expect(p.unfetched).toBe(4);
    expect(p.movers).toEqual([]);
    expect(p.unpriced).toBe(4);
    expect(p.symbols.every((s) => s.sparkline.length === 0 && s.mood.level === "not_enough_news")).toBe(true);
    expect(p.portfolioMood.level).toBe("not_enough_news");
  });
});

describe("buildNewsPayload hardening", () => {
  it("never emits a non-http(s) article url or image (defence in depth behind ingest)", async () => {
    const { store, ids } = await seed();
    const [bad1, bad2, img] = await store.upsertArticles([
      article(["ZZTEST"], 1, { url: "javascript:alert(1)", headline: "ZZTEST invented script link" }),
      article(["ZZTEST"], 1, { url: "data:text/html,<b>x</b>", headline: "ZZTEST invented data link" }),
      article(["ZZTEST"], 1, { imageUrl: "data:image/png;base64,AAAA", headline: "ZZTEST invented data image" }),
    ]);
    await store.putRatings([rating(bad1!.id, "ZZTEST", { materiality: 3 }), rating(bad2!.id, "ZZTEST", { materiality: 3 }), rating(img!.id, "ZZTEST")]);
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", {});
    const feedIds = p.feed.map((c) => c.articleId);
    expect(feedIds).not.toContain(bad1!.id);
    expect(feedIds).not.toContain(bad2!.id);
    expect(feedIds).toContain(ids.a1);
    expect(p.feed.find((c) => c.articleId === img!.id)!.imageUrl).toBeNull();
    expect(JSON.stringify(p)).not.toMatch(/javascript:|data:/);
  });

  it("concurrent builds share one on-demand refresh per stale symbol", async () => {
    const { store } = await seed();
    await store.markFetched("ZZTEST", hoursAgo(7));
    await store.markFetched("ZZUSD", hoursAgo(8));
    const d1 = deps(store);
    const d2 = deps(store);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = async (symbols: NewsSymbol[]) => { await gate; for (const s of symbols) await store.markFetched(s.symbol, NOW); return { fetched: 0, rated: 0, skipped: 0, failures: 0, budgetLeft: 80 }; };
    d1.refresh.refreshSymbols.mockImplementation(slow);
    d2.refresh.refreshSymbols.mockImplementation(slow);
    const both = Promise.all([
      buildNewsPayload(d1, portfolio(), "sub", {}),
      buildNewsPayload(d2, portfolio(), "sub", { window: "24h" }),
    ]);
    await vi.waitFor(() => expect(d1.refresh.refreshSymbols.mock.calls.length + d2.refresh.refreshSymbols.mock.calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [p1, p2] = await both;
    const calls = [...d1.refresh.refreshSymbols.mock.calls, ...d2.refresh.refreshSymbols.mock.calls].flatMap((c: any[]) => c[0].map((s: NewsSymbol) => s.symbol));
    expect(calls.sort()).toEqual(["ZZTEST", "ZZUSD"]);
    expect(p1.newsAsOf).toBe(hoursAgo(1).toISOString());
    expect(p2.newsAsOf).toBe(hoursAgo(1).toISOString());
    // Settled refreshes are forgotten: a later stale call refreshes again.
    await store.markFetched("ZZTEST", hoursAgo(9));
    await buildNewsPayload(d1, portfolio(), "sub", {});
    expect(d1.refresh.refreshSymbols.mock.calls.length + d2.refresh.refreshSymbols.mock.calls.length).toBe(2);
  });

  it("keeps a 200-holding portfolio under 60 KB: feed first, then sparklines, then symbols beyond 100, keeping movers", async () => {
    const store = new MemoryNewsStore();
    const symbolsList = Array.from({ length: 200 }, (_, i) => `ZZT${String(i).padStart(3, "0")}`);
    const big: any = portfolio();
    big.accounts[0].value = { amount: 200_000, currency: "CAD", source: "brokerage_reported" };
    big.accounts[0].positions = symbolsList.map((s, i) => pos(s, { units: 100 + i, marketValue: 5000 + i, description: `${s} Synthetic Corp with a long invented name` }));
    big.accounts[1].positions = [];
    const movers = new Set(symbolsList.slice(0, 30));
    await store.putStats(symbolsList.map((s) => stat(s, "CAD", movers.has(s) ? 60 : 50.1, 50)));
    const rows = await store.upsertArticles(symbolsList.flatMap((s, i) => [0, 1].map((k) => article([s], 1 + k + (i % 20), {
      headline: `${s} invented headline that is long enough to look like a real one ${k}`, snippet: "Invented snippet ".repeat(11).slice(0, 200), imageUrl: "https://img.example.invalid/zz.png",
    }))));
    await store.putRatings(rows.map((a) => rating(a.id, a.symbols[0]!, { materiality: 3 })));
    for (const s of symbolsList) await store.markFetched(s, hoursAgo(1));
    const d = deps(store);
    const p = await buildNewsPayload(d, big, "sub", {});
    expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(60_000);
    expect(p.movers).toHaveLength(30);
    expect(p.omitted.movers).toBe(0);
    const kept = new Set(p.symbols.map((s) => s.symbol));
    for (const m of movers) expect(kept.has(m)).toBe(true);
    expect(p.symbols.length + p.omitted.symbols).toBe(200);
    expect(p.symbols.length).toBeLessThanOrEqual(100);
    expect(p.feed.length).toBe(0);
    expect(p.omitted.feed).toBeGreaterThan(0);
    expect(p.symbols.every((s) => s.sparkline.length === 0)).toBe(true);
    expect(p.omitted.sparklines).toBeGreaterThan(0);
  });

  it("reports nothing omitted for a small portfolio", async () => {
    const { store } = await seed();
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", {});
    expect(p.omitted).toEqual({ feed: 0, sparklines: 0, symbols: 0, movers: 0 });
  });
});

describe("news text, model copy and tool definitions", () => {
  it("text gives counts, top movers with reason headline and source, and the mood word, without amounts", async () => {
    const { store } = await seed();
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", {});
    const text = newsText(p, { show: true });
    expect(text).toContain("2 of 4 holdings moved more than usual");
    expect(text).toContain("ZZTEST moved more than usual: ZZTEST wins invented contract (synthetic.example) (AI-rated; may be wrong).");
    expect(text).toContain("ZZUSD moved more than usual; no clear news.");
    expect(text).toMatch(/Portfolio news mood: [a-z ]+ \(AI-rated from the headline and summary; may be wrong\)\./);
    expect(text).toContain("News and ratings are for information only, not investment advice.");
    expect(text).toContain("Showing the news widget.");
    expect(text).not.toMatch(/\$|%|500|200|20000|10000/);
    expect(newsText(p)).not.toContain("Showing");
  });

  it("quoted reason headlines carry the AI caveat even when the portfolio mood is not enough news (M2)", async () => {
    const { store } = await seed();
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", {});
    const quiet = { ...p, portfolioMood: { level: "not_enough_news" as const, value: null, spread: { positive: 0, negative: 0, neutral: 0, unknown: 4 } } };
    const text = newsText(quiet);
    expect(text).toContain("Portfolio news mood: not enough news.");
    expect(text).toContain("ZZTEST wins invented contract (synthetic.example) (AI-rated; may be wrong).");
    expect(text).not.toContain("ZZUSD moved more than usual; no clear news. (AI-rated");
  });

  it("model copy is compact (≤ 20 items per list), has no dollar amounts and no image URLs", async () => {
    const { store } = await seed();
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", {});
    const copy = newsModelCopy(p) as any;
    expect(copy.movers.length).toBeLessThanOrEqual(20);
    expect(copy.feed.length).toBeLessThanOrEqual(20);
    expect(copy.symbols.length).toBeLessThanOrEqual(20);
    const json = JSON.stringify(copy);
    expect(json).not.toContain("dollarMove");
    expect(json).not.toContain("marketValue");
    expect(json).not.toContain("imageUrl");
    expect(copy.notes.ratings).toBe("AI-rated from the headline and summary; may be wrong");
  });

  it("defines show_news (model-visible) and get_news (app-only) with strict schemas matching the payload keys", async () => {
    const { store } = await seed();
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", {});
    expect(NEWS_WIDGET).toBe("news");
    const [show, get] = newsToolDefinitions;
    expect(show.name).toBe("show_news");
    expect(show.description).toBe("Use this when the user asks what moved, why a holding moved, or for news and sentiment about their holdings. Pass `symbol` when the question names one holding (e.g. 'news about GOOG') so the view opens on that holding; omit it for portfolio-wide questions. Read-only; informational, not advice.");
    expect(show._meta).toMatchObject({ ui: { resourceUri: NEWS_WIDGET_URI }, "openai/outputTemplate": NEWS_WIDGET_URI });
    expect(get.name).toBe("get_news");
    expect(get._meta).toMatchObject({ ui: { visibility: ["app"] } });
    for (const t of newsToolDefinitions) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.securitySchemes).toEqual([{ type: "oauth2", scopes: ["portfolio:read"] }]);
      expect(t.outputSchema.additionalProperties).toBe(false);
      expect([...t.outputSchema.required].sort()).toEqual(Object.keys(p).sort());
      expect(Object.keys(t.outputSchema.properties).sort()).toEqual(Object.keys(p).sort());
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("show_news lenient symbol: exact, base-match and not-held (no throw, symbolNotHeld)", async () => {
    const { store } = await seed();
    const lenient = { resolveSymbol: true };
    const exact = await buildNewsPayload(deps(store), portfolio(), "sub", { symbol: "ZZTEST" }, lenient);
    expect(exact.filters.symbol).toBe("ZZTEST");
    expect(exact.filters.symbolNotHeld).toBeUndefined();
    const based = await buildNewsPayload(deps(store), portfolio(), "sub", { symbol: "ZZTEST.TO" }, lenient);
    expect(based.filters.symbol).toBe("ZZTEST");
    expect(based.symbols.map((s) => s.symbol)).toEqual(["ZZTEST"]);
    const missing = await buildNewsPayload(deps(store), portfolio(), "sub", { symbol: "NOPE" }, lenient);
    expect(missing.filters.symbol).toBeUndefined();
    expect(missing.filters.symbolNotHeld).toBe("NOPE");
    expect(missing.symbols.length).toBe(4);
    expect(newsText(missing)).toContain("NOPE isn't in your holdings; showing all.");
    // get_news (strict) still throws
    await expect(buildNewsPayload(deps(store), portfolio(), "sub", { symbol: "NOPE" })).rejects.toBeInstanceOf(NewsScopeError);
  });

  it("filtered text leads with the symbol, mood word, article count and the reason line", async () => {
    const { store } = await seed();
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", { symbol: "ZZTEST" });
    const text = newsText(p, { show: true });
    const n = p.symbols[0]!.mood.articles;
    expect(text.startsWith(`ZZTEST: ${p.symbols[0]!.mood.level.replace(/_/g, " ")}, ${n} article${n === 1 ? "" : "s"} in the window.`)).toBe(true);
    expect(text).toContain("ZZTEST moved more than usual: ZZTEST wins invented contract (synthetic.example) (AI-rated; may be wrong).");
    expect(text).toContain("News and ratings are for information only, not investment advice.");
    expect(text).toContain("Showing the news widget.");
    expect(text).not.toContain("Portfolio news mood");
    const calm = await buildNewsPayload(deps(store), portfolio(), "sub", { symbol: "ZZCALM" });
    expect(newsText(calm)).toMatch(/^ZZCALM: not enough news, 0 articles in the window\./);
    expect(newsText(calm)).not.toContain("moved more than usual");
  });

  it("input is strict and normalises the symbol", () => {
    expect(newsInput.parse({ symbol: " zztest " })).toEqual({ symbol: "ZZTEST" });
    expect(() => newsInput.parse({ window: "1y" })).toThrow();
    expect(() => newsInput.parse({ extra: 1 })).toThrow();
  });
});

describe("buildNewsResult: refreshed and noRefresh (rate limits)", () => {
  it("refreshed is false on a cache hit (every symbol fresh)", async () => {
    const { store } = await seed();
    const d = deps(store);
    const r = await buildNewsResult(d, portfolio(), "sub", {});
    expect(d.refresh.refreshSymbols).not.toHaveBeenCalled();
    expect(r.refreshed).toBe(false);
  });

  it("refreshed is true when a stale symbol was refreshed", async () => {
    const { store } = await seed();
    await store.markFetched("ZZTEST", hoursAgo(7));
    const d = deps(store);
    const r = await buildNewsResult(d, portfolio(), "sub", {});
    expect(d.refresh.refreshSymbols).toHaveBeenCalledTimes(1);
    expect(r.refreshed).toBe(true);
  });

  it("refreshed is false when the budget is exhausted (nothing was fetched)", async () => {
    const { store } = await seed();
    await store.markFetched("ZZTEST", hoursAgo(20));
    await store.spendBudget("2026-10-21", 90);
    const r = await buildNewsResult(deps(store), portfolio(), "sub", {});
    expect(r.refreshed).toBe(false);
  });

  it("noRefresh skips the on-demand refresh and serves the cache", async () => {
    const { store } = await seed();
    await store.markFetched("ZZTEST", hoursAgo(20));
    const d = deps(store);
    const r = await buildNewsResult(d, portfolio(), "sub", {}, { noRefresh: true });
    expect(d.refresh.refreshSymbols).not.toHaveBeenCalled();
    expect(r.refreshed).toBe(false);
    expect(r.payload.newsAsOf).toBe(hoursAgo(20).toISOString());
    expect(r.payload.feed.length).toBeGreaterThan(0);
  });

  it("buildNewsPayload keeps its payload shape (no refreshed key)", async () => {
    const { store } = await seed();
    const p = await buildNewsPayload(deps(store), portfolio(), "sub", {});
    expect(Object.keys(p)).not.toContain("refreshed");
  });
});
