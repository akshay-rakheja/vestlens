import { HIDDEN, HIDDEN_FMT } from "./headlines";
import { call, card, emptyCard, OVERALL } from "./test-fixture";
import {
  barGeometry, callBars, callTally, costMeter, costTiles, keptVsSoldLine, overallGap, saleBars, scaleMax, shareFigures, shareText, shareTitle,
} from "./visual";

test("calls against the S&P 500: unmeasured-ahead first, then highest to lowest, short symbols in the detail", () => {
  const base = card();
  const rows = callBars({ ...base, calls: { ...base.calls, items: [...base.calls.items, call("XEQT.TO", 4)] } }.calls, "S&P 500");
  expect(rows.map((r) => [r.symbol, r.figure])).toEqual([["WIN", "Ahead"], ["AAA", "+12.5 pts"], ["XEQT.TO", "+4.0 pts"], ["CCC", "+2.0 pts"], ["BBB", "-15.0 pts"]]);
  expect(rows[0]!.unmeasured).toBe(true);
  expect(rows[2]!.detail).toMatch(/^XEQT: \+9\.0% from 2 January 2025 to 22 October 2026; \+4\.0 points against the S&P 500/);
});

test("calls against the TSX: TSX figures, holdings without one trail as No figure", () => {
  const base = card();
  const items = [call("AAA", 12.5), call("NUL", 3, { vsTsxPct: null }), call("BBB", -15)];
  const rows = callBars({ ...base.calls, items }, "TSX");
  expect(rows.map((r) => [r.symbol, r.value, r.figure])).toEqual([["AAA", 13.5, "+13.5 pts"], ["BBB", -14, "-14.0 pts"], ["NUL", null, "No figure"], ["WIN", null, "No figure"]]);
  expect(rows.some((r) => r.unmeasured)).toBe(false);
  expect(callTally({ ...base.calls, items }, "TSX")).toEqual({ ahead: 1, total: 2, marks: ["ahead", "behind"] });
});

test("the S&P 500 tally is the server's count; marks follow the rows", () => {
  expect(callTally(card().calls, "S&P 500")).toEqual({ ahead: 3, total: 4, marks: ["ahead", "ahead", "ahead", "behind"] });
});

test("sales: price change since, highest first, hidden amounts stay hidden in the detail", () => {
  const rows = saleBars(card().afterSold, HIDDEN_FMT);
  expect(rows.map((r) => [r.symbol, r.figure])).toEqual([["USX", "+10.0%"], ["DWN", "-25.0%"]]);
  expect(rows[0]!.detail).toContain(HIDDEN);
  expect(rows[0]!.detail).not.toMatch(/\$\d/);
});

test("bar geometry around the centre line, capped at the track's half", () => {
  expect(barGeometry(10, 20)).toEqual({ left: 50, width: 25 });
  expect(barGeometry(-10, 20)).toEqual({ left: 25, width: 25 });
  expect(barGeometry(-40, 20)).toEqual({ left: 0, width: 50 });
  expect(scaleMax([1, -2, null])).toBe(5);
  expect(scaleMax([1, -24.6])).toBe(24.6);
});

test("the gap to the S&P 500 in words", () => {
  expect(overallGap(OVERALL)).toBe("3.7 points behind the S&P 500 (est.)");
  expect(overallGap({ ...OVERALL, returnPct: 13.1, sp500Estimated: false })).toBe("1.0 point ahead of the S&P 500");
  expect(overallGap({ ...OVERALL, returnPct: 12.12, sp500Estimated: false })).toBe("Level with the S&P 500");
});

test("cost tiles: the estimate, too few trades, none, a gain; fees with est. and native amounts", () => {
  const base = card().tradingCost;
  expect(costTiles(base)).toEqual([
    { label: "Currency conversion", value: "about $300", sub: "1.11% of the value compared (est.)" },
    { label: "Fees", value: "$8.70", sub: "3 fees (est., Bank of Canada rate 2026-03-02; includes US$2)" },
  ]);
  const few = { ...base, conversion: { ...base.conversion, estimate: { ...base.conversion.estimate, costCad: null, sharePct: null, rows: 12 } } };
  expect(costTiles(few)[0]).toEqual({ label: "Currency conversion", value: "Not enough trades", sub: "12 of the 20 needed for an estimate" });
  const gain = { ...base, conversion: { ...base.conversion, estimate: { ...base.conversion.estimate, costCad: -40, sharePct: -0.2 } } };
  expect(costTiles(gain)[0]!.value).toBe("about $40 ahead");
  expect(costMeter(gain)).toBeNull();
  expect(costTiles(emptyCard().tradingCost)).toEqual([
    { label: "Currency conversion", value: "None", sub: "No trades between CAD and USD found" },
    { label: "Fees", value: "None", sub: "No fees recorded" },
  ]);
  const unread = { ...base, conversion: { ...base.conversion, rows: 0, cantTell: { count: 3, reasons: [] } } };
  expect(costTiles(unread)[0]!.sub).toBe("3 trades between CAD and USD couldn't be read");
  expect(costTiles(base, HIDDEN_FMT).map((t) => t.value)).toEqual([`about ${HIDDEN}`, HIDDEN]);
});

test("the per-$100 meter", () => {
  expect(costMeter(card().tradingCost)).toEqual({ share: 1.1111, line: "Every $100 converted cost about $1.11 against the Bank of Canada rate" });
});

test("kept vs sold in one line, with est. and native amounts", () => {
  expect(keptVsSoldLine(card().afterSold)).toBe("Kept vs sold, all together: +$115 (est., Bank of Canada rate 2026-10-22; includes US$100).");
  expect(keptVsSoldLine(emptyCard().afterSold)).toBeNull();
});

test("the share card: percentages and counts only, never amounts or symbols; missing figures left out", () => {
  const p = card({ overall: OVERALL });
  expect(shareTitle(p)).toBe("My 2026 investing");
  expect(shareFigures(p)).toEqual([
    { value: "+8.4%", label: "vs S&P 500 total return +12.1%" },
    { value: "3/4", label: "holdings ahead of the S&P 500 total return" },
    { value: "1.11%", label: "conversion cost (est.)" },
  ]);
  const text = shareText(p)!;
  expect(text).not.toMatch(/\$|AAA|BBB|CCC|USX|DWN|WIN/);
  expect(text).toContain("Not advice.");
  expect(shareFigures(card()).map((f) => f.label)).toEqual(["holdings ahead of the S&P 500 total return", "conversion cost (est.)"]);
  expect(shareFigures(emptyCard())).toEqual([]);
  expect(shareText(emptyCard())).toBeNull();
});
