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

const nullableDateSchema = z
  .string()
  .nullable()
  .optional()
  .transform((value, context) => {
    if (!value) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [year, month, day] = value.split("-").map(Number);
      const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      const daysInMonth = [0, 31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month]) {
        return value;
      }
      context.addIssue({ code: "custom", message: "Expected a valid date" });
      return z.NEVER;
    }
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) {
      context.addIssue({ code: "custom", message: "Expected a valid date" });
      return z.NEVER;
    }
    return date.toISOString();
  });

const symbolSchema = z
  .looseObject({
    symbol: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const optionSymbolSchema = z
  .looseObject({ ticker: z.string().min(1) })
  .nullable()
  .optional();

const orderSchema = z.looseObject({
  brokerage_order_id: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  universal_symbol: symbolSchema,
  option_symbol: optionSymbolSchema,
  symbol: z.string().min(1).optional(),
  action: z.string().nullable().optional(),
  total_quantity: nullableNumberSchema,
  open_quantity: nullableNumberSchema,
  canceled_quantity: nullableNumberSchema,
  filled_quantity: nullableNumberSchema,
  execution_price: nullableNumberSchema,
  limit_price: nullableNumberSchema,
  stop_price: nullableNumberSchema,
  order_type: z.string().nullable().optional(),
  time_in_force: z.string().nullable().optional(),
  time_placed: nullableDateSchema,
  time_updated: nullableDateSchema,
  time_executed: nullableDateSchema,
});

const activitySchema = z.looseObject({
  id: z.string().min(1).optional(),
  symbol: symbolSchema,
  option_symbol: optionSymbolSchema,
  price: nullableNumberSchema,
  units: nullableNumberSchema,
  amount: nullableNumberSchema,
  currency: z
    .looseObject({ code: z.string().min(1).optional() })
    .nullable()
    .optional(),
  currency_universal_symbol: z
    .looseObject({ symbol: z.string().min(1).optional() })
    .nullable()
    .optional(),
  type: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  trade_date: nullableDateSchema,
  settlement_date: nullableDateSchema,
  fee: nullableNumberSchema,
  fx_rate: nullableNumberSchema,
});

const activitiesResponseSchema = z.looseObject({
  data: z.array(activitySchema).default([]),
  pagination: z
    .looseObject({
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
      total: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const balanceHistorySchema = z.looseObject({
  currency: z.string().min(1).optional(),
  history: z
    .array(
      z.looseObject({
        date: z.string().min(1),
        total_value: nullableNumberSchema,
      }),
    )
    .default([]),
});

export interface NormalizedOrder {
  id: string | null;
  status: string;
  symbol: string | null;
  description: string | null;
  action: string | null;
  totalQuantity: number | null;
  openQuantity: number | null;
  canceledQuantity: number | null;
  filledQuantity: number | null;
  executionPrice: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  orderType: string | null;
  timeInForce: string | null;
  placedAt: string | null;
  updatedAt: string | null;
  executedAt: string | null;
}

export interface NormalizedActivity {
  id: string | null;
  type: string;
  symbol: string | null;
  description: string | null;
  price: number | null;
  units: number | null;
  amount: number | null;
  currency: string | null;
  fee: number | null;
  fxRate: number | null;
  tradeDate: string | null;
  settlementDate: string | null;
}

export interface NormalizedBalanceHistory {
  currency: string | null;
  points: Array<{ date: string; totalValue: number }>;
}

export function normalizeOrders(input: unknown): NormalizedOrder[] {
  return z.array(orderSchema).parse(input).map((order) => ({
    id: order.brokerage_order_id ?? null,
    status: order.status ?? "UNKNOWN",
    symbol:
      order.universal_symbol?.symbol ??
      order.option_symbol?.ticker ??
      order.symbol ??
      null,
    description: order.universal_symbol?.description ?? null,
    action: order.action ?? null,
    totalQuantity: order.total_quantity,
    openQuantity: order.open_quantity,
    canceledQuantity: order.canceled_quantity,
    filledQuantity: order.filled_quantity,
    executionPrice: order.execution_price,
    limitPrice: order.limit_price,
    stopPrice: order.stop_price,
    orderType: order.order_type ?? null,
    timeInForce: order.time_in_force ?? null,
    placedAt: order.time_placed,
    updatedAt: order.time_updated,
    executedAt: order.time_executed,
  }));
}

export function normalizeActivities(input: unknown): {
  items: NormalizedActivity[];
  pagination: { offset: number; limit: number; total: number };
} {
  const response = activitiesResponseSchema.parse(input);
  const items = response.data.map((activity) => ({
    id: activity.id ?? null,
    type: activity.type ?? "UNKNOWN",
    symbol:
      activity.symbol?.symbol ??
      activity.option_symbol?.ticker ??
      null,
    description: activity.description ?? activity.symbol?.description ?? null,
    price: activity.price,
    units: activity.units,
    amount: activity.amount,
    currency:
      activity.currency?.code ??
      activity.currency_universal_symbol?.symbol ??
      null,
    fee: activity.fee,
    fxRate: activity.fx_rate,
    tradeDate: activity.trade_date,
    settlementDate: activity.settlement_date,
  }));

  return {
    items,
    pagination: {
      offset: response.pagination?.offset ?? 0,
      limit: response.pagination?.limit ?? items.length,
      total: response.pagination?.total ?? items.length,
    },
  };
}

export function normalizeBalanceHistory(
  input: unknown,
): NormalizedBalanceHistory {
  const response = balanceHistorySchema.parse(input);
  return {
    currency: response.currency ?? null,
    points: response.history
      .filter(
        (point): point is typeof point & { total_value: number } =>
          point.total_value !== null,
      )
      .map((point) => ({
        date: nullableDateSchema.parse(point.date)!,
        totalValue: point.total_value,
      }))
      .sort((left, right) => left.date.localeCompare(right.date)),
  };
}

const GROSS_TYPES = new Set(["DIVIDEND", "DISTRIBUTION"]);
export const HISTORY_ANALYTICS_NOTE =
  "pageActivityTotals are raw sums of reported amounts over the returned page only (see activities.pagination.total), " +
  "not netted for transfers between your accounts; DIVIDEND and DISTRIBUTION amounts are gross, with withholding tax in separate TAX rows. " +
  "balanceChangeIncludingDeposits comes from SnapTrade's experimental balance history and includes deposits and withdrawals, so it is not a return.";

export function summarizeAccountHistory(input: {
  orders: NormalizedOrder[];
  activities: NormalizedActivity[];
  balanceHistory: NormalizedBalanceHistory;
}) {
  const orderStatusCounts: Record<string, number> = {};
  for (const order of input.orders) {
    orderStatusCounts[order.status] = (orderStatusCounts[order.status] ?? 0) + 1;
  }

  const activityGroups = new Map<
    string,
    { type: string; currency: string; count: number; amount: number; amountBasis?: "gross" }
  >();
  for (const activity of input.activities) {
    const currency = activity.currency ?? "UNKNOWN";
    const key = `${activity.type}\u0000${currency}`;
    const group = activityGroups.get(key) ?? {
      type: activity.type,
      currency,
      count: 0,
      amount: 0,
      // Withholding tax is reported in separate TAX rows, so dividend amounts are gross.
      ...(GROSS_TYPES.has(activity.type.toUpperCase()) ? { amountBasis: "gross" as const } : {}),
    };
    group.count += 1;
    if (activity.amount !== null) group.amount += activity.amount;
    activityGroups.set(key, group);
  }

  const points = input.balanceHistory.points;
  const first = points[0];
  const last = points.at(-1);
  const absoluteChange = first && last ? last.totalValue - first.totalValue : null;
  const balanceChangeIncludingDeposits =
    first && last && absoluteChange !== null
      ? {
          currency: input.balanceHistory.currency,
          startDate: first.date,
          endDate: last.date,
          startValue: first.totalValue,
          endValue: last.totalValue,
          absoluteChange,
          percentChange:
            first.totalValue === 0
              ? null
              : (absoluteChange / first.totalValue) * 100,
          estimated: true as const,
          includesDeposits: true as const,
        }
      : null;

  return {
    orderStatusCounts,
    pageActivityTotals: Array.from(activityGroups.values()).sort(
      (left, right) =>
        left.type.localeCompare(right.type) ||
        left.currency.localeCompare(right.currency),
    ),
    balanceChangeIncludingDeposits,
    note: HISTORY_ANALYTICS_NOTE,
  };
}
