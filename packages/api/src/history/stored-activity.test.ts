import { describe, expect, it } from "vitest";
import { toStoredActivities } from "./stored-activity.js";

const raw = (over: Record<string, unknown> = {}) => ({ id: "INVENTED-ACT-1", type: "buy", symbol: { symbol: "SYN.EQ", currency: { code: "CAD" } }, units: 2, price: 10, amount: -20, currency: { code: "CAD" }, trade_date: "2026-01-05T00:00:00Z", settlement_date: "2026-01-06T00:00:00Z", description: "Invented", fee: 0, fx_rate: null, ...over });

describe("toStoredActivities", () => {
  it("normalises type, dates, currency and security currency", () => {
    const { items, total } = toStoredActivities("ACC-1", { data: [raw()], pagination: { total: 1 } });
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ snapTradeAccountId: "ACC-1", type: "BUY", symbol: "SYN.EQ", securityCurrency: "CAD", units: 2, amount: -20, currency: "CAD", tradeDate: "2026-01-05", settlementDate: "2026-01-06" });
  });
  it("M3: total is null when the provider did not report it", () => {
    expect(toStoredActivities("ACC-1", { data: [raw()] }).total).toBeNull();
    expect(toStoredActivities("ACC-1", { data: [raw()], pagination: { offset: 0 } }).total).toBeNull();
    expect(toStoredActivities("ACC-1", { data: [raw()], pagination: { total: 0 } }).total).toBe(0);
  });
  it("flags option trades via option_symbol without changing the dedupe key", () => {
    const opt = toStoredActivities("ACC-1", { data: [raw({ id: undefined, symbol: null, option_symbol: { ticker: "SYN 260101C00010000" } })] }).items[0];
    const plain = toStoredActivities("ACC-1", { data: [raw({ id: undefined })] }).items[0];
    expect(opt.type).toBe("BUY");
    expect(opt.isOption).toBe(true);
    expect(plain.isOption).toBe(false);
    expect(toStoredActivities("ACC-1", { data: [raw({ id: "Z", option_symbol: null })] }).items[0].isOption).toBe(false);
  });
  it("stable dedupe keys without SnapTrade ids", () => {
    const a = toStoredActivities("ACC-1", { data: [raw({ id: undefined })] }).items[0];
    const b = toStoredActivities("ACC-1", { data: [raw({ id: undefined })] }).items[0];
    const c = toStoredActivities("ACC-2", { data: [raw({ id: undefined })] }).items[0];
    expect(a.dedupeKey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(a.dedupeKey).not.toBe(c.dedupeKey);
  });
  it("drops undated rows and counts them", () => {
    const r = toStoredActivities("ACC-1", { data: [raw({ trade_date: null, settlement_date: null }), raw({ id: "B" })] });
    expect(r.items).toHaveLength(1);
    expect(r.dropped).toBe(1);
    expect(r.items[0].dedupeKey).toMatch(/^[0-9a-f]{64}$/);
  });
  it("account-scoped id keys", () => {
    const k = (acc: string, id: string) => toStoredActivities(acc, { data: [raw({ id })] }).items[0].dedupeKey;
    expect(k("ACC-1", "A")).toMatch(/^[0-9a-f]{64}$/);
    expect(k("ACC-1", "A")).toBe(k("ACC-1", "A"));
    expect(k("ACC-1", "A")).not.toBe(k("ACC-2", "A"));
    expect(k("ACC-1", "X".repeat(100))).toMatch(/^[0-9a-f]{64}$/);
  });
  it("keeps identical id-less rows with stable distinct keys", () => {
    const input = { data: [raw({ id: undefined }), raw({ id: undefined })] };
    const a = toStoredActivities("ACC-1", input).items.map((i) => i.dedupeKey);
    const b = toStoredActivities("ACC-1", input).items.map((i) => i.dedupeKey);
    expect(a).toHaveLength(2);
    expect(a[0]).not.toBe(a[1]);
    expect(b).toEqual(a);
  });
  it("numeric strings and whitespace-variant descriptions hash the same", () => {
    const k = (over: Record<string, unknown>) => toStoredActivities("ACC-1", { data: [raw({ id: undefined, ...over })] }).items[0].dedupeKey;
    expect(k({ units: "2" })).toBe(k({ units: 2 }));
    expect(k({ description: "  a   b " })).toBe(k({ description: "a b" }));
  });
});
