import { Prisma } from "@prisma/client";

import type { FactFilter, MemoryRepository, NewStoredFact, StoredFact } from "./memory-service.js";
import { MemoryConflictError } from "./memory-types.js";
import { HASHED_KEY_TYPES, OUTSIDE_KEY_PREFIX, tokenMayMatchHashedKeys } from "./search.js";

/**
 * MemoryFact rows keyed by the auth subject (no AppUser relation). One current fact per
 * (subject, nodeType, nodeKey, property, coalesce(validFrom, epoch)) is enforced by the partial unique index
 * "MemoryFact_current_topic_key" (baseline migration 0001_baseline). Writes also take a transaction-scoped
 * advisory lock on the topic, so racing writers for one topic queue rather than conflict, including writers whose
 * validFrom differs on an ordinary property; the index stays the backstop and a violation surfaces as
 * MemoryConflictError for the service to retry once. Nothing here logs.
 */

type Count = Promise<{ count: number }>;

interface TopicWhere {
  subject: string;
  nodeType: string;
  nodeKey: string;
  property: string;
  supersededAt: null;
  validFrom?: Date | null;
}

type CreateData = Omit<NewStoredFact, "value"> & { value: unknown };

export interface MemoryPrismaTransaction {
  /** Tagged-template raw statement (Prisma's $executeRaw). */
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  memoryFact: {
    updateMany(input: { where: TopicWhere; data: { supersededAt: Date } }): Count;
    create(input: { data: CreateData }): Promise<Record<string, unknown>>;
  };
}

export interface MemoryPrismaPort {
  memoryFact: {
    findMany(input: { where: Record<string, unknown>; orderBy: Array<Record<string, "asc" | "desc">>; take?: number }): Promise<Array<Record<string, unknown>>>;
    findFirst(input: { where: { subject: string; id: string } }): Promise<Record<string, unknown> | null>;
    deleteMany(input: { where: Record<string, unknown> & { subject: string } }): Count;
  };
  $transaction<T>(fn: (tx: MemoryPrismaTransaction) => Promise<T>): Promise<T>;
}

/** Node keys per query; keeps each IN list well under Postgres's bind-parameter limit. */
const NODE_CHUNK = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NEWEST_FIRST: Array<Record<string, "asc" | "desc">> = [{ recordedAt: "desc" }, { id: "desc" }];

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function toStored(row: Record<string, unknown>): StoredFact {
  return {
    id: row.id as string,
    subject: row.subject as string,
    nodeType: row.nodeType as string,
    nodeKey: row.nodeKey as string,
    property: row.property as string,
    value: (row.value ?? null) as unknown,
    text: row.text as string,
    kind: row.kind as string,
    provenance: row.provenance as string,
    validFrom: (row.validFrom ?? null) as Date | null,
    validTo: (row.validTo ?? null) as Date | null,
    recordedAt: row.recordedAt as Date,
    source: (row.source ?? null) as string | null,
    supersededAt: (row.supersededAt ?? null) as Date | null,
  };
}

/** A token in the text, the property or the node key (ILIKE); see search.ts for the hashed-key rule. */
function tokenConditions(token: string): Array<Record<string, unknown>> {
  const ci = { contains: token, mode: "insensitive" };
  return [
    { text: ci }, { property: ci },
    tokenMayMatchHashedKeys(token)
      ? { nodeKey: ci }
      : { nodeKey: ci, OR: [{ nodeType: { notIn: [...HASHED_KEY_TYPES] } }, { nodeKey: { startsWith: OUTSIDE_KEY_PREFIX } }] },
  ];
}

const newestFirst = (a: StoredFact, b: StoredFact) =>
  b.recordedAt.getTime() - a.recordedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export class PrismaMemoryRepository implements MemoryRepository {
  constructor(private readonly prisma: MemoryPrismaPort) {}

  async supersedeAndInsert(fact: NewStoredFact, scope: { sameValidFrom: boolean }): Promise<{ fact: StoredFact; superseded: number }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const lockKey = JSON.stringify([fact.subject, fact.nodeType, fact.nodeKey, fact.property]);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        const where: TopicWhere = {
          subject: fact.subject, nodeType: fact.nodeType, nodeKey: fact.nodeKey, property: fact.property, supersededAt: null,
          ...(scope.sameValidFrom ? { validFrom: fact.validFrom } : {}),
        };
        const superseded = (await tx.memoryFact.updateMany({ where, data: { supersededAt: fact.recordedAt } })).count;
        const created = await tx.memoryFact.create({ data: { ...fact, value: fact.value === null ? Prisma.DbNull : fact.value } });
        return { fact: toStored(created), superseded };
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new MemoryConflictError();
      throw error;
    }
  }

  async find(subject: string, filter: FactFilter): Promise<StoredFact[]> {
    const base: Record<string, unknown> = { subject };
    if (!filter.includeHistory) base.supersededAt = null;
    if (filter.nodeType) base.nodeType = filter.nodeType;
    if (filter.property) base.property = { startsWith: filter.property };
    if (filter.validFrom !== undefined) base.validFrom = filter.validFrom;
    if (filter.anyTokens && filter.anyTokens.length > 0) base.AND = [{ OR: filter.anyTokens.flatMap(tokenConditions) }];

    if (!filter.nodes) {
      return (await this.prisma.memoryFact.findMany({ where: base, orderBy: NEWEST_FIRST, take: filter.take })).map(toStored);
    }
    if (filter.nodes.length === 0) return [];
    const rows: StoredFact[] = [];
    for (let i = 0; i < filter.nodes.length; i += NODE_CHUNK) {
      const byType = new Map<string, string[]>();
      for (const node of filter.nodes.slice(i, i + NODE_CHUNK)) {
        const keys = byType.get(node.type) ?? [];
        keys.push(node.key);
        byType.set(node.type, keys);
      }
      const OR = [...byType].map(([nodeType, keys]) => ({ nodeType, nodeKey: { in: keys } }));
      const found = await this.prisma.memoryFact.findMany({ where: { ...base, OR }, orderBy: NEWEST_FIRST, take: filter.take });
      rows.push(...found.map(toStored));
    }
    return rows.sort(newestFirst).slice(0, filter.take);
  }

  async findById(subject: string, id: string): Promise<StoredFact | null> {
    if (!UUID.test(id)) return null;
    const row = await this.prisma.memoryFact.findFirst({ where: { subject, id } });
    return row ? toStored(row) : null;
  }

  async listAll(subject: string): Promise<StoredFact[]> {
    return (await this.prisma.memoryFact.findMany({ where: { subject }, orderBy: [{ recordedAt: "asc" }, { id: "asc" }] })).map(toStored);
  }

  async deleteById(subject: string, id: string): Promise<number> {
    if (!UUID.test(id)) return 0;
    return (await this.prisma.memoryFact.deleteMany({ where: { subject, id } })).count;
  }

  async deleteTopic(subject: string, nodeType: string, nodeKey: string, property: string): Promise<number> {
    return (await this.prisma.memoryFact.deleteMany({ where: { subject, nodeType, nodeKey, property } })).count;
  }

  async deleteBySubject(subject: string): Promise<number> {
    return (await this.prisma.memoryFact.deleteMany({ where: { subject } })).count;
  }
}
