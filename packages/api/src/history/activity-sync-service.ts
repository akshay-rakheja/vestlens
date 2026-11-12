import { SnapTradeKeyRejectedError, type SnapTradeCredentials, type SnapTradeGateway } from "../snaptrade/gateway.js";
import type { ActivityStore } from "./activity-store.js";
import { toStoredActivities, type StoredActivity } from "./stored-activity.js";

const PAGE_LIMIT = 1000;
const MAX_PAGES = 50;
const WINDOW_DAYS = 30;
/** A full read this often lets SnapTrade's corrections to old rows (cancellations, reissued ids) reach us. */
const FULL_REFRESH_DAYS = 7;
/** A full read returning less than this share of the stored rows looks like a provider fault: prune nothing. */
const PRUNE_MIN_RETURNED_SHARE = 0.9;
const PROVIDER_TIMEOUT_MS = 15_000;

export interface ActivityProvider {
  listAccountIds(credentials: SnapTradeCredentials): Promise<string[]>;
  activitiesPage(
    credentials: SnapTradeCredentials,
    accountId: string,
    page: { offset: number; limit: number; startDate?: string },
  ): Promise<unknown>;
}

export function createSnapTradeActivityProvider(
  gateway: Pick<SnapTradeGateway, "listAccounts" | "getActivities">,
): ActivityProvider {
  return {
    async listAccountIds(credentials) {
      const accounts = await gateway.listAccounts(credentials);
      if (!Array.isArray(accounts)) return [];
      const ids: string[] = [];
      for (const account of accounts) {
        const id = (account as { id?: unknown } | null)?.id;
        if (typeof id === "string" && id.length > 0) ids.push(id);
      }
      return ids;
    },
    activitiesPage(credentials, accountId, page) {
      const options: { offset: number; limit: number; startDate?: string } = { offset: page.offset, limit: page.limit };
      if (page.startDate !== undefined) options.startDate = page.startDate;
      return gateway.getActivities(credentials, accountId, options, { timeout: PROVIDER_TIMEOUT_MS });
    },
  };
}

export interface ActivitySyncResult {
  accounts: number;
  written: number;
  failures: number;
  skipped: boolean;
  /** Failure reason codes with counts (no identifiers). */
  codes?: Record<string, number>;
}

const torontoDay = (date: Date): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

function shiftDay(day: string, deltaDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

interface State { backfillCompletedAt: Date | null; lastSyncedAt: Date | null; lastError: string | null; dirty: boolean }

/**
 * undefined => run the full backfill path (no startDate). The last full read is under a week old
 * otherwise, so a 30-day window always overlaps it, whether or not later syncs failed.
 */
function incrementalStart(now: Date, state: State | null): string | undefined {
  if (!state?.backfillCompletedAt) return undefined;
  if (now.getTime() - state.backfillCompletedAt.getTime() > FULL_REFRESH_DAYS * 86_400_000) return undefined;
  return shiftDay(torontoDay(now), -WINDOW_DAYS);
}

export class ActivitySyncService {
  private readonly now: () => Date;
  private readonly minIntervalMs: number;

  constructor(
    private readonly options: {
      identity: { getExisting(subject: string): Promise<SnapTradeCredentials | null> };
      provider: ActivityProvider;
      store: ActivityStore;
      now?: () => Date;
      minIntervalMs?: number;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.minIntervalMs = options.minIntervalMs ?? 600_000;
  }

  async syncUser(authSubject: string): Promise<ActivitySyncResult> {
    const { identity, provider, store } = this.options;
    const skipped: ActivitySyncResult = { accounts: 0, written: 0, failures: 0, skipped: true };
    const credentials = await identity.getExisting(authSubject);
    if (!credentials) return skipped;
    const appUserId = await store.userId(authSubject);
    if (!appUserId) return skipped;

    let accountIds: string[];
    try {
      accountIds = await provider.listAccountIds(credentials);
    } catch (error) {
      const code = error instanceof SnapTradeKeyRejectedError ? "snaptrade_key_rejected" : "sync_list_accounts";
      return { accounts: 0, written: 0, failures: 1, skipped: false, codes: { [code]: 1 } };
    }

    const nowMs = this.now().getTime();
    const stale: Array<{ id: string; startDate: string | undefined }> = [];
    for (const id of accountIds) {
      const state = await store.syncState(appUserId, id);
      const fresh = state && !state.dirty && state.lastError === null && state.lastSyncedAt && nowMs - state.lastSyncedAt.getTime() < this.minIntervalMs;
      if (!fresh) stale.push({ id, startDate: incrementalStart(this.now(), state) });
    }
    if (stale.length === 0) return skipped;

    let written = 0;
    let failures = 0;
    for (const account of stale) {
      try {
        written += await this.syncAccount(credentials, appUserId, account.id, account.startDate);
      } catch {
        failures += 1;
        try {
          await store.recordSync(appUserId, account.id, { error: "provider_error" });
        } catch {
          // state bookkeeping must not abort remaining accounts
        }
      }
    }
    return { accounts: stale.length, written, failures, skipped: false, ...(failures ? { codes: { sync_account: failures } } : {}) };
  }

  private async syncAccount(
    credentials: SnapTradeCredentials,
    appUserId: string,
    accountId: string,
    startDate: string | undefined,
  ): Promise<number> {
    const { provider, store } = this.options;
    const backfilled = startDate !== undefined;
    // A window read returns every row since startDate, so rows it misses there are stale too; the
    // first day is left to the weekly full read in case the provider's day boundary differs from ours.
    const windowFloor = startDate === undefined ? null : shiftDay(startDate, 1);
    const storedDays = (await store.listActivities(appUserId, accountId)).map((a) => a.tradeDate ?? a.settlementDate ?? "");
    const returned = new Set<string>();
    let written = 0;
    let earliest: string | null = null;
    let offset = 0;
    let truncated = true;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await provider.activitiesPage(
        credentials,
        accountId,
        startDate === undefined ? { offset, limit: PAGE_LIMIT } : { offset, limit: PAGE_LIMIT, startDate },
      );
      const { items, total, dropped } = toStoredActivities(accountId, response);
      written += await store.upsertActivities(appUserId, items);
      for (const item of items) returned.add(item.dedupeKey);
      earliest = earliestOf(earliest, items);
      const fetched = items.length + dropped;
      offset += fetched;
      if (fetched < PAGE_LIMIT || (total !== null && offset >= total)) {
        truncated = false;
        break;
      }
    }
    if (truncated) {
      await store.recordSync(appUserId, accountId, { error: "backfill_truncated" });
      return written;
    }
    // Measure the read against only the stored rows it could prune: a full read never touches rows
    // older than the earliest it returned, so history the provider has stopped serving stays out of the share.
    const floor = windowFloor ?? earliest;
    const stored = floor === null ? storedDays.length : storedDays.filter((day) => day >= floor).length;
    if (stored > 0) {
      if (floor === null || returned.size < stored * PRUNE_MIN_RETURNED_SHARE) {
        console.log(JSON.stringify({ event: "activity_prune_skipped", stored, returned: returned.size }));
      } else {
        const removed = await store.pruneActivities(appUserId, accountId, returned, floor);
        if (removed > 0) console.log(JSON.stringify({ event: "activity_prune", removed }));
      }
    }
    await store.recordSync(
      appUserId,
      accountId,
      backfilled ? {} : { backfillCompleted: true, activityCount: written, earliestTradeDate: earliest },
    );
    return written;
  }
}

function earliestOf(current: string | null, items: StoredActivity[]): string | null {
  let min = current;
  for (const item of items) {
    const day = item.tradeDate ?? item.settlementDate;
    if (day && (min === null || day < min)) min = day;
  }
  return min;
}
