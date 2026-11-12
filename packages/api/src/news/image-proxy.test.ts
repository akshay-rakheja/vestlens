import express from "express";
import { describe, expect, it, vi } from "vitest";

import { loopbackRequest } from "../testing/loopback-request.js";
import { IMAGE_PROXY_MAX_BYTES, IMAGE_PROXY_MAX_IN_FLIGHT, imageProxyRouter } from "./image-proxy.js";
import { MemoryNewsStore } from "./store.js";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PUBLIC = [{ address: "93.184.216.34", family: 4 as const }];

async function setup(over: { imageUrl?: string | null; fetch?: ReturnType<typeof vi.fn>; lookup?: ReturnType<typeof vi.fn>; timeoutMs?: number; rateLimit?: number; maxInFlight?: number } = {}) {
  const store = new MemoryNewsStore();
  const [a] = await store.upsertArticles([{
    urlHash: "a".repeat(64), url: "https://news.example.invalid/zztest/1", headline: "ZZTEST invented headline", snippet: null,
    source: "synthetic.example", imageUrl: over.imageUrl === undefined ? "https://img.example.invalid/zz.png" : over.imageUrl,
    publishedAt: NOW, symbols: ["ZZTEST"], fetchedAt: NOW,
  }]);
  const fetch = over.fetch ?? vi.fn(async () => new Response(PNG, { status: 200, headers: { "content-type": "image/png", "content-length": String(PNG.length) } }));
  const lookup = over.lookup ?? vi.fn(async () => PUBLIC);
  const logs: object[] = [];
  const app = express();
  app.use(imageProxyRouter({
    store, fetch: fetch as never, lookup: lookup as never, log: (e) => logs.push(e),
    ...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {}),
    ...(over.rateLimit ? { rateLimitPerMinute: over.rateLimit } : {}),
    ...(over.maxInFlight ? { maxInFlight: over.maxInFlight } : {}),
  }));
  return { app, id: a!.id, fetch, lookup, logs, client: await loopbackRequest(app) };
}

describe("news image proxy", () => {
  it("streams a stored image with passthrough type, a 24 h public cache and nosniff", async () => {
    const { client, id, fetch, lookup } = await setup();
    const res = await client.get(`/api/news/image/${id}`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = []; r.on("data", (c: Buffer) => chunks.push(c)); r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("public, max-age=86400");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("sandbox");
    expect(lookup).toHaveBeenCalledWith("img.example.invalid");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://img.example.invalid/zz.png");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("404s an unknown id, a malformed id and an article without an image, without fetching", async () => {
    const { client, fetch } = await setup();
    expect((await client.get("/api/news/image/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await client.get("/api/news/image/not-a-uuid")).status).toBe(404);
    const none = await setup({ imageUrl: null });
    expect((await none.client.get(`/api/news/image/${none.id}`)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    expect(none.fetch).not.toHaveBeenCalled();
  });

  it("502s a non-image or SVG response", async () => {
    for (const type of ["text/html", "application/octet-stream", "image/svg+xml"]) {
      const fetch = vi.fn(async () => new Response("<x/>", { status: 200, headers: { "content-type": type } }));
      const { client, id } = await setup({ fetch });
      const res = await client.get(`/api/news/image/${id}`);
      expect(res.status).toBe(502);
      expect(res.headers["content-type"]).not.toMatch(/^image\//);
    }
  });

  it("502s a private or loopback address without calling fetch", async () => {
    for (const addrs of [[{ address: "10.0.0.7", family: 4 }], [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }], [{ address: "::1", family: 6 }], []]) {
      const fetch = vi.fn();
      const { client, id } = await setup({ fetch, lookup: vi.fn(async () => addrs) });
      expect((await client.get(`/api/news/image/${id}`)).status).toBe(502);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("502s non-https and IP-literal image URLs without a lookup or fetch", async () => {
    for (const imageUrl of ["http://img.example.invalid/zz.png", "https://10.0.0.7/zz.png", "https://[::1]/zz.png", "https://user:pw@img.example.invalid/zz.png", "https://localhost/zz.png", "ftp://img.example.invalid/zz.png", "https://img.example.invalid:22/zz.png", "https://img.example.invalid:8443/zz.png", "https://img.example.invalid./zz.png"]) {
      const fetch = vi.fn(); const lookup = vi.fn(async () => PUBLIC);
      const { client, id } = await setup({ imageUrl, fetch, lookup });
      expect((await client.get(`/api/news/image/${id}`)).status).toBe(502);
      expect(fetch).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
    }
  });

  it("502s a body past the 1 MB cap, declared or streamed", async () => {
    const big = new Uint8Array(IMAGE_PROXY_MAX_BYTES + 1);
    const declared = vi.fn(async () => new Response(PNG, { status: 200, headers: { "content-type": "image/png", "content-length": String(IMAGE_PROXY_MAX_BYTES + 1) } }));
    const a = await setup({ fetch: declared });
    expect((await a.client.get(`/api/news/image/${a.id}`)).status).toBe(502);
    const streamed = vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(big.subarray(0, 600_000)); c.enqueue(big.subarray(600_000)); c.close(); } }), { status: 200, headers: { "content-type": "image/jpeg" } }));
    const b = await setup({ fetch: streamed });
    expect((await b.client.get(`/api/news/image/${b.id}`)).status).toBe(502);
    expect(IMAGE_PROXY_MAX_BYTES).toBe(1024 * 1024);
  });

  it("502s an upstream error status and a fetch failure", async () => {
    for (const fetch of [vi.fn(async () => new Response("no", { status: 404 })), vi.fn(async () => { throw new Error("connect failed"); })]) {
      const { client, id } = await setup({ fetch });
      expect((await client.get(`/api/news/image/${id}`)).status).toBe(502);
    }
  });

  it("follows one redirect after re-checking it, and refuses a second or a private target", async () => {
    const ok = () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    const to = (location: string) => new Response(null, { status: 302, headers: { location } });
    const once = vi.fn().mockResolvedValueOnce(to("https://cdn.example.invalid/zz.png")).mockResolvedValueOnce(ok());
    const a = await setup({ fetch: once });
    expect((await a.client.get(`/api/news/image/${a.id}`)).status).toBe(200);
    expect(once.mock.calls.map((c) => c[0])).toEqual(["https://img.example.invalid/zz.png", "https://cdn.example.invalid/zz.png"]);
    expect(a.lookup).toHaveBeenCalledWith("cdn.example.invalid");

    const twice = vi.fn().mockResolvedValueOnce(to("https://cdn.example.invalid/1.png")).mockResolvedValueOnce(to("https://cdn.example.invalid/2.png")).mockResolvedValue(ok());
    const b = await setup({ fetch: twice });
    expect((await b.client.get(`/api/news/image/${b.id}`)).status).toBe(502);
    expect(twice).toHaveBeenCalledTimes(2);

    const toPrivate = vi.fn().mockResolvedValueOnce(to("https://internal.example.invalid/zz.png")).mockResolvedValue(ok());
    const lookup = vi.fn(async (host: string) => (host === "internal.example.invalid" ? [{ address: "192.168.1.5", family: 4 }] : PUBLIC));
    const c = await setup({ fetch: toPrivate, lookup });
    expect((await c.client.get(`/api/news/image/${c.id}`)).status).toBe(502);
    expect(toPrivate).toHaveBeenCalledTimes(1);

    const toHttp = vi.fn().mockResolvedValueOnce(to("http://cdn.example.invalid/zz.png")).mockResolvedValue(ok());
    const d = await setup({ fetch: toHttp });
    expect((await d.client.get(`/api/news/image/${d.id}`)).status).toBe(502);
    expect(toHttp).toHaveBeenCalledTimes(1);
  });

  it("gives up after the timeout", async () => {
    const hang = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const { client, id } = await setup({ fetch: hang, timeoutMs: 50 });
    const started = Date.now();
    expect((await client.get(`/api/news/image/${id}`)).status).toBe(502);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("caps proxy fetches in flight (16 by default) and answers 503 when full", async () => {
    const release: Array<() => void> = [];
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { release.push(() => resolve(new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }))); }));
    const { client, id } = await setup({ fetch, maxInFlight: 2 });
    const first = client.get(`/api/news/image/${id}`).then((r) => r.status);
    const second = client.get(`/api/news/image/${id}`).then((r) => r.status);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect((await client.get(`/api/news/image/${id}`)).status).toBe(503);
    release.forEach((r) => r());
    expect(await Promise.all([first, second])).toEqual([200, 200]);
    expect(IMAGE_PROXY_MAX_IN_FLIGHT).toBe(16);
  });

  it("rate-limits per client IP (120 a minute by default)", async () => {
    const { client, id } = await setup({ rateLimit: 2 });
    expect((await client.get(`/api/news/image/${id}`)).status).toBe(200);
    expect((await client.get(`/api/news/image/${id}`)).status).toBe(200);
    expect((await client.get(`/api/news/image/${id}`)).status).toBe(429);
  });

  it("logs outcomes and counts only, never the publisher URL or the article id", async () => {
    const fetch = vi.fn(async () => new Response("x", { status: 200, headers: { "content-type": "text/html" } }));
    const { client, id, logs } = await setup({ fetch });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await client.get(`/api/news/image/${id}`);
    } finally {
      info.mockRestore(); warn.mockRestore();
    }
    expect(logs.length).toBeGreaterThan(0);
    const text = JSON.stringify([...logs, ...info.mock.calls, ...warn.mock.calls]);
    expect(text).not.toContain("img.example.invalid");
    expect(text).not.toContain(id);
    expect(logs[0]).toMatchObject({ event: "news_image_proxy", outcome: "not_image" });
  });
});
