import { fetchJson, MarketDataUnavailableError, type FetchLike } from "../market-data/types.js";
import { hashUrl, httpUrlOrNull, type NewArticle, type NewsFetcher } from "./marketaux.js";

const PROVIDER = "edgar";
const TIMEOUT_MS = 10_000;
const MIN_INTERVAL_MS = 100; // <= 10 req/s
const TICKER_TTL_MS = 24 * 3_600_000;
const FORMS = new Set(["8-K", "6-K"]);
/** Periodic reports whose filing dates anchor the earnings projection. */
const PERIODIC_FORMS = new Set(["10-Q", "10-K"]);
const FILINGS_TTL_MS = 24 * 3_600_000;
/** A submissions read is reused by filingDates for this long (longer than one nightly run). */
const SUBMISSIONS_REUSE_MS = 15 * 60_000;
const NON_US = /\.(TO|V)$/i;

/** EDGAR fetcher plus the 10-Q/10-K filing dates used by the calendar projection. */
export interface EdgarFetcher extends NewsFetcher {
  /** Ascending UTC-midnight 10-Q/10-K filing dates; [] for non-US or unknown tickers; cached 24 h per symbol. Throws on errors. */
  filingDates(symbol: string): Promise<Date[]>;
}

export function edgarFetcher(o: { userAgent: string; fetch: FetchLike; now?: () => Date }): EdgarFetcher {
  const now = o.now ?? (() => new Date());
  let nextSlot = 0;
  const paced: FetchLike = async (url, init) => {
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Date.now() + wait + MIN_INTERVAL_MS;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return o.fetch(url, { ...init, headers: { ...init?.headers, "user-agent": o.userAgent } });
  };
  let tickers: { at: number; map: Map<string, number> } | null = null;
  let loading: Promise<Map<string, number>> | null = null;
  const loadTickers = async (): Promise<Map<string, number>> => {
    if (tickers && now().getTime() - tickers.at < TICKER_TTL_MS) return tickers.map;
    loading ??= (async () => {
      try {
        const raw = (await fetchJson(paced, "https://www.sec.gov/files/company_tickers.json", TIMEOUT_MS, PROVIDER)) as
          Record<string, { cik_str?: number; ticker?: string }> | null;
        const map = new Map<string, number>();
        for (const v of Object.values(raw ?? {})) if (v?.ticker && typeof v.cik_str === "number") map.set(v.ticker.toUpperCase(), v.cik_str);
        tickers = { at: now().getTime(), map };
        return map;
      } finally { loading = null; }
    })();
    return loading;
  };

  const cikOf = async (symbol: string) => (await loadTickers()).get(symbol.toUpperCase().replace(/\./g, "-"));
  type Submissions = { filings?: { recent?: Record<string, unknown[]> } } | null;
  // fetchForSymbol always reads fresh; filingDates reuses that read for the rest of the run (one fetch per symbol).
  const recentSubmissions = new Map<number, { at: number; body: Submissions }>();
  const submissions = async (cik: number): Promise<Submissions> => {
    const body = (await fetchJson(paced, `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`, TIMEOUT_MS, PROVIDER)) as Submissions;
    recentSubmissions.set(cik, { at: now().getTime(), body });
    return body;
  };
  const reusedSubmissions = (cik: number): Promise<Submissions> => {
    const hit = recentSubmissions.get(cik);
    return hit && now().getTime() - hit.at < SUBMISSIONS_REUSE_MS ? Promise.resolve(hit.body) : submissions(cik);
  };
  const filings = new Map<string, { at: number; dates: Date[] }>();

  return {
    async filingDates(symbol) {
      const key = symbol.toUpperCase();
      if (NON_US.test(key)) return [];
      const hit = filings.get(key);
      if (hit && now().getTime() - hit.at < FILINGS_TTL_MS) return hit.dates.map((d) => new Date(d));
      const cik = await cikOf(key);
      let dates: Date[] = [];
      if (cik !== undefined) {
        const r = (await reusedSubmissions(cik))?.filings?.recent;
        const forms = r?.form ?? [];
        const days = new Set<number>();
        for (let i = 0; i < forms.length; i++) {
          if (!PERIODIC_FORMS.has(String(forms[i]))) continue;
          const day = String(r?.filingDate?.[i] ?? "");
          const t = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : Number.NaN;
          if (Number.isFinite(t)) days.add(t);
        }
        dates = [...days].sort((a, b) => a - b).map((t) => new Date(t));
      }
      filings.set(key, { at: now().getTime(), dates });
      return dates.map((d) => new Date(d));
    },
    async fetchForSymbol(symbol, since) {
      if (NON_US.test(symbol)) return { articles: [], rateLimited: false, requests: 0 };
      try {
        const cik = await cikOf(symbol);
        if (cik === undefined) return { articles: [], rateLimited: false };
        const sub = await submissions(cik);
        const r = sub?.filings?.recent;
        const forms = r?.form ?? [];
        const fetchedAt = now();
        const articles: NewArticle[] = [];
        for (let i = 0; i < forms.length; i++) {
          const form = String(forms[i]);
          if (!FORMS.has(form)) continue;
          const accession = String(r?.accessionNumber?.[i] ?? "");
          const stamp = String(r?.acceptanceDateTime?.[i] ?? "") || (r?.filingDate?.[i] ? `${r.filingDate[i]}T00:00:00Z` : "");
          const publishedAt = new Date(stamp);
          if (!accession || Number.isNaN(publishedAt.getTime()) || publishedAt < since) continue;
          const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, "")}/${accession}-index.htm`;
          if (!httpUrlOrNull(url)) continue;
          articles.push({
            urlHash: hashUrl(url), url, headline: `${form}: ${String(r?.primaryDocDescription?.[i] ?? "") || "filing"}`,
            snippet: null, source: "SEC EDGAR", imageUrl: null, publishedAt, symbols: [symbol.toUpperCase()], fetchedAt,
          });
        }
        return { articles, rateLimited: false };
      } catch (error) {
        if (error instanceof MarketDataUnavailableError && (error.reason === "http_429" || error.reason === "http_403")) return { articles: [], rateLimited: true, limit: "throttle" };
        throw error;
      }
    },
  };
}
