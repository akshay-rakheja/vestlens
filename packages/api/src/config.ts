import { z } from "zod";
import type { JWK } from "jose";
import { parseOwnerPasswordHash } from "./auth/owner-password.js";
import { isLoopbackHttp } from "./loopback-url.js";
import { runtimeDatabaseUrl } from "./database-url.js";

const envSchema = z.object({
  SNAPTRADE_CLIENT_ID: z.string().trim().min(1),
  SNAPTRADE_CONSUMER_KEY: z.string().trim().min(1),
  DATABASE_URL: z.string().trim().min(1),
  APP_BASE_URL: z.url(),
  WEB_DIST_DIRECTORY: z.string().trim().min(1).optional(),
  WIDGETS_DIST_DIRECTORY: z.string().trim().min(1).optional(),
  MCP_GATEWAY_SIGNING_KEY: z.string().trim().min(1),
  MCP_GATEWAY_PREVIOUS_SIGNING_KEY: z.string().optional(),
  SESSION_SECRET: z.string().trim().min(1),
  OWNER_PASSWORD_HASH: z.string().trim().min(1),
  NEWS_ENABLED: z.enum(["true", "false"]).default("false"),
  TYPESAFE_API_KEY: z.string().optional(),
  TYPESAFE_MODEL: z.string().optional(),
  MARKETAUX_API_KEY: z.string().optional(),
  MARKETAUX_DAILY_BUDGET: z.string().optional(),
  EDGAR_USER_AGENT: z.string().optional(),
  WEBHOOKS_ENABLED: z.enum(["true", "false"]).default("false"),
  NODE_ENV: z.string().optional(),
  SNAPTRADE_BASE_PATH: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
});

export interface NewsConfig {
  typesafeApiKey: string;
  typesafeModel: string;
  marketauxApiKey: string;
  marketauxDailyBudget: number;
  edgarUserAgent: string;
}

export interface GatewayConfig {
  /** The origin of APP_BASE_URL: the JWT `iss` and the metadata `issuer`. */
  issuer: string;
  signingKey: JWK;
  previousSigningKey?: JWK;
}

/** The owner's sign-in secrets (see scripts/setup.mjs). Never logged. */
export interface OwnerAuthConfig {
  /** OWNER_PASSWORD_HASH: `scrypt$N$r$p$salt$hash`, validated at load. */
  passwordHash: string;
  /** SESSION_SECRET: keys the HMAC that identifies a session in the database (at least 32 bytes, base64url). */
  sessionSecret: string;
}

/** The self-hosted configuration: one owner, one instance. */
export interface SelfHostConfig {
  snapTrade: {
    clientId: string;
    consumerKey: string;
    /** SNAPTRADE_BASE_PATH: a stand-in SnapTrade address. Only ever set when NODE_ENV=test (the Compose smoke test). */
    basePath?: string;
  };
  databaseUrl: string;
  appBaseUrl: string;
  /** `${appBaseUrl}/mcp`: the gateway's JWT audience and the only resource. */
  mcpResourceUrl: string;
  webDistDirectory?: string;
  widgetsDistDirectory?: string;
  gateway: GatewayConfig;
  owner: OwnerAuthConfig;
  news?: NewsConfig;
  /** TRUST_PROXY: reverse-proxy hops to trust for the client address (1 to 5). Absent means trust none. */
  trustProxy?: number;
  /** WEBHOOKS_ENABLED: mount POST /webhooks/snaptrade (verified with the consumer key). Off by default. */
  webhooksEnabled: boolean;
}

function parseJwk(name: string, raw: string, requirePrivate: boolean): JWK {
  const fail = (): never => {
    throw new Error(`Invalid server configuration: ${name}`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail();
  const raw_ = parsed as JWK;
  if (raw_.kty !== "EC" || raw_.crv !== "P-256" || typeof raw_.x !== "string" || typeof raw_.y !== "string") return fail();
  if (typeof raw_.kid !== "string" || raw_.kid.length === 0) return fail();
  if (requirePrivate && (typeof raw_.d !== "string" || raw_.d.length === 0)) return fail();
  // Whitelist members so extras (and any private part on a previous key) never propagate.
  const jwk: JWK = { kty: raw_.kty, crv: raw_.crv, x: raw_.x, y: raw_.y, kid: raw_.kid };
  if (requirePrivate) jwk.d = raw_.d;
  return jwk;
}

/**
 * APP_BASE_URL is the gateway's issuer, so it must be https, or http on this machine only (a local trial run).
 * No credentials in the URL. The message never echoes the value.
 */
function loadAppBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Invalid server configuration: APP_BASE_URL"); }
  if ((url.protocol !== "https:" && !isLoopbackHttp(url)) || url.username || url.password) {
    throw new Error("Invalid server configuration: APP_BASE_URL");
  }
  return url.origin;
}

/** Accepted only under NODE_ENV=test, so a production instance can never be pointed away from SnapTrade. Never echoes the value. */
function loadSnapTradeBasePath(data: z.infer<typeof envSchema>): string | undefined {
  const raw = data.SNAPTRADE_BASE_PATH;
  if (raw === undefined) return undefined;
  const fail = (): never => { throw new Error("Invalid server configuration: SNAPTRADE_BASE_PATH"); };
  if (data.NODE_ENV !== "test") return fail();
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return fail(); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return fail();
  return raw.trim().replace(/\/+$/, "");
}

/** TRUST_PROXY: unset or empty trusts nothing; otherwise an integer hop count from 1 to 5. */
function loadTrustProxy(data: z.infer<typeof envSchema>): number | undefined {
  const raw = data.TRUST_PROXY?.trim();
  if (!raw) return undefined;
  if (!/^[1-5]$/.test(raw)) throw new Error("Invalid server configuration: TRUST_PROXY");
  return Number(raw);
}

function loadGatewayConfig(data: z.infer<typeof envSchema>, issuer: string): GatewayConfig {
  const signingKey = parseJwk("MCP_GATEWAY_SIGNING_KEY", data.MCP_GATEWAY_SIGNING_KEY, true);
  const previousRaw = data.MCP_GATEWAY_PREVIOUS_SIGNING_KEY?.trim() || undefined;
  const previousSigningKey = previousRaw
    ? parseJwk("MCP_GATEWAY_PREVIOUS_SIGNING_KEY", previousRaw, false)
    : undefined;
  if (previousSigningKey && previousSigningKey.kid === signingKey.kid) {
    throw new Error("Invalid server configuration: MCP_GATEWAY_PREVIOUS_SIGNING_KEY");
  }
  return { issuer, signingKey, ...(previousSigningKey ? { previousSigningKey } : {}) };
}

/** Both owner secrets are validated here so a bad value fails at startup, never at the first login. Values are never echoed. */
function loadOwnerAuth(data: z.infer<typeof envSchema>): OwnerAuthConfig {
  const secret = data.SESSION_SECRET;
  if (!/^[A-Za-z0-9_-]+$/.test(secret) || Buffer.from(secret, "base64url").length < 32) {
    throw new Error("Invalid server configuration: SESSION_SECRET");
  }
  try {
    parseOwnerPasswordHash(data.OWNER_PASSWORD_HASH);
  } catch {
    throw new Error("Invalid server configuration: OWNER_PASSWORD_HASH");
  }
  return { passwordHash: data.OWNER_PASSWORD_HASH, sessionSecret: secret };
}

function loadNewsConfig(
  data: z.infer<typeof envSchema>,
): NewsConfig | undefined {
  if (data.NEWS_ENABLED !== "true") return undefined;
  const trimmed = (v: string | undefined) => v?.trim() || undefined;
  const required = {
    TYPESAFE_API_KEY: trimmed(data.TYPESAFE_API_KEY),
    MARKETAUX_API_KEY: trimmed(data.MARKETAUX_API_KEY),
    EDGAR_USER_AGENT: trimmed(data.EDGAR_USER_AGENT),
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`Invalid server configuration: ${missing.join(", ")}`);
  }
  const budgetRaw = trimmed(data.MARKETAUX_DAILY_BUDGET);
  let marketauxDailyBudget = 90;
  if (budgetRaw !== undefined) {
    if (!/^\d{1,5}$/.test(budgetRaw) || Number(budgetRaw) < 1 || Number(budgetRaw) > 10_000) {
      throw new Error("Invalid server configuration: MARKETAUX_DAILY_BUDGET");
    }
    marketauxDailyBudget = Number(budgetRaw);
  }
  return {
    typesafeApiKey: required.TYPESAFE_API_KEY!,
    typesafeModel: trimmed(data.TYPESAFE_MODEL) ?? "jev-1.13.0",
    marketauxApiKey: required.MARKETAUX_API_KEY!,
    marketauxDailyBudget,
    edgarUserAgent: required.EDGAR_USER_AGENT!,
  };
}

/**
 * The address the server binds. Loopback unless `HOST` says otherwise: run directly (outside Docker), the plain-http
 * login must not be reachable from the LAN. The container sets HOST=0.0.0.0; Compose still publishes on 127.0.0.1 only.
 */
export function listenHost(env: NodeJS.ProcessEnv): string {
  const raw = env.HOST?.trim();
  if (!raw) return "127.0.0.1";
  if (!/^[A-Za-z0-9.:_-]{1,253}$/.test(raw)) throw new Error("Invalid server configuration: HOST");
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv): SelfHostConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const invalidNames = [
      ...new Set(result.error.issues.map((issue) => String(issue.path[0]))),
    ];
    throw new Error(
      `Invalid server configuration: ${invalidNames.join(", ")}`,
    );
  }

  const databaseUrl = runtimeDatabaseUrl(result.data.DATABASE_URL);
  const appBaseUrl = loadAppBaseUrl(result.data.APP_BASE_URL);
  const gateway = loadGatewayConfig(result.data, appBaseUrl);
  const owner = loadOwnerAuth(result.data);
  const news = loadNewsConfig(result.data);
  const basePath = loadSnapTradeBasePath(result.data);
  const trustProxy = loadTrustProxy(result.data);
  return {
    snapTrade: {
      clientId: result.data.SNAPTRADE_CLIENT_ID,
      consumerKey: result.data.SNAPTRADE_CONSUMER_KEY,
      ...(basePath ? { basePath } : {}),
    },
    databaseUrl,
    appBaseUrl,
    mcpResourceUrl: `${appBaseUrl}/mcp`,
    webDistDirectory: result.data.WEB_DIST_DIRECTORY,
    widgetsDistDirectory: result.data.WIDGETS_DIST_DIRECTORY,
    gateway,
    owner,
    webhooksEnabled: result.data.WEBHOOKS_ENABLED === "true",
    ...(trustProxy !== undefined ? { trustProxy } : {}),
    ...(news ? { news } : {}),
  };
}
