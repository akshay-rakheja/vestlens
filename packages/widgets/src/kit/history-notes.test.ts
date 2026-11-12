import { historyNotes } from "./history-notes";

const accounts = [{ id: "a", label: "TFSA" }, { id: "b" }];

test("snapshots-only account yields a limited note with a reason phrase", () => {
  const n = historyNotes({ qualities: [{ accountId: "a", method: "snapshots_only", reason: "no_activity", driftFraction: null }], earliest: "2025-01-01", accounts, points: [{ source: "reported" }], currentYear: "2026" });
  expect(n).toMatchObject({ earliest: null, limited: true, snapshotsOnly: true, estimated: false, details: "TFSA: no activity history found", currentYear: "2026" });
});

test("estimated reconstruction reports drift and the earliest rebuilt date", () => {
  const n = historyNotes({ qualities: [{ accountId: "b", method: "reconstructed", reason: "drift", driftFraction: -0.12 }], earliest: "2025-01-01", accounts, points: [], currentYear: "2026" });
  expect(n.earliest).toBe("2025-01-01");
  expect(n.estimated).toBe(true);
  expect(n.details).toBe("Account: estimated, rebuilt value differs from reported by about 12%");
  expect(n.drift).toBe("differs from reported by about 12%");
});

test("a point-level estimate counts even with clean qualities", () => {
  const n = historyNotes({ qualities: [], earliest: null, accounts, points: [{ source: "estimated" }], currentYear: "2026" });
  expect(n.estimated).toBe(true);
  expect(n.limited).toBe(false);
});

test("a drift-guarded account is listed as snapshots-only with its reason", () => {
  const n = historyNotes({ qualities: [{ accountId: "a", method: "snapshots_only", reason: "drift_too_large", driftFraction: 1.37 }], earliest: null, accounts, points: [{ source: "reported" }], currentYear: "2026" });
  expect(n).toMatchObject({ limited: true, snapshotsOnly: true, estimated: false, earliest: null });
  expect(n.details).toBe("TFSA: rebuilt history didn't match the brokerage, so only snapshots are shown");
});

test("an anchored account explains the estimated starting cash balance", () => {
  const n = historyNotes({ qualities: [{ accountId: "a", method: "reconstructed", reason: "opening_cash", driftFraction: 0 }], earliest: "2025-01-01", accounts, points: [], currentYear: "2026" });
  expect(n).toMatchObject({ limited: true, estimated: true, snapshotsOnly: false });
  expect(n.details).toBe("TFSA: estimated, includes an estimated starting cash balance from before your activity history");
});
