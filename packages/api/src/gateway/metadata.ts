/**
 * RFC 8414 authorization server metadata and the public JWKS for the MCP
 * sign-in gateway. The keys are exactly the Task 6 brief's.
 */
import express from "express";

import { GATEWAY_SCOPE, MEMORY_SCOPE } from "./scope.js";
import type { GatewayTokenService } from "./tokens.js";

export function metadataRouter(o: { issuer: string; resource: string; tokens: GatewayTokenService }): express.Router {
  const router = express.Router();
  const issuer = o.issuer.replace(/\/+$/, "");
  const metadata = Object.freeze({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: [GATEWAY_SCOPE, MEMORY_SCOPE],
    client_id_metadata_document_supported: true,
    // RFC 9207: every authorization response carries `iss` (mix-up defence).
    authorization_response_iss_parameter_supported: true,
  });

  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    res.json(metadata);
  });

  router.get("/.well-known/jwks.json", (_req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    res.json(o.tokens.jwks());
  });

  return router;
}
