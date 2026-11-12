import type { Request } from "express";

/**
 * The one same-origin rule for browser writes (the owner login and logout forms and every non-GET `/api` call).
 * The expected origin is always `new URL(APP_BASE_URL).origin`, never the request's own Host, so it does not depend on
 * what a proxy rewrites. A `Sec-Fetch-Site: cross-site` request is refused whatever its Origin says.
 * `requireOrigin` (the JSON API) also refuses a request that carries no Origin; the sign-in forms accept its absence
 * because some browsers omit Origin on same-origin form posts.
 */
export function isSameOriginRequest(
  request: Pick<Request, "get">,
  expectedOrigin: string,
  o: { requireOrigin?: boolean } = {},
): boolean {
  if (request.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.get("origin");
  if (origin === undefined) return o.requireOrigin !== true;
  return origin === expectedOrigin;
}
