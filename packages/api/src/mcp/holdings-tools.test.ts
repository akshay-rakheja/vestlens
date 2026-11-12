import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings/settings-service.js";
import {
  buildHoldingsPayload, HOLDINGS_WIDGET, HOLDINGS_WIDGET_URI, holdingsInput, holdingsModelCopy, HoldingsScopeError, holdingsText, holdingsToolDefinitions,
} from "./holdings-tools.js";
import { buildHoldingsResult } from "./holdings-tools.js";
import { MarketDataService, MemoryMarketDataCache } from "../market-data/market-data-service.js";

const cls = (bucket: string, group: string, included: boolean, label: string): any => ({ label, bucket, group, includedInPortfolioTotal: included, isClosed: group === "closed" });
const pos = (over: Record<string, unknown>): any => ({ instrumentId: "i", kind: "etf", symbol: "VFV", description: null, units: 10, price: 100, costBasis: 80, marketValue: 1000, unrealizedGain: null, currency: "CAD", cashEquivalent: false, ...over });
const portfolio = (positionsA: any[] = [pos({})], positionsB: any[] = []): any => ({
  generatedAt: "2026-10-16T15:00:00.000Z",
  accounts: [
    { id: "TFSA", name: "Synthetic TFSA", classification: cls("tfsa", "registered", true, "TFSA"), value: null, balances: [{ currency: "CAD", cash: 10, buyingPower: null }], positions: positionsA },
    { id: "RRSP", name: "Synthetic RRSP", classification: cls("rrsp", "registered", true, "RRSP"), value: null, balances: [], positions: positionsB },
    { id: "CARD", classification: cls("credit_card", "credit_products", false, "Credit card"), value: null, balances: [], positions: [] },
    { id: "OLD", classification: cls("tfsa", "closed", false, "Closed TFSA"), value: null, balances: [], positions: [pos({ symbol: "OLD" })] },
  ],
});

function deps(over: Record<string, any> = {}): any {
  return {
    market: {
      quotes: vi.fn(async (): Promise<any> => new Map()),
      usdCad: vi.fn(async (): Promise<any> => [{ date: "2026-10-14", close: 1.4 }, { date: "2026-10-15", close: 1.5 }]),
    },
    settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })) },
    now: () => new Date("2026-10-16T15:00:00Z"),
    ...over,
  };
}

describe("buildHoldingsPayload", () => {
  it("returns rows, totals, listed accounts (no credit or closed) and currencies", async () => {
    const p = await buildHoldingsPayload(deps(), portfolio(), "sub", {});
    expect(p.rows.map((r) => r.key)).toEqual(["VFV|CAD"]);
    expect(p.accounts).toEqual([{ id: "TFSA", label: "TFSA" }, { id: "RRSP", label: "RRSP" }]);
    expect(p.currencies).toEqual(["CAD"]);
    expect(p.totals[0]).toMatchObject({ currency: "CAD", cash: 10, holdings: 1 });
    expect(p.filters).toEqual({ sort: "weight" });
    expect(p.asOf).toBe("2026-10-16T15:00:00.000Z");
    expect(p.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("says how old the prices are: the oldest brokerage sync among the accounts shown, not when the view was built", async () => {
    const synced = (at: string | null) => ({ freshness: { positionsAsOf: at, holdingsLastSyncedAt: at, initialSyncCompleted: true, holdingsUnavailable: false } });
    const base = portfolio([pos({})], [pos({ symbol: "XEQT" })]);
    base.accounts[0] = { ...base.accounts[0], ...synced("2026-10-16T12:06:03.800Z") };
    base.accounts[1] = { ...base.accounts[1], ...synced("2026-10-16T11:58:00.000Z") };
    // Closed and credit accounts are not shown, so their older syncs do not count.
    base.accounts[3] = { ...base.accounts[3], ...synced("2026-10-01T00:00:00.000Z") };
    expect((await buildHoldingsPayload(deps(), base, "sub", {})).pricesAsOf).toBe("2026-10-16T11:58:00.000Z");
    expect((await buildHoldingsPayload(deps(), base, "sub", { accountId: "TFSA" })).pricesAsOf).toBe("2026-10-16T12:06:03.800Z");
    expect((await buildHoldingsPayload(deps(), portfolio(), "sub", {})).pricesAsOf).toBeNull();
  });

  it("tells the model how old the prices are, so it can explain a gap with the brokerage's live total", async () => {
    const base = portfolio();
    base.accounts[0] = { ...base.accounts[0], freshness: { positionsAsOf: null, holdingsLastSyncedAt: "2026-10-16T12:06:03.800Z", initialSyncCompleted: true, holdingsUnavailable: false } };
    const copy = holdingsModelCopy(await buildHoldingsPayload(deps(), base, "sub", {}));
    expect(copy.pricesAsOf).toBe("2026-10-16T12:06:03.800Z");
    expect(copy.notes.pricesAsOf).toMatch(/last synced.*live/);
  });

  it("computes CAD-equivalent weight from the latest BoC rate and reports it", async () => {
    const p = await buildHoldingsPayload(deps(), portfolio([pos({ symbol: "AAA", marketValue: 600 }), pos({ symbol: "UUU", currency: "USD", marketValue: 200 })]), "sub", {});
    expect(p.fx).toEqual({ rate: 1.5, date: "2026-10-15" });
    const w = (s: string) => p.rows.find((r) => r.symbol === s)!.weightCad!;
    expect(w("AAA")).toBeCloseTo(600 / 900);
    expect(w("UUU")).toBeCloseTo(300 / 900);
    expect(p.rows.find((r) => r.symbol === "UUU")!.weight).toBe(1);
  });

  it("weightCad is null everywhere when no rate is available", async () => {
    const d = deps(); d.market.usdCad = vi.fn(async () => null);
    const p = await buildHoldingsPayload(d, portfolio(), "sub", {});
    expect(p.fx).toEqual({ rate: null, date: null });
    expect(p.rows.every((r) => r.weightCad === null)).toBe(true);
  });

  it("asks the FX service for a window of about a week ending today", async () => {
    const d = deps();
    await buildHoldingsPayload(d, portfolio(), "sub", {});
    expect(d.market.usdCad).toHaveBeenCalledWith("2026-10-09", "2026-10-16");
  });

  it("adds an estimated day change from quotes sent by public ticker only; a failure leaves it null", async () => {
    const d = deps(); d.market.quotes = vi.fn(async () => new Map([["VFV", { ticker: "VFV", currency: "CAD", price: 102, previousClose: 100, asOf: "x" }]]));
    const p = await buildHoldingsPayload(d, portfolio(), "sub", {});
    expect(d.market.quotes).toHaveBeenCalledWith(["VFV"]);
    expect(p.rows[0].dayChange).toEqual({ amount: 20, fraction: 0.02, estimated: true });
    const bad = deps(); bad.market.quotes = vi.fn(async () => { throw new Error("down"); });
    expect((await buildHoldingsPayload(bad, portfolio(), "sub", {})).rows[0].dayChange).toBeNull();
  });

  it("gives up on slow market data after the deadline", async () => {
    const d = deps({ marketDeadlineMs: 10 });
    d.market.quotes = vi.fn(() => new Promise(() => {}));
    d.market.usdCad = vi.fn(() => new Promise(() => {}));
    const p = await buildHoldingsPayload(d, portfolio(), "sub", {});
    expect(p.rows[0].dayChange).toBeNull();
    expect(p.fx.rate).toBeNull();
  });

  it("accountValue: sums brokerage-reported totals per currency, excluding credit and closed accounts", async () => {
    const pf = portfolio();
    pf.accounts[0].value = { amount: 1500.126, currency: "CAD", source: "brokerage_reported" };
    pf.accounts[1].value = { amount: 500, currency: "CAD", source: "brokerage_reported" };
    pf.accounts[2].value = { amount: -900, currency: "CAD", source: "brokerage_reported" };
    pf.accounts[3].value = { amount: 777, currency: "CAD", source: "brokerage_reported" };
    const p = await buildHoldingsPayload(deps(), pf, "sub", {});
    expect(p.accountValue).toEqual([{ currency: "CAD", amount: 2000.13, source: "reported" }]);
    const one = await buildHoldingsPayload(deps(), pf, "sub", { accountId: "RRSP" });
    expect(one.accountValue).toEqual([{ currency: "CAD", amount: 500, source: "reported" }]);
    const usd = await buildHoldingsPayload(deps(), pf, "sub", { currency: "USD" });
    expect(usd.accountValue).toEqual([{ currency: "CAD", amount: 2000.13, source: "reported" }]);
  });

  it("accountValue: an account without a reported value is estimated from holdings and cash at the BoC rate", async () => {
    const pf = portfolio([pos({ symbol: "AAA", marketValue: 600 }), pos({ symbol: "UUU", currency: "USD", marketValue: 200 })]);
    pf.accounts[1].value = { amount: 1000, currency: "CAD", source: "brokerage_reported" };
    pf.accounts[0].balances = [{ currency: "CAD", cash: 10, buyingPower: null }, { currency: "USD", cash: 20, buyingPower: null }];
    const p = await buildHoldingsPayload(deps(), pf, "sub", {});
    // 1000 reported + 600 + 10 + (200 + 20) x 1.5
    expect(p.accountValue).toEqual([{ currency: "CAD", amount: 1940, source: "estimated" }]);
  });

  it("accountValue: without a rate the estimate stays in native currencies", async () => {
    const d = deps(); d.market.usdCad = vi.fn(async () => null);
    const pf = portfolio([pos({ symbol: "AAA", marketValue: 600 }), pos({ symbol: "UUU", currency: "USD", marketValue: 200 })]);
    pf.accounts[1].value = { amount: 1000, currency: "CAD", source: "brokerage_reported" };
    const p = await buildHoldingsPayload(d, pf, "sub", {});
    expect(p.accountValue).toEqual([{ currency: "CAD", amount: 1610, source: "estimated" }, { currency: "USD", amount: 200, source: "estimated" }]);
  });

  it("accountValue is empty when nothing is in scope", async () => {
    const pf = portfolio(); pf.accounts = pf.accounts.slice(2);
    expect((await buildHoldingsPayload(deps(), pf, "sub", {})).accountValue).toEqual([]);
  });

  it("scopes by account and currency and rejects an unknown or excluded account", async () => {
    const pf = portfolio([pos({ symbol: "AAA" })], [pos({ symbol: "BBB", currency: "USD" })]);
    expect((await buildHoldingsPayload(deps(), pf, "sub", { accountId: "RRSP" })).rows.map((r) => r.symbol)).toEqual(["BBB"]);
    const usd = await buildHoldingsPayload(deps(), pf, "sub", { currency: "USD" });
    expect(usd.rows.map((r) => r.symbol)).toEqual(["BBB"]);
    expect(usd.currencies).toEqual(["CAD", "USD"]);
    expect(usd.filters).toEqual({ currency: "USD", sort: "weight" });
    for (const accountId of ["nope", "CARD", "OLD"]) await expect(buildHoldingsPayload(deps(), pf, "sub", { accountId })).rejects.toBeInstanceOf(HoldingsScopeError);
  });

  it("sorts, with unknown values last", async () => {
    const pf = portfolio([
      pos({ symbol: "AAA", marketValue: 100, costBasis: 5, units: 10 }), pos({ symbol: "BBB", marketValue: 300, costBasis: 20, units: 10 }),
      pos({ symbol: "CCC", marketValue: null, price: null, costBasis: null }), pos({ symbol: "DDD", marketValue: 200, costBasis: 10, units: 10 }),
    ]);
    const order = async (sort: any) => (await buildHoldingsPayload(deps(), pf, "sub", { sort })).rows.map((r) => r.symbol[0]).join("");
    expect(await order("weight")).toBe("BDAC");
    expect(await order("value")).toBe("BDAC");
    expect(await order("return")).toBe("BDAC");
    expect(await order("returnPct")).toBe("ADBC");
    expect(await order("symbol")).toBe("ABCD");
  });

  it("stays under 60 KB for 300 USD positions in an unreported account with no rate", async () => {
    const d = deps(); d.market.usdCad = vi.fn(async () => null);
    const many = Array.from({ length: 300 }, (_, i) => pos({ symbol: `S${String(i).padStart(3, "0")}`, currency: "USD", marketValue: 1000 + i }));
    const p = await buildHoldingsPayload(d, portfolio(many.slice(0, 150), many.slice(150)), "sub", {});
    expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(60_000);
    expect(p.home.total.excludedCount).toBeGreaterThan(0);
    expect(p.home.total.excluded.length).toBeLessThanOrEqual(2);
  });

  it("stays under 60 KB for 300 holdings", async () => {
    const many = Array.from({ length: 300 }, (_, i) => pos({ symbol: `S${String(i).padStart(3, "0")}`, marketValue: 1000 + i }));
    const p = await buildHoldingsPayload(deps(), portfolio(many.slice(0, 150), many.slice(150)), "sub", {});
    expect(p.rows.length + p.omitted).toBe(300);
    expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(60_000);
    expect(p.omitted).toBeGreaterThan(0);
    expect(p.rows[0].marketValue).toBe(1299);
    expect(p.totals[0].holdings).toBe(300);
  });

  it("drops the per-account breakdown from the smallest rows first when the rows are over budget", async () => {
    const many = Array.from({ length: 170 }, (_, i) => pos({ symbol: `S${String(i).padStart(3, "0")}`, marketValue: 1000 + i }));
    const p = await buildHoldingsPayload(deps(), portfolio(many), "sub", {});
    expect(p.omitted).toBe(0);
    expect(p.rows[0].accounts).toHaveLength(1);
    expect(p.rows[p.rows.length - 1].accounts).toHaveLength(0);
    expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(60_000);
  });

  it("keeps the per-account breakdown when the rows fit", async () => {
    const p = await buildHoldingsPayload(deps(), portfolio([pos({})], [pos({ marketValue: 500 })]), "sub", {});
    expect(p.rows[0].accounts.map((a) => a.accountId)).toEqual(["TFSA", "RRSP"]);
    expect(p.omitted).toBe(0);
  });
});

describe("text and model copy", () => {
  it("the text answers first: count, scope, value, the cash held and the largest holding", async () => {
    const r = await buildHoldingsResult(deps(), portfolio(), "sub", { accountId: "TFSA" });
    const text = holdingsText(r.payload, r.scope, { show: true });
    expect(text).toBe("1 holding in Synthetic TFSA worth 1,000.00 CAD; cash 10.00 CAD. Largest: VFV at 100.0% of holdings, cash excluded. Showing the holdings widget.");
    expect(holdingsText(r.payload, r.scope)).not.toContain("Showing");
    const empty = await buildHoldingsResult(deps(), portfolio([]), "sub", {});
    expect(holdingsText(empty.payload, empty.scope)).toBe("No holdings across all accounts; cash 10.00 CAD.");
    const pf = portfolio([]); pf.accounts[0].balances = [];
    const none = await buildHoldingsResult(deps(), pf, "sub", {});
    expect(holdingsText(none.payload, none.scope)).toBe("No holdings across all accounts.");
  });

  it("the text counts omitted rows, says so, and respects the currency filter", async () => {
    const many = Array.from({ length: 300 }, (_, i) => pos({ symbol: `S${String(i).padStart(3, "0")}`, marketValue: 1000 + i }));
    const p = await buildHoldingsPayload(deps(), portfolio(many.slice(0, 150), many.slice(150)), "sub", {});
    expect(p.omitted).toBeGreaterThan(0);
    expect(holdingsText(p, "across all accounts")).toBe(`300 holdings across all accounts worth 344,850.00 CAD; cash 10.00 CAD. Largest: S299 at 0.4% of holdings, cash excluded. The table lists the largest ${p.rows.length}; narrow by account or currency to see the rest.`);
    const mixed = portfolio([pos({ symbol: "AAA" }), pos({ symbol: "UUU", currency: "USD" })]);
    const usd = await buildHoldingsPayload(deps(), mixed, "sub", { currency: "USD" });
    expect(holdingsText(usd, "across all accounts")).toBe("1 USD holding across all accounts worth 1,000.00 USD. Largest: UUU at 60.0% of holdings, cash excluded (est., BoC Oct 15).");
    expect(holdingsText(await buildHoldingsPayload(deps(), mixed, "sub", { currency: "EUR" }), "across all accounts")).toBe("No EUR holdings across all accounts.");
    expect(holdingsText(await buildHoldingsPayload(deps(), mixed, "sub", {}), "across all accounts"))
      .toBe("2 holdings across all accounts worth 2,500.00 CAD est. (BoC Oct 15) (1,000.00 CAD + 1,000.00 USD); cash 10.00 CAD. Largest: UUU at 60.0% of holdings, cash excluded (est., BoC Oct 15).");
  });

  it("over budget, unknown-value rows are kept and the smallest known CAD-equivalent rows go first", async () => {
    const many = Array.from({ length: 300 }, (_, i) => pos({ symbol: `S${String(i).padStart(3, "0")}`, marketValue: 1000 + i }));
    const unknown = pos({ symbol: "ZZZ", marketValue: null, price: null, costBasis: null });
    // USD rows are worth more in CAD: S000 in USD (1000 x 1.4) outranks CAD rows below 1400.
    const usdRow = pos({ symbol: "USDONE", currency: "USD", marketValue: 1000 });
    const p = await buildHoldingsPayload(deps(), portfolio([unknown, usdRow, ...many]), "sub", {});
    expect(p.omitted).toBeGreaterThan(0);
    expect(p.rows.some((r) => r.symbol === "ZZZ")).toBe(true);
    expect(p.rows.some((r) => r.symbol === "USDONE")).toBe(true);
    expect(p.rows.some((r) => r.symbol === "S000")).toBe(false);
  });

  it("no known value: the text omits the value instead of stating 0.00", async () => {
    const unknown = (symbol: string) => pos({ symbol, marketValue: null, price: null, costBasis: null });
    const r = await buildHoldingsResult(deps(), portfolio([unknown("AAA"), unknown("BBB")]), "sub", { accountId: "TFSA" });
    const text = holdingsText(r.payload, r.scope);
    expect(text).toBe("2 holdings in Synthetic TFSA (none with a reported value); cash 10.00 CAD.");
    expect(text).not.toMatch(/worth|\b0\.00/);
  });

  it("some unknown values: the value is the known part and says how many have none", async () => {
    const pf = portfolio([pos({ symbol: "AAA", marketValue: 1000 }), pos({ symbol: "BBB", marketValue: null, price: null, costBasis: null })]);
    const r = await buildHoldingsResult(deps(), pf, "sub", { accountId: "TFSA" });
    expect(holdingsText(r.payload, r.scope)).toBe("2 holdings in Synthetic TFSA worth 1,000.00 CAD (1 with no reported value); cash 10.00 CAD. Largest: AAA at 100.0% of holdings, cash excluded.");
  });

  it("cash reads as a per-currency list: a margin debit keeps its sign and is not added to the value", async () => {
    const pf = portfolio(); pf.accounts[0].balances = [{ currency: "CAD", cash: 2000, buyingPower: null }, { currency: "USD", cash: -500, buyingPower: null }];
    const text = holdingsText(await buildHoldingsPayload(deps(), pf, "sub", {}), "across all accounts");
    expect(text).toBe("1 holding across all accounts worth 1,000.00 CAD; cash 2,000.00 CAD and -500.00 USD. Largest: VFV at 100.0% of holdings, cash excluded.");
    expect(text).not.toMatch(/plus|owed/);
  });

  it("three cash currencies read A, B and C", async () => {
    const pf = portfolio(); pf.accounts[0].balances = [
      { currency: "CAD", cash: 10, buyingPower: null },
      { currency: "USD", cash: 20, buyingPower: null },
      { currency: "EUR", cash: 30, buyingPower: null },
    ];
    const text = holdingsText(await buildHoldingsPayload(deps(), pf, "sub", {}), "across all accounts");
    expect(text).toMatch(/; cash 10\.00 CAD, [\d.,]+ [A-Z]{3} and [\d.,]+ [A-Z]{3}\./);
    expect(text.match(/ and /g)).toHaveLength(1);
  });

  it("CAD holdings with USD cash only are single-currency: no est. on the share", async () => {
    const pf = portfolio(); pf.accounts[0].balances = [{ currency: "CAD", cash: 10, buyingPower: null }, { currency: "USD", cash: 20, buyingPower: null }];
    const p = await buildHoldingsPayload(deps(), pf, "sub", {});
    expect(p.currencies).toEqual(["CAD", "USD"]);
    expect(p.settings.cadView).toBe(true);
    const text = holdingsText(p, "across all accounts");
    expect(text).toBe("1 holding across all accounts worth 1,000.00 CAD; cash 10.00 CAD and 20.00 USD. Largest: VFV at 100.0% of holdings, cash excluded.");
    expect(text).not.toContain("est.");
  });

  it("the text gives the holdings value, not the account value the model copy carries", async () => {
    const pf = portfolio(); pf.accounts[0].value = { amount: 4321, currency: "CAD", source: "brokerage_reported" };
    const p = await buildHoldingsPayload(deps(), pf, "sub", {});
    expect(holdingsText(p, "across all accounts")).not.toMatch(/4321|4,321/);
    expect(holdingsModelCopy(p).accountValue).toEqual([{ currency: "CAD", amount: 4321, source: "estimated" }]);
  });

  it("model copy: the CAD total and the CAD note replace 'currencies are never mixed'", async () => {
    const copy = holdingsModelCopy(await buildHoldingsPayload(deps(), portfolio(), "sub", {}));
    expect(copy.home!.total).toEqual({ amount: expect.any(Number), estimated: expect.any(Boolean), notConverted: 0 });
    expect(copy.notes.currency).toBe("Figures are in CAD; USD amounts are converted at the Bank of Canada rate and marked est.");
    expect(copy.notes.returns).toBe("totalReturn and returnPct are market value against book cost, the 'Gain vs book cost' on screen. Dividends aren't included, and reinvested dividends add to book cost.");
    expect(JSON.stringify(copy)).not.toContain("never mixed");
  });

  it("model copy says a converted holding's CAD day change includes the currency move, only with the CAD view on (B2)", async () => {
    const copy = holdingsModelCopy(await buildHoldingsPayload(deps(), portfolio(), "sub", {})) as any;
    expect(copy.notes.dayChange).toBe("A converted holding's CAD day change includes the day's currency move; its percent is the price move.");
    const off = deps({ settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView: false })) } });
    expect((holdingsModelCopy(await buildHoldingsPayload(off, portfolio(), "sub", {})) as any).notes.dayChange).toBeUndefined();
  });

  it("model copy with cadView off: no CAD total and no CAD note, native totals kept", async () => {
    const d = deps({ settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView: false })) } });
    const p = await buildHoldingsPayload(d, portfolio(), "sub", {});
    const copy = holdingsModelCopy(p) as any;
    expect(copy.home).toBeUndefined();
    expect(copy.notes.currency).toBeUndefined();
    expect(JSON.stringify(copy)).not.toContain("Figures are in CAD");
    expect(copy.totals).toEqual(p.totals);
    expect(holdingsModelCopy(await buildHoldingsPayload(deps(), portfolio(), "sub", {})).notes.currency).toContain("Figures are in CAD");
  });

  it("the model copy has at most 20 rows ranked by weight, without account ids", async () => {
    const many = Array.from({ length: 30 }, (_, i) => pos({ symbol: `S${String(i).padStart(2, "0")}`, marketValue: 100 + i }));
    const p = await buildHoldingsPayload(deps(), portfolio(many), "sub", { accountId: "TFSA" });
    const copy = holdingsModelCopy(p);
    expect(copy.top).toHaveLength(20);
    expect(copy.top[0]).toEqual({ symbol: "S29", currency: "CAD", weight: expect.any(Number), returnPct: expect.any(Number) });
    expect(copy.hasMore).toBe(true);
    expect(copy.holdings).toBe(30);
    expect(copy.filters).toEqual({ accountLabel: "TFSA", sort: "weight" });
    expect(JSON.stringify(copy)).not.toMatch(/accountId|"accounts"|"id"/);
  });
});

describe("accountType and symbol filters", () => {
  const account = (id: string, name: string, c: any, positions: any[]): any => ({ id, name, classification: c, value: null, balances: [], positions });
  const tfsa = () => cls("tfsa", "registered", true, "TFSA");
  const typed = (tfsas: 1 | 2 = 2): any => ({
    generatedAt: "2026-10-16T15:00:00.000Z",
    accounts: [
      account("T1", "Synthetic TFSA one", tfsa(), [pos({ symbol: "XEQT.TO", marketValue: 600 }), pos({ symbol: "VFV", marketValue: 400 })]),
      ...(tfsas === 2 ? [account("T2", "Synthetic TFSA two", tfsa(), [pos({ symbol: "XEQT.TO", marketValue: 300 }), pos({ symbol: "XEQTX", marketValue: 50 }), pos({ symbol: "ZAG", marketValue: 100 })])] : []),
      account("M1", "Synthetic margin", cls("margin", "non_registered", true, "Non-registered"), [pos({ symbol: "XEQT.TO", marketValue: 1000 }), pos({ symbol: "AAPL", currency: "USD", marketValue: 200 })]),
      account("OLD", "Synthetic closed TFSA", cls("tfsa", "closed", false, "Closed TFSA"), [pos({ symbol: "XEQT.TO", marketValue: 9000 })]),
    ],
  });
  const firstSentence = (text: string) => text.split(/(?<=\.) (?=[A-Z])/)[0];

  it("accountType tfsa with two TFSAs and a margin account: only the TFSAs' holdings, no accountId echoed", async () => {
    const r = await buildHoldingsResult(deps(), typed(), "sub", { accountType: "tfsa" });
    const p = r.payload;
    expect(p.rows.map((row) => row.symbol).sort()).toEqual(["VFV", "XEQT.TO", "XEQTX", "ZAG"]);
    expect(p.rows.find((row) => row.symbol === "XEQT.TO")!.marketValue).toBe(900);
    expect(p.filters).toEqual({ accountType: "tfsa", sort: "weight" });
    expect(p.totals).toEqual([expect.objectContaining({ currency: "CAD", marketValue: 1450, holdings: 4 })]);
    expect(p.accountValue).toEqual([{ currency: "CAD", amount: 1450, source: "estimated" }]);
    expect(p.home.total.amount).toBe(1450);
    expect(r.scope).toBe("in your TFSAs");
    expect(holdingsText(p, r.scope)).toMatch(/^4 holdings in your TFSAs /);
  });

  it("accountType matching one account echoes that account's id (Review Focus 5)", async () => {
    const r = await buildHoldingsResult(deps(), typed(1), "sub", { accountType: "tfsa" });
    expect(r.payload.filters).toEqual({ accountId: "T1", accountType: "tfsa", sort: "weight" });
    expect(r.payload.rows.map((row) => row.symbol).sort()).toEqual(["VFV", "XEQT.TO"]);
  });

  it("the single accountId path is unchanged by the new filters", async () => {
    const byId = await buildHoldingsResult(deps(), typed(1), "sub", { accountId: "T1" });
    const byType = await buildHoldingsResult(deps(), typed(1), "sub", { accountType: "tfsa" });
    expect(byId.payload.filters).toEqual({ accountId: "T1", sort: "weight" });
    const { filters: _a, ...idRest } = byId.payload;
    const { filters: _b, ...typeRest } = byType.payload;
    expect(typeRest).toEqual(idRest);
  });

  it("symbol xeqt: only XEQT.TO rows, totals are its value, weights stay against the whole scope", async () => {
    const all = await buildHoldingsResult(deps(), typed(), "sub", { accountType: "tfsa" });
    const r = await buildHoldingsResult(deps(), typed(), "sub", { accountType: "tfsa", symbol: "xeqt" });
    const p = r.payload;
    expect(p.rows.map((row) => row.key)).toEqual(["XEQT.TO|CAD"]);
    expect(p.rows[0].accounts.map((a) => a.accountId).sort()).toEqual(["T1", "T2"]);
    expect(p.totals).toEqual([expect.objectContaining({ currency: "CAD", marketValue: 900, holdings: 1, cash: 0 })]);
    for (const row of p.rows) {
      const same = all.payload.rows.find((x) => x.key === row.key)!;
      expect(row.weight).toBe(same.weight);
      expect(row.weightCad).toBe(same.weightCad);
    }
    expect(p.filters).toEqual({ accountType: "tfsa", symbol: "XEQT", sort: "weight" });
    // accountValue and home still describe the accounts in scope.
    expect(p.accountValue).toEqual(all.payload.accountValue);
    expect(p.home).toEqual(all.payload.home);
    const text = holdingsText(p, r.scope);
    expect(text).toMatch(/^1 holding in your TFSAs for XEQT worth 900\.00 CAD\. XEQT\.TO is 62\.1% of the holdings in your TFSAs, cash excluded\./);
  });

  it("symbol matches XEQT and XEQT.TO but not XEQTX, ignoring case (Review Focus 2)", async () => {
    const pf = portfolio([pos({ symbol: "XEQT" }), pos({ symbol: "xeqt.to" }), pos({ symbol: "XEQTX" }), pos({ symbol: "VFV" })]);
    const p = await buildHoldingsPayload(deps(), pf, "sub", { symbol: "Xeqt" });
    expect(p.rows.map((row) => row.symbol).sort()).toEqual(["XEQT", "XEQT.TO"]);
    // A listing query also matches the bare symbol (I2), never XEQTX.
    expect((await buildHoldingsPayload(deps(), pf, "sub", { symbol: "xeqt.to" })).rows.map((row) => row.symbol).sort()).toEqual(["XEQT", "XEQT.TO"]);
  });

  it("the answer-first text for a single-currency CAD scope", async () => {
    const r = await buildHoldingsResult(deps(), typed(1), "sub", { accountType: "tfsa" });
    const text = holdingsText(r.payload, r.scope, { show: true });
    expect(text).toMatch(/^2 holdings in your TFSA worth 1,000\.00 CAD\. Largest: XEQT\.TO at 60\.0% of holdings, cash excluded\./);
    expect(firstSentence(text)).toBe("2 holdings in your TFSA worth 1,000.00 CAD.");
    expect(firstSentence(text).length).toBeLessThan(300);
    expect(text.endsWith(" Showing the holdings widget.")).toBe(true);
    expect(text).not.toContain("est.");
  });

  it("CAD and USD with no CAD figure in the payload: both native totals, no est.", async () => {
    const cadOff = deps({ settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView: false })) } });
    const noRate = deps(); noRate.market.usdCad = vi.fn(async () => null);
    for (const d of [cadOff, noRate]) {
      const r = await buildHoldingsResult(d, typed(), "sub", { accountType: "non_registered" });
      const text = holdingsText(r.payload, r.scope);
      expect(r.payload.filters).toEqual({ accountId: "M1", accountType: "non_registered", sort: "weight" });
      expect(text).toMatch(/^2 holdings in your non-registered account worth 1,000\.00 CAD \+ 200\.00 USD\./);
      expect(text).toContain("Largest: XEQT.TO at 100.0% of CAD holdings, cash excluded, AAPL at 100.0% of USD holdings, cash excluded.");
      expect(text).not.toContain("est.");
      expect(firstSentence(text).length).toBeLessThan(300);
    }
  });

  it("CAD and USD with the CAD view on: the payload's CAD figure, est. with its BoC date, then the native totals", async () => {
    const r = await buildHoldingsResult(deps(), typed(), "sub", { accountType: "non_registered" });
    expect(holdingsText(r.payload, r.scope)).toBe(
      "2 holdings in your non-registered account worth 1,300.00 CAD est. (BoC Oct 15) (1,000.00 CAD + 200.00 USD). Largest: XEQT.TO at 76.9% of holdings, cash excluded (est., BoC Oct 15).",
    );
  });

  it("a Cash account with no positions: the text states its cash, not just 'No holdings' (C1)", async () => {
    const pf = typed(1);
    pf.accounts.push({ ...account("C1", "Synthetic Cash", cls("money_market", "non_registered", true, "Cash"), []), balances: [{ currency: "CAD", cash: 5000, buyingPower: null }] });
    const r = await buildHoldingsResult(deps(), pf, "sub", { accountType: "cash_account" });
    expect(r.scope).toBe("in your Cash account");
    const text = holdingsText(r.payload, r.scope, { show: true });
    expect(text).toBe("No holdings in your Cash account; cash 5,000.00 CAD. Showing the holdings widget.");
    expect(firstSentence(text).length).toBeLessThan(300);
  });

  it("a TFSA with positions and cash in two currencies: the value, then each currency's cash as reported, never converted (C1)", async () => {
    const pf = typed(1);
    pf.accounts[0].balances = [{ currency: "CAD", cash: 2000, buyingPower: null }, { currency: "USD", cash: 50, buyingPower: null }];
    pf.accounts[0].positions.push(pos({ symbol: "AAPL", currency: "USD", marketValue: 100 }));
    const r = await buildHoldingsResult(deps(), pf, "sub", { accountType: "tfsa" });
    const text = holdingsText(r.payload, r.scope);
    expect(firstSentence(text)).toBe(
      "3 holdings in your TFSA worth 1,150.00 CAD est. (BoC Oct 15) (1,000.00 CAD + 100.00 USD); cash 2,000.00 CAD and 50.00 USD.",
    );
    expect(firstSentence(text).length).toBeLessThan(300);
    // The currency filter narrows the cash with the holdings, and keeps its scope words.
    const usd = await buildHoldingsResult(deps(), pf, "sub", { accountType: "tfsa", currency: "USD" });
    expect(firstSentence(holdingsText(usd.payload, usd.scope))).toBe("1 USD holding in your TFSA worth 100.00 USD; cash 50.00 USD.");
    // A symbol filter is about that symbol's holdings only: no cash.
    const sym = await buildHoldingsResult(deps(), pf, "sub", { accountType: "tfsa", symbol: "vfv" });
    expect(firstSentence(holdingsText(sym.payload, sym.scope))).toBe("1 holding in your TFSA for VFV worth 400.00 CAD.");
  });

  it("account ids never appear in the text, by accountId or accountType", async () => {
    for (const input of [{ accountId: "T1" }, { accountType: "tfsa" as const }, { accountType: "non_registered" as const }]) {
      const r = await buildHoldingsResult(deps(), typed(1), "sub", input);
      const text = holdingsText(r.payload, r.scope, { show: true });
      expect(text).not.toMatch(/\b(T1|M1)\b/);
      expect(r.payload.filters.accountId).toMatch(/^(T1|M1)$/);
    }
    const byId = await buildHoldingsResult(deps(), typed(1), "sub", { accountId: "T1" });
    expect(holdingsText(byId.payload, byId.scope)).toMatch(/^2 holdings in Synthetic TFSA one worth /);
  });

  it("errors: both filters, and a type with no connected account, carry their verbatim copy", async () => {
    await expect(buildHoldingsResult(deps(), typed(), "sub", { accountId: "T1", accountType: "tfsa" }))
      .rejects.toMatchObject({ name: "HoldingsScopeError", code: "both_filters", text: "Give accountId or accountType, not both." });
    await expect(buildHoldingsResult(deps(), typed(), "sub", { accountType: "fhsa" }))
      .rejects.toMatchObject({ code: "no_accounts_of_type", text: "No connected FHSA accounts. Use list_portfolio_accounts to see what is connected." });
    await expect(buildHoldingsResult(deps(), typed(), "sub", { accountId: "OLD" }))
      .rejects.toMatchObject({ code: "unknown_account", text: "Unknown or excluded account. Use list_portfolio_accounts to pick an account." });
  });
});

describe("input and definitions", () => {
  it("validates input strictly and uppercases the currency", () => {
    expect(holdingsInput.parse({ currency: " usd ", sort: "today" })).toEqual({ currency: "USD", sort: "today" });
    expect(holdingsInput.parse({})).toEqual({});
    expect(() => holdingsInput.parse({ extra: 1 })).toThrow();
    expect(() => holdingsInput.parse({ sort: "random" })).toThrow();
    expect(() => holdingsInput.parse({ currency: "CADX" })).toThrow();
    expect(holdingsInput.parse({ accountType: "tfsa", symbol: " xeqt " })).toEqual({ accountType: "tfsa", symbol: "xeqt" });
    expect(() => holdingsInput.parse({ accountType: "cash" })).toThrow();
    expect(() => holdingsInput.parse({ symbol: "" })).toThrow();
  });

  it("show_holdings is model-visible with widget metadata; get_holdings is app-only; schemas use real keys", async () => {
    const [show, get] = holdingsToolDefinitions;
    expect(HOLDINGS_WIDGET).toBe("holdings");
    expect(HOLDINGS_WIDGET_URI).toBe("ui://portfolio/holdings-v1");
    expect(show.name).toBe("show_holdings");
    expect(show.description).toBe("Use this when the user asks what they own, or wants the full list of holdings or positions across their accounts: renders the interactive holdings table. Filter with accountType (for example tfsa) or accountId, and symbol. Read-only.");
    expect(Object.keys(show.inputSchema.properties)).toEqual(["accountId", "accountType", "currency", "sort", "symbol"]);
    expect(show._meta).toEqual({
      ui: { resourceUri: HOLDINGS_WIDGET_URI }, "openai/outputTemplate": HOLDINGS_WIDGET_URI, "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Loading holdings…", "openai/toolInvocation/invoked": "Holdings ready.",
      securitySchemes: [{ type: "oauth2", scopes: ["portfolio:read"] }],
    });
    expect((show._meta as any).ui.visibility).toBeUndefined();
    expect(get.name).toBe("get_holdings");
    expect((get._meta as any).ui).toEqual({ visibility: ["app"] });
    for (const t of holdingsToolDefinitions) {
      expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(t.securitySchemes).toEqual([{ type: "oauth2", scopes: ["portfolio:read"] }]);
      expect(t.outputSchema.additionalProperties).toBe(false);
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
    const required = ["rows", "totals", "accounts", "currencies", "omitted", "filters", "fx", "accountValue", "home", "settings", "asOf", "pricesAsOf"];
    expect(show.outputSchema.required).toEqual(required);
    expect(Object.keys(show.outputSchema.properties).sort()).toEqual([...required].sort());
    const p = await buildHoldingsPayload(deps(), portfolio(), "sub", {});
    expect(Object.keys(p).sort()).toEqual([...required].sort());
  });
});

describe("buildHoldingsResult: refreshed and noRefresh (rate limits)", () => {
  const quote = new Map([["VFV", { ticker: "VFV", currency: "CAD", price: 102, previousClose: 100, asOf: "x" }]]);

  it("refreshed is true when quotes were requested from the market service", async () => {
    const d = deps(); d.market.quotes = vi.fn(async () => quote);
    const r = await buildHoldingsResult(d, portfolio(), "sub", {});
    expect(r.refreshed).toBe(true);
    expect(r.payload.rows[0].dayChange).toEqual({ amount: 20, fraction: 0.02, estimated: true });
  });

  it("refreshed is false when there is nothing to quote", async () => {
    const d = deps();
    const r = await buildHoldingsResult(d, portfolio([]), "sub", {});
    expect(d.market.quotes).not.toHaveBeenCalled();
    expect(r.refreshed).toBe(false);
  });

  it("uses cachedQuotes first when the service offers it; a full cache hit is not a refresh", async () => {
    const d = deps(); d.market.quotes = vi.fn(async () => new Map()); d.market.cachedQuotes = vi.fn(async () => quote);
    const r = await buildHoldingsResult(d, portfolio(), "sub", {});
    expect(d.market.quotes).not.toHaveBeenCalled();
    expect(r.refreshed).toBe(false);
    expect(r.payload.rows[0].dayChange).toEqual({ amount: 20, fraction: 0.02, estimated: true });
  });

  it("cache misses are fetched and count as a refresh", async () => {
    const d = deps(); d.market.cachedQuotes = vi.fn(async () => new Map()); d.market.quotes = vi.fn(async () => quote);
    const r = await buildHoldingsResult(d, portfolio(), "sub", {});
    expect(d.market.quotes).toHaveBeenCalledWith(["VFV"]);
    expect(r.refreshed).toBe(true);
  });

  it("noRefresh skips quote fetches: day change is null (or cached only)", async () => {
    const d = deps(); d.market.quotes = vi.fn(async () => quote);
    const r = await buildHoldingsResult(d, portfolio(), "sub", {}, { noRefresh: true });
    expect(d.market.quotes).not.toHaveBeenCalled();
    expect(r.refreshed).toBe(false);
    expect(r.payload.rows[0].dayChange).toBeNull();
    expect(r.payload.rows[0].marketValue).toBe(1000);
    const c = deps(); c.market.quotes = vi.fn(async () => new Map()); c.market.cachedQuotes = vi.fn(async () => quote);
    const cached = await buildHoldingsResult(c, portfolio(), "sub", {}, { noRefresh: true });
    expect(c.market.quotes).not.toHaveBeenCalled();
    expect(cached.payload.rows[0].dayChange).toEqual({ amount: 20, fraction: 0.02, estimated: true });
  });

  it("buildHoldingsPayload returns the same payload as the result (no extra keys)", async () => {
    const p = await buildHoldingsPayload(deps(), portfolio(), "sub", {});
    expect(Object.keys(p)).not.toContain("refreshed");
  });
});

describe("buildHoldingsResult with the real MarketDataService", () => {
  const now = () => new Date("2026-10-16T15:00:00Z");
  const service = (quote: any) => new MarketDataService({
    history: [], quotes: { name: "q", quote }, fx: { usdCad: vi.fn(async () => [{ date: "2026-10-15", close: 1.5 }]) } as any,
    cache: new MemoryMarketDataCache(), now, retryDelayMs: 0,
  });
  const live = (t: string) => ({ ticker: t, currency: "CAD", price: 102, previousClose: 100, asOf: "x" });

  it("all quotes cached: refreshed is false and the provider is not called again", async () => {
    const quote = vi.fn(async (t: string) => live(t));
    const market = service(quote);
    const first = await buildHoldingsResult(deps({ market }), portfolio(), "sub", {});
    expect(first.refreshed).toBe(true);
    expect(quote).toHaveBeenCalledTimes(1);
    const second = await buildHoldingsResult(deps({ market }), portfolio(), "sub", {});
    expect(second.refreshed).toBe(false);
    expect(quote).toHaveBeenCalledTimes(1);
    expect(second.payload.rows[0].dayChange).toEqual({ amount: 20, fraction: 0.02, estimated: true });
  });

  it("noRefresh with a warm cache keeps the day change", async () => {
    const quote = vi.fn(async (t: string) => live(t));
    const market = service(quote);
    await buildHoldingsResult(deps({ market }), portfolio(), "sub", {});
    const r = await buildHoldingsResult(deps({ market }), portfolio(), "sub", {}, { noRefresh: true });
    expect(r.payload.rows[0].dayChange).toEqual({ amount: 20, fraction: 0.02, estimated: true });
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it("a failing ticker is a known miss: 11 calls fetch once and report refreshed only on the first", async () => {
    const quote = vi.fn(async () => { throw new Error("unquotable"); });
    const market = service(quote);
    const flags: boolean[] = [];
    for (let i = 0; i < 11; i++) flags.push((await buildHoldingsResult(deps({ market }), portfolio(), "sub", {})).refreshed);
    expect(flags).toEqual([true, ...Array(10).fill(false)]);
  });
});
