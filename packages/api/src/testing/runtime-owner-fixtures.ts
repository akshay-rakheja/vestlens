import { generateKeyPairSync } from "node:crypto";
import type { JWK } from "jose";

import type { GatewayConfig, OwnerAuthConfig } from "../config.js";
import { MemoryGatewayStore } from "../gateway/store.js";
import { GatewayTokenService } from "../gateway/tokens.js";
import { OWNER_SUBJECT } from "../identity/owner-identity.js";
import { memoryOwnerSessions } from "./owner-session-prisma.js";

/** One synthetic ES256 key for the whole test process; generated, never a real key. */
const signingKey: JWK = (() => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { ...(privateKey.export({ format: "jwk" }) as JWK), kid: "synthetic-runtime" };
})();

export function syntheticGatewayConfig(issuer: string): GatewayConfig {
  return { issuer, signingKey };
}

/** Placeholders: runtime composition never verifies the hash; login tests build a real one. */
export const syntheticOwnerAuth: OwnerAuthConfig = {
  passwordHash: "scrypt$32768$8$1$synthetic$synthetic",
  sessionSecret: "s".repeat(43),
};

/** What a runtime built over an injected database port also needs injected. */
export function runtimeStoreFixtures() {
  return { gatewayStore: new MemoryGatewayStore(), ownerSessions: memoryOwnerSessions() };
}

/** A gateway-issued /mcp bearer for a runtime built from `config` (same issuer, key and audience). */
export async function mcpBearer(
  config: { gateway: GatewayConfig; mcpResourceUrl: string },
  scope = "portfolio:read",
  subject: string = OWNER_SUBJECT,
): Promise<string> {
  const tokens = new GatewayTokenService({
    issuer: config.gateway.issuer,
    audience: config.mcpResourceUrl,
    signingKey: config.gateway.signingKey,
  });
  return (await tokens.issueAccess({ subject, clientKey: "synthetic-client", scope })).token;
}
