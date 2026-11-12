import { describe, expect, it } from "vitest";

import { accountKey, activityKey } from "../memory/keys.js";
import type { MemoryFact, Provenance } from "../memory/memory-types.js";
import {
  computeFhsaRoom, FHSA_HEADLINE_BASIS, FHSA_LAST_YEAR_BASIS, FHSA_ROOM_LABEL, FHSA_RRSP_NOTE, FHSA_RRSP_OUT_NOTE, type FhsaRoomInput, type FhsaRoomResult,
} from "./fhsa-room.js";
import { buildFhsaLedger, type LedgerMove } from "./tfsa-ledger.js";

// Synthetic ids, labels and amounts only.
const FHSA = accountKey("synthetic-fhsa-main");
const FHSA2 = accountKey("synthetic-fhsa-second");
const RRSP = accountKey("synthetic-rrsp");
const CASH = accountKey("synthetic-cash");

let seq = 0;
function fact(nodeType: MemoryFact["node"]["type"], key: string, property: string, value: unknown, provenance: Provenance = "stated"): MemoryFact {
  seq += 1;
  return {
    id: `synthetic-fact-${seq}`, subject: "subject|synthetic-fhsa", node: { type: nodeType, key }, property, value, text: "Synthetic.",
    kind: "fact", provenance, validFrom: null, validTo: null, recordedAt: new Date(Date.UTC(2026, 0, 1) + seq * 60_000), source: "claude", supersededAt: null,
  };
}
const room = (year: number, amountCad: number, provenance: Provenance = "stated") => fact("tax_year", `${year}:fhsa`, "tax_year.fhsa_room", { amountCad }, provenance);

type Activity = FhsaRoomInput["activities"][number];
let rowSeq = 0;
function act(type: string | null, amount: number | null, tradeDate: string | null, extra: Partial<Activity> = {}): Activity {
  rowSeq += 1;
  return { accountKey: FHSA, activityKey: activityKey(`synthetic-fhsa-dedupe-${rowSeq}`), type, amount, currency: "CAD", fxRate: null, tradeDate, ...extra };
}
const counterpart = (key: string, label: string, type: string, amount: number, tradeDate: string) => {
  rowSeq += 1;
  return { accountKey: key, label, activityKey: activityKey(`synthetic-fhsa-cp-${rowSeq}`), type, amount, currency: "CAD", tradeDate };
};

const NOW = "2026-10-24T16:00:00.000Z";
const fresh = { lastSyncedAt: "2026-10-24T08:00:00.000Z", lastError: false, dirty: false };

function input(over: Partial<Omit<FhsaRoomInput, "memory">> & { memory?: Partial<FhsaRoomInput["memory"]> } = {}): FhsaRoomInput {
  const { memory, ...rest } = over;
  return {
    today: "2026-10-24",
    now: NOW,
    accounts: [{ accountKey: FHSA, label: "Synthetic FHSA", bucket: "fhsa", neutral: false }],
    rrspAccountKeys: [RRSP],
    activities: [],
    coverage: new Map([[FHSA, { coversFrom: "0001-01-01" }], [FHSA2, { coversFrom: "0001-01-01" }]]),
    sync: new Map([[FHSA, fresh], [FHSA2, fresh]]),
    fx: { toCad: () => null },
    ...rest,
    memory: { participationRoom: room(2026, 8000), outside: [], classifications: new Map(), ...memory },
  };
}
function known(r: FhsaRoomResult) {
  if (r.status !== "known") throw new Error(`expected known, got ${JSON.stringify(r)}`);
  return r;
}

describe("computeFhsaRoom: a managed FHSA (A9)", () => {
  const MANAGED = accountKey("synthetic-managed-fhsa");
  const accounts = [
    { accountKey: FHSA, label: "Synthetic FHSA", bucket: "fhsa", neutral: false },
    { accountKey: MANAGED, label: "Synthetic Managed FHSA", bucket: "fhsa", neutral: false, managed: true },
  ];
  const ytd = (year: number, amountCad: number, asOf = `${year}-05-01`) =>
    ({ ...fact("account", MANAGED, "account.ytd_contributions", { year, amountCad, asOf }), recordedAt: new Date(`${asOf}T16:00:00.000Z`) });

  it("doesn't hold the number back: it names the account as not counted; with a saved figure, the figure counts as a total and the name goes", () => {
    const r = known(computeFhsaRoom(input({ accounts, activities: [act("CONTRIBUTION", 2000, "2026-04-01")] })));
    expect(r).toMatchObject({ contributedCad: 2000, roomLeftCad: 6000, participationRoomCad: 8000 });
    expect(r.notCounted).toEqual([{ accountKey: MANAGED, label: "Synthetic Managed FHSA" }]);
    expect(r.basis).toContain("Managed FHSA: Synthetic Managed FHSA; contributions to it aren't visible through SnapTrade");
    expect(r.basis).not.toContain("Connected FHSA: Synthetic Managed FHSA");
    const k = known(computeFhsaRoom(input({ accounts, activities: [act("CONTRIBUTION", 2000, "2026-04-01")], memory: { outside: [ytd(2026, 3000)] } })));
    expect(k).toMatchObject({ contributedCad: 5000, roomLeftCad: 3000, participationRoomCad: 8000 });
    expect(k.ledger.rows.find((x) => x.kind === "outside_total")).toMatchObject({ label: "Synthetic Managed FHSA", amountCad: 3000, date: "2026-05-01" });
    expect(k.basis).toContain("Synthetic Managed FHSA: $3,000 contributed this year as of 2026-05-01 (you said; contributions to it aren't visible through SnapTrade)");
    expect("notCounted" in k).toBe(false);
  });

  it("a managed-only user gets the participation room, with the note", () => {
    const r = known(computeFhsaRoom(input({ accounts: [accounts[1]!], activities: [], sync: new Map(), coverage: new Map() })));
    expect(r).toMatchObject({ contributedCad: 0, roomLeftCad: 8000, overLimitCad: 0 });
    expect(r.notCounted?.map((n) => n.accountKey)).toEqual([MANAGED]);
  });
});

describe("computeFhsaRoom", () => {
  it("no broker-labelled FHSA: status none", () => {
    expect(computeFhsaRoom(input({ accounts: [{ accountKey: CASH, label: "Cash", bucket: "money_market", neutral: false }] }))).toEqual({ status: "none" });
    expect(computeFhsaRoom(input({ accounts: [] }))).toEqual({ status: "none" });
  });

  it("room 8000, +5000, +4000: over by 1000 since the second date", () => {
    const r = known(computeFhsaRoom(input({ activities: [act("CONTRIBUTION", 5000, "2026-02-03"), act("CONTRIBUTION", 4000, "2026-06-10")] })));
    expect(r).toMatchObject({ year: 2026, participationRoomCad: 8000, contributedCad: 9000, roomLeftCad: 0, overLimitCad: 1000, headlineBasis: FHSA_HEADLINE_BASIS });
    expect(r.ledger.overSince).toBe("2026-06-10");
    expect(r.ledger.rows[0]).toMatchObject({ kind: "cra_room", label: FHSA_ROOM_LABEL, amountCad: 8000, roomLeftCad: 8000 });
    expect(r.ledger.rows.at(-1)).toMatchObject({ wentOver: true, excessCad: 1000, roomLeftCad: 0 });
    expect(r.basis).toContain("FHSA participation room for 2026: $8,000 (you said)");
  });

  it("a matched RRSP→FHSA transfer uses room and says so", () => {
    const row = act("TRANSFER_IN", 3000, "2026-04-02");
    const r = known(computeFhsaRoom(input({ activities: [row], counterparts: [counterpart(RRSP, "Synthetic RRSP", "TRANSFER_OUT", -3000, "2026-04-01")] })));
    expect(r.contributedCad).toBe(3000);
    expect(r.roomLeftCad).toBe(5000);
    expect(r.ledger.rows[1]).toMatchObject({ kind: "contribution", inferred: true, matchedWith: { label: "Synthetic RRSP", date: "2026-04-01" }, note: FHSA_RRSP_NOTE });
  });

  it("a matched transfer from a non-registered account is a contribution with no RRSP note", () => {
    const row = act("TRANSFER_IN", 2000, "2026-04-02");
    const r = known(computeFhsaRoom(input({ activities: [row], counterparts: [counterpart(CASH, "Synthetic cash", "TRANSFER_OUT", -2000, "2026-04-02")] })));
    expect(r.roomLeftCad).toBe(6000);
    expect(r.ledger.rows[1]!.note).toBeUndefined();
  });

  it("FHSA→FHSA is none on both sides", () => {
    const out = act("TRANSFER_OUT", -1500, "2026-05-01");
    const into = act("TRANSFER_IN", 1500, "2026-05-01", { accountKey: FHSA2 });
    const r = known(computeFhsaRoom(input({
      accounts: [{ accountKey: FHSA, label: "Synthetic FHSA", bucket: "fhsa", neutral: false }, { accountKey: FHSA2, label: "Second FHSA", bucket: "fhsa", neutral: false }],
      activities: [out, into], counterparts: [{ ...out, label: "Synthetic FHSA" }, { ...into, label: "Second FHSA" }],
    })));
    expect(r.contributedCad).toBe(0);
    expect(r.roomLeftCad).toBe(8000);
    expect(r.ledger.rows.slice(1).map((x) => x.kind)).toEqual(["none", "none"]);
  });

  it("FHSA out to a non-FHSA account is a withdrawal; it never raises room left", () => {
    const r = known(computeFhsaRoom(input({
      activities: [act("CONTRIBUTION", 6000, "2026-02-01"), act("TRANSFER_OUT", -2000, "2026-03-01")],
      counterparts: [counterpart(CASH, "Synthetic cash", "TRANSFER_IN", 2000, "2026-03-02")],
    })));
    expect(r).toMatchObject({ withdrawnCad: 2000, roomLeftCad: 2000, overLimitCad: 0 });
    const w = r.ledger.rows.find((x) => x.kind === "withdrawal")!;
    expect(w).toMatchObject({ inferred: true, roomLeftCad: 2000, excessCad: 0, qualifyingCad: 0 });
    // Nothing later goes over, so it lowers no excess; withdrawals never give FHSA room back (no "comes back" part).
    expect(w).not.toHaveProperty("offsetsLater");
    expect(w).not.toHaveProperty("returnsCad");
    expect(w).not.toHaveProperty("returnsOn");
    expect(r.basis).toContain("Withdrawals are counted as taxable withdrawals");
  });

  it("CRA's formula: room 8000, +5000, −2000, +4000 gives room left 0, not over; the withdrawal counts against the later excess", () => {
    const r = known(computeFhsaRoom(input({ activities: [act("CONTRIBUTION", 5000, "2026-02-01"), act("WITHDRAWAL", -2000, "2026-03-01"), act("CONTRIBUTION", 4000, "2026-04-01")] })));
    expect(r).toMatchObject({ roomLeftCad: 0, overLimitCad: 0, contributedCad: 9000, withdrawnCad: 2000 });
    expect(r.ledger.overSince).toBeNull();
    expect(r.ledger.rows.find((x) => x.kind === "withdrawal")).toMatchObject({ qualifyingCad: 0, offsetsLater: true, roomLeftCad: 3000, excessCad: 0 });
    expect(r.ledger.rows.at(-1)).toMatchObject({ roomLeftCad: 0, excessCad: 0, wentOver: false });
  });

  it("room 8000, +9000: over by 1000; then −600: over by 400, room left 0", () => {
    const over = known(computeFhsaRoom(input({ activities: [act("CONTRIBUTION", 9000, "2026-02-01")] })));
    expect(over).toMatchObject({ overLimitCad: 1000, roomLeftCad: 0 });
    const r = known(computeFhsaRoom(input({ activities: [act("CONTRIBUTION", 9000, "2026-02-01"), act("WITHDRAWAL", -600, "2026-03-01")] })));
    expect(r).toMatchObject({ overLimitCad: 400, roomLeftCad: 0, withdrawnCad: 600 });
    expect(r.ledger.overSince).toBe("2026-02-01");
    const w = r.ledger.rows.find((x) => x.kind === "withdrawal")!;
    expect(w).toMatchObject({ excessCad: 400, qualifyingCad: 600, roomLeftCad: 0 });
    expect(w).not.toHaveProperty("offsetsLater");
  });

  it("+5000, −2000, +6000: over by 1000 since the date of the +6000", () => {
    const r = known(computeFhsaRoom(input({ activities: [act("CONTRIBUTION", 5000, "2026-02-01"), act("WITHDRAWAL", -2000, "2026-03-01"), act("CONTRIBUTION", 6000, "2026-07-15")] })));
    expect(r).toMatchObject({ overLimitCad: 1000, roomLeftCad: 0 });
    expect(r.ledger.overSince).toBe("2026-07-15");
    expect(r.ledger.rows.find((x) => x.kind === "withdrawal")).toMatchObject({ qualifyingCad: 0, offsetsLater: true });
    expect(r.ledger.rows.at(-1)).toMatchObject({ wentOver: true, excessCad: 1000 });
  });

  it("a withdrawal of 2000 while over by 1000: over by 0 and room left 0, never above", () => {
    const r = known(computeFhsaRoom(input({ activities: [act("CONTRIBUTION", 9000, "2026-02-01"), act("WITHDRAWAL", -2000, "2026-03-01")] })));
    expect(r).toMatchObject({ overLimitCad: 0, roomLeftCad: 0, withdrawnCad: 2000 });
    expect(r.ledger.overSince).toBeNull();
    expect(r.ledger.rows.find((x) => x.kind === "withdrawal")).toMatchObject({ qualifyingCad: 1000, roomLeftCad: 0, excessCad: 0 });
  });

  it("every FHSA withdrawal counts as taxable (the data can't tell a qualifying one), with one basis line; none without a withdrawal", () => {
    const r = known(computeFhsaRoom(input({ activities: [act("CONTRIBUTION", 9000, "2026-02-01"), act("WITHDRAWAL", -300, "2026-03-01"), act("WITHDRAWAL", -200, "2026-04-01")] })));
    expect(r.overLimitCad).toBe(500);
    expect(r.basis.filter((b) => b === "Withdrawals are counted as taxable withdrawals")).toHaveLength(1);
    expect(known(computeFhsaRoom(input({ activities: [act("CONTRIBUTION", 100, "2026-02-01")] }))).basis).not.toContain("Withdrawals are counted as taxable withdrawals");
  });

  it("missing room gives [fhsa_room] only; a last-year, inferred or derived room doesn't count", () => {
    for (const participationRoom of [null, room(2025, 8000), room(2026, 8000, "inferred"), room(2026, 8000, "derived")]) {
      const r = computeFhsaRoom(input({ memory: { participationRoom }, activities: [act("CONTRIBUTION", 1000, "2026-02-01")] }));
      expect(r.status).toBe("missing");
      if (r.status === "missing") {
        expect(r.missing).toEqual([{ kind: "fhsa_room" }]);
        expect(r.ledger.rows[0]!.roomLeftCad).toBeNull();
      }
    }
  });

  it("stale activity (7 days) and a coverage gap withhold the number", () => {
    const r = computeFhsaRoom(input({ sync: new Map([[FHSA, { ...fresh, lastSyncedAt: "2026-10-10T08:00:00.000Z" }]]), coverage: new Map() }));
    expect(r.status === "missing" && r.missing.map((m) => m.kind)).toEqual(["coverage", "stale_activity"]);
  });

  it("an unmatched transfer in is assumed a contribution", () => {
    const r = known(computeFhsaRoom(input({ activities: [act("TRANSFER_IN", 500, "2026-07-01")] })));
    expect(r.roomLeftCad).toBe(7500);
    expect(r.ledger.rows[1]).toMatchObject({ kind: "contribution", assumed: true });
  });

  it("a USD contribution at a Bank of Canada rate is est., with its rate date and native amount", () => {
    const r = known(computeFhsaRoom(input({
      fx: { toCad: (amount) => ({ cad: amount * 1.35, estimated: true, rateDate: "2026-03-02" }) },
      activities: [act("CONTRIBUTION", 1000, "2026-03-03", { currency: "USD" })],
    })));
    expect(r).toMatchObject({ contributedCad: 1350, estimated: true, roomLeftCad: 6650 });
    expect(r.fx.contributions).toEqual({ estimated: true, rateDates: ["2026-03-02"], native: [{ amount: 1000, currency: "USD" }] });
    expect(r.ledger.rows[1]).toMatchObject({ amountCad: 1350, estimated: true, rateDate: "2026-03-02", native: { amount: 1000, currency: "USD" } });
  });

  it("the year boundary: 31 December last year is out, 1 January is in", () => {
    const r = known(computeFhsaRoom(input({ activities: [act("CONTRIBUTION", 1000, "2025-12-31"), act("CONTRIBUTION", 2000, "2026-01-01")] })));
    expect(r.contributedCad).toBe(2000);
  });

  it("no advice words in any basis line or note", () => {
    const r = known(computeFhsaRoom(input({
      activities: [act("CONTRIBUTION", 9000, "2026-02-01"), act("WITHDRAWAL", -1000, "2026-03-01"), act("TRANSFER_IN", 100, "2026-04-02")],
      counterparts: [counterpart(RRSP, "Synthetic RRSP", "TRANSFER_OUT", -100, "2026-04-02")],
    })));
    const text = [...r.basis, ...r.ledger.rows.map((x) => x.note ?? "")].join(" ").toLowerCase();
    expect(text).not.toContain("designat");
    for (const word of ["should", "consider", "you can contribute", "we recommend"]) expect(text).not.toContain(word);
  });

  it("a matched FHSA→RRSP transfer while over leaves the excess and room unchanged, with its copy", () => {
    const out = act("TRANSFER_OUT", -1500, "2026-05-02");
    const r = known(computeFhsaRoom(input({
      activities: [act("CONTRIBUTION", 9000, "2026-02-01"), out],
      counterparts: [counterpart(RRSP, "Synthetic RRSP", "TRANSFER_IN", 1500, "2026-05-02")],
    })));
    expect(r).toMatchObject({ overLimitCad: 1000, roomLeftCad: 0, withdrawnCad: 0 });
    const row = r.ledger.rows.find((x) => x.activityKey === out.activityKey)!;
    expect(row).toMatchObject({ kind: "none", inferred: true, matchedWith: { label: "Synthetic RRSP", date: "2026-05-02" }, note: FHSA_RRSP_OUT_NOTE, excessCad: 1000 });
    expect(FHSA_RRSP_OUT_NOTE).toBe("transfer to your RRSP; doesn't change your FHSA room or the amount over unless you designated it");
    expect(r.basis).not.toContain("Withdrawals are counted as taxable withdrawals");
  });

  it("the last year's excess isn't modelled: one always-on basis line whenever an FHSA exists", () => {
    expect(FHSA_LAST_YEAR_BASIS).toBe("An amount over from last year isn't included; CRA My Account shows it.");
    expect(known(computeFhsaRoom(input())).basis.filter((b) => b === FHSA_LAST_YEAR_BASIS)).toHaveLength(1);
    const missingRoom = computeFhsaRoom(input({ memory: { participationRoom: null } }));
    expect(missingRoom.status === "missing" && missingRoom.basis).toContain(FHSA_LAST_YEAR_BASIS);
  });
});

describe("buildFhsaLedger: same-day order", () => {
  const move = (kind: LedgerMove["kind"], amountCad: number, date: string): LedgerMove =>
    ({ date, kind, label: "Synthetic FHSA", amountCad, estimated: false, rateDate: null, native: null });

  it("contributions come before withdrawals within a date (the day's highest excess is never understated)", () => {
    const ledger = buildFhsaLedger(8000, 2026, [move("withdrawal", -1000, "2026-06-10"), move("contribution", 9000, "2026-06-10")], "Room");
    expect(ledger.rows.slice(1).map((r) => r.kind)).toEqual(["contribution", "withdrawal"]);
    expect(ledger.rows[1]).toMatchObject({ excessCad: 1000, wentOver: true, date: "2026-06-10" });
    expect(ledger.rows[2]).toMatchObject({ excessCad: 0, qualifyingCad: 1000 });
    // Not over at the end, so the ledger names no current over-since date; the day it went over is the went-over row's.
    expect(ledger.overSince).toBeNull();
    expect(ledger.rows.find((r) => r.wentOver)?.date).toBe("2026-06-10");
  });

  it("with the excess still standing at the day's end, overSince is that date", () => {
    const ledger = buildFhsaLedger(8000, 2026, [move("withdrawal", -400, "2026-06-10"), move("contribution", 9000, "2026-06-10")], "Room");
    expect(ledger.rows[1]).toMatchObject({ kind: "contribution", excessCad: 1000 });
    expect(ledger.rows[2]).toMatchObject({ kind: "withdrawal", excessCad: 600, qualifyingCad: 400 });
    expect(ledger.overSince).toBe("2026-06-10");
  });
});

describe("computeFhsaRoom: the New Year check (owner ruling 2026-11-03)", () => {
  const jan = (over: Parameters<typeof input>[0] = {}) => input({
    today: "2027-01-10", now: "2027-01-10T16:00:00.000Z",
    sync: new Map([[FHSA, { lastSyncedAt: "2027-01-10T08:00:00.000Z", lastError: false, dirty: false }]]),
    memory: { participationRoom: room(2027, 8000) },
    ...over,
  });

  it("names last year's late-December contribution, and not a transfer in from the user's RRSP-side move out", () => {
    const r = known(computeFhsaRoom(jan({ priorDecember: [act("CONTRIBUTION", 2000, "2026-12-30")] })));
    expect(r.roomLeftCad).toBe(8000);
    expect(r.newYear).toEqual([expect.objectContaining({ date: "2026-12-30", label: "Synthetic FHSA", amountCad: 2000, countedIn: 2026, mayCountIn: 2027 })]);
  });

  it("is absent without a contribution near New Year", () => {
    expect(computeFhsaRoom(jan({ priorDecember: [act("BUY", -100, "2026-12-30")], activities: [act("CONTRIBUTION", 50, "2027-01-05")] }))).not.toHaveProperty("newYear");
  });
});
