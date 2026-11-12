import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Ajv } from "ajv";
import _addFormats from "ajv-formats";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { miniSyntheticAccount } from "../testing/mini-synthetic-fixtures.js";
import { focusedInstructions } from "./playbook.js";
import { createPortfolioMcpServer } from "./portfolio-mcp-server.js";

// The routing case set (spec D8, goal 7): realistic, synthetic user questions, each mapped to the tool and arguments an
// assistant should produce. Every case is checked against the LIVE focused tool list and each tool's real input schema,
// so the query surface can't drift. Registration only: no tool is called.
interface RoutingCase { question: string; tool: string; args: Record<string, unknown>; note?: string }
const CASES = JSON.parse(readFileSync(new URL("./__fixtures__/routing-cases.json", import.meta.url), "utf8")) as RoutingCase[];

const ACCOUNT_TYPES = ["tfsa", "fhsa", "rrsp", "non_registered", "crypto", "cash_account"];
const SNAPSHOT_ORIGIN = "https://vestlens.example";
const stubBuild = (name: string) => `<!doctype html><head><script type="module" crossorigin>console.log(${JSON.stringify(name)})</script></head><body><div id="app"></div></body>`;
// The everything-enabled focused deps, as focused-surface.test.ts builds them for the committed focused fixture.
const everything = { overview: {}, performance: {}, activity: {}, holdings: {}, allocation: {}, income: {}, news: { publicOrigin: SNAPSHOT_ORIGIN }, calendar: {}, alerts: {}, memory: {}, room: {}, portfolioFacts: {}, reportCard: {} };

interface ListedTool { name: string; inputSchema: Record<string, unknown>; _meta?: unknown }
const FOCUSED_FIXTURE = JSON.parse(readFileSync(new URL("./__fixtures__/portfolio-mcp-focused.json", import.meta.url), "utf8")) as { tools: { tools: ListedTool[] } };
let tools: ListedTool[] = [];
let visible: ListedTool[] = [];
const isAppOnly = (t: ListedTool) => (t._meta as { ui?: { visibility?: string[] } } | undefined)?.ui?.visibility?.every((v) => v === "app") === true;

// The same validator family and options the MCP SDK uses for tool schemas (ajv + ajv-formats, strict off, all errors).
// ajv-formats is CJS, so under NodeNext its default import is the module namespace, as in the SDK.
const addFormats = _addFormats as unknown as (typeof _addFormats)["default"];
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);

beforeAll(async () => {
  const portfolio = { getPortfolio: vi.fn(async () => ({ connectionRequired: false, generatedAt: "2026-10-14T12:00:00.000Z", accounts: [miniSyntheticAccount(0)], errors: [] })) };
  const server = createPortfolioMcpServer({
    authSubject: "subject|synthetic-routing-subject", portfolio, history: { getAccountHistory: vi.fn(async () => ({})) },
    assets: { html: stubBuild }, surface: "focused", ...everything,
  } as never);
  const client = new Client({ name: "synthetic-host", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  tools = (await client.listTools()).tools as ListedTool[];
  visible = tools.filter((t) => !isAppOnly(t));
});

const sorted = (names: string[]) => [...names].sort();
const casesFor = (tool: string) => CASES.filter((c) => c.tool === tool);
const has = (c: RoutingCase, key: string) => c.args[key] !== undefined;

describe("routing cases: shape", () => {
  it("holds at least 40 well-formed cases with distinct questions", () => {
    expect(Array.isArray(CASES)).toBe(true);
    expect(CASES.length).toBeGreaterThanOrEqual(40);
    for (const c of CASES) {
      expect(typeof c.question, `question of a case for ${String(c.tool)}`).toBe("string");
      expect(c.question.trim().length, `empty question for ${String(c.tool)}`).toBeGreaterThan(0);
      expect(typeof c.tool, `tool of "${c.question}"`).toBe("string");
      expect(c.args !== null && typeof c.args === "object" && !Array.isArray(c.args), `args of "${c.question}" must be an object`).toBe(true);
    }
    const questions = CASES.map((c) => c.question.trim().toLowerCase());
    expect(questions.filter((q, i) => questions.indexOf(q) !== i), "duplicate questions").toEqual([]);
  });

  it("holds no real-looking account number or email in any question", () => {
    for (const c of CASES) {
      expect(c.question, "email-like text").not.toMatch(/[^\s@]+@[^\s@]+/);
      expect(c.question, "account-number-like digits").not.toMatch(/\d{6,}|(?:\d[ -]?){8,}/);
    }
  });
});

describe("routing cases: harness and playbook agreement", () => {
  it("this harness lists the same model-visible tools as the committed focused fixture", () => {
    const committed = FOCUSED_FIXTURE.tools.tools.filter((t) => !isAppOnly(t)).map((t) => t.name);
    expect(sorted(visible.map((t) => t.name)), "model-visible tools differ from __fixtures__/portfolio-mcp-focused.json").toEqual(sorted(committed));
  });

  it("every show_ tool a case routes to appears in the playbook for the same listed set", () => {
    const playbook = focusedInstructions(new Set(visible.map((t) => t.name)), { factDeps: true });
    const missing = [...new Set(CASES.map((c) => c.tool).filter((n) => n.startsWith("show_")))].filter((n) => !new RegExp(`\\b${n}\\b`).test(playbook));
    expect(missing, `routing case tool(s) not named in the playbook: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("routing cases: each case against the live focused surface", () => {
  it.each(CASES.map((c) => [c.question, c] as const))("%s", (_q, c) => {
    const listed = tools.find((t) => t.name === c.tool);
    expect(listed, `tool ${c.tool} is not listed on the focused surface`).toBeDefined();
    expect(isAppOnly(listed!), `tool ${c.tool} is app-only, so the model can't call it`).toBe(false);
    const validate = ajv.compile(listed!.inputSchema);
    const ok = validate(c.args);
    expect(ok, `args ${JSON.stringify(c.args)} do not validate against ${c.tool}'s input schema: ${ajv.errorsText(validate.errors)}`).toBe(true);
  });
});

describe("routing cases: coverage", () => {
  it("covers every model-visible focused tool", () => {
    expect(visible.length).toBeGreaterThan(0);
    const missing = visible.map((t) => t.name).filter((n) => casesFor(n).length === 0);
    expect(missing, `no routing case for model-visible tool(s): ${missing.join(", ")}`).toEqual([]);
  });

  it("the accountType filter still offers exactly the six values the cases cover", () => {
    for (const name of ["show_performance", "show_holdings", "show_allocation", "show_income", "show_activity"]) {
      const schema = visible.find((t) => t.name === name)?.inputSchema as { properties?: { accountType?: { enum?: string[] } } } | undefined;
      expect(schema?.properties?.accountType?.enum, `${name} accountType values`).toEqual(ACCOUNT_TYPES);
    }
  });

  it("covers each of the six accountType values", () => {
    const used = new Set(CASES.map((c) => c.args.accountType).filter((v): v is string => typeof v === "string"));
    const missing = ACCOUNT_TYPES.filter((v) => !used.has(v));
    expect(missing, `no routing case uses accountType value(s): ${missing.join(", ")}`).toEqual([]);
  });

  it("the cash_account cases are explicitly about the Wealthsimple Cash account", () => {
    const cash = CASES.filter((c) => c.args.accountType === "cash_account");
    expect(cash.length, "no routing case uses accountType value: cash_account").toBeGreaterThan(0);
    for (const c of cash) expect(c.question, `cash_account case "${c.question}" must name the Wealthsimple Cash account`).toMatch(/wealthsimple cash|cash account/i);
  });

  it("every shared filter on every model-visible tool appears in a case for that tool", () => {
    const missing: string[] = [];
    for (const t of visible) {
      const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      for (const filter of ["accountType", "symbol", "from", "to"]) {
        if (props.includes(filter) && !casesFor(t.name).some((c) => has(c, filter))) missing.push(`${t.name}.${filter}`);
      }
    }
    expect(missing, `no routing case uses filter(s): ${missing.join(", ")}`).toEqual([]);
  });

  it("covers accountId on a show_ tool, with the account named in the question", () => {
    const named = CASES.filter((c) => c.tool.startsWith("show_") && has(c, "accountId"));
    expect(named.length, "no show_ case passes accountId").toBeGreaterThan(0);
    for (const c of named) expect(c.question, `accountId case "${c.question}" must name the account`).toMatch(/\b(my|the) [A-Z][\w' -]* account\b/);
  });

  it("covers symbol on holdings and on income", () => {
    for (const tool of ["show_holdings", "show_income"]) {
      expect(casesFor(tool).some((c) => has(c, "symbol")), `no ${tool} case passes symbol`).toBe(true);
    }
  });

  it("covers activity with from and to", () => {
    expect(casesFor("show_activity").some((c) => has(c, "from") && has(c, "to")), "no show_activity case passes both from and to").toBe(true);
  });

  it("covers performance with accountType", () => {
    expect(casesFor("show_performance").some((c) => has(c, "accountType")), "no show_performance case passes accountType").toBe(true);
  });

  it("covers TFSA, FHSA and RRSP room questions on get_contribution_room with no arguments", () => {
    const room = casesFor("get_contribution_room");
    for (const [label, re] of [["TFSA", /tfsa/i], ["FHSA", /fhsa/i], ["RRSP", /rrsp/i]] as const) {
      expect(room.some((c) => re.test(c.question)), `no get_contribution_room case asks about ${label} room`).toBe(true);
    }
    for (const c of room) expect(c.args, `get_contribution_room takes no arguments ("${c.question}")`).toEqual({});
  });

  it("covers show_thesis with a ticker, set_portfolio_limit with kind/target/maxPct, show_limits and show_report_card", () => {
    expect(casesFor("show_thesis").some((c) => typeof c.args.ticker === "string"), "no show_thesis case passes ticker").toBe(true);
    expect(casesFor("set_portfolio_limit").some((c) => has(c, "kind") && has(c, "target") && has(c, "maxPct")), "no set_portfolio_limit case passes kind, target and maxPct").toBe(true);
    expect(casesFor("show_limits").length, "no show_limits case").toBeGreaterThan(0);
    expect(casesFor("show_report_card").length, "no show_report_card case").toBeGreaterThan(0);
  });

  it("routes 'how much cash do I have' to show_holdings with no accountType", () => {
    const cash = CASES.filter((c) => /how much cash do i have/i.test(c.question));
    expect(cash.length, "no routing case asks 'how much cash do I have'").toBeGreaterThan(0);
    for (const c of cash) {
      expect(c.tool, `"${c.question}" must route to show_holdings`).toBe("show_holdings");
      expect(c.args.accountType, `"${c.question}" must not pass accountType`).toBeUndefined();
    }
  });
});
