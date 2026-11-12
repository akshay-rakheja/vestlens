import { z } from "zod";

import { SnapTradeKeyRejectedError, type ProviderDeletion, type SnapTradeCredentials } from "../snaptrade/gateway.js";
import { MAX_PENDING_DISCONNECTS_PER_USER, pendingDisconnectCutoff } from "./retention.js";
import type { ConnectionPurge, PendingDisconnect, StoredUser } from "./prisma-data-control-repository.js";

export class DataControlError extends Error {
  constructor(readonly code: "connection_not_found" | "provider_unavailable" | "too_many_pending", readonly status: 404 | 429 | 502) {
    super(code);
    this.name = "DataControlError";
  }
}

interface DataControlRepository {
  findUser(authSubject: string): Promise<StoredUser | null>;
  findOwnerAppUserId(): Promise<string | null>;
  purgeConnection(user: StoredUser, snapTradeConnectionId: string, options?: { keepWebhookReceipts?: boolean; pending?: "mark" | "mark_confirmed" | "clear" }): Promise<ConnectionPurge>;
  connectionState(appUserId: string, snapTradeConnectionId: string): Promise<{ stored: boolean; pending: boolean; pendingCount: number }>;
  pendingDisconnects(): Promise<PendingDisconnect[]>;
}

interface DataControlGateway {
  deleteConnection(credentials: SnapTradeCredentials, connectionId: string): Promise<ProviderDeletion>;
  /** Read-only; proves ownership of a connection the caller has not stored locally yet. */
  listConnections(credentials: SnapTradeCredentials): Promise<unknown>;
}

export type DataControlEvent =
  | { event: "connection_disconnected"; provider: ProviderDeletion; accounts: number; snapshots: number; webhookEvents: number }
  | { event: "data_control_provider_failed"; action: "disconnect" }
  | { event: "connection_purged"; source: "webhook"; accounts: number; snapshots: number }
  | { event: "connection_purge_failed"; source: "webhook"; failed: number }
  | { event: "pending_disconnect_sweep"; pending: number; cleared: number; expired: number; failed: number }
  | { event: "pending_disconnect_sweep_failed" };

export interface DisconnectSweep { pending: number; cleared: number; expired: number; failed: number }

const connectionIdSchema = z.string().trim().min(1).max(64);

/**
 * User-initiated disconnect. The provider is always asked first: if
 * SnapTrade refuses, nothing local is removed, so the user can retry.
 */
export class DataControlService {
  constructor(private readonly options: {
    identity: { getExisting(authSubject: string): Promise<SnapTradeCredentials | null> };
    gateway: DataControlGateway;
    repository: DataControlRepository;
    /** Evicts cached portfolio reads for the subject. */
    evict?: (authSubject: string) => void;
    /** Counts-only events; never subjects, ids or values. Default: one JSON line on stderr. */
    log?: (event: DataControlEvent) => void;
    now?: () => Date;
  }) {}

  private log(event: DataControlEvent) {
    (this.options.log ?? ((e) => console.warn(JSON.stringify(e))))(event);
  }

  async disconnect(authSubject: string, connectionId: string): Promise<{ status: "disconnected"; providerDeletion: ProviderDeletion }> {
    const id = connectionIdSchema.parse(connectionId);
    const [credentials, user] = await Promise.all([
      this.options.identity.getExisting(authSubject),
      this.options.repository.findUser(authSubject),
    ]);
    if (!credentials || !user) throw new DataControlError("connection_not_found", 404);

    // Only an authorization the caller has (stored locally, already pending, or listed for them
    // at SnapTrade) gets a provider write and a marker; anything else is 404 with neither.
    const state = await this.options.repository.connectionState(user.appUserId, id);
    if (!state.stored && !state.pending && !(await this.listedForCaller(credentials, id))) {
      throw new DataControlError("connection_not_found", 404);
    }
    if (!state.pending && state.pendingCount >= MAX_PENDING_DISCONNECTS_PER_USER) {
      throw new DataControlError("too_many_pending", 429);
    }

    let providerDeletion: ProviderDeletion;
    try {
      providerDeletion = await this.options.gateway.deleteConnection(credentials, id);
    } catch (error) {
      if (error instanceof SnapTradeKeyRejectedError) throw error;
      this.log({ event: "data_control_provider_failed", action: "disconnect" });
      throw new DataControlError("provider_unavailable", 502);
    }
    // The marker is written with the purge: SnapTrade only queues the deletion and may keep
    // listing the connection, so reads must not re-persist or show it.
    // A provider 404 means SnapTrade no longer has it, so the marker starts confirmed.
    const purged = await this.options.repository.purgeConnection(user, id, { pending: providerDeletion === "not_found" ? "mark_confirmed" : "mark" });
    this.options.evict?.(authSubject);
    this.log({ event: "connection_disconnected", provider: providerDeletion, ...purged });
    return { status: "disconnected", providerDeletion };
  }

  private async listedForCaller(credentials: SnapTradeCredentials, connectionId: string): Promise<boolean> {
    let listed: unknown;
    try {
      listed = await this.options.gateway.listConnections(credentials);
    } catch (error) {
      if (error instanceof SnapTradeKeyRejectedError) throw error;
      this.log({ event: "data_control_provider_failed", action: "disconnect" });
      throw new DataControlError("provider_unavailable", 502);
    }
    return Array.isArray(listed) && listed.some((item) => typeof item === "object" && item !== null && (item as { id?: unknown }).id === connectionId);
  }

  /**
   * CONNECTION_DELETED webhook (ours or a removal in SnapTrade's portal). The webhook
   * repository has already stored a confirmed pending-disconnect marker with the receipt, so
   * reads hide the connection. Here its local state is dropped and the marker is kept
   * confirmed, with the purged account ids, rather than cleared: a paged activity sync that
   * listed the account earlier may still write rows. The nightly sweep does the final purge
   * and clears the marker. A failure is logged and left to the sweep, never thrown. The
   * receipt is kept and ages out under the 30-day receipt retention.
   */
  async purgeDeletedConnection(connectionId: string): Promise<"purged" | "unknown_user" | "failed"> {
    try {
      const appUserId = await this.options.repository.findOwnerAppUserId();
      if (!appUserId) return "unknown_user";
      const purged = await this.options.repository.purgeConnection(
        { appUserId }, connectionIdSchema.parse(connectionId), { keepWebhookReceipts: true, pending: "mark_confirmed" },
      );
      this.log({ event: "connection_purged", source: "webhook", accounts: purged.accounts, snapshots: purged.snapshots });
      return "purged";
    } catch {
      this.log({ event: "connection_purge_failed", source: "webhook", failed: 1 });
      return "failed";
    }
  }

  /**
   * Nightly retry: re-purges every pending disconnect (idempotent; the marker's account ids
   * reach rows an in-flight sync wrote after the disconnect) and clears the markers SnapTrade
   * has confirmed. Unconfirmed markers stay so reads keep hiding the connection, until
   * RETENTION.pendingDisconnectDays after the request, when a final re-purge clears them.
   */
  async sweepPendingDisconnects(): Promise<DisconnectSweep> {
    let pending: PendingDisconnect[];
    try {
      pending = await this.options.repository.pendingDisconnects();
    } catch {
      this.log({ event: "pending_disconnect_sweep_failed" });
      return { pending: 0, cleared: 0, expired: 0, failed: 1 };
    }
    const cutoff = pendingDisconnectCutoff((this.options.now ?? (() => new Date()))());
    let cleared = 0;
    let expired = 0;
    let failed = 0;
    for (const marker of pending) {
      const aged = !marker.confirmed && marker.requestedAt < cutoff;
      try {
        await this.options.repository.purgeConnection(marker.user, marker.snapTradeConnectionId, {
          keepWebhookReceipts: true, ...(marker.confirmed || aged ? { pending: "clear" as const } : {}),
        });
        if (marker.confirmed) cleared += 1;
        if (aged) expired += 1;
      } catch {
        failed += 1;
      }
    }
    const result = { pending: pending.length, cleared, expired, failed };
    this.log({ event: "pending_disconnect_sweep", ...result });
    return result;
  }
}
