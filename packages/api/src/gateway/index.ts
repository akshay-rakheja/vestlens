/**
 * Composition of the MCP sign-in gateway (spec §2, §6): one router with the
 * authorization server endpoints, and the /mcp bearer verifier.
 *
 * Always mounted by the app. `close()` stops the housekeeping sweep.
 */
import express, { type NextFunction, type Request, type Response } from "express";

import type { GatewayConfig } from "../config.js";
import { AiAppsService } from "./ai-apps.js";
import { authorizeRouter, sendErrorPage, type GatewayLogEvent } from "./authorize-routes.js";
import { CimdResolver, createPinnedHttpsFetch, systemLookup, type CimdLookup } from "./cimd.js";
import { ClientRegistry } from "./clients.js";
import { consentRouter } from "./consent-routes.js";
import { McpTokenVerifier, type TokenVerifier } from "./mcp-token-verifier.js";
import { metadataRouter } from "./metadata.js";
import type { GatewayStore } from "./store.js";
import { CODE_REUSE_REVOKE_GRACE_MS, tokenRouter } from "./token-routes.js";
import { ACCESS_TOKEN_MAX_ACCEPT_MS, GatewayTokenService } from "./tokens.js";
import type { UpstreamIdp } from "./upstream.js";

export type { TokenVerifier } from "./mcp-token-verifier.js";

export const SWEEP_MAX_INTERVAL_MS = 10 * 60 * 1000;
export const CLIENT_IDLE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** DCR clients that never completed a token exchange are removed after 24 h (keeps the 5,000 cap free). */
export const CLIENT_NEVER_USED_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Families last at most 30 days, so a marker older than 31 days guards nothing. */
export const REVOKED_FAMILY_MARKER_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
/** An access-token marker guards nothing once every token it could refuse has expired (1 h + skew); kept 2 h. */
export const CLIENT_REVOCATION_RETENTION_MS = Math.max(2 * 60 * 60 * 1000, ACCESS_TOKEN_MAX_ACCEPT_MS);

/** Path prefixes owned by the gateway (kept out of the SPA fallback when mounted). */
export const GATEWAY_PATH_PREFIXES = ["/authorize", "/token", "/register", "/revoke", "/oauth"] as const;

/** Public metadata documents: readable cross-origin, never credentialed. */
export const PUBLIC_METADATA_PATHS = ["/.well-known/oauth-authorization-server", "/.well-known/jwks.json"] as const;

const BROWSER_PATH_PREFIXES = ["/authorize", "/oauth"];

export interface Gateway {
  router: express.Router;
  mcpVerifier: TokenVerifier;
  issuer: string;
  /** Dashboard "Connected AI apps": list and revoke the caller's own apps. */
  aiApps: AiAppsService;
  close(): void;
}

export interface CreateGatewayOptions {
  config: GatewayConfig;
  /** The MCP resource URL (`…/mcp`): the JWT audience and the only resource. */
  resource: string;
  store: GatewayStore;
  /** Who the user is: the local owner upstream (local-upstream.ts). */
  upstream: UpstreamIdp;
  /** Test seams; production uses the pinned, SSRF-guarded fetch. */
  cimdFetch?: typeof fetch;
  cimdLookup?: CimdLookup;
  now?: () => Date;
  log?: (e: GatewayLogEvent) => void;
  sweepIntervalMs?: number;
  sweepLog?: (e: Record<string, unknown>) => void;
}

/** CORS for public metadata: GET only, any origin, no credentials. */
export function publicMetadataCors(req: Request, res: Response, next: NextFunction) {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Access-Control-Allow-Headers", "MCP-Protocol-Version, Content-Type");
    res.set("Access-Control-Max-Age", "600");
    return res.status(204).end();
  }
  return next();
}

export function createGateway(o: CreateGatewayOptions): Gateway {
  const now = o.now ?? (() => new Date());
  const issuer = o.config.issuer.replace(/\/+$/, "");
  const log = o.log ?? ((e: GatewayLogEvent) => console.info(JSON.stringify(e)));
  const sweepLog = o.sweepLog ?? ((e: Record<string, unknown>) => console.info(JSON.stringify(e)));

  const tokens = new GatewayTokenService({
    issuer,
    audience: o.resource,
    signingKey: o.config.signingKey,
    ...(o.config.previousSigningKey ? { previousSigningKey: o.config.previousSigningKey } : {}),
    now,
  });
  const lookup = o.cimdLookup ?? systemLookup;
  const cimd = new CimdResolver({
    store: o.store,
    fetch: o.cimdFetch ?? createPinnedHttpsFetch(lookup),
    lookup,
    now,
  });
  const clients = new ClientRegistry({ store: o.store, cimd, now });
  const upstream = o.upstream;

  const router = express.Router();
  router.use([...PUBLIC_METADATA_PATHS], publicMetadataCors);
  router.use(metadataRouter({ issuer, resource: o.resource, tokens }));
  router.use(authorizeRouter({ store: o.store, clients, upstream, issuer, resource: o.resource, now, log }));
  router.use(consentRouter({ store: o.store, clients, issuer, now, log }));
  router.use(tokenRouter({ store: o.store, clients, tokens, resource: o.resource, now, log }));
  // Last-resort handler: unexpected errors never reach Express's default (stack-bearing) page.
  router.use((_err: unknown, req: Request, res: Response, _next: NextFunction) => {
    log({ event: "gateway_error", clientHost: "unknown", result: "server_error" });
    if (res.headersSent) return res.end();
    if (BROWSER_PATH_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`))) {
      return sendErrorPage(res, 500, "Sign-in is temporarily unavailable.");
    }
    res.set("Cache-Control", "no-store");
    return res.status(500).json({ error: "server_error" });
  });

  const interval = Math.min(Math.max(o.sweepIntervalMs ?? SWEEP_MAX_INTERVAL_MS, 1_000), SWEEP_MAX_INTERVAL_MS);
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void (async () => {
      try {
        const at = now();
        const ago = (ms: number) => new Date(at.getTime() - ms);
        const pendings = await o.store.deleteExpiredPendings(at);
        const idleClients = await o.store.deleteClientsUnusedSince(ago(CLIENT_IDLE_RETENTION_MS));
        const neverUsedClients = await o.store.deleteNeverUsedClientsCreatedBefore(ago(CLIENT_NEVER_USED_RETENTION_MS));
        const cimd = await o.store.deleteExpiredCimd(at);
        // Kept through the reuse grace window, so a late replay still revokes its family.
        const codes = await o.store.deleteExpiredCodes(ago(CODE_REUSE_REVOKE_GRACE_MS));
        const refreshTokens = await o.store.deleteExpiredRefreshTokens(at);
        const revokedFamilies = await o.store.deleteRevokedFamilyMarkersBefore(ago(REVOKED_FAMILY_MARKER_RETENTION_MS));
        const clientRevocations = await o.store.deleteClientRevocationsBefore(ago(CLIENT_REVOCATION_RETENTION_MS));
        sweepLog({
          event: "gateway_sweep",
          result: "ok",
          pendings,
          clients: idleClients + neverUsedClients,
          cimd,
          codes,
          refreshTokens,
          revokedFamilies,
          clientRevocations,
        });
      } catch {
        sweepLog({ event: "gateway_sweep", result: "failed" });
      } finally {
        sweeping = false;
      }
    })();
  }, interval);
  timer.unref?.();

  return {
    router,
    mcpVerifier: new McpTokenVerifier({ gateway: tokens, revocations: o.store }),
    issuer,
    aiApps: new AiAppsService({ store: o.store, now }),
    close: () => clearInterval(timer),
  };
}
