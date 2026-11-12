import { describe, expect, it, vi } from "vitest";

import { accountKey, activityKey, outsideAccountKey } from "../memory/keys.js";
import { MemoryService } from "../memory/memory-service.js";
import type { Provenance } from "../memory/memory-types.js";
import { MemoryFactRepository } from "../testing/memory-fact-repository.js";
import { loadRoomBase, loadRoomInput, roomFx, torontoToday, type RoomPrismaPort } from "./room-loader.js";
import { computeTfsaRoom, COVERS_FROM_START } from "./tfsa-room.js";

// Synthetic ids, labels and amounts only.
const SUBJECT = "subject|synthetic-room-loader";
const TFSA_ID = "synthetic-acct-tfsa";
const CLOSED_ID = "synthetic-acct-closed-tfsa";
const ODD_ID = "synthetic-acct-neutral";
const RRSP_ID = "synthetic-acct-rrsp";
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
const NOW = new Date("2026-10-24T16:00:00Z");
const SYNCED = new Date("2026-10-24T08:00:00Z");
const ok = { lastSyncedAt: SYNCED, lastError: null, dirty: false };

const snap = (type: string, status: string | null = "OPEN") => [{ payload: { account: { type, metaType: null, unifiedType: null, status }, positions: [] } }];

const isCounterpartQuery = (input: unknown) => (input as { where: { OR?: Array<Record<string, unknown>> } }).where.OR?.some((o) => "type" in o) ?? false;
/** The New Year check's read of last 27–31 December: a plain tradeDate range, no OR. */
const isPriorDecemberQuery = (input: unknown) => (input as { where: { OR?: unknown } }).where.OR === undefined;

function prismaPort(over: {
  activities?: Array<Record<string, unknown>>; counterparts?: Array<Record<string, unknown>>; sync?: Array<Record<string, unknown>>; accounts?: Array<Record<string, unknown>>;
  priorDecember?: Array<Record<string, unknown>>;
} = {}) {
  const port: RoomPrismaPort = {
    brokerageAccount: {
      findMany: vi.fn(async () => (over.accounts ?? [
        { snapTradeAccountId: TFSA_ID, displayName: null, institutionName: "Synthetic Broker", rawType: "TFSA", status: "OPEN", snapshots: snap("TFSA") },
        { snapTradeAccountId: CLOSED_ID, displayName: "Old synthetic TFSA", institutionName: "Synthetic Broker", rawType: "TFSA", status: "CLOSED", snapshots: snap("TFSA", "CLOSED") },
        { snapTradeAccountId: ODD_ID, displayName: null, institutionName: "Synthetic Broker", rawType: "MYSTERY", status: "OPEN", snapshots: snap("MYSTERY") },
        { snapTradeAccountId: RRSP_ID, displayName: null, institutionName: "Synthetic Broker", rawType: "RRSP", status: "OPEN", snapshots: snap("RRSP") },
      ]) as never),
    },
    activity: {
      findMany: vi.fn(async (input: unknown) => (isPriorDecemberQuery(input) ? over.priorDecember ?? []
        : isCounterpartQuery(input) ? over.counterparts ?? [] : over.activities ?? []) as never),
    },
    activitySyncState: {
      findMany: vi.fn(async () => (over.sync ?? [
        { snapTradeAccountId: TFSA_ID, backfillCompletedAt: new Date("2026-02-01T00:00:00Z"), earliestTradeDate: day("2024-03-01"), ...ok },
      ]) as never),
    },
  };
  return port;
}

async function service(facts: Array<{ node: { type: string; key: string }; property: string; value: unknown; provenance?: Provenance }> = []) {
  const repository = new MemoryFactRepository();
  const memory = new MemoryService({ repository, log: () => {} });
  for (const f of facts) {
    if (f.provenance === "inferred") {
      // validateFact refuses inferred TFSA inputs now; a row stored before that rule still must never feed the room.
      const validFrom = f.property === "activity.room_effect" ? null : new Date(Date.UTC(f.property.startsWith("account.") ? (f.value as { year: number }).year : Number(f.node.key.slice(0, 4)), 0, 1));
      await repository.supersedeAndInsert({
        subject: SUBJECT, nodeType: f.node.type, nodeKey: f.node.key, property: f.property, value: f.value, text: "Synthetic.", kind: "fact",
        provenance: "inferred", validFrom, validTo: null, recordedAt: new Date("2026-03-01T12:00:00Z"), source: "claude",
      }, { sameValidFrom: true });
      continue;
    }
    await memory.remember(SUBJECT, { ...f, node: f.node as never, text: "Synthetic.", kind: "fact", provenance: f.provenance ?? "stated" }, new Date("2026-03-01T12:00:00Z"), "system");
  }
  return repository;
}

describe("loadRoomInput", () => {
  it("passes TFSA-bucket accounts (closed included) and neutral accounts, never other buckets", async () => {
    const prisma = prismaPort();
    const input = await loadRoomInput({ prisma, memory: await service() }, SUBJECT, "2026-10-24", NOW);
    expect(input.today).toBe("2026-10-24");
    expect(input.accounts).toEqual([
      { accountKey: accountKey(TFSA_ID), label: "Synthetic Broker TFSA", bucket: "tfsa", neutral: false, closed: false, managed: false, maskedNumber: null, value: null },
      { accountKey: accountKey(CLOSED_ID), label: "Old synthetic TFSA", bucket: "tfsa", neutral: false, closed: true, managed: false, maskedNumber: null, value: null },
      { accountKey: accountKey(ODD_ID), label: "Synthetic Broker Other account", bucket: "other", neutral: true, closed: false, managed: false, maskedNumber: null, value: null },
    ]);
    // A managed TFSA is passed with `managed` set, whether SnapTrade reports its value as 0 or not at all (A9).
    const managedId = "synthetic-acct-managed-tfsa";
    for (const reportedTotal of [0, null]) {
      const withManaged = prismaPort({ accounts: [
        { snapTradeAccountId: TFSA_ID, displayName: null, institutionName: "Synthetic Broker", rawType: "TFSA", status: "OPEN", snapshots: snap("TFSA") },
        { snapTradeAccountId: managedId, displayName: null, institutionName: "Synthetic Broker", rawType: "TFSA", status: "OPEN", reportedTotal, reportedCurrency: "CAD",
          snapshots: [{ payload: { account: { type: "TFSA", metaType: null, unifiedType: "MANAGED_TFSA", status: "OPEN" }, positions: [] } }] },
      ] });
      const managed = await loadRoomInput({ prisma: withManaged, memory: await service() }, SUBJECT, "2026-10-24", NOW);
      expect(managed.accounts.map((a) => [a.accountKey, a.bucket, a.managed])).toEqual([[accountKey(TFSA_ID), "tfsa", false], [accountKey(managedId), "tfsa", true]]);
    }
    // Every query is by auth subject.
    const accountQuery = (prisma.brokerageAccount.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(accountQuery.where).toEqual({ appUser: { authSubject: SUBJECT } });
    const activityQuery = (prisma.activity.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(activityQuery.where.appUser).toEqual({ authSubject: SUBJECT });
    expect(activityQuery.where.snapTradeAccountId).toEqual({ in: [TFSA_ID, CLOSED_ID, ODD_ID] });
    expect(activityQuery.where.OR[0]).toEqual({ tradeDate: { gte: day("2026-01-01"), lt: day("2027-01-01") } });
    expect(activityQuery.select).not.toHaveProperty("description");
  });

  it("maps activity rows to Toronto YYYY-MM-DD strings, numbers and activity keys", async () => {
    const prisma = prismaPort({
      activities: [
        { snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-dedupe-1", type: "CONTRIBUTION", amount: "500.25", currency: "CAD", fxRate: null, tradeDate: day("2026-12-31") },
        { snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-dedupe-2", type: "CONTRIBUTION", amount: { toString: () => "100" }, currency: "USD", fxRate: "1.37", tradeDate: null },
      ],
    });
    const input = await loadRoomInput({ prisma, memory: await service() }, SUBJECT, "2026-10-24", NOW);
    expect(input.activities).toEqual([
      { accountKey: accountKey(TFSA_ID), activityKey: activityKey("synthetic-dedupe-1"), type: "CONTRIBUTION", amount: 500.25, currency: "CAD", fxRate: null, tradeDate: "2026-12-31", units: null, price: null, symbol: null, securityCurrency: null },
      { accountKey: accountKey(TFSA_ID), activityKey: activityKey("synthetic-dedupe-2"), type: "CONTRIBUTION", amount: 100, currency: "USD", fxRate: 1.37, tradeDate: null, units: null, price: null, symbol: null, securityCurrency: null },
    ]);
    expect(input.prices).toBeUndefined();
  });

  it("shares moved in kind: units, price and symbol pass through; without a price, closes are read once per ticker and value the row (A2)", async () => {
    const inKind = (dedupeKey: string, price: string | null) =>
      ({ snapTradeAccountId: TFSA_ID, dedupeKey, type: "TRANSFER", amount: "0", currency: "CAD", fxRate: null, tradeDate: day("2026-03-16"), units: "100", price, symbol: "SYN", securityCurrency: "CAD" });
    const securityHistory = vi.fn(async (ticker: string) => (ticker === "SYN"
      ? { points: [{ date: "2026-03-13", close: 95 }, { date: "2026-03-17", close: 99 }], splits: [] }
      : null));
    const market = { usdCad: async () => null, securityHistory };
    const prisma = prismaPort({ activities: [inKind("synthetic-ik-priced", "100"), inKind("synthetic-ik-unpriced", null)] });
    const input = await loadRoomInput({ prisma, memory: await service(), market }, SUBJECT, "2026-10-24", NOW);
    expect(input.activities[0]).toMatchObject({ type: "TRANSFER", amount: 0, units: 100, price: 100, symbol: "SYN", securityCurrency: "CAD" });
    // One read per ticker, from 10 days before 1 January through today; the close on or before the trade date (16 March → 13 March).
    expect(securityHistory).toHaveBeenCalledTimes(1);
    expect(securityHistory).toHaveBeenCalledWith("SYN", "2025-12-22", "2026-10-24");
    expect(input.prices?.closeOn(input.activities[1]!, "2026-03-16")).toEqual({ price: 95, currency: "CAD" });
    // The query never reads the description.
    const activityQuery = (prisma.activity.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(activityQuery.select).toMatchObject({ units: true, price: true, symbol: true, securityCurrency: true });
    expect(activityQuery.select).not.toHaveProperty("description");
    // Every row priced, or no market: no price read, no port.
    const priced = await loadRoomInput({ prisma: prismaPort({ activities: [inKind("synthetic-ik-priced", "100")] }), memory: await service(), market }, SUBJECT, "2026-10-24", NOW);
    expect(priced.prices).toBeUndefined();
    expect(securityHistory).toHaveBeenCalledTimes(1);
  });

  it("coverage: the whole history once the backfill completed (whatever the earliest trade); unknown otherwise", async () => {
    const prisma = prismaPort({
      sync: [
        { snapTradeAccountId: TFSA_ID, backfillCompletedAt: new Date("2026-02-01T00:00:00Z"), earliestTradeDate: day("2026-01-05"), ...ok },
        { snapTradeAccountId: CLOSED_ID, backfillCompletedAt: null, earliestTradeDate: day("2020-01-01"), ...ok },
      ],
    });
    const input = await loadRoomInput({ prisma, memory: await service() }, SUBJECT, "2026-10-24", NOW);
    expect(input.coverage.get(accountKey(TFSA_ID))).toEqual({ coversFrom: COVERS_FROM_START });
    expect(input.coverage.get(accountKey(CLOSED_ID))).toEqual({ coversFrom: null });
    expect(input.coverage.get(accountKey(ODD_ID))).toEqual({ coversFrom: null });
  });

  it("freshness: each account's last sync time, error and dirty flag; no row means never synced", async () => {
    const prisma = prismaPort({
      sync: [
        { snapTradeAccountId: TFSA_ID, backfillCompletedAt: new Date("2026-02-01T00:00:00Z"), earliestTradeDate: day("2024-03-01"), ...ok },
        { snapTradeAccountId: CLOSED_ID, backfillCompletedAt: null, earliestTradeDate: null, lastSyncedAt: new Date("2026-10-20T08:00:00Z"), lastError: "provider_error", dirty: true },
      ],
    });
    const input = await loadRoomInput({ prisma, memory: await service() }, SUBJECT, "2026-10-24", NOW);
    expect(input.now).toBe(NOW.toISOString());
    expect(input.sync.get(accountKey(TFSA_ID))).toEqual({ lastSyncedAt: SYNCED.toISOString(), lastError: false, dirty: false });
    expect(input.sync.get(accountKey(CLOSED_ID))).toEqual({ lastSyncedAt: "2026-10-20T08:00:00.000Z", lastError: true, dirty: true });
    expect(input.sync.get(accountKey(ODD_ID))).toBeUndefined();
    const syncQuery = (prisma.activitySyncState.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(syncQuery.select).toMatchObject({ lastSyncedAt: true, lastError: true, dirty: true });
    // Every connected account's key, whatever its bucket, so a confirmed key that is gone can be told apart.
    expect(input.connectedAccountKeys).toEqual([TFSA_ID, CLOSED_ID, ODD_ID, RRSP_ID].map(accountKey));
  });

  it("passes current facts only, excludes inferred ones, and includes connected and outside year-to-date figures", async () => {
    const node = { type: "tax_year", key: "2026:tfsa" };
    const repo = await service([
      { node, property: "tax_year.cra_room_jan1", value: { amountCad: 6000 } },
      { node, property: "tax_year.cra_room_jan1", value: { amountCad: 7000 } },
      { node, property: "tax_year.account_set", value: { connected: [accountKey(TFSA_ID)], outside: [{ label: "Other bank" }], confirmedAt: "2026-02-01T15:00:00.000Z" }, provenance: "inferred" },
      { node: { type: "account", key: outsideAccountKey("Other bank") }, property: "account.ytd_contributions", value: { year: 2026, amountCad: 1000, asOf: "2026-02-01" } },
      { node: { type: "account", key: accountKey(CLOSED_ID) }, property: "account.ytd_contributions", value: { year: 2026, amountCad: 200, asOf: "2026-02-01" } },
      { node: { type: "account", key: accountKey(ODD_ID) }, property: "account.ytd_contributions", value: { year: 2026, amountCad: 50, asOf: "2026-02-01" }, provenance: "inferred" },
      { node: { type: "activity", key: activityKey("synthetic-dedupe-1") }, property: "activity.room_effect", value: { effect: "none" } },
      { node: { type: "activity", key: activityKey("synthetic-dedupe-2") }, property: "activity.room_effect", value: { effect: "contribution" }, provenance: "inferred" },
      { node: { type: "tax_year", key: "2025:tfsa" }, property: "tax_year.cra_room_jan1", value: { amountCad: 1 } },
    ]);
    const input = await loadRoomInput({ prisma: prismaPort(), memory: repo }, SUBJECT, "2026-10-24", NOW);
    expect((input.memory.craRoom?.value as { amountCad: number }).amountCad).toBe(7000);
    expect(input.memory.accountSet).toBeNull();
    expect(input.memory.outside.map((f) => (f.value as { amountCad: number }).amountCad).sort()).toEqual([1000, 200]);
    expect([...input.memory.classifications]).toEqual([[activityKey("synthetic-dedupe-1"), "none"]]);
  });

  it("passes the latest stated account set from an earlier year as previousAccountSet, whether or not this year has one", async () => {
    const set = (year: number) => ({ connected: [accountKey(ODD_ID)], outside: [{ label: "Other bank" }], confirmedAt: `${year}-02-01T15:00:00.000Z`, notTfsa: [accountKey(TFSA_ID)] });
    const at = (year: number, provenance: Provenance = "stated") => ({ node: { type: "tax_year", key: `${year}:tfsa` }, property: "tax_year.account_set", value: set(year), provenance });
    const older = await loadRoomInput({ prisma: prismaPort(), memory: await service([at(2023), at(2024), at(2025, "inferred"), at(2027)]) }, SUBJECT, "2026-10-24", NOW);
    expect(older.memory.accountSet).toBeNull();
    expect(older.previousAccountSet?.value).toEqual(set(2024));
    // The engine reads it: last year's notTfsa still excludes the broker TFSA.
    expect(computeTfsaRoom(older).basis).toContain("Your TFSAs as confirmed for 2024 on 2024-02-01 (you said), carried forward");

    const both = await loadRoomInput({ prisma: prismaPort(), memory: await service([at(2025), at(2026)]) }, SUBJECT, "2026-10-24", NOW);
    expect(both.memory.accountSet?.value).toEqual(set(2026));
    expect(both.previousAccountSet?.value).toEqual(set(2025));

    const none = await loadRoomInput({ prisma: prismaPort(), memory: await service([]) }, SUBJECT, "2026-10-24", NOW);
    expect(none.previousAccountSet).toBeNull();
  });

  it("falls back to the next older valid set when the newest earlier one is malformed or its outside labels collide", async () => {
    const good = { connected: [], outside: [{ label: "Other bank" }], confirmedAt: "2024-02-01T15:00:00.000Z", notTfsa: [accountKey(TFSA_ID)] };
    const repo = await service([{ node: { type: "tax_year", key: "2024:tfsa" }, property: "tax_year.account_set", value: good }]);
    // Rows stored before today's write checks: a 2025 set whose labels share a key, then a malformed 2025 one.
    for (const [key, value] of [["2025:tfsa", { connected: [], outside: [{ label: "RBC TFSA" }, { label: "rbc-tfsa" }], confirmedAt: "2025-02-01T15:00:00.000Z", notTfsa: [] }], ["2025:tfsa", { connected: "nope" }]] as const) {
      await repo.supersedeAndInsert({
        subject: SUBJECT, nodeType: "tax_year", nodeKey: key, property: "tax_year.account_set", value, text: "Synthetic.", kind: "fact",
        provenance: "stated", validFrom: new Date(Date.UTC(2025, 0, 1)), validTo: null, recordedAt: new Date("2026-03-01T12:00:00Z"), source: "claude",
      }, { sameValidFrom: true });
      const input = await loadRoomInput({ prisma: prismaPort(), memory: repo }, SUBJECT, "2026-10-24", NOW);
      expect(input.previousAccountSet?.value).toEqual(good);
    }
  });

  it("passes current account.tfsa_moves facts as outsideMoves, excluding inferred and superseded ones", async () => {
    const key = outsideAccountKey("Other bank");
    const entries = (amountCad: number) => [{ date: "2026-03-01", amountCad, kind: "deposit" }];
    const repo = await service([
      { node: { type: "account", key }, property: "account.tfsa_moves", value: { year: 2026, entries: entries(100) } },
      { node: { type: "account", key }, property: "account.tfsa_moves", value: { year: 2026, entries: entries(250) } },
      { node: { type: "account", key: outsideAccountKey("Third bank") }, property: "account.tfsa_moves", value: { year: 2026, entries: entries(75) }, provenance: "inferred" },
      { node: { type: "account", key }, property: "account.ytd_contributions", value: { year: 2026, amountCad: 1000, asOf: "2026-02-01" } },
    ]);
    const input = await loadRoomInput({ prisma: prismaPort(), memory: repo }, SUBJECT, "2026-10-24", NOW);
    expect(input.memory.outsideMoves.map((f) => [f.property, f.node.key, (f.value as { entries: Array<{ amountCad: number }> }).entries[0]!.amountCad])).toEqual([
      ["account.tfsa_moves", key, 250],
    ]);
    expect(input.memory.outside.map((f) => f.property)).toEqual(["account.ytd_contributions"]);
  });

  it("feeds computeTfsaRoom end to end", async () => {
    const node = { type: "tax_year", key: "2026:tfsa" };
    const repo = await service([
      { node, property: "tax_year.cra_room_jan1", value: { amountCad: 7000 } },
      { node, property: "tax_year.account_set", value: { connected: [accountKey(TFSA_ID), accountKey(CLOSED_ID)], outside: [], confirmedAt: "2026-02-01T15:00:00.000Z", notTfsa: [accountKey(ODD_ID)] } },
    ]);
    const prisma = prismaPort({
      activities: [{ snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-dedupe-9", type: "CONTRIBUTION", amount: 2000, currency: "CAD", fxRate: null, tradeDate: day("2026-04-01") }],
      sync: [
        { snapTradeAccountId: TFSA_ID, backfillCompletedAt: new Date("2026-02-01T00:00:00Z"), earliestTradeDate: day("2024-03-01"), ...ok },
        { snapTradeAccountId: CLOSED_ID, backfillCompletedAt: new Date("2026-02-01T00:00:00Z"), earliestTradeDate: day("2021-03-01"), ...ok },
      ],
    });
    const result = computeTfsaRoom(await loadRoomInput({ prisma, memory: repo }, SUBJECT, "2026-10-24", NOW));
    expect(result).toMatchObject({ status: "known", roomLeftCad: 5000, contributedCad: 2000 });
  });
});

describe("roomFx (Bank of Canada fallback)", () => {
  const series = [
    { date: "2025-12-31", close: 1.37 },
    { date: "2026-07-02", close: 1.36 },
    { date: "2026-07-03", close: 1.35 },
  ];

  it("uses the nearest previous Bank of Canada rate on a weekend or holiday, estimated", async () => {
    const market = { usdCad: vi.fn(async () => series) };
    const fx = await roomFx(market, "2026-10-24", true);
    // 1 January 2026 is a holiday: the 31 December rate is used.
    expect(fx.toCad(100, "USD", "2026-01-01")).toEqual({ cad: 137, estimated: true, rateDate: "2025-12-31" });
    // Saturday 4 July: Friday's rate.
    expect(fx.toCad(100, "USD", "2026-07-04")).toEqual({ cad: 135, estimated: true, rateDate: "2026-07-03" });
    // The fetch reaches back before 1 January for the holiday.
    expect(market.usdCad).toHaveBeenCalledWith("2025-12-22", "2026-10-24");
  });

  it("returns null only when no rate exists at all", async () => {
    const fx = await roomFx({ usdCad: async () => series }, "2026-10-24", true);
    expect(fx.toCad(100, "USD", "2026-06-01")).toBeNull(); // more than a week after the previous rate
    expect(fx.toCad(100, "EUR", "2026-07-03")).toBeNull();
    const none = await roomFx({ usdCad: async () => null }, "2026-10-24", true);
    expect(none.toCad(100, "USD", "2026-07-03")).toBeNull();
    const failing = await roomFx({ usdCad: async () => { throw new Error("synthetic outage"); } }, "2026-10-24", true);
    expect(failing.toCad(100, "USD", "2026-07-03")).toBeNull();
  });

  it("makes no request when no row needs converting or there is no market", async () => {
    const market = { usdCad: vi.fn(async () => series) };
    expect((await roomFx(market, "2026-10-24", false)).toCad(1, "USD", "2026-07-03")).toBeNull();
    expect(market.usdCad).not.toHaveBeenCalled();
    expect((await roomFx(undefined, "2026-10-24", true)).toCad(1, "USD", "2026-07-03")).toBeNull();
  });

  it("the loader fetches rates only for foreign rows", async () => {
    const market = { usdCad: vi.fn(async () => series) };
    await loadRoomInput({ prisma: prismaPort(), memory: await service(), market }, SUBJECT, "2026-10-24", NOW);
    expect(market.usdCad).not.toHaveBeenCalled();
    const prisma = prismaPort({ activities: [{ snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-dedupe-3", type: "CONTRIBUTION", amount: 100, currency: "USD", fxRate: null, tradeDate: day("2026-07-04") }] });
    const input = await loadRoomInput({ prisma, memory: await service(), market }, SUBJECT, "2026-10-24", NOW);
    expect(input.fx.toCad(100, "USD", "2026-07-04")).toEqual({ cad: 135, estimated: true, rateDate: "2026-07-03" });
  });
});

describe("torontoToday", () => {
  it("is the Toronto calendar date, not the UTC one", () => {
    expect(torontoToday(new Date("2027-01-01T03:30:00Z"))).toBe("2026-12-31");
    expect(torontoToday(new Date("2026-10-24T16:00:00Z"))).toBe("2026-10-24");
  });
});

describe("loadRoomInput: auto-room inputs", () => {
  const CASH_ID = "synthetic-acct-cash";
  const node = { type: "tax_year", key: "2026:tfsa" };
  const account = (id: string, rawType: string, extra: Record<string, unknown> = {}) =>
    ({ snapTradeAccountId: id, displayName: null, institutionName: "Synthetic Broker", rawType, status: "OPEN", snapshots: snap(rawType), maskedNumber: null, reportedTotal: null, reportedCurrency: null, ...extra });

  it("loads transfer rows from every connected account (24 December last year through this year +3 days), labelled by the loader's rule", async () => {
    const prisma = prismaPort({
      accounts: [account(TFSA_ID, "TFSA"), account(CASH_ID, "MSB")],
      counterparts: [
        { snapTradeAccountId: CASH_ID, dedupeKey: "synthetic-cp-1", type: "INTERNAL_CASH_TRANSFER_OUT", amount: "-1000", currency: "CAD", fxRate: null, tradeDate: day("2026-03-04") },
        { snapTradeAccountId: "synthetic-acct-gone", dedupeKey: "synthetic-cp-2", type: "TRANSFER_OUT", amount: "-5", currency: "CAD", fxRate: null, tradeDate: day("2026-03-04") },
      ],
    });
    const input = await loadRoomInput({ prisma, memory: await service() }, SUBJECT, "2026-10-24", NOW);
    expect(input.counterparts).toEqual([
      { accountKey: accountKey(CASH_ID), label: "Synthetic Broker Cash / money market", activityKey: activityKey("synthetic-cp-1"), type: "INTERNAL_CASH_TRANSFER_OUT", amount: -1000, currency: "CAD", tradeDate: "2026-03-04" },
    ]);
    const calls = (prisma.activity.findMany as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    const query = calls.find(isCounterpartQuery);
    expect(query.where.appUser).toEqual({ authSubject: SUBJECT });
    expect(query.where.snapTradeAccountId).toEqual({ in: [TFSA_ID, CASH_ID] });
    // From 3 days before last 27 December: the New Year check matches last December's transfers too.
    expect(query.where.tradeDate).toEqual({ gte: day("2025-12-24"), lt: day("2027-01-04") });
    expect(query.where.OR).toEqual([{ type: { in: ["INTERNAL_CASH_TRANSFER_IN", "INTERNAL_CASH_TRANSFER_OUT"] } }, { type: { startsWith: "TRANSFER" } }]);
    expect(query.select).not.toHaveProperty("description");
  });

  it("a cash to TFSA transfer is matched end to end, and a completed backfill first funded on 5 January is known", async () => {
    const repo = await service([
      { node, property: "tax_year.cra_room_jan1", value: { amountCad: 7000 } },
      { node, property: "tax_year.account_set", value: { connected: [accountKey(TFSA_ID)], outside: [], confirmedAt: "2026-02-01T15:00:00.000Z", notTfsa: [] } },
    ]);
    const into = { snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-in-1", type: "INTERNAL_CASH_TRANSFER_IN", amount: 1000, currency: "CAD", fxRate: null, tradeDate: day("2026-01-05") };
    const prisma = prismaPort({
      accounts: [account(TFSA_ID, "TFSA"), account(CASH_ID, "MSB")],
      activities: [into],
      counterparts: [into, { snapTradeAccountId: CASH_ID, dedupeKey: "synthetic-out-1", type: "INTERNAL_CASH_TRANSFER_OUT", amount: -1000, currency: "CAD", fxRate: null, tradeDate: day("2026-01-05") }],
      sync: [{ snapTradeAccountId: TFSA_ID, backfillCompletedAt: new Date("2026-02-01T00:00:00Z"), earliestTradeDate: day("2026-01-05"), ...ok }],
    });
    const result = computeTfsaRoom(await loadRoomInput({ prisma, memory: repo }, SUBJECT, "2026-10-24", NOW));
    expect(result).toMatchObject({ status: "known", roomLeftCad: 6000 });
    expect(result.ledger.rows[1]).toMatchObject({ kind: "contribution", inferred: true, matchedWith: { label: "Synthetic Broker Cash / money market", date: "2026-01-05" } });

    // Without a completed backfill the coverage item remains.
    const pending = prismaPort({
      accounts: [account(TFSA_ID, "TFSA")], activities: [into],
      sync: [{ snapTradeAccountId: TFSA_ID, backfillCompletedAt: null, earliestTradeDate: day("2026-01-05"), ...ok }],
    });
    const gap = computeTfsaRoom(await loadRoomInput({ prisma: pending, memory: repo }, SUBJECT, "2026-10-24", NOW));
    // The cash account isn't connected here, so the transfer is unmatched and assumed a contribution: no ambiguous item.
    expect(gap.status === "missing" && gap.missing.map((m) => m.kind)).toEqual(["coverage"]);
  });

  it("two accounts with the same name get distinct labels; masked number and value are passed", async () => {
    const prisma = prismaPort({
      accounts: [
        account(TFSA_ID, "TFSA", { displayName: "Synthetic TFSA", maskedNumber: "****1234", reportedTotal: "12345.678", reportedCurrency: "CAD" }),
        account(CLOSED_ID, "TFSA", { displayName: "Synthetic TFSA", maskedNumber: "xx-9876", reportedTotal: { toString: () => "50" }, reportedCurrency: "USD" }),
        account(ODD_ID, "TFSA", { displayName: "Synthetic unique", maskedNumber: null, reportedTotal: "10", reportedCurrency: null }),
      ],
    });
    const input = await loadRoomInput({ prisma, memory: await service() }, SUBJECT, "2026-10-24", NOW);
    expect(input.accounts.map((a) => [a.label, a.maskedNumber, a.value])).toEqual([
      ["Synthetic TFSA ••1234", "1234", { amount: 12345.68, currency: "CAD" }],
      ["Synthetic TFSA ••9876", "9876", { amount: 50, currency: "USD" }],
      ["Synthetic unique", null, null],
    ]);
    const query = (prisma.brokerageAccount.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(query.select).toMatchObject({ maskedNumber: true, reportedTotal: true, reportedCurrency: true });
  });
});

describe("loadRoomBase: the period", () => {
  const include = (c: { bucket: string }) => c.bucket === "tfsa";
  const queries = (prisma: RoomPrismaPort) => {
    const calls = (prisma.activity.findMany as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    return { activity: calls.find((q) => !isCounterpartQuery(q) && !isPriorDecemberQuery(q)), counterpart: calls.find((q) => isCounterpartQuery(q)) };
  };

  it("a period bounds the activity query and the counterpart window by its own dates", async () => {
    const prisma = prismaPort();
    await loadRoomBase({ prisma, memory: await service() }, SUBJECT, "2026-10-24", include, { from: "2025-03-04", to: "2026-03-02" });
    const { activity, counterpart } = queries(prisma);
    expect(activity.where.OR).toEqual([
      { tradeDate: { gte: day("2025-03-04"), lt: day("2026-03-03") } },
      { tradeDate: null, settlementDate: { gte: day("2025-03-04"), lt: day("2026-03-03") } },
      { tradeDate: null, settlementDate: null },
    ]);
    expect(counterpart.where.tradeDate).toEqual({ gte: day("2025-03-01"), lt: day("2026-03-06") });
  });

  it("the window crosses a month and a year end", async () => {
    const prisma = prismaPort();
    await loadRoomBase({ prisma, memory: await service() }, SUBJECT, "2026-10-24", include, { from: "2026-01-02", to: "2026-12-31" });
    const { activity, counterpart } = queries(prisma);
    expect(activity.where.OR[0]).toEqual({ tradeDate: { gte: day("2026-01-02"), lt: day("2027-01-01") } });
    expect(counterpart.where.tradeDate).toEqual({ gte: day("2025-12-30"), lt: day("2027-01-04") });
  });

  it("without a period it is the Toronto calendar year of today, as before", async () => {
    const prisma = prismaPort();
    await loadRoomBase({ prisma, memory: await service() }, SUBJECT, "2026-10-24", include);
    const { activity, counterpart } = queries(prisma);
    expect(activity.where.OR).toEqual([
      { tradeDate: { gte: day("2026-01-01"), lt: day("2027-01-01") } },
      { tradeDate: null, settlementDate: { gte: day("2026-01-01"), lt: day("2027-01-01") } },
      { tradeDate: null, settlementDate: null },
    ]);
    expect(counterpart.where.tradeDate).toEqual({ gte: day("2025-12-24"), lt: day("2027-01-04") });
  });
});

describe("loadRoomInput: the New Year check (owner ruling 2026-11-03)", () => {
  it("reads the room accounts' rows dated 27–31 December last year, and transfers from 24 December, for the check only", async () => {
    const prisma = prismaPort({
      priorDecember: [
        { snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-dec-1", type: "CONTRIBUTION", amount: "180", currency: "CAD", fxRate: null, tradeDate: day("2026-12-29") },
      ],
    });
    const input = await loadRoomInput({ prisma, memory: await service() }, SUBJECT, "2027-01-15", new Date("2027-01-15T16:00:00Z"));
    expect(input.priorDecember).toEqual([
      { accountKey: accountKey(TFSA_ID), activityKey: activityKey("synthetic-dec-1"), type: "CONTRIBUTION", amount: 180, currency: "CAD", fxRate: null, tradeDate: "2026-12-29", units: null, price: null, symbol: null, securityCurrency: null },
    ]);
    const calls = (prisma.activity.findMany as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    const dec = calls.find(isPriorDecemberQuery);
    expect(dec.where).toEqual({ appUser: { authSubject: SUBJECT }, snapTradeAccountId: { in: [TFSA_ID, CLOSED_ID, ODD_ID] }, tradeDate: { gte: day("2026-12-27"), lt: day("2027-01-01") } });
    expect(dec.select).not.toHaveProperty("description");
    expect(calls.find(isCounterpartQuery).where.tradeDate).toEqual({ gte: day("2026-12-24"), lt: day("2028-01-04") });
    // Last December's rows are never this year's.
    expect(input.activities).toEqual([]);
  });

  it("names them in the room without counting them", async () => {
    const prisma = prismaPort({
      priorDecember: [{ snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-dec-2", type: "CONTRIBUTION", amount: "250", currency: "CAD", fxRate: null, tradeDate: day("2026-12-30") }],
      sync: [{ snapTradeAccountId: TFSA_ID, backfillCompletedAt: new Date("2026-02-01T00:00:00Z"), earliestTradeDate: day("2024-03-01"), lastSyncedAt: new Date("2027-01-15T08:00:00Z"), lastError: null, dirty: false }],
      accounts: [{ snapTradeAccountId: TFSA_ID, displayName: null, institutionName: "Synthetic Broker", rawType: "TFSA", status: "OPEN", snapshots: snap("TFSA") }],
    });
    const memory = await service([{ node: { type: "tax_year", key: "2027:tfsa" }, property: "tax_year.cra_room_jan1", value: { amountCad: 7500 } }]);
    const result = computeTfsaRoom(await loadRoomInput({ prisma, memory }, SUBJECT, "2027-01-15", new Date("2027-01-15T16:00:00Z")));
    expect(result).toMatchObject({ status: "known", roomLeftCad: 7500, newYear: [{ date: "2026-12-30", amountCad: 250, countedIn: 2026, mayCountIn: 2027 }] });
  });

  it("an RRSP period read has no New Year check", async () => {
    const prisma = prismaPort();
    const base = await loadRoomBase({ prisma, memory: await service() }, SUBJECT, "2027-01-15", (c) => c.bucket === "rrsp", { from: "2026-03-02", to: "2027-01-15" });
    expect(base.priorDecember).toEqual([]);
    expect((prisma.activity.findMany as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).some(isPriorDecemberQuery)).toBe(false);
  });
});
