// Prisma 6 classic-engine parameters. Errors deliberately contain no URL values.

/**
 * Each background job (the nightly run, the history catch-up, a manual refresh) pins one pooled connection for its whole
 * run (jobs/advisory-lock.ts) while the work inside it needs more. With fewer than 3 connections the job waits on its
 * own lock transaction and fails. 5 leaves room for the dashboard.
 */
const DEFAULT_CONNECTION_LIMIT = 5;
const MIN_CONNECTION_LIMIT = 3;

function parseDatabaseUrl(value: string, setting: string): URL {
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.hash) throw new Error();
    for (const key of new Set(url.searchParams.keys())) {
      if (url.searchParams.getAll(key).length !== 1) throw new Error();
    }
    return url;
  } catch {
    throw new Error(`Invalid server configuration: ${setting}`);
  }
}

export function runtimeDatabaseUrl(value: string): string {
  const url = parseDatabaseUrl(value, "DATABASE_URL");
  for (const [key, fallback, minimum, maximum] of [
    ["connection_limit", DEFAULT_CONNECTION_LIMIT, MIN_CONNECTION_LIMIT, 10], ["pool_timeout", 10, 1, 60], ["connect_timeout", 5, 1, 60],
  ] as const) {
    const existing = url.searchParams.get(key);
    if (existing !== null && (!/^[1-9]\d*$/.test(existing) || Number(existing) < minimum || Number(existing) > maximum)) {
      throw new Error("Invalid server configuration: DATABASE_URL");
    }
    if (existing === null) url.searchParams.set(key, String(fallback));
  }
  return url.toString();
}

/** The optional `MIGRATION_DATABASE_URL` for the Prisma CLI: a transaction pooler (pgbouncer) cannot run migrations. */
export function migrationDatabaseUrl(value: string): string {
  const url = parseDatabaseUrl(value, "MIGRATION_DATABASE_URL");
  if (url.searchParams.get("pgbouncer") === "true") {
    throw new Error("Invalid server configuration: MIGRATION_DATABASE_URL");
  }
  return url.toString();
}
