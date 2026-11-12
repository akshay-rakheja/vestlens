import { describe, expect, it, vi } from "vitest";

import { accountKey, activityKey } from "../memory/keys.js";
import { MemoryService } from "../memory/memory-service.js";
import { MemoryFactRepository } from "../testing/memory-fact-repository.js";
import { computeRrspRoom } from "./rrsp-room.js";
import { loadRrspRoomInput, type RoomPrismaPort } from "./room-loader.js";

// Synthetic ids, labels and amounts only.
const SUBJECT = "subject|synthetic-rrsp-loader";
const RRSP_ID = "synthetic-acct-rrsp";
const MANAGED_ID = "synthetic-acct-managed-rrsp";
const FHSA_ID = "synthetic-acct-fhsa";
const TFSA_ID = "synthetic-acct-tfsa";
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
const NOW = new Date("2026-10-29T16:00:00Z");
const ok = { lastSyncedAt: new Date("2026-10-29T08:00:00Z"), lastError: null, dirty: false };
const snap = (type: string, unifiedType: string | null = null) => [{ payload: { account: { type, metaType: null, unifiedType, status: "OPEN" }, positions: [] } }];
const isCounterpartQuery = (input: unknown) => (input as { where: { OR: Array<Record<string, unknown>> } }).where.OR.some((o) => "type" in o);

function prismaPort(accounts: Array<Record<string, unknown>>, activities: Array<Record<string, unknown>> = [], counterparts: Array<Record<string, unknown>> = []) {
  const port: RoomPrismaPort = {
    brokerageAccount: { findMany: vi.fn(async () => accounts as never) },
    activity: { findMany: vi.fn(async (input: unknown) => (isCounterpartQuery(input) ? counterparts : activities) as never) },
    activitySyncState: { findMany: vi.fn(async () => [{ snapTradeAccountId: RRSP_ID, backfillCompletedAt: new Date("2025-01-01T00:00:00Z"), ...ok }] as never) },
  };
  return port;
}
const account = (id: string, rawType: string, unifiedType: string | null = null) =>
  ({ snapTradeAccountId: id, displayName: null, institutionName: "Synthetic Broker", rawType, status: "OPEN", snapshots: snap(rawType, unifiedType) });

async function memoryWith(facts: Array<{ year: number; property: string; amountCad: number }>) {
  const repository = new MemoryFactRepository();
  const memory = new MemoryService({ repository, log: () => {} });
  for (const f of facts) {
    await memory.remember(SUBJECT, { node: { type: "tax_year", key: `${f.year}:rrsp` }, property: f.property, value: { amountCad: f.amountCad }, text: "Synthetic.", kind: "fact", provenance: "stated" }, new Date("2026-03-01T12:00:00Z"), "dashboard");
  }
  return repository;
}

describe("loadRrspRoomInput", () => {
  it("passes RRSP-bucket accounts with managed set, the FHSA keys, and bounds the activity query to the open window", async () => {
    const prisma = prismaPort([account(RRSP_ID, "RRSP"), account(MANAGED_ID, "RRSP", "MANAGED_RRSP"), account(FHSA_ID, "FHSA"), account(TFSA_ID, "TFSA")]);
    const input = await loadRrspRoomInput({ prisma, memory: await memoryWith([]) }, SUBJECT, "2026-10-29", NOW);
    expect(input.accounts.map((a) => [a.accountKey, a.bucket, a.managed])).toEqual([
      [accountKey(RRSP_ID), "rrsp", false],
      [accountKey(MANAGED_ID), "rrsp", true],
    ]);
    expect(input.fhsaAccountKeys).toEqual([accountKey(FHSA_ID)]);
    const q = (prisma.activity.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(q.where).toMatchObject({ appUser: { authSubject: SUBJECT }, snapTradeAccountId: { in: [RRSP_ID, MANAGED_ID] } });
    expect(q.where.OR[0].tradeDate).toEqual({ gte: day("2026-03-03"), lt: day("2026-10-30") });
  });

  it("reads each open year's three facts: 2026 only on 2026-10-29, 2025 and 2026 on 2026-02-10", async () => {
    const memory = await memoryWith([
      { year: 2026, property: "tax_year.rrsp_deduction_limit", amountCad: 30000 },
      { year: 2025, property: "tax_year.rrsp_unused_contributions", amountCad: 500 },
      { year: 2024, property: "tax_year.rrsp_elsewhere", amountCad: 900 },
    ]);
    const late = await loadRrspRoomInput({ prisma: prismaPort([account(RRSP_ID, "RRSP")]), memory }, SUBJECT, "2026-10-29", NOW);
    expect([...late.memory.byYear.keys()]).toEqual([2026]);
    expect(late.memory.byYear.get(2026)).toMatchObject({ limit: { value: { amountCad: 30000 } }, unused: null, elsewhere: null });

    const early = await loadRrspRoomInput({ prisma: prismaPort([account(RRSP_ID, "RRSP")]), memory }, SUBJECT, "2026-02-10", NOW);
    expect([...early.memory.byYear.keys()]).toEqual([2025, 2026]);
    expect(early.memory.byYear.get(2025)).toMatchObject({ limit: null, unused: { value: { amountCad: 500 } }, elsewhere: null });
    expect(early.memory.byYear.get(2026)!.limit).not.toBeNull();
    const prisma = prismaPort([account(RRSP_ID, "RRSP")]);
    await loadRrspRoomInput({ prisma, memory }, SUBJECT, "2026-02-10", NOW);
    const q = (prisma.activity.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(q.where.OR[0].tradeDate).toEqual({ gte: day("2025-03-04"), lt: day("2026-02-11") });
  });

  it("end to end: a contribution counts, a transfer from the FHSA does not use room", async () => {
    const prisma = prismaPort(
      [account(RRSP_ID, "RRSP"), account(FHSA_ID, "FHSA")],
      [
        { snapTradeAccountId: RRSP_ID, dedupeKey: "synthetic-dep", type: "CONTRIBUTION", amount: "1000", currency: "CAD", fxRate: null, tradeDate: day("2026-05-01") },
        { snapTradeAccountId: RRSP_ID, dedupeKey: "synthetic-fhsa-in", type: "TRANSFER_IN", amount: "2000", currency: "CAD", fxRate: null, tradeDate: day("2026-06-01") },
      ],
      [
        { snapTradeAccountId: RRSP_ID, dedupeKey: "synthetic-fhsa-in", type: "TRANSFER_IN", amount: "2000", currency: "CAD", fxRate: null, tradeDate: day("2026-06-01") },
        { snapTradeAccountId: FHSA_ID, dedupeKey: "synthetic-fhsa-out", type: "TRANSFER_OUT", amount: "-2000", currency: "CAD", fxRate: null, tradeDate: day("2026-06-01") },
      ],
    );
    // Room left needs all three figures (0 counts as stated).
    const memory = await memoryWith([
      { year: 2026, property: "tax_year.rrsp_deduction_limit", amountCad: 10000 },
      { year: 2026, property: "tax_year.rrsp_unused_contributions", amountCad: 0 },
      { year: 2026, property: "tax_year.rrsp_elsewhere", amountCad: 0 },
    ]);
    const r = computeRrspRoom(await loadRrspRoomInput({ prisma, memory }, SUBJECT, "2026-10-29", NOW));
    expect(r.status).toBe("shown");
    if (r.status === "shown") {
      expect(r.years).toHaveLength(1);
      expect(r.years[0]).toMatchObject({ contributedCad: 1000, roomLeftCad: 9000 });
      expect(r.years[0]!.ledger.rows.some((row) => row.activityKey === activityKey("synthetic-fhsa-in"))).toBe(true);
    }
  });

  it("no RRSP: no activity or memory query, and the engine answers none", async () => {
    const prisma = prismaPort([account(TFSA_ID, "TFSA"), account(FHSA_ID, "FHSA")]);
    const repository = await memoryWith([]);
    const find = vi.spyOn(repository, "find");
    const input = await loadRrspRoomInput({ prisma, memory: repository }, SUBJECT, "2026-10-29", NOW);
    expect(prisma.activity.findMany).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    expect(input.fx.toCad(1, "USD", "2026-10-01")).toBeNull();
    expect(computeRrspRoom(input)).toEqual({ status: "none" });
  });

  it("no open window (before CRA's table): returns the empty shape without reading", async () => {
    const prisma = prismaPort([account(RRSP_ID, "RRSP")]);
    const input = await loadRrspRoomInput({ prisma, memory: await memoryWith([]) }, SUBJECT, "2020-06-01", NOW);
    expect(prisma.activity.findMany).not.toHaveBeenCalled();
    expect(computeRrspRoom(input)).toEqual({ status: "none" });
  });
});
