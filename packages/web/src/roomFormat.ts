import type { FxSummary, LedgerRowView, RoomNative } from "./apiErrors";

/**
 * The same strings the API's text helpers produce (packages/api/src/mcp/room-tools.ts, room/tfsa-room.ts) and the TFSA
 * card's format.ts (packages/widgets/src/widgets/tfsa-room), so the dashboard, the card and the assistant's text agree.
 * Asserted against the one shared fixture. Formatting only: nothing is converted or computed here.
 */

/** CAD with thousands separators; cents only when there are any. */
export function cad(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-CA", { minimumFractionDigits: Number.isInteger(abs) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** CAD with thousands separators, whole dollars (the assistant's goal text). */
export function dollars(n: number): string {
  const rounded = Math.round(n);
  return `${rounded < 0 ? "-" : ""}$${Math.abs(rounded).toLocaleString("en-CA")}`;
}

/** " (est., Bank of Canada rate <date>)" when converted with a known rate date, " (est.)" when estimated without one, "" otherwise. */
export const estLabel = (estimated: boolean, fxDate: string | null): string =>
  !estimated ? "" : fxDate ? ` (est., Bank of Canada rate ${fxDate})` : " (est.)";

export function nativeMoney(amount: number, currency: string): string {
  const sign = amount < 0 ? "-" : "";
  const digits = Math.abs(amount).toLocaleString("en-CA", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 });
  return currency === "USD" ? `${sign}US$${digits}` : `${sign}${currency} ${digits}`;
}

export function convertedMoney(amount: string, c: { estimated: boolean; rateDate: string | null; native: RoomNative | null }): string {
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

/** Verbatim copy; `amount` is the formatted total with its note. `over`: putting it back would exceed the room left (B4). */
export const withdrawalNote = (amount: string, year: number, over = true) =>
  `You withdrew ${amount} this year. That room comes back on 1 January ${year + 1}. ${over ? "Putting it back before then would be an over-contribution." : "Putting it back before then would count as a new contribution against your remaining room."}`;

/** Verbatim copy; `amount` is the formatted excess with its note. States facts, no instructions. */
export const overLimitAlert = (amount: string) =>
  `Your TFSA contributions this year are about ${amount} over your room. CRA charges 1% a month on the excess.`;

/** The conversion note an alert row stores: "(est.; includes …)", "(includes …)", "(est.)" or null. */
export function overLimitNote(contributions: FxSummary, estimated: boolean): string | null {
  return (fxNote(contributions) || (estimated ? " (est.)" : "")).trim() || null;
}

export const noteAmount = (amountCad: number, note: string | null) => `${cad(amountCad)}${note ? ` ${note}` : ""}`;

/** The alert sentence from the stored alert row, its note verbatim. */
export const storedAlertText = (alert: { excessCad: number; note: string | null }) => overLimitAlert(noteAmount(alert.excessCad, alert.note));

const TORONTO_DATE_TIME = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
});
/** An instant as a Toronto date and time: "24 October 2026, 4:00 a.m. Toronto time". */
export function torontoDateTime(iso: string): string {
  const parts = Object.fromEntries(TORONTO_DATE_TIME.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${parts.dayPeriod} Toronto time`;
}

/** Today's Toronto calendar date, YYYY-MM-DD (the room engines' "today"; never the UTC date). */
export const torontoToday = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

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

type AmbiguousAmountRow = { amountCad: number | null; estimated: boolean; rateDate: string | null; native: RoomNative | null; inKind?: true };
/** An unclear row's amount; one with none says why: shares moved in kind with no price or close, else a value not known in CAD. */
export function ambiguousAmount(row: AmbiguousAmountRow): string {
  if (row.amountCad === null) return row.inKind ? "shares moved in kind, no price or close found" : "amount not known in CAD";
  return convertedMoney(cad(row.amountCad), row);
}
/** The way out of such a row (the API's words): a stated year-to-date figure as of a later date stands in for it. */
export const inKindWayOut = (row: { label: string; date: string }) =>
  `No price or close was found for these shares, so answering alone can't give an amount. Give what you have contributed to ${row.label} this year as of a date on or after ${row.date}, `
  + "these shares at their value that day included, in Claude or ChatGPT through VestLens, and don't include amounts already entered elsewhere; that figure then stands in for this row.";

/** A ledger row's signed CAD amount: "+$1,000", "-$500", with est., the Bank of Canada date and the native amount when converted. */
export function ledgerAmount(row: Pick<LedgerRowView, "amountCad" | "estimated" | "rateDate" | "native">): string {
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

/**
 * The FHSA headline (the API's fhsaHeadline, the same fixture): room left, the amount over and since when, or
 * "I can't give a number yet".
 */
export function fhsaHeadline(result: { status: "known" | "missing"; roomLeftCad?: number; overLimitCad?: number; ledger?: { rows: Array<{ kind: string; label: string }>; overSince: string | null; undatedExcess: boolean } }): string {
  if (result.status === "missing" || !result.ledger) return "I can't give a number yet";
  const over = result.overLimitCad ?? 0;
  if (over <= 0) return `About ${cad(Math.max(0, result.roomLeftCad ?? 0))} of FHSA room left this year`;
  const amount = cad(over);
  const { overSince, undatedExcess, rows } = result.ledger;
  if (undatedExcess) {
    const total = rows.find((r) => r.kind === "outside_total")?.label ?? "an account";
    return `About ${amount} over your FHSA room; the date can't be told because ${total} has a total, not dated deposits`;
  }
  return overSince ? `About ${amount} over your FHSA room since ${calendarDate(overSince, false)}` : `About ${amount} over your FHSA room`;
}

/**
 * An FHSA withdrawal row's note: how much it lowered an excess existing when it was made; else, when it lowers a later
 * excess (CRA counts every taxable withdrawal in the year), that it counts against it; else that it gives no room back.
 */
export function fhsaWithdrawalNote(row: { qualifyingCad?: number | null; offsetsLater?: true }): string {
  if ((row.qualifyingCad ?? 0) > 0) return `this reduced the amount over by ${cad(row.qualifyingCad!)}`;
  return row.offsetsLater ? "withdrawals don't give FHSA room back; this one counts against any amount over later this year" : "withdrawals don't give FHSA room back";
}

/** Shown while an account's first history read is incomplete (a `coverage` gap): the 10-minute catch-up fills it. */
export const HISTORY_READING =
  "Still reading this year's deposits and withdrawals from Wealthsimple, so room left isn't final yet. This usually takes about 10 minutes after you link.";
export const readingHistory = (room: { status: string; missing?: ReadonlyArray<{ kind: string }> }): boolean =>
  room.status === "missing" && (room.missing ?? []).some((item) => item.kind === "coverage");

/** The RRSP section's fixed lines (the API's rrsp-room.ts constants, pinned by web-format-drift.test.ts). */
export const RRSP_LIMIT_PROMPT = "Enter your RRSP deduction limit from CRA My Account or your notice of assessment to see room left.";
export const RRSP_DEDUCT_LATER = "Unused contributions can be deducted in a later year; VestLens doesn't choose the year for you.";
export const RRSP_CRA_FACT = "CRA charges 1% a month on contributions more than $2,000 over your RRSP deduction limit. Check your figures in CRA My Account.";
export const RRSP_UNUSED_QUESTION = (year: number): string =>
  `What unused RRSP contributions does CRA show for ${year}? It's next to your deduction limit on your notice of assessment and in CRA My Account; enter 0 if there are none.`;
export const RRSP_ELSEWHERE_QUESTION = (year: number): string =>
  `Did you contribute to an RRSP VestLens doesn't see for the ${year} tax year, such as a group RRSP at work, an account at another institution, or a spousal RRSP for your spouse? Enter the total, or 0 if none.`;
export const RRSP_MANAGED_QUESTION = (labels: string, year: number): string =>
  `Contributions to ${labels} aren't visible through SnapTrade. Add them, plus any other RRSP contributions VestLens doesn't see for the ${year} tax year (a group RRSP at work, an account at another institution, a spousal RRSP for your spouse), to 'Contributions not in VestLens'; enter 0 if there are none.`;
/** The year's own figures (the API's RRSP_FIGURE_KINDS): while only these are missing, the contributions still show. */
const RRSP_FIGURE_KINDS: ReadonlySet<string> = new Set(["deduction_limit", "unused_contributions", "elsewhere"]);

type RrspYearCopy = {
  window: { taxYear: number; from: string; to: string | null };
  missing: ReadonlyArray<{ kind: string }>;
  contributedCad: number | null; elsewhereCad: number | null; roomLeftCad: number | null; overLimitCad: number | null;
};

/** True when the headline is the contributions figure: only the year's own figures (limit, unused, elsewhere) are missing. */
const contributedHeadline = (year: RrspYearCopy) => year.missing.length > 0 && year.missing.every((m) => RRSP_FIGURE_KINDS.has(m.kind));

/**
 * One RRSP tax year's headline (the API's rrspHeadline): anything missing besides the year's figures (limit, unused
 * contributions, contributions elsewhere) means no number; then a missing figure means the contributions only; then
 * the amount over; then the deduction room left.
 */
export function rrspHeadline(year: RrspYearCopy): string {
  const Y = year.window.taxYear;
  if (year.missing.some((m) => !RRSP_FIGURE_KINDS.has(m.kind))) return `I can't give a number for ${Y} yet`;
  if (contributedHeadline(year)) return `${cad(year.contributedCad ?? 0)} contributed for the ${Y} tax year`;
  if ((year.overLimitCad ?? 0) > 0) return `${cad(year.overLimitCad ?? 0)} over your RRSP deduction limit for ${Y}`;
  return `${cad(Math.max(0, year.roomLeftCad ?? 0))} of RRSP deduction room left for ${Y}`;
}

const rrspPlus = (year: RrspYearCopy) => (year.elsewhereCad === null ? "" : ` plus ${cad(year.elsewhereCad)} you entered as contributions not in VestLens`);
/** What follows a contributions headline: the figure entered for RRSPs VestLens can't see, named beside it, never added in. */
export const rrspHeadlinePlus = (year: RrspYearCopy): string => (contributedHeadline(year) ? rrspPlus(year) : "");
/** With any other headline: the connected contributions and the entered figure beside them, or null. */
export function rrspContributedLine(year: RrspYearCopy): string | null {
  if (contributedHeadline(year) || year.contributedCad === null || year.elsewhereCad === null) return null;
  return `${cad(year.contributedCad)} contributed${rrspPlus(year)}`;
}

type RrspMissingCopy =
  | { kind: "deduction_limit" } | { kind: "unused_contributions" } | { kind: "elsewhere" } | { kind: "managed_rrsp"; labels: string[] } | { kind: "coverage"; label: string }
  | { kind: "stale_activity"; label: string; lastSyncedAt: string | null }
  | { kind: "ambiguous"; count: number; rows: Array<{ date: string; amountCad: number | null; estimated: boolean; rateDate: string | null; native: RoomNative | null; type: string; label: string }> };

/** One RRSP missing item in the assistant's words (the API's rrspQuestion): the limit prompt, a fact, or a question. */
export function rrspMissingLine(item: RrspMissingCopy, year: RrspYearCopy): string {
  switch (item.kind) {
    case "deduction_limit": return RRSP_LIMIT_PROMPT;
    case "unused_contributions": return RRSP_UNUSED_QUESTION(year.window.taxYear);
    case "elsewhere": return RRSP_ELSEWHERE_QUESTION(year.window.taxYear);
    case "managed_rrsp": return RRSP_MANAGED_QUESTION(item.labels.join(", "), year.window.taxYear);
    case "coverage": return `${item.label}'s stored activity doesn't reach ${calendarDate(year.window.from)} yet; I'll have a number once its full history has loaded.`;
    case "stale_activity": return item.lastSyncedAt === null
      ? `${item.label}'s activity hasn't been loaded yet; I'll have a number after it refreshes.`
      : `${item.label}'s activity was last updated ${torontoDateTime(item.lastSyncedAt)}; I'll have a number after it refreshes.`;
    case "ambiguous": {
      const rows = item.rows.map((r) => {
        const amount = r.amountCad === null ? " (amount not known in CAD)" : ` of ${convertedMoney(cad(r.amountCad), r)}`;
        return `Was the ${r.type}${amount} ${r.date === "unknown" ? "on an unknown date" : `on ${r.date}`} (${r.label}) a contribution to your RRSP?`;
      });
      const more = item.count - item.rows.length;
      return [...rows, ...(more > 0 ? [`${more} more need checking after these.`] : [])].join(" ");
    }
  }
}
