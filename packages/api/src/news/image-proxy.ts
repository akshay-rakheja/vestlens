// GET /api/news/image/:articleId — thumbnails for the news widget without exposing publisher image URLs.
// Unauthenticated (widgets load <img> without a token) but it only serves ids that exist in the store and
// carry an image. Fetching a publisher-chosen URL is an SSRF surface, so it reuses the CIMD guard: https only,
// DNS host names only, every resolved address vetted by isBlockedAddress before fetch, the production fetch
// pins the connection to vetted addresses (createPinnedHttpsFetch), at most one redirect (re-checked), a 5 s
// deadline, a 1 MB streamed cap, at most 16 fetches in flight and raster image types only (SVG can carry
// script). Image bytes are never stored (the 24 h cache is the client's); only the publisher's image URL is,
// because proxying needs it. Logs carry outcomes only.
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import express from "express";

import type { CimdLookup } from "../gateway/cimd.js";
import { isBlockedAddress, rateLimitKeyForIp } from "../gateway/ip.js";
import { SlidingWindowLimiter } from "../gateway/rate-limit.js";
import type { NewsStore } from "./store.js";

export const IMAGE_PROXY_PATH = "/api/news/image/:articleId";
export const IMAGE_PROXY_MAX_BYTES = 1024 * 1024;
export const IMAGE_PROXY_TIMEOUT_MS = 5_000;
export const IMAGE_PROXY_RATE_PER_MINUTE = 120;
/** Global cap on concurrent upstream fetches (each may buffer up to 1 MB); past it the proxy answers 503. */
export const IMAGE_PROXY_MAX_IN_FLIGHT = 16;
const MAX_REDIRECTS = 1;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/jpg", "image/pjpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

/** A WHATWG-fetch-shaped function; production passes `createPinnedHttpsFetch(systemLookup)`. */
export type ImageFetch = (url: string, init: RequestInit) => Promise<Response>;

type Outcome = "ok" | "not_found" | "rate_limited" | "busy" | "blocked" | "redirect" | "upstream_status" | "not_image" | "too_large" | "timeout" | "fetch_failed";

class ProxyFailure extends Error {
  constructor(readonly outcome: Outcome) { super(outcome); }
}

function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ProxyFailure("blocked");
  }
  const host = u.hostname;
  // The same host rules as parseCimdUrl: https on the default port, DNS host name only (no IP literal,
  // single-label, trailing-dot or localhost host), no userinfo.
  if (u.protocol !== "https:" || u.port !== "" || u.username !== "" || u.password !== "") throw new ProxyFailure("blocked");
  if (host === "" || host.startsWith("[") || isIP(host) !== 0) throw new ProxyFailure("blocked");
  if (!host.includes(".") || host.endsWith(".")) throw new ProxyFailure("blocked");
  if (host === "localhost" || host.endsWith(".localhost")) throw new ProxyFailure("blocked");
  return u;
}

function race<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ProxyFailure("timeout"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ProxyFailure("timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); }, (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

async function readCapped(res: Response, max: number, signal: AbortSignal): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await race(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new ProxyFailure("too_large");
      chunks.push(value);
    }
  } catch (e) {
    reader.cancel().catch(() => undefined);
    throw e instanceof ProxyFailure ? e : new ProxyFailure("fetch_failed");
  }
  return Buffer.concat(chunks);
}

export function imageProxyRouter(o: {
  store: Pick<NewsStore, "articleImageUrl">;
  fetch: ImageFetch;
  lookup: CimdLookup;
  timeoutMs?: number;
  maxBytes?: number;
  rateLimitPerMinute?: number;
  maxInFlight?: number;
  now?: () => number;
  log?: (e: object) => void;
}): express.Router {
  const timeoutMs = o.timeoutMs ?? IMAGE_PROXY_TIMEOUT_MS;
  const maxBytes = o.maxBytes ?? IMAGE_PROXY_MAX_BYTES;
  const now = o.now ?? (() => Date.now());
  const log = o.log ?? ((e: object) => console.info(JSON.stringify(e)));
  const limiter = new SlidingWindowLimiter([{ ms: 60_000, max: o.rateLimitPerMinute ?? IMAGE_PROXY_RATE_PER_MINUTE }]);
  const maxInFlight = o.maxInFlight ?? IMAGE_PROXY_MAX_IN_FLIGHT;
  let inFlight = 0;
  const router = express.Router();

  async function fetchImage(raw: string, signal: AbortSignal): Promise<{ type: string; body: Buffer }> {
    let url = checkUrl(raw);
    for (let hop = 0; ; hop += 1) {
      let addrs: Array<{ address: string }>;
      try {
        addrs = await race(o.lookup(url.hostname), signal);
      } catch (e) {
        throw e instanceof ProxyFailure ? e : new ProxyFailure("fetch_failed");
      }
      if (!Array.isArray(addrs) || addrs.length === 0 || addrs.some((a) => isBlockedAddress(a.address))) throw new ProxyFailure("blocked");
      let res: Response;
      try {
        res = await race(o.fetch(url.href, {
          method: "GET", redirect: "manual", signal, credentials: "omit", cache: "no-store",
          headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9" },
        }), signal);
      } catch (e) {
        throw e instanceof ProxyFailure ? e : new ProxyFailure("fetch_failed");
      }
      const discard = () => { res.body?.cancel().catch(() => undefined); };
      if (res.status >= 300 && res.status < 400) {
        discard();
        const location = res.headers.get("location");
        if (hop >= MAX_REDIRECTS || !location) throw new ProxyFailure("redirect");
        let next: string;
        try { next = new URL(location, url).href; } catch { throw new ProxyFailure("redirect"); }
        url = checkUrl(next);
        continue;
      }
      if (res.status < 200 || res.status >= 300) { discard(); throw new ProxyFailure("upstream_status"); }
      const type = (res.headers.get("content-type") ?? "").trim();
      if (!ALLOWED_TYPES.has(type.split(";")[0]!.trim().toLowerCase())) { discard(); throw new ProxyFailure("not_image"); }
      const declared = res.headers.get("content-length");
      if (declared !== null && !(Number(declared) <= maxBytes)) { discard(); throw new ProxyFailure("too_large"); }
      return { type, body: await readCapped(res, maxBytes, signal) };
    }
  }

  router.get(IMAGE_PROXY_PATH, async (req, res) => {
    const started = now();
    const done = (outcome: Outcome, status: number) => {
      if (outcome !== "ok") log({ event: "news_image_proxy", outcome, status, latencyMs: now() - started });
    };
    const key = createHash("sha256").update(rateLimitKeyForIp(req.ip ?? req.socket.remoteAddress ?? "")).digest("hex");
    if (!limiter.take(key, now())) {
      res.status(429).set("Retry-After", "60").json({ error: "rate_limited" });
      done("rate_limited", 429);
      return;
    }
    let raw: string | null;
    try {
      raw = await o.store.articleImageUrl(String(req.params.articleId ?? ""));
    } catch {
      raw = null;
    }
    if (!raw) {
      res.status(404).json({ error: "not_found" });
      done("not_found", 404);
      return;
    }
    if (inFlight >= maxInFlight) {
      res.status(503).set("Retry-After", "5").json({ error: "busy" });
      done("busy", 503);
      return;
    }
    inFlight += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const image = await fetchImage(raw, controller.signal);
      res.status(200).set({
        "Content-Type": image.type,
        "Content-Length": String(image.body.length),
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "cross-origin",
      }).end(image.body);
      done("ok", 200);
    } catch (e) {
      const outcome = e instanceof ProxyFailure ? e.outcome : "fetch_failed";
      res.status(502).json({ error: "image_unavailable" });
      done(outcome, 502);
    } finally {
      clearTimeout(timer);
      inFlight -= 1;
    }
  });
  return router;
}
