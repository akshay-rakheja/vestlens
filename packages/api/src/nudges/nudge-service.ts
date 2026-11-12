import { createHash } from "node:crypto";

import { isInvestable } from "../analytics/holdings.js";
import { homeConverter, loadHomeConverter, type HomeConverter } from "../fx/home-currency.js";
import { checkLimits, formatPct, type LimitCheck } from "../limits/limit-check.js";
import { loadLimitInput } from "../limits/limit-loader.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import { accountLabels, quotedUserText } from "../mcp/portfolio-fact-tools.js";
import { stripControlAndFormat } from "../mcp/user-text.js";
import type { ConcentrationLimit, Condition, ConditionKind } from "../memory/memory-types.js";
import { readLimits, readTheses, type PortfolioFactsSource } from "../memory/portfolio-facts.js";
import { positionsAsOfDay, torontoDay } from "../portfolio/data-freshness.js";
import type { PortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import { checkThesis } from "../theses/thesis-check.js";
import { quickThesisInput } from "../theses/thesis-loader.js";

/**
 * Nightly thesis-condition and concentration-limit nudges (spec 2026-10-24 §5.3, §6, §11a.5). One row per
 * (subject, kind, target, conditionId): raised when a condition is newly broken or a limit newly exceeded, cleared when
 * it holds again (or its thesis, condition or limit is gone), raised again on the next transition. `cant_tell` never
 * raises and leaves an open row alone. The row keeps its text, so readers (get_portfolio_alerts, the dashboard) state
 * it from the row alone, with no evaluation and no write.
 *
 * Only the cheap checks the status lines use run here: thesis price and weight conditions, and limits, from a portfolio
 * the caller already has and the BoC rate. No news, benchmark, activity or brokerage read. Return, fundamental and
 * custom conditions are skipped (no nudge in v1). The text states facts only. Nothing here logs.
 */

export type NudgeKind = "thesis_condition" | "limit";
export const NUDGE_TEXT_MAX = 400;
/** Width of the target and conditionId columns. */
const KEY_MAX = 120;
/** Condition kinds evaluated at night: the same cheap checks as the status lines. */
const NIGHTLY_CONDITIONS: ReadonlySet<ConditionKind> = new Set(["price_below", "price_above", "weight_above"]);

export interface NudgeRow {
  id: string;
  subject: string;
  kind: NudgeKind;
  /** Ticker (as saved) for a thesis condition; the limit's slug for a limit. */
  target: string;
  /** The condition id for a thesis; the group key (listing "SYMBOL|CURRENCY", sector or class) for a limit. */
  conditionId: string | null;
  /** Hash of what the text was stated against (conditionBasis / limitBasis); a reader hides a row that no longer matches. */
  basis: string | null;
  text: string;
  raisedAt: Date;
  updatedAt: Date;
  clearedAt: Date | null;
}

type NudgeData = Omit<NudgeRow, "id">;

export interface NudgePrismaPort {
  portfolioNudge: {
    findMany(input: { where: { subject: string; clearedAt?: null }; orderBy?: Array<{ raisedAt: "asc" } | { id: "asc" }> }): Promise<NudgeRow[]>;
    create(input: { data: NudgeData }): Promise<unknown>;
    update(input: { where: { id: string }; data: Partial<Pick<NudgeRow, "text" | "basis" | "raisedAt" | "updatedAt" | "clearedAt">> }): Promise<unknown>;
  };
}

export interface NudgeDeps {
  prisma: NudgePrismaPort;
  memory: PortfolioFactsSource;
  /** The latest stored portfolio, used only when the caller passes none; never a brokerage refresh. */
  portfolio: (subject: string) => Promise<PortfolioPresentation>;
  market: Pick<MarketDataService, "usdCad"> & Partial<Pick<MarketDataService, "cachedProfileLookup" | "cachedProfile">>;
  now?: () => Date;
}

export interface NudgeOutcome { raised: number; cleared: number; failed: number }
export interface OpenNudge { kind: NudgeKind; target: string; text: string; raisedAt: Date }

const upper = (s: string) => s.trim().toUpperCase();
const oneLine = (s: string) => stripControlAndFormat(s).replace(/\s+/g, " ").trim();
const shortHash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

/** What a condition nudge is stated against: its kind and threshold (the id already covers the text). */
export function conditionBasis(c: Condition): string {
  switch (c.kind) {
    case "price_below":
    case "price_above": return shortHash([c.kind, c.price, c.currency.toUpperCase()]);
    case "return_below":
    case "weight_above": return shortHash([c.kind, c.pct]);
    default: return shortHash([c.kind]);
  }
}

/** What a limit nudge is stated against: its maximum and account set (the slug already covers kind and target). */
export const limitBasis = (l: ConcentrationLimit) => shortHash([l.maxPct, l.accounts ? [...new Set(l.accounts)].sort() : null]);
const keyOf = (kind: NudgeKind, target: string, conditionId: string | null) => `${kind}\u0000${target}\u0000${conditionId ?? ""}`;
const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";

/** `text` with `user` cut (ending "…") so the whole stays within the cap. */
function fitted(build: (user: string) => string, user: string): string {
  const full = build(user);
  if (full.length <= NUDGE_TEXT_MAX) return full;
  const room = Math.max(1, user.length - (full.length - NUDGE_TEXT_MAX) - 1);
  return build(`${user.slice(0, room).trimEnd()}…`);
}

/**
 * `Your <TICKER> thesis condition "<text>" looks broken (<evidence>).` The user's text is quoted by quotedUserText (as
 * show_thesis shows it: control and format characters removed, JSON-quoted), so it can't end its quotes or forge lines; it is cut
 * (ending "…") to keep the whole within the cap.
 */
export function thesisNudgeText(ticker: string, condition: string, evidence: string): string {
  const build = (q: string) => `Your ${ticker} thesis condition ${q} looks broken (${evidence}).`;
  let max = 300;
  let text = build(quotedUserText(condition, max));
  while (text.length > NUDGE_TEXT_MAX && max > 1) {
    max = Math.max(1, max - (text.length - NUDGE_TEXT_MAX));
    text = build(quotedUserText(condition, max));
  }
  return text;
}

export function limitNudgeText(row: Pick<LimitCheck, "label" | "currentPct" | "maxPct" | "fxDate" | "estimated">, o: { subset: boolean; accounts?: string }): string {
  const basis = o.subset ? "the chosen accounts" : "your portfolio";
  const bank = row.fxDate ? ` USD converted at the Bank of Canada rate of ${row.fxDate}.` : "";
  const label = o.accounts ? `${row.label} in ${o.accounts}` : row.label;
  return fitted((l) => `${l} is ${formatPct(row.currentPct ?? 0)}%${row.estimated === false ? "" : " (est.)"} of ${basis}, over your ${formatPct(row.maxPct)}% limit.${bank}`, oneLine(label));
}

/** A converter for the portfolio's positions dates (no rate read without a foreign holding), and the latest BoC date used. */
async function converterFor(market: NudgeDeps["market"], portfolio: PortfolioPresentation, today: string): Promise<{ fx: HomeConverter; fxDate: string | null }> {
  const accounts = (portfolio.accounts ?? []).filter(isInvestable);
  const foreign = (a: PortfolioPresentation["accounts"][number]) => (a.positions ?? []).some((p) => p.currency && upper(p.currency) !== "CAD")
    || (a.balances ?? []).some((b) => b.currency && upper(b.currency) !== "CAD" && typeof b.cash === "number" && b.cash !== 0);
  if (!accounts.some(foreign)) return { fx: homeConverter(null, today), fxDate: null };
  const days = accounts.map(positionsAsOfDay).filter((d): d is string => d !== null).sort();
  const fx = await loadHomeConverter(market, days[0] ?? today, today);
  let fxDate: string | null = null;
  for (const a of accounts.filter(foreign)) {
    const d = fx.at(1, "USD", positionsAsOfDay(a) ?? today).rateDate;
    if (d && (fxDate === null || d > fxDate)) fxDate = d;
  }
  return { fx, fxDate };
}

type Desired = { key: string; kind: NudgeKind; target: string; conditionId: string | null; basis: string; text: string } | { key: string; clear: true };

export class NudgeService {
  private readonly now: () => Date;

  constructor(private readonly o: NudgeDeps) {
    this.now = o.now ?? (() => new Date());
  }

  /**
   * Brings the subject's nudges in line with their current theses and limits. `portfolio` is the one the caller
   * already holds (the nightly run passes the accounts its snapshot read); otherwise the stored one is read, and only
   * when there is something to evaluate. Each part (theses, limits) that fails is counted and leaves its rows alone.
   */
  async evaluateNudges(subject: string, now: Date = this.now(), options: { portfolio?: PortfolioPresentation } = {}): Promise<NudgeOutcome> {
    const table = this.o.prisma.portfolioNudge;
    const rows = new Map((await table.findMany({ where: { subject } })).map((r) => [keyOf(r.kind, r.target, r.conditionId), r]));
    const today = torontoDay(now);
    let portfolioRead: Promise<PortfolioPresentation> | undefined;
    const portfolio = () => (portfolioRead ??= options.portfolio ? Promise.resolve(options.portfolio) : this.o.portfolio(subject));
    const outcome: NudgeOutcome = { raised: 0, cleared: 0, failed: 0 };

    const parts: Array<() => Promise<Desired[]>> = [
      () => this.thesisPart(subject, rows, portfolio, now, today),
      () => this.limitPart(subject, rows, portfolio, now),
    ];
    for (const part of parts) {
      let desired: Desired[];
      try {
        desired = await part();
      } catch {
        outcome.failed += 1;
        continue;
      }
      for (const d of desired) {
        try {
          if ("clear" in d) {
            const row = rows.get(d.key);
            if (row && row.clearedAt === null) {
              await table.update({ where: { id: row.id }, data: { clearedAt: now, updatedAt: now } });
              rows.set(d.key, { ...row, clearedAt: now, updatedAt: now });
              outcome.cleared += 1;
            }
          } else if (await this.raise(subject, d, rows, now)) {
            outcome.raised += 1;
          }
        } catch {
          outcome.failed += 1;
        }
      }
    }
    return outcome;
  }

  private async thesisPart(subject: string, rows: Map<string, NudgeRow>, portfolio: () => Promise<PortfolioPresentation>, now: Date, today: string): Promise<Desired[]> {
    const theses = await readTheses(this.o.memory, subject, { currentOnly: true });
    const out: Desired[] = [];
    const live = new Set<string>();
    for (const t of theses) for (const c of t.thesis.conditions ?? []) live.add(keyOf("thesis_condition", upper(t.ticker), c.id));
    // A removed thesis, or a condition whose id is gone (an edit gives a new id), clears its nudge.
    for (const [key, row] of rows) if (row.kind === "thesis_condition" && row.clearedAt === null && !live.has(key)) out.push({ key, clear: true });

    const evaluated = theses.filter((t) => (t.thesis.conditions ?? []).some((c) => NIGHTLY_CONDITIONS.has(c.kind)));
    if (evaluated.length === 0) return out;
    const loaded = await portfolio();
    const { fx, fxDate } = await converterFor(this.o.market, loaded, today);
    for (const t of evaluated) {
      const ticker = upper(t.ticker);
      const input = quickThesisInput(t, loaded, fx);
      const check = checkThesis(input, now);
      const saved = new Map((t.thesis.conditions ?? []).map((c) => [c.id, c as Condition]));
      for (const c of check.conditions) {
        if (!NIGHTLY_CONDITIONS.has(c.kind)) continue;
        const key = keyOf("thesis_condition", ticker, c.id);
        if (c.status === "held") out.push({ key, clear: true });
        if (c.status !== "broken" || !c.evidence) continue; // can't tell: leave any open nudge alone
        const condition = saved.get(c.id);
        if (!condition) continue;
        // "(est.)" inside the evidence becomes ", est.," (with the BoC date when converted): no nested parentheses.
        const converted = c.kind === "weight_above" && input.weight?.estimated === true && fxDate !== null;
        const value = c.evidence.value.replace(/ \(est\.\)$/, converted ? `, est. at the Bank of Canada rate of ${fxDate},` : ", est.,");
        out.push({
          key, kind: "thesis_condition", target: ticker, conditionId: c.id, basis: conditionBasis(condition),
          text: thesisNudgeText(ticker, c.text, `${value} as of ${c.evidence.asOf}`),
        });
      }
    }
    return out;
  }

  private async limitPart(subject: string, rows: Map<string, NudgeRow>, portfolio: () => Promise<PortfolioPresentation>, now: Date): Promise<Desired[]> {
    const limits = await readLimits(this.o.memory, subject);
    const out: Desired[] = [];
    const slugs = new Set(limits.map((l) => l.slug));
    // A removed limit clears its nudges.
    for (const [key, row] of rows) if (row.kind === "limit" && row.clearedAt === null && !slugs.has(row.target)) out.push({ key, clear: true });
    if (limits.length === 0) return out;

    const loaded = await portfolio();
    const input = await loadLimitInput({ memory: this.o.memory, portfolio: async () => loaded, market: this.o.market }, subject, now, { portfolio: loaded });
    const checks = checkLimits(input, now);
    const labels = accountLabels(loaded);
    for (const { slug, limit, scope } of input.limits) {
      const mine = checks.filter((r) => r.slug === slug);
      const listed = new Set<string>();
      for (const r of mine) {
        if (r.informational) continue; // a listing row: its company's combined row carries the verdict
        // Keyed by the group (the listing for a holding), not its display label, which can change ("SHOP" -> "SHOP (CAD)").
        const group = (r.groupKey ?? r.label).slice(0, KEY_MAX); // the column's width
        const key = keyOf("limit", slug, group);
        listed.add(key);
        if (r.status === "within") out.push({ key, clear: true });
        if (r.status !== "over" || r.currentPct === null) continue;
        const accounts = scope.subset && limit.accounts ? limit.accounts.map((k) => labels.get(k) ?? "an account no longer connected").join(", ") : undefined;
        out.push({ key, kind: "limit", target: slug, conditionId: group, basis: limitBasis(limit), text: limitNudgeText(r, { subset: scope.subset, ...(accounts ? { accounts } : {}) }) });
      }
      // A group no longer listed is under the limit, unless the whole limit can't be told (no number at all).
      const wholeCantTell = mine.length === 1 && mine[0]!.status === "cant_tell" && mine[0]!.currentPct === null;
      if (wholeCantTell) continue;
      for (const [key, row] of rows) if (row.kind === "limit" && row.target === slug && row.clearedAt === null && !listed.has(key)) out.push({ key, clear: true });
    }
    return out;
  }

  /** True when this call raised (created or reopened) the nudge; an open one only has its text brought up to date. */
  private async raise(subject: string, d: Exclude<Desired, { clear: true }>, rows: Map<string, NudgeRow>, now: Date, retried = false): Promise<boolean> {
    const table = this.o.prisma.portfolioNudge;
    const row = rows.get(d.key);
    if (!row) {
      try {
        const data = { subject, kind: d.kind, target: d.target, conditionId: d.conditionId, basis: d.basis, text: d.text, raisedAt: now, updatedAt: now, clearedAt: null };
        const created = await table.create({ data }) as { id?: unknown } | null;
        rows.set(d.key, { id: typeof created?.id === "string" ? created.id : "", ...data });
        return true;
      } catch (error) {
        // A concurrent evaluation created it first: apply this one against that row.
        if (retried || !isUniqueViolation(error)) throw error;
        for (const r of await table.findMany({ where: { subject } })) rows.set(keyOf(r.kind, r.target, r.conditionId), r);
        return this.raise(subject, d, rows, now, true);
      }
    }
    if (row.clearedAt !== null) {
      await table.update({ where: { id: row.id }, data: { text: d.text, basis: d.basis, raisedAt: now, updatedAt: now, clearedAt: null } });
      rows.set(d.key, { ...row, text: d.text, basis: d.basis, raisedAt: now, updatedAt: now, clearedAt: null });
      return true;
    }
    // Still over or broken under a changed threshold: restated in place under the new basis, not raised again.
    if (row.text !== d.text || row.basis !== d.basis) {
      await table.update({ where: { id: row.id }, data: { text: d.text, basis: d.basis, updatedAt: now } });
      rows.set(d.key, { ...row, text: d.text, basis: d.basis, updatedAt: now });
    }
    return false;
  }

  /**
   * The subject's open nudges, oldest first, as stored. Read-only: one whose thesis, condition or limit has since been
   * removed, or whose threshold or accounts changed (basis no longer matches), is left out until the next evaluation
   * clears or restates it. Current fact versions only.
   */
  async openNudges(subject: string): Promise<OpenNudge[]> {
    const rows = await this.o.prisma.portfolioNudge.findMany({ where: { subject, clearedAt: null }, orderBy: [{ raisedAt: "asc" }, { id: "asc" }] });
    if (rows.length === 0) return [];
    const [theses, limits] = await Promise.all([
      rows.some((r) => r.kind === "thesis_condition") ? readTheses(this.o.memory, subject, { currentOnly: true }) : Promise.resolve([]),
      rows.some((r) => r.kind === "limit") ? readLimits(this.o.memory, subject) : Promise.resolve([]),
    ]);
    const conditions = new Map(theses.flatMap((t) => (t.thesis.conditions ?? []).map((c) => [`${upper(t.ticker)}\u0000${c.id}`, conditionBasis(c as Condition)] as const)));
    const slugs = new Map(limits.map((l) => [l.slug, limitBasis(l.limit)] as const));
    const current = (r: NudgeRow) => r.kind === "limit" ? slugs.get(r.target) : conditions.get(`${r.target}\u0000${r.conditionId ?? ""}`);
    return rows
      .filter((r) => { const basis = current(r); return basis !== undefined && basis === r.basis; })
      .map((r) => ({ kind: r.kind, target: r.target, text: r.text, raisedAt: r.raisedAt }));
  }

  /**
   * Clears every open nudge of one thesis (`thesis_condition`, target = ticker) or limit (`limit`, target = slug) whose
   * entry was deleted, with no evaluation and no portfolio read: the generic memory delete (final fix 5). Returns the
   * count cleared.
   */
  async clearFor(subject: string, kind: NudgeKind, target: string, now: Date = this.now()): Promise<number> {
    const table = this.o.prisma.portfolioNudge;
    const want = kind === "thesis_condition" ? upper(target) : target;
    let cleared = 0;
    for (const row of await table.findMany({ where: { subject, clearedAt: null } })) {
      if (row.kind !== kind || row.target !== want) continue;
      await table.update({ where: { id: row.id }, data: { clearedAt: now, updatedAt: now } });
      cleared += 1;
    }
    return cleared;
  }

  /** Every row for the account export, open and cleared, oldest first, without the subject or row id. */
  async listForExport(subject: string): Promise<Array<Omit<NudgeRow, "id" | "subject">>> {
    const rows = await this.o.prisma.portfolioNudge.findMany({ where: { subject }, orderBy: [{ raisedAt: "asc" }, { id: "asc" }] });
    return rows.map((r) => ({ kind: r.kind, target: r.target, conditionId: r.conditionId, basis: r.basis, text: r.text, raisedAt: r.raisedAt, updatedAt: r.updatedAt, clearedAt: r.clearedAt }));
  }
}
