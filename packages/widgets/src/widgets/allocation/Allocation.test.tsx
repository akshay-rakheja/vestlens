import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { Allocation } from "./Allocation";
import type { AllocationPayload, Slice } from "./types";

const slice = (key: string, label: string, valueCad: number, fraction: number, over: Partial<Slice> = {}): Slice => ({
  key, label, valueCad, fraction, estimated: false, moreHoldings: 0,
  holdings: [{ holdingKey: "VFV|CAD", symbol: "VFV", valueCad: valueCad * 0.6 }, { holdingKey: "AAPL|USD", symbol: "AAPL", valueCad: valueCad * 0.4 }], ...over,
});
function payload(over: Partial<AllocationPayload> = {}): AllocationPayload {
  return {
    dimension: "assetClass",
    slices: [slice("etfs-funds", "ETFs & funds", 6000, 0.6), slice("stocks", "Stocks", 3000, 0.3, { estimated: true }), slice("cash", "Cash", 1000, 0.1, { holdings: [{ holdingKey: "cash:TFSA:CAD", symbol: "Cash (CAD)", valueCad: 1000 }] })],
    unclassifiedFraction: 0, estimated: false, fx: { rate: 1.4, date: "2026-10-16" }, usdExcluded: false, excludedCurrencies: [], unvalued: 0,
    concentration: { top10: 0.9, effectiveN: 3.4, estimated: false, largest: { symbol: "VFV", fraction: 0.36 }, largestWithLookThrough: null },
    overlap: [], accounts: [{ id: "acct-secret-1", label: "TFSA 2" }, { id: "acct-secret-2", label: "RRSP" }], filters: {},
    settings: { benchmark: "sp500", cadView: false, privacyDefault: false }, asOf: "2026-10-16T15:00:00Z", ...over,
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
  return { bridge, callTool, push: (p: AllocationPayload) => listener({ structuredContent: p }) };
}
async function open(p = payload(), impl?: Impl) {
  const f = fakeBridge(impl);
  render(<Allocation bridge={f.bridge} />);
  expect(screen.getByText(/loading your allocation/i)).toBeInTheDocument();
  act(() => f.push(p));
  await screen.findByRole("list", { name: "Allocation breakdown" });
  return f;
}
const listItems = () => within(screen.getByRole("list", { name: "Allocation breakdown" })).getAllByRole("listitem").map((li) => li.textContent);
afterEach(() => { cleanup(); vi.useRealTimers(); });

test("1: renders the donut, the sorted list with percent and value, and the read-only badge", async () => {
  await open();
  expect(screen.getByText("Read-only")).toBeInTheDocument();
  expect(document.querySelectorAll("path[data-slice]")).toHaveLength(3);
  expect(listItems()).toEqual(["ETFs & funds60% · $6,000.00", "Stocks30% · $3,000.00 est.", "Cash10% · $1,000.00"]);
});

test("2: the dimension switch calls get_allocation with that dimension and shows the new view", async () => {
  const next = payload({ dimension: "currency", slices: [slice("CAD", "CAD", 7000, 0.7), slice("USD", "USD", 3000, 0.3, { estimated: true })] });
  const { callTool } = await open(payload(), async () => ({ structuredContent: next }));
  fireEvent.click(screen.getByRole("radio", { name: "Currency" }));
  expect(callTool).toHaveBeenCalledWith("get_allocation", { dimension: "currency" });
  await waitFor(() => expect(listItems()).toEqual(["CAD70% · $7,000.00", "USD30% · $3,000.00 est."]));
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-2" } });
  expect(callTool).toHaveBeenLastCalledWith("get_allocation", { dimension: "currency", accountId: "acct-secret-2" });
});

test("3: all five dimension labels are offered", async () => {
  await open();
  expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Asset class", "Currency", "Account", "Sector", "Region"]);
});

test("4: the donut shows the top eight slices plus Other; the list shows every slice", async () => {
  const many = Array.from({ length: 9 }, (_, i) => slice(`s${i}`, `Sector ${i}`, 1000 - i, 0.1 - i * 0.001));
  await open(payload({ dimension: "sector", slices: many }));
  const keys = [...document.querySelectorAll("path[data-slice]")].map((p) => p.getAttribute("data-slice"));
  expect(keys).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "__other"]);
  expect(listItems()).toHaveLength(9);
});

test("5: a slice click lists its holdings; a holding click sends the history request; cash is not clickable", async () => {
  const { bridge } = await open();
  fireEvent.click(screen.getByRole("button", { name: "ETFs & funds 60%" }));
  const section = screen.getByRole("region", { name: "ETFs & funds holdings" });
  expect(within(section).getByText("$3,600.00")).toBeInTheDocument();
  fireEvent.click(within(section).getByRole("button", { name: "VFV" }));
  expect(bridge.sendMessage).toHaveBeenCalledWith("Show my history with VFV");
  (bridge.sendMessage as any).mockRejectedValueOnce(new Error("no"));
  fireEvent.click(within(section).getByRole("button", { name: "AAPL" }));
  expect(await screen.findByText("Couldn't send that to the chat.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cash 10%" }));
  expect(within(screen.getByRole("region", { name: "Cash holdings" })).queryByRole("button")).toBeNull();
});

test("5b: clicking a donut slice selects it and the overflow count is shown", async () => {
  await open(payload({ slices: [slice("stocks", "Stocks", 3000, 1, { moreHoldings: 4 })] }));
  fireEvent.click(document.querySelector("path[data-slice='stocks']")!);
  const section = screen.getByRole("region", { name: "Stocks holdings" });
  expect(within(section).getByText("+4 more")).toBeInTheDocument();
});

test("6: concentration tiles and the look-through hint outside sector/region", async () => {
  await open();
  const tiles = screen.getByRole("region", { name: "Concentration" });
  expect(within(tiles).getByText("Top 10").parentElement).toHaveTextContent("90%");
  expect(within(tiles).getByText("Effective holdings").parentElement).toHaveTextContent("3.4");
  expect(within(tiles).getByText("Largest").parentElement).toHaveTextContent("VFV 36%");
  expect(within(tiles).getByText("Largest incl. ETFs (est.)").parentElement).toHaveTextContent("—");
  expect(screen.getByText("Switch to Sector or Region to see ETF look-through")).toBeInTheDocument();
  expect(screen.queryByText("Sector and region data: Yahoo Finance")).toBeNull();
});

test("6b: concentration tiles say est. when values were converted", async () => {
  await open(payload({ concentration: { top10: 0.9, effectiveN: 3.4, estimated: true, largest: { symbol: "VFV", fraction: 0.36 }, largestWithLookThrough: null } }));
  const tiles = screen.getByRole("region", { name: "Concentration" });
  expect(within(tiles).getByText("Top 10").parentElement).toHaveTextContent("90% est.");
  expect(within(tiles).getByText("Effective holdings").parentElement).toHaveTextContent("3.4 est.");
  expect(within(tiles).getByText("Largest").parentElement).toHaveTextContent("VFV 36% est.");
});

test("7: sector view shows look-through, overlap, the Yahoo note and the unclassified note", async () => {
  await open(payload({
    dimension: "sector", estimated: true, unclassifiedFraction: 0.12,
    concentration: { top10: 0.9, effectiveN: 3.4, estimated: false, largest: { symbol: "VFV", fraction: 0.36 }, largestWithLookThrough: { symbol: "AAPL", fraction: 0.07, estimated: true } },
    overlap: [{ symbol: "AAPL", direct: 0.03, indirect: 0.04, combined: 0.07, estimated: true }],
  }));
  expect(within(screen.getByRole("region", { name: "Concentration" })).getByText("Largest incl. ETFs (est.)").parentElement).toHaveTextContent("AAPL 7.0%");
  expect(screen.queryByText("Switch to Sector or Region to see ETF look-through")).toBeNull();
  expect(screen.getByText("12% unclassified (no data)")).toBeInTheDocument();
  expect(screen.getByText("Sector and region data: Yahoo Finance")).toBeInTheDocument();
  const overlap = screen.getByRole("region", { name: "Overlap" });
  expect(overlap).toHaveTextContent("7.0% combined");
  fireEvent.click(within(overlap).getByRole("button", { name: "AAPL" }));
});

test("8: no unclassified note when zero; the estimated conversion note names the BoC date", async () => {
  await open();
  expect(screen.queryByText(/unclassified/)).toBeNull();
  expect(screen.queryByText(/Converted to CAD/)).toBeNull();
  cleanup();
  await open(payload({ estimated: true }));
  expect(screen.getByText("Converted to CAD at Bank of Canada rate of 2026-10-16 · est.")).toBeInTheDocument();
});

test("9: excluded USD holdings are announced", async () => {
  await open(payload({ usdExcluded: true, fx: { rate: null, date: null } }));
  expect(screen.getByText("USD holdings excluded: exchange rate unavailable")).toBeInTheDocument();
  expect(screen.queryByText(/Converted to CAD/)).toBeNull();
});

test("10: privacy hides money but keeps percentages", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  expect(screen.queryByText("$6,000.00")).toBeNull();
  expect(screen.getAllByRole("img", { name: "Hidden amount" }).length).toBeGreaterThanOrEqual(3);
  expect(listItems()[0]).toContain("60%");
  fireEvent.click(screen.getByRole("button", { name: "ETFs & funds 60%" }));
  expect(screen.queryByText("$3,600.00")).toBeNull();
});

test("11: the model context names the view without digits, ids or account labels", async () => {
  const { bridge } = await open();
  await waitFor(() => expect(bridge.updateModelContext).toHaveBeenCalledWith("Viewing allocation by asset class: all accounts"));
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-1" } });
  await waitFor(() => expect(bridge.updateModelContext).toHaveBeenLastCalledWith("Viewing allocation by asset class: one account"));
  for (const [text] of (bridge.updateModelContext as any).mock.calls) { expect(text).not.toMatch(/\d|secret|TFSA/); }
});

test("12: a failed reload keeps the view and shows a notice; the newest request wins", async () => {
  let n = 0;
  await open(payload(), async () => { n += 1; if (n === 1) throw new Error("boom"); return { structuredContent: payload({ dimension: "region", slices: [slice("europe", "Europe", 100, 1)] }) }; });
  fireEvent.click(screen.getByRole("radio", { name: "Sector" }));
  expect(await screen.findByText("Couldn't load that view. Showing the previous one.")).toBeInTheDocument();
  expect(listItems()).toHaveLength(3);
  expect(screen.getByRole("radio", { name: "Asset class" })).toHaveAttribute("aria-checked", "true");
  fireEvent.click(screen.getByRole("radio", { name: "Region" }));
  await waitFor(() => expect(listItems()).toEqual(["Europe100% · $100.00"]));
});

test("12b: a stale response does not overwrite a newer one", async () => {
  const resolvers: Array<(r: ToolResult) => void> = [];
  await open(payload(), () => new Promise<ToolResult>((res) => { resolvers.push(res); }));
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-1" } });
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-2" } });
  await act(async () => { resolvers[1]({ structuredContent: payload({ slices: [slice("n", "New", 10, 1)] }) }); });
  await act(async () => { resolvers[0]({ structuredContent: payload({ slices: [slice("o", "Old", 10, 1)] }) }); });
  expect(listItems()).toEqual(["New100% · $10.00"]);
});

test("13: an empty view says so", async () => {
  const f = fakeBridge();
  render(<Allocation bridge={f.bridge} />);
  act(() => f.push(payload({ slices: [] })));
  expect(await screen.findByText("Nothing to allocate in this view")).toBeInTheDocument();
});

describe("Allocation resilience", () => {
  test("14: shows a retry 30 s after initialize with no payload, and retry hydrates", async () => {
    vi.useFakeTimers();
    const { bridge } = fakeBridge();
    (bridge.callTool as any).mockImplementation(async (name: string) => ({ structuredContent: name === "show_allocation" ? payload() : {} }));
    render(<Allocation bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(29_500); });
    expect(screen.queryByText(/still loading/i)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.getByText(/still loading/i)).toBeInTheDocument();
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(bridge.callTool).toHaveBeenCalledWith("show_allocation", {});
    expect(await screen.findByRole("list", { name: "Allocation breakdown" })).toBeInTheDocument();
  });
});

test("15: Unclassified is its own selectable donut slice beside Other with 11 sectors", async () => {
  const sectors = Array.from({ length: 11 }, (_, i) => slice(`s${i}`, `Sector ${i}`, 1000 - i, 0.08));
  const un = slice("unclassified", "Unclassified (no data)", 50, 0.02);
  await open(payload({ dimension: "sector", slices: [...sectors, un], unclassifiedFraction: 0.02 }));
  const keys = [...document.querySelectorAll("path[data-slice]")].map((p) => p.getAttribute("data-slice"));
  expect(keys).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "__other", "unclassified"]);
  fireEvent.click(document.querySelector("path[data-slice='unclassified']")!);
  expect(screen.getByRole("region", { name: "Unclassified (no data) holdings" })).toBeInTheDocument();
});

test("16: excluded currencies and unvalued holdings are announced", async () => {
  await open(payload({ excludedCurrencies: ["EUR", "GBP"], unvalued: 2 }));
  expect(screen.getByText("EUR, GBP holdings excluded: exchange rate unavailable")).toBeInTheDocument();
  expect(screen.getByText("2 holdings without a reported value are not included")).toBeInTheDocument();
  cleanup();
  await open(payload({ unvalued: 1 }));
  expect(screen.getByText("1 holding without a reported value is not included")).toBeInTheDocument();
});

test("17: a tiny unclassified share reads <0.1%", async () => {
  await open(payload({ unclassifiedFraction: 0.0002 }));
  expect(screen.getByText("<0.1% unclassified (no data)")).toBeInTheDocument();
});

const colorOfSlice = (key: string) => document.querySelector(`path[data-slice='${key}']`)!.getAttribute("data-color");
const listButton = (label: RegExp) => within(screen.getByRole("list", { name: "Allocation breakdown" })).getByRole("button", { name: label });
const swatchOf = (label: RegExp) => (listButton(label).querySelector(".w-swatch") as HTMLElement).style.backgroundColor;

test("18: no two donut slices share a colour; Unclassified and Other are neutral, never a series slot", async () => {
  const sectors = ["Technology", "Financial services", "Healthcare", "Communication services", "Consumer cyclical", "Industrials", "Consumer defensive", "Energy", "Utilities", "Basic materials"]
    .map((label, i) => slice(label.toLowerCase(), label, 1000 - i, 0.09 - i * 0.001));
  await open(payload({ dimension: "sector", slices: [...sectors, slice("unclassified", "Unclassified (no data)", 900, 0.1)], unclassifiedFraction: 0.1 }));
  const colors = [...document.querySelectorAll("path[data-slice]")].map((p) => p.getAttribute("data-color"));
  expect(new Set(colors).size).toBe(colors.length);
  expect(colorOfSlice("unclassified")).toBe("var(--c-unclassified)");
  expect(colorOfSlice("__other")).toBe("var(--c-other)");
  expect(colorOfSlice("technology")).toBe("var(--c1)");
  // Folded slices are listed with the Other colour.
  expect(swatchOf(/^Basic materials/)).toBe("var(--c-other)");
  expect(listButton(/^Unclassified/).querySelector(".w-swatch.w-hatch")).not.toBeNull();
});

test("19: a sector keeps its colour when the account filter changes the set and order of slices", async () => {
  const first = payload({ dimension: "sector", slices: [slice("technology", "Technology", 600, 0.6), slice("energy", "Energy", 400, 0.4)] });
  const second = payload({ dimension: "sector", slices: [slice("energy", "Energy", 900, 0.9), slice("healthcare", "Healthcare", 100, 0.1)] });
  await open(first, async () => ({ structuredContent: second }));
  const energy = colorOfSlice("energy");
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-1" } });
  await waitFor(() => expect(listItems()[0]).toContain("Energy"));
  expect(colorOfSlice("energy")).toBe(energy);
  expect(colorOfSlice("healthcare")).not.toBe(energy);
});

test("20: the list is the legend: no legend row under the donut; each row has a swatch in its slice colour and a share bar", async () => {
  await open();
  expect(document.querySelector("[data-chart-legend]")).toBeNull();
  expect(swatchOf(/^ETFs & funds/)).toBe(colorOfSlice("etfs-funds"));
  const bar = listButton(/^ETFs & funds/).querySelector(".w-share > span") as HTMLElement;
  expect(bar.style.width).toBe("60%");
  expect(document.querySelector(".w-alloc-list, button.w-chip.w-row")).toBeNull();
});

test("21: the drill-down names the slice and its holding count, shows each holding's share of the slice, and the donut centre follows the selection", async () => {
  await open(payload({ slices: [slice("stocks", "Stocks", 3000, 1, { moreHoldings: 4 })] }));
  expect(document.querySelector("[data-donut-center]")).toHaveTextContent("Stocks100%");
  fireEvent.click(screen.getByRole("button", { name: "Stocks 100%" }));
  const section = screen.getByRole("region", { name: "Stocks holdings" });
  expect(within(section).getByRole("heading")).toHaveTextContent("Stocks6 holdings");
  expect(within(section).getAllByRole("listitem")[0]).toHaveTextContent("$1,800.00 · 60%");
  expect(within(section).getByRole("button", { name: "VFV" })).toHaveClass("w-link");
  expect(document.querySelector("[data-donut-center]")).toHaveTextContent("Stocks100%");
});

test("22: the notes are collected in one footer block", async () => {
  await open(payload({ estimated: true, unvalued: 1 }));
  const footer = document.querySelector("footer.w-notes")!;
  expect(footer).toHaveTextContent("Switch to Sector or Region to see ETF look-through");
  expect(footer).toHaveTextContent("1 holding without a reported value is not included");
  expect(footer).toHaveTextContent("Converted to CAD at Bank of Canada rate of 2026-10-16 · est.");
});

describe("Allocation CAD total", () => {
  const home = (over: Record<string, unknown> = {}) => ({
    total: { amount: 15300, estimated: true, rateDates: ["2026-10-16"], excluded: [] as Array<{ amount: number; currency: string }> },
    includesUnreported: false, rowsDiffer: false, ...over,
  });
  const cad = (over: Partial<AllocationPayload> = {}) => payload({ home: home(), settings: { benchmark: "sp500", cadView: true, privacyDefault: false }, ...over });

  test("26: cadView on shows the one CAD total with its caption and the currency switch", async () => {
    await open(cad());
    const card = screen.getByRole("region", { name: "Total value" });
    expect(within(card).getByText("$15,300.00")).toBeInTheDocument();
    expect(card).toHaveTextContent("est. · BoC Oct 16");
    expect(screen.getByRole("button", { name: /Show original currencies/ })).toBeInTheDocument();
  });

  test("27: cadView off shows no total card and the list is unchanged", async () => {
    await open(payload({ home: home() }));
    expect(screen.queryByRole("region", { name: "Total value" })).toBeNull();
    expect(listItems()).toEqual(["ETFs & funds60% · $6,000.00", "Stocks30% · $3,000.00 est.", "Cash10% · $1,000.00"]);
  });

  test("28: the rows-differ note and the unreported note show when set; a scoped total says Account value", async () => {
    await open(cad({ home: home({ rowsDiffer: true, includesUnreported: true }), filters: { accountId: "acct-secret-1" } }));
    expect(screen.getByRole("region", { name: "Account value" })).toBeInTheDocument();
    expect(screen.getByText("Rows converted at the BoC rate; the brokerage total uses its own rate.")).toBeInTheDocument();
    expect(screen.getByText("Includes accounts without a brokerage total (valued from holdings)")).toBeInTheDocument();
  });

  test("28b: a type of several accounts labels the total TFSA accounts value; one matched account says Account value (M2)", async () => {
    await open(cad({ filters: { accountType: "tfsa" } }));
    const card = screen.getByRole("region", { name: "TFSA accounts value" });
    expect(within(card).getByText("TFSA accounts value in CAD")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Total value" })).toBeNull();
    cleanup();
    await open(cad({ filters: { accountType: "tfsa", accountId: "acct-secret-1" } }));
    expect(screen.getByRole("region", { name: "Account value" })).toBeInTheDocument();
  });

  test("29: nothing converted shows native amounts and the note, never CAD $0.00; privacy hides the total", async () => {
    await open(cad({ home: home({ total: { amount: 0, estimated: false, rateDates: [], excluded: [{ amount: 2300, currency: "USD" }] } }) }));
    const card = screen.getByRole("region", { name: "Total value" });
    expect(card).toHaveTextContent("US$2,300.00");
    expect(card).toHaveTextContent("Not converted (no recent Bank of Canada rate)");
    expect(card).not.toHaveTextContent("$0.00");
    cleanup();
    await open(cad());
    fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
    expect(screen.queryByText("$15,300.00")).toBeNull();
  });

  test("30: the switch saves cadView and removes the total card", async () => {
    const { callTool } = await open(cad(), async (name) => (name === "save_portfolio_settings" ? { structuredContent: {} } : { structuredContent: payload() }));
    fireEvent.click(screen.getByRole("button", { name: /Show original currencies/ }));
    expect(callTool).toHaveBeenCalledWith("save_portfolio_settings", { cadView: false });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Total value" })).toBeNull());
  });
});

describe("Allocation shared filter (accountType)", () => {
  const picker = () => screen.getByLabelText("Account") as HTMLSelectElement;
  const echo = (args: any) => ({ structuredContent: payload({ dimension: args.dimension, filters: { ...(args.accountId ? { accountId: args.accountId } : {}), ...(args.accountType ? { accountType: args.accountType } : {}) } }) });

  test("F1: an accountType echo shows a removable TFSA accounts chip and the picker reads it", async () => {
    await open(payload({ filters: { accountType: "tfsa", accountId: "acct-secret-1" } }));
    expect(screen.getByRole("button", { name: "Remove filter TFSA accounts" })).toHaveTextContent("TFSA accounts");
    expect(picker().selectedOptions[0].textContent).toBe("TFSA accounts");
  });

  test("F2: a dimension change sends accountType and not the echoed accountId", async () => {
    const { callTool } = await open(payload({ filters: { accountType: "tfsa", accountId: "acct-secret-1" } }), (_n, args) => echo(args));
    fireEvent.click(screen.getByRole("radio", { name: "Currency" }));
    expect(callTool).toHaveBeenLastCalledWith("get_allocation", { dimension: "currency", accountType: "tfsa" });
    await waitFor(() => expect(screen.getByRole("radio", { name: "Currency" })).toBeChecked());
    expect(screen.getByRole("button", { name: "Remove filter TFSA accounts" })).toBeInTheDocument();
  });

  test("F3: clearing the chip refetches with neither filter", async () => {
    const { callTool } = await open(payload({ filters: { accountType: "fhsa" } }), (_n, args) => echo(args));
    fireEvent.click(screen.getByRole("button", { name: "Remove filter FHSA accounts" }));
    expect(callTool).toHaveBeenLastCalledWith("get_allocation", { dimension: "assetClass" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove filter FHSA accounts" })).toBeNull());
    expect(picker().selectedOptions[0].textContent).toBe("All accounts");
  });

  test("F4: picking an account replaces the chip", async () => {
    const { callTool } = await open(payload({ filters: { accountType: "tfsa" } }), (_n, args) => echo(args));
    fireEvent.change(picker(), { target: { value: "acct-secret-2" } });
    expect(callTool).toHaveBeenLastCalledWith("get_allocation", { dimension: "assetClass", accountId: "acct-secret-2" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove filter TFSA accounts" })).toBeNull());
  });

  test("F5: an old payload shows no filter chip and sends neither new field", async () => {
    const { callTool } = await open();
    expect(screen.queryByRole("button", { name: /^Remove filter/ })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Region" }));
    expect(callTool).toHaveBeenLastCalledWith("get_allocation", { dimension: "region" });
  });
});

test("basis captions: shares of total value, concentration of holdings (B1)", async () => {
  await open(payload());
  expect(screen.getByText("Shares of total value, cash included")).toBeInTheDocument();
  expect(screen.getByText("Of holdings, cash excluded")).toBeInTheDocument();
});

test("a margin debit: shares of net value over 100%, the debit stated, the donut labelled the same (A13)", async () => {
  const home = { total: { amount: 60000, estimated: false, rateDates: [], excluded: [], excludedCount: 0 }, includesUnreported: false, rowsDiffer: false, marginDebit: { amountCad: 40000, estimated: false, netBasis: true } };
  await open(payload({ slices: [slice("stocks", "Stocks", 100000, 100000 / 60000)], home: home as never }));
  expect(screen.getByText(/^Shares of net value after a margin debit of \$40,000\.00 \(the brokerage total\), so they can add up to over 100%$/)).toBeInTheDocument();
  expect(listItems()[0]).toContain("167%");
  expect(document.querySelector("[data-slice='stocks']")!.getAttribute("aria-label")).toBe("Stocks 166.7%");
});
