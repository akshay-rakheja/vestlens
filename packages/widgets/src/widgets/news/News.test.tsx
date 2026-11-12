import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { News } from "./News";
import type { Mover, MoodView, NewsCard, NewsPayload } from "./types";

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const mood = (over: Partial<MoodView> = {}): MoodView => ({ level: "positive", value: 0.3, articles: 3, mostRecentAt: ago(2), estimated: true, lookThrough: false, lookThroughMissing: false, ...over });
const card = (over: Partial<NewsCard> = {}): NewsCard => ({
  articleId: "art-1", headline: "ZZTEST reports invented quarterly results", snippet: "Synthetic snippet.", source: "Example Wire",
  publishedAt: ago(3), imageUrl: "/api/news/image/art-1", url: "https://news.example.test/a1", symbols: ["ZZTEST"],
  tags: { eventType: "earnings_report", impactLevel: 2, mood: "positive", credible: true }, alsoReportedBy: [], via: null, ...over,
});
const mover = (over: Partial<Mover> = {}): Mover => ({
  symbol: "ZZTEST", currency: "CAD", returnFraction: 0.023, dollarMove: 123.45, estimated: false, flagged: true, limitedHistory: false,
  units: 37.5, marketValue: 5490.12, sessionDate: "2026-10-21", reason: { kind: "article", card: card(), via: null, lookThrough: false }, mood: mood(), ...over,
});
function payload(over: Partial<NewsPayload> = {}): NewsPayload {
  return {
    window: "7d", asOf: "2026-10-21T15:00:00Z", newsAsOf: ago(1), unfetched: 0, budgetExhausted: false,
    portfolioMood: { level: "positive", value: 0.31, spread: { positive: 3, negative: 2, neutral: 0, unknown: 1 } },
    movers: [
      mover(),
      mover({ symbol: "ZZALT", currency: "USD", returnFraction: -0.041, dollarMove: -88.2, estimated: true, limitedHistory: true, units: 12, marketValue: 900,
        reason: { kind: "no_clear_news", card: null, via: null, lookThrough: false }, mood: mood({ level: "not_enough_news", value: null, articles: 0, mostRecentAt: null }) }),
      mover({ symbol: "ZZETF", returnFraction: 0.019, dollarMove: 60, reason: { kind: "nothing_explains", card: null, via: null, lookThrough: false }, mood: mood({ level: "negative", value: -0.3 }) }),
    ],
    asUsual: 4, unpriced: 0,
    feed: [
      card({ alsoReportedBy: ["Other Daily", "Third Post"] }),
      card({ articleId: "art-2", headline: "ZZETF constituent invented update", url: "https://news.example.test/a2", imageUrl: null, symbols: ["ZZETF"], via: "ZZCON",
        tags: { eventType: null, impactLevel: 1, mood: "negative", credible: true } }),
    ],
    symbols: [
      { symbol: "ZZALT", mood: mood({ level: "not_enough_news", value: null, articles: 0, mostRecentAt: null }), sparkline: [] },
      { symbol: "ZZETF", mood: mood({ level: "negative", value: -0.3 }), sparkline: [10, 11, 10.5] },
      { symbol: "ZZTEST", mood: mood({ articles: 4 }), sparkline: [100, 101, 103, 102, 104] },
    ],
    accounts: [{ id: "acct-secret-1", label: "TFSA 2" }, { id: "acct-secret-2", label: "RRSP" }],
    filters: { window: "7d" }, settings: { benchmark: "sp500", cadView: false, privacyDefault: false },
    imageOrigin: "https://app.example.test", ...over,
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
  return { bridge, callTool, push: (p: NewsPayload) => listener({ structuredContent: p }) };
}
async function open(p = payload(), impl?: Impl) {
  const f = fakeBridge(impl);
  render(<News bridge={f.bridge} />);
  expect(screen.getByText(/loading your news/i)).toBeInTheDocument();
  act(() => f.push(p));
  await screen.findByRole("region", { name: /^(News tone|[A-Z.]+ news)$/ });
  return f;
}
const movers = () => screen.getByRole("region", { name: "Movers" });
const moverCard = (key: string) => movers().querySelector(`[data-mover="${key}"]`) as HTMLElement;
const feed = () => screen.getByRole("region", { name: "News feed" });
afterEach(() => { cleanup(); vi.useRealTimers(); });

test("1: header, mood strip with the large dial, spread sentence and caption", async () => {
  await open();
  expect(screen.getByText("Read-only")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "7d", checked: true })).toBeInTheDocument();
  const strip = within(screen.getByRole("region", { name: "News tone" }));
  const dial = strip.getByRole("img", { name: "News tone: Positive" });
  expect(dial).toHaveAttribute("data-size", "lg");
  // ratings summed over symbols (0 + 3 + 4); an article tied to two symbols counts twice, so it says ratings
  expect(dial).toHaveTextContent("based on 7 article ratings · most recent 2 h ago");
  expect(strip.getByText("Positive · 3 positive · 2 negative · 1 not enough news")).toBeInTheDocument();
  expect(strip.queryByText(/Mostly/)).toBeNull();
  expect(strip.getByText("The tone of recent headlines, not a view on the stocks · AI-rated, may be wrong")).toBeInTheDocument();
});

test("1b: a portfolio with not enough news says so and invents no neutral", async () => {
  await open(payload({ portfolioMood: { level: "not_enough_news", value: null, spread: { positive: 0, negative: 0, neutral: 0, unknown: 3 } } }));
  const strip = within(screen.getByRole("region", { name: "News tone" }));
  expect(strip.getByRole("img", { name: "News tone: Not enough news" })).toBeInTheDocument();
  expect(strip.getByText("Not enough news · 3 not enough news")).toBeInTheDocument();
  expect(strip.queryByText(/Neutral/)).toBeNull();
});

test("2: movers render in the given order with the three reason variants and mood chips", async () => {
  await open();
  const keys = [...movers().querySelectorAll("[data-mover]")].map((e) => e.getAttribute("data-mover"));
  expect(keys).toEqual(["ZZTEST|CAD", "ZZALT|USD", "ZZETF|CAD"]);
  const a = within(moverCard("ZZTEST|CAD"));
  expect(a.getByText("+$123.45 (+2.3%)")).toBeInTheDocument();
  expect(a.getByRole("link", { name: "ZZTEST reports invented quarterly results" })).toBeInTheDocument();
  expect(a.getByText(/Example Wire · 3 h ago/)).toBeInTheDocument();
  expect(a.queryByRole("button", { name: "Summarize" })).toBeNull();
  expect(a.getByText("Positive").closest("[data-mood]")).toHaveAttribute("data-mood", "positive");
  const b = within(moverCard("ZZALT|USD"));
  expect(b.getByText("−US$88.20 (−4.1%)")).toBeInTheDocument();
  expect(b.getByText("est.")).toBeInTheDocument();
  expect(b.getByText("limited history")).toBeInTheDocument();
  expect(b.getByText("Moved more than usual · no clear news")).toBeInTheDocument();
  expect(b.getByText("Not enough news")).toBeInTheDocument();
  const c = within(moverCard("ZZETF|CAD"));
  expect(c.getByText("News, but nothing that explains the move")).toBeInTheDocument();
  expect(c.queryByText("est.")).toBeNull();
  expect(within(movers()).getByText("Moved as usual (4 holdings)")).toBeInTheDocument();
  expect(within(movers()).queryByText(/without a usable price/)).toBeNull();
});

test("2a: a mover whose articles are not yet rated says so; unrated feed cards carry the chip", async () => {
  const p = payload();
  p.movers = [mover({ reason: { kind: "news_not_rated", card: null, via: null, lookThrough: false }, mood: mood({ level: "not_enough_news", value: null, articles: 0, mostRecentAt: null }) })];
  p.feed = [...p.feed, card({ articleId: "art-u", headline: "ZZTEST invented item awaiting rating", url: "https://news.example.test/au", tags: null })];
  await open(p);
  const m = within(moverCard("ZZTEST|CAD"));
  expect(m.getByText("News found, not yet rated")).toBeInTheDocument();
  expect(m.queryByText(/no clear news/)).toBeNull();
  const unrated = feed().querySelector('[data-article="art-u"]') as HTMLElement;
  expect(within(unrated).getByText("Not yet rated")).toBeInTheDocument();
});

test("2c: an ETF explained through look-through labels its mood and names the constituent in the compact reason", async () => {
  const p = payload();
  p.movers = [mover({ symbol: "ZZETF", reason: { kind: "article", card: card({ articleId: "art-2", headline: "ZZCON invented recall", symbols: ["ZZETF"], via: null }), via: "ZZCON", lookThrough: true },
    mood: mood({ level: "negative", value: -0.3, lookThrough: true }) })];
  p.symbols = [{ symbol: "ZZETF", mood: mood({ level: "negative", value: -0.3, lookThrough: true }), sparkline: [] }];
  await open(p);
  const m = within(moverCard("ZZETF|CAD"));
  expect(m.getByText("via ZZCON")).toBeInTheDocument();
  expect(m.getByText("from top holdings · est.")).toBeInTheDocument();
  fireEvent.click(m.getByRole("button", { name: /ZZETF/ }));
  expect(within(moverCard("ZZETF|CAD")).getAllByText("from top holdings · est.").length).toBeGreaterThanOrEqual(2);
});

test("2d: a fund without look-through data says so instead of a mood", async () => {
  const p = payload();
  p.movers = [mover({ symbol: "ZZFUND", reason: { kind: "no_clear_news", card: null, via: null, lookThrough: false },
    mood: mood({ level: "not_enough_news", value: null, articles: 0, mostRecentAt: null, lookThroughMissing: true }) })];
  await open(p);
  const m = within(moverCard("ZZFUND|CAD"));
  expect(m.getByText("No look-through data")).toBeInTheDocument();
  expect(m.queryByText("Not enough news")).toBeNull();
});

test("2b: a symbol held in two currencies gets a currency chip; unpriced holdings are counted", async () => {
  const p = payload({ unpriced: 2, asUsual: 1 });
  p.movers = [mover(), mover({ currency: "USD", dollarMove: 70 })];
  await open(p);
  expect(within(moverCard("ZZTEST|CAD")).getByText("CAD")).toBeInTheDocument();
  expect(within(moverCard("ZZTEST|USD")).getByText("USD")).toBeInTheDocument();
  expect(screen.getByText("Moved as usual (1 holding)")).toBeInTheDocument();
  expect(screen.getByText("2 holdings without a usable price")).toBeInTheDocument();
  cleanup();
  await open();
  expect(within(moverCard("ZZTEST|CAD")).queryByText("CAD")).toBeNull();
});

test("3: tapping a mover expands its feed, sparkline and small dial, and asks get_news for that symbol", async () => {
  const symbolFeed = payload({ feed: [card({ articleId: "art-9", headline: "ZZTEST second invented item", url: "https://news.example.test/a9" })], filters: { window: "7d", symbol: "ZZTEST" } });
  const { callTool } = await open(payload(), async () => ({ structuredContent: symbolFeed }));
  const toggle = within(moverCard("ZZTEST|CAD")).getByRole("button", { name: /ZZTEST/ });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  const detail = within(moverCard("ZZTEST|CAD"));
  expect(detail.getByRole("img", { name: "ZZTEST recent closes" })).toBeInTheDocument();
  const dial = detail.getByRole("img", { name: "ZZTEST news tone: Positive" });
  expect(dial).toHaveAttribute("data-size", "sm");
  expect(callTool).toHaveBeenCalledWith("get_news", { window: "7d", symbol: "ZZTEST" });
  expect(await detail.findByRole("link", { name: "ZZTEST second invented item" })).toBeInTheDocument();
  // The main view is not replaced by the per-symbol response.
  expect(within(feed()).getByRole("link", { name: "ZZETF constituent invented update" })).toBeInTheDocument();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("3b: before the symbol feed arrives the expanded view shows the cached cards for that symbol", async () => {
  await open(payload(), () => new Promise<ToolResult>(() => {}));
  fireEvent.click(within(moverCard("ZZTEST|CAD")).getByRole("button", { name: /ZZTEST/ }));
  const list = moverCard("ZZTEST|CAD").querySelector("[data-symbol-feed]") as HTMLElement;
  expect(within(list).getByRole("link", { name: "ZZTEST reports invented quarterly results" })).toBeInTheDocument();
  expect(within(list).queryByText("ZZETF constituent invented update")).toBeNull();
});

test("4: window switch calls get_news with window and account, and a stale response is dropped", async () => {
  const resolvers: Array<(r: ToolResult) => void> = [];
  const { callTool } = await open(payload(), () => new Promise<ToolResult>((res) => { resolvers.push(res); }));
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-2" } });
  expect(callTool).toHaveBeenLastCalledWith("get_news", { window: "7d", accountId: "acct-secret-2" });
  fireEvent.click(screen.getByRole("radio", { name: "24h" }));
  expect(callTool).toHaveBeenLastCalledWith("get_news", { window: "24h", accountId: "acct-secret-2" });
  const fresh = payload({ window: "24h", filters: { window: "24h", accountId: "acct-secret-2" }, movers: [mover({ symbol: "ZZNEW" })] });
  const stale = payload({ filters: { window: "7d", accountId: "acct-secret-2" }, movers: [mover({ symbol: "ZZOLD" })] });
  await act(async () => { resolvers[1]({ structuredContent: fresh }); });
  await act(async () => { resolvers[0]({ structuredContent: stale }); await new Promise((r) => setTimeout(r, 0)); });
  expect(moverCard("ZZNEW|CAD")).not.toBeNull();
  expect(moverCard("ZZOLD|CAD")).toBeNull();
  expect(screen.getByRole("radio", { name: "24h", checked: true })).toBeInTheDocument();
});

test("4b: a failed reload keeps the view and shows a notice", async () => {
  await open(payload(), async () => { throw new Error("boom"); });
  fireEvent.click(screen.getByRole("radio", { name: "30d" }));
  expect(await screen.findByText("Couldn't load that view. Showing the previous one.")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "7d", checked: true })).toBeInTheDocument();
  expect(moverCard("ZZTEST|CAD")).not.toBeNull();
});

test("5: Summarize sends exactly the message; a failure shows a notice", async () => {
  const { bridge } = await open();
  const buttons = within(feed()).getAllByRole("button", { name: "Summarize" });
  fireEvent.click(buttons[0]);
  expect(bridge.sendMessage).toHaveBeenCalledWith("Summarize this article for me: https://news.example.test/a1");
  (bridge.sendMessage as any).mockRejectedValueOnce(new Error("no"));
  fireEvent.click(buttons[1]);
  expect(await screen.findByText("Couldn't send that to the chat.")).toBeInTheDocument();
});

test("6: feed links open safely, duplicates are noted, thumbnails use the image origin", async () => {
  await open();
  const f = within(feed());
  const link = f.getByRole("link", { name: "ZZTEST reports invented quarterly results" });
  expect(link).toHaveAttribute("href", "https://news.example.test/a1");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(f.getByText("also reported by 2 sources")).toBeInTheDocument();
  const imgs = feed().querySelectorAll("img");
  expect(imgs).toHaveLength(1);
  expect(imgs[0]).toHaveAttribute("src", "https://app.example.test/api/news/image/art-1");
  expect(feed().querySelectorAll("[data-placeholder]")).toHaveLength(1);
});

test("7: privacy hides dollar moves, units and values but keeps percentages, moods and headlines", async () => {
  await open();
  fireEvent.click(within(moverCard("ZZTEST|CAD")).getByRole("button", { name: /ZZTEST/ }));
  expect(within(moverCard("ZZTEST|CAD")).getByText(/37\.5 units/)).toBeInTheDocument();
  expect(within(moverCard("ZZTEST|CAD")).getByText("$5,490.12")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  expect(movers()).not.toHaveTextContent(/\$/);
  expect(movers()).not.toHaveTextContent(/37\.5/);
  expect(screen.getAllByRole("img", { name: "Hidden amount" }).length).toBeGreaterThanOrEqual(4);
  expect(within(moverCard("ZZTEST|CAD")).getByText("(+2.3%)")).toBeInTheDocument();
  expect(within(moverCard("ZZTEST|CAD")).getAllByText("Positive").length).toBeGreaterThan(0);
  expect(within(feed()).getByRole("link", { name: "ZZTEST reports invented quarterly results" })).toBeInTheDocument();
});

test("7b: privacyDefault starts hidden", async () => {
  await open(payload({ settings: { benchmark: "sp500", cadView: false, privacyDefault: true } }));
  expect(screen.getByRole("button", { name: "Show amounts" })).toBeInTheDocument();
  expect(movers()).not.toHaveTextContent(/\$/);
});

test("8: notes footer: advice note, sources, as-of; no news-as-of note when fresh", async () => {
  await open();
  const notes = within(screen.getByRole("contentinfo"));
  expect(notes.getByText("News and ratings are for information only, not investment advice.")).toBeInTheDocument();
  expect(notes.getByText("Sources: Marketaux, SEC EDGAR")).toBeInTheDocument();
  expect(notes.getByText(/^As of /)).toBeInTheDocument();
  expect(notes.getByText(/AI-rated from the headline and summary\. They describe the news, not the stock, and may be wrong\./)).toBeInTheDocument();
  expect(notes.queryByText(/^News as of/)).toBeNull();
  expect(notes.queryByText(/not yet fetched/)).toBeNull();
});

test("8a: footer times are Toronto time, labelled ET", async () => {
  const { formatDateTime } = await import("../../kit/format");
  const asOf = "2026-10-21T02:30:00Z"; // 22:30 on Oct 20 in Toronto
  await open(payload({ asOf, newsAsOf: asOf, budgetExhausted: true }));
  const notes = within(screen.getByRole("contentinfo"));
  expect(notes.getByText(`As of ${formatDateTime(asOf, "en-CA", "America/Toronto")} ET`)).toBeInTheDocument();
  expect(notes.getByText(`News as of ${formatDateTime(asOf, "en-CA", "America/Toronto")} ET`)).toBeInTheDocument();
  expect(notes.getAllByText(/Oct 20, 2026/)).toHaveLength(2);
});

test("8b: budget exhausted, stale news and unfetched holdings are noted", async () => {
  await open(payload({ budgetExhausted: true, unfetched: 2 }));
  let notes = within(screen.getByRole("contentinfo"));
  expect(notes.getByText(/^News as of /)).toBeInTheDocument();
  expect(notes.getByText("2 holdings not yet fetched")).toBeInTheDocument();
  cleanup();
  await open(payload({ newsAsOf: ago(7), unfetched: 1 }));
  notes = within(screen.getByRole("contentinfo"));
  expect(notes.getByText(/^News as of /)).toBeInTheDocument();
  expect(notes.getByText("1 holding not yet fetched")).toBeInTheDocument();
  cleanup();
  await open(payload({ newsAsOf: null, unfetched: 5 }));
  notes = within(screen.getByRole("contentinfo"));
  expect(notes.queryByText(/^News as of/)).toBeNull();
  expect(notes.getByText("5 holdings not yet fetched")).toBeInTheDocument();
});

test("9: model context names only the window and the mover count", async () => {
  const { bridge } = await open(payload(), async () => ({ structuredContent: payload({ window: "30d", filters: { window: "30d", accountId: "acct-secret-1" }, movers: [mover()] }) }));
  await waitFor(() => expect(bridge.updateModelContext).toHaveBeenCalledWith("Viewing news: 7d, 3 movers"));
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acct-secret-1" } });
  await waitFor(() => expect(bridge.updateModelContext).toHaveBeenLastCalledWith("Viewing news: 30d, 1 movers"));
  for (const [text] of (bridge.updateModelContext as any).mock.calls) {
    const m = /^Viewing news: (24h|7d|30d), (\d+) movers$/.exec(text);
    expect(m).not.toBeNull();
    expect(text.replace(m![1], "").replace(m![2], "")).not.toMatch(/\d|\$|ZZ|TFSA|secret/);
  }
});

test("9b: a host-pushed result with different filters replaces the view after a user load; same filters do not", async () => {
  const user = payload({ window: "30d", filters: { window: "30d" }, movers: [mover({ symbol: "ZZUSER" })] });
  const f = await open(payload(), async () => ({ structuredContent: user }));
  fireEvent.click(screen.getByRole("radio", { name: "30d" }));
  await waitFor(() => expect(moverCard("ZZUSER|CAD")).not.toBeNull());
  act(() => f.push(payload({ window: "30d", filters: { window: "30d" }, movers: [mover({ symbol: "ZZSAME" })] })));
  expect(moverCard("ZZUSER|CAD")).not.toBeNull();
  expect(moverCard("ZZSAME|CAD")).toBeNull();
  act(() => f.push(payload({ window: "24h", filters: { window: "24h", accountId: "acct-secret-2" }, movers: [mover({ symbol: "ZZHOST" })] })));
  expect(moverCard("ZZHOST|CAD")).not.toBeNull();
  expect(screen.getByRole("radio", { name: "24h", checked: true })).toBeInTheDocument();
  expect((screen.getByLabelText("Account") as HTMLSelectElement).value).toBe("acct-secret-2");
});

test("9c: a host-pushed result with new filters drops an in-flight user load", async () => {
  const resolvers: Array<(r: ToolResult) => void> = [];
  const f = await open(payload(), () => new Promise<ToolResult>((res) => { resolvers.push(res); }));
  fireEvent.click(screen.getByRole("radio", { name: "30d" }));
  act(() => f.push(payload({ window: "24h", filters: { window: "24h" }, movers: [mover({ symbol: "ZZHOST" })] })));
  await act(async () => { resolvers[0]({ structuredContent: payload({ window: "30d", filters: { window: "30d" }, movers: [mover({ symbol: "ZZLATE" })] }) }); await new Promise((r) => setTimeout(r, 0)); });
  expect(moverCard("ZZHOST|CAD")).not.toBeNull();
  expect(moverCard("ZZLATE|CAD")).toBeNull();
});

test("9d: the mover head has a chevron reflecting the expanded state", async () => {
  await open(payload(), () => new Promise<ToolResult>(() => {}));
  const toggle = within(moverCard("ZZTEST|CAD")).getByRole("button", { name: /ZZTEST/ });
  expect(toggle.querySelector("[data-chevron]")).toHaveTextContent("▸");
  fireEvent.click(toggle);
  expect(toggle.querySelector("[data-chevron]")).toHaveTextContent("▾");
});

test("10: an empty view says nothing moved more than usual and there is no news", async () => {
  await open(payload({ movers: [], feed: [] }));
  expect(within(movers()).getByText("No holdings moved more than usual")).toBeInTheDocument();
  expect(within(feed()).getByText("No news in this window")).toBeInTheDocument();
});

describe("News resilience", () => {
  test("11: shows a retry 30 s after initialize with no payload, and retry hydrates", async () => {
    vi.useFakeTimers();
    const { bridge } = fakeBridge();
    (bridge.callTool as any).mockImplementation(async (name: string) => ({ structuredContent: name === "show_news" ? payload() : {} }));
    render(<News bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(29_500); });
    expect(screen.queryByText(/still loading/i)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.getByText(/still loading/i)).toBeInTheDocument();
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(bridge.callTool).toHaveBeenCalledWith("show_news", {});
    expect(await screen.findByRole("region", { name: "News tone" })).toBeInTheDocument();
  });

  test("12: an error result shows the unavailable banner with a retry", async () => {
    const f = fakeBridge();
    render(<News bridge={f.bridge} />);
    act(() => f.push({} as NewsPayload));
    expect(await screen.findByText("News unavailable right now")).toBeInTheDocument();
  });
});

const filteredPayload = () => payload({
  movers: [mover()], feed: [card()], symbols: [{ symbol: "ZZTEST", mood: mood({ articles: 4 }), sparkline: [100, 101, 103] }],
  filters: { window: "7d", symbol: "ZZTEST" },
});

test("filters.symbol opens on that holding: chip, small dial, sparkline, filtered feed, no portfolio strip", async () => {
  const f = await open(filteredPayload(), (name, args) => ({ structuredContent: payload() }));
  expect(screen.queryByRole("region", { name: "Movers" })).toBeNull();
  expect(screen.getByRole("button", { name: /ZZTEST · All holdings/ })).toBeInTheDocument();
  const sym = within(screen.getByRole("region", { name: "ZZTEST news" }));
  expect(sym.getByRole("img", { name: /ZZTEST news tone/ })).toHaveAttribute("data-size", "sm");
  expect(sym.getByRole("img", { name: "ZZTEST recent closes" })).toBeInTheDocument();
  expect(feed()).toHaveTextContent("ZZTEST reports invented quarterly results");
  expect(feed()).not.toHaveTextContent("ZZETF constituent");
  await waitFor(() => expect(f.bridge.updateModelContext).toHaveBeenCalledWith("Viewing news: 7d, one holding"));
});

test("the chip clears the filter by calling get_news without a symbol", async () => {
  const f = await open(filteredPayload(), () => ({ structuredContent: payload() }));
  fireEvent.click(screen.getByRole("button", { name: /ZZTEST · All holdings/ }));
  await waitFor(() => expect(f.callTool).toHaveBeenCalledWith("get_news", { window: "7d" }));
  await screen.findByRole("region", { name: "Movers" });
  expect(screen.queryByRole("button", { name: /All holdings/ })).toBeNull();
});

test("filters.symbolNotHeld shows a banner over the unfiltered view", async () => {
  await open(payload({ filters: { window: "7d", symbolNotHeld: "GOOG" } }));
  expect(screen.getByText("GOOG isn't in your holdings — showing all")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Movers" })).toBeInTheDocument();
});

// ---- CAD view ----
const homeOf = (amount: number | null, native: number, currency: string, estimated: boolean): any => ({
  amount, estimated, rate: estimated ? 1.4 : null, rateDate: estimated ? "2026-10-21" : null, native: { amount: native, currency },
});
function cadPayload(over: Partial<NewsPayload> = {}): NewsPayload {
  const p = payload({ settings: { benchmark: "sp500", cadView: true, privacyDefault: false } });
  p.movers[0].home = homeOf(123.45, 123.45, "CAD", false);
  p.movers[1].home = homeOf(-123.5, -88.2, "USD", true);
  return { ...p, ...over };
}

test("CAD view: the movers carry the caption that a USD holding's CAD move includes the currency move; not without the CAD view (B2)", async () => {
  const caption = "A USD holding's CAD move includes the day's currency move; the percent is the price move.";
  await open(cadPayload());
  expect(within(movers()).getByText(caption)).toBeInTheDocument();
  cleanup();
  await open(payload());
  expect(screen.queryByText(caption)).toBeNull();
});

test("CAD view: a USD mover's dollar move is in CAD est. with the native move under it; the percent stays native", async () => {
  await open(cadPayload());
  const b = within(moverCard("ZZALT|USD"));
  const head = b.getByText("ZZALT").closest("button")!;
  expect(head.textContent).toContain("−$123.50");
  expect(head.textContent).toContain("−US$88.20");
  expect(head.textContent).toContain("(−4.1%)");
  expect(head.textContent).toContain("est.");
  // A CAD mover reads as before.
  expect(within(moverCard("ZZTEST|CAD")).getByText(/\+\$123\.45/).closest("button")!.textContent).toContain("(+2.3%)");
  expect(within(moverCard("ZZTEST|CAD")).getByText("ZZTEST").closest("button")!.textContent).not.toContain("est.");
});

test("CAD view: a move that could not be converted keeps its native amount", async () => {
  const p = cadPayload();
  p.movers[1].home = homeOf(null, -88.2, "USD", false);
  await open(p);
  expect(within(moverCard("ZZALT|USD")).getByText("−US$88.20 (−4.1%)")).toBeInTheDocument();
});

test("CAD view: privacy hides CAD and native amounts alike", async () => {
  await open(cadPayload());
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  expect(movers().textContent).not.toContain("123.50");
  expect(movers().textContent).not.toContain("88.20");
  expect(movers().textContent).toContain("(−4.1%)");
});

test("the switch shows the native moves again and saves the setting", async () => {
  const f = await open(cadPayload());
  fireEvent.click(screen.getByRole("button", { name: "Show original currencies" }));
  expect(f.callTool).toHaveBeenCalledWith("save_portfolio_settings", { cadView: false });
  expect(within(moverCard("ZZALT|USD")).getByText("−US$88.20 (−4.1%)")).toBeInTheDocument();
  expect(movers().textContent).not.toContain("123.50");
});

test("turning CAD on over a payload without CAD data reloads the view", async () => {
  const f = await open(payload(), (name) => ({ structuredContent: name === "save_portfolio_settings" ? {} : cadPayload() }));
  const sw = screen.getByRole("button", { name: "Show original currencies" });
  await waitFor(() => expect(sw).toHaveAttribute("aria-pressed", "true"));
  fireEvent.click(sw);
  await waitFor(() => expect(f.callTool).toHaveBeenCalledWith("get_news", { window: "7d" }));
  await waitFor(() => expect(movers().textContent).toContain("−$123.50"));
});

test("the news feed shows 10 cards per page with Prev/Next (owner request 2026-10-23)", async () => {
  const many = Array.from({ length: 13 }, (_, i) => card({ articleId: `art-p${i}`, headline: `ZZTEST invented headline ${i + 1}`, url: `https://news.example.test/p${i}` }));
  await open(payload({ feed: many }));
  const feed = () => screen.getByRole("region", { name: "News feed" });
  expect(within(feed()).getByText("ZZTEST invented headline 10")).toBeInTheDocument();
  expect(within(feed()).queryByText("ZZTEST invented headline 11")).toBeNull();
  expect(within(feed()).getByText("1–10 of 13")).toBeInTheDocument();
  fireEvent.click(within(feed()).getByRole("button", { name: "Next page" }));
  expect(within(feed()).getByText("ZZTEST invented headline 11")).toBeInTheDocument();
  expect(within(feed()).queryByText("ZZTEST invented headline 1")).toBeNull();
});

test("clicking a feed headline asks the host to open it in the browser", async () => {
  const f = await open(payload());
  const spy = vi.fn(async () => true);
  f.bridge.openLink = spy;
  const feed = screen.getByRole("region", { name: "News feed" });
  const link = within(feed).getAllByRole("link")[0];
  fireEvent.click(link);
  expect(spy).toHaveBeenCalledWith(link.getAttribute("href"));
});
