import { symbolAliases } from "./marketaux.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const REFRESH_MS = 6 * HOUR_MS;
export const DEFAULT_PAGES = 3;

export type KnownAliases = Map<string, { usSymbol?: string | null }>;

/** Marketaux requests the fetcher will spend on a held symbol: one per alias per page (worst case). */
export function estimateRequests(symbol: string, known?: { usSymbol?: string | null }, pages = DEFAULT_PAGES): number {
  return symbolAliases(symbol, known).length * pages;
}

export function planFetches(o: {
  symbols: Array<{ symbol: string; isMover: boolean; isConstituent: boolean }>;
  lastFetch: Map<string, Date | null>;
  budgetLeft: number;
  now: Date;
  freeTier: boolean;
  known?: KnownAliases;
  /** Pages estimated per alias; defaults to 1 on the free tier, 3 otherwise. */
  pages?: number;
  /** Marketaux `limit`; defaults to 3 on the free tier, 20 otherwise. */
  pageSize?: number;
}): Array<{ symbol: string; since: Date; requests: number; pageSize: number }> {
  const pages = o.pages ?? (o.freeTier ? 1 : DEFAULT_PAGES);
  const pageSize = o.pageSize ?? (o.freeTier ? 3 : 20);
  const t = o.now.getTime();
  const since = new Date(t - (o.freeTier ? 7 : 30) * DAY_MS);
  const seen = new Set<string>();
  const candidates: Array<{ symbol: string; tier: number; last: number }> = [];
  for (const s of o.symbols) {
    if (seen.has(s.symbol)) continue;
    seen.add(s.symbol);
    const last = o.lastFetch.get(s.symbol) ?? null;
    if (last && t - last.getTime() < REFRESH_MS) continue;
    candidates.push({ symbol: s.symbol, tier: s.isMover ? 0 : s.isConstituent ? 2 : 1, last: last ? last.getTime() : -Infinity });
  }
  candidates.sort((a, b) => a.tier - b.tier || a.last - b.last);
  const plan: Array<{ symbol: string; since: Date; requests: number; pageSize: number }> = [];
  let left = o.budgetLeft;
  for (const c of candidates) {
    const requests = estimateRequests(c.symbol, o.known?.get(c.symbol), pages);
    if (requests > left) break;
    left -= requests;
    plan.push({ symbol: c.symbol, since, requests, pageSize });
  }
  return plan;
}
