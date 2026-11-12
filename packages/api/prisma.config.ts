import "dotenv/config";
import { defineConfig } from "prisma/config";
import { migrationDatabaseUrl } from "./src/database-url.js";

// Optional: existing GCP/local CLI callers continue to use schema DATABASE_URL.
// Runtime always uses AppConfig.databaseUrl, never this migration endpoint.
const migrationUrl = process.env.MIGRATION_DATABASE_URL;
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  ...(migrationUrl !== undefined ? {
    engine: "classic" as const,
    datasource: { url: migrationDatabaseUrl(migrationUrl) },
  } : {}),
});
