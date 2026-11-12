import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { Performance, drawdownIndex, growthInputs } from "./Performance";
import type { PerformancePayload } from "./types";

const MINUS = "−";
const fig = (value: number | null, estimated = false, reason?: any) => ({ value, estimated, ...(reason ? { reason } : {}) });

function payload(over: Partial<PerformancePayload> = {}): PerformancePayload {
  return {
    scope: { kind: "portfolio", label: "All accounts", currency: "CAD" },
    accounts: [{ id: "acct-secret-1", label: "TFSA", currency: "CAD" }, { id: "acct-secret-2", label: "Margin", currency: "USD" }],
    period: "YTD",
    span: { start: "2026-01-02", end: "2026-10-15", partial: false },
    series: {
      value: [{ date: "2026-01-02", value: 51234.56, source: "reported" }, { date: "2026-06-01", value: 55000, source: "estimated" }, { date: "2026-10-15", value: 61234.56, source: "reported" }],
      netDeposits: [{ date: "2026-01-02", value: 0 }, { date: "2026-06-01", value: 2000 }, { date: "2026-10-15", value: 3777.77 }],
      twrIndex: [{ date: "2026-01-02", value: 1 }, { date: "2026-06-01", value: 1.05 }, { date: "2026-10-15", value: 1.0831 }],
      benchmarkIndex: [{ date: "2026-01-02", value: 1 }, { date: "2026-06-01", value: 1.03 }, { date: "2026-10-15", value: 1.0642 }],
    },
    figures: {
      personalReturn: { ...fig(0.1234), annualised: false }, investmentReturn: fig(0.0831), benchmarkReturn: fig(0.0642),
      valueChange: fig(10000), netDeposits: fig(3777.77), marketGain: fig(6222.23),
      maxDrawdown: { ...fig(-0.0712), peak: "2026-03-05", trough: "2026-04-09" }, volatility: fig(0.143),
      bestMonth: { ...fig(0.0421), month: "2026-05" }, worstMonth: { ...fig(-0.0333), month: "2026-03" },
    },
    monthly: [{ month: "2026-03", return: -0.0333, partial: false, estimated: false }, { month: "2026-05", return: 0.0421, partial: false, estimated: false }],
    benchmark: { key: "sp500", name: "S&P 500", explainer: "S&P 500: 500 large US companies.", note: "USD index converted to CAD with the Bank of Canada daily rate.", unavailableReason: null },
    benchmarks: [{ key: "sp500", name: "S&P 500", explainer: "S&P 500: 500 large US companies." }, { key: "tsx", name: "S&P/TSX Composite", explainer: "TSX." }],
    settings: { benchmark: "sp500", cadView: false, privacyDefault: false },
    history: { qualities: [], earliest: null },
    otherCurrencies: [],
    asOf: "2026-10-15T15:00:00Z",
    ...over,
  };
}
function fakeBridge(impl?: (name: string, args: any) => Promise<ToolResult>) {
  let listener: (r: ToolResult) => void = () => {};
  const bridge: Bridge = {
    ready: Promise.resolve({ hostTools: true, context: {} }),
    onToolResult: (fn) => { listener = fn; return () => {}; },
    onContext: () => () => {},
    toolArguments: () => ({}), openLink: async () => true,
    callTool: vi.fn(impl ?? (async (name: string, args: any) => ({ structuredContent: name === "get_performance" ? payload({ period: args.period ?? "YTD", scope: args.accountId ? { kind: "account", accountId: args.accountId, label: "TFSA", currency: "CAD" } : payload().scope, benchmark: { ...payload().benchmark, key: args.benchmark ?? "sp500" } }) : {} }))),
    sendMessage: vi.fn(async () => {}),
    updateModelContext: vi.fn(async () => {}),
    destroy: () => {},
  };
  return { bridge, push: (p: PerformancePayload) => listener({ structuredContent: p }) };
}

test("renders the headline, return chips and the Growth tab tiles", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  expect(screen.getByText(/loading your performance/i)).toBeInTheDocument();
  push(payload());
  expect(await screen.findByText("+12.34%")).toBeInTheDocument();
  expect(screen.getByText(/Your return, YTD/)).toBeInTheDocument();
  expect(screen.getByText("Investment return +8.3%")).toBeInTheDocument();
  expect(screen.getByText("S&P 500 +6.4%")).toBeInTheDocument();
  expect(screen.getByText("Market gain")).toBeInTheDocument();
  expect(screen.getByText("+$6,222.23")).toBeInTheDocument();
  expect(screen.getByText("Net deposits")).toBeInTheDocument();
  expect(screen.getByText("+$3,777.77")).toBeInTheDocument();
  expect(screen.getByText(/CAD · as of/)).toBeInTheDocument();
  expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", screen.getByRole("tab", { name: "Growth" }).id);
  await waitFor(() => expect(bridge.updateModelContext).toHaveBeenCalledWith("Viewing performance: All accounts, period YTD, benchmark S&P 500."));
});

test("each tab shows its content", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("tab", { name: "vs Benchmark" }));
  expect(screen.getByRole("img", { name: /vs S&P 500/i })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Monthly" }));
  expect(screen.getByRole("img", { name: `Mar 2026: ${MINUS}3.3%` })).toBeInTheDocument();
  expect(screen.getByText(/Best month May 2026 \+4\.2%/)).toBeInTheDocument();
  expect(screen.getByText(new RegExp(`Worst month Mar 2026 ${MINUS}3\\.3%`))).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Risk" }));
  expect(screen.getByText("Max drawdown")).toBeInTheDocument();
  expect(screen.getByText(`${MINUS}7.1%`)).toBeInTheDocument();
  expect(screen.getByText(/Mar 5 → Apr 9/)).toBeInTheDocument();
  expect(screen.getByText("Volatility (annualised)")).toBeInTheDocument();
  expect(screen.getByText("14.3%")).toBeInTheDocument();
});

test("empty monthly list explains itself", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  push(payload({ monthly: [] }));
  fireEvent.click(await screen.findByRole("tab", { name: "Monthly" }));
  expect(screen.getByText("Not enough history for monthly returns yet")).toBeInTheDocument();
});

test("period and account changes call get_performance; All maps to ALL and no account id is displayed", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("radio", { name: "1Y" }));
  await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("get_performance", { period: "1Y", benchmark: "sp500" }));
  fireEvent.click(screen.getByRole("radio", { name: "All" }));
  await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("get_performance", { period: "ALL", benchmark: "sp500" }));
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-1" } });
  await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("get_performance", { period: "ALL", accountId: "acct-secret-1", benchmark: "sp500" }));
  expect(screen.getByRole("option", { name: "TFSA · CAD" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "All accounts" })).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("acct-secret");
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "" } });
  await waitFor(() => expect(bridge.callTool).toHaveBeenLastCalledWith("get_performance", { period: "ALL", benchmark: "sp500" }));
});

test("a benchmark change reloads, then saves the default benchmark", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("tab", { name: "vs Benchmark" }));
  fireEvent.change(screen.getByLabelText("Benchmark"), { target: { value: "tsx" } });
  await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("get_performance", { period: "YTD", benchmark: "tsx" }));
  await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("save_portfolio_settings", { benchmark: "tsx" }));
  const names = (bridge.callTool as any).mock.calls.map((c: any[]) => c[0]);
  expect(names.indexOf("get_performance")).toBeLessThan(names.indexOf("save_portfolio_settings"));
});

test("a failed default-benchmark save shows a notice", async () => {
  const { bridge, push } = fakeBridge(async (name, args) => name === "save_portfolio_settings" ? { isError: true } : { structuredContent: payload({ benchmark: { ...payload().benchmark, key: args.benchmark } }) });
  render(<Performance bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("tab", { name: "vs Benchmark" }));
  fireEvent.change(screen.getByLabelText("Benchmark"), { target: { value: "tsx" } });
  expect(await screen.findByText("Couldn't save default benchmark.")).toBeInTheDocument();
});

test("null figures show a dash and reason; estimated figures show est. and the note", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  const base = payload();
  push(payload({ figures: { ...base.figures, personalReturn: { ...fig(null, false, "insufficient_history"), annualised: false }, investmentReturn: fig(null, false, "no_solution"), benchmarkReturn: fig(null, false, "benchmark_unavailable"), netDeposits: fig(null, false, "flows_unavailable"), marketGain: fig(null, false, "flows_unavailable") } }));
  expect(await screen.findByText("not enough history yet")).toBeInTheDocument();
  expect(screen.getByText(/can't be calculated for these cash flows/)).toBeInTheDocument();
  expect(screen.getByText(/benchmark unavailable/)).toBeInTheDocument();
  expect(screen.getAllByText(/deposits unavailable right now/).length).toBeGreaterThan(0);
  expect(screen.getAllByText("—").length).toBeGreaterThan(0);
});

test("estimated figures show est. and the estimated note", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  const base = payload();
  push(payload({ figures: { ...base.figures, personalReturn: { ...fig(0.05, true), annualised: false } } }));
  expect(await screen.findByText("est.")).toBeInTheDocument();
  expect(screen.getByText("Includes estimated values")).toBeInTheDocument();
});

test("benchmark unavailable replaces only that tab's chart", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  const base = payload();
  push(payload({ series: { ...base.series, benchmarkIndex: [] }, benchmark: { ...base.benchmark, unavailableReason: "Benchmark data unavailable" }, figures: { ...base.figures, benchmarkReturn: fig(null, false, "benchmark_unavailable") } }));
  fireEvent.click(await screen.findByRole("tab", { name: "vs Benchmark" }));
  expect(screen.getByText("Benchmark unavailable right now")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Risk" }));
  expect(screen.getByText("Max drawdown")).toBeInTheDocument();
});

test("privacy hides money but not percentages and starts from the saved default", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  push(payload());
  expect(await screen.findByText("+$6,222.23")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  expect(screen.queryByText("+$6,222.23")).toBeNull();
  expect(screen.getAllByRole("img", { name: "Hidden amount" }).length).toBeGreaterThan(0);
  expect(screen.getByText("+12.34%")).toBeInTheDocument();
  expect(screen.getByText("Investment return +8.3%")).toBeInTheDocument();
});

test("privacy default from settings hides amounts initially", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  push(payload({ settings: { benchmark: "sp500", cadView: false, privacyDefault: true } }));
  await screen.findByText("+12.34%");
  expect(screen.queryByText("+$6,222.23")).toBeNull();
});

test("a failed get_performance keeps the previous headline and shows the notice", async () => {
  const { bridge, push } = fakeBridge(async () => ({ isError: true }));
  render(<Performance bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("radio", { name: "1Y" }));
  expect(await screen.findByText("Couldn't load that view. Showing the previous one.")).toBeInTheDocument();
  expect(screen.getByText("+12.34%")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "YTD" })).toHaveAttribute("aria-checked", "true");
});

test("a slower earlier request cannot overwrite a later one", async () => {
  const calls: Array<{ args: any; resolve: (r: ToolResult) => void }> = [];
  const { bridge, push } = fakeBridge((_n, args) => new Promise<ToolResult>((resolve) => { calls.push({ args, resolve }); }));
  render(<Performance bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("radio", { name: "1M" }));
  fireEvent.click(screen.getByRole("radio", { name: "1Y" }));
  const res = (a: any) => ({ structuredContent: payload({ period: a.period }) });
  calls[1].resolve(res(calls[1].args));
  await waitFor(() => expect(screen.getByRole("radio", { name: "1Y" })).toHaveAttribute("aria-checked", "true"));
  calls[0].resolve(res(calls[0].args));
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.getByRole("radio", { name: "1Y" })).toHaveAttribute("aria-checked", "true");
});

test("without an initial payload a retry banner calls show_performance", async () => {
  const { bridge, push } = fakeBridge(async (name) => (name === "show_performance" ? { structuredContent: payload() } : {}));
  render(<Performance bridge={bridge} />);
  push({} as any);
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("show_performance", {}));
  expect(await screen.findByText("+12.34%")).toBeInTheDocument();
});

test("history line shows for ALL or when earliest is inside the span, otherwise not", async () => {
  const q = [{ accountId: "acct-secret-1", method: "reconstructed", reason: null, driftFraction: null }];
  const a = fakeBridge();
  const { unmount } = render(<Performance bridge={a.bridge} />);
  a.push(payload({ history: { qualities: q, earliest: "2026-03-10" } }));
  expect(await screen.findByText(/History rebuilt from your activity since/)).toBeInTheDocument();
  unmount();
  const b = fakeBridge();
  render(<Performance bridge={b.bridge} />);
  b.push(payload({ history: { qualities: q, earliest: "2019-03-10" } }));
  await screen.findByText("+12.34%");
  expect(screen.queryByText(/History rebuilt from your activity since/)).toBeNull();
});

test("other currencies and partial spans are labelled", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  push(payload({ otherCurrencies: ["USD"], span: { start: "2026-03-10", end: "2026-10-15", partial: true, since: "2026-03-10" } }));
  expect(await screen.findByText("USD accounts are shown separately")).toBeInTheDocument();
  expect(screen.getByText(/Your return, since Mar 10/)).toBeInTheDocument();
});

test("messages and model context never carry ids, symbols or amounts, even after an account switch hydrates", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  push(payload());
  fireEvent.change(await screen.findByLabelText("Account"), { target: { value: "acct-secret-1" } });
  await waitFor(() => expect(bridge.updateModelContext).toHaveBeenCalledWith("Viewing performance: TFSA, period YTD, benchmark S&P 500."));
  const sent = JSON.stringify([...(bridge.sendMessage as any).mock.calls, ...(bridge.updateModelContext as any).mock.calls]);
  expect(sent).not.toMatch(/acct-secret|\d{2,}\.\d|\$/);
  expect(bridge.sendMessage).not.toHaveBeenCalled();
});

test("unknown deposits omit the money-put-in line and say so", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  const base = payload();
  push(payload({ series: { ...base.series, netDeposits: [] }, figures: { ...base.figures, netDeposits: fig(null, false, "flows_unavailable"), marketGain: fig(null, false, "flows_unavailable") } }));
  await screen.findByText("+12.34%");
  expect(screen.getByText("Deposits unavailable right now", { selector: ".w-deposits-note" })).toBeInTheDocument();
  const chart = screen.getAllByRole("img").find((e) => /^Value/.test(e.getAttribute("aria-label") ?? ""))!;
  expect(chart.getAttribute("aria-label")).not.toMatch(/money put in/);
  expect(chart.querySelector('[data-series="deposits"]')).toBeNull();
});

test("a non-zero starting net deposit gives per-date deltas and the first value as baseline", () => {
  const r = growthInputs(
    [{ date: "d1", value: 1000, source: "reported" }, { date: "d2", value: 1100, source: "reported" }, { date: "d3", value: 1500, source: "reported" }],
    [{ date: "d1", value: 500 }, { date: "d2", value: 500 }, { date: "d3", value: 800 }],
  );
  expect(r).toEqual({ baseline: 1000, deposits: [{ date: "d2", value: 0 }, { date: "d3", value: 300 }] });
  expect(growthInputs([], [])).toEqual({ baseline: 0, deposits: [] });
});

test("a failed benchmark load does not save the default", async () => {
  const { bridge, push } = fakeBridge(async () => ({ isError: true }));
  render(<Performance bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("tab", { name: "vs Benchmark" }));
  fireEvent.change(screen.getByLabelText("Benchmark"), { target: { value: "tsx" } });
  expect(await screen.findByText("Couldn't load that view. Showing the previous one.")).toBeInTheDocument();
  await new Promise((r) => setTimeout(r, 0));
  expect((bridge.callTool as any).mock.calls.some((c: any[]) => c[0] === "save_portfolio_settings")).toBe(false);
});

test("a benchmark change superseded by a period change is still saved once", async () => {
  const calls: Array<{ name: string; args: any; resolve: (r: ToolResult) => void }> = [];
  const { bridge, push } = fakeBridge((name, args) => new Promise<ToolResult>((resolve) => { calls.push({ name, args, resolve }); }));
  render(<Performance bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("tab", { name: "vs Benchmark" }));
  fireEvent.change(screen.getByLabelText("Benchmark"), { target: { value: "tsx" } });
  fireEvent.click(screen.getByRole("radio", { name: "1Y" }));
  expect(calls.map((c) => c.args)).toEqual([{ period: "YTD", benchmark: "tsx" }, { period: "1Y", benchmark: "tsx" }]);
  calls[0].resolve({ structuredContent: payload({ period: "YTD" }) });
  calls[1].resolve({ structuredContent: payload({ period: "1Y", benchmark: { ...payload().benchmark, key: "tsx" } }) });
  await waitFor(() => expect(calls.filter((c) => c.name === "save_portfolio_settings").map((c) => c.args)).toEqual([{ benchmark: "tsx" }]));
});

test("when a newer request fails and an older one succeeds late, the older is ignored and the notice shows", async () => {
  const calls: Array<{ args: any; resolve: (r: ToolResult) => void }> = [];
  const { bridge, push } = fakeBridge((_n, args) => new Promise<ToolResult>((resolve) => { calls.push({ args, resolve }); }));
  render(<Performance bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("radio", { name: "1M" }));
  fireEvent.click(screen.getByRole("radio", { name: "1Y" }));
  calls[1].resolve({ isError: true });
  expect(await screen.findByText("Couldn't load that view. Showing the previous one.")).toBeInTheDocument();
  calls[0].resolve({ structuredContent: payload({ period: "1M" }) });
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.getByRole("radio", { name: "YTD" })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByText("Couldn't load that view. Showing the previous one.")).toBeInTheDocument();
});

test("a result without a series is treated as a failure", async () => {
  const { bridge, push } = fakeBridge(async () => ({ structuredContent: { figures: payload().figures } as any }));
  render(<Performance bridge={bridge} />);
  push(payload());
  fireEvent.click(await screen.findByRole("radio", { name: "1Y" }));
  expect(await screen.findByText("Couldn't load that view. Showing the previous one.")).toBeInTheDocument();
});

test("a model-supplied benchmark override is never saved as the default by a period change", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  // show_performance was called with benchmark "tsx" while the saved default is the S&P 500.
  push(payload({ benchmark: { ...payload().benchmark, key: "tsx", name: "S&P/TSX Composite" } }));
  fireEvent.click(await screen.findByRole("radio", { name: "1Y" }));
  await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("get_performance", { period: "1Y", benchmark: "tsx" }));
  await new Promise((r) => setTimeout(r, 0));
  expect((bridge.callTool as any).mock.calls.some((c: any[]) => c[0] === "save_portfolio_settings")).toBe(false);
  // An explicit benchmark choice is still saved.
  fireEvent.click(screen.getByRole("tab", { name: "vs Benchmark" }));
  fireEvent.change(screen.getByLabelText("Benchmark"), { target: { value: "sp500" } });
  await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("save_portfolio_settings", { benchmark: "sp500" }));
});

test("drawdown chart omits lag-merged days and risk tiles show est. (N2, N7)", async () => {
  const base = payload();
  const series = { ...base.series, twrIndex: [{ date: "2026-01-05", value: 1 }, { date: "2026-01-07", value: 0.5 }, { date: "2026-01-08", value: 1 }], riskMergedDates: ["2026-01-07"] };
  expect(drawdownIndex(series).map((p) => p.date)).toEqual(["2026-01-05", "2026-01-08"]);
  expect(drawdownIndex({ ...series, riskMergedDates: undefined })).toHaveLength(3);
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  push(payload({ figures: { ...base.figures, maxDrawdown: { ...fig(0, true) }, volatility: fig(0.1, true) } }));
  fireEvent.click(await screen.findByRole("tab", { name: "Risk" }));
  const panel = screen.getByRole("tabpanel");
  expect(within(panel).getAllByText("est.").length).toBe(2);
});

// Brief 9: every estimated figure says "est."; joining accounts are not deposits.
test("7/8: market gain, net deposits, investment return and best/worst month show est. when estimated", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  const base = payload();
  push(payload({ figures: { ...base.figures, investmentReturn: fig(0.0831, true), marketGain: fig(6222.23, true), netDeposits: fig(3777.77, true),
    bestMonth: { ...fig(0.0421, true), month: "2026-05" }, worstMonth: { ...fig(-0.0333, true), month: "2026-03" } } }));
  expect(await screen.findByText("Investment return +8.3% est.")).toBeInTheDocument();
  const tiles = screen.getByText("Market gain").closest(".w-tiles") as HTMLElement;
  expect(within(tiles).getAllByText("est.").length).toBe(2);
  fireEvent.click(screen.getByRole("tab", { name: "Monthly" }));
  expect(screen.getByText(/Best month May 2026 \+4\.2% est\./)).toBeInTheDocument();
  expect(screen.getByText(new RegExp(`Worst month Mar 2026 ${MINUS}3\\.3% est\\.`))).toBeInTheDocument();
});

const small = (text: string) => (_: string, el: Element | null) => el?.tagName === "SMALL" && el.textContent === text;

test("6: accounts added to tracking show as their own line, not in net deposits", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  const base = payload();
  push(payload({ figures: { ...base.figures, netDeposits: fig(7000), accountsAddedToTracking: { ...fig(40000), joined: 40000, left: 0, movedFromTracked: 0 } } }));
  expect(await screen.findByText("+$7,000.00")).toBeInTheDocument();
  expect(screen.getByText(small("Accounts added to tracking +$40,000.00"))).toBeInTheDocument();
});

test("I2/I3/M3: a move from your other accounts, an est. join and a leave each get a line", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  const base = payload();
  push(payload({ figures: { ...base.figures, netDeposits: fig(0), accountsAddedToTracking: { ...fig(-450, true), joined: 950, movedFromTracked: -900, left: -500 } } }));
  expect(await screen.findByText(small("Accounts added to tracking +$950.00 est."))).toBeInTheDocument();
  expect(screen.getByText(small("of which $900.00 moved from your other accounts"))).toBeInTheDocument();
  expect(screen.getByText(small(`Accounts no longer tracked ${MINUS}$500.00 est.`))).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /money put in, plus accounts added to tracking/ })).toBeInTheDocument();
});

test("(b): the growth chart summary only mentions money put in when nothing was added", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  push(payload());
  const chart = await screen.findByRole("img", { name: /dashed line shows money put in/ });
  expect(chart.getAttribute("aria-label")).not.toMatch(/accounts added/);
});

test("6: no accounts-added line when nothing joined", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  const base = payload();
  push(payload({ figures: { ...base.figures, accountsAddedToTracking: fig(0) } }));
  await screen.findByText("Net deposits");
  expect(screen.queryByText(/Accounts added to tracking/)).toBeNull();
});


describe("Performance resilience", () => {
  afterEach(() => { vi.useRealTimers(); });

  test("shows a retry 30 s after initialize with no payload, and retry hydrates", async () => {
    vi.useFakeTimers();
    const { bridge } = fakeBridge();
    (bridge.callTool as any).mockImplementation(async (name: string) => ({ structuredContent: name === "show_performance" ? payload() : {} }));
    render(<Performance bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(29_500); });
    expect(screen.queryByText(/still loading/i)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.getByText(/still loading/i)).toBeInTheDocument();
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(bridge.callTool).toHaveBeenCalledWith("show_performance", {});
    expect(await screen.findByText("+12.34%")).toBeInTheDocument();
    expect(screen.queryByText(/still loading/i)).toBeNull();
  });

  test("tolerates an unknown top-level key", async () => {
    const { bridge, push } = fakeBridge();
    render(<Performance bridge={bridge} />);
    push({ ...payload(), futureField: { nested: [1, 2] } } as any);
    expect(await screen.findByText("+12.34%")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't display this view.")).toBeNull();
  });

  test("tolerates missing optional sub-fields", async () => {
    const { bridge, push } = fakeBridge();
    render(<Performance bridge={bridge} />);
    const p: any = payload();
    delete p.history; delete p.settings; delete p.series.riskMergedDates; delete p.figures.accountsAddedToTracking; delete p.span.since;
    push(p);
    expect(await screen.findByText("+12.34%")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't display this view.")).toBeNull();
  });
});

test("chart legends and tooltips: growth, vs benchmark and drawdown", async () => {
  const { bridge, push } = fakeBridge();
  const { container } = render(<Performance bridge={bridge} />);
  push(payload());
  await screen.findByText("+12.34%");
  const legend = () => [...container.querySelectorAll("[data-chart-legend] [data-legend]")].map((e) => e.textContent);
  const move = (x: number) => fireEvent.pointerMove(container.querySelector("[data-chart-plot]")!, { clientX: x, pointerType: "mouse" });
  const tip = () => container.querySelector("[data-chart-tip]")!.textContent!;
  expect(legend()).toEqual(["Your portfolio value", "Money you put in"]);
  move(300);
  expect(tip()).toContain("Value $61,234.56");
  expect(tip()).toContain("Money put in $55,012.33");
  expect(tip()).toContain("Market gain +$6,222.23");
  fireEvent.click(screen.getByRole("tab", { name: "vs Benchmark" }));
  expect(legend()).toEqual(["Your investment return", "S&P 500"]);
  move(150);
  expect(tip()).toContain("Your investment return +5.0% est.");
  expect(tip()).toContain("S&P 500 +3.0%");
  fireEvent.click(screen.getByRole("tab", { name: "Risk" }));
  move(300);
  expect(tip()).toMatch(/Drawdown (0\.0|−)/);
  expect(tip()).not.toContain("acct-secret");
});

describe("cadView on: combined CAD performance (task 11)", () => {
  const home = (over: Partial<NonNullable<PerformancePayload["home"]>> = {}): NonNullable<PerformancePayload["home"]> => ({ currency: "CAD", converted: true, estimated: true, notConvertedDays: 0, notConvertedAccounts: 0, flowNotConverted: null, native: null, ...over });
  const cad = (over: Partial<PerformancePayload> = {}) => payload({
    settings: { benchmark: "sp500", cadView: true, privacyDefault: false },
    figures: { ...payload().figures, investmentReturn: fig(0.0831, true), marketGain: fig(6222.23, true), netDeposits: fig(3777.77, true) },
    home: home(), ...over,
  });

  test("one CAD view: the returns are est., the caption explains the daily rate, no 'shown separately'", async () => {
    const { bridge, push } = fakeBridge();
    render(<Performance bridge={bridge} />);
    push(cad({ home: home({ notConvertedDays: 3 }) }));
    expect(await screen.findByText("Investment return +8.3% est.")).toBeInTheDocument();
    expect(screen.getByText("est. · 3 days not converted")).toBeInTheDocument();
    expect(screen.getByText(/USD values use each day's Bank of Canada rate/)).toBeInTheDocument();
    expect(screen.queryByText(/shown separately/)).toBeNull();
    expect(screen.getByRole("button", { name: "Show original currencies" })).toHaveAttribute("aria-pressed", "false");
  });

  test("one USD account keeps its own-currency figures under the CAD ones", async () => {
    const { bridge, push } = fakeBridge();
    const { container } = render(<Performance bridge={bridge} />);
    push(cad({ scope: { kind: "account", accountId: "acct-secret-2", label: "Margin", currency: "CAD" }, home: home({ native: { currency: "USD", value: 500, valueChange: fig(20), netDeposits: fig(10), marketGain: fig(-12.5) } }) }));
    await screen.findByText("Investment return +8.3% est.");
    expect(container.textContent).toContain("US$10.00");
    expect(container.textContent).toMatch(/−US\$12\.50|-US\$12\.50/);
  });

  test("nothing converted: the figures are in the account's currency with the note", async () => {
    const { bridge, push } = fakeBridge();
    render(<Performance bridge={bridge} />);
    push(cad({ scope: { kind: "account", accountId: "acct-secret-2", label: "Margin", currency: "USD" }, home: home({ converted: false, estimated: false, notConvertedAccounts: 1 }) }));
    expect(await screen.findByText("Not converted (no recent Bank of Canada rate)")).toBeInTheDocument();
  });

  test("no rate at all at portfolio scope: CAD accounts in CAD, USD accounts shown separately with the note, no converted caption", async () => {
    const { bridge, push } = fakeBridge();
    render(<Performance bridge={bridge} />);
    push(cad({ otherCurrencies: ["USD"], figures: payload().figures, home: home({ converted: false, estimated: false, notConvertedAccounts: 1 }) }));
    expect(await screen.findByText("Not converted (no recent Bank of Canada rate)")).toBeInTheDocument();
    expect(screen.getByText("USD accounts are shown separately")).toBeInTheDocument();
    expect(screen.queryByText(/USD values use each day's Bank of Canada rate/)).toBeNull();
  });

  test("an account never converted is counted as an account, not as days", async () => {
    const { bridge, push } = fakeBridge();
    render(<Performance bridge={bridge} />);
    push(cad({ home: home({ notConvertedAccounts: 1, notConvertedDays: 2 }) }));
    expect(await screen.findByText("est. · 2 days not converted · 1 account not converted")).toBeInTheDocument();
  });

  test("a USD flow without a rate withholds the return with the date; the values chart is still drawn", async () => {
    const { bridge, push } = fakeBridge();
    const { container } = render(<Performance bridge={bridge} />);
    const none = fig(null, false, "flow_not_converted");
    push(cad({
      figures: { ...payload().figures, personalReturn: { ...none, annualised: false }, investmentReturn: none, marketGain: none, netDeposits: none },
      series: { ...payload().series, twrIndex: [], netDeposits: [] },
      home: home({ flowNotConverted: "2026-09-10" }),
    }));
    expect(await screen.findAllByText("Return unavailable: a USD deposit or withdrawal on Sep 10 could not be converted")).not.toHaveLength(0);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  test("the switch saves cadView and reloads the view built with the other setting", async () => {
    const { bridge, push } = fakeBridge();
    render(<Performance bridge={bridge} />);
    push(cad());
    await screen.findByText("Investment return +8.3% est.");
    fireEvent.click(screen.getByRole("button", { name: "Show original currencies" }));
    await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("save_portfolio_settings", { cadView: false }));
    await waitFor(() => expect(bridge.callTool).toHaveBeenCalledWith("get_performance", { period: "YTD", benchmark: "sp500" }));
  });

  test("privacy hides the CAD and native amounts alike", async () => {
    const { bridge, push } = fakeBridge();
    const { container } = render(<Performance bridge={bridge} />);
    push(cad({ home: home({ native: { currency: "USD", value: 500, valueChange: fig(20), netDeposits: fig(10), marketGain: fig(-12.5) } }) }));
    await screen.findByText("Investment return +8.3% est.");
    fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
    expect(container.textContent).not.toMatch(/\$\d/);
  });

  test("cadView off keeps 'shown separately'", async () => {
    const { bridge, push } = fakeBridge();
    render(<Performance bridge={bridge} />);
    push(payload({ otherCurrencies: ["USD"], home: null }));
    expect(await screen.findByText("USD accounts are shown separately")).toBeInTheDocument();
  });
});

test("All with a year or more: per-year rates for you and the benchmark, with how it is worked out", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  const base = payload();
  push(payload({ period: "ALL", span: { start: "2023-01-03", end: "2026-10-15", partial: false },
    figures: { ...base.figures, investmentCagr: { value: 0.1123, estimated: true, years: 3.78 }, benchmarkCagr: { value: 0.0931, estimated: false, years: 3.78 } } }));
  const block = await screen.findByRole("region", { name: "Per year" });
  expect(within(block).getByRole("img", { name: "You +11.2% a year, S&P 500 +9.3% a year" })).toBeInTheDocument();
  expect(within(block).getByText("A year, over 3.8 years since Jan 3, 2023 (est.)")).toBeInTheDocument();
  fireEvent.click(within(block).getByRole("button", { name: "About the yearly rate" }));
  expect(within(block).getByRole("dialog")).toHaveTextContent(/Compound annual growth rate \(CAGR\)/);
});

test("under a year on All says so; YTD shows no per-year block", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  const base = payload();
  push(payload({ period: "ALL", figures: { ...base.figures, investmentCagr: { value: null, estimated: false, reason: "under_a_year" }, benchmarkCagr: { value: null, estimated: false, reason: "under_a_year" } } }));
  expect(await screen.findByText("Under a year of history, so no yearly rate yet")).toBeInTheDocument();
  cleanup();
  const again = fakeBridge();
  render(<Performance bridge={again.bridge} />);
  again.push(payload({ figures: { ...base.figures, investmentCagr: { value: 0.1, estimated: false, years: 2 }, benchmarkCagr: { value: 0.08, estimated: false, years: 2 } } }));
  await screen.findByText("+12.34%");
  expect(screen.queryByRole("region", { name: "Per year" })).toBeNull();
});

test("the comparison says what the benchmark leaves out (B7)", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  push(payload({ benchmark: { ...payload().benchmark, basis: "price index, dividends excluded" } }));
  expect(await screen.findByText("S&P 500: price index, dividends excluded")).toBeInTheDocument();
});

test("the benchmark chip carries its basis in the label, so no separate line is needed", async () => {
  const { bridge, push } = fakeBridge();
  render(<Performance bridge={bridge} />);
  push(payload({ benchmark: { ...payload().benchmark, name: "S&P/TSX Composite", label: "S&P/TSX Composite (price)", basis: "price index, dividends excluded" } }));
  expect(await screen.findByText("S&P/TSX Composite (price) +6.4%")).toBeInTheDocument();
  expect(screen.queryByText("S&P/TSX Composite: price index, dividends excluded")).toBeNull();
});

describe("same money in the index", () => {
  const withMatched = (over: Partial<PerformancePayload["figures"]> = {}) => payload({
    benchmark: { ...payload().benchmark, label: "S&P 500 (total return)", basis: "total return, dividends reinvested" },
    figures: { ...payload().figures, matchedBenchmarkReturn: { ...fig(0.1), annualised: false }, matchedBenchmarkValue: fig(60123.45), ...over },
  });

  test("sits right under your return, on the same scale, with the gap in points and what it would be worth", async () => {
    const { bridge, push } = fakeBridge();
    render(<Performance bridge={bridge} />);
    push(withMatched());
    const line = await screen.findByRole("group", { name: "Same money in the index" });
    expect(line).toHaveTextContent("Same money in S&P 500 (total return)");
    expect(line).toHaveTextContent("+10.00%");
    expect(line).toHaveTextContent("You +2.34 pts");
    expect(line).toHaveTextContent("$60,123");
    fireEvent.click(within(line).getByRole("button", { name: "About same money in the index" }));
    expect(within(line).getByRole("dialog")).toHaveTextContent(/every dollar you added had gone into the index on the same day/);
  });

  test("behind the index reads as negative points; privacy hides the amount but not the return", async () => {
    const { bridge, push } = fakeBridge();
    render(<Performance bridge={bridge} />);
    push(withMatched({ matchedBenchmarkReturn: { ...fig(0.15), annualised: false } }));
    const line = await screen.findByRole("group", { name: "Same money in the index" });
    expect(line).toHaveTextContent(`You ${MINUS}2.66 pts`);
    fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
    expect(line).not.toHaveTextContent("$60,123");
    expect(line).toHaveTextContent("+15.00%");
  });

  test("withdrawals larger than the index holding: said in words, never a number", async () => {
    const { bridge, push } = fakeBridge();
    render(<Performance bridge={bridge} />);
    push(withMatched({ matchedBenchmarkReturn: { ...fig(null, false, "no_solution"), annualised: false, exhausted: true }, matchedBenchmarkValue: fig(null, false, "no_solution") }));
    const line = await screen.findByRole("group", { name: "Same money in the index" });
    expect(line).toHaveTextContent("You took out more than the same money in the index would have held");
  });

  test("older payloads without it show no line", async () => {
    const { bridge, push } = fakeBridge();
    render(<Performance bridge={bridge} />);
    push(payload());
    await screen.findByText("+12.34%");
    expect(screen.queryByRole("group", { name: "Same money in the index" })).toBeNull();
  });

  test("a yearly headline puts the chips on the same yearly scale", async () => {
    const { bridge, push } = fakeBridge();
    render(<Performance bridge={bridge} />);
    push(withMatched({
      personalReturn: { ...fig(0.1234), annualised: true }, matchedBenchmarkReturn: { ...fig(0.1), annualised: true },
      investmentCagr: { value: 0.09, estimated: false, years: 3 }, benchmarkCagr: { value: 0.101, estimated: false, years: 3 },
    }));
    const line = await screen.findByRole("group", { name: "Same money in the index" });
    expect(line).toHaveTextContent("+10.00% /yr");
    expect(screen.getByText("Investment return +9.0% /yr")).toBeInTheDocument();
    expect(screen.getByText("S&P 500 (total return) +10.1% /yr")).toBeInTheDocument();
  });
});
