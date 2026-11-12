import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DASHBOARD_PARTY, OwnerSessionStore, SESSION_COOKIE } from "./owner-session.js";

interface Row { id: string; createdAt: Date; lastSeenAt: Date; expiresAt: Date }
function fakePrisma() {
  const rows = new Map<string, Row>();
  let updates = 0;
  return {
    rows,
    get updates() { return updates; },
    ownerSession: {
      create: async ({ data }: { data: Omit<Row, "createdAt"> & { createdAt?: Date } }) => {
        const row = { createdAt: new Date(), ...data };
        rows.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      updateMany: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.get(where.id);
        if (!row) return { count: 0 };
        updates += 1;
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
const DAY = 86_400_000;

describe("owner session store", () => {
  it("exports the cookie and party names", () => {
    expect(SESSION_COOKIE).toBe("vl_session");
    expect(DASHBOARD_PARTY).toBe("vestlens-dashboard");
  });

  it("creates, resolves, slides and revokes a session", async () => {
    const prisma = fakePrisma();
    let now = new Date("2026-01-01T00:00:00Z");
    const store = new OwnerSessionStore({ prisma: prisma as never, secret: "s".repeat(43), now: () => now });

    const { token, expiresAt } = await store.create();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(expiresAt.getTime()).toBe(now.getTime() + 30 * DAY);
    // The token itself is never stored; the id is its HMAC (64 hex chars).
    const [id] = [...prisma.rows.keys()];
    expect(id).toBe(createHmac("sha256", "s".repeat(43)).update(token).digest("hex"));
    for (const v of Object.values(prisma.rows.get(id!)!)) expect(v).not.toBe(token);

    expect(await store.resolve("not-a-token")).toBe(false);
    expect(await store.resolve("")).toBe(false);

    // Within the hour: resolves without a write.
    now = new Date(now.getTime() + 10 * 60_000);
    expect(await store.resolve(token)).toBe(true);
    expect(prisma.updates).toBe(0);

    // Day 29 still resolves, and slides the expiry to day 59.
    now = new Date("2026-01-01T00:00:00Z"); now = new Date(now.getTime() + 29 * DAY);
    expect(await store.resolve(token)).toBe(true);
    expect(prisma.updates).toBe(1);
    expect(prisma.rows.get(id!)!.expiresAt.getTime()).toBe(now.getTime() + 30 * DAY);
    // Again within the hour: no second write.
    now = new Date(now.getTime() + 59 * 60_000);
    expect(await store.resolve(token)).toBe(true);
    expect(prisma.updates).toBe(1);

    // Day 61 with no use since day 29 (+59 min): expired.
    now = new Date("2026-01-01T00:00:00Z"); now = new Date(now.getTime() + 61 * DAY);
    expect(await store.resolve(token)).toBe(false);

    // Revoke.
    now = new Date("2026-01-02T00:00:00Z");
    const second = await store.create();
    expect(await store.resolve(second.token)).toBe(true);
    await store.revoke(second.token);
    expect(await store.resolve(second.token)).toBe(false);
    await store.revoke("never-existed");
  });

  it("create() sweeps expired sessions", async () => {
    const prisma = fakePrisma();
    let now = new Date("2026-01-01T00:00:00Z");
    const store = new OwnerSessionStore({ prisma: prisma as never, secret: "s".repeat(43), now: () => now });
    await store.create();
    now = new Date(now.getTime() + 40 * DAY);
    await store.create();
    expect(prisma.rows.size).toBe(1);
  });

  it("ignores a zero count when sliding a row that vanished", async () => {
    const prisma = fakePrisma();
    let now = new Date("2026-01-01T00:00:00Z");
    const store = new OwnerSessionStore({ prisma: prisma as never, secret: "s".repeat(43), now: () => now });
    const { token } = await store.create();
    prisma.ownerSession.updateMany = async () => ({ count: 0 });
    now = new Date(now.getTime() + 2 * 3600_000);
    expect(await store.resolve(token)).toBe(true);
  });

  it("does not resolve with a different secret", async () => {
    const prisma = fakePrisma();
    const a = new OwnerSessionStore({ prisma: prisma as never, secret: "a".repeat(43) });
    const b = new OwnerSessionStore({ prisma: prisma as never, secret: "b".repeat(43) });
    const { token } = await a.create();
    expect(await a.resolve(token)).toBe(true);
    expect(await b.resolve(token)).toBe(false);
  });
});
