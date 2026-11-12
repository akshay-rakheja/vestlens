/**
 * The caller's own data as one JSON document, written incrementally. Every user-scoped query is filtered by the
 * caller's appUserId (connected AI apps, memory facts and room alerts by subject), pages by an id cursor, and projects each row
 * through an explicit per-table allowlist, so a column added to the schema later is excluded until it is listed here.
 * Secrets and internals (encryptedUserSecret, key versions, token or code hashes, ipHash, dedupe keys, raw webhook
 * payloads) are not on any list. Nothing here logs row content.
 */

export const EXPORT_FORMAT = "vestlens-export-v1";
export const EXPORT_NOTE = "Webhook receipts are short-lived operational records and are not included.";

/** Rows per database page for ordinary tables; snapshots carry large JSON payloads, so they page smaller. */
const PAGE_SIZE = 1000;
const SNAPSHOT_PAGE_SIZE = 50;

export interface ExportPage {
  where: { appUserId: string };
  select: Record<string, true>;
  orderBy: { id: "asc" };
  take: number;
  cursor?: { id: string };
  skip?: 1;
}

export interface ExportDelegate {
  findMany(input: ExportPage): Promise<Array<Record<string, unknown>>>;
}

/** Per-account tables keyed by (appUserId, account): one row per account, so a single bounded read. */
export interface ExportListDelegate {
  findMany(input: { where: { appUserId: string }; select: Record<string, true>; orderBy: { snapTradeAccountId: "asc" } }): Promise<Array<Record<string, unknown>>>;
}

export interface ExportPrismaPort {
  appUser: { findUnique(input: { where: { authSubject: string }; select: { id: true } }): Promise<{ id: string } | null> };
  brokerageConnection: ExportDelegate;
  brokerageAccount: ExportDelegate;
  portfolioSnapshot: ExportDelegate;
  activity: ExportDelegate;
  dailyValue: ExportDelegate;
  newsAlertDelivery: ExportDelegate;
  pendingDisconnect: ExportDelegate;
  activitySyncState: ExportListDelegate;
  accountHistoryQuality: ExportListDelegate;
  portfolioSettings: {
    findUnique(input: { where: { appUserId: string }; select: Record<string, true> }): Promise<Record<string, unknown> | null>;
  };
}

/** Field allowlists, per table. `id` is selected as the paging cursor but never emitted unless listed. */
export const EXPORT_FIELDS = {
  connections: ["id", "snapTradeConnectionId", "brokerageSlug", "brokerageName", "disabled", "dataFreshnessMode", "lastWebhookAt", "createdAt", "updatedAt"],
  accounts: [
    "id", "connectionId", "snapTradeAccountId", "institutionAccountId", "displayName", "maskedNumber", "institutionName", "rawType", "category",
    "status", "isPaper", "reportedTotal", "reportedCurrency", "holdingsUnavailable", "holdingsLastSyncedAt", "createdAt", "updatedAt",
  ],
  snapshots: ["id", "accountId", "snapTradeAccountId", "payload", "positionsAsOf", "capturedAt"],
  activities: [
    "snapTradeAccountId", "type", "symbol", "securityCurrency", "isOption", "units", "price", "amount", "fee", "fxRate", "currency",
    "tradeDate", "settlementDate", "description", "syncedAt",
  ],
  dailyValues: ["date", "snapTradeAccountId", "currency", "value", "source", "capturedAt"],
  activitySyncStates: ["snapTradeAccountId", "backfillCompletedAt", "lastSyncedAt", "lastError", "activityCount", "earliestTradeDate", "dirty"],
  accountHistoryQualities: ["snapTradeAccountId", "method", "reason", "driftFraction", "computedAt"],
  settings: ["benchmark", "cadView", "privacyDefault", "targetAllocation", "contributionRoom", "updatedAt"],
  newsAlertDeliveries: ["clientKey", "alertId", "deliveredAt"],
  pendingDisconnects: ["snapTradeConnectionId", "snapTradeAccountIds", "requestedAt", "confirmedAt"],
  aiApps: ["clientKey", "name", "host", "grantedAt"],
  /** Every memory fact, current and superseded (history is the user's data too). */
  memory: ["nodeType", "nodeKey", "property", "value", "text", "kind", "provenance", "validFrom", "validTo", "recordedAt", "source", "supersededAt"],
  /** TFSA over-limit alerts, open and cleared (one per Toronto year). */
  roomAlerts: ["year", "excessCad", "estimated", "note", "raisedAt", "updatedAt", "clearedAt"],
  /** Thesis-condition and limit nudges, open and cleared. */
  nudges: ["kind", "target", "conditionId", "basis", "text", "raisedAt", "updatedAt", "clearedAt"],
} as const;

type Table = keyof typeof EXPORT_FIELDS;
export type ExportCounts = Record<Table, number>;

export interface AccountExportOptions {
  prisma: ExportPrismaPort;
  aiApps?: { list(subject: string): Promise<readonly object[]> };
  memory?: { listForExport(subject: string): Promise<readonly object[]> };
  roomAlerts?: { listForExport(subject: string): Promise<readonly object[]> };
  nudges?: { listForExport(subject: string): Promise<readonly object[]> };
  now?: () => Date;
}

function pick(row: object, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) if (field in row) out[field] = (row as Record<string, unknown>)[field];
  return out;
}

function selectOf(fields: readonly string[]): Record<string, true> {
  return Object.fromEntries(["id", ...fields].map((f) => [f, true as const]));
}

export class AccountExportService {
  constructor(private readonly o: AccountExportOptions) {}

  /**
   * Writes the document through `write` (which should honour back-pressure). Rejects part-way on any failure; the
   * partial text is deliberately never closed, so a caller must abort the transport rather than end it cleanly.
   */
  async stream(subject: string, write: (chunk: string) => Promise<void>): Promise<ExportCounts> {
    const now = (this.o.now ?? (() => new Date()))();
    const counts = Object.fromEntries(Object.keys(EXPORT_FIELDS).map((t) => [t, 0])) as ExportCounts;
    const user = await this.o.prisma.appUser.findUnique({ where: { authSubject: subject }, select: { id: true } });
    const appUserId = user?.id ?? null;

    await write(`{"exportedAt":${JSON.stringify(now.toISOString())},"format":${JSON.stringify(EXPORT_FORMAT)},"note":${JSON.stringify(EXPORT_NOTE)}`);

    const paged = async (table: Table, delegate: ExportDelegate | null, pageSize = PAGE_SIZE) => {
      await write(`,"${table}":[`);
      if (delegate && appUserId) {
        const fields = EXPORT_FIELDS[table];
        let cursor: string | undefined;
        let first = true;
        for (;;) {
          const rows = await delegate.findMany({
            where: { appUserId }, select: selectOf(fields), orderBy: { id: "asc" }, take: pageSize,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 as const } : {}),
          });
          if (rows.length > 0) {
            await write((first ? "" : ",") + rows.map((r) => JSON.stringify(pick(r, fields))).join(","));
            first = false;
            counts[table] += rows.length;
            cursor = String(rows[rows.length - 1]!.id);
          }
          if (rows.length < pageSize) break;
        }
      }
      await write("]");
    };

    const p = this.o.prisma;
    await paged("connections", p.brokerageConnection);
    await paged("accounts", p.brokerageAccount);
    await paged("snapshots", p.portfolioSnapshot, SNAPSHOT_PAGE_SIZE);
    await paged("activities", p.activity);
    await paged("dailyValues", p.dailyValue);

    const listed = async (table: "activitySyncStates" | "accountHistoryQualities", delegate: ExportListDelegate) => {
      const fields = EXPORT_FIELDS[table];
      const rows = appUserId
        ? await delegate.findMany({ where: { appUserId }, select: selectOf(fields), orderBy: { snapTradeAccountId: "asc" } })
        : [];
      counts[table] = rows.length;
      await write(`,"${table}":${JSON.stringify(rows.map((r) => pick(r, fields)))}`);
    };
    await listed("activitySyncStates", p.activitySyncState);
    await listed("accountHistoryQualities", p.accountHistoryQuality);

    const settings = appUserId
      ? await p.portfolioSettings.findUnique({ where: { appUserId }, select: selectOf(EXPORT_FIELDS.settings) })
      : null;
    await write(`,"settings":${settings ? JSON.stringify(pick(settings, EXPORT_FIELDS.settings)) : "null"}`);
    counts.settings = settings ? 1 : 0;

    await paged("newsAlertDeliveries", p.newsAlertDelivery);
    await paged("pendingDisconnects", p.pendingDisconnect);

    // Keyed by subject, so these work for a user with no AppUser row.
    const aiApps = (await this.o.aiApps?.list(subject) ?? []).map((r) => pick(r, EXPORT_FIELDS.aiApps));
    counts.aiApps = aiApps.length;
    await write(`,"aiApps":${JSON.stringify(aiApps)}`);
    const memory = (await this.o.memory?.listForExport(subject) ?? []).map((r) => pick(r, EXPORT_FIELDS.memory));
    counts.memory = memory.length;
    await write(`,"memory":${JSON.stringify(memory)}`);
    const roomAlerts = (await this.o.roomAlerts?.listForExport(subject) ?? []).map((r) => pick(r, EXPORT_FIELDS.roomAlerts));
    counts.roomAlerts = roomAlerts.length;
    await write(`,"roomAlerts":${JSON.stringify(roomAlerts)}`);
    const nudges = (await this.o.nudges?.listForExport(subject) ?? []).map((r) => pick(r, EXPORT_FIELDS.nudges));
    counts.nudges = nudges.length;
    await write(`,"nudges":${JSON.stringify(nudges)}}`);
    return counts;
  }
}
