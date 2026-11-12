import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createPersonalSnapTradeClient } from "./sdk-client.js";

const credentials = { clientId: "test-client-id", consumerKey: "synthetic-read-only-key" };

describe("SnapTrade client is read-only", () => {
  it("exposes no trading, order-placement or transfer method", () => {
    const source = readFileSync(fileURLToPath(new URL("./sdk-client.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/\bsdk\.trading\b|placeOrder|placeForceOrder|cancel(User)?AccountOrder|replaceOrder|transfer/i);
    expect(Object.keys(createPersonalSnapTradeClient(credentials))).toEqual(["authentication", "connections", "accountInformation", "referenceData"]);
    const client = createPersonalSnapTradeClient(credentials);
    const methods = (group: object) => Object.keys(group).sort();
    expect(methods(client.authentication)).toEqual(["loginSnapTradeUser"]);
    expect(methods(client.connections)).toEqual(["deleteConnection", "detailBrokerageAuthorization", "listBrokerageAuthorizations"]);
    expect(methods(client.accountInformation)).toEqual([
      "getAccountActivities", "getAccountBalanceHistory", "getAllAccountPositions",
      "getUserAccountBalance", "getUserAccountDetails", "getUserAccountOrders", "listUserAccounts",
    ]);
    expect(methods(client.referenceData)).toEqual(["getPartnerInfo"]);
  });
});
