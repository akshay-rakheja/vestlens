import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { Overview } from "./Overview";
import type { OverviewPayload } from "./types";

function payload(over: Partial<OverviewPayload> = {}): OverviewPayload {
  return {
    portfolio: { connectionRequired: false, generatedAt: "2026-10-15T15:00:00Z", totals: [{ currency: "CAD", amount: 248310.42 }, { currency: "USD", amount: 18940.1 }], accounts: [], errors: [] },
    summary: {
      primaryCurrency: "CAD", totals: [{ currency: "CAD", amount: 248310.42 }, { currency: "USD", amount: 18940.1 }],
      dayChange: [{ currency: "CAD", amount: 1204.18, fraction: 0.0049, coverage: 1 }], unrealizedGain: [{ currency: "CAD", amount: 31402.77 }],
      cash: [{ currency: "CAD", amount: 7710 }, { currency: "USD", amount: 412 }], largestHolding: { symbol: "XEQT.TO", fraction: 0.312 },
      allocationCurrency: "CAD", allocation: [{ key: "etf", label: "ETFs", fraction: 0.58 }, { key: "cash", label: "Cash", fraction: 0.42 }],
      groups: [{ key: "tfsa:CAD", label: "TFSA", currency: "CAD", value: 92104.2, accountCount: 2, holdingCount: 9, dayChangeFraction: 0.006, accountIds: ["a"] }],
    },
    series: { period: "YTD", currency: "CAD", points: [{ date: "2026-01-02", value: 200000, source: "reported" }, { date: "2026-10-15", value: 248310.42, source: "reported" }],
      benchmark: { key: "sp500", name: "S&P 500", explainer: "S&P 500: 500 large US companies.", points: [{ date: "2026-01-02", returnFraction: 0 }, { date: "2026-10-15", returnFraction: 0.1 }], unavailableReason: null },
      portfolioReturn: 0.2416, benchmarkReturn: 0.1, fxNote: "USD index converted to CAD with the Bank of Canada daily rate.", spanStart: "2026-01-02", spanIsPartial: false },
    settings: { benchmark: "sp500", cadView: false, privacyDefault: false },
    benchmarks: [{ key: "sp500", name: "S&P 500", explainer: "S&P 500: 500 large US companies." }, { key: "tsx", name: "S&P/TSX Composite", explainer: "TSX." }],
    ...over,
  };
}
function fakeBridge() {
  let listener: (r: ToolResult) => void = () => {};
  const bridge: Bridge = {
    ready: Promise.resolve({ hostTools: true, context: {} }),
    onToolResult: (fn) => { listener = fn; return () => {}; },
    onContext: () => () => {},
    toolArguments: () => ({}), openLink: async () => true,
    callTool: vi.fn(async (name: string, args: any) => ({ structuredContent: name === "get_overview_series" ? { ...payload().series, period: args.period, benchmark: { ...payload().series.benchmark, key: args.benchmark ?? "sp500" } } : {} })),
    sendMessage: vi.fn(async () => {}),
    updateModelContext: vi.fn(async () => {}),
    destroy: () => {},
  };
  return { bridge, push: (p: OverviewPayload) => listener({ structuredContent: p }), pushResult: (r: ToolResult) => listener(r) };
}

test("renders totals, change, tiles, allocation and accounts from the tool result", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  expect(screen.getByText(/loading your portfolio/i)).toBeInTheDocument();
  push(payload());
  expect(await screen.findByText("$248,310.42")).toBeInTheDocument();
  expect(screen.getByText(/\+\$1,204\.18/)).toBeInTheDocument();
  expect(screen.getByText(/\+ US\$18,940\.10 in USD/)).toBeInTheDocument();
  // No time-weighted return in this payload: a value change is never compared with the index.
  expect(screen.getByText("needs deposit history")).toBeInTheDocument();
  // The symbol shows without its exchange suffix; screen readers and the hover title keep the full symbol.
  const largest = screen.getByText("Largest holding").parentElement!;
  expect(within(largest).getByText("XEQT")).toHaveAttribute("aria-hidden", "true");
  expect(within(largest).getByText("XEQT.TO")).toHaveClass("w-sr");
  expect(largest).toHaveTextContent("31.2%");
  expect(screen.getByText("ETFs 58%")).toBeInTheDocument();
  expect(screen.getByText("TFSA")).toBeInTheDocument();
  await waitFor(() => expect(bridge.updateModelContext).toHaveBeenCalledWith("Viewing portfolio overview: period YTD, benchmark S&P 500."));
});

test("names a managed portfolio the total leaves out (SnapTrade reports no value for it)", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push({ ...base, portfolio: { ...base.portfolio, accounts: [...base.portfolio.accounts,
    { id: "m", unifiedType: "MANAGED_PORTFOLIO_NON_REGISTERED", classification: { label: "Automated portfolio", includedInPortfolioTotal: true }, value: { amount: 0, currency: "CAD" } }] } });
  expect(await screen.findByText(/Not included: Automated portfolio\. SnapTrade doesn't provide the value of Wealthsimple managed portfolios/)).toBeInTheDocument();
});

test("no not-included line without an unvalued managed portfolio", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  await screen.findByText("$248,310.42");
  expect(screen.queryByText(/Not included:/)).toBeNull();
});

test("period and benchmark changes fetch a new series and save the default benchmark", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("radio", { name: "1M" }));
  await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("get_overview_series", { period: "1M", benchmark: "sp500" }));
  fireEvent.change(screen.getByLabelText("Compare with"), { target: { value: "tsx" } });
  await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("save_portfolio_settings", { benchmark: "tsx" }));
});

test("explains the benchmark and shows unavailability without inventing numbers", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({ series: { ...base.series, benchmark: { ...base.series.benchmark, points: null, unavailableReason: "Benchmark data unavailable" }, benchmarkReturn: null } }));
  expect(await screen.findByText("Benchmark data unavailable")).toBeInTheDocument();
  expect(screen.getByText("—")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /about s&p 500/i }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Bank of Canada");
});

test("partial day-change coverage, empty chart and privacy mode", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({ summary: { ...base.summary, dayChange: [{ currency: "CAD", amount: 10, fraction: 0.001, coverage: 0.5 }] }, series: { ...base.series, points: [base.series.points[1]] } }));
  expect(await screen.findByText(/partial/)).toBeInTheDocument();
  expect(screen.getByText(/not enough value history for this period/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  expect(screen.queryByText("$248,310.42")).toBeNull();
});

test("a just-linked account says its history is still being read", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({
    series: { ...base.series, points: [base.series.points[1]], investmentReturn: { value: null, estimated: false } as never },
    history: { qualities: [], earliest: null, building: true },
  }));
  expect(await screen.findByText(/building your history from wealthsimple/i)).toBeInTheDocument();
  expect(screen.queryByText(/not enough value history/i)).toBeNull();
  expect(screen.getByText("history still loading")).toBeInTheDocument();
  expect(screen.queryByText("needs deposit history")).toBeNull();
});

test("tapping an account group asks Claude without sending values", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("button", { name: /TFSA/ }));
  expect(bridge.sendMessage).toHaveBeenCalledWith("Show me my TFSA accounts");
});

test("Performance link asks Claude with the mapped period label and no values", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("button", { name: /performance/i }));
  expect(bridge.sendMessage).toHaveBeenCalledWith("Show my performance for YTD");
  const text = (bridge.sendMessage as any).mock.calls.at(-1)[0] as string;
  expect(text.replace("YTD", "")).not.toMatch(/\d/);
  fireEvent.click(screen.getByRole("radio", { name: "1W" }));
  await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("get_overview_series", { period: "1W", benchmark: "sp500" }));
  await waitFor(() => expect(screen.getByRole("radio", { name: "1W" })).toBeChecked());
  fireEvent.click(screen.getByRole("button", { name: /performance/i }));
  expect(bridge.sendMessage).toHaveBeenLastCalledWith("Show my performance for 1M");
  fireEvent.click(screen.getByRole("radio", { name: "All" }));
  await waitFor(() => expect(screen.getByRole("radio", { name: "All" })).toBeChecked());
  fireEvent.click(screen.getByRole("button", { name: /performance/i }));
  expect(bridge.sendMessage).toHaveBeenLastCalledWith("Show my performance for All");
});

test("a rejected Performance message shows the value-free notice", async () => {
  const { bridge, push } = fakeBridge();
  (bridge.sendMessage as any).mockImplementation(async () => { throw new Error("host refused"); });
  render(<Overview bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("button", { name: /performance/i }));
  expect(await screen.findByText("Couldn't send that to the chat.")).toBeInTheDocument();
});

// Controllable bridge: every callTool is held until the test resolves it.
function deferredBridge() {
  let listener: (r: ToolResult) => void = () => {};
  const calls: Array<{ name: string; args: any; resolve: (r: ToolResult) => void; reject: (e: unknown) => void }> = [];
  const bridge: Bridge = {
    ready: Promise.resolve({ hostTools: true, context: {} }),
    onToolResult: (fn) => { listener = fn; return () => {}; },
    onContext: () => () => {},
    toolArguments: () => ({}), openLink: async () => true,
    callTool: vi.fn((name: string, args: any) => new Promise<ToolResult>((resolve, reject) => { calls.push({ name, args, resolve, reject }); })),
    sendMessage: vi.fn(async () => {}),
    updateModelContext: vi.fn(async () => {}),
    destroy: () => {},
  };
  const seriesFor = (args: any) => ({ structuredContent: { ...payload().series, period: args.period, benchmark: { ...payload().series.benchmark, key: args.benchmark } } });
  return { bridge, calls, seriesFor, push: (p: OverviewPayload) => listener({ structuredContent: p }) };
}

test("a slower earlier series request cannot overwrite a later one", async () => {
  const { bridge, calls, seriesFor, push } = deferredBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("radio", { name: "1M" }));
  fireEvent.click(screen.getByRole("radio", { name: "1Y" }));
  expect(calls.map((c) => c.args.period)).toEqual(["1M", "1Y"]);
  calls[1].resolve(seriesFor(calls[1].args));
  await waitFor(() => expect(screen.getByRole("radio", { name: "1Y" })).toHaveAttribute("aria-checked", "true"));
  calls[0].resolve(seriesFor(calls[0].args));
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.getByRole("radio", { name: "1Y" })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("radio", { name: "1M" })).toHaveAttribute("aria-checked", "false");
  expect(screen.getByRole("img", { name: /^Value 1Y/ })).toBeInTheDocument();
});

test("a failed benchmark series load does not save the default and keeps the previous selection", async () => {
  const { bridge, calls, push } = deferredBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  const select = (await screen.findByLabelText("Compare with")) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: "tsx" } });
  calls[0].resolve({ isError: true });
  expect(await screen.findByText(/couldn't load that view/i)).toBeInTheDocument();
  expect(bridge.callTool).not.toHaveBeenCalledWith("save_portfolio_settings", expect.anything());
  expect(select.value).toBe("sp500");
});

test("an error result from saving the default benchmark shows the save note", async () => {
  const { bridge, calls, seriesFor, push } = deferredBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  fireEvent.change(await screen.findByLabelText("Compare with"), { target: { value: "tsx" } });
  calls[0].resolve(seriesFor(calls[0].args));
  await waitFor(() => expect(calls.some((c) => c.name === "save_portfolio_settings")).toBe(true));
  calls[1].resolve({ isError: true });
  expect(await screen.findByText(/couldn't save default benchmark/i)).toBeInTheDocument();
});

test("a later tool result keeps the privacy choice and the user's chosen view", async () => {
  const { bridge, calls, seriesFor, push } = deferredBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("button", { name: "Hide amounts" }));
  fireEvent.click(screen.getByRole("radio", { name: "1M" }));
  calls[0].resolve(seriesFor(calls[0].args));
  await waitFor(() => expect(screen.getByRole("radio", { name: "1M" })).toHaveAttribute("aria-checked", "true"));
  push(payload());
  await Promise.resolve();
  expect(screen.queryByText("$248,310.42")).toBeNull();
  expect(screen.getByRole("button", { name: "Show amounts" })).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "1M" })).toHaveAttribute("aria-checked", "true");
});

test("the chart is busy while a series loads and the controls stay enabled", async () => {
  const { bridge, calls, seriesFor, push } = deferredBridge();
  const { container } = render(<Overview bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("radio", { name: "1M" }));
  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(screen.getByRole("radio", { name: "1W" })).not.toBeDisabled();
  expect(screen.getByLabelText("Compare with")).not.toBeDisabled();
  calls[0].resolve(seriesFor(calls[0].args));
  await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull());
});

test("a failed first user load does not stop later tool results from updating the series", async () => {
  const { bridge, calls, push } = deferredBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("radio", { name: "1M" }));
  calls[0].resolve({ isError: true });
  await screen.findByText(/couldn't load that view/i);
  const base = payload();
  push(payload({ series: { ...base.series, period: "1Y" } }));
  await waitFor(() => expect(screen.getByRole("radio", { name: "1Y" })).toHaveAttribute("aria-checked", "true"));
});

test("labels the value change with its period when history covers the whole period", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  expect(await screen.findByText("YTD +24.2%")).toBeInTheDocument();
  expect(screen.getByText("vs S&P 500 (YTD)")).toBeInTheDocument();
});

test("labels a late-starting span 'since <date>' in the chip and the benchmark tile", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({ series: { ...base.series, spanStart: "2026-06-01", spanIsPartial: true } }));
  expect(await screen.findByText("since Jun 1 +24.2%")).toBeInTheDocument();
  expect(screen.getByText("vs S&P 500 (since Jun 1)")).toBeInTheDocument();
  expect(screen.queryByText(/^YTD \+/)).toBeNull();
});

const twr = (value: number | null, estimated = false) => ({ value, estimated, ...(value === null ? { reason: "flows_unavailable" } : {}) });

test("shows the time-weighted return chip with an explanation when present", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({ series: { ...base.series, investmentReturn: twr(0.32), benchmarkReturnTwr: twr(0.1) } }));
  expect(await screen.findByText("YTD return +32.0%")).toBeInTheDocument();
  expect(screen.queryByText("YTD +24.2%")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /about time-weighted return/i }));
  expect(screen.getByText(/^How your investments performed, excluding money you added or withdrew/)).toBeInTheDocument();
  expect(screen.getByText(/the chart shows total value, which includes deposits/i)).toBeInTheDocument();
});

test("the benchmark tile uses the time-weighted difference when both returns are present", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({ series: { ...base.series, investmentReturn: twr(0.32), benchmarkReturnTwr: twr(0.1) } }));
  expect(await screen.findByText("+22.0 pts")).toBeInTheDocument();
  expect(screen.queryByText("+14.2 pts")).toBeNull();
});

test("marks an estimated time-weighted return with 'est.'", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({ series: { ...base.series, investmentReturn: twr(0.32, true), benchmarkReturnTwr: twr(0.1) } }));
  expect(await screen.findByText("YTD return +32.0% est.")).toBeInTheDocument();
});

test("keeps the value-change chip but no index difference when the time-weighted return is null", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({ series: { ...base.series, investmentReturn: twr(null), benchmarkReturnTwr: twr(0.1) } }));
  expect(await screen.findByText("YTD value change +24.2%")).toBeInTheDocument();
  expect(screen.queryByText("+14.2 pts")).toBeNull();
  expect(screen.getByText("needs deposit history")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /time-weighted/i })).toBeNull();
});

test("shows a dash, not the value-change difference, when only the investment return is present", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({ series: { ...base.series, investmentReturn: twr(0.32), benchmarkReturnTwr: twr(null) } }));
  expect(await screen.findByText("YTD return +32.0%")).toBeInTheDocument();
  expect(screen.queryByText("+14.2 pts")).toBeNull();
  expect(screen.getByText("—")).toBeInTheDocument();
});

test("marks the tile est. when the return is estimated and uses the time-weighted span for the label", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({ series: { ...base.series, investmentReturn: twr(0.32, true), benchmarkReturnTwr: twr(0.1), returnSpan: { partial: true, since: "2026-06-01" } } }));
  expect(await screen.findByText("Return since Jun 1 +32.0% est.")).toBeInTheDocument();
  expect(screen.getByText("+22.0 pts est.")).toBeInTheDocument();
  expect(screen.getByText("vs S&P 500 (since Jun 1)")).toBeInTheDocument();
});

test("labels the fallback chip as a value change when flows are unavailable", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({ series: { ...base.series, spanStart: "2026-06-01", spanIsPartial: true, investmentReturn: twr(null), benchmarkReturnTwr: twr(null) } }));
  expect(await screen.findByText("Value change since Jun 1 +24.2%")).toBeInTheDocument();
});

test("a failed show_portfolio result shows an error with a working retry", async () => {
  const { bridge, pushResult } = fakeBridge();
  (bridge.callTool as any).mockImplementation(async (name: string) => (name === "show_portfolio" ? { structuredContent: payload() } : { isError: true }));
  render(<Overview bridge={bridge} />);
  pushResult({ isError: true, content: [{ type: "text", text: "failed" }] });
  expect(await screen.findByText("Couldn't load your portfolio.")).toBeInTheDocument();
  expect(screen.queryByText(/loading your portfolio/i)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(bridge.callTool).toHaveBeenCalledWith("show_portfolio", {});
  expect(await screen.findByText("$248,310.42")).toBeInTheDocument();
  expect(screen.queryByText("Couldn't load your portfolio.")).toBeNull();
});

test("a result without structured content before any data shows the error, and a failed retry keeps it", async () => {
  const { bridge, pushResult } = fakeBridge();
  (bridge.callTool as any).mockImplementation(async () => { throw new Error("timeout"); });
  render(<Overview bridge={bridge} />);
  pushResult({ content: [{ type: "text", text: "no structured content" }] });
  expect(await screen.findByText("Couldn't load your portfolio.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("show_portfolio", {}));
  await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).not.toBeDisabled());
  expect(screen.getByText("Couldn't load your portfolio.")).toBeInTheDocument();
});

test("an error result after data has loaded keeps the existing view", async () => {
  const { bridge, push, pushResult } = fakeBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  await screen.findByText("$248,310.42");
  pushResult({ isError: true });
  await Promise.resolve();
  expect(screen.getByText("$248,310.42")).toBeInTheDocument();
  expect(screen.queryByText("Couldn't load your portfolio.")).toBeNull();
});

test("a rejected ui/message shows a value-free notice", async () => {
  const { bridge, push } = fakeBridge();
  (bridge.sendMessage as any).mockImplementation(async () => { throw new Error("host refused"); });
  render(<Overview bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("button", { name: /TFSA/ }));
  expect(await screen.findByText("Couldn't send that to the chat.")).toBeInTheDocument();
  expect(bridge.sendMessage).toHaveBeenCalledWith("Show me my TFSA accounts");
});

test("shows the history line and an info listing account labels and reasons, without values", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({
    portfolio: { ...base.portfolio, accounts: [{ id: "A", classification: { label: "TFSA" } }, { id: "B", classification: { label: "Crypto" } }] },
    history: { earliest: "2024-03-04", qualities: [
      { accountId: "A", method: "reconstructed", reason: null, driftFraction: 0.001 },
      { accountId: "B", method: "snapshots_only", reason: "no_activity", driftFraction: null },
    ] },
  }));
  expect(await screen.findByText(/History rebuilt from your activity since Mar 4, 2024/)).toBeInTheDocument();
  expect(screen.getByText(/Some accounts show history only since their first snapshot/)).toBeInTheDocument();
  expect(screen.queryByText("Some history is estimated")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /history coverage/i }));
  expect(await screen.findByText(/Crypto: no activity history found/)).toBeInTheDocument();
  expect(screen.queryByText(/TFSA:/)).toBeNull();
});

test("flags estimated accounts and omits history notes when there is no history", async () => {
  const { bridge, push } = fakeBridge();
  const { unmount } = render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({
    portfolio: { ...base.portfolio, accounts: [{ id: "A", classification: { label: "TFSA" } }] },
    history: { earliest: "2025-01-02", qualities: [{ accountId: "A", method: "reconstructed", reason: "drift", driftFraction: 0.05 }] },
  }));
  expect(await screen.findByText("Some history is estimated")).toBeInTheDocument();
  expect(screen.queryByText(/only since their first snapshot/)).toBeNull();
  unmount();
  const next = fakeBridge();
  render(<Overview bridge={next.bridge} />);
  next.push(payload({ history: { earliest: null, qualities: [] } }));
  await screen.findByText("$248,310.42");
  expect(screen.queryByText(/History rebuilt/)).toBeNull();
  expect(screen.queryByText(/Some accounts show history/)).toBeNull();
});

test("M7: the estimated note shows the rounded drift as a percentage only", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({
    portfolio: { ...base.portfolio, accounts: [{ id: "A", classification: { label: "TFSA" } }] },
    history: { earliest: "2025-01-02", qualities: [{ accountId: "A", method: "reconstructed", reason: "drift", driftFraction: 0.0815 }] },
  }));
  expect(await screen.findByText("Some history is estimated")).toBeInTheDocument();
  expect(screen.getByText(/differs from reported by about 8%/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /history coverage/i }));
  expect(await screen.findByText(/TFSA: estimated, rebuilt value differs from reported by about 8%/)).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/0\.0815/);
});

test("M8: the estimated note appears when any series point is estimated", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({
    series: { ...base.series, points: [{ date: "2026-01-02", value: 200000, source: "estimated" }, { date: "2026-10-15", value: 248310.42, source: "reported" }] },
    history: { earliest: "2025-01-02", qualities: [{ accountId: "A", method: "reconstructed", reason: null, driftFraction: 0.001 }] },
  }));
  expect(await screen.findByText("Some history is estimated")).toBeInTheDocument();
});

test("M9: missing_currency has its own reason phrase", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({
    portfolio: { ...base.portfolio, accounts: [{ id: "B", classification: { label: "RRSP" } }] },
    history: { earliest: null, qualities: [{ accountId: "B", method: "snapshots_only", reason: "missing_currency", driftFraction: null }] },
  }));
  fireEvent.click(await screen.findByRole("button", { name: /history coverage/i }));
  expect(await screen.findByText(/RRSP: some activity is missing its currency/)).toBeInTheDocument();
});

const torontoToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const intradayResult = (over: Record<string, unknown> = {}) => ({
  structuredContent: {
    points: [{ t: "2026-10-15T14:30:00Z", value: 1000 }, { t: "2026-10-15T15:00:00Z", value: 1010 }, { t: "2026-10-15T15:30:00Z", value: 1020 }],
    coverage: 1, sessionDate: torontoToday(), drawn: true, warnings: [], label: "Estimated from live prices", fallback: { previousClose: 990, reported: 1020 }, ...over,
  },
});

test("selecting 1D calls get_intraday and draws the live chart with the estimated note", async () => {
  const { bridge, calls, seriesFor, push } = deferredBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("radio", { name: "1D" }));
  calls[0].resolve(seriesFor(calls[0].args));
  await waitFor(() => expect(calls.some((c) => c.name === "get_intraday")).toBe(true));
  expect(calls.find((c) => c.name === "get_intraday")!.args).toEqual({});
  calls.find((c) => c.name === "get_intraday")!.resolve(intradayResult());
  expect(await screen.findByText("Estimated from live prices")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Value today (estimated): +2.0%" })).toBeInTheDocument();
  expect(screen.getByText("$248,310.42")).toBeInTheDocument();
});

test("a past session date and partial coverage are appended to the note", async () => {
  const { bridge, calls, seriesFor, push } = deferredBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("radio", { name: "1D" }));
  calls[0].resolve(seriesFor(calls[0].args));
  await waitFor(() => expect(calls.some((c) => c.name === "get_intraday")).toBe(true));
  calls.find((c) => c.name === "get_intraday")!.resolve(intradayResult({ sessionDate: "2026-10-09", coverage: 0.86 }));
  expect(await screen.findByText("Estimated from live prices · Oct 9 · 86% of holdings priced live")).toBeInTheDocument();
});

test("when the line is not drawn, or the call fails, the 1D chart stays with the unavailable note", async () => {
  for (const respond of [(c: any) => c.resolve(intradayResult({ drawn: false, points: [] })), (c: any) => c.reject(new Error("boom")), (c: any) => c.resolve({ isError: true })]) {
    const { bridge, calls, seriesFor, push } = deferredBridge();
    const { unmount } = render(<Overview bridge={bridge} />);
    push(payload());
    fireEvent.click(await screen.findByRole("radio", { name: "1D" }));
    calls[0].resolve(seriesFor(calls[0].args));
    await waitFor(() => expect(calls.some((c) => c.name === "get_intraday")).toBe(true));
    respond(calls.find((c) => c.name === "get_intraday"));
    expect(await screen.findByText("Live prices unavailable")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Value 1D/ })).toBeInTheDocument();
    expect(screen.queryByText("Estimated from live prices")).toBeNull();
    unmount();
  }
});

test("other periods never call get_intraday, and a pending intraday response is discarded after switching away", async () => {
  const { bridge, calls, seriesFor, push } = deferredBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("radio", { name: "1M" }));
  calls[0].resolve(seriesFor(calls[0].args));
  await waitFor(() => expect(screen.getByRole("radio", { name: "1M" })).toBeChecked());
  expect(calls.some((c) => c.name === "get_intraday")).toBe(false);
  fireEvent.click(screen.getByRole("radio", { name: "1D" }));
  calls[1].resolve(seriesFor(calls[1].args));
  await waitFor(() => expect(calls.some((c) => c.name === "get_intraday")).toBe(true));
  fireEvent.click(screen.getByRole("radio", { name: "1Y" }));
  calls.find((c) => c.name === "get_intraday")!.resolve(intradayResult());
  const yearCall = calls.find((c) => c.args.period === "1Y")!;
  yearCall.resolve(seriesFor(yearCall.args));
  await waitFor(() => expect(screen.getByRole("radio", { name: "1Y" })).toBeChecked());
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.queryByText("Estimated from live prices")).toBeNull();
  expect(screen.queryByText("Live prices unavailable")).toBeNull();
  expect(screen.getByRole("img", { name: /^Value 1Y/ })).toBeInTheDocument();
});

test("Activity link asks Claude for recent activity with no values, and a rejection shows the notice", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("button", { name: /activity/i }));
  expect(bridge.sendMessage).toHaveBeenCalledWith("Show my recent activity");
  (bridge.sendMessage as any).mockImplementation(async () => { throw new Error("refused"); });
  fireEvent.click(screen.getByRole("button", { name: /activity/i }));
  expect(await screen.findByText("Couldn't send that to the chat.")).toBeInTheDocument();
});

test.each([
  ["Holdings", "Show my holdings"],
  ["Allocation", "Show my allocation"],
  ["Income", "Show my dividend income"],
])("%s link asks Claude with no values, and a rejection shows the notice", async (label, message) => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${label}`, "i") }));
  expect(bridge.sendMessage).toHaveBeenCalledWith(message);
  (bridge.sendMessage as any).mockImplementation(async () => { throw new Error("refused"); });
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`, "i") }));
  expect(await screen.findByText("Couldn't send that to the chat.")).toBeInTheDocument();
});

test("partial coverage on today's session shows the coverage note without a date", async () => {
  const { bridge, calls, seriesFor, push } = deferredBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("radio", { name: "1D" }));
  calls[0].resolve(seriesFor(calls[0].args));
  await waitFor(() => expect(calls.some((c) => c.name === "get_intraday")).toBe(true));
  calls.find((c) => c.name === "get_intraday")!.resolve(intradayResult({ coverage: 0.9 }));
  expect(await screen.findByText("Estimated from live prices · 90% of holdings priced live")).toBeInTheDocument();
});

// Brief 9: every figure is reported, reconciled or labelled "est.".
const summaryOf = (over: Partial<OverviewPayload["summary"]>) => { const base = payload(); return payload({ summary: { ...base.summary, ...over } }); };

test("1: the day-change pill is labelled est. and other currencies get their own line", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  push(summaryOf({ dayChange: [
    { currency: "CAD", amount: 1204.18, fraction: 0.0049, coverage: 1, estimated: true },
    { currency: "USD", amount: 10, fraction: 0.25, coverage: 0.5, estimated: true },
  ] }));
  expect(await screen.findByText(/\+\$1,204\.18 · 0\.49% today est\./)).toBeInTheDocument();
  expect(screen.getByText(/\+US\$10\.00 · 25\.00% today in USD est\. · partial/)).toBeInTheDocument();
});

test("3: unrealized gain shows the USD line and partial coverage", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  push(summaryOf({ unrealizedGain: [{ currency: "CAD", amount: 4 }, { currency: "USD", amount: 10 }], unrealizedCoverage: { withCostBasis: 2, holdings: 3 } }));
  expect(await screen.findByText((_, el) => el?.tagName === "SMALL" && el.textContent === "+ US$10.00 in USD")).toBeInTheDocument();
  expect(screen.getByText("from 2 of 3 holdings · partial")).toBeInTheDocument();
});

test("4: the largest holding is labelled est. when converted", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  push(summaryOf({ largestHolding: { symbol: "SYNTHETICU", fraction: 0.7, estimated: true } }));
  expect(await screen.findByText("SYNTHETICU 70.0% est.")).toBeInTheDocument();
});

test("5: without a time-weighted return the benchmark tile shows a dash and why", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  expect(await screen.findByText("needs deposit history", { selector: "small" })).toBeInTheDocument();
  expect(screen.getByText("needs deposit history").closest(".w-tile")!.textContent).toBe("vs S&P 500 (YTD)—needs deposit history");
  expect(screen.queryByText("+14.2 pts")).toBeNull();
});

test("12/13: an unreported account is called out in its group and margin cash is labelled", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  push(summaryOf({
    cashNetOfMargin: true,
    groups: [{ key: "tfsa:CAD", label: "TFSA", currency: "CAD", value: 92104.2, accountCount: 2, unavailableCount: 1, holdingCount: 9, dayChangeFraction: 0.006, dayChangeCoverage: 1, accountIds: ["a", "b"] }],
  }));
  expect(await screen.findByText(/value unavailable for 1 account/)).toBeInTheDocument();
  expect(screen.getByText("Cash, net of margin")).toBeInTheDocument();
});

test("2: a group's day change is a dash below 80% coverage", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  push(summaryOf({ groups: [{ key: "tfsa:CAD", label: "TFSA", currency: "CAD", value: 92104.2, accountCount: 1, unavailableCount: 0, holdingCount: 9, dayChangeFraction: 0.006, dayChangeCoverage: 0.5, accountIds: ["a"] }] }));
  await screen.findByText("TFSA");
  expect(screen.queryByText(/▲ 0\.6%/)).toBeNull();
});


describe("Overview resilience", () => {
  afterEach(() => { vi.useRealTimers(); });

  test("shows a retry 30 s after initialize with no payload, and retry hydrates", async () => {
    vi.useFakeTimers();
    const { bridge } = fakeBridge();
    (bridge.callTool as any).mockImplementation(async (name: string) => ({ structuredContent: name === "show_portfolio" ? payload() : {} }));
    render(<Overview bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(29_500); });
    expect(screen.queryByText(/still loading/i)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.getByText(/still loading/i)).toBeInTheDocument();
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(bridge.callTool).toHaveBeenCalledWith("show_portfolio", {});
    expect(await screen.findByText("$248,310.42")).toBeInTheDocument();
    expect(screen.queryByText(/still loading/i)).toBeNull();
  });

  test("tolerates an unknown top-level key", async () => {
    const { bridge, push } = fakeBridge();
    render(<Overview bridge={bridge} />);
    push({ ...payload(), futureField: { nested: [1, 2] } } as any);
    expect(await screen.findByText("$248,310.42")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't display this view.")).toBeNull();
  });

  test("tolerates missing optional sub-fields", async () => {
    const { bridge, push } = fakeBridge();
    render(<Overview bridge={bridge} />);
    const p: any = payload();
    delete p.history; delete p.settings; delete p.portfolio.cache; delete p.summary.unrealizedCoverage; delete p.series.investmentReturn;
    push(p);
    expect(await screen.findByText("$248,310.42")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't display this view.")).toBeNull();
  });
});

test("the value chart has no benchmark line, labels its series and points to the fair comparison", async () => {
  const { bridge, push } = fakeBridge();
  const { container } = render(<Overview bridge={bridge} />);
  push(payload());
  await screen.findByText("$248,310.42");
  expect(container.querySelector("path[data-series='benchmark']")).toBeNull();
  expect(container.querySelector("path[data-series='portfolio']")).not.toBeNull();
  expect(screen.getByText("Your investments’ value (includes deposits; Cash left out)")).toBeInTheDocument();
  expect(screen.getByText("Compare your return with the index in the tile below or under vs Benchmark in Performance.")).toBeInTheDocument();
  // The picker still drives the benchmark tile.
  expect(screen.getByRole("combobox", { name: "Compare with" })).toBeInTheDocument();
  expect(screen.getByText(/vs S&P 500 \(YTD\)/)).toBeInTheDocument();
});

test("the overview chart tooltip hides money when amounts are hidden", async () => {
  const { bridge, push } = fakeBridge();
  const { container } = render(<Overview bridge={bridge} />);
  push(payload());
  await screen.findByText("$248,310.42");
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  fireEvent.pointerMove(container.querySelector("[data-chart-plot]")!, { clientX: 300, pointerType: "mouse" });
  const tip = container.querySelector("[data-chart-tip]")!.textContent!;
  expect(tip).toContain("Value ••••");
  expect(tip).toContain("+24.2%");
  expect(tip).not.toMatch(/\$/);
});

describe("cadView on: one CAD total", () => {
  const est = (amount: number) => ({ amount, estimated: true, rateDates: ["2026-10-15"], excluded: [] });
  function cadPayload(home: Partial<NonNullable<OverviewPayload["summary"]["home"]>> = {}): OverviewPayload {
    const base = payload();
    return {
      ...base,
      settings: { benchmark: "sp500", cadView: true, privacyDefault: false },
      summary: {
        ...base.summary,
        dayChange: [...base.summary.dayChange, { currency: "USD", amount: 52.1, fraction: 0.003, coverage: 1 }],
        unrealizedGain: [...base.summary.unrealizedGain, { currency: "USD", amount: 900 }],
        home: {
          total: est(274447.96), includesUnreported: false,
          dayChange: est(1290.55), dayChangeFraction: 0.0047, dayChangeCoverage: 1,
          unrealizedGain: est(32644.77), cash: est(8278.56),
          groups: [{ key: "tfsa:CAD", value: { amount: 92104.2, estimated: false, rateDates: [], excluded: [] } }],
          ...home,
        },
      },
    };
  }

  test("a CAD change with a converted holding says it includes the day's currency move (B2)", async () => {
    const { bridge, push } = fakeBridge();
    render(<Overview bridge={bridge} />);
    push(cadPayload({ dayChangeIncludesFx: true }));
    expect(await screen.findByText("The CAD change includes the day's currency move; the breakdown shows each currency's own move.")).toBeInTheDocument();
  });

  test("shows one CAD total, CAD day change, gain and cash, and the currency breakdown instead of chips", async () => {
    const { bridge, push } = fakeBridge();
    const { container } = render(<Overview bridge={bridge} />);
    push(cadPayload());
    expect(await screen.findByText("$274,447.96")).toBeInTheDocument();
    expect(screen.queryByText(/in USD/)).toBeNull();
    expect(container.querySelector(".w-big")!.textContent).toBe("$274,447.96 est.");
    expect(screen.getByText(/\+\$1,290\.55 · [\d.]+% today est\./)).toBeInTheDocument();
    expect(screen.getByText(/\+\$32,644\.77/)).toBeInTheDocument();
    expect(screen.getByText(/\$8,278\.56/)).toBeInTheDocument();
    // The per-currency figures move into the expander.
    const details = container.querySelector("details")!;
    expect(details.querySelector("summary")!.textContent).toBe("Breakdown by currency");
    expect(details.textContent).toContain("$248,310.42");
    expect(details.textContent).toContain("US$18,940.10");
    expect(details.textContent).toContain("+US$52.10");
    // Footer: the est./rate caption replaces "Values stay in their own currency."
    const foot = container.querySelector(".w-foot")!;
    expect(foot.textContent).not.toContain("Values stay in their own currency");
    expect(foot.textContent).toContain("est. · BoC Oct 15");
    expect(screen.getByRole("button", { name: "Show original currencies" })).toHaveAttribute("aria-pressed", "false");
  });

  test("says when the CAD total includes accounts without a brokerage total, and names unconverted amounts", async () => {
    const { bridge, push } = fakeBridge();
    render(<Overview bridge={bridge} />);
    push(cadPayload({ includesUnreported: true, total: { ...est(274447.96), excluded: [{ amount: 10, currency: "EUR" }] } }));
    expect(await screen.findByText("Includes accounts without a brokerage total (valued from holdings)")).toBeInTheDocument();
    expect(screen.getByText(/1 not converted/)).toBeInTheDocument();
  });

  test("privacy hides CAD and the breakdown alike", async () => {
    const { bridge, push } = fakeBridge();
    const { container } = render(<Overview bridge={bridge} />);
    push(cadPayload());
    await screen.findByText("$274,447.96");
    fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
    expect(container.textContent).not.toMatch(/\$\d/);
  });

  test("the switch shows original currencies as today and saves cadView", async () => {
    const { bridge, push } = fakeBridge();
    const { container } = render(<Overview bridge={bridge} />);
    push(cadPayload());
    await screen.findByText("$274,447.96");
    fireEvent.click(screen.getByRole("button", { name: "Show original currencies" }));
    expect(await screen.findByText("$248,310.42")).toBeInTheDocument();
    expect(screen.getByText(/\+ US\$18,940\.10 in USD/)).toBeInTheDocument();
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector(".w-foot")!.textContent).toContain("Values stay in their own currency.");
    expect(bridge.callTool).toHaveBeenCalledWith("save_portfolio_settings", { cadView: false });
  });

  test("an older payload without home renders as today", async () => {
    const { bridge, push } = fakeBridge();
    render(<Overview bridge={bridge} />);
    push({ ...payload(), settings: { benchmark: "sp500", cadView: true, privacyDefault: false } });
    expect(await screen.findByText("$248,310.42")).toBeInTheDocument();
    expect(screen.getByText(/\+ US\$18,940\.10 in USD/)).toBeInTheDocument();
  });

  test("the CAD unrealized gain is labelled at today's rate and excludes currency movement", async () => {
    const { bridge, push } = fakeBridge();
    render(<Overview bridge={bridge} />);
    push(cadPayload());
    expect(await screen.findByText("Unrealized gain (at today's rate)")).toBeInTheDocument();
    expect(screen.getByText("Excludes currency movement since purchase.")).toBeInTheDocument();
  });

  test("cadView off keeps the unrealized label as today", async () => {
    const { bridge, push } = fakeBridge();
    render(<Overview bridge={bridge} />);
    push(payload());
    expect(await screen.findByText("Unrealized gain")).toBeInTheDocument();
    expect(screen.queryByText("Excludes currency movement since purchase.")).toBeNull();
  });

  const none = (excluded: Array<{ amount: number; currency: string }>) => ({ amount: 0, estimated: false, rateDates: [], excluded });
  test("USD-only with no rate: headline, day change, gain and cash show the native amounts, never $0.00", async () => {
    const { bridge, push } = fakeBridge();
    const { container } = render(<Overview bridge={bridge} />);
    push(cadPayload({
      total: none([{ amount: 293, currency: "USD" }]),
      dayChange: none([{ amount: 6, currency: "USD" }, { amount: 4, currency: "USD" }]), dayChangeFraction: null, dayChangeCoverage: 0,
      unrealizedGain: none([{ amount: 20, currency: "USD" }]), cash: none([{ amount: 4, currency: "USD" }]),
    }));
    await screen.findByText("Unrealized gain (at today's rate)");
    expect(container.textContent).not.toContain("$0.00");
    expect(container.querySelector(".w-big")!.textContent).toBe("US$293.00");
    expect(screen.getByText(/\+US\$10\.00 today est\./)).toBeInTheDocument();
    expect(screen.getByText("+US$20.00")).toBeInTheDocument();
    expect(screen.getByText("US$4.00")).toBeInTheDocument();
    // Headline, day change, gain and cash each say so.
    expect(screen.getAllByText("Not converted (no recent Bank of Canada rate)")).toHaveLength(4);
  });

  test("CAD + USD with no rate keeps the CAD part plus 1 not converted", async () => {
    const { bridge, push } = fakeBridge();
    const { container } = render(<Overview bridge={bridge} />);
    push(cadPayload({ total: { amount: 156, estimated: false, rateDates: [], excluded: [{ amount: 293, currency: "USD" }] } }));
    await screen.findByText("Unrealized gain (at today's rate)");
    expect(container.querySelector(".w-big")!.textContent).toBe("$156.00");
    expect(container.querySelector(".w-foot")!.textContent).toContain("1 not converted");
    expect(screen.queryByText("Not converted (no recent Bank of Canada rate)")).toBeNull();
  });
});

describe("cadView on: charts in CAD (task 11)", () => {
  const est = (amount: number) => ({ amount, estimated: true, rateDates: ["2026-10-15"], excluded: [] });
  function cadCharts(over: { allocation?: boolean; notConvertedDays?: number; flowNotConverted?: string } = {}): OverviewPayload {
    const base = payload();
    return {
      ...base,
      settings: { benchmark: "sp500", cadView: true, privacyDefault: false },
      summary: {
        ...base.summary,
        home: {
          total: est(274447.96), includesUnreported: false, dayChange: est(1290.55), dayChangeFraction: 0.0047, dayChangeCoverage: 1,
          unrealizedGain: est(32644.77), cash: est(8278.56), groups: [],
          ...(over.allocation === false ? {} : { allocation: [{ key: "stock", label: "Stocks", fraction: 0.7 }, { key: "cash", label: "Cash", fraction: 0.3 }], allocationEstimated: true, allocationNotConverted: 0 }),
        },
      },
      series: {
        ...base.series, home: { estimated: true, notConvertedDays: over.notConvertedDays ?? 0, notConvertedAccounts: 0, flowNotConverted: over.flowNotConverted ?? null },
        ...(over.flowNotConverted ? { investmentReturn: { value: null, estimated: false, reason: "flow_not_converted" } } : {}),
      },
    };
  }

  test("the value chart says it is in CAD at each day's rate and counts days not converted", async () => {
    const { bridge, push } = fakeBridge();
    render(<Overview bridge={bridge} />);
    push(cadCharts({ notConvertedDays: 2 }));
    expect(await screen.findByText("est. · 2 days not converted")).toBeInTheDocument();
    expect(screen.getByText(/USD values use each day's Bank of Canada rate/)).toBeInTheDocument();
  });

  test("a USD flow without a rate: the return is withheld with the date", async () => {
    const { bridge, push } = fakeBridge();
    render(<Overview bridge={bridge} />);
    push(cadCharts({ flowNotConverted: "2026-09-10" }));
    expect(await screen.findByText("Return unavailable: a USD deposit or withdrawal on Sep 10 could not be converted")).toBeInTheDocument();
  });

  test("no rate at all: the series in its own currency with the not-converted note", async () => {
    const { bridge, push } = fakeBridge();
    const { container } = render(<Overview bridge={bridge} />);
    const p = cadCharts();
    push({ ...p, series: { ...payload().series, home: { estimated: false, notConvertedDays: 0, notConvertedAccounts: 1, flowNotConverted: null } } });
    await screen.findByText("Allocation (CAD, all holdings) est.");
    expect(container.textContent).toContain("Not converted (no recent Bank of Canada rate): the chart shows CAD accounts only");
    expect(screen.queryByText(/USD values use each day's Bank of Canada rate/)).toBeNull();
  });

  test("the allocation bar is in CAD across currencies", async () => {
    const { bridge, push } = fakeBridge();
    render(<Overview bridge={bridge} />);
    push(cadCharts());
    expect(await screen.findByText("Allocation (CAD, all holdings) est.")).toBeInTheDocument();
    expect(screen.queryByText("Allocation (CAD holdings)")).toBeNull();
  });

  test("an older summary without a CAD allocation keeps today's bar", async () => {
    const { bridge, push } = fakeBridge();
    render(<Overview bridge={bridge} />);
    push(cadCharts({ allocation: false }));
    expect(await screen.findByText("Allocation (CAD holdings)")).toBeInTheDocument();
  });

  test("switching to original currencies reloads the series after the setting is saved", async () => {
    const { bridge, push } = fakeBridge();
    render(<Overview bridge={bridge} />);
    push(cadCharts());
    await screen.findByText("Allocation (CAD, all holdings) est.");
    fireEvent.click(screen.getByRole("button", { name: "Show original currencies" }));
    await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("get_overview_series", { period: "YTD", benchmark: "sp500" }));
    expect(screen.getByText("Allocation (CAD holdings)")).toBeInTheDocument();
  });

  test("switching back to CAD over a per-currency series reloads it", async () => {
    const { bridge, push } = fakeBridge();
    render(<Overview bridge={bridge} />);
    push({ ...cadCharts(), settings: { benchmark: "sp500", cadView: false, privacyDefault: false }, series: payload().series });
    await screen.findByText("Allocation (CAD holdings)");
    fireEvent.click(screen.getByRole("button", { name: "Show original currencies" }));
    await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("save_portfolio_settings", { cadView: true }));
    await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("get_overview_series", { period: "YTD", benchmark: "sp500" }));
  });

  test("a CAD-only series is not reloaded on a switch", async () => {
    const { bridge, push } = fakeBridge();
    render(<Overview bridge={bridge} />);
    push({ ...payload(), summary: { ...payload().summary, totals: [{ currency: "CAD", amount: 248310.42 }] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Show original currencies" })).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(screen.getByRole("button", { name: "Show original currencies" }));
    await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("save_portfolio_settings", { cadView: true }));
    expect(bridge.callTool).not.toHaveBeenCalledWith("get_overview_series", expect.anything());
  });
});

test("tolerates an extra memory field on the result", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  push({ ...payload(), memory: { facts: [{ id: "synthetic-id", text: "Saving for a house in 2028." }] } } as OverviewPayload);
  expect(await screen.findByText("$248,310.42")).toBeInTheDocument();
  expect(screen.queryByText(/house/)).toBeNull();
});

test("the largest holding states its basis, and a margin account's bar states its debit (B1, A13)", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({ summary: { ...base.summary, cashNetOfMargin: true, largestHolding: { symbol: "AAA", fraction: 100000 / 60000, basis: "of net value after a margin debit (the brokerage total), so it can be over 100%" },
    allocation: [{ key: "stock", label: "Stocks", fraction: 100000 / 60000 }, { key: "cash", label: "Cash", fraction: -40000 / 60000 }] } }));
  const largest = (await screen.findByText("Largest holding")).parentElement!;
  expect(largest).toHaveTextContent("166.7%");
  expect(largest).toHaveTextContent("of net value after a margin debit (the brokerage total), so it can be over 100%");
  expect(screen.getByText("Stocks 167%")).toBeInTheDocument();
  expect(screen.getByText("Cash −67% (margin debit, not drawn)")).toBeInTheDocument();
  expect(screen.getByText("Shares of net CAD value after a margin debit (the brokerage total), so they can be over 100%: CAD holdings and CAD cash in accounts with a brokerage total; other currencies aren't in this bar.")).toBeInTheDocument();
});

test("the native bar's caption says what it covers: holdings and cash in its currency only, not the whole total (review 8)", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  push(payload());
  expect(await screen.findByText("Shares of CAD holdings and CAD cash in accounts with a brokerage total; other currencies aren't in this bar.")).toBeInTheDocument();
  expect(screen.queryByText("Shares of total value, cash included.")).toBeNull();
});

test("a last session that isn't today is labelled with its date (B3)", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({ summary: { ...base.summary, dayChangeSession: "2024-03-08" } }));
  await screen.findByText("Largest holding");
  expect(document.body.textContent).toMatch(/on Mar 8, 2024 est\./);
  expect(document.body.textContent).not.toContain("today est.");
});

test("the day change says today when the session is today", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const base = payload();
  push(payload({ summary: { ...base.summary, dayChangeSession: today } }));
  await screen.findByText("Largest holding");
  expect(document.body.textContent).toContain("today est.");
});

test("the benchmark tile says what the index leaves out, not only the popover (B7)", async () => {
  const { bridge, push } = fakeBridge();
  render(<Overview bridge={bridge} />);
  const base = payload();
  push(payload({ series: { ...base.series, benchmark: { ...base.series.benchmark, basis: "price index, dividends excluded" } } }));
  const tile = (await screen.findByText(/^vs S&P 500/)).parentElement!;
  expect(tile).toHaveTextContent("price index, dividends excluded");
});
