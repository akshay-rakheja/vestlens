import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SettingsService, type SettingsPrismaPort } from "./settings-service.js";

type Row = { benchmark: string; cadView: boolean; privacyDefault: boolean };

function memoryPrisma(): SettingsPrismaPort & { rows: Map<string, Row> } {
  const users = new Map([["subject|synthetic-a", "user-a"], ["subject|synthetic-b", "user-b"]]);
  const rows = new Map<string, Row>();
  return {
    rows,
    appUser: { findIdByAuthSubject: async (s) => (users.has(s) ? { id: users.get(s)! } : null) },
    portfolioSettings: {
      findUnique: async ({ where }) => rows.get(where.appUserId) ?? null,
      upsert: async ({ where, create, update }) => {
        // Prisma-like invariant: the create payload must target the same row as the where clause.
        if (create.appUserId !== where.appUserId) {
          throw new Error("upsert create.appUserId must match where.appUserId");
        }
        const existing = rows.get(where.appUserId);
        let next: Row;
        if (existing) {
          next = { ...existing, ...update };
        } else {
          const { appUserId: _ownerId, ...fields } = create;
          next = { ...DEFAULT_SETTINGS, ...fields };
        }
        rows.set(where.appUserId, next);
        return next;
      },
    },
  };
}

describe("SettingsService", () => {
  it("shows money in the home currency (cadView on) by default", () => {
    expect(DEFAULT_SETTINGS.cadView).toBe(true);
  });
  it("returns defaults when nothing is stored, including unknown users", async () => {
    const service = new SettingsService(memoryPrisma());
    await expect(service.get("subject|synthetic-a")).resolves.toEqual(DEFAULT_SETTINGS);
    await expect(service.get("subject|nobody")).resolves.toEqual(DEFAULT_SETTINGS);
  });
  it("saves only the caller's row", async () => {
    const prisma = memoryPrisma();
    const service = new SettingsService(prisma);
    await service.save("subject|synthetic-a", { benchmark: "tsx" });
    await expect(service.get("subject|synthetic-a")).resolves.toMatchObject({ benchmark: "tsx" });
    await expect(service.get("subject|synthetic-b")).resolves.toEqual(DEFAULT_SETTINGS);
    expect([...prisma.rows.keys()]).toEqual(["user-a"]);
  });
  it("keeps earlier fields when a later save changes another field", async () => {
    const service = new SettingsService(memoryPrisma());
    await service.save("subject|synthetic-a", { cadView: false });
    await service.save("subject|synthetic-a", { benchmark: "tsx" });
    await expect(service.get("subject|synthetic-a")).resolves.toEqual({
      benchmark: "tsx",
      cadView: false,
      privacyDefault: false,
    });
  });
  it("does not let one user's save change another user's settings", async () => {
    const prisma = memoryPrisma();
    const service = new SettingsService(prisma);
    await service.save("subject|synthetic-b", { benchmark: "dow" });
    await expect(service.get("subject|synthetic-a")).resolves.toEqual(DEFAULT_SETTINGS);
    expect([...prisma.rows.keys()]).toEqual(["user-b"]);
  });
  it("rejects unknown keys, invalid benchmarks and unknown users", async () => {
    const service = new SettingsService(memoryPrisma());
    await expect(service.save("subject|synthetic-a", { benchmark: "ftse" })).rejects.toThrow();
    await expect(service.save("subject|synthetic-a", { appUserId: "user-b" })).rejects.toThrow();
    await expect(service.save("subject|nobody", { benchmark: "tsx" })).rejects.toThrow(/not found/i);
  });
  it("rejects a __proto__ payload instead of applying it", async () => {
    const prisma = memoryPrisma();
    const service = new SettingsService(prisma);
    const payload = JSON.parse('{"__proto__": {"benchmark": "tsx"}}');
    await expect(service.save("subject|synthetic-a", payload)).rejects.toThrow();
    await expect(service.get("subject|synthetic-a")).resolves.toEqual(DEFAULT_SETTINGS);
    expect(prisma.rows.size).toBe(0);
  });
  it("falls back to the default benchmark if a stored value is no longer allowed", async () => {
    const prisma = memoryPrisma();
    prisma.rows.set("user-a", { benchmark: "retired", cadView: true, privacyDefault: false });
    await expect(new SettingsService(prisma).get("subject|synthetic-a")).resolves.toEqual({ benchmark: "sp500", cadView: true, privacyDefault: false });
  });
});
