/**
 * One-off runner for the counts-only data audit (see data-audit.ts). Run inside the app image (`docker compose run`):
 * `node dist/audit/data-audit-main.js`. It reads only the fields the audit needs and prints one JSON line of counts.
 */
import { PrismaClient } from "@prisma/client";

import { auditCounts } from "./data-audit.js";

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const day = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

async function main() {
  const prisma = new PrismaClient();
  try {
    const [users, accounts, activities, sync, dailyRows, snapshotCount] = await Promise.all([
      prisma.appUser.count(),
      prisma.brokerageAccount.findMany({ select: { appUserId: true, snapTradeAccountId: true, institutionName: true, rawType: true, category: true, status: true } }),
      prisma.activity.findMany({
        select: { appUserId: true, snapTradeAccountId: true, type: true, symbol: true, securityCurrency: true, currency: true, units: true, price: true, amount: true, fee: true, fxRate: true, tradeDate: true, description: true },
      }),
      prisma.activitySyncState.findMany({ select: { appUserId: true, snapTradeAccountId: true, backfillCompletedAt: true, lastSyncedAt: true, lastError: true, earliestTradeDate: true } }),
      prisma.dailyValue.groupBy({ by: ["appUserId", "date"] }),
      prisma.portfolioSnapshot.count(),
    ]);
    const daysPerUser = new Map<string, number>();
    for (const r of dailyRows) daysPerUser.set(r.appUserId, (daysPerUser.get(r.appUserId) ?? 0) + 1);
    const counts = auditCounts({
      today: new Date().toISOString().slice(0, 10),
      users,
      accounts,
      activities: activities.map((r) => ({
        appUserId: r.appUserId, snapTradeAccountId: r.snapTradeAccountId, type: r.type, symbolPresent: r.symbol !== null,
        securityCurrency: r.securityCurrency, currency: r.currency, units: num(r.units), price: num(r.price), amount: num(r.amount),
        fee: num(r.fee), fxRate: num(r.fxRate), tradeDate: day(r.tradeDate), description: r.description,
      })),
      sync: sync.map((s) => ({
        appUserId: s.appUserId, snapTradeAccountId: s.snapTradeAccountId, backfillCompleted: s.backfillCompletedAt !== null,
        lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null, lastError: s.lastError !== null, earliestTradeDate: day(s.earliestTradeDate),
      })),
      dailyValueDaysPerUser: [...daysPerUser.values()],
      snapshotCount,
    });
    process.stdout.write(`${JSON.stringify({ event: "data_audit", ...counts })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ event: "data_audit", code: "failed" })}\n`);
  process.exit(1);
});
