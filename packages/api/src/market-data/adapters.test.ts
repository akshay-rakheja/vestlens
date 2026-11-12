import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BankOfCanadaFx } from "./bank-of-canada.js";
import { StooqProvider } from "./stooq.js";
import { MarketDataUnavailableError, type FetchLike } from "./types.js";
import { YahooChartProvider } from "./yahoo.js";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const respond = (body: string, ok = true, status = 200): FetchLike =>
  vi.fn(async () => ({ ok, status, json: async () => JSON.parse(body), text: async () => body }));

describe("market-data adapters", () => {
  it("parses Yahoo history and quotes; URLs carry only ticker and range", async () => {
    const fetch = respond(fixture("yahoo-chart.json"));
    const yahoo = new YahooChartProvider(fetch);
    await expect(yahoo.history("XEQT.TO", "2026-10-13", "2026-10-14")).resolves.toEqual([
      { date: "2026-10-13", close: 31.25 }, { date: "2026-10-14", close: 31.42 },
    ]);
    await expect(yahoo.quote("XEQT.TO")).resolves.toMatchObject({ ticker: "XEQT.TO", currency: "CAD", price: 31.42, previousClose: 31.25 });
    const url = String((fetch as any).mock.calls[0][0]);
    expect(url).toMatch(/^https:\/\/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/XEQT\.TO\?/);
    expect(url).not.toMatch(/user|account|units|value/i);
  });
  it("distributions asks for dividend events and reports them with the chart's currency", async () => {
    const body = JSON.stringify({ chart: { result: [{
      meta: { currency: "CAD", regularMarketPrice: 20 }, timestamp: [1760000000], indicators: { quote: [{ close: [20] }] },
      events: { dividends: { "1767364200": { date: 1767364200, amount: 0.25 }, "1759584600": { date: 1759584600, amount: 0.2 }, "1": { date: 1 } } } }] } });
    const fetch = respond(body);
    const yahoo = new YahooChartProvider(fetch);
    await expect(yahoo.distributions("SYN.TO", "2025-10-01", "2026-10-01")).resolves.toEqual({
      currency: "CAD", events: [{ date: "2025-10-04", amount: 0.2 }, { date: "2026-01-02", amount: 0.25 }],
    });
    const url = String((fetch as any).mock.calls[0][0]);
    expect(url).toMatch(/[?&]events=div,split(&|$)/);
    const none = JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 20 }, indicators: { quote: [{ close: [] }] } }] } });
    await expect(new YahooChartProvider(respond(none)).distributions("SYN", "2025-10-01", "2026-10-01")).resolves.toEqual({ currency: null, events: [] });
  });

  it("F3: Yahoo history requests split events and returns them alongside closes", async () => {
    const body = JSON.stringify({ chart: { result: [{
      meta: { currency: "USD", regularMarketPrice: 12 },
      timestamp: [1760362200, 1760448600, 1760535000],
      indicators: { quote: [{ close: [10, 11, 12] }] },
      events: { splits: {
        "1760448600": { date: 1760448600, numerator: 10, denominator: 1, splitRatio: "10:1" },
        "1760535000": { date: 1760535000, numerator: 0, denominator: 1, splitRatio: "0:1" },
      } },
    }] } });
    const fetch = respond(body);
    const yahoo = new YahooChartProvider(fetch);
    await expect(yahoo.historyWithSplits("SYN", "2026-10-13", "2026-10-15")).resolves.toEqual({
      points: [{ date: "2025-10-13", close: 10 }, { date: "2025-10-14", close: 11 }, { date: "2025-10-15", close: 12 }],
      splits: [{ date: "2025-10-14", ratio: 10 }],
    });
    const url = String((fetch as any).mock.calls[0][0]);
    expect(url).toMatch(/[?&]events=split(&|$)/);
    expect(url).not.toMatch(/user|account|units|value/i);
    // A response without events means "no splits in range", not "unknown".
    await expect(new YahooChartProvider(respond(fixture("yahoo-chart.json"))).historyWithSplits("XEQT.TO", "2026-10-13", "2026-10-14"))
      .resolves.toMatchObject({ splits: [] });
  });
  it("parses Stooq CSV", async () => {
    await expect(new StooqProvider(respond(fixture("stooq.csv"))).history("^spx", "2026-10-13", "2026-10-14"))
      .resolves.toEqual([{ date: "2026-10-13", close: 6712.5 }, { date: "2026-10-14", close: 6735.9 }]);
  });
  it("parses Bank of Canada USD/CAD", async () => {
    await expect(new BankOfCanadaFx(respond(fixture("boc-fx.json"))).usdCad("2026-10-13", "2026-10-14"))
      .resolves.toEqual([{ date: "2026-10-13", close: 1.3712 }, { date: "2026-10-14", close: 1.3698 }]);
  });
  it("turns HTTP errors and malformed bodies into MarketDataUnavailableError", async () => {
    await expect(new YahooChartProvider(respond("{}", false, 429)).quote("VFV.TO")).rejects.toBeInstanceOf(MarketDataUnavailableError);
    await expect(new YahooChartProvider(respond("{\"chart\":{\"result\":null}}")).quote("VFV.TO")).rejects.toBeInstanceOf(MarketDataUnavailableError);
    await expect(new StooqProvider(respond("No data")).history("^spx", "2026-10-13", "2026-10-14")).rejects.toBeInstanceOf(MarketDataUnavailableError);
  });
  it("maps a Stooq body read failure to MarketDataUnavailableError", async () => {
    const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => { throw new Error("socket reset"); } }));
    await expect(new StooqProvider(fetch).history("^spx", "2026-10-13", "2026-10-14")).rejects.toBeInstanceOf(MarketDataUnavailableError);
  });
  it("times out a fetch whose body never resolves with MarketDataUnavailableError", async () => {
    const stalled = (): Promise<never> => new Promise(() => {});
    const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, json: stalled, text: stalled }));
    await expect(new YahooChartProvider(fetch, 20).quote("VFV.TO")).rejects.toBeInstanceOf(MarketDataUnavailableError);
    await expect(new StooqProvider(fetch, 20).history("^spx", "2026-10-13", "2026-10-14")).rejects.toBeInstanceOf(MarketDataUnavailableError);
    await expect(new BankOfCanadaFx(fetch, 20).usdCad("2026-10-13", "2026-10-14")).rejects.toBeInstanceOf(MarketDataUnavailableError);
  });
  it("drops Stooq rows with an empty or non-positive close", async () => {
    const csv = "Date,Open,High,Low,Close,Volume\n2026-10-13,1,1,1,,0\n2026-10-14,1,1,1,0,0\n2026-10-15,1,1,1,6735.9,0\n";
    await expect(new StooqProvider(respond(csv)).history("^spx", "2026-10-13", "2026-10-15"))
      .resolves.toEqual([{ date: "2026-10-15", close: 6735.9 }]);
  });
  it("drops Bank of Canada observations with blank, zero or missing values", async () => {
    const body = JSON.stringify({ observations: [
      { d: "2026-10-13", FXUSDCAD: { v: "" } },
      { d: "2026-10-14" },
      { d: "2026-10-15", FXUSDCAD: { v: "0" } },
      { d: "2026-10-16", FXUSDCAD: { v: "1.3650" } },
    ] });
    await expect(new BankOfCanadaFx(respond(body)).usdCad("2026-10-13", "2026-10-16"))
      .resolves.toEqual([{ date: "2026-10-16", close: 1.365 }]);
  });
  it("takes Yahoo previousClose from the penultimate bar when meta omits it", async () => {
    const body = JSON.stringify({ chart: { result: [{ meta: { currency: "CAD", regularMarketPrice: 12, chartPreviousClose: 9 },
      timestamp: [1791763200, 1791849600, 1791936000], indicators: { quote: [{ close: [10, 11, 12] }] } }], error: null } });
    await expect(new YahooChartProvider(respond(body)).quote("VFV.TO")).resolves.toMatchObject({ price: 12, previousClose: 11 });
  });
  it("uses the last non-null close before the final index, and never chartPreviousClose", async () => {
    const body = JSON.stringify({ chart: { result: [{ meta: { currency: "CAD", regularMarketPrice: 12, chartPreviousClose: 9 },
      timestamp: [1791763200, 1791849600, 1791936000], indicators: { quote: [{ close: [10, 11, null] }] } }], error: null } });
    await expect(new YahooChartProvider(respond(body)).quote("VFV.TO")).resolves.toMatchObject({ previousClose: 11 });
  });
  it("returns null previousClose for a single bar, ignoring chartPreviousClose", async () => {
    const body = JSON.stringify({ chart: { result: [{ meta: { currency: "CAD", regularMarketPrice: 12, chartPreviousClose: 9 },
      timestamp: [1791936000], indicators: { quote: [{ close: [12] }] } }], error: null } });
    await expect(new YahooChartProvider(respond(body)).quote("VFV.TO")).resolves.toMatchObject({ previousClose: null });
  });
});

describe("Yahoo intraday", () => {
  const body = (extra = "") => JSON.stringify({ chart: { result: [{ meta: { currency: "CAD", symbol: "SYN", regularMarketPrice: 10, exchangeTimezoneName: "America/Toronto" + extra },
    timestamp: [1792029000, 1792029300, 1792029600, 1792114800], indicators: { quote: [{ close: [10, null, 10.5, 11] }] } }], error: null } });
  it("parses 5m bars, drops null closes and takes the session date in the exchange timezone", async () => {
    const fetch = respond(body());
    const r = await new YahooChartProvider(fetch).intraday("SYN", "5m");
    expect(r.points).toEqual([
      { t: new Date(1792029000 * 1000).toISOString(), price: 10 },
      { t: new Date(1792029600 * 1000).toISOString(), price: 10.5 },
      { t: new Date(1792114800 * 1000).toISOString(), price: 11 },
    ]);
    // 1792114800 = 2026-10-16T01:40:00Z = 2026-10-15 21:40 in Toronto
    expect(r.sessionDate).toBe("2026-10-15");
    const url = String((fetch as any).mock.calls[0][0]);
    expect(url).toMatch(/\/chart\/SYN\?range=1d&interval=5m$/);
  });
  it("falls back to the UTC date without an exchange timezone and handles an empty series", async () => {
    const noTz = JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 1 }, timestamp: [1792114800], indicators: { quote: [{ close: [1] }] } }] } });
    expect((await new YahooChartProvider(respond(noTz)).intraday("SYN", "1h")).sessionDate).toBe("2026-10-16");
    const empty = JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 1 }, indicators: { quote: [{ close: [] }] } }] } });
    await expect(new YahooChartProvider(respond(empty)).intraday("SYN", "5m")).resolves.toEqual({ points: [], sessionDate: null });
  });
});

describe("Yahoo security profile", () => {
  type Handler = (url: string, headers?: Record<string, string>) => { status: number; body: string; cookie?: string[] };
  const routed = (handler: Handler): FetchLike => vi.fn(async (url, init) => {
    const r = handler(url, init?.headers);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(r.body), text: async () => r.body,
      headers: { get: (n: string) => (n.toLowerCase() === "set-cookie" ? (r.cookie ?? []).join(", ") || null : null), getSetCookie: () => r.cookie ?? [] } };
  });
  const happy = (summary: string): Handler => (url) => {
    if (url.startsWith("https://fc.yahoo.com")) return { status: 404, body: "", cookie: ["A3=d=abc; Expires=Wed, 01 Jan 2030 00:00:00 GMT; Domain=.yahoo.com", "B=xyz; Path=/"] };
    if (url.includes("/v1/test/getcrumb")) return { status: 200, body: "CRUMB123" };
    return { status: 200, body: summary };
  };

  it("parses a stock profile via the cookie+crumb flow; requests carry only ticker, crumb and cookie", async () => {
    const fetch = routed(happy(fixture("yahoo-quotesummary-stock.json")));
    await expect(new YahooChartProvider(fetch).profile("AAPL")).resolves.toEqual({
      kind: "stock", sector: "Technology", country: "United States", sectorWeights: null, countryWeights: null, topHoldings: null,
    });
    const calls = (fetch as any).mock.calls as Array<[string, { headers?: Record<string, string> }]>;
    expect(calls[1][0]).toBe("https://query1.finance.yahoo.com/v1/test/getcrumb");
    expect(calls[1][1].headers?.cookie).toBe("A3=d=abc; B=xyz");
    const url = calls[2][0];
    expect(url).toMatch(/^https:\/\/query1\.finance\.yahoo\.com\/v10\/finance\/quoteSummary\/AAPL\?modules=assetProfile,fundProfile,topHoldings&crumb=CRUMB123$/);
    expect(calls[2][1].headers?.cookie).toBe("A3=d=abc; B=xyz");
  });
  it("parses an ETF: snake_case sector keys become labels, weights use .raw, holdings kept", async () => {
    const profile = await new YahooChartProvider(routed(happy(fixture("yahoo-quotesummary-etf.json")))).profile("VFV.TO");
    expect(profile).toEqual({
      kind: "fund", sector: null, country: null, countryWeights: null,
      sectorWeights: { "Real estate": 0.018, "Consumer cyclical": 0.0931, Technology: 0.3, "Financial services": 0.2, "Communication services": 0.1 },
      topHoldings: [{ symbol: "VOO", weight: 1 }],
    });
  });
  it("normalises display-cased stock sectors and keeps country weights when present", async () => {
    const body = JSON.stringify({ quoteSummary: { result: [{ assetProfile: { sector: "Financial Services", country: "Canada" } }] } });
    await expect(new YahooChartProvider(routed(happy(body))).profile("RY.TO")).resolves.toMatchObject({ kind: "stock", sector: "Financial services", country: "Canada" });
    const fund = JSON.stringify({ quoteSummary: { result: [{ topHoldings: { sectorWeightings: [], holdings: [] }, fundProfile: { countryWeightings: [{ Canada: { raw: 0.6 } }] } }] } });
    const p = await new YahooChartProvider(routed(happy(fund))).profile("F");
    expect(p?.kind).toBe("fund");
  });
  it("missing modules give an unknown profile with nulls", async () => {
    const body = JSON.stringify({ quoteSummary: { result: [{}] } });
    await expect(new YahooChartProvider(routed(happy(body))).profile("ZZZ")).resolves.toEqual({
      kind: "unknown", sector: null, country: null, sectorWeights: null, countryWeights: null, topHoldings: null,
    });
  });
  it("crumb failure returns null without throwing", async () => {
    const noCookie = routed((url) => (url.startsWith("https://fc.yahoo.com") ? { status: 404, body: "" } : { status: 200, body: "x" }));
    await expect(new YahooChartProvider(noCookie).profile("AAPL")).resolves.toBeNull();
    const badCrumb = routed((url) => (url.startsWith("https://fc.yahoo.com") ? { status: 404, body: "", cookie: ["A=1"] } : { status: 429, body: "" }));
    await expect(new YahooChartProvider(badCrumb).profile("AAPL")).resolves.toBeNull();
    const boom: FetchLike = vi.fn(async () => { throw new Error("offline"); });
    await expect(new YahooChartProvider(boom).profile("AAPL")).resolves.toBeNull();
  });
  it("caches the crumb for an hour, refreshes once on 401, then gives up", async () => {
    let clock = 0;
    let crumbs = 0;
    const fetch = routed((url) => {
      if (url.startsWith("https://fc.yahoo.com")) return { status: 404, body: "", cookie: ["A=1"] };
      if (url.includes("getcrumb")) return { status: 200, body: `C${++crumbs}` };
      return { status: 200, body: fixture("yahoo-quotesummary-stock.json") };
    });
    const yahoo = new YahooChartProvider(fetch, 8_000, () => clock);
    await yahoo.profile("AAPL");
    await yahoo.profile("MSFT");
    expect(crumbs).toBe(1);
    clock = 3_600_001;
    await yahoo.profile("AAPL");
    expect(crumbs).toBe(2);

    let summaries = 0;
    const always401 = routed((url) => {
      if (url.startsWith("https://fc.yahoo.com")) return { status: 404, body: "", cookie: ["A=1"] };
      if (url.includes("getcrumb")) return { status: 200, body: "C" };
      summaries++;
      return { status: 401, body: "{\"finance\":{\"error\":{\"code\":\"Unauthorized\",\"description\":\"Invalid Crumb\"}}}" };
    });
    await expect(new YahooChartProvider(always401).profile("AAPL")).resolves.toBeNull();
    expect(summaries).toBe(2);
  });
  it("a 401 followed by a fresh crumb succeeds", async () => {
    let summaries = 0;
    const fetch = routed((url) => {
      if (url.startsWith("https://fc.yahoo.com")) return { status: 404, body: "", cookie: ["A=1"] };
      if (url.includes("getcrumb")) return { status: 200, body: "C" };
      return ++summaries === 1 ? { status: 401, body: "{}" } : { status: 200, body: fixture("yahoo-quotesummary-stock.json") };
    });
    await expect(new YahooChartProvider(fetch).profile("AAPL")).resolves.toMatchObject({ kind: "stock" });
  });
  it("concurrent cold profile() calls share one cookie+crumb flow", async () => {
    let cookies = 0;
    let crumbs = 0;
    const fetch = routed((url) => {
      if (url.startsWith("https://fc.yahoo.com")) { cookies++; return { status: 404, body: "", cookie: ["A=1"] }; }
      if (url.includes("getcrumb")) { crumbs++; return { status: 200, body: "C" }; }
      return { status: 200, body: fixture("yahoo-quotesummary-stock.json") };
    });
    const yahoo = new YahooChartProvider(fetch);
    const results = await Promise.all(["A", "B", "C", "D", "E"].map((t) => yahoo.profile(t)));
    expect(results.every((r) => r?.kind === "stock")).toBe(true);
    expect([cookies, crumbs]).toEqual([1, 1]);
  });
  it("concurrent calls after crumb expiry start only one new session", async () => {
    let clock = 0;
    let crumbs = 0;
    const fetch = routed((url) => {
      if (url.startsWith("https://fc.yahoo.com")) return { status: 404, body: "", cookie: ["A=1"] };
      if (url.includes("getcrumb")) { crumbs++; return { status: 200, body: "C" }; }
      return { status: 200, body: fixture("yahoo-quotesummary-stock.json") };
    });
    const yahoo = new YahooChartProvider(fetch, 8_000, () => clock);
    await yahoo.profile("A");
    clock = 3_600_001;
    await Promise.all(["B", "C", "D", "E", "F"].map((t) => yahoo.profile(t)));
    expect(crumbs).toBe(2);
  });
});
