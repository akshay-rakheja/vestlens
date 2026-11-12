import { describe, expect, it } from "vitest";
import { estimateRequests, planFetches } from "./fetch-plan.js";

const now = new Date("2026-10-21T12:00:00Z");
const h = (n: number) => new Date(now.getTime() - n * 3_600_000);
const s = (symbol: string, isMover = false, isConstituent = false) => ({ symbol, isMover, isConstituent });
const base = { now, freeTier: false, budgetLeft: 100 };

describe("planFetches", () => {
  it("orders movers, then stalest (null first), then constituents", () => {
    const plan = planFetches({ ...base,
      symbols: [s("C1", false, true), s("OLD"), s("NEVER"), s("MOV", true), s("OLDER")],
      lastFetch: new Map([["C1", null], ["OLD", h(10)], ["NEVER", null], ["MOV", h(8)], ["OLDER", h(20)]]) });
    expect(plan.map((p) => p.symbol)).toEqual(["MOV", "NEVER", "OLDER", "OLD", "C1"]);
  });
  it("skips symbols fetched within 6 hours", () => {
    const plan = planFetches({ ...base, symbols: [s("A"), s("B"), s("C", true)], lastFetch: new Map([["A", h(5)], ["B", h(7)], ["C", h(1)]]) });
    expect(plan.map((p) => p.symbol)).toEqual(["B"]);
  });
  it("uses a 7 day window on the free tier and 30 days otherwise", () => {
    const sym = [s("A")]; const lastFetch = new Map<string, Date | null>();
    expect(planFetches({ ...base, freeTier: true, symbols: sym, lastFetch })[0].since).toEqual(new Date(now.getTime() - 7 * 86_400_000));
    expect(planFetches({ ...base, symbols: sym, lastFetch })[0].since).toEqual(new Date(now.getTime() - 30 * 86_400_000));
  });
  it("counts requests per alias and stays within budget", () => {
    expect(estimateRequests("ZZ.TO", { usSymbol: "ZZ" })).toBe(6);
    expect(estimateRequests("ZZ")).toBe(3);
    const plan = planFetches({ ...base, budgetLeft: 7, symbols: [s("ZZ.TO", true), s("B"), s("C")], lastFetch: new Map(), known: new Map([["ZZ.TO", { usSymbol: "ZZ" }]]) });
    expect(plan.map((p) => [p.symbol, p.requests])).toEqual([["ZZ.TO", 6]]);
    expect(planFetches({ ...base, budgetLeft: 0, symbols: [s("A")], lastFetch: new Map() })).toEqual([]);
    expect(planFetches({ ...base, budgetLeft: 3, pages: 1, symbols: [s("A"), s("B"), s("C"), s("D")], lastFetch: new Map() })).toHaveLength(3);
  });
  it("estimates one page on the free tier and carries pageSize", () => {
    const plan = planFetches({ ...base, freeTier: true, budgetLeft: 90, symbols: [s("A"), s("ZZ.TO")], lastFetch: new Map(), known: new Map([["ZZ.TO", { usSymbol: "ZZ" }]]) });
    expect(plan.map((p) => [p.symbol, p.requests, p.pageSize])).toEqual([["A", 1, 3], ["ZZ.TO", 2, 3]]);
    const paid = planFetches({ ...base, symbols: [s("A")], lastFetch: new Map() });
    expect(paid[0]).toMatchObject({ requests: 3, pageSize: 20 });
    expect(planFetches({ ...base, pageSize: 7, symbols: [s("A")], lastFetch: new Map() })[0].pageSize).toBe(7);
  });
});
