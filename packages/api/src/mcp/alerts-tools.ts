import { z } from "zod";
import { aggregateHoldings, type HoldingRow } from "../analytics/holdings.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import { providerTicker } from "../market-data/ticker-map.js";
import type { Quote } from "../market-data/types.js";
import { buildAlerts, deliver, type Alert } from "../news/alerts.js";
import { torontoToday } from "../news/calendar.js";
import { classifyMovers } from "../news/movers.js";
import { torontoMarketOpen } from "../news/refresh-service.js";
import type { ArticleRating, CalendarEvent, NewsStore, StoredArticle, SymbolStats } from "../news/store.js";
import type { PortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import type { RoomAlertService } from "../room/room-alerts.js";
import { userDividendEvents, type UserDividends } from "./calendar-tools.js";
import { NEWS_KINDS, portfolioTotals } from "./news-tools.js";
import { withDeadline } from "./overview-tools.js";
import { storedRoomAlertText } from "./room-tools.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Default news window: the last 48 hours (global constraints). */
const DEFAULT_WINDOW_HOURS = 48;
const MAX_WINDOW_DAYS = 7;
/** Earnings reported up to two days ago need coverage from the day before the event. */
const EVENT_LOOKBACK_DAYS = 3;
const DEFAULT_MARKET_DEADLINE_MS = 5_000;
const NOT_ADVICE = "Informational, not advice.";

export const alertsInput = z.object({ since: z.iso.datetime({ offset: true }).optional() }).strict();
export type AlertsInput = z.infer<typeof alertsInput>;

export interface AlertsDeps {
  store: Pick<NewsStore, "stats" | "articlesForSymbols" | "ratingsFor" | "events" | "deliveredAlertIds" | "recordDeliveries">;
  /** Live quotes while the Toronto market is open (no news provider is called). */
  market: Pick<MarketDataService, "quotes">;
  /** The requesting user's own past dividend payments, for dividend alerts (never a shared projection). */
  dividends?: UserDividends;
  /** The app user id the delivery ledger is keyed by. */
  appUserId(authSubject: string): Promise<string | null>;
  now?: () => Date;
  marketDeadlineMs?: number;
}

export interface AlertsPayload {
  generatedAt: string;
  /** Start of the news window: `since` clamped to the last 7 days (default 48 h). */
  since: string;
  /** Not yet delivered to this client, ≤ 10, by materiality. */
  alerts: Alert[];
  quiet: boolean;
  next: { earningsThisWeek: number };
}

export class AlertsUnavailableError extends Error {
  constructor() { super("alerts_unavailable"); this.name = "AlertsUnavailableError"; }
}

/** Delivery-ledger client key: the token's client_id claim (gateway tokens carry one) or "mcp:<resource>". `deliver` hashes long keys. */
export const alertsClientKey = (identity: { clientId?: string | null }, fallback: string) =>
  identity.clientId ? identity.clientId : `mcp:${fallback}`;

/**
 * Material events for all of the user's investable holdings since the last check, from cache only: flagged movers,
 * in-window material news, earnings and projected pay dates. Each alert is delivered once per (user, client).
 */
export async function buildAlertsPayload(deps: AlertsDeps, portfolio: PortfolioPresentation, authSubject: string, clientKey: string, input: AlertsInput): Promise<AlertsPayload> {
  const now = (deps.now ?? (() => new Date()))();
  const appUserId = await deps.appUserId(authSubject);
  if (!appUserId) throw new AlertsUnavailableError();
  const since = alertsWindowStart(now, input);
  const today = torontoToday(now);
  const weekEnd = today + (6 - ((new Date(today).getUTCDay() + 6) % 7)) * DAY_MS;

  const rows: HoldingRow[] = aggregateHoldings(portfolio.accounts, {}).rows.filter((r) => NEWS_KINDS.has(r.kind));
  const held = [...new Set(rows.map((r) => r.symbol))].sort();
  const marketOpen = torontoMarketOpen(now);
  const tickers = [...new Set(rows.map((r) => providerTicker({ symbol: r.symbol, kind: r.kind, currency: r.currency })).filter((t): t is string => t !== null))];
  const articleFloor = new Date(Math.min(since.getTime(), today - EVENT_LOOKBACK_DAYS * DAY_MS));
  const { store } = deps;
  const [stats, quotes, articles, earnings, dividends] = await Promise.all([
    store.stats(held).catch((): SymbolStats[] => []),
    marketOpen && tickers.length > 0
      ? withDeadline(() => deps.market.quotes(tickers), deps.marketDeadlineMs ?? DEFAULT_MARKET_DEADLINE_MS, () => new Map<string, Quote>())
      : Promise.resolve(new Map<string, Quote>()),
    held.length > 0 ? store.articlesForSymbols(held, articleFloor).catch((): StoredArticle[] => []) : Promise.resolve([]),
    held.length > 0
      ? store.events(held, new Date(today - 2 * DAY_MS), new Date(Math.max(today + 3 * DAY_MS, weekEnd))).catch((): CalendarEvent[] => [])
      : Promise.resolve([]),
    userDividendEvents(deps.dividends, authSubject, portfolio.accounts, held, now),
  ]);
  // Shared earnings dates plus this user's own projected pay dates (stored dividend rows, if any, are ignored).
  const events = [...earnings.filter((e) => e.kind === "earnings"), ...dividends];

  const statsMap = new Map(stats.map((s) => [`${s.symbol}|${s.currency}`, s]));
  const movers = classifyMovers(rows, statsMap, quotes instanceof Map ? quotes : new Map(), portfolioTotals(portfolio, undefined), marketOpen, now).movers;
  const ratings = articles.length > 0 ? await store.ratingsFor(articles.map((a) => a.id)).catch((): ArticleRating[] => []) : [];
  const byId = new Map(articles.map((a) => [a.id, a]));
  const rated = new Map<string, Array<{ article: StoredArticle; rating: ArticleRating }>>();
  for (const rating of ratings) {
    const article = byId.get(rating.articleId);
    if (!article || !article.symbols.includes(rating.symbol)) continue;
    rated.set(rating.symbol, [...(rated.get(rating.symbol) ?? []), { article, rating }]);
  }
  // Older articles were loaded only for "reported" earnings; news alerts keep to the window.
  const built = buildAlerts({ movers, ratings: rated, events, now })
    .filter((a) => a.kind !== "news" || (a.publishedAt !== null && Date.parse(a.publishedAt) >= since.getTime()));
  const { alerts, quiet } = await deliver({ store: store as NewsStore, appUserId, clientKey, alerts: built, now });
  const earningsThisWeek = events.filter((e) => e.kind === "earnings" && e.date.getTime() >= today && e.date.getTime() <= weekEnd).length;
  return { generatedAt: now.toISOString(), since: since.toISOString(), alerts, quiet, next: { earningsThisWeek } };
}

/** `since` clamped to the last 7 days (default 48 h). */
function alertsWindowStart(now: Date, input: AlertsInput): Date {
  const requested = input.since !== undefined ? Date.parse(input.since) : now.getTime() - DEFAULT_WINDOW_HOURS * HOUR_MS;
  return new Date(Math.min(now.getTime(), Math.max(requested, now.getTime() - MAX_WINDOW_DAYS * DAY_MS)));
}

/** The payload when no news step is composed: no news alerts, so only the room alert (if any) is material. */
export function roomOnlyAlertsPayload(now: Date, input: AlertsInput): AlertsPayload {
  return { generatedAt: now.toISOString(), since: alertsWindowStart(now, input).toISOString(), alerts: [], quiet: true, next: { earningsThisWeek: 0 } };
}

/**
 * The open TFSA over-limit alert's sentence for this subject, or null: read from the stored row alone (its excess and
 * the room text's formatted note), with no evaluation and no write. The nightly run and reserved memory changes keep
 * the row current. Separate from the news alert budget and ledger: it is included on every call while open.
 */
export async function roomAlertSentence(alerts: Pick<RoomAlertService, "openRoomAlert">, authSubject: string, now: Date): Promise<string | null> {
  const open = await alerts.openRoomAlert(authSubject, now);
  return open ? storedRoomAlertText(open) : null;
}

/**
 * The model-facing text: an open TFSA room alert first, then the stored thesis and limit nudges (each its own sentence,
 * oldest first), then the news items.
 */
export function alertsText(p: AlertsPayload, roomAlert?: string | null, nudges: readonly string[] = []): string {
  const n = p.alerts.length;
  const lead = [...(roomAlert ? [roomAlert] : []), ...nudges].join(" ");
  if (lead) {
    return n === 0 || p.quiet
      ? `${lead} Nothing else material since the last check. ${NOT_ADVICE}`
      : `${lead} ${n} material ${n === 1 ? "item" : "items"} since the last check: ${p.alerts.map((a) => a.summary).join(" ")} ${NOT_ADVICE}`;
  }
  if (p.quiet) return `Nothing material since the last check. ${NOT_ADVICE}`;
  return `${n} material ${n === 1 ? "item" : "items"} since the last check: ${p.alerts.map((a) => a.summary).join(" ")} ${NOT_ADVICE}`;
}

const security = [{ type: "oauth2" as const, scopes: ["portfolio:read"] }];
const nullableString = { type: ["string", "null"] } as const;

const alertItem = {
  type: "object",
  properties: {
    id: { type: "string" },
    symbol: { type: "string" },
    kind: { type: "string", enum: ["news", "earnings_upcoming", "earnings_reported", "dividend_upcoming", "unusual_move"] },
    materiality: { type: "number" },
    mood: nullableString,
    headline: nullableString,
    source: nullableString,
    url: nullableString,
    publishedAt: nullableString,
    summary: { type: "string" },
  },
  required: ["id", "symbol", "kind", "materiality", "mood", "headline", "source", "url", "publishedAt", "summary"],
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  properties: {
    generatedAt: { type: "string" },
    since: { type: "string" },
    alerts: { type: "array", maxItems: 10, items: alertItem },
    quiet: { type: "boolean" },
    next: { type: "object", properties: { earningsThisWeek: { type: "integer" } }, required: ["earningsThisWeek"], additionalProperties: false },
  },
  required: ["generatedAt", "since", "alerts", "quiet", "next"],
  additionalProperties: false,
} as const;

export const alertsToolDefinitions = [
  {
    name: "get_portfolio_alerts",
    title: "Get portfolio alerts",
    description: "Returns material events for the user's holdings since the last check: unusual moves, high-materiality news, earnings and dividend dates. Call it from a scheduled task. If `quiet` is true, reply in one line that nothing material happened. Informational, not advice.",
    inputSchema: {
      type: "object",
      properties: { since: { type: "string", format: "date-time", description: "Optional start of the news window (ISO 8601); defaults to the last 48 hours, at most 7 days." } },
      additionalProperties: false,
    },
    outputSchema,
    // Read-only at the brokerage; each call records which alerts this client has seen, so it is not idempotent.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    securitySchemes: security,
    _meta: { securitySchemes: security },
  },
] as const;
