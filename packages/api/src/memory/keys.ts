import { createHash } from "node:crypto";

/**
 * Stable memory node keys for brokerage-backed things. Shared by the memory store, the context builder and the
 * TFSA room guard; never re-derive them elsewhere. Neither reveals the underlying provider id.
 */

const hash16 = (input: string) => createHash("sha256").update(input).digest("hex").slice(0, 16);

/** First 16 hex of sha256("acct:" + snapTradeAccountId); persists across reconnects of the same account. */
export function accountKey(snapTradeAccountId: string): string {
  return hash16(`acct:${snapTradeAccountId}`);
}

/** First 16 hex of sha256("act:" + dedupeKey); survives resyncs because the stored dedupeKey does. */
export function activityKey(dedupeKey: string): string {
  return hash16(`act:${dedupeKey}`);
}

export const HASH_KEY_PATTERN = /^[0-9a-f]{16}$/;

export function isHashKey(key: string): boolean {
  return HASH_KEY_PATTERN.test(key);
}

const OUTSIDE_SLUG_MAX = 60;

/**
 * The node key of a declared outside account, `outside:<slug>` (spec §5.1; node `account:outside:<slug>`). The slug
 * is deterministic: accents folded, lower-cased, every run of other characters becomes one "-", trimmed, at most
 * 60 characters. A label with nothing left (e.g. only punctuation) gets the first 8 hex of sha256("outside:" + label).
 * The account set keeps the human label; this key only links it to its year-to-date contributions fact.
 */
export function outsideAccountKey(label: string): string {
  return `outside:${memorySlug(label, "outside:")}`;
}

/**
 * A deterministic slug for a node key (outside accounts, and the rule:<slug> and goal:<slug> keys of typed limits and
 * goals): accents folded, lower-cased, every run of other characters one "-", trimmed, at most 60 characters. A label
 * with nothing left gets the first 8 hex of sha256(namespace + label).
 */
export function memorySlug(label: string, namespace = ""): string {
  const slug = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, OUTSIDE_SLUG_MAX)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : createHash("sha256").update(`${namespace}${label}`).digest("hex").slice(0, 8);
}
