import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryNewsStore, PrismaNewsStore, type ArticleRating, type CalendarEvent, type NewsStore, type StoredArticle, type SymbolStats } from "./store.js";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const hash = (n: number) => String(n).padStart(64, "0");

const article = (n: number, over: Partial<Omit<StoredArticle, "id">> = {}): Omit<StoredArticle, "id"> => ({
  urlHash: hash(n),
  url: `https://news.example/a/${n}`,
  headline: `ZZTEST headline ${n}`,
  snippet: "short",
  source: "example.com",
  imageUrl: null,
  publishedAt: daysAgo(1),
  symbols: ["ZZTEST"],
  fetchedAt: NOW,
  ...over,
});

const rating = (articleId: string, symbol: string, over: Partial<ArticleRating> = {}): ArticleRating => ({
  articleId,
  symbol,
  model: "jev-test",
  ratedAt: NOW,
  relevant: 0.9,
  sentiment: 3,
  sentimentConfidence: 0.8,
  materiality: 2,
  eventType: null,
  eventConfidence: 0,
  credible: 0.9,
  clickbait: 0.1,
  duplicateOf: null,
  ...over,
});

describe("MemoryNewsStore contract", () => {
  let store: NewsStore;
  beforeEach(() => {
    store = new MemoryNewsStore();
  });

  it("dedupes articles by urlHash, assigns ids and unions symbols", async () => {
    const [a] = await store.upsertArticles([article(1)]);
    expect(a!.id).toBeTruthy();
    const again = await store.upsertArticles([article(1, { symbols: ["ZZOTHER"], headline: "changed" })]);
    expect(again).toHaveLength(1);
    expect(again[0]!.id).toBe(a!.id);
    expect(again[0]!.headline).toBe(a!.headline);
    expect([...again[0]!.symbols].sort()).toEqual(["ZZOTHER", "ZZTEST"]);
    const dup = await store.upsertArticles([article(2), article(2)]);
    expect(dup).toHaveLength(1);
  });

  it("clamps snippets to 200 characters", async () => {
    const [a] = await store.upsertArticles([article(1, { snippet: "x".repeat(500) })]);
    expect(a!.snippet).toHaveLength(200);
  });

  it("clamps headline and source, and skips articles whose url exceeds 2048 characters", async () => {
    const got = await store.upsertArticles([
      article(1, { headline: "h".repeat(900), source: "s".repeat(400), imageUrl: "https://x.example/" + "i".repeat(3000) }),
      article(2, { url: "https://news.example/" + "u".repeat(2100) }),
    ]);
    expect(got).toHaveLength(1);
    expect(got[0]!.headline).toHaveLength(500);
    expect(got[0]!.source).toHaveLength(200);
    expect(got[0]!.imageUrl).toBeNull();
  });

  it("skips ratings for unknown articles", async () => {
    const [a] = await store.upsertArticles([article(1)]);
    await expect(store.putRatings([rating("00000000-0000-4000-8000-000000000000", "ZZTEST"), rating(a!.id, "ZZTEST")])).resolves.toBe(1);
    await expect(store.putRatings([])).resolves.toBe(0);
    expect((await store.ratingsFor([a!.id, "00000000-0000-4000-8000-000000000000"])).map((r) => r.articleId)).toEqual([a!.id]);
  });

  it("rejects non-positive-integer budget spends", async () => {
    for (const n of [0, -1, 1.5, Number.NaN]) await expect(store.spendBudget("2026-10-21", n)).rejects.toThrow(/positive integer/);
    expect(await store.budgetSpent("2026-10-21")).toBe(0);
  });

  it("returns articles for symbols since a date, newest first", async () => {
    await store.upsertArticles([
      article(1, { publishedAt: daysAgo(5) }),
      article(2, { publishedAt: daysAgo(1) }),
      article(3, { symbols: ["ZZNONE"], publishedAt: daysAgo(1) }),
      article(4, { publishedAt: daysAgo(20) }),
    ]);
    const got = await store.articlesForSymbols(["ZZTEST"], daysAgo(10));
    expect(got.map((x) => x.urlHash)).toEqual([hash(2), hash(1)]);
    expect(await store.articlesForSymbols([], daysAgo(10))).toEqual([]);
  });

  it("tracks per-symbol fetch times", async () => {
    expect(await store.latestFetch("ZZTEST")).toBeNull();
    await store.markFetched("ZZTEST", daysAgo(1));
    await store.markFetched("ZZTEST", NOW);
    expect(await store.latestFetch("ZZTEST")).toEqual(NOW);
  });

  it("stores ratings idempotently per (article, symbol) and excludes rated pairs from unratedFor", async () => {
    const [a, b] = await store.upsertArticles([article(1, { symbols: ["ZZTEST", "ZZOTHER"] }), article(2)]);
    expect((await store.unratedFor(["ZZTEST", "ZZOTHER"], daysAgo(30))).map((p) => `${p.article.id === a!.id ? "a" : "b"}:${p.symbol}`).sort()).toEqual(["a:ZZOTHER", "a:ZZTEST", "b:ZZTEST"]);
    await store.putRatings([rating(a!.id, "ZZTEST")]);
    await store.putRatings([rating(a!.id, "ZZTEST", { relevant: 0.2 })]);
    const rated = await store.ratingsFor([a!.id, b!.id]);
    expect(rated).toHaveLength(1);
    expect(rated[0]!.relevant).toBe(0.2);
    const unrated = await store.unratedFor(["ZZTEST", "ZZOTHER"], daysAgo(30));
    expect(unrated.map((p) => `${p.article.id === a!.id ? "a" : "b"}:${p.symbol}`).sort()).toEqual(["a:ZZOTHER", "b:ZZTEST"]);
    expect(await store.unratedFor(["ZZNONE"], daysAgo(30))).toEqual([]);
  });

  it("stores and reads symbol stats, replacing on conflict", async () => {
    const s: SymbolStats = { symbol: "ZZTEST", currency: "CAD", closes: 60, typicalMove: 0.01, lastClose: 10, prevClose: 9.9, lastCloseDate: "2026-10-20", updatedAt: NOW };
    await store.putStats([s, { ...s, symbol: "ZZOTHER", closes: 5, typicalMove: null }]);
    await store.putStats([{ ...s, closes: 61 }]);
    const got = await store.stats(["ZZTEST"]);
    expect(got).toEqual([{ ...s, closes: 61 }]);
    expect(await store.stats([])).toEqual([]);
  });

  it("stores calendar events, replaces by id, and filters by symbol and date range", async () => {
    const ev = (id: string, symbol: string, date: Date, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
      id, symbol, kind: "earnings", date, status: "expected", source: "edgar", amountPerUnit: null, currency: null, ...over,
    });
    await store.putEvents([ev("e1", "ZZTEST", daysAgo(-3)), ev("e2", "ZZTEST", daysAgo(-40)), ev("e3", "ZZNONE", daysAgo(-3))]);
    await store.putEvents([ev("e1", "ZZTEST", daysAgo(-4), { status: "confirmed" })]);
    const got = await store.events(["ZZTEST"], NOW, daysAgo(-14));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: "e1", status: "confirmed" });
  });

  it("replaceEvents replaces one symbol's events of one kind dated from a day on, keeping earlier ones and other kinds", async () => {
    const ev = (id: string, kind: CalendarEvent["kind"], date: Date): CalendarEvent => ({
      id, symbol: "ZZTEST", kind, date, status: "expected", source: "edgar", amountPerUnit: null, currency: null,
    });
    await store.putEvents([ev("past", "earnings", daysAgo(5)), ev("old-future", "earnings", daysAgo(-10)), ev("div", "dividend_pay", daysAgo(-10))]);
    await store.putEvents([{ ...ev("other", "earnings", daysAgo(-10)), symbol: "ZZOTHER" }]);
    await store.replaceEvents("ZZTEST", "earnings", NOW, [ev("new-future", "earnings", daysAgo(-12))]);
    const ids = (await store.events(["ZZTEST", "ZZOTHER"], daysAgo(30), daysAgo(-30))).map((e) => e.id).sort();
    expect(ids).toEqual(["div", "new-future", "other", "past"]);
    await store.replaceEvents("ZZTEST", "dividend_pay", NOW, []);
    expect((await store.events(["ZZTEST"], daysAgo(30), daysAgo(-30))).map((e) => e.id).sort()).toEqual(["new-future", "past"]);
  });

  it("records alert deliveries idempotently per (user, client, alert), returning only the ids it inserted", async () => {
    expect((await store.deliveredAlertIds("u1", "c1", daysAgo(180))).size).toBe(0);
    expect(await store.recordDeliveries("u1", "c1", ["a", "b"], NOW)).toEqual(["a", "b"]);
    expect(await store.recordDeliveries("u1", "c1", ["b", "c", "c"], daysAgo(-1))).toEqual(["c"]);
    expect([...(await store.deliveredAlertIds("u1", "c1", daysAgo(180)))].sort()).toEqual(["a", "b", "c"]);
    expect((await store.deliveredAlertIds("u1", "c2", daysAgo(180))).size).toBe(0);
    expect((await store.deliveredAlertIds("u2", "c1", daysAgo(180))).size).toBe(0);
  });

  it("bounds unratedFor by publish date and deliveredAlertIds by delivery date", async () => {
    const [recent, old] = await store.upsertArticles([article(1, { publishedAt: daysAgo(29) }), article(2, { publishedAt: daysAgo(31) })]);
    expect((await store.unratedFor(["ZZTEST"], daysAgo(30))).map((p) => p.article.id)).toEqual([recent!.id]);
    expect(old).toBeDefined();
    await store.recordDeliveries("u1", "c1", ["old"], daysAgo(181));
    await store.recordDeliveries("u1", "c1", ["new"], daysAgo(179));
    expect([...(await store.deliveredAlertIds("u1", "c1", daysAgo(180)))]).toEqual(["new"]);
  });

  it("returns an article's stored image URL by id, or null for unknown ids and articles without one", async () => {
    const [withImage, without] = await store.upsertArticles([article(1, { imageUrl: "https://img.example.invalid/zz.png" }), article(2)]);
    expect(await store.articleImageUrl(withImage!.id)).toBe("https://img.example.invalid/zz.png");
    expect(await store.articleImageUrl(without!.id)).toBeNull();
    expect(await store.articleImageUrl("00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await store.articleImageUrl("not-a-uuid")).toBeNull();
  });

  it("returns the running total from spendBudget, per day", async () => {
    expect(await store.budgetSpent("2026-10-21")).toBe(0);
    expect(await store.spendBudget("2026-10-21", 3)).toBe(3);
    expect(await store.spendBudget("2026-10-21", 2)).toBe(5);
    expect(await store.budgetSpent("2026-10-21")).toBe(5);
    expect(await store.budgetSpent("2026-10-22")).toBe(0);
  });

  it("sweeps articles older than 90 days (with ratings) and deliveries older than 180 days", async () => {
    const [old, fresh] = await store.upsertArticles([article(1, { publishedAt: daysAgo(91) }), article(2, { publishedAt: daysAgo(89) })]);
    await store.putRatings([rating(old!.id, "ZZTEST"), rating(fresh!.id, "ZZTEST")]);
    await store.recordDeliveries("u1", "c1", ["old"], daysAgo(181));
    await store.recordDeliveries("u1", "c1", ["new"], daysAgo(179));
    expect(await store.sweep(NOW)).toEqual({ articles: 1, deliveries: 1, events: 0 });
    expect((await store.ratingsFor([old!.id, fresh!.id])).map((r) => r.articleId)).toEqual([fresh!.id]);
    expect([...(await store.deliveredAlertIds("u1", "c1", daysAgo(180)))]).toEqual(["new"]);
    expect(await store.sweep(NOW)).toEqual({ articles: 0, deliveries: 0, events: 0 });
  });

  it("sweeps calendar events dated more than 90 days ago, keeping the recent past", async () => {
    const ev = (id: string, date: Date): CalendarEvent => ({ id, symbol: "ZZTEST", kind: "earnings", date, status: "expected", source: "edgar", amountPerUnit: null, currency: null });
    await store.putEvents([ev("old", daysAgo(91)), ev("recent", daysAgo(7)), ev("future", daysAgo(-10))]);
    expect(await store.sweep(NOW)).toEqual({ articles: 0, deliveries: 0, events: 1 });
    expect((await store.events(["ZZTEST"], daysAgo(400), daysAgo(-400))).map((e) => e.id)).toEqual(["recent", "future"]);
  });
});

describe("PrismaNewsStore.articleImageUrl", () => {
  it("selects only the image URL by id and never queries with a non-uuid id", async () => {
    const findUnique = vi.fn(async () => ({ imageUrl: "https://img.example.invalid/zz.png" }));
    const store = new PrismaNewsStore({ newsArticle: { findUnique } } as never);
    expect(await store.articleImageUrl("not-a-uuid")).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
    const id = "3f1c2b4a-1d2e-4f3a-9b8c-7d6e5f4a3b2c";
    expect(await store.articleImageUrl(id)).toBe("https://img.example.invalid/zz.png");
    expect(findUnique).toHaveBeenCalledWith({ where: { id }, select: { imageUrl: true } });
  });
});

describe("PrismaNewsStore.replaceEvents", () => {
  it("deletes the symbol's same-kind events from the day on (except the new ids), then upserts the new ones", async () => {
    const calls: string[] = [];
    const deleteMany = vi.fn(async (a: unknown) => { calls.push("delete"); return { count: 1, a }; });
    const upsert = vi.fn(async () => { calls.push("upsert"); return {}; });
    const store = new PrismaNewsStore({ newsCalendarEvent: { deleteMany, upsert } } as never);
    const e: CalendarEvent = { id: "earnings:ZZTEST:2026-11-05", symbol: "ZZTEST", kind: "earnings", date: new Date("2026-11-05T00:00:00Z"), status: "expected", source: "edgar", amountPerUnit: null, currency: null };
    await store.replaceEvents("ZZTEST", "earnings", NOW, [e]);
    expect(deleteMany).toHaveBeenCalledWith({ where: { symbol: "ZZTEST", kind: "earnings", date: { gte: NOW }, id: { notIn: [e.id] } } });
    expect(calls).toEqual(["delete", "upsert"]);
  });
});

describe("PrismaNewsStore bounded reads and delivery inserts", () => {
  it("unratedFor and deliveredAlertIds pass their date lower bounds to the query", async () => {
    const findMany = vi.fn(async () => []);
    const store = new PrismaNewsStore({ newsArticle: { findMany }, newsAlertDelivery: { findMany } } as never);
    await store.unratedFor(["ZZTEST"], daysAgo(30));
    expect(findMany.mock.calls[0]).toMatchObject([{ where: { symbols: { hasSome: ["ZZTEST"] }, publishedAt: { gte: daysAgo(30) } } }]);
    await store.deliveredAlertIds("u1", "c1", daysAgo(180));
    expect(findMany.mock.calls[1]).toEqual([{ where: { appUserId: "u1", clientKey: "c1", deliveredAt: { gte: daysAgo(180) } }, select: { alertId: true } }]);
  });

  it("recordDeliveries inserts with skipDuplicates and returns only the rows the insert returned", async () => {
    const createManyAndReturn = vi.fn(async () => [{ alertId: "b" }]);
    const store = new PrismaNewsStore({ newsAlertDelivery: { createManyAndReturn } } as never);
    expect(await store.recordDeliveries("u1", "c1", ["a", "b", "a"], NOW)).toEqual(["b"]);
    expect(createManyAndReturn).toHaveBeenCalledWith({
      data: [{ appUserId: "u1", clientKey: "c1", alertId: "a", deliveredAt: NOW }, { appUserId: "u1", clientKey: "c1", alertId: "b", deliveredAt: NOW }],
      skipDuplicates: true,
      select: { alertId: true },
    });
    expect(await store.recordDeliveries("u1", "c1", [], NOW)).toEqual([]);
    expect(createManyAndReturn).toHaveBeenCalledTimes(1);
  });
});

describe("PrismaNewsStore.sweep", () => {
  it("deletes calendar events dated before now − 90 d", async () => {
    const del = () => vi.fn(async () => ({ count: 2 }));
    const db = { newsArticle: { deleteMany: del() }, newsAlertDelivery: { deleteMany: del() }, newsCalendarEvent: { deleteMany: del() } };
    const store = new PrismaNewsStore(db as never);
    expect(await store.sweep(NOW)).toEqual({ articles: 2, deliveries: 2, events: 2 });
    expect(db.newsCalendarEvent.deleteMany).toHaveBeenCalledWith({ where: { date: { lt: daysAgo(90) } } });
  });
});
