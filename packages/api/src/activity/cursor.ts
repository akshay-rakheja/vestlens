import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export interface CursorPosition { date: string; key: string }

/** HKDF-SHA256(secret, salt "", info "activity-cursor-v1", 32). */
export function cursorKey(secret: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "activity-cursor-v1", 32));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical).sort((a, b) => {
      const x = JSON.stringify(a);
      const y = JSON.stringify(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) out[k] = canonical((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

/** sha256 of canonical JSON (sorted keys, sorted arrays), first 16 hex chars. */
export function filtersHash(filters: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonical(filters))).digest("hex").slice(0, 16);
}

const sign = (key: Buffer, payload: string) => createHmac("sha256", key).update(payload).digest();

export function encodeCursor(key: Buffer, filters: Record<string, unknown>, before: CursorPosition): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, h: filtersHash(filters), d: before.date, k: before.key })).toString("base64url");
  return `${payload}.${sign(key, payload).toString("base64url")}`;
}

const RESTART = { before: null, restarted: true } as const;

export function decodeCursor(
  key: Buffer,
  filters: Record<string, unknown>,
  cursor: unknown,
): { before: CursorPosition | null; restarted: boolean } {
  if (cursor === undefined || cursor === null || cursor === "") return { before: null, restarted: false };
  if (typeof cursor !== "string" || cursor.length > 1024) return { ...RESTART };
  const parts = cursor.split(".");
  if (parts.length !== 2) return { ...RESTART };
  const [payload, mac] = parts;
  if (!/^[A-Za-z0-9_-]{43}$/.test(mac)) return { ...RESTART };
  const expected = sign(key, payload);
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ...RESTART };
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
    if (body.v !== 1 || body.h !== filtersHash(filters) || typeof body.d !== "string" || typeof body.k !== "string") {
      return { ...RESTART };
    }
    return { before: { date: body.d, key: body.k }, restarted: false };
  } catch {
    return { ...RESTART };
  }
}
