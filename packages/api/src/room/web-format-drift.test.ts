import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { rrspHeadline, rrspText } from "../mcp/room-tools.js";
import {
  RRSP_CRA_FACT, RRSP_DEDUCT_LATER, RRSP_ELSEWHERE_QUESTION, RRSP_LIMIT_PROMPT, RRSP_MANAGED_QUESTION, RRSP_UNUSED_QUESTION, type RrspMissingItem, type RrspYear,
} from "./rrsp-room.js";

// The dashboard's formatter (packages/web/src/roomFormat.ts) must format exactly like the API's helpers. The check
// lives here because the web build installs only web dependencies (no Node types, no access to packages/api).
const here = dirname(fileURLToPath(import.meta.url));
const cases: Record<string, any[]> = JSON.parse(readFileSync(join(here, "__fixtures__", "currency-format-cases.json"), "utf8"));
const webFormatPath: string = join(here, "..", "..", "..", "web", "src", "roomFormat.ts");
// The widget is Preact (not importable here): its RRSP questions are pinned as source text, the year as `${Y}`.
const widgetSource = readFileSync(join(here, "..", "..", "..", "widgets", "src", "widgets", "tfsa-room", "TfsaRoom.tsx"), "utf8");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const web: any = await import(webFormatPath);

describe("dashboard room format matches the shared fixture", () => {
  test.each(cases.cad)("cad $input", (c) => expect(web.cad(c.input)).toBe(c.expected));
  test.each(cases.dollars)("dollars $input", (c) => expect(web.dollars(c.input)).toBe(c.expected));
  test.each(cases.estLabel)("estLabel $estimated $fxDate", (c) => expect(web.estLabel(c.estimated, c.fxDate)).toBe(c.expected));
  test.each(cases.nativeMoney)("nativeMoney $amount $currency", (c) => expect(web.nativeMoney(c.amount, c.currency)).toBe(c.expected));
  test.each(cases.convertedMoney)("convertedMoney $cad", (c) => expect(web.convertedMoney(c.cad, c)).toBe(c.expected));
  test.each(cases.fxNote)("fxNote", (c) => expect(web.fxNote(c.fx)).toBe(c.expected));
  test.each(cases.torontoDateTime)("torontoDateTime $input", (c) => expect(web.torontoDateTime(c.input)).toBe(c.expected));
  test.each(cases.withdrawalNote)("withdrawalNote $year $over", (c) => expect(web.withdrawalNote(c.amount, c.year, c.over)).toBe(c.expected));
  test.each(cases.withdrawalRowNote)("withdrawalRowNote $expected", (c) => expect(web.withdrawalRowNote(c.row)).toBe(c.expected));
  test.each(cases.returningNote)("returningNote $expected", (c) => expect(web.returningNote(c.result)).toBe(c.expected));
  test.each(cases.matchedNote)("matchedNote $expected", (c) => expect(web.matchedNote(c.row)).toBe(c.expected));
  test.each(cases.assumedNote)("assumedNote $expected", (c) => expect(web.assumedNote(c.row)).toBe(c.expected));
  test.each(cases.fhsaHeadline)("fhsaHeadline $expected", (c) => expect(web.fhsaHeadline(c.result)).toBe(c.expected));
  test.each(cases.fhsaWithdrawalNote)("fhsaWithdrawalNote $expected", (c) => expect(web.fhsaWithdrawalNote(c.row)).toBe(c.expected));
  test.each(cases.notCountedLine)("notCountedLine $expected", (c) => expect(web.notCountedLine(c.items, c.over)).toBe(c.expected));
  test.each(cases.overLimitAlert)("overLimitAlert $overLimitCad", (c) =>
    expect(web.overLimitAlert(web.noteAmount(c.overLimitCad, web.overLimitNote(c.fx, c.estimated)))).toBe(c.expected));
  test.each(cases.overLimitAlert)("stored alert $overLimitCad", (c) =>
    expect(web.storedAlertText({ excessCad: c.overLimitCad, note: web.overLimitNote(c.fx, c.estimated) })).toBe(c.expected));
});

// The RRSP section's copy on the dashboard: the same headline, missing-item lines and constants as the assistant's text.
const noFx = { contributions: { estimated: false, rateDates: [], native: [] }, withdrawals: { estimated: false, rateDates: [], native: [] } };
const rrspYear = (over: Partial<RrspYear>): RrspYear => ({
  window: { taxYear: 2025, from: "2025-03-04", to: "2026-03-02" }, contributedCad: 4000, limitCad: null, unusedCad: null, elsewhereCad: null,
  roomLeftCad: null, overLimitCad: null, estimated: false, missing: [], basis: [], fx: noFx, fxDates: [],
  ledger: { rows: [], overSince: null, undatedExcess: false }, ...over,
});
const ambiguous: RrspMissingItem = {
  kind: "ambiguous", count: 3, rows: [
    { activityKey: "a".repeat(16), date: "2025-06-01", amountCad: 1350, estimated: true, rateDate: "2025-05-30", native: { amount: 1000, currency: "USD" }, type: "TRANSFER_IN", label: "Synthetic RRSP" },
    { activityKey: "b".repeat(16), date: "unknown", amountCad: null, estimated: false, rateDate: null, native: null, type: "TRANSFER_IN", label: "Synthetic RRSP" },
  ],
};
const rrspMissing: RrspMissingItem[] = [
  { kind: "deduction_limit" },
  { kind: "unused_contributions" },
  { kind: "elsewhere" },
  { kind: "managed_rrsp", labels: ["Synthetic Managed RRSP", "Synthetic Other RRSP"] },
  { kind: "coverage", label: "Synthetic RRSP", accountKey: "c".repeat(64) },
  { kind: "stale_activity", label: "Synthetic RRSP", accountKey: "c".repeat(64), lastSyncedAt: null },
  { kind: "stale_activity", label: "Synthetic RRSP", accountKey: "c".repeat(64), lastSyncedAt: "2026-02-01T13:05:00.000Z" },
  ambiguous,
];
const rrspYears: RrspYear[] = [
  rrspYear({ missing: [{ kind: "deduction_limit" }] }),
  rrspYear({ missing: [{ kind: "deduction_limit" }], contributedCad: 1234.5, elsewhereCad: 800 }),
  rrspYear({ limitCad: 10000, missing: [{ kind: "unused_contributions" }, { kind: "elsewhere" }] }),
  rrspYear({ limitCad: 10000, unusedCad: 0, missing: [{ kind: "elsewhere" }] }),
  rrspYear({ limitCad: 10000, elsewhereCad: 300, missing: [{ kind: "unused_contributions" }] }),
  rrspYear({ limitCad: 10000, missing: [{ kind: "unused_contributions" }, { kind: "managed_rrsp", labels: ["Synthetic Managed RRSP"] }] }),
  rrspYear({ missing: [{ kind: "deduction_limit" }, { kind: "coverage", label: "Synthetic RRSP", accountKey: "c".repeat(64) }], contributedCad: null }),
  rrspYear({ limitCad: 10000, roomLeftCad: 6000, overLimitCad: 0 }),
  rrspYear({ limitCad: 10000, roomLeftCad: 2000, overLimitCad: 0, elsewhereCad: 2000 }),
  rrspYear({ limitCad: 10000, roomLeftCad: 0, overLimitCad: 2500.25, window: { taxYear: 2026, from: "2026-03-03", to: null } }),
];

describe("dashboard RRSP copy matches the assistant's", () => {
  test("constants", () => {
    expect(web.RRSP_LIMIT_PROMPT).toBe(RRSP_LIMIT_PROMPT);
    expect(web.RRSP_DEDUCT_LATER).toBe(RRSP_DEDUCT_LATER);
    expect(web.RRSP_CRA_FACT).toBe(RRSP_CRA_FACT);
    for (const Y of [2025, 2026]) {
      expect(web.RRSP_UNUSED_QUESTION(Y)).toBe(RRSP_UNUSED_QUESTION(Y));
      expect(web.RRSP_ELSEWHERE_QUESTION(Y)).toBe(RRSP_ELSEWHERE_QUESTION(Y));
      expect(web.RRSP_MANAGED_QUESTION("Synthetic Managed RRSP", Y)).toBe(RRSP_MANAGED_QUESTION("Synthetic Managed RRSP", Y));
    }
  });
  test("the widget's unused and elsewhere questions", () => {
    // 1111 stands in for the year so the template's `${Y}` can be put back.
    expect(widgetSource).toContain(`\`${RRSP_UNUSED_QUESTION(1111).replace("1111", "${Y}")}\``);
    expect(widgetSource).toContain(`\`${RRSP_ELSEWHERE_QUESTION(1111).replace("1111", "${Y}")}\``);
    expect(widgetSource).toContain(`\`${RRSP_MANAGED_QUESTION("LABELS", 1111).replace("LABELS", "${labels}").replace("1111", "${Y}")}\``);
    // The "plus" the headline carries when a contributions-not-in-VestLens figure is entered (B12), as rrspText words it.
    expect(rrspText({ status: "shown", years: [rrspYear({ missing: [{ kind: "deduction_limit" }], elsewhereCad: 800 })], activityAsOf: null })).toContain(" plus $800 you entered as contributions not in VestLens.");
    expect(widgetSource).toContain("you entered as contributions not in VestLens");
  });
  test.each(rrspYears.map((y, i) => [i, y] as const))("rrspHeadline and the contributions-elsewhere words, year %i", (_i, y) => {
    expect(web.rrspHeadline(y)).toBe(rrspHeadline(y));
    const text = rrspText({ status: "shown", years: [y], activityAsOf: null });
    expect(text).toContain(`${web.rrspHeadline(y)}${web.rrspHeadlinePlus(y)}.`);
    const contributed = web.rrspContributedLine(y);
    if (contributed !== null) expect(text).toContain(`${contributed}.`);
  });
  test.each(rrspMissing.map((m) => [m.kind, m] as const))("missing line %s", (_kind, item) => {
    const y = rrspYear({ missing: [item] });
    expect(rrspText({ status: "shown", years: [y], activityAsOf: null })).toContain(web.rrspMissingLine(item, y));
  });
});
