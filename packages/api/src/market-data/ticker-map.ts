const PRICED_KINDS = new Set(["stock", "etf", "mutualfund", "crypto", "equity", "cs", "et"]);
/**
 * Kinds whose provider price history is trusted (stock, ETF, crypto, in the same vocabulary as
 * PRICED_KINDS). Any other kind is valued at the brokerage-reported price (price sanity guard).
 */
const TRUSTED_PRICE_KINDS = new Set(["stock", "etf", "crypto", "equity", "cs", "et"]);
export function isTrustedPriceKind(kind: string): boolean { return TRUSTED_PRICE_KINDS.has(kind.trim().toLowerCase()); }
/** Provider close over reported price outside [0.5, 1.5] means the history belongs to another security. */
export const PRICE_SANITY_MIN = 0.5;
export const PRICE_SANITY_MAX = 1.5;
export function priceOutOfRange(ratio: number): boolean { return !Number.isFinite(ratio) || ratio < PRICE_SANITY_MIN || ratio > PRICE_SANITY_MAX; }
export function providerTicker(input: { symbol: string; kind: string; currency: string | null }): string | null {
  const symbol = input.symbol.trim().toUpperCase();
  const kind = input.kind.trim().toLowerCase();
  if (!PRICED_KINDS.has(kind) || !/^[A-Z0-9.\-^]{1,20}$/.test(symbol)) return null;
  if (kind === "crypto") {
    if (!input.currency) return null;
    return `${symbol.replace(/-.*$/, "")}-${input.currency.trim().toUpperCase()}`;
  }
  return symbol;
}
const STOOQ: Record<string, string> = { "^GSPC": "^spx", "^NDX": "^ndx", "^DJI": "^dji", "^GSPTSE": "^tsx" };
export function stooqTicker(yahooTicker: string): string | null { return STOOQ[yahooTicker] ?? null; }
