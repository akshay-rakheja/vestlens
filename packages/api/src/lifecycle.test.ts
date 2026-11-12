import { afterEach, describe, expect, it, vi } from "vitest";

import { createLifecycle } from "./lifecycle.js";

afterEach(() => vi.useRealTimers());

function setup(stop: () => Promise<void>) {
  const order: string[] = [];
  let finishClose!: (error?: Error) => void;
  const startScheduler = vi.fn(() => ({ stop: vi.fn(() => { order.push("stop"); return stop(); }) }));
  const lifecycle = createLifecycle({
    startScheduler,
    closeServer: (done) => { order.push("closeServer"); finishClose = done; },
    closeRuntime: async () => { order.push("closeRuntime"); },
    onCloseError: () => order.push("closeError"),
  });
  return { lifecycle, order, startScheduler, closeServer: (error?: Error) => finishClose(error) };
}

describe("server lifecycle", () => {
  it("does not start the scheduler once shutdown has begun", () => {
    const { lifecycle, startScheduler, order } = setup(async () => {});
    lifecycle.shutdown();
    lifecycle.onListening();
    expect(startScheduler).not.toHaveBeenCalled();
    expect(order).toEqual(["closeServer"]);
  });

  it("starts the scheduler once on listen", () => {
    const { lifecycle, startScheduler } = setup(async () => {});
    lifecycle.onListening();
    lifecycle.onListening();
    expect(startScheduler).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight run before closing the runtime", async () => {
    let finishRun!: () => void;
    const { lifecycle, order, closeServer } = setup(() => new Promise<void>((resolve) => { finishRun = resolve; }));
    lifecycle.onListening();
    lifecycle.shutdown();
    closeServer();
    await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(["stop", "closeServer"]);
    finishRun();
    await vi.waitFor(() => expect(order).toEqual(["stop", "closeServer", "closeRuntime"]));
  });

  it("gives up waiting after 8 seconds and closes the runtime anyway", async () => {
    vi.useFakeTimers();
    const { lifecycle, order, closeServer } = setup(() => new Promise<void>(() => {}));
    lifecycle.onListening();
    lifecycle.shutdown();
    closeServer();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(order).not.toContain("closeRuntime");
    await vi.advanceTimersByTimeAsync(2);
    expect(order).toContain("closeRuntime");
  });

  it("reports a server close error after closing the runtime, and only shuts down once", async () => {
    const { lifecycle, order, closeServer } = setup(async () => {});
    lifecycle.onListening();
    lifecycle.shutdown();
    lifecycle.shutdown();
    closeServer(new Error("x"));
    await vi.waitFor(() => expect(order).toEqual(["stop", "closeServer", "closeRuntime", "closeError"]));
  });

  describe("the shutdown bound starts at the signal", () => {
    function bounded(o: { stop?: () => Promise<void>; drain?: () => Promise<void> } = {}) {
      const order: string[] = [];
      const lifecycle = createLifecycle({
        startScheduler: () => ({ stop: () => { order.push("stop"); return (o.stop ?? (async () => {}))(); } }),
        closeServer: () => { order.push("closeServer"); /* never finishes: a connection is held open */ },
        closeAllConnections: () => { order.push("closeAllConnections"); },
        drainBackground: () => { order.push("drain"); return (o.drain ?? (async () => {}))(); },
        closeRuntime: async () => { order.push("closeRuntime"); },
        boundMs: 8_000,
      });
      lifecycle.onListening();
      return { lifecycle, order };
    }

    it("force-closes connections and closes the runtime 8 s after the signal even when server.close never calls back", async () => {
      vi.useFakeTimers();
      const { lifecycle, order } = bounded();
      lifecycle.shutdown();
      await vi.advanceTimersByTimeAsync(7_999);
      expect(order).not.toContain("closeRuntime");
      expect(order).not.toContain("closeAllConnections");
      await vi.advanceTimersByTimeAsync(2);
      expect(order.slice(0, 3)).toEqual(["stop", "drain", "closeServer"]);
      expect(order.indexOf("closeAllConnections")).toBeLessThan(order.indexOf("closeRuntime"));
    });

    it("waits for a background refresh within the bound, and abandons it after the bound", async () => {
      vi.useFakeTimers();
      let finish!: () => void;
      const quick = bounded({ drain: () => new Promise<void>((resolve) => { finish = resolve; }) });
      quick.lifecycle.shutdown();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(quick.order).not.toContain("closeRuntime");
      finish();
      // The server never closes here, so the bound still decides; what matters is that the drain was started at the signal.
      expect(quick.order).toContain("drain");
      await vi.advanceTimersByTimeAsync(5_001);
      expect(quick.order).toContain("closeRuntime");

      const stuck = bounded({ drain: () => new Promise<void>(() => {}) });
      stuck.lifecycle.shutdown();
      await vi.advanceTimersByTimeAsync(8_001);
      expect(stuck.order).toContain("closeRuntime");
    });

    it("does not wait out the bound when everything finishes sooner", async () => {
      const order: string[] = [];
      const lifecycle = createLifecycle({
        startScheduler: () => ({ stop: async () => {} }),
        closeServer: (done) => { done(); },
        closeAllConnections: () => { order.push("closeAllConnections"); },
        drainBackground: async () => {},
        closeRuntime: async () => { order.push("closeRuntime"); },
      });
      lifecycle.onListening();
      lifecycle.shutdown();
      await vi.waitFor(() => expect(order).toContain("closeRuntime"));
      expect(order).not.toContain("closeAllConnections");
    });
  });
});
