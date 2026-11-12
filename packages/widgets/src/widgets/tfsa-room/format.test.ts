// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assumedNote, dashboardEnterable, cad, convertedMoney, dollars, estLabel, fxNote, matchedNote, nativeMoney, notCountedLine, returningNote, torontoDateTime, withdrawalNote, withdrawalRowNote } from "./format";

/** The API's own test asserts the same file against its helpers (packages/api/src/room/currency-format.test.ts). */
const cases: Record<string, any[]> = JSON.parse(readFileSync(resolve(__dirname, "../../../../api/src/room/__fixtures__/currency-format-cases.json"), "utf8"));

test.each(cases.cad)("cad $input", (c) => expect(cad(c.input)).toBe(c.expected));
test.each(cases.estLabel)("estLabel $estimated $fxDate", (c) => expect(estLabel(c.estimated, c.fxDate)).toBe(c.expected));
test.each(cases.dollars)("dollars $input", (c) => expect(dollars(c.input)).toBe(c.expected));
test.each(cases.nativeMoney)("nativeMoney $amount $currency", (c) => expect(nativeMoney(c.amount, c.currency)).toBe(c.expected));
test.each(cases.convertedMoney)("convertedMoney $cad", (c) => expect(convertedMoney(c.cad, c)).toBe(c.expected));
test.each(cases.fxNote)("fxNote", (c) => expect(fxNote(c.fx)).toBe(c.expected));
test.each(cases.withdrawalNote)("withdrawalNote $year $over", (c) => expect(withdrawalNote(c.amount, c.year, c.over)).toBe(c.expected));
test.each(cases.withdrawalRowNote)("withdrawalRowNote $expected", (c) => expect(withdrawalRowNote(c.row)).toBe(c.expected));
test.each(cases.returningNote)("returningNote $expected", (c) => expect(returningNote(c.result)).toBe(c.expected));
test.each(cases.matchedNote)("matchedNote $expected", (c) => expect(matchedNote(c.row)).toBe(c.expected));
test.each(cases.assumedNote)("assumedNote $expected", (c) => expect(assumedNote(c.row)).toBe(c.expected));
test.each(cases.notCountedLine)("notCountedLine $expected", (c) => expect(notCountedLine(c.items, c.over)).toBe(c.expected));
test.each(cases.torontoDateTime)("torontoDateTime $input", (c) => expect(torontoDateTime(c.input)).toBe(c.expected));

test("dashboardEnterable pins the kinds the dashboard takes (same list as the API test)", () => {
  const kinds = ["cra_room", "outside_contributions", "ambiguous", "coverage", "stale_activity", "disconnected_account", "dated_entries", "managed_account"];
  expect(kinds.filter((kind) => dashboardEnterable({ kind, accountKey: "k" }))).toEqual(["cra_room", "outside_contributions", "ambiguous", "managed_account"]);
  expect(dashboardEnterable({ kind: "dated_entries", accountKey: "outside:other-bank" })).toBe(true);
  expect(dashboardEnterable({ kind: "dated_entries", accountKey: "1111111111111111" })).toBe(false);
});
