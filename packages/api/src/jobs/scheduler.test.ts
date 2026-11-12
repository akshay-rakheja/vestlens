import { describe, expect, it, vi } from "vitest";

import { nextRun, startScheduler, type ScheduleSpec } from "./scheduler.js";

const NIGHTLY: ScheduleSpec = { kind: "daily", hour: 17, minute: 30, weekdaysOnly: true };
const EVERY_10: ScheduleSpec = { kind: "every", minutes: 10 };
const TZ = "America/Toronto";

describe("nextRun", () => {
  it("schedules 17:30 Toronto on weekdays across the DST change", () => {
    // Friday 18:00 EDT -> Monday 17:30 EST (the clocks went back on 2026-11-01).
    expect(nextRun(NIGHTLY, new Date("2026-10-30T22:00:00Z"), TZ).toISOString()).toBe("2026-11-02T22:30:00.000Z");
    // Friday 18:00 EST -> Monday 17:30 EDT (the clocks went forward on 2026-03-08).
    expect(nextRun(NIGHTLY, new Date("2026-03-06T23:00:00Z"), TZ).toISOString()).toBe("2026-03-09T21:30:00.000Z");
  });

  it("runs the same day when 17:30 is still ahead, and skips weekends", () => {
    expect(nextRun(NIGHTLY, new Date("2026-10-28T15:00:00Z"), TZ).toISOString()).toBe("2026-10-28T21:30:00.000Z");
    expect(nextRun(NIGHTLY, new Date("2026-10-31T15:00:00Z"), TZ).toISOString()).toBe("2026-11-02T22:30:00.000Z");
  });

  it("is strictly after a run time that falls exactly on now", () => {
    expect(nextRun(NIGHTLY, new Date("2026-10-28T21:30:00Z"), TZ).toISOString()).toBe("2026-10-29T21:30:00.000Z");
    expect(nextRun(NIGHTLY, new Date("2026-10-30T21:30:00Z"), TZ).toISOString()).toBe("2026-11-02T22:30:00.000Z");
    expect(nextRun(EVERY_10, new Date("2026-10-28T12:10:00Z"), TZ).toISOString()).toBe("2026-10-28T12:20:00.000Z");
  });

  it("runs every 10 minutes", () => {
    expect(nextRun(EVERY_10, new Date("2026-10-28T12:03:20Z"), TZ).toISOString()).toBe("2026-10-28T12:10:00.000Z");
    expect(nextRun(EVERY_10, new Date("2026-10-28T12:59:59.999Z"), TZ).toISOString()).toBe("2026-10-28T13:00:00.000Z");
  });

  it("pins the spring-forward gap: 02:30 on 2026-03-08 resolves to 06:30Z (01:30 EST), the instant before the gap", () => {
    const early: ScheduleSpec = { kind: "daily", hour: 2, minute: 30, weekdaysOnly: false };
    expect(nextRun(early, new Date("2026-03-08T05:00:00Z"), TZ).toISOString()).toBe("2026-03-08T06:30:00.000Z");
    expect(nextRun(early, new Date("2026-03-08T06:30:00Z"), TZ).toISOString()).toBe("2026-03-09T06:30:00.000Z");
  });

  it("supports a daily job that also runs on weekends", () => {
    const daily: ScheduleSpec = { kind: "daily", hour: 6, minute: 0, weekdaysOnly: false };
    expect(nextRun(daily, new Date("2026-10-31T15:00:00Z"), TZ).toISOString()).toBe("2026-11-01T11:00:00.000Z");
  });
});

/** A fake clock and timer set: no real waiting. */
function harness() {
  let clock = new Date("2026-10-28T12:00:00Z").getTime();
  let seq = 0;
  const timers = new Map<number, { at: number; cb: () => void; delay: number }>();
  const setTimer = ((cb: () => void, delay: number) => {
    const id = ++seq;
    timers.set(id, { at: clock + delay, cb, delay });
    return id;
  }) as unknown as typeof setTimeout;
  const clearTimer = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
  const advanceTo = async (ms: number) => {
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= ms).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = Math.max(clock, due[1].at);
      due[1].cb();
      await flush();
    }
    clock = ms;
  };
  return { now: () => new Date(clock), setClock: (ms: number) => { clock = ms; }, setTimer, clearTimer, timers, advanceTo, at: (iso: string) => new Date(iso).getTime() };
}

describe("startScheduler", () => {
  it("runs a job each time its spec comes due and re-arms", async () => {
    const h = harness();
    const run = vi.fn(async () => {});
    const lock = vi.fn(async (_name: string, fn: () => Promise<void>) => { await fn(); return true; });
    startScheduler({ jobs: [{ name: "history-catchup", spec: EVERY_10, run }], lock, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, log: () => {} });
    await h.advanceTo(h.at("2026-10-28T12:09:59Z"));
    expect(run).not.toHaveBeenCalled();
    await h.advanceTo(h.at("2026-10-28T12:10:00Z"));
    expect(run).toHaveBeenCalledTimes(1);
    await h.advanceTo(h.at("2026-10-28T12:30:00Z"));
    expect(run).toHaveBeenCalledTimes(3);
    expect(lock).toHaveBeenCalledWith("history-catchup", expect.any(Function));
  });

  it("never arms a single timer above 24 hours and runs only at the real due time", async () => {
    const h = harness();
    const run = vi.fn(async () => {});
    const lock = async (_n: string, fn: () => Promise<void>) => { await fn(); return true; };
    // Wednesday 08:00 EDT; Friday evening to Monday is about 3 days away, so the wait is split into capped timers.
    startScheduler({ jobs: [{ name: "nightly", spec: NIGHTLY, run }], lock, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, log: () => {} });
    await h.advanceTo(h.at("2026-10-30T22:00:00Z"));
    expect(run).toHaveBeenCalledTimes(3); // Wed, Thu and Fri 17:30
    const delays: number[] = [];
    for (const t of h.timers.values()) delays.push(t.delay);
    expect(Math.max(...delays)).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    await h.advanceTo(h.at("2026-11-02T22:29:00Z"));
    expect(run).toHaveBeenCalledTimes(3);
    await h.advanceTo(h.at("2026-11-02T22:30:00Z"));
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("skips a job whose lock is held and logs job_skipped_locked", async () => {
    const h = harness();
    const run = vi.fn(async () => {});
    const log = vi.fn();
    const lock = vi.fn(async () => false);
    startScheduler({ jobs: [{ name: "nightly", spec: EVERY_10, run }], lock, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, log });
    await h.advanceTo(h.at("2026-10-28T12:10:00Z"));
    expect(run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith({ event: "job_skipped_locked", job: "nightly" });
    // It stays armed for the next slot.
    await h.advanceTo(h.at("2026-10-28T12:20:00Z"));
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("logs a failing job by name and error code or class only, then still re-arms", async () => {
    const h = harness();
    const log = vi.fn();
    class PrivateProblem extends Error {}
    const run = vi.fn(async () => { throw new PrivateProblem("balance 12345.67 for account ABC"); });
    const lock = async (_n: string, fn: () => Promise<void>) => { await fn(); return true; };
    startScheduler({ jobs: [{ name: "nightly", spec: EVERY_10, run }], lock, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, log });
    await h.advanceTo(h.at("2026-10-28T12:10:00Z"));
    expect(log).toHaveBeenCalledWith({ event: "job_failed", job: "nightly", error: "PrivateProblem" });
    await h.advanceTo(h.at("2026-10-28T12:20:00Z"));
    expect(run).toHaveBeenCalledTimes(2);
    const coded = vi.fn(async () => { throw Object.assign(new Error("secret text"), { code: "P2028" }); });
    const log2 = vi.fn();
    startScheduler({ jobs: [{ name: "x", spec: EVERY_10, run: coded }], lock, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, log: log2 });
    await h.advanceTo(h.at("2026-10-28T12:30:00Z"));
    expect(log2).toHaveBeenCalledWith({ event: "job_failed", job: "x", error: "P2028" });
    expect(JSON.stringify([...log.mock.calls, ...log2.mock.calls])).not.toMatch(/12345|ABC|secret/);
  });

  it("a failing lock counts as a failed job and the job re-arms", async () => {
    const h = harness();
    const log = vi.fn();
    const lock = vi.fn(async () => { throw new TypeError("connection details"); });
    startScheduler({ jobs: [{ name: "nightly", spec: EVERY_10, run: async () => {} }], lock, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, log });
    await h.advanceTo(h.at("2026-10-28T12:20:00Z"));
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith({ event: "job_failed", job: "nightly", error: "TypeError" });
  });

  it("stop() clears the timers and starts no new runs; a run in progress finishes", async () => {
    const h = harness();
    let finish!: () => void;
    let finished = false;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = () => { finished = true; resolve(); }; }));
    const lock = async (_n: string, fn: () => Promise<void>) => { await fn(); return true; };
    const scheduler = startScheduler({ jobs: [{ name: "nightly", spec: EVERY_10, run }], lock, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, log: () => {} });
    await h.advanceTo(h.at("2026-10-28T12:10:00Z"));
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
    expect(finished).toBe(false);
    finish();
    await Promise.resolve();
    expect(finished).toBe(true);
    await h.advanceTo(h.at("2026-10-28T13:00:00Z"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.timers.size).toBe(0);
  });

  it("stop() before the first slot clears the armed timers", async () => {
    const h = harness();
    const run = vi.fn(async () => {});
    const scheduler = startScheduler({ jobs: [{ name: "a", spec: EVERY_10, run }, { name: "b", spec: NIGHTLY, run }], lock: async () => true, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, log: () => {} });
    expect(h.timers.size).toBe(2);
    scheduler.stop();
    expect(h.timers.size).toBe(0);
  });

  it("a run that ends after the next slot skips it and runs once at the following slot", async () => {
    const h = harness();
    const run = vi.fn(async () => { if (run.mock.calls.length === 1) h.setClock(h.at("2026-10-28T12:25:00Z")); });
    const lock = async (_n: string, fn: () => Promise<void>) => { await fn(); return true; };
    startScheduler({ jobs: [{ name: "j", spec: EVERY_10, run }], lock, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, log: () => {} });
    await h.advanceTo(h.at("2026-10-28T12:10:00Z"));
    expect(run).toHaveBeenCalledTimes(1);
    await h.advanceTo(h.at("2026-10-28T12:29:59Z"));
    expect(run).toHaveBeenCalledTimes(1);
    await h.advanceTo(h.at("2026-10-28T12:30:00Z"));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a slow job spanning several ticks never overlaps itself", async () => {
    const h = harness();
    let active = 0;
    let maxActive = 0;
    let finish!: () => void;
    const run = vi.fn(async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => { finish = resolve; });
      active -= 1;
    });
    const lock = async (_n: string, fn: () => Promise<void>) => { await fn(); return true; };
    startScheduler({ jobs: [{ name: "history-catchup", spec: EVERY_10, run }], lock, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, log: () => {} });
    await h.advanceTo(h.at("2026-10-28T12:10:00Z"));
    await h.advanceTo(h.at("2026-10-28T12:45:00Z"));
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await h.advanceTo(h.at("2026-10-28T12:50:00Z"));
    expect(run).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it("stop() returns a promise that settles when an in-flight run finishes", async () => {
    const h = harness();
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const lock = async (_n: string, fn: () => Promise<void>) => { await fn(); return true; };
    const scheduler = startScheduler({ jobs: [{ name: "j", spec: EVERY_10, run }], lock, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, log: () => {} });
    await h.advanceTo(h.at("2026-10-28T12:10:00Z"));
    let settled = false;
    const stopped = scheduler.stop().then(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await stopped;
    expect(settled).toBe(true);
    await expect(startScheduler({ jobs: [], lock: async () => true }).stop()).resolves.toBeUndefined();
  });

  it("rejects invalid specs at start", () => {
    const bad: ScheduleSpec[] = [
      { kind: "every", minutes: 0 }, { kind: "every", minutes: -5 }, { kind: "every", minutes: 1.5 }, { kind: "every", minutes: Number.NaN },
      { kind: "daily", hour: 24, minute: 0, weekdaysOnly: false }, { kind: "daily", hour: -1, minute: 0, weekdaysOnly: false },
      { kind: "daily", hour: 1.5, minute: 0, weekdaysOnly: false }, { kind: "daily", hour: 1, minute: 60, weekdaysOnly: false },
    ];
    for (const spec of bad) {
      const h = harness();
      expect(() => startScheduler({ jobs: [{ name: "j", spec, run: async () => {} }], lock: async () => true, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer }), JSON.stringify(spec)).toThrow("invalid_schedule");
    }
  });

  it("a throwing log never becomes an unhandled rejection and the job still re-arms", async () => {
    const h = harness();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const run = vi.fn(async () => { throw new Error("x"); });
      const lock = async (_n: string, fn: () => Promise<void>) => { await fn(); return true; };
      startScheduler({ jobs: [{ name: "j", spec: EVERY_10, run }], lock, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, log: () => { throw new Error("sink down"); } });
      await h.advanceTo(h.at("2026-10-28T12:20:00Z"));
      await new Promise((resolve) => setImmediate(resolve));
      expect(run).toHaveBeenCalledTimes(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
