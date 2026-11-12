import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { OVERALL_MISSING } from "./headlines";
import { LIST_LIMIT, ReportCard } from "./ReportCard";
import { call, card, emptyCard, OVERALL } from "./test-fixture";
import { TAP_HINT } from "./visual";

function fakeBridge(next: unknown = card()) {
  let listener: (r: ToolResult) => void = () => {};
  const bridge: Bridge = {
    ready: Promise.resolve({ hostTools: true, context: {} }),
    onToolResult: (fn) => { listener = fn; return () => {}; },
    onContext: () => () => {}, toolArguments: () => ({}), openLink: async () => true,
    callTool: vi.fn(async () => ({ structuredContent: next })), sendMessage: vi.fn(async () => {}), updateModelContext: vi.fn(async () => {}), destroy: () => {},
  };
  return { bridge, push: (p: unknown) => listener({ structuredContent: p }) };
}
async function open(p: unknown) {
  const f = fakeBridge();
  render(<ReportCard bridge={f.bridge} />);
  expect(screen.getByText("Crunching your trades. The first time takes about 20 seconds.")).toBeInTheDocument();
  act(() => f.push(p));
  await screen.findByRole("region", { name: "Investing report card" });
  return f;
}
const section = (name: string) => screen.getByRole("region", { name });
const bars = (name: string) => within(screen.getByRole("list", { name })).getAllByRole("button");
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ADVICE = /\b(should|consider|mistakes?|bad calls?|better off|recommend\w*|regret\w*|wrong)\b/i;

test("four sections in order: a race against the S&P 500, then counts and charts", async () => {
  await open(card({ overall: OVERALL }));
  expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["2026 so far", "Your holdings against the market", "After you sold", "What trading cost you"]);
  const overall = section("2026 so far");
  expect(within(overall).getByRole("img", { name: "You +8.4%, S&P 500 +12.1%" })).toBeInTheDocument();
  expect(within(overall).getByText("3.7 points behind the S&P 500 (est.)")).toBeInTheDocument();
  const calls = section("Your holdings against the market");
  expect(within(calls).getByText("3 of 4")).toBeInTheDocument();
  expect(within(calls).getByText("came out ahead of the S&P 500")).toBeInTheDocument();
  expect(within(calls).getByRole("img", { name: "3 ahead, 1 behind" })).toBeInTheDocument();
  expect(within(section("After you sold")).getByText("1 of 2")).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(ADVICE);
  expect(document.querySelector(".w-brand")).toHaveTextContent("VestLens Read-only.");
});

test("tapping a bar shows its full line; tapping again goes back to the hint", async () => {
  await open(card());
  const calls = section("Your holdings against the market");
  const rows = bars("Holdings against the S&P 500");
  expect(rows.map((r) => r.querySelector(".rc-fig")!.textContent)).toEqual(["Ahead", "+12.5 pts", "+2.0 pts", "-15.0 pts"]);
  expect(within(calls).getByText(TAP_HINT)).toBeInTheDocument();
  fireEvent.click(rows[2]!);
  expect(rows[2]).toHaveAttribute("aria-pressed", "true");
  expect(within(calls).getByText("CCC: +7.0% from 2 January 2025 to 22 October 2026; +2.0 points against the S&P 500, +3.0 points against the TSX (est., Bank of Canada rate 2026-10-22)")).toBeInTheDocument();
  fireEvent.click(rows[2]!);
  expect(within(calls).getByText(TAP_HINT)).toBeInTheDocument();
});

test("the TSX switch redraws the count and the chart from the TSX figures", async () => {
  await open(card());
  const calls = section("Your holdings against the market");
  fireEvent.click(within(calls).getByRole("radio", { name: "TSX" }));
  expect(within(calls).getByText("2 of 3")).toBeInTheDocument();
  expect(within(calls).getByText("came out ahead of the TSX")).toBeInTheDocument();
  expect(bars("Holdings against the TSX").map((r) => r.querySelector(".rc-fig")!.textContent)).toEqual(["+13.5 pts", "+3.0 pts", "-14.0 pts", "No figure"]);
  // BBB is behind the S&P 500 by 15 and the TSX by 14: still behind. The fixture's TSX figures are S&P + 1.
  expect(within(calls).getByRole("img", { name: "2 ahead, 1 behind" })).toBeInTheDocument();
});

test("after you sold: each sale's line on tap, kept vs sold with est. and native amounts", async () => {
  await open(card());
  const sold = section("After you sold");
  expect(within(sold).getByText("Kept vs sold, all together: +$115 (est., Bank of Canada rate 2026-10-22; includes US$100).")).toBeInTheDocument();
  const rows = bars("Sales against the latest close");
  expect(rows.map((r) => r.querySelector(".rc-fig")!.textContent)).toEqual(["+10.0%", "-25.0%"]);
  fireEvent.click(rows[0]!);
  expect(within(sold).getByText(/^USX, sold 1 April 2026 at US\$100 \(est\., Bank of Canada rate 2026-04-01; \$135 as recorded\) \(10 shares\).*kept vs sold \+\$135 \(est\., BoC 2026-10-22; US\$100\)$/)).toBeInTheDocument();
});

test("what trading cost you: two tiles, the per-$100 meter and the Bank of Canada dates", async () => {
  await open(card());
  const cost = section("What trading cost you");
  expect(within(cost).getByText("about $300")).toBeInTheDocument();
  expect(within(cost).getByText("$8.70")).toBeInTheDocument();
  expect(within(cost).getByText("3 fees (est., Bank of Canada rate 2026-03-02; includes US$2)")).toBeInTheDocument();
  expect(within(cost).getByRole("img", { name: "Every $100 converted cost about $1.11 against the Bank of Canada rate" })).toBeInTheDocument();
  expect(within(cost).getByText(/^Estimated over 20 trades against each day's close, Bank of Canada rates from 2 January 2025 to 5 January 2026; single trades are noisy\. You converted about \$27,000 between CAD and USD on trades\. In your stored activity since 2 January 2025\.$/)).toBeInTheDocument();
});

test("couldn't tell is collapsed to a count and opens to the reasons, with short symbols", async () => {
  const base = card();
  await open({ ...base, calls: { ...base.calls, cantTell: { count: 1, reasons: [{ reason: "no price history for this symbol", count: 1, symbols: ["XEQT.TO"] }] } } });
  const calls = section("Your holdings against the market");
  const toggle = within(calls).getByRole("button", { name: "Couldn't tell for 1" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(within(calls).getByText("1: no price history for this symbol (XEQT)")).toBeInTheDocument();
  const cost = section("What trading cost you");
  fireEvent.click(within(cost).getByRole("button", { name: "Left out of the cost estimate: 1" }));
  expect(within(cost).getByText("1: no closing price within 3 days of the trade (GAP)")).toBeInTheDocument();
});

test("each section's title has an info icon that opens how it is worked out", async () => {
  await open(card());
  const cost = section("What trading cost you");
  fireEvent.click(within(cost).getByRole("button", { name: 'How "What trading cost you" is worked out' }));
  expect(within(cost).getByRole("dialog")).toHaveTextContent(/Single trades are noisy/);
  expect(screen.getAllByRole("button", { name: /^How ".*" is worked out$/ })).toHaveLength(4);
  expect(screen.getByText(/^As of 23 October 2026\. From your stored activity/)).toBeInTheDocument();
});

test("per year since the history began, when there is a year or more", async () => {
  await open(card({ overall: { ...OVERALL, sinceStart: { from: "2023-01-02", to: "2026-10-22", years: 3.8, cagrPct: 11.2, sp500CagrPct: 9.3, estimated: true } } }));
  const overall = section("2026 so far");
  expect(within(overall).getByText("Per year since January 2023")).toBeInTheDocument();
  expect(within(overall).getByRole("img", { name: "Per year since January 2023: you +11.2%, S&P 500 +9.3%" })).toBeInTheDocument();
  expect(within(overall).getByText("A year, over 3.8 years (est.)")).toBeInTheDocument();
});

test("hide amounts blurs money, prices and share counts; percentages and counts stay", async () => {
  await open(card());
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  fireEvent.click(bars("Sales against the latest close")[0]!);
  // The per-$100 rate is a rate, not an amount the person holds or paid, so it stays.
  const shell = screen.getByRole("region", { name: "Investing report card" }).cloneNode(true) as HTMLElement;
  shell.querySelector("style")!.remove();
  const text = shell.textContent!.replace("Every $100 converted cost about $1.11 against the Bank of Canada rate", "");
  expect(text).not.toMatch(/\$\d|US\$|10 shares/);
  expect(screen.getAllByRole("img", { name: "Hidden amount" }).length).toBeGreaterThan(5);
  expect(text).toContain("+10.0%");
  expect(text).toContain("3 of 4");
  fireEvent.click(screen.getByRole("button", { name: "Show amounts" }));
  expect(document.body.textContent).toContain("about $300");
});

test("empty: each section says so plainly, no charts and no share card", async () => {
  await open(emptyCard());
  expect(within(section("2026 so far")).getByText(OVERALL_MISSING)).toBeInTheDocument();
  expect(screen.getByText("None of your holdings could be compared with the S&P 500 yet")).toBeInTheDocument();
  expect(screen.getByText("No sales could be compared with the latest price yet")).toBeInTheDocument();
  expect(screen.getByText("No trades between CAD and USD found")).toBeInTheDocument();
  expect(screen.getByText("No fees recorded")).toBeInTheDocument();
  expect(screen.queryAllByRole("list")).toHaveLength(0);
  expect(screen.queryByRole("button", { name: /Couldn't tell/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Share card" })).toBeNull();
  expect(document.body.textContent).not.toMatch(ADVICE);
});

test(`shows the first ${LIST_LIMIT} holdings, then all on request`, async () => {
  const items = Array.from({ length: 10 }, (_, i) => call(`S${String(i).padStart(2, "0")}`, 10 - i));
  const base = card();
  await open({ ...base, calls: { ...base.calls, items, summary: { ...base.calls.summary, aheadUnmeasured: [] } } });
  expect(bars("Holdings against the S&P 500")).toHaveLength(LIST_LIMIT);
  fireEvent.click(screen.getByRole("button", { name: "Show all 10" }));
  expect(bars("Holdings against the S&P 500")).toHaveLength(10);
});

test("the share card: percentages and counts only, made only on request", async () => {
  await open(card({ overall: OVERALL }));
  expect(screen.queryByRole("region", { name: "Share card" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Share card" }));
  const share = section("Share card");
  expect(within(share).getByText("My 2026 investing")).toBeInTheDocument();
  expect(within(share).getByText("+8.4%")).toBeInTheDocument();
  expect(within(share).getByText("3/4")).toBeInTheDocument();
  expect(share.textContent).not.toMatch(/\$\d|AAA|BBB|CCC|USX|DWN|WIN/);
});

test("copy text falls back to a selectable box when the clipboard is blocked", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => { throw new Error("blocked"); }) } });
  await open(card({ overall: OVERALL }));
  fireEvent.click(screen.getByRole("button", { name: "Share card" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy text" })); });
  expect(await screen.findByText("Copying isn't allowed here. Select the text and copy it.")).toBeInTheDocument();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toMatch(/^My 2026 investing, so far:\n\+8\.4% vs S&P 500 total return \+12\.1%\n3\/4 holdings ahead of the S&P 500 total return\n1\.11% conversion cost \(est\.\)\nEstimates from my own trades/);
});

test("copy text says Copied when the clipboard takes it", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await open(card());
  fireEvent.click(screen.getByRole("button", { name: "Share card" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy text" })); });
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining("3/4 holdings ahead of the S&P 500 total return"));
  expect(await screen.findByRole("status")).toHaveTextContent("Copied");
});

test("no save image: hosts block downloads, so the card is for a screenshot", async () => {
  await open(card());
  fireEvent.click(screen.getByRole("button", { name: "Share card" }));
  expect(screen.queryByRole("button", { name: "Save image" })).toBeNull();
  expect(screen.getByText("Percentages only: no dollar amounts or tickers. Take a screenshot to share it.")).toBeInTheDocument();
});

test("a result that isn't a report card is a calm failure with Try again, which re-calls show_report_card", async () => {
  const f = fakeBridge();
  render(<ReportCard bridge={f.bridge} />);
  act(() => f.push({ limits: [] }));
  expect(await screen.findByText("Report card unavailable right now")).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
  expect(f.bridge.callTool).toHaveBeenCalledWith("show_report_card", {});
  expect(await screen.findByRole("region", { name: "Investing report card" })).toBeInTheDocument();
});
