export interface IntradayHolding { ticker: string; units: number; currency: string; value: number }
export interface IntradayResult { points: Array<{ t: string; value: number }>; coverage: number; sessionDate: string | null; drawn: boolean }

const MIN_COVERAGE = 0.8;

/** Multiplier from `currency` into `scope`; null when it cannot be converted. */
function factor(currency: string, scope: string, fx: number | null): number | null {
  if (currency === scope) return 1;
  if (fx === null || !(fx > 0)) return null;
  if (currency === "USD" && scope === "CAD") return fx;
  if (currency === "CAD" && scope === "USD") return 1 / fx;
  return null;
}

/**
 * Today's estimated portfolio line: cash plus, per holding with bars, units times its last bar
 * price (its first bar price before that bar, so a late first bar adds no step). Every other
 * holding (no bars, unmappable, no usable fx, a third currency) contributes its reported value
 * as a constant, so the line keeps the portfolio's level. `value` is the reported market value already in the scope currency (0 when
 * unknown). Coverage = value of holdings with bars / total value. `sessionDate` is supplied by
 * the caller (exchange-local); it is never derived here.
 */
export function intradayLine(input: {
  holdings: IntradayHolding[]; cash: number; scopeCurrency: string; fx: number | null;
  bars: Map<string, Array<{ t: string; price: number }>>; sessionDate: string | null;
}): IntradayResult {
  const live: Array<{ mult: number; bars: Array<{ ms: number; price: number }>; value: number }> = [];
  let constant = input.cash;
  for (const h of input.holdings) {
    const f = factor(h.currency, input.scopeCurrency, input.fx);
    const bars = input.bars.get(h.ticker);
    const sorted = f === null || !bars ? [] : bars.map((b) => ({ ms: Date.parse(b.t), price: b.price })).filter((b) => Number.isFinite(b.ms)).sort((a, b) => a.ms - b.ms);
    if (f !== null && sorted.length) live.push({ mult: h.units * f, bars: sorted, value: h.value });
    else constant += h.value;
  }
  const total = input.holdings.reduce((s, h) => s + h.value, 0);
  const coverage = total > 0 ? live.reduce((s, x) => s + x.value, 0) / total : 0;

  const times = [...new Set(live.flatMap((x) => x.bars.map((b) => b.ms)))].sort((a, b) => a - b);
  const cursor = live.map(() => -1);
  const points = times.map((ms) => {
    let value = constant;
    live.forEach((x, i) => {
      while (cursor[i] + 1 < x.bars.length && x.bars[cursor[i] + 1].ms <= ms) cursor[i]++;
      // Before its first bar a covered holding is valued at that first bar's price (no step).
      value += x.mult * x.bars[Math.max(cursor[i], 0)].price;
    });
    return { t: new Date(ms).toISOString(), value };
  });
  return { points, coverage, sessionDate: input.sessionDate, drawn: coverage >= MIN_COVERAGE && points.length >= 2 };
}
