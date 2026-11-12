import { SignJWT, importJWK, jwtVerify, type CryptoKey, type JWK, type KeyObject } from "jose";

import {
  InvalidAccessTokenError,
  MissingRequiredScopeError,
  type AuthenticatedIdentity,
} from "../auth/token-types.js";
import { randomToken } from "./crypto.js";

const ACCESS_TOKEN_SECONDS = 3600 as const;
const CLOCK_TOLERANCE_SECONDS = 30;
/** Longest a gateway access token can still verify after issue: lifetime plus the skew tolerance. */
export const ACCESS_TOKEN_MAX_ACCEPT_MS = (ACCESS_TOKEN_SECONDS + CLOCK_TOLERANCE_SECONDS) * 1000;

export type GatewayIdentity = AuthenticatedIdentity & { clientId: string; issuedAtMs: number };
const ALG = "ES256";
/** RFC 9068 JWT access token type; verify requires it (jose also accepts "application/at+jwt"). */
const TYP = "at+jwt";

function publicPart(jwk: JWK): JWK {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid: jwk.kid, alg: ALG, use: "sig" };
}

export class GatewayTokenService {
  readonly issuer: string;
  private readonly audience: string;
  private readonly signingJwk: JWK;
  private readonly publicJwks: JWK[];
  private readonly now: () => Date;
  private readonly keyCache = new Map<string, Promise<CryptoKey | KeyObject | Uint8Array>>();
  private signingKeyPromise: Promise<CryptoKey | Uint8Array> | null = null;

  constructor(options: {
    issuer: string;
    audience: string;
    signingKey: JWK;
    previousSigningKey?: JWK;
    now?: () => Date;
  }) {
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.signingJwk = options.signingKey;
    this.now = options.now ?? (() => new Date());
    this.publicJwks = [publicPart(options.signingKey)];
    if (options.previousSigningKey) this.publicJwks.push(publicPart(options.previousSigningKey));
  }

  async issueAccess(p: {
    subject: string;
    clientKey: string;
    scope: string;
  }): Promise<{ token: string; expiresIn: 3600 }> {
    const issuedAtMs = this.now().getTime();
    const iat = Math.floor(issuedAtMs / 1000);
    // Imported once and reused; a failed import is not cached.
    this.signingKeyPromise ??= importJWK({ ...this.signingJwk, alg: ALG }, ALG).catch((e: unknown) => {
      this.signingKeyPromise = null;
      throw e;
    });
    const key = await this.signingKeyPromise;
    // iat_ms: the millisecond issue time, compared with revocation markers at /mcp
    // (iat alone cannot order a token against a revoke in the same second).
    const token = await new SignJWT({ scope: p.scope, client_id: p.clientKey, iat_ms: issuedAtMs })
      .setProtectedHeader({ alg: ALG, kid: this.signingJwk.kid, typ: TYP })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(p.subject)
      .setJti(randomToken(16))
      .setIssuedAt(iat)
      .setExpirationTime(iat + ACCESS_TOKEN_SECONDS)
      .sign(key);
    return { token, expiresIn: ACCESS_TOKEN_SECONDS };
  }

  async verifyAccess(
    token: string,
    requiredScopes: readonly string[],
  ): Promise<GatewayIdentity> {
    let payload;
    try {
      ({ payload } = await jwtVerify(
        token,
        async (header) => {
          const jwk = this.publicJwks.find((k) => k.kid === header.kid);
          if (!jwk) throw new Error("unknown key");
          let key = this.keyCache.get(jwk.kid!);
          if (!key) {
            key = importJWK(jwk, ALG);
            this.keyCache.set(jwk.kid!, key);
          }
          return key;
        },
        {
          issuer: this.issuer,
          audience: this.audience,
          algorithms: [ALG],
          typ: TYP,
          currentDate: this.now(),
          // Absorbs small clock skew between the gateway and the host's clock.
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          requiredClaims: ["exp", "iat", "sub", "iss", "aud", "jti"],
        },
      ));
    } catch {
      throw new InvalidAccessTokenError();
    }

    if (
      typeof payload.sub !== "string" || payload.sub.length === 0 ||
      typeof payload.client_id !== "string" || payload.client_id.length === 0
    ) {
      throw new InvalidAccessTokenError();
    }
    const scopes = new Set<string>(
      typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [],
    );
    for (const requiredScope of requiredScopes) {
      if (!scopes.has(requiredScope)) throw new MissingRequiredScopeError(requiredScope);
    }
    const iatMs = (payload.iat as number) * 1000;
    const claimed = payload.iat_ms;
    // Signed by us, but only trusted when it falls inside the iat second; otherwise the
    // start of that second (the earliest possible issue time, so revocation errs strict).
    const issuedAtMs =
      typeof claimed === "number" && Number.isInteger(claimed) && claimed >= iatMs && claimed < iatMs + 1000
        ? claimed
        : iatMs;
    return { subject: payload.sub, scopes, clientId: payload.client_id, issuedAtMs };
  }

  jwks(): { keys: JWK[] } {
    return { keys: this.publicJwks.map((k) => ({ ...k })) };
  }
}
