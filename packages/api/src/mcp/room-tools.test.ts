import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { BrokerageLinks } from "../memory/context-builder.js";
import { accountKey, activityKey } from "../memory/keys.js";
import { MemoryService } from "../memory/memory-service.js";
import type { RoomPrismaPort } from "../room/room-loader.js";
import type { RoomResult } from "../room/tfsa-room.js";
import { MemoryFactRepository } from "../testing/memory-fact-repository.js";
import { createPortfolioMcpServer } from "./portfolio-mcp-server.js";
import { TFSA_ROOM_WIDGET_URI, dashboardEnterable, fhsaText, newYearText, roomText, withdrawalNote, withdrawalRowNote } from "./room-tools.js";

// Synthetic ids, labels and amounts only.
const SUBJECT = "subject|synthetic-room-tools";
const TFSA_ID = "synthetic-acct-tfsa";
const NOW = new Date("2026-10-24T16:00:00Z");
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

type TextBlock = { type: string; text: string };
const texts = (result: unknown) => ((result as { content?: TextBlock[] }).content ?? []).filter((b) => b.type === "text").map((b) => b.text);

const links: BrokerageLinks = {
  accountsHoldingSecurity: async () => [],
  tfsaAccounts: async () => [TFSA_ID],
  accountIds: async () => [TFSA_ID],
  activityDedupeKeys: async () => [],
};

type SyncOverride = { lastSyncedAt: Date | null; lastError: string | null; dirty: boolean };
function prismaPort(activities: Array<Record<string, unknown>>, sync?: SyncOverride): RoomPrismaPort {
  return {
    brokerageAccount: {
      findMany: async () => [{
        snapTradeAccountId: TFSA_ID, displayName: null, institutionName: "Synthetic Broker", rawType: "TFSA", status: "OPEN",
        snapshots: [{ payload: { account: { type: "TFSA", metaType: null, unifiedType: null, status: "OPEN" }, positions: [] } }],
      }],
    },
    activity: { findMany: async () => activities as never },
    activitySyncState: { findMany: async () => [{ snapTradeAccountId: TFSA_ID, backfillCompletedAt: day("2026-02-01"), earliestTradeDate: day("2023-05-01"), lastSyncedAt: new Date("2026-10-24T08:00:00Z"), lastError: null, dirty: false, ...sync }] },
  };
}

async function connect(o: { scopes?: string[]; activities?: Array<Record<string, unknown>>; facts?: Array<Record<string, unknown>>; widget?: boolean; sync?: SyncOverride; market?: { usdCad(from: string, to: string): Promise<Array<{ date: string; close: number }> | null> } } = {}) {
  const repository = new MemoryFactRepository();
  const service = new MemoryService({ repository, links, log: () => {}, now: () => NOW });
  for (const f of o.facts ?? []) await service.remember(SUBJECT, { text: "Synthetic.", kind: "fact", provenance: "stated", ...f } as never, new Date("2026-03-01T12:00:00Z"), "system");
  const room = { loader: { prisma: prismaPort(o.activities ?? [], o.sync), memory: repository, ...(o.market ? { market: o.market } : {}) }, context: { repository, links, now: () => NOW }, now: () => NOW };
  const portfolio = { getPortfolio: vi.fn(async () => { throw new Error("the brokerage is not read"); }) };
  const built = (name: string) => `<!doctype html><title>${name}</title>`;
  const server = createPortfolioMcpServer({
    authSubject: SUBJECT,
    scopes: o.scopes ?? ["portfolio:read", "memory"],
    portfolio,
    history: { getAccountHistory: vi.fn(async () => ({})) },
    memory: { service, links },
    room,
    ...(o.widget ? { overview: {}, assets: { html: built } } : {}),
  } as never);
  const client = new Client({ name: "synthetic-host", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, repository, portfolio };
}

const node = { type: "tax_year", key: "2026:tfsa" };
const craFact = (amountCad: number) => ({ node, property: "tax_year.cra_room_jan1", value: { amountCad } });
const setFact = () => ({ node, property: "tax_year.account_set", value: { connected: [accountKey(TFSA_ID)], outside: [], confirmedAt: "2026-02-01T15:00:00.000Z" } });
const row = (dedupeKey: string, type: string, amount: number, tradeDate: string, currency = "CAD") =>
  ({ snapTradeAccountId: TFSA_ID, dedupeKey, type, amount, currency, fxRate: null, tradeDate: day(tradeDate) });

describe("get_contribution_room: listing and gates", () => {
  it("is listed in normal mode, with the existing tool names unchanged", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["get_portfolio_snapshot", "list_portfolio_accounts", "get_account_positions", "get_account_history", "show_portfolio", "remember", "recall", "forget", "get_contribution_room"]);
    const room = tools.find((t) => t.name === "get_contribution_room")!;
    expect(room.description).toMatch(/TFSA/);
    expect(room.description).toMatch(/deposit or withdrawal/);
    expect(room.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("works with portfolio:read alone, from stored inputs, without reading the brokerage", async () => {
    const { client, portfolio } = await connect({ scopes: ["portfolio:read"], facts: [craFact(7000), setFact()] });
    const result = await client.callTool({ name: "get_contribution_room", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(texts(result)[0]).toMatch(/^You have about \$7,000 of TFSA room left this year\./);
    expect(portfolio.getPortfolio).not.toHaveBeenCalled();
  });

  it("references the TFSA room widget only once the widget is served", async () => {
    expect(TFSA_ROOM_WIDGET_URI).toBe("ui://portfolio/tfsa-room-v1");
    const without = (await (await connect()).client.listTools()).tools.find((t) => t.name === "get_contribution_room")!;
    expect((without._meta as any)?.ui).toBeUndefined();
    const withWidget = await connect({ widget: true });
    const tool = (await withWidget.client.listTools()).tools.find((t) => t.name === "get_contribution_room")!;
    const uri = (tool._meta as any).ui.resourceUri as string;
    expect(uri).toMatch(/^ui:\/\/portfolio\/tfsa-room-[0-9a-f]{10}$/);
    expect((tool._meta as any)["openai/outputTemplate"]).toBe(uri);
    expect((await withWidget.client.listResources()).resources.map((r) => r.uri)).toContain(uri);
    const read = await withWidget.client.readResource({ uri });
    expect((read.contents[0] as { text: string }).text).toContain("tfsa-room");
  });
});

describe("get_contribution_room: output", () => {
  it("known: the number, Based on, structuredContent with the tax-year context", async () => {
    const { client } = await connect({ facts: [craFact(7000), setFact()], activities: [row("synthetic-dedupe-1", "CONTRIBUTION", 2000, "2026-03-02")] });
    const result = await client.callTool({ name: "get_contribution_room", arguments: {} });
    const [text] = texts(result);
    expect(text).toBe([
      "You have about $5,000 of TFSA room left this year.",
      "Based on your connected TFSAs.",
      "Based on activity up to 24 October 2026; deposits made since then aren't included.",
      "Based on: CRA room on 1 January 2026: $7,000 (you said); Your TFSAs for 2026, confirmed 2026-02-01 (you said); Connected TFSA: Synthetic Broker TFSA.",
      "Over time, from your stored activity:",
      "- Synthetic Broker TFSA: put in $2,000, taken out $0, net $2,000 since 2 March 2026.",
      "  Running net at the end of each year: 2026 $2,000.",
      "  The earliest activity SnapTrade has for this account is 2 March 2026. Anything before that isn't in these figures.",
      "This doesn't include TFSAs at other institutions, or closed accounts that aren't connected.",
    ].join("\n"));
    const sc = result.structuredContent as RoomResult & { context: { focus: unknown; facts: Array<Record<string, unknown>> }; accounts: unknown };
    expect(sc).toMatchObject({ status: "known", year: 2026, roomLeftCad: 5000, contributedCad: 2000, withdrawnCad: 0, activityAsOf: "2026-10-24T08:00:00.000Z" });
    expect(sc.accounts).toEqual([{ accountKey: accountKey(TFSA_ID), label: "Synthetic Broker TFSA", neutral: false, inSet: true, maskedNumber: null, value: null }]);
    expect(sc.context.focus).toEqual({ type: "tax_year", key: "2026:tfsa" });
    expect(sc.context.facts.map((f) => f.property).sort()).toEqual(["tax_year.account_set", "tax_year.cra_room_jan1"]);
    expect(JSON.stringify(sc)).not.toContain(SUBJECT);
  });

  it("estimated, over the limit, with the withdrawal note verbatim", async () => {
    const { client } = await connect({
      facts: [craFact(5000), setFact()],
      activities: [row("synthetic-dedupe-1", "WITHDRAWAL", -5000, "2026-03-02"), row("synthetic-dedupe-2", "CONTRIBUTION", 6000, "2026-06-01")],
    });
    const [text] = texts(await client.callTool({ name: "get_contribution_room", arguments: {} }));
    expect(text.split("\n").slice(0, 4)).toEqual([
      "You have about $0 of TFSA room left this year.",
      "Based on your connected TFSAs.",
      "Your TFSA contributions this year are about $1,000 over your room. CRA charges 1% a month on the excess.",
      "About $1,000 over your TFSA room since 1 June.",
    ]);
    expect(text.split("\n")).toContain("1 June 2026: Synthetic Broker TFSA · +$6,000; this went over by $1,000.");
    expect(text.split("\n").slice(5, 6)).toEqual([
      "You withdrew $5,000 this year. That room comes back on 1 January 2027. Putting it back before then would be an over-contribution.",
    ]);
    expect(text).not.toMatch(/you should/i);
  });

  it("missing: the lead-in, one plain question per item, ambiguous rows with date, CAD amount, type and label only, and the withdrawal note", async () => {
    const { client } = await connect({
      activities: [
        row("synthetic-dedupe-1", "WITHDRAWAL", -1500, "2026-02-10"),
        // An unknown type stays unclear (a transfer would be assumed).
        row("synthetic-dedupe-2", "SOMETHING_NEW", 5000, "2026-03-03"),
      ],
    });
    const result = await client.callTool({ name: "get_contribution_room", arguments: {} });
    expect(texts(result)[0]).toBe([
      "I can't give a number yet:",
      "- What was your TFSA contribution room on 1 January 2026? It's in CRA My Account.",
      "- Was the SOMETHING_NEW of $5,000 on 2026-03-03 (Synthetic Broker TFSA) a contribution to your TFSA?",
      "You withdrew $1,500 this year. Some or all of that room comes back on 1 January 2027; the exact amount needs the missing items above.",
      "Based on: Connected TFSA: Synthetic Broker TFSA.",
      "Over time, from your stored activity:",
      "- Synthetic Broker TFSA: put in $0, taken out $1,500, net -$1,500 since 10 February 2026.",
      "  Running net at the end of each year: 2026 -$1,500.",
      "  The earliest activity SnapTrade has for this account is 10 February 2026. Anything before that isn't in these figures.",
      "  Not counted: SOMETHING_NEW (1 row, $5,000).",
      "This doesn't include TFSAs at other institutions, or closed accounts that aren't connected.",
    ].join("\n"));
    const sc = result.structuredContent as any;
    expect(sc.status).toBe("missing");
    // No set is confirmed, yet the broker-labelled TFSA is counted.
    expect(sc.accounts).toEqual([{ accountKey: accountKey(TFSA_ID), label: "Synthetic Broker TFSA", neutral: false, inSet: true, maskedNumber: null, value: null }]);
    const ambiguous = sc.missing.find((m: any) => m.kind === "ambiguous");
    expect(ambiguous.rows).toEqual([{ activityKey: activityKey("synthetic-dedupe-2"), date: "2026-03-03", amountCad: 5000, estimated: false, rateDate: null, native: { amount: 5000, currency: "CAD" }, type: "SOMETHING_NEW", label: "Synthetic Broker TFSA" }]);
    // The model copy carries the activityKey so the answer can be saved with remember.
    expect(texts(result)[1]).toContain(activityKey("synthetic-dedupe-2"));
  });
});

describe("get_contribution_room: converted amounts (Bank of Canada rate dates, native amounts)", () => {
  // Synthetic closes: 2 March and 1 June only, so other days use the nearest previous close.
  const market = { usdCad: async () => [{ date: "2026-03-02", close: 1.35 }, { date: "2026-06-01", close: 1.4 }] };

  it("a USD ambiguous row and a USD withdrawal show est., the BoC date and the native amount", async () => {
    const { client } = await connect({ market, activities: [
      row("synthetic-dedupe-1", "SOMETHING_NEW", 1000, "2026-03-03", "USD"),
      row("synthetic-dedupe-2", "WITHDRAWAL", -1000, "2026-03-04", "USD"),
    ] });
    const result = await client.callTool({ name: "get_contribution_room", arguments: {} });
    const lines = texts(result)[0]!.split("\n");
    expect(lines).toContain("- Was the SOMETHING_NEW of $1,350 (est., BoC 2026-03-02; US$1,000) on 2026-03-03 (Synthetic Broker TFSA) a contribution to your TFSA?");
    expect(lines).toContain("You withdrew $1,350 (est.; includes US$1,000 converted at the Bank of Canada rate of 2026-03-02) this year. Some or all of that room comes back on 1 January 2027; the exact amount needs the missing items above.");
    const sc = result.structuredContent as any;
    expect(sc.missing.find((m: any) => m.kind === "ambiguous").rows[0]).toMatchObject({ amountCad: 1350, estimated: true, rateDate: "2026-03-02", native: { amount: 1000, currency: "USD" } });
    expect(sc.fxDates).toEqual(["2026-03-02"]);
  });

  it("USD contributions in a known result: est. with the range of Bank of Canada rate dates and the native total", async () => {
    const { client } = await connect({ market, facts: [craFact(10000), setFact()], activities: [
      row("synthetic-dedupe-1", "CONTRIBUTION", 1000, "2026-03-03", "USD"),
      row("synthetic-dedupe-2", "CONTRIBUTION", 500, "2026-06-06", "USD"),
      row("synthetic-dedupe-3", "CONTRIBUTION", 100, "2026-07-01"),
    ] });
    const result = await client.callTool({ name: "get_contribution_room", arguments: {} });
    // 10,000 − (1,350 + 700 + 100) = 7,850
    expect(texts(result)[0]!.split("\n")[0]).toBe("You have about $7,850 of TFSA room left this year (est.; includes US$1,500 converted at Bank of Canada rates from 2026-03-02–2026-06-01).");
    expect(result.structuredContent).toMatchObject({ status: "known", estimated: true, fxDates: ["2026-03-02", "2026-06-01"], fx: { contributions: { native: [{ amount: 1500, currency: "USD" }] } } });
  });
});

describe("roomText", () => {
  const noFx = { estimated: false, rateDates: [] as string[], native: [] as Array<{ amount: number; currency: string }> };
  const base = { year: 2026, withdrawnCad: 0, returningCad: 0, basis: [] as string[], fx: { contributions: noFx, withdrawals: noFx }, fxDates: [] as string[], ledger: { rows: [], overSince: null, undatedExcess: false } };
  it("with only the CRA room missing, the text asks that one thing (never which accounts are TFSAs)", () => {
    const text = roomText({ ...base, status: "missing", missing: [{ kind: "cra_room" }] }, [
      { accountKey: "1111111111111111", label: "Main TFSA", neutral: false, inSet: true, maskedNumber: null, value: null },
      { accountKey: "2222222222222222", label: "Odd account", neutral: true, inSet: false, maskedNumber: null, value: null },
    ]);
    expect(text.split("\n")).toEqual(["I can't give a number yet:", "- What was your TFSA contribution room on 1 January 2026? It's in CRA My Account."]);
  });

  it("a known number names what isn't counted, in words, with the account keys remember takes", () => {
    const shown = { ...base, status: "known", roomLeftCad: 5000, contributedCad: 2000, craRoomCad: 7000, returningCad: 0, estimated: false, overLimitCad: 0, activityAsOf: null, headlineBasis: "Based on your connected TFSAs",
      notCounted: [{ accountKey: "7777777777777777", label: "Managed TFSA" }] } as unknown as RoomResult;
    const lines = roomText(shown).split("\n");
    expect(lines[0]).toBe("You have about $5,000 of TFSA room left this year.");
    expect(lines).toContain("Not counted: Managed TFSA. Contributions to it aren't visible through SnapTrade. If you contributed to it this year, your room is lower than this.");
    expect(lines).toContain("If the user gives a year-to-date figure, save it with remember (account.ytd_contributions) on Managed TFSA (account key 7777777777777777).");
    const none = { ...shown, notCounted: undefined } as unknown as RoomResult;
    expect(roomText(none)).not.toContain("Not counted");
  });

  it("covers every missing kind with a question", () => {
    const text = roomText({
      ...base, status: "missing", missing: [
        { kind: "coverage", label: "Old TFSA", accountKey: "3333333333333333" },
        { kind: "outside_contributions", label: "Other bank", accountKey: "outside:other-bank" },
        { kind: "stale_activity", label: "Main TFSA", accountKey: "4444444444444444", lastSyncedAt: "2026-10-22T15:00:00.000Z" },
        { kind: "stale_activity", label: "Fresh-never TFSA", accountKey: "5555555555555555", lastSyncedAt: null },
        { kind: "disconnected_account", accountKey: "6666666666666666" },
        { kind: "managed_account", label: "Managed TFSA", accountKey: "7777777777777777" },
        { kind: "ambiguous", count: 7, rows: [
          { activityKey: "0123456789abcdef", date: "unknown", amountCad: null, estimated: false, rateDate: null, native: null, type: "UNKNOWN", label: "New TFSA" },
          { activityKey: "0123456789abcdee", date: "2026-03-15", amountCad: null, estimated: false, rateDate: null, native: null, type: "TRANSFER", label: "New TFSA", inKind: true, accountKey: "8888888888888888" },
        ] },
      ],
    });
    expect(text.split("\n")).toEqual([
      "I can't give a number yet:",
      "- How much have you contributed to Old TFSA (account key 3333333333333333) this year, and as of what date? Its stored activity doesn't go back to 1 January.",
      "- How much have you contributed to Other bank (account key outside:other-bank) this year, and as of what date?",
      "- Main TFSA's activity was last updated 22 October 2026, 11:00 a.m. Toronto time; I'll have a number after it refreshes.",
      "- Fresh-never TFSA's activity hasn't been loaded yet; I'll have a number after it refreshes.",
      "- An account you confirmed as a TFSA (key 6666666666666666) is no longer connected. How much did you contribute to it this year?",
      "- Contributions to Managed TFSA (account key 7777777777777777) aren't visible through SnapTrade. How much have you contributed to it this year, and as of what date? Don't include amounts already entered elsewhere.",
      "- Was the UNKNOWN (amount not known in CAD) on an unknown date (New TFSA) a contribution to your TFSA?",
      "- The TRANSFER on 2026-03-15 (New TFSA) moved shares in kind, and no price or close was found for them, so it has no amount and an answer alone can't give it one. Tell me what you have contributed to New TFSA (account key 8888888888888888) this year as of a date on or after 2026-03-15, these shares at their value that day included, and don't include amounts already entered elsewhere; that figure then stands in for it.",
      "- 5 more need checking after these.",
    ]);
  });
  it("marks an estimated number and keeps cents", () => {
    const usd = { estimated: true, rateDates: ["2026-03-02"], native: [{ amount: 1000, currency: "USD" }] };
    const text = roomText({ ...base, fx: { contributions: usd, withdrawals: noFx }, fxDates: ["2026-03-02"], status: "known", roomLeftCad: 1234.5, contributedCad: 0, craRoomCad: 1234.5, estimated: true, overLimitCad: 0, activityAsOf: null, headlineBasis: "Based on your connected TFSAs" });
    expect(text).toBe("You have about $1,234.50 of TFSA room left this year (est.; includes US$1,000 converted at the Bank of Canada rate of 2026-03-02).\nBased on your connected TFSAs.");
  });
  it("a known number with a carried outside TFSA says what it is based on, right after the headline", () => {
    const text = roomText({ ...base, status: "known", roomLeftCad: 100, contributedCad: 0, craRoomCad: 100, estimated: false, overLimitCad: 0, activityAsOf: null, headlineBasis: "Based on your connected TFSAs and what you entered" });
    expect(text.split("\n").slice(0, 2)).toEqual(["You have about $100 of TFSA room left this year.", "Based on your connected TFSAs and what you entered."]);
  });
  it("a known number says how current the activity is, in Toronto time", () => {
    const text = roomText({ ...base, status: "known", roomLeftCad: 100, contributedCad: 0, craRoomCad: 100, estimated: false, overLimitCad: 0, activityAsOf: "2027-01-01T04:59:00.000Z", headlineBasis: "Based on your connected TFSAs" });
    expect(text).toBe("You have about $100 of TFSA room left this year.\nBased on your connected TFSAs.\nBased on activity up to 31 December 2026; deposits made since then aren't included.");
  });
  const row = (o: Record<string, unknown>) => ({ date: "2026-03-14", kind: "contribution", label: "Synthetic TFSA", amountCad: 5000, estimated: false, rateDate: null, native: null, roomLeftCad: -4000, excessCad: 4000, wentOver: false, ...o });
  const overKnown = (ledger: Record<string, unknown>) => ({ ...base, status: "known" as const, roomLeftCad: -4000, contributedCad: 11000, craRoomCad: 7000, estimated: false, overLimitCad: 4000, activityAsOf: "2026-10-24T08:00:00.000Z", ledger } as never);
  it("over: the since sentence, the freshness label, the went-over row and the dashboard link", () => {
    const text = roomText(overKnown({ rows: [row({ wentOver: true, native: { amount: 5000, currency: "USD" }, estimated: true, rateDate: "2026-03-13" })], overSince: "2026-03-14", undatedExcess: false }), [], "https://app.example.test/");
    const lines = text.split("\n");
    expect(lines).toContain("About $4,000 over your TFSA room since 14 March.");
    expect(lines).toContain("14 March 2026: Synthetic TFSA · +$5,000 (est., BoC 2026-03-13; US$5,000); this went over by $4,000.");
    expect(lines).toContain("Based on activity up to 24 October 2026; deposits made since then aren't included.");
    expect(lines).toContain("See every move: https://app.example.test/?view=room");
  });
  it("an assumed transfer that went over says it is assumed", () => {
    const text = roomText(overKnown({ rows: [row({ wentOver: true, assumed: true, activityKey: "0123456789abcdef" })], overSince: "2026-03-14", undatedExcess: false }));
    expect(text.split("\n")).toContain("14 March 2026: Synthetic TFSA · +$5,000; this went over by $4,000; assumed; you can change this.");
  });
  it("over with an undated total: the date can't be told", () => {
    const text = roomText(overKnown({ rows: [row({ kind: "outside_total", label: "Other bank" })], overSince: null, undatedExcess: true }));
    expect(text).toContain("About $4,000 over your TFSA room; the date can't be told because Other bank has a total, not dated deposits.");
    expect(text).not.toContain("view=room");
  });
  it("missing: the dashboard line comes before the questions, and only with a base URL", () => {
    const items = [{ kind: "cra_room" as const }];
    expect(roomText({ ...base, status: "missing", missing: items }, [], "https://app.example.test").split("\n").slice(0, 3)).toEqual([
      "I can't give a number yet:",
      "Enter these on the VestLens dashboard: https://app.example.test/?view=room",
      "- What was your TFSA contribution room on 1 January 2026? It's in CRA My Account.",
    ]);
    expect(roomText({ ...base, status: "missing", missing: items })).not.toContain("dashboard");
  });
  it("dashboard line: every item enterable, some enterable, none enterable", () => {
    const url = "https://app.example.test";
    const cov = { kind: "coverage" as const, label: "A", accountKey: "k" };
    const stale = { kind: "stale_activity" as const, label: "B", accountKey: "j", lastSyncedAt: null };
    const text = (missing: never[]) => roomText({ ...base, status: "missing", missing }, [], url);
    expect(text([{ kind: "cra_room" }, { kind: "outside_contributions", label: "O", accountKey: "outside:o" }] as never)).toContain("Enter these on the VestLens dashboard: https://app.example.test/?view=room");
    const some = text([{ kind: "cra_room" }, cov] as never);
    expect(some).toContain("You can enter some of these on the VestLens dashboard: https://app.example.test/?view=room");
    expect(some).not.toContain("Enter these on");
    expect(text([cov, stale] as never)).not.toContain("dashboard");
  });
  it("dashboardEnterable pins the kinds the dashboard takes (same list as the widget test)", () => {
    const kinds = ["cra_room", "outside_contributions", "ambiguous", "coverage", "stale_activity", "disconnected_account", "dated_entries", "managed_account"];
    expect(kinds.filter((kind) => dashboardEnterable({ kind, accountKey: "k" } as never))).toEqual(["cra_room", "outside_contributions", "ambiguous", "managed_account"]);
    expect(dashboardEnterable({ kind: "dated_entries", accountKey: "outside:other-bank", label: "O" })).toBe(true);
    expect(dashboardEnterable({ kind: "dated_entries", accountKey: "1111111111111111", label: "O" })).toBe(false);
  });
  it("the withdrawal sentence says over-contribution only when putting it back would exceed the room left (B4)", () => {
    const known = (roomLeftCad: number) => roomText({ ...base, status: "known", withdrawnCad: 500, returningCad: 500, roomLeftCad, contributedCad: 1000, craRoomCad: 7000, estimated: false, overLimitCad: 0, activityAsOf: null,
      ledger: { rows: [], overSince: null, undatedExcess: false } } as never);
    // Room 7,000, contributed 1,000, withdrew 500: 6,000 left, so re-depositing $500 uses room, it isn't an over-contribution.
    expect(known(6000).split("\n")).toContain("You withdrew $500 this year. That room comes back on 1 January 2027. Putting it back before then would count as a new contribution against your remaining room.");
    expect(known(6000)).not.toContain("over-contribution");
    // Less room left than the withdrawal: putting all of it back would be an over-contribution.
    expect(known(200).split("\n")).toContain("You withdrew $500 this year. That room comes back on 1 January 2027. Putting it back before then would be an over-contribution.");
    expect(known(0)).toContain("would be an over-contribution");
  });
  it("missing state: the withdrawal sentence doesn't say how much room comes back", () => {
    const text = roomText({ ...base, status: "missing", missing: [{ kind: "cra_room" }], withdrawnCad: 2000, returningCad: 0 });
    expect(text).toContain("You withdrew $2,000 this year. Some or all of that room comes back on 1 January 2027; the exact amount needs the missing items above.");
    expect(text).not.toContain("That room comes back");
  });
  it("withdrawal row notes: only qualifying, only returning, both, or none without a date", () => {
    expect(withdrawalRowNote({ qualifyingCad: 2000, returnsCad: 0 })).toBe("this reduced the amount over by $2,000");
    expect(withdrawalRowNote({ qualifyingCad: 0, returnsCad: 500, returnsOn: "2027-01-01" })).toBe("this room comes back on 1 January 2027, not now");
    expect(withdrawalRowNote({ qualifyingCad: 1000, returnsCad: 2000, returnsOn: "2027-01-01" })).toBe("this reduced the amount over by $1,000; the other $2,000 comes back on 1 January 2027, not now");
    expect(withdrawalRowNote({ qualifyingCad: null, returnsCad: null })).toBeNull();
    expect(withdrawalRowNote({ qualifyingCad: 0, returnsCad: 500 })).toBeNull();
  });
  const wrow = (o: Record<string, unknown>) => ({ date: "2026-02-01", kind: "withdrawal", label: "Synthetic TFSA", amountCad: -2000, estimated: false, rateDate: null, native: null, roomLeftCad: 0, excessCad: 0, wentOver: false, ...o });
  it("spec example: a fully qualifying withdrawal gets its row line and no comes-back sentence", () => {
    const text = roomText({ ...base, status: "known", withdrawnCad: 2000, returningCad: 0, roomLeftCad: -1000, contributedCad: 8000, craRoomCad: 5000, estimated: false, overLimitCad: 1000, activityAsOf: null,
      ledger: { rows: [wrow({ qualifyingCad: 2000, returnsCad: 0 })], overSince: "2026-03-01", undatedExcess: false } } as never);
    expect(text.split("\n")).toContain("1 February 2026: Synthetic TFSA · -$2,000; this reduced the amount over by $2,000.");
    expect(text).not.toContain("comes back");
  });
  it("mixed: the headline sentence counts only the returning part", () => {
    const text = roomText({ ...base, status: "known", withdrawnCad: 3000, returningCad: 2000, roomLeftCad: 0, contributedCad: 6000, craRoomCad: 5000, estimated: false, overLimitCad: 0, activityAsOf: null,
      ledger: { rows: [wrow({ amountCad: -3000, qualifyingCad: 1000, returnsCad: 2000, returnsOn: "2027-01-01" })], overSince: null, undatedExcess: false } } as never);
    const lines = text.split("\n");
    expect(lines).toContain("1 February 2026: Synthetic TFSA · -$3,000; this reduced the amount over by $1,000; the other $2,000 comes back on 1 January 2027, not now.");
    expect(lines).toContain("You withdrew $2,000 this year. That room comes back on 1 January 2027. Putting it back before then would be an over-contribution.");
  });
  it("a matched row the text shows says what it was matched to", () => {
    const matchedWith = { label: "Synthetic Cash", date: "2026-03-13" };
    const over = roomText(overKnown({ rows: [row({ wentOver: true, matchedWith, inferred: true })], overSince: "2026-03-14", undatedExcess: false }));
    expect(over.split("\n")).toContain("14 March 2026: Synthetic TFSA · +$5,000; this went over by $4,000; matched to a transfer from Synthetic Cash on 13 March.");
    const text = roomText({ ...base, status: "known", withdrawnCad: 2000, returningCad: 0, roomLeftCad: -1000, contributedCad: 8000, craRoomCad: 5000, estimated: false, overLimitCad: 1000, activityAsOf: null,
      ledger: { rows: [wrow({ qualifyingCad: 2000, returnsCad: 0, matchedWith: { label: "Synthetic Cash", date: "2026-02-02" }, inferred: true })], overSince: "2026-03-01", undatedExcess: false } } as never);
    expect(text.split("\n")).toContain("1 February 2026: Synthetic TFSA · -$2,000; this reduced the amount over by $2,000; matched to a transfer to Synthetic Cash on 2 February.");
  });
  it("dated_entries: asks for the total's dated deposits", () => {
    const text = roomText({ ...base, status: "missing", missing: [{ kind: "dated_entries", label: "Other bank", accountKey: "outside:other-bank" }] });
    expect(text.split("\n")[1]).toBe("- Other bank's contributions this year as dated deposits, so withdrawals can be placed correctly (account key outside:other-bank).");
  });
  it("withdrawal note is the global-constraints copy", () => {
    expect(withdrawalNote("$5,000", 2026)).toBe("You withdrew $5,000 this year. That room comes back on 1 January 2027. Putting it back before then would be an over-contribution.");
  });
});

describe("get_contribution_room: end to end through tool outputs only", () => {
  const MAIN_ID = "synthetic-e2e-main";
  const GAP_ID = "synthetic-e2e-gap";
  const ODD_E2E = "synthetic-e2e-odd";
  const account = (id: string, rawType: string) => ({
    snapTradeAccountId: id, displayName: null, institutionName: "Synthetic Broker", rawType, status: "OPEN",
    snapshots: [{ payload: { account: { type: rawType, metaType: null, unifiedType: null, status: "OPEN" }, positions: [] } }],
  });
  const rows = [
    { snapTradeAccountId: MAIN_ID, dedupeKey: "synthetic-e2e-1", type: "CONTRIBUTION", amount: 1000, currency: "CAD", fxRate: null, tradeDate: day("2026-04-01") },
    { snapTradeAccountId: MAIN_ID, dedupeKey: "synthetic-e2e-2", type: "INTERNAL_CASH_TRANSFER_IN", amount: 9000, currency: "CAD", fxRate: null, tradeDate: day("2026-05-01") },
  ];
  const e2eLinks: BrokerageLinks = {
    accountsHoldingSecurity: async () => [],
    tfsaAccounts: async () => [MAIN_ID, GAP_ID],
    accountIds: async () => [MAIN_ID, GAP_ID, ODD_E2E],
    activityDedupeKeys: async () => rows.map((r) => r.dedupeKey),
  };
  const prisma: RoomPrismaPort = {
    brokerageAccount: { findMany: async () => [account(MAIN_ID, "TFSA"), account(GAP_ID, "TFSA"), account(ODD_E2E, "MYSTERY")] },
    activity: { findMany: async () => rows as never },
    activitySyncState: {
      findMany: async () => [
        { snapTradeAccountId: MAIN_ID, backfillCompletedAt: day("2026-02-01"), earliestTradeDate: day("2023-05-01"), lastSyncedAt: new Date("2026-10-24T08:00:00Z"), lastError: null, dirty: false },
        // Backfill not complete: coverage unknown (a completed backfill is the whole history, auto-room B).
        { snapTradeAccountId: GAP_ID, backfillCompletedAt: null, earliestTradeDate: day("2026-06-01"), lastSyncedAt: new Date("2026-10-24T08:00:00Z"), lastError: null, dirty: false },
      ],
    },
  };

  it("asks, the assistant answers with remember using only returned keys, and the number appears", async () => {
    const repository = new MemoryFactRepository();
    const service = new MemoryService({ repository, links: e2eLinks, log: () => {}, now: () => NOW });
    const server = createPortfolioMcpServer({
      authSubject: SUBJECT, scopes: ["portfolio:read", "memory"],
      portfolio: { getPortfolio: vi.fn() }, history: { getAccountHistory: vi.fn() },
      memory: { service, links: e2eLinks },
      room: { loader: { prisma, memory: repository }, context: { repository, links: e2eLinks, now: () => NOW }, now: () => NOW, log: () => {} },
      clientKey: "https://claude.ai/oauth/mcp-oauth-client-metadata",
    } as never);
    const client = new Client({ name: "synthetic-host", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const room = async () => (await client.callTool({ name: "get_contribution_room", arguments: {} })).structuredContent as any;
    const remember = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: "remember", arguments: { kind: "fact", provenance: "stated", text: "Synthetic answer.", ...args } });
      expect(texts(result)[0], JSON.stringify(args)).toMatch(/^Saved/);
    };

    const first = await room();
    expect(first.status).toBe("missing");
    // Which accounts are TFSAs is never asked: the neutral account is reported, not counted.
    // The unmatched transfer is assumed a contribution, so it isn't in missing either.
    expect(first.missing.map((m: any) => m.kind)).toEqual(["cra_room", "coverage"]);
    expect(first.basis).toContain("1 transfer couldn't be matched to your other accounts; it's assumed to be a contribution until you change it");
    expect(first.basis).toContain("1 connected account of unknown type isn't counted; add it if it's a TFSA");
    const tfsaKeys = first.accounts.filter((a: any) => !a.neutral).map((a: any) => a.accountKey);
    const neutralKey = first.accounts.find((a: any) => a.neutral).accountKey;
    const gapKey = first.missing.find((m: any) => m.kind === "coverage").accountKey;
    const ambiguousKey = first.ledger.rows.find((r: any) => r.assumed).activityKey;
    const tfsa = { type: "tax_year", key: `${first.year}:tfsa` };

    await remember({ node: tfsa, property: "tax_year.cra_room_jan1", value: { amountCad: 20000 } });
    await remember({ node: tfsa, property: "tax_year.account_set", value: { connected: tfsaKeys, outside: [{ label: "Questrade TFSA" }], notTfsa: [neutralKey], confirmedAt: "2026-10-24T15:00:00.000Z" } });
    await remember({ node: { type: "activity", key: ambiguousKey }, property: "activity.room_effect", value: { effect: "none" } });
    await remember({ node: { type: "account", key: gapKey }, property: "account.ytd_contributions", value: { year: 2026, amountCad: 2500, asOf: "2026-10-24" } });

    const second = await room();
    expect(second.missing).toEqual([{ kind: "outside_contributions", label: "Questrade TFSA", accountKey: "outside:questrade-tfsa" }]);
    // The assistant writes the outside account the way the user named it.
    await remember({ node: { type: "account", key: "outside:Questrade TFSA" }, property: "account.ytd_contributions", value: { year: 2026, amountCad: 500, asOf: "2026-09-30" } });

    const last = await room();
    expect(last).toMatchObject({ status: "known", craRoomCad: 20000, contributedCad: 4000, roomLeftCad: 16000 });
    expect(last.accounts.filter((a: any) => a.inSet).map((a: any) => a.accountKey).sort()).toEqual([...tfsaKeys].sort());
  });
});

describe("get_contribution_room: stale activity", () => {
  it("withholds the number while the TFSA's activity is out of date, and says when it was last updated", async () => {
    const { client } = await connect({ facts: [craFact(7000), setFact()], sync: { lastSyncedAt: new Date("2026-10-16T15:00:00Z"), lastError: null, dirty: false } });
    const result = await client.callTool({ name: "get_contribution_room", arguments: {} });
    expect((result.structuredContent as any).missing).toEqual([{ kind: "stale_activity", accountKey: accountKey(TFSA_ID), label: "Synthetic Broker TFSA", lastSyncedAt: "2026-10-16T15:00:00.000Z" }]);
    expect(texts(result)[0]!.split("\n").slice(0, 2)).toEqual([
      "I can't give a number yet:",
      "- Synthetic Broker TFSA's activity was last updated 16 October 2026, 11:00 a.m. Toronto time; I'll have a number after it refreshes.",
    ]);
  });
});

describe("get_contribution_room: a confirmed TFSA disconnects (end to end through tool outputs only)", () => {
  const MAIN_ID = "synthetic-acct-dc-main";
  const GONE_ID = "synthetic-acct-dc-gone";
  const account = (id: string) => ({
    snapTradeAccountId: id, displayName: null, institutionName: "Synthetic Broker", rawType: "TFSA", status: "OPEN",
    snapshots: [{ payload: { account: { type: "TFSA", metaType: null, unifiedType: null, status: "OPEN" }, positions: [] } }],
  });
  const fresh = { backfillCompletedAt: day("2026-02-01"), earliestTradeDate: day("2023-05-01"), lastSyncedAt: new Date("2026-10-24T08:00:00Z"), lastError: null, dirty: false };

  it("asks for the vanished account's contributions, accepts them on its key, and counts them", async () => {
    let connected = [MAIN_ID, GONE_ID];
    const rows = [
      { snapTradeAccountId: MAIN_ID, dedupeKey: "synthetic-dc-1", type: "CONTRIBUTION", amount: 1000, currency: "CAD", fxRate: null, tradeDate: day("2026-04-01") },
      { snapTradeAccountId: GONE_ID, dedupeKey: "synthetic-dc-2", type: "CONTRIBUTION", amount: 3000, currency: "CAD", fxRate: null, tradeDate: day("2026-05-01") },
    ];
    const dcLinks: BrokerageLinks = {
      accountsHoldingSecurity: async () => [], tfsaAccounts: async () => connected, accountIds: async () => connected,
      activityDedupeKeys: async () => rows.filter((r) => connected.includes(r.snapTradeAccountId)).map((r) => r.dedupeKey),
    };
    // Disconnecting cascades the account, its activity and its sync state away.
    const prisma: RoomPrismaPort = {
      brokerageAccount: { findMany: async () => connected.map(account) },
      activity: { findMany: async () => rows.filter((r) => connected.includes(r.snapTradeAccountId)) as never },
      activitySyncState: { findMany: async () => connected.map((id) => ({ snapTradeAccountId: id, ...fresh })) },
    };
    const repository = new MemoryFactRepository();
    const service = new MemoryService({ repository, links: dcLinks, log: () => {}, now: () => NOW });
    const server = createPortfolioMcpServer({
      authSubject: SUBJECT, scopes: ["portfolio:read", "memory"],
      portfolio: { getPortfolio: vi.fn() }, history: { getAccountHistory: vi.fn() },
      memory: { service, links: dcLinks, now: () => NOW },
      room: { loader: { prisma, memory: repository }, context: { repository, links: dcLinks, now: () => NOW }, now: () => NOW, log: () => {} },
      clientKey: "https://claude.ai/oauth/mcp-oauth-client-metadata",
    } as never);
    const client = new Client({ name: "synthetic-host", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const room = async () => client.callTool({ name: "get_contribution_room", arguments: {} });
    const remember = (args: Record<string, unknown>) =>
      client.callTool({ name: "remember", arguments: { kind: "fact", provenance: "stated", text: "Synthetic answer.", ...args } });

    const first = (await room()).structuredContent as any;
    const keys = first.accounts.map((a: any) => a.accountKey);
    const tfsa = { type: "tax_year", key: `${first.year}:tfsa` };
    expect(texts(await remember({ node: tfsa, property: "tax_year.cra_room_jan1", value: { amountCad: 10000 } }))[0]).toMatch(/^Saved/);
    expect(texts(await remember({ node: tfsa, property: "tax_year.account_set", value: { connected: keys, outside: [], confirmedAt: "2026-10-24T15:00:00.000Z" } }))[0]).toMatch(/^Saved/);
    expect((await room()).structuredContent).toMatchObject({ status: "known", contributedCad: 4000, roomLeftCad: 6000 });

    connected = [MAIN_ID];
    const gone = await room();
    const goneKey = keys.find((k: string) => k !== accountKey(MAIN_ID));
    expect((gone.structuredContent as any).missing).toEqual([{ kind: "disconnected_account", accountKey: goneKey }]);
    expect(texts(gone)[0]).toContain(`- An account you confirmed as a TFSA (key ${goneKey}) is no longer connected. How much did you contribute to it this year?`);

    // A key that was never confirmed is still refused.
    const stranger = await remember({ node: { type: "account", key: accountKey("synthetic-acct-never") }, property: "account.ytd_contributions", value: { year: 2026, amountCad: 1, asOf: "2026-10-24" } });
    expect(stranger.isError).toBe(true);
    expect(texts(stranger)[0]).toMatch(/^Not saved: That account isn't one of the user's connected accounts/);

    expect(texts(await remember({ node: { type: "account", key: goneKey }, property: "account.ytd_contributions", value: { year: 2026, amountCad: 3000, asOf: "2026-10-24" } }))[0]).toMatch(/^Saved/);
    const last = await room();
    expect(last.structuredContent).toMatchObject({ status: "known", contributedCad: 4000, roomLeftCad: 6000 });
    expect(texts(last)[0]).toContain(goneKey);
  });
});

describe("newYearText: the New Year check (owner ruling 2026-11-03)", () => {
  const row = (date: string, amountCad: number, countedIn: number, mayCountIn: number, label = "Synthetic TFSA") =>
    ({ date, label, amountCad, estimated: false, rateDate: null, native: { amount: amountCad, currency: "CAD" }, countedIn, mayCountIn });

  it("one of last December's contributions: counted last year here, and this year's room up to that much lower if recorded this year", () => {
    expect(newYearText([row("2026-12-29", 180, 2026, 2027)], "TFSA", 2027)).toBe(
      "Near New Year: 29 December 2026 · Synthetic TFSA · +$180 is counted in 2026 here, but your brokerage may record it in 2027. "
      + "If it does, your 2027 TFSA room is up to $180 lower than shown. Check the date your brokerage shows for it.",
    );
  });

  it("several: each with its years, then what each direction could change", () => {
    expect(newYearText([row("2026-12-29", 180, 2026, 2027), row("2026-12-30", 51.65, 2026, 2027), row("2027-01-01", 100, 2027, 2026)], "TFSA", 2027)).toBe(
      "Near New Year, these are counted by their date here, but your brokerage may record them in the neighbouring year: "
      + "29 December 2026 · Synthetic TFSA · +$180 (counted in 2026; may be 2027); 30 December 2026 · Synthetic TFSA · +$51.65 (counted in 2026; may be 2027); "
      + "1 January 2027 · Synthetic TFSA · +$100 (counted in 2027; may be 2026). "
      + "If the 2026 ones are recorded in 2027, your 2027 TFSA room is up to $231.65 lower than shown. "
      + "If the 2027 ones are recorded in another year, it is up to $100 higher. Check the dates your brokerage shows for them.",
    );
  });

  it("this year's own late-December one: this year's room up to that much higher", () => {
    expect(newYearText([row("2027-12-30", 250, 2027, 2028, "Synthetic FHSA")], "FHSA", 2027)).toBe(
      "Near New Year: 30 December 2027 · Synthetic FHSA · +$250 is counted in 2027 here, but your brokerage may record it in 2028. "
      + "If it does, your 2027 FHSA room is up to $250 higher than shown. Check the date your brokerage shows for it.",
    );
  });

  it("nothing near New Year: no text", () => {
    expect(newYearText(undefined, "TFSA", 2027)).toBeNull();
    expect(newYearText([], "TFSA", 2027)).toBeNull();
  });

  it("is in the TFSA and FHSA answers", () => {
    const noFx = { estimated: false, rateDates: [] as string[], native: [] as Array<{ amount: number; currency: string }> };
    const shown = {
      year: 2027, withdrawnCad: 0, returningCad: 0, basis: [] as string[], fx: { contributions: noFx, withdrawals: noFx }, ledger: { rows: [], overSince: null, undatedExcess: false },
      status: "known", roomLeftCad: 7500, contributedCad: 0, craRoomCad: 7500, estimated: false, overLimitCad: 0, activityAsOf: null, headlineBasis: "Based on your connected TFSAs",
      newYear: [row("2026-12-29", 180, 2026, 2027)],
    } as unknown as RoomResult;
    expect(roomText(shown).split("\n")).toContain(newYearText([row("2026-12-29", 180, 2026, 2027)], "TFSA", 2027));
    const fhsa = {
      status: "known", year: 2027, roomLeftCad: 8000, contributedCad: 0, participationRoomCad: 8000, withdrawnCad: 0, estimated: false, basis: [], overLimitCad: 0,
      activityAsOf: null, ledger: { rows: [], overSince: null, undatedExcess: false }, headlineBasis: "Based on your connected FHSAs", fx: { contributions: noFx, withdrawals: noFx },
      newYear: [row("2026-12-30", 2000, 2026, 2027, "Synthetic FHSA")],
    } as unknown as Parameters<typeof fhsaText>[0];
    expect(fhsaText(fhsa)).toContain(newYearText([row("2026-12-30", 2000, 2026, 2027, "Synthetic FHSA")], "FHSA", 2027)!);
  });
});
