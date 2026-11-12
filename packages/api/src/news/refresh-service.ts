// Nightly / on-demand news refresh: plan Marketaux fetches within the daily budget, add EDGAR filings for
// US-listed names, upsert articles, refresh per-symbol daily stats from cached price history, then rate
// unrated articles. Only tickers leave the server here (company names go to the rater). Logs carry counts,
// latency and budget state only.
import { aggregateHoldings } from "../analytics/holdings.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import { providerTicker } from "../market-data/ticker-map.js";
import type { PortfolioPresentationAccount } from "../portfolio/portfolio-presentation.js";
import { extractDates, isoDay, projectEarnings, torontoToday } from "./calendar.js";
import { DEFAULT_PAGES, planFetches } from "./fetch-plan.js";
import type { NewsFetcher } from "./marketaux.js";
import { buildStats } from "./movers.js";
import { EVENT_CONFIDENCE_GATE } from "./rater.js";
import { RELEVANT_MIN } from "./scoring.js";
import type { CalendarEvent, NewsStore, SymbolStats } from "./store.js";

export const MAX_SYMBOLS = 200;
export const REFRESH_DEADLINE_MS = 60_000;
const STATS_DAYS = 90;
/** Ratings per run: the nightly run works through the backlog; an on-demand refresh rates a few under its 5 s bound. */
export const NIGHTLY_MAX_RATINGS = 200;
export const ON_DEMAND_MAX_RATINGS = 20;
const STATS_CONCURRENCY = 4;
const FETCH_CONCURRENCY = 4;
const DAY_MS = 86_400_000;
const NEWS_KINDS = new Set(["stock", "etf", "equity", "cs", "et"]);
const ETF_KINDS = new Set(["etf", "et"]);
const NON_US_SUFFIX = /\.(TO|V|NE|CN)$/i;
/** Time kept back from the rater in the nightly run so the calendar projection still runs. */
export const CALENDAR_RESERVE_MS = 10_000;
/** Earnings-typed articles from this far back supply announced report dates. */
const CALENDAR_ARTICLE_DAYS = 30;

/**
 * One past dividend payment (gross per unit held that day): the input to a user's own pay-date projection, built at
 * read time by the calendar and alerts tools. Never merged across users or stored.
 */
/** `perUnit` is null when the units behind the payment can't be trusted: the date still counts for the cadence. */
export interface DividendPayment { symbol: string; date: Date; perUnit: number | null; currency: string }

/** EDGAR periodic-report dates for the earnings projection (US-listed names only). */
export interface FilingDates { filingDates(symbol: string): Promise<Date[]> }

export interface NewsSymbol {
  symbol: string;
  currency: string;
  isMover: boolean;
  isConstituent: boolean;
  usListed: boolean;
  /** Provider security kind; defaults to "stock" for the price-history ticker. */
  kind?: string;
  /** Security description from holdings, sent to the rater as the company name; the symbol otherwise. */
  name?: string | null;
}

export interface NewsRater {
  rateUnrated(o: { symbols: string[]; companyName: (symbol: string) => string; deadline: Date; maxPerRun: number }): Promise<{ rated: number; failed: number; skipped?: number }>;
}

export interface RefreshSymbolsResult { fetched: number; rated: number; skipped: number; failures: number; budgetLeft: number }
export interface RefreshAllResult extends RefreshSymbolsResult { users: number; symbols: number }

export interface NewsSweepLogEvent { event: "news_sweep"; articles: number; deliveries: number; events: number }

export interface NewsRefreshLogEvent {
  event: "news_refresh";
  symbols: number;
  fetched: number;
  rated: number;
  skipped: number;
  failures: number;
  /** Which step each failure came from (counts only, never symbols); the values add up to `failures`. */
  failureCodes: Record<string, number>;
  /** Symbols whose price history came back empty: expected for a few (new listings, some crypto), so not failures. */
  statsNoHistory: number;
  budgetLeft: number;
  rateLimited: boolean;
  limit: "daily" | "throttle" | null;
  deadlineHit: boolean;
  latencyMs: number;
}

const torontoParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function toronto(now: Date): { day: string; weekday: string; minutes: number } {
  const p = Object.fromEntries(torontoParts.formatToParts(now).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** Toronto-local YYYY-MM-DD. */
export const torontoDay = (now: Date) => toronto(now).day;

/** Toronto weekday 09:30–16:00 (exchange holidays are not modelled). */
export function torontoMarketOpen(now: Date): boolean {
  const t = toronto(now);
  return t.weekday !== "Sat" && t.weekday !== "Sun" && t.minutes >= 570 && t.minutes < 960;
}

const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** One stock-like entry per SYMBOL|CURRENCY from included, open, non-credit accounts (options/cash/funds skipped). */
export function newsSymbolsFromAccounts(accounts: PortfolioPresentationAccount[]): NewsSymbol[] {
  const names = new Map<string, string>();
  for (const a of accounts) {
    for (const p of a.positions ?? []) {
      const symbol = p.symbol.trim().toUpperCase();
      const name = p.description?.trim();
      if (symbol && name && !names.has(symbol)) names.set(symbol, name);
    }
  }
  return aggregateHoldings(accounts, {}).rows
    .filter((r) => NEWS_KINDS.has(r.kind))
    .map((r) => ({
      symbol: r.symbol, currency: r.currency, kind: r.kind, name: names.get(r.symbol) ?? null,
      isMover: false, isConstituent: false, usListed: r.currency === "USD" && !NON_US_SUFFIX.test(r.symbol),
    }));
}

export class NewsRefreshService {
  private readonly now: () => Date;
  private readonly log: (e: NewsRefreshLogEvent | NewsSweepLogEvent) => void;

  constructor(private readonly o: {
    store: NewsStore;
    marketaux: NewsFetcher;
    edgar: NewsFetcher & Partial<FilingDates>;
    rater: NewsRater;
    /** `cachedProfile` (optional): ETF top holdings from the profile cache for the nightly constituent fetch. */
    market: Pick<MarketDataService, "history"> & Partial<Pick<MarketDataService, "cachedProfile">>;
    budget: number;
    freeTier: boolean;
    now?: () => Date;
    log?: (e: object) => void;
  }) {
    this.now = o.now ?? (() => new Date());
    this.log = o.log ?? ((e) => console.info(JSON.stringify(e)));
  }

  /** plan → fetch → upsert → rate → stats, bounded by the daily budget and a deadline. Never throws. */
  refreshSymbols(symbols: NewsSymbol[], options: { budgetMs?: number } = {}): Promise<RefreshSymbolsResult> {
    const deadline = this.now().getTime() + Math.min(options.budgetMs ?? REFRESH_DEADLINE_MS, REFRESH_DEADLINE_MS);
    return this.run(symbols, deadline, { maxRatings: ON_DEMAND_MAX_RATINGS });
  }

  /**
   * Dedupes symbols across users and caps at 200 (movers first, then holder count, then stalest fetch); ≤ 60 s.
   * Failures are counted, never thrown.
   */
  async refreshAll(users: () => Promise<Array<{ symbols: NewsSymbol[] }>>, options: { budgetMs?: number } = {}): Promise<RefreshAllResult> {
    const deadline = this.now().getTime() + Math.min(options.budgetMs ?? REFRESH_DEADLINE_MS, REFRESH_DEADLINE_MS);
    let loaded: Array<{ symbols: NewsSymbol[] }>;
    try {
      loaded = await users();
    } catch {
      return { users: 0, symbols: 0, fetched: 0, rated: 0, skipped: 0, failures: 1, budgetLeft: await this.budgetLeft().catch(() => 0) };
    }
    const merged = new Map<string, NewsSymbol>();
    const holders = new Map<string, number>();
    for (const u of loaded) {
      for (const symbol of new Set(u.symbols.map((s) => s.symbol))) holders.set(symbol, (holders.get(symbol) ?? 0) + 1);
      for (const s of u.symbols) {
        const key = `${s.symbol}|${s.currency}`;
        const prev = merged.get(key);
        merged.set(key, prev
          ? { ...prev, isMover: prev.isMover || s.isMover, isConstituent: prev.isConstituent && s.isConstituent, usListed: prev.usListed || s.usListed, name: prev.name || s.name, kind: prev.kind ?? s.kind }
          : { ...s });
      }
    }
    // Cap order: movers first, then more holders, then the stalest fetch (never fetched is stalest).
    const distinct = [...holders.keys()];
    const mover = new Set([...merged.values()].filter((s) => s.isMover).map((s) => s.symbol));
    const last = new Map<string, number>();
    for (const symbol of distinct) {
      try {
        last.set(symbol, (await this.o.store.latestFetch(symbol))?.getTime() ?? -Infinity);
      } catch {
        last.set(symbol, -Infinity);
      }
    }
    const heldRank = [...distinct].sort((a, b) =>
      Number(mover.has(b)) - Number(mover.has(a)) || holders.get(b)! - holders.get(a)! || last.get(a)! - last.get(b)!);
    // ETF constituents (news only, for look-through) come last within the cap, from cached profiles only.
    const constituents = await this.constituentsOf([...merged.values()], new Set(distinct));
    for (const c of constituents) merged.set(`${c.symbol}|${c.currency}`, c);
    const rank = [...heldRank, ...constituents.map((c) => c.symbol)];
    const keep = new Set(rank.slice(0, MAX_SYMBOLS));
    const position = new Map(rank.map((s, i) => [s, i]));
    const capped = [...merged.values()].filter((s) => keep.has(s.symbol)).sort((a, b) => position.get(a.symbol)! - position.get(b.symbol)!);
    const result = await this.run(capped, deadline, { reserveMs: CALENDAR_RESERVE_MS, maxRatings: NIGHTLY_MAX_RATINGS });
    // Earnings projection: nightly only, with the time left after fetch, rating and stats.
    if (this.now().getTime() < deadline) result.failures += await this.projectCalendar(capped, () => this.now().getTime() >= deadline);
    // Retention (articles with ratings 90 d, deliveries 180 d, past events 90 d): nightly, best-effort, counts only.
    try {
      const swept = await this.o.store.sweep(this.now());
      this.log({ event: "news_sweep", articles: swept.articles, deliveries: swept.deliveries, events: swept.events });
    } catch {
      result.failures += 1;
    }
    return { users: loaded.length, symbols: keep.size, ...result };
  }

  /**
   * Constituent symbols of the held ETFs from the profile cache (never a new profile fetch), heaviest first; symbols
   * already held are left out. A cache miss or read failure just contributes nothing.
   */
  private async constituentsOf(symbols: NewsSymbol[], held: Set<string>): Promise<NewsSymbol[]> {
    const read = this.o.market.cachedProfile?.bind(this.o.market);
    if (!read) return [];
    const weight = new Map<string, number>();
    const seen = new Set<string>();
    for (const s of symbols) {
      if (!ETF_KINDS.has(s.kind ?? "") || seen.has(s.symbol)) continue;
      seen.add(s.symbol);
      const ticker = providerTicker({ symbol: s.symbol, kind: s.kind ?? "etf", currency: s.currency });
      if (!ticker) continue;
      let top: Array<{ symbol?: string | null; weight?: number | null }> = [];
      try {
        top = (await read(ticker))?.topHoldings ?? [];
      } catch {
        top = [];
      }
      for (const h of top) {
        const symbol = String(h.symbol ?? "").trim().toUpperCase();
        const w = Number(h.weight);
        if (!symbol || symbol === s.symbol || held.has(symbol) || !Number.isFinite(w) || w <= 0) continue;
        weight.set(symbol, (weight.get(symbol) ?? 0) + w);
      }
    }
    return [...weight.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([symbol]) => ({ symbol, currency: "USD", kind: "stock", name: null, isMover: false, isConstituent: true, usListed: false }));
  }

  /**
   * Earnings: US-listed names from EDGAR 10-Q/10-K dates (confirmed by an announced date in an earnings-typed
   * article within ±3 d); other names from announced article dates only, always "expected". Earnings dates are
   * public facts, so they are stored and shared; dividend dates are per user and never projected here. Each symbol's
   * future earnings are replaced; past ones are kept so their outcome can still be shown. A failed EDGAR read keeps
   * what is stored. Returns the number of failures.
   */
  private async projectCalendar(symbols: NewsSymbol[], past: () => boolean): Promise<number> {
    const { store } = this.o;
    const now = this.now();
    const from = new Date(torontoToday(now));
    const wanted = [...new Set(symbols.filter((s) => !s.isConstituent).map((s) => s.symbol))];
    const usListed = new Set(symbols.filter((s) => s.usListed).map((s) => s.symbol));
    let failures = 0;

    // Announced dates from earnings-typed (choice confidence ≥ 0.5), relevant, non-duplicate articles (headline +
    // snippet, code-only patterns). "confirmed" needs such a date within ±3 d of the filing projection; a date from
    // articles alone stays "expected" (est.) for every listing, US or TSX.
    const announced = new Map<string, Date[]>();
    try {
      const articles = await store.articlesForSymbols(wanted, new Date(now.getTime() - CALENDAR_ARTICLE_DAYS * DAY_MS));
      const byId = new Map(articles.map((a) => [a.id, a]));
      const ratings = articles.length > 0 ? await store.ratingsFor(articles.map((a) => a.id)) : [];
      for (const r of ratings) {
        const a = byId.get(r.articleId);
        if (!a || !a.symbols.includes(r.symbol) || r.eventType !== "earnings" || r.eventConfidence < EVENT_CONFIDENCE_GATE || r.relevant < RELEVANT_MIN || r.duplicateOf !== null) continue;
        announced.set(r.symbol, [...(announced.get(r.symbol) ?? []), ...extractDates(`${a.headline} ${a.snippet ?? ""}`, now)]);
      }
    } catch {
      failures += 1;
    }

    for (const symbol of wanted) {
      if (past()) break;
      const articleDates = announced.get(symbol) ?? [];
      try {
        let event: CalendarEvent | null = null;
        if (usListed.has(symbol) && this.o.edgar.filingDates) event = projectEarnings(symbol, await this.o.edgar.filingDates(symbol), articleDates, now);
        if (event === null && articleDates.length > 0) {
          const date = new Date(Math.min(...articleDates.map((d) => d.getTime())));
          event = { id: `earnings:${symbol}:${isoDay(date)}`, symbol, kind: "earnings", date, status: "expected", source: "article", amountPerUnit: null, currency: null };
        }
        await store.replaceEvents(symbol, "earnings", from, event ? [event] : []);
      } catch {
        failures += 1;
      }
    }
    return failures;
  }

  private async budgetLeft(): Promise<number> {
    return Math.max(0, this.o.budget - (await this.o.store.budgetSpent(torontoDay(this.now()))));
  }

  private async run(symbols: NewsSymbol[], deadline: number, o: { reserveMs?: number; maxRatings: number }): Promise<RefreshSymbolsResult> {
    const reserveMs = o.reserveMs ?? 0;
    const { store } = this.o;
    const started = this.now();
    const day = torontoDay(started);
    const past = () => this.now().getTime() >= deadline;
    const distinct = [...new Set(symbols.map((s) => s.symbol))];
    const usListed = new Set(symbols.filter((s) => s.usListed).map((s) => s.symbol));
    const names = new Map<string, string>();
    for (const s of symbols) if (s.name && !names.has(s.symbol)) names.set(s.symbol, s.name);
    const paging = { pageSize: this.o.freeTier ? 3 : 20, maxPages: this.o.freeTier ? 1 : DEFAULT_PAGES };
    let fetched = 0;
    let rated = 0;
    let failures = 0;
    const failureCodes: Record<string, number> = {};
    const fail = (code: string, n = 1) => { if (n <= 0) return; failures += n; failureCodes[code] = (failureCodes[code] ?? 0) + n; };
    let attempted = 0;
    let limit: "daily" | "throttle" | null = null;
    let deadlineHit = false;
    let statsNoHistory = 0;

    // 1. Marketaux (budgeted) + EDGAR (US-listed) for the planned symbols: the scarce, valuable part goes first.
    let spent = 0;
    try {
      spent = await store.budgetSpent(day);
    } catch {
      fail("budget_read");
      spent = this.o.budget;
    }
    if (spent < this.o.budget && distinct.length > 0) {
      const lastFetch = new Map<string, Date | null>();
      for (const s of distinct) {
        try {
          lastFetch.set(s, await store.latestFetch(s));
        } catch {
          lastFetch.set(s, null);
        }
      }
      const plan = planFetches({ symbols, lastFetch, budgetLeft: this.o.budget - spent, now: started, freeTier: this.o.freeTier, ...paging });
      // A few fetches in flight: the live run showed 32 sequential provider calls using the whole minute and
      // leaving nothing for rating. Budget charges stay serialised through the store (atomic increment).
      let next = 0;
      const worker = async () => {
        while (next < plan.length) {
          if (spent >= this.o.budget || limit) return;
          if (past()) { deadlineHit = true; return; }
          const entry = plan[next++];
          attempted += 1;
          let requests = entry.requests;
          try {
            const r = await this.o.marketaux.fetchForSymbol(entry.symbol, entry.since, { pageSize: entry.pageSize, maxPages: paging.maxPages });
            if (typeof r.requests === "number") requests = r.requests;
            const articles = [...r.articles];
            if (usListed.has(entry.symbol)) {
              try {
                articles.push(...(await this.o.edgar.fetchForSymbol(entry.symbol, entry.since)).articles);
              } catch {
                fail("edgar_fetch");
              }
            }
            // Read-modify-write after the await: `fetched += (await …)` would read a stale count with workers in flight.
            if (articles.length > 0) { const stored = (await store.upsertArticles(articles)).length; fetched += stored; }
            // An unlabelled limit is treated as a throttle: it ends this run without burning the day.
            if (r.rateLimited) limit = r.limit ?? "throttle";
            else await store.markFetched(entry.symbol, this.now());
          } catch {
            fail("marketaux_fetch");
          }
          try {
            if (requests > 0) spent = await store.spendBudget(day, requests);
            // Only daily exhaustion (402 / usage_limit_reached) spends the rest, so no later call tries today.
            if (limit === "daily" && spent < this.o.budget) spent = await store.spendBudget(day, this.o.budget - spent);
          } catch {
            fail("budget_spend");
            spent = this.o.budget;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, plan.length) }, worker));
    }
    const skipped = distinct.length - attempted;

    // 2. Rate unrated articles (also cached ones when the budget is gone). The rater (4 in flight) is bounded by the
    //    deadline and a per-run cap, not by a worst-case per-call estimate: Jev usually answers in well under a second.
    if (distinct.length > 0) {
      const left = deadline - this.now().getTime();
      // Keep the reserve back only when there is enough time for both.
      const remainingMs = left > 2 * reserveMs ? left - reserveMs : left;
      if (remainingMs <= 0) deadlineHit = true;
      else {
        try {
          rated = (await this.o.rater.rateUnrated({
            symbols: distinct,
            companyName: (s) => names.get(s) ?? s,
            deadline: new Date(this.now().getTime() + Math.min(remainingMs, REFRESH_DEADLINE_MS)),
            maxPerRun: o.maxRatings,
          })).rated;
        } catch {
          fail("rating_error");
        }
      }
    }

    // 3. Stats with whatever time is left (Yahoo history is cached, so this is not budgeted).
    if (past()) { if (symbols.length > 0) deadlineHit = true; } else {
      const { attempted: statsAttempted, ...stats } = await this.refreshStats(symbols, started, past);
      // market.history returns null both for a symbol with no data (a new listing, some crypto) and for a provider
      // outage. A few misses are expected and logged, not failures; every symbol missing reads as an outage.
      if (statsAttempted > 0 && stats.stats_no_history === statsAttempted) fail("stats_unavailable");
      else statsNoHistory = stats.stats_no_history;
      fail("stats_error", stats.stats_error);
      fail("stats_store", stats.stats_store);
    }

    const budgetLeft = Math.max(0, this.o.budget - spent);
    const result = { fetched, rated, skipped, failures, budgetLeft };
    this.log({ event: "news_refresh", symbols: distinct.length, ...result, failureCodes, statsNoHistory, rateLimited: limit !== null, limit, deadlineHit, latencyMs: this.now().getTime() - started.getTime() });
    return result;
  }

  /** Symbols attempted, and misses by reason: no history returned, a fetch error, or the stats write. */
  private async refreshStats(symbols: NewsSymbol[], now: Date, past: () => boolean): Promise<{ attempted: number; stats_no_history: number; stats_error: number; stats_store: number }> {
    const seen = new Set<string>();
    const jobs: Array<{ symbol: string; currency: string; ticker: string }> = [];
    for (const s of symbols) {
      if (s.isConstituent) continue; // ETF constituents are fetched for news only; nothing reads their stats.
      const key = `${s.symbol}|${s.currency}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ticker = providerTicker({ symbol: s.symbol, kind: s.kind ?? "stock", currency: s.currency });
      if (ticker) jobs.push({ symbol: s.symbol, currency: s.currency, ticker });
    }
    const to = torontoDay(now);
    const from = shiftDay(to, -STATS_DAYS);
    const open = torontoMarketOpen(now);
    const out: SymbolStats[] = [];
    const counts = { stats_no_history: 0, stats_error: 0, stats_store: 0 };
    let next = 0;
    const worker = async () => {
      while (next < jobs.length && !past()) {
        const job = jobs[next++];
        try {
          const points = await this.o.market.history(job.ticker, from, to);
          if (points && points.length > 0) out.push(buildStats(job.symbol, job.currency, points, now, open));
          else counts.stats_no_history += 1;
        } catch {
          counts.stats_error += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(STATS_CONCURRENCY, jobs.length) }, worker));
    if (out.length > 0) {
      try {
        await this.o.store.putStats(out);
      } catch {
        counts.stats_store += 1;
      }
    }
    return { attempted: Math.min(next, jobs.length), ...counts };
  }
}
