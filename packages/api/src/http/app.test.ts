import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import { loopbackRequest } from "../testing/loopback-request.js";
import { describe, expect, it, vi } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import {
  InvalidAccessTokenError,
  MissingRequiredScopeError,
} from "../auth/token-types.js";
import { OWNER_SUBJECT } from "../identity/owner-identity.js";
import { memoryOwnerSessions } from "../testing/owner-session-prisma.js";
import { sessionCookieFor } from "../testing/owner-session.js";
import { PortfolioAccountNotFoundError } from "../portfolio/portfolio-history-service.js";
import type { PortfolioQueryResult } from "../portfolio/portfolio-query-service.js";
import { InvalidSnapTradeWebhookError } from "../snaptrade/webhook-ingestion-service.js";
import { createPortfolioApi } from "./app.js";
import { SnapTradeKeyRejectedError } from "../snaptrade/gateway.js";
import { DataControlError } from "../data-controls/data-control-service.js";
import { createWidgetLoader } from "../mcp/widget-loader.js";

function dependencies() {
  const mcpVerifier = {
    verify: vi.fn(async (token: string, scopes: readonly string[]) => {
      if (token === "invalid") throw new InvalidAccessTokenError();
      if (token === "portfolio-only" && scopes.includes("connections:manage")) {
        throw new MissingRequiredScopeError("connections:manage");
      }
      if (token === "connection-only" && scopes.includes("portfolio:read")) {
        throw new MissingRequiredScopeError("portfolio:read");
      }
      return {
        subject: token === "user-b" ? "synthetic-user-b" : OWNER_SUBJECT,
        scopes: new Set(["portfolio:read", "connections:manage"]),
      };
    }),
  };
  const portfolio = {
    getPortfolio: vi.fn(async (_authSubject: string): Promise<PortfolioQueryResult> => ({
      connectionRequired: false,
      generatedAt: "2026-08-19T15:00:00.000Z",
      accounts: [],
      errors: [],
    })),
  };
  const connections = {
    getConnections: vi.fn(async (): Promise<unknown[]> => []),
    createConnectionPortal: vi.fn(
      async () => "https://connect.snaptrade.com/session",
    ),
  };
  const webhooks = {
    ingest: vi.fn(async () => ({ duplicate: false })),
  };
  const history = {
    getAccountHistory: vi.fn(async () => ({
      accountId: "account-1",
      generatedAt: "2026-08-20T16:00:00.000Z",
      orders: [],
      activities: {
        items: [],
        pagination: { offset: 0, limit: 50, total: 0 },
      },
      balanceHistory: { currency: "CAD", points: [] },
      analytics: {
        orderStatusCounts: {},
        pageActivityTotals: [],
        balanceChangeIncludingDeposits: null,
      },
      freshness: {
        orders: "Brokerage dependent: real-time when enabled, otherwise daily.",
        activities: "Daily SnapTrade data.",
        balanceHistory:
          "Experimental SnapTrade estimate; maximum one-year lookback.",
      },
      errors: [],
    })),
  };
  return { mcpVerifier, portfolio, history, connections, webhooks };
}

const configuration = {
  appBaseUrl: "https://portfolio.example.com",
};

const sessions = memoryOwnerSessions();
/** The dashboard's browser headers: the owner session cookie and this app's own Origin (required on writes). */
const owner = async () => ({ Cookie: await sessionCookieFor(sessions), Origin: configuration.appBaseUrl });

/**
 * createPortfolioApi with the owner session store, and `mcpVerifier` (the mock below) standing in for the gateway's
 * /mcp verifier. A test that passes its own `gateway` keeps it.
 */
function createApi(options: Record<string, unknown> & { mcpVerifier?: unknown; noGateway?: boolean }) {
  const { mcpVerifier, noGateway, ...rest } = options;
  return createPortfolioApi({
    sessions,
    ...(rest.gateway || !mcpVerifier || noGateway ? {} : { gateway: { router: express.Router(), mcpVerifier, issuer: configuration.appBaseUrl } }),
    ...rest,
  } as never);
}

async function createStaticAssets() {
  const directory = await mkdtemp(join(tmpdir(), "portfolio-web-"));
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><main>Your portfolio, connected.</main><div id="root"></div>',
  );
  await writeFile(join(directory, "app.js"), "window.portfolioApp = true;");
  return directory;
}

describe("portfolio HTTP API", () => {
  for (const path of ["/mcp", "/mcp/", "/MCP"]) {
    for (const method of ["post", "get", "delete"] as const) {
      for (const auth of [
        { token: undefined, status: 401, error: "authentication_required" },
        { token: "invalid", status: 401, error: "invalid_token" },
        { token: "connection-only", status: 403, error: "insufficient_scope" },
      ]) {
        it(`keeps MCP discovery for ${method} ${path} with ${auth.error}`, async () => {
          const deps = dependencies();
          const app = createApi({
            ...deps, ...configuration, mcpResourceUrl: "https://mcp.example.invalid/mcp",
          });
          const request = (await loopbackRequest(app))[method](path);
          if (auth.token) request.set("Authorization", `Bearer ${auth.token}`);
          const response = await request.send({}).expect(auth.status);
          expect(response.body).toEqual({ error: auth.error });
          expect(response.headers["www-authenticate"]).toContain(
            'resource_metadata="https://mcp.example.invalid/.well-known/oauth-protected-resource/mcp"',
          );
          expect(response.headers["www-authenticate"]).not.toContain("connections:manage");
          if (auth.error === "insufficient_scope") {
            expect(response.headers["www-authenticate"]).toContain('scope="portfolio:read"');
          }
          if (auth.token) expect(deps.mcpVerifier.verify).toHaveBeenCalledWith(auth.token, ["portfolio:read"]);
          else expect(deps.mcpVerifier.verify).not.toHaveBeenCalled();
          for (const service of [deps.portfolio.getPortfolio, deps.history.getAccountHistory,
            deps.connections.getConnections, deps.connections.createConnectionPortal, deps.webhooks.ingest]) {
            expect(service).not.toHaveBeenCalled();
          }
        });
      }
    }
  }

  it("serves a dedicated MCP resource naming the gateway issuer, without a provider call", async () => {
    const deps = dependencies();
    const resource = "https://portfolio.example.com/mcp";
    const app = createApi({ ...deps, ...configuration, mcpResourceUrl: resource });
    const result = await (await loopbackRequest(app)).get("/.well-known/oauth-protected-resource/mcp").expect(200);
    expect(result.body).toEqual({ resource, authorization_servers: [configuration.appBaseUrl], scopes_supported: ["portfolio:read", "memory"], bearer_methods_supported: ["header"] });
    expect(deps.portfolio.getPortfolio).not.toHaveBeenCalled();
    expect(deps.connections.getConnections).not.toHaveBeenCalled();
  });

  it("rejects malformed arguments for every MCP tool before data access", async () => {
    const deps = dependencies();
    const app = createApi({ ...deps, ...configuration });
    for (const [name, args] of [
      ["get_portfolio_snapshot", { extra: "INVENTED-PRIVATE-INPUT" }],
      ["list_portfolio_accounts", { extra: true }],
      ["show_portfolio", { accountId: "invented-other" }],
      ["get_account_positions", { accountId: " " }],
      ["get_account_history", { accountId: "invented", orderDays: "90" }],
      ["get_account_history", { accountId: "invented", orderDays: 91 }],
      ["get_account_history", { accountId: "invented", activityStartDate: "not-a-date" }],
      ["get_account_history", { accountId: "invented", transfer: true }],
      ["execute_trade_INVENTED-PRIVATE-INPUT", {}],
    ] as const) {
      const response = await (await loopbackRequest(app)).post("/mcp").set("Authorization", "Bearer valid-token").set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }).expect(200);
      expect(response.body.error.code).toBe(-32602);
      expect(JSON.stringify(response.body)).not.toContain("INVENTED-PRIVATE-INPUT");
    }
    expect(deps.portfolio.getPortfolio).not.toHaveBeenCalled();
    expect(deps.history.getAccountHistory).not.toHaveBeenCalled();
  });

  it("redacts unexpected MCP data errors and rejects unknown resources", async () => {
    const deps = dependencies();
    const app = createApi({ ...deps, ...configuration });
    const local = await loopbackRequest(app);
    for (const [name, error] of [["show_portfolio", new Error("INVENTED-PRIVATE-PROVIDER-DETAIL")], ["get_portfolio_snapshot", new McpError(ErrorCode.InternalError, "INVENTED-PRIVATE-PROVIDER-DETAIL")]] as const) {
      deps.portfolio.getPortfolio.mockRejectedValue(error);
      const params = { name, arguments: {} };
      const response = await local.post("/mcp").set("Authorization", "Bearer valid-token").set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params }).expect(200);
      expect(response.body.result.isError).toBe(true);
      expect(JSON.stringify(response.body)).not.toContain("INVENTED-PRIVATE");
    }
    const response = await local.post("/mcp").set("Authorization", "Bearer valid-token").set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://INVENTED-PRIVATE-RESOURCE" } }).expect(200);
    expect(response.body.error.code).toBe(-32602);
    expect(JSON.stringify(response.body)).not.toContain("INVENTED-PRIVATE");
  });
  it("publishes OAuth protected-resource metadata without authentication", async () => {
    const deps = dependencies();
    const app = createApi({ ...deps, ...configuration });

    const response = await (await loopbackRequest(app)).get(
      "/.well-known/oauth-protected-resource",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      resource: "https://portfolio.example.com/",
      authorization_servers: [configuration.appBaseUrl],
      scopes_supported: ["portfolio:read", "memory"],
      bearer_methods_supported: ["header"],
    });
  });

  it("has no validation or demo routes", async () => {
    const request = await loopbackRequest(createApi({ ...dependencies(), ...configuration }));
    expect((await request.get("/api/validation/status")).status).toBe(404);
    expect((await request.get("/.well-known/openai-apps-challenge")).status).toBe(404);
  });
  it("serves the dashboard at / and has no growth routes", async () => {
    const staticAssetsDirectory = await createStaticAssets();
    try {
      const request = await loopbackRequest(createApi({ ...dependencies(), ...configuration, staticAssetsDirectory }));
      const root = await request.get("/").set("Accept", "text/html");
      expect(root.status).toBe(200);
      expect(root.text).toContain('<div id="root"></div>');
      expect((await request.post("/api/waitlist").send({ list: "early_access", email: "someone@example.test" })).status).toBe(404);
      expect((await request.get("/api/early-access")).status).toBe(404);
      expect((await request.get("/.well-known/security.txt")).status).toBe(404);
    } finally {
      await rm(staticAssetsDirectory, { recursive: true, force: true });
    }
  });

  it("answers unauthenticated portfolio requests with 401 and no OAuth challenge", async () => {
    const app = createApi({ ...dependencies(), ...configuration });

    const response = await (await loopbackRequest(app)).get("/api/portfolio");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "authentication_required" });
    expect(response.headers["www-authenticate"]).toBeUndefined();
  });

  it("queries only the authenticated subject with portfolio read scope", async () => {
    const deps = dependencies();
    const app = createApi({ ...deps, ...configuration });

    const response = await (await loopbackRequest(app))
      .get("/api/portfolio")
      .set(await owner());

    expect(response.status).toBe(200);
    expect(deps.mcpVerifier.verify).not.toHaveBeenCalled();
    expect(deps.portfolio.getPortfolio).toHaveBeenCalledWith(OWNER_SUBJECT);
  });

  it("returns the authoritative classified portfolio presentation", async () => {
    const deps = dependencies();
    deps.portfolio.getPortfolio.mockResolvedValueOnce({
      connectionRequired: false,
      generatedAt: "2026-08-26T20:05:00.000Z",
      accounts: [
        {
          account: {
            id: "margin-account",
            connectionId: "private-connection",
            name: "Personal",
            number: "private-number",
            institution: "Wealthsimple",
            type: "PERSONAL",
            category: "INVESTMENT",
            metaType: "non_registered",
            unifiedType: "SELF_DIRECTED_NON_REGISTERED_MARGIN",
            status: "open",
            isPaper: false,
            reportedTotal: { amount: 1200, currency: "CAD" },
          },
          balances: [
            { currency: "CAD", cash: 200, buyingPower: 250 },
            { currency: "USD", cash: 15, buyingPower: null },
          ],
          positions: [],
          calculatedValueByCurrency: { CAD: 300, USD: 15 },
          freshness: {
            positionsAsOf: "2026-08-26T20:00:00.000Z",
            holdingsLastSyncedAt: "2026-08-26T19:55:00.000Z",
            initialSyncCompleted: true,
            holdingsUnavailable: false,
          },
          warnings: [],
        },
      ],
      errors: [],
    });
    const app = createApi({ ...deps, ...configuration });

    const response = await (await loopbackRequest(app))
      .get("/api/portfolio")
      .set(await owner());

    expect(response.status).toBe(200);
    expect(response.body.totals).toEqual([
      { currency: "CAD", amount: 1200, source: "brokerage_reported" },
    ]);
    expect(response.body.accounts[0]).toMatchObject({
      id: "margin-account",
      classification: {
        group: "non_registered",
        bucket: "margin",
        label: "Margin account",
        includedInPortfolioTotal: true,
      },
      value: {
        amount: 1200,
        currency: "CAD",
        source: "brokerage_reported",
      },
      balances: [
        { currency: "CAD", cash: 200, buyingPower: 250 },
        { currency: "USD", cash: 15, buyingPower: null },
      ],
      reconciliation: {
        calculatedByCurrency: [
          { currency: "CAD", amount: 300 },
          { currency: "USD", amount: 15 },
        ],
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("private-connection");
    expect(JSON.stringify(response.body)).not.toContain("private-number");
  });

  it("queries normalized account history only for the authenticated subject", async () => {
    const deps = dependencies();
    const app = createApi({ ...deps, ...configuration });

    const response = await (await loopbackRequest(app))
      .get("/api/accounts/account-1/history")
      .query({
        orderState: "executed",
        orderDays: "45",
        activityStartDate: "2026-08-01T00:00:00.000Z",
        activityEndDate: "2026-08-20T00:00:00.000Z",
        activityLimit: "50",
      })
      .set(await owner());

    expect(response.status).toBe(200);
    expect(deps.history.getAccountHistory).toHaveBeenCalledWith(
      OWNER_SUBJECT,
      "account-1",
      {
        orders: { state: "executed", days: 45 },
        activities: {
          startDate: "2026-08-01T00:00:00.000Z",
          endDate: "2026-08-20T00:00:00.000Z",
          limit: 50,
        },
      },
    );
  });

  it("does not reveal whether an unowned account exists", async () => {
    const deps = dependencies();
    deps.history.getAccountHistory.mockRejectedValueOnce(
      new PortfolioAccountNotFoundError(),
    );
    const app = createApi({ ...deps, ...configuration });

    const response = await (await loopbackRequest(app))
      .get("/api/accounts/account-from-user-b/history")
      .set(await owner());

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "account_not_found" });
  });

  it("creates a scoped read-only Wealthsimple portal session", async () => {
    const deps = dependencies();
    const app = createApi({ ...deps, ...configuration });
    const reconnect = "00000000-0000-4000-8000-0000000000c2";

    const response = await (await loopbackRequest(app))
      .post("/api/connections/session")
      .set(await owner())
      .send({ reconnect });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      portalUrl: "https://connect.snaptrade.com/session",
    });
    expect(deps.connections.createConnectionPortal).toHaveBeenCalledWith(
      OWNER_SUBJECT,
      { reconnect },
    );
  });

  it("returns only the authenticated user's normalized connection health", async () => {
    const deps = dependencies();
    deps.connections.getConnections.mockResolvedValueOnce([
      {
        id: "00000000-0000-4000-8000-0000000000c2",
        brokerageName: "Wealthsimple",
        disabled: true,
      },
    ]);
    const app = createApi({ ...deps, ...configuration });

    const response = await (await loopbackRequest(app))
      .get("/api/connections")
      .set(await owner());

    expect(response.status).toBe(200);
    expect(deps.connections.getConnections).toHaveBeenCalledWith(
      OWNER_SUBJECT,
    );
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({
      brokerageName: "Wealthsimple",
      disabled: true,
    });
  });

  it("does not expose any legacy trading route", async () => {
    const app = createApi({ ...dependencies(), ...configuration });

    await (await loopbackRequest(app)).post("/api/buy").expect(404);
    await (await loopbackRequest(app)).post("/api/sell").expect(404);
    await (await loopbackRequest(app)).post("/api/transfer").expect(404);
  });

  it("challenges unauthenticated MCP requests with OAuth discovery metadata", async () => {
    const app = createApi({ ...dependencies(), ...configuration });

    const response = await (await loopbackRequest(app))
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toContain(
      'resource_metadata="https://portfolio.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    expect(response.headers["www-authenticate"]).toContain(
      'scope="portfolio:read"',
    );
  });

  it("rejects an MCP token that lacks portfolio read scope", async () => {
    const app = createApi({ ...dependencies(), ...configuration });

    const response = await (await loopbackRequest(app))
      .post("/mcp")
      .set("Authorization", "Bearer connection-only")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(response.status).toBe(403);
    expect(response.headers["www-authenticate"]).toContain(
      'error="insufficient_scope"',
    );
    expect(response.headers["www-authenticate"]).toContain(
      'scope="portfolio:read"',
    );
  });

  it("exposes only OAuth-protected read-only portfolio MCP tools", async () => {
    const app = createApi({ ...dependencies(), ...configuration });

    const response = await (await loopbackRequest(app))
      .post("/mcp")
      .set("Authorization", "Bearer valid-token")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(response.status).toBe(200);
    expect(response.body.result.tools).toHaveLength(5);
    expect(response.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "get_portfolio_snapshot",
      "list_portfolio_accounts",
      "get_account_positions",
      "get_account_history",
      "show_portfolio",
    ]);
    for (const tool of response.body.result.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      });
      expect(tool.securitySchemes).toEqual([
        { type: "oauth2", scopes: ["portfolio:read"] },
      ]);
    }
    const showPortfolio = response.body.result.tools.find(
      (tool: { name: string }) => tool.name === "show_portfolio",
    );
    expect(showPortfolio._meta).toMatchObject({
      ui: { resourceUri: "ui://portfolio/dashboard-v4" },
      "openai/outputTemplate": "ui://portfolio/dashboard-v4",
      "openai/widgetAccessible": true,
    });
    expect(
      response.body.result.tools
        .filter((tool: { name: string }) => tool.name !== "show_portfolio")
        .some((tool: { _meta?: { ui?: unknown } }) => tool._meta?.ui),
    ).toBe(false);
    expect(
      response.body.result.tools.some((tool: { name: string }) =>
        /execute|submit|place|buy|sell|transfer|order/i.test(tool.name),
      ),
    ).toBe(false);
  });

  it("does not expose a validation status tool or fall through to portfolio reads", async () => {
    const deps = dependencies();
    const local = await loopbackRequest(createApi({ ...deps, ...configuration }));
    const response = await local.post("/mcp").set("Authorization", "Bearer valid-token")
      .set("Accept", "application/json, text/event-stream").send({ jsonrpc: "2.0", id: 1,
        method: "tools/call", params: { name: "get_validation_status", arguments: {} } });
    expect(response.body.error.code).toBe(ErrorCode.InvalidParams);
    expect(deps.portfolio.getPortfolio).not.toHaveBeenCalled();
    expect(deps.history.getAccountHistory).not.toHaveBeenCalled();
  });

  it("publishes a static credential-free MCP Apps portfolio resource", async () => {
    const app = createApi({ ...dependencies(), ...configuration });
    const authenticated = async (body: Record<string, unknown>) =>
      (await loopbackRequest(app))
        .post("/mcp")
        .set("Authorization", "Bearer valid-token")
        .set("Accept", "application/json, text/event-stream")
        .send(body);

    const listed = await authenticated({
      jsonrpc: "2.0",
      id: 5,
      method: "resources/list",
      params: {},
    });
    expect(listed.status).toBe(200);
    expect(listed.body.result.resources).toEqual([
      expect.objectContaining({
        uri: "ui://portfolio/dashboard-v4",
        name: "portfolio-dashboard",
        mimeType: "text/html;profile=mcp-app",
      }),
    ]);

    const read = await authenticated({
      jsonrpc: "2.0",
      id: 6,
      method: "resources/read",
      params: { uri: "ui://portfolio/dashboard-v4" },
    });
    expect(read.status).toBe(200);
    expect(read.body.result.contents).toHaveLength(1);
    expect(read.body.result.contents[0]).toMatchObject({
      uri: "ui://portfolio/dashboard-v4",
      mimeType: "text/html;profile=mcp-app",
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { connectDomains: [], resourceDomains: [] },
        },
      },
    });
    const html = read.body.result.contents[0].text as string;
    expect(html).toContain("Brokerage-reported portfolio value");
    expect(html).toContain("ui/notifications/tool-result");
    expect(html).toContain("tools/call");
    expect(html).not.toContain("SNAPTRADE_CONSUMER_KEY");
    expect(html).not.toContain("CREDENTIAL_ENCRYPTION_KEY");
    expect(html).not.toContain(OWNER_SUBJECT);
    expect(html).not.toContain("account-owned-by-a");
  });

  it("renders the authenticated portfolio through the dedicated read-only tool", async () => {
    const deps = dependencies();
    const app = createApi({ ...deps, ...configuration });

    const response = await (await loopbackRequest(app))
      .post("/mcp")
      .set("Authorization", "Bearer user-b")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "show_portfolio", arguments: {} },
      });

    expect(response.status).toBe(200);
    expect(response.body.result.isError).not.toBe(true);
    expect(response.body.result.structuredContent).toEqual({
      connectionRequired: false,
      generatedAt: "2026-08-19T15:00:00.000Z",
      totals: [],
      accounts: [],
      errors: [],
    });
    expect(deps.portfolio.getPortfolio).toHaveBeenCalledWith("synthetic-user-b");
  });

  it("keeps MCP portfolio calls isolated to each authenticated subject", async () => {
    const deps = dependencies();
    const app = createApi({ ...deps, ...configuration });
    const call = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_portfolio_snapshot", arguments: {} },
    };

    const userA = await (await loopbackRequest(app))
      .post("/mcp")
      .set("Authorization", "Bearer user-a")
      .set("Accept", "application/json, text/event-stream")
      .send(call);
    const userB = await (await loopbackRequest(app))
      .post("/mcp")
      .set("Authorization", "Bearer user-b")
      .set("Accept", "application/json, text/event-stream")
      .send({ ...call, id: 3 });

    expect(userA.status).toBe(200);
    expect(userA.body.result.isError).not.toBe(true);
    expect(userB.status).toBe(200);
    expect(userB.body.result.isError).not.toBe(true);
    expect(deps.portfolio.getPortfolio.mock.calls).toEqual([
      [OWNER_SUBJECT],
      ["synthetic-user-b"],
    ]);
  });

  it("does not expose another user's account through an MCP account selector", async () => {
    const deps = dependencies();
    deps.portfolio.getPortfolio.mockImplementation(async (authSubject) => ({
      connectionRequired: false,
      generatedAt: "2026-08-20T16:00:00.000Z",
      accounts: [
        {
          account: {
            id:
              authSubject === "synthetic-user-b"
                ? "account-owned-by-b"
                : "account-owned-by-a",
            connectionId: "connection-for-owner",
            name: "Account",
            number: "••••1234",
            institution: "Wealthsimple",
            type: "TFSA",
            category: "INVESTMENT",
            metaType: "tfsa",
            unifiedType: "SELF_DIRECTED_TFSA",
            status: "open",
            isPaper: false,
            reportedTotal: null,
          },
          balances: [],
          positions: [],
          calculatedValueByCurrency: {},
          freshness: {
            positionsAsOf: "2026-08-20T15:55:00.000Z",
            holdingsLastSyncedAt: "2026-08-20T15:55:00.000Z",
            initialSyncCompleted: true,
            holdingsUnavailable: false,
          },
          warnings: [],
        },
      ],
      errors: [],
    }));
    const app = createApi({ ...deps, ...configuration });

    const response = await (await loopbackRequest(app))
      .post("/mcp")
      .set("Authorization", "Bearer user-b")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "get_account_positions",
          arguments: { accountId: "account-owned-by-a" },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.result.isError).toBe(true);
    expect(response.body.result.structuredContent).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain("account-owned-by-b");
  });

  it("keeps MCP paths out of the dashboard fallback", async () => {
    const staticAssetsDirectory = await createStaticAssets();

    try {
      const app = createApi({
        ...dependencies(),
        ...configuration,
        staticAssetsDirectory,
      });

      await (await loopbackRequest(app))
        .get("/mcp")
        .set("Accept", "text/html")
        .set("Authorization", "Bearer valid-token")
        .expect(405);
    } finally {
      await rm(staticAssetsDirectory, { recursive: true, force: true });
    }
  });

  it("serves built dashboard assets for root and client-side routes", async () => {
    const staticAssetsDirectory = await createStaticAssets();

    try {
      const app = createApi({
        ...dependencies(),
        ...configuration,
        staticAssetsDirectory,
      });

      const root = await (await loopbackRequest(app)).get("/").set("Accept", "text/html");
      const clientRoute = await (await loopbackRequest(app))
        .get("/accounts/connected")
        .set("Accept", "text/html");
      const asset = await (await loopbackRequest(app)).get("/app.js");

      expect(root.status).toBe(200);
      expect(root.text).toContain("Your portfolio, connected.");
      expect(clientRoute.status).toBe(200);
      expect(clientRoute.text).toContain("Your portfolio, connected.");
      expect(asset.status).toBe(200);
      expect(asset.text).toBe("window.portfolioApp = true;");
    } finally {
      await rm(staticAssetsDirectory, { recursive: true, force: true });
    }
  });

  it("keeps unknown API paths out of the dashboard fallback", async () => {
    const staticAssetsDirectory = await createStaticAssets();

    try {
      const app = createApi({
        ...dependencies(),
        ...configuration,
        staticAssetsDirectory,
      });

      await (await loopbackRequest(app))
        .get("/api/missing")
        .set("Accept", "text/html")
        .expect(404);
    } finally {
      await rm(staticAssetsDirectory, { recursive: true, force: true });
    }
  });

  it("passes the exact JSON body and Signature header to webhook ingestion", async () => {
    const deps = dependencies();
    const app = createApi({ ...deps, ...configuration });
    const body = {
      webhookId: "webhook-123",
      clientId: "commercial-client",
      eventType: "CONNECTION_ADDED",
    };

    const response = await (await loopbackRequest(app))
      .post("/webhooks/snaptrade")
      .set("Content-Type", "application/json")
      .set("Signature", "base64-signature")
      .send(body);

    expect(response.status).toBe(204);
    expect(deps.webhooks.ingest).toHaveBeenCalledWith(
      JSON.stringify(body),
      "base64-signature",
    );
  });

  it("rejects an invalid SnapTrade webhook without acknowledging it", async () => {
    const deps = dependencies();
    deps.webhooks.ingest.mockRejectedValueOnce(
      new InvalidSnapTradeWebhookError(),
    );
    const app = createApi({ ...deps, ...configuration });

    const response = await (await loopbackRequest(app))
      .post("/webhooks/snaptrade")
      .set("Content-Type", "application/json")
      .set("Signature", "invalid")
      .send({ webhookId: "webhook-123" });

    expect(response.status).toBe(401);
  });
});

describe("validation failure diagnostics", () => {
  it("logs the route pattern and issue paths/codes without request or provider values", async () => {
    const deps = dependencies();
    const { z } = await import("zod");
    deps.connections.getConnections.mockImplementation(async () =>
      z.array(z.object({ id: z.uuid() })).parse([{ id: "SECRET-LOOKING-VALUE" }]) as never,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createApi({ ...deps, ...configuration });
      await (await loopbackRequest(app)).get("/api/connections").set(await owner()).expect(400);
      expect(warn).toHaveBeenCalledOnce();
      const logged = String(warn.mock.calls[0][0]);
      expect(JSON.parse(logged)).toEqual({
        event: "request_validation_failed",
        method: "GET",
        route: "/api/connections",
        issues: [{ path: "0.id", code: "invalid_format" }],
      });
      expect(logged).not.toContain("SECRET-LOOKING-VALUE");
      expect(logged).not.toContain("user-123");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("MCP request diagnostics", () => {
  it("logs the tool name and the names of its arguments, never their values", async () => {
    const deps = dependencies();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const app = createApi({ ...deps, ...configuration });
      await (await loopbackRequest(app)).post("/mcp").set("Authorization", "Bearer valid-token").set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_portfolio_accounts", arguments: { symbol: "SECRET-SYMBOL", accountId: "SECRET-ACCOUNT", "bad key!": 1 } } })
        .expect(200);
      const entries = log.mock.calls.map((call) => { try { return JSON.parse(String(call[0])); } catch { return null; } }).filter(Boolean);
      const entry = entries.find((e: any) => e.event === "mcp_request" && e.rpcMethod === "tools/call");
      expect(entry).toMatchObject({ tool: "list_portfolio_accounts", argKeys: ["accountId", "symbol"] });
      expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET-");
    } finally {
      log.mockRestore();
    }
  });
});

describe("MCP rejection diagnostics", () => {
  it("logs the JSON-RPC method, protocol version header and status for rejected MCP requests", async () => {
    const deps = dependencies();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createApi({ ...deps, ...configuration });
      await (await loopbackRequest(app))
        .post("/mcp")
        .set("Authorization", "Bearer valid-token")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", "1999-01-01")
        .send({ jsonrpc: "2.0", id: 9, method: "tools/list", params: { cursor: "SECRET-LOOKING-VALUE" } })
        .expect(400);
      const entries = warn.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(entries).toContainEqual({
        event: "mcp_request_rejected",
        status: 400,
        rpcMethod: "tools/list",
        protocolVersionHeader: "1999-01-01",
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET-LOOKING-VALUE");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("user-123");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("user data controls", () => {
  function controls() {
    return {
      disconnect: vi.fn(async () => ({ status: "disconnected" as const, providerDeletion: "queued" })),
    };
  }

  it("disconnects the owner's connection with the owner session", async () => {
    const dataControls = controls();
    const app = createApi({ ...dependencies(), ...configuration, dataControls });

    const response = await (await loopbackRequest(app)).delete("/api/connections/invented-connection-1")
      .set(await owner()).expect(202);
    expect(response.body).toEqual({ status: "disconnected", providerDeletion: "queued" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(dataControls.disconnect).toHaveBeenCalledWith(OWNER_SUBJECT, "invented-connection-1");
  });

  it("requires the owner session for the data-control route", async () => {
    const dataControls = controls();
    const deps = dependencies();
    const app = createApi({ ...deps, ...configuration, dataControls });

    await (await loopbackRequest(app)).delete("/api/connections/invented-connection").expect(401);
    await (await loopbackRequest(app)).delete("/api/connections/invented-connection").set("Authorization", "Bearer anything").expect(401);
    await (await loopbackRequest(app)).delete("/api/connections/invented-connection").set("Cookie", (await owner()).Cookie).set("Origin", "https://evil.example").expect(403);
    expect(deps.mcpVerifier.verify).not.toHaveBeenCalled();
    expect(dataControls.disconnect).not.toHaveBeenCalled();
  });

  it("maps data-control errors to their status without details", async () => {
    const dataControls = controls();
    dataControls.disconnect.mockRejectedValueOnce(new DataControlError("connection_not_found", 404));
    dataControls.disconnect.mockRejectedValueOnce(new DataControlError("provider_unavailable", 502));
    const app = createApi({ ...dependencies(), ...configuration, dataControls });

    const missing = await (await loopbackRequest(app)).delete("/api/connections/invented-elsewhere").set(await owner()).expect(404);
    expect(missing.body).toEqual({ error: "connection_not_found" });
    const failed = await (await loopbackRequest(app)).delete("/api/connections/invented-down").set(await owner()).expect(502);
    expect(failed.body).toEqual({ error: "provider_unavailable" });
  });

  it("does not expose data-control routes unless composed", async () => {
    const app = createApi({ ...dependencies(), ...configuration });
    await (await loopbackRequest(app)).delete("/api/connections/invented-connection").set(await owner()).expect(404);
  });
});

describe("health and log labels", () => {
  it("reports only status on /health without auth: no environment label, no hosting revision", async () => {
    const saved = process.env.K_REVISION;
    try {
      process.env.K_REVISION = "vestlens-00042-abc";
      const app = createApi({ ...dependencies(), ...configuration });
      expect((await (await loopbackRequest(app)).get("/health").expect(200)).body).toEqual({ status: "ok" });
    } finally {
      if (saved === undefined) delete process.env.K_REVISION; else process.env.K_REVISION = saved;
    }
  });
  it("structured log lines carry no env label", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const refresh = { run: vi.fn(async () => ({ users: 0, synced: 0, reconstructed: 0, rows: 0, failures: 0, deferred: 0 })), lock: async (_n: string, fn: () => Promise<void>) => { await fn(); return true; } };
      const app = createApi({ ...dependencies(), ...configuration, refresh });
      await (await loopbackRequest(app)).post("/api/refresh").set(await owner()).expect(202);
      await vi.waitFor(() => expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes("manual_refresh"))).toBe(true));
      const events = warn.mock.calls.map((c) => JSON.parse(String(c[0])));
      expect(events).toContainEqual(expect.objectContaining({ event: "manual_refresh" }));
      for (const event of events) expect("env" in event).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("webhook route", () => {
  it("is not mounted without a webhook service (WEBHOOKS_ENABLED off): 404, nothing ingested", async () => {
    const { webhooks, ...rest } = dependencies();
    const app = createApi({ ...rest, ...configuration });
    await (await loopbackRequest(app)).post("/webhooks/snaptrade").set("Content-Type", "application/json").set("Signature", "x").send("{}").expect(404);
    expect(webhooks.ingest).not.toHaveBeenCalled();
  });
});

describe("POST /api/refresh", () => {
  const counts = { users: 1, synced: 1, reconstructed: 1, rows: 3, failures: 1, deferred: 0, failureCodes: { sync_account: 1 } };
  const freeLock = async (_name: string, fn: () => Promise<void>) => { await fn(); return true; };
  /** Polls GET /api/refresh/status until the background run leaves "running". */
  async function finished(app: ReturnType<typeof createApi>) {
    for (let i = 0; i < 200; i += 1) {
      const response = await (await loopbackRequest(app)).get("/api/refresh/status").set(await owner()).expect(200);
      if (response.body.state !== "running") return response.body as Record<string, unknown>;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("refresh did not finish");
  }
  const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("needs the owner session and this app's Origin, and does not run otherwise", async () => {
    const run = vi.fn(async () => counts);
    const app = createApi({ ...dependencies(), ...configuration, refresh: { run, lock: freeLock } });
    await (await loopbackRequest(app)).post("/api/refresh").expect(401);
    await (await loopbackRequest(app)).post("/api/refresh").set("Authorization", "Bearer user-123").expect(401);
    await (await loopbackRequest(app)).post("/api/refresh").set("Cookie", (await owner()).Cookie).set("Origin", "https://evil.example").expect(403);
    await (await loopbackRequest(app)).get("/api/refresh/status").expect(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("is 404 when not composed", async () => {
    const app = createApi({ ...dependencies(), ...configuration });
    await (await loopbackRequest(app)).post("/api/refresh").set(await owner()).expect(404);
    await (await loopbackRequest(app)).get("/api/refresh/status").set(await owner()).expect(404);
  });

  it("answers 202 at once, runs in the background under the nightly lock, and reports counts only", async () => {
    const warn = quiet();
    try {
      let release!: () => void;
      const run = vi.fn(() => new Promise<typeof counts>((resolve) => { release = () => resolve(counts); }));
      const lock = vi.fn(freeLock);
      const app = createApi({ ...dependencies(), ...configuration, refresh: { run, lock } });
      const started = await (await loopbackRequest(app)).post("/api/refresh").set(await owner()).expect(202);
      expect(started.body).toEqual({ status: "started" });
      expect(started.headers["cache-control"]).toBe("no-store");
      const running = await (await loopbackRequest(app)).get("/api/refresh/status").set(await owner()).expect(200);
      expect(running.body).toEqual({ state: "running" });
      release();
      const done = await finished(app);
      expect(lock).toHaveBeenCalledWith("nightly", expect.any(Function));
      expect(run).toHaveBeenCalledOnce();
      expect(done).toEqual({ state: "succeeded", users: 1, synced: 1, reconstructed: 1, rows: 3, failures: 1, deferred: 0, failureCodes: { sync_account: 1 } });
    } finally { warn.mockRestore(); }
  });

  it("answers 409 already_running to a second request while one runs, and starts only one run", async () => {
    const warn = quiet();
    try {
      let release!: () => void;
      const run = vi.fn(() => new Promise<typeof counts>((resolve) => { release = () => resolve(counts); }));
      const app = createApi({ ...dependencies(), ...configuration, refresh: { run, lock: freeLock } });
      await (await loopbackRequest(app)).post("/api/refresh").set(await owner()).expect(202);
      const second = await (await loopbackRequest(app)).post("/api/refresh").set(await owner()).expect(409);
      expect(second.body).toEqual({ error: "already_running" });
      release();
      await finished(app);
      expect(run).toHaveBeenCalledOnce();
    } finally { warn.mockRestore(); }
  });

  it("reports a busy nightly lock (held by another process) as a failed run, and does not use up the minute", async () => {
    const warn = quiet();
    try {
      let held = true;
      const run = vi.fn(async () => counts);
      const lock = async (_n: string, fn: () => Promise<void>) => { if (held) return false; await fn(); return true; };
      const app = createApi({ ...dependencies(), ...configuration, refresh: { run, lock } });
      await (await loopbackRequest(app)).post("/api/refresh").set(await owner()).expect(202);
      expect(await finished(app)).toEqual({ state: "failed", error: "busy" });
      expect(run).not.toHaveBeenCalled();
      held = false;
      await (await loopbackRequest(app)).post("/api/refresh").set(await owner()).expect(202);
      expect((await finished(app)).state).toBe("succeeded");
    } finally { warn.mockRestore(); }
  });

  it("answers 429 rate_limited for a second run within 60 seconds, and runs again after", async () => {
    const warn = quiet();
    try {
      let nowMs = Date.parse("2026-10-28T15:00:00Z");
      const run = vi.fn(async () => counts);
      const app = createApi({ ...dependencies(), ...configuration, now: () => new Date(nowMs), refresh: { run, lock: freeLock } });
      await (await loopbackRequest(app)).post("/api/refresh").set(await owner()).expect(202);
      await finished(app);
      nowMs += 59_000;
      const limited = await (await loopbackRequest(app)).post("/api/refresh").set(await owner()).expect(429);
      expect(limited.body).toEqual({ error: "rate_limited" });
      expect(run).toHaveBeenCalledOnce();
      nowMs += 1_001;
      await (await loopbackRequest(app)).post("/api/refresh").set(await owner()).expect(202);
      await finished(app);
      expect(run).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
  });

  it("reports a rejected SnapTrade key as a failed run with its code, not as success", async () => {
    const warn = quiet();
    try {
      const rejected = { ...counts, failures: 1, failureCodes: { snaptrade_key_rejected: 1 } };
      const app = createApi({ ...dependencies(), ...configuration, refresh: { run: vi.fn(async () => rejected), lock: freeLock } });
      await (await loopbackRequest(app)).post("/api/refresh").set(await owner()).expect(202);
      expect(await finished(app)).toEqual({ state: "failed", error: "snaptrade_key_rejected" });
      const events = warn.mock.calls.map((c) => String(c[0]));
      expect(events.filter((line) => line.includes("snaptrade_key_rejected"))).toHaveLength(2); // manual_refresh counts line + the one-line event
      expect(events).toContain(JSON.stringify({ event: "snaptrade_key_rejected" }));
    } finally { warn.mockRestore(); }
  });

  it("a thrown SnapTrade key rejection is the same failure; any other throw is a generic one without details", async () => {
    const warn = quiet();
    try {
      let nowMs = Date.parse("2026-10-28T15:00:00Z");
      const run = vi.fn<() => Promise<typeof counts>>()
        .mockRejectedValueOnce(new SnapTradeKeyRejectedError())
        .mockRejectedValueOnce(new Error("balance 99999 leaked"));
      const app = createApi({ ...dependencies(), ...configuration, now: () => new Date(nowMs), refresh: { run, lock: freeLock } });
      await (await loopbackRequest(app)).post("/api/refresh").set(await owner()).expect(202);
      expect(await finished(app)).toEqual({ state: "failed", error: "snaptrade_key_rejected" });
      nowMs += 61_000;
      await (await loopbackRequest(app)).post("/api/refresh").set(await owner()).expect(202);
      const second = await finished(app);
      expect(second).toEqual({ state: "failed", error: "refresh_failed" });
      expect(JSON.stringify([second, warn.mock.calls])).not.toContain("99999");
    } finally { warn.mockRestore(); }
  });

  it("hands the background run to refresh.track so shutdown can wait for it", async () => {
    const warn = quiet();
    try {
      const tracked: Array<Promise<unknown>> = [];
      const app = createApi({ ...dependencies(), ...configuration, refresh: { run: vi.fn(async () => counts), lock: freeLock, track: (p: Promise<unknown>) => { tracked.push(p); } } });
      await (await loopbackRequest(app)).post("/api/refresh").set(await owner()).expect(202);
      expect(tracked).toHaveLength(1);
      await expect(tracked[0]).resolves.toBeUndefined();
    } finally { warn.mockRestore(); }
  });
});


describe("news image route", () => {
  const ID = "3f1c2b4a-1d2e-4f3a-9b8c-7d6e5f4a3b2c";
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  async function images(over: Record<string, unknown> = {}) {
    const { imageProxyRouter } = await import("../news/image-proxy.js");
    return imageProxyRouter({
      ...over,
      store: { articleImageUrl: vi.fn(async (id: string) => (id === ID ? "https://img.example.invalid/zz.png" : null)) },
      fetch: vi.fn(async () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } })),
      lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]),
      log: () => undefined,
    });
  }

  it("serves the proxy without a token and with a public cache, overriding the API no-store default", async () => {
    const deps = dependencies();
    const app = createApi({ ...deps, ...configuration, staticAssetsDirectory: await createStaticAssets(), newsImages: await images() });
    const client = await loopbackRequest(app);
    const ok = await client.get(`/api/news/image/${ID}`).expect(200);
    expect(ok.headers["content-type"]).toBe("image/png");
    expect(ok.headers["cache-control"]).toBe("public, max-age=86400");
    const missing = await client.get("/api/news/image/00000000-0000-4000-8000-000000000000").set("Accept", "text/html").expect(404);
    expect(missing.body).toEqual({ error: "not_found" });
    expect(deps.mcpVerifier.verify).not.toHaveBeenCalled();
  });

  it("with TRUST_PROXY=1, trusts one proxy hop so each client IP has its own bucket; unset trusts nothing", async () => {
    const app = createApi({ ...dependencies(), ...configuration, noGateway: true, trustProxy: 1, newsImages: await images({ rateLimitPerMinute: 1 }) });
    expect(app.get("trust proxy")).toBe(1);
    const client = await loopbackRequest(app);
    await client.get(`/api/news/image/${ID}`).set("X-Forwarded-For", "203.0.113.30").expect(200);
    await client.get(`/api/news/image/${ID}`).set("X-Forwarded-For", "203.0.113.30").expect(429);
    await client.get(`/api/news/image/${ID}`).set("X-Forwarded-For", "198.51.100.9, 203.0.113.30").expect(429);
    await client.get(`/api/news/image/${ID}`).set("X-Forwarded-For", "203.0.113.31").expect(200);
    const bare = createApi({ ...dependencies(), ...configuration, noGateway: true, newsImages: await images({ rateLimitPerMinute: 1 }) });
    expect(bare.get("trust proxy")).toBeFalsy();
    const bareClient = await loopbackRequest(bare);
    await bareClient.get(`/api/news/image/${ID}`).set("X-Forwarded-For", "203.0.113.40").expect(200);
    await bareClient.get(`/api/news/image/${ID}`).set("X-Forwarded-For", "203.0.113.41").expect(429);
  });

  it("is absent when news is off: the path is an unknown API path, never the dashboard", async () => {
    const app = createApi({ ...dependencies(), ...configuration, staticAssetsDirectory: await createStaticAssets() });
    const response = await (await loopbackRequest(app)).get(`/api/news/image/${ID}`).set("Accept", "text/html").expect(404);
    expect(response.text).not.toContain("Your portfolio, connected.");
    expect(response.body).not.toEqual({ error: "not_found" });
  });

});

describe("alerts client key and calendar/alerts gating", () => {
  const NOW = new Date("2026-10-21T20:00:00Z");
  const OVERVIEW_HTML = "<!doctype html><title>overview</title>";
  async function wiredApp() {
    const { MemoryNewsStore } = await import("../news/store.js");
    const store = new MemoryNewsStore();
    await store.putEvents([{ id: "earnings:ZZTEST:2026-10-22", symbol: "ZZTEST", kind: "earnings", date: new Date("2026-10-22T00:00:00Z"), status: "expected", source: "edgar", amountPerUnit: null, currency: null }]);
    const deps = dependencies();
    deps.mcpVerifier.verify.mockImplementation(async (token: string) => ({
      subject: OWNER_SUBJECT, scopes: new Set(["portfolio:read"]), ...(token.startsWith("gw-") ? { clientId: token } : {}),
    }) as never);
    deps.portfolio.getPortfolio.mockResolvedValue({
      connectionRequired: false, generatedAt: NOW.toISOString(), errors: [],
      accounts: [{
        account: { id: "acct-1", connectionId: "c-1", number: null, name: "Synthetic", institution: "Synthetic", type: "TFSA", category: null, metaType: null, unifiedType: "SELF_DIRECTED_TFSA", status: "open", isPaper: true, reportedTotal: null },
        balances: [], calculatedValueByCurrency: {}, warnings: [],
        positions: [{ instrumentId: "i", kind: "stock", symbol: "ZZTEST", description: null, units: 10, price: 5, costBasis: null, marketValue: 50, unrealizedGain: null, currency: "CAD", cashEquivalent: false }],
        freshness: { positionsAsOf: NOW.toISOString(), holdingsLastSyncedAt: null, initialSyncCompleted: true, holdingsUnavailable: false },
      }] as never,
    });
    const settings = { get: vi.fn(async () => ({ benchmark: "sp500", cadView: false, privacyDefault: false })), save: vi.fn() };
    const overview = {
      market: { history: vi.fn(async () => null), usdCad: vi.fn(async () => null), quotes: vi.fn(async () => new Map()) },
      settings, dailyValues: { rows: vi.fn(async () => []), earliest: vi.fn(async () => null) }, now: () => NOW,
    };
    const alerts = { store, market: { quotes: vi.fn(async () => new Map()) }, appUserId: vi.fn(async () => "00000000-0000-4000-8000-0000000000bb"), now: () => NOW };
    const app = createApi({ ...deps, ...configuration, overview: overview as never, alerts: alerts as never, assets: { html: (n: string) => (n === "overview" ? OVERVIEW_HTML : null) } as never });
    const call = async (token: string) => {
      const response = await (await loopbackRequest(app)).post("/mcp").set("Authorization", `Bearer ${token}`).set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_portfolio_alerts", arguments: {} } }).expect(200);
      return response.body.result.structuredContent as { quiet: boolean; alerts: unknown[] };
    };
    return { call, store };
  }

  it("ledgers per token client_id, falling back to mcp:<resource>; each client gets every alert once", async () => {
    const { call, store } = await wiredApp();
    expect((await call("gw-claude")).quiet).toBe(false);
    expect((await call("gw-chatgpt")).quiet).toBe(false);
    expect((await call("no-client-token")).quiet).toBe(false);
    expect((await call("gw-claude")).quiet).toBe(true);
    expect((await call("no-client-other-token")).quiet).toBe(true); // same fallback key
    const keys = ["gw-claude", "gw-chatgpt", "mcp:https://portfolio.example.com/"];
    for (const key of keys) expect((await store.deliveredAlertIds("00000000-0000-4000-8000-0000000000bb", key, new Date(0))).size).toBe(1);
  });

});

describe("live widget loader route", () => {
  const BUILT = '<!doctype html><head><script type="module" crossorigin>console.log("holdings")</script><style rel="stylesheet" crossorigin>a{}</style></head><body><div id="app"></div></body>';
  const loader = () => createWidgetLoader({ names: ["holdings"], origin: configuration.appBaseUrl, assets: { html: (n) => (n === "holdings" ? BUILT : null) } });

  it("serves the build without a token, before auth and the dashboard fallback, and 404s other names", async () => {
    const deps = dependencies();
    const app = createApi({ ...deps, ...configuration, staticAssetsDirectory: await createStaticAssets(), widgetLoader: loader() });
    const client = await loopbackRequest(app);
    const js = await client.get("/widgets/holdings.js").expect(200);
    expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(js.headers["cache-control"]).toBe("no-cache");
    expect(js.text).toBe('console.log("holdings")');
    const withCookie = await client.get("/widgets/holdings.js").set("Cookie", "a=b").set("Authorization", "Bearer invalid").expect(200);
    expect(withCookie.text).toBe(js.text);
    expect(withCookie.headers.etag).toBe(js.headers.etag);
    await client.get("/widgets/holdings.css").expect(200).expect("Content-Type", "text/css; charset=utf-8");
    for (const path of ["/widgets/activity.js", "/widgets/holdings.html"]) {
      const missing = await client.get(path).set("Accept", "text/html").expect(404);
      expect(missing.text).not.toContain("Your portfolio, connected.");
    }
    expect(deps.mcpVerifier.verify).not.toHaveBeenCalled();
  });

  it("serves the build with no widget listed as a loader page, so cached loader pages keep working", async () => {
    const unlisted = createWidgetLoader({ names: [], origin: configuration.appBaseUrl, assets: { html: (n) => (n === "holdings" ? BUILT : null) } });
    const client = await loopbackRequest(createApi({ ...dependencies(), ...configuration, widgetLoader: unlisted }));
    const js = await client.get("/widgets/holdings.js").expect(200);
    expect(js.text).toBe('console.log("holdings")');
    expect(js.headers["cache-control"]).toBe("no-cache");
    await client.get("/widgets/unknown.js").expect(404);
  });

  it("is absent when no widget builds are available", async () => {
    const app = createApi({ ...dependencies(), ...configuration });
    const response = await (await loopbackRequest(app)).get("/widgets/holdings.js");
    expect(response.status).toBe(404);
    expect(response.text).not.toContain("console.log");
  });

});
