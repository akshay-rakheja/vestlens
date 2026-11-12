import express from "express";
import { describe, expect, it } from "vitest";
import { loopbackRequest } from "../testing/loopback-request.js";
import { SlidingWindowLimiter } from "../security/sliding-window.js";
import { hashOwnerPassword } from "./owner-password.js";
import { OwnerSessionStore } from "./owner-session.js";
import { clearSessionCookie, loginRouter, safeContinue, setSessionCookie } from "./login-routes.js";

function fakePrisma() {
  const rows = new Map<string, { id: string; lastSeenAt: Date; expiresAt: Date }>();
  return {
    rows,
    ownerSession: {
      create: async ({ data }: { data: { id: string; lastSeenAt: Date; expiresAt: Date } }) => { rows.set(data.id, data); return data; },
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      updateMany: async ({ where, data }: { where: { id: string }; data: object }) => { Object.assign(rows.get(where.id)!, data); return { count: 1 }; },
      deleteMany: async ({ where }: { where: { id?: string } }) => { if (where.id) rows.delete(where.id); return { count: 0 }; },
    },
  };
}

let cachedHash: Promise<string> | undefined;
const PASSWORD = "owner-password-for-tests";
const APP_ORIGIN = "https://vestlens.example.com";

async function build(opts: { secureCookies?: boolean; ipMax?: number } = {}) {
  cachedHash ??= hashOwnerPassword(PASSWORD);
  const prisma = fakePrisma();
  const sessions = new OwnerSessionStore({ prisma: prisma as never, secret: "t".repeat(43) });
  const app = express();
  app.use(loginRouter({
    sessions,
    passwordHash: await cachedHash,
    limiter: new SlidingWindowLimiter([{ ms: 15 * 60_000, max: opts.ipMax ?? 10 }]),
    secureCookies: opts.secureCookies ?? true,
    expectedOrigin: APP_ORIGIN,
  }));
  return { app, prisma, sessions };
}
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const post = async (app: express.Express, body: Record<string, string>) =>
  (await loopbackRequest(app)).post("/login").type("form").send(form(body));

describe("owner login", () => {
  it("sends Referrer-Policy same-origin on the page and the failed-login page, so a browser keeps Origin on the form post", async () => {
    const { app } = await build();
    const page = await (await loopbackRequest(app)).get("/login").expect(200);
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    const failed = await post(app, { password: "wrong-password" });
    expect(failed.status).toBe(401);
    expect(failed.headers["referrer-policy"]).toBe("same-origin");
  });

  it("still refuses Origin: null (what no-referrer pages send); the policy header is the fix, not a looser check", async () => {
    const { app } = await build();
    const res = await (await loopbackRequest(app)).post("/login").set("Origin", "null").type("form").send(form({ password: PASSWORD }));
    expect(res.status).toBe(403);
  });

  it("logs in, sets vl_session HttpOnly Secure SameSite=Lax, and redirects to continue", async () => {
    const { app, prisma, sessions } = await build();
    const res = await post(app, { password: PASSWORD, continue: "/authorize?x=1" });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/authorize?x=1");
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/^vl_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${30 * 86400}`);
    expect(prisma.rows.size).toBe(1);
    const token = /vl_session=([^;]+)/.exec(cookie)![1]!;
    expect(await sessions.resolve(token)).toBe(true);
  });

  it("omits Secure only when secureCookies is false", async () => {
    const { app } = await build({ secureCookies: false });
    const res = await post(app, { password: PASSWORD });
    expect(String(res.headers["set-cookie"])).not.toContain("Secure");
    expect(res.headers.location).toBe("/");
  });

  it("ignores off-site continue values", async () => {
    const { app } = await build();
    for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
      const res = await post(app, { password: PASSWORD, continue: bad });
      expect(res.status, bad).toBe(303);
      expect(res.headers.location, bad).toBe("/");
    }
  });

  it("re-renders the form with a generic message on a wrong password", async () => {
    const { app, prisma } = await build();
    const res = await post(app, { password: "nope", continue: "/a?b=1&c=2" });
    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.text).toContain("That password didn&#39;t work");
    expect(res.text).toContain('name="continue" value="/a?b=1&amp;c=2"');
    expect(prisma.rows.size).toBe(0);
    const missing = await post(app, {});
    expect(missing.status).toBe(401);
  });

  it("serves a private, escaped, asset-free form with a strict CSP", async () => {
    const { app } = await build();
    const res = await (await loopbackRequest(app)).get("/login").query({ continue: '/x"><script>alert(1)</script>' });
    expect(res.status).toBe(200);
    expect(res.text).toContain("private");
    expect(res.text).toContain('autocomplete="current-password"');
    expect(res.text).toMatch(/<label for="password"/);
    expect(res.text).not.toContain("<script");
    expect(res.text).not.toMatch(/https?:\/\//);
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("logout revokes the session, clears the cookie and redirects to /login", async () => {
    const { app, sessions } = await build();
    const login = await post(app, { password: PASSWORD });
    const token = /vl_session=([^;]+)/.exec(String(login.headers["set-cookie"]))![1]!;
    const res = await (await loopbackRequest(app)).post("/logout").set("Cookie", `vl_session=${token}`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/login");
    const cleared = String(res.headers["set-cookie"]);
    expect(cleared).toMatch(/^vl_session=;/);
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("Secure");
    expect(cleared).toContain("SameSite=Lax");
    expect(cleared).toContain("Path=/");
    expect(await sessions.resolve(token)).toBe(false);
  });

  it("locks out after 10 failures in 15 minutes per IP and 50 globally", async () => {
    const { app } = await build();
    for (let i = 0; i < 10; i += 1) expect((await post(app, { password: "wrong" })).status).toBe(401);
    const locked = await post(app, { password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.headers["set-cookie"]).toBeUndefined();
    expect(locked.text.length).toBeLessThan(200);
  });

  it("applies a global budget of 50 across all IPs", async () => {
    // Per-IP limiter generous, so only the global budget can trip; req.ip is the loopback address for all.
    const { app } = await build({ ipMax: 1000 });
    for (let i = 0; i < 50; i += 1) expect((await post(app, { password: "wrong" })).status).toBe(401);
    expect((await post(app, { password: PASSWORD })).status).toBe(429);
  }, 60_000);
});

describe("session cookie builders", () => {
  it("setSessionCookie sets 30-day Max-Age and the required attributes", () => {
    const headers: string[] = [];
    const res = { append: (_: string, v: string) => headers.push(v) } as never;
    setSessionCookie(res, "tok", { secure: true });
    clearSessionCookie(res, { secure: true });
    expect(headers[0]).toBe(`vl_session=tok; Max-Age=${30 * 86400}; Path=/; HttpOnly; SameSite=Lax; Secure`);
    expect(headers[1]).toBe("vl_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure");
    setSessionCookie(res, "tok", { secure: false });
    expect(headers[2]).not.toContain("Secure");
  });
});

describe("cross-site posts", () => {
  it("refuses Sec-Fetch-Site: cross-site and an Origin that is not APP_BASE_URL's on login and logout", async () => {
    const { app, prisma } = await build();
    for (const path of ["/login", "/logout"]) {
      const a = await (await loopbackRequest(app)).post(path).type("form").set("Sec-Fetch-Site", "cross-site")
        .send(form({ password: PASSWORD }));
      expect(a.status, path).toBe(403);
      const b = await (await loopbackRequest(app)).post(path).type("form").set("Host", "vestlens.test")
        .set("Origin", "https://evil.example").send(form({ password: PASSWORD }));
      expect(b.status, path).toBe(403);
      // An Origin that merely matches the Host header is not enough: the expected origin is APP_BASE_URL's.
      const c = await (await loopbackRequest(app)).post(path).type("form").set("Host", "vestlens.test")
        .set("Origin", "http://vestlens.test").send(form({ password: PASSWORD }));
      expect(c.status, path).toBe(403);
      // Cross-site wins even when the Origin matches.
      const d = await (await loopbackRequest(app)).post(path).type("form").set("Origin", APP_ORIGIN)
        .set("Sec-Fetch-Site", "cross-site").send(form({ password: PASSWORD }));
      expect(d.status, path).toBe(403);
    }
    expect(prisma.rows.size).toBe(0);
  });

  it("accepts an Origin equal to APP_BASE_URL's origin even when Host is a proxy-internal name", async () => {
    const { app } = await build();
    const ok = await (await loopbackRequest(app)).post("/login").type("form").set("Host", "vestlens-app:8080")
      .set("Origin", APP_ORIGIN).set("Sec-Fetch-Site", "same-origin").send(form({ password: PASSWORD }));
    expect(ok.status).toBe(303);
    const noOrigin = await (await loopbackRequest(app)).post("/login").type("form").send(form({ password: PASSWORD }));
    expect(noOrigin.status).toBe(303);
  });
});

describe("safeContinue", () => {
  it("accepts same-origin paths", () => {
    expect(safeContinue("/")).toBe("/");
    expect(safeContinue("/ok/path?x=1")).toBe("/ok/path?x=1");
  });
  it("rejects everything else", () => {
    for (const bad of [
      "//evil.example", "/\\evil.example", "https://evil.example", "evil", "", "/a\\b", "/a\u0000b", "/a\nb", "/a\u007fb",
      undefined, null, 5, ["/ok"], {},
    ]) expect(safeContinue(bad), String(bad)).toBe("/");
  });
});
