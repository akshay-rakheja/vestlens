/**
 * The report card's data-version marker for one subject: the number of open (non-disabled) brokerage connections, the
 * latest stored activity sync and the latest portfolio snapshot. A deleted connection, a new sync or a new snapshot
 * changes it on every instance, so a cached report (report-cache.ts) is recomputed. Three indexed aggregates, read
 * together; no rows are read and nothing is logged.
 */
export interface ReportVersionPrismaPort {
  brokerageConnection: { count(input: { where: { appUser: { authSubject: string }; disabled: false } }): Promise<number> };
  activity: {
    aggregate(input: { where: { appUser: { authSubject: string } }; _max: { syncedAt: true } }): Promise<{ _max: { syncedAt: Date | null } }>;
  };
  portfolioSnapshot: {
    aggregate(input: { where: { appUser: { authSubject: string } }; _max: { capturedAt: true } }): Promise<{ _max: { capturedAt: Date | null } }>;
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : "-");

export async function reportDataVersion(prisma: ReportVersionPrismaPort, subject: string): Promise<string> {
  const appUser = { authSubject: subject };
  const [connections, activity, snapshot] = await Promise.all([
    prisma.brokerageConnection.count({ where: { appUser, disabled: false } }),
    prisma.activity.aggregate({ where: { appUser }, _max: { syncedAt: true } }),
    prisma.portfolioSnapshot.aggregate({ where: { appUser }, _max: { capturedAt: true } }),
  ]);
  return `${connections}|${iso(activity._max.syncedAt)}|${iso(snapshot._max.capturedAt)}`;
}
