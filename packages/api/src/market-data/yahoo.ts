import { z } from "zod";
import { fetchRaw, fetchJson, isoDay, MarketDataUnavailableError, type FetchLike, type IntradayBars, type PricePoint, type PriceHistoryProvider, type Quote, type QuoteProvider, type SecurityDistributions, type SecurityProfile, type SplitEvent } from "./types.js";

const chartSchema = z.object({ chart: z.object({ result: z.array(z.object({
  meta: z.looseObject({ currency: z.string().nullable().optional(), regularMarketPrice: z.number(), previousClose: z.number().nullable().optional(), chartPreviousClose: z.number().nullable().optional(), regularMarketTime: z.number().optional(), exchangeTimezoneName: z.string().optional() }),
  timestamp: z.array(z.number()).optional(),
  indicators: z.object({ quote: z.array(z.object({ close: z.array(z.number().nullable()) })) }),
  events: z.looseObject({
    splits: z.record(z.string(), z.looseObject({ date: z.number(), numerator: z.number().optional(), denominator: z.number().optional() })).optional(),
    dividends: z.record(z.string(), z.looseObject({ date: z.number(), amount: z.number().optional() })).optional(),
  }).optional(),
})).min(1) }) });

const PROFILE_TIMEOUT_MS = 5_000;
const CRUMB_TTL_MS = 3_600_000;

const SECTOR_LABELS: Record<string, string> = {
  realestate: "Real estate", consumer_cyclical: "Consumer cyclical", basic_materials: "Basic materials",
  consumer_defensive: "Consumer defensive", technology: "Technology", communication_services: "Communication services",
  financial_services: "Financial services", utilities: "Utilities", industrials: "Industrials", energy: "Energy", healthcare: "Healthcare",
};

/** Maps Yahoo snake_case keys and display-cased names ("Financial Services") to one display label. */
export function sectorLabel(name: string): string {
  const key = name.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (SECTOR_LABELS[key]) return SECTOR_LABELS[key];
  const text = key.replace(/_/g, " ");
  return text ? text[0].toUpperCase() + text.slice(1) : name;
}

const raw = (v: unknown): number | null => {
  const n = v && typeof v === "object" ? (v as { raw?: unknown }).raw : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// Yahoo lists weights as an array of single-key objects; keys are folded through `label`.
function weightMap(list: unknown, label: (k: string) => string): Record<string, number> | null {
  if (!Array.isArray(list)) return null;
  const out: Record<string, number> = {};
  for (const entry of list) {
    for (const [k, v] of Object.entries(obj(entry))) {
      const w = raw(v);
      if (w !== null && w > 0) out[label(k)] = (out[label(k)] ?? 0) + w;
    }
  }
  return Object.keys(out).length ? out : null;
}

export function parseQuoteSummary(body: unknown): SecurityProfile | null {
  const results = obj(obj(body).quoteSummary).result;
  if (!Array.isArray(results) || results.length === 0) return null;
  const result = obj(results[0]);
  const asset = obj(result.assetProfile);
  const fund = obj(result.fundProfile);
  const top = obj(result.topHoldings);
  const sectorWeights = weightMap(top.sectorWeightings, sectorLabel);
  const countryWeights = weightMap(top.countryWeightings ?? fund.countryWeightings, (k) => k);
  const holdings = Array.isArray(top.holdings)
    ? top.holdings.flatMap((h) => {
        const symbol = str(obj(h).symbol);
        const weight = raw(obj(h).holdingPercent);
        return symbol && weight !== null && weight > 0 ? [{ symbol, weight }] : [];
      })
    : [];
  const isFund = Object.keys(fund).length > 0 || sectorWeights !== null || holdings.length > 0 || Array.isArray(top.sectorWeightings);
  const sector = str(asset.sector);
  return {
    kind: isFund ? "fund" : sector ? "stock" : "unknown",
    sector: sector ? sectorLabel(sector) : null,
    country: str(asset.country),
    sectorWeights, countryWeights,
    topHoldings: holdings.length ? holdings : null,
  };
}

function sessionDay(epochSeconds: number, timeZone: string | undefined): string {
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epochSeconds * 1000));
    } catch {
      // An unknown zone falls back to UTC.
    }
  }
  return isoDay(epochSeconds);
}

export class YahooChartProvider implements PriceHistoryProvider, QuoteProvider {
  readonly name = "yahoo";
  private session: Promise<{ crumb: string; cookie: string; expiresAt: number } | null> | null = null;
  constructor(private readonly fetch: FetchLike, private readonly timeoutMs = 8_000, private readonly clock: () => number = Date.now) {}

  // fc.yahoo.com answers 404 but sets the cookie; any response carrying a cookie counts. Null on any failure.
  private async openSession(): Promise<{ crumb: string; cookie: string; expiresAt: number } | null> {
    const first = await fetchRaw(this.fetch, "https://fc.yahoo.com", PROFILE_TIMEOUT_MS, this.name);
    if (!first.cookies.length) return null;
    const cookie = first.cookies.join("; ");
    const crumb = await fetchRaw(this.fetch, "https://query1.finance.yahoo.com/v1/test/getcrumb", PROFILE_TIMEOUT_MS, this.name, { cookie });
    const value = crumb.text.trim();
    if (crumb.status !== 200 || !value || value.length > 64 || /[\s<{]/.test(value)) return null;
    return { crumb: value, cookie, expiresAt: this.clock() + CRUMB_TTL_MS };
  }

  /** Public-ticker profile; null when the crumb flow or request fails. Never throws, never logs. */
  async profile(ticker: string): Promise<SecurityProfile | null> {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        // One in-flight session promise is shared by concurrent callers; failures and expiry clear it.
        let pending = this.session;
        let session = pending ? await pending : null;
        if (!pending || (session && session.expiresAt <= this.clock())) {
          // Only the first caller to see the stale (or missing) session replaces it; others join the new one.
          if (this.session === pending) this.session = this.openSession().catch(() => null);
          pending = this.session!;
          session = await pending;
        }
        if (!session) {
          if (this.session === pending) this.session = null;
          return null;
        }
        const current = pending;
        const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=assetProfile,fundProfile,topHoldings&crumb=${encodeURIComponent(session.crumb)}`;
        const res = await fetchRaw(this.fetch, url, PROFILE_TIMEOUT_MS, this.name, { cookie: session.cookie });
        if (res.status === 401) {
          if (this.session === current) this.session = null; // refresh the crumb once, then give up
          continue;
        }
        if (res.status !== 200) return null;
        return parseQuoteSummary(JSON.parse(res.text));
      }
      return null;
    } catch {
      return null;
    }
  }

  private async chart(ticker: string, query: string) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${query}`;
    const parsed = chartSchema.safeParse(await fetchJson(this.fetch, url, this.timeoutMs, this.name));
    if (!parsed.success) throw new MarketDataUnavailableError(this.name, "malformed");
    return parsed.data.chart.result[0];
  }

  /** Daily closes (split-adjusted by Yahoo) plus split events in range; `events=split` adds only the events. */
  async historyWithSplits(ticker: string, from: string, to: string): Promise<{ points: PricePoint[]; splits: SplitEvent[] }> {
    const period1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
    const period2 = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000);
    const result = await this.chart(ticker, `period1=${period1}&period2=${period2}&interval=1d&events=split`);
    const closes = result.indicators.quote[0]?.close ?? [];
    const points = (result.timestamp ?? []).flatMap((ts, i) => (closes[i] == null ? [] : [{ date: isoDay(ts), close: closes[i]! }]));
    const splits = Object.values(result.events?.splits ?? {}).flatMap((e) => {
      const ratio = (e.numerator ?? NaN) / (e.denominator ?? NaN);
      return Number.isFinite(ratio) && ratio > 0 ? [{ date: isoDay(e.date), ratio }] : [];
    }).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { points, splits };
  }

  /**
   * Per-share dividends by ex-date in range, which Yahoo reports split-adjusted, with the chart's currency: the
   * listing's (CAD for a .TO line; GBp for a London one), not always the currency a broker pays in.
   */
  async distributions(ticker: string, from: string, to: string): Promise<SecurityDistributions> {
    const period1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
    const period2 = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000);
    const result = await this.chart(ticker, `period1=${period1}&period2=${period2}&interval=1d&events=div,split`);
    const events = Object.values(result.events?.dividends ?? {}).flatMap((e) => (typeof e.amount === "number" && Number.isFinite(e.amount) && e.amount > 0 ? [{ date: isoDay(e.date), amount: e.amount }] : []))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { currency: result.meta.currency ?? null, events };
  }

  async history(ticker: string, from: string, to: string): Promise<PricePoint[]> {
    return (await this.historyWithSplits(ticker, from, to)).points;
  }

  /** Intraday bars for the latest session (`range=1d`); null closes are dropped. */
  async intraday(ticker: string, interval: "5m" | "1h"): Promise<IntradayBars> {
    const result = await this.chart(ticker, `range=1d&interval=${interval}`);
    const closes = result.indicators.quote[0]?.close ?? [];
    const raw = (result.timestamp ?? []).flatMap((ts, i) => (closes[i] == null ? [] : [{ ts, price: closes[i]! }]));
    const points = raw.map(({ ts, price }) => ({ t: new Date(ts * 1000).toISOString(), price }));
    const last = raw.at(-1);
    return { points, sessionDate: last ? sessionDay(last.ts, result.meta.exchangeTimezoneName) : null };
  }

  async quote(ticker: string): Promise<Quote> {
    const result = await this.chart(ticker, "range=5d&interval=1d");
    const closes = result.indicators.quote[0]?.close ?? [];
    // The previous close is the last non-null bar strictly before the final bar index.
    let penultimate: number | null = null;
    for (let i = closes.length - 2; i >= 0 && penultimate === null; i--) penultimate = closes[i] ?? null;
    const previousClose = result.meta.previousClose ?? penultimate;
    return { ticker, currency: result.meta.currency ?? null, price: result.meta.regularMarketPrice, previousClose,
      asOf: new Date((result.meta.regularMarketTime ?? Date.now() / 1000) * 1000).toISOString() };
  }
}
