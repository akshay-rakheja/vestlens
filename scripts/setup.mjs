#!/usr/bin/env node
// First-run setup: writes OWNER_PASSWORD_HASH, SESSION_SECRET and MCP_GATEWAY_SIGNING_KEY to .env (mode 0600).
// Prints the generated owner password once. Never overwrites an existing setup.
//
// With no .env it first creates one from .env.example (comments kept). An existing .env must already hold APP_BASE_URL and
// DATABASE_URL, or setup stops and says which lines to copy. A missing or placeholder SnapTrade key only draws a warning
// (key names, never values).
//
// `--reset-password` is the way back from a forgotten or leaked password: it asks for a new one (Enter generates one) and
// rewrites only OWNER_PASSWORD_HASH and SESSION_SECRET in the existing .env. Rotating SESSION_SECRET signs every browser out.
// MCP_GATEWAY_SIGNING_KEY is kept, so AI apps that were already connected stay connected.
//
// `--password-stdin` (first-time setup or `--reset-password`) is the non-interactive path for scripts and AI agents: it reads
// one line from stdin as the owner password the human chose, enforces the same 12-character minimum, never echoes it, and
// never generates one. Without the flag nothing changes.
import { createHash, generateKeyPairSync, randomBytes, scrypt } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KEYS = ["OWNER_PASSWORD_HASH", "SESSION_SECRET", "MCP_GATEWAY_SIGNING_KEY"];

function argDir() {
  const i = process.argv.indexOf("--dir");
  return i > 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

// Same format as packages/api/src/auth/owner-password.ts: scrypt$N$r$p$salt$hash (base64url), N=2^15, r=8, p=1.
function hashPassword(password) {
  const salt = randomBytes(16);
  return new Promise((res, rej) =>
    scrypt(password.normalize("NFKC"), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? rej(err) : res(["scrypt", 1 << 15, 8, 1, salt.toString("base64url"), key.toString("base64url")].join("$")),
    ),
  );
}

function signingKey() {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
  // RFC 7638 thumbprint over the canonical required members.
  const kid = createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest("base64url");
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d, kid };
}

const MIN_PASSWORD_LENGTH = 12;
const PASSWORD_FROM_STDIN = process.argv.includes("--password-stdin");
if (PASSWORD_FROM_STDIN && process.stdin.isTTY) {
  // A terminal would echo what is typed. Refuse rather than read the password in the clear.
  console.error("--password-stdin needs the password piped in, not typed here (a terminal would show it).");
  console.error("Run plain `npm run setup` for the hidden prompt, or: read -rs OWNER_PASSWORD && printf '%s\\n' \"$OWNER_PASSWORD\" | npm run setup -- --password-stdin");
  process.exit(1);
}

/** The one line on stdin, for --password-stdin. Empty and short passwords are refused: nothing is generated in this mode. */
async function readStdinPassword() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const password = Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
  if (password.trim() === "") {
    fail(
      "No password was received on stdin (it was empty or closed; the password must be at least 12 characters). Nothing was changed.\n" +
        "This needs a real terminal (the Terminal app, from the folder you cloned into) where you can type at the hidden prompt: " +
        "a chat box or an agent's command box has no keyboard input. Run plain `npm run setup` there, or: " +
        "read -rs OWNER_PASSWORD && printf '%s\\n' \"$OWNER_PASSWORD\" | npm run setup -- --password-stdin",
    );
  }
  if (password.length < MIN_PASSWORD_LENGTH) fail(`The password must be at least ${MIN_PASSWORD_LENGTH} characters. Nothing was changed.`);
  return password;
}

/**
 * Without --password-stdin, setup may generate a password and print it. That must only ever reach a person at a real terminal,
 * never an AI agent's captured output or a log, so a non-terminal stdin or stdout is refused before anything is written.
 */
function requireTerminal() {
  if (PASSWORD_FROM_STDIN || (process.stdin.isTTY && process.stdout.isTTY)) return;
  fail(
    "Setup was not run from a real terminal, so it stopped and changed nothing: it would have to print the owner password where a chat or an AI tool can see it.\n" +
      "Run it in a real terminal (the Terminal app), from the folder you cloned into, and choose your own password at the hidden prompt:\n" +
      "  read -rs OWNER_PASSWORD && printf '%s\\n' \"$OWNER_PASSWORD\" | npm run setup -- --password-stdin; unset OWNER_PASSWORD\n" +
      "(To reset an existing password, add --reset-password before --password-stdin.) Or run plain `npm run setup` there to have one generated.",
  );
}

/** One line from stdin when it is piped; with a terminal, a hidden prompt (the answer is never echoed). */
async function readPassword(prompt) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return await new Promise((resolveLine, reject) => {
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolveLine(value);
          return;
        }
        if (ch === "\u0003") {
          process.stdin.setRawMode(false);
          reject(new Error("cancelled"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const keyLine = (key) => new RegExp(`^(\\s*(?:export\\s+)?)${key}=`);

async function resetPassword(path) {
  if (!existsSync(path)) fail("No .env here: run `npm run setup` first.");
  const text = readFileSync(path, "utf8");
  if (!text.split("\n").some((line) => keyLine("OWNER_PASSWORD_HASH").test(line))) {
    fail("This .env has no owner setup: run `npm run setup` first.");
  }
  requireTerminal();
  let password = PASSWORD_FROM_STDIN ? await readStdinPassword() : await readPassword("New owner password (at least 12 characters; Enter generates one): ");
  let generated = false;
  if (password === "") {
    password = randomBytes(18).toString("base64url");
    generated = true;
  } else {
    if (password.length < MIN_PASSWORD_LENGTH) fail(`The password must be at least ${MIN_PASSWORD_LENGTH} characters. Nothing was changed.`);
    if (!PASSWORD_FROM_STDIN && process.stdin.isTTY && (await readPassword("Type it again: ")) !== password) fail("The two entries differ. Nothing was changed.");
  }
  const replacements = {
    // Single-quoted: the hash contains `$`, which Docker Compose would otherwise read as a variable reference.
    OWNER_PASSWORD_HASH: `'${await hashPassword(password)}'`,
    SESSION_SECRET: randomBytes(32).toString("base64url"),
  };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split("\n");
  const done = new Set();
  const out = lines.map((line) => {
    for (const [key, value] of Object.entries(replacements)) {
      const m = keyLine(key).exec(line);
      if (m) {
        done.add(key);
        return `${m[1]}${key}=${value}${line.endsWith("\r") ? "\r" : ""}`;
      }
    }
    return line;
  });
  let result = out.join("\n");
  for (const [key, value] of Object.entries(replacements)) {
    if (done.has(key)) continue;
    result += `${result === "" || result.endsWith("\n") ? "" : eol}${key}=${value}${eol}`;
  }
  // Write beside the file and rename over it, so an interrupted write never leaves a half-written .env.
  const tmp = `${path}.reset-${process.pid}`;
  writeFileSync(tmp, result, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  console.log("Owner password reset. Only OWNER_PASSWORD_HASH and SESSION_SECRET changed in .env.");
  console.log("");
  if (generated) {
    console.log(`New owner password: ${password}`);
    console.log("");
    console.log("This is the only time the password is shown. .env keeps only a hash, which will not work as a password. Store it in your password manager now.");
    console.log("");
  }
  console.log("Everyone is signed out once the app restarts: run `docker compose up -d` to recreate the container with the new settings.");
  console.log("AI apps that were already connected stay connected. To disconnect them, revoke them on the Account page.");
}

const envPath = join(argDir(), ".env");
if (process.argv.includes("--reset-password")) {
  await resetPassword(envPath);
  process.exit(0);
}
const REQUIRED = ["APP_BASE_URL", "DATABASE_URL"];
const SNAPTRADE_KEYS = ["SNAPTRADE_CLIENT_ID", "SNAPTRADE_CONSUMER_KEY"];
const examplePath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.example");
const exampleText = existsSync(examplePath) ? readFileSync(examplePath, "utf8") : "";

/** The value on the last non-comment `KEY=value` line (Compose reads the last one), unquoted; null when there is none. */
function envValue(text, key) {
  let found = null;
  for (const line of text.split(/\r?\n/)) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${key}=(.*)$`).exec(line);
    if (m) found = m[1].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return found;
}
const exampleLine = (key) => {
  const v = envValue(exampleText, key);
  return v === null ? `${key}=` : `${key}=${v}`;
};
const isPlaceholder = (key, value) =>
  value === null || value === "" || value === envValue(exampleText, key) || /^(your[-_ ]|changeme|placeholder|todo|xxx|\.\.\.|…)/i.test(value);

const envExisted = existsSync(envPath);
const existing = envExisted ? readFileSync(envPath, "utf8") : "";
if (KEYS.some((k) => new RegExp(`^\\s*(?:export\\s+)?${k}=`, "m").test(existing))) {
  if (PASSWORD_FROM_STDIN) {
    fail("This .env is already set up, so the supplied password was NOT applied and nothing changed. To set a new password: ... | npm run setup -- --reset-password --password-stdin");
  }
  if (statSync(envPath).mode & 0o077) {
    chmodSync(envPath, 0o600);
    console.log("Tightened .env permissions to 0600.");
  }
  console.log("already set up: .env already holds owner settings, nothing changed.");
  console.log("Forgot the password, or think it leaked? Run `npm run setup -- --reset-password`.");
  process.exit(0);
}

// A missing .env starts as a copy of .env.example (its comments explain every setting). An existing one is never guessed at.
const base = envExisted ? existing : exampleText;
const missing = REQUIRED.filter((k) => (envValue(base, k) ?? "") === "");
if (missing.length > 0) {
  fail(
    [
      `This .env is missing ${missing.join(" and ")}, so setup stopped and changed nothing (without them, \`docker compose up -d\` fails at the migrate step).`,
      "Add these lines to .env (they are right for a local install) (adjust the port if you changed it), or start over with `cp .env.example .env`:",
      ...missing.map((k) => `  ${exampleLine(k)}`),
      "Then run `npm run setup` again.",
    ].join("\n"),
  );
}

requireTerminal();
const chosen = PASSWORD_FROM_STDIN ? await readStdinPassword() : null;
const password = chosen ?? randomBytes(18).toString("base64url"); // generated: 24 characters
const lines = [
  // Single-quoted: the hash contains `$`, which Docker Compose would otherwise read as a variable reference.
  `OWNER_PASSWORD_HASH='${await hashPassword(password)}'`,
  `SESSION_SECRET=${randomBytes(32).toString("base64url")}`,
  // Single quotes make Docker Compose env_file and dotenv both read values literally.
  `MCP_GATEWAY_SIGNING_KEY='${JSON.stringify(signingKey())}'`,
];
const prefix = base === "" || base.endsWith("\n") ? base : `${base}\n`;
writeFileSync(envPath, `${prefix}${lines.join("\n")}\n`, { mode: 0o600 });
chmodSync(envPath, 0o600); // mode above only applies when the file is created

console.log("VestLens owner setup complete. Settings written to .env.");
if (!envExisted) console.log("There was no .env, so setup created .env from .env.example first.");
console.log("");
if (chosen === null) {
  console.log(`Owner password: ${password}`);
  console.log("");
  console.log("This is the only time the password is shown. .env keeps only OWNER_PASSWORD_HASH, a hash, which will not work as a password.");
  console.log("Store the password above in your password manager now: save it before you close this terminal.");
} else {
  console.log("The owner password is the one you supplied. VestLens keeps only its hash, so store the password itself now.");
}
console.log("If you lose it, run `npm run setup -- --reset-password` to choose a new one.");

const final = readFileSync(envPath, "utf8");
const unset = SNAPTRADE_KEYS.filter((k) => isPlaceholder(k, envValue(final, k)));
if (unset.length > 0) {
  console.log("");
  console.log(`Warning: ${unset.join(" and ")} in .env ${unset.length > 1 ? "are" : "is"} missing or still a placeholder.`);
  console.log("Open .env in your editor and paste the real value(s) from your SnapTrade dashboard, then run `docker compose up -d`.");
}
