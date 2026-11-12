import { formatMoney, formatUnits, formatShortDate, formatPercent, formatPoints, formatSignedMoney, formatSignedPercent } from "./format";

test("money keeps native currency symbols", () => {
  expect(formatMoney(1204.18, "CAD")).toBe("$1,204.18");
  expect(formatMoney(600, "USD")).toBe("US$600.00");
  expect(formatSignedMoney(1204.18, "CAD")).toBe("+$1,204.18");
  expect(formatSignedMoney(-12, "CAD")).toBe("−$12.00");
});
test("percent and points", () => {
  expect(formatPercent(0.0049)).toBe("0.49%");
  expect(formatSignedPercent(0.118, 1)).toBe("+11.8%");
  expect(formatSignedPercent(-0.002, 1)).toBe("−0.2%");
  expect(formatPoints(0.019)).toBe("+1.9 pts");
  expect(formatPoints(-0.004)).toBe("−0.4 pts");
});
test("unknown currency codes fall back without throwing", () => {
  expect(formatMoney(5, "ZZZ")).toMatch(/5\.00/);
});
test("short dates omit the year unless it differs from the reference year", () => {
  expect(formatShortDate("2026-06-01", "2026")).toBe("Jun 1");
  expect(formatShortDate("2025-10-15", "2026")).toBe("Oct 15, 2025");
});

test("units drop trailing zeros, group thousands and use a true minus", () => {
  expect(formatUnits(10)).toBe("10");
  expect(formatUnits(2.5)).toBe("2.5");
  expect(formatUnits(0.123456789)).toBe("0.123457");
  expect(formatUnits(1234.5)).toBe("1,234.5");
  expect(formatUnits(-3)).toBe("−3");
});

import { formatCompactMoney, formatTime } from "./format";

test("compact money for axis labels", () => {
  expect(formatCompactMoney(150000, "CAD")).toBe("$150k");
  expect(formatCompactMoney(1234567, "CAD")).toBe("$1.2M");
  expect(formatCompactMoney(12.5, "CAD")).toBe("$12.50");
  expect(formatCompactMoney(-2500, "USD")).toBe("−US$2.5k");
});

test("times are shown in Toronto market time", () => {
  expect(formatTime("2026-10-15T14:30:00Z")).toBe("10:30 a.m.");
});

test("formatRelativeTime words the age in minutes, hours and days", async () => {
  const { formatRelativeTime } = await import("./format");
  const now = Date.parse("2026-10-21T12:00:00Z");
  expect(formatRelativeTime("2026-10-21T11:59:40Z", now)).toBe("just now");
  expect(formatRelativeTime("2026-10-21T11:55:00Z", now)).toBe("5 min ago");
  expect(formatRelativeTime("2026-10-21T09:00:00Z", now)).toBe("3 h ago");
  expect(formatRelativeTime("2026-10-19T12:00:00Z", now)).toBe("2 d ago");
  expect(formatRelativeTime("garbage", now)).toBe("garbage");
});
