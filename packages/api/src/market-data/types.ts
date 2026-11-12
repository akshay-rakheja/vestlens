export interface PricePoint { date: string; close: number }
export interface Quote { ticker: string; currency: string | null; price: number; previousClose: number | null; asOf: string }
/** A stock split effective on `date` (ex-date): one share before becomes `ratio` shares after. */
export interface SplitEvent { date: string; ratio: number }
/** Closes plus split events; `splits` is null when the provider carries no split information. */
/** `notFound`: the primary provider reports the ticker does not exist (e.g. delisted) — permanent, not an outage. */
export interface SecurityHistory { points: PricePoint[]; splits: SplitEvent[] | null; notFound?: true }
/** A security's per-share distributions by ex-date, split-adjusted by the provider; `currency` is the listing's. */
export interface SecurityDistributions { currency: string | null; events: Array<{ date: string; amount: number }> }
export interface PriceHistoryProvider {
  name: string;
  history(ticker: string, from: string, to: string): Promise<PricePoint[]>;
  /** Providers that report split events implement this; others are treated as having no split information. */
  historyWithSplits?(ticker: string, from: string, to: string): Promise<{ points: PricePoint[]; splits: SplitEvent[] }>;
  /** Providers with dividend events implement this. An empty list means none in range. */
  distributions?(ticker: string, from: string, to: string): Promise<SecurityDistributions>;
  /** Providers with intraday bars implement this; there is no fallback across providers. */
  intraday?(ticker: string, interval: "5m" | "1h"): Promise<IntradayBars>;
  /** Providers with security profiles implement this; returns null when unavailable (never throws). */
  profile?(ticker: string): Promise<SecurityProfile | null>;
}
/** Latest-session bars; `sessionDate` is the exchange-local date of the last bar. */
export interface IntradayBars { points: Array<{ t: string; price: number }>; sessionDate: string | null }
export interface QuoteProvider { name: string; quote(ticker: string): Promise<Quote> }
export interface FxProvider { usdCad(from: string, to: string): Promise<PricePoint[]> }
export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string>;
    /** Optional: only the Yahoo cookie flow reads response headers. */
    headers?: { get(name: string): string | null; getSetCookie?(): string[] } }>;
/** Public-security profile used for allocation; unknown fields are null, never guessed. */
export interface SecurityProfile {
  kind: "stock" | "fund" | "unknown";
  sector: string | null;
  country: string | null;
  sectorWeights: Record<string, number> | null;
  countryWeights: Record<string, number> | null;
  topHoldings: Array<{ symbol: string; weight: number }> | null;
}
export class MarketDataUnavailableError extends Error {
  constructor(readonly provider: string, readonly reason: string) { super(`${provider} market data unavailable: ${reason}`); this.name = "MarketDataUnavailableError"; }
}

// Runs one provider request under a deadline that covers the headers AND the body.
// Any failure that is not already a MarketDataUnavailableError is reported as "network".
async function guarded<T>(provider: string, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new MarketDataUnavailableError(provider, "timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } catch (error) {
    if (error instanceof MarketDataUnavailableError) throw error;
    throw new MarketDataUnavailableError(provider, "network");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOk(fetch: FetchLike, url: string, signal: AbortSignal, provider: string) {
  const response = await fetch(url, { signal, headers: { "user-agent": "vestlens/1.0" } });
  if (!response.ok) throw new MarketDataUnavailableError(provider, `http_${response.status}`);
  return response;
}

/** One GET under the deadline with no status check; the caller inspects status, body text and cookies. */
export function fetchRaw(fetch: FetchLike, url: string, timeoutMs: number, provider: string, headers: Record<string, string> = {}):
  Promise<{ status: number; text: string; cookies: string[] }> {
  return guarded(provider, timeoutMs, async (signal) => {
    const response = await fetch(url, { signal, headers: { "user-agent": "Mozilla/5.0", ...headers } });
    const h = response.headers;
    let raw = h?.getSetCookie?.() ?? [];
    if (!raw.length) {
      const joined = h?.get("set-cookie");
      raw = joined ? joined.split(/,(?=\s*[^;,=\s]+=)/) : [];
    }
    const cookies = raw.map((c) => c.split(";")[0].trim()).filter((c) => c.includes("="));
    return { status: response.status, text: await response.text().catch(() => ""), cookies };
  });
}

export function fetchText(fetch: FetchLike, url: string, timeoutMs: number, provider: string): Promise<string> {
  return guarded(provider, timeoutMs, async (signal) => (await fetchOk(fetch, url, signal, provider)).text());
}

export function fetchJson(fetch: FetchLike, url: string, timeoutMs: number, provider: string): Promise<unknown> {
  return guarded(provider, timeoutMs, async (signal) => {
    const response = await fetchOk(fetch, url, signal, provider);
    try {
      return await response.json();
    } catch {
      throw new MarketDataUnavailableError(provider, "malformed");
    }
  });
}

// Parses a provider-reported price or rate; blank, non-numeric and non-positive values are rejected.
export function positiveNumber(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export const isoDay = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString().slice(0, 10);
