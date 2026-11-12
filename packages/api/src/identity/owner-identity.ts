import { PERSONAL_CREDENTIALS, type SnapTradeCredentials } from "../snaptrade/gateway.js";

/** The one authenticated subject of a self-hosted instance. */
export const OWNER_SUBJECT = "owner";

/** The slice of the Prisma client the owner row needs. */
export interface OwnerPrismaPort {
  appUser: {
    upsert(input: {
      where: { authSubject: string };
      create: { authSubject: string };
      update: Record<string, never>;
      select: { id: true };
    }): Promise<{ id: string }>;
  };
}

/**
 * One owner per instance. The owner's own SnapTrade Personal key identifies the user at SnapTrade, so there is no
 * per-user identity to register, store or decrypt: the owner subject maps to PERSONAL_CREDENTIALS and nothing else does.
 */
export class OwnerIdentity {
  constructor(private readonly options: { prisma: OwnerPrismaPort }) {}

  /** Creates the owner's AppUser row if it is missing and returns its id. Safe to call on every start. */
  async ensureOwner(): Promise<string> {
    const row = await this.options.prisma.appUser.upsert({
      where: { authSubject: OWNER_SUBJECT },
      create: { authSubject: OWNER_SUBJECT },
      update: {},
      select: { id: true },
    });
    return row.id;
  }

  async getExisting(authSubject: string): Promise<SnapTradeCredentials | null> {
    return authSubject === OWNER_SUBJECT ? PERSONAL_CREDENTIALS : null;
  }

  async getOrCreate(authSubject: string): Promise<SnapTradeCredentials> {
    if (authSubject !== OWNER_SUBJECT) throw new Error("unknown_subject");
    return PERSONAL_CREDENTIALS;
  }

  /** A key switch never happens on a self-hosted instance, so no relink is ever pending. */
  async relinkRequired(_authSubject: string): Promise<boolean> {
    return false;
  }
}
