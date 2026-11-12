import { describe, expect, it } from "vitest";

import type { StoredActivity } from "../history/stored-activity.js";
import { lifetimeText } from "../mcp/room-tools.js";
import { loadTfsaLifetime, type RoomPrismaPort } from "./room-loader.js";
import { computeTfsaLifetime, type LifetimeAccount } from "./tfsa-lifetime.js";

const account = (id: string, over: Partial<LifetimeAccount> = {}): LifetimeAccount => ({ id, label: `TFSA ${id}`, managed: false, backfilled: true, ...over });
let n = 0;
const row = (accountId: string, type: string, amount: number | null, tradeDate: string, over: Partial<StoredActivity> = {}): StoredActivity => ({
  snapTradeAccountId: accountId, dedupeKey: `k${n++}`, type, symbol: null, securityCurrency: null, isOption: false, units: null, price: null,
  amount, fee: null, fxRate: null, currency: "CAD", tradeDate, settlementDate: null, description: null, ...over,
});
const cadOnly = () => ({ cad: null, estimated: false });

describe("computeTfsaLifetime", () => {
  // The performance figure starts after its first value date, so an account's first deposits fell out of it.
  it("counts the account's very first deposit", () => {
    const r = computeTfsaLifetime([account("a")], [row("a", "CONTRIBUTION", 2600, "2021-03-05"), row("a", "CONTRIBUTION", 1000, "2022-01-10"), row("a", "WITHDRAWAL", -500, "2023-06-01")], cadOnly);
    expect(r.accounts[0]).toMatchObject({ putInCad: 3600, takenOutCad: -500, netCad: 3100, firstDate: "2021-03-05", historyComplete: true, unvaluedMoves: 0, estimated: false });
    expect(r.total).toMatchObject({ putInCad: 3600, takenOutCad: -500, netCad: 3100 });
  });

  it("leaves out buys, sells, income, fees and promotions", () => {
    const r = computeTfsaLifetime([account("a")], ["BUY", "SELL", "DIVIDEND", "INTEREST", "FEE", "TAX", "PROMOTION", "REIMBURSEMENT"].map((t) => row("a", t, 50, "2022-02-02")), cadOnly);
    expect(r.total).toMatchObject({ putInCad: 0, takenOutCad: 0, netCad: 0 });
  });

  it("counts transfers as money in and out, and says how much of the net they are", () => {
    const r = computeTfsaLifetime([account("a")], [row("a", "CONTRIBUTION", 1000, "2022-01-10"), row("a", "INTERNAL_CASH_TRANSFER_IN", 400, "2022-02-10")], cadOnly);
    expect(r.accounts[0]).toMatchObject({ putInCad: 1400, netCad: 1400, transfersNetCad: 400 });
  });

  it("values shares moved in kind at their reported price", () => {
    const r = computeTfsaLifetime([account("a")], [row("a", "TRANSFER", 0, "2022-02-10", { symbol: "XEQT", units: 10, price: 30 })], cadOnly);
    expect(r.accounts[0]).toMatchObject({ putInCad: 300, transfersNetCad: 300, unvaluedMoves: 0 });
  });

  it("reports moves it can't value instead of dropping them quietly", () => {
    const r = computeTfsaLifetime([account("a")], [
      row("a", "TRANSFER", 0, "2022-02-10", { symbol: "XEQT", units: 10 }),
      row("a", "TRANSFER", 250, "2022-03-10"),
    ], cadOnly);
    expect(r.accounts[0]).toMatchObject({ putInCad: 0, unvaluedMoves: 2 });
  });

  it("nets a move between two TFSAs in the total but shows it on each account", () => {
    const r = computeTfsaLifetime([account("a"), account("b")], [
      row("a", "CONTRIBUTION", 1000, "2022-01-10"),
      row("a", "INTERNAL_CASH_TRANSFER_OUT", -600, "2023-01-10"),
      row("b", "INTERNAL_CASH_TRANSFER_IN", 600, "2023-01-11"),
    ], cadOnly);
    expect(r.accounts.find((x) => x.label === "TFSA a")).toMatchObject({ putInCad: 1000, takenOutCad: -600 });
    expect(r.accounts.find((x) => x.label === "TFSA b")).toMatchObject({ putInCad: 600, takenOutCad: 0 });
    expect(r.total).toMatchObject({ putInCad: 1000, takenOutCad: 0, netCad: 1000 });
  });

  it("converts foreign deposits and marks them estimated", () => {
    const r = computeTfsaLifetime([account("a")], [row("a", "CONTRIBUTION", 100, "2022-01-10", { currency: "USD" })], () => ({ cad: 135, estimated: true }));
    expect(r.accounts[0]).toMatchObject({ putInCad: 135, estimated: true });
    expect(r.total.estimated).toBe(true);
  });

  it("counts a foreign deposit with no rate as a move it can't value", () => {
    const r = computeTfsaLifetime([account("a")], [row("a", "CONTRIBUTION", 100, "2022-01-10", { currency: "USD" })], cadOnly);
    expect(r.accounts[0]).toMatchObject({ putInCad: 0, unvaluedMoves: 1 });
  });

  it("gives no figures for a managed account, whose activity SnapTrade doesn't provide", () => {
    const r = computeTfsaLifetime([account("a", { managed: true })], [], cadOnly);
    expect(r.accounts[0]).toMatchObject({ managed: true, putInCad: null, takenOutCad: null, netCad: null });
  });

  it("gives each year's money in and out, and the running net at its end", () => {
    const r = computeTfsaLifetime([account("a")], [
      row("a", "CONTRIBUTION", 1000, "2021-03-05"), row("a", "CONTRIBUTION", 2000, "2021-08-01"),
      row("a", "WITHDRAWAL", -500, "2023-06-01"),
    ], cadOnly);
    expect(r.accounts[0]!.years).toEqual([
      { year: 2021, putInCad: 3000, takenOutCad: 0, netSoFarCad: 3000 },
      { year: 2023, putInCad: 0, takenOutCad: -500, netSoFarCad: 2500 },
    ]);
  });

  it("names money rows it doesn't count, by type, and skips ordinary investing rows", () => {
    const r = computeTfsaLifetime([account("a")], [
      row("a", "PROMOTION", 100, "2022-01-01"), row("a", "PROMOTION", 50, "2022-02-01"), row("a", "SOMETHING_NEW", 25, "2022-03-01"),
      row("a", "BUY", -500, "2022-03-01"), row("a", "DIVIDEND", 5, "2022-03-01"), row("a", "SPLIT", 0, "2022-03-01"),
    ], cadOnly);
    expect(r.accounts[0]!.notCounted).toEqual([{ type: "PROMOTION", rows: 2, amountCad: 150 }, { type: "SOMETHING_NEW", rows: 1, amountCad: 25 }]);
  });

  it("marks an account whose history hasn't finished loading", () => {
    const r = computeTfsaLifetime([account("a", { backfilled: false })], [row("a", "CONTRIBUTION", 100, "2022-01-10")], cadOnly);
    expect(r.accounts[0]!.historyComplete).toBe(false);
  });
});

describe("lifetimeText", () => {
  const text = (accounts: LifetimeAccount[], rows: StoredActivity[]) => lifetimeText(computeTfsaLifetime(accounts, rows, cadOnly));

  it("gives the figures, the start date and what they can't see", () => {
    const t = text([account("a")], [row("a", "CONTRIBUTION", 2600, "2021-03-05"), row("a", "WITHDRAWAL", -500, "2023-06-01")]);
    expect(t).toContain("TFSA a: put in $2,600, taken out $500, net $2,100 since 5 March 2021");
    expect(t).toMatch(/TFSAs at other institutions/);
  });

  // SnapTrade can start after the account opened, and an earlier deposit or withdrawal would move the net either way.
  it("says where the history starts once it has finished loading", () => {
    const start = "The earliest activity SnapTrade has for this account is 10 January 2022. Anything before that isn't in these figures.";
    const rows = [row("a", "CONTRIBUTION", 1, "2022-01-10")];
    expect(text([account("a")], rows)).toContain(start);
    expect(text([account("a", { backfilled: false })], rows)).not.toContain(start);
    expect(text([account("a")], [])).not.toContain("earliest activity");
  });

  it("warns that transfers aren't the same as contributions for room", () => {
    expect(text([account("a")], [row("a", "INTERNAL_CASH_TRANSFER_IN", 400, "2022-02-10")])).toMatch(/\$400 of the net is transfers/);
  });

  it("says when history is still loading, a move has no value or an account is managed", () => {
    expect(text([account("a", { backfilled: false })], [row("a", "CONTRIBUTION", 1, "2022-01-10")])).toMatch(/still loading/);
    expect(text([account("a")], [row("a", "TRANSFER", 250, "2022-03-10")])).toMatch(/1 move has no value/);
    expect(text([account("a", { managed: true })], [])).toMatch(/SnapTrade doesn't provide/);
  });

  it("lists the running net by year and the rows it doesn't count", () => {
    const t = text([account("a")], [row("a", "CONTRIBUTION", 1000, "2021-03-05"), row("a", "WITHDRAWAL", -500, "2023-06-01"), row("a", "PROMOTION", 100, "2022-01-01")]);
    expect(t).toContain("Running net at the end of each year: 2021 $1,000; 2023 $500.");
    expect(t).toContain("Not counted: PROMOTION (1 row, $100).");
  });

  it("adds a total only with more than one account", () => {
    expect(text([account("a")], [row("a", "CONTRIBUTION", 1, "2022-01-10")])).not.toMatch(/All connected TFSAs/);
    expect(text([account("a"), account("b")], [row("a", "CONTRIBUTION", 1, "2022-01-10")])).toMatch(/All connected TFSAs/);
  });
});

describe("loadTfsaLifetime", () => {
  const account = (id: string, rawType: string) => ({ snapTradeAccountId: id, displayName: `Synthetic ${rawType}`, institutionName: "Synthetic Broker", rawType, status: "open", snapshots: [] });

  it("reads every stored row of the TFSAs, with no date limit, and ignores other accounts", async () => {
    const queries: Array<Record<string, unknown>> = [];
    const port = {
      brokerageAccount: { findMany: async () => [account("T", "TFSA"), account("R", "RRSP")] },
      activity: {
        findMany: async (q: { where: Record<string, unknown>; select: Record<string, unknown> }) => {
          if (!q.select.isOption) return [];
          queries.push(q.where);
          return [{ snapTradeAccountId: "T", dedupeKey: "old", type: "CONTRIBUTION", amount: 2600, currency: "CAD", fxRate: null, tradeDate: new Date("2015-01-05T00:00:00Z"), isOption: false }];
        },
      },
      activitySyncState: { findMany: async () => [{ snapTradeAccountId: "T", backfillCompletedAt: new Date("2026-01-01T00:00:00Z"), lastSyncedAt: null, lastError: null, dirty: false }] },
    } as unknown as RoomPrismaPort;
    const r = await loadTfsaLifetime({ prisma: port, memory: {} as never }, "subject", "2026-11-02");
    expect(queries).toEqual([{ appUser: { authSubject: "subject" }, snapTradeAccountId: { in: ["T"] } }]);
    expect(r.accounts).toHaveLength(1);
    expect(r.accounts[0]).toMatchObject({ putInCad: 2600, firstDate: "2015-01-05", historyComplete: true });
  });
});
