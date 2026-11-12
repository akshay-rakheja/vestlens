import { z } from "zod";

export const BENCHMARK_KEYS = ["sp500", "nasdaq100", "dow", "tsx", "xeqt"] as const;
export type BenchmarkKey = (typeof BENCHMARK_KEYS)[number];
export interface PortfolioSettingsView { benchmark: BenchmarkKey; cadView: boolean; privacyDefault: boolean }
export const DEFAULT_SETTINGS: PortfolioSettingsView = { benchmark: "sp500", cadView: true, privacyDefault: false };

export const settingsUpdateSchema = z.object({
  benchmark: z.enum(BENCHMARK_KEYS).optional(),
  cadView: z.boolean().optional(),
  privacyDefault: z.boolean().optional(),
}).strict();

export interface SettingsPrismaPort {
  appUser: { findIdByAuthSubject(authSubject: string): Promise<{ id: string } | null> };
  portfolioSettings: {
    findUnique(input: { where: { appUserId: string } }): Promise<{ benchmark: string; cadView: boolean; privacyDefault: boolean } | null>;
    upsert(input: {
      where: { appUserId: string };
      create: { appUserId: string } & Partial<PortfolioSettingsView>;
      update: Partial<PortfolioSettingsView>;
    }): Promise<{ benchmark: string; cadView: boolean; privacyDefault: boolean }>;
  };
}

function view(row: { benchmark: string; cadView: boolean; privacyDefault: boolean } | null): PortfolioSettingsView {
  if (!row) return { ...DEFAULT_SETTINGS };
  const benchmark = (BENCHMARK_KEYS as readonly string[]).includes(row.benchmark)
    ? (row.benchmark as BenchmarkKey)
    : DEFAULT_SETTINGS.benchmark;
  return { benchmark, cadView: row.cadView, privacyDefault: row.privacyDefault };
}

export class SettingsService {
  constructor(private readonly prisma: SettingsPrismaPort) {}

  async get(authSubject: string): Promise<PortfolioSettingsView> {
    const owner = await this.prisma.appUser.findIdByAuthSubject(authSubject);
    if (!owner) return { ...DEFAULT_SETTINGS };
    return view(await this.prisma.portfolioSettings.findUnique({ where: { appUserId: owner.id } }));
  }

  async save(authSubject: string, update: unknown): Promise<PortfolioSettingsView> {
    // zod 4 silently drops an own "__proto__" key even in strict mode, so reject it explicitly.
    if (typeof update === "object" && update !== null && Object.prototype.hasOwnProperty.call(update, "__proto__")) {
      throw new Error("Unrecognized settings key: __proto__");
    }
    const parsed = settingsUpdateSchema.parse(update);
    const owner = await this.prisma.appUser.findIdByAuthSubject(authSubject);
    if (!owner) throw new Error("Authenticated app user not found");
    return view(await this.prisma.portfolioSettings.upsert({
      where: { appUserId: owner.id },
      create: { appUserId: owner.id, ...parsed },
      update: parsed,
    }));
  }
}
