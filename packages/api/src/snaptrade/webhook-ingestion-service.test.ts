import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  WebhookIngestionService,
  type VerifiedWebhookRecord,
} from "./webhook-ingestion-service.js";

const payload = {
  webhookId: "webhook-123",
  userId: "portfolio_00000000-0000-4000-8000-0000000000c1",
  eventType: "ACCOUNT_HOLDINGS_UPDATED",
  eventTimestamp: "2026-08-19T17:00:00.000Z",
  clientId: "commercial-client",
  webhookSecret: "deprecated-secret-must-not-be-stored",
  accountId: "account-1",
};
const rawBody = JSON.stringify(payload);
const signature = "jY/0IaZbqaajFrkiMDk5ks+zqR90vAOXYhqzpWUNZaY=";

describe("WebhookIngestionService", () => {
  it("verifies and records a sanitized event idempotently", async () => {
    const repository = {
      recordVerifiedEvent: vi.fn(
        async (_event: VerifiedWebhookRecord) => "created" as const,
      ),
    };
    const service = new WebhookIngestionService({
      repository,
      consumerKey: "consumer-secret",
      clientId: "commercial-client",
      now: () => new Date("2026-08-19T17:03:00.000Z"),
    });

    await expect(service.ingest(rawBody, signature)).resolves.toEqual({
      duplicate: false,
    });
    expect(repository.recordVerifiedEvent).toHaveBeenCalledOnce();
    const recorded = repository.recordVerifiedEvent.mock.calls[0][0];
    expect(recorded).toMatchObject({
      webhookId: "webhook-123",
      snapTradeUserId: payload.userId,
      eventType: "ACCOUNT_HOLDINGS_UPDATED",
      eventTimestamp: "2026-08-19T17:00:00.000Z",
      payload: {
        accountId: "account-1",
        clientId: "commercial-client",
        eventType: "ACCOUNT_HOLDINGS_UPDATED",
        eventTimestamp: "2026-08-19T17:00:00.000Z",
        userId: payload.userId,
        webhookId: "webhook-123",
      },
    });
    expect(recorded.payload).not.toHaveProperty("webhookSecret");
    expect(recorded.bodyDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("acknowledges a repository-detected duplicate", async () => {
    const repository = {
      recordVerifiedEvent: vi.fn(
        async (_event: VerifiedWebhookRecord) => "duplicate" as const,
      ),
    };
    const service = new WebhookIngestionService({
      repository,
      consumerKey: "consumer-secret",
      clientId: "commercial-client",
      now: () => new Date("2026-08-19T17:03:00.000Z"),
    });

    await expect(service.ingest(rawBody, signature)).resolves.toEqual({
      duplicate: true,
    });
  });

  it("does not persist an event with an invalid signature", async () => {
    const repository = { recordVerifiedEvent: vi.fn() };
    const service = new WebhookIngestionService({
      repository,
      consumerKey: "consumer-secret",
      clientId: "commercial-client",
      now: () => new Date("2026-08-19T17:03:00.000Z"),
    });

    await expect(service.ingest(rawBody, "invalid")).rejects.toThrow(
      /webhook/i,
    );
    expect(repository.recordVerifiedEvent).not.toHaveBeenCalled();
  });
});

describe("WebhookIngestionService change notifications", () => {
  function service(result: "created" | "duplicate", onRecorded: (event: { snapTradeUserId: string; eventType: string; brokerageAuthorizationId?: string }) => Promise<void> | void) {
    return new WebhookIngestionService({
      repository: { recordVerifiedEvent: vi.fn(async () => result) },
      consumerKey: "consumer-secret",
      clientId: "commercial-client",
      now: () => new Date("2026-08-19T17:03:00.000Z"),
      onRecorded,
    });
  }

  it("notifies once for a newly recorded event", async () => {
    const onRecorded = vi.fn();
    await service("created", onRecorded).ingest(rawBody, signature);
    expect(onRecorded).toHaveBeenCalledWith({ snapTradeUserId: payload.userId, eventType: "ACCOUNT_HOLDINGS_UPDATED" });
  });

  it("passes the named connection on for a deletion event", async () => {
    const deleted = {
      webhookId: "webhook-456",
      userId: payload.userId,
      eventType: "CONNECTION_DELETED",
      eventTimestamp: "2026-08-19T17:00:00.000Z",
      clientId: "commercial-client",
      brokerageAuthorizationId: "invented-connection-1",
    };
    const body = JSON.stringify(deleted);
    const canonical = JSON.stringify(Object.fromEntries(Object.entries(deleted).sort(([a], [b]) => a.localeCompare(b))));
    const signed = createHmac("sha256", "consumer-secret").update(canonical).digest("base64");
    const onRecorded = vi.fn();

    await service("created", onRecorded).ingest(body, signed);

    expect(onRecorded).toHaveBeenCalledWith({
      snapTradeUserId: payload.userId,
      eventType: "CONNECTION_DELETED",
      brokerageAuthorizationId: "invented-connection-1",
    });
  });

  it("does not notify for duplicates", async () => {
    const onRecorded = vi.fn();
    await service("duplicate", onRecorded).ingest(rawBody, signature);
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it("a failing notification does not fail an already recorded webhook", async () => {
    const onRecorded = vi.fn(async () => { throw new Error("synthetic invalidation failure"); });
    await expect(service("created", onRecorded).ingest(rawBody, signature)).resolves.toEqual({ duplicate: false });
  });

  it("logs only why a webhook was refused and the claimed client's tag", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const repository = { recordVerifiedEvent: vi.fn(async (_event: VerifiedWebhookRecord) => "created" as const) };
    const service = new WebhookIngestionService({
      repository, consumerKey: "consumer-secret", clientId: "commercial-client", now: () => new Date("2026-08-19T17:03:00.000Z"),
    });
    await expect(service.ingest(rawBody, "bm90LXRoZS1zaWduYXR1cmU=")).rejects.toThrow();
    await expect(service.ingest("{not json", signature)).rejects.toThrow();
    const late = new WebhookIngestionService({
      repository, consumerKey: "consumer-secret", clientId: "commercial-client", now: () => new Date("2026-08-20T17:03:00.000Z"),
    });
    await expect(late.ingest(rawBody, signature)).rejects.toThrow();
    const logged = warn.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(logged.map((l) => l.reason)).toEqual(["signature", "payload", "replay"]);
    expect(logged[0].bodyClientTag).toMatch(/^[0-9a-f]{16}$/);
    expect(logged[1].bodyClientTag).toBeNull();
    const text = JSON.stringify(warn.mock.calls);
    for (const secret of ["commercial-client", payload.userId, payload.webhookSecret, "account-1"]) expect(text).not.toContain(secret);
    expect(repository.recordVerifiedEvent).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
