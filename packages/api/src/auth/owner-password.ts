import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Owner password hash: `scrypt$<N>$<r>$<p>$<saltB64url>$<hashB64url>`, N=2^15, r=8, p=1, 32-byte key.
 * 128*N*r = 32 MiB, over Node's default scrypt maxmem, so every call passes an explicit one.
 */
const N = 1 << 15;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const MAXMEM = 64 * 1024 * 1024;
const B64URL = /^[A-Za-z0-9_-]+$/;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, len, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashOwnerPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, N, R, P, KEY_LEN);
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

interface Parsed { n: number; r: number; p: number; salt: Buffer; hash: Buffer }

function parse(encoded: string): Parsed {
  const fail = (): never => {
    throw new Error("OWNER_PASSWORD_HASH");
  };
  if (typeof encoded !== "string") return fail();
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return fail();
  const [, ns, rs, ps, saltS, hashS] = parts as [string, string, string, string, string, string];
  for (const num of [ns, rs, ps]) if (!/^[1-9][0-9]{0,7}$/.test(num)) return fail();
  const n = Number(ns);
  const r = Number(rs);
  const p = Number(ps);
  if (n !== N || r !== R || p !== P) return fail();
  if (!B64URL.test(saltS) || !B64URL.test(hashS)) return fail();
  const salt = Buffer.from(saltS, "base64url");
  const hash = Buffer.from(hashS, "base64url");
  if (salt.length < SALT_LEN || hash.length !== KEY_LEN) return fail();
  return { n, r, p, salt, hash };
}

/** Throws `Error("OWNER_PASSWORD_HASH")` when the encoded hash is malformed. Never echoes the value. */
export function parseOwnerPasswordHash(encoded: string): void {
  parse(encoded);
}

/** False for a wrong password or a malformed hash. */
export async function verifyOwnerPassword(password: string, encoded: string): Promise<boolean> {
  let parsed: Parsed;
  try {
    parsed = parse(encoded);
  } catch {
    return false;
  }
  const key = await derive(password, parsed.salt, parsed.n, parsed.r, parsed.p, parsed.hash.length);
  return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
}
