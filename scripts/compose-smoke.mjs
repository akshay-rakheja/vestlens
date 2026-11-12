#!/usr/bin/env node
// Compose smoke test: builds and starts the real stack (db, migrate, app) against a fake SnapTrade served from this
// process, then checks health, sign-in, the portfolio read and the MCP gateway's refusal of an anonymous caller.
//
// Isolation: secrets come from `scripts/setup.mjs --dir <temp dir>` and live only in that directory, which Compose reads
// through `--env-file` and VESTLENS_ENV_FILE. A repo-root `.env` is never created, read or overwritten. The Compose
// project is throwaway and always torn down with `down -v --rmi local` (volume and the images it built). Fake SnapTrade data is synthetic and read-only: any
// non-GET request to it fails the test. Nothing secret is printed; the owner password is captured and never echoed.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Preconditions, checked before anything starts: the synthetic fixtures are TypeScript (Node type stripping, 22.18+) and the
// smoke override uses Compose's `!override` tag (2.24.4+).
const MIN_NODE = [22, 18, 0];
const MIN_COMPOSE = [2, 24, 4];
const versionAtLeast = (version, min) => {
  const parts = String(version).replace(/^v/, "").split(/[.-]/).map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < min.length; i += 1) {
    const have = Number.isFinite(parts[i]) ? parts[i] : 0;
    if (have !== min[i]) return have > min[i];
  }
  return true;
};
function requireTools() {
  if (!versionAtLeast(process.versions.node, MIN_NODE)) {
    console.error(`compose smoke needs Node ${MIN_NODE.join(".")} or newer (this is ${process.versions.node}).`);
    process.exit(2);
  }
  const compose = spawnSync("docker", ["compose", "version", "--short"], { encoding: "utf8" });
  const version = compose.status === 0 ? compose.stdout.trim() : "";
  if (!version || !versionAtLeast(version, MIN_COMPOSE)) {
    console.error(`compose smoke needs Docker Compose ${MIN_COMPOSE.join(".")} or newer (${version ? `this is ${version}` : "docker compose was not found"}).`);
    process.exit(2);
  }
}
requireTools();

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const COMPOSE_FILES = ["-f", join(ROOT, "docker-compose.yml"), "-f", join(ROOT, "docker-compose.smoke.yml")];
const STARTUP_TIMEOUT_MS = 180_000;

const suffix = randomBytes(4).toString("hex");
// R32: locally the project is vestlens-sdd-<random>; CI may use any name.
const project = process.env.CI ? `vestlens-smoke-${suffix}` : `vestlens-sdd-${suffix}`;

let passed = 0;
function check(name, condition) {
  if (!condition) throw new Error(`FAIL ${name}`);
  passed += 1;
  console.log(`PASS ${name}`);
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.once("error", rej);
    s.listen(0, "0.0.0.0", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

async function pickAppPort() {
  for (;;) {
    const port = await freePort();
    if (![5432, 54322, 8080].includes(port)) return port;
  }
}

// --- the synthetic SnapTrade ------------------------------------------------------------------------------------------
const { inventedAccountNumber, inventedFixture } = await import("../packages/api/src/testing/synthetic-fixtures.ts");

function syntheticAccounts() {
  const make = (id, name, rawType, unified, currency, total) => ({
    id,
    brokerage_authorization: inventedFixture(`${id}-connection`),
    name,
    number: inventedAccountNumber(id),
    institution_name: "Synthetic brokerage",
    raw_type: rawType,
    account_category: null,
    status: "open",
    is_paper: false,
    meta: { type: rawType, unified_account_type: unified },
    balance: { total: { amount: total, currency } },
    sync_status: {
      holdings: { initial_sync_completed: true, last_successful_sync: "2026-11-09T12:00:00.000Z", holdings_unavailable: false },
    },
  });
  return [
    make("synthetic-account-1", "Synthetic TFSA", "TFSA", "SELF_DIRECTED_TFSA", "CAD", 1234),
    make("synthetic-account-2", "Synthetic margin", "MARGIN", "SELF_DIRECTED_MARGIN", "USD", 567),
  ];
}

function startFakeSnapTrade() {
  const accounts = syntheticAccounts();
  const seen = { methods: new Set(), paths: [] };
  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://fake.invalid").pathname;
    seen.methods.add(method);
    seen.paths.push(`${method} ${path.replace(/synthetic-account-\d/, "<account>")}`);
    req.resume();
    if (method !== "GET") return json(res, 405, { detail: "read-only synthetic server" });
    if (path === "/accounts") return json(res, 200, accounts);
    const m = /^\/accounts\/([^/]+)(?:\/(balances|positions\/all))?$/.exec(path);
    const account = m && accounts.find((a) => a.id === m[1]);
    if (!account) return json(res, 200, []);
    const currency = account.balance.total.currency;
    if (!m[2]) return json(res, 200, account);
    if (m[2] === "balances") return json(res, 200, [{ currency: { code: currency }, cash: 10, buying_power: 10 }]);
    return json(res, 200, {
      results: [{
        instrument: { id: inventedFixture(`${account.id}-instrument`), kind: "stock", symbol: "SYNTH", description: "Synthetic position" },
        units: 3, price: 20, cost_basis: 18, currency, cash_equivalent: false,
      }],
      data_freshness: { as_of: "2026-11-09T12:00:00.000Z" },
    });
  });
  return new Promise((res, rej) => {
    server.once("error", rej);
    // All interfaces: the app container reaches the host through host.docker.internal.
    server.listen(0, "0.0.0.0", () => res({ server, seen, accounts, port: server.address().port }));
  });
}

// --- docker helpers ---------------------------------------------------------------------------------------------------
function compose(args, env, { capture = false } = {}) {
  const base = ["compose", "-p", project, ...COMPOSE_FILES, "--env-file", env.SMOKE_INTERPOLATION_FILE];
  return new Promise((res) => {
    const child = spawn("docker", [...base, ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"] });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("close", (code) => res({ code, out }));
  });
}

async function http(base, path, init = {}) {
  const res = await fetch(`${base}${path}`, { redirect: "manual", ...init });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
}

async function waitForHealth(base) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await http(base, "/health")).status === 200) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("FAIL the app did not become healthy in time");
}

// --- main -------------------------------------------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "vestlens-smoke-"));
let fake;
let env;
let failure = null;
let tornDown = false;
// Runs once, from `finally` or from a signal: removes the throwaway project and volume, the fake server and the temp dir.
async function teardown() {
  if (tornDown) return;
  tornDown = true;
  if (env) await compose(["down", "-v", "--rmi", "local", "--remove-orphans"], env);
  else spawnSync("docker", ["compose", "-p", project, "down", "-v", "--rmi", "local", "--remove-orphans"], { cwd: ROOT, stdio: "ignore" });
  fake?.server.close();
  rmSync(dir, { recursive: true, force: true });
}
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => {
    console.log(`${signal} received: tearing down`);
    teardown().finally(() => process.exit(code));
  });
}
const smokePassword = randomBytes(18).toString("base64url"); // synthetic; setup reads it from stdin and never prints it
try {
  // Setup refuses an .env without APP_BASE_URL and DATABASE_URL, so the smoke starts from one that has them (the real path).
  writeFileSync(join(dir, ".env"), "APP_BASE_URL=http://localhost:8080\nDATABASE_URL=postgresql://vestlens:vestlens@db:5432/vestlens?connection_limit=5\n", { mode: 0o600 });
  const setup = spawnSync(process.execPath, [join(ROOT, "scripts/setup.mjs"), "--dir", dir, "--password-stdin"], { encoding: "utf8", input: `${smokePassword}\n` });
  if (setup.status !== 0) throw new Error("FAIL setup.mjs did not complete");
  const password = smokePassword;

  const interpolationFile = join(dir, "interpolation.env");
  writeFileSync(interpolationFile, "VESTLENS_SMOKE=1\n");
  fake = await startFakeSnapTrade();
  const appPort = await pickAppPort();
  const base = `http://localhost:${appPort}`;
  appendFileSync(
    join(dir, ".env"),
    [
      `APP_BASE_URL=${base}`,
      "DATABASE_URL=postgresql://vestlens:vestlens@db:5432/vestlens?connection_limit=5",
      "SNAPTRADE_CLIENT_ID=synthetic-client-id",
      "SNAPTRADE_CONSUMER_KEY=synthetic-consumer-key",
      "",
    ].join("\n"),
  );
  env = {
    VESTLENS_ENV_FILE: join(dir, ".env"),
    // Compose interpolates from this harmless file, so it never parses the secrets file and never reads a repo-root .env.
    SMOKE_INTERPOLATION_FILE: interpolationFile,
    SMOKE_APP_PORT: String(appPort),
    SMOKE_SNAPTRADE_BASE_PATH: `http://host.docker.internal:${fake.port}`,
  };

  const up = await compose(["up", "-d", "--build"], env);
  if (up.code !== 0) throw new Error("FAIL docker compose up did not succeed");
  await waitForHealth(base);

  const health = await http(base, "/health");
  check("GET /health is 200", health.status === 200);

  const anon = await http(base, "/api/session");
  check("GET /api/session without a cookie is { signedIn: false }", anon.status === 200 && JSON.stringify(anon.json()) === '{"signedIn":false}');

  const login = await http(base, "/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base },
    body: new URLSearchParams({ password }).toString(),
  });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("vl_session="));
  check("POST /login with the setup password sets a session", login.status === 303 && Boolean(cookie));

  const wrong = await http(base, "/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base },
    body: new URLSearchParams({ password: "not-the-password" }).toString(),
  });
  check("POST /login with a wrong password is 401", wrong.status === 401);

  const session = await http(base, "/api/session", { headers: { Cookie: cookie } });
  check("GET /api/session with the cookie is { signedIn: true }", session.json().signedIn === true);

  const portfolio = await http(base, "/api/portfolio", { headers: { Cookie: cookie } });
  check("GET /api/portfolio is 200", portfolio.status === 200);
  const body = portfolio.json();
  // Counts and flags only: never print account contents.
  console.log(`info portfolio accounts=${body.accounts?.length} errors=${body.errors?.length ?? "n/a"} connectionRequired=${body.connectionRequired}; fake saw ${fake.seen.paths.length} requests`);
  check("GET /api/portfolio lists the synthetic accounts", body.accounts?.length === fake.accounts.length);

  const noCookie = await http(base, "/api/portfolio");
  check("GET /api/portfolio without a cookie is 401", noCookie.status === 401);

  const mcp = await http(base, "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check("POST /mcp without a bearer token is 401", mcp.status === 401);

  check("the fake SnapTrade was reached", fake.seen.paths.some((p) => p === "GET /accounts"));
  check("only read requests reached the fake SnapTrade", [...fake.seen.methods].every((m) => m === "GET"));
} catch (error) {
  failure = error;
  console.log(error instanceof Error && error.message.startsWith("FAIL") ? error.message : "FAIL unexpected error (see below)");
  if (env) {
    const logs = await compose(["logs", "--no-color", "--tail", "40", "migrate", "app"], env, { capture: true });
    // Service logs carry counts and codes only; shown on failure to make CI failures diagnosable.
    console.log(logs.out);
  }
  if (!(error instanceof Error && error.message.startsWith("FAIL"))) console.log(error?.name ?? "Error");
} finally {
  await teardown();
}

if (failure) {
  console.log(`compose smoke FAILED after ${passed} passing checks`);
  process.exit(1);
}
console.log(`compose smoke OK: ${passed} checks passed`);
process.exit(0);
