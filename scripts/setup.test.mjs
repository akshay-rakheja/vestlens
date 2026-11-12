import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createPublicKey, createHash, sign, verify } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SETUP = resolve(import.meta.dirname, "setup.mjs");

/** Plain `npm run setup` with piped (non-terminal) stdio: what an AI agent's shell gives it. */
function run(dir) {
  return spawnSync(process.execPath, [SETUP, "--dir", dir], { encoding: "utf8" });
}
/** A successful first-time setup through the non-interactive path (the password is the human's, never generated). */
function runOk(dir) {
  return spawnSync(process.execPath, [SETUP, "--dir", dir, "--password-stdin"], { encoding: "utf8", input: "a-fixed-test-password\n" });
}
/** Runs setup under a pseudo-terminal (stdin and stdout are TTYs), optionally typing `typed` once output appears. */
function runPty(args, typed = "") {
  const code = `import os,pty,sys,time
pid,fd=pty.fork()
if pid==0:
    os.execv(sys.argv[1],[sys.argv[1],sys.argv[2]]+sys.argv[4:])
typed=sys.argv[3]
out=b""
sent=False
while True:
    try:
        d=os.read(fd,4096)
    except OSError:
        break
    if not d: break
    out+=d
    if typed and not sent:
        sent=True
        time.sleep(0.2)
        os.write(fd,typed.encode())
_,st=os.waitpid(pid,0)
sys.stdout.write(out.decode(errors="replace"))
sys.exit(os.waitstatus_to_exitcode(st))`;
  return spawnSync("python3", ["-c", code, process.execPath, SETUP, typed, ...args], { encoding: "utf8", timeout: 20000 });
}
const hasPty = spawnSync("python3", ["-c", "import pty"], { encoding: "utf8" }).status === 0;
/** dotenv/Compose rule: single-quoted values are literal; plain values are unquoted. */
function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].startsWith("'") && m[2].endsWith("'") ? m[2].slice(1, -1) : m[2];
  }
  return out;
}

test("setup writes generated secrets once and never overwrites", { skip: !hasPty && "python3 pty not available" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-setup-"));
  try {
    const first = runPty(["--dir", dir]);
    assert.equal(first.status, 0, first.stdout);
    const envPath = join(dir, ".env");
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
    const text = readFileSync(envPath, "utf8");
    const env = parseEnv(text);

    // Quoted in the file so Compose does not expand the `$` separators.
    assert.match(text, /^OWNER_PASSWORD_HASH='scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+'$/m);
    assert.match(env.OWNER_PASSWORD_HASH, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    assert.equal(Buffer.from(env.SESSION_SECRET, "base64url").length, 32);
    assert.match(env.SESSION_SECRET, /^[A-Za-z0-9_-]{43}$/);
    assert.match(text, /^MCP_GATEWAY_SIGNING_KEY='\{.*\}'$/m);
    const jwk = JSON.parse(env.MCP_GATEWAY_SIGNING_KEY);
    assert.equal(jwk.kty, "EC");
    assert.equal(jwk.crv, "P-256");
    for (const f of ["x", "y", "d", "kid"]) assert.ok(typeof jwk[f] === "string" && jwk[f].length > 0, f);
    const thumb = createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest("base64url");
    assert.equal(jwk.kid, thumb);
    // The private key is a usable ES256 key pair.
    const pub = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: "jwk" });
    const sig = sign("sha256", Buffer.from("m"), { key: jwk, format: "jwk", dsaEncoding: "ieee-p1363" });
    assert.ok(verify("sha256", Buffer.from("m"), { key: pub, dsaEncoding: "ieee-p1363" }, sig));

    // Password: printed once, 24 base64url characters, and it is the one that was hashed.
    const printed = first.stdout.match(/[A-Za-z0-9_-]{24}(?![A-Za-z0-9_-])/g) ?? [];
    assert.equal(printed.length, 1);
    assert.match(first.stdout, /store/i);
    for (const secret of [env.SESSION_SECRET, env.OWNER_PASSWORD_HASH, jwk.d]) {
      assert.ok(!first.stdout.includes(secret) && !first.stderr.includes(secret));
    }

    const second = run(dir);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /already set up/);
    assert.equal(readFileSync(envPath, "utf8"), text);
    assert.ok(!second.stdout.includes(printed[0]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup tightens a 0644 .env, keeps its contents, and honours an export prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-setup-"));
  const dir2 = mkdtempSync(join(tmpdir(), "vestlens-setup-"));
  try {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "export SESSION_SECRET=abc\n");
    chmodSync(envPath, 0o644);
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /already set up/);
    assert.match(r.stdout, /0600/);
    assert.equal(readFileSync(envPath, "utf8"), "export SESSION_SECRET=abc\n");
    assert.equal(statSync(envPath).mode & 0o777, 0o600);

    // Appending to a pre-existing 0644 file that holds none of the keys also ends at 0600.
    const p2 = join(dir2, ".env");
    writeFileSync(p2, "OTHER=1\nAPP_BASE_URL=http://localhost:8080\nDATABASE_URL=postgresql://synthetic:synthetic@db:5432/x\n");
    chmodSync(p2, 0o644);
    assert.equal(runOk(dir2).status, 0);
    assert.equal(statSync(p2).mode & 0o777, 0o600);
    assert.match(readFileSync(p2, "utf8"), /^OTHER=1\nAPP_BASE_URL=.*\nDATABASE_URL=.*\nOWNER_PASSWORD_HASH=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

// --reset-password: only ever run against a temp directory passed with --dir.
function reset(dir, password, extra = []) {
  const viaStdin = password !== undefined && password !== "" && !extra.includes("--password-stdin");
  return spawnSync(process.execPath, [SETUP, "--dir", dir, "--reset-password", ...(viaStdin ? ["--password-stdin"] : []), ...extra], {
    encoding: "utf8",
    input: password === undefined ? "" : `${password}\n`,
  });
}

function seeded(dir, mode = 0o600) {
  const text = [
    "# my notes: keep this line",
    "APP_BASE_URL=http://localhost:8080",
    "DATABASE_URL=postgresql://vestlens:vestlens@db:5432/vestlens?connection_limit=5",
    "OWNER_PASSWORD_HASH='scrypt$32768$8$1$OLDSALT$OLDHASH'",
    "",
    "SNAPTRADE_CONSUMER_KEY=consumer-key-placeholder",
    "SESSION_SECRET=oldsecretoldsecretoldsecretoldsecretoldsecret1",
    "MCP_GATEWAY_SIGNING_KEY='{\"kty\":\"EC\",\"d\":\"old-private\"}'",
    "TRUST_PROXY=1",
    "",
  ].join("\n");
  const envPath = join(dir, ".env");
  writeFileSync(envPath, text);
  chmodSync(envPath, mode);
  return { envPath, text };
}

test("--reset-password rewrites only OWNER_PASSWORD_HASH and SESSION_SECRET, byte for byte elsewhere, at 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-reset-"));
  try {
    const { envPath, text } = seeded(dir, 0o644);
    const r = reset(dir, "a-new-password-for-tests");
    assert.equal(r.status, 0, r.stderr);
    const after = readFileSync(envPath, "utf8");
    assert.equal(statSync(envPath).mode & 0o777, 0o600);

    const before = text.split("\n");
    const now = after.split("\n");
    assert.equal(now.length, before.length);
    const changed = now.map((line, i) => (line === before[i] ? null : i)).filter((i) => i !== null);
    assert.deepEqual(changed.map((i) => before[i].split("=")[0]), ["OWNER_PASSWORD_HASH", "SESSION_SECRET"]);

    // Same positions, same quoting rules as first-run setup: the hash is single-quoted so Compose does not expand `$`.
    assert.match(after, /^OWNER_PASSWORD_HASH='scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+'$/m);
    assert.match(after, /^SESSION_SECRET=[A-Za-z0-9_-]{43}$/m);
    assert.notEqual(parseEnv(after).SESSION_SECRET, parseEnv(text).SESSION_SECRET);
    // The gateway signing key is untouched, so connected AI apps keep working.
    assert.match(after, /^MCP_GATEWAY_SIGNING_KEY='\{"kty":"EC","d":"old-private"\}'$/m);
    assert.ok(after.startsWith("# my notes: keep this line\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--reset-password hashes the password it was given and never prints a secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-reset-"));
  try {
    const { envPath } = seeded(dir);
    const password = "correct horse battery staple";
    const r = reset(dir, password);
    assert.equal(r.status, 0, r.stderr);
    const env = parseEnv(readFileSync(envPath, "utf8"));
    const [, n, rr, p, salt, hash] = env.OWNER_PASSWORD_HASH.split("$");
    const { scryptSync } = await import("node:crypto");
    const derived = scryptSync(password.normalize("NFKC"), Buffer.from(salt, "base64url"), 32, { N: Number(n), r: Number(rr), p: Number(p), maxmem: 64 * 1024 * 1024 });
    assert.equal(derived.toString("base64url"), hash);
    for (const secret of [password, env.SESSION_SECRET, env.OWNER_PASSWORD_HASH]) {
      assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
    }
    assert.match(r.stdout, /docker compose up -d/);
    assert.match(r.stdout, /signed out/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--reset-password with an empty answer generates a password and prints it once (in a real terminal)", { skip: !hasPty && "python3 pty not available" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-reset-"));
  try {
    const { envPath } = seeded(dir);
    const r = runPty(["--dir", dir, "--reset-password"], "\r");
    assert.equal(r.status, 0, r.stdout);
    const printed = r.stdout.match(/[A-Za-z0-9_-]{24}(?![A-Za-z0-9_-])/g) ?? [];
    assert.equal(printed.length, 1);
    assert.match(readFileSync(envPath, "utf8"), /^OWNER_PASSWORD_HASH='scrypt\$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--reset-password refuses a short password and changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-reset-"));
  try {
    const { envPath, text } = seeded(dir);
    const r = reset(dir, "short");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /at least 12/);
    assert.equal(readFileSync(envPath, "utf8"), text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--reset-password needs an existing setup, and plain setup still refuses to overwrite", () => {
  const empty = mkdtempSync(join(tmpdir(), "vestlens-reset-"));
  const dir = mkdtempSync(join(tmpdir(), "vestlens-reset-"));
  try {
    const none = reset(empty, "a-new-password-for-tests");
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /run `npm run setup` first/i);
    assert.throws(() => readFileSync(join(empty, ".env")), /ENOENT/);

    const { envPath, text } = seeded(dir);
    const plain = run(dir);
    assert.equal(plain.status, 0);
    assert.match(plain.stdout, /already set up/);
    assert.match(plain.stdout, /--reset-password/);
    assert.equal(readFileSync(envPath, "utf8"), text);
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--reset-password adds a missing SESSION_SECRET and keeps CRLF line endings and an export prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-reset-"));
  try {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "export OWNER_PASSWORD_HASH='scrypt$1$1$1$a$b'\r\nOTHER=1\r\n", { mode: 0o600 });
    const r = reset(dir, "a-new-password-for-tests");
    assert.equal(r.status, 0, r.stderr);
    const after = readFileSync(envPath, "utf8");
    assert.match(after, /^export OWNER_PASSWORD_HASH='scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+'\r\nOTHER=1\r\nSESSION_SECRET=[A-Za-z0-9_-]{43}\r\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --password-stdin: the non-interactive path for scripts and AI agents. The human picks the password; one line on stdin.
function withStdin(dir, input, extra) {
  return spawnSync(process.execPath, [SETUP, "--dir", dir, ...extra, "--password-stdin"], { encoding: "utf8", input });
}

async function verifies(envText, password) {
  const [, n, r, p, salt, hash] = parseEnv(envText).OWNER_PASSWORD_HASH.split("$");
  const { scryptSync } = await import("node:crypto");
  return scryptSync(password.normalize("NFKC"), Buffer.from(salt, "base64url"), 32, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 }).toString("base64url") === hash;
}

test("first-time setup --password-stdin uses the given password and never prints it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-pwstdin-"));
  try {
    const password = "chosen by the human 123";
    const r = withStdin(dir, `${password}\n`, []);
    assert.equal(r.status, 0, r.stderr);
    const envPath = join(dir, ".env");
    const text = readFileSync(envPath, "utf8");
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
    assert.match(text, /^OWNER_PASSWORD_HASH='scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+'$/m);
    assert.match(text, /^MCP_GATEWAY_SIGNING_KEY='\{.*\}'$/m);
    assert.ok(await verifies(text, password));
    assert.ok(!r.stdout.includes(password) && !r.stderr.includes(password));
    assert.doesNotMatch(r.stdout, /[A-Za-z0-9_-]{24}(?![A-Za-z0-9_-])/);
    assert.match(r.stdout, /setup complete/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-time setup --password-stdin refuses a short or empty password and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-pwstdin-"));
  try {
    for (const input of ["short\n", "\n", ""]) {
      const r = withStdin(dir, input, []);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /at least 12/);
      assert.throws(() => readFileSync(join(dir, ".env")), /ENOENT/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--reset-password --password-stdin sets the given password, keeps the other lines, and enforces the minimum", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-pwstdin-"));
  try {
    const { envPath, text } = seeded(dir);
    const password = "another chosen password";
    const r = withStdin(dir, `${password}\n`, ["--reset-password"]);
    assert.equal(r.status, 0, r.stderr);
    const after = readFileSync(envPath, "utf8");
    assert.ok(await verifies(after, password));
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
    assert.match(after, /^MCP_GATEWAY_SIGNING_KEY='\{"kty":"EC","d":"old-private"\}'$/m);
    assert.match(after, /^TRUST_PROXY=1$/m);
    assert.ok(!r.stdout.includes(password) && !r.stderr.includes(password));
    assert.doesNotMatch(r.stdout, /New owner password/);

    // An empty line is not a request to generate one: it is rejected, and nothing changes.
    const again = withStdin(dir, "\n", ["--reset-password"]);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /at least 12/);
    assert.equal(readFileSync(envPath, "utf8"), after);
    const short = withStdin(dir, "short\n", ["--reset-password"]);
    assert.notEqual(short.status, 0);
    assert.equal(readFileSync(envPath, "utf8"), after);
    assert.notEqual(after, text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--password-stdin refuses an interactive terminal and points to plain setup", (t) => {
  const py = spawnSync("python3", ["-c", "import pty"], { encoding: "utf8" });
  if (py.status !== 0) return t.skip("python3 pty not available");
  const dir = mkdtempSync(join(tmpdir(), "vestlens-pwstdin-"));
  try {
    // Run under a pseudo-terminal so process.stdin.isTTY is true.
    const code = `import os,pty,sys
pid,fd=pty.fork()
if pid==0:
    os.execv(sys.argv[1],[sys.argv[1],sys.argv[2],"--dir",sys.argv[3],"--password-stdin"])
out=b""
while True:
    try:
        d=os.read(fd,4096)
    except OSError:
        break
    if not d: break
    out+=d
_,st=os.waitpid(pid,0)
sys.stdout.write(out.decode(errors="replace"))
sys.exit(os.waitstatus_to_exitcode(st))`;
    const r = spawnSync("python3", ["-c", code, process.execPath, SETUP, dir], { encoding: "utf8", timeout: 15000 });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /npm run setup/);
    assert.match(r.stdout, /pipe/i);
    assert.throws(() => readFileSync(join(dir, ".env")), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--password-stdin on an already set-up .env fails loudly and changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-pwstdin-"));
  try {
    const { envPath, text } = seeded(dir);
    const r = withStdin(dir, "a password the human chose\n", []);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /NOT applied/);
    assert.match(r.stderr, /--reset-password --password-stdin/);
    assert.equal(readFileSync(envPath, "utf8"), text);
    assert.ok(!r.stdout.includes("a password the human chose") && !r.stderr.includes("a password the human chose"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Task 14b: first-run fixes -------------------------------------------------------------------------------------------

test("setup with no .env seeds it from .env.example (comments kept), adds the secrets, and warns about placeholder SnapTrade keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-seed-"));
  try {
    const r = runOk(dir);
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(join(dir, ".env"), "utf8");
    assert.match(text, /^# --- Required ---$/m);
    assert.match(text, /^APP_BASE_URL=http:\/\/localhost:8080$/m);
    assert.match(text, /^DATABASE_URL=postgresql:\/\/.+@db:5432\//m);
    assert.match(text, /^OWNER_PASSWORD_HASH='scrypt\$/m);
    assert.match(text, /^SESSION_SECRET=[A-Za-z0-9_-]{43}$/m);
    assert.match(text, /^MCP_GATEWAY_SIGNING_KEY='\{/m);
    assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
    assert.match(r.stdout, /created \.env from \.env\.example/i);
    // Placeholders: named, never echoed.
    assert.match(r.stdout, /SNAPTRADE_CLIENT_ID/);
    assert.match(r.stdout, /SNAPTRADE_CONSUMER_KEY/);
    assert.doesNotMatch(r.stdout + r.stderr, /your-snaptrade-client-id|your-snaptrade-consumer-key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup refuses an .env that lacks APP_BASE_URL or DATABASE_URL, names them with the example lines, and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-missing-"));
  try {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "SNAPTRADE_CLIENT_ID=abc\n", { mode: 0o600 });
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /APP_BASE_URL/);
    assert.match(r.stderr, /DATABASE_URL/);
    assert.match(r.stderr, /APP_BASE_URL=http:\/\/localhost:8080/);
    assert.match(r.stderr, /DATABASE_URL=postgresql:\/\/vestlens:vestlens@db:5432\/vestlens\?connection_limit=5/);
    assert.match(r.stderr, /cp \.env\.example \.env/);
    assert.equal(readFileSync(envPath, "utf8"), "SNAPTRADE_CLIENT_ID=abc\n");
    assert.doesNotMatch(r.stdout, /Owner password:/);

    // Only one missing: only that one is named.
    writeFileSync(envPath, "APP_BASE_URL=http://localhost:8080\n");
    const one = run(dir);
    assert.notEqual(one.status, 0);
    assert.match(one.stderr, /DATABASE_URL/);
    assert.doesNotMatch(one.stderr, /^.*APP_BASE_URL=http.*$/m);
    assert.equal(readFileSync(envPath, "utf8"), "APP_BASE_URL=http://localhost:8080\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup warns, without failing or printing values, when SnapTrade keys are missing or placeholders; stays quiet when set", () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-warn-"));
  const dir2 = mkdtempSync(join(tmpdir(), "vestlens-warn-"));
  try {
    const base = "APP_BASE_URL=http://localhost:8080\nDATABASE_URL=postgresql://synthetic:synthetic@db:5432/x\n";
    writeFileSync(join(dir, ".env"), `${base}SNAPTRADE_CLIENT_ID=real-looking-id-1234\n`);
    const r = runOk(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SNAPTRADE_CONSUMER_KEY/);
    assert.doesNotMatch(r.stdout, /SNAPTRADE_CLIENT_ID/);
    assert.ok(!r.stdout.includes("real-looking-id-1234") && !r.stderr.includes("real-looking-id-1234"));

    writeFileSync(join(dir2, ".env"), `${base}SNAPTRADE_CLIENT_ID=real-looking-id-1234\nSNAPTRADE_CONSUMER_KEY=real-looking-key-5678\n`);
    const ok = runOk(dir2);
    assert.equal(ok.status, 0, ok.stderr);
    assert.doesNotMatch(ok.stdout, /SNAPTRADE_/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("generated password output says it is shown once and the .env hash will not work as a password", { skip: !hasPty && "python3 pty not available" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-once-"));
  try {
    const r = runPty(["--dir", dir]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /only time the password is shown/i);
    assert.match(r.stdout, /OWNER_PASSWORD_HASH/);
    assert.match(r.stdout, /hash, which will not work as a password/i);
    assert.match(r.stdout, /password manager/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--password-stdin with empty stdin or EOF fails with a message that says nothing was received and where to run it", () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-empty-"));
  try {
    for (const input of ["", "\n"]) {
      const first = withStdin(dir, input, []);
      assert.notEqual(first.status, 0);
      assert.match(first.stderr, /no password was received/i);
      assert.match(first.stderr, /terminal/i);
      assert.throws(() => readFileSync(join(dir, ".env")), /ENOENT/);
    }
    const { envPath, text } = seeded(dir);
    const again = withStdin(dir, "", ["--reset-password"]);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /no password was received/i);
    assert.equal(readFileSync(envPath, "utf8"), text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plain setup without a terminal refuses, writes nothing and never generates or prints a password", () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-nontty-"));
  try {
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /real terminal/i);
    assert.match(r.stderr, /read -rs OWNER_PASSWORD/);
    assert.doesNotMatch(r.stdout + r.stderr, /[A-Za-z0-9_-]{24}(?![A-Za-z0-9_-])/);
    assert.throws(() => readFileSync(join(dir, ".env")), /ENOENT/);

    // An existing .env that has the required lines but no owner setup is left untouched too.
    const envPath = join(dir, ".env");
    const text = "APP_BASE_URL=http://localhost:8080\nDATABASE_URL=postgresql://synthetic:synthetic@db:5432/x\n";
    writeFileSync(envPath, text);
    const again = run(dir);
    assert.notEqual(again.status, 0);
    assert.equal(readFileSync(envPath, "utf8"), text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--reset-password without --password-stdin and without a terminal refuses and changes nothing, even with an empty answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-nontty-"));
  try {
    const { envPath, text } = seeded(dir);
    for (const input of ["", "\n", "a typed password 123\n"]) {
      const r = spawnSync(process.execPath, [SETUP, "--dir", dir, "--reset-password"], { encoding: "utf8", input });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /real terminal/i);
      assert.doesNotMatch(r.stdout + r.stderr, /[A-Za-z0-9_-]{24}(?![A-Za-z0-9_-])/);
      assert.equal(readFileSync(envPath, "utf8"), text);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the setup refusal for a missing .env line tells the reader to adjust the port if they changed it", () => {
  const dir = mkdtempSync(join(tmpdir(), "vestlens-port-"));
  try {
    writeFileSync(join(dir, ".env"), "OTHER=1\n");
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\(adjust the port if you changed it\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
