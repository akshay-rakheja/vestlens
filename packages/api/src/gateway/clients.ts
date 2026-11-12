/**
 * Client registry for the MCP sign-in gateway: RFC 7591 dynamic registration
 * (DCR) plus Client ID Metadata Documents (CIMD, https client_ids).
 */
import { OAuthClientMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";

import type { CimdResolver } from "./cimd.js";
import { randomToken, sha256 } from "./crypto.js";
import { SlidingWindowLimiter } from "./rate-limit.js";
import { isAllowedRedirectForm, MAX_REDIRECT_URI_LENGTH } from "./redirects.js";
import type { GatewayStore } from "./store.js";

export interface ResolvedClient {
  clientKey: string;
  kind: "dcr" | "cimd";
  name: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_post";
  /** Supported grants: authorization_code, plus refresh_token when registered or listed (CIMD default: both). */
  grantTypes: string[];
  clientSecretHash: string | null;
  verifiedHost: boolean;
}

export const VERIFIED_HOSTS: readonly string[] = ["claude.ai", "chatgpt.com"];

export const DEFAULT_MAX_CLIENTS = 5_000;
export const REGISTRATIONS_PER_IP_PER_HOUR = 20;
/** Second budget per IPv6 /48 (one site holds 65k /64s). */
export const REGISTRATIONS_PER_PREFIX_PER_HOUR = 100;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME = 100;
const RATE_SWEEP_INTERVAL_MS = 60 * 1000;
export const RATE_LIMIT_MAX_KEYS = 50_000;
/** C0/C1 controls, bidi marks/embeddings/overrides/isolates, zero-width chars, line/paragraph separators, BOM. */
const UNSAFE_NAME_CHARS = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/g;

/** Strips control and bidi-formatting characters, trims, and caps at 100 code points. Empty → null. */
export function sanitizeClientName(name: string | undefined | null): string | null {
  if (typeof name !== "string") return null;
  const cleaned = Array.from(name.replace(UNSAFE_NAME_CHARS, "").trim()).slice(0, MAX_CLIENT_NAME).join("").trim();
  return cleaned === "" ? null : cleaned;
}
const ALLOWED_GRANTS: ReadonlySet<string> = new Set(["authorization_code", "refresh_token"]);
const ALLOWED_RESPONSE_TYPES: ReadonlySet<string> = new Set(["code"]);

type AuthMethod = ResolvedClient["tokenEndpointAuthMethod"];

export interface ValidatedMetadata {
  redirectUris: string[];
  tokenEndpointAuthMethod: AuthMethod;
  grantTypes: string[];
  responseTypes: string[];
  clientName: string | null;
}

export type MetadataResult =
  | { ok: true; value: ValidatedMetadata }
  | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string };

/**
 * Shared by DCR bodies and CIMD documents.
 *
 * - `dcr` (default): grant/response types must be subsets of what we support;
 *   the auth method must be one of `allowedAuthMethods`.
 * - `cimd`: documents are published for many servers, so extra grants and
 *   response types are ignored as long as `authorization_code` / `code` are
 *   present (or the member is absent). The client is treated as public
 *   (`none`, PKCE) when `token_endpoint_auth_method` is `none`/absent or
 *   `token_endpoint_auth_methods_supported` includes `none`; otherwise the
 *   document is rejected (private_key_jwt is not supported).
 */
export function validateClientMetadata(
  body: unknown,
  o: { allowedAuthMethods: readonly AuthMethod[]; mode?: "dcr" | "cimd" },
): MetadataResult {
  const cimd = o.mode === "cimd";
  const fail = (error: "invalid_redirect_uri" | "invalid_client_metadata", description: string): MetadataResult => ({
    ok: false,
    error,
    description,
  });
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("invalid_client_metadata", "Client metadata must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;

  const uris = raw.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return fail("invalid_redirect_uri", "redirect_uris must be a non-empty array.");
  if (uris.length > MAX_REDIRECT_URIS) return fail("invalid_redirect_uri", `At most ${MAX_REDIRECT_URIS} redirect_uris are allowed.`);
  for (const u of uris) {
    if (typeof u !== "string" || u.length > MAX_REDIRECT_URI_LENGTH || !isAllowedRedirectForm(u)) {
      return fail("invalid_redirect_uri", "Each redirect_uri must be https or loopback http (127.0.0.1 or localhost).");
    }
  }

  const parsed = OAuthClientMetadataSchema.safeParse(body);
  if (!parsed.success) return fail("invalid_client_metadata", "Client metadata does not match RFC 7591.");
  const meta = parsed.data;

  let method = (meta.token_endpoint_auth_method ?? "none") as string;
  if (cimd && method !== "none") {
    const supported = raw.token_endpoint_auth_methods_supported;
    if (Array.isArray(supported) && supported.includes("none")) method = "none";
  }
  if (!(o.allowedAuthMethods as readonly string[]).includes(method)) {
    return fail("invalid_client_metadata", `token_endpoint_auth_method must be one of: ${o.allowedAuthMethods.join(", ")}.`);
  }

  let grantTypes = meta.grant_types ?? ["authorization_code", "refresh_token"];
  let responseTypes = meta.response_types ?? ["code"];
  if (cimd) {
    if (!grantTypes.includes("authorization_code")) {
      return fail("invalid_client_metadata", "grant_types must include authorization_code.");
    }
    if (!responseTypes.includes("code")) return fail("invalid_client_metadata", "response_types must include code.");
    grantTypes = grantTypes.filter((g) => ALLOWED_GRANTS.has(g));
    responseTypes = responseTypes.filter((r) => ALLOWED_RESPONSE_TYPES.has(r));
  } else {
    if (grantTypes.length === 0 || !grantTypes.every((g) => ALLOWED_GRANTS.has(g))) {
      return fail("invalid_client_metadata", "grant_types may contain only authorization_code and refresh_token.");
    }
    if (responseTypes.length === 0 || !responseTypes.every((r) => ALLOWED_RESPONSE_TYPES.has(r))) {
      return fail("invalid_client_metadata", "response_types may contain only code.");
    }
  }


  return {
    ok: true,
    value: {
      redirectUris: [...(uris as string[])],
      tokenEndpointAuthMethod: method as AuthMethod,
      grantTypes: [...new Set(grantTypes)],
      responseTypes: [...new Set(responseTypes)],
      clientName: sanitizeClientName(meta.client_name),
    },
  };
}

type RegisterError = { status: 400 | 429; body: { error: string; error_description: string } };
type RegisterResult = { status: 201; body: Record<string, unknown> } | RegisterError;

export class ClientRegistry {
  private readonly store: GatewayStore;
  private readonly cimd: CimdResolver;
  private readonly now: () => Date;
  private readonly maxClients: number;
  /** ipHash → attempt timestamps (ms) within the last hour. In-memory: resets on restart. */
  private readonly attempts = new Map<string, number[]>();
  private lastSweepMs = Number.NEGATIVE_INFINITY;
  private readonly prefixLimiter = new SlidingWindowLimiter([{ ms: RATE_WINDOW_MS, max: REGISTRATIONS_PER_PREFIX_PER_HOUR }]);

  constructor(o: { store: GatewayStore; cimd: CimdResolver; now?: () => Date; maxClients?: number }) {
    this.store = o.store;
    this.cimd = o.cimd;
    this.now = o.now ?? (() => new Date());
    this.maxClients = o.maxClients ?? DEFAULT_MAX_CLIENTS;
  }

  /** `prefixHash`: hashed IPv6 /48 key (`rateLimitPrefixKeyForIp`), or null for IPv4. */
  async register(body: unknown, ipHash: string, prefixHash: string | null = null): Promise<RegisterResult> {
    const now = this.now();
    if (
      !this.takeRateSlot(ipHash, now.getTime()) ||
      (prefixHash !== null && !this.prefixLimiter.take(prefixHash, now.getTime()))
    ) {
      return tooMany("Too many client registrations from this address; try again later.");
    }

    const meta = validateClientMetadata(body, { allowedAuthMethods: ["none", "client_secret_post"] });
    if (!meta.ok) return { status: 400, body: { error: meta.error, error_description: meta.description } };

    if ((await this.store.countClients()) >= this.maxClients) {
      return tooMany("Client registration is temporarily unavailable.");
    }

    const v = meta.value;
    const clientId = randomToken(24);
    const secret = v.tokenEndpointAuthMethod === "client_secret_post" ? randomToken(32) : null;
    await this.store.createClient({
      clientId,
      clientSecretHash: secret ? sha256(secret) : null,
      redirectUris: v.redirectUris,
      clientName: v.clientName,
      tokenEndpointAuthMethod: v.tokenEndpointAuthMethod,
      grantTypes: v.grantTypes,
      createdAt: now,
      lastUsedAt: null,
    });

    const response: Record<string, unknown> = {
      client_id: clientId,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      redirect_uris: v.redirectUris,
      token_endpoint_auth_method: v.tokenEndpointAuthMethod,
      grant_types: v.grantTypes,
      response_types: v.responseTypes,
      client_name: v.clientName ?? undefined,
    };
    if (response.client_name === undefined) delete response.client_name;
    if (secret) {
      response.client_secret = secret;
      response.client_secret_expires_at = 0; // RFC 7591 §3.2.1: required with a secret; 0 = never expires
    }
    return { status: 201, body: response };
  }

  /** https URL → CIMD; anything else → DCR client id. */
  async resolve(clientId: string): Promise<ResolvedClient | null> {
    if (typeof clientId !== "string" || clientId.length === 0) return null;
    if (clientId.startsWith("https://")) return this.cimd.resolve(clientId);
    if (clientId.includes(":")) return null; // other URL-like ids are never DCR ids
    const c = await this.store.getClient(clientId);
    if (!c) return null;
    return {
      clientKey: c.clientId,
      kind: "dcr",
      name: c.clientName ?? "Unnamed client",
      redirectUris: [...c.redirectUris],
      tokenEndpointAuthMethod: c.tokenEndpointAuthMethod,
      grantTypes: [...c.grantTypes],
      clientSecretHash: c.clientSecretHash,
      verifiedHost: false,
    };
  }

  /**
   * Sliding window per ipHash. Task 4 should derive ipHash from
   * `rateLimitKeyForIp` (./ip.ts) so IPv6 is limited per /64. Expired keys are
   * swept at most once a minute; the map is capped at RATE_LIMIT_MAX_KEYS by
   * evicting the least recently used key (Map order = last access).
   */
  private takeRateSlot(ipHash: string, nowMs: number): boolean {
    const cutoff = nowMs - RATE_WINDOW_MS;
    if (nowMs - this.lastSweepMs >= RATE_SWEEP_INTERVAL_MS) {
      this.lastSweepMs = nowMs;
      for (const [k, ts] of this.attempts) if (!ts.some((t) => t > cutoff)) this.attempts.delete(k);
    }
    const recent = (this.attempts.get(ipHash) ?? []).filter((t) => t > cutoff);
    this.attempts.delete(ipHash); // re-inserted below to move it to the most-recent end
    const allowed = recent.length < REGISTRATIONS_PER_IP_PER_HOUR;
    if (allowed) recent.push(nowMs);
    while (this.attempts.size >= RATE_LIMIT_MAX_KEYS) {
      const oldest = this.attempts.keys().next().value;
      if (oldest === undefined) break;
      this.attempts.delete(oldest);
    }
    this.attempts.set(ipHash, recent);
    return allowed;
  }
}

function tooMany(description: string): RegisterError {
  return { status: 429, body: { error: "temporarily_unavailable", error_description: description } };
}
