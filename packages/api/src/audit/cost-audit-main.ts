/**
 * One-off runner for the counts-only cost-base audit (see cost-audit.ts). Run inside the app image (`docker compose run`):
 * `node dist/audit/cost-audit-main.js`. Reads stored activities and each account's latest snapshot, fetches the
 * public Bank of Canada USD/CAD series, and prints one JSON line of counts.
 */
import { PrismaClient } from "@prisma/client";

import { homeConverter } from "../fx/home-currency.js";
import { BankOfCanadaFx } from "../market-data/bank-of-canada.js";
import { costAudit, type CostAuditPosition } from "./cost-audit.js";

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const day = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function positionsOf(appUserId: string, snapTradeAccountId: string, payload: unknown): CostAuditPosition[] {
  const list = (payload as { positions?: unknown } | null)?.positions;
  if (!Array.isArray(list)) return [];
  return list.flatMap((p: Record<string, unknown>) => {
    const symbol = str(p?.symbol);
    if (!symbol) return [];
    return [{
      appUserId, snapTradeAccountId, symbol, kind: str(p.kind) ?? "unknown",
      units: finite(p.units), costBasis: finite(p.costBasis), currency: str(p.currency), cashEquivalent: p.cashEquivalent === true,
    }];
  });
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [accounts, activities, snapshots] = await Promise.all([
      prisma.brokerageAccount.findMany({ select: { appUserId: true, snapTradeAccountId: true, rawType: true } }),
      prisma.activity.findMany(),
      prisma.portfolioSnapshot.findMany({
        orderBy: { capturedAt: "desc" }, distinct: ["appUserId", "snapTradeAccountId"],
        select: { appUserId: true, snapTradeAccountId: true, payload: true },
      }),
    ]);
    const earliest = activities.map((r) => day(r.tradeDate ?? r.settlementDate)).filter((d): d is string => !!d).sort()[0] ?? today;
    const from = new Date(Date.parse(`${earliest}T00:00:00Z`) - 10 * 86_400_000).toISOString().slice(0, 10);
    const series = await new BankOfCanadaFx(fetch, 20_000).usdCad(from, today);
    const counts = costAudit({
      taxYear: today.slice(0, 4),
      conv: homeConverter(series, today),
      accounts,
      positions: snapshots.flatMap((s) => positionsOf(s.appUserId, s.snapTradeAccountId, s.payload)),
      activities: activities.map((r) => ({
        appUserId: r.appUserId, snapTradeAccountId: r.snapTradeAccountId, dedupeKey: r.dedupeKey, type: r.type, symbol: r.symbol,
        securityCurrency: r.securityCurrency, isOption: r.isOption, units: num(r.units), price: num(r.price), amount: num(r.amount),
        fee: num(r.fee), fxRate: num(r.fxRate), currency: r.currency, tradeDate: day(r.tradeDate), settlementDate: day(r.settlementDate), description: null,
      })),
    });
    process.stdout.write(`${JSON.stringify({ event: "cost_audit", rateDays: series.length, ...counts })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ event: "cost_audit", code: "failed" })}\n`);
  process.exit(1);
});
