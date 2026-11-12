import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Alert, buildAlerts, deliver, summaryFor } from "./alerts.js";
import type { Mover } from "./movers.js";
import { type ArticleRating, type CalendarEvent, MemoryNewsStore, type StoredArticle } from "./store.js";

const NOW = new Date("2026-10-21T15:00:00Z");
const H = 3_600_000;
const day = (s: string) => new Date(`${s}T00:00:00Z`);

const article = (id: string, headline: string, hoursAgo = 3, source = "Synthetic Wire"): StoredArticle => ({
  id, urlHash: `h-${id}`, url: `https://news.example.test/${id}`, headline, snippet: null, source, imageUrl: null,
  publishedAt: new Date(NOW.getTime() - hoursAgo * H), symbols: ["ZZTEST"], fetchedAt: NOW,
});
const rating = (articleId: string, o: Partial<ArticleRating> = {}): ArticleRating => ({
  articleId, symbol: "ZZTEST", model: "synthetic", ratedAt: NOW, relevant: 0.9, sentiment: 2, sentimentConfidence: 0.9,
  materiality: 2, eventType: null, eventConfidence: 0, credible: 0.8, clickbait: 0, duplicateOf: null, ...o,
});
const mover = (symbol: string, returnFraction: number, flagged = true, sessionDate = "2026-10-21"): Mover => ({
  symbol, currency: "CAD", returnFraction, dollarMove: returnFraction * 10_000, price: 100, previousClose: 100, estimated: false, flagged, limitedHistory: false, units: 100, marketValue: 10_000, sessionDate,
});
const event = (symbol: string, kind: CalendarEvent["kind"], date: string, status: CalendarEvent["status"] = "expected"): CalendarEvent => ({
  id: `${kind}:${symbol}:${date}`, symbol, kind, date: day(date), status, source: "edgar", amountPerUnit: kind === "dividend_pay" ? 0.25 : null, currency: kind === "dividend_pay" ? "CAD" : null,
});
const build = (o: Partial<Parameters<typeof buildAlerts>[0]>) => buildAlerts({ movers: [], ratings: new Map(), events: [], now: NOW, ...o });
const ADVICE = /\b(buy|sell|hold|reduce|add|overweight|underweight|target|target price|should|consider)\b/i;
const AI = " AI-rated; may be wrong.";

describe("buildAlerts: unusual moves", () => {
  it("keys and words the alert by the session the move ends on: \"today\" only for today's session", () => {
    // 08:00 Tuesday Toronto: the move is Monday's session
    const tuesday = new Date("2026-10-20T12:00:00Z");
    const [a] = buildAlerts({ movers: [mover("ZZTEST", -0.031, true, "2026-10-19")], ratings: new Map(), events: [], now: tuesday });
    expect(a).toMatchObject({ id: "unusual_move:ZZTEST:2026-10-19", summary: "ZZTEST fell 3.1% on Oct 19, more than its usual move." });
    const [live] = buildAlerts({ movers: [mover("ZZTEST", 0.031, true, "2026-10-20")], ratings: new Map(), events: [], now: tuesday });
    expect(live).toMatchObject({ id: "unusual_move:ZZTEST:2026-10-20", summary: "ZZTEST rose 3.1% today, more than its usual move." });
  });

  it("a Saturday call and a missed nightly run re-use the session id, so a delivered move stays quiet", async () => {
    const store = new MemoryNewsStore();
    const friday = mover("ZZTEST", 0.05, true, "2026-10-23");
    const fri = buildAlerts({ movers: [friday], ratings: new Map(), events: [], now: new Date("2026-10-23T21:00:00Z") });
    expect((await deliver({ store, appUserId: "u", clientKey: "k", alerts: fri, now: NOW })).alerts).toHaveLength(1);
    const sat = buildAlerts({ movers: [friday], ratings: new Map(), events: [], now: new Date("2026-10-24T14:00:00Z") });
    expect(sat[0]!.summary).toBe("ZZTEST rose 5.0% on Oct 23, more than its usual move.");
    expect(await deliver({ store, appUserId: "u", clientKey: "k", alerts: sat, now: NOW })).toEqual({ alerts: [], quiet: true });
    // the nightly run missed Monday: Tuesday 08:00 still sees Friday's session, same id, still quiet
    const tue = buildAlerts({ movers: [friday], ratings: new Map(), events: [], now: new Date("2026-10-27T12:00:00Z") });
    expect(tue[0]!.id).toBe("unusual_move:ZZTEST:2026-10-23");
    expect((await deliver({ store, appUserId: "u", clientKey: "k", alerts: tue, now: NOW })).quiet).toBe(true);
  });

  it("one alert per flagged mover; materiality 3 at |return| >= 6%, else 2; Toronto-date id", () => {
    const a = build({ movers: [mover("ZZTEST", -0.061), mover("ZZTESTB", 0.031), mover("ZZTESTC", 0.2, false), mover("ZZTESTD", 0.06)] });
    expect(a.map((x) => [x.id, x.kind, x.materiality, x.mood])).toEqual([
      ["unusual_move:ZZTEST:2026-10-21", "unusual_move", 3, null],
      ["unusual_move:ZZTESTB:2026-10-21", "unusual_move", 2, null],
      ["unusual_move:ZZTESTD:2026-10-21", "unusual_move", 3, null],
    ]);
    expect(a[0]).toMatchObject({ headline: null, source: null, url: null, publishedAt: null, summary: "ZZTEST fell 6.1% today, more than its usual move." });
    expect(a[1].summary).toBe("ZZTESTB rose 3.1% today, more than its usual move.");
    // 02:00Z on the 22nd is still the 21st in Toronto: today's session is still "today"
    expect(buildAlerts({ movers: [mover("ZZTEST", 0.02)], ratings: new Map(), events: [], now: new Date("2026-10-22T02:00:00Z") })[0].summary).toBe("ZZTEST rose 2.0% today, more than its usual move.");
  });
});

describe("buildAlerts: news", () => {
  it("material, credible, relevant, non-duplicate articles; materiality and mood from the rating", () => {
    const keep = { article: article("art-1", "ZZTEST cuts outlook"), rating: rating("art-1", { materiality: 3, sentiment: 0.5 }) };
    const ratings = new Map([["ZZTEST", [
      keep,
      { article: article("art-2", "minor"), rating: rating("art-2", { materiality: 1 }) },
      { article: article("art-3", "rumour"), rating: rating("art-3", { credible: 0.5 }) },
      { article: article("art-4", "off-topic"), rating: rating("art-4", { relevant: 0.5 }) },
      { article: article("art-5", "copy"), rating: rating("art-5", { duplicateOf: "art-1" }) },
    ]]]);
    const a = build({ ratings });
    expect(a).toHaveLength(1);
    expect(a[0]).toEqual({
      id: "news:art-1", symbol: "ZZTEST", kind: "news", materiality: 3, mood: "strongly_negative",
      headline: "ZZTEST cuts outlook", source: "Synthetic Wire", url: "https://news.example.test/art-1",
      publishedAt: keep.article.publishedAt.toISOString(),
      summary: `ZZTEST: ZZTEST cuts outlook (Synthetic Wire, 3 h ago), rated strongly negative, high materiality.${AI}`,
    });
  });

  it("thresholds are inclusive (materiality 2, credible 0.6, relevant 0.6)", () => {
    const ratings = new Map([["ZZTEST", [{ article: article("art-1", "edge", 50), rating: rating("art-1", { materiality: 2, credible: 0.6, relevant: 0.6, sentiment: 3 }) }]]]);
    const [a] = build({ ratings });
    expect(a.summary).toBe(`ZZTEST: edge (Synthetic Wire, 2 d ago), rated positive, meaningful materiality.${AI}`);
  });

  it("one news alert per article even when tagged to several symbols", () => {
    const art = { ...article("art-1", "joint"), symbols: ["ZZTEST", "ZZTESTB"] };
    const ratings = new Map([
      ["ZZTEST", [{ article: art, rating: rating("art-1", { materiality: 2 }) }, { article: art, rating: rating("art-1") }]],
      ["ZZTESTB", [{ article: art, rating: rating("art-1", { symbol: "ZZTESTB", materiality: 3 }) }]],
    ]);
    const a = build({ ratings });
    expect(a.map((x) => [x.id, x.symbol])).toEqual([["news:art-1", "ZZTESTB"]]);
  });

  it("news ids are symbol-independent: a re-rating that moves the winning symbol does not re-alert", async () => {
    const art = { ...article("art-1", "joint"), symbols: ["ZZTEST", "ZZTESTB"] };
    const run = (aMat: number, bMat: number) => build({ ratings: new Map([
      ["ZZTEST", [{ article: art, rating: rating("art-1", { materiality: aMat }) }]],
      ["ZZTESTB", [{ article: art, rating: rating("art-1", { symbol: "ZZTESTB", materiality: bMat }) }]],
    ]) });
    const store = new MemoryNewsStore();
    const first = await deliver({ store, appUserId: "u", clientKey: "k", alerts: run(3, 2), now: NOW });
    expect(first.alerts.map((x) => [x.id, x.symbol])).toEqual([["news:art-1", "ZZTEST"]]);
    expect(run(2, 3)[0].symbol).toBe("ZZTESTB");
    expect(await deliver({ store, appUserId: "u", clientKey: "k", alerts: run(2, 3), now: NOW })).toEqual({ alerts: [], quiet: true });
  });
});

describe("buildAlerts: calendar", () => {
  it("earnings within 3 days -> earnings_upcoming (materiality 2); est. wording only when expected", () => {
    const a = build({ events: [event("ZZTEST", "earnings", "2026-10-23"), event("ZZTESTB", "earnings", "2026-10-24", "confirmed"), event("ZZTESTC", "earnings", "2026-10-25")] });
    expect(a.map((x) => [x.id, x.materiality, x.mood, x.summary])).toEqual([
      ["earnings_upcoming:ZZTEST:2026-10-23", 2, null, "ZZTEST is expected to report earnings on Oct 23 (estimated)."],
      ["earnings_upcoming:ZZTESTB:2026-10-24", 2, null, "ZZTESTB is expected to report earnings on Oct 24."],
    ]);
  });

  it("earnings in the last 2 days -> earnings_reported (materiality 3) with the top-ranked earnings article", () => {
    const ratings = new Map([["ZZTEST", [
      { article: article("art-1", "ZZTEST beats estimates", 5), rating: rating("art-1", { eventType: "earnings", sentiment: 3, materiality: 3 }) },
      { article: article("art-2", "ZZTEST results in line", 20), rating: rating("art-2", { eventType: "earnings", sentiment: 2, materiality: 1 }) },
      { article: article("art-3", "ZZTEST unrelated", 1), rating: rating("art-3", { eventType: "product", materiality: 3, sentiment: 4 }) },
    ]]]);
    const a = build({ ratings, events: [
      event("ZZTEST", "earnings", "2026-10-20"), // expected, but an earnings article exists
      event("ZZTESTB", "earnings", "2026-10-21"), // day 0, expected, no article: upcoming "today", not reported
      event("ZZTESTC", "earnings", "2026-10-18", "confirmed"), // 3 days ago: outside
      event("ZZTESTD", "earnings", "2026-10-19", "confirmed"), // confirmed date, but no article: not evidence of a report
    ] });
    const reported = a.filter((x) => x.kind === "earnings_reported");
    expect(reported.map((x) => x.id)).toEqual(["earnings_reported:ZZTEST:2026-10-20"]);
    expect(a.filter((x) => x.symbol === "ZZTESTD")).toEqual([]);
    expect(a.filter((x) => x.symbol === "ZZTESTB").map((x) => [x.id, x.materiality, x.summary])).toEqual([
      ["earnings_upcoming:ZZTESTB:2026-10-21", 2, "ZZTESTB is expected to report earnings today (estimated)."],
    ]);
    expect(reported[0]).toMatchObject({ materiality: 3, mood: "positive", headline: "ZZTEST beats estimates", source: "Synthetic Wire", url: "https://news.example.test/art-1" });
    expect(reported[0].summary).toBe(`ZZTEST reported earnings; top-rated news: ZZTEST beats estimates (Synthetic Wire), rated positive.${AI}`);
  });

  it("an earnings article older than the day before the event does not qualify (days -1/-2)", () => {
    const ratings = new Map([["ZZTEST", [{ article: article("art-1", "last quarter", 72), rating: rating("art-1", { eventType: "earnings" }) }]]]);
    expect(build({ ratings, events: [event("ZZTEST", "earnings", "2026-10-20")] }).filter((x) => x.kind !== "news")).toEqual([]);
    // published 2026-10-19 11:00 Toronto = event day - 1: qualifies for a 10-20 event
    const prior = new Map([["ZZTEST", [{ article: article("art-1", "ZZTEST results", 52), rating: rating("art-1", { eventType: "earnings" }) }]]]);
    expect(build({ ratings: prior, events: [event("ZZTEST", "earnings", "2026-10-20")] }).filter((x) => x.kind !== "news").map((x) => x.id)).toEqual(["earnings_reported:ZZTEST:2026-10-20"]);
  });

  it("day 0: reported only with an earnings article published on the event day (Toronto); else upcoming today", () => {
    // NOW is 11:00 Toronto on 2026-10-21. 12 h ago = 23:00 Toronto on 10-20 (a preview); 2 h ago = 09:00 on 10-21.
    const preview = { article: article("art-p", "ZZTEST to report tomorrow", 12), rating: rating("art-p", { eventType: "earnings" }) };
    const sameDay = { article: article("art-s", "ZZTEST posts results", 2), rating: rating("art-s", { eventType: "earnings", sentiment: 3 }) };
    const confirmed = event("ZZTEST", "earnings", "2026-10-21", "confirmed");
    const pre = build({ ratings: new Map([["ZZTEST", [preview]]]), events: [confirmed] }).filter((x) => x.kind !== "news");
    expect(pre.map((x) => [x.id, x.materiality, x.summary])).toEqual([
      ["earnings_upcoming:ZZTEST:2026-10-21", 2, "ZZTEST is expected to report earnings today."],
    ]);
    const post = build({ ratings: new Map([["ZZTEST", [preview, sameDay]]]), events: [confirmed] }).filter((x) => x.kind !== "news");
    expect(post.map((x) => [x.id, x.headline])).toEqual([["earnings_reported:ZZTEST:2026-10-21", "ZZTEST posts results"]]);
  });

  it("windows compare whole Toronto days (23:00 Toronto = 03:00Z next day)", () => {
    const late = new Date("2026-10-22T03:00:00Z"); // still 2026-10-21 in Toronto
    const a = buildAlerts({ movers: [], ratings: new Map(), now: late, events: [
      event("ZZE1", "earnings", "2026-10-22"), // +1 -> upcoming
      event("ZZE3", "earnings", "2026-10-24"), // +3 -> upcoming
      event("ZZE4", "earnings", "2026-10-25"), // +4 -> none
      event("ZZE0", "earnings", "2026-10-21", "confirmed"), // 0, no article -> upcoming today
      event("ZZEX", "earnings", "2026-10-21"), // 0, expected, no article -> upcoming today (estimated)
      event("ZZEM1", "earnings", "2026-10-20", "confirmed"), // -1, no article -> none (a date is not a report)
      event("ZZEM2", "earnings", "2026-10-19", "confirmed"), // -2, no article -> none
      event("ZZEM3", "earnings", "2026-10-18", "confirmed"), // -3 -> none
      event("ZZD0", "dividend_pay", "2026-10-21"), // 0 -> upcoming
      event("ZZD2", "dividend_pay", "2026-10-23"), // +2 -> upcoming
      event("ZZD3", "dividend_pay", "2026-10-24"), // +3 -> none
      event("ZZDM1", "dividend_pay", "2026-10-20"), // -1 -> none
    ] });
    expect(a.map((x) => x.id)).toEqual([
      "earnings_upcoming:ZZE1:2026-10-22", "earnings_upcoming:ZZE3:2026-10-24",
      "earnings_upcoming:ZZE0:2026-10-21", "earnings_upcoming:ZZEX:2026-10-21",
      "dividend_upcoming:ZZD0:2026-10-21", "dividend_upcoming:ZZD2:2026-10-23",
    ]);
    expect(a.find((x) => x.symbol === "ZZE0")!.summary).toBe("ZZE0 is expected to report earnings today.");
    expect(a.find((x) => x.symbol === "ZZEX")!.summary).toBe("ZZEX is expected to report earnings today (estimated).");
  });

  it("projected pay date within 2 days -> dividend_upcoming (materiality 1)", () => {
    const a = build({ events: [event("ZZTEST", "dividend_pay", "2026-10-23"), event("ZZTESTB", "dividend_pay", "2026-10-24")] });
    expect(a.map((x) => [x.id, x.materiality, x.summary])).toEqual([
      ["dividend_upcoming:ZZTEST:2026-10-23", 1, "ZZTEST dividend pay date expected Oct 23 (estimated)."],
    ]);
  });
});

describe("buildAlerts: determinism and copy", () => {
  it("same inputs give the same ids; no summary of any kind contains advice language", () => {
    const ratings = new Map([["ZZTEST", [
      { article: article("art-1", "ZZTEST news"), rating: rating("art-1", { materiality: 3 }) },
      { article: article("art-2", "ZZTEST quarter"), rating: rating("art-2", { eventType: "earnings", materiality: 1 }) },
    ]]]);
    const input = { movers: [mover("ZZTEST", 0.07), mover("ZZTESTB", -0.02)], ratings, now: NOW, events: [
      event("ZZTEST", "earnings", "2026-10-22"), event("ZZTEST", "dividend_pay", "2026-10-22"),
      event("ZZTEST", "earnings", "2026-10-20"), event("ZZTESTB", "earnings", "2026-10-20", "confirmed"),
      event("ZZTESTC", "earnings", "2026-10-23", "confirmed"),
    ] };
    const a = buildAlerts(input);
    expect(a.map((x) => x.id)).toEqual(buildAlerts(input).map((x) => x.id));
    expect(new Set(a.map((x) => x.kind)).size).toBe(5);
    expect(a.filter((x) => x.kind === "earnings_reported").map((x) => x.headline)).toEqual(["ZZTEST quarter"]);
    for (const x of a) expect(x.summary).not.toMatch(ADVICE);
  });

  it("summaryFor fills templates from values", () => {
    const base: Omit<Alert, "summary"> = { id: "x", symbol: "ZZTEST", kind: "news", materiality: 0, mood: "neutral", headline: "H", source: "S", url: null, publishedAt: new Date(NOW.getTime() - 0.5 * H).toISOString() };
    const fixtures = [
      [summaryFor(base, { now: NOW }), `ZZTEST: H (S, under 1 h ago), rated neutral, minimal materiality.${AI}`],
      [summaryFor({ ...base, materiality: 1, publishedAt: new Date(NOW.getTime() - 47 * H).toISOString() }, { now: NOW }), `ZZTEST: H (S, 47 h ago), rated neutral, low materiality.${AI}`],
      [summaryFor({ ...base, kind: "unusual_move", mood: null }, { returnFraction: 0.0249 }), "ZZTEST rose 2.5% today, more than its usual move."],
      [summaryFor({ ...base, kind: "earnings_reported", mood: "negative" }, {}), `ZZTEST reported earnings; top-rated news: H (S), rated negative.${AI}`],
      [summaryFor({ ...base, kind: "earnings_upcoming", mood: null }, { date: day("2026-11-05"), estimated: true }), "ZZTEST is expected to report earnings on Nov 5 (estimated)."],
      [summaryFor({ ...base, kind: "earnings_upcoming", mood: null }, { date: day("2026-10-21"), estimated: false, today: true }), "ZZTEST is expected to report earnings today."],
      [summaryFor({ ...base, kind: "dividend_upcoming", mood: null }, { date: day("2026-11-05") }), "ZZTEST dividend pay date expected Nov 5 (estimated)."],
    ];
    for (const [got, want] of fixtures) {
      expect(got).toBe(want);
      expect(got).not.toMatch(ADVICE);
    }
  });
});

describe("deliver", () => {
  const alert = (id: string, materiality: number, publishedAt: string | null = null): Alert => ({
    id, symbol: "ZZTEST", kind: "news", materiality, mood: null, headline: null, source: null, url: null, publishedAt, summary: id,
  });

  it("two client keys each get every alert once; a third call is quiet (Review Focus 5)", async () => {
    const store = new MemoryNewsStore();
    const alerts = [alert("a", 2), alert("b", 3)];
    const claude = await deliver({ store, appUserId: "user-1", clientKey: "client-claude", alerts, now: NOW });
    const chatgpt = await deliver({ store, appUserId: "user-1", clientKey: "client-chatgpt", alerts, now: NOW });
    expect(claude).toEqual({ alerts: [alerts[1], alerts[0]], quiet: false });
    expect(chatgpt.alerts.map((x) => x.id)).toEqual(["b", "a"]);
    expect(await deliver({ store, appUserId: "user-1", clientKey: "client-claude", alerts, now: NOW })).toEqual({ alerts: [], quiet: true });
    expect(await deliver({ store, appUserId: "user-1", clientKey: "client-chatgpt", alerts, now: NOW })).toEqual({ alerts: [], quiet: true });
    // another user is independent
    expect((await deliver({ store, appUserId: "user-2", clientKey: "client-claude", alerts, now: NOW })).alerts).toHaveLength(2);
  });

  it("caps at 10 by materiality desc then publishedAt desc; the rest arrive next call", async () => {
    const store = new MemoryNewsStore();
    const alerts = Array.from({ length: 12 }, (_, i) => alert(`n${i}`, i % 4, new Date(NOW.getTime() - i * H).toISOString()));
    alerts.push(alert("m-null", 3, null));
    const first = await deliver({ store, appUserId: "u", clientKey: "k", alerts, now: NOW });
    expect(first.alerts.map((x) => x.id)).toEqual(["n3", "n7", "n11", "m-null", "n2", "n6", "n10", "n1", "n5", "n9"]);
    const second = await deliver({ store, appUserId: "u", clientKey: "k", alerts, now: NOW });
    expect(second.alerts.map((x) => x.id)).toEqual(["n0", "n4", "n8"]);
    expect((await deliver({ store, appUserId: "u", clientKey: "k", alerts, now: NOW, cap: 1 })).quiet).toBe(true);
    const capped = await deliver({ store: new MemoryNewsStore(), appUserId: "u", clientKey: "k", alerts, now: NOW, cap: 2 });
    expect(capped.alerts.map((x) => x.id)).toEqual(["n3", "n7"]);
  });

  it("dedupes repeated ids and hashes client keys longer than 512 characters", async () => {
    const store = new MemoryNewsStore();
    const long = "c".repeat(600);
    const out = await deliver({ store, appUserId: "u", clientKey: long, alerts: [alert("a", 1), alert("a", 1)], now: NOW });
    expect(out.alerts).toHaveLength(1);
    const hashed = createHash("sha256").update(long).digest("hex");
    expect(await store.deliveredAlertIds("u", hashed, new Date(0))).toEqual(new Set(["a"]));
    expect(await store.deliveredAlertIds("u", long, new Date(0))).toEqual(new Set());
    const exact = "d".repeat(512);
    await deliver({ store, appUserId: "u", clientKey: exact, alerts: [alert("a", 1)], now: NOW });
    expect(await store.deliveredAlertIds("u", exact, new Date(0))).toEqual(new Set(["a"]));
  });

  it("records before returning: two concurrent calls from one client deliver the union exactly once", async () => {
    const store = new MemoryNewsStore();
    const alerts = [alert("a", 2), alert("b", 3), alert("c", 1)];
    const [x, y] = await Promise.all([
      deliver({ store, appUserId: "u", clientKey: "k", alerts, now: NOW }),
      deliver({ store, appUserId: "u", clientKey: "k", alerts, now: NOW }),
    ]);
    const ids = [...x.alerts, ...y.alerts].map((a) => a.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
    expect([x.quiet, y.quiet].filter(Boolean)).toHaveLength(1);
    expect(await deliver({ store, appUserId: "u", clientKey: "k", alerts, now: NOW })).toEqual({ alerts: [], quiet: true });
  });

  it("an empty alert list is quiet and records nothing", async () => {
    const store = new MemoryNewsStore();
    expect(await deliver({ store, appUserId: "u", clientKey: "k", alerts: [], now: NOW })).toEqual({ alerts: [], quiet: true });
  });
});
