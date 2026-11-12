import { describe, expect, it } from "vitest";

import { homeConverter } from "../fx/home-currency.js";
import type { StoredActivity } from "../history/stored-activity.js";
import type { SecurityHistory } from "../market-data/types.js";
import type { HoldingFlow } from "../analytics/shadow-benchmark.js";
import {
  ACTIVITY_NOT_LOADED, ACTIVITY_NOT_RECORDED, activityStaleNote, bocNote, NO_FULL_HISTORY, NO_PURCHASE_RECORDED, shadowExhaustedNote, UNITS_NOT_REPORTED,
  type HoldingCheck,
} from "../theses/thesis-check.js";
import {
  afterSoldSection, boughtSymbols, buysBeforeSales, callsSection, cantTellCodes, MAX_REPORT_SYMBOLS, MIN_ESTIMATE_ROWS, REASONS, reasonCode, TIMED_OUT, tradingCostSection,
  type CallOutcome, type HistoryEntry,
} from "./report-card.js";

// Synthetic symbols, dates, prices and amounts only. Friday 2026-10-23 in Toronto; a flat 1.35 Bank of Canada rate.
const TODAY = "2026-10-23";
const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
const FX = homeConverter(days("2024-12-20", TODAY).map((date) => ({ date, close: 1.35 })), TODAY);

const row = (over: Partial<StoredActivity>): StoredActivity => ({
  snapTradeAccountId: "SYN-ACCOUNT", dedupeKey: `k-${Math.random()}`, type: "BUY", symbol: "SYN", securityCurrency: "CAD", isOption: false,
  units: 10, price: 10, amount: -100, fee: null, fxRate: null, currency: "CAD", tradeDate: "2025-01-02", settlementDate: null, description: null, ...over,
});

type PlayedOut = HoldingCheck["sinceFirstBought"];
const played = (over: Partial<PlayedOut>): PlayedOut => ({
  returnPct: 10, vsSp500Pct: 0, vsTsxPct: 0, estimated: false, excluded: [], startDate: "2025-01-02", endDate: "2026-10-22", notes: [], ...over,
});
const none = (reason: string, notes: string[] = []): PlayedOut =>
  ({ returnPct: null, vsSp500Pct: null, vsTsxPct: null, estimated: false, excluded: [], reason, startDate: null, endDate: null, notes });

describe("calls against the market", () => {
  const outcomes: CallOutcome[] = [
    { symbol: "AAA", check: played({ returnPct: 25, vsSp500Pct: 12.5, vsTsxPct: 9 }) },
    { symbol: "BBB", check: played({ returnPct: -4, vsSp500Pct: -15, vsTsxPct: -11, estimated: true }) },
    { symbol: "CCC", check: played({ returnPct: 8, vsSp500Pct: 2 }) },
    { symbol: "DDD", check: none("can't tell: stored activity doesn't cover this holding's full history") },
    { symbol: "EEE", check: none("can't tell: stored activity doesn't cover this holding's full history") },
    // A return, but no S&P 500 comparison: can't tell, with the engine's own note as the reason.
    { symbol: "FFF", check: played({ returnPct: 5, vsSp500Pct: null, notes: ["Benchmarks are price indices.", "No S&P 500 close for every date in the period, so no comparison with it."] }) },
    { symbol: "GGG", failed: true },
  ];

  it("counts ahead, behind and can't tell (grouped by reason)", () => {
    const c = callsSection(outcomes);
    expect(c.checked).toBe(7);
    expect(c.summary).toMatchObject({ compared: 3, ahead: 2, behind: 1, even: 0 });
    expect(c.cantTell.count).toBe(4);
    expect(c.cantTell.reasons).toEqual([
      { reason: "stored activity doesn't cover this holding's full history", count: 2, symbols: ["DDD", "EEE"] },
      { reason: "No S&P 500 close for every date in the period, so no comparison with it.", count: 1, symbols: ["FFF"] },
      { reason: REASONS.readFailed, count: 1, symbols: ["GGG"] },
    ]);
  });

  it("names the best and the worst by the S&P 500 comparison, and lists best first", () => {
    const c = callsSection(outcomes);
    expect(c.summary.best).toMatchObject({ symbol: "AAA", vsSp500Pct: 12.5, returnPct: 25, vsTsxPct: 9, startDate: "2025-01-02" });
    expect(c.summary.worst).toMatchObject({ symbol: "BBB", vsSp500Pct: -15, estimated: true });
    expect(c.items.map((i) => i.symbol)).toEqual(["AAA", "CCC", "BBB"]);
  });

  it("sales worth more than the same money in the S&P 500: ahead without a figure, only when every buy came first", () => {
    const exhausted = played({ returnPct: 50, vsSp500Pct: null, notes: [shadowExhaustedNote("S&P 500")] });
    const c = callsSection([
      { symbol: "WIN", check: exhausted, buysBeforeSales: true },
      { symbol: "MIX", check: exhausted, buysBeforeSales: false },
      { symbol: "BBB", check: played({ vsSp500Pct: -3 }) },
    ]);
    expect(c.summary).toMatchObject({ compared: 2, ahead: 1, behind: 1 });
    expect(c.summary.aheadUnmeasured).toEqual([{ symbol: "WIN", returnPct: 50, startDate: "2025-01-02", endDate: "2026-10-22", estimated: false, rateDate: null }]);
    expect(c.summary.best!.symbol).toBe("BBB");
    expect(c.cantTell.reasons).toEqual([{ reason: shadowExhaustedNote("S&P 500"), count: 1, symbols: ["MIX"] }]);
  });

  it("buysBeforeSales: no purchase after the first sale or dividend", () => {
    const f = (date: string, amountCad: number): HoldingFlow => ({ date, kind: amountCad < 0 ? "buy" : "sell", amountCad, estimated: false, rateDate: null, native: { amount: amountCad, currency: "CAD" }, units: 1 });
    expect(buysBeforeSales([f("2025-01-02", -100), f("2025-02-03", -50), f("2026-01-05", 200)])).toBe(true);
    expect(buysBeforeSales([f("2025-01-02", -100), f("2025-06-02", 5), f("2026-01-05", -50)])).toBe(false);
    expect(buysBeforeSales([f("2025-01-02", -100)])).toBe(true);
  });

  it("carries the holding check's Bank of Canada rate date, and counts a holding not read in time", () => {
    const c = callsSection([
      { symbol: "USA", check: played({ vsSp500Pct: 4, estimated: true, notes: ["Money-weighted.", bocNote("2026-10-22")] }) },
      { symbol: "SLO", timedOut: true },
    ]);
    expect(c.items[0]).toMatchObject({ symbol: "USA", estimated: true, rateDate: "2026-10-22" });
    expect(c.cantTell.reasons).toEqual([{ reason: REASONS.timedOut, count: 1, symbols: ["SLO"] }]);
    expect(callsSection([{ symbol: "CAD", check: played({}) }]).items[0]!.rateDate).toBeNull();
  });

  it("no comparison at all: no best or worst", () => {
    const c = callsSection([{ symbol: "DDD", check: none("can't tell: no purchase of this holding is recorded") }]);
    expect(c.summary).toMatchObject({ compared: 0, ahead: 0, behind: 0, best: null, worst: null });
    expect(c.cantTell.reasons[0]!.reason).toBe("no purchase of this holding is recorded");
  });

  it("caps the work at MAX_REPORT_SYMBOLS, most recent purchases first, and counts the rest as can't tell", () => {
    expect(MAX_REPORT_SYMBOLS).toBe(60);
    const rows: StoredActivity[] = [];
    for (let i = 0; i < 62; i++) {
      const day = new Date(Date.parse("2025-01-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
      rows.push(row({ symbol: `S${String(i).padStart(2, "0")}`, tradeDate: day }));
    }
    rows.push(row({ type: "SELL", symbol: "SOLDONLY", units: -1, amount: 10 }), row({ symbol: "OPT", isOption: true }), row({ symbol: null }));
    const { symbols, overCap } = boughtSymbols(rows);
    expect(symbols).toHaveLength(60);
    expect(symbols[0]).toBe("S61");
    expect(overCap).toEqual(["S00", "S01"]);
    expect(symbols).not.toContain("SOLDONLY");
    expect(symbols).not.toContain("OPT");
    const c = callsSection([], overCap);
    expect(c.cantTell).toEqual({ count: 2, reasons: [{ reason: REASONS.overCap, count: 2, symbols: ["S00", "S01"] }] });
  });
});

const history = (points: Array<[string, number]>, splits: SecurityHistory["splits"] = []): SecurityHistory =>
  ({ points: points.map(([date, close]) => ({ date, close })), splits });

describe("after you sold", () => {
  const sell = (over: Partial<StoredActivity>) => row({ type: "SELL", tradeDate: "2026-01-05", ...over });

  it("a sale followed by a rise and one followed by a fall, with kept vs sold in CAD", () => {
    const rows = [
      sell({ symbol: "UPP", units: -10, price: 50, amount: 500 }),
      sell({ symbol: "DWN", units: -4, price: 20, amount: 80, tradeDate: "2026-02-02" }),
    ];
    const histories = new Map([
      ["UPP", history([["2026-01-05", 50], ["2026-10-22", 60]])],
      ["DWN", history([["2026-02-02", 20], ["2026-10-22", 15]])],
    ]);
    const s = afterSoldSection(rows, histories, FX, TODAY);
    expect(s.summary).toMatchObject({ sells: 2, rose: 1, fell: 1, unchanged: 0, keptVsSoldCad: 80, estimated: false, notConverted: 0 });
    const up = s.items.find((i) => i.symbol === "UPP")!;
    expect(up).toMatchObject({ date: "2026-01-05", units: 10, salePrice: 50, currency: "CAD", latestClose: 60, latestCloseDate: "2026-10-22", changePct: 20 });
    expect(up.keptVsSold).toMatchObject({ native: { amount: 100, currency: "CAD" }, cad: 100, estimated: false, rateDate: null });
    expect(s.items.find((i) => i.symbol === "DWN")!.keptVsSold.cad).toBe(-20);
    // Newest sale first.
    expect(s.items.map((i) => i.symbol)).toEqual(["DWN", "UPP"]);
  });

  it("a US-dollar sale: kept vs sold in USD, converted to CAD at the Bank of Canada rate (est.)", () => {
    // 10 shares at US$100 for CAD 1,350: the price is in the security's currency.
    const rows = [sell({ symbol: "USA", securityCurrency: "USD", currency: "CAD", units: -10, price: 100, amount: 1350 })];
    const s = afterSoldSection(rows, new Map([["USA", history([["2026-01-05", 100], ["2026-10-22", 110]])]]), FX, TODAY);
    expect(s.items[0]).toMatchObject({ salePrice: 100, currency: "USD", changePct: 10 });
    expect(s.items[0]!.keptVsSold).toEqual({ native: { amount: 100, currency: "USD" }, cad: 135, estimated: true, rateDate: "2026-10-22" });
    expect(s.summary).toMatchObject({ keptVsSoldCad: 135, estimated: true, rateDate: "2026-10-22" });
  });

  it("a US-dollar sale whose price is reported in the account's CAD is converted to USD first (est.)", () => {
    const rows = [sell({ symbol: "USA", securityCurrency: "USD", currency: "CAD", units: -10, price: 135, amount: 1350 })];
    const s = afterSoldSection(rows, new Map([["USA", history([["2026-01-05", 100], ["2026-10-22", 110]])]]), FX, TODAY);
    expect(s.items[0]!.salePrice).toBeCloseTo(100, 6);
    expect(s.items[0]).toMatchObject({ estimated: true, priceRateDate: "2026-01-05", recordedPrice: { amount: 135, currency: "CAD" } });
    expect(s.items[0]!.keptVsSold.cad).toBeCloseTo(135, 2);
  });

  it("a split after the sale: the shares kept would have multiplied (closes are split-adjusted)", () => {
    // Sold at 100; a 2-for-1 split on 2026-04-01; adjusted closes 50 at the sale and 60 now: the kept share is worth 120.
    const rows = [sell({ symbol: "SPL", units: -10, price: 100, amount: 1000 })];
    const s = afterSoldSection(rows, new Map([["SPL", history([["2026-01-05", 50], ["2026-10-22", 60]], [{ date: "2026-04-01", ratio: 2 }])]]), FX, TODAY);
    expect(s.items[0]).toMatchObject({ changePct: 20 });
    expect(s.items[0]!.keptVsSold.cad).toBe(200);
  });

  it("a split after the sale: the row carries the close on the sale's share basis beside the raw close (B8)", () => {
    const rows = [sell({ symbol: "SPL", units: -10, price: 200, amount: 2000 })];
    const s = afterSoldSection(rows, new Map([["SPL", history([["2026-01-05", 100], ["2026-10-22", 105]], [{ date: "2026-04-01", ratio: 2 }])]]), FX, TODAY);
    expect(s.items[0]).toMatchObject({ latestClose: 105, latestCloseSplitAdjusted: 210, changePct: 5 });
    const plain = afterSoldSection([sell({ symbol: "UPP", units: -10, price: 50, amount: 500 })], new Map([["UPP", history([["2026-01-05", 50], ["2026-10-22", 60]])]]), FX, TODAY);
    expect(plain.items[0]).not.toHaveProperty("latestCloseSplitAdjusted");
  });

  it("the native 'includes' total counts only the sales converted into the CAD total (A12)", () => {
    // Two US$100 gains; the Bank of Canada has no recent rate for the second's latest close.
    const stale = homeConverter(days("2024-12-20", "2026-10-01").map((date) => ({ date, close: 1.35 })), TODAY);
    const rows = [
      sell({ symbol: "USA", securityCurrency: "USD", currency: "USD", units: -10, price: 100, amount: 1000 }),
      sell({ symbol: "USB", securityCurrency: "USD", currency: "USD", units: -10, price: 100, amount: 1000 }),
    ];
    const histories = new Map([
      ["USA", history([["2026-01-05", 100], ["2026-10-05", 110]])],
      ["USB", history([["2026-01-05", 100], ["2026-10-22", 110]])],
    ]);
    const s = afterSoldSection(rows, histories, stale, "2026-10-08");
    const converted = s.items.filter((i) => i.keptVsSold.cad !== null);
    expect(converted.length).toBe(1);
    expect(s.summary.native).toEqual([{ currency: "USD", amount: converted[0]!.keptVsSold.native.amount }]);
  });

  it("no amount recorded: the currency reading whose sale-day close agrees within 15% is used", () => {
    const h = new Map([["USA", history([["2026-01-05", 100], ["2026-10-22", 110]])]]);
    const one = (price: number) => afterSoldSection([sell({ symbol: "USA", securityCurrency: "USD", currency: "CAD", units: -10, price, amount: null })], h, FX, TODAY);
    // CAD 135 reads as US$100 (the close); US$100 reads as itself; CAD 120 reads as US$88.89 (within 15%; US$120 is not).
    expect(one(135).items[0]).toMatchObject({ currency: "USD", estimated: true, recordedPrice: { amount: 135, currency: "CAD" } });
    expect(one(135).items[0]!.salePrice).toBeCloseTo(100, 6);
    expect(one(100).items[0]).toMatchObject({ salePrice: 100, estimated: false, recordedPrice: null });
    expect(one(120).items[0]!.salePrice).toBeCloseTo(120 / 1.35, 6);
    // CAD or US$ 200: neither reading is near the close of 100.
    expect(one(200).items).toEqual([]);
    expect(one(200).cantTell.reasons).toEqual([{ reason: REASONS.saleCurrencyUnclear, count: 1, symbols: ["USA"] }]);
  });

  it("refuses a sale price 1.35 times away from that day's close (the local 20% band)", () => {
    const s = afterSoldSection([sell({ symbol: "MIS", units: -10, price: 100, amount: 1000 })], new Map([["MIS", history([["2026-01-05", 135], ["2026-10-22", 140]])]]), FX, TODAY);
    expect(s.items).toEqual([]);
    expect(s.cantTell.reasons).toEqual([{ reason: REASONS.priceMismatch, count: 1, symbols: ["MIS"] }]);
  });

  it("counts a history not read in time, and sales over the cap as sold most recently", () => {
    const s = afterSoldSection([sell({ symbol: "SLO" }), sell({ symbol: "CAP" })], new Map<string, HistoryEntry>([["SLO", TIMED_OUT]]), FX, TODAY, new Set(["CAP"]));
    expect(s.cantTell.reasons).toEqual([
      { reason: REASONS.timedOut, count: 1, symbols: ["SLO"] },
      { reason: REASONS.overCapSold, count: 1, symbols: ["CAP"] },
    ]);
    expect(REASONS.overCapSold).toContain("sold most recently");
  });

  it("skips and counts sales it can't value, with the reason", () => {
    const rows = [
      sell({ symbol: "NOH" }),
      sell({ symbol: "NOS" }),
      sell({ symbol: "OLD" }),
      sell({ symbol: "ODD", price: 10 }),
      sell({ symbol: "NOU", units: null }),
    ];
    const histories = new Map<string, HistoryEntry>([
      ["NOH", null],
      ["NOS", history([["2026-01-05", 10], ["2026-10-22", 11]], null)],
      ["OLD", history([["2026-01-05", 10], ["2026-09-01", 11]])],
      ["ODD", history([["2026-01-05", 40], ["2026-10-22", 41]])],
    ]);
    const s = afterSoldSection(rows, histories, FX, TODAY);
    expect(s.summary.sells).toBe(0);
    expect(s.summary.keptVsSoldCad).toBeNull();
    expect(s.cantTell.count).toBe(5);
    const reasons = Object.fromEntries(s.cantTell.reasons.map((r) => [r.reason, r.symbols]));
    expect(reasons[REASONS.noHistory]).toEqual(["NOH"]);
    expect(reasons[REASONS.noSplits]).toEqual(["NOS"]);
    expect(reasons[REASONS.staleClose]).toEqual(["OLD"]);
    expect(reasons[REASONS.priceMismatch]).toEqual(["ODD"]);
    expect(reasons[REASONS.saleNotRecorded]).toEqual(["NOU"]);
  });
});

describe("what trading cost you", () => {
  // Prices in the account's CAD, as stored (the norm); the security's own USD close is 100 every day.
  const usd = (over: Partial<StoredActivity>) => row({ symbol: "USA", securityCurrency: "USD", currency: "CAD", units: 10, price: 136.5, tradeDate: "2026-01-05", ...over });
  const closes = new Map<string, HistoryEntry>([["USA", history(days("2024-12-20", TODAY).map((d) => [d, 100] as [string, number]))]]);
  const buys = (n: number, over: Partial<StoredActivity> = {}) => Array.from({ length: n }, () => usd({ type: "BUY", amount: -1365, ...over }));

  it("the headline fact is the CAD value converted; the cost estimate compares each trade with that day's close at the BoC rate", () => {
    // Each buy pays 1,365 for 10 × US$100 × 1.35 = 1,350 (+15); each sale receives 1,335 (+15).
    const rows = [...buys(10), ...Array.from({ length: 10 }, () => usd({ type: "SELL", units: -10, price: 133.5, amount: 1335, tradeDate: "2026-02-02" }))];
    const c = tradingCostSection(rows, FX, closes).conversion;
    expect(c).toMatchObject({ rows: 20, convertedCad: 27_000, estimated: false, rateDate: null, native: [] });
    expect(c.estimate).toMatchObject({ rows: 20, minRows: MIN_ESTIMATE_ROWS, costCad: 300, estimated: true, rateDates: { first: "2026-01-05", last: "2026-02-02" } });
    expect(c.estimate.sharePct).toBeCloseTo(300 / 27_000 * 100, 6);
    expect(c).not.toHaveProperty("bySymbol");
  });

  it("works the cost net of the fee", () => {
    expect(tradingCostSection(buys(20, { amount: -1366, fee: 1 }), FX, closes).conversion.estimate.costCad).toBe(300);
  });

  it("fewer than 20 usable trades: the value, but no cost estimate", () => {
    const c = tradingCostSection(buys(19), FX, closes).conversion;
    expect(c).toMatchObject({ rows: 19, convertedCad: 25_935 });
    expect(c.estimate).toMatchObject({ rows: 19, costCad: null, sharePct: null });
  });

  it("counts trades the estimate can't use, with accurate reasons", () => {
    const sparse = new Map<string, HistoryEntry>([["GAP", history([["2026-01-01", 100], ["2026-10-22", 100]])], ["SLO", TIMED_OUT]]);
    const rows = [
      ...buys(20),
      usd({ type: "BUY", amount: -1600, symbol: "BAD" }), // 1,600 vs 1,350 at that day's close: 18.5% off
      usd({ type: "BUY", symbol: "GAP", amount: -1365 }), // the nearest close is 4 days before
      usd({ type: "BUY", symbol: "NOH", amount: -1365 }),
      usd({ type: "BUY", symbol: "SLO", amount: -1365 }),
      usd({ type: "BUY", symbol: "NOU", amount: -1365, units: null }),
    ];
    const c = tradingCostSection(rows, FX, new Map([...closes, ["BAD", closes.get("USA")!], ...sparse])).conversion;
    expect(c.rows).toBe(25);
    expect(c.estimate).toMatchObject({ rows: 20, costCad: 300 });
    expect(Object.fromEntries(c.estimate.cantTell.reasons.map((r) => [r.reason, r.symbols]))).toEqual({
      [REASONS.gapOff]: ["BAD"], [REASONS.noCloseNearTrade]: ["GAP"], [REASONS.noHistory]: ["NOH"], [REASONS.timedOut]: ["SLO"], [REASONS.unitsNotRecorded]: ["NOU"],
    });
  });

  it("a converted trade with no amount isn't counted in the value: couldn't tell", () => {
    const c = tradingCostSection([usd({ type: "BUY", amount: null })], FX, closes).conversion;
    expect(c.rows).toBe(0);
    expect(c.cantTell).toEqual({ count: 1, reasons: [{ reason: REASONS.tradeNotRecorded, count: 1, symbols: ["USA"] }] });
  });

  it("a USD account's amount converts to CAD at the Bank of Canada rate (est.), native kept", () => {
    const c = tradingCostSection([row({ symbol: "CDN", securityCurrency: "CAD", currency: "USD", amount: -100 })], FX).conversion;
    expect(c).toMatchObject({ rows: 1, convertedCad: 135, estimated: true, rateDate: "2025-01-02", native: [{ currency: "USD", amount: 100 }] });
  });

  it("no converted trades: zero value and no estimate", () => {
    const c = tradingCostSection([row({})], FX).conversion;
    expect(c).toMatchObject({ rows: 0, convertedCad: 0, cantTell: { count: 0 } });
    expect(c.estimate).toMatchObject({ rows: 0, costCad: null });
  });

  it("fees: FEE rows and non-zero fee fields summed in CAD, US dollars at the Bank of Canada rate (est.)", () => {
    const rows = [
      row({ type: "FEE", symbol: null, units: null, price: null, amount: -5, tradeDate: "2026-03-02" }),
      row({ type: "FEE", symbol: null, units: null, price: null, amount: -2, currency: "USD", tradeDate: "2026-03-02" }),
      row({ type: "BUY", fee: 1 }),
      row({ type: "SELL", units: -10, amount: 100, fee: 0 }),
    ];
    const f = tradingCostSection(rows, FX).fees;
    expect(f).toMatchObject({ rows: 3, totalCad: 8.7, estimated: true, rateDate: "2026-03-02", native: [{ currency: "USD", amount: 2 }] });
    expect(f.cantTell.count).toBe(0);
  });

  it("fees: no fees recorded is zero, not an estimate", () => {
    expect(tradingCostSection([row({})], FX).fees).toMatchObject({ rows: 0, totalCad: 0, estimated: false, rateDate: null });
  });
});

describe("reason codes (for the log)", () => {
  it("gives every report reason its own fixed code", () => {
    const codes = Object.values(REASONS).map(reasonCode);
    expect(codes.every((c) => /^[a-z][a-z0-9_]*$/.test(c) && c !== "other")).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
    expect(reasonCode(REASONS.timedOut)).toBe("timed_out");
  });

  it("codes the holding check's own reasons, the dated ones included", () => {
    expect(reasonCode(NO_FULL_HISTORY)).toBe("no_full_history");
    expect(reasonCode("shares moved without a recorded value")).toBe("shares_moved_unvalued");
    expect(reasonCode(ACTIVITY_NOT_RECORDED)).toBe("activity_not_recorded");
    expect(reasonCode(ACTIVITY_NOT_LOADED)).toBe("activity_not_loaded");
    expect(reasonCode(activityStaleNote("2026-10-01"))).toBe("activity_stale");
    expect(reasonCode(activityStaleNote("2026-09-14"))).toBe("activity_stale");
    expect(reasonCode(UNITS_NOT_REPORTED)).toBe("units_not_reported");
    expect(reasonCode(NO_PURCHASE_RECORDED)).toBe("no_purchase_recorded");
    expect(reasonCode(shadowExhaustedNote("S&P 500"))).toBe("sales_exceed_index");
    expect(reasonCode("No S&P 500 close for every date in the period, so no comparison with it.")).toBe("no_index_close");
    expect(reasonCode("something new the engine says")).toBe("other");
  });

  it("counts a section's couldn't-tell by code, summing reasons that share one", () => {
    const c = callsSection([
      { symbol: "AAA", check: none(`can't tell: ${activityStaleNote("2026-10-01")}`) },
      { symbol: "BBB", check: none(`can't tell: ${activityStaleNote("2026-09-14")}`) },
      { symbol: "CCC", check: none(`can't compare: shares moved without a recorded value`) },
      { symbol: "DDD", timedOut: true },
    ]);
    expect(cantTellCodes(c.cantTell)).toEqual({ activity_stale: 2, shares_moved_unvalued: 1, timed_out: 1 });
    expect(cantTellCodes({ count: 0, reasons: [] })).toEqual({});
  });
});
