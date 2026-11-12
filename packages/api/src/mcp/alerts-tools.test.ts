import { describe, expect, it, vi } from "vitest";

import { MemoryNewsStore, type ArticleRating, type StoredArticle } from "../news/store.js";
import {
  alertsClientKey, alertsInput, AlertsUnavailableError, alertsText, alertsToolDefinitions, buildAlertsPayload, type AlertsDeps,
} from "./alerts-tools.js";

// Wednesday 16:00 Toronto (market closed): movers compare the last two closes.
const NOW = new Date("2026-10-21T20:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const cls = (bucket: string, group: string, included: boolean, label: string): any => ({ label, bucket, group, includedInPortfolioTotal: included, isClosed: group === "closed" });
const pos = (symbol: string, over: Record<string, unknown> = {}): any => ({
  instrumentId: `i-${symbol}`, kind: "stock", symbol, description: `${symbol} Synthetic Corp`, units: 100, price: 50, costBasis: 40, marketValue: 5000, unrealizedGain: null, currency: "CAD", cashEquivalent: false, ...over,
});
const portfolio = (): any => ({
  generatedAt: "2026-10-21T19:55:00.000Z",
  accounts: [
    { id: "TFSA", classification: cls("tfsa", "registered", true, "TFSA"), value: { amount: 20_000, currency: "CAD", source: "brokerage_reported" }, balances: [], positions: [pos("ZZTEST"), pos("ZZCALM", { units: 10, price: 100, marketValue: 1000 })] },
    { id: "RRSP", classification: cls("rrsp", "registered", true, "RRSP"), value: { amount: 10_000, currency: "CAD", source: "brokerage_reported" }, balances: [], positions: [pos("ZZEARN"), pos("ZZDIV")] },
  ],
});
const stat = (symbol: string, lastClose: number, prevClose: number) => ({ symbol, currency: "CAD", closes: 61, typicalMove: 0.01, lastClose, prevClose, lastCloseDate: "2026-10-21", updatedAt: NOW });
const rating = (articleId: string, symbol: string, over: Partial<ArticleRating> = {}): ArticleRating => ({
  articleId, symbol, model: "jev-test", ratedAt: NOW, relevant: 0.9, sentiment: 1, sentimentConfidence: 0.8, materiality: 3,
  eventType: "other", eventConfidence: 0.8, credible: 0.9, clickbait: 0.1, duplicateOf: null, ...over,
});
let n = 0;
const article = (symbol: string, h: number, over: Partial<Omit<StoredArticle, "id">> = {}): Omit<StoredArticle, "id"> => {
  n += 1;
  return { urlHash: String(n).padStart(64, "0"), url: `https://news.example.invalid/al/${n}`, headline: `Invented ${symbol} item ${n}`, snippet: null,
    source: "synthetic.example", imageUrl: null, publishedAt: hoursAgo(h), symbols: [symbol], fetchedAt: NOW, ...over };
};

async function seed(newsCount = 1) {
  const store = new MemoryNewsStore();
  await store.putStats([stat("ZZTEST", 50, 45), stat("ZZCALM", 100, 100), stat("ZZEARN", 50, 50), stat("ZZDIV", 50, 50)]);
  const items = await store.upsertArticles([
    ...Array.from({ length: newsCount }, (_, i) => article("ZZTEST", 2 + i)),
    article("ZZCALM", 3, { headline: "Invented ZZCALM minor note" }),
    article("ZZCALM", 100, { headline: "Invented ZZCALM old story" }),
  ]);
  await store.putRatings([
    ...items.slice(0, newsCount).map((a) => rating(a.id, "ZZTEST")),
    rating(items[newsCount]!.id, "ZZCALM", { materiality: 1 }),
    rating(items[newsCount + 1]!.id, "ZZCALM"),
  ]);
  await store.putEvents([
    { id: "earnings:ZZEARN:2026-10-23", symbol: "ZZEARN", kind: "earnings", date: day("2026-10-23"), status: "expected", source: "edgar", amountPerUnit: null, currency: null },
    { id: "earnings:ZZDIV:2026-11-20", symbol: "ZZDIV", kind: "earnings", date: day("2026-11-20"), status: "expected", source: "edgar", amountPerUnit: null, currency: null },
  ]);
  return store;
}
/** The requesting user's own past payments (quarterly ZZDIV: next pay date 2026-10-22). */
const divPay = (iso: string, perUnit = 0.2) => ({ symbol: "ZZDIV", date: day(iso), perUnit, currency: "CAD" });
function deps(store: MemoryNewsStore, over: Partial<AlertsDeps> = {}): AlertsDeps & { market: any; dividends: any } {
  return {
    store, market: { quotes: vi.fn(async () => new Map()) }, appUserId: vi.fn(async () => "00000000-0000-4000-8000-000000000001"),
    dividends: vi.fn(async () => [divPay("2026-04-22"), divPay("2026-07-22")]), now: () => NOW, ...over,
  } as never;
}

describe("buildAlertsPayload", () => {
  it("returns movers, material news, earnings and dividend dates since the last check", async () => {
    const p = await buildAlertsPayload(deps(await seed()), portfolio(), "sub", "client-a", {});
    expect(Object.keys(p).sort()).toEqual(["alerts", "generatedAt", "next", "quiet", "since"]);
    expect(p.generatedAt).toBe(NOW.toISOString());
    expect(p.since).toBe(hoursAgo(48).toISOString());
    expect(p.quiet).toBe(false);
    expect(p.alerts.map((a) => a.kind).sort()).toEqual(["dividend_upcoming", "earnings_upcoming", "news", "unusual_move"]);
    expect(p.alerts.find((a) => a.kind === "unusual_move")).toMatchObject({ symbol: "ZZTEST", materiality: 3 });
    expect(p.alerts.find((a) => a.kind === "news")!.summary).toContain("AI-rated; may be wrong.");
    expect(p.next).toEqual({ earningsThisWeek: 1 });
    expect(JSON.stringify(p)).not.toMatch(/TFSA|RRSP|20000|5000/);
  });

  it("Review Focus 5: two clients each receive every alert once; a third call from either is quiet", async () => {
    const store = await seed();
    const d = deps(store);
    const a1 = await buildAlertsPayload(d, portfolio(), "sub", "client-a", {});
    const b1 = await buildAlertsPayload(d, portfolio(), "sub", "client-b", {});
    expect(b1.alerts.map((a) => a.id).sort()).toEqual(a1.alerts.map((a) => a.id).sort());
    expect(a1.alerts).toHaveLength(4);
    for (const key of ["client-a", "client-b"]) {
      const again = await buildAlertsPayload(d, portfolio(), "sub", key, {});
      expect(again).toMatchObject({ quiet: true, alerts: [] });
    }
  });

  it("caps each call at 10 by materiality; the rest arrive on the next call", async () => {
    const d = deps(await seed(12));
    const first = await buildAlertsPayload(d, portfolio(), "sub", "client-a", {});
    expect(first.alerts).toHaveLength(10);
    const second = await buildAlertsPayload(d, portfolio(), "sub", "client-a", {});
    expect(second.alerts.length).toBe(5);
    expect(second.alerts.map((a) => a.kind)).toContain("dividend_upcoming");
  });

  it("since narrows the news window (clamped to 7 days); the ledger still decides what is new", async () => {
    const d = deps(await seed(3));
    const p = await buildAlertsPayload(d, portfolio(), "sub", "client-a", { since: hoursAgo(3).toISOString() });
    expect(p.since).toBe(hoursAgo(3).toISOString());
    expect(p.alerts.filter((a) => a.kind === "news")).toHaveLength(2);
    const wide = await buildAlertsPayload(d, portfolio(), "sub", "client-b", { since: "2020-01-01T00:00:00Z" });
    expect(wide.since).toBe(new Date(NOW.getTime() - 7 * 86_400_000).toISOString());
    expect(wide.alerts.filter((a) => a.kind === "news").map((a) => a.symbol)).toEqual(["ZZTEST", "ZZTEST", "ZZTEST", "ZZCALM"]);
  });

  it("Review Focus 4: with the news budget gone it still alerts from cache and makes no provider request", async () => {
    const store = await seed();
    await store.spendBudget("2026-10-21", 500);
    const d = deps(store);
    const p = await buildAlertsPayload(d, portfolio(), "sub", "client-a", {});
    expect(p.alerts.map((a) => a.kind)).toEqual(expect.arrayContaining(["unusual_move", "earnings_upcoming", "dividend_upcoming"]));
    expect(d.market.quotes).not.toHaveBeenCalled(); // market closed
  });

  it("dividend alerts come from the requesting user's own payments only, never from a shared projection (I2)", async () => {
    const store = await seed();
    // A legacy shared dividend row is ignored.
    await store.putEvents([{ id: "dividend_pay:ZZDIV:2026-10-23", symbol: "ZZDIV", kind: "dividend_pay", date: day("2026-10-23"), status: "expected", source: "projection", amountPerUnit: 9, currency: "CAD" }]);
    const byUser: Record<string, ReturnType<typeof divPay>[]> = { alice: [divPay("2026-04-22"), divPay("2026-07-22")], bob: [] };
    const d = deps(store, { appUserId: async (sub: string) => (sub === "alice" ? "00000000-0000-4000-8000-00000000000a" : "00000000-0000-4000-8000-00000000000b"), dividends: vi.fn(async (sub: string) => byUser[sub] ?? []) } as never);
    const alice = await buildAlertsPayload(d, portfolio(), "alice", "client-a", {});
    const bob = await buildAlertsPayload(d, portfolio(), "bob", "client-a", {});
    expect(alice.alerts.filter((a) => a.kind === "dividend_upcoming").map((a) => a.id)).toEqual(["dividend_upcoming:ZZDIV:2026-10-22"]);
    expect(bob.alerts.filter((a) => a.kind === "dividend_upcoming")).toEqual([]);
    expect(d.dividends).toHaveBeenCalledWith("alice", expect.any(Array));
    // a failed read of the user's own payments only drops the dividend alerts
    const failing = deps(await seed(), { dividends: vi.fn(async () => { throw new Error("synthetic"); }) } as never);
    const p = await buildAlertsPayload(failing, portfolio(), "sub", "client-a", {});
    expect(p.alerts.map((a) => a.kind).sort()).toEqual(["earnings_upcoming", "news", "unusual_move"]);
  });

  it("the client key is the token's client_id, else mcp:<resource>", () => {
    expect(alertsClientKey({ clientId: "https://claude.example.invalid/client" }, "https://portfolio.example.invalid")).toBe("https://claude.example.invalid/client");
    expect(alertsClientKey({}, "https://portfolio.example.invalid")).toBe("mcp:https://portfolio.example.invalid");
    expect(alertsClientKey({ clientId: "" }, "aud")).toBe("mcp:aud");
  });

  it("long client keys are ledgered by hash; without an app user alerts are unavailable", async () => {
    const store = await seed();
    const long = "https://client.example.invalid/" + "x".repeat(600);
    const first = await buildAlertsPayload(deps(store), portfolio(), "sub", long, {});
    expect(first.quiet).toBe(false);
    expect((await buildAlertsPayload(deps(store), portfolio(), "sub", long, {})).quiet).toBe(true);
    await expect(buildAlertsPayload(deps(store, { appUserId: async () => null }), portfolio(), "sub", "client-a", {})).rejects.toBeInstanceOf(AlertsUnavailableError);
  });
});

describe("alerts text and tool definition", () => {
  it("quiet text is one line; otherwise it lists the summaries", async () => {
    const d = deps(await seed());
    const p = await buildAlertsPayload(d, portfolio(), "sub", "client-a", {});
    const text = alertsText(p);
    expect(text).toContain("4 material items since the last check");
    for (const a of p.alerts) expect(text).toContain(a.summary);
    const quiet = alertsText(await buildAlertsPayload(d, portfolio(), "sub", "client-a", {}));
    expect(quiet).toBe("Nothing material since the last check. Informational, not advice.");
  });

  it("get_portfolio_alerts is model-visible, read-only, instructs the quiet reply, and has a strict schema with real keys", async () => {
    const [tool] = alertsToolDefinitions;
    expect(alertsToolDefinitions).toHaveLength(1);
    expect(tool.name).toBe("get_portfolio_alerts");
    expect(tool.description).toBe("Returns material events for the user's holdings since the last check: unusual moves, high-materiality news, earnings and dividend dates. Call it from a scheduled task. If `quiet` is true, reply in one line that nothing material happened. Informational, not advice.");
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool.securitySchemes).toEqual([{ type: "oauth2", scopes: ["portfolio:read"] }]);
    expect(JSON.stringify(tool._meta)).not.toContain("visibility");
    expect(JSON.stringify(tool._meta)).not.toContain("resourceUri");
    const p = await buildAlertsPayload(deps(await seed()), portfolio(), "sub", "client-a", {});
    const schema = tool.outputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(p).sort()).toEqual([...schema.required].sort());
    expect(Object.keys(schema.properties).sort()).toEqual([...schema.required].sort());
    const item = schema.properties.alerts.items;
    for (const a of p.alerts) expect(Object.keys(a).sort()).toEqual([...item.required].sort());
    expect(Object.keys(item.properties).sort()).toEqual([...item.required].sort());
    expect(Object.keys(p.next).sort()).toEqual([...schema.properties.next.required].sort());
    expect(() => alertsInput.parse({ since: "yesterday" })).toThrow();
    expect(() => alertsInput.parse({ extra: 1 })).toThrow();
    expect(alertsInput.parse({})).toEqual({});
  });
});
