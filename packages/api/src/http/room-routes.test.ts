import { describe, expect, it, vi } from "vitest";

import { OWNER_SUBJECT } from "../identity/owner-identity.js";
import { accountKey, activityKey } from "../memory/keys.js";
import { MemoryService } from "../memory/memory-service.js";
import { reevaluateRoomAlert, RoomAlertService } from "../room/room-alerts.js";
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
const TFSA_ID = "synthetic-acct-tfsa";
const NOW = new Date("2026-10-24T16:00:00Z");
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
const MINE = accountKey(TFSA_ID);
const TRANSFER_KEY = activityKey("synthetic-dedupe-transfer");
const node = { type: "tax_year" as const, key: "2026:tfsa" };



const transfer = { snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-dedupe-transfer", type: "INTERNAL_CASH_TRANSFER_IN", amount: 5000, currency: "CAD", fxRate: null, tradeDate: day("2026-03-03") };

const CASH_ID = "synthetic-acct-cash";
/** Only ME owns the TFSA (and, with counterparts, a cash account); any other subject has no accounts and no activity. */
const MANAGED_ID = "synthetic-acct-managed-tfsa";
function prismaPort(activities: Array<Record<string, unknown>>, counterparts?: Array<Record<string, unknown>>, managed = false): RoomPrismaPort {
  const mine = (input: { where: { appUser?: { authSubject: string } } }) => input.where.appUser?.authSubject === ME;
  const transfers = (input: { where: Record<string, unknown> }) => "tradeDate" in input.where;
  const account = (id: string, type: string, masked: string | null, unifiedType: string | null = null) => ({
    snapTradeAccountId: id, displayName: null, institutionName: "Synthetic Broker", rawType: type, status: "OPEN",
    maskedNumber: masked, reportedTotal: "1234.5", reportedCurrency: "CAD",
    snapshots: [{ payload: { account: { type, metaType: null, unifiedType, status: "OPEN" }, positions: [] } }],
  });
  return {
    brokerageAccount: {
      findMany: async (input: never) => !mine(input) ? [] : [
        account(TFSA_ID, "TFSA", "****4321"), ...(counterparts ? [account(CASH_ID, "MSB", null)] : []), ...(managed ? [account(MANAGED_ID, "TFSA", null, "MANAGED_TFSA")] : []),
      ] as never,
    },
    activity: { findMany: async (input: never) => (!mine(input) ? [] : transfers(input) ? counterparts ?? activities : activities) as never },
    activitySyncState: { findMany: async (input: never) => !mine(input) ? [] : [{ snapTradeAccountId: TFSA_ID, backfillCompletedAt: day("2026-02-01"), earliestTradeDate: day("2023-05-01"), lastSyncedAt: new Date("2026-10-24T08:00:00Z"), lastError: null, dirty: false }] },
  };
}
const links = { accountsHoldingSecurity: async () => [], tfsaAccounts: async () => [TFSA_ID, MANAGED_ID], accountIds: async () => [TFSA_ID, MANAGED_ID], activityDedupeKeys: async () => [] };

async function build(o: { activities?: Array<Record<string, unknown>>; counterparts?: Array<Record<string, unknown>>; managed?: boolean } = {}) {
  const repository = new MemoryFactRepository();
  const alerts = new RoomAlertService({ prisma: new MemoryRoomAlertPrisma(), now: () => NOW });
  const loader = { prisma: prismaPort(o.activities ?? [], o.counterparts, o.managed), memory: repository };
  const reserved = vi.fn((subject: string) => reevaluateRoomAlert({ loader, alerts, now: () => NOW }, subject));
  const service = new MemoryService({ repository, links, now: () => NOW, log: () => {}, onReservedChange: reserved });
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
  const req = await loopbackRequest(app);
  const auth = async () => ({ Cookie: await sessionCookieFor(sessions), Origin: APP });
  return { req, auth, service, reserved };
}

describe("GET /api/room/tfsa", () => {
  it("includes ledger, accounts and outcomes", async () => {
    const { req, auth, service } = await build({ activities: [transfer] });
    await service.remember(ME, { node, property: "tax_year.account_set", value: { connected: [MINE], outside: [], confirmedAt: "2026-02-01T15:00:00.000Z" }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    await service.remember(ME, { node, property: "tax_year.cra_room_jan1", value: { amountCad: 7000 }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    const res = await req.get("/api/room/tfsa").set(await auth()).expect(200);
    // The unmatched transfer is assumed a contribution (owner ruling 2026-10-26): known, and no outcome to preview.
    expect(res.body).toMatchObject({ status: "known", roomLeftCad: 2000, headlineBasis: "Based on your connected TFSAs" });
    expect(res.body.ledger.rows.find((r: { activityKey?: string }) => r.activityKey === TRANSFER_KEY)).toMatchObject({ kind: "contribution", assumed: true });
    expect(res.body.accounts).toEqual([expect.objectContaining({ accountKey: MINE, inSet: true })]);
    expect(res.body.outcomes).toEqual({});
    expect(res.body.alert).toBeNull();
    expect(res.body.accountSet).toEqual({ connected: [MINE], notTfsa: [], outside: [] });
  });

  it("an answer overrides the assumed transfer, and clearing it returns the row to the assumption", async () => {
    const { req, auth, service } = await build({ activities: [transfer] });
    await service.remember(ME, { node, property: "tax_year.cra_room_jan1", value: { amountCad: 7000 }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    const answered = (await req.put(`/api/room/tfsa/activities/${TRANSFER_KEY}`).set(await auth()).send({ effect: "none" }).expect(200)).body;
    expect(answered.ledger.rows.find((r: { activityKey?: string }) => r.activityKey === TRANSFER_KEY)).toMatchObject({ kind: "none", answered: true });
    expect(answered.roomLeftCad).toBe(7000);
    const cleared = (await req.delete(`/api/room/tfsa/activities/${TRANSFER_KEY}`).set(await auth()).expect(200)).body;
    expect(cleared.ledger.rows.find((r: { activityKey?: string }) => r.activityKey === TRANSFER_KEY)).toMatchObject({ kind: "contribution", assumed: true });
    expect(cleared.roomLeftCad).toBe(2000);
  });

  it("includes this year's outside labels from the stored set, and null without one", async () => {
    const { req, auth, service } = await build();
    expect((await req.get("/api/room/tfsa").set(await auth()).expect(200)).body.accountSet).toBeNull();
    await service.remember(ME, { node, property: "tax_year.account_set", value: { connected: [], outside: [{ label: "Synthetic Bank" }], confirmedAt: "2026-02-01T15:00:00.000Z" }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    const res = await req.get("/api/room/tfsa").set(await auth()).expect(200);
    expect(res.body.accountSet).toEqual({ connected: [], notTfsa: [], outside: [{ label: "Synthetic Bank" }] });
  });
});

describe("GET /api/room/tfsa: matched transfers and account details (auto-room)", () => {
  const setFacts = async (service: MemoryService) => {
    await service.remember(ME, { node, property: "tax_year.account_set", value: { connected: [MINE], outside: [], confirmedAt: "2026-02-01T15:00:00.000Z" }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    await service.remember(ME, { node, property: "tax_year.cra_room_jan1", value: { amountCad: 7000 }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
  };
  const cashOut = { snapTradeAccountId: CASH_ID, dedupeKey: "synthetic-dedupe-cash-out", type: "INTERNAL_CASH_TRANSFER_OUT", amount: -5000, currency: "CAD", fxRate: null, tradeDate: day("2026-03-02") };

  it("a matched transfer carries matchedWith and inferred; no outcome or missing item is asked for it", async () => {
    const { req, auth, service } = await build({ activities: [transfer], counterparts: [transfer, cashOut] });
    await setFacts(service);
    const res = await req.get("/api/room/tfsa").set(await auth()).expect(200);
    expect(res.body).toMatchObject({ status: "known", roomLeftCad: 2000 });
    expect(res.body.ledger.rows[1]).toMatchObject({ kind: "contribution", activityKey: TRANSFER_KEY, inferred: true, matchedWith: { label: "Synthetic Broker Cash / money market", date: "2026-03-02" } });
    expect(res.body.outcomes).toEqual({});
    expect(res.body.basis).toContain("Matched 1 transfer to your other accounts (same amount within 3 days)");
    expect(res.body.accounts).toEqual([{ accountKey: MINE, label: "Synthetic Broker TFSA", neutral: false, inSet: true, maskedNumber: "4321", value: { amount: 1234.5, currency: "CAD" } }]);
  });

  it("an answer on a matched transfer is stored and wins over the match", async () => {
    const { req, auth, service } = await build({ activities: [transfer], counterparts: [transfer, cashOut] });
    await setFacts(service);
    const res = await req.put(`/api/room/tfsa/activities/${TRANSFER_KEY}`).set(await auth()).send({ effect: "none" }).expect(200);
    expect(res.body).toMatchObject({ status: "known", roomLeftCad: 7000 });
    expect(res.body.ledger.rows[1]).toMatchObject({ kind: "none", activityKey: TRANSFER_KEY });
    expect(res.body.ledger.rows[1]).not.toHaveProperty("inferred");
  });
});

describe("activity answers by direction, and back to the automatic match (fix round 1)", () => {
  const setFacts = async (service: MemoryService) => {
    await service.remember(ME, { node, property: "tax_year.account_set", value: { connected: [MINE], outside: [], confirmedAt: "2026-02-01T15:00:00.000Z" }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    await service.remember(ME, { node, property: "tax_year.cra_room_jan1", value: { amountCad: 7000 }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
  };
  const OUT_KEY = activityKey("synthetic-dedupe-out");
  const tfsaOut = { snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-dedupe-out", type: "INTERNAL_CASH_TRANSFER_OUT", amount: -800, currency: "CAD", fxRate: null, tradeDate: day("2026-04-03") };
  const cashIn = { snapTradeAccountId: CASH_ID, dedupeKey: "synthetic-dedupe-cash-in", type: "INTERNAL_CASH_TRANSFER_IN", amount: 800, currency: "CAD", fxRate: null, tradeDate: day("2026-04-03") };
  const stored = async (service: MemoryService, key: string) => service.current(ME, { type: "activity", key }, "activity.room_effect");

  it("PUT withdrawal on an outgoing matched row is stored with outgoing wording, and the room stays known", async () => {
    const { req, auth, service } = await build({ activities: [tfsaOut], counterparts: [tfsaOut, cashIn] });
    await setFacts(service);
    const before = (await req.get("/api/room/tfsa").set(await auth()).expect(200)).body;
    expect(before.ledger.rows[1]).toMatchObject({ kind: "withdrawal", inferred: true });
    const res = await req.put(`/api/room/tfsa/activities/${OUT_KEY}`).set(await auth()).send({ effect: "withdrawal" }).expect(200);
    expect(res.body).toMatchObject({ status: "known", withdrawnCad: 800 });
    expect(res.body.ledger.rows[1]).toMatchObject({ kind: "withdrawal" });
    expect(res.body.ledger.rows[1]).not.toHaveProperty("inferred");
    const fact = await stored(service, OUT_KEY);
    expect(fact?.value).toEqual({ effect: "withdrawal" });
    expect(fact?.text).toBe("A transfer out of a TFSA, as you answered: withdrawal.");

    await req.put(`/api/room/tfsa/activities/${OUT_KEY}`).set(await auth()).send({ effect: "none" }).expect(200);
    expect((await stored(service, OUT_KEY))?.text).toBe("A transfer out of a TFSA, as you answered: moved to another TFSA.");
  });

  it("an incoming answer keeps its wording", async () => {
    const { req, auth, service } = await build({ activities: [transfer] });
    await req.put(`/api/room/tfsa/activities/${TRANSFER_KEY}`).set(await auth()).send({ effect: "contribution" }).expect(200);
    expect((await stored(service, TRANSFER_KEY))?.text).toBe("A transfer into a TFSA, as you answered: it counts as a contribution.");
  });

  it("DELETE on an owned row forgets the answer and the automatic match applies again", async () => {
    const { req, auth, service } = await build({ activities: [tfsaOut], counterparts: [tfsaOut, cashIn] });
    await setFacts(service);
    await req.put(`/api/room/tfsa/activities/${OUT_KEY}`).set(await auth()).send({ effect: "none" }).expect(200);
    const res = await req.delete(`/api/room/tfsa/activities/${OUT_KEY}`).set(await auth()).expect(200);
    expect(res.body).toMatchObject({ status: "known", withdrawnCad: 800 });
    expect(res.body.ledger.rows[1]).toMatchObject({ kind: "withdrawal", inferred: true, matchedWith: { label: "Synthetic Broker Cash / money market", date: "2026-04-03" } });
    expect(await stored(service, OUT_KEY)).toBeNull();
    // Nothing stored any more: a second DELETE still answers with the room.
    await req.delete(`/api/room/tfsa/activities/${OUT_KEY}`).set(await auth()).expect(200);
  });

  it("DELETE for an unknown or malformed key, is 404 and forgets nothing", async () => {
    const { req, auth, service } = await build({ activities: [tfsaOut], counterparts: [tfsaOut, cashIn] });
    await req.put(`/api/room/tfsa/activities/${OUT_KEY}`).set(await auth()).send({ effect: "none" }).expect(200);
    await req.delete(`/api/room/tfsa/activities/${activityKey("synthetic-unknown")}`).set(await auth()).expect(404);
    await req.delete("/api/room/tfsa/activities/not-a-key").set(await auth()).expect(404);
    expect((await stored(service, OUT_KEY))?.value).toEqual({ effect: "none" });
  });
});

describe("activity answers: direction and transfer-only (fix round 2)", () => {
  const OUT_KEY = activityKey("synthetic-dedupe-out2");
  const tfsaOut = { snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-dedupe-out2", type: "TRANSFER_OUT", amount: -800, currency: "CAD", fxRate: null, tradeDate: day("2026-04-03") };
  const DIV_KEY = activityKey("synthetic-dedupe-dividend");
  const dividend = { snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-dedupe-dividend", type: "DIVIDEND", amount: 12, currency: "CAD", fxRate: null, tradeDate: day("2026-05-01") };
  const ODD_KEY = activityKey("synthetic-dedupe-odd");
  const odd = { snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-dedupe-odd", type: "SOMETHING_NEW", amount: 50, currency: "CAD", fxRate: null, tradeDate: day("2026-05-02") };
  const stored = async (service: MemoryService, key: string) => service.current(ME, { type: "activity", key }, "activity.room_effect");

  it("a direction mismatch is 400 INVALID_MEMORY_EDIT and nothing is stored", async () => {
    const { req, auth, service } = await build({ activities: [transfer, tfsaOut] });
    const put = async (key: string, effect: string) => req.put(`/api/room/tfsa/activities/${key}`).set(await auth()).send({ effect });
    expect((await put(TRANSFER_KEY, "withdrawal")).status).toBe(400);
    expect((await put(TRANSFER_KEY, "withdrawal")).body).toEqual({ error: "invalid_memory_edit", message: "That change could not be saved." });
    expect((await put(OUT_KEY, "contribution")).status).toBe(400);
    expect(await stored(service, TRANSFER_KEY)).toBeNull();
    expect(await stored(service, OUT_KEY)).toBeNull();
    // The matching directions are accepted.
    expect((await put(TRANSFER_KEY, "contribution")).status).toBe(200);
    expect((await put(OUT_KEY, "withdrawal")).status).toBe(200);
  });

  it("PUT and DELETE take transfer rows or rows the engine finds unclear; anything else is 404 with no write", async () => {
    const { req, auth, service } = await build({ activities: [transfer, dividend, odd] });
    await req.put(`/api/room/tfsa/activities/${DIV_KEY}`).set(await auth()).send({ effect: "none" }).expect(404);
    await req.delete(`/api/room/tfsa/activities/${DIV_KEY}`).set(await auth()).expect(404);
    expect(await stored(service, DIV_KEY)).toBeNull();
    // An unknown type is unclear to the engine, so it can be answered, and its answer edited or cleared afterwards.
    const res = await req.put(`/api/room/tfsa/activities/${ODD_KEY}`).set(await auth()).send({ effect: "contribution" }).expect(200);
    expect(res.body.ledger.rows.find((r: { activityKey?: string }) => r.activityKey === ODD_KEY)).toMatchObject({ kind: "contribution", answered: true });
    await req.put(`/api/room/tfsa/activities/${ODD_KEY}`).set(await auth()).send({ effect: "none" }).expect(200);
    await req.delete(`/api/room/tfsa/activities/${ODD_KEY}`).set(await auth()).expect(200);
    expect(await stored(service, ODD_KEY)).toBeNull();
  });
});

describe("one rule for which rows take an answer (round 3)", () => {
  it("chat answers on a WITHDRAWAL and a DIVIDEND are ignored: the room is known, nothing is queued, and PUT and DELETE refuse them", async () => {
    const W_KEY = activityKey("synthetic-dedupe-w3");
    const D_KEY = activityKey("synthetic-dedupe-d3");
    const w = { snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-dedupe-w3", type: "WITHDRAWAL", amount: -500, currency: "CAD", fxRate: null, tradeDate: day("2026-03-05") };
    const d = { snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-dedupe-d3", type: "DIVIDEND", amount: 12, currency: "CAD", fxRate: null, tradeDate: day("2026-03-06") };
    const { req, auth, service } = await build({ activities: [w, d] });
    await service.remember(ME, { node, property: "tax_year.account_set", value: { connected: [MINE], outside: [], confirmedAt: "2026-02-01T15:00:00.000Z" }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    await service.remember(ME, { node, property: "tax_year.cra_room_jan1", value: { amountCad: 7000 }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    // As chat would store them (remember), bypassing the dashboard's checks.
    await service.remember(ME, { node: { type: "activity", key: W_KEY }, property: "activity.room_effect", value: { effect: "contribution" }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    await service.remember(ME, { node: { type: "activity", key: D_KEY }, property: "activity.room_effect", value: { effect: "withdrawal" }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    const res = await req.get("/api/room/tfsa").set(await auth()).expect(200);
    expect(res.body).toMatchObject({ status: "known", withdrawnCad: 500, roomLeftCad: 7000 });
    expect(res.body.ledger.rows[1]).toMatchObject({ kind: "withdrawal", activityKey: W_KEY });
    expect(res.body.ledger.rows[1]).not.toHaveProperty("answered");
    for (const key of [W_KEY, D_KEY]) {
      await req.put(`/api/room/tfsa/activities/${key}`).set(await auth()).send({ effect: "none" }).expect(404);
      await req.delete(`/api/room/tfsa/activities/${key}`).set(await auth()).expect(404);
    }
  });
});

describe("GET /api/room/tfsa previousAccountSet", () => {
  const last = { type: "tax_year" as const, key: "2025:tfsa" };
  const lastSet = { connected: [MINE], outside: [{ label: "Synthetic Bank" }], confirmedAt: "2025-02-01T15:00:00.000Z", notTfsa: [] };
  it("returns last year's set while this year has none, and null once this year's is stored", async () => {
    const { req, auth, service } = await build();
    await service.remember(ME, { node: last, property: "tax_year.account_set", value: lastSet, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    const before = (await req.get("/api/room/tfsa").set(await auth()).expect(200)).body;
    expect(before.accountSet).toBeNull();
    expect(before.previousAccountSet).toEqual({ connected: [MINE], notTfsa: [], outside: [{ label: "Synthetic Bank" }] });
    // Last year's set is no question: with this year's CRA room missing, that is the only item.
    expect(before.missing.map((m: { kind: string }) => m.kind)).toEqual(["cra_room"]);
    await service.remember(ME, { node, property: "tax_year.account_set", value: { ...lastSet, confirmedAt: "2026-02-01T15:00:00.000Z" }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    const after = (await req.get("/api/room/tfsa").set(await auth()).expect(200)).body;
    expect(after.accountSet).not.toBeNull();
    expect(after.previousAccountSet).toBeNull();
  });
});

describe("PUT /api/room/tfsa/*", () => {
  it("cra-room saves a stated dashboard fact and returns the recomputed room", async () => {
    const { req, auth, service } = await build();
    const res = await req.put("/api/room/tfsa/cra-room").set(await auth()).send({ year: 2026, amountCad: 7000 }).expect(200);
    // The 1 January room is the only question: with no account set confirmed, the broker-labelled TFSA counts.
    expect(res.body).toMatchObject({ status: "known", craRoomCad: 7000 });
    const [fact] = (await service.listCurrent(ME)).filter((f) => f.property === "tax_year.cra_room_jan1");
    expect(fact).toMatchObject({ provenance: "stated", kind: "fact", source: "dashboard", value: { amountCad: 7000 }, text: "TFSA room of $7,000 on 1 January 2026, from CRA My Account." });
  });

  it("managed/:accountKey saves a managed TFSA's year-to-date figure as a stated dashboard fact on its key, and the account is then counted (review 6)", async () => {
    const { req, auth, service } = await build({ managed: true });
    await service.remember(ME, { node, property: "tax_year.cra_room_jan1", value: { amountCad: 7000 }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    const before = (await req.get("/api/room/tfsa").set(await auth()).expect(200)).body;
    expect(before).toMatchObject({ status: "known", roomLeftCad: 7000, notCounted: [expect.objectContaining({ accountKey: accountKey(MANAGED_ID) })] });
    const res = await req.put(`/api/room/tfsa/managed/${accountKey(MANAGED_ID)}`).set(await auth()).send({ year: 2026, amountCad: 3000, asOf: "2026-10-15" }).expect(200);
    expect(res.body).toMatchObject({ status: "known", contributedCad: 3000, roomLeftCad: 4000 });
    expect(res.body.notCounted).toBeUndefined();
    const fact = (await service.listCurrent(ME)).find((f) => f.property === "account.ytd_contributions");
    expect(fact).toMatchObject({ provenance: "stated", source: "dashboard", node: { type: "account", key: accountKey(MANAGED_ID) }, value: { year: 2026, amountCad: 3000, asOf: "2026-10-15" } });
    expect(fact!.text).toContain("$3,000");
  });

  it("managed/:accountKey refuses a self-directed TFSA, an as-of date after today or in another year, and writes nothing", async () => {
    const { req, auth, service } = await build({ managed: true });
    const body = { year: 2026, amountCad: 3000, asOf: "2026-10-15" };
    await req.put(`/api/room/tfsa/managed/${MINE}`).set(await auth()).send(body).expect(404);
    await req.put(`/api/room/tfsa/managed/${accountKey(MANAGED_ID)}`).set(await auth()).send({ ...body, asOf: "2026-10-25" }).expect(400);
    await req.put(`/api/room/tfsa/managed/${accountKey(MANAGED_ID)}`).set(await auth()).send({ ...body, asOf: "2025-10-15" }).expect(400);
    expect((await service.listCurrent(ME)).filter((f) => f.property === "account.ytd_contributions")).toEqual([]);
  });

  it("accounts saves the set with confirmedAt now", async () => {
    const { req, auth, service } = await build();
    await req.put("/api/room/tfsa/accounts").set(await auth())
      .send({ year: 2026, connected: [MINE], notTfsa: [], outside: [{ label: "Synthetic Bank" }] }).expect(200);
    const fact = (await service.listCurrent(ME)).find((f) => f.property === "tax_year.account_set");
    expect(fact?.value).toEqual({ connected: [MINE], outside: [{ label: "Synthetic Bank" }], confirmedAt: NOW.toISOString(), notTfsa: [] });
  });

  it("accounts with a foreign accountKey returns 404 and writes nothing", async () => {
    const { req, auth, service } = await build();
    const res = await req.put("/api/room/tfsa/accounts").set(await auth())
      .send({ year: 2026, connected: [accountKey("synthetic-someone-elses")], notTfsa: [], outside: [] }).expect(404);
    expect(res.body).toEqual({ error: "not_found" });
    await req.put("/api/room/tfsa/accounts").set(await auth())
      .send({ year: 2026, connected: [], notTfsa: [accountKey("synthetic-someone-elses")], outside: [] }).expect(404);
    expect(await service.listCurrent(ME)).toEqual([]);
  });

  it("activities saves the answer for the caller's own transfer, and returns the room", async () => {
    const { req, auth, service } = await build({ activities: [transfer] });
    await req.put(`/api/room/tfsa/activities/${TRANSFER_KEY}`).set(await auth()).send({ effect: "contribution" }).expect(200);
    expect((await service.listCurrent(ME)).find((f) => f.property === "activity.room_effect")).toMatchObject({ node: { type: "activity", key: TRANSFER_KEY }, value: { effect: "contribution" }, source: "dashboard" });
  });

  it("outside moves saves dated entries, and an entry outside the year returns 400 INVALID_MEMORY_EDIT", async () => {
    const { req, auth, service } = await build();
    const ok = { year: 2026, entries: [{ date: "2026-04-01", amountCad: 1000, kind: "deposit" }] };
    await req.put("/api/room/tfsa/outside/Synthetic%20Bank/moves").set(await auth()).send(ok).expect(200);
    expect((await service.listCurrent(ME)).find((f) => f.property === "account.tfsa_moves")).toMatchObject({ node: { type: "account", key: "outside:synthetic-bank" }, value: ok });
    const res = await req.put("/api/room/tfsa/outside/Synthetic%20Bank/moves").set(await auth())
      .send({ year: 2026, entries: [{ date: "2025-12-31", amountCad: 1000, kind: "deposit" }] }).expect(400);
    expect(res.body.error).toBe("invalid_memory_edit");
  });

  it("outside moves: an entry dated after today (Toronto) is 400 INVALID_MEMORY_EDIT and nothing is stored; today is fine", async () => {
    const { req, auth, service } = await build();
    const res = await req.put("/api/room/tfsa/outside/Synthetic%20Bank/moves").set(await auth())
      .send({ year: 2026, entries: [{ date: "2026-10-01", amountCad: 100, kind: "deposit" }, { date: "2026-10-25", amountCad: 1000, kind: "deposit" }] }).expect(400);
    expect(res.body.error).toBe("invalid_memory_edit");
    expect(await service.listCurrent(ME)).toEqual([]);
    await req.put("/api/room/tfsa/outside/Synthetic%20Bank/moves").set(await auth())
      .send({ year: 2026, entries: [{ date: "2026-10-24", amountCad: 1000, kind: "withdrawal" }] }).expect(200);
  });

  it("a body that does not match is 400", async () => {
    const { req, auth } = await build();
    await req.put("/api/room/tfsa/cra-room").set(await auth()).send({ year: 2026, amountCad: -1 }).expect(400);
    await req.put("/api/room/tfsa/cra-room").set(await auth()).send({ year: 2026, amountCad: 1, extra: true }).expect(400);
  });

  it("a write re-evaluates the room alert", async () => {
    const { req, auth, reserved } = await build();
    await req.put("/api/room/tfsa/cra-room").set(await auth()).send({ year: 2026, amountCad: 7000 }).expect(200);
    expect(reserved).toHaveBeenCalledWith(ME);
  });
});

describe("auth", () => {
  it("answers 401 without a token on every route", async () => {
    const { req } = await build();
    for (const [method, path] of [
      ["get", "/api/room/tfsa"], ["put", "/api/room/tfsa/cra-room"], ["put", "/api/room/tfsa/accounts"],
      ["put", "/api/room/tfsa/outside/x/moves"], ["put", `/api/room/tfsa/activities/${TRANSFER_KEY}`], ["delete", `/api/room/tfsa/activities/${TRANSFER_KEY}`],
    ] as const) {
      await req[method](path).send({}).expect(401);
    }
  });
});
