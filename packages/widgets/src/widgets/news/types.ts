import type { HomeAmountView } from "../../kit/home-money";

// Mirrors NewsPayload (packages/api/src/mcp/news-tools.ts); the widgets package cannot import API code.
export interface PortfolioSettingsView { benchmark: string; cadView: boolean; privacyDefault: boolean }

export type NewsWindow = "24h" | "7d" | "30d";
export type MoodLevel = "strongly_negative" | "negative" | "neutral" | "positive" | "strongly_positive";

export interface MoodView {
  level: MoodLevel | "not_enough_news";
  value: number | null;
  articles: number;
  mostRecentAt: string | null;
  estimated: true;
  /** An ETF mood from its top holdings' articles: labelled "from top holdings · est.". */
  lookThrough: boolean;
  /** An ETF without top-holdings data: "No look-through data" instead of a mood. */
  lookThroughMissing: boolean;
}

export interface NewsCard {
  articleId: string;
  headline: string;
  snippet: string | null;
  source: string;
  /** ISO time. */
  publishedAt: string;
  /** "/api/news/image/<articleId>" or null — never the publisher URL; img src = imageOrigin + imageUrl. */
  imageUrl: string | null;
  url: string;
  /** Held symbols in scope (an ETF when reached via look-through), sorted. */
  symbols: string[];
  /** Null while the article is not yet rated ("Not yet rated"; outside every mood and reason). */
  tags: { eventType: string | null; impactLevel: 0 | 1 | 2 | 3; mood: MoodLevel | null; credible: boolean } | null;
  /** Sources of collapsed duplicates, sorted, excluding this card's own source. */
  alsoReportedBy: string[];
  /** ETF constituent ticker when the card relates to no held symbol directly. */
  via: string | null;
}

export interface Mover {
  symbol: string;
  currency: string;
  returnFraction: number;
  /** Native currency. */
  dollarMove: number;
  /** True while the market is open (live quote). */
  estimated: boolean;
  flagged: true;
  limitedHistory: boolean;
  units: number;
  marketValue: number | null;
  /** Toronto YYYY-MM-DD of the session the move ends on (today while the market is open). */
  sessionDate: string;
  /** news_not_rated: articles exist but none is rated yet. `via`: the ETF constituent the reason article is about (lookThrough). */
  reason: { kind: "article" | "no_clear_news" | "nothing_explains" | "news_not_rated"; card: NewsCard | null; via: string | null; lookThrough: boolean };
  mood: MoodView;
  /** CAD view: the day's dollar move in CAD (today's value at today's rate minus the previous close at its rate; est. for USD). `dollarMove` and the percent stay native. */
  home?: HomeAmountView;
}

export interface NewsPayload {
  window: NewsWindow;
  asOf: string;
  /** Oldest latest fetch among scope symbols that have been fetched; null if none. */
  newsAsOf: string | null;
  /** Scope symbols never fetched (not covered by newsAsOf). */
  unfetched: number;
  budgetExhausted: boolean;
  portfolioMood: {
    level: MoodLevel | "not_enough_news";
    value: number | null;
    spread: { positive: number; negative: number; neutral: number; unknown: number };
  };
  /** Flagged only, ranked by |dollarMove| desc; one per SYMBOL|CURRENCY. */
  movers: Mover[];
  /** Priced, not flagged. */
  asUsual: number;
  /** No usable price: neither flagged nor "as usual". */
  unpriced: number;
  feed: NewsCard[];
  symbols: Array<{ symbol: string; mood: MoodView; sparkline: number[] }>;
  accounts: Array<{ id: string; label: string }>;
  filters: { window: NewsWindow; accountId?: string; symbol?: string; /** show_news: the requested symbol was not held; the view is unfiltered. */ symbolNotHeld?: string };
  settings: PortfolioSettingsView;
  /** Server public origin; img src = imageOrigin + card.imageUrl. */
  imageOrigin: string;
}
