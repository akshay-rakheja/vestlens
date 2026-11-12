import { useEffect, useRef, useState } from "preact/hooks";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { WidgetGuard, useHydrateWatchdog } from "../../kit/resilience";
import { Pager, usePager } from "../../kit/pager";
import { Banner, BrandFooter, Money, Segmented, ViewControls } from "../../kit/components";
import { MoodDial, MOOD_WORDS, moodColor } from "../../kit/MoodDial";
import { NewsCard } from "../../kit/NewsCard";
import { Sparkline } from "../../kit/charts/Sparkline";
import { useCadView } from "../../kit/currency-switch";
import { HomeMoney } from "../../kit/home-money";
import { formatDateTime, formatSignedMoney, formatSignedPercent, formatUnits } from "../../kit/format";
import type { Mover, MoodView, NewsCard as Card, NewsPayload, NewsWindow } from "./types";

const WINDOWS: readonly NewsWindow[] = ["24h", "7d", "30d"];
const LOAD_FAILED = "Couldn't load that view. Showing the previous one.";
const SEND_FAILED = "Couldn't send that to the chat.";
const STALE_MS = 6 * 3600_000;
/** Footer times are Toronto time (as in the calendar and alerts), labelled so a viewer elsewhere is not misled. */
const torontoTime = (iso: string) => `${formatDateTime(iso, "en-CA", "America/Toronto")} ET`;

interface View { window: NewsWindow; accountId: string; symbol: string }

const isPayload = (c: unknown): c is NewsPayload => {
  const p = c as NewsPayload;
  return !!p && WINDOWS.includes(p.window) && Array.isArray(p.movers) && Array.isArray(p.feed) && Array.isArray(p.symbols)
    && Array.isArray(p.accounts) && !!p.portfolioMood?.spread && !!p.filters;
};
const payloadOf = (r: ToolResult): NewsPayload => {
  if (r.isError || !isPayload(r.structuredContent)) throw new Error("failed");
  return r.structuredContent;
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "<Dial word> · 3 positive · 2 negative · 1 not enough news": the dial word leads, then the non-zero per-holding counts. */
export function spreadSentence(mood: NewsPayload["portfolioMood"]): string {
  const s = mood.spread;
  const parts: Array<[number, string]> = [[s.positive, "positive"], [s.negative, "negative"], [s.neutral, "neutral"], [s.unknown, "not enough news"]];
  return [MOOD_WORDS[mood.level], ...parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`)].join(" · ");
}

function Hidden() { return <span class="w-blur" role="img" aria-label="Hidden amount">••••</span>; }

const LOOK_THROUGH = "from top holdings · est.";
const NO_LOOK_THROUGH = "No look-through data";

function MoodChip({ mood }: { mood: MoodView }) {
  if (mood.lookThroughMissing) return <span class="w-chip w-mood-chip" data-mood="none">{NO_LOOK_THROUGH}</span>;
  return (
    <>
      <span class="w-chip w-mood-chip" data-mood={mood.level} style={{ "--mood": moodColor(mood.level) }}>{MOOD_WORDS[mood.level]}</span>
      {mood.lookThrough && <small class="w-muted">{LOOK_THROUGH}</small>}
    </>
  );
}

/** The basis line under a symbol dial: ETFs say where the mood comes from. */
function MoodBasis({ mood }: { mood: MoodView }) {
  if (mood.lookThroughMissing) return <small class="w-muted">{NO_LOOK_THROUGH}</small>;
  return mood.lookThrough ? <small class="w-muted">{LOOK_THROUGH}</small> : null;
}

function Move({ m, privacy, cad }: { m: Mover; privacy: boolean; cad: boolean }) {
  const pct = formatSignedPercent(m.returnFraction, 1);
  const home = cad && m.home && m.home.amount !== null ? m.home : undefined;
  const sign = home ? home.amount! : m.dollarMove;
  const tone = sign > 0 ? "up" : sign < 0 ? "down" : undefined;
  if (home) {
    return privacy
      ? <span class={tone}><Hidden /> <span>{`(${pct})`}</span></span>
      : <span class={tone}><HomeMoney value={home} privacy={false} signed /> <span>{`(${pct})`}</span></span>;
  }
  return privacy
    ? <span class={tone}><Hidden /> <span>{`(${pct})`}</span></span>
    : <span class={tone}>{`${formatSignedMoney(m.dollarMove, m.currency)} (${pct})`}</span>;
}

function Reason({ m, privacy, onSummarize, onOpen }: { m: Mover; privacy: boolean; onSummarize(url: string): void; onOpen(url: string): void }) {
  if (m.reason.kind === "article" && m.reason.card) {
    return <NewsCard compact onOpen={onOpen} card={{ ...m.reason.card, via: m.reason.via ?? m.reason.card.via }} privacy={privacy} onSummarize={onSummarize} />;
  }
  if (m.reason.kind === "nothing_explains") return <div class="w-muted">News, but nothing that explains the move</div>;
  if (m.reason.kind === "news_not_rated") return <div class="w-muted">News found, not yet rated</div>;
  return <div class="w-muted">Moved more than usual · no clear news</div>;
}

function NewsView({ bridge, seed }: { bridge: Bridge; seed: ToolResult | null }) {
  const [page, setPage] = useState<NewsPayload | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [privacy, setPrivacy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [symbolFeeds, setSymbolFeeds] = useState<Record<string, Card[]>>({});
  const [cadOn, setCadOn] = useCadView(bridge, page?.settings);

  const req = useRef(0);
  const hasData = useRef(false);
  const userLoaded = useRef(false);
  const viewRef = useRef<View | null>(null);
  const appliedRef = useRef<View | null>(null);
  const requested = useRef(new Set<string>());

  function show(content: NewsPayload, settled: View) {
    viewRef.current = settled; appliedRef.current = settled;
    requested.current = new Set();
    setView(settled); setPage(content); setExpanded(new Set()); setSymbolFeeds({});
  }
  function hydrate(result: ToolResult): boolean {
    const content = result.structuredContent;
    if (result.isError || !isPayload(content)) {
      if (!hasData.current) setLoadFailed(true);
      return false;
    }
    // After a user-driven load, a pushed result for the same view is ignored; one for a different view wins.
    const cur = appliedRef.current;
    if (userLoaded.current && cur && cur.window === content.window && cur.accountId === (content.filters.accountId ?? "") && cur.symbol === (content.filters.symbol ?? "")) return true;
    req.current += 1; // drop any in-flight user load
    setLoading(false);
    const first = !hasData.current;
    hasData.current = true;
    show(content, { window: content.window, accountId: content.filters.accountId ?? "", symbol: content.filters.symbol ?? "" });
    setLoadFailed(false);
    if (first) setPrivacy(content.settings?.privacyDefault ?? false);
    return true;
  }
  useEffect(() => bridge.onToolResult((result) => { hydrate(result); }), [bridge]);
  useEffect(() => { if (seed) hydrate(seed); }, []);
  const stalled = useHydrateWatchdog(bridge, () => hasData.current);
  // Host-opened links (a sandboxed frame cannot open windows); fall back to window.open if the host refuses.
  const openArticle = (url: string) => { void bridge.openLink(url).then((ok) => { if (!ok) { try { window.open(url, "_blank", "noopener"); } catch { /* blocked */ } } }); };
  // 10 cards per page (owner request 2026-10-23); a new payload (window, account, symbol) returns to page 1.
  const feedPager = usePager(page?.feed ?? [], false, async () => {}, page ? `${page.filters.window}|${page.filters.accountId ?? ""}|${page.filters.symbol ?? ""}|${page.asOf}` : "");
  async function retryLoad() {
    setRetrying(true);
    try { hydrate(await bridge.callTool("show_news", bridge.toolArguments())); } catch { if (!hasData.current) setLoadFailed(true); } finally { setRetrying(false); }
  }

  useEffect(() => {
    if (!page) return;
    // Only the window and a count: no symbols, amounts, accounts or headlines.
    void bridge.updateModelContext(page.filters.symbol
      ? `Viewing news: ${page.window}, one holding`
      : `Viewing news: ${page.window}, ${page.movers.length} movers`).catch(() => {});
  }, [bridge, page]);

  if (!page || !view) {
    if (loadFailed) {
      return (
        <div class="w-shell">
          <Banner tone="warning">News unavailable right now</Banner>
          <button type="button" class="w-chip w-toggle" disabled={retrying} onClick={() => void retryLoad()}>Try again</button>
        </div>
      );
    }
    if (stalled) return (
      <div class="w-shell">
        <Banner tone="info">Still loading…</Banner>
        <button type="button" class="w-chip w-toggle" disabled={retrying} onClick={() => void retryLoad()}>Try again</button>
      </div>
    );
    return <div class="w-shell w-muted">Loading your news…</div>;
  }

  const scopeArgs = (v: View): Record<string, unknown> => ({ window: v.window, ...(v.accountId ? { accountId: v.accountId } : {}), ...(v.symbol ? { symbol: v.symbol } : {}) });

  async function load(change: Partial<View>) {
    const next = { ...viewRef.current!, ...change };
    viewRef.current = next; setView(next);
    const id = ++req.current;
    setLoading(true);
    try {
      const content = payloadOf(await bridge.callTool("get_news", scopeArgs(next)));
      if (id !== req.current) return;
      userLoaded.current = true;
      show(content, { window: content.window, accountId: next.accountId, symbol: next.symbol });
      setNotice(null); setLoading(false);
    } catch {
      if (id !== req.current) return;
      const back = appliedRef.current!;
      viewRef.current = back; setView(back);
      setLoading(false); setNotice(LOAD_FAILED);
    }
  }

  async function loadSymbol(symbol: string) {
    const applied = appliedRef.current!;
    const key = `${applied.window}|${applied.accountId}|${symbol}`;
    if (requested.current.has(key)) return;
    requested.current.add(key);
    try {
      const content = payloadOf(await bridge.callTool("get_news", { ...scopeArgs(applied), symbol }));
      // A response for a view that has since changed is dropped (show() resets the requested set).
      if (!requested.current.has(key)) return;
      setSymbolFeeds((f) => ({ ...f, [key]: content.feed }));
    } catch {
      requested.current.delete(key); // keep showing the cached cards; a later tap may retry
    }
  }

  // Turning CAD on over a payload built with it off needs the CAD moves from the server, after the setting is saved.
  function onCadChange(next: boolean) {
    const saved = setCadOn(next);
    if (next && page && page.movers.some((m) => !m.home)) void saved.then((ok) => { if (ok) void load({}); });
  }

  function toggle(m: Mover) {
    const key = `${m.symbol}|${m.currency}`;
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key); else { next.add(key); void loadSymbol(m.symbol); }
    setExpanded(next);
  }

  function summarize(url: string) {
    bridge.sendMessage(`Summarize this article for me: ${url}`).catch(() => setNotice(SEND_FAILED));
  }

  const counts = new Map<string, number>();
  for (const m of page.movers) counts.set(m.symbol, (counts.get(m.symbol) ?? 0) + 1);
  const symbolInfo = new Map(page.symbols.map((s) => [s.symbol, s]));
  const articles = page.symbols.reduce((n, s) => n + s.mood.articles, 0);
  const mostRecentAt = page.symbols.reduce<string | null>((best, s) => {
    const t = s.mood.mostRecentAt;
    return t && (!best || Date.parse(t) > Date.parse(best)) ? t : best;
  }, null);
  const newsStale = page.newsAsOf !== null && (page.budgetExhausted || Date.now() - Date.parse(page.newsAsOf) > STALE_MS);
  const applied = appliedRef.current ?? view;
  const focus = page.filters.symbol ?? "";
  const focusInfo = focus ? symbolInfo.get(focus) : undefined;
  const focusMover = focus ? page.movers.find((m) => m.symbol === focus) : undefined;

  return (
    <div class="w-shell">
      <h2 class="w-sr">News</h2>
      <ViewControls privacy={privacy} onPrivacy={setPrivacy} cadOn={cadOn} onCadChange={onCadChange} />
      <div class="w-row" style={{ justifyContent: "space-between" }}>
        <select aria-label="Account" value={view.accountId} onChange={(e) => void load({ accountId: (e.target as HTMLSelectElement).value, symbol: "" })}>
          <option value="">All accounts</option>
          {page.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </div>
      <Segmented label="Window" options={WINDOWS} value={view.window} onChange={(window) => void load({ window })} />
      {focus && (
        <div class="w-row">
          <button type="button" class="w-chip w-toggle" onClick={() => void load({ symbol: "" })}>{`${focus} · All holdings ✕`}</button>
        </div>
      )}
      {page.filters.symbolNotHeld && <Banner tone="info">{`${page.filters.symbolNotHeld} isn't in your holdings — showing all`}</Banner>}

      <div aria-busy={loading ? "true" : "false"} class="w-shell" style={{ padding: 0 }}>
        {focus ? (
          <section aria-label={`${focus} news`} class="w-mover-detail">
            <div class="w-row" style={{ justifyContent: "space-between" }}>
              <div>
                {focusInfo
                  ? <MoodDial size="sm" label={`${focus} news tone`} level={focusInfo.mood.level} value={focusInfo.mood.value} articles={focusInfo.mood.articles} mostRecentAt={focusInfo.mood.mostRecentAt} />
                  : <div class="w-muted">No news tone for this holding</div>}
                {focusInfo && <MoodBasis mood={focusInfo.mood} />}
                <small class="w-muted">The tone of recent headlines, not a view on the stocks · AI-rated, may be wrong</small>
              </div>
              {focusInfo && <Sparkline values={focusInfo.sparkline} width={120} height={32} label={`${focus} recent closes`} />}
            </div>
            {focusMover && (
              <>
                <div class="w-row"><b class="w-sym">{focus}</b><Move m={focusMover} privacy={privacy} cad={cadOn} />{focusMover.estimated && <span class="w-chip">est.</span>}</div>
                <Reason m={focusMover} privacy={privacy} onSummarize={summarize} onOpen={openArticle} />
              </>
            )}
          </section>
        ) : <>
        <section aria-label="News tone" class="w-mood-strip">
          <MoodDial size="lg" unit="ratings" label="News tone" level={page.portfolioMood.level} value={page.portfolioMood.value} articles={articles} mostRecentAt={mostRecentAt} />
          <div>{spreadSentence(page.portfolioMood)}</div>
          <small class="w-muted">The tone of recent headlines, not a view on the stocks · AI-rated, may be wrong</small>
        </section>

        <section aria-label="Movers">
          <h3 class="w-h">Moved more than usual</h3>
          {page.movers.length === 0 && <div class="w-muted">No holdings moved more than usual</div>}
          {cadOn && page.movers.some((m) => m.home?.estimated) && <small class="w-muted">A USD holding's CAD move includes the day's currency move; the percent is the price move.</small>}
          {page.movers.map((m) => {
            const key = `${m.symbol}|${m.currency}`;
            const open = expanded.has(key);
            const info = symbolInfo.get(m.symbol);
            const cards = symbolFeeds[`${applied.window}|${applied.accountId}|${m.symbol}`] ?? page.feed.filter((c) => c.symbols.includes(m.symbol));
            return (
              <div key={key} class="w-mover" data-mover={key}>
                <button type="button" class="w-mover-head" aria-expanded={open ? "true" : "false"} onClick={() => toggle(m)}>
                  <span class="w-mover-id">
                    <span class="w-chevron" data-chevron aria-hidden="true">{open ? "▾" : "▸"}</span>
                    <b class="w-sym">{m.symbol}</b>
                    {(counts.get(m.symbol) ?? 0) > 1 && <span class="w-chip">{m.currency}</span>}
                  </span>
                  <span class="w-mover-move">
                    <Move m={m} privacy={privacy} cad={cadOn} />
                    {m.estimated && <span class="w-chip">est.</span>}
                  </span>
                </button>
                <div class="w-row">
                  {m.limitedHistory && <span class="w-chip">limited history</span>}
                  <MoodChip mood={m.mood} />
                </div>
                <Reason m={m} privacy={privacy} onSummarize={summarize} onOpen={openArticle} />
                {open && (
                  <div class="w-mover-detail">
                    <div class="w-row" style={{ justifyContent: "space-between" }}>
                      <div>
                        <MoodDial size="sm" label={`${m.symbol} news tone`} level={(info?.mood ?? m.mood).level} value={(info?.mood ?? m.mood).value}
                          articles={(info?.mood ?? m.mood).articles} mostRecentAt={(info?.mood ?? m.mood).mostRecentAt} />
                        <MoodBasis mood={info?.mood ?? m.mood} />
                      </div>
                      {info && <Sparkline values={info.sparkline} width={120} height={32} label={`${m.symbol} recent closes`} />}
                    </div>
                    <div class="w-muted">
                      {privacy ? <Hidden /> : <span>{`${formatUnits(m.units)} units`}</span>}
                      {m.marketValue !== null && <> · <Money amount={m.marketValue} currency={m.currency} privacy={privacy} /></>}
                    </div>
                    <div data-symbol-feed>
                      {cards.length === 0
                        ? <div class="w-muted">No news for this holding in this window</div>
                        : cards.map((c) => <NewsCard key={c.articleId} onOpen={openArticle} card={c} privacy={privacy} imageBase={page.imageOrigin} onSummarize={summarize} />)}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <div class="w-muted">{`Moved as usual (${plural(page.asUsual, "holding", "holdings")})`}</div>
          {page.unpriced > 0 && <div class="w-muted">{`${plural(page.unpriced, "holding", "holdings")} without a usable price`}</div>}
        </section>
        </>}

        <section aria-label="News feed">
          <h3 class="w-h">News</h3>
          {page.feed.length === 0
            ? <div class="w-muted">No news in this window</div>
            : feedPager.visible.map((c) => <NewsCard key={c.articleId} onOpen={openArticle} card={c} privacy={privacy} imageBase={page.imageOrigin} onSummarize={summarize} />)}
          <Pager pager={feedPager} />
        </section>
      </div>

      {notice && <Banner tone="info">{notice}</Banner>}

      <footer class="w-notes w-muted">
        <div>News and ratings are for information only, not investment advice.</div>
        <div>News tone and tags are AI-rated from the headline and summary. They describe the news, not the stock, and may be wrong.</div>
        <div>Sources: Marketaux, SEC EDGAR</div>
        <div>{`As of ${torontoTime(page.asOf)}`}</div>
        {newsStale && <div>{`News as of ${torontoTime(page.newsAsOf!)}`}</div>}
        {page.unfetched > 0 && <div>{`${plural(page.unfetched, "holding", "holdings")} not yet fetched`}</div>}
      </footer>
      <BrandFooter advice={false} />
    </div>
  );
}

export function News({ bridge }: { bridge: Bridge }) {
  return <WidgetGuard bridge={bridge} showTool="show_news">{(seed) => <NewsView bridge={bridge} seed={seed} />}</WidgetGuard>;
}
