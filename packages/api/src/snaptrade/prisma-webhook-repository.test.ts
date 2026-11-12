import { describe, expect, it, vi } from "vitest";

import type { VerifiedWebhookRecord } from "./webhook-ingestion-service.js";
import { PrismaWebhookEventRepository } from "./prisma-webhook-repository.js";

const event: VerifiedWebhookRecord = {
  webhookId: "webhook-123",
  snapTradeUserId: "portfolio_user-123",
  eventType: "CONNECTION_ADDED",
  eventTimestamp: "2026-08-20T15:30:00.000Z",
  bodyDigest: "a".repeat(64),
  payload: { brokerageAuthorizationId: "connection-1" },
};

function client() {
  return {
    appUser: { findUnique: vi.fn() },
    brokerageConnection: { upsert: vi.fn() },
    webhookEvent: { create: vi.fn() },
  };
}

describe("PrismaWebhookEventRepository", () => {
  it("links a verified webhook to its owning app user", async () => {
    const prisma = client();
    prisma.appUser.findUnique.mockResolvedValue({ id: "app-user-1" });
    prisma.brokerageConnection.upsert.mockResolvedValue({ id: "connection-1" });
    prisma.webhookEvent.create.mockResolvedValue({ id: "event-1" });
    const repository = new PrismaWebhookEventRepository(
      prisma,
      () => new Date("2026-08-20T15:31:00.000Z"),
    );

    await expect(repository.recordVerifiedEvent(event)).resolves.toBe("created");
    expect(prisma.appUser.findUnique).toHaveBeenCalledWith({
      where: { authSubject: "owner" },
      select: { id: true },
    });
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith({
      data: {
        appUserId: "app-user-1",
        snapTradeUserId: event.snapTradeUserId,
        snapTradeWebhookId: event.webhookId,
        eventType: event.eventType,
        bodyDigest: event.bodyDigest,
        payload: event.payload,
        status: "PROCESSED",
        processedAt: new Date("2026-08-20T15:31:00.000Z"),
      },
    });
    expect(prisma.brokerageConnection.upsert).toHaveBeenCalledWith({
      where: {
        appUserId_snapTradeConnectionId: {
          appUserId: "app-user-1",
          snapTradeConnectionId: "connection-1",
        },
      },
      create: {
        appUserId: "app-user-1",
        snapTradeConnectionId: "connection-1",
        disabled: false,
        lastWebhookAt: new Date("2026-08-20T15:30:00.000Z"),
      },
      update: {
        disabled: false,
        lastWebhookAt: new Date("2026-08-20T15:30:00.000Z"),
      },
    });
  });

  it("marks a known connection disabled after a signed broken event", async () => {
    const prisma = client();
    prisma.appUser.findUnique.mockResolvedValue({ id: "app-user-1" });
    prisma.brokerageConnection.upsert.mockResolvedValue({ id: "connection-1" });
    prisma.webhookEvent.create.mockResolvedValue({ id: "event-1" });
    const repository = new PrismaWebhookEventRepository(prisma);

    await repository.recordVerifiedEvent({
      ...event,
      webhookId: "webhook-broken",
      eventType: "CONNECTION_BROKEN",
    });

    expect(prisma.brokerageConnection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ disabled: true }),
        update: expect.objectContaining({ disabled: true }),
      }),
    );
  });

  it("does not recreate a deleted connection as a disabled stub", async () => {
    const prisma = client();
    prisma.appUser.findUnique.mockResolvedValue({ id: "user-1" });
    prisma.webhookEvent.create.mockResolvedValue({ id: "event-1" });
    const repository = new PrismaWebhookEventRepository(prisma, () => new Date("2026-08-20T15:31:00.000Z"));

    await repository.recordVerifiedEvent({ ...event, webhookId: "webhook-deleted", eventType: "CONNECTION_DELETED" });

    expect(prisma.brokerageConnection.upsert).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: "CONNECTION_DELETED", status: "PROCESSED" }),
    });
  });

  it("stores an unmatched event as ignored without inventing an owner", async () => {
    const prisma = client();
    prisma.appUser.findUnique.mockResolvedValue(null);
    prisma.webhookEvent.create.mockResolvedValue({ id: "event-1" });
    const repository = new PrismaWebhookEventRepository(
      prisma,
      () => new Date("2026-08-20T15:31:00.000Z"),
    );

    await repository.recordVerifiedEvent(event);

    expect(prisma.brokerageConnection.upsert).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        appUserId: null,
        status: "IGNORED",
        processedAt: new Date("2026-08-20T15:31:00.000Z"),
      }),
    });
  });

  it("treats a unique webhook ID conflict as an acknowledged duplicate", async () => {
    const prisma = client();
    prisma.appUser.findUnique.mockResolvedValue({ id: "app-user-1" });
    prisma.webhookEvent.create.mockRejectedValue({ code: "P2002" });
    const repository = new PrismaWebhookEventRepository(prisma);

    await expect(repository.recordVerifiedEvent(event)).resolves.toBe(
      "duplicate",
    );
  });

  it("durably records a confirmed pending disconnect before the CONNECTION_DELETED receipt", async () => {
    const order: string[] = [];
    const prisma = {
      ...client(),
      pendingDisconnect: { upsert: vi.fn(async () => { order.push("marker"); return {}; }) },
    };
    prisma.appUser.findUnique.mockResolvedValue({ id: "app-user-1" });
    prisma.webhookEvent.create.mockImplementation(async () => { order.push("receipt"); return { id: "event-1" }; });
    const repository = new PrismaWebhookEventRepository(prisma, () => new Date("2026-08-20T15:31:00.000Z"));

    await expect(repository.recordVerifiedEvent({ ...event, webhookId: "webhook-deleted-2", eventType: "CONNECTION_DELETED" })).resolves.toBe("created");

    expect(prisma.pendingDisconnect.upsert).toHaveBeenCalledWith({
      where: { appUserId_snapTradeConnectionId: { appUserId: "app-user-1", snapTradeConnectionId: "connection-1" } },
      create: {
        appUserId: "app-user-1", snapTradeConnectionId: "connection-1",
        requestedAt: new Date("2026-08-20T15:31:00.000Z"), confirmedAt: new Date("2026-08-20T15:31:00.000Z"),
      },
      update: { confirmedAt: new Date("2026-08-20T15:31:00.000Z") },
    });
    expect(order).toEqual(["marker", "receipt"]);
  });

  it("stores no receipt when the marker cannot be written, so SnapTrade's redelivery is not a duplicate", async () => {
    const prisma = {
      ...client(),
      pendingDisconnect: { upsert: vi.fn(async () => { throw new Error("synthetic database outage"); }) },
    };
    prisma.appUser.findUnique.mockResolvedValue({ id: "app-user-1" });
    const repository = new PrismaWebhookEventRepository(prisma);

    await expect(repository.recordVerifiedEvent({ ...event, webhookId: "webhook-deleted-3", eventType: "CONNECTION_DELETED" })).rejects.toThrow();
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });
});
