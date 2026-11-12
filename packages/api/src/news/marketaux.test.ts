import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../market-data/types.js";
import { hashUrl, marketauxFetcher, symbolAliases } from "./marketaux.js";

const NOW = new Date("2026-10-21T12:00:00Z");
const since = new Date("2026-10-14T00:00:00Z");
const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const item = (n: number, extra: Record<string, unknown> = {}) => ({
  title: `ZZTEST headline ${n}`, snippet: "short snippet", description: "desc", source: "example.test",
  image_url: "https://img.example.test/a.png", url: `https://example.test/a${n}?utm_source=x&id=${n}`,
  published_at: "2026-10-20T10:00:00.000000Z", entities: [{ symbol: "zztest" }, { symbol: "ZZOTHER" }, { symbol: "ZZTEST" }], ...extra,
});

describe("marketauxFetcher", () => {
  it("maps fields, truncates snippet, merges symbols, hashes cleaned url", async () => {
    const urls: string[] = [];
    const f: FetchLike = async (u) => { urls.push(u); return res(200, { data: [item(1, { snippet: "", description: "d".repeat(300), image_url: null })] }); };
    const out = await marketauxFetcher({ apiKey: "KEY123", fetch: f, now: () => NOW, pageSize: 20 }).fetchForSymbol("ZZTEST", since);
    expect(out.rateLimited).toBe(false);
    const [a] = out.articles;
    expect(a).toMatchObject({ headline: "ZZTEST headline 1", source: "example.test", imageUrl: null, publishedAt: new Date("2026-10-20T10:00:00Z"), fetchedAt: NOW });
    expect(a.snippet).toHaveLength(200);
    expect([...a.symbols].sort()).toEqual(["ZZOTHER", "ZZTEST"]);
    expect(a.urlHash).toBe(createHash("sha256").update("https://example.test/a1?id=1").digest("hex"));
    const u = new URL(urls[0]);
    expect(u.searchParams.get("symbols")).toBe("ZZTEST");
    expect(u.searchParams.get("filter_entities")).toBe("true");
    expect(u.searchParams.get("language")).toBe("en");
    expect(u.searchParams.get("limit")).toBe("20");
    expect(u.searchParams.get("published_after")).toContain("2026-10-14");
    expect(u.searchParams.get("api_token")).toBe("KEY123");
  });

  it("drops articles whose url is not http(s) and nulls a non-http(s) image url", async () => {
    const data = [
      item(1, { url: "javascript:alert(1)" }),
      item(2, { url: "data:text/html,<b>x</b>" }),
      item(3, { image_url: "javascript:alert(1)" }),
      item(4, { image_url: "data:image/png;base64,AAAA" }),
      item(5, { url: "http://example.test/a5" }),
    ];
    const out = await marketauxFetcher({ apiKey: "K", fetch: async () => res(200, { data }), now: () => NOW, pageSize: 20 }).fetchForSymbol("ZZTEST", since);
    expect(out.articles.map((a) => a.headline)).toEqual(["ZZTEST headline 3", "ZZTEST headline 4", "ZZTEST headline 5"]);
    expect(out.articles.map((a) => a.imageUrl)).toEqual([null, null, "https://img.example.test/a.png"]);
  });

  it("pages up to 3 times and stops early on a short page", async () => {
    let calls = 0;
    const f: FetchLike = async (u) => { calls++; const p = Number(new URL(u).searchParams.get("page")); return res(200, { data: [item(p * 10), item(p * 10 + 1)] }); };
    const out = await marketauxFetcher({ apiKey: "K", fetch: f, now: () => NOW, pageSize: 2 }).fetchForSymbol("ZZTEST", since);
    expect(calls).toBe(3);
    expect(out.articles).toHaveLength(6);
    calls = 0;
    const g: FetchLike = async () => { calls++; return res(200, { data: [item(1)] }); };
    await marketauxFetcher({ apiKey: "K", fetch: g, now: () => NOW, pageSize: 3 }).fetchForSymbol("ZZTEST", since);
    expect(calls).toBe(1);
  });

  it("429 and rate_limit_reached return empty with rateLimited", async () => {
    const a = await marketauxFetcher({ apiKey: "K", fetch: async () => res(429, {}), now: () => NOW }).fetchForSymbol("ZZTEST", since);
    expect(a).toMatchObject({ articles: [], rateLimited: true });
    const b = await marketauxFetcher({ apiKey: "K", fetch: async () => res(200, { error: { code: "rate_limit_reached" } }), now: () => NOW }).fetchForSymbol("ZZTEST", since);
    expect(b).toMatchObject({ articles: [], rateLimited: true });
  });

  it("returns pages already fetched when rate limited mid-way, and counts requests", async () => {
    let calls = 0;
    const f: FetchLike = async () => { calls++; return calls === 1 ? res(200, { data: [item(1), item(2)] }) : res(429, {}); };
    const out = await marketauxFetcher({ apiKey: "K", fetch: f, now: () => NOW, pageSize: 2 }).fetchForSymbol("ZZTEST", since);
    expect(out.rateLimited).toBe(true);
    expect(out.articles).toHaveLength(2);
    expect(out.requests).toBe(2);
  });

  it("treats 402 and usage_limit_reached as rate limited", async () => {
    const a = await marketauxFetcher({ apiKey: "K", fetch: async () => res(402, {}), now: () => NOW }).fetchForSymbol("ZZTEST", since);
    expect(a).toMatchObject({ articles: [], rateLimited: true });
    const b = await marketauxFetcher({ apiKey: "K", fetch: async () => res(200, { error: { code: "usage_limit_reached" } }), now: () => NOW }).fetchForSymbol("ZZTEST", since);
    expect(b).toMatchObject({ articles: [], rateLimited: true });
  });

  it("labels 429 / rate_limit_reached as a throttle and 402 / usage_limit_reached as daily exhaustion", async () => {
    const fetchWith = (r: ReturnType<typeof res>) => marketauxFetcher({ apiKey: "K", fetch: async () => r, now: () => NOW }).fetchForSymbol("ZZTEST", since);
    expect((await fetchWith(res(429, {}))).limit).toBe("throttle");
    expect((await fetchWith(res(200, { error: { code: "rate_limit_reached" } }))).limit).toBe("throttle");
    expect((await fetchWith(res(402, {}))).limit).toBe("daily");
    expect((await fetchWith(res(200, { error: { code: "usage_limit_reached" } }))).limit).toBe("daily");
    expect((await fetchWith(res(200, { data: [] }))).limit).toBeNull();
  });

  it("honours per-call pageSize and maxPages", async () => {
    const urls: string[] = [];
    const f: FetchLike = async (u) => { urls.push(u); return res(200, { data: [item(urls.length * 10), item(urls.length * 10 + 1), item(urls.length * 10 + 2)] }); };
    const out = await marketauxFetcher({ apiKey: "K", fetch: f, now: () => NOW, pageSize: 20 }).fetchForSymbol("ZZTEST", since, { pageSize: 3, maxPages: 1 });
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).searchParams.get("limit")).toBe("3");
    expect(out.requests).toBe(1);
  });

  it("never leaks the api token in errors", async () => {
    const f: FetchLike = async (u) => { throw new Error(`boom ${u}`); };
    const err = await marketauxFetcher({ apiKey: "SECRETKEY", fetch: f, now: () => NOW }).fetchForSymbol("ZZTEST", since).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain("SECRETKEY");
  });

  it("queries each alias, dedupes by urlHash and tags the held symbol", async () => {
    const seen: string[] = [];
    const f: FetchLike = async (u) => {
      const s = new URL(u).searchParams.get("symbols")!; seen.push(s);
      return res(200, { data: s === "ZZ.TO" ? [item(1, { entities: [] })] : [item(1, { entities: [{ symbol: "ZZ" }] }), item(2, { entities: [{ symbol: "ZZ" }] })] });
    };
    const out = await marketauxFetcher({ apiKey: "K", fetch: f, now: () => NOW, pageSize: 20, known: () => "ZZ" }).fetchForSymbol("ZZ.TO", since);
    expect(seen).toEqual(["ZZ.TO", "ZZ"]);
    expect(out.articles).toHaveLength(2);
    for (const a of out.articles) expect(a.symbols).toContain("ZZ.TO");
    expect(out.articles.find((a) => a.url.includes("a1"))!.symbols.sort()).toEqual(["ZZ", "ZZ.TO"]);
  });
});

describe("hashUrl", () => {
  it("strips utm params and trailing slash", () => {
    expect(hashUrl("https://e.test/x/?utm_medium=a")).toBe(hashUrl("https://e.test/x"));
  });
});

describe("symbolAliases", () => {
  it("expands Canadian listings", () => {
    expect(symbolAliases("ZZ.TO", { usSymbol: "ZZ" })).toEqual(["ZZ.TO", "ZZ"]);
    expect(symbolAliases("ZZ")).toEqual(["ZZ"]);
    expect(symbolAliases("ZZ.TO")).toEqual(["ZZ.TO"]);
    expect(symbolAliases("RY.TO")).toEqual(["RY.TO", "RY"]);
    expect(symbolAliases("CNR.TO")).toEqual(["CNR.TO", "CNI"]);
    expect(symbolAliases("GIB.A.TO")).toEqual(["GIB.A.TO", "GIB"]);
    expect(symbolAliases("DOL.TO")).toEqual(["DOL.TO"]);
    expect(symbolAliases("ZZ.V", { usSymbol: null })).toEqual(["ZZ.V"]);
  });
});
