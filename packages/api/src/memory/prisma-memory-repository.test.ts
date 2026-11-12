import { readFileSync } from "node:fs";

import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MemoryConflictError, type NewStoredFact } from "./memory-service.js";
import { PrismaMemoryRepository, type MemoryPrismaTransaction } from "./prisma-memory-repository.js";

// Synthetic values only.
const subject = "subject|synthetic-memory-repo";
const at = new Date("2026-10-23T12:00:00.000Z");
const jan1 = new Date("2026-01-01T00:00:00.000Z");
const FACT_ID = "00000000-0000-4000-8000-0000000000f1";

const fact = (over: Partial<NewStoredFact> = {}): NewStoredFact => ({
  subject, nodeType: "tax_year", nodeKey: "2026:tfsa", property: "tax_year.cra_room_jan1", value: { amountCad: 1 },
  text: "Room.", kind: "fact", provenance: "stated", validFrom: jan1, validTo: null, recordedAt: at, source: "claude", ...over,
});

function client() {
  const calls: string[] = [];
  const tx = {
    $executeRaw: vi.fn(async (..._args: unknown[]) => { calls.push("lock"); return 1; }),
    memoryFact: {
      updateMany: vi.fn(async (_input: unknown) => { calls.push("supersede"); return { count: 1 }; }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { calls.push("create"); return { id: "f-1", supersededAt: null, ...data }; }),
    },
  } satisfies MemoryPrismaTransaction;
  const prisma = {
    memoryFact: {
      findMany: vi.fn(async (_input: unknown) => [] as Array<Record<string, unknown>>),
      findFirst: vi.fn(async (_input: unknown) => null as Record<string, unknown> | null),
      deleteMany: vi.fn(async (_input: unknown) => ({ count: 3 })),
    },
    async $transaction<T>(fn: (t: MemoryPrismaTransaction) => Promise<T>): Promise<T> { calls.push("begin"); const r = await fn(tx); calls.push("commit"); return r; },
  };
  return { prisma, tx, calls };
}

describe("PrismaMemoryRepository", () => {
  it("locks the topic, supersedes the current fact for the same validFrom and inserts, in one transaction", async () => {
    const { prisma, tx, calls } = client();
    const result = await new PrismaMemoryRepository(prisma).supersedeAndInsert(fact(), { sameValidFrom: true });
    expect(calls).toEqual(["begin", "lock", "supersede", "create", "commit"]);
    expect(result.superseded).toBe(1);
    expect(result.fact).toMatchObject({ id: "f-1", subject, property: "tax_year.cra_room_jan1", supersededAt: null });
    const [strings, ...values] = tx.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toContain("pg_advisory_xact_lock(hashtextextended(?, 0))");
    // The lock key is the topic; no fact text or value reaches it.
    expect(values).toHaveLength(1);
    expect(String(values[0])).not.toContain("Room.");
    expect(tx.memoryFact.updateMany).toHaveBeenCalledWith({
      where: { subject, nodeType: "tax_year", nodeKey: "2026:tfsa", property: "tax_year.cra_room_jan1", supersededAt: null, validFrom: jan1 },
      data: { supersededAt: at },
    });
    expect(tx.memoryFact.create.mock.calls[0]![0].data).toMatchObject({ value: { amountCad: 1 }, validFrom: jan1 });
  });

  it("supersedes across validFrom for ordinary properties and writes a JSON null value", async () => {
    const { prisma, tx } = client();
    await new PrismaMemoryRepository(prisma).supersedeAndInsert(fact({ property: "security.note", nodeType: "security", nodeKey: "SYN", value: null, validFrom: null }), { sameValidFrom: false });
    expect(tx.memoryFact.updateMany.mock.calls[0]![0]).toEqual({
      where: { subject, nodeType: "security", nodeKey: "SYN", property: "security.note", supersededAt: null },
      data: { supersededAt: at },
    });
    expect(tx.memoryFact.create.mock.calls[0]![0].data.value).toBe(Prisma.DbNull);
  });

  it("maps a unique violation on the current-fact index to MemoryConflictError", async () => {
    const { prisma, tx } = client();
    tx.memoryFact.create.mockRejectedValueOnce({ code: "P2002" });
    await expect(new PrismaMemoryRepository(prisma).supersedeAndInsert(fact(), { sameValidFrom: true })).rejects.toBeInstanceOf(MemoryConflictError);
    tx.memoryFact.create.mockRejectedValueOnce(new Error("synthetic other failure"));
    await expect(new PrismaMemoryRepository(prisma).supersedeAndInsert(fact(), { sameValidFrom: true })).rejects.toThrow("synthetic other failure");
  });

  it("finds by subject with node, property-prefix, token and history filters, newest first", async () => {
    const { prisma } = client();
    const repo = new PrismaMemoryRepository(prisma);
    await repo.find(subject, { nodes: [{ type: "security", key: "SYN" }, { type: "account", key: "a1" }, { type: "account", key: "a2" }], property: "security.", anyTokens: ["div", "cafe"], take: 21 });
    const ci = (v: string) => ({ contains: v, mode: "insensitive" });
    expect(prisma.memoryFact.findMany).toHaveBeenCalledWith({
      where: {
        subject, supersededAt: null,
        OR: [{ nodeType: "security", nodeKey: { in: ["SYN"] } }, { nodeType: "account", nodeKey: { in: ["a1", "a2"] } }],
        property: { startsWith: "security." },
        // Any token in text, node key or property (ILIKE); a hex-only token never matches a hashed account or activity key.
        AND: [{ OR: [
          { text: ci("div") }, { property: ci("div") }, { nodeKey: ci("div") },
          { text: ci("cafe") }, { property: ci("cafe") },
          { nodeKey: ci("cafe"), OR: [{ nodeType: { notIn: ["account", "activity"] } }, { nodeKey: { startsWith: "outside:" } }] },
        ] }],
      },
      orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
      take: 21,
    });
    await repo.find(subject, { includeHistory: true, nodeType: "activity", validFrom: null, take: 1 });
    expect(prisma.memoryFact.findMany).toHaveBeenLastCalledWith({
      where: { subject, nodeType: "activity", validFrom: null }, orderBy: [{ recordedAt: "desc" }, { id: "desc" }], take: 1,
    });
  });

  it("chunks a long node list and skips the read for an empty one", async () => {
    const { prisma } = client();
    const repo = new PrismaMemoryRepository(prisma);
    await expect(repo.find(subject, { nodes: [], take: 5 })).resolves.toEqual([]);
    expect(prisma.memoryFact.findMany).not.toHaveBeenCalled();
    const many = Array.from({ length: 2_500 }, (_, i) => ({ type: "activity" as const, key: `k${i}` }));
    prisma.memoryFact.findMany.mockImplementation(async (input: unknown) => {
      const ors = (input as { where: { OR: Array<{ nodeKey: { in: string[] } }> } }).where.OR;
      return ors.flatMap((o) => o.nodeKey.in.slice(0, 1)).map((k, i) => ({ id: k, recordedAt: new Date(at.getTime() + i), nodeKey: k }));
    });
    const rows = await repo.find(subject, { nodes: many, take: 3 });
    expect(prisma.memoryFact.findMany).toHaveBeenCalledTimes(3);
    expect(rows).toHaveLength(3);
  });

  it("reads one fact, lists all for export and deletes, always by subject", async () => {
    const { prisma } = client();
    const repo = new PrismaMemoryRepository(prisma);
    await repo.findById(subject, FACT_ID);
    expect(prisma.memoryFact.findFirst).toHaveBeenCalledWith({ where: { subject, id: FACT_ID } });
    await repo.listAll(subject);
    expect(prisma.memoryFact.findMany).toHaveBeenLastCalledWith({ where: { subject }, orderBy: [{ recordedAt: "asc" }, { id: "asc" }] });
    expect(await repo.deleteById(subject, FACT_ID)).toBe(3);
    expect(prisma.memoryFact.deleteMany).toHaveBeenLastCalledWith({ where: { subject, id: FACT_ID } });
    await repo.deleteTopic(subject, "security", "SYN", "security.note");
    expect(prisma.memoryFact.deleteMany).toHaveBeenLastCalledWith({ where: { subject, nodeType: "security", nodeKey: "SYN", property: "security.note" } });
    await repo.deleteBySubject(subject);
    expect(prisma.memoryFact.deleteMany).toHaveBeenLastCalledWith({ where: { subject } });
  });

  it("does not query with a malformed id", async () => {
    const { prisma } = client();
    await expect(new PrismaMemoryRepository(prisma).findById(subject, "not-a-uuid")).resolves.toBeNull();
    // Uuid ids only reach the database.
    expect(prisma.memoryFact.findFirst).not.toHaveBeenCalled();
    expect(await new PrismaMemoryRepository(prisma).deleteById(subject, "not-a-uuid")).toBe(0);
  });
});

describe("MemoryFact schema and migration", () => {
  const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
  const sql = readFileSync(new URL("../../prisma/migrations/0001_baseline/migration.sql", import.meta.url), "utf8");

  it("declares the fact columns keyed by subject, with no AppUser relation", () => {
    const model = /model MemoryFact \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
    const fields = [...model.matchAll(/^\s+(\w+)\s+\S/gm)].map((m) => m[1]);
    expect(fields).toEqual(["id", "subject", "nodeType", "nodeKey", "property", "value", "text", "kind", "provenance",
      "validFrom", "validTo", "recordedAt", "source", "supersededAt"]);
    expect(model).toContain("@@index([subject, nodeType, nodeKey, property, recordedAt])");
    expect(model).toMatch(/text\s+String\s+@db\.VarChar\(2000\)/);
    expect(model).toMatch(/nodeKey\s+String\s+@db\.VarChar\(120\)/);
    expect(model).not.toMatch(/AppUser|appUser/);
    const dmmf = Prisma.dmmf.datamodel.models.find((m) => m.name === "MemoryFact");
    expect(dmmf?.fields.map((f) => f.name)).toEqual(fields);
  });

  it("the baseline creates the table and enforces one current fact per topic", () => {
    expect(sql).toContain('CREATE TABLE "MemoryFact"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "MemoryFact_current_topic_key" ON "MemoryFact"("subject", "nodeType", "nodeKey", "property", COALESCE("validFrom", DATE \'epoch\')) WHERE "supersededAt" IS NULL;');
    expect(sql).toContain('CREATE INDEX "MemoryFact_subject_nodeType_nodeKey_property_recordedAt_idx" ON "MemoryFact"("subject", "nodeType", "nodeKey", "property", "recordedAt");');
    expect(sql).toContain("CHECK (\"provenance\" IN ('stated', 'inferred', 'imported', 'derived'))");
    expect(sql).toContain("CHECK (\"nodeKey\" ~ '^[A-Za-z0-9_.:-]+$')");
  });
});
