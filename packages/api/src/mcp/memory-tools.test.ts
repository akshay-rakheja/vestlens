import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { BrokerageLinks } from "../memory/context-builder.js";
import { accountKey, activityKey, outsideAccountKey } from "../memory/keys.js";
import { MemoryService, type MemoryLogEvent } from "../memory/memory-service.js";
import { MemoryFactRepository } from "../testing/memory-fact-repository.js";
import { miniSyntheticAccount } from "../testing/mini-synthetic-fixtures.js";
import { MemoryNudgePrisma } from "../testing/memory-nudge-prisma.js";
import { NudgeService } from "../nudges/nudge-service.js";
import { MEMORY_RECONNECT_TEXT, memorySource, nodeKeySlug } from "./memory-tools.js";
import { createPortfolioMcpServer } from "./portfolio-mcp-server.js";

// Synthetic subjects, ids and text only.
const SUBJECT = "subject|synthetic-memory-tools";
const OTHER = "subject|synthetic-memory-other";
const ACCOUNT_ID = "synthetic-acct-1";
const DEDUPE = "synthetic-dedupe-1";
const MEMORY_TOOLS = ["remember", "recall", "forget"];

type TextBlock = { type: string; text: string };
const texts = (result: unknown) => ((result as { content?: TextBlock[] }).content ?? []).filter((b) => b.type === "text").map((b) => b.text);

const links: BrokerageLinks = {
  accountsHoldingSecurity: async () => [],
  tfsaAccounts: async () => [ACCOUNT_ID],
  accountIds: async (subject) => (subject === SUBJECT ? [ACCOUNT_ID] : []),
  activityDedupeKeys: async (subject) => (subject === SUBJECT ? [DEDUPE] : []),
};

async function connect(o: { scopes?: string[]; repository?: MemoryFactRepository; subject?: string; clientKey?: string; log?: (e: MemoryLogEvent) => void; nudges?: NudgeService } = {}) {
  const repository = o.repository ?? new MemoryFactRepository();
  const service = new MemoryService({ repository, links, log: o.log ?? (() => {}), now: () => new Date("2026-10-24T16:00:00Z") });
  const portfolio = { getPortfolio: vi.fn(async () => ({ connectionRequired: false, generatedAt: "2026-10-24T12:00:00.000Z", accounts: [miniSyntheticAccount(0)], errors: [] })) };
  const server = createPortfolioMcpServer({
    authSubject: o.subject ?? SUBJECT,
    scopes: o.scopes ?? ["portfolio:read", "memory"],
    portfolio,
    history: { getAccountHistory: vi.fn(async () => ({})) },
    memory: { service, links },
    ...(o.nudges ? { nudges: o.nudges } : {}),
    clientKey: o.clientKey ?? "https://claude.ai/oauth/mcp-oauth-client-metadata",
  } as never);
  const client = new Client({ name: "synthetic-host", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, repository, portfolio, service };
}

const cra = (amountCad: unknown = 7000, provenance = "stated") => ({
  node: { type: "tax_year", key: "2026:tfsa" }, property: "tax_year.cra_room_jan1", value: { amountCad },
  text: "TFSA room on 1 January 2026 was $7,000.", kind: "fact", provenance,
});

describe("memory tools: listing", () => {
  it("are listed in normal mode with memory deps, after the existing tools", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.slice(-3)).toEqual(MEMORY_TOOLS);
    expect(names.slice(0, 5)).toEqual(["get_portfolio_snapshot", "list_portfolio_accounts", "get_account_positions", "get_account_history", "show_portfolio"]);
  });

  it("remember's description carries the saving rules", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const remember = tools.find((t) => t.name === "remember")!;
    expect(remember.description).toMatch(/without asking/);
    expect(remember.description).toMatch(/stated/);
    expect(remember.description).toMatch(/inferred/);
    expect(remember.description).toMatch(/1 January/);
    expect(remember.description).toMatch(/only when it changes a number/);
    expect(remember.description).toMatch(/other people/);
    expect((remember.inputSchema as any).properties.provenance.enum).toEqual(["stated", "inferred"]);
    expect(remember.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tools.find((t) => t.name === "forget")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find((t) => t.name === "recall")!.annotations).toMatchObject({ readOnlyHint: true });
  });
});

describe("remember defers theses, limits and goals to their tools", () => {
  it("rejects each dedicated property with plain text naming the tool, and saves nothing", async () => {
    const { client, repository } = await connect();
    const cases = [
      [{ node: { type: "security", key: "SHOP" }, property: "security.thesis", value: { reasons: "r", timeFrame: null, writtenAt: "2020-01-01T00:00:00.000Z" } }, "Not saved: Use log_thesis to save a thesis."],
      [{ node: { type: "security", key: "SHOP" }, property: "security.thesis_baseline", value: {} }, "Not saved: VestLens records that itself when log_thesis saves a thesis."],
      [{ node: { type: "rule", key: "single-holding-any" }, property: "rule.concentration_limit", value: { kind: "single_holding", maxPct: 10 } }, "Not saved: Use set_portfolio_limit to save a limit."],
      [{ node: { type: "goal", key: "house" }, property: "goal.savings_target", value: { name: "House", targetCad: 1, targetDate: "2030-01-01", accounts: ["outside:x"] } }, "Not saved: Use set_savings_goal to save a savings goal."],
    ] as const;
    for (const [fact, text] of cases) {
      const result = await client.callTool({ name: "remember", arguments: { ...fact, text: "Synthetic.", kind: "plan", provenance: "stated" } as never });
      expect(result.isError, fact.property).toBe(true);
      expect(texts(result), fact.property).toEqual([text]);
    }
    expect(repository.rows).toHaveLength(0);
  });

  it("its description no longer asks for buy reasons and points to the dedicated tools", async () => {
    const { client } = await connect();
    const remember = (await client.listTools()).tools.find((t) => t.name === "remember")!;
    expect(remember.description).not.toContain("why they bought something");
    expect(remember.description).toContain("For reasons for owning a stock, limits and savings goals use log_thesis, set_portfolio_limit and set_savings_goal.");
  });
});

describe("memory tools: gates", () => {

  it("a token without memory gets the plain reconnect message from all three, never an error", async () => {
    const { client, repository } = await connect({ scopes: ["portfolio:read"] });
    for (const [name, args] of [["remember", cra()], ["recall", {}], ["forget", { id: "x" }]] as const) {
      const result = await client.callTool({ name, arguments: args as never });
      expect(result.isError, name).toBeFalsy();
      expect(texts(result), name).toEqual([MEMORY_RECONNECT_TEXT]);
    }
    expect(MEMORY_RECONNECT_TEXT).toBe("Reconnect VestLens to let it remember things.");
    expect(repository.rows).toHaveLength(0);
  });
});

describe("remember", () => {
  it("saves a stated fact sourced to the calling app, and a second save supersedes it", async () => {
    const { client, repository } = await connect();
    const first = await client.callTool({ name: "remember", arguments: cra(6000) });
    expect(first.isError).toBeFalsy();
    expect(texts(first)[0]).toMatch(/^Saved/);
    await client.callTool({ name: "remember", arguments: cra(7000) });
    const current = repository.rows.filter((r) => r.supersededAt === null);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ subject: SUBJECT, value: { amountCad: 7000 }, provenance: "stated", source: "claude" });
  });

  it("a malformed reserved write returns the validation message as text (isError, never an error code)", async () => {
    const { client, repository } = await connect();
    const result = await client.callTool({ name: "remember", arguments: cra(-5) });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toBe("Not saved: Invalid value for tax_year.cra_room_jan1: expected { amountCad: number >= 0 }, the room on 1 January.");
    const noText = await client.callTool({ name: "remember", arguments: { ...cra(), text: "" } });
    expect(noText.isError).toBe(true);
    expect(texts(noText)[0]).toBe("Not saved: Text is required: the fact in plain words.");
    expect(repository.rows).toHaveLength(0);
  });

  it("rejects derived and imported provenance from an assistant", async () => {
    const { client, repository } = await connect();
    for (const provenance of ["derived", "imported"]) {
      const result = await client.callTool({ name: "remember", arguments: cra(7000, provenance) });
      expect(result.isError).toBe(true);
      expect(texts(result)[0]).toBe("Not saved: Only stated or inferred facts can be saved here.");
    }
    expect(repository.rows).toHaveLength(0);
  });

  it("checks that an account node is one of the caller's accounts or an outside account", async () => {
    const { client, repository } = await connect();
    const note = (key: string) => ({ node: { type: "account", key }, property: "account.note", value: null, text: "Synthetic note.", kind: "note", provenance: "stated" });
    expect(texts(await client.callTool({ name: "remember", arguments: note(accountKey(ACCOUNT_ID)) }))[0]).toMatch(/^Saved/);
    expect(texts(await client.callTool({ name: "remember", arguments: note(outsideAccountKey("Other bank")) }))[0]).toMatch(/^Saved/);
    const foreign = await client.callTool({ name: "remember", arguments: note(accountKey("synthetic-someone-else")) });
    expect(texts(foreign)[0]).toBe("Not saved: That account isn't one of the user's connected accounts. Use an accountKey from get_contribution_room, or outside:<name> for an account elsewhere.");
    expect(repository.rows).toHaveLength(2);
  });

  it("checks that an activity node exists in the caller's stored activity", async () => {
    const { client } = await connect();
    const effect = (key: string) => ({ node: { type: "activity", key }, property: "activity.room_effect", value: { effect: "none" }, text: "Not a contribution.", kind: "fact", provenance: "stated" });
    expect(texts(await client.callTool({ name: "remember", arguments: effect(activityKey(DEDUPE)) }))[0]).toMatch(/^Saved/);
    const missing = await client.callTool({ name: "remember", arguments: effect(activityKey("synthetic-not-stored")) });
    expect(texts(missing)[0]).toBe("Not saved: That activity isn't in the user's stored activity. Use an activityKey from get_contribution_room.");
  });

  it("another subject cannot attach facts to this subject's account or activity", async () => {
    const { client } = await connect({ subject: OTHER });
    const result = await client.callTool({ name: "remember", arguments: { node: { type: "account", key: accountKey(ACCOUNT_ID) }, property: "account.note", text: "Synthetic.", kind: "note", provenance: "stated" } });
    expect(texts(result)[0]).toMatch(/^Not saved: That account isn't/);
  });

  it("checks that a security key is a plausible ticker, upper-cased", async () => {
    const { client, repository } = await connect();
    const reason = (key: string) => ({ node: { type: "security", key }, property: "security.reason", text: "Bought for the long term.", kind: "reason", provenance: "stated" });
    expect(texts(await client.callTool({ name: "remember", arguments: reason("xeqt.to") }))[0]).toMatch(/^Saved/);
    expect(repository.rows[0]!.nodeKey).toBe("XEQT.TO");
    for (const bad of ["123", "SHOP:US:EXTRA_LONG_TICKER_XX", "a_b"]) {
      expect(texts(await client.callTool({ name: "remember", arguments: reason(bad) }))[0], bad).toMatch(/^Not saved: /);
    }
    expect(repository.rows).toHaveLength(1);
  });

  it("slugs sector names to the node-key format", async () => {
    const { client, repository } = await connect();
    const result = await client.callTool({ name: "remember", arguments: { node: { type: "sector", key: "Information Technology" }, property: "sector.note", text: "Keep tech under a quarter.", kind: "note", provenance: "inferred" } });
    expect(texts(result)[0]).toMatch(/^Saved/);
    expect(repository.rows[0]).toMatchObject({ nodeType: "sector", nodeKey: "information-technology", provenance: "inferred" });
    expect(nodeKeySlug("Consumer Discretionary & Staples")).toBe("consumer-discretionary-staples");
  });

  it("logs counts and constant codes only, never text, values or keys", async () => {
    const events: MemoryLogEvent[] = [];
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { client } = await connect({ log: (e) => events.push(e) });
    await client.callTool({ name: "remember", arguments: { ...cra(), text: "SYNTHETIC-SECRET-TEXT" } });
    await client.callTool({ name: "recall", arguments: { text: "SYNTHETIC-SECRET-TEXT" } });
    const logged = JSON.stringify([events, info.mock.calls, log.mock.calls]);
    info.mockRestore();
    log.mockRestore();
    expect(logged).not.toContain("SYNTHETIC-SECRET-TEXT");
    expect(logged).not.toContain("7000");
    expect(logged).not.toContain(SUBJECT);
  });
});

describe("remember: account_set keys must be the user's accounts", () => {
  const set = (connected: string[]) => ({
    node: { type: "tax_year", key: "2026:tfsa" }, property: "tax_year.account_set",
    value: { connected, outside: [], confirmedAt: "2026-10-24T15:00:00.000Z" }, text: "My TFSAs.", kind: "fact", provenance: "stated",
  });

  it("rejects a connected key that isn't among the subject's stored accounts, and saves nothing", async () => {
    const { client, repository } = await connect();
    const result = await client.callTool({ name: "remember", arguments: set([accountKey(ACCOUNT_ID), accountKey("synthetic-acct-invented")]) });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toBe("Not saved: That account key isn't one of your accounts.");
    expect(repository.rows).toHaveLength(0);
    // Another subject's account is not this subject's either.
    const other = await connect({ subject: OTHER });
    expect(texts(await other.client.callTool({ name: "remember", arguments: set([accountKey(ACCOUNT_ID)]) }))[0]).toBe("Not saved: That account key isn't one of your accounts.");
  });

  it("accepts the subject's own keys, and keeps a confirmed key that has since disconnected when re-confirming", async () => {
    const { client, repository } = await connect();
    expect(texts(await client.callTool({ name: "remember", arguments: set([accountKey(ACCOUNT_ID)]) }))[0]).toMatch(/^Saved/);
    // A set confirmed (stated) earlier with a key that is no longer stored can be saved again with that key.
    const gone = accountKey("synthetic-acct-gone");
    await repository.supersedeAndInsert({
      subject: SUBJECT, nodeType: "tax_year", nodeKey: "2026:tfsa", property: "tax_year.account_set",
      value: { connected: [accountKey(ACCOUNT_ID), gone], outside: [], confirmedAt: "2026-02-01T15:00:00.000Z", notTfsa: [] }, text: "Earlier.", kind: "fact",
      provenance: "stated", validFrom: new Date(Date.UTC(2026, 0, 1)), validTo: null, recordedAt: new Date("2026-02-01T15:00:00Z"), source: "claude",
    }, { sameValidFrom: true });
    expect(texts(await client.callTool({ name: "remember", arguments: set([accountKey(ACCOUNT_ID), gone]) }))[0]).toMatch(/^Saved/);
  });
});

describe("outside-account keys", () => {
  it("normalises assistant-style outside labels to the engine's key, for remember, recall and forget", async () => {
    const { client, repository } = await connect();
    const ytd = (key: string, amountCad: number) => ({ node: { type: "account", key }, property: "account.ytd_contributions", value: { year: 2026, amountCad, asOf: "2026-09-30" }, text: "Synthetic.", kind: "fact", provenance: "stated" });
    for (const [raw, amount] of [["outside:Questrade TFSA", 100], ["outside:Questrade-TFSA", 200], ["outside:questrade tfsa", 300], ["outside:questrade-tfsa", 400]] as const) {
      expect(texts(await client.callTool({ name: "remember", arguments: ytd(raw, amount) }))[0], raw).toMatch(/^Saved/);
    }
    const current = repository.rows.filter((r) => r.supersededAt === null);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ nodeKey: outsideAccountKey("Questrade TFSA"), value: { amountCad: 400 } });
    expect(outsideAccountKey("Questrade TFSA")).toBe("outside:questrade-tfsa");
    const recalled = await client.callTool({ name: "recall", arguments: { node: { type: "account", key: "outside:QUESTRADE TFSA" } } });
    expect((recalled.structuredContent as any).facts).toHaveLength(1);
    expect(texts(await client.callTool({ name: "forget", arguments: { node: { type: "account", key: "outside:Questrade  TFSA" }, property: "account.ytd_contributions" } }))[0]).toBe("Forgot 4 entries.");
  });

  it("an account_set's outside labels drop an outside: prefix, so the set and the figure meet on one key", async () => {
    const { client, repository } = await connect();
    const set = { node: { type: "tax_year", key: "2026:tfsa" }, property: "tax_year.account_set", text: "Synthetic.", kind: "fact", provenance: "stated",
      value: { connected: [accountKey(ACCOUNT_ID)], outside: [{ label: "outside:Questrade TFSA" }, { label: "Other bank" }], confirmedAt: "2026-10-24T15:00:00.000Z" } };
    expect(texts(await client.callTool({ name: "remember", arguments: set }))[0]).toMatch(/^Saved/);
    const labels = (repository.rows[0]!.value as { outside: Array<{ label: string }> }).outside.map((o) => o.label);
    expect(labels).toEqual(["Questrade TFSA", "Other bank"]);
    expect(labels.map(outsideAccountKey)).toEqual(["outside:questrade-tfsa", "outside:other-bank"]);
  });
});

describe("memorySource", () => {
  it("names the calling app from its client key", () => {
    expect(memorySource("https://claude.ai/oauth/mcp-oauth-client-metadata")).toBe("claude");
    expect(memorySource("https://chatgpt.com/connector/oauth/abc")).toBe("chatgpt");
    expect(memorySource("mcp:https://vestlens.example/")).toBe("assistant");
    expect(memorySource(undefined)).toBe("assistant");
  });
});

describe("recall and forget", () => {
  it("returns current facts with age, provenance and hop, newest first, and marks inferred ones", async () => {
    const { client } = await connect();
    await client.callTool({ name: "remember", arguments: cra() });
    await client.callTool({ name: "remember", arguments: { node: { type: "user", key: "me" }, property: "user.risk_comfort", value: "cautious", text: "Seems cautious about tech.", kind: "note", provenance: "inferred" } });
    const result = await client.callTool({ name: "recall", arguments: {} });
    const facts = (result.structuredContent as { facts: Array<Record<string, unknown>> }).facts;
    expect(facts).toHaveLength(2);
    const inferred = facts.find((f) => f.property === "user.risk_comfort");
    expect(inferred).toMatchObject({ provenance: "inferred", ageDays: 0, hop: 0 });
    for (const f of facts) expect(f).not.toHaveProperty("subject");
    expect(texts(result)[0]).toMatch(/inferred/);
    expect(texts(result)[0]).toMatch(/Seems cautious about tech\./);
    expect(texts(result)[0]).toMatch(/today/);
  });

  it("recall by node includes one-hop facts; another subject sees nothing", async () => {
    const { client, repository } = await connect();
    await client.callTool({ name: "remember", arguments: { node: { type: "account", key: accountKey(ACCOUNT_ID) }, property: "account.note", text: "Synthetic TFSA note.", kind: "note", provenance: "stated" } });
    const result = await client.callTool({ name: "recall", arguments: { node: { type: "tax_year", key: "2026:tfsa" } } });
    expect((result.structuredContent as any).facts).toMatchObject([{ property: "account.note", hop: 1 }]);
    const other = await connect({ subject: OTHER, repository });
    const none = await other.client.callTool({ name: "recall", arguments: {} });
    expect((none.structuredContent as any).facts).toEqual([]);
    expect(texts(none)[0]).toBe("Nothing saved matches.");
  });

  it("forget by id and by node and property both delete the fact with its history; invalid input is plain text", async () => {
    const { client, repository } = await connect();
    await client.callTool({ name: "remember", arguments: cra(6000) });
    await client.callTool({ name: "remember", arguments: cra(7000) });
    const id = repository.rows.find((r) => r.supersededAt === null)!.id;
    expect(texts(await client.callTool({ name: "forget", arguments: { id } }))[0]).toBe("Forgot 2 entries.");
    expect(repository.rows).toHaveLength(0);
    expect(texts(await client.callTool({ name: "forget", arguments: { node: { type: "tax_year", key: "2026:tfsa" }, property: "tax_year.cra_room_jan1" } }))[0]).toBe("No such memory entry.");
    expect(texts(await client.callTool({ name: "forget", arguments: { id } }))[0]).toBe("No such memory entry.");
    const missing = await client.callTool({ name: "forget", arguments: { id } });
    expect(missing.isError).toBeFalsy();
    const bad = await client.callTool({ name: "forget", arguments: {} });
    expect(bad.isError).toBe(true);
    expect(texts(bad)[0]).toBe("Say what to forget: an id from recall, or a node and property.");
  });

  it("forget cannot reach another subject's entries", async () => {
    const { client, repository } = await connect();
    await client.callTool({ name: "remember", arguments: cra() });
    const id = repository.rows[0]!.id;
    const other = await connect({ subject: OTHER, repository });
    expect(texts(await other.client.callTool({ name: "forget", arguments: { id } }))[0]).toBe("No such memory entry.");
    expect(repository.rows).toHaveLength(1);
  });
});

describe("forget by id removes the fact's earlier versions too", () => {
  it("matches the dashboard: neither version remains in recall with history", async () => {
    const repository = new MemoryFactRepository();
    const { client } = await connect({ repository });
    const service = new MemoryService({ repository, links, log: () => {}, now: () => new Date("2026-10-24T16:00:00Z") });
    await service.remember(SUBJECT, { node: { type: "security", key: "SYN" }, property: "security.reason", value: null, text: "First wording.", kind: "reason", provenance: "stated" });
    const second = await service.remember(SUBJECT, { node: { type: "security", key: "SYN" }, property: "security.reason", value: null, text: "Second wording.", kind: "reason", provenance: "stated" });
    expect(texts(await client.callTool({ name: "forget", arguments: { id: second.fact.id } }))[0]).toBe("Forgot 2 entries.");
    expect(await service.recall(SUBJECT, { includeHistory: true })).toEqual([]);
    const tool = (await client.listTools()).tools.find((t) => t.name === "forget")!;
    expect(tool.description).toMatch(/earlier versions/i);
  });
});

describe("forget a thesis or a limit cleans up after it (follow-up ruling 2)", () => {
  const NOW = new Date("2026-10-24T16:00:00Z");
  const nudgeRow = (id: string, subject: string, kind: "thesis_condition" | "limit", target: string, conditionId: string) => ({
    id, subject, kind, target, conditionId, basis: "b", text: "Synthetic nudge.", raisedAt: NOW, updatedAt: NOW, clearedAt: null as Date | null,
  });
  const withNudges = async () => {
    const prisma = new MemoryNudgePrisma();
    const repository = new MemoryFactRepository();
    const nudges = new NudgeService({ prisma, memory: repository as never, portfolio: async () => { throw new Error("no portfolio read expected"); }, market: { usdCad: async () => [] } as never, now: () => NOW });
    return { prisma, ...(await connect({ repository, nudges })) };
  };
  const saveThesis = async (service: MemoryService) => {
    const thesis = await service.remember(SUBJECT, { node: { type: "security", key: "SYN" }, property: "security.thesis", value: { reasons: "Synthetic.", timeFrame: null }, text: "Thesis on SYN: Synthetic.", kind: "reason", provenance: "stated", source: "claude" } as never, NOW);
    await service.remember(SUBJECT, {
      node: { type: "security", key: "SYN" }, property: "security.thesis_baseline", kind: "fact", provenance: "derived", text: "Value of SYN recorded when the thesis was saved.",
      value: { writtenAt: NOW.toISOString(), positionsAsOf: NOW.toISOString(), valueCad: 100, units: 1, priceNative: 100, currency: "CAD", accountsSeen: [], accountsAsOf: {} },
    } as never, NOW, "system");
    return thesis;
  };

  for (const how of ["id", "node"] as const) {
    it(`forgetting a thesis by ${how} also forgets its baseline and clears its nudges, with no portfolio read`, async () => {
      const { client, service, prisma, portfolio } = await withNudges();
      const thesis = await saveThesis(service);
      prisma.rows.push(nudgeRow("n1", SUBJECT, "thesis_condition", "SYN", "c1"), nudgeRow("n2", SUBJECT, "thesis_condition", "OTHER", "c1"), nudgeRow("n3", OTHER, "thesis_condition", "SYN", "c1"));
      const args = how === "id" ? { id: thesis.fact.id } : { node: { type: "security", key: "SYN" }, property: "security.thesis" };
      const result = await client.callTool({ name: "forget", arguments: args });
      expect(result.isError).toBeFalsy();
      expect((await service.listForExport(SUBJECT)).map((f) => f.property)).toEqual([]);
      expect(prisma.rows.filter((r) => r.clearedAt !== null).map((r) => r.id)).toEqual(["n1"]);
      expect(portfolio.getPortfolio).not.toHaveBeenCalled();
    });
  }

  it("forgetting a limit clears that limit's nudges only", async () => {
    const { client, service, prisma } = await withNudges();
    await service.remember(SUBJECT, { node: { type: "rule", key: "single-holding-syn" }, property: "rule.concentration_limit", value: { kind: "single_holding", target: "SYN", maxPct: 10 }, kind: "plan", text: "Limit: no more than 10% in SYN.", provenance: "stated", source: "claude" } as never, NOW);
    prisma.rows.push(nudgeRow("l1", SUBJECT, "limit", "single-holding-syn", "SYN|CAD"), nudgeRow("l2", SUBJECT, "limit", "sector-tech", "Technology"));
    await client.callTool({ name: "forget", arguments: { node: { type: "rule", key: "single-holding-syn" }, property: "rule.concentration_limit" } });
    expect(prisma.rows.filter((r) => r.clearedAt !== null).map((r) => r.id)).toEqual(["l1"]);
  });

  it("forgetting something else touches no nudge; nothing found clears nothing", async () => {
    const { client, service, prisma } = await withNudges();
    const note = await service.remember(SUBJECT, { node: { type: "security", key: "SYN" }, property: "security.reason", value: null, text: "Unrelated.", kind: "reason", provenance: "stated", source: "claude" } as never, NOW);
    prisma.rows.push(nudgeRow("n1", SUBJECT, "thesis_condition", "SYN", "c1"));
    await client.callTool({ name: "forget", arguments: { id: note.fact.id } });
    await client.callTool({ name: "forget", arguments: { node: { type: "security", key: "SYN" }, property: "security.thesis" } });
    expect(prisma.rows[0]!.clearedAt).toBeNull();
  });
});
