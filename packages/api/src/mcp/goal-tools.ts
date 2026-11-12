import { checkGoal, type GoalCheck } from "../goals/goal-check.js";
import { loadGoalInputs } from "../goals/goal-loader.js";
import { memorySlug, outsideAccountKey } from "../memory/keys.js";
import { MemoryValidationError, type MemoryService } from "../memory/memory-service.js";
import { validateFact } from "../memory/memory-types.js";
import { readGoals } from "../memory/portfolio-facts.js";
import type { PortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import { goalFactText } from "./fact-text.js";
import { oneLineUserText } from "./user-text.js";
import { memorySource } from "./memory-tools.js";
import {
  accountLabel, accountLabels, dollars, estLabel, factLog, isObject, notSaved, nowOf, plain, quotedUserText, rejected, resolveAccountKeys, sentence,
  UNKNOWN_ACCOUNT_TEXT, withLabels, writeScopeResult, type PortfolioFactContext, type PortfolioFactDeps, type ToolResult,
} from "./portfolio-fact-tools.js";
import { accountKey } from "../memory/keys.js";

/**
 * set_savings_goal and show_goal (spec 2026-10-24 §7, §9, §11a.8). A goal is the user's own target on `goal:<slug>`,
 * stated only, with the accounts that count toward it (connected, or outside accounts with a stated value). show_goal
 * states progress, time left, what it takes with no growth, the recent pace, and a projection at the user's own
 * growth rate only when they gave one, labelled "(your assumption)". Never advice.
 */

/** The goal card's base address (packages/widgets goal, Task 6); the server rebinds it to the served URI. */
export const GOAL_WIDGET_URI = "ui://portfolio/goal-v1";

export const goalEcho = (name: string) => `Noted your goal: ${oneLineUserText(name)}.`;
export const YOUR_ASSUMPTION = "(your assumption)";

const memorySecurity = [{ type: "oauth2" as const, scopes: ["portfolio:read", "memory"] }];
const readSecurity = [{ type: "oauth2" as const, scopes: ["portfolio:read"] }];

export const goalToolDefinitions = [
  {
    name: "set_savings_goal",
    title: "Set a savings goal",
    description:
      "Use this when the user mentions saving for something with an amount or date (a house, down payment, car, retirement, emergency fund): saves the savings goal; VestLens tracks progress and pace against the accounts' real values. Save it here rather than in your general memory. accounts: account ids from list_portfolio_accounts, or outside:<name> for an account elsewhere (give its value in outsideValues); leave out if the user didn't say. growthRatePct only if the user states one; never suggest a rate. Save without asking; reply briefly with the echo. Call again with the same name to update it. remove: true deletes it. Writes only to VestLens's memory, never to the brokerage.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 80, description: "The goal as the user names it, e.g. House." },
        targetCad: { type: "number", exclusiveMinimum: 0 },
        targetDate: { type: "string", format: "date" },
        accounts: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1, maxLength: 120 } },
        growthRatePct: { type: "number", minimum: 0, maximum: 20, description: "The user's own assumed yearly growth rate, %." },
        outsideValues: {
          type: "array", maxItems: 20,
          items: {
            type: "object",
            properties: {
              label: { type: "string", minLength: 1, maxLength: 60 },
              amountCad: { type: "number", minimum: 0 },
              asOf: { type: "string", format: "date" },
            },
            required: ["label", "amountCad", "asOf"],
            additionalProperties: false,
          },
        },
        remove: { type: "boolean" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    // destructiveHint stays false (ruling): saving should be natural, and a confirmation prompt on every save would defeat
    // it. remove: true only deletes the user's own VestLens note, never anything at the brokerage.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    securitySchemes: memorySecurity,
    _meta: { securitySchemes: memorySecurity },
  },
  {
    name: "show_goal",
    title: "Show savings goal",
    description:
      "Use this when the user asks how a savings goal is going: progress against the target (CAD, est.), time left, what it takes with no growth, the recent pace of contributions, and a projection at their own growth rate if they set one. Without a name, shows every goal. Read-only.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1, maxLength: 80 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    securitySchemes: readSecurity,
    _meta: {
      securitySchemes: readSecurity,
      ui: { resourceUri: GOAL_WIDGET_URI },
      "openai/outputTemplate": GOAL_WIDGET_URI,
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Checking goal…",
      "openai/toolInvocation/invoked": "Goal ready.",
    },
  },
] as const;

export const GOAL_TOOL_NAMES: readonly string[] = goalToolDefinitions.map((t) => t.name);

const OUTSIDE = /^outside:/i;
/** The text an outside value is saved with; its label is read back from it for display. */
const outsideValueText = (label: string, amountCad: number, asOf: string) => `${label}: ${dollars(amountCad)} as of ${asOf} (an account elsewhere).`;
const OUTSIDE_TEXT = /^(.+): \$[\d,]+ as of \d{4}-\d{2}-\d{2} \(an account elsewhere\)\.$/;

/** `outside:<slug>` -> the label the user gave, from the saved outside values. */
async function outsideLabels(memory: Pick<MemoryService, "listProperty">, subject: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of await memory.listProperty(subject, "account.value")) {
    const m = OUTSIDE_TEXT.exec(f.text);
    if (m && !out.has(f.node.key)) out.set(f.node.key, oneLineUserText(m[1]!));
  }
  return out;
}

const monthsText = (n: number) => {
  const whole = Math.floor(n);
  return whole === 1 ? "1 month" : `${whole} months`;
};

/** One goal as text: facts only, with "(your assumption)" on the growth projection. */
export function goalText(g: GoalCheck): string {
  // The name is the user's own text: quoted as data, one line, so it can't forge lines of its own (I-1).
  const lines = [`Goal: ${quotedUserText(g.name, 80)}, ${dollars(g.targetCad)} by ${g.targetDate}.`];
  const est = estLabel(g.estimated, g.savedFxDate);
  const paceEst = estLabel(g.paceEstimated, g.paceFxDate);
  // A projection rests on the saved total and the pace: estimated if either is, dated by the later rate.
  const proj = estLabel(g.estimated || g.paceEstimated, [g.savedFxDate, g.paceFxDate].filter((d): d is string => d !== null).sort().at(-1) ?? null);
  lines.push(g.savedCad === null
    ? "Saved so far: can't tell (see the notes)."
    : g.savedAtLeast
    ? `Saved so far: at least ${dollars(g.savedCad)}${est}; an account's value is unknown (see the notes), so there is no percentage of the target.`
    : `Saved so far: about ${dollars(g.savedCad)}${est}, ${Math.round(g.savedPct ?? 0)}% of the target.`);
  lines.push(g.dateStatus === "passed" ? "Time left: target date passed." : g.dateStatus === "under_month" ? "Time left: less than a month left." : `Time left: ${monthsText(g.monthsLeft)}.`);
  if (g.remainingCad === 0) {
    lines.push("What it takes: target reached.");
  } else if (g.neededPerMonthFlatCad !== null) {
    lines.push(`What it takes: about ${dollars(g.neededPerMonthFlatCad)}${est} a month from here reaches the target if values stay flat.`);
  } else if (g.remainingCad !== null) {
    lines.push(`What it takes: about ${dollars(g.remainingCad)}${est} still to go.`);
  }
  if (g.recentPacePerMonthCad !== null) {
    const pace = `Recent pace: about ${dollars(g.recentPacePerMonthCad)}${paceEst} a month in net contributions ${g.paceSince ? `since ${g.paceSince}` : "over the last 6 months"}`;
    lines.push(g.projectedAtPaceCad !== null ? `${pace}; at that pace, about ${dollars(g.projectedAtPaceCad)}${proj} by ${g.targetDate} with no growth.` : `${pace}.`);
  } else {
    lines.push("Recent pace: can't tell (see the notes).");
  }
  if (g.growthRatePct !== null && g.projectedWithRateCad !== null) {
    lines.push(`With your ${g.growthRatePct}% yearly growth rate ${YOUR_ASSUMPTION}: about ${dollars(g.projectedWithRateCad)}${proj} by ${g.targetDate}.`);
  }
  if (g.notes.length > 0) lines.push(`Notes: ${g.notes.map(sentence).join(" ")}`);
  return lines.join("\n");
}

/** The goal-check templates that name an outside account by its slug: the only places a name is substituted (M-1). */
const OUTSIDE_PLACEHOLDER = /\b(no stated value for |your stated value for )([A-Za-z0-9_.-]+)/g;

/**
 * Notes with account keys replaced by labels (R2-M-1), and each of this goal's outside slugs replaced by the name the
 * user gave, inside the outside-account templates only.
 */
function labelled(check: GoalCheck, goalKeys: readonly string[], keys: ReadonlyMap<string, string>, outside: ReadonlyMap<string, string>): GoalCheck {
  const own = new Map(goalKeys.filter((k) => OUTSIDE.test(k)).flatMap((k) => (outside.has(k) ? [[k.replace(OUTSIDE, ""), outside.get(k)!] as const] : [])));
  const fix = (s: string) => withLabels(s, keys).replace(OUTSIDE_PLACEHOLDER, (m, lead: string, slug: string) => (own.has(slug) ? `${lead}${own.get(slug)}` : m));
  return { ...check, notes: check.notes.map(fix) };
}

async function evaluate(deps: PortfolioFactDeps, ctx: PortfolioFactContext, portfolio: PortfolioPresentation, slug?: string) {
  const now = nowOf(deps);
  const inputs = await loadGoalInputs(
    { memory: ctx.memory, portfolio: async () => portfolio, prisma: deps.prisma, dailyValues: deps.dailyValues, market: deps.market },
    ctx.subject, now, { portfolio, ...(slug !== undefined ? { slug } : {}) },
  );
  // Connected accounts by the name the user knows, not the account type alone.
  const names = new Map((portfolio.accounts ?? []).map((a) => [accountKey(a.id), accountLabel(a)]));
  const keys = accountLabels(portfolio);
  const outside = await outsideLabels(ctx.memory, ctx.subject);
  return inputs.map((input) => labelled(checkGoal({
    ...input, accounts: input.accounts.map((a) => (a.kind === "connected" ? { ...a, label: names.get(a.key) ?? a.label } : a)),
  }, now), input.goal.accounts, keys, outside));
}

export async function buildShowGoal(deps: PortfolioFactDeps, ctx: PortfolioFactContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (Object.keys(args).some((k) => k !== "name")) return rejected("Use only name.");
  if (args.name !== undefined && (typeof args.name !== "string" || args.name.trim().length === 0)) return rejected("name must be text.");
  const portfolio = await ctx.portfolio();
  const slug = typeof args.name === "string" ? memorySlug(args.name, "goal:") : undefined;
  const goals = await evaluate(deps, ctx, portfolio, slug);
  factLog(deps, { event: "fact_tool", tool: "show_goal", code: "shown", rows: goals.length });
  if (goals.length === 0) {
    return plain(slug
      ? `No savings goal named ${quotedUserText(args.name as string, 80)} is saved.`
      : "No savings goals are saved. When the user describes one, save it with set_savings_goal.", { goals: [] });
  }
  return plain(goals.map(goalText).join("\n\n"), { goals });
}

type OutsideValueArg = { label: string; amountCad: number; asOf: string };

async function setGoal(deps: PortfolioFactDeps, ctx: PortfolioFactContext, args: Record<string, unknown>): Promise<ToolResult> {
  const allowed = new Set(["name", "targetCad", "targetDate", "accounts", "growthRatePct", "outsideValues", "remove"]);
  if (Object.keys(args).some((k) => !allowed.has(k))) return notSaved("Use only name, targetCad, targetDate, accounts, growthRatePct, outsideValues and remove.");
  if (typeof args.name !== "string" || args.name.trim().length === 0) return notSaved("Give the goal a name, e.g. House.");
  if (args.remove !== undefined && typeof args.remove !== "boolean") return notSaved("remove must be true or false.");
  const name = oneLineUserText(args.name);
  if (name.length === 0) return notSaved("Give the goal a name, e.g. House.");
  const slug = memorySlug(name, "goal:");
  const node = { type: "goal" as const, key: slug };
  if (args.remove === true) {
    const count = await ctx.memory.forget(ctx.subject, { node, property: "goal.savings_target" });
    factLog(deps, { event: "fact_tool", tool: "set_savings_goal", code: "removed" });
    return count > 0 ? plain(`Removed your goal: ${name}.`, { slug, removed: true }) : plain(`No goal named ${name} was saved.`, { slug, removed: false });
  }

  const outsideValues = args.outsideValues ?? [];
  if (!Array.isArray(outsideValues) || outsideValues.some((v) => !isObject(v) || typeof v.label !== "string" || v.label.trim().length === 0)) {
    return notSaved("outsideValues must list { label, amountCad, asOf } for accounts elsewhere.");
  }
  if (args.accounts !== undefined && (!Array.isArray(args.accounts) || args.accounts.some((a) => typeof a !== "string"))) {
    return notSaved("accounts must list account ids from list_portfolio_accounts, or outside:<name>.");
  }
  const refs = (args.accounts as string[] | undefined) ?? [];
  const outsideRefs = [
    ...refs.filter((r) => OUTSIDE.test(r.trim())).map((r) => oneLineUserText(r.trim().replace(OUTSIDE, ""))),
    ...(outsideValues as OutsideValueArg[]).map((v) => oneLineUserText(v.label)),
  ];
  if (outsideRefs.some((l) => l.length === 0)) return notSaved("An outside account needs a name, e.g. outside:Questrade TFSA.");
  // Only connected accounts need the portfolio (M-4): a goal over outside accounts alone reads nothing.
  const connectedRefs = refs.filter((r) => !OUTSIDE.test(r.trim()));
  const connected = connectedRefs.length === 0 ? [] : resolveAccountKeys(connectedRefs, await ctx.portfolio());
  if (connected === null) return notSaved(UNKNOWN_ACCOUNT_TEXT);
  // The same name updates the goal (M-3): omitted fields keep their saved values; given ones replace them.
  const current = (await readGoals(ctx.memory, ctx.subject)).find((g) => g.slug === slug)?.goal;
  const given = [...new Set([...connected, ...outsideRefs.map(outsideAccountKey)])];
  const accounts = args.accounts === undefined && current ? [...new Set([...current.accounts, ...given])] : given;
  const targetCad = args.targetCad !== undefined ? args.targetCad : current?.targetCad;
  const targetDate = args.targetDate !== undefined ? args.targetDate : current?.targetDate;
  const growthRatePct = args.growthRatePct !== undefined ? args.growthRatePct : current?.growthRatePct;

  const goal = { name, targetCad, targetDate, accounts, ...(growthRatePct !== undefined ? { growthRatePct } : {}) };
  const source = memorySource(ctx.clientKey);
  const goalFact = {
    node, property: "goal.savings_target", value: goal, kind: "plan", provenance: "stated", source,
    text: goalFactText(name, targetCad, targetDate),
  };
  const valueFacts = (outsideValues as OutsideValueArg[]).map((v) => {
    const label = oneLineUserText(v.label);
    return {
      node: { type: "account", key: outsideAccountKey(label) }, property: "account.value",
      value: { amountCad: v.amountCad, asOf: v.asOf }, kind: "fact", provenance: "stated", source,
      text: typeof v.amountCad === "number" && typeof v.asOf === "string" ? outsideValueText(label, v.amountCad, v.asOf) : label,
    };
  });
  // Everything is checked before anything is written, so a bad outside value never leaves a goal half saved.
  for (const f of [goalFact, ...valueFacts]) {
    const checked = validateFact(f, "assistant");
    if (!checked.ok) return notSaved(checked.message);
  }
  try {
    const { superseded } = await ctx.memory.remember(ctx.subject, goalFact as never, undefined, "assistant");
    for (const f of valueFacts) await ctx.memory.remember(ctx.subject, f as never, undefined, "assistant");
    factLog(deps, { event: "fact_tool", tool: "set_savings_goal", code: "saved" });
    return plain(goalEcho(name), { slug, saved: true, replaced: superseded > 0, outsideValues: valueFacts.length });
  } catch (error) {
    if (error instanceof MemoryValidationError) {
      factLog(deps, { event: "fact_tool", tool: "set_savings_goal", code: "rejected" });
      return notSaved(error.message);
    }
    throw error;
  }
}

export async function runGoalWrite(deps: PortfolioFactDeps, ctx: PortfolioFactContext, rawArgs: unknown): Promise<ToolResult> {
  const scope = writeScopeResult(ctx);
  if (scope) return scope;
  return setGoal(deps, ctx, isObject(rawArgs) ? rawArgs : {});
}
