import { describe, expect, it, vi } from "vitest";
import { HOME_CURRENCY, homeConverter, loadHomeConverter, sumHome } from "./home-currency.js";

const series = [{ date: "2026-05-22", close: 1.37 }, { date: "2026-05-26", close: 1.3712 }];

describe("homeConverter", () => {
  it("home currency is CAD", () => {
    expect(HOME_CURRENCY).toBe("CAD");
  });

  it("CAD amount is exact", () => {
    const fx = homeConverter(series, "2026-05-26");
    expect(fx.at(100, "CAD")).toEqual({ amount: 100, estimated: false, rate: null, rateDate: null, native: { amount: 100, currency: "CAD" } });
  });

  it("USD converts at the rate on or before the date, rounded to cents", () => {
    const fx = homeConverter(series, "2026-05-26");
    expect(fx.at(4640, "USD", "2026-05-26")).toEqual({
      amount: 6362.37, estimated: true, rate: 1.3712, rateDate: "2026-05-26", native: { amount: 4640, currency: "USD" },
    });
    expect(fx.at(10, "USD", "2026-05-25")).toMatchObject({ amount: 13.7, rate: 1.37, rateDate: "2026-05-22" });
  });

  it("no date converts at today's rate; latest is the rate valid today", () => {
    const fx = homeConverter([...series].reverse(), "2026-05-27");
    expect(fx.at(4640, "USD")).toMatchObject({ amount: 6362.37, rateDate: "2026-05-26" });
    expect(fx.latest).toEqual({ rate: 1.3712, date: "2026-05-26" });
  });

  it("7 days converts, 8 does not", () => {
    const fx = homeConverter([{ date: "2026-05-01", close: 1.37 }], "2026-05-09");
    expect(fx.at(1, "USD", "2026-05-08").amount).toBe(1.37);
    expect(fx.at(1, "USD", "2026-05-09")).toMatchObject({ amount: null, estimated: false, rate: null, rateDate: null });
    expect(fx.latest).toBeNull();
  });

  it("a full ISO timestamp converts by its calendar date under the 7-day rule", () => {
    const fx = homeConverter([{ date: "2026-05-01", close: 1.37 }], "2026-05-09");
    expect(fx.at(1, "USD", "2026-05-08T14:00:00Z")).toMatchObject({ amount: 1.37, rateDate: "2026-05-01" });
    expect(fx.at(1, "USD", "2026-05-09T00:30:00Z").amount).toBeNull();
  });

  it("a date that is not a calendar date is not converted", () => {
    const fx = homeConverter(series, "2026-05-26");
    for (const d of ["garbage", "", "2026-05-26x", "2026-02-30", "2026-05-26 10:00"]) {
      expect(fx.at(1, "USD", d)).toMatchObject({ amount: null, estimated: false, rate: null, rateDate: null });
    }
  });

  it("series points without a valid calendar date are ignored", () => {
    const fx = homeConverter([{ date: "2026-05-01", close: 1.37 }, { date: "bad", close: 9 }, { date: "2026-05-03T00:00:00Z", close: 8 }], "2026-05-05");
    expect(fx.at(1, "USD", "2026-05-05")).toMatchObject({ amount: 1.37, rateDate: "2026-05-01" });
    expect(fx.latest).toEqual({ rate: 1.37, date: "2026-05-01" });
  });

  it("no series means USD is not converted", () => {
    const fx = homeConverter(null, "2026-05-26");
    expect(fx.at(1, "USD").amount).toBeNull();
    expect(fx.latest).toBeNull();
  });

  it("other currencies are not converted", () => {
    const fx = homeConverter(series, "2026-05-26");
    const eur = fx.at(5, "EUR");
    expect(eur.amount).toBeNull();
    expect(eur.estimated).toBe(false);
    expect(eur.native).toEqual({ amount: 5, currency: "EUR" });
  });
});

describe("sumHome", () => {
  it("adds converted parts, marks est., lists rate dates and exclusions", () => {
    const A = "2026-05-22";
    const fx = homeConverter([{ date: A, close: 1.37 }], "2026-05-26");
    const total = sumHome([fx.at(100, "CAD"), fx.at(100, "USD", A), fx.at(5, "EUR")]);
    expect(total).toEqual({ amount: 237, estimated: true, rateDates: [A], excluded: [{ amount: 5, currency: "EUR" }], excludedCount: 1 });
  });

  it("groups unconverted parts by currency, summed and sorted, and counts them", () => {
    const fx = homeConverter([], "2026-05-26");
    const total = sumHome([fx.at(10.1, "USD"), fx.at(5, "EUR"), fx.at(20.2, "USD")]);
    expect(total.excluded).toEqual([{ amount: 5, currency: "EUR" }, { amount: 30.3, currency: "USD" }]);
    expect(total.excludedCount).toBe(3);
  });

  it("all-CAD total is exact", () => {
    const fx = homeConverter(series, "2026-05-26");
    expect(sumHome([fx.at(1.1, "CAD"), fx.at(2.2, "CAD")])).toEqual({ amount: 3.3, estimated: false, rateDates: [], excluded: [], excludedCount: 0 });
  });

  it("sums rounded parts and lists each rate date once, sorted", () => {
    const fx = homeConverter(series, "2026-05-26");
    const total = sumHome([fx.at(1.005, "USD", "2026-05-26"), fx.at(1, "USD", "2026-05-22"), fx.at(2, "USD", "2026-05-26")]);
    expect(total.rateDates).toEqual(["2026-05-22", "2026-05-26"]);
    expect(total.amount).toBe(Math.round((1.38 + 1.37 + 2.74) * 100) / 100);
  });
});

describe("loadHomeConverter", () => {
  it("fetches from 10 days before `from` to today in one call", async () => {
    const usdCad = vi.fn(async () => series);
    const fx = await loadHomeConverter({ usdCad }, "2026-05-01", "2026-05-26");
    expect(usdCad).toHaveBeenCalledTimes(1);
    expect(usdCad).toHaveBeenCalledWith("2026-04-21", "2026-05-26");
    expect(fx.at(4640, "USD", "2026-05-26").amount).toBe(6362.37);
  });

  it("an unavailable series leaves USD not converted", async () => {
    const fx = await loadHomeConverter({ usdCad: async () => null }, "2026-05-01", "2026-05-26");
    expect(fx.at(1, "USD").amount).toBeNull();
  });
});
