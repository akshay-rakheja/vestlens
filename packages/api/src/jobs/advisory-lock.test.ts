import { describe, expect, it, vi } from "vitest";

import { withAdvisoryLock, type AdvisoryLockPrisma } from "./advisory-lock.js";

/** A fake client: one lock per name, held from the first $queryRaw until the transaction callback settles. */
function fakePrisma(held: Set<string> = new Set()) {
  const txOptions: unknown[] = [];
  const prisma: AdvisoryLockPrisma = {
    $transaction: async (fn, options) => {
      txOptions.push(options);
      const mine = new Set<string>();
      const tx = {
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          expect(strings.join("?")).toContain("pg_try_advisory_xact_lock(hashtext(?))");
          const name = String(values[0]);
          if (held.has(name)) return [{ locked: false }];
          held.add(name);
          mine.add(name);
          return [{ locked: true }];
        },
      };
      try {
        return await fn(tx);
      } finally {
        for (const name of mine) held.delete(name);
      }
    },
  };
  return { prisma, held, txOptions };
}

describe("withAdvisoryLock", () => {
  it("returns false without running fn while another holder has the lock", async () => {
    const { prisma } = fakePrisma(new Set(["nightly"]));
    const fn = vi.fn(async () => {});
    expect(await withAdvisoryLock(prisma, "nightly", fn)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("runs fn and returns true when the lock is free, holding it for the duration", async () => {
    const { prisma, held, txOptions } = fakePrisma();
    let heldDuring = false;
    const fn = vi.fn(async () => { heldDuring = held.has("nightly"); });
    expect(await withAdvisoryLock(prisma, "nightly", fn)).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
    expect(heldDuring).toBe(true);
    expect(held.has("nightly")).toBe(false);
    expect(txOptions).toEqual([{ timeout: 30 * 60_000, maxWait: 5_000 }]);
  });

  it("locks per name", async () => {
    const { prisma } = fakePrisma(new Set(["nightly"]));
    const fn = vi.fn(async () => {});
    expect(await withAdvisoryLock(prisma, "history-catchup", fn)).toBe(true);
  });

  it("surfaces an error from fn and leaves the lock free", async () => {
    const { prisma, held } = fakePrisma();
    await expect(withAdvisoryLock(prisma, "nightly", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(held.has("nightly")).toBe(false);
    const fn = vi.fn(async () => {});
    expect(await withAdvisoryLock(prisma, "nightly", fn)).toBe(true);
  });
});
