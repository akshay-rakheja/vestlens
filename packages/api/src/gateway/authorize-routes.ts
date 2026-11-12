/**
 * GET /authorize and GET /oauth/upstream/callback for the MCP sign-in gateway.
 *
 * /authorize validates the host's request (client, redirect, PKCE, scope,
 * resource), stores a pending authorization and sends the browser to the owner sign-in
 * (the upstream) with our own state, nonce and PKCE. The callback exchanges the upstream code,
 * binds the verified subject to the pending authorization and hands over to
 * /oauth/consent (Task 5).
 *
 * Until the redirect_uri is validated, failures are an HTML error page and
 * never a redirect (no open redirector). Pre-interaction errors after that
 * (state, response_type, PKCE, scope, resource) are redirected only to
 * verified-host CIMD clients; any other client gets the error page, since
 * anyone can DCR-register a redirect URI. Every host redirect carries RFC 9207
 * `iss`. A new authorization grants `portfolio:read memory`; the request may
 * name memory and add openid/offline_access/email/profile to portfolio:read,
 * which are dropped (scope.ts).
 *
 * Browser binding (RFC 9700 §4.7): /authorize sets `__Host-gw_pa`, whose
 * SHA-256 is stored on the pending. The callback (and Task 5 consent) require
 * it. One cookie per browser: a second /authorize in the same browser
 * overwrites it, so the earlier flow then fails safely with the error page.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import express, { type Request, type Response } from "express";

import type { ClientRegistry, ResolvedClient } from "./clients.js";
import { RATE_LIMIT_MAX_KEYS } from "./clients.js";
import { renderBrandedMessage } from "./consent-page.js";
import { readCookies } from "./cookies.js";
import { randomToken, sha256 } from "./crypto.js";
import { rateLimitKeyForIp } from "./ip.js";
import { redirectUriAllowed } from "./redirects.js";
import { GRANTED_SCOPES, normalizeScope } from "./scope.js";
import type { GatewayStore, PendingAuthorization } from "./store.js";
import { UpstreamUnavailableError, type UpstreamIdp } from "./upstream.js";

export const PENDING_TTL_MS = 10 * 60 * 1000;
export const BROWSER_BINDING_COOKIE = "__Host-gw_pa";
export const AUTHORIZE_PER_IP_PER_MINUTE = 20;
export const AUTHORIZE_PER_IP_PER_HOUR = 200;
export const DEFAULT_MAX_LIVE_PENDINGS = 10_000;
const PENDING_SWEEP_INTERVAL_MS = 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
export { GATEWAY_SCOPE, GRANTED_SCOPES } from "./scope.js";
const MAX_STATE_LENGTH = 2048;
const MAX_PARAM_LENGTH = 4096;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type GatewayLogEvent = { event: string; clientHost: string; result: string };

const defaultLog = (e: GatewayLogEvent) => console.info(JSON.stringify(e));

const MESSAGES = {
  unverified: "This app couldn't be verified.",
  badRequest: "This sign-in request isn't valid. Return to the app and try again.",
  expired: "This sign-in link has expired or was already used. Return to the app and try again.",
  unavailable: "Sign-in is temporarily unavailable.",
  tooMany: "Too many sign-in attempts. Wait a minute and try again.",
} as const;

/**
 * True when the request carries exactly one `__Host-gw_pa` cookie whose
 * SHA-256 equals `pending.browserBindingHash` (constant-time compare).
 * Task 5 consent GET/POST must require this too.
 */
export function checkBrowserBinding(req: Request, pending: Pick<PendingAuthorization, "browserBindingHash">): boolean {
  const values = readCookies(req, BROWSER_BINDING_COOKIE);
  if (values.length !== 1 || values[0] === "") return false;
  const actual = Buffer.from(sha256(values[0]!));
  const expected = Buffer.from(typeof pending.browserBindingHash === "string" ? pending.browserBindingHash : "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function setBindingCookie(res: Response, value: string) {
  res.append(
    "Set-Cookie",
    `${BROWSER_BINDING_COOKIE}=${value}; Max-Age=${PENDING_TTL_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
}

/** Per-IP sliding window (20/min, 200/h), in memory, LRU-capped. */
class AuthorizeRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweepMs = Number.NEGATIVE_INFINITY;

  take(key: string, nowMs: number): boolean {
    const hourCutoff = nowMs - HOUR_MS;
    if (nowMs - this.lastSweepMs >= MINUTE_MS) {
      this.lastSweepMs = nowMs;
      for (const [k, ts] of this.hits) if (!ts.some((t) => t > hourCutoff)) this.hits.delete(k);
    }
    const recent = (this.hits.get(key) ?? []).filter((t) => t > hourCutoff);
    this.hits.delete(key);
    const lastMinute = recent.filter((t) => t > nowMs - MINUTE_MS).length;
    const allowed = lastMinute < AUTHORIZE_PER_IP_PER_MINUTE && recent.length < AUTHORIZE_PER_IP_PER_HOUR;
    if (allowed) recent.push(nowMs);
    while (this.hits.size >= RATE_LIMIT_MAX_KEYS) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
    this.hits.set(key, recent);
    return allowed;
  }
}

function noStore(res: Response) {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  res.set("Referrer-Policy", "no-referrer");
}

export function sendErrorPage(res: Response, status: number, message: string) {
  noStore(res);
  res.set("X-Frame-Options", "DENY");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res
    .status(status)
    .type("html")
    .send(renderBrandedMessage("Sign-in problem", message));
}

/**
 * Appends error params to the host redirect URI, preserving its existing query.
 * `iss` (RFC 9207) lets the host detect a mix-up with another authorization server.
 */
function redirectWithError(
  res: Response,
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
  issuer: string,
) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state !== null) url.searchParams.set("state", state);
  url.searchParams.set("iss", issuer);
  noStore(res);
  res.redirect(302, url.href);
}

/** Single-valued query param: undefined if absent, null if repeated or not a plain string. */
function single(req: Request, name: string): string | undefined | null {
  const v = (req.query as Record<string, unknown>)[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length > MAX_PARAM_LENGTH) return null;
  return v;
}

function hostOf(value: string): string {
  try {
    return new URL(value).host || "unknown";
  } catch {
    return "unknown";
  }
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function authorizeRouter(o: {
  store: GatewayStore;
  clients: ClientRegistry;
  upstream: UpstreamIdp;
  issuer: string;
  resource: string;
  now?: () => Date;
  log?: (e: GatewayLogEvent) => void;
  maxLivePendings?: number;
}): express.Router {
  const router = express.Router();
  const now = o.now ?? (() => new Date());
  const log = o.log ?? defaultLog;
  const issuer = o.issuer.replace(/\/+$/, "");
  const callbackUri = `${issuer}/oauth/upstream/callback`;
  const maxLivePendings = o.maxLivePendings ?? DEFAULT_MAX_LIVE_PENDINGS;
  const limiter = new AuthorizeRateLimiter();
  let lastPendingSweepMs = Number.NEGATIVE_INFINITY;

  router.get("/authorize", async (req, res, next) => {
    try {
      const ipKey = sha256(rateLimitKeyForIp(req.ip ?? req.socket.remoteAddress ?? "")).slice(0, 32);
      if (!limiter.take(ipKey, now().getTime())) {
        log({ event: "gateway_authorize", clientHost: "unknown", result: "rate_limited" });
        return sendErrorPage(res, 429, MESSAGES.tooMany);
      }

      const clientId = single(req, "client_id");
      let client: ResolvedClient | null = null;
      if (typeof clientId === "string" && clientId !== "") {
        try {
          client = await o.clients.resolve(clientId);
        } catch {
          client = null;
        }
      }
      if (!client) {
        log({ event: "gateway_authorize", clientHost: "unknown", result: "invalid_client" });
        return sendErrorPage(res, 400, MESSAGES.unverified);
      }

      const redirectUri = single(req, "redirect_uri");
      const clientHost = client.kind === "cimd" ? hostOf(client.clientKey) : "unknown";
      if (typeof redirectUri !== "string" || !redirectUriAllowed(client.redirectUris, redirectUri)) {
        log({ event: "gateway_authorize", clientHost, result: "invalid_redirect_uri" });
        return sendErrorPage(res, 400, MESSAGES.badRequest);
      }

      const redirectHost = hostOf(redirectUri);
      const rawState = single(req, "state");
      const state = typeof rawState === "string" && rawState !== "" && rawState.length <= MAX_STATE_LENGTH ? rawState : null;
      // Pre-interaction errors redirect only to verified-host CIMD clients; for
      // anyone else (any DCR registration) a redirect here would make this
      // origin an open redirector (RFC 9700 §4.11.2), so they get the page.
      const mayRedirectErrors = client.verifiedHost;
      const fail = (error: string, description: string) => {
        log({ event: "gateway_authorize", clientHost: redirectHost, result: error });
        if (!mayRedirectErrors) return sendErrorPage(res, 400, MESSAGES.badRequest);
        redirectWithError(res, redirectUri, error, description, state, issuer);
      };

      if (rawState === null || (typeof rawState === "string" && rawState.length > MAX_STATE_LENGTH)) {
        return fail("invalid_request", "state is invalid.");
      }

      const responseType = single(req, "response_type");
      if (responseType === undefined || responseType === null || responseType === "") {
        return fail("invalid_request", "response_type is required.");
      }
      if (responseType !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");

      const challenge = single(req, "code_challenge");
      const method = single(req, "code_challenge_method");
      if (method !== "S256" || typeof challenge !== "string" || !CHALLENGE_PATTERN.test(challenge)) {
        return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
      }

      const scope = single(req, "scope");
      if (scope === null || normalizeScope(scope) === null) {
        return fail("invalid_scope", "Only the portfolio:read and memory scopes are available.");
      }

      const resource = single(req, "resource");
      if (resource === null || (resource !== undefined && resource !== o.resource)) {
        return fail("invalid_target", "Unknown resource.");
      }

      const nowDate = now();
      if (nowDate.getTime() - lastPendingSweepMs >= PENDING_SWEEP_INTERVAL_MS) {
        lastPendingSweepMs = nowDate.getTime();
        await o.store.deleteExpiredPendings(nowDate);
      }
      if ((await o.store.countLivePendings(nowDate)) >= maxLivePendings) {
        log({ event: "gateway_authorize", clientHost: redirectHost, result: "pending_cap" });
        return sendErrorPage(res, 503, MESSAGES.unavailable);
      }

      const upstreamVerifier = randomToken(32);
      const binding = randomToken(32);
      const pending: PendingAuthorization = {
        id: randomToken(32),
        clientKey: client.clientKey,
        redirectUri,
        state,
        codeChallenge: challenge,
        scope: GRANTED_SCOPES,
        resource: o.resource,
        upstreamState: randomToken(32),
        upstreamNonce: randomToken(32),
        upstreamVerifier,
        subject: null,
        consentCsrf: null,
        browserBindingHash: sha256(binding),
        upstreamClaimedAt: null,
        expiresAt: new Date(nowDate.getTime() + PENDING_TTL_MS),
      };
      await o.store.createPending(pending);

      const location = o.upstream.authorizeUrl({
        state: pending.upstreamState,
        nonce: pending.upstreamNonce,
        codeChallenge: s256(upstreamVerifier),
        redirectUri: callbackUri,
      });
      log({ event: "gateway_authorize", clientHost: redirectHost, result: "redirect_upstream" });
      noStore(res);
      setBindingCookie(res, binding);
      return res.redirect(302, location);
    } catch (e) {
      return next(e);
    }
  });

  router.get("/oauth/upstream/callback", async (req, res, next) => {
    const event = "gateway_upstream_callback";
    try {
      const upstreamState = single(req, "state");
      const pending = typeof upstreamState === "string" && upstreamState !== ""
        ? await o.store.getPendingByUpstreamState(upstreamState)
        : null;
      if (!pending) {
        log({ event, clientHost: "unknown", result: "unknown_state" });
        return sendErrorPage(res, 400, MESSAGES.expired);
      }
      const clientHost = hostOf(pending.redirectUri);
      if (pending.expiresAt.getTime() <= now().getTime()) {
        await o.store.deletePending(pending.id);
        log({ event, clientHost, result: "expired" });
        return sendErrorPage(res, 400, MESSAGES.expired);
      }
      // Checked before any mutation, so a request from another browser can't burn the pending.
      if (!checkBrowserBinding(req, pending)) {
        log({ event, clientHost, result: "browser_mismatch" });
        return sendErrorPage(res, 400, MESSAGES.expired);
      }
      if (!(await o.store.claimPendingByUpstreamState(pending.upstreamState, now()))) {
        log({ event, clientHost, result: "replayed" });
        return sendErrorPage(res, 400, MESSAGES.expired);
      }

      const deny = async (result: string) => {
        await o.store.deletePending(pending.id);
        log({ event, clientHost, result });
        redirectWithError(res, pending.redirectUri, "access_denied", "Sign-in was not completed.", pending.state, issuer);
      };

      if (single(req, "error") !== undefined) return deny("upstream_error");

      const code = single(req, "code");
      if (typeof code !== "string" || code === "") {
        await o.store.deletePending(pending.id);
        log({ event, clientHost, result: "missing_code" });
        return sendErrorPage(res, 400, MESSAGES.badRequest);
      }

      let identity: { subject: string; emailVerified: boolean };
      try {
        identity = await o.upstream.exchange({
          code,
          verifier: pending.upstreamVerifier,
          redirectUri: callbackUri,
          nonce: pending.upstreamNonce,
        });
      } catch (e) {
        if (e instanceof UpstreamUnavailableError) {
          await o.store.deletePending(pending.id);
          log({ event, clientHost, result: "upstream_unavailable" });
          return sendErrorPage(res, 503, MESSAGES.unavailable);
        }
        return deny("upstream_rejected");
      }
      if (!identity.emailVerified) return deny("email_unverified");

      if (!(await o.store.bindPendingSubject(pending.id, identity.subject))) {
        log({ event, clientHost, result: "pending_gone" });
        return sendErrorPage(res, 400, MESSAGES.expired);
      }
      log({ event, clientHost, result: "consent" });
      noStore(res);
      return res.redirect(302, `/oauth/consent?p=${encodeURIComponent(pending.id)}`);
    } catch (e) {
      return next(e);
    }
  });

  return router;
}
