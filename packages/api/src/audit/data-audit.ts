/**
 * Counts-only data audit: what the stored brokerage data actually contains, so
 * the next analytics features are grounded in fields that are really filled. The output holds counts, buckets and
 * fixed enum-like labels only: never amounts, symbols, account ids or names, dates, descriptions, or user identifiers.
 */

export interface AuditAccount { appUserId: string; snapTradeAccountId: string; institutionName: string; rawType: string | null; category: string | null; status: string | null }
export interface AuditActivity {
  appUserId: string; snapTradeAccountId: string; type: string; symbolPresent: boolean; securityCurrency: string | null; currency: string | null;
  units: number | null; price: number | null; amount: number | null; fee: number | null; fxRate: number | null; tradeDate: string | null; description: string | null;
}
export interface AuditSync { appUserId: string; snapTradeAccountId: string; backfillCompleted: boolean; lastSyncedAt: string | null; lastError: boolean; earliestTradeDate: string | null }
export interface AuditInput { today: string; users: number; accounts: AuditAccount[]; activities: AuditActivity[]; sync: AuditSync[]; dailyValueDaysPerUser: number[]; snapshotCount: number }

const LABEL = /^[A-Za-z0-9 _./&()-]{1,40}$/;
/** An enum-like label is kept; anything else (free text, long or odd strings) is reported as "other". */
export const safeLabel = (s: string | null | undefined): string => (s && LABEL.test(s.trim()) ? s.trim().toUpperCase() : s ? "OTHER" : "NONE");

const tally = (into: Record<string, number>, key: string) => { into[key] = (into[key] ?? 0) + 1; };
const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

/** Days of history bucketed so no exact dates leave the audit. */
export function historyBucket(earliest: string | null, today: string): string {
  if (!earliest) return "none";
  const days = dayNumber(today) - dayNumber(earliest);
  if (days < 0) return "future";
  if (days <= 31) return "≤1 month";
  if (days <= 92) return "1–3 months";
  if (days <= 366) return "3–12 months";
  if (days <= 731) return "1–2 years";
  if (days <= 1826) return "2–5 years";
  return ">5 years";
}

const TRANSFER = /^(INTERNAL_CASH_TRANSFER|TRANSFER)/;
const PAIR_DAYS = 3;
const KEYWORDS = { withholding: /withholding|non-?resident tax/i, conversion: /conver|exchange|\bfx\b/i, fee: /\bfee\b|commission/i, contribution: /contribut|deposit/i };

export function auditCounts(input: AuditInput) {
  const accountType: Record<string, number> = {};
  const accountCategory: Record<string, number> = {};
  const institution: Record<string, number> = {};
  const accountKind = new Map<string, string>();
  for (const a of input.accounts) {
    tally(accountType, safeLabel(a.rawType));
    tally(accountCategory, safeLabel(a.category));
    tally(institution, safeLabel(a.institutionName));
    accountKind.set(`${a.appUserId}\u0000${a.snapTradeAccountId}`, safeLabel(a.rawType));
  }

  const byType: Record<string, number> = {};
  const currency: Record<string, number> = {};
  const fieldsFilled = { symbol: 0, securityCurrency: 0, units: 0, price: 0, amount: 0, feeNonZero: 0, fxRate: 0, tradeDate: 0, description: 0 };
  const descriptionMentions = { withholding: 0, conversion: 0, fee: 0, contribution: 0 };
  const foreignSecurityInCadRows = { total: 0, withFxRate: 0 };
  // |amount| / (units × price) on those trades, bucketed: ~1 means price is in the account currency; ~1.3-1.45 means
  // price is in the security's (USD) currency. Settles which convention the stored rows follow.
  const priceRatio: Record<string, number> = {};
  const ratioBucket = (r: number) =>
    r < 0.95 ? "<0.95" : r <= 1.05 ? "0.95-1.05" : r < 1.25 ? "1.05-1.25" : r < 1.3 ? "1.25-1.30" : r < 1.35 ? "1.30-1.35" : r < 1.4 ? "1.35-1.40" : r < 1.45 ? "1.40-1.45" : ">=1.45";
  const dividends = { total: 0, usd: 0, usdWithTaxRowSameDay: 0 };
  const perAccountEarliest = new Map<string, string>();
  const taxRowsByKeyDay = new Set<string>();
  for (const r of input.activities) if (/^(TAX|WITHHOLDING)/.test(r.type) && r.tradeDate) taxRowsByKeyDay.add(`${r.appUserId}\u0000${r.snapTradeAccountId}\u0000${r.tradeDate}`);

  for (const r of input.activities) {
    tally(byType, safeLabel(r.type));
    tally(currency, safeLabel(r.currency));
    if (r.symbolPresent) fieldsFilled.symbol++;
    if (r.securityCurrency) fieldsFilled.securityCurrency++;
    if (r.units !== null) fieldsFilled.units++;
    if (r.price !== null) fieldsFilled.price++;
    if (r.amount !== null) fieldsFilled.amount++;
    if (r.fee !== null && r.fee !== 0) fieldsFilled.feeNonZero++;
    if (r.fxRate !== null) fieldsFilled.fxRate++;
    if (r.tradeDate) fieldsFilled.tradeDate++;
    if (r.description) {
      fieldsFilled.description++;
      for (const [k, re] of Object.entries(KEYWORDS)) if (re.test(r.description)) descriptionMentions[k as keyof typeof descriptionMentions]++;
    }
    if ((r.type === "BUY" || r.type === "SELL") && r.securityCurrency && r.currency && r.securityCurrency !== r.currency) {
      foreignSecurityInCadRows.total++;
      if (r.fxRate !== null) foreignSecurityInCadRows.withFxRate++;
      const gross = (r.units ?? 0) * (r.price ?? 0);
      if (r.amount !== null && Math.abs(gross) > 0) tally(priceRatio, ratioBucket(Math.abs(r.amount) / Math.abs(gross)));
    }
    if (r.type === "DIVIDEND") {
      dividends.total++;
      if (r.currency === "USD" || r.securityCurrency === "USD") {
        dividends.usd++;
        if (r.tradeDate && taxRowsByKeyDay.has(`${r.appUserId}\u0000${r.snapTradeAccountId}\u0000${r.tradeDate}`)) dividends.usdWithTaxRowSameDay++;
      }
    }
    const key = `${r.appUserId}\u0000${r.snapTradeAccountId}`;
    if (r.tradeDate && (!perAccountEarliest.has(key) || r.tradeDate < perAccountEarliest.get(key)!)) perAccountEarliest.set(key, r.tradeDate);
  }

  // Transfers: can an "in" be paired with an opposite "out" in another of the same user's accounts (same magnitude to
  // the cent, within PAIR_DAYS)? Paired rows could be classified without asking the user.
  const transfers = input.activities.filter((r) => TRANSFER.test(r.type) && r.amount !== null && r.tradeDate);
  const transferCounts = { total: input.activities.filter((r) => TRANSFER.test(r.type)).length, usable: transfers.length, inPaired: 0, inUnpaired: 0, inPairedFromNonTfsaIntoTfsa: 0, inPairedTfsaToTfsa: 0 };
  const isTfsa = (user: string, acct: string) => /TFSA/.test(accountKind.get(`${user}\u0000${acct}`) ?? "");
  const usedOut = new Set<AuditActivity>();
  for (const t of transfers.filter((r) => r.amount! > 0)) {
    const match = transfers.find((o) => o.amount! < 0 && !usedOut.has(o) && o.appUserId === t.appUserId && o.snapTradeAccountId !== t.snapTradeAccountId
      && Math.abs(Math.abs(o.amount!) - t.amount!) < 0.005 && Math.abs(dayNumber(o.tradeDate!) - dayNumber(t.tradeDate!)) <= PAIR_DAYS);
    if (!match) { transferCounts.inUnpaired++; continue; }
    usedOut.add(match);
    transferCounts.inPaired++;
    const intoTfsa = isTfsa(t.appUserId, t.snapTradeAccountId);
    const fromTfsa = isTfsa(match.appUserId, match.snapTradeAccountId);
    if (intoTfsa && !fromTfsa) transferCounts.inPairedFromNonTfsaIntoTfsa++;
    if (intoTfsa && fromTfsa) transferCounts.inPairedTfsaToTfsa++;
  }

  const historyFromActivity: Record<string, number> = {};
  for (const a of input.accounts) tally(historyFromActivity, historyBucket(perAccountEarliest.get(`${a.appUserId}\u0000${a.snapTradeAccountId}`) ?? null, input.today));
  const historyFromSync: Record<string, number> = {};
  const sync = { accounts: input.sync.length, backfillCompleted: 0, withError: 0, neverSynced: 0 };
  for (const s of input.sync) {
    tally(historyFromSync, historyBucket(s.earliestTradeDate, input.today));
    if (s.backfillCompleted) sync.backfillCompleted++;
    if (s.lastError) sync.withError++;
    if (!s.lastSyncedAt) sync.neverSynced++;
  }
  const dailyValueHistory: Record<string, number> = {};
  for (const days of input.dailyValueDaysPerUser) tally(dailyValueHistory, days === 0 ? "none" : days <= 7 ? "≤1 week" : days <= 31 ? "≤1 month" : days <= 92 ? "1–3 months" : ">3 months");

  return {
    users: input.users,
    accounts: { total: input.accounts.length, byType: accountType, byCategory: accountCategory, byInstitution: institution },
    activities: { total: input.activities.length, byType, byCurrency: currency, fieldsFilled, descriptionMentions, foreignSecurityTrades: { ...foreignSecurityInCadRows, priceRatio }, dividends },
    transfers: transferCounts,
    history: { perAccountFromActivity: historyFromActivity, perAccountFromSync: historyFromSync, sync, dailyValuesPerUser: dailyValueHistory, snapshots: input.snapshotCount },
  };
}
