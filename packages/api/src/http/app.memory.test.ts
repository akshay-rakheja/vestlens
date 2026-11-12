import { exportJWK, generateKeyPair, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { OWNER_SUBJECT } from "../identity/owner-identity.js";
import { GatewayTokenService } from "../gateway/tokens.js";
import { accountKey } from "../memory/keys.js";
import { MemoryService } from "../memory/memory-service.js";
import { reevaluateRoomAlert, RoomAlertService } from "../room/room-alerts.js";
import type { RoomPrismaPort } from "../room/room-loader.js";
import { loopbackRequest } from "../testing/loopback-request.js";
import { memoryOwnerSessions } from "../testing/owner-session-prisma.js";
import { sessionCookieFor } from "../testing/owner-session.js";
import { MemoryFactRepository } from "../testing/memory-fact-repository.js";
import { MemoryRoomAlertPrisma } from "../testing/memory-room-alert-prisma.js";
import { MemoryNudgePrisma } from "../testing/memory-nudge-prisma.js";
import { NudgeService } from "../nudges/nudge-service.js";
import { createPortfolioApi } from "./app.js";

// Synthetic identities, ids and amounts only.
const APP = "https://mcp.example.test";
const RESOURCE = "https://mcp.example.test/mcp";
// Every /api caller is the owner; OTHER is a second subject whose rows must stay invisible and untouched.
const ME = OWNER_SUBJECT;
const OTHER = "synthetic-memory-routes-other";
const TFSA_ID = "synthetic-acct-tfsa";
const NOW = new Date("2026-10-24T16:00:00Z");
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
const HOSTILE = "<b>x</b> [a](b) <img src=x onerror=alert(1)>";

let signingKey: JWK;
beforeAll(async () => {
  const es = await generateKeyPair("ES256", { extractable: true });
  signingKey = { ...(await exportJWK(es.privateKey)), kid: "gw1" };
});

const links = { accountsHoldingSecurity: async () => [], tfsaAccounts: async () => [TFSA_ID], accountIds: async () => [TFSA_ID], activityDedupeKeys: async () => [] };
function prismaPort(activities: Array<Record<string, unknown>>): RoomPrismaPort {
  return {
    brokerageAccount: {
      findMany: async () => [{
        snapTradeAccountId: TFSA_ID, displayName: null, institutionName: "Synthetic Broker", rawType: "TFSA", status: "OPEN",
        snapshots: [{ payload: { account: { type: "TFSA", metaType: null, unifiedType: null, status: "OPEN" }, positions: [] } }],
      }],
    },
    activity: { findMany: async () => activities as never },
    activitySyncState: { findMany: async () => [{ snapTradeAccountId: TFSA_ID, backfillCompletedAt: day("2026-02-01"), earliestTradeDate: day("2023-05-01"), lastSyncedAt: new Date("2026-10-24T08:00:00Z"), lastError: null, dirty: false }] },
  };
}
const contribution = (amount: number) =>
  ({ snapTradeAccountId: TFSA_ID, dedupeKey: "synthetic-dedupe-1", type: "CONTRIBUTION", amount, currency: "CAD", fxRate: null, tradeDate: day("2026-06-01") });
const node = { type: "tax_year" as const, key: "2026:tfsa" };

afterEach(() => vi.restoreAllMocks());

const NUDGE = { kind: "limit", target: "single-holding-syn", text: "SYN is 40% (est.) of your portfolio, over your 30% limit.", raisedAt: NOW };
async function build(o: { activities?: Array<Record<string, unknown>>; withMemory?: boolean; nudges?: { openNudges(s: string): Promise<unknown[]> } | NudgeService } = {}) {
  const repository = new MemoryFactRepository();
  const alertPrisma = new MemoryRoomAlertPrisma();
  const alerts = new RoomAlertService({ prisma: alertPrisma, now: () => NOW });
  const loader = { prisma: prismaPort(o.activities ?? []), memory: repository };
  const alertDeps = { loader, alerts, now: () => NOW };
  const service = new MemoryService({
    repository, links, now: () => NOW, log: () => {},
    onReservedChange: (subject) => reevaluateRoomAlert(alertDeps, subject),
  });
  const sessions = memoryOwnerSessions();
  const app = createPortfolioApi({
    sessions,
    portfolio: { getPortfolio: vi.fn(async () => ({ connectionRequired: false, generatedAt: NOW.toISOString(), accounts: [], errors: [] })) },
    history: { getAccountHistory: vi.fn(async () => ({})) },
    connections: { getConnections: vi.fn(async () => []), createConnectionPortal: vi.fn(async () => "https://x.invalid") },
    webhooks: { ingest: vi.fn(async () => ({ duplicate: false })) },
    appBaseUrl: APP, mcpResourceUrl: RESOURCE,
    ...(o.withMemory === false ? {} : {
      memory: { service, links },
      room: { loader, context: { repository, links, now: () => NOW }, now: () => NOW, alerts },
      nudges: o.nudges ?? { openNudges: async (s: string) => (s === ME ? [NUDGE] : []) },
    }),
  } as never);
  const req = await loopbackRequest(app);
  // The dashboard's browser headers: the owner session cookie and this app's own Origin (required on writes).
  const bearer = async () => ({ Cookie: await sessionCookieFor(sessions), Origin: APP });
  const remember = (subject: string, over: Record<string, unknown> = {}) => service.remember(subject, {
    node: { type: "security", key: "SYN" }, property: "security.reason", value: null, text: "For the dividend.", kind: "reason", provenance: "stated", source: "claude", ...over,
  } as never, NOW);
  return { req, bearer, service, repository, alertPrisma, alerts, remember };
}

describe("GET /api/memory", () => {
  it("returns the caller's current facts grouped by node type, as plain data, newest first, without subject", async () => {
    const { req, bearer, remember, service } = await build();
    await remember(ME, { text: HOSTILE });
    await service.remember(ME, { node: { type: "goal", key: "house" }, property: "goal.note", value: null, text: "Save for a house.", kind: "plan", provenance: "inferred", source: "chatgpt" }, new Date(NOW.getTime() + 1000));
    await remember(OTHER, { text: "Theirs." });
    const res = await req.get("/api/memory").set(await bearer()).expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.groups.map((g: { nodeType: string }) => g.nodeType)).toEqual(["goal", "security"]);
    const security = res.body.groups[1].facts[0];
    expect(security).toMatchObject({ nodeType: "security", nodeKey: "SYN", property: "security.reason", text: HOSTILE, provenance: "stated", source: "claude", kind: "reason" });
    expect(typeof security.id).toBe("string");
    expect(typeof security.recordedAt).toBe("string");
    expect(res.body.groups[0].facts[0]).toMatchObject({ provenance: "inferred", source: "chatgpt" });
    expect(JSON.stringify(res.body)).not.toContain(ME);
    expect(JSON.stringify(res.body)).not.toContain("Theirs.");
  });

  it("is empty for a new user", async () => {
    const { req, bearer } = await build();
    const res = await req.get("/api/memory").set(await bearer()).expect(200);
    expect(res.body).toEqual({ groups: [] });
  });

  it("is not mounted without memory", async () => {
    const { req, bearer } = await build({ withMemory: false });
    await req.get("/api/memory").set(await bearer()).expect(404);
  });
});

describe("dashboard-only auth on the memory and room routes", () => {
  const routes = [
    { method: "get", path: "/api/memory" },
    { method: "patch", path: "/api/memory/some-id", body: { text: "x" } },
    { method: "post", path: "/api/memory/some-id/promote" },
    { method: "delete", path: "/api/memory/some-id" },
    { method: "get", path: "/api/room/tfsa" },
    { method: "get", path: "/api/nudges" },
  ] as const;

  it("refuses a gateway-issued AI token on every route, even with the memory scope", async () => {
    const { req } = await build();
    const tokens = new GatewayTokenService({ issuer: APP, audience: RESOURCE, signingKey, now: () => NOW });
    const ai = (await tokens.issueAccess({ subject: ME, clientKey: "dcr-client-synthetic-0001", scope: "portfolio:read memory" })).token;
    for (const r of routes) {
      const res = await req[r.method](r.path).set("Authorization", `Bearer ${ai}`).send("body" in r ? r.body : undefined);
      expect([401, 403]).toContain(res.status);
      expect(res.body).not.toHaveProperty("groups");
    }
  });

  it("answers 401 without a session, and 403 for a write whose Origin is not this app's", async () => {
    const { req, bearer } = await build();
    for (const r of routes) {
      await req[r.method](r.path).expect(401);
      if (r.method === "get") continue;
      const cookie = (await bearer()).Cookie;
      const foreign = await req[r.method](r.path).set("Cookie", cookie).set("Origin", "https://evil.example").send("body" in r ? r.body : undefined);
      expect(foreign.status).toBe(403);
      expect(foreign.body).toEqual({ error: "bad_origin" });
    }
  });
});

describe("PATCH /api/memory/:id", () => {
  it("saves a superseding stated fact sourced to the dashboard", async () => {
    const { req, bearer, remember, service } = await build();
    const { fact } = await remember(ME, { provenance: "inferred" });
    const res = await req.patch(`/api/memory/${fact.id}`).set(await bearer()).send({ text: HOSTILE }).expect(200);
    expect(res.body).toMatchObject({ text: HOSTILE, provenance: "stated", source: "dashboard", nodeKey: "SYN" });
    expect(res.body.id).not.toBe(fact.id);
    expect((await service.listCurrent(ME)).map((f) => f.text)).toEqual([HOSTILE]);
  });

  it("returns 400 with a fixed message for an invalid change, an empty body and unknown fields; nothing is saved", async () => {
    const { req, bearer, remember, service } = await build();
    const cra = await service.remember(ME, { node, property: "tax_year.cra_room_jan1", value: { amountCad: 7000 }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    const plain = await remember(ME);
    for (const [id, body] of [[cra.fact.id, { value: { amountCad: -5, secret: "SECRET-VALUE" } }], [plain.fact.id, { text: "" }], [plain.fact.id, {}], [plain.fact.id, { provenance: "inferred" }]] as const) {
      const res = await req.patch(`/api/memory/${id}`).set(await bearer()).send(body).expect(400);
      expect(res.body).toEqual({ error: "invalid_memory_edit", message: "That change could not be saved." });
    }
    expect((await service.listCurrent(ME)).map((f) => f.id).sort()).toEqual([cra.fact.id, plain.fact.id].sort());
  });

  it("answers 404 for an unknown entry and another subject's entry", async () => {
    const { req, bearer, remember, service } = await build();
    const theirs = await remember(OTHER, { text: "Theirs." });
    await req.patch("/api/memory/no-such-id").set(await bearer()).send({ text: "x" }).expect(404);
    const res = await req.patch(`/api/memory/${theirs.fact.id}`).set(await bearer()).send({ text: "x" }).expect(404);
    expect(res.body).toEqual({ error: "not_found" });
    expect((await service.listCurrent(OTHER)).map((f) => f.text)).toEqual(["Theirs."]);
  });

  it("editing the reserved CRA room fact re-evaluates the alert through the same hook", async () => {
    const { req, bearer, service, alerts } = await build({ activities: [contribution(6000)] });
    await service.remember(ME, { node, property: "tax_year.account_set", value: { connected: [accountKey(TFSA_ID)], outside: [], confirmedAt: "2026-02-01T15:00:00.000Z" }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    const cra = await service.remember(ME, { node, property: "tax_year.cra_room_jan1", value: { amountCad: 7000 }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    expect(await alerts.openRoomAlert(ME, NOW)).toBeNull();
    const edit = await req.patch(`/api/memory/${cra.fact.id}`).set(await bearer()).send({ value: { amountCad: 5000 } }).expect(200);
    expect(await alerts.openRoomAlert(ME, NOW)).toMatchObject({ excessCad: 1000 });
    await req.patch(`/api/memory/${edit.body.id}`).set(await bearer()).send({ value: { amountCad: 9000 } }).expect(200);
    expect(await alerts.openRoomAlert(ME, NOW)).toBeNull();
  });
});

describe("PATCH /api/memory/:id on typed plan entries", () => {
  const TYPED = [
    { node: { type: "security", key: "SYN" }, property: "security.thesis", value: { reasons: "Synthetic.", timeFrame: null }, kind: "reason", text: "Thesis on SYN: Synthetic." },
    { node: { type: "rule", key: "single-holding-syn" }, property: "rule.concentration_limit", value: { kind: "single_holding", target: "SYN", maxPct: 10 }, kind: "plan", text: "Limit: no more than 10% in SYN." },
    { node: { type: "goal", key: "house" }, property: "goal.savings_target", value: { name: "House", targetCad: 5000, targetDate: "2028-01-01", accounts: [accountKey(TFSA_ID)] }, kind: "plan", text: "Goal: House, $5,000 by 2028-01-01." },
  ];
  it("refuses text and value edits with a fixed message pointing to the Plans page, changing nothing", async () => {
    const { req, bearer, service } = await build();
    for (const t of TYPED) {
      const { fact } = await service.remember(ME, { ...t, provenance: "stated", source: "claude" } as never, NOW);
      for (const body of [{ text: "Changed." }, { value: t.value }, { text: "x", value: t.value }]) {
        const res = await req.patch(`/api/memory/${fact.id}`).set(await bearer()).send(body).expect(400);
        expect(res.body).toEqual({ error: "use_plans_page", message: "Edit theses, limits and goals on the Plans page." });
      }
      expect((await service.listCurrent(ME)).find((f) => f.id === fact.id)?.text).toBe(t.text);
    }
  });
});

describe("POST /api/memory/:id/promote and DELETE /api/memory/:id", () => {
  it("promotes an inferred fact to stated; refuses a stated one with the fixed message", async () => {
    const { req, bearer, remember } = await build();
    const inferred = await remember(ME, { provenance: "inferred" });
    const res = await req.post(`/api/memory/${inferred.fact.id}/promote`).set(await bearer()).expect(200);
    expect(res.body).toMatchObject({ provenance: "stated", source: "dashboard" });
    const again = await req.post(`/api/memory/${res.body.id}/promote`).set(await bearer()).expect(400);
    expect(again.body).toEqual({ error: "invalid_memory_edit", message: "That change could not be saved." });
    await req.post("/api/memory/no-such-id/promote").set(await bearer()).expect(404);
  });

  it("deleting the current entry removes every earlier version: not in recall with history, not in the export", async () => {
    const { req, bearer, remember, service } = await build();
    await remember(ME, { text: "First wording." });
    const second = await service.edit(ME, (await service.listCurrent(ME))[0]!.id, { text: "Second wording." });
    await remember(ME, { text: "Another topic.", node: { type: "security", key: "ABC" } });
    await req.delete(`/api/memory/${second.id}`).set(await bearer()).expect(204);
    const history = await service.recall(ME, { includeHistory: true });
    expect(history.map((f) => f.text)).toEqual(["Another topic."]);
    expect((await service.listForExport(ME)).map((f) => f.text)).toEqual(["Another topic."]);
  });

  it("deletes one entry (204), and a reserved delete re-evaluates the alert; another subject's is 404 and untouched", async () => {
    const { req, bearer, remember, service, alerts } = await build({ activities: [contribution(6000)] });
    await service.remember(ME, { node, property: "tax_year.account_set", value: { connected: [accountKey(TFSA_ID)], outside: [], confirmedAt: "2026-02-01T15:00:00.000Z" }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    const cra = await service.remember(ME, { node, property: "tax_year.cra_room_jan1", value: { amountCad: 5000 }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    expect(await alerts.openRoomAlert(ME, NOW)).toMatchObject({ excessCad: 1000 });
    await req.delete(`/api/memory/${cra.fact.id}`).set(await bearer()).expect(204);
    expect(await alerts.openRoomAlert(ME, NOW)).toBeNull();
    const theirs = await remember(OTHER, { text: "Theirs." });
    await req.delete(`/api/memory/${theirs.fact.id}`).set(await bearer()).expect(404);
    expect((await service.listCurrent(OTHER)).map((f) => f.text)).toEqual(["Theirs."]);
    await req.delete(`/api/memory/${cra.fact.id}`).set(await bearer()).expect(404);
  });
});

describe("DELETE /api/memory/:id on the FHSA room", () => {
  it("deletes a stated tax_year.fhsa_room fact (204), and it is gone from recall and the export", async () => {
    const { req, bearer, service } = await build();
    const fhsa = await service.remember(ME, { node: { type: "tax_year", key: "2026:fhsa" }, property: "tax_year.fhsa_room", value: { amountCad: 8000 }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    expect((await service.listForExport(ME)).map((f) => f.property)).toEqual(["tax_year.fhsa_room"]);
    await req.delete(`/api/memory/${fhsa.fact.id}`).set(await bearer()).expect(204);
    expect(await service.listCurrent(ME)).toEqual([]);
    expect(await service.listForExport(ME)).toEqual([]);
  });
});

describe("GET /api/room/tfsa", () => {

  it("returns what is missing, with a null alert", async () => {
    const { req, bearer } = await build();
    const res = await req.get("/api/room/tfsa").set(await bearer()).expect(200);
    expect(res.body).toMatchObject({ status: "missing", year: 2026, alert: null });
    expect(res.body.missing.map((m: { kind: string }) => m.kind)).toContain("cra_room");
  });

  it("returns the number, and the stored open alert with its note verbatim", async () => {
    const { req, bearer, service, alertPrisma } = await build({ activities: [contribution(6000)] });
    await service.remember(ME, { node, property: "tax_year.account_set", value: { connected: [accountKey(TFSA_ID)], outside: [], confirmedAt: "2026-02-01T15:00:00.000Z" }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    await service.remember(ME, { node, property: "tax_year.cra_room_jan1", value: { amountCad: 7000 }, text: "Synthetic.", kind: "fact", provenance: "stated" }, NOW);
    const known = await req.get("/api/room/tfsa").set(await bearer()).expect(200);
    expect(known.body).toMatchObject({ status: "known", roomLeftCad: 1000, alert: null });
    alertPrisma.rows.push({ subject: ME, year: 2026, excessCad: "400.00", estimated: true, note: "(est.; includes US$4,000 converted at the Bank of Canada rate of 2026-06-01)", raisedAt: NOW, updatedAt: NOW, clearedAt: null });
    const over = await req.get("/api/room/tfsa").set(await bearer()).expect(200);
    expect(over.body.alert).toEqual({ year: 2026, excessCad: 400, estimated: true, note: "(est.; includes US$4,000 converted at the Bank of Canada rate of 2026-06-01)" });
  });
});

describe("GET /api/nudges", () => {

  it("returns the caller's open nudges as stored, no-store, with no subject", async () => {
    const { req, bearer } = await build();
    const res = await req.get("/api/nudges").set(await bearer()).expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ nudges: [{ ...NUDGE, raisedAt: NOW.toISOString() }] });
    expect(JSON.stringify(res.body)).not.toContain(ME);
  });

  it("is not mounted without memory", async () => {
    const { req, bearer } = await build({ withMemory: false });
    await req.get("/api/nudges").set(await bearer()).expect(404);
  });

  it("a read failure is a plain 503 with a code-only log", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    const { req, bearer } = await build({ nudges: { openNudges: async () => { throw new Error(`boom ${ME}`); } } });
    const res = await req.get("/api/nudges").set(await bearer()).expect(503);
    expect(res.body).toEqual({ error: "nudges_unavailable" });
    expect(lines.join("\n")).not.toContain(ME);
    expect(lines.join("\n")).not.toContain("boom");
  });
});

describe("logging", () => {
  it("carries counts and constant codes only, never entry text, ids, subjects or amounts", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    const { req, bearer, remember } = await build({ activities: [contribution(6000)] });
    const { fact } = await remember(ME, { text: "SECRET-TEXT-123", provenance: "inferred" });
    await req.get("/api/memory").set(await bearer()).expect(200);
    await req.post(`/api/memory/${fact.id}/promote`).set(await bearer()).expect(200);
    await req.patch(`/api/memory/${fact.id}`).set(await bearer()).send({ text: "SECRET-TEXT-456" });
    await req.get("/api/room/tfsa").set(await bearer()).expect(200);
    const all = lines.join("\n");
    expect(all).toContain("memory_dashboard");
    for (const secret of ["SECRET-TEXT", ME, fact.id, TFSA_ID, "6000"]) expect(all).not.toContain(secret);
  });
});

describe("DELETE /api/memory/:id on a thesis or a limit (final fix 5)", () => {
  const nudgeRow = (subject: string, kind: "thesis_condition" | "limit", target: string, conditionId: string) => ({
    subject, kind, target, conditionId, basis: "b", text: "Synthetic nudge.", raisedAt: NOW, updatedAt: NOW, clearedAt: null as Date | null,
  });
  const withNudges = async () => {
    const prisma = new MemoryNudgePrisma();
    const repository = new MemoryFactRepository();
    const nudges = new NudgeService({ prisma, memory: repository as never, portfolio: async () => { throw new Error("no portfolio read expected"); }, market: { usdCad: async () => [] } as never, now: () => NOW });
    const built = await build({ nudges });
    return { ...built, prisma };
  };

  it("deleting a thesis also forgets its baseline and clears its nudges, with no portfolio read", async () => {
    const { req, bearer, service, prisma } = await withNudges();
    const thesis = await service.remember(ME, { node: { type: "security", key: "SYN" }, property: "security.thesis", value: { reasons: "Synthetic.", timeFrame: null }, text: "Thesis on SYN: Synthetic.", kind: "reason", provenance: "stated", source: "claude" } as never, NOW);
    await service.remember(ME, {
      node: { type: "security", key: "SYN" }, property: "security.thesis_baseline", kind: "fact", provenance: "derived", text: "Value of SYN recorded when the thesis was saved.",
      value: { writtenAt: NOW.toISOString(), positionsAsOf: NOW.toISOString(), valueCad: 100, units: 1, priceNative: 100, currency: "CAD", accountsSeen: [], accountsAsOf: {} },
    } as never, NOW, "system");
    await service.remember(ME, { node: { type: "security", key: "SYN" }, property: "security.reason", value: null, text: "Unrelated note.", kind: "reason", provenance: "stated", source: "claude" } as never, NOW);
    prisma.rows.push({ id: "n1", ...nudgeRow(ME, "thesis_condition", "SYN", "c1") }, { id: "n2", ...nudgeRow(ME, "thesis_condition", "OTHER", "c1") }, { id: "n3", ...nudgeRow(OTHER, "thesis_condition", "SYN", "c1") });
    await req.delete(`/api/memory/${thesis.fact.id}`).set(await bearer()).expect(204);
    const left = await service.listCurrent(ME);
    expect(left.map((f) => f.property)).toEqual(["security.reason"]);
    expect((await service.listForExport(ME)).some((f) => f.property === "security.thesis_baseline")).toBe(false);
    expect(prisma.rows.find((r) => r.id === "n1")!.clearedAt).toEqual(NOW);
    expect(prisma.rows.find((r) => r.id === "n2")!.clearedAt).toBeNull();
    expect(prisma.rows.find((r) => r.id === "n3")!.clearedAt).toBeNull();
  });

  it("deleting a limit clears that limit's nudges only", async () => {
    const { req, bearer, service, prisma } = await withNudges();
    const limit = await service.remember(ME, { node: { type: "rule", key: "single-holding-syn" }, property: "rule.concentration_limit", value: { kind: "single_holding", target: "SYN", maxPct: 10 }, kind: "plan", text: "Limit: no more than 10% in SYN.", provenance: "stated", source: "claude" } as never, NOW);
    prisma.rows.push(
      { id: "l1", ...nudgeRow(ME, "limit", "single-holding-syn", "SYN|CAD") }, { id: "l2", ...nudgeRow(ME, "limit", "single-holding-syn", "SYN|USD") },
      { id: "l3", ...nudgeRow(ME, "limit", "sector-tech", "Technology") }, { id: "t1", ...nudgeRow(ME, "thesis_condition", "single-holding-syn", "c1") },
    );
    await req.delete(`/api/memory/${limit.fact.id}`).set(await bearer()).expect(204);
    expect(prisma.rows.filter((r) => r.clearedAt !== null).map((r) => r.id)).toEqual(["l1", "l2"]);
  });

  it("an unrelated fact's delete touches no nudge", async () => {
    const { req, bearer, remember, prisma } = await withNudges();
    const fact = await remember(ME);
    prisma.rows.push({ id: "n1", ...nudgeRow(ME, "thesis_condition", "SYN", "c1") });
    await req.delete(`/api/memory/${fact.fact.id}`).set(await bearer()).expect(204);
    expect(prisma.rows[0]!.clearedAt).toBeNull();
  });
});
