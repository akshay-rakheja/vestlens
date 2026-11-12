import { z } from "zod";

const nullableNumberSchema = z
  .union([z.number(), z.string()])
  .nullable()
  .optional()
  .transform((value, context) => {
    if (value === null || value === undefined || value === "") return null;
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) {
      context.addIssue({ code: "custom", message: "Expected a finite number" });
      return z.NEVER;
    }
    return number;
  });

const accountSchema = z.looseObject({
  id: z.string().min(1),
  brokerage_authorization: z.string().min(1),
  name: z.string().nullable(),
  number: z.string(),
  institution_name: z.string().min(1),
  raw_type: z.string().nullable().optional(),
  account_category: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  is_paper: z.boolean(),
  meta: z
    .looseObject({
      type: z.string().nullable().optional(),
      unifiedAccountType: z.string().nullable().optional(),
      unified_account_type: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  balance: z.looseObject({
    total: z
      .looseObject({
        amount: z.number().finite(),
        currency: z.string().min(1),
      })
      .nullable()
      .optional(),
  }),
  sync_status: z.looseObject({
    holdings: z
      .looseObject({
        initial_sync_completed: z.boolean().optional(),
        last_successful_sync: z.string().nullable().optional(),
        holdings_unavailable: z.boolean().optional(),
      })
      .optional(),
  }),
});

const balanceSchema = z.looseObject({
  currency: z.looseObject({ code: z.string().min(1) }),
  cash: nullableNumberSchema,
  buying_power: nullableNumberSchema,
});

const positionSchema = z.looseObject({
  instrument: z.looseObject({
    id: z.string().min(1),
    kind: z.string().min(1),
    symbol: z.string().min(1),
    description: z.string().nullable().optional(),
  }),
  units: nullableNumberSchema,
  price: nullableNumberSchema,
  cost_basis: nullableNumberSchema,
  currency: z.string().nullable().optional(),
  cash_equivalent: z.boolean().optional(),
});

const positionsResponseSchema = z.looseObject({
  results: z.array(positionSchema),
  data_freshness: z.looseObject({ as_of: z.string().min(1).nullable().optional() }).optional(),
});

export interface NormalizedAccountPortfolio {
  account: {
    id: string;
    connectionId: string;
    name: string | null;
    number: string;
    institution: string;
    type: string | null;
    category: string | null;
    metaType: string | null;
    unifiedType: string | null;
    status: string | null;
    isPaper: boolean;
    reportedTotal: { amount: number; currency: string } | null;
  };
  balances: Array<{
    currency: string;
    cash: number | null;
    buyingPower: number | null;
  }>;
  positions: Array<{
    instrumentId: string;
    kind: string;
    symbol: string;
    description: string | null;
    units: number | null;
    price: number | null;
    costBasis: number | null;
    marketValue: number | null;
    unrealizedGain: number | null;
    currency: string | null;
    cashEquivalent: boolean;
  }>;
  calculatedValueByCurrency: Record<string, number>;
  freshness: {
    positionsAsOf: string | null;
    holdingsLastSyncedAt: string | null;
    initialSyncCompleted: boolean;
    holdingsUnavailable: boolean;
  };
  warnings: string[];
}

function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("SnapTrade returned an invalid freshness timestamp");
  }
  return date.toISOString();
}

function addCurrencyValue(
  totals: Record<string, number>,
  currency: string,
  amount: number,
): void {
  totals[currency] = (totals[currency] ?? 0) + amount;
}

export function normalizeAccountPortfolio(input: {
  account: unknown;
  balances: unknown;
  positions: unknown;
}): NormalizedAccountPortfolio {
  const sourceAccount = accountSchema.parse(input.account);
  const sourceBalances = z.array(balanceSchema).parse(input.balances);
  const sourcePositions = positionsResponseSchema.parse(input.positions);
  const warnings: string[] = [];

  const balances = sourceBalances.map((balance) => ({
    currency: balance.currency.code,
    cash: balance.cash,
    buyingPower: balance.buying_power,
  }));

  const positions = sourcePositions.results.map((position) => {
    const supportsUnitValuation = ["stock", "etf", "mutualfund", "crypto"].includes(position.instrument.kind.toLowerCase());
    const marketValue =
      !supportsUnitValuation || position.units === null || position.price === null
        ? null
        : position.units * position.price;
    const unrealizedGain =
      !supportsUnitValuation || position.units === null ||
      position.price === null ||
      position.cost_basis === null
        ? null
        : position.units * (position.price - position.cost_basis);

    return {
      instrumentId: position.instrument.id,
      kind: position.instrument.kind,
      symbol: position.instrument.symbol,
      description: position.instrument.description ?? null,
      units: position.units,
      price: position.price,
      costBasis: position.cost_basis,
      marketValue,
      unrealizedGain,
      currency: position.currency ?? null,
      cashEquivalent: position.cash_equivalent ?? false,
    };
  });

  const calculatedValueByCurrency: Record<string, number> = {};
  for (const balance of balances) {
    if (balance.cash !== null) {
      addCurrencyValue(
        calculatedValueByCurrency,
        balance.currency,
        balance.cash,
      );
    }
  }
  for (const position of positions) {
    if (
      position.marketValue !== null &&
      position.currency !== null &&
      !position.cashEquivalent
    ) {
      addCurrencyValue(
        calculatedValueByCurrency,
        position.currency,
        position.marketValue,
      );
    }
  }

  if (positions.some((position) => position.price === null)) {
    warnings.push("One or more positions are missing a current price.");
  }
  if (sourcePositions.results.some((position) => !["stock", "etf", "mutualfund", "crypto"].includes(position.instrument.kind.toLowerCase()))) {
    warnings.push("Special or unknown instrument valuation requires brokerage values; share-price multiplication was not assumed.");
  }

  const holdings = sourceAccount.sync_status.holdings;
  const holdingsUnavailable = holdings?.holdings_unavailable ?? false;
  if (holdingsUnavailable) {
    warnings.push(
      "This brokerage account does not expose holdings; use its reported total value.",
    );
  }
  if (!(holdings?.initial_sync_completed ?? false)) {
    warnings.push("The initial holdings sync has not completed.");
  }

  return {
    account: {
      id: sourceAccount.id,
      connectionId: sourceAccount.brokerage_authorization,
      name: sourceAccount.name,
      number: sourceAccount.number,
      institution: sourceAccount.institution_name,
      type: sourceAccount.raw_type ?? null,
      category: sourceAccount.account_category ?? null,
      metaType: sourceAccount.meta?.type ?? null,
      unifiedType:
        sourceAccount.meta?.unifiedAccountType ??
        sourceAccount.meta?.unified_account_type ??
        null,
      status: sourceAccount.status ?? null,
      isPaper: sourceAccount.is_paper,
      reportedTotal: sourceAccount.balance.total
        ? {
            amount: sourceAccount.balance.total.amount,
            currency: sourceAccount.balance.total.currency,
          }
        : null,
    },
    balances,
    positions,
    calculatedValueByCurrency,
    freshness: {
      positionsAsOf: isoDate(sourcePositions.data_freshness?.as_of),
      holdingsLastSyncedAt: isoDate(holdings?.last_successful_sync),
      initialSyncCompleted: holdings?.initial_sync_completed ?? false,
      holdingsUnavailable,
    },
    warnings,
  };
}
