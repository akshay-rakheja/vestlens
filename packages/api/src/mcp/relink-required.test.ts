import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { PortfolioQueryResult } from "../portfolio/portfolio-query-service.js";
import { RELINK_NOTE, createPortfolioMcpServer } from "./portfolio-mcp-server.js";

// A user whose link a SnapTrade key switch cleared (spec 2026-10-28-snaptrade-key-switch-design.md).
const relink: PortfolioQueryResult = {
  connectionRequired: true, relinkRequired: true, generatedAt: "2026-11-02T12:00:00.000Z", accounts: [], errors: [],
};

async function connect(portfolio: PortfolioQueryResult) {
  const server = createPortfolioMcpServer({
    authSubject: "subject|synthetic-relink",
    portfolio: { getPortfolio: vi.fn(async () => portfolio) },
    history: { getAccountHistory: vi.fn(async () => ({})) },
  } as never);
  const client = new Client({ name: "synthetic-host", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const text = (result: unknown) => ((result as { content: Array<{ type: string; text: string }> }).content)
  .filter((b) => b.type === "text").map((b) => b.text).join("\n");

describe("MCP after a SnapTrade key switch", () => {
  for (const name of ["get_portfolio_snapshot", "list_portfolio_accounts", "show_portfolio"]) {
    it(`${name} asks the person to link again in text and keeps structured content within the cached schema`, async () => {
      const client = await connect(relink);
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain(RELINK_NOTE.trim());
      expect(result.structuredContent).toMatchObject({ connectionRequired: true });
      expect(result.structuredContent).not.toHaveProperty("relinkRequired");
    });
  }

  it("says nothing about relinking for an ordinary first connection", async () => {
    const client = await connect({ ...relink, relinkRequired: undefined });
    const result = await client.callTool({ name: "get_portfolio_snapshot", arguments: {} });
    expect(text(result)).not.toContain("link Wealthsimple again");
    expect(text(result)).not.toContain(RELINK_NOTE.trim());
  });
});
