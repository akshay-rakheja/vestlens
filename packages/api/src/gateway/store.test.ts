import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryGatewayStore,
  PrismaGatewayStore,
  type AuthorizationCode,
  type DcrClient,
  type GatewayStore,
  type PendingAuthorization,
  type RefreshToken,
} from "./store.js";

const T0 = new Date("2026-10-20T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

const client = (over: Partial<DcrClient> = {}): DcrClient => ({
  clientId: "client-a",
  clientSecretHash: null,
  redirectUris: ["https://host.example/cb"],
  clientName: "Host",
  tokenEndpointAuthMethod: "none",
  grantTypes: ["authorization_code", "refresh_token"],
  createdAt: T0,
  lastUsedAt: null,
  ...over,
});

const pending = (over: Partial<PendingAuthorization> = {}): PendingAuthorization => ({
  id: "p1",
  clientKey: "client-a",
  redirectUri: "https://host.example/cb",
  state: "s",
  codeChallenge: "c".repeat(43),
  scope: "portfolio:read",
  resource: "https://api.example/mcp",
  upstreamState: "us1",
  upstreamNonce: "un1",
  upstreamVerifier: "uv1",
  subject: null,
  consentCsrf: null,
  browserBindingHash: "b".repeat(64),
  upstreamClaimedAt: null,
  expiresAt: at(600_000),
  ...over,
});

const code = (over: Partial<AuthorizationCode> = {}): AuthorizationCode => ({
  codeHash: "h".repeat(64),
  clientKey: "client-a",
  redirectUri: "https://host.example/cb",
  codeChallenge: "c".repeat(43),
  subject: "subject|u1",
  scope: "portfolio:read",
  resource: "https://api.example/mcp",
  expiresAt: at(60_000),
  usedAt: null,
  familyId: "fam1",
  ...over,
});

const refresh = (over: Partial<RefreshToken> = {}): RefreshToken => ({
  tokenHash: "r".repeat(64),
  familyId: "fam1",
  clientKey: "client-a",
  subject: "subject|u1",
  scope: "portfolio:read",
  resource: "https://api.example/mcp",
  parentHash: null,
  expiresAt: at(1000),
  familyExpiresAt: at(2000),
  rotatedAt: null,
  revokedAt: null,
  ...over,
});

export function gatewayStoreContract(name: string, make: () => GatewayStore) {
  describe(`GatewayStore contract: ${name}`, () => {
    let store: GatewayStore;
    beforeEach(() => {
      store = make();
    });

    it("stores, reads, touches and counts clients", async () => {
      await store.createClient(client());
      expect(await store.countClients()).toBe(1);
      expect(await store.getClient("client-a")).toEqual(client());
      expect(await store.getClient("missing")).toBeNull();
      await store.touchClient("client-a", at(5));
      expect((await store.getClient("client-a"))?.lastUsedAt).toEqual(at(5));
    });

    it("deleteClientsUnusedSince deletes only stale clients", async () => {
      await store.createClient(client({ clientId: "old-never-used", createdAt: at(-10_000) }));
      await store.createClient(client({ clientId: "old-used-long-ago", createdAt: at(-20_000), lastUsedAt: at(-9_000) }));
      await store.createClient(client({ clientId: "old-but-used-recently", createdAt: at(-20_000), lastUsedAt: at(100) }));
      await store.createClient(client({ clientId: "new", createdAt: at(50) }));
      const removed = await store.deleteClientsUnusedSince(at(0));
      expect(removed).toBe(2);
      expect(await store.getClient("old-never-used")).toBeNull();
      expect(await store.getClient("old-used-long-ago")).toBeNull();
      expect(await store.getClient("old-but-used-recently")).not.toBeNull();
      expect(await store.getClient("new")).not.toBeNull();
    });

    it("deleteNeverUsedClientsCreatedBefore deletes only never-used clients created before the cutoff", async () => {
      await store.createClient(client({ clientId: "old-never-used", createdAt: at(-10) }));
      await store.createClient(client({ clientId: "old-used", createdAt: at(-10), lastUsedAt: at(-5) }));
      await store.createClient(client({ clientId: "new-never-used", createdAt: at(0) }));
      expect(await store.deleteNeverUsedClientsCreatedBefore(at(0))).toBe(1);
      expect(await store.getClient("old-never-used")).toBeNull();
      expect(await store.getClient("old-used")).not.toBeNull();
      expect(await store.getClient("new-never-used")).not.toBeNull();
    });

    it("deleteExpiredCimd deletes entries past staleUntil", async () => {
      const v = { document: { client_id: "u" }, fetchedAt: T0, freshUntil: at(1), staleUntil: at(2) };
      await store.putCimd("https://c.example/old", v);
      await store.putCimd("https://c.example/live", { ...v, staleUntil: at(3) });
      expect(await store.deleteExpiredCimd(at(2))).toBe(1);
      expect(await store.getCimd("https://c.example/old")).toBeNull();
      expect(await store.getCimd("https://c.example/live")).not.toBeNull();
    });

    it("deleteExpiredCodes deletes codes that expired before the cutoff", async () => {
      await store.createCode(code({ codeHash: "old", expiresAt: at(-1) }));
      await store.createCode(code({ codeHash: "edge", expiresAt: at(0) }));
      expect(await store.deleteExpiredCodes(at(0))).toBe(1);
      expect(await store.getCode("old")).toBeNull();
      expect(await store.getCode("edge")).not.toBeNull();
    });

    it("deleteExpiredRefreshTokens deletes rows past their family's absolute expiry", async () => {
      await store.createRefresh(refresh({ tokenHash: "old", familyExpiresAt: at(0) }));
      await store.createRefresh(refresh({ tokenHash: "live", familyExpiresAt: at(1) }));
      expect(await store.deleteExpiredRefreshTokens(at(0))).toBe(1);
      expect(await store.getRefresh("old")).toBeNull();
      expect(await store.getRefresh("live")).not.toBeNull();
    });

    it("deleteRevokedFamilyMarkersBefore deletes only older markers", async () => {
      await store.revokeFamily("old", at(-1));
      await store.revokeFamily("recent", at(0));
      expect(await store.deleteRevokedFamilyMarkersBefore(at(0))).toBe(1);
      // The old family's marker is gone: a new row in it is live; the recent one stays revoked.
      expect(await store.createRefresh(refresh({ tokenHash: "a", familyId: "old" }))).toBe("ok");
      expect(await store.createRefresh(refresh({ tokenHash: "b", familyId: "recent" }))).toBe("revoked");
    });

    it("caches CIMD documents and overwrites on put", async () => {
      const v = { document: { client_id: "u" }, fetchedAt: T0, freshUntil: at(1), staleUntil: at(2) };
      expect(await store.getCimd("https://c.example/m")).toBeNull();
      await store.putCimd("https://c.example/m", v);
      expect(await store.getCimd("https://c.example/m")).toEqual(v);
      await store.putCimd("https://c.example/m", { ...v, document: { client_id: "v2" } });
      expect((await store.getCimd("https://c.example/m"))?.document).toEqual({ client_id: "v2" });
    });

    it("manages pending authorizations", async () => {
      await store.createPending(pending());
      expect(await store.getPending("p1")).toEqual(pending());
      expect((await store.getPendingByUpstreamState("us1"))?.id).toBe("p1");
      expect(await store.getPendingByUpstreamState("nope")).toBeNull();
      await store.updatePending("p1", { subject: "subject|u1", consentCsrf: "tok" });
      expect(await store.getPending("p1")).toEqual(pending({ subject: "subject|u1", consentCsrf: "tok" }));
      expect(await store.deletePending("p1")).toBe(true);
      expect(await store.getPending("p1")).toBeNull();
      expect(await store.deletePending("p1")).toBe(false);
    });

    it("claimPendingByUpstreamState claims once", async () => {
      await store.createPending(pending());
      const first = await store.claimPendingByUpstreamState("us1", at(5));
      expect(first).toEqual(pending({ upstreamClaimedAt: at(5) }));
      expect(await store.claimPendingByUpstreamState("us1", at(6))).toBeNull();
      expect(await store.claimPendingByUpstreamState("nope", at(6))).toBeNull();
      expect((await store.getPending("p1"))?.upstreamClaimedAt).toEqual(at(5));
    });

    it("bindPendingSubject binds once and reports whether a row changed", async () => {
      await store.createPending(pending());
      expect(await store.bindPendingSubject("p1", "subject|u1")).toBe(true);
      expect(await store.bindPendingSubject("p1", "subject|u2")).toBe(false);
      expect((await store.getPending("p1"))?.subject).toBe("subject|u1");
      expect(await store.bindPendingSubject("missing", "subject|u1")).toBe(false);
    });

    it("deleteExpiredPendings and countLivePendings", async () => {
      await store.createPending(pending({ id: "old", upstreamState: "a", expiresAt: at(-1) }));
      await store.createPending(pending({ id: "edge", upstreamState: "b", expiresAt: at(0) }));
      await store.createPending(pending({ id: "live", upstreamState: "c", expiresAt: at(1) }));
      expect(await store.countLivePendings(at(0))).toBe(1);
      expect(await store.deleteExpiredPendings(at(0))).toBe(2);
      expect(await store.getPending("old")).toBeNull();
      expect(await store.getPending("edge")).toBeNull();
      expect(await store.getPending("live")).not.toBeNull();
    });

    it("consumeCode is single use", async () => {
      await store.createCode(code());
      const first = await store.consumeCode("h".repeat(64), at(10));
      expect(first).not.toBeNull();
      expect(first).not.toHaveProperty("used");
      expect((first as AuthorizationCode).usedAt).toEqual(at(10));
      expect((first as AuthorizationCode).familyId).toBe("fam1");
      expect(await store.consumeCode("h".repeat(64), at(20))).toEqual({
        used: true,
        familyId: "fam1",
        clientKey: "client-a",
        expiresAt: at(60_000),
      });
      expect(await store.consumeCode("x".repeat(64), at(20))).toBeNull();
    });

    it("rotateRefresh rotates once and reports reuse", async () => {
      await store.createRefresh(refresh());
      const first = await store.rotateRefresh("r".repeat(64), at(10));
      expect(first).not.toBeNull();
      expect(first).not.toHaveProperty("reused");
      expect((first as RefreshToken).rotatedAt).toEqual(at(10));
      expect(await store.rotateRefresh("r".repeat(64), at(20))).toEqual({ reused: true, familyId: "fam1" });
      expect(await store.rotateRefresh("z".repeat(64), at(20))).toBeNull();
    });

    it("getRefresh reads a token without rotating it", async () => {
      await store.createRefresh(refresh());
      expect(await store.getRefresh("r".repeat(64))).toEqual(refresh());
      expect(await store.getRefresh("z".repeat(64))).toBeNull();
      expect(await store.rotateRefresh("r".repeat(64), at(10))).not.toBeNull();
    });

    it("revokeFamily blocks future rotation of every token in the family", async () => {
      await store.createRefresh(refresh({ tokenHash: "a".repeat(64) }));
      await store.createRefresh(refresh({ tokenHash: "b".repeat(64), parentHash: "a".repeat(64) }));
      await store.createRefresh(refresh({ tokenHash: "o".repeat(64), familyId: "other" }));
      await store.revokeFamily("fam1", at(5));
      expect(await store.rotateRefresh("a".repeat(64), at(10))).toBeNull();
      expect(await store.rotateRefresh("b".repeat(64), at(10))).toBeNull();
      expect(await store.rotateRefresh("o".repeat(64), at(10))).not.toBeNull();
    });

    it("createRefresh reports live, and a family revoked before the insert stays revoked", async () => {
      expect(await store.createRefresh(refresh({ tokenHash: "a".repeat(64) }))).toBe("ok");
      await store.revokeFamily("late", at(5));
      expect(await store.createRefresh(refresh({ tokenHash: "b".repeat(64), familyId: "late" }))).toBe("revoked");
      expect((await store.getRefresh("b".repeat(64)))?.revokedAt).toEqual(at(5));
      expect(await store.rotateRefresh("b".repeat(64), at(10))).toBeNull();
    });

    it("revokeSubject marks the subject's families, including code-only families", async () => {
      await store.createCode(code({ codeHash: "k".repeat(64), familyId: "code-fam" }));
      await store.createRefresh(refresh({ tokenHash: "a".repeat(64), familyId: "f1" }));
      expect(await store.revokeSubject("subject|u1", at(5))).toBe(1);
      expect(await store.createRefresh(refresh({ tokenHash: "b".repeat(64), familyId: "code-fam" }))).toBe("revoked");
      expect(await store.createRefresh(refresh({ tokenHash: "c".repeat(64), familyId: "f1" }))).toBe("revoked");
      expect(await store.createRefresh(refresh({ tokenHash: "d".repeat(64), familyId: "f9", subject: "subject|u2" }))).toBe("ok");
    });

    it("revokeSubject revokes only that subject's live tokens and counts them", async () => {
      await store.createRefresh(refresh({ tokenHash: "a".repeat(64), familyId: "f1" }));
      await store.createRefresh(refresh({ tokenHash: "b".repeat(64), familyId: "f2" }));
      await store.createRefresh(refresh({ tokenHash: "c".repeat(64), familyId: "f3", subject: "subject|u2" }));
      expect(await store.revokeSubject("subject|u1", at(5))).toBe(2);
      expect(await store.revokeSubject("subject|u1", at(6))).toBe(0);
      expect(await store.rotateRefresh("a".repeat(64), at(10))).toBeNull();
      expect(await store.rotateRefresh("c".repeat(64), at(10))).not.toBeNull();
    });

    it("consent is unique per (subject, clientKey)", async () => {
      expect(await store.hasConsent("subject|u1", "client-a")).toBe(false);
      await store.putConsent("subject|u1", "client-a", "portfolio:read", T0);
      await store.putConsent("subject|u1", "client-a", "portfolio:read", at(1));
      expect(await store.hasConsent("subject|u1", "client-a")).toBe(true);
      expect(await store.hasConsent("subject|u1", "client-b")).toBe(false);
      expect(await store.hasConsent("subject|u2", "client-a")).toBe(false);
      await store.putConsent("subject|u1", "client-b", "portfolio:read", T0);
      expect(await store.deleteConsents("subject|u1")).toBe(2);
      expect(await store.hasConsent("subject|u1", "client-a")).toBe(false);
    });

    it("listConsents returns only the subject's grants with their latest grantedAt", async () => {
      await store.putConsent("subject|u1", "client-a", "portfolio:read", T0);
      await store.putConsent("subject|u1", "client-a", "portfolio:read", at(7));
      await store.putConsent("subject|u1", "https://claude.ai/oauth/meta", "portfolio:read", at(3));
      await store.putConsent("subject|u2", "client-z", "portfolio:read", T0);
      const rows = await store.listConsents("subject|u1");
      expect(rows.sort((a, b) => a.clientKey.localeCompare(b.clientKey))).toEqual([
        { clientKey: "client-a", grantedAt: at(7) },
        { clientKey: "https://claude.ai/oauth/meta", grantedAt: at(3) },
      ]);
      expect(await store.listConsents("subject|nobody")).toEqual([]);
    });

    it("isFamilyRevoked reflects family markers", async () => {
      expect(await store.isFamilyRevoked("fam1")).toBe(false);
      await store.revokeFamily("fam1", at(1));
      expect(await store.isFamilyRevoked("fam1")).toBe(true);
    });

    it("revokeClient is a no-op returning false without the caller's own consent", async () => {
      await store.putConsent("subject|u2", "client-a", "portfolio:read", T0);
      await store.createRefresh(refresh({ subject: "subject|u2" }));
      const clock = () => at(5);
      expect(await store.revokeClient("subject|u1", "client-a", clock)).toBe(false);
      expect(await store.revokeClient("subject|u1", "never-registered", clock)).toBe(false);
      expect(await store.accessRevokedAt("subject|u1", "client-a")).toBeNull();
      expect(await store.accessRevokedAt("subject|u2", "client-a")).toBeNull();
      expect(await store.hasConsent("subject|u2", "client-a")).toBe(true);
      expect(await store.rotateRefresh("r".repeat(64), at(6))).not.toBeNull();
    });

    it("revokeClient revokes one client's families and consent, then writes the marker last", async () => {
      await store.putConsent("subject|u1", "client-a", "portfolio:read", T0);
      await store.putConsent("subject|u1", "client-b", "portfolio:read", T0);
      await store.createRefresh(refresh({ tokenHash: "a".repeat(64), familyId: "fa" }));
      await store.createCode(code({ codeHash: "k".repeat(64), familyId: "fa-code" }));
      await store.createRefresh(refresh({ tokenHash: "b".repeat(64), familyId: "fb", clientKey: "client-b" }));
      let tick = 0;
      const clock = () => at(10 + tick++);
      expect(await store.revokeClient("subject|u1", "client-a", clock)).toBe(true);
      const familiesAt = (await store.getRefresh("a".repeat(64)))!.revokedAt!;
      const marker = (await store.accessRevokedAt("subject|u1", "client-a"))!;
      expect(marker.getTime()).toBeGreaterThan(familiesAt.getTime());
      expect(await store.isFamilyRevoked("fa")).toBe(true);
      expect(await store.isFamilyRevoked("fa-code")).toBe(true);
      expect(await store.isFamilyRevoked("fb")).toBe(false);
      expect(await store.hasConsent("subject|u1", "client-a")).toBe(false);
      expect(await store.hasConsent("subject|u1", "client-b")).toBe(true);
      expect(await store.accessRevokedAt("subject|u1", "client-b")).toBeNull();
      expect(await store.rotateRefresh("b".repeat(64), at(20))).not.toBeNull();
    });

    it("revokeAllForSubject marks every family and writes one subject-wide marker", async () => {
      await store.createRefresh(refresh({ tokenHash: "a".repeat(64), familyId: "fa" }));
      await store.createRefresh(refresh({ tokenHash: "b".repeat(64), familyId: "fb", clientKey: "client-b" }));
      await store.createRefresh(refresh({ tokenHash: "c".repeat(64), familyId: "fc", subject: "subject|u2" }));
      let tick = 0;
      const clock = () => at(10 + tick++);
      expect(await store.revokeAllForSubject("subject|u1", clock)).toBe(2);
      const marker = (await store.accessRevokedAt("subject|u1", "any-client"))!;
      expect(marker.getTime()).toBeGreaterThan((await store.getRefresh("a".repeat(64)))!.revokedAt!.getTime());
      expect(await store.accessRevokedAt("subject|u1", "client-b")).toEqual(marker);
      expect(await store.accessRevokedAt("subject|u2", "client-a")).toBeNull();
      expect(await store.isFamilyRevoked("fb")).toBe(true);
      expect(await store.isFamilyRevoked("fc")).toBe(false);
    });

    it("accessRevokedAt returns the later of the client and subject-wide markers", async () => {
      await store.putConsent("subject|u1", "client-a", "portfolio:read", T0);
      await store.revokeAllForSubject("subject|u1", () => at(5));
      await store.revokeClient("subject|u1", "client-a", () => at(9));
      expect(await store.accessRevokedAt("subject|u1", "client-a")).toEqual(at(9));
      expect(await store.accessRevokedAt("subject|u1", "client-b")).toEqual(at(5));
      await store.revokeAllForSubject("subject|u1", () => at(12));
      expect(await store.accessRevokedAt("subject|u1", "client-a")).toEqual(at(12));
    });

    it("deleteClientRevocationsBefore deletes only older markers", async () => {
      await store.putConsent("subject|u1", "client-a", "portfolio:read", T0);
      await store.revokeClient("subject|u1", "client-a", () => at(1));
      await store.revokeAllForSubject("subject|u2", () => at(10));
      expect(await store.deleteClientRevocationsBefore(at(5))).toBe(1);
      expect(await store.accessRevokedAt("subject|u1", "client-a")).toBeNull();
      expect(await store.accessRevokedAt("subject|u2", "x")).toEqual(at(10));
    });
  });
}

gatewayStoreContract("MemoryGatewayStore", () => new MemoryGatewayStore());

describe("McpOAuthClientRevocation schema and migration", () => {
  const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");

  it("holds subject, clientKey and revokedAt, unique per (subject, clientKey)", () => {
    const model = /model McpOAuthClientRevocation \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
    const fields = [...model.matchAll(/^\s+(\w+)\s+\S/gm)].map((m) => m[1]);
    expect(fields).toEqual(["id", "subject", "clientKey", "revokedAt"]);
    expect(model).toContain("@@unique([subject, clientKey])");
    expect(model).toContain("@@index([revokedAt])");
  });

  it("the baseline creates the table and its unique index", () => {
    const sql = readFileSync(new URL("../../prisma/migrations/0001_baseline/migration.sql", import.meta.url), "utf8");
    expect(sql).toContain('CREATE TABLE "McpOAuthClientRevocation"');
    expect(sql).toContain('CREATE UNIQUE INDEX "McpOAuthClientRevocation_subject_clientKey_key"');
  });
});

describe("PrismaGatewayStore revocation queries (mocked client)", () => {
  function fakeDb() {
    const calls: string[] = [];
    const op = (name: string, result: unknown = { count: 0 }) => vi.fn(async (..._args: unknown[]) => { calls.push(name); return result; });
    const db = {
      mcpOAuthConsent: { findUnique: op("consent.findUnique", { id: "x" }), deleteMany: op("consent.deleteMany", { count: 1 }) },
      mcpOAuthRefreshToken: {
        findMany: op("refresh.findMany", [{ familyId: "f1" }]),
        updateMany: op("refresh.updateMany", { count: 1 }),
      },
      mcpOAuthCode: { findMany: op("code.findMany", [{ familyId: "f2" }]) },
      mcpOAuthRevokedFamily: { createMany: op("families.createMany") },
      mcpOAuthClientRevocation: {
        upsert: op("marker.upsert"),
        findMany: op("marker.findMany", [{ revokedAt: new Date(5) }, { revokedAt: new Date(9) }]),
      },
    };
    return { db, calls, store: new PrismaGatewayStore(db as never) };
  }

  it("revokeClient marks families, then writes the marker with a later clock reading, then deletes the consent", async () => {
    const { db, calls, store } = fakeDb();
    let tick = 0;
    expect(await store.revokeClient("subject|u1", "client-a", () => new Date(1000 + tick++))).toBe(true);
    expect(calls.slice(-4)).toEqual(["families.createMany", "refresh.updateMany", "marker.upsert", "consent.deleteMany"]);
    expect(db.mcpOAuthRefreshToken.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { subject: "subject|u1", clientKey: "client-a" } }));
    expect(db.mcpOAuthRevokedFamily.createMany).toHaveBeenCalledWith({
      data: [{ familyId: "f1", revokedAt: new Date(1000) }, { familyId: "f2", revokedAt: new Date(1000) }],
      skipDuplicates: true,
    });
    expect(db.mcpOAuthClientRevocation.upsert).toHaveBeenCalledWith({
      where: { subject_clientKey: { subject: "subject|u1", clientKey: "client-a" } },
      create: { subject: "subject|u1", clientKey: "client-a", revokedAt: new Date(1001) },
      update: { revokedAt: new Date(1001) },
    });
    expect(db.mcpOAuthConsent.deleteMany).toHaveBeenCalledWith({ where: { subject: "subject|u1", clientKey: "client-a" } });
  });

  it("revokeClient writes nothing without the caller's consent, and never accepts the '*' key", async () => {
    const { db, calls, store } = fakeDb();
    db.mcpOAuthConsent.findUnique.mockResolvedValueOnce(null as never);
    expect(await store.revokeClient("subject|u1", "client-a", () => new Date(1))).toBe(false);
    expect(await store.revokeClient("subject|u1", "*", () => new Date(1))).toBe(false);
    expect(db.mcpOAuthConsent.findUnique).toHaveBeenCalledTimes(1); // the "*" key never reaches the database
    expect(calls).toEqual([]); // nothing else was read or written
  });

  it("accessRevokedAt reads the client and subject-wide markers in one query and returns the later", async () => {
    const { db, store } = fakeDb();
    expect(await store.accessRevokedAt("subject|u1", "client-a")).toEqual(new Date(9));
    expect(db.mcpOAuthClientRevocation.findMany).toHaveBeenCalledTimes(1);
    expect(db.mcpOAuthClientRevocation.findMany).toHaveBeenCalledWith({
      where: { subject: "subject|u1", clientKey: { in: ["client-a", "*"] } },
      select: { revokedAt: true },
    });
  });
});
