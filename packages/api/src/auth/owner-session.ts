import { createHmac, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export const SESSION_COOKIE = "vl_session";
/** Authorized party of the browser dashboard, as opposed to an MCP host. */
export const DASHBOARD_PARTY = "vestlens-dashboard";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SLIDE_WRITE_INTERVAL_MS = 60 * 60 * 1000;

type SessionDb = Pick<PrismaClient, "ownerSession">;

/**
 * Server-side owner sessions. The cookie carries a random token; the database holds only its HMAC-SHA256
 * (hex) under the instance's SESSION_SECRET, so a database copy alone can't be replayed as a login.
 * Expiry slides to now + 30 days on use, written at most once an hour.
 */
export class OwnerSessionStore {
  private readonly prisma: SessionDb;
  private readonly secret: string;
  private readonly now: () => Date;

  constructor(o: { prisma: SessionDb; secret: string; now?: () => Date }) {
    this.prisma = o.prisma;
    this.secret = o.secret;
    this.now = o.now ?? (() => new Date());
  }

  private idFor(token: string): string {
    return createHmac("sha256", this.secret).update(token).digest("hex");
  }

  async create(): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.prisma.ownerSession.deleteMany({ where: { expiresAt: { lte: now } } });
    await this.prisma.ownerSession.create({ data: { id: this.idFor(token), lastSeenAt: now, expiresAt } });
    return { token, expiresAt };
  }

  async resolve(token: string): Promise<boolean> {
    if (typeof token !== "string" || token.length === 0 || token.length > 256) return false;
    const id = this.idFor(token);
    const row = await this.prisma.ownerSession.findUnique({ where: { id } });
    if (!row) return false;
    const now = this.now();
    if (row.expiresAt.getTime() <= now.getTime()) {
      await this.prisma.ownerSession.deleteMany({ where: { id } });
      return false;
    }
    if (now.getTime() - row.lastSeenAt.getTime() >= SLIDE_WRITE_INTERVAL_MS) {
      // updateMany: a concurrent revoke leaves count 0, which is fine.
      await this.prisma.ownerSession.updateMany({
        where: { id },
        data: { lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) },
      });
    }
    return true;
  }

  async revoke(token: string): Promise<void> {
    if (typeof token !== "string" || token.length === 0 || token.length > 256) return;
    await this.prisma.ownerSession.deleteMany({ where: { id: this.idFor(token) } });
  }
}
