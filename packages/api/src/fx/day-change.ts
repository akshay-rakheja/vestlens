import type { HomeAmount, HomeConverter } from "./home-currency.js";

const DAY_MS = 86_400_000;
const cents = (n: number) => Math.round(n * 100) / 100;

/** The weekday before `date` (holidays are covered by the converter's on-or-before rule). */
export function previousTradingDay(date: string): string {
  let t = Date.parse(`${date}T00:00:00Z`) - DAY_MS;
  while ([0, 6].includes(new Date(t).getUTCDay())) t -= DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * CAD day change of a holding: today's value at today's rate minus the previous close at the previous
 * trading day's rate. `day` is the session date the price refers to (the converter's today when omitted).
 * When either side cannot be converted the amount is null and `native` carries the native move.
 */
export function homeDayChange(
  conv: HomeConverter,
  input: { currency: string; units: number; price: number; previousClose: number; day: string | undefined; fallbackDay: string },
): HomeAmount {
  const { currency, units, price, previousClose, day } = input;
  const now = conv.at(units * price, currency, day);
  const before = conv.at(units * previousClose, currency, previousTradingDay(day ?? input.fallbackDay));
  const native = { amount: units * (price - previousClose), currency: now.native.currency };
  if (now.amount === null || before.amount === null) return { amount: null, estimated: false, rate: null, rateDate: null, native };
  return { amount: cents(now.amount - before.amount), estimated: now.estimated || before.estimated, rate: now.rate, rateDate: now.rateDate, native };
}
