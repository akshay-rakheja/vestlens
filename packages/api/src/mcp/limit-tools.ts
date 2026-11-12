import { createHash } from "node:crypto";

import { checkLimits, formatPct, type LimitCheck } from "../limits/limit-check.js";
import { loadLimitInput } from "../limits/limit-loader.js";
import { isInvestable, isInvestableClassification } from "../analytics/holdings.js";
import { accountKey, memorySlug } from "../memory/keys.js";
import { MemoryValidationError } from "../memory/memory-service.js";
import type { ConcentrationLimit } from "../memory/memory-types.js";
import { readLimits } from "../memory/portfolio-facts.js";
import type { PortfolioPresentation, PortfolioPresentationAccount } from "../portfolio/portfolio-presentation.js";
import { limitFactText } from "./fact-text.js";
import { memorySource } from "./memory-tools.js";
import { oneLineUserText } from "./user-text.js";
import {
  accountLabel, accountLabels, factLog, heldSymbols, isObject, resolveTicker, notSaved, nowOf, plain, rejected, resolveAccountKeys, sentence, UNKNOWN_ACCOUNT_TEXT, withLabels,
  writeScopeResult, type PortfolioFactContext, type PortfolioFactDeps, type ToolResult,
  reevaluateNudges,
} from "./portfolio-fact-tools.js";

/**
 * set_portfolio_limit and show_limits (spec 2026-10-24 §6, §9, §11a.6-7). A limit is the user's own rule on
 * `rule:<slug>`, stated only; VestLens checks it against brokerage-reported holdings (CAD, est.), of the portfolio
 * including cash. Facts only: a limit is within, over, or can't tell, never a suggestion.
 */

/** The limits card's base address (packages/widgets limits, Task 6); the server rebinds it to the served URI. */
export const LIMITS_WIDGET_URI = "ui://portfolio/limits-v1";

export const limitEcho = (max: number, label: string) => `Noted your ${formatPct(max)}% limit on ${label}.`;
export const PORTFOLIO_BASIS = "(of your portfolio, cash included)";
export const SUBSET_BASIS = "(of the chosen accounts, cash included)";

const memorySecurity = [{ type: "oauth2" as const, scopes: ["portfolio:read", "memory"] }];
const readSecurity = [{ type: "oauth2" as const, scopes: ["portfolio:read"] }];

const KINDS = ["single_holding", "sector", "asset_class"] as const;

export const limitToolDefinitions = [
  {
    name: "set_portfolio_limit",
    title: "Set a portfolio limit",
    description:
      "Use this when the user states a limit or cap on their portfolio, like 'no more than X% in one stock', 'keep tech under X%' or 'keep X under 5% of that account': saves it; VestLens checks it against their real holdings. Save it here rather than in your general memory. kind single_holding (target: a ticker, or none for any one holding), sector (target: a sector, or none for any sector) or asset_class (target, e.g. cash); accounts: ids from list_portfolio_accounts to apply it to one account. Save without asking; reply briefly with the echo. remove: true deletes it. Writes only to VestLens's memory, never to the brokerage.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...KINDS] },
        target: { type: "string", minLength: 1, maxLength: 80, description: "A ticker, sector or asset class; leave out for any one holding or sector." },
        maxPct: { type: "number", minimum: 0, maximum: 100 },
        accounts: { type: "array", items: { type: "string", minLength: 1, maxLength: 120 }, maxItems: 100, description: "Account ids from list_portfolio_accounts when the limit covers only some accounts; leave out for the whole portfolio." },
        remove: { type: "boolean" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    // destructiveHint stays false (ruling): saving should be natural, and a confirmation prompt on every save would defeat
    // it. remove: true only deletes the user's own VestLens note, never anything at the brokerage.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    securitySchemes: memorySecurity,
    _meta: { securitySchemes: memorySecurity },
  },
  {
    name: "show_limits",
    title: "Show portfolio limits",
    description:
      "Use this when the user asks about their limits or concentration rules: lists every limit they set against current holdings (CAD, est., of the portfolio including cash), over, within or can't tell. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    securitySchemes: readSecurity,
    _meta: {
      securitySchemes: readSecurity,
      ui: { resourceUri: LIMITS_WIDGET_URI },
      "openai/outputTemplate": LIMITS_WIDGET_URI,
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Checking limits…",
      "openai/toolInvocation/invoked": "Limits ready.",
    },
  },
] as const;

export const LIMIT_TOOL_NAMES: readonly string[] = limitToolDefinitions.map((t) => t.name);

/** Why an account is outside the investment total (holdings.ts isInvestableClassification), or null when it is in it. */
export function uncountedReason(c: PortfolioPresentationAccount["classification"]): "closed" | "a credit product" | "not counted in your portfolio total" | null {
  if (c.isClosed || c.group === "closed") return "closed";
  if (c.bucket === "credit_card" || c.bucket === "line_of_credit" || c.group === "credit_products") return "a credit product";
  return isInvestableClassification(c) ? null : "not counted in your portfolio total";
}

const KIND_WORDS: Record<ConcentrationLimit["kind"], string> = { single_holding: "single holding", sector: "sector", asset_class: "asset class" };

/** `rule:<slug>`: one limit per kind, target and account set (memorySlug; a subset adds a short hash of its keys). */
export function limitSlug(limit: Pick<ConcentrationLimit, "kind" | "target" | "accounts">): string {
  const slug = memorySlug(`${limit.kind} ${limit.target?.trim() || "any"}`, "rule:");
  if (!limit.accounts || limit.accounts.length === 0) return slug;
  const hash = createHash("sha256").update([...new Set(limit.accounts)].sort().join(",")).digest("hex").slice(0, 8);
  return `${slug.slice(0, 51).replace(/-+$/, "")}-${hash}`;
}

/** What the limit is on, as the user would say it: "SHOP", "any single holding", "Technology in My TFSA". Labels, never keys. */
export function limitLabel(limit: ConcentrationLimit, labels: ReadonlyMap<string, string>): string {
  // The target is the user's own text and account names come from the brokerage: one line each (I-1).
  const what = (limit.target ? oneLineUserText(limit.target) : "") || `any ${KIND_WORDS[limit.kind]}`;
  if (!limit.accounts || limit.accounts.length === 0) return what;
  return `${what} in ${limit.accounts.map((k) => oneLineUserText(labels.get(k) ?? "") || "an account no longer connected").join(", ")}`;
}

/** One row as text: the verbatim line, then the basis note as its own sentence, then any other note. */
export function limitRowText(row: LimitCheck): string {
  const [basis, ...rest] = (row.note ?? "").split("; ").filter((s) => s.length > 0);
  const basisNote = basis?.startsWith("Share of the chosen accounts") ? SUBSET_BASIS : PORTFOLIO_BASIS;
  return [`${row.line}.`, basisNote, ...(rest.length > 0 ? [sentence(rest.join("; "))] : [])].join(" ");
}

/** Rows grouped by limit (one limit can give several rows), in the order the limits come. */
export function groupBySlug(rows: readonly LimitCheck[]): Array<{ slug: string; rows: LimitCheck[] }> {
  const groups = new Map<string, LimitCheck[]>();
  for (const r of rows) groups.set(r.slug, [...(groups.get(r.slug) ?? []), r]);
  return [...groups].map(([slug, rs]) => ({ slug, rows: rs }));
}

async function evaluate(deps: PortfolioFactDeps, ctx: PortfolioFactContext, portfolio: PortfolioPresentation) {
  const now = nowOf(deps);
  const input = await loadLimitInput({ memory: ctx.memory, portfolio: async () => portfolio, market: deps.market }, ctx.subject, now, { portfolio });
  return { input, rows: checkLimits(input, now) };
}

/** "Your limits" lines for holdings and allocation results, from the portfolio those tools loaded. Empty without limits. */
export async function limitStatusLines(deps: PortfolioFactDeps, ctx: PortfolioFactContext, portfolio: PortfolioPresentation): Promise<string[]> {
  const { rows } = await evaluate(deps, ctx, portfolio);
  const labels = accountLabels(portfolio);
  return groupBySlug(rows).flatMap((g) => g.rows.map((r) => withLabels(limitRowText(r), labels)));
}

/** The dashboard's "Your limits": each limit with its rows (share, status, the verbatim line and the basis text). */
export async function limitsPayload(deps: PortfolioFactDeps, ctx: PortfolioFactContext) {
  const portfolio = await ctx.portfolio();
  const { input, rows } = await evaluate(deps, ctx, portfolio);
  const labels = accountLabels(portfolio);
  factLog(deps, { event: "fact_tool", tool: "show_limits", code: "shown", rows: rows.length });
  const groups = groupBySlug(rows);
  return {
    limits: input.limits.map(({ slug, limit }) => ({
      slug, kind: limit.kind, target: limit.target ?? null, maxPct: limit.maxPct, label: limitLabel(limit, labels),
      rows: (groups.find((g) => g.slug === slug)?.rows ?? []).map((r) => ({
        label: withLabels(r.label, labels), currentPct: r.currentPct, status: r.status, line: withLabels(r.line, labels),
        text: withLabels(limitRowText(r), labels), unclassifiedPct: r.unclassifiedPct ?? null, fxDate: r.fxDate ?? null, ...(r.informational ? { informational: true } : {}),
      })),
    })),
  };
}

export async function buildShowLimits(deps: PortfolioFactDeps, ctx: PortfolioFactContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (Object.keys(args).length > 0) return rejected("show_limits takes no arguments.");
  const portfolio = await ctx.portfolio();
  const { input, rows } = await evaluate(deps, ctx, portfolio);
  const labels = accountLabels(portfolio);
  factLog(deps, { event: "fact_tool", tool: "show_limits", code: "shown", rows: rows.length });
  if (input.limits.length === 0) {
    return plain("No limits are saved. When the user states one, like 'no more than 10% in one stock', save it with set_portfolio_limit.", { limits: [] });
  }
  const groups = groupBySlug(rows);
  const limits = input.limits.map(({ slug, limit }) => ({
    slug, kind: limit.kind, target: limit.target ?? null, maxPct: limit.maxPct, label: limitLabel(limit, labels),
    // groupKey is internal (nudge keys): not part of the shown result.
    rows: (groups.find((g) => g.slug === slug)?.rows ?? []).map(({ groupKey: _key, ...r }) => ({ ...r, note: r.note ? withLabels(r.note, labels) : r.note })),
  }));
  const lines = ["Your limits:"];
  for (const l of limits) {
    lines.push(`${formatPct(l.maxPct)}% limit on ${l.label}:`);
    for (const r of l.rows) lines.push(`- ${withLabels(limitRowText(r), labels)}`);
  }
  return plain(lines.join("\n"), { limits });
}

async function setLimit(deps: PortfolioFactDeps, ctx: PortfolioFactContext, args: Record<string, unknown>): Promise<ToolResult> {
  const allowed = new Set(["kind", "target", "maxPct", "accounts", "remove"]);
  if (Object.keys(args).some((k) => !allowed.has(k))) return notSaved("Use only kind, target, maxPct, accounts and remove.");
  if (typeof args.kind !== "string" || !(KINDS as readonly string[]).includes(args.kind)) return notSaved("kind must be single_holding, sector or asset_class.");
  if (args.target !== undefined && (typeof args.target !== "string" || args.target.trim().length === 0)) return notSaved("target must be text.");
  if (args.accounts !== undefined && (!Array.isArray(args.accounts) || args.accounts.length === 0 || args.accounts.some((a) => typeof a !== "string"))) {
    return notSaved("accounts must list account ids from list_portfolio_accounts.");
  }
  if (args.remove !== undefined && typeof args.remove !== "boolean") return notSaved("remove must be true or false.");
  const portfolio = await ctx.portfolio();
  const labels = accountLabels(portfolio);
  const accounts = args.accounts === undefined ? undefined : resolveAccountKeys(args.accounts as string[], portfolio);
  if (accounts === null) return notSaved(UNKNOWN_ACCOUNT_TEXT);
  // An account outside the investment total (closed, a credit product, or not counted) can't be covered (M-6).
  const uncounted = (portfolio.accounts ?? []).find((a) => accounts?.includes(accountKey(a.id)) && !isInvestable(a));
  if (uncounted) {
    return notSaved(`${accountLabel(uncounted)} is ${uncountedReason(uncounted.classification) ?? "not counted in your portfolio total"}, so a limit can't cover it. Leave it out of accounts.`);
  }
  const kind = args.kind as ConcentrationLimit["kind"];
  const given = typeof args.target === "string" ? oneLineUserText(args.target) || undefined : undefined;
  if (typeof args.target === "string" && given === undefined) return notSaved("target must be text.");
  // A single holding is named as held, the same way log_thesis resolves it: "SHOP" and "SHOP.TO" are one limit (M-2).
  const target = given && kind === "single_holding" ? resolveTicker(given, heldSymbols(portfolio)) : given;
  const slug = limitSlug({ kind, ...(target ? { target } : {}), ...(accounts ? { accounts } : {}) });
  const node = { type: "rule" as const, key: slug };

  if (args.remove === true) {
    const count = await ctx.memory.forget(ctx.subject, { node, property: "rule.concentration_limit" });
    factLog(deps, { event: "fact_tool", tool: "set_portfolio_limit", code: "removed" });
    const label = limitLabel({ kind, maxPct: 0, ...(target ? { target } : {}), ...(accounts ? { accounts } : {}) }, labels);
    return count > 0 ? plain(`Removed your limit on ${label}.`, { slug, removed: true }) : plain(`No limit was saved on ${label}.`, { slug, removed: false });
  }

  if (typeof args.maxPct !== "number") return notSaved("maxPct is required: the limit as a percentage, 0-100.");
  const value = { kind, ...(target ? { target } : {}), maxPct: args.maxPct, ...(accounts ? { accounts } : {}) };
  const label = limitLabel(value, labels);
  const echo = limitEcho(args.maxPct, label);
  try {
    const { fact, superseded } = await ctx.memory.remember(ctx.subject, {
      node, property: "rule.concentration_limit", value, text: limitFactText(args.maxPct, label),
      kind: "plan", provenance: "stated", source: memorySource(ctx.clientKey),
    } as never, undefined, "assistant");
    factLog(deps, { event: "fact_tool", tool: "set_portfolio_limit", code: "saved" });
    await reevaluateNudges(deps, ctx.subject, portfolio);
    // The current reading of the limit just saved, from the same portfolio (no further read).
    const { rows } = await evaluate(deps, ctx, portfolio);
    const now = rows.filter((r) => r.slug === slug).map((r) => withLabels(limitRowText(r), labels));
    return plain([echo, ...(now.length > 0 ? [`Now: ${now.join(" ")}`] : [])].join(" "), { slug, saved: true, replaced: superseded > 0, limit: fact.value });
  } catch (error) {
    if (error instanceof MemoryValidationError) {
      factLog(deps, { event: "fact_tool", tool: "set_portfolio_limit", code: "rejected" });
      return notSaved(error.message);
    }
    throw error;
  }
}

export async function runLimitWrite(deps: PortfolioFactDeps, ctx: PortfolioFactContext, rawArgs: unknown): Promise<ToolResult> {
  const scope = writeScopeResult(ctx);
  if (scope) return scope;
  return setLimit(deps, ctx, isObject(rawArgs) ? rawArgs : {});
}
