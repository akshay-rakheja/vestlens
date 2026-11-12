import { describe, expect, it } from "vitest";

import { buildFhsaLedger, buildLedger, buildRrspLedger, CRA_ROOM_LABEL, type LedgerMove } from "./tfsa-ledger.js";

// Synthetic labels and amounts only.
const move = (kind: LedgerMove["kind"], amountCad: number | null, date: string | null, over: Partial<LedgerMove> = {}): LedgerMove => ({
  date, kind, label: "Synthetic TFSA", amountCad, estimated: false, rateDate: null, native: null, ...over,
});
const dep = (amount: number, date: string, over: Partial<LedgerMove> = {}) => move("contribution", amount, date, over);
const wd = (amount: number, date: string, over: Partial<LedgerMove> = {}) => move("withdrawal", -amount, date, over);

describe("buildLedger: running room and excess (spec §5)", () => {
  it("owner case: a withdrawal while not over adds no room this year", () => {
    const l = buildLedger(7000, 2026, [dep(6000, "2026-01-10"), wd(5000, "2026-02-03"), dep(5000, "2026-03-14")]);
    expect(l.rows.map((r) => r.roomLeftCad)).toEqual([7000, 1000, 1000, -4000]);
    expect(l.rows.map((r) => r.excessCad)).toEqual([0, 0, 0, 4000]);
    expect(l.overSince).toBe("2026-03-14");
    expect(l.undatedExcess).toBe(false);
    expect(l.rows.find((r) => r.date === "2026-03-14")!.wentOver).toBe(true);
    expect(l.rows.filter((r) => r.wentOver)).toHaveLength(1);
    expect(l.rows.find((r) => r.kind === "withdrawal")!.returnsOn).toBe("2027-01-01");
    expect(l.rows[0]).toMatchObject({ kind: "cra_room", date: "2026-01-01", label: CRA_ROOM_LABEL, amountCad: 7000 });
    expect(l.rows.map((r) => r.amountCad)).toEqual([7000, 6000, -5000, 5000]);
  });

  it("qualifying withdrawal reduces excess", () => {
    const l = buildLedger(5000, 2026, [dep(7000, "2026-01-05"), wd(2000, "2026-02-01"), dep(1000, "2026-03-01")]);
    expect(l.rows.map((r) => r.excessCad)).toEqual([0, 2000, 0, 1000]);
    expect(l.rows.map((r) => r.roomLeftCad)).toEqual([5000, -2000, 0, -1000]);
    expect(l.rows.map((r) => r.wentOver)).toEqual([false, true, false, true]);
    expect(l.overSince).toBe("2026-03-01");
  });

  it("a withdrawal larger than the excess removes it but creates no room", () => {
    const l = buildLedger(5000, 2026, [dep(7000, "2026-01-05"), wd(3000, "2026-02-01")]);
    expect(l.rows.map((r) => r.roomLeftCad)).toEqual([5000, -2000, 0]);
    expect(l.overSince).toBeNull();
  });

  it("a withdrawal smaller than the excess keeps the original over-since date", () => {
    const l = buildLedger(5000, 2026, [dep(7000, "2026-01-05"), wd(500, "2026-02-01"), dep(100, "2026-03-01")]);
    expect(l.rows.map((r) => r.excessCad)).toEqual([0, 2000, 1500, 1600]);
    expect(l.overSince).toBe("2026-01-05");
  });

  it("withdrawal while not over adds no room", () => {
    const l = buildLedger(5000, 2026, [wd(1000, "2026-01-05"), dep(5500, "2026-01-06")]);
    expect(l.rows.at(-1)!.roomLeftCad).toBe(-500);
    expect(l.rows.at(-1)!.excessCad).toBe(500);
  });

  it("same-day withdrawal applied before contribution (Review Focus 1)", () => {
    const l = buildLedger(1000, 2026, [dep(800, "2026-01-05"), dep(500, "2026-02-01"), wd(500, "2026-02-01")]);
    expect(l.rows[1]!.roomLeftCad).toBe(200);
    expect(l.rows.map((r) => r.kind)).toEqual(["cra_room", "contribution", "withdrawal", "contribution"]);
    expect(l.rows.at(-1)!.excessCad).toBe(300);
    expect(l.overSince).toBe("2026-02-01");
  });

  it("sorts by date; moves on 1 January follow the CRA row", () => {
    const l = buildLedger(7000, 2026, [dep(100, "2026-05-01"), dep(200, "2026-01-01"), dep(300, "2026-03-01")]);
    expect(l.rows.map((r) => r.date)).toEqual(["2026-01-01", "2026-01-01", "2026-03-01", "2026-05-01"]);
    expect(l.rows.map((r) => r.roomLeftCad)).toEqual([7000, 6800, 6500, 6400]);
  });

  it("rounds to cents", () => {
    const l = buildLedger(100, 2026, [dep(0.1, "2026-01-02"), dep(0.2, "2026-01-03")]);
    expect(l.rows.at(-1)!.roomLeftCad).toBe(99.7);
  });

  it("a user-classified none row appears with zero effect", () => {
    const l = buildLedger(5000, 2026, [dep(1000, "2026-01-05"), move("none", 2500, "2026-02-01"), dep(500, "2026-03-01")]);
    expect(l.rows.map((r) => r.kind)).toEqual(["cra_room", "contribution", "none", "contribution"]);
    expect(l.rows.map((r) => r.roomLeftCad)).toEqual([5000, 4000, 4000, 3500]);
    expect(l.rows[2]!.amountCad).toBe(2500);
  });

  it("a none row with a null amount or no date keeps the running values", () => {
    const l = buildLedger(5000, 2026, [dep(1000, "2026-01-05"), move("none", null, "2026-02-01"), dep(500, "2026-03-01"), move("none", null, null)]);
    expect(l.rows.map((r) => [r.kind, r.date, r.roomLeftCad, r.excessCad])).toEqual([
      ["cra_room", "2026-01-01", 5000, 0], ["contribution", "2026-01-05", 4000, 0], ["none", "2026-02-01", 4000, 0], ["contribution", "2026-03-01", 3500, 0], ["none", null, 3500, 0],
    ]);
  });

  it("carries the conversion fields through", () => {
    const native = { amount: 1000, currency: "USD" };
    const l = buildLedger(5000, 2026, [dep(1350, "2026-03-03", { estimated: true, rateDate: "2026-03-02", native, activityKey: "a1", accountKey: "k1" })]);
    expect(l.rows[1]).toMatchObject({ estimated: true, rateDate: "2026-03-02", native, activityKey: "a1", accountKey: "k1" });
    expect(l.rows[0]).toMatchObject({ estimated: false, rateDate: null, native: null });
  });
});

describe("buildLedger: unknowns", () => {
  it("unknown room: every running value is null", () => {
    const l = buildLedger(null, 2026, [dep(6000, "2026-01-10"), wd(5000, "2026-02-03"), dep(5000, "2026-03-14")]);
    expect(l.rows[0]).toMatchObject({ kind: "cra_room", amountCad: null });
    for (const r of l.rows) {
      expect(r.roomLeftCad).toBeNull();
      expect(r.excessCad).toBeNull();
      expect(r.wentOver).toBe(false);
    }
    expect(l.overSince).toBeNull();
    expect(l.undatedExcess).toBe(false);
  });

  it("ambiguous row: running values are null from it onward, and rows before keep theirs", () => {
    const l = buildLedger(5000, 2026, [dep(1000, "2026-01-05"), move("ambiguous", 300, "2026-02-01"), dep(500, "2026-03-01"), wd(200, "2026-04-01")]);
    expect(l.rows.map((r) => r.roomLeftCad)).toEqual([5000, 4000, null, null, null]);
    expect(l.rows.map((r) => r.excessCad)).toEqual([0, 0, null, null, null]);
    expect(l.rows[2]).toMatchObject({ kind: "ambiguous", amountCad: 300 });
    expect(l.overSince).toBeNull();
  });

  it("an ambiguous row on a day sorts before that day's other moves", () => {
    const l = buildLedger(5000, 2026, [dep(1000, "2026-02-01"), move("ambiguous", 300, "2026-02-01")]);
    expect(l.rows.map((r) => r.kind)).toEqual(["cra_room", "ambiguous", "contribution"]);
    expect(l.rows.map((r) => r.roomLeftCad)).toEqual([5000, null, null]);
  });

  it("an undated ambiguous row could fall on any day: every move's running value is unknown", () => {
    const l = buildLedger(5000, 2026, [dep(1000, "2026-01-05"), move("ambiguous", null, null)]);
    expect(l.rows.map((r) => r.date)).toEqual(["2026-01-01", "2026-01-05", null]);
    expect(l.rows.map((r) => r.roomLeftCad)).toEqual([5000, null, null]);
  });

  it("undated total: the amount over is known but its date is not", () => {
    const l = buildLedger(5000, 2026, [dep(1000, "2026-01-05"), move("outside_total", 4500, "2026-05-01", { undated: true, label: "Synthetic outside TFSA" })]);
    expect(l.rows.at(-1)).toMatchObject({ kind: "outside_total", date: "2026-05-01", roomLeftCad: -500, excessCad: 500 });
    expect(l.overSince).toBeNull();
    expect(l.undatedExcess).toBe(true);
    expect(l.rows.some((r) => r.wentOver)).toBe(false);
  });

  it("an undated total with no excess sets nothing", () => {
    const l = buildLedger(5000, 2026, [move("outside_total", 4500, "2026-05-01", { undated: true })]);
    expect(l).toMatchObject({ overSince: null, undatedExcess: false });
    expect(l.rows.at(-1)!.roomLeftCad).toBe(500);
  });
});

describe("buildLedger: a withdrawal's qualifying portion (ITA 207.01(1))", () => {
  it("spec example: the whole withdrawal reduced the excess, so none of it comes back next year", () => {
    const l = buildLedger(5000, 2026, [dep(7000, "2026-01-05"), wd(2000, "2026-02-01"), dep(1000, "2026-03-01")]);
    const w = l.rows.find((r) => r.kind === "withdrawal")!;
    expect(w).toMatchObject({ qualifyingCad: 2000, returnsCad: 0 });
    expect(w.returnsOn).toBeUndefined();
  });

  it("mixed: 1000 reduced the excess and the other 2000 comes back on 1 January", () => {
    const l = buildLedger(5000, 2026, [dep(6000, "2026-01-05"), wd(3000, "2026-02-01")]);
    expect(l.rows.find((r) => r.kind === "withdrawal")).toMatchObject({ qualifyingCad: 1000, returnsCad: 2000, returnsOn: "2027-01-01" });
  });

  it("a withdrawal while not over: all of it comes back", () => {
    const l = buildLedger(5000, 2026, [wd(500, "2026-02-01")]);
    expect(l.rows[1]).toMatchObject({ qualifyingCad: 0, returnsCad: 500, returnsOn: "2027-01-01" });
  });

  it("a withdrawal after an unclear row: its split is unknown and it has no return date", () => {
    const l = buildLedger(5000, 2026, [move("ambiguous", 100, "2026-01-05"), wd(500, "2026-02-01")]);
    const w = l.rows.find((r) => r.kind === "withdrawal")!;
    expect(w).toMatchObject({ qualifyingCad: null, returnsCad: null });
    expect(w.returnsOn).toBeUndefined();
  });

  it("non-withdrawal rows carry no split", () => {
    const l = buildLedger(5000, 2026, [dep(100, "2026-01-05")]);
    for (const r of l.rows) {
      expect(r.qualifyingCad).toBeUndefined();
      expect(r.returnsCad).toBeUndefined();
    }
  });
});

describe("buildRrspLedger", () => {
  const label = "Synthetic RRSP limit (you entered)";

  it("room left stops at 0, the rest is excess, and a withdrawal changes neither", () => {
    const l = buildRrspLedger(5000, "2026-03-03", [dep(3000, "2026-03-10"), wd(1000, "2026-04-01"), dep(2500, "2026-05-01")], label);
    expect(l.rows[0]).toMatchObject({ kind: "cra_room", date: "2026-03-03", label, amountCad: 5000, roomLeftCad: 5000, excessCad: 0 });
    expect(l.rows.map((r) => r.roomLeftCad)).toEqual([5000, 2000, 2000, 0]);
    expect(l.rows.map((r) => r.excessCad)).toEqual([0, 0, 0, 500]);
    expect(l.rows.map((r) => r.wentOver)).toEqual([false, false, false, true]);
    expect(l.overSince).toBe("2026-05-01");
    expect(l.undatedExcess).toBe(false);
  });

  it("none moves are listed and change nothing; outside_total counts as contributed", () => {
    const l = buildRrspLedger(5000, "2026-03-03", [move("none", 700, "2026-03-05"), move("outside_total", 1500, "2026-03-06")], label);
    expect(l.rows.map((r) => r.kind)).toEqual(["cra_room", "none", "outside_total"]);
    expect(l.rows.map((r) => r.roomLeftCad)).toEqual([5000, 5000, 3500]);
  });

  it("an ambiguous or unknown-amount move makes the running values unknown", () => {
    const l = buildRrspLedger(5000, "2026-03-03", [dep(1000, "2026-03-05"), move("ambiguous", null, "2026-03-06"), dep(1, "2026-03-07")], label);
    expect(l.rows.map((r) => r.roomLeftCad)).toEqual([5000, 4000, null, null]);
    expect(l.rows.map((r) => r.excessCad)).toEqual([0, 0, null, null]);
    expect(l.overSince).toBeNull();
    const nullAmount = buildRrspLedger(5000, "2026-03-03", [dep(1000, "2026-03-05"), move("contribution", null, "2026-03-06")], label);
    expect(nullAmount.rows.at(-1)!.roomLeftCad).toBeNull();
  });

  it("no limit entered: every running value is unknown", () => {
    const l = buildRrspLedger(null, "2026-03-03", [dep(1000, "2026-03-05")], label);
    expect(l.rows.map((r) => r.roomLeftCad)).toEqual([null, null]);
    expect(l.rows.map((r) => r.excessCad)).toEqual([null, null]);
  });

  it("a negative room opens over: room left 0, the excess from the opening date", () => {
    const l = buildRrspLedger(-1000, "2026-03-03", [dep(200, "2026-03-10"), wd(50, "2026-03-11")], label);
    expect(l.rows[0]).toMatchObject({ kind: "cra_room", date: "2026-03-03", amountCad: -1000, roomLeftCad: 0, excessCad: 1000, wentOver: false });
    expect(l.rows.map((r) => r.roomLeftCad)).toEqual([0, 0, 0]);
    expect(l.rows.map((r) => r.excessCad)).toEqual([1000, 1200, 1200]);
    expect(l.rows.some((r) => r.wentOver)).toBe(false);
    expect(l.overSince).toBe("2026-03-03");
    expect(l.undatedExcess).toBe(false);
    const empty = buildRrspLedger(-1000, "2026-03-03", [], label);
    expect(empty.overSince).toBe("2026-03-03");
    expect(empty.rows[0]!.excessCad).toBe(1000);
  });

  it("within one date contributions come before withdrawals", () => {
    const l = buildRrspLedger(5000, "2026-03-03", [wd(100, "2026-03-05"), dep(200, "2026-03-05")], label);
    expect(l.rows.slice(1).map((r) => r.kind)).toEqual(["contribution", "withdrawal"]);
  });

  it("an undated total that leaves an excess tells no date for it", () => {
    const l = buildRrspLedger(1000, "2026-03-03", [move("outside_total", 1500, "2026-06-01", { undated: true })], label);
    expect(l.undatedExcess).toBe(true);
    expect(l.overSince).toBeNull();
    expect(l.rows.at(-1)!.excessCad).toBe(500);
  });
});

describe("buildLedger and buildFhsaLedger opening dates", () => {
  it("still open on 1 January of the year", () => {
    expect(buildLedger(100, 2026, []).rows[0]!.date).toBe("2026-01-01");
    expect(buildFhsaLedger(100, 2026, [], "x").rows[0]!.date).toBe("2026-01-01");
  });
});
