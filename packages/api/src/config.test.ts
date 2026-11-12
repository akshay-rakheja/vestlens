import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, type JWK } from "jose";

import { hashOwnerPassword } from "./auth/owner-password.js";
import { listenHost, loadConfig } from "./config.js";

const signingPair = await generateKeyPair("ES256", { extractable: true });
const privateJwk: JWK = { ...(await exportJWK(signingPair.privateKey)), kid: "k1" };
const publicJwk: JWK = { ...(await exportJWK(signingPair.publicKey)), kid: "k0" };
const rsaJwk: JWK = { ...(await exportJWK((await generateKeyPair("RS256", { extractable: true })).privateKey)), kid: "r1" };
const OWNER_HASH = await hashOwnerPassword("synthetic-owner-password");
const SESSION_SECRET = "s".repeat(43);

const stagingDatabaseUrl = "postgresql://synthetic:password@localhost:5432/synthetic_staging";

function validEnv(): NodeJS.ProcessEnv {
  return {
    SNAPTRADE_CLIENT_ID: "commercial-client",
    SNAPTRADE_CONSUMER_KEY: "consumer-secret",
    DATABASE_URL: "postgresql://synthetic:password@localhost:5432/vestlens",
    APP_BASE_URL: "https://portfolio.example.com/",
    MCP_GATEWAY_SIGNING_KEY: JSON.stringify(privateJwk),
    SESSION_SECRET,
    OWNER_PASSWORD_HASH: OWNER_HASH,
  };
}

describe("loadConfig", () => {
  it("loads a minimal self-hosted env", () => {
    const config = loadConfig(validEnv());
    expect(config.appBaseUrl).toBe("https://portfolio.example.com");
    expect(config.mcpResourceUrl).toBe("https://portfolio.example.com/mcp");
    expect(config.snapTrade).toEqual({ clientId: "commercial-client", consumerKey: "consumer-secret" });
    expect(config.news).toBeUndefined();
    expect(config.webhooksEnabled).toBe(false);
    expect(Object.keys(config).sort()).toEqual(["appBaseUrl", "databaseUrl", "gateway", "mcpResourceUrl", "owner", "snapTrade", "webDistDirectory", "webhooksEnabled", "widgetsDistDirectory"]);
  });
  it("accepts the documented Compose DATABASE_URL", () => {
    const url = "postgresql://vestlens:vestlens@db:5432/vestlens";
    expect(new URL(loadConfig({ ...validEnv(), DATABASE_URL: url }).databaseUrl).pathname).toBe("/vestlens");
  });
  it.each(["SNAPTRADE_CLIENT_ID", "SNAPTRADE_CONSUMER_KEY", "DATABASE_URL", "APP_BASE_URL", "OWNER_PASSWORD_HASH", "SESSION_SECRET", "MCP_GATEWAY_SIGNING_KEY"])(
    "requires %s, naming it",
    (name) => {
      const env = validEnv();
      delete env[name];
      expect(() => loadConfig(env)).toThrow(new RegExp(name));
    },
  );
  it("refuses to start without a valid OWNER_PASSWORD_HASH", () => {
    const secret = "scrypt$not-a-real-hash-SECRETVALUE";
    for (const value of [undefined, "", "   ", secret]) {
      const env = validEnv();
      if (value === undefined) delete env.OWNER_PASSWORD_HASH; else env.OWNER_PASSWORD_HASH = value;
      let message = "";
      try { loadConfig(env); } catch (e) { message = (e as Error).message; }
      expect(message).toMatch(/OWNER_PASSWORD_HASH/);
      expect(message).not.toContain("SECRETVALUE");
    }
  });
  it("refuses http APP_BASE_URL except localhost", () => {
    const load = (url: string) => loadConfig({ ...validEnv(), APP_BASE_URL: url });
    expect(() => load("http://example.com")).toThrow(/APP_BASE_URL/);
    expect(load("http://localhost:8080").appBaseUrl).toBe("http://localhost:8080");
    expect(load("https://x.example").appBaseUrl).toBe("https://x.example");
  });
  it("no longer reads ENVIRONMENT or WIDGET_LOADER, and a _staging database name means nothing", () => {
    for (const extra of [{ ENVIRONMENT: "staging" }, { ENVIRONMENT: "qa-secret-value" }, { WIDGET_LOADER: "secret-widget" }, { ENVIRONMENT: "production", DATABASE_URL: stagingDatabaseUrl }]) {
      const config = loadConfig({ ...validEnv(), ...extra });
      expect("environment" in config).toBe(false);
      expect("widgetLoader" in config).toBe(false);
    }
  });
  it("WEBHOOKS_ENABLED defaults to false and accepts only true or false", () => {
    expect(loadConfig(validEnv()).webhooksEnabled).toBe(false);
    expect(loadConfig({ ...validEnv(), WEBHOOKS_ENABLED: "false" }).webhooksEnabled).toBe(false);
    expect(loadConfig({ ...validEnv(), WEBHOOKS_ENABLED: "true" }).webhooksEnabled).toBe(true);
    expect(() => loadConfig({ ...validEnv(), WEBHOOKS_ENABLED: "yes" })).toThrow(/WEBHOOKS_ENABLED/);
  });
  it("keeps runtime selection independent of an optional migration endpoint", () => {
    const expected = loadConfig(validEnv()).databaseUrl;
    for (const migrationUrl of ["postgresql://synthetic-invented-migration@localhost/postgres", "not-a-url-INVENTED-MIGRATION"]) {
      expect(loadConfig({ ...validEnv(), MIGRATION_DATABASE_URL: migrationUrl }).databaseUrl).toBe(expected);
    }
  });
  it("bounds the runtime pool while preserving encoded credentials and socket settings", () => {
    const config = loadConfig({ ...validEnv(), DATABASE_URL: "postgresql://synthetic-invented:p%40ss@localhost/db?host=%2Ftmp%2Finvented&schema=public" });
    const url = new URL(config.databaseUrl);
    expect(url.password).toBe("p%40ss");
    expect(url.searchParams.get("host")).toBe("/tmp/invented");
    expect(url.searchParams.get("connection_limit")).toBe("5");
    expect(url.searchParams.get("pool_timeout")).toBe("10");
    expect(url.searchParams.get("connect_timeout")).toBe("5");
  });

  it("preserves bounded explicit pool settings and rejects conflicting or unbounded values", () => {
    const env = { ...validEnv(), DATABASE_URL: validEnv().DATABASE_URL + "?connection_limit=3&pool_timeout=3" };
    expect(new URL(loadConfig(env).databaseUrl).searchParams.get("connection_limit")).toBe("3");
    for (const query of ["connection_limit=0", "connection_limit=1", "connection_limit=2", "connection_limit=11", "pool_timeout=0", "pool_timeout=61", "connection_limit=1&connection_limit=2", "connection_limit=oops"]) {
      expect(() => loadConfig({ ...validEnv(), DATABASE_URL: validEnv().DATABASE_URL + "?" + query })).toThrow(/DATABASE_URL/);
    }
  });

  it("rejects malformed database URLs without returning their contents", () => {
    for (const value of ["not-a-url-INVENTED", "https://invented.example/db", "postgresql://invented/db#INVENTED"]) {
      expect(() => loadConfig({ ...validEnv(), DATABASE_URL: value })).toThrow(/DATABASE_URL/);
      expect(() => loadConfig({ ...validEnv(), DATABASE_URL: value })).not.toThrow(/INVENTED/);
    }
  });
  it("returns validated server-only configuration", () => {
    const config = loadConfig(validEnv());

    expect(config.snapTrade.clientId).toBe("commercial-client");
    expect(config.snapTrade.consumerKey).toBe("consumer-secret");
    expect(config.appBaseUrl).toBe("https://portfolio.example.com");
  });

  it("passes an optional static dashboard directory to the runtime", () => {
    const env = validEnv();
    env.WEB_DIST_DIRECTORY = "  /app/packages/web/dist  ";

    expect(loadConfig(env).webDistDirectory).toBe("/app/packages/web/dist");
  });

  it("rejects a missing SnapTrade consumer key without echoing secrets", () => {
    const env = validEnv();
    env.SNAPTRADE_CONSUMER_KEY = " ";

    expect(() => loadConfig(env)).toThrow(/SNAPTRADE_CONSUMER_KEY/);
    expect(() => loadConfig(env)).not.toThrow(/consumer-secret/);
  });

});

describe("removed Auth0 settings", () => {
  it("are no longer read, required or returned", () => {
    const withOld = {
      ...validEnv(),
      AUTH0_ISSUER_BASE_URL: "https://old.example.com/", AUTH0_AUDIENCE: "https://old.example.com", AUTH0_ADDITIONAL_AUDIENCES: "x",
      AUTH0_ADDITIONAL_AUDIENCES_UNTIL: "not a date", AUTH0_PREVIOUS_ISSUER_BASE_URL: "not a url", AUTH0_PREVIOUS_ISSUER_UNTIL: "nope",
      DASHBOARD_CLIENT_ID: "bad value,with|stuff",
    };
    const config = loadConfig(withOld);
    expect(config).not.toHaveProperty("auth");
    expect(config).not.toHaveProperty("dashboardClientId");
    expect(loadConfig(validEnv())).not.toHaveProperty("auth");
  });
});

describe("widget configuration", () => {
  it("accepts an optional widgets directory", () => {
    const config = loadConfig({ ...validEnv(), WIDGETS_DIST_DIRECTORY: "/app/packages/widgets/dist" });
    expect(config.widgetsDistDirectory).toBe("/app/packages/widgets/dist");
  });
});

describe("gateway configuration", () => {
  const gatewayEnv = validEnv;

  it("always builds the gateway: issuer is the APP_BASE_URL origin and the resource is its /mcp", () => {
    const config = loadConfig(gatewayEnv());
    expect(config.gateway.issuer).toBe("https://portfolio.example.com");
    expect(config.mcpResourceUrl).toBe("https://portfolio.example.com/mcp");
    expect(config.appBaseUrl).toBe("https://portfolio.example.com");
    expect(config.gateway.signingKey.kid).toBe("k1");
    expect(config.gateway.previousSigningKey).toBeUndefined();
    // A path or trailing slash on APP_BASE_URL never reaches the issuer.
    const pathy = loadConfig({ ...gatewayEnv(), APP_BASE_URL: "https://portfolio.example.com/some/path/" });
    expect(pathy.gateway.issuer).toBe("https://portfolio.example.com");
    expect(pathy.mcpResourceUrl).toBe("https://portfolio.example.com/mcp");
  });

  it("allows a plain-http loopback APP_BASE_URL for a local trial run", () => {
    const config = loadConfig({ ...gatewayEnv(), APP_BASE_URL: "http://localhost:3004" });
    expect(config.gateway.issuer).toBe("http://localhost:3004");
    expect(config.mcpResourceUrl).toBe("http://localhost:3004/mcp");
  });

  it("no longer reads the removed gateway and Auth0-cutover variables", () => {
    const config = loadConfig({
      ...gatewayEnv(),
      MCP_GATEWAY_ENABLED: "false",
      MCP_GATEWAY_ISSUER: "https://elsewhere.example.net",
      MCP_RESOURCE_URL: "https://elsewhere.example.net/mcp",
      MCP_GATEWAY_AUTH0_CLIENT_ID: "x",
      MCP_GATEWAY_AUTH0_CLIENT_SECRET: "y",
      MCP_ACCEPT_AUTH0_TOKENS_UNTIL: "not a date",
    });
    expect(config.gateway.issuer).toBe("https://portfolio.example.com");
    expect(config.mcpResourceUrl).toBe("https://portfolio.example.com/mcp");
    expect(config.gateway).not.toHaveProperty("auth0ClientId");
    expect(config.gateway).not.toHaveProperty("acceptAuth0TokensUntil");
  });

  it("strips unknown JWK members and rejects a previous key reusing the current kid", () => {
    const gateway = loadConfig({
      ...gatewayEnv(),
      MCP_GATEWAY_SIGNING_KEY: JSON.stringify({ ...privateJwk, key_ops: ["sign"], ext: true, extra: "x" }),
      MCP_GATEWAY_PREVIOUS_SIGNING_KEY: JSON.stringify({ ...privateJwk, kid: "k0", d: "leak" }),
    }).gateway;
    expect(Object.keys(gateway.signingKey).sort()).toEqual(["crv", "d", "kid", "kty", "x", "y"]);
    expect(Object.keys(gateway.previousSigningKey!).sort()).toEqual(["crv", "kid", "kty", "x", "y"]);
    expect(() => loadConfig({ ...gatewayEnv(), MCP_GATEWAY_PREVIOUS_SIGNING_KEY: JSON.stringify(publicJwk).replace('"k0"', '"k1"') })).toThrow(/MCP_GATEWAY_PREVIOUS_SIGNING_KEY/);
  });

  it("accepts a public previous key", () => {
    const gateway = loadConfig({ ...gatewayEnv(), MCP_GATEWAY_PREVIOUS_SIGNING_KEY: JSON.stringify(publicJwk) }).gateway;
    expect(gateway.previousSigningKey?.kid).toBe("k0");
  });

  it("requires MCP_GATEWAY_SIGNING_KEY, naming it without values", () => {
    for (const bad of [undefined, "", "  "]) {
      const env = { ...gatewayEnv(), MCP_GATEWAY_SIGNING_KEY: bad };
      expect(() => loadConfig(env)).toThrow(/MCP_GATEWAY_SIGNING_KEY/);
    }
  });

  it("rejects bad signing keys without echoing them", () => {
    const { d: _d, ...withoutD } = privateJwk;
    const noKid = { ...privateJwk, kid: undefined };
    for (const bad of [withoutD, noKid, rsaJwk, "not json"]) {
      const value = typeof bad === "string" ? bad : JSON.stringify(bad);
      const env = { ...gatewayEnv(), MCP_GATEWAY_SIGNING_KEY: value };
      expect(() => loadConfig(env)).toThrow(/MCP_GATEWAY_SIGNING_KEY/);
      expect(() => loadConfig(env)).not.toThrow(new RegExp(String(privateJwk.d).slice(0, 12)));
    }
  });

  it("rejects a bad previous key", () => {
    expect(() => loadConfig({ ...gatewayEnv(), MCP_GATEWAY_PREVIOUS_SIGNING_KEY: JSON.stringify(rsaJwk) })).toThrow(/MCP_GATEWAY_PREVIOUS_SIGNING_KEY/);
  });
});

describe("APP_BASE_URL scheme", () => {
  const load = (url: string) => loadConfig({ ...validEnv(), APP_BASE_URL: url });

  it.each(["https://x.example", "http://localhost:3004", "http://127.0.0.1:3004", "http://[::1]:3004"])("accepts %s", (url) => {
    expect(load(url).gateway.issuer).toBe(new URL(url).origin);
  });

  it.each(["http://example.test", "http://localhost.example.test", "foo:bar", "ftp://localhost", "https://u:p@x.test", "http://u:p@localhost:3004"])(
    "rejects %s without echoing it",
    (url) => {
      let message = "";
      try { load(url); } catch (e) { message = (e as Error).message; }
      expect(message).toBe("Invalid server configuration: APP_BASE_URL");
    },
  );
});

describe("owner sign-in configuration", () => {
  const message = (env: NodeJS.ProcessEnv) => {
    try { loadConfig(env); } catch (e) { return (e as Error).message; }
    return "";
  };

  it("loads the password hash and session secret", () => {
    const { owner } = loadConfig(validEnv());
    expect(owner.passwordHash).toBe(OWNER_HASH);
    expect(owner.sessionSecret).toBe(SESSION_SECRET);
  });

  it.each(["SESSION_SECRET", "OWNER_PASSWORD_HASH"])("requires %s, naming it without values", (name) => {
    for (const bad of [undefined, "", "  "]) {
      expect(message({ ...validEnv(), [name]: bad })).toBe(`Invalid server configuration: ${name}`);
    }
  });

  it("requires SESSION_SECRET to decode to at least 32 bytes of base64url, never echoing it", () => {
    expect(loadConfig({ ...validEnv(), SESSION_SECRET: "a".repeat(43) }).owner.sessionSecret).toBe("a".repeat(43));
    for (const bad of ["a".repeat(42), "short-secret-value", "not base64url !!!".padEnd(60, "x"), "a".repeat(43) + "=="]) {
      const text = message({ ...validEnv(), SESSION_SECRET: bad });
      expect(text).toBe("Invalid server configuration: SESSION_SECRET");
      expect(text).not.toContain(bad);
    }
  });

  it("validates OWNER_PASSWORD_HASH with the same parser the login uses, never echoing it", () => {
    const [scheme, , r, p, salt, hash] = OWNER_HASH.split("$");
    const weak = ["scrypt", "1024", r, p, salt, hash].join("$");
    for (const bad of ["plaintext-password", "scrypt$1$2$3", weak, `${OWNER_HASH}$extra`, OWNER_HASH.replace(scheme!, "bcrypt")]) {
      const text = message({ ...validEnv(), OWNER_PASSWORD_HASH: bad });
      expect(text).toBe("Invalid server configuration: OWNER_PASSWORD_HASH");
      expect(text).not.toContain(bad);
    }
  });
});

describe("news configuration", () => {
  const newsEnv = (): NodeJS.ProcessEnv => ({
    ...validEnv(),
    NEWS_ENABLED: "true",
    TYPESAFE_API_KEY: "ts-secret-value",
    MARKETAUX_API_KEY: "mx-secret-value",
    EDGAR_USER_AGENT: "Portfolio App ops@example.com",
  });

  it("leaves news undefined when disabled or unset, tolerating empty variables", () => {
    expect(loadConfig(validEnv()).news).toBeUndefined();
    expect(loadConfig({ ...validEnv(), NEWS_ENABLED: "false" }).news).toBeUndefined();
    const empty = { ...validEnv(), TYPESAFE_API_KEY: "", TYPESAFE_MODEL: " ", MARKETAUX_API_KEY: "", MARKETAUX_DAILY_BUDGET: "", EDGAR_USER_AGENT: "" };
    expect(loadConfig(empty).news).toBeUndefined();
    expect("news" in loadConfig(validEnv())).toBe(false);
  });

  it("parses a complete configuration with defaults", () => {
    expect(loadConfig(newsEnv()).news).toEqual({
      typesafeApiKey: "ts-secret-value",
      typesafeModel: "jev-1.13.0",
      marketauxApiKey: "mx-secret-value",
      marketauxDailyBudget: 90,
      edgarUserAgent: "Portfolio App ops@example.com",
    });
    const custom = loadConfig({ ...newsEnv(), TYPESAFE_MODEL: "jev-2", MARKETAUX_DAILY_BUDGET: "40" }).news!;
    expect(custom.typesafeModel).toBe("jev-2");
    expect(custom.marketauxDailyBudget).toBe(40);
  });

  it.each(["TYPESAFE_API_KEY", "MARKETAUX_API_KEY", "EDGAR_USER_AGENT"])("requires %s when enabled, naming it without values", (name) => {
    const env = newsEnv();
    delete env[name];
    expect(() => loadConfig(env)).toThrow(new RegExp(name));
    expect(() => loadConfig({ ...env, [name]: "  " })).toThrow(new RegExp(name));
    expect(() => loadConfig(env)).not.toThrow(/secret-value/);
  });

  it.each(["abc", "0", "-3", "1.5", "100000"])("rejects budget %s naming the variable only", (v) => {
    expect(() => loadConfig({ ...newsEnv(), MARKETAUX_DAILY_BUDGET: v })).toThrow("Invalid server configuration: MARKETAUX_DAILY_BUDGET");
    expect(() => loadConfig({ ...newsEnv(), MARKETAUX_DAILY_BUDGET: v })).not.toThrow(/secret-value/);
  });


  it("news is off unless enabled with keys", () => {
    // Off by default, and keys alone do not turn it on.
    expect(loadConfig(validEnv()).news).toBeUndefined();
    expect(loadConfig({ ...validEnv(), MARKETAUX_API_KEY: "mx-secret-value", TYPESAFE_API_KEY: "ts-secret-value" }).news).toBeUndefined();
    // Enabled without keys is a startup error naming the missing keys (never a silent half-on state).
    let message = "";
    try { loadConfig({ ...validEnv(), NEWS_ENABLED: "true" }); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/MARKETAUX_API_KEY/);
    expect(message).toMatch(/TYPESAFE_API_KEY/);
    expect(loadConfig(newsEnv()).news?.marketauxApiKey).toBe("mx-secret-value");
  });

  it("rejects an invalid NEWS_ENABLED value", () => {
    expect(() => loadConfig({ ...validEnv(), NEWS_ENABLED: "yes" })).toThrow(/NEWS_ENABLED/);
  });
});

describe("SNAPTRADE_BASE_PATH (test-only)", () => {
  it("is accepted only when NODE_ENV=test and exposed as snapTrade.basePath", () => {
    const env = { ...validEnv(), NODE_ENV: "test", SNAPTRADE_BASE_PATH: "http://host.docker.internal:4010" };
    expect(loadConfig(env).snapTrade.basePath).toBe("http://host.docker.internal:4010");
    expect(loadConfig({ ...validEnv(), NODE_ENV: "test" }).snapTrade).toEqual({ clientId: "commercial-client", consumerKey: "consumer-secret" });
  });
  it.each([undefined, "production", "development", ""])("rejects a set value when NODE_ENV is %s, naming only the variable", (nodeEnv) => {
    const env: NodeJS.ProcessEnv = { ...validEnv(), SNAPTRADE_BASE_PATH: "http://127.0.0.1:4010/secret-path" };
    if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
    expect(() => loadConfig(env)).toThrow("Invalid server configuration: SNAPTRADE_BASE_PATH");
    expect(() => loadConfig(env)).not.toThrow(/secret-path/);
  });
  it("rejects a value that is not an http(s) URL even in test", () => {
    expect(() => loadConfig({ ...validEnv(), NODE_ENV: "test", SNAPTRADE_BASE_PATH: "not a url" })).toThrow("Invalid server configuration: SNAPTRADE_BASE_PATH");
    expect(() => loadConfig({ ...validEnv(), NODE_ENV: "test", SNAPTRADE_BASE_PATH: "file:///etc/passwd" })).toThrow("Invalid server configuration: SNAPTRADE_BASE_PATH");
  });
});

describe("TRUST_PROXY", () => {
  it("defaults to trusting nothing", () => {
    expect(loadConfig(validEnv()).trustProxy).toBeUndefined();
    expect(loadConfig({ ...validEnv(), TRUST_PROXY: "" }).trustProxy).toBeUndefined();
  });
  it.each(["1", "2", "5"])("accepts a hop count of %s", (v) => {
    expect(loadConfig({ ...validEnv(), TRUST_PROXY: v }).trustProxy).toBe(Number(v));
  });
  it("trims surrounding whitespace before reading the hop count", () => {
    expect(loadConfig({ ...validEnv(), TRUST_PROXY: " 1 " }).trustProxy).toBe(1);
  });
  it.each(["0", "6", "-1", "1.5", "true", "loopback", "10.0.0.0/8"])("rejects %s", (v) => {
    expect(() => loadConfig({ ...validEnv(), TRUST_PROXY: v })).toThrow("Invalid server configuration: TRUST_PROXY");
  });
});

describe("listenHost", () => {
  it("defaults to loopback so a directly run API is not exposed on the LAN", () => {
    expect(listenHost({})).toBe("127.0.0.1");
    expect(listenHost({ HOST: "" })).toBe("127.0.0.1");
    expect(listenHost({ HOST: "  " })).toBe("127.0.0.1");
  });
  it("takes HOST (the container sets 0.0.0.0)", () => {
    expect(listenHost({ HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(listenHost({ HOST: " ::1 " })).toBe("::1");
  });
  it("refuses a value that is not an address or host name, without echoing it", () => {
    expect(() => listenHost({ HOST: "bad host;rm" })).toThrow("Invalid server configuration: HOST");
    expect(() => listenHost({ HOST: "bad host;rm" })).not.toThrow(/rm/);
  });
});
