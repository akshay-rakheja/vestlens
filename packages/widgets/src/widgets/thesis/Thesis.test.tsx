import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { Thesis } from "./Thesis";

function fakeBridge() {
  let listener: (r: ToolResult) => void = () => {};
  const openLink = vi.fn(async () => true);
  const bridge: Bridge = {
    ready: Promise.resolve({ hostTools: true, context: {} }),
    onToolResult: (fn) => { listener = fn; return () => {}; },
    onContext: () => () => {}, toolArguments: () => ({}), openLink,
    callTool: vi.fn(async () => ({ structuredContent: one() })), sendMessage: vi.fn(async () => {}), updateModelContext: vi.fn(async () => {}), destroy: () => {},
  };
  return { bridge, openLink, push: (p: unknown) => listener({ structuredContent: p }) };
}

const playedOut = (over: Record<string, unknown> = {}) => ({
  returnPct: 12.34, vsSp500Pct: 3.3, vsTsxPct: -1.1, estimated: false, excluded: [], startDate: "2026-01-05", endDate: "2026-10-23",
  notes: ["Benchmarks are price indices (dividends not included); your holding's dividends are counted."], ...over,
});
const check = (over: Record<string, unknown> = {}) => ({
  ticker: "SHOP.TO", writtenAt: "2026-01-05T15:00:00.000Z", timeFrame: { label: "9 months into a 3-year thesis", ended: false },
  conditions: [
    { id: "c1", text: "Price stays above $100", kind: "price_above", status: "held", evidence: { value: "$140", asOf: "2026-10-23" } },
    { id: "c2", text: "Weight under 20%", kind: "weight_above", status: "broken", evidence: { value: "24%", asOf: "2026-10-23" } },
    { id: "c3", text: "Margins improve", kind: "fundamental", status: "cant_tell", note: "can't check automatically yet" },
  ],
  news: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ title: `Headline ${n}`, source: "Wire", publishedAt: `2026-10-0${n}T12:00:00.000Z`, tone: n === 1 ? "news tone: positive" : null })),
  earnings: [{ date: "2026-11-05" }, { date: "2027-02-12" }],
  playedOut: playedOut(), ...over,
});
const one = (over: Record<string, unknown> = {}, c: Record<string, unknown> = {}) => ({
  mode: "one", ticker: "SHOP.TO", thesis: { reasons: "I like the growth.", boughtAround: "2026-01-05", history: [], check: check(c), ...over },
});
async function open(p: unknown) {
  const f = fakeBridge();
  render(<Thesis bridge={f.bridge} />);
  expect(screen.getByText("Loading your holding…")).toBeInTheDocument();
  act(() => f.push(p));
  await screen.findByRole("region", { name: "Holding check" });
  return f;
}
afterEach(cleanup);

test("sections come in order: reasons, time frame, conditions, news, earnings, played out", async () => {
  await open(one());
  const text = document.body.textContent!;
  const order = ["I like the growth.", "9 months into a 3-year thesis", "Price stays above $100", "Headline 1", "2026-11-05", "How it played out"].map((s) => text.indexOf(s));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

test("conditions show a status word chip with evidence and note", async () => {
  await open(one());
  const list = screen.getByRole("list", { name: "Conditions" });
  const items = within(list).getAllByRole("listitem");
  expect(items).toHaveLength(3);
  expect(items[0]!.textContent).toMatch(/Held/);
  expect(items[0]!.textContent).toMatch(/\$140, 2026-10-23/);
  expect(items[1]!.textContent).toMatch(/Broken/);
  expect(items[2]!.textContent).toMatch(/Can't tell/);
  expect(items[2]!.textContent).toMatch(/can't check automatically yet/);
});

test("time frame ended is shown verbatim", async () => {
  await open(one({}, { timeFrame: { label: "time frame ended", ended: true } }));
  expect(screen.getByText("time frame ended")).toBeInTheDocument();
});

test("no time frame is said plainly", async () => {
  await open(one({}, { timeFrame: null }));
  expect(screen.getByText("No time frame")).toBeInTheDocument();
});

test("at most 5 news items; a link opens through the bridge", async () => {
  const f = await open(one({}, { news: Array.from({ length: 7 }, (_, i) => ({ title: `Headline ${i + 1}`, source: "Wire", publishedAt: "2026-10-01T12:00:00.000Z", tone: null, url: i === 0 ? "https://example.com/a" : undefined })) }));
  const list = screen.getByRole("list", { name: "News since you wrote it" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(5);
  expect(screen.queryByText(/Headline 6/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Headline 1" }));
  expect(f.openLink).toHaveBeenCalledWith("https://example.com/a");
  expect(screen.queryByRole("button", { name: "Headline 2" })).toBeNull();
});

test.each(["http://example.com/a", "data:text/html,<b>x</b>", "javascript:alert(1)", "//example.com/a", "HTTPS-not-a-url"])("url %s is never opened", async (url) => {
  const f = await open(one({}, { news: [{ title: "Bad", source: "Wire", publishedAt: "2026-10-01T12:00:00.000Z", tone: null, url }] }));
  expect(screen.queryByRole("button", { name: "Bad" })).toBeNull();
  expect(screen.getByText("Bad")).toBeInTheDocument();
  expect(f.openLink).not.toHaveBeenCalled();
});

test("the https check ignores case", async () => {
  const f = await open(one({}, { news: [{ title: "Upper", source: "Wire", publishedAt: "2026-10-01T12:00:00.000Z", tone: null, url: "HTTPS://Example.com/A" }] }));
  fireEvent.click(screen.getByRole("button", { name: "Upper" }));
  expect(f.openLink).toHaveBeenCalledWith("HTTPS://Example.com/A");
});

test("a non-https url is not opened", async () => {
  await open(one({}, { news: [{ title: "Bad", source: "Wire", publishedAt: "2026-10-01T12:00:00.000Z", tone: null, url: "javascript:alert(1)" }] }));
  expect(screen.queryByRole("button", { name: "Bad" })).toBeNull();
  expect(screen.getByText(/Bad/)).toBeInTheDocument();
});

test("earnings dates are listed", async () => {
  await open(one());
  expect(screen.getByText(/Earnings reports/)).toBeInTheDocument();
  expect(screen.getByText(/2026-11-05/)).toBeInTheDocument();
  expect(screen.getByText(/2027-02-12/)).toBeInTheDocument();
});

test("played out compares you, the S&P 500 and the TSX, with the basis note", async () => {
  await open(one());
  const row = screen.getByRole("group", { name: "How it played out" });
  expect(row.textContent).toMatch(/You\s*12\.3%/);
  expect(row.textContent).toMatch(/S&P 500\s*9\.0%/);
  expect(row.textContent).toMatch(/\+3\.3 pts/);
  expect(row.textContent).toMatch(/TSX\s*13\.4%/);
  expect(row.textContent).toMatch(/-1\.1 pts/);
  expect(row.textContent).toMatch(/2026-01-05 to 2026-10-23/);
  expect(screen.getByText(/Benchmarks are price indices/)).toBeInTheDocument();
});

test("shadow exhausted and left-out notes render; the excluded list shows can't compare", async () => {
  await open(one({}, { playedOut: playedOut({
    vsSp500Pct: null, estimated: true, excluded: ["can't compare: no purchase date"],
    notes: ["Benchmarks are price indices (dividends not included); your holding's dividends are counted.", "Your sales took out more than the same money in the S&P 500 would have been worth.", "The comparison covers the rest of your activity; the items listed are left out."],
  }) }));
  expect(screen.getByText(/Your sales took out more than the same money in the S&P 500/)).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "Left out of the comparison" }).textContent).toContain("can't compare: no purchase date");
  expect(screen.getByRole("group", { name: "How it played out" }).textContent).toMatch(/est\./);
  expect(screen.queryByText(/S&P 500\s*\d/)).toBeNull();
});

test("no return: the reason shows, never a number", async () => {
  await open(one({}, { playedOut: playedOut({ returnPct: null, vsSp500Pct: null, vsTsxPct: null, startDate: null, endDate: null, reason: "can't tell: no value found for this holding when you wrote it", excluded: ["can't compare: no purchase date"], notes: [] }) }));
  expect(screen.getByText("can't tell: no value found for this holding when you wrote it")).toBeInTheDocument();
  expect(screen.getByText("can't compare: no purchase date")).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "How it played out" }).textContent).not.toMatch(/\d%/);
});

test("without a ticker, a list with condition counts", async () => {
  await open({ mode: "list", theses: [
    { ticker: "SHOP.TO", reasons: "Growth", writtenAt: "2026-01-05T15:00:00.000Z", timeFrame: { label: "time frame ended", ended: true }, conditions: check().conditions },
    { ticker: "XEQT.TO", reasons: "Core holding", writtenAt: "2026-02-01T15:00:00.000Z", timeFrame: null, conditions: [] },
  ] });
  const items = within(screen.getByRole("list", { name: "Saved theses" })).getAllByRole("listitem");
  expect(items).toHaveLength(2);
  expect(items[0]!.textContent).toMatch(/SHOP\.TO/);
  expect(items[0]!.textContent).toMatch(/1 held/);
  expect(items[0]!.textContent).toMatch(/1 broken/);
  expect(items[0]!.textContent).toMatch(/1 can't tell/);
  expect(items[1]!.textContent).toMatch(/No conditions/);
});

test("empty states are plain", async () => {
  await open({ mode: "list", theses: [] });
  expect(screen.getByText("No theses are saved yet.")).toBeInTheDocument();
  cleanup();
  await open({ mode: "one", ticker: "SHOP.TO", thesis: null, holding: null });
  expect(screen.getByText("You don't hold SHOP.TO in a connected account.")).toBeInTheDocument();
});

const holding = (over: Record<string, unknown> = {}) => ({
  sinceFirstBought: playedOut({ startDate: "2025-01-02", estimated: true, notes: ["Money-weighted from your first purchase: each purchase, sale and dividend counts from its own date.", "USD amounts converted at the Bank of Canada rate of each date (est.); latest rate 2026-10-22."] }),
  weight: { pct: 40, estimated: true, asOf: "2026-10-22" },
  limits: [{ label: "SHOP.TO", status: "over", currentPct: 40, line: "SHOP.TO 40% (est.), over your 10% limit", text: "SHOP.TO 40% (est.), over your 10% limit. (of your portfolio, cash included)" }],
  news: [{ title: "Recent headline", source: "Wire", publishedAt: "2026-10-20T12:00:00.000Z", tone: null, url: "https://example.com/r" }],
  newsLabel: "News in the last 30 days",
  noReasons: "No reasons saved for this holding.",
  ...over,
});
const holdingOnly = (over: Record<string, unknown> = {}) => ({ mode: "one", ticker: "SHOP.TO", thesis: null, holding: holding(over) });

test("no thesis: the holding view shows since first bought, weight, limits, news and the no-reasons line, in order", async () => {
  const f = await open(holdingOnly());
  const row = screen.getByRole("group", { name: "Since your first recorded purchase" });
  expect(row.textContent).toMatch(/Since your first recorded purchase \(2025-01-02\) to 2026-10-23, est\./);
  expect(row.textContent).toMatch(/You\s*12\.3%/);
  expect(row.textContent).toMatch(/\+3\.3 pts/);
  expect(screen.getByText(/USD amounts converted at the Bank of Canada rate/)).toBeInTheDocument();
  expect(screen.getByText("40.0% (est.), cash included, as of 2026-10-22")).toBeInTheDocument();
  expect(within(screen.getByRole("list", { name: "Your limits on it" })).getByText(/over your 10% limit/)).toBeInTheDocument();
  expect(within(screen.getByRole("list", { name: "News in the last 30 days" })).getAllByRole("listitem")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Recent headline" }));
  expect(f.openLink).toHaveBeenCalledWith("https://example.com/r");
  expect(screen.getByText("No reasons saved for this holding.")).toBeInTheDocument();
  expect(screen.queryByText("Your reasons")).toBeNull();
  const text = document.body.textContent!;
  const order = ["Since your first recorded purchase", "Share of your portfolio", "Your limits", "News in the last 30 days", "No reasons saved"].map((s) => text.indexOf(s));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(document.body.textContent).not.toMatch(/\b(should|buy|sell|recommend|consider)\b/i);
});

test("holding view: can't tell shows the reason and no number; no weight shows its reason; no news is said plainly", async () => {
  await open(holdingOnly({
    sinceFirstBought: playedOut({ returnPct: null, vsSp500Pct: null, vsTsxPct: null, startDate: null, endDate: null, notes: [], reason: "can't tell: stored activity doesn't reach back to your first purchase" }),
    weight: null, weightNote: "latest positions are more than 3 trading days old", limits: [], news: [],
  }));
  const row = screen.getByRole("group", { name: "Since your first recorded purchase" });
  expect(row.textContent).toContain("can't tell: stored activity doesn't reach back to your first purchase");
  expect(row.textContent).not.toMatch(/\d%/);
  expect(screen.getByText("can't tell: latest positions are more than 3 trading days old")).toBeInTheDocument();
  expect(screen.queryByRole("list", { name: "Your limits on it" })).toBeNull();
  expect(screen.getByText("No news found in the last 30 days.")).toBeInTheDocument();
});

test("a thesis comes with the holding view: since the first recorded purchase, weight, limits and one news list", async () => {
  const { noReasons: _n, ...h } = holding({ sinceFirstBought: playedOut({ startDate: "2025-01-02", returnPct: 20 }), newsLabel: "News since you wrote it" });
  await open({ ...one(), holding: h });
  expect(screen.getByRole("group", { name: "How it played out" })).toBeInTheDocument();
  const since = screen.getByRole("group", { name: "Since your first recorded purchase" });
  expect(since.textContent).toMatch(/You\s*20\.0%/);
  const text = document.body.textContent!;
  expect(text.indexOf("How it played out")).toBeLessThan(text.indexOf("Since your first recorded purchase"));
  expect(screen.getByText("40.0% (est.), cash included, as of 2026-10-22")).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "Your limits on it" })).toBeInTheDocument();
  // One news list: the holding view's (the thesis's own is not repeated).
  expect(screen.getAllByRole("list", { name: /^News/ })).toHaveLength(1);
  expect(within(screen.getByRole("list", { name: "News since you wrote it" })).getByText("Recent headline")).toBeInTheDocument();
  expect(screen.queryByText("Headline 1")).toBeNull();
  // The price-index note prints once, not under both comparisons (M-4).
  expect(screen.getAllByText(/Benchmarks are price indices/)).toHaveLength(1);
  expect(screen.queryByText("No reasons saved for this holding.")).toBeNull();
});

test("an older thesis result with only the since row still renders, with its own news", async () => {
  await open({ ...one(), holding: { sinceFirstBought: playedOut({ startDate: "2025-01-02", returnPct: 20 }) } });
  expect(screen.getByRole("group", { name: "Since your first recorded purchase" })).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "News since you wrote it" })).toBeInTheDocument();
});

test("holding view text renders literally", async () => {
  await open(holdingOnly({
    limits: [{ label: "<b>L</b>", status: "within", currentPct: 1, line: "<b>L</b> 1%", text: "<b>L</b> [x](y)" }],
    news: [{ title: "<i>t</i> [a](b)", source: "<s>S</s>", publishedAt: "2026-10-20T12:00:00.000Z", tone: null }],
  }));
  expect(screen.getByText("<b>L</b> [x](y)")).toBeInTheDocument();
  expect(screen.getByText("<i>t</i> [a](b)")).toBeInTheDocument();
  expect(document.querySelector("a")).toBeNull();
  expect(document.querySelectorAll("b:not(.w-brand b), i, s").length).toBe(0);
});

test("every string renders as text: HTML and markdown stay literal", async () => {
  await open(one({ reasons: "<b>x</b> and [a](b)" }, {
    conditions: [{ id: "c", text: "<i>c</i> [l](u)", kind: "custom", status: "held", note: "<u>n</u>" }],
    news: [{ title: "<b>t</b> [a](b)", source: "<s>S</s>", publishedAt: "2026-10-01T12:00:00.000Z", tone: null }],
    playedOut: playedOut({ excluded: ["<em>e</em>"], notes: ["<b>note</b>"] }),
  }));
  for (const s of ["<b>x</b> and [a](b)", "<i>c</i> [l](u)", "<b>t</b> [a](b)", "<em>e</em>"]) expect(screen.getAllByText(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).length).toBeGreaterThan(0);
  expect(document.querySelector("a")).toBeNull();
  expect(document.querySelectorAll("b:not(.w-brand b), i, u, s, em").length).toBe(0);
});

test("no advice words", async () => {
  await open(one());
  expect(document.body.textContent).not.toMatch(/\b(should|buy|sell|recommend)\b/i);
});

test("phone width: styles wrap long text and add no fixed widths", async () => {
  await open(one());
  const css = document.querySelector("style")!.textContent!;
  expect(css).toMatch(/overflow-wrap:anywhere/);
  expect(css).not.toMatch(/(^|[;{\s])(min-)?width:\s*\d{3,}px/);
});

test.each([
  ["a list item with no conditions array", { mode: "list", theses: [{ ticker: "A", reasons: "r", writtenAt: "2026-01-01", timeFrame: null }] }],
  ["a list item that is not an object", { mode: "list", theses: [null] }],
  ["a condition with no status", { mode: "one", ticker: "A", thesis: { reasons: "r", boughtAround: null, check: { ...check(), conditions: [{ id: "c", text: "t" }] } } }],
  ["a news item with no title", { mode: "one", ticker: "A", thesis: { reasons: "r", boughtAround: null, check: { ...check(), news: [{ source: "s" }] } } }],
  ["a holding view with no sinceFirstBought", { mode: "one", ticker: "A", thesis: null, holding: { ...holding(), sinceFirstBought: null } }],
  ["a holding view limit with no text", { mode: "one", ticker: "A", thesis: null, holding: { ...holding(), limits: [{ status: "over" }] } }],
  ["a holding view weight that is not a number", { mode: "one", ticker: "A", thesis: null, holding: { ...holding(), weight: { pct: "40", asOf: "2026-10-22" } } }],
  ["a holding view weightNote that is not text", { mode: "one", ticker: "A", thesis: null, holding: { ...holding(), weight: null, weightNote: { x: 1 } } }],
  ["a holding view newsLabel that is not text", { mode: "one", ticker: "A", thesis: null, holding: { ...holding(), newsLabel: 3 } }],
])("%s shows the calm message", async (_name, payload) => {
  const f = fakeBridge();
  render(<Thesis bridge={f.bridge} />);
  act(() => f.push(payload));
  expect(await screen.findByText("Holding unavailable right now")).toBeInTheDocument();
});

test("a malformed result shows a calm message, not numbers", async () => {
  const f = fakeBridge();
  render(<Thesis bridge={f.bridge} />);
  act(() => f.push({ mode: "wrong" }));
  expect(await screen.findByText("Holding unavailable right now")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("region", { name: "Holding check" });
});
