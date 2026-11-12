import { createHash } from "node:crypto";

import { WebhookRejectedError, verifySnapTradeWebhook } from "./webhook-verifier.js";

/** A short, non-reversible tag for a claimed client ID, so a rejected webhook can be logged without the ID. */
const snapTradeClientTag = (clientId: string) => createHash("sha256").update(clientId).digest("hex").slice(0, 16);

export interface VerifiedWebhookRecord {
  webhookId: string;
  snapTradeUserId: string;
  eventType: string;
  eventTimestamp: string;
  bodyDigest: string;
  payload: Record<string, unknown>;
}

export interface WebhookChange {
  snapTradeUserId: string;
  eventType: string;
  /** The connection the event names, when the payload carries one. */
  brokerageAuthorizationId?: string;
}

export interface WebhookEventRepository {
  recordVerifiedEvent(
    event: VerifiedWebhookRecord,
  ): Promise<"created" | "duplicate">;
}

export class InvalidSnapTradeWebhookError extends Error {
  constructor() {
    super("Invalid SnapTrade webhook");
    this.name = "InvalidSnapTradeWebhookError";
  }
}

export class WebhookIngestionService {
  private readonly repository: WebhookEventRepository;
  private readonly consumerKey: string;
  private readonly clientId: string;
  private readonly now: () => Date;
  private readonly onRecorded?: (event: WebhookChange) => Promise<void> | void;

  constructor(options: {
    repository: WebhookEventRepository;
    consumerKey: string;
    clientId: string;
    now?: () => Date;
    /** Called after a new verified event is stored, e.g. to evict cached portfolios. */
    onRecorded?: (event: WebhookChange) => Promise<void> | void;
  }) {
    this.repository = options.repository;
    this.consumerKey = options.consumerKey;
    this.clientId = options.clientId;
    this.now = options.now ?? (() => new Date());
    this.onRecorded = options.onRecorded;
  }

  async ingest(
    rawBody: string,
    signature: string | undefined,
  ): Promise<{ duplicate: boolean }> {
    let event;
    try {
      event = verifySnapTradeWebhook({
        rawBody,
        signature,
        consumerKey: this.consumerKey,
        expectedClientId: this.clientId,
        now: this.now(),
      });
    } catch (error) {
      // Counts only: the reason code and, when the body names a client, that client's tag (a hash prefix, not the ID),
      // so a retired client still sending webhooks is told apart from a real signature fault.
      const reason = error instanceof WebhookRejectedError ? error.reason : "payload";
      let bodyClientTag: string | null = null;
      try {
        const claimed = (JSON.parse(rawBody) as { clientId?: unknown }).clientId;
        if (typeof claimed === "string" && claimed) bodyClientTag = snapTradeClientTag(claimed);
      } catch {
        // unparsable body: no tag
      }
      console.warn(JSON.stringify({ event: "snaptrade_webhook_rejected", reason, bodyClientTag, hasSignature: Boolean(signature) }));
      throw new InvalidSnapTradeWebhookError();
    }
    const { webhookSecret: _discardedWebhookSecret, ...safePayload } = event;
    const result = await this.repository.recordVerifiedEvent({
      webhookId: event.webhookId,
      snapTradeUserId: event.userId,
      eventType: event.eventType,
      eventTimestamp: event.eventTimestamp,
      bodyDigest: createHash("sha256").update(rawBody).digest("hex"),
      payload: safePayload,
    });

    if (result === "created" && this.onRecorded) {
      try {
        const authorizationId = safePayload.brokerageAuthorizationId;
        await this.onRecorded({
          snapTradeUserId: event.userId,
          eventType: event.eventType,
          ...(typeof authorizationId === "string" && authorizationId ? { brokerageAuthorizationId: authorizationId } : {}),
        });
      } catch {
        // The event is already durable; a missed eviction only delays freshness to the cache TTL.
      }
    }
    return { duplicate: result === "duplicate" };
  }
}
