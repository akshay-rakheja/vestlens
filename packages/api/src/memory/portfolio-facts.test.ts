import { describe, expect, it } from "vitest";

import { memoryToolDefinitions } from "../mcp/memory-tools.js";
import { MemoryFactRepository } from "../testing/memory-fact-repository.js";
import { accountKey } from "./keys.js";
import { MemoryService } from "./memory-service.js";
import { PROPERTY_REGISTRY, SERVER_DERIVED_PROPERTIES, type MemoryFactInput } from "./memory-types.js";
import { OUTSIDE_VALUE_STALE_DAYS, readGoals, readLimits, readOutsideValues, readTheses, readThesisBaseline } from "./portfolio-facts.js";

// Synthetic subjects, accounts and symbols only.
const ME = "subject|synthetic-facts-me";
const OTHER = "subject|synthetic-facts-other";
const T0 = new Date("2026-05-01T12:00:00.000Z");
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

function setup() {
  const repository = new MemoryFactRepository();
  const service = new MemoryService({ repository, now: () => day(30), log: () => undefined });
  return { repository, service };
}

const thesis = (ticker: string, reasons: string): MemoryFactInput => ({
  node: { type: "security", key: ticker }, property: "security.thesis",
  value: { reasons, timeFrame: { kind: "long", years: 3 }, conditions: [{ kind: "custom", text: "Management stays" }] },
  text: `Thesis on ${ticker}.`, kind: "reason", provenance: "stated",
});

describe("typed portfolio fact readers", () => {
  it("readTheses returns current theses with writtenAt and the number of earlier versions", async () => {
    const { service } = setup();
    await service.remember(ME, thesis("SYN", "First idea."), day(0));
    await service.remember(ME, thesis("SYN", "Changed my mind."), day(5));
    await service.remember(ME, thesis("SYN", "Third take."), day(9));
    await service.remember(ME, thesis("ABC", "Only one."), day(7));
    await service.remember(OTHER, thesis("SYN", "Someone else."), day(1));
    // A free reason on the same node is not a thesis.
    await service.remember(ME, { node: { type: "security", key: "SYN" }, property: "security.reason", value: null, text: "Free text.", kind: "reason", provenance: "inferred" }, day(10));

    const theses = await readTheses(service, ME);
    expect(theses.map((t) => [t.ticker, t.thesis.reasons, t.writtenAt.toISOString(), t.history])).toEqual([
      ["SYN", "Third take.", day(9).toISOString(), 2],
      ["ABC", "Only one.", day(7).toISOString(), 0],
    ]);
    expect(theses[0]!.thesis.conditions[0]!.id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("readTheses takes writtenAt from the value (an amendment keeps it), else the version's recordedAt", async () => {
    const { service } = setup();
    const t = thesis("SYN", "Same idea.");
    await service.remember(ME, { ...t, value: { ...(t.value as object), writtenAt: day(2).toISOString() } } as never, day(6));
    await service.remember(ME, thesis("ABC", "Older row."), day(3));
    const theses = await readTheses(service, ME);
    expect(theses.map((x) => [x.ticker, x.writtenAt.toISOString()])).toEqual([["SYN", day(2).toISOString()], ["ABC", day(3).toISOString()]]);
    expect(theses[0]!.thesis.writtenAt).toBe(day(2).toISOString());
  });

  it("readTheses skips rows that are not stated or imported, or whose value no longer parses", async () => {
    const { service, repository } = setup();
    await service.remember(ME, thesis("SYN", "Good."), day(0));
    repository.rows.push({
      id: "synthetic-bad", subject: ME, nodeType: "security", nodeKey: "BAD", property: "security.thesis", value: { reasons: "x" },
      text: "Bad.", kind: "reason", provenance: "stated", validFrom: null, validTo: null, recordedAt: day(1), source: null, supersededAt: null,
    }, {
      id: "synthetic-inferred", subject: ME, nodeType: "security", nodeKey: "INF", property: "security.thesis",
      value: { reasons: "Guess.", timeFrame: null, conditions: [] },
      text: "Guess.", kind: "reason", provenance: "inferred", validFrom: null, validTo: null, recordedAt: day(2), source: null, supersededAt: null,
    });
    expect((await readTheses(service, ME)).map((t) => t.ticker)).toEqual(["SYN"]);
  });

  it("readLimits and readGoals return current values only, keyed by slug", async () => {
    const { service } = setup();
    const limit = (maxPct: number): MemoryFactInput => ({
      node: { type: "rule", key: "single-holding" }, property: "rule.concentration_limit", value: { kind: "single_holding", maxPct },
      text: "Limit.", kind: "plan", provenance: "stated",
    });
    await service.remember(ME, limit(15), day(0));
    await service.remember(ME, limit(10), day(2));
    await service.remember(ME, {
      node: { type: "rule", key: "tech" }, property: "rule.concentration_limit", value: { kind: "sector", target: "Technology", maxPct: 25 },
      text: "Tech limit.", kind: "plan", provenance: "stated",
    }, day(1));
    const goal = (targetCad: number): MemoryFactInput => ({
      node: { type: "goal", key: "house" }, property: "goal.savings_target",
      value: { name: "House", targetCad, targetDate: "2028-06-01", accounts: [accountKey("synthetic-a"), "outside:other-bank"], growthRatePct: 5 },
      text: "House goal.", kind: "plan", provenance: "stated",
    });
    await service.remember(ME, goal(80000), day(0));
    await service.remember(ME, goal(100000), day(3));

    const limits = await readLimits(service, ME);
    expect(limits.map((l) => [l.slug, l.limit.maxPct, l.setAt.toISOString()])).toEqual([
      ["single-holding", 10, day(2).toISOString()],
      ["tech", 25, day(1).toISOString()],
    ]);
    const goals = await readGoals(service, ME);
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({ slug: "house", goal: { name: "House", targetCad: 100000, growthRatePct: 5 } });
    expect(goals[0]!.setAt.toISOString()).toBe(day(3).toISOString());
    expect(await readLimits(service, OTHER)).toEqual([]);
  });

  it("readOutsideValues maps outside account keys to the current value, stale after 90 days", async () => {
    const { service } = setup();
    const value = (key: string, amountCad: number, asOf: string): MemoryFactInput => ({
      node: { type: "account", key }, property: "account.value", value: { amountCad, asOf }, text: "Outside value.", kind: "fact", provenance: "stated",
    });
    await service.remember(ME, value("outside:other-bank", 1000, "2026-01-01"), day(0));
    await service.remember(ME, value("outside:other-bank", 2500, "2026-05-01"), day(1));
    await service.remember(ME, value("outside:old-rrsp", 4000, "2026-01-30"), day(1));
    const now = new Date("2026-05-31T12:00:00.000Z");
    const values = await readOutsideValues(service, ME, now);
    expect([...values.keys()].sort()).toEqual(["outside:old-rrsp", "outside:other-bank"]);
    expect(values.get("outside:other-bank")).toEqual({ amountCad: 2500, asOf: "2026-05-01", stale: false });
    // 121 days old.
    expect(values.get("outside:old-rrsp")).toEqual({ amountCad: 4000, asOf: "2026-01-30", stale: true });
    expect(OUTSIDE_VALUE_STALE_DAYS).toBe(90);
    // Exactly 90 days is not yet stale; 91 is.
    expect((await readOutsideValues(service, ME, new Date("2026-04-30T00:00:00.000Z"))).get("outside:old-rrsp")?.stale).toBe(false);
    expect((await readOutsideValues(service, ME, new Date("2026-05-01T00:00:00.000Z"))).get("outside:old-rrsp")?.stale).toBe(true);
  });
});

describe("security.thesis_baseline (server-written, derived only)", () => {
  const baseline = {
    writtenAt: "2026-05-01T12:00:00.000Z", positionsAsOf: "2026-04-30T21:00:00.000Z", valueCad: 1_000, units: 10,
    priceNative: 100, currency: "CAD", accountsSeen: [accountKey("synthetic-acct-a")],
    accountsAsOf: { [accountKey("synthetic-acct-a")]: "2026-04-30T21:00:00.000Z" },
  };
  const fact = (provenance: "derived" | "stated" | "inferred", value: unknown = baseline): MemoryFactInput => ({
    node: { type: "security", key: "SYN" }, property: "security.thesis_baseline", value, text: "Value of SYN when the thesis was written.", kind: "fact", provenance,
  });
  it("is written by the system as derived, and read back for the ticker", async () => {
    const { service } = setup();
    await service.remember(ME, fact("derived"), day(0), "system");
    expect(await readThesisBaseline(service, ME, "syn")).toEqual(baseline);
    expect(await readThesisBaseline(service, OTHER, "SYN")).toBeNull();
    expect(await readThesisBaseline(service, ME, "ABC")).toBeNull();
  });
  it("is never writable by an assistant or the dashboard, stated or inferred", async () => {
    const { service } = setup();
    for (const caller of ["assistant", "dashboard"] as const) {
      for (const p of ["stated", "inferred", "derived"] as const) await expect(service.remember(ME, fact(p), day(0), caller)).rejects.toThrow();
    }
    await expect(service.remember(ME, fact("stated"), day(0), "system")).rejects.toThrow();
  });
  it("rejects a malformed value", async () => {
    const { service } = setup();
    await expect(service.remember(ME, fact("derived", { ...baseline, accountsSeen: ["not-a-key"] }), day(0), "system")).rejects.toThrow();
    await expect(service.remember(ME, fact("derived", { ...baseline, valueCad: -1 }), day(0), "system")).rejects.toThrow();
    // Every account seen needs its own positions date.
    await expect(service.remember(ME, fact("derived", { ...baseline, accountsAsOf: {} }), day(0), "system")).rejects.toThrow();
  });
  it("is not offered in the remember tool's schema", () => {
    const remember = memoryToolDefinitions.find((t) => t.name === "remember")!;
    const properties = (remember.inputSchema as unknown as { properties: { property: { enum: string[] } } }).properties.property.enum;
    expect(properties).toContain("security.reason");
    expect(properties).not.toContain("security.thesis_baseline");
    expect(SERVER_DERIVED_PROPERTIES).toEqual(["security.thesis_baseline"]);
    expect(PROPERTY_REGISTRY["security.thesis_baseline"]!.derivedOnly).toBe(true);
  });
});
