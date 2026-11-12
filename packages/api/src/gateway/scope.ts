/**
 * Scope handling shared by /authorize and /token.
 *
 * New authorizations are granted exactly GRANTED_SCOPES: portfolio:read plus
 * `memory` (VestLens's own memory store; never brokerage writes). Hosts
 * commonly add OpenID or refresh-token scopes, so those are accepted and
 * dropped; anything else is invalid_scope.
 *
 * A stored grant (code or refresh family) keeps the scope it was created
 * with: families created before `memory` existed carry portfolio:read only
 * and keep it until the user reconnects. Refresh never escalates.
 */
export const GATEWAY_SCOPE = "portfolio:read" as const;
export const MEMORY_SCOPE = "memory" as const;

/** The scope string stored and issued for every new authorization. */
export const GRANTED_SCOPES = "portfolio:read memory" as const;

/** Stored grants a code or refresh family may carry: the current grant, and the pre-memory one. */
const KNOWN_GRANTS: ReadonlySet<string> = new Set([GRANTED_SCOPES, GATEWAY_SCOPE]);

/** Accepted alongside portfolio:read and dropped: never granted. */
export const IGNORED_SCOPES: ReadonlySet<string> = new Set(["openid", "offline_access", "email", "profile"]);

/**
 * Absent or empty → GRANTED_SCOPES. Otherwise the space-separated set must
 * contain portfolio:read, may contain memory, and nothing but IGNORED_SCOPES
 * besides. `memory` alone is invalid. Returns the granted scope, or null for
 * invalid_scope.
 */
export function normalizeScope(scope?: string): typeof GRANTED_SCOPES | null {
  if (scope === undefined || scope === "") return GRANTED_SCOPES;
  const tokens = new Set(scope.split(" ").filter((t) => t !== ""));
  if (!tokens.has(GATEWAY_SCOPE)) return null;
  for (const t of tokens) {
    if (t !== GATEWAY_SCOPE && t !== MEMORY_SCOPE && !IGNORED_SCOPES.has(t)) return null;
  }
  return GRANTED_SCOPES;
}

/** True when a stored code or refresh row carries a grant this gateway issues (exact string). */
export function isGrantedScope(stored: string): boolean {
  return KNOWN_GRANTS.has(stored);
}

/** Whether a grant (space-separated string, or the verified identity's scope list) includes `scope`. */
export function hasScope(granted: string | readonly string[], scope: typeof GATEWAY_SCOPE | typeof MEMORY_SCOPE): boolean {
  const list = typeof granted === "string" ? granted.split(" ") : granted;
  return list.includes(scope);
}
