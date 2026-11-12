import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export interface StoredArticle {
  id: string;
  urlHash: string;
  url: string;
  headline: string;
  snippet: string | null;
  source: string;
  /**
   * The publisher's thumbnail URL. "image_url (proxied, never stored)" in the constraints means the image bytes:
   * the URL itself must be stored so `GET /api/news/image/:articleId` can proxy it. It is never sent to clients.
   */
  imageUrl: string | null;
  publishedAt: Date;
  symbols: string[];
  fetchedAt: Date;
}

export interface ArticleRating {
  articleId: string;
  symbol: string;
  model: string;
  ratedAt: Date;
  relevant: number;
  /** 0..4 weighted. */
  sentiment: number;
  sentimentConfidence: number;
  /** 0..3. */
  materiality: number;
  eventType: string | null;
  eventConfidence: number;
  credible: number;
  clickbait: number;
  duplicateOf: string | null;
}

export interface SymbolStats {
  symbol: string;
  currency: string;
  closes: number;
  typicalMove: number | null;
  lastClose: number | null;
  prevClose: number | null;
  /** Toronto-local date (YYYY-MM-DD) of lastClose; null when there is no close. */
  lastCloseDate: string | null;
  updatedAt: Date;
}

export interface CalendarEvent {
  id: string;
  symbol: string;
  kind: "earnings" | "dividend_pay";
  date: Date;
  status: "confirmed" | "expected";
  source: string;
  amountPerUnit: number | null;
  currency: string | null;
}

export interface NewsStore {
  /** Dedupes by urlHash (existing rows win; symbol tags are unioned). Returns stored rows with ids. */
  upsertArticles(a: Omit<StoredArticle, "id">[]): Promise<StoredArticle[]>;
  articlesForSymbols(symbols: string[], since: Date): Promise<StoredArticle[]>;
  /** The stored thumbnail URL of one article (image proxy only); null for an unknown or malformed id or no image. */
  articleImageUrl(id: string): Promise<string | null>;
  latestFetch(symbol: string): Promise<Date | null>;
  markFetched(symbol: string, at: Date): Promise<void>;
  /** Upserts per (articleId, symbol); ratings for unknown articleIds are skipped. Returns the number stored. */
  putRatings(r: ArticleRating[]): Promise<number>;
  ratingsFor(articleIds: string[]): Promise<ArticleRating[]>;
  /** Unrated (article, symbol) pairs for articles published on or after `since` (callers pass now − 30 d), newest first. */
  unratedFor(symbols: string[], since: Date): Promise<Array<{ article: StoredArticle; symbol: string }>>;
  putStats(s: SymbolStats[]): Promise<void>;
  stats(symbols: string[]): Promise<SymbolStats[]>;
  putEvents(e: CalendarEvent[]): Promise<void>;
  events(symbols: string[], from: Date, to: Date): Promise<CalendarEvent[]>;
  /**
   * Replaces one symbol's events of one kind dated on or after `from` with `events` (earlier events are kept,
   * so recent past dates can still show their outcome).
   */
  replaceEvents(symbol: string, kind: CalendarEvent["kind"], from: Date, events: CalendarEvent[]): Promise<void>;
  /** clientKey is stored in VarChar(512): callers pass the sha256 hex of the client key when it is longer than that. */
  /** Alert ids delivered on or after `since` (callers pass now − 180 d, the ledger's retention). */
  deliveredAlertIds(appUserId: string, clientKey: string, since: Date): Promise<Set<string>>;
  /**
   * Inserts the deliveries, skipping ones already recorded, and returns only the ids this call inserted, so two
   * concurrent calls never both deliver the same alert.
   */
  recordDeliveries(appUserId: string, clientKey: string, alertIds: string[], at: Date): Promise<string[]>;
  budgetSpent(day: string): Promise<number>;
  /**
   * Atomically adds n and returns the new running total for the day. Callers spend first and compare
   * the returned total to the cap; n must be a positive integer (otherwise this throws).
   */
  spendBudget(day: string, n: number): Promise<number>;
  /** Retention: articles (with ratings) 90 d, deliveries 180 d, calendar events dated more than 90 d ago. */
  sweep(now: Date): Promise<{ articles: number; deliveries: number; events: number }>;
}

export const ARTICLE_RETENTION_DAYS = 90;
export const DELIVERY_RETENTION_DAYS = 180;
/** Past calendar events are kept for outcomes; never longer than their articles. */
export const EVENT_RETENTION_DAYS = 90;
const SNIPPET_MAX = 200;
const DAY_MS = 86_400_000;

const clampSnippet = (s: string | null) => (s === null ? null : s.slice(0, SNIPPET_MAX));

/** Fits an article to the column sizes; null when the url is too long to store (the article is skipped). */
function fitArticle(a: Omit<StoredArticle, "id">): Omit<StoredArticle, "id"> | null {
  if (a.url.length > 2048) return null;
  return {
    ...a,
    headline: a.headline.slice(0, 500),
    source: a.source.slice(0, 200),
    snippet: clampSnippet(a.snippet),
    imageUrl: a.imageUrl !== null && a.imageUrl.length > 2048 ? null : a.imageUrl,
  };
}

function assertSpend(n: number): void {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("spendBudget: n must be a positive integer");
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
const cutoff = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

// ---------------------------------------------------------------- Prisma

export type NewsPrisma = Pick<
  PrismaClient,
  | "newsArticle"
  | "newsRating"
  | "newsSymbolFetch"
  | "newsSymbolStats"
  | "newsCalendarEvent"
  | "newsAlertDelivery"
  | "newsBudget"
>;

export class PrismaNewsStore implements NewsStore {
  constructor(private readonly db: NewsPrisma) {}

  async upsertArticles(input: Omit<StoredArticle, "id">[]): Promise<StoredArticle[]> {
    const byHash = new Map<string, Omit<StoredArticle, "id">>();
    for (const raw of input) {
      const a = fitArticle(raw);
      if (!a) continue;
      const prev = byHash.get(a.urlHash);
      byHash.set(a.urlHash, prev ? { ...prev, symbols: union(prev.symbols, a.symbols) } : a);
    }
    const wanted = [...byHash.values()];
    if (wanted.length === 0) return [];
    await this.db.newsArticle.createMany({ data: wanted, skipDuplicates: true });
    const rows = await this.db.newsArticle.findMany({ where: { urlHash: { in: wanted.map((a) => a.urlHash) } } });
    const out: StoredArticle[] = [];
    for (const row of rows) {
      const symbols = union(row.symbols, byHash.get(row.urlHash)?.symbols ?? []);
      if (symbols.length !== row.symbols.length) {
        await this.db.newsArticle.update({ where: { id: row.id }, data: { symbols } });
        out.push({ ...row, symbols });
      } else {
        out.push(row);
      }
    }
    const order = new Map(wanted.map((a, i) => [a.urlHash, i]));
    return out.sort((x, y) => order.get(x.urlHash)! - order.get(y.urlHash)!);
  }

  articlesForSymbols(symbols: string[], since: Date): Promise<StoredArticle[]> {
    if (symbols.length === 0) return Promise.resolve([]);
    return this.db.newsArticle.findMany({
      where: { symbols: { hasSome: symbols }, publishedAt: { gte: since } },
      orderBy: { publishedAt: "desc" },
    });
  }

  async articleImageUrl(id: string): Promise<string | null> {
    if (!UUID.test(id)) return null;
    const row = await this.db.newsArticle.findUnique({ where: { id }, select: { imageUrl: true } });
    return row?.imageUrl ?? null;
  }

  async latestFetch(symbol: string): Promise<Date | null> {
    const row = await this.db.newsSymbolFetch.findUnique({ where: { symbol } });
    return row?.fetchedAt ?? null;
  }

  async markFetched(symbol: string, at: Date): Promise<void> {
    await this.db.newsSymbolFetch.upsert({ where: { symbol }, create: { symbol, fetchedAt: at }, update: { fetchedAt: at } });
  }

  async putRatings(all: ArticleRating[]): Promise<number> {
    if (all.length === 0) return 0;
    const known = new Set(
      (await this.db.newsArticle.findMany({ where: { id: { in: [...new Set(all.map((r) => r.articleId))] } }, select: { id: true } })).map((r) => r.id),
    );
    const ratings = all.filter((r) => known.has(r.articleId));
    await Promise.all(
      ratings.map(({ articleId, symbol, ...rest }) =>
        this.db.newsRating.upsert({
          where: { articleId_symbol: { articleId, symbol } },
          create: { articleId, symbol, ...rest },
          update: rest,
        }),
      ),
    );
    return ratings.length;
  }

  async ratingsFor(articleIds: string[]): Promise<ArticleRating[]> {
    if (articleIds.length === 0) return [];
    const rows = await this.db.newsRating.findMany({ where: { articleId: { in: articleIds } } });
    return rows.map(({ id: _id, ...r }) => r);
  }

  async unratedFor(symbols: string[], since: Date): Promise<Array<{ article: StoredArticle; symbol: string }>> {
    if (symbols.length === 0) return [];
    const wanted = new Set(symbols);
    const rows = await this.db.newsArticle.findMany({
      where: { symbols: { hasSome: symbols }, publishedAt: { gte: since } },
      include: { ratings: { select: { symbol: true } } },
      orderBy: { publishedAt: "desc" },
    });
    const out: Array<{ article: StoredArticle; symbol: string }> = [];
    for (const { ratings, ...article } of rows) {
      const rated = new Set(ratings.map((r) => r.symbol));
      for (const symbol of article.symbols) if (wanted.has(symbol) && !rated.has(symbol)) out.push({ article, symbol });
    }
    return out;
  }

  async putStats(stats: SymbolStats[]): Promise<void> {
    await Promise.all(
      stats.map((s) =>
        this.db.newsSymbolStats.upsert({
          where: { symbol_currency: { symbol: s.symbol, currency: s.currency } },
          create: s,
          update: s,
        }),
      ),
    );
  }

  stats(symbols: string[]): Promise<SymbolStats[]> {
    if (symbols.length === 0) return Promise.resolve([]);
    return this.db.newsSymbolStats.findMany({ where: { symbol: { in: symbols } } });
  }

  async putEvents(events: CalendarEvent[]): Promise<void> {
    await Promise.all(
      events.map(({ id, ...rest }) => this.db.newsCalendarEvent.upsert({ where: { id }, create: { id, ...rest }, update: rest })),
    );
  }

  async events(symbols: string[], from: Date, to: Date): Promise<CalendarEvent[]> {
    if (symbols.length === 0) return [];
    const rows = await this.db.newsCalendarEvent.findMany({
      where: { symbol: { in: symbols }, date: { gte: from, lte: to } },
      orderBy: { date: "asc" },
    });
    return rows as CalendarEvent[];
  }

  async replaceEvents(symbol: string, kind: CalendarEvent["kind"], from: Date, events: CalendarEvent[]): Promise<void> {
    await this.db.newsCalendarEvent.deleteMany({ where: { symbol, kind, date: { gte: from }, id: { notIn: events.map((e) => e.id) } } });
    await this.putEvents(events);
  }

  async deliveredAlertIds(appUserId: string, clientKey: string, since: Date): Promise<Set<string>> {
    const rows = await this.db.newsAlertDelivery.findMany({ where: { appUserId, clientKey, deliveredAt: { gte: since } }, select: { alertId: true } });
    return new Set(rows.map((r) => r.alertId));
  }

  async recordDeliveries(appUserId: string, clientKey: string, alertIds: string[], at: Date): Promise<string[]> {
    if (alertIds.length === 0) return [];
    // ON CONFLICT DO NOTHING ... RETURNING: only rows this statement inserted come back.
    const rows = await this.db.newsAlertDelivery.createManyAndReturn({
      data: [...new Set(alertIds)].map((alertId) => ({ appUserId, clientKey, alertId, deliveredAt: at })),
      skipDuplicates: true,
      select: { alertId: true },
    });
    return rows.map((r) => r.alertId);
  }

  async budgetSpent(day: string): Promise<number> {
    return (await this.db.newsBudget.findUnique({ where: { day } }))?.spent ?? 0;
  }

  async spendBudget(day: string, n: number): Promise<number> {
    assertSpend(n);
    const row = await this.db.newsBudget.upsert({
      where: { day },
      create: { day, spent: n },
      update: { spent: { increment: n } },
    });
    return row.spent;
  }

  async sweep(now: Date): Promise<{ articles: number; deliveries: number; events: number }> {
    const [articles, deliveries, events] = await Promise.all([
      this.db.newsArticle.deleteMany({ where: { publishedAt: { lt: cutoff(now, ARTICLE_RETENTION_DAYS) } } }),
      this.db.newsAlertDelivery.deleteMany({ where: { deliveredAt: { lt: cutoff(now, DELIVERY_RETENTION_DAYS) } } }),
      this.db.newsCalendarEvent.deleteMany({ where: { date: { lt: cutoff(now, EVENT_RETENTION_DAYS) } } }),
    ]);
    return { articles: articles.count, deliveries: deliveries.count, events: events.count };
  }
}

// ---------------------------------------------------------------- Memory fake

export class MemoryNewsStore implements NewsStore {
  private articles = new Map<string, StoredArticle>(); // by urlHash
  private ratings = new Map<string, ArticleRating>(); // by articleId|symbol
  private fetches = new Map<string, Date>();
  private statsMap = new Map<string, SymbolStats>();
  private eventsMap = new Map<string, CalendarEvent>();
  private deliveries = new Map<string, { appUserId: string; clientKey: string; alertId: string; deliveredAt: Date }>();
  private budget = new Map<string, number>();

  private static ratingKey = (articleId: string, symbol: string) => JSON.stringify([articleId, symbol]);
  private static deliveryKey = (u: string, c: string, a: string) => JSON.stringify([u, c, a]);
  private static copy = (a: StoredArticle): StoredArticle => ({ ...a, symbols: [...a.symbols] });

  async upsertArticles(input: Omit<StoredArticle, "id">[]): Promise<StoredArticle[]> {
    const out = new Map<string, StoredArticle>();
    for (const raw of input) {
      const a = fitArticle(raw);
      if (!a) continue;
      const existing = this.articles.get(a.urlHash);
      if (existing) {
        existing.symbols = union(existing.symbols, a.symbols);
        out.set(a.urlHash, existing);
      } else {
        const row: StoredArticle = { ...a, id: randomUUID(), symbols: union([], a.symbols) };
        this.articles.set(a.urlHash, row);
        out.set(a.urlHash, row);
      }
    }
    return [...out.values()].map(MemoryNewsStore.copy);
  }

  async articlesForSymbols(symbols: string[], since: Date): Promise<StoredArticle[]> {
    return [...this.articles.values()]
      .filter((a) => a.publishedAt >= since && a.symbols.some((s) => symbols.includes(s)))
      .sort((x, y) => y.publishedAt.getTime() - x.publishedAt.getTime())
      .map(MemoryNewsStore.copy);
  }

  async articleImageUrl(id: string): Promise<string | null> {
    if (!UUID.test(id)) return null;
    for (const a of this.articles.values()) if (a.id === id) return a.imageUrl;
    return null;
  }

  async latestFetch(symbol: string): Promise<Date | null> {
    return this.fetches.get(symbol) ?? null;
  }

  async markFetched(symbol: string, at: Date): Promise<void> {
    this.fetches.set(symbol, at);
  }

  async putRatings(r: ArticleRating[]): Promise<number> {
    const known = new Set([...this.articles.values()].map((a) => a.id));
    let stored = 0;
    for (const x of r) {
      if (!known.has(x.articleId)) continue;
      this.ratings.set(MemoryNewsStore.ratingKey(x.articleId, x.symbol), { ...x });
      stored += 1;
    }
    return stored;
  }

  async ratingsFor(articleIds: string[]): Promise<ArticleRating[]> {
    return [...this.ratings.values()].filter((r) => articleIds.includes(r.articleId)).map((r) => ({ ...r }));
  }

  async unratedFor(symbols: string[], since: Date): Promise<Array<{ article: StoredArticle; symbol: string }>> {
    const out: Array<{ article: StoredArticle; symbol: string }> = [];
    for (const a of [...this.articles.values()].filter((x) => x.publishedAt >= since).sort((x, y) => y.publishedAt.getTime() - x.publishedAt.getTime())) {
      for (const symbol of a.symbols) {
        if (symbols.includes(symbol) && !this.ratings.has(MemoryNewsStore.ratingKey(a.id, symbol))) {
          out.push({ article: MemoryNewsStore.copy(a), symbol });
        }
      }
    }
    return out;
  }

  async putStats(s: SymbolStats[]): Promise<void> {
    for (const x of s) this.statsMap.set(JSON.stringify([x.symbol, x.currency]), { ...x });
  }

  async stats(symbols: string[]): Promise<SymbolStats[]> {
    return [...this.statsMap.values()].filter((s) => symbols.includes(s.symbol)).map((s) => ({ ...s }));
  }

  async putEvents(e: CalendarEvent[]): Promise<void> {
    for (const x of e) this.eventsMap.set(x.id, { ...x });
  }

  async events(symbols: string[], from: Date, to: Date): Promise<CalendarEvent[]> {
    return [...this.eventsMap.values()]
      .filter((e) => symbols.includes(e.symbol) && e.date >= from && e.date <= to)
      .sort((x, y) => x.date.getTime() - y.date.getTime())
      .map((e) => ({ ...e }));
  }

  async replaceEvents(symbol: string, kind: CalendarEvent["kind"], from: Date, events: CalendarEvent[]): Promise<void> {
    const keep = new Set(events.map((e) => e.id));
    for (const [id, e] of this.eventsMap) if (e.symbol === symbol && e.kind === kind && e.date >= from && !keep.has(id)) this.eventsMap.delete(id);
    await this.putEvents(events);
  }

  async deliveredAlertIds(appUserId: string, clientKey: string, since: Date): Promise<Set<string>> {
    const out = new Set<string>();
    for (const d of this.deliveries.values()) if (d.appUserId === appUserId && d.clientKey === clientKey && d.deliveredAt >= since) out.add(d.alertId);
    return out;
  }

  async recordDeliveries(appUserId: string, clientKey: string, alertIds: string[], at: Date): Promise<string[]> {
    const inserted: string[] = [];
    for (const alertId of new Set(alertIds)) {
      const key = MemoryNewsStore.deliveryKey(appUserId, clientKey, alertId);
      if (this.deliveries.has(key)) continue;
      this.deliveries.set(key, { appUserId, clientKey, alertId, deliveredAt: at });
      inserted.push(alertId);
    }
    return inserted;
  }

  async budgetSpent(day: string): Promise<number> {
    return this.budget.get(day) ?? 0;
  }

  async spendBudget(day: string, n: number): Promise<number> {
    assertSpend(n);
    const total = (this.budget.get(day) ?? 0) + n;
    this.budget.set(day, total);
    return total;
  }

  async sweep(now: Date): Promise<{ articles: number; deliveries: number; events: number }> {
    const eventCut = cutoff(now, EVENT_RETENTION_DAYS);
    let events = 0;
    for (const [id, e] of this.eventsMap) {
      if (e.date < eventCut) {
        this.eventsMap.delete(id);
        events += 1;
      }
    }
    const articleCut = cutoff(now, ARTICLE_RETENTION_DAYS);
    const deliveryCut = cutoff(now, DELIVERY_RETENTION_DAYS);
    let articles = 0;
    for (const [hash, a] of this.articles) {
      if (a.publishedAt < articleCut) {
        this.articles.delete(hash);
        for (const key of [...this.ratings.keys()]) if (this.ratings.get(key)!.articleId === a.id) this.ratings.delete(key);
        articles += 1;
      }
    }
    let deliveries = 0;
    for (const [key, d] of this.deliveries) {
      if (d.deliveredAt < deliveryCut) {
        this.deliveries.delete(key);
        deliveries += 1;
      }
    }
    return { articles, deliveries, events };
  }
}
