import type { MarketDataCachePort } from "./market-data-service.js";

export interface MarketDataCachePrismaPort {
  marketDataCache: {
    findUnique(input: { where: { key: string } }): Promise<{ payload: unknown; expiresAt: Date } | null>;
    upsert(input: {
      where: { key: string };
      create: { key: string; payload: object; fetchedAt: Date; expiresAt: Date };
      update: { payload: object; fetchedAt: Date; expiresAt: Date };
    }): Promise<unknown>;
    deleteMany(input: { where: { expiresAt: { lt: Date } } }): Promise<{ count: number }>;
  };
}

export class PrismaMarketDataCache implements MarketDataCachePort {
  constructor(private readonly prisma: MarketDataCachePrismaPort) {}

  async get(key: string, now: Date): Promise<unknown | null> {
    const row = await this.prisma.marketDataCache.findUnique({ where: { key } });
    return row && row.expiresAt > now ? row.payload : null;
  }

  async set(key: string, payload: unknown, fetchedAt: Date, expiresAt: Date): Promise<void> {
    const data = { payload: payload as object, fetchedAt, expiresAt };
    await this.prisma.marketDataCache.upsert({ where: { key }, create: { key, ...data }, update: data });
  }

  /** Deletes rows that expired before `now`; returns the count only. */
  async purgeExpired(now: Date): Promise<number> {
    return (await this.prisma.marketDataCache.deleteMany({ where: { expiresAt: { lt: now } } })).count;
  }
}
