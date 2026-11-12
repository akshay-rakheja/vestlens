import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { WidgetGuard, useHydrateWatchdog } from "../../kit/resilience";
import { PriceMarkerChart } from "../../kit/charts/PriceMarkerChart";
import { Banner, BrandFooter, FilterChip, Money, Segmented, SymbolText, Tile, ViewControls, shortSymbol } from "../../kit/components";
import { ACCOUNT_TYPE_OPTION, accountTypeChip, knownAccountType, type AccountType } from "../../kit/account-types";
import { Pager, usePager } from "../../kit/pager";
import { formatShortDate, formatSignedPercent, formatUnits } from "../../kit/format";
import { HomeCaption, HomeMoney, NativeAmounts, notConverted } from "../../kit/home-money";
import type { HomeAmountView, HomeTotalView } from "../../kit/home-money";
import { useCadView } from "../../kit/currency-switch";
import type { ActivityCategory, ActivityPage, ActivityRow, SymbolHistory } from "./types";

const CATEGORIES: ReadonlyArray<{ key: ActivityCategory; chip: string; name: string }> = [
  { key: "investing", chip: "Investing", name: "Investing" },
  { key: "moving_money", chip: "+ Moving money", name: "Moving money" },
  { key: "cash", chip: "+ Cash & spending", name: "Cash & spending" },
];
const RANGES = ["30 days", "90 days", "YTD", "1Y", "All"] as const;
type RangeKey = (typeof RANGES)[number] | "Custom";
const PERIODS = ["1Y", "All"] as const;
const ALL_TIME_FROM = "2000-01-01";
const SEARCH_DEBOUNCE_MS = 300;
const LOAD_FAILED = "Couldn't load that view. Showing the previous one.";
/** Replayed and reported units are compared with a small tolerance for fractional-share rounding. */
const UNITS_TOLERANCE = 1e-6;
const GAINS_UNAVAILABLE = "Realized gain unavailable: history incomplete";
const COST_HISTORY_UNAVAILABLE = "Cost history unavailable — rebuilt cost didn't match Wealthsimple";

/** `accountType` (a chip) and `accountId` (the picker) are never both set. */
interface Filters { accountId: string; accountType?: AccountType; categories: ActivityCategory[]; range: RangeKey; query: string; symbol?: string }
interface SymbolSel { symbol: string; accountId: string; period: "1Y" | "ALL" }
interface SymbolView extends SymbolSel { history: SymbolHistory; rows: ActivityRow[]; nextCursor: string | null }

const torontoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });
const minusDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
const isPage = (c: unknown): c is ActivityPage => !!c && Array.isArray((c as ActivityPage).rows) && Array.isArray((c as ActivityPage).totals) && !!(c as ActivityPage).filters;
const isHistory = (c: unknown): c is SymbolHistory => !!c && typeof (c as SymbolHistory).symbol === "string" && !!(c as SymbolHistory).position && Array.isArray((c as SymbolHistory).prices);
const pageOf = (r: ToolResult): ActivityPage => {
  if (r.isError || !isPage(r.structuredContent)) throw new Error("failed");
  return r.structuredContent;
};

/**
 * The symbol a symbol-scoped payload opens. show_activity matches listings (XEQT matches XEQT.TO) and
 * get_symbol_history reads one symbol, so rows that all share one symbol open on it; with no rows the query opens,
 * and rows naming several listings (XEQT.TO and XEQT.NE) keep the feed (null).
 */
function symbolToOpen(content: ActivityPage): string | null {
  const query = content.filters.symbol;
  if (!query) return null;
  const symbols = [...new Set(content.rows.map((r) => r.symbol?.trim().toUpperCase()).filter((s): s is string => !!s))];
  if (symbols.length === 0) return query;
  return symbols.length === 1 ? symbols[0]! : null;
}

function rangeFrom(range: RangeKey, to: string, custom: string): string {
  switch (range) {
    case "30 days": return minusDays(to, 30);
    case "90 days": return minusDays(to, 90);
    case "YTD": return `${to.slice(0, 4)}-01-01`;
    case "1Y": return minusDays(to, 365);
    case "All": return ALL_TIME_FROM;
    default: return custom;
  }
}
function inferRange(from: string, to: string): RangeKey {
  return RANGES.find((r) => rangeFrom(r, to, "") === from) ?? "Custom";
}

function iconOf(row: ActivityRow): { glyph: string; tone: string } {
  switch (row.type.toUpperCase()) {
    case "BUY": return { glyph: "↓", tone: "buy" };
    case "SELL": return { glyph: "↑", tone: "sell" };
    case "DIVIDEND": case "DISTRIBUTION": case "REI": case "REINVEST": case "STOCK_DIVIDEND": case "INTEREST": return { glyph: "$", tone: "" };
    case "FEE": case "TAX": case "WITHHOLDING": return { glyph: "%", tone: "" };
  }
  return { glyph: row.category === "moving_money" ? "⇄" : row.category === "cash" ? "¤" : "•", tone: "" };
}

/** Units are a holding size, so privacy hides them like amounts. */
function Units(props: { units: number; privacy: boolean }) {
  return props.privacy
    ? <span class="w-blur" role="img" aria-label="Hidden amount">••••••</span>
    : <>{formatUnits(props.units)}</>;
}

/** A CAD figure with no original amount of its own (totals and gains are already in CAD). */
const cadView = (amount: number, estimated: boolean): HomeAmountView => ({ amount, estimated, rate: null, rateDate: null, native: { amount, currency: "CAD" } });

function HomeTile(props: { label: string; total: HomeTotalView; privacy: boolean; signed?: boolean; tone?: "up" | "neutral" }) {
  return (
    <Tile label={props.label} tone={props.tone} value={<>
      {notConverted(props.total)
        ? <NativeAmounts total={props.total} privacy={props.privacy} signed={props.signed} />
        : <>
          <HomeMoney value={cadView(props.total.amount, props.total.estimated)} privacy={props.privacy} signed={props.signed} />
          <HomeCaption total={props.total} />
        </>}
    </>} />
  );
}

function GainTile(props: { label: string; gain: { amount: number; estimated: boolean }; privacy: boolean }) {
  const tone = props.gain.amount > 0 ? "up" : props.gain.amount < 0 ? "down" : "neutral";
  return <Tile label={props.label} tone={tone} value={<HomeMoney value={cadView(props.gain.amount, props.gain.estimated)} privacy={props.privacy} signed />} />;
}

/** A row's description with its symbol shown short (VFV, not VFV.TO); screen readers still hear the full symbol. */
function Description(props: { text: string; symbol: string | null }) {
  const { text, symbol } = props;
  if (!symbol || shortSymbol(symbol) === symbol || !text.includes(symbol)) return <>{text}</>;
  return <>{text.split(symbol).map((part, i) => <Fragment key={i}>{i > 0 && <SymbolText symbol={symbol} />}{part}</Fragment>)}</>;
}

function FeedRow(props: { row: ActivityRow; privacy: boolean; cad: boolean; onTap?: (row: ActivityRow) => void }) {
  const { row } = props;
  const icon = iconOf(row);
  const priceCurrency = row.priceCurrency ?? row.currency;
  const showUnitsPrice = row.units !== null && row.price !== null && priceCurrency !== null;
  const signed = !row.unsigned;
  const body = (
    <>
      <span class={`w-act-ic ${icon.tone}`} aria-hidden="true">{icon.glyph}</span>
      <span><Description text={row.description} symbol={row.symbol} /></span>
      <span class={`w-act-amt${signed && row.amount !== null && row.amount > 0 ? " up" : ""}`}>
        {props.cad && row.home ? <HomeMoney value={row.home} privacy={props.privacy} signed={signed} />
          : row.amount !== null && row.currency !== null ? <Money amount={row.amount} currency={row.currency} signed={signed} privacy={props.privacy} /> : "—"}
      </span>
      <small>
        {row.accountLabel}
        {showUnitsPrice && <> · <Units units={row.units!} privacy={props.privacy} /> × <Money amount={row.price!} currency={priceCurrency!} privacy={props.privacy} /></>}
      </small>
      <small class="w-act-cur">{row.currency ?? ""}</small>
    </>
  );
  // The visible text stays the accessible name; the action is appended for screen readers.
  return props.onTap
    ? <button type="button" class="w-act-row" onClick={() => props.onTap!(row)}>{body}{row.symbol && <span class="w-sr">{`, View ${row.symbol} history`}</span>}</button>
    : <div class="w-act-row">{body}</div>;
}

function Feed(props: { rows: ActivityRow[]; privacy: boolean; cad: boolean; today: string; onTap?: (row: ActivityRow) => void }) {
  const year = props.today.slice(0, 4);
  const groups: Array<{ date: string; rows: ActivityRow[] }> = [];
  for (const row of props.rows) {
    const last = groups[groups.length - 1];
    if (last && last.date === row.date) last.rows.push(row);
    else groups.push({ date: row.date, rows: [row] });
  }
  return (
    <>
      {groups.map((g) => {
        const label = formatShortDate(g.date, year);
        return (
          <section key={g.date}>
            <h3 class="w-day">{g.date === props.today ? `Today, ${label}` : label}</h3>
            {g.rows.map((r) => <FeedRow key={r.id} row={r} privacy={props.privacy} cad={props.cad} onTap={props.onTap} />)}
          </section>
        );
      })}
    </>
  );
}

function ActivityView({ bridge, seed }: { bridge: Bridge; seed: ToolResult | null }) {
  const [page, setPage] = useState<ActivityPage | null>(null);
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [filters, setFilters] = useState<Filters | null>(null);
  const [applied, setApplied] = useState<Filters | null>(null);
  const [searchText, setSearchText] = useState("");
  const [privacy, setPrivacy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [sym, setSym] = useState<SymbolView | null>(null);
  const [symBusy, setSymBusy] = useState(false);

  const [cadOn, setCadOn] = useCadView(bridge, page?.settings);

  const cadRef = useRef(true);
  const cadClick = useRef(0);
  const feedReq = useRef(0);
  const moreReq = useRef(0);
  const searchRef = useRef("");
  const histReq = useRef(0);
  const rowsReq = useRef(0);
  const hasData = useRef(false);
  const userLoaded = useRef(false);
  const filtersRef = useRef<Filters | null>(null);
  const appliedRef = useRef<Filters | null>(null);
  const anchor = useRef({ to: "", custom: "" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const feedArgs = (f: Filters): Record<string, unknown> => {
    const args: Record<string, unknown> = { categories: f.categories, from: rangeFrom(f.range, anchor.current.to, anchor.current.custom) };
    // A past range ("my activity in March") keeps its end; today's end is the server default.
    if (anchor.current.to && anchor.current.to !== torontoDate.format(new Date())) args.to = anchor.current.to;
    if (f.accountType) args.accountType = f.accountType;
    else if (f.accountId) args.accountId = f.accountId;
    if (f.query) args.query = f.query;
    if (f.symbol) args.symbol = f.symbol;
    return args;
  };
  const symbolRowsArgs = (s: SymbolSel): Record<string, unknown> => ({
    symbol: s.symbol, categories: ["investing"], from: ALL_TIME_FROM, ...(s.accountId ? { accountId: s.accountId } : {}),
  });

  function hydrate(result: ToolResult): boolean {
    const content = result.structuredContent;
    if (result.isError || !isPage(content)) {
      if (!hasData.current) setLoadFailed(true);
      return false;
    }
    if (userLoaded.current) return true;
    const first = !hasData.current;
    hasData.current = true;
    anchor.current = { to: content.filters.to, custom: content.filters.from };
    // An account-type scope is kept as the type, even when the server also echoes the one account it matched.
    const accountType = knownAccountType(content.filters.accountType);
    const next: Filters = {
      accountId: accountType ? "" : content.filters.accountId ?? "", ...(accountType ? { accountType } : {}), categories: content.filters.categories,
      range: inferRange(content.filters.from, content.filters.to), query: content.filters.query ?? "",
      ...(content.filters.symbol ? { symbol: content.filters.symbol } : {}),
    };
    filtersRef.current = next; appliedRef.current = next;
    setFilters(next); setApplied(next); setSearchText(next.query); searchRef.current = next.query;
    setPage(content); setRows(content.rows); setLoadFailed(false);
    if (first) setPrivacy(content.settings?.privacyDefault ?? false);
    // A symbol-scoped payload opens its symbol's view (symbolToOpen); it stays until the user goes back.
    // get_symbol_history takes no accountType: a type that matched one account opens on that account, else on all.
    const open = symbolToOpen(content);
    if (open) void loadSymbol({ symbol: open, accountId: content.filters.accountId ?? "", period: "ALL" }, "open");
    return true;
  }
  useEffect(() => bridge.onToolResult((result) => { hydrate(result); }), [bridge]);
  useEffect(() => { if (seed) hydrate(seed); }, []);
  const stalled = useHydrateWatchdog(bridge, () => hasData.current);
  // 10 rows per page with Prev/Next (server still pages in 50s; Next fetches more at the end).
  const feedPager = usePager(rows, !!page?.nextCursor, () => loadMore(), applied ? JSON.stringify(applied) : "", loading || moreBusy);
  const symPager = usePager(sym?.rows ?? [], !!sym?.nextCursor, () => loadMoreSymbol(), sym ? `${sym.symbol}|${sym.accountId}|${sym.period}` : "", symBusy || moreBusy);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function retryLoad() {
    setRetrying(true);
    try { hydrate(await bridge.callTool("show_activity", bridge.toolArguments())); } catch { if (!hasData.current) setLoadFailed(true); } finally { setRetrying(false); }
  }

  const accountLabel = (id: string) => page?.accounts.find((a) => a.id === id)?.label ?? "All accounts";
  useEffect(() => {
    if (!applied || !page) return;
    const cats = CATEGORIES.filter((c) => applied.categories.includes(c.key)).map((c) => c.name).join(" + ");
    const range = applied.range === "Custom" ? "custom range" : applied.range;
    const scope = sym ? accountLabel(sym.accountId) : applied.accountType ? accountTypeChip(applied.accountType) : accountLabel(applied.accountId);
    void bridge.updateModelContext(`Viewing activity: ${scope}, ${cats}, ${range}${sym ? `, symbol ${sym.symbol}` : ""}`).catch(() => {});
  }, [bridge, page !== null, applied, sym?.symbol, sym?.accountId]);

  if (!page || !filters || !applied) {
    if (loadFailed) {
      return (
        <div class="w-shell">
          <Banner tone="warning">Activity unavailable right now</Banner>
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
    return <div class="w-shell w-muted">Loading your activity…</div>;
  }

  async function loadFeed(change: Partial<Filters>) {
    const next = { ...filtersRef.current!, ...change };
    filtersRef.current = next; setFilters(next);
    const id = ++feedReq.current;
    moreReq.current += 1; // a filter change makes any in-flight Load more stale
    setMoreBusy(false); setLoading(true);
    try {
      const content = pageOf(await bridge.callTool("get_activity_page", feedArgs(next)));
      if (id !== feedReq.current) return;
      userLoaded.current = true; appliedRef.current = next;
      setApplied(next); setPage(content); setRows(content.rows); setNotice(null); setLoading(false); setMoreBusy(false);
    } catch {
      if (id !== feedReq.current) return;
      const back = appliedRef.current!;
      filtersRef.current = back; setFilters(back);
      // Restore the box only if the user has not typed something newer since.
      if (searchRef.current.trim() === next.query) { setSearchText(back.query); searchRef.current = back.query; }
      setLoading(false); setMoreBusy(false); setNotice(LOAD_FAILED);
    }
  }
  function toggleCategory(key: ActivityCategory) {
    const current = filtersRef.current!.categories;
    const on = current.includes(key);
    if (on && current.length === 1) return;
    const next = CATEGORIES.map((c) => c.key).filter((k) => (k === key ? !on : current.includes(k)));
    void loadFeed({ categories: next });
  }
  function onSearch(text: string) {
    setSearchText(text); searchRef.current = text;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const query = text.trim();
      if (query !== filtersRef.current!.query) void loadFeed({ query });
    }, SEARCH_DEBOUNCE_MS);
  }
  async function loadMore() {
    if (!page?.nextCursor || loading || moreBusy) return;
    const fid = feedReq.current;
    const id = ++moreReq.current;
    setMoreBusy(true);
    try {
      const content = pageOf(await bridge.callTool("get_activity_page", { cursor: page.nextCursor, ...feedArgs(appliedRef.current!) }));
      if (id !== moreReq.current || fid !== feedReq.current) return;
      setPage(content); setRows((prev) => (content.restarted ? content.rows : [...prev, ...content.rows])); setNotice(null); setMoreBusy(false);
    } catch {
      if (id !== moreReq.current || fid !== feedReq.current) return;
      setMoreBusy(false); setNotice(LOAD_FAILED);
    }
  }

  async function loadSymbol(next: SymbolSel, mode: "open" | "account" | "period") {
    const hid = ++histReq.current;
    const withRows = mode !== "period";
    const rid = withRows ? ++rowsReq.current : rowsReq.current;
    if (withRows) setMoreBusy(false); // a reload makes any in-flight symbol Load more stale
    setSymBusy(true);
    try {
      const [h, r] = await Promise.all([
        bridge.callTool("get_symbol_history", { symbol: next.symbol, period: next.period, ...(next.accountId ? { accountId: next.accountId } : {}) }),
        withRows ? bridge.callTool("get_activity_page", symbolRowsArgs(next)) : Promise.resolve(null),
      ]);
      if (hid !== histReq.current || (withRows && rid !== rowsReq.current)) return;
      if (h.isError || !isHistory(h.structuredContent)) throw new Error("failed");
      const history = h.structuredContent;
      const symbolRows = r ? pageOf(r) : null;
      setSym((prev) => ({ ...next, history, rows: symbolRows ? symbolRows.rows : prev?.rows ?? [], nextCursor: symbolRows ? symbolRows.nextCursor : prev?.nextCursor ?? null }));
      setNotice(null); setSymBusy(false); setMoreBusy(false);
    } catch {
      if (hid !== histReq.current) return;
      setSymBusy(false); setMoreBusy(false); setNotice(LOAD_FAILED);
    }
  }
  async function loadMoreSymbol() {
    if (!sym?.nextCursor || symBusy || moreBusy) return;
    const id = ++rowsReq.current;
    setMoreBusy(true);
    try {
      const content = pageOf(await bridge.callTool("get_activity_page", { cursor: sym.nextCursor, ...symbolRowsArgs(sym) }));
      if (id !== rowsReq.current) return;
      setSym((prev) => (prev ? { ...prev, rows: content.restarted ? content.rows : [...prev.rows, ...content.rows], nextCursor: content.nextCursor } : prev));
      setMoreBusy(false);
    } catch {
      if (id !== rowsReq.current) return;
      setMoreBusy(false); setNotice(LOAD_FAILED);
    }
  }
  function closeSymbol() {
    histReq.current += 1; rowsReq.current += 1;
    setSym(null); setSymBusy(false); setMoreBusy(false); setNotice(null);
    // Leaving a symbol-scoped payload: reload the feed without the symbol.
    if (filtersRef.current?.symbol) void loadFeed({ symbol: undefined });
  }
  function tapRow(row: ActivityRow) {
    const symbolAccount = applied!.accountType ? page!.filters.accountId ?? "" : applied!.accountId;
    if (row.symbol) { void loadSymbol({ symbol: row.symbol, accountId: symbolAccount, period: "ALL" }, "open"); return; }
    bridge.sendMessage(`Tell me about my ${row.type.replace(/_/g, " ").toLowerCase()} activity in my ${row.accountLabel}`)
      .catch(() => setNotice("Couldn't send that to the chat."));
  }

  const today = torontoDate.format(new Date());
  // Switching CAD back on over a payload fetched with it off needs fresh CAD fields from the server.
  function onCadChange(next: boolean) {
    const click = ++cadClick.current;
    const generation = histReq.current;
    const saved = setCadOn(next);
    if (!next) return;
    if (!page!.homeTotals) void loadFeed({});
    // Gains are computed only while the stored setting is on, so reload after the save lands.
    if (sym && !sym.history.homeGains) {
      const target = sym;
      // Skip when the user closed or re-selected the symbol view, or clicked the switch again, meanwhile.
      void saved.then((ok) => {
        if (ok && cadRef.current && histReq.current === generation && cadClick.current === click) void loadSymbol(target, "account");
      });
    }
  }
  const cad = cadOn;
  cadRef.current = cadOn;
  const header = (left: preact.ComponentChildren) => (
    <>
      <ViewControls privacy={privacy} onPrivacy={setPrivacy} cadOn={cadOn} onCadChange={onCadChange} />
      <div class="w-row" style={{ justifyContent: "space-between" }}>
        {left}
      </div>
    </>
  );
  // While an account-type chip is active the feed's picker reads it; choosing an account (or All accounts) replaces it.
  const accountSelect = (value: string, disabled: boolean, onChange: (id: string) => void, accountType?: AccountType) => (
    <select aria-label="Account" value={accountType ? ACCOUNT_TYPE_OPTION : value} disabled={disabled}
      onChange={(e) => { const id = (e.target as HTMLSelectElement).value; if (id !== ACCOUNT_TYPE_OPTION) onChange(id); }}>
      <option value="">All accounts</option>
      {accountType && <option value={ACCOUNT_TYPE_OPTION}>{accountTypeChip(accountType)}</option>}
      {page.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
    </select>
  );
  const noticeBanner = notice && <Banner tone="info">{notice}</Banner>;

  if (sym) {
    const h = sym.history;
    const pos = h.position;
    const money = (amount: number, signed = false) => (pos.currency ? <Money amount={amount} currency={pos.currency} signed={signed} privacy={privacy} /> : "—");
    const chartOk = !h.priceUnavailable && h.prices.length >= 2;
    const unitsDiffer = h.reportedUnits !== null && h.reportedUnits !== undefined && Math.abs(h.reportedUnits - pos.units) > UNITS_TOLERANCE;
    // Brokerage-reported figures win; without them (a closed position) the replay is an estimate.
    const rep = h.reported ?? null;
    const repCurrency = rep?.currency ?? pos.currency;
    const repMoney = (amount: number | null, signed = false) =>
      amount === null || !repCurrency ? "—" : <Money amount={amount} currency={repCurrency} signed={signed} privacy={privacy} />;
    const hasSells = pos.markers.some((m) => m.side === "sell") || sym.rows.some((r) => r.type.toUpperCase() === "SELL");
    const costHistory = h.costHistory ?? "unverified";
    const costPoints = costHistory === "unavailable" ? [] : pos.points.map((p) => ({ date: p.date, avgCost: p.avgCost }));
    const costLineDrawn = chartOk && costPoints.some((p) => p.avgCost !== null);
    const returnTone = rep?.totalReturn === null || rep?.totalReturn === undefined || rep.totalReturn === 0 ? "neutral" : rep.totalReturn > 0 ? "up" : "down";
    const dividendsTile = (
      <Tile label="Dividends (net of withholding)" tone={pos.dividends > 0 ? "up" : "neutral"} value={<>{money(pos.dividends, true)}
        {(pos.otherDividends ?? []).map((d) => <small key={d.currency} class="w-muted"> <Money amount={d.amount} currency={d.currency} signed privacy={privacy} /></small>)}</>} />
    );
    return (
      <main class="w-shell">
        {header(<button type="button" class="w-back" onClick={closeSymbol}>← All activity</button>)}
        <h2 class="w-sym-title"><span class="w-sym"><SymbolText symbol={h.symbol} /></span> {h.name && <span class="w-muted">{h.name}</span>}</h2>
        <div class="w-row">
          <Segmented label="Period" options={PERIODS} value={sym.period === "ALL" ? "All" : "1Y"} disabled={symBusy}
            onChange={(p) => void loadSymbol({ ...sym, period: p === "All" ? "ALL" : "1Y" }, "period")} />
          {accountSelect(sym.accountId, symBusy || moreBusy, (accountId) => void loadSymbol({ ...sym, accountId }, "account"))}
        </div>
        <div aria-busy={symBusy ? "true" : "false"}>
          {chartOk
            ? <PriceMarkerChart label={`${h.symbol} trades`} prices={h.prices} avgCost={costPoints} markers={pos.markers} currency={h.currency ?? pos.currency ?? undefined} privacy={privacy} />
            : <div class="w-muted">Price history unavailable</div>}
          {costHistory === "unavailable" && <small class="w-muted">{COST_HISTORY_UNAVAILABLE}</small>}
          {costHistory === "unverified" && costLineDrawn && <small class="w-muted">Dashed line: average cost est. from activity</small>}
        </div>
        {rep ? (
          <>
            <div class="w-tiles three">
              <Tile label="Units held" value={<Units units={rep.units ?? pos.units} privacy={privacy} />} />
              <Tile label="Avg cost" value={repMoney(rep.avgCost)} />
              <Tile label="Book cost" value={repMoney(rep.bookCost)} />
              <Tile label="Gain vs book cost" tone={returnTone} value={rep.totalReturn === null ? "—" : <>{repMoney(rep.totalReturn, true)}
                {rep.totalReturnFraction !== null && (privacy
                  ? <small> <span class="w-blur" role="img" aria-label="Hidden amount">••••</span></small>
                  : <small>{` ${formatSignedPercent(rep.totalReturnFraction)}`}</small>)}</>} />
              {dividendsTile}
            </div>
            <small class="w-muted">Brokerage reported</small>
          </>
        ) : (
          <div class="w-tiles three">
            <Tile label="Units held" value={<><Units units={pos.units} privacy={privacy} />
              {!privacy && unitsDiffer && <small class="w-muted">{` Brokerage reports ${formatUnits(h.reportedUnits!)}`}</small>}</>} />
            <Tile label="Avg cost" value={pos.avgCost === null
              ? <>—{pos.reason === "inconsistent" && <small class="w-muted"> records show more sold than bought</small>}</>
              : <>{money(pos.avgCost)}<small class="w-muted"> est. from activity</small></>} />
            {dividendsTile}
          </div>
        )}
        {cad && h.homeGains && (h.homeGains.unavailable
          ? <div class="w-muted">{GAINS_UNAVAILABLE}</div>
          : (hasSells && h.homeGains.realized) || h.homeGains.unrealized ? (
            <div class="w-tiles three">
              {hasSells && h.homeGains.realized && <GainTile label="Realized gain" gain={h.homeGains.realized} privacy={privacy} />}
              {h.homeGains.unrealized && <GainTile label="Unrealized gain incl. currency" gain={h.homeGains.unrealized} privacy={privacy} />}
            </div>
          ) : null)}
        {(pos.unmatchedWithholding ?? []).map((u) => <UnmatchedWithholding key={u.currency} count={u.count} amount={u.amount} currency={u.currency} privacy={privacy} />)}
        {h.otherCurrencies.length > 0 && <span class="w-muted">{`Also held in ${h.otherCurrencies.join(", ")}`}</span>}
        <h3 class="w-h">Activity for <SymbolText symbol={h.symbol} /></h3>
        {sym.rows.length === 0 && <div class="w-muted">No activity matches these filters</div>}
        <Feed rows={symPager.visible} privacy={privacy} cad={cad} today={today} />
        <Pager pager={symPager} />
        {noticeBanner}
        <BrandFooter />
      </main>
    );
  }

  const [first, ...others] = page.totals;
  const scopeSyncing = applied.accountId ? page.syncing.includes(applied.accountId) : page.syncing.length > 0;
  const homeTotals = cad ? page.homeTotals : undefined;
  const totalsLine = (t: ActivityPage["totals"][number]) => (
    <>
      <Tile label="Bought" value={<Money amount={t.bought} currency={t.currency} privacy={privacy} />} />
      <Tile label="Sold" value={<Money amount={t.sold} currency={t.currency} privacy={privacy} />} />
      <Tile label="Dividends (net of withholding)" tone={t.dividends > 0 ? "up" : "neutral"} value={<Money amount={t.dividends} currency={t.currency} signed privacy={privacy} />} />
    </>
  );
  return (
    <main class="w-shell">
      <h2 class="w-sr">Activity</h2>
      {header(accountSelect(filters.accountId, false, (accountId) => void loadFeed({ accountId, accountType: undefined }), filters.accountType))}
      <input type="search" class="w-input" aria-label="Search symbol" placeholder="Search symbol…" value={searchText}
        onInput={(e) => onSearch((e.target as HTMLInputElement).value)} />
      <div class="w-row">
        {CATEGORIES.map((c) => (
          <button key={c.key} type="button" class="w-chip w-toggle" aria-pressed={filters.categories.includes(c.key)} onClick={() => toggleCategory(c.key)}>{c.chip}</button>
        ))}
        {filters.accountType && <FilterChip text={accountTypeChip(filters.accountType)} onRemove={() => void loadFeed({ accountType: undefined })} />}
        {filters.symbol && (
          <button type="button" class="w-chip w-toggle" aria-pressed="true" aria-label={`Remove symbol filter ${filters.symbol}`}
            onClick={() => void loadFeed({ symbol: undefined })}>{`Symbol: ${shortSymbol(filters.symbol)} ×`}</button>
        )}
        <select aria-label="Range" value={filters.range} onChange={(e) => void loadFeed({ range: (e.target as HTMLSelectElement).value as RangeKey })}>
          {RANGES.map((r) => <option key={r} value={r}>{r}</option>)}
          {filters.range === "Custom" && <option value="Custom">Custom</option>}
        </select>
      </div>
      {homeTotals && (
        <div class="w-tiles three">
          <HomeTile label="Bought" total={homeTotals.bought} privacy={privacy} />
          <HomeTile label="Sold" total={homeTotals.sold} privacy={privacy} />
          <HomeTile label="Dividends (net of withholding)" total={homeTotals.dividends} privacy={privacy} signed tone={(notConverted(homeTotals.dividends) ? homeTotals.dividends.excluded.reduce((sum, p) => sum + p.amount, 0) : homeTotals.dividends.amount) > 0 ? "up" : "neutral"} />
        </div>
      )}
      {!homeTotals && first && <div class="w-tiles three">{totalsLine(first)}</div>}
      {!homeTotals && others.map((t) => (
        <div key={t.currency} class="w-muted">
          {t.currency}: bought <Money amount={t.bought} currency={t.currency} privacy={privacy} />
          {", sold "}<Money amount={t.sold} currency={t.currency} privacy={privacy} />
          {" and dividends (net of withholding) "}<Money amount={t.dividends} currency={t.currency} signed privacy={privacy} />
        </div>
      ))}
      {page.totals.map((t) => t.unmatchedWithholding && <UnmatchedWithholding key={t.currency} count={t.unmatchedWithholding.count} amount={t.unmatchedWithholding.amount} currency={t.currency} privacy={privacy} />)}
      {scopeSyncing && <Banner tone="info">Still syncing your history, so some activity may be missing.</Banner>}
      <div aria-busy={loading ? "true" : "false"}>
        {rows.length === 0 && <div class="w-muted">No activity matches these filters</div>}
        <Feed rows={feedPager.visible} privacy={privacy} cad={cad} today={today} onTap={tapRow} />
      </div>
      <Pager pager={feedPager} />
      {noticeBanner}
      <BrandFooter />
    </main>
  );
}

/** The same note Income shows: tax that matches no dividend is not in the net figure. */
function UnmatchedWithholding({ count, amount, currency, privacy }: { count: number; amount: number; currency: string; privacy: boolean }) {
  return (
    <small class="w-muted">
      {`${count} withholding ${count === 1 ? "row" : "rows"} not matched to a dividend (`}
      <Money amount={amount} currency={currency} privacy={privacy} />
      {`) ${count === 1 ? "is" : "are"} not included`}
    </small>
  );
}

export function Activity({ bridge }: { bridge: Bridge }) {
  return <WidgetGuard bridge={bridge} showTool="show_activity">{(seed) => <ActivityView bridge={bridge} seed={seed} />}</WidgetGuard>;
}
