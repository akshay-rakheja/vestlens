// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DashboardPerformance } from "./App";
import { PerformancePanel } from "./PerformancePanel";

const figure = (value: number | null, estimated = false) => ({ value, estimated });
const view = (over: Partial<DashboardPerformance> = {}): DashboardPerformance => ({
  period: "YTD",
  periods: ["1M", "3M", "YTD", "1Y", "3Y", "ALL"],
  span: { start: "2026-01-02", end: "2026-10-28", partial: false },
  asOf: "2026-10-28T20:00:00.000Z",
  currency: "CAD",
  estimated: false,
  benchmark: { key: "sp500", name: "S&P 500", note: null, unavailableReason: null },
  benchmarks: [{ key: "sp500", name: "S&P 500" }, { key: "tsx", name: "S&P/TSX" }],
  figures: { investmentReturn: figure(0.167), benchmarkReturn: figure(0.139, true), netDeposits: figure(15200), marketGain: figure(47640.31), valueChange: figure(62840.31) },
  series: {
    you: [{ date: "2026-01-02", value: 1 }, { date: "2026-06-01", value: 1.08 }, { date: "2026-10-28", value: 1.167 }],
    benchmark: [{ date: "2026-01-02", value: 1 }, { date: "2026-06-01", value: 1.05 }, { date: "2026-10-28", value: 1.139 }],
  },
  deposits: {
    putIn: 18200, takenOut: -3000, estimated: false,
    byAccount: [
      { accountId: "f", label: "FHSA", name: "Wealthsimple FHSA", bucket: "fhsa", value: { amount: 8400, currency: "CAD" }, putIn: 8000, takenOut: 0 },
      { accountId: "t", label: "TFSA", name: "Wealthsimple TFSA", bucket: "tfsa", value: null, putIn: 7700, takenOut: 0 },
      { accountId: "r", label: "RRSP", name: "RRSP", bucket: "rrsp", value: null, putIn: 2500, takenOut: 0 },
      { accountId: "n", label: "Non-registered", name: "Wealthsimple Margin", bucket: "margin", value: { amount: 2725, currency: "CAD" }, putIn: 0, takenOut: -3000 },
    ],
    leftOut: ["Cash / money market"],
  },
  ...over,
});

afterEach(cleanup);

describe("PerformancePanel", () => {
  it("shows your investment return against the benchmark, the money you put in and the chart", async () => {
    render(<PerformancePanel api={{ getPerformance: vi.fn(async () => view()) }} />);
    expect(await screen.findByRole("heading", { name: "Investment return vs S&P 500" })).toBeInTheDocument();
    expect(screen.getByText("+16.7%")).toBeInTheDocument();
    expect(screen.getByText("+13.9%")).toBeInTheDocument();
    expect(screen.getAllByText("$18,200")[0]).toBeInTheDocument();
    expect(screen.getAllByText("-$3,000").length).toBeGreaterThan(0);
    expect(screen.getByText("$47,640")).toBeInTheDocument();
    // The working: one row per account, adding up to the net, and what is left out.
    expect(screen.getByRole("row", { name: /TFSA \$7,700\.00/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Net \$15,200\.00/ })).toBeInTheDocument();
    expect(screen.getByText(/Cash \/ money market isn't counted/)).toBeInTheDocument();
    expect(screen.getByText(/Money already invested on Jan 2 is the starting value, not money put in\./)).toBeInTheDocument();
    // Each row names the brokerage's own account and today's value, so it can be matched in Wealthsimple.
    expect(screen.getByText("Wealthsimple Margin, $2,725.00 now")).toBeInTheDocument();
    expect(screen.getByText(/first 60 days of a year can count toward the year before/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Investment return \+16\.7% from Jan 2 to Oct 28; S&P 500 \+13\.9%/ })).toBeInTheDocument();
  });

  it("puts your money-weighted return beside the same money in the index, labelled with its basis", async () => {
    const matched = view({
      benchmark: { key: "sp500", name: "S&P 500", label: "S&P 500 (total return)", basis: "total return, dividends reinvested", note: null, unavailableReason: null },
      figures: { ...view().figures, personalReturn: { value: 0.123, estimated: false, annualised: false }, matchedBenchmarkReturn: { value: 0.131, estimated: false, annualised: false }, matchedBenchmarkValue: figure(64010) },
    });
    render(<PerformancePanel api={{ getPerformance: vi.fn(async () => matched) }} />);
    expect(await screen.findByRole("heading", { name: "Investment return vs S&P 500 (total return)" })).toBeInTheDocument();
    const pair = screen.getByRole("group", { name: "Your return against the same money in the index" });
    expect(pair).toHaveTextContent("Your return+12.3%");
    expect(pair).toHaveTextContent("Same money in S&P 500 (total return)+13.1%");
    expect(pair).toHaveTextContent("worth $64,010");
    expect(screen.getByText(/had gone into the index on the same day/)).toBeInTheDocument();
    // The basis is in the label, so the subtitle doesn't repeat it.
    expect(screen.getByText("Time-weighted, with your deposits taken out.")).toBeInTheDocument();
  });

  it("a withdrawal larger than the index holding is said in words, and a yearly figure says /yr", async () => {
    const exhausted = view({ figures: { ...view().figures, personalReturn: { value: 0.08, estimated: false, annualised: true }, matchedBenchmarkReturn: { value: null, estimated: false, annualised: false, exhausted: true }, matchedBenchmarkValue: figure(null) } });
    render(<PerformancePanel api={{ getPerformance: vi.fn(async () => exhausted) }} />);
    const pair = await screen.findByRole("group", { name: "Your return against the same money in the index" });
    expect(pair).toHaveTextContent("+8.0% /yr");
    expect(pair).toHaveTextContent("You took out more than it would have held");
  });

  it("says what the benchmark leaves out beside the heading (B7)", async () => {
    render(<PerformancePanel api={{ getPerformance: vi.fn(async () => view({ benchmark: { key: "sp500", name: "S&P 500", basis: "price index, dividends excluded", note: null, unavailableReason: null } })) }} />);
    expect(await screen.findByText("Time-weighted, with your deposits taken out. S&P 500: price index, dividends excluded.")).toBeInTheDocument();
  });

  it("names accounts left out of the figures at the bottom, never with amounts", async () => {
    render(<PerformancePanel api={{ getPerformance: vi.fn(async () => view({ notInFigures: [
      { accountId: "m", label: "Automated portfolio", name: "Wealthsimple Trade PERSONAL", reason: "managed" },
      { accountId: "g", label: "Margin account", name: "Margin", reason: "history_gaps" },
    ] })) }} />);
    const note = await screen.findByText(/count only accounts whose numbers SnapTrade provides in full/);
    expect(note).toHaveTextContent("Not included: Automated portfolio (managed portfolios, whose holdings history SnapTrade doesn't provide).");
    expect(note).toHaveTextContent("Not included for this period: Margin account (gaps in its value history).");
    expect(screen.queryByRole("row", { name: /Automated portfolio/ })).not.toBeInTheDocument();
  });

  it("explains a value step SnapTrade's records don't show, and only blames US dollar rates when they are the reason", async () => {
    const sentence = "TFSA's value rose by about 5,000 CAD on Mar 3 with no deposit in SnapTrade's records: if you added money then, SnapTrade hasn't reported it, so these figures count it as investment gain.";
    const { unmount } = render(<PerformancePanel api={{ getPerformance: vi.fn(async () => view({ estimated: true, fxEstimated: false, unrecordedNote: sentence })) }} />);
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.getByText("Includes estimated values.")).toBeInTheDocument();
    expect(screen.queryByText(/Bank of Canada rate of each day/)).not.toBeInTheDocument();
    unmount();
    render(<PerformancePanel api={{ getPerformance: vi.fn(async () => view({ estimated: true, fxEstimated: true })) }} />);
    expect(await screen.findByText("Includes estimated values: US dollar amounts use the Bank of Canada rate of each day.")).toBeInTheDocument();
  });

  it("asks again for the period and benchmark picked", async () => {
    const getPerformance = vi.fn(async (_input: { period: string; benchmark?: string }) => view());
    render(<PerformancePanel api={{ getPerformance }} />);
    await screen.findByText("+16.7%");
    fireEvent.click(screen.getByRole("button", { name: "1Y" }));
    await waitFor(() => expect(getPerformance).toHaveBeenLastCalledWith({ period: "1Y" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "tsx" } });
    await waitFor(() => expect(getPerformance).toHaveBeenLastCalledWith({ period: "1Y", benchmark: "tsx" }));
  });

  it("says when there isn't enough history, hides itself before anything is linked, and survives a failure", async () => {
    render(<PerformancePanel api={{ getPerformance: vi.fn(async () => view({ series: { you: [{ date: "2026-10-28", value: 1 }], benchmark: [] } })) }} />);
    expect(await screen.findByText(/not enough history for this period yet/i)).toBeInTheDocument();
    cleanup();
    const { container } = render(<PerformancePanel api={{ getPerformance: vi.fn(async () => null) }} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    cleanup();
    render(<PerformancePanel api={{ getPerformance: vi.fn(async () => { throw new Error("x"); }) }} />);
    expect(await screen.findByText(/performance is unavailable right now/i)).toBeInTheDocument();
  });
});
