import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../market-data/types.js";
import { edgarFetcher } from "./edgar.js";

const NOW = new Date("2026-10-21T12:00:00Z");
const since = new Date("2026-10-01T00:00:00Z");
const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => "" });
const tickers = { "0": { cik_str: 1234567, ticker: "ZZTEST", title: "Zz Test Inc" } };
const subs = { filings: { recent: {
  form: ["8-K", "10-Q", "6-K", "8-K"],
  filingDate: ["2026-10-15", "2026-10-14", "2026-10-10", "2026-08-01"],
  acceptanceDateTime: ["2026-10-15T13:00:00.000Z", "2026-10-14T13:00:00.000Z", "2026-10-10T13:00:00.000Z", "2026-08-01T13:00:00.000Z"],
  accessionNumber: ["0001234567-26-000001", "0001234567-26-000002", "0001234567-26-000003", "0001234567-26-000004"],
  primaryDocDescription: ["Invented results", "", "", "Old"],
} } };
function mk(log: Array<{ url: string; ua?: string; t: number }> = []): FetchLike {
  return async (url, init) => {
    log.push({ url, ua: init?.headers?.["user-agent"] ?? init?.headers?.["User-Agent"], t: Date.now() });
    if (url.includes("company_tickers")) return res(200, tickers);
    if (url.includes("CIK0001234567")) return res(200, subs);
    return res(404, {});
  };
}

describe("edgarFetcher", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  it("returns 8-K/6-K filings in window with the user agent", async () => {
    const log: Array<{ url: string; ua?: string; t: number }> = [];
    const p = edgarFetcher({ userAgent: "Test test@example.test", fetch: mk(log), now: () => NOW }).fetchForSymbol("zztest", since);
    await vi.runAllTimersAsync();
    const out = await p;
    expect(out.rateLimited).toBe(false);
    expect(out.articles.map((a) => a.headline)).toEqual(["8-K: Invented results", "6-K: filing"]);
    expect(out.articles[0]).toMatchObject({ source: "SEC EDGAR", imageUrl: null, snippet: null, symbols: ["ZZTEST"],
      url: "https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/0001234567-26-000001-index.htm" });
    expect(log.every((l) => l.ua === "Test test@example.test")).toBe(true);
  });

  it("caches the ticker map, unknown ticker gives empty, and paces to 10 req/s", async () => {
    const log: Array<{ url: string; ua?: string; t: number }> = [];
    const f = edgarFetcher({ userAgent: "UA", fetch: mk(log), now: () => NOW });
    const p = Promise.all([f.fetchForSymbol("ZZTEST", since), f.fetchForSymbol("ZZTEST", since), f.fetchForSymbol("NOPE", since)]);
    await vi.runAllTimersAsync();
    const [, , none] = await p;
    expect(none.articles).toEqual([]);
    expect(log.filter((l) => l.url.includes("company_tickers"))).toHaveLength(1);
    expect(log).toHaveLength(3);
    for (let i = 1; i < log.length; i++) expect(log[i].t - log[i - 1].t).toBeGreaterThanOrEqual(100);
  });

  it("429 yields rateLimited", async () => {
    const p = edgarFetcher({ userAgent: "UA", fetch: async () => res(429, {}), now: () => NOW }).fetchForSymbol("ZZTEST", since);
    await vi.runAllTimersAsync();
    expect(await p).toMatchObject({ articles: [], rateLimited: true });
  });

  it("403 yields rateLimited", async () => {
    const p = edgarFetcher({ userAgent: "UA", fetch: async () => res(403, {}), now: () => NOW }).fetchForSymbol("ZZTEST", since);
    await vi.runAllTimersAsync();
    expect(await p).toMatchObject({ articles: [], rateLimited: true });
  });

  it("ignores Canadian listings without any request", async () => {
    const log: Array<{ url: string; ua?: string; t: number }> = [];
    const f = edgarFetcher({ userAgent: "UA", fetch: mk(log), now: () => NOW });
    expect(await f.fetchForSymbol("ZZ.TO", since)).toMatchObject({ articles: [], rateLimited: false });
    expect(await f.fetchForSymbol("zz.v", since)).toMatchObject({ articles: [] });
    expect(log).toHaveLength(0);
  });

  it("filingDates: 10-Q/10-K filing dates (UTC midnight, ascending) from the submissions API, cached per symbol", async () => {
    const log: Array<{ url: string; ua?: string; t: number }> = [];
    const withK = { filings: { recent: { ...subs.filings.recent,
      form: [...subs.filings.recent.form, "10-K", "10-Q/A"], filingDate: [...subs.filings.recent.filingDate, "2026-02-05", "2026-03-01"],
      acceptanceDateTime: [...subs.filings.recent.acceptanceDateTime, "", ""], accessionNumber: [...subs.filings.recent.accessionNumber, "x", "y"],
      primaryDocDescription: [...subs.filings.recent.primaryDocDescription, "", ""] } } };
    const fetch: FetchLike = async (url, init) => {
      log.push({ url, ua: init?.headers?.["user-agent"], t: Date.now() });
      if (url.includes("company_tickers")) return res(200, tickers);
      if (url.includes("CIK0001234567")) return res(200, withK);
      return res(404, {});
    };
    const f = edgarFetcher({ userAgent: "UA", fetch, now: () => NOW });
    const p = f.filingDates("zztest");
    await vi.runAllTimersAsync();
    expect((await p).map((d) => d.toISOString())).toEqual(["2026-02-05T00:00:00.000Z", "2026-10-14T00:00:00.000Z"]);
    const again = f.filingDates("ZZTEST");
    await vi.runAllTimersAsync();
    expect(await again).toHaveLength(2);
    expect(log.filter((l) => l.url.includes("CIK"))).toHaveLength(1);
    expect(log.every((l) => l.ua === "UA")).toBe(true);
    expect(await f.filingDates("ZZ.TO")).toEqual([]);
    const none = f.filingDates("NOPE");
    await vi.runAllTimersAsync();
    expect(await none).toEqual([]);
  });

  it("filingDates throws on a rate limit so callers keep what they have", async () => {
    const p = edgarFetcher({ userAgent: "UA", fetch: async () => res(429, {}), now: () => NOW }).filingDates("ZZTEST");
    const done = p.catch((e) => e);
    await vi.runAllTimersAsync();
    expect(await done).toBeInstanceOf(Error);
  });

  it("filingDates reuses the submissions fetchForSymbol just read (one EDGAR fetch per symbol per run)", async () => {
    const log: Array<{ url: string; ua?: string; t: number }> = [];
    const f = edgarFetcher({ userAgent: "UA", fetch: mk(log), now: () => NOW });
    const p = (async () => { await f.fetchForSymbol("ZZTEST", since); return f.filingDates("ZZTEST"); })();
    await vi.runAllTimersAsync();
    expect((await p).map((d) => d.toISOString().slice(0, 10))).toEqual(["2026-10-14"]);
    expect(log.filter((l) => l.url.includes("CIK"))).toHaveLength(1);
  });
});
