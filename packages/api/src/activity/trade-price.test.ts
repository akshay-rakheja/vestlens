import { describe, expect, it } from "vitest";
import { tradePriceConverter } from "./trade-price.js";

const fx = [{ date: "2026-01-02", close: 1.4 }, { date: "2026-01-09", close: 1.38 }];

describe("tradePriceConverter (price in the row currency when it differs)", () => {
  it("converts a CAD price of a USD security at the BoC rate on or before the date", () => {
    const to = tradePriceConverter(fx);
    expect(to(29.85, "CAD", "USD", "2026-01-05")).toBeCloseTo(21.3214, 4);
    expect(to(29.85, "CAD", "USD", "2026-01-09")).toBeCloseTo(29.85 / 1.38, 6);
    expect(to(20, "USD", "CAD", "2026-01-05")).toBeCloseTo(28, 6);
  });

  it("leaves same-currency and unknown-currency prices as reported", () => {
    const to = tradePriceConverter(null);
    expect(to(50, "USD", "USD", "2026-01-05")).toBe(50);
    expect(to(50, null, "USD", "2026-01-05")).toBe(50);
    expect(to(50, "CAD", null, "2026-01-05")).toBe(50);
    expect(to(50, " cad ", "CAD", "2026-01-05")).toBe(50);
  });

  it("uses a BoC rate at most 7 days old: exactly 7 days converts, 8 days is unknown", () => {
    const to = tradePriceConverter(fx);
    expect(to(27.6, "CAD", "USD", "2026-01-16")).toBeCloseTo(20, 6);
    expect(to(27.6, "CAD", "USD", "2026-01-17")).toBeNull();
  });

  it("a USD-row trade of a CAD security converts at the reported fxRate, either direction", () => {
    const to = tradePriceConverter(fx);
    expect(to(20, "USD", "CAD", "2026-01-05", 1.35)).toBeCloseTo(27, 6);
    expect(to(20, "USD", "CAD", "2026-01-05", 1 / 1.35)).toBeCloseTo(27, 6);
    expect(tradePriceConverter(null)(20, "USD", "CAD", "2026-01-05", 1.35)).toBeCloseTo(27, 6);
  });

  it("is unknown without a rate: before the series, a stale rate, no series, or another pair", () => {
    expect(tradePriceConverter(fx)(29.85, "CAD", "USD", "2026-01-01")).toBeNull();
    expect(tradePriceConverter(fx)(29.85, "CAD", "USD", "2026-01-20")).toBeNull();
    expect(tradePriceConverter(null)(29.85, "CAD", "USD", "2026-01-05")).toBeNull();
    expect(tradePriceConverter(fx)(29.85, "EUR", "USD", "2026-01-05")).toBeNull();
  });

  it("a reported fxRate takes precedence, in the quoting direction nearest the BoC rate", () => {
    const to = tradePriceConverter(fx);
    expect(to(27, "CAD", "USD", "2026-01-05", 1.35)).toBeCloseTo(20, 6);
    expect(to(27, "CAD", "USD", "2026-01-05", 1 / 1.35)).toBeCloseTo(20, 6);
    // Without a BoC rate the reported rate still applies (USD/CAD is above 1).
    expect(tradePriceConverter(null)(27, "CAD", "USD", "2026-01-05", 1 / 1.35)).toBeCloseTo(20, 6);
  });
});
