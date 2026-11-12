import { z } from "zod";
import { aggregateHoldings, isInvestable, type HoldingRow } from "../analytics/holdings.js";
import { homeDayChange } from "../fx/day-change.js";
import type { HomeAmount } from "../fx/home-currency.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import { providerTicker } from "../market-data/ticker-map.js";
import type { Quote } from "../market-data/types.js";
import { httpUrlOrNull } from "../news/marketaux.js";
import { classifyMovers, type Mover } from "../news/movers.js";
import { newsSymbolsFromAccounts, torontoDay, torontoMarketOpen, type NewsRefreshService, type NewsSymbol } from "../news/refresh-service.js";
import {
  dedupeLookThrough, levelFor, lookThroughRatings, moodFor, portfolioMood, rank, reasonFor, RELEVANT_MIN, weightedMoodFor,
  type Mood, type MoodLevel, type Reason,
} from "../news/scoring.js";
import type { ArticleRating, NewsStore, StoredArticle, SymbolStats } from "../news/store.js";
import type { PortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import type { PortfolioSettingsView, SettingsService } from "../settings/settings-service.js";
import { listAccounts } from "./activity-tools.js";
import { CAD_NOTE, homeConverterFor } from "./home-fx.js";
import { loadSettings, withDeadline } from "./overview-tools.js";

export const NEWS_WIDGET = "news";
const CAD_MOVE_NOTE = "A USD holding's moveCad includes the day's currency move; returnPct is the price move.";
export const NEWS_WIDGET_URI = "ui://portfolio/news-v1";
export const NEWS_WINDOWS = ["24h", "7d", "30d"] as const;
export type NewsWindow = (typeof NEWS_WINDOWS)[number];
const WINDOW_HOURS: Record<NewsWindow, number> = { "24h": 24, "7d": 168, "30d": 720 };
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A symbol is refreshed on demand only when its last fetch is older than this (the planner's own interval). */
const STALE_MS = 6 * HOUR_MS;
const REASON_HOURS = 48;
const DEFAULT_REFRESH_DEADLINE_MS = 5_000;
const DEFAULT_MARKET_DEADLINE_MS = 5_000;
const MARKET_CONCURRENCY = 4;
const SPARKLINE_DAYS = 90;
const SPARKLINE_POINTS = 30;
const EVENT_CONFIDENCE_MIN = 0.5;
const CREDIBLE_MIN = 0.6;
const MAX_FEED = 40;
/** Symbols kept when the payload is over budget (movers' symbols are always kept). */
const MAX_SYMBOLS_TRIMMED = 100;
const MODEL_ITEMS = 20;
const PAYLOAD_BUDGET_BYTES = 58_000;
export const NEWS_KINDS = new Set(["stock", "etf", "equity", "cs", "et"]);
const ETF_KINDS = new Set(["etf", "et"]);
export const RATING_CAVEAT = "AI-rated from the headline and summary; may be wrong";
export const ADVICE_NOTE = "News and ratings are for information only, not investment advice.";

export const newsInput = z.object({
  window: z.enum(NEWS_WINDOWS).optional(),
  accountId: z.string().min(1).optional(),
  symbol: z.string().trim().regex(/^[A-Za-z0-9.\-]{1,20}$/, "Use a ticker symbol").transform((s) => s.toUpperCase()).optional(),
}).strict();
export type NewsInput = z.infer<typeof newsInput>;

export interface NewsDeps {
  store: NewsStore;
  /** On-demand refresh of stale symbols; absent means cache only. */
  refresh?: Pick<NewsRefreshService, "refreshSymbols">;
  market: Pick<MarketDataService, "quotes" | "history" | "profile"> & Partial<Pick<MarketDataService, "usdCad">>;
  settings: Pick<SettingsService, "get">;
  /** Marketaux daily request budget (MARKETAUX_DAILY_BUDGET). */
  budget: number;
  /** This server's public origin: thumbnails are served from `${publicOrigin}/api/news/image/<id>`. */
  publicOrigin: string;
  now?: () => Date;
  /** Bound on the on-demand refresh. Default (and maximum) 5000 ms. */
  refreshDeadlineMs?: number;
  /** Bound on each market-data phase (quotes; profiles and sparklines). Default 5000 ms. */
  marketDeadlineMs?: number;
  /** Counts-only diagnostics (`news_served`); defaults to a JSON line on stdout. */
  log?: (event: object) => void;
}

export interface NewsCard {
  articleId: string;
  headline: string;
  snippet: string | null;
  source: string;
  publishedAt: string;
  /** `/api/news/image/<articleId>` (relative to `imageOrigin`) when the article has a thumbnail; never the publisher URL. */
  imageUrl: string | null;
  url: string;
  /** Held symbols in scope this article relates to (an ETF when reached through look-through). */
  symbols: string[];
  /** Null while the article is not yet rated: shown as "Not yet rated", outside every mood and reason. */
  tags: { eventType: string | null; impactLevel: 0 | 1 | 2 | 3; mood: MoodLevel | null; credible: boolean } | null;
  /** Other sources whose duplicate copies were collapsed into this card. */
  alsoReportedBy: string[];
  /** The ETF constituent through which the article relates, when it relates to no held symbol directly. */
  via: string | null;
}

/**
 * `lookThrough`: an ETF mood built from its top holdings' articles ("from top holdings · est.").
 * `lookThroughMissing`: an ETF with no top-holdings data; its level is "not_enough_news" ("no look-through data").
 */
export type MoodView = Omit<Mood, "mostRecentAt"> & { mostRecentAt: string | null; lookThrough: boolean; lookThroughMissing: boolean };
/**
 * `via`: the ETF constituent the reason article is about when the mover is an ETF explained through look-through
 * (`lookThrough: true`); null otherwise.
 */
export type NewsMover = Mover & {
  /** CAD view only: the day's dollar move in CAD (today's value at today's rate minus the previous close at its rate; est. for USD). `dollarMove` and the percent stay native. */
  home?: HomeAmount;
  reason: { kind: Reason["kind"]; card: NewsCard | null; via: string | null; lookThrough: boolean }; mood: MoodView;
};

export interface NewsPayload {
  window: NewsWindow;
  asOf: string;
  /** Oldest news fetch among the scope's symbols that have been fetched; null when none has. */
  newsAsOf: string | null;
  /** Scope symbols never fetched yet (not covered by `newsAsOf`). */
  unfetched: number;
  budgetExhausted: boolean;
  portfolioMood: ReturnType<typeof portfolioMood>;
  /** Flagged (unusual) movers, largest |dollarMove| first, per symbol and currency. */
  movers: NewsMover[];
  /** Priced holdings that moved as usual. */
  asUsual: number;
  /** Holdings without a usable price: neither flagged nor "as usual". */
  unpriced: number;
  feed: NewsCard[];
  symbols: Array<{ symbol: string; mood: MoodView; sparkline: number[] }>;
  accounts: Array<{ id: string; label: string }>;
  filters: { window: NewsWindow; accountId?: string; symbol?: string; /** show_news only: the requested symbol, not held, so the view is unfiltered. */ symbolNotHeld?: string };
  settings: PortfolioSettingsView;
  /** Origin to prefix card `imageUrl`s with (the widget runs in a sandboxed frame on another origin). */
  imageOrigin: string;
  /**
   * Left out to keep the payload under 60 KB (feed also counts cards past the 40-card cap): cards, sparklines
   * emptied to [], symbols, and (last resort) the smallest flagged movers.
   */
  omitted: { feed: number; sparklines: number; symbols: number; movers: number };
}

export class NewsScopeError extends Error {
  constructor(readonly code: "unknown_account" | "unknown_symbol") { super(code); this.name = "NewsScopeError"; }
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;
const roundOrNull = (v: number | null, places: number) => (v === null ? null : round(v, places));
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
type MoodBasis = "direct" | "look_through" | "missing";
const moodView = (m: Mood, basis: MoodBasis = "direct"): MoodView => ({
  ...m, value: roundOrNull(m.value, 4), mostRecentAt: m.mostRecentAt ? m.mostRecentAt.toISOString() : null,
  lookThrough: basis === "look_through", lookThroughMissing: basis === "missing",
});
const relevantRating = (r: ArticleRating) => r.relevant >= RELEVANT_MIN;
type Rated = { article: StoredArticle; rating: ArticleRating };

/** Runs `work` over `items`, four at a time, until the shared deadline; unfinished items are absent. Never throws. */
async function pooled<T, R>(items: T[], work: (item: T) => Promise<R>, deadlineMs: number): Promise<Map<T, R>> {
  const out = new Map<T, R>();
  if (items.length === 0) return out;
  const queue = [...items];
  let open = true;
  const worker = async () => {
    while (open) {
      const item = queue.shift();
      if (item === undefined) return;
      try {
        const r = await work(item);
        if (open) out.set(item, r);
      } catch { /* absent */ }
    }
  };
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, deadlineMs);
    void Promise.all(Array.from({ length: Math.min(MARKET_CONCURRENCY, queue.length) }, worker)).then(() => { clearTimeout(timer); resolve(); });
  });
  open = false;
  return out;
}

/**
 * The portfolio size a mover's dollar threshold is measured against, for every currency held in scope: reported account
 * totals (holdings plus cash when an account reports none) summed across currencies at par. A threshold is a coarse
 * materiality floor, never shown, so it needs no exchange rate; one size means a move's verdict doesn't depend on which
 * currency its listing or its account reports in.
 */
export function portfolioTotals(portfolio: PortfolioPresentation, accountId: string | undefined): Map<string, number> {
  const sums = new Map<string, number>();
  const add = (c: string, v: number) => sums.set(c, (sums.get(c) ?? 0) + v);
  const accounts = portfolio.accounts.filter((a) => isInvestable(a) && (accountId === undefined || a.id === accountId));
  for (const a of accounts) {
    if (a.value && finite(a.value.amount)) { add(a.value.currency.trim().toUpperCase(), a.value.amount); continue; }
    for (const t of aggregateHoldings([a], {}).totals) add(t.currency, t.marketValue + t.cash);
  }
  const total = [...sums.values()].reduce((x, y) => x + y, 0);
  const currencies = [...sums.keys(), ...aggregateHoldings(accounts, {}).rows.map((r) => r.currency)];
  return new Map(currencies.map((c) => [c, total]));
}

function cardFor(article: StoredArticle, rating: ArticleRating | null, symbols: string[], via: string | null, alsoReportedBy: string[]): NewsCard {
  return {
    articleId: article.id,
    headline: article.headline,
    snippet: article.snippet,
    source: article.source,
    publishedAt: article.publishedAt.toISOString(),
    imageUrl: httpUrlOrNull(article.imageUrl) ? `/api/news/image/${article.id}` : null,
    url: article.url,
    symbols,
    tags: rating === null ? null : {
      eventType: rating.eventType !== null && rating.eventConfidence >= EVENT_CONFIDENCE_MIN ? rating.eventType : null,
      impactLevel: Math.max(0, Math.min(3, Math.round(finite(rating.materiality) ? rating.materiality : 0))) as 0 | 1 | 2 | 3,
      mood: relevantRating(rating) ? levelFor((rating.sentiment - 2) / 2) : null,
      credible: rating.credible >= CREDIBLE_MIN,
    },
    alsoReportedBy,
    via,
  };
}

const baseSymbol = (s: string) => s.toUpperCase().replace(/\.(TO|V|NE|CN)$/, "");

export interface NewsBuildOptions {
  /** `resolveSymbol` (show_news): match a symbol by base, or fall back to an unfiltered view with `filters.symbolNotHeld` instead of throwing. */
  resolveSymbol?: boolean;
  /** Skip the on-demand refresh and serve the cache only (the refresh rate limit is spent). */
  noRefresh?: boolean;
}

export async function buildNewsPayload(
  deps: NewsDeps, portfolio: PortfolioPresentation, authSubject: string, rawInput: NewsInput, options: NewsBuildOptions = {},
): Promise<NewsPayload> {
  return (await buildNewsResult(deps, portfolio, authSubject, rawInput, options)).payload;
}

/** `refreshed`: this call started an on-demand refresh of at least one stale symbol (joining one already running does not count). */
export async function buildNewsResult(
  deps: NewsDeps, portfolio: PortfolioPresentation, authSubject: string, rawInput: NewsInput, options: NewsBuildOptions = {},
): Promise<{ payload: NewsPayload; refreshed: boolean }> {
  let input = rawInput;
  let symbolNotHeld: string | undefined;
  const listed = listAccounts(portfolio).filter((a) => a.kind !== "credit");
  if (input.accountId !== undefined && !listed.some((a) => a.id === input.accountId)) throw new NewsScopeError("unknown_account");
  const window: NewsWindow = input.window ?? "7d";
  const now = (deps.now ?? (() => new Date()))();
  const marketDeadline = deps.marketDeadlineMs ?? DEFAULT_MARKET_DEADLINE_MS;
  const refreshDeadline = Math.min(deps.refreshDeadlineMs ?? DEFAULT_REFRESH_DEADLINE_MS, DEFAULT_REFRESH_DEADLINE_MS);
  const scope = input.accountId !== undefined ? { accountId: input.accountId } : {};
  const rows: HoldingRow[] = aggregateHoldings(portfolio.accounts, scope).rows.filter((r) => NEWS_KINDS.has(r.kind));
  const held = [...new Set(rows.map((r) => r.symbol))].sort();
  if (input.symbol !== undefined && !held.includes(input.symbol)) {
    if (!options.resolveSymbol) throw new NewsScopeError("unknown_symbol");
    const requested = input.symbol;
    const match = held.find((h) => baseSymbol(h) === baseSymbol(requested));
    const { symbol: _dropped, ...rest } = input;
    if (match) input = { ...rest, symbol: match };
    else { input = rest; symbolNotHeld = requested; }
  }
  const tickerOf = (r: HoldingRow) => providerTicker({ symbol: r.symbol, kind: r.kind, currency: r.currency });
  const firstRow = new Map<string, HoldingRow>();
  for (const r of rows) if (!firstRow.has(r.symbol)) firstRow.set(r.symbol, r);
  const shown = input.symbol !== undefined ? [input.symbol] : held;
  const marketOpen = torontoMarketOpen(now);
  const today = torontoDay(now);
  const { store } = deps;

  // Everything from cache or bounded market calls, in parallel.
  const tickers = [...new Set(rows.map(tickerOf).filter((t): t is string => t !== null))];
  const etfs = held.filter((s) => ETF_KINDS.has(firstRow.get(s)!.kind) && tickerOf(firstRow.get(s)!) !== null);
  const sparkFrom = isoDay(new Date(now.getTime() - SPARKLINE_DAYS * DAY_MS));
  const [stats, quotes, profiles, sparks, settings] = await Promise.all([
    store.stats(held).catch((): SymbolStats[] => []),
    marketOpen && tickers.length > 0
      ? withDeadline(() => deps.market.quotes(tickers), marketDeadline, () => new Map<string, Quote>())
      : Promise.resolve(new Map<string, Quote>()),
    pooled(etfs, (s) => deps.market.profile(tickerOf(firstRow.get(s)!)!), marketDeadline),
    pooled(shown.filter((s) => tickerOf(firstRow.get(s)!) !== null), (s) => deps.market.history(tickerOf(firstRow.get(s)!)!, sparkFrom, isoDay(now)), marketDeadline),
    loadSettings(deps as Parameters<typeof loadSettings>[0], authSubject),
  ]);

  // Movers from cached daily stats (and live quotes while the market is open).
  const statsMap = new Map(stats.map((s) => [`${s.symbol}|${s.currency}`, s]));
  const classified = classifyMovers(rows, statsMap, quotes instanceof Map ? quotes : new Map(), portfolioTotals(portfolio, input.accountId), marketOpen, now);
  const flaggedSymbols = new Set(classified.movers.filter((m) => m.flagged).map((m) => m.symbol));

  // ETF look-through constituents (upper-cased, excluding the ETF itself).
  const constituents = new Map<string, Array<{ symbol: string; weight: number }>>();
  for (const etf of etfs) {
    const top = profiles.get(etf)?.topHoldings ?? [];
    const list = top
      .map((h) => ({ symbol: String(h.symbol ?? "").trim().toUpperCase(), weight: Number(h.weight) }))
      .filter((h) => h.symbol && h.symbol !== etf && finite(h.weight) && h.weight > 0);
    if (list.length > 0) constituents.set(etf, list);
  }
  const constituentSymbols = [...new Set([...constituents.values()].flat().map((c) => c.symbol))].filter((s) => !held.includes(s)).sort();

  // On-demand refresh: stale symbols only, never when the day's budget is gone, never longer than 5 s.
  const fetchedAt = async (symbols: string[]) => new Map(await Promise.all(symbols.map(async (s) => [s, await store.latestFetch(s).catch(() => null)] as const)));
  const spent = () => store.budgetSpent(today).catch(() => deps.budget);
  let last = await fetchedAt([...held, ...constituentSymbols]);
  let budgetExhausted = (await spent()) >= deps.budget;
  const stale = (s: string) => { const at = last.get(s); return !at || now.getTime() - at.getTime() > STALE_MS; };
  let refreshed = false;
  if (deps.refresh && !budgetExhausted && !options.noRefresh) {
    const scopeAccounts = portfolio.accounts.filter((a) => input.accountId === undefined || a.id === input.accountId);
    const wanted: NewsSymbol[] = [
      ...newsSymbolsFromAccounts(scopeAccounts).filter((s) => stale(s.symbol)).map((s) => ({ ...s, isMover: flaggedSymbols.has(s.symbol) })),
      ...constituentSymbols.filter(stale).map((symbol) => ({ symbol, currency: "USD", kind: "stock", isMover: false, isConstituent: true, usListed: false })),
    ];
    if (wanted.length > 0) {
      const refresh = deps.refresh;
      // Single flight per store and symbol: concurrent builds await the refresh already running for a symbol.
      const running = inFlightRefreshes.get(store) ?? new Map<string, Promise<unknown>>();
      inFlightRefreshes.set(store, running);
      const pending = new Set<Promise<unknown>>();
      const fresh = wanted.filter((s) => { const p = running.get(s.symbol); if (p) pending.add(p); return !p; });
      if (fresh.length > 0) {
        refreshed = true;
        const run: Promise<unknown> = Promise.resolve().then(() => refresh.refreshSymbols(fresh, { budgetMs: refreshDeadline })).catch(() => null);
        const mine = new Set(fresh.map((s) => s.symbol));
        for (const sym of mine) running.set(sym, run);
        void run.finally(() => { for (const sym of mine) if (running.get(sym) === run) running.delete(sym); });
        pending.add(run);
      }
      await withDeadline(() => Promise.all([...pending]), refreshDeadline, () => null);
      last = await fetchedAt([...held, ...constituentSymbols]);
      budgetExhausted = (await spent()) >= deps.budget;
    }
  }
  const heldFetches = held.map((s) => last.get(s) ?? null);
  const fetched = heldFetches.filter((d): d is Date => d !== null);
  const newsAsOf = fetched.length > 0 ? new Date(Math.min(...fetched.map((d) => d.getTime()))).toISOString() : null;

  // Rated articles: the window for mood and feed, at least 48 h for the reason line.
  const windowStart = new Date(now.getTime() - WINDOW_HOURS[window] * HOUR_MS);
  const since = new Date(Math.min(windowStart.getTime(), now.getTime() - REASON_HOURS * HOUR_MS));
  const articles = await store.articlesForSymbols([...held, ...constituentSymbols], since).catch((): StoredArticle[] => []);
  const ratings = articles.length > 0 ? await store.ratingsFor(articles.map((a) => a.id)).catch((): ArticleRating[] => []) : [];
  const byId = new Map(articles.map((a) => [a.id, a]));
  const all = new Map<string, Rated[]>();
  for (const rating of ratings) {
    const article = byId.get(rating.articleId);
    // Defence in depth behind ingest: a card link is always an absolute http(s) URL.
    if (!article || !article.symbols.includes(rating.symbol) || !httpUrlOrNull(article.url)) continue;
    all.set(rating.symbol, [...(all.get(rating.symbol) ?? []), { article, rating }]);
  }
  const inWindow = new Map([...all].map(([s, list]) => [s, list.filter((x) => x.article.publishedAt >= windowStart)]));
  // Unrated (article, symbol) pairs: shown as "not yet rated" cards, never in a mood or as a reason.
  const scopeSymbols = new Set([...held, ...constituentSymbols]);
  const ratedPairs = new Set(ratings.map((r) => `${r.articleId}|${r.symbol}`));
  const unrated = new Map<string, StoredArticle[]>();
  for (const a of articles) {
    if (!httpUrlOrNull(a.url)) continue;
    for (const s of new Set(a.symbols)) if (scopeSymbols.has(s) && !ratedPairs.has(`${a.id}|${s}`)) unrated.set(s, [...(unrated.get(s) ?? []), a]);
  }
  const lookThrough = (etf: string, source: Map<string, Rated[]>) => {
    const c = constituents.get(etf);
    return c ? lookThroughRatings(etf, c, source) : [];
  };

  // Moods per held symbol: ETFs from their top holdings (est.); an ETF without top-holdings data has no mood
  // ("no look-through data"), never one from its own few articles.
  const moods = new Map<string, Mood>();
  const basis = new Map<string, MoodBasis>();
  for (const s of held) {
    if (constituents.has(s)) {
      basis.set(s, "look_through");
      moods.set(s, weightedMoodFor(dedupeLookThrough(lookThrough(s, inWindow)).map((i) => ({ rating: i.rating, publishedAt: i.article.publishedAt, weight: i.weight })), now));
    } else if (ETF_KINDS.has(firstRow.get(s)!.kind)) {
      basis.set(s, "missing");
      moods.set(s, { level: "not_enough_news", value: null, articles: 0, mostRecentAt: null, estimated: true });
    } else {
      basis.set(s, "direct");
      moods.set(s, moodFor((inWindow.get(s) ?? []).map((x) => ({ rating: x.rating, publishedAt: x.article.publishedAt })), now));
    }
  }
  const moodOf = (s: string) => moodView(moods.get(s)!, basis.get(s));

  // Feed: one card per article, best rank across its relations, duplicates collapsed.
  interface Entry { article: StoredArticle; best: ArticleRating; bestRank: number; direct: Set<string>; etfs: Set<string>; via: Set<string>; dupOf: string | null }
  const entries = new Map<string, Entry>();
  const relate = (x: Rated, kind: { direct: string } | { etf: string; via: string }) => {
    if (!relevantRating(x.rating)) return;
    const r = rank(x.rating, now, x.article.publishedAt);
    let e = entries.get(x.article.id);
    if (!e) { e = { article: x.article, best: x.rating, bestRank: r, direct: new Set(), etfs: new Set(), via: new Set(), dupOf: null }; entries.set(x.article.id, e); }
    else if (r > e.bestRank) { e.best = x.rating; e.bestRank = r; }
    if (x.rating.duplicateOf !== null && x.rating.duplicateOf !== x.article.id) e.dupOf ??= x.rating.duplicateOf;
    if ("direct" in kind) e.direct.add(kind.direct);
    else { e.etfs.add(kind.etf); e.via.add(kind.via); }
  };
  for (const s of held) {
    for (const x of inWindow.get(s) ?? []) relate(x, { direct: s });
    for (const i of lookThrough(s, inWindow)) relate(i, { etf: s, via: i.via });
  }
  const target = (id: string): string => {
    let cur = id;
    for (let hop = 0; hop < 4; hop += 1) {
      const next = entries.get(cur)?.dupOf;
      if (!next || !entries.has(next) || next === id) return cur;
      cur = next;
    }
    return cur;
  };
  const also = new Map<string, Set<string>>();
  const kept: Entry[] = [];
  for (const [id, e] of entries) {
    const into = target(id);
    if (into === id) { kept.push(e); continue; }
    const host = entries.get(into)!;
    if (e.article.source !== host.article.source) also.set(into, (also.get(into) ?? new Set()).add(e.article.source));
    for (const s of e.direct) host.direct.add(s);
    for (const s of e.etfs) host.etfs.add(s);
    for (const s of e.via) host.via.add(s);
  }
  // Not-yet-rated cards for articles with no relevant rating in scope, after the rated ones, newest first.
  interface Pending { article: StoredArticle; direct: Set<string>; etfs: Set<string>; via: Set<string> }
  const pending = new Map<string, Pending>();
  const relatePending = (a: StoredArticle, kind: { direct: string } | { etf: string; via: string }) => {
    if (a.publishedAt < windowStart || entries.has(a.id)) return;
    let e = pending.get(a.id);
    if (!e) { e = { article: a, direct: new Set(), etfs: new Set(), via: new Set() }; pending.set(a.id, e); }
    if ("direct" in kind) e.direct.add(kind.direct);
    else { e.etfs.add(kind.etf); e.via.add(kind.via); }
  };
  for (const s of held) {
    for (const a of unrated.get(s) ?? []) relatePending(a, { direct: s });
    for (const c of constituents.get(s) ?? []) for (const a of unrated.get(c.symbol) ?? []) relatePending(a, { etf: s, via: c.symbol });
  }
  const pendingCards = [...pending.values()]
    .sort((a, b) => b.article.publishedAt.getTime() - a.article.publishedAt.getTime() || a.article.id.localeCompare(b.article.id))
    .map((e) => cardFor(e.article, null, [...new Set([...e.direct, ...e.etfs])].sort(), e.direct.size === 0 ? [...e.via].sort()[0] ?? null : null, []));
  const toCard = (e: Entry) => cardFor(
    e.article, e.best, [...new Set([...e.direct, ...e.etfs])].sort(),
    e.direct.size === 0 ? [...e.via].sort()[0] ?? null : null,
    [...(also.get(e.article.id) ?? [])].sort(),
  );
  kept.sort((a, b) => b.bestRank - a.bestRank || b.article.publishedAt.getTime() - a.article.publishedAt.getTime() || a.article.id.localeCompare(b.article.id));
  const cards = new Map(kept.map((e) => [e.article.id, toCard(e)]));
  const allCards = [...kept.map((e) => cards.get(e.article.id)!), ...pendingCards].filter((c) => input.symbol === undefined || c.symbols.includes(input.symbol));
  const feed = allCards.slice(0, MAX_FEED);

  // CAD view: one bounded BoC fetch, only when a flagged mover is in USD, from its session's previous trading day.
  const flaggedUsd = classified.movers.filter((m) => m.flagged && m.currency.toUpperCase() === "USD").map((m) => m.sessionDate).sort();
  const conv = settings.cadView ? await homeConverterFor(deps.market, flaggedUsd[0], today, marketDeadline) : null;

  // Movers: flagged only, with the reason line (48 h) and the symbol mood.
  const movers: NewsMover[] = classified.movers
    .filter((m) => m.flagged && (input.symbol === undefined || m.symbol === input.symbol))
    .sort((a, b) => Math.abs(b.dollarMove) - Math.abs(a.dollarMove) || a.symbol.localeCompare(b.symbol) || a.currency.localeCompare(b.currency))
    .map((m) => {
      const direct = all.get(m.symbol) ?? [];
      const through = lookThrough(m.symbol, all);
      const candidates: Rated[] = [...direct, ...through.map((i) => ({ article: i.article, rating: i.rating }))];
      const waiting = [...(unrated.get(m.symbol) ?? []), ...(constituents.get(m.symbol) ?? []).flatMap((c) => unrated.get(c.symbol) ?? [])];
      const reason = reasonFor(candidates, now, waiting);
      let card: NewsCard | null = null;
      let via: string | null = null;
      if (reason.kind === "article" && reason.article && reason.rating) {
        const id = reason.article.id;
        if (!direct.some((x) => x.article.id === id)) via = through.find((i) => i.article.id === id)?.via ?? null;
        card = cards.get(target(id)) ?? cardFor(reason.article, reason.rating, [m.symbol], via, []);
      }
      return {
        ...m, returnFraction: round(m.returnFraction, 6), dollarMove: round(m.dollarMove, 2), units: round(m.units, 6), marketValue: roundOrNull(m.marketValue, 2),
        ...(conv ? { home: homeDayChange(conv, { currency: m.currency, units: m.units, price: m.price, previousClose: m.previousClose, day: m.sessionDate, fallbackDay: today }) } : {}),
        reason: { kind: reason.kind, card, via, lookThrough: via !== null }, mood: moodOf(m.symbol),
      };
    });
  const inShown = (s: { symbol: string }) => input.symbol === undefined || s.symbol === input.symbol;
  const asUsual = classified.movers.filter((m) => !m.flagged && inShown(m)).length;
  const unpriced = classified.unpriced.filter(inShown).length;

  // Portfolio mood: each holding weighted by its share of its own currency (no cross-currency sum).
  const pMood = portfolioMood(rows.map((r) => ({ mood: moods.get(r.symbol)!, weight: r.weight ?? 0 })));

  const symbols = shown.map((s) => {
    const points = sparks.get(s) ?? null;
    const closes = Array.isArray(points)
      ? [...points].filter((p) => finite(p.close) && p.close > 0).sort((a, b) => a.date.localeCompare(b.date)).slice(-SPARKLINE_POINTS).map((p) => round(p.close, 4))
      : [];
    return { symbol: s, mood: moodOf(s), sparkline: closes };
  });

  const payload: NewsPayload = {
    window, asOf: portfolio.generatedAt, newsAsOf, unfetched: heldFetches.filter((d) => d === null).length, budgetExhausted,
    portfolioMood: { ...pMood, value: roundOrNull(pMood.value, 4) },
    movers, asUsual, unpriced, feed, symbols,
    accounts: listed.map((a) => ({ id: a.id, label: a.label })),
    filters: { window, ...(input.accountId !== undefined ? { accountId: input.accountId } : {}), ...(input.symbol !== undefined ? { symbol: input.symbol } : {}), ...(symbolNotHeld !== undefined ? { symbolNotHeld } : {}) },
    settings,
    imageOrigin: deps.publicOrigin,
    omitted: { feed: allCards.length - feed.length, sparklines: 0, symbols: 0, movers: 0 },
  };
  const weightOf = (s: string) => rows.filter((r) => r.symbol === s).reduce((t, r) => t + (r.weight ?? 0), 0);
  fitPayload(payload, new Set(movers.map((m) => m.symbol)), weightOf);
  // How often a view is empty or thin (decides whether an open-news backfill is worth it). Counts only.
  const articleCounts = payload.symbols.map((x) => x.mood.articles ?? 0);
  (deps.log ?? ((e) => console.log(JSON.stringify(e))))({
    event: "news_served", window, scoped: input.symbol !== undefined, symbols: payload.symbols.length,
    noNews: articleCounts.filter((n) => n === 0).length,
    thin: articleCounts.filter((n) => n > 0 && n < 3).length,
    notEnoughNews: payload.symbols.filter((x) => x.mood.level === "not_enough_news").length,
    feed: payload.feed.length, emptyFeed: payload.feed.length === 0, refreshed, budgetExhausted, unfetched: payload.unfetched,
  });
  return { payload, refreshed };
}

/** Per store: symbol → the on-demand refresh currently running for it (settled entries are removed). */
const inFlightRefreshes = new WeakMap<NewsStore, Map<string, Promise<unknown>>>();

/**
 * Keeps the payload under the budget, in order: the lowest-ranked feed cards; then sparklines (to [], non-movers and
 * smaller holdings first); then symbols beyond 100, then further symbols (movers' symbols are always kept); last, the
 * smallest movers. Everything left out is counted in `omitted`.
 */
function fitPayload(p: NewsPayload, moverSymbols: Set<string>, weightOf: (symbol: string) => number): void {
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  let size = bytes(p);
  const over = () => size > PAYLOAD_BUDGET_BYTES;
  const recount = () => { size = bytes(p); };
  while (over() && p.feed.length > 0) {
    size -= bytes(p.feed[p.feed.length - 1]) + 1;
    p.feed.pop();
    p.omitted.feed += 1;
    if (!over()) recount();
  }
  // Drop order for symbols: non-movers before movers, smaller holdings first, then reverse symbol order.
  const dropOrder = [...p.symbols].sort((a, b) =>
    Number(moverSymbols.has(a.symbol)) - Number(moverSymbols.has(b.symbol)) || weightOf(a.symbol) - weightOf(b.symbol) || b.symbol.localeCompare(a.symbol));
  for (const s of dropOrder) {
    if (!over()) break;
    if (s.sparkline.length === 0) continue;
    size -= bytes(s.sparkline) - 2;
    s.sparkline = [];
    p.omitted.sparklines += 1;
  }
  recount();
  const dropSymbols = (keepAtMost: number) => {
    const drop = new Set<string>();
    let remaining = p.symbols.length;
    for (const s of dropOrder) {
      if (!over() || remaining <= keepAtMost) break;
      if (moverSymbols.has(s.symbol) || drop.has(s.symbol)) continue;
      drop.add(s.symbol);
      size -= bytes(s) + 1;
      remaining -= 1;
    }
    if (drop.size > 0) {
      p.symbols = p.symbols.filter((s) => !drop.has(s.symbol));
      p.omitted.symbols += drop.size;
      recount();
    }
  };
  if (over() && p.symbols.length > MAX_SYMBOLS_TRIMMED) {
    // Past the budget, keep at most 100 symbols in one step (movers' symbols always stay).
    const before = p.symbols.length;
    const keep = new Set(p.symbols.filter((s) => moverSymbols.has(s.symbol)).map((s) => s.symbol));
    for (const s of [...dropOrder].reverse()) if (keep.size < MAX_SYMBOLS_TRIMMED) keep.add(s.symbol);
    p.symbols = p.symbols.filter((s) => keep.has(s.symbol));
    p.omitted.symbols += before - p.symbols.length;
    recount();
  }
  dropSymbols(0);
  while (over() && p.movers.length > 0) {
    p.movers.pop();
    p.omitted.movers += 1;
    recount();
  }
}

const moodWord = (level: Mood["level"]) => (level === "not_enough_news" ? "not enough news" : level.replace(/_/g, " "));

function reasonLine(m: NewsMover): string {
  if (m.reason.kind === "article" && m.reason.card) {
    // The headline is chosen by AI ratings, so it carries the caveat whatever the mood says.
    return `${m.symbol} moved more than usual: ${m.reason.via ? `${m.reason.via}: ` : ""}${m.reason.card.headline} (${m.reason.card.source}) (AI-rated; may be wrong).`;
  }
  if (m.reason.kind === "nothing_explains") return `${m.symbol} moved more than usual; news, but nothing that explains the move.`;
  if (m.reason.kind === "news_not_rated") return `${m.symbol} moved more than usual; news found, not yet rated.`;
  return `${m.symbol} moved more than usual; no clear news.`;
}

/** One holding: "<SYM>: <mood word>, N articles in the window." then its reason line when it is a mover. */
function filteredNewsText(p: NewsPayload, symbol: string, options: { show?: boolean }): string {
  const mood = p.symbols.find((s) => s.symbol === symbol)?.mood ?? null;
  const n = mood?.articles ?? 0;
  const parts = [`${symbol}: ${mood ? moodWord(mood.level) : "not enough news"}, ${n} article${n === 1 ? "" : "s"} in the window.`];
  if (mood && mood.level !== "not_enough_news") parts.push(`Mood is ${RATING_CAVEAT}.`);
  for (const m of p.movers.filter((x) => x.symbol === symbol).slice(0, 1)) parts.push(reasonLine(m));
  parts.push(`${p.feed.length} news ${p.feed.length === 1 ? "item" : "items"} in the last ${p.window}.`);
  if (p.budgetExhausted) parts.push("Today's news budget is used up; showing cached news.");
  parts.push(ADVICE_NOTE);
  if (options.show) parts.push("Showing the news widget.");
  return parts.join(" ");
}

/** Counts, the top three movers with their reason, and the portfolio mood word. No amounts or account ids. */
export function newsText(p: NewsPayload, options: { show?: boolean } = {}): string {
  const priced = p.movers.length + p.asUsual;
  const parts: string[] = [];
  if (p.filters.symbol !== undefined) return filteredNewsText(p, p.filters.symbol, options);
  if (p.filters.symbolNotHeld !== undefined) parts.push(`${p.filters.symbolNotHeld} isn't in your holdings; showing all.`);
  if (priced + p.unpriced === 0) parts.push(p.filters.accountId ? "No stock or ETF holdings in this account." : "No stock or ETF holdings.");
  else {
    const holdings = priced === 1 ? "holding" : "holdings";
    parts.push(`${p.movers.length} of ${priced} ${holdings} moved more than usual since the previous close${p.movers.some((m) => m.estimated) ? " (est.)" : ""}.`);
    if (p.unpriced > 0) parts.push(`${p.unpriced} without a usable price.`);
    for (const m of p.movers.slice(0, 3)) parts.push(reasonLine(m));
  }
  parts.push(`${p.feed.length} news ${p.feed.length === 1 ? "item" : "items"} in the last ${p.window}.`);
  parts.push(p.portfolioMood.level === "not_enough_news"
    ? "Portfolio news mood: not enough news."
    : `Portfolio news mood: ${moodWord(p.portfolioMood.level)} (${RATING_CAVEAT}).`);
  if (p.budgetExhausted) parts.push("Today's news budget is used up; showing cached news.");
  parts.push(ADVICE_NOTE);
  if (options.show) parts.push("Showing the news widget.");
  return parts.join(" ");
}

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** Compact copy for the model: at most 20 movers, cards and symbol moods; no amounts or image URLs. */
export function newsModelCopy(p: NewsPayload) {
  return {
    window: p.window,
    newsAsOf: p.newsAsOf,
    budgetExhausted: p.budgetExhausted,
    portfolioMood: { level: p.portfolioMood.level, spread: p.portfolioMood.spread },
    movers: p.movers.slice(0, MODEL_ITEMS).map((m) => ({
      symbol: m.symbol, currency: m.currency, returnPct: r4(m.returnFraction), estimated: m.estimated,
      ...(m.home && m.home.amount !== null ? { moveCad: m.home.amount, moveCadEstimated: m.home.estimated } : {}), limitedHistory: m.limitedHistory,
      reason: m.reason.kind, headline: m.reason.card?.headline ?? null, source: m.reason.card?.source ?? null, via: m.reason.via, lookThrough: m.reason.lookThrough,
      mood: m.mood.level, moodFromTopHoldings: m.mood.lookThrough, noLookThroughData: m.mood.lookThroughMissing,
    })),
    asUsual: p.asUsual,
    unpriced: p.unpriced,
    feed: p.feed.slice(0, MODEL_ITEMS).map((c) => ({
      headline: c.headline, source: c.source, publishedAt: c.publishedAt, symbols: c.symbols, via: c.via, rated: c.tags !== null,
      eventType: c.tags?.eventType ?? null, impactLevel: c.tags?.impactLevel ?? null, mood: c.tags?.mood ?? null, credible: c.tags?.credible ?? null,
      alsoReportedBy: c.alsoReportedBy,
    })),
    symbols: p.symbols.slice(0, MODEL_ITEMS).map((s) => ({ symbol: s.symbol, mood: s.mood.level, articles: s.mood.articles, moodFromTopHoldings: s.mood.lookThrough, noLookThroughData: s.mood.lookThroughMissing })),
    hasMore: p.movers.length > MODEL_ITEMS || p.feed.length > MODEL_ITEMS || p.symbols.length > MODEL_ITEMS,
    notes: {
      ...(p.movers.some((m) => m.home) ? { currency: CAD_NOTE, moveCad: CAD_MOVE_NOTE } : {}),
      ratings: RATING_CAVEAT,
      advice: ADVICE_NOTE,
      movers: "A mover is flagged when its move since the previous close is unusually large for it and large enough in dollars; returnPct is a fraction and carries est. while the market is open.",
      lookThrough: "ETF moods with moodFromTopHoldings are from the fund's top holdings (est.); a reason with via names the holding the article is about; noLookThroughData means the fund's holdings are unknown.",
      noNews: "\"no clear news\" and \"not enough news\" are outcomes, not neutral ratings. \"news_not_rated\" means articles exist but are not yet rated; feed items with rated=false carry no tags.",
    },
  };
}

const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const security = [{ type: "oauth2" as const, scopes: ["portfolio:read"] }];

const inputSchema = {
  type: "object",
  properties: {
    window: { type: "string", enum: [...NEWS_WINDOWS] },
    accountId: { type: "string", minLength: 1 },
    symbol: { type: "string", pattern: "^[A-Za-z0-9.\\-]{1,20}$" },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  properties: {
    window: { type: "string" }, asOf: { type: "string" }, newsAsOf: { type: ["string", "null"] }, unfetched: { type: "integer" },
    budgetExhausted: { type: "boolean" }, portfolioMood: { type: "object" }, movers: { type: "array" }, asUsual: { type: "integer" },
    unpriced: { type: "integer" }, feed: { type: "array" }, symbols: { type: "array" }, accounts: { type: "array" }, filters: { type: "object" },
    settings: { type: "object" }, imageOrigin: { type: "string" }, omitted: { type: "object" },
  },
  required: ["window", "asOf", "newsAsOf", "unfetched", "budgetExhausted", "portfolioMood", "movers", "asUsual", "unpriced", "feed", "symbols", "accounts", "filters", "settings", "imageOrigin", "omitted"],
  additionalProperties: false,
} as const;

export const newsToolDefinitions = [
  {
    name: "show_news",
    title: "Show news",
    description: "Use this when the user asks what moved, why a holding moved, or for news and sentiment about their holdings. Pass `symbol` when the question names one holding (e.g. 'news about GOOG') so the view opens on that holding; omit it for portfolio-wide questions. Read-only; informational, not advice.",
    inputSchema,
    outputSchema,
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    _meta: {
      securitySchemes: security, ui: { resourceUri: NEWS_WIDGET_URI }, "openai/outputTemplate": NEWS_WIDGET_URI,
      "openai/widgetAccessible": true, "openai/toolInvocation/invoking": "Loading news…", "openai/toolInvocation/invoked": "News ready.",
    },
  },
  {
    name: "get_news",
    title: "Get news",
    description: "Used by the news widget to change the window, account or symbol of the movers and news view. Read-only; informational, not advice.",
    inputSchema,
    outputSchema,
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    _meta: { securitySchemes: security, ui: { visibility: ["app"] } },
  },
] as const;
