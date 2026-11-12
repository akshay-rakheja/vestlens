import { describe, expect, it } from "vitest";
import type { StoredActivity } from "../history/stored-activity.js";
import { accountKey } from "../memory/keys.js";
import { benchmarkFetchFrom } from "../analytics/value-series.js";
import { MemoryService } from "../memory/memory-service.js";
import type { MemoryFactInput } from "../memory/memory-types.js";
import type { ArticleRating, CalendarEvent, StoredArticle } from "../news/store.js";
import { MemoryFactRepository } from "../testing/memory-fact-repository.js";
import { ACTIVITY_NOT_LOADED, ACTIVITY_NOT_RECORDED, ACTIVITY_STALE_DAYS, activityAsOfNote, activityStaleNote, checkHolding, checkThesis, NO_FULL_HISTORY, SHARES_MOVED_UNVALUED, UNITS_NOT_REPORTED } from "./thesis-check.js";
import { torontoDay } from "../portfolio/data-freshness.js";
import { captureThesisBaseline, loadHoldingView, loadThesisInput, withoutReinvestedDividends, type ThesisLoaderDeps } from "./thesis-loader.js";

// Synthetic subjects, accounts, symbols and amounts only.
const ME = "subject|synthetic-thesis-me";
const OTHER = "subject|synthetic-thesis-other";
const NOW = new Date("2026-10-23T16:00:00Z");
const WRITTEN = new Date("2026-06-01T15:00:00Z");

const cls = (bucket: string, group: string, included: boolean, label: string): any => ({ label, bucket, group, includedInPortfolioTotal: included, isClosed: group === "closed" });
const pos = (over: Record<string, unknown>): any => ({ instrumentId: "i", kind: "stock", symbol: "SYN.TO", description: null, units: 10, price: 120, costBasis: null, marketValue: 1_200, unrealizedGain: null, currency: "CAD", cashEquivalent: false, ...over });
const acct = (id: string, positions: any[], over: Record<string, unknown> = {}): any => ({
  id, name: id, classification: cls("tfsa", "registered", true, id), value: null, balances: [], positions,
  freshness: { positionsAsOf: "2026-10-22T21:00:00.000Z", holdingsLastSyncedAt: null, initialSyncCompleted: true, holdingsUnavailable: false }, ...over,
});

type ActivityRec = Omit<StoredActivity, "description"> & { subject: string };
const act = (over: Partial<ActivityRec>): ActivityRec => ({
  subject: ME, snapTradeAccountId: "A", dedupeKey: `k-${Math.random()}`, type: "BUY", symbol: "SYN.TO", securityCurrency: "CAD", isOption: false,
  units: null, price: null, amount: null, fee: null, fxRate: null, currency: "CAD", tradeDate: "2026-05-15", settlementDate: null, ...over,
});
type SnapRec = { subject: string; snapTradeAccountId: string; positionsAsOf: Date | null; capturedAt: Date; payload: unknown };
const snap = (account: string, capturedAt: string, positions: any[], positionsAsOf: string | null = capturedAt): SnapRec => ({
  subject: ME, snapTradeAccountId: account, capturedAt: new Date(capturedAt), positionsAsOf: positionsAsOf ? new Date(positionsAsOf) : null, payload: { positions },
});
type SyncRec = {
  subject: string; snapTradeAccountId: string; backfillCompletedAt: Date | null; earliestTradeDate: Date | null; lastSyncedAt: Date | null; lastError: string | null;
};

interface World {
  thesisTicker?: string;
  accounts: any[];
  activities: ActivityRec[];
  snapshots: SnapRec[];
  sync: SyncRec[];
  /** BrokerageAccount.createdAt by account id; default 2025-01-01. */
  createdAt?: Record<string, string>;
  articles?: StoredArticle[];
  ratings?: ArticleRating[];
  events?: CalendarEvent[];
  sp500?: Array<{ date: string; close: number }>;
  tsx?: Array<{ date: string; close: number }>;
}

const dates = (from: string, to: string) => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

async function setup(w: World, conditions: unknown[] = [{ kind: "weight_above", text: "over 10%", pct: 10 }]) {
  const repository = new MemoryFactRepository();
  const memory = new MemoryService({ repository, now: () => WRITTEN, log: () => undefined });
  const fact = (subject: string): MemoryFactInput => ({
    node: { type: "security", key: w.thesisTicker ?? "SYN.TO" }, property: "security.thesis",
    value: { reasons: "Synthetic reasons.", timeFrame: { kind: "long", years: 3 }, conditions }, text: "Thesis.", kind: "reason", provenance: "stated",
  });
  await memory.remember(ME, fact(ME), WRITTEN);
  await memory.remember(OTHER, fact(OTHER), new Date("2026-01-05T15:00:00Z"));
  const calls = { activityWhere: [] as unknown[], syncWhere: [] as unknown[], snapWhere: [] as unknown[], accountWhere: [] as unknown[], newsSymbols: [] as string[][], history: [] as string[][], usdCad: [] as string[][] };
  const deps: ThesisLoaderDeps = {
    memory,
    portfolio: async (subject) => {
      expect(subject).toBe(ME);
      return { connectionRequired: false, generatedAt: NOW.toISOString(), totals: [], accounts: w.accounts, errors: [] } as any;
    },
    prisma: {
      activity: {
        findMany: (async (input: any) => {
          calls.activityWhere.push(input.where);
          const want = input.where.symbol.equals.toUpperCase();
          return w.activities.filter((a) => a.subject === input.where.appUser.authSubject && a.symbol?.toUpperCase() === want).map((a) => ({
            ...a, tradeDate: a.tradeDate ? new Date(`${a.tradeDate}T00:00:00Z`) : null, settlementDate: a.settlementDate ? new Date(`${a.settlementDate}T00:00:00Z`) : null,
          }));
        }) as never,
      },
      activitySyncState: { findMany: async (input) => { calls.syncWhere.push(input.where); return w.sync.filter((s) => s.subject === input.where.appUser.authSubject); } },
      brokerageAccount: {
        findMany: async (input) => {
          calls.accountWhere.push(input.where);
          return w.accounts.map((a) => ({ snapTradeAccountId: a.id, createdAt: new Date(w.createdAt?.[a.id] ?? "2025-01-01T00:00:00Z") }));
        },
      },
      portfolioSnapshot: {
        findMany: async (input) => (calls.snapWhere.push(input.where), w.snapshots).filter((s) => s.subject === input.where.appUser.authSubject
          && s.capturedAt >= input.where.capturedAt.gte && s.capturedAt <= input.where.capturedAt.lte).sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime()),
      },
    },
    news: {
      articlesForSymbols: async (symbols, since) => { calls.newsSymbols.push(symbols); return (w.articles ?? []).filter((a) => a.publishedAt >= since); },
      ratingsFor: async (ids) => (w.ratings ?? []).filter((r) => ids.includes(r.articleId)),
      events: async () => w.events ?? [],
    },
    market: {
      history: async (ticker, from) => { calls.history.push([ticker, from]); return ticker === "^SP500TR" ? w.sp500 ?? null : ticker === "^GSPTSE" ? w.tsx ?? null : null; },
      usdCad: async (from, to) => { calls.usdCad.push([from, to]); return dates(from, to).map((date) => ({ date, close: 1.35 })); },
    },
  };
  return { deps, calls, memory };
}

const backfilled = (account: string, earliest = "2024-01-02", over: Partial<SyncRec> = {}): SyncRec => ({
  subject: ME, snapTradeAccountId: account, backfillCompletedAt: new Date("2026-01-01T00:00:00Z"), earliestTradeDate: new Date(`${earliest}T00:00:00Z`),
  lastSyncedAt: new Date(NOW.getTime() - 3_600_000), lastError: null, ...over,
});
const article = (id: string, publishedAt: string, symbols = ["SYN.TO"]): StoredArticle => ({
  id, urlHash: id, url: `https://example.test/${id}`, headline: `Synthetic ${id}`, snippet: null, source: "Synthetic Wire", imageUrl: null,
  publishedAt: new Date(publishedAt), symbols, fetchedAt: NOW,
});
const rating = (articleId: string, over: Partial<ArticleRating> = {}): ArticleRating => ({
  articleId, symbol: "SYN.TO", model: "m", ratedAt: NOW, relevant: 0.9, sentiment: 3.5, sentimentConfidence: 0.9, materiality: 2,
  eventType: null, eventConfidence: 0, credible: 0.9, clickbait: 0, duplicateOf: null, ...over,
});

/** A: holds SYN.TO 10 @ 120 = 1200 now, 10 @ 100 = 1000 the evening the thesis was written. B: holds VFV only. */
const base = (): World => ({
  accounts: [
    // 10 at the start plus the 0.045 reinvested on 2026-08-03 (I-2: units reconcile).
    acct("A", [pos({ units: 10.045 })], { balances: [{ currency: "CAD", cash: 300, buyingPower: null }] }),
    acct("B", [pos({ symbol: "VFV", kind: "etf", marketValue: 1_500, price: 150 })]),
  ],
  activities: [
    act({ type: "BUY", units: 10, price: 90, amount: -900, tradeDate: "2026-05-15" }),
    // A reinvested dividend reported as a DIVIDEND and a same-day BUY of the same amount: counted once (in the value).
    act({ type: "DIVIDEND", amount: 5, tradeDate: "2026-08-03" }),
    act({ type: "BUY", units: 0.045, price: 111.2, amount: -5.004, tradeDate: "2026-08-03" }),
    act({ subject: OTHER, type: "SELL", units: -10, amount: 99_999, tradeDate: "2026-07-01" }),
  ],
  snapshots: [
    snap("A", "2026-06-01T22:30:00Z", [pos({ price: 100, marketValue: 1_000 })], "2026-06-01T21:00:00Z"),
    snap("B", "2026-06-01T22:30:00Z", [pos({ symbol: "VFV", kind: "etf", marketValue: 1_400 })], "2026-06-01T21:00:00Z"),
  ],
  sync: [backfilled("A"), { subject: ME, snapTradeAccountId: "B", backfillCompletedAt: null, earliestTradeDate: null, lastSyncedAt: null, lastError: null }],
  sp500: [{ date: "2026-06-01", close: 100 }, { date: "2026-10-22", close: 110 }],
  tsx: [{ date: "2026-06-01", close: 100 }, { date: "2026-10-22", close: 105 }],
});

describe("withoutReinvestedDividends", () => {
  const rows = (...a: Array<Partial<StoredActivity>>) => a.map((x) => ({ ...act({}), description: null, ...x }) as StoredActivity);
  it("drops a DIVIDEND and a same-day BUY of the same symbol and amount (within 1 cent), once", () => {
    const out = withoutReinvestedDividends(rows(
      { dedupeKey: "d", type: "DIVIDEND", amount: 5, tradeDate: "2026-08-03" },
      { dedupeKey: "b", type: "BUY", amount: -5.009, units: 0.04, tradeDate: "2026-08-03" },
      { dedupeKey: "b2", type: "BUY", amount: -5, units: 0.04, tradeDate: "2026-08-03" },
    ));
    expect(out.map((a) => a.dedupeKey)).toEqual(["b2"]);
  });
  it("keeps them when the amounts differ by more than a cent, the day differs, or the account or symbol differs", () => {
    const keys = (...a: Array<Partial<StoredActivity>>) => withoutReinvestedDividends(rows(...a)).map((x) => x.dedupeKey);
    expect(keys({ dedupeKey: "d", type: "DIVIDEND", amount: 5 }, { dedupeKey: "b", type: "BUY", amount: -5.02 })).toEqual(["d", "b"]);
    expect(keys({ dedupeKey: "d", type: "DIVIDEND", amount: 5 }, { dedupeKey: "b", type: "BUY", amount: -5, tradeDate: "2026-05-16" })).toEqual(["d", "b"]);
    expect(keys({ dedupeKey: "d", type: "DIVIDEND", amount: 5 }, { dedupeKey: "b", type: "BUY", amount: -5, snapTradeAccountId: "Z" })).toEqual(["d", "b"]);
    expect(keys({ dedupeKey: "d", type: "DIVIDEND", amount: 5 }, { dedupeKey: "b", type: "BUY", amount: -5, symbol: "OTHER" })).toEqual(["d", "b"]);
  });
  it("drops a DIVIDEND reinvested through a same-day REINVEST row (which is not a flow itself)", () => {
    const out = withoutReinvestedDividends(rows(
      { dedupeKey: "d", type: "DIVIDEND", amount: 5 },
      { dedupeKey: "r", type: "REINVEST", amount: -5, units: 0.04 },
    ));
    expect(out.map((a) => a.dedupeKey)).toEqual(["r"]);
  });
});

describe("loadThesisInput", () => {
  it("returns null when the user has no current thesis on the ticker", async () => {
    const { deps } = await setup(base());
    expect(await loadThesisInput(deps, ME, "NOPE", NOW)).toBeNull();
  });

  it("reads the thesis, price, weight, start and end values, flows, coverage and benchmarks for this subject only", async () => {
    const { deps, calls } = await setup(base());
    const input = (await loadThesisInput(deps, ME, "syn.to", NOW))!;
    expect(input.ticker).toBe("SYN.TO");
    expect(input.writtenAt.toISOString()).toBe(WRITTEN.toISOString());
    expect(input.multipleListings).toBe(false);
    expect(input.price).toEqual({ value: 120, currency: "CAD", asOf: "2026-10-22" });
    // 1200 of 1200 + 300 cash + 1500 VFV = 40%.
    expect(input.weight).toEqual({ pct: 40, estimated: false, asOf: "2026-10-22" });
    expect(input.syncError).toBe(false);
    expect(input.start).toEqual({ date: "2026-06-01", valueCad: 1_000, estimated: false });
    expect(input.end).toEqual({ date: "2026-10-22", valueCad: 1_200, estimated: false });
    // The reinvested dividend is paired away; the pre-thesis buy is before writtenAt; the other subject's sale never loads.
    expect(input.flows).toEqual([]);
    expect(input.coverageStart).toBe("2024-01-02");
    expect(input.benchmarks.sp500!.at(-1)).toMatchObject({ date: "2026-10-22", closeCad: 148.5, estimated: true });
    expect(input.benchmarks.tsx!.at(-1)).toMatchObject({ date: "2026-10-22", closeCad: 105 });
    for (const where of [...calls.activityWhere, ...calls.syncWhere, ...calls.snapWhere, ...calls.accountWhere]) expect((where as any).appUser.authSubject).toBe(ME);
    expect(calls.syncWhere.length * calls.snapWhere.length * calls.accountWhere.length).toBeGreaterThan(0);

    const check = checkThesis(input, NOW);
    expect(check.playedOut.returnPct).toBeCloseTo(20, 6);
    expect(check.playedOut.vsSp500Pct).toBeCloseTo(10, 6);
    expect(check.playedOut.vsTsxPct).toBeCloseTo(15, 6);
    expect(check.conditions[0]).toMatchObject({ kind: "weight_above", status: "broken" });
  });

  it("news since writtenAt for this ticker only, with tone; earnings dates confirmed since then", async () => {
    const w = base();
    w.articles = [article("n1", "2026-07-01T12:00:00Z"), article("n2", "2026-05-01T12:00:00Z"), article("n3", "2026-08-01T12:00:00Z"), article("n4", "2026-08-02T12:00:00Z")];
    w.ratings = [rating("n1"), rating("n3", { relevant: 0.2 }), rating("n4", { duplicateOf: "n1" })];
    w.events = [
      { id: "e1", symbol: "SYN.TO", kind: "earnings", date: new Date("2026-08-06T00:00:00Z"), status: "confirmed", source: "s", amountPerUnit: null, currency: null },
      { id: "e2", symbol: "SYN.TO", kind: "earnings", date: new Date("2026-07-01T00:00:00Z"), status: "expected", source: "s", amountPerUnit: null, currency: null },
      { id: "e3", symbol: "SYN.TO", kind: "dividend_pay", date: new Date("2026-07-15T00:00:00Z"), status: "confirmed", source: "s", amountPerUnit: 1, currency: "CAD" },
    ];
    const { deps, calls } = await setup(w);
    const input = (await loadThesisInput(deps, ME, "SYN.TO", NOW))!;
    expect(calls.newsSymbols).toEqual([["SYN.TO"]]);
    expect(input.news.map((n) => [n.title, n.mood])).toEqual([["Synthetic n1", "strongly_positive"], ["Synthetic n3", null]]);
    expect(input.earnings).toEqual(["2026-08-06"]);
    expect(checkThesis(input, NOW).news.map((n) => n.title)).toEqual(["Synthetic n3", "Synthetic n1"]);
    expect(checkThesis(input, NOW).news.map((n) => n.url)).toEqual(["https://example.test/n3", "https://example.test/n1"]);
  });

  it("a holding sold in full: the end is the sale date at 0, the proceeds are a flow, and the weight is 0 (Review Focus 1)", async () => {
    const w = base();
    w.accounts[0].positions = [];
    w.activities.push(act({ type: "SELL", units: -10.045, price: 120, amount: 1_200, tradeDate: "2026-09-01" }));
    const { deps } = await setup(w);
    const input = (await loadThesisInput(deps, ME, "SYN.TO", NOW))!;
    expect(input.price).toBeNull();
    expect(input.weight).toEqual({ pct: 0, estimated: false, asOf: "2026-10-22" });
    expect(input.end).toEqual({ date: "2026-09-01", valueCad: 0, estimated: false });
    expect(input.flows.map((f) => [f.date, f.kind, f.amountCad])).toEqual([["2026-09-01", "sell", 1_200]]);
    const check = checkThesis(input, NOW);
    expect(check.conditions[0]).toMatchObject({ status: "held", evidence: { value: "0.0% of your portfolio, cash included" } });
    expect(check.playedOut.returnPct).toBeCloseTo(20, 6);
  });

  it("a margin debit: the weight is of net equity and flagged; a managed account left out is named (A13, A9)", async () => {
    const w = base();
    w.accounts[0].balances = [{ currency: "CAD", cash: -1_000, buyingPower: null }];
    w.accounts.push(acct("R", [], { unifiedType: "MANAGED_RRSP", classification: { ...w.accounts[0].classification, label: "Managed RRSP" }, value: { amount: 0, currency: "CAD", source: "brokerage_reported" } }));
    const { deps } = await setup(w);
    const input = (await loadThesisInput(deps, ME, "SYN.TO", NOW))!;
    // SYN.TO 1,200 + VFV 1,500 - debit 1,000 = 1,700.
    expect(input.weight!.pct).toBeCloseTo((1_200 / 1_700) * 100, 3);
    expect(input.weight).toMatchObject({ netOfMargin: true, notInTotal: ["Managed RRSP"] });
  });

  it("a trivial negative cash balance (under 1% of the positions) is not flagged as a margin debit (review 5)", async () => {
    const w = base();
    w.accounts[0].balances = [{ currency: "CAD", cash: -10, buyingPower: null }];
    const { deps } = await setup(w);
    const input = (await loadThesisInput(deps, ME, "SYN.TO", NOW))!;
    expect(input.weight!.netOfMargin).toBeUndefined();
  });

  it("no snapshot after writtenAt within 3 trading days: no start value, so no return (Review Focus 2)", async () => {
    const w = base();
    w.snapshots = [snap("A", "2026-06-08T22:30:00Z", [pos({ price: 100, marketValue: 1_000 })])];
    const { deps } = await setup(w, [{ kind: "return_below", text: "down 10%", pct: -10 }]);
    const input = (await loadThesisInput(deps, ME, "SYN.TO", NOW))!;
    expect(input.start).toBeNull();
    const check = checkThesis(input, NOW);
    expect(check.conditions[0]!.status).toBe("cant_tell");
    expect(check.playedOut.returnPct).toBeNull();
  });

  it("a snapshot captured before writtenAt is not the start (a buy later that day would be missed)", async () => {
    const w = base();
    w.snapshots = [snap("A", "2026-06-01T13:00:00Z", [pos({ price: 100, marketValue: 1_000 })]), snap("A", "2026-06-02T22:30:00Z", [pos({ price: 101, marketValue: 1_010 })])];
    const { deps } = await setup(w);
    expect((await loadThesisInput(deps, ME, "SYN.TO", NOW))!.start).toEqual({ date: "2026-06-02", valueCad: 1_010, estimated: false });
  });

  it("a snapshot captured after writtenAt whose positions are as of before it is not the start either", async () => {
    const w = base();
    w.snapshots = [
      snap("A", "2026-06-01T16:00:00Z", [pos({ price: 100, marketValue: 1_000 })], "2026-06-01T13:00:00Z"),
      snap("A", "2026-06-02T22:30:00Z", [pos({ price: 101, marketValue: 1_010 })]),
    ];
    const { deps } = await setup(w);
    expect((await loadThesisInput(deps, ME, "SYN.TO", NOW))!.start).toEqual({ date: "2026-06-02", valueCad: 1_010, estimated: false });
  });

  it("start snapshots on different days with a flow between them give no start value", async () => {
    const w = base();
    w.accounts.push(acct("C", [pos({ marketValue: 600, units: 5 })]));
    w.sync.push(backfilled("C"));
    w.snapshots.push(snap("C", "2026-06-03T22:30:00Z", [pos({ marketValue: 500, units: 5 })]));
    w.activities.push(act({ snapTradeAccountId: "A", type: "BUY", units: 1, amount: -100, tradeDate: "2026-06-02" }));
    const { deps } = await setup(w);
    expect((await loadThesisInput(deps, ME, "SYN.TO", NOW))!.start).toBeNull();
  });

  it("coverage is unknown when an account involved has not finished its activity backfill", async () => {
    const w = base();
    w.sync = [backfilled("A", "2024-01-02", { backfillCompletedAt: null })];
    const { deps } = await setup(w);
    const input = (await loadThesisInput(deps, ME, "SYN.TO", NOW))!;
    expect(input.coverageStart).toBeNull();
    expect(checkThesis(input, NOW).playedOut.returnPct).toBeNull();
  });

  it("a USD listing converts at the Bank of Canada rate (est.)", async () => {
    const w = base();
    w.thesisTicker = "SYNU";
    w.accounts[0].positions.push(pos({ symbol: "SYNU", currency: "USD", price: 50, marketValue: 500 }));
    w.snapshots[0]!.payload = { positions: [pos({ symbol: "SYNU", currency: "USD", price: 40, marketValue: 400 })] };
    const { deps } = await setup(w);
    const input = (await loadThesisInput(deps, ME, "SYNU", NOW))!;
    expect(input.price).toEqual({ value: 50, currency: "USD", asOf: "2026-10-22" });
    expect(input.start).toEqual({ date: "2026-06-01", valueCad: 540, estimated: true });
    expect(input.end).toEqual({ date: "2026-10-22", valueCad: 675, estimated: true });
    expect(input.weight!.estimated).toBe(true);
  });

  it("the same ticker held as a CAD and a US listing is flagged, never combined", async () => {
    const w = base();
    w.thesisTicker = "SYN";
    w.accounts[0].positions.push(pos({ symbol: "SYN", currency: "CAD" }));
    w.accounts[1].positions.push(pos({ symbol: "SYN", currency: "USD" }));
    const { deps } = await setup(w);
    expect((await loadThesisInput(deps, ME, "SYN", NOW))!.multipleListings).toBe(true);
  });

  it("closed and credit accounts are left out of the holding's value and weight", async () => {
    const w = base();
    w.accounts.push(acct("Z", [pos({ marketValue: 9_000 })], { classification: cls("tfsa", "closed", false, "Old") }));
    const { deps } = await setup(w);
    const input = (await loadThesisInput(deps, ME, "SYN.TO", NOW))!;
    expect(input.end!.valueCad).toBe(1_200);
    expect(input.weight!.pct).toBe(40);
  });
});

/** World where SYN.TO was sold in full on 2026-09-01 (10 units at the start, 0.045 reinvested, 10.045 sold). */
const soldWorld = (): World => {
  const w = base();
  w.accounts[0].positions = [];
  w.activities.push(act({ type: "SELL", units: -10.045, price: 120, amount: 1_200, tradeDate: "2026-09-01" }));
  return w;
};

describe("sold in full is verified, never inferred from absence (C-2)", () => {
  const unverified = async (w: World) => {
    const { deps } = await setup(w);
    const input = (await loadThesisInput(deps, ME, "SYN.TO", NOW))!;
    expect(input.end).toBeNull();
    expect(input.weight).toBeNull();
    const check = checkThesis(input, NOW);
    expect(check.playedOut.returnPct).toBeNull();
    expect(check.conditions[0]!.status).toBe("cant_tell");
  };
  it("activity never synced: the reason says it hasn't been loaded (not 'no current value')", async () => {
    const w = soldWorld();
    w.sync[0] = backfilled("A", "2024-01-02", { lastSyncedAt: null });
    const { deps } = await setup(w);
    const input = (await loadThesisInput(deps, ME, "SYN.TO", NOW))!;
    expect(input.end).toBeNull();
    expect(input.endNote).toBe(ACTIVITY_NOT_LOADED);
  });
  it("stale positions in an account involved", async () => {
    const w = soldWorld();
    w.accounts[0].freshness = { ...w.accounts[0].freshness, positionsAsOf: "2026-10-01T21:00:00.000Z" };
    await unverified(w);
  });
  it("an account involved with no positions date", async () => {
    const w = soldWorld();
    w.accounts[0].freshness = { ...w.accounts[0].freshness, positionsAsOf: null };
    await unverified(w);
  });
  it("activity last synced more than 48 hours ago", async () => {
    const w = soldWorld();
    w.sync[0] = backfilled("A", "2024-01-02", { lastSyncedAt: new Date(NOW.getTime() - 49 * 3_600_000) });
    await unverified(w);
  });
  it("activity never synced", async () => {
    const w = soldWorld();
    w.sync[0] = backfilled("A", "2024-01-02", { lastSyncedAt: null });
    await unverified(w);
  });
  it("a sync error on an account involved", async () => {
    const w = soldWorld();
    w.sync[0] = backfilled("A", "2024-01-02", { lastError: "SYNTHETIC_ERROR" });
    await unverified(w);
  });
  it("units since the start that don't net to zero (a sale not yet synced, a partial record)", async () => {
    const w = soldWorld();
    w.activities.at(-1)!.units = -6;
    await unverified(w);
  });
  it("a sale reported with no units", async () => {
    const w = soldWorld();
    w.activities.at(-1)!.units = null;
    await unverified(w);
  });
  it("verified: sold in full gives the end at 0 on the sale date (control)", async () => {
    const { deps } = await setup(soldWorld());
    expect((await loadThesisInput(deps, ME, "SYN.TO", NOW))!.end).toEqual({ date: "2026-09-01", valueCad: 0, estimated: false });
  });
});

describe("weight needs fresh, valued positions (I-1)", () => {
  it("is as of the oldest positions date of the accounts counted", async () => {
    const w = base();
    w.accounts[1].freshness = { ...w.accounts[1].freshness, positionsAsOf: "2026-10-20T21:00:00.000Z" };
    const { deps } = await setup(w);
    expect((await loadThesisInput(deps, ME, "SYN.TO", NOW))!.weight).toEqual({ pct: 40, estimated: false, asOf: "2026-10-20" });
  });
  it("is unknown when an account has no positions date", async () => {
    const w = base();
    w.accounts[1].freshness = { ...w.accounts[1].freshness, positionsAsOf: null };
    const { deps } = await setup(w);
    expect((await loadThesisInput(deps, ME, "SYN.TO", NOW))!.weight).toBeNull();
  });
  it("a held position with no reported value is unknown, not held at 0%", async () => {
    const w = base();
    w.accounts[0].positions = [pos({ marketValue: null, price: null })];
    const { deps } = await setup(w);
    const input = (await loadThesisInput(deps, ME, "SYN.TO", NOW))!;
    expect(input.weight).toBeNull();
    expect(input.end).toBeNull();
  });
  it("a held position with no currency uses the listing from stored activity", async () => {
    const w = base();
    w.accounts[0].positions = [pos({ currency: null, units: 10.045 })];
    const { deps } = await setup(w);
    const input = (await loadThesisInput(deps, ME, "SYN.TO", NOW))!;
    expect(input.end).toEqual({ date: "2026-10-22", valueCad: 1_200, estimated: false });
    expect(input.multipleListings).toBe(false);
  });
});

describe("activity sync errors (I-2)", () => {
  it("lastError on an account involved sets syncError; on another account it does not", async () => {
    const onA = base();
    onA.sync[0] = backfilled("A", "2024-01-02", { lastError: "SYNTHETIC_ERROR" });
    expect((await loadThesisInput((await setup(onA)).deps, ME, "SYN.TO", NOW))!.syncError).toBe(true);
    const onB = base();
    onB.sync[1] = { ...onB.sync[1]!, lastError: "SYNTHETIC_ERROR" };
    expect((await loadThesisInput((await setup(onB)).deps, ME, "SYN.TO", NOW))!.syncError).toBe(false);
  });
});

describe("thesis baseline (I-3)", () => {
  const SNAPSHOT_START = { date: "2026-06-01", valueCad: 1_000, estimated: false };
  const BASELINE_START = { date: "2026-06-01", valueCad: 1_050, estimated: false };
  const baseline = (over: Record<string, unknown> = {}) => ({
    writtenAt: WRITTEN.toISOString(), positionsAsOf: "2026-06-01T14:00:00.000Z", valueCad: 1_050, units: 10, priceNative: 105, currency: "CAD",
    accountsSeen: [accountKey("A"), accountKey("B")],
    accountsAsOf: { [accountKey("A")]: "2026-06-01T14:00:00.000Z", [accountKey("B")]: "2026-06-01T13:00:00.000Z" }, ...over,
  });
  const write = (memory: MemoryService, value: unknown) => memory.remember(ME, {
    node: { type: "security", key: "SYN.TO" }, property: "security.thesis_baseline", value, text: "Baseline.", kind: "fact", provenance: "derived",
  }, WRITTEN, "system");
  const startWith = async (w: World, value: unknown) => {
    const { deps, memory } = await setup(w);
    await write(memory, value);
    return (await loadThesisInput(deps, ME, "SYN.TO", NOW))!.start;
  };

  it("captureThesisBaseline records the holding at save time, and the loader prefers it", async () => {
    const w = base();
    const { deps, memory } = await setup(w);
    const atSave = { connectionRequired: false, generatedAt: WRITTEN.toISOString(), totals: [], errors: [], accounts: [
      acct("A", [pos({ price: 105, marketValue: 1_050 })], { freshness: { positionsAsOf: "2026-06-01T14:00:00.000Z", holdingsLastSyncedAt: null, initialSyncCompleted: true, holdingsUnavailable: false } }),
      acct("B", [pos({ symbol: "VFV", kind: "etf", marketValue: 1_400 })], { freshness: { positionsAsOf: "2026-06-01T13:00:00.000Z", holdingsLastSyncedAt: null, initialSyncCompleted: true, holdingsUnavailable: false } }),
    ] } as any;
    const written = await captureThesisBaseline({ memory, portfolio: async () => atSave, market: deps.market }, ME, "SYN.TO", WRITTEN);
    expect(written).toEqual(baseline({ positionsAsOf: "2026-06-01T13:00:00.000Z" }));
    expect(written!.accountsAsOf).toEqual({ [accountKey("A")]: "2026-06-01T14:00:00.000Z", [accountKey("B")]: "2026-06-01T13:00:00.000Z" });
    expect((await loadThesisInput(deps, ME, "SYN.TO", NOW))!.start).toEqual(BASELINE_START);
  });
  it("captureThesisBaseline writes nothing when an account has no positions date or the listing is ambiguous", async () => {
    const { deps, memory } = await setup(base());
    const noDate = { accounts: [acct("A", [pos({})], { freshness: { positionsAsOf: null, holdingsLastSyncedAt: null } })] } as any;
    expect(await captureThesisBaseline({ memory, portfolio: async () => noDate, market: deps.market }, ME, "SYN.TO", WRITTEN)).toBeNull();
    const twoListings = { accounts: [acct("A", [pos({}), pos({ currency: "USD" })])] } as any;
    expect(await captureThesisBaseline({ memory, portfolio: async () => twoListings, market: deps.market }, ME, "SYN.TO", WRITTEN)).toBeNull();
    expect((await loadThesisInput(deps, ME, "SYN.TO", NOW))!.start).toMatchObject(SNAPSHOT_START);
  });
  it("is used when its writtenAt, positions date, accounts and coverage all hold (even with no snapshots left)", async () => {
    const w = base();
    w.snapshots = [];
    expect(await startWith(w, baseline())).toMatchObject(BASELINE_START);
  });
  it("matches an amended version by its value's writtenAt, not the amendment's recordedAt", async () => {
    const w = base();
    w.snapshots = [];
    const { deps, memory } = await setup(w);
    await write(memory, baseline());
    const later = new Date(WRITTEN.getTime() + 5 * 86_400_000);
    await memory.remember(ME, {
      node: { type: "security", key: "SYN.TO" }, property: "security.thesis",
      value: { reasons: "Synthetic reasons.", timeFrame: { kind: "long", years: 5 }, conditions: [], writtenAt: WRITTEN.toISOString() },
      text: "Thesis.", kind: "reason", provenance: "stated",
    }, later);
    const input = (await loadThesisInput(deps, ME, "SYN.TO", NOW))!;
    expect(input.writtenAt.toISOString()).toBe(WRITTEN.toISOString());
    expect(input.start).toMatchObject(BASELINE_START);
  });
  it("is not used for another thesis version (writtenAt differs)", async () => {
    expect(await startWith(base(), baseline({ writtenAt: new Date(WRITTEN.getTime() + 1_000).toISOString() }))).toMatchObject(SNAPSHOT_START);
  });
  it("is not used when its positions are more than 3 trading days from writtenAt", async () => {
    // Fri 2026-05-22 to Mon 2026-06-01 is 6 weekdays.
    expect(await startWith(base(), baseline({ positionsAsOf: "2026-05-22T20:00:00.000Z" }))).toMatchObject(SNAPSHOT_START);
  });
  it("is not used when an account involved that existed then was not seen", async () => {
    expect(await startWith(base(), baseline({ accountsSeen: [accountKey("B")] }))).toMatchObject(SNAPSHOT_START);
    // Even with no activity in the holding before the baseline: A existed then, so a value of 0 can't be assumed.
    const w = base();
    w.activities = w.activities.filter((a) => a.tradeDate !== "2026-05-15");
    expect(await startWith(w, baseline({ accountsSeen: [accountKey("B")] }))).toMatchObject(SNAPSHOT_START);
  });
  it("an account connected after writtenAt with no earlier activity in the holding does not block it", async () => {
    const w = base();
    w.accounts.push(acct("C", [pos({ marketValue: 600, units: 5 })]));
    w.sync.push(backfilled("C"));
    w.createdAt = { C: "2026-07-01T00:00:00Z" };
    w.activities.push(act({ snapTradeAccountId: "C", type: "BUY", units: 5, amount: -550, tradeDate: "2026-07-02" }));
    expect(await startWith(w, baseline())).toMatchObject(BASELINE_START);
    // ...but one with activity in it on or before the baseline date does.
    w.activities.push(act({ snapTradeAccountId: "C", type: "BUY", units: 1, amount: -100, tradeDate: "2026-05-20" }));
    expect(await startWith(w, baseline())).toBeNull();
  });
  it("is not used when coverage no longer reaches its date", async () => {
    const w = base();
    w.sync[0] = backfilled("A", "2026-06-15");
    expect(await startWith(w, baseline())).toMatchObject(SNAPSHOT_START);
  });
  it("is not used when holding activity falls between its accounts' positions dates (R2-I-1)", async () => {
    // A as of Fri 2026-05-29, C as of Mon 2026-06-01; a buy in C on 2026-05-30... is already in C's value, so counting
    // it again as a flow after the oldest date would count it twice.
    const w = base();
    w.accounts.push(acct("C", [pos({ marketValue: 600, units: 5 })]));
    w.sync.push(backfilled("C"));
    w.activities.push(act({ snapTradeAccountId: "C", type: "BUY", units: 1, amount: -100, tradeDate: "2026-06-01" }));
    const mixed = baseline({
      positionsAsOf: "2026-05-29T20:00:00.000Z", accountsSeen: [accountKey("A"), accountKey("B"), accountKey("C")],
      accountsAsOf: { [accountKey("A")]: "2026-05-29T20:00:00.000Z", [accountKey("B")]: "2026-05-29T20:00:00.000Z", [accountKey("C")]: "2026-06-01T20:00:00.000Z" },
    });
    // No usable baseline, and C has no start snapshot: no start value.
    expect(await startWith(w, mixed)).toBeNull();
    // Same dates with no activity in between: the baseline is used.
    w.activities = w.activities.filter((a) => a.tradeDate !== "2026-06-01");
    expect(await startWith(w, mixed)).toMatchObject({ date: "2026-05-29", valueCad: 1_050 });
  });
  it("is not used when its currency is not the holding's listing", async () => {
    expect(await startWith(base(), baseline({ currency: "USD" }))).toMatchObject(SNAPSHOT_START);
  });
});

describe("held positions: activity age is not a gate; the units check is, and the return says how current (2026-10-25 ruling, was R2-I-2)", () => {
  const RET = [{ kind: "return_below", text: "down 10%", pct: -10 }];
  const behind = async (over: Partial<SyncRec>) => {
    const w = base();
    w.sync[0] = backfilled("A", "2024-01-02", over);
    const { deps } = await setup(w, RET);
    const input = (await loadThesisInput(deps, ME, "SYN.TO", NOW))!;
    return { input, check: checkThesis(input, NOW) };
  };
  const counted = async (over: Partial<SyncRec>, day: string) => {
    const { input, check } = await behind(over);
    expect(input.end).not.toBeNull();
    expect(input.activityAsOf).toBe(day);
    expect(check.playedOut.returnPct).not.toBeNull();
    expect(check.playedOut.notes).toContain(activityAsOfNote(day));
  };
  it("activity last synced before the positions, units reconciling: the end counts, dated by the sync", async () => {
    // Positions as of 2026-10-22 21:00Z; activity synced that morning. The units still match, so no trade is missing.
    await counted({ lastSyncedAt: new Date("2026-10-22T14:00:00Z") }, "2026-10-22");
  });
  it("activity synced more than 48 hours ago, units reconciling: the end counts, dated by the sync", async () => {
    await counted({ lastSyncedAt: new Date(NOW.getTime() - 72 * 3_600_000) }, torontoDay(new Date(NOW.getTime() - 72 * 3_600_000)));
  });
  it("activity never synced: can't tell, saying it hasn't been loaded", async () => {
    const { input, check } = await behind({ lastSyncedAt: null });
    expect(input.end).toBeNull();
    expect(input.endNote).toBe(ACTIVITY_NOT_LOADED);
    expect(check.playedOut.reason).toBe(`can't tell: ${ACTIVITY_NOT_LOADED}`);
    expect(input.activityAsOf).toBeNull();
  });
  it("activity more than ACTIVITY_STALE_DAYS old: can't tell, saying when it was last updated (a stopped sync misses dividends)", async () => {
    const old = new Date(NOW.getTime() - (ACTIVITY_STALE_DAYS + 1) * 86_400_000);
    const { input, check } = await behind({ lastSyncedAt: old });
    expect(input.end).toBeNull();
    expect(input.endNote).toBe(activityStaleNote(torontoDay(old)));
    expect(check.playedOut.reason).toBe(`can't tell: ${activityStaleNote(torontoDay(old))}`);
  });
  it("two accounts hold it: the as-of date is the older sync; an account not involved doesn't count", async () => {
    const w = base();
    w.accounts[1].positions.push(pos({ units: 2 }));
    w.activities.push(act({ snapTradeAccountId: "B", units: 2, price: 90, amount: -180, tradeDate: "2026-06-01" }));
    const older = new Date(NOW.getTime() - 72 * 3_600_000);
    w.sync = [backfilled("A"), backfilled("B", "2024-01-02", { lastSyncedAt: older })];
    const { deps } = await setup(w, RET);
    expect((await loadThesisInput(deps, ME, "SYN.TO", NOW))!.activityAsOf).toBe(torontoDay(older));
    const w2 = base();
    w2.sync = [backfilled("A"), backfilled("B", "2024-01-02", { lastSyncedAt: older })];
    const { deps: deps2 } = await setup(w2, RET);
    expect((await loadThesisInput(deps2, ME, "SYN.TO", NOW))!.activityAsOf).toBe(torontoDay(new Date(NOW.getTime() - 3_600_000)));
  });
  it("a sync error", async () => {
    const { input, check } = await behind({ lastError: "SYNTHETIC_ERROR" });
    expect(input.end).toBeNull();
    expect(check.conditions[0]!.status).toBe("cant_tell");
    expect(check.playedOut.returnPct).toBeNull();
  });
  it("an involved account with no sync row", async () => {
    const w = base();
    w.sync = w.sync.filter((s) => s.snapTradeAccountId !== "A");
    const { deps } = await setup(w);
    const input = (await loadThesisInput(deps, ME, "SYN.TO", NOW))!;
    expect(input.end).toBeNull();
    expect(input.endNote).toBe(ACTIVITY_NOT_LOADED);
  });
});

describe("held: start units plus the units since must match the units held now (final review I-2)", () => {
  const RET = [{ kind: "return_below", text: "down 10%", pct: -10 }];
  const cantTell = async (w: World, note = ACTIVITY_NOT_RECORDED) => {
    const { deps } = await setup(w, RET);
    const input = (await loadThesisInput(deps, ME, "SYN.TO", NOW))!;
    expect(input.end).toBeNull();
    const check = checkThesis(input, NOW);
    expect(check.conditions[0]).toMatchObject({ status: "cant_tell", note });
    expect(check.playedOut.returnPct).toBeNull();
    expect(check.playedOut.reason).toBe(`can't tell: ${note}`);
    return input;
  };
  const counted = async (w: World) => {
    const { deps } = await setup(w, RET);
    const input = (await loadThesisInput(deps, ME, "SYN.TO", NOW))!;
    expect(input.end).not.toBeNull();
    expect(checkThesis(input, NOW).playedOut.returnPct).not.toBeNull();
  };

  it("the brokerage posted activity after the positions: 5 more units held, no buy recorded yet", async () => {
    const w = base();
    // Activity is synced after the positions (R2-I-2 holds), but the buy itself has not been posted.
    w.accounts[0].positions = [pos({ units: 15.045, marketValue: 1_800 })];
    await cantTell(w);
  });
  it("a sale in the positions that activity doesn't show yet", async () => {
    const w = base();
    w.accounts[0].positions = [pos({ units: 4, marketValue: 480 })];
    await cantTell(w);
  });
  it("control: the buy recorded, units reconcile and the return is a number", async () => {
    const w = base();
    w.accounts[0].positions = [pos({ units: 15.045, marketValue: 1_800 })];
    w.activities.push(act({ type: "BUY", units: 5, price: 110, amount: -550, tradeDate: "2026-09-10" }));
    await counted(w);
  });
  it("reinvested-dividend units count: a REINVEST row's units are in the units held", async () => {
    const w = base();
    w.accounts[0].positions = [pos({ units: 10.095 })];
    w.activities.push(act({ type: "DIVIDEND", amount: 6, tradeDate: "2026-09-02" }), act({ type: "REINVEST", units: 0.05, amount: -6, tradeDate: "2026-09-02" }));
    await counted(w);
    // Without the REINVEST row's units the count is short by 0.05.
    w.activities.pop();
    w.activities.push(act({ type: "REINVEST", units: null, amount: -6, tradeDate: "2026-09-02" }));
    await cantTell(w);
  });
  it("within 1e-6 relative it matches; beyond it does not", async () => {
    const w = base();
    w.accounts[0].positions = [pos({ units: 10.045 * (1 + 5e-7) })];
    await counted(w);
    w.accounts[0].positions = [pos({ units: 10.045 * (1 + 5e-6) })];
    await cantTell(w);
  });
  it("a split with no units gives can't tell", async () => {
    const w = base();
    w.accounts[0].positions = [pos({ units: 20.09, price: 60 })];
    w.activities.push(act({ type: "SPLIT", units: null, tradeDate: "2026-09-15" }));
    await cantTell(w);
  });
  it("a corporate action with no units gives can't tell", async () => {
    const w = base();
    w.activities.push(act({ type: "CORPORATE_ACTION", units: 0, amount: 0, tradeDate: "2026-09-15" }));
    await cantTell(w);
  });
  it("a split that reports its units reconciles", async () => {
    const w = base();
    w.accounts[0].positions = [pos({ units: 20.09, price: 60 })];
    w.activities.push(act({ type: "SPLIT", units: 10.045, tradeDate: "2026-09-15" }));
    await counted(w);
  });
  it("start units unknown (a start snapshot without units): can't tell", async () => {
    const w = base();
    w.snapshots[0]!.payload = { positions: [pos({ price: 100, marketValue: 1_000, units: null })] };
    await cantTell(w, UNITS_NOT_REPORTED);
  });
  it("units held now unknown: can't tell", async () => {
    const w = base();
    w.accounts[0].positions = [pos({ units: null })];
    await cantTell(w, UNITS_NOT_REPORTED);
  });
  it("price and weight conditions are unaffected", async () => {
    const w = base();
    w.accounts[0].positions = [pos({ units: 15.045, marketValue: 1_800 })];
    const { deps } = await setup(w);
    const input = (await loadThesisInput(deps, ME, "SYN.TO", NOW))!;
    expect(checkThesis(input, NOW).conditions[0]).toMatchObject({ kind: "weight_above", status: "broken" });
  });
});

describe("loadHoldingView: any holding, thesis optional", () => {
  /** base() with the thesis on another ticker, and benchmark closes on the first purchase date. */
  const noThesis = (): World => ({
    ...base(), thesisTicker: "OTHER.TO",
    sp500: [{ date: "2026-05-15", close: 100 }, { date: "2026-10-22", close: 110 }],
    tsx: [{ date: "2026-05-15", close: 100 }, { date: "2026-10-22", close: 105 }],
  });

  it("a holding with no thesis: since the first purchase (start 0) vs the market, weight and the last 30 days of news", async () => {
    const w = noThesis();
    w.articles = [article("recent", "2026-10-20T12:00:00Z"), article("old", "2026-08-01T12:00:00Z")];
    const { deps, calls } = await setup(w);
    const view = await loadHoldingView(deps, ME, "syn.to", NOW);
    expect(view.thesis).toBeNull();
    const h = view.holding!;
    expect(h.ticker).toBe("SYN.TO");
    // The reinvested dividend is paired away: the only flow is the first purchase.
    expect(h.flows.map((f) => [f.date, f.kind, f.amountCad])).toEqual([["2026-05-15", "buy", -900]]);
    expect(h.end).toMatchObject({ date: "2026-10-22", valueCad: 1_200, estimated: false });
    expect(h.coverageStart).toBe("2024-01-02");
    const check = checkHolding(h, NOW);
    expect(check.sinceFirstBought.startDate).toBe("2026-05-15");
    expect(check.sinceFirstBought.returnPct).toBeCloseTo(100 / 3, 6);
    expect(check.sinceFirstBought.vsSp500Pct).toBeCloseTo(100 / 3 - 10, 6);
    expect(check.sinceFirstBought.vsTsxPct).toBeCloseTo(100 / 3 - 5, 6);
    expect(check.sinceFirstBought.notes.some((n) => n.startsWith("USD amounts converted at the Bank of Canada rate"))).toBe(true);
    expect(check.weight).toEqual({ pct: 40, estimated: false, asOf: "2026-10-22" });
    expect(check.news.map((n) => n.title)).toEqual(["Synthetic recent"]);
    // No thesis: no start snapshots or baseline are read.
    expect(calls.snapWhere).toHaveLength(0);
    for (const where of [...calls.activityWhere, ...calls.syncWhere]) expect((where as any).appUser.authSubject).toBe(ME);
  });

  it("coverage starting after the first purchase gives can't tell", async () => {
    const w = noThesis();
    w.sync = [backfilled("A", "2026-06-01"), w.sync[1]!];
    const { deps } = await setup(w);
    const check = checkHolding((await loadHoldingView(deps, ME, "SYN.TO", NOW)).holding!, NOW);
    expect(check.sinceFirstBought.returnPct).toBeNull();
    expect(check.sinceFirstBought.reason).toBe(`can't tell: ${NO_FULL_HISTORY}`);
  });

  it("an unvalued transfer-in gives can't tell", async () => {
    const w = noThesis();
    w.activities.push(act({ type: "TRANSFER", units: 2, price: null, amount: null, tradeDate: "2026-07-02" }));
    w.accounts[0].positions = [pos({ units: 12.045, marketValue: 1_440 })];
    const { deps } = await setup(w);
    const check = checkHolding((await loadHoldingView(deps, ME, "SYN.TO", NOW)).holding!, NOW);
    expect(check.sinceFirstBought.returnPct).toBeNull();
    expect(check.sinceFirstBought.reason).toBe(SHARES_MOVED_UNVALUED);
  });

  it("units held that stored activity doesn't explain (shares from before coverage, posting lag) give can't tell", async () => {
    const w = noThesis();
    w.accounts[0].positions = [pos({ units: 15.045, marketValue: 1_800 })];
    const { deps } = await setup(w);
    const h = (await loadHoldingView(deps, ME, "SYN.TO", NOW)).holding!;
    expect(h.end).toBeNull();
    expect(checkHolding(h, NOW).sinceFirstBought.reason).toBe(`can't tell: ${ACTIVITY_NOT_RECORDED}`);
  });

  it("a sync error gives can't tell; activity three days old still gives the return, dated by the oldest sync", async () => {
    const w = noThesis();
    w.sync = [backfilled("A", "2024-01-02", { lastError: "synthetic" }), w.sync[1]!];
    const { deps } = await setup(w);
    expect(checkHolding((await loadHoldingView(deps, ME, "SYN.TO", NOW)).holding!, NOW).sinceFirstBought.reason).toMatch(/^can't tell: activity sync/);
    const w2 = noThesis();
    const old = new Date(NOW.getTime() - 72 * 3_600_000);
    w2.sync = [backfilled("A", "2024-01-02", { lastSyncedAt: old }), w2.sync[1]!];
    const { deps: deps2 } = await setup(w2);
    const view = (await loadHoldingView(deps2, ME, "SYN.TO", NOW)).holding!;
    expect(view.activityAsOf).toBe(torontoDay(old));
    const since = checkHolding(view, NOW).sinceFirstBought;
    expect(since.returnPct).not.toBeNull();
    expect(since.notes).toContain(activityAsOfNote(torontoDay(old)));
  });

  it("a holding held before and sold in full: compares up to the sale, weight 0", async () => {
    const w = noThesis();
    w.accounts[0].positions = [];
    w.activities.push(act({ type: "SELL", units: -10.045, price: 120, amount: 1_200, tradeDate: "2026-09-01" }));
    w.sp500 = [{ date: "2026-05-15", close: 100 }, { date: "2026-09-01", close: 110 }, { date: "2026-10-22", close: 110 }];
    w.tsx = w.sp500;
    const { deps } = await setup(w);
    const check = checkHolding((await loadHoldingView(deps, ME, "SYN.TO", NOW)).holding!, NOW);
    expect(check.sinceFirstBought.endDate).toBe("2026-09-01");
    expect(check.sinceFirstBought.returnPct).toBeCloseTo(100 / 3, 6);
    expect(check.weight).toEqual({ pct: 0, estimated: false, asOf: "2026-10-22" });
  });

  it("market data: benchmarks from the first of the start month (shared cache keys), one Bank of Canada read", async () => {
    const { deps, calls } = await setup(noThesis());
    const check = checkHolding((await loadHoldingView(deps, ME, "SYN.TO", NOW)).holding!, NOW);
    expect(check.sinceFirstBought.returnPct).not.toBeNull();
    // 2026-05-15 snaps to 2026-05-01, less the benchmark lead days: the same key for any start in May.
    const from = benchmarkFetchFrom("2026-05-01");
    expect(calls.history.map(([t, f]) => [t, f]).sort()).toEqual([["^GSPTSE", from], ["^SP500TR", from]]);
    expect(calls.usdCad).toHaveLength(1);
    expect(calls.usdCad[0]![0]! <= from).toBe(true);
  });

  it("market data is not read when the answer is already can't tell (coverage after the first recorded purchase, all CAD)", async () => {
    const w = noThesis();
    w.sync = [backfilled("A", "2026-06-01"), w.sync[1]!];
    const { deps, calls } = await setup(w);
    const check = checkHolding((await loadHoldingView(deps, ME, "SYN.TO", NOW)).holding!, NOW);
    expect(check.sinceFirstBought.reason).toBe(`can't tell: ${NO_FULL_HISTORY}`);
    expect(calls.history).toEqual([]);
    expect(calls.usdCad).toEqual([]);
  });

  it("a ticker never held (no position, no stored activity) is null", async () => {
    const { deps } = await setup(noThesis());
    expect(await loadHoldingView(deps, ME, "NOPE.TO", NOW)).toEqual({ holding: null, thesis: null });
  });

  it("with a thesis: the thesis input is unchanged and the holding view comes too", async () => {
    const w = base();
    w.sp500 = [{ date: "2026-05-15", close: 100 }, ...w.sp500!];
    w.tsx = [{ date: "2026-05-15", close: 100 }, ...w.tsx!];
    const { deps } = await setup(w);
    const view = await loadHoldingView(deps, ME, "SYN.TO", NOW);
    const thesisCheck = checkThesis(view.thesis!, NOW);
    expect(thesisCheck.playedOut.returnPct).toBeCloseTo(20, 6);
    expect(thesisCheck.playedOut.startDate).toBe("2026-06-01");
    const holding = checkHolding(view.holding!, NOW);
    expect(holding.sinceFirstBought.startDate).toBe("2026-05-15");
    expect(holding.sinceFirstBought.returnPct).toBeCloseTo(100 / 3, 6);
    expect((await loadThesisInput(deps, ME, "SYN.TO", NOW))!.start).toEqual(view.thesis!.start);
  });
});
