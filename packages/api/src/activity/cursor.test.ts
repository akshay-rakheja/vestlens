import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cursorKey, decodeCursor, encodeCursor, filtersHash } from "./cursor.js";

const key = cursorKey(Buffer.alloc(32, 7));
const f = { accountId: "A", categories: ["investing"], from: "2026-07-01", to: "2026-10-16" };

describe("activity cursor", () => {
  it("round-trips a position for the same filters", () => {
    const c = encodeCursor(key, f, { date: "2026-09-01", key: "k1" });
    expect(decodeCursor(key, f, c)).toEqual({ before: { date: "2026-09-01", key: "k1" }, restarted: false });
  });
  it("is independent of key and array order in filters", () => {
    expect(filtersHash({ b: 1, a: ["y", "x"] })).toBe(filtersHash({ a: ["x", "y"], b: 1 }));
  });
  const pos = { date: "2026-09-01", key: "k1" };
  const restart = { before: null, restarted: true };
  const signed = (body: unknown) => {
    const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
    return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
  };
  it("restarts on changed filters", () => {
    expect(decodeCursor(key, { ...f, accountId: "B" }, encodeCursor(key, f, pos))).toEqual(restart);
  });
  it("restarts on a tampered MAC", () => {
    const c = encodeCursor(key, f, pos);
    const tampered = c.slice(0, -2) + (c.endsWith("A") ? "BB" : "AA");
    expect(decodeCursor(key, f, tampered)).toEqual(restart);
  });
  it("restarts when the payload is tampered but the MAC is kept", () => {
    const [, mac] = encodeCursor(key, f, pos).split(".");
    const other = encodeCursor(key, f, { date: "2020-01-01", key: "zz" }).split(".")[0];
    expect(decodeCursor(key, f, `${other}.${mac}`)).toEqual(restart);
  });
  it("restarts under a different key", () => {
    expect(decodeCursor(cursorKey(Buffer.alloc(32, 8)), f, encodeCursor(key, f, pos))).toEqual(restart);
  });
  it("restarts on garbage, zero dots and three dots", () => {
    expect(decodeCursor(key, f, "not-a-cursor")).toEqual(restart);
    expect(decodeCursor(key, f, "abcdef")).toEqual(restart);
    expect(decodeCursor(key, f, `${encodeCursor(key, f, pos)}.x`)).toEqual(restart);
  });
  it("restarts when the MAC part is malformed", () => {
    const [payload] = encodeCursor(key, f, pos).split(".");
    expect(decodeCursor(key, f, `${payload}.short`)).toEqual(restart);
    expect(decodeCursor(key, f, `${payload}.${"!".repeat(43)}`)).toEqual(restart);
    expect(decodeCursor(key, f, `${payload}.`)).toEqual(restart);
  });
  it("restarts on non-string input without throwing", () => {
    for (const v of [42, {}, [], true, Symbol("x")]) expect(decodeCursor(key, f, v)).toEqual(restart);
  });
  it("restarts on an over-long string", () => {
    expect(decodeCursor(key, f, "a".repeat(1025))).toEqual(restart);
  });
  it("restarts on a validly signed body with the wrong version", () => {
    const body = { v: 2, h: filtersHash(f), d: pos.date, k: pos.key };
    expect(decodeCursor(key, f, signed(body))).toEqual(restart);
    expect(decodeCursor(key, f, signed({ ...body, v: 1 }))).toEqual({ before: pos, restarted: false });
  });
  it("no cursor (undefined, null, empty) is page 1, not a restart", () => {
    for (const v of [undefined, null, ""]) expect(decodeCursor(key, f, v)).toEqual({ before: null, restarted: false });
  });
  it("carries no filter values in clear text", () => {
    const c = encodeCursor(key, f, { date: "2026-09-01", key: "k1" });
    expect(Buffer.from(c.split(".")[0], "base64url").toString()).not.toContain("investing");
  });
});
