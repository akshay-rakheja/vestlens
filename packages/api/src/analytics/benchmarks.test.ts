import { describe, expect, it } from "vitest";
import { BENCHMARKS, benchmarkPrices } from "./benchmarks.js";

const closes = (points: Array<[string, number]>) => points.map(([date, close]) => ({ date, close }));

describe("benchmark series", () => {
  it("the S&P 500 is its total-return index, dividends reinvested", () => {
    expect(BENCHMARKS.sp500.ticker).toBe("^SP500TR");
    expect(BENCHMARKS.sp500.totalReturn).toBe(true);
    expect(BENCHMARKS.sp500.basis).toBe("total return, dividends reinvested");
  });

  it("indices without a total-return series say price in their label", () => {
    for (const key of ["nasdaq100", "dow", "tsx"] as const) {
      expect(BENCHMARKS[key].totalReturn).toBe(false);
      expect(BENCHMARKS[key].label).toBe(`${BENCHMARKS[key].name} (price)`);
    }
    expect(BENCHMARKS.sp500.label).toBe("S&P 500 (total return)");
  });

  it("an index is fetched as is", async () => {
    const market = { history: async (t: string) => (t === "^SP500TR" ? closes([["2026-01-02", 100], ["2026-01-05", 101]]) : null) };
    expect(await benchmarkPrices(market, "sp500", "2026-01-01", "2026-01-05")).toEqual(closes([["2026-01-02", 100], ["2026-01-05", 101]]));
  });

  it("XEQT reinvests each distribution on its ex-date", async () => {
    const market = {
      history: async () => closes([["2026-01-02", 40], ["2026-01-05", 40], ["2026-01-06", 39], ["2026-01-07", 39]]),
      // 1.00 paid with the ex-date on Jan 6: the price falls by it, the total return does not.
      distributions: async () => ({ currency: "CAD", events: [{ date: "2026-01-06", amount: 1 }] }),
    };
    const out = await benchmarkPrices(market, "xeqt", "2026-01-01", "2026-01-07");
    expect(out!.map((p) => +p.close.toFixed(6))).toEqual([40, 40, 40, 40]);
  });

  it("XEQT without its distributions is unavailable, never shown as a total return it isn't", async () => {
    const history = async () => closes([["2026-01-02", 40], ["2026-01-05", 41]]);
    expect(await benchmarkPrices({ history, distributions: async () => null }, "xeqt", "2026-01-01", "2026-01-05")).toBeNull();
    expect(await benchmarkPrices({ history }, "xeqt", "2026-01-01", "2026-01-05")).toBeNull();
    expect(await benchmarkPrices({ history, distributions: async () => ({ currency: "USD", events: [] }) }, "xeqt", "2026-01-01", "2026-01-05")).toBeNull();
  });

  it("XEQT with no distributions in range is its price", async () => {
    const market = { history: async () => closes([["2026-01-02", 40], ["2026-01-05", 41]]), distributions: async () => ({ currency: "CAD", events: [] }) };
    expect(await benchmarkPrices(market, "xeqt", "2026-01-01", "2026-01-05")).toEqual(closes([["2026-01-02", 40], ["2026-01-05", 41]]));
  });
});
