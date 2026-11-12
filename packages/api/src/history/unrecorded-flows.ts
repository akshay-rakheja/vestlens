/**
 * Deposits and withdrawals SnapTrade's activity records leave out, seen on reported days (spec
 * 2026-11-04-unrecorded-flow-check-design.md). gap = reported − rebuilt: market moves change both sides alike, so the
 * gap stays level, and a flow the activities miss moves it by the flow's amount for good.
 */
export interface UnrecordedFlow { date: string; amount: number }
interface Point { date: string; value: number }

/** Aligned days needed on each side of a step. */
export const UNRECORDED_WINDOW = 5;
/** A step smaller than the larger of these (account currency; share of the account's value) is not flagged. */
export const UNRECORDED_MIN_AMOUNT = 100;
export const UNRECORDED_MIN_SHARE = 0.01;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const spreadOf = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
const usable = (p: Point) => Number.isFinite(p.value) && p.value > 0;

/**
 * Steps in reported − rebuilt over the days both sides value. A step at day i is flagged when the median gap of the
 * UNRECORDED_WINDOW days from i, minus that of the days before i, clears the materiality floor, and each window's
 * spread is at most half the step: one clean shift, not noise, drift or a timing blip that reverses. Adjacent flagged
 * days are one event (the largest step). Positive: money arrived that the records don't show; negative: it left.
 */
export function findUnrecordedFlows(reported: Point[], rebuilt: Point[]): UnrecordedFlow[] {
  const rebuiltOn = new Map(rebuilt.filter(usable).map((p) => [p.date, p.value]));
  const aligned = reported.filter(usable).filter((p) => rebuiltOn.has(p.date)).sort((a, b) => a.date.localeCompare(b.date));
  const gaps = aligned.map((p) => p.value - rebuiltOn.get(p.date)!);
  const W = UNRECORDED_WINDOW;
  const found: Array<UnrecordedFlow & { index: number }> = [];
  for (let i = W; i + W <= aligned.length; i++) {
    const before = gaps.slice(i - W, i), after = gaps.slice(i, i + W);
    const step = median(after) - median(before);
    const level = median(aligned.slice(i - W, i + W).map((p) => p.value));
    if (Math.abs(step) < Math.max(UNRECORDED_MIN_AMOUNT, UNRECORDED_MIN_SHARE * level)) continue;
    if (spreadOf(before) > Math.abs(step) / 2 || spreadOf(after) > Math.abs(step) / 2) continue;
    const last = found[found.length - 1];
    const event = { date: aligned[i].date, amount: Math.round(step), index: i };
    if (last && i - last.index <= 1) { if (Math.abs(step) > Math.abs(last.amount)) found[found.length - 1] = event; }
    else found.push(event);
  }
  return found.map(({ date, amount }) => ({ date, amount }));
}
