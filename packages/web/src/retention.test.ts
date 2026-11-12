import { describe, expect, it } from "vitest";

import { BACKUP_DAYS, RETENTION_DAYS, retentionCopy } from "./retention";

// The drift check against packages/api/src/data-controls/retention.ts lives in the API package
// (web-retention-drift.test.ts), which has Node types; the web build has none.
describe("retention copy", () => {
  it("states the periods and that backups age out within 14 days", () => {
    expect(BACKUP_DAYS).toBe(14);
    const copy = retentionCopy();
    expect(copy).toContain(`${RETENTION_DAYS.snapshots} days`);
    expect(copy).toContain(`${RETENTION_DAYS.webhookEvents} days`);
    expect(copy).toContain("Deleted data leaves our backups within 14 days.");
  });
});
