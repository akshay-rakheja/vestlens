import { describe, expect, it, vi } from "vitest";

import { accountKey, activityKey } from "../memory/keys.js";
import { MemoryService } from "../memory/memory-service.js";
import { MemoryFactRepository } from "../testing/memory-fact-repository.js";
import { computeFhsaRoom, FHSA_RRSP_NOTE } from "./fhsa-room.js";
import { loadFhsaRoomInput, type RoomPrismaPort } from "./room-loader.js";

// Synthetic ids, labels and amounts only.
const SUBJECT = "subject|synthetic-fhsa-loader";
const FHSA_ID = "synthetic-acct-fhsa";
const RRSP_ID = "synthetic-acct-rrsp";
const TFSA_ID = "synthetic-acct-tfsa";
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
const NOW = new Date("2026-10-24T16:00:00Z");
const ok = { lastSyncedAt: new Date("2026-10-24T08:00:00Z"), lastError: null, dirty: false };
const snap = (type: string) => [{ payload: { account: { type, metaType: null, unifiedType: null, status: "OPEN" }, positions: [] } }];
const isCounterpartQuery = (input: unknown) => (input as { where: { OR?: Array<Record<string, unknown>> } }).where.OR?.some((o) => "type" in o) ?? false;
/** The New Year check's read of last 27–31 December (no OR): none here. */
const isPriorDecemberQuery = (input: unknown) => (input as { where: { OR?: unknown } }).where.OR === undefined;

function prismaPort(accounts: Array<Record<string, unknown>>, activities: Array<Record<string, unknown>> = [], counterparts: Array<Record<string, unknown>> = []) {
  const port: RoomPrismaPort = {
    brokerageAccount: { findMany: vi.fn(async () => accounts as never) },
    activity: { findMany: vi.fn(async (input: unknown) => (isPriorDecemberQuery(input) ? [] : isCounterpartQuery(input) ? counterparts : activities) as never) },
    activitySyncState: { findMany: vi.fn(async () => [{ snapTradeAccountId: FHSA_ID, backfillCompletedAt: new Date("2026-02-01T00:00:00Z"), ...ok }] as never) },
  };
  return port;
}
const account = (id: string, rawType: string) => ({ snapTradeAccountId: id, displayName: null, institutionName: "Synthetic Broker", rawType, status: "OPEN", snapshots: snap(rawType) });

async function memoryWith(amountCad: number | null) {
  const repository = new MemoryFactRepository();
  const memory = new MemoryService({ repository, log: () => {} });
  if (amountCad !== null) {
    await memory.remember(SUBJECT, { node: { type: "tax_year", key: "2026:fhsa" }, property: "tax_year.fhsa_room", value: { amountCad }, text: "Synthetic.", kind: "fact", provenance: "stated" }, new Date("2026-03-01T12:00:00Z"), "dashboard");
  }
  return repository;
}

describe("loadFhsaRoomInput", () => {
  it("passes FHSA-bucket accounts only, the RRSP keys, and this year's FHSA room; end to end an RRSP transfer uses room", async () => {
    const prisma = prismaPort(
      [account(FHSA_ID, "FHSA"), account(RRSP_ID, "RRSP"), account(TFSA_ID, "TFSA")],
      [{ snapTradeAccountId: FHSA_ID, dedupeKey: "synthetic-fhsa-in", type: "TRANSFER_IN", amount: "4000", currency: "CAD", fxRate: null, tradeDate: day("2026-04-02") }],
      [
        { snapTradeAccountId: FHSA_ID, dedupeKey: "synthetic-fhsa-in", type: "TRANSFER_IN", amount: "4000", currency: "CAD", fxRate: null, tradeDate: day("2026-04-02") },
        { snapTradeAccountId: RRSP_ID, dedupeKey: "synthetic-rrsp-out", type: "TRANSFER_OUT", amount: "-4000", currency: "CAD", fxRate: null, tradeDate: day("2026-04-01") },
      ],
    );
    const input = await loadFhsaRoomInput({ prisma, memory: await memoryWith(8000) }, SUBJECT, "2026-10-24", NOW);
    expect(input.accounts).toEqual([{ accountKey: accountKey(FHSA_ID), label: "Synthetic Broker FHSA", bucket: "fhsa", neutral: false, closed: false, managed: false, maskedNumber: null, value: null }]);
    expect(input.rrspAccountKeys).toEqual([accountKey(RRSP_ID)]);
    const activityQuery = (prisma.activity.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(activityQuery.where).toMatchObject({ appUser: { authSubject: SUBJECT }, snapTradeAccountId: { in: [FHSA_ID] } });
    const r = computeFhsaRoom(input);
    expect(r).toMatchObject({ status: "known", roomLeftCad: 4000, participationRoomCad: 8000 });
    if (r.status === "known") expect(r.ledger.rows[1]).toMatchObject({ activityKey: activityKey("synthetic-fhsa-in"), note: FHSA_RRSP_NOTE });
  });

  it("no FHSA: no activity or memory query, and the engine answers none", async () => {
    const prisma = prismaPort([account(TFSA_ID, "TFSA")]);
    const repository = await memoryWith(8000);
    const find = vi.spyOn(repository, "find");
    const input = await loadFhsaRoomInput({ prisma, memory: repository }, SUBJECT, "2026-10-24", NOW);
    expect(prisma.activity.findMany).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    expect(computeFhsaRoom(input)).toEqual({ status: "none" });
  });

  it("without a stated room the only missing item is fhsa_room", async () => {
    const input = await loadFhsaRoomInput({ prisma: prismaPort([account(FHSA_ID, "FHSA")]), memory: await memoryWith(null) }, SUBJECT, "2026-10-24", NOW);
    const r = computeFhsaRoom(input);
    expect(r.status === "missing" && r.missing).toEqual([{ kind: "fhsa_room" }]);
  });
});
