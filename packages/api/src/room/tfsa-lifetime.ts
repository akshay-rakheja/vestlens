import { externalFlows, matchedTransferKeys } from "../analytics/flows.js";
import type { StoredActivity } from "../history/stored-activity.js";
import { isTransferType } from "./tfsa-rules.js";

/**
 * What went in and out of each connected TFSA over its whole stored history, in CAD. Pure. These are money movements,
 * not room: a transfer from another institution's TFSA uses no room, and this never feeds the room engine. Unlike the
 * performance figures, nothing here starts after a first value date, so an account's first deposits count.
 */
export interface LifetimeAccount { id: string; label: string; managed: boolean; backfilled: boolean }

export type ToCad = (amount: number, currency: string, date: string) => { cad: number | null; estimated: boolean };

export interface LifetimeAccountResult {
  label: string;
  /** A managed portfolio's activity isn't provided through SnapTrade, so its figures are null. */
  managed: boolean;
  putInCad: number | null;
  /** Negative, as stored. */
  takenOutCad: number | null;
  netCad: number | null;
  /** The part of the net that came through transfers, which may not have used room. */
  transfersNetCad: number | null;
  firstDate: string | null;
  historyComplete: boolean;
  /** Moves left out of the figures because they have no value: no price, no exchange rate, or a cash transfer row with no symbol. */
  unvaluedMoves: number;
  estimated: boolean;
  /** Years with money in or out, oldest first; netSoFarCad is the running net at that year's end. */
  years: Array<{ year: number; putInCad: number; takenOutCad: number; netSoFarCad: number }>;
  /** Rows carrying money that aren't counted and aren't ordinary investing: an issuer's promotion, or a type VestLens doesn't know. */
  notCounted: Array<{ type: string; rows: number; amountCad: number }>;
}

export interface TfsaLifetime {
  accounts: LifetimeAccountResult[];
  /** Moves between two connected TFSAs net out here. */
  total: { putInCad: number; takenOutCad: number; netCad: number; estimated: boolean };
}

const cents = (n: number) => Math.round(n * 100) / 100;
/** Money moving inside the account, or earned or charged there: never a deposit or a withdrawal. */
const INVESTING_TYPES = new Set(["BUY", "SELL", "DIVIDEND", "INTEREST", "FEE", "TAX", "REI", "REINVEST", "STOCK_DIVIDEND", "SPLIT", "REVERSE_SPLIT", "REORG", "CORPORATE_ACTION", "MERGER", "SPINOFF", "FXT", "FX", "FUNDS_CONVERSION", "PORTFOLIO_INVESTMENT", "PORTFOLIO_REBALANCING", "FUNDS_INVESTED"]);

export function computeTfsaLifetime(accounts: readonly LifetimeAccount[], rows: readonly StoredActivity[], toCad: ToCad): TfsaLifetime {
  let totalEstimated = false;
  const valueOf = (row: StoredActivity) => {
    // externalFlows skips a TRANSFER with no symbol, but money moved: it has no place in the totals, so it's reported.
    if (row.type.toUpperCase() === "TRANSFER" && !row.symbol && !row.isOption && row.amount) return { value: null, estimated: false };
    let estimated = false;
    const flows = externalFlows({
      activities: [row], scope: "account", scopeCurrency: "CAD", priceInKind: () => null,
      toScope: (amount, currency, date) => { const at = toCad(amount, currency, date); estimated ||= at.estimated; return at.cad; },
    });
    if (flows.unknownDates.size > 0) return { value: null, estimated };
    const entries = flows.entries ?? [];
    return { value: entries.length > 0 ? entries.reduce((sum, e) => sum + e.value, 0) : undefined, estimated };
  };
  const paired = matchedTransferKeys([...rows]);
  let totalIn = 0, totalOut = 0;
  const results = accounts.map((account): LifetimeAccountResult => {
    const own = rows.filter((r) => r.snapTradeAccountId === account.id);
    const dates = own.map((r) => r.tradeDate ?? r.settlementDate).filter((d): d is string => d !== null).sort();
    const base = { label: account.label, managed: account.managed, firstDate: dates[0] ?? null, historyComplete: account.backfilled };
    if (account.managed) return { ...base, putInCad: null, takenOutCad: null, netCad: null, transfersNetCad: null, unvaluedMoves: 0, estimated: false, years: [], notCounted: [] };
    let putIn = 0, takenOut = 0, transfers = 0, unvaluedMoves = 0, estimated = false;
    const byYear = new Map<number, { putIn: number; takenOut: number }>();
    const uncounted = new Map<string, { rows: number; amount: number }>();
    for (const row of own) {
      const { value, estimated: rowEstimated } = valueOf(row);
      if (value === undefined) {
        const type = row.type.toUpperCase();
        if (row.amount && !INVESTING_TYPES.has(type) && !type.startsWith("OPTION")) {
          const date = row.tradeDate ?? row.settlementDate ?? "";
          const at = toCad(row.amount, row.currency ?? "CAD", date);
          const entry = uncounted.get(type) ?? { rows: 0, amount: 0 };
          uncounted.set(type, { rows: entry.rows + 1, amount: entry.amount + ((row.currency ?? "CAD").toUpperCase() === "CAD" ? row.amount : at.cad ?? 0) });
        }
        continue;
      }
      if (value === null) { unvaluedMoves += 1; continue; }
      estimated ||= rowEstimated;
      if (value > 0) putIn += value; else takenOut += value;
      const year = Number((row.tradeDate ?? row.settlementDate)!.slice(0, 4));
      const inYear = byYear.get(year) ?? { putIn: 0, takenOut: 0 };
      if (value > 0) inYear.putIn += value; else inYear.takenOut += value;
      byYear.set(year, inYear);
      if (isTransferType(row.type)) transfers += value;
      if (!paired.has(row.dedupeKey)) { if (value > 0) totalIn += value; else totalOut += value; totalEstimated ||= rowEstimated; }
    }
    let running = 0;
    const years = [...byYear].sort(([a], [b]) => a - b).map(([year, v]) => {
      running += v.putIn + v.takenOut;
      return { year, putInCad: cents(v.putIn), takenOutCad: cents(v.takenOut), netSoFarCad: cents(running) };
    });
    const notCounted = [...uncounted].sort(([a], [b]) => a.localeCompare(b)).map(([type, v]) => ({ type, rows: v.rows, amountCad: cents(v.amount) }));
    return { ...base, putInCad: cents(putIn), takenOutCad: cents(takenOut), netCad: cents(putIn + takenOut), transfersNetCad: cents(transfers), unvaluedMoves, estimated, years, notCounted };
  });
  return { accounts: results, total: { putInCad: cents(totalIn), takenOutCad: cents(totalOut), netCad: cents(totalIn + totalOut), estimated: totalEstimated } };
}
