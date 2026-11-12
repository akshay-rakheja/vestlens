/** The slice of a Prisma client the lock needs. */
export interface AdvisoryLockTx {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}
export interface AdvisoryLockPrisma {
  $transaction<T>(fn: (tx: AdvisoryLockTx) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T>;
}

/**
 * Runs `fn` only if no other process holds the named lock; returns false without running it when one does.
 *
 * The lock is a transaction-level advisory lock, taken inside an interactive transaction: Postgres releases it at
 * commit or rollback, on the same connection that took it. (A session-level lock paired with a separate unlock call
 * can run on different pooled connections and leak.) `fn` keeps using the normal client, not the transaction, and a
 * throw from `fn` rolls the transaction back, releases the lock and propagates.
 */
export async function withAdvisoryLock(prisma: AdvisoryLockPrisma, name: string, fn: () => Promise<void>): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      const rows = (await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext(${name})) AS locked`) as Array<{ locked: boolean }>;
      if (rows[0]?.locked !== true) return false;
      await fn();
      return true;
    },
    // Invariant: a locked job must finish well inside this timeout (the pipeline's budgetMs defaults to 240 s). Past it,
    // Prisma expires the transaction, which releases the lock while `fn` may still be running and reports a false failure.
    { timeout: 30 * 60_000, maxWait: 5_000 },
  );
}
