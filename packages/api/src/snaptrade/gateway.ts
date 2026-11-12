import { z } from "zod";

export interface SnapTradeCredentials {
  userId: string;
  userSecret: string;
}
/** A Personal key resolves the SnapTrade user by itself; these placeholders never leave this process. */
export const PERSONAL_CREDENTIALS: SnapTradeCredentials = { userId: "personal", userSecret: "personal" };

/** SnapTrade answered 401 or 403: the owner's Personal key is wrong or revoked. */
export class SnapTradeKeyRejectedError extends Error {
  readonly code = "snaptrade_key_rejected";
  readonly status = 502;
  constructor() {
    super("snaptrade_key_rejected");
    this.name = "SnapTradeKeyRejectedError";
  }
}

export interface ProviderReadOptions { signal?: AbortSignal; timeout?: number }

interface SnapTradeResponse<T = unknown> {
  data: T;
}

interface AccountRequest extends SnapTradeCredentials {
  accountId: string;
}

export interface SnapTradeClientPort {
  authentication: {
    loginSnapTradeUser(
      input: SnapTradeCredentials & {
        connectionType: "read";
        customRedirect?: string;
        reconnect?: string;
      },
    ): Promise<SnapTradeResponse<{ redirectURI: string }>>;
  };
  connections: {
    listBrokerageAuthorizations(
      input: SnapTradeCredentials,
      options?: ProviderReadOptions,
    ): Promise<SnapTradeResponse>;
    detailBrokerageAuthorization(
      input: SnapTradeCredentials & { authorizationId: string },
    ): Promise<SnapTradeResponse>;
    /** Queues removal of one connection and its accounts at SnapTrade (CONNECTION_DELETED webhook confirms). */
    deleteConnection(
      input: SnapTradeCredentials & { connectionId: string },
    ): Promise<SnapTradeResponse>;
  };
  accountInformation: {
    listUserAccounts(input: SnapTradeCredentials, options?: ProviderReadOptions): Promise<SnapTradeResponse>;
    getUserAccountDetails(input: AccountRequest, options?: ProviderReadOptions): Promise<SnapTradeResponse>;
    getUserAccountBalance(input: AccountRequest, options?: ProviderReadOptions): Promise<SnapTradeResponse>;
    getAllAccountPositions(input: AccountRequest, options?: ProviderReadOptions): Promise<SnapTradeResponse>;
    getUserAccountOrders(
      input: AccountRequest & {
        state?: "all" | "open" | "executed";
        days?: number;
      },
      options?: ProviderReadOptions,
    ): Promise<SnapTradeResponse>;
    getAccountActivities(
      input: AccountRequest & {
        startDate?: string;
        endDate?: string;
        limit?: number;
        offset?: number;
      },
      options?: ProviderReadOptions,
    ): Promise<SnapTradeResponse>;
    getAccountBalanceHistory(input: AccountRequest, options?: ProviderReadOptions): Promise<SnapTradeResponse>;
  };
  referenceData: {
    getPartnerInfo(): Promise<SnapTradeResponse>;
  };
}

const redirectSchema = z.object({ redirectURI: z.url() });
const providerIdSchema = z.string().trim().min(1).max(64);

/** "queued": SnapTrade accepted the asynchronous deletion. "not_found": nothing to delete there. */
export type ProviderDeletion = "queued" | "not_found";

// SnapTradeError exposes `status`; raw Axios errors carry `response.status`.
function isProviderNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = "status" in error ? error.status
    : "response" in error && typeof error.response === "object" && error.response !== null && "status" in error.response
      ? error.response.status
      : undefined;
  return status === 404;
}

async function providerDeletion(request: () => Promise<unknown>): Promise<ProviderDeletion> {
  try {
    await request();
    return "queued";
  } catch (error) {
    if (isProviderNotFound(error)) return "not_found";
    throw error;
  }
}

export class SnapTradeGateway {
  constructor(private readonly client: SnapTradeClientPort) {}

  async createConnectionUrl(
    credentials: SnapTradeCredentials,
    options: {
      customRedirect?: string;
      reconnect?: string;
    } = {},
  ): Promise<string> {
    const response = await this.client.authentication.loginSnapTradeUser({
      ...credentials,
      connectionType: "read",
      ...options,
    });

    return redirectSchema.parse(response.data).redirectURI;
  }

  /** Removes one of the user's own connections; SnapTrade scopes the id to these credentials. */
  async deleteConnection(credentials: SnapTradeCredentials, connectionId: string): Promise<ProviderDeletion> {
    const id = providerIdSchema.parse(connectionId);
    return providerDeletion(() => this.client.connections.deleteConnection({ ...credentials, connectionId: id }));
  }

  async listConnections(credentials: SnapTradeCredentials, options?: ProviderReadOptions): Promise<unknown> {
    return (
      await this.client.connections.listBrokerageAuthorizations(credentials, ...(options ? [options] : []))
    ).data;
  }

  async getConnection(
    credentials: SnapTradeCredentials,
    authorizationId: string,
  ): Promise<unknown> {
    return (
      await this.client.connections.detailBrokerageAuthorization({
        ...credentials,
        authorizationId,
      })
    ).data;
  }

  async listAccounts(credentials: SnapTradeCredentials, options?: ProviderReadOptions): Promise<unknown> {
    return (await this.client.accountInformation.listUserAccounts(credentials, ...(options ? [options] : [])))
      .data;
  }

  async getAccountDetails(
    credentials: SnapTradeCredentials,
    accountId: string,
    options?: ProviderReadOptions,
  ): Promise<unknown> {
    return (
      await this.client.accountInformation.getUserAccountDetails({
        ...credentials,
        accountId,
      }, ...(options ? [options] : []))
    ).data;
  }

  async getBalances(
    credentials: SnapTradeCredentials,
    accountId: string,
    options?: ProviderReadOptions,
  ): Promise<unknown> {
    return (
      await this.client.accountInformation.getUserAccountBalance({
        ...credentials,
        accountId,
      }, ...(options ? [options] : []))
    ).data;
  }

  async getPositions(
    credentials: SnapTradeCredentials,
    accountId: string,
    options?: ProviderReadOptions,
  ): Promise<unknown> {
    return (
      await this.client.accountInformation.getAllAccountPositions({
        ...credentials,
        accountId,
      }, ...(options ? [options] : []))
    ).data;
  }

  async getOrders(
    credentials: SnapTradeCredentials,
    accountId: string,
    options: { state?: "all" | "open" | "executed"; days?: number } = {},
    requestOptions?: ProviderReadOptions,
  ): Promise<unknown> {
    return (
      await this.client.accountInformation.getUserAccountOrders({
        ...credentials,
        accountId,
        ...options,
      }, ...(requestOptions ? [requestOptions] : []))
    ).data;
  }

  async getActivities(
    credentials: SnapTradeCredentials,
    accountId: string,
    options: { startDate?: string; endDate?: string; limit?: number; offset?: number } = {},
    requestOptions?: ProviderReadOptions,
  ): Promise<unknown> {
    return (
      await this.client.accountInformation.getAccountActivities({
        ...credentials,
        accountId,
        ...options,
      }, ...(requestOptions ? [requestOptions] : []))
    ).data;
  }

  async getBalanceHistory(
    credentials: SnapTradeCredentials,
    accountId: string,
    options?: ProviderReadOptions,
  ): Promise<unknown> {
    return (
      await this.client.accountInformation.getAccountBalanceHistory({
        ...credentials,
        accountId,
      }, ...(options ? [options] : []))
    ).data;
  }

  async getPartnerInfo(): Promise<unknown> {
    return (await this.client.referenceData.getPartnerInfo()).data;
  }
}
