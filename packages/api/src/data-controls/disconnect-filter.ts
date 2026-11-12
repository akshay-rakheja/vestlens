import type { SnapTradeCredentials } from "../snaptrade/gateway.js";

/** Authorization ids the user disconnected whose removal SnapTrade may still be processing. */
export interface DisconnectedConnections {
  disconnectedConnectionIds(): Promise<ReadonlySet<string>>;
}

type Listing = (credentials: SnapTradeCredentials, ...rest: never[]) => Promise<unknown>;

/**
 * Normal-mode read gateway: SnapTrade only queues a connection deletion, so for a while it
 * still lists that authorization and its accounts. Every read service (REST, MCP, nightly
 * sync and snapshots, connection status) lists through this wrapper, so a disconnected
 * authorization is never shown, read further or persisted again. Other calls pass through.
 * A failed marker lookup fails the read instead of showing the connection.
 */
export function hideDisconnected<G extends { listAccounts: Listing; listConnections: Listing }>(
  gateway: G,
  pending: DisconnectedConnections,
): G {
  const filtered = (key: "listAccounts" | "listConnections", idField: "brokerage_authorization" | "id") =>
    async (credentials: SnapTradeCredentials, ...rest: never[]) => {
      const listed = await gateway[key](credentials, ...rest);
      if (!Array.isArray(listed)) return listed;
      const hidden = await pending.disconnectedConnectionIds();
      if (hidden.size === 0) return listed;
      return listed.filter((item) => {
        const id = typeof item === "object" && item !== null ? (item as Record<string, unknown>)[idField] : undefined;
        return !(typeof id === "string" && hidden.has(id));
      });
    };
  const overrides = {
    listAccounts: filtered("listAccounts", "brokerage_authorization"),
    listConnections: filtered("listConnections", "id"),
  };
  return new Proxy(gateway, {
    get(target, property) {
      if (property === "listAccounts" || property === "listConnections") return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
