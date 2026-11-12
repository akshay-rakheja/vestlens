/**
 * Applies the baseline migration to an empty PostgreSQL database and checks that the result matches schema.prisma
 * and carries the hand-written objects Prisma cannot express. Runs only when BASELINE_TEST_DATABASE_URL points at a
 * throwaway, empty database (CI starts a postgres:16 service for it); otherwise it is skipped so `npm test` needs no
 * database. Run it with: BASELINE_TEST_DATABASE_URL=postgresql://... npx vitest run scripts/baseline-migration.test.ts
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

const url = process.env.BASELINE_TEST_DATABASE_URL;
const apiRoot = fileURLToPath(new URL("..", import.meta.url));
const prismaBin = fileURLToPath(new URL("../node_modules/.bin/prisma", import.meta.url));

function env(): NodeJS.ProcessEnv {
  const { MIGRATION_DATABASE_URL: _unused, ...rest } = process.env;
  return { ...rest, DATABASE_URL: url };
}

function prisma(args: string[]): string {
  return execFileSync(prismaBin, [...args], {
    cwd: apiRoot,
    env: env(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe.skipIf(!url)("baseline migration (needs BASELINE_TEST_DATABASE_URL)", () => {
  const db = new PrismaClient({ datasourceUrl: url });
  afterAll(async () => { await db.$disconnect(); });

  it("baseline applies on an empty database and matches the schema", async () => {
    prisma(["migrate", "deploy", "--schema", "prisma/schema.prisma"]);

    // Exits non-zero (and execFileSync throws) when the database differs from the schema.
    prisma(["migrate", "diff", "--from-url", url!, "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"]);

    const checks = await db.$queryRaw<{ conname: string }[]>`
      SELECT c.conname FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'c' AND n.nspname = 'public' ORDER BY c.conname`;
    expect(checks.map((r) => r.conname)).toEqual([
      "MemoryFact_kind_check",
      "MemoryFact_nodeKey_check",
      "MemoryFact_nodeType_check",
      "MemoryFact_provenance_check",
      "PortfolioNudge_kind_check",
    ]);

    const indexes = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_catalog.pg_indexes WHERE schemaname = 'public'`;
    const byName = new Map(indexes.map((r) => [r.indexname, r.indexdef]));
    expect(byName.get("MemoryFact_current_topic_key")).toMatch(/UNIQUE.*COALESCE\("validFrom".*WHERE \("supersededAt" IS NULL\)/);
    expect(byName.get("PortfolioNudge_subject_kind_target_condition_key")).toMatch(/UNIQUE.*COALESCE\("conditionId"/);
    expect(byName.get("NewsArticle_symbols_idx")).toMatch(/USING gin/);

    // Nothing from the hosted era: no trigger, no custom function.
    const triggers = await db.$queryRaw<{ tgname: string }[]>`
      SELECT tg.tgname FROM pg_catalog.pg_trigger tg
      JOIN pg_catalog.pg_class t ON t.oid = tg.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      WHERE NOT tg.tgisinternal AND n.nspname = 'public'`;
    expect(triggers).toEqual([]);

    // The constraints bite.
    await expect(db.$executeRawUnsafe(
      `INSERT INTO "PortfolioNudge" ("id","subject","kind","target","text","raisedAt","updatedAt")
       VALUES (gen_random_uuid(),'s','bogus','t','x',now(),now())`)).rejects.toThrow();
  }, 120_000);
});
