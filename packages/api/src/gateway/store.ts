import type { Prisma, PrismaClient } from "@prisma/client";

export interface DcrClient {
  clientId: string;
  clientSecretHash: string | null;
  redirectUris: string[];
  clientName: string | null;
  tokenEndpointAuthMethod: "none" | "client_secret_post";
  /** Registered grant types (subset of authorization_code, refresh_token). */
  grantTypes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface PendingAuthorization {
  id: string;
  clientKey: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  /** The scope string this authorization will grant (scope.ts GRANTED_SCOPES for new ones). */
  scope: string;
  resource: string;
  upstreamState: string;
  upstreamNonce: string;
  upstreamVerifier: string;
  subject: string | null;
  consentCsrf: string | null;
  /** SHA-256 (hex) of the `__Host-gw_pa` cookie set by /authorize. */
  browserBindingHash: string;
  /** Set once when the upstream callback claims this pending's upstream state. */
  upstreamClaimedAt: Date | null;
  expiresAt: Date;
}

export interface AuthorizationCode {
  codeHash: string;
  clientKey: string;
  redirectUri: string;
  codeChallenge: string;
  subject: string;
  scope: string;
  resource: string;
  expiresAt: Date;
  usedAt: Date | null;
  familyId: string;
}

export interface RefreshToken {
  tokenHash: string;
  familyId: string;
  clientKey: string;
  subject: string;
  scope: string;
  resource: string;
  parentHash: string | null;
  expiresAt: Date;
  familyExpiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

export interface CimdCacheEntry {
  document: unknown;
  fetchedAt: Date;
  freshUntil: Date;
  staleUntil: Date;
}

/** clientKey of the subject-wide revocation marker (never a DCR id or CIMD URL). */
export const ALL_CLIENTS = "*";

export interface ConsentGrant {
  clientKey: string;
  grantedAt: Date;
}

export type CodeUsed = { used: true; familyId: string; clientKey: string; expiresAt: Date };
export type RefreshReused = { reused: true; familyId: string };

export interface GatewayStore {
  createClient(c: DcrClient): Promise<void>;
  getClient(id: string): Promise<DcrClient | null>;
  touchClient(id: string, at: Date): Promise<void>;
  deleteClientsUnusedSince(before: Date): Promise<number>;
  /** Deletes clients never used (lastUsedAt null) and created before `before`. */
  deleteNeverUsedClientsCreatedBefore(before: Date): Promise<number>;
  countClients(): Promise<number>;
  getCimd(url: string): Promise<CimdCacheEntry | null>;
  putCimd(url: string, v: CimdCacheEntry): Promise<void>;
  /** Deletes CIMD entries with staleUntil <= before. */
  deleteExpiredCimd(before: Date): Promise<number>;
  createPending(p: PendingAuthorization): Promise<void>;
  getPendingByUpstreamState(s: string): Promise<PendingAuthorization | null>;
  getPending(id: string): Promise<PendingAuthorization | null>;
  updatePending(id: string, patch: Partial<PendingAuthorization>): Promise<void>;
  /** Atomic: sets upstreamClaimedAt where it is null. Returns the claimed row, or null if unknown or already claimed. */
  claimPendingByUpstreamState(s: string, at: Date): Promise<PendingAuthorization | null>;
  /** Atomic: sets subject where it is null. True when a row changed. */
  bindPendingSubject(id: string, subject: string): Promise<boolean>;
  /** Atomic: true when this call deleted the row (single winner for concurrent callers). */
  deletePending(id: string): Promise<boolean>;
  /** Deletes pendings with expiresAt <= before. Returns the count. */
  deleteExpiredPendings(before: Date): Promise<number>;
  /** Counts pendings with expiresAt > at. */
  countLivePendings(at: Date): Promise<number>;
  createCode(c: AuthorizationCode): Promise<void>;
  /** Read-only lookup; never consumes. */
  getCode(hash: string): Promise<AuthorizationCode | null>;
  /** Deletes codes with expiresAt < before. */
  deleteExpiredCodes(before: Date): Promise<number>;
  /** Atomic: sets usedAt. Returns `{ used, familyId }` if already used, null if unknown. */
  consumeCode(hash: string, at: Date): Promise<AuthorizationCode | CodeUsed | null>;
  /**
   * Inserts, then checks the revoked-family marker. "revoked" means the family
   * was revoked (possibly concurrently): the new row is revoked too and must
   * not be handed out.
   */
  createRefresh(t: RefreshToken): Promise<"ok" | "revoked">;
  /** Read-only lookup; never rotates. */
  getRefresh(hash: string): Promise<RefreshToken | null>;
  /** Atomic: sets rotatedAt. `{ reused, familyId }` if already rotated; null if unknown, revoked or in a marked family. */
  rotateRefresh(hash: string, at: Date): Promise<RefreshToken | RefreshReused | null>;
  /** Deletes refresh rows with familyExpiresAt <= before (no row in such a family can be used again). */
  deleteExpiredRefreshTokens(before: Date): Promise<number>;
  /** Writes the family marker first, then revokes existing rows. */
  revokeFamily(familyId: string, at: Date): Promise<void>;
  /** Deletes revoked-family markers with revokedAt < before. */
  deleteRevokedFamilyMarkersBefore(before: Date): Promise<number>;
  /**
   * Takes the raw subject string. Marks every family of the subject (refresh
   * and code families), then revokes rows. Returns the number of tokens newly revoked.
   */
  revokeSubject(subject: string, at: Date): Promise<number>;
  hasConsent(subject: string, clientKey: string): Promise<boolean>;
  putConsent(subject: string, clientKey: string, scope: string, at: Date): Promise<void>;
  deleteConsents(subject: string): Promise<number>;
  /** The subject's own grants (one per client). */
  listConsents(subject: string): Promise<ConsentGrant[]>;
  /** True when the family carries a revoked-family marker. */
  isFamilyRevoked(familyId: string): Promise<boolean>;
  /**
   * Revokes one client for one subject. Without the subject's consent for that
   * client it writes nothing and returns false. Otherwise, in order: marks the
   * client's refresh and code families and revokes its refresh rows, then
   * writes the access-token marker with a fresh `now()` (so any token minted
   * before a family check that missed the marks is still older than the
   * marker), then deletes the consent (last, so a retry after a partial
   * failure still finds the app).
   */
  revokeClient(subject: string, clientKey: string, now: () => Date): Promise<boolean>;
  /**
   * Revokes every client of the subject (account deletion): marks all of the
   * subject's families, then writes the subject-wide marker (clientKey "*")
   * with a fresh `now()`. Consents are left to the caller. Returns the number of
   * refresh tokens newly revoked.
   */
  revokeAllForSubject(subject: string, now: () => Date): Promise<number>;
  /** The later of the (subject, clientKey) and (subject, "*") markers, or null. One indexed lookup. */
  accessRevokedAt(subject: string, clientKey: string): Promise<Date | null>;
  /** Deletes access-token markers with revokedAt < before. */
  deleteClientRevocationsBefore(before: Date): Promise<number>;
}

// ---------------------------------------------------------------- Prisma

export type GatewayPrisma = Pick<
  PrismaClient,
  | "mcpOAuthClient"
  | "mcpOAuthCimdCache"
  | "mcpOAuthPending"
  | "mcpOAuthCode"
  | "mcpOAuthRefreshToken"
  | "mcpOAuthConsent"
  | "mcpOAuthRevokedFamily"
  | "mcpOAuthClientRevocation"
>;

const json = (v: unknown) => v as Prisma.InputJsonValue;

export class PrismaGatewayStore implements GatewayStore {
  constructor(private readonly db: GatewayPrisma) {}

  async createClient(c: DcrClient): Promise<void> {
    await this.db.mcpOAuthClient.create({
      data: { ...c, redirectUris: json(c.redirectUris), grantTypes: json(c.grantTypes) },
    });
  }

  async getClient(id: string): Promise<DcrClient | null> {
    const row = await this.db.mcpOAuthClient.findUnique({ where: { clientId: id } });
    if (!row) return null;
    return {
      ...row,
      redirectUris: row.redirectUris as string[],
      grantTypes: row.grantTypes as string[],
      tokenEndpointAuthMethod: row.tokenEndpointAuthMethod as DcrClient["tokenEndpointAuthMethod"],
    };
  }

  async touchClient(id: string, at: Date): Promise<void> {
    await this.db.mcpOAuthClient.updateMany({ where: { clientId: id }, data: { lastUsedAt: at } });
  }

  async deleteClientsUnusedSince(before: Date): Promise<number> {
    const res = await this.db.mcpOAuthClient.deleteMany({
      where: { OR: [{ lastUsedAt: { lt: before } }, { lastUsedAt: null, createdAt: { lt: before } }] },
    });
    return res.count;
  }

  async deleteNeverUsedClientsCreatedBefore(before: Date): Promise<number> {
    const res = await this.db.mcpOAuthClient.deleteMany({ where: { lastUsedAt: null, createdAt: { lt: before } } });
    return res.count;
  }

  countClients(): Promise<number> {
    return this.db.mcpOAuthClient.count();
  }

  async getCimd(url: string): Promise<CimdCacheEntry | null> {
    const row = await this.db.mcpOAuthCimdCache.findUnique({ where: { url } });
    if (!row) return null;
    return { document: row.document, fetchedAt: row.fetchedAt, freshUntil: row.freshUntil, staleUntil: row.staleUntil };
  }

  async putCimd(url: string, v: CimdCacheEntry): Promise<void> {
    const data = { document: json(v.document), fetchedAt: v.fetchedAt, freshUntil: v.freshUntil, staleUntil: v.staleUntil };
    await this.db.mcpOAuthCimdCache.upsert({ where: { url }, create: { url, ...data }, update: data });
  }

  async deleteExpiredCimd(before: Date): Promise<number> {
    const res = await this.db.mcpOAuthCimdCache.deleteMany({ where: { staleUntil: { lte: before } } });
    return res.count;
  }

  async createPending(p: PendingAuthorization): Promise<void> {
    await this.db.mcpOAuthPending.create({ data: p });
  }

  async getPendingByUpstreamState(s: string): Promise<PendingAuthorization | null> {
    return (await this.db.mcpOAuthPending.findUnique({ where: { upstreamState: s } })) as PendingAuthorization | null;
  }

  async getPending(id: string): Promise<PendingAuthorization | null> {
    return (await this.db.mcpOAuthPending.findUnique({ where: { id } })) as PendingAuthorization | null;
  }

  async updatePending(id: string, patch: Partial<PendingAuthorization>): Promise<void> {
    await this.db.mcpOAuthPending.updateMany({ where: { id }, data: patch });
  }

  async claimPendingByUpstreamState(s: string, at: Date): Promise<PendingAuthorization | null> {
    const res = await this.db.mcpOAuthPending.updateMany({
      where: { upstreamState: s, upstreamClaimedAt: null },
      data: { upstreamClaimedAt: at },
    });
    if (res.count !== 1) return null;
    return (await this.db.mcpOAuthPending.findUnique({ where: { upstreamState: s } })) as PendingAuthorization | null;
  }

  async bindPendingSubject(id: string, subject: string): Promise<boolean> {
    const res = await this.db.mcpOAuthPending.updateMany({ where: { id, subject: null }, data: { subject } });
    return res.count === 1;
  }

  async deletePending(id: string): Promise<boolean> {
    const res = await this.db.mcpOAuthPending.deleteMany({ where: { id } });
    return res.count === 1;
  }

  async deleteExpiredPendings(before: Date): Promise<number> {
    const res = await this.db.mcpOAuthPending.deleteMany({ where: { expiresAt: { lte: before } } });
    return res.count;
  }

  countLivePendings(at: Date): Promise<number> {
    return this.db.mcpOAuthPending.count({ where: { expiresAt: { gt: at } } });
  }

  async createCode(c: AuthorizationCode): Promise<void> {
    await this.db.mcpOAuthCode.create({ data: c });
  }

  getCode(hash: string): Promise<AuthorizationCode | null> {
    return this.db.mcpOAuthCode.findUnique({ where: { codeHash: hash } });
  }

  async deleteExpiredCodes(before: Date): Promise<number> {
    const res = await this.db.mcpOAuthCode.deleteMany({ where: { expiresAt: { lt: before } } });
    return res.count;
  }

  async consumeCode(hash: string, at: Date): Promise<AuthorizationCode | CodeUsed | null> {
    const res = await this.db.mcpOAuthCode.updateMany({
      where: { codeHash: hash, usedAt: null },
      data: { usedAt: at },
    });
    const row = await this.db.mcpOAuthCode.findUnique({ where: { codeHash: hash } });
    if (!row) return null;
    return res.count === 1
      ? row
      : { used: true, familyId: row.familyId, clientKey: row.clientKey, expiresAt: row.expiresAt };
  }

  async createRefresh(t: RefreshToken): Promise<"ok" | "revoked"> {
    await this.db.mcpOAuthRefreshToken.create({ data: t });
    // Insert-then-check pairs with revokeFamily's mark-then-update: one side always sees the other.
    const marker = await this.db.mcpOAuthRevokedFamily.findUnique({ where: { familyId: t.familyId } });
    if (!marker) return "ok";
    await this.db.mcpOAuthRefreshToken.updateMany({
      where: { tokenHash: t.tokenHash, revokedAt: null },
      data: { revokedAt: marker.revokedAt },
    });
    return "revoked";
  }

  getRefresh(hash: string): Promise<RefreshToken | null> {
    return this.db.mcpOAuthRefreshToken.findUnique({ where: { tokenHash: hash } });
  }

  async rotateRefresh(hash: string, at: Date): Promise<RefreshToken | RefreshReused | null> {
    const res = await this.db.mcpOAuthRefreshToken.updateMany({
      where: { tokenHash: hash, rotatedAt: null, revokedAt: null },
      data: { rotatedAt: at },
    });
    const row = await this.db.mcpOAuthRefreshToken.findUnique({ where: { tokenHash: hash } });
    if (!row) return null;
    if (await this.db.mcpOAuthRevokedFamily.findUnique({ where: { familyId: row.familyId } })) return null;
    if (res.count === 1) return row;
    if (row.revokedAt) return null;
    return { reused: true, familyId: row.familyId };
  }

  async deleteExpiredRefreshTokens(before: Date): Promise<number> {
    const res = await this.db.mcpOAuthRefreshToken.deleteMany({ where: { familyExpiresAt: { lte: before } } });
    return res.count;
  }

  async revokeFamily(familyId: string, at: Date): Promise<void> {
    await this.db.mcpOAuthRevokedFamily.upsert({ where: { familyId }, create: { familyId, revokedAt: at }, update: {} });
    await this.db.mcpOAuthRefreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: at } });
  }

  async deleteRevokedFamilyMarkersBefore(before: Date): Promise<number> {
    const res = await this.db.mcpOAuthRevokedFamily.deleteMany({ where: { revokedAt: { lt: before } } });
    return res.count;
  }

  async revokeSubject(subject: string, at: Date): Promise<number> {
    const [tokens, codes] = await Promise.all([
      this.db.mcpOAuthRefreshToken.findMany({ where: { subject }, select: { familyId: true }, distinct: ["familyId"] }),
      this.db.mcpOAuthCode.findMany({ where: { subject }, select: { familyId: true }, distinct: ["familyId"] }),
    ]);
    const families = [...new Set([...tokens, ...codes].map((r) => r.familyId))];
    if (families.length > 0) {
      await this.db.mcpOAuthRevokedFamily.createMany({
        data: families.map((familyId) => ({ familyId, revokedAt: at })),
        skipDuplicates: true,
      });
    }
    const res = await this.db.mcpOAuthRefreshToken.updateMany({
      where: { subject, revokedAt: null },
      data: { revokedAt: at },
    });
    return res.count;
  }

  async hasConsent(subject: string, clientKey: string): Promise<boolean> {
    const row = await this.db.mcpOAuthConsent.findUnique({ where: { subject_clientKey: { subject, clientKey } } });
    return row !== null;
  }

  async putConsent(subject: string, clientKey: string, scope: string, at: Date): Promise<void> {
    await this.db.mcpOAuthConsent.upsert({
      where: { subject_clientKey: { subject, clientKey } },
      create: { subject, clientKey, scope, grantedAt: at },
      update: { scope, grantedAt: at },
    });
  }

  async deleteConsents(subject: string): Promise<number> {
    const res = await this.db.mcpOAuthConsent.deleteMany({ where: { subject } });
    return res.count;
  }

  async listConsents(subject: string): Promise<ConsentGrant[]> {
    return this.db.mcpOAuthConsent.findMany({
      where: { subject },
      select: { clientKey: true, grantedAt: true },
      orderBy: { grantedAt: "desc" },
    });
  }

  async isFamilyRevoked(familyId: string): Promise<boolean> {
    return (await this.db.mcpOAuthRevokedFamily.findUnique({ where: { familyId } })) !== null;
  }

  async revokeClient(subject: string, clientKey: string, now: () => Date): Promise<boolean> {
    if (clientKey === ALL_CLIENTS || !(await this.hasConsent(subject, clientKey))) return false;
    const at = now();
    const [tokens, codes] = await Promise.all([
      this.db.mcpOAuthRefreshToken.findMany({ where: { subject, clientKey }, select: { familyId: true }, distinct: ["familyId"] }),
      this.db.mcpOAuthCode.findMany({ where: { subject, clientKey }, select: { familyId: true }, distinct: ["familyId"] }),
    ]);
    const families = [...new Set([...tokens, ...codes].map((r) => r.familyId))];
    if (families.length > 0) {
      await this.db.mcpOAuthRevokedFamily.createMany({
        data: families.map((familyId) => ({ familyId, revokedAt: at })),
        skipDuplicates: true,
      });
    }
    await this.db.mcpOAuthRefreshToken.updateMany({ where: { subject, clientKey, revokedAt: null }, data: { revokedAt: at } });
    await this.putRevocation(subject, clientKey, now());
    await this.db.mcpOAuthConsent.deleteMany({ where: { subject, clientKey } });
    return true;
  }

  async revokeAllForSubject(subject: string, now: () => Date): Promise<number> {
    const n = await this.revokeSubject(subject, now());
    await this.putRevocation(subject, ALL_CLIENTS, now());
    return n;
  }

  private async putRevocation(subject: string, clientKey: string, revokedAt: Date): Promise<void> {
    await this.db.mcpOAuthClientRevocation.upsert({
      where: { subject_clientKey: { subject, clientKey } },
      create: { subject, clientKey, revokedAt },
      update: { revokedAt },
    });
  }

  async accessRevokedAt(subject: string, clientKey: string): Promise<Date | null> {
    const rows = await this.db.mcpOAuthClientRevocation.findMany({
      where: { subject, clientKey: { in: [clientKey, ALL_CLIENTS] } },
      select: { revokedAt: true },
    });
    return latest(rows.map((r) => r.revokedAt));
  }

  async deleteClientRevocationsBefore(before: Date): Promise<number> {
    const res = await this.db.mcpOAuthClientRevocation.deleteMany({ where: { revokedAt: { lt: before } } });
    return res.count;
  }
}

// ---------------------------------------------------------------- Memory fake

export class MemoryGatewayStore implements GatewayStore {
  private clients = new Map<string, DcrClient>();
  private cimd = new Map<string, CimdCacheEntry>();
  private pendings = new Map<string, PendingAuthorization>();
  private codes = new Map<string, AuthorizationCode>();
  private refreshes = new Map<string, RefreshToken>();
  private consents = new Map<string, { scope: string; grantedAt: Date }>();
  private revokedFamilies = new Map<string, Date>();
  private clientRevocations = new Map<string, Date>();

  private static consentKey = (subject: string, clientKey: string) => JSON.stringify([subject, clientKey]);

  async createClient(c: DcrClient): Promise<void> {
    if (this.clients.has(c.clientId)) throw new Error("duplicate client");
    this.clients.set(c.clientId, { ...c, redirectUris: [...c.redirectUris], grantTypes: [...c.grantTypes] });
  }
  async getClient(id: string): Promise<DcrClient | null> {
    const c = this.clients.get(id);
    return c ? { ...c, redirectUris: [...c.redirectUris], grantTypes: [...c.grantTypes] } : null;
  }
  async touchClient(id: string, at: Date): Promise<void> {
    const c = this.clients.get(id);
    if (c) c.lastUsedAt = at;
  }
  async deleteClientsUnusedSince(before: Date): Promise<number> {
    let n = 0;
    for (const [id, c] of this.clients) {
      if ((c.lastUsedAt ?? c.createdAt) < before) {
        this.clients.delete(id);
        n += 1;
      }
    }
    return n;
  }
  async deleteNeverUsedClientsCreatedBefore(before: Date): Promise<number> {
    let n = 0;
    for (const [id, c] of this.clients) {
      if (c.lastUsedAt === null && c.createdAt < before) {
        this.clients.delete(id);
        n += 1;
      }
    }
    return n;
  }
  async countClients(): Promise<number> {
    return this.clients.size;
  }
  async getCimd(url: string): Promise<CimdCacheEntry | null> {
    const v = this.cimd.get(url);
    return v ? { ...v } : null;
  }
  async putCimd(url: string, v: CimdCacheEntry): Promise<void> {
    this.cimd.set(url, { ...v });
  }
  async deleteExpiredCimd(before: Date): Promise<number> {
    return deleteWhere(this.cimd, (v) => v.staleUntil.getTime() <= before.getTime());
  }
  async createPending(p: PendingAuthorization): Promise<void> {
    if (this.pendings.has(p.id)) throw new Error("duplicate pending");
    this.pendings.set(p.id, { ...p });
  }
  async getPendingByUpstreamState(s: string): Promise<PendingAuthorization | null> {
    for (const p of this.pendings.values()) if (p.upstreamState === s) return { ...p };
    return null;
  }
  async getPending(id: string): Promise<PendingAuthorization | null> {
    const p = this.pendings.get(id);
    return p ? { ...p } : null;
  }
  async updatePending(id: string, patch: Partial<PendingAuthorization>): Promise<void> {
    const p = this.pendings.get(id);
    if (!p) return;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (p as unknown as Record<string, unknown>)[k] = v;
  }
  async claimPendingByUpstreamState(s: string, at: Date): Promise<PendingAuthorization | null> {
    for (const p of this.pendings.values()) {
      if (p.upstreamState !== s) continue;
      if (p.upstreamClaimedAt) return null;
      p.upstreamClaimedAt = at;
      return { ...p };
    }
    return null;
  }
  async bindPendingSubject(id: string, subject: string): Promise<boolean> {
    const p = this.pendings.get(id);
    if (!p || p.subject !== null) return false;
    p.subject = subject;
    return true;
  }
  async deletePending(id: string): Promise<boolean> {
    return this.pendings.delete(id);
  }
  async deleteExpiredPendings(before: Date): Promise<number> {
    let n = 0;
    for (const [id, p] of this.pendings) {
      if (p.expiresAt.getTime() <= before.getTime()) {
        this.pendings.delete(id);
        n += 1;
      }
    }
    return n;
  }
  async countLivePendings(at: Date): Promise<number> {
    let n = 0;
    for (const p of this.pendings.values()) if (p.expiresAt.getTime() > at.getTime()) n += 1;
    return n;
  }
  async createCode(c: AuthorizationCode): Promise<void> {
    if (this.codes.has(c.codeHash)) throw new Error("duplicate code");
    this.codes.set(c.codeHash, { ...c });
  }
  async getCode(hash: string): Promise<AuthorizationCode | null> {
    const c = this.codes.get(hash);
    return c ? { ...c } : null;
  }
  async deleteExpiredCodes(before: Date): Promise<number> {
    return deleteWhere(this.codes, (c) => c.expiresAt.getTime() < before.getTime());
  }
  async consumeCode(hash: string, at: Date): Promise<AuthorizationCode | CodeUsed | null> {
    const c = this.codes.get(hash);
    if (!c) return null;
    if (c.usedAt) return { used: true, familyId: c.familyId, clientKey: c.clientKey, expiresAt: c.expiresAt };
    c.usedAt = at;
    return { ...c };
  }
  async createRefresh(t: RefreshToken): Promise<"ok" | "revoked"> {
    if (this.refreshes.has(t.tokenHash)) throw new Error("duplicate refresh token");
    const row = { ...t };
    this.refreshes.set(t.tokenHash, row);
    const marked = this.revokedFamilies.get(t.familyId);
    if (!marked) return "ok";
    row.revokedAt ??= marked;
    return "revoked";
  }
  async getRefresh(hash: string): Promise<RefreshToken | null> {
    const t = this.refreshes.get(hash);
    return t ? { ...t } : null;
  }
  async rotateRefresh(hash: string, at: Date): Promise<RefreshToken | RefreshReused | null> {
    const t = this.refreshes.get(hash);
    if (!t) return null;
    if (t.revokedAt || this.revokedFamilies.has(t.familyId)) return null;
    if (t.rotatedAt) return { reused: true, familyId: t.familyId };
    t.rotatedAt = at;
    return { ...t };
  }
  async deleteExpiredRefreshTokens(before: Date): Promise<number> {
    return deleteWhere(this.refreshes, (t) => t.familyExpiresAt.getTime() <= before.getTime());
  }
  async deleteRevokedFamilyMarkersBefore(before: Date): Promise<number> {
    return deleteWhere(this.revokedFamilies, (at) => at.getTime() < before.getTime());
  }
  async revokeFamily(familyId: string, at: Date): Promise<void> {
    if (!this.revokedFamilies.has(familyId)) this.revokedFamilies.set(familyId, at);
    for (const t of this.refreshes.values()) if (t.familyId === familyId && !t.revokedAt) t.revokedAt = at;
  }
  async revokeSubject(subject: string, at: Date): Promise<number> {
    for (const r of [...this.refreshes.values(), ...this.codes.values()]) {
      if (r.subject === subject && !this.revokedFamilies.has(r.familyId)) this.revokedFamilies.set(r.familyId, at);
    }
    let n = 0;
    for (const t of this.refreshes.values()) {
      if (t.subject === subject && !t.revokedAt) {
        t.revokedAt = at;
        n += 1;
      }
    }
    return n;
  }
  async hasConsent(subject: string, clientKey: string): Promise<boolean> {
    return this.consents.has(MemoryGatewayStore.consentKey(subject, clientKey));
  }
  async putConsent(subject: string, clientKey: string, scope: string, at: Date): Promise<void> {
    this.consents.set(MemoryGatewayStore.consentKey(subject, clientKey), { scope, grantedAt: at });
  }
  async deleteConsents(subject: string): Promise<number> {
    let n = 0;
    for (const key of [...this.consents.keys()]) {
      if ((JSON.parse(key) as [string, string])[0] === subject) {
        this.consents.delete(key);
        n += 1;
      }
    }
    return n;
  }
  async listConsents(subject: string): Promise<ConsentGrant[]> {
    const out: ConsentGrant[] = [];
    for (const [key, v] of this.consents) {
      const [s, clientKey] = JSON.parse(key) as [string, string];
      if (s === subject) out.push({ clientKey, grantedAt: v.grantedAt });
    }
    return out.sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime());
  }
  async isFamilyRevoked(familyId: string): Promise<boolean> {
    return this.revokedFamilies.has(familyId);
  }
  async revokeClient(subject: string, clientKey: string, now: () => Date): Promise<boolean> {
    if (clientKey === ALL_CLIENTS || !(await this.hasConsent(subject, clientKey))) return false;
    const at = now();
    for (const r of [...this.refreshes.values(), ...this.codes.values()]) {
      if (r.subject === subject && r.clientKey === clientKey && !this.revokedFamilies.has(r.familyId)) {
        this.revokedFamilies.set(r.familyId, at);
      }
    }
    for (const t of this.refreshes.values()) {
      if (t.subject === subject && t.clientKey === clientKey && !t.revokedAt) t.revokedAt = at;
    }
    this.clientRevocations.set(MemoryGatewayStore.consentKey(subject, clientKey), now());
    this.consents.delete(MemoryGatewayStore.consentKey(subject, clientKey));
    return true;
  }
  async revokeAllForSubject(subject: string, now: () => Date): Promise<number> {
    const n = await this.revokeSubject(subject, now());
    this.clientRevocations.set(MemoryGatewayStore.consentKey(subject, ALL_CLIENTS), now());
    return n;
  }
  async accessRevokedAt(subject: string, clientKey: string): Promise<Date | null> {
    return latest(
      [clientKey, ALL_CLIENTS]
        .map((k) => this.clientRevocations.get(MemoryGatewayStore.consentKey(subject, k)))
        .filter((d): d is Date => d !== undefined),
    );
  }
  async deleteClientRevocationsBefore(before: Date): Promise<number> {
    return deleteWhere(this.clientRevocations, (at) => at.getTime() < before.getTime());
  }
}

function latest(dates: Date[]): Date | null {
  let out: Date | null = null;
  for (const d of dates) if (!out || d.getTime() > out.getTime()) out = d;
  return out ? new Date(out.getTime()) : null;
}

function deleteWhere<V>(map: Map<string, V>, pred: (v: V) => boolean): number {
  let n = 0;
  for (const [k, v] of map) {
    if (pred(v)) {
      map.delete(k);
      n += 1;
    }
  }
  return n;
}
