// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PortfolioExperience } from "./App";
import { LOADING_COPY, METHOD_NOTE, ReportCardPage, SLOW_COPY, SLOW_MS, type ReportCardView } from "./ReportCard";

// Synthetic symbols, dates, prices and amounts only.
const call = (symbol: string, vs: number, over: Record<string, unknown> = {}) => ({
  symbol, returnPct: vs + 5, vsSp500Pct: vs, vsTsxPct: vs + 1, startDate: "2025-01-02", endDate: "2026-10-22", estimated: false, rateDate: null as string | null, ...over,
});
const none = { count: 0, reasons: [] };

const card = (over: Partial<ReportCardView> = {}): ReportCardView => ({
  asOf: "2026-10-23",
  activityFrom: "2025-01-02",
  calls: {
    checked: 5,
    items: [call("AAA", 12.5), call("CCC", 2, { estimated: true, rateDate: "2026-10-22" }), call("BBB", -15)],
    summary: {
      compared: 4, ahead: 3, behind: 1, even: 0, best: call("AAA", 12.5), worst: call("BBB", -15),
      aheadUnmeasured: [{ symbol: "WIN", returnPct: 50, startDate: "2025-02-03", endDate: "2026-03-02", estimated: false, rateDate: null }],
    },
    cantTell: { count: 1, reasons: [{ reason: "stored activity doesn't cover this holding's full history", count: 1, symbols: ["DDD"] }] },
  },
  afterSold: {
    items: [
      {
        symbol: "USX", date: "2026-04-01", units: 10, salePrice: 100, currency: "USD", estimated: true, priceRateDate: "2026-04-01",
        recordedPrice: { amount: 135, currency: "CAD" }, latestClose: 110, latestCloseDate: "2026-10-22",
        changePct: 10, keptVsSold: { native: { amount: 100, currency: "USD" }, cad: 135, estimated: true, rateDate: "2026-10-22" },
      },
      {
        symbol: "DWN", date: "2026-02-02", units: 4, salePrice: 20, currency: "CAD", estimated: false, priceRateDate: null, recordedPrice: null,
        latestClose: 15, latestCloseDate: "2026-10-22",
        changePct: -25, keptVsSold: { native: { amount: -20, currency: "CAD" }, cad: -20, estimated: false, rateDate: null },
      },
    ],
    summary: { sells: 2, rose: 1, fell: 1, unchanged: 0, keptVsSoldCad: 115, estimated: true, rateDate: "2026-10-22", notConverted: 0, native: [{ currency: "USD", amount: 100 }] },
    cantTell: { count: 1, reasons: [{ reason: "no price history for this symbol", count: 1, symbols: ["NOH"] }] },
  },
  tradingCost: {
    conversion: {
      rows: 25, convertedCad: 27000, estimated: false, rateDate: null, native: [], cantTell: { count: 1, reasons: [{ reason: "the trade's amount or date wasn't recorded", count: 1, symbols: ["NOA"] }] },
      estimate: {
        rows: 20, minRows: 20, costCad: 300, sharePct: 1.1111, estimated: true, rateDates: { first: "2025-01-02", last: "2026-01-05" },
        cantTell: { count: 1, reasons: [{ reason: "no closing price within 3 days of the trade", count: 1, symbols: ["GAP"] }] },
      },
    },
    fees: { rows: 3, totalCad: 8.7, estimated: true, rateDate: "2026-03-02", native: [{ currency: "USD", amount: 2 }], cantTell: none },
  },
  overall: null,
  ...over,
});

const page = (view: ReportCardView) => render(<ReportCardPage api={{ getReportCard: async () => view } as never} onBack={vi.fn()} />);

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("ReportCardPage", () => {
  it("renders each section's headline from the API, in order", async () => {
    page(card());
    expect(await screen.findByText("3 of 4 holdings came out ahead of the S&P 500 since your first purchase")).toBeInTheDocument();
    expect(screen.getByText("Since you sold, the price rose after 1 of 2 sales")).toBeInTheDocument();
    expect(screen.getByText("You converted about $27,000 between CAD and USD on trades")).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Your calls against the market", "After you sold", "What trading cost you"]);
    expect(screen.queryByText("Overall")).toBeNull();
    expect(screen.getByText(METHOD_NOTE)).toBeInTheDocument();
  });

  it("lists highest and lowest, the holdings ahead without a figure, and each section's couldn't-tell reasons", async () => {
    page(card());
    // WIN is ahead without a figure, so the best line says it is the highest with a figure.
    expect(await screen.findByText("Highest with a figure against the S&P 500: AAA, +12.5 points (+17.5% from 2 January 2025 to 22 October 2026)")).toBeInTheDocument();
    expect(screen.queryByText(/^Highest against the S&P 500/)).toBeNull();
    expect(screen.getByText("Lowest against the S&P 500: BBB, -15.0 points (-10.0% from 2 January 2025 to 22 October 2026)")).toBeInTheDocument();
    expect(screen.getByText(/WIN: \+50\.0% from 3 February 2025 to 2 March 2026; ahead of the S&P 500 by more than this comparison can put a number on/)).toBeInTheDocument();
    expect(screen.getByText("Couldn't tell for 1: stored activity doesn't cover this holding's full history (DDD)")).toBeInTheDocument();
    expect(screen.getByText("Couldn't tell for 1: no price history for this symbol (NOH)")).toBeInTheDocument();
    expect(screen.getByText("Couldn't tell for 1: the trade's amount or date wasn't recorded (NOA)")).toBeInTheDocument();
    expect(screen.getByText("Left out of the cost estimate 1: no closing price within 3 days of the trade (GAP)")).toBeInTheDocument();
  });

  it("labels converted and estimated figures est., with the Bank of Canada date, and keeps the native amount visible", async () => {
    page(card());
    await screen.findByText(/came out ahead/);
    const text = document.body.textContent ?? "";
    expect(text).toContain("kept vs sold +$135 (est., BoC 2026-10-22; US$100)");
    expect(text).toContain("USX, sold 1 April 2026 at US$100 (est., Bank of Canada rate 2026-04-01; $135 as recorded)");
    expect(text).toContain("minus what the sales brought in (before fees)");
    expect(text).toContain("CCC: +7.0% from 2 January 2025 to 22 October 2026; +2.0 points against the S&P 500, +3.0 points against the TSX (est., Bank of Canada rate 2026-10-22)");
    expect(text).toContain("Kept vs sold, all sales together: +$115 (est., Bank of Canada rate 2026-10-22; includes US$100)");
    expect(text).toContain("Estimated cost against the Bank of Canada rate: about $300 (est.; compares each trade with that day's closing price, so single trades are noisy), 1.11% of the value compared, over 20 trades, Bank of Canada rates from 2 January 2025 to 5 January 2026.");
    expect(text).toContain("Fees: $8.70 (est., Bank of Canada rate 2026-03-02; includes US$2)");
    expect(METHOD_NOTE).toContain("holdings count their dividends, before withholding, so the TSX comparison favours holdings slightly");
  });

  it("states facts only: no advice or judgement words", async () => {
    page(card({ overall: { period: "YTD", from: "2026-01-01", to: "2026-10-22", returnPct: 8.4, sp500Pct: 12.1, returnEstimated: false, sp500Estimated: true } }));
    await screen.findByText(/came out ahead/);
    expect(document.body.textContent).not.toMatch(/\b(should|consider|mistakes?|bad calls?|better off|recommend\w*|regret\w*|wrong)\b/i);
  });

  it("shows Overall only when present", async () => {
    page(card({ overall: { period: "YTD", from: "2026-01-01", to: "2026-10-22", returnPct: 8.4, sp500Pct: 12.1, returnEstimated: false, sp500Estimated: true } }));
    expect(await screen.findByRole("heading", { level: 2, name: "Overall" })).toBeInTheDocument();
    expect(screen.getByText("From 1 January 2026 to 22 October 2026: your portfolio +8.4% against the S&P 500's +12.1% (est.)")).toBeInTheDocument();
  });

  it("words empty sections plainly, and a conversion that came out ahead of the Bank of Canada rate", async () => {
    const empty = card();
    page({
      ...empty,
      calls: { checked: 0, items: [], summary: { compared: 0, ahead: 0, behind: 0, even: 0, best: null, worst: null, aheadUnmeasured: [] }, cantTell: none },
      afterSold: { items: [], summary: { sells: 0, rose: 0, fell: 0, unchanged: 0, keptVsSoldCad: null, estimated: false, rateDate: null, notConverted: 0, native: [] }, cantTell: none },
      tradingCost: {
        conversion: { ...empty.tradingCost.conversion, rows: 0, convertedCad: 0, cantTell: none, estimate: { ...empty.tradingCost.conversion.estimate, rows: 0, costCad: null, sharePct: null, rateDates: null, cantTell: none } },
        fees: { rows: 0, totalCad: 0, estimated: false, rateDate: null, native: [], cantTell: none },
      },
    });
    expect(await screen.findByText("None of your holdings could be compared with the S&P 500 yet")).toBeInTheDocument();
    expect(screen.getByText("No sales could be compared with the latest price yet")).toBeInTheDocument();
    expect(screen.getByText("No trades between CAD and USD found")).toBeInTheDocument();
    expect(screen.getByText("No fees recorded")).toBeInTheDocument();
  });

  it("the best line is plain when nothing is ahead without a figure", async () => {
    const base = card();
    page({ ...base, calls: { ...base.calls, summary: { ...base.calls.summary, aheadUnmeasured: [] } } });
    expect(await screen.findByText("Highest against the S&P 500: AAA, +12.5 points (+17.5% from 2 January 2025 to 22 October 2026)")).toBeInTheDocument();
  });

  it("fewer than 20 usable trades: the converted value, and no cost estimate", async () => {
    const base = card();
    const conversion = { ...base.tradingCost.conversion, estimate: { ...base.tradingCost.conversion.estimate, rows: 7, costCad: null, sharePct: null } };
    page({ ...base, tradingCost: { ...base.tradingCost, conversion } });
    expect(await screen.findByText("You converted about $27,000 between CAD and USD on trades")).toBeInTheDocument();
    expect(screen.getByText("Too few trades with a closing price that day to estimate what the conversion cost (7 of the 20 needed).")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Estimated cost");
  });

  it("says how many couldn't be read rather than that none were found", async () => {
    const base = card();
    const unreadTrades = { count: 2, reasons: [{ reason: "the trade's amount or date wasn't recorded", count: 2, symbols: ["NOA"] }] };
    const unreadFees = { count: 1, reasons: [{ reason: "the fee amount wasn't recorded", count: 1, symbols: [] }] };
    page({
      ...base,
      tradingCost: {
        conversion: { ...base.tradingCost.conversion, rows: 0, convertedCad: 0, cantTell: unreadTrades, estimate: { ...base.tradingCost.conversion.estimate, rows: 0, costCad: null, sharePct: null, rateDates: null, cantTell: none } },
        fees: { rows: 0, totalCad: 0, estimated: false, rateDate: null, native: [], cantTell: unreadFees },
      },
    });
    expect(await screen.findByText("2 trades between CAD and USD couldn't be read")).toBeInTheDocument();
    expect(screen.getByText("No fee amounts could be counted: 1 fee row couldn't be read")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/No trades between CAD and USD found|No fees recorded/);
  });

  it("shows the first ten holdings, then all on request", async () => {
    const items = Array.from({ length: 12 }, (_, i) => call(`S${String(i).padStart(2, "0")}`, 12 - i));
    const base = card();
    page({ ...base, calls: { ...base.calls, items, summary: { ...base.calls.summary, aheadUnmeasured: [] } } });
    await screen.findByText(/S00:/);
    expect(screen.queryByText(/S11:/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all 12" }));
    expect(screen.getByText(/S11:/)).toBeInTheDocument();
  });

  it("shows a fixed line when the report can't be loaded", async () => {
    render(<ReportCardPage api={{ getReportCard: async () => { throw new Error("boom <b>"); } } as never} onBack={() => undefined} />);
    expect(await screen.findByText("The report card is unavailable right now.")).toBeInTheDocument();
  });
});

describe("ReportCardPage: loading", () => {
  it("says what is happening, with a progress indicator", () => {
    render(<ReportCardPage api={{ getReportCard: () => new Promise(() => undefined) } as never} onBack={vi.fn()} />);
    expect(LOADING_COPY).toBe("Crunching your trades. The first time takes about 20 seconds.");
    expect(screen.getByText(LOADING_COPY)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.queryByText(SLOW_COPY)).toBeNull();
  });

  it("after 60 seconds: taking longer than usual, and a retry that asks again", async () => {
    vi.useFakeTimers();
    const getReportCard = vi.fn().mockReturnValueOnce(new Promise(() => undefined)).mockResolvedValueOnce(card());
    render(<ReportCardPage api={{ getReportCard } as never} onBack={vi.fn()} />);
    expect(SLOW_MS).toBe(60_000);
    act(() => { vi.advanceTimersByTime(SLOW_MS - 1); });
    expect(screen.queryByText(SLOW_COPY)).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(SLOW_COPY).toBe("Taking longer than usual");
    expect(screen.getByText(SLOW_COPY)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(getReportCard).toHaveBeenCalledTimes(2);
    expect(screen.getByText("3 of 4 holdings came out ahead of the S&P 500 since your first purchase")).toBeInTheDocument();
    expect(screen.queryByText(SLOW_COPY)).toBeNull();
  });
});

describe("ReportCardPage: shareable card", () => {
  it("opens a preview of the card from the report's numbers", async () => {
    page(card());
    fireEvent.click(await screen.findByRole("button", { name: "Make a shareable card" }));
    const svg = document.querySelector("svg.share-card-svg")!;
    expect(svg.textContent).toContain("My investing, by VestLens");
    expect(svg.textContent).toContain("3 of 4");
    expect(svg.textContent).not.toContain("AAA");
    fireEvent.click(screen.getByRole("button", { name: "Close the shareable card" }));
    expect(document.querySelector("svg.share-card-svg")).toBeNull();
  });
});

describe("App routing", () => {
  const auth = { isLoading: false, isAuthenticated: true, userName: "Synthetic", login: async () => undefined, logout: () => undefined };
  const api = {
    getPortfolio: async () => ({ connectionRequired: false, generatedAt: "2026-10-24T20:00:00.000Z", totals: [], accounts: [], errors: [] }),
    getConnections: async () => [], createConnectionSession: async () => ({ portalUrl: "https://x.invalid" }), getReportCard: async () => card(),
  };

  it("opens the report card when ?view=report is set", async () => {
    window.history.pushState({}, "", "/?view=report");
    render(<PortfolioExperience auth={auth} api={api} />);
    expect(await screen.findByText("3 of 4 holdings came out ahead of the S&P 500 since your first purchase")).toBeInTheDocument();
    window.history.pushState({}, "", "/");
  });
});
