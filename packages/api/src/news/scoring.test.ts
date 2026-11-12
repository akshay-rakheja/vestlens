import { describe, expect, it } from "vitest";
import {
  dedupeLookThrough, impact, levelFor, lookThroughRatings, moodFor, portfolioMood, rank, reasonFor, recency, weightedMoodFor, type Mood,
} from "./scoring.js";
import type { ArticleRating, StoredArticle } from "./store.js";

const NOW = new Date("2026-10-21T15:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const rating = (o: Partial<ArticleRating> = {}): ArticleRating => ({
  articleId: "a1", symbol: "ZZTEST", model: "jev-test", ratedAt: NOW, relevant: 1, sentiment: 2, sentimentConfidence: 1,
  materiality: 0, eventType: null, eventConfidence: 0, credible: 1, clickbait: 0, duplicateOf: null, ...o,
});
const article = (id: string, ageHours: number, symbols = ["ZZTEST"]): StoredArticle => ({
  id, urlHash: `h-${id}`, url: `https://example.test/${id}`, headline: `Synthetic headline ${id}`, snippet: null,
  source: "Example Wire", imageUrl: null, publishedAt: hoursAgo(ageHours), symbols, fetchedAt: NOW,
});
const item = (sentiment: number, ageHours: number, o: Partial<ArticleRating> = {}) => ({
  rating: rating({ sentiment, ...o }), publishedAt: hoursAgo(ageHours),
});

describe("impact / recency / rank", () => {
  it("worked example: relevant 0.9, sentiment 0, materiality 3, credible 1 -> 0.9", () => {
    expect(impact(rating({ relevant: 0.9, sentiment: 0, materiality: 3, credible: 1 }))).toBeCloseTo(0.9, 12);
  });
  it("relevant is a multiplier and a neutral, immaterial, non-credible article scores 0", () => {
    expect(impact(rating({ relevant: 0, sentiment: 4, materiality: 3, credible: 1 }))).toBe(0);
    expect(impact(rating({ relevant: 1, sentiment: 2, materiality: 0, credible: 0 }))).toBe(0);
    // 0.5 × |3-2|/2 + 0.3 × 1/3 + 0.2 × 0.5 = 0.25 + 0.1 + 0.1 = 0.45, × 0.5
    expect(impact(rating({ relevant: 0.5, sentiment: 3, materiality: 1, credible: 0.5 }))).toBeCloseTo(0.225, 12);
  });
  it("recency(0) = 1, recency(48) ≈ 0.3679, recency(96) ≈ 0.1353", () => {
    expect(recency(0)).toBe(1);
    expect(recency(48)).toBeCloseTo(0.3679, 4);
    expect(recency(96)).toBeCloseTo(Math.exp(-2), 12);
  });
  it("rank = impact × recency of the publish age", () => {
    const r = rating({ relevant: 0.9, sentiment: 0, materiality: 3, credible: 1 });
    expect(rank(r, NOW, hoursAgo(48))).toBeCloseTo(0.9 * Math.exp(-1), 12);
  });
});

describe("future-dated articles", () => {
  it("clamp age at 0: rank never exceeds impact", () => {
    const r = rating({ relevant: 0.9, sentiment: 0, materiality: 3, credible: 1 });
    expect(rank(r, NOW, hoursAgo(-10))).toBeCloseTo(0.9, 12);
    const m = moodFor([item(4, -10), item(0, 0)], NOW);
    expect(m.value).toBeCloseTo(0, 12);
  });
});

describe("moodFor", () => {
  it("one article -> not_enough_news with value null, estimated", () => {
    const m = moodFor([item(4, 1)], NOW);
    expect(m).toEqual({ level: "not_enough_news", value: null, articles: 1, mostRecentAt: hoursAgo(1), estimated: true });
  });
  it("zero articles -> not_enough_news, no invented neutral", () => {
    expect(moodFor([], NOW)).toEqual({ level: "not_enough_news", value: null, articles: 0, mostRecentAt: null, estimated: true });
  });
  it("is the recency-weighted mean of (sentiment - 2)/2", () => {
    // s=4 at 0h (w=1, x=1), s=0 at 48h (w=e^-1, x=-1)
    const w = Math.exp(-1);
    const m = moodFor([item(4, 0), item(0, 48)], NOW);
    expect(m.value).toBeCloseTo((1 - w) / (1 + w), 12);
    expect(m.articles).toBe(2);
    expect(m.mostRecentAt).toEqual(hoursAgo(0));
    expect(m.estimated).toBe(true);
  });
  it("five levels at cut points -0.6, -0.2, 0.2, 0.6 (exact boundaries via levelFor)", () => {
    expect(levelFor(-1)).toBe("strongly_negative");
    expect(levelFor(-0.6000001)).toBe("strongly_negative");
    expect(levelFor(-0.6)).toBe("negative");
    expect(levelFor(-0.2000001)).toBe("negative");
    expect(levelFor(-0.2)).toBe("neutral");
    expect(levelFor(0)).toBe("neutral");
    expect(levelFor(0.2)).toBe("neutral");
    expect(levelFor(0.2000001)).toBe("positive");
    expect(levelFor(0.6)).toBe("positive");
    expect(levelFor(0.6000001)).toBe("strongly_positive");
    expect(levelFor(1)).toBe("strongly_positive");
  });
  it("moodFor maps through the same levels", () => {
    // two same-age articles with sentiment s give value (s-2)/2
    const at = (s: number) => moodFor([item(s, 2), item(s, 2)], NOW).level;
    expect([at(0), at(1), at(2), at(3), at(4)]).toEqual(["strongly_negative", "negative", "neutral", "positive", "strongly_positive"]);
  });
  it("means that are mathematically exactly on a cut point land on the level nearer neutral (1e-9 tolerance)", () => {
    const at = (a: number, b: number) => moodFor([item(a, 2), item(b, 2)], NOW);
    expect(at(3.2, 3.2).level).toBe("positive"); // 0.6000000000000001 in floats
    expect(at(3.3, 3.1).level).toBe("positive");
    expect(at(2.6, 2.2).level).toBe("neutral"); // 0.20000000000000007
    expect(at(1.4, 1.8).level).toBe("neutral"); // -0.2
    expect(at(1.6, 1.6).level).toBe("neutral");
    expect(at(0.4, 1.2).level).toBe("negative"); // -0.6000000000000001
    expect(at(0.8, 0.8).level).toBe("negative"); // -0.6
    expect(at(0.79, 0.79).level).toBe("strongly_negative");
    expect(at(3.21, 3.21).level).toBe("strongly_positive");
  });
  it("excludes relevant < 0.6 and duplicates before the 2-article floor", () => {
    const m = moodFor([item(4, 1), item(0, 1, { relevant: 0.59 }), item(0, 1, { duplicateOf: "a1" })], NOW);
    expect(m.level).toBe("not_enough_news");
    expect(m.articles).toBe(1);
    const ok = moodFor([item(4, 1), item(4, 2, { relevant: 0.6 }), item(0, 1, { duplicateOf: "a1" })], NOW);
    expect(ok.level).toBe("strongly_positive");
    expect(ok.value).toBe(1);
    expect(ok.articles).toBe(2);
  });
});

describe("weightedMoodFor", () => {
  it("multiplies each recency term by weight", () => {
    const m = weightedMoodFor([
      { ...item(4, 0), weight: 0.75 },
      { ...item(0, 0), weight: 0.25 },
    ], NOW);
    expect(m.value).toBeCloseTo(0.5, 12);
    expect(m.level).toBe("positive");
  });
  it("applies the same gates and floor", () => {
    const m = weightedMoodFor([{ ...item(4, 0), weight: 1 }, { ...item(0, 0, { duplicateOf: "x" }), weight: 1 }], NOW);
    expect(m.level).toBe("not_enough_news");
    expect(m.value).toBeNull();
  });
});

const mood = (level: Mood["level"], value: number | null): Mood => ({
  level, value, articles: value === null ? 0 : 3, mostRecentAt: value === null ? null : NOW, estimated: true,
});

describe("portfolioMood", () => {
  it("weighted mean of known moods; spread counts levels, unknown for not_enough_news", () => {
    const p = portfolioMood([
      { mood: mood("strongly_positive", 0.8), weight: 300 },
      { mood: mood("negative", -0.4), weight: 100 },
      { mood: mood("neutral", 0), weight: 100 },
      { mood: mood("not_enough_news", null), weight: 5000 },
    ]);
    // (240 - 40 + 0) / 500 = 0.4
    expect(p.value).toBeCloseTo(0.4, 12);
    expect(p.level).toBe("positive");
    expect(p.spread).toEqual({ positive: 1, negative: 1, neutral: 1, unknown: 1 });
  });
  it("known moods that all have weight <= 0 count as unknown, consistent with not_enough_news", () => {
    const p = portfolioMood([
      { mood: mood("positive", 0.4), weight: 0 },
      { mood: mood("negative", -0.4), weight: -5 },
      { mood: mood("not_enough_news", null), weight: 10 },
    ]);
    expect(p).toEqual({ level: "not_enough_news", value: null, spread: { positive: 0, negative: 0, neutral: 0, unknown: 3 } });
  });
  it("all unknown -> not_enough_news, value null", () => {
    const p = portfolioMood([{ mood: mood("not_enough_news", null), weight: 1 }]);
    expect(p).toEqual({ level: "not_enough_news", value: null, spread: { positive: 0, negative: 0, neutral: 0, unknown: 1 } });
    expect(portfolioMood([]).level).toBe("not_enough_news");
  });
});

describe("reasonFor", () => {
  const r = (id: string, o: Partial<ArticleRating> = {}) => rating({ articleId: id, ...o });
  it("no articles -> no_clear_news (Review Focus 3)", () => {
    expect(reasonFor([], NOW)).toEqual({ kind: "no_clear_news" });
  });
  it("only irrelevant, duplicate or older-than-48h articles -> no_clear_news", () => {
    expect(reasonFor([
      { article: article("a", 1, ["ZZTEST", "ZZB", "ZZC", "ZZD", "ZZE"]), rating: r("a", { relevant: 0.3, materiality: 3 }) },
      { article: article("b", 1), rating: r("b", { materiality: 3, duplicateOf: "x" }) },
      { article: article("c", 49), rating: r("c", { materiality: 3 }) },
    ], NOW)).toEqual({ kind: "no_clear_news" });
  });
  it("candidates exist but all materiality < 2 -> nothing_explains", () => {
    expect(reasonFor([{ article: article("a", 1), rating: r("a", { materiality: 1 }) }], NOW)).toEqual({ kind: "nothing_explains" });
  });
  it("material but not credible -> nothing_explains", () => {
    expect(reasonFor([{ article: article("a", 1), rating: r("a", { materiality: 3, credible: 0.59 }) }], NOW)).toEqual({ kind: "nothing_explains" });
  });
  it("recent immaterial + older-than-48h material -> nothing_explains", () => {
    expect(reasonFor([
      { article: article("recent", 1), rating: r("recent", { materiality: 1 }) },
      { article: article("old", 49), rating: r("old", { materiality: 3 }) },
    ], NOW)).toEqual({ kind: "nothing_explains" });
  });
  it("no rated candidate but unrated articles in the 48 h window -> news_not_rated (never no_clear_news)", () => {
    expect(reasonFor([], NOW, [article("u", 3)])).toEqual({ kind: "news_not_rated" });
    expect(reasonFor([{ article: article("a", 1), rating: r("a", { relevant: 0.3 }) }], NOW, [article("u", 47)])).toEqual({ kind: "news_not_rated" });
    // unrated articles older than 48 h are not candidates
    expect(reasonFor([], NOW, [article("u", 49)])).toEqual({ kind: "no_clear_news" });
    // a rated explanation still wins, and rated-but-immaterial candidates keep their own outcome
    expect(reasonFor([{ article: article("a", 1), rating: r("a", { materiality: 3 }) }], NOW, [article("u", 1)]).kind).toBe("article");
    expect(reasonFor([{ article: article("a", 1), rating: r("a", { materiality: 1 }) }], NOW, [article("u", 1)])).toEqual({ kind: "nothing_explains" });
  });
  it("the 48 h window is inclusive", () => {
    const at48 = reasonFor([{ article: article("edge", 48), rating: r("edge", { materiality: 3 }) }], NOW);
    expect(at48.kind).toBe("article");
    expect(at48.article?.id).toBe("edge");
    const past = reasonFor([{ article: article("edge", 48.001), rating: r("edge", { materiality: 3 }) }], NOW);
    expect(past).toEqual({ kind: "no_clear_news" });
  });
  it("ties on rank break by newer, then lower article id", () => {
    // sentiment 2, materiality 2, credible 1: impact = 0.2 + 0.2 = 0.4 for all
    const base = { materiality: 2, sentiment: 2, credible: 1, relevant: 1 };
    const tied = reasonFor([
      { article: article("b", 0), rating: r("b", base) },
      { article: article("a", 0), rating: r("a", base) },
    ], NOW);
    expect(tied.article?.id).toBe("a");
    // a future-dated article clamps to age 0, ties on rank with "c", and wins as the newer one
    const clamped = reasonFor([
      { article: article("c", 0), rating: r("c", base) },
      { article: article("fut", -5), rating: r("fut", base) },
    ], NOW);
    expect(clamped.article?.id).toBe("fut");
  });
  it("picks the top-ranked qualifying article", () => {
    const pick = reasonFor([
      { article: article("low", 1), rating: r("low", { materiality: 1, sentiment: 0 }) },
      { article: article("old", 40), rating: r("old", { materiality: 3, sentiment: 0 }) },
      { article: article("new", 2), rating: r("new", { materiality: 2, sentiment: 1 }) },
    ], NOW);
    expect(pick.kind).toBe("article");
    expect(pick.article?.id).toBe("new");
    expect(pick.rating?.articleId).toBe("new");
  });
});

describe("lookThroughRatings", () => {
  it("carries raw constituent weight and via; skips weight <= 0 and constituents without ratings", () => {
    const ratings = new Map([
      ["ZZA", [{ article: article("x", 1, ["ZZA"]), rating: r1("x", "ZZA") }, { article: article("y", 2, ["ZZA"]), rating: r1("y", "ZZA") }]],
      ["ZZB", [{ article: article("z", 1, ["ZZB"]), rating: r1("z", "ZZB") }]],
      ["ZZC", [{ article: article("w", 1, ["ZZC"]), rating: r1("w", "ZZC") }]],
    ]);
    const out = lookThroughRatings("ZZETF", [
      { symbol: "ZZA", weight: 0.3 }, { symbol: "ZZB", weight: 0.1 }, { symbol: "ZZC", weight: 0 }, { symbol: "ZZD", weight: 0.2 },
    ], ratings);
    expect(out.map((o) => [o.article.id, o.weight, o.via])).toEqual([["x", 0.3, "ZZA"], ["y", 0.3, "ZZA"], ["z", 0.1, "ZZB"]]);
  });
  it("skips a constituent equal to the ETF itself", () => {
    const ratings = new Map([
      ["ZZETF", [{ article: article("self", 1, ["ZZETF"]), rating: r1("self", "ZZETF") }]],
      ["ZZA", [{ article: article("x", 1, ["ZZA"]), rating: r1("x", "ZZA") }]],
    ]);
    const out = lookThroughRatings("ZZETF", [{ symbol: "ZZETF", weight: 0.5 }, { symbol: "ZZA", weight: 0.5 }], ratings);
    expect(out.map((o) => o.via)).toEqual(["ZZA"]);
  });
  it("feeds weightedMoodFor", () => {
    const ratings = new Map([
      ["ZZA", [{ article: article("x", 0, ["ZZA"]), rating: r1("x", "ZZA", 4) }]],
      ["ZZB", [{ article: article("z", 0, ["ZZB"]), rating: r1("z", "ZZB", 0) }]],
    ]);
    const lt = lookThroughRatings("ZZETF", [{ symbol: "ZZA", weight: 0.3 }, { symbol: "ZZB", weight: 0.1 }], ratings);
    const m = weightedMoodFor(lt.map((o) => ({ rating: o.rating, publishedAt: o.article.publishedAt, weight: o.weight })), NOW);
    expect(m.value).toBeCloseTo(0.5, 12);
  });
});

describe("dedupeLookThrough", () => {
  it("splits a constituent's weight equally across its articles, then keeps one entry per article id (max weight)", () => {
    const ratings = new Map([
      ["ZZA", [
        { article: article("x", 1, ["ZZA"]), rating: r1("x", "ZZA") },
        { article: article("y", 1, ["ZZA"]), rating: r1("y", "ZZA") },
        { article: article("shared", 1, ["ZZA", "ZZB"]), rating: r1("shared", "ZZA") },
      ]],
      ["ZZB", [{ article: article("shared", 1, ["ZZA", "ZZB"]), rating: r1("shared", "ZZB") }]],
    ]);
    const out = dedupeLookThrough(lookThroughRatings("ZZETF", [{ symbol: "ZZA", weight: 0.3 }, { symbol: "ZZB", weight: 0.2 }], ratings));
    expect(out.map((o) => [o.article.id, o.via])).toEqual([["x", "ZZA"], ["y", "ZZA"], ["shared", "ZZB"]]);
    expect(out[0].weight).toBeCloseTo(0.1, 12);
    expect(out[1].weight).toBeCloseTo(0.1, 12);
    expect(out[2].weight).toBeCloseTo(0.2, 12);
    expect(out[2].rating.symbol).toBe("ZZB");
  });
  it("one article per constituent keeps the raw weight; empty input -> empty", () => {
    const ratings = new Map([["ZZA", [{ article: article("x", 1, ["ZZA"]), rating: r1("x", "ZZA") }]]]);
    expect(dedupeLookThrough(lookThroughRatings("ZZETF", [{ symbol: "ZZA", weight: 0.3 }], ratings))[0].weight).toBe(0.3);
    expect(dedupeLookThrough([])).toEqual([]);
  });
});

function r1(id: string, symbol: string, sentiment = 2): ArticleRating {
  return rating({ articleId: id, symbol, sentiment });
}
