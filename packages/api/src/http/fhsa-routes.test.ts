import { describe, expect, it, vi } from "vitest";

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
const FHSA_ID = "synthetic-acct-fhsa";
const TFSA_ID = "synthetic-acct-tfsa";
const NOW = new Date("2026-10-24T16:00:00Z");
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);



/** ME owns a TFSA and (unless withFhsa is false) an FHSA; any other subject has nothing. */
function prismaPort(withFhsa: boolean, activities: Array<Record<string, unknown>>): RoomPrismaPort {
  const mine = (input: { where: { appUser?: { authSubject: string } } }) => input.where.appUser?.authSubject === ME;
  const transfers = (input: { where: Record<string, unknown> }) => "tradeDate" in input.where;
  const account = (id: string, type: string) => ({
    snapTradeAccountId: id, displayName: null, institutionName: "Synthetic Broker", rawType: type, status: "OPEN", maskedNumber: null, reportedTotal: null, reportedCurrency: null,
    snapshots: [{ payload: { account: { type, metaType: null, unifiedType: null, status: "OPEN" }, positions: [] } }],
  });
  const sync = (id: string) => ({ snapTradeAccountId: id, backfillCompletedAt: day("2026-02-01"), lastSyncedAt: new Date("2026-10-24T08:00:00Z"), lastError: null, dirty: false });
  return {
    brokerageAccount: { findMany: async (input: never) => (!mine(input) ? [] : [account(TFSA_ID, "TFSA"), ...(withFhsa ? [account(FHSA_ID, "FHSA")] : [])]) as never },
    activity: {
      findMany: async (input: never) => (!mine(input) ? [] : transfers(input) ? activities.filter((a) => String(a.type).includes("TRANSFER"))
        : activities.filter((a) => (input as { where: { snapTradeAccountId: { in: string[] } } }).where.snapTradeAccountId.in.includes(a.snapTradeAccountId as string))) as never,
    },
    activitySyncState: { findMany: async (input: never) => (!mine(input) ? [] : [sync(TFSA_ID), sync(FHSA_ID)]) as never },
  };
}
const links = { accountsHoldingSecurity: async () => [], tfsaAccounts: async () => [TFSA_ID], accountIds: async () => [TFSA_ID, FHSA_ID], activityDedupeKeys: async () => [] };

async function build(o: { withFhsa?: boolean; activities?: Array<Record<string, unknown>> } = {}) {
  const repository = new MemoryFactRepository();
  const alerts = new RoomAlertService({ prisma: new MemoryRoomAlertPrisma(), now: () => NOW });
  const loader = { prisma: prismaPort(o.withFhsa !== false, o.activities ?? []), memory: repository };
  const service = new MemoryService({ repository, links, now: () => NOW, log: () => {} });
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
  return { req: await loopbackRequest(app), auth: async () => ({ Cookie: await sessionCookieFor(sessions), Origin: APP }), service };
}

describe("GET /api/room/fhsa", () => {
  it("is { status: none } without a broker-labelled FHSA", async () => {
    const { req, auth } = await build({ withFhsa: false });
    expect((await req.get("/api/room/fhsa").set(await auth()).expect(200)).body).toEqual({ status: "none" });
  });

  it("asks for the participation room only, then gives the number with the ledger, the FHSA accounts and no alert", async () => {
    const contribution = { snapTradeAccountId: FHSA_ID, dedupeKey: "synthetic-fhsa-c1", type: "CONTRIBUTION", amount: 3000, currency: "CAD", fxRate: null, tradeDate: day("2026-03-03") };
    const { req, auth, service } = await build({ activities: [contribution] });
    const before = (await req.get("/api/room/fhsa").set(await auth()).expect(200)).body;
    expect(before).toMatchObject({ status: "missing", year: 2026, missing: [{ kind: "fhsa_room" }], alert: null });
    await service.remember(ME, { node: { type: "tax_year", key: "2026:fhsa" }, property: "tax_year.fhsa_room", value: { amountCad: 8000 }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    const after = (await req.get("/api/room/fhsa").set(await auth()).expect(200)).body;
    expect(after).toMatchObject({ status: "known", roomLeftCad: 5000, participationRoomCad: 8000, alert: null, headlineBasis: "Based on your connected FHSAs" });
    expect(after.ledger.rows).toHaveLength(2);
    expect(after.accounts).toEqual([{ accountKey: accountKey(FHSA_ID), label: "Synthetic Broker FHSA", maskedNumber: null, value: null }]);
  });
});

describe("PUT /api/room/fhsa/participation-room", () => {
  it("saves a stated dashboard fact on <year>:fhsa and returns the recomputed room", async () => {
    const { req, auth, service } = await build();
    const res = await req.put("/api/room/fhsa/participation-room").set(await auth()).send({ year: 2026, amountCad: 8000 }).expect(200);
    expect(res.body).toMatchObject({ status: "known", participationRoomCad: 8000, roomLeftCad: 8000 });
    const [fact] = (await service.listCurrent(ME)).filter((f) => f.property === "tax_year.fhsa_room");
    expect(fact).toMatchObject({ node: { type: "tax_year", key: "2026:fhsa" }, provenance: "stated", kind: "fact", source: "dashboard", value: { amountCad: 8000 }, text: "FHSA participation room of $8,000 for 2026, from CRA." });
  });

  it("a body that does not match is 400 and nothing is stored", async () => {
    const { req, auth, service } = await build();
    // The FHSA began in 2023: an earlier year is refused.
    for (const body of [{ year: 2026, amountCad: -1 }, { year: 2026, amountCad: 1, extra: true }, { amountCad: 1 }, { year: 1999, amountCad: 1 }, { year: 2022, amountCad: 8000 }, {}]) {
      const res = await req.put("/api/room/fhsa/participation-room").set(await auth()).send(body).expect(400);
      expect(res.body.error).toBe("invalid_memory_edit");
    }
    expect(await service.listCurrent(ME)).toEqual([]);
    await req.put("/api/room/fhsa/participation-room").set(await auth()).send({ year: 2023, amountCad: 8000 }).expect(200);
  });

});

const IN_KEY = activityKey("synthetic-fhsa-transfer-in");
const OUT_KEY = activityKey("synthetic-fhsa-transfer-out");
const TFSA_KEY = activityKey("synthetic-tfsa-transfer-in");
const DIVIDEND_KEY = activityKey("synthetic-fhsa-dividend");
const fhsaActivities = [
  { snapTradeAccountId: FHSA_ID, dedupeKey: "synthetic-fhsa-transfer-in", type: "TRANSFER_IN", amount: 3000, currency: "CAD", fxRate: null, tradeDate: day("2026-03-03") },
  { snapTradeAccountId: FHSA_ID, dedupeKey: "synthetic-fhsa-transfer-out", type: "TRANSFER_OUT", amount: -500, currency: "CAD", fxRate: null, tradeDate: day("2026-05-03") },
  { snapTradeAccountId: FHSA_ID, dedupeKey: "synthetic-fhsa-dividend", type: "DIVIDEND", amount: 12, currency: "CAD", fxRate: null, tradeDate: day("2026-04-01") },
  { snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-tfsa-transfer-in", type: "TRANSFER_IN", amount: 100, currency: "CAD", fxRate: null, tradeDate: day("2026-03-04") },
];
const fhsaRoom = { node: { type: "tax_year" as const, key: "2026:fhsa" }, property: "tax_year.fhsa_room", value: { amountCad: 8000 }, text: "Synthetic.", kind: "fact" as const, provenance: "stated" as const };
const rowOf = (body: { ledger: { rows: Array<{ activityKey?: string }> } }, key: string) => body.ledger.rows.find((r) => r.activityKey === key);

describe("PUT and DELETE /api/room/fhsa/activities/:activityKey", () => {
  it("an answer on the caller's own FHSA transfer is stored with FHSA wording and wins; DELETE returns it to the assumption", async () => {
    const { req, auth, service } = await build({ activities: fhsaActivities });
    await service.remember(ME, fhsaRoom, NOW);
    const before = (await req.get("/api/room/fhsa").set(await auth()).expect(200)).body;
    expect(rowOf(before, IN_KEY)).toMatchObject({ kind: "contribution", assumed: true });
    expect(before.roomLeftCad).toBe(5000);
    const answered = (await req.put(`/api/room/fhsa/activities/${IN_KEY}`).set(await auth()).send({ effect: "none" }).expect(200)).body;
    expect(rowOf(answered, IN_KEY)).toMatchObject({ kind: "none", answered: true });
    expect(answered.roomLeftCad).toBe(8000);
    const fact = (await service.listCurrent(ME)).find((f) => f.property === "activity.room_effect");
    expect(fact).toMatchObject({ node: { type: "activity", key: IN_KEY }, value: { effect: "none" }, source: "dashboard", text: "A transfer into an FHSA, as you answered: it is not a contribution." });
    await req.put(`/api/room/fhsa/activities/${OUT_KEY}`).set(await auth()).send({ effect: "withdrawal" }).expect(200);
    expect((await service.listCurrent(ME)).find((f) => f.node.key === OUT_KEY)?.text).toBe("A transfer out of an FHSA, as you answered: withdrawal.");
    // "Moved to another FHSA" and "Moved to my RRSP" both store none: no effect on FHSA room or the amount over.
    await req.put(`/api/room/fhsa/activities/${OUT_KEY}`).set(await auth()).send({ effect: "none" }).expect(200);
    expect((await service.listCurrent(ME)).find((f) => f.node.key === OUT_KEY)?.text).toBe("A transfer out of an FHSA, as you answered: moved to another FHSA or an RRSP.");
    const cleared = (await req.delete(`/api/room/fhsa/activities/${IN_KEY}`).set(await auth()).expect(200)).body;
    expect(rowOf(cleared, IN_KEY)).toMatchObject({ kind: "contribution", assumed: true });
    expect(cleared.roomLeftCad).toBe(5000);
  });

  it("an unknown, a malformed, a TFSA or a non-answerable key is 404 and nothing is written", async () => {
    const { req, auth, service } = await build({ activities: fhsaActivities });
    for (const [, key] of [[ME, activityKey("synthetic-nope")], [ME, "not-a-key"], [ME, TFSA_KEY], [ME, DIVIDEND_KEY]] as const) {
      const put = await req.put(`/api/room/fhsa/activities/${key}`).set(await auth()).send({ effect: "none" }).expect(404);
      expect(put.body).toEqual({ error: "not_found" });
      await req.delete(`/api/room/fhsa/activities/${key}`).set(await auth()).expect(404);
    }
    expect(await service.listCurrent(ME)).toEqual([]);
  });

  it("a direction mismatch or a bad body is 400 and nothing is stored", async () => {
    const { req, auth, service } = await build({ activities: fhsaActivities });
    for (const [key, body] of [[IN_KEY, { effect: "withdrawal" }], [OUT_KEY, { effect: "contribution" }], [IN_KEY, { effect: "maybe" }], [IN_KEY, {}]] as const) {
      const res = await req.put(`/api/room/fhsa/activities/${key}`).set(await auth()).send(body).expect(400);
      expect(res.body.error).toBe("invalid_memory_edit");
    }
    expect(await service.listCurrent(ME)).toEqual([]);
  });
});

describe("auth", () => {
  it("answers 401 without a token on every route", async () => {
    const { req } = await build();
    for (const [method, path] of [
      ["get", "/api/room/fhsa"], ["put", "/api/room/fhsa/participation-room"],
      ["put", `/api/room/fhsa/activities/${IN_KEY}`], ["delete", `/api/room/fhsa/activities/${IN_KEY}`],
    ] as const) {
      await req[method](path).send({}).expect(401);
    }
  });
});
