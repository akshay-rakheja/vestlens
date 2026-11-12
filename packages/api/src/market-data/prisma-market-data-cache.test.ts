import { describe, expect, it } from "vitest";
import { PrismaMarketDataCache } from "./prisma-market-data-cache.js";

type Row = { key: string; payload: unknown; fetchedAt: Date; expiresAt: Date };

function fakePrisma() {
  const rows = new Map<string, Row>();
  const port = {
    marketDataCache: {
      async findUnique({ where }: { where: { key: string } }) {
        return rows.get(where.key) ?? null;
      },
      async upsert({ where, create, update }: { where: { key: string }; create: Row; update: Partial<Row> }) {
        const existing = rows.get(where.key);
        const next = existing ? { ...existing, ...update } : create;
        rows.set(where.key, next as Row);
        return next;
      },
      async deleteMany({ where }: { where: { expiresAt: { lt: Date } } }) {
        let count = 0;
        for (const [k, r] of rows) if (r.expiresAt < where.expiresAt.lt) { rows.delete(k); count++; }
        return { count };
      },
    },
  };
  return { port, rows };
}

describe("PrismaMarketDataCache", () => {
  it("returns null for a missing or expired row and the payload while fresh", async () => {
    const { port } = fakePrisma();
    const cache = new PrismaMarketDataCache(port);
    const now = new Date("2026-10-15T15:00:00Z");
    expect(await cache.get("quote:VFV.TO", now)).toBeNull();

    await cache.set("quote:VFV.TO", { price: 1 }, now, new Date("2026-10-15T15:05:00Z"));
    expect(await cache.get("quote:VFV.TO", new Date("2026-10-15T15:04:59Z"))).toEqual({ price: 1 });
    expect(await cache.get("quote:VFV.TO", new Date("2026-10-15T15:05:00Z"))).toBeNull();
  });

  it("upserts payload, fetchedAt and expiresAt by key", async () => {
    const { port, rows } = fakePrisma();
    const cache = new PrismaMarketDataCache(port);
    const first = new Date("2026-10-15T15:00:00Z");
    const second = new Date("2026-10-15T16:00:00Z");
    await cache.set("fx:USDCAD:a:b", [{ date: "2026-10-14", close: 1.37 }], first, new Date("2026-10-16T15:00:00Z"));
    await cache.set("fx:USDCAD:a:b", [{ date: "2026-10-15", close: 1.38 }], second, new Date("2026-10-17T16:00:00Z"));

    expect(rows.size).toBe(1);
    expect(rows.get("fx:USDCAD:a:b")).toEqual({
      key: "fx:USDCAD:a:b",
      payload: [{ date: "2026-10-15", close: 1.38 }],
      fetchedAt: second,
      expiresAt: new Date("2026-10-17T16:00:00Z"),
    });
  });

  it("F4: purgeExpired deletes only rows with expiresAt before now", async () => {
    const { port, rows } = fakePrisma();
    const cache = new PrismaMarketDataCache(port);
    const now = new Date("2026-10-15T15:00:00Z");
    await cache.set("history:A:x:y", [], now, new Date("2026-10-15T14:59:59Z"));
    await cache.set("history:B:x:y", [], now, new Date("2026-10-15T15:00:00Z"));
    await cache.set("history:C:x:y", [], now, new Date("2026-10-16T15:00:00Z"));
    await expect(cache.purgeExpired(now)).resolves.toBe(1);
    expect([...rows.keys()].sort()).toEqual(["history:B:x:y", "history:C:x:y"]);
  });
});
