import { describe, expect, it, vi } from "vitest";

import { MemoryNewsStore, type ArticleRating, type CalendarEvent, type StoredArticle } from "../news/store.js";
import { DEFAULT_SETTINGS } from "../settings/settings-service.js";
import {
  buildCalendarPayload, CALENDAR_WIDGET_URI, calendarInput, calendarModelCopy, CalendarScopeError, calendarText, calendarToolDefinitions, type CalendarDeps,
} from "./calendar-tools.js";

// Wednesday 12:00 Toronto; this week starts Monday 2026-10-19.
const NOW = new Date("2026-10-21T16:00:00.000Z");
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const cls = (bucket: string, group: string, included: boolean, label: string): any => ({ label, bucket, group, includedInPortfolioTotal: included, isClosed: group === "closed" });
const pos = (symbol: string, over: Record<string, unknown> = {}): any => ({
  instrumentId: `i-${symbol}`, kind: "stock", symbol, description: `${symbol} Synthetic Corp`, units: 100, price: 50, costBasis: 40, marketValue: 5000, unrealizedGain: null, currency: "CAD", cashEquivalent: false, ...over,
});
const portfolio = (): any => ({
  generatedAt: "2026-10-21T15:55:00.000Z",
  accounts: [
    { id: "TFSA", classification: cls("tfsa", "registered", true, "TFSA"), value: null, balances: [], positions: [pos("ZZTEST"), pos("ZZDIV", { units: 150 })] },
    { id: "RRSP", classification: cls("rrsp", "registered", true, "RRSP"), value: null, balances: [], positions: [pos("ZZDIV", { units: 50 }), pos("ZZUSD", { currency: "USD", units: 10 })] },
    { id: "CARD", classification: cls("credit_card", "credit_products", false, "Credit card"), value: null, balances: [], positions: [] },
  ],
});

const ev = (kind: CalendarEvent["kind"], symbol: string, date: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: `${kind}:${symbol}:${date}`, symbol, kind, date: day(date), status: "expected", source: kind === "earnings" ? "edgar" : "projection",
  amountPerUnit: kind === "dividend_pay" ? 0.25 : null, currency: kind === "dividend_pay" ? "CAD" : null, ...over,
});
const rating = (articleId: string, symbol: string, over: Partial<ArticleRating> = {}): ArticleRating => ({
  articleId, symbol, model: "jev-test", ratedAt: NOW, relevant: 0.9, sentiment: 3, sentimentConfidence: 0.8, materiality: 2,
  eventType: "earnings", eventConfidence: 0.8, credible: 0.9, clickbait: 0.1, duplicateOf: null, ...over,
});
let n = 0;
const article = (symbol: string, publishedAt: string, over: Partial<Omit<StoredArticle, "id">> = {}): Omit<StoredArticle, "id"> => {
  n += 1;
  return { urlHash: String(n).padStart(64, "0"), url: `https://news.example.invalid/c/${n}`, headline: `Invented ${symbol} headline ${n}`, snippet: null,
    source: "synthetic.example", imageUrl: null, publishedAt: new Date(publishedAt), symbols: [symbol], fetchedAt: NOW, ...over };
};

async function seed() {
  const store = new MemoryNewsStore();
  await store.putEvents([
    ev("earnings", "ZZTEST", "2026-10-16", { status: "confirmed", source: "article" }),
    ev("earnings", "ZZTEST", "2026-10-10"), // more than 7 days back
    ev("earnings", "ZZUSD", "2026-10-23"),
    // A legacy shared dividend row: never shown (dividends are projected per user at read time).
    ev("dividend_pay", "ZZDIV", "2026-10-29", { amountPerUnit: 9 }),
    ev("earnings", "ZZNOTHELD", "2026-10-25"),
  ]);
  const [old, report, minor, dup] = await store.upsertArticles([
    article("ZZTEST", "2026-10-13T12:00:00Z", { headline: "ZZTEST invented preview" }),
    article("ZZTEST", "2026-10-16T21:00:00Z", { headline: "ZZTEST invented quarter beats", source: "wire.example" }),
    article("ZZTEST", "2026-10-17T12:00:00Z", { headline: "ZZTEST invented minor note" }),
    article("ZZTEST", "2026-10-16T22:00:00Z", { headline: "ZZTEST invented copy" }),
  ]);
  await store.putRatings([
    rating(old!.id, "ZZTEST", { sentiment: 0, materiality: 3 }),
    rating(report!.id, "ZZTEST", { sentiment: 3, materiality: 3 }),
    rating(minor!.id, "ZZTEST", { sentiment: 1, materiality: 0, eventType: "other" }),
    rating(dup!.id, "ZZTEST", { sentiment: 4, materiality: 3, duplicateOf: report!.id }),
  ]);
  return store;
}
/** The requesting user's own past ZZDIV payments (quarterly): the next pay date projects to 2026-10-30. */
const divPay = (iso: string, perUnit = 0.25, currency = "CAD") => ({ symbol: "ZZDIV", date: day(iso), perUnit, currency });
const PAYMENTS = [divPay("2026-04-30"), divPay("2026-07-30")];
const deps = (store: MemoryNewsStore, dividends: CalendarDeps["dividends"] = vi.fn(async () => PAYMENTS)): CalendarDeps =>
  ({ store, settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })) }, dividends, now: () => NOW });

describe("buildCalendarPayload", () => {
  it("returns the documented shape: weeks from 7 days back to the range end, held symbols only", async () => {
    const p = await buildCalendarPayload(deps(await seed()), portfolio(), "sub", {});
    expect(Object.keys(p).sort()).toEqual(["accounts", "asOf", "filters", "home", "range", "settings", "thisWeek", "weeks"]);
    expect(p.range).toBe("1m");
    expect(p.asOf).toBe("2026-10-21T15:55:00.000Z");
    expect(p.filters).toEqual({ range: "1m" });
    expect(p.accounts).toEqual([{ id: "TFSA", label: "TFSA" }, { id: "RRSP", label: "RRSP" }]);
    expect(p.settings).toEqual(DEFAULT_SETTINGS);
    expect(p.weeks.map((w) => [w.weekStart, w.events.map((e) => e.id)])).toEqual([
      ["2026-10-12", ["earnings:ZZTEST:2026-10-16"]],
      ["2026-10-19", ["earnings:ZZUSD:2026-10-23"]],
      ["2026-10-26", ["dividend_pay:ZZDIV:2026-10-30"]],
    ]);
    expect(p.thisWeek).toEqual({ earnings: 1, dividends: 0 });
  });

  it("marks projections est., totals dividends as per unit × current units in the event currency", async () => {
    const p = await buildCalendarPayload(deps(await seed()), portfolio(), "sub", {});
    const events = p.weeks.flatMap((w) => w.events);
    expect(Object.keys(events[0]!).sort()).toEqual(["amount", "date", "estimated", "id", "kind", "outcome", "status", "symbol"]);
    const div = events.find((e) => e.kind === "dividend_pay")!;
    expect(div).toMatchObject({ symbol: "ZZDIV", date: "2026-10-30", status: "expected", estimated: true, amount: { perUnit: 0.25, units: 200, total: 50, currency: "CAD" } });
    expect(events.find((e) => e.symbol === "ZZUSD")).toMatchObject({ estimated: true, amount: null, outcome: null });
    expect(events.find((e) => e.symbol === "ZZTEST")).toMatchObject({ status: "confirmed", estimated: false });
  });

  it("a past earnings date shows the top earnings article since the day before, with its mood (duplicates and other types skipped)", async () => {
    const p = await buildCalendarPayload(deps(await seed()), portfolio(), "sub", {});
    const past = p.weeks[0]!.events[0]!;
    expect(past.outcome).toEqual({ headline: "ZZTEST invented quarter beats", source: "wire.example", mood: "positive" });
  });

  it("scopes to one account (its units) and extends to 3m; unknown accounts are a scope error", async () => {
    const one = await buildCalendarPayload(deps(await seed()), portfolio(), "sub", { accountId: "RRSP", range: "3m" });
    const events = one.weeks.flatMap((w) => w.events);
    expect(events.map((e) => e.id)).toEqual(["earnings:ZZUSD:2026-10-23", "dividend_pay:ZZDIV:2026-10-30"]);
    expect(events[1]!.amount).toMatchObject({ perUnit: 0.25, units: 50, total: 12.5, currency: "CAD" });
    expect(one.filters).toEqual({ range: "3m", accountId: "RRSP" });
    const two = await buildCalendarPayload(deps(await seed()), portfolio(), "sub", { range: "2w" });
    expect(two.weeks.flatMap((w) => w.events).map((e) => e.symbol)).toEqual(["ZZTEST", "ZZUSD", "ZZDIV"]);
    await expect(buildCalendarPayload(deps(await seed()), portfolio(), "sub", { accountId: "CARD" })).rejects.toBeInstanceOf(CalendarScopeError);
  });

  it("projects dividends per user from that user's own payments, for the accounts in scope (I2)", async () => {
    const store = await seed();
    const byUser: Record<string, ReturnType<typeof divPay>[]> = {
      alice: PAYMENTS,
      bob: [divPay("2026-05-10", 0.3), divPay("2026-08-10", 0.3)],
      carol: [],
    };
    const dividends = vi.fn(async (sub: string) => byUser[sub] ?? []);
    const view = async (sub: string) => (await buildCalendarPayload(deps(store, dividends), portfolio(), sub, {})).weeks.flatMap((w) => w.events).filter((e) => e.kind === "dividend_pay");
    expect((await view("alice")).map((e) => [e.id, e.amount?.perUnit])).toEqual([["dividend_pay:ZZDIV:2026-10-30", 0.25]]);
    expect((await view("bob")).map((e) => [e.id, e.amount?.perUnit])).toEqual([["dividend_pay:ZZDIV:2026-11-10", 0.3]]);
    expect(await view("carol")).toEqual([]);
    await buildCalendarPayload(deps(store, dividends), portfolio(), "alice", { accountId: "RRSP" });
    expect(dividends).toHaveBeenLastCalledWith("alice", [expect.objectContaining({ id: "RRSP" })]);
  });

  it("a symbol paid in two currencies gets one projection, in the latest payment's currency; a failed read shows none", async () => {
    const mixed = vi.fn(async () => [divPay("2026-04-30", 0.2, "USD"), divPay("2026-05-30", 0.2, "USD"), divPay("2026-04-30"), divPay("2026-07-30")]);
    const events = (await buildCalendarPayload(deps(await seed(), mixed), portfolio(), "sub", {})).weeks.flatMap((w) => w.events).filter((e) => e.kind === "dividend_pay");
    expect(events.map((e) => [e.id, e.amount?.currency])).toEqual([["dividend_pay:ZZDIV:2026-10-30", "CAD"]]);
    const failing = vi.fn(async () => { throw new Error("synthetic"); });
    const p = await buildCalendarPayload(deps(await seed(), failing), portfolio(), "sub", {});
    expect(p.weeks.flatMap((w) => w.events).some((e) => e.kind === "dividend_pay")).toBe(false);
  });

  it("is empty without stored events and stays under 60 KB", async () => {
    const p = await buildCalendarPayload(deps(new MemoryNewsStore(), vi.fn(async () => [])), portfolio(), "sub", {});
    expect(p.weeks).toEqual([]);
    expect(p.thisWeek).toEqual({ earnings: 0, dividends: 0 });
    expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(60_000);
  });
});

describe("calendar text and model copy", () => {
  it("text lists the next five dated events with est., never amounts", async () => {
    const store = await seed();
    await store.putEvents(["2026-10-22", "2026-10-24", "2026-10-26", "2026-10-28"].map((d, i) => ev("earnings", ["ZZTEST", "ZZDIV", "ZZUSD", "ZZTEST"][i]!, d)));
    const p = await buildCalendarPayload(deps(store), portfolio(), "sub", {});
    const text = calendarText(p, { show: true, now: NOW });
    expect(text).toContain("Next: ZZTEST earnings Oct 22 (est.); ZZUSD earnings Oct 23 (est.); ZZDIV earnings Oct 24 (est.); ZZUSD earnings Oct 26 (est.); ZZTEST earnings Oct 28 (est.).");
    expect(text).not.toContain("Oct 30");
    expect(text).not.toMatch(/\$|0\.25|12\.5|\b50\b/);
    expect(text).toContain("Showing the calendar widget.");
    expect(calendarText(p)).not.toContain("Showing");
    const empty = await buildCalendarPayload(deps(new MemoryNewsStore(), vi.fn(async () => [])), portfolio(), "sub", {});
    expect(calendarText(empty)).toContain("No earnings or dividend dates");
  });

  it("model copy carries at most 20 events, per-unit amounts only, and the notes", async () => {
    const store = await seed();
    await store.putEvents(Array.from({ length: 25 }, (_, i) => ev("earnings", "ZZDIV", `2026-11-${String(i + 1).padStart(2, "0")}`)));
    const copy = calendarModelCopy(await buildCalendarPayload(deps(store), portfolio(), "sub", {}));
    expect(copy.events).toHaveLength(20);
    expect(copy.hasMore).toBe(true);
    expect(JSON.stringify(copy)).not.toContain('"total"');
    expect(copy.events.find((e) => e.kind === "dividend_pay")).toMatchObject({ perUnit: 0.25, currency: "CAD", estimated: true });
    expect(copy.notes.estimates).toContain("est.");
  });
});

describe("calendar tool definitions", () => {
  it("show_calendar is model-visible with the widget; get_calendar is app-only; both read-only with a strict schema", async () => {
    const [show, get] = calendarToolDefinitions;
    expect(show.name).toBe("show_calendar");
    expect(show.description).toBe("Use this when the user asks about upcoming earnings dates, dividend payments, or what's coming up for their holdings: renders the interactive calendar. Read-only; dates may be estimated. Informational, not advice.");
    expect(get.description).toBe("Used by the calendar widget to change the range or account of the earnings and dividend calendar. Read-only; dates may be estimated. Informational, not advice.");
    expect(show._meta).toMatchObject({ ui: { resourceUri: CALENDAR_WIDGET_URI }, "openai/outputTemplate": CALENDAR_WIDGET_URI });
    expect(get.name).toBe("get_calendar");
    expect(get._meta).toMatchObject({ ui: { visibility: ["app"] } });
    for (const t of calendarToolDefinitions) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.securitySchemes).toEqual([{ type: "oauth2", scopes: ["portfolio:read"] }]);
      expect(t.outputSchema.additionalProperties).toBe(false);
    }
    const p = await buildCalendarPayload(deps(await seed()), portfolio(), "sub", {});
    expect(Object.keys(p).sort()).toEqual([...show.outputSchema.required, "home"].sort());
    expect(Object.keys(show.outputSchema.properties).sort()).toEqual([...show.outputSchema.required, "home"].sort());
    expect(() => calendarInput.parse({ range: "1y" })).toThrow();
    expect(() => calendarInput.parse({ extra: 1 })).toThrow();
    expect(calendarInput.parse({ range: "2w", accountId: "TFSA" })).toEqual({ range: "2w", accountId: "TFSA" });
  });
});

describe("buildCalendarPayload in CAD", () => {
  const usd = (iso: string) => ({ symbol: "ZZUSD", date: day(iso), perUnit: 0.5, currency: "USD" });
  const payments = [...PAYMENTS, usd("2026-04-30"), usd("2026-07-30")];
  const market = (series: Array<{ date: string; close: number }> | null = [{ date: "2026-10-20", close: 1.4 }]) => ({ usdCad: vi.fn(async () => series) });
  const withMarket = (store: MemoryNewsStore, m: any, over: Partial<CalendarDeps> = {}): CalendarDeps => ({ ...deps(store, vi.fn(async () => payments)), market: m, ...over } as CalendarDeps);

  it("projected dividend totals are CAD est. at the latest rate, with the native per-unit amount kept", async () => {
    const m = market();
    const p = await buildCalendarPayload(withMarket(await seed(), m), portfolio(), "sub", {});
    const events = p.weeks.flatMap((w) => w.events).filter((e) => e.kind === "dividend_pay");
    const u = events.find((e) => e.symbol === "ZZUSD")!;
    expect(u.amount).toMatchObject({ perUnit: 0.5, units: 10, total: 5, currency: "USD" });
    expect(u.amount!.home).toMatchObject({ amount: 7, estimated: true, rate: 1.4, native: { amount: 5, currency: "USD" } });
    const c = events.find((e) => e.symbol === "ZZDIV")!;
    expect(c.amount!.home).toMatchObject({ amount: 50, estimated: false });
    expect(p.home!.dividends).toMatchObject({ amount: 57, estimated: true, excludedCount: 0 });
    expect(m.usdCad).toHaveBeenCalledTimes(1);
  });

  it("without a rate the USD dividend is not converted and counted", async () => {
    const p = await buildCalendarPayload(withMarket(await seed(), market(null)), portfolio(), "sub", {});
    const u = p.weeks.flatMap((w) => w.events).find((e) => e.symbol === "ZZUSD" && e.kind === "dividend_pay")!;
    expect(u.amount!.home!.amount).toBeNull();
    expect(p.home!.dividends).toMatchObject({ amount: 50, estimated: false, excludedCount: 1, excluded: [{ amount: 5, currency: "USD" }] });
  });

  it("is absent with cadView off, and the fetch is skipped without a USD dividend", async () => {
    const m = market();
    const off = withMarket(await seed(), m, { settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView: false })) } });
    const p = await buildCalendarPayload(off, portfolio(), "sub", {});
    expect(p.home).toBeUndefined();
    expect(p.weeks.flatMap((w) => w.events).every((e) => !e.amount || e.amount.home === undefined)).toBe(true);
    const cadOnly = withMarket(await seed(), m, { dividends: vi.fn(async () => PAYMENTS) });
    await buildCalendarPayload(cadOnly, portfolio(), "sub", {});
    expect(m.usdCad).not.toHaveBeenCalled();
  });

  it("model copy: CAD total and the CAD note", async () => {
    const p = await buildCalendarPayload(withMarket(await seed(), market()), portfolio(), "sub", {});
    const copy = calendarModelCopy(p) as any;
    expect(copy.homeDividends).toEqual({ amount: 57, estimated: true, notConverted: 0 });
    expect(copy.notes.currency).toBe("Figures are in CAD; USD amounts are converted at the Bank of Canada rate and marked est.");
    expect(JSON.stringify(copy)).not.toContain("never mixed");
    expect(copy.notes.projectedRate).toContain("converted at the latest Bank of Canada rate");
  });
});

describe("a dividend whose last payment has no per-unit figure (A4)", () => {
  it("keeps the date with no amount, and the model copy says why", async () => {
    const store = await seed();
    const dividends = vi.fn(async () => [divPay("2026-08-30"), { symbol: "ZZDIV", date: day("2026-09-30"), perUnit: null, currency: "CAD" }]);
    const p = await buildCalendarPayload(deps(store, dividends), portfolio(), "sub", {});
    const div = p.weeks.flatMap((w) => w.events).find((e) => e.kind === "dividend_pay")!;
    expect(div).toMatchObject({ symbol: "ZZDIV", date: "2026-10-30", amount: null });
    const copy = calendarModelCopy(p);
    expect(copy.events.find((e) => e.kind === "dividend_pay")!.perUnit).toBeNull();
    expect(copy.notes.amounts).toMatch(/null perUnit/);
  });
});
