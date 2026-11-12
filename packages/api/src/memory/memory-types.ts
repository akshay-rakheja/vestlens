import { z } from "zod";

import { oneLineUserText } from "../mcp/user-text.js";
import { HASH_KEY_PATTERN, outsideAccountKey } from "./keys.js";

/**
 * Portfolio memory as a small typed graph (spec §5.1): facts about fixed node types, each through a property
 * allowed for that type. Four reserved TFSA properties and four typed portfolio properties (thesis, limit, goal, outside value) carry
 * typed values that may feed numbers; every other property carries free JSON or null and is context only. Validation is plain code, never a model, and its
 * messages never echo the submitted text or value, so an assistant can relay them as they are.
 */

export const NODE_TYPES = ["account", "security", "sector", "tax_year", "goal", "rule", "activity", "user"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export interface NodeRef {
  type: NodeType;
  key: string;
}

export const PROVENANCES = ["stated", "inferred", "imported", "derived"] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** Assistants may write only these; imported and derived come from VestLens's own code. */
export const ASSISTANT_PROVENANCES: readonly Provenance[] = ["stated", "inferred"];

export const KINDS = ["fact", "plan", "reason", "note"] as const;
export type MemoryKind = (typeof KINDS)[number];

/** Who is writing: an assistant through MCP, the dashboard, or VestLens itself (imports, derived facts). */
export type MemoryCaller = "assistant" | "dashboard" | "system";

export const MAX_TEXT_LENGTH = 2000;
export const MAX_NODE_KEY_LENGTH = 120;
export const NODE_KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_VALUE_JSON_LENGTH = 4000;
const SOURCE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const OUTSIDE_LABEL = /^outside:[A-Za-z0-9_.-]{1,60}$/;
const TAX_YEAR_KEY = /^(\d{4}):([a-z_]{2,16})$/;
const TFSA_KEY = /^(\d{4}):tfsa$/;
const FHSA_KEY = /^(\d{4}):fhsa$/;
const RRSP_KEY = /^(\d{4}):rrsp$/;
const SECURITY_KEY = /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,23}$/;
const MIN_YEAR = 2009;
const MAX_YEAR = 2100;

/** Only these provenances may feed the room engine, an alert or any number. Inferred facts are context only. */
export function feedsNumbers(provenance: Provenance): boolean {
  return provenance === "stated" || provenance === "imported" || provenance === "derived";
}

/** Normalizes a node key per type, or explains (without echoing it) why it is not a valid key. */
function nodeKeyError(type: NodeType, key: string): string | null {
  if (key.length === 0 || key.length > MAX_NODE_KEY_LENGTH || !NODE_KEY_PATTERN.test(key)) {
    return `Invalid node key: use 1-${MAX_NODE_KEY_LENGTH} letters, digits or _ . : -`;
  }
  switch (type) {
    case "account":
      return HASH_KEY_PATTERN.test(key) || OUTSIDE_LABEL.test(key) ? null
        : "Invalid account key: use a connected account's key or outside:<label>";
    case "activity":
      return HASH_KEY_PATTERN.test(key) ? null : "Invalid activity key: use the activity's 16-character key";
    case "security":
      return SECURITY_KEY.test(key) ? null : "Invalid security key: use the ticker symbol";
    case "tax_year": {
      const m = TAX_YEAR_KEY.exec(key);
      return m && Number(m[1]) >= MIN_YEAR && Number(m[1]) <= MAX_YEAR ? null : "Invalid tax_year key: use <year>:<account type>, e.g. 2026:tfsa";
    }
    case "user":
      return key === "me" ? null : "Invalid user key: use me";
    default:
      return null;
  }
}

export type NodeRefResult = { ok: true; node: NodeRef } | { ok: false; message: string };

/** Validates a node reference; tickers are upper-cased so SHOP and shop are one node. */
export function parseNodeRef(input: unknown): NodeRefResult {
  if (typeof input !== "object" || input === null) return { ok: false, message: "A node must be { type, key }." };
  const { type, key } = input as { type?: unknown; key?: unknown };
  if (typeof type !== "string" || !(NODE_TYPES as readonly string[]).includes(type)) {
    return { ok: false, message: `Unknown node type. Use one of: ${NODE_TYPES.join(", ")}.` };
  }
  if (typeof key !== "string") return { ok: false, message: "A node key is required." };
  const nodeType = type as NodeType;
  const normalized = nodeType === "security" ? key.trim().toUpperCase() : key.trim();
  const error = nodeKeyError(nodeType, normalized);
  return error ? { ok: false, message: error } : { ok: true, node: { type: nodeType, key: normalized } };
}

const amountCad = z.number().nonnegative();

/**
 * Typed portfolio properties (theses, concentration limits, savings goals, declared outside values). Like the
 * reserved TFSA properties they are typed and come from the user (stated, or imported by VestLens), but they do not
 * touch the room engine, so they are not "reserved": no room hook, and an update supersedes the whole topic.
 */
export const MAX_CONDITIONS = 5;
export const MAX_THESES = 50;
export const MAX_LIMITS = 20;
export const MAX_GOALS = 10;
const MAX_CONDITION_TEXT = 300;
const CONDITION_ID = /^[A-Za-z0-9_-]{1,32}$/;
/** rule:<slug> and goal:<slug> keys for typed facts: lower-case letters, digits and single dashes (keys.ts memorySlug). */
const SLUG_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const pct = z.number().min(0).max(100);
const isoDay = z.iso.date();

const conditionBase = { id: z.string().regex(CONDITION_ID).optional(), text: z.string().trim().min(1).max(MAX_CONDITION_TEXT) };
const priceCondition = { price: z.number().positive().finite(), currency: z.string().regex(/^[A-Za-z]{3}$/).transform((c) => c.toUpperCase()) };

export const ConditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("price_below"), ...conditionBase, ...priceCondition }),
  z.strictObject({ kind: z.literal("price_above"), ...conditionBase, ...priceCondition }),
  z.strictObject({ kind: z.literal("return_below"), ...conditionBase, pct: z.number().min(-100).max(1000) }),
  z.strictObject({ kind: z.literal("weight_above"), ...conditionBase, pct }),
  z.strictObject({ kind: z.literal("fundamental"), ...conditionBase, metric: z.string().trim().min(1).max(60).optional(), threshold: z.number().finite().optional() }),
  z.strictObject({ kind: z.literal("custom"), ...conditionBase }),
]);
/** A condition as stored: the server assigns `id` when the user's assistant did not give one. */
export type Condition = z.output<typeof ConditionSchema> & { id: string };
export type ConditionKind = Condition["kind"];

/** FNV-1a (32-bit), hex: a short id from content, stable across saves; not a security hash. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Keeps given ids; gives each other condition `c<hash of kind and text>`, so re-saving the same conditions keeps
 * their ids whatever the order. A repeat of the same condition gets a -2, -3 suffix.
 */
function withConditionIds(conditions: Array<z.output<typeof ConditionSchema>>): Condition[] {
  const taken = new Set(conditions.flatMap((c) => (c.id ? [c.id] : [])));
  return conditions.map((c) => {
    if (c.id) return c as Condition;
    const stem = `c${fnv1a(`${c.kind}\u0000${collapseWhitespace(c.text).toLowerCase()}`)}`;
    let id = stem;
    for (let n = 2; taken.has(id); n++) id = `${stem}-${n}`;
    taken.add(id);
    return { ...c, id };
  });
}

export const ThesisSchema = z.strictObject({
  reasons: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
  timeFrame: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("short"), endDate: isoDay }),
    z.strictObject({ kind: z.literal("long"), years: z.number().positive().max(100) }),
  ]).nullable(),
  conditions: z.array(ConditionSchema).max(MAX_CONDITIONS).optional().default([]),
  boughtAround: isoDay.optional(),
  /**
   * When this thesis was first written: server-set by log_thesis, kept by an amendment (same or omitted reasons), new for new
   * reasons. Older rows without it use their version's recordedAt.
   */
  writtenAt: z.iso.datetime({ offset: true }).optional(),
}).refine((t) => {
  const ids = t.conditions.flatMap((c) => (c.id ? [c.id] : []));
  return new Set(ids).size === ids.length;
}, { message: "duplicate_condition_id", path: ["conditions"] })
  .transform((t) => ({ ...t, conditions: withConditionIds(t.conditions) }));
export type Thesis = z.output<typeof ThesisSchema>;

/**
 * A user-named label (goal name, limit target, outside-account label) that VestLens places inside its own sentences:
 * control and format characters removed and whitespace collapsed on save, so a stored name can't forge lines.
 */
const userLabel = (max: number) => z.string().overwrite(oneLineUserText).min(1).max(max);

export const ConcentrationLimitSchema = z.strictObject({
  kind: z.enum(["single_holding", "sector", "asset_class"]),
  target: userLabel(80).optional(),
  maxPct: pct,
  accounts: z.array(z.string().regex(HASH_KEY_PATTERN)).min(1).max(100).optional(),
});
export type ConcentrationLimit = z.output<typeof ConcentrationLimitSchema>;

export const SavingsGoalSchema = z.strictObject({
  name: userLabel(80),
  targetCad: z.number().positive().finite(),
  targetDate: isoDay,
  accounts: z.array(z.string().regex(new RegExp(`${HASH_KEY_PATTERN.source}|${OUTSIDE_LABEL.source}`))).min(1).max(50),
  growthRatePct: z.number().min(0).max(20).optional(),
});
export type SavingsGoal = z.output<typeof SavingsGoalSchema>;

export const OutsideValueSchema = z.strictObject({ amountCad: amountCad.finite(), asOf: isoDay });
export type OutsideValue = z.output<typeof OutsideValueSchema>;

/**
 * What VestLens recorded about a holding when a thesis version was saved (spec §11a.2): the start value for "how it
 * played out" that outlives snapshot retention. `accountsSeen` lists every included account seen then (not only
 * holders), so a missing account is told apart from a value of 0. Server-written only.
 */
export const ThesisBaselineSchema = z.strictObject({
  writtenAt: z.iso.datetime({ offset: true }),
  positionsAsOf: z.iso.datetime({ offset: true }),
  valueCad: amountCad.finite(),
  units: z.number().finite().nonnegative(),
  priceNative: z.number().positive().finite().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  accountsSeen: z.array(z.string().regex(HASH_KEY_PATTERN)).max(100),
  /** Each seen account's own positions date: the value of each was taken at it, so moves between them are visible. */
  accountsAsOf: z.record(z.string().regex(HASH_KEY_PATTERN), z.iso.datetime({ offset: true })),
}).refine((b) => b.accountsSeen.every((k) => typeof b.accountsAsOf[k] === "string"), { message: "missing_account_positions_date", path: ["accountsAsOf"] });
export type ThesisBaseline = z.output<typeof ThesisBaselineSchema>;

/** Facts VestLens itself derives: never offered to or writable by assistants or the dashboard. */
export const SERVER_DERIVED_PROPERTIES = ["security.thesis_baseline"] as const;

export const TYPED_PORTFOLIO_PROPERTIES = ["security.thesis", "rule.concentration_limit", "goal.savings_target", "account.value"] as const;
export type TypedPortfolioProperty = (typeof TYPED_PORTFOLIO_PROPERTIES)[number];

/** How a property's validFrom is fixed: from the node's year, from value.year, never set, or free. */
type ValidFromRule = "node_year_jan1" | "value_year_jan1" | "none" | "free";

export interface PropertySpec {
  nodeType: NodeType;
  reserved: boolean;
  /** Reserved properties only. */
  schema?: z.ZodType;
  /** Human description of the value shape for error messages. */
  shape?: string;
  validFrom: ValidFromRule;
  /** Extra node-key rule for this property, with its message. */
  nodeKey?: { pattern: RegExp; message: string };
  /** Typed properties only: a rule on the parsed value, returning a plain message when it fails. */
  check?: (value: unknown) => string | null;
  /** Typed properties only: a plain message for a specific schema failure, instead of the generic shape message. */
  explain?: (issues: readonly z.core.$ZodIssue[]) => string | null;
  /** Only stated (or, from VestLens itself, imported) facts; inferred and derived are refused. */
  statedOnly?: boolean;
  /** Only derived facts, which only the system caller may write (assistants and the dashboard never can). */
  derivedOnly?: boolean;
  /** At most this many current facts of the property per subject (enforced by MemoryService through a CapPort). */
  cap?: { max: number; message: string };
}

export const OUTSIDE_LABEL_COLLISION = "Two outside accounts have names that are too similar; please name them differently.";

/** Null when every declared outside label maps to its own outside account key. */
export function outsideLabelCollision(outside: ReadonlyArray<{ label: string }>): string | null {
  const keys = new Set(outside.map((o) => outsideAccountKey(o.label)));
  return keys.size === outside.length ? null : OUTSIDE_LABEL_COLLISION;
}

const free = (nodeType: NodeType): PropertySpec => ({ nodeType, reserved: false, validFrom: "free" });

export const PROPERTY_REGISTRY: Readonly<Record<string, PropertySpec>> = {
  "tax_year.cra_room_jan1": {
    nodeType: "tax_year", reserved: true, validFrom: "node_year_jan1",
    schema: z.strictObject({ amountCad }),
    shape: "{ amountCad: number >= 0 }, the room on 1 January",
    nodeKey: { pattern: TFSA_KEY, message: "Invalid node key: tax_year.cra_room_jan1 belongs on <year>:tfsa" },
  },
  // The year's FHSA participation room as CRA reports it (it already includes the carry-forward and lifetime limit).
  "tax_year.fhsa_room": {
    nodeType: "tax_year", reserved: true, statedOnly: true, validFrom: "node_year_jan1",
    schema: z.strictObject({ amountCad }),
    shape: "{ amountCad: number >= 0 }, the year's FHSA participation room from CRA",
    nodeKey: { pattern: FHSA_KEY, message: "Invalid node key: tax_year.fhsa_room belongs on <year>:fhsa" },
  },
  // The year's RRSP deduction limit as CRA reports it (My Account or the notice of assessment).
  "tax_year.rrsp_deduction_limit": {
    nodeType: "tax_year", reserved: true, statedOnly: true, validFrom: "node_year_jan1",
    schema: z.strictObject({ amountCad }),
    shape: "{ amountCad: number >= 0 }, the year's RRSP deduction limit as CRA shows it",
    nodeKey: { pattern: RRSP_KEY, message: "Invalid node key: tax_year.rrsp_deduction_limit belongs on <year>:rrsp" },
  },
  // The unused RRSP contributions CRA shows for the year.
  "tax_year.rrsp_unused_contributions": {
    nodeType: "tax_year", reserved: true, statedOnly: true, validFrom: "node_year_jan1",
    schema: z.strictObject({ amountCad }),
    shape: "{ amountCad: number >= 0 }, the unused RRSP contributions CRA shows for the year",
    nodeKey: { pattern: RRSP_KEY, message: "Invalid node key: tax_year.rrsp_unused_contributions belongs on <year>:rrsp" },
  },
  // The tax year's contributions to RRSPs VestLens doesn't count (group RRSPs, other institutions, managed RRSPs, and
  // the user's contributions to a spousal RRSP for their spouse).
  "tax_year.rrsp_elsewhere": {
    nodeType: "tax_year", reserved: true, statedOnly: true, validFrom: "node_year_jan1",
    schema: z.strictObject({ amountCad }),
    shape: "{ amountCad: number >= 0 }, the tax year's contributions to RRSPs VestLens doesn't count, including contributions the user made to a spousal RRSP for their spouse",
    nodeKey: { pattern: RRSP_KEY, message: "Invalid node key: tax_year.rrsp_elsewhere belongs on <year>:rrsp" },
  },
  "tax_year.account_set": {
    nodeType: "tax_year", reserved: true, validFrom: "node_year_jan1",
    schema: z.strictObject({
      connected: z.array(z.string().regex(HASH_KEY_PATTERN)).max(100),
      outside: z.array(z.strictObject({ label: userLabel(60) })).max(20),
      confirmedAt: z.iso.datetime({ offset: true }),
      // Connected accounts the taxonomy leaves neutral that the user said are not TFSAs.
      notTfsa: z.array(z.string().regex(HASH_KEY_PATTERN)).max(100).optional().default([]),
    }),
    shape: "{ connected: accountKey[], outside: [{ label }], confirmedAt: ISO time, notTfsa?: accountKey[] }",
    check: (value) => outsideLabelCollision((value as { outside: Array<{ label: string }> }).outside),
    nodeKey: { pattern: TFSA_KEY, message: "Invalid node key: tax_year.account_set belongs on <year>:tfsa" },
  },
  "account.ytd_contributions": {
    nodeType: "account", reserved: true, validFrom: "value_year_jan1",
    schema: z.strictObject({ year: z.number().int().min(MIN_YEAR).max(MAX_YEAR), amountCad, asOf: z.iso.date() }),
    shape: "{ year: integer, amountCad: number >= 0, asOf: YYYY-MM-DD }",
    check: (value) => {
      const { year, asOf } = value as { year: number; asOf: string };
      return asOf.startsWith(`${year}-`) ? null : `The as-of date must be in the same year as the contributions (${year}).`;
    },
    // On a declared outside account, or on a connected TFSA whose stored activity does not reach 1 January (spec §9a.5).
    nodeKey: {
      pattern: new RegExp(`${HASH_KEY_PATTERN.source}|${OUTSIDE_LABEL.source}`),
      message: "Invalid node key: account.ytd_contributions belongs on a connected account's key or an outside:<label> account",
    },
  },
  "account.tfsa_moves": {
    nodeType: "account", reserved: true, validFrom: "value_year_jan1",
    schema: z.strictObject({
      year: z.number().int().min(MIN_YEAR).max(MAX_YEAR),
      entries: z.array(z.strictObject({ date: z.iso.date(), amountCad, kind: z.enum(["deposit", "withdrawal"]) })).max(200),
    }),
    shape: "{ year: integer, entries: [{ date: YYYY-MM-DD, amountCad: number >= 0, kind: \"deposit\" | \"withdrawal\" }] }",
    check: (value) => {
      const { year, entries } = value as { year: number; entries: Array<{ date: string }> };
      return entries.every((e) => e.date.startsWith(`${year}-`)) ? null : `Every deposit and withdrawal date must be in the same year (${year}).`;
    },
    nodeKey: { pattern: OUTSIDE_LABEL, message: "Invalid node key: account.tfsa_moves belongs on an outside:<label> account" },
  },
  "activity.room_effect": {
    nodeType: "activity", reserved: true, validFrom: "none",
    schema: z.strictObject({ effect: z.enum(["contribution", "withdrawal", "none"]) }),
    shape: "{ effect: \"contribution\" | \"withdrawal\" | \"none\" }",
  },
  "security.thesis": {
    nodeType: "security", reserved: false, statedOnly: true, validFrom: "none", schema: ThesisSchema,
    shape: "{ reasons: text, timeFrame: { kind: \"short\", endDate: YYYY-MM-DD } | { kind: \"long\", years: number > 0 } | null, "
      + "conditions?: up to 5 of { kind: price_below | price_above (price > 0, currency) | return_below (pct) | weight_above (pct 0-100) "
      + "| fundamental (metric?, threshold?) | custom, text, id? }, boughtAround?: YYYY-MM-DD, writtenAt?: ISO time }",
    explain: (issues) => {
      if (issues.some((i) => i.path[0] === "conditions" && i.path.length === 1 && i.code === "too_big")) return `A thesis can have at most ${MAX_CONDITIONS} conditions.`;
      if (issues.some((i) => i.message === "duplicate_condition_id")) return "Each condition needs its own id.";
      return null;
    },
    cap: { max: MAX_THESES, message: `You already have ${MAX_THESES} theses saved. Remove one before adding another.` },
  },
  "security.thesis_baseline": {
    nodeType: "security", reserved: false, derivedOnly: true, validFrom: "none", schema: ThesisBaselineSchema,
    shape: "{ writtenAt, positionsAsOf: ISO time, valueCad >= 0, units >= 0, priceNative: number > 0 | null, currency: XXX | null, accountsSeen: accountKey[], accountsAsOf: { accountKey: ISO time } }",
  },
  "rule.concentration_limit": {
    nodeType: "rule", reserved: false, statedOnly: true, validFrom: "none", schema: ConcentrationLimitSchema,
    shape: "{ kind: single_holding | sector | asset_class, target?: sector or asset class name, maxPct: 0-100, accounts?: accountKey[] }",
    nodeKey: { pattern: SLUG_KEY, message: "Invalid node key: a limit's key is a slug of lower-case letters, digits and dashes" },
    cap: { max: MAX_LIMITS, message: `You already have ${MAX_LIMITS} limits saved. Remove one before adding another.` },
  },
  "goal.savings_target": {
    nodeType: "goal", reserved: false, statedOnly: true, validFrom: "none", schema: SavingsGoalSchema,
    shape: "{ name, targetCad: number > 0, targetDate: YYYY-MM-DD, accounts: at least one accountKey or outside:<label>, growthRatePct?: 0-20 }",
    nodeKey: { pattern: SLUG_KEY, message: "Invalid node key: a goal's key is a slug of lower-case letters, digits and dashes" },
    cap: { max: MAX_GOALS, message: `You already have ${MAX_GOALS} goals saved. Remove one before adding another.` },
  },
  "account.value": {
    nodeType: "account", reserved: false, statedOnly: true, validFrom: "none", schema: OutsideValueSchema,
    shape: "{ amountCad: number >= 0, asOf: YYYY-MM-DD }",
    nodeKey: { pattern: OUTSIDE_LABEL, message: "Invalid node key: account.value belongs on an outside:<label> account" },
  },
  "security.reason": free("security"),
  "security.note": free("security"),
  "goal.target_date": free("goal"),
  "goal.note": free("goal"),
  "rule.limit": free("rule"),
  "rule.note": free("rule"),
  "user.risk_comfort": free("user"),
  "user.note": free("user"),
  "account.note": free("account"),
  "sector.note": free("sector"),
};

export const RESERVED_PROPERTIES: readonly string[] = Object.keys(PROPERTY_REGISTRY).filter((p) => PROPERTY_REGISTRY[p]!.reserved);

export function isReservedProperty(property: string): boolean {
  return PROPERTY_REGISTRY[property]?.reserved === true;
}

/** True when `property` is registered for `type`. */
export function propertyAllowed(type: NodeType, property: string): boolean {
  return PROPERTY_REGISTRY[property]?.nodeType === type;
}

export interface MemoryFactInput {
  node: NodeRef;
  property: string;
  value?: unknown;
  text: string;
  kind: MemoryKind;
  provenance: Provenance;
  /** YYYY-MM-DD or a Date (UTC day); world validity, day precision. */
  validFrom?: string | Date | null;
  validTo?: string | Date | null;
  /** The writing app, e.g. claude, chatgpt or dashboard. */
  source?: string | null;
}

export interface ValidatedFact {
  node: NodeRef;
  property: string;
  value: unknown | null;
  text: string;
  kind: MemoryKind;
  provenance: Provenance;
  validFrom: Date | null;
  validTo: Date | null;
  source: string | null;
}

export type ValidateResult = { ok: true; fact: ValidatedFact } | { ok: false; message: string };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A UTC-midnight Date for a YYYY-MM-DD string or a Date, or undefined when malformed. */
function parseDay(input: unknown): Date | null | undefined {
  if (input === undefined || input === null) return null;
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return undefined;
    return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  }
  if (typeof input !== "string") return undefined;
  const m = DAY.exec(input.trim());
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? d : undefined;
}

const jan1 = (year: number) => new Date(Date.UTC(year, 0, 1));

/** Plain JSON only (no functions, symbols or cycles), bounded in size. Returns undefined when not. */
function plainJson(value: unknown): unknown | undefined {
  if (value === undefined || value === null) return null;
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (text === undefined || text.length > MAX_VALUE_JSON_LENGTH) return undefined;
  return JSON.parse(text) as unknown;
}

const fail = (message: string): ValidateResult => ({ ok: false, message });

/** Every run of whitespace (newlines included) as one space, trimmed. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Reserved TFSA properties are stated or imported only (an inferred save is refused, never superseding a stated one). */
export const RESERVED_NEEDS_USER = "This needs to come from the user: ask them to confirm it, then save it as stated.";

/**
 * Checks a fact before it is saved: node type and key, that the property is allowed for that type, the typed value
 * and validFrom of reserved properties, kind, text and provenance. Assistant callers may only use stated or inferred.
 */
export function validateFact(input: unknown, caller: MemoryCaller = "assistant"): ValidateResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return fail("A memory fact must be an object.");
  const raw = input as Record<string, unknown>;

  const node = parseNodeRef(raw.node);
  if (!node.ok) return fail(node.message);

  const property = raw.property;
  if (typeof property !== "string" || !propertyAllowed(node.node.type, property)) {
    const allowed = Object.keys(PROPERTY_REGISTRY).filter((p) => propertyAllowed(node.node.type, p));
    return fail(`That property is not allowed for a ${node.node.type} node. Allowed: ${allowed.join(", ")}.`);
  }
  const spec = PROPERTY_REGISTRY[property]!;
  if (spec.nodeKey && !spec.nodeKey.pattern.test(node.node.key)) return fail(spec.nodeKey.message);

  if (typeof raw.provenance !== "string" || !(PROVENANCES as readonly string[]).includes(raw.provenance)) {
    return fail("Provenance is required: stated (the user said it) or inferred (you concluded it).");
  }
  const provenance = raw.provenance as Provenance;
  if (caller !== "system" && !ASSISTANT_PROVENANCES.includes(provenance)) {
    return fail("Only stated or inferred facts can be saved here.");
  }
  // Reserved TFSA inputs feed the room number and its alert, so a guess must never replace what the user said.
  if (spec.reserved && provenance === "inferred") return fail(RESERVED_NEEDS_USER);
  // Theses, limits, goals and outside values are the user's own words: never inferred, never derived.
  if (spec.statedOnly && provenance !== "stated" && provenance !== "imported") return fail(RESERVED_NEEDS_USER);
  // Server-derived facts (thesis baselines) are VestLens's own records, never anyone's statement.
  if (spec.derivedOnly && (provenance !== "derived" || caller !== "system")) return fail("That fact is recorded by VestLens itself and can't be saved here.");

  if (typeof raw.kind !== "string" || !(KINDS as readonly string[]).includes(raw.kind)) {
    return fail(`Kind must be one of: ${KINDS.join(", ")}.`);
  }
  const kind = raw.kind as MemoryKind;

  if (typeof raw.text !== "string" || raw.text.trim().length === 0) return fail("Text is required: the fact in plain words.");
  // One line: stored text is shown back inside quoted, line-per-fact blocks, so it can't forge lines of its own.
  const text = collapseWhitespace(raw.text);
  if (text.length > MAX_TEXT_LENGTH) return fail(`Text must be at most ${MAX_TEXT_LENGTH} characters.`);

  let value: unknown;
  if (spec.schema) {
    const parsed = spec.schema.safeParse(raw.value);
    if (!parsed.success) return fail(spec.explain?.(parsed.error.issues) ?? `Invalid value for ${property}: expected ${spec.shape}.`);
    value = parsed.data;
    const problem = spec.check?.(value) ?? null;
    if (problem) return fail(problem);
  } else {
    value = plainJson(raw.value);
    if (value === undefined) return fail(`Invalid value: use plain JSON of at most ${MAX_VALUE_JSON_LENGTH} characters, or null.`);
  }

  const givenFrom = parseDay(raw.validFrom);
  if (givenFrom === undefined) return fail("Invalid validFrom: use YYYY-MM-DD.");
  const validTo = parseDay(raw.validTo);
  if (validTo === undefined) return fail("Invalid validTo: use YYYY-MM-DD.");

  let validFrom: Date | null = givenFrom;
  if (spec.validFrom === "node_year_jan1" || spec.validFrom === "value_year_jan1") {
    const year = spec.validFrom === "node_year_jan1"
      ? Number(TAX_YEAR_KEY.exec(node.node.key)![1])
      : (value as { year: number }).year;
    const expected = jan1(year);
    if (givenFrom !== null && givenFrom.getTime() !== expected.getTime()) {
      return fail(`${property} is valid from 1 January of its year; leave validFrom empty or use ${year}-01-01.`);
    }
    validFrom = expected;
  } else if (spec.validFrom === "none" && givenFrom !== null) {
    return fail(`${property} takes no validFrom.`);
  }
  if (validFrom && validTo && validTo.getTime() < validFrom.getTime()) return fail("Invalid validTo: it is before validFrom.");

  const source = raw.source ?? null;
  if (source !== null && (typeof source !== "string" || !SOURCE_PATTERN.test(source))) {
    return fail("Invalid source: use the app's short name, e.g. claude, chatgpt or dashboard.");
  }

  return { ok: true, fact: { node: node.node, property, value, text, kind, provenance, validFrom, validTo, source } };
}

/** Counts a subject's current facts, for the per-user caps. MemoryService supplies it from its repository. */
export interface CapPort {
  countCurrent(subject: string, property: string): Promise<number>;
  /** True when the topic (node, property) already has a current fact, so a save supersedes rather than adds. */
  hasCurrent(subject: string, node: NodeRef, property: string): Promise<boolean>;
}

/** The plain cap message when saving `fact` would add a topic beyond its property's cap, else null. */
export async function capViolation(subject: string, fact: Pick<ValidatedFact, "node" | "property">, port: CapPort): Promise<string | null> {
  const cap = PROPERTY_REGISTRY[fact.property]?.cap;
  if (!cap) return null;
  if ((await port.countCurrent(subject, fact.property)) < cap.max) return null;
  return (await port.hasCurrent(subject, fact.node, fact.property)) ? null : cap.message;
}

export interface MemoryFact {
  id: string;
  subject: string;
  node: NodeRef;
  property: string;
  value: unknown | null;
  text: string;
  kind: MemoryKind;
  provenance: Provenance;
  validFrom: Date | null;
  validTo: Date | null;
  recordedAt: Date;
  source: string | null;
  supersededAt: Date | null;
}

/** A row as stored (flat node columns). */
export interface StoredFact {
  id: string;
  subject: string;
  nodeType: string;
  nodeKey: string;
  property: string;
  value: unknown | null;
  text: string;
  kind: string;
  provenance: string;
  validFrom: Date | null;
  validTo: Date | null;
  recordedAt: Date;
  source: string | null;
  supersededAt: Date | null;
}

/** A fact with how long ago VestLens learned it and whether it sits on the focus (0) or one hop away (1). */
export type ContextFact = MemoryFact & { ageDays: number; hop: 0 | 1 };

export function toMemoryFact(row: StoredFact): MemoryFact {
  return {
    id: row.id,
    subject: row.subject,
    node: { type: row.nodeType as NodeType, key: row.nodeKey },
    property: row.property,
    value: row.value ?? null,
    text: row.text,
    kind: row.kind as MemoryKind,
    provenance: row.provenance as Provenance,
    validFrom: row.validFrom,
    validTo: row.validTo,
    recordedAt: row.recordedAt,
    source: row.source,
    supersededAt: row.supersededAt,
  };
}

const DAY_MS = 86_400_000;

export function withAge(row: StoredFact, hop: 0 | 1, now: Date): ContextFact {
  return { ...toMemoryFact(row), hop, ageDays: Math.max(0, Math.floor((now.getTime() - row.recordedAt.getTime()) / DAY_MS)) };
}

/** A save the validator rejected; `message` is plain and safe to relay to the user. */
export class MemoryValidationError extends Error {
  readonly code = "invalid_fact";
  constructor(message: string) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

/** Another write took the topic's current slot first, twice. */
export class MemoryConflictError extends Error {
  readonly code = "memory_conflict";
  constructor() {
    super("Another save for this topic happened at the same time. Try again.");
    this.name = "MemoryConflictError";
  }
}

export class MemoryNotFoundError extends Error {
  readonly code = "memory_not_found";
  constructor() {
    super("No such memory entry.");
    this.name = "MemoryNotFoundError";
  }
}

