import { Snaptrade, SnaptradeAuth } from "snaptrade-typescript-sdk";

import {
  SnapTradeGateway,
  SnapTradeKeyRejectedError,
  type SnapTradeClientPort,
  type ProviderReadOptions,
} from "./gateway.js";

// SDK 12.1.3 retries Axios 429 errors internally. Guarded reads must count
// each request once: let Axios return 429, then reject it outside that loop.
function providerOptions(options?: ProviderReadOptions): [] | [ProviderReadOptions & { validateStatus(status: number): boolean }] {
  return options ? [{ ...options, validateStatus: (status) => (status >= 200 && status < 300) || status === 429 }] : [];
}
async function readResponse<T extends { status: number }>(request: Promise<T>, options?: ProviderReadOptions): Promise<T> {
  const response = await request;
  if (options && response.status === 429) throw new Error("Provider read unavailable");
  return response;
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("status" in error && typeof error.status === "number") return error.status;
  if ("response" in error && typeof error.response === "object" && error.response !== null
    && "status" in error.response && typeof error.response.status === "number") return error.response.status;
  return undefined;
}

/** SnapTrade answering 401 or 403 means the owner's Personal key is wrong or revoked. */
async function keyChecked<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    const status = httpStatus(error);
    if (status === 401 || status === 403) throw new SnapTradeKeyRejectedError();
    throw error;
  }
}

/** A Personal key identifies the owner by itself: the SDK takes no userId or userSecret. */
function withoutUser<T extends { userId?: string; userSecret?: string }>(input: T): Omit<T, "userId" | "userSecret"> {
  const { userId: _userId, userSecret: _userSecret, ...rest } = input;
  return rest;
}

export interface SnapTradePersonalCredentials {
  clientId: string;
  consumerKey: string;
}

export type SnapTradeClientFactory = (
  credentials: SnapTradePersonalCredentials,
) => SnapTradeClientPort;

export function createPersonalSnapTradeClient(
  credentials: SnapTradePersonalCredentials,
  transport: { basePath?: string } = {},
): SnapTradeClientPort {
  const sdk = new Snaptrade({
    auth: SnaptradeAuth.personalApiKey(credentials),
    ...transport,
  });

  return {
    authentication: {
      async loginSnapTradeUser(input) {
        const response = await keyChecked(sdk.authentication.loginSnapTradeUser(withoutUser(input)));
        return {
          data: response.data as { redirectURI: string },
        };
      },
    },
    connections: {
      async listBrokerageAuthorizations(input, options) {
        const response =
          await keyChecked(readResponse(sdk.connections.listBrokerageAuthorizations(withoutUser(input), ...providerOptions(options)), options));
        return { data: response.data };
      },
      async detailBrokerageAuthorization(input) {
        const response =
          await keyChecked(sdk.connections.detailBrokerageAuthorization(withoutUser(input)));
        return { data: response.data };
      },
      async deleteConnection(input) {
        const response = await keyChecked(sdk.connections.deleteConnection(withoutUser(input)));
        return { data: response.data };
      },
    },
    accountInformation: {
      async listUserAccounts(input, options) {
        const response = await keyChecked(readResponse(sdk.accountInformation.listUserAccounts(withoutUser(input), ...providerOptions(options)), options));
        return { data: response.data };
      },
      async getUserAccountDetails(input, options) {
        const response =
          await keyChecked(readResponse(sdk.accountInformation.getUserAccountDetails(withoutUser(input), ...providerOptions(options)), options));
        return { data: response.data };
      },
      async getUserAccountBalance(input, options) {
        const response =
          await keyChecked(readResponse(sdk.accountInformation.getUserAccountBalance(withoutUser(input), ...providerOptions(options)), options));
        return { data: response.data };
      },
      async getAllAccountPositions(input, options) {
        const response =
          await keyChecked(readResponse(sdk.accountInformation.getAllAccountPositions(withoutUser(input), ...providerOptions(options)), options));
        return { data: response.data };
      },
      async getUserAccountOrders(input, options) {
        const response =
          await keyChecked(readResponse(sdk.accountInformation.getUserAccountOrders(withoutUser(input), ...providerOptions(options)), options));
        return { data: response.data };
      },
      async getAccountActivities(input, options) {
        const response =
          await keyChecked(readResponse(sdk.accountInformation.getAccountActivities(withoutUser(input), ...providerOptions(options)), options));
        return { data: response.data };
      },
      async getAccountBalanceHistory(input, options) {
        const response =
          await keyChecked(readResponse(sdk.accountInformation.getAccountBalanceHistory(withoutUser(input), ...providerOptions(options)), options));
        return { data: response.data };
      },
    },
    referenceData: {
      async getPartnerInfo() {
        const response = await keyChecked(sdk.referenceData.getPartnerInfo());
        return { data: response.data };
      },
    },
  };
}

export function createSnapTradeGateway(
  credentials: SnapTradePersonalCredentials,
  factory: SnapTradeClientFactory = createPersonalSnapTradeClient,
): SnapTradeGateway {
  return new SnapTradeGateway(factory(credentials));
}
