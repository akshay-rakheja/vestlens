import { describe, expect, it } from "vitest";
import type { Condition, Thesis } from "../memory/memory-types.js";
import type { HoldingFlow } from "../analytics/shadow-benchmark.js";
import {
  BENCHMARK_BASIS_NOTE, checkThesis, EXCLUSION_COPY, FUNDAMENTAL_PENDING, NEWS_LIMIT, PRICE_STALE_TRADING_DAYS, SHARES_MOVED_UNVALUED,
  TIME_FRAME_ENDED, tradingDaysBetween, type ThesisCheck, type ThesisInput,
} from "./thesis-check.js";

/** Friday 2026-10-23, noon in Toronto. */
const NOW = new Date("2026-10-23T16:00:00Z");
const WRITTEN = new Date("2026-06-01T15:00:00Z");

type ConditionIn = Condition extends infer C ? (C extends Condition ? Omit<C, "id"> & { id?: string } : never) : never;
const cond = (c: ConditionIn): Condition => ({ ...c, id: c.id ?? `c-${c.kind}` }) as Condition;
const thesis = (over: Partial<Thesis> = {}): Thesis => ({ reasons: "Strong product, growing margins", timeFrame: { kind: "long", years: 3 }, conditions: [], ...over });
const flow = (over: Partial<HoldingFlow>): HoldingFlow => ({
  date: "2026-09-01", kind: "buy", amountCad: -500, estimated: false, rateDate: null, native: { amount: -500, currency: "CAD" }, units: 5, ...over,
});

const input = (over: Partial<ThesisInput> = {}): ThesisInput => ({
  ticker: "SHOP.TO",
  thesis: thesis(),
  writtenAt: WRITTEN,
  multipleListings: false,
  price: { value: 100, currency: "CAD", asOf: "2026-10-22" },
  weight: { pct: 8.5, estimated: true, asOf: "2026-10-22" },
  syncError: false,
  start: { date: "2026-06-01", valueCad: 1_000, estimated: false },
  end: { date: "2026-10-22", valueCad: 1_200, estimated: false },
  flows: [],
  excluded: [],
  coverageStart: "2024-01-02",
  benchmarks: {
    sp500: [{ date: "2026-06-01", closeCad: 100 }, { date: "2026-10-22", closeCad: 110 }],
    tsx: [{ date: "2026-06-01", closeCad: 100 }, { date: "2026-10-22", closeCad: 105 }],
  },
  news: [],
  earnings: [],
  ...over,
});
const one = (r: ThesisCheck, id: string) => r.conditions.find((c) => c.id === id)!;

describe("tradingDaysBetween (Toronto weekdays, holidays ignored)", () => {
  it("counts weekdays after the first date up to and including the second", () => {
    expect(tradingDaysBetween("2026-10-22", "2026-10-23")).toBe(1);
    expect(tradingDaysBetween("2026-10-16", "2026-10-19")).toBe(1); // Fri -> Mon
    expect(tradingDaysBetween("2026-10-17", "2026-10-18")).toBe(0); // Sat -> Sun
    expect(tradingDaysBetween("2026-10-19", "2026-10-23")).toBe(4);
    expect(tradingDaysBetween("2026-10-23", "2026-10-23")).toBe(0);
    expect(PRICE_STALE_TRADING_DAYS).toBe(3);
  });
});

describe("price conditions", () => {
  const below = cond({ id: "p1", kind: "price_below", text: "drops under $90", price: 90, currency: "CAD" });
  const above = cond({ id: "p2", kind: "price_above", text: "goes above $95", price: 95, currency: "CAD" });
  it("are held or broken on the snapshot price in native currency, with its date", () => {
    const r = checkThesis(input({ thesis: thesis({ conditions: [below, above] }) }), NOW);
    expect(one(r, "p1")).toMatchObject({ status: "held", kind: "price_below", text: "drops under $90", evidence: { value: "100.00 CAD", asOf: "2026-10-22" } });
    expect(one(r, "p2")).toMatchObject({ status: "broken", evidence: { value: "100.00 CAD", asOf: "2026-10-22" } });
    const low = checkThesis(input({ thesis: thesis({ conditions: [below] }), price: { value: 89.5, currency: "CAD", asOf: "2026-10-22" } }), NOW);
    expect(one(low, "p1").status).toBe("broken");
  });
  it("a price exactly 3 trading days old is used; one older is can't tell", () => {
    const at3 = checkThesis(input({ thesis: thesis({ conditions: [below] }), price: { value: 100, currency: "CAD", asOf: "2026-10-20" } }), NOW);
    expect(one(at3, "p1").status).toBe("held");
    // 2026-10-19 (Mon) to Fri 2026-10-23 is 4 trading days.
    const stale = checkThesis(input({ thesis: thesis({ conditions: [below] }), price: { value: 100, currency: "CAD", asOf: "2026-10-19" } }), NOW);
    expect(one(stale, "p1")).toMatchObject({ status: "cant_tell" });
    expect(one(stale, "p1").evidence).toBeUndefined();
    expect(one(stale, "p1").note).toMatch(/3 trading days/);
  });
  it("a weekend does not make Friday's price stale on Monday", () => {
    const monday = new Date("2026-10-26T16:00:00Z");
    expect(one(checkThesis(input({ thesis: thesis({ conditions: [below] }), price: { value: 100, currency: "CAD", asOf: "2026-10-21" } }), monday), "p1").status).toBe("held");
  });
  it("no price, or a price in another currency, is can't tell", () => {
    expect(one(checkThesis(input({ thesis: thesis({ conditions: [below] }), price: null }), NOW), "p1").status).toBe("cant_tell");
    const usd = cond({ id: "p3", kind: "price_below", text: "under 60 USD", price: 60, currency: "USD" });
    const r = checkThesis(input({ thesis: thesis({ conditions: [usd] }) }), NOW);
    expect(one(r, "p3").status).toBe("cant_tell");
    expect(one(r, "p3").note).toMatch(/CAD/);
  });
});

describe("return_below", () => {
  const ret = cond({ id: "r1", kind: "return_below", text: "down more than 10%", pct: -10 });
  it("is computed from the value when the thesis was written (money-weighted), est.", () => {
    const r = checkThesis(input({ thesis: thesis({ conditions: [ret] }) }), NOW);
    expect(one(r, "r1")).toMatchObject({ status: "held", evidence: { value: "20.0% (est.)", asOf: "2026-10-22" } });
    const down = checkThesis(input({ thesis: thesis({ conditions: [ret] }), end: { date: "2026-10-22", valueCad: 850, estimated: false } }), NOW);
    expect(one(down, "r1")).toMatchObject({ status: "broken", evidence: { value: "-15.0% (est.)" } });
  });
  it("with no value found at writtenAt it is can't tell, never a number (Review Focus 2)", () => {
    const r = checkThesis(input({ thesis: thesis({ conditions: [ret] }), start: null }), NOW);
    expect(one(r, "r1").status).toBe("cant_tell");
    expect(one(r, "r1").evidence).toBeUndefined();
    expect(r.playedOut.returnPct).toBeNull();
    expect(r.playedOut.vsSp500Pct).toBeNull();
    expect(r.playedOut.vsTsxPct).toBeNull();
    expect(r.playedOut.reason).toBeTruthy();
  });
  it("a thesis written before stored activity coverage is can't tell (Review Focus 2)", () => {
    for (const coverageStart of ["2026-07-01", null]) {
      const r = checkThesis(input({ thesis: thesis({ conditions: [ret] }), coverageStart }), NOW);
      expect(one(r, "r1").status).toBe("cant_tell");
      expect(r.playedOut.returnPct).toBeNull();
    }
  });
  it("a stale end value is can't tell", () => {
    const r = checkThesis(input({ thesis: thesis({ conditions: [ret] }), end: { date: "2026-10-16", valueCad: 1_200, estimated: false } }), NOW);
    expect(one(r, "r1").status).toBe("cant_tell");
  });
  it("an excluded flow in the period makes the condition can't tell", () => {
    const r = checkThesis(input({ thesis: thesis({ conditions: [ret] }), excluded: [{ date: "2026-08-01", reason: "no purchase date", unitsMoved: true }] }), NOW);
    expect(one(r, "r1").status).toBe("cant_tell");
  });
  it("an activity sync error on an account involved is can't tell (dirty is ignored)", () => {
    const r = checkThesis(input({ thesis: thesis({ conditions: [ret] }), syncError: true }), NOW);
    expect(one(r, "r1").status).toBe("cant_tell");
    expect(one(r, "r1").note).toMatch(/sync/);
    expect(r.playedOut.returnPct).toBeNull();
    expect(r.playedOut.reason).toMatch(/sync/);
  });
});

describe("weight_above", () => {
  const w = cond({ id: "w1", kind: "weight_above", text: "more than 10% of my portfolio", pct: 10 });
  it("uses the summed weight of the portfolio, cash included", () => {
    const r = checkThesis(input({ thesis: thesis({ conditions: [w] }) }), NOW);
    expect(one(r, "w1")).toMatchObject({ status: "held", evidence: { value: "8.5% of your portfolio, cash included (est.)", asOf: "2026-10-22" } });
    expect(one(checkThesis(input({ thesis: thesis({ conditions: [w] }), weight: { pct: 12.25, estimated: false, asOf: "2026-10-22" } }), NOW), "w1").status).toBe("broken");
    expect(one(checkThesis(input({ thesis: thesis({ conditions: [w] }), weight: null }), NOW), "w1").status).toBe("cant_tell");
  });
  it("needs fresh positions, and gives their date as the evidence date (I-1)", () => {
    const at3 = checkThesis(input({ thesis: thesis({ conditions: [w] }), weight: { pct: 5, estimated: false, asOf: "2026-10-20" } }), NOW);
    expect(one(at3, "w1")).toMatchObject({ status: "held", evidence: { asOf: "2026-10-20" } });
    const stale = checkThesis(input({ thesis: thesis({ conditions: [w] }), weight: { pct: 5, estimated: false, asOf: "2026-10-01" } }), NOW);
    expect(one(stale, "w1")).toMatchObject({ status: "cant_tell", note: "latest positions are more than 3 trading days old" });
    expect(one(stale, "w1").evidence).toBeUndefined();
  });
});

describe("fundamental and custom", () => {
  it("fundamental is always can't tell with the pending note; custom is never evaluated", () => {
    const f = cond({ id: "f1", kind: "fundamental", text: "revenue growth stays above 20%", metric: "revenue_growth", threshold: 20 });
    const c = cond({ id: "x1", kind: "custom", text: "management stays" });
    const r = checkThesis(input({ thesis: thesis({ conditions: [f, c] }) }), NOW);
    expect(one(r, "f1")).toEqual({ id: "f1", text: "revenue growth stays above 20%", kind: "fundamental", status: "cant_tell", note: FUNDAMENTAL_PENDING });
    expect(one(r, "x1")).toEqual({ id: "x1", text: "management stays", kind: "custom", status: "cant_tell" });
    expect(FUNDAMENTAL_PENDING).toBe("can't check automatically yet");
  });
});

describe("time frame", () => {
  it("a short time frame past its end date has ended", () => {
    const r = checkThesis(input({ thesis: thesis({ timeFrame: { kind: "short", endDate: "2026-10-01" } }) }), NOW);
    expect(r.timeFrame).toEqual({ label: TIME_FRAME_ENDED, ended: true });
    expect(TIME_FRAME_ENDED).toBe("time frame ended");
  });
  it("a running time frame says how far in it is", () => {
    expect(checkThesis(input(), NOW).timeFrame).toEqual({ label: "4 months into a 3-year thesis", ended: false });
    const short = checkThesis(input({ thesis: thesis({ timeFrame: { kind: "short", endDate: "2027-01-31" } }) }), NOW);
    expect(short.timeFrame).toEqual({ label: "4 months into a time frame ending 2027-01-31", ended: false });
    const fresh = checkThesis(input({ writtenAt: new Date("2026-10-20T12:00:00Z") }), NOW);
    expect(fresh.timeFrame!.label).toBe("less than a month into a 3-year thesis");
  });
  it("no time frame is null", () => {
    expect(checkThesis(input({ thesis: thesis({ timeFrame: null }) }), NOW).timeFrame).toBeNull();
  });
});

describe("news and earnings since the thesis", () => {
  const item = (i: number, over: Partial<ThesisInput["news"][number]> = {}) => ({
    title: `Headline ${i}`, source: "Wire", publishedAt: new Date(Date.UTC(2026, 6, i, 12)), symbols: ["SHOP.TO"], mood: "positive" as const, ...over,
  });
  it("keeps only this ticker's items after writtenAt, newest first, at most 5, tone labelled as the news", () => {
    const news = [
      ...Array.from({ length: 7 }, (_, i) => item(i + 1)),
      item(20, { symbols: ["RY.TO"] }),
      { ...item(0), publishedAt: new Date("2026-05-30T12:00:00Z") },
      item(21, { mood: null }),
    ];
    const r = checkThesis(input({ news }), NOW);
    expect(NEWS_LIMIT).toBe(5);
    expect(r.news).toHaveLength(5);
    expect(r.news.map((n) => n.title)).toEqual(["Headline 21", "Headline 7", "Headline 6", "Headline 5", "Headline 4"]);
    expect(r.news[0]!.tone).toBeNull();
    expect(r.news[1]).toEqual({ title: "Headline 7", source: "Wire", publishedAt: "2026-07-07T12:00:00.000Z", tone: "news tone: positive" });
  });
  it("passes an article's http(s) url through; anything else is left out", () => {
    const news = [
      item(1, { url: "https://example.test/a" }), item(2, { url: "http://example.test/b" }), item(3, { url: "javascript:alert(1)" }),
      item(4, { url: "data:text/html,<b>x</b>" }), item(5, { url: null }),
    ];
    const r = checkThesis(input({ news }), NOW);
    const byTitle = Object.fromEntries(r.news.map((n) => [n.title, n]));
    expect(byTitle["Headline 1"]!.url).toBe("https://example.test/a");
    expect(byTitle["Headline 2"]!.url).toBe("http://example.test/b");
    for (const t of ["Headline 3", "Headline 4", "Headline 5"]) expect("url" in byTitle[t]!, t).toBe(false);
  });
  it("lists earnings report dates since writtenAt only, oldest first", () => {
    // A report on the day the thesis was written may come before it: "since" means after that day.
    const r = checkThesis(input({ earnings: ["2026-08-06", "2026-05-07", "2026-11-05", "2026-08-06", "2026-06-01"] }), NOW);
    expect(r.earnings).toEqual([{ date: "2026-08-06" }]);
  });
});

describe("how it played out", () => {
  it("compares the same flows replayed into the S&P 500 (CAD) and the TSX, with the basis note", () => {
    // Holding: 1000 -> 1200, no flows: 20%. S&P 500: 100 -> 110: 10%. TSX: 100 -> 105: 5%.
    const r = checkThesis(input(), NOW);
    expect(r.playedOut.returnPct).toBeCloseTo(20, 6);
    expect(r.playedOut.vsSp500Pct).toBeCloseTo(10, 6);
    expect(r.playedOut.vsTsxPct).toBeCloseTo(15, 6);
    expect(r.playedOut.notes).toContain(BENCHMARK_BASIS_NOTE);
    expect(BENCHMARK_BASIS_NOTE).toBe("S&P 500 is total return, dividends reinvested; S&P/TSX Composite is a price index, dividends not included. Your holding's dividends are counted.");
    expect(r.playedOut.excluded).toEqual([]);
  });
  it("replays each dated flow after the start into the benchmark", () => {
    // Holding: −1000 at t0, −500 at 2026-09-01, end 1650. S&P: 10 units + 500/120 units, × 110 at the end.
    const sp500 = [{ date: "2026-06-01", closeCad: 100 }, { date: "2026-09-01", closeCad: 120 }, { date: "2026-10-22", closeCad: 110 }];
    const r = checkThesis(input({ flows: [flow({ date: "2026-09-01", amountCad: -500 })], end: { date: "2026-10-22", valueCad: 1_650, estimated: false }, benchmarks: { sp500, tsx: sp500 } }), NOW);
    // −1000 − 500/(1+r)^(92/143) + 1650/(1+r) = 0 gives r ≈ 12.8%.
    const r0 = r.playedOut.returnPct! / 100;
    expect(-1_000 - 500 / (1 + r0) ** (92 / 143) + 1_650 / (1 + r0)).toBeCloseTo(0, 4);
    // Shadow: (10 + 4.1667) × 110 = 1558.33 < 1650: the holding did better.
    expect(r.playedOut.vsSp500Pct!).toBeGreaterThan(0);
  });
  it("a holding sold in full uses the proceeds, and its weight is held at 0% (Review Focus 1)", () => {
    // Start 1000; sold for 1200 on 2026-09-01; nothing left. TSX: 10 units − 1200/125 = 0.4 units × 125 = 50: −1000 + 1250 → 25%.
    const w = cond({ id: "w1", kind: "weight_above", text: "more than 10% of my portfolio", pct: 10 });
    const tsx = [{ date: "2026-06-01", closeCad: 100 }, { date: "2026-09-01", closeCad: 125 }, { date: "2026-10-22", closeCad: 130 }];
    const sp500 = [{ date: "2026-06-01", closeCad: 100 }, { date: "2026-09-01", closeCad: 110 }, { date: "2026-10-22", closeCad: 120 }];
    const r = checkThesis(input({
      thesis: thesis({ conditions: [w] }),
      price: null, weight: { pct: 0, estimated: false, asOf: "2026-10-22" },
      flows: [flow({ date: "2026-09-01", kind: "sell", amountCad: 1_200, native: { amount: 1_200, currency: "CAD" } })],
      end: { date: "2026-09-01", valueCad: 0, estimated: false },
      benchmarks: { sp500, tsx },
    }), NOW);
    expect(one(r, "w1")).toMatchObject({ status: "held", evidence: { value: "0.0% of your portfolio, cash included" } });
    expect(r.playedOut.returnPct).toBeCloseTo(20, 6);
    expect(r.playedOut.endDate).toBe("2026-09-01");
    expect(r.playedOut.vsTsxPct).toBeCloseTo(-5, 6);
    // S&P: 10 units − 1200/110 = −0.909 units: the sale took out more than the shadow was worth.
    expect(r.playedOut.vsSp500Pct).toBeNull();
    expect(r.playedOut.notes).toContain("Your sales took out more than the same money in the S&P 500 would have been worth.");
  });
  it("cash-only exclusions in the period are listed with the exact copy, and the rest is still compared (est.)", () => {
    const r = checkThesis(input({
      excluded: [
        { date: null, reason: "no date", unitsMoved: false }, { date: "2026-08-04", reason: "not converted", unitsMoved: false },
        { date: "2026-05-01", reason: "no amount", unitsMoved: true }, // before the start: inside the start value, not listed
      ],
    }), NOW);
    expect(r.playedOut.excluded).toEqual(["can't compare: no date", "can't compare: currency not converted"]);
    expect(r.playedOut.returnPct).toBeCloseTo(20, 6);
    expect(r.playedOut.estimated).toBe(true);
    expect(r.playedOut.notes.join(" ")).toMatch(/left out/);
  });
  it("shares that moved without a recorded value give no number, with every exclusion listed (C-1)", () => {
    const r = checkThesis(input({
      excluded: [
        { date: null, reason: "no purchase date", unitsMoved: true }, { date: "2026-08-02", reason: "no date", unitsMoved: false },
        { date: "2026-08-03", reason: "no amount", unitsMoved: true }, { date: "2026-08-04", reason: "not converted", unitsMoved: true },
      ],
    }), NOW);
    expect(r.playedOut).toMatchObject({ returnPct: null, vsSp500Pct: null, vsTsxPct: null, reason: SHARES_MOVED_UNVALUED });
    expect(SHARES_MOVED_UNVALUED).toBe("can't compare: shares moved without a recorded value");
    expect(r.playedOut.excluded).toEqual([
      "can't compare: no purchase date", "can't compare: no date", "can't compare: amount not recorded", "can't compare: currency not converted",
    ]);
    expect(EXCLUSION_COPY["no purchase date"]).toBe("can't compare: no purchase date");
  });
  it("probe: an untracked transfer out after a partial sale is never a −60% (C-1)", () => {
    const r = checkThesis(input({
      start: { date: "2026-06-01", valueCad: 10_000, estimated: false },
      flows: [flow({ date: "2026-07-01", kind: "sell", amountCad: 4_000, units: -40, native: { amount: 4_000, currency: "CAD" } })],
      excluded: [{ date: "2026-08-01", reason: "no purchase date", unitsMoved: true }],
      end: { date: "2026-08-01", valueCad: 0, estimated: false }, weight: null,
    }), NOW);
    expect(r.playedOut.returnPct).toBeNull();
    expect(r.playedOut.reason).toBe(SHARES_MOVED_UNVALUED);
  });
  it("probe: a transfer in with no cost is never a +100% (C-1)", () => {
    const r = checkThesis(input({
      end: { date: "2026-10-22", valueCad: 2_000, estimated: false },
      excluded: [{ date: "2026-07-15", reason: "no purchase date", unitsMoved: true }],
    }), NOW);
    expect(r.playedOut.returnPct).toBeNull();
    expect(r.playedOut.reason).toBe(SHARES_MOVED_UNVALUED);
  });
  it("a benchmark without a close for every date gives no comparison for it", () => {
    const r = checkThesis(input({ benchmarks: { sp500: [{ date: "2026-10-22", closeCad: 110 }], tsx: null } }), NOW);
    expect(r.playedOut.returnPct).toBeCloseTo(20, 6);
    expect(r.playedOut.vsSp500Pct).toBeNull();
    expect(r.playedOut.vsTsxPct).toBeNull();
  });
  it("estimated is carried from converted values, flows and benchmark closes", () => {
    expect(checkThesis(input(), NOW).playedOut.estimated).toBe(false);
    expect(checkThesis(input({ start: { date: "2026-06-01", valueCad: 1_000, estimated: true } }), NOW).playedOut.estimated).toBe(true);
    const sp500 = [{ date: "2026-06-01", closeCad: 100, estimated: true }, { date: "2026-10-22", closeCad: 110, estimated: true }];
    expect(checkThesis(input({ benchmarks: { sp500, tsx: null } }), NOW).playedOut.estimated).toBe(true);
  });
  it("more than one listing under the ticker is never combined", () => {
    const w = cond({ id: "w1", kind: "weight_above", text: "more than 10%", pct: 10 });
    const r = checkThesis(input({ thesis: thesis({ conditions: [w] }), multipleListings: true }), NOW);
    expect(one(r, "w1").status).toBe("cant_tell");
    expect(r.playedOut.returnPct).toBeNull();
  });
});

describe("no advice words", () => {
  const BANNED = ["should", "sell", "buy", "recommend", "consider"];
  /** VestLens copy only: the user's own words (condition text, reasons) and news titles/sources are shown verbatim. */
  const USER_KEYS = new Set(["text", "title", "source", "ticker"]);
  const strings = (v: unknown, key = ""): string[] => {
    if (typeof v === "string") return USER_KEYS.has(key) ? [] : [v];
    if (Array.isArray(v)) return v.flatMap((x) => strings(x, key === "excluded" || key === "notes" ? "" : key));
    if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => strings(x, k));
    return [];
  };
  it("appears in no output string across every branch", () => {
    const all = [
      cond({ id: "p1", kind: "price_below", text: "sell if under $90", price: 90, currency: "CAD" }),
      cond({ id: "p2", kind: "price_above", text: "buy more above", price: 60, currency: "USD" }),
      cond({ id: "r1", kind: "return_below", text: "down 10%", pct: -10 }),
      cond({ id: "w1", kind: "weight_above", text: "over 10%", pct: 10 }),
      cond({ id: "f1", kind: "fundamental", text: "growth > 20%" }),
      cond({ id: "x1", kind: "custom", text: "I should reconsider" }),
    ];
    const t = thesis({ conditions: all, timeFrame: { kind: "short", endDate: "2026-09-01" } });
    const cases: ThesisInput[] = [
      input({ thesis: t }),
      input({ thesis: t, price: null, weight: null, start: null, end: null, coverageStart: null }),
      input({ thesis: t, price: { value: 1, currency: "CAD", asOf: "2026-01-02" }, end: { date: "2026-01-02", valueCad: 5, estimated: true } }),
      input({ thesis: t, multipleListings: true }),
      input({ thesis: thesis({ conditions: all }), excluded: [{ date: null, reason: "no purchase date", unitsMoved: true }, { date: "2026-08-02", reason: "no date", unitsMoved: false }, { date: "2026-08-03", reason: "no amount", unitsMoved: true }, { date: "2026-08-04", reason: "not converted", unitsMoved: false }] }),
      input({ thesis: thesis({ conditions: all }), excluded: [{ date: "2026-08-02", reason: "no date", unitsMoved: false }] }),
      input({ thesis: thesis({ conditions: all }), syncError: true, weight: { pct: 1, estimated: false, asOf: "2026-01-02" } }),
      input({ thesis: thesis({ conditions: all, timeFrame: null }), flows: [flow({ kind: "sell", amountCad: 5_000 })], end: { date: "2026-09-01", valueCad: 0, estimated: false }, weight: { pct: 0, estimated: false, asOf: "2026-10-22" } }),
      input({ benchmarks: { sp500: null, tsx: null }, news: [{ title: "Analysts say buy", source: "Wire", publishedAt: new Date("2026-07-01T00:00:00Z"), symbols: ["SHOP.TO"], mood: "strongly_negative" }], earnings: ["2026-08-06"] }),
      input({ start: { date: "2026-06-01", valueCad: 0, estimated: false } }),
    ];
    for (const c of cases) {
      const out = strings(checkThesis(c, NOW));
      expect(out.length).toBeGreaterThan(0);
      for (const s of out) for (const word of BANNED) expect(s.toLowerCase(), s).not.toContain(word);
    }
  });
});
