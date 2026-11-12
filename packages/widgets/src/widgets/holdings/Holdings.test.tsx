import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { Holdings } from "./Holdings";
import type { HoldingRow, HoldingsPayload } from "./types";
import type { HomeAmountView, HomeTotalView } from "../../kit/home-money";
import { formatDateTime } from "../../kit/format";

const row = (over: Partial<HoldingRow> = {}): HoldingRow => ({
  key: "VFV|CAD", symbol: "VFV", currency: "CAD", kind: "equity", units: 46.5, price: 150, marketValue: 6975, bookCost: 5000,
  totalReturn: 1975, totalReturnFraction: 0.395, weight: 0.7, weightCad: 0.5, dayChange: { amount: 35, fraction: 0.005, estimated: true },
  accounts: [
    { accountId: "acct-secret-1", label: "TFSA", units: 30, marketValue: 4500, bookCost: 3000, totalReturn: 1500 },
    { accountId: "acct-secret-2", label: "RRSP", units: 16.5, marketValue: 2475, bookCost: 2000, totalReturn: 475 },
  ], ...over,
});
const rows = (): HoldingRow[] => [
  row(),
  row({ key: "XEQT|CAD", symbol: "XEQT", units: 100, price: 30, marketValue: 3000, bookCost: 2800, totalReturn: 200, totalReturnFraction: 0.07, weight: 0.3, weightCad: 0.21, dayChange: null,
    accounts: [{ accountId: "acct-secret-1", label: "TFSA", units: 100, marketValue: 3000, bookCost: 2800, totalReturn: 200 }] }),
  row({ key: "AAPL|USD", symbol: "AAPL", currency: "USD", units: 10, price: 230, marketValue: 2300, bookCost: 2000, totalReturn: 300, totalReturnFraction: 0.15, weight: 1, weightCad: 0.29, dayChange: null, accounts: [] }),
];
function payload(over: Partial<HoldingsPayload> = {}): HoldingsPayload {
  return {
    rows: rows(),
    totals: [
      { currency: "CAD", marketValue: 9975, bookCost: 7800, totalReturn: 2175, totalReturnFraction: 0.279, withCostBasis: 2, holdings: 2, cash: 120.5 },
      { currency: "USD", marketValue: 2300, bookCost: 2000, totalReturn: 300, totalReturnFraction: 0.15, withCostBasis: 1, holdings: 1, cash: 0 },
    ],
    accounts: [{ id: "acct-secret-1", label: "TFSA" }, { id: "acct-secret-2", label: "RRSP" }],
    currencies: ["CAD", "USD"], omitted: 0, filters: { currency: "CAD", sort: "weight" },
    fx: { rate: 1.4, date: "2026-10-16" }, accountValue: [{ currency: "CAD", amount: 13500.25, source: "reported" }], settings: { benchmark: "sp500", cadView: false, privacyDefault: false }, asOf: "2026-10-16T15:00:00Z", ...over,
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
  return { bridge, callTool, push: (p: HoldingsPayload) => listener({ structuredContent: p }) };
}
const symbols = () => [...document.querySelectorAll("tbody tr[data-row]")].map((r) => r.getAttribute("data-row"));
const table = () => screen.getByRole("table", { name: "Holdings" });
async function open(p = payload(), impl?: Impl) {
  const f = fakeBridge(impl);
  render(<Holdings bridge={f.bridge} />);
  expect(screen.getByText(/loading your holdings/i)).toBeInTheDocument();
  act(() => f.push(p));
  await screen.findByRole("table", { name: "Holdings" });
  return f;
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

test("1: renders per-currency tiles with the caption, the cash line and the table rows", async () => {
  await open();
  expect(screen.getByText("Read-only")).toBeInTheDocument();
  expect(screen.getAllByText("$9,975.00").length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText("$7,800.00")).toBeInTheDocument();
  expect(screen.getAllByText("Values as your brokerage reports them")).toHaveLength(1);
  expect(screen.queryByText("Brokerage reported")).toBeNull();
  expect(screen.getAllByText("$120.50").some((e) => e.parentElement?.textContent?.includes("Cash $120.50"))).toBe(true);
  expect(symbols()).toEqual(["VFV|CAD", "XEQT|CAD"]);
  const t = within(table());
  expect(t.getByText("70.00%")).toBeInTheDocument();
  expect(t.getByText("+$1,975.00")).toBeInTheDocument();
  expect(t.getByText(/\+39\.50%/)).toBeInTheDocument();
  expect(t.getByText("+$35.00")).toBeInTheDocument();
  expect(t.getByText(/Today \(est\.\)/)).toBeInTheDocument();
});

test("the gain is labelled against book cost, not as a total return, and the caption says dividends aren't in it", async () => {
  await open();
  expect(screen.queryByText("Total return")).toBeNull();
  expect(screen.getAllByText("Gain vs book cost").length).toBeGreaterThanOrEqual(1);
  expect(screen.getByRole("columnheader", { name: /Gain vs cost/ })).toBeInTheDocument();
  expect(screen.getAllByText("Dividends aren't included here. Reinvested dividends add to book cost.")).toHaveLength(1);
});

test("2: clicking a header re-sorts and asks get_holdings for that sort", async () => {
  const { callTool } = await open();
  fireEvent.click(within(table()).getByRole("button", { name: /^Value/ }));
  expect(callTool).toHaveBeenCalledWith("get_holdings", expect.objectContaining({ sort: "value", currency: "CAD" }));
  // A number column starts highest first.
  expect(symbols()).toEqual(["VFV|CAD", "XEQT|CAD"]);
});



test("4: expand shows the accounts, and a trimmed row has no chevron", async () => {
  await open(payload({ filters: { sort: "weight" } }));
  expect(screen.getAllByRole("button", { name: /Show details/ })).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: /Show details/ })[0]);
  expect(within(table()).getByText("TFSA")).toBeInTheDocument();
  expect(within(table()).getByText("RRSP")).toBeInTheDocument();
  expect(table()).toHaveTextContent(/cost \$3,000\.00/);
  expect(table()).toHaveTextContent(/cost \$2,000\.00/);
  expect(table()).toHaveTextContent(/gain \+?\$1,500\.00/);
});

test("5: a null book cost shows a dash and the from N of M note", async () => {
  const p = payload();
  p.totals[0] = { ...p.totals[0], bookCost: null, totalReturn: null, totalReturnFraction: null, withCostBasis: 1, holdings: 2 };
  await open(p);
  expect(screen.getByText(/from 1 of 2 holdings/)).toBeInTheDocument();
  expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
});

test("5b: omitted rows are announced", async () => {
  await open(payload({ omitted: 7 }));
  expect(screen.getByText("Showing the largest 3 of 10 holdings — filter by account or currency to see the rest")).toBeInTheDocument();
});

test("6: privacy hides money and units but keeps percentages", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  expect(screen.queryByText("$9,975.00")).toBeNull();
  expect(screen.queryByText("46.5")).toBeNull();
  expect(screen.queryByText("+$1,975.00")).toBeNull();
  expect(screen.getAllByRole("img", { name: "Hidden amount" }).length).toBeGreaterThan(4);
  expect(within(table()).getByText("70.00%")).toBeInTheDocument();
  expect(within(table()).getByText(/\+39\.50%/)).toBeInTheDocument();
});

test("7: a row click sends exactly the history request; failure shows a notice", async () => {
  const { bridge } = await open();
  fireEvent.click(within(table()).getByText("VFV"));
  expect(bridge.sendMessage).toHaveBeenCalledWith("Show my history with VFV");
  (bridge.sendMessage as any).mockRejectedValueOnce(new Error("no"));
  fireEvent.click(within(table()).getByText("XEQT"));
  expect(await screen.findByText("Couldn't send that to the chat.")).toBeInTheDocument();
});

test("7b: a symbol shows without its exchange suffix; the full symbol stays in the title, for screen readers and in the request", async () => {
  const { bridge } = await open(payload({ rows: [row({ key: "XEQT.TO|CAD", symbol: "XEQT.TO" })] }));
  const sym = within(table()).getByText("XEQT");
  expect(sym).toHaveAttribute("aria-hidden", "true");
  expect(sym.parentElement).toHaveAttribute("title", "XEQT.TO");
  expect(within(table()).getByText("XEQT.TO")).toHaveClass("w-sr");
  fireEvent.click(sym);
  expect(bridge.sendMessage).toHaveBeenCalledWith("Show my history with XEQT.TO");
});

test("8: model context names the view without digits or ids", async () => {
  const { bridge } = await open();
  await waitFor(() => expect(bridge.updateModelContext).toHaveBeenCalledWith("Viewing holdings: all accounts, CAD, sorted by weight"));
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-1" } });
  await waitFor(() => expect(bridge.updateModelContext).toHaveBeenLastCalledWith("Viewing holdings: one account, CAD, sorted by weight"));
  for (const [text] of (bridge.updateModelContext as any).mock.calls) { expect(text).not.toMatch(/\d/); expect(text).not.toMatch(/secret/); }
});

test("9: a failed reload keeps the view and shows a notice; the newest request wins", async () => {
  let n = 0;
  const { callTool } = await open(payload(), async () => { n += 1; if (n === 1) throw new Error("boom"); return { structuredContent: payload({ filters: { currency: "CAD", accountId: "acct-secret-2", sort: "weight" }, rows: [row({ key: "ONLY|CAD", symbol: "ONLY" })] }) }; });
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-1" } });
  expect(await screen.findByText("Couldn't load that view. Showing the previous one.")).toBeInTheDocument();
  expect(symbols()).toEqual(["VFV|CAD", "XEQT|CAD"]);
  expect((screen.getByLabelText("Account") as HTMLSelectElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-2" } });
  await waitFor(() => expect(symbols()).toEqual(["ONLY|CAD"]));
  expect(callTool).toHaveBeenCalledTimes(2);
});

test("9b: a stale response does not overwrite a newer one", async () => {
  const resolvers: Array<(r: ToolResult) => void> = [];
  await open(payload(), () => new Promise<ToolResult>((res) => { resolvers.push(res); }));
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-1" } });
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-2" } });
  await act(async () => { resolvers[1]({ structuredContent: payload({ rows: [row({ key: "NEW|CAD", symbol: "NEW" })] }) }); });
  await act(async () => { resolvers[0]({ structuredContent: payload({ rows: [row({ key: "OLD|CAD", symbol: "OLD" })] }) }); });
  expect(symbols()).toEqual(["NEW|CAD"]);
});

describe("Holdings resilience", () => {
  test("10: shows a retry 30 s after initialize with no payload, and retry hydrates", async () => {
    vi.useFakeTimers();
    const { bridge } = fakeBridge();
    (bridge.callTool as any).mockImplementation(async (name: string) => ({ structuredContent: name === "show_holdings" ? payload() : {} }));
    render(<Holdings bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(29_500); });
    expect(screen.queryByText(/still loading/i)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.getByText(/still loading/i)).toBeInTheDocument();
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(bridge.callTool).toHaveBeenCalledWith("show_holdings", {});
    expect(await screen.findByRole("table", { name: "Holdings" })).toBeInTheDocument();
  });
});

test("11: an account label with an ordinal never reaches the model context", async () => {
  const { bridge } = await open(payload({ accounts: [{ id: "acct-secret-1", label: "TFSA 2" }, { id: "acct-secret-2", label: "RRSP" }] }));
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-1" } });
  await waitFor(() => expect(bridge.updateModelContext).toHaveBeenLastCalledWith("Viewing holdings: one account, CAD, sorted by weight"));
  for (const [text] of (bridge.updateModelContext as any).mock.calls) expect(text).not.toMatch(/\d|TFSA/);
});



test("13: a failed sort reload reverts the sort indicator with the view", async () => {
  await open(payload(), async () => { throw new Error("boom"); });
  fireEvent.click(within(table()).getByRole("button", { name: /^Value/ }));
  await screen.findByText("Couldn't load that view. Showing the previous one.");
  expect(within(table()).getByRole("columnheader", { name: /Value/ }).getAttribute("aria-sort")).toBe("none");
  expect(within(table()).getByRole("columnheader", { name: /Weight/ }).getAttribute("aria-sort")).toBe("descending");
});

test("14: the account value tile shows the reported total with its caption and the made-up-of row", async () => {
  await open(payload({ filters: { sort: "weight" } }));
  const card = screen.getByRole("region", { name: "Total value" });
  expect(within(card).getByText("$13,500.25")).toBeInTheDocument();
  expect(within(card).getByText("Values as your brokerage reports them")).toBeInTheDocument();
  expect(screen.getByLabelText("Made up of")).toHaveTextContent("Made up of CAD holdings $9,975.00, USD holdings US$2,300.00 and CAD cash $120.50");
});

test("14b: a single account is labelled Account value", async () => {
  await open(payload({ filters: { accountId: "acct-secret-1", sort: "weight" } }));
  expect(screen.getByRole("region", { name: "Account value" })).toBeInTheDocument();
});

test("14c: an estimated value says est. with the BoC date; without a rate just est.", async () => {
  const est: HoldingsPayload["accountValue"] = [{ currency: "CAD", amount: 14000, source: "estimated" }];
  await open(payload({ accountValue: est }));
  const card = screen.getByRole("region", { name: "Total value" });
  expect(within(card).getByText("est. · BoC 2026-10-16")).toBeInTheDocument();
  expect(within(card).queryByText("Values as your brokerage reports them")).toBeNull();
  cleanup();
  await open(payload({ fx: { rate: null, date: null }, accountValue: [{ currency: "CAD", amount: 100, source: "estimated" }, { currency: "USD", amount: 50, source: "estimated" }] }));
  const c2 = screen.getByRole("region", { name: "Total value" });
  expect(within(c2).getAllByText("est.")).toHaveLength(2);
  expect(within(c2).getByText("US$50.00")).toBeInTheDocument();
});

test("14d: privacy hides the account value and the made-up-of amounts", async () => {
  await open(payload({ filters: { sort: "weight" } }));
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  expect(screen.queryByText("$13,500.25")).toBeNull();
  expect(screen.getByLabelText("Made up of")).not.toHaveTextContent(/\$/);
});

test("14e: Made up of survives a currency filter after an unfiltered load", async () => {
  const usd = payload({ filters: { currency: "USD", sort: "weight" }, rows: [rows()[2]] });
  usd.totals = [usd.totals[1]];
  await open(payload({ filters: { sort: "weight" } }), async () => ({ structuredContent: usd }));
  fireEvent.click(screen.getByRole("radio", { name: "USD" }));
  await waitFor(() => expect(symbols()).toEqual(["AAPL|USD"]));
  expect(screen.getByLabelText("Made up of")).toHaveTextContent("CAD holdings $9,975.00");
});



test("15c: the model context stays digit-free with the account value card", async () => {
  const { bridge } = await open(payload({ filters: { sort: "weight" } }));
  await waitFor(() => expect(bridge.updateModelContext).toHaveBeenCalled());
  for (const [text] of (bridge.updateModelContext as any).mock.calls) expect(text).not.toMatch(/\d|\$/);
});

const tot = (amount: number, over: Partial<HomeTotalView> = {}): HomeTotalView => ({ amount, estimated: false, rateDates: [], excluded: [], ...over });
const usd = (amount: number, rate = 1.4): HomeAmountView => ({ amount: Math.round(amount * rate * 100) / 100, estimated: true, rate, rateDate: "2026-10-16", native: { amount, currency: "USD" } });
/** The CAD view: every currency's rows, USD rows carrying their CAD figures, and the shared home totals. */
function cadPayload(over: Partial<HoldingsPayload> = {}): HoldingsPayload {
  const p = payload({ filters: { sort: "weight" }, settings: { benchmark: "sp500", cadView: true, privacyDefault: false }, ...over });
  p.rows = p.rows.map((r) => (r.currency === "USD" ? { ...r, cad: { value: usd(2300), totalReturn: usd(300), dayChange: null } } : r));
  p.home ??= {
    total: tot(15300, { estimated: true, rateDates: ["2026-10-16"] }), includesUnreported: false, rowsDiffer: false,
    tiles: { value: tot(13195, { estimated: true, rateDates: ["2026-10-16"] }), bookCost: tot(10600, { estimated: true, rateDates: ["2026-10-16"] }), totalReturn: tot(2595, { estimated: true, rateDates: ["2026-10-16"] }), totalReturnFraction: 0.2448, complete: true },
  };
  return p;
}

describe("Holdings in CAD", () => {
  test("16: cadView on shows CAD rows with the native amount on a second line, and no All segment", async () => {
    await open(cadPayload());
    expect(symbols()).toHaveLength(3);
    expect(screen.queryByRole("radio", { name: "All · CAD est." })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Currency" })).toBeNull();
    const aapl = document.querySelector('tr[data-row="AAPL|USD"]') as HTMLElement;
    expect(within(aapl).getByText("$3,220.00")).toBeInTheDocument();
    expect(aapl.querySelector(".w-home-native")).toHaveTextContent("US$2,300.00");
    expect(within(aapl).getAllByText("est.").length).toBeGreaterThanOrEqual(1);
    expect(within(table()).getByText("50.00%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show original currencies/ })).toBeInTheDocument();
  });

  test("17: the account value is the one CAD total with its caption; tiles say unrealized gain at today's rate", async () => {
    await open(cadPayload());
    const card = screen.getByRole("region", { name: "Total value" });
    expect(within(card).getByText("$15,300.00")).toBeInTheDocument();
    expect(card).toHaveTextContent("est. · BoC Oct 16");
    const tiles = within(screen.getByRole("region", { name: "CAD-equivalent totals" }));
    expect(tiles.getByText("$13,195.00")).toBeInTheDocument();
    expect(tiles.getByText("Unrealized gain (at today's rate)")).toBeInTheDocument();
    expect(tiles.getByText("Excludes currency movement since purchase.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "CAD totals" })).toBeNull();
  });

  test("17b: a converted day change carries the caption that the CAD figure includes the currency move; none without one (B2)", async () => {
    const caption = "The CAD day change includes the day's currency move; the percent is the price move.";
    await open(cadPayload());
    expect(screen.queryByText(caption)).toBeNull();
    cleanup();
    const p = cadPayload();
    p.rows = p.rows.map((r) => (r.currency === "USD" ? { ...r, dayChange: { amount: 50, fraction: 0.022, estimated: true }, cad: { ...r.cad!, dayChange: usd(50) } } : r));
    await open(p);
    expect(screen.getByText(caption)).toBeInTheDocument();
  });

  test("18: the rows-differ note shows only when set", async () => {
    await open(cadPayload());
    expect(screen.queryByText("Rows converted at the BoC rate; the brokerage total uses its own rate.")).toBeNull();
    cleanup();
    const p = cadPayload(); p.home = { ...p.home!, rowsDiffer: true };
    await open(p);
    expect(screen.getByText("Rows converted at the BoC rate; the brokerage total uses its own rate.")).toBeInTheDocument();
  });

  test("19: nothing converted renders native amounts with the not-converted note, never CAD $0.00", async () => {
    const p = cadPayload();
    p.rows = p.rows.map((r) => ({ ...r, cad: undefined }));
    p.home = {
      total: tot(0, { excluded: [{ amount: 2300, currency: "USD" }] }), includesUnreported: false, rowsDiffer: false,
      tiles: { value: tot(0, { excluded: [{ amount: 2300, currency: "USD" }] }), bookCost: null, totalReturn: null, totalReturnFraction: null, complete: true },
    };
    await open(p);
    const card = screen.getByRole("region", { name: "Total value" });
    expect(card).toHaveTextContent("US$2,300.00");
    expect(card).toHaveTextContent("Not converted (no recent Bank of Canada rate)");
    expect(card).not.toHaveTextContent("CA$0.00");
    expect(card).not.toHaveTextContent("$0.00");
  });

  test("20: a mixed total keeps CAD and counts what was not converted", async () => {
    const p = cadPayload();
    p.home = { ...p.home!, total: tot(9000, { excluded: [{ amount: 50, currency: "EUR" }] }) };
    await open(p);
    const card = screen.getByRole("region", { name: "Total value" });
    expect(within(card).getByText("$9,000.00")).toBeInTheDocument();
    expect(card).toHaveTextContent("1 not converted");
  });

  test("21: the Value sort uses the API's CAD figures and the weight header stays short (est. is in the caption)", async () => {
    const p = cadPayload();
    p.rows.push(row({ key: "BOND|CAD", symbol: "BOND", marketValue: null, weight: null, weightCad: null, totalReturn: null, totalReturnFraction: null, dayChange: null, accounts: [] }));
    await open(p);
    expect(within(table()).getByRole("button", { name: /^Weight/ })).toBeInTheDocument();
    expect(screen.getByText("1 holding without a value is not weighted")).toBeInTheDocument();
    fireEvent.click(within(table()).getByRole("button", { name: /^Value/ }));
    expect(symbols()).toEqual(["VFV|CAD", "AAPL|USD", "XEQT|CAD", "BOND|CAD"]);
  });

  test("22: the switch saves cadView and falls back to per-currency tiles without the All segment", async () => {
    const { callTool } = await open(cadPayload(), async (name) => (name === "save_portfolio_settings" ? { structuredContent: {} } : { structuredContent: payload() }));
    fireEvent.click(screen.getByRole("button", { name: /Show original currencies/ }));
    expect(callTool).toHaveBeenCalledWith("save_portfolio_settings", { cadView: false });
    expect(await screen.findByRole("region", { name: "CAD totals" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "USD" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "All · CAD est." })).toBeNull();
    expect(symbols()).toEqual(["VFV|CAD", "XEQT|CAD"]);
  });

  test("23: switching the CAD view on after a single-currency load reloads every currency", async () => {
    const { callTool } = await open(cadPayload({ settings: { benchmark: "sp500", cadView: false, privacyDefault: false }, filters: { currency: "CAD", sort: "weight" } }), async (name) => (name === "save_portfolio_settings" ? { structuredContent: {} } : { structuredContent: cadPayload() }));
    fireEvent.click(screen.getByRole("button", { name: /Show original currencies/ }));
    // pressed state means "original currencies"; clicking while off turns the CAD view on
    await waitFor(() => expect(callTool).toHaveBeenCalledWith("get_holdings", expect.not.objectContaining({ currency: expect.anything() })));
    await waitFor(() => expect(symbols()).toHaveLength(3));
  });

  test("23b: a model-requested currency in the CAD view filters the rows with a chip and does not reload unfiltered", async () => {
    const f = fakeBridge(async (name) => (name === "save_portfolio_settings" ? { structuredContent: {} } : { structuredContent: cadPayload() }));
    f.bridge.toolArguments = () => ({ currency: "USD" });
    render(<Holdings bridge={f.bridge} />);
    act(() => f.push(cadPayload({ filters: { currency: "USD", sort: "weight" } })));
    await screen.findByRole("table", { name: "Holdings" });
    await act(async () => { await Promise.resolve(); });
    expect(symbols()).toEqual(["AAPL|USD"]);
    const aapl = document.querySelector('tr[data-row="AAPL|USD"]') as HTMLElement;
    expect(within(aapl).getByText("$3,220.00")).toBeInTheDocument();
    expect(f.callTool).not.toHaveBeenCalledWith("get_holdings", expect.anything());
    const chip = screen.getByRole("button", { name: "Remove currency filter USD" });
    expect(chip).toHaveTextContent("Currency: USD ×");
    fireEvent.click(chip);
    await waitFor(() => expect(f.callTool).toHaveBeenCalledWith("get_holdings", expect.not.objectContaining({ currency: expect.anything() })));
    await waitFor(() => expect(symbols()).toHaveLength(3));
    expect(screen.queryByRole("button", { name: "Remove currency filter USD" })).toBeNull();
  });

  test("24: privacy hides CAD and native amounts alike", async () => {
    await open(cadPayload());
    fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
    expect(screen.queryByText("$3,220.00")).toBeNull();
    expect(screen.queryByText("US$2,300.00")).toBeNull();
    expect(screen.queryByText("$15,300.00")).toBeNull();
  });
});

test("25: cadView off with several currencies opens on the first currency with its own tiles", async () => {
  await open(payload({ filters: { sort: "weight" } }));
  expect(symbols()).toEqual(["VFV|CAD", "XEQT|CAD"]);
  expect(screen.getByRole("region", { name: "CAD totals" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "CAD-equivalent totals" })).toBeNull();
});

test("the holdings table shows 10 rows per page with Prev/Next (owner request 2026-10-23)", async () => {
  const many = Array.from({ length: 14 }, (_, i) => row({ key: `ZZ${i}|CAD`, symbol: `ZZ${i}`, weight: (14 - i) / 100, weightCad: (14 - i) / 100 }));
  await open(payload({ rows: many }));
  expect(symbols()).toHaveLength(10);
  expect(screen.getByText("1–10 of 14")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(symbols()).toHaveLength(4);
  expect(screen.getByText("11–14 of 14")).toBeInTheDocument();
});

test("CAD view keeps table headers short so the columns fit the frame (owner report 2026-10-23)", async () => {
  await open(payload({ rows: [row(), row({ key: "ZZU|USD", symbol: "ZZU", currency: "USD", cad: { value: 100, totalReturn: 10, dayChange: 1, estimated: true } as any })], settings: { benchmark: "sp500", cadView: true, privacyDefault: false } as any }));
  const headers = within(table()).getAllByRole("columnheader").map((h) => h.textContent?.replace(/[▲▼]/g, "").trim());
  expect(headers).not.toContain("Weight (CAD est.)");
  expect(headers.some((h) => h?.includes("(at today's rate)"))).toBe(false);
  for (const h of headers) expect((h ?? "").length).toBeLessThanOrEqual(16);
});

test("tolerates an extra memory field on the result", async () => {
  await open({ ...payload(), memory: { facts: [{ id: "synthetic-id", text: "Saving for a house in 2028." }] } } as HoldingsPayload);
  expect(symbols()).toContain("VFV|CAD");
  expect(screen.queryByText(/house/)).toBeNull();
});

describe("Holdings shared filters (accountType, symbol)", () => {
  const picker = () => screen.getByLabelText("Account") as HTMLSelectElement;
  const echo = (args: any) => ({ structuredContent: payload({ filters: { sort: args.sort, ...(args.currency ? { currency: args.currency } : {}), ...(args.accountId ? { accountId: args.accountId } : {}), ...(args.accountType ? { accountType: args.accountType } : {}), ...(args.symbol ? { symbol: args.symbol } : {}) } }) });

  test("F1: an accountType echo shows a removable TFSA accounts chip and the picker reads it", async () => {
    await open(payload({ filters: { currency: "CAD", sort: "weight", accountType: "tfsa", accountId: "acct-secret-1" } }));
    const chip = screen.getByRole("button", { name: "Remove filter TFSA accounts" });
    expect(chip).toHaveTextContent("TFSA accounts");
    expect(picker().selectedOptions[0].textContent).toBe("TFSA accounts");
    expect([...picker().options].map((o) => o.textContent)).toEqual(["All accounts", "TFSA accounts", "TFSA", "RRSP"]);
  });

  test("F1b: a type of several accounts labels the value tile TFSA accounts value; one matched account keeps Account value (M2)", async () => {
    await open(payload({ filters: { currency: "CAD", sort: "weight", accountType: "tfsa" } }));
    const card = screen.getByRole("region", { name: "TFSA accounts value" });
    expect(within(card).getByText("TFSA accounts value in CAD")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Total value" })).toBeNull();
    cleanup();
    await open(cadPayload({ filters: { sort: "weight", accountType: "non_registered" } }));
    expect(within(screen.getByRole("region", { name: "non-registered accounts value" })).getByText("non-registered accounts value in CAD")).toBeInTheDocument();
    cleanup();
    await open(payload({ filters: { currency: "CAD", sort: "weight", accountType: "tfsa", accountId: "acct-secret-1" } }));
    expect(screen.getByRole("region", { name: "Account value" })).toBeInTheDocument();
  });

  test("F2: a sort change sends accountType and not the echoed accountId; the chip stays", async () => {
    const { callTool } = await open(payload({ filters: { currency: "CAD", sort: "weight", accountType: "tfsa", accountId: "acct-secret-1" } }), (_n, args) => echo(args));
    fireEvent.click(within(table()).getByRole("button", { name: /^Value/ }));
    expect(callTool).toHaveBeenLastCalledWith("get_holdings", { sort: "value", currency: "CAD", accountType: "tfsa" });
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Remove filter TFSA accounts" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "USD" }));
    expect(callTool).toHaveBeenLastCalledWith("get_holdings", { sort: "value", currency: "USD", accountType: "tfsa" });
  });

  test("F3: clearing the chip refetches with neither filter and the picker reads All accounts", async () => {
    const { callTool } = await open(payload({ filters: { currency: "CAD", sort: "weight", accountType: "tfsa" } }), (_n, args) => echo(args));
    fireEvent.click(screen.getByRole("button", { name: "Remove filter TFSA accounts" }));
    expect(callTool).toHaveBeenLastCalledWith("get_holdings", { sort: "weight", currency: "CAD" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove filter TFSA accounts" })).toBeNull());
    expect(picker().selectedOptions[0].textContent).toBe("All accounts");
    expect([...picker().options].map((o) => o.textContent)).toEqual(["All accounts", "TFSA", "RRSP"]);
  });

  test("F4: picking an account replaces the chip: accountId is sent, accountType is not", async () => {
    const { callTool } = await open(payload({ filters: { currency: "CAD", sort: "weight", accountType: "rrsp" } }), (_n, args) => echo(args));
    fireEvent.change(picker(), { target: { value: "acct-secret-2" } });
    expect(callTool).toHaveBeenLastCalledWith("get_holdings", { sort: "weight", currency: "CAD", accountId: "acct-secret-2" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove filter RRSP accounts" })).toBeNull());
    expect(picker().value).toBe("acct-secret-2");
  });

  test("F5: a symbol chip is kept on follow-ups and cleared on its own", async () => {
    const { callTool } = await open(payload({ filters: { currency: "CAD", sort: "weight", accountType: "tfsa", symbol: "XEQT" } }), (_n, args) => echo(args));
    const chip = screen.getByRole("button", { name: "Remove filter XEQT" });
    expect(chip).toHaveTextContent("XEQT");
    fireEvent.click(within(table()).getByRole("button", { name: /^Value/ }));
    expect(callTool).toHaveBeenLastCalledWith("get_holdings", { sort: "value", currency: "CAD", accountType: "tfsa", symbol: "XEQT" });
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove filter XEQT" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Remove filter XEQT" }));
    expect(callTool).toHaveBeenLastCalledWith("get_holdings", { sort: "value", currency: "CAD", accountType: "tfsa" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove filter XEQT" })).toBeNull());
    expect(screen.getByRole("button", { name: "Remove filter TFSA accounts" })).toBeInTheDocument();
  });

  test("F6: labels for cash and non-registered; the model context names the type", async () => {
    const { bridge } = await open(payload({ filters: { currency: "CAD", sort: "weight", accountType: "cash_account" } }));
    expect(screen.getByRole("button", { name: "Remove filter Cash accounts" })).toHaveTextContent("Cash accounts");
    await waitFor(() => expect(bridge.updateModelContext).toHaveBeenLastCalledWith("Viewing holdings: Cash accounts, CAD, sorted by weight"));
    cleanup();
    await open(payload({ filters: { currency: "CAD", sort: "weight", accountType: "non_registered" } }));
    expect(screen.getByRole("button", { name: "Remove filter non-registered accounts" })).toBeInTheDocument();
  });

  test("F7: an unknown accountType is ignored and the echoed accountId is used, as an old widget would", async () => {
    const { callTool } = await open(payload({ filters: { currency: "CAD", sort: "weight", accountType: "other", accountId: "acct-secret-1" } as any }), (_n, args) => echo(args));
    expect(screen.queryByRole("button", { name: /^Remove filter/ })).toBeNull();
    expect(picker().value).toBe("acct-secret-1");
    fireEvent.click(within(table()).getByRole("button", { name: /^Value/ }));
    expect(callTool).toHaveBeenLastCalledWith("get_holdings", { sort: "value", currency: "CAD", accountId: "acct-secret-1" });
  });

  test("F8: an old payload shows no filter chip and sends neither new field", async () => {
    const { callTool } = await open();
    expect(screen.queryByRole("button", { name: /^Remove filter/ })).toBeNull();
    fireEvent.click(within(table()).getByRole("button", { name: /^Value/ }));
    expect(callTool).toHaveBeenLastCalledWith("get_holdings", { sort: "value", currency: "CAD" });
  });
});

test("the weight column states its basis: holdings, cash excluded (B1)", async () => {
  await open();
  expect(screen.getByText(/^Weight is of [A-Z]{3} holdings, cash excluded$/)).toBeInTheDocument();
});

test("the Today column names the last session when it isn't today (B3)", async () => {
  await open(payload({ rows: rows().map((r) => ({ ...r, dayChange: { amount: 1, fraction: 0.01, estimated: true as const, sessionDate: "2024-03-08" } })) }));
  expect(within(table()).getByText(/^Mar 8, 2024 \(est\.\)$/)).toBeInTheDocument();
  expect(within(table()).queryByText("Today (est.)")).toBeNull();
});

describe("sorting", () => {
  const day = (amount: number | null, fraction: number | null) => ({ amount, fraction, estimated: true as const });
  const sym = (symbol: string, over: Partial<HoldingRow>): HoldingRow =>
    row({ key: `${symbol}|CAD`, symbol, accounts: [], ...over });
  // Given out of order on purpose: the default sort (weight, largest first) has to put them right.
  const sortRowsFixture = (): HoldingRow[] => [
    sym("EEE", { price: 10, units: 40, marketValue: 400, weight: 0.08, weightCad: 0.08, totalReturn: -30, totalReturnFraction: -0.07, dayChange: day(-8, -0.02) }),
    sym("CCC", { price: null, units: 5, marketValue: null, weight: null, weightCad: null, totalReturn: null, totalReturnFraction: null, dayChange: null }),
    sym("AAA", { price: 50, units: 10, marketValue: 500, weight: 0.1, weightCad: 0.1, totalReturn: 50, totalReturnFraction: 0.11, dayChange: day(5, 0.01) }),
    sym("DDD", { price: 70, units: 1, marketValue: 700, weight: 0.15, weightCad: 0.15, totalReturn: 20, totalReturnFraction: 0.03, dayChange: day(null, null) }),
    sym("BBB", { price: 50, units: 20, marketValue: 1000, weight: 0.2, weightCad: 0.2, totalReturn: 100, totalReturnFraction: 0.11, dayChange: day(3, 0.02) }),
  ];
  const sortPayload = (over: Partial<HoldingsPayload> = {}) => payload({ rows: sortRowsFixture(), ...over });
  const openSorted = (p = sortPayload()) => open(p, async () => ({ structuredContent: p }));
  const order = () => symbols().map((k) => k!.split("|")[0]);
  const header = (label: string) => within(table()).getByRole("button", { name: new RegExp(`^${label}`) });
  const ariaSort = (label: string) => within(table()).getByRole("columnheader", { name: new RegExp(`^${label}`) }).getAttribute("aria-sort");
  const picker = () => screen.getByRole("combobox", { name: "Sort by" }) as HTMLSelectElement;
  const pick = async (key: string) => { fireEvent.change(picker(), { target: { value: key } }); await act(async () => {}); };
  const click = async (label: string) => { fireEvent.click(header(label)); await act(async () => {}); };

  test("S1: the default order is unchanged: weight, largest first, unknown last", async () => {
    await openSorted();
    expect(order()).toEqual(["BBB", "DDD", "AAA", "EEE", "CCC"]);
    expect(ariaSort("Weight")).toBe("descending");
    expect(ariaSort("Price")).toBe("none");
    expect(picker().value).toBe("weight");
  });

  test("S2: a model-requested sort opens in that order (returnPct is now a real key)", async () => {
    await openSorted(sortPayload({ filters: { currency: "CAD", sort: "returnPct" } }));
    expect(order()).toEqual(["AAA", "BBB", "DDD", "EEE", "CCC"]);
    expect(picker().value).toBe("returnPct");
  });

  test("S3: Price sorts highest first then lowest first, ties by symbol either way, the unknown price last either way", async () => {
    await openSorted();
    await click("Price");
    expect(order()).toEqual(["DDD", "AAA", "BBB", "EEE", "CCC"]);
    expect(ariaSort("Price")).toBe("descending");
    expect(ariaSort("Weight")).toBe("none");
    expect(picker().value).toBe("price");
    await click("Price");
    expect(order()).toEqual(["EEE", "AAA", "BBB", "DDD", "CCC"]);
    expect(ariaSort("Price")).toBe("ascending");
  });

  test("S4: the Price column shows the quote in the holding's own currency and privacy leaves it alone", async () => {
    await openSorted();
    fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
    const aaa = document.querySelector('tr[data-row="AAA|CAD"]') as HTMLElement;
    expect(within(aaa).getByText("$50.00")).toBeInTheDocument();
    const ccc = document.querySelector('tr[data-row="CCC|CAD"]') as HTMLElement;
    expect(within(ccc).getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  test("S5: Units, Value, Weight, Gain and Today each sort both ways with unknowns last", async () => {
    const { callTool } = await openSorted();
    // Number columns start highest first; Symbol, the one text column, starts A to Z.
    const cases: Array<[string, string[], string[], string, string]> = [
      ["Units", ["EEE", "BBB", "AAA", "CCC", "DDD"], ["DDD", "CCC", "AAA", "BBB", "EEE"], "descending", "ascending"],
      ["Value", ["BBB", "DDD", "AAA", "EEE", "CCC"], ["EEE", "AAA", "DDD", "BBB", "CCC"], "descending", "ascending"],
      ["Weight", ["BBB", "DDD", "AAA", "EEE", "CCC"], ["EEE", "AAA", "DDD", "BBB", "CCC"], "descending", "ascending"],
      ["Gain vs cost", ["BBB", "AAA", "DDD", "EEE", "CCC"], ["EEE", "DDD", "AAA", "BBB", "CCC"], "descending", "ascending"],
      ["Today \\(est\\.\\)", ["AAA", "BBB", "EEE", "CCC", "DDD"], ["EEE", "BBB", "AAA", "CCC", "DDD"], "descending", "ascending"],
      ["Symbol", ["AAA", "BBB", "CCC", "DDD", "EEE"], ["EEE", "DDD", "CCC", "BBB", "AAA"], "ascending", "descending"],
    ];
    for (const [label, first, second, firstDir, secondDir] of cases) {
      // Weight is not the open sort by this point (the one before it is), so it too starts with its own first direction.
      await click(label);
      expect(order(), `${label} ${firstDir}`).toEqual(first);
      await click(label);
      expect(order(), `${label} ${secondDir}`).toEqual(second);
    }
    // The ones the tool knows are also asked for; Units has no tool sort and stays on the rows in hand.
    expect(callTool).toHaveBeenCalledWith("get_holdings", expect.objectContaining({ sort: "return" }));
    expect(callTool).not.toHaveBeenCalledWith("get_holdings", expect.objectContaining({ sort: "units" }));
  });

  test("S6: Gain % and Today % sort from the sort control, ties by symbol, unknowns last", async () => {
    await openSorted();
    const labels = [...picker().options].map((o) => o.textContent);
    expect(labels).toEqual(expect.arrayContaining(["Symbol", "Units", "Price", "Value", "Weight", "Gain vs cost", "Today (est.)", "Gain %", "Today % (est.)"]));
    await pick("returnPct");
    expect(order()).toEqual(["AAA", "BBB", "DDD", "EEE", "CCC"]);
    fireEvent.click(screen.getByRole("button", { name: /Sort order: descending/ }));
    await act(async () => {});
    expect(order()).toEqual(["EEE", "DDD", "AAA", "BBB", "CCC"]);
    await pick("todayPct");
    expect(order()).toEqual(["BBB", "AAA", "EEE", "CCC", "DDD"]);
    fireEvent.click(screen.getByRole("button", { name: /Sort order: descending/ }));
    await act(async () => {});
    expect(order()).toEqual(["EEE", "AAA", "BBB", "CCC", "DDD"]);
    // The sort control carries the state; no column header claims it.
    expect(picker().value).toBe("todayPct");
    expect(ariaSort("Weight")).toBe("none");
    expect(screen.getByRole("button", { name: /Sort order: ascending/ })).toHaveTextContent("Ascending");
  });

  test("S7: the sort survives a scope change and the model is told the key, never a value", async () => {
    const p = sortPayload();
    const { bridge } = await open(p, async (_n, args) => ({ structuredContent: sortPayload({ filters: { currency: "CAD", sort: args.sort, ...(args.accountId ? { accountId: args.accountId } : {}) } }) }));
    await click("Price");
    await waitFor(() => expect(bridge.updateModelContext).toHaveBeenLastCalledWith("Viewing holdings: all accounts, CAD, sorted by price"));
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-1" } });
    await waitFor(() => expect(bridge.updateModelContext).toHaveBeenLastCalledWith("Viewing holdings: one account, CAD, sorted by price"));
    await act(async () => {});
    expect(order()).toEqual(["DDD", "AAA", "BBB", "EEE", "CCC"]);
    for (const [text] of (bridge.updateModelContext as any).mock.calls) expect(text).not.toMatch(/\d|\$/);
  });

  describe("in the CAD view", () => {
    const mixed = (): HoldingsPayload => {
      const p = cadPayload();
      p.rows = [
        row({ key: "VFV|CAD", symbol: "VFV", price: 150, marketValue: 6975, weightCad: 0.5, accounts: [] }),
        row({ key: "XEQT|CAD", symbol: "XEQT", price: 30, marketValue: 3000, weightCad: 0.21, accounts: [] }),
        // 2,300 USD is more than XEQT's 3,000 CAD in CAD (3,220) but less as bare numbers.
        row({ key: "AAPL|USD", symbol: "AAPL", currency: "USD", price: 230, marketValue: 2300, weightCad: 0.29, accounts: [], cad: { value: usd(2300), totalReturn: usd(300), dayChange: null } }),
        // 1,500 USD is 2,100 CAD, so it sits above a 1,800 CAD holding although 1,500 is the smaller bare number.
        row({ key: "MSFT|USD", symbol: "MSFT", currency: "USD", price: 20, marketValue: 1500, weightCad: 0.14, accounts: [], cad: { value: usd(1500), totalReturn: null, dayChange: null } }),
        row({ key: "ZINC|CAD", symbol: "ZINC", price: 5, marketValue: 1800, weightCad: 0.1, accounts: [] }),
      ];
      return p;
    };
    const openMixed = (p = mixed()) => open(p, async () => ({ structuredContent: p }));

    test("S8: Value sorts on the CAD figure and the native amount stays on screen", async () => {
      await openMixed();
      await click("Value");
      expect(order()).toEqual(["VFV", "AAPL", "XEQT", "MSFT", "ZINC"]);
      await click("Value");
      expect(order()).toEqual(["ZINC", "MSFT", "XEQT", "AAPL", "VFV"]);
      const aapl = document.querySelector('tr[data-row="AAPL|USD"]') as HTMLElement;
      expect(aapl.querySelector(".w-home-native")).toHaveTextContent("US$2,300.00");
      expect(within(aapl).getByText("$3,220.00")).toBeInTheDocument();
      expect(within(aapl).getAllByText("est.").length).toBeGreaterThanOrEqual(1);
    });

    test("S9: a row with no CAD figure sorts last on Value, not by its bare native number", async () => {
      const p = mixed();
      p.rows = p.rows.map((r) => (r.symbol === "MSFT" ? { ...r, cad: undefined } : r));
      await openMixed(p);
      await click("Value");
      expect(order()).toEqual(["VFV", "AAPL", "XEQT", "ZINC", "MSFT"]);
      await click("Value");
      expect(order()).toEqual(["ZINC", "XEQT", "AAPL", "VFV", "MSFT"]);
    });

    test("S10: Price is never ordered across currencies: it sorts inside CAD, then inside USD, and says so", async () => {
      await openMixed();
      expect(screen.queryByText("Price is sorted within each currency, not across them.")).toBeNull();
      await click("Price");
      expect(order()).toEqual(["VFV", "XEQT", "ZINC", "AAPL", "MSFT"]);
      expect(screen.getByText("Price is sorted within each currency, not across them.")).toBeInTheDocument();
      await click("Price");
      expect(order()).toEqual(["ZINC", "XEQT", "VFV", "MSFT", "AAPL"]);
      const aapl = document.querySelector('tr[data-row="AAPL|USD"]') as HTMLElement;
      expect(within(aapl).getByText("US$230.00")).toBeInTheDocument();
      // Another metric drops the note again.
      await click("Symbol");
      expect(screen.queryByText("Price is sorted within each currency, not across them.")).toBeNull();
    });

    test("S11: the percent sorts are unitless, so they order CAD and USD rows together", async () => {
      const p = mixed();
      p.rows = p.rows.map((r) => ({ ...r, totalReturnFraction: { VFV: 0.1, XEQT: 0.3, AAPL: 0.2, MSFT: null, ZINC: 0.05 }[r.symbol] ?? null }));
      await openMixed(p);
      await pick("returnPct");
      expect(order()).toEqual(["XEQT", "AAPL", "VFV", "ZINC", "MSFT"]);
      expect(screen.queryByText("Price is sorted within each currency, not across them.")).toBeNull();
    });
  });
});

test("says how old the prices are next to the value, so a gap with the brokerage's live total is explained", async () => {
  await open(payload({ pricesAsOf: "2026-10-16T12:06:00.000Z" }));
  const note = screen.getByText(/^Prices as of /);
  expect(note.textContent).toContain(formatDateTime("2026-10-16T12:06:00.000Z"));
  expect(note.textContent).toMatch(/SnapTrade's last sync.*live prices/);
  cleanup();
  await open(payload({ pricesAsOf: null }));
  expect(screen.queryByText(/^Prices as of /)).toBeNull();
});
