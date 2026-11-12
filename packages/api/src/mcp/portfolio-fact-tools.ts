import { hasScope, MEMORY_SCOPE } from "../gateway/scope.js";
import type { GoalPrismaPort } from "../goals/goal-loader.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import { accountKey, isHashKey } from "../memory/keys.js";
import type { MemoryService } from "../memory/memory-service.js";
import type { NewsStore } from "../news/store.js";
import type { NudgeService } from "../nudges/nudge-service.js";
import type { PortfolioPresentation, PortfolioPresentationAccount } from "../portfolio/portfolio-presentation.js";
import type { DailySnapshotService } from "../snapshots/daily-snapshot-service.js";
import type { ThesisPrismaPort } from "../theses/thesis-loader.js";
import { MEMORY_RECONNECT_TEXT } from "./memory-tools.js";
import { quoteUserText } from "./user-text.js";

/**
 * Shared pieces of the thesis, limit and goal tools (spec 2026-10-24 §9, §11a): their dependencies, the per-call
 * context, plain results, and account labels. The three write tools need the `memory` scope; the show tools need
 * portfolio:read only. Nothing here reaches the brokerage.
 */

/** Stored data, cached market data and the news cache: no brokerage read. Normal mode only. */
export interface PortfolioFactDeps {
  prisma: ThesisPrismaPort & GoalPrismaPort;
  dailyValues: Pick<DailySnapshotService, "rows">;
  /** `securityHistory`: split-aware closes for the report card's "after you sold" (the runtime's market data has it). */
  market: Pick<MarketDataService, "history" | "usdCad"> & Partial<Pick<MarketDataService, "cachedProfileLookup" | "cachedProfile" | "securityHistory">>;
  /** The news cache; without it a thesis check has no news or earnings dates. */
  news?: Pick<NewsStore, "articlesForSymbols" | "ratingsFor" | "events">;
  now?: () => Date;
  /** Counts and constant codes only. */
  log?: (event: PortfolioFactLogEvent) => void;
  /** Nudges, re-evaluated (best effort) after a successful log_thesis or set_portfolio_limit save. */
  nudges?: Pick<NudgeService, "evaluateNudges">;
  /** Deadline for that re-evaluation (default NUDGE_REEVALUATE_DEADLINE_MS). */
  nudgeDeadlineMs?: number;
}

export type PortfolioFactLogEvent =
  | { event: "thesis_baseline"; code: "captured" | "skipped" | "failed" }
  | { event: "fact_status_lines"; code: "failed" }
  | { event: "nudge_reevaluate"; code: "done" | "timeout" | "failed" | "nudge_reeval_skipped" }
  | { event: "fact_tool"; tool: string; code: "saved" | "removed" | "rejected" | "shown" | "holding" | "not_held" | "limits_failed"; rows?: number };

export interface PortfolioFactContext {
  subject: string;
  scopes: readonly string[] | undefined;
  clientKey?: string;
  memory: MemoryService;
  /** The caller's portfolio, read at most once per call (the cached read the other tools use; never a refresh). */
  portfolio: () => Promise<PortfolioPresentation>;
}

export type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

export const plain = (text: string, structuredContent?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(structuredContent ? { structuredContent } : {}),
});
/** A call the assistant can correct: plain text with the result-level isError flag (never a JSON-RPC error code). */
export const rejected = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
export const notSaved = (message: string) => rejected(`Not saved: ${message}`);

/** Null when the write may go ahead; else the verbatim reconnect text, as the memory tools return it. */
export function writeScopeResult(ctx: Pick<PortfolioFactContext, "scopes">): ToolResult | null {
  return hasScope(ctx.scopes ?? [], MEMORY_SCOPE) ? null : plain(MEMORY_RECONNECT_TEXT);
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const factLog = (deps: PortfolioFactDeps, event: PortfolioFactLogEvent) =>
  (deps.log ?? ((e: PortfolioFactLogEvent) => console.info(JSON.stringify(e))))(event);

export const nowOf = (deps: PortfolioFactDeps) => (deps.now ?? (() => new Date()))();

export const NUDGE_REEVALUATE_DEADLINE_MS = 2_000;

/**
 * After a save, brings the subject's nudges in line with the fact just saved, from the portfolio the tool already
 * loaded (so an open nudge never states an old threshold until the night). Skipped on a stale or partial read. Best
 * effort: it waits at most the deadline, logs a constant code, and never fails the save.
 */
export async function reevaluateNudges(deps: PortfolioFactDeps, subject: string, portfolio: PortfolioPresentation): Promise<void> {
  if (!deps.nudges) return;
  // A stale (fallback) or partial read is not the current portfolio: evaluating it could raise or clear on missing
  // accounts, so the nudges stay as they are until the nightly run (which skips such reads too).
  if (portfolio.cache?.stale || (portfolio.errors ?? []).length > 0) {
    factLog(deps, { event: "nudge_reevaluate", code: "nudge_reeval_skipped" });
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = deps.nudges.evaluateNudges(subject, nowOf(deps), { portfolio })
    .then((o): "done" | "failed" => (o.failed > 0 ? "failed" : "done"), (): "failed" => "failed");
  const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), deps.nudgeDeadlineMs ?? NUDGE_REEVALUATE_DEADLINE_MS); });
  try {
    factLog(deps, { event: "nudge_reevaluate", code: await Promise.race([run, deadline]) });
  } finally {
    clearTimeout(timer);
  }
}

/** An account as the user knows it: its name, else the institution and account type. Never its key. */
export function accountLabel(a: Pick<PortfolioPresentationAccount, "name" | "institution" | "classification">): string {
  return a.name?.trim() || `${a.institution} ${a.classification.label}`;
}

/** accountKey -> label for every connected account (closed included). */
export function accountLabels(portfolio: PortfolioPresentation): Map<string, string> {
  return new Map((portfolio.accounts ?? []).map((a) => [accountKey(a.id), accountLabel(a)]));
}

export const UNKNOWN_ACCOUNT_TEXT = "That account isn't one of the user's connected accounts. Use an account id from list_portfolio_accounts.";

/**
 * Account references as an assistant may give them (an account id from list_portfolio_accounts, or its accountKey) to
 * memory keys. Null when any is not one of the caller's connected accounts.
 */
export function resolveAccountKeys(refs: readonly string[], portfolio: PortfolioPresentation): string[] | null {
  const byId = new Map((portfolio.accounts ?? []).map((a) => [a.id, accountKey(a.id)]));
  const keys = new Set(byId.values());
  const out: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    const key = byId.get(ref) ?? (isHashKey(ref) && keys.has(ref) ? ref : null);
    if (key === null) return null;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** Replaces any account key left in VestLens copy with its label (Task 4 review R2-M-1); an unknown one reads "an account". */
export function withLabels(text: string, labels: ReadonlyMap<string, string>): string {
  return text
    .replace(/account ((?:[0-9a-f]{16})(?:, [0-9a-f]{16})*) in this goal is no longer connected/g, (_m, keys: string) => {
      const names = keys.split(", ").map((k) => labels.get(k) ?? "an account");
      return `${names.join(", ")} in this goal ${names.length > 1 ? "are" : "is"} no longer connected`;
    })
    .replace(/\b[0-9a-f]{16}\b/g, (k) => labels.get(k) ?? "an account");
}

/** CAD with thousands separators, whole dollars. */
export function dollars(n: number): string {
  const rounded = Math.round(n);
  return `${rounded < 0 ? "-" : ""}$${Math.abs(rounded).toLocaleString("en-CA")}`;
}

/**
 * The estimate label for a figure: " (est., Bank of Canada rate <date>)" when converted with a known rate date, " (est.)"
 * when estimated without one, "" otherwise. Shared with the widgets through currency-format-cases.json.
 */
export const estLabel = (estimated: boolean, fxDate: string | null): string =>
  !estimated ? "" : fxDate ? ` (est., Bank of Canada rate ${fxDate})` : " (est.)";

/** First letter upper-cased: a VestLens note used as a sentence. */
export const sentence = (s: string) => (s.length === 0 ? s : `${s[0]!.toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? "" : "."}`);

/** User text shown back inside a result (user-text.ts): stripped of control and format characters, one line, JSON-quoted. */
export const quotedUserText = (text: string, max = 300): string => quoteUserText(text, max);

const upperSymbol = (s: string) => s.trim().toUpperCase();
const LISTING_SUFFIX = /\.(TO|V|NE|NEO|CN)$/;
const baseSymbol = (s: string) => upperSymbol(s).replace(LISTING_SUFFIX, "");

/** Held symbols across every account the portfolio lists. */
export const heldSymbols = (portfolio: PortfolioPresentation) =>
  [...new Set((portfolio.accounts ?? []).flatMap((a) => (a.positions ?? []).map((p) => upperSymbol(p.symbol))))];

/**
 * The ticker as held (news-tools' symbol handling): the exact symbol, else the one held listing with the same base
 * symbol ("SHOP" -> "SHOP.TO"), else the symbol as given, upper-cased.
 */
export function resolveTicker(input: string, candidates: readonly string[]): string {
  const want = upperSymbol(input);
  if (candidates.includes(want)) return want;
  const same = candidates.filter((c) => baseSymbol(c) === baseSymbol(want));
  return same.length === 1 ? same[0]! : want;
}
