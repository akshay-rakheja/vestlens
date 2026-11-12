import { describe, expect, it, vi } from "vitest";

import { NudgeService } from "../nudges/nudge-service.js";
import { buildPortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import { connectFacts, FACT_SUBJECT, firstText } from "../testing/fact-tools-harness.js";
import { MemoryNudgePrisma } from "../testing/memory-nudge-prisma.js";

// Synthetic accounts, symbols and amounts only. SHOP.TO is 40% of the 3,000 portfolio (cash included).
const limit = (maxPct: number) => ({ name: "set_portfolio_limit", arguments: { kind: "single_holding", target: "SHOP.TO", maxPct } });
const thesis = { name: "log_thesis", arguments: { ticker: "SHOP.TO", reasons: "Synthetic reasons.", timeFrame: null, conditions: [{ kind: "price_below", text: "Price stays above 130", price: 130, currency: "CAD" }] } };

async function withRealNudges() {
  const c = await connectFacts();
  const prisma = new MemoryNudgePrisma();
  const nudges = new NudgeService({
    prisma, memory: c.service, market: c.facts.market, now: () => c.clock.now,
    portfolio: async () => buildPortfolioPresentation(await c.portfolio.getPortfolio() as never),
  });
  c.facts.nudges = nudges;
  return { ...c, prisma, nudges };
}

describe("nudges are re-evaluated after a save", () => {
  it("an open 30% limit nudge: setting a 50% limit hides it at once and the re-evaluation clears it", async () => {
    const { client, nudges, prisma, events } = await withRealNudges();
    await client.callTool(limit(30));
    expect((await nudges.openNudges(FACT_SUBJECT)).map((n) => n.text)).toEqual(["SHOP.TO is 40% of your portfolio, over your 30% limit."]);
    const saved = await client.callTool(limit(50));
    expect(firstText(saved).startsWith("Noted your 50% limit on SHOP.TO.")).toBe(true);
    expect(await nudges.openNudges(FACT_SUBJECT)).toEqual([]);
    expect(prisma.rows.filter((r) => r.clearedAt === null)).toEqual([]);
    expect(events).toContainEqual({ event: "nudge_reevaluate", code: "done" });
  });

  it("log_thesis re-evaluates with the portfolio it already loaded", async () => {
    const { client, nudges, portfolio } = await withRealNudges();
    const reads = () => portfolio.getPortfolio.mock.calls.length;
    await client.callTool(thesis);
    expect((await nudges.openNudges(FACT_SUBJECT)).map((n) => n.text)).toEqual(['Your SHOP.TO thesis condition "Price stays above 130" looks broken (120.00 CAD as of 2026-10-22).']);
    expect(reads()).toBe(1);
  });

  it("a slow re-evaluation is cut off at the deadline: a code is logged and the save stands", async () => {
    const c = await connectFacts();
    c.facts.nudges = { evaluateNudges: vi.fn(() => new Promise<never>(() => {})) };
    c.facts.nudgeDeadlineMs = 10;
    const result = await c.client.callTool(limit(30));
    expect(result.isError).toBeFalsy();
    expect(firstText(result).startsWith("Noted your 30% limit on SHOP.TO.")).toBe(true);
    expect(c.events).toContainEqual({ event: "nudge_reevaluate", code: "timeout" });
  });

  it("a failed re-evaluation logs a code only and never fails the save", async () => {
    const c = await connectFacts();
    c.facts.nudges = { evaluateNudges: vi.fn(async () => { throw new Error(`synthetic ${FACT_SUBJECT}`); }) };
    const result = await c.client.callTool(thesis);
    expect(result.isError).toBeFalsy();
    expect(c.events).toContainEqual({ event: "nudge_reevaluate", code: "failed" });
    expect(JSON.stringify(c.events)).not.toContain("synthetic");
  });

  it("the default deadline is 2 seconds; a rejected save does not re-evaluate", async () => {
    const { NUDGE_REEVALUATE_DEADLINE_MS } = await import("./portfolio-fact-tools.js");
    expect(NUDGE_REEVALUATE_DEADLINE_MS).toBe(2000);
    const c = await connectFacts();
    const evaluateNudges = vi.fn(async () => ({ raised: 0, cleared: 0, failed: 0 }));
    c.facts.nudges = { evaluateNudges };
    expect((await c.client.callTool(limit(120))).isError).toBe(true);
    expect(evaluateNudges).not.toHaveBeenCalled();
  });

  for (const [name, over] of [
    ["stale", { cache: { source: "last_good", loadedAt: "2026-10-20T16:00:00.000Z", stale: true, staleReason: "provider_unavailable" } }],
    ["partial", { errors: [{ accountId: "SYNTHETIC-FACT-RRSP", code: "account_data_unavailable" }] }],
  ] as const) {
    it(`a ${name} portfolio read skips the re-evaluation: nudges stay as they were, a code is logged, the save stands`, async () => {
      const { client, nudges, prisma, portfolio, events } = await withRealNudges();
      await client.callTool(limit(30));
      const before = prisma.rows.map((r) => ({ ...r }));
      expect(before).toHaveLength(1);
      const spy = vi.spyOn(nudges, "evaluateNudges");
      const base = await portfolio.getPortfolio();
      portfolio.getPortfolio.mockResolvedValue({ ...base, ...over } as never);
      const saved = await client.callTool(limit(50));
      expect(firstText(saved).startsWith("Noted your 50% limit on SHOP.TO.")).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      expect(prisma.rows).toEqual(before);
      expect(events).toContainEqual({ event: "nudge_reevaluate", code: "nudge_reeval_skipped" });
    });
  }
});
