import { randomUUID } from "node:crypto";

import {
  MemoryConflictError,
  type FactFilter,
  type MemoryRepository,
  type NewStoredFact,
  type StoredFact,
} from "../memory/memory-service.js";
import { matchCount } from "../memory/search.js";

const sameDay = (a: Date | null, b: Date | null) => (a === null || b === null ? a === b : a.getTime() === b.getTime());

/**
 * In-memory MemoryRepository that models the table's partial unique index: at most one current fact
 * per (subject, nodeType, nodeKey, property, coalesce(validFrom, epoch)). A write supersedes, then inserts;
 * an insert that would break the index throws MemoryConflictError and leaves nothing changed, as a rolled-back
 * transaction would. `beforeInsert` lets a test interleave two writes between the two steps. Tests only.
 */
export class MemoryFactRepository implements MemoryRepository {
  readonly rows: StoredFact[] = [];
  beforeInsert?: () => Promise<void>;

  async supersedeAndInsert(fact: NewStoredFact, scope: { sameValidFrom: boolean }): Promise<{ fact: StoredFact; superseded: number }> {
    const topic = (r: StoredFact) => r.subject === fact.subject && r.nodeType === fact.nodeType && r.nodeKey === fact.nodeKey
      && r.property === fact.property;
    const toSupersede = this.rows.filter((r) => topic(r) && r.supersededAt === null && (!scope.sameValidFrom || sameDay(r.validFrom, fact.validFrom)));
    await this.beforeInsert?.();
    const clash = this.rows.some((r) => topic(r) && r.supersededAt === null && !toSupersede.includes(r) && sameDay(r.validFrom, fact.validFrom));
    if (clash) throw new MemoryConflictError();
    for (const r of toSupersede) r.supersededAt = fact.recordedAt;
    const stored: StoredFact = { ...fact, id: randomUUID(), supersededAt: null };
    this.rows.push(stored);
    return { fact: { ...stored }, superseded: toSupersede.length };
  }

  async find(subject: string, filter: FactFilter): Promise<StoredFact[]> {
    return this.rows
      .filter((r) => r.subject === subject)
      .filter((r) => filter.includeHistory || r.supersededAt === null)
      .filter((r) => !filter.nodes || filter.nodes.some((n) => n.type === r.nodeType && n.key === r.nodeKey))
      .filter((r) => !filter.nodeType || r.nodeType === filter.nodeType)
      .filter((r) => !filter.property || r.property.startsWith(filter.property))
      .filter((r) => filter.validFrom === undefined || sameDay(r.validFrom, filter.validFrom))
      .filter((r) => !filter.anyTokens?.length || matchCount(r, filter.anyTokens) > 0)
      .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime() || (a.id < b.id ? 1 : -1))
      .slice(0, filter.take)
      .map((r) => ({ ...r }));
  }

  async findById(subject: string, id: string): Promise<StoredFact | null> {
    const row = this.rows.find((r) => r.subject === subject && r.id === id);
    return row ? { ...row } : null;
  }

  async listAll(subject: string): Promise<StoredFact[]> {
    return this.rows.filter((r) => r.subject === subject)
      .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())
      .map((r) => ({ ...r }));
  }

  private remove(match: (r: StoredFact) => boolean): number {
    let removed = 0;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (match(this.rows[i]!)) {
        this.rows.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  async deleteById(subject: string, id: string): Promise<number> {
    return this.remove((r) => r.subject === subject && r.id === id);
  }

  async deleteTopic(subject: string, nodeType: string, nodeKey: string, property: string): Promise<number> {
    return this.remove((r) => r.subject === subject && r.nodeType === nodeType && r.nodeKey === nodeKey && r.property === property);
  }

  async deleteBySubject(subject: string): Promise<number> {
    return this.remove((r) => r.subject === subject);
  }
}
