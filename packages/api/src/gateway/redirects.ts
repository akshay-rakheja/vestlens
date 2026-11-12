/**
 * Redirect-URI policy for the MCP sign-in gateway.
 *
 * Matching is exact-string, with one carve-out (RFC 8252 §7.3): a registered
 * loopback `http:` URI matches a candidate that differs only in port. Hosts
 * are compared after WHATWG URL parsing; prefix/substring matching is never
 * used.
 */

/** Global Constraints: only these two loopback hosts (no IPv6 literal). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

/** Lowercase letters, digits and hyphens in dot-separated labels (punycode for IDNs). No IP-literal brackets. */
const LDH_HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

export const MAX_REDIRECT_URI_LENGTH = 2048;

function parse(value: string): URL | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopbackHttp(u: URL): boolean {
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

/**
 * True when `value` is an allowed registered form: https, or loopback http.
 * It must be in canonical WHATWG form (`new URL(v).href === v`), so the stored
 * string is exactly what a browser navigates to. No fragments or userinfo.
 */
export function isAllowedRedirectForm(value: string): boolean {
  const u = parse(value);
  if (!u || u.href !== value) return false;
  if (u.hash !== "" || value.includes("#")) return false;
  if (u.username !== "" || u.password !== "") return false;
  if (u.protocol === "https:") return LDH_HOSTNAME.test(u.hostname);
  return isLoopbackHttp(u);
}

export function redirectUriAllowed(registered: string[], candidate: string): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  // RFC 6749 §3.1.2: never a fragment, not even an empty one.
  if (candidate.includes("#")) return false;
  if (registered.includes(candidate)) return true;

  const c = parse(candidate);
  // The candidate must already be in canonical form, so that normalisation
  // (dot segments, numeric hosts, case) can never turn it into a match.
  if (!c || c.href !== candidate) return false;
  if (!isLoopbackHttp(c) || c.username !== "" || c.password !== "" || c.hash !== "") return false;

  return registered.some((entry) => {
    const r = parse(entry);
    if (!r || !isLoopbackHttp(r) || r.username !== "" || r.password !== "" || r.hash !== "") return false;
    return (
      r.protocol === c.protocol &&
      r.hostname === c.hostname &&
      r.pathname === c.pathname &&
      r.search === c.search
    );
  });
}
