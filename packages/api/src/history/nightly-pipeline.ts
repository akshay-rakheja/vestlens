import { newsSymbolsFromAccounts, type NewsSymbol } from "../news/refresh-service.js";
import type { PortfolioPresentationAccount } from "../portfolio/portfolio-presentation.js";
import type { RoomAlertOutcome } from "../room/room-alerts.js";
import type { ActivitySyncService } from "./activity-sync-service.js";

type PipelineUser = { id: string; authSubject: string };

export interface NightlyNewsResult { symbols: number; fetched: number; rated: number; failures: number; budgetLeft: number }

/** Counts only. `evaluated` excludes failures. */
export interface NightlyRoomResult { evaluated: number; raised: number; updated: number; cleared: number; failed: number }

/** Counts only. `evaluated` excludes users not evaluated; `failed` counts thrown users, failed parts and skipped users. */
export interface NightlyNudgeResult { evaluated: number; raised: number; cleared: number; failed: number }

export type NightlyLogEvent =
  | { event: "news_skipped"; reason: "no_time"; users: number; deferred: number }
  | ({ event: "room_alerts" } & NightlyRoomResult)
  | ({ event: "portfolio_nudges" } & NightlyNudgeResult);

export interface NightlyPipelineResult {
  users: number; synced: number; reconstructed: number; rows: number; failures: number; deferred: number; failureCodes: Record<string, number>;
  /** Present only when a news step is composed and ran. */
  news?: NightlyNewsResult;
  /** Present only when the room alert step is composed. */
  room?: NightlyRoomResult;
  /** Present only when the nudge step is composed. */
  nudges?: NightlyNudgeResult;
}

/** Counts only. The history catch-up's result (runPending). */
export interface CatchUpResult { users: number; synced: number; reconstructed: number; rows: number; failures: number; deferred: number; failureCodes: Record<string, number> }

export class NightlyPipeline {
  constructor(private readonly options: {
    users(): Promise<PipelineUser[]>;
    /** People whose first history read is still due (history/pending-history.ts), for runPending. */
    pending?: () => Promise<PipelineUser[]>;
    sync: Pick<ActivitySyncService, "syncUser">;
    reconstruct: { reconstructUser(authSubject: string): Promise<{ accounts: number; failures: number; codes?: Record<string, number> }> };
    /** With `keepAccounts`, hands back the accounts the capture read so news symbols need no second read. */
    snapshot: { captureFor(user: PipelineUser, options: { keepAccounts: boolean }): Promise<{ rows: number; failed: boolean; accounts?: PortfolioPresentationAccount[] }> };
    /** Optional news refresh after the snapshots, given the users processed this run and the remaining time budget. */
    news?: { refreshAll(users: () => Promise<Array<{ symbols: NewsSymbol[] }>>, options: { budgetMs: number }): Promise<NightlyNewsResult> };
    /**
     * Optional TFSA over-limit alert evaluation from stored inputs, per user after their sync, snapshot and
     * reconstruction. A user's failure is counted (room_alert_error) and never stops the run.
     */
    roomAlerts?: { evaluate(authSubject: string): Promise<RoomAlertOutcome> };
    /**
     * Optional thesis-condition and limit nudges, per user after the room alert, from the accounts this run's
     * snapshot read (no second read). A user whose read failed or was partial is skipped, so their nudges stay as they
     * are. A user's failure is counted (nudge_error) and never stops the run.
     */
    nudges?: { evaluate(authSubject: string, portfolio: { accounts: PortfolioPresentationAccount[] }): Promise<{ raised: number; cleared: number; failed: number }> };
    /** Best-effort purge of expired market-data cache rows after the run (ruling F4). */
    purgeCache?: () => Promise<unknown>;
    budgetMs?: number;
    now?: () => number;
    /** Counts-only events (default: one JSON line on stdout). */
    log?: (e: NightlyLogEvent) => void;
  }) {}

  /**
   * The history catch-up (every 10 minutes): for people who linked recently and whose first activity read is due, the
   * nightly run's sync, snapshot and reconstruction steps, nothing else (no news, alerts, nudges or purge).
   */
  async runPending(): Promise<CatchUpResult> {
    return this.catchUp(this.options.pending ? await this.options.pending() : []);
  }

  /**
   * "Refresh now": the sync, snapshot and reconstruction steps for every user (the owner), nothing else (no news,
   * alerts, nudges or purge), within the same time budget.
   */
  async refreshUsers(): Promise<CatchUpResult> {
    return this.catchUp(await this.options.users());
  }

  private async catchUp(users: PipelineUser[]): Promise<CatchUpResult> {
    const failureCodes: Record<string, number> = {};
    const result: CatchUpResult = { users: users.length, synced: 0, reconstructed: 0, rows: 0, failures: 0, deferred: 0, failureCodes };
    const fail = (code: string, n = 1) => { if (n <= 0) return; result.failures += n; failureCodes[code] = (failureCodes[code] ?? 0) + n; };
    const now = this.options.now ?? Date.now;
    const budgetMs = this.options.budgetMs ?? 240_000;
    const startedAt = now();
    for (const [index, user] of users.entries()) {
      if (now() - startedAt >= budgetMs) {
        result.deferred = users.length - index;
        break;
      }
      await this.catchUpUser(user, result, fail);
    }
    return result;
  }

  private async catchUpUser(user: PipelineUser, result: CatchUpResult, fail: (code: string, n?: number) => void): Promise<void> {
    try {
      const synced = await this.options.sync.syncUser(user.authSubject);
      if (!synced.skipped) result.synced += 1;
      for (const [code, n] of Object.entries(synced.codes ?? {})) fail(code, n);
      if (!synced.codes) fail("sync_failed", synced.failures ?? 0);
    } catch {
      fail("sync_error");
    }
    try {
      const captured = await this.options.snapshot.captureFor(user, { keepAccounts: false });
      result.rows += captured.rows;
      if (captured.failed) fail("snapshot_failed");
    } catch {
      fail("snapshot_error");
    }
    try {
      const rebuilt = await this.options.reconstruct.reconstructUser(user.authSubject);
      result.reconstructed += 1;
      for (const [code, n] of Object.entries(rebuilt?.codes ?? {})) fail(code, n);
      if (!rebuilt?.codes) fail("reconstruct_failed", rebuilt?.failures ?? 0);
    } catch {
      fail("reconstruct_error");
    }
  }

  async runAll(): Promise<NightlyPipelineResult> {
    const linked = await this.options.users();
    const users = linked;
    let synced = 0;
    let reconstructed = 0;
    let rows = 0;
    let failures = 0;
    let deferred = 0;
    const failureCodes: Record<string, number> = {};
    const note = (code: string, n = 1) => { failureCodes[code] = (failureCodes[code] ?? 0) + n; };
    const merge = (codes?: Record<string, number>) => { for (const [k, n] of Object.entries(codes ?? {})) note(k, n); };
    const now = this.options.now ?? Date.now;
    const budgetMs = this.options.budgetMs ?? 240_000;
    const startedAt = now();
    const keepAccounts = Boolean(this.options.news || this.options.nudges);
    const newsUsers: Array<{ symbols: NewsSymbol[] }> = [];
    const room: NightlyRoomResult = { evaluated: 0, raised: 0, updated: 0, cleared: 0, failed: 0 };
    const nudges: NightlyNudgeResult = { evaluated: 0, raised: 0, cleared: 0, failed: 0 };
    const log = this.options.log ?? ((e: NightlyLogEvent) => console.info(JSON.stringify(e)));
    for (const [index, user] of users.entries()) {
      if (now() - startedAt >= budgetMs) {
        deferred = users.length - index;
        break;
      }
      try {
        const result = await this.options.sync.syncUser(user.authSubject);
        if (!result.skipped) synced += 1;
        failures += result.failures ?? 0;
        merge(result.codes);
      } catch {
        failures += 1;
        note("sync_error");
      }
      // Snapshot before reconstruct: reconstruction reuses the snapshot's fresh cached read
      // instead of triggering a second provider read.
      // Accounts from a complete, fresh read only: the nudge step evaluates nothing from a partial or fallback one.
      let nudgeAccounts: PortfolioPresentationAccount[] | null = null;
      try {
        const captured = await this.options.snapshot.captureFor(user, { keepAccounts });
        rows += captured.rows;
        if (captured.failed) { failures += 1; note("snapshot_failed"); }
        if (!captured.failed && captured.accounts) nudgeAccounts = captured.accounts;
        if (this.options.news) {
          // A failed read is already counted above; a successful one without usable accounts is counted here.
          let symbols: NewsSymbol[] | null = null;
          try {
            if (captured.accounts) symbols = newsSymbolsFromAccounts(captured.accounts);
          } catch {
            symbols = null;
          }
          if (symbols) newsUsers.push({ symbols });
          else if (!captured.failed || captured.accounts) { failures += 1; note("news_symbols_failed"); }
        }
      } catch {
        failures += 1;
        note("snapshot_error");
      }
      try {
        const result = await this.options.reconstruct.reconstructUser(user.authSubject);
        reconstructed += 1;
        failures += result?.failures ?? 0;
        merge(result?.codes);
      } catch {
        failures += 1;
        note("reconstruct_error");
      }
      if (this.options.roomAlerts) {
        try {
          const outcome = await this.options.roomAlerts.evaluate(user.authSubject);
          room.evaluated += 1;
          if (outcome !== "none") room[outcome] += 1;
        } catch {
          room.failed += 1;
          failures += 1;
          note("room_alert_error");
        }
      }
      if (this.options.nudges) {
        if (!nudgeAccounts) {
          nudges.failed += 1; // already counted as a snapshot failure
        } else {
          try {
            const outcome = await this.options.nudges.evaluate(user.authSubject, { accounts: nudgeAccounts });
            nudges.evaluated += 1;
            nudges.raised += outcome.raised;
            nudges.cleared += outcome.cleared;
            if (outcome.failed > 0) { nudges.failed += outcome.failed; failures += outcome.failed; note("nudge_error", outcome.failed); }
          } catch {
            nudges.failed += 1;
            failures += 1;
            note("nudge_error");
          }
        }
      }
    }
    if (this.options.roomAlerts) log({ event: "room_alerts", ...room });
    if (this.options.nudges) log({ event: "portfolio_nudges", ...nudges });
    let news: NightlyNewsResult | undefined;
    const remainingMs = budgetMs - (now() - startedAt);
    if (this.options.news && remainingMs <= 0) {
      // The user loop used the whole budget: say so (counts only) rather than skip silently.
      note("news_skipped");
      log({ event: "news_skipped", reason: "no_time", users: newsUsers.length, deferred });
    }
    if (this.options.news && remainingMs > 0) {
      try {
        const r = await this.options.news.refreshAll(async () => newsUsers, { budgetMs: remainingMs });
        news = { symbols: r.symbols, fetched: r.fetched, rated: r.rated, failures: r.failures, budgetLeft: r.budgetLeft };
        if (r.failures > 0) { failures += r.failures; note("news_failed", r.failures); }
      } catch {
        failures += 1;
        note("news_error");
      }
    }
    try {
      await this.options.purgeCache?.();
    } catch {
      // Expired rows are only dead weight; the next run retries. Nothing is logged.
    }
    return { users: users.length, synced, reconstructed, rows, failures, deferred, failureCodes, ...(news ? { news } : {}), ...(this.options.roomAlerts ? { room } : {}), ...(this.options.nudges ? { nudges } : {}) };
  }
}
