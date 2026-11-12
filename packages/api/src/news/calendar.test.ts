import { describe, expect, it } from "vitest";
import { extractDates, projectDividendPay, projectEarnings } from "./calendar.js";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const ymd = (x: Date) => x.toISOString().slice(0, 10);
const NOW = new Date("2026-10-21T15:00:00Z");

describe("projectEarnings", () => {
  const filings = [d("2026-02-05"), d("2026-05-07"), d("2026-08-06")];

  it("worked example: next = last filing + median gap, confirmed by an article date within 3 days", () => {
    const e = projectEarnings("ZZTEST", filings, [d("2026-11-04")], NOW)!;
    expect(e).not.toBeNull();
    expect(ymd(e.date)).toBe("2026-11-04");
    expect(e).toMatchObject({ symbol: "ZZTEST", kind: "earnings", status: "confirmed", source: "article", amountPerUnit: null, currency: null });
    expect(e.id).toBe("earnings:ZZTEST:2026-11-04");
  });

  it("is expected on the projected date (edgar) without a nearby article date", () => {
    const e = projectEarnings("ZZTEST", filings, [d("2026-11-09"), d("2026-10-01")], NOW)!;
    expect(ymd(e.date)).toBe("2026-11-05"); // 08-06 + 91 d
    expect(e).toMatchObject({ status: "expected", source: "edgar" });
    expect(e.id).toBe("earnings:ZZTEST:2026-11-05");
  });

  it("accepts an article exactly 3 days away and picks the closest one", () => {
    expect(ymd(projectEarnings("ZZTEST", filings, [d("2026-11-08")], NOW)!.date)).toBe("2026-11-08");
    expect(ymd(projectEarnings("ZZTEST", filings, [d("2026-11-02"), d("2026-11-06")], NOW)!.date)).toBe("2026-11-06");
  });

  it("uses the median of the last four gaps only, in any input order", () => {
    // gaps: 10 (ignored), 90, 92, 100, 200 -> last four 92, 90... sorted [90, 92, 100, 200] -> median 96
    const f = ["2025-01-01", "2025-01-11", "2025-04-11", "2025-07-12", "2025-10-20", "2026-05-08"].map(d).reverse();
    const e = projectEarnings("ZZTEST", f, [], new Date("2026-06-01T00:00:00Z"))!;
    expect(ymd(e.date)).toBe("2026-08-12"); // 05-08 + 96 d
  });

  it("needs at least two distinct filing dates", () => {
    expect(projectEarnings("ZZTEST", [d("2026-08-06")], [], NOW)).toBeNull();
    expect(projectEarnings("ZZTEST", [d("2026-08-06"), d("2026-08-06")], [], NOW)).toBeNull();
    expect(projectEarnings("ZZTEST", [], [], NOW)).toBeNull();
  });

  it("is null when the projection is more than a day in the past", () => {
    expect(projectEarnings("ZZTEST", [d("2026-03-01"), d("2026-06-01")], [], NOW)).toBeNull(); // next 2026-08-31
    expect(projectEarnings("ZZTEST", [d("2026-07-21"), d("2026-08-21")], [], new Date("2026-09-21T12:00:00Z"))).not.toBeNull();
  });
});

describe("extractDates", () => {
  const got = (text: string, now = NOW) => extractDates(text, now).map(ymd);

  it("parses month-name forms with and without year", () => {
    expect(got("ZZTEST results on Oct 30")).toEqual(["2026-10-30"]);
    expect(got("ZZTEST to report October 30")).toEqual(["2026-10-30"]);
    expect(got("Q3 results on October 30, 2026 after close")).toEqual(["2026-10-30"]);
    expect(got("Call scheduled for Nov. 4th")).toEqual(["2026-11-04"]);
    expect(got("Results 30 Oct")).toEqual(["2026-10-30"]);
    expect(got("Results due 30 October 2026")).toEqual(["2026-10-30"]);
    expect(got("Sept 2 meeting", new Date("2026-08-20T12:00:00Z"))).toEqual(["2026-09-02"]);
  });

  it("parses US m/d only with a 4-digit year or an earnings keyword within 30 chars before", () => {
    expect(got("earnings 10/30")).toEqual(["2026-10-30"]);
    expect(got("meeting 11/05/2026")).toEqual(["2026-11-05"]);
    expect(got("dividend payable 11/14")).toEqual(["2026-11-14"]);
    expect(got("ZZTEST Q3 call set for 11/2")).toEqual(["2026-11-02"]);
    expect(got("results, which the company says are coming, 11/3")).toEqual([]); // keyword > 30 chars before
    expect(got("meeting 11/05")).toEqual([]);
  });

  it("does not read fractions, ratings or the verb 'may' as dates", () => {
    expect(got("ZZTEST raised its payout 3/4 of a cent")).toEqual([]);
    expect(got("a 1/2 point move")).toEqual([]);
    expect(got("reviewers gave it 4/5 stars")).toEqual([]);
    expect(got("we may 12 times over", new Date("2026-04-01T15:00:00Z"))).toEqual([]);
    expect(got("ZZTEST shares jump 30 may follow", new Date("2026-04-01T15:00:00Z"))).toEqual([]);
    expect(got("Annual meeting May 12", new Date("2026-04-01T15:00:00Z"))).toEqual(["2026-05-12"]);
    expect(got("RESULTS ON OCT 30")).toEqual(["2026-10-30"]);
  });

  it("defaults the year to the next occurrence and keeps today", () => {
    expect(got("on Jan 15")).toEqual(["2027-01-15"]);
    expect(got("on Oct 21")).toEqual(["2026-10-21"]);
    expect(got("on Oct 20")).toEqual([]); // next occurrence is 2027-10-20, beyond 120 d
  });

  it("returns only dates within 120 days, deduped and sorted", () => {
    expect(got("Feb 18 2027 and Feb 19, 2027")).toEqual(["2027-02-18"]); // now + 120 d = 2027-02-18
    expect(got("October 30, 2025")).toEqual([]);
    expect(got("Nov 5, then earnings 10/30, then Oct 30, 2026 and 30 Oct")).toEqual(["2026-10-30", "2026-11-05"]);
  });

  it("ignores weekdays, invalid days, and non-dates", () => {
    expect(got("results on Thursday")).toEqual([]);
    expect(got("Feb 30 and 13/01 and 2026/10/30 and Oct 32")).toEqual([]);
    expect(got("revenue up 12% in October")).toEqual([]);
  });
});

describe("projectDividendPay", () => {
  const pay = (date: string, perUnit = 0.25, currency = "CAD") => ({ date: d(date), perUnit, currency });

  it("quarterly cadence: last + 3 months, last perUnit and currency, expected", () => {
    const e = projectDividendPay("ZZTEST", [pay("2026-08-14", 0.24, "USD"), pay("2026-02-13", 0.2), pay("2026-05-15", 0.22)], 100, NOW)!;
    expect(ymd(e.date)).toBe("2026-11-14");
    expect(e).toEqual({
      id: "dividend_pay:ZZTEST:2026-11-14", symbol: "ZZTEST", kind: "dividend_pay", date: e.date, status: "expected",
      source: "projection", amountPerUnit: 0.24, currency: "USD",
    });
  });

  it("monthly cadence: last + 1 month, clamped to month end", () => {
    expect(ymd(projectDividendPay("ZZTEST", [pay("2026-08-31"), pay("2026-09-30")], 10, NOW)!.date)).toBe("2026-10-30");
    expect(ymd(projectDividendPay("ZZTEST", [pay("2026-12-31"), pay("2027-01-31")], 10, NOW)!.date)).toBe("2027-02-28");
  });

  it("annual cadence: last + 1 year", () => {
    expect(ymd(projectDividendPay("ZZTEST", [pay("2024-12-01"), pay("2025-12-01")], 10, NOW)!.date)).toBe("2026-12-01");
  });

  it("semi-annual cadence: last + 6 months, so the next payment is not skipped (A11)", () => {
    expect(ymd(projectDividendPay("ZZTEST", [pay("2025-06-12"), pay("2025-12-11"), pay("2026-06-12")], 10, NOW)!.date)).toBe("2026-12-12");
  });

  it("keeps the date but no amount when the last payment has no per-unit figure (A4)", () => {
    const e = projectDividendPay("ZZTEST", [pay("2026-05-15", 0.25), { date: d("2026-08-14"), perUnit: null, currency: "CAD" }], 100, NOW)!;
    expect(ymd(e.date)).toBe("2026-11-14");
    expect(e.amountPerUnit).toBeNull();
  });

  it("uses the per-unit figure of another account paid the same last day", () => {
    const e = projectDividendPay("ZZTEST", [pay("2026-05-15", 0.2), pay("2026-08-14", 0.25), { date: d("2026-08-14"), perUnit: null, currency: "CAD" }], 100, NOW)!;
    expect(e.amountPerUnit).toBe(0.25);
  });

  it("uses the median gap of the last six payments only", () => {
    // all seven gaps: median 31 (monthly); last six payments -> gaps 30, 31, 90, 91, 92 -> median 90 (quarterly)
    const p = ["2025-09-15", "2025-10-15", "2025-11-15", "2025-12-15", "2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"].map((x) => pay(x));
    expect(ymd(projectDividendPay("ZZTEST", p, 10, NOW)!.date)).toBe("2027-01-15");
  });

  it("is null with fewer than two payments or when the next date is stale", () => {
    expect(projectDividendPay("ZZTEST", [pay("2026-09-15")], 10, NOW)).toBeNull();
    expect(projectDividendPay("ZZTEST", [], 10, NOW)).toBeNull();
    expect(projectDividendPay("ZZTEST", [pay("2026-04-15"), pay("2026-07-15")], 10, NOW)).toBeNull(); // next 10-15
    expect(projectDividendPay("ZZTEST", [pay("2026-08-21"), pay("2026-09-21")], 10, NOW)).not.toBeNull(); // 10-21 >= now - 1 d
  });
});
