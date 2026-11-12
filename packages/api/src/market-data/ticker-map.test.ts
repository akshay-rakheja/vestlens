import { expect, it } from "vitest";
import { isTrustedPriceKind, priceOutOfRange, providerTicker, stooqTicker } from "./ticker-map.js";

it("maps SnapTrade symbols to Yahoo tickers", () => {
  expect(providerTicker({ symbol: "VFV.TO", kind: "etf", currency: "CAD" })).toBe("VFV.TO");
  expect(providerTicker({ symbol: "AAPL", kind: "stock", currency: "USD" })).toBe("AAPL");
  expect(providerTicker({ symbol: "BTC", kind: "crypto", currency: "CAD" })).toBe("BTC-CAD");
  expect(providerTicker({ symbol: "SHOP.TO", kind: "stock", currency: "CAD" })).toBe("SHOP.TO");
  expect(providerTicker({ symbol: "CASH", kind: "cash", currency: "CAD" })).toBeNull();
  expect(providerTicker({ symbol: "XYZ 2026-12 C", kind: "option", currency: "USD" })).toBeNull();
});
it("maps index and ETF tickers to Stooq symbols", () => {
  expect(stooqTicker("^GSPC")).toBe("^spx");
  expect(stooqTicker("^NDX")).toBe("^ndx");
  expect(stooqTicker("^DJI")).toBe("^dji");
  expect(stooqTicker("^GSPTSE")).toBe("^tsx");
  expect(stooqTicker("XEQT.TO")).toBeNull();
});
it("maps crypto to a Yahoo pair in its quote currency and never guesses one", () => {
  expect(providerTicker({ symbol: "BTC", kind: "crypto", currency: "CAD" })).toBe("BTC-CAD");
  expect(providerTicker({ symbol: "BTC", kind: "crypto", currency: null })).toBeNull();
});
it("trusts provider prices only for stock, ETF and crypto kinds, and flags ratios outside [0.5, 1.5]", () => {
  for (const k of ["stock", "ETF", " crypto ", "equity", "cs", "et"]) expect(isTrustedPriceKind(k)).toBe(true);
  for (const k of ["other", "bond", "mutualfund", "option", ""]) expect(isTrustedPriceKind(k)).toBe(false);
  expect([0.007, 0.49, 1.51, NaN].map(priceOutOfRange)).toEqual([true, true, true, true]);
  expect([0.5, 1, 1.02, 1.5].map(priceOutOfRange)).toEqual([false, false, false, false]);
});
