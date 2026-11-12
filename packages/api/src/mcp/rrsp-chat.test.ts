import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { BrokerageLinks } from "../memory/context-builder.js";
import { MemoryService } from "../memory/memory-service.js";
import type { RoomPrismaPort } from "../room/room-loader.js";
import { RRSP_CRA_FACT, RRSP_DEDUCT_LATER, RRSP_ELSEWHERE_QUESTION, RRSP_LIMIT_PROMPT, RRSP_UNUSED_QUESTION, type RrspYear } from "../room/rrsp-room.js";
import { MemoryFactRepository } from "../testing/memory-fact-repository.js";
import { createPortfolioMcpServer } from "./portfolio-mcp-server.js";
import { rrspHeadline, rrspText } from "./room-tools.js";

// Synthetic ids, labels and amounts only.
const SUBJECT = "subject|synthetic-rrsp-chat";
const TFSA_ID = "synthetic-acct-tfsa";
const RRSP_ID = "synthetic-acct-rrsp";
const NOW = new Date("2026-10-24T16:00:00Z");
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
type TextBlock = { type: string; text: string };
const firstText = (result: unknown) => ((result as { content?: TextBlock[] }).content ?? []).find((b) => b.type === "text")!.text;
const links: BrokerageLinks = { accountsHoldingSecurity: async () => [], tfsaAccounts: async () => [TFSA_ID], accountIds: async () => [TFSA_ID, RRSP_ID], activityDedupeKeys: async () => [] };

/** failRrsp: the RRSP's sync-state read throws (the TFSA's still answers). */
function prismaPort(withRrsp: boolean, activities: Array<Record<string, unknown>>, failRrsp = false): RoomPrismaPort {
  const account = (id: string, type: string) => ({
    snapTradeAccountId: id, displayName: null, institutionName: "Synthetic Broker", rawType: type, status: "OPEN",
    snapshots: [{ payload: { account: { type, metaType: null, unifiedType: null, status: "OPEN" }, positions: [] } }],
  });
  const sync = (id: string) => ({ snapTradeAccountId: id, backfillCompletedAt: day("2026-02-01"), lastSyncedAt: new Date("2026-10-24T08:00:00Z"), lastError: null, dirty: false });
  return {
    brokerageAccount: { findMany: async () => [account(TFSA_ID, "TFSA"), ...(withRrsp ? [account(RRSP_ID, "RRSP")] : [])] as never },
    activity: {
      findMany: async (input: never) => ("tradeDate" in (input as { where: object }).where ? []
        : activities.filter((a) => (input as { where: { snapTradeAccountId: { in: string[] } } }).where.snapTradeAccountId.in.includes(a.snapTradeAccountId as string))) as never,
    },
    activitySyncState: {
      findMany: async (input: never) => {
        if (failRrsp && (input as { where: { snapTradeAccountId: { in: string[] } } }).where.snapTradeAccountId.in.includes(RRSP_ID)) throw new Error("synthetic read failure");
        return [sync(TFSA_ID), sync(RRSP_ID)] as never;
      },
    },
  };
}

async function call(o: { withRrsp: boolean; limit?: number; unused?: number; elsewhere?: number; activities?: Array<Record<string, unknown>>; failRrsp?: boolean; log?: (e: unknown) => void }) {
  const repository = new MemoryFactRepository();
  const service = new MemoryService({ repository, links, log: () => {}, now: () => NOW });
  const save = (key: string, property: string, amountCad: number) =>
    service.remember(SUBJECT, { node: { type: "tax_year", key }, property, value: { amountCad }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW, "system");
  await save("2026:tfsa", "tax_year.cra_room_jan1", 7000);
  if (o.limit !== undefined) await save("2026:rrsp", "tax_year.rrsp_deduction_limit", o.limit);
  if (o.unused !== undefined) await save("2026:rrsp", "tax_year.rrsp_unused_contributions", o.unused);
  if (o.elsewhere !== undefined) await save("2026:rrsp", "tax_year.rrsp_elsewhere", o.elsewhere);
  const server = createPortfolioMcpServer({
    authSubject: SUBJECT, scopes: ["portfolio:read", "memory"],
    portfolio: { getPortfolio: vi.fn(async () => { throw new Error("the brokerage is not read"); }) },
    history: { getAccountHistory: vi.fn(async () => ({})) },
    memory: { service, links },
    room: { loader: { prisma: prismaPort(o.withRrsp, o.activities ?? [], o.failRrsp), memory: repository }, context: { repository, links, now: () => NOW }, now: () => NOW, ...(o.log ? { log: o.log } : {}) },
  } as never);
  const client = new Client({ name: "synthetic-host", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client.callTool({ name: "get_contribution_room", arguments: {} });
}
const rrspRow = (dedupeKey: string, amount: number, tradeDate: string) => ({ snapTradeAccountId: RRSP_ID, dedupeKey, type: "CONTRIBUTION", amount, currency: "CAD", fxRate: null, tradeDate: day(tradeDate) });
const rrspLine = (result: unknown) => firstText(result).split("\n").filter((l) => l.startsWith("RRSP: "));
const FRESH = "Based on activity up to 24 October 2026; deposits made since then aren't included.";
const WINDOW = "Contributions for 2026: 2026-03-03 to CRA's deadline (not yet published).";

describe("get_contribution_room: the RRSP line", () => {
  it("no RRSP: no RRSP text and no rrsp field", async () => {
    const result = await call({ withRrsp: false });
    expect(firstText(result)).not.toContain("RRSP");
    expect(result.structuredContent).not.toHaveProperty("rrsp");
  });

  it("an RRSP without a limit: the contributions only, the limit prompt and the deduct-later line", async () => {
    const result = await call({ withRrsp: true, activities: [rrspRow("synthetic-rrsp-a", 3000, "2026-05-01")] });
    expect(rrspLine(result)).toEqual([`RRSP: $3,000 contributed for the 2026 tax year. ${WINDOW} ${RRSP_LIMIT_PROMPT} ${FRESH} ${RRSP_DEDUCT_LATER}`]);
    expect(firstText(result).split("\n").at(-1)).toMatch(/^RRSP: /);
    expect(firstText(result)).toContain(RRSP_DEDUCT_LATER);
    const sc = result.structuredContent as { rrsp: { status: string; years: Array<Record<string, unknown>>; line: string } };
    expect(sc.rrsp).toMatchObject({ status: "shown", line: rrspLine(result)[0], years: [{ contributedCad: 3000, limitCad: null, roomLeftCad: null, headline: "$3,000 contributed for the 2026 tax year", window: { taxYear: 2026 } }] });
    expect(sc.rrsp.years[0]).not.toHaveProperty("ledger");
    expect(sc).toHaveProperty("rrsp");
  });

  it("with the limit only: the contributions, both figures asked, no room left (R11)", async () => {
    const result = await call({ withRrsp: true, limit: 10000, activities: [rrspRow("synthetic-rrsp-a", 3000, "2026-05-01")] });
    expect(rrspLine(result)).toEqual([
      `RRSP: $3,000 contributed for the 2026 tax year. ${WINDOW} ${RRSP_UNUSED_QUESTION(2026)} ${RRSP_ELSEWHERE_QUESTION(2026)} ${FRESH} ${RRSP_DEDUCT_LATER}`,
    ]);
    expect(rrspLine(result)[0]).not.toContain("room left for 2026");
    const sc = result.structuredContent as { rrsp: { years: Array<Record<string, unknown>> } };
    expect(sc.rrsp.years[0]).toMatchObject({
      limitCad: 10000, roomLeftCad: null, overLimitCad: null, headline: "$3,000 contributed for the 2026 tax year",
      missing: [{ kind: "unused_contributions" }, { kind: "elsewhere" }],
    });
  });

  it("with the limit, unused contributions and contributions elsewhere (0 counts): the room left", async () => {
    const result = await call({ withRrsp: true, limit: 10000, unused: 0, elsewhere: 0, activities: [rrspRow("synthetic-rrsp-a", 3000, "2026-05-01")] });
    expect(rrspLine(result)).toEqual([
      `RRSP: $7,000 of RRSP deduction room left for 2026. $3,000 contributed plus $0 you entered as contributions not in VestLens. ${WINDOW} ${FRESH} ${RRSP_DEDUCT_LATER}`,
    ]);
    expect((result.structuredContent as { rrsp: { years: Array<{ headline: string }> } }).rrsp.years[0]!.headline).toBe("$7,000 of RRSP deduction room left for 2026");
  });

  it("over the limit: the amount over and the CRA fact", async () => {
    const result = await call({ withRrsp: true, limit: 2000, unused: 0, elsewhere: 0, activities: [rrspRow("synthetic-rrsp-a", 3000, "2026-05-01")] });
    expect(rrspLine(result)).toEqual([
      `RRSP: $1,000 over your RRSP deduction limit for 2026. $3,000 contributed plus $0 you entered as contributions not in VestLens. ${WINDOW} ${RRSP_CRA_FACT} ${FRESH} ${RRSP_DEDUCT_LATER}`,
    ]);
    // Over by the limit alone, but no over line or CRA fact until all three figures are stated.
    const limitOnly = await call({ withRrsp: true, limit: 2000, activities: [rrspRow("synthetic-rrsp-a", 3000, "2026-05-01")] });
    expect(rrspLine(limitOnly)[0]).not.toContain("over your RRSP deduction limit");
    expect(rrspLine(limitOnly)[0]).not.toContain(RRSP_CRA_FACT);
  });

  it("contributions entered elsewhere are named after the contributed amount, not folded into it", async () => {
    const result = await call({ withRrsp: true, elsewhere: 500, activities: [rrspRow("synthetic-rrsp-a", 3000, "2026-05-01")] });
    expect(rrspLine(result)[0]).toContain("RRSP: $3,000 contributed for the 2026 tax year plus $500 you entered as contributions not in VestLens.");
    const withLimit = await call({ withRrsp: true, limit: 10000, unused: 0, elsewhere: 0, activities: [rrspRow("synthetic-rrsp-a", 3000, "2026-05-01")] });
    expect(rrspLine(withLimit)[0]).toContain("RRSP: $7,000 of RRSP deduction room left for 2026. $3,000 contributed plus $0 you entered as contributions not in VestLens.");
  });

  it("an error loading the RRSP drops the RRSP part, keeps the TFSA answer and logs a code", async () => {
    const log = vi.fn();
    const result = await call({ withRrsp: true, limit: 10000, failRrsp: true, log });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toMatch(/TFSA room left this year/);
    expect(firstText(result)).not.toContain("RRSP");
    expect(result.structuredContent).not.toHaveProperty("rrsp");
    expect(log).toHaveBeenCalledWith({ event: "rrsp_room", status: "error" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic");
  });
});

describe("rrspText and rrspHeadline", () => {
  const fx = { contributions: { estimated: false, rateDates: [], native: [] }, withdrawals: { estimated: false, rateDates: [], native: [] } };
  const year = (over: Partial<RrspYear>): RrspYear => ({
    window: { taxYear: 2026, from: "2026-03-03", to: null }, contributedCad: 3000, limitCad: 10000, unusedCad: null, elsewhereCad: null,
    roomLeftCad: 7000, overLimitCad: 0, estimated: false, missing: [], basis: ["Contributions for 2026: 2026-03-03 to CRA's deadline (not yet published)"],
    ledger: { rows: [], overSince: null, undatedExcess: false }, fx, fxDates: [], ...over,
  });
  const shown = (years: RrspYear[]) => ({ status: "shown" as const, years, activityAsOf: null });

  it("headline precedence: missing items, then no limit, then over, then room left", () => {
    expect(rrspHeadline(year({}))).toBe("$7,000 of RRSP deduction room left for 2026");
    expect(rrspHeadline(year({ roomLeftCad: 0, overLimitCad: 250 }))).toBe("$250 over your RRSP deduction limit for 2026");
    expect(rrspHeadline(year({ limitCad: null, roomLeftCad: null, overLimitCad: null, missing: [{ kind: "deduction_limit" }] }))).toBe("$3,000 contributed for the 2026 tax year");
    expect(rrspHeadline(year({ limitCad: null, roomLeftCad: null, overLimitCad: null, contributedCad: null, missing: [{ kind: "deduction_limit" }, { kind: "coverage", label: "Synthetic RRSP", accountKey: "1111111111111111" }] }))).toBe("I can't give a number for 2026 yet");
    expect(rrspHeadline(year({ roomLeftCad: null, overLimitCad: null, missing: [{ kind: "managed_rrsp", labels: ["Synthetic Managed"] }] }))).toBe("I can't give a number for 2026 yet");
    // The unused and elsewhere figures rank with the limit: the contributions still show.
    expect(rrspHeadline(year({ roomLeftCad: null, overLimitCad: null, missing: [{ kind: "unused_contributions" }, { kind: "elsewhere" }] }))).toBe("$3,000 contributed for the 2026 tax year");
    expect(rrspHeadline(year({ roomLeftCad: null, overLimitCad: null, missing: [{ kind: "elsewhere" }] }))).toBe("$3,000 contributed for the 2026 tax year");
    expect(rrspHeadline(year({ roomLeftCad: null, overLimitCad: null, missing: [{ kind: "unused_contributions" }, { kind: "managed_rrsp", labels: ["Synthetic Managed"] }] }))).toBe("I can't give a number for 2026 yet");
  });

  it("asks the unused and elsewhere figures in CRA's words, with the year", () => {
    const text = rrspText(shown([year({ roomLeftCad: null, overLimitCad: null, missing: [{ kind: "unused_contributions" }, { kind: "elsewhere" }] })]));
    expect(text).toContain("What unused RRSP contributions does CRA show for 2026? It's next to your deduction limit on your notice of assessment and in CRA My Account; enter 0 if there are none.");
    expect(text).toContain("Did you contribute to an RRSP VestLens doesn't see for the 2026 tax year, such as a group RRSP at work, an account at another institution, or a spousal RRSP for your spouse? Enter the total, or 0 if none.");
    expect(text).not.toContain("room left for 2026");
  });

  it("words every missing kind as a question on one line, with no advice words", () => {
    const text = rrspText(shown([
      year({
        contributedCad: null, roomLeftCad: null, overLimitCad: null,
        missing: [
          { kind: "deduction_limit" }, { kind: "managed_rrsp", labels: ["Synthetic Managed A", "Synthetic Managed B"] },
          { kind: "coverage", label: "Synthetic RRSP", accountKey: "1111111111111111" },
          { kind: "stale_activity", label: "Synthetic RRSP", accountKey: "1111111111111111", lastSyncedAt: null },
          { kind: "ambiguous", count: 3, rows: [{ activityKey: "2222222222222222", date: "2026-03-03", amountCad: 100, estimated: false, rateDate: null, native: null, type: "SOMETHING_NEW", label: "Synthetic RRSP" }] },
        ],
      }),
    ]));
    expect(text.split("\n")).toHaveLength(1);
    expect(text.startsWith("RRSP: I can't give a number for 2026 yet.")).toBe(true);
    expect(text).toContain(RRSP_LIMIT_PROMPT);
    expect(text).toContain("Contributions to Synthetic Managed A, Synthetic Managed B aren't visible through SnapTrade. Add them, plus any other RRSP contributions VestLens doesn't see for the 2026 tax year (a group RRSP at work, an account at another institution, a spousal RRSP for your spouse), to 'Contributions not in VestLens'; enter 0 if there are none.");
    expect(text).toContain("Synthetic RRSP's stored activity doesn't reach 3 March 2026 yet; I'll have a number once its full history has loaded.");
    expect(text).not.toContain("How much have you contributed");
    expect(text).not.toContain("1111111111111111");
    expect(text).toContain("Synthetic RRSP's activity hasn't been loaded yet; I'll have a number after it refreshes.");
    expect(text).toContain("Was the SOMETHING_NEW of $100 on 2026-03-03 (Synthetic RRSP) a contribution to your RRSP?");
    expect(text).toContain("2 more need checking after these.");
    expect(text.endsWith(RRSP_DEDUCT_LATER)).toBe(true);
    for (const word of ["should", "consider", "you can contribute", "we recommend"]) expect(text.toLowerCase()).not.toContain(word);
  });

  it("two open years are joined by '; ', previous year first", () => {
    const text = rrspText(shown([
      year({ window: { taxYear: 2025, from: "2025-03-04", to: "2026-03-02" }, roomLeftCad: 500 }),
      year({ roomLeftCad: 7000 }),
    ]));
    expect(text).toContain("$500 of RRSP deduction room left for 2025.");
    expect(text.indexOf("for 2025")).toBeLessThan(text.indexOf("; $7,000 of RRSP deduction room left for 2026"));
  });

  it("converted contributions are marked est. with their rate date", () => {
    const converted = { contributions: { estimated: true, rateDates: ["2026-05-01"], native: [{ amount: 1000, currency: "USD" }] }, withdrawals: fx.withdrawals };
    const text = rrspText(shown([year({ fx: converted, estimated: true, limitCad: null, roomLeftCad: null, overLimitCad: null, missing: [{ kind: "deduction_limit" }] })]));
    expect(text).toContain("$3,000 contributed for the 2026 tax year (est.; includes US$1,000 converted at the Bank of Canada rate of 2026-05-01).");
  });
});
