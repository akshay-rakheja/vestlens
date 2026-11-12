import { describe, expect, it, vi } from "vitest";

import { accountKey, activityKey, outsideAccountKey } from "../memory/keys.js";
import type { MemoryFact, Provenance } from "../memory/memory-types.js";
import { answerable, computeTfsaRoom, COVERS_FROM_START, MAX_ACTIVITY_AGE_DAYS, MAX_AMBIGUOUS_ROWS, type RoomInput, type RoomResult } from "./tfsa-room.js";

// Synthetic ids, labels and amounts only.
const MAIN = accountKey("synthetic-tfsa-main");
const SECOND = accountKey("synthetic-tfsa-second");
const ODD = accountKey("synthetic-neutral-odd");

let seq = 0;
function fact(nodeType: MemoryFact["node"]["type"], key: string, property: string, value: unknown, provenance: Provenance = "stated"): MemoryFact {
  seq += 1;
  return {
    id: `synthetic-fact-${seq}`, subject: "subject|synthetic-room", node: { type: nodeType, key }, property, value, text: "Synthetic.",
    kind: "fact", provenance, validFrom: null, validTo: null, recordedAt: new Date(Date.UTC(2026, 0, 1) + seq * 60_000), source: "claude", supersededAt: null,
  };
}
const craRoom = (year: number, amountCad: number, provenance: Provenance = "stated") =>
  fact("tax_year", `${year}:tfsa`, "tax_year.cra_room_jan1", { amountCad }, provenance);
const accountSet = (year: number, connected: string[], outside: string[] = [], provenance: Provenance = "stated", notTfsa?: string[]) =>
  fact("tax_year", `${year}:tfsa`, "tax_year.account_set", {
    connected, outside: outside.map((label) => ({ label })), confirmedAt: `${year}-02-01T15:00:00.000Z`, ...(notTfsa ? { notTfsa } : {}),
  }, provenance);
/** recordedAt defaults to midday Toronto on the asOf date. */
const connectedYtd = (key: string, year: number, amountCad: number, provenance: Provenance = "stated", asOf = `${year}-05-01`, recordedAt = `${asOf}T16:00:00.000Z`) =>
  ({ ...fact("account", key, "account.ytd_contributions", { year, amountCad, asOf }, provenance), recordedAt: new Date(recordedAt) });
const outsideYtd = (label: string, year: number, amountCad: number) =>
  fact("account", outsideAccountKey(label), "account.ytd_contributions", { year, amountCad, asOf: `${year}-05-01` });
const outsideMoves = (label: string, year: number, entries: Array<{ date: string; amountCad: number; kind: "deposit" | "withdrawal" }>, provenance: Provenance = "stated") =>
  fact("account", outsideAccountKey(label), "account.tfsa_moves", { year, entries }, provenance);

type Activity = RoomInput["activities"][number];
let rowSeq = 0;
function act(type: string | null, amount: number | null, tradeDate: string | null, extra: Partial<Activity> = {}): Activity {
  rowSeq += 1;
  return { accountKey: MAIN, activityKey: activityKey(`synthetic-dedupe-${rowSeq}`), type, amount, currency: "CAD", fxRate: null, tradeDate, ...extra };
}

const noFx: RoomInput["fx"] = { toCad: () => null };
/** Midday Toronto on the default today; activity synced in the early morning is fresh. */
const NOW = "2026-10-24T16:00:00.000Z";
const SYNCED = "2026-10-24T08:00:00.000Z";
const fresh = (over: Partial<{ lastSyncedAt: string | null; lastError: boolean; dirty: boolean }> = {}) => ({ lastSyncedAt: SYNCED, lastError: false, dirty: false, ...over });

function input(over: Partial<Omit<RoomInput, "memory">> & { memory?: Partial<RoomInput["memory"]> } = {}): RoomInput {
  const { memory, ...rest } = over;
  return {
    today: "2026-10-24",
    accounts: [{ accountKey: MAIN, label: "Synthetic TFSA", bucket: "tfsa", neutral: false }],
    activities: [],
    coverage: new Map([[MAIN, { coversFrom: "2025-06-01" }], [SECOND, { coversFrom: "2024-01-01" }], [ODD, { coversFrom: "2025-01-01" }]]),
    fx: noFx,
    now: NOW,
    sync: new Map([MAIN, SECOND, ODD].map((k) => [k, fresh()])),
    ...rest,
    connectedAccountKeys: rest.connectedAccountKeys ?? (rest.accounts ?? [{ accountKey: MAIN }]).map((a) => a.accountKey),
    memory: { craRoom: craRoom(2026, 7000), accountSet: accountSet(2026, [MAIN]), outside: [], outsideMoves: [], classifications: new Map(), ...memory },
  };
}

function known(result: RoomResult) {
  if (result.status !== "known") throw new Error(`expected known, got missing: ${JSON.stringify(result.missing)}`);
  return result;
}
function missing(result: RoomResult) {
  if (result.status !== "missing") throw new Error("expected missing, got known");
  return result.missing;
}

describe("computeTfsaRoom: the four gates", () => {
  it("all gates hold: CRA room minus this year's contributions", () => {
    const r = known(computeTfsaRoom(input({ activities: [act("CONTRIBUTION", 1500, "2026-02-03"), act("BUY", -1500, "2026-02-04"), act("DIVIDEND", 12.5, "2026-03-01")] })));
    expect(r).toMatchObject({ status: "known", year: 2026, craRoomCad: 7000, contributedCad: 1500, roomLeftCad: 5500, withdrawnCad: 0, estimated: false, overLimitCad: 0 });
  });

  it("gate 1: no CRA figure", () => {
    expect(missing(computeTfsaRoom(input({ memory: { craRoom: null } })))).toEqual([{ kind: "cra_room" }]);
  });

  it("gate 1: a CRA figure from last year does not count", () => {
    expect(missing(computeTfsaRoom(input({ memory: { craRoom: craRoom(2025, 7000) } })))).toEqual([{ kind: "cra_room" }]);
  });

  it("gate 1: an inferred CRA figure is ignored", () => {
    expect(missing(computeTfsaRoom(input({ memory: { craRoom: craRoom(2026, 7000, "inferred") } })))).toEqual([{ kind: "cra_room" }]);
  });

  it("gate 1: a derived CRA figure does not satisfy it; a derived account set is not an override", () => {
    expect(missing(computeTfsaRoom(input({ memory: { craRoom: craRoom(2026, 7000, "derived") } })))).toEqual([{ kind: "cra_room" }]);
    // A derived set's notTfsa is ignored: the broker-labelled TFSA still counts.
    const derived = known(computeTfsaRoom(input({ activities: [act("CONTRIBUTION", 1000, "2026-04-01")], memory: { accountSet: accountSet(2026, [], [], "derived", [MAIN]) } })));
    expect(derived.contributedCad).toBe(1000);
    expect(derived.basis.some((b) => b.startsWith("Your TFSAs for"))).toBe(false);
    expect(computeTfsaRoom(input({ memory: { accountSet: accountSet(2026, [MAIN], [], "imported") } })).status).toBe("known");
  });

  it("gate 1: a malformed or superseded CRA fact is ignored", () => {
    const bad = { ...craRoom(2026, 7000), value: { amountCad: -1 } };
    expect(missing(computeTfsaRoom(input({ memory: { craRoom: bad } })))).toEqual([{ kind: "cra_room" }]);
    const old = { ...craRoom(2026, 7000), supersededAt: new Date() };
    expect(missing(computeTfsaRoom(input({ memory: { craRoom: old } })))).toEqual([{ kind: "cra_room" }]);
  });

  it("broker-labelled TFSAs count automatically: two TFSAs, no confirmed set, CRA room present is known", () => {
    const accounts = [
      { accountKey: MAIN, label: "Synthetic TFSA", bucket: "tfsa", neutral: false },
      { accountKey: SECOND, label: "Synthetic new TFSA", bucket: "tfsa", neutral: false },
    ];
    const activities = [act("CONTRIBUTION", 1000, "2026-04-01"), act("CONTRIBUTION", 2000, "2026-04-02", { accountKey: SECOND })];
    const r = known(computeTfsaRoom(input({ accounts, activities, memory: { accountSet: null } })));
    expect(r).toMatchObject({ contributedCad: 3000, roomLeftCad: 4000 });
    expect(r.basis).toEqual(expect.arrayContaining(["Connected TFSA: Synthetic TFSA", "Connected TFSA: Synthetic new TFSA"]));
    expect(r.basis.some((b) => b.startsWith("Your TFSAs for"))).toBe(false);
  });

  it("no set this year (none, last year's, or an inferred one) never withholds the number", () => {
    for (const accountSetFact of [null, accountSet(2025, [MAIN]), accountSet(2026, [MAIN], [], "inferred")]) {
      expect(computeTfsaRoom(input({ memory: { accountSet: accountSetFact } })).status).toBe("known");
    }
  });

  it("a new broker-labelled TFSA beside last year's (or this year's) confirmed set counts automatically", () => {
    const accounts = [
      { accountKey: MAIN, label: "Synthetic TFSA", bucket: "tfsa", neutral: false },
      { accountKey: SECOND, label: "Synthetic new TFSA ••KgtA", bucket: "tfsa", neutral: false },
    ];
    const activities = [act("CONTRIBUTION", 500, "2026-04-02", { accountKey: SECOND })];
    for (const accountSetFact of [accountSet(2025, [MAIN]), accountSet(2026, [MAIN])]) {
      const r = known(computeTfsaRoom(input({ accounts, activities, memory: { accountSet: accountSetFact } })));
      expect(r.contributedCad).toBe(500);
      expect(r.basis).toContain("Connected TFSA: Synthetic new TFSA ••KgtA");
    }
  });

  it("a neutral account isn't counted: a basis line, never a missing item", () => {
    const accounts = [
      { accountKey: MAIN, label: "Synthetic TFSA", bucket: "tfsa", neutral: false },
      { accountKey: ODD, label: "Synthetic odd account", bucket: "other", neutral: true },
    ];
    const activities = [act("CONTRIBUTION", 1000, "2026-04-01"), act("CONTRIBUTION", 2000, "2026-04-02", { accountKey: ODD })];
    const one = known(computeTfsaRoom(input({ accounts, activities, memory: { accountSet: null } })));
    expect(one.contributedCad).toBe(1000);
    expect(one.basis).toContain("1 connected account of unknown type isn't counted; add it if it's a TFSA");
    const two = known(computeTfsaRoom(input({
      accounts: [...accounts, { accountKey: SECOND, label: "Synthetic odd two", bucket: "other", neutral: true }], memory: { accountSet: null },
    })));
    expect(two.basis).toContain("2 connected accounts of unknown type aren't counted; add them if they're TFSAs");
    expect(computeTfsaRoom(input({ accounts, memory: { accountSet: null, craRoom: null } }))).toMatchObject({ missing: [{ kind: "cra_room" }] });
  });

  it("a neutral account the user said is not a TFSA is excluded, and isn't in the unknown-type count", () => {
    const accounts = [
      { accountKey: MAIN, label: "Synthetic TFSA", bucket: "tfsa", neutral: false },
      { accountKey: ODD, label: "Synthetic odd account", bucket: "other", neutral: true },
    ];
    const activities = [act("CONTRIBUTION", 1000, "2026-04-01"), act("CONTRIBUTION", 2000, "2026-04-02", { accountKey: ODD }), act("TRANSFER", 5, "2026-04-03", { accountKey: ODD })];
    const r = known(computeTfsaRoom(input({ accounts, activities, memory: { accountSet: accountSet(2026, [MAIN], [], "stated", [ODD]) } })));
    expect(r.contributedCad).toBe(1000);
    expect(r.basis).toContain("Not a TFSA: Synthetic odd account (you said)");
    expect(r.basis.some((b) => b.startsWith("Connected TFSA: Synthetic odd account"))).toBe(false);
    expect(r.basis.some((b) => b.includes("of unknown type"))).toBe(false);
  });

  it("a key in both connected and notTfsa counts as a TFSA (the safer reading)", () => {
    const accounts = [
      { accountKey: MAIN, label: "Synthetic TFSA", bucket: "tfsa", neutral: false },
      { accountKey: ODD, label: "Synthetic odd account", bucket: "other", neutral: true },
    ];
    const activities = [act("CONTRIBUTION", 2000, "2026-04-02", { accountKey: ODD })];
    const r = known(computeTfsaRoom(input({ accounts, activities, memory: { accountSet: accountSet(2026, [MAIN, ODD], [], "stated", [ODD]) } })));
    expect(r.contributedCad).toBe(2000);
  });

  it("notTfsa in this year's set excludes a broker-labelled TFSA (its activity and its gates)", () => {
    const accounts = [
      { accountKey: MAIN, label: "Synthetic TFSA", bucket: "tfsa", neutral: false },
      { accountKey: SECOND, label: "Synthetic new TFSA", bucket: "tfsa", neutral: false },
    ];
    const activities = [act("CONTRIBUTION", 1000, "2026-04-01"), act("CONTRIBUTION", 3000, "2026-04-02", { accountKey: SECOND }), act("TRANSFER", 5, "2026-04-03", { accountKey: SECOND })];
    // Its stale sync and missing coverage no longer withhold the number either.
    const sync = new Map([[MAIN, fresh()], [SECOND, fresh({ lastError: true })]]);
    const coverage = new Map([[MAIN, { coversFrom: "2025-06-01" }]]);
    const r = known(computeTfsaRoom(input({ accounts, activities, sync, coverage, memory: { accountSet: accountSet(2026, [], [], "stated", [SECOND]) } })));
    expect(r.contributedCad).toBe(1000);
    expect(r.basis).toContain("Not a TFSA: Synthetic new TFSA (you said)");
    expect(r.basis).not.toContain("Connected TFSA: Synthetic new TFSA");
  });

  it("outside TFSAs count only from a confirmed set", () => {
    const outside = [outsideYtd("Synthetic Bank", 2026, 1500)];
    expect(known(computeTfsaRoom(input({ memory: { accountSet: null, outside } }))).contributedCad).toBe(0);
    expect(known(computeTfsaRoom(input({ memory: { accountSet: accountSet(2025, [], ["Synthetic Bank"]), outside } }))).contributedCad).toBe(0);
    const r = known(computeTfsaRoom(input({ memory: { accountSet: accountSet(2026, [], ["Synthetic Bank"]), outside } })));
    expect(r.contributedCad).toBe(1500);
    expect(r.basis).toContain("Synthetic Bank: $1,500 contributed this year (you said)");
  });

  it("a set whose outside labels share a key is not applied (no question): only the broker-labelled TFSAs count", () => {
    const outside = [outsideYtd("RBC TFSA", 2026, 1000)];
    const r = known(computeTfsaRoom(input({ memory: { accountSet: accountSet(2026, [MAIN], ["RBC TFSA", "rbc-tfsa"]), outside } })));
    expect(r.contributedCad).toBe(0);
  });

  it("with only the CRA room missing, missing is exactly [cra_room]", () => {
    const accounts = [
      { accountKey: MAIN, label: "Synthetic TFSA", bucket: "tfsa", neutral: false },
      { accountKey: SECOND, label: "Synthetic new TFSA", bucket: "tfsa", neutral: false },
      { accountKey: ODD, label: "Synthetic odd account", bucket: "other", neutral: true },
    ];
    expect(missing(computeTfsaRoom(input({ accounts, memory: { craRoom: null, accountSet: accountSet(2025, [MAIN]) } })))).toEqual([{ kind: "cra_room" }]);
    expect(missing(computeTfsaRoom(input({ accounts, memory: { craRoom: null, accountSet: null } })))).toEqual([{ kind: "cra_room" }]);
  });

  it("a confirmed key that is still connected but not a TFSA or neutral account is simply not counted", () => {
    expect(computeTfsaRoom(input({ connectedAccountKeys: [MAIN, SECOND], memory: { accountSet: accountSet(2026, [MAIN, SECOND]) } })).status).toBe("known");
  });

  it("a confirmed key that is no longer connected still needs its figure (disconnected_account)", () => {
    expect(missing(computeTfsaRoom(input({ connectedAccountKeys: [MAIN], memory: { accountSet: accountSet(2026, [MAIN, SECOND]) } }))))
      .toEqual([{ kind: "disconnected_account", accountKey: SECOND }]);
  });

  it("a neutral account the user confirmed as a TFSA counts: its activity and its coverage", () => {
    const accounts = [
      { accountKey: MAIN, label: "Synthetic TFSA", bucket: "tfsa", neutral: false },
      { accountKey: ODD, label: "Synthetic odd account", bucket: "other", neutral: true },
    ];
    const activities = [act("CONTRIBUTION", 1000, "2026-04-01"), act("CONTRIBUTION", 2000, "2026-04-02", { accountKey: ODD })];
    const r = known(computeTfsaRoom(input({ accounts, activities, memory: { accountSet: accountSet(2026, [MAIN, ODD]) } })));
    expect(r.contributedCad).toBe(3000);
    expect(r.roomLeftCad).toBe(4000);
    expect(r.basis).toContain("Connected TFSA: Synthetic odd account (you said it is a TFSA)");
    expect(r.basis.some((b) => b.includes("of unknown type"))).toBe(false);

    const coverage = new Map([[MAIN, { coversFrom: "2025-01-01" }], [ODD, { coversFrom: "2026-03-01" }]]);
    expect(missing(computeTfsaRoom(input({ accounts, activities, coverage, memory: { accountSet: accountSet(2026, [MAIN, ODD]) } }))))
      .toEqual([{ kind: "coverage", label: "Synthetic odd account", accountKey: ODD }]);
  });

  it("activity in accounts that are not TFSAs never counts", () => {
    const accounts = [
      { accountKey: MAIN, label: "Synthetic TFSA", bucket: "tfsa", neutral: false },
      { accountKey: SECOND, label: "Synthetic RRSP", bucket: "rrsp", neutral: false },
    ];
    const r = known(computeTfsaRoom(input({ accounts, activities: [act("CONTRIBUTION", 3000, "2026-04-01", { accountKey: SECOND }), act("TRANSFER", 9, "2026-04-01", { accountKey: SECOND })] })));
    expect(r.contributedCad).toBe(0);
  });

  it("gate 3: an unresolved unclear row (an unknown type; transfers are assumed) withholds the number", () => {
    const rows = [act("SOMETHING_NEW", 5000, "2026-03-03")];
    const m = missing(computeTfsaRoom(input({ activities: rows })));
    expect(m).toEqual([{ kind: "ambiguous", count: 1, rows: [{ activityKey: rows[0]!.activityKey, date: "2026-03-03", amountCad: 5000, estimated: false, rateDate: null, native: { amount: 5000, currency: "CAD" }, type: "SOMETHING_NEW", label: "Synthetic TFSA" }] }]);
  });

  it("gate 4: coverage starting after 1 January, or unknown", () => {
    expect(missing(computeTfsaRoom(input({ coverage: new Map([[MAIN, { coversFrom: "2026-01-02" }]]) })))).toEqual([{ kind: "coverage", label: "Synthetic TFSA", accountKey: MAIN }]);
    expect(missing(computeTfsaRoom(input({ coverage: new Map([[MAIN, { coversFrom: null }]]) })))).toEqual([{ kind: "coverage", label: "Synthetic TFSA", accountKey: MAIN }]);
    expect(missing(computeTfsaRoom(input({ coverage: new Map() })))).toEqual([{ kind: "coverage", label: "Synthetic TFSA", accountKey: MAIN }]);
    expect(computeTfsaRoom(input({ coverage: new Map([[MAIN, { coversFrom: "2026-01-01" }]]) })).status).toBe("known");
  });

  it("every failing gate is listed together, in gate order", () => {
    const accounts = [
      { accountKey: MAIN, label: "Synthetic TFSA", bucket: "tfsa", neutral: false },
      { accountKey: ODD, label: "Synthetic odd account", bucket: "other", neutral: true },
    ];
    const m = missing(computeTfsaRoom(input({
      accounts, activities: [act("SOMETHING_NEW", 10, "2026-05-01")], coverage: new Map(), memory: { craRoom: null, accountSet: null },
    })));
    expect(m.map((i) => i.kind)).toEqual(["cra_room", "coverage", "ambiguous"]);
  });
});

describe("computeTfsaRoom: overrides carry forward from the latest earlier set", () => {
  const two = [
    { accountKey: MAIN, label: "Synthetic TFSA", bucket: "tfsa", neutral: false },
    { accountKey: SECOND, label: "Synthetic new TFSA", bucket: "tfsa", neutral: false },
    { accountKey: ODD, label: "Synthetic odd account", bucket: "other", neutral: true },
  ];
  const rows = () => [act("CONTRIBUTION", 1000, "2026-04-01"), act("CONTRIBUTION", 3000, "2026-04-02", { accountKey: SECOND }), act("CONTRIBUTION", 500, "2026-04-03", { accountKey: ODD })];

  it("last year's notTfsa still excludes a broker TFSA and its neutral add still counts, with only the room given in chat", () => {
    const r = known(computeTfsaRoom(input({
      accounts: two, activities: rows(), memory: { accountSet: null }, previousAccountSet: accountSet(2025, [ODD], [], "stated", [SECOND]),
    })));
    expect(r.contributedCad).toBe(1500);
    expect(r.basis).toContain("Not a TFSA: Synthetic new TFSA (you said)");
    expect(r.basis).toContain("Connected TFSA: Synthetic odd account (you said it is a TFSA)");
    expect(r.basis).toContain("Your TFSAs as confirmed for 2025 on 2025-02-01 (you said), carried forward");
  });

  it("this year's set, when present, wins over last year's", () => {
    const r = known(computeTfsaRoom(input({
      accounts: two, activities: rows(), memory: { accountSet: accountSet(2026, [], []) }, previousAccountSet: accountSet(2025, [ODD], [], "stated", [SECOND]),
    })));
    expect(r.contributedCad).toBe(4000);
    expect(r.basis.some((b) => b.includes("carried forward"))).toBe(false);
  });

  it("an earlier set that is not stated or imported, or not from an earlier year, is not carried", () => {
    for (const previousAccountSet of [accountSet(2025, [], [], "inferred", [SECOND]), accountSet(2026, [], [], "stated", [SECOND]), accountSet(2027, [], [], "stated", [SECOND])]) {
      expect(known(computeTfsaRoom(input({ accounts: two, activities: rows(), memory: { accountSet: null }, previousAccountSet }))).contributedCad).toBe(4000);
    }
  });

  it("a carried key that is no longer connected is not asked about: a basis line says it isn't counted", () => {
    const one = known(computeTfsaRoom(input({ memory: { accountSet: null }, previousAccountSet: accountSet(2025, [MAIN, SECOND]) })));
    expect(one.basis).toContain("1 account in your 2025 TFSAs is no longer connected and isn't counted");
    const two = known(computeTfsaRoom(input({ memory: { accountSet: null }, previousAccountSet: accountSet(2025, [SECOND, ODD]) })));
    expect(two.basis).toContain("2 accounts in your 2025 TFSAs are no longer connected and aren't counted");
    expect(known(computeTfsaRoom(input({ memory: { accountSet: null }, previousAccountSet: accountSet(2025, [MAIN]) }))).basis.some((b) => b.includes("no longer connected"))).toBe(false);
  });

  it("every known number says what it is based on: connected TFSAs by default", () => {
    expect(known(computeTfsaRoom(input({ memory: { accountSet: null } }))).headlineBasis).toBe("Based on your connected TFSAs");
  });

  it("a broker TFSA that disconnects after an edit-screen save (no broker keys in connected) raises no question", () => {
    // What step 2 now writes: only neutral adds in connected, only unticked broker TFSAs in notTfsa.
    const r = computeTfsaRoom(input({ connectedAccountKeys: [MAIN], memory: { accountSet: accountSet(2026, [], [], "stated", []) } }));
    expect(r.status).toBe("known");
  });

  it("a carried outside TFSA with no figure this year never blocks: a basis line and the headline basis", () => {
    const r = known(computeTfsaRoom(input({ memory: { accountSet: null }, previousAccountSet: accountSet(2024, [], ["Synthetic Bank"]) })));
    expect(r.basis).toContain("Synthetic Bank is listed as a TFSA at another institution from 2024; add this year's deposits there if any");
    expect(r.headlineBasis).toBe("Based on your connected TFSAs and what you entered");
  });

  it("a carried outside TFSA with this year's figure counts it as usual", () => {
    const r = known(computeTfsaRoom(input({
      memory: { accountSet: null, outside: [outsideYtd("Synthetic Bank", 2026, 1500)] }, previousAccountSet: accountSet(2025, [], ["Synthetic Bank"]),
    })));
    expect(r.contributedCad).toBe(1500);
    expect(r.headlineBasis).toBe("Based on your connected TFSAs");
    const dated = known(computeTfsaRoom(input({
      memory: { accountSet: null, outsideMoves: [outsideMoves("Synthetic Bank", 2026, [{ date: "2026-03-01", amountCad: 200, kind: "deposit" }])] },
      previousAccountSet: accountSet(2025, [], ["Synthetic Bank"]),
    })));
    expect(dated.contributedCad).toBe(200);
    // Last year's figure is not this year's.
    expect(known(computeTfsaRoom(input({
      memory: { accountSet: null, outside: [outsideYtd("Synthetic Bank", 2025, 900)] }, previousAccountSet: accountSet(2025, [], ["Synthetic Bank"]),
    }))).headlineBasis).toBe("Based on your connected TFSAs and what you entered");
  });

  it("an outside TFSA first declared in this year's set with no figure stays missing; one re-listed from an earlier set doesn't", () => {
    expect(missing(computeTfsaRoom(input({ memory: { accountSet: accountSet(2026, [], ["Synthetic Bank"]) } }))))
      .toEqual([{ kind: "outside_contributions", label: "Synthetic Bank", accountKey: outsideAccountKey("Synthetic Bank") }]);
    const relisted = known(computeTfsaRoom(input({
      memory: { accountSet: accountSet(2026, [], ["Synthetic Bank"]) }, previousAccountSet: accountSet(2025, [], ["Synthetic Bank"]),
    })));
    expect(relisted.basis).toContain("Synthetic Bank is listed as a TFSA at another institution from 2025; add this year's deposits there if any");
    expect(relisted.headlineBasis).toBe("Based on your connected TFSAs and what you entered");
    expect(known(computeTfsaRoom(input())).headlineBasis).toBe("Based on your connected TFSAs");
  });
});

describe("computeTfsaRoom: unmatched transfers are assumed (owner ruling 2026-10-26)", () => {
  it("an unmatched transfer in counts as a contribution: known, an assumed ledger row and the basis line", () => {
    const t = act("INTERNAL_CASH_TRANSFER_IN", 5000, "2026-03-03");
    const r = known(computeTfsaRoom(input({ activities: [t] })));
    expect(r).toMatchObject({ contributedCad: 5000, roomLeftCad: 2000 });
    expect(r.ledger.rows[1]).toMatchObject({ kind: "contribution", activityKey: t.activityKey, assumed: true, amountCad: 5000 });
    expect(r.basis).toContain("1 transfer couldn't be matched to your other accounts; it's assumed to be a contribution until you change it");
  });

  it("an unmatched transfer out gives no room back: kind none, no returnsOn, nothing withdrawn", () => {
    const t = act("TRANSFER_OUT", -800, "2026-04-03");
    const r = known(computeTfsaRoom(input({ activities: [t] })));
    expect(r.withdrawnCad).toBe(0);
    expect(r.ledger.rows[1]).toMatchObject({ kind: "none", assumed: true, amountCad: -800 });
    expect(r.ledger.rows[1]!.returnsOn).toBeUndefined();
    expect(r.basis).toContain("1 transfer couldn't be matched to your other accounts; it's assumed to give no room back until you change it");
  });

  it("several: the plural basis line", () => {
    const r = known(computeTfsaRoom(input({ activities: [act("TRANSFER_IN", 100, "2026-03-03"), act("TRANSFER_OUT", -50, "2026-03-04")] })));
    expect(r.basis).toContain("2 transfers couldn't be matched to your other accounts; they're assumed to be contributions (in) and to give no room back (out) until you change them");
  });

  it("a stored answer wins over the assumption; without it (cleared) the assumption returns", () => {
    const t = act("INTERNAL_CASH_TRANSFER_IN", 5000, "2026-03-03");
    const answered = known(computeTfsaRoom(input({ activities: [t], memory: { classifications: new Map([[t.activityKey, "none" as const]]) } })));
    expect(answered.contributedCad).toBe(0);
    expect(answered.ledger.rows[1]).toMatchObject({ kind: "none", answered: true });
    expect(answered.ledger.rows[1]!.assumed).toBeUndefined();
    expect(answered.basis.some((b) => b.includes("couldn't be matched"))).toBe(false);
    expect(known(computeTfsaRoom(input({ activities: [t] }))).ledger.rows[1]).toMatchObject({ kind: "contribution", assumed: true });
  });

  it("a matched transfer is not assumed", () => {
    const t = act("INTERNAL_CASH_TRANSFER_IN", 5000, "2026-03-03");
    const counterparts = [{ accountKey: SECOND, label: "Synthetic Cash", activityKey: activityKey("synthetic-cp"), type: "INTERNAL_CASH_TRANSFER_OUT", amount: -5000, currency: "CAD", tradeDate: "2026-03-03" }];
    const r = known(computeTfsaRoom(input({ activities: [t], counterparts })));
    expect(r.ledger.rows[1]).toMatchObject({ kind: "contribution", inferred: true });
    expect(r.ledger.rows[1]!.assumed).toBeUndefined();
  });

  it("still blocking: a transfer with no CAD value, and an unknown type", () => {
    const usd = act("TRANSFER_IN", 1000, "2026-03-03", { currency: "USD" });
    expect(missing(computeTfsaRoom(input({ activities: [usd] })))).toMatchObject([{ kind: "ambiguous", count: 1 }]);
    expect(missing(computeTfsaRoom(input({ activities: [act("SOMETHING_NEW", 10, "2026-03-03")] })))).toMatchObject([{ kind: "ambiguous", count: 1 }]);
    expect(missing(computeTfsaRoom(input({ activities: [act("TRANSFER_IN", 10, null)] })))).toMatchObject([{ kind: "ambiguous", count: 1 }]);
  });
});

describe("computeTfsaRoom: classification", () => {
  it("a user classification decides an unclear row; on a row the table already classifies it is ignored", () => {
    const transfer = act("INTERNAL_CASH_TRANSFER_IN", 5000, "2026-03-03");
    const contribution = act("CONTRIBUTION", 1000, "2026-03-04");
    const classifications = new Map<string, "contribution" | "none">([[transfer.activityKey, "contribution"], [contribution.activityKey, "none"]]);
    const r = known(computeTfsaRoom(input({ activities: [transfer, contribution], memory: { classifications } })));
    // The CONTRIBUTION still counts: a chat "none" on it is ignored (round-3 ruling).
    expect(r.contributedCad).toBe(6000);
    expect(r.roomLeftCad).toBe(1000);
    expect(r.basis).toContain("You said the transfer in of $5,000 on 2026-03-03 (Synthetic TFSA) was a contribution");
    expect(r.basis.some((b) => b.includes("CONTRIBUTION of $1,000"))).toBe(false);
    expect(r.ledger.rows.slice(1).map((x) => [x.kind, x.answered ?? false])).toEqual([["contribution", true], ["contribution", false]]);
  });

  it("an unknown type and a missing amount are both ambiguous", () => {
    const rows = [act("SOMETHING_NEW", 10, "2026-03-03"), act("CONTRIBUTION", null, "2026-02-01")];
    const m = missing(computeTfsaRoom(input({ activities: rows })));
    expect(m).toEqual([{ kind: "ambiguous", count: 2, rows: [
      { activityKey: rows[1]!.activityKey, date: "2026-02-01", amountCad: null, estimated: false, rateDate: null, native: null, type: "CONTRIBUTION", label: "Synthetic TFSA" },
      { activityKey: rows[0]!.activityKey, date: "2026-03-03", amountCad: 10, estimated: false, rateDate: null, native: { amount: 10, currency: "CAD" }, type: "SOMETHING_NEW", label: "Synthetic TFSA" },
    ] }]);
  });

  it("lists at most five ambiguous rows, oldest first, with the full count and no description text", () => {
    const rows = Array.from({ length: 7 }, (_, i) => act("SOMETHING_NEW", 100 + i, `2026-0${7 - i}-15`));
    const [item] = missing(computeTfsaRoom(input({ activities: rows })));
    if (item?.kind !== "ambiguous") throw new Error("expected ambiguous");
    expect(item.count).toBe(7);
    expect(item.rows.map((r) => r.date)).toEqual(["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15", "2026-05-15"]);
    for (const r of item.rows) expect(Object.keys(r).sort()).toEqual(["activityKey", "amountCad", "date", "estimated", "label", "native", "rateDate", "type"]);
  });

  it("a row with no type or no date in a TFSA is ambiguous, with neutral placeholders", () => {
    const rows = [act(null, 10, "2026-03-03"), act("CONTRIBUTION", 10, null)];
    const [item] = missing(computeTfsaRoom(input({ activities: rows })));
    if (item?.kind !== "ambiguous") throw new Error("expected ambiguous");
    expect(item.rows.map((r) => [r.date, r.type])).toEqual([["2026-03-03", "UNKNOWN"], ["unknown", "CONTRIBUTION"]]);
  });

  it("a row whose sign contradicts its type is ambiguous, never double counted", () => {
    const rows = [act("CONTRIBUTION", 5000, "2026-03-03"), act("CONTRIBUTION", -5000, "2026-03-04")];
    const m = missing(computeTfsaRoom(input({ activities: rows })));
    expect(m).toEqual([{ kind: "ambiguous", count: 1, rows: [{ activityKey: rows[1]!.activityKey, date: "2026-03-04", amountCad: -5000, estimated: false, rateDate: null, native: { amount: -5000, currency: "CAD" }, type: "CONTRIBUTION", label: "Synthetic TFSA" }] }]);
    expect(missing(computeTfsaRoom(input({ activities: [act("WITHDRAWAL", 2000, "2026-03-03")] })))[0]).toMatchObject({ kind: "ambiguous", count: 1 });
  });

  it("ignores duplicate activity keys", () => {
    const row = act("CONTRIBUTION", 1000, "2026-03-03");
    expect(known(computeTfsaRoom(input({ activities: [row, { ...row }] }))).contributedCad).toBe(1000);
  });
});

describe("computeTfsaRoom: the withdrawal rule", () => {
  it("the owner's trap: a withdrawal never adds room back this year", () => {
    const r = known(computeTfsaRoom(input({
      activities: [act("WITHDRAWAL", -5000, "2026-03-10"), act("CONTRIBUTION", 5000, "2026-06-02"), act("CONTRIBUTION", 7000, "2026-01-15")],
    })));
    expect(r).toMatchObject({ status: "known", roomLeftCad: -5000, overLimitCad: 5000, withdrawnCad: 5000, contributedCad: 12000, craRoomCad: 7000 });
  });

  it("reports withdrawals even while the number is withheld", () => {
    const r = computeTfsaRoom(input({ memory: { craRoom: null }, activities: [act("WITHDRAWAL", -1234.5, "2026-03-10")] }));
    expect(r).toMatchObject({ status: "missing", withdrawnCad: 1234.5 });
  });
});

describe("computeTfsaRoom: the Toronto calendar (Review Focus 1)", () => {
  it("a row dated 2026-12-31 counts toward 2026", () => {
    const r = known(computeTfsaRoom(input({ today: "2026-12-31", activities: [act("CONTRIBUTION", 1000, "2026-12-31")] })));
    expect(r.year).toBe(2026);
    expect(r.contributedCad).toBe(1000);
  });

  it("the today year drives which contributions count", () => {
    const rows = [act("CONTRIBUTION", 1000, "2026-12-31"), act("CONTRIBUTION", 300, "2027-01-01"), act("TRANSFER", 1, "2026-06-01")];
    const r = known(computeTfsaRoom(input({
      today: "2027-01-01", activities: rows,
      coverage: new Map([[MAIN, { coversFrom: "2026-01-01" }]]),
      memory: { craRoom: craRoom(2027, 14000), accountSet: accountSet(2027, [MAIN]) },
    })));
    expect(r).toMatchObject({ year: 2027, contributedCad: 300, roomLeftCad: 13700 });
    // Last year's CRA room no longer satisfies gate 1 on 1 January; last year's set is no question.
    expect(missing(computeTfsaRoom(input({ today: "2027-01-01", activities: rows })))).toEqual([{ kind: "cra_room" }]);
  });

  it("rejects a today that is not a YYYY-MM-DD date", () => {
    expect(() => computeTfsaRoom(input({ today: "2026-12-31T23:30:00-05:00" }))).toThrow();
    expect(() => computeTfsaRoom(input({ today: "2026-02-30" }))).toThrow();
  });

  it("a trade date that is not a plain YYYY-MM-DD date is ambiguous, never converted", () => {
    const rows = [act("CONTRIBUTION", 1000, "2027-01-01T04:30:00.000Z")];
    expect(missing(computeTfsaRoom(input({ today: "2026-12-31", activities: rows })))[0]).toMatchObject({ kind: "ambiguous", count: 1 });
  });
});

describe("computeTfsaRoom: currency (Review Focus 2)", () => {
  it("a USD contribution with a broker fxRate uses it, not estimated", () => {
    const toCad = vi.fn(() => ({ cad: 1390, estimated: true }));
    const r = known(computeTfsaRoom(input({ fx: { toCad }, activities: [act("CONTRIBUTION", 1000, "2026-03-03", { currency: "USD", fxRate: 1.38 })] })));
    expect(r.contributedCad).toBe(1380);
    expect(r.estimated).toBe(false);
  });

  it("a USD contribution without fxRate uses the Bank of Canada port for its trade date and is estimated", () => {
    const toCad = vi.fn((amount: number, _currency: string, _date: string) => ({ cad: amount * 1.4, estimated: true }));
    const r = known(computeTfsaRoom(input({ fx: { toCad }, activities: [act("CONTRIBUTION", 1000, "2026-12-25", { currency: "usd" })] })));
    expect(toCad).toHaveBeenCalledWith(1000, "USD", "2026-12-25");
    expect(r.contributedCad).toBe(1400);
    expect(r.estimated).toBe(true);
  });

  it("a fallback conversion is estimated even if the port says otherwise", () => {
    const r = known(computeTfsaRoom(input({ fx: { toCad: () => ({ cad: 1400, estimated: false }) }, activities: [act("CONTRIBUTION", 1000, "2026-03-03", { currency: "USD" })] })));
    expect(r.estimated).toBe(true);
  });

  it("with no rate at all the row is ambiguous", () => {
    const rows = [act("CONTRIBUTION", 1000, "2026-03-03", { currency: "USD" })];
    const [item] = missing(computeTfsaRoom(input({ activities: rows })));
    expect(item).toEqual({ kind: "ambiguous", count: 1, rows: [{ activityKey: rows[0]!.activityKey, date: "2026-03-03", amountCad: null, estimated: false, rateDate: null, native: { amount: 1000, currency: "USD" }, type: "CONTRIBUTION", label: "Synthetic TFSA" }] });
  });

  it("a missing currency is ambiguous rather than assumed CAD", () => {
    expect(missing(computeTfsaRoom(input({ activities: [act("CONTRIBUTION", 1000, "2026-03-03", { currency: null })] })))[0]).toMatchObject({ kind: "ambiguous" });
  });

  it("a broker fxRate more than 2% from the Bank of Canada value is est. at the Bank of Canada rate with its date (A10)", () => {
    const toCad = () => ({ cad: 1360, estimated: true, rateDate: "2026-03-03" });
    // 1.25 is 8% off: the Bank of Canada value, marked est. with the rate date and the native amount.
    const far = known(computeTfsaRoom(input({ fx: { toCad }, activities: [act("CONTRIBUTION", 1000, "2026-03-03", { currency: "USD", fxRate: 1.25 })] })));
    expect(far.ledger.rows[1]).toMatchObject({ amountCad: 1360, estimated: true, rateDate: "2026-03-03", native: { amount: 1000, currency: "USD" } });
    expect(far.estimated).toBe(true);
    // 1.35 is within 2% (a settlement spread): the broker's own rate, exact.
    const near = known(computeTfsaRoom(input({ fx: { toCad }, activities: [act("CONTRIBUTION", 1000, "2026-03-03", { currency: "USD", fxRate: 1.35 })] })));
    expect(near.ledger.rows[1]).toMatchObject({ amountCad: 1350, estimated: false, rateDate: null });
  });

  it("a broker fxRate of exactly 1 on a foreign row, or one far from the Bank of Canada rate, falls back to the estimate", () => {
    const toCad = () => ({ cad: 1400, estimated: true });
    for (const fxRate of [1, 0.72]) {
      const r = known(computeTfsaRoom(input({ fx: { toCad }, activities: [act("CONTRIBUTION", 1000, "2026-03-03", { currency: "USD", fxRate })] })));
      expect(r.contributedCad).toBe(1400);
      expect(r.estimated).toBe(true);
    }
    // ...and with no Bank of Canada rate, a foreign row is ambiguous whatever its broker rate.
    for (const [currency, fxRate] of [["USD", 1], ["USD", 0.73], ["USD", 1.37], ["EUR", 1.5]] as const) {
      expect(missing(computeTfsaRoom(input({ activities: [act("CONTRIBUTION", 1000, "2026-03-03", { currency, fxRate })] })))[0], `${currency} ${fxRate}`)
        .toMatchObject({ kind: "ambiguous" });
    }
  });

  it("a zero Bank of Canada value for a non-zero foreign amount is no rate: the row is ambiguous", () => {
    const rows = [act("CONTRIBUTION", 5000, "2026-03-03", { currency: "USD", fxRate: 1.37 })];
    const r = computeTfsaRoom(input({ fx: { toCad: () => ({ cad: 0, estimated: true }) }, activities: rows }));
    expect(r.status).toBe("missing");
    expect(missing(r)).toEqual([{ kind: "ambiguous", count: 1, rows: [expect.objectContaining({ activityKey: rows[0]!.activityKey, amountCad: null })] }]);
    // A zero foreign amount converts to zero.
    expect(known(computeTfsaRoom(input({ fx: { toCad: () => ({ cad: 0, estimated: true }) }, activities: [act("CONTRIBUTION", 0, "2026-03-03", { currency: "USD" })] }))).contributedCad).toBe(0);
  });

  it("CAD rows ignore fxRate and the port", () => {
    const toCad = vi.fn(() => null);
    const r = known(computeTfsaRoom(input({ fx: { toCad }, activities: [act("CONTRIBUTION", 1000, "2026-03-03", { fxRate: 1.38 })] })));
    expect(r.contributedCad).toBe(1000);
    expect(toCad).not.toHaveBeenCalled();
  });
});

describe("computeTfsaRoom: outside accounts", () => {
  it("subtracts this year's declared outside contributions and ignores last year's", () => {
    const outside = [outsideYtd("Other bank", 2026, 1200), outsideYtd("RBC — TFSA!", 2025, 6000), outsideYtd("RBC — TFSA!", 2026, 300)];
    const r = known(computeTfsaRoom(input({
      activities: [act("CONTRIBUTION", 1000, "2026-03-03")],
      memory: { accountSet: accountSet(2026, [MAIN], ["Other bank", "RBC — TFSA!"]), outside },
    })));
    expect(r).toMatchObject({ contributedCad: 2500, roomLeftCad: 4500 });
    expect(r.basis).toContain("Other bank: $1,200 contributed this year (you said)");
  });

  it("an outside account without this year's figure withholds the number", () => {
    const outside = [outsideYtd("Other bank", 2025, 6000)];
    expect(missing(computeTfsaRoom(input({ memory: { accountSet: accountSet(2026, [MAIN], ["Other bank"]), outside } }))))
      .toEqual([{ kind: "outside_contributions", label: "Other bank", accountKey: outsideAccountKey("Other bank") }]);
  });

  it("ignores an inferred outside figure, and figures for accounts not in the set", () => {
    const inferred = { ...outsideYtd("Other bank", 2026, 1200), provenance: "inferred" as const };
    expect(missing(computeTfsaRoom(input({ memory: { accountSet: accountSet(2026, [MAIN], ["Other bank"]), outside: [inferred] } }))))
      .toEqual([{ kind: "outside_contributions", label: "Other bank", accountKey: outsideAccountKey("Other bank") }]);
    expect(known(computeTfsaRoom(input({ memory: { outside: [outsideYtd("Not declared", 2026, 999)] } }))).contributedCad).toBe(0);
  });
});

describe("computeTfsaRoom: coverage gaps on connected TFSAs (spec §9a.5)", () => {
  const late = new Map([[MAIN, { coversFrom: "2026-04-01" }]]);
  const rows = () => [act("CONTRIBUTION", 1000, "2026-04-15"), act("TRANSFER_IN", 50, "2026-04-30"), act("WITHDRAWAL", -300, "2026-06-01")];

  it("a stated year-to-date figure on that account replaces its computed sum", () => {
    const r = known(computeTfsaRoom(input({ coverage: late, activities: rows(), memory: { outside: [connectedYtd(MAIN, 2026, 4200)] } })));
    expect(r).toMatchObject({ contributedCad: 4200, roomLeftCad: 2800, withdrawnCad: 300 });
    expect(r.basis).toContain("Synthetic TFSA: $4,200 contributed this year (you said; stored activity starts 2026-04-01)");
  });

  it("an imported figure works too; inferred, derived or last year's do not", () => {
    expect(known(computeTfsaRoom(input({ coverage: late, memory: { outside: [connectedYtd(MAIN, 2026, 10, "imported")] } }))).contributedCad).toBe(10);
    for (const f of [connectedYtd(MAIN, 2026, 10, "inferred"), connectedYtd(MAIN, 2026, 10, "derived"), connectedYtd(MAIN, 2025, 10)]) {
      expect(missing(computeTfsaRoom(input({ coverage: late, memory: { outside: [f] } })))).toEqual([{ kind: "coverage", label: "Synthetic TFSA", accountKey: MAIN }]);
    }
  });

  it("without a figure the gap is missing coverage", () => {
    // The TRANSFER_IN is assumed a contribution, so only the coverage gap is missing.
    expect(missing(computeTfsaRoom(input({ coverage: late, activities: rows() })))).toEqual([
      { kind: "coverage", label: "Synthetic TFSA", accountKey: MAIN },
    ]);
  });

  it("counts contributions after the figure's asOf and gates their ambiguity (the review's example)", () => {
    const coverage = new Map([[MAIN, { coversFrom: "2026-03-01" }]]);
    const transfer = act("SOMETHING_NEW", 9000, "2026-11-20");
    const activities = [act("CONTRIBUTION", 3000, "2026-04-01"), act("CONTRIBUTION", 5000, "2026-11-15"), transfer];
    const memory = { outside: [connectedYtd(MAIN, 2026, 3000, "stated", "2026-05-01")] };
    const m = missing(computeTfsaRoom(input({ today: "2026-12-01", coverage, activities, memory })));
    expect(m).toEqual([{ kind: "ambiguous", count: 1, rows: [expect.objectContaining({ activityKey: transfer.activityKey, amountCad: 9000 })] }]);

    const classifications = new Map<string, "contribution" | "none">([[transfer.activityKey, "none"]]);
    const r = known(computeTfsaRoom(input({ today: "2026-12-01", coverage, activities, memory: { ...memory, classifications } })));
    expect(r).toMatchObject({ contributedCad: 8000, roomLeftCad: -1000, overLimitCad: 1000 });
  });

  it("a figure's asOf after the day it was recorded (Toronto), after today, or outside its year never bridges the gap", () => {
    const coverage = new Map([[MAIN, { coversFrom: "2026-03-01" }]]);
    const activities = [act("CONTRIBUTION", 5000, "2026-11-15"), act("TRANSFER_IN", 9000, "2026-11-20")];
    const cases = [
      connectedYtd(MAIN, 2026, 3000, "stated", "2026-12-31", "2026-11-14T17:00:00.000Z"), // the review's example
      connectedYtd(MAIN, 2026, 3000, "stated", "2027-01-15", "2027-01-15T17:00:00.000Z"), // cross-year (and future)
      connectedYtd(MAIN, 2026, 3000, "stated", "2026-12-15", "2026-12-15T17:00:00.000Z"), // after today
      connectedYtd(MAIN, 2026, 3000, "stated", "2026-11-30", "2026-05-01T16:00:00.000Z"), // after recordedAt
    ];
    for (const f of cases) {
      const r = computeTfsaRoom(input({ today: "2026-12-01", coverage, activities, memory: { outside: [f] } }));
      expect(r.status, JSON.stringify(f.value)).toBe("missing");
      expect(missing(r)[0]).toEqual({ kind: "coverage", label: "Synthetic TFSA", accountKey: MAIN });
    }
  });

  it("recordedAt is read as a Toronto date: 02:30 UTC on 1 June is still 31 May in Toronto", () => {
    const coverage = new Map([[MAIN, { coversFrom: "2026-03-01" }]]);
    const late = connectedYtd(MAIN, 2026, 3000, "stated", "2026-06-01", "2026-06-01T02:30:00.000Z");
    expect(missing(computeTfsaRoom(input({ coverage, memory: { outside: [late] } })))[0]).toEqual({ kind: "coverage", label: "Synthetic TFSA", accountKey: MAIN });
    const sameDay = connectedYtd(MAIN, 2026, 3000, "stated", "2026-05-31", "2026-06-01T02:30:00.000Z");
    expect(known(computeTfsaRoom(input({ coverage, memory: { outside: [sameDay] } }))).contributedCad).toBe(3000);
  });

  it("a contribution dated on the asOf date is counted (a double count can only lower room)", () => {
    const coverage = new Map([[MAIN, { coversFrom: "2026-03-01" }]]);
    const r = known(computeTfsaRoom(input({ coverage, activities: [act("CONTRIBUTION", 5000, "2026-05-01")], memory: { outside: [connectedYtd(MAIN, 2026, 3000, "stated", "2026-05-01")] } })));
    expect(r.contributedCad).toBe(8000);
  });

  it("rows before asOf count as withdrawals only", () => {
    const coverage = new Map([[MAIN, { coversFrom: "2026-03-01" }]]);
    const activities = [act("CONTRIBUTION", 3000, "2026-04-01"), act("TRANSFER", 7, "2026-04-02"), act("WITHDRAWAL", -400, "2026-04-30"), act("CONTRIBUTION", 100, "2026-05-02")];
    const r = known(computeTfsaRoom(input({ coverage, activities, memory: { outside: [connectedYtd(MAIN, 2026, 3000, "stated", "2026-05-01")] } })));
    expect(r).toMatchObject({ contributedCad: 3100, withdrawnCad: 400 });
  });

  it("a figure dated before the stored activity starts leaves a gap: missing coverage", () => {
    const coverage = new Map([[MAIN, { coversFrom: "2026-06-01" }]]);
    const gap = input({ coverage, memory: { outside: [connectedYtd(MAIN, 2026, 3000, "stated", "2026-05-01")] } });
    expect(missing(computeTfsaRoom(gap))).toEqual([{ kind: "coverage", label: "Synthetic TFSA", accountKey: MAIN }]);
    const touching = input({ coverage, memory: { outside: [connectedYtd(MAIN, 2026, 3000, "stated", "2026-05-31")] } });
    expect(known(computeTfsaRoom(touching)).contributedCad).toBe(3000);
    const unknownCoverage = input({ coverage: new Map(), memory: { outside: [connectedYtd(MAIN, 2026, 3000, "stated", "2026-05-31")] } });
    expect(missing(computeTfsaRoom(unknownCoverage))).toEqual([{ kind: "coverage", label: "Synthetic TFSA", accountKey: MAIN }]);
  });

  it("a covered account ignores a year-to-date figure and uses its activity", () => {
    const r = known(computeTfsaRoom(input({ activities: [act("CONTRIBUTION", 1000, "2026-04-15")], memory: { outside: [connectedYtd(MAIN, 2026, 4200)] } })));
    expect(r.contributedCad).toBe(1000);
  });
});

describe("computeTfsaRoom: basis", () => {
  it("lists the CRA as-of year, the connected account labels and the 'you said' items", () => {
    const r = known(computeTfsaRoom(input({ memory: { accountSet: accountSet(2026, [MAIN], ["Other bank"]), outside: [outsideYtd("Other bank", 2026, 50.5)] } })));
    expect(r.basis).toEqual([
      "CRA room on 1 January 2026: $7,000 (you said)",
      "Your TFSAs for 2026, confirmed 2026-02-01 (you said)",
      "Connected TFSA: Synthetic TFSA",
      "Other bank: $50.50 contributed this year (you said)",
    ]);
  });

  it("says imported for an imported CRA figure", () => {
    const r = known(computeTfsaRoom(input({ memory: { craRoom: craRoom(2026, 7000, "imported") } })));
    expect(r.basis[0]).toBe("CRA room on 1 January 2026: $7,000 (imported)");
  });

  it("rounds to cents", () => {
    const r = known(computeTfsaRoom(input({ activities: [act("CONTRIBUTION", 0.1, "2026-03-03"), act("CONTRIBUTION", 0.2, "2026-03-04")] })));
    expect(r.contributedCad).toBe(0.3);
    expect(r.roomLeftCad).toBe(6999.7);
  });
});

describe("Bank of Canada rate dates and native amounts (repo currency rule)", () => {
  const boc = (rate: number, rateDate: string) => ({ toCad: (amount: number) => ({ cad: amount * rate, estimated: true, rateDate }) });

  it("a USD ambiguous row carries est., its BoC rate date and the native amount", () => {
    const row = act("SOMETHING_NEW", 1000, "2026-03-03", { currency: "USD" });
    const [item] = missing(computeTfsaRoom(input({ fx: boc(1.35, "2026-03-02"), activities: [row] })));
    expect(item).toEqual({ kind: "ambiguous", count: 1, rows: [{
      activityKey: row.activityKey, date: "2026-03-03", amountCad: 1350, estimated: true, rateDate: "2026-03-02",
      native: { amount: 1000, currency: "USD" }, type: "SOMETHING_NEW", label: "Synthetic TFSA",
    }] });
  });

  it("a USD transfer converted at a BoC rate is assumed, keeping est., its rate date and the native amount", () => {
    const row = act("TRANSFER_IN", 1000, "2026-03-03", { currency: "USD" });
    const r = known(computeTfsaRoom(input({ fx: boc(1.35, "2026-03-02"), activities: [row] })));
    expect(r.ledger.rows[1]).toMatchObject({ kind: "contribution", assumed: true, amountCad: 1350, estimated: true, rateDate: "2026-03-02", native: { amount: 1000, currency: "USD" } });
  });

  it("a USD withdrawal's total says est., with its rate dates and native amounts", () => {
    const r = computeTfsaRoom(input({ fx: boc(1.4, "2026-03-02"), activities: [act("WITHDRAWAL", -1000, "2026-03-03", { currency: "USD" }), act("WITHDRAWAL", -500, "2026-03-04")] }));
    expect(r.withdrawnCad).toBe(1900);
    expect(r.fx.withdrawals).toEqual({ estimated: true, rateDates: ["2026-03-02"], native: [{ amount: 1000, currency: "USD" }] });
    expect(r.fx.contributions).toEqual({ estimated: false, rateDates: [], native: [] });
    expect(r.fxDates).toEqual(["2026-03-02"]);
  });

  it("USD contributions in a known result list every BoC rate date used, sorted, and the native total", () => {
    let call = 0;
    const fx = { toCad: (amount: number) => ({ cad: amount * 1.35, estimated: true, rateDate: ++call === 1 ? "2026-06-01" : "2026-03-02" }) };
    const r = known(computeTfsaRoom(input({ fx, activities: [act("CONTRIBUTION", 1000, "2026-06-02", { currency: "USD" }), act("CONTRIBUTION", 500, "2026-03-03", { currency: "USD" }), act("CONTRIBUTION", 100, "2026-03-04")] })));
    expect(r.contributedCad).toBe(2125);
    expect(r.estimated).toBe(true);
    expect(r.fx.contributions).toEqual({ estimated: true, rateDates: ["2026-03-02", "2026-06-01"], native: [{ amount: 1500, currency: "USD" }] });
    expect(r.fxDates).toEqual(["2026-03-02", "2026-06-01"]);
  });

  it("a broker-rate conversion is not est. but its native amount stays visible", () => {
    const r = known(computeTfsaRoom(input({ fx: boc(1.38, "2026-03-02"), activities: [act("CONTRIBUTION", 1000, "2026-03-03", { currency: "USD", fxRate: 1.37 })] })));
    expect(r.fx.contributions).toEqual({ estimated: false, rateDates: [], native: [{ amount: 1000, currency: "USD" }] });
    expect(r.fxDates).toEqual([]);
  });

  it("a user-classified converted row's basis line shows est., the BoC date and the native amount", () => {
    const row = act("TRANSFER_IN", 1000, "2026-03-03", { currency: "USD" });
    const r = known(computeTfsaRoom(input({ fx: boc(1.35, "2026-03-02"), activities: [row], memory: { classifications: new Map([[row.activityKey, "contribution"]]) } })));
    expect(r.basis).toContain("You said the transfer in of $1,350 (est., BoC 2026-03-02; US$1,000) on 2026-03-03 (Synthetic TFSA) was a contribution");
  });
});

describe("computeTfsaRoom: stale activity (freshness gate)", () => {
  const stale = (lastSyncedAt: string | null) => [{ kind: "stale_activity", accountKey: MAIN, label: "Synthetic TFSA", lastSyncedAt }];

  it("a sync error, a sync 8 days old, a null sync time or no sync row withhold the number", () => {
    expect(missing(computeTfsaRoom(input({ sync: new Map([[MAIN, fresh({ lastError: true })]]) })))).toEqual(stale(SYNCED));
    expect(missing(computeTfsaRoom(input({ sync: new Map([[MAIN, fresh({ lastSyncedAt: "2026-10-16T16:00:00.000Z" })]]) })))).toEqual(stale("2026-10-16T16:00:00.000Z"));
    expect(missing(computeTfsaRoom(input({ sync: new Map([[MAIN, fresh({ lastSyncedAt: "2026-10-17T15:59:59.000Z" })]]) })))).toEqual(stale("2026-10-17T15:59:59.000Z"));
    expect(missing(computeTfsaRoom(input({ sync: new Map([[MAIN, fresh({ lastSyncedAt: null })]]) })))).toEqual(stale(null));
    expect(missing(computeTfsaRoom(input({ sync: new Map() })))).toEqual(stale(null));
  });

  it("a dirty flag alone (any webhook sets it) does not withhold the number; the as-of line discloses it", () => {
    const r = known(computeTfsaRoom(input({ sync: new Map([[MAIN, fresh({ dirty: true })]]) })));
    expect(r.activityAsOf).toBe(SYNCED);
  });

  it("72 hours old is now fresh, and so is exactly 7 days old", () => {
    expect(MAX_ACTIVITY_AGE_DAYS).toBe(7);
    expect(known(computeTfsaRoom(input({ sync: new Map([[MAIN, fresh({ lastSyncedAt: "2026-10-21T16:00:00.000Z" })]]) }))).activityAsOf).toBe("2026-10-21T16:00:00.000Z");
    expect(known(computeTfsaRoom(input({ sync: new Map([[MAIN, fresh({ lastSyncedAt: "2026-10-17T16:00:00.000Z" })]]) }))).activityAsOf).toBe("2026-10-17T16:00:00.000Z");
  });

  it("fresh accounts give a known number with activityAsOf, the oldest sync across connected TFSAs", () => {
    const accounts = [
      { accountKey: MAIN, label: "Synthetic TFSA", bucket: "tfsa", neutral: false },
      { accountKey: SECOND, label: "Synthetic second TFSA", bucket: "tfsa", neutral: false },
      // Not a TFSA: its sync never matters.
      { accountKey: ODD, label: "Synthetic odd account", bucket: "other", neutral: true },
    ];
    const sync = new Map([[MAIN, fresh()], [SECOND, fresh({ lastSyncedAt: "2026-10-23T09:30:00.000Z" })], [ODD, fresh({ lastError: true })]]);
    const r = known(computeTfsaRoom(input({ accounts, sync, memory: { accountSet: accountSet(2026, [MAIN, SECOND], [], "stated", [ODD]) } })));
    expect(r.activityAsOf).toBe("2026-10-23T09:30:00.000Z");
  });

  it("is listed with the other gates; only connected TFSAs are checked", () => {
    const m = missing(computeTfsaRoom(input({ sync: new Map([[MAIN, fresh({ lastError: true })]]), memory: { craRoom: null } })));
    expect(m.map((x) => x.kind)).toEqual(["cra_room", "stale_activity"]);
  });
});

describe("computeTfsaRoom: a confirmed TFSA that is no longer connected (spec §9a.4)", () => {
  const set = () => accountSet(2026, [MAIN, SECOND]);

  it("asks for its contributions this year instead of re-confirming the set", () => {
    expect(missing(computeTfsaRoom(input({ memory: { accountSet: set() } })))).toEqual([{ kind: "disconnected_account", accountKey: SECOND }]);
  });

  it("a stated year-to-date figure on its key counts toward contributions", () => {
    const r = known(computeTfsaRoom(input({
      activities: [act("CONTRIBUTION", 1000, "2026-03-01")],
      memory: { accountSet: set(), outside: [connectedYtd(SECOND, 2026, 2500, "stated", "2026-10-20")] },
    })));
    expect(r).toMatchObject({ contributedCad: 3500, roomLeftCad: 3500 });
    expect(r.basis.some((line) => line.includes(SECOND) && line.includes("$2,500"))).toBe(true);
  });

  it("an inferred, last year's or not-yet-credible figure does not satisfy it", () => {
    for (const f of [
      connectedYtd(SECOND, 2026, 2500, "inferred", "2026-10-20"),
      connectedYtd(SECOND, 2025, 2500, "stated", "2025-10-20"),
      connectedYtd(SECOND, 2026, 2500, "stated", "2026-10-30", "2026-10-24T12:00:00.000Z"),
    ]) {
      expect(missing(computeTfsaRoom(input({ memory: { accountSet: set(), outside: [f] } })))).toEqual([{ kind: "disconnected_account", accountKey: SECOND }]);
    }
  });
});

describe("computeTfsaRoom: freshness exemptions and the alert's view", () => {
  it("a closed TFSA is exempt from the freshness gate (its activity can't change) and is left out of activityAsOf", () => {
    const accounts = [
      { accountKey: MAIN, label: "Synthetic TFSA", bucket: "tfsa", neutral: false },
      { accountKey: SECOND, label: "Synthetic closed TFSA", bucket: "tfsa", neutral: false, closed: true },
    ];
    const sync = new Map([[MAIN, fresh()], [SECOND, fresh({ lastSyncedAt: "2026-03-01T08:00:00.000Z", lastError: true })]]);
    const r = known(computeTfsaRoom(input({ accounts, sync, memory: { accountSet: accountSet(2026, [MAIN, SECOND]) } })));
    expect(r.activityAsOf).toBe(SYNCED);
    // Without a sync row at all it is still exempt; an open one is not.
    expect(computeTfsaRoom(input({ accounts, sync: new Map([[MAIN, fresh()]]), memory: { accountSet: accountSet(2026, [MAIN, SECOND]) } })).status).toBe("known");
    expect(missing(computeTfsaRoom(input({ accounts: [accounts[0]!, { ...accounts[1]!, closed: false }], sync, memory: { accountSet: accountSet(2026, [MAIN, SECOND]) } }))))
      .toEqual([{ kind: "stale_activity", accountKey: SECOND, label: "Synthetic closed TFSA", lastSyncedAt: "2026-03-01T08:00:00.000Z" }]);
  });

  it("ignoreFreshness computes the number as if activity were fresh, and nothing else changes", () => {
    const staleInput = input({ activities: [act("CONTRIBUTION", 8000, "2026-03-01")], sync: new Map([[MAIN, fresh({ lastError: true })]]) });
    expect(missing(computeTfsaRoom(staleInput)).map((m) => m.kind)).toEqual(["stale_activity"]);
    expect(known(computeTfsaRoom(staleInput, { ignoreFreshness: true }))).toMatchObject({ overLimitCad: 1000, activityAsOf: null });
    expect(missing(computeTfsaRoom({ ...staleInput, memory: { ...staleInput.memory, craRoom: null } }, { ignoreFreshness: true }))).toEqual([{ kind: "cra_room" }]);
  });
});

describe("computeTfsaRoom: the ledger (spec §5)", () => {
  const boc = (rate: number, rateDate: string) => ({ toCad: (amount: number) => ({ cad: amount * rate, estimated: true, rateDate }) });

  it("known result's ledger final row equals roomLeftCad and overLimitCad", () => {
    const rows = [act("CONTRIBUTION", 6000, "2026-01-10"), act("WITHDRAWAL", -5000, "2026-02-03"), act("CONTRIBUTION", 5000, "2026-03-14"), act("BUY", -100, "2026-03-15")];
    const r = known(computeTfsaRoom(input({ activities: rows })));
    expect(r.ledger.rows.map((x) => [x.kind, x.roomLeftCad])).toEqual([["cra_room", 7000], ["contribution", 1000], ["withdrawal", 1000], ["contribution", -4000]]);
    const last = r.ledger.rows.at(-1)!;
    expect(r.roomLeftCad).toBe(last.roomLeftCad);
    expect(r.overLimitCad).toBe(last.excessCad);
    expect(r).toMatchObject({ roomLeftCad: -4000, overLimitCad: 4000, contributedCad: 11000, withdrawnCad: 5000 });
    expect(r.ledger.overSince).toBe("2026-03-14");
    expect(last).toMatchObject({ activityKey: rows[2]!.activityKey, accountKey: MAIN, label: "Synthetic TFSA", wentOver: true });
  });

  it("a qualifying withdrawal lowers overLimitCad (the alert's figure too)", () => {
    const r = known(computeTfsaRoom(input({
      memory: { craRoom: craRoom(2026, 5000) },
      activities: [act("CONTRIBUTION", 7000, "2026-01-05"), act("WITHDRAWAL", -2000, "2026-02-01"), act("CONTRIBUTION", 1000, "2026-03-01")],
    })));
    expect(r).toMatchObject({ roomLeftCad: -1000, overLimitCad: 1000 });
    expect(r.ledger.overSince).toBe("2026-03-01");
  });

  it("with no moves the ledger is the CRA row alone", () => {
    const r = known(computeTfsaRoom(input()));
    expect(r.ledger).toEqual({ rows: [expect.objectContaining({ kind: "cra_room", amountCad: 7000, roomLeftCad: 7000, excessCad: 0 })], overSince: null, undatedExcess: false });
  });

  it("a USD contribution row carries estimated, rateDate and native (Review Focus 4)", () => {
    const r = known(computeTfsaRoom(input({ fx: boc(1.35, "2026-03-02"), activities: [act("CONTRIBUTION", 1000, "2026-03-03", { currency: "USD" })] })));
    expect(r.ledger.rows[1]).toMatchObject({
      kind: "contribution", date: "2026-03-03", amountCad: 1350, estimated: true, rateDate: "2026-03-02", native: { amount: 1000, currency: "USD" }, roomLeftCad: 5650,
    });
    const broker = known(computeTfsaRoom(input({ fx: boc(1.38, "2026-03-02"), activities: [act("CONTRIBUTION", 1000, "2026-03-03", { currency: "USD", fxRate: 1.37 })] })));
    expect(broker.ledger.rows[1]).toMatchObject({ amountCad: 1370, estimated: false, rateDate: null, native: { amount: 1000, currency: "USD" } });
  });

  it("a withdrawal row is signed negative and says when its room returns", () => {
    const r = known(computeTfsaRoom(input({ activities: [act("WITHDRAWAL", -1234.5, "2026-03-10")] })));
    expect(r.ledger.rows[1]).toMatchObject({ kind: "withdrawal", amountCad: -1234.5, returnsOn: "2027-01-01", roomLeftCad: 7000 });
  });

  it("a user-classified none row is listed with zero effect; table-none rows are not listed", () => {
    const row = act("TRANSFER_IN", 2500, "2026-03-03");
    const r = known(computeTfsaRoom(input({ activities: [row, act("DIVIDEND", 12, "2026-03-04")], memory: { classifications: new Map([[row.activityKey, "none"]]) } })));
    expect(r.ledger.rows.map((x) => [x.kind, x.amountCad, x.roomLeftCad])).toEqual([["cra_room", 7000, 7000], ["none", 2500, 7000]]);
  });

  it("a USD none-classified row with no rate and an undated none row still give a known result", () => {
    const usd = act("TRANSFER_IN", 1000, "2026-03-03", { currency: "USD" });
    const undated = act("TRANSFER_IN", 400, null);
    const r = known(computeTfsaRoom(input({
      memory: { craRoom: craRoom(2026, 5000), classifications: new Map([[usd.activityKey, "none"], [undated.activityKey, "none"]]) },
      activities: [act("CONTRIBUTION", 6000, "2026-01-05"), usd, undated],
    })));
    // Neither none row has a CAD amount (no rate; no date to convert on); each keeps its native amount.
    expect(r.ledger.rows.map((x) => [x.kind, x.date, x.amountCad, x.native])).toEqual([
      ["cra_room", "2026-01-01", 5000, null], ["contribution", "2026-01-05", 6000, { amount: 6000, currency: "CAD" }],
      ["none", "2026-03-03", null, { amount: 1000, currency: "USD" }], ["none", null, null, { amount: 400, currency: "CAD" }],
    ]);
    const last = r.ledger.rows.at(-1)!;
    expect(typeof r.roomLeftCad).toBe("number");
    expect(typeof r.overLimitCad).toBe("number");
    expect(r).toMatchObject({ roomLeftCad: -1000, overLimitCad: 1000 });
    expect([last.roomLeftCad, last.excessCad]).toEqual([r.roomLeftCad, r.overLimitCad]);
    expect(r.ledger.overSince).toBe("2026-01-05");
  });

  it("six unclear transfers: missing caps at 5, ledger lists all 6 (Review Focus 2)", () => {
    const rows = [act("CONTRIBUTION", 1000, "2026-01-02"), ...Array.from({ length: 6 }, (_, i) => act("SOMETHING_NEW", 100 + i, `2026-0${i + 2}-15`))];
    const r = computeTfsaRoom(input({ activities: rows }));
    const [item] = missing(r);
    if (item?.kind !== "ambiguous") throw new Error("expected ambiguous");
    expect(item.count).toBe(6);
    expect(item.rows).toHaveLength(MAX_AMBIGUOUS_ROWS);
    const unclear = r.ledger.rows.filter((x) => x.kind === "ambiguous");
    expect(unclear).toHaveLength(6);
    for (const x of unclear) expect([x.roomLeftCad, x.excessCad]).toEqual([null, null]);
    expect(r.ledger.rows.slice(0, 2).map((x) => x.roomLeftCad)).toEqual([7000, 6000]);
  });

  it("31 December 2025 excluded, 1 January 2026 included (Review Focus 5)", () => {
    const rows = [act("CONTRIBUTION", 500, "2025-12-31"), act("CONTRIBUTION", 300, "2026-01-01")];
    const r = known(computeTfsaRoom(input({ activities: rows })));
    expect(r.ledger.rows.map((x) => [x.date, x.kind, x.amountCad])).toEqual([["2026-01-01", "cra_room", 7000], ["2026-01-01", "contribution", 300]]);
    expect(r.roomLeftCad).toBe(6700);
  });

  it("a new year with no room entered shows the missing ledger from known moves (Review Focus 5)", () => {
    const r = computeTfsaRoom(input({ today: "2027-01-05", memory: { craRoom: null, accountSet: accountSet(2027, [MAIN]) }, activities: [act("CONTRIBUTION", 300, "2027-01-02")] }));
    expect(missing(r)).toEqual([{ kind: "cra_room" }]);
    expect(r.ledger.rows.map((x) => [x.kind, x.amountCad, x.roomLeftCad])).toEqual([["cra_room", null, null], ["contribution", 300, null]]);
  });

  it("duplicate activityKey counted once in the ledger", () => {
    const row = act("CONTRIBUTION", 1000, "2026-03-03");
    const r = known(computeTfsaRoom(input({ activities: [row, { ...row }] })));
    expect(r.ledger.rows.filter((x) => x.activityKey === row.activityKey)).toHaveLength(1);
    expect(r.roomLeftCad).toBe(6000);
  });

  it("outside TFSA with tfsa_moves: dated rows in the ledger, no outside_contributions missing item", () => {
    const label = "Synthetic outside TFSA";
    const key = outsideAccountKey(label);
    const r = known(computeTfsaRoom(input({
      memory: {
        accountSet: accountSet(2026, [MAIN], [label]),
        outsideMoves: [outsideMoves(label, 2026, [{ date: "2026-06-01", amountCad: 400, kind: "withdrawal" }, { date: "2026-03-10", amountCad: 2000, kind: "deposit" }])],
      },
      activities: [act("CONTRIBUTION", 1000, "2026-02-01")],
    })));
    expect(r.ledger.rows.map((x) => [x.kind, x.date, x.label, x.amountCad, x.accountKey ?? null, x.roomLeftCad])).toEqual([
      ["cra_room", "2026-01-01", "Room from CRA My Account (you entered)", 7000, null, 7000],
      ["contribution", "2026-02-01", "Synthetic TFSA", 1000, MAIN, 6000],
      ["contribution", "2026-03-10", label, 2000, key, 4000],
      ["withdrawal", "2026-06-01", label, -400, key, 4000],
    ]);
    for (const row of r.ledger.rows.slice(2)) {
      expect(row).toMatchObject({ estimated: false, rateDate: null, native: null });
      expect(row.activityKey).toBeUndefined();
    }
    expect(r.ledger.rows.at(-1)!.returnsOn).toBe("2027-01-01");
    expect(r).toMatchObject({ roomLeftCad: 4000, contributedCad: 3000, withdrawnCad: 400, overLimitCad: 0 });
    expect(r.ledger.undatedExcess).toBe(false);
  });

  it("outside withdrawal while over reduces excess", () => {
    const label = "Synthetic outside TFSA";
    const r = known(computeTfsaRoom(input({
      memory: {
        craRoom: craRoom(2026, 5000),
        accountSet: accountSet(2026, [MAIN], [label]),
        outsideMoves: [outsideMoves(label, 2026, [{ date: "2026-03-01", amountCad: 2000, kind: "deposit" }, { date: "2026-04-01", amountCad: 600, kind: "withdrawal" }])],
      },
      activities: [act("CONTRIBUTION", 4000, "2026-02-01")],
    })));
    expect(r.ledger.rows.map((x) => [x.kind, x.roomLeftCad, x.excessCad])).toEqual([
      ["cra_room", 5000, 0], ["contribution", 1000, 0], ["contribution", -1000, 1000], ["withdrawal", -400, 400],
    ]);
    expect(r).toMatchObject({ roomLeftCad: -400, overLimitCad: 400 });
    // Dated moves, so the date the excess began is known.
    expect(r.ledger).toMatchObject({ overSince: "2026-03-01", undatedExcess: false });
  });

  it("outside account with both tfsa_moves and ytd_contributions uses tfsa_moves", () => {
    const label = "Synthetic outside TFSA";
    const r = known(computeTfsaRoom(input({
      memory: {
        accountSet: accountSet(2026, [MAIN], [label]),
        outside: [outsideYtd(label, 2026, 4500)],
        outsideMoves: [
          outsideMoves(label, 2025, [{ date: "2025-03-01", amountCad: 6000, kind: "deposit" }]),
          outsideMoves(label, 2026, [{ date: "2026-03-01", amountCad: 900, kind: "deposit" }]),
        ],
      },
    })));
    expect(r.ledger.rows.map((x) => [x.kind, x.date, x.amountCad])).toEqual([["cra_room", "2026-01-01", 7000], ["contribution", "2026-03-01", 900]]);
    expect(r).toMatchObject({ roomLeftCad: 6100, contributedCad: 900 });
  });

  it("an inferred or last year's tfsa_moves fact never counts: the ytd_contributions fallback or the missing item stands", () => {
    const label = "Synthetic outside TFSA";
    const inferred = outsideMoves(label, 2026, [{ date: "2026-03-01", amountCad: 900, kind: "deposit" }], "inferred");
    const lastYear = outsideMoves(label, 2025, [{ date: "2025-03-01", amountCad: 900, kind: "deposit" }]);
    expect(missing(computeTfsaRoom(input({ memory: { accountSet: accountSet(2026, [MAIN], [label]), outsideMoves: [inferred, lastYear] } }))))
      .toEqual([{ kind: "outside_contributions", label, accountKey: outsideAccountKey(label) }]);
    const r = known(computeTfsaRoom(input({ memory: { accountSet: accountSet(2026, [MAIN], [label]), outside: [outsideYtd(label, 2026, 300)], outsideMoves: [inferred] } })));
    expect(r.contributedCad).toBe(300);
  });

  it("the newest tfsa_moves fact for the year replaces an older one", () => {
    const label = "Synthetic outside TFSA";
    const older = outsideMoves(label, 2026, [{ date: "2026-03-01", amountCad: 900, kind: "deposit" }]);
    const newer = outsideMoves(label, 2026, [{ date: "2026-03-01", amountCad: 100, kind: "deposit" }]);
    expect(known(computeTfsaRoom(input({ memory: { accountSet: accountSet(2026, [MAIN], [label]), outsideMoves: [newer, older] } }))).contributedCad).toBe(100);
  });

  it("outside account with only ytd_contributions: one undated outside_total row", () => {
    const label = "Synthetic outside TFSA";
    const r = known(computeTfsaRoom(input({ memory: { accountSet: accountSet(2026, [MAIN], [label]), outside: [outsideYtd(label, 2026, 1200)] } })));
    const outsideRows = r.ledger.rows.filter((x) => x.accountKey === outsideAccountKey(label));
    expect(outsideRows).toHaveLength(1);
    expect(outsideRows[0]).toMatchObject({ kind: "outside_total", date: "2026-05-01", amountCad: 1200 });
    expect(r.roomLeftCad).toBe(5800);
  });

  it("outside and stand-in totals are undated rows at their as-of date", () => {
    const r = known(computeTfsaRoom(input({
      memory: { craRoom: craRoom(2026, 5000), accountSet: accountSet(2026, [MAIN], ["Synthetic outside TFSA"]), outside: [outsideYtd("Synthetic outside TFSA", 2026, 4500)] },
      activities: [act("CONTRIBUTION", 1000, "2026-01-05")],
    })));
    expect(r.ledger.rows.at(-1)).toMatchObject({ kind: "outside_total", date: "2026-05-01", label: "Synthetic outside TFSA", amountCad: 4500, accountKey: outsideAccountKey("Synthetic outside TFSA") });
    expect(r).toMatchObject({ roomLeftCad: -500, overLimitCad: 500 });
    expect(r.ledger).toMatchObject({ overSince: null, undatedExcess: true });
  });

  it("a coverage stand-in figure is an undated total; withdrawals before its asOf are listed, contributions are not", () => {
    const r = known(computeTfsaRoom(input({
      coverage: new Map([[MAIN, { coversFrom: "2026-04-01" }]]),
      memory: { outside: [connectedYtd(MAIN, 2026, 2000, "stated", "2026-04-15")] },
      activities: [act("CONTRIBUTION", 300, "2026-04-02"), act("WITHDRAWAL", -100, "2026-04-03"), act("CONTRIBUTION", 400, "2026-05-01")],
    })));
    expect(r.ledger.rows.map((x) => [x.kind, x.date, x.amountCad])).toEqual([
      ["cra_room", "2026-01-01", 7000], ["withdrawal", "2026-04-03", -100], ["outside_total", "2026-04-15", 2000], ["contribution", "2026-05-01", 400],
    ]);
    expect(r.roomLeftCad).toBe(4600);
  });

  it("in the missing state for another gap, rows are listed with unknown running values", () => {
    const r = computeTfsaRoom(input({ coverage: new Map([[MAIN, { coversFrom: "2026-04-01" }]]), activities: [act("CONTRIBUTION", 300, "2026-04-02")] }));
    expect(missing(r).map((m) => m.kind)).toEqual(["coverage"]);
    expect(r.ledger.rows.map((x) => [x.kind, x.roomLeftCad])).toEqual([["cra_room", 7000], ["contribution", null]]);
    expect(r.ledger.overSince).toBeNull();
  });

  it("ignoreFreshness builds the same ledger the alert reads", () => {
    const staleInput = input({ activities: [act("CONTRIBUTION", 8000, "2026-03-01")], sync: new Map([[MAIN, fresh({ lastError: true })]]) });
    const r = known(computeTfsaRoom(staleInput, { ignoreFreshness: true }));
    expect(r.ledger.rows.at(-1)).toMatchObject({ roomLeftCad: -1000, excessCad: 1000, wentOver: true });
  });
});

describe("computeTfsaRoom: withdrawals that reduced an excess (ITA 207.01(1))", () => {
  it("spec example: the withdrawal's whole amount qualified, so nothing returns next year", () => {
    const r = known(computeTfsaRoom(input({
      memory: { craRoom: craRoom(2026, 5000) },
      activities: [act("CONTRIBUTION", 7000, "2026-01-05"), act("WITHDRAWAL", -2000, "2026-02-01"), act("CONTRIBUTION", 1000, "2026-03-01")],
    })));
    expect(r.ledger.rows.find((x) => x.kind === "withdrawal")).toMatchObject({ qualifyingCad: 2000, returnsCad: 0 });
    expect(r).toMatchObject({ withdrawnCad: 2000, returningCad: 0 });
  });

  it("mixed: 1000 qualified and 2000 returns next year", () => {
    const r = known(computeTfsaRoom(input({
      memory: { craRoom: craRoom(2026, 5000) },
      activities: [act("CONTRIBUTION", 6000, "2026-01-05"), act("WITHDRAWAL", -3000, "2026-02-01")],
    })));
    expect(r.ledger.rows.find((x) => x.kind === "withdrawal")).toMatchObject({ qualifyingCad: 1000, returnsCad: 2000, returnsOn: "2027-01-01" });
    expect(r).toMatchObject({ withdrawnCad: 3000, returningCad: 2000 });
  });

  it("missing: returningCad is null when a withdrawal's split can't be told", () => {
    const r = computeTfsaRoom(input({ memory: { craRoom: null }, activities: [act("WITHDRAWAL", -500, "2026-02-01")] }));
    expect(r).toMatchObject({ status: "missing", withdrawnCad: 500, returningCad: null });
    const w = r.ledger.rows.find((x) => x.kind === "withdrawal")!;
    expect(w).toMatchObject({ qualifyingCad: null, returnsCad: null });
    expect(w.returnsOn).toBeUndefined();
  });

  it("missing for another input (stale activity): the split is withheld too", () => {
    const r = computeTfsaRoom(input({ activities: [act("WITHDRAWAL", -500, "2026-02-01")], sync: new Map([[MAIN, fresh({ lastError: true })]]) }));
    expect(r).toMatchObject({ status: "missing", returningCad: null });
    expect(r.ledger.rows[1]!.returnsOn).toBeUndefined();
  });
});

describe("computeTfsaRoom: an undated total after a dated withdrawal", () => {
  const label = "Synthetic outside TFSA";
  const key = outsideAccountKey(label);
  const total = (asOf: string, amountCad: number) => fact("account", key, "account.ytd_contributions", { year: 2026, amountCad, asOf });

  it("a total as of 1 April after a 1 March withdrawal, with an excess: missing dated_entries", () => {
    const r = computeTfsaRoom(input({
      memory: { craRoom: craRoom(2026, 5000), accountSet: accountSet(2026, [MAIN], [label]), outside: [total("2026-04-01", 7000)] },
      activities: [act("WITHDRAWAL", -2000, "2026-03-01")],
    }));
    expect(missing(r)).toEqual([{ kind: "dated_entries", label, accountKey: key }]);
    expect(r.ledger.rows.slice(1).every((x) => x.roomLeftCad === null && x.excessCad === null)).toBe(true);
  });

  it("the same total with no excess stays known", () => {
    const r = known(computeTfsaRoom(input({
      memory: { craRoom: craRoom(2026, 9000), accountSet: accountSet(2026, [MAIN], [label]), outside: [total("2026-04-01", 7000)] },
      activities: [act("WITHDRAWAL", -2000, "2026-03-01")],
    })));
    expect(r.roomLeftCad).toBe(2000);
  });

  it("a withdrawal after the total's as-of date doesn't change it: known, over with no date", () => {
    const r = known(computeTfsaRoom(input({
      memory: { craRoom: craRoom(2026, 5000), accountSet: accountSet(2026, [MAIN], [label]), outside: [total("2026-04-01", 7000)] },
      activities: [act("WITHDRAWAL", -500, "2026-05-01")],
    })));
    expect(r).toMatchObject({ overLimitCad: 1500 });
    expect(r.ledger.undatedExcess).toBe(true);
  });
});

describe("computeTfsaRoom: a managed TFSA (A9)", () => {
  // SnapTrade gives no activity for a managed portfolio, so its contributions are invisible: as for the RRSP, the room
  // waits for the user's figure for that account instead of counting it as $0.
  const MANAGED = accountKey("synthetic-managed-tfsa");
  const accounts = [
    { accountKey: MAIN, label: "Synthetic TFSA", bucket: "tfsa", neutral: false },
    { accountKey: MANAGED, label: "Synthetic Managed TFSA", bucket: "tfsa", neutral: false, managed: true },
  ];
  const selfDirected = [act("CONTRIBUTION", 2000, "2026-04-01")];

  it("doesn't hold the number back: the room is computed from what's visible and names it as not counted, and it is never a 'Connected TFSA'", () => {
    const r = known(computeTfsaRoom(input({ accounts, activities: selfDirected, memory: { accountSet: null } })));
    expect(r).toMatchObject({ contributedCad: 2000, roomLeftCad: 5000 });
    expect(r.notCounted).toEqual([{ accountKey: MANAGED, label: "Synthetic Managed TFSA" }]);
    expect(r.basis).toContain("Managed TFSA: Synthetic Managed TFSA; contributions to it aren't visible through SnapTrade");
    expect(r.basis).not.toContain("Connected TFSA: Synthetic Managed TFSA");
    expect(r.basis).toContain("Connected TFSA: Synthetic TFSA");
    expect(r.ledger.rows.at(-1)!.roomLeftCad).toBe(5000);
    // Its stale sync and coverage are not asked about: there is no activity to be fresh or to cover.
    const noSync = known(computeTfsaRoom(input({ accounts, activities: selfDirected, memory: { accountSet: null }, sync: new Map([[MAIN, fresh()]]), coverage: new Map([[MAIN, { coversFrom: "2025-06-01" }]]) })));
    expect(noSync.notCounted).toEqual([{ accountKey: MANAGED, label: "Synthetic Managed TFSA" }]);
  });

  it("a managed-only user still gets a number, the CRA room with nothing visible, and the note", () => {
    const r = known(computeTfsaRoom(input({ accounts: [accounts[1]!], activities: [], memory: { accountSet: null }, sync: new Map(), coverage: new Map() })));
    expect(r).toMatchObject({ contributedCad: 0, roomLeftCad: 7000, craRoomCad: 7000, overLimitCad: 0 });
    expect(r.notCounted).toEqual([{ accountKey: MANAGED, label: "Synthetic Managed TFSA" }]);
  });

  it("a user with no managed TFSA has no notCounted field at all (closed output shapes stay as they were)", () => {
    const r = known(computeTfsaRoom(input({ accounts: [accounts[0]!], activities: selfDirected, memory: { accountSet: null } })));
    expect("notCounted" in r).toBe(false);
  });

  it("without the CRA room it still asks for that alone, not for the managed account", () => {
    expect(missing(computeTfsaRoom(input({ accounts, activities: selfDirected, memory: { accountSet: null, craRoom: null } }))).map((m) => m.kind)).toEqual(["cra_room"]);
  });

  it("with the user's year-to-date figure on its key it counts as a total at that date, and the number shows", () => {
    const r = known(computeTfsaRoom(input({ accounts, activities: selfDirected, memory: { accountSet: null, outside: [connectedYtd(MANAGED, 2026, 3000)] } })));
    expect(r).toMatchObject({ contributedCad: 5000, roomLeftCad: 2000 });
    expect(r.ledger.rows.find((x) => x.kind === "outside_total")).toMatchObject({ label: "Synthetic Managed TFSA", amountCad: 3000, date: "2026-05-01", accountKey: MANAGED });
    expect(r.basis).toContain("Synthetic Managed TFSA: $3,000 contributed this year as of 2026-05-01 (you said; contributions to it aren't visible through SnapTrade)");
    // A saved figure counts, so the account is no longer named as not counted.
    expect("notCounted" in r).toBe(false);
    // A figure for another year, or dated in the future, doesn't count: the account stays not counted.
    for (const figure of [connectedYtd(MANAGED, 2025, 3000), connectedYtd(MANAGED, 2026, 3000, "stated", "2026-11-01")]) {
      const other = known(computeTfsaRoom(input({ accounts, activities: selfDirected, memory: { accountSet: null, outside: [figure] } })));
      expect(other).toMatchObject({ contributedCad: 2000, roomLeftCad: 5000 });
      expect(other.notCounted?.map((n) => n.accountKey)).toEqual([MANAGED]);
    }
  });

  it("a managed TFSA the user marked as not a TFSA is left out as before", () => {
    const r = known(computeTfsaRoom(input({ accounts, activities: selfDirected, memory: { accountSet: accountSet(2026, [MAIN], [], "stated", [MANAGED]) } })));
    expect(r).toMatchObject({ contributedCad: 2000, roomLeftCad: 5000 });
    expect(r.basis).toContain("Not a TFSA: Synthetic Managed TFSA (you said)");
  });
});

describe("computeTfsaRoom: shares moved in kind (A2)", () => {
  // SnapTrade's TRANSFER rows carry amount 0 and the shares in units (history/sign-rules.ts).
  const inKind = (units: number, price: number | null, extra: Partial<Activity> = {}) =>
    act("TRANSFER", 0, "2026-03-15", { units, price, symbol: "SYN", securityCurrency: "CAD", ...extra });
  const boc = { toCad: (amount: number) => ({ cad: amount * 1.4, estimated: true, rateDate: "2026-03-13" }) };

  it("is a question valued at units × the row's price, and answering contribution adds that value, not $0", () => {
    const row = inKind(100, 100);
    const [item] = missing(computeTfsaRoom(input({ activities: [row] })));
    expect(item).toMatchObject({ kind: "ambiguous", count: 1, rows: [{ activityKey: row.activityKey, amountCad: 10000, estimated: false, native: { amount: 10000, currency: "CAD" }, type: "TRANSFER" }] });
    const answered = known(computeTfsaRoom(input({ activities: [row], memory: { classifications: new Map([[row.activityKey, "contribution"]]) } })));
    // 100 shares × $100 = $10,000 against $7,000 of room: $3,000 over.
    expect(answered).toMatchObject({ contributedCad: 10000, roomLeftCad: -3000, overLimitCad: 3000, estimated: false });
    expect(answered.ledger.rows[1]).toMatchObject({ kind: "contribution", amountCad: 10000, answered: true });
    // It is never assumed to be a contribution: the question flow stands.
    expect(answered.ledger.rows[1]!.assumed).toBeUndefined();
    const none = known(computeTfsaRoom(input({ activities: [row], memory: { classifications: new Map([[row.activityKey, "none"]]) } })));
    expect(none).toMatchObject({ contributedCad: 0, roomLeftCad: 7000 });
  });

  it("without a row price it is valued at that day's close, est.; with no close it stays a question with no amount", () => {
    const row = inKind(100, null);
    const prices = { closeOn: (r: { symbol?: string | null }, date: string) => (r.symbol === "SYN" && date === "2026-03-15" ? { price: 95, currency: "CAD" } : null) };
    const [item] = missing(computeTfsaRoom(input({ activities: [row], prices })));
    expect(item).toMatchObject({ kind: "ambiguous", rows: [{ amountCad: 9500, estimated: true, native: { amount: 9500, currency: "CAD" } }] });
    const answered = known(computeTfsaRoom(input({ activities: [row], prices, memory: { classifications: new Map([[row.activityKey, "contribution"]]) } })));
    expect(answered).toMatchObject({ contributedCad: 9500, estimated: true, overLimitCad: 2500 });
    expect(answered.ledger.rows[1]).toMatchObject({ amountCad: 9500, estimated: true });
    // No value at all: the row stays open, and an answer of contribution never resolves to $0.
    const [open] = missing(computeTfsaRoom(input({ activities: [row] })));
    expect(open).toMatchObject({ kind: "ambiguous", rows: [{ amountCad: null, native: null }] });
    const [still] = missing(computeTfsaRoom(input({ activities: [row], memory: { classifications: new Map([[row.activityKey, "contribution"]]) } })));
    expect(still).toMatchObject({ kind: "ambiguous", count: 1 });
  });

  it("with no price and no close, the row says it is shares moved in kind and a stated year-to-date figure as of a later date stands in for it (review 3)", () => {
    const row = inKind(100, null);
    const [open] = missing(computeTfsaRoom(input({ activities: [row] })));
    expect(open).toMatchObject({ kind: "ambiguous", rows: [{ activityKey: row.activityKey, amountCad: null, inKind: true, accountKey: MAIN }] });
    // The account's activity reaches 1 January, so coverage never asked; the figure still stands for the rows before its as-of date.
    const figure = connectedYtd(MAIN, 2026, 10000, "stated", "2026-04-01");
    const r = known(computeTfsaRoom(input({ coverage: new Map([[MAIN, { coversFrom: COVERS_FROM_START }]]), activities: [row], memory: { outside: [figure] } })));
    expect(r).toMatchObject({ contributedCad: 10000, roomLeftCad: -3000, overLimitCad: 3000 });
    expect(r.ledger.rows.map((x) => [x.kind, x.amountCad])).toEqual([["cra_room", 7000], ["outside_total", 10000]]);
    expect(r.basis).toContain("Synthetic TFSA: $10,000 contributed this year as of 2026-04-01 (you said; stands in for shares moved in kind on 2026-03-15 with no price)");
    // A figure from before the transfer can't hold it: the row stays a question, and a priced row never needs the figure.
    const [early] = missing(computeTfsaRoom(input({ activities: [row], memory: { outside: [connectedYtd(MAIN, 2026, 10000, "stated", "2026-03-01")] } })));
    expect(early).toMatchObject({ kind: "ambiguous", rows: [{ inKind: true }] });
    const priced = missing(computeTfsaRoom(input({ coverage: new Map([[MAIN, { coversFrom: COVERS_FROM_START }]]), activities: [inKind(100, 100)], memory: { outside: [figure] } })));
    expect(priced).toEqual([expect.objectContaining({ kind: "ambiguous", rows: [expect.objectContaining({ amountCad: 10000 })] })]);
    expect(priced[0]).not.toMatchObject({ rows: [{ inKind: true }] });
  });

  it("a USD-priced row is converted at the Bank of Canada rate, est. with its date; shares out are a withdrawal when answered so", () => {
    const usd = inKind(100, 50, { currency: "USD", securityCurrency: "USD" });
    const [item] = missing(computeTfsaRoom(input({ fx: boc, activities: [usd] })));
    expect(item).toMatchObject({ kind: "ambiguous", rows: [{ amountCad: 7000, estimated: true, rateDate: "2026-03-13", native: { amount: 5000, currency: "USD" } }] });
    const out = inKind(-100, 100);
    const withdrawn = known(computeTfsaRoom(input({ activities: [out], memory: { classifications: new Map([[out.activityKey, "withdrawal"]]) } })));
    expect(withdrawn).toMatchObject({ withdrawnCad: 10000, contributedCad: 0, returningCad: 10000 });
    // Shares out answered as a contribution contradicts the sign: still a question.
    expect(missing(computeTfsaRoom(input({ activities: [out], memory: { classifications: new Map([[out.activityKey, "contribution"]]) } })))[0]).toMatchObject({ kind: "ambiguous" });
  });
});

describe("computeTfsaRoom: transfers matched to the user's other accounts (auto-room A)", () => {
  const CASH = accountKey("synthetic-cash");
  const cash = "Synthetic Cash";
  type Counterpart = NonNullable<RoomInput["counterparts"]>[number];
  /** A transfer row in another of the user's accounts, as the loader passes it. */
  function cp(account: string, label: string, amount: number, tradeDate: string, extra: Partial<Counterpart> = {}): Counterpart {
    rowSeq += 1;
    return { accountKey: account, label, activityKey: activityKey(`synthetic-counterpart-${rowSeq}`), type: amount < 0 ? "INTERNAL_CASH_TRANSFER_OUT" : "INTERNAL_CASH_TRANSFER_IN", amount, currency: "CAD", tradeDate, ...extra };
  }
  const two = [
    { accountKey: MAIN, label: "Synthetic TFSA", bucket: "tfsa", neutral: false },
    { accountKey: SECOND, label: "Synthetic second TFSA", bucket: "tfsa", neutral: false },
  ];
  /** A TFSA's own transfer row, also passed as a counterpart (the loader reads transfers from every account). */
  const mirror = (row: Activity, label: string): Counterpart =>
    ({ accountKey: row.accountKey, label, activityKey: row.activityKey, type: row.type, amount: row.amount, currency: row.currency, tradeDate: row.tradeDate });
  const BASIS = (n: number) => `Matched ${n} ${n === 1 ? "transfer" : "transfers"} to your other accounts (same amount within 3 days)`;

  it("cash to TFSA is a contribution, carrying matchedWith and inferred to its ledger row", () => {
    const row = act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-05");
    const r = known(computeTfsaRoom(input({ activities: [row], counterparts: [cp(CASH, cash, -1000, "2026-03-04")] })));
    expect(r).toMatchObject({ contributedCad: 1000, roomLeftCad: 6000 });
    expect(r.ledger.rows[1]).toMatchObject({ kind: "contribution", activityKey: row.activityKey, amountCad: 1000, inferred: true, matchedWith: { label: cash, date: "2026-03-04" } });
    expect(r.basis).toContain(BASIS(1));
  });

  it("TFSA to TFSA in the set is none on both sides", () => {
    const out = act("INTERNAL_CASH_TRANSFER_OUT", -1000, "2026-03-05", { accountKey: SECOND });
    const into = act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-06");
    const r = known(computeTfsaRoom(input({
      accounts: two, memory: { accountSet: accountSet(2026, [MAIN, SECOND]) },
      activities: [out, into], counterparts: [mirror(out, "Synthetic second TFSA"), mirror(into, "Synthetic TFSA")],
    })));
    expect(r).toMatchObject({ contributedCad: 0, withdrawnCad: 0, roomLeftCad: 7000 });
    expect(r.ledger.rows.slice(1).map((x) => [x.kind, x.activityKey, x.matchedWith, x.inferred])).toEqual([
      ["none", out.activityKey, { label: "Synthetic TFSA", date: "2026-03-06" }, true],
      ["none", into.activityKey, { label: "Synthetic second TFSA", date: "2026-03-05" }, true],
    ]);
    expect(r.basis).toContain(BASIS(2));
  });

  /** Every ordering of a list. */
  const orderings = <T,>(items: T[]): T[][] => (items.length <= 1 ? [items] : items.flatMap((x, i) => orderings([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest])));

  it("a same-day TFSA1 -> Cash -> TFSA2 is a withdrawal plus a contribution, whatever the rows' order (A1)", () => {
    const day = "2026-03-05";
    const out = act("INTERNAL_CASH_TRANSFER_OUT", -5000, day);
    const into = act("INTERNAL_CASH_TRANSFER_IN", 5000, day, { accountKey: SECOND });
    const legs: Array<{ row?: Activity; cp: Counterpart }> = [
      { row: out, cp: mirror(out, "Synthetic TFSA") }, { row: into, cp: mirror(into, "Synthetic second TFSA") },
      { cp: cp(CASH, cash, 5000, day) }, { cp: cp(CASH, cash, -5000, day) },
    ];
    for (const ordering of orderings(legs)) {
      const r = known(computeTfsaRoom(input({
        accounts: two, memory: { accountSet: accountSet(2026, [MAIN, SECOND]) },
        activities: ordering.flatMap((l) => (l.row ? [l.row] : [])), counterparts: ordering.map((l) => l.cp),
      })));
      // CRA: money passing through a non-registered account is a withdrawal and a new contribution.
      expect(r, ordering.map((l) => l.cp.accountKey.slice(0, 6)).join(",")).toMatchObject({ contributedCad: 5000, withdrawnCad: 5000, roomLeftCad: 2000, returningCad: 5000 });
      expect(r.ledger.rows.slice(1).map((x) => [x.kind, x.matchedWith?.label]).sort()).toEqual([["contribution", cash], ["withdrawal", cash]]);
    }
  });

  it("a direct same-day TFSA1 -> TFSA2 with no Cash leg stays neutral in either order", () => {
    const day = "2026-03-05";
    const out = act("INTERNAL_CASH_TRANSFER_OUT", -5000, day, { accountKey: SECOND });
    const into = act("INTERNAL_CASH_TRANSFER_IN", 5000, day);
    for (const [activities, counterparts] of [[[out, into], [mirror(out, "Synthetic second TFSA"), mirror(into, "Synthetic TFSA")]], [[into, out], [mirror(into, "Synthetic TFSA"), mirror(out, "Synthetic second TFSA")]]] as const) {
      const r = known(computeTfsaRoom(input({ accounts: two, memory: { accountSet: accountSet(2026, [MAIN, SECOND]) }, activities: [...activities], counterparts: [...counterparts] })));
      expect(r).toMatchObject({ contributedCad: 0, withdrawnCad: 0, roomLeftCad: 7000 });
    }
  });

  it("a direct TFSA1 -> TFSA2 plus a same-day, same-size Cash -> TFSA1 is one contribution, whatever the rows' order (review 2)", () => {
    const day = "2026-03-05";
    const t1out = act("INTERNAL_CASH_TRANSFER_OUT", -5000, day);
    const t2in = act("INTERNAL_CASH_TRANSFER_IN", 5000, day, { accountKey: SECOND });
    const t1in = act("INTERNAL_CASH_TRANSFER_IN", 5000, day);
    const legs: Array<{ row?: Activity; cp: Counterpart }> = [
      { row: t1out, cp: mirror(t1out, "Synthetic TFSA") }, { row: t2in, cp: mirror(t2in, "Synthetic second TFSA") },
      { row: t1in, cp: mirror(t1in, "Synthetic TFSA") }, { cp: cp(CASH, cash, -5000, day) },
    ];
    for (const ordering of orderings(legs)) {
      const r = known(computeTfsaRoom(input({
        accounts: two, memory: { accountSet: accountSet(2026, [MAIN, SECOND]) },
        activities: ordering.flatMap((l) => (l.row ? [l.row] : [])), counterparts: ordering.map((l) => l.cp),
      })));
      // The only pairing of all four legs: Cash -> TFSA1 (a contribution) and TFSA1 -> TFSA2 (a move within the set).
      expect(r, ordering.map((l) => l.cp.accountKey.slice(0, 6)).join(",")).toMatchObject({ contributedCad: 5000, withdrawnCad: 0, roomLeftCad: 2000 });
      expect(r.ledger.rows.slice(1).map((x) => [x.kind, x.matchedWith?.label]).sort()).toEqual([["contribution", cash], ["none", "Synthetic TFSA"], ["none", "Synthetic second TFSA"]]);
    }
  });

  it("TFSA to cash is a withdrawal", () => {
    const row = act("INTERNAL_CASH_TRANSFER_OUT", -500, "2026-03-05");
    const r = known(computeTfsaRoom(input({ activities: [row], counterparts: [cp(CASH, cash, 500, "2026-03-05")] })));
    expect(r).toMatchObject({ withdrawnCad: 500, roomLeftCad: 7000 });
    expect(r.ledger.rows[1]).toMatchObject({ kind: "withdrawal", amountCad: -500, inferred: true, matchedWith: { label: cash, date: "2026-03-05" }, returnsOn: "2027-01-01" });
  });

  it("a 4-day gap, a cent's difference, a different currency, the same sign or the same account stay unmatched (and are assumed)", () => {
    const fx = { toCad: (amount: number) => ({ cad: amount * 1.35, estimated: true, rateDate: "2026-03-04" }) };
    const cases: Array<[Activity, Counterpart]> = [
      [act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-05"), cp(CASH, cash, -1000, "2026-03-01")],
      [act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-05"), cp(CASH, cash, -999.99, "2026-03-05")],
      [act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-05", { currency: "USD" }), cp(CASH, cash, -1000, "2026-03-05")],
      [act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-05"), cp(CASH, cash, 1000, "2026-03-05")],
      [act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-05"), cp(MAIN, "Synthetic TFSA", -1000, "2026-03-05")],
    ];
    for (const [row, counterpart] of cases) {
      const r = known(computeTfsaRoom(input({ fx, activities: [row], counterparts: [counterpart] })));
      expect(r.ledger.rows[1]).toMatchObject({ kind: "contribution", assumed: true });
      expect(r.ledger.rows[1]).not.toHaveProperty("matchedWith");
      expect(r.basis.some((b) => b.startsWith("Matched"))).toBe(false);
    }
    // Exactly 3 days apart still matches.
    expect(computeTfsaRoom(input({ activities: [act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-05")], counterparts: [cp(CASH, cash, -1000, "2026-03-02")] })).status).toBe("known");
  });

  it("two equal transfers pair one-to-one with the closest date; one with no counterpart left is assumed", () => {
    const first = act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-05");
    const second = act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-10");
    const r = known(computeTfsaRoom(input({ activities: [first, second], counterparts: [cp(CASH, cash, -1000, "2026-03-05"), cp(CASH, cash, -1000, "2026-03-09")] })));
    expect(r.ledger.rows.slice(1).map((x) => x.matchedWith)).toEqual([{ label: cash, date: "2026-03-05" }, { label: cash, date: "2026-03-09" }]);
    expect(r.contributedCad).toBe(2000);

    const third = act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-05");
    const fourth = act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-05");
    const k = known(computeTfsaRoom(input({ activities: [third, fourth], counterparts: [cp(CASH, cash, -1000, "2026-03-05")] })));
    expect(k.ledger.rows.slice(1).map((x) => [x.activityKey, x.inferred ?? false, x.assumed ?? false])).toEqual([[third.activityKey, true, false], [fourth.activityKey, false, true]]);
  });

  it("the closest date wins, and a tie goes to the earliest row", () => {
    const row = act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-05");
    const far = cp(CASH, "Synthetic far", -1000, "2026-03-02");
    const after = cp(CASH, "Synthetic after", -1000, "2026-03-06");
    const before = cp(CASH, "Synthetic before", -1000, "2026-03-04");
    const r = known(computeTfsaRoom(input({ activities: [row], counterparts: [far, after, before] })));
    expect(r.ledger.rows[1]!.matchedWith).toEqual({ label: "Synthetic before", date: "2026-03-04" });
  });

  it("a stored room_effect overrides a match", () => {
    const row = act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-05");
    const r = known(computeTfsaRoom(input({ activities: [row], counterparts: [cp(CASH, cash, -1000, "2026-03-04")], memory: { classifications: new Map([[row.activityKey, "none"]]) } })));
    expect(r).toMatchObject({ contributedCad: 0, roomLeftCad: 7000 });
    expect(r.ledger.rows[1]).toMatchObject({ kind: "none" });
    expect(r.ledger.rows[1]).not.toHaveProperty("inferred");
    expect(r.ledger.rows[1]).not.toHaveProperty("matchedWith");
    expect(r.basis.some((b) => b.startsWith("Matched"))).toBe(false);

    const out = act("INTERNAL_CASH_TRANSFER_OUT", -1000, "2026-03-05", { accountKey: SECOND });
    const into = act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-06");
    const both = computeTfsaRoom(input({
      accounts: two, memory: { accountSet: accountSet(2026, [MAIN, SECOND]), classifications: new Map([[into.activityKey, "contribution"]]) },
      activities: [out, into], counterparts: [mirror(out, "Synthetic second TFSA"), mirror(into, "Synthetic TFSA")],
    }));
    // A contribution answer on the incoming side releases the pair: the outgoing side is no longer "moved"; unmatched and
    // unanswered, it is assumed to give no room back (owner ruling 2026-10-26).
    expect(both.status).toBe("known");
    expect(both.ledger.rows.slice(1).map((x) => [x.kind, x.inferred ?? false, x.answered ?? false, x.assumed ?? false])).toEqual([["none", false, false, true], ["contribution", false, true, false]]);
    expect(both.basis.some((b) => b.startsWith("Matched"))).toBe(false);
  });

  it("a none answer on one side of a TFSA pair lets the other side keep its pairing", () => {
    const out = act("INTERNAL_CASH_TRANSFER_OUT", -1000, "2026-03-05", { accountKey: SECOND });
    const into = act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-06");
    const r = known(computeTfsaRoom(input({
      accounts: two, memory: { accountSet: accountSet(2026, [MAIN, SECOND]), classifications: new Map([[into.activityKey, "none"]]) },
      activities: [out, into], counterparts: [mirror(out, "Synthetic second TFSA"), mirror(into, "Synthetic TFSA")],
    })));
    expect(r.roomLeftCad).toBe(7000);
    expect(r.ledger.rows.slice(1).map((x) => [x.kind, x.inferred ?? false, x.answered ?? false])).toEqual([["none", true, false], ["none", false, true]]);
  });

  it("answered rows carry answered; automaticMatch says whether clearing the answer brings a match back", () => {
    const matchable = act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-05");
    const lonely = act("INTERNAL_CASH_TRANSFER_IN", 400, "2026-04-05");
    const r = known(computeTfsaRoom(input({
      activities: [matchable, lonely], counterparts: [cp(CASH, cash, -1000, "2026-03-04")],
      memory: { classifications: new Map([[matchable.activityKey, "none"], [lonely.activityKey, "contribution"]]) },
    })));
    expect(r.ledger.rows.slice(1).map((x) => [x.activityKey, x.answered, x.automaticMatch ?? false])).toEqual([
      [matchable.activityKey, true, true],
      [lonely.activityKey, true, false],
    ]);
    // A chat answer on a row the table already classifies takes effect but isn't editable on the dashboard (the route
    // takes transfers and unclear rows only), so it carries no answered flag.
    const buy = act("CONTRIBUTION", 300, "2026-05-05");
    const clear = known(computeTfsaRoom(input({ activities: [buy], memory: { classifications: new Map([[buy.activityKey, "none"]]) } })));
    expect(clear.ledger.rows[1]).toMatchObject({ kind: "contribution", amountCad: 300 });
    expect(clear.ledger.rows[1]).not.toHaveProperty("answered");
    // A USD row with no rate is unclear without its answer, so it is editable.
    const usd = act("CONTRIBUTION", 100, "2026-05-06", { currency: "USD" });
    const fx = known(computeTfsaRoom(input({ activities: [usd], memory: { classifications: new Map([[usd.activityKey, "none"]]) } })));
    expect(fx.ledger.rows[1]).toMatchObject({ kind: "none", answered: true });
    // An unanswered row never carries either.
    const plain = known(computeTfsaRoom(input({ activities: [act("CONTRIBUTION", 10, "2026-03-05")] })));
    expect(plain.ledger.rows[1]).not.toHaveProperty("answered");
    expect(plain.ledger.rows[1]).not.toHaveProperty("automaticMatch");
  });

  it("a stored withdrawal answer: an outgoing row is a withdrawal, releasing its TFSA pair; a positive one is ambiguous", () => {
    const out = act("INTERNAL_CASH_TRANSFER_OUT", -1000, "2026-03-05", { accountKey: SECOND });
    const into = act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-06");
    const r = computeTfsaRoom(input({
      accounts: two, memory: { accountSet: accountSet(2026, [MAIN, SECOND]), classifications: new Map([[out.activityKey, "withdrawal"]]) },
      activities: [out, into], counterparts: [mirror(out, "Synthetic second TFSA"), mirror(into, "Synthetic TFSA")],
    }));
    // A withdrawal answer on the outgoing side releases the pair: the incoming side is assumed a contribution.
    expect(r.status).toBe("known");
    expect(r.withdrawnCad).toBe(1000);
    expect(r.ledger.rows.slice(1).map((x) => [x.kind, x.inferred ?? false, x.answered ?? false, x.assumed ?? false])).toEqual([["withdrawal", false, true, false], ["contribution", false, false, true]]);
    expect(r.basis).toContain("You said the transfer out of $1,000 on 2026-03-05 (Synthetic second TFSA) was a withdrawal");

    // An answer that contradicts the row's direction still blocks: a stored answer is never replaced by the assumption.
    const positive = act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-05");
    const m = missing(computeTfsaRoom(input({ activities: [positive], memory: { classifications: new Map([[positive.activityKey, "withdrawal"]]) } })));
    expect(m).toEqual([expect.objectContaining({ kind: "ambiguous", count: 1 })]);
  });

  it("a matched contribution in a foreign currency with no rate stays ambiguous", () => {
    const row = act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-05", { currency: "USD" });
    const r = computeTfsaRoom(input({ activities: [row], counterparts: [cp(CASH, cash, -1000, "2026-03-05", { currency: "USD" })] }));
    expect(missing(r)).toEqual([expect.objectContaining({ kind: "ambiguous", count: 1 })]);
    expect(r.ledger.rows[1]).not.toHaveProperty("matchedWith");
  });

  it("a non-transfer row is never matched", () => {
    const row = act("CONTRIBUTION", 1000, "2026-03-05");
    const r = known(computeTfsaRoom(input({ activities: [row], counterparts: [cp(CASH, cash, -1000, "2026-03-05")] })));
    expect(r.ledger.rows[1]).not.toHaveProperty("matchedWith");
    expect(r.basis.some((b) => b.startsWith("Matched"))).toBe(false);
  });
});

describe("computeTfsaRoom: a completed backfill is the account's whole history (auto-room B)", () => {
  it("COVERS_FROM_START covers 1 January, so an account first funded after it is known", () => {
    const r = known(computeTfsaRoom(input({ coverage: new Map([[MAIN, { coversFrom: COVERS_FROM_START }]]), activities: [act("CONTRIBUTION", 1000, "2026-01-05")] })));
    expect(r.roomLeftCad).toBe(6000);
  });
});

describe("computeTfsaRoom: one rule for which rows take an answer (round 3)", () => {
  const CASH = accountKey("synthetic-cash-r3");
  const cpRow = (amount: number, tradeDate: string, currency = "CAD") => {
    rowSeq += 1;
    return { accountKey: CASH, label: "Synthetic Cash", activityKey: activityKey(`synthetic-cp-r3-${rowSeq}`), type: amount < 0 ? "INTERNAL_CASH_TRANSFER_OUT" : "INTERNAL_CASH_TRANSFER_IN", amount, currency, tradeDate };
  };

  it("answerable: unclear and transfer types, missing data, a sign mismatch, or no CAD value; never a classified row", () => {
    const usd = (type: string, amount: number) => act(type, amount, "2026-03-05", { currency: "USD" });
    expect([
      act("TRANSFER_IN", 10, "2026-03-05"), act("SOMETHING_NEW", 10, "2026-03-05"), act("CONTRIBUTION", null, "2026-03-05"), act("CONTRIBUTION", 10, null),
      act(null, 10, "2026-03-05"), act("CONTRIBUTION", -10, "2026-03-05"), usd("CONTRIBUTION", 10),
    ].map((r) => answerable(r, noFx))).toEqual([true, true, true, true, true, true, true]);
    expect([act("CONTRIBUTION", 10, "2026-03-05"), act("WITHDRAWAL", -10, "2026-03-05"), act("DIVIDEND", 5, "2026-03-05"), act("BUY", -5, "2026-03-05")]
      .map((r) => answerable(r, noFx))).toEqual([false, false, false, false]);
  });

  it("chat's contribution on a WITHDRAWAL and withdrawal on a DIVIDEND are ignored: table kinds, no queue, room known", () => {
    const w = act("WITHDRAWAL", -500, "2026-03-05");
    const d = act("DIVIDEND", 12, "2026-03-06");
    const r = known(computeTfsaRoom(input({ activities: [w, d], memory: { classifications: new Map([[w.activityKey, "contribution"], [d.activityKey, "withdrawal"]]) } })));
    expect(r).toMatchObject({ withdrawnCad: 500, contributedCad: 0, roomLeftCad: 7000 });
    expect(r.ledger.rows.slice(1).map((x) => [x.kind, x.activityKey, x.answered ?? false])).toEqual([["withdrawal", w.activityKey, false]]);
    expect(r.basis.some((b) => b.startsWith("You said"))).toBe(false);
  });

  it("automaticMatch only when clearing the answer brings back a matched, classified row", () => {
    const usd = act("INTERNAL_CASH_TRANSFER_IN", 1000, "2026-03-05", { currency: "USD" });
    const r = known(computeTfsaRoom(input({ activities: [usd], counterparts: [cpRow(-1000, "2026-03-05", "USD")], memory: { classifications: new Map([[usd.activityKey, "none"]]) } })));
    // The match would be a contribution with no CAD value: unclear again, not matched.
    expect(r.ledger.rows[1]).toMatchObject({ kind: "none", answered: true });
    expect(r.ledger.rows[1]).not.toHaveProperty("automaticMatch");
    const fx = { toCad: (amount: number) => ({ cad: amount * 1.35, estimated: true, rateDate: "2026-03-04" }) };
    const withRate = known(computeTfsaRoom(input({ fx, activities: [usd], counterparts: [cpRow(-1000, "2026-03-05", "USD")], memory: { classifications: new Map([[usd.activityKey, "none"]]) } })));
    expect(withRate.ledger.rows[1]).toMatchObject({ answered: true, automaticMatch: true });
  });

  it("before a stated figure's as-of date the engine and the route's rule agree on which rows are editable", () => {
    const coverage = new Map([[MAIN, { coversFrom: "2026-03-01" }]]);
    const transferOut = act("TRANSFER_OUT", -200, "2026-04-02");
    const withdrawal = act("WITHDRAWAL", -400, "2026-04-10");
    const r = known(computeTfsaRoom(input({
      coverage, activities: [transferOut, withdrawal],
      memory: { outside: [connectedYtd(MAIN, 2026, 3000, "stated", "2026-05-01")], classifications: new Map([[transferOut.activityKey, "withdrawal"], [withdrawal.activityKey, "none"]]) },
    })));
    // The transfer's answer applies (a withdrawal, editable); the chat "none" on the WITHDRAWAL is ignored (it still counts).
    expect(r.withdrawnCad).toBe(600);
    const rows = r.ledger.rows.filter((x) => x.activityKey !== undefined);
    expect(rows.map((x) => [x.activityKey, x.kind, x.answered ?? false])).toEqual([[transferOut.activityKey, "withdrawal", true], [withdrawal.activityKey, "withdrawal", false]]);
    // Every editable row is one the route accepts, and no other.
    for (const x of rows) expect(answerable([transferOut, withdrawal].find((a) => a.activityKey === x.activityKey)!, noFx)).toBe(x.answered === true);
  });
});

describe("computeTfsaRoom: the New Year check (owner ruling 2026-11-03)", () => {
  const jan = (over: Parameters<typeof input>[0] = {}) => input({
    today: "2027-01-15", now: "2027-01-15T16:00:00.000Z",
    sync: new Map([[MAIN, { lastSyncedAt: "2027-01-15T08:00:00.000Z", lastError: false, dirty: false }]]),
    memory: { craRoom: craRoom(2027, 7500), accountSet: accountSet(2027, [MAIN]) },
    ...over,
  });

  it("names last year's 27–31 December contributions without counting them this year", () => {
    const r = known(computeTfsaRoom(jan({
      activities: [act("CONTRIBUTION", 500, "2027-01-10")],
      priorDecember: [act("CONTRIBUTION", 180, "2026-12-29"), act("CONTRIBUTION", 300, "2026-12-26"), act("BUY", -180, "2026-12-29"), act("WITHDRAWAL", -50, "2026-12-30")],
    })));
    expect(r.roomLeftCad).toBe(7000);
    expect(r.newYear).toEqual([
      expect.objectContaining({ date: "2026-12-29", label: "Synthetic TFSA", amountCad: 180, countedIn: 2026, mayCountIn: 2027 }),
    ]);
  });

  it("names this year's 1 January and 27–31 December contributions as possibly the neighbouring year's", () => {
    const r = known(computeTfsaRoom(jan({
      today: "2027-12-30", now: "2027-12-30T16:00:00.000Z",
      sync: new Map([[MAIN, { lastSyncedAt: "2027-12-30T08:00:00.000Z", lastError: false, dirty: false }]]),
      activities: [act("CONTRIBUTION", 100, "2027-01-01"), act("CONTRIBUTION", 200, "2027-01-02"), act("CONTRIBUTION", 250, "2027-12-28")],
    })));
    expect(r.roomLeftCad).toBe(6950);
    expect(r.newYear).toEqual([
      expect.objectContaining({ date: "2027-01-01", amountCad: 100, countedIn: 2027, mayCountIn: 2026 }),
      expect.objectContaining({ date: "2027-12-28", amountCad: 250, countedIn: 2027, mayCountIn: 2028 }),
    ]);
  });

  it("leaves a transfer between the user's own TFSAs out (it uses no room in either year)", () => {
    const r = known(computeTfsaRoom(jan({
      accounts: [{ accountKey: MAIN, label: "Synthetic TFSA", bucket: "tfsa", neutral: false }, { accountKey: SECOND, label: "Second TFSA", bucket: "tfsa", neutral: false }],
      sync: new Map([MAIN, SECOND].map((k) => [k, { lastSyncedAt: "2027-01-15T08:00:00.000Z", lastError: false, dirty: false }])),
      memory: { craRoom: craRoom(2027, 7500), accountSet: accountSet(2027, [MAIN, SECOND]) },
      priorDecember: [act("INTERNAL_CASH_TRANSFER_IN", 400, "2026-12-29")],
      counterparts: [
        { accountKey: SECOND, label: "Second TFSA", activityKey: activityKey("synthetic-cp-1"), type: "INTERNAL_CASH_TRANSFER_OUT", amount: -400, currency: "CAD", tradeDate: "2026-12-29" },
      ],
    })));
    expect(r.newYear).toBeUndefined();
  });

  it("counts a transfer in from a non-TFSA account as a contribution to name", () => {
    const CASH = accountKey("synthetic-cash");
    const r = known(computeTfsaRoom(jan({
      connectedAccountKeys: [MAIN, CASH],
      priorDecember: [act("INTERNAL_CASH_TRANSFER_IN", 51.65, "2026-12-29")],
      counterparts: [
        { accountKey: CASH, label: "Synthetic cash", activityKey: activityKey("synthetic-cp-2"), type: "INTERNAL_CASH_TRANSFER_OUT", amount: -51.65, currency: "CAD", tradeDate: "2026-12-29" },
      ],
    })));
    expect(r.newYear).toEqual([expect.objectContaining({ date: "2026-12-29", amountCad: 51.65, countedIn: 2026, mayCountIn: 2027 })]);
  });

  it("is on a missing result too, and absent when nothing is near New Year", () => {
    const r = computeTfsaRoom(jan({ memory: { craRoom: null, accountSet: accountSet(2027, [MAIN]) }, priorDecember: [act("CONTRIBUTION", 180, "2026-12-31")] }));
    expect(r.status).toBe("missing");
    expect(r.newYear).toEqual([expect.objectContaining({ date: "2026-12-31", mayCountIn: 2027 })]);
    expect(computeTfsaRoom(jan({ activities: [act("CONTRIBUTION", 100, "2027-01-02")] })).newYear).toBeUndefined();
  });
});
