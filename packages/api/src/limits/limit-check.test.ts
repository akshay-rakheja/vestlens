import { describe, expect, it } from "vitest";
import type { ExposureCash, ExposureItem } from "../analytics/exposure.js";
import type { ConcentrationLimit } from "../memory/memory-types.js";
import { checkLimits, limitsTouchingHolding, type LimitCheck, type LimitScope } from "./limit-check.js";

// Synthetic symbols and amounts only.
const NOW = new Date("2026-10-23T16:00:00Z"); // Friday
const item = (symbol: string, valueCad: number, over: Partial<ExposureItem> = {}): ExposureItem => ({
  holdingKey: `${symbol}|${over.currency ?? "CAD"}`, symbol, kind: "stock", valueCad, currency: "CAD", accountLabel: "TFSA", profile: null, ...over,
});
const cash = (valueCad: number, currency = "CAD"): ExposureCash => ({ currency, accountLabel: "TFSA", valueCad });
const scope = (items: ExposureItem[], cashItems: ExposureCash[], over: Partial<LimitScope> = {}): LimitScope => ({
  items, cash: cashItems, positionsAsOf: "2026-10-22", missingAccounts: 0, excludedAccounts: 0, unvalued: [], notConverted: [], subset: false, ...over,
});
const run = (limit: ConcentrationLimit, s: LimitScope, slug = "rule-1") => checkLimits({ limits: [{ slug, limit, scope: s }] }, NOW);

const profile = (over: Record<string, unknown>): any => ({ sector: null, sectorWeights: null, countryWeights: null, country: null, ...over });

describe("Bank of Canada rate date", () => {
  const s = scope([item("SHOP", 1_400, { currency: "USD" }), item("RY.TO", 100)], [cash(8_500)], { fxDate: "2026-10-22" });
  it("a converted scope names the rate date on each row, in the note, and keeps the (est.) line", () => {
    const [row] = run({ kind: "single_holding", maxPct: 10, target: "SHOP" }, s);
    expect(row!.line).toBe("SHOP 14% (est.), over your 10% limit");
    expect(row!.fxDate).toBe("2026-10-22");
    expect(row!.note).toContain("USD converted at the Bank of Canada rate of 2026-10-22");
  });
  it("can't tell rows name it too; an unconverted scope has neither", () => {
    const [cant] = run({ kind: "single_holding", maxPct: 10, target: "SHOP" }, { ...s, unvalued: ["QQQ"] });
    expect(cant).toMatchObject({ status: "cant_tell", fxDate: "2026-10-22" });
    const [plain] = run({ kind: "single_holding", maxPct: 10, target: "RY.TO" }, scope([item("RY.TO", 100)], [cash(900)]));
    expect(plain!.fxDate).toBeUndefined();
    expect(plain!.note).not.toContain("Bank of Canada");
  });
});

describe("single-holding limits", () => {
  const basic = scope([item("SHOP", 1_200), item("RY.TO", 1_100)], [cash(7_700)]);

  it("over: one row per listing above the limit, with the verbatim line and the basis note", () => {
    const rows = run({ kind: "single_holding", maxPct: 10 }, basic);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ slug: "rule-1", label: "SHOP", kind: "single_holding", maxPct: 10, status: "over", line: "SHOP 12%, over your 10% limit" });
    expect(rows[0]!.currentPct).toBeCloseTo(12, 6);
    expect(rows[1]!.line).toBe("RY.TO 11%, over your 10% limit");
    expect(rows[0]!.note).toContain("of your portfolio, cash included");
    expect(rows[0]!.line).not.toContain("cash included");
  });

  it("within: the largest listing, with the verbatim line", () => {
    const rows = run({ kind: "single_holding", maxPct: 15 }, basic);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "SHOP", status: "within", line: "SHOP 12% of your 15% limit" });
  });

  it("exactly at the limit is within", () => {
    expect(run({ kind: "single_holding", maxPct: 12 }, basic)[0]!.status).toBe("within");
  });

  it("a named holding is evaluated on its own", () => {
    const rows = run({ kind: "single_holding", target: "ry.to", maxPct: 10 }, basic);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.line).toBe("RY.TO 11%, over your 10% limit");
  });

  it("a named holding not held is 0%", () => {
    const rows = run({ kind: "single_holding", target: "ZZZ", maxPct: 10 }, basic);
    expect(rows[0]).toMatchObject({ label: "ZZZ", currentPct: 0, status: "within", line: "ZZZ 0% of your 10% limit" });
  });

  it("CAD and US listings: the limit is evaluated on the combined company, the listing rows are informational (A5)", () => {
    const s = scope([item("SHOP", 600), item("SHOP", 600, { currency: "USD", holdingKey: "SHOP|USD" })], [cash(8_800)]);
    const rows = run({ kind: "single_holding", target: "SHOP", maxPct: 10 }, s);
    expect(rows.map((r) => r.label)).toEqual(["SHOP (all listings)", "SHOP (CAD)", "SHOP (USD)"]);
    expect(rows[0]).toMatchObject({ status: "over", line: "SHOP (all listings) 12% (est.), over your 10% limit", groupKey: "SHOP|ALL" });
    expect(rows[0]!.informational).toBeUndefined();
    expect(rows[1]).toMatchObject({ informational: true, status: "over", currentPct: 6, line: "SHOP (CAD) 6% (est.), counted in SHOP (all listings)" });
    expect(rows[2]).toMatchObject({ informational: true, line: "SHOP (USD) 6% (est.), counted in SHOP (all listings)" });
    for (const r of rows) expect(r.note).not.toContain("not combined");
  });

  it("two listings under the limit together stay within; no target picks the company by its combined share", () => {
    const s = scope([item("TD.TO", 900), item("TD", 400, { currency: "USD", holdingKey: "TD|USD" }), item("RY.TO", 1_000)], [cash(7_700)]);
    const rows = run({ kind: "single_holding", maxPct: 20 }, s);
    expect(rows.map((r) => [r.label, r.status, r.informational ?? false])).toEqual([["TD (all listings)", "within", false], ["TD.TO", "within", true], ["TD", "within", true]]);
    const over = run({ kind: "single_holding", maxPct: 12 }, s);
    expect(over.filter((r) => !r.informational).map((r) => r.label)).toEqual(["TD (all listings)"]);
  });

  it("a limit named on one listing is evaluated on the company", () => {
    const s = scope([item("TD.TO", 900), item("TD", 400, { currency: "USD", holdingKey: "TD|USD" })], [cash(8_700)]);
    expect(run({ kind: "single_holding", target: "TD.TO", maxPct: 10 }, s)[0]).toMatchObject({ label: "TD (all listings)", status: "over" });
  });

  it("share classes are different securities: CTC and CTC.A are never combined", () => {
    const s = scope([item("CTC", 800), item("CTC.A", 700)], [cash(8_500)]);
    const rows = run({ kind: "single_holding", target: "CTC", maxPct: 10 }, s);
    expect(rows.map((r) => [r.label, r.status, r.informational ?? false])).toEqual([["CTC", "within", false]]);
  });

  it("one ticker on two exchanges but two companies (names disagree) is not combined", () => {
    const s = scope([
      item("T.TO", 800, { name: "TELUS Corp" }),
      item("T", 700, { currency: "USD", holdingKey: "T|USD", name: "AT&T Inc." }),
    ], [cash(8_500)]);
    const rows = run({ kind: "single_holding", target: "T", maxPct: 10 }, s);
    expect(rows.map((r) => [r.label, r.status, r.informational ?? false])).toEqual([["T", "within", false]]);
    // The row says the other listing under this ticker was not combined (review 4).
    expect(rows[0]!.note).toContain("other listings not combined");
    expect(run({ kind: "single_holding", target: "T.TO", maxPct: 10 }, s)[0]!.note).toContain("other listings not combined");
    // Names that agree, in different styles, are one company.
    const same = scope([
      item("TD.TO", 800, { name: "Toronto-Dominion Bank" }),
      item("TD", 700, { currency: "USD", holdingKey: "TD|USD", name: "THE TORONTO DOMINION BANK" }),
    ], [cash(8_500)]);
    expect(run({ kind: "single_holding", target: "TD", maxPct: 10 }, same)[0]).toMatchObject({ label: "TD (all listings)", status: "over" });
  });
});

describe("est. follows the figures (B11)", () => {
  it("an all-CAD holding limit has no (est.); a converted amount in the scope does", () => {
    const plain = scope([item("SHOP", 1_200)], [cash(8_800)]);
    expect(run({ kind: "single_holding", target: "SHOP", maxPct: 10 }, plain)[0]).toMatchObject({ line: "SHOP 12%, over your 10% limit", estimated: false });
    expect(run({ kind: "single_holding", target: "SHOP", maxPct: 20 }, plain)[0]!.line).toBe("SHOP 12% of your 20% limit");
    expect(run({ kind: "single_holding", target: "ZZZ", maxPct: 20 }, plain)[0]!.line).toBe("ZZZ 0% of your 20% limit");
    const fx = scope([item("SHOP", 1_200), item("USX", 100, { currency: "USD", holdingKey: "USX|USD" })], [cash(8_700)]);
    expect(run({ kind: "single_holding", target: "SHOP", maxPct: 10 }, fx)[0]).toMatchObject({ line: "SHOP 12% (est.), over your 10% limit", estimated: true });
  });
  it("USD cash in the denominator makes a CAD holding's share est.", () => {
    const fx = scope([item("SHOP", 1_200)], [cash(8_800, "USD")]);
    expect(run({ kind: "single_holding", target: "SHOP", maxPct: 10 }, fx)[0]!.line).toBe("SHOP 12% (est.), over your 10% limit");
  });
  it("an asset-class share of an all-CAD scope has no (est.); a fund's sector share does", () => {
    const plain = scope([item("AAA", 5_000), item("XEQT", 2_000, { kind: "etf", profile: profile({ sectorWeights: { Technology: 1 } }) })], [cash(3_000)]);
    expect(run({ kind: "asset_class", target: "cash", maxPct: 20 }, plain)[0]!.line).toBe("Cash 30%, over your 20% limit");
    expect(run({ kind: "sector", target: "Technology", maxPct: 10 }, plain)[0]!.line).toBe("Technology 20% (est.), over your 10% limit");
  });
});

describe("a margin debit (A13)", () => {
  // Positions 100,000, cash -40,000: net equity, the brokerage total, is 60,000.
  const s = scope([item("AAA", 100_000)], [cash(-40_000)]);
  it("the share is of net equity, can exceed 100%, and says so", () => {
    const [row] = run({ kind: "single_holding", target: "AAA", maxPct: 90 }, s);
    expect(row!.currentPct).toBeCloseTo(166.666667, 4);
    expect(row).toMatchObject({ status: "over", line: "AAA 166.7%, over your 90% limit" });
    expect(row!.note).toContain("net of a margin debit (the brokerage total), so a share can be over 100%");
  });
  it("without a debit nothing changes", () => {
    const [row] = run({ kind: "single_holding", target: "AAA", maxPct: 90 }, scope([item("AAA", 100_000)], [cash(40_000)]));
    expect(row!.currentPct).toBeCloseTo(71.428571, 4);
    expect(row!.note).not.toContain("margin");
  });
  it("a trivial negative cash balance (under 1% of the positions) is not called a margin debit (review 5)", () => {
    const [row] = run({ kind: "single_holding", target: "AAA", maxPct: 90 }, scope([item("AAA", 100_000)], [cash(-50)]));
    expect(row!.note).not.toContain("margin");
    // At 1% it is.
    expect(run({ kind: "single_holding", target: "AAA", maxPct: 90 }, scope([item("AAA", 100_000)], [cash(-1_000)]))[0]!.note).toContain("net of a margin debit");
  });
  it("a debit as large as the holdings leaves nothing to measure", () => {
    expect(run({ kind: "single_holding", target: "AAA", maxPct: 90 }, scope([item("AAA", 100)], [cash(-100)]))[0]).toMatchObject({ status: "cant_tell", currentPct: null });
  });
});

describe("a managed account left out of the total (A9)", () => {
  it("each row names it, in the dashboard's words", () => {
    const [row] = run({ kind: "single_holding", target: "SHOP", maxPct: 10 }, scope([item("SHOP", 1_200)], [cash(8_800)], { notInTotal: ["Managed RRSP"] }));
    expect(row!.note).toContain("Not included in the total: Managed RRSP. SnapTrade doesn't provide the value of Wealthsimple managed portfolios");
    expect(run({ kind: "single_holding", target: "SHOP", maxPct: 10 }, scope([item("SHOP", 1_200)], [cash(8_800)]))[0]!.note).not.toContain("Not included");
  });
});

describe("sector limits (Review Focus 3)", () => {
  // Technology: AAA 2,000 + 25% of XEQT 4,000 = 3,000 (30%); Financial Services 3,000 (30%); ZZZ unclassified 1,000 (10%).
  const s = scope([
    item("AAA", 2_000, { profile: profile({ sector: "Technology" }) }),
    item("XEQT", 4_000, { kind: "etf", profile: profile({ sectorWeights: { Technology: 0.25, "Financial Services": 0.75 } }) }),
    item("ZZZ", 1_000, { kind: "etf" }),
  ], [cash(3_000)]);

  it("over on the classified share; the unclassified holdings and their share are stated", () => {
    const [row] = run({ kind: "sector", target: "technology", maxPct: 25 }, s);
    expect(row).toMatchObject({ label: "Technology", status: "over", line: "Technology 30% (est.), over your 25% limit", unclassifiedPct: 10 });
    expect(row!.currentPct).toBeCloseTo(30, 6);
    expect(row!.note).toContain("ZZZ");
    expect(row!.note).toContain("10%");
    expect(row!.note).toContain("not in any sector");
  });

  it("can't tell when the unclassified share could take it over the limit; the classified share is still given", () => {
    const [row] = run({ kind: "sector", target: "Technology", maxPct: 35 }, s);
    expect(row).toMatchObject({ status: "cant_tell", unclassifiedPct: 10 });
    expect(row!.currentPct).toBeCloseTo(30, 6);
    expect(row!.line).toBe("Technology 30% (est.) classified, 10% unclassified: can't tell against your 35% limit");
  });

  it("within when even all of the unclassified share would stay under", () => {
    const [row] = run({ kind: "sector", target: "Technology", maxPct: 45 }, s);
    expect(row).toMatchObject({ status: "within", line: "Technology 30% (est.) of your 45% limit", unclassifiedPct: 10 });
  });

  it("no target: every sector over the limit gets a row", () => {
    const rows = run({ kind: "sector", maxPct: 25 }, s);
    expect(rows.map((r) => [r.label, r.status])).toEqual([["Financial Services", "over"], ["Technology", "over"]]);
  });

  it("a named sector with no classified holding is 0%, and the note lists the sectors held", () => {
    const [row] = run({ kind: "sector", target: "Energy", maxPct: 15 }, s);
    expect(row).toMatchObject({ label: "Energy", currentPct: 0, status: "within" });
    expect(row!.note).toContain("Technology");
  });
});

describe("asset-class limits", () => {
  it("cash share of the portfolio", () => {
    const s = scope([item("AAA", 5_000), item("XEQT", 2_000, { kind: "etf" })], [cash(3_000)]);
    const [row] = run({ kind: "asset_class", target: "cash", maxPct: 20 }, s);
    expect(row).toMatchObject({ label: "Cash", status: "over", line: "Cash 30%, over your 20% limit" });
    const [etf] = run({ kind: "asset_class", target: "ETFs", maxPct: 25 }, s);
    expect(etf).toMatchObject({ label: "ETFs & funds", status: "within", line: "ETFs & funds 20% of your 25% limit" });
  });
});

describe("can't tell", () => {
  const s = scope([item("SHOP", 1_200)], [cash(8_800)]);

  it("an account subset with a disconnected account (§11a.6)", () => {
    const [row] = run({ kind: "single_holding", maxPct: 10, accounts: ["0123456789abcdef"] }, { ...s, subset: true, missingAccounts: 1 });
    expect(row).toMatchObject({ status: "cant_tell", currentPct: null });
    expect(row!.note).toContain("no longer connected");
    expect(row!.line).toContain("can't tell");
  });

  it("stale positions", () => {
    const [row] = run({ kind: "sector", target: "Technology", maxPct: 10 }, { ...s, positionsAsOf: "2026-10-16" });
    expect(row).toMatchObject({ status: "cant_tell", currentPct: null, label: "Technology" });
    expect(row!.note).toContain("latest positions are more than 3 trading days old");
  });

  it("3 trading days old is still fresh", () => {
    expect(run({ kind: "single_holding", maxPct: 10 }, { ...s, positionsAsOf: "2026-10-20" })[0]!.status).toBe("over");
  });

  it("no positions date", () => {
    expect(run({ kind: "single_holding", maxPct: 10 }, { ...s, positionsAsOf: null })[0]!.status).toBe("cant_tell");
  });

  it("a value that could not be converted to CAD", () => {
    const [row] = run({ kind: "single_holding", maxPct: 10 }, { ...s, notConverted: ["USD"] });
    expect(row).toMatchObject({ status: "cant_tell", currentPct: null });
    expect(row!.note).toContain("USD");
  });

  it("nothing to measure", () => {
    expect(run({ kind: "single_holding", maxPct: 10 }, scope([], []))[0]).toMatchObject({ status: "cant_tell", currentPct: null });
  });

  it("an unvalued holding in the scope: can't tell, with no target (I-1)", () => {
    const [row] = run({ kind: "single_holding", maxPct: 50 }, { ...s, unvalued: ["QQQ"] });
    expect(row).toMatchObject({ status: "cant_tell", currentPct: null });
    expect(row!.note).toContain("a holding in this limit has no reported value");
    expect(row!.note).toContain("QQQ");
  });

  it("an unvalued named holding: can't tell, never 0% (I-1)", () => {
    const [row] = run({ kind: "single_holding", target: "QQQ", maxPct: 10 }, { ...s, unvalued: ["QQQ"] });
    expect(row).toMatchObject({ label: "QQQ", status: "cant_tell", currentPct: null });
    expect(row!.line).not.toMatch(/\d+% \(est\.\)/);
  });

  it("an unvalued holding makes sector and asset-class limits can't tell too", () => {
    for (const limit of [{ kind: "sector", target: "Technology", maxPct: 50 }, { kind: "asset_class", target: "cash", maxPct: 99 }] as ConcentrationLimit[]) {
      expect(run(limit, { ...s, unvalued: ["QQQ"] })[0]).toMatchObject({ status: "cant_tell", currentPct: null });
    }
  });

  it("closed or credit accounts dropped from a subset are noted (M-5)", () => {
    const [row] = run({ kind: "single_holding", maxPct: 10, accounts: ["0123456789abcdef"] }, { ...s, subset: true, excludedAccounts: 1 });
    expect(row!.status).toBe("over");
    expect(row!.note).toContain("1 account in this limit is closed or a credit product and is not counted");
  });

  it("a subset says its basis is the chosen accounts", () => {
    const [row] = run({ kind: "single_holding", maxPct: 10, accounts: ["0123456789abcdef"] }, { ...s, subset: true });
    expect(row!.note).toContain("of the chosen accounts, cash included");
  });
});

describe("copy", () => {
  it("no advice words in any VestLens string; the user's own target passes through", () => {
    const banned = /should|sell|buy|recommend|consider/i;
    const s = scope([item("AAA", 2_000, { profile: profile({ sector: "Technology" }) }), item("ZZZ", 1_000, { kind: "etf" })], [cash(3_000)]);
    const rows: LimitCheck[] = [
      ...run({ kind: "single_holding", maxPct: 10 }, s),
      ...run({ kind: "single_holding", maxPct: 90 }, s),
      ...run({ kind: "sector", target: "Technology", maxPct: 20 }, s),
      ...run({ kind: "sector", target: "Technology", maxPct: 40 }, s),
      ...run({ kind: "sector", target: "Energy", maxPct: 40 }, s),
      ...run({ kind: "asset_class", target: "cash", maxPct: 10 }, s),
      ...run({ kind: "single_holding", maxPct: 10 }, { ...s, missingAccounts: 1, subset: true }),
      ...run({ kind: "single_holding", maxPct: 10 }, { ...s, positionsAsOf: "2026-01-01" }),
      ...run({ kind: "single_holding", maxPct: 10 }, { ...s, notConverted: ["EUR"] }),
      ...run({ kind: "single_holding", maxPct: 10 }, scope([], [])),
      ...run({ kind: "single_holding", maxPct: 10 }, { ...s, unvalued: ["QQQ"] }),
      ...run({ kind: "single_holding", maxPct: 10 }, { ...s, subset: true, excludedAccounts: 2 }),
    ];
    for (const r of rows) for (const text of [r.line, r.note ?? ""]) expect(text).not.toMatch(banned);
    const [own] = run({ kind: "sector", target: "Should Buy Sector", maxPct: 10 }, s);
    expect(own!.label).toBe("Should Buy Sector");
  });
});

describe("limitsTouchingHolding (the holding view)", () => {
  const items = [
    item("SHOP", 1_200, { profile: profile({ sector: "Technology" }) }),
    item("RY.TO", 600, { profile: profile({ sector: "Financial Services" }) }),
    item("XEQT.TO", 1_000, { kind: "etf", profile: profile({ sectorWeights: { Technology: 0.3, "Financial Services": 0.2 } }) }),
  ];
  const s = scope(items, [cash(7_200)]);
  const touching = (limits: Array<{ slug: string; limit: ConcentrationLimit }>, symbol: string) =>
    limitsTouchingHolding({ limits: limits.map((l) => ({ ...l, scope: s })) }, symbol, NOW);

  it("a single-holding limit on it, or on any one holding, gives its own line; one on another ticker does not", () => {
    const rows = touching([
      { slug: "a", limit: { kind: "single_holding", maxPct: 10, target: "SHOP" } },
      { slug: "b", limit: { kind: "single_holding", maxPct: 15 } },
      { slug: "c", limit: { kind: "single_holding", maxPct: 5, target: "RY.TO" } },
    ], "RY.TO");
    expect(rows.map((r) => [r.slug, r.line])).toEqual([["b", "RY.TO 6% of your 15% limit"], ["c", "RY.TO 6%, over your 5% limit"]]);
  });

  it("a company held under two listings: either listing's view shows the combined row and its own listing row", () => {
    const both = scope([item("SHOP", 600), item("SHOP.TO", 500)], [cash(8_900)]);
    const rows = limitsTouchingHolding({ limits: [{ slug: "a", limit: { kind: "single_holding", maxPct: 10, target: "SHOP" }, scope: both }] }, "SHOP.TO", NOW);
    expect(rows.map((r) => r.label)).toEqual(["SHOP (all listings)", "SHOP.TO"]);
    expect(rows[0]).toMatchObject({ status: "over", line: "SHOP (all listings) 11%, over your 10% limit" });
  });

  it("a sector limit touches a stock in that sector, and an untargeted one gives its sector's line", () => {
    const rows = touching([
      { slug: "t", limit: { kind: "sector", maxPct: 10, target: "Technology" } },
      { slug: "any", limit: { kind: "sector", maxPct: 50 } },
      { slug: "fin", limit: { kind: "sector", maxPct: 50, target: "Financial Services" } },
    ], "SHOP");
    expect(rows.map((r) => r.slug)).toEqual(["t", "any"]);
    expect(rows[1]!.label).toBe("Technology");
  });

  it("a fund touches the targeted sector limits of the sectors it holds", () => {
    const rows = touching([{ slug: "fin", limit: { kind: "sector", maxPct: 50, target: "Financial Services" } }], "XEQT.TO");
    expect(rows.map((r) => r.slug)).toEqual(["fin"]);
  });

  it("an asset-class limit touches a holding in that class", () => {
    const rows = touching([
      { slug: "funds", limit: { kind: "asset_class", maxPct: 5, target: "ETFs" } },
      { slug: "cash", limit: { kind: "asset_class", maxPct: 50, target: "cash" } },
    ], "XEQT.TO");
    expect(rows.map((r) => r.slug)).toEqual(["funds"]);
    expect(rows[0]!.status).toBe("over");
  });

  it("a whole-limit can't tell (stale positions) is shown for a limit that touches it", () => {
    const rows = limitsTouchingHolding({ limits: [{ slug: "b", limit: { kind: "single_holding", maxPct: 15 }, scope: { ...s, positionsAsOf: "2026-10-01" } }] }, "SHOP", NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("cant_tell");
    expect(rows[0]!.currentPct).toBeNull();
  });

  it("an account-subset limit whose accounts don't hold it is not shown", () => {
    const rows = limitsTouchingHolding({ limits: [{ slug: "sub", limit: { kind: "single_holding", maxPct: 15, accounts: ["account:x"] }, scope: { ...scope([item("RY.TO", 600)], [cash(400)]), subset: true } }] }, "SHOP", NOW);
    expect(rows).toEqual([]);
  });
});
