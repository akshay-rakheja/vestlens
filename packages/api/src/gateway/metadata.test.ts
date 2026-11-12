import express from "express";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { loopbackRequest } from "../testing/loopback-request.js";
import { metadataRouter } from "./metadata.js";
import { GatewayTokenService } from "./tokens.js";

let current: JWK;
let previous: JWK;
beforeAll(async () => {
  const a = await generateKeyPair("ES256", { extractable: true });
  const b = await generateKeyPair("ES256", { extractable: true });
  current = { ...(await exportJWK(a.privateKey)), kid: "current" };
  previous = { ...(await exportJWK(b.privateKey)), kid: "previous" };
});

async function app(issuer: string) {
  const tokens = new GatewayTokenService({
    issuer: issuer.replace(/\/+$/, ""),
    audience: "https://gw.example.test/mcp",
    signingKey: current,
    previousSigningKey: previous,
  });
  const a = express();
  a.use(metadataRouter({ issuer, resource: "https://gw.example.test/mcp", tokens }));
  return loopbackRequest(a);
}

describe("metadataRouter", () => {
  it("serves exactly the authorization server metadata keys", async () => {
    const req = await app("https://gw.example.test/");
    const res = await req.get("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      issuer: "https://gw.example.test",
      authorization_endpoint: "https://gw.example.test/authorize",
      token_endpoint: "https://gw.example.test/token",
      registration_endpoint: "https://gw.example.test/register",
      revocation_endpoint: "https://gw.example.test/revoke",
      jwks_uri: "https://gw.example.test/.well-known/jwks.json",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      scopes_supported: ["portfolio:read", "memory"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  it("serves public keys only", async () => {
    const req = await app("https://gw.example.test");
    const res = await req.get("/.well-known/jwks.json");
    expect(res.status).toBe(200);
    const keys = (res.body as { keys: JWK[] }).keys;
    expect(keys.map((k) => k.kid)).toEqual(["current", "previous"]);
    for (const k of keys) {
      expect(k).not.toHaveProperty("d");
      expect(Object.keys(k).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x", "y"]);
      expect(k.alg).toBe("ES256");
    }
  });
});
