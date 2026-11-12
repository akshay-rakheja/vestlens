/**
 * Pure news scoring (no I/O). Exact formulas from the news/movers/alerts global constraints:
 *   impact  = relevant × (0.5 × |sentiment − 2| / 2 + 0.3 × materiality / 3 + 0.2 × credible)
 *   recency = exp(−ageHours / 48)
 *   rank    = impact × recency
 *   mood    = recency-weighted mean of (sentiment − 2) / 2 over relevant (≥ 0.6), non-duplicate
 *             articles, requiring ≥ 2 articles; five levels at −0.6, −0.2, 0.2, 0.6.
 * Moods are always `estimated: true` (AI-rated). "not enough news" / "no clear news" are real
 * outcomes and are never replaced by a neutral.
 */
import type { ArticleRating, StoredArticle } from "./store.js";

export const RELEVANT_MIN = 0.6;
export const MOOD_MIN_ARTICLES = 2;
export const REASON_WINDOW_HOURS = 48;
export const REASON_MATERIALITY_MIN = 2;
export const REASON_CREDIBLE_MIN = 0.6;
const HOUR_MS = 3_600_000;

export type MoodLevel = "strongly_negative" | "negative" | "neutral" | "positive" | "strongly_positive";
export interface Mood {
  level: MoodLevel | "not_enough_news";
  value: number | null;
  articles: number;
  mostRecentAt: Date | null;
  estimated: boolean;
}
export interface PortfolioMood {
  level: Mood["level"];
  value: number | null;
  spread: { positive: number; negative: number; neutral: number; unknown: number };
}
export interface Reason {
  /** news_not_rated: no rated candidate, but articles from the window are still waiting for a rating. */
  kind: "article" | "no_clear_news" | "nothing_explains" | "news_not_rated";
  article?: StoredArticle;
  rating?: ArticleRating;
}

export function impact(r: ArticleRating): number {
  return r.relevant * (0.5 * (Math.abs(r.sentiment - 2) / 2) + 0.3 * (r.materiality / 3) + 0.2 * r.credible);
}

export function recency(ageHours: number): number {
  return Math.exp(-ageHours / 48);
}

/** Age in hours, clamped at 0 so a future-dated publish time never scores above 1. */
const ageHours = (now: Date, publishedAt: Date) => Math.max(0, (now.getTime() - publishedAt.getTime()) / HOUR_MS);

export function rank(r: ArticleRating, now: Date, publishedAt: Date): number {
  return impact(r) * recency(ageHours(now, publishedAt));
}

/** Tolerance so a mean that is mathematically on a cut point (e.g. 0.6000000000000001) lands nearer neutral. */
const LEVEL_EPSILON = 1e-9;

export function levelFor(value: number): MoodLevel {
  if (value < -0.6 - LEVEL_EPSILON) return "strongly_negative";
  if (value < -0.2 - LEVEL_EPSILON) return "negative";
  if (value <= 0.2 + LEVEL_EPSILON) return "neutral";
  if (value <= 0.6 + LEVEL_EPSILON) return "positive";
  return "strongly_positive";
}

const eligible = (r: ArticleRating) => r.relevant >= RELEVANT_MIN && r.duplicateOf === null;

export function weightedMoodFor(
  items: Array<{ rating: ArticleRating; publishedAt: Date; weight: number }>,
  now: Date,
): Mood {
  const kept = items.filter((i) => eligible(i.rating));
  const mostRecentAt = kept.reduce<Date | null>((m, i) => (m === null || i.publishedAt > m ? i.publishedAt : m), null);
  const notEnough: Mood = { level: "not_enough_news", value: null, articles: kept.length, mostRecentAt, estimated: true };
  if (kept.length < MOOD_MIN_ARTICLES) return notEnough;
  let num = 0;
  let den = 0;
  for (const i of kept) {
    const w = recency(ageHours(now, i.publishedAt)) * i.weight;
    num += w * ((i.rating.sentiment - 2) / 2);
    den += w;
  }
  if (!(den > 0)) return notEnough;
  const value = num / den;
  return { level: levelFor(value), value, articles: kept.length, mostRecentAt, estimated: true };
}

export function moodFor(ratings: Array<{ rating: ArticleRating; publishedAt: Date }>, now: Date): Mood {
  return weightedMoodFor(ratings.map((r) => ({ ...r, weight: 1 })), now);
}

/**
 * Weights are position values in one currency basis chosen by the caller (no conversion here).
 * `not_enough_news` items are excluded from the weighted mean and counted as `unknown`.
 * Spread counts holdings (not weight); strongly_* fold into positive/negative. If no known mood
 * has a positive weight the level is not_enough_news and every holding is counted as unknown.
 */
export function portfolioMood(items: Array<{ mood: Mood; weight: number }>): PortfolioMood {
  const spread = { positive: 0, negative: 0, neutral: 0, unknown: 0 };
  let num = 0;
  let den = 0;
  for (const { mood, weight } of items) {
    if (mood.level === "not_enough_news" || mood.value === null) {
      spread.unknown += 1;
      continue;
    }
    if (mood.level === "positive" || mood.level === "strongly_positive") spread.positive += 1;
    else if (mood.level === "negative" || mood.level === "strongly_negative") spread.negative += 1;
    else spread.neutral += 1;
    if (weight > 0) {
      num += weight * mood.value;
      den += weight;
    }
  }
  if (!(den > 0)) {
    return { level: "not_enough_news", value: null, spread: { positive: 0, negative: 0, neutral: 0, unknown: items.length } };
  }
  const value = num / den;
  return { level: levelFor(value), value, spread };
}

/**
 * `unrated`: the mover's articles that have no rating yet. When no rated candidate exists but one of them is in the
 * 48 h window, the outcome is "news_not_rated" rather than "no clear news" (which would be a false statement).
 */
export function reasonFor(articles: Array<{ article: StoredArticle; rating: ArticleRating }>, now: Date, unrated: StoredArticle[] = []): Reason {
  const candidates = articles.filter(
    (a) => eligible(a.rating) && ageHours(now, a.article.publishedAt) <= REASON_WINDOW_HOURS,
  );
  if (candidates.length === 0) {
    return unrated.some((a) => ageHours(now, a.publishedAt) <= REASON_WINDOW_HOURS) ? { kind: "news_not_rated" } : { kind: "no_clear_news" };
  }
  const qualifying = candidates.filter(
    (a) => a.rating.materiality >= REASON_MATERIALITY_MIN && a.rating.credible >= REASON_CREDIBLE_MIN,
  );
  if (qualifying.length === 0) return { kind: "nothing_explains" };
  let best = qualifying[0];
  let bestRank = rank(best.rating, now, best.article.publishedAt);
  for (const a of qualifying.slice(1)) {
    const r = rank(a.rating, now, a.article.publishedAt);
    // Deterministic tie-break: newer first, then lower article id.
    if (
      r > bestRank ||
      (r === bestRank &&
        (a.article.publishedAt > best.article.publishedAt ||
          (a.article.publishedAt.getTime() === best.article.publishedAt.getTime() && a.article.id < best.article.id)))
    ) {
      best = a;
      bestRank = r;
    }
  }
  return { kind: "article", article: best.article, rating: best.rating };
}

/**
 * Expands an ETF into its constituents' rated articles. Weights are the raw constituent weights
 * (not renormalised; the caller decides). A constituent also held directly is still included;
 * the caller dedupes by article id if needed. A constituent equal to the ETF itself is skipped.
 */
export function lookThroughRatings(
  etf: string,
  constituents: Array<{ symbol: string; weight: number }>,
  ratingsBySymbol: Map<string, Array<{ article: StoredArticle; rating: ArticleRating }>>,
): Array<{ article: StoredArticle; rating: ArticleRating; weight: number; via: string }> {
  const out: Array<{ article: StoredArticle; rating: ArticleRating; weight: number; via: string }> = [];
  for (const c of constituents) {
    if (!(c.weight > 0) || c.symbol === etf) continue;
    for (const { article, rating } of ratingsBySymbol.get(c.symbol) ?? []) {
      out.push({ article, rating, weight: c.weight, via: c.symbol });
    }
  }
  return out;
}

export type LookThroughItem = { article: StoredArticle; rating: ArticleRating; weight: number; via: string };

/**
 * Normalises look-through output for weightedMoodFor: each constituent's weight is split equally
 * across its articles (so N articles do not give N times the influence), then one entry per
 * article id is kept, the one with the largest normalised weight (first seen on ties). Output
 * order follows each kept article's first appearance.
 */
export function dedupeLookThrough(items: LookThroughItem[]): LookThroughItem[] {
  const perVia = new Map<string, number>();
  for (const i of items) perVia.set(i.via, (perVia.get(i.via) ?? 0) + 1);
  const order: string[] = [];
  const best = new Map<string, LookThroughItem>();
  for (const i of items) {
    const n: LookThroughItem = { ...i, weight: i.weight / (perVia.get(i.via) ?? 1) };
    const prev = best.get(i.article.id);
    if (prev === undefined) {
      order.push(i.article.id);
      best.set(i.article.id, n);
    } else if (n.weight > prev.weight) best.set(i.article.id, n);
  }
  return order.map((id) => best.get(id) as LookThroughItem);
}
