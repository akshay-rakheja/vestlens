import { inventedFixture } from "../testing/synthetic-fixtures.js";
import { describe, expect, it } from "vitest";

import {
  SnapTradeGateway,
  type SnapTradeClientPort,
} from "./gateway.js";

function recordingClient() {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const client: SnapTradeClientPort = {
    authentication: {
      async loginSnapTradeUser(input) {
        calls.push({ operation: "login", input });
        return { data: { redirectURI: "https://connect.snaptrade.com/session" } };
      },
    },
    connections: {
      async listBrokerageAuthorizations(input) {
        calls.push({ operation: "connections", input });
        return { data: [] };
      },
      async detailBrokerageAuthorization(input) {
        calls.push({ operation: "connection", input });
        return { data: { id: input.authorizationId } };
      },
      async deleteConnection(input) {
        calls.push({ operation: "deleteConnection", input });
        return { data: { connection_id: input.connectionId } };
      },
    },
    accountInformation: {
      async listUserAccounts(input) {
        calls.push({ operation: "accounts", input });
        return { data: [{ id: "account-1" }] };
      },
      async getUserAccountDetails(input) {
        calls.push({ operation: "accountDetails", input });
        return { data: { id: input.accountId } };
      },
      async getUserAccountBalance(input) {
        calls.push({ operation: "balances", input });
        return { data: [] };
      },
      async getAllAccountPositions(input) {
        calls.push({ operation: "positions", input });
        return { data: { positions: [] } };
      },
      async getUserAccountOrders(input) {
        calls.push({ operation: "orders", input });
        return { data: [] };
      },
      async getAccountActivities(input) {
        calls.push({ operation: "activities", input });
        return { data: { data: [], pagination: {} } };
      },
      async getAccountBalanceHistory(input) {
        calls.push({ operation: "history", input });
        return { data: [] };
      },
    },
    referenceData: {
      async getPartnerInfo() {
        calls.push({ operation: "partnerInfo", input: undefined });
        return { data: { name: "Portfolio MCP App" } };
      },
    },
  };

  return { client, calls };
}

const appUserId = "00000000-0000-4000-8000-0000000000c1";
const credentials = {
  userId: `portfolio_${appUserId}`,
  userSecret: inventedFixture("gateway-test-fresh-2"),
};

describe("SnapTradeGateway", () => {
  it("always requests a read-only Connection Portal session", async () => {
    const { client, calls } = recordingClient();
    const gateway = new SnapTradeGateway(client);

    const redirectUri = await gateway.createConnectionUrl(credentials, {
      customRedirect: "https://portfolio.example.com/connections/complete",
      reconnect: "00000000-0000-4000-8000-0000000000c2",
    });

    expect(redirectUri).toBe("https://connect.snaptrade.com/session");
    expect(calls).toContainEqual({
      operation: "login",
      input: {
        userId: credentials.userId,
        userSecret: credentials.userSecret,
        connectionType: "read",
        customRedirect: "https://portfolio.example.com/connections/complete",
          reconnect: "00000000-0000-4000-8000-0000000000c2",
      },
    });
  });

  it("passes server-held user credentials to every account data call", async () => {
    const { client, calls } = recordingClient();
    const gateway = new SnapTradeGateway(client);

    await gateway.listAccounts(credentials);
    await gateway.getBalances(credentials, "account-1");
    await gateway.getPositions(credentials, "account-1");
    await gateway.getOrders(credentials, "account-1", {
      state: "executed",
      days: 45,
    });
    await gateway.getActivities(credentials, "account-1", {
      startDate: "2026-01-01",
      endDate: "2026-08-19",
      limit: 100,
    });
    await gateway.getBalanceHistory(credentials, "account-1");

    for (const call of calls) {
      expect(call.input).toMatchObject({
        userId: credentials.userId,
        userSecret: credentials.userSecret,
      });
    }
    expect(calls).toContainEqual({
      operation: "orders",
      input: {
        ...credentials,
        accountId: "account-1",
        state: "executed",
        days: 45,
      },
    });
  });
});

describe("SnapTrade data-control writes", () => {
  it("removes one connection with the caller's own credentials", async () => {
    const { client, calls } = recordingClient();
    const gateway = new SnapTradeGateway(client);

    await expect(gateway.deleteConnection(credentials, "invented-connection-1")).resolves.toBe("queued");
    expect(calls).toEqual([
      { operation: "deleteConnection", input: { ...credentials, connectionId: "invented-connection-1" } },
    ]);
  });

  it("treats a provider 404 as already removed and rethrows other failures", async () => {
    const { client } = recordingClient();
    const gateway = new SnapTradeGateway(client);
    client.connections.deleteConnection = async () => { throw Object.assign(new Error("gone"), { status: 404 }); };

    await expect(gateway.deleteConnection(credentials, "invented-connection-2")).resolves.toBe("not_found");

    client.connections.deleteConnection = async () => { throw Object.assign(new Error("down"), { status: 503 }); };
    await expect(gateway.deleteConnection(credentials, "invented-connection-3")).rejects.toThrow("down");
  });

  it("rejects empty ids before any provider call", async () => {
    const { client, calls } = recordingClient();
    const gateway = new SnapTradeGateway(client);

    await expect(gateway.deleteConnection(credentials, " ")).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
