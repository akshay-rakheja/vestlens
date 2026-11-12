import { describe, expect, it } from "vitest";
import type { StoredActivity } from "../history/stored-activity.js";
import type { HoldingRow } from "./holdings.js";
import {
  contributionsByAccountType, DIVIDEND_MATCH_DAYS, forwardDetail, forwardEstimate, monthlyIncome, netDividends, overallYields, unmatchedWithholding, withholdingByAccountType, yields, type DividendEvent,
} from "./income.js";

let n = 0;
const act = (over: Partial<StoredActivity>): StoredActivity => ({
  snapTradeAccountId: "A", dedupeKey: `k${n++}`, type: "DIVIDEND", symbol: "AAA", securityCurrency: "CAD", isOption: false, units: null, price: null,
  amount: 10, fee: null, fxRate: null, currency: "CAD", tradeDate: "2026-03-15", settlementDate: null, description: null, ...over,
});
const ev = (over: Partial<DividendEvent>): DividendEvent => ({ date: "2026-03-15", accountId: "A", symbol: "AAA", currency: "CAD", gross: 10, withholding: 0, net: 10, ...over });

describe("unmatchedWithholding", () => {
  it("counts withholding rows with no matching dividend per currency and year, without netting them", () => {
    const rows = [
      act({ amount: 10 }), act({ type: "TAX", amount: -1.5, tradeDate: "2026-03-16" }),
      act({ type: "TAX", amount: -9, tradeDate: "2026-05-01" }),
      act({ type: "WITHHOLDING", amount: -2, symbol: null, tradeDate: "2026-06-01" }),
      act({ type: "TAX", amount: -4, currency: "USD", symbol: "UUU", tradeDate: "2026-07-01" }),
      act({ type: "TAX", amount: 1, tradeDate: "2026-08-01" }),
      act({ type: "TAX", amount: -5, tradeDate: "2025-12-01" }),
    ];
    expect(unmatchedWithholding(rows, 2026)).toEqual([{ currency: "CAD", count: 3, amount: 10 }, { currency: "USD", count: 1, amount: 4 }]);
    expect(netDividends(rows)[0]).toMatchObject({ gross: 10, withholding: 1.5, net: 8.5 });
    expect(unmatchedWithholding([act({ amount: 10 })], 2026)).toEqual([]);
  });
});

describe("netDividends", () => {
  it("nets matched withholding (positive magnitude): net = gross - withholding", () => {
    const [e, ...rest] = netDividends([act({ amount: 10 }), act({ type: "TAX", amount: -1.5, tradeDate: "2026-03-16" })]);
    expect(rest).toEqual([]);
    expect(e).toEqual({ date: "2026-03-15", accountId: "A", symbol: "AAA", currency: "CAD", gross: 10, withholding: 1.5, net: 8.5 });
  });
  it("no withholding: net equals gross", () => {
    expect(netDividends([act({})])).toEqual([ev({})]);
  });
  it("a matched positive TAX refund reduces withholding", () => {
    const [e] = netDividends([act({ amount: 10 }), act({ type: "TAX", amount: -1.5 }), act({ type: "TAX", amount: 0.5, tradeDate: "2026-03-17" })]);
    expect(e).toMatchObject({ gross: 10, withholding: 1, net: 9 });
    expect(DIVIDEND_MATCH_DAYS).toBe(3);
  });
  it("an unmatched TAX row (other account, symbol, currency or beyond 3 days) is ignored", () => {
    const events = netDividends([
      act({ amount: 10 }),
      act({ type: "TAX", amount: -2, snapTradeAccountId: "B" }),
      act({ type: "TAX", amount: -2, symbol: "ZZZ" }),
      act({ type: "TAX", amount: -2, currency: "USD" }),
      act({ type: "TAX", amount: -2, tradeDate: "2026-03-20" }),
    ]);
    expect(events).toEqual([ev({})]);
  });
  it("the same symbol in a different account is a separate event", () => {
    const events = netDividends([act({ amount: 10 }), act({ snapTradeAccountId: "B", amount: 4 })]);
    expect(events.map((e) => [e.accountId, e.net])).toEqual([["A", 10], ["B", 4]]);
  });
  it("a REI next to a matching dividend is not counted again; a lone REI counts once", () => {
    expect(netDividends([act({ amount: 10 }), act({ type: "REI", amount: -10, units: 1, tradeDate: "2026-03-16" })])).toEqual([ev({})]);
    expect(netDividends([act({ type: "REI", amount: -7, units: 1 })])).toEqual([ev({ gross: 7, net: 7 })]);
    expect(netDividends([act({ type: "REINVEST", amount: 7 })])).toEqual([ev({ gross: 7, net: 7 })]);
  });
  it("counts DISTRIBUTION, skips rows without a currency, amount or date, and sorts by date", () => {
    const events = netDividends([
      act({ type: "DISTRIBUTION", amount: 3, tradeDate: "2026-05-01" }), act({ amount: null }), act({ currency: null }), act({ tradeDate: null, settlementDate: null }),
      act({ amount: 2, tradeDate: null, settlementDate: "2026-01-02" }),
    ]);
    expect(events.map((e) => [e.date, e.gross])).toEqual([["2026-01-02", 2], ["2026-05-01", 3]]);
  });
});

describe("monthlyIncome", () => {
  it("stacks net by account per month and currency and adds interest", () => {
    const events = [ev({ date: "2026-03-15", accountId: "A", gross: 10, withholding: 1, net: 9 }), ev({ date: "2026-03-20", accountId: "B", gross: 5, net: 5 }), ev({ date: "2025-03-20", net: 99, gross: 99 }), ev({ date: "2026-04-01", currency: "USD", net: 2, gross: 2 })];
    const interest = [act({ type: "INTEREST", amount: 1.25, tradeDate: "2026-03-31", symbol: null }), act({ type: "INTEREST", amount: 8, tradeDate: "2026-06-30", symbol: null }), act({ type: "INTEREST", amount: 50, tradeDate: "2025-06-30" })];
    expect(monthlyIncome(events, interest, 2026)).toEqual([
      { month: "2026-03", currency: "CAD", byAccount: { A: 9, B: 5 }, payers: [{ symbol: "AAA", net: 14 }], net: 14, gross: 15, withholding: 1, interest: 1.25 },
      { month: "2026-04", currency: "USD", byAccount: { A: 2 }, payers: [{ symbol: "AAA", net: 2 }], net: 2, gross: 2, withholding: 0, interest: 0 },
      { month: "2026-06", currency: "CAD", byAccount: {}, payers: [], net: 0, gross: 0, withholding: 0, interest: 8 },
    ]);
  });
  it("lists the month's payers by net: same symbol summed across accounts, symbol-less as Other, top 10 only", () => {
    const events = [
      ev({ date: "2026-05-01", accountId: "A", symbol: "XEQT", net: 5, gross: 5 }), ev({ date: "2026-05-02", accountId: "B", symbol: "XEQT", net: 7, gross: 7 }),
      ev({ date: "2026-05-03", symbol: null, net: 3, gross: 3 }), ev({ date: "2026-05-04", currency: "USD", symbol: "AAPL", net: 1, gross: 1 }),
      ...Array.from({ length: 12 }, (_, i) => ev({ date: "2026-06-01", symbol: `S${String(i).padStart(2, "0")}`, net: 100 - i, gross: 100 - i })),
    ];
    const m = monthlyIncome(events, [], 2026);
    expect(m.find((x) => x.month === "2026-05" && x.currency === "CAD")!.payers).toEqual([{ symbol: "XEQT", net: 12 }, { symbol: "Other", net: 3 }]);
    expect(m.find((x) => x.month === "2026-05" && x.currency === "USD")!.payers).toEqual([{ symbol: "AAPL", net: 1 }]);
    const june = m.find((x) => x.month === "2026-06")!.payers;
    expect(june).toHaveLength(10);
    expect(june[0]).toEqual({ symbol: "S00", net: 100 });
  });
  it("is empty for a year with nothing", () => {
    expect(monthlyIncome([ev({})], [], 2024)).toEqual([]);
  });
});

describe("forwardEstimate", () => {
  const today = "2026-10-18";
  const quarterly = ["2025-11-15", "2026-02-15", "2026-05-15", "2026-08-15"].map((date) => ev({ date, gross: 50, net: 50 }));
  it("four quarterly $0.50/unit payments at 100 units x 120 current units = $240", () => {
    const out = forwardEstimate(quarterly, () => 100, new Map([["AAA|A", 120]]), today);
    expect(out).toEqual([{ symbol: "AAA", currency: "CAD", amount: 240, estimated: true }]);
  });
  it("ignores payments older than 365 days", () => {
    const out = forwardEstimate([ev({ date: "2025-10-01", net: 50 }), ...quarterly], () => 100, new Map([["AAA|A", 120]]), today);
    expect(out[0]!.amount).toBe(240);
  });
  it("skips the whole payer when any payment's units are unknown or 0, or when it has no current units", () => {
    const units = (_s: string, _a: string, date: string) => (date === "2025-11-15" ? null : date === "2026-02-15" ? 0 : 100);
    expect(forwardEstimate(quarterly, units, new Map([["AAA|A", 100]]), today)).toEqual([]);
    expect(forwardEstimate(quarterly, () => null, new Map([["AAA|A", 100]]), today)).toEqual([]);
    expect(forwardEstimate(quarterly, () => 100, new Map(), today)).toEqual([]);
  });
  it("skips a payer whose replayed final units differ from the reported units by more than 0.5% (split, partial history)", () => {
    const current = new Map([["AAA|A", 400]]);
    expect(forwardEstimate(quarterly, () => 100, current, today, () => 100)).toEqual([]);
    expect(forwardEstimate(quarterly, () => 100, new Map([["AAA|A", 100.4]]), today, () => 100)).toHaveLength(1);
    expect(forwardEstimate(quarterly, () => 100, new Map([["AAA|A", 100]]), today, () => null)).toEqual([]);
  });
  it("reports coverage per currency: payers with trailing payments and current units, and those covered", () => {
    const events = [...quarterly, ...quarterly.map((e) => ({ ...e, symbol: "BBB" })), ev({ symbol: "ZZZ", date: "2026-08-15", currency: "USD" })];
    const current = new Map([["AAA|A", 100], ["BBB|A", 400], ["ZZZ|A", 10]]);
    const d = forwardDetail(events, () => 100, current, today, (s) => (s === "BBB" ? 100 : s === "ZZZ" ? 100 : 100));
    expect(d.estimates.map((e) => e.symbol)).toEqual(["AAA"]);
    expect(d.coverage.get("CAD")).toEqual({ payers: 2, covered: 1 });
    expect(d.coverage.get("USD")).toEqual({ payers: 1, covered: 0 });
  });
  it("a true trailing 12 months keeps all twelve payments of a monthly payer (C2)", () => {
    const months = ["2025-01-28", "2025-02-28", "2025-03-28", "2025-04-28", "2025-05-28", "2025-06-28", "2025-07-28", "2025-08-28", "2025-09-28", "2025-10-28", "2025-11-28", "2025-12-28"];
    const monthly = months.map((date) => ev({ date, gross: 10, net: 10 }));
    expect(forwardEstimate(monthly, () => 100, new Map([["AAA|A", 100]]), "2026-01-25")[0]!.amount).toBe(120);
    // A year to the day is outside the window.
    expect(forwardEstimate([ev({ date: "2025-10-18", net: 50 }), ...quarterly], () => 100, new Map([["AAA|A", 100]]), today)[0]!.amount).toBe(200);
  });
  it("five drifting quarterly payments still count four: the oldest repeats the latest payment's period", () => {
    const drift = ["2025-10-19", "2026-01-18", "2026-04-19", "2026-07-18", "2026-10-17"].map((date) => ev({ date, net: 50, gross: 50 }));
    expect(forwardEstimate(drift, () => 100, new Map([["AAA|A", 100]]), today)[0]!.amount).toBe(200);
  });
  it("sums accounts of the same symbol and keeps currencies apart", () => {
    const events = [ev({ accountId: "A", date: "2026-08-15", net: 10 }), ev({ accountId: "B", date: "2026-08-15", net: 20 }), ev({ symbol: "XUU", currency: "USD", date: "2026-08-15", net: 5 })];
    const out = forwardEstimate(events, () => 10, new Map([["AAA|A", 10], ["AAA|B", 20], ["XUU|A", 10]]), today);
    expect(out).toEqual([{ symbol: "AAA", currency: "CAD", amount: 10 + 40, estimated: true }, { symbol: "XUU", currency: "USD", amount: 5, estimated: true }]);
  });
});

const holding = (over: Partial<HoldingRow>): HoldingRow => ({ key: "AAA|CAD", symbol: "AAA", currency: "CAD", kind: "stock", units: 10, price: 10, marketValue: 200, bookCost: 100, totalReturn: null, totalReturnFraction: null, weight: null, weightCad: null, dayChange: null, accounts: [], ...over });

describe("yields", () => {
  it("net / book cost and net / market value per holding; null when the value is unknown", () => {
    const out = yields(new Map([["AAA|CAD", 10], ["BBB|CAD", 4], ["CCC|CAD", 3]]), [
      holding({}), holding({ key: "BBB|CAD", symbol: "BBB", bookCost: null, marketValue: 80 }), holding({ key: "CCC|CAD", symbol: "CCC", marketValue: null, bookCost: 50 }),
    ]);
    expect(out).toEqual([
      { symbol: "AAA", currency: "CAD", yieldOnCost: 0.1, currentYield: 0.05, estimated: true },
      { symbol: "BBB", currency: "CAD", yieldOnCost: null, currentYield: 0.05, estimated: true },
      { symbol: "CCC", currency: "CAD", yieldOnCost: 0.06, currentYield: null, estimated: true },
    ]);
  });
  it("omits holdings without trailing income", () => {
    expect(yields(new Map(), [holding({})])).toEqual([]);
  });
  it("overall is sum over sum across the holdings that have each value", () => {
    const rows = [holding({}), holding({ key: "BBB|CAD", symbol: "BBB", bookCost: null, marketValue: 100 }), holding({ key: "XXX|CAD", symbol: "XXX", bookCost: 300, marketValue: 300 })];
    const out = overallYields(new Map([["AAA|CAD", 10], ["BBB|CAD", 5]]), rows);
    // cost: (10) / (100 + 300); value: (10 + 5) / (200 + 100 + 300)
    expect(out.get("CAD")).toEqual({ yieldOnCost: 10 / 400, currentYield: 15 / 600 });
  });
});

describe("withholdingByAccountType", () => {
  it("sums gross and withholding per account type and currency with the rate", () => {
    const type = (id: string) => (id === "A" ? "TFSA" : "RRSP");
    const out = withholdingByAccountType([ev({ gross: 100, withholding: 15, net: 85 }), ev({ accountId: "B", gross: 100, withholding: 0, net: 100 }), ev({ accountId: "A", gross: 100, withholding: 15, net: 85 }), ev({ accountId: "A", currency: "USD", gross: 0, net: 0 })], type);
    expect(out).toEqual([
      { accountType: "RRSP", currency: "CAD", gross: 100, withholding: 0, rate: 0 },
      { accountType: "TFSA", currency: "CAD", gross: 200, withholding: 30, rate: 0.15 },
      { accountType: "TFSA", currency: "USD", gross: 0, withholding: 0, rate: null },
    ]);
  });
});

describe("contributionsByAccountType", () => {
  const type = (id: string) => (id === "A" ? "TFSA" : "RRSP");
  it("sums deposit-type rows of the year per account type and currency, excluding transfers within one account type", () => {
    const rows = [
      act({ type: "CONTRIBUTION", amount: 500, tradeDate: "2026-02-01" }), act({ type: "DEPOSIT", amount: 100, tradeDate: "2026-02-02", snapTradeAccountId: "B" }),
      act({ type: "CONTRIBUTION", amount: 900, tradeDate: "2025-12-31" }),
      // B (RRSP) -> A (TFSA): crosses types, so it is money put into the TFSA (it netted away before I3).
      act({ type: "INTERNAL_CASH_TRANSFER_OUT", amount: -300, tradeDate: "2026-03-01", snapTradeAccountId: "B" }),
      act({ type: "INTERNAL_CASH_TRANSFER_IN", amount: 300, tradeDate: "2026-03-01", snapTradeAccountId: "A" }),
      // B -> C, both RRSP: internal to the type, nets.
      act({ type: "INTERNAL_CASH_TRANSFER_OUT", amount: -200, tradeDate: "2026-03-05", snapTradeAccountId: "B" }),
      act({ type: "INTERNAL_CASH_TRANSFER_IN", amount: 200, tradeDate: "2026-03-05", snapTradeAccountId: "C" }),
      act({ type: "INTERNAL_CASH_TRANSFER_IN", amount: 40, tradeDate: "2026-04-01", snapTradeAccountId: "A", currency: "USD" }),
      act({ type: "DIVIDEND", amount: 10 }),
    ];
    expect(contributionsByAccountType(rows, 2026, type)).toEqual([
      { accountType: "RRSP", currency: "CAD", amount: 100 },
      { accountType: "TFSA", currency: "CAD", amount: 800 },
      { accountType: "TFSA", currency: "USD", amount: 40 },
    ]);
  });

  describe("all accounts agree with each type's own scope (I3)", () => {
    const types: Record<string, string> = { T1: "TFSA", T2: "TFSA", CASH: "Cash" };
    const typeOf = (id: string) => types[id]!;
    const leg = (id: string, dir: "IN" | "OUT", amount: number, tradeDate: string) =>
      act({ snapTradeAccountId: id, type: `INTERNAL_CASH_TRANSFER_${dir}`, symbol: null, amount: dir === "IN" ? amount : -amount, tradeDate });
    const rows = [
      act({ snapTradeAccountId: "T2", type: "CONTRIBUTION", symbol: null, amount: 1000, tradeDate: "2026-01-10" }),
      leg("T1", "OUT", 500, "2026-02-01"), leg("T2", "IN", 500, "2026-02-01"), // TFSA1 -> TFSA2: nets in every view
      leg("CASH", "OUT", 300, "2026-07-01"), leg("T1", "IN", 300, "2026-07-01"), // Cash -> TFSA: a TFSA contribution
      leg("T1", "OUT", 1000, "2026-08-01"), leg("CASH", "IN", 1000, "2026-08-01"), // TFSA1 -> Cash -> TFSA2
      leg("CASH", "OUT", 1000, "2026-08-02"), leg("T2", "IN", 1000, "2026-08-02"),
    ];
    const tfsaRows = rows.filter((r) => typeOf(r.snapTradeAccountId) === "TFSA");
    const cashRows = rows.filter((r) => r.snapTradeAccountId === "CASH");

    it("Cash -> TFSA and TFSA1 -> Cash -> TFSA2 count toward the TFSA row; before I3 the TFSA row was 1000 and Cash had none", () => {
      expect(contributionsByAccountType(rows, 2026, typeOf)).toEqual([
        { accountType: "Cash", currency: "CAD", amount: 1000 },
        { accountType: "TFSA", currency: "CAD", amount: 2300 },
      ]);
    });

    it("each row equals that type's scope (accountType tfsa reads Cash as match-only; one Cash account has no pairs)", () => {
      expect(contributionsByAccountType(tfsaRows, 2026, typeOf, cashRows)).toEqual([{ accountType: "TFSA", currency: "CAD", amount: 2300 }]);
      expect(contributionsByAccountType(cashRows, 2026, typeOf)).toEqual([{ accountType: "Cash", currency: "CAD", amount: 1000 }]);
    });

    it("a same-day TFSA1 -> Cash -> TFSA2 counts whatever the dedupe keys' order", () => {
      for (const keys of [["a", "b", "c", "d"], ["d", "c", "b", "a"]]) {
        const sameDay = [
          { ...leg("T1", "OUT", 700, "2026-09-01"), dedupeKey: keys[0]! }, { ...leg("CASH", "IN", 700, "2026-09-01"), dedupeKey: keys[1]! },
          { ...leg("CASH", "OUT", 700, "2026-09-01"), dedupeKey: keys[2]! }, { ...leg("T2", "IN", 700, "2026-09-01"), dedupeKey: keys[3]! },
        ];
        expect(contributionsByAccountType(sameDay, 2026, typeOf)).toEqual([
          { accountType: "Cash", currency: "CAD", amount: 700 },
          { accountType: "TFSA", currency: "CAD", amount: 700 },
        ]);
      }
    });
  });
});
