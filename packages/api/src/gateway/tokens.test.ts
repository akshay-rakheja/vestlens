import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";

import { InvalidAccessTokenError, MissingRequiredScopeError } from "../auth/token-types.js";
import { randomToken, sha256, verifyPkceS256 } from "./crypto.js";
import { GatewayTokenService } from "./tokens.js";

const issuer = "https://portfolio.example.com";
const audience = "https://portfolio.example.com/mcp";

async function makeKey(kid: string): Promise<JWK> {
  const pair = await generateKeyPair("ES256", { extractable: true });
  return { ...(await exportJWK(pair.privateKey)), kid };
}

let keyA: JWK;
let keyB: JWK;
beforeAll(async () => {
  keyA = await makeKey("a");
  keyB = await makeKey("b");
});

const at = (iso: string) => () => new Date(iso);

describe("GatewayTokenService", () => {
  it("issues a token that verifies and carries the identity", async () => {
    const svc = new GatewayTokenService({ issuer, audience, signingKey: keyA });
    const { token, expiresIn } = await svc.issueAccess({ subject: "subject|u1", clientKey: "client-1", scope: "portfolio:read" });
    expect(expiresIn).toBe(3600);
    const identity = await svc.verifyAccess(token, ["portfolio:read"]);
    expect(identity.subject).toBe("subject|u1");
    expect(identity.scopes.has("portfolio:read")).toBe(true);
    // The alerts delivery ledger is keyed per client.
    expect(identity.clientId).toBe("client-1");
  });

  it("rejects a wrong audience or issuer", async () => {
    const svc = new GatewayTokenService({ issuer, audience, signingKey: keyA });
    const { token } = await svc.issueAccess({ subject: "s", clientKey: "c", scope: "portfolio:read" });
    const otherAud = new GatewayTokenService({ issuer, audience: "https://other.example.com/mcp", signingKey: keyA });
    const otherIss = new GatewayTokenService({ issuer: "https://other.example.com", audience, signingKey: keyA });
    await expect(otherAud.verifyAccess(token, [])).rejects.toBeInstanceOf(InvalidAccessTokenError);
    await expect(otherIss.verifyAccess(token, [])).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });

  it("rejects an expired token", async () => {
    const issuing = new GatewayTokenService({ issuer, audience, signingKey: keyA, now: at("2026-10-20T00:00:00Z") });
    const { token } = await issuing.issueAccess({ subject: "s", clientKey: "c", scope: "portfolio:read" });
    const early = new GatewayTokenService({ issuer, audience, signingKey: keyA, now: at("2026-10-20T00:59:00Z") });
    const late = new GatewayTokenService({ issuer, audience, signingKey: keyA, now: at("2026-10-20T01:00:31Z") });
    await expect(early.verifyAccess(token, [])).resolves.toBeDefined();
    await expect(late.verifyAccess(token, [])).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });

  it("tolerates 30 seconds of clock skew but no more", async () => {
    const issuing = new GatewayTokenService({ issuer, audience, signingKey: keyA, now: at("2026-10-20T00:00:00Z") });
    const { token } = await issuing.issueAccess({ subject: "s", clientKey: "c", scope: "portfolio:read" });
    const within = new GatewayTokenService({ issuer, audience, signingKey: keyA, now: at("2026-10-20T01:00:20Z") });
    await expect(within.verifyAccess(token, [])).resolves.toBeDefined();
  });

  it("requires jti and client_id claims", async () => {
    const svc = new GatewayTokenService({ issuer, audience, signingKey: keyA });
    const key = await importJWK(keyA, "ES256");
    const build = (claims: Record<string, unknown>, jti: boolean) => {
      const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", kid: "a", typ: "at+jwt" })
        .setIssuer(issuer).setAudience(audience).setSubject("s").setIssuedAt().setExpirationTime("1h");
      if (jti) jwt.setJti("j1");
      return jwt.sign(key);
    };
    await expect(svc.verifyAccess(await build({ scope: "portfolio:read", client_id: "c" }, true), [])).resolves.toBeDefined();
    await expect(svc.verifyAccess(await build({ scope: "portfolio:read", client_id: "c" }, false), [])).rejects.toBeInstanceOf(InvalidAccessTokenError);
    await expect(svc.verifyAccess(await build({ scope: "portfolio:read" }, true), [])).rejects.toBeInstanceOf(InvalidAccessTokenError);
    await expect(svc.verifyAccess(await build({ scope: "portfolio:read", client_id: 5 }, true), [])).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });

  it("carries a millisecond issue time beside iat and reports it as issuedAtMs", async () => {
    const svc = new GatewayTokenService({ issuer, audience, signingKey: keyA, now: at("2026-10-20T00:00:00.789Z") });
    const { token } = await svc.issueAccess({ subject: "s", clientKey: "c", scope: "portfolio:read" });
    const claims = decodeJwt(token);
    expect(claims.iat).toBe(Date.parse("2026-10-20T00:00:00Z") / 1000);
    expect(claims.iat_ms).toBe(Date.parse("2026-10-20T00:00:00.789Z"));
    expect((await svc.verifyAccess(token, [])).issuedAtMs).toBe(Date.parse("2026-10-20T00:00:00.789Z"));
  });

  it("falls back to the start of the iat second without a consistent iat_ms, and requires iat", async () => {
    const svc = new GatewayTokenService({ issuer, audience, signingKey: keyA, now: at("2026-10-20T00:00:10Z") });
    const key = await importJWK(keyA, "ES256");
    const iat = Date.parse("2026-10-20T00:00:05Z") / 1000;
    const build = (claims: Record<string, unknown>, withIat = true) => {
      const jwt = new SignJWT({ scope: "portfolio:read", client_id: "c", ...claims })
        .setProtectedHeader({ alg: "ES256", kid: "a", typ: "at+jwt" })
        .setIssuer(issuer).setAudience(audience).setSubject("s").setJti("j").setExpirationTime(iat + 3600);
      if (withIat) jwt.setIssuedAt(iat);
      return jwt.sign(key);
    };
    expect((await svc.verifyAccess(await build({}), [])).issuedAtMs).toBe(iat * 1000);
    // An iat_ms outside the iat second (or not an integer) is ignored, never trusted.
    expect((await svc.verifyAccess(await build({ iat_ms: iat * 1000 + 5000 }), [])).issuedAtMs).toBe(iat * 1000);
    expect((await svc.verifyAccess(await build({ iat_ms: iat * 1000 + 0.5 }), [])).issuedAtMs).toBe(iat * 1000);
    expect((await svc.verifyAccess(await build({ iat_ms: iat * 1000 + 250 }), [])).issuedAtMs).toBe(iat * 1000 + 250);
    await expect(svc.verifyAccess(await build({}, false), [])).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });

  it("issues RFC 9068 at+jwt tokens and rejects any other typ", async () => {
    const svc = new GatewayTokenService({ issuer, audience, signingKey: keyA });
    const { token } = await svc.issueAccess({ subject: "s", clientKey: "c", scope: "portfolio:read" });
    expect(decodeProtectedHeader(token)).toEqual({ alg: "ES256", kid: "a", typ: "at+jwt" });
    const key = await importJWK(keyA, "ES256");
    const withTyp = (typ: string | undefined) =>
      new SignJWT({ scope: "portfolio:read", client_id: "c" })
        .setProtectedHeader({ alg: "ES256", kid: "a", ...(typ ? { typ } : {}) })
        .setIssuer(issuer).setAudience(audience).setSubject("s").setJti("j").setIssuedAt().setExpirationTime("1h")
        .sign(key);
    await expect(svc.verifyAccess(await withTyp("application/at+jwt"), [])).resolves.toBeDefined();
    for (const typ of ["JWT", "id_token+jwt", undefined]) {
      await expect(svc.verifyAccess(await withTyp(typ), []), String(typ)).rejects.toBeInstanceOf(InvalidAccessTokenError);
    }
    // Repeated issuance reuses the imported signing key and keeps working.
    const again = await svc.issueAccess({ subject: "s", clientKey: "c", scope: "portfolio:read" });
    await expect(svc.verifyAccess(again.token, [])).resolves.toBeDefined();
  });

  it("verifies a token signed by the previous key", async () => {
    const old = new GatewayTokenService({ issuer, audience, signingKey: keyB });
    const { token } = await old.issueAccess({ subject: "s", clientKey: "c", scope: "portfolio:read" });
    const rotated = new GatewayTokenService({ issuer, audience, signingKey: keyA, previousSigningKey: keyB });
    await expect(rotated.verifyAccess(token, [])).resolves.toBeDefined();
    const noPrev = new GatewayTokenService({ issuer, audience, signingKey: keyA });
    await expect(noPrev.verifyAccess(token, [])).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });

  it("accepts a public previous key", async () => {
    const old = new GatewayTokenService({ issuer, audience, signingKey: keyB });
    const { token } = await old.issueAccess({ subject: "s", clientKey: "c", scope: "portfolio:read" });
    const { d: _d, ...pub } = keyB;
    const rotated = new GatewayTokenService({ issuer, audience, signingKey: keyA, previousSigningKey: pub });
    await expect(rotated.verifyAccess(token, [])).resolves.toBeDefined();
  });

  it("raises MissingRequiredScopeError for a missing scope", async () => {
    const svc = new GatewayTokenService({ issuer, audience, signingKey: keyA });
    const { token } = await svc.issueAccess({ subject: "s", clientKey: "c", scope: "portfolio:read" });
    await expect(svc.verifyAccess(token, ["connections:manage"])).rejects.toBeInstanceOf(MissingRequiredScopeError);
  });

  it("rejects tokens with the wrong algorithm, an unknown key, or garbage", async () => {
    const svc = new GatewayTokenService({ issuer, audience, signingKey: keyA });
    const stranger = await makeKey("a");
    const forged = await new SignJWT({ scope: "portfolio:read", client_id: "c" })
      .setProtectedHeader({ alg: "ES256", kid: "a" })
      .setIssuer(issuer).setAudience(audience).setSubject("s").setIssuedAt().setExpirationTime("1h")
      .sign(await importJWK(stranger, "ES256"));
    await expect(svc.verifyAccess(forged, [])).rejects.toBeInstanceOf(InvalidAccessTokenError);
    await expect(svc.verifyAccess("not.a.jwt", [])).rejects.toBeInstanceOf(InvalidAccessTokenError);
    const hs = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer(issuer).setAudience(audience).setSubject("s").setExpirationTime("1h").sign(new Uint8Array(32));
    await expect(svc.verifyAccess(hs, [])).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });

  it("publishes public keys only, current and previous", () => {
    const svc = new GatewayTokenService({ issuer, audience, signingKey: keyA, previousSigningKey: keyB });
    const { keys } = svc.jwks();
    expect(keys.map((k) => k.kid)).toEqual(["a", "b"]);
    for (const key of keys) {
      expect(Object.keys(key).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x", "y"]);
      expect(key.d).toBeUndefined();
      expect(key.alg).toBe("ES256");
      expect(key.use).toBe("sig");
    }
  });
});

describe("crypto helpers", () => {
  it("matches the RFC 7636 PKCE vector", () => {
    expect(verifyPkceS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
    expect(verifyPkceS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cX")).toBe(false);
  });
  it("rejects malformed or non-canonical challenges", () => {
    const v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const c = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(verifyPkceS256(v, c + "=")).toBe(false);
    expect(verifyPkceS256(v, c.slice(0, 42))).toBe(false);
    expect(verifyPkceS256(v, c + "A")).toBe(false);
    // last char variants decode to the same bytes in lenient decoders; must not match
    expect(verifyPkceS256(v, c.slice(0, 42) + "N")).toBe(false);
  });
  it("rejects verifiers outside 43-128 characters or charset", () => {
    const short = "a".repeat(42);
    expect(verifyPkceS256(short, Buffer.from(sha256(short), "hex").toString("base64url"))).toBe(false);
    const long = "a".repeat(129);
    expect(verifyPkceS256(long, Buffer.from(sha256(long), "hex").toString("base64url"))).toBe(false);
    const bad = "a".repeat(42) + "!";
    expect(verifyPkceS256(bad, Buffer.from(sha256(bad), "hex").toString("base64url"))).toBe(false);
  });
  it("generates base64url tokens and hex sha256", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(randomToken());
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
