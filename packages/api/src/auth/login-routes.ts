import express, { type Request, type Response } from "express";
import { isSameOriginRequest } from "../http/same-origin.js";
import { SlidingWindowLimiter } from "../security/sliding-window.js";
import { verifyOwnerPassword } from "./owner-password.js";
import { OwnerSessionStore, SESSION_COOKIE, SESSION_TTL_MS } from "./owner-session.js";

const GLOBAL_WINDOW = { ms: 15 * 60_000, max: 50 };

/** Same-origin path or "/". Rejects absolute URLs, protocol-relative `//`, backslashes and control characters. */
export function safeContinue(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  // eslint-disable-next-line no-control-regex
  if (raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return "/";
  return raw;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Palette and type from packages/web/src/index.css (light and dark); system fonts only, no assets.
const STYLE = `
:root{color-scheme:light dark;--page:#f4f7f6;--surface:#fff;--ink:#14212b;--muted:#4d5c66;--line:#d5dfdd;--accent:#0e6b6b;--accent-deep:#0a5252;--on-accent:#fff;--danger:#9a2f1f;--danger-bg:#fbe9e5;--danger-line:#efc6bd}
@media (prefers-color-scheme:dark){:root{--page:#0f1a1f;--surface:#16252b;--ink:#e6eeec;--muted:#9fb0b6;--line:#2a3d44;--accent:#4fb8b0;--accent-deep:#7fd3cc;--on-accent:#0f1a1f;--danger:#f0a090;--danger-bg:#3a1f1a;--danger-line:#6b3329}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--page);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,sans-serif}
main{width:100%;max-width:380px;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:28px;box-shadow:0 24px 60px -32px rgba(20,33,43,.35)}
h1{margin:0 0 4px;font:600 1.5rem/1.2 "Bricolage Grotesque Variable","Avenir Next","Segoe UI",system-ui,sans-serif}
p{margin:0 0 20px;color:var(--muted);font-size:.9rem}
label{display:block;margin-bottom:6px;font-size:.9rem;font-weight:600}
input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--page);color:var(--ink);font:inherit}
input[type=password]:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
button{margin-top:16px;width:100%;padding:11px 14px;border:0;border-radius:10px;background:var(--accent);color:var(--on-accent);font:inherit;font-weight:600;cursor:pointer}
button:hover{background:var(--accent-deep)}
.err{margin:0 0 16px;padding:10px 12px;border:1px solid var(--danger-line);border-radius:10px;background:var(--danger-bg);color:var(--danger);font-size:.9rem}
`;

function renderLogin(next: string, failed: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Sign in - VestLens</title><style>${STYLE}</style></head>
<body><main>
<h1>VestLens</h1>
<p>This VestLens instance is private. Sign in with the owner password to continue.</p>
${failed ? `<div class="err" role="alert">That password didn&#39;t work.</div>` : ""}
<form method="post" action="/login">
<label for="password">Owner password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<input type="hidden" name="continue" value="${escapeHtml(next)}">
<button type="submit">Sign in</button>
</form>
</main></body></html>`;
}

function sendPage(res: Response, status: number, html: string): void {
  res.set({
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    // same-origin, not no-referrer: under no-referrer a browser posts the form with `Origin: null`, which the
    // same-origin check (rightly) refuses. This page's URL carries only a local `continue` path, no secret.
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    // Inline <style> only; no scripts, images, fonts or connections.
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.status(status).type("html").send(html);
}

function cookieHeader(value: string, maxAgeSec: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Max-Age=${maxAgeSec}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Sets the owner session cookie (30 days). Call again on authenticated requests to slide the browser expiry. */
export function setSessionCookie(res: Pick<Response, "append">, token: string, o: { secure: boolean }): void {
  res.append("Set-Cookie", cookieHeader(token, SESSION_TTL_MS / 1000, o.secure));
}

export function clearSessionCookie(res: Pick<Response, "append">, o: { secure: boolean }): void {
  res.append("Set-Cookie", cookieHeader("", 0, o.secure));
}

function refuseCrossSite(res: Response): void {
  res.set("Cache-Control", "no-store");
  res.status(403).type("text/plain").send("Cross-site request refused.");
}

function readSessionCookie(req: Request): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim();
  }
  return "";
}

/**
 * `limiter` is the per-IP budget (10 per 15 minutes in production). A global 50 per 15 minutes budget is held
 * here. Every attempt counts, not only failures; an over-budget attempt is refused before the password is checked.
 */
export function loginRouter(o: {
  sessions: OwnerSessionStore;
  passwordHash: string;
  limiter: SlidingWindowLimiter;
  secureCookies: boolean;
  /** `new URL(APP_BASE_URL).origin`: the only Origin a sign-in or sign-out post may carry. */
  expectedOrigin: string;
}): express.Router {
  const router = express.Router();
  const global = new SlidingWindowLimiter([GLOBAL_WINDOW]);
  const form = express.urlencoded({ extended: false, limit: "4kb", parameterLimit: 10 });

  router.get("/login", (req, res) => {
    sendPage(res, 200, renderLogin(safeContinue(req.query.continue), false));
  });

  router.post("/login", form, async (req, res) => {
    if (!isSameOriginRequest(req, o.expectedOrigin)) return refuseCrossSite(res);
    const now = Date.now();
    const ip = req.ip ?? "unknown";
    if (!o.limiter.take(ip, now) || !global.take("global", now)) {
      res.set({ "Cache-Control": "no-store", "Retry-After": "900" });
      res.status(429).type("text/plain").send("Too many sign-in attempts. Try again later.");
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const next = safeContinue(body.continue);
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length === 0 || password.length > 1024 || !(await verifyOwnerPassword(password, o.passwordHash))) {
      sendPage(res, 401, renderLogin(next, true));
      return;
    }
    const { token } = await o.sessions.create();
    res.set("Cache-Control", "no-store");
    setSessionCookie(res, token, { secure: o.secureCookies });
    res.redirect(303, next);
  });

  router.post("/logout", async (req, res) => {
    if (!isSameOriginRequest(req, o.expectedOrigin)) return refuseCrossSite(res);
    const token = readSessionCookie(req);
    if (token) await o.sessions.revoke(token);
    res.set("Cache-Control", "no-store");
    clearSessionCookie(res, { secure: o.secureCookies });
    res.redirect(303, "/login");
  });

  return router;
}
