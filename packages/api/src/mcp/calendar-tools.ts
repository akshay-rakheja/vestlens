import { z } from "zod";
import { aggregateHoldings, type HoldingRow } from "../analytics/holdings.js";
import { isoDay, projectDividends, torontoToday } from "../news/calendar.js";
import type { DividendPayment } from "../news/refresh-service.js";
import { sumHome, type HomeAmount, type HomeTotal } from "../fx/home-currency.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import { levelFor, rank, RELEVANT_MIN, type MoodLevel } from "../news/scoring.js";
import type { ArticleRating, CalendarEvent, NewsStore, StoredArticle } from "../news/store.js";
import type { PortfolioPresentation, PortfolioPresentationAccount } from "../portfolio/portfolio-presentation.js";
import type { PortfolioSettingsView, SettingsService } from "../settings/settings-service.js";
import { listAccounts } from "./activity-tools.js";
import { ADVICE_NOTE, NEWS_KINDS, RATING_CAVEAT } from "./news-tools.js";
import { CAD_NOTE, homeConverterFor } from "./home-fx.js";
import { loadSettings } from "./overview-tools.js";

export const CALENDAR_WIDGET = "calendar";
export const CALENDAR_WIDGET_URI = "ui://portfolio/calendar-v1";
export const CALENDAR_RANGES = ["2w", "1m", "3m"] as const;
export type CalendarRange = (typeof CALENDAR_RANGES)[number];
const RANGE_DAYS: Record<CalendarRange, number> = { "2w": 14, "1m": 30, "3m": 90 };
const RANGE_WORDS: Record<CalendarRange, string> = { "2w": "two weeks", "1m": "month", "3m": "three months" };
const DAY_MS = 86_400_000;
/** Recent past events stay visible (with their outcome) for this many days. */
const PAST_DAYS = 7;
const MAX_EVENTS = 200;
const TEXT_EVENTS = 5;
const MODEL_EVENTS = 20;
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const ESTIMATE_NOTE = "Dates marked est. are projected from past filings and payments and may be wrong.";

const NO_AMOUNT_NOTE = "A dividend with a null perUnit has its date only: units changed around the last payment, so the amount can't be told, and it is not in any total.";

export const calendarInput = z.object({
  range: z.enum(CALENDAR_RANGES).optional(),
  accountId: z.string().min(1).optional(),
}).strict();
export type CalendarInput = z.infer<typeof calendarInput>;

/** The requesting user's own past dividend payments in the given accounts (stored activities; no provider read). */
export type UserDividends = (authSubject: string, accounts: PortfolioPresentationAccount[]) => Promise<DividendPayment[]>;

/** Dividend pay dates for one user, projected now from that user's own payments; [] when they cannot be read. */
export async function userDividendEvents(dividends: UserDividends | undefined, authSubject: string, accounts: PortfolioPresentationAccount[], held: string[], now: Date): Promise<CalendarEvent[]> {
  if (!dividends || held.length === 0) return [];
  try {
    return projectDividends(await dividends(authSubject, accounts), new Set(held), now);
  } catch {
    return [];
  }
}

export interface CalendarDeps {
  /** Shared, public earnings dates (stored dividend rows, if any, are ignored). */
  store: Pick<NewsStore, "events" | "articlesForSymbols" | "ratingsFor">;
  /** Per-user dividend projection input; absent means no dividend events. */
  dividends?: UserDividends;
  settings: Pick<SettingsService, "get">;
  /** Bank of Canada USD/CAD rates for the CAD view; without it USD dividends stay not converted. */
  market?: Partial<Pick<MarketDataService, "usdCad">>;
  marketDeadlineMs?: number;
  now?: () => Date;
}

/**
 * One calendar entry. Known v1 gap: a projected dividend pay date that has passed stays "expected" (est.) even
 * after the brokerage reports the payment; it is not yet marked confirmed from activity.
 */
export interface CalendarEventView {
  id: string;
  symbol: string;
  kind: CalendarEvent["kind"];
  /** YYYY-MM-DD. */
  date: string;
  status: CalendarEvent["status"];
  /** True unless "confirmed" (an earnings article date within ±3 d of the filing projection); the same rule for every listing. */
  estimated: boolean;
  /** Dividends: last payment per unit × units held now in scope (an estimate); null when units changed around that payment. */
  amount: {
    perUnit: number; units: number; total: number; currency: string;
    /** CAD view only: the total in CAD at the latest Bank of Canada rate (est. for USD), the native total kept in `native`. */
    home?: HomeAmount;
  } | null;
  /** Past earnings: the top-ranked earnings article since the day before, with its AI-rated mood. */
  outcome: { headline: string; source: string; mood: MoodLevel } | null;
}

export interface CalendarPayload {
  range: CalendarRange;
  asOf: string;
  /** Weeks (Monday start) that have events, ascending; events by date, then symbol. */
  weeks: Array<{ weekStart: string; events: CalendarEventView[] }>;
  /** Events still ahead (today included) in the current week. */
  thisWeek: { earnings: number; dividends: number };
  accounts: Array<{ id: string; label: string }>;
  filters: { range: CalendarRange; accountId?: string };
  settings: PortfolioSettingsView;
  /** CAD view only: the projected dividend payments in the listed weeks, summed in CAD. */
  home?: { dividends: HomeTotal };
}

export class CalendarScopeError extends Error {
  readonly code = "unknown_account" as const;
  constructor() { super("unknown_account"); this.name = "CalendarScopeError"; }
}

const torontoDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });
const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;
/** Monday of the (UTC date-only) day. */
const weekStartOf = (t: number) => t - ((new Date(t).getUTCDay() + 6) % 7) * DAY_MS;
type Rated = { article: StoredArticle; rating: ArticleRating };

/** Top earnings article for a passed date: day 0 needs same-day coverage; later days count from the day before (as alerts do). */
function outcomeFor(e: CalendarEvent, rated: Rated[], today: number, now: Date): CalendarEventView["outcome"] {
  const at = e.date.getTime();
  const day = isoDay(e.date);
  let best: { x: Rated; r: number } | null = null;
  for (const x of rated) {
    const { rating, article } = x;
    if (rating.symbol !== e.symbol || rating.eventType !== "earnings" || rating.relevant < RELEVANT_MIN || rating.duplicateOf !== null) continue;
    if (at === today ? torontoDay.format(article.publishedAt) < day : article.publishedAt.getTime() < at - DAY_MS) continue;
    const r = rank(rating, now, article.publishedAt);
    if (!best || r > best.r || (r === best.r && article.publishedAt > best.x.article.publishedAt)
      || (r === best.r && article.publishedAt.getTime() === best.x.article.publishedAt.getTime() && article.id < best.x.article.id)) best = { x, r };
  }
  return best ? { headline: best.x.article.headline, source: best.x.article.source, mood: levelFor((best.x.rating.sentiment - 2) / 2) } : null;
}

export async function buildCalendarPayload(deps: CalendarDeps, portfolio: PortfolioPresentation, authSubject: string, input: CalendarInput): Promise<CalendarPayload> {
  const listed = listAccounts(portfolio).filter((a) => a.kind !== "credit");
  if (input.accountId !== undefined && !listed.some((a) => a.id === input.accountId)) throw new CalendarScopeError();
  const range: CalendarRange = input.range ?? "1m";
  const now = (deps.now ?? (() => new Date()))();
  const today = torontoToday(now);
  const rows: HoldingRow[] = aggregateHoldings(portfolio.accounts, input.accountId !== undefined ? { accountId: input.accountId } : {}).rows
    .filter((r) => NEWS_KINDS.has(r.kind));
  const held = [...new Set(rows.map((r) => r.symbol))].sort();
  const unitsOf = (symbol: string, currency: string | null) => {
    const mine = rows.filter((r) => r.symbol === symbol);
    const same = mine.filter((r) => r.currency === currency);
    return (same.length > 0 ? same : mine).reduce((sum, r) => sum + r.units, 0);
  };

  const from = today - PAST_DAYS * DAY_MS;
  const to = today + RANGE_DAYS[range] * DAY_MS;
  const scopeAccounts = portfolio.accounts.filter((a) => input.accountId === undefined || a.id === input.accountId);
  const [stored, dividends, settings] = await Promise.all([
    held.length > 0 ? deps.store.events(held, new Date(from), new Date(to)).catch((): CalendarEvent[] => []) : Promise.resolve([]),
    userDividendEvents(deps.dividends, authSubject, scopeAccounts, held, now),
    loadSettings(deps as Parameters<typeof loadSettings>[0], authSubject),
  ]);
  // Earnings dates are shared public facts; dividends are this user's own projection only.
  const events = [...stored.filter((e) => e.kind === "earnings"), ...dividends.filter((e) => e.date.getTime() >= from && e.date.getTime() <= to)]
    .filter((e) => held.includes(e.symbol))
    .sort((a, b) => a.date.getTime() - b.date.getTime() || a.symbol.localeCompare(b.symbol) || a.kind.localeCompare(b.kind))
    .slice(0, MAX_EVENTS);

  // Outcomes for passed earnings dates (cache only).
  const pastEarnings = events.filter((e) => e.kind === "earnings" && e.date.getTime() <= today);
  let rated: Rated[] = [];
  if (pastEarnings.length > 0) {
    const symbols = [...new Set(pastEarnings.map((e) => e.symbol))];
    const since = new Date(Math.min(...pastEarnings.map((e) => e.date.getTime())) - DAY_MS);
    const articles = await deps.store.articlesForSymbols(symbols, since).catch((): StoredArticle[] => []);
    const byId = new Map(articles.map((a) => [a.id, a]));
    const ratings = articles.length > 0 ? await deps.store.ratingsFor(articles.map((a) => a.id)).catch((): ArticleRating[] => []) : [];
    rated = ratings.flatMap((rating) => {
      const article = byId.get(rating.articleId);
      return article && article.symbols.includes(rating.symbol) ? [{ article, rating }] : [];
    });
  }

  // One bounded BoC fetch, only when a USD dividend is listed; the latest rate applies to every projected payment.
  const usdDividend = settings.cadView && events.some((e) => e.kind === "dividend_pay" && e.currency?.toUpperCase() === "USD");
  const conv = settings.cadView ? await homeConverterFor(deps.market, usdDividend ? isoDay(new Date(today)) : undefined, isoDay(new Date(today)), deps.marketDeadlineMs) : null;
  const homeParts: HomeAmount[] = [];
  const views: Array<{ week: number; view: CalendarEventView }> = events.map((e) => {
    const units = e.kind === "dividend_pay" ? unitsOf(e.symbol, e.currency) : 0;
    const amount: CalendarEventView["amount"] = e.kind === "dividend_pay" && e.amountPerUnit !== null && Number.isFinite(e.amountPerUnit) && e.currency
      ? { perUnit: round(e.amountPerUnit, 6), units: round(units, 6), total: round(e.amountPerUnit * units, 2), currency: e.currency }
      : null;
    if (amount && conv) { amount.home = conv.at(amount.total, amount.currency); homeParts.push(amount.home); }
    return {
      week: weekStartOf(e.date.getTime()),
      view: {
        id: e.id, symbol: e.symbol, kind: e.kind, date: isoDay(e.date), status: e.status, estimated: e.status !== "confirmed", amount,
        outcome: e.kind === "earnings" && e.date.getTime() <= today ? outcomeFor(e, rated, today, now) : null,
      },
    };
  });
  const weeks = new Map<number, CalendarEventView[]>();
  for (const { week, view } of views) weeks.set(week, [...(weeks.get(week) ?? []), view]);
  const thisWeekStart = weekStartOf(today);
  const ahead = views.filter((v) => v.week === thisWeekStart && Date.parse(`${v.view.date}T00:00:00Z`) >= today).map((v) => v.view);

  return {
    range,
    asOf: portfolio.generatedAt,
    weeks: [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([week, list]) => ({ weekStart: isoDay(new Date(week)), events: list })),
    thisWeek: { earnings: ahead.filter((e) => e.kind === "earnings").length, dividends: ahead.filter((e) => e.kind === "dividend_pay").length },
    accounts: listed.map((a) => ({ id: a.id, label: a.label })),
    filters: { range, ...(input.accountId !== undefined ? { accountId: input.accountId } : {}) },
    settings,
    ...(conv ? { home: { dividends: sumHome(homeParts) } } : {}),
  };
}

const monDay = (iso: string) => `${MONTHS_SHORT[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const kindWord = (k: CalendarEvent["kind"]) => (k === "earnings" ? "earnings" : "dividend");
const allEvents = (p: CalendarPayload) => p.weeks.flatMap((w) => w.events);

/** The next five dated events and this week's counts; no amounts, account ids or labels. */
export function calendarText(p: CalendarPayload, options: { show?: boolean; now?: Date } = {}): string {
  const all = allEvents(p);
  const today = torontoDay.format(options.now ?? new Date(p.asOf));
  const next = all.filter((e) => e.date >= today).slice(0, TEXT_EVENTS);
  const parts: string[] = [];
  if (all.length === 0) parts.push(`No earnings or dividend dates in the next ${RANGE_WORDS[p.range]} for ${p.filters.accountId ? "this account's" : "your"} holdings.`);
  else {
    parts.push(`This week: ${p.thisWeek.earnings} earnings ${p.thisWeek.earnings === 1 ? "date" : "dates"} and ${p.thisWeek.dividends} dividend ${p.thisWeek.dividends === 1 ? "payment" : "payments"} ahead.`);
    if (next.length > 0) parts.push(`Next: ${next.map((e) => `${e.symbol} ${kindWord(e.kind)} ${monDay(e.date)}${e.estimated ? " (est.)" : ""}`).join("; ")}.`);
    else parts.push(`Nothing else in the next ${RANGE_WORDS[p.range]}.`);
  }
  parts.push(ESTIMATE_NOTE, ADVICE_NOTE);
  if (options.show) parts.push("Showing the calendar widget.");
  return parts.join(" ");
}

/** Compact copy for the model: at most 20 events with per-unit amounts only (no totals, units or account ids). */
export function calendarModelCopy(p: CalendarPayload) {
  const all = allEvents(p);
  return {
    range: p.range,
    asOf: p.asOf,
    thisWeek: p.thisWeek,
    events: all.slice(0, MODEL_EVENTS).map((e) => ({
      symbol: e.symbol, kind: e.kind, date: e.date, status: e.status, estimated: e.estimated,
      perUnit: e.amount?.perUnit ?? null, currency: e.amount?.currency ?? null,
      outcome: e.outcome,
    })),
    hasMore: all.length > MODEL_EVENTS,
    ...(p.home ? { homeDividends: { amount: p.home.dividends.amount, estimated: p.home.dividends.estimated, notConverted: p.home.dividends.excludedCount } } : {}),
    notes: { ...(p.home ? { currency: CAD_NOTE, projectedRate: "Projected dividend payments are converted at the latest Bank of Canada rate." } : {}),
      ...(all.some((e) => e.kind === "dividend_pay" && e.amount === null) ? { amounts: NO_AMOUNT_NOTE } : {}), estimates: ESTIMATE_NOTE, ratings: `Outcome moods are ${RATING_CAVEAT}.`, advice: ADVICE_NOTE },
  };
}

const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const security = [{ type: "oauth2" as const, scopes: ["portfolio:read"] }];

const inputSchema = {
  type: "object",
  properties: { range: { type: "string", enum: [...CALENDAR_RANGES] }, accountId: { type: "string", minLength: 1 } },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  properties: {
    range: { type: "string" }, asOf: { type: "string" }, weeks: { type: "array" }, thisWeek: { type: "object" },
    accounts: { type: "array" }, filters: { type: "object" }, settings: { type: "object" }, home: { type: "object" },
  },
  required: ["range", "asOf", "weeks", "thisWeek", "accounts", "filters", "settings"],
  additionalProperties: false,
} as const;

export const calendarToolDefinitions = [
  {
    name: "show_calendar",
    title: "Show calendar",
    description: "Use this when the user asks about upcoming earnings dates, dividend payments, or what's coming up for their holdings: renders the interactive calendar. Read-only; dates may be estimated. Informational, not advice.",
    inputSchema,
    outputSchema,
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    _meta: {
      securitySchemes: security, ui: { resourceUri: CALENDAR_WIDGET_URI }, "openai/outputTemplate": CALENDAR_WIDGET_URI,
      "openai/widgetAccessible": true, "openai/toolInvocation/invoking": "Loading calendar…", "openai/toolInvocation/invoked": "Calendar ready.",
    },
  },
  {
    name: "get_calendar",
    title: "Get calendar",
    description: "Used by the calendar widget to change the range or account of the earnings and dividend calendar. Read-only; dates may be estimated. Informational, not advice.",
    inputSchema,
    outputSchema,
    annotations: readOnlyAnnotations,
    securitySchemes: security,
    _meta: { securitySchemes: security, ui: { visibility: ["app"] } },
  },
] as const;
