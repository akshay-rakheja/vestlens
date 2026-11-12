import {
  acrossTradesNote, afterSoldHeadline, bestWorstLines, callLine, callRows, callsCounts, callsHeadline, estimateLine, feesLine, HIDDEN, HIDDEN_FMT, keptVsSoldNote,
  LOADING_COPY, METHOD_NOTE, overallHeadline, saleLine, saleRow, storedSinceNote, TITLES, tradingCostHeadline,
} from "./headlines";
import { card, emptyCard, none, OVERALL } from "./test-fixture";

// The dashboard's expectations (packages/web/src/ReportCard.test.tsx), unchanged: the chat card says the same thing.
describe("report card wording, as on the dashboard", () => {
  it("section titles and headlines", () => {
    expect(Object.values(TITLES)).toEqual(["Overall", "Your calls against the market", "After you sold", "What trading cost you"]);
    expect(callsHeadline(card().calls)).toBe("3 of 4 holdings came out ahead of the S&P 500 since your first purchase");
    expect(afterSoldHeadline(card().afterSold)).toBe("Since you sold, the price rose after 1 of 2 sales");
    expect(tradingCostHeadline(card().tradingCost)).toBe("You converted about $27,000 between CAD and USD on trades");
    expect(overallHeadline(OVERALL)).toBe("From 1 January 2026 to 22 October 2026: your portfolio +8.4% against the S&P 500's +12.1% (est.)");
    expect(callsCounts(card().calls)).toBe("3 ahead, 1 behind, 1 couldn't tell");
  });

  it("highest and lowest, and the holdings ahead without a figure", () => {
    // WIN is ahead without a figure, so the best line says it is the highest with a figure.
    expect(bestWorstLines(card().calls)).toEqual([
      "Highest with a figure against the S&P 500: AAA, +12.5 points (+17.5% from 2 January 2025 to 22 October 2026)",
      "Lowest against the S&P 500: BBB, -15.0 points (-10.0% from 2 January 2025 to 22 October 2026)",
    ]);
    const lines = callRows(card().calls).map(callLine);
    expect(lines.find((l) => l.startsWith("WIN:"))).toMatch(/^WIN: \+50\.0% from 3 February 2025 to 2 March 2026; ahead of the S&P 500 by more than this comparison can put a number on/);
  });

  it("highest and lowest name short symbols", () => {
    const base = card();
    const best = { ...base.calls.summary.best!, symbol: "XEQT.TO" };
    expect(bestWorstLines({ ...base.calls, summary: { ...base.calls.summary, best } })[0]).toMatch(/^Highest with a figure against the S&P 500: XEQT, /);
  });

  it("the best line is plain when nothing is ahead without a figure", () => {
    const base = card();
    expect(bestWorstLines({ ...base.calls, summary: { ...base.calls.summary, aheadUnmeasured: [] } })[0])
      .toBe("Highest against the S&P 500: AAA, +12.5 points (+17.5% from 2 January 2025 to 22 October 2026)");
  });

  it("labels converted and estimated figures est., with the Bank of Canada date, and keeps the native amount visible", () => {
    const c = card();
    const sales = c.afterSold.items.map((i) => saleLine(saleRow(i)));
    expect(sales[0]).toContain("kept vs sold +$135 (est., BoC 2026-10-22; US$100)");
    expect(sales[0]).toContain("USX, sold 1 April 2026 at US$100 (est., Bank of Canada rate 2026-04-01; $135 as recorded)");
    expect(keptVsSoldNote(c.afterSold)).toContain("minus what the sales brought in (before fees)");
    expect(callRows(c.calls).map(callLine)).toContain("CCC: +7.0% from 2 January 2025 to 22 October 2026; +2.0 points against the S&P 500, +3.0 points against the TSX (est., Bank of Canada rate 2026-10-22)");
    expect(keptVsSoldNote(c.afterSold)).toMatch(/^Kept vs sold, all sales together: \+\$115 \(est\., Bank of Canada rate 2026-10-22; includes US\$100\)/);
    expect(estimateLine(c.tradingCost)).toBe("Estimated cost against the Bank of Canada rate: about $300 (est.; compares each trade with that day's closing price, so single trades are noisy), 1.11% of the value compared, over 20 trades, Bank of Canada rates from 2 January 2025 to 5 January 2026.");
    expect(feesLine(c.tradingCost)).toBe("Fees: $8.70 (est., Bank of Canada rate 2026-03-02; includes US$2)");
    expect(METHOD_NOTE).toContain("holdings count their dividends, before withholding, so the TSX comparison favours holdings slightly");
    expect(storedSinceNote(c.activityFrom)).toBe("In your stored activity since 2 January 2025.");
    expect(acrossTradesNote(c.tradingCost)).toBe("Across 25 trades in a security whose currency differs from the account's, from the amounts recorded.");
  });

  it("words empty sections plainly", () => {
    const e = emptyCard();
    expect(callsHeadline(e.calls)).toBe("None of your holdings could be compared with the S&P 500 yet");
    expect(afterSoldHeadline(e.afterSold)).toBe("No sales could be compared with the latest price yet");
    expect(tradingCostHeadline(e.tradingCost)).toBe("No trades between CAD and USD found");
    expect(feesLine(e.tradingCost)).toBe("No fees recorded");
    expect(estimateLine(e.tradingCost)).toBeNull();
    expect(keptVsSoldNote(e.afterSold)).toBeNull();
    expect(storedSinceNote(e.activityFrom)).toBeNull();
  });

  it("fewer than 20 usable trades: the converted value, and no cost estimate", () => {
    const base = card();
    const tradingCost = { ...base.tradingCost, conversion: { ...base.tradingCost.conversion, estimate: { ...base.tradingCost.conversion.estimate, rows: 7, costCad: null, sharePct: null } } };
    expect(tradingCostHeadline(tradingCost)).toBe("You converted about $27,000 between CAD and USD on trades");
    expect(estimateLine(tradingCost)).toBe("Too few trades with a closing price that day to estimate what the conversion cost (7 of the 20 needed).");
  });

  it("a conversion that came out ahead of the Bank of Canada rate", () => {
    const base = card();
    const tradingCost = { ...base.tradingCost, conversion: { ...base.tradingCost.conversion, estimate: { ...base.tradingCost.conversion.estimate, costCad: -40 } } };
    expect(estimateLine(tradingCost)).toMatch(/^Against the Bank of Canada rate, the conversions came out about \$40 ahead \(est\.;/);
  });

  it("says how many couldn't be read rather than that none were found", () => {
    const base = card();
    const unreadTrades = { count: 2, reasons: [{ reason: "the trade's amount or date wasn't recorded", count: 2, symbols: ["NOA"] }] };
    const unreadFees = { count: 1, reasons: [{ reason: "the fee amount wasn't recorded", count: 1, symbols: [] }] };
    const tradingCost = {
      conversion: { ...base.tradingCost.conversion, rows: 0, convertedCad: 0, cantTell: unreadTrades, estimate: { ...base.tradingCost.conversion.estimate, rows: 0, costCad: null, sharePct: null, rateDates: null, cantTell: none } },
      fees: { rows: 0, totalCad: 0, estimated: false, rateDate: null, native: [], cantTell: unreadFees },
    };
    expect(tradingCostHeadline(tradingCost)).toBe("2 trades between CAD and USD couldn't be read");
    expect(feesLine(tradingCost)).toBe("No fee amounts could be counted: 1 fee row couldn't be read");
  });

  it("the loading line", () => {
    expect(LOADING_COPY).toBe("Crunching your trades. The first time takes about 20 seconds.");
  });

  it("with amounts hidden, money, prices and share counts are hidden; percentages stay", () => {
    const c = card();
    const sale = saleRow(c.afterSold.items[0]!, HIDDEN_FMT);
    expect(sale.detail).not.toMatch(/\$|\b10 shares/);
    expect(sale.detail).toContain(HIDDEN);
    expect(sale.figure).toBe("+10.0%");
    for (const line of [tradingCostHeadline(c.tradingCost, HIDDEN_FMT), feesLine(c.tradingCost, HIDDEN_FMT), estimateLine(c.tradingCost, HIDDEN_FMT)!, keptVsSoldNote(c.afterSold, HIDDEN_FMT)!]) {
      expect(line).not.toMatch(/\$\d/);
      expect(line).toContain(HIDDEN);
    }
  });
});

describe("after you sold, with a split since the sale", () => {
  it("shows the raw close beside its split-adjusted figure, so the percent reads against the sale price (B8)", () => {
    const row = { ...card().afterSold.items[1]!, symbol: "SPL", salePrice: 200, latestClose: 105, latestCloseSplitAdjusted: 210, changePct: 5 };
    expect(saleRow(row).detail).toContain("latest close $105 on 22 October 2026 ($210 with the splits since the sale), +5.0%");
  });
});

