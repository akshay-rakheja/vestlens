import { createHash } from "node:crypto";
import { normalizeActivities } from "../portfolio/history-normalize.js";

export interface StoredActivity {
  snapTradeAccountId: string;
  dedupeKey: string;
  type: string;
  symbol: string | null;
  securityCurrency: string | null;
  /** True when SnapTrade reported an option_symbol (option trades can be typed BUY/SELL). */
  isOption: boolean;
  units: number | null;
  price: number | null;
  amount: number | null;
  fee: number | null;
  fxRate: number | null;
  currency: string | null;
  tradeDate: string | null;
  settlementDate: string | null;
  description: string | null;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function day(value: string | null): string | null {
  return value ? value.slice(0, 10) : null;
}

function isOptionOf(rawItem: unknown): boolean {
  const o = (rawItem as { option_symbol?: unknown } | null)?.option_symbol;
  return o !== null && o !== undefined && typeof o === "object";
}

function securityCurrencyOf(rawItem: unknown): string | null {
  const symbol = (rawItem as { symbol?: { currency?: { code?: unknown } | null } | null } | null)?.symbol;
  const code = symbol?.currency?.code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

export function toStoredActivities(
  accountId: string,
  response: unknown,
): { items: StoredActivity[]; total: number | null; dropped: number } {
  const normalized = normalizeActivities(response);
  const rawData = (response as { data?: unknown[] } | null)?.data ?? [];
  const items: StoredActivity[] = [];
  let dropped = 0;
  const seen = new Map<string, number>();

  normalized.items.forEach((activity, index) => {
    const tradeDate = day(activity.tradeDate);
    const settlementDate = day(activity.settlementDate);
    if (!tradeDate && !settlementDate) {
      dropped += 1;
      return;
    }
    const type = activity.type.toUpperCase();
    let dedupeKey: string;
    if (activity.id) {
      dedupeKey = sha256(JSON.stringify(["id", accountId, activity.id]));
    } else {
      const description = activity.description === null ? null : activity.description.trim().replace(/\s+/g, " ");
      const base = sha256(
        JSON.stringify([
          "row", accountId, type, tradeDate, settlementDate, activity.symbol,
          activity.units, activity.price, activity.amount, activity.fee, activity.currency, description,
        ]),
      );
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      dedupeKey = n === 0 ? base : sha256(`${base}:${n}`);
    }
    items.push({
      snapTradeAccountId: accountId,
      dedupeKey,
      type,
      symbol: activity.symbol,
      securityCurrency: securityCurrencyOf(rawData[index]),
      isOption: isOptionOf(rawData[index]),
      units: activity.units,
      price: activity.price,
      amount: activity.amount,
      fee: activity.fee,
      fxRate: activity.fxRate,
      currency: activity.currency,
      tradeDate,
      settlementDate,
      description: activity.description,
    });
  });

  // M3: only a provider-reported total bounds paging; otherwise callers rely on the short-page check.
  const reported = (response as { pagination?: { total?: unknown } | null } | null)?.pagination?.total;
  const total = typeof reported === "number" && Number.isFinite(reported) ? reported : null;
  return { items, total, dropped };
}
