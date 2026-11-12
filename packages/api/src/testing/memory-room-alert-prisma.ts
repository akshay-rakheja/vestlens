import type { RoomAlertPrismaPort, RoomAlertRow } from "../room/room-alerts.js";

/**
 * In-memory ContributionRoomAlert table that models the (subject, year) unique index: a create that clashes throws
 * a Prisma-style P2002 error and changes nothing. `beforeCreate` lets a test interleave a concurrent write. Tests only.
 */
export class MemoryRoomAlertPrisma implements RoomAlertPrismaPort {
  readonly rows: RoomAlertRow[] = [];
  beforeCreate?: () => Promise<void>;

  readonly contributionRoomAlert: RoomAlertPrismaPort["contributionRoomAlert"] = {
    findUnique: async ({ where }) => {
      const row = this.find(where.subject_year.subject, where.subject_year.year);
      return row ? { ...row } : null;
    },
    create: async ({ data }) => {
      await this.beforeCreate?.();
      if (this.find(data.subject, data.year)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      this.rows.push({ ...data });
      return {};
    },
    update: async ({ where, data }) => {
      const row = this.find(where.subject_year.subject, where.subject_year.year);
      if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
      Object.assign(row, data);
      return {};
    },
    findMany: async ({ where }) =>
      this.rows.filter((r) => r.subject === where.subject).sort((a, b) => a.year - b.year).map((r) => ({ ...r })),
  };

  private find(subject: string, year: number): RoomAlertRow | undefined {
    return this.rows.find((r) => r.subject === subject && r.year === year);
  }
}
