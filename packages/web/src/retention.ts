/**
 * Retention periods quoted on the Account page. Mirrors packages/api/src/data-controls/retention.ts;
 * retention.test.ts reads that file and fails if these drift.
 */
export const RETENTION_DAYS = { snapshots: 90, webhookEvents: 30 } as const;

/** Deleted data leaves backups within this many days (14 daily backups). */
export const BACKUP_DAYS = 14;

export function retentionCopy(): string {
  return (
    `Account snapshots are kept for ${RETENTION_DAYS.snapshots} days (the latest one for each connected account ` +
    `is kept as an offline fallback) and SnapTrade notifications for ${RETENTION_DAYS.webhookEvents} days, then ` +
    `deleted automatically. Holdings history stays until you disconnect or delete your data. ` +
    `Deleted data leaves our backups within ${BACKUP_DAYS} days.`
  );
}
