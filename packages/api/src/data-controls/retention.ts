/**
 * Retention policy for stored provider data. The privacy policy and help article quote
 * these periods; change them together.
 */
import { ACCESS_TOKEN_MAX_ACCEPT_MS } from "../gateway/tokens.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const RETENTION = {
  /**
   * Sanitized PortfolioSnapshot rows, from capturedAt. The newest snapshot of each account that
   * still exists is kept past this age: a new row is written only when SnapTrade's positionsAsOf
   * moves, so it can be the account's only "last good" fallback.
   */
  snapshotDays: 90,
  /** Verified SnapTrade webhook receipts, from receivedAt. */
  webhookEventDays: 30,
  /**
   * Unconfirmed PendingDisconnect markers, from requestedAt: after a final re-purge the marker
   * goes even if CONNECTION_DELETED never arrived. Confirmed markers go as soon as their purge
   * succeeds.
   */
  pendingDisconnectDays: 30,
} as const;

/** Extra time a subject-wide revocation marker is kept past the last token it could refuse. */
export const SUBJECT_REVOCATION_MARGIN_MS = 60 * 60 * 1000;
/**
 * Subject-wide ("*") gateway revocation markers written by account deletion, from revokedAt.
 * The marker must outlive every gateway access token issued before the delete, so it is kept
 * for the access-token lifetime (with clock tolerance, read from the gateway token code) plus a
 * margin, then swept by the nightly data-controls run.
 */
export const SUBJECT_REVOCATION_RETENTION_MS = ACCESS_TOKEN_MAX_ACCEPT_MS + SUBJECT_REVOCATION_MARGIN_MS;

/** Subject-wide revocation markers written before this are swept. */
export function subjectRevocationCutoff(now: Date): Date {
  return new Date(now.getTime() - SUBJECT_REVOCATION_RETENTION_MS);
}

/** Most pending-disconnect markers one user may hold; a new disconnect beyond it is refused. */
export const MAX_PENDING_DISCONNECTS_PER_USER = 20;

/** Unconfirmed markers requested before this are aged out by the nightly sweep. */
export function pendingDisconnectCutoff(now: Date): Date {
  return new Date(now.getTime() - RETENTION.pendingDisconnectDays * DAY_MS);
}

export function retentionCutoffs(now: Date): { snapshotsBefore: Date; webhookEventsBefore: Date } {
  return {
    snapshotsBefore: new Date(now.getTime() - RETENTION.snapshotDays * DAY_MS),
    webhookEventsBefore: new Date(now.getTime() - RETENTION.webhookEventDays * DAY_MS),
  };
}

export interface RetentionResult {
  snapshots: number;
  webhookEvents: number;
  /** Subject-wide revocation markers removed, when that sweep is composed. */
  subjectRevocations?: number;
  /** Pending-disconnect retry counts, when the sweep is composed. */
  disconnects?: { pending: number; cleared: number; expired: number; failed: number };
}

export class RetentionService {
  constructor(private readonly options: {
    store: { purgeExpired(cutoffs: ReturnType<typeof retentionCutoffs>): Promise<{ snapshots: number; webhookEvents: number }> };
    /** Retries pending disconnects; handles its own failures and never throws. */
    sweepDisconnects?: () => Promise<{ pending: number; cleared: number; expired: number; failed: number }>;
    /** Removes subject-wide ("*") revocation markers written before the cutoff; returns the count. */
    sweepSubjectRevocations?: (before: Date) => Promise<number>;
    now?: () => Date;
  }) {}

  /** Every step runs even when an earlier one fails; the first failure is then rethrown. */
  async purge(): Promise<RetentionResult> {
    const now = (this.options.now ?? (() => new Date()))();
    let expired: { snapshots: number; webhookEvents: number } | undefined;
    let subjectRevocations: number | undefined;
    let failed = false;
    let failure: unknown;
    try {
      expired = await this.options.store.purgeExpired(retentionCutoffs(now));
    } catch (error) {
      failed = true;
      failure = error;
    }
    if (this.options.sweepSubjectRevocations) {
      try {
        subjectRevocations = await this.options.sweepSubjectRevocations(subjectRevocationCutoff(now));
      } catch (error) {
        if (!failed) { failed = true; failure = error; }
      }
    }
    const disconnects = await this.options.sweepDisconnects?.();
    if (failed || !expired) throw failure;
    return {
      ...expired,
      ...(subjectRevocations !== undefined ? { subjectRevocations } : {}),
      ...(disconnects ? { disconnects } : {}),
    };
  }
}
