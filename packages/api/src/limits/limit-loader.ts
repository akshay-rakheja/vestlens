import type { ExposureCash, ExposureItem } from "../analytics/exposure.js";
import { aggregateHoldings, isInvestable } from "../analytics/holdings.js";
import { homeConverter, loadHomeConverter, type HomeConverter } from "../fx/home-currency.js";
import type { MarketDataService } from "../market-data/market-data-service.js";
import { providerTicker } from "../market-data/ticker-map.js";
import type { SecurityProfile } from "../market-data/types.js";
import { accountKey } from "../memory/keys.js";
import { readLimits, type PortfolioFactsSource } from "../memory/portfolio-facts.js";
import { positionsAsOfDay, torontoDay } from "../portfolio/data-freshness.js";
import { managedNotInTotal, type PortfolioPresentation, type PortfolioPresentationAccount } from "../portfolio/portfolio-presentation.js";
import type { LimitInput, LimitScope } from "./limit-check.js";

/**
 * Reads the inputs of every current concentration limit for one auth subject (spec 2026-10-24 §6, §11a.6-7, §11a.10).
 * Cheap and local: the latest stored portfolio (or one the caller already loaded), the Bank of Canada rate, and
 * cached security profiles only (never a profile refresh). No brokerage read.
 *
 * - Scope: the whole portfolio's included, open, non-credit accounts, or the limit's subset of them (by account key).
 *   A subset key that matches no connected account is counted as missing (`cant_tell`).
 * - Values are brokerage-reported position values and cash balances, converted to CAD at each account's positions
 *   date (USD at the BoC rate, est.). Options and cash equivalents are skipped as the holdings view does. A negative cash
 *   balance is a margin debit and stays in the scope, so the total is net equity.
 * - Sector profiles are read only when a sector limit exists; an uncached holding stays unclassified.
 */

export interface LimitLoaderDeps {
  memory: PortfolioFactsSource;
  /** The latest stored portfolio (snapshot positions); never a brokerage refresh. */
  portfolio: (authSubject: string) => Promise<PortfolioPresentation>;
  market: Pick<MarketDataService, "usdCad"> & Partial<Pick<MarketDataService, "cachedProfileLookup" | "cachedProfile">>;
}

const PROFILED_KINDS = new Set(["stock", "etf", "fund", "mutualfund"]);
const itemKind = (kind: string) => (kind === "mutualfund" ? "fund" : kind);
const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const upper = (s: string) => s.trim().toUpperCase();

async function cachedProfile(market: LimitLoaderDeps["market"], ticker: string): Promise<SecurityProfile | null> {
  try {
    if (market.cachedProfileLookup) return (await market.cachedProfileLookup(ticker)).profile;
    if (market.cachedProfile) return await market.cachedProfile(ticker);
  } catch {
    return null;
  }
  return null;
}

function buildScope(accounts: PortfolioPresentationAccount[], fx: HomeConverter, profiles: Map<string, SecurityProfile | null>, today: string): Omit<LimitScope, "missingAccounts" | "excludedAccounts" | "subset"> {
  const days = new Map(accounts.map((a) => [a.id, positionsAsOfDay(a)]));
  const known = [...days.values()];
  const positionsAsOf = accounts.length === 0 ? today : known.some((d) => d === null) ? null : (known as string[]).sort()[0]!;
  const items: ExposureItem[] = [];
  const cash: ExposureCash[] = [];
  const unvalued: string[] = [];
  const notConverted: string[] = [];
  let fxDate: string | null = null;
  const seen = (at: { estimated: boolean; rateDate: string | null }) => { if (at.estimated && at.rateDate && (fxDate === null || at.rateDate > fxDate)) fxDate = at.rateDate; };
  const { rows } = aggregateHoldings(accounts, {});
  const nameOf = (accountId: string, symbol: string) =>
    accounts.find((x) => x.id === accountId)?.positions?.find((p) => upper(p.symbol) === upper(symbol))?.description ?? null;
  for (const r of rows) {
    const ticker = providerTicker({ symbol: r.symbol, kind: r.kind, currency: r.currency });
    const profile = ticker ? profiles.get(ticker) ?? null : null;
    for (const a of r.accounts) {
      if (a.marketValue === null) { unvalued.push(r.symbol); continue; } // the limit is then can't tell (I-1)
      if (!(a.marketValue > 0)) continue;
      const at = fx.at(a.marketValue, r.currency, days.get(a.accountId) ?? today);
      if (at.amount === null) { notConverted.push(r.currency); continue; }
      seen(at);
      items.push({ holdingKey: r.key, symbol: r.symbol, kind: itemKind(r.kind), valueCad: at.amount, currency: r.currency, accountLabel: a.accountId, profile, classification: accounts.find((x) => x.id === a.accountId)!.classification, name: nameOf(a.accountId, r.symbol) });
    }
  }
  for (const a of accounts) {
    for (const b of a.balances ?? []) {
      // A negative balance is a margin debit: it stays in, so the total is net equity (exposure.ts).
      if (!b.currency || !finite(b.cash) || b.cash === 0) continue;
      const at = fx.at(b.cash, b.currency, days.get(a.id) ?? today);
      if (at.amount === null) { notConverted.push(upper(b.currency)); continue; }
      seen(at);
      cash.push({ currency: upper(b.currency), accountLabel: a.id, valueCad: at.amount, classification: a.classification });
    }
  }
  const notInTotal = managedNotInTotal({ accounts });
  return { items, cash, positionsAsOf, unvalued, notConverted, fxDate, ...(notInTotal.length > 0 ? { notInTotal } : {}) };
}

const holdsForeign = (accounts: PortfolioPresentationAccount[]) => accounts.some((a) =>
  (a.positions ?? []).some((p) => p.currency && upper(p.currency) !== "CAD") || (a.balances ?? []).some((b) => b.currency && upper(b.currency) !== "CAD" && finite(b.cash) && b.cash !== 0));

export async function loadLimitInput(
  deps: LimitLoaderDeps, subject: string, now: Date, options: { portfolio?: PortfolioPresentation } = {},
): Promise<LimitInput> {
  const limits = await readLimits(deps.memory, subject);
  if (limits.length === 0) return { limits: [] };
  const today = torontoDay(now);
  const portfolio = options.portfolio ?? (await deps.portfolio(subject));
  const all = portfolio.accounts ?? [];
  const investable = all.filter(isInvestable);

  const oldest = investable.map(positionsAsOfDay).filter((d): d is string => d !== null).sort()[0] ?? today;
  const fx = holdsForeign(investable) ? await loadHomeConverter(deps.market, oldest, today) : homeConverter(null, today);

  const profiles = new Map<string, SecurityProfile | null>();
  if (limits.some((l) => l.limit.kind === "sector")) {
    const { rows } = aggregateHoldings(investable, {});
    const tickers = [...new Set(rows.filter((r) => PROFILED_KINDS.has(r.kind)).map((r) => providerTicker({ symbol: r.symbol, kind: r.kind, currency: r.currency })).filter((t): t is string => t !== null))];
    await Promise.all(tickers.map(async (t) => profiles.set(t, await cachedProfile(deps.market, t))));
  }

  const byKey = new Map(all.map((a) => [accountKey(a.id), a]));
  const cache = new Map<string, Omit<LimitScope, "missingAccounts" | "excludedAccounts" | "subset">>();
  const scopeOf = (accounts: PortfolioPresentationAccount[]) => {
    const id = accounts.map((a) => a.id).sort().join("|");
    let s = cache.get(id);
    if (!s) cache.set(id, (s = buildScope(accounts, fx, profiles, today)));
    return s;
  };

  return {
    limits: limits.map(({ slug, limit }) => {
      if (!limit.accounts) return { slug, limit, scope: { ...scopeOf(investable), missingAccounts: 0, excludedAccounts: 0, subset: false } };
      const keys = [...new Set(limit.accounts)];
      const found = keys.map((k) => byKey.get(k)).filter((a): a is PortfolioPresentationAccount => a !== undefined);
      const counted = found.filter(isInvestable);
      return { slug, limit, scope: { ...scopeOf(counted), missingAccounts: keys.length - found.length, excludedAccounts: found.length - counted.length, subset: true } };
    }),
  };
}
