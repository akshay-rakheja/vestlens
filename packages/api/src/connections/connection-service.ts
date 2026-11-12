import { z } from "zod";

import type { SnapTradeCredentials } from "../snaptrade/gateway.js";

interface ConnectionIdentityProvider {
  getOrCreate(authSubject: string): Promise<SnapTradeCredentials>;
}

interface ConnectionGateway {
  createConnectionUrl(
    credentials: SnapTradeCredentials,
    options: {
      customRedirect: string;
      reconnect?: string;
    },
  ): Promise<string>;
}

const optionsSchema = z.object({
  reconnect: z.uuid().optional(),
});

export class ConnectionService {
  private readonly identity: ConnectionIdentityProvider;
  private readonly gateway: ConnectionGateway;
  private readonly completionUrl: string;

  constructor(options: {
    identity: ConnectionIdentityProvider;
    gateway: ConnectionGateway;
    appBaseUrl: string;
  }) {
    this.identity = options.identity;
    this.gateway = options.gateway;
    this.completionUrl = new URL(
      "/connections/complete",
      options.appBaseUrl,
    ).toString();
  }

  async createConnectionPortal(
    authSubject: string,
    options: { reconnect?: string } = {},
  ): Promise<string> {
    const parsed = optionsSchema.parse(options);
    const credentials = await this.identity.getOrCreate(authSubject);
    return this.gateway.createConnectionUrl(credentials, {
      customRedirect: this.completionUrl,
      ...(parsed.reconnect ? { reconnect: parsed.reconnect } : {}),
    });
  }
}
