import { describe, expect, it } from "vitest";
import type { StoredActivity } from "./stored-activity.js";
import { classifyAccount, netDeposits, replay } from "./replay.js";

let n = 0;
function act(p: Partial<StoredActivity> & { type: string; tradeDate: string | null }): StoredActivity {
  n += 1;
  return {
    snapTradeAccountId: "a", dedupeKey: `k${String(n).padStart(4, "0")}`, symbol: null, securityCurrency: null, isOption: false,
    units: null, price: null, amount: null, fee: null, fxRate: null, currency: "CAD", settlementDate: null,
    description: null, ...p,
  };
}

const base = [
  act({ type: "CONTRIBUTION", tradeDate: "2026-01-01", amount: 1000 }),
  act({ type: "BUY", tradeDate: "2026-01-02", symbol: "SYN.EQ", units: 10, price: 50, amount: -500, fee: 0 }),
  act({ type: "DIVIDEND", tradeDate: "2026-01-03", amount: 5 }),
  act({ type: "TAX", tradeDate: "2026-01-03", amount: -0.75 }),
  act({ type: "SELL", tradeDate: "2026-01-04", symbol: "SYN.EQ", units: -4, price: 60, amount: 240 }),
];

describe("replay", () => {
  it("hand-worked scenario", () => {
    const days = replay(base, "2026-01-01", "2026-01-04");
    expect(days.map((d) => d.date)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]);
    const last = days[3]!;
    expect(last.units.get("SYN.EQ")).toBe(6);
    expect(last.cash.get("CAD")).toBeCloseTo(744.25, 10);
    expect(days[1]!.units.get("SYN.EQ")).toBe(10);
  });

  it("sorts a copy and does not mutate input", () => {
    const shuffled = [...base].reverse();
    const snapshot = shuffled.map((a) => a.dedupeKey);
    const days = replay(shuffled, "2026-01-01", "2026-01-04");
    expect(days[3]!.cash.get("CAD")).toBeCloseTo(744.25, 10);
    expect(shuffled.map((a) => a.dedupeKey)).toEqual(snapshot);
  });

  it("funds conversion credits own currency and records conversion entries for that day only", () => {
    const days = replay(
      [
        act({ type: "FUNDS_CONVERSION", tradeDate: "2026-02-01", amount: 1000, currency: "USD" }),
        act({ type: "FUNDS_CONVERSION", tradeDate: "2026-02-03", amount: 50, currency: "CAD" }),
      ],
      "2026-02-01",
      "2026-02-03",
    );
    expect(days[0]!.cash.get("USD")).toBe(1000);
    expect(days[0]!.conversions).toEqual([{ currency: "USD", amount: 1000 }]);
    expect(days[1]!.conversions).toEqual([]);
    expect(days[2]!.conversions).toEqual([{ currency: "CAD", amount: 50 }]);
    expect(days[2]!.cash.get("USD")).toBe(1000);
  });

  it("in-kind transfer adds units without cash", () => {
    const days = replay([act({ type: "TRANSFER", tradeDate: "2026-03-01", symbol: "SYN.US", units: 5, amount: 0 })], "2026-03-01", "2026-03-01");
    expect(days[0]!.units.get("SYN.US")).toBe(5);
    expect(days[0]!.cash.get("CAD") ?? 0).toBe(0);
  });

  it("starts at first activity date, uses settlementDate fallback, carries state", () => {
    const days = replay([act({ type: "CONTRIBUTION", tradeDate: null, settlementDate: "2026-04-03", amount: 10 })], "2026-04-01", "2026-04-05");
    expect(days.map((d) => d.date)).toEqual(["2026-04-03", "2026-04-04", "2026-04-05"]);
    expect(days[2]!.cash.get("CAD")).toBe(10);
  });

  it("returns [] when no dated activities or first date after to", () => {
    expect(replay([], "2026-01-01", "2026-01-05")).toEqual([]);
    expect(replay(base, "2025-01-01", "2025-12-31")).toEqual([]);
  });

  it("removes closed positions and ignores option symbols in units", () => {
    const days = replay(
      [
        act({ type: "BUY", tradeDate: "2026-05-01", symbol: "X", units: 3, amount: -30 }),
        act({ type: "SELL", tradeDate: "2026-05-02", symbol: "X", units: -3, amount: 33 }),
        act({ type: "OPTIONEXPIRATION", tradeDate: "2026-05-02", symbol: "X 260101C", units: 1, amount: 0 }),
      ],
      "2026-05-01",
      "2026-05-02",
    );
    expect(days[0]!.units.get("X")).toBe(3);
    expect(days[1]!.units.size).toBe(0);
    expect(days[1]!.cash.get("CAD")).toBe(3);
  });
});

describe("replay options and edge cases", () => {
  it("option BUY (isOption) + OPTIONEXPIRATION leave no position but cash applies", () => {
    const days = replay(
      [
        act({ type: "BUY", tradeDate: "2026-06-01", symbol: "SYN260101C", units: 1, amount: -120, isOption: true }),
        act({ type: "OPTIONEXPIRATION", tradeDate: "2026-06-02", symbol: "SYN260101C", units: 1, amount: 0 }),
      ],
      "2026-06-01",
      "2026-06-02",
    );
    expect(days[0]!.units.size).toBe(0);
    expect(days[1]!.units.size).toBe(0);
    expect(days[1]!.cash.get("CAD")).toBe(-120);
  });

  it("negative FUNDS_CONVERSION applies to cash but is not recorded as a conversion", () => {
    const days = replay(
      [act({ type: "FUNDS_CONVERSION", tradeDate: "2026-07-01", amount: -1370, currency: "CAD" })],
      "2026-07-01",
      "2026-07-01",
    );
    expect(days[0]!.cash.get("CAD")).toBe(-1370);
    expect(days[0]!.conversions).toEqual([]);
  });

  it("iterates calendar days across leap day and year end", () => {
    const leap = replay([act({ type: "CONTRIBUTION", tradeDate: "2028-02-28", amount: 1 })], "2028-02-28", "2028-03-01");
    expect(leap.map((d) => d.date)).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
    const ye = replay([act({ type: "CONTRIBUTION", tradeDate: "2026-12-31", amount: 1 })], "2026-12-31", "2027-01-01");
    expect(ye.map((d) => d.date)).toEqual(["2026-12-31", "2027-01-01"]);
  });
});

describe("classifyAccount", () => {
  it("option BUY warns options_excluded and is exempt from missing_units", () => {
    const r = classifyAccount([act({ type: "BUY", tradeDate: "2026-06-01", symbol: null, units: null, amount: -5, isOption: true })]);
    expect(r).toEqual({ method: "reconstructed", reason: null, warnings: ["options_excluded"] });
  });
  it("negative FUNDS_CONVERSION warns fx_conversion_two_sided", () => {
    const r = classifyAccount([act({ type: "FUNDS_CONVERSION", tradeDate: "2026-07-01", amount: -5 })]);
    expect(r.warnings).toContain("fx_conversion_two_sided");
  });
  it("no_activity", () => {
    expect(classifyAccount([])).toMatchObject({ method: "snapshots_only", reason: "no_activity" });
  });
  it("portfolio_rebalancing", () => {
    const r = classifyAccount([...base, act({ type: "PORTFOLIO_REBALANCING", tradeDate: "2026-01-05", amount: 1 })]);
    expect(r).toMatchObject({ method: "snapshots_only", reason: "portfolio_rebalancing" });
  });
  it("missing_units", () => {
    const r = classifyAccount([act({ type: "BUY", tradeDate: "2026-01-02", symbol: "S", units: null, amount: -5 })]);
    expect(r).toMatchObject({ method: "snapshots_only", reason: "missing_units" });
    expect(classifyAccount([act({ type: "SELL", tradeDate: "2026-01-02", symbol: null, units: -1, amount: 5 })]).reason).toBe("missing_units");
  });
  it("M4: REINVEST is position-affecting; missing symbol or units -> missing_units", () => {
    expect(classifyAccount([...base, act({ type: "REINVEST", tradeDate: "2026-01-05", symbol: "SYN.EQ", units: 0.1, amount: -5 })]).method).toBe("reconstructed");
    expect(classifyAccount([...base, act({ type: "REINVEST", tradeDate: "2026-01-05", symbol: "SYN.EQ", units: null, amount: -5 })]).reason).toBe("missing_units");
    expect(classifyAccount([...base, act({ type: "REINVEST", tradeDate: "2026-01-05", symbol: null, units: 0.1, amount: -5 })]).reason).toBe("missing_units");
    const days = replay([...base, act({ type: "REINVEST", tradeDate: "2026-01-05", symbol: "SYN.EQ", units: -0.1, amount: -5 })], "2026-01-01", "2026-01-05");
    expect(days.at(-1)!.units.get("SYN.EQ")).toBeCloseTo(6.1, 9);
  });
  it("M9: a non-option BUY/SELL without a currency -> missing_currency", () => {
    expect(classifyAccount([...base, act({ type: "BUY", tradeDate: "2026-01-05", symbol: "SYN.EQ", units: 1, amount: -5, currency: null })]))
      .toMatchObject({ method: "snapshots_only", reason: "missing_currency" });
    expect(classifyAccount([...base, act({ type: "SELL", tradeDate: "2026-01-05", symbol: "SYN.EQ", units: -1, amount: 5, currency: null })]).reason).toBe("missing_currency");
    expect(classifyAccount([...base, act({ type: "BUY", tradeDate: "2026-01-05", isOption: true, amount: -5, currency: null })]).method).toBe("reconstructed");
  });
  it("options warning keeps reconstructed", () => {
    const r = classifyAccount([...base, act({ type: "OPTIONS_MULTILEG", tradeDate: "2026-01-05", amount: 3 })]);
    expect(r).toEqual({ method: "reconstructed", reason: null, warnings: ["options_excluded"] });
  });
  it("fx_conversion_unsupported for non CAD/USD", () => {
    const r = classifyAccount([...base, act({ type: "FUNDS_CONVERSION", tradeDate: "2026-01-05", amount: 5, currency: "EUR" })]);
    expect(r.method).toBe("reconstructed");
    expect(r.warnings).toContain("fx_conversion_unsupported");
  });
  it("clean account", () => {
    expect(classifyAccount(base)).toEqual({ method: "reconstructed", reason: null, warnings: [] });
  });
});

describe("netDeposits", () => {
  it("counts contributions, withdrawals and internal cash transfers per date/currency", () => {
    const m = netDeposits([
      act({ type: "CONTRIBUTION", tradeDate: "2026-01-01", amount: 1000 }),
      act({ type: "WITHDRAWAL", tradeDate: "2026-01-01", amount: -200 }),
      act({ type: "INTERNAL_CASH_TRANSFER_IN", tradeDate: "2026-01-02", amount: 50 }),
      act({ type: "INTERNAL_CASH_TRANSFER_OUT", tradeDate: "2026-01-02", amount: -20, currency: "USD" }),
      act({ type: "DIVIDEND", tradeDate: "2026-01-02", amount: 9 }),
    ]);
    expect(m.get("2026-01-01")!.get("CAD")).toBe(800);
    expect(m.get("2026-01-02")!.get("CAD")).toBe(50);
    expect(m.get("2026-01-02")!.get("USD")).toBe(-20);
  });
});
