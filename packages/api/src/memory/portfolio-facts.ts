import type { MemoryService } from "./memory-service.js";
import {
  ConcentrationLimitSchema,
  OutsideValueSchema,
  SavingsGoalSchema,
  ThesisBaselineSchema,
  ThesisSchema,
  type ConcentrationLimit,
  type MemoryFact,
  type SavingsGoal,
  type Thesis,
  type ThesisBaseline,
} from "./memory-types.js";

/**
 * Typed readers for theses, concentration limits, savings goals and declared outside values (spec 2026-10-24 §5-7,
 * §11a). Each returns current, stated or imported facts only, and re-parses the stored value so a row that no longer
 * fits its schema is skipped rather than trusted.
 */

/** A declared outside value older than this is flagged stale (spec §11a.8). */
export const OUTSIDE_VALUE_STALE_DAYS = 90;
const DAY_MS = 86_400_000;

export type PortfolioFactsSource = Pick<MemoryService, "listProperty">;

const trusted = (f: MemoryFact) => f.provenance === "stated" || f.provenance === "imported";

function parsed<T>(facts: MemoryFact[], schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): Array<{ fact: MemoryFact; value: T }> {
  const out: Array<{ fact: MemoryFact; value: T }> = [];
  for (const fact of facts) {
    if (fact.supersededAt !== null || !trusted(fact)) continue;
    const r = schema.safeParse(fact.value);
    if (r.success) out.push({ fact, value: r.data });
  }
  return out;
}

/**
 * Current theses, newest first. `writtenAt` is when the thesis was written: the value's server-set `writtenAt` (an
 * amendment keeps it), else the current version's recordedAt (older rows). `history` counts the earlier versions kept.
 */
export async function readTheses(
  memory: PortfolioFactsSource, subject: string, options: { currentOnly?: boolean } = {},
): Promise<Array<{ ticker: string; thesis: Thesis; writtenAt: Date; history: number }>> {
  // currentOnly skips the superseded versions (then `history` is 0): enough for callers that need the live theses only.
  const all = await memory.listProperty(subject, "security.thesis", options.currentOnly ? {} : { includeHistory: true });
  const earlier = new Map<string, number>();
  for (const f of all) if (f.supersededAt !== null) earlier.set(f.node.key, (earlier.get(f.node.key) ?? 0) + 1);
  return parsed(all, ThesisSchema).map(({ fact, value }) => ({
    ticker: fact.node.key, thesis: value, writtenAt: value.writtenAt ? new Date(value.writtenAt) : fact.recordedAt, history: earlier.get(fact.node.key) ?? 0,
  }));
}

/**
 * The current server-written baseline for a ticker (the holding's value when its thesis version was saved), or null.
 * Derived facts only; callers check its `writtenAt` against the current thesis version before trusting it.
 */
export async function readThesisBaseline(memory: PortfolioFactsSource, subject: string, ticker: string): Promise<ThesisBaseline | null> {
  const want = ticker.trim().toUpperCase();
  const facts = await memory.listProperty(subject, "security.thesis_baseline");
  for (const fact of facts) {
    if (fact.supersededAt !== null || fact.provenance !== "derived" || fact.node.key.trim().toUpperCase() !== want) continue;
    const r = ThesisBaselineSchema.safeParse(fact.value);
    if (r.success) return r.data;
  }
  return null;
}

/** Current concentration limits, newest first, keyed by the rule node's slug. */
export async function readLimits(memory: PortfolioFactsSource, subject: string): Promise<Array<{ slug: string; limit: ConcentrationLimit; setAt: Date }>> {
  const facts = await memory.listProperty(subject, "rule.concentration_limit");
  return parsed(facts, ConcentrationLimitSchema).map(({ fact, value }) => ({ slug: fact.node.key, limit: value, setAt: fact.recordedAt }));
}

/** Current savings goals, newest first, keyed by the goal node's slug. */
export async function readGoals(memory: PortfolioFactsSource, subject: string): Promise<Array<{ slug: string; goal: SavingsGoal; setAt: Date }>> {
  const facts = await memory.listProperty(subject, "goal.savings_target");
  return parsed(facts, SavingsGoalSchema).map(({ fact, value }) => ({ slug: fact.node.key, goal: value, setAt: fact.recordedAt }));
}

/**
 * Declared outside account values by node key (`outside:<slug>`, as a goal's accounts list them). `stale` when
 * `asOf` is more than OUTSIDE_VALUE_STALE_DAYS whole days before `now`.
 */
export async function readOutsideValues(
  memory: PortfolioFactsSource, subject: string, now: Date = new Date(),
): Promise<Map<string, { amountCad: number; asOf: string; stale: boolean }>> {
  const facts = await memory.listProperty(subject, "account.value");
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out = new Map<string, { amountCad: number; asOf: string; stale: boolean }>();
  for (const { fact, value } of parsed(facts, OutsideValueSchema)) {
    if (out.has(fact.node.key)) continue; // newest first; one current per topic anyway
    const ageDays = Math.floor((today - Date.parse(`${value.asOf}T00:00:00Z`)) / DAY_MS);
    out.set(fact.node.key, { amountCad: value.amountCad, asOf: value.asOf, stale: ageDays > OUTSIDE_VALUE_STALE_DAYS });
  }
  return out;
}
