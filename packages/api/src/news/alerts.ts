/**
 * Pure alert building plus ledgered delivery. Material items only (global constraints):
 *   unusual_move       flagged mover                                   materiality 2 (3 at |return| ≥ 6%)
 *   news               relevant ≥ 0.6, materiality ≥ 2, credible ≥ 0.6, non-duplicate; one per article
 *   earnings_upcoming  earnings event 1..3 Toronto days ahead, or today  materiality 2
 *                      (day 0) while no earnings article from the event day exists ("expected to report today")
 *   earnings_reported  needs an earnings article, whatever the status:     materiality 3
 *                      day 0: published on/after the event day (Toronto); days −1/−2: published ≥ event − 1 d
 *                      (a passed date without such an article emits nothing: a date is not a report)
 *   dividend_upcoming  projected pay date 0..2 Toronto days ahead        materiality 1
 * Windows compare whole days: eventDay (UTC-midnight date) − Toronto today.
 * Summaries are assembled here from fixed templates only; they never contain buy/sell/hold language, and
 * those that carry model-derived labels end with " AI-rated; may be wrong."
 */
import { createHash } from "node:crypto";
import { isoDay, torontoToday } from "./calendar.js";
import type { Mover } from "./movers.js";
import { levelFor, type MoodLevel, rank, REASON_CREDIBLE_MIN, REASON_MATERIALITY_MIN, RELEVANT_MIN } from "./scoring.js";
import { type ArticleRating, type CalendarEvent, DELIVERY_RETENTION_DAYS, type NewsStore, type StoredArticle } from "./store.js";

/**
 * Ids are deterministic and symbol-stable where it matters for the delivery ledger:
 *   unusual_move:<SYM>:<session YYYY-MM-DD (Mover.sessionDate)>   news:<articleId> (symbol-independent; `symbol` is the
 *   highest-ranked holding the article is attached to, so a re-rating never re-alerts the same article)
 *   earnings_upcoming|earnings_reported|dividend_upcoming:<SYM>:<event YYYY-MM-DD>
 */
export interface Alert {
  id: string;
  symbol: string;
  kind: "news" | "earnings_upcoming" | "earnings_reported" | "dividend_upcoming" | "unusual_move";
  materiality: number;
  mood: MoodLevel | null;
  headline: string | null;
  source: string | null;
  url: string | null;
  publishedAt: string | null;
  summary: string;
}

export interface SummaryExtra {
  /** unusual_move: the session's return as a fraction. */
  returnFraction?: number;
  /** unusual_move: the session the move ends on (YYYY-MM-DD); "today" only when it is Toronto today. */
  sessionDate?: string;
  /** calendar kinds: the event date (UTC-midnight date-only value). */
  date?: Date;
  /** earnings_upcoming: true when the date is projected (status "expected"). */
  estimated?: boolean;
  /** earnings_upcoming: the event is today (Toronto); renders "today" instead of the date. */
  today?: boolean;
  /** news: reference time for the relative age. */
  now?: Date;
}

export const ALERT_CAP = 10;
export const CLIENT_KEY_MAX = 512;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const BIG_MOVE = 2 * 0.015 * 2; // 6%
const REL_TOL = 1e-9;
const EARNINGS_UPCOMING_DAYS = 3;
const EARNINGS_REPORTED_DAYS = 2;
const DIVIDEND_UPCOMING_DAYS = 2;
const MATERIALITY_WORDS = ["minimal", "low", "meaningful", "high"] as const;
const AI_CAVEAT = " AI-rated; may be wrong.";
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const torontoDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });

const moodWord = (m: MoodLevel | null) => (m === null ? "unrated" : m.replace("_", " "));
const materialityWord = (n: number) => MATERIALITY_WORDS[Math.min(3, Math.max(0, Math.round(n)))];
const monDay = (d: Date) => `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
const pct = (f: number) => `${(Math.abs(f) * 100).toFixed(1)}%`;
const moodOf = (r: ArticleRating): MoodLevel => levelFor((r.sentiment - 2) / 2);

function age(publishedAt: string | null, now: Date | undefined): string {
  if (publishedAt === null || now === undefined) return "time unknown";
  const hours = Math.max(0, (now.getTime() - Date.parse(publishedAt)) / HOUR_MS);
  if (hours < 1) return "under 1 h ago";
  if (hours < 48) return `${Math.floor(hours)} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function summaryFor(a: Omit<Alert, "summary">, extra: SummaryExtra): string {
  const date = extra.date ? monDay(extra.date) : "a date not yet known";
  switch (a.kind) {
    case "unusual_move": {
      const f = extra.returnFraction ?? 0;
      const when = extra.sessionDate === undefined || (extra.now && extra.sessionDate === torontoDay.format(extra.now))
        ? "today"
        : `on ${monDay(new Date(`${extra.sessionDate}T00:00:00Z`))}`;
      return `${a.symbol} ${f < 0 ? "fell" : "rose"} ${pct(f)} ${when}, more than its usual move.`;
    }
    case "news":
      return `${a.symbol}: ${a.headline} (${a.source}, ${age(a.publishedAt, extra.now)}), rated ${moodWord(a.mood)}, ${materialityWord(a.materiality)} materiality.${AI_CAVEAT}`;
    case "earnings_upcoming":
      return `${a.symbol} is expected to report earnings ${extra.today ? "today" : `on ${date}`}${extra.estimated ? " (estimated)" : ""}.`;
    case "earnings_reported":
      return `${a.symbol} reported earnings; top-rated news: ${a.headline} (${a.source}), rated ${moodWord(a.mood)}.${AI_CAVEAT}`;
    case "dividend_upcoming":
      return `${a.symbol} dividend pay date expected ${date} (estimated).`;
  }
}

type Rated = { article: StoredArticle; rating: ArticleRating };
const usable = (r: ArticleRating) => r.relevant >= RELEVANT_MIN && r.duplicateOf === null;
const material = (r: ArticleRating) => usable(r) && r.materiality >= REASON_MATERIALITY_MIN && r.credible >= REASON_CREDIBLE_MIN;

/** Higher rank wins; ties: newer, then lower article id, then lower symbol. */
function better(a: Rated & { symbol: string }, b: Rated & { symbol: string }, now: Date): boolean {
  const ra = rank(a.rating, now, a.article.publishedAt);
  const rb = rank(b.rating, now, b.article.publishedAt);
  if (ra !== rb) return ra > rb;
  const ta = a.article.publishedAt.getTime();
  const tb = b.article.publishedAt.getTime();
  if (ta !== tb) return ta > tb;
  if (a.article.id !== b.article.id) return a.article.id < b.article.id;
  return a.symbol < b.symbol;
}

const articleFields = (x: Rated) => ({
  mood: moodOf(x.rating),
  headline: x.article.headline,
  source: x.article.source,
  url: x.article.url,
  publishedAt: x.article.publishedAt.toISOString(),
});
const noArticle = { mood: null, headline: null, source: null, url: null, publishedAt: null };

export function buildAlerts(o: {
  movers: Mover[];
  ratings: Map<string, Array<{ article: StoredArticle; rating: ArticleRating }>>;
  events: CalendarEvent[];
  now: Date;
}): Alert[] {
  const { now } = o;
  const out = new Map<string, Alert>();
  const push = (a: Omit<Alert, "summary">, extra: SummaryExtra) => {
    if (!out.has(a.id)) out.set(a.id, { ...a, summary: summaryFor(a, extra) });
  };

  // Unusual moves: one per symbol (largest |return| when a symbol trades in several currencies), keyed by session.
  const moves = new Map<string, Mover>();
  for (const m of o.movers) {
    if (!m.flagged || !Number.isFinite(m.returnFraction)) continue;
    const prev = moves.get(m.symbol);
    if (!prev || Math.abs(m.returnFraction) > Math.abs(prev.returnFraction)) moves.set(m.symbol, m);
  }
  for (const m of moves.values()) {
    const big = Math.abs(m.returnFraction) >= BIG_MOVE * (1 - REL_TOL);
    push({ id: `unusual_move:${m.symbol}:${m.sessionDate}`, symbol: m.symbol, kind: "unusual_move", materiality: big ? 3 : 2, ...noArticle }, { returnFraction: m.returnFraction, sessionDate: m.sessionDate, now });
  }

  // News: one alert per article, attached to the symbol where it ranks highest.
  const best = new Map<string, Rated & { symbol: string }>();
  for (const [symbol, items] of o.ratings) {
    for (const x of items) {
      if (!material(x.rating)) continue;
      const cand = { ...x, symbol };
      const prev = best.get(x.article.id);
      if (!prev || better(cand, prev, now)) best.set(x.article.id, cand);
    }
  }
  for (const x of best.values()) {
    push({ id: `news:${x.article.id}`, symbol: x.symbol, kind: "news", materiality: x.rating.materiality, ...articleFields(x) }, { now });
  }

  // Calendar: whole Toronto days between the event's date and today.
  const todayStart = torontoToday(now);
  for (const e of o.events) {
    const at = e.date.getTime();
    const dayOffset = Math.round((at - todayStart) / DAY_MS);
    const day = isoDay(e.date);
    if (e.kind === "earnings") {
      if (dayOffset >= 1 && dayOffset <= EARNINGS_UPCOMING_DAYS) {
        push({ id: `earnings_upcoming:${e.symbol}:${day}`, symbol: e.symbol, kind: "earnings_upcoming", materiality: 2, ...noArticle }, { date: e.date, estimated: e.status !== "confirmed" });
      } else if (dayOffset <= 0 && dayOffset >= -EARNINGS_REPORTED_DAYS) {
        // Day 0: only coverage from the event day itself counts (a day-before preview is not a report).
        // Days −1/−2: coverage from the day before the event onward (not last quarter's).
        const qualifies = (x: Rated) =>
          dayOffset === 0 ? torontoDay.format(x.article.publishedAt) >= day : x.article.publishedAt.getTime() >= at - DAY_MS;
        let top: (Rated & { symbol: string }) | null = null;
        for (const x of o.ratings.get(e.symbol) ?? []) {
          if (x.rating.eventType !== "earnings" || !usable(x.rating) || !qualifies(x)) continue;
          const cand = { ...x, symbol: e.symbol };
          if (top === null || better(cand, top, now)) top = cand;
        }
        if (top === null && dayOffset === 0) {
          // "confirmed" confirms the date, not that the report has happened
          push({ id: `earnings_upcoming:${e.symbol}:${day}`, symbol: e.symbol, kind: "earnings_upcoming", materiality: 2, ...noArticle }, { date: e.date, estimated: e.status !== "confirmed", today: true });
          continue;
        }
        // a passed date, confirmed or not, is not evidence of a report: "reported" needs an article
        if (top === null) continue;
        push({ id: `earnings_reported:${e.symbol}:${day}`, symbol: e.symbol, kind: "earnings_reported", materiality: 3, ...articleFields(top) }, { date: e.date });
      }
    } else if (e.kind === "dividend_pay" && dayOffset >= 0 && dayOffset <= DIVIDEND_UPCOMING_DAYS) {
      push({ id: `dividend_upcoming:${e.symbol}:${day}`, symbol: e.symbol, kind: "dividend_upcoming", materiality: 1, ...noArticle }, { date: e.date });
    }
  }
  return [...out.values()];
}

/** Ledger key column is VarChar(512): longer client keys are stored as their sha256 hex. */
export const ledgerClientKey = (clientKey: string) =>
  clientKey.length > CLIENT_KEY_MAX ? createHash("sha256").update(clientKey).digest("hex") : clientKey;

const publishedMs = (a: Alert) => (a.publishedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(a.publishedAt));

/**
 * Returns at most `cap` (default 10) alerts not yet delivered to (appUserId, clientKey), ordered by
 * materiality desc then publishedAt desc (undated last, then id). The deliveries are recorded before
 * returning, and only the alerts this call actually inserted are returned: a concurrent call that chose
 * the same alerts gets none of them, so each alert reaches a client once.
 */
export async function deliver(o: {
  store: NewsStore;
  appUserId: string;
  clientKey: string;
  alerts: Alert[];
  now: Date;
  cap?: number;
}): Promise<{ alerts: Alert[]; quiet: boolean }> {
  const key = ledgerClientKey(o.clientKey);
  const cap = Math.max(0, Math.floor(o.cap ?? ALERT_CAP));
  const delivered = await o.store.deliveredAlertIds(o.appUserId, key, new Date(o.now.getTime() - DELIVERY_RETENTION_DAYS * DAY_MS));
  const fresh = new Map<string, Alert>();
  for (const a of o.alerts) if (!delivered.has(a.id) && !fresh.has(a.id)) fresh.set(a.id, a);
  const chosen = [...fresh.values()]
    .sort((x, y) => y.materiality - x.materiality || publishedMs(y) - publishedMs(x) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .slice(0, cap);
  if (chosen.length === 0) return { alerts: [], quiet: true };
  const inserted = new Set(await o.store.recordDeliveries(o.appUserId, key, chosen.map((a) => a.id), o.now));
  const alerts = chosen.filter((a) => inserted.has(a.id));
  return { alerts, quiet: alerts.length === 0 };
}
