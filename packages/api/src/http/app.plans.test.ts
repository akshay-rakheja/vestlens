import { exportJWK, generateKeyPair, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { GatewayTokenService } from "../gateway/tokens.js";
import { connectFacts, FACT_NOW, FACT_SUBJECT, TFSA_ID } from "../testing/fact-tools-harness.js";
import { loopbackRequest } from "../testing/loopback-request.js";
import { memoryOwnerSessions } from "../testing/owner-session-prisma.js";
import { sessionCookieFor } from "../testing/owner-session.js";
import { createPortfolioApi } from "./app.js";

// Synthetic identities, accounts, symbols and amounts only. My TFSA holds SHOP.TO (40% of 3,000) and reports 1,300 CAD.
const APP = "https://mcp.example.test";
const RESOURCE = "https://mcp.example.test/mcp";
const HOSTILE = "<b>x</b> [a](b) <img src=x onerror=alert(1)>";

let signingKey: JWK;
beforeAll(async () => {
  const es = await generateKeyPair("ES256", { extractable: true });
  signingKey = { ...(await exportJWK(es.privateKey)), kid: "gw1" };
});
afterEach(() => vi.restoreAllMocks());

async function build(o: { withFacts?: boolean; portfolioFails?: boolean; stalePortfolio?: boolean } = {}) {
  const harness = await connectFacts();
  const sessions = memoryOwnerSessions();
  const evaluateNudges = vi.fn(async () => ({ raised: 0, cleared: 0, failed: 0 }));
  const facts = { ...harness.facts, nudges: { evaluateNudges } };
  const portfolio = o.stalePortfolio ? { getPortfolio: vi.fn(async () => ({ connectionRequired: false, generatedAt: FACT_NOW.toISOString(), accounts: await (await harness.portfolio.getPortfolio()).accounts, errors: [{ accountId: TFSA_ID, message: "x" }] })) } : o.portfolioFails ? { getPortfolio: vi.fn(async () => { throw new Error(`boom ${FACT_SUBJECT}`); }) } : harness.portfolio;
  const app = createPortfolioApi({
    sessions, portfolio,
    history: { getAccountHistory: vi.fn(async () => ({})) },
    connections: { getConnections: vi.fn(async () => []), createConnectionPortal: vi.fn(async () => "https://x.invalid") },
    webhooks: { ingest: vi.fn(async () => ({ duplicate: false })) },
    appBaseUrl: APP, mcpResourceUrl: RESOURCE,
    memory: { service: harness.service, links: { accountsHoldingSecurity: async () => [], tfsaAccounts: async () => [TFSA_ID], accountIds: async () => [TFSA_ID], activityDedupeKeys: async () => [] } },
    ...(o.withFacts === false ? {} : { portfolioFacts: facts }),
  } as never);
  const req = await loopbackRequest(app);
  // The dashboard's browser headers: the owner session cookie and this app's own Origin (required on writes).
  const bearer = async () => ({ Cookie: await sessionCookieFor(sessions), Origin: APP });
  const call = (name: string, args: Record<string, unknown>) => harness.client.callTool({ name, arguments: args });
  return { req, bearer, call, evaluateNudges, ...harness };
}

const seed = async (call: Awaited<ReturnType<typeof build>>["call"]) => {
  await call("log_thesis", {
    ticker: "SHOP.TO", reasons: HOSTILE, timeFrame: { kind: "long", years: 3 },
    conditions: [{ kind: "price_below", text: "Falls below 100", price: 100, currency: "CAD" }, { kind: "weight_above", text: "Over 30% of the portfolio", pct: 30 }],
  });
  await call("set_portfolio_limit", { kind: "single_holding", target: "SHOP.TO", maxPct: 10 });
  await call("set_savings_goal", { name: "House", targetCad: 50_000, targetDate: "2028-06-30", accounts: [TFSA_ID], growthRatePct: 5 });
  await call("set_savings_goal", { name: "Trip", targetCad: 5_000, targetDate: "2028-06-30", accounts: [TFSA_ID] });
};

const ROUTES = ["/api/theses", "/api/theses/SHOP.TO", "/api/limits", "/api/goals"] as const;

describe("dashboard plan routes: auth", () => {
  it("refuses a gateway-issued AI token on every route, even with the memory scope", async () => {
    const { req } = await build();
    const tokens = new GatewayTokenService({ issuer: APP, audience: RESOURCE, signingKey, now: () => FACT_NOW });
    const ai = (await tokens.issueAccess({ subject: FACT_SUBJECT, clientKey: "dcr-client-synthetic-0001", scope: "portfolio:read memory" })).token;
    for (const path of ROUTES) {
      const res = await req.get(path).set("Authorization", `Bearer ${ai}`);
      expect([401, 403], path).toContain(res.status);
      expect(res.body).not.toHaveProperty("theses");
      expect(res.body).not.toHaveProperty("limits");
      expect(res.body).not.toHaveProperty("goals");
    }
  });

  it("answers 401 without a session", async () => {
    const { req } = await build();
    for (const path of ROUTES) await req.get(path).expect(401);
  });

  it("is not mounted without the fact tools", async () => {
    const { req, bearer } = await build({ withFacts: false });
    for (const path of ROUTES) await req.get(path).set(await bearer()).expect(404);
  });
});

describe("GET /api/theses and /api/theses/:ticker", () => {
  it("lists each thesis with cheap condition status, no-store, and no subject", async () => {
    const { req, bearer, call } = await build();
    await seed(call);
    const res = await req.get("/api/theses").set(await bearer()).expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.theses).toHaveLength(1);
    const [t] = res.body.theses;
    expect(t).toMatchObject({ ticker: "SHOP.TO", reasons: HOSTILE, timeFrame: { ended: false } });
    expect(t.conditions.map((c: { status: string }) => c.status)).toEqual(["held", "broken"]);
    expect(t.playedOut).toHaveProperty("returnPct");
    expect(JSON.stringify(res.body)).not.toContain(FACT_SUBJECT);
  });

  it("never claims no value was found when the thesis was written: return and played out are checked in the full view (I-3)", async () => {
    const { req, bearer, call } = await build();
    await call("log_thesis", {
      ticker: "SHOP.TO", reasons: "Synthetic reasons.", timeFrame: { kind: "long", years: 3 },
      conditions: [{ kind: "return_below", text: "Down 20%", pct: -20 }, { kind: "price_below", text: "Falls below 100", price: 100, currency: "CAD" }],
    });
    const res = await req.get("/api/theses").set(await bearer()).expect(200);
    const [t] = res.body.theses;
    expect(JSON.stringify(res.body)).not.toContain("no value found");
    expect(t.playedOut.reason).toBe("checked in the full view");
    expect(t.conditions[0]).toMatchObject({ kind: "return_below", status: "cant_tell", note: "checked in the full view" });
    expect(t.conditions[1]).toMatchObject({ kind: "price_below", status: "held" });
  });

  it("is empty for a new user", async () => {
    const { req, bearer } = await build();
    expect((await req.get("/api/theses").set(await bearer()).expect(200)).body).toEqual({ theses: [] });
  });

  it("returns the full check for one ticker, found by its base symbol too", async () => {
    const { req, bearer, call } = await build();
    await seed(call);
    for (const path of ["/api/theses/SHOP.TO", "/api/theses/shop"]) {
      const res = await req.get(path).set(await bearer()).expect(200);
      expect(res.body.ticker).toBe("SHOP.TO");
      expect(res.body.thesis.reasons).toBe(HOSTILE);
      expect(res.body.thesis.check.ticker).toBe("SHOP.TO");
      expect(res.body.thesis.check.playedOut).toHaveProperty("notes");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });

  it("answers a fixed 404 for a ticker without a thesis and a fixed 400 for a bad symbol", async () => {
    const { req, bearer, call } = await build();
    await seed(call);
    expect((await req.get("/api/theses/NOPE").set(await bearer()).expect(404)).body).toEqual({ error: "not_found" });
    expect((await req.get(`/api/theses/${encodeURIComponent("<b>")}`).set(await bearer()).expect(400)).body).toEqual({ error: "invalid_ticker" });
  });

  it("a held ticker without a thesis is 404 before any holding view runs (M-2)", async () => {
    const { req, bearer, facts, marketCalls } = await build();
    const activityReads = (facts.prisma as any).activity.findMany as ReturnType<typeof vi.fn>;
    activityReads.mockClear();
    expect((await req.get("/api/theses/SHOP.TO").set(await bearer()).expect(404)).body).toEqual({ error: "not_found" });
    expect(activityReads).not.toHaveBeenCalled();
    expect(marketCalls).toEqual([]);
  });
});

describe("GET /api/limits", () => {
  it("returns each limit with its current share, status and basis sentence", async () => {
    const { req, bearer, call } = await build();
    await seed(call);
    const res = await req.get("/api/limits").set(await bearer()).expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.limits).toHaveLength(1);
    const [l] = res.body.limits;
    expect(l).toMatchObject({ slug: "single-holding-shop-to", kind: "single_holding", maxPct: 10, label: "SHOP.TO" });
    expect(l.rows[0]).toMatchObject({ currentPct: 40, status: "over", line: "SHOP.TO 40%, over your 10% limit" });
    expect(l.rows[0].text).toContain("(of your portfolio, cash included)");
    expect(l.rows[0]).not.toHaveProperty("groupKey");
    expect(JSON.stringify(res.body)).not.toContain(FACT_SUBJECT);
  });

  it("is empty with no limits", async () => {
    const { req, bearer } = await build();
    expect((await req.get("/api/limits").set(await bearer()).expect(200)).body).toEqual({ limits: [] });
  });
});

describe("GET /api/goals", () => {
  it("returns each goal check, with the growth rate only where one is set", async () => {
    const { req, bearer, call } = await build();
    await seed(call);
    const res = await req.get("/api/goals").set(await bearer()).expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const byName = Object.fromEntries(res.body.goals.map((g: { name: string }) => [g.name, g]));
    expect(byName.House).toMatchObject({ targetCad: 50_000, savedCad: 1300, growthRatePct: 5 });
    expect(byName.Trip.growthRatePct).toBeNull();
    expect(byName.Trip.projectedWithRateCad).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(FACT_SUBJECT);
  });
});

describe("read failures", () => {
  it("answer a fixed 503 with a code-only log", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    const { req, bearer, call } = await build({ portfolioFails: true });
    // A saved thesis, so the full-check route reaches the failing portfolio read (without one it is a 404 first).
    await call("log_thesis", { ticker: "SHOP.TO", reasons: "Synthetic reasons." });
    for (const path of ROUTES) {
      const res = await req.get(path).set(await bearer()).expect(503);
      expect(res.body).toEqual({ error: "plans_unavailable" });
    }
    const logged = lines.join("\n");
    expect(logged).toContain("plans_dashboard_failed");
    expect(logged).not.toContain(FACT_SUBJECT);
    expect(logged).not.toContain("boom");
  });
});

const current = (repository: { rows: Array<{ property: string; supersededAt: Date | null; nodeKey: string }> }, property: string) =>
  repository.rows.filter((r) => r.property === property && r.supersededAt === null) as any[];
const EDITS = [
  { method: "patch", path: "/api/limits/single-holding-shop-to", body: { maxPct: 15 } },
  { method: "patch", path: "/api/goals/house", body: { targetCad: 60_000 } },
  { method: "patch", path: "/api/theses/SHOP.TO", body: { timeFrame: null } },
  { method: "delete", path: "/api/limits/single-holding-shop-to" },
  { method: "delete", path: "/api/goals/house" },
  { method: "delete", path: "/api/theses/SHOP.TO" },
] as const;

describe("typed edit routes: auth", () => {
  it("refuses a gateway AI token, a missing session and a foreign Origin; changes nothing", async () => {
    const { req, bearer, call, repository } = await build();
    await seed(call);
    const before = repository.rows.length;
    const tokens = new GatewayTokenService({ issuer: APP, audience: RESOURCE, signingKey, now: () => FACT_NOW });
    const ai = (await tokens.issueAccess({ subject: FACT_SUBJECT, clientKey: "dcr-client-synthetic-0001", scope: "portfolio:read memory" })).token;
    for (const r of EDITS) {
      expect([401, 403], r.path).toContain((await req[r.method](r.path).set("Authorization", `Bearer ${ai}`).send("body" in r ? r.body : undefined)).status);
      await req[r.method](r.path).send("body" in r ? r.body : undefined).expect(401);
      expect((await req[r.method](r.path).set("Cookie", (await bearer()).Cookie).set("Origin", "https://evil.example").send("body" in r ? r.body : undefined)).status).toBe(403);
    }
    expect(repository.rows.length).toBe(before);
  });
});

describe("PATCH /api/limits/:slug", () => {
  it("saves the new maximum as a stated entry with the tool's text, then re-evaluates nudges", async () => {
    const { req, bearer, call, repository, evaluateNudges } = await build();
    await seed(call);
    const res = await req.patch("/api/limits/single-holding-shop-to").set(await bearer()).send({ maxPct: 15 }).expect(200);
    expect(res.body).toEqual({ saved: true });
    const [row] = current(repository, "rule.concentration_limit");
    expect(row).toMatchObject({ nodeKey: "single-holding-shop-to", provenance: "stated", source: "dashboard", text: "Limit: no more than 15% in SHOP.TO." });
    expect(row.value).toEqual({ kind: "single_holding", target: "SHOP.TO", maxPct: 15 });
    expect(evaluateNudges).toHaveBeenCalledTimes(1);
    expect((evaluateNudges.mock.calls[0] as unknown[])[0]).toBe(FACT_SUBJECT);
    const shown = await req.get("/api/limits").set(await bearer()).expect(200);
    expect(shown.body.limits[0]).toMatchObject({ maxPct: 15 });
  });

  it("uses the same text as set_portfolio_limit, account subset included", async () => {
    const { req, bearer, call, repository } = await build();
    await call("set_portfolio_limit", { kind: "single_holding", maxPct: 50, accounts: [TFSA_ID] });
    const slug = current(repository, "rule.concentration_limit")[0].nodeKey;
    const viaTool = current(repository, "rule.concentration_limit")[0].text;
    await req.patch(`/api/limits/${slug}`).set(await bearer()).send({ maxPct: 50 }).expect(200);
    expect(current(repository, "rule.concentration_limit")[0].text).toBe(viaTool);
    expect(viaTool).toContain("in My TFSA");
  });

  it("rejects a bad value, extra fields and an unknown limit with fixed bodies, saving nothing", async () => {
    const { req, bearer, call, repository, evaluateNudges } = await build();
    await seed(call);
    const before = repository.rows.length;
    for (const body of [{ maxPct: 120 }, { maxPct: "x" }, {}, { maxPct: 10, text: "hi" }]) {
      const res = await req.patch("/api/limits/single-holding-shop-to").set(await bearer()).send(body).expect(400);
      expect(res.body).toEqual({ error: "invalid_plan_edit", message: "That change could not be saved." });
    }
    expect((await req.patch("/api/limits/nope").set(await bearer()).send({ maxPct: 5 }).expect(404)).body).toEqual({ error: "not_found" });
    expect(repository.rows.length).toBe(before);
    expect(evaluateNudges).not.toHaveBeenCalled();
  });

  it("still saves on a partial read but leaves the nudges for the nightly run", async () => {
    const { req, bearer, call, repository, evaluateNudges } = await build({ stalePortfolio: true });
    await seed(call);
    await req.patch("/api/limits/single-holding-shop-to").set(await bearer()).send({ maxPct: 15 }).expect(200);
    expect(current(repository, "rule.concentration_limit")[0].value.maxPct).toBe(15);
    expect(evaluateNudges).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/goals/:slug", () => {
  it("changes only the given fields, with the tool's text; null removes the growth rate", async () => {
    const { req, bearer, call, repository } = await build();
    await seed(call);
    await req.patch("/api/goals/house").set(await bearer()).send({ targetCad: 60_000 }).expect(200);
    let [row] = current(repository, "goal.savings_target").filter((r) => r.nodeKey === "house");
    expect(row.text).toBe("Goal: House, $60,000 by 2028-06-30.");
    expect(row.value).toMatchObject({ name: "House", targetCad: 60_000, targetDate: "2028-06-30", growthRatePct: 5 });
    expect(row).toMatchObject({ provenance: "stated", source: "dashboard" });
    await req.patch("/api/goals/house").set(await bearer()).send({ targetDate: "2029-01-01", growthRatePct: null }).expect(200);
    [row] = current(repository, "goal.savings_target").filter((r) => r.nodeKey === "house");
    expect(row.text).toBe("Goal: House, $60,000 by 2029-01-01.");
    expect(row.value).not.toHaveProperty("growthRatePct");
    expect(row.value.accounts).toHaveLength(1);
  });

  it("rejects bad values and an unknown goal", async () => {
    const { req, bearer, call } = await build();
    await seed(call);
    for (const body of [{ targetCad: -5 }, { targetDate: "soon" }, { growthRatePct: 50 }, {}, { name: "Other" }]) {
      expect((await req.patch("/api/goals/house").set(await bearer()).send(body).expect(400)).body.error).toBe("invalid_plan_edit");
    }
    await req.patch("/api/goals/nope").set(await bearer()).send({ targetCad: 5 }).expect(404);
  });
});

describe("PATCH /api/theses/:ticker", () => {
  it("changes the time frame, keeping reasons, writtenAt, conditions and text; then re-evaluates nudges", async () => {
    const { req, bearer, call, repository, evaluateNudges } = await build();
    await seed(call);
    const [before] = current(repository, "security.thesis");
    await req.patch("/api/theses/shop").set(await bearer()).send({ timeFrame: { kind: "short", endDate: "2027-06-01" } }).expect(200);
    const [row] = current(repository, "security.thesis");
    expect(row.value.timeFrame).toEqual({ kind: "short", endDate: "2027-06-01" });
    expect(row.value.reasons).toBe(before.value.reasons);
    expect(row.value.writtenAt).toBe(before.value.writtenAt);
    expect(row.value.conditions).toEqual(before.value.conditions);
    expect(row.text).toBe(before.text);
    expect(row).toMatchObject({ provenance: "stated", source: "dashboard" });
    expect(evaluateNudges).toHaveBeenCalledTimes(1);
    await req.patch("/api/theses/SHOP.TO").set(await bearer()).send({ timeFrame: null }).expect(200);
    expect(current(repository, "security.thesis")[0].value.timeFrame).toBeNull();
  });

  it("replaces the conditions, keeping the ids of ones sent with them", async () => {
    const { req, bearer, call, repository } = await build();
    await seed(call);
    const [before] = current(repository, "security.thesis");
    const keep = before.value.conditions[0];
    await req.patch("/api/theses/SHOP.TO").set(await bearer()).send({ conditions: [keep] }).expect(200);
    expect(current(repository, "security.thesis")[0].value.conditions).toEqual([keep]);
    await req.patch("/api/theses/SHOP.TO").set(await bearer()).send({ conditions: [] }).expect(200);
    expect(current(repository, "security.thesis")[0].value.conditions).toEqual([]);
  });

  it("cannot change the reasons; a bad body or unknown ticker is refused", async () => {
    const { req, bearer, call, repository, evaluateNudges } = await build();
    await seed(call);
    const before = repository.rows.length;
    for (const body of [{ reasons: "new" }, {}, { timeFrame: { kind: "weekly" } }, { conditions: [{ kind: "price_below", text: "x" }] }]) {
      expect((await req.patch("/api/theses/SHOP.TO").set(await bearer()).send(body).expect(400)).body).toEqual({ error: "invalid_plan_edit", message: "That change could not be saved." });
    }
    await req.patch("/api/theses/NOPE").set(await bearer()).send({ timeFrame: null }).expect(404);
    expect(repository.rows.length).toBe(before);
    expect(evaluateNudges).not.toHaveBeenCalled();
  });
});

describe("typed deletes", () => {
  it("DELETE /api/limits/:slug removes it and re-evaluates nudges; a second delete is 404", async () => {
    const { req, bearer, call, repository, evaluateNudges } = await build();
    await seed(call);
    await req.delete("/api/limits/single-holding-shop-to").set(await bearer()).expect(204);
    expect(current(repository, "rule.concentration_limit")).toHaveLength(0);
    expect(evaluateNudges).toHaveBeenCalledTimes(1);
    await req.delete("/api/limits/single-holding-shop-to").set(await bearer()).expect(404);
  });

  it("DELETE /api/theses/:ticker removes the thesis and its baseline, then re-evaluates nudges", async () => {
    const { req, bearer, call, repository, evaluateNudges } = await build();
    await seed(call);
    await req.delete("/api/theses/shop").set(await bearer()).expect(204);
    expect(repository.rows.filter((r: any) => ["security.thesis", "security.thesis_baseline"].includes(r.property))).toHaveLength(0);
    expect(evaluateNudges).toHaveBeenCalledTimes(1);
    await req.delete("/api/theses/SHOP.TO").set(await bearer()).expect(404);
  });

  it("DELETE /api/goals/:slug removes the goal only", async () => {
    const { req, bearer, call, repository } = await build();
    await seed(call);
    await req.delete("/api/goals/house").set(await bearer()).expect(204);
    expect(current(repository, "goal.savings_target").map((r) => r.nodeKey)).toEqual(["trip"]);
    await req.delete("/api/goals/house").set(await bearer()).expect(404);
  });

  it("a nudge failure never fails the delete", async () => {
    const { req, bearer, call, evaluateNudges } = await build();
    await seed(call);
    evaluateNudges.mockRejectedValueOnce(new Error("boom"));
    await req.delete("/api/limits/single-holding-shop-to").set(await bearer()).expect(204);
  });
});
