import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { InvalidAccessTokenError, MissingRequiredScopeError } from "../auth/token-types.js";
import { McpTokenVerifier } from "./mcp-token-verifier.js";
import { MemoryGatewayStore } from "./store.js";
import { GatewayTokenService } from "./tokens.js";

const ISSUER = "https://gw.example.test";
const RESOURCE = "https://gw.example.test/mcp";
const AUTH0 = "https://tenant.example.test/";

let signingKey: JWK;
beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signingKey = { ...(await exportJWK(pair.privateKey)), kid: "k1" };
});

async function auth0Shaped(iss = AUTH0): Promise<string> {
  // Only the unverified `iss` matters for routing; the Auth0 verifier is a fake.
  const { privateKey } = await generateKeyPair("ES256");
  return new SignJWT({ scope: "portfolio:read" })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(iss)
    .setSubject("subject|abc")
    .setAudience(RESOURCE)
    .setExpirationTime("1h")
    .sign(privateKey);
}

function setup(at: Date) {
  let now = at;
  const gateway = new GatewayTokenService({ issuer: ISSUER, audience: RESOURCE, signingKey, now: () => now });
  const store = new MemoryGatewayStore();
  const verifier = new McpTokenVerifier({ gateway, revocations: store });
  return { gateway, store, verifier, now: () => now, setNow: (d: Date) => (now = d) };
}

describe("McpTokenVerifier", () => {
  it("verifies a gateway-issued token", async () => {
    const { gateway, verifier } = setup(new Date("2026-10-20T12:00:00Z"));
    const { token } = await gateway.issueAccess({ subject: "subject|abc", clientKey: "c1", scope: "portfolio:read" });
    await expect(verifier.verify(token, ["portfolio:read"])).resolves.toMatchObject({ subject: "subject|abc" });
  });

  it("verifies read access with either granted scope string and exposes the granted scopes", async () => {
    const { gateway, store, verifier, now } = setup(new Date("2026-10-20T12:00:00Z"));
    const legacy = (await gateway.issueAccess({ subject: "subject|abc", clientKey: "c1", scope: "portfolio:read" })).token;
    const granted = (await gateway.issueAccess({ subject: "subject|abc", clientKey: "c1", scope: "portfolio:read memory" })).token;
    expect([...(await verifier.verify(legacy, ["portfolio:read"])).scopes]).toEqual(["portfolio:read"]);
    expect([...(await verifier.verify(granted, ["portfolio:read"])).scopes]).toEqual(["portfolio:read", "memory"]);
    // The memory scope does not exempt a token from revocation.
    await store.putConsent("subject|abc", "c1", "portfolio:read memory", now());
    await store.revokeClient("subject|abc", "c1", now);
    await expect(verifier.verify(granted, ["portfolio:read"])).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });

  it("keeps gateway scope errors", async () => {
    const { gateway, verifier } = setup(new Date("2026-10-20T12:00:00Z"));
    const { token } = await gateway.issueAccess({ subject: "subject|abc", clientKey: "c1", scope: "other" });
    await expect(verifier.verify(token, ["portfolio:read"])).rejects.toBeInstanceOf(MissingRequiredScopeError);
  });

  it("rejects a forged token claiming the gateway issuer", async () => {
    const { verifier } = setup(new Date("2026-10-20T12:00:00Z"));
    const forged = await auth0Shaped(ISSUER);
    await expect(verifier.verify(forged, ["portfolio:read"])).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });

  it("rejects a token from any other issuer, Auth0 included, at any time", async () => {
    const { verifier, setNow } = setup(new Date("2026-10-20T12:00:00Z"));
    for (const iss of [AUTH0, "https://other.example.test", ""]) {
      const token = await auth0Shaped(iss);
      await expect(verifier.verify(token, ["portfolio:read"])).rejects.toBeInstanceOf(InvalidAccessTokenError);
    }
    setNow(new Date("2030-01-01T00:00:00Z"));
    await expect(verifier.verify(await auth0Shaped(), ["portfolio:read"])).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });

  it("rejects tokens that are not JWTs", async () => {
    const { verifier } = setup(new Date("2026-10-20T12:00:00Z"));
    for (const bad of ["", "abc", "a.b.c", "x.y"]) {
      await expect(verifier.verify(bad, ["portfolio:read"])).rejects.toBeInstanceOf(InvalidAccessTokenError);
    }
  });

  describe("revocation markers (checked on every request, no cache)", () => {
    const T = new Date("2026-10-20T12:00:00.400Z");
    const issue = (g: GatewayTokenService, clientKey = "c1", subject = "subject|abc") =>
      g.issueAccess({ subject, clientKey, scope: "portfolio:read" }).then((r) => r.token);

    it("rejects a token issued before or at the client marker; same-second re-authorisation after it works", async () => {
      const { gateway, store, verifier, setNow } = setup(new Date("2026-10-20T12:00:00.100Z"));
      const before = await issue(gateway); // earlier in the same second as the revoke
      setNow(T);
      const atBoundary = await issue(gateway); // same millisecond as the marker
      const other = await issue(gateway, "c2");
      await expect(verifier.verify(before, ["portfolio:read"])).resolves.toBeTruthy();
      await store.putConsent("subject|abc", "c1", "portfolio:read", T);
      await store.revokeClient("subject|abc", "c1", () => T);
      await expect(verifier.verify(before, ["portfolio:read"])).rejects.toBeInstanceOf(InvalidAccessTokenError);
      await expect(verifier.verify(atBoundary, ["portfolio:read"])).rejects.toBeInstanceOf(InvalidAccessTokenError);
      await expect(verifier.verify(other, ["portfolio:read"])).resolves.toMatchObject({ clientId: "c2" });
      setNow(new Date(T.getTime() + 1)); // still the same iat second
      const reauthorised = await issue(gateway);
      await expect(verifier.verify(reauthorised, ["portfolio:read"])).resolves.toMatchObject({ clientId: "c1" });
      setNow(new Date(T.getTime() + 60_000));
      await expect(verifier.verify(before, ["portfolio:read"])).rejects.toBeInstanceOf(InvalidAccessTokenError);
      await expect(verifier.verify(reauthorised, ["portfolio:read"])).resolves.toBeTruthy();
    });

    it("the subject-wide marker rejects every client's earlier tokens but not other subjects'", async () => {
      const { gateway, store, verifier, setNow } = setup(T);
      const a = await issue(gateway, "c1");
      const b = await issue(gateway, "https://claude.ai/oauth/meta");
      const stranger = await issue(gateway, "c1", "subject|other");
      setNow(new Date(T.getTime() + 5));
      await store.revokeAllForSubject("subject|abc", () => new Date(T.getTime() + 5));
      await expect(verifier.verify(a, ["portfolio:read"])).rejects.toBeInstanceOf(InvalidAccessTokenError);
      await expect(verifier.verify(b, ["portfolio:read"])).rejects.toBeInstanceOf(InvalidAccessTokenError);
      await expect(verifier.verify(stranger, ["portfolio:read"])).resolves.toMatchObject({ subject: "subject|other" });
      setNow(new Date(T.getTime() + 6));
      await expect(verifier.verify(await issue(gateway, "c1"), ["portfolio:read"])).resolves.toBeTruthy();
    });

    it("a token without iat_ms in the revoke second is treated as issued at the start of that second", async () => {
      const { store, verifier } = setup(T);
      const { importJWK } = await import("jose");
      const key = await importJWK(signingKey, "ES256");
      const iat = Math.floor(T.getTime() / 1000);
      const legacy = await new SignJWT({ scope: "portfolio:read", client_id: "c1" })
        .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "at+jwt" })
        .setIssuer(ISSUER).setAudience(RESOURCE).setSubject("subject|abc").setJti("j")
        .setIssuedAt(iat).setExpirationTime(iat + 3600)
        .sign(key);
      await expect(verifier.verify(legacy, ["portfolio:read"])).resolves.toBeTruthy();
      await store.revokeAllForSubject("subject|abc", () => new Date(iat * 1000));
      await expect(verifier.verify(legacy, ["portfolio:read"])).rejects.toBeInstanceOf(InvalidAccessTokenError);
    });

    it("fails closed when the marker lookup fails", async () => {
      const { gateway, store, verifier } = setup(T);
      const token = await issue(gateway);
      vi.spyOn(store, "accessRevokedAt").mockRejectedValueOnce(new Error("db down"));
      await expect(verifier.verify(token, ["portfolio:read"])).rejects.toThrow();
    });

    it("does one marker lookup per verification of a gateway token", async () => {
      const { gateway, store, verifier } = setup(T);
      const spy = vi.spyOn(store, "accessRevokedAt");
      const token = await issue(gateway);
      await verifier.verify(token, ["portfolio:read"]);
      await verifier.verify(token, ["portfolio:read"]);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenCalledWith("subject|abc", "c1");
    });
  });
});
