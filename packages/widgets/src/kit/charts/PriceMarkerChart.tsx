import { formatCompactMoney, formatShortDate, formatUnits } from "../format";
import { ChartFrame, HIDDEN, W, atOrBefore, midIndex, moneyText, scaleY, type LegendItem } from "./ChartFrame";

// Many trades get smaller dots so the line stays readable; every trade is still drawn.
const DENSE_MARKERS = 40;

export interface PriceMarkerChartProps {
  prices: Array<{ date: string; close: number }>;
  avgCost: Array<{ date: string; avgCost: number | null }>;
  markers: Array<{ date: string; side: "buy" | "sell"; units: number; price: number | null }>;
  height?: number;
  label: string;
  /** Currency of closes and trade prices. */
  currency?: string;
  /** Hides trade units, trade prices and the average cost; closes are market data and stay visible. */
  privacy?: boolean;
}

/** Price line with an average-cost step line and buy (filled) / sell (hollow) markers. The text alternative carries dates and counts only. */
export function PriceMarkerChart(props: PriceMarkerChartProps) {
  const height = props.height ?? 110;
  const prices = props.prices
    .map((p) => ({ t: Date.parse(p.date), close: p.close, date: p.date }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.close))
    .sort((a, b) => a.t - b.t);
  if (prices.length < 2) {
    return <div class="w-muted" style={{ height: `${height}px`, display: "grid", placeItems: "center" }}>Price history is not available for this period.</div>;
  }
  const t0 = prices[0].t;
  const tail = prices[prices.length - 1];
  const t1 = tail.t === t0 ? t0 + 1 : tail.t;
  const cost = props.avgCost
    .map((c) => ({ t: Date.parse(c.date), v: c.avgCost !== null && Number.isFinite(c.avgCost) ? c.avgCost : null }))
    .filter((c) => Number.isFinite(c.t))
    .sort((a, b) => a.t - b.t);
  // Close on or before the marker date (first close if the marker precedes the series).
  const closeAt = (t: number) => {
    let found = prices[0].close;
    for (const p of prices) { if (p.t <= t) found = p.close; else break; }
    return found;
  };
  const placed = props.markers
    .map((m) => ({ ...m, t: Date.parse(m.date) }))
    .filter((m) => Number.isFinite(m.t) && m.t >= t0 && m.t <= t1)
    .sort((a, b) => a.t - b.t)
    .map((m) => ({ ...m, level: closeAt(m.t) }));
  const all = [...prices.map((p) => p.close), ...cost.flatMap((c) => (c.v === null ? [] : [c.v]))];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
  const y = scaleY(min, max, height);
  const pricePath = prices.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.close).toFixed(1)}`).join(" ");
  // Step line: hold each cost level until the next change; an unknown cost (null) breaks the line.
  const known = cost.filter((c) => c.t <= t1);
  const steps: string[] = [];
  known.forEach((c, i) => {
    if (c.v === null) return;
    const sx = x(Math.max(c.t, t0)).toFixed(1);
    const ex = x(Math.max(i + 1 < known.length ? Math.min(known[i + 1].t, t1) : t1, t0)).toFixed(1);
    steps.push(`${i > 0 && known[i - 1].v !== null ? "L" : "M"}${sx},${y(c.v).toFixed(1)}`, `L${ex},${y(c.v).toFixed(1)}`);
  });
  const buys = placed.filter((m) => m.side === "buy").length;
  const sells = placed.length - buys;
  const summary = `${props.label}: ${buys} ${buys === 1 ? "buy" : "buys"}, ${sells} ${sells === 1 ? "sell" : "sells"} (${prices[0].date} to ${tail.date})${steps.length ? "; dashed line shows average cost" : ""}`;
  const r = placed.length > DENSE_MARKERS ? 2 : 3.2;
  const privacy = !!props.privacy;
  const year = tail.date.slice(0, 4);
  const price = (v: number) => moneyText(v, props.currency, false);
  // The y range includes the average cost, so its labels are hidden with amounts when that line is drawn.
  const tick = (v: number) => (privacy && steps.length ? HIDDEN : props.currency ? formatCompactMoney(v, props.currency) : v.toFixed(2));
  const legend: LegendItem[] = [{ key: "price", label: "Price (close)", color: "var(--accent)" }];
  if (steps.length) legend.push({ key: "avg-cost", label: "Average cost", color: "var(--muted)", mark: "dashed" });
  if (buys) legend.push({ key: "buy", label: "Buy", color: "var(--up)", mark: "dot" });
  if (sells) legend.push({ key: "sell", label: "Sell", color: "var(--down)", mark: "ring" });
  const mid = midIndex(prices.map((p) => p.t));
  const tip = (i: number) => {
    const p = prices[i];
    // Trades on this close's date, or between it and the next close (a trade on a non-trading day).
    const next = i + 1 < prices.length ? prices[i + 1].t : Infinity;
    const lines = [`Close ${price(p.close)}`];
    for (const m of placed) {
      if (m.t < p.t || m.t >= next) continue;
      const verb = m.side === "buy" ? "Bought" : "Sold";
      lines.push(privacy ? `${verb} ${HIDDEN}${m.price !== null ? ` at ${HIDDEN}` : ""}` : `${verb} ${formatUnits(m.units)}${m.price !== null ? ` at ${price(m.price)}` : ""}`);
    }
    const dots = [{ y: y(p.close), color: "var(--accent)" }];
    const c = steps.length ? known[atOrBefore(known, p.t)] : undefined;
    if (c && c.v !== null) {
      lines.push(`Avg cost ${moneyText(c.v, props.currency, privacy)}`);
      dots.push({ y: y(c.v), color: "var(--muted)" });
    }
    return { title: formatShortDate(p.date, year), lines, dots };
  };
  return (
    <ChartFrame height={height} summary={summary} xs={prices.map((p) => x(p.t))} legend={legend} tip={tip}
      yTicks={[tick(max), tick((min + max) / 2), tick(min)]}
      xTicks={{ start: formatShortDate(prices[0].date, year), mid: mid >= 0 ? { at: x(prices[mid].t), text: formatShortDate(prices[mid].date, year) } : null, end: formatShortDate(tail.date, year) }}
      overlay={
        // Markers sit in an unscaled overlay (x in percent, y in pixels) so they stay round.
        <svg aria-hidden="true" height={height} width="100%" class="w-chart-layer" style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", overflow: "visible" }}>
          {placed.map((m) => (
            <circle data-side={m.side} cx={`${((x(m.t) / W) * 100).toFixed(2)}%`} cy={y(m.level)} r={r}
              fill={m.side === "buy" ? "var(--up)" : "var(--bg)"} stroke={m.side === "buy" ? "var(--up)" : "var(--down)"} stroke-width="1.6" />
          ))}
        </svg>
      }>
      {steps.length > 0 && <path data-series="avg-cost" d={steps.join(" ")} fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" />}
      <path data-series="price" d={pricePath} fill="none" stroke="var(--accent)" stroke-width="2.2" vector-effect="non-scaling-stroke" />
    </ChartFrame>
  );
}
