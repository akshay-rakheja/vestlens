import { describe, expect, it } from "vitest";
import { hashOwnerPassword, parseOwnerPasswordHash, verifyOwnerPassword } from "./owner-password.js";

describe("owner password hash", () => {
  it("verifies the password it hashed and rejects another", async () => {
    const encoded = await hashOwnerPassword("correct horse battery");
    const [scheme, n, r, p, salt, hash] = encoded.split("$");
    expect([scheme, n, r, p]).toEqual(["scrypt", "32768", "8", "1"]);
    expect(Buffer.from(salt!, "base64url")).toHaveLength(16);
    expect(Buffer.from(hash!, "base64url")).toHaveLength(32);
    expect(() => parseOwnerPasswordHash(encoded)).not.toThrow();
    expect(await verifyOwnerPassword("correct horse battery", encoded)).toBe(true);
    expect(await verifyOwnerPassword("correct horse batterz", encoded)).toBe(false);
    expect(await verifyOwnerPassword("", encoded)).toBe(false);
  });

  it("rejects a malformed hash", async () => {
    for (const bad of [
      "",
      "scrypt$32768$8$1$abc",
      "bcrypt$32768$8$1$AAAA$AAAA",
      "scrypt$x$8$1$AAAA$AAAA",
      "scrypt$32768$8$1$$AAAA",
      "scrypt$32768$8$1$AAAA$AAAA$extra",
    ]) {
      expect(() => parseOwnerPasswordHash(bad), bad).toThrow("OWNER_PASSWORD_HASH");
      expect(await verifyOwnerPassword("x", bad)).toBe(false);
    }
  });

  it("accepts only the exact scrypt parameters, salt and hash length", async () => {
    const good = await hashOwnerPassword("pw");
    const [, , , , salt, hash] = good.split("$");
    const short = Buffer.alloc(8, 1).toString("base64url");
    for (const bad of [
      `scrypt$65536$8$1$${salt}$${hash}`,
      `scrypt$32768$16$1$${salt}$${hash}`,
      `scrypt$32768$8$2$${salt}$${hash}`,
      `scrypt$1024$8$1$${salt}$${hash}`,
      `scrypt$32768$8$1$${short}$${hash}`,
      `scrypt$32768$8$1$${salt}$${Buffer.alloc(16, 1).toString("base64url")}`,
    ]) {
      expect(() => parseOwnerPasswordHash(bad), bad).toThrow("OWNER_PASSWORD_HASH");
      expect(await verifyOwnerPassword("pw", bad)).toBe(false);
    }
  });
});
