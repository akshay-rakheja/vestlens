import { describe, expect, it } from "vitest";

import { verifySnapTradeWebhook } from "./webhook-verifier.js";

const payload = {
  webhookId: "webhook-123",
  userId: "app-user-8d1a",
  eventType: "ACCOUNT_HOLDINGS_UPDATED",
  eventTimestamp: "2026-08-19T17:00:00.000Z",
  details: {
    positions: { success: true, error: null },
    balances: { success: true, error: null },
  },
  clientId: "commercial-client",
};

const signature = "BXWdi2LIQ3P5mVa+UBu5iO44wTzVpp6XcX802mDIR6E=";

describe("verifySnapTradeWebhook", () => {
  it("accepts a current event signed from canonical sorted JSON", () => {
    const event = verifySnapTradeWebhook({
      rawBody: JSON.stringify(payload),
      signature,
      consumerKey: "consumer-secret",
      expectedClientId: "commercial-client",
      now: new Date("2026-08-19T17:03:00.000Z"),
    });

    expect(event.webhookId).toBe("webhook-123");
    expect(event.eventType).toBe("ACCOUNT_HOLDINGS_UPDATED");
    expect(event.userId).toBe("app-user-8d1a");
  });

  it("rejects a modified event with the original signature", () => {
    const modified = { ...payload, userId: "app-user-other" };

    expect(() =>
      verifySnapTradeWebhook({
        rawBody: JSON.stringify(modified),
        signature,
        consumerKey: "consumer-secret",
        expectedClientId: "commercial-client",
        now: new Date("2026-08-19T17:03:00.000Z"),
      }),
    ).toThrow(/signature/i);
  });

  it("rejects a correctly signed event outside the replay window", () => {
    expect(() =>
      verifySnapTradeWebhook({
        rawBody: JSON.stringify(payload),
        signature,
        consumerKey: "consumer-secret",
        expectedClientId: "commercial-client",
        now: new Date("2026-08-19T17:06:00.001Z"),
      }),
    ).toThrow(/timestamp/i);
  });

  it("rejects an event for a different SnapTrade client", () => {
    expect(() =>
      verifySnapTradeWebhook({
        rawBody: JSON.stringify(payload),
        signature,
        consumerKey: "consumer-secret",
        expectedClientId: "different-client",
        now: new Date("2026-08-19T17:03:00.000Z"),
      }),
    ).toThrow(/client/i);
  });
});
