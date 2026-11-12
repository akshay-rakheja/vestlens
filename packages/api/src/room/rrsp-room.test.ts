import { describe, expect, it } from "vitest";

import { accountKey, activityKey } from "../memory/keys.js";
import type { MemoryFact, Provenance } from "../memory/memory-types.js";
import { RRSP_DEADLINES } from "./rrsp-calendar.js";
import {
  computeRrspRoom, RRSP_CRA_FACT, RRSP_DEDUCT_LATER, RRSP_ELSEWHERE_LABEL, RRSP_ELSEWHERE_QUESTION, RRSP_FHSA_NOTE, RRSP_HBP_LLP_BASIS, RRSP_LIMIT_PROMPT,
  RRSP_ROOM_LABEL, RRSP_SPOUSAL_BASIS, RRSP_UNUSED_QUESTION, type RrspRoomInput, type RrspRoomResult, type RrspYear,
} from "./rrsp-room.js";

// Synthetic ids, labels and amounts only.
const RRSP = accountKey("synthetic-rrsp-main");
const RRSP2 = accountKey("synthetic-rrsp-second");
const MANAGED = accountKey("synthetic-rrsp-managed");
const FHSA = accountKey("synthetic-fhsa");
const CASH = accountKey("synthetic-cash");

let seq = 0;
function fact(key: string, property: string, amountCad: number, provenance: Provenance = "stated"): MemoryFact {
  seq += 1;
  return {
    id: `synthetic-fact-${seq}`, subject: "subject|synthetic-rrsp", node: { type: "tax_year", key }, property, value: { amountCad }, text: "Synthetic.",
    kind: "fact", provenance, validFrom: null, validTo: null, recordedAt: new Date(Date.UTC(2026, 0, 1) + seq * 60_000), source: "claude", supersededAt: null,
  };
}
const limit = (year: number, amountCad: number, provenance: Provenance = "stated") => fact(`${year}:rrsp`, "tax_year.rrsp_deduction_limit", amountCad, provenance);
const unused = (year: number, amountCad: number) => fact(`${year}:rrsp`, "tax_year.rrsp_unused_contributions", amountCad);
const elsewhere = (year: number, amountCad: number) => fact(`${year}:rrsp`, "tax_year.rrsp_elsewhere", amountCad);
type YearFacts = { limit?: MemoryFact | null; unused?: MemoryFact | null; elsewhere?: MemoryFact | null };
/** The three figures room left needs, unused and elsewhere 0 unless given (0 counts as stated). */
const figures = (year: number, limitCad: number, unusedCad = 0, elsewhereCad = 0): YearFacts =>
  ({ limit: limit(year, limitCad), unused: unused(year, unusedCad), elsewhere: elsewhere(year, elsewhereCad) });
const byYear = (entries: Record<number, YearFacts>) =>
  new Map(Object.entries(entries).map(([y, f]) => [Number(y), { limit: f.limit ?? null, unused: f.unused ?? null, elsewhere: f.elsewhere ?? null }]));

type Activity = RrspRoomInput["activities"][number];
let rowSeq = 0;
function act(type: string | null, amount: number | null, tradeDate: string | null, extra: Partial<Activity> = {}): Activity {
  rowSeq += 1;
  return { accountKey: RRSP, activityKey: activityKey(`synthetic-rrsp-dedupe-${rowSeq}`), type, amount, currency: "CAD", fxRate: null, tradeDate, ...extra };
}
const counterpart = (key: string, label: string, type: string, amount: number, tradeDate: string) => {
  rowSeq += 1;
  return { accountKey: key, label, activityKey: activityKey(`synthetic-rrsp-cp-${rowSeq}`), type, amount, currency: "CAD", tradeDate };
};

type Account = RrspRoomInput["accounts"][number];
const MAIN: Account = { accountKey: RRSP, label: "Synthetic RRSP", bucket: "rrsp", managed: false };
const SECOND: Account = { accountKey: RRSP2, label: "Second RRSP", bucket: "rrsp", managed: false };
const MANAGED_RRSP: Account = { accountKey: MANAGED, label: "Managed RRSP", bucket: "rrsp", managed: true };

const fresh = (now: string) => {
  const at = Date.parse(now);
  return { lastSyncedAt: Number.isFinite(at) ? new Date(at - 8 * 3_600_000).toISOString() : null, lastError: false, dirty: false };
};

function input(over: Partial<Omit<RrspRoomInput, "memory">> & { memory?: Partial<RrspRoomInput["memory"]> } = {}): RrspRoomInput {
  const { memory, ...rest } = over;
  const now = rest.now ?? "2026-10-29T16:00:00.000Z";
  return {
    today: "2026-10-29",
    now,
    accounts: [MAIN],
    fhsaAccountKeys: [FHSA],
    activities: [],
    coverage: new Map([[RRSP, { coversFrom: "0001-01-01" }], [RRSP2, { coversFrom: "0001-01-01" }]]),
    sync: new Map([[RRSP, fresh(now)], [RRSP2, fresh(now)]]),
    fx: { toCad: () => null },
    ...rest,
    memory: { byYear: new Map(), classifications: new Map(), ...memory },
  };
}
function shown(r: RrspRoomResult) {
  if (r.status !== "shown") throw new Error(`expected shown, got ${JSON.stringify(r)}`);
  return r;
}
const only = (r: RrspRoomResult): RrspYear => {
  const s = shown(r);
  expect(s.years).toHaveLength(1);
  return s.years[0]!;
};
const DEPOSITS = () => [act("CONTRIBUTION", 1000, "2026-03-02"), act("CONTRIBUTION", 2000, "2026-03-03"), act("CONTRIBUTION", 500, "2026-09-01")];

describe("computeRrspRoom", () => {
  it("the fixed copy, verbatim", () => {
    expect(RRSP_LIMIT_PROMPT).toBe("Enter your RRSP deduction limit from CRA My Account or your notice of assessment to see room left.");
    expect(RRSP_DEDUCT_LATER).toBe("Unused contributions can be deducted in a later year; VestLens doesn't choose the year for you.");
    expect(RRSP_CRA_FACT).toBe("CRA charges 1% a month on contributions more than $2,000 over your RRSP deduction limit. Check your figures in CRA My Account.");
    expect(RRSP_FHSA_NOTE).toBe("transfer from your FHSA; doesn't use RRSP room");
    expect(RRSP_ELSEWHERE_LABEL).toBe("Contributions not in VestLens (you entered)");
    expect(RRSP_HBP_LLP_BASIS).toBe("VestLens counts Home Buyers' Plan and Lifelong Learning Plan repayments as contributions");
    expect(RRSP_UNUSED_QUESTION(2026)).toBe("What unused RRSP contributions does CRA show for 2026? It's next to your deduction limit on your notice of assessment and in CRA My Account; enter 0 if there are none.");
    expect(RRSP_ELSEWHERE_QUESTION(2026)).toBe("Did you contribute to an RRSP VestLens doesn't see for the 2026 tax year, such as a group RRSP at work, an account at another institution, or a spousal RRSP for your spouse? Enter the total, or 0 if none.");
    expect(RRSP_SPOUSAL_BASIS).toBe("A contribution to a spousal RRSP counts against the limit of the spouse who made it");
  });

  it("no account in the rrsp bucket: status none", () => {
    expect(computeRrspRoom(input({ accounts: [{ accountKey: CASH, label: "Cash", bucket: "money_market", managed: false }] }))).toEqual({ status: "none" });
    expect(computeRrspRoom(input({ accounts: [] }))).toEqual({ status: "none" });
  });

  it("today 2026-10-29: one year, 2026, from 2026-03-03; the deadline-day deposit belongs to 2025", () => {
    const y = only(computeRrspRoom(input({ activities: DEPOSITS() })));
    expect(y.window).toEqual({ taxYear: 2026, from: "2026-03-03", to: RRSP_DEADLINES[2026] ?? null });
    expect(y.contributedCad).toBe(2500);
    expect(y.ledger.rows.filter((r) => r.kind === "contribution").map((r) => r.date)).toEqual(["2026-03-03", "2026-09-01"]);
  });

  it("no limit fact: contributions only, no room left or over line, the deduct-later line always", () => {
    const y = only(computeRrspRoom(input({ activities: DEPOSITS() })));
    expect(y).toMatchObject({ contributedCad: 2500, limitCad: null, unusedCad: null, elsewhereCad: null, roomLeftCad: null, overLimitCad: null });
    expect(y.missing).toEqual([{ kind: "deduction_limit" }]);
    expect(y.basis).toContain(RRSP_DEDUCT_LATER);
    expect(y.basis).not.toContain(RRSP_CRA_FACT);
    expect(y.ledger.rows[0]).toMatchObject({ kind: "cra_room", label: RRSP_ROOM_LABEL, date: "2026-03-03", amountCad: null, roomLeftCad: null });
  });

  it("the window line names CRA's deadline, or that it isn't published yet", () => {
    const y = only(computeRrspRoom(input()));
    expect(y.basis[0]).toBe(`Contributions for 2026: 2026-03-03 to ${RRSP_DEADLINES[2026] ?? "CRA's deadline (not yet published)"}`);
  });

  it("limit 10000, unused 1500, elsewhere 1000: room left 5000, not over", () => {
    const y = only(computeRrspRoom(input({
      activities: DEPOSITS(),
      memory: { byYear: byYear({ 2026: { limit: limit(2026, 10000), unused: unused(2026, 1500), elsewhere: elsewhere(2026, 1000) } }) },
    })));
    expect(y).toMatchObject({ contributedCad: 2500, limitCad: 10000, unusedCad: 1500, elsewhereCad: 1000, roomLeftCad: 5000, overLimitCad: 0, missing: [] });
    expect(y.basis).not.toContain(RRSP_CRA_FACT);
    expect(y.basis).toContain("RRSP deduction limit for 2026: $10,000 (you said)");
    expect(y.basis).toContain("Unused RRSP contributions for 2026: $1,500 (you said)");
    expect(y.basis).toContain("Contributions not in VestLens for 2026: $1,000 (you said)");
    expect(y.ledger.rows[0]).toMatchObject({ kind: "cra_room", label: RRSP_ROOM_LABEL, amountCad: 8500, roomLeftCad: 8500 });
    expect(y.ledger.rows.find((r) => r.kind === "outside_total")).toMatchObject({ date: "2026-03-03", label: RRSP_ELSEWHERE_LABEL, amountCad: 1000 });
    expect(y.ledger.rows.at(-1)).toMatchObject({ roomLeftCad: 5000, excessCad: 0 });
  });

  it("limit 2000, unused 0, elsewhere 0: room left 0, over by 500, with CRA's fact", () => {
    const y = only(computeRrspRoom(input({ activities: DEPOSITS(), memory: { byYear: byYear({ 2026: figures(2026, 2000) }) } })));
    expect(y).toMatchObject({ roomLeftCad: 0, overLimitCad: 500, missing: [] });
    expect(y.basis).toContain(RRSP_CRA_FACT);
    expect(y.ledger.overSince).toBe("2026-09-01");
  });

  it("a withdrawal never raises room left or lowers the amount over", () => {
    const y = only(computeRrspRoom(input({
      activities: [...DEPOSITS(), act("WITHDRAWAL", -1000, "2026-10-01")], memory: { byYear: byYear({ 2026: figures(2026, 2000) }) },
    })));
    expect(y).toMatchObject({ contributedCad: 2500, roomLeftCad: 0, overLimitCad: 500 });
  });

  it("unused contributions above the limit open over", () => {
    const y = only(computeRrspRoom(input({ activities: [act("CONTRIBUTION", 200, "2026-04-01")], memory: { byYear: byYear({ 2026: figures(2026, 1000, 1500) }) } })));
    expect(y).toMatchObject({ roomLeftCad: 0, overLimitCad: 700 });
    expect(y.ledger.overSince).toBe("2026-03-03");
    expect(y.basis).toContain(RRSP_CRA_FACT);
  });

  describe("room left needs all three figures (R11)", () => {
    it("limit only: no room left or amount over, both figures asked, contributions still show", () => {
      const y = only(computeRrspRoom(input({ activities: DEPOSITS(), memory: { byYear: byYear({ 2026: { limit: limit(2026, 2000) } }) } })));
      expect(y).toMatchObject({ contributedCad: 2500, limitCad: 2000, roomLeftCad: null, overLimitCad: null });
      expect(y.missing).toEqual([{ kind: "unused_contributions" }, { kind: "elsewhere" }]);
      // Over the limit by the figures entered so far, but no over line until all three are stated.
      expect(y.basis).not.toContain(RRSP_CRA_FACT);
      expect(y.ledger.overSince).toBeNull();
      expect(y.ledger.rows.every((r) => r.roomLeftCad === null && (r.excessCad ?? null) === null)).toBe(true);
    });

    it("limit, unused 0 and elsewhere 0: room left (0 counts as stated)", () => {
      const y = only(computeRrspRoom(input({ activities: DEPOSITS(), memory: { byYear: byYear({ 2026: figures(2026, 10000) }) } })));
      expect(y).toMatchObject({ contributedCad: 2500, limitCad: 10000, unusedCad: 0, elsewhereCad: 0, roomLeftCad: 7500, overLimitCad: 0, missing: [] });
      expect(y.ledger.rows[0]).toMatchObject({ kind: "cra_room", amountCad: 10000, roomLeftCad: 10000 });
    });

    it("limit and unused but no elsewhere: still no room left, elsewhere asked", () => {
      const y = only(computeRrspRoom(input({
        activities: DEPOSITS(), memory: { byYear: byYear({ 2026: { limit: limit(2026, 10000), unused: unused(2026, 0) } }) },
      })));
      expect(y).toMatchObject({ contributedCad: 2500, roomLeftCad: null, overLimitCad: null, missing: [{ kind: "elsewhere" }] });
      expect(y.ledger.rows.every((r) => r.roomLeftCad === null)).toBe(true);
    });

    it("limit and elsewhere but no unused: still no room left, unused asked", () => {
      const y = only(computeRrspRoom(input({
        activities: DEPOSITS(), memory: { byYear: byYear({ 2026: { limit: limit(2026, 10000), elsewhere: elsewhere(2026, 0) } }) },
      })));
      expect(y).toMatchObject({ roomLeftCad: null, overLimitCad: null, missing: [{ kind: "unused_contributions" }] });
    });

    it("no limit: the limit alone is asked, even with unused and elsewhere entered", () => {
      const y = only(computeRrspRoom(input({ memory: { byYear: byYear({ 2026: { unused: unused(2026, 0), elsewhere: elsewhere(2026, 0) } }) } })));
      expect(y.missing).toEqual([{ kind: "deduction_limit" }]);
      expect(only(computeRrspRoom(input())).missing).toEqual([{ kind: "deduction_limit" }]);
    });

    it("with a managed RRSP: managed_rrsp asks for elsewhere, never both; entering elsewhere clears it", () => {
      const accounts = [MAIN, MANAGED_RRSP];
      const y = only(computeRrspRoom(input({ accounts, memory: { byYear: byYear({ 2026: { limit: limit(2026, 10000) } }) } })));
      expect(y.missing).toEqual([{ kind: "unused_contributions" }, { kind: "managed_rrsp", labels: ["Managed RRSP"] }]);
      const managedOnly = only(computeRrspRoom(input({ accounts, memory: { byYear: byYear({ 2026: { limit: limit(2026, 10000), unused: unused(2026, 0) } }) } })));
      expect(managedOnly.missing).toEqual([{ kind: "managed_rrsp", labels: ["Managed RRSP"] }]);
      const cleared = only(computeRrspRoom(input({ accounts, memory: { byYear: byYear({ 2026: figures(2026, 10000) }) } })));
      expect(cleared).toMatchObject({ missing: [], roomLeftCad: 10000 });
    });

    it("the figures come right after the limit, before a coverage gap", () => {
      const y = only(computeRrspRoom(input({
        coverage: new Map([[RRSP, { coversFrom: null }]]), memory: { byYear: byYear({ 2026: { limit: limit(2026, 10000) } }) },
      })));
      expect(y.missing.map((m) => m.kind)).toEqual(["unused_contributions", "elsewhere", "coverage"]);
    });
  });

  it("an inferred or derived limit, or one on another key, doesn't count", () => {
    for (const l of [limit(2026, 5000, "inferred"), limit(2026, 5000, "derived"), limit(2025, 5000)]) {
      const y = only(computeRrspRoom(input({ memory: { byYear: byYear({ 2026: { limit: l } }) } })));
      expect(y.limitCad).toBeNull();
      expect(y.missing).toEqual([{ kind: "deduction_limit" }]);
    }
    const imported = only(computeRrspRoom(input({ memory: { byYear: byYear({ 2026: { limit: limit(2026, 5000, "imported") } }) } })));
    expect(imported.limitCad).toBe(5000);
    expect(imported.basis).toContain("RRSP deduction limit for 2026: $5,000 (imported)");
  });

  describe("today 2026-02-10", () => {
    const FEB = { today: "2026-02-10", now: "2026-02-10T16:00:00.000Z" };

    it("years [2025, 2026]; the 2025 window counts a 2026-01-20 deposit", () => {
      const r = shown(computeRrspRoom(input({ ...FEB, activities: [act("CONTRIBUTION", 300, "2025-03-03"), act("CONTRIBUTION", 700, "2025-03-04"), act("CONTRIBUTION", 1200, "2026-01-20")] })));
      expect(r.years.map((y) => y.window.taxYear)).toEqual([2025, 2026]);
      expect(r.years[0]!.window).toEqual({ taxYear: 2025, from: "2025-03-04", to: "2026-03-02" });
      expect(r.years[0]!.contributedCad).toBe(1900);
      expect(r.years[1]!.contributedCad).toBe(0);
      expect(r.years[0]!.basis[0]).toBe("Contributions for 2025: 2025-03-04 to 2026-03-02");
    });

    it("a limit saved on 2026:rrsp doesn't feed the 2025 year (Review Focus 5)", () => {
      const r = shown(computeRrspRoom(input({ ...FEB, memory: { byYear: byYear({ 2026: figures(2026, 7000) }) } })));
      expect(r.years[0]).toMatchObject({ limitCad: null, roomLeftCad: null, missing: [{ kind: "deduction_limit" }] });
      expect(r.years[1]).toMatchObject({ limitCad: 7000, roomLeftCad: 7000 });
      // Even placed in 2025's slot, a 2026 fact is not 2025's.
      const misplaced = shown(computeRrspRoom(input({ ...FEB, memory: { byYear: byYear({ 2025: { limit: limit(2026, 7000), elsewhere: elsewhere(2026, 100) } }) } })));
      expect(misplaced.years[0]).toMatchObject({ limitCad: null, elsewhereCad: null });
    });
  });

  describe("matched transfers", () => {
    it("from Cash into the RRSP: a contribution", () => {
      const y = only(computeRrspRoom(input({
        accounts: [MAIN, { accountKey: CASH, label: "Synthetic cash", bucket: "money_market", managed: false }],
        activities: [act("TRANSFER_IN", 3000, "2026-04-02")], counterparts: [counterpart(CASH, "Synthetic cash", "TRANSFER_OUT", -3000, "2026-04-01")],
      })));
      expect(y.contributedCad).toBe(3000);
      expect(y.ledger.rows[1]).toMatchObject({ kind: "contribution", inferred: true, matchedWith: { label: "Synthetic cash", date: "2026-04-01" } });
      expect(y.ledger.rows[1]!.note).toBeUndefined();
    });

    it("RRSP to RRSP: none on both sides", () => {
      const out = act("TRANSFER_OUT", -1500, "2026-05-01");
      const into = act("TRANSFER_IN", 1500, "2026-05-01", { accountKey: RRSP2 });
      const y = only(computeRrspRoom(input({
        accounts: [MAIN, SECOND], activities: [out, into], counterparts: [{ ...out, label: "Synthetic RRSP" }, { ...into, label: "Second RRSP" }],
        memory: { byYear: byYear({ 2026: figures(2026, 5000) }) },
      })));
      expect(y).toMatchObject({ contributedCad: 0, roomLeftCad: 5000 });
      // The opening row, the entered "not in VestLens" figure (0), then both sides of the move.
      expect(y.ledger.rows.map((r) => r.kind)).toEqual(["cra_room", "outside_total", "none", "none"]);
    });

    it("from a managed RRSP into a counted RRSP: none, no note (moves between the user's own RRSPs are netted)", () => {
      const into = act("TRANSFER_IN", 2500, "2026-06-02");
      const y = only(computeRrspRoom(input({
        accounts: [MAIN, MANAGED_RRSP], activities: [into], counterparts: [counterpart(MANAGED, "Managed RRSP", "TRANSFER_OUT", -2500, "2026-06-01")],
        memory: { byYear: byYear({ 2026: figures(2026, 5000) }) },
      })));
      expect(y).toMatchObject({ contributedCad: 0, roomLeftCad: 5000 });
      const row = y.ledger.rows.find((r) => r.activityKey === into.activityKey)!;
      expect(row).toMatchObject({ kind: "none", inferred: true, matchedWith: { label: "Managed RRSP", date: "2026-06-01" } });
      expect(row.note).toBeUndefined();
    });

    it("from an FHSA into the RRSP: none, with its note; out to an FHSA: none, no note", () => {
      const into = act("TRANSFER_IN", 2000, "2026-06-02");
      const out = act("TRANSFER_OUT", -400, "2026-07-02");
      const y = only(computeRrspRoom(input({
        activities: [into, out],
        counterparts: [counterpart(FHSA, "Synthetic FHSA", "TRANSFER_OUT", -2000, "2026-06-01"), counterpart(FHSA, "Synthetic FHSA", "TRANSFER_IN", 400, "2026-07-02")],
        memory: { byYear: byYear({ 2026: figures(2026, 5000) }) },
      })));
      expect(y).toMatchObject({ contributedCad: 0, roomLeftCad: 5000 });
      expect(y.ledger.rows.find((r) => r.activityKey === into.activityKey)).toMatchObject({ kind: "none", inferred: true, note: RRSP_FHSA_NOTE });
      const outRow = y.ledger.rows.find((r) => r.activityKey === out.activityKey)!;
      expect(outRow).toMatchObject({ kind: "none", inferred: true });
      expect(outRow.note).toBeUndefined();
    });
  });

  describe("managed RRSPs", () => {
    it("a connected managed RRSP with a limit but no elsewhere: no room left, the managed item; entering elsewhere clears it", () => {
      const accounts = [MAIN, MANAGED_RRSP];
      const y = only(computeRrspRoom(input({ accounts, activities: DEPOSITS(), memory: { byYear: byYear({ 2026: { limit: limit(2026, 10000), unused: unused(2026, 0) } }) } })));
      expect(y).toMatchObject({ contributedCad: 2500, roomLeftCad: null, overLimitCad: null });
      expect(y.missing).toContainEqual({ kind: "managed_rrsp", labels: ["Managed RRSP"] });
      expect(y.ledger.rows.at(-1)!.roomLeftCad).toBeNull();

      const cleared = only(computeRrspRoom(input({
        accounts, activities: DEPOSITS(), memory: { byYear: byYear({ 2026: figures(2026, 10000, 0, 1000) }) },
      })));
      expect(cleared).toMatchObject({ missing: [], roomLeftCad: 6500, overLimitCad: 0 });
    });

    it("a managed RRSP's rows are never counted and it isn't gated on freshness or coverage", () => {
      const y = only(computeRrspRoom(input({
        accounts: [MAIN, MANAGED_RRSP], activities: [act("CONTRIBUTION", 900, "2026-04-01", { accountKey: MANAGED })],
        memory: { byYear: byYear({ 2026: figures(2026, 10000) }) },
      })));
      expect(y).toMatchObject({ contributedCad: 0, missing: [], roomLeftCad: 10000 });
    });

    it("a closed managed RRSP still raises the managed item (it may have taken contributions before it closed); elsewhere 0 clears it", () => {
      const accounts = [MAIN, { ...MANAGED_RRSP, closed: true }];
      const y = only(computeRrspRoom(input({ accounts, memory: { byYear: byYear({ 2026: { limit: limit(2026, 10000), unused: unused(2026, 0) } }) } })));
      expect(y).toMatchObject({ roomLeftCad: null, overLimitCad: null, missing: [{ kind: "managed_rrsp", labels: ["Managed RRSP"] }] });
      const cleared = only(computeRrspRoom(input({ accounts, memory: { byYear: byYear({ 2026: figures(2026, 10000) }) } })));
      expect(cleared).toMatchObject({ missing: [], roomLeftCad: 10000, overLimitCad: 0 });
    });

    it("each year asks for its own elsewhere figure: 2026's doesn't clear the managed item for 2025", () => {
      const r = shown(computeRrspRoom(input({
        today: "2026-02-10", now: "2026-02-10T16:00:00.000Z", accounts: [MAIN, { ...MANAGED_RRSP, closed: true }],
        memory: { byYear: byYear({ 2025: { limit: limit(2025, 5000), unused: unused(2025, 0) }, 2026: figures(2026, 5000) }) },
      })));
      expect(r.years[0]!.missing).toEqual([{ kind: "managed_rrsp", labels: ["Managed RRSP"] }]);
      expect(r.years[1]!.missing).toEqual([]);
    });

    it("only managed RRSPs: shown, nothing counted, no spousal line", () => {
      const y = only(computeRrspRoom(input({ accounts: [MANAGED_RRSP] })));
      expect(y.contributedCad).toBe(0);
      expect(y.missing.map((m) => m.kind)).toEqual(["deduction_limit", "managed_rrsp"]);
      expect(y.basis).not.toContain(RRSP_SPOUSAL_BASIS);
      expect(y.basis).toContain(RRSP_DEDUCT_LATER);
      expect(only(computeRrspRoom(input())).basis).toContain(RRSP_SPOUSAL_BASIS);
    });
  });

  describe("CAD conversion (Review Focus 4)", () => {
    it("a USD deposit with a Bank of Canada rate is est., with its rate date", () => {
      const y = only(computeRrspRoom(input({
        fx: { toCad: (amount) => ({ cad: amount * 1.35, estimated: true, rateDate: "2026-04-01" }) },
        activities: [act("CONTRIBUTION", 1000, "2026-04-02", { currency: "USD" })], memory: { byYear: byYear({ 2026: figures(2026, 5000) }) },
      })));
      expect(y).toMatchObject({ contributedCad: 1350, estimated: true, roomLeftCad: 3650 });
      expect(y.fx.contributions).toEqual({ estimated: true, rateDates: ["2026-04-01"], native: [{ amount: 1000, currency: "USD" }] });
      expect(y.fxDates).toEqual(["2026-04-01"]);
    });

    it("with no rate: an unclear row, never zero; contributions withheld", () => {
      const y = only(computeRrspRoom(input({
        activities: [act("CONTRIBUTION", 500, "2026-04-01"), act("CONTRIBUTION", 1000, "2026-04-02", { currency: "USD" })],
        memory: { byYear: byYear({ 2026: figures(2026, 5000) }) },
      })));
      expect(y).toMatchObject({ contributedCad: null, roomLeftCad: null, overLimitCad: null });
      expect(y.missing).toEqual([expect.objectContaining({ kind: "ambiguous", count: 1 })]);
    });
  });

  describe("gates", () => {
    it("an RRSP without a completed backfill: a coverage item, contributions withheld", () => {
      const y = only(computeRrspRoom(input({
        coverage: new Map([[RRSP, { coversFrom: null }]]), activities: DEPOSITS(), memory: { byYear: byYear({ 2026: figures(2026, 10000) }) },
      })));
      expect(y).toMatchObject({ contributedCad: null, roomLeftCad: null });
      expect(y.missing).toEqual([{ kind: "coverage", label: "Synthetic RRSP", accountKey: RRSP }]);
      expect(y.ledger.rows.slice(1).every((r) => r.roomLeftCad === null)).toBe(true);
    });

    it("coverage must reach the window's start", () => {
      const late = only(computeRrspRoom(input({ coverage: new Map([[RRSP, { coversFrom: "2026-03-04" }]]) })));
      expect(late.missing.map((m) => m.kind)).toEqual(["deduction_limit", "coverage"]);
      const exact = only(computeRrspRoom(input({ coverage: new Map([[RRSP, { coversFrom: "2026-03-03" }]]) })));
      expect(exact.missing.map((m) => m.kind)).toEqual(["deduction_limit"]);
    });

    it("stale activity (7 days) withholds contributions; ignoreFreshness skips the gate", () => {
      const stale = new Map([[RRSP, { lastSyncedAt: "2026-10-10T08:00:00.000Z", lastError: false, dirty: false }]]);
      const y = only(computeRrspRoom(input({ sync: stale, activities: DEPOSITS(), memory: { byYear: byYear({ 2026: figures(2026, 10000) }) } })));
      expect(y).toMatchObject({ contributedCad: null, roomLeftCad: null });
      expect(y.missing.map((m) => m.kind)).toEqual(["stale_activity"]);
      const ignored = only(computeRrspRoom(input({ sync: stale, activities: DEPOSITS(), memory: { byYear: byYear({ 2026: figures(2026, 10000) }) } }), { ignoreFreshness: true }));
      expect(ignored).toMatchObject({ contributedCad: 2500, roomLeftCad: 7500 });
    });

    it("activityAsOf is the oldest fresh sync", () => {
      const r = shown(computeRrspRoom(input()));
      expect(r.activityAsOf).toBe("2026-10-29T08:00:00.000Z");
    });
  });

  it("the HBP/LLP line and the deduct-later line are in every year's basis", () => {
    const r = shown(computeRrspRoom(input({ today: "2026-02-10", now: "2026-02-10T16:00:00.000Z" })));
    for (const y of r.years) {
      expect(y.basis).toContain(RRSP_HBP_LLP_BASIS);
      expect(y.basis.filter((b) => b === RRSP_DEDUCT_LATER)).toHaveLength(1);
    }
  });

  it("no advice words in any basis line or note", () => {
    const y = only(computeRrspRoom(input({
      activities: [...DEPOSITS(), act("TRANSFER_IN", 100, "2026-04-02")],
      counterparts: [counterpart(FHSA, "Synthetic FHSA", "TRANSFER_OUT", -100, "2026-04-02")],
      memory: { byYear: byYear({ 2026: { limit: limit(2026, 2000), unused: unused(2026, 100), elsewhere: elsewhere(2026, 50) } }) },
    })));
    const text = [...y.basis, ...y.ledger.rows.map((x) => x.note ?? "")].join(" ").toLowerCase();
    for (const word of ["should", "consider", "you can contribute", "we recommend"]) expect(text).not.toContain(word);
  });

  it("rejects a today that isn't a calendar date or a now that isn't an instant", () => {
    expect(() => computeRrspRoom(input({ today: "2026-13-01" }))).toThrow();
    expect(() => computeRrspRoom(input({ now: "not-a-time" }))).toThrow();
  });
});
