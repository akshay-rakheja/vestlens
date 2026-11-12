import { describe, expect, it, vi } from "vitest";

import { miniSyntheticAccount } from "../testing/mini-synthetic-fixtures.js";
import {
  PrismaLastGoodPortfolioStore,
  type LastGoodPrismaPort,
  type LastGoodAccountRow,
} from "./prisma-last-good-portfolio-store.js";

const SUBJECT = "subject|synthetic-last-good";

// Mirrors the payload written by PrismaPortfolioStateRepository.
function payloadFor(index: number) {
  const account = miniSyntheticAccount(index);
  return {
    account: {
      id: account.account.id,
      name: account.account.name,
      institution: account.account.institution,
      type: account.account.type,
      category: account.account.category,
      metaType: account.account.metaType,
      unifiedType: account.account.unifiedType,
      status: account.account.status,
      isPaper: account.account.isPaper,
      reportedTotal: account.account.reportedTotal,
    },
    balances: account.balances,
    positions: account.positions,
    calculatedValueByCurrency: account.calculatedValueByCurrency,
    freshness: account.freshness,
    warnings: account.warnings,
  };
}

function row(index: number, capturedAt: string, overrides: Partial<LastGoodAccountRow> = {}): LastGoodAccountRow {
  return {
    snapTradeAccountId: `MINI-SYNTHETIC-ACCOUNT-${index}`,
    maskedNumber: "••••0097",
    connection: { snapTradeConnectionId: `MINI-SYNTHETIC-CONNECTION-${index}`, disabled: false },
    snapshots: [{ payload: payloadFor(index), capturedAt: new Date(capturedAt) }],
    ...overrides,
  };
}

function store(rows: LastGoodAccountRow[]) {
  const prisma: LastGoodPrismaPort = { brokerageAccount: { findMany: vi.fn(async () => rows) } };
  return { prisma, store: new PrismaLastGoodPortfolioStore(prisma) };
}

describe("PrismaLastGoodPortfolioStore", () => {
  it("rebuilds the latest snapshot of each account for the subject only", async () => {
    const { prisma, store: lastGood } = store([
      row(0, "2026-10-14T09:00:00.000Z"),
      row(1, "2026-10-14T08:00:00.000Z"),
    ]);
    const result = await lastGood.load(SUBJECT);
    expect(prisma.brokerageAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { appUser: { authSubject: SUBJECT } },
    }));
    expect(result?.connectionRequired).toBe(false);
    expect(result?.accounts.map((account) => account.account.id)).toEqual(["MINI-SYNTHETIC-ACCOUNT-0", "MINI-SYNTHETIC-ACCOUNT-1"]);
    expect(result?.accounts[0].account.connectionId).toBe("MINI-SYNTHETIC-CONNECTION-0");
    expect(result?.accounts[0].account.number).toBe("••••0097");
    expect(result?.accounts[0].positions).toEqual(miniSyntheticAccount(0).positions);
    // The oldest capture bounds how stale the combined view may be.
    expect(result?.generatedAt).toBe("2026-10-14T08:00:00.000Z");
    expect(result?.accounts[0].warnings.at(-1)).toMatch(/saved snapshot/i);
  });

  it("skips disabled connections, accounts without snapshots and malformed payloads", async () => {
    const { store: lastGood } = store([
      row(0, "2026-10-14T09:00:00.000Z", { connection: { snapTradeConnectionId: "MINI-SYNTHETIC-CONNECTION-0", disabled: true } }),
      row(1, "2026-10-14T09:00:00.000Z", { snapshots: [] }),
      row(2, "2026-10-14T09:00:00.000Z", { snapshots: [{ payload: { account: { id: 7 } }, capturedAt: new Date("2026-10-14T09:00:00.000Z") }] }),
      row(3, "2026-10-14T09:30:00.000Z"),
    ]);
    const result = await lastGood.load(SUBJECT);
    expect(result?.accounts.map((account) => account.account.id)).toEqual(["MINI-SYNTHETIC-ACCOUNT-3"]);
  });

  it("returns null when nothing usable is stored", async () => {
    const { store: lastGood } = store([]);
    await expect(lastGood.load(SUBJECT)).resolves.toBeNull();
  });
});
