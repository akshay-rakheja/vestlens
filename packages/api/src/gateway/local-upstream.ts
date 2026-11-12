/**
 * The gateway's upstream for a single-owner instance: "is the owner signed in?" instead of an external IdP.
 *
 * `authorizeUrl` points at our own `/oauth/local/authorize`. A browser with a valid owner session (the `vl_session`
 * cookie) gets a one-time code and goes straight back to the gateway's callback; any other browser is sent to
 * `/login`, which returns it here. `exchange` spends the code and answers with the fixed owner subject.
 *
 * Codes live in memory only (32 random bytes, 5 minutes, one use, bound to the PKCE challenge, nonce and
 * redirect URI). A restart drops them; the sign-in then simply starts over.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import express, { type Request } from "express";

import { OwnerSessionStore, SESSION_COOKIE } from "../auth/owner-session.js";
import { OWNER_SUBJECT } from "../identity/owner-identity.js";
import { sendErrorPage } from "./authorize-routes.js";
import { readCookies } from "./cookies.js";
import { verifyPkceS256 } from "./crypto.js";
import type { UpstreamIdp } from "./upstream.js";

export const LOCAL_AUTHORIZE_PATH = "/oauth/local/authorize";
export const LOCAL_CODE_TTL_MS = 5 * 60 * 1000;
/** Bounds memory if something floods the endpoint with signed-in requests. */
const MAX_LIVE_CODES = 1_000;
const MAX_PARAM_LENGTH = 512;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface IssuedCode {
  challenge: string;
  nonce: string;
  redirectUri: string;
  expiresAtMs: number;
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The raw query, parsed without qs's bracket handling: `state=a&state[]=b` must not read as plain `state=a`. */
function rawQuery(req: Request): URLSearchParams | null {
  const params = new URLSearchParams(req.originalUrl.split("?")[1] ?? "");
  for (const key of params.keys()) if (/[[\]]/.test(key)) return null;
  return params;
}

function singleParam(params: URLSearchParams, name: string): string | null {
  const all = params.getAll(name);
  const v = all[0];
  return all.length === 1 && v !== undefined && v.length > 0 && v.length <= MAX_PARAM_LENGTH ? v : null;
}

export function localOwnerUpstream(o: {
  sessions: OwnerSessionStore;
  /** The gateway's issuer origin; its `/oauth/upstream/callback` is the only redirect_uri accepted. */
  issuer: string;
  now?: () => Date;
}): { upstream: UpstreamIdp; router: express.Router } {
  const now = o.now ?? (() => new Date());
  const callbackUri = `${o.issuer.replace(/\/+$/, "")}/oauth/upstream/callback`;
  const codes = new Map<string, IssuedCode>();

  const sweep = () => {
    const t = now().getTime();
    for (const [code, entry] of codes) if (entry.expiresAtMs <= t) codes.delete(code);
  };

  const upstream: UpstreamIdp = {
    authorizeUrl(p) {
      const q = new URLSearchParams({
        state: p.state,
        nonce: p.nonce,
        code_challenge: p.codeChallenge,
        redirect_uri: p.redirectUri,
      });
      return `${LOCAL_AUTHORIZE_PATH}?${q.toString()}`;
    },

    async exchange(p) {
      sweep();
      const entry = codes.get(p.code);
      // Spent on the first attempt, right or wrong.
      codes.delete(p.code);
      if (
        !entry ||
        entry.expiresAtMs <= now().getTime() ||
        !verifyPkceS256(p.verifier, entry.challenge) ||
        !sameString(p.nonce, entry.nonce) ||
        !sameString(p.redirectUri, entry.redirectUri)
      ) {
        throw new Error("invalid_grant");
      }
      return { subject: OWNER_SUBJECT, emailVerified: true };
    },
  };

  const router = express.Router();
  router.get(LOCAL_AUTHORIZE_PATH, async (req, res) => {
    res.set("Cache-Control", "no-store");
    // The code carries a one-time credential in a redirect: keep the URL out of any Referer.
    res.set("Referrer-Policy", "no-referrer");
    const params = rawQuery(req);
    if (params === null) return sendErrorPage(res, 400, "This sign-in link is not valid.");
    const redirectUri = singleParam(params, "redirect_uri");
    const state = singleParam(params, "state");
    const nonce = singleParam(params, "nonce");
    const challenge = singleParam(params, "code_challenge");
    if (redirectUri === null || !sameString(redirectUri, callbackUri)) {
      return sendErrorPage(res, 400, "This sign-in link is not valid.");
    }
    if (state === null || nonce === null || challenge === null || !CHALLENGE_PATTERN.test(challenge)) {
      return sendErrorPage(res, 400, "This sign-in link is not valid.");
    }

    let signedIn = false;
    const cookies = readCookies(req, SESSION_COOKIE);
    if (cookies.length === 1) {
      try {
        signedIn = await o.sessions.resolve(cookies[0]!);
      } catch {
        return sendErrorPage(res, 503, "Sign-in is temporarily unavailable.");
      }
    }
    if (!signedIn) {
      // originalUrl is this request's own path and query: a same-origin path that safeContinue accepts.
      return res.redirect(302, `/login?continue=${encodeURIComponent(req.originalUrl)}`);
    }

    sweep();
    if (codes.size >= MAX_LIVE_CODES) return sendErrorPage(res, 503, "Sign-in is temporarily unavailable.");
    const code = randomBytes(32).toString("base64url");
    codes.set(code, { challenge, nonce, redirectUri, expiresAtMs: now().getTime() + LOCAL_CODE_TTL_MS });
    const back = new URL(callbackUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", state);
    return res.redirect(302, back.href);
  });

  return { upstream, router };
}
