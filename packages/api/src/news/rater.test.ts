import { describe, expect, it, vi } from "vitest";
import type { JevAnswers, JevState } from "./jev.js";
import { rateUnrated } from "./rater.js";
import { MemoryNewsStore, type StoredArticle } from "./store.js";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const hash = (n: number) => String(n).padStart(64, "0");
const COMPANIES: Record<string, string> = { ZZA: "Zz Alpha Inc", ZZB: "Zz Beta Ltd", ZZC: "Zz Gamma Co", ZZD: "Zz Delta plc", ZZE: "Zz Epsilon SA" };
const companyName = (s: string) => COMPANIES[s] ?? s;

const draft = (n: number, over: Partial<Omit<StoredArticle, "id">> = {}): Omit<StoredArticle, "id"> => ({
  urlHash: hash(n),
  url: `https://news.example/a/${n}`,
  headline: `ZZA synthetic headline ${n}`,
  snippet: `synthetic snippet ${n}`,
  source: `source${n}.example`,
  imageUrl: null,
  publishedAt: hoursAgo(n),
  symbols: ["ZZA"],
  fetchedAt: NOW,
  ...over,
});

const answers = (over: Partial<JevAnswers> = {}): JevAnswers => ({
  relevant: 0.9,
  sentiment: { score: 3.1, confidence: 0.7 },
  materiality: { score: 2.2, confidence: 0.6 },
  eventType: { choice: "earnings", confidence: 0.8 },
  credible: 0.85,
  clickbait: 0.1,
  duplicates: {},
  ...over,
});

function fakeJev(answer: (state: JevState, ids: string[]) => JevAnswers | Promise<JevAnswers>) {
  const rate = vi.fn(async (state: JevState, ids: string[]) => answer(state, ids));
  return { jev: { model: "jev-test", rate }, rate };
}

const base = (store: MemoryNewsStore, jev: ReturnType<typeof fakeJev>["jev"], over = {}) => ({
  store, jev, companyName, now: () => NOW, symbols: ["ZZA", "ZZB", "ZZC", "ZZD", "ZZE"], log: () => {}, ...over,
});

describe("rateUnrated deadline", () => {
  it("stops starting new ratings at the deadline and counts the rest as skipped", async () => {
    const store = new MemoryNewsStore();
    await store.upsertArticles([draft(1), draft(2), draft(3)]);
    let t = NOW.getTime();
    const { jev, rate } = fakeJev(() => { t += 5_000; return answers(); });
    const out = await rateUnrated({ ...base(store, jev), now: () => new Date(t), deadline: new Date(NOW.getTime() + 8_000) });
    expect(rate).toHaveBeenCalledTimes(2); // starts at 0 s and 5 s; 10 s is past the deadline
    expect(out).toEqual({ rated: 2, failed: 0, skipped: 1 });
  });
});

describe("rateUnrated concurrency", () => {
  it("rates four pairs at a time by default and every pair once", async () => {
    const store = new MemoryNewsStore();
    await store.upsertArticles(Array.from({ length: 10 }, (_, i) => draft(i + 1)));
    let inFlight = 0;
    let peak = 0;
    const { jev, rate } = fakeJev(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return answers();
    });
    await expect(rateUnrated(base(store, jev))).resolves.toEqual({ rated: 10, failed: 0 });
    expect(peak).toBe(4);
    expect(new Set(rate.mock.calls.map((c) => c[0].article.headline)).size).toBe(10);
    expect(await store.unratedFor(["ZZA"], new Date(0))).toEqual([]);
  });

  it("honours a lower concurrency", async () => {
    const store = new MemoryNewsStore();
    await store.upsertArticles(Array.from({ length: 4 }, (_, i) => draft(i + 1)));
    let inFlight = 0;
    let peak = 0;
    const { jev } = fakeJev(async () => { inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 1)); inFlight -= 1; return answers(); });
    await rateUnrated(base(store, jev, { concurrency: 1 }));
    expect(peak).toBe(1);
  });
});

describe("rateUnrated", () => {
  it("rates each (article, symbol) once and maps answers to stored ratings", async () => {
    const store = new MemoryNewsStore();
    const [a] = await store.upsertArticles([draft(1)]);
    const { jev, rate } = fakeJev(() => answers());
    await expect(rateUnrated(base(store, jev))).resolves.toEqual({ rated: 1, failed: 0 });
    expect(rate).toHaveBeenCalledTimes(1);
    expect(rate.mock.calls[0][0]).toEqual({
      ticker: "ZZA",
      company: "Zz Alpha Inc",
      article: { headline: a.headline, snippet: a.snippet, source: a.source, published_at: a.publishedAt.toISOString() },
      candidates: {},
    });
    expect(await store.ratingsFor([a.id])).toEqual([{
      articleId: a.id, symbol: "ZZA", model: "jev-test", ratedAt: NOW,
      relevant: 0.9, sentiment: 3.1, sentimentConfidence: 0.7, materiality: 2.2,
      eventType: "earnings", eventConfidence: 0.8, credible: 0.85, clickbait: 0.1, duplicateOf: null,
    }]);
    await expect(rateUnrated(base(store, jev))).resolves.toEqual({ rated: 0, failed: 0 });
    expect(rate).toHaveBeenCalledTimes(1);
  });

  it("nulls eventType when the choice confidence is below 0.5, and unknown choices", async () => {
    const store = new MemoryNewsStore();
    const [a, b] = await store.upsertArticles([draft(1), draft(200, { symbols: ["ZZB"] })]);
    const { jev } = fakeJev((s) => answers({ eventType: s.ticker === "ZZA" ? { choice: "earnings", confidence: 0.49 } : { choice: "bogus", confidence: 0.9 } }));
    await rateUnrated(base(store, jev));
    const r = await store.ratingsFor([a.id, b.id]);
    expect(r.map((x) => [x.symbol, x.eventType, x.eventConfidence])).toEqual(expect.arrayContaining([["ZZA", null, 0.49], ["ZZB", null, 0.9]]));
  });

  it("offers up to five same-symbol candidates within 7 days and stores the max duplicate at or above 0.7", async () => {
    const store = new MemoryNewsStore();
    // target at 24h ago; neighbours at various distances; one other-symbol article; one 8 days away.
    const rows = await store.upsertArticles([
      draft(24, { headline: "target" }),
      draft(25), draft(26), draft(30), draft(40), draft(60), draft(80),
      draft(23), draft(20), draft(10), // later than the target: never offered
      draft(27, { symbols: ["ZZB"] }),
      draft(24 + 8 * 24),
    ]);
    const target = rows[0];
    const byHours = new Map(rows.map((r) => [Math.round((NOW.getTime() - r.publishedAt.getTime()) / 3_600_000), r]));
    const { jev, rate } = fakeJev((s, ids) => {
      if (s.article.headline !== "target") return answers();
      const dup: Record<string, number> = {};
      for (const id of ids) dup[id] = 0.2;
      const near = ids.find((id) => s.candidates[id].published_at === byHours.get(26)!.publishedAt.toISOString())!;
      const nearer = ids.find((id) => s.candidates[id].published_at === byHours.get(25)!.publishedAt.toISOString())!;
      dup[near] = 0.95;
      dup[nearer] = 0.71;
      return answers({ duplicates: dup });
    });
    await rateUnrated(base(store, jev, { symbols: ["ZZA"] }));
    const call = rate.mock.calls.find(([s]) => s.article.headline === "target")!;
    const [state, ids] = call;
    expect(ids).toHaveLength(5);
    expect(Object.keys(state.candidates).sort()).toEqual([...ids].sort());
    const offered = Object.values(state.candidates).map((c) => c.published_at).sort();
    expect(offered).toEqual([25, 26, 30, 40, 60].map((h) => hoursAgo(h).toISOString()).sort());
    expect(Object.values(state.candidates)[0]).toEqual({ headline: expect.any(String), source: expect.any(String), published_at: expect.any(String) });
    const [stored] = (await store.ratingsFor([target.id])).filter((r) => r.symbol === "ZZA");
    expect(stored.duplicateOf).toBe(byHours.get(26)!.id);
  });

  it("offers only earlier articles, so two articles can never mark each other as duplicates", async () => {
    const store = new MemoryNewsStore();
    const [older, newer] = await store.upsertArticles([draft(5), draft(4)]);
    const { jev, rate } = fakeJev((_s, ids) => answers({ duplicates: Object.fromEntries(ids.map((id) => [id, 0.95])) }));
    await rateUnrated(base(store, jev));
    const offered = new Map(rate.mock.calls.map(([s, ids]) => [s.article.published_at, ids.length]));
    expect(offered.get(older.publishedAt.toISOString())).toBe(0);
    expect(offered.get(newer.publishedAt.toISOString())).toBe(1);
    const byId = new Map((await store.ratingsFor([older.id, newer.id])).map((r) => [r.articleId, r.duplicateOf]));
    expect(byId.get(older.id)).toBeNull();
    expect(byId.get(newer.id)).toBe(older.id);
  });

  it("breaks equal publishedAt ties by id: the smaller id counts as earlier", async () => {
    const store = new MemoryNewsStore();
    const same = hoursAgo(6);
    const rows = await store.upsertArticles([draft(6, { publishedAt: same }), draft(7, { publishedAt: same })]);
    const [first, second] = [...rows].sort((x, y) => x.id.localeCompare(y.id));
    const { jev } = fakeJev((_s, ids) => answers({ duplicates: Object.fromEntries(ids.map((id) => [id, 0.95])) }));
    await rateUnrated(base(store, jev));
    const byId = new Map((await store.ratingsFor([first.id, second.id])).map((r) => [r.articleId, r.duplicateOf]));
    expect(byId.get(first.id)).toBeNull();
    expect(byId.get(second.id)).toBe(first.id);
  });

  it("counts only the ratings the store actually stored", async () => {
    const store = new MemoryNewsStore();
    await store.upsertArticles([draft(1), draft(2), draft(3)]);
    const real = store.putRatings.bind(store);
    store.putRatings = async (r) => { await real(r); return r.length - 1; }; // e.g. one article swept meanwhile
    const { jev } = fakeJev(() => answers());
    await expect(rateUnrated(base(store, jev))).resolves.toEqual({ rated: 2, failed: 0 });
  });

  it("stores no duplicate when every dup answer is below 0.7", async () => {
    const store = new MemoryNewsStore();
    const [a] = await store.upsertArticles([draft(1), draft(2)]);
    const { jev } = fakeJev((_s, ids) => answers({ duplicates: Object.fromEntries(ids.map((id) => [id, 0.69])) }));
    await rateUnrated(base(store, jev));
    expect((await store.ratingsFor([a.id]))[0].duplicateOf).toBeNull();
  });

  it("rates a five-ticker round-up separately per symbol, so relevance comes from the model per company", async () => {
    const store = new MemoryNewsStore();
    const [roundUp] = await store.upsertArticles([draft(3, { headline: "Synthetic sector round-up", symbols: ["ZZA", "ZZB", "ZZC", "ZZD", "ZZE"] })]);
    const { jev, rate } = fakeJev((s) => answers({ relevant: s.ticker === "ZZC" ? 0.88 : 0.12 }));
    await expect(rateUnrated(base(store, jev))).resolves.toEqual({ rated: 5, failed: 0 });
    expect(rate.mock.calls.map(([s]) => [s.ticker, s.company]).sort()).toEqual(Object.entries(COMPANIES).sort());
    const ratings = await store.ratingsFor([roundUp.id]);
    expect(Object.fromEntries(ratings.map((r) => [r.symbol, r.relevant]))).toEqual({ ZZA: 0.12, ZZB: 0.12, ZZC: 0.88, ZZD: 0.12, ZZE: 0.12 });
    expect(ratings.filter((r) => r.relevant >= 0.6).map((r) => r.symbol)).toEqual(["ZZC"]);
  });

  it("counts failures without throwing and leaves failed pairs unrated for the next run", async () => {
    const store = new MemoryNewsStore();
    const rows = await store.upsertArticles([draft(1), draft(2), draft(3)]);
    const { jev } = fakeJev((s) => {
      if (s.article.headline.endsWith(" 2")) throw new Error("jev down");
      return answers();
    });
    await expect(rateUnrated(base(store, jev))).resolves.toEqual({ rated: 2, failed: 1 });
    const left = await store.unratedFor(["ZZA"], new Date(0));
    expect(left.map((p) => p.article.id)).toEqual([rows[1].id]);
  });

  it("caps the run at maxPerRun (default 200)", async () => {
    const store = new MemoryNewsStore();
    await store.upsertArticles(Array.from({ length: 205 }, (_, i) => draft(i + 1, { publishedAt: hoursAgo(i) })));
    const { jev, rate } = fakeJev(() => answers());
    await expect(rateUnrated(base(store, jev, { maxPerRun: 3 }))).resolves.toEqual({ rated: 3, failed: 0 });
    expect(rate).toHaveBeenCalledTimes(3);
    await expect(rateUnrated(base(store, jev))).resolves.toEqual({ rated: 200, failed: 0 });
  });

  it("rates only articles published in the last 30 days", async () => {
    const store = new MemoryNewsStore();
    await store.upsertArticles([draft(1, { publishedAt: hoursAgo(29 * 24) }), draft(2, { publishedAt: hoursAgo(31 * 24) })]);
    const { jev, rate } = fakeJev(() => answers());
    await expect(rateUnrated(base(store, jev))).resolves.toEqual({ rated: 1, failed: 0 });
    expect(rate.mock.calls.map((c) => c[0].article.headline)).toEqual(["ZZA synthetic headline 1"]);
  });

  it("logs only counts, latency and model", async () => {
    const store = new MemoryNewsStore();
    await store.upsertArticles([draft(1, { headline: "SECRET-HEADLINE" })]);
    const log = vi.fn();
    const { jev } = fakeJev(() => answers());
    await rateUnrated(base(store, jev, { log }));
    expect(log).toHaveBeenCalledTimes(1);
    const [event] = log.mock.calls[0];
    expect(Object.keys(event).sort()).toEqual(["event", "failed", "latencyMs", "model", "rated"]);
    expect(event).toMatchObject({ event: "news_rating", rated: 1, failed: 0, model: "jev-test" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET-HEADLINE");
  });
});
