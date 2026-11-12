import { OWNER_SUBJECT } from "../identity/owner-identity.js";
import type {
  VerifiedWebhookRecord,
  WebhookEventRepository,
} from "./webhook-ingestion-service.js";

export interface WebhookPrismaPort {
  appUser: {
    findUnique(input: {
      where: { authSubject: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  brokerageConnection: {
    upsert(input: {
      where: {
        appUserId_snapTradeConnectionId: {
          appUserId: string;
          snapTradeConnectionId: string;
        };
      };
      create: {
        appUserId: string;
        snapTradeConnectionId: string;
        disabled: boolean;
        lastWebhookAt: Date;
      };
      update: { disabled?: boolean; lastWebhookAt: Date };
    }): Promise<unknown>;
  };
  /**
   * Pending-disconnect markers (normal-mode runtime). Optional so ports injected by tests
   * without data controls keep their shape; production wiring always supplies it.
   */
  pendingDisconnect?: {
    upsert(input: {
      where: { appUserId_snapTradeConnectionId: { appUserId: string; snapTradeConnectionId: string } };
      create: { appUserId: string; snapTradeConnectionId: string; requestedAt: Date; confirmedAt: Date };
      update: { confirmedAt: Date };
    }): Promise<unknown>;
  };
  webhookEvent: {
    create(input: {
      data: {
        appUserId: string | null;
        snapTradeUserId: string;
        snapTradeWebhookId: string;
        eventType: string;
        bodyDigest: string;
        payload: Record<string, unknown>;
        status: "PROCESSED" | "IGNORED";
        processedAt: Date;
      };
    }): Promise<unknown>;
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

export class PrismaWebhookEventRepository implements WebhookEventRepository {
  constructor(
    private readonly prisma: WebhookPrismaPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async recordVerifiedEvent(
    event: VerifiedWebhookRecord,
  ): Promise<"created" | "duplicate"> {
    // One owner per instance: every verified webhook belongs to the owner's Personal key.
    const owner = await this.prisma.appUser.findUnique({
      where: { authSubject: OWNER_SUBJECT },
      select: { id: true },
    });
    const authorizationId =
      typeof event.payload.brokerageAuthorizationId === "string"
        ? event.payload.brokerageAuthorizationId
        : null;
    let status: "PROCESSED" | "IGNORED" = "IGNORED";

    if (owner && authorizationId && event.eventType === "CONNECTION_DELETED") {
      // Never recreate the connection as a stub. A confirmed marker is stored before the
      // receipt: reads hide the connection, and if the purge that follows fails, the nightly
      // sweep retries it. If this write fails, no receipt is stored and the error reaches
      // SnapTrade, whose redelivery is then not a duplicate.
      const confirmedAt = this.now();
      await this.prisma.pendingDisconnect?.upsert({
        where: { appUserId_snapTradeConnectionId: { appUserId: owner.id, snapTradeConnectionId: authorizationId } },
        create: { appUserId: owner.id, snapTradeConnectionId: authorizationId, requestedAt: confirmedAt, confirmedAt },
        update: { confirmedAt },
      });
      status = "PROCESSED";
    } else if (owner && authorizationId) {
      const disabled = event.eventType === "CONNECTION_BROKEN";
      const explicitlyHealthy =
        event.eventType === "CONNECTION_ADDED" ||
        event.eventType === "CONNECTION_FIXED";
      await this.prisma.brokerageConnection.upsert({
        where: {
          appUserId_snapTradeConnectionId: {
            appUserId: owner.id,
            snapTradeConnectionId: authorizationId,
          },
        },
        create: {
          appUserId: owner.id,
          snapTradeConnectionId: authorizationId,
          disabled,
          lastWebhookAt: new Date(event.eventTimestamp),
        },
        update: {
          ...(disabled || explicitlyHealthy ? { disabled } : {}),
          lastWebhookAt: new Date(event.eventTimestamp),
        },
      });
      status = "PROCESSED";
    }

    try {
      await this.prisma.webhookEvent.create({
        data: {
          appUserId: owner?.id ?? null,
          snapTradeUserId: event.snapTradeUserId,
          snapTradeWebhookId: event.webhookId,
          eventType: event.eventType,
          bodyDigest: event.bodyDigest,
          payload: event.payload,
          status,
          processedAt: this.now(),
        },
      });
      return "created";
    } catch (error) {
      if (isUniqueConstraintError(error)) return "duplicate";
      throw error;
    }
  }
}
