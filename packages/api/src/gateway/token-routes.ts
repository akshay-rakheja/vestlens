/**
 * POST /token, /revoke and /register for the MCP sign-in gateway (spec §4 step 7, §10).
 *
 * The store only records state; every binding is checked here:
 * - codes: expiry, client, exact redirect_uri, PKCE S256, resource, scope;
 * - refresh tokens: client (before rotation, so another client cannot burn a
 *   token), the user's stored consent (missing → the family is revoked), sliding expiry (30 d from issue/rotation), absolute family expiry
 *   (30 d from the code exchange, carried unchanged through rotations), resource
 *   and scope.
 *
 * A second use of a code (by the same client, within 10 min of the code's
 * expiry) or of a rotated refresh token revokes the whole family (Review
 * Focus 3). A revoked-family marker closes the race with a concurrent
 * exchange: createRefresh (or, without refresh, isFamilyRevoked) reports the
 * revocation and no tokens are returned. The access JWT is minted before that
 * final family check, so a revoke that marks families and then writes its
 * access-token marker (store.revokeClient / revokeAllForSubject) always either
 * stops the exchange or post-dates the token; /mcp refuses tokens issued at or
 * before a marker.
 *
 * Refresh tokens are issued only to clients whose registered (DCR) or
 * published (CIMD) grant_types include refresh_token.
 *
 * A mismatched `resource` parameter is `invalid_target` on both grants; a code
 * bound to another resource is `invalid_grant`.
 */
import { timingSafeEqual } from "node:crypto";

import express, { type NextFunction, type Request, type Response } from "express";

import type { GatewayLogEvent } from "./authorize-routes.js";
import type { ClientRegistry, ResolvedClient } from "./clients.js";
import { randomToken, sha256, verifyPkceS256 } from "./crypto.js";
import { rateLimitKeyForIp, rateLimitPrefixKeyForIp } from "./ip.js";
import { SlidingWindowLimiter } from "./rate-limit.js";
import { isGrantedScope, normalizeScope } from "./scope.js";
import type { GatewayStore, RefreshToken } from "./store.js";
import type { GatewayTokenService } from "./tokens.js";

export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const FAMILY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Reuse of a code revokes its family only within this window after the code's expiry. */
export const CODE_REUSE_REVOKE_GRACE_MS = 10 * 60 * 1000;
/** Shared per-IP budget (IPv6 per /64) for /token and /revoke. */
export const TOKEN_PER_IP_PER_MINUTE = 60;

/**
 * Same rule as /authorize: portfolio:read, optionally memory, optionally with dropped
 * OpenID/refresh scopes. The parameter is only validated: what is issued is always the
 * grant's own stored scope, so a refresh never escalates a pre-memory family.
 */
const scopeParamOk = (scope: string | undefined): boolean => normalizeScope(scope) !== null;

type OAuthError =
  | "invalid_client"
  | "invalid_grant"
  | "invalid_request"
  | "unsupported_grant_type"
  | "unauthorized_client"
  | "invalid_scope"
  | "invalid_target";

const DESCRIPTIONS: Record<OAuthError, string> = {
  invalid_client: "Client authentication failed.",
  invalid_grant: "The grant is invalid, expired or was already used.",
  invalid_request: "The request is missing a parameter or is malformed.",
  unsupported_grant_type: "Only authorization_code and refresh_token are supported.",
  unauthorized_client: "This client is not registered for this grant type.",
  invalid_scope: "Only portfolio:read and memory may be requested.",
  invalid_target: "The requested resource is not served by this gateway.",
};

const defaultLog = (e: GatewayLogEvent) => console.info(JSON.stringify(e));

function noStore(_req: Request, res: Response, next: NextFunction) {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  next();
}

function hostOf(value: string | undefined): string {
  if (!value) return "unknown";
  try {
    return new URL(value).host || "unknown";
  } catch {
    return "unknown";
  }
}

function clientHost(c: ResolvedClient): string {
  return hostOf(c.kind === "cimd" ? c.clientKey : c.redirectUris[0]);
}

/** Only string parameters are accepted; duplicates (arrays) or objects make the request malformed. */
function readParams(body: unknown): Record<string, string> | null {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (typeof v !== "string") return null;
    out[k] = v;
  }
  return out;
}

const present = (v: string | undefined): v is string => typeof v === "string" && v !== "";

function hashEqual(secret: string, storedHash: string): boolean {
  const a = Buffer.from(sha256(secret), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function tokenRouter(o: {
  store: GatewayStore;
  clients: ClientRegistry;
  tokens: GatewayTokenService;
  resource: string;
  now?: () => Date;
  log?: (e: GatewayLogEvent) => void;
}): express.Router {
  const router = express.Router();
  const now = o.now ?? (() => new Date());
  const log = o.log ?? defaultLog;

  const fail = (res: Response, event: string, host: string, error: OAuthError, result: string = error) => {
    log({ event, clientHost: host, result });
    return res.status(error === "invalid_client" ? 401 : 400).json({ error, error_description: DESCRIPTIONS[error] });
  };

  const parseErrors =
    (event: string, error: string) => (err: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (!err) return next();
      const tooLarge = (err as { status?: number }).status === 413;
      log({ event, clientHost: "unknown", result: tooLarge ? "too_large" : "bad_body" });
      return res.status(tooLarge ? 413 : 400).json({
        error,
        error_description: tooLarge ? "The request body is too large." : "The request body could not be parsed.",
      });
    };

  const form = express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 20 });
  const json8k = express.json({ limit: "8kb" });

  async function authenticate(p: Record<string, string>): Promise<ResolvedClient | null> {
    const id = p.client_id;
    if (!present(id)) return null;
    let client: ResolvedClient | null;
    try {
      client = await o.clients.resolve(id);
    } catch {
      client = null;
    }
    if (!client || client.clientKey !== id) return null;
    if (client.tokenEndpointAuthMethod === "none") return present(p.client_secret) ? null : client;
    if (!present(p.client_secret) || !client.clientSecretHash) return null;
    return hashEqual(p.client_secret, client.clientSecretHash) ? client : null;
  }

  const allowsRefresh = (c: ResolvedClient) => c.grantTypes.includes("refresh_token");

  async function issue(
    res: Response,
    client: ResolvedClient,
    g: { subject: string; scope: string; familyId: string; parentHash: string | null; familyExpiresAt: Date; at: Date },
  ) {
    const event = "gateway_token";
    const host = clientHost(client);
    // Minted first: the family check below then always happens after the token's issue time.
    const access = await o.tokens.issueAccess({ subject: g.subject, clientKey: client.clientKey, scope: g.scope });
    let refresh: string | null = null;
    if (allowsRefresh(client)) {
      refresh = randomToken(32);
      const row: RefreshToken = {
        tokenHash: sha256(refresh),
        familyId: g.familyId,
        clientKey: client.clientKey,
        subject: g.subject,
        scope: g.scope,
        resource: o.resource,
        parentHash: g.parentHash,
        expiresAt: new Date(Math.min(g.at.getTime() + REFRESH_TTL_MS, g.familyExpiresAt.getTime())),
        familyExpiresAt: g.familyExpiresAt,
        rotatedAt: null,
        revokedAt: null,
      };
      if ((await o.store.createRefresh(row)) === "revoked") return fail(res, event, host, "invalid_grant", "family_revoked");
    } else if (await o.store.isFamilyRevoked(g.familyId)) {
      return fail(res, event, host, "invalid_grant", "family_revoked");
    }
    if (client.kind === "dcr") {
      // Best effort: bookkeeping must never fail an exchange whose code is already consumed.
      await o.store.touchClient(client.clientKey, g.at).catch(() => log({ event, clientHost: host, result: "touch_failed" }));
    }
    log({ event, clientHost: host, result: "issued" });
    return res.status(200).json({
      access_token: access.token,
      token_type: "Bearer",
      expires_in: access.expiresIn,
      ...(refresh ? { refresh_token: refresh } : {}),
      scope: g.scope,
    });
  }

  async function authorizationCode(res: Response, client: ResolvedClient, p: Record<string, string>) {
    const event = "gateway_token";
    const host = clientHost(client);
    if (!present(p.code) || !present(p.redirect_uri) || !present(p.code_verifier)) {
      return fail(res, event, host, "invalid_request");
    }
    if (!scopeParamOk(p.scope)) return fail(res, event, host, "invalid_scope");
    if (p.resource !== undefined && p.resource !== o.resource) return fail(res, event, host, "invalid_target");
    const at = now();
    const code = await o.store.consumeCode(sha256(p.code), at);
    if (!code) return fail(res, event, host, "invalid_grant", "unknown_code");
    if ("used" in code) {
      // Only the code's own client, close to issuance (host retries), triggers revocation:
      // a leaked old code must not let anyone end the user's session.
      const inWindow = at.getTime() <= code.expiresAt.getTime() + CODE_REUSE_REVOKE_GRACE_MS;
      if (code.clientKey !== client.clientKey || !inWindow) {
        return fail(res, event, host, "invalid_grant", "code_reused_ignored");
      }
      await o.store.revokeFamily(code.familyId, at);
      return fail(res, event, host, "invalid_grant", "code_reused");
    }
    if (code.expiresAt.getTime() <= at.getTime()) return fail(res, event, host, "invalid_grant", "code_expired");
    if (code.clientKey !== client.clientKey) return fail(res, event, host, "invalid_grant", "client_mismatch");
    if (code.redirectUri !== p.redirect_uri) return fail(res, event, host, "invalid_grant", "redirect_mismatch");
    if (!verifyPkceS256(p.code_verifier, code.codeChallenge)) return fail(res, event, host, "invalid_grant", "pkce_failed");
    if (code.resource !== o.resource) return fail(res, event, host, "invalid_grant", "wrong_resource");
    if (!isGrantedScope(code.scope)) return fail(res, event, host, "invalid_grant", "wrong_scope");
    return issue(res, client, {
      subject: code.subject,
      scope: code.scope,
      familyId: code.familyId,
      parentHash: null,
      familyExpiresAt: new Date(at.getTime() + FAMILY_TTL_MS),
      at,
    });
  }

  async function refreshToken(res: Response, client: ResolvedClient, p: Record<string, string>) {
    const event = "gateway_token";
    const host = clientHost(client);
    if (!allowsRefresh(client)) return fail(res, event, host, "unauthorized_client");
    if (!present(p.refresh_token)) return fail(res, event, host, "invalid_request");
    if (!scopeParamOk(p.scope)) return fail(res, event, host, "invalid_scope");
    if (p.resource !== undefined && p.resource !== o.resource) return fail(res, event, host, "invalid_target");
    const hash = sha256(p.refresh_token);
    // Checked before rotation so a token presented by another client is not burned.
    const existing = await o.store.getRefresh(hash);
    if (!existing) return fail(res, event, host, "invalid_grant", "unknown_refresh");
    if (existing.clientKey !== client.clientKey) return fail(res, event, host, "invalid_grant", "client_mismatch");
    const at = now();
    // Spec §4.7: the user's grant must still exist; without it the whole family ends.
    if (!(await o.store.hasConsent(existing.subject, existing.clientKey))) {
      await o.store.revokeFamily(existing.familyId, at);
      return fail(res, event, host, "invalid_grant", "consent_missing");
    }
    const row = await o.store.rotateRefresh(hash, at);
    if (!row) return fail(res, event, host, "invalid_grant", "revoked");
    if ("reused" in row) {
      await o.store.revokeFamily(row.familyId, at);
      return fail(res, event, host, "invalid_grant", "refresh_reused");
    }
    if (row.clientKey !== client.clientKey) return fail(res, event, host, "invalid_grant", "client_mismatch");
    if (row.familyExpiresAt.getTime() <= at.getTime()) return fail(res, event, host, "invalid_grant", "family_expired");
    if (row.expiresAt.getTime() <= at.getTime()) return fail(res, event, host, "invalid_grant", "refresh_expired");
    if (row.resource !== o.resource) return fail(res, event, host, "invalid_grant", "wrong_resource");
    // The family keeps the scope it was created with (never escalated by refresh).
    if (!isGrantedScope(row.scope)) return fail(res, event, host, "invalid_grant", "wrong_scope");
    return issue(res, client, {
      subject: row.subject,
      scope: row.scope,
      familyId: row.familyId,
      parentHash: hash,
      familyExpiresAt: row.familyExpiresAt,
      at,
    });
  }

  // One per-IP budget for /token and /revoke: both are unauthenticated entry points.
  const grantLimiter = new SlidingWindowLimiter([{ ms: 60_000, max: TOKEN_PER_IP_PER_MINUTE }]);
  const rateLimited = (event: string) => (req: Request, res: Response, next: NextFunction) => {
    const key = sha256(rateLimitKeyForIp(req.ip ?? req.socket.remoteAddress ?? "")).slice(0, 32);
    if (grantLimiter.take(key, now().getTime())) return next();
    log({ event, clientHost: "unknown", result: "rate_limited" });
    res.set("Retry-After", "60");
    return res.status(429).json({ error: "temporarily_unavailable", error_description: "Too many requests; try again later." });
  };

  /**
   * The grant (code or refresh row, by hash) is looked up before the client is
   * resolved, so a bogus grant never triggers a CIMD fetch or cache write, and
   * only a client_id equal to the grant's own client is ever resolved.
   */
  router.post("/token", noStore, rateLimited("gateway_token"), form, json8k, parseErrors("gateway_token", "invalid_request"), async (req: Request, res: Response, next: NextFunction) => {
    const event = "gateway_token";
    try {
      const p = readParams(req.body);
      if (!p) return fail(res, event, "unknown", "invalid_request");
      if (!present(p.client_id)) return fail(res, event, "unknown", "invalid_client");
      if (!present(p.grant_type)) return fail(res, event, "unknown", "invalid_request");
      let grantClientKey: string;
      if (p.grant_type === "authorization_code") {
        if (!present(p.code)) return fail(res, event, "unknown", "invalid_request");
        const code = await o.store.getCode(sha256(p.code));
        if (!code) return fail(res, event, "unknown", "invalid_grant", "unknown_code");
        grantClientKey = code.clientKey;
      } else if (p.grant_type === "refresh_token") {
        if (!present(p.refresh_token)) return fail(res, event, "unknown", "invalid_request");
        const row = await o.store.getRefresh(sha256(p.refresh_token));
        if (!row) return fail(res, event, "unknown", "invalid_grant", "unknown_refresh");
        grantClientKey = row.clientKey;
      } else {
        return fail(res, event, "unknown", "unsupported_grant_type");
      }
      if (grantClientKey !== p.client_id) return fail(res, event, "unknown", "invalid_grant", "client_mismatch");
      const client = await authenticate(p);
      if (!client) return fail(res, event, "unknown", "invalid_client");
      if (p.grant_type === "authorization_code") return await authorizationCode(res, client, p);
      return await refreshToken(res, client, p);
    } catch (e) {
      return next(e);
    }
  });

  /** RFC 7009: revokes a refresh token's family. 200 for unknown or other clients' tokens, without resolving the client. */
  router.post("/revoke", noStore, rateLimited("gateway_revoke"), form, json8k, parseErrors("gateway_revoke", "invalid_request"), async (req: Request, res: Response, next: NextFunction) => {
    const event = "gateway_revoke";
    try {
      const p = readParams(req.body);
      if (!p) return fail(res, event, "unknown", "invalid_request");
      if (!present(p.client_id)) return fail(res, event, "unknown", "invalid_client");
      if (!present(p.token)) return fail(res, event, "unknown", "invalid_request");
      const row = await o.store.getRefresh(sha256(p.token));
      if (!row || row.clientKey !== p.client_id) {
        log({ event, clientHost: "unknown", result: "ignored" });
        return res.status(200).end();
      }
      const client = await authenticate(p);
      if (!client) return fail(res, event, "unknown", "invalid_client");
      await o.store.revokeFamily(row.familyId, now());
      log({ event, clientHost: clientHost(client), result: "revoked" });
      return res.status(200).end();
    } catch (e) {
      return next(e);
    }
  });

  router.post(
    "/register",
    noStore,
    express.json({ limit: "16kb" }),
    parseErrors("gateway_register", "invalid_client_metadata"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const ip = req.ip ?? req.socket.remoteAddress ?? "";
        const ipHash = sha256(rateLimitKeyForIp(ip)).slice(0, 32);
        const prefix = rateLimitPrefixKeyForIp(ip);
        const out = await o.clients.register(req.body, ipHash, prefix === null ? null : sha256(prefix).slice(0, 32));
        const redirect = (out.body as { redirect_uris?: unknown }).redirect_uris;
        const host = out.status === 201 && Array.isArray(redirect) ? hostOf(String(redirect[0])) : "unknown";
        log({ event: "gateway_register", clientHost: host, result: out.status === 201 ? "registered" : out.body.error as string });
        return res.status(out.status).json(out.body);
      } catch (e) {
        return next(e);
      }
    },
  );

  // JSON server_error for anything unexpected; never the message or stack (they may hold values).
  router.use(
    ["/token", "/revoke", "/register"],
    (_err: unknown, req: Request, res: Response, _next: NextFunction) => {
      const event = req.baseUrl.endsWith("/revoke")
        ? "gateway_revoke"
        : req.baseUrl.endsWith("/register")
          ? "gateway_register"
          : "gateway_token";
      log({ event, clientHost: "unknown", result: "server_error" });
      if (res.headersSent) return res.end();
      res.set("Cache-Control", "no-store");
      res.set("Pragma", "no-cache");
      return res.status(500).json({ error: "server_error" });
    },
  );

  return router;
}
