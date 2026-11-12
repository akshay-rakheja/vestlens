import { describe, expect, it, vi } from "vitest";

import type { PortfolioQueryResult } from "../portfolio/portfolio-query-service.js";
import { createPortfolioApi } from "../http/app.js";
import { loopbackRequest } from "../testing/loopback-request.js";
import { memoryOwnerSessions } from "../testing/owner-session-prisma.js";
import express from "express";
import { handlePortfolioMcpRequest } from "./portfolio-mcp-server.js";

// Each MCP request builds a fresh server (stateless transport); the limit only works if they share one limiter.
// This file has its own module instance, so the process-wide limiter starts empty here.
describe("HTTP /mcp tool rate limit", () => {
  it("per-request servers share the process-wide limiter: the 61st call for a subject is the isError result", async () => {
    const mcpVerifier = {
      verify: vi.fn(async (token: string) => ({
        subject: token === "user-b" ? "rate-http-b" : "rate-http-a",
        scopes: new Set(["portfolio:read", "connections:manage"]),
      })),
    };
    const portfolio = {
      getPortfolio: vi.fn(async (): Promise<PortfolioQueryResult> => ({ connectionRequired: false, generatedAt: "2026-10-21T20:00:00.000Z", accounts: [], errors: [] })),
    };
    const app = createPortfolioApi({
      sessions: memoryOwnerSessions(),
      gateway: { router: express.Router(), mcpVerifier, issuer: "https://portfolio.example.com" },
      portfolio,
      history: { getAccountHistory: vi.fn(async () => ({})) },
      connections: { getConnections: vi.fn(async (): Promise<unknown[]> => []), createConnectionPortal: vi.fn(async () => "https://connect.snaptrade.com/session") },
      webhooks: { ingest: vi.fn(async () => ({ duplicate: false })) },
      appBaseUrl: "https://portfolio.example.com",
    } as never);
    const local = await loopbackRequest(app);
    const call = (token: string) => local.post("/mcp").set("Authorization", `Bearer ${token}`).set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_portfolio_accounts", arguments: {} } });
    for (let i = 0; i < 60; i++) {
      const ok = await call("user-a");
      expect(ok.status).toBe(200);
      expect(ok.body.result.isError).not.toBe(true);
    }
    const over = await call("user-a");
    expect(over.status).toBe(200);
    expect(over.body.result).toEqual({ content: [{ type: "text", text: "Too many requests; try again in a minute." }], isError: true });
    expect(portfolio.getPortfolio).toHaveBeenCalledTimes(60);
    const other = await call("user-b");
    expect(other.body.result.isError).not.toBe(true);
  });

  it("an explicit toolLimiter: undefined still falls back to the process-wide limiter", async () => {
    const getPortfolio = vi.fn(async (): Promise<PortfolioQueryResult> => ({ connectionRequired: false, generatedAt: "2026-10-21T20:00:00.000Z", accounts: [], errors: [] }));
    const app = express();
    app.use(express.json());
    app.post("/mcp", async (request, response) => {
      await handlePortfolioMcpRequest(request, response, {
        authSubject: "rate-http-undefined", portfolio: { getPortfolio }, history: { getAccountHistory: vi.fn() }, toolLimiter: undefined,
      });
    });
    const local = await loopbackRequest(app);
    let last: any;
    for (let i = 0; i < 61; i++) {
      last = await local.post("/mcp").set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_portfolio_accounts", arguments: {} } });
    }
    expect(last.body.result).toEqual({ content: [{ type: "text", text: "Too many requests; try again in a minute." }], isError: true });
    expect(getPortfolio).toHaveBeenCalledTimes(60);
  });
});
