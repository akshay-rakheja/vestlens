import { BENCHMARKS } from "../analytics/benchmarks.js";
import {
  replayIntoBenchmark, returnSince, shadowBasis, type BenchmarkClose, type ExcludedFlow, type HoldingFlow,
  type ShadowBenchmarkBasis, type ShadowFlow,
} from "../analytics/shadow-benchmark.js";
import type { Condition, ConditionKind, Thesis } from "../memory/memory-types.js";
import type { MoodLevel } from "../news/scoring.js";
import { freshDay, POSITIONS_STALE_NOTE, PRICE_STALE_TRADING_DAYS, torontoDay, tradingDaysBetween } from "../portfolio/data-freshness.js";

/**
 * The thesis check (spec 2026-10-24 §5.2, §8, §11a.1-4): a pure evaluation of one thesis against figures the loader
 * read. It states facts only; a condition is `held` or `broken` only on fresh, complete data, and `cant_tell`
 * otherwise. Every string here is VestLens copy, except the user's own condition text and news titles/sources, which
 * are passed through verbatim.
 */

/** A brokerage price older than PRICE_STALE_TRADING_DAYS Toronto weekdays (holidays ignored) is not used (§11a.1). */
export { PRICE_STALE_TRADING_DAYS, tradingDaysBetween };
export const NEWS_LIMIT = 5;
export const FUNDAMENTAL_PENDING = "can't check automatically yet";
export const TIME_FRAME_ENDED = "time frame ended";
/** Built from each benchmark's basis (shadowBasis), so a switch of series can't leave this copy stale. */
const BASIS_COPY: Record<ShadowBenchmarkBasis, string> = { total_return: "total return, dividends reinvested", price_index: "a price index, dividends not included" };
export const BENCHMARK_BASIS_NOTE = `${BENCHMARKS.sp500.name} is ${BASIS_COPY[shadowBasis("sp500")]}; ${BENCHMARKS.tsx.name} is ${BASIS_COPY[shadowBasis("tsx")]}. Your holding's dividends are counted.`;
/** The units held now don't match the start units plus the activity since (final review I-2): posting lag, a split. */
export const ACTIVITY_NOT_RECORDED = "recent activity hasn't been recorded yet";
/** An account involved has never synced its activity, so the shares held can't be checked against it. */
export const ACTIVITY_NOT_LOADED = "activity hasn't been loaded yet; it refreshes nightly";
/** Activity older than this is not used for a return: a sync that stopped without an error would miss dividends. */
export const ACTIVITY_STALE_DAYS = 7;
export const activityStaleNote = (day: string) => `activity was last updated ${day}; there'll be a number after it refreshes`;
/** How current the stored activity behind a return is (the oldest involved account's last sync, Toronto date). */
export const activityAsOfNote = (day: string) => `Based on activity up to ${day}.`;
/** The start or current position reported no units, so the activity since can't be checked against it. */
export const UNITS_NOT_REPORTED = "share counts weren't reported, so recent activity can't be checked";
/** The cheap pass (Plans list, status lines) doesn't load the start, flows or end: the full check does. */
export const CHECKED_IN_FULL_VIEW = "checked in the full view";
/** Played out when shares arrived or left in the period without a recorded value (C-1). */
export const SHARES_MOVED_UNVALUED = "can't compare: shares moved without a recorded value";
export const EXCLUSION_COPY: Record<ExcludedFlow["reason"], string> = {
  "no purchase date": "can't compare: no purchase date",
  "no date": "can't compare: no date",
  "no amount": "can't compare: amount not recorded",
  "not converted": "can't compare: currency not converted",
};
export const shadowExhaustedNote = (benchmark: string) => `Your sales took out more than the same money in the ${benchmark} would have been worth.`;

const LEFT_OUT_NOTE = "The comparison covers the rest of your activity; the items listed are left out.";
const NOTE = {
  stale: `latest price is more than ${PRICE_STALE_TRADING_DAYS} trading days old`,
  positionsStale: POSITIONS_STALE_NOTE,
  noPrice: "no recent brokerage price for this holding",
  delayed: "price as reported by your brokerage; may be delayed",
  listings: "held as more than one listing under this ticker; listings are not combined",
  noStart: "no value found for this holding when you wrote it",
  noCoverage: "stored activity doesn't reach back to when you wrote it",
  noEnd: "no current value for this holding",
  noSolution: "not enough data to work out a return",
  excluded: "some activity since you wrote it can't be valued",
  noWeight: "portfolio weight not available",
  syncError: "activity sync for an account holding it reported an error",
} as const;
/** The reasons above, for callers that code them (the report card log). */
export const CHECK_NOTES = NOTE;
export const noBenchmarkNote = (name: string) => `No ${name} close for every date in the period, so no comparison with it.`;

export interface ThesisNewsItem { title: string; source: string; publishedAt: Date; symbols: string[]; mood: MoodLevel | null; /** The article address from the news store. */ url?: string | null }

export interface ThesisInput {
  ticker: string;
  thesis: Thesis;
  writtenAt: Date;
  /** The ticker matches more than one listing (CAD and US): holding figures are never combined. */
  multipleListings: boolean;
  /** The latest brokerage-reported price in the security's native currency; `asOf` is its Toronto date. */
  price: { value: number; currency: string; asOf: string } | null;
  /**
   * The holding's share (0-100) of the investment total, cash included and net of any margin debit (`netOfMargin`), with
   * any managed accounts left out named (`notInTotal`), as of the oldest positions date (`asOf`) of
   * the accounts counted; 0 only when sold in full is verified; null when unknown.
   */
  weight: { pct: number; estimated: boolean; asOf: string; netOfMargin?: boolean; notInTotal?: string[] } | null;
  /** An account involved reported an activity sync error (`lastError`): flows may be incomplete. */
  syncError: boolean;
  /** The holding's CAD value at the start: the first point at or after `writtenAt` with a known value; null when none. */
  start: { date: string; valueCad: number; estimated: boolean } | null;
  /** The CAD value now (or 0 on the date it was sold in full); `date` is the date of its prices. */
  end: { date: string; valueCad: number; estimated: boolean } | null;
  /** Why `end` is null when the loader knows (ACTIVITY_NOT_RECORDED, ACTIVITY_NOT_LOADED, UNITS_NOT_REPORTED); else "no current value". */
  endNote?: string;
  /** Toronto date of the oldest involved account's last activity sync; a return shown carries it as a note. */
  activityAsOf?: string | null;
  /** Return-based figures are not worked out in this pass; this is the stated reason (CHECKED_IN_FULL_VIEW). */
  returnNote?: string;
  /** The holding's dated CAD flows on or after the Toronto date of `writtenAt` (reinvested dividends already paired). */
  flows: HoldingFlow[];
  excluded: ExcludedFlow[];
  /** First date stored activity covers for the accounts involved; null when unknown. */
  coverageStart: string | null;
  benchmarks: { sp500: BenchmarkClose[] | null; tsx: BenchmarkClose[] | null };
  news: ThesisNewsItem[];
  /** Known (confirmed) earnings report dates, YYYY-MM-DD. */
  earnings: string[];
}

export type ConditionStatus = "held" | "broken" | "cant_tell";
export interface ConditionCheck {
  id: string; text: string; kind: ConditionKind; status: ConditionStatus;
  evidence?: { value: string; asOf: string };
  note?: string;
}
export interface ThesisCheck {
  ticker: string;
  writtenAt: string;
  timeFrame: { label: string; ended: boolean } | null;
  conditions: ConditionCheck[];
  news: Array<{ title: string; source: string; publishedAt: string; tone: string | null; url?: string }>;
  earnings: Array<{ date: string }>;
  playedOut: {
    returnPct: number | null;
    vsSp500Pct: number | null;
    vsTsxPct: number | null;
    estimated: boolean;
    excluded: string[];
    reason?: string;
    /** The period compared; null when there is no comparison. */
    startDate: string | null;
    endDate: string | null;
    notes: string[];
  };
}

const fresh = freshDay;

const pct1 = (n: number) => `${(Math.round(n * 10) / 10).toFixed(1)}%`;
const MOOD_WORDS: Record<MoodLevel, string> = {
  strongly_negative: "strongly negative", negative: "negative", neutral: "neutral", positive: "positive", strongly_positive: "strongly positive",
};

function wholeMonths(fromDay: string, toDay: string): number {
  const [fy, fm, fd] = fromDay.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = toDay.split("-").map(Number) as [number, number, number];
  return Math.max(0, (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0));
}
const monthsText = (n: number) => (n === 0 ? "less than a month" : n === 1 ? "1 month" : `${n} months`);

function timeFrameOf(t: Thesis["timeFrame"], written: string, today: string): ThesisCheck["timeFrame"] {
  if (!t) return null;
  const into = wholeMonths(written, today);
  if (t.kind === "short") {
    return today > t.endDate ? { label: TIME_FRAME_ENDED, ended: true } : { label: `${monthsText(into)} into a time frame ending ${t.endDate}`, ended: false };
  }
  if (into >= t.years * 12) return { label: TIME_FRAME_ENDED, ended: true };
  return { label: `${monthsText(into)} into a ${t.years}-year thesis`, ended: false };
}

interface ReturnFigure { pct: number | null; estimated: boolean; note?: string; endDate?: string }

/** What the return, the benchmarks and "played out" read: a thesis input, or the holding view's (from the first purchase). */
type ReturnInput = Pick<ThesisInput, "returnNote" | "multipleListings" | "syncError" | "start" | "end" | "endNote" | "activityAsOf" | "coverageStart" | "flows" | "benchmarks">;

/** Money-weighted return since the start, with every reason it is not a number. */
function holdingReturn(input: ReturnInput, today: string, noCoverage: string = NOTE.noCoverage): ReturnFigure {
  if (input.returnNote) return { pct: null, estimated: false, note: input.returnNote };
  if (input.multipleListings) return { pct: null, estimated: false, note: NOTE.listings };
  if (input.syncError) return { pct: null, estimated: false, note: NOTE.syncError };
  const { start, end } = input;
  if (!start || !Number.isFinite(start.valueCad)) return { pct: null, estimated: false, note: NOTE.noStart };
  if (typeof input.coverageStart !== "string" || input.coverageStart > start.date) return { pct: null, estimated: false, note: noCoverage };
  if (!end || !Number.isFinite(end.valueCad)) return { pct: null, estimated: false, note: input.endNote ?? NOTE.noEnd };
  if (end.valueCad > 0 && !fresh(end.date, today)) return { pct: null, estimated: false, note: NOTE.stale };
  const flows = periodFlows(input.flows, start.date, end.date);
  const r = returnSince(start.date, start.valueCad, flows, end.valueCad, { endDate: end.date, coverageStart: input.coverageStart });
  if (r.pct === null) return { pct: null, estimated: false, note: r.reason === "no_coverage" ? noCoverage : r.reason === "no_start_value" ? NOTE.noStart : NOTE.noSolution };
  return { pct: r.pct, estimated: start.estimated || end.estimated || flows.some((f) => f.estimated === true), endDate: end.date };
}

const periodFlows = (flows: HoldingFlow[], startDate: string, endDate: string): ShadowFlow[] =>
  flows.filter((f) => f.date > startDate && f.date <= endDate && Number.isFinite(f.amountCad)).map((f) => ({ date: f.date, amountCad: f.amountCad, estimated: f.estimated }));

/** Excluded flows that fall in the period: undated ones (timing unknown) and those after the start date. */
function excludedInPeriod(input: ThesisInput): ExcludedFlow[] {
  const startDate = input.start?.date ?? torontoDay(input.writtenAt);
  return input.excluded.filter((e) => e.date === null || e.date > startDate);
}

function checkCondition(c: Condition, input: ThesisInput, ret: ReturnFigure, excluded: ExcludedFlow[], today: string): ConditionCheck {
  const base = { id: c.id, text: c.text, kind: c.kind };
  const cantTell = (note?: string): ConditionCheck => ({ ...base, status: "cant_tell", ...(note ? { note } : {}) });
  switch (c.kind) {
    case "price_below":
    case "price_above": {
      if (input.multipleListings) return cantTell(NOTE.listings);
      const p = input.price;
      if (!p || !Number.isFinite(p.value) || p.value <= 0) return cantTell(NOTE.noPrice);
      if (!fresh(p.asOf, today)) return cantTell(NOTE.stale);
      if (p.currency.toUpperCase() !== c.currency.toUpperCase()) return cantTell(`price is reported in ${p.currency.toUpperCase()}, not ${c.currency.toUpperCase()}`);
      const broken = c.kind === "price_below" ? p.value < c.price : p.value > c.price;
      return { ...base, status: broken ? "broken" : "held", evidence: { value: `${p.value.toFixed(2)} ${p.currency.toUpperCase()}`, asOf: p.asOf }, note: NOTE.delayed };
    }
    case "return_below": {
      if (ret.pct === null) return cantTell(ret.note);
      if (excluded.length > 0) return cantTell(NOTE.excluded);
      return { ...base, status: ret.pct < c.pct ? "broken" : "held", evidence: { value: `${pct1(ret.pct)} (est.)`, asOf: ret.endDate! } };
    }
    case "weight_above": {
      if (input.multipleListings) return cantTell(NOTE.listings);
      const w = input.weight;
      if (!w || !Number.isFinite(w.pct)) return cantTell(NOTE.noWeight);
      if (!fresh(w.asOf, today)) return cantTell(NOTE.positionsStale);
      return { ...base, status: w.pct > c.pct ? "broken" : "held", evidence: { value: `${pct1(w.pct)} of your portfolio, cash included${w.estimated ? " (est.)" : ""}`, asOf: w.asOf } };
    }
    case "fundamental":
      return cantTell(FUNDAMENTAL_PENDING);
    case "custom":
      return cantTell();
  }
}

/** One benchmark: the same start value and flows replayed into its series, compared as a money-weighted return. */
function versus(input: ReturnInput, ret: ReturnFigure, series: BenchmarkClose[] | null, name: string, notes: string[]): { vs: number | null; estimated: boolean } {
  if (ret.pct === null || !input.start || !ret.endDate) return { vs: null, estimated: false };
  if (!series || series.length === 0) { notes.push(noBenchmarkNote(name)); return { vs: null, estimated: false }; }
  const { start } = input;
  const flows = periodFlows(input.flows, start.date, ret.endDate);
  const shadow = replayIntoBenchmark([{ date: start.date, amountCad: -start.valueCad, estimated: start.estimated }, ...flows], series, ret.endDate);
  if (shadow.shadowExhausted) { notes.push(shadowExhaustedNote(name)); return { vs: null, estimated: shadow.estimated }; }
  if (shadow.valueCad === null) { notes.push(noBenchmarkNote(name)); return { vs: null, estimated: false }; }
  const b = returnSince(start.date, start.valueCad, flows, shadow.valueCad, { endDate: ret.endDate, coverageStart: input.coverageStart });
  if (b.pct === null) { notes.push(noBenchmarkNote(name)); return { vs: null, estimated: false }; }
  return { vs: ret.pct - b.pct, estimated: shadow.estimated };
}

function playedOut(input: ReturnInput, ret: ReturnFigure, excluded: ExcludedFlow[]): ThesisCheck["playedOut"] {
  const excludedCopy = [...new Set(excluded.map((e) => EXCLUSION_COPY[e.reason]))];
  const none = (reason: string): ThesisCheck["playedOut"] =>
    ({ returnPct: null, vsSp500Pct: null, vsTsxPct: null, estimated: false, excluded: excludedCopy, reason, startDate: null, endDate: null, notes: [] });
  // The cheap pass states where the figure is, not a reason it can't be found (I-3).
  if (input.returnNote) return none(input.returnNote);
  if (ret.pct === null) return none(`can't tell: ${ret.note ?? NOTE.noSolution}`);
  // Shares that arrived or left unvalued are in (or missing from) the value with no flow to match: no number at all.
  if (excluded.some((e) => e.unitsMoved)) return none(SHARES_MOVED_UNVALUED);
  const notes: string[] = [BENCHMARK_BASIS_NOTE];
  const sp = versus(input, ret, input.benchmarks.sp500, BENCHMARKS.sp500.name, notes);
  const tsx = versus(input, ret, input.benchmarks.tsx, BENCHMARKS.tsx.name, notes);
  if (excludedCopy.length > 0) notes.push(LEFT_OUT_NOTE);
  if (input.activityAsOf) notes.push(activityAsOfNote(input.activityAsOf));
  return {
    returnPct: ret.pct, vsSp500Pct: sp.vs, vsTsxPct: tsx.vs,
    estimated: ret.estimated || sp.estimated || tsx.estimated || excludedCopy.length > 0,
    excluded: excludedCopy, startDate: input.start!.date, endDate: ret.endDate!, notes,
  };
}

/** The ticker's news after `since` (to `now`), newest first, at most NEWS_LIMIT; only an http(s) address is kept. */
function newsSince(items: ThesisNewsItem[], ticker: string, since: Date, now: Date): ThesisCheck["news"] {
  const want = ticker.trim().toUpperCase();
  return items
    .filter((n) => n.symbols.some((s) => s.trim().toUpperCase() === want) && n.publishedAt > since && n.publishedAt <= now)
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, NEWS_LIMIT)
    .map((n) => ({ title: n.title, source: n.source, publishedAt: n.publishedAt.toISOString(), tone: n.mood ? `news tone: ${MOOD_WORDS[n.mood]}` : null, ...(n.url && /^https?:\/\//i.test(n.url) ? { url: n.url } : {}) }));
}

export function checkThesis(input: ThesisInput, now: Date): ThesisCheck {
  const today = torontoDay(now);
  const written = torontoDay(input.writtenAt);
  const ret = holdingReturn(input, today);
  const excluded = excludedInPeriod(input);
  const news = newsSince(input.news, input.ticker, input.writtenAt, now);
  const earnings = [...new Set(input.earnings.filter((d) => d > written && d <= today))].sort().map((date) => ({ date }));
  return {
    ticker: input.ticker,
    writtenAt: input.writtenAt.toISOString(),
    timeFrame: timeFrameOf(input.thesis.timeFrame, written, today),
    conditions: input.thesis.conditions.map((c) => checkCondition(c, input, ret, excluded, today)),
    news,
    earnings,
    playedOut: playedOut(input, ret, excluded),
  };
}

/* ------------------------------------------------------------------------------------------------------------------
 * The holding view (show_thesis for any holding, thesis optional): how the holding has done since the first purchase.
 * ---------------------------------------------------------------------------------------------------------------- */

/** News in the holding view: this many days back. */
export const HOLDING_NEWS_DAYS = 30;
export const NO_REASONS_SAVED = "No reasons saved for this holding.";
export const NO_PURCHASE_RECORDED = "no purchase of this holding is recorded";
/** Coverage starts after the first recorded purchase, or activity was recorded before it: the history is incomplete. */
export const NO_FULL_HISTORY = "stored activity doesn't cover this holding's full history";
const MONEY_WEIGHTED_NOTE = "Money-weighted from your first recorded purchase: each purchase, sale and dividend (before withholding) counts from its own date.";
export const TRANSFER_IN_FIRST_NOTE = "Your first recorded purchase is a transfer-in valued at the reported price.";
export const bocNote = (date: string) => `USD amounts converted at the Bank of Canada rate of each date (est.); latest rate ${date}.`;

/** The holding view's news window: since `writtenAt` when that is within HOLDING_NEWS_DAYS, else the last HOLDING_NEWS_DAYS. */
export function holdingNewsSince(now: Date, writtenAt?: Date): Date {
  const floor = new Date(now.getTime() - HOLDING_NEWS_DAYS * 86_400_000);
  return writtenAt && writtenAt > floor ? writtenAt : floor;
}

export interface HoldingInput {
  ticker: string;
  /** The ticker matches more than one listing (CAD and US): holding figures are never combined. */
  multipleListings: boolean;
  /** An account involved reported an activity sync error (`lastError`). */
  syncError: boolean;
  /** As ThesisInput.weight. */
  weight: ThesisInput["weight"];
  /** Every dated CAD flow of the holding in stored activity, from the beginning (reinvested dividends paired away). */
  flows: HoldingFlow[];
  /** Every row left out of `flows`, whatever its date. */
  excluded: ExcludedFlow[];
  /** First date stored activity covers for the accounts involved; null when unknown. */
  coverageStart: string | null;
  /**
   * The CAD value now (or 0 on the last flow date when sold in full is verified); null when unknown. The loader gives
   * one only when every unit held now is explained by stored activity from zero (held-path unit reconciliation).
   * `rateDate` is the Bank of Canada rate date of a converted value.
   */
  end: { date: string; valueCad: number; estimated: boolean; rateDate?: string | null } | null;
  endNote?: string;
  activityAsOf?: string | null;
  benchmarks: ThesisInput["benchmarks"];
  news: ThesisNewsItem[];
}

export interface HoldingCheck {
  ticker: string;
  /** As ThesisCheck.playedOut; `startDate` is the first recorded purchase (stored activity can't show an earlier one). */
  sinceFirstBought: ThesisCheck["playedOut"];
  /** The holding's share (0-100) of the investment total, cash included; null with `weightNote` when not shown. */
  weight: { pct: number; estimated: boolean; asOf: string; netOfMargin?: boolean; notInTotal?: string[] } | null;
  weightNote?: string;
  /** The last HOLDING_NEWS_DAYS days. */
  news: ThesisCheck["news"];
}

const ACQUIRING = new Set<HoldingFlow["kind"]>(["buy", "transfer_in"]);

function latestRateDate(input: HoldingInput, startDate: string, endDate: string): string | null {
  const dates: string[] = [];
  for (const f of input.flows) if (f.estimated && f.rateDate && f.date >= startDate && f.date <= endDate) dates.push(f.rateDate);
  if (input.end?.estimated && input.end.rateDate) dates.push(input.end.rateDate);
  for (const series of [input.benchmarks.sp500, input.benchmarks.tsx]) {
    for (const p of series ?? []) if (p.estimated && p.rateDate && p.date <= endDate) dates.push(p.rateDate);
  }
  return dates.sort().at(-1) ?? null;
}

/**
 * Since the first recorded purchase: nothing held before it (start 0), so the first day's net purchase is the start value and
 * every later flow follows on its date; replayed into the S&P 500 and TSX the same way. Never a number unless stored
 * activity reaches back to that purchase, nothing was recorded before it, no shares moved unvalued, and the thesis
 * check's gates hold (listings, sync, a fresh reconciled end).
 */
function sinceFirstBought(input: HoldingInput, today: string): ThesisCheck["playedOut"] {
  const excludedCopy = [...new Set(input.excluded.map((e) => EXCLUSION_COPY[e.reason]))];
  const none = (reason: string): ThesisCheck["playedOut"] =>
    ({ returnPct: null, vsSp500Pct: null, vsTsxPct: null, estimated: false, excluded: excludedCopy, reason, startDate: null, endDate: null, notes: [] });
  const first = input.flows.filter((f) => ACQUIRING.has(f.kind) && Number.isFinite(f.amountCad)).map((f) => f.date).sort()[0];
  if (!first) {
    if (input.excluded.some((e) => e.unitsMoved)) return none(SHARES_MOVED_UNVALUED);
    return none(`can't tell: ${NO_PURCHASE_RECORDED}`);
  }
  // Anything recorded before the first recorded purchase (a sale, a dividend) means the holding predates stored activity.
  if (input.flows.some((f) => f.date < first)) return none(`can't tell: ${NO_FULL_HISTORY}`);
  // Shares that arrived or left unvalued: the stated reason, ahead of the units check they also fail.
  if (input.excluded.some((e) => e.unitsMoved)) return none(SHARES_MOVED_UNVALUED);
  const net = input.flows.filter((f) => f.date === first).reduce((a, f) => a + f.amountCad, 0);
  if (!(net < 0)) return none(`can't tell: ${NOTE.noSolution}`);
  const pseudo: ReturnInput = {
    multipleListings: input.multipleListings, syncError: input.syncError,
    start: { date: first, valueCad: Math.round(-net * 100) / 100, estimated: input.flows.some((f) => f.date === first && f.estimated) },
    end: input.end, ...(input.endNote ? { endNote: input.endNote } : {}), activityAsOf: input.activityAsOf ?? null,
    coverageStart: input.coverageStart, flows: input.flows, benchmarks: input.benchmarks,
  };
  const ret = holdingReturn(pseudo, today, NO_FULL_HISTORY);
  const out = playedOut(pseudo, ret, input.excluded);
  if (out.returnPct === null || !out.startDate || !out.endDate) return out;
  const rateDate = latestRateDate(input, out.startDate, out.endDate);
  const transferFirst = input.flows.some((f) => f.date === first && f.kind === "transfer_in");
  return { ...out, notes: [MONEY_WEIGHTED_NOTE, ...(transferFirst ? [TRANSFER_IN_FIRST_NOTE] : []), ...out.notes, ...(rateDate ? [bocNote(rateDate)] : [])] };
}

/**
 * `opts.newsSince` (a thesis's writtenAt): news since then, or the last HOLDING_NEWS_DAYS days when it is older.
 */
export function checkHolding(input: HoldingInput, now: Date, opts: { newsSince?: Date } = {}): HoldingCheck {
  const today = torontoDay(now);
  const w = input.weight;
  let weight: HoldingCheck["weight"] = null;
  let weightNote: string | undefined;
  if (input.multipleListings) weightNote = NOTE.listings;
  else if (!w || !Number.isFinite(w.pct)) weightNote = NOTE.noWeight;
  else if (!fresh(w.asOf, today)) weightNote = NOTE.positionsStale;
  else weight = { pct: w.pct, estimated: w.estimated, asOf: w.asOf };
  return {
    ticker: input.ticker,
    sinceFirstBought: sinceFirstBought(input, today),
    weight, ...(weightNote ? { weightNote } : {}),
    news: newsSince(input.news, input.ticker, holdingNewsSince(now, opts.newsSince), now),
  };
}
