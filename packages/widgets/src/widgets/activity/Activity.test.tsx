import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { Activity } from "./Activity";
import type { ActivityPage, ActivityRow, SymbolHistory } from "./types";

const MINUS = "−";
const row = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  id: "r1", date: "2026-10-16", accountId: "acct-secret-1", accountLabel: "TFSA", category: "investing", type: "BUY", symbol: "VFV",
  description: "Bought VFV", units: 10, price: 112.4, priceCurrency: "CAD", amount: -1124, currency: "CAD", ...over,
});
const baseRows = (): ActivityRow[] => [
  row(),
  row({ id: "r2", type: "DIVIDEND", symbol: "XEQT", description: "Dividend XEQT", units: null, price: null, amount: 18.62, accountLabel: "RRSP", accountId: "acct-secret-2" }),
  row({ id: "r3", date: "2026-10-10", type: "SELL", symbol: "AAPL", description: "Sold AAPL", units: 5, price: 230, priceCurrency: "USD", amount: 1150, currency: "USD", accountLabel: "Margin", accountId: "acct-secret-3" }),
  row({ id: "r4", date: "2025-12-30", category: "moving_money", type: "DEPOSIT", symbol: null, description: "Deposit", units: null, price: null, amount: 500, accountLabel: "TFSA" }),
];
function page(over: Partial<ActivityPage> = {}): ActivityPage {
  return {
    rows: baseRows(), nextCursor: null, restarted: false,
    totals: [{ currency: "CAD", bought: 8420, sold: 1150.5, dividends: 312.4, dividendsGross: 312.4, withholding: 0, deposits: 0, withdrawals: 0, feeTransactions: 0 }, { currency: "USD", bought: 77, sold: 1150, dividends: 3, dividendsGross: 3.53, withholding: -0.53, deposits: 0, withdrawals: 0, feeTransactions: 0 }],
    counts: { total: 4, byType: { BUY: 1 } },
    filters: { categories: ["investing"], from: "2026-07-18", to: "2026-10-16" },
    accounts: [{ id: "acct-secret-1", label: "TFSA", kind: "investment" }, { id: "acct-secret-2", label: "RRSP", kind: "investment" }],
    syncing: [], settings: { benchmark: "sp500", cadView: false, privacyDefault: false }, asOf: "2026-10-16T15:00:00Z", ...over,
  };
}
function history(over: Partial<SymbolHistory> = {}): SymbolHistory {
  return {
    symbol: "VFV", name: "Vanguard S&P 500 Index ETF", currency: "CAD", period: "ALL",
    prices: [{ date: "2026-09-01", close: 10 }, { date: "2026-09-02", close: 11 }, { date: "2026-09-03", close: 12 }],
    priceUnavailable: false,
    position: {
      currency: "CAD", units: 46, avgCost: 98.12, avgCostEstimated: false, dividends: 141.08, otherDividends: [],
      points: [{ date: "2026-09-01", units: 46, avgCost: 98.12 }],
      markers: [{ date: "2026-09-02", side: "buy", units: 10, price: 11 }, { date: "2026-09-03", side: "sell", units: 4, price: 12 }],
    },
    reportedUnits: 46, reported: null, costHistory: "unverified", otherCurrencies: [], asOf: "2026-10-16T15:00:00Z", ...over,
  };
}
type Impl = (name: string, args: any) => Promise<ToolResult> | ToolResult;
function fakeBridge(impl?: Impl) {
  let listener: (r: ToolResult) => void = () => {};
  const callTool = vi.fn(async (name: string, args: any) => {
    if (impl) return impl(name, args);
    if (name === "get_symbol_history") return { structuredContent: history() };
    return { structuredContent: page({ rows: args.symbol ? [row({ id: "s1" })] : baseRows() }) };
  });
  const bridge: Bridge = {
    ready: Promise.resolve({ hostTools: true, context: {} }),
    onToolResult: (fn) => { listener = fn; return () => {}; },
    onContext: () => () => {},
    toolArguments: () => ({}), openLink: async () => true,
    callTool, sendMessage: vi.fn(async () => {}), updateModelContext: vi.fn(async () => {}), destroy: () => {},
  };
  return { bridge, callTool, push: (p: ActivityPage) => listener({ structuredContent: p }) };
}
const lastCall = (callTool: any, name: string) => callTool.mock.calls.filter((c: any[]) => c[0] === name).at(-1)![1];

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-16T16:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });

test("renders the summary, day groups and rows", async () => {
  const { bridge, push } = fakeBridge();
  render(<Activity bridge={bridge} />);
  expect(screen.getByText(/loading your activity/i)).toBeInTheDocument();
  push(page());
  expect(await screen.findByText("Today, Oct 16")).toBeInTheDocument();
  expect(screen.getByText("Oct 10")).toBeInTheDocument();
  expect(screen.getByText("Dec 30, 2025")).toBeInTheDocument();
  expect(screen.getByText("Bought")).toBeInTheDocument();
  expect(screen.getByText("$8,420.00")).toBeInTheDocument();
  expect(screen.getByText("+$312.40")).toBeInTheDocument();
  expect(screen.getByText(/US\$77\.00/)).toBeInTheDocument(); // secondary currency line
  expect(screen.getByText(`${MINUS}$1,124.00`)).toBeInTheDocument();
  expect(screen.getByText("+$18.62")).toBeInTheDocument();
  expect(screen.getByText("+US$1,150.00")).toBeInTheDocument();
  expect(screen.getByText(/TFSA · 10 ×/)).toBeInTheDocument();
  expect(screen.getByText("$112.40")).toBeInTheDocument();
  expect(screen.queryByText(/RRSP · /)).toBeNull(); // no units x price when either is null
  expect(screen.getByText("Read-only")).toBeInTheDocument();
  const select = screen.getByLabelText("Account") as HTMLSelectElement;
  expect([...select.options].map((o) => o.textContent)).toEqual(["All accounts", "TFSA", "RRSP"]);
  expect(document.body.textContent).not.toMatch(/acct-secret/);
});

test("category chips and the range call get_activity_page with the filters; the last chip cannot be turned off", async () => {
  const { bridge, push, callTool } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(page());
  const investing = await screen.findByRole("button", { name: "Investing" });
  expect(investing).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(investing);
  expect(callTool).not.toHaveBeenCalled();
  expect(investing).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "+ Moving money" }));
  await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
  expect(callTool).toHaveBeenLastCalledWith("get_activity_page", { categories: ["investing", "moving_money"], from: "2026-07-18" });
  fireEvent.click(investing);
  await waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
  expect(lastCall(callTool, "get_activity_page").categories).toEqual(["moving_money"]);
  fireEvent.change(screen.getByLabelText("Range"), { target: { value: "30 days" } });
  await waitFor(() => expect(callTool).toHaveBeenCalledTimes(3));
  expect(lastCall(callTool, "get_activity_page")).toEqual({ categories: ["moving_money"], from: "2026-09-16" });
  fireEvent.change(screen.getByLabelText("Range"), { target: { value: "YTD" } });
  await waitFor(() => expect(callTool).toHaveBeenCalledTimes(4));
  expect(lastCall(callTool, "get_activity_page").from).toBe("2026-01-01");
  fireEvent.change(screen.getByLabelText("Range"), { target: { value: "1Y" } });
  await waitFor(() => expect(callTool).toHaveBeenCalledTimes(5));
  expect(lastCall(callTool, "get_activity_page").from).toBe("2025-10-16");
  fireEvent.change(screen.getByLabelText("Range"), { target: { value: "All" } });
  await waitFor(() => expect(callTool).toHaveBeenCalledTimes(6));
  expect(lastCall(callTool, "get_activity_page").from).toBe("2000-01-01");
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-2" } });
  await waitFor(() => expect(callTool).toHaveBeenCalledTimes(7));
  expect(lastCall(callTool, "get_activity_page").accountId).toBe("acct-secret-2");
});

test("search is debounced by 300 ms and sends the query", async () => {
  const { bridge, push, callTool } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(page());
  const box = await screen.findByLabelText("Search symbol");
  fireEvent.input(box, { target: { value: "V" } });
  fireEvent.input(box, { target: { value: "VFV" } });
  await new Promise((r) => setTimeout(r, 150));
  expect(callTool).not.toHaveBeenCalled();
  await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
  expect(callTool).toHaveBeenCalledWith("get_activity_page", { categories: ["investing"], from: "2026-07-18", query: "VFV" });
});

test("load more appends rows with the cursor and filters; a restarted page replaces them", async () => {
  let n = 0;
  const { bridge, push, callTool } = fakeBridge(async (_name, args) => {
    n += 1;
    if (n === 1) return { structuredContent: page({ rows: [row({ id: "n1", description: "Bought 1 NEW" })], nextCursor: "c2" }) };
    return { structuredContent: page({ rows: [row({ id: "n2", description: "Bought 2 FRESH" })], restarted: true }) };
  });
  render(<Activity bridge={bridge} />);
  push(page({ nextCursor: "c1" }));
  fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
  expect(await screen.findByText("Bought 1 NEW")).toBeInTheDocument();
  expect(callTool).toHaveBeenLastCalledWith("get_activity_page", { cursor: "c1", categories: ["investing"], from: "2026-07-18" });
  expect(screen.getByText("Bought VFV")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(await screen.findByText("Bought 2 FRESH")).toBeInTheDocument();
  expect(screen.queryByText("Bought VFV")).toBeNull();
  expect(screen.queryByText("Bought 1 NEW")).toBeNull();
  expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
});

test("a symbol row opens the symbol view with markers and tiles, and Back returns", async () => {
  const { bridge, push, callTool } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(page());
  fireEvent.click(await screen.findByRole("button", { name: /View VFV history/ }));
  expect(await screen.findByText("Vanguard S&P 500 Index ETF")).toBeInTheDocument();
  expect(callTool).toHaveBeenCalledWith("get_symbol_history", { symbol: "VFV", period: "ALL" });
  expect(callTool).toHaveBeenCalledWith("get_activity_page", expect.objectContaining({ symbol: "VFV", categories: ["investing"], from: "2000-01-01" }));
  expect(screen.getByRole("img", { name: /VFV.*1 buy, 1 sell/ })).toBeInTheDocument();
  expect(screen.getByText("Units held")).toBeInTheDocument();
  expect(screen.getByText("46")).toBeInTheDocument();
  // The tile, not the chart axis (whose top label is also the average cost here).
  expect(screen.getByText("Avg cost").closest(".w-tile")!.textContent).toContain("$98.12");
  expect(screen.getByText("+$141.08")).toBeInTheDocument();
  expect(screen.queryByText(/Also held in/)).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "1Y" }));
  await waitFor(() => expect(callTool).toHaveBeenLastCalledWith("get_symbol_history", { symbol: "VFV", period: "1Y" }));
  fireEvent.click(screen.getByRole("button", { name: "← All activity" }));
  expect(await screen.findByLabelText("Search symbol")).toBeInTheDocument();
  expect(screen.getByText("Oct 10")).toBeInTheDocument();
  expect(screen.queryByText("Units held")).toBeNull();
});

test("price unavailable, other currencies and an inconsistent average cost", async () => {
  const h = history({ priceUnavailable: true, prices: [], otherCurrencies: ["USD"], position: { ...history().position, avgCost: null, reason: "inconsistent" } });
  const { bridge, push } = fakeBridge(async (name, args) => name === "get_symbol_history" ? { structuredContent: h } : { structuredContent: page({ rows: [row()] }) });
  render(<Activity bridge={bridge} />);
  push(page());
  fireEvent.click(await screen.findByRole("button", { name: /View VFV history/ }));
  expect(await screen.findByText("Price history unavailable")).toBeInTheDocument();
  expect(screen.getByText("Also held in USD")).toBeInTheDocument();
  expect(screen.getByText(/records show more sold than bought/)).toBeInTheDocument();
});

test("an estimated average cost is marked est.", async () => {
  const h = history({ position: { ...history().position, avgCostEstimated: true } });
  const { bridge, push } = fakeBridge(async (name) => name === "get_symbol_history" ? { structuredContent: h } : { structuredContent: page({ rows: [row()] }) });
  render(<Activity bridge={bridge} />);
  push(page());
  fireEvent.click(await screen.findByRole("button", { name: /View VFV history/ }));
  expect(await screen.findByText("est. from activity")).toBeInTheDocument();
});

// HIMS (owner screenshots): Wealthsimple reports avg US$36.64; the replay gives US$45.37.
const hims = (over: Partial<SymbolHistory> = {}) => history({
  symbol: "HIMS", name: null, currency: "USD",
  position: { ...history().position, currency: "USD", units: 204.2793, avgCost: 45.37, dividends: 0,
    points: [{ date: "2026-09-01", units: 204.2793, avgCost: null }] },
  reportedUnits: 204.2793,
  reported: { units: 204.2793, avgCost: 36.64, bookCost: 7485.12, marketValue: 5730.06, totalReturn: -1755.06, totalReturnFraction: -0.2345, currency: "USD" },
  costHistory: "unavailable", ...over,
});
const openSymbol = async (h: SymbolHistory) => {
  const { bridge, push } = fakeBridge(async (name) => name === "get_symbol_history" ? { structuredContent: h } : { structuredContent: page({ rows: [row()] }) });
  render(<Activity bridge={bridge} />);
  push(page());
  fireEvent.click(await screen.findByRole("button", { name: /View VFV history/ }));
  await screen.findByText("Units held");
};

test("tiles show the brokerage-reported units, average, book cost and total return with a caption", async () => {
  await openSymbol(hims());
  expect(screen.getByText("204.2793")).toBeInTheDocument();
  expect(screen.getByText("US$36.64")).toBeInTheDocument();
  expect(screen.queryByText("US$45.37")).toBeNull();
  expect(screen.getByText("Book cost")).toBeInTheDocument();
  expect(screen.getByText("US$7,485.12")).toBeInTheDocument();
  const ret = screen.getByText("Gain vs book cost").closest(".w-tile")!;
  expect(within(ret as HTMLElement).getByText(`${MINUS}US$1,755.06`)).toBeInTheDocument();
  expect(within(ret as HTMLElement).getByText(`${MINUS}23.45%`)).toBeInTheDocument();
  expect(ret.querySelector("b")).toHaveClass("down");
  expect(screen.getByText("Brokerage reported")).toBeInTheDocument();
  expect(screen.getByText("Dividends (net of withholding)")).toBeInTheDocument();
  expect(screen.queryByText(/est\. from activity/)).toBeNull();
  expect(screen.queryByText(/Brokerage reports/)).toBeNull();
});

test("a gain is toned up; missing cost figures show a dash", async () => {
  await openSymbol(hims({ reported: { units: 10, avgCost: 30, bookCost: 300, marketValue: 360, totalReturn: 60, totalReturnFraction: 0.2, currency: "USD" }, costHistory: "matches" }));
  const ret = screen.getByText("Gain vs book cost").closest(".w-tile")!;
  expect(within(ret as HTMLElement).getByText("+US$60.00")).toBeInTheDocument();
  expect(within(ret as HTMLElement).getByText("+20.00%")).toBeInTheDocument();
  expect(ret.querySelector("b")).toHaveClass("up");
  cleanup();
  await openSymbol(hims({ reported: { units: 10, avgCost: null, bookCost: null, marketValue: 360, totalReturn: null, totalReturnFraction: null, currency: "USD" }, costHistory: "unverified" }));
  const avg = screen.getByText("Avg cost").closest(".w-tile")!;
  expect(avg.textContent).toContain("—");
  expect(screen.getByText("Book cost").closest(".w-tile")!.textContent).toContain("—");
});

test("an unavailable cost history hides the dashed line and says why", async () => {
  await openSymbol(hims({ position: { ...hims().position, points: [{ date: "2026-09-01", units: 204.2793, avgCost: null }] } }));
  expect(screen.getByText("Cost history unavailable — rebuilt cost didn't match Wealthsimple")).toBeInTheDocument();
  const chart = screen.getByRole("img", { name: /HIMS trades/ });
  expect(chart.getAttribute("aria-label")).not.toMatch(/dashed line/);
  expect(screen.getByRole("img", { name: /1 buy, 1 sell/ })).toBeInTheDocument(); // markers unaffected
});

test("an unverified cost history draws the line labelled est.; matches draws it unlabelled", async () => {
  await openSymbol(hims({ reported: null, costHistory: "unverified", position: { ...hims().position, points: [{ date: "2026-09-01", units: 204.2793, avgCost: 45.37 }] } }));
  expect(screen.getByRole("img", { name: /dashed line shows average cost/ })).toBeInTheDocument();
  expect(screen.getByText("Dashed line: average cost est. from activity")).toBeInTheDocument();
  expect(screen.queryByText(/Cost history unavailable/)).toBeNull();
  cleanup();
  await openSymbol(hims({ costHistory: "matches", position: { ...hims().position, points: [{ date: "2026-09-01", units: 204.2793, avgCost: 36.7 }] } }));
  expect(screen.getByRole("img", { name: /dashed line shows average cost/ })).toBeInTheDocument();
  expect(screen.queryByText(/Dashed line:/)).toBeNull();
});

test("a closed position falls back to the replayed figures labelled est. from activity", async () => {
  await openSymbol(hims({ reported: null, reportedUnits: 0, costHistory: "unverified", position: { ...hims().position, units: 0, avgCost: null } }));
  expect(screen.queryByText("Book cost")).toBeNull();
  expect(screen.queryByText("Brokerage reported")).toBeNull();
  expect(screen.getByText("Avg cost").closest(".w-tile")!.textContent).toContain("—");
  cleanup();
  await openSymbol(hims({ reported: null, reportedUnits: null, costHistory: "unverified" }));
  expect(screen.getByText("US$45.37")).toBeInTheDocument();
  expect(screen.getByText("est. from activity")).toBeInTheDocument();
});

test("privacy hides the reported amounts, units and return", async () => {
  await openSymbol(hims());
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  for (const text of ["204.2793", "US$36.64", "US$7,485.12", `${MINUS}US$1,755.06`]) expect(screen.queryByText(text)).toBeNull();
  expect(document.body.textContent).not.toMatch(/23\.45/);
  expect(screen.getByText("Brokerage reported")).toBeInTheDocument();
});

test("a non-symbol row sends a value-free message; a rejection shows the notice", async () => {
  const { bridge, push } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(page());
  fireEvent.click(await screen.findByRole("button", { name: /Deposit/ }));
  expect(bridge.sendMessage).toHaveBeenCalledWith("Tell me about my deposit activity in my TFSA");
  (bridge.sendMessage as any).mockRejectedValueOnce(new Error("no"));
  fireEvent.click(screen.getByRole("button", { name: /Deposit/ }));
  expect(await screen.findByText("Couldn't send that to the chat.")).toBeInTheDocument();
});

test("privacy hides amounts and prices", async () => {
  const { bridge, push } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(page());
  await screen.findByText(`${MINUS}$1,124.00`);
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  expect(screen.queryByText(`${MINUS}$1,124.00`)).toBeNull();
  expect(screen.queryByText("$8,420.00")).toBeNull();
  expect(screen.queryByText(/112\.40/)).toBeNull();
  // Units are hidden too (final review I4); the description carries neither units nor prices.
  expect(screen.getByText("Bought VFV")).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/\b10 ×|5 ×/);
  expect(screen.getAllByRole("img", { name: "Hidden amount" }).length).toBeGreaterThan(4);
  expect(screen.getByRole("button", { name: "Show amounts" })).toBeInTheDocument();
});

test("syncing and empty states", async () => {
  const { bridge, push } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(page({ rows: [], totals: [], syncing: ["acct-secret-1"] }));
  expect(await screen.findByText("No activity matches these filters")).toBeInTheDocument();
  expect(screen.getByText(/still syncing/i)).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/acct-secret/);
});

test("syncing for an account outside the selected scope is not shown", async () => {
  const { bridge, push } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(page({ syncing: ["acct-secret-2"], filters: { ...page().filters, accountId: "acct-secret-1" } }));
  await screen.findByText("Oct 10");
  expect(screen.queryByText(/still syncing/i)).toBeNull();
});

test("model context carries no amounts, ids or digits beyond the range label", async () => {
  const { bridge, push } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(page());
  await waitFor(() => expect(bridge.updateModelContext).toHaveBeenCalledWith("Viewing activity: All accounts, Investing, 90 days"));
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-2" } });
  fireEvent.click(screen.getByRole("button", { name: "+ Cash & spending" }));
  await waitFor(() => expect((bridge.updateModelContext as any).mock.calls.length).toBeGreaterThan(1));
  fireEvent.click(await screen.findByRole("button", { name: /View VFV history/ }));
  await screen.findByText("Units held");
  const texts = () => (bridge.updateModelContext as any).mock.calls.map((c: any[]) => c[0]) as string[];
  await waitFor(() => expect(texts().at(-1)).toBe("Viewing activity: RRSP, Investing + Cash & spending, 90 days, symbol VFV"));
  for (const t of texts()) {
    expect(t.replace(/90 days|30 days|1Y/g, "")).not.toMatch(/\d|acct|secret|\$/);
  }
});

test("an unavailable payload shows a retry that calls show_activity", async () => {
  const { bridge, push, callTool } = fakeBridge(async () => ({ structuredContent: page() }));
  render(<Activity bridge={bridge} />);
  push({ ...page(), rows: undefined as any });
  expect(await screen.findByText("Activity unavailable right now")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Oct 10")).toBeInTheDocument();
  expect(callTool).toHaveBeenCalledWith("show_activity", {});
});

test("a stale response is ignored and a failure keeps the previous view with a notice", async () => {
  const resolvers: Array<(r: ToolResult) => void> = [];
  const { bridge, push } = fakeBridge(() => new Promise<ToolResult>((resolve) => { resolvers.push(resolve); }));
  render(<Activity bridge={bridge} />);
  push(page());
  await screen.findByText("Oct 10");
  fireEvent.click(screen.getByRole("button", { name: "+ Moving money" }));
  fireEvent.click(screen.getByRole("button", { name: "+ Cash & spending" }));
  await waitFor(() => expect(resolvers.length).toBe(2));
  resolvers[1]({ structuredContent: page({ rows: [row({ id: "w", description: "Winner row", symbol: null })] }) });
  expect(await screen.findByText("Winner row")).toBeInTheDocument();
  resolvers[0]({ structuredContent: page({ rows: [row({ id: "l", description: "Loser row", symbol: null })] }) });
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText("Loser row")).toBeNull();
  fireEvent.change(screen.getByLabelText("Range"), { target: { value: "30 days" } });
  await waitFor(() => expect(resolvers.length).toBe(3));
  resolvers[2]({ isError: true });
  expect(await screen.findByText("Couldn't load that view. Showing the previous one.")).toBeInTheDocument();
  expect(screen.getByText("Winner row")).toBeInTheDocument();
  expect((screen.getByLabelText("Range") as HTMLSelectElement).value).toBe("90 days");
});

// ---- Fix round 1 ----

test("a payload with filters.symbol opens the symbol view without a tap and keeps it", async () => {
  const { bridge, push, callTool } = fakeBridge();
  const view = render(<Activity bridge={bridge} />);
  push(page({ rows: [row()], filters: { ...page().filters, symbol: "VFV", accountId: "acct-secret-1" } }));
  expect(await screen.findByText("Units held")).toBeInTheDocument();
  expect(callTool).toHaveBeenCalledWith("get_symbol_history", { symbol: "VFV", accountId: "acct-secret-1", period: "ALL" });
  expect(callTool).toHaveBeenCalledWith("get_activity_page", expect.objectContaining({ symbol: "VFV", accountId: "acct-secret-1" }));
  view.rerender(<Activity bridge={bridge} />);
  expect(screen.getByText("Units held")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "← All activity" }));
  await screen.findByLabelText("Search symbol");
  await waitFor(() => expect(lastCall(callTool, "get_activity_page").symbol).toBeUndefined());
});

test("a bare symbol query whose rows all share one listing opens that listing's view (XEQT -> XEQT.TO)", async () => {
  const { bridge, push, callTool } = fakeBridge();
  render(<Activity bridge={bridge} />);
  const listed = [row({ id: "x1", symbol: "XEQT.TO", description: "Bought XEQT.TO" }), row({ id: "x2", symbol: " xeqt.to ", description: "Bought XEQT.TO" })];
  push(page({ rows: listed, filters: { ...page().filters, symbol: "XEQT" } }));
  expect(await screen.findByText("Units held")).toBeInTheDocument();
  expect(callTool).toHaveBeenCalledWith("get_symbol_history", { symbol: "XEQT.TO", period: "ALL" });
  expect(callTool).toHaveBeenCalledWith("get_activity_page", expect.objectContaining({ symbol: "XEQT.TO" }));
  expect(callTool.mock.calls.some((c: any[]) => c[0] === "get_symbol_history" && c[1].symbol === "XEQT")).toBe(false);
});

test("a bare symbol query matching several listings keeps the feed", async () => {
  const { bridge, push, callTool } = fakeBridge();
  render(<Activity bridge={bridge} />);
  const mixed = [row({ id: "x1", symbol: "XEQT.TO", description: "Bought on TSX" }), row({ id: "x2", symbol: "XEQT.NE", description: "Bought on NEO" })];
  push(page({ rows: mixed, filters: { ...page().filters, symbol: "XEQT" } }));
  expect(await screen.findByText("Bought on TSX")).toBeInTheDocument();
  expect(screen.getByText("Bought on NEO")).toBeInTheDocument();
  expect(screen.queryByText("Units held")).toBeNull();
  expect(callTool.mock.calls.some((c: any[]) => c[0] === "get_symbol_history")).toBe(false);
});

test("Load more is disabled during a filter change and no flags stay stuck", async () => {
  const resolvers: Array<(r: ToolResult) => void> = [];
  const { bridge, push, callTool } = fakeBridge(() => new Promise<ToolResult>((resolve) => { resolvers.push(resolve); }));
  render(<Activity bridge={bridge} />);
  push(page({ nextCursor: "c1" }));
  const more = await screen.findByRole("button", { name: "Next page" });
  fireEvent.click(screen.getByRole("button", { name: "+ Moving money" }));
  await waitFor(() => expect(resolvers.length).toBe(1));
  expect(more).toBeDisabled();
  fireEvent.click(more);
  expect(callTool).toHaveBeenCalledTimes(1);
  resolvers[0]({ structuredContent: page({ rows: [row({ id: "f", description: "Filtered row", symbol: null })], nextCursor: "c9" }) });
  expect(await screen.findByText("Filtered row")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).not.toBeDisabled());
});

test("a filter change during Load more wins and clears the busy state", async () => {
  const resolvers: Array<(r: ToolResult) => void> = [];
  const { bridge, push } = fakeBridge(() => new Promise<ToolResult>((resolve) => { resolvers.push(resolve); }));
  render(<Activity bridge={bridge} />);
  push(page({ nextCursor: "c1" }));
  fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
  await waitFor(() => expect(resolvers.length).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: "+ Moving money" }));
  await waitFor(() => expect(resolvers.length).toBe(2));
  resolvers[1]({ structuredContent: page({ rows: [row({ id: "w", description: "Winner row", symbol: null })], nextCursor: "c2" }) });
  await screen.findByText("Winner row");
  resolvers[0]({ structuredContent: page({ rows: [row({ id: "l", description: "Stale more", symbol: null })] }) });
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText("Stale more")).toBeNull();
  expect(screen.getByRole("button", { name: "Next page" })).not.toBeDisabled();
});

test("a failed Load more keeps the rows, shows a notice and re-enables the button", async () => {
  const { bridge, push } = fakeBridge(async () => ({ isError: true }));
  render(<Activity bridge={bridge} />);
  push(page({ nextCursor: "c1" }));
  fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
  expect(await screen.findByText("Couldn't load that view. Showing the previous one.")).toBeInTheDocument();
  expect(screen.getByText("Oct 10")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next page" })).not.toBeDisabled();
});

test("symbol view paging appends, restarted replaces, and the account select reloads", async () => {
  let n = 0;
  const { bridge, push, callTool } = fakeBridge(async (name, args) => {
    if (name === "get_symbol_history") return { structuredContent: history() };
    n += 1;
    if (n === 1) return { structuredContent: page({ rows: [row({ id: "s1", description: "Bought 10 VFV" })], nextCursor: "s2" }) };
    if (n === 2) return { structuredContent: page({ rows: [row({ id: "s2", description: "Sold 4 VFV" })], nextCursor: "s3" }) };
    if (n === 3) return { structuredContent: page({ rows: [row({ id: "s3", description: "Fresh VFV" })], restarted: true }) };
    return { structuredContent: page({ rows: [row({ id: "s4", description: "RRSP VFV" })] }) };
  });
  render(<Activity bridge={bridge} />);
  push(page());
  fireEvent.click(await screen.findByRole("button", { name: /View VFV history/ }));
  await screen.findByText("Units held");
  fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
  await screen.findByText("Sold 4 VFV");
  expect(callTool).toHaveBeenLastCalledWith("get_activity_page", { cursor: "s2", symbol: "VFV", categories: ["investing"], from: "2000-01-01" });
  expect(screen.getByText("Bought 10 VFV")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByText("Fresh VFV");
  expect(screen.queryByText("Bought 10 VFV")).toBeNull();
  expect(screen.queryByText("Sold 4 VFV")).toBeNull();
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-2" } });
  await screen.findByText("RRSP VFV");
  expect(callTool).toHaveBeenCalledWith("get_symbol_history", { symbol: "VFV", accountId: "acct-secret-2", period: "ALL" });
  expect(lastCall(callTool, "get_activity_page")).toEqual({ symbol: "VFV", accountId: "acct-secret-2", categories: ["investing"], from: "2000-01-01" });
  expect(screen.getByLabelText("Account")).not.toBeDisabled();
});

test("the symbol account select is disabled while symbol rows are loading", async () => {
  const pending: Array<(r: ToolResult) => void> = [];
  const { bridge, push } = fakeBridge(async (name, args) => {
    if (name === "get_symbol_history") return { structuredContent: history() };
    if (args.cursor) return new Promise<ToolResult>((resolve) => { pending.push(resolve); });
    return { structuredContent: page({ rows: [row({ id: "s1" })], nextCursor: "s2" }) };
  });
  render(<Activity bridge={bridge} />);
  push(page());
  fireEvent.click(await screen.findByRole("button", { name: /View VFV history/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
  await waitFor(() => expect(pending.length).toBe(1));
  expect(screen.getByLabelText("Account")).toBeDisabled();
  pending[0]({ structuredContent: page({ rows: [row({ id: "s9", description: "More VFV" })] }) });
  await screen.findByText("More VFV");
  expect(screen.getByLabelText("Account")).not.toBeDisabled();
});

test("a failed symbol Load more clears the busy state", async () => {
  const { bridge, push } = fakeBridge(async (name, args) => {
    if (name === "get_symbol_history") return { structuredContent: history() };
    if (args.cursor) return { isError: true };
    return { structuredContent: page({ rows: [row({ id: "s1" })], nextCursor: "s2" }) };
  });
  render(<Activity bridge={bridge} />);
  push(page());
  fireEvent.click(await screen.findByRole("button", { name: /View VFV history/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
  expect(await screen.findByText("Couldn't load that view. Showing the previous one.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next page" })).not.toBeDisabled();
  expect(screen.getByLabelText("Account")).not.toBeDisabled();
});

test("a failed search does not overwrite text typed after it", async () => {
  const resolvers: Array<(r: ToolResult) => void> = [];
  const { bridge, push } = fakeBridge(() => new Promise<ToolResult>((resolve) => { resolvers.push(resolve); }));
  render(<Activity bridge={bridge} />);
  push(page());
  const box = (await screen.findByLabelText("Search symbol")) as HTMLInputElement;
  fireEvent.input(box, { target: { value: "VFV" } });
  await waitFor(() => expect(resolvers.length).toBe(1));
  fireEvent.input(box, { target: { value: "VFVX" } });
  resolvers[0]({ isError: true });
  expect(await screen.findByText("Couldn't load that view. Showing the previous one.")).toBeInTheDocument();
  expect(box.value).toBe("VFVX");
});

test("a failed search restores the box when nothing newer was typed", async () => {
  const { bridge, push } = fakeBridge(async () => ({ isError: true }));
  render(<Activity bridge={bridge} />);
  push(page());
  const box = (await screen.findByLabelText("Search symbol")) as HTMLInputElement;
  fireEvent.input(box, { target: { value: "VFV" } });
  await screen.findByText("Couldn't load that view. Showing the previous one.");
  expect(box.value).toBe("");
});

test("privacy applies inside the symbol view and the toggle exposes aria-pressed", async () => {
  const { bridge, push } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(page());
  fireEvent.click(await screen.findByRole("button", { name: /View VFV history/ }));
  await screen.findByText("Units held");
  const toggle = screen.getByRole("button", { name: "Hide amounts" });
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(toggle);
  expect(screen.getByRole("button", { name: "Show amounts" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByText("$98.12")).toBeNull();
  expect(screen.queryByText("+$141.08")).toBeNull();
  expect(screen.getAllByRole("img", { name: "Hidden amount" }).length).toBeGreaterThanOrEqual(3);
});

test("a custom range survives other filter changes and has a heading", async () => {
  const { bridge, push, callTool } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(page({ filters: { ...page().filters, from: "2026-08-01" } }));
  const range = (await screen.findByLabelText("Range")) as HTMLSelectElement;
  expect(range.value).toBe("Custom");
  expect(screen.getByRole("heading", { name: "Activity" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "+ Moving money" }));
  await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
  expect(callTool).toHaveBeenLastCalledWith("get_activity_page", { categories: ["investing", "moving_money"], from: "2026-08-01" });
  await waitFor(() => expect(bridge.updateModelContext).toHaveBeenCalledWith("Viewing activity: All accounts, Investing + Moving money, custom range"));
  fireEvent.change(range, { target: { value: "30 days" } });
  await waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
  expect(lastCall(callTool, "get_activity_page").from).toBe("2026-09-16");
});

// ---- Final review fix wave ----

test("card rows: a money-out row is negative and not green; a CREDIT_CARD row is unsigned (I2)", async () => {
  const { bridge, push } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(page({ rows: [
    row({ id: "c1", category: "cash", type: "SPEND", symbol: null, description: "Card spending", units: null, price: null, priceCurrency: null, amount: -54.2 }),
    row({ id: "c2", category: "cash", type: "CREDIT_CARD", symbol: null, description: "Credit Card", units: null, price: null, priceCurrency: null, amount: 30, unsigned: true }),
  ] }));
  const spend = await screen.findByText(`${MINUS}$54.20`);
  expect(spend.closest(".w-act-amt")).not.toHaveClass("up");
  const card = screen.getByText("$30.00");
  expect(card.closest(".w-act-amt")).not.toHaveClass("up");
  expect(screen.queryByText("+$30.00")).toBeNull();
});

test("an FX trade's price is shown in the security currency (I3)", async () => {
  const { bridge, push } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(page({ rows: [row({ id: "fx", symbol: "AAPL", description: "Bought AAPL", currency: "CAD", priceCurrency: "USD", price: 230, amount: -3174 })] }));
  expect(await screen.findByText("US$230.00")).toBeInTheDocument();
  expect(screen.getByText(`${MINUS}$3,174.00`)).toBeInTheDocument();
});

test("the symbol view lists dividends paid in another currency (I3)", async () => {
  const h = history({ symbol: "AAPL", currency: "USD", position: { ...history().position, currency: "USD", dividends: 5, otherDividends: [{ currency: "CAD", amount: 6.9 }] } });
  const { bridge, push } = fakeBridge(async (name) => name === "get_symbol_history" ? { structuredContent: h } : { structuredContent: page({ rows: [row()] }) });
  render(<Activity bridge={bridge} />);
  push(page());
  fireEvent.click(await screen.findByRole("button", { name: /View VFV history/ }));
  expect(await screen.findByText("+US$5.00")).toBeInTheDocument();
  expect(screen.getByText("+$6.90")).toBeInTheDocument();
});

test("privacy hides units held and the brokerage note in the symbol view (I4, I9)", async () => {
  const h = history({ reportedUnits: 50 });
  const { bridge, push } = fakeBridge(async (name) => name === "get_symbol_history" ? { structuredContent: h } : { structuredContent: page({ rows: [row()] }) });
  render(<Activity bridge={bridge} />);
  push(page());
  fireEvent.click(await screen.findByRole("button", { name: /View VFV history/ }));
  expect(await screen.findByText("46")).toBeInTheDocument();
  expect(screen.getByText("Brokerage reports 50")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  expect(screen.queryByText("46")).toBeNull();
  expect(screen.queryByText(/Brokerage reports/)).toBeNull();
  expect(document.body.textContent).not.toMatch(/\b10 ×/);
});

test("no brokerage note when the replayed units match (I9)", async () => {
  const { bridge, push } = fakeBridge(async (name) => name === "get_symbol_history" ? { structuredContent: history({ reportedUnits: 46.0000000001 }) } : { structuredContent: page({ rows: [row()] }) });
  render(<Activity bridge={bridge} />);
  push(page());
  fireEvent.click(await screen.findByRole("button", { name: /View VFV history/ }));
  await screen.findByText("46");
  expect(screen.queryByText(/Brokerage reports/)).toBeNull();
});

test("a past range keeps its end date through chips and Load more (I5)", async () => {
  const { bridge, push, callTool } = fakeBridge(async () => ({ structuredContent: page({ filters: { categories: ["investing"], from: "2026-03-01", to: "2026-03-31" }, nextCursor: "c2" }) }));
  render(<Activity bridge={bridge} />);
  push(page({ filters: { categories: ["investing"], from: "2026-03-01", to: "2026-03-31" }, nextCursor: "c1" }));
  fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
  await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
  expect(lastCall(callTool, "get_activity_page")).toEqual({ cursor: "c1", categories: ["investing"], from: "2026-03-01", to: "2026-03-31" });
  fireEvent.click(screen.getByRole("button", { name: "+ Moving money" }));
  await waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
  expect(lastCall(callTool, "get_activity_page")).toEqual({ categories: ["investing", "moving_money"], from: "2026-03-01", to: "2026-03-31" });
  fireEvent.change(screen.getByLabelText("Range"), { target: { value: "30 days" } });
  await waitFor(() => expect(callTool).toHaveBeenCalledTimes(3));
  expect(lastCall(callTool, "get_activity_page")).toMatchObject({ from: "2026-03-01", to: "2026-03-31" });
});

test("a failed auto-open leaves a removable symbol chip in the feed (I6)", async () => {
  const { bridge, push, callTool } = fakeBridge(async (name, args) => {
    if (name === "get_symbol_history") return { isError: true };
    return { structuredContent: page({ rows: args.symbol ? [row({ id: "s1" })] : baseRows(), filters: { ...page().filters, ...(args.symbol ? { symbol: args.symbol } : {}) } }) };
  });
  render(<Activity bridge={bridge} />);
  push(page({ rows: [row({ id: "s1" })], filters: { ...page().filters, symbol: "VFV" } }));
  const chip = await screen.findByRole("button", { name: "Remove symbol filter VFV" });
  expect(chip).toHaveTextContent("Symbol: VFV ×");
  fireEvent.click(screen.getByRole("button", { name: "+ Moving money" }));
  await waitFor(() => expect(lastCall(callTool, "get_activity_page")).toMatchObject({ symbol: "VFV" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove symbol filter VFV" }));
  await waitFor(() => expect(lastCall(callTool, "get_activity_page").symbol).toBeUndefined());
  expect(await screen.findByText("Oct 10")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Remove symbol filter/ })).toBeNull();
});

test("a symbol row's accessible name keeps its description and amount (M13)", async () => {
  const { bridge, push } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(page());
  const button = await screen.findByRole("button", { name: /View VFV history/ });
  expect(button).toHaveAccessibleName(expect.stringContaining("Bought VFV"));
  expect(button).toHaveAccessibleName(expect.stringContaining(`${MINUS}$1,124.00`));
});

test("a row shows its symbol without the exchange suffix; the name and the request keep the full symbol", async () => {
  const { bridge, push, callTool } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(page({ rows: [row({ symbol: "VFV.TO", description: "Bought VFV.TO" })] }));
  const button = await screen.findByRole("button", { name: /View VFV\.TO history/ });
  expect(within(button).getByText("VFV")).toHaveAttribute("aria-hidden", "true");
  expect(button).toHaveAccessibleName(expect.stringContaining("Bought VFV.TO"));
  fireEvent.click(button);
  await waitFor(() => expect(callTool).toHaveBeenCalledWith("get_symbol_history", expect.objectContaining({ symbol: "VFV.TO" })));
});

test("withholding that matches no dividend is named in the feed and the symbol view (B12)", async () => {
  const h = history({ position: { ...history().position, unmatchedWithholding: [{ currency: "USD", count: 2, amount: 15 }] } });
  const { bridge, push } = fakeBridge(async (name) => name === "get_symbol_history" ? { structuredContent: h } : { structuredContent: page({ rows: [row()] }) });
  render(<Activity bridge={bridge} />);
  const p = page();
  p.totals = [{ ...p.totals[0]!, unmatchedWithholding: { count: 1, amount: 4 } }];
  push(p);
  expect(await screen.findByText(/1 withholding row not matched to a dividend/)).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: /View VFV history/ }));
  expect(await screen.findByText(/2 withholding rows not matched to a dividend/)).toBeInTheDocument();
});

test("9: the dividends tile is labelled net of withholding, in every currency line", async () => {
  const { bridge, push } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(page());
  expect(await screen.findByText("Dividends (net of withholding)")).toBeInTheDocument();
  expect(screen.getByText(/USD: bought.*, sold.* and dividends \(net of withholding\)/)).toBeInTheDocument();
});


describe("Activity resilience", () => {
  afterEach(() => { vi.useRealTimers(); });

  test("shows a retry 30 s after initialize with no payload, and retry hydrates", async () => {
    vi.useFakeTimers();
    const { bridge } = fakeBridge();
    (bridge.callTool as any).mockImplementation(async (name: string) => ({ structuredContent: name === "show_activity" ? page() : {} }));
    render(<Activity bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(29_500); });
    expect(screen.queryByText(/still loading/i)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.getByText(/still loading/i)).toBeInTheDocument();
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(bridge.callTool).toHaveBeenCalledWith("show_activity", {});
    expect(await screen.findByText("Bought VFV")).toBeInTheDocument();
    expect(screen.queryByText(/still loading/i)).toBeNull();
  });

  test("tolerates an unknown top-level key", async () => {
    const { bridge, push } = fakeBridge();
    render(<Activity bridge={bridge} />);
    push({ ...page(), futureField: { nested: [1, 2] } } as any);
    expect(await screen.findByText("Bought VFV")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't display this view.")).toBeNull();
  });

  test("tolerates missing optional sub-fields", async () => {
    const { bridge, push } = fakeBridge();
    render(<Activity bridge={bridge} />);
    const p: any = page();
    delete p.settings; delete p.filters.query; delete p.filters.accountId; p.totals.forEach((t: any) => { delete t.dividendsGross; delete t.withholding; delete t.feeTransactions; });
    push(p);
    expect(await screen.findByText("Bought VFV")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't display this view.")).toBeNull();
  });
});

test("the price chart tooltip shows the close and the trade on that date, hiding units and prices when amounts are hidden", async () => {
  await openSymbol(history());
  const move = () => fireEvent.pointerMove(document.querySelector("[data-chart-plot]")!, { clientX: 150, pointerType: "touch" });
  const tip = () => document.querySelector("[data-chart-tip]")!.textContent!;
  move();
  expect(tip()).toContain("Sep 2");
  expect(tip()).toContain("Close $11.00");
  expect(tip()).toContain("Bought 10 at $11.00");
  expect(tip()).toContain("Avg cost $98.12");
  expect(tip()).not.toContain("VFV");
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  move();
  expect(tip()).toContain("Bought •••• at ••••");
  expect(tip()).not.toMatch(/98\.12|Bought 10/);
});

test("Try again re-runs the call the model made, keeping its symbol filter", async () => {
  vi.useFakeTimers();
  const { bridge, callTool } = fakeBridge();
  bridge.toolArguments = () => ({ symbol: "HOOD" });
  render(<Activity bridge={bridge} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_100); });
  vi.useRealTimers();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(callTool).toHaveBeenCalledWith("show_activity", { symbol: "HOOD" }));
});

// ---- CAD view (one home currency) ----
const cadTotal = (amount: number, over: Record<string, unknown> = {}) => ({ amount, estimated: true, rateDates: ["2026-10-15"], excluded: [], ...over });
const usdHome = (amount: number, native: number) => ({ amount, estimated: true, rate: 1.371, rateDate: "2026-10-15", native: { amount: native, currency: "USD" } });
function cadPage(over: Partial<ActivityPage> = {}): ActivityPage {
  return page({
    rows: [row({ id: "a1", type: "SELL", symbol: "ASTS", description: "Sold ASTS", units: 100, price: 46.4, priceCurrency: "USD", amount: 4640, currency: "USD", home: usdHome(6362.37, 4640) })],
    totals: [{ currency: "USD", bought: 0, sold: 4640, dividends: 0, deposits: 0, withdrawals: 0 }],
    homeTotals: { bought: cadTotal(0, { estimated: false, rateDates: [] }), sold: cadTotal(6362.37), dividends: cadTotal(0, { estimated: false, rateDates: [] }) },
    settings: { benchmark: "sp500", cadView: true, privacyDefault: false },
    ...over,
  });
}
const gains = (over: any = {}) => ({ realized: { amount: 1200.5, estimated: true }, unrealized: { amount: -300, estimated: true }, unavailable: false, ...over });

test("cadView on: tiles show the CAD totals marked est. with the rate caption and no USD line", async () => {
  const { bridge, push } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(cadPage());
  const sold = (await screen.findByText("Sold")).closest(".w-tile")!;
  expect(sold.textContent).toContain("$6,362.37");
  expect(sold.textContent).toContain("est.");
  expect(sold.textContent).toContain("est. · BoC Oct 15");
  expect(screen.queryByText(/USD: /)).toBeNull();
  expect(screen.getByText("Bought").closest(".w-tile")!.textContent).toContain("$0.00");
});

test("cadView on: a tile with nothing converted shows the original amounts and the not-converted note, never $0.00", async () => {
  const { bridge, push } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(cadPage({
    rows: [row({ id: "a1", type: "SELL", symbol: "ASTS", description: "Sold ASTS", units: 100, price: 46.4, priceCurrency: "USD", amount: 4640, currency: "USD", home: { amount: null, estimated: false, rate: null, rateDate: null, native: { amount: 4640, currency: "USD" } } })],
    homeTotals: {
      bought: cadTotal(0, { estimated: false, rateDates: [] }),
      sold: cadTotal(0, { estimated: false, rateDates: [], excluded: [{ amount: 4640, currency: "USD" }], excludedCount: 1 }),
      dividends: cadTotal(0, { estimated: false, rateDates: [] }),
    },
  }));
  const sold = (await screen.findByText("Sold")).closest(".w-tile")!;
  expect(sold.textContent).toContain("US$4,640.00");
  expect(sold.textContent).toContain("Not converted (no recent Bank of Canada rate)");
  expect(sold.textContent).not.toContain("$0.00");
  expect(sold.textContent).not.toContain("1 not converted");
  expect(sold.querySelector(".w-caption")).toBeNull();
});

test("cadView on: a USD row shows CAD with the original amount under it; unsigned rows stay unsigned", async () => {
  const { bridge, push } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(cadPage({ rows: [
    row({ id: "a1", type: "SELL", symbol: "ASTS", description: "Sold ASTS", units: 100, price: 46.4, priceCurrency: "USD", amount: 4640, currency: "USD", home: usdHome(6362.37, 4640) }),
    row({ id: "c2", category: "cash", type: "CREDIT_CARD", symbol: null, description: "Credit Card", units: null, price: null, priceCurrency: null, amount: 30, unsigned: true, home: { amount: 30, estimated: false, rate: null, rateDate: null, native: { amount: 30, currency: "CAD" } } }),
  ] }));
  const sell = (await screen.findByText("Sold ASTS")).closest(".w-act-row")!;
  expect(sell.textContent).toContain("+$6,362.37");
  expect(sell.textContent).toContain("US$4,640.00");
  expect(screen.getByText("$30.00")).toBeInTheDocument();
  expect(screen.queryByText("+$30.00")).toBeNull();
});

test("the switch restores today's tiles and the other-currency line, and on again restores CAD", async () => {
  const { bridge, push, callTool } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(cadPage({ totals: [
    { currency: "CAD", bought: 8420, sold: 1150.5, dividends: 312.4, deposits: 0, withdrawals: 0 },
    { currency: "USD", bought: 77, sold: 4640, dividends: 3, deposits: 0, withdrawals: 0 },
  ] }));
  const sw = await screen.findByRole("button", { name: "Show original currencies" });
  expect(screen.queryByText(/USD: /)).toBeNull();
  fireEvent.click(sw);
  expect(callTool).toHaveBeenCalledWith("save_portfolio_settings", { cadView: false });
  expect(screen.getByText("$8,420.00")).toBeInTheDocument();
  expect(screen.getByText(/USD: /)).toBeInTheDocument();
  expect(screen.queryByText("est. · BoC Oct 15")).toBeNull();
  expect(screen.getByText("Sold ASTS").closest(".w-act-row")!.textContent).not.toContain("6,362.37");
  fireEvent.click(screen.getByRole("button", { name: "Show original currencies" }));
  expect(screen.queryByText(/USD: /)).toBeNull();
  expect(screen.getByText("Sold").closest(".w-tile")!.textContent).toContain("$6,362.37");
  expect(screen.getByText("Sold ASTS").closest(".w-act-row")!.textContent).toContain("+$6,362.37");
});

test("privacy hides CAD and original amounts alike", async () => {
  const { bridge, push } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(cadPage());
  fireEvent.click(await screen.findByRole("button", { name: "Hide amounts" }));
  expect(document.body.textContent).not.toMatch(/6,362|4,640/);
});

test("symbol view with cadView: Realized gain and Unrealized gain incl. currency tiles in CAD", async () => {
  const { bridge, push } = fakeBridge(async (name) => name === "get_symbol_history"
    ? { structuredContent: history({ symbol: "ASTS", homeGains: gains() }) }
    : { structuredContent: cadPage() });
  render(<Activity bridge={bridge} />);
  push(cadPage());
  fireEvent.click(await screen.findByRole("button", { name: /View ASTS history/ }));
  const realized = (await screen.findByText("Realized gain")).closest(".w-tile")!;
  expect(realized.textContent).toContain("+$1,200.50");
  expect(realized.textContent).toContain("est.");
  const unrealized = screen.getByText("Unrealized gain incl. currency").closest(".w-tile")!;
  expect(unrealized.textContent).toContain(`${MINUS}$300.00`);
  expect(unrealized.textContent).toContain("est.");
  expect(screen.queryByText("Unrealized")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show original currencies" }));
  expect(screen.queryByText("Realized gain")).toBeNull();
  expect(screen.queryByText("Unrealized gain incl. currency")).toBeNull();
});

test("a symbol that was never sold hides the Realized tile", async () => {
  const noSells = history({ homeGains: gains({ realized: { amount: 0, estimated: true } }) });
  noSells.position.markers = [{ date: "2026-09-02", side: "buy", units: 10, price: 11 }];
  const { bridge, push } = fakeBridge(async (name) => name === "get_symbol_history"
    ? { structuredContent: noSells }
    : { structuredContent: cadPage({ rows: [row({ id: "b1", description: "Bought VFV", home: undefined })] }) });
  render(<Activity bridge={bridge} />);
  push(cadPage());
  fireEvent.click(await screen.findByRole("button", { name: /View ASTS history/ }));
  expect(await screen.findByText("Unrealized gain incl. currency")).toBeInTheDocument();
  expect(screen.queryByText("Realized gain")).toBeNull();
});

test("unavailable gains show the history-incomplete copy in place of both tiles", async () => {
  const { bridge, push } = fakeBridge(async (name) => name === "get_symbol_history"
    ? { structuredContent: history({ homeGains: { realized: null, unrealized: null, unavailable: true } }) }
    : { structuredContent: cadPage() });
  render(<Activity bridge={bridge} />);
  push(cadPage());
  fireEvent.click(await screen.findByRole("button", { name: /View ASTS history/ }));
  expect(await screen.findByText("Realized gain unavailable: history incomplete")).toBeInTheDocument();
  expect(screen.queryByText("Unrealized gain incl. currency")).toBeNull();
});

test("turning the switch on over a payload without CAD data reloads the feed", async () => {
  const { bridge, push, callTool } = fakeBridge(async () => ({ structuredContent: cadPage() }));
  render(<Activity bridge={bridge} />);
  push(page());
  const sw = await screen.findByRole("button", { name: "Show original currencies" });
  await waitFor(() => expect(sw).toHaveAttribute("aria-pressed", "true")); // the payload's cadView: false has been adopted
  fireEvent.click(sw);
  await waitFor(() => expect(screen.queryByText(/USD: /)).toBeNull());
  expect(callTool).toHaveBeenCalledWith("save_portfolio_settings", { cadView: true });
});

function gainsBridge(save: () => Promise<ToolResult>) {
  const order: string[] = [];
  const noGains = history({ symbol: "ASTS", homeGains: null });
  const withGains = history({ symbol: "ASTS", homeGains: gains() });
  const f = fakeBridge(async (name) => {
    if (name === "save_portfolio_settings") { const r = await save(); order.push("save-done"); return r; }
    if (name === "get_symbol_history") { order.push("history"); return { structuredContent: order.includes("save-done") ? withGains : noGains }; }
    return { structuredContent: page({ rows: [row({ id: "s1", symbol: "ASTS" })] }) };
  });
  return { ...f, order };
}

test("switching CAD on in a symbol view reloads it only after the save lands, then shows the gain tiles", async () => {
  const { bridge, push, order } = gainsBridge(() => new Promise((r) => setTimeout(() => r({}), 60)));
  render(<Activity bridge={bridge} />);
  push(page());
  fireEvent.click(await screen.findByRole("button", { name: /View VFV history/ }));
  await screen.findByText("Units held");
  const sw = screen.getByRole("button", { name: "Show original currencies" });
  await waitFor(() => expect(sw).toHaveAttribute("aria-pressed", "true"));
  const before = order.length;
  fireEvent.click(sw);
  expect(order.slice(before)).toEqual([]);
  expect(await screen.findByText("Unrealized gain incl. currency")).toBeInTheDocument();
  expect(order.slice(before)).toEqual(["save-done", "history"]);
});

test("a failed save does not reload the symbol view", async () => {
  const { bridge, push, order } = gainsBridge(async () => ({ isError: true }));
  render(<Activity bridge={bridge} />);
  push(page());
  fireEvent.click(await screen.findByRole("button", { name: /View VFV history/ }));
  await screen.findByText("Units held");
  const sw = screen.getByRole("button", { name: "Show original currencies" });
  await waitFor(() => expect(sw).toHaveAttribute("aria-pressed", "true"));
  const before = order.length;
  fireEvent.click(sw);
  await waitFor(() => expect(order).toContain("save-done"));
  await new Promise((r) => setTimeout(r, 50));
  expect(order.slice(before)).toEqual(["save-done"]);
});

function controlledSaves() {
  const resolvers: Array<(r: ToolResult) => void> = [];
  const save = () => new Promise<ToolResult>((r) => { resolvers.push(r); });
  return { save, resolvers };
}
async function openSymbolView(push: (p: ActivityPage) => void) {
  push(page());
  fireEvent.click(await screen.findByRole("button", { name: /View VFV history/ }));
  await screen.findByText("Units held");
  const sw = screen.getByRole("button", { name: "Show original currencies" });
  await waitFor(() => expect(sw).toHaveAttribute("aria-pressed", "true"));
  return sw;
}
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

test("closing the symbol view during a pending save does not reopen it", async () => {
  const { save, resolvers } = controlledSaves();
  const { bridge, push, order } = gainsBridge(save);
  render(<Activity bridge={bridge} />);
  const sw = await openSymbolView(push);
  const before = order.length;
  fireEvent.click(sw);
  fireEvent.click(screen.getByRole("button", { name: "← All activity" }));
  await act(async () => { resolvers[0]({}); });
  await settle();
  expect(order.slice(before)).toEqual(["save-done"]);
  expect(screen.queryByText("Units held")).toBeNull();
  expect(screen.getByLabelText("Search symbol")).toBeInTheDocument();
});

test("changing the period during a pending save keeps the user's selection with no stale reload", async () => {
  const { save, resolvers } = controlledSaves();
  const { bridge, push, order, callTool } = gainsBridge(save);
  render(<Activity bridge={bridge} />);
  const sw = await openSymbolView(push);
  fireEvent.click(sw);
  fireEvent.click(screen.getByRole("radio", { name: "1Y" }));
  await waitFor(() => expect(lastCall(callTool, "get_symbol_history").period).toBe("1Y"));
  const historyCalls = callTool.mock.calls.filter((c: any[]) => c[0] === "get_symbol_history").length;
  await act(async () => { resolvers[0]({}); });
  await settle();
  expect(callTool.mock.calls.filter((c: any[]) => c[0] === "get_symbol_history").length).toBe(historyCalls);
  expect(screen.getByRole("radio", { name: "1Y" })).toBeChecked();
  expect(order).toContain("save-done");
});

test("ON, OFF, ON quickly with delayed saves reloads at most once", async () => {
  const { save, resolvers } = controlledSaves();
  const { bridge, push, callTool } = gainsBridge(save);
  render(<Activity bridge={bridge} />);
  const sw = await openSymbolView(push);
  const before = callTool.mock.calls.filter((c: any[]) => c[0] === "get_symbol_history").length;
  fireEvent.click(sw); // on
  fireEvent.click(screen.getByRole("button", { name: "Show original currencies" })); // off
  fireEvent.click(screen.getByRole("button", { name: "Show original currencies" })); // on
  expect(resolvers.length).toBe(3);
  await act(async () => { resolvers.forEach((r) => r({})); });
  await settle();
  await waitFor(() => expect(screen.getByText("Unrealized gain incl. currency")).toBeInTheDocument());
  expect(callTool.mock.calls.filter((c: any[]) => c[0] === "get_symbol_history").length - before).toBe(1);
});

test("the feed shows 10 rows per page with Prev/Next (owner request 2026-10-23)", async () => {
  const many = Array.from({ length: 25 }, (_, i) => row({ id: `r${i}`, description: `Synthetic row ${i + 1}` }));
  const { bridge, push } = fakeBridge();
  render(<Activity bridge={bridge} />);
  push(page({ rows: many, nextCursor: null }));
  expect(await screen.findByText("1–10 of 25")).toBeInTheDocument();
  expect(screen.queryByText("Synthetic row 11")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getByText("11–20 of 25")).toBeInTheDocument();
  expect(screen.queryByText("Synthetic row 1")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
  expect(screen.getByText("1–10 of 25")).toBeInTheDocument();
});

describe("Activity shared filter (accountType)", () => {
  const picker = () => screen.getByLabelText("Account") as HTMLSelectElement;
  async function openWith(p: ActivityPage) {
    const f = fakeBridge();
    render(<Activity bridge={f.bridge} />);
    f.push(p);
    await screen.findByText("Today, Oct 16");
    return f;
  }
  const typed = (accountType: string, over: Partial<ActivityPage["filters"]> = {}) =>
    page({ filters: { categories: ["investing"], from: "2026-07-18", to: "2026-10-16", accountType, ...over } as ActivityPage["filters"] });

  test("F1: an accountType echo shows a removable TFSA accounts chip and the picker reads it", async () => {
    await openWith(typed("tfsa", { accountId: "acct-secret-1" }));
    expect(screen.getByRole("button", { name: "Remove filter TFSA accounts" })).toHaveTextContent("TFSA accounts");
    expect(picker().selectedOptions[0].textContent).toBe("TFSA accounts");
    expect([...picker().options].map((o) => o.textContent)).toEqual(["All accounts", "TFSA accounts", "TFSA", "RRSP"]);
  });

  test("F2: category, range and load-more calls send accountType and not the echoed accountId", async () => {
    const { callTool } = await openWith(typed("tfsa", { accountId: "acct-secret-1" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Moving money" }));
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    expect(lastCall(callTool, "get_activity_page")).toEqual({ categories: ["investing", "moving_money"], from: "2026-07-18", accountType: "tfsa" });
    fireEvent.change(screen.getByLabelText("Range"), { target: { value: "30 days" } });
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
    expect(lastCall(callTool, "get_activity_page")).toEqual({ categories: ["investing", "moving_money"], from: "2026-09-16", accountType: "tfsa" });
    expect(screen.getByRole("button", { name: "Remove filter TFSA accounts" })).toBeInTheDocument();
  });

  test("F2b: Load more keeps accountType with the cursor", async () => {
    const many = Array.from({ length: 10 }, (_, i) => row({ id: `m${i}` }));
    const { callTool } = await openWith(page({ rows: many, nextCursor: "c1", filters: { categories: ["investing"], from: "2026-07-18", to: "2026-10-16", accountType: "crypto" } as ActivityPage["filters"] }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    expect(lastCall(callTool, "get_activity_page")).toEqual({ cursor: "c1", categories: ["investing"], from: "2026-07-18", accountType: "crypto" });
  });

  test("F3: clearing the chip refetches with neither filter", async () => {
    const { callTool } = await openWith(typed("non_registered"));
    fireEvent.click(screen.getByRole("button", { name: "Remove filter non-registered accounts" }));
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    expect(lastCall(callTool, "get_activity_page")).toEqual({ categories: ["investing"], from: "2026-07-18" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove filter non-registered accounts" })).toBeNull());
    expect(picker().selectedOptions[0].textContent).toBe("All accounts");
  });

  test("F4: picking an account replaces the chip", async () => {
    const { callTool } = await openWith(typed("tfsa"));
    fireEvent.change(picker(), { target: { value: "acct-secret-2" } });
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    expect(lastCall(callTool, "get_activity_page")).toEqual({ categories: ["investing"], from: "2026-07-18", accountId: "acct-secret-2" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove filter TFSA accounts" })).toBeNull());
    expect(picker().value).toBe("acct-secret-2");
  });

  test("F4b: a symbol drill-down opens on the one matched account (get_symbol_history takes no accountType); back keeps the chip", async () => {
    const { callTool } = await openWith(typed("tfsa", { accountId: "acct-secret-1" }));
    fireEvent.click(screen.getByRole("button", { name: /View VFV history/ }));
    await waitFor(() => expect(lastCall(callTool, "get_symbol_history")).toEqual({ symbol: "VFV", period: "ALL", accountId: "acct-secret-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "← All activity" }));
    expect(screen.getByRole("button", { name: "Remove filter TFSA accounts" })).toBeInTheDocument();
    cleanup();
    const several = await openWith(typed("rrsp"));
    fireEvent.click(screen.getByRole("button", { name: /View VFV history/ }));
    await waitFor(() => expect(lastCall(several.callTool, "get_symbol_history")).toEqual({ symbol: "VFV", period: "ALL" }));
  });

  test("F5: the model context names the type", async () => {
    const { bridge } = await openWith(typed("cash_account"));
    await waitFor(() => expect(bridge.updateModelContext).toHaveBeenLastCalledWith("Viewing activity: Cash accounts, Investing, 90 days"));
  });

  test("F6: an old payload shows no filter chip and sends neither new field", async () => {
    const { callTool } = await openWith(page());
    expect(screen.queryByRole("button", { name: /^Remove filter/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "+ Moving money" }));
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    expect(lastCall(callTool, "get_activity_page")).toEqual({ categories: ["investing", "moving_money"], from: "2026-07-18" });
  });
});
