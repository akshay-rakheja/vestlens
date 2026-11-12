import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

const webhookSchema = z
  .object({
    webhookId: z.string().min(1),
    clientId: z.string().min(1),
    eventTimestamp: z.iso.datetime({ offset: true }),
    eventType: z.string().min(1),
    userId: z.string().min(1),
  })
  .loose();

export type SnapTradeWebhookEvent = z.infer<typeof webhookSchema>;

export interface VerifySnapTradeWebhookInput {
  rawBody: string;
  signature: string | undefined;
  consumerKey: string;
  expectedClientId: string;
  now?: Date;
  maxAgeMs?: number;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }

  return value;
}

/** Why a webhook was refused: a fixed code, never the body, for the counts-only rejection log. */
export type WebhookRejectReason = "payload" | "signature" | "client" | "replay";
export class WebhookRejectedError extends Error {
  constructor(readonly reason: WebhookRejectReason, message: string) {
    super(message);
    this.name = "WebhookRejectedError";
  }
}

function signaturesMatch(expected: Buffer, received: string | undefined): boolean {
  if (!received) return false;

  try {
    const decoded = Buffer.from(received, "base64");
    return (
      decoded.length === expected.length && timingSafeEqual(decoded, expected)
    );
  } catch {
    return false;
  }
}

export function verifySnapTradeWebhook(
  input: VerifySnapTradeWebhookInput,
): SnapTradeWebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    throw new WebhookRejectedError("payload", "Invalid SnapTrade webhook payload");
  }

  const canonicalBody = JSON.stringify(canonicalize(parsed));
  const expectedSignature = createHmac("sha256", input.consumerKey)
    .update(canonicalBody)
    .digest();

  if (!signaturesMatch(expectedSignature, input.signature)) {
    throw new WebhookRejectedError("signature", "SnapTrade webhook signature verification failed");
  }

  const eventResult = webhookSchema.safeParse(parsed);
  if (!eventResult.success) {
    throw new WebhookRejectedError("payload", "Invalid SnapTrade webhook payload");
  }

  if (eventResult.data.clientId !== input.expectedClientId) {
    throw new WebhookRejectedError("client", "SnapTrade webhook client ID does not match");
  }

  const nowMs = (input.now ?? new Date()).getTime();
  const eventMs = new Date(eventResult.data.eventTimestamp).getTime();
  const maxAgeMs = input.maxAgeMs ?? 5 * 60 * 1000;
  if (!Number.isFinite(eventMs) || Math.abs(nowMs - eventMs) > maxAgeMs) {
    throw new WebhookRejectedError("replay", "SnapTrade webhook timestamp is outside the replay window");
  }

  return eventResult.data;
}
