/**
 * Bearer verification for /mcp only (spec §10 route separation).
 *
 * Only tokens this gateway issued are accepted: the unverified `iss` claim must equal the gateway issuer, and
 * the gateway verifier then checks signature, issuer, audience, scope and expiry itself. Anything else (a token
 * from another identity provider, a token from another issuer, a malformed string) is an invalid token. /api/* never uses this class, so
 * gateway tokens stay confined to /mcp.
 *
 * Revocation (dashboard "revoke app", account deletion): after a gateway
 * token verifies, one indexed lookup reads the (subject, client) and
 * subject-wide markers and refuses the token when its millisecond issue time
 * is at or before the later marker. Nothing is cached, so a revoke takes
 * effect on every instance at the next request. A lookup failure fails closed.
 */
import { decodeJwt } from "jose";

import { InvalidAccessTokenError, type AuthenticatedIdentity } from "../auth/token-types.js";
import type { GatewayStore } from "./store.js";
import type { GatewayTokenService } from "./tokens.js";

export interface TokenVerifier {
  verify(token: string, scopes: readonly string[]): Promise<AuthenticatedIdentity>;
}

export class McpTokenVerifier implements TokenVerifier {
  private readonly gateway: GatewayTokenService;
  private readonly revocations: Pick<GatewayStore, "accessRevokedAt">;

  constructor(o: {
    gateway: GatewayTokenService;
    revocations: Pick<GatewayStore, "accessRevokedAt">;
  }) {
    this.gateway = o.gateway;
    this.revocations = o.revocations;
  }

  async verify(token: string, scopes: readonly string[]): Promise<AuthenticatedIdentity> {
    let iss: unknown;
    try {
      iss = decodeJwt(token).iss;
    } catch {
      throw new InvalidAccessTokenError();
    }
    if (iss !== this.gateway.issuer) throw new InvalidAccessTokenError();
    const identity = await this.gateway.verifyAccess(token, scopes);
    const revokedAt = await this.revocations.accessRevokedAt(identity.subject, identity.clientId);
    if (revokedAt && identity.issuedAtMs <= revokedAt.getTime()) throw new InvalidAccessTokenError();
    const { issuedAtMs: _issuedAtMs, ...rest } = identity;
    return rest;
  }
}
