import { OwnerSessionStore } from "../auth/owner-session.js";

interface Row { id: string; lastSeenAt: Date; expiresAt: Date }

/** In-memory stand-in for the ownerSession table, for tests that need a real OwnerSessionStore without a database. */
export function fakeOwnerSessionPrisma() {
  const rows = new Map<string, Row>();
  return {
    rows,
    ownerSession: {
      create: async ({ data }: { data: Row }) => { rows.set(data.id, { ...data }); return data; },
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      updateMany: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.get(where.id);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      deleteMany: async ({ where }: { where: { id?: string; expiresAt?: { lte: Date } } }) => {
        if (where.id) rows.delete(where.id);
        if (where.expiresAt) for (const [k, r] of rows) if (r.expiresAt <= where.expiresAt.lte) rows.delete(k);
        return { count: 0 };
      },
    },
  };
}

export function memoryOwnerSessions(secret = "t".repeat(43)): OwnerSessionStore {
  return new OwnerSessionStore({ prisma: fakeOwnerSessionPrisma() as never, secret });
}
