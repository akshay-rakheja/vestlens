import { describe, expect, it, vi } from "vitest";
import { providerMetadataProbe, type ProbeInput } from "./provider-probe.js";
import type { StoredActivity } from "./stored-activity.js";

let n = 0;
const act = (o: Partial<StoredActivity>): StoredActivity => ({
  snapTradeAccountId: "A", dedupeKey: `k${String(++n).padStart(4, "0")}`, type: "BUY", symbol: "SECRETUS", securityCurrency: "USD", isOption: false,
  units: 10, price: 28, amount: -280, fee: null, fxRate: null, currency: "CAD", tradeDate: "2026-10-05", settlementDate: null, description: null, ...o,
});
const position = (o: Record<string, unknown>) => ({
  instrumentId: "i", kind: "stock", symbol: "SECRETUS", description: null, units: 10, price: 21, costBasis: 20, marketValue: 210,
  unrealizedGain: null, currency: "USD", cashEquivalent: false, ...o,
});
const market = (closes: Record<string, Array<{ date: string; close: number }>> = {}) => ({
  securityHistory: vi.fn(async (ticker: string) => (closes[ticker] ? { points: closes[ticker], splits: [] } : null) as never),
  usdCad: vi.fn(async () => [{ date: "2026-10-01", close: 1.4 }] as never),
});
const input = (o: Partial<ProbeInput> = {}): ProbeInput => ({
  reportingCurrency: "CAD", reportedTotal: 1000, balances: [], positions: [], activities: [],
  securityCurrencyOf: (s: string) => (s.endsWith(".TO") ? "CAD" : "USD"),
  tickerFor: (s: string) => s, market: market(), range: { from: "2026-09-20", to: "2026-10-15" }, usdCad: 1.4, today: "2026-10-15", ...o,
});
const KEYS = ["cashEquivalentInBalance", "costBasisCurrency", "positionPriceLiveness"];
const DIST = ["count", "median", "p10", "p90"];

describe("providerMetadataProbe", () => {
  it("has exactly the allowed keys, with empty distributions when nothing applies", async () => {
    const p = await providerMetadataProbe(input());
    expect(Object.keys(p).sort()).toEqual(KEYS);
    expect(Object.keys(p.costBasisCurrency).sort()).toEqual(DIST);
    expect(p.costBasisCurrency).toEqual({ count: 0, median: null, p10: null, p90: null });
    expect(p.cashEquivalentInBalance).toEqual({ count: 0, r1: null });
    expect(Object.keys(p.positionPriceLiveness).sort()).toEqual(["count", "latest", "nearLatest", "nearPrevious", "previous"]);
    expect(p.positionPriceLiveness).toMatchObject({ count: 0, nearLatest: null, nearPrevious: null });
  });

  it("costBasisCurrency: costBasis over the replayed average cost in the security currency (after the row-currency fix)", async () => {
    // CA$28 at USD/CAD 1.40 = US$20 average cost.
    const usdBasis = await providerMetadataProbe(input({ positions: [position({ costBasis: 20 })], activities: [act({})] }));
    expect(usdBasis.costBasisCurrency).toEqual({ count: 1, median: 1, p10: 1, p90: 1 });
    const cadBasis = await providerMetadataProbe(input({ positions: [position({ costBasis: 28 })], activities: [act({})] }));
    expect(cadBasis.costBasisCurrency.median).toBe(1.4);
    // A security in the reporting currency is not counted.
    const local = await providerMetadataProbe(input({ positions: [position({ symbol: "LOCAL.TO", currency: "CAD" })], activities: [act({ symbol: "LOCAL.TO", securityCurrency: "CAD" })] }));
    expect(local.costBasisCurrency.count).toBe(0);
  });

  it("cashEquivalentInBalance: r1 near 0 when the cash-equivalent sits inside balance cash, near 1 when additional", async () => {
    const positions = [position({ marketValue: 300, currency: "CAD", symbol: "STOCK.TO" }), position({ cashEquivalent: true, symbol: "MMF.TO", marketValue: 200, currency: "CAD" })];
    const inside = await providerMetadataProbe(input({ reportedTotal: 1000, positions, balances: [{ currency: "CAD", cash: 700, buyingPower: null }] }));
    expect(inside.cashEquivalentInBalance).toEqual({ count: 1, r1: 0 });
    const additional = await providerMetadataProbe(input({ reportedTotal: 1000, positions, balances: [{ currency: "CAD", cash: 500, buyingPower: null }] }));
    expect(additional.cashEquivalentInBalance).toEqual({ count: 1, r1: 1 });
    // USD amounts are converted at the given rate.
    const usd = await providerMetadataProbe(input({ reportedTotal: 1000, positions: [position({ marketValue: 300, currency: "CAD", symbol: "STOCK.TO" }), position({ cashEquivalent: true, symbol: "MMF", marketValue: 100, currency: "USD" })], balances: [{ currency: "CAD", cash: 560, buyingPower: null }] }));
    expect(usd.cashEquivalentInBalance).toEqual({ count: 1, r1: 1 });
    // A pair other than USD/CAD cannot be converted: r1 is null.
    const eur = await providerMetadataProbe(input({ reportedTotal: 1000, positions, balances: [{ currency: "EUR", cash: 500, buyingPower: null }] }));
    expect(eur.cashEquivalentInBalance).toEqual({ count: 1, r1: null });
    const unknownCash = await providerMetadataProbe(input({ positions, balances: [{ currency: "CAD", cash: null, buyingPower: null }] }));
    expect(unknownCash.cashEquivalentInBalance).toEqual({ count: 1, r1: null });
  });

  it("positionPriceLiveness: position price over the latest and previous close, with ±0.3% shares", async () => {
    const closes = { LIVE: [{ date: "2026-10-13", close: 99 }, { date: "2026-10-14", close: 100 }, { date: "2026-10-16", close: 500 }], PREV: [{ date: "2026-10-13", close: 50 }, { date: "2026-10-14", close: 52 }] };
    const p = await providerMetadataProbe(input({
      market: market(closes),
      positions: [
        position({ symbol: "LIVE", price: 100.1 }), position({ symbol: "PREV", price: 50 }),
        position({ symbol: "OPT", kind: "option", price: 1 }), position({ symbol: "CEQ", cashEquivalent: true, price: 1 }),
        position({ symbol: "NOHIST", price: 1 }), position({ symbol: "NOPRICE", price: null }),
      ],
    }));
    expect(p.positionPriceLiveness.count).toBe(2);
    expect(p.positionPriceLiveness.nearLatest).toBe(0.5);
    expect(p.positionPriceLiveness.nearPrevious).toBe(0.5);
    expect(p.positionPriceLiveness.latest).toEqual({ count: 2, median: expect.closeTo(0.981, 3), p10: expect.closeTo(0.965, 3), p90: expect.closeTo(0.997, 3) });
    expect(p.positionPriceLiveness.previous).toEqual({ count: 2, median: 1.006, p10: 1.001, p90: 1.01 });
  });

  it("issues no market calls once cancelled", async () => {
    const m = market({ SECRETUS: [{ date: "2026-10-14", close: 21 }] });
    const p = await providerMetadataProbe(input({ market: m, positions: [position({})], activities: [act({})], cancelled: () => true }));
    expect(m.securityHistory).not.toHaveBeenCalled();
    expect(m.usdCad).not.toHaveBeenCalled();
    expect(p.positionPriceLiveness.count).toBe(0);
  });

  it("never carries symbols or values", async () => {
    const p = await providerMetadataProbe(input({
      market: market({ SECRETUS: [{ date: "2026-10-13", close: 20.5 }, { date: "2026-10-14", close: 21 }] }),
      positions: [position({}), position({ cashEquivalent: true, symbol: "SECRETMMF", marketValue: 123.45, currency: "CAD" })],
      balances: [{ currency: "CAD", cash: 678.9, buyingPower: null }], activities: [act({})],
    }));
    expect(JSON.stringify(p)).not.toMatch(/SECRET/);
    // Key shape: exactly the probe keys, and every leaf is a count, ratio or null (never a string).
    const shape = (v: unknown): unknown => (v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : v === null ? "null" : typeof v);
    const dist = { count: "number", median: expect.stringMatching(/^(number|null)$/), p10: expect.stringMatching(/^(number|null)$/), p90: expect.stringMatching(/^(number|null)$/) };
    expect(shape(p)).toEqual({
      costBasisCurrency: dist,
      cashEquivalentInBalance: { count: "number", r1: expect.stringMatching(/^(number|null)$/) },
      positionPriceLiveness: { count: "number", latest: dist, previous: dist, nearLatest: expect.stringMatching(/^(number|null)$/), nearPrevious: expect.stringMatching(/^(number|null)$/) },
    });
  });
});
