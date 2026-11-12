import { describe, expect, it } from "vitest";
import type { StoredActivity } from "../history/stored-activity.js";
import { externalFlows, matchedTransferKeys, matchedTransferPairs, scopedTransferKeys } from "./flows.js";

let n = 0;
const act = (account: string, o: Partial<StoredActivity>): StoredActivity => ({
  snapTradeAccountId: account, dedupeKey: `k${n++}`, type: "CONTRIBUTION", symbol: null, securityCurrency: null, isOption: false,
  units: null, price: null, amount: null, fee: null, fxRate: null, currency: "CAD", tradeDate: "2026-03-02", settlementDate: null, description: null, ...o,
});
const base = { scopeCurrency: "CAD", toScope: (a: number, c: string) => (c === "CAD" ? a : c === "USD" ? a * 1.4 : null), priceInKind: () => null };
const flat = (r: ReturnType<typeof externalFlows>) => Object.fromEntries(r.byDate);

describe("externalFlows", () => {
  it("contributions are positive, withdrawals negative; dividends and fees are not flows", () => {
    const r = externalFlows({ ...base, scope: "account", activities: [
      act("A", { type: "CONTRIBUTION", amount: 1000, tradeDate: "2026-03-02" }),
      act("A", { type: "WITHDRAWAL", amount: -250, tradeDate: "2026-03-05" }),
      act("A", { type: "DIVIDEND", amount: 12, tradeDate: "2026-03-05" }),
      act("A", { type: "FEE", amount: -3, tradeDate: "2026-03-05" }),
    ] });
    expect(flat(r)).toEqual({ "2026-03-02": 1000, "2026-03-05": -250 });
    expect(r.unknownDates.size).toBe(0);
  });

  it("internal transfers count per account but net out at portfolio level, even settling days apart", () => {
    const rows = [
      act("A", { type: "INTERNAL_CASH_TRANSFER_OUT", amount: -500, tradeDate: "2026-03-02" }),
      act("B", { type: "INTERNAL_CASH_TRANSFER_IN", amount: 500, tradeDate: "2026-03-04" }),
    ];
    expect(flat(externalFlows({ ...base, scope: "account", activities: [rows[0]] }))).toEqual({ "2026-03-02": -500 });
    expect(flat(externalFlows({ ...base, scope: "portfolio", activities: rows }))).toEqual({});
  });

  it("an unmatched internal leg stays a flow at portfolio level", () => {
    const r = externalFlows({ ...base, scope: "portfolio", activities: [act("A", { type: "INTERNAL_CASH_TRANSFER_OUT", amount: -500, tradeDate: "2026-03-02" })] });
    expect(flat(r)).toEqual({ "2026-03-02": -500 });
  });

  it("legs more than 3 days apart are not matched", () => {
    const r = externalFlows({ ...base, scope: "portfolio", activities: [
      act("A", { type: "INTERNAL_CASH_TRANSFER_OUT", amount: -500, tradeDate: "2026-03-02" }),
      act("B", { type: "INTERNAL_CASH_TRANSFER_IN", amount: 500, tradeDate: "2026-03-09" }),
    ] });
    expect(flat(r)).toEqual({ "2026-03-02": -500, "2026-03-09": 500 });
  });

  it("in-kind transfer in counts at market value; reported price wins; unpriceable marks the date unknown", () => {
    const priced = externalFlows({ ...base, scope: "account", priceInKind: () => 50, activities: [act("A", { type: "TRANSFER", symbol: "AAA", units: 10, amount: 0, tradeDate: "2026-03-03" })] });
    expect(flat(priced)).toEqual({ "2026-03-03": 500 });
    const reported = externalFlows({ ...base, scope: "account", priceInKind: () => 50, activities: [act("A", { type: "TRANSFER", symbol: "AAA", units: 10, price: 60, amount: 0, securityCurrency: "CAD", tradeDate: "2026-03-03" })] });
    expect(flat(reported)).toEqual({ "2026-03-03": 600 });
    const unknown = externalFlows({ ...base, scope: "account", activities: [act("A", { type: "TRANSFER", symbol: "AAA", units: 10, amount: 0, tradeDate: "2026-03-03" })] });
    expect(flat(unknown)).toEqual({});
    expect([...unknown.unknownDates]).toEqual(["2026-03-03"]);
  });

  it("in-kind moves between own accounts net out at portfolio level", () => {
    const r = externalFlows({ ...base, scope: "portfolio", priceInKind: () => 50, activities: [
      act("A", { type: "TRANSFER", symbol: "aaa ", units: -10, amount: 0, tradeDate: "2026-03-03" }),
      act("B", { type: "TRANSFER", symbol: "AAA", units: 10, amount: 0, tradeDate: "2026-03-05" }),
    ] });
    expect(flat(r)).toEqual({});
  });

  it("converts foreign-currency cash flows and marks unconvertible dates unknown", () => {
    const r = externalFlows({ ...base, scope: "account", activities: [
      act("A", { type: "CONTRIBUTION", amount: 100, currency: "USD", tradeDate: "2026-03-02" }),
      act("A", { type: "CONTRIBUTION", amount: 100, currency: "EUR", tradeDate: "2026-03-03" }),
    ] });
    expect(flat(r)).toEqual({ "2026-03-02": 140 });
    expect([...r.unknownDates]).toEqual(["2026-03-03"]);
  });
});

describe("externalFlows on the 2026-10-15 probe's type list (F2)", () => {
  // Every type seen in the probe, with an amount of the probe's sign; see history/sign-rules.ts.
  const probe: Array<[string, Partial<StoredActivity>]> = [
    ["BUY", { amount: -100, units: 1, symbol: "AAA" }], ["SELL", { amount: 100, units: -1, symbol: "AAA" }],
    ["CONTRIBUTION", { amount: 1000 }], ["DIVIDEND", { amount: 5 }], ["INTEREST", { amount: 2 }], ["REIMBURSEMENT", { amount: 7 }],
    ["PROMOTION", { amount: 25 }], ["INTERNAL_CASH_TRANSFER_IN", { amount: 300 }], ["WITHDRAWAL", { amount: -200 }], ["FEE", { amount: -1 }],
    ["TAX", { amount: -3 }], ["INTERNAL_CASH_TRANSFER_OUT", { amount: -40 }], ["SPEND", { amount: 50 }], ["CREDIT_CARD_PAYMENT", { amount: 2000 }],
    ["FUNDS_CONVERSION", { amount: 70 }], ["CORPORATE_ACTION", { amount: 0, units: 1, symbol: "AAA" }], ["OPTIONS_MULTILEG", { amount: 4 }],
    ["OPTIONS_SHORT_EXPIRY", { amount: 0, units: 1 }], ["OPTIONEXPIRATION", { amount: 0, units: 1 }], ["PORTFOLIO_INVESTMENT", { amount: 9 }],
    ["PORTFOLIO_REBALANCING", { amount: 9 }], ["FUNDS_INVESTED", { amount: 9 }], ["CREDIT_CARD", { amount: 80 }],
  ];
  it("spending and card payments out of an included cash account are outflows; everything else but deposits is return", () => {
    const activities = probe.map(([type, o], i) => act("A", { type, tradeDate: `2026-03-${String(i + 1).padStart(2, "0")}`, ...o }));
    const r = externalFlows({ ...base, scope: "account", activities });
    expect(flat(r)).toEqual({
      "2026-03-03": 1000, // CONTRIBUTION
      "2026-03-08": 300, // INTERNAL_CASH_TRANSFER_IN
      "2026-03-09": -200, // WITHDRAWAL
      "2026-03-12": -40, // INTERNAL_CASH_TRANSFER_OUT
      "2026-03-13": -50, // SPEND (positive outflow)
      "2026-03-14": -2000, // CREDIT_CARD_PAYMENT (positive outflow)
    });
    expect(r.unknownDates.size).toBe(0);
  });
  it("a card payment is not netted against an internal transfer at portfolio level", () => {
    const r = externalFlows({ ...base, scope: "portfolio", activities: [
      act("CASH", { type: "CREDIT_CARD_PAYMENT", amount: 2000, tradeDate: "2026-03-02" }),
      act("B", { type: "INTERNAL_CASH_TRANSFER_IN", amount: 2000, tradeDate: "2026-03-02" }),
    ] });
    expect(flat(r)).toEqual({ "2026-03-02": 0 });
  });
});

describe("externalFlows minors", () => {
  it("a cash flow with no currency marks its date unknown instead of being dropped", () => {
    const r = externalFlows({ ...base, scope: "account", activities: [act("A", { type: "CONTRIBUTION", amount: 100, currency: null, tradeDate: "2026-03-02" })] });
    expect(flat(r)).toEqual({});
    expect([...r.unknownDates]).toEqual(["2026-03-02"]);
  });
});

describe("externalFlows inScope (brief 6)", () => {
  it("a leg outside its account's valued window is not counted; the other leg is a move to an untracked account, not a deposit", () => {
    const rows = [
      act("T", { type: "INTERNAL_CASH_TRANSFER_OUT", amount: -900, tradeDate: "2026-03-05" }),
      act("C", { type: "INTERNAL_CASH_TRANSFER_IN", amount: 900, tradeDate: "2026-03-05" }),
      act("C", { type: "CONTRIBUTION", amount: 50, tradeDate: "2026-03-06" }),
    ];
    const r = externalFlows({ ...base, scope: "portfolio", activities: rows, inScope: (id) => id !== "C" });
    expect(flat(r)).toEqual({});
    expect(Object.fromEntries(r.trackingTransfers!)).toEqual({ "2026-03-05": -900 });
    expect(flat(externalFlows({ ...base, scope: "portfolio", activities: rows, inScope: () => true }))).toEqual({ "2026-03-06": 50 });
  });

  it("an in-kind reported price is in the row currency when it differs from the security currency (brief 8)", () => {
    const row = act("A", { type: "TRANSFER", symbol: "XUS", units: 10, price: 29.85, amount: 0, currency: "CAD", securityCurrency: "USD", tradeDate: "2026-03-03" });
    const cad = externalFlows({ ...base, scope: "account", activities: [row] });
    expect(flat(cad)["2026-03-03"]).toBeCloseTo(298.5, 6);
    const usd = externalFlows({ ...base, scopeCurrency: "USD", toScope: (a: number, c: string) => (c === "USD" ? a : c === "CAD" ? a / 1.4 : null), scope: "account", activities: [row] });
    expect(flat(usd)["2026-03-03"]).toBeCloseTo(298.5 / 1.4, 6);
    // Same currencies: unchanged.
    const same = externalFlows({ ...base, scope: "account", activities: [{ ...row, currency: "USD" }] });
    expect(flat(same)["2026-03-03"]).toBeCloseTo(298.5 * 1.4, 6);
  });

  it("records each external flow by account, never the matched transfer legs", () => {
    const r = externalFlows({ ...base, scope: "portfolio", activities: [
      act("A", { type: "INTERNAL_CASH_TRANSFER_OUT", amount: -500, tradeDate: "2026-03-02" }),
      act("B", { type: "INTERNAL_CASH_TRANSFER_IN", amount: 500, tradeDate: "2026-03-04" }),
      act("A", { type: "DEPOSIT", amount: 300, tradeDate: "2026-03-05" }),
      act("B", { type: "WITHDRAWAL", amount: -100, tradeDate: "2026-03-06" }),
    ] });
    expect(r.entries).toEqual([
      { date: "2026-03-05", accountId: "A", value: 300 },
      { date: "2026-03-06", accountId: "B", value: -100 },
    ]);
  });
});

describe("scopedTransferKeys", () => {
  const out = (account: string, amount: number, tradeDate: string) => act(account, { type: "INTERNAL_CASH_TRANSFER_OUT", amount: -amount, tradeDate });
  const into = (account: string, amount: number, tradeDate: string) => act(account, { type: "INTERNAL_CASH_TRANSFER_IN", amount, tradeDate });

  it("without match-only rows it is matchedTransferKeys of the scope", () => {
    const rows = [out("A", 500, "2026-03-02"), into("B", 500, "2026-03-03"), into("B", 70, "2026-03-03")];
    expect(scopedTransferKeys(rows, [])).toEqual(matchedTransferKeys(rows));
    expect(scopedTransferKeys(rows)).toEqual(new Set([rows[0]!.dedupeKey, rows[1]!.dedupeKey]));
  });

  it("nets a pair with both legs in scope; a leg whose partner is outside stays a real flow", () => {
    const a = out("T1", 500, "2026-02-01"); const b = into("T2", 500, "2026-02-01");
    const cashOut = out("CASH", 300, "2026-07-01"); const t1In = into("T1", 300, "2026-07-01");
    expect(scopedTransferKeys([a, b, t1In], [cashOut])).toEqual(new Set([a.dedupeKey, b.dedupeKey]));
  });

  it("TFSA1 -> Cash (day 0) then Cash -> TFSA2 (day 1): the scope legs pair with Cash, not with each other", () => {
    const t1Out = out("T1", 1000, "2026-08-01"); const t2In = into("T2", 1000, "2026-08-02");
    const cashIn = into("CASH", 1000, "2026-08-01"); const cashOut = out("CASH", 1000, "2026-08-02");
    expect(scopedTransferKeys([t1Out, t2In], [cashIn, cashOut])).toEqual(new Set());
    // Either argument order gives the same pairs (matching sorts by date, then dedupe key).
    expect(scopedTransferKeys([t2In, t1Out], [cashOut, cashIn])).toEqual(new Set());
    // Scope rows alone (the old behaviour) would have paired them.
    expect(matchedTransferKeys([t1Out, t2In])).toEqual(new Set([t1Out.dedupeKey, t2In.dedupeKey]));
  });

  it("a same-day TFSA1 -> Cash -> TFSA2 is never netted, whichever order the dedupe keys give (I1)", () => {
    const day = "2026-08-01";
    const legs = (tfsaKey: string, cashKey: string) => ({
      t1Out: { ...out("T1", 1000, day), dedupeKey: `${tfsaKey}1` }, t2In: { ...into("T2", 1000, day), dedupeKey: `${tfsaKey}2` },
      cashIn: { ...into("CASH", 1000, day), dedupeKey: `${cashKey}1` }, cashOut: { ...out("CASH", 1000, day), dedupeKey: `${cashKey}2` },
    });
    // Whichever keys sort first, each TFSA leg pairs with a Cash leg (a maximum matching, A1), never with the other TFSA leg.
    const first = legs("a", "z");
    expect(matchedTransferPairs([first.t1Out, first.t2In, first.cashIn, first.cashOut])).not.toContainEqual([first.t1Out.dedupeKey, first.t2In.dedupeKey]);
    expect(scopedTransferKeys([first.t1Out, first.t2In], [first.cashIn, first.cashOut])).toEqual(new Set());
    const second = legs("z", "a");
    expect(matchedTransferPairs([second.t1Out, second.t2In, second.cashIn, second.cashOut])).not.toContainEqual([second.t1Out.dedupeKey, second.t2In.dedupeKey]);
    expect(scopedTransferKeys([second.t1Out, second.t2In], [second.cashIn, second.cashOut])).toEqual(new Set());
    // Only one Cash leg seen (the other still syncing): the TFSA legs could have gone through Cash, so they count.
    expect(scopedTransferKeys([first.t1Out, first.t2In], [first.cashIn])).toEqual(new Set());
  });

  /** Every ordering of four legs; the dedupe keys follow the ordering, so the candidate sort sees each one. */
  const orderings = <T,>(items: T[]): T[][] => (items.length <= 1 ? [items] : items.flatMap((x, i) => orderings([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest])));
  const keyed = (rows: StoredActivity[]) => rows.map((r, i) => ({ ...r, dedupeKey: `k${i}` }));

  it("a same-day TFSA1 -> Cash -> TFSA2 pairs each TFSA leg with a Cash leg, whatever the dedupe keys' order (A1)", () => {
    const day = "2026-08-01";
    const legs = [out("T1", 5000, day), into("T2", 5000, day), into("CASH", 5000, day), out("CASH", 5000, day)];
    for (const ordering of orderings(legs)) {
      const rows = keyed(ordering);
      // All accounts in scope (the activity totals at all-accounts scope): every leg nets, so deposits and withdrawals are 0.
      expect(matchedTransferKeys(rows), rows.map((r) => r.snapTradeAccountId).join(",")).toEqual(new Set(rows.map((r) => r.dedupeKey)));
      const pairs = matchedTransferPairs(rows);
      expect(pairs).toHaveLength(2);
      for (const [o, i] of pairs) {
        const outLeg = rows.find((r) => r.dedupeKey === o)!; const inLeg = rows.find((r) => r.dedupeKey === i)!;
        expect([outLeg.snapTradeAccountId, inLeg.snapTradeAccountId].includes("CASH")).toBe(true);
      }
      // Per-type scope with Cash match-only: the TFSA legs never net.
      const tfsa = rows.filter((r) => r.snapTradeAccountId !== "CASH"); const cash = rows.filter((r) => r.snapTradeAccountId === "CASH");
      expect(scopedTransferKeys(tfsa, cash)).toEqual(new Set());
    }
  });

  it("a direct same-day TFSA1 -> TFSA2 with no matching Cash leg still nets (I1)", () => {
    const day = "2026-08-01";
    const t1Out = { ...out("T1", 1000, day), dedupeKey: "m1" }; const t2In = { ...into("T2", 1000, day), dedupeKey: "m2" };
    // Cash rows that cannot be partners: another amount, the same direction, another currency, or too many days away.
    const unrelated = [
      { ...into("CASH", 999, day), dedupeKey: "a1" }, { ...out("CASH", 1000, day), dedupeKey: "a2" }, // out pairs only with an in leg
      { ...act("CASH", { type: "INTERNAL_CASH_TRANSFER_IN", amount: 1000, currency: "USD", tradeDate: day }), dedupeKey: "a3" },
      { ...into("CASH", 1000, "2026-08-10"), dedupeKey: "a4" },
    ];
    // a2 (Cash out, 1000) is a partner for T2's in leg: drop it to keep the transfer direct.
    const direct = unrelated.filter((r) => r.dedupeKey !== "a2");
    expect(scopedTransferKeys([t1Out, t2In], direct)).toEqual(new Set([t1Out.dedupeKey, t2In.dedupeKey]));
    expect(scopedTransferKeys([t2In, t1Out], [...direct].reverse())).toEqual(new Set([t1Out.dedupeKey, t2In.dedupeKey]));
    // With a Cash out leg of the same size that day, the in leg could be from Cash: both count.
    expect(scopedTransferKeys([t1Out, t2In], unrelated)).toEqual(new Set());
  });
});
