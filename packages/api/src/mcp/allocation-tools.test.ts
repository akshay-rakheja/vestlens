import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings/settings-service.js";
import {
  allocationInput, allocationModelCopy, allocationText, allocationToolDefinitions, ALLOCATION_WIDGET, ALLOCATION_WIDGET_URI, AllocationScopeError, buildAllocationPayload,
} from "./allocation-tools.js";
import { buildAllocationResult } from "./allocation-tools.js";

/** The answer text for an input, with the scope words the server passes along. */
async function textFor(pf: any, input: any, options: { show?: boolean } = {}, d: any = deps()) {
  const r = await buildAllocationResult(d, pf, "sub", input);
  return allocationText(r.payload, r.scope, { ...options, fxConverted: r.fxConverted });
}

const cls = (bucket: string, group: string, included: boolean, label: string): any => ({ label, bucket, group, includedInPortfolioTotal: included, isClosed: group === "closed" });
const pos = (over: Record<string, unknown>): any => ({ instrumentId: "i", kind: "etf", symbol: "VFV", description: null, units: 10, price: 100, costBasis: 80, marketValue: 1000, unrealizedGain: null, currency: "CAD", cashEquivalent: false, ...over });
const portfolio = (positionsA: any[] = [pos({})], positionsB: any[] = []): any => ({
  generatedAt: "2026-10-16T15:00:00.000Z",
  accounts: [
    { id: "TFSA", name: "TFSA", classification: cls("tfsa", "registered", true, "TFSA"), value: null, balances: [{ currency: "CAD", cash: 100, buyingPower: null }], positions: positionsA },
    { id: "RRSP", name: "RRSP", classification: cls("rrsp", "registered", true, "RRSP"), value: null, balances: [], positions: positionsB },
    { id: "CARD", name: "Card", classification: cls("credit_card", "credit_products", false, "Credit card"), value: null, balances: [{ currency: "CAD", cash: 999, buyingPower: null }], positions: [] },
    { id: "OLD", name: "Old", classification: cls("tfsa", "closed", false, "Closed TFSA"), value: null, balances: [], positions: [pos({ symbol: "OLD" })] },
  ],
});
const fundProfile = (over: Record<string, unknown> = {}): any => ({ kind: "fund", sector: null, country: null, sectorWeights: { Technology: 0.5, Financials: 0.5 }, countryWeights: { "United States": 1 }, topHoldings: null, ...over });

function deps(over: Record<string, any> = {}): any {
  return {
    market: {
      usdCad: vi.fn(async (): Promise<any> => [{ date: "2026-10-14", close: 1.4 }, { date: "2026-10-15", close: 1.5 }]),
      profile: vi.fn(async (): Promise<any> => fundProfile()),
    },
    settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })) },
    now: () => new Date("2026-10-16T15:00:00Z"),
    ...over,
  };
}

describe("buildAllocationPayload", () => {
  it("defaults to asset class, includes cash, excludes credit and closed accounts, and never fetches profiles", async () => {
    const d = deps();
    const p = await buildAllocationPayload(d, portfolio([pos({ symbol: "VFV" }), pos({ symbol: "AAPL", kind: "stock", marketValue: 500 })]), "sub", {});
    expect(p.dimension).toBe("assetClass");
    expect(p.slices.map((s) => [s.label, s.valueCad])).toEqual([["ETFs & funds", 1000], ["Stocks", 500], ["Cash", 100]]);
    expect(p.accounts).toEqual([{ id: "TFSA", label: "TFSA" }, { id: "RRSP", label: "RRSP" }]);
    expect(p.filters).toEqual({});
    expect(p.asOf).toBe("2026-10-16T15:00:00.000Z");
    expect(p.settings).toEqual(DEFAULT_SETTINGS);
    expect(d.market.profile).not.toHaveBeenCalled();
    expect(p.concentration.largestWithLookThrough).toBeNull();
    expect(p.overlap).toEqual([]);
    expect(p.concentration.largest).toMatchObject({ symbol: "VFV" });
  });

  it("makes no profile calls for currency or account dimensions either", async () => {
    for (const dimension of ["currency", "accountType"] as const) {
      const d = deps();
      await buildAllocationPayload(d, portfolio(), "sub", { dimension });
      expect(d.market.profile).not.toHaveBeenCalled();
    }
  });

  it("sector fetches each public ticker once and classifies from the profile", async () => {
    const d = deps();
    const p = await buildAllocationPayload(d, portfolio([pos({ symbol: "VFV" })], [pos({ symbol: "VFV", marketValue: 500 })]), "sub", { dimension: "sector" });
    expect(d.market.profile.mock.calls.map((c: any[]) => c[0])).toEqual(["VFV"]);
    expect(p.slices.map((s) => [s.label, s.valueCad])).toEqual([["Financials", 750], ["Technology", 750]]);
    expect(p.estimated).toBe(true);
  });

  it("region groups fund country weights and puts a failed profile into Unclassified", async () => {
    const d = deps(); d.market.profile = vi.fn(async (t: string) => { if (t === "BAD") throw new Error("down"); return fundProfile(); });
    const p = await buildAllocationPayload(d, portfolio([pos({ symbol: "VFV" }), pos({ symbol: "BAD", marketValue: 1000 })]), "sub", { dimension: "region" });
    expect(p.unclassifiedFraction).toBeCloseTo(1000 / 2000);
    expect(p.slices[p.slices.length - 1].label).toBe("Unclassified (no data)");
  });

  it("profile fetching runs at most four at a time", async () => {
    let live = 0; let peak = 0;
    const d = deps(); d.market.profile = vi.fn(async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return fundProfile(); });
    const many = Array.from({ length: 12 }, (_, i) => pos({ symbol: `F${i}` }));
    await buildAllocationPayload(d, portfolio(many), "sub", { dimension: "sector" });
    expect(d.market.profile).toHaveBeenCalledTimes(12);
    expect(peak).toBe(4);
  });

  it("the whole profile phase is bounded by the deadline; unfinished tickers are Unclassified", async () => {
    const d = deps({ marketDeadlineMs: 30 });
    d.market.profile = vi.fn((t: string) => (t === "SLOW" ? new Promise(() => {}) : Promise.resolve(fundProfile())));
    const started = Date.now();
    const p = await buildAllocationPayload(d, portfolio([pos({ symbol: "VFV" }), pos({ symbol: "SLOW" })]), "sub", { dimension: "sector" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(p.unclassifiedFraction).toBeCloseTo(1000 / 2000);
  });

  it("does not start new profile fetches after the deadline", async () => {
    const d = deps({ marketDeadlineMs: 20 });
    d.market.profile = vi.fn(() => new Promise(() => {}));
    const many = Array.from({ length: 20 }, (_, i) => pos({ symbol: `F${i}` }));
    await buildAllocationPayload(d, portfolio(many), "sub", { dimension: "sector" });
    expect(d.market.profile.mock.calls.length).toBe(4);
  });

  it("fetches nested fund constituents in a second pass and computes look-through concentration", async () => {
    const d = deps();
    d.market.profile = vi.fn(async (t: string) => {
      if (t === "VEQT") return fundProfile({ topHoldings: [{ symbol: "VUN", weight: 1 }] });
      if (t === "VUN") return fundProfile({ topHoldings: [{ symbol: "AAPL", weight: 0.5 }] });
      if (t === "AAPL") return { kind: "stock", sector: "Technology", country: "United States", sectorWeights: null, countryWeights: null, topHoldings: null };
      return null;
    });
    const p = await buildAllocationPayload(d, portfolio([pos({ symbol: "VEQT", marketValue: 1000 })]), "sub", { dimension: "sector" });
    expect(d.market.profile.mock.calls.map((c: any[]) => c[0])).toEqual(expect.arrayContaining(["VEQT", "VUN"]));
    expect(p.concentration.largestWithLookThrough).toMatchObject({ symbol: "AAPL", estimated: true });
  });

  it("USD converts at the latest BoC rate and is flagged estimated; the rate is reported", async () => {
    const p = await buildAllocationPayload(deps(), portfolio([pos({ symbol: "AAA", kind: "stock", marketValue: 600 }), pos({ symbol: "UUU", kind: "stock", currency: "USD", marketValue: 200 })]), "sub", { dimension: "currency" });
    expect(p.fx).toEqual({ rate: 1.5, date: "2026-10-15" });
    expect(p.slices.find((s) => s.key === "USD")).toMatchObject({ valueCad: 300, estimated: true });
    expect(p.usdExcluded).toBe(false);
    expect(p.estimated).toBe(true);
  });

  it("concentration is estimated only when a USD holding was converted", async () => {
    const cad = await buildAllocationPayload(deps(), portfolio([pos({ symbol: "AAA", kind: "stock", marketValue: 600 })]), "sub", {});
    expect(cad.concentration.estimated).toBe(false);
    const usd = await buildAllocationPayload(deps(), portfolio([pos({ symbol: "AAA", kind: "stock", marketValue: 600 }), pos({ symbol: "UUU", kind: "stock", currency: "USD", marketValue: 200 })]), "sub", {});
    expect(usd.concentration.estimated).toBe(true);
    expect(allocationModelCopy(usd).concentration.estimated).toBe(true);
  });

  it("the FX fetch and the profile phase run concurrently", async () => {
    const d = deps({ marketDeadlineMs: 2000 });
    d.market.usdCad = vi.fn(() => new Promise<any>((r) => setTimeout(() => r([{ date: "2026-10-15", close: 1.5 }]), 150)));
    d.market.profile = vi.fn(() => new Promise<any>((r) => setTimeout(() => r(fundProfile()), 150)));
    const started = Date.now();
    await buildAllocationPayload(d, portfolio([pos({ symbol: "VFV" }), pos({ symbol: "UUU", kind: "stock", currency: "USD", marketValue: 200 })]), "sub", { dimension: "sector" });
    expect(Date.now() - started).toBeLessThan(290);
  });

  it("missing FX excludes USD holdings, reports a null rate and says so", async () => {
    const d = deps(); d.market.usdCad = vi.fn(async () => null);
    const p = await buildAllocationPayload(d, portfolio([pos({ symbol: "AAA", kind: "stock", marketValue: 600 }), pos({ symbol: "UUU", kind: "stock", currency: "USD", marketValue: 200 })]), "sub", { dimension: "currency" });
    expect(p.fx).toEqual({ rate: null, date: null });
    expect(p.usdExcluded).toBe(true);
    expect(p.slices.map((s) => s.key)).toEqual(["CAD", "cash-CAD"]);
  });

  it("an all-CAD portfolio needs no FX call and does not flag exclusion", async () => {
    const d = deps();
    const p = await buildAllocationPayload(d, portfolio(), "sub", {});
    expect(d.market.usdCad).not.toHaveBeenCalled();
    expect(p.usdExcluded).toBe(false);
    expect(p.fx).toEqual({ rate: null, date: null });
  });

  it("excludes positions with an unknown value", async () => {
    const p = await buildAllocationPayload(deps(), portfolio([pos({ symbol: "AAA", marketValue: 500 }), pos({ symbol: "ZZZ", marketValue: null, price: null })]), "sub", {});
    expect(p.slices.flatMap((s) => s.holdings.map((h) => h.symbol))).not.toContain("ZZZ");
  });

  it("groups by account label and scopes by account; unknown, credit or closed accounts are rejected", async () => {
    const pf = portfolio([pos({ symbol: "AAA", marketValue: 400 })], [pos({ symbol: "BBB", marketValue: 600 })]);
    const p = await buildAllocationPayload(deps(), pf, "sub", { dimension: "accountType" });
    expect(p.slices.map((s) => [s.label, s.valueCad])).toEqual([["RRSP", 600], ["TFSA", 500]]);
    const one = await buildAllocationPayload(deps(), pf, "sub", { accountId: "RRSP" });
    expect(one.slices.flatMap((s) => s.holdings.map((h) => h.symbol))).toEqual(["BBB"]);
    expect(one.filters).toEqual({ accountId: "RRSP" });
    for (const accountId of ["nope", "CARD", "OLD"]) await expect(buildAllocationPayload(deps(), pf, "sub", { accountId })).rejects.toBeInstanceOf(AllocationScopeError);
  });

  it("reports non-CAD/USD positions and cash as excluded and does not fetch FX for them alone", async () => {
    const d = deps();
    const pf = portfolio([pos({ symbol: "EEE", kind: "stock", currency: "EUR", marketValue: 700 }), pos({ symbol: "AAA", kind: "stock", marketValue: 300 })]);
    pf.accounts[0].balances.push({ currency: "GBP", cash: 50, buyingPower: null });
    const p = await buildAllocationPayload(d, pf, "sub", { dimension: "currency" });
    expect(p.excludedCurrencies).toEqual(["EUR", "GBP"]);
    expect(d.market.usdCad).not.toHaveBeenCalled();
    expect(p.slices.flatMap((s) => s.holdings.map((h) => h.symbol))).not.toContain("EEE");
    expect(p.usdExcluded).toBe(false);
    expect(allocationModelCopy(p).excludedCurrencies).toEqual(["EUR", "GBP"]);
  });

  it("counts positions without a reported value", async () => {
    const p = await buildAllocationPayload(deps(), portfolio([pos({ symbol: "AAA", marketValue: 500 }), pos({ symbol: "ZZZ", marketValue: null, price: null }), pos({ symbol: "YYY", marketValue: null, price: null })]), "sub", {});
    expect(p.unvalued).toBe(2);
    expect(allocationModelCopy(p).unvalued).toBe(2);
  });

  it("slice values and fractions are unaffected by the per-slice holdings cap", async () => {
    const d = deps(); d.market.profile = vi.fn(async (t: string) => (t.startsWith("U") ? null : fundProfile()));
    const many = Array.from({ length: 300 }, (_, i) => pos({ symbol: `${i % 10 === 0 ? "U" : "S"}${String(i).padStart(3, "0")}`, marketValue: 1000 + i }));
    const p = await buildAllocationPayload(d, portfolio(many.slice(0, 150), many.slice(150)), "sub", { dimension: "sector" });
    expect(p.slices.some((s) => s.moreHoldings > 0)).toBe(true);
    expect(p.slices.reduce((a, s) => a + s.fraction, 0)).toBeCloseTo(1, 4);
    const un = p.slices.find((s) => s.key === "unclassified")!;
    expect(p.unclassifiedFraction).toBeCloseTo(un.fraction, 6);
    const invested = many.reduce((a, m) => a + m.marketValue, 0);
    expect(un.valueCad).toBeCloseTo(many.filter((m) => m.symbol.startsWith("U")).reduce((a, m) => a + m.marketValue, 0), 1);
    expect(p.slices.reduce((a, s) => a + s.valueCad, 0)).toBeCloseTo(invested, 0);
  });

  it("keeps the payload under 60 KB for 300 USD positions in an unreported account with no rate", async () => {
    const d = deps(); d.market.usdCad = vi.fn(async () => null);
    const many = Array.from({ length: 300 }, (_, i) => pos({ symbol: `S${String(i).padStart(3, "0")}`, currency: "USD", marketValue: 1000 + i }));
    const p = await buildAllocationPayload(d, portfolio(many.slice(0, 150), many.slice(150)), "sub", {});
    expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(60_000);
    expect(p.home.total.excludedCount).toBeGreaterThan(0);
  });

  it("keeps the payload under 60 KB for many holdings and sectors", async () => {
    const d = deps(); d.market.profile = vi.fn(async () => fundProfile({ sectorWeights: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`Sector${i}`, 1 / 11])) }));
    const many = Array.from({ length: 300 }, (_, i) => pos({ symbol: `S${String(i).padStart(3, "0")}`, marketValue: 1000 + i }));
    const p = await buildAllocationPayload(d, portfolio(many.slice(0, 150), many.slice(150)), "sub", { dimension: "sector" });
    expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(60_000);
    expect(p.slices.some((s) => s.moreHoldings > 0)).toBe(true);
    expect(p.slices[0].valueCad).toBeGreaterThan(0);
  });
});

describe("basis captions and a margin debit (B1, A13)", () => {
  const margin = () => {
    const p = portfolio([pos({ symbol: "AAA", kind: "stock", units: 1_000, price: 100, marketValue: 100_000 })]);
    p.accounts[0].balances = [{ currency: "CAD", cash: -40_000, buyingPower: null }];
    return p;
  };
  it("a margin debit: asset-class shares are of net value and the debit is stated", async () => {
    const p = await buildAllocationPayload(deps(), margin(), "sub", { dimension: "assetClass" });
    expect(p.slices.find((s) => s.label === "Stocks")!.fraction).toBeCloseTo(100_000 / 60_000, 5);
    expect(p.home.marginDebit).toEqual({ amountCad: 40_000, estimated: false, netBasis: true });
    expect(allocationText(p, "across all accounts")).toContain("Stocks at 166.7%");
    expect(allocationText(p, "across all accounts")).toContain("Shares are of net value after a margin debit of 40,000.00 CAD (the brokerage total), so they can add up to over 100%.");
  });
  it("no debit: of total value, cash included; sector: of holdings, cash excluded; no marginDebit field", async () => {
    const plain = await buildAllocationPayload(deps(), portfolio(), "sub", { dimension: "assetClass" });
    expect(plain.home.marginDebit).toBeUndefined();
    expect(allocationText(plain, "across all accounts")).toContain("Shares are of total value, cash included.");
    const sector = await buildAllocationPayload(deps(), portfolio(), "sub", { dimension: "sector" });
    expect(allocationText(sector, "across all accounts")).toContain("Shares are of holdings, cash excluded.");
  });
  it("a trivial negative cash balance (under 1% of the positions) is not called a margin debit (review 5)", async () => {
    const m = margin();
    m.accounts[0].balances = [{ currency: "CAD", cash: -50, buyingPower: null }];
    const p = await buildAllocationPayload(deps(), m, "sub", { dimension: "assetClass" });
    expect(p.home.marginDebit).toBeUndefined();
    expect(allocationText(p, "across all accounts")).toContain("Shares are of total value, cash included.");
    expect(allocationText(p, "across all accounts")).not.toContain("margin");
  });
  it("a debit larger than the assets: gross shares, and the text says the debit isn't in them", async () => {
    const m = margin();
    m.accounts[0].balances = [{ currency: "CAD", cash: -200_000, buyingPower: null }];
    const p = await buildAllocationPayload(deps(), m, "sub", { dimension: "assetClass" });
    expect(p.slices[0]!.fraction).toBe(1);
    expect(allocationText(p, "across all accounts")).toContain("a margin debit of 200,000.00 CAD is not in them");
  });
});

describe("text and model copy", () => {
  it("the text carries shares and counts, no amounts or symbols", async () => {
    const text = await textFor(portfolio(), { accountId: "TFSA" }, { show: true });
    expect(text).toBe("Largest asset class in TFSA: ETFs & funds at 90.9%, among 2 groups. Shares are of total value, cash included. Showing the allocation widget.");
    expect(text).not.toMatch(/VFV|1000/);
    expect(await textFor(portfolio(), { accountId: "TFSA" })).not.toContain("Showing");
    expect(await textFor({ ...portfolio([]), accounts: [] }, {})).toBe("Nothing to allocate across all accounts.");
  });

  it("the model copy is compact and carries no ids or amounts", async () => {
    const many = Array.from({ length: 5 }, (_, i) => pos({ symbol: `S${i}`, kind: "stock", marketValue: 100 + i }));
    const p = await buildAllocationPayload(deps(), portfolio(many), "sub", { accountId: "TFSA", dimension: "currency" });
    const copy = allocationModelCopy(p);
    expect(copy.dimension).toBe("currency");
    expect(copy.slices.length).toBeLessThanOrEqual(20);
    expect(copy.filters).toEqual({ accountLabel: "TFSA" });
    const json = JSON.stringify(copy);
    expect(json).not.toMatch(/accountId|"accounts"|"id"|holdingKey|valueCad/);
    expect(Buffer.byteLength(json)).toBeLessThan(6_000);
  });
});

describe("accountType filter and answer-first text", () => {
  const account = (id: string, name: string, c: any, positions: any[], cash = 0): any => ({
    id, name, classification: c, value: null, balances: cash > 0 ? [{ currency: "CAD", cash, buyingPower: null }] : [], positions,
  });
  const tfsa = () => cls("tfsa", "registered", true, "TFSA");
  const typed = (tfsas: 1 | 2 = 2): any => ({
    generatedAt: "2026-10-16T15:00:00.000Z",
    accounts: [
      account("T1", "Synthetic TFSA one", tfsa(), [pos({ symbol: "VFV", marketValue: 600 })]),
      ...(tfsas === 2 ? [account("T2", "Synthetic TFSA two", tfsa(), [pos({ symbol: "AAA", kind: "stock", marketValue: 300 })], 100)] : []),
      account("R1", "Synthetic RRSP", cls("rrsp", "registered", true, "RRSP"), [pos({ symbol: "ZAG", marketValue: 800 })]),
      account("M1", "Synthetic margin", cls("margin", "non_registered", true, "Non-registered"), [pos({ symbol: "BBB", kind: "stock", marketValue: 5000 })]),
      account("OLD", "Synthetic closed TFSA", cls("tfsa", "closed", false, "Closed TFSA"), [pos({ symbol: "OLD", marketValue: 9000 })]),
    ],
  });
  const symbolsOf = (p: any) => p.slices.flatMap((s: any) => s.holdings.map((h: any) => h.symbol)).sort();
  const firstSentence = (text: string) => text.split(/(?<=\.) (?=[A-Z])/)[0];

  it("accountType rrsp slices only the RRSP, echoes the type and, with one match, its account id", async () => {
    const p = await buildAllocationPayload(deps(), typed(), "sub", { accountType: "rrsp" });
    expect(symbolsOf(p)).toEqual(["ZAG"]);
    expect(p.filters).toEqual({ accountId: "R1", accountType: "rrsp" });
    expect(p.home.total.amount).toBe(800);
  });

  it("several matches: both TFSAs (cash included), no accountId echoed; margin and closed accounts stay out", async () => {
    const p = await buildAllocationPayload(deps(), typed(), "sub", { accountType: "tfsa" });
    expect(symbolsOf(p)).toEqual(["AAA", "Cash (CAD)", "VFV"]);
    expect(p.slices.map((s) => [s.label, s.valueCad])).toEqual([["ETFs & funds", 600], ["Stocks", 300], ["Cash", 100]]);
    expect(p.filters).toEqual({ accountType: "tfsa" });
    expect(p.home.total.amount).toBe(1000);
  });

  it("accountId still works unchanged and echoes only accountId", async () => {
    const p = await buildAllocationPayload(deps(), typed(), "sub", { accountId: "T1" });
    expect(symbolsOf(p)).toEqual(["VFV"]);
    expect(p.filters).toEqual({ accountId: "T1" });
  });

  it("the text starts with the largest group, its share and the group count, in the type's scope", async () => {
    expect(await textFor(typed(), { accountType: "tfsa" }, { show: true })).toBe("Largest asset class in your TFSAs: ETFs & funds at 60.0%, among 3 groups. Shares are of total value, cash included. Showing the allocation widget.");
    expect(await textFor(typed(), { accountType: "rrsp", dimension: "accountType" })).toBe("Largest account in your RRSP: RRSP at 100.0%, among 1 group. Shares are of total value, cash included.");
    expect(await textFor(typed(), { accountId: "T1", dimension: "currency" })).toBe("Largest currency in Synthetic TFSA one: CAD at 100.0%, among 1 group. Shares are of total value, cash included.");
    const all = await textFor(typed(), {});
    expect(firstSentence(all)).toBe("Largest asset class across all accounts: Stocks at 77.9%, among 3 groups.");
    expect(firstSentence(all).length).toBeLessThan(300);
  });

  it("account ids never appear in the text", async () => {
    for (const input of [{ accountId: "T1" }, { accountType: "tfsa" as const }, { accountType: "rrsp" as const }, {}]) {
      expect(await textFor(typed(), input, { show: true })).not.toMatch(/\b(T1|T2|R1|M1)\b/);
    }
  });

  it("an empty scope still says nothing to allocate, with its scope words", async () => {
    const pf = { ...typed(), accounts: [account("R1", "Synthetic RRSP", cls("rrsp", "registered", true, "RRSP"), [])] };
    expect(await textFor(pf, { accountType: "rrsp" })).toBe("Nothing to allocate in your RRSP.");
  });

  it("USD converted into the shares is marked est. with the Bank of Canada date", async () => {
    const pf = typed(1);
    pf.accounts[0].positions = [pos({ symbol: "VFV", marketValue: 300 }), pos({ symbol: "UUU", kind: "stock", currency: "USD", marketValue: 200 })];
    const r = await buildAllocationResult(deps(), pf, "sub", { accountType: "tfsa", dimension: "currency" });
    expect(r.payload.fx).toEqual({ rate: 1.5, date: "2026-10-15" });
    expect(firstSentence(allocationText(r.payload, r.scope, { fxConverted: r.fxConverted }))).toBe("Largest currency in your TFSA: CAD at 50.0% (est., BoC Oct 15), among 2 groups.");
  });

  it("says when the shares leave out holdings with no reported value, or USD without a rate", async () => {
    const pf = typed(1);
    pf.accounts[0].positions = [pos({ symbol: "VFV", marketValue: 600 }), pos({ symbol: "ZZZ", marketValue: null, price: null }), pos({ symbol: "YYY", marketValue: null, price: null })];
    expect(await textFor(pf, { accountType: "tfsa" })).toBe("Largest asset class in your TFSA: ETFs & funds at 100.0% of known values, among 1 group. Shares are of total value, cash included. Shares count known values only; 2 holdings have no reported value.");
    pf.accounts[0].positions = [pos({ symbol: "VFV", marketValue: 600 }), pos({ symbol: "ZZZ", marketValue: null, price: null })];
    expect(await textFor(pf, { accountType: "tfsa" })).toMatch(/1 holding has no reported value\.$/);

    const usd = typed(1);
    usd.accounts[0].positions = [pos({ symbol: "VFV", marketValue: 600 }), pos({ symbol: "UUU", kind: "stock", currency: "USD", marketValue: 200 })];
    const noFx = deps({ market: { usdCad: vi.fn(async () => null), profile: vi.fn() } });
    expect(await textFor(usd, { accountType: "tfsa" }, {}, noFx)).toMatch(/Shares count known values only; USD amounts are left out \(no exchange rate\)\.$/);
  });

  it("keeps the BoC date when the account reports its own CAD total; look-through estimates alone say plain est.", async () => {
    const pf = typed(1);
    pf.accounts[0].value = { amount: 600, currency: "CAD" };
    pf.accounts[0].positions = [pos({ symbol: "VFV", marketValue: 300 }), pos({ symbol: "UUU", kind: "stock", currency: "USD", marketValue: 200 })];
    const r = await buildAllocationResult(deps(), pf, "sub", { accountType: "tfsa", dimension: "currency" });
    expect(r.fxConverted).toBe(true);
    expect(firstSentence(await textFor(pf, { accountType: "tfsa", dimension: "currency" }))).toBe("Largest currency in your TFSA: CAD at 50.0% (est., BoC Oct 15), among 2 groups.");

    const cad = typed(1);
    const sector = await buildAllocationResult(deps(), cad, "sub", { accountType: "tfsa", dimension: "sector" });
    expect(sector.payload.estimated).toBe(true);
    expect(sector.fxConverted).toBe(false);
    expect(allocationText(sector.payload, sector.scope, { fxConverted: sector.fxConverted })).toMatch(/%\ \(est\.\), among 2 groups\. Shares are of holdings, cash excluded\.$/);
  });

  it("when anything is left out the first sentence says the share is of known values", async () => {
    const usd = typed(1);
    usd.accounts[0].positions = [pos({ symbol: "VFV", marketValue: 600 }), pos({ symbol: "UUU", kind: "stock", currency: "USD", marketValue: 200 })];
    usd.accounts[0].balances = [{ currency: "GBP", cash: 50, buyingPower: null }];
    const noFx = deps({ market: { usdCad: vi.fn(async () => null), profile: vi.fn() } });
    const text = await textFor(usd, { accountType: "tfsa" }, {}, noFx);
    expect(firstSentence(text)).toBe("Largest asset class in your TFSA: ETFs & funds at 100.0% of known values, among 1 group.");
    expect(text).toMatch(/Shares count known values only; USD amounts are left out \(no exchange rate\); GBP amounts are left out \(no exchange rate\)\.$/);
    expect(await textFor(typed(1), { accountType: "tfsa" })).not.toContain("known values");
  });

  it("the model copy carries the type, never ids", async () => {
    const p = await buildAllocationPayload(deps(), typed(), "sub", { accountType: "rrsp" });
    expect(allocationModelCopy(p).filters).toEqual({ accountLabel: "RRSP", accountType: "rrsp" });
    const several = await buildAllocationPayload(deps(), typed(), "sub", { accountType: "tfsa" });
    expect(allocationModelCopy(several).filters).toEqual({ accountType: "tfsa" });
    expect(JSON.stringify(allocationModelCopy(several))).not.toMatch(/\b(T1|T2)\b/);
  });

  it("errors carry the resolver's verbatim copy", async () => {
    await expect(buildAllocationPayload(deps(), typed(), "sub", { accountId: "T1", accountType: "tfsa" }))
      .rejects.toMatchObject({ name: "AllocationScopeError", code: "both_filters", text: "Give accountId or accountType, not both." });
    await expect(buildAllocationPayload(deps(), typed(), "sub", { accountType: "fhsa" }))
      .rejects.toMatchObject({ code: "no_accounts_of_type", text: "No connected FHSA accounts. Use list_portfolio_accounts to see what is connected." });
    await expect(buildAllocationPayload(deps(), typed(), "sub", { accountId: "OLD" }))
      .rejects.toMatchObject({ code: "unknown_account", text: "Unknown or excluded account. Use list_portfolio_accounts to pick an account." });
  });
});

describe("input and definitions", () => {
  it("validates input strictly", () => {
    expect(allocationInput.parse({ dimension: "sector", accountType: "tfsa" })).toEqual({ dimension: "sector", accountType: "tfsa" });
    expect(() => allocationInput.parse({ accountType: "cash" })).toThrow();
    expect(allocationInput.parse({ dimension: "sector" })).toEqual({ dimension: "sector" });
    expect(allocationInput.parse({})).toEqual({});
    expect(() => allocationInput.parse({ dimension: "colour" })).toThrow();
    expect(() => allocationInput.parse({ extra: 1 })).toThrow();
  });

  it("show_allocation is model-visible with widget metadata; get_allocation is app-only; schemas use real keys", async () => {
    const [show, get] = allocationToolDefinitions;
    expect(ALLOCATION_WIDGET).toBe("allocation");
    expect(ALLOCATION_WIDGET_URI).toBe("ui://portfolio/allocation-v1");
    expect(show.description).toBe("Use this when the user asks about their allocation, diversification, exposure by sector/region/currency/account, or concentration: renders the interactive allocation view. Filter with accountType or accountId. Read-only.");
    expect(Object.keys(show.inputSchema.properties)).toEqual(["dimension", "accountId", "accountType"]);
    expect(Object.keys(get.inputSchema.properties)).toEqual(["dimension", "accountId", "accountType"]);
    expect(show._meta).toEqual({
      ui: { resourceUri: ALLOCATION_WIDGET_URI }, "openai/outputTemplate": ALLOCATION_WIDGET_URI, "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Loading allocation…", "openai/toolInvocation/invoked": "Allocation ready.",
      securitySchemes: [{ type: "oauth2", scopes: ["portfolio:read"] }],
    });
    expect((get._meta as any).ui).toEqual({ visibility: ["app"] });
    for (const t of allocationToolDefinitions) {
      expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(t.securitySchemes).toEqual([{ type: "oauth2", scopes: ["portfolio:read"] }]);
      expect(t.outputSchema.additionalProperties).toBe(false);
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
    const required = ["dimension", "slices", "unclassifiedFraction", "estimated", "fx", "usdExcluded", "excludedCurrencies", "unvalued", "concentration", "overlap", "accounts", "filters", "home", "settings", "asOf"];
    expect(show.outputSchema.required).toEqual(required);
    expect(Object.keys(show.outputSchema.properties).sort()).toEqual([...required].sort());
    const p = await buildAllocationPayload(deps(), portfolio(), "sub", {});
    expect(Object.keys(p).sort()).toEqual([...required].sort());
  });
});

describe("buildAllocationResult: refreshed and noRefresh (rate limits)", () => {
  it("refreshed is false for dimensions that need no profiles", async () => {
    const r = await buildAllocationResult(deps(), portfolio(), "sub", {});
    expect(r.refreshed).toBe(false);
  });

  it("refreshed is true when profiles were fetched", async () => {
    const d = deps();
    const r = await buildAllocationResult(d, portfolio(), "sub", { dimension: "sector" });
    expect(d.market.profile).toHaveBeenCalled();
    expect(r.refreshed).toBe(true);
  });

  it("uses cachedProfile first when the service offers it; a full cache hit is not a refresh", async () => {
    const d = deps(); d.market.cachedProfile = vi.fn(async () => fundProfile());
    const r = await buildAllocationResult(d, portfolio([pos({ symbol: "VFV" })], [pos({ symbol: "VFV", marketValue: 500 })]), "sub", { dimension: "sector" });
    expect(d.market.profile).not.toHaveBeenCalled();
    expect(r.refreshed).toBe(false);
    expect(r.payload.slices.map((s) => [s.label, s.valueCad])).toEqual([["Financials", 750], ["Technology", 750]]);
  });

  it("cache misses are fetched and count as a refresh", async () => {
    const d = deps(); d.market.cachedProfile = vi.fn(async () => null);
    const r = await buildAllocationResult(d, portfolio(), "sub", { dimension: "sector" });
    expect(d.market.profile.mock.calls.map((c: any[]) => c[0])).toEqual(["VFV"]);
    expect(r.refreshed).toBe(true);
  });

  it("noRefresh skips profile fetches: holdings are Unclassified (or cached only)", async () => {
    const d = deps();
    const r = await buildAllocationResult(d, portfolio(), "sub", { dimension: "sector" }, { noRefresh: true });
    expect(d.market.profile).not.toHaveBeenCalled();
    expect(r.refreshed).toBe(false);
    expect(r.payload.unclassifiedFraction).toBe(1);
    const c = deps(); c.market.cachedProfile = vi.fn(async () => fundProfile());
    const cached = await buildAllocationResult(c, portfolio(), "sub", { dimension: "sector" }, { noRefresh: true });
    expect(c.market.profile).not.toHaveBeenCalled();
    expect(cached.payload.unclassifiedFraction).toBe(0);
  });
});

describe("buildAllocationResult with known profile failures", () => {
  it("a ticker known to have no profile is not fetched again and not a refresh", async () => {
    const d = deps();
    d.market.cachedProfileLookup = vi.fn(async () => ({ known: true, profile: null }));
    const r = await buildAllocationResult(d, portfolio(), "sub", { dimension: "sector" });
    expect(d.market.profile).not.toHaveBeenCalled();
    expect(r.refreshed).toBe(false);
    expect(r.payload.unclassifiedFraction).toBe(1);
  });
});
