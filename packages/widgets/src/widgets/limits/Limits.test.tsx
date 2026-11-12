import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { Limits } from "./Limits";

function fakeBridge() {
  let listener: (r: ToolResult) => void = () => {};
  const bridge: Bridge = {
    ready: Promise.resolve({ hostTools: true, context: {} }),
    onToolResult: (fn) => { listener = fn; return () => {}; },
    onContext: () => () => {}, toolArguments: () => ({}), openLink: async () => true,
    callTool: vi.fn(async () => ({ structuredContent: payload() })), sendMessage: vi.fn(async () => {}), updateModelContext: vi.fn(async () => {}), destroy: () => {},
  };
  return { bridge, push: (p: unknown) => listener({ structuredContent: p }) };
}
const PORTFOLIO = "Share of your portfolio, cash included";
const row = (over: Record<string, unknown> = {}) => ({
  slug: "single-holding-shop-to", label: "SHOP.TO", kind: "single_holding", maxPct: 10, currentPct: 12.5, status: "over",
  line: "SHOP.TO 12.5% (est.), over your 10% limit", note: PORTFOLIO, ...over,
});
const group = (over: Record<string, unknown> = {}, rows: unknown[] = [row()]) => ({
  slug: "single-holding-shop-to", kind: "single_holding", target: "SHOP.TO", maxPct: 10, label: "SHOP.TO", rows, ...over,
});
const payload = (limits: unknown[] = [group()]) => ({ limits });
async function open(p: unknown) {
  const f = fakeBridge();
  render(<Limits bridge={f.bridge} />);
  expect(screen.getByText(/loading/i)).toBeInTheDocument();
  act(() => f.push(p));
  await screen.findByRole("region", { name: "Portfolio limits" });
  return f;
}
afterEach(cleanup);

test("one row per limit with the verbatim line, a Over label, the basis sentence and a bar", async () => {
  await open(payload());
  expect(screen.getByText("10% limit on SHOP.TO")).toBeInTheDocument();
  expect(screen.getByText("SHOP.TO 12.5% (est.), over your 10% limit")).toBeInTheDocument();
  expect(screen.getByText("Over")).toBeInTheDocument();
  expect(screen.getByText("of your portfolio, cash included")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "SHOP.TO is 12.5% against a 10% limit" })).toBeInTheDocument();
});

test("within and can't tell labels; no bar when there is no number", async () => {
  await open(payload([
    group({ slug: "a", label: "TD.TO", maxPct: 15 }, [row({ slug: "a", label: "TD.TO", maxPct: 15, currentPct: 4, status: "within", line: "TD.TO 4% (est.) of your 15% limit" })]),
    group({ slug: "b", label: "XYZ", maxPct: 20 }, [row({ slug: "b", label: "XYZ", maxPct: 20, currentPct: null, status: "cant_tell", line: "XYZ: can't tell against your 20% limit", note: `${PORTFOLIO}; latest positions date is unknown` })]),
  ]));
  expect(screen.getByText("Within")).toBeInTheDocument();
  expect(screen.getByText("Can't tell")).toBeInTheDocument();
  expect(screen.getAllByRole("img")).toHaveLength(1);
  expect(screen.getByText("Latest positions date is unknown.")).toBeInTheDocument();
});

test("a company's listing rows are a breakdown: no status, no bar, under the combined row (A5)", async () => {
  await open(payload([group({}, [
    row({ label: "SHOP (all listings)", currentPct: 12, line: "SHOP (all listings) 12% (est.), over your 10% limit" }),
    row({ label: "SHOP (CAD)", currentPct: 6, informational: true, line: "SHOP (CAD) 6% (est.), counted in SHOP (all listings)" }),
    row({ label: "SHOP (USD)", currentPct: 6, informational: true, line: "SHOP (USD) 6% (est.), counted in SHOP (all listings)" }),
  ])]));
  expect(screen.getAllByText("Over")).toHaveLength(1);
  expect(screen.getAllByRole("img")).toHaveLength(1);
  expect(screen.getByText("SHOP (CAD) 6% (est.), counted in SHOP (all listings)")).toBeInTheDocument();
});

test("a subset limit says the chosen accounts", async () => {
  await open(payload([group({}, [row({ note: "Share of the chosen accounts, cash included" })])]));
  expect(screen.getByText("of the chosen accounts, cash included")).toBeInTheDocument();
  expect(screen.queryByText("of your portfolio, cash included")).toBeNull();
});

test("a limit that gives several rows keeps them in one group, in order", async () => {
  await open(payload([group({ slug: "any", target: null, label: "any single holding" }, [
    row({ slug: "any", label: "AAA", line: "AAA 20% (est.), over your 10% limit", currentPct: 20 }),
    row({ slug: "any", label: "BBB", line: "BBB 11% (est.), over your 10% limit", currentPct: 11 }),
  ])]));
  const groupEl = screen.getByRole("group", { name: "10% limit on any single holding" });
  const lines = within(groupEl).getAllByText(/over your 10% limit/).map((e) => e.textContent);
  expect(lines).toEqual(["AAA 20% (est.), over your 10% limit", "BBB 11% (est.), over your 10% limit"]);
});

test("the unclassified note shows when present", async () => {
  await open(payload([group({ kind: "sector", label: "Technology", slug: "s" }, [row({
    slug: "s", label: "Technology", kind: "sector", currentPct: 18, unclassifiedPct: 6, status: "cant_tell",
    line: "Technology 18% (est.) classified, 6% unclassified: can't tell against your 10% limit",
    note: `${PORTFOLIO}; 6% is not in any sector (no sector data): FUND1, FUND2`,
  })])]));
  expect(screen.getByText("6% is not in any sector (no sector data): FUND1, FUND2.")).toBeInTheDocument();
});

test("a converted figure shows the Bank of Canada rate date note", async () => {
  await open(payload([group({}, [row({ fxDate: "2026-10-22", line: "SHOP 14% (est.), over your 10% limit", note: `${PORTFOLIO}; USD converted at the Bank of Canada rate of 2026-10-22` })])]));
  expect(screen.getByText("SHOP 14% (est.), over your 10% limit")).toBeInTheDocument();
  expect(screen.getByText("USD converted at the Bank of Canada rate of 2026-10-22.")).toBeInTheDocument();
});

test.each([
  ["a group with no rows array", { limits: [{ slug: "a", label: "A", maxPct: 10 }] }],
  ["a row with no line", { limits: [group({}, [{ status: "over", currentPct: 1, maxPct: 10, label: "A" }])] }],
  ["a row with an unknown status", { limits: [group({}, [row({ status: "maybe" })])] }],
  ["a null group", { limits: [null] }],
])("%s shows the calm message", async (_name, p) => {
  const f = fakeBridge();
  render(<Limits bridge={f.bridge} />);
  act(() => f.push(p));
  expect(await screen.findByText("Limits unavailable right now")).toBeInTheDocument();
});

test("no limits: a plain line", async () => {
  await open(payload([]));
  expect(screen.getByText("No limits are saved yet.")).toBeInTheDocument();
});

test("every string renders as text", async () => {
  await open(payload([group({ label: "<b>x</b> [a](b)" }, [row({ line: "<b>x</b> [a](b) 12%", note: `${PORTFOLIO}; <i>n</i>` })])]));
  expect(screen.getAllByText(/<b>x<\/b> \[a\]\(b\)/).length).toBeGreaterThan(0);
  expect(screen.getByText("<i>n</i>.")).toBeInTheDocument();
  expect(document.querySelector("a")).toBeNull();
  expect(document.querySelectorAll("b:not(.w-brand b), i").length).toBe(0);
});

test("no advice words", async () => {
  await open(payload());
  expect(document.body.textContent).not.toMatch(/\b(should|buy|sell|recommend)\b/i);
});

test("phone width: wraps long text, no fixed widths", async () => {
  await open(payload());
  const css = document.querySelector("style")!.textContent!;
  expect(css).toMatch(/overflow-wrap:anywhere/);
  expect(css).not.toMatch(/(^|[;{\s])(min-)?width:\s*\d{3,}px/);
});

test("a malformed result shows a calm message", async () => {
  const f = fakeBridge();
  render(<Limits bridge={f.bridge} />);
  act(() => f.push({ limits: "no" }));
  expect(await screen.findByText("Limits unavailable right now")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("region", { name: "Portfolio limits" });
});
