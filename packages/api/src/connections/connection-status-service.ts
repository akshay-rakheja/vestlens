import { z } from "zod";

import type { SnapTradeCredentials } from "../snaptrade/gateway.js";

interface ConnectionIdentityProvider {
  getExisting(authSubject: string): Promise<SnapTradeCredentials | null>;
}

interface ConnectionStatusGateway {
  listConnections(credentials: SnapTradeCredentials): Promise<unknown>;
}

const connectionSchema = z.looseObject({
  // Provider ids are opaque; Zod's RFC-strict uuid() rejects some real ones.
  id: z.string().trim().min(1),
  name: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  disabled: z.boolean().optional(),
  disabled_date: z.string().nullable().optional(),
  // Observed live as a non-string; accept any shape and normalize below.
  data_freshness_mode: z.unknown().optional(),
  brokerage: z
    .looseObject({
      slug: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      display_name: z.string().nullable().optional(),
      is_degraded: z.boolean().optional(),
      maintenance_mode: z.boolean().optional(),
    })
    .optional(),
});

function freshnessMode(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "mode" in value && typeof value.mode === "string") {
    return value.mode;
  }
  return null;
}

function isoTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("SnapTrade returned an invalid connection timestamp");
  }
  return date.toISOString();
}

export class ConnectionStatusService {
  constructor(
    private readonly options: {
      identity: ConnectionIdentityProvider;
      gateway: ConnectionStatusGateway;
    },
  ) {}

  async getConnections(authSubject: string) {
    const credentials = await this.options.identity.getExisting(authSubject);
    if (!credentials) return [];

    return z
      .array(connectionSchema)
      .parse(await this.options.gateway.listConnections(credentials))
      .map((connection) => ({
        id: connection.id,
        name: connection.name ?? null,
        brokerageSlug: connection.brokerage?.slug ?? null,
        brokerageName:
          connection.brokerage?.display_name ??
          connection.brokerage?.name ??
          null,
        readOnly: connection.type === "read",
        disabled: connection.disabled ?? false,
        disabledAt: isoTimestamp(connection.disabled_date),
        degraded: connection.brokerage?.is_degraded ?? false,
        maintenance: connection.brokerage?.maintenance_mode ?? false,
        dataFreshnessMode: freshnessMode(connection.data_freshness_mode),
      }));
  }
}
