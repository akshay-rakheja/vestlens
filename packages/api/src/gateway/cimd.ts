/**
 * Client ID Metadata Document (CIMD) resolver.
 *
 * A client_id that is an https URL is dereferenced to a JSON metadata document
 * whose own `client_id` must equal that URL. Fetching attacker-chosen URLs is
 * an SSRF surface, so:
 *
 * - the URL must be https, on the default port, with a DNS host name (no IP
 *   literals, no `localhost`), no userinfo/fragment and in canonical form;
 * - every address the host resolves to is vetted by `isBlockedAddress`, and
 *   one blocked address rejects the whole lookup *before* fetch is called;
 * - redirects are never followed (any 3xx is rejected), the whole exchange has
 *   a 5 s deadline, the body is streamed with a 64 KB cap, and the content type
 *   must be application/json.
 *
 * DNS rebinding (TOCTOU between our lookup and the connection's lookup) is
 * closed in production by `createPinnedHttpsFetch`, whose socket `lookup`
 * re-resolves and re-vets at connect time and hands the socket only vetted
 * addresses: the address actually connected to is always one that passed the
 * guard. See task-3-report.md.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

import { VERIFIED_HOSTS, validateClientMetadata, type ResolvedClient } from "./clients.js";
import { isBlockedAddress } from "./ip.js";
import type { GatewayStore } from "./store.js";

export { isBlockedAddress };

export type CimdLookup = (host: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export const CIMD_MAX_BYTES = 64 * 1024;
export const CIMD_TIMEOUT_MS = 5_000;
const MIN_FRESH_S = 5 * 60;
const MAX_FRESH_S = 24 * 60 * 60;
const STALE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_URL_LENGTH = 2048;
export const CIMD_NEGATIVE_TTL_MS = 60 * 1000;
export const CIMD_MAX_CONCURRENT = 8;
const NEGATIVE_CACHE_MAX = 10_000;

// ------------------------------------------------------------- production IO

export const systemLookup: CimdLookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

/**
 * A socket `lookup` (net/tls/https option) that resolves through `lookup`,
 * vets every address, and hands the socket only vetted addresses. Supports
 * both the single-address and the `{ all: true }` (autoSelectFamily) shapes.
 */
export function pinnedLookup(lookup: CimdLookup = systemLookup) {
  return (hostname: string, options: LookupOptions | number | undefined, callback: LookupCallback): void => {
    const opts: LookupOptions = typeof options === "object" && options !== null ? options : {};
    lookup(hostname).then(
      (addrs) => {
        if (addrs.length === 0 || addrs.some((a) => isBlockedAddress(a.address))) {
          const err: NodeJS.ErrnoException = new Error("CIMD host resolved to a blocked address");
          err.code = "ECIMDBLOCKED";
          callback(err);
          return;
        }
        const wanted = opts.family === 4 || opts.family === 6 ? addrs.filter((a) => a.family === opts.family) : addrs;
        if (wanted.length === 0) {
          const err: NodeJS.ErrnoException = new Error("no address for requested family");
          err.code = "ENOTFOUND";
          callback(err);
          return;
        }
        if (opts.all) callback(null, wanted.map((a) => ({ address: a.address, family: a.family })));
        else callback(null, wanted[0]!.address, wanted[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err),
    );
  };
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/**
 * Production fetch for CIMD: node:https (undici is not a dependency, and the
 * global fetch offers no per-request DNS hook). The socket's DNS lookup is
 * `pinnedLookup`, so the connected address is always a vetted one; TLS SNI and
 * Host stay the original host name, so certificate verification is unchanged.
 * Never follows redirects; honours `init.signal`; uses a fresh agent (no
 * pooled sockets) per request.
 */
export function createPinnedHttpsFetch(lookup: CimdLookup = systemLookup): typeof fetch {
  const pinned = pinnedLookup(lookup);
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      } catch (e) {
        reject(e);
        return;
      }
      // net skips `lookup` for IP literals, so they must never reach the socket.
      if (url.protocol !== "https:" || url.hostname.startsWith("[") || isIP(url.hostname) !== 0) {
        reject(new TypeError("pinned fetch accepts https URLs with DNS host names only"));
        return;
      }
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      const req = https.request(
        url,
        {
          method: "GET",
          headers,
          lookup: pinned as unknown as https.RequestOptions["lookup"],
          agent: false,
          signal: init?.signal ?? undefined,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const h = new Headers();
          for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) h.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
          try {
            if (NULL_BODY_STATUS.has(status)) {
              res.resume();
              resolve(new Response(null, { status, headers: h }));
            } else {
              resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers: h }));
            }
          } catch (e) {
            res.destroy();
            reject(e);
          }
        },
      );
      req.on("error", reject);
      req.end();
    });
  return impl as typeof fetch;
}

// ------------------------------------------------------------------ resolver

/** Returns the parsed URL when `raw` is an acceptable CIMD client_id, else null. */
export function parseCimdUrl(raw: string): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.href !== raw) return null; // canonical only: no dot segments, case or numeric-host tricks
  if (u.protocol !== "https:" || u.port !== "") return null;
  if (u.username !== "" || u.password !== "" || u.hash !== "" || raw.includes("#")) return null;
  const host = u.hostname;
  if (host.startsWith("[") || isIP(host) !== 0) return null;
  if (!host.includes(".") || host.endsWith(".")) return null; // no single-label or trailing-dot (FQDN-root) hosts
  if (host === "localhost" || host.endsWith(".localhost")) return null;
  if (u.pathname === "/" || u.pathname === "") return null;
  return u;
}

function maxAgeSeconds(cacheControl: string | null): number {
  const m = cacheControl ? /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?:,|$)/i.exec(cacheControl) : null;
  const raw = m ? Number(m[1]) : 0;
  return Math.min(MAX_FRESH_S, Math.max(MIN_FRESH_S, Number.isFinite(raw) ? raw : 0));
}

function isJsonContentType(ct: string | null): boolean {
  if (!ct) return false;
  return ct.split(";")[0]!.trim().toLowerCase() === "application/json";
}

class Aborted extends Error {}

/** The connect-time guard (`pinnedLookup`) refused the address: a policy failure, never transient. */
function isBlockedError(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && typeof cur === "object" && depth < 5; depth += 1) {
    if ((cur as { code?: unknown }).code === "ECIMDBLOCKED") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

function withAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** `transient` failures may fall back to a stale cache entry; policy failures never do. */
type FetchOutcome = { ok: true; document: unknown; maxAge: number } | { ok: false; transient: boolean };

const POLICY: FetchOutcome = { ok: false, transient: false };
const TRANSIENT: FetchOutcome = { ok: false, transient: true };

export class CimdResolver {
  private readonly store: GatewayStore;
  private readonly fetchFn: typeof fetch;
  private readonly lookup: CimdLookup;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  /** Single-flight: one resolution per URL at a time. */
  private readonly inFlight = new Map<string, Promise<ResolvedClient | null>>();
  /** Failed URLs → { until, transient }. In-memory, bounded, 60 s. */
  private readonly negative = new Map<string, { untilMs: number; transient: boolean }>();
  private active = 0;

  constructor(o: {
    store: GatewayStore;
    fetch: typeof fetch;
    lookup: CimdLookup;
    now?: () => Date;
    /** Test hook; defaults to 5 s. */
    timeoutMs?: number;
    /** Global cap on concurrent CIMD fetches; defaults to 8. Saturated → null. */
    maxConcurrent?: number;
  }) {
    this.store = o.store;
    this.fetchFn = o.fetch;
    this.lookup = o.lookup;
    this.now = o.now ?? (() => new Date());
    this.timeoutMs = o.timeoutMs ?? CIMD_TIMEOUT_MS;
    this.maxConcurrent = o.maxConcurrent ?? CIMD_MAX_CONCURRENT;
  }

  resolve(url: string): Promise<ResolvedClient | null> {
    const target = parseCimdUrl(url);
    if (!target) return Promise.resolve(null);
    const pending = this.inFlight.get(url);
    if (pending) return pending;
    const p = this.resolveOnce(target, url).finally(() => {
      this.inFlight.delete(url);
    });
    this.inFlight.set(url, p);
    return p;
  }

  private async resolveOnce(target: URL, url: string): Promise<ResolvedClient | null> {
    const cached = await this.store.getCimd(url);
    if (cached && this.now() < cached.freshUntil) {
      const fromCache = toResolvedClient(target, url, cached.document);
      if (fromCache) return fromCache;
    }

    const stale = () =>
      cached && this.now() < cached.staleUntil ? toResolvedClient(target, url, cached.document) : null;

    const neg = this.negative.get(url);
    if (neg && this.now().getTime() < neg.untilMs) return neg.transient ? stale() : null;

    if (this.active >= this.maxConcurrent) return stale(); // saturated: no fetch, not negatively cached
    this.active += 1;
    let outcome: FetchOutcome;
    try {
      outcome = await this.fetchDocument(target, url);
    } finally {
      this.active -= 1;
    }
    if (outcome.ok) {
      this.negative.delete(url);
      const validated = validateCimd(target, url, outcome.document);
      if (!validated) return null;
      const { client, stored } = validated;
      const fetchedAt = this.now();
      const freshUntil = new Date(fetchedAt.getTime() + outcome.maxAge * 1000);
      try {
        await this.store.putCimd(url, {
          document: stored,
          fetchedAt,
          freshUntil,
          staleUntil: new Date(freshUntil.getTime() + STALE_WINDOW_MS),
        });
      } catch {
        // Caching is an optimisation; a store failure must not fail resolution.
      }
      return client;
    }
    this.rememberFailure(url, outcome.transient);
    return outcome.transient ? stale() : null;
  }

  private rememberFailure(url: string, transient: boolean): void {
    this.negative.delete(url);
    while (this.negative.size >= NEGATIVE_CACHE_MAX) {
      const oldest = this.negative.keys().next().value;
      if (oldest === undefined) break;
      this.negative.delete(oldest);
    }
    this.negative.set(url, { untilMs: this.now().getTime() + CIMD_NEGATIVE_TTL_MS, transient });
  }

  private async fetchDocument(target: URL, url: string): Promise<FetchOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("CIMD fetch timed out")), this.timeoutMs);
    const signal = controller.signal;
    try {
      let addrs: Array<{ address: string; family: 4 | 6 }>;
      try {
        addrs = await withAbort(this.lookup(target.hostname), signal);
      } catch {
        return TRANSIENT;
      }
      if (!Array.isArray(addrs) || addrs.length === 0) return POLICY;
      if (addrs.some((a) => isBlockedAddress(a.address))) return POLICY;

      let res: Response;
      try {
        res = await withAbort(
          this.fetchFn(url, {
            method: "GET",
            redirect: "manual",
            signal,
            credentials: "omit",
            cache: "no-store",
            headers: { accept: "application/json" },
          }),
          signal,
        );
      } catch (e) {
        return isBlockedError(e) ? POLICY : TRANSIENT;
      }

      const discard = () => {
        res.body?.cancel().catch(() => undefined);
      };
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        discard();
        return POLICY;
      }
      if (res.status >= 500 || res.status === 429) {
        discard();
        return TRANSIENT;
      }
      if (res.status < 200 || res.status >= 300) {
        discard();
        return POLICY;
      }
      if (!isJsonContentType(res.headers.get("content-type"))) {
        discard();
        return POLICY;
      }
      const declared = res.headers.get("content-length");
      if (declared !== null && !(Number(declared) <= CIMD_MAX_BYTES)) {
        discard();
        return POLICY;
      }

      let text: string | null;
      try {
        text = await readCapped(res, signal);
      } catch {
        return TRANSIENT;
      }
      if (text === null) return POLICY;

      let document: unknown;
      try {
        document = JSON.parse(text);
      } catch {
        return POLICY;
      }
      if (!toResolvedClient(target, url, document)) return POLICY;
      return { ok: true, document, maxAge: maxAgeSeconds(res.headers.get("cache-control")) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Reads at most CIMD_MAX_BYTES; returns null (and cancels the stream) past the cap. */
async function readCapped(res: Response, signal: AbortSignal): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > CIMD_MAX_BYTES) {
        reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch (e) {
    reader.cancel().catch(() => undefined);
    throw e;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

function toResolvedClient(target: URL, url: string, document: unknown): ResolvedClient | null {
  return validateCimd(target, url, document)?.client ?? null;
}

/**
 * Validates a CIMD document. `stored` is the validated subset that is cached
 * (never the raw document): it re-validates to the same client.
 */
function validateCimd(target: URL, url: string, document: unknown): { client: ResolvedClient; stored: Record<string, unknown> } | null {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return null;
  if ((document as { client_id?: unknown }).client_id !== url) return null;
  const meta = validateClientMetadata(document, { allowedAuthMethods: ["none"], mode: "cimd" });
  if (!meta.ok) return null;
  const v = meta.value;
  return {
    client: {
      clientKey: url,
      kind: "cimd",
      name: v.clientName ?? target.hostname,
      redirectUris: v.redirectUris,
      tokenEndpointAuthMethod: "none",
      grantTypes: v.grantTypes,
      clientSecretHash: null,
      verifiedHost: VERIFIED_HOSTS.includes(target.hostname),
    },
    stored: {
      client_id: url,
      ...(v.clientName !== null ? { client_name: v.clientName } : {}),
      redirect_uris: [...v.redirectUris],
      grant_types: [...v.grantTypes],
      response_types: [...v.responseTypes],
      token_endpoint_auth_method: "none",
    },
  };
}
