/**
 * Server-rendered consent page for the MCP sign-in gateway. Plain HTML with
 * inline styles only (the CSP allows nothing else), every interpolated value
 * HTML-escaped, no scripts and no external assets.
 */

export const CONSENT_ACCESS_COPY = "Read your portfolio: balances, holdings, activity. No trading or money movement.";
/** The `memory` scope: part of the standard grant, shown as a plain statement (never a checkbox). */
export const CONSENT_MEMORY_COPY = "Save the TFSA and FHSA room details and the limits you give it, so VestLens can check them for you.";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface ConsentPageInput {
  clientName: string;
  redirectHost: string;
  verifiedHost: boolean;
  /** Host of the CIMD client_id, shown in the verified badge. */
  clientHost: string;
  pendingId: string;
  csrf: string;
  /** A consent for this (user, client) is already stored: noted, but the click is still required. */
  approvedBefore?: boolean;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f4f7f6;--card:#fff;--fg:#14212b;--muted:#4d5c66;--line:#d5dfdd;--accent:#0e6b6b;--accent-fg:#fff;--ok:#0e6b6b;--ok-bg:#dcedea;--warn:#7a4e0e;--warn-bg:#f6ebd8}
@media (prefers-color-scheme: dark){:root{--bg:#0f1a1f;--card:#16252b;--fg:#e6eeec;--muted:#9fb0b6;--line:#2a3d44;--accent:#4fb8b0;--accent-fg:#0f1a1f;--ok:#7fd3cc;--ok-bg:#1b4243;--warn:#e2b36a;--warn-bg:#3a2d17}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:28rem;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font:700 1.3rem/1.25 "Avenir Next","Segoe UI",system-ui,sans-serif;letter-spacing:-.01em;margin:0 0 4px}
.brand{display:flex;align-items:center;gap:8px;margin:0 0 16px;font:700 1.05rem "Avenir Next","Segoe UI",system-ui,sans-serif;color:var(--fg)}
.brand svg{flex:none}
.host{font-size:1.05rem;font-weight:600;margin:12px 0 4px;word-break:break-all}
.muted{color:var(--muted);font-size:.9rem;margin:0}
.note{margin-top:8px}
.badge{display:inline-block;font-size:.8rem;font-weight:600;padding:2px 8px;border-radius:999px;margin-top:8px}
.ok{color:var(--ok);background:var(--ok-bg)}
.warn{color:var(--warn);background:var(--warn-bg)}
.access{border-top:1px solid var(--line);margin-top:16px;padding-top:16px}
.actions{display:flex;gap:12px;margin-top:20px}
button{flex:1;font:inherit;font-weight:600;padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--fg)}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
`.replace(/\n/g, "");

/** The VestLens mark (as in the widgets' footer): inline SVG, no external assets. */
export const BRAND_HTML =
  `<p class="brand"><svg width="24" height="24" viewBox="0 0 48 48" aria-hidden="true">` +
  `<circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-width="3"/>` +
  `<circle cx="24" cy="24" r="12" fill="none" stroke="var(--accent)" stroke-width="3"/>` +
  `<polyline points="9,31 18,25 25,28 39,15" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` +
  `</svg>VestLens</p>`;

/** A small branded page (the sign-in problem page): the consent page's look, one heading and one message. */
export function renderBrandedMessage(title: string, message: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">` +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>` +
    BRAND_HTML + `<h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(message)}</p>` +
    `</main></body></html>`
  );
}

export function renderConsentPage(i: ConsentPageInput): string {
  const name = escapeHtml(i.clientName);
  const host = escapeHtml(i.redirectHost);
  const badge = i.verifiedHost
    ? `<span class="badge ok">Verified: ${escapeHtml(i.clientHost)}</span>`
    : `<span class="badge warn">Unverified app</span>`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="referrer" content="no-referrer">` +
    `<title>Allow access to your portfolio?</title><style>${STYLE}</style></head><body><main>` +
    BRAND_HTML +
    `<h1>${name} wants to access your portfolio</h1>` +
    `<p class="host">${host}</p>` +
    `<p class="muted">You'll be sent back to this site after you choose.</p>` +
    badge +
    (i.approvedBefore ? `<p class="muted note">You approved this app before.</p>` : "") +
    `<div class="access"><p>${escapeHtml(CONSENT_ACCESS_COPY)}</p><p>${escapeHtml(CONSENT_MEMORY_COPY)}</p></div>` +
    `<form method="post" action="/oauth/consent">` +
    `<input type="hidden" name="p" value="${escapeHtml(i.pendingId)}">` +
    `<input type="hidden" name="csrf" value="${escapeHtml(i.csrf)}">` +
    `<div class="actions">` +
    `<button type="submit" name="action" value="deny" formnovalidate>Deny</button>` +
    `<button type="submit" name="action" value="allow" class="primary">Allow</button>` +
    `</div></form></main></body></html>`
  );
}
