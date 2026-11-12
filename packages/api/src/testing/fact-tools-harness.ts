import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { vi } from "vitest";

import { OWNER_SUBJECT } from "../identity/owner-identity.js";
import { MemoryService, type MemoryLogEvent } from "../memory/memory-service.js";
import { createPortfolioMcpServer } from "../mcp/portfolio-mcp-server.js";
import type { PortfolioFactDeps, PortfolioFactLogEvent } from "../mcp/portfolio-fact-tools.js";
import type { NormalizedAccountPortfolio } from "../portfolio/normalize.js";
import { MemoryFactRepository } from "./memory-fact-repository.js";

/**
 * Synthetic harness for the thesis, limit and goal tools through the MCP server: generated accounts, symbols and
 * amounts only, in-memory memory store, fake stored-data ports. Nothing reaches a provider or a database.
 */

/** Every subject is the owner now; the REST routes cannot see any other. */
export const FACT_SUBJECT = OWNER_SUBJECT;
export const FACT_NOW = new Date("2026-10-23T16:00:00Z");
export const TFSA_ID = "SYNTHETIC-FACT-TFSA";
export const RRSP_ID = "SYNTHETIC-FACT-RRSP";

type Position = NormalizedAccountPortfolio["positions"][number];
const position = (symbol: string, units: number, price: number, currency = "CAD", kind = "stock"): Position => ({
  instrumentId: `SYN-${symbol}`, kind, symbol, description: "Synthetic position", units, price, costBasis: null,
  marketValue: units * price, unrealizedGain: null, currency, cashEquivalent: false,
} as Position);

export function syntheticAccount(id: string, type: string, unifiedType: string, positions: Position[], cash: number, name: string, status = "open"): NormalizedAccountPortfolio {
  const total = positions.reduce((s, p) => s + (p.marketValue ?? 0), 0) + cash;
  return {
    account: {
      id, connectionId: `${id}-CONN`, number: "700000001", name, institution: "Synthetic brokerage fixture", type, category: "SYNTHETIC",
      metaType: null, unifiedType, status, isPaper: true, reportedTotal: { currency: "CAD", amount: total },
    },
    balances: [{ currency: "CAD", cash, buyingPower: null }],
    positions,
    calculatedValueByCurrency: { CAD: total },
    freshness: { positionsAsOf: "2026-10-22T21:00:00.000Z", holdingsLastSyncedAt: null, initialSyncCompleted: true, holdingsUnavailable: false },
    warnings: [],
  } as NormalizedAccountPortfolio;
}

/** SHOP.TO is 1,200 of 3,000 (40%); XEQT.TO 1,500; cash 300. */
export const defaultAccounts = () => [
  syntheticAccount(TFSA_ID, "TFSA", "SELF_DIRECTED_TFSA", [position("SHOP.TO", 10, 120)], 100, "My TFSA"),
  syntheticAccount(RRSP_ID, "RRSP", "SELF_DIRECTED_RRSP", [position("XEQT.TO", 50, 30, "CAD", "etf")], 200, "My RRSP"),
];

const dates = (from: string, to: string) => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

export interface HarnessOptions {
  scopes?: string[];
  validation?: unknown;
  /** Also compose holdings, allocation and the widget builds (for the status lines and widget binding). */
  widgets?: boolean;
  /** Leave out the fact tool deps. */
  noFacts?: boolean;
  accounts?: NormalizedAccountPortfolio[];
  activities?: Array<Record<string, unknown>>;
  html?: (name: string) => string | null;
  surface?: "full" | "focused";
  /** show_report_card's runner (report-routes.ts createReportCardRunner, or a fake). */
  reportCard?: unknown;
}

export async function connectFacts(o: HarnessOptions = {}) {
  const repository = new MemoryFactRepository();
  const memoryEvents: MemoryLogEvent[] = [];
  // One clock for the memory store and the tools; tests move it to tell a later save from an earlier one.
  const clock = { now: FACT_NOW, set(d: Date) { clock.now = d; } };
  const service = new MemoryService({ repository, log: (e) => memoryEvents.push(e), now: () => clock.now });
  const accounts = o.accounts ?? defaultAccounts();
  const portfolio = { getPortfolio: vi.fn(async () => ({ connectionRequired: false, generatedAt: FACT_NOW.toISOString(), accounts, errors: [] })) };
  const activities = (o.activities ?? [
    { snapTradeAccountId: TFSA_ID, dedupeKey: "dep-1", type: "DEPOSIT", symbol: null, amount: 600, currency: "CAD", tradeDate: new Date("2026-08-03T00:00:00Z") },
  ]).map((a) => ({
    securityCurrency: null, isOption: false, units: null, price: null, fee: null, fxRate: null, settlementDate: null, ...a,
  }));
  const events: PortfolioFactLogEvent[] = [];
  const marketCalls: string[] = [];
  const facts: PortfolioFactDeps = {
    prisma: {
      activity: {
        findMany: vi.fn(async (input: any) => activities.filter((a: any) =>
          input.where.symbol ? (a.symbol ?? "").toUpperCase() === input.where.symbol.equals.toUpperCase() : input.where.snapTradeAccountId.in.includes(a.snapTradeAccountId))) as never,
      },
      activitySyncState: {
        findMany: vi.fn(async () => accounts.map((a) => ({
          snapTradeAccountId: a.account.id, backfillCompletedAt: new Date("2026-01-01T00:00:00Z"), earliestTradeDate: new Date("2024-01-02T00:00:00Z"),
          lastSyncedAt: new Date(FACT_NOW.getTime() - 3_600_000), lastError: null,
        }))),
      },
      brokerageAccount: { findMany: vi.fn(async () => accounts.map((a) => ({ snapTradeAccountId: a.account.id, createdAt: new Date("2025-01-01T00:00:00Z") }))) },
      portfolioSnapshot: { findMany: vi.fn(async () => []) },
    } as never,
    dailyValues: { rows: vi.fn(async () => []) },
    market: {
      history: vi.fn(async (ticker: string, from: string, to: string) => { marketCalls.push(`history:${ticker}`); return dates(from, to).map((date) => ({ date, close: 100 })); }) as never,
      usdCad: vi.fn(async (from: string, to: string) => { marketCalls.push("usdCad"); return dates(from, to).map((date) => ({ date, close: 1.35 })); }),
      cachedProfileLookup: vi.fn(async () => ({ profile: null })) as never,
    },
    now: () => clock.now,
    log: (e) => events.push(e),
  };
  const settings = { get: vi.fn(async () => ({ benchmark: "sp500", cadView: false, privacyDefault: false })), save: vi.fn() };
  const widgetDeps = o.widgets ? {
    overview: {
      market: { history: vi.fn(async () => null), usdCad: vi.fn(async () => null), quotes: vi.fn(async () => new Map()) },
      settings, dailyValues: { rows: vi.fn(async () => []), earliest: vi.fn(async () => null) }, now: () => FACT_NOW,
    },
    holdings: { market: { quotes: vi.fn(async () => new Map()), usdCad: vi.fn(async () => [{ date: "2026-10-22", close: 1.35 }]) }, settings, now: () => FACT_NOW },
    allocation: { market: { usdCad: vi.fn(async () => [{ date: "2026-10-22", close: 1.35 }]), profile: vi.fn(async () => null) }, settings, now: () => FACT_NOW },
    assets: { html: o.html ?? ((name: string) => `<!doctype html><title>${name}</title>`) },
  } : {};
  const server = createPortfolioMcpServer({
    authSubject: FACT_SUBJECT,
    scopes: o.scopes ?? ["portfolio:read", "memory"],
    portfolio,
    history: { getAccountHistory: vi.fn(async () => ({})) },
    memory: { service },
    ...(o.noFacts ? {} : { portfolioFacts: facts }),
    ...widgetDeps,
    clientKey: "https://claude.ai/oauth/mcp-oauth-client-metadata",
    ...(o.validation ? { validation: o.validation } : {}),
    ...(o.surface ? { surface: o.surface } : {}),
    ...(o.reportCard ? { reportCard: o.reportCard } : {}),
  } as never);
  const client = new Client({ name: "synthetic-host", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, repository, service, portfolio, facts, events, memoryEvents, marketCalls, clock };
}

type TextBlock = { type: string; text: string };
export const texts = (result: unknown) => ((result as { content?: TextBlock[] }).content ?? []).filter((b) => b.type === "text").map((b) => b.text);
export const firstText = (result: unknown) => texts(result)[0] ?? "";
