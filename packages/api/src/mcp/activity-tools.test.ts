import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings/settings-service.js";
import type { StoredActivity } from "../history/stored-activity.js";
import {
  ACTIVITY_WIDGET_URI, ActivityScopeError, activityFiltersInput, activityModelCopy, activityPageInput, activityText,
  activityToolDefinitions, parseShowActivity, buildActivityPage, buildActivityResult, buildSymbolHistory, symbolHistoryInput, symbolHistoryModelCopy,
} from "./activity-tools.js";

const cls = (bucket: string, group: string, included: boolean, label: string): any => ({ label, bucket, group, includedInPortfolioTotal: included, isClosed: group === "closed" });
const portfolio = (): any => ({
  generatedAt: "2026-10-16T15:00:00.000Z",
  accounts: [
    { id: "TFSA", name: "Self-directed TFSA", classification: cls("tfsa", "registered", true, "TFSA"), value: { amount: 1, currency: "CAD" } },
    { id: "RRSP", name: "Self-directed RRSP", classification: cls("rrsp", "registered", true, "RRSP"), value: { amount: 1, currency: "CAD" } },
    { id: "CASH", name: "Cash", classification: cls("money_market", "non_registered", true, "Cash / money market"), value: { amount: 1, currency: "CAD" } },
    { id: "CARD", name: "Credit card", classification: cls("credit_card", "credit_products", false, "Credit card"), value: null },
    { id: "OLD", name: "Old TFSA", classification: cls("tfsa", "closed", false, "Closed TFSA"), value: null },
    { id: "ODD", name: "Odd account", classification: cls("other", "other", false, "Odd"), value: null },
  ],
});

let n = 0;
const act = (over: Partial<StoredActivity>): StoredActivity => ({
  snapTradeAccountId: "TFSA", dedupeKey: `k${String(++n).padStart(5, "0")}`, type: "BUY", symbol: "VFV", securityCurrency: "CAD", isOption: false,
  units: 1, price: 100, amount: -100, fee: null, fxRate: null, currency: "CAD", tradeDate: "2026-09-01", settlementDate: "2026-09-01", description: null, ...over,
});
const synced = { backfillCompletedAt: new Date("2026-09-01T00:00:00Z"), lastSyncedAt: new Date(), lastError: null, dirty: false };

function fakeStore(rows: StoredActivity[], states: Record<string, any> = {}) {
  const queryActivities = vi.fn(async (_u: string, q: any) => {
    const symbol = q.symbol?.trim().toUpperCase();
    const out = rows.filter((r) => {
      const d = r.tradeDate ?? r.settlementDate;
      if (!q.accountIds.includes(r.snapTradeAccountId) || d === null || d < q.from || d > q.to) return false;
      if (symbol && (r.symbol ?? "").trim().toUpperCase() !== symbol) return false;
      if (q.before && !(d < q.before.date || (d === q.before.date && r.dedupeKey < q.before.key))) return false;
      return true;
    });
    out.sort((a, b) => {
      const da = a.tradeDate ?? a.settlementDate!; const db = b.tradeDate ?? b.settlementDate!;
      return da !== db ? (da < db ? 1 : -1) : a.dedupeKey < b.dedupeKey ? 1 : -1;
    });
    return q.limit === undefined ? out : out.slice(0, q.limit);
  });
  return {
    userId: vi.fn(async () => "user-1"),
    syncState: vi.fn(async (_u: string, id: string) => (id in states ? states[id] : synced)),
    queryActivities,
  };
}

function deps(rows: StoredActivity[], over: Record<string, any> = {}, states: Record<string, any> = {}): any {
  return {
    activities: fakeStore(rows, states),
    market: { securityHistory: vi.fn(async (): Promise<any> => null) },
    settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })) },
    cursorSecret: Buffer.from("test-secret-test-secret-test-secret"),
    now: () => new Date("2026-10-16T15:00:00Z"),
    ...over,
  };
}
const day = (i: number) => new Date(Date.parse("2026-08-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);

describe("buildActivityPage", () => {
  it("defaults to investing over the last 90 days (Toronto date)", async () => {
    const d = deps([
      act({ tradeDate: "2026-07-18", settlementDate: "2026-07-18" }),
      act({ tradeDate: "2026-07-17", settlementDate: "2026-07-17" }),
      act({ type: "DEPOSIT", symbol: null, amount: 500, units: null, price: null }),
    ]);
    const p = await buildActivityPage(d, portfolio(), "sub", {});
    expect(p.filters).toEqual({ categories: ["investing"], from: "2026-07-18", to: "2026-10-16" });
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ category: "investing", accountLabel: "TFSA", symbol: "VFV", currency: "CAD" });
    expect(p.rows[0].id).toMatch(/^[0-9a-f]{16}$/);
    expect(p.asOf).toBe("2026-10-16T15:00:00.000Z");
    expect(p.settings).toEqual(DEFAULT_SETTINGS);
  });

  // 2026-10-22: "show my history with HOOD" came back empty for the last 90 days (the trades
  // were in April), so the model called show_activity a second time with a wider window and
  // two widgets rendered. A symbol question means the whole history unless a range is given.
  it("a symbol with no from covers all history; an explicit from still wins", async () => {
    const old = act({ symbol: "HOOD", tradeDate: "2026-04-28", settlementDate: "2026-04-29" });
    const p = await buildActivityPage(deps([old]), portfolio(), "sub", { symbol: "hood" });
    expect(p.filters).toMatchObject({ from: "2000-01-01", to: "2026-10-16", symbol: "HOOD" });
    expect(p.rows).toHaveLength(1);
    const ranged = await buildActivityPage(deps([old]), portfolio(), "sub", { symbol: "HOOD", from: "2026-09-01" });
    expect(ranged.filters.from).toBe("2026-09-01");
    expect(ranged.rows).toHaveLength(0);
    const plain = await buildActivityPage(deps([old]), portfolio(), "sub", {});
    expect(plain.filters.from).toBe("2026-07-18");
  });

  it("symbol has the one meaning holdings and income use: XEQT matches XEQT.TO and a bare XEQT, never XEQTX (I2)", async () => {
    const rows = [act({ symbol: "XEQT" }), act({ symbol: "XEQT.TO" }), act({ symbol: " xeqt.to " }), act({ symbol: "XEQTX" }), act({ symbol: "XEQT.NE" }), act({ symbol: "VFV" })];
    const bare = await buildActivityPage(deps(rows), portfolio(), "sub", { symbol: "xeqt" });
    expect(bare.rows.map((r) => r.symbol!.trim().toUpperCase()).sort()).toEqual(["XEQT", "XEQT.NE", "XEQT.TO", "XEQT.TO"]);
    expect(bare.counts.total).toBe(4);
    expect(bare.filters.symbol).toBe("XEQT");
    // A listing query matches that listing and the bare symbol, not another exchange's listing.
    const listing = await buildActivityPage(deps(rows), portfolio(), "sub", { symbol: "XEQT.TO" });
    expect(listing.rows.map((r) => r.symbol!.trim().toUpperCase()).sort()).toEqual(["XEQT", "XEQT.TO", "XEQT.TO"]);
    // The store is read without the symbol; the match happens in show_activity.
    const d = deps(rows);
    await buildActivityPage(d, portfolio(), "sub", { symbol: "xeqt" });
    expect(d.activities.queryActivities.mock.calls.every((c: any[]) => c[1].symbol === undefined)).toBe(true);
  });

  it("get_symbol_history keeps its exact symbol: XEQT reads only XEQT rows (I2)", async () => {
    const d = deps([act({ symbol: "XEQT" }), act({ symbol: "XEQT.TO" })]);
    await buildSymbolHistory(d, portfolio(), "sub", { symbol: "xeqt" });
    expect(d.activities.queryActivities.mock.calls[0][1].symbol).toBe("XEQT");
  });

  it("get_symbol_history reads a bare symbol as the one listing traded in scope: XEQT opens XEQT.TO", async () => {
    const d = deps([act({ symbol: "XEQT.TO", units: 5 }), act({ symbol: "XEQT.TO", units: 3 }), act({ symbol: "VFV" })]);
    d.market.securityHistory = vi.fn(async () => null);
    const h = await buildSymbolHistory(d, portfolio(), "sub", { symbol: "xeqt" });
    expect(h.symbol).toBe("XEQT.TO");
    expect(h.position.units).toBe(8);
  });

  it("get_symbol_history reads a bare symbol as the one listing held in scope when nothing was traded", async () => {
    const pf = portfolio();
    pf.accounts[0].positions = [{ symbol: "XEQT.TO", units: 4, currency: "CAD", kind: "etf", price: 30, marketValue: 120, costBasis: 25, cashEquivalent: false }];
    const h = await buildSymbolHistory(deps([]), pf, "sub", { symbol: "XEQT" });
    expect(h.symbol).toBe("XEQT.TO");
    expect(h.reportedUnits).toBe(4);
  });

  it("get_symbol_history keeps a bare symbol with several listings in scope, and never reads a share class as a listing", async () => {
    const mixed = await buildSymbolHistory(deps([act({ symbol: "XEQT.TO" }), act({ symbol: "XEQT.NE" })]), portfolio(), "sub", { symbol: "XEQT" });
    expect(mixed.symbol).toBe("XEQT");
    expect(mixed.position.units).toBe(0);
    const shareClass = await buildSymbolHistory(deps([act({ symbol: "CTC.A" })]), portfolio(), "sub", { symbol: "CTC" });
    expect(shareClass.symbol).toBe("CTC");
    // Out of scope does not count: the RRSP's listing is not the TFSA's.
    const scoped = await buildSymbolHistory(deps([act({ symbol: "XEQT.TO", snapTradeAccountId: "RRSP" })]), portfolio(), "sub", { symbol: "XEQT", accountId: "TFSA" });
    expect(scoped.symbol).toBe("XEQT");
  });

  it("lists included investment, cash and credit accounts, never closed or other", async () => {
    const p = await buildActivityPage(deps([]), portfolio(), "sub", {});
    expect(p.accounts).toEqual([
      { id: "TFSA", label: "TFSA", kind: "investment" }, { id: "RRSP", label: "RRSP", kind: "investment" },
      { id: "CASH", label: "Cash / money market", kind: "cash" }, { id: "CARD", label: "Credit card", kind: "credit" },
    ]);
  });

  it("includes cash and credit account rows only when cash is requested", async () => {
    const rows = [
      act({ snapTradeAccountId: "CASH", type: "SPEND", symbol: null, amount: 12, units: null, price: null }),
      act({ snapTradeAccountId: "CARD", type: "CREDIT_CARD", symbol: null, amount: 30, units: null, price: null }),
      act({ snapTradeAccountId: "CASH", type: "DEPOSIT", symbol: null, amount: 500, units: null, price: null }),
      act({}),
    ];
    const d = deps(rows);
    const without = await buildActivityPage(d, portfolio(), "sub", { categories: ["investing", "moving_money"] });
    expect(without.rows.map((r) => r.type).sort()).toEqual(["BUY", "DEPOSIT"]);
    expect(d.activities.queryActivities.mock.calls[0][1].accountIds.sort()).toEqual(["CASH", "RRSP", "TFSA"]);
    const withCash = await buildActivityPage(d, portfolio(), "sub", { categories: ["cash"] });
    expect(withCash.rows.map((r) => r.type).sort()).toEqual(["CREDIT_CARD", "SPEND"]);
    expect(d.activities.queryActivities.mock.calls[1][1].accountIds).toContain("CARD");
  });

  it("totals the whole filtered range per currency while the page holds 50 rows", async () => {
    const rows: StoredActivity[] = [];
    for (let i = 0; i < 60; i++) rows.push(act({ tradeDate: day(i), settlementDate: day(i), amount: -100 }));
    rows.push(act({ type: "SELL", tradeDate: "2026-09-30", units: -1, amount: 250 }));
    rows.push(act({ type: "DIVIDEND", tradeDate: "2026-09-30", units: null, price: null, amount: 7 }));
    rows.push(act({ type: "BUY", currency: "USD", securityCurrency: "USD", amount: -40, tradeDate: "2026-09-30" }));
    const p = await buildActivityPage(deps(rows), portfolio(), "sub", { from: "2026-08-01" });
    expect(p.rows).toHaveLength(50);
    expect(p.nextCursor).not.toBeNull();
    const cad = p.totals.find((t) => t.currency === "CAD")!;
    expect(cad).toMatchObject({ bought: 6000, sold: 250, dividends: 7 });
    expect(p.totals.find((t) => t.currency === "USD")).toMatchObject({ bought: 40, sold: 0 });
    expect(p.counts.total).toBe(63);
  });

  it("totals deposits, withdrawals (negative) and fee transactions with cash signs", async () => {
    const rows = [
      act({ type: "DEPOSIT", symbol: null, amount: 500 }), act({ type: "WITHDRAWAL", symbol: null, amount: -200 }),
      act({ type: "FEE", symbol: null, amount: -3 }),
    ];
    const p = await buildActivityPage(deps(rows), portfolio(), "sub", { categories: ["investing", "moving_money"] });
    expect(p.totals[0]).toMatchObject({ currency: "CAD", deposits: 500, withdrawals: -200, feeTransactions: -3 });
  });

  it("pages three times with no duplicates, including same-date ties", async () => {
    const rows: StoredActivity[] = [];
    for (let i = 0; i < 120; i++) rows.push(act({ tradeDate: day(Math.floor(i / 4)), settlementDate: day(Math.floor(i / 4)) }));
    const d = deps(rows);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const p = await buildActivityPage(d, portfolio(), "sub", { from: "2026-08-01", ...(cursor ? { cursor } : {}) } as any);
      expect(p.restarted).toBe(false);
      seen.push(...p.rows.map((r) => r.id));
      if (page < 2) expect(p.nextCursor).not.toBeNull(); else expect(p.nextCursor).toBeNull();
      cursor = p.nextCursor ?? undefined;
    }
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });

  it("restarts when the filters changed or the cursor belongs to another user", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => act({ tradeDate: day(i), settlementDate: day(i) }));
    const d = deps(rows);
    const first = await buildActivityPage(d, portfolio(), "sub", { from: "2026-08-01" });
    const cursor = first.nextCursor!;
    const changed = await buildActivityPage(d, portfolio(), "sub", { from: "2026-08-02", cursor } as any);
    expect(changed.restarted).toBe(true);
    expect(changed.rows).toHaveLength(50);
    const other = await buildActivityPage(d, portfolio(), "someone-else", { from: "2026-08-01", cursor } as any);
    expect(other.restarted).toBe(true);
    const same = await buildActivityPage(d, portfolio(), "sub", { from: "2026-08-01", categories: ["investing", "investing"], cursor } as any);
    expect(same.restarted).toBe(false);
    expect(same.rows).toHaveLength(10);
    const garbage = await buildActivityPage(d, portfolio(), "sub", { from: "2026-08-01", cursor: "nonsense" } as any);
    expect(garbage.restarted).toBe(true);
  });

  it("rejects an unknown or closed account", async () => {
    await expect(buildActivityPage(deps([]), portfolio(), "sub", { accountId: "NOPE" })).rejects.toBeInstanceOf(ActivityScopeError);
    await expect(buildActivityPage(deps([]), portfolio(), "sub", { accountId: "OLD" })).rejects.toBeInstanceOf(ActivityScopeError);
    await expect(buildActivityPage(deps([]), portfolio(), "sub", { accountId: "ODD" })).rejects.toMatchObject({ code: "unknown_account" });
  });

  it("scopes to one account", async () => {
    const rows = [act({ snapTradeAccountId: "RRSP" }), act({})];
    const p = await buildActivityPage(deps(rows), portfolio(), "sub", { accountId: "RRSP" });
    expect(p.rows.map((r) => r.accountId)).toEqual(["RRSP"]);
    expect(p.filters.accountId).toBe("RRSP");
  });

  it("lists accounts still syncing", async () => {
    const d = deps([], {}, { RRSP: null, CASH: { ...synced, backfillCompletedAt: null } });
    const p = await buildActivityPage(d, portfolio(), "sub", {});
    expect(p.syncing.sort()).toEqual(["CASH", "RRSP"]);
  });

  it("matches query by symbol prefix and by description substring", async () => {
    const rows = [
      act({ symbol: "VFV" }), act({ symbol: "XEQT" }),
      act({ type: "DEPOSIT", symbol: null, amount: 5 }),
    ];
    const bySymbol = await buildActivityPage(deps(rows), portfolio(), "sub", { query: "vf" });
    expect(bySymbol.rows.map((r) => r.symbol)).toEqual(["VFV"]);
    const byText = await buildActivityPage(deps(rows), portfolio(), "sub", { query: "bought xeq" });
    expect(byText.rows.map((r) => r.symbol)).toEqual(["XEQT"]);
    expect(byText.filters.query).toBe("bought xeq");
  });

  it("does not match the query against the raw brokerage description", async () => {
    const rows = [act({ symbol: "VFV", description: "secret-memo" })];
    const p = await buildActivityPage(deps(rows), portfolio(), "sub", { query: "secret" });
    expect(p.rows).toEqual([]);
  });

  it("always labels credit-account rows cash and keeps them out of investing totals", async () => {
    const rows = [
      act({ snapTradeAccountId: "CARD", type: "FEE", symbol: null, amount: -9, units: null, price: null }),
      act({ snapTradeAccountId: "CARD", type: "INTEREST", symbol: null, amount: -4, units: null, price: null }),
      act({ snapTradeAccountId: "CARD", type: "DEPOSIT", symbol: null, amount: 100, units: null, price: null }),
      act({ type: "FEE", symbol: null, amount: -3, units: null, price: null }),
    ];
    const both = await buildActivityPage(deps(rows), portfolio(), "sub", { categories: ["investing", "cash"] });
    const card = both.rows.filter((r) => r.accountId === "CARD");
    expect(card).toHaveLength(3);
    expect(card.every((r) => r.category === "cash")).toBe(true);
    expect(both.totals[0]).toMatchObject({ feeTransactions: -3, deposits: 0, withdrawals: 0 });
    const cashOnly = await buildActivityPage(deps(rows), portfolio(), "sub", { categories: ["cash"] });
    expect(cashOnly.rows.map((r) => r.accountId)).toEqual(["CARD", "CARD", "CARD"]);
    const investing = await buildActivityPage(deps(rows), portfolio(), "sub", { categories: ["investing", "moving_money"] });
    expect(investing.rows.every((r) => r.accountId !== "CARD")).toBe(true);
  });

  it("never invents values for rows without symbol, price or currency", async () => {
    const p = await buildActivityPage(deps([act({ type: "FEE", symbol: null, units: null, price: null, amount: null, currency: null, securityCurrency: null })]), portfolio(), "sub", {});
    expect(p.rows[0]).toMatchObject({ symbol: null, units: null, price: null, amount: null, currency: null, description: "Fee" });
    expect(p.totals).toEqual([]);
  });

  it("returns an empty page when the user has no stored identity", async () => {
    const d = deps([act({})]);
    d.activities.userId = vi.fn(async () => null);
    const p = await buildActivityPage(d, portfolio(), "sub", {});
    expect(p.rows).toEqual([]);
    expect(p.nextCursor).toBeNull();
  });

  it("keeps the show_activity payload for 50 rows under 60 KB", async () => {
    const rows = Array.from({ length: 80 }, (_, i) => act({ tradeDate: day(i % 40), settlementDate: day(i % 40), symbol: "ABCDEFGHIJKLMNOPQRST", units: 123456.12345678, price: 98765.4321987, amount: -1219253456.78, description: "x".repeat(200) }));
    const p = await buildActivityPage(deps(rows), portfolio(), "sub", { from: "2026-08-01" });
    expect(p.rows).toHaveLength(50);
    expect(JSON.stringify(p).length).toBeLessThan(60_000);
  });
});

describe("CAD home amounts", () => {
  const asts = () => [
    act({ symbol: "ASTS", securityCurrency: "USD", type: "BUY", amount: -1190.67, currency: "CAD", tradeDate: "2026-05-26", settlementDate: "2026-05-26" }),
    act({ symbol: "ASTS", securityCurrency: "USD", type: "BUY", amount: -819, currency: "USD", tradeDate: "2026-05-26", settlementDate: "2026-05-26" }),
    act({ symbol: "ASTS", securityCurrency: "USD", type: "SELL", amount: 4640, currency: "USD", tradeDate: "2026-05-26", settlementDate: "2026-05-26" }),
  ];
  const withFx = (rows: StoredActivity[], usdCad: any) => deps(rows, { market: { securityHistory: vi.fn(async () => null), usdCad } });

  it("adds CAD home amounts to rows and totals (ASTS case)", async () => {
    const d = withFx(asts(), vi.fn(async () => [{ date: "2026-05-26", close: 1.3712 }]));
    const p = await buildActivityPage(d, portfolio(), "sub", { from: "2026-05-01" });
    expect(p.homeTotals.sold).toMatchObject({ amount: 6362.37, estimated: true, rateDates: ["2026-05-26"], excluded: [] });
    expect(p.homeTotals.bought.amount).toBe(2313.68);
    const cadBuy = p.rows.find((r) => r.currency === "CAD")!;
    expect(cadBuy.home).toMatchObject({ amount: -1190.67, estimated: false });
    const usdSell = p.rows.find((r) => r.type === "SELL")!;
    expect(usdSell.home).toMatchObject({ amount: 6362.37, estimated: true, rate: 1.3712, rateDate: "2026-05-26", native: { amount: 4640, currency: "USD" } });
    expect(p.rows.find((r) => r.amount === -819)!.home!.amount).toBe(-1123.01);
    expect(p.totals).toEqual([
      { currency: "CAD", bought: 1190.67, sold: 0, dividends: 0, dividendsGross: 0, withholding: 0, deposits: 0, withdrawals: 0, feeTransactions: 0 },
      { currency: "USD", bought: 819, sold: 4640, dividends: 0, dividendsGross: 0, withholding: 0, deposits: 0, withdrawals: 0, feeTransactions: 0 },
    ]);
  });

  it("without a rate series USD rows are not converted and counted as excluded; rows without an amount get no home", async () => {
    const rows = [...asts(), act({ type: "DEPOSIT", symbol: null, amount: null, units: null, price: null })];
    const p = await buildActivityPage(withFx(rows, vi.fn(async () => { throw new Error("down"); })), portfolio(), "sub", { from: "2026-05-01", categories: ["investing", "moving_money"] });
    expect(p.rows.find((r) => r.type === "SELL")!.home).toMatchObject({ amount: null });
    expect(p.homeTotals.sold).toMatchObject({ amount: 0, excluded: [{ amount: 4640, currency: "USD" }] });
    expect(p.rows.find((r) => r.type === "DEPOSIT")!.home).toBeUndefined();
    const stub = await buildActivityPage(deps(asts()), portfolio(), "sub", { from: "2026-05-01" });
    expect(stub.homeTotals.sold.excluded).toHaveLength(1);
  });

  it("keeps the sign and gives unsigned card rows a home amount", async () => {
    const card = act({ snapTradeAccountId: "CARD", type: "CREDIT_CARD", symbol: null, amount: 30, units: null, price: null });
    const p = await buildActivityPage(deps([card]), portfolio(), "sub", { categories: ["cash"] });
    expect(p.rows[0]).toMatchObject({ unsigned: true, home: { amount: 30, estimated: false } });
  });

  it("nets dividend withholding in the CAD dividends total", async () => {
    const rows = [
      act({ type: "DIVIDEND", symbol: "AAPL", amount: 10, currency: "USD", securityCurrency: "USD", tradeDate: "2026-05-26", settlementDate: "2026-05-26" }),
      act({ type: "TAX", symbol: "AAPL", amount: -1.5, currency: "USD", securityCurrency: "USD", tradeDate: "2026-05-26", settlementDate: "2026-05-26" }),
    ];
    const p = await buildActivityPage(withFx(rows, vi.fn(async () => [{ date: "2026-05-26", close: 1.3712 }])), portfolio(), "sub", { from: "2026-05-01", categories: ["investing", "moving_money"] });
    expect(p.totals.find((t) => t.currency === "USD")!.dividends).toBe(8.5);
    expect(p.homeTotals.dividends.amount).toBe(11.65);
  });

  it("model copy carries homeTotals and the CAD note, keeping per-currency totals and no per-row home amounts", async () => {
    const d = withFx(asts(), vi.fn(async () => [{ date: "2026-05-26", close: 1.3712 }]));
    const copy = activityModelCopy(await buildActivityPage(d, portfolio(), "sub", { from: "2026-05-01" })) as any;
    expect(copy.homeTotals.sold.amount).toBe(6362.37);
    expect(copy.totals).toHaveLength(2);
    expect(copy.notes.cad).toBe("Figures are in CAD; USD amounts are converted at the Bank of Canada rate and marked est.");
    expect(JSON.stringify(copy.recent)).not.toContain("home");
  });

  it("model copy with cadView off: no homeTotals and no CAD note, per-currency totals kept", async () => {
    const d = withFx(asts(), vi.fn(async () => [{ date: "2026-05-26", close: 1.3712 }]));
    const p = await buildActivityPage(d, portfolio(), "sub", { from: "2026-05-01" });
    const copy = activityModelCopy({ ...p, settings: { ...p.settings, cadView: false } }) as any;
    expect(copy.homeTotals).toBeUndefined();
    expect(copy.notes.cad).toBeUndefined();
    expect(JSON.stringify(copy)).not.toContain("Figures are in CAD");
    expect(copy.totals).toHaveLength(2);
    expect(copy.notes.dividends).toMatch(/withholding/);
  });
});

describe("row display (final review I2, I3)", () => {
  it("shows each probe type's amount with the user's money-out sign; card rows of unknown direction are unsigned", async () => {
    const cases: Array<[string, number, number, boolean]> = [
      // type, stored amount, displayed amount, unsigned
      ["BUY", -100, -100, false], ["SELL", 250, 250, false], ["DIVIDEND", 7, 7, false], ["INTEREST", 2, 2, false],
      ["CONTRIBUTION", 500, 500, false], ["WITHDRAWAL", -200, -200, false], ["FEE", -3, -3, false], ["TAX", -1, -1, false],
      ["INTERNAL_CASH_TRANSFER_IN", 40, 40, false], ["INTERNAL_CASH_TRANSFER_OUT", -38, -38, false], ["REIMBURSEMENT", 5, 5, false],
      ["PROMOTION", 1, 1, false], ["FUNDS_CONVERSION", 60, 60, false],
      ["SPEND", 54.2, -54.2, false], ["CREDIT_CARD_PAYMENT", 100, -100, false], ["CREDIT_CARD", 30, 30, true],
    ];
    const rows = cases.map(([type, amount], i) => act({ snapTradeAccountId: "CASH", type, symbol: null, units: null, price: null, amount, tradeDate: day(40 + i), settlementDate: day(40 + i) }));
    const p = await buildActivityPage(deps(rows), portfolio(), "sub", { categories: ["investing", "moving_money", "cash"], from: "2026-08-01" });
    for (const [type, , shown, unsigned] of cases) {
      const r = p.rows.find((x) => x.type === type)!;
      expect([type, r.amount, r.unsigned === true]).toEqual([type, shown, unsigned]);
    }
  });

  it("labels the trade price in the row currency when it differs from the security currency (brief 8)", async () => {
    const rows = [
      act({ symbol: "AAPL", currency: "CAD", securityCurrency: "USD", units: 10, price: 29.85, amount: -298.5 }),
      act({ symbol: "VFV", currency: "CAD", securityCurrency: null }),
      act({ symbol: "MSFT", currency: "USD", securityCurrency: "USD", units: 1, price: 400, amount: -400 }),
    ];
    const p = await buildActivityPage(deps(rows), portfolio(), "sub", {});
    expect(p.rows.find((r) => r.symbol === "AAPL")).toMatchObject({ currency: "CAD", price: 29.85, priceCurrency: "CAD", description: "Bought AAPL" });
    expect(p.rows.find((r) => r.symbol === "MSFT")!.priceCurrency).toBe("USD");
    expect(p.rows.find((r) => r.symbol === "VFV")!.priceCurrency).toBe("CAD");
  });
});

describe("activity text and model copy", () => {
  const rows = [
    ...Array.from({ length: 12 }, () => act({})), ...Array.from({ length: 3 }, () => act({ type: "SELL", units: -1, amount: 100 })),
    ...Array.from({ length: 18 }, () => act({ type: "DIVIDEND", units: null, price: null, amount: 3 })),
  ];
  it("summarises counts with no amounts or ids", async () => {
    const p = await buildActivityPage(deps(rows), portfolio(), "sub", {});
    expect(activityText(p)).toBe("33 investing activities across all accounts from Jul 18 to Oct 16: 12 buys, 3 sells, 18 dividends.");
    expect(activityText(p, { show: true })).toBe("33 investing activities across all accounts from Jul 18 to Oct 16: 12 buys, 3 sells, 18 dividends. Showing the activity widget.");
    expect(activityText(p)).not.toMatch(/\$|k0\d{4}|[0-9a-f]{16}/);
    const empty = await buildActivityResult(deps([]), portfolio(), "sub", { accountId: "TFSA" });
    expect(activityText(empty.page, { facts: empty.facts })).toBe("No investing activities in Self-directed TFSA from Jul 18 to Oct 16.");
  });

  it("keeps the model copy compact for 200 rows", async () => {
    const many = Array.from({ length: 200 }, (_, i) => act({ tradeDate: day(i % 60), settlementDate: day(i % 60), symbol: "ABCDEFGHIJ" }));
    const p = await buildActivityPage(deps(many), portfolio(), "sub", { from: "2026-08-01" });
    const copy = activityModelCopy(p) as any;
    expect(JSON.stringify(copy).length).toBeLessThan(6_000);
    expect(copy.recent).toHaveLength(10);
    // Units and price left the description (I4); the model copy keeps them as fields.
    expect(copy.recent[0]).toEqual({ date: expect.any(String), description: "Bought ABCDEFGHIJ", units: 1, price: 100, priceCurrency: "CAD" });
    const bare = activityModelCopy(await buildActivityPage(deps([act({ type: "DEPOSIT", symbol: null, units: null, price: null, amount: 5 })]), portfolio(), "sub", { categories: ["moving_money"] })) as any;
    expect(bare.recent[0]).toEqual({ date: expect.any(String), description: "Deposit" });
    expect(copy.totals).toBeDefined();
    expect(copy.rows).toBeUndefined();
  });

  it("uses the account label, not its id, in the model copy filters", async () => {
    const p = await buildActivityPage(deps([act({})]), portfolio(), "sub", { accountId: "RRSP" });
    const copy = activityModelCopy(p) as any;
    expect(copy.filters.accountLabel).toBe("RRSP");
    expect(copy.filters.accountId).toBeUndefined();
  });

  it("words categories in a fixed order with a final and", async () => {
    const p = await buildActivityPage(deps([]), portfolio(), "sub", { categories: ["cash", "investing", "moving_money"] });
    expect(activityText(p)).toBe("No investing, money movement, and cash and spending activities across all accounts from Jul 18 to Oct 16.");
    const two = await buildActivityPage(deps([]), portfolio(), "sub", { categories: ["cash", "investing"] });
    expect(activityText(two)).toContain("No investing and cash and spending activities");
  });
});

describe("buildSymbolHistory", () => {
  const hist = (over: Record<string, any> = {}) => ({ points: [{ date: "2026-01-02", close: 50 }, { date: "2026-03-01", close: 60 }, { date: "2026-06-01", close: 70 }], splits: [{ date: "2026-02-01", ratio: 2 }], ...over });

  it("converts closes to as-traded using later splits and computes the position", async () => {
    const rows = [
      act({ symbol: "VFV", tradeDate: "2026-01-05", settlementDate: "2026-01-05", units: 10, price: 100, amount: -1000 }),
      act({ type: "DIVIDEND", symbol: "VFV", tradeDate: "2026-04-01", settlementDate: "2026-04-01", units: null, price: null, amount: 4 }),
    ];
    const d = deps(rows);
    d.market.securityHistory = vi.fn(async () => hist());
    const h = await buildSymbolHistory(d, portfolio(), "sub", { symbol: " vfv ", period: "ALL" });
    expect(d.market.securityHistory).toHaveBeenCalledWith("VFV", "2025-12-26", "2026-10-16");
    expect(h.symbol).toBe("VFV");
    expect(h.priceUnavailable).toBe(false);
    expect(h.prices).toEqual([{ date: "2026-01-02", close: 100 }, { date: "2026-03-01", close: 60 }, { date: "2026-06-01", close: 70 }]);
    expect(h.position).toMatchObject({ units: 20, currency: "CAD", dividends: 4 });
    expect(h.position.avgCost).toBeCloseTo(50);
    expect(h.currency).toBe("CAD");
    expect(h.otherCurrencies).toEqual([]);
    expect(h.period).toBe("ALL");
  });

  it("defaults to ALL; 1Y fetches from the first activity so old splits still count, and only trims prices", async () => {
    const rows = [act({ tradeDate: "2024-01-05", settlementDate: "2024-01-05", units: 10, price: 100, amount: -1000 })];
    const h0 = { points: [{ date: "2024-02-01", close: 50 }, { date: "2025-11-01", close: 70 }, { date: "2026-06-01", close: 80 }], splits: [{ date: "2024-06-01", ratio: 2 }] };
    const run = async (period?: "1Y" | "ALL") => {
      const d = deps(rows);
      d.market.securityHistory = vi.fn(async () => h0);
      const h = await buildSymbolHistory(d, portfolio(), "sub", { symbol: "VFV", ...(period ? { period } : {}) });
      expect(d.market.securityHistory).toHaveBeenCalledWith("VFV", "2023-12-26", "2026-10-16");
      return h;
    };
    const all = await run();
    const one = await run("1Y");
    expect(all.period).toBe("ALL");
    expect(all.position.units).toBe(20);
    expect(all.position.avgCost).toBeCloseTo(50);
    expect(one.position).toEqual(all.position);
    expect(all.prices).toHaveLength(3);
    expect(one.prices.map((p) => p.date)).toEqual(["2025-11-01", "2026-06-01"]);
  });

  it("prices an unpriced transfer-in with the as-traded close on or before its date", async () => {
    const rows = [act({ type: "TRANSFER", tradeDate: "2026-03-05", settlementDate: "2026-03-05", units: 10, price: null, amount: null })];
    const d = deps(rows);
    d.market.securityHistory = vi.fn(async () => hist({ splits: [] }));
    const h = await buildSymbolHistory(d, portfolio(), "sub", { symbol: "VFV" });
    expect(h.position.avgCost).toBe(60);
    expect(h.position.avgCostEstimated).toBe(true);
  });

  it("ignores rows of other symbols returned by the store", async () => {
    const d = deps([]);
    d.activities.queryActivities = vi.fn(async () => [act({ symbol: "OTHER" }), act({ symbol: "OTHER" }), act({ symbol: "VFV" })]);
    const h = await buildSymbolHistory(d, portfolio(), "sub", { symbol: "vfv" });
    expect(h.position.units).toBe(1);
    expect(h.otherCurrencies).toEqual([]);
  });

  it("flags priceUnavailable when history is not found, null or has no split list", async () => {
    const rows = [act({ tradeDate: "2026-01-05", settlementDate: "2026-01-05", units: 10, price: 100, amount: -1000 })];
    for (const value of [{ points: [], splits: [], notFound: true }, null, hist({ splits: null })]) {
      const d = deps(rows);
      d.market.securityHistory = vi.fn(async () => value);
      const h = await buildSymbolHistory(d, portfolio(), "sub", { symbol: "VFV", period: "ALL" });
      expect(h.priceUnavailable).toBe(true);
      expect(h.prices).toEqual([]);
      expect(h.position.units).toBe(10);
    }
  });

  it("treats a slow provider as unavailable", async () => {
    const d = deps([act({})], { marketDeadlineMs: 10 });
    d.market.securityHistory = vi.fn(() => new Promise(() => {}));
    const h = await buildSymbolHistory(d, portfolio(), "sub", { symbol: "VFV" });
    expect(h.priceUnavailable).toBe(true);
  });

  it("splits a multi-currency symbol: most rows win, the rest are listed", async () => {
    const rows = [
      act({ symbol: "ABX" }), act({ symbol: "ABX" }),
      act({ symbol: "ABX", currency: "USD", securityCurrency: "USD", units: 3, price: 20, amount: -60 }),
      act({ snapTradeAccountId: "RRSP", symbol: "ABX" }),
    ];
    const d = deps(rows);
    const h = await buildSymbolHistory(d, portfolio(), "sub", { symbol: "abx" });
    expect(h.currency).toBe("CAD");
    expect(h.otherCurrencies).toEqual(["USD"]);
    expect(h.position.units).toBe(3);
  });

  it("converts a CAD-row trade of a USD security to USD at the day's USD/CAD rate (brief 8)", async () => {
    const rows = [act({ symbol: "XUS", currency: "CAD", securityCurrency: "USD", tradeDate: "2026-03-05", settlementDate: "2026-03-05", units: 10, price: 29.85, amount: -298.5 })];
    const d = deps(rows);
    d.market.usdCad = vi.fn(async () => [{ date: "2026-03-04", close: 1.4 }]);
    const h = await buildSymbolHistory(d, portfolio(), "sub", { symbol: "XUS" });
    expect(d.market.usdCad).toHaveBeenCalled();
    expect(h.currency).toBe("USD");
    expect(h.position.avgCost).toBeCloseTo(21.32, 2);
    expect(h.position.markers[0]!.price).toBeCloseTo(21.32, 2);
    // No FX: the price is unknown and the cost estimated.
    const none = deps(rows);
    none.market.usdCad = vi.fn(async () => null);
    const u = await buildSymbolHistory(none, portfolio(), "sub", { symbol: "XUS" });
    expect(u.position.avgCost).toBeNull();
    expect(u.position.avgCostEstimated).toBe(true);
    expect(u.position.markers[0]!.price).toBeNull();
  });

  it("does not fetch FX when every trade is in the security currency", async () => {
    const d = deps([act({})]);
    d.market.usdCad = vi.fn(async () => null);
    await buildSymbolHistory(d, portfolio(), "sub", { symbol: "VFV" });
    expect(d.market.usdCad).not.toHaveBeenCalled();
  });

  it("scopes by account and rejects unknown accounts", async () => {
    const rows = [act({ snapTradeAccountId: "RRSP" }), act({})];
    const h = await buildSymbolHistory(deps(rows), portfolio(), "sub", { symbol: "VFV", accountId: "RRSP" });
    expect(h.position.units).toBe(1);
    await expect(buildSymbolHistory(deps(rows), portfolio(), "sub", { symbol: "VFV", accountId: "NOPE" })).rejects.toBeInstanceOf(ActivityScopeError);
  });
});

describe("buildSymbolHistory across accounts and positions (final review I1, I3, I9)", () => {
  const withPositions = (positions: Record<string, any[]>, unavailable: string[] = []): any => {
    const p = portfolio();
    for (const a of p.accounts) {
      a.positions = positions[a.id] ?? [];
      a.freshness = { holdingsUnavailable: unavailable.includes(a.id) };
    }
    return p;
  };
  const pos = (symbol: string, units: number, currency = "CAD") => ({ symbol, units, currency, cashEquivalent: false, kind: "stock" });

  it("replays All accounts per account, then combines", async () => {
    const rows = [
      act({ snapTradeAccountId: "TFSA", tradeDate: "2026-01-05", units: 10, price: 100, amount: -1000 }),
      act({ snapTradeAccountId: "RRSP", tradeDate: "2026-02-05", units: 10, price: 200, amount: -2000 }),
      act({ snapTradeAccountId: "TFSA", type: "SELL", tradeDate: "2026-03-05", units: -10, price: 150, amount: 1500 }),
    ];
    const h = await buildSymbolHistory(deps(rows), portfolio(), "sub", { symbol: "VFV" });
    expect(h.position.units).toBe(10);
    expect(h.position.avgCost).toBeCloseTo(200);
  });

  it("converts a CAD-row price of a USD security at the reported fxRate and lists CAD dividends separately", async () => {
    const rows = [
      act({ symbol: "AAPL", currency: "CAD", securityCurrency: "USD", fxRate: 1.38, tradeDate: "2026-01-05", units: 10, price: 200, amount: -2000 }),
      act({ symbol: "AAPL", type: "DIVIDEND", currency: "CAD", securityCurrency: "USD", tradeDate: "2026-02-05", units: null, price: null, amount: 6.9 }),
    ];
    const h = await buildSymbolHistory(deps(rows), portfolio(), "sub", { symbol: "AAPL" });
    expect(h.currency).toBe("USD");
    expect(h.position.avgCost).toBeCloseTo(200 / 1.38, 6);
    expect(h.position.dividends).toBe(0);
    expect(h.position.otherDividends).toEqual([{ currency: "CAD", amount: 6.9 }]);
  });

  it("reports the brokerage's units for the symbol in the same accounts and currency", async () => {
    const rows = [act({ tradeDate: "2026-01-05", units: 10, price: 100, amount: -1000 })];
    const p = withPositions({ TFSA: [pos("VFV", 12), pos("XEQT", 3), pos("VFV", 99, "USD")], RRSP: [pos("vfv", 1)], CARD: [pos("VFV", 50)] });
    const all = await buildSymbolHistory(deps(rows), p, "sub", { symbol: "VFV" });
    expect(all.position.units).toBe(10);
    expect(all.reportedUnits).toBe(13);
    const one = await buildSymbolHistory(deps(rows), p, "sub", { symbol: "VFV", accountId: "TFSA" });
    expect(one.reportedUnits).toBe(12);
    const sold = await buildSymbolHistory(deps(rows), withPositions({}), "sub", { symbol: "VFV" });
    expect(sold.reportedUnits).toBe(0);
  });

  it("has no reported units when an in-scope account's holdings are unavailable", async () => {
    const rows = [act({ tradeDate: "2026-01-05", units: 10, price: 100, amount: -1000 })];
    const h = await buildSymbolHistory(deps(rows), withPositions({ RRSP: [pos("VFV", 2)] }, ["TFSA"]), "sub", { symbol: "VFV" });
    expect(h.reportedUnits).toBeNull();
  });

  it("returns exactly the output schema's keys", async () => {
    const def = activityToolDefinitions.find((t) => t.name === "get_symbol_history")!;
    const h = await buildSymbolHistory(deps([act({})]), portfolio(), "sub", { symbol: "VFV" });
    expect(Object.keys(h).sort()).toEqual([...def.outputSchema.required].sort());
    expect(Object.keys(def.outputSchema.properties).sort()).toEqual([...def.outputSchema.required].sort());
  });
});

describe("buildSymbolHistory brokerage-reported figures and the cost-history gate", () => {
  const withPositions = (positions: Record<string, any[]>, unavailable: string[] = []): any => {
    const p = portfolio();
    for (const a of p.accounts) { a.positions = positions[a.id] ?? []; a.freshness = { holdingsUnavailable: unavailable.includes(a.id) }; }
    return p;
  };
  const pos = (over: Record<string, any> = {}) => ({ symbol: "HIMS", units: 10, currency: "USD", cashEquivalent: false, kind: "stock", price: 30, costBasis: 40, ...over });
  // USD rows of a USD security; the amount is always −units × price (a SELL's units are negative).
  const usdBuy = (over: Partial<StoredActivity> = {}) => {
    const units = over.units ?? 10;
    const price = over.price === undefined ? 40 : over.price;
    return act({ symbol: "HIMS", currency: "USD", securityCurrency: "USD", tradeDate: "2026-01-05", settlementDate: "2026-01-05", ...over, units, price, amount: price === null || units === null ? null : -units * price });
  };

  it("weights the reported cost basis across accounts", async () => {
    const rows = [usdBuy(), usdBuy({ snapTradeAccountId: "RRSP", units: 30 })];
    const p = withPositions({ TFSA: [pos({ units: 10, costBasis: 30 })], RRSP: [pos({ units: 30, costBasis: 50 })] });
    const h = await buildSymbolHistory(deps(rows), p, "sub", { symbol: "HIMS" });
    expect(h.reported).not.toBeNull();
    expect(h.reported!.units).toBe(40);
    expect(h.reported!.avgCost).toBeCloseTo(45);
    expect(h.reported!.bookCost).toBeCloseTo(1800);
    expect(h.reported!.marketValue).toBeCloseTo(1200);
    expect(h.reported!.totalReturn).toBeCloseTo(-600);
    expect(h.reported!.totalReturnFraction).toBeCloseTo(-1 / 3);
    expect(h.reported!.currency).toBe("USD");
    expect(h.reportedUnits).toBe(h.reported!.units);
  });

  it("scopes the reported figures to one account", async () => {
    const rows = [usdBuy(), usdBuy({ snapTradeAccountId: "RRSP", units: 30 })];
    const p = withPositions({ TFSA: [pos({ units: 10, costBasis: 30 })], RRSP: [pos({ units: 30, costBasis: 50 })] });
    const h = await buildSymbolHistory(deps(rows), p, "sub", { symbol: "HIMS", accountId: "TFSA" });
    expect(h.reported).toMatchObject({ units: 10, currency: "USD" });
    expect(h.reported!.avgCost).toBeCloseTo(30);
    expect(h.reported!.bookCost).toBeCloseTo(300);
    expect(h.reportedUnits).toBe(10);
  });

  it("a missing cost basis nulls the cost figures but keeps units and market value", async () => {
    const rows = [usdBuy(), usdBuy({ snapTradeAccountId: "RRSP", units: 30 })];
    const p = withPositions({ TFSA: [pos({ units: 10, costBasis: null })], RRSP: [pos({ units: 30, costBasis: 50 })] });
    const h = await buildSymbolHistory(deps(rows), p, "sub", { symbol: "HIMS" });
    expect(h.reported).toMatchObject({ units: 40, avgCost: null, bookCost: null, totalReturn: null, totalReturnFraction: null, currency: "USD" });
    expect(h.reported!.marketValue).toBeCloseTo(1200);
    expect(h.costHistory).toBe("unverified");
  });

  it("a closed position has no reported figures", async () => {
    const rows = [usdBuy(), usdBuy({ type: "SELL", tradeDate: "2026-02-05", settlementDate: "2026-02-05", units: -10, price: 45 })];
    const h = await buildSymbolHistory(deps(rows), withPositions({}), "sub", { symbol: "HIMS" });
    expect(h.reported).toBeNull();
    expect(h.costHistory).toBe("unverified");
    const unavailable = await buildSymbolHistory(deps([usdBuy()]), withPositions({ TFSA: [pos()] }, ["TFSA"]), "sub", { symbol: "HIMS" });
    expect(unavailable.reported).toBeNull();
  });

  it("a replayed average far from the reported one hides the cost history (HIMS: 45.37 vs 36.64)", async () => {
    const rows = [usdBuy({ units: 10, price: 45.37 })];
    const h = await buildSymbolHistory(deps(rows), withPositions({ TFSA: [pos({ units: 10, costBasis: 36.64 })] }), "sub", { symbol: "HIMS" });
    expect(h.costHistory).toBe("unavailable");
    expect(h.position.points.length).toBeGreaterThan(0);
    expect(h.position.points.every((pt) => pt.avgCost === null)).toBe(true);
    expect(h.position.points[0].units).toBe(10);
    expect(h.position.markers).toHaveLength(1);
    expect(h.reported!.avgCost).toBeCloseTo(36.64);
  });

  it("a replayed average within 1% of the reported one keeps the cost history", async () => {
    const rows = [usdBuy({ units: 10, price: 36.9 })];
    const h = await buildSymbolHistory(deps(rows), withPositions({ TFSA: [pos({ units: 10, costBasis: 36.64 })] }), "sub", { symbol: "HIMS" });
    expect(h.costHistory).toBe("matches");
    expect(h.position.points.at(-1)!.avgCost).toBeCloseTo(36.9);
  });

  it("excludes a position in another currency from the group", async () => {
    const rows = [usdBuy()];
    const p = withPositions({ TFSA: [pos({ units: 10, costBasis: 30 }), pos({ units: 5, currency: "CAD", costBasis: 99, price: 99 })] });
    const h = await buildSymbolHistory(deps(rows), p, "sub", { symbol: "HIMS" });
    expect(h.currency).toBe("USD");
    expect(h.reported).toMatchObject({ units: 10, currency: "USD" });
    expect(h.reported!.avgCost).toBeCloseTo(30);
  });

  it("without a group currency, sums only the first matching position's currency", async () => {
    const p = withPositions({ TFSA: [pos({ units: 10, costBasis: 30 })], RRSP: [pos({ units: 5, currency: "CAD", costBasis: 99, price: 99 })] });
    const h = await buildSymbolHistory(deps([]), p, "sub", { symbol: "HIMS" });
    expect(h.reported).toMatchObject({ units: 10, currency: "USD" });
    expect(h.reported!.bookCost).toBeCloseTo(300);
  });

  it("prefers the reported market value; a null price without one nulls the value and return", async () => {
    const rows = [usdBuy()];
    const withValue = await buildSymbolHistory(deps(rows), withPositions({ TFSA: [pos({ marketValue: 333 })] }), "sub", { symbol: "HIMS" });
    expect(withValue.reported!.marketValue).toBe(333);
    expect(withValue.reported!.totalReturn).toBeCloseTo(333 - 400);
    const noPrice = await buildSymbolHistory(deps(rows), withPositions({ TFSA: [pos({ price: null })] }), "sub", { symbol: "HIMS" });
    expect(noPrice.reported).toMatchObject({ units: 10, marketValue: null, totalReturn: null, totalReturnFraction: null });
    expect(noPrice.reported!.avgCost).toBeCloseTo(40);
    expect(noPrice.reported!.bookCost).toBeCloseTo(400);
  });

  it("the 1% boundary matches; just past it is unavailable", async () => {
    const at = await buildSymbolHistory(deps([usdBuy({ price: 101 })]), withPositions({ TFSA: [pos({ costBasis: 100 })] }), "sub", { symbol: "HIMS" });
    expect(at.costHistory).toBe("matches");
    const past = await buildSymbolHistory(deps([usdBuy({ price: 101.02 })]), withPositions({ TFSA: [pos({ costBasis: 100 })] }), "sub", { symbol: "HIMS" });
    expect(past.costHistory).toBe("unavailable");
  });

  it("a replay whose last average is unknown is unavailable against a reported average", async () => {
    const h = await buildSymbolHistory(deps([usdBuy({ price: null })]), withPositions({ TFSA: [pos()] }), "sub", { symbol: "HIMS" });
    expect(h.position.points.at(-1)!.avgCost).toBeNull();
    expect(h.costHistory).toBe("unavailable");
  });

  it("reported has exactly the nested schema keys", async () => {
    const def = activityToolDefinitions.find((t) => t.name === "get_symbol_history")!;
    const h = await buildSymbolHistory(deps([usdBuy()]), withPositions({ TFSA: [pos()] }), "sub", { symbol: "HIMS" });
    const schema = (def.outputSchema.properties as any).reported;
    expect(Object.keys(h.reported!).sort()).toEqual([...schema.required].sort());
    expect(Object.keys(schema.properties).sort()).toEqual([...schema.required].sort());
    expect(schema.additionalProperties).toBe(false);
  });

  it("the model copy uses the reported units and average", async () => {
    const h = await buildSymbolHistory(deps([usdBuy()]), withPositions({ TFSA: [pos({ units: 12, costBasis: 30 })] }), "sub", { symbol: "HIMS" });
    const copy = symbolHistoryModelCopy(h);
    expect(copy).toMatchObject({ units: 12, avgCostEstimated: false });
    expect(copy.avgCost).toBeCloseTo(30);
    const closed = await buildSymbolHistory(deps([usdBuy()]), withPositions({}), "sub", { symbol: "HIMS" });
    expect(symbolHistoryModelCopy(closed)).toMatchObject({ units: 10, avgCost: 40, avgCostEstimated: false });
  });

  it("no reported average leaves the cost history unverified", async () => {
    const rows = [usdBuy({ units: 10, price: 45.37 })];
    const h = await buildSymbolHistory(deps(rows), withPositions({ TFSA: [pos({ costBasis: null })] }), "sub", { symbol: "HIMS" });
    expect(h.costHistory).toBe("unverified");
    expect(h.position.points.at(-1)!.avgCost).toBeCloseTo(45.37);
  });
});

describe("buildSymbolHistory price sanity guard", () => {
  const withPositions = (positions: Record<string, any[]>): any => {
    const p = portfolio();
    for (const a of p.accounts) { a.positions = positions[a.id] ?? []; a.freshness = { holdingsUnavailable: false }; }
    return p;
  };
  const pos = (over: Record<string, any> = {}) => ({ symbol: "VFV", units: 10, currency: "CAD", cashEquivalent: false, kind: "stock", price: 100, ...over });
  const history = (close: number) => ({ points: [{ date: "2026-01-02", close }, { date: "2026-06-01", close }], splits: [] });
  const buyRows = () => [
    act({ tradeDate: "2026-01-05", settlementDate: "2026-01-05", units: 10, price: 100, amount: -1000 }),
    act({ type: "DIVIDEND", tradeDate: "2026-04-01", settlementDate: "2026-04-01", units: null, price: null, amount: 4 }),
  ];
  const run = async (rows: StoredActivity[], positions: any[], close: number) => {
    const d = deps(rows);
    d.market.securityHistory = vi.fn(async () => history(close));
    return buildSymbolHistory(d, withPositions({ TFSA: positions }), "sub", { symbol: "VFV" });
  };

  it("a normal symbol still returns prices", async () => {
    const h = await run(buyRows(), [pos()], 102);
    expect(h.priceUnavailable).toBe(false);
    expect(h.prices).toHaveLength(2);
  });

  it("a non-trusted kind hides the price chart but keeps the position", async () => {
    const normal = await run(buyRows(), [pos()], 100);
    const h = await run(buyRows(), [pos({ kind: "other" })], 100);
    expect(h.priceUnavailable).toBe(true);
    expect(h.prices).toEqual([]);
    expect(h.position).toEqual(normal.position);
    expect(h.reportedUnits).toBe(10);
  });

  it("a latest close more than 50% off the reported price hides the price chart", async () => {
    for (const close of [0.7, 49, 151]) {
      const h = await run(buyRows(), [pos()], close);
      expect(h.priceUnavailable).toBe(true);
      expect(h.prices).toEqual([]);
      expect(h.position).toMatchObject({ units: 10, dividends: 4 });
      expect(h.position.avgCost).toBeCloseTo(100);
    }
    const ok = await run(buyRows(), [pos()], 140);
    expect(ok.priceUnavailable).toBe(false);
  });

  it("an in-kind transfer of a guarded symbol is priced at the reported price, else null", async () => {
    const rows = [act({ type: "TRANSFER", tradeDate: "2026-03-05", settlementDate: "2026-03-05", units: 10, price: null, amount: null })];
    const priced = await run(rows, [pos({ kind: "other", price: 97 })], 0.7);
    expect(priced.position.avgCost).toBe(97);
    expect(priced.position.avgCostEstimated).toBe(true);
    const unpriced = await run(rows, [pos({ kind: "other", price: null })], 0.7);
    expect(unpriced.priceUnavailable).toBe(true);
    expect(unpriced.position.avgCost).toBeNull();
  });
});

describe("input schemas", () => {
  it("validates dates, ranges, query length and categories", () => {
    expect(activityFiltersInput.safeParse({}).success).toBe(true);
    expect(activityFiltersInput.safeParse({ from: "2026-02-30" }).success).toBe(false);
    expect(activityFiltersInput.safeParse({ from: "2026-2-3" }).success).toBe(false);
    expect(activityFiltersInput.safeParse({ from: "2026-05-02", to: "2026-05-01" }).success).toBe(false);
    expect(activityFiltersInput.safeParse({ from: "2026-05-01", to: "2026-05-01" }).success).toBe(true);
    expect(activityFiltersInput.safeParse({ query: "x".repeat(1001) }).success).toBe(false);
    expect(activityFiltersInput.safeParse({ categories: [] }).success).toBe(false);
    expect(activityFiltersInput.safeParse({ categories: ["bogus"] }).success).toBe(false);
    expect(activityFiltersInput.safeParse({ extra: 1 }).success).toBe(false);
    expect(activityPageInput.safeParse({ cursor: "abc" }).success).toBe(true);
    expect(activityFiltersInput.safeParse({ cursor: "abc" }).success).toBe(false);
    expect(symbolHistoryInput.safeParse({ symbol: "" }).success).toBe(false);
    expect(symbolHistoryInput.safeParse({ symbol: "   " }).success).toBe(false);
    expect(symbolHistoryInput.safeParse({ symbol: "x".repeat(41) }).success).toBe(false);
    expect(symbolHistoryInput.safeParse({ symbol: "VFV", period: "ALL" }).success).toBe(true);
    expect(symbolHistoryInput.safeParse({ symbol: "VFV", period: "5Y" }).success).toBe(false);
  });
});

describe("activityToolDefinitions", () => {
  it("has names, visibility and widget metadata", () => {
    const [show, page, symbol] = activityToolDefinitions;
    expect([show.name, page.name, symbol.name]).toEqual(["show_activity", "get_activity_page", "get_symbol_history"]);
    expect(show._meta).toMatchObject({
      ui: { resourceUri: ACTIVITY_WIDGET_URI }, "openai/outputTemplate": ACTIVITY_WIDGET_URI, "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Loading activity…", "openai/toolInvocation/invoked": "Activity ready.",
      securitySchemes: [{ type: "oauth2", scopes: ["portfolio:read"] }],
    });
    expect(ACTIVITY_WIDGET_URI).toBe("ui://portfolio/activity-v1");
    expect(show.description).toContain("Read-only.");
    expect((show._meta as any).ui.visibility).toBeUndefined();
    expect(page._meta.ui).toEqual({ visibility: ["app"] });
    expect(symbol._meta.ui).toEqual({ visibility: ["app"] });
    for (const t of activityToolDefinitions) {
      expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(t.securitySchemes).toEqual([{ type: "oauth2", scopes: ["portfolio:read"] }]);
      expect(t.outputSchema.additionalProperties).toBe(false);
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
    expect(show.outputSchema.required).toEqual(["rows", "nextCursor", "restarted", "totals", "homeTotals", "counts", "filters", "accounts", "syncing", "settings", "asOf"]);
    expect(page.outputSchema.required).toEqual(show.outputSchema.required);
    expect(symbol.outputSchema.required).toEqual(["symbol", "name", "currency", "period", "prices", "priceUnavailable", "position", "reportedUnits", "reported", "costHistory", "homeGains", "otherCurrencies", "asOf"]);
    expect(symbol.inputSchema.required).toEqual(["symbol"]);
  });
});

describe("activity totals match what reached the account (brief 9)", () => {
  it("9: nets dividends against matched withholding tax and reports gross and withholding", async () => {
    const rows = [
      act({ type: "DIVIDEND", symbol: "AAPL", currency: "USD", securityCurrency: "USD", units: null, price: null, amount: 100, tradeDate: "2026-09-10" }),
      act({ type: "TAX", symbol: "AAPL", currency: "USD", securityCurrency: "USD", units: null, price: null, amount: -15, tradeDate: "2026-09-12" }),
      // Unrelated tax: another symbol, so not netted against the dividend.
      act({ type: "TAX", symbol: "MSFT", currency: "USD", securityCurrency: "USD", units: null, price: null, amount: -5, tradeDate: "2026-09-10" }),
    ];
    const p = await buildActivityPage(deps(rows), portfolio(), "sub", {});
    expect(p.totals.find((t) => t.currency === "USD")).toMatchObject({ dividends: 85, dividendsGross: 100, withholding: -15 });
  });
  it("9: a withholding row more than three days away is not netted", async () => {
    const rows = [
      act({ type: "DIVIDEND", symbol: "AAPL", units: null, price: null, amount: 100, tradeDate: "2026-09-10" }),
      act({ type: "WITHHOLDING", symbol: "AAPL", units: null, price: null, amount: -15, tradeDate: "2026-09-20" }),
    ];
    const p = await buildActivityPage(deps(rows), portfolio(), "sub", {});
    expect(p.totals[0]).toMatchObject({ dividends: 100, dividendsGross: 100, withholding: 0 });
  });
  it("9: a reinvested dividend counts its cash once", async () => {
    const rows = [
      act({ type: "DIVIDEND", symbol: "VFV", units: null, price: null, amount: 10, tradeDate: "2026-09-10" }),
      act({ type: "REI", symbol: "VFV", units: 0.1, price: 100, amount: 10, tradeDate: "2026-09-10" }),
      act({ type: "REI", symbol: "XEQT", units: 0.2, price: 25, amount: 5, tradeDate: "2026-09-10" }),
    ];
    const p = await buildActivityPage(deps(rows), portfolio(), "sub", {});
    expect(p.totals[0]).toMatchObject({ dividends: 15, dividendsGross: 15 });
  });
  it("10: an internal transfer between two in-scope accounts is not a deposit and a withdrawal", async () => {
    const rows = [
      act({ snapTradeAccountId: "TFSA", type: "INTERNAL_CASH_TRANSFER_OUT", symbol: null, units: null, price: null, amount: -500, tradeDate: "2026-09-10" }),
      act({ snapTradeAccountId: "RRSP", type: "INTERNAL_CASH_TRANSFER_IN", symbol: null, units: null, price: null, amount: 500, tradeDate: "2026-09-11" }),
      act({ type: "DEPOSIT", symbol: null, units: null, price: null, amount: 100, tradeDate: "2026-09-12" }),
    ];
    const all = await buildActivityPage(deps(rows), portfolio(), "sub", { categories: ["moving_money"] });
    expect(all.totals[0]).toMatchObject({ deposits: 100, withdrawals: 0 });
    const one = await buildActivityPage(deps(rows), portfolio(), "sub", { categories: ["moving_money"], accountId: "TFSA" });
    expect(one.totals[0]).toMatchObject({ deposits: 100, withdrawals: -500 });
  });
  it("11: fees are fee transactions only, and the model copy says FX spreads are not included", async () => {
    const p = await buildActivityPage(deps([act({ type: "FEE", symbol: null, units: null, price: null, amount: -3 })]), portfolio(), "sub", {});
    expect(p.totals[0]).toMatchObject({ feeTransactions: -3 });
    expect(p.totals[0]).not.toHaveProperty("fees");
    const copy = activityModelCopy(p) as any;
    expect(copy.notes.feeTransactions).toMatch(/FX/);
    expect(copy.notes.dividends).toMatch(/withholding/);
  });
});

it("11: the activity text calls fees fee transactions", async () => {
  const p = await buildActivityPage(deps([act({ type: "FEE", symbol: null, units: null, price: null, amount: -3 })]), portfolio(), "sub", {});
  expect(activityText(p)).toContain("1 fee transaction");
});

describe("withholding matching (review M4, M5)", () => {
  it("does not match withholding in another account with the same symbol", async () => {
    const rows = [
      act({ snapTradeAccountId: "TFSA", type: "DIVIDEND", symbol: "AAPL", units: null, price: null, amount: 100, tradeDate: "2026-09-10" }),
      act({ snapTradeAccountId: "RRSP", type: "TAX", symbol: "AAPL", units: null, price: null, amount: -15, tradeDate: "2026-09-10" }),
    ];
    const p = await buildActivityPage(deps(rows), portfolio(), "sub", {});
    expect(p.totals[0]).toMatchObject({ dividends: 100, withholding: 0 });
  });
  it("adds back a positive withholding refund", async () => {
    const rows = [
      act({ type: "DIVIDEND", symbol: "AAPL", units: null, price: null, amount: 100, tradeDate: "2026-09-10" }),
      act({ type: "TAX", symbol: "AAPL", units: null, price: null, amount: -15, tradeDate: "2026-09-10" }),
      act({ type: "TAX", symbol: "AAPL", units: null, price: null, amount: 5, tradeDate: "2026-09-11" }),
    ];
    const p = await buildActivityPage(deps(rows), portfolio(), "sub", {});
    expect(p.totals[0]).toMatchObject({ dividends: 90, dividendsGross: 100, withholding: -10 });
  });
});

describe("buildSymbolHistory CAD gains (spec 6.4)", () => {
  const withPositions = (positions: Record<string, any[]>, unavailable: string[] = []): any => {
    const p = portfolio();
    for (const a of p.accounts) { a.positions = positions[a.id] ?? []; a.freshness = { holdingsUnavailable: unavailable.includes(a.id) }; }
    return p;
  };
  const usdPos = (over: Record<string, any> = {}) => ({ symbol: "ASTS", units: 10, currency: "USD", cashEquivalent: false, kind: "stock", price: 60, marketValue: 600, costBasis: 50, ...over });
  const cadPos = (over: Record<string, any> = {}) => ({ symbol: "VFV", units: 100, currency: "CAD", cashEquivalent: false, kind: "stock", price: 12, marketValue: 1200, costBasis: 10, ...over });
  const series = [
    { date: "2026-03-02", close: 1.36 }, { date: "2026-03-09", close: 1.37 }, { date: "2026-04-01", close: 1.4 },
    { date: "2026-05-26", close: 1.3712 }, { date: "2026-10-16", close: 1.38 },
  ];
  const withFx = (rows: StoredActivity[], over: Record<string, any> = {}) =>
    deps(rows, { market: { securityHistory: vi.fn(async () => null), usdCad: vi.fn(async () => series) }, ...over });
  const usd = (over: Partial<StoredActivity>) => act({ symbol: "ASTS", securityCurrency: "USD", currency: "USD", snapTradeAccountId: "RRSP", ...over });
  const asts = () => [
    usd({ tradeDate: "2026-03-02", settlementDate: "2026-03-02", units: 10, price: 96.39, amount: -963.9, currency: "CAD" }),
    usd({ tradeDate: "2026-03-09", settlementDate: "2026-03-09", units: 10, price: 119.067, amount: -1190.67, currency: "CAD" }),
    usd({ tradeDate: "2026-04-01", settlementDate: "2026-04-01", units: 10, price: 81.9, amount: -819 }),
    usd({ type: "SELL", tradeDate: "2026-05-26", settlementDate: "2026-05-26", units: -20, price: 116, amount: 2320 }),
  ];
  const oneBuy = () => [usd({ tradeDate: "2026-04-01", settlementDate: "2026-04-01", units: 10, price: 50, amount: -500 })];

  it("ASTS: realized 980.40 est. and unrealized below average cost (branch A)", async () => {
    const p = withPositions({ RRSP: [usdPos({ units: 10, costBasis: 79.89, price: 20, marketValue: 200 })] });
    const h = await buildSymbolHistory(withFx(asts()), p, "sub", { symbol: "ASTS" });
    expect(h.homeGains).toEqual({ realized: { amount: 980.4, estimated: true }, unrealized: { amount: -824.39, estimated: true }, unavailable: false });
  });

  it("a sold-out symbol whose only buy is a cost-less transfer-in is unavailable", async () => {
    const rows = [
      usd({ type: "TRANSFER", units: 10, price: null, amount: 0, tradeDate: "2026-04-01", settlementDate: "2026-04-01" }),
      usd({ type: "SELL", units: -10, price: 116, amount: 1160, tradeDate: "2026-05-26", settlementDate: "2026-05-26" }),
    ];
    const h = await buildSymbolHistory(withFx(rows), withPositions({}), "sub", { symbol: "ASTS" });
    expect(h.homeGains).toEqual({ realized: null, unrealized: null, unavailable: true });
  });

  it("a cleanly sold-out symbol shows realized only", async () => {
    const rows = [...oneBuy(), usd({ type: "SELL", units: -10, price: 116, amount: 1160, tradeDate: "2026-05-26", settlementDate: "2026-05-26" })];
    const h = await buildSymbolHistory(withFx(rows), withPositions({}), "sub", { symbol: "ASTS" });
    // 1160 × 1.3712 = 1590.59; cost 500 × 1.40 = 700.
    expect(h.homeGains).toEqual({ realized: { amount: 890.59, estimated: true }, unrealized: null, unavailable: false });
  });

  it("open position: replayed units within 0.5% of reported are shown, beyond are unavailable", async () => {
    const rows = [act({ symbol: "VFV", units: 100, price: 10, amount: -1000 })];
    const near = await buildSymbolHistory(withFx(rows), withPositions({ TFSA: [cadPos({ units: 100.4, marketValue: 1204.8 })] }), "sub", { symbol: "VFV" });
    expect(near.homeGains).toEqual({ realized: { amount: 0, estimated: true }, unrealized: { amount: 204.8, estimated: false }, unavailable: false });
    const far = await buildSymbolHistory(withFx(rows), withPositions({ TFSA: [cadPos({ units: 100.6, marketValue: 1207.2 })] }), "sub", { symbol: "VFV" });
    expect(far.homeGains).toEqual({ realized: null, unrealized: null, unavailable: true });
  });

  it("branch A (cost basis in USD): CAD market value at the latest rate minus the CAD replay cost", async () => {
    const h = await buildSymbolHistory(withFx(oneBuy()), withPositions({ RRSP: [usdPos()] }), "sub", { symbol: "ASTS" });
    // 600 × 1.38 = 828; 500 × 1.40 = 700.
    expect(h.homeGains!.unrealized).toEqual({ amount: 128, estimated: true });
  });

  it("branch B (cost basis in CAD): CAD market value minus reported cost basis × units", async () => {
    const h = await buildSymbolHistory(withFx(oneBuy()), withPositions({ RRSP: [usdPos({ costBasis: 69.5 })] }), "sub", { symbol: "ASTS" });
    // 828 − 69.5 × 10.
    expect(h.homeGains!.unrealized).toEqual({ amount: 133, estimated: true });
    expect(h.homeGains!.unavailable).toBe(false);
  });

  it("branch B needs the CAD replay within 3% of the reported cost basis", async () => {
    const h = await buildSymbolHistory(withFx(oneBuy()), withPositions({ RRSP: [usdPos({ costBasis: 66.3 })] }), "sub", { symbol: "ASTS" });
    expect(h.homeGains).toEqual({ realized: null, unrealized: null, unavailable: true });
  });

  it("a cost basis near neither 1 nor USD/CAD of the replayed USD average is unavailable", async () => {
    const h = await buildSymbolHistory(withFx(oneBuy()), withPositions({ RRSP: [usdPos({ costBasis: 60 })] }), "sub", { symbol: "ASTS" });
    expect(h.homeGains!.unavailable).toBe(true);
  });

  it("decides the branch per account and sums across accounts", async () => {
    const rows = [...oneBuy(), usd({ snapTradeAccountId: "TFSA", tradeDate: "2026-04-01", settlementDate: "2026-04-01", units: 10, price: 50, amount: -500 })];
    const p = withPositions({ RRSP: [usdPos()], TFSA: [usdPos({ costBasis: 69.5 })] });
    const h = await buildSymbolHistory(withFx(rows), p, "sub", { symbol: "ASTS" });
    expect(h.homeGains).toEqual({ realized: { amount: 0, estimated: true }, unrealized: { amount: 261, estimated: true }, unavailable: false });
  });

  it("one unavailable account makes the combined figure unavailable, never a partial sum", async () => {
    const rows = [...oneBuy(), usd({ snapTradeAccountId: "TFSA", tradeDate: "2026-04-01", settlementDate: "2026-04-01", units: 10, price: 50, amount: -500 })];
    const p = withPositions({ RRSP: [usdPos()], TFSA: [usdPos({ costBasis: 60 })] });
    const h = await buildSymbolHistory(withFx(rows), p, "sub", { symbol: "ASTS" });
    expect(h.homeGains).toEqual({ realized: null, unrealized: null, unavailable: true });
    const one = await buildSymbolHistory(withFx(rows), p, "sub", { symbol: "ASTS", accountId: "RRSP" });
    expect(one.homeGains!.unavailable).toBe(false);
  });

  it("without a rate series USD gains are unavailable", async () => {
    const d = deps(oneBuy(), { market: { securityHistory: vi.fn(async () => null), usdCad: vi.fn(async () => { throw new Error("down"); }) } });
    const h = await buildSymbolHistory(d, withPositions({ RRSP: [usdPos()] }), "sub", { symbol: "ASTS" });
    expect(h.homeGains!.unavailable).toBe(true);
  });

  it("is null when cadView is off", async () => {
    const d = withFx(oneBuy(), { settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView: false })) } });
    const h = await buildSymbolHistory(d, withPositions({ RRSP: [usdPos()] }), "sub", { symbol: "ASTS" });
    expect(h.homeGains).toBeNull();
  });

  it("model copy carries the CAD gains with est. semantics and no advice", async () => {
    const h = await buildSymbolHistory(withFx(oneBuy()), withPositions({ RRSP: [usdPos()] }), "sub", { symbol: "ASTS" });
    const copy = symbolHistoryModelCopy(h) as any;
    expect(copy.homeGains).toEqual(h.homeGains);
    expect(copy.notes.homeGains).toMatch(/est\./);
    expect(copy.notes.homeGains).not.toMatch(/should|recommend|consider/i);
  });
});

describe("accountType filter, netting for sets and answer-first text (Task 5)", () => {
  // Ids are distinct from names so the text can be checked for ids.
  const typed = (): any => ({
    generatedAt: "2026-10-16T15:00:00.000Z",
    accounts: [
      { id: "acct-7f3a-tfsa-a", name: "TFSA A", classification: cls("tfsa", "registered", true, "TFSA"), value: { amount: 1000, currency: "CAD" } },
      { id: "acct-91c2-tfsa-b", name: "TFSA B", classification: cls("tfsa", "registered", true, "TFSA"), value: { amount: 2000, currency: "CAD" } },
      { id: "acct-55d0-cash", name: "Cash", classification: cls("money_market", "non_registered", true, "Cash / money market"), value: { amount: 500, currency: "CAD" } },
      { id: "acct-2b8e-rrsp", name: "My RRSP", classification: cls("rrsp", "registered", true, "RRSP"), value: { amount: 3000, currency: "CAD" } },
      { id: "acct-0c4d-card", name: "Visa", classification: cls("credit_card", "credit_products", false, "Credit card"), value: null },
    ],
  });
  const A = "acct-7f3a-tfsa-a", B = "acct-91c2-tfsa-b", CASH = "acct-55d0-cash", RRSP = "acct-2b8e-rrsp", CARD = "acct-0c4d-card";
  const move = (account: string, type: string, amount: number | null, date: string, over: Partial<StoredActivity> = {}) =>
    act({ snapTradeAccountId: account, type, symbol: null, units: null, price: null, amount, tradeDate: date, settlementDate: date, ...over });
  const moving = { categories: ["moving_money"] as any, from: "2026-09-01" };
  const ids = /acct-[0-9a-f]{4}-[a-z-]+/;

  it("Review Focus 3: a transfer between two TFSAs nets out under accountType tfsa; a deposit from Cash still counts", async () => {
    const rows = [
      move(A, "INTERNAL_CASH_TRANSFER_OUT", -500, "2026-09-10"), move(B, "INTERNAL_CASH_TRANSFER_IN", 500, "2026-09-10"),
      move(CASH, "INTERNAL_CASH_TRANSFER_OUT", -300, "2026-09-12"), move(A, "INTERNAL_CASH_TRANSFER_IN", 300, "2026-09-12"),
    ];
    const d = deps(rows);
    const { page, facts } = await buildActivityResult(d, typed(), "sub", { ...moving, accountType: "tfsa" });
    expect(page.totals).toEqual([{ currency: "CAD", bought: 0, sold: 0, dividends: 0, dividendsGross: 0, withholding: 0, deposits: 300, withdrawals: 0, feeTransactions: 0 }]);
    expect(page.rows.map((r) => r.accountId).sort()).toEqual([A, A, B]);
    expect(page.filters).toEqual({ categories: ["moving_money"], from: "2026-09-01", to: "2026-10-16", accountType: "tfsa" });
    expect(facts.scope).toBe("in your TFSAs");
    // One scope read and one match-only read of the other listed non-credit accounts, same window.
    const calls = d.activities.queryActivities.mock.calls.map((c: any[]) => c[1]);
    expect(calls).toHaveLength(2);
    // The scope's own read reaches six days past the range for withholding; the rows outside it stay out of the view.
    expect(calls[0]).toEqual({ accountIds: [A, B], from: "2026-08-26", to: "2026-10-22" });
    expect(calls[1]).toEqual({ accountIds: [CASH, RRSP], from: "2026-09-01", to: "2026-10-16" });
    const text = activityText(page, { facts, show: true });
    expect(text).toBe("3 money movement activities in your TFSAs from Sep 1 to Oct 16: 2 deposits, 1 withdrawal; deposits 300.00 CAD (transfers between these accounts left out). Showing the activity widget.");
    expect(text).not.toContain("500");
    expect(text).not.toMatch(ids);
  });

  it("money routed TFSA1 -> Cash -> TFSA2 is a withdrawal and a deposit under accountType tfsa, not a netted transfer", async () => {
    const rows = [
      move(A, "INTERNAL_CASH_TRANSFER_OUT", -1000, "2026-09-10"), move(CASH, "INTERNAL_CASH_TRANSFER_IN", 1000, "2026-09-10"),
      move(CASH, "INTERNAL_CASH_TRANSFER_OUT", -1000, "2026-09-11"), move(B, "INTERNAL_CASH_TRANSFER_IN", 1000, "2026-09-11"),
    ];
    const { page, facts } = await buildActivityResult(deps(rows), typed(), "sub", { ...moving, accountType: "tfsa" });
    expect(page.totals[0]).toMatchObject({ deposits: 1000, withdrawals: -1000 });
    expect(activityText(page, { facts })).toBe("2 money movement activities in your TFSAs from Sep 1 to Oct 16: 1 deposit, 1 withdrawal; deposits 1,000.00 CAD, withdrawals 1,000.00 CAD.");
    // Across all accounts every leg is in scope and both transfers net out, as today.
    const all = await buildActivityResult(deps(rows), typed(), "sub", moving);
    expect(all.page.totals[0]).toMatchObject({ deposits: 0, withdrawals: 0 });
    expect(activityText(all.page, { facts: all.facts })).toBe("4 money movement activities across all accounts from Sep 1 to Oct 16: 2 deposits, 2 withdrawals; no deposit or withdrawal amounts (transfers between these accounts left out).");
  });

  it("a match-only account still backfilling joins the scope's syncing signal; one account and all accounts are unchanged (T5)", async () => {
    const rows = [move(A, "INTERNAL_CASH_TRANSFER_OUT", -1000, "2026-09-10"), move(B, "INTERNAL_CASH_TRANSFER_IN", 1000, "2026-09-10")];
    const backfilling = { [CASH]: { backfillCompletedAt: null, lastSyncedAt: null, lastError: null, dirty: false } };
    const d = deps(rows, {}, backfilling);
    const { page } = await buildActivityResult(d, typed(), "sub", { ...moving, accountType: "tfsa" });
    expect(page.syncing).toEqual([CASH]);
    expect(d.activities.syncState.mock.calls.map((c: any[]) => c[1])).toEqual([A, B, CASH, RRSP]);
    // A read that fails counts as not known to be complete, as for the scope's accounts.
    const failing = deps(rows);
    failing.activities.syncState = vi.fn(async (_u: string, id: string) => { if (id === RRSP) throw new Error("down"); return { backfillCompletedAt: new Date(), lastSyncedAt: null, lastError: null, dirty: false }; });
    expect((await buildActivityResult(failing, typed(), "sub", { ...moving, accountType: "tfsa" })).page.syncing).toEqual([RRSP]);
    // No match-only read without money movement in view, so no outside sync check either.
    expect((await buildActivityResult(deps(rows, {}, backfilling), typed(), "sub", { categories: ["investing"] as any, from: "2026-09-01", accountType: "tfsa" })).page.syncing).toEqual([]);
    // One account and all accounts read no outside accounts: only their own accounts' state.
    expect((await buildActivityResult(deps(rows, {}, backfilling), typed(), "sub", { ...moving, accountId: A })).page.syncing).toEqual([]);
    expect((await buildActivityResult(deps(rows, {}, backfilling), typed(), "sub", moving)).page.syncing).toEqual([CASH]);
    const one = deps(rows, {}, backfilling);
    await buildActivityResult(one, typed(), "sub", { ...moving, accountType: "rrsp" });
    expect(one.activities.syncState.mock.calls.map((c: any[]) => c[1])).toEqual([RRSP]);
  });

  it("one account by type behaves exactly like that accountId, echoes it, and reads no other accounts", async () => {
    const rows = [
      move(RRSP, "INTERNAL_CASH_TRANSFER_OUT", -500, "2026-09-10"), move(A, "INTERNAL_CASH_TRANSFER_IN", 500, "2026-09-10"),
      move(RRSP, "DEPOSIT", 200, "2026-09-12"),
    ];
    const byType = deps(rows);
    const byId = deps(rows);
    const t = await buildActivityResult(byType, typed(), "sub", { ...moving, accountType: "rrsp" });
    const i = await buildActivityResult(byId, typed(), "sub", { ...moving, accountId: RRSP });
    expect(t.page.filters).toEqual({ categories: ["moving_money"], from: "2026-09-01", to: "2026-10-16", accountId: RRSP, accountType: "rrsp" });
    const { filters: _tf, nextCursor: _tn, ...tRest } = t.page;
    const { filters: _if, nextCursor: _in, ...iRest } = i.page;
    expect(JSON.stringify(tRest)).toBe(JSON.stringify(iRest));
    expect(t.page.totals[0]).toMatchObject({ deposits: 200, withdrawals: -500 });
    expect(byType.activities.queryActivities).toHaveBeenCalledTimes(1);
    expect(byId.activities.queryActivities).toHaveBeenCalledTimes(1);
    expect(t.facts.scope).toBe("in your RRSP");
    expect(i.facts.scope).toBe("in My RRSP");
    expect(activityText(i.page, { facts: i.facts })).toBe("2 money movement activities in My RRSP from Sep 1 to Oct 16: 1 deposit, 1 withdrawal; deposits 200.00 CAD, withdrawals 500.00 CAD.");
  });

  it("the all-accounts and single-accountId paths read once and keep the accountId-only filters", async () => {
    const all = deps([]);
    await buildActivityResult(all, typed(), "sub", moving);
    expect(all.activities.queryActivities).toHaveBeenCalledTimes(1);
    const one = await buildActivityPage(deps([]), typed(), "sub", { ...moving, accountId: A });
    expect(one.filters).toEqual({ categories: ["moving_money"], from: "2026-09-01", to: "2026-10-16", accountId: A });
  });

  it("a multi-account scope reads other accounts only when money movement is in view", async () => {
    const d = deps([]);
    await buildActivityResult(d, typed(), "sub", { accountType: "tfsa" });
    expect(d.activities.queryActivities).toHaveBeenCalledTimes(1);
  });

  it("refuses both filters and a type with no account, with the shared copy", async () => {
    await expect(buildActivityPage(deps([]), typed(), "sub", { accountId: A, accountType: "tfsa" } as any))
      .rejects.toMatchObject({ code: "both_filters", text: "Give accountId or accountType, not both." });
    const none = buildActivityPage(deps([]), typed(), "sub", { accountType: "fhsa" });
    await expect(none).rejects.toBeInstanceOf(ActivityScopeError);
    await expect(none).rejects.toMatchObject({ code: "no_accounts_of_type", text: "No connected FHSA accounts. Use list_portfolio_accounts to see what is connected." });
    await expect(buildActivityPage(deps([]), typed(), "sub", { accountId: "nope" }))
      .rejects.toMatchObject({ code: "unknown_account", text: "Unknown or excluded account. Use list_portfolio_accounts to pick an account." });
    // A credit account is listed, so it can be named by id but never matches a type.
    await expect(buildActivityPage(deps([]), typed(), "sub", { accountId: CARD })).resolves.toMatchObject({ filters: { accountId: CARD } });
  });

  it("cash_account scopes the Cash account in the words 'in your Cash account'", async () => {
    const { page, facts } = await buildActivityResult(deps([move(CASH, "DEPOSIT", 50, "2026-09-03")]), typed(), "sub", { ...moving, accountType: "cash_account" });
    expect(page.filters).toMatchObject({ accountId: CASH, accountType: "cash_account" });
    expect(activityText(page, { facts })).toBe("1 money movement activity in your Cash account from Sep 1 to Oct 16: 1 deposit; deposits 50.00 CAD.");
  });

  it("keeps native amounts per currency and never converts deposits, even with a CAD view and reported account totals", async () => {
    const rows = [
      move(A, "DEPOSIT", 300, "2026-09-03"), move(B, "DEPOSIT", 50, "2026-09-04", { currency: "USD" }),
      move(B, "WITHDRAWAL", -20, "2026-09-05", { currency: "USD" }),
      act({ snapTradeAccountId: B, symbol: "AAPL", currency: "USD", securityCurrency: "USD", amount: -100, tradeDate: "2026-09-06", settlementDate: "2026-09-06" }),
    ];
    const d = deps(rows, { market: { securityHistory: vi.fn(async () => null), usdCad: vi.fn(async () => [{ date: "2026-09-04", close: 1.36 }]) } });
    const { page, facts } = await buildActivityResult(d, typed(), "sub", { categories: ["investing", "moving_money"], from: "2026-09-01", accountType: "tfsa" });
    expect(page.homeTotals.bought.estimated).toBe(true);
    const text = activityText(page, { facts });
    expect(text).toBe("4 investing and money movement activities in your TFSAs from Sep 1 to Oct 16: 1 buy, 2 deposits, 1 withdrawal; deposits 300.00 CAD + 50.00 USD, withdrawals 20.00 USD.");
    expect(text).not.toMatch(/est\.|BoC/);
  });

  it("marks deposits and withdrawals whose amounts are unknown, and credit-account rows left out, in the first sentence", async () => {
    const rows = [
      move(A, "DEPOSIT", 300, "2026-09-03"), move(A, "DEPOSIT", null, "2026-09-04"), move(B, "WITHDRAWAL", -40, "2026-09-05", { currency: null }),
      move(CARD, "INTERNAL_CASH_TRANSFER_IN", 75, "2026-09-06"),
    ];
    const { page, facts } = await buildActivityResult(deps(rows), typed(), "sub", { categories: ["moving_money", "cash"], from: "2026-09-01" });
    const text = activityText(page, { facts });
    expect(text).toBe("4 money movement and cash and spending activities across all accounts from Sep 1 to Oct 16: 3 deposits, 1 withdrawal; deposits 300.00 CAD (1 deposit amount unknown; 1 withdrawal amount unknown; 1 credit-account row left out).");
    expect(text.split(". ")[0].length).toBeLessThan(300);
  });

  it("adds 'for {SYMBOL}' to the scope", async () => {
    const { page, facts } = await buildActivityResult(deps([act({ snapTradeAccountId: A, symbol: "XEQT" })]), typed(), "sub", { accountType: "tfsa", symbol: "xeqt" });
    expect(page.filters).toMatchObject({ accountType: "tfsa", symbol: "XEQT" });
    expect(activityText(page, { facts })).toBe("1 investing activity in your TFSAs for XEQT from Jan 1, 2000 to Oct 16: 1 buy.");
    const empty = await buildActivityResult(deps([]), typed(), "sub", { accountType: "rrsp", symbol: "VFV", from: "2026-09-01" });
    expect(activityText(empty.page, { facts: empty.facts })).toBe("No investing activities in your RRSP for VFV from Sep 1 to Oct 16.");
  });

  it("drops the per-kind counts when the first sentence would reach 300 characters", async () => {
    const p = typed();
    p.accounts[3].name = `RRSP ${"x".repeat(170)}`;
    const rows = [
      act({ snapTradeAccountId: RRSP }), act({ snapTradeAccountId: RRSP, type: "SELL", units: -1, amount: 100 }),
      act({ snapTradeAccountId: RRSP, type: "DIVIDEND", units: null, price: null, amount: 3 }), move(RRSP, "DEPOSIT", 10, "2026-09-02"),
      move(RRSP, "WITHDRAWAL", -5, "2026-09-03"), move(RRSP, "FEE", -1, "2026-09-03"),
    ];
    const { page, facts } = await buildActivityResult(deps(rows), p, "sub", { categories: ["investing", "moving_money"], from: "2026-09-01", accountId: RRSP });
    const text = activityText(page, { facts });
    expect(text.length).toBeLessThan(300);
    expect(text).toContain("; deposits 10.00 CAD, withdrawals 5.00 CAD.");
    expect(text).not.toContain("1 buy");
  });

  it("the cursor pages a type scope and the model copy carries the type, not ids", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => act({ snapTradeAccountId: i % 2 ? A : B, tradeDate: day(30 + (i % 30)), settlementDate: day(30 + (i % 30)) }));
    const first = await buildActivityPage(deps(rows), typed(), "sub", { from: "2026-08-01", accountType: "tfsa" });
    expect(first.nextCursor).not.toBeNull();
    const second = await buildActivityPage(deps(rows), typed(), "sub", { from: "2026-08-01", accountType: "tfsa", cursor: first.nextCursor! });
    expect(second.restarted).toBe(false);
    expect(second.rows).toHaveLength(10);
    const copy = activityModelCopy(first) as any;
    expect(copy.filters).toMatchObject({ accountType: "tfsa" });
    expect(JSON.stringify(copy.filters)).not.toMatch(ids);
  });

  it("the input schemas and show_activity accept accountType; the description names the filters", () => {
    expect(activityFiltersInput.safeParse({ accountType: "tfsa" }).success).toBe(true);
    expect(activityPageInput.safeParse({ accountType: "cash_account", cursor: "x" }).success).toBe(true);
    expect(activityFiltersInput.safeParse({ accountType: "cash" }).success).toBe(false);
    expect(symbolHistoryInput.safeParse({ symbol: "VFV", accountType: "tfsa" }).success).toBe(false);
    const [show, page, symbol] = activityToolDefinitions;
    expect((show.inputSchema.properties as any).accountType.enum).toEqual(["tfsa", "fhsa", "rrsp", "non_registered", "crypto", "cash_account"]);
    expect((page.inputSchema.properties as any).accountType).toBeDefined();
    expect((symbol.inputSchema.properties as any).accountType).toBeUndefined();
    expect(show.description).toMatch(/Filter with accountType or accountId, symbol, categories and from\/to dates\. Read-only\.$/);
  });
});

describe("the dividends tile is net of withholding read beyond the view (A3)", () => {
  const usx = { symbol: "USX", securityCurrency: "USD", currency: "USD", units: null, price: null };
  const dividend = act({ ...usx, type: "DIVIDEND", amount: 100, tradeDate: "2025-12-31", settlementDate: "2025-12-31", description: "Dividend USX" });
  const tax = act({ ...usx, type: "TAX", amount: -15, tradeDate: "2026-01-02", settlementDate: "2026-01-02", description: "Withholding tax USX" });
  const year2025 = { from: "2025-01-01", to: "2025-12-31" };
  const year2026 = { from: "2026-01-01", to: "2026-10-16" };
  const usdTotal = (p: any) => p.totals.find((t: any) => t.currency === "USD");

  it("a TAX row posted after the range still nets its dividend, and the row itself stays out of the feed", async () => {
    const p = await buildActivityPage(deps([dividend, tax]), portfolio(), "sub", year2025);
    expect(usdTotal(p)).toMatchObject({ dividends: 85, dividendsGross: 100, withholding: -15 });
    expect(p.rows).toHaveLength(1);
    expect(p.counts.total).toBe(1);
  });

  it("a TAX row posted before the range nets its dividend too", async () => {
    const early = act({ ...usx, type: "TAX", amount: -15, tradeDate: "2026-02-28", settlementDate: "2026-02-28" });
    const paid = act({ ...usx, type: "DIVIDEND", amount: 100, tradeDate: "2026-03-01", settlementDate: "2026-03-01" });
    const p = await buildActivityPage(deps([early, paid]), portfolio(), "sub", { from: "2026-03-01", to: "2026-03-31" });
    expect(usdTotal(p)).toMatchObject({ dividends: 85, withholding: -15 });
  });

  it("the view holding only the TAX row files it under its dividend: no deduction, and not unmatched", async () => {
    const r = await buildActivityResult(deps([dividend, tax]), portfolio(), "sub", year2026);
    expect(usdTotal(r.page)).toMatchObject({ dividends: 0, dividendsGross: 0, withholding: 0 });
    expect(usdTotal(r.page).unmatchedWithholding).toBeUndefined();
    expect(activityText(r.page, { facts: r.facts })).not.toMatch(/matches no dividend/);
  });

  it("search text does not change the net figure: a query matching only the dividend still nets the TAX", async () => {
    const p = await buildActivityPage(deps([dividend, tax]), portfolio(), "sub", { ...year2025, query: "dividend" });
    expect(p.rows.map((r) => r.type)).toEqual(["DIVIDEND"]);
    expect(usdTotal(p)).toMatchObject({ dividends: 85, withholding: -15 });
  });

  it("the CAD tile is net as well, the withholding at the dividend's rate", async () => {
    const p = await buildActivityPage(deps([dividend, tax], {
      settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS, cadView: true })) },
      market: { securityHistory: vi.fn(async (): Promise<any> => null), usdCad: vi.fn(async () => [{ date: "2025-12-31", close: 1.4 }]) },
    }), portfolio(), "sub", year2025);
    expect(p.homeTotals.dividends).toMatchObject({ amount: 119, estimated: true, rateDates: ["2025-12-31"] });
  });

  it("a REI beside a dividend just outside the view is not counted as a dividend of its own", async () => {
    const rei = act({ ...usx, type: "REI", amount: 100, units: 1, tradeDate: "2026-01-01", settlementDate: "2026-01-01" });
    const p = await buildActivityPage(deps([dividend, rei]), portfolio(), "sub", year2026);
    expect(usdTotal(p)).toMatchObject({ dividends: 0, dividendsGross: 0 });
  });
});

describe("withholding that matches no dividend is named, not silently dropped (B12)", () => {
  const usx = { symbol: "USX", securityCurrency: "USD", currency: "USD", units: null, price: null };
  const rows = () => [
    act({ ...usx, type: "DIVIDEND", amount: 100, tradeDate: "2026-09-01", settlementDate: "2026-09-01" }),
    act({ ...usx, type: "TAX", amount: -15, tradeDate: "2026-09-05", settlementDate: "2026-09-05" }),
  ];

  it("a TAX row 4 days after its dividend: not deducted, counted per currency and said in the text, as Income says it", async () => {
    const r = await buildActivityResult(deps(rows()), portfolio(), "sub", { from: "2026-08-01" });
    expect(r.page.totals[0]).toMatchObject({ dividends: 100, withholding: 0, unmatchedWithholding: { count: 1, amount: 15 } });
    expect(activityText(r.page, { facts: r.facts })).toMatch(/15\.00 USD of withholding tax matches no dividend and is not deducted\./);
  });

  it("the symbol view carries the same note", async () => {
    const h = await buildSymbolHistory(deps(rows()), portfolio(), "sub", { symbol: "USX" });
    expect(h.position.dividends).toBe(100);
    expect(h.position.unmatchedWithholding).toEqual([{ currency: "USD", count: 1, amount: 15 }]);
  });
});

describe("the symbol view and show_activity give one net figure (A6)", () => {
  const usx = { symbol: "USX", securityCurrency: "USD", currency: "USD", units: null, price: null };
  it("same net dividends for withholding and for a DRIP pair", async () => {
    const rows = [
      act({ ...usx, type: "DIVIDEND", amount: 100, tradeDate: "2026-03-01", settlementDate: "2026-03-01" }),
      act({ ...usx, type: "TAX", amount: -15, tradeDate: "2026-03-02", settlementDate: "2026-03-02" }),
      act({ ...usx, type: "DIVIDEND", amount: 50, tradeDate: "2026-06-01", settlementDate: "2026-06-01" }),
      act({ ...usx, type: "REI", amount: 50, units: 1, tradeDate: "2026-06-01", settlementDate: "2026-06-01" }),
    ];
    const page = await buildActivityPage(deps(rows), portfolio(), "sub", { symbol: "USX" });
    const h = await buildSymbolHistory(deps(rows), portfolio(), "sub", { symbol: "USX" });
    expect(page.totals[0]!.dividends).toBe(135);
    expect(h.position.dividends).toBe(135);
    expect((symbolHistoryModelCopy(h) as any).dividends).toBe(135);
    expect((symbolHistoryModelCopy(h) as any).notes.dividends).toMatch(/net of withholding/);
  });
});

describe("withdrawals say what they leave out (B6)", () => {
  const cash = { snapTradeAccountId: "CASH", symbol: null, securityCurrency: null, units: null, price: null, tradeDate: "2026-09-10", settlementDate: "2026-09-10" };
  const rows = () => [
    act({ ...cash, type: "WITHDRAWAL", amount: -200 }),
    act({ ...cash, type: "SPEND", amount: 80 }),
    act({ ...cash, type: "CREDIT_CARD_PAYMENT", amount: 300 }),
  ];
  it("names the spending and card payments next to the withdrawals, even when the cash chip is off", async () => {
    const both = await buildActivityResult(deps(rows()), portfolio(), "sub", { from: "2026-09-01", categories: ["moving_money", "cash"] });
    expect(activityText(both.page, { facts: both.facts })).toContain("withdrawals 200.00 CAD (380.00 CAD of spending and card payments not counted as withdrawals)");
    const moving = await buildActivityResult(deps(rows()), portfolio(), "sub", { from: "2026-09-01", categories: ["moving_money"] });
    expect(activityText(moving.page, { facts: moving.facts })).toContain("380.00 CAD of spending and card payments not counted as withdrawals");
  });
  it("stays out of an investing view with no withdrawals", async () => {
    const r = await buildActivityResult(deps(rows()), portfolio(), "sub", { from: "2026-09-01" });
    expect(activityText(r.page, { facts: r.facts })).not.toMatch(/spending/);
  });
  it("the model copy states what withdrawals leaves out", async () => {
    const r = await buildActivityResult(deps(rows()), portfolio(), "sub", { from: "2026-09-01", categories: ["moving_money"] });
    expect(activityModelCopy(r.page).notes.withdrawals).toMatch(/spending and credit card payments/i);
  });
});

// A model put its own question in the search box, so the widget opened on "No activity matches these filters".
describe("show_activity's search text", () => {
  const full = "Total TFSA contributions (deposits) over all time";

  it("keeps a word or short phrase", () => {
    expect(parseShowActivity({ query: "interac" }).query).toBe("interac");
    expect(parseShowActivity({ query: "e-transfer from bank" }).query).toBe("e-transfer from bank");
  });

  it("ignores a sentence, keeping the other filters", () => {
    const input = parseShowActivity({ accountType: "tfsa", query: full });
    expect(input.accountType).toBe("tfsa");
    expect(input).not.toHaveProperty("query");
  });

  it("tells the model what the field is, and sends lifetime questions to the room tool", () => {
    const show = activityToolDefinitions[0] as unknown as { description: string; inputSchema: { properties: { query: { description: string } } } };
    expect(show.inputSchema.properties.query.description).toMatch(/word or short phrase/);
    expect(show.description).toContain("get_contribution_room");
  });
});
