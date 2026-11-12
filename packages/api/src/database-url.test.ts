import { describe, expect, it } from "vitest";
import { migrationDatabaseUrl, runtimeDatabaseUrl } from "./database-url.js";

// Invented configuration only. These helpers never resolve DNS or connect.
function rejectsRedacted(action: () => unknown, setting: string) {
  expect(action).toThrow(`Invalid server configuration: ${setting}`);
  expect(action).not.toThrow(/INVENTED|invented|postgresql:\/\//);
}

describe("connection_limit", () => {
  const base = "postgresql://synthetic-invented:INVENTED@localhost/postgres";

  it("defaults to 5 when the URL omits it (the old default of 1 left every background job waiting on its own lock)", () => {
    const url = new URL(runtimeDatabaseUrl(base));
    expect(url.searchParams.get("connection_limit")).toBe("5");
    expect(url.searchParams.get("pool_timeout")).toBe("10");
    expect(url.searchParams.get("connect_timeout")).toBe("5");
    expect(new URL(runtimeDatabaseUrl(`${base}?schema=public`)).searchParams.get("connection_limit")).toBe("5");
  });

  it("keeps an explicit value from 3 to 10", () => {
    for (const value of ["3", "5", "10"]) {
      expect(new URL(runtimeDatabaseUrl(`${base}?connection_limit=${value}`)).searchParams.get("connection_limit")).toBe(value);
    }
  });

  it("refuses to start below 3 or above 10, naming DATABASE_URL and no value", () => {
    for (const value of ["1", "2", "0", "11", "oops", "-1", "1.5"]) {
      rejectsRedacted(() => runtimeDatabaseUrl(`${base}?connection_limit=${value}`), "DATABASE_URL");
    }
  });
});

describe("database URL compatibility and redaction", () => {
  it.each(["postgres", "postgresql"])("preserves encoded credentials and local socket settings for %s", scheme => {
    const input = `${scheme}://invented%2Buser:INVENTED%40VALUE%3AONLY@localhost:6543/postgres?host=%2Ftmp%2Finvented&schema=public&connection_limit=4&pool_timeout=3&connect_timeout=4`;
    const runtime = new URL(runtimeDatabaseUrl(input));
    expect(runtime.username).toBe("invented%2Buser");
    expect(runtime.password).toBe("INVENTED%40VALUE%3AONLY");
    expect(runtime.searchParams.get("host")).toBe("/tmp/invented");
    expect(runtime.searchParams.get("schema")).toBe("public");
    expect(runtime.searchParams.get("connection_limit")).toBe("4");
    expect(runtime.searchParams.get("pool_timeout")).toBe("3");
    expect(runtime.searchParams.get("connect_timeout")).toBe("4");
    expect(migrationDatabaseUrl(input)).toBe(input);
  });

  it.each([
    "connection_limit=5&connection%5Flimit=6", "pool_timeout=2&pool_timeout=3",
    "sslmode=require&%73slmode=disable", "host=localhost&h%6fst=%2Ftmp%2Finvented",
    "pgbouncer=true&pgbouncer=false",
  ])("rejects duplicate decoded query keys: %s", query => {
    const url = `postgresql://synthetic-invented:INVENTED@localhost/postgres?${query}`;
    rejectsRedacted(() => runtimeDatabaseUrl(url), "DATABASE_URL");
    rejectsRedacted(() => migrationDatabaseUrl(url), "MIGRATION_DATABASE_URL");
  });

  it.each([
    { key: "pool_timeout", maximum: 60 }, { key: "connect_timeout", maximum: 60 },
  ])("keeps $key positive and finite, including explicit upper bound", ({ key, maximum }) => {
    const base = "postgresql://synthetic-invented:INVENTED@localhost/postgres?";
    expect(new URL(runtimeDatabaseUrl(`${base}${key}=${maximum}`)).searchParams.get(key)).toBe(String(maximum));
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "oops", String(maximum + 1), "9".repeat(100)]) {
      rejectsRedacted(() => runtimeDatabaseUrl(`${base}${key}=${value}`), "DATABASE_URL");
    }
  });

  it("returns only setting names when either URL is malformed", () => {
    for (const input of ["not-a-url-INVENTED", "https://INVENTED.example/db", "postgresql://invented/db#INVENTED"]) {
      rejectsRedacted(() => runtimeDatabaseUrl(input), "DATABASE_URL");
      rejectsRedacted(() => migrationDatabaseUrl(input), "MIGRATION_DATABASE_URL");
    }
  });

  it("refuses a pgbouncer transaction pooler for migrations only", () => {
    const url = "postgresql://synthetic-invented:INVENTED@localhost:6543/postgres?pgbouncer=true";
    rejectsRedacted(() => migrationDatabaseUrl(url), "MIGRATION_DATABASE_URL");
    expect(new URL(runtimeDatabaseUrl(url)).searchParams.get("pgbouncer")).toBe("true");
  });
});
