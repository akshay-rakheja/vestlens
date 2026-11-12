import { describe, expect, it } from "vitest";
import type { HoldingRow } from "../analytics/holdings.js";
import type { Quote } from "../market-data/types.js";
import { buildStats, classifyMovers, typicalMove } from "./movers.js";
import type { SymbolStats } from "./store.js";

const row = (symbol: string, currency: string, units: number, accounts = 1, kind = "stock"): HoldingRow => ({
  key: `${symbol}|${currency}`, symbol, currency, kind, units, price: null, marketValue: units * 100, bookCost: null,
  totalReturn: null, totalReturnFraction: null, weight: null, weightCad: null, dayChange: null,
  accounts: Array.from({ length: accounts }, (_, i) => ({ accountId: `a${i}`, label: `A${i}`, units: units / accounts, marketValue: null, bookCost: null, totalReturn: null })),
});
const NOW = new Date("2026-10-21T15:00:00Z");
const stats = (symbol: string, currency: string, typical: number | null, prevClose: number | null = 100, lastClose: number | null = 100): SymbolStats => ({
  symbol, currency, closes: typical === null ? 10 : 60, typicalMove: typical, lastClose, prevClose, lastCloseDate: "2026-10-20", updatedAt: new Date("2026-10-20T00:00:00Z"),
});
const quote = (ticker: string, price: number, asOf = "2026-10-21T15:00:00Z"): Quote => ({ ticker, currency: "CAD", price, previousClose: null, asOf });
const run = (rows: HoldingRow[], s: SymbolStats[], q: Quote[], totals: Array<[string, number]>, open = false) =>
  classifyMovers(rows, new Map(s.map((x) => [`${x.symbol}|${x.currency}`, x])), new Map(q.map((x) => [x.ticker, x])), new Map(totals), open, NOW);

describe("typicalMove", () => {
  it("is the hand-computed median for even and odd return counts", () => {
    // 31 closes -> 30 returns: fifteen of |0.01| then fifteen of |0.03| -> even median (0.01+0.03)/2 = 0.02
    const closes = [100];
    for (let i = 0; i < 30; i += 1) closes.push(closes[i] * (i < 15 ? 1.01 : 0.97));
    expect(typicalMove(closes)).toBeCloseTo(0.02, 9);
    // first 30 closes -> 29 returns: fifteen 0.01, fourteen 0.03 -> odd median 0.01
    expect(typicalMove(closes.slice(0, 30))).toBeCloseTo(0.01, 9);
  });
  it("window is the last 61 closes (60 returns): the 62nd-from-last close is ignored", () => {
    // 62 closes -> 61 returns. r1 = 0.5 is outside the window; r2..r31 = 0.5 (30), r32..r61 = 0.01 (30).
    const closes = [100];
    for (let i = 1; i <= 61; i += 1) closes.push(closes[i - 1] * (i <= 31 ? 1.5 : 1.01));
    expect(typicalMove(closes)).toBeCloseTo(0.255, 9); // (0.01 + 0.5) / 2; including r1 would give 0.5
  });
  it("ignores non-positive and non-finite closes", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 * 1.01 ** i);
    expect(typicalMove([...closes, Number.NaN, 0, -5, Number.POSITIVE_INFINITY])).toBeCloseTo(0.01, 9);
  });
  it("is null under 30 closes", () => {
    expect(typicalMove(Array.from({ length: 29 }, (_, i) => 100 + i))).toBeNull();
    expect(typicalMove(Array.from({ length: 30 }, (_, i) => 100 + i))).not.toBeNull();
  });
  it("uses only the last 60 trading days", () => {
    const old = Array.from({ length: 40 }, (_, i) => (i % 2 ? 150 : 100)); // huge swings, must be ignored
    const recent = Array.from({ length: 61 }, (_, i) => 100 * 1.01 ** i);
    expect(typicalMove([...old, ...recent])).toBeCloseTo(0.01, 9);
  });
});

describe("buildStats", () => {
  const day = (i: number) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10); // 2026-09-01 + i
  const series = (n: number) => Array.from({ length: n }, (_, i) => ({ date: day(i), close: 100 * 1.01 ** i }));
  it("derives closes, last/prev close, lastCloseDate and typical move (any input order)", () => {
    const s = buildStats("ZZTEST", "CAD", series(40).reverse(), new Date("2026-10-20T16:00:00Z"), false);
    expect(s.closes).toBe(40);
    expect(s.typicalMove).toBeCloseTo(0.01, 9);
    expect(s.lastClose).toBeCloseTo(100 * 1.01 ** 39, 9);
    expect(s.prevClose).toBeCloseTo(100 * 1.01 ** 38, 9);
    expect(s.lastCloseDate).toBe(day(39));
    expect(s.updatedAt).toEqual(new Date("2026-10-20T16:00:00Z"));
  });
  it("reports nulls for short history", () => {
    const s = buildStats("ZZTEST", "CAD", [{ date: "2026-10-19", close: 5 }], new Date("2026-10-20T16:00:00Z"), false);
    expect(s).toMatchObject({ closes: 1, typicalMove: null, lastClose: 5, prevClose: null, lastCloseDate: "2026-10-19" });
    expect(buildStats("ZZTEST", "CAD", [], NOW, false)).toMatchObject({ closes: 0, lastClose: null, prevClose: null, lastCloseDate: null });
  });
  it("market open: a partial bar for today is dropped and does not leak into typicalMove", () => {
    const base = Array.from({ length: 40 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 11 + i)).toISOString().slice(0, 10), close: 100 * 1.01 ** i }));
    // base ends 2026-10-20; add a wild partial bar for 2026-10-21 (Toronto trading day of NOW)
    const withPartial = [...base, { date: "2026-10-21", close: 300 }];
    const a = buildStats("ZZTEST", "CAD", withPartial, NOW, true);
    const b = buildStats("ZZTEST", "CAD", base, NOW, true);
    expect(a).toEqual(b);
    expect(a.lastCloseDate).toBe("2026-10-20");
    expect(a.typicalMove).toBeCloseTo(0.01, 9);
    expect(a.lastClose).toBeCloseTo(100 * 1.01 ** 39, 9);
    expect(a.prevClose).toBeCloseTo(100 * 1.01 ** 38, 9);
  });
  it("market closed: today's completed bar is kept; future-dated points are dropped", () => {
    const pts = [{ date: "2026-10-19", close: 10 }, { date: "2026-10-20", close: 11 }, { date: "2026-10-21", close: 12 }, { date: "2026-10-22", close: 99 }];
    const s = buildStats("ZZTEST", "CAD", pts, NOW, false);
    expect(s).toMatchObject({ lastClose: 12, prevClose: 11, lastCloseDate: "2026-10-21", closes: 3 });
  });
  it("uses the Toronto date, not the UTC date", () => {
    // 2026-10-22T01:00Z is 21:00 on 2026-10-21 in Toronto (EDT)
    const late = new Date("2026-10-22T01:00:00Z");
    const pts = [{ date: "2026-10-20", close: 11 }, { date: "2026-10-21", close: 12 }, { date: "2026-10-22", close: 99 }];
    expect(buildStats("ZZTEST", "CAD", pts, late, false)).toMatchObject({ lastClose: 12, lastCloseDate: "2026-10-21" });
    expect(buildStats("ZZTEST", "CAD", pts, late, true)).toMatchObject({ lastClose: 11, lastCloseDate: "2026-10-20" });
  });
  it("dedupes points by date, last one wins", () => {
    const pts = [{ date: "2026-10-19", close: 10 }, { date: "2026-10-20", close: 11 }, { date: "2026-10-20", close: 12 }];
    const s = buildStats("ZZTEST", "CAD", pts, NOW, false);
    expect(s).toMatchObject({ closes: 2, lastClose: 12, prevClose: 10 });
  });
  it("ignores unparsable dates and non-positive or non-finite closes", () => {
    const pts = [
      { date: "garbage", close: 50 }, { date: "2026-13-45", close: 51 }, { date: "2026-10-18", close: Number.NaN },
      { date: "2026-10-19", close: 0 }, { date: "2026-10-20", close: 11 }, { date: "2026-10-21", close: -3 },
    ];
    expect(buildStats("ZZTEST", "CAD", pts, NOW, false)).toMatchObject({ closes: 1, lastClose: 11, prevClose: null, lastCloseDate: "2026-10-20" });
  });
});

describe("classifyMovers flagging", () => {
  const totals: Array<[string, number]> = [["CAD", 100_000]]; // dollar floor = max(50, 250) = 250
  it("flags at exactly 2x typical (boundary inclusive)", () => {
    const m = run([row("ZZTEST", "CAD", 1000)], [stats("ZZTEST", "CAD", 0.01, 100, 102)], [], totals);
    expect(m.movers[0]).toMatchObject({ returnFraction: expect.closeTo(0.02, 9), flagged: true, limitedHistory: false, estimated: false });
    const below = run([row("ZZTEST", "CAD", 1000)], [stats("ZZTEST", "CAD", 0.01, 100, 101.99)], [], totals);
    expect(below.movers[0].flagged).toBe(false);
  });
  it("applies the 1.5% floor when typical is small", () => {
    const at = run([row("ZZTEST", "CAD", 1000)], [stats("ZZTEST", "CAD", 0.001, 100, 101.5)], [], totals);
    expect(at.movers[0].flagged).toBe(true);
    const under = run([row("ZZTEST", "CAD", 1000)], [stats("ZZTEST", "CAD", 0.001, 100, 101.49)], [], totals);
    expect(under.movers[0].flagged).toBe(false);
  });
  it("flags downward moves by absolute size", () => {
    const m = run([row("ZZTEST", "CAD", 1000)], [stats("ZZTEST", "CAD", 0.01, 100, 97)], [], totals);
    expect(m.movers[0]).toMatchObject({ flagged: true, dollarMove: -3000 });
  });
  it("requires the dollar floor max(50, 0.25% of total)", () => {
    // return 3% but only 10 units: move $30 < $50
    expect(run([row("ZZTEST", "CAD", 10)], [stats("ZZTEST", "CAD", 0.01, 100, 103)], [], [["CAD", 1000]]).movers[0].flagged).toBe(false);
    // $60 move, total small so floor is 50
    expect(run([row("ZZTEST", "CAD", 20)], [stats("ZZTEST", "CAD", 0.01, 100, 103)], [], [["CAD", 1000]]).movers[0].flagged).toBe(true);
    // $3000 move vs 0.25% of 2,000,000 = 5000 -> not flagged; at 1,200,000 = 3000 -> flagged
    expect(run([row("ZZTEST", "CAD", 1000)], [stats("ZZTEST", "CAD", 0.01, 100, 103)], [], [["CAD", 2_000_000]]).movers[0].flagged).toBe(false);
    expect(run([row("ZZTEST", "CAD", 1000)], [stats("ZZTEST", "CAD", 0.01, 100, 103)], [], [["CAD", 1_200_000]]).movers[0].flagged).toBe(true);
  });
  it("dollar floor is exactly $50 (inclusive) when 0.25% of the total is smaller", () => {
    const t: Array<[string, number]> = [["CAD", 1000]];
    expect(run([row("ZZTEST", "CAD", 50)], [stats("ZZTEST", "CAD", 0.01, 100, 102)], [], t).movers[0]).toMatchObject({ dollarMove: 100, flagged: true });
    expect(run([row("ZZTEST", "CAD", 25)], [stats("ZZTEST", "CAD", 0.01, 100, 102)], [], t).movers[0]).toMatchObject({ dollarMove: 50, flagged: true });
    expect(run([row("ZZTEST", "CAD", 24.9)], [stats("ZZTEST", "CAD", 0.01, 100, 102)], [], t).movers[0].flagged).toBe(false);
  });
  it("does not flag a value that is meaningfully below the threshold (tolerance is tiny and relative)", () => {
    expect(run([row("ZZTEST", "CAD", 1000)], [stats("ZZTEST", "CAD", 0.01, 100, 101.9999)], [], [["CAD", 100_000]]).movers[0].flagged).toBe(false);
    expect(run([row("ZZTEST", "CAD", 1000)], [stats("ZZTEST", "CAD", 1e-14, 1e-12, 1.0149e-12)], [], [["CAD", 100_000]]).movers[0].flagged).toBe(false);
  });
  it("uses the floor-only rule with limitedHistory when typical is null", () => {
    const m = run([row("ZZTEST", "CAD", 1000)], [stats("ZZTEST", "CAD", null, 100, 101.6)], [], totals);
    expect(m.movers[0]).toMatchObject({ limitedHistory: true, flagged: true });
    expect(run([row("ZZTEST", "CAD", 1000)], [stats("ZZTEST", "CAD", null, 100, 101)], [], totals).movers[0].flagged).toBe(false);
  });
  it("treats a missing portfolio total as zero for the dollar floor", () => {
    expect(run([row("ZZTEST", "CAD", 20)], [stats("ZZTEST", "CAD", 0.01, 100, 103)], [], []).movers[0].flagged).toBe(true);
  });
});

describe("classifyMovers aggregation and pricing", () => {
  const totals: Array<[string, number]> = [["CAD", 1000], ["USD", 1000]];
  it("one mover per symbol and currency across accounts", () => {
    const r = classifyMovers(
      [row("ZZTEST", "CAD", 100, 2)], new Map([["ZZTEST|CAD", stats("ZZTEST", "CAD", 0.01, 100, 103)]]), new Map(), new Map(totals), false, NOW);
    expect(r.movers).toHaveLength(1);
    expect(r.movers[0]).toMatchObject({ symbol: "ZZTEST", currency: "CAD", units: 100, dollarMove: 300 });
  });
  it("sums duplicate rows for the same symbol and currency", () => {
    const r = run([row("ZZTEST", "CAD", 60), row("ZZTEST", "CAD", 40)], [stats("ZZTEST", "CAD", 0.01, 100, 103)], [], totals);
    expect(r.movers).toHaveLength(1);
    expect(r.movers[0]).toMatchObject({ units: 100, marketValue: 10000, dollarMove: 300 });
  });
  it("keeps CAD and USD listings separate", () => {
    const r = run([row("ZZTEST", "CAD", 1000), row("ZZTEST", "USD", 1000)],
      [stats("ZZTEST", "CAD", 0.01, 100, 105), stats("ZZTEST", "USD", 0.01, 100, 100.2)], [], [["CAD", 1000], ["USD", 1000]]);
    expect(r.movers).toHaveLength(2);
    expect(r.movers.find((m) => m.currency === "CAD")!.flagged).toBe(true);
    expect(r.movers.find((m) => m.currency === "USD")!.flagged).toBe(false);
  });
  it("market open: live quote vs lastClose (last completed session), estimated", () => {
    const r = run([row("ZZTEST", "CAD", 100)], [stats("ZZTEST", "CAD", 0.01, 90, 100)], [quote("ZZTEST", 104)], totals, true);
    expect(r.movers[0]).toMatchObject({ estimated: true, dollarMove: 400 });
    expect(r.movers[0].returnFraction).toBeCloseTo(0.04, 9);
  });
  it("market open does not need prevClose", () => {
    const r = run([row("ZZTEST", "CAD", 100)], [stats("ZZTEST", "CAD", 0.01, null, 100)], [quote("ZZTEST", 104)], totals, true);
    expect(r.movers[0].dollarMove).toBe(400);
  });
  it("market closed: lastClose vs prevClose, not estimated", () => {
    const r = run([row("ZZTEST", "CAD", 100)], [stats("ZZTEST", "CAD", 0.01, 90, 99)], [], totals, false);
    expect(r.movers[0]).toMatchObject({ estimated: false, dollarMove: 900 });
    expect(r.movers[0].returnFraction).toBeCloseTo(0.1, 9);
  });
  it("market open without a quote is unpriced; closed ignores quotes", () => {
    const open = run([row("ZZTEST", "CAD", 100)], [stats("ZZTEST", "CAD", 0.01, 100, 100.5)], [], totals, true);
    expect(open).toEqual({ movers: [], unpriced: [{ symbol: "ZZTEST", currency: "CAD" }] });
    const closed = run([row("ZZTEST", "CAD", 100)], [stats("ZZTEST", "CAD", 0.01, 100, 101)], [quote("ZZTEST", 150)], totals, false);
    expect(closed.movers[0]).toMatchObject({ estimated: false, dollarMove: 100 });
  });
  it("ignores a quote older than 24 hours (or with an unparsable asOf)", () => {
    const rows = [row("ZZTEST", "CAD", 100)];
    const st = [stats("ZZTEST", "CAD", 0.01, 100, 100)];
    expect(run(rows, st, [quote("ZZTEST", 104, "2026-10-20T14:59:00Z")], totals, true).unpriced).toHaveLength(1);
    expect(run(rows, st, [quote("ZZTEST", 104, "not a date")], totals, true).unpriced).toHaveLength(1);
    expect(run(rows, st, [quote("ZZTEST", 104, "2026-10-20T15:01:00Z")], totals, true).movers).toHaveLength(1);
  });
  it("omits symbols with missing stats or closes into unpriced (no duplicates)", () => {
    const r = run([row("ZZNONE", "CAD", 5), row("ZZNOPREV", "CAD", 5)], [stats("ZZNOPREV", "CAD", 0.01, null, 100)], [], totals);
    expect(r.movers).toEqual([]);
    expect(r.unpriced).toEqual(expect.arrayContaining([{ symbol: "ZZNONE", currency: "CAD" }, { symbol: "ZZNOPREV", currency: "CAD" }]));
    expect(r.unpriced).toHaveLength(2);
  });
  it("unpriced reports each (symbol, currency) once", () => {
    const r = run([row("ZZTEST", "CAD", 1), row("ZZTEST", "CAD", 2), row("ZZTEST", "USD", 3)], [], [], totals);
    expect(r.unpriced).toHaveLength(2);
    expect(r.unpriced).toEqual(expect.arrayContaining([{ symbol: "ZZTEST", currency: "CAD" }, { symbol: "ZZTEST", currency: "USD" }]));
  });
  it("prevClose of 0, NaN or negative prices are unpriced, not infinite moves", () => {
    for (const bad of [0, Number.NaN, -1]) {
      expect(run([row("ZZTEST", "CAD", 10)], [stats("ZZTEST", "CAD", 0.01, bad, 100)], [], totals).unpriced).toHaveLength(1);
    }
    expect(run([row("ZZTEST", "CAD", 10)], [stats("ZZTEST", "CAD", 0.01, 100, Number.NaN)], [], totals).unpriced).toHaveLength(1);
    expect(run([row("ZZTEST", "CAD", 10)], [stats("ZZTEST", "CAD", 0.01, 100, 100)], [quote("ZZTEST", -5)], totals, true).unpriced).toHaveLength(1);
  });
  it("empty rows and empty stats give empty results", () => {
    expect(run([], [], [], totals)).toEqual({ movers: [], unpriced: [] });
    expect(run([row("ZZTEST", "CAD", 1)], [], [], totals)).toEqual({ movers: [], unpriced: [{ symbol: "ZZTEST", currency: "CAD" }] });
  });
  it("carries the session the move ends on: the last close's date when closed, Toronto today while open", () => {
    expect(run([row("ZZTEST", "CAD", 100)], [stats("ZZTEST", "CAD", 0.01, 90, 99)], [], totals, false).movers[0].sessionDate).toBe("2026-10-20");
    expect(run([row("ZZTEST", "CAD", 100)], [stats("ZZTEST", "CAD", 0.01, 90, 100)], [quote("ZZTEST", 104)], totals, true).movers[0].sessionDate).toBe("2026-10-21");
  });
  it("stats whose last close is older than 2 Toronto trading days (weekends skipped) are unpriced, open or closed", () => {
    const at = (lastCloseDate: string | null, now: string, open = false) => classifyMovers(
      [row("ZZTEST", "CAD", 100)], new Map([["ZZTEST|CAD", { ...stats("ZZTEST", "CAD", 0.01, 90, 99), lastCloseDate }]]),
      new Map([["ZZTEST", quote("ZZTEST", 104, now)]]), new Map(totals), open, new Date(now));
    // Wednesday 2026-10-21: Tue and Mon are within two trading days; Fri is not
    expect(at("2026-10-19", "2026-10-21T12:00:00Z").movers).toHaveLength(1);
    expect(at("2026-10-16", "2026-10-21T12:00:00Z").unpriced).toEqual([{ symbol: "ZZTEST", currency: "CAD" }]);
    expect(at("2026-10-16", "2026-10-21T15:00:00Z", true).unpriced).toHaveLength(1);
    // Monday 2026-10-19 skips the weekend: Thursday's close is still usable, Wednesday's is not
    expect(at("2026-10-15", "2026-10-19T12:00:00Z").movers).toHaveLength(1);
    expect(at("2026-10-14", "2026-10-19T12:00:00Z").unpriced).toHaveLength(1);
    // Saturday 2026-10-24: Thursday and Friday are usable
    expect(at("2026-10-22", "2026-10-24T15:00:00Z").movers).toHaveLength(1);
    expect(at("2026-10-21", "2026-10-24T15:00:00Z").unpriced).toHaveLength(1);
    // no date is never fresh
    expect(at(null, "2026-10-21T12:00:00Z").unpriced).toHaveLength(1);
  });
  it("looks quotes up by provider ticker (crypto gets a currency suffix)", () => {
    const r = run([row("ZZCOIN", "CAD", 2, 1, "crypto")], [stats("ZZCOIN", "CAD", 0.01, 100, 100)], [quote("ZZCOIN-CAD", 110)], totals, true);
    expect(r.movers[0]).toMatchObject({ estimated: true, dollarMove: 20 });
  });
});
