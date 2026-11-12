import { z } from "zod";

import { MemoryValidationError } from "../memory/memory-service.js";
import { readGoals, readLimits, readTheses } from "../memory/portfolio-facts.js";
import { goalFactText, limitFactText, thesisFactText } from "./fact-text.js";
import { limitLabel } from "./limit-tools.js";
import { accountLabels, factLog, reevaluateNudges, type PortfolioFactContext, type PortfolioFactDeps } from "./portfolio-fact-tools.js";
import { resolveTicker } from "./thesis-tools.js";

/**
 * The dashboard's typed edits and deletes of theses, limits and goals (`PATCH`/`DELETE /api/theses|limits|goals`).
 * Each loads the caller's current entry, merges only the edited fields, derives the text with the same builder the
 * assistant tools use, saves through the memory service as a stated entry from the dashboard, and then brings the
 * nudges in line (best effort, with the tools' 2-second deadline and stale-read skip). Reasons can't be changed here:
 * new reasons are a new thesis, which goes through the assistant.
 */

export type PlanEditResult =
  | { status: 200; body: { saved: true } }
  | { status: 204 }
  | { status: 400; body: { error: "invalid_plan_edit"; message: "That change could not be saved." } }
  | { status: 404; body: { error: "not_found" } };

const OK: PlanEditResult = { status: 200, body: { saved: true } };
const DELETED: PlanEditResult = { status: 204 };
const INVALID: PlanEditResult = { status: 400, body: { error: "invalid_plan_edit", message: "That change could not be saved." } };
const NOT_FOUND: PlanEditResult = { status: 404, body: { error: "not_found" } };

const upper = (s: string) => s.trim().toUpperCase();

const limitEdit = z.strictObject({ maxPct: z.number() });
const goalEdit = z.strictObject({
  targetCad: z.number().optional(), targetDate: z.string().optional(), growthRatePct: z.number().nullable().optional(),
}).refine((b) => b.targetCad !== undefined || b.targetDate !== undefined || b.growthRatePct !== undefined);
const thesisEdit = z.strictObject({
  timeFrame: z.unknown().optional(), conditions: z.array(z.unknown()).max(5).optional(),
}).refine((b) => b.timeFrame !== undefined || b.conditions !== undefined);

/** Nudges follow the change; never fails it. A portfolio that can't be read leaves them for the nightly run. */
async function followUp(deps: PortfolioFactDeps, ctx: PortfolioFactContext): Promise<void> {
  try {
    await reevaluateNudges(deps, ctx.subject, await ctx.portfolio());
  } catch {
    factLog(deps, { event: "nudge_reevaluate", code: "failed" });
  }
}

async function save(
  ctx: PortfolioFactContext, node: { type: "security" | "rule" | "goal"; key: string }, property: string, value: unknown, text: string, kind: "reason" | "plan",
): Promise<boolean> {
  try {
    await ctx.memory.remember(ctx.subject, { node, property, value, text, kind, provenance: "stated", source: "dashboard" } as never, undefined, "dashboard");
    return true;
  } catch (error) {
    if (error instanceof MemoryValidationError) return false;
    throw error;
  }
}

export async function editLimit(deps: PortfolioFactDeps, ctx: PortfolioFactContext, slug: string, body: unknown): Promise<PlanEditResult> {
  const found = (await readLimits(ctx.memory, ctx.subject)).find((l) => l.slug === slug);
  if (!found) return NOT_FOUND;
  const edit = limitEdit.safeParse(body);
  if (!edit.success) return INVALID;
  const label = limitLabel(found.limit, accountLabels(await ctx.portfolio()));
  const value = { ...found.limit, maxPct: edit.data.maxPct };
  if (!(await save(ctx, { type: "rule", key: slug }, "rule.concentration_limit", value, limitFactText(edit.data.maxPct, label), "plan"))) return INVALID;
  await followUp(deps, ctx);
  return OK;
}

export async function editGoal(_deps: PortfolioFactDeps, ctx: PortfolioFactContext, slug: string, body: unknown): Promise<PlanEditResult> {
  const found = (await readGoals(ctx.memory, ctx.subject)).find((g) => g.slug === slug);
  if (!found) return NOT_FOUND;
  const edit = goalEdit.safeParse(body);
  if (!edit.success) return INVALID;
  const { growthRatePct, ...fields } = edit.data;
  const { growthRatePct: kept, ...rest } = found.goal;
  // Given fields replace theirs; a growth rate of null removes it, and an omitted one is kept.
  const rate = growthRatePct === undefined ? kept : growthRatePct ?? undefined;
  const value = {
    ...rest, ...Object.fromEntries(Object.entries(fields).filter(([, x]) => x !== undefined)),
    ...(rate !== undefined ? { growthRatePct: rate } : {}),
  };
  const v = value as { name: string; targetCad: number; targetDate: string };
  // Goals have no nudges, so nothing follows the save.
  return (await save(ctx, { type: "goal", key: slug }, "goal.savings_target", value, goalFactText(v.name, v.targetCad, v.targetDate), "plan")) ? OK : INVALID;
}

/** The saved ticker a path names: exactly, or by its base symbol when one saved thesis matches (SHOP for SHOP.TO). */
async function savedThesis(ctx: PortfolioFactContext, ticker: string) {
  const theses = await readTheses(ctx.memory, ctx.subject, { currentOnly: true });
  const saved = theses.map((t) => upper(t.ticker));
  const want = resolveTicker(ticker, saved);
  return saved.includes(want) ? theses.find((t) => upper(t.ticker) === want) : undefined;
}

export async function editThesis(deps: PortfolioFactDeps, ctx: PortfolioFactContext, ticker: string, body: unknown): Promise<PlanEditResult> {
  const found = await savedThesis(ctx, ticker);
  if (!found) return NOT_FOUND;
  const edit = thesisEdit.safeParse(body);
  if (!edit.success) return INVALID;
  const patch = Object.fromEntries(Object.entries(edit.data).filter(([, v]) => v !== undefined));
  const value = { ...found.thesis, writtenAt: found.writtenAt.toISOString(), ...patch };
  if (!(await save(ctx, { type: "security", key: found.ticker }, "security.thesis", value, thesisFactText(upper(found.ticker), found.thesis.reasons), "reason"))) return INVALID;
  await followUp(deps, ctx);
  return OK;
}

export async function deleteLimit(deps: PortfolioFactDeps, ctx: PortfolioFactContext, slug: string): Promise<PlanEditResult> {
  const count = await ctx.memory.forget(ctx.subject, { node: { type: "rule", key: slug }, property: "rule.concentration_limit" });
  if (count === 0) return NOT_FOUND;
  await followUp(deps, ctx);
  return DELETED;
}

export async function deleteGoal(_deps: PortfolioFactDeps, ctx: PortfolioFactContext, slug: string): Promise<PlanEditResult> {
  return (await ctx.memory.forget(ctx.subject, { node: { type: "goal", key: slug }, property: "goal.savings_target" })) === 0 ? NOT_FOUND : DELETED;
}

export async function deleteThesis(deps: PortfolioFactDeps, ctx: PortfolioFactContext, ticker: string): Promise<PlanEditResult> {
  const found = await savedThesis(ctx, ticker);
  if (!found) return NOT_FOUND;
  const node = { type: "security" as const, key: found.ticker };
  const count = await ctx.memory.forget(ctx.subject, { node, property: "security.thesis" });
  await ctx.memory.forget(ctx.subject, { node, property: "security.thesis_baseline" });
  if (count === 0) return NOT_FOUND;
  await followUp(deps, ctx);
  return DELETED;
}
