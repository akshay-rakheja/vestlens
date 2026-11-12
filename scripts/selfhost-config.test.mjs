// The self-hosted line carries no hosted-service machinery: no Google Cloud, no vestlens.com call targets, no deploy
// workflow, and a root package.json and CI that only run what exists. Static checks over the working tree; no network.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

function walk(dir, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    if (["node_modules", "dist", "coverage", ".git", "test-results", "playwright-report"].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

test("R14: no vestlens.com address in app source, widgets, web metadata or the MCP plugin config", () => {
  const files = [
    ...walk("packages").filter((f) => /^packages\/[^/]+\/(src|gallery)\//.test(f) || f === "packages/web/index.html"),
    // The MCP plugin config lives in the private repository only; the public tree has no plugins/.
    ...(existsSync(join(root, "plugins")) ? walk("plugins") : []),
  ].filter((f) => !/\.(png|woff2?|snap)$/.test(f));
  assert.ok(files.length > 100, "the scan found the source tree");
  const found = [];
  for (const file of files) {
    read(file).split("\n").forEach((line, i) => {
      if (/vestlens\.com/i.test(line)) found.push({ file, line: i + 1, text: line.trim() });
    });
  }
  // Allowed: attribution text naming the project homepage (share-card footers, the plugin's homepage links and README
  // note). Never an address the app fetches, redirects to or tells a host to connect to.
  const attribution = (f) =>
    (f.file === "packages/web/src/ShareCard.tsx" && /^export const CARD_FOOTER = ".*vestlens\.com";$/.test(f.text)) ||
    (f.file === "packages/widgets/src/widgets/report-card/visual.ts" && /^export const SHARE_FOOTER = ".*vestlens\.com";$/.test(f.text)) ||
    (f.file === "plugins/vestlens/plugin.json" && /^"(homepage|websiteURL)": "https:\/\/vestlens\.com",?$/.test(f.text)) ||
    (f.file === "plugins/vestlens/README.md" && /Project home: https:\/\/vestlens\.com\.$/.test(f.text));
  assert.deepEqual(found.filter((f) => !attribution(f)), []);
  assert.deepEqual(found.filter((f) => /vestlens\.com\/(mcp|legal|api|og\.png|connect)/i.test(f.text)), []);
});

test("R14: source never calls vestlens.com (fetch, connect-src, CSP, redirect) and sets no analytics", () => {
  for (const file of walk("packages").filter((f) => /\/src\/.*\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))) {
    const text = read(file);
    assert.doesNotMatch(text, /(fetch|EventSource|WebSocket|sendBeacon|redirect|connect-src)[^\n]*vestlens\.com/i, file);
    assert.doesNotMatch(text, /googletagmanager|google-analytics|plausible\.io|posthog|segment\.(io|com)|mixpanel/i, file);
  }
});

test("the Google Cloud and hosted-deploy machinery is gone", () => {
  for (const path of ["infra", "cloudbuild.yaml", ".gcloudignore", ".github/workflows/deploy.yml", "packages/api/src/migrate-guard.ts", "packages/api/src/environment-database.ts"]) {
    assert.equal(existsSync(join(root, path)), false, path);
  }
  const workflows = readdirSync(join(root, ".github/workflows"));
  for (const name of workflows) {
    assert.doesNotMatch(read(`.github/workflows/${name}`), /gcloud|google-github-actions|workload_identity|id-token|run\.app|artifactregistry|cloud run/i, name);
  }
});

test("the root package.json only references files that exist, and npm test runs the kept script tests", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.test, "node --test scripts/*.test.mjs");
  for (const command of Object.values(pkg.scripts)) {
    for (const [, path] of command.matchAll(/(scripts\/[\w./-]+)/g)) {
      if (path.includes("*")) continue;
      assert.ok(existsSync(join(root, path)), path);
    }
  }
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /synthetic|infra|gcloud|deploy/i);
});

test("CI runs on selfhost and main pushes and pull requests only, and runs the package suites and script tests", () => {
  const ci = read(".github/workflows/ci.yml").split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  // One ci.yml serves both repositories: selfhost in the private one, main in the public one. In the private repository
  // pushes to main run main's own workflow, never this file (selfhost never reaches main: .githooks/pre-push).
  assert.match(ci, /^on:\n {2}push:\n {4}branches: \[selfhost, main\]\n {2}pull_request:\n/m);
  assert.doesNotMatch(ci, /workflow_call|workflow_dispatch|branches-ignore/);
  assert.doesNotMatch(ci, /infra\/|deploy|cloudbuild|permissions:\n(?:.*\n)*? {2}id-token/);
  for (const needle of ["npx vitest run", "npm run typecheck", "npm run prisma:validate", "npm run build", "node --test scripts/*.test.mjs"]) {
    assert.ok(ci.includes(needle), needle);
  }
});

test("CI steps that need private-only files are skipped when the file is absent (the public tree passes its own CI)", () => {
  const ci = read(".github/workflows/ci.yml");
  const privateOnly = ["scripts/publish-audit.py", "scripts/publish/"];
  const steps = ci.split(/\n(?= {6}- )/);
  let gated = 0;
  for (const step of steps) {
    for (const path of privateOnly) {
      const body = step.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
      if (!/^ {6}- /.test(step) || !body.includes(path)) continue;
      assert.match(body, new RegExp(`if: hashFiles\\('${path.replace(/[/.]/g, "\\$&")}[^']*'\\) != ''`), `${path} step is gated`);
      gated++;
    }
  }
  assert.ok(gated >= 2, "the publication audit and the publish-tool tests are gated");
});

test("the Dockerfile names no deleted file and no cloud target", () => {
  const dockerfile = read("Dockerfile");
  assert.doesNotMatch(dockerfile, /migrate-guard|ENVIRONMENT|auth0|cloud run|cloudbuild|gcloud/i);
  assert.match(dockerfile, /prisma", "migrate", "deploy"/);
  assert.match(dockerfile, /AS migrator/);
});

test("the container listens on all interfaces, and Compose still publishes the port on loopback only", () => {
  assert.match(read("Dockerfile"), /^ENV HOST=0\.0\.0\.0$/m);
  assert.match(read("docker-compose.yml"), /"127\.0\.0\.1:8080:8080"/);
  assert.doesNotMatch(read("docker-compose.yml"), /"8080:8080"|"0\.0\.0\.0:/);
});

test(".env.example documents every key the config reads, with placeholders only", () => {
  const example = read(".env.example");
  const required = ["APP_BASE_URL", "DATABASE_URL", "SNAPTRADE_CLIENT_ID", "SNAPTRADE_CONSUMER_KEY", "OWNER_PASSWORD_HASH", "SESSION_SECRET", "MCP_GATEWAY_SIGNING_KEY"];
  const optional = ["MCP_GATEWAY_PREVIOUS_SIGNING_KEY", "NEWS_ENABLED", "MARKETAUX_API_KEY", "MARKETAUX_DAILY_BUDGET", "TYPESAFE_API_KEY", "TYPESAFE_MODEL", "EDGAR_USER_AGENT", "WEBHOOKS_ENABLED", "TRUST_PROXY"];
  for (const key of [...required, ...optional]) assert.match(example, new RegExp(`^#? ?${key}=`, "m"), key);
  // The generated keys stay commented out, and say who generates them.
  for (const key of ["OWNER_PASSWORD_HASH", "SESSION_SECRET", "MCP_GATEWAY_SIGNING_KEY"]) {
    assert.match(example, new RegExp(`^# ${key}=.*npm run setup`, "m"), key);
    assert.doesNotMatch(example, new RegExp(`^${key}=`, "m"), key);
  }
  assert.match(example, /^DATABASE_URL=postgresql:\/\/vestlens:vestlens@db:5432\/vestlens\?connection_limit=5$/m);
  assert.match(example, /^APP_BASE_URL=http:\/\/localhost:8080$/m);
  assert.doesNotMatch(example, /^SNAPTRADE_BASE_PATH=|^# SNAPTRADE_BASE_PATH/m, "test-only, never documented as a setting");
  for (const gone of ["ENVIRONMENT", "WIDGET_LOADER", "AUTH0", "DASHBOARD_CLIENT_ID", "SNAPSHOT_INVOKER_EMAIL", "GOOGLE_"]) assert.doesNotMatch(example, new RegExp(gone));
  assert.doesNotMatch(example, /eyJ|sk-|BEGIN [A-Z ]*KEY/);
  // Every active (uncommented) value is a placeholder.
  for (const line of example.split("\n").filter((l) => /^[A-Z_]+=/.test(l))) {
    assert.match(line, /=(http:\/\/localhost:\d+|postgresql:\/\/vestlens:vestlens@db:5432\/vestlens\?connection_limit=5|your-[a-z-]+)$/, line.split("=")[0]);
  }
  assert.equal(existsSync(join(root, "packages/api/.env.example")), false, "the root .env.example is the only one");
});

test("the kept scripts exist and the deleted hosted-era ones do not", () => {
  for (const kept of ["setup.mjs", "setup.test.mjs", "compose-smoke.mjs", "portfolio-widget-lifecycle.test.mjs"]) {
    assert.ok(existsSync(join(root, "scripts", kept)), kept);
  }
  // Private-repository tooling (the SELFHOST marker is never published): the push guard and the publication audit.
  if (existsSync(join(root, "SELFHOST"))) {
    for (const kept of ["selfhost-guard.test.mjs", "publish-audit.py"]) assert.ok(existsSync(join(root, "scripts", kept)), kept);
  }
  for (const gone of ["verify-mini-synthetic.mjs", "synthetic-network-guard.cjs", "revoke-mcp-access.mjs", "release-smoke.sh", "prepare-host-package.mjs", "host-oauth-contract.mjs", "runbook-commands.test.mjs"]) {
    assert.equal(existsSync(join(root, "scripts", gone)), false, gone);
  }
  assert.ok(relative(root, root) === "");
});

test("docker-compose.yml: loopback port, the named volume, and nothing test-only; the smoke override holds that", () => {
  const compose = read("docker-compose.yml");
  assert.match(compose, /"127\.0\.0\.1:8080:8080"/);
  assert.match(compose, /image: postgres:16/);
  assert.match(compose, /vestlens-db:\/var\/lib\/postgresql\/data/);
  assert.match(compose, /target: migrator/);
  assert.match(compose, /target: production/);
  assert.match(compose, /service_completed_successfully/);
  assert.match(compose, /env_file: \$\{VESTLENS_ENV_FILE:-\.env\}/);
  assert.doesNotMatch(compose, /SNAPTRADE_BASE_PATH|NODE_ENV|host\.docker\.internal|extra_hosts/);
  const smoke = read("docker-compose.smoke.yml");
  for (const needle of ["SNAPTRADE_BASE_PATH", "NODE_ENV: test", "host.docker.internal:host-gateway"]) assert.ok(smoke.includes(needle), needle);
});
