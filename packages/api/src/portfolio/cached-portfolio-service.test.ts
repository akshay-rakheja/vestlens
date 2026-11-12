import { describe, expect, it, vi } from "vitest";

import { miniSyntheticAccount } from "../testing/mini-synthetic-fixtures.js";
import { SnapTradeKeyRejectedError } from "../snaptrade/gateway.js";
import { CachedPortfolioService } from "./cached-portfolio-service.js";
import type { PortfolioQueryResult } from "./portfolio-query-service.js";

const SUBJECT_A = "subject|synthetic-cache-a";
const SUBJECT_B = "subject|synthetic-cache-b";

function clock(start = Date.UTC(2026, 9, 14, 12)) {
  let now = start;
  return { now: () => new Date(now), advance: (ms: number) => { now += ms; } };
}

function result(generatedAt: string, accounts = [miniSyntheticAccount(0), miniSyntheticAccount(1)]): PortfolioQueryResult {
  return { connectionRequired: false, generatedAt, accounts, errors: [] };
}

function setup(options: { lastGood?: (subject: string) => Promise<PortfolioQueryResult | null> } = {}) {
  const time = clock();
  const source = {
    getPortfolio: vi.fn(async (_subject: string) => result(time.now().toISOString())),
  };
  const service = new CachedPortfolioService({
    source,
    now: time.now,
    ttlMs: 60_000,
    minRefreshIntervalMs: 15_000,
    maxStaleMs: 3_600_000,
    lastGood: options.lastGood ? { load: vi.fn(options.lastGood) } : undefined,
  });
  return { time, source, service };
}

describe("CachedPortfolioService", () => {
  it("reuses a fresh result within the TTL and reports it as cached", async () => {
    const { time, source, service } = setup();
    const first = await service.getPortfolio(SUBJECT_A);
    time.advance(30_000);
    const second = await service.getPortfolio(SUBJECT_A);
    expect(source.getPortfolio).toHaveBeenCalledTimes(1);
    expect(first.cache).toMatchObject({ source: "provider", stale: false });
    expect(second.cache).toMatchObject({ source: "cache", stale: false, loadedAt: first.generatedAt });
    expect(second.accounts).toEqual(first.accounts);
  });

  it("reloads after the TTL expires", async () => {
    const { time, source, service } = setup();
    await service.getPortfolio(SUBJECT_A);
    time.advance(60_001);
    const again = await service.getPortfolio(SUBJECT_A);
    expect(source.getPortfolio).toHaveBeenCalledTimes(2);
    expect(again.cache?.source).toBe("provider");
  });

  it("shares one provider read between concurrent callers", async () => {
    const { source, service } = setup();
    let release!: () => void;
    source.getPortfolio.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(result("2026-10-14T12:00:00.000Z"));
    }));
    const calls = [service.getPortfolio(SUBJECT_A), service.getPortfolio(SUBJECT_A), service.getAccountPortfolio(SUBJECT_A, "MINI-SYNTHETIC-ACCOUNT-1")];
    release();
    await Promise.all(calls);
    expect(source.getPortfolio).toHaveBeenCalledTimes(1);
  });

  it("keeps users isolated", async () => {
    const { source, service } = setup();
    await service.getPortfolio(SUBJECT_A);
    await service.getPortfolio(SUBJECT_B);
    expect(source.getPortfolio.mock.calls).toEqual([[SUBJECT_A], [SUBJECT_B]]);
    service.invalidate(SUBJECT_A);
    await service.getPortfolio(SUBJECT_B);
    expect(source.getPortfolio).toHaveBeenCalledTimes(2);
  });

  it("serves one account from the cached portfolio without another provider read", async () => {
    const { source, service } = setup();
    await service.getPortfolio(SUBJECT_A);
    const single = await service.getAccountPortfolio(SUBJECT_A, "MINI-SYNTHETIC-ACCOUNT-1");
    expect(source.getPortfolio).toHaveBeenCalledTimes(1);
    expect(single.accounts.map((account) => account.account.id)).toEqual(["MINI-SYNTHETIC-ACCOUNT-1"]);
    const missing = await service.getAccountPortfolio(SUBJECT_A, "MINI-SYNTHETIC-ACCOUNT-unknown");
    expect(missing.accounts).toEqual([]);
  });

  it("honours an explicit refresh only after the minimum interval", async () => {
    const { time, source, service } = setup();
    await service.getPortfolio(SUBJECT_A);
    time.advance(5_000);
    const early = await service.getPortfolio(SUBJECT_A, { refresh: true });
    expect(source.getPortfolio).toHaveBeenCalledTimes(1);
    expect(early.cache?.source).toBe("cache");
    time.advance(10_000);
    const late = await service.getPortfolio(SUBJECT_A, { refresh: true });
    expect(source.getPortfolio).toHaveBeenCalledTimes(2);
    expect(late.cache?.source).toBe("provider");
  });

  it("invalidation forces the next call to read the provider", async () => {
    const { source, service } = setup();
    await service.getPortfolio(SUBJECT_A);
    service.invalidate(SUBJECT_A);
    await service.getPortfolio(SUBJECT_A);
    expect(source.getPortfolio).toHaveBeenCalledTimes(2);
  });

  it("does not cache a connection-required result", async () => {
    const { source, service } = setup();
    source.getPortfolio.mockResolvedValueOnce({ connectionRequired: true, generatedAt: "2026-10-14T12:00:00.000Z", accounts: [], errors: [] });
    const first = await service.getPortfolio(SUBJECT_A);
    expect(first.connectionRequired).toBe(true);
    const second = await service.getPortfolio(SUBJECT_A);
    expect(source.getPortfolio).toHaveBeenCalledTimes(2);
    expect(second.connectionRequired).toBe(false);
  });

  it("falls back to the last in-memory result, labelled stale, when the provider fails", async () => {
    const { time, source, service } = setup();
    const first = await service.getPortfolio(SUBJECT_A);
    time.advance(120_000);
    source.getPortfolio.mockRejectedValueOnce(new Error("synthetic provider outage"));
    const fallback = await service.getPortfolio(SUBJECT_A);
    expect(fallback.cache).toMatchObject({ source: "cache", stale: true, staleReason: "provider_unavailable", loadedAt: first.generatedAt });
    expect(fallback.accounts).toEqual(first.accounts);
  });

  it("an invalidated entry still serves as a stale fallback", async () => {
    const { source, service } = setup();
    await service.getPortfolio(SUBJECT_A);
    service.invalidate(SUBJECT_A);
    source.getPortfolio.mockRejectedValueOnce(new Error("synthetic provider outage"));
    const fallback = await service.getPortfolio(SUBJECT_A);
    expect(fallback.cache?.stale).toBe(true);
  });

  it("does not serve in-memory data older than the stale limit", async () => {
    const { time, source, service } = setup();
    await service.getPortfolio(SUBJECT_A);
    time.advance(3_600_001);
    source.getPortfolio.mockRejectedValueOnce(new Error("synthetic provider outage"));
    await expect(service.getPortfolio(SUBJECT_A)).rejects.toThrow("synthetic provider outage");
  });

  it("uses the persisted last-good portfolio when no in-memory copy exists", async () => {
    const persisted = result("2026-10-14T09:00:00.000Z", [miniSyntheticAccount(2)]);
    const { source, service } = setup({ lastGood: async (subject) => (subject === SUBJECT_A ? persisted : null) });
    source.getPortfolio.mockRejectedValue(new Error("synthetic provider outage"));
    const fallback = await service.getPortfolio(SUBJECT_A);
    expect(fallback.cache).toMatchObject({ source: "last_good", stale: true, staleReason: "provider_unavailable", loadedAt: "2026-10-14T09:00:00.000Z" });
    expect(fallback.accounts).toEqual(persisted.accounts);
    await expect(service.getPortfolio(SUBJECT_B)).rejects.toThrow("synthetic provider outage");
  });

  it("a failed read is not cached and a failing last-good store does not mask the provider error", async () => {
    const { source, service } = setup({ lastGood: async () => { throw new Error("synthetic store failure"); } });
    source.getPortfolio.mockRejectedValueOnce(new Error("synthetic provider outage"));
    await expect(service.getPortfolio(SUBJECT_A)).rejects.toThrow("synthetic provider outage");
    const recovered = await service.getPortfolio(SUBJECT_A);
    expect(recovered.cache?.source).toBe("provider");
  });

  it("evicts the oldest user when the entry limit is reached", async () => {
    const time = clock();
    const source = { getPortfolio: vi.fn(async () => result(time.now().toISOString())) };
    const service = new CachedPortfolioService({ source, now: time.now, maxEntries: 2 });
    await service.getPortfolio("subject|synthetic-1");
    await service.getPortfolio("subject|synthetic-2");
    await service.getPortfolio("subject|synthetic-3");
    await service.getPortfolio("subject|synthetic-1");
    expect(source.getPortfolio).toHaveBeenCalledTimes(4);
  });

  it("forget drops the entry entirely, so a provider failure cannot show the forgotten result", async () => {
    const { time, source, service } = setup();
    await service.getPortfolio(SUBJECT_A);
    service.forget(SUBJECT_A);
    time.advance(1_000);
    source.getPortfolio.mockRejectedValueOnce(new Error("synthetic outage"));

    await expect(service.getPortfolio(SUBJECT_A)).rejects.toThrow("synthetic outage");
  });

  it("forget keeps a read that was already in flight from being cached or shared", async () => {
    const { source, service } = setup();
    let release!: () => void;
    source.getPortfolio.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(result("2026-10-14T11:00:00.000Z"));
    }));
    const inFlight = service.getPortfolio(SUBJECT_A);
    await Promise.resolve();
    service.forget(SUBJECT_A);

    const after = service.getPortfolio(SUBJECT_A);
    release();
    await inFlight;
    await after;
    expect(source.getPortfolio).toHaveBeenCalledTimes(2);
    const cached = await service.getPortfolio(SUBJECT_A);
    // The post-forget read is cached; the pre-forget one never was.
    expect(source.getPortfolio).toHaveBeenCalledTimes(2);
    expect(cached.cache?.source).toBe("cache");
    expect(cached.generatedAt).not.toBe("2026-10-14T11:00:00.000Z");
  });

  it("never serves stale data over a rejected SnapTrade key: it rethrows and logs one code-only line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { time, source, service } = setup();
      await service.getPortfolio(SUBJECT_A);
      time.advance(120_000);
      source.getPortfolio.mockRejectedValueOnce(new SnapTradeKeyRejectedError());
      await expect(service.getPortfolio(SUBJECT_A)).rejects.toBeInstanceOf(SnapTradeKeyRejectedError);
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines).toEqual([JSON.stringify({ event: "snaptrade_key_rejected" })]);
    } finally {
      warn.mockRestore();
    }
  });

  it("still falls back to the last good data on an ordinary provider failure", async () => {
    const { time, source, service } = setup();
    await service.getPortfolio(SUBJECT_A);
    time.advance(120_000);
    source.getPortfolio.mockRejectedValueOnce(new Error("provider down"));
    const stale = await service.getPortfolio(SUBJECT_A);
    expect(stale.cache?.stale).toBe(true);
  });
});
