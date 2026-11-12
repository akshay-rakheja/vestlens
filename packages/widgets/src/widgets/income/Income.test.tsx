import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { Income } from "./Income";
import type { IncomePayload } from "./types";

function payload(over: Partial<IncomePayload> = {}): IncomePayload {
  return {
    year: 2026, years: [2025, 2026],
    currencyTotals: [
      { currency: "CAD", net: 500, gross: 500, withholding: 0, interest: 12.5, forward12m: 640, unmatchedWithholding: { count: 0, amount: 0 }, forwardCoverage: { payers: 3, covered: 2 }, yieldOnCost: 0.041, currentYield: 0.035 },
      { currency: "USD", net: 85, gross: 100, withholding: 15, interest: 0, forward12m: 120, unmatchedWithholding: { count: 0, amount: 0 }, forwardCoverage: { payers: 1, covered: 1 }, yieldOnCost: null, currentYield: 0.02 },
    ],
    months: [
      { month: "2026-01", currency: "CAD", byAccount: { "acct-secret-1": 200, "acct-secret-2": 100 }, payers: [{ symbol: "XEQT", net: 250 }, { symbol: "Other", net: 50 }], net: 300, gross: 300, withholding: 0, interest: 5 },
      { month: "2026-03", currency: "CAD", byAccount: { "acct-secret-1": 200 }, payers: [{ symbol: "XEQT", net: 200 }], net: 200, gross: 200, withholding: 0, interest: 7.5 },
      { month: "2026-03", currency: "USD", byAccount: { "acct-secret-1": 85 }, payers: [{ symbol: "AAPL", net: 85 }], net: 85, gross: 100, withholding: 15, interest: 0 },
    ],
    topPayers: [
      { symbol: "XEQT", currency: "CAD", net: 400, yieldOnCost: 0.04 },
      { symbol: "AAPL", currency: "USD", net: 85, yieldOnCost: null },
    ],
    yields: [],
    withholding: [
      { accountType: "TFSA", currency: "USD", gross: 100, withholding: 15, rate: 0.15 },
      { accountType: "RRSP", currency: "CAD", gross: 500, withholding: 0, rate: 0 },
      { accountType: "Margin", currency: "CAD", gross: 0, withholding: 0, rate: null },
    ],
    contributions: [{ accountType: "TFSA", currency: "CAD", amount: 7000 }],
    accounts: [{ id: "acct-secret-1", label: "TFSA 2" }, { id: "acct-secret-2", label: "RRSP" }],
    syncing: [], filters: {}, settings: { benchmark: "sp500", cadView: false, privacyDefault: false }, asOf: "2026-10-16T15:00:00Z", ...over,
  };
}
type Impl = (name: string, args: any) => Promise<ToolResult> | ToolResult;
function fakeBridge(impl?: Impl) {
  let listener: (r: ToolResult) => void = () => {};
  const callTool = vi.fn(async (name: string, args: any) => (impl ? impl(name, args) : { structuredContent: payload() }));
  const bridge: Bridge = {
    ready: Promise.resolve({ hostTools: true, context: {} }),
    onToolResult: (fn) => { listener = fn; return () => {}; },
    onContext: () => () => {},
    toolArguments: () => ({}), openLink: async () => true,
    callTool, sendMessage: vi.fn(async () => {}), updateModelContext: vi.fn(async () => {}), destroy: () => {},
  };
  return { bridge, callTool, push: (p: IncomePayload) => listener({ structuredContent: p }) };
}
async function open(p = payload(), impl?: Impl) {
  const f = fakeBridge(impl);
  render(<Income bridge={f.bridge} />);
  expect(screen.getByText(/loading your income/i)).toBeInTheDocument();
  act(() => f.push(p));
  await screen.findByText("Estimates for information only, not tax or investment advice.");
  return f;
}
const group = (currency: string) => screen.getByRole("group", { name: `${currency} income` });
const tile = (currency: string, label: string) => within(group(currency)).getByText(label).parentElement!;
afterEach(() => { cleanup(); vi.useRealTimers(); });

const CAPTION = "Net dividends, withholding and interest are brokerage reported · forward and yields are est., after withholding";
const showCurrency = (currency: string) => fireEvent.click(screen.getByRole("radio", { name: currency }));
const pickMonth = (key: string) => fireEvent.click(document.querySelector(`g[data-bar='${key}']`)!);

test("1: per-currency tiles with one caption and est. labels; coverage shown only when partial", async () => {
  await open();
  expect(tile("CAD", "Net dividends")).toHaveTextContent("$500.00");
  expect(tile("CAD", "Interest")).toHaveTextContent("$12.50");
  expect(tile("CAD", "Forward 12 months (est.)")).toHaveTextContent("$640.00");
  expect(tile("CAD", "Forward 12 months (est.)")).toHaveTextContent("est. from 2 of 3 holdings");
  expect(tile("CAD", "Yield on cost (est.)")).toHaveTextContent("4.1%");
  // Brokerage reported is said once for the group, not under every tile.
  expect(within(group("CAD")).getByText(CAPTION)).toBeInTheDocument();
  expect(group("CAD")).not.toHaveTextContent("Brokerage reported");
  showCurrency("USD");
  expect(tile("USD", "Withholding")).toHaveTextContent("$15.00");
  expect(tile("USD", "Forward 12 months (est.)")).not.toHaveTextContent(/payers/);
  expect(tile("USD", "Yield on cost (est.)")).toHaveTextContent("—");
});

test("1b: currency tabs show one currency at a time and appear only with more than one currency", async () => {
  await open();
  expect(screen.getByRole("radiogroup", { name: "Currency" })).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "CAD" })).toHaveAttribute("aria-checked", "true");
  expect(screen.queryByRole("group", { name: "USD income" })).toBeNull();
  showCurrency("USD");
  expect(screen.getByRole("group", { name: "USD income" })).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "CAD income" })).toBeNull();
  cleanup();
  await open(payload({ currencyTotals: [payload().currencyTotals[0]] }));
  expect(screen.queryByRole("radiogroup", { name: "Currency" })).toBeNull();
  expect(group("CAD")).toBeInTheDocument();
});

test("1c: months are chosen on the chart: no month chip buttons; a bar click or Enter on the chart opens the month, a second click closes it", async () => {
  await open();
  expect(within(group("CAD")).queryByRole("button", { name: /^(Jan|Mar)$/ })).toBeNull();
  pickMonth("2026-03");
  expect(screen.getByRole("region", { name: "CAD income in March 2026" })).toBeInTheDocument();
  expect(document.querySelector("g[data-bar='2026-03']")!.getAttribute("data-selected")).toBe("true");
  expect(document.querySelector("g[data-bar='2026-01']")!.getAttribute("opacity")).toBe("0.4");
  pickMonth("2026-03");
  expect(screen.queryByRole("region", { name: /CAD income in/ })).toBeNull();
  const chart = within(group("CAD")).getByRole("img", { name: /CAD income by month/ });
  fireEvent.keyDown(chart, { key: "Home" });
  fireEvent.keyDown(chart, { key: "Enter" });
  expect(screen.getByRole("region", { name: "CAD income in January 2026" })).toBeInTheDocument();
  // A month with no income opens nothing.
  pickMonth("2026-02");
  expect(screen.queryByRole("region", { name: /CAD income in/ })).toBeNull();
});

test("1d: accounts keep their colour in the chart and the month split; notes sit in one footer", async () => {
  await open(payload({ syncing: ["acct-secret-1"] }));
  const bar = (s: string) => document.querySelector(`g[data-bar='2026-01'] [data-series='${s}']`)!.getAttribute("fill");
  expect(bar("acct-secret-1")).toBe("var(--c1)");
  expect(bar("acct-secret-2")).toBe("var(--c2)");
  pickMonth("2026-01");
  const split = within(screen.getByRole("region", { name: "CAD income in January 2026" })).getByRole("list", { name: "By account" });
  const swatch = (label: string) => (within(split).getByText(label).parentElement!.querySelector(".w-swatch") as HTMLElement).style.backgroundColor;
  expect(swatch("TFSA 2")).toBe("var(--c1)");
  expect(swatch("RRSP")).toBe("var(--c2)");
  const footer = document.querySelector("footer.w-notes")!;
  expect(footer).toHaveTextContent("Estimates for information only, not tax or investment advice.");
  expect(footer).toHaveTextContent(/still syncing/i);
});

test("2: switching the year or account calls get_income and shows the result", async () => {
  const next = payload({ year: 2025, months: [], currencyTotals: [] });
  const { callTool } = await open(payload(), async () => ({ structuredContent: next }));
  fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2025" } });
  expect(callTool).toHaveBeenCalledWith("get_income", { year: 2025 });
  await screen.findByText("No dividends recorded in 2025");
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-2" } });
  expect(callTool).toHaveBeenLastCalledWith("get_income", { year: 2025, accountId: "acct-secret-2" });
});

test("3: a month click lists that month's income and where it came from", async () => {
  await open();
  pickMonth("2026-01");
  const detail = screen.getByRole("region", { name: "CAD income in January 2026" });
  expect(detail).toHaveTextContent("TFSA 2");
  expect(detail).toHaveTextContent("$200.00");
  expect(detail).toHaveTextContent("RRSP");
  expect(detail).not.toHaveTextContent("secret");
});

test("3b: a month click lists the month's payers above the account split; a payer click sends the history request; Other is not clickable", async () => {
  const { bridge } = await open();
  pickMonth("2026-01");
  const detail = screen.getByRole("region", { name: "CAD income in January 2026" });
  const payers = within(detail).getByRole("list", { name: "Payers" });
  expect(within(payers).getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("XEQT"), expect.stringContaining("Other")]);
  expect(within(payers).getByText("$250.00")).toBeInTheDocument();
  expect(within(payers).queryByRole("button", { name: "Other" })).toBeNull();
  fireEvent.click(within(payers).getByRole("button", { name: "XEQT" }));
  expect(bridge.sendMessage).toHaveBeenCalledWith("Show my history with XEQT");
  expect(detail.textContent!.indexOf("Payers")).toBeLessThan(detail.textContent!.indexOf("TFSA 2"));
});

test("a partial forward estimate says a holding in each account counts once, and names what's left out and why", async () => {
  const p = payload();
  p.currencyTotals[0]!.forwardCoverage = { payers: 3, covered: 1 };
  p.currencyTotals[0]!.forwardUncovered = [{ symbol: "XEQT", account: "RRSP", reason: "units_changed" }, { symbol: "AAA", account: "FHSA", reason: "partial_year" }];
  await open(p);
  expect(tile("CAD", "Forward 12 months (est.)")).toHaveTextContent("est. from 1 of 3 holdings");
  expect(screen.getByText("A holding in each account counts once. Left out: XEQT in RRSP (units changed around a payment), AAA in FHSA (held under a year).")).toBeInTheDocument();
});

test("3c: top payers states how many are shown when truncated", async () => {
  await open();
  expect(screen.queryByText(/Top 10 of/)).toBeNull();
  cleanup();
  await open(payload({ topPayers: Array.from({ length: 14 }, (_, i) => ({ symbol: `S${i}`, currency: "CAD", net: 100 - i, yieldOnCost: null })) }));
  expect(screen.getByText("Top 10 of 14 payers")).toBeInTheDocument();
});

test("4: withholding sentences are factual; USD rows say USD; rows with nothing withheld are skipped", async () => {
  await open();
  const list = screen.getByRole("list", { name: "Withholding by account type" });
  expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    expect.stringContaining("TFSA: 15% withheld on USD dividends"),
  ]);
  expect(screen.getByRole("table", { name: "Deposits this year" })).toHaveTextContent("$7,000.00");
});

test("4b: unmatched withholding rows are reported for the shown currency in the notes, and the amount is hidden in privacy mode", async () => {
  const base = payload();
  await open(payload({ currencyTotals: [{ ...base.currencyTotals[0]!, unmatchedWithholding: { count: 2, amount: 12 } }, base.currencyTotals[1]!] }));
  const notes = () => document.querySelector("footer.w-notes")!;
  expect(notes()).toHaveTextContent("2 withholding rows not matched to a dividend ($12.00) are not included");
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  expect(notes()).toHaveTextContent("2 withholding rows not matched to a dividend (");
  expect(notes()).not.toHaveTextContent("$12.00");
  showCurrency("USD");
  expect(notes()).not.toHaveTextContent("not matched");
});

test("5: an empty year says so and nothing throws", async () => {
  await open(payload({ months: [], currencyTotals: [], topPayers: [], withholding: [], contributions: [] }));
  expect(screen.getByText("No dividends recorded in 2026")).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: /income$/ })).toBeNull();
});

test("6: a syncing account shows the note", async () => {
  await open(payload({ syncing: ["acct-secret-1"] }));
  expect(screen.getByText(/still syncing/i)).toBeInTheDocument();
  cleanup();
  await open();
  expect(screen.queryByText(/still syncing/i)).toBeNull();
});

test("7: the not-advice note is always present, even when empty", async () => {
  await open(payload({ months: [], currencyTotals: [] }));
  expect(screen.getByText("Estimates for information only, not tax or investment advice.")).toBeInTheDocument();
});

test("8: privacy hides money but keeps percentages", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  expect(screen.queryByText("$500.00")).toBeNull();
  expect(screen.queryByText("$7,000.00")).toBeNull();
  expect(screen.getAllByRole("img", { name: "Hidden amount" }).length).toBeGreaterThanOrEqual(5);
  expect(tile("CAD", "Yield on cost (est.)")).toHaveTextContent("4.1%");
  expect(screen.getByRole("list", { name: "Withholding by account type" })).toHaveTextContent("15%");
  pickMonth("2026-01");
  const detail = screen.getByRole("region", { name: "CAD income in January 2026" });
  expect(detail).not.toHaveTextContent(/\$\d/);
  expect(within(detail).getAllByRole("img", { name: "Hidden amount" }).length).toBeGreaterThanOrEqual(5);
  expect(within(detail).getByRole("button", { name: "XEQT" })).toBeInTheDocument();
});

test("9: a payer click sends the history request", async () => {
  const { bridge } = await open();
  fireEvent.click(within(screen.getByRole("table", { name: "Top payers" })).getByRole("button", { name: "XEQT" }));
  expect(bridge.sendMessage).toHaveBeenCalledWith("Show my history with XEQT");
  (bridge.sendMessage as any).mockRejectedValueOnce(new Error("no"));
  fireEvent.click(within(screen.getByRole("table", { name: "Top payers" })).getByRole("button", { name: "AAPL" }));
  expect(await screen.findByText("Couldn't send that to the chat.")).toBeInTheDocument();
});

test("10: the model context has no digits except the year, no ids and no account labels", async () => {
  const { bridge } = await open(payload(), async (_n, args) => ({ structuredContent: payload({ filters: args.accountId ? { accountId: args.accountId } : {} }) }));
  await waitFor(() => expect(bridge.updateModelContext).toHaveBeenCalledWith("Viewing income for 2026: all accounts"));
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-1" } });
  await waitFor(() => expect(bridge.updateModelContext).toHaveBeenLastCalledWith("Viewing income for 2026: one account"));
  for (const [text] of (bridge.updateModelContext as any).mock.calls) {
    expect(String(text).replace("2026", "")).not.toMatch(/\d|secret|TFSA|RRSP/);
  }
});

test("11: accounts beyond five are grouped as Other accounts in the chart legend", async () => {
  const ids = Array.from({ length: 7 }, (_, i) => `a${i}`);
  await open(payload({
    accounts: ids.map((id, i) => ({ id, label: `Acct ${i}` })),
    months: [{ month: "2026-02", currency: "CAD", byAccount: Object.fromEntries(ids.map((id, i) => [id, 100 - i])), payers: [], net: 700, gross: 700, withholding: 0, interest: 0 }],
    currencyTotals: [payload().currencyTotals[0]],
  }));
  const legend = within(group("CAD"));
  expect(legend.getByText("Other accounts")).toBeInTheDocument();
  expect(legend.queryByText("Acct 6")).toBeNull();
  expect(legend.getByText("Acct 4")).toBeInTheDocument();
});

test("12: a failed reload keeps the view with a notice; a stale response does not overwrite a newer one", async () => {
  let n = 0;
  await open(payload(), async () => { n += 1; if (n === 1) throw new Error("boom"); return { structuredContent: payload({ year: 2025, months: [], currencyTotals: [] }) }; });
  fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2025" } });
  expect(await screen.findByText("Couldn't load that view. Showing the previous one.")).toBeInTheDocument();
  expect(screen.getByLabelText("Year")).toHaveValue("2026");
  cleanup();
  const resolvers: Array<(r: ToolResult) => void> = [];
  await open(payload(), () => new Promise<ToolResult>((res) => { resolvers.push(res); }));
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-1" } });
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-2" } });
  await act(async () => { resolvers[1]({ structuredContent: payload({ months: [], currencyTotals: [], year: 2024, years: [2024, 2026] }) }); });
  await act(async () => { resolvers[0]({ structuredContent: payload() }); });
  expect(screen.getByText("No dividends recorded in 2024")).toBeInTheDocument();
});

test("13: the watchdog offers a retry that hydrates", async () => {
  vi.useFakeTimers();
  const { bridge } = fakeBridge();
  (bridge.callTool as any).mockImplementation(async (name: string) => ({ structuredContent: name === "show_income" ? payload() : {} }));
  render(<Income bridge={bridge} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_600); });
  expect(screen.getByText(/still loading/i)).toBeInTheDocument();
  vi.useRealTimers();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(bridge.callTool).toHaveBeenCalledWith("show_income", {});
  expect(await screen.findByText("Estimates for information only, not tax or investment advice.")).toBeInTheDocument();
});

// ---- CAD view ----
const total = (amount: number, over: Record<string, unknown> = {}) => ({ amount, estimated: true, rateDates: ["2026-02-13", "2026-05-14"], excluded: [], excludedCount: 0, ...over });
const cadTile = (label: string) => within(group("CAD")).getByText(label) as HTMLElement; // the tile itself
function cadPayload(over: Partial<IncomePayload> = {}): IncomePayload {
  return payload({
    settings: { benchmark: "sp500", cadView: true, privacyDefault: false },
    home: {
      tiles: { net: total(284), gross: total(305), withholding: total(21), interest: total(10, { estimated: false, rateDates: [] }), forward12m: total(900, { rateDates: ["2026-10-16"] }) },
      months: [
        { month: "2026-02", currency: "CAD", byAccount: { "acct-secret-1": 219 }, payers: [{ symbol: "UUU", net: 119 }, { symbol: "XEQT", net: 100 }], net: 219, gross: 240, withholding: 21, interest: 0 },
        { month: "2026-05", currency: "CAD", byAccount: { "acct-secret-2": 65 }, payers: [{ symbol: "UUU", net: 65 }], net: 65, gross: 65, withholding: 0, interest: 10 },
      ],
      topPayers: [{ symbol: "UUU", net: 184, estimated: true, yieldOnCost: null }, { symbol: "XEQT", net: 100, estimated: false, yieldOnCost: 0.04 }],
      forwardCoverage: { payers: 4, covered: 3 },
      yields: null,
    },
    ...over,
  });
}

test("CAD view: one tile set and one chart in CAD, marked est., no currency tabs", async () => {
  await open(cadPayload());
  expect(screen.queryByRole("radiogroup", { name: "Currency" })).toBeNull();
  expect(screen.queryByRole("group", { name: "USD income" })).toBeNull();
  expect(cadTile("Net dividends")).toHaveTextContent("$284.00");
  expect(cadTile("Net dividends")).toHaveTextContent("est. · rates by trade date");
  expect(cadTile("Interest")).toHaveTextContent("$10.00");
  expect(cadTile("Interest")).not.toHaveTextContent("est.");
  expect(cadTile("Forward 12 months (est.)")).toHaveTextContent("$900.00");
  expect(cadTile("Forward 12 months (est.)")).toHaveTextContent("est. from 3 of 4 holdings");
  expect(within(group("CAD")).getByRole("img", { name: /CAD income by month/ })).toBeInTheDocument();
  // Yields are native percents: not shown for mixed currencies.
  expect(within(group("CAD")).queryByText("Yield on cost (est.)")).toBeNull();
  expect(screen.getByText(/Yields are per currency/)).toBeInTheDocument();
  pickMonth("2026-02");
  const month = screen.getByRole("region", { name: "CAD income in February 2026" });
  expect(month).toHaveTextContent("$219.00");
});

test("CAD view: top payers in CAD; withholding and deposits stay per currency", async () => {
  await open(cadPayload());
  const payers = screen.getByRole("region", { name: "Top payers" });
  expect(payers).toHaveTextContent("UUU");
  expect(payers).toHaveTextContent("$184.00");
  expect(payers).not.toHaveTextContent("Currency");
  const wh = screen.getByRole("list", { name: "Withholding by account type" });
  expect(wh).toHaveTextContent("TFSA: 15% withheld on USD dividends");
  expect(wh).toHaveTextContent("US$15.00");
});

test("CAD view: a total with nothing converted shows the native amounts and the not-converted note, not CAD $0.00", async () => {
  const none = total(0, { estimated: false, rateDates: [], excluded: [{ amount: 85, currency: "USD" }], excludedCount: 1 });
  const p = cadPayload();
  p.home!.tiles.net = none;
  await open(p);
  expect(cadTile("Net dividends")).toHaveTextContent("US$85.00");
  expect(cadTile("Net dividends")).toHaveTextContent("Not converted (no recent Bank of Canada rate)");
  expect(cadTile("Net dividends")).not.toHaveTextContent("$0.00");
});

test("CAD view: a mixed total keeps CAD and counts what was not converted", async () => {
  const p = cadPayload();
  p.home!.tiles.net = total(284, { excluded: [{ amount: 20, currency: "USD" }], excludedCount: 2 });
  await open(p);
  expect(cadTile("Net dividends")).toHaveTextContent("$284.00");
  expect(cadTile("Net dividends")).toHaveTextContent("2 not converted");
});

test("CAD view: privacy hides CAD and native amounts alike", async () => {
  await open(cadPayload());
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  expect(screen.queryByText("$284.00")).toBeNull();
  expect(screen.queryByText("US$15.00")).toBeNull();
  expect(screen.queryByText("$184.00")).toBeNull();
});

test("the switch brings back the per-currency tabs and tiles, and saves the setting", async () => {
  const f = await open(cadPayload(), (name) => ({ structuredContent: name === "save_portfolio_settings" ? {} : cadPayload() }));
  fireEvent.click(screen.getByRole("button", { name: "Show original currencies" }));
  expect(f.callTool).toHaveBeenCalledWith("save_portfolio_settings", { cadView: false });
  expect(screen.getByRole("radiogroup", { name: "Currency" })).toBeInTheDocument();
  expect(tile("CAD", "Net dividends")).toHaveTextContent("$500.00");
});

test("turning CAD on over a payload without CAD data reloads the view", async () => {
  const f = await open(payload(), (name) => ({ structuredContent: name === "save_portfolio_settings" ? {} : cadPayload() }));
  const sw = screen.getByRole("button", { name: "Show original currencies" });
  await waitFor(() => expect(sw).toHaveAttribute("aria-pressed", "true"));
  fireEvent.click(sw);
  await waitFor(() => expect(f.callTool).toHaveBeenCalledWith("get_income", { year: 2026 }));
  await waitFor(() => expect(cadTile("Net dividends")).toHaveTextContent("$284.00"));
});

test("fix 1: CAD view never calls converted figures brokerage reported; cadView off keeps the old caption", async () => {
  await open(cadPayload());
  expect(within(group("CAD")).getByText("CAD figures: CAD amounts as reported; USD converted at the Bank of Canada rate on each payment date (est.).")).toBeInTheDocument();
  expect(group("CAD")).not.toHaveTextContent("brokerage reported");
  expect(group("CAD")).toHaveTextContent("Forward and yields are est., after withholding.");
  cleanup();
  await open(payload());
  expect(within(group("CAD")).getByText(CAPTION)).toBeInTheDocument();
});

describe("Income shared filters (accountType, symbol)", () => {
  const picker = () => screen.getByLabelText("Account") as HTMLSelectElement;
  const echo = (args: any) => ({ structuredContent: payload({ year: args.year, filters: { ...(args.accountId ? { accountId: args.accountId } : {}), ...(args.accountType ? { accountType: args.accountType } : {}), ...(args.symbol ? { symbol: args.symbol } : {}) } }) });

  test("F1: an accountType echo shows a removable TFSA accounts chip and the picker reads it", async () => {
    await open(payload({ filters: { accountType: "tfsa", accountId: "acct-secret-1" } }));
    expect(screen.getByRole("button", { name: "Remove filter TFSA accounts" })).toHaveTextContent("TFSA accounts");
    expect(picker().selectedOptions[0].textContent).toBe("TFSA accounts");
  });

  test("F2: a year change sends accountType and not the echoed accountId; the chip stays", async () => {
    const { callTool } = await open(payload({ filters: { accountType: "tfsa", accountId: "acct-secret-1" } }), (_n, args) => echo(args));
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2025" } });
    expect(callTool).toHaveBeenLastCalledWith("get_income", { year: 2025, accountType: "tfsa" });
    await waitFor(() => expect((screen.getByLabelText("Year") as HTMLSelectElement).value).toBe("2025"));
    expect(screen.getByRole("button", { name: "Remove filter TFSA accounts" })).toBeInTheDocument();
    expect(picker().selectedOptions[0].textContent).toBe("TFSA accounts");
  });

  test("F3: clearing the chip refetches with neither filter", async () => {
    const { callTool } = await open(payload({ filters: { accountType: "tfsa" } }), (_n, args) => echo(args));
    fireEvent.click(screen.getByRole("button", { name: "Remove filter TFSA accounts" }));
    expect(callTool).toHaveBeenLastCalledWith("get_income", { year: 2026 });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove filter TFSA accounts" })).toBeNull());
    expect(picker().selectedOptions[0].textContent).toBe("All accounts");
  });

  test("F4: picking an account replaces the chip", async () => {
    const { callTool } = await open(payload({ filters: { accountType: "tfsa" } }), (_n, args) => echo(args));
    fireEvent.change(picker(), { target: { value: "acct-secret-2" } });
    expect(callTool).toHaveBeenLastCalledWith("get_income", { year: 2026, accountId: "acct-secret-2" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove filter TFSA accounts" })).toBeNull());
    expect(picker().value).toBe("acct-secret-2");
  });

  test("F5: a symbol chip is kept on follow-ups and cleared on its own", async () => {
    const { callTool } = await open(payload({ filters: { accountType: "rrsp", symbol: "XEQT" } }), (_n, args) => echo(args));
    expect(screen.getByRole("button", { name: "Remove filter XEQT" })).toHaveTextContent("XEQT");
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2025" } });
    expect(callTool).toHaveBeenLastCalledWith("get_income", { year: 2025, accountType: "rrsp", symbol: "XEQT" });
    await waitFor(() => expect((screen.getByLabelText("Year") as HTMLSelectElement).value).toBe("2025"));
    fireEvent.click(screen.getByRole("button", { name: "Remove filter XEQT" }));
    expect(callTool).toHaveBeenLastCalledWith("get_income", { year: 2025, accountType: "rrsp" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove filter XEQT" })).toBeNull());
    expect(screen.getByRole("button", { name: "Remove filter RRSP accounts" })).toBeInTheDocument();
  });

  test("F6: an old payload shows no filter chip and sends neither new field", async () => {
    const { callTool } = await open();
    expect(screen.queryByRole("button", { name: /^Remove filter/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2025" } });
    expect(callTool).toHaveBeenLastCalledWith("get_income", { year: 2025 });
  });
});

test("yields left out are said, per currency and in CAD (A4)", async () => {
  const p = payload();
  p.currencyTotals[0]!.yieldsLeftOut = 2;
  p.currencyTotals[0]!.yieldsConverted = 1;
  await open(p);
  expect(await screen.findByText(/Yields leave out 2 holdings/)).toBeInTheDocument();
  expect(screen.getByText(/Yields use dividends paid in another currency, converted at the Bank of Canada rate on each pay date \(est\.\)/)).toBeInTheDocument();
});

test("forward and yields are stated as after withholding, in native and CAD views (B5)", async () => {
  await open(payload());
  expect(screen.getByText(/forward and yields are est\., after withholding/i)).toBeInTheDocument();
});

describe("sorting the top payers", () => {
  const payers = () => within(screen.getByRole("table", { name: "Top payers" }));
  const order = () => [...screen.getByRole("table", { name: "Top payers" }).querySelectorAll("tbody tr[data-row]")].map((r) => r.getAttribute("data-row")!.split("|")[0]);
  const header = (label: string) => payers().getByRole("button", { name: new RegExp(`^${label}`) });
  const ariaSort = (label: string) => payers().getByRole("columnheader", { name: new RegExp(`^${label}`) }).getAttribute("aria-sort");
  const NOTE = "Net is sorted within each currency, not across them.";
  const mixed = () => payload({
    topPayers: [
      { symbol: "AAA", currency: "CAD", net: 100, yieldOnCost: 0.04 },
      { symbol: "BBB", currency: "USD", net: 500, yieldOnCost: null },
      { symbol: "CCC", currency: "CAD", net: 100, yieldOnCost: 0.02 },
      { symbol: "DDD", currency: "USD", net: 50, yieldOnCost: 0.06 },
      { symbol: "EEE", currency: "CAD", net: 300, yieldOnCost: 0.03 },
    ],
  });

  test("the default order is the one the tool sent, with no column marked as sorted", async () => {
    await open(mixed());
    expect(order()).toEqual(["AAA", "BBB", "CCC", "DDD", "EEE"]);
    for (const label of ["Payer", "Currency", "Net", "Yield on cost"]) expect(ariaSort(label)).toBe("none");
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  test("Net sorts highest first then lowest first inside each currency, never CAD against USD; ties go by symbol", async () => {
    await open(mixed());
    fireEvent.click(header("Net"));
    expect(order()).toEqual(["EEE", "AAA", "CCC", "BBB", "DDD"]);
    expect(ariaSort("Net")).toBe("descending");
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    fireEvent.click(header("Net"));
    expect(order()).toEqual(["AAA", "CCC", "EEE", "DDD", "BBB"]);
    expect(ariaSort("Net")).toBe("ascending");
    // The native amounts stay as they were shown.
    expect(payers().getByText("US$500.00")).toBeInTheDocument();
    expect(payers().getByText("$300.00")).toBeInTheDocument();
  });

  test("Yield on cost compares across currencies (a percent), unknown last both ways, ties by symbol", async () => {
    await open(mixed());
    fireEvent.click(header("Yield on cost"));
    expect(order()).toEqual(["DDD", "AAA", "EEE", "CCC", "BBB"]);
    expect(screen.queryByText(NOTE)).toBeNull();
    fireEvent.click(header("Yield on cost"));
    expect(order()).toEqual(["CCC", "EEE", "AAA", "DDD", "BBB"]);
  });

  test("Payer and Currency sort too; equal currencies keep the symbol order in both directions", async () => {
    await open(mixed());
    fireEvent.click(header("Payer"));
    expect(order()).toEqual(["AAA", "BBB", "CCC", "DDD", "EEE"]);
    fireEvent.click(header("Payer"));
    expect(order()).toEqual(["EEE", "DDD", "CCC", "BBB", "AAA"]);
    fireEvent.click(header("Currency"));
    expect(order()).toEqual(["AAA", "CCC", "EEE", "BBB", "DDD"]);
    fireEvent.click(header("Currency"));
    expect(order()).toEqual(["BBB", "DDD", "AAA", "CCC", "EEE"]);
  });

  test("the CAD table: every net is already CAD, so Net sorts as one list; unknown yields stay last; ties by symbol", async () => {
    const p = cadPayload();
    p.home!.topPayers = [
      { symbol: "ZZZ", net: 100, estimated: true, yieldOnCost: null },
      { symbol: "UUU", net: 184, estimated: true, yieldOnCost: null },
      { symbol: "XEQT", net: 100, estimated: false, yieldOnCost: 0.04 },
    ];
    await open(p);
    expect(order()).toEqual(["ZZZ", "UUU", "XEQT"]);
    fireEvent.click(header("Net"));
    expect(order()).toEqual(["UUU", "XEQT", "ZZZ"]);
    fireEvent.click(header("Net"));
    expect(order()).toEqual(["XEQT", "ZZZ", "UUU"]);
    expect(screen.queryByText(NOTE)).toBeNull();
    fireEvent.click(header("Yield on cost"));
    expect(order()).toEqual(["XEQT", "UUU", "ZZZ"]);
    fireEvent.click(header("Yield on cost"));
    expect(order()).toEqual(["XEQT", "UUU", "ZZZ"]);
  });
});
