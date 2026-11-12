/**
 * The upstream seam of the MCP sign-in gateway: "who is the user?" State, nonce and PKCE are the gateway's own;
 * an implementation turns them into a redirect (`authorizeUrl`) and later spends the resulting code (`exchange`).
 * The only implementation is `localOwnerUpstream` (the owner's own session); see local-upstream.ts.
 *
 * `exchange` signals a refusal with any error other than UpstreamUnavailableError; the host then gets access_denied.
 */

/** The upstream said no (bad code, nonce mismatch…). The host gets access_denied. */
export class UpstreamRejectedError extends Error {
  constructor(reason: string) {
    super(`upstream rejected: ${reason}`);
    this.name = "UpstreamRejectedError";
  }
}

/** The upstream is unreachable or malformed. The user sees "temporarily unavailable". */
export class UpstreamUnavailableError extends Error {
  constructor(reason: string) {
    super(`upstream unavailable: ${reason}`);
    this.name = "UpstreamUnavailableError";
  }
}

export interface UpstreamIdp {
  authorizeUrl(p: { state: string; nonce: string; codeChallenge: string; redirectUri: string }): string;
  exchange(p: { code: string; verifier: string; redirectUri: string; nonce: string }): Promise<{
    subject: string;
    emailVerified: boolean;
  }>;
}
