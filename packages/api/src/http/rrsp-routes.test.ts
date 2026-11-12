import { afterEach, describe, expect, it, vi } from "vitest";

import { OWNER_SUBJECT } from "../identity/owner-identity.js";
import { accountKey, activityKey } from "../memory/keys.js";
import { MemoryService } from "../memory/memory-service.js";
import { RoomAlertService } from "../room/room-alerts.js";
import type { RoomPrismaPort } from "../room/room-loader.js";
import { loopbackRequest } from "../testing/loopback-request.js";
import { memoryOwnerSessions } from "../testing/owner-session-prisma.js";
import { sessionCookieFor } from "../testing/owner-session.js";
import { MemoryFactRepository } from "../testing/memory-fact-repository.js";
import { MemoryRoomAlertPrisma } from "../testing/memory-room-alert-prisma.js";
import { createPortfolioApi } from "./app.js";

// Synthetic identities, ids and amounts only.
const APP = "https://mcp.example.test";
const RESOURCE = "https://mcp.example.test/mcp";
// Every /api caller is the owner.
const ME = OWNER_SUBJECT;
const RRSP_ID = "synthetic-acct-rrsp";
const MANAGED_ID = "synthetic-acct-managed-rrsp";
const TFSA_ID = "synthetic-acct-tfsa";
const NOW = new Date("2026-10-24T16:00:00Z");
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

afterEach(() => { vi.restoreAllMocks(); });

const isCounterpartQuery = (input: unknown) => (input as { where: { OR?: Array<Record<string, unknown>> } }).where.OR?.some((o) => "type" in o) ?? false;

/** ME owns an RRSP, a TFSA and (with `managed`) a managed RRSP; any other subject has nothing. */
function prismaPort(o: { withRrsp: boolean; managed: boolean; closed?: boolean }, activities: Array<Record<string, unknown>>): RoomPrismaPort {
  const mine = (input: { where: { appUser?: { authSubject: string } } }) => input.where.appUser?.authSubject === ME;
  const account = (id: string, type: string, unifiedType: string | null = null, status = "OPEN") => ({
    snapTradeAccountId: id, displayName: null, institutionName: "Synthetic Broker", rawType: type, status, maskedNumber: null, reportedTotal: null, reportedCurrency: null,
    snapshots: [{ payload: { account: { type, metaType: null, unifiedType, status }, positions: [] } }],
  });
  const sync = (id: string) => ({ snapTradeAccountId: id, backfillCompletedAt: day("2025-01-01"), lastSyncedAt: new Date("2026-10-24T08:00:00Z"), lastError: null, dirty: false });
  return {
    brokerageAccount: {
      findMany: async (input: never) => (!mine(input) ? [] : [account(TFSA_ID, "TFSA"), ...(o.withRrsp ? [account(RRSP_ID, "RRSP", null, o.closed ? "CLOSED" : "OPEN")] : []),
        ...(o.managed ? [account(MANAGED_ID, "RRSP", "MANAGED_RRSP")] : [])]) as never,
    },
    activity: {
      findMany: async (input: never) => (!mine(input) ? [] : isCounterpartQuery(input) ? activities.filter((a) => String(a.type).includes("TRANSFER")) : activities) as never,
    },
    activitySyncState: { findMany: async (input: never) => (!mine(input) ? [] : [sync(TFSA_ID), sync(RRSP_ID), sync(MANAGED_ID)]) as never },
  };
}
const links = { accountsHoldingSecurity: async () => [], tfsaAccounts: async () => [TFSA_ID], accountIds: async () => [TFSA_ID, RRSP_ID, MANAGED_ID], activityDedupeKeys: async () => [] };

async function build(o: { withRrsp?: boolean; managed?: boolean; closed?: boolean; activities?: Array<Record<string, unknown>> } = {}) {
  const repository = new MemoryFactRepository();
  const alerts = new RoomAlertService({ prisma: new MemoryRoomAlertPrisma(), now: () => NOW });
  const loader = { prisma: prismaPort({ withRrsp: o.withRrsp !== false, managed: o.managed === true, closed: o.closed === true }, o.activities ?? []), memory: repository };
  const service = new MemoryService({ repository, links, now: () => NOW, log: () => {} });
  // The room routes log through console.info as JSON .
  const logs: unknown[] = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => {
    try { logs.push(JSON.parse(String(line))); } catch { /* not a log line of ours */ }
  });
  const sessions = memoryOwnerSessions();
  const app = createPortfolioApi({
    sessions,
    portfolio: { getPortfolio: vi.fn(async () => ({ connectionRequired: false, generatedAt: NOW.toISOString(), accounts: [], errors: [] })) },
    history: { getAccountHistory: vi.fn(async () => ({})) },
    connections: { getConnections: vi.fn(async () => []), createConnectionPortal: vi.fn(async () => "https://x.invalid") },
    webhooks: { ingest: vi.fn(async () => ({ duplicate: false })) },
    appBaseUrl: APP, mcpResourceUrl: RESOURCE,
    memory: { service, links },
    room: { loader, context: { repository, links, now: () => NOW }, now: () => NOW, alerts },
  } as never);
  return { req: await loopbackRequest(app), auth: async () => ({ Cookie: await sessionCookieFor(sessions), Origin: APP }), service, logs };
}

const IN_KEY = activityKey("synthetic-rrsp-transfer-in");
const OUT_KEY = activityKey("synthetic-rrsp-transfer-out");
const TFSA_KEY = activityKey("synthetic-tfsa-transfer-in");
const DIVIDEND_KEY = activityKey("synthetic-rrsp-dividend");
const activities = [
  { snapTradeAccountId: RRSP_ID, dedupeKey: "synthetic-rrsp-deposit", type: "CONTRIBUTION", amount: 1000, currency: "CAD", fxRate: null, tradeDate: day("2026-05-03") },
  { snapTradeAccountId: RRSP_ID, dedupeKey: "synthetic-rrsp-transfer-in", type: "TRANSFER_IN", amount: 3000, currency: "CAD", fxRate: null, tradeDate: day("2026-06-03") },
  { snapTradeAccountId: RRSP_ID, dedupeKey: "synthetic-rrsp-transfer-out", type: "TRANSFER_OUT", amount: -500, currency: "CAD", fxRate: null, tradeDate: day("2026-07-03") },
  { snapTradeAccountId: RRSP_ID, dedupeKey: "synthetic-rrsp-dividend", type: "DIVIDEND", amount: 12, currency: "CAD", fxRate: null, tradeDate: day("2026-04-01") },
  { snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-tfsa-transfer-in", type: "TRANSFER_IN", amount: 100, currency: "CAD", fxRate: null, tradeDate: day("2026-03-04") },
];
const rowOf = (body: { years: Array<{ ledger: { rows: Array<{ activityKey?: string }> } }> }, key: string) => body.years[0]!.ledger.rows.find((r) => r.activityKey === key);
const amounts = (logs: unknown[]) => JSON.stringify(logs);

describe("GET /api/room/rrsp", () => {
  it("is { status: none } without an RRSP", async () => {
    const { req, auth, logs } = await build({ withRrsp: false });
    expect((await req.get("/api/room/rrsp").set(await auth()).expect(200)).body).toEqual({ status: "none" });
    expect(logs).toContainEqual({ event: "rrsp_room_dashboard", status: "none" });
  });

  it("is the engine's result plus the RRSP accounts (managed flagged), and logs the status only", async () => {
    const { req, auth, logs } = await build({ managed: true, activities });
    const body = (await req.get("/api/room/rrsp").set(await auth()).expect(200)).body;
    expect(body.status).toBe("shown");
    expect(body.years.map((y: { window: { taxYear: number } }) => y.window.taxYear)).toEqual([2026]);
    expect(body.years[0].missing.map((m: { kind: string }) => m.kind)).toContain("deduction_limit");
    expect(body.accounts).toEqual([
      { accountKey: accountKey(RRSP_ID), label: "Synthetic Broker RRSP", maskedNumber: null, value: null, managed: false, closed: false },
      { accountKey: accountKey(MANAGED_ID), label: expect.any(String), maskedNumber: null, value: null, managed: true, closed: false },
    ]);
    expect(logs).toContainEqual({ event: "rrsp_room_dashboard", status: "shown" });
  });

  it("marks a closed RRSP closed, so the page can say so", async () => {
    const { req, auth } = await build({ closed: true, activities });
    const body = (await req.get("/api/room/rrsp").set(await auth()).expect(200)).body;
    expect(body.accounts).toEqual([{ accountKey: accountKey(RRSP_ID), label: expect.any(String), maskedNumber: null, value: null, managed: false, closed: true }]);
  });
});

describe("PUT /api/room/rrsp/deduction-limit", () => {
  it("saves the limit as a stated dashboard fact on <year>:rrsp and answers with the recomputed GET body", async () => {
    const { req, auth, service, logs } = await build({ activities });
    const res = await req.put("/api/room/rrsp/deduction-limit").set(await auth()).send({ year: 2026, amountCad: 30000 }).expect(200);
    expect(res.body).toMatchObject({ status: "shown" });
    expect(res.body.years[0]).toMatchObject({ limitCad: 30000, unusedCad: null });
    const facts = await service.listCurrent(ME);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ node: { type: "tax_year", key: "2026:rrsp" }, property: "tax_year.rrsp_deduction_limit", provenance: "stated", kind: "fact", source: "dashboard", value: { amountCad: 30000 }, text: "RRSP deduction limit of $30,000 for 2026, from CRA." });
    // A saved limit shows in the next GET.
    const next = (await req.get("/api/room/rrsp").set(await auth()).expect(200)).body;
    expect(next.years[0].limitCad).toBe(30000);
    expect(logs).toContainEqual({ event: "room_input_saved", input: "rrsp_limit" });
  });

  it("with unusedCad also saves the unused contributions, both before the one answer", async () => {
    const { req, auth, service, logs } = await build({ activities });
    const res = await req.put("/api/room/rrsp/deduction-limit").set(await auth()).send({ year: 2026, amountCad: 30000, unusedCad: 4000 }).expect(200);
    expect(res.body.years[0]).toMatchObject({ limitCad: 30000, unusedCad: 4000 });
    const facts = await service.listCurrent(ME);
    expect(facts.map((f) => f.property).sort()).toEqual(["tax_year.rrsp_deduction_limit", "tax_year.rrsp_unused_contributions"]);
    expect(facts.find((f) => f.property === "tax_year.rrsp_unused_contributions")).toMatchObject({
      node: { type: "tax_year", key: "2026:rrsp" }, provenance: "stated", source: "dashboard", value: { amountCad: 4000 }, text: "Unused RRSP contributions of $4,000 for 2026, from CRA.",
    });
    expect(logs).toContainEqual({ event: "room_input_saved", input: "rrsp_limit" });
    expect(logs).toContainEqual({ event: "room_input_saved", input: "rrsp_unused" });
  });

  it("a body that does not match is 400 invalid_memory_edit and nothing is stored", async () => {
    const { req, auth, service } = await build();
    for (const body of [{ year: 2026, amountCad: -1 }, { year: 2026, amountCad: 1, unusedCad: -1 }, { year: 2026, amountCad: 1, extra: true }, { amountCad: 1 }, { year: 2008, amountCad: 1 }, { year: 2101, amountCad: 1 }, {}]) {
      const res = await req.put("/api/room/rrsp/deduction-limit").set(await auth()).send(body).expect(400);
      expect(res.body.error).toBe("invalid_memory_edit");
    }
    expect(await service.listCurrent(ME)).toEqual([]);
  });
});

describe("PUT /api/room/rrsp/elsewhere", () => {
  it("saves the contributions not in VestLens on <year>:rrsp and answers with the GET body", async () => {
    const { req, auth, service, logs } = await build({ activities });
    const res = await req.put("/api/room/rrsp/elsewhere").set(await auth()).send({ year: 2026, amountCad: 2500 }).expect(200);
    expect(res.body.years[0].elsewhereCad).toBe(2500);
    const [fact] = await service.listCurrent(ME);
    expect(fact).toMatchObject({ node: { type: "tax_year", key: "2026:rrsp" }, property: "tax_year.rrsp_elsewhere", provenance: "stated", source: "dashboard", value: { amountCad: 2500 }, text: "RRSP contributions of $2,500 for the 2026 tax year not in VestLens." });
    expect(logs).toContainEqual({ event: "room_input_saved", input: "rrsp_elsewhere" });
  });

  it("a bad body is 400 and nothing is stored", async () => {
    const { req, auth, service } = await build();
    for (const body of [{ year: 2026, amountCad: -5 }, { year: 2026 }, { year: 2026, amountCad: 5, unusedCad: 1 }, {}]) {
      await req.put("/api/room/rrsp/elsewhere").set(await auth()).send(body).expect(400);
    }
    expect(await service.listCurrent(ME)).toEqual([]);
  });
});

describe("logs", () => {
  it("carry counts and constant codes only: no amount, label or key", async () => {
    const { req, auth, logs } = await build({ activities });
    await req.get("/api/room/rrsp").set(await auth()).expect(200);
    await req.put("/api/room/rrsp/deduction-limit").set(await auth()).send({ year: 2026, amountCad: 31234.5, unusedCad: 4321.5 }).expect(200);
    await req.put("/api/room/rrsp/elsewhere").set(await auth()).send({ year: 2026, amountCad: 2222.25 }).expect(200);
    await req.put(`/api/room/rrsp/activities/${IN_KEY}`).set(await auth()).send({ effect: "none" }).expect(200);
    const text = amounts(logs);
    for (const secret of ["31234", "4321", "2222", "Synthetic Broker", IN_KEY, RRSP_ID]) expect(text).not.toContain(secret);
    const rrsp = logs.filter((l) => JSON.stringify(l).includes("rrsp"));
    expect(rrsp.length).toBeGreaterThanOrEqual(4);
    for (const l of rrsp) expect(Object.keys(l as object).sort()).toSatisfy((k: string[]) => k.join() === "event,status" || k.join() === "event,input");
  });
});

describe("auth", () => {
  it("answers 401 without a token on every route", async () => {
    const { req } = await build();
    for (const [method, path] of [
      ["get", "/api/room/rrsp"], ["put", "/api/room/rrsp/deduction-limit"], ["put", "/api/room/rrsp/elsewhere"],
      ["put", `/api/room/rrsp/activities/${IN_KEY}`], ["delete", `/api/room/rrsp/activities/${IN_KEY}`],
    ] as const) {
      await req[method](path).send({}).expect(401);
    }
  });
});

describe("PUT and DELETE /api/room/rrsp/activities/:activityKey", () => {
  it("an answer on the caller's own RRSP transfer is stored with RRSP wording and wins; DELETE returns it to the assumption", async () => {
    const { req, auth, service } = await build({ activities });
    const before = (await req.get("/api/room/rrsp").set(await auth()).expect(200)).body;
    expect(rowOf(before, IN_KEY)).toMatchObject({ kind: "contribution", assumed: true });
    const answered = (await req.put(`/api/room/rrsp/activities/${IN_KEY}`).set(await auth()).send({ effect: "none" }).expect(200)).body;
    expect(rowOf(answered, IN_KEY)).toMatchObject({ kind: "none", answered: true });
    const fact = (await service.listCurrent(ME)).find((f) => f.property === "activity.room_effect");
    expect(fact).toMatchObject({ node: { type: "activity", key: IN_KEY }, value: { effect: "none" }, source: "dashboard", text: "A transfer into an RRSP, as you answered: it is not a contribution." });
    await req.put(`/api/room/rrsp/activities/${OUT_KEY}`).set(await auth()).send({ effect: "withdrawal" }).expect(200);
    expect((await service.listCurrent(ME)).find((f) => f.node.key === OUT_KEY)?.text).toBe("A transfer out of an RRSP, as you answered: withdrawal.");
    await req.put(`/api/room/rrsp/activities/${OUT_KEY}`).set(await auth()).send({ effect: "none" }).expect(200);
    expect((await service.listCurrent(ME)).find((f) => f.node.key === OUT_KEY)?.text).toBe("A transfer out of an RRSP, as you answered: moved to another RRSP.");
    const cleared = (await req.delete(`/api/room/rrsp/activities/${IN_KEY}`).set(await auth()).expect(200)).body;
    expect(rowOf(cleared, IN_KEY)).toMatchObject({ kind: "contribution", assumed: true });
  });

  it("an unknown, a malformed, a TFSA or a non-answerable key is 404 and nothing is written", async () => {
    const { req, auth, service } = await build({ activities });
    for (const [, key] of [[ME, activityKey("synthetic-nope")], [ME, "not-a-key"], [ME, TFSA_KEY], [ME, DIVIDEND_KEY]] as const) {
      const put = await req.put(`/api/room/rrsp/activities/${key}`).set(await auth()).send({ effect: "none" }).expect(404);
      expect(put.body).toEqual({ error: "not_found" });
      await req.delete(`/api/room/rrsp/activities/${key}`).set(await auth()).expect(404);
    }
    expect(await service.listCurrent(ME)).toEqual([]);
  });

  it("a direction mismatch or a bad body is 400 and nothing is stored", async () => {
    const { req, auth, service } = await build({ activities });
    for (const [key, body] of [[IN_KEY, { effect: "withdrawal" }], [OUT_KEY, { effect: "contribution" }], [IN_KEY, { effect: "maybe" }], [IN_KEY, {}]] as const) {
      const res = await req.put(`/api/room/rrsp/activities/${key}`).set(await auth()).send(body).expect(400);
      expect(res.body.error).toBe("invalid_memory_edit");
    }
    expect(await service.listCurrent(ME)).toEqual([]);
  });
});
