import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { miniSyntheticAccount } from "../testing/mini-synthetic-fixtures.js";
import { ReconstructionService, type ReconstructedValuePort } from "./reconstruction-service.js";
import type { StoredActivity } from "./stored-activity.js";

export const _check: ReconstructedValuePort = null as unknown as PrismaClient;

const NOW = new Date("2026-10-15T16:00:00Z");
let n = 0;
function act(accountId: string, p: Partial<StoredActivity> & { type: string; tradeDate: string }): StoredActivity {
  n += 1;
  return {
    snapTradeAccountId: accountId, dedupeKey: `k${String(n).padStart(4, "0")}`, symbol: null, securityCurrency: null, isOption: false,
    units: null, price: null, amount: null, fee: null, fxRate: null, currency: "CAD", settlementDate: null, description: null, ...p,
  };
}
const ID = "MINI-SYNTHETIC-ACCOUNT-0";
const goodActivities = (id = ID) => [
  act(id, { type: "CONTRIBUTION", tradeDate: "2026-10-10", amount: 1000 }),
  act(id, { type: "BUY", tradeDate: "2026-10-11", symbol: "AAA", securityCurrency: "CAD", units: 10, price: 50, amount: -500 }),
];
// 10-10: 1000 cash; 10-11..10-15: 500 cash + 10 * 50 = 1000

// Balances default to none (reported cash unknown), so no opening cash anchor applies unless a test sets them.
function account(index: number, reported: number, units: number | null = 10, symbol = "AAA", opts: { unifiedType?: string } = {}) {
  const a = miniSyntheticAccount(index, opts);
  a.account.reportedTotal = { currency: "CAD", amount: reported };
  // Reported price matches the default provider close (50), so the price sanity guard stays quiet.
  a.positions = units === null ? [] : [{ ...a.positions[0]!, symbol, units, price: 50, marketValue: units * 50 }];
  a.balances = [];
  return a;
}
const withCash = (a: ReturnType<typeof account>, cash: number, currency = "CAD") => { a.balances = [{ currency, cash, buyingPower: null }]; return a; };

function setup(options: {
  accounts: ReturnType<typeof account>[];
  activities?: Record<string, StoredActivity[]>;
  existing?: Array<{ date: string; source: string; value?: number; currency?: string }>;
  throwFor?: string;
  raceReported?: string[];
  failOnCreate?: boolean;
  market?: { securityHistory: any; usdCad: any };
  valuationDeadlineMs?: number;
  tradePriceBudgetMs?: number;
  providerProbe?: boolean;
  driftFallback?: number;
  prior?: Array<{ accountId: string; method: string; computedAt: string }>;
}) {
  const upserts: any[] = []; // rows passed to createMany, shaped { create }
  const rowStore = new Map<string, any>(); // key date|currency -> row, with skipDuplicates semantics
  const createCalls: any[] = [];
  const deletes: any[] = [];
  const staleDeletes: any[] = [];
  const qualityPrunes: any[] = [];
  const qualities: any[] = [];
  const dailyValues = {
    findMany: vi.fn(async () => {
      const rows = (options.existing ?? []).map((r) => ({ date: new Date(`${r.date}T00:00:00Z`), source: r.source, value: r.value ?? null, currency: r.currency ?? "CAD" }));
      for (const r of options.raceReported ?? []) rowStore.set(`${r}|CAD`, { source: "reported", date: r });
      return rows;
    }),
    createMany: vi.fn(async (i: any) => {
      createCalls.push(i);
      if (options.failOnCreate) throw new Error("write failed");
      for (const d of i.data) {
        upserts.push({ create: d });
        const k = `${d.date.toISOString().slice(0, 10)}|${d.currency}`;
        if (!rowStore.has(k)) rowStore.set(k, { source: d.source, date: k });
      }
      return { count: i.data.length };
    }),
    deleteMany: vi.fn(async (i: any) => {
      if (typeof i.where.snapTradeAccountId !== "string") { staleDeletes.push(i); return { count: 0 }; }
      deletes.push(i);
      if (i.where.source?.in) for (const [k, v] of rowStore) if (v.source !== "reported") rowStore.delete(k);
      return { count: 0 };
    }),
  };
  const store = {
    userId: vi.fn(async () => "u1"),
    listActivities: vi.fn(async (_u: string, id: string) => {
      if (id === options.throwFor) throw new Error("boom");
      return (options.activities ?? {})[id] ?? goodActivities(id);
    }),
    saveQuality: vi.fn(async (_u: string, id: string, q: any) => { qualities.push({ id, ...q }); }),
    qualities: vi.fn(async () => (options.prior ?? []).map((q) => ({ reason: null, driftFraction: null, ...q }))),
    deleteQualitiesExcept: vi.fn(async (u: string, keep: string[]) => { qualityPrunes.push({ u, keep }); }),
  };
  const closes = ["10", "11", "12", "13", "14", "15"].map((d) => ({ date: `2026-10-${d}`, close: 50 }));
  const market = options.market ?? { securityHistory: vi.fn(async () => ({ points: closes, splits: [] }) as never), usdCad: vi.fn(async () => null as never) };
  const portfolio = { getPortfolio: vi.fn(async () => ({ connectionRequired: false, generatedAt: "x", errors: [], accounts: options.accounts })) };
  const service = new ReconstructionService({ store: store as any, portfolio: portfolio as any, market, dailyValues: { dailyValue: dailyValues }, now: () => NOW,
    ...(options.driftFallback !== undefined ? { driftFallback: options.driftFallback } : {}),
    ...(options.valuationDeadlineMs !== undefined ? { valuationDeadlineMs: options.valuationDeadlineMs } : {}),
    ...(options.tradePriceBudgetMs !== undefined ? { tradePriceBudgetMs: options.tradePriceBudgetMs } : {}),
    ...(options.providerProbe !== undefined ? { providerProbe: options.providerProbe } : {}) });
  return { service, upserts, rowStore, createCalls, deletes, staleDeletes, qualityPrunes, qualities, dailyValues, store, portfolio, market };
}
const dates = (u: any[]) => u.map((x) => x.create.date.toISOString().slice(0, 10));

describe("ReconstructionService", () => {
  it("skips reconciliation when the brokerage read is stale or partial", async () => {
    for (const extra of [{ cache: { stale: true } }, { errors: [{ accountId: "x", code: "account_data_unavailable" }] }]) {
      const t = setup({ accounts: [account(0, 1010)] });
      t.portfolio.getPortfolio.mockImplementation(async () => ({ connectionRequired: false, generatedAt: "x", errors: [], accounts: [account(0, 1010)], ...extra }) as never);
      await expect(t.service.reconstructUser("subject|x")).resolves.toMatchObject({ accounts: 0, failures: 1 });
      expect(t.createCalls.length + t.deletes.length + t.qualities.length).toBe(0);
    }
  });

  it("persists only days before today and keeps sources when drift is small", async () => {
    const t = setup({ accounts: [account(0, 1010)] });
    await expect(t.service.reconstructUser("subject|x")).resolves.toMatchObject({ accounts: 1, failures: 0 });
    expect(dates(t.upserts)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"]);
    expect(t.upserts.every((u) => u.create.source === "reconstructed" && u.create.currency === "CAD")).toBe(true);
    expect(t.upserts[0].create.value).toBe(1000);
    expect(t.qualities[0]).toMatchObject({ id: ID, method: "reconstructed", reason: null });
    expect(t.qualities[0].driftFraction).toBeCloseTo(10 / 1010, 6);
  });

  it("marks all days estimated with reason drift when drift exceeds the threshold", async () => {
    const t = setup({ accounts: [account(0, 1050)] });
    await t.service.reconstructUser("subject|x");
    expect(t.upserts.every((u) => u.create.source === "estimated")).toBe(true);
    expect(t.qualities[0]).toMatchObject({ method: "reconstructed", reason: "drift" });
    expect(t.qualities[0].driftFraction).toBeCloseTo(50 / 1050, 6);
  });

  it("drift guard: 5% drift still writes estimated rows with reason drift", async () => {
    const t = setup({ accounts: [account(0, 1000 / 0.95)] });
    await t.service.reconstructUser("subject|x");
    expect(t.upserts.length).toBeGreaterThan(0);
    expect(t.upserts.every((u) => u.create.source === "estimated")).toBe(true);
    expect(t.qualities[0]).toMatchObject({ method: "reconstructed", reason: "drift" });
  });

  it("drift guard: drift above 10% deletes derived rows and stores snapshots_only", async () => {
    const t = setup({ accounts: [account(0, 2000)] });
    await expect(t.service.reconstructUser("subject|x")).resolves.toMatchObject({ accounts: 1, failures: 0 });
    expect(t.createCalls).toHaveLength(0);
    expect(t.deletes).toHaveLength(1);
    expect(t.qualities).toEqual([{ id: ID, method: "snapshots_only", reason: "drift_too_large", driftFraction: 0.5 }]);
  });

  it("drift guard: holdings mismatch with drift above 10% is also snapshots_only", async () => {
    const t = setup({ accounts: [account(0, 2000, 9)] });
    await t.service.reconstructUser("subject|x");
    expect(t.createCalls).toHaveLength(0);
    expect(t.qualities[0]).toMatchObject({ method: "snapshots_only", reason: "drift_too_large" });
  });

  it("drift guard: the fallback threshold is configurable", async () => {
    const t = setup({ accounts: [account(0, 1000 / 0.95)], driftFallback: 0.01 });
    await t.service.reconstructUser("subject|x");
    expect(t.createCalls).toHaveLength(0);
    expect(t.qualities[0]).toMatchObject({ method: "snapshots_only", reason: "drift_too_large" });
  });

  describe("reconstruction diagnostic", () => {
    const logged = async (t: ReturnType<typeof setup>) => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      let calls: unknown[][] = [];
      try { await t.service.reconstructUser("subject|x"); calls = [...spy.mock.calls]; } finally { spy.mockRestore(); }
      return calls.map((c) => String(c[0])).filter((l) => l.includes("reconstruction_diagnostic")).map((l) => JSON.parse(l));
    };
    const diagAccount = () => {
      const a = account(0, 2000, 10);
      a.positions = [{ ...a.positions[0]!, marketValue: 400 }];
      a.balances = [{ currency: "CAD", cash: 250, buyingPower: null }];
      return a;
    };

    it("emits one counts-and-ratios line with exactly the allowed keys", async () => {
      const lines = await logged(setup({ accounts: [diagAccount()] }));
      expect(lines).toHaveLength(1);
      expect(Object.keys(lines[0]).sort()).toEqual([
        "activityTypes", "anchorRejected", "anchorShare", "bucket", "cashByType", "cashRatio", "corporateActionRows", "costBasisCurrency", "direction", "driftFraction", "event", "extraSymbols",
        "holdingsRatio", "inferredSymbols", "mismatchedSymbols", "missingSymbols", "outcome", "priceChecks", "priceOverridden", "splitAdjusted", "transferOutRows", "unitRatios",
      ]);
      // cashRatio is the raw rebuild (500 / 250); the anchor (-250 over 2000) moves the drift to 1250 / 2000.
      expect(lines[0]).toMatchObject({
        event: "reconstruction_diagnostic", direction: "low", driftFraction: 0.63, holdingsRatio: 1.25, cashRatio: 2, anchorShare: 0.13, anchorRejected: false, unitRatios: [],
        mismatchedSymbols: 0, extraSymbols: 0, missingSymbols: 0, splitAdjusted: false,
        corporateActionRows: 0, transferOutRows: 0, activityTypes: { CONTRIBUTION: 1, BUY: 1 }, outcome: "snapshots_only",
        inferredSymbols: 0, cashByType: { CONTRIBUTION: 0.5, BUY: -0.25 }, priceOverridden: 0,
      });
      // rebuilt close 50 over the reported position price 50
      expect(lines[0].priceChecks).toMatchObject([{ ratio: 1, weight: 1, currencyMatch: true, mapped: true, cashEquivalent: false }]);
      expect(typeof lines[0].bucket).toBe("string");
      // no identities or values: only these strings may appear
      const strings: string[] = [];
      const walk = (v: unknown, key?: string) => {
        if (typeof v === "string") strings.push(`${key}`);
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, ["activityTypes"].includes(key ?? "") ? "activityType" : k);
      };
      walk(lines[0]);
      // `kind` is an allowlisted lowercase instrument word (see kindLabel), never a name or symbol.
      expect([...new Set(strings)].sort()).toEqual(["bucket", "direction", "event", "kind", "outcome"]);
      expect(JSON.stringify(lines[0])).not.toContain(ID);
      expect(JSON.stringify(lines[0])).not.toContain("AAA");
    });

    it("only provider-style type names reach the log; anything else is OTHER", async () => {
      const acts = [...goodActivities(), act(ID, { type: "weird type/john@x.com", tradeDate: "2026-10-12", amount: 0 })];
      const lines = await logged(setup({ accounts: [diagAccount()], activities: { [ID]: acts } }));
      expect(Object.keys(lines[0].activityTypes).every((k) => /^[A-Z_]{1,40}$/.test(k))).toBe(true);
      expect(lines[0].activityTypes.OTHER).toBe(1);
    });

    it("counts symbol differences and activity kinds, and labels 2-10% drift as estimated", async () => {
      const a = account(0, 1000 / 0.95, 9);
      const acts = [...goodActivities(),
        act(ID, { type: "CORPORATE_ACTION", tradeDate: "2026-10-12", symbol: "AAA", units: 1 }),
        act(ID, { type: "WITHDRAWAL", tradeDate: "2026-10-13", amount: 0 }),
        act(ID, { type: "TRANSFER", tradeDate: "2026-10-13", symbol: "AAA", units: -1 })];
      const lines = await logged(setup({ accounts: [a], activities: { [ID]: acts } }));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ outcome: "estimated", corporateActionRows: 1, transferOutRows: 2, mismatchedSymbols: 1, extraSymbols: 0, missingSymbols: 0 });
    });

    it("counts extra and missing symbols; ratios are null when the reported side is zero", async () => {
      const a = account(0, 1000, 10, "BBB");
      a.positions = [{ ...a.positions[0]!, marketValue: 0 }];
      a.balances = [{ currency: "CAD", cash: 0, buyingPower: null }];
      const lines = await logged(setup({ accounts: [a] }));
      expect(lines[0]).toMatchObject({ extraSymbols: 1, missingSymbols: 1, mismatchedSymbols: 0, holdingsRatio: null, cashRatio: null });
    });

    it("cashByType ratios are rounded to 3 dp, allowlisted, and capped at 30 keys", async () => {
      const acts = [...goodActivities(), act(ID, { type: "INTEREST", tradeDate: "2026-10-12", amount: 1 / 3 }),
        act(ID, { type: "weird type/john@x.com", tradeDate: "2026-10-12", amount: 2 })];
      for (let i = 0; i < 35; i++) acts.push(act(ID, { type: `TYPE_${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`, tradeDate: "2026-10-13", amount: 1 }));
      const lines = await logged(setup({ accounts: [diagAccount()], activities: { [ID]: acts } }));
      const c = lines[0].cashByType as Record<string, number>;
      expect(Object.keys(c).length).toBeLessThanOrEqual(30);
      expect(Object.keys(c).every((key) => /^(OPTION:)?[A-Z_]{1,40}$/.test(key) || key === "FUNDS_CONVERSION_COUNTERPART")).toBe(true);
      expect(c.INTEREST).toBe(0); // (1/3) / 2000 rounds to 0.000
      expect(c.CONTRIBUTION).toBe(0.5);
      expect(c.OTHER).toBeGreaterThan(0);
      expect(JSON.stringify(c)).not.toContain("john");
    });

    it("counts inferred opening positions", async () => {
      const acts = [
        act(ID, { type: "CONTRIBUTION", tradeDate: "2026-10-10", amount: 1000 }),
        act(ID, { type: "SELL", tradeDate: "2026-10-11", symbol: "AAA", securityCurrency: "CAD", units: -5, price: 50, amount: 250 }),
      ];
      const lines = await logged(setup({ accounts: [diagAccount()], activities: { [ID]: acts } }));
      expect(lines[0]).toMatchObject({ inferredSymbols: 1 });
    });

    it("unitRatios: replayed over reported units for mismatched symbols only, sorted, 2 dp, no symbols", async () => {
      const a = account(0, 2000 + 485, 5);
      a.positions = [{ ...a.positions[0]!, symbol: "AAA", units: 5 }, { ...a.positions[0]!, symbol: "BBB", units: 10 }];
      const acts = [
        act(ID, { type: "CONTRIBUTION", tradeDate: "2026-10-10", amount: 2000 }),
        act(ID, { type: "BUY", tradeDate: "2026-10-11", symbol: "AAA", securityCurrency: "CAD", units: 10, price: 50, amount: -500 }),
        act(ID, { type: "BUY", tradeDate: "2026-10-11", symbol: "BBB", securityCurrency: "CAD", units: 9.7, price: 50, amount: -485 }),
      ];
      const lines = await logged(setup({ accounts: [a], activities: { [ID]: acts } }));
      expect(lines[0]).toMatchObject({ mismatchedSymbols: 2, unitRatios: [0.97, 2], anchorShare: null });
      expect(JSON.stringify(lines[0])).not.toContain("BBB");
    });

    describe("priceChecks", () => {
      const pos = (symbol: string, units: number, price: number | null, currency: string) =>
        ({ ...miniSyntheticAccount(0).positions[0]!, symbol, units, price, currency, marketValue: price === null ? null : units * price });
      const fxMarket = () => ({
        securityHistory: vi.fn(async () => ({ points: ["10", "11", "12", "13", "14", "15"].map((d) => ({ date: `2026-10-${d}`, close: 50 })), splits: [] }) as never),
        usdCad: vi.fn(async () => ["10", "11", "12", "13", "14", "15"].map((d) => ({ date: `2026-10-${d}`, close: 1.4 })) as never),
      });
      const buy = (symbol: string, cur: string, units: number) =>
        act(ID, { type: "BUY", tradeDate: "2026-10-11", symbol, securityCurrency: cur, units, price: 50, amount: -units * 50, currency: cur });
      const run = async (positions: any[], acts: StoredActivity[]) => {
        const a = account(0, 1000, null);
        a.positions = positions;
        const lines = await logged(setup({ accounts: [a], activities: { [ID]: [act(ID, { type: "CONTRIBUTION", tradeDate: "2026-10-10", amount: 100000 }), ...acts] }, market: fxMarket() }));
        expect(lines).toHaveLength(1);
        return lines[0].priceChecks as Array<Record<string, unknown>>;
      };

      it("flags a USD security valued as CAD, passes a correct holding, and nulls an unmappable symbol", async () => {
        const checks = await run(
          [pos("BADX", 10, 50, "USD"), pos("GOODX", 10, 50, "USD"), pos("XX YY", 1, 10, "CAD")],
          [buy("BADX", "CAD", 10), buy("GOODX", "USD", 10), buy("XX YY", "CAD", 1)],
        );
        expect(checks).toEqual([
          { ratio: 0.714, weight: 0.5, currencyMatch: false, mapped: true },
          { ratio: 1, weight: 0.5, currencyMatch: true, mapped: true },
          { ratio: null, weight: 0.01, currencyMatch: true, mapped: false },
        ].map((c) => expect.objectContaining(c)));
        expect(checks.every((c) => typeof c.kind === "string" && /^[a-z _-]{1,24}$/.test(c.kind as string) && c.cashEquivalent === false)).toBe(true);
        expect(JSON.stringify(checks)).not.toMatch(/BADX|GOODX|XX YY/);
      });

      it("reports the instrument kind as a short word and the cash-equivalent flag, never a name", async () => {
        const odd = { ...pos("ODDX", 10, 50, "CAD"), kind: "Mutual Fund (Series F) / ODDX", cashEquivalent: true };
        const checks = await run([pos("GOODX", 10, 50, "CAD"), odd], [buy("GOODX", "CAD", 10), buy("ODDX", "CAD", 10)]);
        const kinds = checks.map((c) => c.kind).sort();
        expect(kinds).toContain("other");
        expect(checks.some((c) => c.cashEquivalent === true)).toBe(true);
        expect(JSON.stringify(checks)).not.toMatch(/ODDX|Mutual|Series/);
      });

      it("is sorted by deviation from 1, capped at 20, with exactly the allowed keys", async () => {
        const positions: any[] = [];
        const acts: StoredActivity[] = [];
        for (let i = 0; i < 25; i++) {
          const symbol = `S${String.fromCharCode(65 + (i * 7) % 25)}`;
          positions.push(pos(symbol, 10, 50 + i * 2, "CAD"));
          acts.push(buy(symbol, "CAD", 10));
        }
        const checks = await run(positions, acts);
        expect(checks).toHaveLength(20);
        expect(checks.every((c) => JSON.stringify(Object.keys(c).sort()) === JSON.stringify(["cashEquivalent", "currencyMatch", "kind", "mapped", "ratio", "weight"]))).toBe(true);
        const dev = checks.map((c) => Math.abs((c.ratio as number) - 1));
        expect([...dev].sort((x, y) => y - x)).toEqual(dev);
        expect(checks[0]!.ratio).toBe(0.51); // 50 / 98
      });

      it("skips positions without a positive unit count", async () => {
        const checks = await run([pos("GOODX", 10, 50, "CAD"), pos("ZEROX", 0, 50, "CAD")], [buy("GOODX", "CAD", 10)]);
        expect(checks).toHaveLength(1);
      });
    });

    describe("tradePriceChecks", () => {
      const days = ["10", "11", "12", "13", "14", "15"];
      const fxMarket = (fx: Array<{ date: string; close: number }> | null = days.map((d) => ({ date: `2026-10-${d}`, close: 1.4 }))) => ({
        securityHistory: vi.fn(async () => ({ points: days.map((d) => ({ date: `2026-10-${d}`, close: 50 })), splits: [] }) as never),
        usdCad: vi.fn(async () => fx as never),
      });
      const pos = (symbol: string, currency: string) => ({ ...miniSyntheticAccount(0).positions[0]!, symbol, units: 10, price: 50, currency, marketValue: 500 });
      const trade = (symbol: string, rowCurrency: string, price: number, over: Partial<StoredActivity> = {}): StoredActivity =>
        ({ ...act(ID, { type: "BUY", tradeDate: "2026-10-11", symbol, securityCurrency: "USD", currency: rowCurrency, units: 10, price, amount: -10 * price }), ...over });
      const tradeLines = async (t: ReturnType<typeof setup>) => {
        const spy = vi.spyOn(console, "log").mockImplementation(() => {});
        let calls: unknown[][] = [];
        try { await t.service.reconstructUser("subject|x"); calls = [...spy.mock.calls]; } finally { spy.mockRestore(); }
        return calls.map((c) => String(c[0])).filter((l) => l.includes("trade_price_check")).map((l) => JSON.parse(l));
      };
      const run = async (symbols: string[], acts: StoredActivity[], market = fxMarket()) => {
        const a = account(0, 1000, null);
        a.positions = symbols.map((s) => pos(s, "USD"));
        const lines = await tradeLines(setup({ accounts: [a], activities: { [ID]: [act(ID, { type: "CONTRIBUTION", tradeDate: "2026-10-10", amount: 100000 }), ...acts] }, market }));
        expect(lines).toHaveLength(1);
        expect(Object.keys(lines[0]).sort()).toEqual(["bucket", "event", "tradePriceChecks"]);
        return lines[0].tradePriceChecks as Array<Record<string, unknown>>;
      };

      it("a CAD-priced USD security lands in nearFx; a USD-priced one in nearOne", async () => {
        const checks = await run(["CADPX", "USDPX"], [trade("CADPX", "CAD", 70), trade("USDPX", "USD", 50)]);
        const cad = checks.find((c) => c.rowCurrency === "CAD")!;
        const usd = checks.find((c) => c.rowCurrency === "USD")!;
        expect(cad).toEqual({ rowCurrency: "CAD", securityCurrency: "USD", hasFxRate: false, count: 1, median: 1.4, p10: 1.4, p90: 1.4, nearOne: 0, nearFx: 1 });
        // FX is fetched whenever trades exist, so a same-currency group still gets nearFx.
        expect(usd).toEqual({ rowCurrency: "USD", securityCurrency: "USD", hasFxRate: false, count: 1, median: 1, p10: 1, p90: 1, nearOne: 1, nearFx: 0 });
      });

      it("is emitted for an unflagged account too (no reconstruction_diagnostic line)", async () => {
        const t = setup({ accounts: [account(0, 1010)] });
        const lines = await tradeLines(t);
        expect(lines).toEqual([{ event: "trade_price_check", bucket: expect.any(String), tradePriceChecks: [expect.objectContaining({ rowCurrency: "CAD", securityCurrency: "CAD", count: 1, median: 1, nearOne: 1, nearFx: null })] }]);
      });

      it("groups by row currency, security currency and fx-rate presence, with percentiles and shares", async () => {
        const acts = [
          trade("MIXX", "CAD", 70, { fxRate: 1.4 }), trade("MIXX", "CAD", 50, { fxRate: 1.4 }), trade("MIXX", "CAD", 50, { fxRate: 1.4 }),
          trade("MIXX", "CAD", 50, { fxRate: 1.4 }), trade("MIXX", "CAD", 60, { fxRate: 1.4 }),
          trade("MIXX", "CAD", 70, { type: "SELL", units: -1, amount: 70 }),
          trade("MIXX", "CAD", 70, { type: "DIVIDEND", units: null }), // not a trade
          trade("MIXX", "CAD", 70, { isOption: true }), // options are skipped
        ];
        const checks = await run(["MIXX"], acts);
        expect(checks).toHaveLength(2);
        expect(checks[0]).toEqual({ rowCurrency: "CAD", securityCurrency: "USD", hasFxRate: true, count: 5, median: 1, p10: 1, p90: 1.32, nearOne: 0.6, nearFx: 0.2 });
        expect(checks[1]).toMatchObject({ hasFxRate: false, count: 1, median: 1.4, nearFx: 1 });
      });

      it("nearFx counts only rows with a USD/CAD rate within 7 days, and is null when none had one", async () => {
        // FX only on Oct 1 and Oct 20: an Oct 11 trade is 10 days after the last rate; an Oct 2 trade has one.
        const market = fxMarket([{ date: "2026-10-01", close: 1.4 }, { date: "2026-10-20", close: 1.4 }]);
        market.securityHistory = vi.fn(async () => ({ points: [{ date: "2026-10-01", close: 50 }, ...days.map((d) => ({ date: `2026-10-${d}`, close: 50 }))], splits: [] }) as never);
        const acts = [trade("FXX", "CAD", 70, { tradeDate: "2026-10-02" }), trade("FXX", "CAD", 50), trade("FXX", "CAD", 50), trade("FXX", "USD", 50)];
        const checks = await run(["FXX"], acts, market);
        expect(checks.find((c) => c.rowCurrency === "CAD")).toMatchObject({ count: 3, nearFx: 1 }); // 1 of the 1 row with a rate
        expect(checks.find((c) => c.rowCurrency === "USD")).toMatchObject({ count: 1, nearFx: null });
      });

      it("has exactly the allowed keys, exactly 10 groups when more exist, and no symbols, prices or amounts", async () => {
        const currencies = ["CAD", "USD", "EUR", "GBP", "JPY", "AUD", "CHF", "HKD", "MXN", "SEK", "NOK", "x$y"];
        const acts = currencies.flatMap((c) => [trade("SECRETX", c, 51.234), trade("SECRETX", c, 52.345, { fxRate: 1.39 })]);
        const checks = await run(["SECRETX"], acts);
        expect(checks).toHaveLength(10);
        expect(checks.every((c) => JSON.stringify(Object.keys(c).sort()) === JSON.stringify(["count", "hasFxRate", "median", "nearFx", "nearOne", "p10", "p90", "rowCurrency", "securityCurrency"]))).toBe(true);
        expect(checks.every((c) => /^([A-Z]{3}|OTHER)$/.test(c.rowCurrency as string) && /^([A-Z]{3}|OTHER)$/.test(c.securityCurrency as string))).toBe(true);
        const text = JSON.stringify(checks);
        expect(text).not.toMatch(/SECRETX|51\.23|52\.34|x\$y/);
      });

      it("is empty without mappable trades, nearFx is null without FX, and a slow lookup is bounded", async () => {
        expect(await run(["CADPX"], [trade("CADPX", "CAD", 70)], fxMarket(null))).toEqual([expect.objectContaining({ rowCurrency: "CAD", nearFx: null })]);
        const a = account(0, 1000, null);
        const none = await tradeLines(setup({ accounts: [a], activities: { [ID]: [act(ID, { type: "CONTRIBUTION", tradeDate: "2026-10-10", amount: 1000 })] } }));
        expect(none[0].tradePriceChecks).toEqual([]);
        // A CAD-only account needs no FX for valuation; a hanging FX fetch only delays the check, which falls back to [].
        const hang = { ...fxMarket(), usdCad: vi.fn(() => new Promise(() => {}) as never) };
        const slow = await tradeLines(setup({ accounts: [account(0, 1010)], market: hang, tradePriceBudgetMs: 20 }));
        expect(slow[0].tradePriceChecks).toEqual([]);
      });
    });

    describe("provider_metadata_probe", () => {
      it("is one line per valued account with the bucket and the probe keys only", async () => {
        const spy = vi.spyOn(console, "log").mockImplementation(() => {});
        let calls: unknown[][] = [];
        try { await setup({ accounts: [account(0, 1010)] }).service.reconstructUser("subject|x"); calls = [...spy.mock.calls]; } finally { spy.mockRestore(); }
        const lines = calls.map((c) => String(c[0])).filter((l) => l.includes("provider_metadata_probe")).map((l) => JSON.parse(l));
        expect(lines).toHaveLength(1);
        expect(Object.keys(lines[0]).sort()).toEqual(["bucket", "cashEquivalentInBalance", "costBasisCurrency", "event", "positionPriceLiveness"]);
        expect(lines[0].event).toBe("provider_metadata_probe");
        expect(JSON.stringify(lines[0])).not.toMatch(/AAA|MINI-SYNTHETIC/);
      });

      const probeLines = async (t: ReturnType<typeof setup>) => {
        const spy = vi.spyOn(console, "log").mockImplementation(() => {});
        let calls: unknown[][] = [];
        try { await t.service.reconstructUser("subject|x"); calls = [...spy.mock.calls]; } finally { spy.mockRestore(); }
        const lines = calls.map((c) => String(c[0]));
        return { probe: lines.filter((l) => l.includes("provider_metadata_probe")), trade: lines.filter((l) => l.includes("trade_price_check")) };
      };

      it("can be turned off with providerProbe: false; the trade-price check still logs", async () => {
        const { probe, trade } = await probeLines(setup({ accounts: [account(0, 1010)], providerProbe: false }));
        expect(probe).toEqual([]);
        expect(trade).toHaveLength(1);
      });

      it("shares one budget with the trade-price check and stops calling the market once it expires", async () => {
        // A hanging FX fetch stalls the trade-price check past the budget: neither runs on.
        const market = {
          securityHistory: vi.fn(async () => ({ points: [{ date: "2026-10-09", close: 50 }, { date: "2026-10-14", close: 50 }], splits: [] })),
          usdCad: vi.fn(() => new Promise(() => {})),
        };
        const started = Date.now();
        const { probe, trade } = await probeLines(setup({ accounts: [account(0, 1010)], market, tradePriceBudgetMs: 30 }));
        expect(Date.now() - started).toBeLessThan(1000);
        expect(probe).toEqual([]);
        expect(JSON.parse(trade[0]!).tradePriceChecks).toEqual([]);
        const calls = market.securityHistory.mock.calls.length + market.usdCad.mock.calls.length;
        await new Promise((r) => setTimeout(r, 60));
        expect(market.securityHistory.mock.calls.length + market.usdCad.mock.calls.length).toBe(calls);
      });
    });

    describe("share-count tolerance", () => {
      const diag = (reportedUnits: number) => logged(setup({ accounts: [(() => { const a = account(0, 2000, reportedUnits); return a; })()] }));
      it("a 0.3% unit difference is not a mismatch", async () => {
        const lines = await diag(10.03);
        expect(lines[0]).toMatchObject({ mismatchedSymbols: 0, unitRatios: [] });
      });
      it("a 1% unit difference is a mismatch", async () => {
        const lines = await diag(10.1);
        expect(lines[0]).toMatchObject({ mismatchedSymbols: 1, unitRatios: [0.99] });
      });
    });

    it("unitRatios keeps at most 20 entries", async () => {
      const a = account(0, 1000, null);
      const acts = [act(ID, { type: "CONTRIBUTION", tradeDate: "2026-10-10", amount: 100000 })];
      a.positions = [];
      for (let i = 0; i < 25; i++) {
        const symbol = `S${String.fromCharCode(65 + i)}`;
        a.positions.push({ ...miniSyntheticAccount(0).positions[0]!, symbol, units: 10 });
        acts.push(act(ID, { type: "BUY", tradeDate: "2026-10-11", symbol, securityCurrency: "CAD", units: 5 + i, price: 50, amount: -(5 + i) * 50 }));
      }
      const lines = await logged(setup({ accounts: [a], activities: { [ID]: acts } }));
      expect(lines[0].unitRatios).toHaveLength(20);
      expect(lines[0].unitRatios[0]).toBe(0.5);
      expect([...lines[0].unitRatios].sort((x: number, y: number) => x - y)).toEqual(lines[0].unitRatios);
    });

    it("emits nothing for an account within 2% with matching holdings", async () => {
      expect(await logged(setup({ accounts: [account(0, 1010)] }))).toHaveLength(0);
    });

    describe("costBasisCurrency", () => {
      const days = ["10", "11", "12", "13", "14", "15"];
      const fxMarket = (fx: Array<{ date: string; close: number }> | null = days.map((d) => ({ date: `2026-10-${d}`, close: 1.4 }))) => ({
        securityHistory: vi.fn(async () => ({ points: days.map((d) => ({ date: `2026-10-${d}`, close: 50 })), splits: [] }) as never),
        usdCad: vi.fn(async () => fx as never),
      });
      const pos = (symbol: string, units: number, costBasis: number | null, currency = "USD") =>
        ({ ...miniSyntheticAccount(0).positions[0]!, symbol, units, price: 50, currency, marketValue: units * 50, costBasis });
      const buy = (symbol: string, rowCurrency: string, units: number, price: number, date = "2026-10-11") =>
        act(ID, { type: "BUY", tradeDate: date, symbol, securityCurrency: "USD", currency: rowCurrency, units, price, amount: -units * price });
      const sell = (symbol: string, units: number, price: number) =>
        act(ID, { type: "SELL", tradeDate: "2026-10-13", symbol, securityCurrency: "USD", currency: "USD", units: -units, price, amount: units * price });
      const run = async (positions: ReturnType<typeof pos>[], acts: StoredActivity[], market = fxMarket()) => {
        const a = account(0, 9000, null);
        a.positions = positions;
        const lines = await logged(setup({ accounts: [a], activities: { [ID]: [act(ID, { type: "CONTRIBUTION", tradeDate: "2026-10-10", amount: 10000 }), ...acts] }, market }));
        expect(lines).toHaveLength(1);
        return lines[0];
      };

      it("counts whether USD positions' reported cost basis matches the replayed USD or CAD average", async () => {
        const line = await run(
          [pos("SYNUSD", 15, 55.5), pos("SYNCAD", 20, 69.5), pos("SYNNEI", 10, 63), pos("SYNNUL", 10, null), pos("SYNCDN", 10, 123, "CAD")],
          [
            // USD average 55, CAD average (500 + 600) × 1.4 / 20 = 77; a sell keeps both averages.
            buy("SYNUSD", "USD", 10, 50), buy("SYNUSD", "USD", 10, 60, "2026-10-12"), sell("SYNUSD", 5, 70),
            // CAD-paid 700 CAD (USD 50 at 1.4) + USD-paid 500 USD: USD average 50, CAD average (700 + 700) / 20 = 70.
            buy("SYNCAD", "CAD", 10, 70), buy("SYNCAD", "USD", 10, 50),
            // USD 50, CAD 70: 63 is neither.
            buy("SYNNEI", "USD", 10, 50),
            buy("SYNNUL", "USD", 10, 50),
            // A CAD security is not counted.
            act(ID, { type: "BUY", tradeDate: "2026-10-11", symbol: "SYNCDN", securityCurrency: "CAD", currency: "CAD", units: 10, price: 123, amount: -1230 }),
          ],
        );
        expect(line.costBasisCurrency).toEqual({ usd: 1, cad: 1, neither: 1, noCost: 1 });
        const text = JSON.stringify(line);
        for (const s of ["SYNUSD", "SYNCAD", "SYNNEI", "SYNNUL", "SYNCDN", ID, "55.5", "69.5", ":63", ":77", "1230", "10000"]) expect(text).not.toContain(s);
      });

      it("counts a USD position as neither when a USD-paid buy has no BoC rate within 7 days", async () => {
        // The only rate is 2026-10-01; a 2026-10-11 buy is 10 days later. The USD average still replays.
        const line = await run([pos("SYNOLD", 10, 70)], [buy("SYNOLD", "USD", 10, 50)], fxMarket([{ date: "2026-10-01", close: 1.4 }]));
        expect(line.costBasisCurrency).toEqual({ usd: 0, cad: 0, neither: 1, noCost: 0 });
      });

      it("is all zeros for an account without USD positions", async () => {
        const lines = await logged(setup({ accounts: [diagAccount()] }));
        expect(lines[0].costBasisCurrency).toEqual({ usd: 0, cad: 0, neither: 0, noCost: 0 });
      });
    });
  });

  describe("opening cash anchor", () => {
    const quiet = async (t: ReturnType<typeof setup>) => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      let calls: unknown[][] = [];
      try { await t.service.reconstructUser("subject|x"); calls = [...spy.mock.calls]; } finally { spy.mockRestore(); }
      return calls.map((c) => String(c[0])).filter((l) => l.includes("reconstruction_diagnostic")).map((l) => JSON.parse(l));
    };

    it("removes a constant cash gap: drift ~0, every day estimated with reason opening_cash", async () => {
      // Rebuilt: 500 cash + 500 holdings. Reported: 400 cash + 500 holdings = 900 (unanchored drift 11%).
      const t = setup({ accounts: [withCash(account(0, 900), 400)] });
      await quiet(t);
      expect(t.qualities[0]).toMatchObject({ id: ID, method: "reconstructed", reason: "opening_cash" });
      expect(t.qualities[0].driftFraction).toBeCloseTo(0, 9);
      expect(t.upserts.map((u) => [u.create.value, u.create.source])).toEqual(Array.from({ length: 5 }, () => [900, "estimated"]));
    });

    it("anchors without a label when anchorShare is at most 2%", async () => {
      const t = setup({ accounts: [withCash(account(0, 990), 490)] });
      await t.service.reconstructUser("subject|x");
      expect(t.qualities[0]).toMatchObject({ method: "reconstructed", reason: null });
      expect(t.qualities[0].driftFraction).toBeCloseTo(0, 9);
      expect(t.upserts.map((u) => [u.create.value, u.create.source])).toEqual(Array.from({ length: 5 }, () => [990, "reconstructed"]));
    });

    it("cash account: anchorShare above 10% keeps snapshots_only / drift_too_large and deletes derived rows", async () => {
      const reported = 1000 / 1.22; // rebuilt cash 1000, reported cash = total: anchorShare 0.22
      const a = withCash(account(0, reported, null, "AAA", { unifiedType: "CASH" }), reported);
      expect(a.positions).toEqual([]);
      const t = setup({ accounts: [a], activities: { [ID]: [act(ID, { type: "CONTRIBUTION", tradeDate: "2026-10-10", amount: 1000 })] } });
      const lines = await quiet(t);
      expect(t.createCalls).toHaveLength(0);
      expect(t.deletes).toHaveLength(1);
      expect(t.qualities).toHaveLength(1);
      expect(t.qualities[0]).toMatchObject({ id: ID, method: "snapshots_only", reason: "drift_too_large" });
      expect(t.qualities[0].driftFraction).toBeCloseTo(0.22, 9);
      expect(lines[0]).toMatchObject({ bucket: "money_market", anchorShare: 0.22, outcome: "snapshots_only" });
    });

    it("cash account: anchorShare within 10% is anchored and estimated", async () => {
      const reported = 1000 / 1.05;
      const a = withCash(account(0, reported, null, "AAA", { unifiedType: "CASH" }), reported);
      const t = setup({ accounts: [a], activities: { [ID]: [act(ID, { type: "CONTRIBUTION", tradeDate: "2026-10-10", amount: 1000 })] } });
      await quiet(t);
      expect(t.qualities[0]).toMatchObject({ method: "reconstructed", reason: "opening_cash" });
      expect(t.upserts.every((u) => u.create.source === "estimated" && Math.abs(u.create.value - reported) < 1e-9)).toBe(true);
    });

    it("investment account: anchorShare 0.36 is estimated and history is kept", async () => {
      const cash = 320 / 1.36; // |cash - 500| / (500 + cash) = 0.36
      const t = setup({ accounts: [withCash(account(0, 500 + cash), cash)] });
      const lines = await quiet(t);
      expect(t.createCalls.length).toBeGreaterThan(0);
      expect(t.qualities[0]).toMatchObject({ method: "reconstructed", reason: "opening_cash" });
      expect(t.qualities[0].driftFraction).toBeCloseTo(0, 9);
      expect(t.upserts.every((u) => u.create.source === "estimated" && Math.abs(u.create.value - (500 + cash)) < 1e-9)).toBe(true);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ anchorShare: 0.36, outcome: "estimated", driftFraction: 0 });
    });

    it("a positive offset raises every day", async () => {
      const t = setup({ accounts: [withCash(account(0, 1100), 600)] });
      await quiet(t);
      expect(t.qualities[0]).toMatchObject({ method: "reconstructed", reason: "opening_cash" });
      expect(t.qualities[0].driftFraction).toBeCloseTo(0, 9);
      expect(t.upserts.map((u) => [u.create.value, u.create.source])).toEqual(Array.from({ length: 5 }, () => [1100, "estimated"]));
    });

    it("converts a USD balance at the real FX rate", async () => {
      const acts = [...goodActivities(), act(ID, { type: "DIVIDEND", tradeDate: "2026-10-12", amount: 10, currency: "USD" })];
      const closes = ["10", "11", "12", "13", "14", "15"].map((d) => ({ date: `2026-10-${d}`, close: 50 }));
      const fx = ["10", "11", "12", "13", "14", "15"].map((d) => ({ date: `2026-10-${d}`, close: 1.4 }));
      const market = { securityHistory: vi.fn(async () => ({ points: closes, splits: [] }) as never), usdCad: vi.fn(async () => fx as never) };
      // Rebuilt cash today 500 CAD + 10 USD (14 CAD) = 514; reported 400 CAD + 10 USD = 414; offset -100.
      const a = account(0, 914);
      a.balances = [{ currency: "CAD", cash: 400, buyingPower: null }, { currency: "USD", cash: 10, buyingPower: null }];
      const t = setup({ accounts: [a], activities: { [ID]: acts }, market });
      const lines = await quiet(t);
      expect(t.qualities[0]).toMatchObject({ method: "reconstructed", reason: "opening_cash" });
      expect(t.qualities[0].driftFraction).toBeCloseTo(0, 9);
      const values = t.upserts.map((u) => u.create.value);
      [900, 900, 914, 914, 914].forEach((v, i) => expect(values[i]).toBeCloseTo(v, 6));
      expect(lines[0]).toMatchObject({ anchorShare: 0.11, anchorRejected: false });
    });

    it("anchor with a holdings mismatch keeps the holdings_mismatch reason", async () => {
      const t = setup({ accounts: [withCash(account(0, 900, 9), 400)] });
      await quiet(t);
      expect(t.qualities[0]).toMatchObject({ method: "reconstructed", reason: "holdings_mismatch" });
      expect(t.upserts.every((u) => u.create.source === "estimated" && u.create.value === 900)).toBe(true);
    });

    it("anchored drift between 2% and 10% has reason drift", async () => {
      const t = setup({ accounts: [withCash(account(0, 950), 400)] });
      await quiet(t);
      expect(t.qualities[0]).toMatchObject({ method: "reconstructed", reason: "drift" });
      expect(t.qualities[0].driftFraction).toBeCloseTo(50 / 950, 9);
      expect(t.upserts.every((u) => u.create.source === "estimated" && u.create.value === 900)).toBe(true);
    });

    it("anchored drift above 10% is snapshots_only even though the cash matches", async () => {
      const t = setup({ accounts: [withCash(account(0, 1100), 400)] });
      await quiet(t);
      expect(t.createCalls).toHaveLength(0);
      expect(t.qualities).toHaveLength(1);
      expect(t.qualities[0]).toMatchObject({ method: "snapshots_only", reason: "drift_too_large" });
      expect(t.qualities[0].driftFraction).toBeCloseTo(200 / 1100, 9);
    });

    it("rejects an anchor that would take any day to zero or below; the unanchored drift guard decides", async () => {
      // 10-10: 100 cash; from 10-11: 500 cash + 500 holdings. Reported 300 cash, 800 total: offset -200 makes 10-10 -100.
      const acts = [
        act(ID, { type: "CONTRIBUTION", tradeDate: "2026-10-10", amount: 100 }),
        act(ID, { type: "CONTRIBUTION", tradeDate: "2026-10-11", amount: 900 }),
        act(ID, { type: "BUY", tradeDate: "2026-10-11", symbol: "AAA", securityCurrency: "CAD", units: 10, price: 50, amount: -500 }),
      ];
      const t = setup({ accounts: [withCash(account(0, 800), 300)], activities: { [ID]: acts } });
      const lines = await quiet(t);
      expect(t.createCalls).toHaveLength(0);
      expect(t.qualities[0]).toMatchObject({ method: "snapshots_only", reason: "drift_too_large" });
      expect(t.qualities[0].driftFraction).toBeCloseTo(0.25, 9);
      expect(lines[0]).toMatchObject({ anchorShare: 0.25, anchorRejected: true, driftFraction: 0.25, outcome: "snapshots_only" });
    });

    it("a rejected anchor within the guard keeps the unanchored series without opening_cash", async () => {
      const acts = [
        act(ID, { type: "CONTRIBUTION", tradeDate: "2026-10-10", amount: 10 }),
        act(ID, { type: "CONTRIBUTION", tradeDate: "2026-10-11", amount: 990 }),
        act(ID, { type: "BUY", tradeDate: "2026-10-11", symbol: "AAA", securityCurrency: "CAD", units: 10, price: 50, amount: -500 }),
      ];
      const t = setup({ accounts: [withCash(account(0, 1000), 480)], activities: { [ID]: acts } }); // offset -20 makes 10-10 -10
      const lines = await quiet(t);
      expect(t.qualities[0]).toMatchObject({ method: "reconstructed", reason: null });
      expect(t.upserts.map((u) => u.create.value)).toEqual([10, 1000, 1000, 1000, 1000]);
      expect(lines[0]).toMatchObject({ anchorShare: 0.02, anchorRejected: true });
    });

    it("reported cash unknown (no balances, or a foreign balance without FX): no anchor, anchorShare null", async () => {
      for (const a of [account(0, 1000 / 0.95), withCash(account(0, 1000 / 0.95), 10, "USD")]) {
        const t = setup({ accounts: [a] });
        const lines = await quiet(t);
        expect(t.qualities[0]).toMatchObject({ method: "reconstructed", reason: "drift" });
        expect(t.qualities[0].driftFraction).toBeCloseTo(0.05, 9);
        expect(t.upserts[0].create.value).toBe(1000);
        expect(lines[0]).toMatchObject({ anchorShare: null, anchorRejected: false });
      }
    });
  });

  it("holdings reconciliation sees units that include an inferred opening lot", async () => {
    // Sell 5 never bought, then buy 10: an opening lot of 5 makes the final 10 match the brokerage.
    const acts = [
      act(ID, { type: "CONTRIBUTION", tradeDate: "2026-10-10", amount: 1000 }),
      act(ID, { type: "SELL", tradeDate: "2026-10-11", symbol: "AAA", securityCurrency: "CAD", units: -5, price: 50, amount: 250 }),
      act(ID, { type: "BUY", tradeDate: "2026-10-12", symbol: "AAA", securityCurrency: "CAD", units: 10, price: 50, amount: -500 }),
    ];
    const t = setup({ accounts: [account(0, 1250, 10)], activities: { [ID]: acts } });
    await t.service.reconstructUser("subject|x");
    expect(t.qualities[0]).toMatchObject({ method: "reconstructed", reason: null });
    expect(t.qualities[0].driftFraction).toBeCloseTo(0, 9);
    expect(t.upserts.map((u) => [u.create.value, u.create.source])).toEqual([
      [1250, "estimated"], [1250, "reconstructed"], [1250, "estimated"], [1250, "estimated"], [1250, "estimated"],
    ]);
  });

  it("flags holdings mismatch even when value matches", async () => {
    const t = setup({ accounts: [account(0, 1000, 9)] });
    await t.service.reconstructUser("subject|x");
    expect(t.upserts.every((u) => u.create.source === "estimated")).toBe(true);
    expect(t.qualities[0]).toMatchObject({ method: "reconstructed", reason: "holdings_mismatch" });
  });

  it("flags a symbol present on only one side", async () => {
    const t = setup({ accounts: [account(0, 1000, 10, "BBB")] });
    await t.service.reconstructUser("subject|x");
    expect(t.qualities[0]).toMatchObject({ reason: "holdings_mismatch" });
  });

  it("F1: writes derived rows only before the account's first reported row", async () => {
    const t = setup({ accounts: [account(0, 1000)], existing: [{ date: "2026-10-12", source: "reported" }, { date: "2026-10-14", source: "reported" }, { date: "2026-10-13", source: "estimated" }] });
    await t.service.reconstructUser("subject|x");
    expect(dates(t.upserts)).toEqual(["2026-10-10", "2026-10-11"]);
  });

  describe("unrecorded flows (spec 2026-11-04-unrecorded-flow-check)", () => {
    // 1000 deposited Sep 20, 10 AAA bought at 50 on Sep 21; AAA closes vary, so the rebuild tracks the market.
    const days = Array.from({ length: 26 }, (_, i) => new Date(Date.UTC(2026, 8, 20 + i)).toISOString().slice(0, 10));
    const close = (i: number) => 50 + 3 * Math.sin(i);
    const market = () => ({ securityHistory: vi.fn(async () => ({ points: days.map((date, i) => ({ date, close: close(i) })), splits: [] }) as never), usdCad: vi.fn(async () => null as never) });
    const activities = { [ID]: [
      act(ID, { type: "CONTRIBUTION", tradeDate: days[0], amount: 1000 }),
      act(ID, { type: "BUY", tradeDate: days[1], symbol: "AAA", securityCurrency: "CAD", units: 10, price: 50, amount: -500 }),
    ] };
    const rebuilt = (i: number) => 500 + 10 * close(i);
    // Snapshots from Sep 23; a 500 deposit on Oct 5 that SnapTrade's records don't have.
    const reported = (step: number) => days.slice(3, -1).map((date, k) => ({ date, source: "reported", value: rebuilt(k + 3) + (date >= "2026-10-05" ? step : 0) }));
    // Today the brokerage shows the extra 500 as cash: the opening-cash anchor absorbs it, so drift stays small.
    const today = (cash: number, units = 10) => withCash(account(0, cash + units * close(25), units), cash);

    it("stores a step between reported and rebuilt values as an unrecorded flow", async () => {
      const t = setup({ accounts: [today(1000)], activities, existing: reported(500), market: market() });
      await t.service.reconstructUser("subject|x");
      expect(t.qualities[0]).toMatchObject({ method: "reconstructed", unrecordedFlows: [{ date: "2026-10-05", amount: 500 }] });
    });

    it("finds nothing when reported and rebuilt agree", async () => {
      const t = setup({ accounts: [today(500)], activities, existing: reported(0), market: market() });
      await t.service.reconstructUser("subject|x");
      expect(t.qualities[0].method).toBe("reconstructed");
      expect(t.qualities[0].unrecordedFlows ?? []).toEqual([]);
    });

    it("does not look when the rebuild is not market-neutral (holdings mismatch)", async () => {
      const t = setup({ accounts: [today(1000, 12)], activities, existing: reported(500), market: market() });
      await t.service.reconstructUser("subject|x");
      expect(t.qualities[0]).toMatchObject({ reason: "holdings_mismatch" });
      expect(t.qualities[0].unrecordedFlows).toBeUndefined();
    });
  });

  it("deletes ALL derived rows for the account (any date/currency) before writing", async () => {
    const t = setup({ accounts: [account(0, 1000)] });
    await t.service.reconstructUser("subject|x");
    expect(t.deletes).toHaveLength(1);
    expect(t.deletes[0].where).toEqual({ appUserId: "u1", snapTradeAccountId: ID, source: { in: ["reconstructed", "estimated"] } });
    expect(t.dailyValues.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(t.dailyValues.createMany.mock.invocationCallOrder[0]!);
    expect(t.createCalls[0].skipDuplicates).toBe(true);
  });

  it("leaves no old-currency derived rows when the reporting currency changes", async () => {
    const t = setup({ accounts: [account(0, 1000)] });
    t.rowStore.set("2026-10-10|USD", { source: "reconstructed" });
    await t.service.reconstructUser("subject|x");
    expect([...t.rowStore.keys()].some((k) => k.endsWith("|USD"))).toBe(false);
  });

  it("race: a reported row inserted between read and write stays reported", async () => {
    const t = setup({ accounts: [account(0, 1000)], raceReported: ["2026-10-12"] });
    await t.service.reconstructUser("subject|x");
    expect(t.rowStore.get("2026-10-12|CAD").source).toBe("reported");
    expect(t.rowStore.get("2026-10-11|CAD").source).toBe("reconstructed");
  });

  it("failure mid-write removes derived rows and records error quality", async () => {
    const t = setup({ accounts: [account(0, 1000)], failOnCreate: true });
    await expect(t.service.reconstructUser("subject|x")).resolves.toMatchObject({ accounts: 1, failures: 1 });
    expect(t.deletes.length).toBe(2);
    expect(t.qualities[0]).toEqual({ id: ID, method: "snapshots_only", reason: "error", driftFraction: null });
  });

  it("matches holdings case/whitespace-insensitively", async () => {
    const t = setup({ accounts: [account(0, 1000, 10, " aaa ")] });
    await t.service.reconstructUser("subject|x");
    expect(t.qualities[0]).toMatchObject({ method: "reconstructed", reason: null });
  });

  it("writes derived rows in chunks of 500", async () => {
    const start = new Date(Date.parse("2026-10-14T00:00:00Z") - 1200 * 86_400_000).toISOString().slice(0, 10);
    const t = setup({ accounts: [account(0, 1000, null)], activities: { [ID]: [act(ID, { type: "CONTRIBUTION", tradeDate: start, amount: 1000 })] } });
    await t.service.reconstructUser("subject|x");
    expect(t.createCalls.map((c) => c.data.length)).toEqual([500, 500, 201]);
  });

  it("snapshots_only accounts delete derived rows, save quality and skip valuation", async () => {
    const t = setup({ accounts: [account(0, 1000)], activities: { [ID]: [] } });
    await expect(t.service.reconstructUser("subject|x")).resolves.toMatchObject({ accounts: 1, failures: 0 });
    expect(t.qualities[0]).toMatchObject({ method: "snapshots_only", reason: "no_activity" });
    expect(t.upserts).toEqual([]);
    expect(t.deletes).toHaveLength(1);
    expect(t.deletes[0].where.date).toBeUndefined();
  });

  it("one account throwing does not stop the next", async () => {
    const t = setup({ accounts: [account(0, 1000), account(1, 1000)], throwFor: ID });
    await expect(t.service.reconstructUser("subject|x")).resolves.toMatchObject({ accounts: 2, failures: 1 });
    expect(t.qualities[0]).toEqual({ id: ID, method: "snapshots_only", reason: "error", driftFraction: null });
    expect(t.qualities[1]).toMatchObject({ id: "MINI-SYNTHETIC-ACCOUNT-1", method: "reconstructed" });
  });

  it("skips excluded and unreported accounts", async () => {
    const credit = miniSyntheticAccount(2, { unifiedType: "CREDIT_CARD" });
    const t = setup({ accounts: [account(0, 1000), miniSyntheticAccount(1, { reported: false }), credit] });
    await expect(t.service.reconstructUser("subject|x")).resolves.toMatchObject({ accounts: 1, failures: 0 });
  });

  it("F2: a failed history fetch for a held ticker keeps existing rows and quality (zero writes)", async () => {
    const market = { securityHistory: vi.fn(async () => null as never), usdCad: vi.fn(async () => null as never) };
    const t = setup({ accounts: [account(0, 1000)], market, prior: [{ accountId: ID, method: "reconstructed", computedAt: "2026-10-14T21:30:00Z" }] });
    await expect(t.service.reconstructUser("subject|x")).resolves.toEqual({ accounts: 1, failures: 1, codes: { history_unavailable: 1 } });
    expect(t.createCalls.length + t.deletes.length + t.qualities.length).toBe(0);
  });

  it("F2 bound: a fetch failure with no recent rebuilt history writes estimated rows instead of freezing", async () => {
    const market = { securityHistory: vi.fn(async () => null as never), usdCad: vi.fn(async () => null as never) };
    for (const prior of [undefined, [{ accountId: ID, method: "reconstructed", computedAt: "2026-10-07T21:30:00Z" }]]) {
      const t = setup({ accounts: [account(0, 1000)], market, prior, driftFallback: Infinity });
      await t.service.reconstructUser("subject|x");
      expect(t.createCalls.length).toBeGreaterThan(0);
      expect(t.upserts.every((u) => u.create.source === "estimated")).toBe(true);
      expect(t.qualities).toHaveLength(1);
    }
  });

  it("F2: needed FX unavailable keeps existing rows and quality", async () => {
    const usd = [
      act(ID, { type: "CONTRIBUTION", tradeDate: "2026-10-10", amount: 1000 }),
      act(ID, { type: "BUY", tradeDate: "2026-10-11", symbol: "AAA", securityCurrency: "USD", units: 10, price: 50, amount: -500 }),
    ];
    const t = setup({ accounts: [account(0, 1000)], activities: { [ID]: usd }, prior: [{ accountId: ID, method: "reconstructed", computedAt: "2026-10-14T21:30:00Z" }] });
    await expect(t.service.reconstructUser("subject|x")).resolves.toEqual({ accounts: 1, failures: 1, codes: { fx_unavailable: 1 } });
    expect(t.createCalls.length + t.deletes.length + t.qualities.length).toBe(0);
  });

  it("F2/M11: the per-account valuation deadline keeps existing rows and quality", async () => {
    const market = { securityHistory: vi.fn(() => new Promise<never>(() => {})), usdCad: vi.fn(async () => null as never) };
    const t = setup({ accounts: [account(0, 1000), account(1, 1000)], market, valuationDeadlineMs: 20,
      activities: { "MINI-SYNTHETIC-ACCOUNT-1": [act("MINI-SYNTHETIC-ACCOUNT-1", { type: "CONTRIBUTION", tradeDate: "2026-10-10", amount: 1000 })] } });
    await expect(t.service.reconstructUser("subject|x")).resolves.toMatchObject({ accounts: 2, failures: 1 });
    expect(t.qualities.map((q) => q.id)).toEqual(["MINI-SYNTHETIC-ACCOUNT-1"]);
    expect(t.deletes.every((d) => d.where.snapTradeAccountId === "MINI-SYNTHETIC-ACCOUNT-1")).toBe(true);
  });

  it("F3: reconciliation uses post-split units", async () => {
    const acts = [
      act(ID, { type: "CONTRIBUTION", tradeDate: "2026-10-10", amount: 1000 }),
      act(ID, { type: "BUY", tradeDate: "2026-10-11", symbol: "AAA", securityCurrency: "CAD", units: 1, price: 500, amount: -500 }),
    ];
    const closes = ["10", "11", "12", "13", "14", "15"].map((d) => ({ date: `2026-10-${d}`, close: 50 }));
    const market = { securityHistory: vi.fn(async () => ({ points: closes, splits: [{ date: "2026-10-13", ratio: 10 }] }) as never), usdCad: vi.fn(async () => null as never) };
    const t = setup({ accounts: [account(0, 1000, 10)], activities: { [ID]: acts }, market });
    await t.service.reconstructUser("subject|x");
    expect(t.qualities[0]).toMatchObject({ method: "reconstructed", reason: null });
    expect(t.upserts.map((u) => u.create.value)).toEqual([1000, 1000, 1000, 1000, 1000]);
  });

  it("F4: fetches each ticker and FX once per run with a common from (earliest activity - 10 days)", async () => {
    const other = "MINI-SYNTHETIC-ACCOUNT-1";
    const usdBuy = (id: string, date: string) => [
      act(id, { type: "CONTRIBUTION", tradeDate: date, amount: 1000 }),
      act(id, { type: "BUY", tradeDate: date, symbol: "AAA", securityCurrency: "USD", units: 1, price: 50, amount: -50 }),
    ];
    const closes = [{ date: "2026-09-01", close: 50 }];
    const market = { securityHistory: vi.fn(async () => ({ points: closes, splits: [] }) as never), usdCad: vi.fn(async () => [{ date: "2026-09-01", close: 1 }] as never) };
    const t = setup({ accounts: [account(0, 1000, 1), account(1, 1000, 1)], activities: { [ID]: usdBuy(ID, "2026-10-01"), [other]: usdBuy(other, "2026-09-20") }, market });
    await t.service.reconstructUser("subject|x");
    expect(market.securityHistory).toHaveBeenCalledTimes(1);
    expect(market.securityHistory).toHaveBeenCalledWith("AAA", "2026-09-10", "2026-10-15");
    expect(market.usdCad).toHaveBeenCalledTimes(1);
    expect(market.usdCad).toHaveBeenCalledWith("2026-09-10", "2026-10-15");
  });

  it("M5: crypto positions are unmappable, so the account is estimated rather than priced as a stock", async () => {
    const a = account(0, 1000);
    a.positions = [{ ...a.positions[0]!, symbol: "AAA", units: 10, kind: "crypto" }];
    const t = setup({ accounts: [a], driftFallback: Infinity });
    await t.service.reconstructUser("subject|x");
    expect((t.market.securityHistory as any).mock.calls.length).toBe(0);
    expect(t.upserts.length).toBeGreaterThan(0);
    expect(t.upserts.slice(1).every((u) => u.create.source === "estimated")).toBe(true);
  });

  it("M6: removes derived and quality rows for accounts no longer included", async () => {
    const t = setup({ accounts: [account(0, 1000), miniSyntheticAccount(2, { unifiedType: "CREDIT_CARD" })] });
    await t.service.reconstructUser("subject|x");
    expect(t.staleDeletes).toEqual([{ where: { appUserId: "u1", snapTradeAccountId: { notIn: [ID] }, source: { in: ["reconstructed", "estimated"] } } }]);
    expect(t.qualityPrunes).toEqual([{ u: "u1", keep: [ID] }]);
  });

  it("M6: an included account with a transient null total keeps its history", async () => {
    const t = setup({ accounts: [account(0, 1000), miniSyntheticAccount(1, { reported: false })] });
    await t.service.reconstructUser("subject|x");
    expect(t.staleDeletes[0].where.snapTradeAccountId.notIn).toEqual([ID, "MINI-SYNTHETIC-ACCOUNT-1"]);
    expect(t.qualityPrunes[0].keep).toEqual([ID, "MINI-SYNTHETIC-ACCOUNT-1"]);
  });

  it("returns zeros for an unknown user", async () => {
    const t = setup({ accounts: [account(0, 1000)] });
    t.store.userId.mockResolvedValueOnce(null as never);
    await expect(t.service.reconstructUser("subject|x")).resolves.toMatchObject({ accounts: 0, failures: 0 });
  });

  describe("price sanity guard", () => {
    const logged = async (t: ReturnType<typeof setup>) => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      let calls: unknown[][] = [];
      try { await t.service.reconstructUser("subject|x"); calls = [...spy.mock.calls]; } finally { spy.mockRestore(); }
      return calls.map((c) => String(c[0])).filter((l) => l.includes("reconstruction_diagnostic")).map((l) => JSON.parse(l));
    };
    const closesAt = (close: number) => ({
      securityHistory: vi.fn(async () => ({ points: ["10", "11", "12", "13", "14", "15"].map((d) => ({ date: `2026-10-${d}`, close })), splits: [] }) as never),
      usdCad: vi.fn(async () => null as never),
    });
    const guarded = (kind: string, price: number | null) => {
      const a = account(0, 1000);
      a.positions = [{ ...a.positions[0]!, kind, price, marketValue: price === null ? null : 10 * price }];
      return a;
    };

    it("a non-stock holding priced at 0.007x by the provider is valued at the reported price, held constant, estimated", async () => {
      const t = setup({ accounts: [guarded("other", 50)], market: closesAt(0.35) });
      const lines = await logged(t);
      expect((t.market.securityHistory as any).mock.calls.length).toBe(0);
      expect(t.qualities[0]).toMatchObject({ method: "reconstructed" });
      expect(t.qualities[0].driftFraction).toBeCloseTo(0, 6);
      expect(t.upserts.map((u) => u.create.value)).toEqual([1000, 1000, 1000, 1000, 1000]);
      expect(t.upserts.map((u) => u.create.source)).toEqual(["reconstructed", "estimated", "estimated", "estimated", "estimated"]);
      expect(lines).toHaveLength(1);
      expect(lines[0].priceOverridden).toBe(1);
      expect(JSON.stringify(lines[0])).not.toContain("AAA");
    });

    it("a stock within 50% of the reported price (ratio 1.02) keeps its provider history", async () => {
      const t = setup({ accounts: [guarded("stock", 50 / 1.02)], market: closesAt(50) });
      const lines = await logged(t);
      expect(t.upserts.every((u) => u.create.source === "reconstructed")).toBe(true);
      expect(t.upserts[1].create.value).toBe(1000);
      expect(lines.every((l) => l.priceOverridden === 0)).toBe(true);
    });

    it("a stock whose provider close is 0.3x the reported price is overridden", async () => {
      const t = setup({ accounts: [guarded("stock", 50)], market: closesAt(15) });
      const lines = await logged(t);
      expect(t.qualities[0]).toMatchObject({ method: "reconstructed" });
      expect(t.qualities[0].driftFraction).toBeCloseTo(0, 6);
      expect(t.upserts.map((u) => u.create.value)).toEqual([1000, 1000, 1000, 1000, 1000]);
      expect(t.upserts.slice(1).every((u) => u.create.source === "estimated")).toBe(true);
      expect(lines[0].priceOverridden).toBe(1);
    });

    it("a stock 1.6x the reported price is overridden", async () => {
      const t = setup({ accounts: [guarded("etf", 50)], market: closesAt(80) });
      const lines = await logged(t);
      expect(t.upserts.map((u) => u.create.value)).toEqual([1000, 1000, 1000, 1000, 1000]);
      expect(lines[0].priceOverridden).toBe(1);
    });

    it("a guarded holding with no reported price is not overridden: it is unmappable (estimated)", async () => {
      const t = setup({ accounts: [guarded("other", null)], market: closesAt(0.35), driftFallback: Infinity });
      const lines = await logged(t);
      expect((t.market.securityHistory as any).mock.calls.length).toBe(0);
      expect(t.upserts.length).toBeGreaterThan(0);
      // the holding is not valued at all (unmappable): only cash remains
      expect(t.upserts[1].create.value).toBe(500);
      expect(t.upserts.slice(1).every((u) => u.create.source === "estimated")).toBe(true);
      expect(lines[0].priceOverridden).toBe(0);
    });
  });
});
