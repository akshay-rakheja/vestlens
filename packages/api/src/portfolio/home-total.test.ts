import { describe, expect, it, vi } from "vitest";
import { dashboardHomeTotal } from "./home-total.js";
import type { PortfolioPresentation } from "./portfolio-presentation.js";

const account = (amount: number, currency: string, included = true) => ({
  value: { amount, currency }, classification: { includedInPortfolioTotal: included },
}) as unknown as PortfolioPresentation["accounts"][number];
const portfolio = (...accounts: PortfolioPresentation["accounts"]) => ({ accounts }) as unknown as PortfolioPresentation;

describe("the dashboard's combined CAD total", () => {
  it("adds CAD exactly and USD at the Bank of Canada rate (est., dated); skips accounts outside the total", async () => {
    const market = { usdCad: vi.fn(async () => [{ date: "2026-10-27", close: 1.4 }]) };
    const total = await dashboardHomeTotal(portfolio(account(1000, "CAD"), account(100, "USD"), account(500, "CAD", false)), market, "2026-10-28");
    expect(total).toEqual({ currency: "CAD", amount: 1140, estimated: true, rateDate: "2026-10-27", notConverted: [] });
  });

  it("no combined total when any part can't be converted (no recent rate, or a third currency)", async () => {
    expect(await dashboardHomeTotal(portfolio(account(1000, "CAD"), account(100, "USD")), { usdCad: async () => null }, "2026-10-28")).toBeNull();
    const market = { usdCad: async () => [{ date: "2026-10-27", close: 1.4 }] };
    expect(await dashboardHomeTotal(portfolio(account(1000, "CAD"), account(100, "EUR")), market, "2026-10-28")).toBeNull();
  });

  it("no combined total for a single currency", async () => {
    const market = { usdCad: vi.fn(async () => []) };
    expect(await dashboardHomeTotal(portfolio(account(1000, "CAD")), market, "2026-10-28")).toBeNull();
    expect(market.usdCad).not.toHaveBeenCalled();
  });
});
