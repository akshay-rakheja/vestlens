import type { NudgePrismaPort, NudgeRow } from "../nudges/nudge-service.js";

/**
 * In-memory PortfolioNudge table that models the (subject, kind, target, coalesce(conditionId, '')) unique index: a
 * create that clashes throws a Prisma-style P2002 error and changes nothing. `beforeCreate` lets a test interleave a
 * concurrent write. Tests only.
 */
export class MemoryNudgePrisma implements NudgePrismaPort {
  readonly rows: NudgeRow[] = [];
  beforeCreate?: () => Promise<void>;
  private next = 1;

  readonly portfolioNudge: NudgePrismaPort["portfolioNudge"] = {
    findMany: async ({ where, orderBy }) => {
      const rows = this.rows
        .filter((r) => r.subject === where.subject && (where.clearedAt === undefined || r.clearedAt === where.clearedAt))
        .map((r) => ({ ...r }));
      return orderBy ? rows.sort((a, b) => a.raisedAt.getTime() - b.raisedAt.getTime() || a.id.localeCompare(b.id)) : rows;
    },
    create: async ({ data }) => {
      await this.beforeCreate?.();
      const clash = this.rows.find((r) => r.subject === data.subject && r.kind === data.kind && r.target === data.target && (r.conditionId ?? "") === (data.conditionId ?? ""));
      if (clash) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      const row = { id: `nudge-${String(this.next++).padStart(4, "0")}`, ...data };
      this.rows.push(row);
      return { ...row };
    },
    update: async ({ where, data }) => {
      const row = this.rows.find((r) => r.id === where.id);
      if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
      Object.assign(row, data);
      return { ...row };
    },
  };
}
