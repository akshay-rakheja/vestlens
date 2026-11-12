import type { StoredActivity } from "./stored-activity.js";
import type { UnrecordedFlow } from "./unrecorded-flows.js";

type DecimalLike = number | string | { toString(): string } | null;

interface ActivityData {
  appUserId: string;
  snapTradeAccountId: string;
  dedupeKey: string;
  type: string;
  symbol: string | null;
  securityCurrency: string | null;
  isOption: boolean;
  units: number | null;
  price: number | null;
  amount: number | null;
  fee: number | null;
  fxRate: number | null;
  currency: string | null;
  tradeDate: Date | null;
  settlementDate: Date | null;
  description: string | null;
  syncedAt: Date;
}

interface ActivityRow {
  snapTradeAccountId: string;
  dedupeKey: string;
  type: string;
  symbol: string | null;
  securityCurrency: string | null;
  isOption: boolean;
  units: DecimalLike;
  price: DecimalLike;
  amount: DecimalLike;
  fee: DecimalLike;
  fxRate: DecimalLike;
  currency: string | null;
  tradeDate: Date | null;
  settlementDate: Date | null;
  description: string | null;
}

interface SyncStateRow {
  backfillCompletedAt: Date | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
  dirty: boolean;
}

interface SyncStateKey { appUserId_snapTradeAccountId: { appUserId: string; snapTradeAccountId: string } }

interface SyncStateData {
  lastSyncedAt?: Date;
  backfillCompletedAt?: Date;
  lastError?: string | null;
  dirty?: boolean;
  activityCount?: number;
  earliestTradeDate?: Date | null;
}

interface QualityData {
  method: string;
  reason: string | null;
  driftFraction: number | null;
  /** JSON array of UnrecordedFlow, or null when none were found (spec 2026-11-04-unrecorded-flow-check). */
  unrecordedFlows: string | null;
  computedAt: Date;
}

export interface ActivityStorePort {
  appUser: {
    findUnique(input: { where: { authSubject: string }; select: { id: true } }): Promise<{ id: string } | null>;
  };
  activity: {
    upsert(input: {
      where: { appUserId_dedupeKey: { appUserId: string; dedupeKey: string } };
      create: ActivityData;
      update: Omit<ActivityData, "appUserId" | "dedupeKey">;
    }): Promise<unknown>;
    findMany(input: {
      where: {
        appUserId: string;
        snapTradeAccountId: string | { in: string[] };
        OR?: Array<{ tradeDate: { gte: Date; lte: Date } } | { tradeDate: null; settlementDate: { gte: Date; lte: Date } }>;
        type?: { in: string[] };
      };
    }): Promise<ActivityRow[]>;
    deleteMany(input: { where: { appUserId: string; snapTradeAccountId: string; dedupeKey: { in: string[] } } }): Promise<{ count: number }>;
  };
  activitySyncState: {
    findUnique(input: { where: SyncStateKey }): Promise<SyncStateRow | null>;
    upsert(input: {
      where: SyncStateKey;
      create: SyncStateData & { appUserId: string; snapTradeAccountId: string };
      update: SyncStateData;
    }): Promise<unknown>;
    updateMany(input: { where: { appUserId: string }; data: { dirty: boolean } }): Promise<unknown>;
    findMany(input: { where: { appUserId: string } }): Promise<unknown[]>;
  };
  accountHistoryQuality: {
    upsert(input: {
      where: SyncStateKey;
      create: QualityData & { appUserId: string; snapTradeAccountId: string };
      update: QualityData;
    }): Promise<unknown>;
    deleteMany(input: { where: { appUserId: string; snapTradeAccountId: { notIn: string[] } } }): Promise<unknown>;
    findMany(input: { where: { appUserId: string } }): Promise<Array<{
      snapTradeAccountId: string;
      method: string;
      reason: string | null;
      driftFraction: DecimalLike;
      unrecordedFlows?: string | null;
      computedAt: Date;
    }>>;
  };
}

const toDate = (value: string | null): Date | null => (value ? new Date(`${value}T00:00:00.000Z`) : null);
const toDay = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);
const toNumber = (value: DecimalLike): number | null => (value === null || value === undefined ? null : Number(value));
/** Stored unrecorded flows; anything unreadable is dropped rather than trusted. */
function parseUnrecordedFlows(raw: string | null | undefined): UnrecordedFlow[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is UnrecordedFlow => typeof e?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && typeof e.amount === "number" && Number.isFinite(e.amount));
  } catch {
    return [];
  }
}

function fromRow(row: ActivityRow): StoredActivity {
  return {
    snapTradeAccountId: row.snapTradeAccountId,
    dedupeKey: row.dedupeKey,
    type: row.type,
    symbol: row.symbol,
    securityCurrency: row.securityCurrency,
    isOption: row.isOption,
    units: toNumber(row.units),
    price: toNumber(row.price),
    amount: toNumber(row.amount),
    fee: toNumber(row.fee),
    fxRate: toNumber(row.fxRate),
    currency: row.currency,
    tradeDate: toDay(row.tradeDate),
    settlementDate: toDay(row.settlementDate),
    description: row.description,
  };
}

export class ActivityStore {
  constructor(private readonly prisma: ActivityStorePort, private readonly now: () => Date = () => new Date()) {}

  async userId(authSubject: string): Promise<string | null> {
    const user = await this.prisma.appUser.findUnique({ where: { authSubject }, select: { id: true } });
    return user?.id ?? null;
  }

  async upsertActivities(appUserId: string, items: StoredActivity[]): Promise<number> {
    let written = 0;
    const syncedAt = this.now();
    for (const item of items) {
      const { dedupeKey, ...rest } = item;
      const fields = {
        snapTradeAccountId: rest.snapTradeAccountId,
        type: rest.type,
        symbol: rest.symbol,
        securityCurrency: rest.securityCurrency,
        isOption: rest.isOption,
        units: rest.units,
        price: rest.price,
        amount: rest.amount,
        fee: rest.fee,
        fxRate: rest.fxRate,
        currency: rest.currency,
        tradeDate: toDate(rest.tradeDate),
        settlementDate: toDate(rest.settlementDate),
        description: rest.description,
        syncedAt,
      };
      await this.prisma.activity.upsert({
        where: { appUserId_dedupeKey: { appUserId, dedupeKey } },
        create: { appUserId, dedupeKey, ...fields },
        update: fields,
      });
      written += 1;
    }
    return written;
  }

  /**
   * After a complete full read: deletes the account's rows SnapTrade no longer returns (a cancelled
   * deposit it now hides, or the old copy of a row it reissued under a new id). Rows dated before
   * `since`, the earliest date it still returned, stay: history it stops serving is kept, not lost.
   */
  async pruneActivities(appUserId: string, accountId: string, keep: Set<string>, since: string): Promise<number> {
    const stale = (await this.listActivities(appUserId, accountId))
      .filter((a) => !keep.has(a.dedupeKey) && (a.tradeDate ?? a.settlementDate ?? "") >= since)
      .map((a) => a.dedupeKey);
    let removed = 0;
    for (let i = 0; i < stale.length; i += 1000) {
      removed += (await this.prisma.activity.deleteMany({ where: { appUserId, snapTradeAccountId: accountId, dedupeKey: { in: stale.slice(i, i + 1000) } } })).count;
    }
    return removed;
  }

  async listActivities(appUserId: string, accountId: string): Promise<StoredActivity[]> {
    const rows = await this.prisma.activity.findMany({ where: { appUserId, snapTradeAccountId: accountId } });
    return rows
      .map(fromRow)
      .sort((a, b) => {
        const da = a.tradeDate ?? a.settlementDate;
        const db = b.tradeDate ?? b.settlementDate;
        if (da !== db) {
          if (da === null) return 1;
          if (db === null) return -1;
          return da < db ? -1 : 1;
        }
        return a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0;
      });
  }

  /**
   * Filtered, keyset-paged read for the activity feed. A row's date is
   * `tradeDate ?? settlementDate`, which no single indexed column expresses, so
   * the DB narrows by account, type and the date range on either column; symbol is
   * matched in code only, exactly (trim + uppercase on both sides, so padded stored symbols
   * still match; get_symbol_history relies on it; show_activity reads without it and matches
   * listings itself with symbolMatches) and the exact date filter, ordering and paging happen here. A user has at
   * most a few thousand rows, so this is cheap. Order: date desc, dedupeKey desc.
   * `before` is exclusive (date < d, or date = d and key < k). Undated rows are
   * excluded. No `limit` returns every match (used for totals).
   */
  async queryActivities(
    appUserId: string,
    q: {
      accountIds: string[];
      from: string;
      to: string;
      types?: string[];
      symbol?: string;
      before?: { date: string; key: string } | null;
      limit?: number;
    },
  ): Promise<StoredActivity[]> {
    if (q.accountIds.length === 0) return [];
    const range = { gte: toDate(q.from)!, lte: toDate(q.to)! };
    const symbol = q.symbol?.trim().toUpperCase();
    const rows = await this.prisma.activity.findMany({
      where: {
        appUserId,
        snapTradeAccountId: { in: q.accountIds },
        OR: [{ tradeDate: range }, { tradeDate: null, settlementDate: range }],
        ...(q.types ? { type: { in: q.types } } : {}),
      },
    });
    const before = q.before ?? null;
    const dated: Array<{ date: string; row: StoredActivity }> = [];
    for (const raw of rows) {
      const row = fromRow(raw);
      const date = row.tradeDate ?? row.settlementDate;
      if (date === null || date < q.from || date > q.to) continue;
      if (q.types && !q.types.includes(row.type)) continue;
      if (symbol && (row.symbol ?? "").trim().toUpperCase() !== symbol) continue;
      if (before && !(date < before.date || (date === before.date && row.dedupeKey < before.key))) continue;
      dated.push({ date, row });
    }
    dated.sort((a, b) =>
      a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.row.dedupeKey < b.row.dedupeKey ? 1 : a.row.dedupeKey > b.row.dedupeKey ? -1 : 0);
    const out = dated.map((d) => d.row);
    return q.limit === undefined ? out : out.slice(0, Math.max(0, q.limit));
  }

  async syncState(appUserId: string, accountId: string) {
    const row = await this.prisma.activitySyncState.findUnique({
      where: { appUserId_snapTradeAccountId: { appUserId, snapTradeAccountId: accountId } },
    });
    return row
      ? { backfillCompletedAt: row.backfillCompletedAt, lastSyncedAt: row.lastSyncedAt, lastError: row.lastError ?? null, dirty: row.dirty }
      : null;
  }

  async recordSync(
    appUserId: string,
    accountId: string,
    update: { backfillCompleted?: boolean; error?: string | null; activityCount?: number; earliestTradeDate?: string | null },
  ): Promise<void> {
    const now = this.now();
    const data: SyncStateData = { lastSyncedAt: now };
    if (update.backfillCompleted === true) data.backfillCompletedAt = now;
    if (update.error === undefined || update.error === null) {
      data.lastError = null;
      data.dirty = false;
    } else {
      data.lastError = update.error === "" ? "unknown_error" : update.error;
    }
    if (update.activityCount !== undefined) data.activityCount = update.activityCount;
    if (update.earliestTradeDate !== undefined) data.earliestTradeDate = toDate(update.earliestTradeDate);
    await this.prisma.activitySyncState.upsert({
      where: { appUserId_snapTradeAccountId: { appUserId, snapTradeAccountId: accountId } },
      create: { appUserId, snapTradeAccountId: accountId, ...data },
      update: data,
    });
  }

  async markDirty(appUserId: string): Promise<void> {
    await this.prisma.activitySyncState.updateMany({ where: { appUserId }, data: { dirty: true } });
  }

  async saveQuality(
    appUserId: string,
    accountId: string,
    quality: { method: "reconstructed" | "snapshots_only"; reason: string | null; driftFraction: number | null; unrecordedFlows?: UnrecordedFlow[] },
  ): Promise<void> {
    // Replaced on every run: a flow SnapTrade later backfills stops being flagged by itself.
    const unrecordedFlows = quality.unrecordedFlows?.length ? JSON.stringify(quality.unrecordedFlows) : null;
    const data = { method: quality.method, reason: quality.reason, driftFraction: quality.driftFraction, unrecordedFlows, computedAt: this.now() };
    await this.prisma.accountHistoryQuality.upsert({
      where: { appUserId_snapTradeAccountId: { appUserId, snapTradeAccountId: accountId } },
      create: { appUserId, snapTradeAccountId: accountId, ...data },
      update: data,
    });
  }

  /** Drops quality rows for accounts outside `accountIds` (M6). */
  async deleteQualitiesExcept(appUserId: string, accountIds: string[]): Promise<void> {
    await this.prisma.accountHistoryQuality.deleteMany({ where: { appUserId, snapTradeAccountId: { notIn: accountIds } } });
  }

  async qualities(authSubject: string) {
    const appUserId = await this.userId(authSubject);
    if (!appUserId) return [];
    const rows = await this.prisma.accountHistoryQuality.findMany({ where: { appUserId } });
    return rows.map((row) => {
      const unrecordedFlows = parseUnrecordedFlows(row.unrecordedFlows);
      return {
        accountId: row.snapTradeAccountId,
        method: row.method,
        reason: row.reason,
        driftFraction: toNumber(row.driftFraction),
        computedAt: row.computedAt.toISOString(),
        ...(unrecordedFlows.length ? { unrecordedFlows } : {}),
      };
    });
  }
}
