import { describe, expect, it } from "vitest";

import { pricesAsOf } from "./pricesAsOf";

const account = (synced: string | null, included = true) => ({
  classification: { includedInPortfolioTotal: included },
  freshness: { holdingsLastSyncedAt: synced },
});

describe("pricesAsOf", () => {
  it("is the oldest brokerage sync among the accounts in the total, not when VestLens read SnapTrade", () => {
    expect(pricesAsOf([account("2026-11-03T13:06:04.741Z"), account("2026-11-03T13:06:03.166Z"), account(null)])).toBe("2026-11-03T13:06:03.166Z");
  });

  it("ignores accounts left out of the total (closed accounts keep their last sync)", () => {
    expect(pricesAsOf([account("2026-11-03T13:06:04.000Z"), account("2026-10-29T15:04:26.000Z", false)])).toBe("2026-11-03T13:06:04.000Z");
  });

  it("is null when no sync time is known", () => {
    expect(pricesAsOf([account(null), account("2026-10-29T15:04:26.000Z", false)])).toBeNull();
  });
});
