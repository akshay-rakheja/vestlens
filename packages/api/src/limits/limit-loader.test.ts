import { describe, expect, it } from "vitest";
import { accountKey } from "../memory/keys.js";
import { MemoryService } from "../memory/memory-service.js";
import { MemoryFactRepository } from "../testing/memory-fact-repository.js";
import { checkLimits } from "./limit-check.js";
import { loadLimitInput, type LimitLoaderDeps } from "./limit-loader.js";

// Synthetic subjects, accounts, symbols and amounts only.
const ME = "subject|synthetic-limit-me";
const OTHER = "subject|synthetic-limit-other";
const NOW = new Date("2026-10-23T16:00:00Z");
const FRESH = "2026-10-22T21:00:00.000Z";

const cls = (bucket: string, group: string, included: boolean, closed = false): any => ({ label: bucket.toUpperCase(), bucket, group, includedInPortfolioTotal: included, isClosed: closed, groupLabel: group, bucketLabel: bucket });
const pos = (symbol: string, marketValue: number | null, over: Record<string, unknown> = {}): any => ({
  instrumentId: symbol, kind: "stock", symbol, description: null, units: 10, price: marketValue === null ? null : marketValue / 10, costBasis: null, marketValue, unrealizedGain: null, currency: "CAD", cashEquivalent: false, ...over,
});
const acct = (id: string, positions: any[], cash: number, over: Record<string, unknown> = {}): any => ({
  id, name: id, classification: cls("tfsa", "registered", true), value: null, balances: [{ currency: "CAD", cash, buyingPower: null }], positions,
  freshness: { positionsAsOf: FRESH, holdingsLastSyncedAt: null, initialSyncCompleted: true, holdingsUnavailable: false }, ...over,
});

async function setup(accounts: any[], limits: Array<{ key: string; value: Record<string, unknown> }>, market: Partial<LimitLoaderDeps["market"]> = {}) {
  const repository = new MemoryFactRepository();
  const memory = new MemoryService({ repository, now: () => NOW, log: () => undefined });
  for (const l of limits) {
    await memory.remember(ME, { node: { type: "rule", key: l.key }, property: "rule.concentration_limit", value: l.value, text: "Limit.", kind: "plan", provenance: "stated" }, NOW);
  }
  await memory.remember(OTHER, { node: { type: "rule", key: "other" }, property: "rule.concentration_limit", value: { kind: "single_holding", maxPct: 1 }, text: "Limit.", kind: "plan", provenance: "stated" }, NOW);
  const calls = { profiles: [] as string[], portfolio: 0, usdCad: 0 };
  const deps: LimitLoaderDeps = {
    memory,
    portfolio: async (subject) => {
      expect(subject).toBe(ME);
      calls.portfolio++;
      return { connectionRequired: false, generatedAt: NOW.toISOString(), totals: [], accounts, errors: [] } as any;
    },
    market: {
      usdCad: async () => { calls.usdCad++; return [{ date: "2026-10-22", close: 1.4 }]; },
      ...market,
    },
  };
  return { deps, calls };
}

describe("loadLimitInput", () => {
  it("scopes the whole portfolio to included, open, non-credit accounts, cash included", async () => {
    const accounts = [
      acct("A", [pos("SHOP", 1_200), pos("RY.TO", 800)], 8_000),
      acct("CARD", [pos("SHOP", 50_000)], 1_000, { classification: cls("credit_card", "credit_products", false) }),
      acct("OLD", [pos("SHOP", 50_000)], 1_000, { classification: cls("tfsa", "closed", true, true) }),
    ];
    const { deps } = await setup(accounts, [{ key: "one-stock", value: { kind: "single_holding", maxPct: 10 } }]);
    const input = await loadLimitInput(deps, ME, NOW);
    expect(input.limits).toHaveLength(1);
    const rows = checkLimits(input, NOW);
    expect(rows).toEqual([expect.objectContaining({ slug: "one-stock", label: "SHOP", status: "over", line: "SHOP 12%, over your 10% limit" })]);
  });

  it("an account subset counts only those accounts; a disconnected one makes it can't tell", async () => {
    const accounts = [acct("A", [pos("SHOP", 1_000)], 1_000), acct("B", [pos("RY.TO", 8_000)], 0)];
    const { deps } = await setup(accounts, [
      { key: "tfsa-only", value: { kind: "single_holding", maxPct: 40, accounts: [accountKey("A")] } },
      { key: "gone", value: { kind: "single_holding", maxPct: 40, accounts: [accountKey("A"), accountKey("GONE")] } },
    ]);
    const rows = checkLimits(await loadLimitInput(deps, ME, NOW), NOW);
    const subset = rows.find((r) => r.slug === "tfsa-only")!;
    expect(subset).toMatchObject({ label: "SHOP", status: "over", line: "SHOP 50%, over your 40% limit" });
    expect(subset.note).toContain("of the chosen accounts, cash included");
    const gone = rows.find((r) => r.slug === "gone")!;
    expect(gone).toMatchObject({ status: "cant_tell", currentPct: null });
    expect(gone.note).toContain("no longer connected");
  });

  it("stale positions in any scoped account give can't tell", async () => {
    const accounts = [acct("A", [pos("SHOP", 1_000)], 1_000), acct("B", [pos("RY.TO", 1_000)], 0, { freshness: { positionsAsOf: "2026-10-14T21:00:00.000Z" } })];
    const { deps } = await setup(accounts, [{ key: "l", value: { kind: "single_holding", maxPct: 10 } }]);
    const [row] = checkLimits(await loadLimitInput(deps, ME, NOW), NOW);
    expect(row).toMatchObject({ status: "cant_tell", currentPct: null });
    expect(row!.note).toContain("latest positions are more than 3 trading days old");
  });

  it("USD converts at the BoC rate on the positions date (est.); no rate gives can't tell", async () => {
    const accounts = [acct("A", [pos("SHOP", 1_000, { currency: "USD" })], 8_600)];
    const { deps } = await setup(accounts, [{ key: "l", value: { kind: "single_holding", maxPct: 10 } }]);
    const [row] = checkLimits(await loadLimitInput(deps, ME, NOW), NOW);
    expect(row!.line).toBe("SHOP 14% (est.), over your 10% limit"); // 1,400 / 10,000
    expect(row!.fxDate).toBe("2026-10-22");
    expect(row!.note).toContain("USD converted at the Bank of Canada rate of 2026-10-22");

    const none = await setup(accounts, [{ key: "l", value: { kind: "single_holding", maxPct: 10 } }], { usdCad: async () => null });
    const [cant] = checkLimits(await loadLimitInput(none.deps, ME, NOW), NOW);
    expect(cant).toMatchObject({ status: "cant_tell", currentPct: null });
    expect(cant!.note).toContain("USD");
  });

  it("an unvalued holding makes the limit can't tell (I-1)", async () => {
    const accounts = [acct("A", [pos("SHOP", 1_000), pos("QQQ", null)], 9_000)];
    const { deps } = await setup(accounts, [{ key: "l", value: { kind: "single_holding", maxPct: 50 } }]);
    const [row] = checkLimits(await loadLimitInput(deps, ME, NOW), NOW);
    expect(row).toMatchObject({ status: "cant_tell", currentPct: null });
    expect(row!.note).toContain("QQQ");
  });

  it("a closed or credit account in a subset is not counted, and noted (M-5)", async () => {
    const accounts = [acct("A", [pos("SHOP", 1_000)], 1_000), acct("CARD", [], 5_000, { classification: cls("credit_card", "credit_products", false) })];
    const { deps } = await setup(accounts, [{ key: "l", value: { kind: "single_holding", maxPct: 40, accounts: [accountKey("A"), accountKey("CARD")] } }]);
    const [row] = checkLimits(await loadLimitInput(deps, ME, NOW), NOW);
    expect(row).toMatchObject({ status: "over", line: "SHOP 50%, over your 40% limit" });
    expect(row!.note).toContain("1 account in this limit is closed or a credit product and is not counted");
  });

  it("sector limits read cached profiles only (no refresh); uncached holdings are unclassified", async () => {
    const accounts = [acct("A", [pos("AAA", 3_000), pos("XEQT", 2_000, { kind: "etf" }), pos("ZZZ", 1_000, { kind: "etf" })], 4_000)];
    const looked: string[] = [];
    const { deps } = await setup(accounts, [{ key: "tech", value: { kind: "sector", target: "Technology", maxPct: 25 } }], {
      cachedProfileLookup: async (t: string) => {
        looked.push(t);
        if (t.startsWith("AAA")) return { known: true, profile: { sector: "Technology" } as any };
        if (t.startsWith("XEQT")) return { known: true, profile: { sectorWeights: { Technology: 0.5, Energy: 0.5 } } as any };
        return { known: false, profile: null };
      },
    });
    const [row] = checkLimits(await loadLimitInput(deps, ME, NOW), NOW);
    expect(row).toMatchObject({ label: "Technology", status: "over", line: "Technology 40% (est.), over your 25% limit", unclassifiedPct: 10 });
    expect(row!.note).toContain("ZZZ");
    expect(looked.length).toBe(3);
  });

  it("no sector limit: no profile reads; a preloaded portfolio is used as given", async () => {
    const accounts = [acct("A", [pos("SHOP", 1_000)], 9_000)];
    const looked: string[] = [];
    const { deps, calls } = await setup(accounts, [{ key: "l", value: { kind: "asset_class", target: "cash", maxPct: 50 } }], {
      cachedProfileLookup: async (t: string) => { looked.push(t); return { known: false, profile: null }; },
    });
    const input = await loadLimitInput(deps, ME, NOW, { portfolio: { connectionRequired: false, generatedAt: NOW.toISOString(), totals: [], accounts, errors: [] } as any });
    expect(calls.portfolio).toBe(0);
    expect(calls.usdCad).toBe(0);
    expect(looked).toEqual([]);
    expect(checkLimits(input, NOW)[0]).toMatchObject({ label: "Cash", status: "over", line: "Cash 90%, over your 50% limit" });
  });

  it("no limits: no portfolio read", async () => {
    const { deps, calls } = await setup([], []);
    expect(await loadLimitInput(deps, ME, NOW)).toEqual({ limits: [] });
    expect(calls.portfolio).toBe(0);
  });

  it("a margin debit stays in the scope as a negative cash line; net equity is the basis (A13)", async () => {
    const { deps } = await setup([acct("M", [pos("AAA", 100_000)], -40_000)], [{ key: "aaa", value: { kind: "single_holding", target: "AAA", maxPct: 90 } }]);
    const input = await loadLimitInput(deps, ME, NOW);
    const [entry] = input.limits;
    expect(entry!.scope.cash.map((c) => c.valueCad)).toEqual([-40_000]);
    const [row] = checkLimits(input, NOW);
    expect(row!.currentPct).toBeCloseTo(166.666667, 4);
    expect(row!.note).toContain("net of a margin debit");
  });

  it("a managed account with zero or no value is named on the row (A9)", async () => {
    const managed = acct("R", [], 0, { unifiedType: "MANAGED_RRSP", classification: { ...cls("rrsp", "registered", true), label: "Managed RRSP", isManaged: true, managementType: "managed" } });
    const { deps } = await setup([acct("A", [pos("SHOP", 1_200)], 8_800), managed], [{ key: "shop", value: { kind: "single_holding", target: "SHOP", maxPct: 10 } }]);
    const input = await loadLimitInput(deps, ME, NOW);
    expect(input.limits[0]!.scope.notInTotal).toEqual(["Managed RRSP"]);
    expect(checkLimits(input, NOW)[0]!.note).toContain("Not included in the total: Managed RRSP.");
  });

  it("names from the brokerage keep two companies on one ticker apart (A5)", async () => {
    const { deps } = await setup([acct("A", [pos("T.TO", 800, { description: "TELUS Corp" }), pos("T", 700, { currency: "USD", description: "AT&T Inc." })], 8_500)], [{ key: "t", value: { kind: "single_holding", target: "T", maxPct: 50 } }]);
    const input = await loadLimitInput(deps, ME, NOW);
    const rows = checkLimits(input, NOW);
    expect(rows.map((r) => r.label)).toEqual(["T"]);
  });
});
