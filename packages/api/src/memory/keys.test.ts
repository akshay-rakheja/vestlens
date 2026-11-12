import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { accountKey, activityKey, isHashKey, memorySlug, outsideAccountKey } from "./keys.js";
import { parseNodeRef, validateFact } from "./memory-types.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("memory node keys", () => {
  it("accountKey is the first 16 hex of sha256('acct:' + snapTradeAccountId)", () => {
    expect(accountKey("synthetic-account-1")).toBe(sha("acct:synthetic-account-1").slice(0, 16));
    expect(accountKey("synthetic-account-1")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("activityKey is the first 16 hex of sha256('act:' + dedupeKey)", () => {
    expect(activityKey("synthetic-dedupe")).toBe(sha("act:synthetic-dedupe").slice(0, 16));
  });

  it("is stable and distinguishes the two namespaces", () => {
    expect(accountKey("x")).toBe(accountKey("x"));
    expect(accountKey("x")).not.toBe(activityKey("x"));
  });

  it("recognizes a hash key", () => {
    expect(isHashKey(accountKey("x"))).toBe(true);
    expect(isHashKey("ABCDEF0123456789")).toBe(false);
    expect(isHashKey("outside:spouse")).toBe(false);
  });

  describe("outsideAccountKey", () => {
    const valid = (key: string) =>
      validateFact({ node: { type: "account", key }, property: "account.ytd_contributions", value: { year: 2026, amountCad: 1, asOf: "2026-03-01" },
        text: "Synthetic.", kind: "fact", provenance: "stated" }).ok;

    it("slugs a plain label into outside:<slug>", () => {
      expect(outsideAccountKey("Other bank")).toBe("outside:other-bank");
    });

    it("lower-cases, replaces other characters, collapses repeats and trims dashes", () => {
      expect(outsideAccountKey("RBC — TFSA!")).toBe("outside:rbc-tfsa");
      expect(outsideAccountKey("  --Spouse's   TFSA__2 ")).toBe("outside:spouse-s-tfsa-2");
    });

    it("is deterministic and case-insensitive", () => {
      expect(outsideAccountKey("Other Bank")).toBe(outsideAccountKey("other bank"));
    });

    it("falls back to a short hash when nothing is left after slugging", () => {
      const key = outsideAccountKey("— ! —");
      expect(key).toMatch(/^outside:[0-9a-f]{8}$/);
      expect(key).toBe(outsideAccountKey("— ! —"));
      expect(key).not.toBe(outsideAccountKey("!!!"));
      expect(outsideAccountKey("")).toMatch(/^outside:[0-9a-f]{8}$/);
    });

    it("caps the slug at 60 characters without a trailing dash", () => {
      const key = outsideAccountKey(`${"a".repeat(59)} b${"c".repeat(30)}`);
      const slug = key.slice("outside:".length);
      expect(slug.length).toBeLessThanOrEqual(60);
      expect(slug.endsWith("-")).toBe(false);
    });

    it("always yields a valid outside account node key", () => {
      for (const label of ["Other bank", "RBC — TFSA!", "— ! —", "x".repeat(200), "Ünïcödé Bank"]) {
        const key = outsideAccountKey(label);
        expect(parseNodeRef({ type: "account", key }).ok).toBe(true);
        expect(valid(key)).toBe(true);
      }
    });
  });

  it("memorySlug gives rule and goal keys that typed limits and goals accept", () => {
    expect(memorySlug("Max 10% in one stock!")).toBe("max-10-in-one-stock");
    expect(memorySlug("Maison à Montréal")).toBe("maison-a-montreal");
    expect(memorySlug("!!!")).toMatch(/^[0-9a-f]{8}$/);
    for (const label of ["Max 10% in one stock!", "Maison à Montréal", "!!!", "x".repeat(200)]) {
      const r = validateFact({
        node: { type: "goal", key: memorySlug(label) }, property: "goal.savings_target", kind: "plan", provenance: "stated", text: "Goal.",
        value: { name: "Goal", targetCad: 1, targetDate: "2030-01-01", accounts: ["outside:x"] },
      });
      expect(r.ok, label).toBe(true);
    }
  });
});
