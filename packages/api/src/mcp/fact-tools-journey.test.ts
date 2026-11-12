import { describe, expect, it } from "vitest";

import { connectFacts, firstText, TFSA_ID } from "../testing/fact-tools-harness.js";

// Spec 2026-10-24 §11 acceptance, end to end through MCP tool outputs only. Synthetic accounts and amounts only.
describe("theses, limits and goals: the full journey from tool outputs", () => {
  it("log_thesis -> show_thesis -> set_portfolio_limit -> show_limits -> set_savings_goal (5%) -> show_goal", async () => {
    const { client } = await connectFacts();

    const logged = await client.callTool({
      name: "log_thesis",
      arguments: {
        ticker: "SHOP", reasons: "Synthetic: merchants keep moving online.", timeFrame: { kind: "long", years: 3 },
        conditions: [
          { kind: "price_below", text: "Falls below 80", price: 80, currency: "CAD" },
          { kind: "fundamental", text: "Revenue growth under 20%", metric: "revenue growth", threshold: 20 },
        ],
      },
    });
    expect(firstText(logged)).toBe("Noted your reasons for SHOP.TO.");

    const thesis = firstText(await client.callTool({ name: "show_thesis", arguments: { ticker: "SHOP" } }));
    expect(thesis).toContain("\"Falls below 80\": held");
    expect(thesis).toContain("can't check automatically yet");
    expect(thesis).toMatch(/S&P 500|can't compare|How it played out/);

    const limit = firstText(await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "single_holding", maxPct: 10 } }));
    expect(limit.startsWith("Noted your 10% limit on any single holding.")).toBe(true);

    const limits = firstText(await client.callTool({ name: "show_limits", arguments: {} }));
    expect(limits).toContain("10% limit on any single holding:");
    expect(limits).toContain("SHOP.TO 40%, over your 10% limit. (of your portfolio, cash included)");

    const goal = firstText(await client.callTool({
      name: "set_savings_goal", arguments: { name: "House", targetCad: 50_000, targetDate: "2028-06-30", accounts: [TFSA_ID], growthRatePct: 5 },
    }));
    expect(goal).toBe("Noted your goal: House.");

    const shown = firstText(await client.callTool({ name: "show_goal", arguments: {} }));
    expect(shown).toContain("Saved so far: about $1,300");
    expect(shown).toContain("Recent pace:");
    expect(shown).toContain("(your assumption)");
  });
});
