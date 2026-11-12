/**
 * GET/POST /oauth/consent for the MCP sign-in gateway (spec §4 steps 5–6).
 *
 * The upstream callback hands over with `?p=<pending id>` once the pending
 * authorization has a verified subject. The one-click consent page is shown
 * on every authorization (Ruling R3): a code is only ever issued by the POST,
 * never by a GET, so a link the user is tricked into opening cannot complete
 * a flow silently. A stored (subject, clientKey) consent only adds the note
 * "You approved this app before." A code is bound to the pending's client,
 * redirect, PKCE challenge, subject, scope and resource.
 *
 * Every request re-checks the browser binding cookie, expiry, subject, the
 * client (re-resolved: it may have been deleted or its CIMD changed) and the
 * stored redirect_uri. Those failures are an HTML error page, never a redirect,
 * and leave the pending untouched. Only after consent is decided does the host
 * get a redirect.
 *
 * CSRF: a per-pending token is stored on `pending.consentCsrf`, sent as a hidden
 * field and as the `__Host-gw_csrf` cookie. POST requires form == cookie ==
 * stored (constant-time).
 */
import { timingSafeEqual } from "node:crypto";

import express, { type NextFunction, type Request, type Response } from "express";

import { BROWSER_BINDING_COOKIE, checkBrowserBinding, sendErrorPage, type GatewayLogEvent } from "./authorize-routes.js";
import type { ClientRegistry, ResolvedClient } from "./clients.js";
import { renderConsentPage } from "./consent-page.js";
import { readCookies } from "./cookies.js";
import { randomToken, sha256 } from "./crypto.js";
import { redirectUriAllowed } from "./redirects.js";
import type { GatewayStore, PendingAuthorization } from "./store.js";

export { CONSENT_ACCESS_COPY, CONSENT_MEMORY_COPY } from "./consent-page.js";

export const CODE_TTL_MS = 60 * 1000;
export const CSRF_COOKIE = "__Host-gw_csrf";
const CSRF_COOKIE_MAX_AGE_S = 600;
const MAX_PARAM_LENGTH = 4096;
const BASE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

const MESSAGES = {
  unverified: "This app couldn't be verified.",
  badRequest: "This sign-in request isn't valid. Return to the app and try again.",
  expired: "This sign-in link has expired or was already used. Return to the app and try again.",
  forbidden: "This consent form has expired. Return to the app and try again.",
  tooLarge: "This request is too large.",
} as const;

const defaultLog = (e: GatewayLogEvent) => console.info(JSON.stringify(e));

/** Constant-time over SHA-256 digests, so differing lengths don't short-circuit. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(a), "hex"), Buffer.from(sha256(b), "hex"));
}

function csrfValid(req: Request, form: unknown, pending: PendingAuthorization): boolean {
  const stored = pending.consentCsrf;
  const cookies = readCookies(req, CSRF_COOKIE);
  if (typeof stored !== "string" || stored === "") return false;
  if (typeof form !== "string" || form === "" || cookies.length !== 1) return false;
  const cookie = cookies[0]!;
  // Evaluate both comparisons regardless of the first result.
  const formOk = safeEqual(form, stored);
  const cookieOk = safeEqual(cookie, stored);
  return formOk && cookieOk;
}

function hostOf(value: string): string {
  try {
    return new URL(value).host || "unknown";
  } catch {
    return "unknown";
  }
}

function securityHeaders(res: Response, csp: string) {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Frame-Options", "DENY");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Security-Policy", csp);
}

/** Scheme, lowercase LDH hostname and optional port: nothing that could end or extend a CSP directive. */
const CSP_SAFE_ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

/**
 * Chromium applies form-action to the redirect that follows a form submission,
 * so the consent page also allows the redirect_uri's origin. WHATWG URL
 * parsing keeps characters such as `;` in hostnames, so the origin is added
 * only when it matches CSP_SAFE_ORIGIN; otherwise the base 'self' is kept
 * (the browser may then block the post-submit redirect, which fails closed).
 */
function pageCsp(redirectUri: string): string {
  let origin: string | null = null;
  try {
    origin = new URL(redirectUri).origin;
  } catch {
    origin = null;
  }
  const formAction = origin && CSP_SAFE_ORIGIN.test(origin) ? `form-action 'self' ${origin}` : "form-action 'self'";
  return `${BASE_CSP.replace("form-action 'self'", formAction)}; base-uri 'none'`;
}

const cookieAttrs = "Path=/; HttpOnly; Secure; SameSite=Lax";

function clearFlowCookies(res: Response) {
  res.append("Set-Cookie", `${BROWSER_BINDING_COOKIE}=; Max-Age=0; ${cookieAttrs}`);
  res.append("Set-Cookie", `${CSRF_COOKIE}=; Max-Age=0; ${cookieAttrs}`);
}

/** Authorization response: params plus RFC 9207 `iss`, so the host can detect an authorization-server mix-up. */
function redirectToHost(
  res: Response,
  status: 303,
  redirectUri: string,
  issuer: string,
  params: Record<string, string | null>,
) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  url.searchParams.set("iss", issuer);
  securityHeaders(res, BASE_CSP);
  clearFlowCookies(res);
  res.redirect(status, url.href);
}

function stringParam(v: unknown): string | null {
  return typeof v === "string" && v !== "" && v.length <= MAX_PARAM_LENGTH ? v : null;
}

export function consentRouter(o: {
  store: GatewayStore;
  clients: ClientRegistry;
  /** The gateway issuer, sent as `iss` on every authorization response. */
  issuer: string;
  now?: () => Date;
  log?: (e: GatewayLogEvent) => void;
}): express.Router {
  const router = express.Router();
  const issuer = o.issuer.replace(/\/+$/, "");
  const now = o.now ?? (() => new Date());
  const log = o.log ?? defaultLog;

  type Loaded = { pending: PendingAuthorization & { subject: string }; client: ResolvedClient; clientHost: string };

  /** Shared checks. Sends the error page and returns null on failure; the pending is left untouched. */
  async function load(req: Request, res: Response, event: string, id: string | null): Promise<Loaded | null> {
    const pending = id ? await o.store.getPending(id) : null;
    if (!pending) {
      log({ event, clientHost: "unknown", result: "unknown_pending" });
      sendErrorPage(res, 400, MESSAGES.expired);
      return null;
    }
    const clientHost = hostOf(pending.redirectUri);
    const fail = (result: string, message: string) => {
      log({ event, clientHost, result });
      sendErrorPage(res, 400, message);
      return null;
    };
    if (pending.expiresAt.getTime() <= now().getTime()) return fail("expired", MESSAGES.expired);
    if (!checkBrowserBinding(req, pending)) return fail("browser_mismatch", MESSAGES.expired);
    if (typeof pending.subject !== "string" || pending.subject === "") return fail("no_subject", MESSAGES.expired);

    let client: ResolvedClient | null = null;
    try {
      client = await o.clients.resolve(pending.clientKey);
    } catch {
      client = null;
    }
    if (!client || client.clientKey !== pending.clientKey) return fail("invalid_client", MESSAGES.unverified);
    if (!redirectUriAllowed(client.redirectUris, pending.redirectUri)) {
      return fail("invalid_redirect_uri", MESSAGES.badRequest);
    }
    return { pending: pending as PendingAuthorization & { subject: string }, client, clientHost };
  }

  /** Claims the pending (single winner), stores consent, issues a code and answers 303 (the host callback is fetched with GET). */
  async function issueCode(res: Response, event: string, l: Loaded) {
    const { pending, clientHost } = l;
    if (!(await o.store.deletePending(pending.id))) {
      log({ event, clientHost, result: "pending_gone" });
      return sendErrorPage(res, 400, MESSAGES.expired);
    }
    const at = now();
    await o.store.putConsent(pending.subject, pending.clientKey, pending.scope, at);
    const code = randomToken(32);
    await o.store.createCode({
      codeHash: sha256(code),
      clientKey: pending.clientKey,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      subject: pending.subject,
      scope: pending.scope,
      resource: pending.resource,
      expiresAt: new Date(at.getTime() + CODE_TTL_MS),
      usedAt: null,
      familyId: randomToken(32),
    });
    log({ event, clientHost, result: "code_issued" });
    redirectToHost(res, 303, pending.redirectUri, issuer, { code, state: pending.state });
  }

  async function sendPage(res: Response, status: 200 | 400, l: Loaded, csrf: string) {
    const approvedBefore = await o.store.hasConsent(l.pending.subject, l.pending.clientKey);
    securityHeaders(res, pageCsp(l.pending.redirectUri));
    return res
      .status(status)
      .type("html")
      .send(
        renderConsentPage({
          clientName: l.client.name,
          redirectHost: hostOf(l.pending.redirectUri),
          verifiedHost: l.client.verifiedHost,
          clientHost: l.client.kind === "cimd" ? hostOf(l.client.clientKey) : "unknown",
          pendingId: l.pending.id,
          csrf,
          approvedBefore,
        }),
      );
  }

  router.get("/oauth/consent", async (req, res, next) => {
    const event = "gateway_consent";
    try {
      const l = await load(req, res, event, stringParam((req.query as Record<string, unknown>).p));
      if (!l) return;
      const csrf = randomToken(32);
      await o.store.updatePending(l.pending.id, { consentCsrf: csrf });
      log({ event, clientHost: l.clientHost, result: "consent_page" });
      res.append("Set-Cookie", `${CSRF_COOKIE}=${csrf}; Max-Age=${CSRF_COOKIE_MAX_AGE_S}; ${cookieAttrs}`);
      return await sendPage(res, 200, l, csrf);
    } catch (e) {
      return next(e);
    }
  });

  const urlencoded = express.urlencoded({ extended: false, limit: "4kb", parameterLimit: 10 });
  const parseForm = (req: Request, res: Response, next: NextFunction) =>
    urlencoded(req, res, (err?: unknown) => {
      if (err) {
        const status = (err as { status?: number }).status === 413 ? 413 : 400;
        log({ event: "gateway_consent_decision", clientHost: "unknown", result: status === 413 ? "too_large" : "bad_body" });
        return sendErrorPage(res, status, status === 413 ? MESSAGES.tooLarge : MESSAGES.badRequest);
      }
      next();
    });

  router.post("/oauth/consent", parseForm, async (req, res, next) => {
    const event = "gateway_consent_decision";
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const l = await load(req, res, event, stringParam(body.p));
      if (!l) return;
      if (!csrfValid(req, body.csrf, l.pending)) {
        log({ event, clientHost: l.clientHost, result: "csrf_mismatch" });
        return sendErrorPage(res, 403, MESSAGES.forbidden);
      }
      if (body.action === "allow") {
        return await issueCode(res, event, l);
      }
      if (body.action === "deny") {
        if (!(await o.store.deletePending(l.pending.id))) {
          log({ event, clientHost: l.clientHost, result: "pending_gone" });
          return sendErrorPage(res, 400, MESSAGES.expired);
        }
        log({ event, clientHost: l.clientHost, result: "denied" });
        return redirectToHost(res, 303, l.pending.redirectUri, issuer, {
          error: "access_denied",
          error_description: "The user denied access.",
          state: l.pending.state,
        });
      }
      log({ event, clientHost: l.clientHost, result: "bad_action" });
      return sendErrorPage(res, 400, MESSAGES.badRequest);
    } catch (e) {
      return next(e);
    }
  });

  return router;
}
