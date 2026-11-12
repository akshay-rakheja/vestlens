import type { NormalizedAccountPortfolio } from "../portfolio/normalize.js";

/** New mini-only test data, generated from the documented index arithmetic. */
export function miniSyntheticAccount(
  index: number,
  options: {
    currency?: string;
    unifiedType?: string | null;
    rawType?: string | null;
    status?: string | null;
    reported?: boolean;
    name?: string | null;
  } = {},
): NormalizedAccountPortfolio {
  if (!Number.isInteger(index) || index < 0 || index > 20) {
    throw new Error("Synthetic fixture index outside documented range");
  }
  const currency = options.currency ?? "CAD";
  const amount = 137 * (index + 1) + 19;
  return {
    account: {
      id: `MINI-SYNTHETIC-ACCOUNT-${index}`,
      connectionId: `MINI-SYNTHETIC-CONNECTION-${index}`,
      number: String(700000000 + (index + 1) * 97),
      name: options.name === undefined ? `Synthetic account ${index}` : options.name,
      institution: "Synthetic brokerage fixture",
      type: options.rawType === undefined ? "TFSA" : options.rawType,
      category: "SYNTHETIC",
      metaType: null,
      unifiedType: options.unifiedType === undefined ? "SELF_DIRECTED_TFSA" : options.unifiedType,
      status: options.status === undefined ? "open" : options.status,
      isPaper: true,
      reportedTotal: options.reported === false ? null : { currency, amount },
    },
    balances: [{ currency, cash: index + 3, buyingPower: null }],
    positions: [{
      instrumentId: `MINI-SYNTHETIC-INSTRUMENT-${index}`,
      kind: "stock",
      symbol: `SYNTHETIC${index}`,
      description: "Entirely generated synthetic position",
      units: index + 2,
      price: index + 7,
      costBasis: null,
      marketValue: (index + 2) * (index + 7),
      unrealizedGain: null,
      currency,
      cashEquivalent: false,
    }],
    calculatedValueByCurrency: { [currency]: index + 3 + (index + 2) * (index + 7) },
    freshness: {
      positionsAsOf: new Date(Date.UTC(2026, 9, 6, 12, index)).toISOString(),
      holdingsLastSyncedAt: null,
      initialSyncCompleted: false,
      holdingsUnavailable: false,
    },
    warnings: ["Generated mini fixture; no live account or provider data."],
  };
}
