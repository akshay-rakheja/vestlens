import { describe, expect, it } from "vitest";
import { homeConverter } from "./home-currency.js";
import { homeDailySeries } from "./home-series.js";

// Invented values: C is a CAD account, U a USD account.
const days = (n: number, start = "2026-09-01") => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
const rows = (id: string, currency: string, value: number, dates: string[]) => dates.map((date) => ({ date, accountId: id, currency, value, source: "reported" as const }));
const rates = (dates: string[], rate: (d: string) => number) => dates.map((date) => ({ date, close: rate(date) }));

describe("homeDailySeries", () => {
  it("sums CAD values and USD values × that day's rate into one CAD series, est. when USD is in it", () => {
    const d = days(3);
    const conv = homeConverter(rates(d, (x) => (x === "2026-09-02" ? 1.5 : 1.4)), "2026-09-04");
    const s = homeDailySeries([...rows("C", "CAD", 1000, d), ...rows("U", "USD", 100, d)], conv, "2026-09-01", "2026-09-04", null);
    expect(s.points.map((p) => p.value)).toEqual([1140, 1150, 1140]);
    expect(s.estimated).toBe(true);
    expect(s.notConvertedDays).toBe(0);
    expect(s.notConvertedAccounts).toEqual([]);
    expect(s.complete).toHaveLength(3);
  });

  it("a CAD-only series is exact", () => {
    const d = days(3);
    const s = homeDailySeries(rows("C", "CAD", 1000, d), homeConverter(null, "2026-09-04"), "2026-09-01", "2026-09-04", null);
    expect(s.estimated).toBe(false);
    expect(s.points.map((p) => p.value)).toEqual([1000, 1000, 1000]);
  });

  it("a day without a rate within 7 days drops that account from the day's value, counts it and leaves it out of the complete series", () => {
    const d = days(12);
    // A rate on Sep 1 only: Sep 1–8 convert (7 days), Sep 9–12 do not; then a rate again on Sep 12.
    const conv = homeConverter([{ date: "2026-09-01", close: 1.4 }, { date: "2026-09-12", close: 1.4 }], "2026-09-13");
    const s = homeDailySeries([...rows("C", "CAD", 1000, d), ...rows("U", "USD", 100, d)], conv, "2026-09-01", "2026-09-13", null);
    const dropped = s.points.filter((p) => p.notConverted);
    expect(dropped.map((p) => p.date)).toEqual(["2026-09-09", "2026-09-10", "2026-09-11"]);
    expect(dropped.every((p) => p.value === 1000 && p.notConverted === 1)).toBe(true);
    expect(s.notConvertedDays).toBe(3);
    expect(s.notConvertedAccounts).toEqual([]);
    // No fake drop: the series used for charts and returns skips those days.
    expect(s.complete.map((p) => p.value).every((v) => v === 1140)).toBe(true);
    expect(s.complete.map((p) => p.date)).not.toContain("2026-09-10");
  });

  it("an account never converted in the span is left out of every day and counted, without marking days", () => {
    const d = days(3);
    const s = homeDailySeries([...rows("C", "CAD", 1000, d), ...rows("U", "USD", 100, d), ...rows("E", "EUR", 50, d)], homeConverter(null, "2026-09-04"), "2026-09-01", "2026-09-04", null);
    expect(s.points.map((p) => p.value)).toEqual([1000, 1000, 1000]);
    expect(s.points.some((p) => p.notConverted)).toBe(false);
    expect(s.complete).toHaveLength(3);
    // Accounts that never convert are counted as accounts, not as days.
    expect(s.notConvertedDays).toBe(0);
    expect(s.notConvertedAccounts.sort()).toEqual(["E", "U"]);
    expect(s.estimated).toBe(false);
  });

  it("adds today from the reported values at today's rate and values the scope for flows in CAD", () => {
    const d = days(3);
    const conv = homeConverter(rates([...d, "2026-09-04"], () => 1.4), "2026-09-04");
    const today = new Map([["C", { amount: 1000, currency: "CAD" }], ["U", { amount: 110, currency: "USD" }]]);
    const s = homeDailySeries([...rows("C", "CAD", 1000, d), ...rows("U", "USD", 100, d)], conv, "2026-09-01", "2026-09-04", today);
    expect(s.complete.at(-1)).toMatchObject({ date: "2026-09-04", value: 1154, source: "reported" });
    expect(s.valued.inScope("U", "2026-09-03")).toBe(true);
    expect(s.valued.joinLeave.size).toBe(0);
  });
});
