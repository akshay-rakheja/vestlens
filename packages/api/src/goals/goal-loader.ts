import { externalFlows, scopedTransferKeys } from "../analytics/flows.js";
import { isInvestable } from "../analytics/holdings.js";
import { isManagedPortfolio } from "../portfolio/account-taxonomy.js";
import { loadHomeConverter } from "../fx/home-currency.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import { listAccounts } from "../mcp/activity-tools.js";
import { accountKey } from "../memory/keys.js";
import { readGoals, readOutsideValues, type PortfolioFactsSource } from "../memory/portfolio-facts.js";
import { activitySynced, positionsAsOfDay, torontoDay } from "../portfolio/data-freshness.js";
import type { PortfolioPresentation, PortfolioPresentationAccount } from "../portfolio/portfolio-presentation.js";
import type { DailySnapshotService } from "../snapshots/daily-snapshot-service.js";
import { toStoredActivity, type ActivityRow } from "../theses/thesis-loader.js";
import { addMonths, PACE_WINDOW_MONTHS, type GoalAccountInput, type GoalContributions, type GoalInput } from "./goal-check.js";

/**
 * Reads savings goal inputs for one auth subject (spec 2026-10-24 §7, §11a.8), from stored data only: the latest stored
 * portfolio (or one the caller already loaded), stored activity and sync state, stored daily values, declared outside
 * values, and the Bank of Canada rate. No brokerage read. Every query is keyed by the auth subject.
 *
 * - Linked accounts match a connected account by its memory key; outside accounts by `outside:<slug>`.
 * - A connected account's value is its brokerage-reported total, converted at its positions date (USD at BoC, est.).
 * - Net contributions are the external flows (deposits, withdrawals, transfers in and out, valued in-kind transfers)
 *   of the counted linked accounts, over the PACE_WINDOW_MONTHS months to today; transfers between two linked
 *   accounts (closed ones included) net out, while a leg that could have gone through another listed account (Cash)
 *   stays a real flow (scopedTransferKeys, as income and activity). An in-kind transfer without a reported price has no value and is
 *   listed rather than guessed. Coverage reports each account's finished backfill and the earliest first recorded
 *   activity (goal-check prorates when it falls inside the window); sync needs an error-free sync within 48 hours.
 * - A failed daily-values read is flagged (`dailyUnavailable`), not shown as "not enough data".
 * - Daily values cover SERIES_MONTHS months; a date counts only when every counted linked account has a value that
 *   converts.
 */

const SERIES_MONTHS = 12;

type SyncRow = { snapTradeAccountId: string; backfillCompletedAt: Date | null; earliestTradeDate: Date | null; lastSyncedAt: Date | null; lastError: string | null };

export interface GoalPrismaPort {
  activity: {
    findMany(input: {
      where: { appUser: { authSubject: string }; snapTradeAccountId: { in: string[] } };
      orderBy: Array<{ tradeDate: "asc" } | { dedupeKey: "asc" }>;
      select: {
        snapTradeAccountId: true; dedupeKey: true; type: true; symbol: true; securityCurrency: true; isOption: true; units: true; price: true;
        amount: true; fee: true; fxRate: true; currency: true; tradeDate: true; settlementDate: true;
      };
    }): Promise<ActivityRow[]>;
  };
  activitySyncState: {
    findMany(input: {
      where: { appUser: { authSubject: string } };
      select: { snapTradeAccountId: true; backfillCompletedAt: true; earliestTradeDate: true; lastSyncedAt: true; lastError: true };
    }): Promise<SyncRow[]>;
  };
}

export interface GoalLoaderDeps {
  memory: PortfolioFactsSource;
  /** The latest stored portfolio (snapshot positions); never a brokerage refresh. */
  portfolio: (authSubject: string) => Promise<PortfolioPresentation>;
  prisma: GoalPrismaPort;
  dailyValues: Pick<DailySnapshotService, "rows">;
  market: Pick<MarketDataService, "usdCad">;
}

const calendarDay = (d: Date | null): string | null => (d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null);
const cents = (n: number) => Math.round(n * 100) / 100;

/** Every current goal (or the one with `slug`), with its inputs. Empty when there is none. */
export async function loadGoalInputs(
  deps: GoalLoaderDeps, subject: string, now: Date, options: { slug?: string; portfolio?: PortfolioPresentation } = {},
): Promise<GoalInput[]> {
  const goals = (await readGoals(deps.memory, subject)).filter((g) => options.slug === undefined || g.slug === options.slug);
  if (goals.length === 0) return [];
  const today = torontoDay(now);
  const windowStart = addMonths(today, -PACE_WINDOW_MONTHS);
  const seriesFrom = addMonths(today, -SERIES_MONTHS);
  const where = { appUser: { authSubject: subject } };

  const portfolio = options.portfolio ?? (await deps.portfolio(subject));
  const byKey = new Map((portfolio.accounts ?? []).map((a) => [accountKey(a.id), a]));
  // Every connected linked account, closed ones included: a transfer between a closed and an open linked account
  // nets out rather than counting as a contribution (M-4).
  const linkedIds = [...new Set(goals.flatMap((g) => g.goal.accounts.map((k) => byKey.get(k)).filter((a): a is PortfolioPresentationAccount => !!a).map((a) => a.id)))];
  // The other listed accounts (Cash included, credit products not) are read only to pair transfer legs: TFSA1 -> Cash
  // -> TFSA2 is money taken out and put back, not a transfer between the linked TFSAs.
  const readIds = [...new Set([...linkedIds, ...listAccounts(portfolio).filter((a) => a.kind !== "credit").map((a) => a.id)])];

  const [outside, activityRows, syncRows, daily, fx] = await Promise.all([
    readOutsideValues(deps.memory, subject, now),
    linkedIds.length > 0
      ? deps.prisma.activity.findMany({
        where: { ...where, snapTradeAccountId: { in: readIds } },
        orderBy: [{ tradeDate: "asc" }, { dedupeKey: "asc" }],
        select: {
          snapTradeAccountId: true, dedupeKey: true, type: true, symbol: true, securityCurrency: true, isOption: true, units: true, price: true,
          amount: true, fee: true, fxRate: true, currency: true, tradeDate: true, settlementDate: true,
        },
      })
      : Promise.resolve([]),
    linkedIds.length > 0
      ? deps.prisma.activitySyncState.findMany({ where, select: { snapTradeAccountId: true, backfillCompletedAt: true, earliestTradeDate: true, lastSyncedAt: true, lastError: true } })
      : Promise.resolve([]),
    linkedIds.length > 0 ? deps.dailyValues.rows(subject, seriesFrom).catch(() => null) : Promise.resolve([]),
    loadHomeConverter(deps.market, seriesFrom, today),
  ]);
  const readRows = activityRows.map(toStoredActivity).filter((a) => readIds.includes(a.snapTradeAccountId));
  const sync = new Map(syncRows.map((s) => [s.snapTradeAccountId, s]));

  return goals.map(({ slug, goal }) => {
    const accounts: GoalAccountInput[] = goal.accounts.map((key): GoalAccountInput => {
      if (key.startsWith("outside:")) {
        const v = outside.get(key);
        return v ? { key, kind: "outside", amountCad: v.amountCad, asOf: v.asOf, stale: v.stale } : { key, kind: "outside_missing" };
      }
      const a = byKey.get(key);
      if (!a) return { key, kind: "disconnected" };
      const positionsAsOf = positionsAsOfDay(a);
      const base = { key, kind: "connected" as const, label: a.classification.label, counted: isInvestable(a), positionsAsOf };
      // SnapTrade doesn't value Wealthsimple managed portfolios: no value or zero is unknown, not $0 (managedNotInTotal).
      if (isManagedPortfolio(a.classification) && (!a.value || a.value.amount === 0)) return { ...base, valueCad: null, estimated: false, problem: "managed" };
      if (!a.value || !Number.isFinite(a.value.amount)) return { ...base, valueCad: null, estimated: false, problem: "no_value" };
      const at = fx.at(a.value.amount, a.value.currency, positionsAsOf ?? today);
      return at.amount === null
        ? { ...base, valueCad: null, estimated: false, problem: "not_converted" }
        : { ...base, valueCad: at.amount, estimated: at.estimated, rateDate: at.rateDate, problem: null };
    });

    const linked = [...new Set(goal.accounts.map((k) => byKey.get(k)).filter((a): a is PortfolioPresentationAccount => !!a))];
    const ids = linked.filter(isInvestable).map((a) => a.id);
    return {
      slug, goal, accounts, contributions: contributionsOf(ids, linked.map((a) => a.id)), daily: dailyOf(ids),
      ...(daily === null ? { dailyUnavailable: true } : {}),
    };
  });

  /** `ids`: the counted linked accounts; `allLinked`: every connected linked account, for transfer matching (the other read accounts are match-only). */
  function contributionsOf(ids: string[], allLinked: string[]): GoalContributions {
    const backfilled = ids.every((id) => !!sync.get(id)?.backfillCompletedAt);
    // Earliest first recorded activity; a finished backfill is taken to mean no earlier history (goal-check.ts).
    const firsts = ids.map((id) => { const s = sync.get(id); return s && s.backfillCompletedAt ? calendarDay(s.earliestTradeDate) : null; });
    const firstActivity = firsts.length > 0 && firsts.every((d) => d !== null) ? (firsts as string[]).sort()[0]! : null;
    const isSynced = ids.every((id) => activitySynced(sync.get(id), now));
    const linkedRows = readRows.filter((a) => allLinked.includes(a.snapTradeAccountId));
    const paired = scopedTransferKeys(linkedRows, readRows.filter((a) => !allLinked.includes(a.snapTradeAccountId)));
    let estimated = false;
    const rateDates = new Set<string>();
    const flows = externalFlows({
      activities: linkedRows.filter((a) => ids.includes(a.snapTradeAccountId) && !paired.has(a.dedupeKey)),
      // `paired` is the whole netting: "account" scope keeps externalFlows from pairing the remaining legs again over
      // the linked rows alone (which would net a routed TFSA1 -> Cash -> TFSA2). Without inScope, nothing else differs.
      scope: "account", scopeCurrency: "CAD",
      toScope: (amount, currency, date) => { const at = fx.at(amount, currency, date); estimated ||= at.estimated; if (at.estimated && at.rateDate) rateDates.add(at.rateDate); return at.amount; },
      priceInKind: () => null,
    });
    const inWindow = (d: string) => d > windowStart && d <= today;
    const netCad = [...flows.byDate].filter(([d]) => inWindow(d)).reduce((s, [, v]) => s + v, 0);
    return {
      connectedAccounts: ids.length, backfilled, firstActivity, synced: isSynced,
      unvaluedDates: [...flows.unknownDates].filter(inWindow).sort(), netCad: cents(netCad), estimated, rateDates: [...rateDates].sort(),
    };
  }

  function dailyOf(ids: string[]): Array<{ date: string; valueCad: number }> {
    if (ids.length === 0) return [];
    const byDate = new Map<string, Map<string, number | null>>();
    for (const r of daily ?? []) {
      if (!ids.includes(r.accountId) || r.date > today) continue;
      const at = fx.at(r.value, r.currency, r.date);
      const day = byDate.get(r.date) ?? new Map<string, number | null>();
      const prior = day.has(r.accountId) ? day.get(r.accountId)! : 0;
      day.set(r.accountId, prior === null || at.amount === null ? null : prior + at.amount);
      byDate.set(r.date, day);
    }
    const out: Array<{ date: string; valueCad: number }> = [];
    for (const [date, values] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) {
      if (ids.some((id) => !values.has(id) || values.get(id) === null)) continue;
      out.push({ date, valueCad: cents([...values.values()].reduce((s: number, v) => s + v!, 0)) });
    }
    return out;
  }
}
