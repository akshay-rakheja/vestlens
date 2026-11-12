import type { AmbiguousRow, FxSummary } from "./types";

/**
 * The same strings the API's text helpers produce (packages/api/src/mcp/room-tools.ts, room/tfsa-room.ts), so the
 * card and the assistant's text agree. Formatting only: nothing is converted or computed here.
 */

/** CAD with thousands separators; cents only when there are any. */
export function cad(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-CA", { minimumFractionDigits: Number.isInteger(abs) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** The estimate label: " (est., Bank of Canada rate <date>)" when converted with a rate date, " (est.)" without one, "" when not estimated. */
export const estLabel = (estimated: boolean, fxDate: string | null): string =>
  !estimated ? "" : fxDate ? ` (est., Bank of Canada rate ${fxDate})` : " (est.)";

/** Whole CAD dollars, rounded: the goal text's "about $X" (packages/api/src/mcp/portfolio-fact-tools.ts dollars). */
export function dollars(n: number): string {
  const rounded = Math.round(n);
  return `${rounded < 0 ? "-" : ""}$${Math.abs(rounded).toLocaleString("en-CA")}`;
}

export function nativeMoney(amount: number, currency: string): string {
  const sign = amount < 0 ? "-" : "";
  const digits = Math.abs(amount).toLocaleString("en-CA", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 });
  return currency === "USD" ? `${sign}US$${digits}` : `${sign}${currency} ${digits}`;
}

export function convertedMoney(amount: string, c: Pick<AmbiguousRow, "estimated" | "rateDate" | "native">): string {
  // A CAD value that is itself an estimate (shares valued at a day's close) says so.
  if (!c.native || c.native.currency === "CAD") return c.estimated ? `${amount} (est.)` : amount;
  const native = nativeMoney(c.native.amount, c.native.currency);
  return c.estimated ? `${amount} (est., BoC ${c.rateDate ?? "date unknown"}; ${native})` : `${amount} (${native} at the broker's rate)`;
}

/** A CAD total's note on its converted rows, or "" when none were converted. */
export function fxNote(fx: FxSummary): string {
  if (fx.native.length === 0) return "";
  const native = fx.native.map((n) => nativeMoney(n.amount, n.currency)).join(" and ");
  if (!fx.estimated) return ` (includes ${native} converted at the broker's rate)`;
  const dates = fx.rateDates;
  const rates = dates.length === 0 ? "Bank of Canada rates"
    : dates.length === 1 ? `the Bank of Canada rate of ${dates[0]}`
      : `Bank of Canada rates from ${dates[0]}–${dates[dates.length - 1]}`;
  return ` (est.; includes ${native} converted at ${rates})`;
}

/** Verbatim copy; `amount` is the formatted total with its note. `over`: putting it back would exceed the room left (B4). */
export const withdrawalNote = (amount: string, year: number, over = true) =>
  `You withdrew ${amount} this year. That room comes back on 1 January ${year + 1}. ${over ? "Putting it back before then would be an over-contribution." : "Putting it back before then would count as a new contribution against your remaining room."}`;

const TORONTO_DATE_TIME = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
});
/** An instant as a Toronto date and time: "24 October 2026, 4:00 a.m. Toronto time". */
export function torontoDateTime(iso: string): string {
  const parts = Object.fromEntries(TORONTO_DATE_TIME.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${parts.dayPeriod} Toronto time`;
}

const TORONTO_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", day: "numeric", month: "long", year: "numeric" });
/** An instant as a Toronto date: "24 October 2026". */
export function torontoDate(iso: string): string {
  const parts = Object.fromEntries(TORONTO_DATE.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.day} ${parts.month} ${parts.year}`;
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
/** A calendar date "YYYY-MM-DD" as "14 March 2026", or "14 March" without the year. */
export function calendarDate(ymd: string, withYear = true): string {
  const parts = Object.fromEntries(DAY_FORMAT.formatToParts(new Date(`${ymd}T00:00:00Z`)).map((p) => [p.type, p.value]));
  return withYear ? `${parts.day} ${parts.month} ${parts.year}` : `${parts.day} ${parts.month}`;
}

/** A ledger row's signed CAD amount: "+$1,000", "-$500", with est., the Bank of Canada date and the native amount when converted. */
export function ledgerAmount(row: { amountCad: number | null; estimated: boolean; rateDate: string | null; native: { amount: number; currency: string } | null }): string {
  if (row.amountCad === null) return "amount not known in CAD";
  const signed = `${row.amountCad > 0 ? "+" : row.amountCad < 0 ? "-" : ""}${cad(Math.abs(row.amountCad))}`;
  const native = row.native && { ...row.native, amount: Math.abs(row.native.amount) * (row.amountCad < 0 ? -1 : 1) };
  return convertedMoney(signed, { estimated: row.estimated, rateDate: row.rateDate, native });
}

/**
 * A withdrawal row's note (ITA 207.01(1)): the part that reduced an amount over never comes back; the rest comes back on
 * 1 January next year. Null when neither part is known to be above 0 (no "comes back" clause without its date).
 */
export function withdrawalRowNote(row: { qualifyingCad?: number | null; returnsCad?: number | null; returnsOn?: string }): string | null {
  const q = row.qualifyingCad ?? 0;
  const back = row.returnsOn && (row.returnsCad ?? 0) > 0 ? calendarDate(row.returnsOn) : null;
  if (q > 0 && back) return `this reduced the amount over by ${cad(q)}; the other ${cad(row.returnsCad!)} comes back on ${back}, not now`;
  if (q > 0) return `this reduced the amount over by ${cad(q)}`;
  if (back) return `this room comes back on ${back}, not now`;
  return null;
}

/** Money leaving the TFSA: a negative CAD amount, else a negative native amount. */
export const isOutgoing = (row: { amountCad: number | null; native?: { amount: number } | null }): boolean => (row.amountCad ?? row.native?.amount ?? 0) < 0;

/** A matched transfer's note, after its kind text: "matched to a transfer from <label> on <D Month>" ("to" when leaving). */
/** An unmatched, unanswered transfer whose kind is assumed (owner ruling 2026-10-26): it can be changed in step 4. */
export function assumedNote(row: { assumed?: true }): string | null {
  return row.assumed ? "assumed; you can change this" : null;
}

export function matchedNote(row: { amountCad: number | null; native?: { amount: number } | null; matchedWith?: { label: string; date: string } }): string | null {
  if (!row.matchedWith) return null;
  return `matched to a transfer ${isOutgoing(row) ? "to" : "from"} ${row.matchedWith.label} on ${calendarDate(row.matchedWith.date, false)}`;
}

/** The headline withdrawal sentence, counting only the parts that come back (withdrawnCad while the split is unknown). */
export function returningNote(result: { year: number; status?: string; withdrawnCad: number; returningCad?: number | null; roomLeftCad?: number; fx: { withdrawals: FxSummary } }): string | null {
  // No known split (the missing state, or a null returningCad): never say how much room comes back.
  if (result.status === "missing" || result.returningCad === null) {
    if (!(result.withdrawnCad > 0)) return null;
    return `You withdrew ${cad(result.withdrawnCad)}${fxNote(result.fx.withdrawals)} this year. Some or all of that room comes back on 1 January ${result.year + 1}; the exact amount needs the missing items above.`;
  }
  const returning = result.returningCad ?? result.withdrawnCad;
  if (!(returning > 0)) return null;
  const note = returning === result.withdrawnCad ? fxNote(result.fx.withdrawals) : result.fx.withdrawals.estimated ? " (est.)" : "";
  // Over-contribution only when putting it all back would exceed the room left (B4); with the room left unknown, it isn't claimed.
  const over = typeof result.roomLeftCad === "number" && result.roomLeftCad < returning;
  return withdrawalNote(`${cad(returning)}${note}`, result.year, over);
}

/** "A ••1111 and ••2222": labels told apart only by their last 4 are shortened after the first. */
function notCountedNames(items: ReadonlyArray<{ label: string }>): string {
  const base = (label: string) => label.split(" ••")[0]!;
  const names = items.map((a, i) => (i > 0 && a.label.includes(" ••") && base(a.label) === base(items[i - 1]!.label) ? `••${a.label.split(" ••")[1]}` : a.label));
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
/** The line under a room number that leaves out managed accounts (the API's notCountedLine, pinned by the shared fixture). */
export function notCountedLine(items: ReadonlyArray<{ label: string }>, over = false): string {
  const them = items.length === 1 ? "it" : "them";
  const effect = over ? "the amount over is higher than this" : "your room is lower than this";
  return `Not counted: ${notCountedNames(items)}. Contributions to ${them} aren't visible through SnapTrade. If you contributed to ${them} this year, ${effect}.`;
}

/** True when the dashboard's setup takes this item (mirrors the API's dashboardEnterable and the web missingStep). */
export function dashboardEnterable(item: { kind: string; accountKey?: string }): boolean {
  switch (item.kind) {
    case "cra_room": case "outside_contributions": case "ambiguous": case "managed_account": return true;
    case "dated_entries": return (item.accountKey ?? "").startsWith("outside:");
    default: return false;
  }
}
