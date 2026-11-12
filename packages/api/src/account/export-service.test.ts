import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { AccountExportService, EXPORT_FIELDS, EXPORT_FORMAT, EXPORT_NOTE, type ExportPrismaPort, type ExportPage } from "./export-service.js";

// Synthetic ids and values only.
const ME = "subject|synthetic-me";
const OTHER = "subject|synthetic-other";
const ME_ID = "00000000-0000-4000-8000-00000000000a";
const OTHER_ID = "00000000-0000-4000-8000-00000000000b";
const NOW = new Date("2026-10-23T12:00:00.000Z");

type Row = Record<string, unknown> & { id: string; appUserId: string };

/** In-memory port that honours where/orderBy/cursor/take like Prisma and records every page request. */
function fakePrisma(tables: Record<string, Row[]>, opts: { failOn?: { table: string; call: number } } = {}) {
  const calls: Array<{ table: string; page: ExportPage }> = [];
  const counts: Record<string, number> = {};
  const delegate = (table: string) => ({
    async findMany(page: ExportPage) {
      calls.push({ table, page });
      counts[table] = (counts[table] ?? 0) + 1;
      if (opts.failOn?.table === table && opts.failOn.call === counts[table]) throw new Error("synthetic db failure");
      let rows = (tables[table] ?? []).filter((r) => Object.entries(page.where).every(([k, v]) => r[k] === v));
      rows = [...rows].sort((a, b) => a.id.localeCompare(b.id));
      if (page.cursor) rows = rows.slice(rows.findIndex((r) => r.id === page.cursor!.id) + 1);
      // Return whole rows, as a mocked driver that ignores `select` would: the service must still allowlist.
      return rows.slice(0, page.take);
    },
  });
  const port: ExportPrismaPort = {
    appUser: { findUnique: async ({ where }) => (where.authSubject === ME ? { id: ME_ID } : where.authSubject === OTHER ? { id: OTHER_ID } : null) },
    brokerageConnection: delegate("connections"),
    brokerageAccount: delegate("accounts"),
    portfolioSnapshot: delegate("snapshots"),
    activity: delegate("activities"),
    dailyValue: delegate("dailyValues"),
    newsAlertDelivery: delegate("deliveries"),
    pendingDisconnect: delegate("pending"),
    portfolioSettings: { findUnique: async ({ where }) => (tables.settings ?? []).find((r) => r.appUserId === where.appUserId) ?? null },
    activitySyncState: { findMany: async ({ where }) => (tables.syncStates ?? []).filter((r) => r.appUserId === where.appUserId) },
    accountHistoryQuality: { findMany: async ({ where }) => (tables.qualities ?? []).filter((r) => r.appUserId === where.appUserId) },
  };
  return { port, calls };
}

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function service(tables: Record<string, Row[]>, extra: Partial<ConstructorParameters<typeof AccountExportService>[0]> = {}, failOn?: { table: string; call: number }) {
  const { port, calls } = fakePrisma(tables, { failOn });
  const svc = new AccountExportService({
    prisma: port,
    aiApps: { list: async (s) => (s === ME ? [{ clientKey: "dcr-me", name: "ChatGPT", host: "chatgpt.com", grantedAt: "2026-10-22T09:00:00.000Z", tokenHash: "x" } as never] : []) },
    memory: { listForExport: async (s) => (s === ME ? memoryRows() : []) },
    roomAlerts: { listForExport: async (s) => (s === ME ? roomAlertRows() : []) },
    nudges: { listForExport: async (s) => (s === ME ? nudgeRows() : []) },
    now: () => NOW,
    ...extra,
  });
  return { svc, calls };
}

async function run(svc: AccountExportService, subject = ME) {
  const chunks: string[] = [];
  const counts = await svc.stream(subject, async (c) => { chunks.push(c); });
  return { text: chunks.join(""), chunks, counts };
}

const nudgeRows = () => [
  { kind: "thesis_condition", target: "SYN", conditionId: "c0000abcd", basis: "0123456789abcdef", text: "Your SYN thesis condition 'Synthetic' looks broken (9.00 CAD as of 2026-10-02).",
    raisedAt: new Date("2026-10-02T00:00:00Z"), updatedAt: new Date("2026-10-02T00:00:00Z"), clearedAt: new Date("2026-10-03T00:00:00Z"), id: "LEAK-id", subject: ME },
];

const memoryRows = () => [
  { nodeType: "security", nodeKey: "SYN", property: "security.reason", value: null, text: "Old reason.", kind: "reason", provenance: "stated",
    validFrom: null, validTo: null, recordedAt: new Date("2026-10-01T00:00:00Z"), source: "claude", supersededAt: new Date("2026-10-02T00:00:00Z"),
    id: "LEAK-memory-id", subject: ME, futureColumn: "LEAK-future" } as never,
  { nodeType: "security", nodeKey: "SYN", property: "security.reason", value: null, text: "New reason.", kind: "reason", provenance: "inferred",
    validFrom: null, validTo: null, recordedAt: new Date("2026-10-02T00:00:00Z"), source: "dashboard", supersededAt: null } as never,
];

const roomAlertRows = () => [
  { year: 2026, excessCad: "1000.00", estimated: true, note: "(est.)", raisedAt: new Date("2026-10-02T00:00:00Z"), updatedAt: new Date("2026-10-03T00:00:00Z"), clearedAt: null,
    id: "LEAK-alert-id", subject: ME, futureColumn: "LEAK-future" } as never,
];

const baseTables = (): Record<string, Row[]> => ({
  connections: [
    { id: id(1), appUserId: ME_ID, snapTradeConnectionId: "conn-me", brokerageName: "Synthetic Broker", disabled: false, secretLike: "LEAK-conn" },
    { id: id(2), appUserId: OTHER_ID, snapTradeConnectionId: "conn-other", brokerageName: "Other Broker", disabled: false },
  ],
  accounts: [
    { id: id(3), appUserId: ME_ID, snapTradeAccountId: "acct-me", institutionName: "Synthetic Broker", reportedTotal: "100.5", reportedCurrency: "CAD" },
    { id: id(4), appUserId: OTHER_ID, snapTradeAccountId: "acct-other", institutionName: "Other Broker" },
  ],
  snapshots: [
    { id: id(5), appUserId: ME_ID, snapTradeAccountId: "acct-me", payload: { positions: [] }, capturedAt: new Date("2026-10-20T00:00:00Z") },
    { id: id(6), appUserId: OTHER_ID, snapTradeAccountId: "acct-other", payload: { positions: ["other"] } },
  ],
  activities: [
    { id: id(7), appUserId: ME_ID, snapTradeAccountId: "acct-me", dedupeKey: "dedupe-secret", type: "BUY", symbol: "SYN", amount: "10" },
    { id: id(8), appUserId: OTHER_ID, snapTradeAccountId: "acct-other", dedupeKey: "d2", type: "SELL", symbol: "OTHERSYM" },
  ],
  dailyValues: [
    { id: id(9), appUserId: ME_ID, snapTradeAccountId: "acct-me", currency: "CAD", value: "1", date: new Date("2026-10-01T00:00:00Z") },
    { id: id(10), appUserId: OTHER_ID, snapTradeAccountId: "acct-other", currency: "CAD", value: "2" },
  ],
  settings: [
    { id: "s1", appUserId: ME_ID, benchmark: "sp500", cadView: true, privacyDefault: false, targetAllocation: null, contributionRoom: null },
    { id: "s2", appUserId: OTHER_ID, benchmark: "other-bench" },
  ],
  deliveries: [
    { id: id(11), appUserId: ME_ID, clientKey: "dcr-me", alertId: "alert-1", deliveredAt: new Date("2026-10-21T00:00:00Z") },
    { id: id(12), appUserId: OTHER_ID, clientKey: "dcr-other", alertId: "alert-other" },
  ],
  syncStates: [
    { id: "y1", appUserId: ME_ID, snapTradeAccountId: "acct-me", lastSyncedAt: new Date("2026-10-22T00:00:00Z"), activityCount: 3, lastError: null, dirty: true },
    { id: "y2", appUserId: OTHER_ID, snapTradeAccountId: "acct-other", activityCount: 99 },
  ],
  qualities: [
    { id: "q1", appUserId: ME_ID, snapTradeAccountId: "acct-me", method: "replay", reason: null, driftFraction: "0.01", computedAt: new Date("2026-10-22T00:00:00Z") },
    { id: "q2", appUserId: OTHER_ID, snapTradeAccountId: "acct-other", method: "other-method" },
  ],
  pending: [
    { id: id(13), appUserId: ME_ID, snapTradeConnectionId: "conn-gone", snapTradeAccountIds: ["acct-gone"], requestedAt: new Date("2026-10-22T00:00:00Z"), confirmedAt: null },
    { id: id(14), appUserId: OTHER_ID, snapTradeConnectionId: "conn-other-gone", requestedAt: new Date("2026-10-22T00:00:00Z") },
  ],
});

describe("AccountExportService", () => {
  it("writes a header and only the caller's rows, as one valid JSON document", async () => {
    const { svc } = service(baseTables());
    const { text, counts } = await run(svc);
    const doc = JSON.parse(text);
    expect(doc.exportedAt).toBe(NOW.toISOString());
    expect(doc.format).toBe(EXPORT_FORMAT);
    expect(doc.note).toBe("Webhook receipts are short-lived operational records and are not included.");
    expect(EXPORT_NOTE).toBe(doc.note);
    expect(doc).not.toHaveProperty("identity");
    expect(doc.activitySyncStates).toEqual([{ snapTradeAccountId: "acct-me", backfillCompletedAt: undefined, lastSyncedAt: "2026-10-22T00:00:00.000Z", lastError: null, activityCount: 3, earliestTradeDate: undefined, dirty: true }].map((r) => JSON.parse(JSON.stringify(r))));
    expect(doc.accountHistoryQualities).toEqual([{ snapTradeAccountId: "acct-me", method: "replay", reason: null, driftFraction: "0.01", computedAt: "2026-10-22T00:00:00.000Z" }]);
    expect(doc.pendingDisconnects[0].snapTradeAccountIds).toEqual(["acct-gone"]);
    expect(EXPORT_FORMAT).toBe("vestlens-export-v1");
    expect(doc.connections.map((r: { snapTradeConnectionId: string }) => r.snapTradeConnectionId)).toEqual(["conn-me"]);
    expect(doc.accounts.map((r: { snapTradeAccountId: string }) => r.snapTradeAccountId)).toEqual(["acct-me"]);
    expect(doc.snapshots).toHaveLength(1);
    expect(doc.activities.map((r: { symbol: string }) => r.symbol)).toEqual(["SYN"]);
    expect(doc.dailyValues).toHaveLength(1);
    expect(doc.settings.benchmark).toBe("sp500");
    expect(doc.newsAlertDeliveries.map((r: { alertId: string }) => r.alertId)).toEqual(["alert-1"]);
    expect(doc.pendingDisconnects.map((r: { snapTradeConnectionId: string }) => r.snapTradeConnectionId)).toEqual(["conn-gone"]);
    expect(doc.aiApps).toEqual([{ clientKey: "dcr-me", name: "ChatGPT", host: "chatgpt.com", grantedAt: "2026-10-22T09:00:00.000Z" }]);
    // Every memory fact, current and superseded, through the allowlist (no id, subject or unlisted column).
    expect(doc.memory).toEqual([
      { nodeType: "security", nodeKey: "SYN", property: "security.reason", value: null, text: "Old reason.", kind: "reason", provenance: "stated",
        validFrom: null, validTo: null, recordedAt: "2026-10-01T00:00:00.000Z", source: "claude", supersededAt: "2026-10-02T00:00:00.000Z" },
      { nodeType: "security", nodeKey: "SYN", property: "security.reason", value: null, text: "New reason.", kind: "reason", provenance: "inferred",
        validFrom: null, validTo: null, recordedAt: "2026-10-02T00:00:00.000Z", source: "dashboard", supersededAt: null },
    ]);
    // The subject's TFSA over-limit alerts, open and cleared, through the allowlist.
    expect(doc.roomAlerts).toEqual([
      { year: 2026, excessCad: "1000.00", estimated: true, note: "(est.)", raisedAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z", clearedAt: null },
    ]);
    // The subject's thesis and limit nudges, open and cleared, through the allowlist.
    expect(doc.nudges).toEqual([
      { kind: "thesis_condition", target: "SYN", conditionId: "c0000abcd", basis: "0123456789abcdef", text: "Your SYN thesis condition 'Synthetic' looks broken (9.00 CAD as of 2026-10-02).",
        raisedAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", clearedAt: "2026-10-03T00:00:00.000Z" },
    ]);
    expect(text).not.toContain("LEAK");
    expect(text).not.toContain(ME);
    for (const leak of ["other", "OTHERSYM", "dcr-other"]) expect(text).not.toContain(leak);
    expect(counts).toMatchObject({ connections: 1, accounts: 1, snapshots: 1, activities: 1, dailyValues: 1, newsAlertDeliveries: 1, pendingDisconnects: 1, aiApps: 1, memory: 2, roomAlerts: 1, nudges: 1 });
  });

  it("account export includes an account.tfsa_moves fact", async () => {
    const value = { year: 2026, entries: [{ date: "2026-03-01", amountCad: 500, kind: "deposit" }, { date: "2026-04-01", amountCad: 100, kind: "withdrawal" }] };
    const row = { nodeType: "account", nodeKey: "outside:synthetic-bank", property: "account.tfsa_moves", value, text: "Synthetic outside moves.", kind: "fact", provenance: "stated",
      validFrom: new Date("2026-01-01T00:00:00Z"), validTo: null, recordedAt: new Date("2026-10-02T00:00:00Z"), source: "dashboard", supersededAt: null };
    const { svc } = service(baseTables(), { memory: { listForExport: async (s) => (s === ME ? [row as never] : []) } });
    const doc = JSON.parse((await run(svc)).text);
    expect(doc.memory).toEqual([{ ...row, validFrom: "2026-01-01T00:00:00.000Z", recordedAt: "2026-10-02T00:00:00.000Z" }]);
  });

  it("account export includes a tax_year.fhsa_room fact", async () => {
    const row = { nodeType: "tax_year", nodeKey: "2026:fhsa", property: "tax_year.fhsa_room", value: { amountCad: 8000 }, text: "Synthetic FHSA room.", kind: "fact", provenance: "stated",
      validFrom: new Date("2026-01-01T00:00:00Z"), validTo: null, recordedAt: new Date("2026-10-02T00:00:00Z"), source: "dashboard", supersededAt: null };
    const { svc } = service(baseTables(), { memory: { listForExport: async (s) => (s === ME ? [row as never] : []) } });
    const doc = JSON.parse((await run(svc)).text);
    expect(doc.memory).toEqual([{ ...row, validFrom: "2026-01-01T00:00:00.000Z", recordedAt: "2026-10-02T00:00:00.000Z" }]);
  });

  it("scopes every query by the caller's appUserId, never the other user's", async () => {
    const { svc, calls } = service(baseTables());
    await run(svc);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.page.where).toEqual({ appUserId: ME_ID });
    const other = await run(svc, OTHER);
    expect(other.text).toContain("other-bench");
    expect(other.text).not.toContain("conn-me");
    expect(other.text).not.toContain("dcr-me");
  });

  it("never emits fields outside the per-table allowlist, even when the driver returns extra columns", async () => {
    const t = baseTables();
    t.connections[0] = { ...t.connections[0]!, encryptedUserSecret: "LEAK-secret", keyVersion: "LEAK-kv", ipHash: "LEAK-ip", tokenHash: "LEAK-tok", codeHash: "LEAK-code", payload: "LEAK-raw", futureColumn: "LEAK-future" };
    t.accounts[0] = { ...t.accounts[0]!, futureColumn: "LEAK-future" };
    t.activities[0] = { ...t.activities[0]!, futureColumn: "LEAK-future" };
    t.settings[0] = { ...t.settings[0]!, futureColumn: "LEAK-future" };
    const { svc } = service(t);
    const { text } = await run(svc);
    expect(text).not.toMatch(/LEAK|encryptedUserSecret|keyVersion|ipHash|tokenHash|codeHash|dedupeKey|dedupe-secret|appUserId|failureCode/);
  });

  it("requests only allowlisted columns (plus the id cursor) from the database", async () => {
    const { svc, calls } = service(baseTables());
    await run(svc);
    for (const c of calls) {
      const cols = Object.keys(c.page.select);
      for (const banned of ["encryptedUserSecret", "keyVersion", "ipHash", "tokenHash", "dedupeKey", "appUserId"]) expect(cols).not.toContain(banned);
    }
  });

  it("returns a valid export with empty arrays for a subject with no AppUser row", async () => {
    const { svc, calls } = service(baseTables());
    const ghost = "subject|synthetic-never-connected";
    const { text } = await run(svc, ghost);
    const doc = JSON.parse(text);
    for (const k of ["connections", "accounts", "snapshots", "activities", "dailyValues", "newsAlertDeliveries", "pendingDisconnects", "aiApps", "memory", "roomAlerts", "nudges", "activitySyncStates", "accountHistoryQualities"]) expect(doc[k]).toEqual([]);
    expect(doc.settings).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("streams a 10k-row history in bounded pages without ever holding it all at once", async () => {
    const t = baseTables();
    t.activities = Array.from({ length: 10_000 }, (_, i) => ({ id: id(100 + i), appUserId: ME_ID, snapTradeAccountId: "acct-me", dedupeKey: `k${i}`, type: "BUY", symbol: "SYN", amount: "1" }));
    const { svc, calls } = service(t);
    let largestChunk = 0;
    let total = 0;
    let first = "";
    const counts = await svc.stream(ME, async (c) => { largestChunk = Math.max(largestChunk, c.length); total += c.length; if (!first) first = c; });
    const pages = calls.filter((c) => c.table === "activities");
    expect(pages.length).toBeGreaterThanOrEqual(10);
    expect(Math.max(...pages.map((p) => p.page.take))).toBeLessThanOrEqual(1001);
    expect(pages[1]!.page.cursor).toBeDefined();
    expect(counts.activities).toBe(10_000);
    // No single chunk approaches the whole document.
    expect(largestChunk).toBeLessThan(total / 5);
    expect(first.startsWith("{")).toBe(true);
  });

  it("rejects mid-stream without ever writing a closing bracket", async () => {
    const t = baseTables();
    t.activities = Array.from({ length: 2_500 }, (_, i) => ({ id: id(100 + i), appUserId: ME_ID, snapTradeAccountId: "a", dedupeKey: `k${i}`, type: "BUY" }));
    const { svc } = service(t, {}, { table: "activities", call: 2 });
    const chunks: string[] = [];
    await expect(svc.stream(ME, async (c) => { chunks.push(c); })).rejects.toThrow("synthetic db failure");
    const text = chunks.join("");
    expect(text).toContain('"activities":[');
    expect(() => JSON.parse(text)).toThrow();
    expect(text.endsWith("]}")).toBe(false);
    expect(text).not.toContain('"dailyValues"');
  });

  it("allowlists only columns that exist on the Prisma model, so a rename fails the build", () => {
    const model: Record<keyof typeof EXPORT_FIELDS, string | null> = {
      connections: "BrokerageConnection", accounts: "BrokerageAccount", snapshots: "PortfolioSnapshot", activities: "Activity",
      dailyValues: "DailyValue", settings: "PortfolioSettings", activitySyncStates: "ActivitySyncState",
      accountHistoryQualities: "AccountHistoryQuality", newsAlertDeliveries: "NewsAlertDelivery", pendingDisconnects: "PendingDisconnect",
      aiApps: null, memory: "MemoryFact", roomAlerts: "ContributionRoomAlert", nudges: "PortfolioNudge",
    };
    const models = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, new Set(m.fields.map((f) => f.name))]));
    for (const [table, name] of Object.entries(model)) {
      if (!name) continue;
      const fields = models.get(name);
      expect(fields, name).toBeDefined();
      for (const f of EXPORT_FIELDS[table as keyof typeof EXPORT_FIELDS]) expect(fields!.has(f), `${name}.${f}`).toBe(true);
    }
    expect(EXPORT_FIELDS.memory).not.toContain("subject");
    expect(EXPORT_FIELDS.roomAlerts).not.toContain("subject");
    expect(EXPORT_FIELDS.nudges).not.toContain("subject");
    expect(EXPORT_FIELDS.nudges).not.toContain("id");
    for (const banned of ["encryptedUserSecret", "keyVersion", "ipHash", "dedupeKey", "appUserId"]) {
      for (const list of Object.values(EXPORT_FIELDS)) expect(list as readonly string[]).not.toContain(banned);
    }
  });
});
