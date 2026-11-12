import { describe, expect, it } from "vitest";

import { accountKey, activityKey } from "../memory/keys.js";
import { matchTransfers, tallyActivity, type ActivitySource, type RoomActivity } from "./room-common.js";

// Synthetic accounts and amounts only.
const A = accountKey("synthetic-account-a");
const B = accountKey("synthetic-account-b");
let seq = 0;
const row = (tradeDate: string | null, amount: number, over: Partial<RoomActivity> = {}): RoomActivity => {
  seq += 1;
  return { accountKey: A, activityKey: activityKey(`synthetic-room-common-${seq}`), type: "CONTRIBUTION", amount, currency: "CAD", fxRate: null, tradeDate, ...over };
};
const source = (activities: RoomActivity[], counterparts?: ActivitySource["counterparts"]): ActivitySource => ({
  activities, counterparts, classifications: new Map(), fx: { toCad: () => null },
});
const SET = new Map([[A, "Synthetic RRSP"]]);

describe("tallyActivity: the period", () => {
  const all = [row("2025-11-01", 1000), row("2026-02-15", 2000), row("2026-03-03", 4000), row("2025-03-03", 8000)];
  const rows = () => all;

  it("a date period counts rows on or between its ends and skips the rest", () => {
    const t = tallyActivity(source(rows()), SET, { from: "2025-03-04", to: "2026-03-02" }, new Map());
    expect(t.contributedCad).toBe(3000);
    expect(t.moves.map((m) => m.date)).toEqual(["2025-11-01", "2026-02-15"]);
  });

  it("both ends are inclusive", () => {
    const t = tallyActivity(source([row("2025-03-04", 10), row("2026-03-02", 20), row("2025-03-03", 40), row("2026-03-03", 80)]), SET, { from: "2025-03-04", to: "2026-03-02" }, new Map());
    expect(t.contributedCad).toBe(30);
  });

  it("a number is the calendar year, as before", () => {
    const t = tallyActivity(source(rows()), SET, 2026, new Map());
    expect(t.contributedCad).toBe(6000);
    expect(t.moves.map((m) => m.date)).toEqual(["2026-02-15", "2026-03-03"]);
    const same = tallyActivity(source(rows()), SET, { from: "2026-01-01", to: "2026-12-31" }, new Map());
    expect(same).toEqual(t);
  });

  it("an undated row is still processed, whatever the period", () => {
    const undated = row(null, 500);
    const byYear = tallyActivity(source([undated]), SET, 2026, new Map());
    const byPeriod = tallyActivity(source([undated]), SET, { from: "2025-03-04", to: "2026-03-02" }, new Map());
    expect(byPeriod).toEqual(byYear);
    expect(byPeriod.moves).toHaveLength(1);
  });
});

describe("matchTransfers: the period", () => {
  it("pairs rows dated inside the period only", () => {
    const out = row("2026-03-02", -300, { type: "TRANSFER", accountKey: A });
    const into = row("2026-03-03", 300, { type: "TRANSFER", accountKey: B });
    const set = new Map([[A, "A"], [B, "B"]]);
    const counterparts = [{ accountKey: B, label: "B", activityKey: into.activityKey, type: into.type, amount: 300, currency: "CAD", tradeDate: "2026-03-03" }];
    const inside = matchTransfers([out], counterparts, new Map([[A, "A"]]), { from: "2025-03-04", to: "2026-03-02" }, new Map());
    expect(inside.get(out.activityKey)?.date).toBe("2026-03-03");
    const outside = matchTransfers([into], [], set, { from: "2025-03-04", to: "2026-03-02" }, new Map());
    expect(outside.size).toBe(0);
  });
});
