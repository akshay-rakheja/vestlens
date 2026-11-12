import { buildContext, type ContextDeps } from "../memory/context-builder.js";
import type { RoomAlertService } from "../room/room-alerts.js";
import { computeFhsaRoom, FHSA_CRA_FACT, FHSA_LAST_YEAR_BASIS, FHSA_TAXABLE_BASIS, type FhsaMissingItem, type FhsaRoomResult } from "../room/fhsa-room.js";
import { loadFhsaRoomInput, loadRoomInput, loadRrspRoomInput, loadTfsaLifetime, torontoToday, type RoomLoaderDeps } from "../room/room-loader.js";
import {
  computeRrspRoom, RRSP_CRA_FACT, RRSP_DEDUCT_LATER, RRSP_ELSEWHERE_QUESTION, RRSP_FIGURE_KINDS, RRSP_MANAGED_QUESTION, RRSP_LIMIT_PROMPT, RRSP_UNUSED_QUESTION,
  type RrspMissingItem, type RrspRoomResult, type RrspYear,
} from "../room/rrsp-room.js";
import { computeTfsaRoom, convertedMoney, countedTfsas, nativeMoney, type AmbiguousRow, type FxSummary, type MissingItem, type RoomInput, type RoomResult } from "../room/tfsa-room.js";
import { notCountedLine, notCountedNote, type NewYearRow, type NotCounted } from "../room/room-common.js";
import type { LedgerRow } from "../room/tfsa-ledger.js";
import type { TfsaLifetime } from "../room/tfsa-lifetime.js";

/**
 * get_contribution_room (spec §6, §7): the TFSA room left this Toronto year from stored inputs only (no brokerage
 * read), or what is missing before a number can be given, as plain questions. It needs portfolio:read only: a
 * token without `memory` still gets the answer from what is already stored. States facts, never advice.
 */

/** The TFSA room card's base address (packages/widgets tfsa-room); the server rebinds it to the served URI. */
export const TFSA_ROOM_WIDGET_URI = "ui://portfolio/tfsa-room-v1";

export interface RoomDeps {
  loader: RoomLoaderDeps;
  /** The tax_year:<year>:tfsa neighbourhood attached to the result. */
  context: ContextDeps;
  now?: () => Date;
  /** The app's base URL (config APP_BASE_URL): the dashboard room page link is built from it. Without it, no link is given. */
  appBaseUrl?: string;
  /** The over-limit alert store; with it, get_portfolio_alerts is listed in normal mode even without news and reads its row. */
  alerts?: RoomAlertService;
  /** Counts and constant codes only. */
  log?: (event: { event: "tfsa_room"; status: RoomResult["status"]; missing: number; ambiguous: number } | { event: "tfsa_lifetime"; status: "error" } | { event: "fhsa_room"; status: "error" } | { event: "rrsp_room"; status: "error" }) => void;
}

const security = [{ type: "oauth2" as const, scopes: ["portfolio:read"] }];

export const roomToolDefinitions = [
  {
    name: "get_contribution_room",
    title: "Get contribution room",
    description:
      "Use this when the user asks about their TFSA contribution room, how much they have contributed to or withdrawn from a TFSA over time, or mentions planning a TFSA deposit or withdrawal. Also returns what went in and out of each connected TFSA over its whole history. Returns the room left this year in CAD from what the user told VestLens and their stored activity, or what is missing before a number can be given, and any withdrawal whose room only returns next year. Ask the missing items as questions and save each answer with remember, using the accountKey and activityKey values returned here. When the user has an FHSA, it also gives one line on their FHSA participation room this year. When the user has an RRSP, it also gives their RRSP contributions for each open tax year (by CRA's dates) and the deduction room left once they've entered their deduction limit, unused contributions and contributions not in VestLens (0 counts). Read-only; states facts, not advice.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    securitySchemes: security,
    _meta: {
      securitySchemes: security,
      ui: { resourceUri: TFSA_ROOM_WIDGET_URI },
      "openai/outputTemplate": TFSA_ROOM_WIDGET_URI,
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Checking TFSA room…",
      "openai/toolInvocation/invoked": "TFSA room ready.",
    },
  },
] as const;

/** The connected TFSA and neutral accounts the room considers, with the keys `remember` takes for them. */
export interface RoomAccount {
  accountKey: string;
  label: string;
  neutral: boolean;
  /** Counted as a TFSA this year (countedTfsas): broker-labelled and not excluded, or added by this year's set. */
  inSet: boolean;
  /** The last 4 characters of the brokerage's masked account number, or null. */
  maskedNumber: string | null;
  /** The brokerage-reported total in its own currency, or null. */
  value: { amount: number; currency: string } | null;
}

export const ROOM_TOOL_NAMES: readonly string[] = roomToolDefinitions.map((t) => t.name);

/** CAD with thousands separators; cents only when there are any. */
export function cad(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-CA", { minimumFractionDigits: Number.isInteger(abs) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/**
 * Global-constraints copy, verbatim; `amount` is the formatted total (with its est. note when converted). `over`: putting
 * the amount back would exceed the room left this year (B4); otherwise it would only use remaining room.
 */
export const withdrawalNote = (amount: string, year: number, over = true) =>
  `You withdrew ${amount} this year. That room comes back on 1 January ${year + 1}. ${over ? "Putting it back before then would be an over-contribution." : "Putting it back before then would count as a new contribution against your remaining room."}`;

/** Global-constraints alert copy, verbatim; `amount` is overLimitAmount's text. States facts, no instructions. */
export const overLimitAlert = (amount: string) =>
  `Your TFSA contributions this year are about ${amount} over your room. CRA charges 1% a month on the excess.`;

/**
 * A CAD total's note on its converted rows (repo currency rule: est. with the Bank of Canada rate date, native amounts
 * visible, never a silent conversion): "(est.; includes US$1,000 converted at the Bank of Canada rate of 2026-03-02)",
 * "... at Bank of Canada rates from <earliest>–<latest>", or "(includes US$1,000 converted at the broker's rate)".
 */
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

/**
 * The conversion note on an over-limit amount, as the room text states it: "(est.; includes US$1,000 converted at …)",
 * "(includes … at the broker's rate)", "(est.)", or null for plain CAD. This is what an alert row stores.
 */
export function overLimitNote(contributions: FxSummary, estimated: boolean): string | null {
  return (fxNote(contributions) || (estimated ? " (est.)" : "")).trim() || null;
}

/** The over-limit amount: CAD, then the stored or computed note. */
export const noteAmount = (amountCad: number, note: string | null) => `${cad(amountCad)}${note ? ` ${note}` : ""}`;

/** The over-limit amount as the room text states it. */
export function overLimitAmount(overLimitCad: number, contributions: FxSummary, estimated: boolean): string {
  return noteAmount(overLimitCad, overLimitNote(contributions, estimated));
}

/**
 * What an alert row stores for a known result: the conversion note, and any managed account the amount leaves out. An
 * over amount is what the visible contributions alone put over, so "over" holds; only its size can be higher.
 */
export function roomAlertNote(result: Extract<RoomResult, { status: "known" }>): string | null {
  const parts = [overLimitNote(result.fx.contributions, result.estimated), result.notCounted?.length ? notCountedNote(result.notCounted) : null];
  return parts.filter((p): p is string => p !== null).join(" ") || null;
}

/** The alert sentence for a known result over the limit (the same words roomText uses). */
export const roomAlertText = (result: Extract<RoomResult, { status: "known" }>) =>
  overLimitAlert(noteAmount(result.overLimitCad, roomAlertNote(result)));

/** The alert sentence from a stored alert row: identical to roomText's over-limit line for the same result. */
export const storedRoomAlertText = (alert: { excessCad: number; note: string | null }) => overLimitAlert(noteAmount(alert.excessCad, alert.note));

const keyed = (label: string, accountKey: string) => `${label} (account key ${accountKey})`;

/**
 * Shares moved in kind with no price and no close (review 3): the row has no amount, so the only way to a number is the
 * account's stated year-to-date figure as of a date on or after it (account.ytd_contributions on its key), which then
 * stands in for the row. The words say so, and say not to double count what was entered elsewhere.
 */
const inKindQuestion = (r: AmbiguousRow) =>
  `The ${r.type} on ${r.date} (${r.label}) moved shares in kind, and no price or close was found for them, so it has no amount and an answer alone can't give it one. `
  + `Tell me what you have contributed to ${r.accountKey ? keyed(r.label, r.accountKey) : r.label} this year as of a date on or after ${r.date}, these shares at their value that day included, `
  + "and don't include amounts already entered elsewhere; that figure then stands in for it.";

const TORONTO_DATE_TIME = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
});
/** An instant as a Toronto date and time: "24 October 2026, 4:00 a.m. Toronto time". Shared fixture with the card and tile. */
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

/**
 * The New Year check's words (owner ruling 2026-11-03): each contribution near New Year with the year VestLens counts it
 * in and the one the brokerage may record it in, then how far each direction could move `year`'s room. Null when none.
 */
export function newYearText(rows: readonly NewYearRow[] | undefined, account: "TFSA" | "FHSA", year: number): string | null {
  if (!rows || rows.length === 0) return null;
  const amount = (r: NewYearRow) => convertedMoney(`+${cad(r.amountCad)}`, r);
  const what = (r: NewYearRow) => `${calendarDate(r.date)} · ${r.label} · ${amount(r)}`;
  const sum = (list: readonly NewYearRow[]) => list.reduce((t, r) => Math.round((t + r.amountCad) * 100) / 100, 0);
  const est = (list: readonly NewYearRow[]) => (list.some((r) => r.estimated) ? " (est.)" : "");
  // Counted last year, maybe recorded this year: this year's room lower. Counted this year, maybe another: higher.
  const lower = rows.filter((r) => r.countedIn !== year && r.mayCountIn === year);
  const higher = rows.filter((r) => r.countedIn === year);
  if (rows.length === 1) {
    const r = rows[0]!;
    const effect = lower.length === 1 ? `lower` : `higher`;
    return `Near New Year: ${what(r)} is counted in ${r.countedIn} here, but your brokerage may record it in ${r.mayCountIn}. `
      + `If it does, your ${year} ${account} room is up to ${cad(r.amountCad)}${est(rows)} ${effect} than shown. Check the date your brokerage shows for it.`;
  }
  const sentences = [
    `Near New Year, these are counted by their date here, but your brokerage may record them in the neighbouring year: ${rows.map((r) => `${what(r)} (counted in ${r.countedIn}; may be ${r.mayCountIn})`).join("; ")}.`,
  ];
  if (lower.length > 0) sentences.push(`If the ${year - 1} ones are recorded in ${year}, your ${year} ${account} room is up to ${cad(sum(lower))}${est(lower)} lower than shown.`);
  if (higher.length > 0) {
    sentences.push(lower.length > 0
      ? `If the ${year} ones are recorded in another year, it is up to ${cad(sum(higher))}${est(higher)} higher.`
      : `If they are recorded in another year, your ${year} ${account} room is up to ${cad(sum(higher))}${est(higher)} higher than shown.`);
  }
  sentences.push("Check the dates your brokerage shows for them.");
  return sentences.join(" ");
}

/** The dashboard room page (spec §7), or null when the app's base URL isn't known. */
export function roomDashboardUrl(appBaseUrl: string | undefined): string | null {
  return appBaseUrl ? `${appBaseUrl.replace(/\/+$/, "")}/?view=room` : null;
}

/** The freshness label, verbatim (owner ruling 2026-10-26). */
export const freshnessLabel = (activityAsOf: string) => `Based on activity up to ${torontoDate(activityAsOf)}; deposits made since then aren't included`;

/** A ledger row's signed CAD amount: "+$1,000", "-$500", with est., the Bank of Canada date and the native amount when converted. */
function ledgerAmount(row: LedgerRow): string {
  if (row.amountCad === null) return "amount not known in CAD";
  const signed = `${row.amountCad > 0 ? "+" : row.amountCad < 0 ? "-" : ""}${cad(Math.abs(row.amountCad))}`;
  const native = row.native && { ...row.native, amount: Math.abs(row.native.amount) * (row.amountCad < 0 ? -1 : 1) };
  return convertedMoney(signed, { estimated: row.estimated, rateDate: row.rateDate, native });
}

/**
 * A withdrawal row's note (ITA 207.01(1)): the part that reduced an amount over never comes back; the rest comes back on
 * 1 January next year. Null when neither part is known to be above 0 (no "comes back" clause without its date).
 */
export function withdrawalRowNote(row: Pick<LedgerRow, "qualifyingCad" | "returnsCad" | "returnsOn">): string | null {
  const q = row.qualifyingCad ?? 0;
  const back = row.returnsOn && (row.returnsCad ?? 0) > 0 ? calendarDate(row.returnsOn) : null;
  if (q > 0 && back) return `this reduced the amount over by ${cad(q)}; the other ${cad(row.returnsCad!)} comes back on ${back}, not now`;
  if (q > 0) return `this reduced the amount over by ${cad(q)}`;
  if (back) return `this room comes back on ${back}, not now`;
  return null;
}

/** Money leaving the TFSA: a negative CAD amount, else a negative native amount (the dashboard and card use the same rule). */
export const isOutgoing = (row: { amountCad: number | null; native?: { amount: number } | null }): boolean => (row.amountCad ?? row.native?.amount ?? 0) < 0;

/**
 * A matched transfer's note (shown after its kind text, the same on the dashboard and the card): "matched to a transfer
 * from <label> on <D Month>", or "to <label>" for money leaving the TFSA. Null on a row that wasn't matched.
 */
export function matchedNote(row: { amountCad: number | null; native?: { amount: number } | null; matchedWith?: { label: string; date: string } }): string | null {
  if (!row.matchedWith) return null;
  return `matched to a transfer ${isOutgoing(row) ? "to" : "from"} ${row.matchedWith.label} on ${calendarDate(row.matchedWith.date, false)}`;
}
/** An unmatched, unanswered transfer whose kind is assumed (owner ruling 2026-10-26): it can be changed in step 4. */
export function assumedNote(row: { assumed?: true }): string | null {
  return row.assumed ? "assumed; you can change this" : null;
}
const withMatch = (row: LedgerRow) => {
  const notes = [matchedNote(row), assumedNote(row)].filter((n): n is string => n !== null);
  return notes.map((n) => `; ${n}`).join("");
};

/**
 * The headline withdrawal sentence counts only the parts that come back (returningCad; withdrawnCad when the split
 * can't be told yet). The withdrawals' conversion note applies only when that is every withdrawal.
 */
export function returningNote(result: Pick<RoomResult, "withdrawnCad" | "returningCad" | "fx" | "year" | "status"> & { roomLeftCad?: number }): string | null {
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

/** The ledger's over-since sentence (the dashboard headline's words), or null when not over. */
function overSentence(result: Extract<RoomResult, { status: "known" }>): string | null {
  if (result.overLimitCad <= 0) return null;
  const amount = cad(result.overLimitCad);
  const { overSince, undatedExcess, rows } = result.ledger;
  if (undatedExcess) {
    const total = rows.find((r) => r.kind === "outside_total")?.label ?? "an account";
    return `About ${amount} over your TFSA room; the date can't be told because ${total} has a total, not dated deposits.`;
  }
  return overSince ? `About ${amount} over your TFSA room since ${calendarDate(overSince, false)}.` : null;
}

/**
 * True when the dashboard takes this item (mirrors the web missingStep: cra_room, outside_contributions, ambiguous, and
 * dated_entries on an outside: key; and the room page's own form for a managed account's figure, review 6). Kept in
 * step by tests.
 */
export function dashboardEnterable(item: MissingItem): boolean {
  switch (item.kind) {
    case "cra_room": case "outside_contributions": case "ambiguous": case "managed_account": return true;
    case "dated_entries": return item.accountKey.startsWith("outside:");
    default: return false;
  }
}

/** Where a figure for a not-counted managed account goes: its own key, through remember (or the dashboard's room page). */
const notCountedSave = (items: NotCounted[]) =>
  `If the user gives a year-to-date figure, save it with remember (account.ytd_contributions) on ${items.map((a) => keyed(a.label, a.accountKey)).join(", ")}.`;

/** A managed TFSA or FHSA (A9): SnapTrade shows none of its contributions, so its year-to-date figure is asked for, on its own key. */
const managedQuestion = (item: { label: string; accountKey: string }) =>
  `Contributions to ${keyed(item.label, item.accountKey)} aren't visible through SnapTrade. How much have you contributed to it this year, and as of what date? Don't include amounts already entered elsewhere.`;

/** One line per missing item. Which accounts are TFSAs is never asked: the broker's labels decide (owner ruling 2026-10-26). */
function questions(item: MissingItem, year: number): string[] {
  switch (item.kind) {
    case "cra_room": return [`What was your TFSA contribution room on 1 January ${year}? It's in CRA My Account.`];
    case "coverage": return [`How much have you contributed to ${keyed(item.label, item.accountKey)} this year, and as of what date? Its stored activity doesn't go back to 1 January.`];
    case "outside_contributions": return [`How much have you contributed to ${keyed(item.label, item.accountKey)} this year, and as of what date?`];
    case "stale_activity": return [item.lastSyncedAt === null
      ? `${item.label}'s activity hasn't been loaded yet; I'll have a number after it refreshes.`
      : `${item.label}'s activity was last updated ${torontoDateTime(item.lastSyncedAt)}; I'll have a number after it refreshes.`];
    case "disconnected_account": return [`An account you confirmed as a TFSA (key ${item.accountKey}) is no longer connected. How much did you contribute to it this year?`];
    case "managed_account": return [managedQuestion(item)];
    case "dated_entries": return [`${item.label}'s contributions this year as dated deposits, so withdrawals can be placed correctly (account key ${item.accountKey}).`];
    case "ambiguous": {
      // Date, CAD amount, type and account label only: never description text.
      const rows = item.rows.map((r) => {
        if (r.inKind && r.amountCad === null) return inKindQuestion(r);
        const amount = r.amountCad === null ? " (amount not known in CAD)" : ` of ${convertedMoney(cad(r.amountCad), r)}`;
        const date = r.date === "unknown" ? "on an unknown date" : `on ${r.date}`;
        return `Was the ${r.type}${amount} ${date} (${r.label}) a contribution to your TFSA?`;
      });
      const more = item.count - item.rows.length;
      return more > 0 ? [...rows, `${more} more need checking after these.`] : rows;
    }
  }
}

type FhsaShown = Exclude<FhsaRoomResult, { status: "none" }>;

/** The FHSA headline, the dashboard's words: room left, the amount over and since when, or "I can't give a number yet". */
export function fhsaHeadline(result: FhsaShown): string {
  if (result.status === "missing") return "I can't give a number yet";
  if (result.overLimitCad <= 0) return `About ${cad(Math.max(0, result.roomLeftCad))} of FHSA room left this year`;
  const amount = cad(result.overLimitCad);
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

/** One plain question or fact per missing FHSA item: only the participation room is ever a question in the usual case. */
function fhsaQuestion(item: FhsaMissingItem, year: number): string {
  switch (item.kind) {
    case "fhsa_room": return `What is your FHSA participation room for ${year}? It's in CRA My Account or on your notice of assessment; give it as CRA shows it, not one you've worked out.`;
    case "managed_account": return managedQuestion(item);
    case "coverage": return `How much have you contributed to ${keyed(item.label, item.accountKey)} this year, and as of what date? Its stored activity doesn't go back to 1 January.`;
    case "stale_activity": return item.lastSyncedAt === null
      ? `${item.label}'s activity hasn't been loaded yet; I'll have a number after it refreshes.`
      : `${item.label}'s activity was last updated ${torontoDateTime(item.lastSyncedAt)}; I'll have a number after it refreshes.`;
    case "ambiguous": {
      const rows = item.rows.map((r) => {
        if (r.inKind && r.amountCad === null) return inKindQuestion(r);
        const amount = r.amountCad === null ? " (amount not known in CAD)" : ` of ${convertedMoney(cad(r.amountCad), r)}`;
        return `Was the ${r.type}${amount} ${r.date === "unknown" ? "on an unknown date" : `on ${r.date}`} (${r.label}) a contribution to your FHSA?`;
      });
      const more = item.count - item.rows.length;
      return [...rows, ...(more > 0 ? [`${more} more need checking after these.`] : [])].join(" ");
    }
  }
}

/**
 * What every FHSA figure is said with, as on the dashboard: the freshness label (known), that withdrawals count as taxable
 * (when there is one), and that last year's excess isn't included (always).
 */
export function fhsaDisclosures(result: FhsaShown): string[] {
  return [
    ...(result.status === "known" && result.activityAsOf ? [freshnessLabel(result.activityAsOf)] : []),
    ...(result.basis.includes(FHSA_TAXABLE_BASIS) ? [FHSA_TAXABLE_BASIS] : []),
    FHSA_LAST_YEAR_BASIS,
  ];
}

/** The FHSA line of get_contribution_room's text (only when an FHSA exists): one line, facts only, with its disclosures. */
export function fhsaText(result: FhsaShown): string {
  const nearNewYear = newYearText(result.newYear, "FHSA", result.year);
  const said = [...fhsaDisclosures(result).map((d) => (d.endsWith(".") ? d : `${d}.`)), ...(nearNewYear ? [nearNewYear] : [])].join(" ");
  if (result.status === "missing") return `FHSA: I can't give a number yet: ${result.missing.map((m) => fhsaQuestion(m, result.year)).join(" ")} ${said}`;
  const note = fxNote(result.fx.contributions) || (result.estimated ? " (est.)" : "");
  const left = result.notCounted?.length ? ` ${notCountedLine(result.notCounted, result.overLimitCad > 0)} ${notCountedSave(result.notCounted)}` : "";
  if (result.overLimitCad > 0) return `FHSA: ${fhsaHeadline(result)}${note}.${left} ${FHSA_CRA_FACT} ${said}`;
  return `FHSA: ${fhsaHeadline(result)}${note}. ${result.headlineBasis}.${left} ${said}`;
}

type RrspShown = Extract<RrspRoomResult, { status: "shown" }>;

/** True when the headline is the contributions figure: only the year's own figures (limit, unused, elsewhere) are missing. */
const rrspContributedHeadline = (year: RrspYear) => year.missing.length > 0 && year.missing.every((m) => RRSP_FIGURE_KINDS.has(m.kind));

/**
 * One RRSP year's headline. Precedence: anything missing besides the year's figures (limit, unused contributions,
 * contributions elsewhere) means no number; then a missing figure means the contributions only; then the amount over;
 * then the room left. Withdrawals never raise room left.
 */
export function rrspHeadline(year: RrspYear): string {
  const Y = year.window.taxYear;
  if (year.missing.some((m) => !RRSP_FIGURE_KINDS.has(m.kind))) return `I can't give a number for ${Y} yet`;
  if (rrspContributedHeadline(year)) return `${cad(year.contributedCad ?? 0)} contributed for the ${Y} tax year`;
  if ((year.overLimitCad ?? 0) > 0) return `${cad(year.overLimitCad ?? 0)} over your RRSP deduction limit for ${Y}`;
  return `${cad(Math.max(0, year.roomLeftCad ?? 0))} of RRSP deduction room left for ${Y}`;
}

/** One plain question or fact per missing RRSP item (the limit prompt, a figure's question, the managed-RRSP sentence, or a FHSA-style question). */
function rrspQuestion(item: RrspMissingItem, year: RrspYear): string {
  const Y = year.window.taxYear;
  switch (item.kind) {
    case "deduction_limit": return RRSP_LIMIT_PROMPT;
    case "unused_contributions": return RRSP_UNUSED_QUESTION(Y);
    case "elsewhere": return RRSP_ELSEWHERE_QUESTION(Y);
    case "managed_rrsp": return RRSP_MANAGED_QUESTION(item.labels.join(", "), Y);
    // A fact, not a question: only the backfill reaching the window's start clears it, so nothing the user says helps.
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

/**
 * One RRSP year as sentences: the headline (with its conversion note), the entered "elsewhere" contributions beside the
 * connected ones, the window, each missing item as a question, and the CRA fact when over.
 */
function rrspYearText(year: RrspYear): string {
  const note = fxNote(year.fx.contributions) || (year.estimated ? " (est.)" : "");
  // Connected RRSPs' contributions only; what the user entered for other RRSPs is named beside them, never added in.
  const plus = year.elsewhereCad === null ? "" : ` plus ${cad(year.elsewhereCad)} you entered as contributions not in VestLens`;
  const contributedHeadline = rrspContributedHeadline(year);
  const sentences = [`${rrspHeadline(year)}${note}${contributedHeadline ? plus : ""}.`];
  if (!contributedHeadline && year.contributedCad !== null && year.elsewhereCad !== null) sentences.push(`${cad(year.contributedCad)} contributed${plus}.`);
  if (year.basis[0]) sentences.push(`${year.basis[0]}.`);
  for (const item of year.missing) sentences.push(rrspQuestion(item, year));
  if ((year.overLimitCad ?? 0) > 0) sentences.push(RRSP_CRA_FACT);
  return sentences.join(" ");
}

/** The RRSP line of get_contribution_room's text (only when an RRSP exists): one line, facts only, years joined by "; ". */
export function rrspText(result: RrspShown): string {
  const fresh = result.activityAsOf ? ` ${freshnessLabel(result.activityAsOf)}.` : "";
  return `RRSP: ${result.years.map(rrspYearText).join("; ")}${fresh} ${RRSP_DEDUCT_LATER}`;
}

/** The model-facing text: the number or the missing items, the withdrawal note, then what it is based on. */
/** `fhsaLine` is fhsaText's line and `rrspLine` is rrspText's, each given only when the user has that account. */
/** Money in and out of each connected TFSA over its whole stored history: movements, not room. */
export function lifetimeText(lifetime: TfsaLifetime): string {
  const est = (estimated: boolean) => (estimated ? " (est.)" : "");
  const lines = ["Over time, from your stored activity:"];
  for (const a of lifetime.accounts) {
    if (a.managed) { lines.push(`- ${a.label}: SnapTrade doesn't provide this managed account's activity.`); continue; }
    const since = a.firstDate ? ` since ${calendarDate(a.firstDate)}` : "";
    lines.push(`- ${a.label}: put in ${cad(a.putInCad ?? 0)}, taken out ${cad(Math.abs(a.takenOutCad ?? 0))}, net ${cad(a.netCad ?? 0)}${since}${est(a.estimated)}.`);
    if (a.years.length > 0) lines.push(`  Running net at the end of each year: ${a.years.map((y) => `${y.year} ${cad(y.netSoFarCad)}`).join("; ")}.`);
    if (a.firstDate && a.historyComplete) lines.push(`  The earliest activity SnapTrade has for this account is ${calendarDate(a.firstDate)}. Anything before that isn't in these figures.`);
    if (a.notCounted.length > 0) lines.push(`  Not counted: ${a.notCounted.map((n) => `${n.type} (${n.rows} ${n.rows === 1 ? "row" : "rows"}, ${cad(n.amountCad)})`).join("; ")}.`);
    if (a.transfersNetCad) lines.push(`  ${cad(Math.abs(a.transfersNetCad))} of the net is transfers. A direct transfer from another TFSA uses no room, so this isn't the same as contributions for room.`);
    if (a.unvaluedMoves > 0) lines.push(`  ${a.unvaluedMoves} ${a.unvaluedMoves === 1 ? "move has no value and isn't" : "moves have no value and aren't"} included.`);
    if (!a.historyComplete) lines.push("  This account's history is still loading, so these figures may be low.");
  }
  if (lifetime.accounts.length > 1) {
    const t = lifetime.total;
    lines.push(`All connected TFSAs, with moves between them netted out: put in ${cad(t.putInCad)}, taken out ${cad(Math.abs(t.takenOutCad))}, net ${cad(t.netCad)}${est(t.estimated)}.`);
  }
  lines.push("This doesn't include TFSAs at other institutions, or closed accounts that aren't connected.");
  return lines.join("\n");
}

export function roomText(result: RoomResult, _accounts: readonly RoomAccount[] = [], appBaseUrl?: string, fhsaLine?: string, rrspLine?: string, lifetimeLine?: string): string {
  const lines: string[] = [];
  if (result.status === "known") {
    const left = Math.max(0, result.roomLeftCad);
    // A known result's estimate comes from converted contributions only (outside and stated figures are CAD).
    const note = fxNote(result.fx.contributions) || (result.estimated ? " (est.)" : "");
    lines.push(`You have about ${cad(left)} of TFSA room left this year${note}.`);
    // A TFSA at another institution carried from an earlier year has no figure this year: say what the number rests on.
    if (result.headlineBasis) lines.push(`${result.headlineBasis}.`);
    if (result.notCounted?.length) lines.push(notCountedLine(result.notCounted, result.overLimitCad > 0), notCountedSave(result.notCounted));
    if (result.overLimitCad > 0) lines.push(roomAlertText(result));
    const over = overSentence(result);
    if (over) lines.push(over);
    const wentOver = result.overLimitCad > 0 ? [...result.ledger.rows].reverse().find((r) => r.wentOver) : undefined;
    if (wentOver && wentOver.date) {
      lines.push(`${calendarDate(wentOver.date)}: ${wentOver.label} · ${ledgerAmount(wentOver)}; this went over by ${cad(wentOver.excessCad ?? 0)}${withMatch(wentOver)}.`);
    }
    // A withdrawal that reduced an amount over: its room doesn't come back with the others.
    for (const w of result.ledger.rows) {
      if (w.kind !== "withdrawal" || !w.date || !((w.qualifyingCad ?? 0) > 0)) continue;
      lines.push(`${calendarDate(w.date)}: ${w.label} · ${ledgerAmount(w)}; ${withdrawalRowNote(w)}${withMatch(w)}.`);
    }
  } else {
    lines.push("I can't give a number yet:");
    const url = roomDashboardUrl(appBaseUrl);
    const enterable = result.missing.filter(dashboardEnterable).length;
    if (url && enterable > 0) {
      lines.push(`${enterable === result.missing.length ? "Enter these" : "You can enter some of these"} on the VestLens dashboard: ${url}`);
    }
    for (const item of result.missing) for (const q of questions(item, result.year)) lines.push(`- ${q}`);
  }
  const nearNewYear = newYearText(result.newYear, "TFSA", result.year);
  if (nearNewYear) lines.push(nearNewYear);
  const back = returningNote(result);
  if (back) lines.push(back);
  if (result.status === "known" && result.activityAsOf) {
    lines.push(`${freshnessLabel(result.activityAsOf)}.`);
  }
  if (result.status === "known") {
    const url = roomDashboardUrl(appBaseUrl);
    if (url) lines.push(`See every move: ${url}`);
  }
  if (result.basis.length > 0) lines.push(`Based on: ${result.basis.join("; ")}.`);
  if (lifetimeLine) lines.push(lifetimeLine);
  if (fhsaLine) lines.push(fhsaLine);
  if (rrspLine) lines.push(rrspLine);
  return lines.join("\n");
}

/** The input's accounts with their keys, and whether the room counts each as a TFSA (the engine's own rule). */
export function roomAccounts(input: RoomInput): RoomAccount[] {
  const { tfsas } = countedTfsas(input);
  return input.accounts.map((a) => ({
    accountKey: a.accountKey, label: a.label, neutral: a.neutral, inSet: tfsas.has(a.accountKey), maskedNumber: a.maskedNumber ?? null, value: a.value ?? null,
  }));
}

/** The result, the accounts and their keys, and the tax-year neighbourhood (facts without their subject). */
export async function buildRoomPayload(deps: RoomDeps, authSubject: string) {
  const now = (deps.now ?? (() => new Date()))();
  const input = await loadRoomInput(deps.loader, authSubject, torontoToday(now), now);
  const result = computeTfsaRoom(input);
  const accounts = roomAccounts(input);
  const bundle = await buildContext(deps.context, authSubject, { type: "tax_year", key: `${result.year}:tfsa` });
  const context = { ...bundle, facts: bundle.facts.map(({ subject: _subject, ...fact }) => fact) };
  const ambiguous = result.status === "missing" ? result.missing.find((m) => m.kind === "ambiguous") : undefined;
  (deps.log ?? ((e) => console.info(JSON.stringify(e))))({
    event: "tfsa_room", status: result.status,
    missing: result.status === "missing" ? result.missing.length : 0,
    ambiguous: ambiguous && ambiguous.kind === "ambiguous" ? ambiguous.count : 0,
  });
  const dashboardUrl = roomDashboardUrl(deps.appBaseUrl);
  // One FHSA summary, only when the user has a broker-labelled FHSA: its headline and line, without the ledger. A failed
  // FHSA read never fails the TFSA answer: the FHSA part is left out and a constant code is logged.
  let fhsaResult: FhsaRoomResult = { status: "none" };
  try {
    fhsaResult = computeFhsaRoom(await loadFhsaRoomInput(deps.loader, authSubject, torontoToday(now), now));
  } catch {
    (deps.log ?? ((e) => console.info(JSON.stringify(e))))({ event: "fhsa_room", status: "error" });
  }
  const fhsa = fhsaResult.status === "none" ? undefined : (({ ledger, ...rest }, shown) => ({
    ...rest, overSince: ledger.overSince, headline: fhsaHeadline(shown), line: fhsaText(shown), disclosures: fhsaDisclosures(shown),
    ...(rest.status === "known" ? { note: fxNote(rest.fx.contributions).trim() || null } : {}),
    ...(rest.newYear?.length ? { newYearNote: newYearText(rest.newYear, "FHSA", rest.year) } : {}),
  }))(fhsaResult, fhsaResult);
  // One RRSP summary per open tax year, the same way: a failed RRSP read leaves RRSP out and logs a constant code.
  let rrspResult: RrspRoomResult = { status: "none" };
  try {
    rrspResult = computeRrspRoom(await loadRrspRoomInput(deps.loader, authSubject, torontoToday(now), now));
  } catch {
    (deps.log ?? ((e) => console.info(JSON.stringify(e))))({ event: "rrsp_room", status: "error" });
  }
  const rrspShown = rrspResult.status === "shown" ? rrspResult : undefined;
  const rrsp = rrspShown && {
    ...rrspShown,
    years: rrspShown.years.map((year) => { const { ledger: _ledger, ...rest } = year; return { ...rest, headline: rrspHeadline(year) }; }),
    line: rrspText(rrspShown),
  };
  // The same way again: a failed read of the whole history leaves it out and logs a constant code.
  let lifetime: (TfsaLifetime & { line: string }) | undefined;
  try {
    const computed = await loadTfsaLifetime(deps.loader, authSubject, torontoToday(now));
    if (computed.accounts.length > 0) lifetime = { ...computed, line: lifetimeText(computed) };
  } catch {
    (deps.log ?? ((e) => console.info(JSON.stringify(e))))({ event: "tfsa_lifetime", status: "error" });
  }
  // The New Year check's words, so the card says exactly what the text says.
  const newYearNote = newYearText(result.newYear, "TFSA", result.year);
  return {
    ...result, accounts, context, ...(dashboardUrl ? { dashboardUrl } : {}), ...(newYearNote ? { newYearNote } : {}),
    ...(fhsa ? { fhsa } : {}), ...(rrsp ? { rrsp } : {}), ...(lifetime ? { lifetime } : {}),
  };
}
