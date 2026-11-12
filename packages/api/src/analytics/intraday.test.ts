import { describe, expect, it } from "vitest";
import { intradayLine } from "./intraday.js";

const bar = (t: string, price: number) => ({ t, price });
const T1 = "2026-10-15T14:30:00.000Z", T2 = "2026-10-15T14:35:00.000Z", T3 = "2026-10-15T14:40:00.000Z";

describe("intradayLine", () => {
  it("sums holdings plus cash on the union time axis, worked by hand", () => {
    const r = intradayLine({
      holdings: [{ ticker: "AAA", units: 2, currency: "CAD", value: 20 }, { ticker: "BBB", units: 3, currency: "CAD", value: 30 }],
      cash: 5, scopeCurrency: "CAD", fx: null, sessionDate: "2026-10-15",
      bars: new Map([["AAA", [bar(T1, 10), bar(T3, 11)]], ["BBB", [bar(T2, 10)]]]),
    });
    // T1: BBB is before its first bar and keeps its reported 30 -> 5 + 20 + 30 = 55; T2: 55; T3: 5 + 22 + 30 = 57
    expect(r.points).toEqual([{ t: T1, value: 55 }, { t: T2, value: 55 }, { t: T3, value: 57 }]);
    expect(r.coverage).toBe(1);
    expect(r.drawn).toBe(true);
    expect(r.sessionDate).toBe("2026-10-15");
  });
  it("values a covered holding at its first bar price before that bar, so there is no step (T6/I7)", () => {
    const r = intradayLine({
      holdings: [{ ticker: "AAA", units: 2, currency: "CAD", value: 20 }, { ticker: "BBB", units: 3, currency: "CAD", value: 33 }],
      cash: 5, scopeCurrency: "CAD", fx: null, sessionDate: "2026-10-15",
      bars: new Map([["AAA", [bar(T1, 10), bar(T3, 11)]], ["BBB", [bar(T2, 10)]]]),
    });
    // BBB's reported 33 is not used once it has bars: T1 = 5 + 20 + 3*10 = 55, T2 = 55, T3 = 57
    expect(r.points.map((p) => p.value)).toEqual([55, 55, 57]);
  });
  it("carries the last price forward between bar times", () => {
    const r = intradayLine({
      holdings: [{ ticker: "AAA", units: 1, currency: "CAD", value: 10 }, { ticker: "BBB", units: 1, currency: "CAD", value: 10 }],
      cash: 0, scopeCurrency: "CAD", fx: null, sessionDate: null,
      bars: new Map([["AAA", [bar(T1, 10), bar(T3, 12)]], ["BBB", [bar(T1, 5), bar(T2, 6), bar(T3, 7)]]]),
    });
    expect(r.points.map((p) => p.value)).toEqual([15, 16, 19]);
  });
  it("lowers coverage for a holding without bars and does not draw below 0.8", () => {
    const bars = new Map([["AAA", [bar(T1, 10), bar(T2, 11)]]]);
    const h = (v: number) => [{ ticker: "AAA", units: 1, currency: "CAD", value: 80 }, { ticker: "BBB", units: 1, currency: "CAD", value: v }];
    const ok = intradayLine({ holdings: h(20), cash: 0, scopeCurrency: "CAD", fx: null, sessionDate: null, bars });
    expect(ok.coverage).toBeCloseTo(0.8);
    expect(ok.drawn).toBe(true);
    const bad = intradayLine({ holdings: h(21), cash: 0, scopeCurrency: "CAD", fx: null, sessionDate: null, bars });
    expect(bad.coverage).toBeLessThan(0.8);
    expect(bad.drawn).toBe(false);
  });
  it("converts USD holdings with fx and treats them as uncovered when fx is null", () => {
    const input = { holdings: [{ ticker: "US", units: 2, currency: "USD", value: 28 }, { ticker: "CA", units: 1, currency: "CAD", value: 10 }],
      cash: 0, scopeCurrency: "CAD", sessionDate: null, bars: new Map([["US", [bar(T1, 5), bar(T2, 5)]], ["CA", [bar(T1, 10), bar(T2, 10)]]]) };
    const withFx = intradayLine({ ...input, fx: 1.4 });
    expect(withFx.points.map((p) => p.value)).toEqual([24, 24]);
    expect(withFx.coverage).toBe(1);
    const noFx = intradayLine({ ...input, fx: null });
    // the USD holding keeps its reported 28 as a constant
    expect(noFx.points.map((p) => p.value)).toEqual([38, 38]);
    expect(noFx.coverage).toBeCloseTo(10 / 38);
    expect(noFx.drawn).toBe(false);
    const usdScope = intradayLine({ holdings: [{ ticker: "CA", units: 14, currency: "CAD", value: 14 }], cash: 0, scopeCurrency: "USD", fx: 1.4, sessionDate: null, bars: new Map([["CA", [bar(T1, 1), bar(T2, 1)]]]) });
    expect(usdScope.points[0].value).toBeCloseTo(10);
  });
  it("treats a third currency as uncovered and a single point as not drawn", () => {
    const r = intradayLine({ holdings: [{ ticker: "E", units: 1, currency: "EUR", value: 10 }], cash: 1, scopeCurrency: "CAD", fx: 1.4, sessionDate: null, bars: new Map([["E", [bar(T1, 5), bar(T2, 5)]]]) });
    expect(r.coverage).toBe(0);
    expect(r.drawn).toBe(false);
    expect(r.points).toEqual([]);
    const one = intradayLine({ holdings: [{ ticker: "A", units: 1, currency: "CAD", value: 10 }], cash: 0, scopeCurrency: "CAD", fx: null, sessionDate: null, bars: new Map([["A", [bar(T1, 5)]]]) });
    expect(one.drawn).toBe(false);
  });
  it("keeps the portfolio level when only one holding has bars and prices are unchanged", () => {
    const r = intradayLine({
      holdings: [{ ticker: "A", units: 2, currency: "CAD", value: 20 }, { ticker: "NOBARS", units: 1, currency: "CAD", value: 30 }, { ticker: "EUR", units: 1, currency: "EUR", value: 10 }],
      cash: 5, scopeCurrency: "CAD", fx: 1.4, sessionDate: null, bars: new Map([["A", [bar(T1, 10), bar(T2, 10)]]]),
    });
    expect(r.points.map((p) => p.value)).toEqual([65, 65]); // 5 + 20 + 30 + 10 reported
    expect(r.coverage).toBeCloseTo(20 / 60);
  });
  it("uses an explicit session date when given", () => {
    const r = intradayLine({ holdings: [{ ticker: "A", units: 1, currency: "CAD", value: 10 }], cash: 0, scopeCurrency: "CAD", fx: null, sessionDate: "2026-10-14", bars: new Map([["A", [bar(T1, 5), bar(T2, 5)]]]) });
    expect(r.sessionDate).toBe("2026-10-14");
  });
});
