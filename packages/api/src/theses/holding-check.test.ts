import { describe, expect, it } from "vitest";
import type { HoldingFlow } from "../analytics/shadow-benchmark.js";
import {
  ACTIVITY_NOT_RECORDED, BENCHMARK_BASIS_NOTE, checkHolding, HOLDING_NEWS_DAYS, NEWS_LIMIT, NO_FULL_HISTORY, NO_PURCHASE_RECORDED,
  SHARES_MOVED_UNVALUED, type HoldingInput,
} from "./thesis-check.js";

// Synthetic symbols, dates and amounts only. Friday 2026-10-23, noon in Toronto.
const NOW = new Date("2026-10-23T16:00:00Z");

const flow = (over: Partial<HoldingFlow>): HoldingFlow => ({
  date: "2025-01-02", kind: "buy", amountCad: -1_000, estimated: false, rateDate: null, native: { amount: -1_000, currency: "CAD" }, units: 10, ...over,
});
const series = (from: number, to: number) => [{ date: "2025-01-02", closeCad: from }, { date: "2026-10-22", closeCad: to }];

const input = (over: Partial<HoldingInput> = {}): HoldingInput => ({
  ticker: "SYN.TO",
  multipleListings: false,
  syncError: false,
  weight: { pct: 12.5, estimated: false, asOf: "2026-10-22" },
  flows: [flow({})],
  excluded: [],
  coverageStart: "2024-01-02",
  end: { date: "2026-10-22", valueCad: 1_200, estimated: false },
  benchmarks: { sp500: series(100, 110), tsx: series(100, 105) },
  news: [],
  ...over,
});

describe("checkHolding: since your first recorded purchase", () => {
  it("copy says first recorded purchase, never a first purchase or first bought it can't establish", () => {
    expect(NO_FULL_HISTORY).toBe("stored activity doesn't cover this holding's full history");
    const notes = checkHolding(input(), NOW).sinceFirstBought.notes;
    expect(notes[0]).toBe("Money-weighted from your first recorded purchase: each purchase, sale and dividend (before withholding) counts from its own date.");
    const all = [...notes, NO_FULL_HISTORY, NO_PURCHASE_RECORDED].join(" ").replace(/first recorded purchase/g, "");
    expect(all).not.toMatch(/first (bought|purchase)/);
  });

  it("the start is the earliest acquiring flow, whatever order the flows come in", () => {
    const s = checkHolding(input({ flows: [flow({ date: "2025-06-02", amountCad: -500, units: 5 }), flow({})], end: { date: "2026-10-22", valueCad: 1_800, estimated: false } }), NOW).sinceFirstBought;
    expect(s.startDate).toBe("2025-01-02");
  });

  it("a transfer-in as the first recorded purchase counts at its reported price, and says so", () => {
    const s = checkHolding(input({ flows: [flow({ kind: "transfer_in" })] }), NOW).sinceFirstBought;
    expect(s.returnPct).toBeCloseTo(20, 6);
    expect(s.notes).toContain("Your first recorded purchase is a transfer-in valued at the reported price.");
    expect(checkHolding(input(), NOW).sinceFirstBought.notes.some((n) => n.includes("transfer-in"))).toBe(false);
  });

  it("a full exit and re-entry gives the one money-weighted return (pinned against an independent bisection)", () => {
    const flows = [
      flow({}), flow({ date: "2025-07-02", kind: "sell", amountCad: 1_500, units: -10 }), flow({ date: "2026-01-05", amountCad: -2_000, units: 20 }),
    ];
    const s = checkHolding(input({ flows, end: { date: "2026-10-22", valueCad: 2_100, estimated: false } }), NOW).sinceFirstBought;
    // Independent: bisection on the period-rate NPV with t as a fraction of the span (the solver's convention).
    const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
    const span = day("2026-10-22") - day("2025-01-02");
    const terms = [[0, -1_000], [(day("2025-07-02") - day("2025-01-02")) / span, 1_500], [(day("2026-01-05") - day("2025-01-02")) / span, -2_000], [1, 2_100]] as const;
    const npv = (r: number) => terms.reduce((a, [t, v]) => a + v / (1 + r) ** t, 0);
    let lo = -0.5, hi = 5;
    for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (Math.sign(npv(mid)) === Math.sign(npv(lo))) lo = mid; else hi = mid; }
    expect(s.returnPct).not.toBeNull();
    expect(s.returnPct!).toBeCloseTo(lo * 100, 2);
  });

  it("is money-weighted from the first purchase (start 0) against the same money in the S&P 500 and TSX", () => {
    const c = checkHolding(input(), NOW);
    const s = c.sinceFirstBought;
    expect(s.startDate).toBe("2025-01-02");
    expect(s.endDate).toBe("2026-10-22");
    expect(s.returnPct).toBeCloseTo(20, 6);
    expect(s.vsSp500Pct).toBeCloseTo(10, 6);
    expect(s.vsTsxPct).toBeCloseTo(15, 6);
    expect(s.notes).toContain(BENCHMARK_BASIS_NOTE);
  });

  it("counts later purchases, sales and dividends on their own dates", () => {
    const c = checkHolding(input({
      flows: [flow({}), flow({ date: "2025-06-02", amountCad: -500, units: 5 }), flow({ date: "2026-03-02", kind: "dividend", amountCad: 20, units: 0 })],
      end: { date: "2026-10-22", valueCad: 1_800, estimated: false },
    }), NOW);
    expect(c.sinceFirstBought.returnPct).not.toBeNull();
    expect(c.sinceFirstBought.returnPct!).toBeGreaterThan(0);
  });

  it("sold in full: compares up to the sale with the proceeds", () => {
    const c = checkHolding(input({
      flows: [flow({}), flow({ date: "2026-01-05", kind: "sell", amountCad: 1_300, units: -10 })],
      end: { date: "2026-01-05", valueCad: 0, estimated: false }, weight: { pct: 0, estimated: false, asOf: "2026-10-22" },
      benchmarks: { sp500: [{ date: "2025-01-02", closeCad: 100 }, { date: "2026-01-05", closeCad: 120 }], tsx: [{ date: "2025-01-02", closeCad: 100 }, { date: "2026-01-05", closeCad: 100 }] },
    }), NOW);
    expect(c.sinceFirstBought.returnPct).toBeCloseTo(30, 6);
    expect(c.sinceFirstBought.endDate).toBe("2026-01-05");
  });

  it("can't tell when stored activity starts after the first purchase", () => {
    const s = checkHolding(input({ coverageStart: "2025-03-01" }), NOW).sinceFirstBought;
    expect(s.returnPct).toBeNull();
    expect(s.reason).toBe(`can't tell: ${NO_FULL_HISTORY}`);
    expect(checkHolding(input({ coverageStart: null }), NOW).sinceFirstBought.reason).toBe(`can't tell: ${NO_FULL_HISTORY}`);
  });

  it("can't tell when the first recorded activity is a sale or dividend (the purchase predates stored activity)", () => {
    for (const first of [flow({ date: "2024-06-03", kind: "sell", amountCad: 400, units: -4 }), flow({ date: "2024-06-03", kind: "dividend", amountCad: 4, units: 0 })]) {
      const s = checkHolding(input({ flows: [first, flow({})] }), NOW).sinceFirstBought;
      expect(s.returnPct).toBeNull();
      expect(s.reason).toBe(`can't tell: ${NO_FULL_HISTORY}`);
    }
  });

  it("can't tell with no recorded purchase", () => {
    expect(checkHolding(input({ flows: [] }), NOW).sinceFirstBought.reason).toBe(`can't tell: ${NO_PURCHASE_RECORDED}`);
  });

  it("an unvalued transfer-in (shares moved without a value) is can't tell, wherever it falls", () => {
    for (const date of [null, "2024-12-01", "2025-08-01"]) {
      const s = checkHolding(input({ excluded: [{ date, reason: "no purchase date", unitsMoved: true }] }), NOW).sinceFirstBought;
      expect(s.returnPct, String(date)).toBeNull();
      expect(s.reason).toBe(SHARES_MOVED_UNVALUED);
    }
  });

  it("a dividend that can't be valued is left out and listed, not a can't tell", () => {
    const s = checkHolding(input({ excluded: [{ date: "2025-08-01", reason: "not converted", unitsMoved: false }] }), NOW).sinceFirstBought;
    expect(s.returnPct).not.toBeNull();
    expect(s.excluded).toEqual(["can't compare: currency not converted"]);
    expect(s.estimated).toBe(true);
  });

  it("applies the same gates: sync error, stale end price, unreconciled units, more than one listing", () => {
    expect(checkHolding(input({ syncError: true }), NOW).sinceFirstBought.reason).toMatch(/^can't tell: activity sync/);
    expect(checkHolding(input({ end: { date: "2026-10-16", valueCad: 1_200, estimated: false } }), NOW).sinceFirstBought.reason).toMatch(/^can't tell: latest price is more than 3 trading days old/);
    expect(checkHolding(input({ end: null, endNote: ACTIVITY_NOT_RECORDED }), NOW).sinceFirstBought.reason).toBe(`can't tell: ${ACTIVITY_NOT_RECORDED}`);
    expect(checkHolding(input({ multipleListings: true }), NOW).sinceFirstBought.reason).toMatch(/^can't tell: held as more than one listing/);
  });

  it("labels USD conversions est. with the latest Bank of Canada rate date", () => {
    const s = checkHolding(input({
      flows: [flow({ estimated: true, rateDate: "2024-12-31", native: { amount: -740, currency: "USD" } })],
      end: { date: "2026-10-22", valueCad: 1_200, estimated: true, rateDate: "2026-10-22" },
      benchmarks: { sp500: [{ date: "2025-01-02", closeCad: 100, estimated: true, rateDate: "2025-01-02" }, { date: "2026-10-22", closeCad: 110, estimated: true, rateDate: "2026-10-21" }], tsx: series(100, 105) },
    }), NOW).sinceFirstBought;
    expect(s.estimated).toBe(true);
    expect(s.notes).toContain("USD amounts converted at the Bank of Canada rate of each date (est.); latest rate 2026-10-22.");
  });

  it("no BoC note when nothing was converted (TSX only)", () => {
    const s = checkHolding(input({ benchmarks: { sp500: null, tsx: series(100, 105) } }), NOW).sinceFirstBought;
    expect(s.notes.some((n) => n.includes("Bank of Canada"))).toBe(false);
  });
});

describe("checkHolding: weight and news", () => {
  it("with a thesis, news is since it was written, or the last 30 days when it was written earlier", () => {
    const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
    const news = [5, 12, 40].map((d) => ({ title: `D${d}`, source: "Wire", publishedAt: at(d), symbols: ["SYN.TO"], mood: null }));
    expect(checkHolding(input({ news }), NOW, { newsSince: at(10) }).news.map((n) => n.title)).toEqual(["D5"]);
    expect(checkHolding(input({ news }), NOW, { newsSince: at(200) }).news.map((n) => n.title)).toEqual(["D5", "D12"]);
  });

  it("weight shows when fresh; stale or unknown is null with a reason", () => {
    expect(checkHolding(input(), NOW).weight).toEqual({ pct: 12.5, estimated: false, asOf: "2026-10-22" });
    const stale = checkHolding(input({ weight: { pct: 12.5, estimated: false, asOf: "2026-10-14" } }), NOW);
    expect(stale.weight).toBeNull();
    expect(stale.weightNote).toMatch(/more than 3 trading days old/);
    expect(checkHolding(input({ weight: null }), NOW).weightNote).toBe("portfolio weight not available");
    expect(checkHolding(input({ multipleListings: true }), NOW).weight).toBeNull();
  });

  it("news: the last 30 days, this ticker, newest first, at most 5, https links only", () => {
    const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
    const news = [
      ...Array.from({ length: 7 }, (_, i) => ({ title: `T${i}`, source: "Wire", publishedAt: at(i + 1), symbols: ["SYN.TO"], mood: null, url: i === 0 ? "https://example.test/0" : i === 1 ? "javascript:x" : null })),
      { title: "Old", source: "Wire", publishedAt: at(HOLDING_NEWS_DAYS + 1), symbols: ["SYN.TO"], mood: null },
      { title: "Other", source: "Wire", publishedAt: at(1), symbols: ["ZZZ"], mood: null },
    ];
    const c = checkHolding(input({ news }), NOW);
    expect(c.news).toHaveLength(NEWS_LIMIT);
    expect(c.news.map((n) => n.title)).toEqual(["T0", "T1", "T2", "T3", "T4"]);
    expect(c.news[0]!.url).toBe("https://example.test/0");
    expect(c.news[1]!.url).toBeUndefined();
  });
});

describe("checkHolding: no advice words", () => {
  const BANNED = ["should", "sell", "buy", "recommend", "consider"];
  const USER_KEYS = new Set(["title", "source", "ticker"]);
  const strings = (v: unknown, key = ""): string[] => {
    if (typeof v === "string") return USER_KEYS.has(key) ? [] : [v];
    if (Array.isArray(v)) return v.flatMap((x) => strings(x, key === "excluded" || key === "notes" ? "" : key));
    if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => strings(x, k));
    return [];
  };
  it("appears in no output string across every branch", () => {
    const cases = [
      input(), input({ coverageStart: "2025-03-01" }), input({ flows: [] }), input({ syncError: true }), input({ multipleListings: true }),
      input({ excluded: [{ date: null, reason: "no purchase date", unitsMoved: true }] }), input({ end: null }), input({ end: null, endNote: ACTIVITY_NOT_RECORDED }),
      input({ weight: null }), input({ benchmarks: { sp500: null, tsx: null } }),
      input({ excluded: [{ date: "2025-08-01", reason: "no amount", unitsMoved: false }] }),
      input({ flows: [flow({ estimated: true, rateDate: "2024-12-31" })] }),
    ];
    for (const c of cases) {
      const out = strings(checkHolding(c, NOW));
      expect(out.length).toBeGreaterThan(0);
      for (const s of out) for (const word of BANNED) expect(s.toLowerCase(), s).not.toContain(word);
    }
  });
});
