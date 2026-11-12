import { useEffect, useState } from "react";

/** Window event apiFetch raises on a 401, so the session hook can move to signedOut and the app can redirect. */
const SESSION_EXPIRED_EVENT = "vestlens:session-expired";

export type OwnerSessionStatus = "loading" | "signedIn" | "signedOut";

/**
 * A same-origin API call on the owner's session cookie. No Authorization header is ever sent. A 401 means the
 * session ended: the response is still returned, and every mounted `useOwnerSession` moves to signedOut.
 * Writes carry the browser's own Origin header, which the server checks.
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = (input, options) => fetch(input, options),
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  const response = await fetchImpl(path, { ...init, headers, credentials: "same-origin" });
  if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  return response;
}

/**
 * Asks `GET /api/session` whether the owner is signed in. Only an explicit `{ signedIn: false }` means signedOut.
 * If the check itself fails (network, 5xx) the status is signedIn: the data calls that follow show their own
 * retryable error, and a failing check can never bounce the browser between the app and the sign-in page.
 */
export function useOwnerSession(): { status: OwnerSessionStatus } {
  const [status, setStatus] = useState<OwnerSessionStatus>("loading");
  useEffect(() => {
    let active = true;
    const expired = () => { if (active) setStatus("signedOut"); };
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    fetch("/api/session", { credentials: "same-origin", cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<{ signedIn?: unknown }>) : null))
      .then((body) => { if (active) setStatus(body?.signedIn === false ? "signedOut" : "signedIn"); })
      .catch(() => { if (active) setStatus("signedIn"); });
    return () => { active = false; window.removeEventListener(SESSION_EXPIRED_EVENT, expired); };
  }, []);
  return { status };
}

/** Sends the browser to the sign-in page, which returns here (same path and query) afterwards. */
export function signIn(): void {
  const here = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?continue=${encodeURIComponent(here)}`);
}

/** Ends the session on the server, then shows the sign-in page. */
export async function signOut(): Promise<void> {
  try {
    await fetch("/logout", { method: "POST", credentials: "same-origin", redirect: "manual" });
  } catch {
    // Even if the request failed, leave the dashboard; the next call shows the sign-in page if the session is gone.
  }
  window.location.assign("/login");
}
