/**
 * Prints the focused normal-mode MCP surface (instructions + tools/list) that a fully configured production
 * server offers, as JSON, for evaluating which tool a model picks for a question.
 * Every dependency is an inert stub: tools/list never calls one, and no database, provider or secret is touched.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createPortfolioMcpServer } from "../src/mcp/portfolio-mcp-server.js";

const stub = {} as never;
const server = createPortfolioMcpServer({
  authSubject: "synthetic-tool-list-export",
  scopes: ["portfolio:read", "memory"],
  portfolio: stub,
  history: stub,
  overview: stub, performance: stub, activity: stub, holdings: stub, allocation: stub, income: stub,
  news: stub, calendar: stub, alerts: stub,
  memory: stub, room: stub, portfolioFacts: stub,
  assets: { html: (name: string) => `<!doctype html><title>${name}</title>` },
  surface: "focused",
} as never);
const client = new Client({ name: "tool-list-export", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
const { tools } = await client.listTools();
process.stdout.write(JSON.stringify({ instructions: client.getInstructions(), tools }, null, 2) + "\n");
await client.close();
