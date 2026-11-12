import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { notCountedLine } from "./room-common.js";
import { assumedNote, cad, fhsaHeadline, fhsaWithdrawalNote, fxNote, matchedNote, overLimitAlert, overLimitAmount, overLimitNote, returningNote, storedRoomAlertText, torontoDateTime, withdrawalNote, withdrawalRowNote } from "../mcp/room-tools.js";
import { dollars, estLabel } from "../mcp/portfolio-fact-tools.js";
import { convertedMoney, nativeMoney } from "./tfsa-room.js";

/** Shared with packages/widgets/src/widgets/tfsa-room/format.test.ts: the card must format exactly as the API text does. */
const cases: Record<string, any[]> = JSON.parse(readFileSync(new URL("./__fixtures__/currency-format-cases.json", import.meta.url), "utf8"));

describe("currency format fixture (API side)", () => {
  it.each(cases.cad)("cad $input", (c) => expect(cad(c.input)).toBe(c.expected));
  it.each(cases.estLabel)("estLabel $estimated $fxDate", (c) => expect(estLabel(c.estimated, c.fxDate)).toBe(c.expected));
  it.each(cases.dollars)("dollars $input", (c) => expect(dollars(c.input)).toBe(c.expected));
  it.each(cases.nativeMoney)("nativeMoney $amount $currency", (c) => expect(nativeMoney(c.amount, c.currency)).toBe(c.expected));
  it.each(cases.convertedMoney)("convertedMoney $cad", (c) => expect(convertedMoney(c.cad, c)).toBe(c.expected));
  it.each(cases.fxNote)("fxNote", (c) => expect(fxNote(c.fx)).toBe(c.expected));
  it.each(cases.torontoDateTime)("torontoDateTime $input", (c) => expect(torontoDateTime(c.input)).toBe(c.expected));
  it.each(cases.withdrawalNote)("withdrawalNote $year $over", (c) => expect(withdrawalNote(c.amount, c.year, c.over)).toBe(c.expected));
  it.each(cases.withdrawalRowNote)("withdrawalRowNote $expected", (c) => expect(withdrawalRowNote(c.row)).toBe(c.expected));
  it.each(cases.returningNote)("returningNote $expected", (c) => expect(returningNote(c.result)).toBe(c.expected));
  it.each(cases.matchedNote)("matchedNote $expected", (c) => expect(matchedNote(c.row)).toBe(c.expected));
  it.each(cases.assumedNote)("assumedNote $expected", (c) => expect(assumedNote(c.row)).toBe(c.expected));
  it.each(cases.fhsaHeadline)("fhsaHeadline $expected", (c) => expect(fhsaHeadline(c.result)).toBe(c.expected));
  it.each(cases.fhsaWithdrawalNote)("fhsaWithdrawalNote $expected", (c) => expect(fhsaWithdrawalNote(c.row)).toBe(c.expected));
  it.each(cases.notCountedLine)("notCountedLine $expected", (c) => expect(notCountedLine(c.items, c.over)).toBe(c.expected));
  it.each(cases.overLimitAlert)("overLimitAlert $overLimitCad", (c) => expect(overLimitAlert(overLimitAmount(c.overLimitCad, c.fx, c.estimated))).toBe(c.expected));
  // An alert row stores overLimitNote's text; get_portfolio_alerts renders it to the same sentence as roomText.
  it.each(cases.overLimitAlert)("stored alert note $overLimitCad", (c) =>
    expect(storedRoomAlertText({ excessCad: c.overLimitCad, note: overLimitNote(c.fx, c.estimated) })).toBe(c.expected));
});
