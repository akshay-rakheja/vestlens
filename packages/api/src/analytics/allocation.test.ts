import { describe, expect, it } from "vitest";
import { allocate, concentration, nestedFundSymbols, overlap, type AllocationItem } from "./allocation.js";
import { regionOf } from "./regions.js";
import type { SecurityProfile } from "../market-data/types.js";

const profile = (p: Partial<SecurityProfile>): SecurityProfile => ({ kind: "unknown", sector: null, country: null, sectorWeights: null, countryWeights: null, topHoldings: null, ...p });
const item = (symbol: string, kind: string, valueCad: number, over: Partial<AllocationItem> = {}): AllocationItem =>
  ({ holdingKey: `${symbol}:CAD`, symbol, kind, valueCad, currency: "CAD", accountLabel: "TFSA", profile: null, ...over });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const stock = item("AAPL", "stock", 400, { currency: "USD", holdingKey: "AAPL:USD", accountLabel: "Margin", profile: profile({ kind: "stock", sector: "Technology", country: "United States" }) });
const etf = item("VFV", "etf", 500, { profile: profile({ kind: "fund", sectorWeights: { Technology: 0.3, Energy: 0.1 }, topHoldings: [{ symbol: "AAPL", weight: 0.06 }, { symbol: "MSFT", weight: 0.05 }] }) });
const bare = item("MYST", "stock", 100);
const cash = [{ currency: "CAD", accountLabel: "TFSA", valueCad: 100 }];

describe("regionOf", () => {
  it.each([
    ["Canada", "Canada"], ["United States", "United States"], ["USA", "United States"], ["United Kingdom", "Developed ex-North America"],
    ["Japan", "Developed ex-North America"], ["China", "Emerging markets"], ["India", "Emerging markets"], ["Atlantis", "Other"], ["  canada ", "Canada"],
  ])("%s -> %s", (c, r) => expect(regionOf(c)).toBe(r));
});

describe("allocate", () => {
  const items = [stock, etf, bare];
  it("assetClass includes cash, fractions sum to 1, and USD marks it estimated", () => {
    const r = allocate(items, cash, "assetClass");
    expect(r.slices.map((s) => [s.label, s.valueCad])).toEqual([["ETFs & funds", 500], ["Stocks", 500], ["Cash", 100]].sort((a, b) => (b[1] as number) - (a[1] as number)));
    expect(sum(r.slices.map((s) => s.fraction))).toBeCloseTo(1, 10);
    expect(r.estimated).toBe(true);
    expect(r.slices.find((s) => s.label === "ETFs & funds")!.estimated).toBe(false);
    expect(r.slices.find((s) => s.label === "Stocks")!.estimated).toBe(true);
  });
  it("is not estimated when all values are CAD", () => {
    expect(allocate([etf], cash, "currency").estimated).toBe(false);
  });
  it("currency keeps native currencies apart and labels cash", () => {
    const r = allocate(items, cash, "currency");
    expect(r.slices.map((s) => s.label).sort()).toEqual(["CAD", "Cash (CAD)", "USD"]);
    expect(r.slices.find((s) => s.label === "CAD")!.valueCad).toBe(600);
  });
  it("accountType uses the account label incl. cash", () => {
    const r = allocate(items, cash, "accountType");
    expect(r.slices.find((s) => s.label === "TFSA")!.valueCad).toBe(700);
    expect(r.slices.find((s) => s.label === "Margin")!.valueCad).toBe(400);
  });
  it("sector: stock by sector, fund by weights (estimated), no profile and weight remainder unclassified, cash excluded", () => {
    const r = allocate(items, cash, "sector");
    const by = Object.fromEntries(r.slices.map((s) => [s.label, s]));
    expect(by.Technology.valueCad).toBeCloseTo(400 + 150, 8);
    expect(by.Technology.estimated).toBe(true);
    expect(by.Energy.valueCad).toBeCloseTo(50, 8);
    expect(by["Unclassified (no data)"].key).toBe("unclassified");
    expect(by["Unclassified (no data)"].valueCad).toBeCloseTo(100 + 300, 8);
    expect(r.unclassifiedFraction).toBeCloseTo(400 / 1000, 8);
    expect(sum(r.slices.map((s) => s.fraction))).toBeCloseTo(1, 10);
    expect(r.slices.at(-1)!.key).toBe("unclassified");
    expect(JSON.stringify(r)).not.toContain("Cash");
  });
  it("Review Focus 3: fund with sectors but no countries is classified for sector, unclassified for region", () => {
    const sector = allocate([etf], cash, "sector");
    expect(sector.unclassifiedFraction).toBeCloseTo(0.6, 8);
    const region = allocate([etf, stock], cash, "region");
    expect(region.slices.map((s) => s.label).sort()).toEqual(["Unclassified (no data)", "United States"]);
    expect(region.unclassifiedFraction).toBeCloseTo(500 / 900, 8);
    expect(sum(region.slices.map((s) => s.fraction))).toBeCloseTo(1, 10);
  });
  it("region uses fund country weights when present", () => {
    const f = item("GLB", "etf", 1000, { profile: profile({ kind: "fund", countryWeights: { "United States": 0.6, Japan: 0.2 } }) });
    const r = allocate([f], [], "region");
    const by = Object.fromEntries(r.slices.map((s) => [s.label, s.valueCad]));
    expect(by["United States"]).toBeCloseTo(600, 8);
    expect(by["Developed ex-North America"]).toBeCloseTo(200, 8);
    expect(r.unclassifiedFraction).toBeCloseTo(0.2, 8);
  });
  it("no profile is unclassified and the share is reported", () => {
    const r = allocate([bare, stock], [], "region");
    expect(r.unclassifiedFraction).toBeCloseTo(100 / 500, 8);
  });
  it("excludes positions with unknown value and handles empty input", () => {
    const unknown = item("BOND", "other", Number.NaN);
    const r = allocate([stock, unknown], [], "assetClass");
    expect(r.slices).toHaveLength(1);
    expect(allocate([], [], "sector")).toEqual({ slices: [], unclassifiedFraction: 0, estimated: false });
  });
  it("slice holdings list contributions", () => {
    const r = allocate(items, cash, "sector");
    const tech = r.slices.find((s) => s.label === "Technology")!;
    expect(tech.holdings.map((h) => h.symbol).sort()).toEqual(["AAPL", "VFV"]);
  });
});

describe("concentration", () => {
  it("worked example: weights 0.5/0.3/0.2 -> effectiveN 2.632", () => {
    const r = concentration([item("A", "stock", 50), item("B", "stock", 30), item("C", "stock", 20), item("CASH", "cash", 999)]);
    expect(r.effectiveN).toBeCloseTo(2.632, 3);
    expect(r.top10).toBeCloseTo(1, 10);
    expect(r.largest).toEqual({ symbol: "A", fraction: 0.5 });
  });
  it("is estimated only when a non-CAD holding was converted", () => {
    expect(concentration([item("A", "stock", 50)]).estimated).toBe(false);
    expect(concentration([item("A", "stock", 50), item("B", "stock", 30, { currency: "USD", holdingKey: "B:USD" })]).estimated).toBe(true);
  });
  it("top10 caps at ten holdings, unknown values excluded, same symbol in two currencies stays two rows", () => {
    const many = Array.from({ length: 12 }, (_, i) => item(`S${i}`, "stock", 10));
    expect(concentration(many).top10).toBeCloseTo(10 / 12, 10);
    const r = concentration([item("X", "stock", 10), item("X", "stock", 10, { currency: "USD", holdingKey: "X:USD" }), item("N", "stock", Number.NaN)]);
    expect(r.largest!.fraction).toBe(0.5);
    expect(concentration([])).toEqual({ top10: 0, effectiveN: 0, largest: null, largestWithLookThrough: null, estimated: false });
  });
  it("look-through largest is a company: ETF residual and unexpanded funds never win; denominator is the full total", () => {
    const r = concentration([stock, etf, bare]);
    expect(r.largest).toEqual({ symbol: "VFV", fraction: 0.5 });
    expect(r.largestWithLookThrough).toEqual({ symbol: "AAPL", fraction: 430 / 1000, estimated: true });
    const e2 = item("E2", "etf", 500, { profile: profile({ kind: "fund", topHoldings: [{ symbol: "AAPL", weight: 0.5 }] }) });
    expect(concentration([stock, e2]).largestWithLookThrough!.fraction).toBeCloseTo(650 / 900, 10);
    const bareEtf = item("XEQT", "etf", 900);
    expect(concentration([bareEtf, item("RY", "stock", 50)]).largestWithLookThrough).toEqual({ symbol: "RY", fraction: 50 / 950, estimated: true });
    expect(concentration([bareEtf]).largestWithLookThrough).toBeNull();
  });
  it("VFV -> VOO -> constituents: nested fund top holdings are substituted one level", () => {
    const vfv = item("VFV", "etf", 1000, { profile: profile({ kind: "fund", topHoldings: [{ symbol: "VOO", weight: 1 }] }) });
    const direct = item("NVDA", "stock", 100);
    const voo = profile({ kind: "fund", topHoldings: [{ symbol: "NVDA", weight: 0.08 }, { symbol: "AAPL", weight: 0.07 }] });
    expect(nestedFundSymbols([vfv, direct])).toEqual(["VOO"]);
    const profiles = new Map<string, SecurityProfile | null>([["VOO", voo]]);
    const r = concentration([vfv, direct], profiles);
    expect(r.largestWithLookThrough!.symbol).toBe("NVDA"); // 80 + 100 direct
    expect(r.largestWithLookThrough!.fraction).toBeCloseTo(180 / 1100, 10);
    const ov = overlap([vfv, direct], profiles);
    const nvda = ov.find((o) => o.symbol === "NVDA")!;
    expect(nvda.direct).toBeCloseTo(100 / 1100, 10);
    expect(nvda.indirect).toBeCloseTo(80 / 1100, 10);
    expect(nvda.combined).toBeCloseTo(180 / 1100, 10);
    expect(ov.some((o) => o.symbol === "VOO")).toBe(false);
    // Without the nested profile the holding is VOO itself.
    expect(overlap([vfv, direct], new Map([["VOO", null]])).some((o) => o.symbol === "NVDA")).toBe(false);
  });
});

describe("round 1 fixes", () => {
  const voo = profile({ kind: "fund", topHoldings: [{ symbol: "NVDA", weight: 0.1 }] });
  it("overlap never lists fund symbols and expands a directly held fund's profile", () => {
    const vfv = item("VFV", "etf", 1000, { profile: profile({ kind: "fund", topHoldings: [{ symbol: "VOO", weight: 1 }] }) });
    const zsp = item("ZSP", "etf", 500, { holdingKey: "ZSP:CAD", profile: profile({ kind: "fund", topHoldings: [{ symbol: "VOO", weight: 0.5 }] }) });
    expect(overlap([vfv, zsp], new Map([["VOO", profile({ kind: "fund" })]]))).toEqual([]); // VOO known fund, unexpandable: not listed
    const vooHeld = item("VOO", "etf", 200, { holdingKey: "VOO:CAD", profile: voo });
    const r = overlap([vfv, vooHeld]);
    expect(r.map((o) => o.symbol)).toEqual(["NVDA"]);
    expect(r[0].indirect).toBeCloseTo(120 / 1200, 10); // VFV via VOO (100) + VOO itself (20)
    expect(r[0].direct).toBe(0);
    expect(concentration([vfv, vooHeld]).largestWithLookThrough!.symbol).toBe("NVDA");
  });
  it("cash rows passed as items are excluded from sector and region", () => {
    const c = item("CASH", "cash", 100);
    for (const d of ["sector", "region"] as const) {
      expect(allocate([c, stock], [], d).unclassifiedFraction).toBe(0);
    }
    expect(allocate([c, stock], [], "assetClass").slices.map((s) => s.label)).toContain("Cash");
  });
  it("nestedFundSymbols returns every top holding not held directly", () => {
    const f = item("VFV", "etf", 100, { profile: profile({ kind: "fund", topHoldings: [{ symbol: "VOO", weight: 1 }, { symbol: "AAPL", weight: 0.07 }, { symbol: "MID", weight: 0.2 }, { symbol: "HELD", weight: 0.5 }] }) });
    expect(nestedFundSymbols([f, item("HELD", "stock", 10)])).toEqual(["VOO", "AAPL", "MID"]);
  });
});

describe("round 2: fund-of-funds safety net", () => {
  const veqt = item("VEQT", "etf", 1000, { profile: profile({ kind: "fund", topHoldings: [
    { symbol: "VUN", weight: 0.44 }, { symbol: "VCN", weight: 0.3 }, { symbol: "VIU", weight: 0.18 }, { symbol: "VEE", weight: 0.07 }] }) });
  const profiles = new Map<string, SecurityProfile | null>([
    ["VUN", profile({ kind: "fund", topHoldings: [{ symbol: "AAPL", weight: 0.06 }, { symbol: "MSFT", weight: 0.05 }] })],
    ["VCN", profile({ kind: "fund", topHoldings: [{ symbol: "RY", weight: 0.07 }] })],
    ["VIU", profile({ kind: "fund" })],
    ["VEE", null],
  ]);
  it("nestedFundSymbols returns every top-holding symbol not held directly", () => {
    expect(nestedFundSymbols([veqt, item("VCN", "etf", 5)])).toEqual(["VUN", "VIU", "VEE"]);
  });
  it("largest is a company; unprofiled siblings of known funds are ineligible; no sub-fund in overlap", () => {
    const r = concentration([veqt], profiles);
    expect(r.largestWithLookThrough!.symbol).toBe("AAPL");
    expect(r.largestWithLookThrough!.fraction).toBeCloseTo(0.44 * 0.06, 10);
    const direct = item("RY", "stock", 100);
    const ov = overlap([veqt, direct], profiles);
    expect(ov.map((o) => o.symbol)).toEqual(["RY"]);
    const noProfiles = new Map<string, SecurityProfile | null>([["VUN", profiles.get("VUN")!], ["VCN", null], ["VIU", profile({ kind: "fund" })], ["VEE", null]]);
    const c2 = concentration([veqt, item("VEE", "stock", 1)], noProfiles);
    expect(["VUN", "VCN", "VIU"]).not.toContain(c2.largestWithLookThrough!.symbol);
    expect(overlap([veqt, item("VCN", "stock", 10)], noProfiles).map((o) => o.symbol)).not.toContain("VCN");
  });
});

describe("overlap", () => {
  it("combined = direct + sum(ETF value x weight), over the total", () => {
    const r = overlap([stock, etf, bare]);
    expect(r).toEqual([{ symbol: "AAPL", direct: 400 / 1000, indirect: 30 / 1000, combined: 430 / 1000, estimated: true }]);
  });
  it("includes symbols reached through two funds and ignores single-fund-only symbols", () => {
    const a = item("FA", "etf", 100, { profile: profile({ kind: "fund", topHoldings: [{ symbol: "XYZ", weight: 0.5 }, { symbol: "ONLY", weight: 0.1 }] }) });
    const b = item("FB", "etf", 100, { holdingKey: "FB:CAD", profile: profile({ kind: "fund", topHoldings: [{ symbol: "XYZ", weight: 0.2 }] }) });
    const r = overlap([a, b]);
    expect(r.map((o) => o.symbol)).toEqual(["XYZ"]);
    expect(r[0].indirect).toBeCloseTo(70 / 200, 10);
  });
});
