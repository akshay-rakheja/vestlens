import { describe, expect, it, vi } from "vitest";

import { connectFacts, FACT_NOW, FACT_SUBJECT, firstText, RRSP_ID, syntheticAccount, TFSA_ID, texts } from "../testing/fact-tools-harness.js";
import { BENCHMARK_BASIS_NOTE, NO_REASONS_SAVED, SHARES_MOVED_UNVALUED } from "../theses/thesis-check.js";
import { MEMORY_RECONNECT_TEXT } from "./memory-tools.js";
import { NO_TIME_FRAME_TEXT, resolveTicker, THESIS_WIDGET_URI } from "./thesis-tools.js";

// Synthetic subjects, accounts, symbols and amounts only.
const FACT_TOOLS = ["log_thesis", "show_thesis", "set_portfolio_limit", "show_limits", "set_savings_goal", "show_goal"];
const thesis = (over: Record<string, unknown> = {}) => ({
  ticker: "shop", reasons: "Synthetic reasons: merchants keep moving online.",
  timeFrame: { kind: "long", years: 3 },
  conditions: [
    { kind: "price_below", text: "Falls below 100", price: 100, currency: "CAD" },
    { kind: "fundamental", text: "Revenue growth above 20%", metric: "revenue growth", threshold: 20 },
  ],
  ...over,
});
const thesisRows = (repository: { rows: Array<{ property: string; supersededAt: Date | null }> }, property = "security.thesis") =>
  repository.rows.filter((r) => r.property === property && r.supersededAt === null);

describe("fact tools: listing", () => {
  it("lists the six tools in normal mode after the memory tools, with their scopes", async () => {
    const { client } = await connectFacts();
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    expect(names.slice(-6)).toEqual(FACT_TOOLS);
    expect(names.indexOf("forget")).toBeLessThan(names.indexOf("log_thesis"));
    for (const name of ["log_thesis", "set_portfolio_limit", "set_savings_goal"]) {
      expect((tools.find((t) => t.name === name) as any)._meta.securitySchemes, name).toEqual([{ type: "oauth2", scopes: ["portfolio:read", "memory"] }]);
    }
    for (const name of ["show_thesis", "show_limits", "show_goal"]) {
      expect((tools.find((t) => t.name === name) as any)._meta.securitySchemes, name).toEqual([{ type: "oauth2", scopes: ["portfolio:read"] }]);
    }
  });

  it("are never listed without their deps", async () => {
    const without = await connectFacts({ noFacts: true });
    const plainNames = (await without.client.listTools()).tools.map((t) => t.name);
    for (const n of FACT_TOOLS) expect(plainNames).not.toContain(n);
  });

  it("instructions send theses, limits and goals to the dedicated tools instead of remember, without contradiction", async () => {
    const { client } = await connectFacts();
    const instructions = client.getInstructions()!;
    expect(instructions).toContain("save it right away, without being asked: theses, limits and savings goals with log_thesis, set_portfolio_limit and set_savings_goal (reply with their short echo); everything else with remember, without announcing it (mention a save only when it changes a number).");
    expect(instructions).toContain("VestLens checks theses, limits and goals against the user's real holdings; show them with show_thesis, show_limits and show_goal.");
    expect(instructions).not.toMatch(/goal, rule, reason or preference, save it with remember/);
    const memoryOnly = (await connectFacts({ noFacts: true })).client.getInstructions()!;
    expect(memoryOnly).toContain("goal, rule, reason or preference, save it with remember right away");
    expect(memoryOnly).not.toMatch(/log_thesis/);
  });

  it("log_thesis's description asks for a save whenever the user explains a buy or a hold", async () => {
    const { client } = await connectFacts();
    const tool = (await client.listTools()).tools.find((t) => t.name === "log_thesis")!;
    expect(tool.description).toMatch(/^Use this whenever the user says why they bought, hold or would sell a stock or ETF, even in passing/);
    expect(tool.description).toContain("Save it here rather than in your general memory");
    expect(tool.description).toContain("Noted your reasons for <TICKER>.");
  });

  it("each show tool drops its widget reference while its widget is not built", async () => {
    const { client } = await connectFacts({ widgets: true, html: (name) => (["thesis", "limits", "goal"].includes(name) ? null : `<!doctype html><title>${name}</title>`) });
    const tools = (await client.listTools()).tools;
    for (const name of ["show_thesis", "show_limits", "show_goal"]) {
      expect(tools.find((t) => t.name === name)!._meta, name).toEqual({ securitySchemes: [{ type: "oauth2", scopes: ["portfolio:read"] }] });
    }
  });

  it("binds show_thesis to the served thesis card once it is built", async () => {
    const { client } = await connectFacts({ widgets: true });
    const tool = (await client.listTools()).tools.find((t) => t.name === "show_thesis")!;
    expect(THESIS_WIDGET_URI).toBe("ui://portfolio/thesis-v1");
    const uri = (tool._meta as any).ui.resourceUri as string;
    expect(uri).toMatch(/^ui:\/\/portfolio\/thesis-[0-9a-f]{10}$/);
    const read = await client.readResource({ uri });
    expect((read.contents[0] as { text: string }).text).toContain("thesis");
  });
});

describe("fact tools: gates", () => {

  it("the write tools need the memory scope: the verbatim reconnect text, not an error, and nothing saved", async () => {
    const { client, repository } = await connectFacts({ scopes: ["portfolio:read"] });
    for (const [name, args] of [["log_thesis", thesis()], ["set_portfolio_limit", { kind: "single_holding", maxPct: 10 }], ["set_savings_goal", { name: "House" }]] as const) {
      const result = await client.callTool({ name, arguments: args as never });
      expect(result.isError, name).toBeFalsy();
      expect(texts(result), name).toEqual([MEMORY_RECONNECT_TEXT]);
    }
    expect(repository.rows).toHaveLength(0);
  });

  it("the show tools need portfolio:read only", async () => {
    const { client } = await connectFacts({ scopes: ["portfolio:read"] });
    for (const name of ["show_thesis", "show_limits", "show_goal"]) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError, name).toBeFalsy();
      expect(firstText(result), name).not.toBe(MEMORY_RECONNECT_TEXT);
    }
  });
});

describe("log_thesis", () => {
  it("saves under the ticker as held, stated, and echoes verbatim", async () => {
    const { client, repository } = await connectFacts();
    const result = await client.callTool({ name: "log_thesis", arguments: thesis() });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toBe("Noted your reasons for SHOP.TO.");
    const [row] = thesisRows(repository) as any[];
    expect(row.nodeKey).toBe("SHOP.TO");
    expect(row.provenance).toBe("stated");
    expect(row.source).toBe("claude");
    expect(row.value.conditions).toHaveLength(2);
  });

  it("without a time frame saves \"no time frame\" and its text suggests asking", async () => {
    const { client, repository } = await connectFacts();
    const result = await client.callTool({ name: "log_thesis", arguments: thesis({ timeFrame: undefined }) });
    expect(firstText(result)).toBe(`Noted your reasons for SHOP.TO. ${NO_TIME_FRAME_TEXT}`);
    expect(NO_TIME_FRAME_TEXT).toMatch(/Ask the user once/);
    expect((thesisRows(repository)[0] as any).value.timeFrame).toBeNull();
    expect((result.structuredContent as any).timeFrame).toBeNull();
  });

  it("records the baseline with the saved fact's exact recordedAt", async () => {
    const { client, repository, events } = await connectFacts();
    await client.callTool({ name: "log_thesis", arguments: thesis() });
    const [saved] = thesisRows(repository) as any[];
    const [baseline] = thesisRows(repository, "security.thesis_baseline") as any[];
    expect(baseline.provenance).toBe("derived");
    expect(baseline.value.writtenAt).toBe(saved.recordedAt.toISOString());
    expect(Date.parse(baseline.value.writtenAt)).toBe(saved.recordedAt.getTime());
    expect(events).toContainEqual({ event: "thesis_baseline", code: "captured" });
  });

  it("a baseline failure logs a code and the save still succeeds", async () => {
    const { client, repository, service, events } = await connectFacts();
    const original = service.remember.bind(service);
    vi.spyOn(service, "remember").mockImplementation(async (subject, input, now, caller) => {
      if ((input as { property: string }).property === "security.thesis_baseline") throw new Error("synthetic store failure");
      return original(subject, input, now, caller);
    });
    const result = await client.callTool({ name: "log_thesis", arguments: thesis() });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toBe("Noted your reasons for SHOP.TO.");
    expect(thesisRows(repository)).toHaveLength(1);
    expect(events).toContainEqual({ event: "thesis_baseline", code: "failed" });
  });

  it("the no-time-frame follow-up (same reasons) amends: conditions, writtenAt and the baseline are kept", async () => {
    const { client, repository, clock } = await connectFacts();
    await client.callTool({ name: "log_thesis", arguments: thesis({ timeFrame: undefined, boughtAround: "2025-03-01" }) });
    const [first] = thesisRows(repository) as any[];
    const [baseline] = thesisRows(repository, "security.thesis_baseline") as any[];
    expect(first.value.writtenAt).toBe(first.recordedAt.toISOString());
    clock.set(new Date("2026-10-23T18:00:00Z"));
    const result = await client.callTool({ name: "log_thesis", arguments: { ticker: "SHOP", reasons: "  synthetic REASONS: merchants keep   moving online. ", timeFrame: { kind: "short", endDate: "2027-06-30" } } });
    expect(firstText(result)).toBe("Noted your reasons for SHOP.TO.");
    const [now] = thesisRows(repository) as any[];
    expect(now.id).not.toBe(first.id);
    expect(now.value.timeFrame).toEqual({ kind: "short", endDate: "2027-06-30" });
    expect(now.value.conditions).toEqual(first.value.conditions);
    expect(now.value.boughtAround).toBe("2025-03-01");
    expect(now.value.writtenAt).toBe(first.value.writtenAt);
    expect(thesisRows(repository, "security.thesis_baseline")).toEqual([baseline]);
    // Provided fields replace theirs.
    await client.callTool({ name: "log_thesis", arguments: { ticker: "SHOP", reasons: "Synthetic reasons: merchants keep moving online.", conditions: [{ kind: "custom", text: "Founder stays" }] } });
    const [third] = thesisRows(repository) as any[];
    expect(third.value.conditions.map((c: any) => c.text)).toEqual(["Founder stays"]);
    expect(third.value.timeFrame).toEqual({ kind: "short", endDate: "2027-06-30" });
    expect(third.value.writtenAt).toBe(first.value.writtenAt);
  });

  it("an amendment retries a missing baseline, keyed to the kept writtenAt (best effort)", async () => {
    const { client, repository, service, events } = await connectFacts();
    const original = service.remember.bind(service);
    const spy = vi.spyOn(service, "remember").mockImplementation(async (subject, input, now, caller) => {
      if ((input as { property: string }).property === "security.thesis_baseline") throw new Error("synthetic store failure");
      return original(subject, input, now, caller);
    });
    await client.callTool({ name: "log_thesis", arguments: thesis({ timeFrame: undefined }) });
    expect(thesisRows(repository, "security.thesis_baseline")).toHaveLength(0);
    spy.mockRestore();
    const [first] = thesisRows(repository) as any[];
    await client.callTool({ name: "log_thesis", arguments: { ticker: "SHOP", reasons: first.value.reasons, timeFrame: { kind: "long", years: 2 } } });
    const [baseline] = thesisRows(repository, "security.thesis_baseline") as any[];
    expect(baseline.value.writtenAt).toBe(first.value.writtenAt);
    expect(events.filter((e) => e.event === "thesis_baseline").map((e) => (e as any).code)).toEqual(["failed", "captured"]);
    // With a baseline in place, a further amendment leaves it alone.
    await client.callTool({ name: "log_thesis", arguments: { ticker: "SHOP", reasons: first.value.reasons, boughtAround: "2025-01-02" } });
    expect(thesisRows(repository, "security.thesis_baseline")).toEqual([baseline]);
  });

  it("changed reasons start a new thesis: new writtenAt and baseline; omitted conditions and boughtAround don't carry over", async () => {
    const { client, repository, clock } = await connectFacts();
    await client.callTool({ name: "log_thesis", arguments: thesis({ boughtAround: "2025-03-01" }) });
    const [first] = thesisRows(repository) as any[];
    const later = new Date("2026-10-23T18:00:00Z");
    clock.set(later);
    await client.callTool({ name: "log_thesis", arguments: { ticker: "SHOP", reasons: "Synthetic: a different reason now." } });
    const [now] = thesisRows(repository) as any[];
    expect(now.value.writtenAt).toBe(later.toISOString());
    expect(now.value.writtenAt).not.toBe(first.value.writtenAt);
    expect(now.value.conditions).toEqual([]);
    expect(now.value.boughtAround).toBeUndefined();
    expect(now.value.timeFrame).toBeNull();
    const [baseline] = thesisRows(repository, "security.thesis_baseline") as any[];
    expect(baseline.value.writtenAt).toBe(later.toISOString());
  });

  it("the description says how a re-save behaves", async () => {
    const { client } = await connectFacts();
    const tool = (await client.listTools()).tools.find((t) => t.name === "log_thesis")!;
    expect(tool.description).toContain("To update, call again with only the changed fields; new reasons start a new entry.");
    expect(tool.description).not.toContain("same reasons");
  });

  it("amend from a fresh chat (I-4): no reasons sent keeps the current reasons, conditions, writtenAt and baseline", async () => {
    const { client, repository, clock } = await connectFacts();
    await client.callTool({ name: "log_thesis", arguments: thesis({ timeFrame: undefined, boughtAround: "2025-03-01" }) });
    const [first] = thesisRows(repository) as any[];
    const [baseline] = thesisRows(repository, "security.thesis_baseline") as any[];
    // A new conversation that knows only the ticker and the change: "make my SHOP thesis long-term, 3 years".
    clock.set(new Date("2026-10-24T09:00:00Z"));
    const result = await client.callTool({ name: "log_thesis", arguments: { ticker: "SHOP", timeFrame: { kind: "long", years: 3 } } });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toBe("Noted your reasons for SHOP.TO.");
    expect((result.structuredContent as any).amended).toBe(true);
    const [now] = thesisRows(repository) as any[];
    expect(now.id).not.toBe(first.id);
    expect(now.value.reasons).toBe(first.value.reasons);
    expect(now.text).toBe(first.text);
    expect(now.value.timeFrame).toEqual({ kind: "long", years: 3 });
    expect(now.value.conditions).toEqual(first.value.conditions);
    expect(now.value.boughtAround).toBe("2025-03-01");
    expect(now.value.writtenAt).toBe(first.value.writtenAt);
    expect(thesisRows(repository, "security.thesis_baseline")).toEqual([baseline]);
    // Only conditions changed, still no reasons: the time frame just set is kept.
    await client.callTool({ name: "log_thesis", arguments: { ticker: "shop.to", conditions: [{ kind: "custom", text: "Founder stays" }] } });
    const [third] = thesisRows(repository) as any[];
    expect(third.value.reasons).toBe(first.value.reasons);
    expect(third.value.conditions.map((c: any) => c.text)).toEqual(["Founder stays"]);
    expect(third.value.timeFrame).toEqual({ kind: "long", years: 3 });
    expect(third.value.writtenAt).toBe(first.value.writtenAt);
  });

  it("no reasons and no thesis on the ticker is a plain rejection asking for the reasons; nothing is written", async () => {
    const { client, repository } = await connectFacts();
    const result = await client.callTool({ name: "log_thesis", arguments: { ticker: "SHOP", timeFrame: { kind: "long", years: 3 } } });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe("Not saved: No thesis is saved on SHOP.TO yet. Give the user's reasons to start one.");
    expect(repository.rows).toHaveLength(0);
    const blank = await client.callTool({ name: "log_thesis", arguments: { ticker: "SHOP", reasons: "   " } });
    expect(blank.isError).toBe(true);
    expect(firstText(blank)).toMatch(/^Not saved: /);
  });

  it("paraphrased reasons still start a new thesis (the rule is unchanged)", async () => {
    const { client, repository, clock } = await connectFacts();
    await client.callTool({ name: "log_thesis", arguments: thesis() });
    const [first] = thesisRows(repository) as any[];
    clock.set(new Date("2026-10-24T09:00:00Z"));
    const result = await client.callTool({ name: "log_thesis", arguments: { ticker: "SHOP", reasons: "Merchants are moving online.", timeFrame: { kind: "long", years: 5 } } });
    expect((result.structuredContent as any).amended).toBe(false);
    const [now] = thesisRows(repository) as any[];
    expect(now.value.writtenAt).not.toBe(first.value.writtenAt);
    expect(now.value.conditions).toEqual([]);
  });

  it("remove of a saved thesis needs no portfolio read (M-4)", async () => {
    const { client, portfolio } = await connectFacts();
    await client.callTool({ name: "log_thesis", arguments: thesis() });
    portfolio.getPortfolio.mockClear();
    await client.callTool({ name: "log_thesis", arguments: { ticker: "shop", remove: true } });
    expect(portfolio.getPortfolio).not.toHaveBeenCalled();
  });

  it("remove forgets both the thesis and its baseline", async () => {
    const { client, repository } = await connectFacts();
    await client.callTool({ name: "log_thesis", arguments: thesis() });
    expect(thesisRows(repository, "security.thesis_baseline")).toHaveLength(1);
    const result = await client.callTool({ name: "log_thesis", arguments: { ticker: "SHOP.TO", remove: true } });
    expect(firstText(result)).toBe("Removed your thesis on SHOP.TO.");
    expect(repository.rows.filter((r) => r.property.startsWith("security.thesis"))).toHaveLength(0);
  });

  it("rejections are isError with plain text: too many conditions, a bad ticker, no reasons, the cap", async () => {
    const { client, repository, service } = await connectFacts();
    const six = Array.from({ length: 6 }, (_, i) => ({ kind: "custom", text: `Synthetic condition ${i}` }));
    const tooMany = await client.callTool({ name: "log_thesis", arguments: thesis({ conditions: six }) });
    expect(tooMany.isError).toBe(true);
    expect(texts(tooMany)).toEqual(["Not saved: A thesis can have at most 5 conditions."]);
    const badTicker = await client.callTool({ name: "log_thesis", arguments: thesis({ ticker: "$$$" }) });
    expect(badTicker.isError).toBe(true);
    const noReasons = await client.callTool({ name: "log_thesis", arguments: { ticker: "SHOP" } });
    expect(noReasons.isError).toBe(true);
    expect(repository.rows).toHaveLength(0);
    for (let i = 0; i < 50; i++) {
      await service.remember(FACT_SUBJECT, {
        node: { type: "security", key: `SYN${i}` }, property: "security.thesis", value: { reasons: "r", timeFrame: null }, text: "t", kind: "reason", provenance: "stated",
      });
    }
    const capped = await client.callTool({ name: "log_thesis", arguments: thesis() });
    expect(capped.isError).toBe(true);
    expect(texts(capped)).toEqual(["Not saved: You already have 50 theses saved. Remove one before adding another."]);
  });

  it("resolves a ticker as held (base symbol), else keeps it as given", () => {
    expect(resolveTicker("shop", ["SHOP.TO", "XEQT.TO"])).toBe("SHOP.TO");
    expect(resolveTicker("SHOP", ["SHOP", "SHOP.TO"])).toBe("SHOP");
    expect(resolveTicker("td", ["TD.TO", "TD"])).toBe("TD");
    expect(resolveTicker("aapl", ["SHOP.TO"])).toBe("AAPL");
  });
});

describe("show_thesis", () => {
  it("shows the reasons, each condition's status, the fundamental pending text, and no advice words", async () => {
    const { client } = await connectFacts();
    await client.callTool({ name: "log_thesis", arguments: thesis() });
    const result = await client.callTool({ name: "show_thesis", arguments: { ticker: "SHOP" } });
    expect(result.isError).toBeFalsy();
    const text = firstText(result);
    expect(text).toContain("Your thesis on SHOP.TO");
    expect(text).toContain("3-year thesis");
    expect(text).toContain("\"Falls below 100\": held (120.00 CAD, 2026-10-22)");
    expect(text).toContain("\"Revenue growth above 20%\": can't tell");
    expect(text).toContain("can't check automatically yet");
    expect(text).toMatch(/How it played out/);
    expect(text.replace(/"[^"]*"/g, "")).not.toMatch(/\b(should|sell|buy|recommend|consider)\b/i);
    const sc = result.structuredContent as any;
    expect(sc.mode).toBe("one");
    expect(sc.thesis.check.conditions.map((c: any) => c.status)).toEqual(["held", "cant_tell"]);
  });

  it("without a ticker lists every thesis with its condition status", async () => {
    const { client } = await connectFacts();
    await client.callTool({ name: "log_thesis", arguments: thesis() });
    await client.callTool({ name: "log_thesis", arguments: thesis({ ticker: "XEQT.TO", conditions: [{ kind: "weight_above", text: "Over 60%", pct: 60 }] }) });
    const result = await client.callTool({ name: "show_thesis", arguments: {} });
    const text = firstText(result);
    expect(text).toContain("2 theses saved");
    expect(text).toContain("SHOP.TO");
    expect(text).toContain("1 held / 0 broken, 1 can't tell here");
    expect(text).toContain("XEQT.TO");
    expect((result.structuredContent as any).theses).toHaveLength(2);
  });

  it("a held ticker with no thesis and no recorded purchase is the holding view with can't tell, not an error", async () => {
    const { client } = await connectFacts();
    const result = await client.callTool({ name: "show_thesis", arguments: { ticker: "SHOP" } });
    expect(result.isError).toBeFalsy();
    const text = firstText(result);
    expect(text).toContain("Since your first recorded purchase: can't tell: no purchase of this holding is recorded.");
    expect(text).toContain(NO_REASONS_SAVED);
    expect((result.structuredContent as any)).toMatchObject({ mode: "one", ticker: "SHOP.TO", thesis: null });
  });
});

describe("show_thesis: the holding view (any holding, thesis optional)", () => {
  const BOUGHT = [
    { snapTradeAccountId: TFSA_ID, dedupeKey: "buy-1", type: "BUY", symbol: "SHOP.TO", securityCurrency: "CAD", units: 10, price: 100, amount: -1_000, currency: "CAD", tradeDate: new Date("2025-01-02T00:00:00Z") },
  ];
  const withNews = (facts: any) => {
    const at = (iso: string, id: string) => ({ id, urlHash: id, url: `https://example.test/${id}`, headline: `Synthetic ${id}`, snippet: null, source: "Synthetic Wire", imageUrl: null, publishedAt: new Date(iso), symbols: ["SHOP.TO"], fetchedAt: FACT_NOW });
    const articles = [at("2026-10-20T12:00:00Z", "recent"), at("2026-08-01T12:00:00Z", "old")];
    facts.news = { articlesForSymbols: async (_s: string[], since: Date) => articles.filter((a) => a.publishedAt >= since), ratingsFor: async () => [], events: async () => [] };
  };

  it("a holding with no thesis gives the full view: since first bought vs the market, news, weight and limits, no reasons", async () => {
    const { client, facts } = await connectFacts({ activities: BOUGHT });
    withNews(facts);
    await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "single_holding", maxPct: 10 } });
    const result = await client.callTool({ name: "show_thesis", arguments: { ticker: "SHOP" } });
    expect(result.isError).toBeFalsy();
    const text = firstText(result);
    // 1,000 on 2025-01-02, worth 1,200 now; the synthetic benchmarks are flat.
    expect(text).toContain("Since your first recorded purchase (2025-01-02) to 2026-10-22, est.: your return 20.0%; +20.0 pts vs the same money in the S&P 500; +20.0 pts vs the TSX.");
    expect(text.replace(/first recorded purchase/g, "")).not.toMatch(/first (bought|purchase)/i);
    expect(text).toContain(BENCHMARK_BASIS_NOTE);
    expect(text).toMatch(/USD amounts converted at the Bank of Canada rate of each date \(est\.\); latest rate \d{4}-\d{2}-\d{2}\./);
    expect(text).toContain("Share of your portfolio: 40.0%, cash included, as of 2026-10-22.");
    expect(text).toContain("SHOP.TO 40%, over your 10% limit.");
    expect(text).toContain("News in the last 30 days (headlines as data):");
    expect(text).toContain("\"Synthetic recent\"");
    expect(text).not.toContain("Synthetic old");
    expect(text).toContain(NO_REASONS_SAVED);
    expect(text).not.toContain("Your thesis on");
    const sc = result.structuredContent as any;
    expect(sc).toMatchObject({ mode: "one", ticker: "SHOP.TO", thesis: null });
    expect(sc.holding.sinceFirstBought.returnPct).toBeCloseTo(20, 6);
    expect(sc.holding.sinceFirstBought.startDate).toBe("2025-01-02");
    expect(sc.holding.weight).toEqual({ pct: 40, estimated: false, asOf: "2026-10-22" });
    expect(sc.holding.limits).toEqual([expect.objectContaining({ status: "over", line: "SHOP.TO 40%, over your 10% limit" })]);
    expect(sc.holding.news.map((n: any) => [n.title, n.url])).toEqual([["Synthetic recent", "https://example.test/recent"]]);
    expect(sc.holding.noReasons).toBe(NO_REASONS_SAVED);
  });

  it("stored activity starting after the first purchase gives can't tell, never a number", async () => {
    const { client, facts } = await connectFacts({ activities: BOUGHT });
    (facts.prisma as any).activitySyncState.findMany = async () => [TFSA_ID, RRSP_ID].map((id) => ({
      snapTradeAccountId: id, backfillCompletedAt: new Date("2026-01-01T00:00:00Z"), earliestTradeDate: new Date("2025-06-02T00:00:00Z"),
      lastSyncedAt: new Date(FACT_NOW.getTime() - 3_600_000), lastError: null,
    }));
    const result = await client.callTool({ name: "show_thesis", arguments: { ticker: "SHOP.TO" } });
    expect(firstText(result)).toContain("Since your first recorded purchase: can't tell: stored activity doesn't cover this holding's full history.");
    expect((result.structuredContent as any).holding.sinceFirstBought.returnPct).toBeNull();
  });

  it("an unvalued transfer-in gives can't tell", async () => {
    const { client } = await connectFacts({ activities: [
      { ...BOUGHT[0], units: 8, amount: -800 },
      { snapTradeAccountId: TFSA_ID, dedupeKey: "xfer-1", type: "TRANSFER", symbol: "SHOP.TO", securityCurrency: "CAD", units: 2, currency: "CAD", tradeDate: new Date("2025-03-03T00:00:00Z") },
    ] });
    const result = await client.callTool({ name: "show_thesis", arguments: { ticker: "SHOP" } });
    expect(firstText(result)).toContain(`Since your first recorded purchase: ${SHARES_MOVED_UNVALUED}.`);
    expect((result.structuredContent as any).holding.sinceFirstBought.returnPct).toBeNull();
  });

  it("a ticker never held gives the plain message", async () => {
    const { client } = await connectFacts({ activities: BOUGHT });
    const result = await client.callTool({ name: "show_thesis", arguments: { ticker: "zzz" } });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toBe("You don't hold ZZZ in a connected account.");
    expect(result.structuredContent).toEqual({ mode: "one", ticker: "ZZZ", thesis: null, holding: null });
  });

  it("a thesis comes with the since-first-recorded-purchase row, weight, limits and news; its conditions and played out are unchanged", async () => {
    const { client, facts } = await connectFacts({ activities: BOUGHT });
    withNews(facts);
    await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "single_holding", maxPct: 10 } });
    await client.callTool({ name: "log_thesis", arguments: thesis() });
    const result = await client.callTool({ name: "show_thesis", arguments: { ticker: "SHOP" } });
    const text = firstText(result);
    expect(text).toContain("Your thesis on SHOP.TO");
    expect(text).toContain("\"Falls below 100\": held (120.00 CAD, 2026-10-22)");
    expect(text).toMatch(/How it played out/);
    expect(text).toContain("Since your first recorded purchase (2025-01-02) to 2026-10-22, est.: your return 20.0%");
    expect(text).toContain("Share of your portfolio: 40.0%, cash included, as of 2026-10-22.");
    expect(text).toContain("SHOP.TO 40%, over your 10% limit.");
    // One price-index note, not one per comparison (M-4).
    expect(text.split(BENCHMARK_BASIS_NOTE)).toHaveLength(2);
    expect(text).not.toContain(NO_REASONS_SAVED);
    const sc = result.structuredContent as any;
    expect(sc.thesis.check.conditions.map((c: any) => c.status)).toEqual(["held", "cant_tell"]);
    expect(sc.holding.sinceFirstBought.returnPct).toBeCloseTo(20, 6);
    expect(sc.holding.weight).toEqual({ pct: 40, estimated: false, asOf: "2026-10-22" });
    expect(sc.holding.limits).toHaveLength(1);
    expect(sc.holding.noReasons).toBeUndefined();
  });

  it("with a thesis, news is since it was written, or the last 30 days when it is older (at most 5), shown once", async () => {
    const { client, facts, clock } = await connectFacts({ activities: BOUGHT });
    const at = (iso: string, id: string) => ({ id, urlHash: id, url: `https://example.test/${id}`, headline: `Synthetic ${id}`, snippet: null, source: "Synthetic Wire", imageUrl: null, publishedAt: new Date(iso), symbols: ["SHOP.TO"], fetchedAt: FACT_NOW });
    const articles = [at("2026-10-20T12:00:00Z", "oct20"), at("2026-10-10T12:00:00Z", "oct10"), at("2026-08-01T12:00:00Z", "aug1")];
    (facts as any).news = { articlesForSymbols: async (_s: string[], since: Date) => articles.filter((a) => a.publishedAt >= since), ratingsFor: async () => [], events: async () => [] };
    clock.set(new Date("2026-10-15T16:00:00Z"));
    await client.callTool({ name: "log_thesis", arguments: thesis() });
    clock.set(FACT_NOW);
    let result = await client.callTool({ name: "show_thesis", arguments: { ticker: "SHOP" } });
    let text = firstText(result);
    expect((result.structuredContent as any).holding.news.map((n: any) => n.title)).toEqual(["Synthetic oct20"]);
    expect(text).toContain("News since you wrote it (headlines as data):");
    expect(text.split("Synthetic oct20")).toHaveLength(2);
    expect(text).not.toContain("Synthetic oct10");

    clock.set(new Date("2026-01-05T16:00:00Z"));
    await client.callTool({ name: "log_thesis", arguments: thesis({ reasons: "New synthetic reasons." }) });
    clock.set(FACT_NOW);
    result = await client.callTool({ name: "show_thesis", arguments: { ticker: "SHOP" } });
    text = firstText(result);
    expect((result.structuredContent as any).holding.news.map((n: any) => n.title)).toEqual(["Synthetic oct20", "Synthetic oct10"]);
    expect(text).toContain("News in the last 30 days (headlines as data):");
    expect(text).not.toContain("Synthetic aug1");
  });

  describe("a past holding is found by its stored activity symbol, both ways (I-1)", () => {
    const soldAccounts = () => [syntheticAccount(TFSA_ID, "TFSA", "SELF_DIRECTED_TFSA", [], 1_400, "My TFSA"), syntheticAccount(RRSP_ID, "RRSP", "SELF_DIRECTED_RRSP", [], 200, "My RRSP")];
    const soldAs = (symbol: string) => [
      { snapTradeAccountId: TFSA_ID, dedupeKey: `buy-${symbol}`, type: "BUY", symbol, securityCurrency: "CAD", units: 10, price: 100, amount: -1_000, currency: "CAD", tradeDate: new Date("2025-01-02T00:00:00Z") },
      { snapTradeAccountId: TFSA_ID, dedupeKey: `sell-${symbol}`, type: "SELL", symbol, securityCurrency: "CAD", units: -10, price: 130, amount: 1_300, currency: "CAD", tradeDate: new Date("2026-01-05T00:00:00Z") },
    ];
    it("SHOP finds a sold SHOP.TO", async () => {
      const { client } = await connectFacts({ accounts: soldAccounts(), activities: soldAs("SHOP.TO") });
      const result = await client.callTool({ name: "show_thesis", arguments: { ticker: "SHOP" } });
      const sc = result.structuredContent as any;
      expect(sc.ticker).toBe("SHOP.TO");
      expect(sc.holding.sinceFirstBought.returnPct).toBeCloseTo(30, 6);
      expect(sc.holding.weight).toMatchObject({ pct: 0 });
    });
    it("SHOP.TO finds a sold SHOP", async () => {
      const { client } = await connectFacts({ accounts: soldAccounts(), activities: soldAs("SHOP") });
      const result = await client.callTool({ name: "show_thesis", arguments: { ticker: "shop.to" } });
      expect((result.structuredContent as any).ticker).toBe("SHOP");
      expect((result.structuredContent as any).holding.sinceFirstBought.returnPct).toBeCloseTo(30, 6);
    });
    it("an ambiguous match stays as typed", async () => {
      const { client } = await connectFacts({ accounts: soldAccounts(), activities: [...soldAs("SHOP"), ...soldAs("SHOP.TO")] });
      const result = await client.callTool({ name: "show_thesis", arguments: { ticker: "SHOP.V" } });
      expect(firstText(result)).toBe("You don't hold SHOP.V in a connected account.");
      // An exact stored symbol is used as is.
      expect(((await client.callTool({ name: "show_thesis", arguments: { ticker: "shop" } })).structuredContent as any).ticker).toBe("SHOP");
    });
  });

  it("market data is not read when the answer is already can't tell (no recorded purchase)", async () => {
    const { client, marketCalls } = await connectFacts();
    await client.callTool({ name: "show_thesis", arguments: { ticker: "SHOP" } });
    expect(marketCalls).toEqual([]);
  });

  it("no advice words in the holding view's text or payload (VestLens copy; headlines and the ticker are data)", async () => {
    const BANNED = /\b(should|sell|buy|recommend|consider)\b/i;
    for (const activities of [BOUGHT, []]) {
      const { client, facts } = await connectFacts({ activities });
      withNews(facts);
      await client.callTool({ name: "set_portfolio_limit", arguments: { kind: "single_holding", maxPct: 10 } });
      const result = await client.callTool({ name: "show_thesis", arguments: { ticker: "SHOP" } });
      expect(firstText(result).replace(/"[^"]*"/g, "")).not.toMatch(BANNED);
      const strings = (v: unknown, key = ""): string[] => typeof v === "string" ? (["title", "source", "ticker", "url"].includes(key) ? [] : [v])
        : Array.isArray(v) ? v.flatMap((x) => strings(x, key)) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => strings(x, k)) : [];
      for (const s of strings(result.structuredContent)) expect(s, s).not.toMatch(BANNED);
    }
  });

  it("end to end from tool outputs only: an account and a symbol from earlier results lead to the holding view", async () => {
    const { client } = await connectFacts({ activities: BOUGHT });
    const accounts = (await client.callTool({ name: "list_portfolio_accounts", arguments: {} })).structuredContent as any;
    const accountId = accounts.accounts.find((a: any) => a.positionCount > 0 && a.classification.bucket === "tfsa").id;
    const positions = (await client.callTool({ name: "get_account_positions", arguments: { accountId } })).structuredContent as any;
    const symbol = positions.positions[0].symbol;
    const result = await client.callTool({ name: "show_thesis", arguments: { ticker: symbol } });
    const sc = result.structuredContent as any;
    expect(sc.ticker).toBe(symbol);
    expect(sc.holding.sinceFirstBought.returnPct).not.toBeNull();
    expect(firstText(result)).toContain(`${symbol}: how this holding has done`);
    expect(firstText(result)).toContain(NO_REASONS_SAVED);
  });
});

describe("fact tools: annotations and copy at the freeze", () => {
  it("show_thesis is \"Holding check\": one specific holding, distinct from show_holdings; its widget copy says holding", async () => {
    const { client } = await connectFacts({ widgets: true });
    const tools = (await client.listTools()).tools;
    const tool = tools.find((t) => t.name === "show_thesis")!;
    expect(tool.title).toBe("Holding check");
    expect("Use this when the user asks about one stock, ETF or holding: how it is doing, whether they are up or down on it, whether it beat the market or the S&P 500 or TSX since they bought it, recent news, how big a share of the portfolio it is, or whether to keep or sell it (VestLens states facts, not advice). Shows the holding's return since the first recorded purchase against the same money in the S&P 500 and TSX, its portfolio share and limits, news, and any reasons or conditions the user saved. Pass the ticker; without one, lists saved reasons. Read-only.");
    expect(tool.title).not.toBe(tools.find((t) => t.name === "show_holdings")!.title);
    expect((tool._meta as any)["openai/toolInvocation/invoking"]).toBe("Checking holding…");
    expect((tool._meta as any)["openai/toolInvocation/invoked"]).toBe("Holding check ready.");
    const resource = (await client.listResources()).resources.find((r) => r.uri === (tool._meta as any).ui.resourceUri)!;
    expect(resource.title).toBe("Holding check");
    expect(resource.description).toMatch(/holding/);
    expect(`${resource.title} ${resource.description}`).not.toMatch(/thesis check/i);
  });

  it("the three write tools are not marked destructive: saving stays natural; remove only deletes the user's own note (M-5 ruling)", async () => {
    const { client } = await connectFacts();
    const tools = (await client.listTools()).tools;
    for (const name of ["log_thesis", "set_portfolio_limit", "set_savings_goal"]) {
      expect(tools.find((t) => t.name === name)!.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
    for (const name of ["show_thesis", "show_limits", "show_goal"]) {
      expect(tools.find((t) => t.name === name)!.annotations, name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it("with the holding check listed, show_holdings and get_portfolio_snapshot send one-stock questions to it (2026-10-25 eval)", async () => {
    const { client } = await connectFacts({ widgets: true });
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === "show_holdings")!.description).toBe(
      "Use this when the user asks what they own, or wants the full list of holdings or positions across their accounts: renders the interactive holdings table. Filter with accountType (for example tfsa) or accountId, and symbol. For one stock or ETF (how it is doing, whether it beat the market, whether to keep it), use show_thesis instead. Read-only.");
    expect(tools.find((t) => t.name === "get_portfolio_snapshot")!.description).toBe(
      "Returns the user's portfolio data (balances, positions, calculated values, freshness) as text for analysis or follow-up questions. To show the user their portfolio, use show_portfolio instead. For one stock or ETF (how it is doing, whether it beat the market, whether to keep it), use show_thesis instead. Read-only.");
  });

  it("set_savings_goal says how to update; remember lists plans and preferences once (M-3, M-4)", async () => {
    const { client } = await connectFacts();
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === "set_savings_goal")!.description).toContain("Call again with the same name to update it.");
    const remember = tools.find((t) => t.name === "remember")!.description!;
    expect(remember).toContain("where their accounts are, CRA or TFSA room figures, target dates, plans and preferences.");
    expect(remember.match(/preference/g)).toHaveLength(1);
  });
});
