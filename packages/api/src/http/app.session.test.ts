import express from "express";
import { describe, expect, it, vi } from "vitest";

import { InvalidAccessTokenError } from "../auth/token-types.js";
import { SESSION_COOKIE } from "../auth/owner-session.js";
import { OWNER_SUBJECT } from "../identity/owner-identity.js";
import { loopbackRequest } from "../testing/loopback-request.js";
import { memoryOwnerSessions } from "../testing/owner-session-prisma.js";
import { sessionCookieFor } from "../testing/owner-session.js";
import { createPortfolioApi } from "./app.js";

const APP = "https://portfolio.example.com";

function build(o: { sessions?: { resolve(token: string): Promise<boolean> }; withGateway?: boolean } = {}) {
  const store = memoryOwnerSessions();
  const portfolio = {
    getPortfolio: vi.fn(async (_subject: string) => ({ connectionRequired: false, generatedAt: "2026-08-19T15:00:00.000Z", accounts: [], errors: [] })),
  };
  const connections = {
    getConnections: vi.fn(async () => []),
    createConnectionPortal: vi.fn(async () => "https://connect.snaptrade.example/session"),
  };
  const mcpVerifier = { verify: vi.fn(async () => { throw new InvalidAccessTokenError(); }) };
  const app = createPortfolioApi({
    sessions: o.sessions ?? store,
    portfolio,
    history: { getAccountHistory: vi.fn() },
    connections,
    webhooks: { ingest: vi.fn(async () => ({ duplicate: false })) },
    appBaseUrl: APP,
    ...(o.withGateway ? { gateway: { router: express.Router(), mcpVerifier, issuer: APP } } : {}),
  } as never);
  return { app, store, portfolio, connections, mcpVerifier };
}

describe("/api on the owner session", () => {
  it("serves /api/portfolio to a session and 401 without one", async () => {
    const { app, store, portfolio } = build();
    const req = await loopbackRequest(app);
    const none = await req.get("/api/portfolio").expect(401);
    expect(none.body).toEqual({ error: "authentication_required" });
    const ok = await req.get("/api/portfolio").set("Cookie", await sessionCookieFor(store)).expect(200);
    expect(ok.body.connectionRequired).toBe(false);
    expect(portfolio.getPortfolio).toHaveBeenCalledTimes(1);
  });

  it("hands services the owner subject, never a token subject", async () => {
    const { app, store, portfolio } = build();
    await (await loopbackRequest(app)).get("/api/portfolio").set("Cookie", await sessionCookieFor(store)).expect(200);
    expect(portfolio.getPortfolio).toHaveBeenCalledWith(OWNER_SUBJECT);
  });

  it("refuses a cross-origin POST with a valid session", async () => {
    const { app, store, connections } = build();
    const cookie = await sessionCookieFor(store);
    const req = await loopbackRequest(app);
    const evil = await req.post("/api/connections/session").set("Cookie", cookie).set("Origin", "https://evil.example").send({}).expect(403);
    expect(evil.body).toEqual({ error: "bad_origin" });
    const missing = await req.post("/api/connections/session").set("Cookie", cookie).send({}).expect(403);
    expect(missing.body).toEqual({ error: "bad_origin" });
    expect(connections.createConnectionPortal).not.toHaveBeenCalled();
    await req.post("/api/connections/session").set("Cookie", cookie).set("Origin", APP).send({}).expect(200);
    expect(connections.createConnectionPortal).toHaveBeenCalledTimes(1);
  });

  it("refuses DELETE and PATCH without this app's Origin as bad_origin, and never looks the session up", async () => {
    // These are the routes that accept a non-GET write other than POST (no route takes PUT). The Origin check runs
    // before the session lookup, so the handlers below are never reached.
    const resolve = vi.fn(async () => true);
    const store = memoryOwnerSessions();
    const disconnect = vi.fn();
    const app = createPortfolioApi({
      sessions: { resolve },
      portfolio: { getPortfolio: vi.fn() },
      history: { getAccountHistory: vi.fn() },
      connections: { getConnections: vi.fn(), createConnectionPortal: vi.fn() },
      dataControls: { disconnect },
      memory: {},
      appBaseUrl: APP,
    } as never);
    const cookie = await sessionCookieFor(store);
    const req = await loopbackRequest(app);
    for (const [method, path] of [["delete", "/api/connections/c1"], ["patch", "/api/memory/m1"], ["delete", "/api/memory/m1"]] as const) {
      for (const origin of [undefined, "https://evil.example", "null"]) {
        let call = req[method](path).set("Cookie", cookie);
        if (origin !== undefined) call = call.set("Origin", origin);
        const res = await call.expect(403);
        expect(res.body).toEqual({ error: "bad_origin" });
      }
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("sets the sliding session cookie without Secure on a loopback http base URL", async () => {
    const store = memoryOwnerSessions();
    const app = createPortfolioApi({
      sessions: store,
      portfolio: { getPortfolio: vi.fn() },
      history: { getAccountHistory: vi.fn() },
      connections: { getConnections: vi.fn(), createConnectionPortal: vi.fn() },
      appBaseUrl: "http://127.0.0.1:8080",
    } as never);
    const res = await (await loopbackRequest(app)).get("/api/session").set("Cookie", await sessionCookieFor(store)).expect(200);
    expect(res.body).toEqual({ signedIn: true });
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("Secure");
    // The https base URL in the other tests keeps Secure.
    const { app: secureApp, store: secureStore } = build();
    const secure = await (await loopbackRequest(secureApp)).get("/api/session").set("Cookie", await sessionCookieFor(secureStore)).expect(200);
    expect(String(secure.headers["set-cookie"])).toContain("Secure");
  });

  it("never accepts the session cookie on /mcp", async () => {
    const { app, store, mcpVerifier } = build({ withGateway: true });
    const cookie = await sessionCookieFor(store);
    const req = await loopbackRequest(app);
    for (const method of ["post", "get", "delete"] as const) {
      const res = await req[method]("/mcp").set("Cookie", cookie).send({}).expect(401);
      expect(res.headers["www-authenticate"]).toContain("resource_metadata=");
    }
    expect(mcpVerifier.verify).not.toHaveBeenCalled();
  });

  it("refuses every /mcp token when no gateway is composed", async () => {
    const { app } = build();
    const res = await (await loopbackRequest(app)).post("/mcp").set("Authorization", "Bearer anything").send({}).expect(401);
    expect(res.body).toEqual({ error: "invalid_token" });
  });

  it("ignores a bearer token on /api", async () => {
    const { app, portfolio } = build({ withGateway: true });
    const res = await (await loopbackRequest(app)).get("/api/portfolio").set("Authorization", "Bearer anything").expect(401);
    expect(res.body).toEqual({ error: "authentication_required" });
    expect(portfolio.getPortfolio).not.toHaveBeenCalled();
  });

  it("re-issues the 30-day session cookie on an authenticated response", async () => {
    const { app, store } = build();
    const cookie = await sessionCookieFor(store);
    const res = await (await loopbackRequest(app)).get("/api/portfolio").set("Cookie", cookie).expect(200);
    const set = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(set).toBeDefined();
    expect(set).toContain(`${SESSION_COOKIE}=${cookie.split("=")[1]}`);
    for (const part of ["Max-Age=2592000", "Path=/", "HttpOnly", "SameSite=Lax", "Secure"]) expect(set).toContain(part);
  });

  it("answers 503 session_unavailable, not 401 or a pass, when the session store throws", async () => {
    const { app, portfolio } = build({ sessions: { resolve: async () => { throw new Error("db down"); } } });
    const res = await (await loopbackRequest(app)).get("/api/portfolio").set("Cookie", `${SESSION_COOKIE}=abc`).expect(503);
    expect(res.body).toEqual({ error: "session_unavailable" });
    expect(portfolio.getPortfolio).not.toHaveBeenCalled();
  });

  it("treats two vl_session cookies as unauthenticated", async () => {
    const { app, store } = build();
    const one = await sessionCookieFor(store);
    const res = await (await loopbackRequest(app)).get("/api/portfolio").set("Cookie", `${one}; ${one}`).expect(401);
    expect(res.body).toEqual({ error: "authentication_required" });
  });

  it("GET /api/session reports signedIn without authentication", async () => {
    const { app, store } = build();
    const req = await loopbackRequest(app);
    expect((await req.get("/api/session").expect(200)).body).toEqual({ signedIn: false });
    expect((await req.get("/api/session").set("Cookie", "vl_session=bogus").expect(200)).body).toEqual({ signedIn: false });
    expect((await req.get("/api/session").set("Cookie", await sessionCookieFor(store)).expect(200)).body).toEqual({ signedIn: true });
  });

  it("mounts the owner routers even without a gateway, and names no authorization server", async () => {
    const ownerRouter = express.Router();
    ownerRouter.get("/login", (_request, response) => { response.status(200).send("login page"); });
    const app = createPortfolioApi({
      sessions: memoryOwnerSessions(),
      portfolio: { getPortfolio: vi.fn() },
      history: { getAccountHistory: vi.fn() },
      connections: { getConnections: vi.fn(), createConnectionPortal: vi.fn() },
      webhooks: { ingest: vi.fn() },
      appBaseUrl: APP,
      ownerRouters: [ownerRouter],
    } as never);
    const req = await loopbackRequest(app);
    expect((await req.get("/login").expect(200)).text).toBe("login page");
    expect((await req.get("/.well-known/oauth-protected-resource").expect(200)).body.authorization_servers).toEqual([]);
    expect((await req.get("/.well-known/oauth-protected-resource/mcp").expect(200)).body.authorization_servers).toEqual([]);
  });

  it("no longer serves /api/config", async () => {
    const { app } = build();
    const res = await (await loopbackRequest(app)).get("/api/config");
    expect(res.status).not.toBe(200);
  });
});
