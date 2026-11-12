import { roomAlertNote } from "../mcp/room-tools.js";
import { loadRoomInput, torontoToday, type RoomLoaderDeps } from "./room-loader.js";
import { computeTfsaRoom, type RoomResult } from "./tfsa-room.js";

/**
 * The TFSA over-limit alert (spec §6.5, §9a item 10): one row per auth subject per Toronto year. A known result
 * over the limit raises it (or reopens the year's row), a different excess updates it in place, and room back to
 * $0 or more, or a result with inputs missing, clears it. A missing result never raises one. Last year's row stays
 * as history, is closed by the first evaluation of the new year, and is never this year's open alert. The row keeps the room text's formatted conversion note, so a
 * reader (get_portfolio_alerts) states the alert from the row alone, with no evaluation or write. Nothing here logs.
 */

export type RoomAlertOutcome = "raised" | "updated" | "cleared" | "none";

type DecimalLike = number | string | { toString(): string };

export interface RoomAlertRow {
  subject: string;
  year: number;
  excessCad: DecimalLike;
  estimated: boolean;
  note: string | null;
  raisedAt: Date;
  updatedAt: Date;
  clearedAt: Date | null;
}

type SubjectYear = { subject_year: { subject: string; year: number } };

export interface RoomAlertPrismaPort {
  contributionRoomAlert: {
    findUnique(input: { where: SubjectYear }): Promise<RoomAlertRow | null>;
    create(input: { data: { subject: string; year: number; excessCad: string; estimated: boolean; note: string | null; raisedAt: Date; updatedAt: Date; clearedAt: null } }): Promise<unknown>;
    update(input: { where: SubjectYear; data: { excessCad?: string; estimated?: boolean; note?: string | null; raisedAt?: Date; updatedAt?: Date; clearedAt?: Date | null } }): Promise<unknown>;
    findMany(input: { where: { subject: string }; orderBy: { year: "asc" } }): Promise<RoomAlertRow[]>;
  };
}

const toCents = (v: DecimalLike) => Math.round(Number(typeof v === "number" ? v : v.toString()) * 100);
const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";

/** Missing only because some TFSA's activity is out of date. */
const isStaleOnly = (result: RoomResult) =>
  result.status === "missing" && result.missing.length > 0 && result.missing.every((m) => m.kind === "stale_activity");

export class RoomAlertService {
  private readonly now: () => Date;

  constructor(private readonly o: { prisma: RoomAlertPrismaPort; now?: () => Date }) {
    this.now = o.now ?? (() => new Date());
  }

  /**
   * `ignoringFreshness` is the same inputs computed with the freshness gate off. When `result` is missing only because
   * activity is out of date, the open alert is checked against it: still over keeps the alert (lowered if the excess
   * dropped, never raised or increased while stale); not over, or another input missing, clears it.
   */
  async evaluateRoomAlert(subject: string, result: RoomResult, now: Date = this.now(), options: { ignoringFreshness?: RoomResult } = {}): Promise<RoomAlertOutcome> {
    await this.closeEarlierYears(subject, result.year, now);
    if (isStaleOnly(result) && options.ignoringFreshness) return this.holdWhileStale(subject, options.ignoringFreshness, now);
    return this.evaluate(subject, result, now, false);
  }

  private async holdWhileStale(subject: string, asIfFresh: RoomResult, now: Date): Promise<RoomAlertOutcome> {
    const table = this.o.prisma.contributionRoomAlert;
    const where = { subject_year: { subject, year: asIfFresh.year } };
    const row = await table.findUnique({ where });
    if (!row || row.clearedAt !== null) return "none";
    const overCents = asIfFresh.status === "known" ? Math.round(Math.max(0, asIfFresh.overLimitCad) * 100) : 0;
    if (overCents <= 0) {
      await table.update({ where, data: { clearedAt: now, updatedAt: now } });
      return "cleared";
    }
    if (overCents >= toCents(row.excessCad) || asIfFresh.status !== "known") return "none";
    const shown = { estimated: asIfFresh.estimated, note: roomAlertNote(asIfFresh) };
    await table.update({ where, data: { excessCad: (overCents / 100).toFixed(2), ...shown, updatedAt: now } });
    return "updated";
  }

  /**
   * Rollover (1 January Toronto): an earlier year's alert still open is closed by the first evaluation of the new year,
   * so it ends as history rather than staying open for ever. The outcome counts are about this year's row only.
   */
  private async closeEarlierYears(subject: string, year: number, now: Date): Promise<void> {
    const table = this.o.prisma.contributionRoomAlert;
    const rows = await table.findMany({ where: { subject }, orderBy: { year: "asc" } });
    for (const row of rows) {
      if (row.year < year && row.clearedAt === null) {
        await table.update({ where: { subject_year: { subject, year: row.year } }, data: { clearedAt: now, updatedAt: now } });
      }
    }
  }

  private async evaluate(subject: string, result: RoomResult, now: Date, retried: boolean): Promise<RoomAlertOutcome> {
    const table = this.o.prisma.contributionRoomAlert;
    const where = { subject_year: { subject, year: result.year } };
    const row = await table.findUnique({ where });
    if (result.status !== "known" || Math.round(Math.max(0, result.overLimitCad) * 100) <= 0) {
      if (!row || row.clearedAt !== null) return "none";
      await table.update({ where, data: { clearedAt: now, updatedAt: now } });
      return "cleared";
    }
    const overCents = Math.round(result.overLimitCad * 100);
    const excessCad = (overCents / 100).toFixed(2);
    const shown = { estimated: result.estimated, note: roomAlertNote(result) };
    if (!row) {
      try {
        await table.create({ data: { subject, year: result.year, excessCad, ...shown, raisedAt: now, updatedAt: now, clearedAt: null } });
        return "raised";
      } catch (error) {
        // A concurrent evaluation created the year's row first: evaluate again against it.
        if (retried || !isUniqueViolation(error)) throw error;
        return this.evaluate(subject, result, now, true);
      }
    }
    if (row.clearedAt !== null) {
      await table.update({ where, data: { excessCad, ...shown, raisedAt: now, updatedAt: now, clearedAt: null } });
      return "raised";
    }
    if (toCents(row.excessCad) === overCents && row.estimated === shown.estimated && (row.note ?? null) === shown.note) return "none";
    await table.update({ where, data: { excessCad, ...shown, updatedAt: now } });
    return "updated";
  }

  /** This Toronto year's open alert for the subject, or null. Read-only. */
  async openRoomAlert(subject: string, now: Date = this.now()): Promise<{ year: number; excessCad: number; estimated: boolean; note: string | null } | null> {
    const year = Number(torontoToday(now).slice(0, 4));
    const row = await this.o.prisma.contributionRoomAlert.findUnique({ where: { subject_year: { subject, year } } });
    return row && row.clearedAt === null
      ? { year: row.year, excessCad: toCents(row.excessCad) / 100, estimated: row.estimated, note: row.note ?? null }
      : null;
  }

  /** Every row for the account export, oldest year first, without the subject. */
  async listForExport(subject: string): Promise<Array<Omit<RoomAlertRow, "subject" | "excessCad"> & { excessCad: string }>> {
    const rows = await this.o.prisma.contributionRoomAlert.findMany({ where: { subject }, orderBy: { year: "asc" } });
    return rows.map((r) => ({
      year: r.year, excessCad: (toCents(r.excessCad) / 100).toFixed(2), estimated: r.estimated, note: r.note ?? null,
      raisedAt: r.raisedAt, updatedAt: r.updatedAt, clearedAt: r.clearedAt,
    }));
  }
}

export interface RoomAlertDeps {
  loader: RoomLoaderDeps;
  alerts: RoomAlertService;
  now?: () => Date;
}

/** Computes the subject's room from stored inputs (no brokerage read) and brings their alert in line with it. */
export async function reevaluateRoomAlert(deps: RoomAlertDeps, subject: string): Promise<{ outcome: RoomAlertOutcome; result: RoomResult }> {
  const now = (deps.now ?? (() => new Date()))();
  const input = await loadRoomInput(deps.loader, subject, torontoToday(now), now);
  const result = computeTfsaRoom(input);
  const ignoringFreshness = isStaleOnly(result) ? computeTfsaRoom(input, { ignoreFreshness: true }) : undefined;
  return { outcome: await deps.alerts.evaluateRoomAlert(subject, result, now, ignoringFreshness ? { ignoringFreshness } : {}), result };
}
