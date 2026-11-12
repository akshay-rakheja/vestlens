import { describe, expect, it, vi } from "vitest";
import { buildOverviewSummary } from "../analytics/overview-summary.js";
import { homeConverter } from "../fx/home-currency.js";
import { DEFAULT_SETTINGS } from "../settings/settings-service.js";
import { buildAllocationPayload } from "./allocation-tools.js";
import { buildHoldingsPayload } from "./holdings-tools.js";

const cls = (bucket: string, group: string, label: string): any => ({ label, bucket, group, includedInPortfolioTotal: true, isClosed: false });
const pos = (over: Record<string, unknown>): any => ({ instrumentId: "i", kind: "etf", symbol: "VFV", description: null, units: 10, price: 100, costBasis: 80, marketValue: 1000, unrealizedGain: null, currency: "CAD", cashEquivalent: false, ...over });
/** One reported-CAD account, one reported-USD account, one account with no reported total. */
const portfolio = (): any => ({
  generatedAt: "2026-10-16T15:00:00.000Z",
  totals: [],
  accounts: [
    { id: "A", classification: cls("tfsa", "registered", "TFSA"), value: { amount: 5000, currency: "CAD", source: "brokerage_reported" }, balances: [{ currency: "CAD", cash: 10, buyingPower: null }], positions: [pos({ marketValue: 4000 })] },
    { id: "B", classification: cls("margin", "non_registered", "Margin"), value: { amount: 2000, currency: "USD", source: "brokerage_reported" }, balances: [], positions: [pos({ symbol: "AAPL", currency: "USD", marketValue: 1900 })] },
    { id: "C", classification: cls("rrsp", "registered", "RRSP"), value: null, balances: [{ currency: "USD", cash: 100, buyingPower: null }], positions: [pos({ symbol: "XEQT", marketValue: 300 })] },
  ],
});
const series = [{ date: "2026-10-14", close: 1.4 }, { date: "2026-10-15", close: 1.5 }];
const deps = (): any => ({
  market: { quotes: vi.fn(async () => new Map()), usdCad: vi.fn(async () => series), profile: vi.fn(async () => null) },
  settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })) },
  now: () => new Date("2026-10-16T15:00:00Z"),
});

describe("one CAD total across Overview, Holdings and Allocation", () => {
  it("agree on the portfolio total", async () => {
    const overview = buildOverviewSummary(portfolio(), new Map(), { home: homeConverter(series, "2026-10-16") }).home!.total;
    const holdings = await buildHoldingsPayload(deps(), portfolio(), "sub", {});
    const allocation = await buildAllocationPayload(deps(), portfolio(), "sub", {});
    expect(overview.amount).toBe(5000 + 2000 * 1.5 + 300 + 100 * 1.5);
    expect(holdings.home!.total.amount).toBe(overview.amount);
    expect(allocation.home!.total.amount).toBe(overview.amount);
    expect(holdings.home!.total.rateDates).toEqual(["2026-10-15"]);
    expect(holdings.home!.includesUnreported).toBe(true);
  });

  it("scopes to one account and keeps the legacy per-currency accountValue", async () => {
    const holdings = await buildHoldingsPayload(deps(), portfolio(), "sub", { accountId: "B" });
    expect(holdings.home!.total).toMatchObject({ amount: 3000, estimated: true });
    expect(holdings.accountValue).toEqual([{ currency: "USD", amount: 2000, source: "reported" }]);
    const allocation = await buildAllocationPayload(deps(), portfolio(), "sub", { accountId: "B" });
    expect(allocation.home!.total.amount).toBe(3000);
  });

  it("gives USD rows a CAD figure and a null cad for CAD rows", async () => {
    const holdings = await buildHoldingsPayload(deps(), portfolio(), "sub", {});
    const usd = holdings.rows.find((r) => r.symbol === "AAPL")!;
    expect(usd.cad!.value).toMatchObject({ amount: 2850, estimated: true, native: { amount: 1900, currency: "USD" } });
    expect(usd.cad!.totalReturn!.amount).toBe(Math.round(usd.totalReturn! * 1.5 * 100) / 100);
    expect(holdings.rows.find((r) => r.symbol === "XEQT")!.cad).toBeUndefined();
    expect(holdings.home!.tiles.value.amount).toBeGreaterThan(0);
  });

  it("with no rate the USD part is not converted and the total keeps the CAD part", async () => {
    const d = deps(); d.market.usdCad = vi.fn(async () => null);
    const holdings = await buildHoldingsPayload(d, portfolio(), "sub", {});
    expect(holdings.home!.total.excluded.length).toBeGreaterThan(0);
    expect(holdings.home!.total.amount).toBe(5300);
    expect(holdings.rows.find((r) => r.symbol === "AAPL")!.cad).toBeUndefined();
  });

  it("Holdings and Allocation take today as the Toronto date: a rate 7 days old at 22:30 Toronto still converts", async () => {
    // 2026-10-22T02:30Z is 22:30 on Oct 21 in Toronto. The Oct 14 rate is 7 days old there (8 by the UTC date).
    const d = deps();
    d.now = () => new Date("2026-10-22T02:30:00Z");
    d.market.usdCad = vi.fn(async () => [{ date: "2026-10-14", close: 1.4 }]);
    const holdings = await buildHoldingsPayload(d, portfolio(), "sub", {});
    const allocation = await buildAllocationPayload(d, portfolio(), "sub", {});
    const overview = buildOverviewSummary(portfolio(), new Map(), { home: homeConverter([{ date: "2026-10-14", close: 1.4 }], "2026-10-21") }).home!.total;
    expect(overview.excluded).toEqual([]);
    expect(holdings.home!.total).toMatchObject({ amount: overview.amount, rateDates: ["2026-10-14"], excluded: [] });
    expect(allocation.home!.total).toMatchObject({ amount: overview.amount, excluded: [] });
    expect(holdings.fx).toEqual({ rate: 1.4, date: "2026-10-14" });
    for (const call of d.market.usdCad.mock.calls) expect(call[1]).toBe("2026-10-21");
  });
});
