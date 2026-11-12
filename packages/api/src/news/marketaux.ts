import { createHash } from "node:crypto";
import { fetchJson, MarketDataUnavailableError, type FetchLike } from "../market-data/types.js";
import type { StoredArticle } from "./store.js";

export type NewArticle = Omit<StoredArticle, "id">;

/** `raw` when it parses as an absolute http(s) URL, else null (drops javascript:, data:, relative and garbage). */
export function httpUrlOrNull(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const p = new URL(raw).protocol;
    return p === "http:" || p === "https:" ? raw : null;
  } catch {
    return null;
  }
}
/**
 * `requests`: provider requests actually made (callers charge the budget with this). `limit`: "daily" when the
 * provider's daily quota is gone (402 / usage_limit_reached), "throttle" for a transient limit (429 /
 * rate_limit_reached), null otherwise.
 */
export interface NewsFetchResult { articles: NewArticle[]; rateLimited: boolean; requests?: number; limit?: "daily" | "throttle" | null }
/** Per-call paging: `pageSize` is the Marketaux `limit`, `maxPages` caps pages per alias. */
export interface NewsFetchOptions { pageSize?: number; maxPages?: number }
export interface NewsFetcher { fetchForSymbol(symbol: string, since: Date, options?: NewsFetchOptions): Promise<NewsFetchResult> }

const PROVIDER = "marketaux";
const TIMEOUT_MS = 10_000;
const MAX_PAGES = 3;
const SNIPPET_MAX = 200;
const LIMIT_CODES: Record<string, "daily" | "throttle"> = { usage_limit_reached: "daily", rate_limit_reached: "throttle" };
const LIMIT_REASONS: Record<string, "daily" | "throttle"> = { http_402: "daily", http_429: "throttle" };

/** Cross-listed Canadian names: Marketaux indexes them under the US symbol (Task 0 finding). */
const STATIC_ALIASES: Record<string, string> = {
  RY: "RY", TD: "TD", BNS: "BNS", BMO: "BMO", CM: "CM", SHOP: "SHOP", ENB: "ENB", CNQ: "CNQ", SU: "SU", CP: "CP",
  CNR: "CNI", BAM: "BAM", BN: "BN", MFC: "MFC", SLF: "SLF", NTR: "NTR", TRI: "TRI", WCN: "WCN", ABX: "GOLD",
  OTEX: "OTEX", TECK: "TECK", CVE: "CVE", IMO: "IMO", FTS: "FTS", TRP: "TRP", PPL: "PBA", CCO: "CCJ", BCE: "BCE",
  T: "TU", QSR: "QSR", "GIB.A": "GIB", WPM: "WPM", FNV: "FNV", AEM: "AEM",
};

export function symbolAliases(symbol: string, known?: { usSymbol?: string | null }): string[] {
  const m = /^(.+)\.(TO|V)$/i.exec(symbol);
  if (!m) return [symbol];
  const us = known?.usSymbol ?? STATIC_ALIASES[m[1].toUpperCase()];
  return us && us !== symbol ? [symbol, us] : [symbol];
}

export function hashUrl(raw: string): string {
  let cleaned = raw;
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (k.toLowerCase().startsWith("utm_")) u.searchParams.delete(k);
    cleaned = u.toString();
  } catch { /* hash the raw string */ }
  return createHash("sha256").update(cleaned.replace(/\/+$/, "")).digest("hex");
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

export function marketauxFetcher(o: {
  apiKey: string;
  fetch: FetchLike;
  now?: () => Date;
  /** Marketaux `limit`: 20 on paid plans, 3 on free. */
  pageSize?: number;
  /** Known US symbol for a held symbol (e.g. from provider metadata). */
  known?: (symbol: string) => string | null | undefined;
}): NewsFetcher {
  const now = o.now ?? (() => new Date());
  const pageSize = o.pageSize ?? 20;
  return {
    async fetchForSymbol(symbol, since, options = {}) {
      const limitSize = options.pageSize ?? pageSize;
      const maxPages = Math.min(options.maxPages ?? MAX_PAGES, MAX_PAGES);
      const byHash = new Map<string, NewArticle>();
      const fetchedAt = now();
      let requests = 0;
      try {
        for (const alias of symbolAliases(symbol, { usSymbol: o.known?.(symbol) })) {
          for (let page = 1; page <= maxPages; page++) {
            const params = new URLSearchParams({
              symbols: alias, filter_entities: "true", language: "en",
              published_after: since.toISOString().slice(0, 19), limit: String(limitSize), page: String(page),
              api_token: o.apiKey,
            });
            requests++;
            const body = (await fetchJson(o.fetch, `https://api.marketaux.com/v1/news/all?${params}`, TIMEOUT_MS, PROVIDER)) as
              { data?: unknown; error?: { code?: string } } | null;
            const code = body?.error?.code;
            if (code && Object.hasOwn(LIMIT_CODES, code)) return { articles: [...byHash.values()], rateLimited: true, requests, limit: LIMIT_CODES[code] };
            const data = Array.isArray(body?.data) ? (body!.data as Array<Record<string, unknown>>) : [];
            for (const d of data) {
              const url = httpUrlOrNull(str(d.url)), title = str(d.title), published = str(d.published_at);
              if (!url || !title || !published) continue;
              const publishedAt = new Date(published);
              if (Number.isNaN(publishedAt.getTime())) continue;
              const entities = Array.isArray(d.entities) ? (d.entities as Array<{ symbol?: unknown }>) : [];
              const symbols = new Set<string>([symbol]);
              for (const e of entities) if (typeof e?.symbol === "string" && e.symbol) symbols.add(e.symbol.toUpperCase());
              const urlHash = hashUrl(url);
              const prior = byHash.get(urlHash);
              if (prior) { prior.symbols = [...new Set([...prior.symbols, ...symbols])]; continue; }
              byHash.set(urlHash, {
                urlHash, url, headline: title,
                snippet: (str(d.snippet) ?? str(d.description))?.slice(0, SNIPPET_MAX) ?? null,
                source: str(d.source) ?? "unknown", imageUrl: httpUrlOrNull(str(d.image_url)), publishedAt,
                symbols: [...symbols], fetchedAt,
              });
            }
            if (data.length < limitSize) break;
          }
        }
      } catch (error) {
        if (error instanceof MarketDataUnavailableError && Object.hasOwn(LIMIT_REASONS, error.reason)) {
          return { articles: [...byHash.values()], rateLimited: true, requests, limit: LIMIT_REASONS[error.reason] };
        }
        // fetchJson errors carry only provider and reason; never echo the url (it holds api_token).
        throw new MarketDataUnavailableError(PROVIDER, error instanceof MarketDataUnavailableError ? error.reason : "network");
      }
      return { articles: [...byHash.values()], rateLimited: false, requests, limit: null };
    },
  };
}
