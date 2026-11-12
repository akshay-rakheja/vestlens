import { describe, expect, it } from "vitest";
import { RRSP_DEADLINES, openTaxYears, rrspWindow, taxYearOf } from "./rrsp-calendar.js";

describe("RRSP tax-year windows", () => {
  it("windows follow CRA's published deadlines, leap year included", () => {
    expect(rrspWindow(2025)).toEqual({ taxYear: 2025, from: "2025-03-04", to: "2026-03-02" });
    expect(rrspWindow(2024)).toEqual({ taxYear: 2024, from: "2024-03-01", to: "2025-03-03" });
    expect(rrspWindow(2026)).toEqual({ taxYear: 2026, from: "2026-03-03", to: RRSP_DEADLINES[2026] ?? null });
    expect(rrspWindow(2022)).toBeNull(); // 2021's deadline isn't in the table
  });

  it("a contribution on the deadline goes to the earlier year, the next day to the new one", () => {
    expect(taxYearOf("2026-03-02")).toBe(2025);
    expect(taxYearOf("2026-03-03")).toBe(2026);
  });

  it("taxYearOf is null for a date outside every known window or not a real date", () => {
    expect(taxYearOf("2024-02-29")).toBeNull(); // 2023's deadline; 2022's isn't in the table, so 2023 has no start
    expect(taxYearOf("2023-06-01")).toBeNull();
    expect(taxYearOf("2026-02-30")).toBeNull();
    expect(taxYearOf("soon")).toBeNull();
  });

  it("between 1 January and the deadline both years are open, previous first", () => {
    expect(openTaxYears("2026-02-10").map((w) => w.taxYear)).toEqual([2025, 2026]);
    expect(openTaxYears("2026-03-02").map((w) => w.taxYear)).toEqual([2025, 2026]);
    expect(openTaxYears("2026-03-03").map((w) => w.taxYear)).toEqual([2026]);
    expect(openTaxYears("2026-10-29").map((w) => w.taxYear)).toEqual([2026]);
  });

  it("when the new year's start is unknown only the previous year is open, with no end", () => {
    // 2026's deadline isn't published, so a date in 2027 can't say when 2027 begins.
    expect(RRSP_DEADLINES[2026]).toBeUndefined();
    expect(openTaxYears("2027-01-15")).toEqual([{ taxYear: 2026, from: "2026-03-03", to: null }]);
    expect(openTaxYears("2030-06-01")).toEqual([]);
    expect(openTaxYears("not a date")).toEqual([]);
  });
});
