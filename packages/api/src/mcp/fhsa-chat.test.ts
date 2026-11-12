import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { BrokerageLinks } from "../memory/context-builder.js";
import { MemoryService } from "../memory/memory-service.js";
import type { RoomPrismaPort } from "../room/room-loader.js";
import { MemoryFactRepository } from "../testing/memory-fact-repository.js";
import { createPortfolioMcpServer } from "./portfolio-mcp-server.js";
import { fhsaHeadline, fhsaText } from "./room-tools.js";

// Synthetic ids, labels and amounts only.
const SUBJECT = "subject|synthetic-fhsa-chat";
const TFSA_ID = "synthetic-acct-tfsa";
const FHSA_ID = "synthetic-acct-fhsa";
const NOW = new Date("2026-10-24T16:00:00Z");
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
type TextBlock = { type: string; text: string };
const firstText = (result: unknown) => ((result as { content?: TextBlock[] }).content ?? []).find((b) => b.type === "text")!.text;
const links: BrokerageLinks = { accountsHoldingSecurity: async () => [], tfsaAccounts: async () => [TFSA_ID], accountIds: async () => [TFSA_ID, FHSA_ID], activityDedupeKeys: async () => [] };

/** failFhsa: the FHSA's sync-state read throws (the TFSA's still answers). */
function prismaPort(withFhsa: boolean, activities: Array<Record<string, unknown>>, failFhsa = false): RoomPrismaPort {
  const account = (id: string, type: string) => ({
    snapTradeAccountId: id, displayName: null, institutionName: "Synthetic Broker", rawType: type, status: "OPEN",
    snapshots: [{ payload: { account: { type, metaType: null, unifiedType: null, status: "OPEN" }, positions: [] } }],
  });
  const sync = (id: string) => ({ snapTradeAccountId: id, backfillCompletedAt: day("2026-02-01"), lastSyncedAt: new Date("2026-10-24T08:00:00Z"), lastError: null, dirty: false });
  return {
    brokerageAccount: { findMany: async () => [account(TFSA_ID, "TFSA"), ...(withFhsa ? [account(FHSA_ID, "FHSA")] : [])] as never },
    activity: {
      findMany: async (input: never) => ("tradeDate" in (input as { where: object }).where ? []
        : activities.filter((a) => (input as { where: { snapTradeAccountId: { in: string[] } } }).where.snapTradeAccountId.in.includes(a.snapTradeAccountId as string))) as never,
    },
    activitySyncState: {
      findMany: async (input: never) => {
        if (failFhsa && (input as { where: { snapTradeAccountId: { in: string[] } } }).where.snapTradeAccountId.in.includes(FHSA_ID)) throw new Error("synthetic read failure");
        return [sync(TFSA_ID), sync(FHSA_ID)] as never;
      },
    },
  };
}

async function call(o: { withFhsa: boolean; fhsaRoom?: number; activities?: Array<Record<string, unknown>>; failFhsa?: boolean; log?: (e: unknown) => void }) {
  const repository = new MemoryFactRepository();
  const service = new MemoryService({ repository, links, log: () => {}, now: () => NOW });
  await service.remember(SUBJECT, { node: { type: "tax_year", key: "2026:tfsa" }, property: "tax_year.cra_room_jan1", value: { amountCad: 7000 }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW, "system");
  if (o.fhsaRoom !== undefined) {
    await service.remember(SUBJECT, { node: { type: "tax_year", key: "2026:fhsa" }, property: "tax_year.fhsa_room", value: { amountCad: o.fhsaRoom }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW, "system");
  }
  const server = createPortfolioMcpServer({
    authSubject: SUBJECT, scopes: ["portfolio:read", "memory"],
    portfolio: { getPortfolio: vi.fn(async () => { throw new Error("the brokerage is not read"); }) },
    history: { getAccountHistory: vi.fn(async () => ({})) },
    memory: { service, links },
    room: { loader: { prisma: prismaPort(o.withFhsa, o.activities ?? [], o.failFhsa), memory: repository }, context: { repository, links, now: () => NOW }, now: () => NOW, ...(o.log ? { log: o.log } : {}) },
  } as never);
  const client = new Client({ name: "synthetic-host", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client.callTool({ name: "get_contribution_room", arguments: {} });
}
const fhsaRow = (dedupeKey: string, amount: number, tradeDate: string) => ({ snapTradeAccountId: FHSA_ID, dedupeKey, type: "CONTRIBUTION", amount, currency: "CAD", fxRate: null, tradeDate: day(tradeDate) });

describe("get_contribution_room: the FHSA line", () => {
  it("no FHSA: no FHSA line and no fhsa field", async () => {
    const result = await call({ withFhsa: false });
    expect(firstText(result)).not.toContain("FHSA");
    expect(result.structuredContent).not.toHaveProperty("fhsa");
  });

  it("an FHSA without its room: one line asking for the participation room", async () => {
    const result = await call({ withFhsa: true });
    const lines = firstText(result).split("\n");
    expect(lines.filter((l) => l.includes("FHSA"))).toEqual([
      "FHSA: I can't give a number yet: What is your FHSA participation room for 2026? It's in CRA My Account or on your notice of assessment; give it as CRA shows it, not one you've worked out. An amount over from last year isn't included; CRA My Account shows it.",
    ]);
    expect(lines.at(-1)).toMatch(/^FHSA: /);
    expect(result.structuredContent).toMatchObject({ fhsa: { status: "missing", year: 2026, missing: [{ kind: "fhsa_room" }], headline: "I can't give a number yet" } });
  });

  it("an FHSA over its room: the amount, the date it went over and the CRA fact", async () => {
    const result = await call({ withFhsa: true, fhsaRoom: 8000, activities: [fhsaRow("synthetic-fhsa-a", 5000, "2026-02-03"), fhsaRow("synthetic-fhsa-b", 4000, "2026-06-10")] });
    expect(firstText(result).split("\n").at(-1)).toBe(
      "FHSA: About $1,000 over your FHSA room since 10 June. CRA charges 1% a month on the highest amount over in each month. Check your figures in CRA My Account. Based on activity up to 24 October 2026; deposits made since then aren't included. An amount over from last year isn't included; CRA My Account shows it.");
    const sc = result.structuredContent as { fhsa: Record<string, unknown> };
    expect(sc.fhsa).toMatchObject({ status: "known", overLimitCad: 1000, headline: "About $1,000 over your FHSA room since 10 June" });
    expect(sc.fhsa).not.toHaveProperty("ledger");
  });

  it("an FHSA with room left", async () => {
    const result = await call({ withFhsa: true, fhsaRoom: 8000, activities: [fhsaRow("synthetic-fhsa-a", 3000, "2026-02-03")] });
    expect(firstText(result).split("\n").at(-1)).toBe("FHSA: About $5,000 of FHSA room left this year. Based on your connected FHSAs. Based on activity up to 24 October 2026; deposits made since then aren't included. An amount over from last year isn't included; CRA My Account shows it.");
  });

  it("a withdrawal: the taxable-withdrawals line is in the text and the structured disclosures", async () => {
    const withdrawal = { snapTradeAccountId: FHSA_ID, dedupeKey: "synthetic-fhsa-w", type: "WITHDRAWAL", amount: -200, currency: "CAD", fxRate: null, tradeDate: day("2026-05-01") };
    const result = await call({ withFhsa: true, fhsaRoom: 8000, activities: [fhsaRow("synthetic-fhsa-a", 3000, "2026-02-03"), withdrawal] });
    expect(firstText(result).split("\n").at(-1)).toBe("FHSA: About $5,000 of FHSA room left this year. Based on your connected FHSAs. Based on activity up to 24 October 2026; deposits made since then aren't included. Withdrawals are counted as taxable withdrawals. An amount over from last year isn't included; CRA My Account shows it.");
    expect((result.structuredContent as { fhsa: { disclosures: string[] } }).fhsa.disclosures).toEqual([
      "Based on activity up to 24 October 2026; deposits made since then aren't included", "Withdrawals are counted as taxable withdrawals", "An amount over from last year isn't included; CRA My Account shows it.",
    ]);
  });

  it("an error loading the FHSA drops the FHSA part, keeps the TFSA answer and logs a code", async () => {
    const log = vi.fn();
    const result = await call({ withFhsa: true, fhsaRoom: 8000, failFhsa: true, log });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toMatch(/TFSA room left this year/);
    expect(firstText(result)).not.toContain("FHSA");
    expect(result.structuredContent).not.toHaveProperty("fhsa");
    expect(log).toHaveBeenCalledWith({ event: "fhsa_room", status: "error" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic");
  });
});

describe("fhsaText and fhsaHeadline", () => {
  const fx = { contributions: { estimated: false, rateDates: [], native: [] }, withdrawals: { estimated: false, rateDates: [], native: [] } };
  const missing = (m: unknown[]) => ({ status: "missing" as const, year: 2026, missing: m as never, withdrawnCad: 0, basis: [], ledger: { rows: [], overSince: null, undatedExcess: false }, fx, fxDates: [] });

  it("words every missing kind as one line, with no advice words", () => {
    const text = fhsaText(missing([
      { kind: "fhsa_room" }, { kind: "coverage", label: "Synthetic FHSA", accountKey: "1111111111111111" },
      { kind: "stale_activity", label: "Synthetic FHSA", accountKey: "1111111111111111", lastSyncedAt: null },
      { kind: "ambiguous", count: 1, rows: [{ activityKey: "2222222222222222", date: "2026-03-03", amountCad: 100, estimated: false, rateDate: null, native: null, type: "SOMETHING_NEW", label: "Synthetic FHSA" }] },
    ]));
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toContain("How much have you contributed to Synthetic FHSA (account key 1111111111111111) this year, and as of what date?");
    expect(text).toContain("Synthetic FHSA's activity hasn't been loaded yet; I'll have a number after it refreshes.");
    expect(text).toContain("Was the SOMETHING_NEW of $100 on 2026-03-03 (Synthetic FHSA) a contribution to your FHSA?");
    for (const word of ["should", "consider", "you can contribute", "we recommend"]) expect(text.toLowerCase()).not.toContain(word);
    expect(fhsaHeadline(missing([{ kind: "fhsa_room" }]))).toBe("I can't give a number yet");
  });
});
