import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { miniSyntheticAccount } from "../testing/mini-synthetic-fixtures.js";
import { loopbackRequest } from "../testing/loopback-request.js";
import { createPortfolioMcpServer } from "../mcp/portfolio-mcp-server.js";
import { memoryOwnerSessions } from "../testing/owner-session-prisma.js";
import { sessionCookieFor } from "../testing/owner-session.js";
import { OWNER_SUBJECT } from "../identity/owner-identity.js";
import { createPortfolioApi } from "./app.js";

const SUBJECT = OWNER_SUBJECT;
const portfolioResult = { connectionRequired: false, generatedAt: "2026-10-23T12:00:00.000Z", accounts: [miniSyntheticAccount(0)], errors: [] };

describe("reading the portfolio with no consent records", () => {
  it("reads the portfolio with no consent records", async () => {
    const portfolio = { getPortfolio: vi.fn(async () => portfolioResult) };
    const sessions = memoryOwnerSessions();
    const app = createPortfolioApi({
      sessions,
      portfolio,
      history: { getAccountHistory: vi.fn(async () => ({})) },
      connections: { getConnections: vi.fn(async () => []), createConnectionPortal: vi.fn(async () => "https://x.invalid") },
      webhooks: { ingest: vi.fn(async () => ({ duplicate: false })) },
      appBaseUrl: "https://vestlens.example.test",
    } as never);
    const res = await (await loopbackRequest(app)).get("/api/portfolio").set("Cookie", await sessionCookieFor(sessions));
    expect(res.status).toBe(200);
    expect(portfolio.getPortfolio).toHaveBeenCalled();
  });

  it("returns snapshot data over MCP with no needs_consent content", async () => {
    const server = createPortfolioMcpServer({
      authSubject: SUBJECT,
      portfolio: { getPortfolio: vi.fn(async () => portfolioResult) },
      history: { getAccountHistory: vi.fn(async () => ({})) },
    } as never);
    const client = new Client({ name: "synthetic-host", version: "1.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    const result = await client.callTool({ name: "get_portfolio_snapshot", arguments: {} });
    expect(JSON.stringify(result)).not.toMatch(/needsConsent|needs_consent/);
    expect(result.isError).not.toBe(true);
  });
});
