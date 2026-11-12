import { describe, expect, it } from "vitest";
import { findUnrecordedFlows } from "./unrecorded-flows.js";

const day = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
/** Rebuilt values follow the market; reported = rebuilt + gap(i). */
function series(n: number, gap: (i: number) => number, market: (i: number) => number = (i) => 10_000 * (1 + 0.004 * Math.sin(i))) {
  const rebuilt = Array.from({ length: n }, (_, i) => ({ date: day(i), value: market(i) }));
  const reported = rebuilt.map((p, i) => ({ date: p.date, value: p.value + gap(i) }));
  return { reported, rebuilt };
}

describe("findUnrecordedFlows", () => {
  it("finds a deposit the activities miss: the reported value steps up and stays up", () => {
    const { reported, rebuilt } = series(20, (i) => (i >= 10 ? 5000 : 0));
    expect(findUnrecordedFlows(reported, rebuilt)).toEqual([{ date: day(10), amount: 5000 }]);
  });

  it("finds money that left without a record (or a recorded deposit that never arrived) as a negative step", () => {
    const { reported, rebuilt } = series(20, (i) => (i >= 12 ? -400 : 0), () => 20_000);
    expect(findUnrecordedFlows(reported, rebuilt)).toEqual([{ date: day(12), amount: -400 }]);
  });

  it("market moves move both sides alike and flag nothing, even large ones", () => {
    const { reported, rebuilt } = series(30, () => 0, (i) => 10_000 * (i < 15 ? 1 : 1.3));
    expect(findUnrecordedFlows(reported, rebuilt)).toEqual([]);
  });

  it("a constant gap (the opening-cash anchor) is no event", () => {
    const { reported, rebuilt } = series(20, () => 2500);
    expect(findUnrecordedFlows(reported, rebuilt)).toEqual([]);
  });

  it("a recorded deposit the snapshot shows two days late reverses and is not flagged", () => {
    const { reported, rebuilt } = series(20, (i) => (i === 10 || i === 11 ? -3000 : 0));
    expect(findUnrecordedFlows(reported, rebuilt)).toEqual([]);
  });

  it("a step below the materiality floor is ignored: 100 units and 1% of the account", () => {
    const find = (step: number, value: number) => { const s = series(20, (i) => (i >= 10 ? step : 0), () => value); return findUnrecordedFlows(s.reported, s.rebuilt); };
    expect(find(90, 5_000)).toEqual([]);
    expect(find(150, 50_000)).toEqual([]);
    expect(find(600, 50_000)).toEqual([{ date: day(10), amount: 600 }]);
  });

  it("a gap that drifts (a holding the rebuild prices wrongly) is noise, not a step", () => {
    const { reported, rebuilt } = series(30, (i) => i * 60);
    expect(findUnrecordedFlows(reported, rebuilt)).toEqual([]);
  });

  it("needs five aligned days either side, so a step near either end waits for more history", () => {
    const { reported, rebuilt } = series(12, (i) => (i >= 8 ? 5000 : 0));
    expect(findUnrecordedFlows(reported, rebuilt)).toEqual([]);
  });

  it("only compares days present on both sides, and finds two separate events", () => {
    const { reported, rebuilt } = series(40, (i) => (i >= 10 ? 5000 : 0) + (i >= 25 ? -2000 : 0));
    const sparse = rebuilt.filter((_, i) => i % 7 !== 5);
    expect(findUnrecordedFlows(reported, sparse)).toEqual([{ date: day(10), amount: 5000 }, { date: day(25), amount: -2000 }]);
  });

  it("snapshot-timing noise (±0.6% of the account) flags nothing; a real step through it still shows", () => {
    const noise = (i: number) => 60 * Math.sin(i * 2.3) * Math.cos(i * 0.7);
    const quiet = series(40, noise);
    expect(findUnrecordedFlows(quiet.reported, quiet.rebuilt)).toEqual([]);
    const stepped = series(40, (i) => noise(i) + (i >= 20 ? 1500 : 0));
    const found = findUnrecordedFlows(stepped.reported, stepped.rebuilt);
    expect(found).toHaveLength(1);
    expect(found[0].date).toBe(day(20));
    expect(Math.abs(found[0].amount - 1500)).toBeLessThan(120);
  });

  it("ignores non-finite and non-positive values", () => {
    const { reported, rebuilt } = series(20, (i) => (i >= 10 ? 5000 : 0));
    reported[3] = { ...reported[3], value: Number.NaN };
    rebuilt[4] = { ...rebuilt[4], value: 0 };
    expect(findUnrecordedFlows(reported, rebuilt)).toEqual([{ date: day(10), amount: 5000 }]);
  });
});
