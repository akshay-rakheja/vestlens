import type { StoredFact } from "./memory-types.js";

/**
 * Forgiving text recall (staging walkthrough, 2026-10-24): a query becomes tokens, and a fact matches when any token
 * appears in its text, node key or property, case-insensitively (accents significant). Facts rank by how many tokens they match, then newest.
 * The repository applies the same match in Postgres (an OR of ILIKE conditions); the service ranks with matchCount.
 */

export const MAX_QUERY_TOKENS = 12;
const MIN_TOKEN = 3;

/** Common English words that carry no topic in a recall query. Tokens under three characters are dropped anyway. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "are", "was", "were", "with", "what", "when", "where", "which", "who", "whom", "why", "how",
  "that", "this", "these", "those", "from", "about", "into", "onto", "have", "has", "had", "you", "your", "yours",
  "our", "ours", "they", "them", "their", "his", "her", "hers", "its", "not", "but", "all", "any", "can", "did", "does",
  "doing", "done", "will", "would", "should", "could", "there", "here", "then", "than", "also", "just", "some", "more",
  "most", "very", "been", "being", "mine", "myself", "out", "off", "over", "under", "again", "once", "too", "each",
  "only", "own", "same", "such", "both", "few", "other", "let", "lets", "get", "got", "say", "said", "tell", "told",
  "know", "remember", "recall", "anything", "something", "thing", "things", "please",
]);

/**
 * Lower-cased and split on anything that isn't a letter or digit in any script. Accents are kept, so "épargne" finds
 * "épargne": Postgres ILIKE and matchCount compare case-insensitively, never accent-insensitively. Tokens under three
 * characters and stopwords are dropped; the first occurrence is kept. Tokens never contain ILIKE wildcards.
 */
export function queryTokens(text: string): string[] {
  const lowered = text.normalize("NFC").toLowerCase();
  const tokens: string[] = [];
  for (const t of lowered.split(/[^\p{L}\p{N}]+/u)) {
    if ([...t].length < MIN_TOKEN || STOPWORDS.has(t) || tokens.includes(t)) continue;
    tokens.push(t);
    if (tokens.length === MAX_QUERY_TOKENS) break;
  }
  return tokens;
}

const HEX_ONLY = /^[0-9a-f]+$/;
/** Node types whose keys are hashes (outside:<slug> accounts excepted). */
export const HASHED_KEY_TYPES = ["account", "activity"] as const;
export const OUTSIDE_KEY_PREFIX = "outside:";

/** A hex-only token ("cafe", "2028") would match hashed account and activity keys by chance, so it never does. */
export function tokenMayMatchHashedKeys(token: string): boolean {
  return !HEX_ONLY.test(token);
}

function matches(row: Pick<StoredFact, "text" | "nodeKey" | "nodeType" | "property">, token: string): boolean {
  if (row.text.normalize("NFC").toLowerCase().includes(token) || row.property.toLowerCase().includes(token)) return true;
  if (!row.nodeKey.toLowerCase().includes(token)) return false;
  const hashed = (HASHED_KEY_TYPES as readonly string[]).includes(row.nodeType) && !row.nodeKey.startsWith(OUTSIDE_KEY_PREFIX);
  return !hashed || tokenMayMatchHashedKeys(token);
}

/** How many of the tokens the fact matches. */
export function matchCount(row: Pick<StoredFact, "text" | "nodeKey" | "nodeType" | "property">, tokens: readonly string[]): number {
  return tokens.reduce((n, t) => n + (matches(row, t) ? 1 : 0), 0);
}
