/** How long shutdown waits for a scheduled run in progress before closing the database anyway. */
export const SCHEDULER_STOP_BOUND_MS = 8_000;

export interface LifecycleDeps {
  startScheduler(): { stop(): Promise<void> };
  /** Stops accepting connections; `done` runs when the server has closed. */
  closeServer(done: (error?: Error) => void): void;
  /** Ends every connection still open once the bound has passed (`server.closeAllConnections()`). */
  closeAllConnections?(): void;
  /** Resolves when background runs (a manual refresh) have finished; they are abandoned if the bound passes first. */
  drainBackground?(): Promise<void>;
  closeRuntime(): Promise<void>;
  onCloseError?(): void;
  boundMs?: number;
}

/**
 * Startup and shutdown ordering for the server: scheduler after listen, never after shutdown began. One bound, started
 * at the signal, covers in-flight requests, a scheduled run and a background refresh. After it, remaining connections are
 * cut and the database closes anyway (Postgres rolls back a lock transaction that was still open).
 */
export function createLifecycle(deps: LifecycleDeps) {
  let scheduler: { stop(): Promise<void> } | undefined;
  let shuttingDown = false;
  return {
    /** The `listen` callback: arms the schedule unless shutdown has already begun. */
    onListening(): void {
      if (shuttingDown || scheduler) return;
      scheduler = deps.startScheduler();
    },
    /** SIGINT/SIGTERM: stop new runs, wait (bounded, from now) for work in progress, then close the runtime. */
    shutdown(): void {
      if (shuttingDown) return;
      shuttingDown = true;
      const stopped = (scheduler ? scheduler.stop() : Promise.resolve()).catch(() => undefined);
      const drained = (deps.drainBackground ? deps.drainBackground() : Promise.resolve()).catch(() => undefined);
      let serverError: Error | undefined;
      let serverClosed = false;
      const closed = new Promise<void>((resolve) => {
        deps.closeServer((error) => { serverError = error; serverClosed = true; resolve(); });
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<"bound">((resolve) => { timer = setTimeout(() => resolve("bound"), deps.boundMs ?? SCHEDULER_STOP_BOUND_MS); });
      void (async () => {
        const outcome = await Promise.race([Promise.all([stopped, drained, closed]).then(() => "done" as const), bound]);
        clearTimeout(timer);
        if (outcome === "bound" && !serverClosed) deps.closeAllConnections?.();
        try {
          await deps.closeRuntime();
        } catch {
          deps.onCloseError?.();
          return;
        }
        if (serverError) deps.onCloseError?.();
      })();
    },
  };
}
