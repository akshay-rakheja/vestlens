import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { connectFacts, firstText } from "../testing/fact-tools-harness.js";
import { miniSyntheticAccount } from "../testing/mini-synthetic-fixtures.js";
import { ROOM_INPUT_PROPERTIES } from "./memory-tools.js";
import { focusedInstructions } from "./playbook.js";
import { createPortfolioMcpServer, PARKED_TOOLS } from "./portfolio-mcp-server.js";

// The focused surface /mcp serves (moat evaluation, 2026-10-25). Synthetic subjects and amounts only.
const ALL_TOOL_NAMES_FULL = async () => (await (await connectFacts({ widgets: true })).client.listTools()).tools.map((t) => t.name);

describe("focused surface", () => {
  it("lists no parked tool, keeps the room input, holding check and limit tools", async () => {
    const { client } = await connectFacts({ widgets: true, surface: "focused" });
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const parked of PARKED_TOOLS) expect(names).not.toContain(parked);
    for (const kept of ["remember", "show_thesis", "set_portfolio_limit", "show_limits", "show_holdings", "get_portfolio_snapshot"]) expect(names).toContain(kept);
  });

  it("no listed description or the instructions name a tool that isn't listed", async () => {
    const full = await ALL_TOOL_NAMES_FULL();
    const { client } = await connectFacts({ widgets: true, surface: "focused" });
    const tools = (await client.listTools()).tools;
    const listed = new Set(tools.map((t) => t.name));
    const unlisted = full.filter((n) => !listed.has(n));
    expect(unlisted.length).toBeGreaterThan(0);
    for (const text of [client.getInstructions() ?? "", ...tools.map((t) => t.description ?? "")]) {
      for (const name of unlisted) expect(text).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it("remember offers and accepts contribution room inputs only, stated only", async () => {
    const { client, repository } = await connectFacts({ surface: "focused" });
    const remember = (await client.listTools()).tools.find((t) => t.name === "remember")!;
    expect(remember.title).toBe("Save contribution room inputs");
    expect((remember.inputSchema as any).properties.property.enum).toEqual([...ROOM_INPUT_PROPERTIES]);
    expect((remember.inputSchema as any).properties.provenance.enum).toEqual(["stated"]);
    const other = await client.callTool({ name: "remember", arguments: { node: { type: "user", key: "me" }, property: "user.preference", text: "Prefers ETFs.", kind: "preference", provenance: "stated" } });
    expect(other.isError).toBe(true);
    expect(firstText(other)).toMatch(/^Not saved: VestLens saves contribution room inputs here only/);
    expect(repository.rows).toHaveLength(0);
    const room = await client.callTool({ name: "remember", arguments: { node: { type: "tax_year", key: "2026:tfsa" }, property: "tax_year.cra_room_jan1", value: { amountCad: 7000 }, text: "TFSA room of $7,000 on 1 January 2026, from CRA My Account.", kind: "fact", provenance: "stated" } });
    expect(firstText(room)).toMatch(/^Saved as stated/);
    expect(repository.rows).toHaveLength(1);
  });

  it("remember's property enum includes account.tfsa_moves, and saves dated outside moves", async () => {
    const { client, repository } = await connectFacts({ surface: "focused" });
    const remember = (await client.listTools()).tools.find((t) => t.name === "remember")!;
    expect((remember.inputSchema as any).properties.property.enum).toContain("account.tfsa_moves");
    expect(remember.description).toContain("account.ytd_contributions is this year's contributions to a connected account; for an outside account use account.tfsa_moves on outside:<label>, which lists dated deposits and withdrawals at that institution this year");
    expect((remember.inputSchema as any).properties.value.description).toContain("tfsa_moves { year, entries: [{ date: YYYY-MM-DD, amountCad, kind: \"deposit\" | \"withdrawal\" }] }");
    const saved = await client.callTool({ name: "remember", arguments: {
      node: { type: "account", key: "outside:synthetic-bank" }, property: "account.tfsa_moves",
      value: { year: 2026, entries: [{ date: "2026-03-01", amountCad: 500, kind: "deposit" }, { date: "2026-04-01", amountCad: 100, kind: "withdrawal" }] },
      text: "Deposited $500 on 1 March and withdrew $100 on 1 April 2026 at a synthetic bank TFSA.", kind: "fact", provenance: "stated",
    } });
    expect(firstText(saved)).toMatch(/^Saved as stated/);
    expect(repository.rows).toHaveLength(1);
  });

  it("remember offers the three RRSP inputs on <year>:rrsp and saves one as stated", async () => {
    const { client, repository } = await connectFacts({ surface: "focused" });
    const remember = (await client.listTools()).tools.find((t) => t.name === "remember")!;
    const props = ["tax_year.rrsp_deduction_limit", "tax_year.rrsp_unused_contributions", "tax_year.rrsp_elsewhere"];
    for (const p of props) expect((remember.inputSchema as any).properties.property.enum).toContain(p);
    expect(remember.description).toContain("tax_year.rrsp_deduction_limit on <year>:rrsp is the RRSP deduction limit for that year from CRA My Account or the notice of assessment (store it as CRA shows it); tax_year.rrsp_unused_contributions on the same key is the unused RRSP contributions CRA shows; tax_year.rrsp_elsewhere is that tax year's contributions to RRSPs VestLens doesn't count (group RRSPs at work, other institutions, managed RRSPs, and contributions the user made to a spousal RRSP for their spouse).");
    expect((remember.inputSchema as any).properties.node.properties.key.description).toContain("<year>:rrsp for the RRSP");
    expect((remember.inputSchema as any).properties.value.description).toContain("rrsp_elsewhere { amountCad }");
    expect((remember.inputSchema as any).properties.value.description).toContain("room_effect { effect: \"contribution\" | \"withdrawal\" | \"none\" } (contribution: new money into a TFSA, FHSA or RRSP; withdrawal: money taken out of those accounts; none: moved between the user's own accounts of the same kind, or a transfer from their FHSA to their RRSP)");
    const args = { node: { type: "tax_year", key: "2026:rrsp" }, property: "tax_year.rrsp_deduction_limit", value: { amountCad: 31560 }, text: "RRSP deduction limit of $31,560 for 2026, from CRA.", kind: "fact" };
    expect((await client.callTool({ name: "remember", arguments: { ...args, provenance: "inferred" } })).isError).toBe(true);
    expect((await client.callTool({ name: "remember", arguments: { ...args, node: { type: "tax_year", key: "2026:tfsa" }, provenance: "stated" } })).isError).toBe(true);
    expect(repository.rows).toHaveLength(0);
    expect(firstText(await client.callTool({ name: "remember", arguments: { ...args, provenance: "stated" } }))).toMatch(/^Saved as stated/);
    expect(repository.rows).toHaveLength(1);
  });

  it("remember offers tax_year.fhsa_room on <year>:fhsa, stated only, and saves it", async () => {
    const { client, repository } = await connectFacts({ surface: "focused" });
    const remember = (await client.listTools()).tools.find((t) => t.name === "remember")!;
    expect((remember.inputSchema as any).properties.property.enum).toContain("tax_year.fhsa_room");
    expect(remember.description).toContain("tax_year.fhsa_room on <year>:fhsa is the year's FHSA participation room from CRA My Account or the notice of assessment");
    expect((remember.inputSchema as any).properties.value.description).toContain("fhsa_room { amountCad }");
    expect((remember.inputSchema as any).properties.node.properties.key.description).toContain("<year>:fhsa");
    const args = { node: { type: "tax_year", key: "2026:fhsa" }, property: "tax_year.fhsa_room", value: { amountCad: 8000 }, text: "FHSA participation room of $8,000 for 2026, from CRA.", kind: "fact" };
    const inferred = await client.callTool({ name: "remember", arguments: { ...args, provenance: "inferred" } });
    expect(inferred.isError).toBe(true);
    expect(repository.rows).toHaveLength(0);
    const wrongNode = await client.callTool({ name: "remember", arguments: { ...args, node: { type: "tax_year", key: "2026:tfsa" }, provenance: "stated" } });
    expect(wrongNode.isError).toBe(true);
    const saved = await client.callTool({ name: "remember", arguments: { ...args, provenance: "stated" } });
    expect(firstText(saved)).toMatch(/^Saved as stated/);
    expect(repository.rows).toHaveLength(1);
  });

  it("a parked tool can't be called", async () => {
    const { client } = await connectFacts({ surface: "focused" });
    for (const name of ["recall", "log_thesis", "set_savings_goal"]) {
      await expect(client.callTool({ name, arguments: {} })).rejects.toThrow();
    }
  });

  it("the default surface is unchanged: every tool is listed", async () => {
    const names = await ALL_TOOL_NAMES_FULL();
    for (const parked of PARKED_TOOLS) expect(names).toContain(parked);
  });
});

describe("focused surface: the routing playbook (spec D7)", () => {
  // The everything-enabled harness on the focused surface, mirroring portfolio-mcp-server.test.ts's flag-off dump:
  // every dep (news, calendar, alerts, memory, room, facts and the report card) with stub builds and dependencies.
  // Registration only: no tool is called. Synthetic accounts only.
  const SNAPSHOT_ORIGIN = "https://vestlens.example";
  const snapshotBuild = (name: string) => `<!doctype html><head><script type="module" crossorigin>console.log(${JSON.stringify(name)})</script><style rel="stylesheet" crossorigin>.${name}{}</style></head><body><div id="app"></div></body>`;
  const everything = { overview: {}, performance: {}, activity: {}, holdings: {}, allocation: {}, income: {}, news: { publicOrigin: SNAPSHOT_ORIGIN }, calendar: {}, alerts: {}, memory: {}, room: {}, portfolioFacts: {}, reportCard: {} };

  async function connectFocused(deps: Record<string, unknown>) {
    const portfolio = { getPortfolio: vi.fn(async () => ({ connectionRequired: false, generatedAt: "2026-10-14T12:00:00.000Z", accounts: [miniSyntheticAccount(0), miniSyntheticAccount(1, { currency: "USD" })], errors: [] })) };
    const server = createPortfolioMcpServer({
      authSubject: "subject|synthetic-focused-subject", portfolio, history: { getAccountHistory: vi.fn(async () => ({})) },
      assets: { html: snapshotBuild }, surface: "focused", ...deps,
    } as never);
    const client = new Client({ name: "synthetic-host", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }
  const modelVisible = (tools: Array<{ name: string; _meta?: unknown }>) =>
    tools.filter((t) => !((t._meta as { ui?: { visibility?: string[] } } | undefined)?.ui?.visibility?.every((v) => v === "app"))).map((t) => t.name);

  it("tools/list and the instructions match the committed focused fixture", async () => {
    const client = await connectFocused(everything);
    const tools = await client.listTools();
    await expect(`${JSON.stringify({ tools, instructions: client.getInstructions() }, null, 2)}\n`)
      .toMatchFileSnapshot("./__fixtures__/portfolio-mcp-focused.json");
  });

  it("is the playbook for the listed model-visible tools: every show_ tool, room, accountType, under 2,000 characters", async () => {
    const client = await connectFocused(everything);
    const tools = (await client.listTools()).tools;
    const visible = modelVisible(tools);
    const instructions = client.getInstructions()!;
    expect(instructions).toBe(focusedInstructions(new Set(visible), { factDeps: true }));
    for (const name of [...visible.filter((n) => n.startsWith("show_")), "get_contribution_room"]) expect(instructions).toMatch(new RegExp(`\\b${name}\\b`));
    expect(instructions).toContain("accountType");
    expect(instructions).toContain("must never be represented as trading or account-management capabilities");
    expect(instructions.length).toBeLessThan(2000);
  });

  it("a reduced deps set (no news, calendar, report card or facts) names no unlisted tool", async () => {
    const { news: _n, calendar: _c, reportCard: _r, portfolioFacts: _f, ...reduced } = everything;
    const client = await connectFocused(reduced);
    const listed = new Set(modelVisible((await client.listTools()).tools));
    for (const gone of ["show_news", "show_calendar", "show_report_card", "show_thesis"]) expect(listed.has(gone)).toBe(false);
    const named = [...client.getInstructions()!.matchAll(/\b(show|get|set|list)_[a-z_]+/g)].map((m) => m[0]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((n) => !listed.has(n))).toEqual([]);
  });

  it("never names an app-only tool", async () => {
    const client = await connectFocused(everything);
    const tools = (await client.listTools()).tools;
    const appOnly = tools.map((t) => t.name).filter((n) => !modelVisible(tools).includes(n));
    expect(appOnly.length).toBeGreaterThan(0);
    for (const name of appOnly) expect(client.getInstructions()).not.toMatch(new RegExp(`\\b${name}\\b`));
  });
});
