/**
 * Connected AI apps for the dashboard: the caller's own gateway consents, and
 * revocation with immediate effect at /mcp (see McpTokenVerifier).
 *
 * `name` and `host` come from client-supplied metadata (DCR registration or the
 * cached CIMD document). They are untrusted display strings: returned as data,
 * never rendered as HTML here. Lookups never fetch: an aged-out registration
 * or cache entry yields null.
 */
import { sanitizeClientName } from "./clients.js";
import type { GatewayStore } from "./store.js";

export interface ConnectedAiApp {
  clientKey: string;
  name: string | null;
  host: string | null;
  /** ISO 8601. */
  grantedAt: string;
}

export const MAX_CLIENT_KEY_LENGTH = 2048;

type AiAppsStore = Pick<GatewayStore, "listConsents" | "getClient" | "getCimd" | "revokeClient">;

function hostOf(url: string | undefined): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export class AiAppsService {
  private readonly store: AiAppsStore;
  private readonly now: () => Date;

  constructor(o: { store: AiAppsStore; now?: () => Date }) {
    this.store = o.store;
    this.now = o.now ?? (() => new Date());
  }

  async list(subject: string): Promise<ConnectedAiApp[]> {
    const grants = await this.store.listConsents(subject);
    const apps = await Promise.all(grants.map(async (g) => ({ ...(await this.describe(g.clientKey)), clientKey: g.clientKey, grantedAt: g.grantedAt })));
    return apps
      .sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime())
      .map((a) => ({ clientKey: a.clientKey, name: a.name, host: a.host, grantedAt: a.grantedAt.toISOString() }));
  }

  /** False (nothing written) when the subject has no grant for that client: unknown and foreign keys look the same. */
  async revoke(subject: string, clientKey: string): Promise<boolean> {
    if (typeof clientKey !== "string" || clientKey.length === 0 || clientKey.length > MAX_CLIENT_KEY_LENGTH) return false;
    return this.store.revokeClient(subject, clientKey, this.now);
  }

  private async describe(clientKey: string): Promise<{ name: string | null; host: string | null }> {
    if (clientKey.startsWith("https://")) {
      const cached = await this.store.getCimd(clientKey);
      const doc = cached?.document as { client_name?: unknown } | undefined;
      const name = typeof doc?.client_name === "string" ? sanitizeClientName(doc.client_name) : null;
      return { name, host: hostOf(clientKey) };
    }
    const client = await this.store.getClient(clientKey);
    if (!client) return { name: null, host: null };
    return { name: sanitizeClientName(client.clientName), host: hostOf(client.redirectUris[0]) };
  }
}
