import { OWNER_SUBJECT } from "../identity/owner-identity.js";
import { buildPortfolioPresentation, type PortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import type { PortfolioQueryResult } from "../portfolio/portfolio-query-service.js";

export interface DailyValuePrismaPort {
  appUser: { findMany(input: { where: { authSubject: string }; select: { id: true; authSubject: true } }): Promise<Array<{ id: string; authSubject: string }>> };
  dailyValue: {
    findFirst(input: { where: { appUser: { authSubject: string }; currency: string }; orderBy: { date: "asc" }; select: { date: true } }): Promise<{ date: Date } | null>;
    upsert(input: { where: { appUserId_date_snapTradeAccountId_currency: { appUserId: string; date: Date; snapTradeAccountId: string; currency: string } }; create: { appUserId: string; date: Date; snapTradeAccountId: string; currency: string; value: number; source: string }; update: { value: number; source: string } }): Promise<unknown>;
    findMany(input: { where: { appUser: { authSubject: string }; date: { gte: Date } }; select: { date: true; snapTradeAccountId: true; currency: true; value: true; source: true } }): Promise<Array<{ date: Date; snapTradeAccountId: string; currency: string; value: unknown; source: string }>>;
  };
}

export interface DailyValueRow { date: string; accountId: string; currency: string; value: number; source: "reported" | "reconstructed" | "estimated" }

const torontoDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export class DailySnapshotService {
  private readonly now: () => Date;

  constructor(private readonly options: {
    prisma: DailyValuePrismaPort;
    portfolio: { getPortfolio(subject: string, options?: { refresh?: boolean }): Promise<PortfolioQueryResult> };
    now?: () => Date;
  }) {
    this.now = options.now ?? (() => new Date());
  }

  async captureAll(): Promise<{ users: number; rows: number; failures: number }> {
    const date = this.today();
    const linked = await this.options.prisma.appUser.findMany({ where: { authSubject: OWNER_SUBJECT }, select: { id: true, authSubject: true } });
    const users = linked;
    let failures = 0;
    let rows = 0;
    for (const user of users) {
      const result = await this.captureForDate(user, date);
      rows += result.rows;
      if (result.failed) failures += 1;
    }
    return { users: users.length, rows, failures };
  }

  /**
   * `keepAccounts` hands back the presentation accounts this capture read (also when stale or partial), so a
   * caller can derive news symbols without a second provider read. Absent when the read itself failed.
   */
  async captureFor(
    user: { id: string; authSubject: string },
    options: { keepAccounts?: boolean } = {},
  ): Promise<{ rows: number; failed: boolean; accounts?: PortfolioPresentation["accounts"] }> {
    return this.captureForDate(user, this.today(), options.keepAccounts === true);
  }

  private today(): Date {
    return new Date(`${torontoDate.format(this.now())}T00:00:00Z`);
  }

  private async captureForDate(
    user: { id: string; authSubject: string }, date: Date, keepAccounts = false,
  ): Promise<{ rows: number; failed: boolean; accounts?: PortfolioPresentation["accounts"] }> {
    let rows = 0;
    let kept: { accounts?: PortfolioPresentation["accounts"] } = {};
    try {
      const presentation = buildPortfolioPresentation(await this.options.portfolio.getPortfolio(user.authSubject, { refresh: true }));
      if (keepAccounts) kept = { accounts: presentation.accounts };
      // A stale (fallback) or partial read is not today's brokerage-reported value; store nothing.
      if (presentation.cache?.stale || presentation.errors.length > 0) return { rows, failed: true, ...kept };
      for (const account of presentation.accounts) {
        if (!account.classification.includedInPortfolioTotal || !account.value || !Number.isFinite(account.value.amount)) continue;
        const key = { appUserId: user.id, date, snapTradeAccountId: account.id, currency: account.value.currency };
        await this.options.prisma.dailyValue.upsert({
          where: { appUserId_date_snapTradeAccountId_currency: key },
          create: { ...key, value: account.value.amount, source: "reported" },
          update: { value: account.value.amount, source: "reported" },
        });
        rows += 1;
      }
      return { rows, failed: false, ...kept };
    } catch {
      return { rows, failed: true, ...kept };
    }
  }

  /** Earliest stored row date for one currency, or null. */
  async earliest(authSubject: string, currency: string): Promise<string | null> {
    const first = await this.options.prisma.dailyValue.findFirst({ where: { appUser: { authSubject }, currency }, orderBy: { date: "asc" }, select: { date: true } });
    return first ? first.date.toISOString().slice(0, 10) : null;
  }

  async rows(authSubject: string, from: string): Promise<DailyValueRow[]> {
    const found = await this.options.prisma.dailyValue.findMany({ where: { appUser: { authSubject }, date: { gte: new Date(`${from}T00:00:00Z`) } }, select: { date: true, snapTradeAccountId: true, currency: true, value: true, source: true } });
    const rows: DailyValueRow[] = [];
    for (const row of found) {
      if (row.source !== "reported" && row.source !== "reconstructed" && row.source !== "estimated") continue;
      rows.push({ date: row.date.toISOString().slice(0, 10), accountId: row.snapTradeAccountId, currency: row.currency, value: Number(row.value), source: row.source });
    }
    return rows;
  }
}
