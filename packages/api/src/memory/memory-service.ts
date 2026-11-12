import { neighbourhood, type BrokerageLinks } from "./context-builder.js";
import {
  capViolation,
  isReservedProperty,
  type CapPort,
  toMemoryFact,
  withAge,
  type ContextFact,
  type MemoryFact,
  type StoredFact,
  parseNodeRef,
  validateFact,
  type MemoryCaller,
  type MemoryFactInput,
  type MemoryKind,
  type NodeRef,
  type NodeType,
  type Provenance,
} from "./memory-types.js";

import { MemoryConflictError, MemoryNotFoundError, MemoryValidationError } from "./memory-types.js";
import { matchCount, queryTokens } from "./search.js";

export type { ContextFact, MemoryFact, StoredFact } from "./memory-types.js";
export { MemoryConflictError, MemoryNotFoundError, MemoryValidationError } from "./memory-types.js";

/**
 * Subject-keyed portfolio memory (spec §5). Append-only: a new fact supersedes the current one for the same
 * (node, property), and for reserved properties the same validFrom too; history is kept until the user deletes it.
 * At most one current fact per topic is enforced by the table's partial unique index; a write that loses a race
 * is retried once. Logs carry counts and constant codes only.
 */

export type NewStoredFact = Omit<StoredFact, "id" | "supersededAt">;

export interface FactFilter {
  /** Any of these nodes. An empty list matches nothing. */
  nodes?: NodeRef[];
  nodeType?: NodeType;
  /** Property prefix (an exact name matches itself). */
  property?: string;
  /** Exact validFrom (null matches facts without one). */
  validFrom?: Date | null;
  /** Any of these tokens (search.ts queryTokens) in the text, node key or property, case-insensitive. */
  anyTokens?: string[];
  includeHistory?: boolean;
  take: number;
}

export interface MemoryRepository {
  /**
   * In one transaction: mark the subject's current facts for the topic superseded (only those with the same
   * validFrom when `sameValidFrom`), then insert. Throws MemoryConflictError when the insert breaks the
   * one-current-fact index because a concurrent write won.
   */
  supersedeAndInsert(fact: NewStoredFact, scope: { sameValidFrom: boolean }): Promise<{ fact: StoredFact; superseded: number }>;
  /** Newest first (recordedAt, then id). */
  find(subject: string, filter: FactFilter): Promise<StoredFact[]>;
  findById(subject: string, id: string): Promise<StoredFact | null>;
  /** Every fact, current and superseded, oldest first (export). */
  listAll(subject: string): Promise<StoredFact[]>;
  deleteById(subject: string, id: string): Promise<number>;
  deleteTopic(subject: string, nodeType: string, nodeKey: string, property: string): Promise<number>;
  deleteBySubject(subject: string): Promise<number>;
}

/** Counts and constant codes only: never text, values, node keys, ids or subjects. */
export type MemoryLogEvent =
  | { event: "memory_remembered"; nodeType: NodeType; property: string; provenance: Provenance; superseded: number; retried: boolean }
  | { event: "memory_rejected"; code: "invalid_fact" | "cap_reached" }
  | { event: "memory_conflict_retry" }
  | { event: "memory_recalled"; count: number; hop1: number; typeMatched: number }
  | { event: "memory_attached"; count: number }
  | { event: "memory_forgotten"; count: number }
  | { event: "memory_promoted" }
  | { event: "memory_subject_deleted"; count: number }
  | { event: "memory_hook_failed"; code: "room_alert_reevaluate" }
  | { event: "room_alert_hook_timeout" };

export interface MemoryServiceOptions {
  repository: MemoryRepository;
  /** Brokerage links for hop-1 recall; without them recall is hop 0 only. */
  links?: BrokerageLinks;
  now?: () => Date;
  log?: (event: MemoryLogEvent) => void;
  /**
   * Called, and awaited, after a remember or forget touches a reserved TFSA property (composition wires the room
   * alert re-evaluation here). Best effort: a failure, or no answer within HOOK_DEADLINE_MS, is logged as a code and never fails the memory call.
   */
  onReservedChange?: (subject: string) => Promise<unknown>;
}

export interface RecallQuery {
  node?: NodeRef;
  property?: string;
  text?: string;
  includeHistory?: boolean;
  limit?: number;
}

export type ExportedFact = Omit<StoredFact, "id" | "subject">;

/**
 * A recalled fact. With a node query, `matched` says whether it is on that node (or one hop from it: "exact") or,
 * because that exact node has no current facts, another node of the same type ("type").
 */
export type RecalledFact = ContextFact & { matched?: "exact" | "type" };

export const DEFAULT_RECALL_LIMIT = 20;
/** Facts appended to portfolio tool results ("What you've told VestLens"). */
export const RESULTS_MEMORY_LIMIT = 8;
export const MAX_RECALL_LIMIT = 50;
const MAX_TEXT_QUERY = 200;
const MAX_CURRENT_LIST = 500;
/** Rows read for one typed property (caps are at most 50 current; history versions add to that). */
const MAX_TYPED_LIST = 1000;
/** Token matches read before ranking; at this scale a subject's matching facts fit well within it. */
const MAX_TOKEN_CANDIDATES = 500;
/** The most a memory call waits for the alert re-evaluation it triggers. */
export const HOOK_DEADLINE_MS = 2000;

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_RECALL_LIMIT;
  return Math.min(MAX_RECALL_LIMIT, Math.max(1, Math.floor(limit)));
}

export class MemoryService {
  private readonly now: () => Date;

  constructor(private readonly o: MemoryServiceOptions) {
    this.now = o.now ?? (() => new Date());
  }

  private log(event: MemoryLogEvent): void {
    (this.o.log ?? ((e: MemoryLogEvent) => console.info(JSON.stringify(e))))(event);
  }

  private node(input: unknown): NodeRef {
    const parsed = parseNodeRef(input);
    if (!parsed.ok) throw new MemoryValidationError(parsed.message);
    return parsed.node;
  }

  async remember(subject: string, input: MemoryFactInput, now: Date = this.now(), caller: MemoryCaller = "assistant"): Promise<{ fact: MemoryFact; superseded: number }> {
    const result = validateFact(input, caller);
    if (!result.ok) {
      this.log({ event: "memory_rejected", code: "invalid_fact" });
      throw new MemoryValidationError(result.message);
    }
    const f = result.fact;
    // Re-saving an existing topic supersedes it, so only a new topic can hit a cap. Two new topics saved at the same
    // moment can both pass at cap - 1; the caps bound abuse, not an invariant, so that is accepted.
    const capMessage = await capViolation(subject, f, this.capPort);
    if (capMessage) {
      this.log({ event: "memory_rejected", code: "cap_reached" });
      throw new MemoryValidationError(capMessage);
    }
    const row: NewStoredFact = {
      subject, nodeType: f.node.type, nodeKey: f.node.key, property: f.property, value: f.value, text: f.text, kind: f.kind,
      provenance: f.provenance, validFrom: f.validFrom, validTo: f.validTo, recordedAt: now, source: f.source,
    };
    const scope = { sameValidFrom: isReservedProperty(f.property) };
    let retried = false;
    let written: { fact: StoredFact; superseded: number };
    try {
      written = await this.o.repository.supersedeAndInsert(row, scope);
    } catch (error) {
      if (!(error instanceof MemoryConflictError)) throw error;
      // The concurrent writer has committed; this attempt supersedes its fact instead.
      this.log({ event: "memory_conflict_retry" });
      retried = true;
      written = await this.o.repository.supersedeAndInsert(row, scope);
    }
    this.log({ event: "memory_remembered", nodeType: f.node.type, property: f.property, provenance: f.provenance, superseded: written.superseded, retried });
    if (isReservedProperty(f.property)) await this.reservedChanged(subject);
    return { fact: toMemoryFact(written.fact), superseded: written.superseded };
  }

  /** Current-fact counts for the per-user caps, read through the repository. */
  private readonly capPort: CapPort = {
    countCurrent: async (subject, property) =>
      (await this.o.repository.find(subject, { property, take: MAX_TYPED_LIST })).filter((r) => r.property === property).length,
    hasCurrent: async (subject, node, property) => (await this.current(subject, node, property)) !== null,
  };

  /**
   * Every fact of one exact property, newest first (recordedAt), current only unless `includeHistory`. Bounded; used by
   * the typed portfolio readers (portfolio-facts.ts), which also check provenance and re-parse each value.
   */
  async listProperty(subject: string, property: string, options: { includeHistory?: boolean } = {}): Promise<MemoryFact[]> {
    const rows = await this.o.repository.find(subject, { property, includeHistory: options.includeHistory === true, take: MAX_TYPED_LIST });
    return rows.filter((r) => r.property === property).map(toMemoryFact);
  }

  /** Best effort, and bounded: a hook that is slow or hangs is logged and abandoned, never failing the memory call. */
  private async reservedChanged(subject: string): Promise<void> {
    if (!this.o.onReservedChange) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), HOOK_DEADLINE_MS); });
    try {
      const run = Promise.resolve().then(() => this.o.onReservedChange!(subject));
      // A failure after the deadline has nothing left to report to; it must not become an unhandled rejection.
      run.catch(() => undefined);
      if ((await Promise.race([run.then(() => "done" as const), timeout])) === "timeout") this.log({ event: "room_alert_hook_timeout" });
    } catch {
      this.log({ event: "memory_hook_failed", code: "room_alert_reevaluate" });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Forgiving recall (staging walkthrough, 2026-10-24). No filters: every current fact, newest first, capped. `text`
   * is tokenised (search.ts): a fact matching any token is returned, most tokens first, then newest. `node`: that
   * node's neighbourhood; when the exact node has no current facts, the subject's facts on any node of that type.
   */
  async recall(subject: string, q: RecallQuery): Promise<RecalledFact[]> {
    const limit = clampLimit(q.limit);
    const tokens = queryTokens(q.text?.slice(0, MAX_TEXT_QUERY) ?? "");
    const property = q.property?.trim() || undefined;
    const filter = { ...(property ? { property } : {}), ...(tokens.length > 0 ? { anyTokens: tokens } : {}), includeHistory: q.includeHistory === true };
    const now = this.now();
    let facts: RecalledFact[];
    if (q.node) {
      const focus = this.node(q.node);
      const near = (await neighbourhood({ repository: this.o.repository, links: this.o.links, now: () => now }, subject, focus, limit, filter)).facts;
      const exact: RecalledFact[] = near.map((f) => ({ ...f, matched: "exact" }));
      if (near.some((f) => f.hop === 0)) {
        facts = exact;
      } else {
        const sameType = (await this.o.repository.find(subject, { ...filter, nodeType: focus.type, take: limit }))
          .map((r): RecalledFact => ({ ...withAge(r, 0, now), matched: "type" }));
        const seen = new Set(sameType.map((f) => f.id));
        facts = [...sameType, ...exact.filter((f) => !seen.has(f.id))].slice(0, limit);
      }
    } else if (tokens.length > 0) {
      const rows = await this.o.repository.find(subject, { ...filter, take: MAX_TOKEN_CANDIDATES });
      // Rows arrive newest first; a stable sort by match count keeps newest first within a count.
      facts = rows.map((r) => ({ r, n: matchCount(r, tokens) }))
        .sort((a, b) => b.n - a.n)
        .slice(0, limit)
        .map(({ r }) => withAge(r, 0, now));
    } else {
      facts = (await this.o.repository.find(subject, { ...filter, take: limit })).map((r) => withAge(r, 0, now));
    }
    this.log({
      event: "memory_recalled", count: facts.length, hop1: facts.filter((f) => f.hop === 1).length,
      typeMatched: facts.filter((f) => f.matched === "type").length,
    });
    return facts;
  }

  /** The newest current facts, with age, for the "What you've told VestLens" block on portfolio tool results. */
  async recent(subject: string, limit = RESULTS_MEMORY_LIMIT): Promise<ContextFact[]> {
    const now = this.now();
    const facts = (await this.o.repository.find(subject, { take: Math.max(1, Math.floor(limit)) })).map((r) => withAge(r, 0, now));
    this.log({ event: "memory_attached", count: facts.length });
    return facts;
  }

  /**
   * `{ id }` deletes the fact that entry belongs to: the entry's topic (node and property) with every earlier version,
   * so a deleted memory is gone; the id may be a current or a superseded version. `{ node, property }` does the same by name.
   */
  async forget(subject: string, target: { id: string } | { node: NodeRef; property: string }): Promise<number> {
    let count: number;
    let reserved: boolean;
    if ("id" in target) {
      const row = await this.o.repository.findById(subject, target.id);
      if (!row) {
        count = 0;
        reserved = false;
      } else {
        reserved = isReservedProperty(row.property);
        count = await this.o.repository.deleteTopic(subject, row.nodeType, row.nodeKey, row.property);
      }
    } else {
      const node = this.node(target.node);
      reserved = isReservedProperty(target.property);
      count = await this.o.repository.deleteTopic(subject, node.type, node.key, target.property);
    }
    this.log({ event: "memory_forgotten", count });
    if (reserved && count > 0) await this.reservedChanged(subject);
    return count;
  }

  /** The current fact for a topic; with `validFrom`, the one valid from that day. Newest wins if several. */
  async current(subject: string, node: NodeRef, property: string, validFrom?: Date | null): Promise<MemoryFact | null> {
    const ref = this.node(node);
    const rows = await this.o.repository.find(subject, {
      nodes: [ref], property, take: MAX_RECALL_LIMIT, ...(validFrom !== undefined ? { validFrom } : {}),
    });
    // The repository matches by prefix; keep the exact property.
    const exact = rows.find((r) => r.property === property);
    return exact ? toMemoryFact(exact) : null;
  }

  /** Re-records a current inferred fact as stated (a new fact that supersedes it), sourced to the promoting app. */
  async promote(subject: string, id: string, source = "dashboard", now: Date = this.now()): Promise<MemoryFact> {
    const row = await this.o.repository.findById(subject, id);
    if (!row) throw new MemoryNotFoundError();
    if (row.supersededAt !== null) throw new MemoryValidationError("Only the current entry can be promoted.");
    if (row.provenance !== "inferred") throw new MemoryValidationError("Only inferred entries can be promoted to stated.");
    const { fact } = await this.remember(subject, {
      node: { type: row.nodeType as NodeType, key: row.nodeKey }, property: row.property, value: row.value, text: row.text,
      kind: row.kind as MemoryKind, provenance: "stated", validFrom: row.validFrom, validTo: row.validTo, source,
    }, now, "dashboard");
    this.log({ event: "memory_promoted" });
    return fact;
  }

  /** Every current fact for the dashboard's memory section, newest first, capped. No history. */
  async listCurrent(subject: string): Promise<MemoryFact[]> {
    const rows = await this.o.repository.find(subject, { take: MAX_CURRENT_LIST });
    return rows.map(toMemoryFact);
  }

  /**
   * A dashboard edit: a superseding stated fact (source dashboard) with the entry's text and/or value replaced, saved
   * through remember so it is validated and the reserved-change hook fires. Only the caller's current entry can be edited.
   */
  async edit(subject: string, id: string, change: { text?: string; value?: unknown }, now: Date = this.now()): Promise<MemoryFact> {
    const row = await this.o.repository.findById(subject, id);
    if (!row || row.supersededAt !== null) throw new MemoryNotFoundError();
    const reserved = isReservedProperty(row.property);
    let value = change.value !== undefined ? change.value : row.value;
    // A thesis's writtenAt is server-set (log_thesis); an edit keeps it (its version's recordedAt for older rows).
    if (row.property === "security.thesis" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      const kept = (row.value as { writtenAt?: unknown } | null)?.writtenAt;
      value = { ...value, writtenAt: typeof kept === "string" ? kept : row.recordedAt.toISOString() };
    }
    const { fact } = await this.remember(subject, {
      node: { type: row.nodeType as NodeType, key: row.nodeKey }, property: row.property,
      value,
      text: change.text !== undefined ? change.text : row.text,
      kind: row.kind as MemoryKind, provenance: "stated",
      // Reserved properties derive their validFrom; the rest keep the entry's own.
      ...(reserved ? {} : { validFrom: row.validFrom }), validTo: row.validTo, source: "dashboard",
    }, now, "dashboard");
    return fact;
  }

  async deleteSubject(subject: string): Promise<number> {
    const count = await this.o.repository.deleteBySubject(subject);
    this.log({ event: "memory_subject_deleted", count });
    return count;
  }

  /** Every fact, current and history, for the account export; no id or subject. */
  async listForExport(subject: string): Promise<ExportedFact[]> {
    return (await this.o.repository.listAll(subject)).map(({ id: _id, subject: _subject, ...rest }) => rest);
  }
}
