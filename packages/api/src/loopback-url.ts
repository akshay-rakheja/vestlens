/**
 * True for a plain-http URL whose host is the local machine (`localhost`, `127.0.0.1`, `[::1]`).
 * The one place http is accepted for APP_BASE_URL and the one place the session cookie may go without Secure.
 */
export function isLoopbackHttp(url: string | URL): boolean {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return false;
  }
  return parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
}
