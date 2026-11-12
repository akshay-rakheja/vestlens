import { describe, expect, it } from "vitest";

import { accountKey } from "../memory/keys.js";
import { MemoryService } from "../memory/memory-service.js";
import { MemoryFactRepository } from "../testing/memory-fact-repository.js";
import { MemoryRoomAlertPrisma } from "../testing/memory-room-alert-prisma.js";
import { roomAlertText, storedRoomAlertText } from "../mcp/room-tools.js";
import { reevaluateRoomAlert, RoomAlertService } from "./room-alerts.js";
import type { RoomPrismaPort } from "./room-loader.js";
import type { RoomResult } from "./tfsa-room.js";

// Synthetic subjects, ids and amounts only.
const ME = "subject|synthetic-room-alerts";
const OTHER = "subject|synthetic-room-alerts-other";
const TFSA_ID = "synthetic-acct-tfsa";
const NOW = new Date("2026-10-24T16:00:00Z");
const LATER = new Date("2026-10-25T16:00:00Z");
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
const noFx = { contributions: { estimated: false, rateDates: [], native: [] }, withdrawals: { estimated: false, rateDates: [], native: [] } };
const noLedger = { rows: [], overSince: null, undatedExcess: false };

const known = (overLimitCad: number, year = 2026): RoomResult => ({
  status: "known", year, roomLeftCad: overLimitCad > 0 ? -overLimitCad : 500, contributedCad: 7000, craRoomCad: 7000 - (overLimitCad > 0 ? -overLimitCad : 500),
  withdrawnCad: 0, returningCad: 0, estimated: false, basis: [], overLimitCad, activityAsOf: "2026-10-24T08:00:00.000Z", fx: noFx, fxDates: [], ledger: noLedger,
  headlineBasis: "Based on your connected TFSAs",
});
const missing = (year = 2026): RoomResult => ({ status: "missing", year, missing: [{ kind: "cra_room" }], withdrawnCad: 0, returningCad: 0, basis: [], fx: noFx, fxDates: [], ledger: noLedger });

function setup() {
  const prisma = new MemoryRoomAlertPrisma();
  return { prisma, alerts: new RoomAlertService({ prisma, now: () => NOW }) };
}

describe("RoomAlertService.evaluateRoomAlert", () => {
  it("an excess resting on an undated total after a dated withdrawal (dated_entries) raises nothing", async () => {
    const { prisma, alerts } = setup();
    const guess = { ...missing(), missing: [{ kind: "dated_entries", label: "Synthetic outside TFSA", accountKey: "outside:synthetic-outside-tfsa" }] } as RoomResult;
    expect(await alerts.evaluateRoomAlert(ME, guess, NOW)).toBe("none");
    expect(prisma.rows).toHaveLength(0);
  });

  it("raises one alert for a known result over the limit; the same excess the next night changes nothing", async () => {
    const { prisma, alerts } = setup();
    expect(await alerts.evaluateRoomAlert(ME, known(1250.5), NOW)).toBe("raised");
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]).toMatchObject({ subject: ME, year: 2026, raisedAt: NOW, updatedAt: NOW, clearedAt: null });
    expect(Number(prisma.rows[0]!.excessCad)).toBe(1250.5);
    expect(await alerts.evaluateRoomAlert(ME, known(1250.5), LATER)).toBe("none");
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]!.updatedAt).toEqual(NOW);
    expect(await alerts.openRoomAlert(ME, NOW)).toEqual({ year: 2026, excessCad: 1250.5, estimated: false, note: null });
  });

  it("an over amount that leaves out a managed account says so in the stored note, and the note goes when the figure is saved", async () => {
    const { prisma, alerts } = setup();
    const hedged: RoomResult = { ...known(1000), notCounted: [{ accountKey: "k1", label: "Synthetic Managed TFSA" }] } as RoomResult;
    expect(await alerts.evaluateRoomAlert(ME, hedged, NOW)).toBe("raised");
    const open = await alerts.openRoomAlert(ME, NOW);
    expect(open?.note).toBe("(not counting Synthetic Managed TFSA, so it could be more)");
    expect(storedRoomAlertText(open!)).toBe(roomAlertText(hedged as Extract<RoomResult, { status: "known" }>));
    expect(storedRoomAlertText(open!)).toBe("Your TFSA contributions this year are about $1,000 (not counting Synthetic Managed TFSA, so it could be more) over your room. CRA charges 1% a month on the excess.");
    expect(await alerts.evaluateRoomAlert(ME, known(1000), LATER)).toBe("updated");
    expect((await alerts.openRoomAlert(ME, LATER))?.note).toBeNull();
  });

  it("room left above 0 with a managed account not counted raises nothing and doesn't crash", async () => {
    const { prisma, alerts } = setup();
    const under: RoomResult = { ...known(0), notCounted: [{ accountKey: "k1", label: "Synthetic Managed TFSA" }] } as RoomResult;
    expect(await alerts.evaluateRoomAlert(ME, under, NOW)).toBe("none");
    expect(prisma.rows).toHaveLength(0);
  });

  it("a different excess updates the same row in place", async () => {
    const { prisma, alerts } = setup();
    await alerts.evaluateRoomAlert(ME, known(1000), NOW);
    expect(await alerts.evaluateRoomAlert(ME, known(1500), LATER)).toBe("updated");
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]).toMatchObject({ raisedAt: NOW, updatedAt: LATER, clearedAt: null });
    expect(await alerts.openRoomAlert(ME, LATER)).toEqual({ year: 2026, excessCad: 1500, estimated: false, note: null });
  });

  it("room of $0 or more clears an open alert; a missing result clears it too and never raises one", async () => {
    const { prisma, alerts } = setup();
    expect(await alerts.evaluateRoomAlert(ME, missing(), NOW)).toBe("none");
    expect(prisma.rows).toHaveLength(0);
    expect(await alerts.evaluateRoomAlert(ME, known(0), NOW)).toBe("none");
    expect(prisma.rows).toHaveLength(0);

    await alerts.evaluateRoomAlert(ME, known(800), NOW);
    expect(await alerts.evaluateRoomAlert(ME, known(0), LATER)).toBe("cleared");
    expect(prisma.rows[0]!.clearedAt).toEqual(LATER);
    expect(await alerts.openRoomAlert(ME, LATER)).toBeNull();
    expect(await alerts.evaluateRoomAlert(ME, known(0), LATER)).toBe("none");

    await alerts.evaluateRoomAlert(ME, known(800), LATER);
    expect(await alerts.evaluateRoomAlert(ME, missing(), LATER)).toBe("cleared");
    expect(await alerts.openRoomAlert(ME, LATER)).toBeNull();
  });

  it("stale-only with the result computed as if fresh: lowers, never raises or increases; clears when not over or another input is missing", async () => {
    const { prisma, alerts } = setup();
    const stale = { ...missing(), missing: [{ kind: "stale_activity", accountKey: accountKey(TFSA_ID), label: "Synthetic TFSA", lastSyncedAt: null }] } as RoomResult;
    // No open alert: never raised while stale.
    expect(await alerts.evaluateRoomAlert(ME, stale, NOW, { ignoringFreshness: known(900) })).toBe("none");
    expect(prisma.rows).toHaveLength(0);
    await alerts.evaluateRoomAlert(ME, known(800), NOW);
    // Higher while stale: held at 800.
    expect(await alerts.evaluateRoomAlert(ME, stale, LATER, { ignoringFreshness: known(1200) })).toBe("none");
    expect(await alerts.openRoomAlert(ME, LATER)).toMatchObject({ excessCad: 800 });
    // Lower while stale: lowered.
    expect(await alerts.evaluateRoomAlert(ME, stale, LATER, { ignoringFreshness: known(300) })).toBe("updated");
    expect(await alerts.openRoomAlert(ME, LATER)).toMatchObject({ excessCad: 300 });
    // Not over: cleared. Another missing input: cleared.
    expect(await alerts.evaluateRoomAlert(ME, stale, LATER, { ignoringFreshness: known(0) })).toBe("cleared");
    await alerts.evaluateRoomAlert(ME, known(800), LATER);
    expect(await alerts.evaluateRoomAlert(ME, stale, LATER, { ignoringFreshness: missing() })).toBe("cleared");
    // Without the as-if-fresh result there is nothing to check the alert against, so a stale-only result clears as any missing one does.
    await alerts.evaluateRoomAlert(ME, known(800), LATER);
    expect(await alerts.evaluateRoomAlert(ME, stale, LATER)).toBe("cleared");
  });

  it("stores the room text's formatted note with the excess, and a changed note alone updates the row", async () => {
    const { prisma, alerts } = setup();
    const usd = { estimated: true, rateDates: ["2026-06-01"], native: [{ amount: 4000, currency: "USD" }] };
    const converted = (over: number, fx = usd): RoomResult => ({ ...known(over), estimated: fx.estimated, fx: { ...noFx, contributions: fx } } as RoomResult);
    expect(await alerts.evaluateRoomAlert(ME, converted(400), NOW)).toBe("raised");
    const note = "(est.; includes US$4,000 converted at the Bank of Canada rate of 2026-06-01)";
    expect(prisma.rows[0]).toMatchObject({ estimated: true, note });
    expect(await alerts.openRoomAlert(ME, NOW)).toEqual({ year: 2026, excessCad: 400, estimated: true, note });
    expect(await alerts.evaluateRoomAlert(ME, converted(400), LATER)).toBe("none");
    const later = { ...usd, rateDates: ["2026-06-02"] };
    expect(await alerts.evaluateRoomAlert(ME, converted(400, later), LATER)).toBe("updated");
    expect(prisma.rows[0]).toMatchObject({ estimated: true, note: "(est.; includes US$4,000 converted at the Bank of Canada rate of 2026-06-02)", updatedAt: LATER });
    expect(await alerts.evaluateRoomAlert(ME, known(400), LATER)).toBe("updated");
    expect(prisma.rows[0]).toMatchObject({ estimated: false, note: null });
  });

  it("crossing again in the same year reopens the year's one row", async () => {
    const { prisma, alerts } = setup();
    await alerts.evaluateRoomAlert(ME, known(800), NOW);
    await alerts.evaluateRoomAlert(ME, known(0), NOW);
    expect(await alerts.evaluateRoomAlert(ME, known(300), LATER)).toBe("raised");
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]).toMatchObject({ raisedAt: LATER, updatedAt: LATER, clearedAt: null });
  });

  it("a new year is a new row; last year's alert stays as history and is not open this year", async () => {
    const { prisma, alerts } = setup();
    await alerts.evaluateRoomAlert(ME, known(800, 2025), new Date("2025-12-01T16:00:00Z"));
    expect(await alerts.openRoomAlert(ME, new Date("2025-12-31T16:00:00Z"))).toEqual({ year: 2025, excessCad: 800, estimated: false, note: null });
    // 1 January 2026 in Toronto (still 31 December nowhere relevant): the 2025 row is not this year's.
    expect(await alerts.openRoomAlert(ME, new Date("2026-01-01T06:00:00Z"))).toBeNull();
    expect(await alerts.evaluateRoomAlert(ME, missing(2026), NOW)).toBe("none");
    expect(prisma.rows).toHaveLength(1);
    // The first evaluation of the new year closes last year's open row; it stays as history.
    expect(prisma.rows[0]).toMatchObject({ year: 2025, clearedAt: NOW, updatedAt: NOW });
    expect(await alerts.evaluateRoomAlert(ME, known(200, 2026), NOW)).toBe("raised");
    expect(prisma.rows.map((r) => r.year)).toEqual([2025, 2026]);
    expect(prisma.rows[1]!.clearedAt).toBeNull();
  });

  it("closes every earlier open year's row at rollover, leaves other subjects, already-cleared rows and this year alone", async () => {
    const { prisma, alerts } = setup();
    const long = new Date("2025-12-01T16:00:00Z");
    await alerts.evaluateRoomAlert(ME, known(800, 2024), long);
    await alerts.evaluateRoomAlert(ME, known(800, 2025), long);
    await alerts.evaluateRoomAlert(ME, known(0, 2024), long);
    await alerts.evaluateRoomAlert(OTHER, known(700, 2025), long);
    const cleared2024 = prisma.rows.find((r) => r.subject === ME && r.year === 2024)!.clearedAt;
    await alerts.evaluateRoomAlert(ME, known(300, 2026), NOW);
    const mine = (year: number) => prisma.rows.find((r) => r.subject === ME && r.year === year)!;
    expect(mine(2024).clearedAt).toEqual(cleared2024);
    expect(mine(2025).clearedAt).toEqual(NOW);
    expect(mine(2026).clearedAt).toBeNull();
    expect(prisma.rows.find((r) => r.subject === OTHER)!.clearedAt).toBeNull();
  });

  it("the Toronto year decides which row is open: 31 December 23:30 Toronto is still that year", async () => {
    const { alerts } = setup();
    await alerts.evaluateRoomAlert(ME, known(800, 2026), NOW);
    expect(await alerts.openRoomAlert(ME, new Date("2027-01-01T04:30:00Z"))).toEqual({ year: 2026, excessCad: 800, estimated: false, note: null });
  });

  it("is scoped by subject", async () => {
    const { alerts } = setup();
    await alerts.evaluateRoomAlert(ME, known(800), NOW);
    expect(await alerts.openRoomAlert(OTHER, NOW)).toBeNull();
    expect(await alerts.listForExport(OTHER)).toEqual([]);
  });

  it("a concurrent first raise ends with one row (the loser updates it)", async () => {
    const { prisma, alerts } = setup();
    prisma.beforeCreate = async () => {
      prisma.beforeCreate = undefined;
      prisma.rows.push({ subject: ME, year: 2026, excessCad: "800.00", estimated: false, note: null, raisedAt: NOW, updatedAt: NOW, clearedAt: null });
    };
    expect(await alerts.evaluateRoomAlert(ME, known(900), NOW)).toBe("updated");
    expect(prisma.rows).toHaveLength(1);
    expect(Number(prisma.rows[0]!.excessCad)).toBe(900);
  });

  it("exports the subject's rows without the subject", async () => {
    const { alerts } = setup();
    await alerts.evaluateRoomAlert(ME, known(800), NOW);
    expect(await alerts.listForExport(ME)).toEqual([{ year: 2026, excessCad: "800.00", estimated: false, note: null, raisedAt: NOW, updatedAt: NOW, clearedAt: null }]);
  });
});

describe("reevaluateRoomAlert (stored inputs end to end)", () => {
  const roomPrisma = (amount: number): RoomPrismaPort => ({
    brokerageAccount: {
      findMany: async () => [{
        snapTradeAccountId: TFSA_ID, displayName: null, institutionName: "Synthetic Broker", rawType: "TFSA", status: "OPEN",
        snapshots: [{ payload: { account: { type: "TFSA", metaType: null, unifiedType: null, status: "OPEN" }, positions: [] } }],
      }],
    },
    activity: { findMany: async () => [{ snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-dedupe-1", type: "CONTRIBUTION", amount, currency: "CAD", fxRate: null, tradeDate: day("2026-06-01") }] as never },
    activitySyncState: { findMany: async () => [{ snapTradeAccountId: TFSA_ID, backfillCompletedAt: day("2026-02-01"), earliestTradeDate: day("2023-05-01"), lastSyncedAt: new Date("2026-10-24T08:00:00Z"), lastError: null, dirty: false }] },
  });
  const node = { type: "tax_year" as const, key: "2026:tfsa" };

  it("deleting the tax_year.cra_room_jan1 fact clears the alert on the next evaluation", async () => {
    const repository = new MemoryFactRepository();
    const memory = new MemoryService({ repository, log: () => {}, now: () => NOW });
    await memory.remember(ME, { node, property: "tax_year.cra_room_jan1", value: { amountCad: 5000 }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW, "system");
    await memory.remember(ME, { node, property: "tax_year.account_set", value: { connected: [accountKey(TFSA_ID)], outside: [], confirmedAt: "2026-02-01T15:00:00.000Z" }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW, "system");
    const { alerts } = setup();
    const deps = { loader: { prisma: roomPrisma(6000), memory: repository }, alerts, now: () => NOW };

    const first = await reevaluateRoomAlert(deps, ME);
    expect(first.outcome).toBe("raised");
    expect(first.result).toMatchObject({ status: "known", overLimitCad: 1000 });
    expect(await alerts.openRoomAlert(ME, NOW)).toEqual({ year: 2026, excessCad: 1000, estimated: false, note: null });

    await memory.forget(ME, { node, property: "tax_year.cra_room_jan1" });
    const second = await reevaluateRoomAlert(deps, ME);
    expect(second.outcome).toBe("cleared");
    expect(second.result.status).toBe("missing");
    expect(await alerts.openRoomAlert(ME, NOW)).toBeNull();
  });
});
