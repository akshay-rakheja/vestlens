// Rates stored-but-unrated (article, symbol) pairs with TypeSafe Jev and stores the ratings.
// Only the ticker, company name and article/candidate headline, snippet, source and time leave the
// server. Logs carry counts, latency and model only.
import type { JevAnswers, JevClient, JevState } from "./jev.js";
import { EVENT_TYPES } from "./questions.js";
import type { ArticleRating, NewsStore, StoredArticle } from "./store.js";

export const DEFAULT_MAX_PER_RUN = 200;
/** Only articles published in the last 30 days are rated (older ones are outside every view's window). */
export const RATING_WINDOW_DAYS = 30;
export const MAX_CANDIDATES = 5;
export const DEFAULT_CONCURRENCY = 4;
export const CANDIDATE_WINDOW_MS = 7 * 86_400_000;
export const EVENT_CONFIDENCE_GATE = 0.5;
export const DUPLICATE_GATE = 0.7;
const PUT_BATCH = 25;

export type JevRater = Pick<JevClient, "rate" | "model">;
export interface RaterLogEvent { event: "news_rating"; rated: number; failed: number; latencyMs: number; model: string }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const KNOWN_EVENTS = new Set<string>(EVENT_TYPES);

/** True when `a` counts as published before `b`; equal times are ordered by id (smaller is earlier). */
const isEarlier = (a: StoredArticle, b: StoredArticle) =>
  a.publishedAt.getTime() < b.publishedAt.getTime() || (a.publishedAt.getTime() === b.publishedAt.getTime() && a.id < b.id);

/**
 * Up to five other same-symbol articles published in the 7 days before the target, nearest first.
 * Only earlier articles are offered, so duplicateOf always points back in time and two articles can
 * never mark each other.
 */
function candidatesFor(target: StoredArticle, symbol: string, pool: StoredArticle[]): StoredArticle[] {
  const t = target.publishedAt.getTime();
  return pool
    .filter((a) => a.id !== target.id && a.symbols.includes(symbol) && isEarlier(a, target) && t - a.publishedAt.getTime() <= CANDIDATE_WINDOW_MS)
    .sort((x, y) => y.publishedAt.getTime() - x.publishedAt.getTime() || (y.id < x.id ? -1 : y.id > x.id ? 1 : 0))
    .slice(0, MAX_CANDIDATES);
}

export function toRating(o: {
  article: StoredArticle;
  symbol: string;
  answers: JevAnswers;
  aliases: Map<string, string>;
  model: string;
  ratedAt: Date;
}): ArticleRating {
  const { answers: a } = o;
  let duplicateOf: string | null = null;
  let best = -Infinity;
  for (const [alias, articleId] of o.aliases) {
    const p = a.duplicates[alias];
    if (p !== undefined && p >= DUPLICATE_GATE && p > best) {
      best = p;
      duplicateOf = articleId;
    }
  }
  const eventKnown = KNOWN_EVENTS.has(a.eventType.choice);
  return {
    articleId: o.article.id,
    symbol: o.symbol,
    model: o.model,
    ratedAt: o.ratedAt,
    relevant: clamp(a.relevant, 0, 1),
    sentiment: clamp(a.sentiment.score, 0, 4),
    sentimentConfidence: clamp(a.sentiment.confidence, 0, 1),
    materiality: clamp(a.materiality.score, 0, 3),
    eventType: eventKnown && a.eventType.confidence >= EVENT_CONFIDENCE_GATE ? a.eventType.choice : null,
    eventConfidence: clamp(a.eventType.confidence, 0, 1),
    credible: clamp(a.credible, 0, 1),
    clickbait: clamp(a.clickbait, 0, 1),
    duplicateOf,
  };
}

export async function rateUnrated(o: {
  store: NewsStore;
  jev: JevRater;
  companyName: (symbol: string) => string;
  now: () => Date;
  /** Symbols whose unrated articles to rate (held tickers and ETF constituents). */
  symbols: string[];
  maxPerRun?: number;
  /** No new rating starts once now() ≥ deadline; the remaining pairs are counted as skipped. */
  deadline?: Date;
  /** Ratings in flight at once (default 4). */
  concurrency?: number;
  log?: (e: RaterLogEvent) => void;
}): Promise<{ rated: number; failed: number; skipped?: number }> {
  const log = o.log ?? ((e: RaterLogEvent) => console.info(JSON.stringify(e)));
  const started = o.now().getTime();
  const pairs = (await o.store.unratedFor(o.symbols, new Date(started - RATING_WINDOW_DAYS * 86_400_000))).slice(0, o.maxPerRun ?? DEFAULT_MAX_PER_RUN);
  let rated = 0;
  let failed = 0;
  let skipped = 0;
  if (pairs.length > 0) {
    const earliest = Math.min(...pairs.map((p) => p.article.publishedAt.getTime()));
    const pairSymbols = [...new Set(pairs.map((p) => p.symbol))];
    const pool = await o.store.articlesForSymbols(pairSymbols, new Date(earliest - CANDIDATE_WINDOW_MS));
    const byId = new Map(pool.map((a) => [a.id, a]));
    let pending: ArticleRating[] = [];
    const flush = async () => {
      const batch = pending;
      pending = [];
      if (batch.length === 0) return;
      try {
        const stored = await o.store.putRatings(batch);
        rated += stored;
      } catch {
        failed += batch.length;
      }
    };
    let next = 0;
    const rateOne = async ({ article, symbol }: { article: StoredArticle; symbol: string }) => {
      // Short aliases keep the `candidates.<id>` state paths simple identifiers.
      const aliases = new Map(candidatesFor(article, symbol, pool).map((c, i) => [`c${i + 1}`, c.id] as const));
      const state: JevState = {
        ticker: symbol,
        company: o.companyName(symbol),
        article: { headline: article.headline, snippet: article.snippet, source: article.source, published_at: article.publishedAt.toISOString() },
        candidates: Object.fromEntries(
          [...aliases].map(([alias, id]) => {
            const c = byId.get(id)!;
            return [alias, { headline: c.headline, source: c.source, published_at: c.publishedAt.toISOString() }];
          }),
        ),
      };
      try {
        const answers = await o.jev.rate(state, [...aliases.keys()]);
        pending.push(toRating({ article, symbol, answers, aliases, model: o.jev.model, ratedAt: o.now() }));
      } catch {
        failed += 1;
      }
      if (pending.length >= PUT_BATCH) await flush();
    };
    // A small pool: each worker takes the next pair until the list or the deadline runs out.
    const worker = async () => {
      while (next < pairs.length) {
        if (o.deadline && o.now().getTime() >= o.deadline.getTime()) {
          skipped = pairs.length - next;
          next = pairs.length;
          return;
        }
        await rateOne(pairs[next++]);
      }
    };
    const workers = Math.max(1, Math.min(Math.floor(o.concurrency ?? DEFAULT_CONCURRENCY), pairs.length));
    await Promise.all(Array.from({ length: workers }, worker));
    await flush();
  }
  log({ event: "news_rating", rated, failed, latencyMs: o.now().getTime() - started, model: o.jev.model });
  return o.deadline ? { rated, failed, skipped } : { rated, failed };
}
