import { describe, expect, it } from "vitest";

import { accountKey } from "../memory/keys.js";
import { connectFacts, defaultAccounts, firstText, RRSP_ID, syntheticAccount, texts, TFSA_ID } from "../testing/fact-tools-harness.js";
import { groupBySlug, limitRowText, limitSlug, PORTFOLIO_BASIS } from "./limit-tools.js";
import { FACT_STATUS_MAX_CHARS, fitStatusSections } from "./portfolio-mcp-server.js";
import { withLabels } from "./portfolio-fact-tools.js";

// Synthetic accounts, symbols and amounts only. SHOP.TO is 40% and XEQT.TO 50% of the 3,000 portfolio (cash included).
const limitRows = (repository: { rows: Array<{ property: string; supersededAt: Date | null }> }) =>
  repository.rows.filter((r) => r.property === "rule.concentration_limit" && r.supersededAt === null) as any[];

describe("limitRowText with a converted figure", () => {
  it("states the Bank of Canada rate date as its own sentence", () => {
    const text = limitRowText({
      slug: "s", label: "SHOP", kind: "single_holding", maxPct: 10, currentPct: 14, status: "over", line: "SHOP 14% (est.), over your 10% limit",
      note: "Share of your portfolio, cash included; USD converted at the Bank of Canada rate of 2026-10-22", fxDate: "2026-10-22",
    });
    expect(text).toBe("SHOP 14% (est.), over your 10% limit. (of your portfolio, cash included) USD converted at the Bank of Canada rate of 2026-10-22.");
  });
});

describe("set_portfolio_limit", () => {
  it("saves a stated limit on a memorySlug key, echoes verbatim, then states the current reading", async () => {
    const { client, repository } = await connectFacts();
    const result = await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "single_holding", target: "SHOP.TO", maxPct: 10 } });
    expect(result.isError).toBeFalsy();
    const text = firstText(result);
    expect(text.startsWith("Noted your 10% limit on SHOP.TO.")).toBe(true);
    expect(text).toContain("SHOP.TO 40%, over your 10% limit. (of your portfolio, cash included)");
    const [row] = limitRows(repository);
    expect(row.nodeKey).toBe("single-holding-shop-to");
    expect(row.provenance).toBe("stated");
    expect(limitSlug({ kind: "sector", target: "Technology" })).toBe("sector-technology");
  });

  it("a limit on any one holding echoes with its label", async () => {
    const { client } = await connectFacts();
    const result = await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "single_holding", maxPct: 10 } });
    expect(firstText(result).startsWith("Noted your 10% limit on any single holding.")).toBe(true);
  });

  it("an account subset takes ids from list_portfolio_accounts and is shown by label, never by key", async () => {
    const { client, repository } = await connectFacts();
    const result = await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "single_holding", maxPct: 50, accounts: [TFSA_ID] } });
    expect(firstText(result).startsWith("Noted your 50% limit on any single holding in My TFSA.")).toBe(true);
    expect(firstText(result)).toContain("(of the chosen accounts, cash included)");
    expect(firstText(result)).not.toContain(accountKey(TFSA_ID));
    expect(limitRows(repository)[0].value.accounts).toEqual([accountKey(TFSA_ID)]);
    const shown = await client.callTool({ name: "show_limits", arguments: {} });
    expect(firstText(shown)).toContain("in My TFSA");
    expect(texts(shown).join("\n")).not.toContain(accountKey(TFSA_ID));
  });

  it("rejections are isError with plain text and save nothing", async () => {
    const { client, repository } = await connectFacts();
    const over = await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "single_holding", maxPct: 120 } });
    expect(over.isError).toBe(true);
    expect(firstText(over)).toMatch(/^Not saved: /);
    const unknown = await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "sector", maxPct: 20, accounts: ["SYNTHETIC-NOT-MINE"] } });
    expect(unknown.isError).toBe(true);
    expect(texts(unknown)).toEqual(["Not saved: That account isn't one of the user's connected accounts. Use an account id from list_portfolio_accounts."]);
    const noMax = await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "sector" } });
    expect(noMax.isError).toBe(true);
    expect(repository.rows).toHaveLength(0);
  });

  it("a single-holding target resolves to the held listing: SHOP and SHOP.TO are one limit (M-2)", async () => {
    const { client, repository } = await connectFacts();
    await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "single_holding", target: "SHOP", maxPct: 10 } });
    const echo = firstText(await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "single_holding", target: "shop.to", maxPct: 15 } }));
    expect(echo.startsWith("Noted your 15% limit on SHOP.TO.")).toBe(true);
    expect(limitRows(repository).map((r) => [r.nodeKey, r.value.target, r.value.maxPct])).toEqual([["single-holding-shop-to", "SHOP.TO", 15]]);
    expect(firstText(await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "single_holding", target: "SHOP", remove: true } }))).toBe("Removed your limit on SHOP.TO.");
    expect(limitRows(repository)).toHaveLength(0);
  });

  it("rejects a closed account or credit product in the subset with plain text (M-6)", async () => {
    const closed = syntheticAccount("SYNTHETIC-FACT-CLOSED", "TFSA", "SELF_DIRECTED_TFSA", [], 0, "Old TFSA", "closed");
    const { client, repository } = await connectFacts({ accounts: [...defaultAccounts(), closed] });
    const result = await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "single_holding", maxPct: 20, accounts: [TFSA_ID, "SYNTHETIC-FACT-CLOSED"] } });
    expect(result.isError).toBe(true);
    expect(texts(result)).toEqual(["Not saved: Old TFSA is closed, so a limit can't cover it. Leave it out of accounts."]);
    expect(repository.rows).toHaveLength(0);
  });

  it("a credit product isn't a portfolio account at all; uncounted accounts are named as such", async () => {
    const card = syntheticAccount("SYNTHETIC-FACT-CARD", "CREDIT_CARD", "CREDIT_CARD", [], 0, "Synthetic card");
    const { client, portfolio } = await connectFacts({ accounts: [...defaultAccounts(), card] });
    const credit = await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "sector", maxPct: 20, accounts: ["SYNTHETIC-FACT-CARD"] } });
    // Credit products are left out of the portfolio (2026-10-28), so the card's id is not an account here.
    expect(texts(credit)).toEqual(["Not saved: That account isn't one of the user's connected accounts. Use an account id from list_portfolio_accounts."]);
    const { uncountedReason } = await import("./limit-tools.js");
    const cls = (over: Record<string, unknown>) => ({ label: "x", bucket: "tfsa", group: "registered", includedInPortfolioTotal: true, isClosed: false, ...over }) as never;
    expect(uncountedReason(cls({ isClosed: true, group: "closed" }))).toBe("closed");
    expect(uncountedReason(cls({ bucket: "line_of_credit", group: "credit_products" }))).toBe("a credit product");
    expect(uncountedReason(cls({ includedInPortfolioTotal: false }))).toBe("not counted in your portfolio total");
    expect(uncountedReason(cls({}))).toBeNull();
    expect(portfolio.getPortfolio).toHaveBeenCalled();
  });

  it("remove deletes the limit", async () => {
    const { client, repository } = await connectFacts();
    await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "single_holding", target: "SHOP.TO", maxPct: 10 } });
    const result = await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "single_holding", target: "SHOP.TO", remove: true } });
    expect(firstText(result)).toBe("Removed your limit on SHOP.TO.");
    expect(repository.rows).toHaveLength(0);
  });
});

describe("show_limits", () => {
  it("groups the rows of one limit by slug: a limit with no target lists each holding over it", async () => {
    const { client } = await connectFacts();
    await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "single_holding", maxPct: 30 } });
    await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "asset_class", target: "cash", maxPct: 20 } });
    const result = await client.callTool({ name: "show_limits", arguments: {} });
    const text = firstText(result);
    expect(text).toContain("30% limit on any single holding:\n- XEQT.TO 50%, over your 30% limit. (of your portfolio, cash included)\n- SHOP.TO 40%, over your 30% limit. (of your portfolio, cash included)");
    expect(text).toContain("20% limit on cash:\n- Cash 10% of your 20% limit. (of your portfolio, cash included)");
    const limits = (result.structuredContent as any).limits;
    expect(limits).toHaveLength(2);
    expect(limits.find((l: any) => l.kind === "single_holding").rows).toHaveLength(2);
  });

  it("with no limits says so plainly", async () => {
    const { client } = await connectFacts();
    const result = await client.callTool({ name: "show_limits", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toMatch(/^No limits are saved/);
  });

  it("formats the line, the basis as its own sentence, then other notes", () => {
    const text = limitRowText({
      slug: "s", label: "SHOP", kind: "single_holding", maxPct: 10, currentPct: 12, status: "over",
      line: "SHOP 12%, over your 10% limit", note: "Share of your portfolio, cash included; other listings not combined",
    });
    expect(text).toBe(`SHOP 12%, over your 10% limit. ${PORTFOLIO_BASIS} Other listings not combined.`);
    expect(groupBySlug([{ slug: "a" }, { slug: "b" }, { slug: "a" }] as never).map((g) => [g.slug, g.rows.length])).toEqual([["a", 2], ["b", 1]]);
  });

  it("labels replace raw account keys in notes", () => {
    const key = accountKey(RRSP_ID);
    expect(withLabels(`account ${key} in this goal is no longer connected, so there is no recent pace`, new Map([[key, "My RRSP"]])))
      .toBe("My RRSP in this goal is no longer connected, so there is no recent pace");
    expect(withLabels(`account ${key} in this goal is no longer connected`, new Map())).toBe("an account in this goal is no longer connected");
  });
});

describe("status lines on holdings and allocation results", () => {
  async function schemas(o: { noFacts?: boolean } = {}) {
    const { client } = await connectFacts({ widgets: true, ...o });
    const tools = (await client.listTools()).tools;
    return Object.fromEntries(["show_holdings", "get_holdings", "show_allocation", "get_allocation"].map((n) => [n, tools.find((t) => t.name === n)!.outputSchema]));
  }

  it("leave the holdings and allocation schemas unchanged", async () => {
    expect(await schemas()).toEqual(await schemas({ noFacts: true }));
  });

  it("append the limit lines and per-holding thesis lines as text, with no extra reads", async () => {
    const { client, portfolio, facts, marketCalls } = await connectFacts({ widgets: true });
    await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "single_holding", target: "SHOP.TO", maxPct: 10 } });
    await client.callTool({ name: "log_thesis", arguments: { ticker: "SHOP", reasons: "Synthetic reasons.", conditions: [{ kind: "price_below", text: "Below 100", price: 100, currency: "CAD" }] } });
    for (const name of ["show_holdings", "get_holdings", "show_allocation", "get_allocation"]) {
      portfolio.getPortfolio.mockClear();
      (facts.prisma.activity.findMany as any).mockClear();
      marketCalls.length = 0;
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError, name).toBeFalsy();
      const text = firstText(result);
      expect(text, name).toContain("Your limits:\n- SHOP.TO 40%, over your 10% limit. (of your portfolio, cash included)");
      expect(text, name).toContain("SHOP.TO — Thesis: 1 held / 0 broken");
      const added = text.slice(text.indexOf("Your limits:"));
      expect(added.length, name).toBeLessThanOrEqual(FACT_STATUS_MAX_CHARS);
      expect(FACT_STATUS_MAX_CHARS).toBe(400);
      expect(portfolio.getPortfolio, name).toHaveBeenCalledTimes(1);
      expect(facts.prisma.activity.findMany, name).not.toHaveBeenCalled();
      expect(marketCalls.filter((c) => c.startsWith("history")), name).toEqual([]);
    }
  });

  it("are skipped when the user has no limits or theses", async () => {
    const { client } = await connectFacts({ widgets: true });
    const withFacts = firstText(await client.callTool({ name: "show_holdings", arguments: {} }));
    const without = await connectFacts({ widgets: true, noFacts: true });
    expect(withFacts).toBe(firstText(await without.client.callTool({ name: "show_holdings", arguments: {} })));
    expect(withFacts).not.toContain("Your limits");
    expect(withFacts).not.toContain("Thesis:");
  });

  it("never emit a header with no line under it, and a long limit line does not hide the theses (M-3)", () => {
    const long = `- ${"x".repeat(395)}`;
    expect(fitStatusSections([
      { header: "Your limits:", lines: [long], more: "- …more in show_limits" },
      { header: "Your theses:", lines: ["- SHOP.TO — Thesis: 1 held / 0 broken"], more: "- …more in show_thesis" },
    ], 400)).toEqual(["Your theses:", "- SHOP.TO — Thesis: 1 held / 0 broken"]);
    // The header and its first line need the newline between them too.
    const exact = `- ${"y".repeat(400 - 1 - "Your limits:".length - 1 - 2)}`;
    expect(fitStatusSections([{ header: "Your limits:", lines: [exact], more: "- …more in show_limits" }], 400)).toEqual(["Your limits:", exact]);
    expect(fitStatusSections([{ header: "Your limits:", lines: [`${exact}z`], more: "- …more in show_limits" }], 400)).toEqual([]);
  });

  it("stay within the character budget with many limits", async () => {
    const { client } = await connectFacts({ widgets: true });
    for (let i = 1; i <= 12; i++) await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "single_holding", target: `SYN${i}`, maxPct: i } });
    const text = firstText(await client.callTool({ name: "show_holdings", arguments: {} }));
    const added = text.slice(text.indexOf("Your limits:"));
    expect(added.length).toBeLessThanOrEqual(FACT_STATUS_MAX_CHARS);
    expect(added).toMatch(/more in show_limits/);
  });
});
