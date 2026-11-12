import { useEffect, useRef, useState } from "preact/hooks";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { WidgetGuard, useHydrateWatchdog } from "../../kit/resilience";
import { Banner, BrandFooter, FilterChip, Money, Segmented, SymbolText, Tile, ViewControls } from "../../kit/components";
import { ACCOUNT_TYPE_OPTION, accountTypeChip, knownAccountType, scopeValueLabel, type AccountType } from "../../kit/account-types";
import { DataTable, type Column, type SortOption } from "../../kit/DataTable";
import { formatDateTime, formatPercent, formatShortDate, formatSignedPercent, formatUnits } from "../../kit/format";
import { useCadView } from "../../kit/currency-switch";
import { HomeCaption, HomeMoney, NativeAmounts, cadValue, notConverted, type HomeAmountView } from "../../kit/home-money";
import type { AccountValue, HoldingRow, HoldingsHome, HoldingsPayload, HoldingsSort, HoldingsTotals } from "./types";

/** Internal view marker: every currency, loaded without a currency filter (the CAD view). Never shown as a segment. */
const ALL = "all";
const LOAD_FAILED = "Couldn't load that view. Showing the previous one.";
/** Table sort keys the get_holdings tool also knows (the rest sort the rows already loaded). */
const SORT_KEYS: Record<string, HoldingsSort> = { symbol: "symbol", value: "value", weight: "weight", return: "return", returnPct: "returnPct", today: "today" };
const PRICE_WITHIN = "Price is sorted within each currency, not across them.";
const SORTS: readonly string[] = ["weight", "value", "return", "returnPct", "today", "symbol"];

/** `accountType` (a chip) and `accountId` (the picker) are never both set; `symbol` is its own chip. */
interface View { accountId: string; accountType: AccountType | null; symbol: string; currency: string; sort: HoldingsSort }

const isPayload = (c: unknown): c is HoldingsPayload =>
  !!c && Array.isArray((c as HoldingsPayload).rows) && Array.isArray((c as HoldingsPayload).totals) && Array.isArray((c as HoldingsPayload).currencies) && !!(c as HoldingsPayload).filters;
const payloadOf = (r: ToolResult): HoldingsPayload => {
  if (r.isError || !isPayload(r.structuredContent)) throw new Error("failed");
  return r.structuredContent;
};

/** What the payload was loaded for: its currency filter, else every currency. */
const scopeCurrency = (p: HoldingsPayload): string => (p.filters.currency && p.currencies.includes(p.filters.currency) ? p.filters.currency : ALL);

/** The currency to show first in the original-currencies view: the payload's filter, else the first currency. */
function defaultCurrency(p: HoldingsPayload): string {
  if (p.filters.currency && p.currencies.includes(p.filters.currency)) return p.filters.currency;
  return p.currencies[0] ?? ALL;
}

function Units(props: { units: number; privacy: boolean }) {
  return props.privacy ? <span class="w-blur" role="img" aria-label="Hidden amount">••••••</span> : <>{formatUnits(props.units)}</>;
}
function Hidden() { return <span class="w-blur" role="img" aria-label="Hidden amount">••••</span>; }
/** The one provenance line for brokerage-reported figures (no caption in every tile). */
const PROVENANCE = "Values as your brokerage reports them";
function Provenance() { return <p class="w-provenance">{PROVENANCE}</p>; }
const tone = (v: number | null | undefined) => (v == null || v === 0 ? undefined : v > 0 ? "up" : "down");

function ReturnCell(props: { amount: number | null; fraction: number | null; currency: string; privacy: boolean }) {
  if (props.amount === null && props.fraction === null) return <>—</>;
  return (
    <span class={tone(props.amount ?? props.fraction)}>
      {props.amount !== null && <Money amount={props.amount} currency={props.currency} signed privacy={props.privacy} />}
      {props.fraction !== null && <small>{` ${formatSignedPercent(props.fraction)}`}</small>}
    </span>
  );
}

function TotalsTiles({ t, privacy }: { t: HoldingsTotals; privacy: boolean }) {
  const partial = t.withCostBasis < t.holdings;
  return (
    <section aria-label={`${t.currency} totals`}>
      <h3 class="w-h">{t.currency}</h3>
      <div class="w-tiles three">
        <Tile label="Value" value={<Money amount={t.marketValue} currency={t.currency} privacy={privacy} />} />
        <Tile label="Book cost" value={t.bookCost === null ? "—" : <Money amount={t.bookCost} currency={t.currency} privacy={privacy} />} />
        <Tile label="Gain vs book cost" tone={tone(t.totalReturn) ?? "neutral"}
          value={t.totalReturn === null ? "—" : <ReturnCell amount={t.totalReturn} fraction={t.totalReturnFraction} currency={t.currency} privacy={privacy} />} />
      </div>
      {partial && <small class="w-muted">{`Cost and gain from ${t.withCostBasis} of ${t.holdings} holdings`}</small>}
      {t.cash !== 0 && <div class="w-muted">Cash <Money amount={t.cash} currency={t.currency} privacy={privacy} /></div>}
    </section>
  );
}

/** CAD tiles over every holding in scope. The gain is the brokerage's native figure at today's rate (est.). */
function HomeTiles({ home, privacy }: { home: HoldingsHome; privacy: boolean }) {
  const t = home.tiles;
  const money = (total: typeof t.value, signed = false) => (notConverted(total) ? <NativeAmounts total={total} privacy={privacy} signed={signed} /> : <HomeMoney value={cadValue(total)} privacy={privacy} signed={signed} />);
  const ret = t.totalReturn;
  const gain = ret === null ? "—" : notConverted(ret) ? money(ret, true) : (
    <span class={tone(ret.amount)}><HomeMoney value={cadValue(ret)} privacy={privacy} signed />{t.totalReturnFraction !== null && <small>{` ${formatSignedPercent(t.totalReturnFraction)}`}</small>}</span>
  );
  return (
    <section aria-label="CAD-equivalent totals">
      <div class="w-tiles three">
        <Tile label="Value" value={money(t.value)} />
        <Tile label="Book cost" value={t.bookCost === null ? "—" : money(t.bookCost)} />
        <Tile label="Unrealized gain (at today's rate)" tone={ret === null ? "neutral" : tone(ret.amount) ?? "neutral"} value={gain} />
      </div>
      {!notConverted(t.value) && <HomeCaption total={t.value} />}
      {ret !== null && ret.estimated && <p class="w-caption">Excludes currency movement since purchase.</p>}
      {!t.complete && <small class="w-muted">Cost and gain only cover holdings with a cost basis</small>}
    </section>
  );
}

/** The one CAD portfolio (or account) total: the same figure Overview and Allocation show. */
function HomeAccountValue({ home, label, privacy }: { home: HoldingsHome; label: string; privacy: boolean }) {
  const t = home.total;
  const none = notConverted(t);
  return (
    <section aria-label={label}>
      <div class="w-tiles">
        <Tile label={`${label} in CAD`}
          value={<span style={{ fontSize: "1.6em" }}>{none ? <NativeAmounts total={t} privacy={privacy} /> : <HomeMoney value={cadValue(t)} privacy={privacy} />}</span>} />
      </div>
      {!none && <HomeCaption total={t} />}
      {home.includesUnreported && <p class="w-caption">Includes accounts without a brokerage total (valued from holdings)</p>}
      {home.rowsDiffer && <p class="w-caption">Rows converted at the BoC rate; the brokerage total uses its own rate.</p>}
    </section>
  );
}

function AccountValueCard({ values, label, fxDate, privacy }: { values: AccountValue[]; label: string; fxDate: string | null; privacy: boolean }) {
  if (values.length === 0) return null;
  // Reported totals share the one provenance line; an estimate keeps its own est. (and BoC date) marking.
  const caption = (v: AccountValue) => (v.source === "reported" ? null : v.currency === "CAD" && fxDate ? `est. · BoC ${fxDate}` : "est.");
  return (
    <section aria-label={label}>
      <div class="w-tiles">
        {values.map((v) => (
          <Tile key={v.currency} label={`${label} in ${v.currency}`}
            value={<span style={{ fontSize: "1.6em" }}><Money amount={v.amount} currency={v.currency} privacy={privacy} />{caption(v) && <small class="w-muted">{caption(v)}</small>}</span>} />
        ))}
      </div>
      {values.some((v) => v.source === "reported") && <Provenance />}
    </section>
  );
}

function MadeUp({ totals, privacy }: { totals: HoldingsTotals[]; privacy: boolean }) {
  const parts: Array<{ key: string; label: string; currency: string; amount: number }> = [];
  for (const t of totals) if (t.holdings > 0 || t.marketValue !== 0) parts.push({ key: `h${t.currency}`, label: `${t.currency} holdings`, currency: t.currency, amount: t.marketValue });
  for (const t of totals) if (t.cash !== 0) parts.push({ key: `c${t.currency}`, label: `${t.currency} cash`, currency: t.currency, amount: t.cash });
  if (parts.length === 0) return null;
  return (
    <div class="w-muted" aria-label="Made up of">
      {"Made up of "}
      {parts.map((p, i) => <span key={p.key}>{i > 0 && (i === parts.length - 1 ? " and " : ", ")}{p.label} <Money amount={p.amount} currency={p.currency} privacy={privacy} /></span>)}
    </div>
  );
}

function HoldingsView({ bridge, seed }: { bridge: Bridge; seed: ToolResult | null }) {
  const [page, setPage] = useState<HoldingsPayload | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [applied, setApplied] = useState<View | null>(null);
  const [privacy, setPrivacy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sortEpoch, setSortEpoch] = useState(0);
  // The key the table is sorted by once the user has chosen one (it can be a key the tool has no sort for).
  const [tableSort, setTableSort] = useState<string | null>(null);
  const [cadOn, setCadOn] = useCadView(bridge, page?.settings);
  // A currency the model asked for (tool input). The CAD view keeps it as a row filter instead of reloading every currency.
  const [rowFilter, setRowFilter] = useState<string | null>(null);
  // Reloads unfiltered rows when the CAD view is switched on after a single-currency load.
  const loadRef = useRef<(change: Partial<View>) => Promise<void>>();
  const cadMode = cadOn && !!page?.home;

  const req = useRef(0);
  const hasData = useRef(false);
  const userLoaded = useRef(false);
  const viewRef = useRef<View | null>(null);
  const appliedRef = useRef<View | null>(null);
  // The latest unfiltered per-currency totals, so "Made up of" survives a currency filter on the same scope.
  const composition = useRef<{ scope: string; totals: HoldingsTotals[] } | null>(null);

  function hydrate(result: ToolResult): boolean {
    const content = result.structuredContent;
    if (result.isError || !isPayload(content)) {
      if (!hasData.current) setLoadFailed(true);
      return false;
    }
    if (userLoaded.current) return true;
    const first = !hasData.current;
    hasData.current = true;
    const sort = (SORTS.includes(content.filters.sort) ? content.filters.sort : "weight") as HoldingsSort;
    // An account-type scope is kept as the type, even when the server also echoes the one account it matched.
    const accountType = knownAccountType(content.filters.accountType);
    const next: View = { accountId: accountType ? "" : content.filters.accountId ?? "", accountType, symbol: content.filters.symbol ?? "", currency: scopeCurrency(content), sort };
    viewRef.current = next; appliedRef.current = next;
    const asked = (bridge.toolArguments() as Record<string, unknown> | undefined)?.currency;
    setRowFilter(typeof asked === "string" && next.currency !== ALL && asked.trim().toUpperCase() === next.currency ? next.currency : null);
    setView(next); setApplied(next); setPage(content); setLoadFailed(false);
    if (first) setPrivacy(content.settings?.privacyDefault ?? false);
    return true;
  }
  useEffect(() => bridge.onToolResult((result) => { hydrate(result); }), [bridge]);
  useEffect(() => { if (seed) hydrate(seed); }, []);
  const stalled = useHydrateWatchdog(bridge, () => hasData.current);
  async function retryLoad() {
    setRetrying(true);
    try { hydrate(await bridge.callTool("show_holdings", bridge.toolArguments())); } catch { if (!hasData.current) setLoadFailed(true); } finally { setRetrying(false); }
  }

  useEffect(() => {
    if (!applied || !page) return;
    const currency = cadMode ? (rowFilter ? `${rowFilter} holdings in CAD` : "all currencies in CAD") : applied.currency === ALL ? defaultCurrency(page) : applied.currency;
    // Account labels can carry ordinals ("TFSA 2"), so only the scope kind is shared.
    const scope = applied.accountType ? accountTypeChip(applied.accountType) : applied.accountId ? "one account" : "all accounts";
    void bridge.updateModelContext(`Viewing holdings: ${scope}${applied.symbol ? `, symbol ${applied.symbol}` : ""}, ${currency}, sorted by ${tableSort ?? applied.sort}`).catch(() => {});
  }, [bridge, page !== null, applied, cadMode, rowFilter, tableSort]);
  useEffect(() => {
    if (cadMode && applied && applied.currency !== ALL && !rowFilter && !loading) void loadRef.current?.({ currency: ALL });
  }, [cadMode, applied, rowFilter]);

  if (!page || !view || !applied) {
    if (loadFailed) {
      return (
        <div class="w-shell">
          <Banner tone="warning">Holdings unavailable right now</Banner>
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
    return <div class="w-shell w-muted">Loading your holdings…</div>;
  }

  async function load(change: Partial<View>) {
    const next = { ...viewRef.current!, ...change };
    viewRef.current = next; setView(next);
    const id = ++req.current;
    setLoading(true);
    const args: Record<string, unknown> = { sort: next.sort };
    if (next.accountType) args.accountType = next.accountType;
    else if (next.accountId) args.accountId = next.accountId;
    if (next.symbol) args.symbol = next.symbol;
    if (next.currency !== ALL) args.currency = next.currency;
    try {
      const content = payloadOf(await bridge.callTool("get_holdings", args));
      if (id !== req.current) return;
      userLoaded.current = true;
      // A scope change can remove the chosen currency; fall back to this payload's default.
      const settled = next.currency === ALL || content.currencies.includes(next.currency) ? next : { ...next, currency: scopeCurrency(content) };
      viewRef.current = settled; appliedRef.current = settled;
      // Choosing a currency (or clearing the chip) replaces the model's filter; a scope that drops it clears it too.
      setRowFilter((f) => (f && !("currency" in change) && settled.currency === f ? f : null));
      setView(settled); setApplied(settled); setPage(content); setNotice(null); setLoading(false);
    } catch {
      if (id !== req.current) return;
      const back = appliedRef.current!;
      viewRef.current = back; setView(back);
      setLoading(false); setNotice(LOAD_FAILED); setSortEpoch((n) => n + 1); setTableSort(null);
    }
  }

  loadRef.current = load;
  const home = cadMode ? page.home! : null;
  const allMode = cadMode;
  // The original-currencies view filters the rows client-side, so a CAD view loaded unfiltered switches back without a reload.
  const currency = view.currency === ALL ? defaultCurrency(page) : view.currency;
  const shown = allMode ? (rowFilter ? page.rows.filter((r) => r.currency === rowFilter) : page.rows) : page.rows.filter((r) => r.currency === currency);
  // A weekend or holiday quote is the last session's move: the column says which session.
  const sessions = [...new Set(shown.flatMap((r) => (r.dayChange?.sessionDate ? [r.dayChange.sessionDate] : [])))].sort();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const lastSession = sessions.at(-1);
  const dayLabel = lastSession && lastSession !== today ? formatShortDate(lastSession, today.slice(0, 4)) : "Today";
  const unweighted = allMode ? shown.filter((r) => r.weightCad === null).length : 0;
  // CAD sort keys come from the API's conversions; a row it could not convert has no CAD figure and sorts last.
  const cadKey = (r: HoldingRow, native: number | null, pick: (c: NonNullable<HoldingRow["cad"]>) => HomeAmountView | null): number | null =>
    native === null || !allMode ? native : r.currency === "CAD" ? native : r.cad ? pick(r.cad)?.amount ?? null : null;
  const totals = allMode ? page.totals : page.totals.filter((t) => t.currency === currency);
  const weightOf = (r: HoldingRow) => (allMode ? r.weightCad : r.weight);
  const options = page.currencies;
  const scopeId = page.filters.accountId ?? "";
  // The scope "Made up of" belongs to: account, account type and symbol all narrow the totals.
  const scopeKey = `${scopeId}|${page.filters.accountType ?? ""}|${page.filters.symbol ?? ""}`;
  if (!page.filters.currency) composition.current = { scope: scopeKey, totals: page.totals };
  const parts = !page.filters.currency ? page.totals : composition.current?.scope === scopeKey ? composition.current.totals : page.totals;
  const partsComplete = parts.length >= page.currencies.length;

  const columns: Column<HoldingRow>[] = [
    { key: "symbol", label: "Symbol", mobile: "primary", sortValue: (r) => r.symbol,
      render: (r) => <><b class="w-sym"><SymbolText symbol={r.symbol} /></b>{allMode && <small class="w-muted">{` ${r.currency}`}</small>}</> },
    { key: "units", label: "Units", align: "right", mobile: "hidden", sortValue: (r) => r.units, render: (r) => <Units units={r.units} privacy={privacy} /> },
    // A quote is not a portfolio amount, so privacy leaves it. It is in the holding's own currency and the widget does no
    // FX math: CAD and USD prices are never ordered against each other, a mixed view sorts them within each currency.
    { key: "price", label: "Price", align: "right", mobile: "secondary", sortValue: (r) => r.price, within: { by: (r) => r.currency, note: PRICE_WITHIN },
      render: (r) => (r.price === null ? "—" : <Money amount={r.price} currency={r.currency} privacy={false} />) },
    { key: "value", label: "Value", align: "right", mobile: "primary", sortValue: (r) => cadKey(r, r.marketValue, (c) => c.value),
      render: (r) => (r.marketValue === null ? "—" : allMode && r.cad ? <HomeMoney value={r.cad.value} privacy={privacy} /> : <Money amount={r.marketValue} currency={r.currency} privacy={privacy} />) },
    { key: "weight", label: "Weight", align: "right", mobile: "secondary", sortValue: weightOf,
      render: (r) => { const w = weightOf(r); return w === null ? "—" : formatPercent(w); } },
    { key: "return", label: allMode && page.rows.some((r) => r.cad) ? "Unrealized gain" : "Gain vs cost", align: "right", mobile: "secondary", sortValue: (r) => cadKey(r, r.totalReturn, (c) => c.totalReturn),
      render: (r) => <ReturnCell amount={privacy ? null : r.totalReturn} fraction={r.totalReturnFraction} currency={r.currency} privacy={privacy} /> },
    { key: "today", label: `${dayLabel}${allMode ? "" : " (est.)"}`, align: "right", mobile: "hidden", sortValue: (r) => cadKey(r, r.dayChange?.amount ?? null, (c) => c.dayChange),
      render: (r) => (r.dayChange ? <ReturnCell amount={r.dayChange.amount === null ? null : r.dayChange.amount} fraction={r.dayChange.fraction} currency={r.currency} privacy={privacy} /> : "—") },
  ];
  // The gain and day-change cells show an amount and a percent together; the percents sort from the sort control.
  const percentSorts: SortOption<HoldingRow>[] = [
    { key: "returnPct", label: "Gain %", sortValue: (r) => r.totalReturnFraction },
    { key: "todayPct", label: `${dayLabel} %${allMode ? "" : " (est.)"}`, sortValue: (r) => r.dayChange?.fraction ?? null },
  ];
  // Privacy blanks the dollar part of Return/Today; ReturnCell only drops the amount when it is null, so show a mask instead.
  const maskedReturn = (r: HoldingRow, amount: number | null, fraction: number | null) =>
    privacy && amount !== null ? <span class={tone(amount ?? fraction)}><Hidden />{fraction !== null && <small>{` ${formatSignedPercent(fraction)}`}</small>}</span>
      : <ReturnCell amount={amount} fraction={fraction} currency={r.currency} privacy={privacy} />;
  const cadReturn = (r: HoldingRow, amount: HomeAmountView | undefined | null, fraction: number | null) =>
    <span class={tone(amount?.amount)}><HomeMoney value={amount!} signed privacy={privacy} />{fraction !== null && <small>{` ${formatSignedPercent(fraction)}`}</small>}</span>;
  columns[5].render = (r) => (allMode && r.cad?.totalReturn ? cadReturn(r, r.cad.totalReturn, r.totalReturnFraction) : maskedReturn(r, r.totalReturn, r.totalReturnFraction));
  columns[6].render = (r) => (r.dayChange ? (allMode && r.cad?.dayChange ? cadReturn(r, r.cad.dayChange, r.dayChange.fraction) : maskedReturn(r, r.dayChange.amount, r.dayChange.fraction)) : "—");

  function onRowClick(r: HoldingRow) {
    bridge.sendMessage(`Show my history with ${r.symbol}`).catch(() => setNotice("Couldn't send that to the chat."));
  }
  const total = page.rows.length + page.omitted;

  return (
    <main class="w-shell">
      <h2 class="w-sr">Holdings</h2>
      <ViewControls privacy={privacy} onPrivacy={setPrivacy} cadOn={cadOn} onCadChange={(next) => { void setCadOn(next); }} />
      <div class="w-row" style={{ justifyContent: "space-between" }}>
        <select aria-label="Account" value={view.accountType ? ACCOUNT_TYPE_OPTION : view.accountId} onChange={(e) => {
          const accountId = (e.target as HTMLSelectElement).value;
          if (accountId !== ACCOUNT_TYPE_OPTION) void load({ accountId, accountType: null });
        }}>
          <option value="">All accounts</option>
          {view.accountType && <option value={ACCOUNT_TYPE_OPTION}>{accountTypeChip(view.accountType)}</option>}
          {page.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </div>
      {(view.accountType || view.symbol) && (
        <div class="w-row">
          {view.accountType && <FilterChip text={accountTypeChip(view.accountType)} disabled={loading} onRemove={() => void load({ accountType: null })} />}
          {view.symbol && <FilterChip text={view.symbol} disabled={loading} onRemove={() => void load({ symbol: "" })} />}
        </div>
      )}
      {allMode && rowFilter && (
        <div class="w-row">
          <button type="button" class="w-chip w-toggle" aria-pressed="true" aria-label={`Remove currency filter ${rowFilter}`} disabled={loading}
            onClick={() => void load({ currency: ALL })}>{`Currency: ${rowFilter} ×`}</button>
        </div>
      )}
      {!allMode && page.currencies.length > 1 && (
        <Segmented label="Currency" options={options} value={currency} disabled={loading}
          onChange={(next) => void load({ currency: next })} />
      )}
      {home ? <HomeAccountValue home={home} label={scopeValueLabel(page.filters)} privacy={privacy} />
        : <AccountValueCard values={page.accountValue ?? []} label={scopeValueLabel(page.filters)} fxDate={page.fx?.date ?? null} privacy={privacy} />}
      {page.pricesAsOf && <small class="w-muted">{`Prices as of ${formatDateTime(page.pricesAsOf)}, SnapTrade's last sync with your brokerage. Your brokerage's app shows live prices, so its total can differ during market hours.`}</small>}
      {partsComplete && <MadeUp totals={parts} privacy={privacy} />}
      {home && totals.length > 0
        ? <HomeTiles home={home} privacy={privacy} />
        : totals.map((t) => <TotalsTiles key={t.currency} t={t} privacy={privacy} />)}
      {totals.length > 0 && <p class="w-caption">Dividends aren't included here. Reinvested dividends add to book cost.</p>}
      {!home && totals.length > 0 && !(page.accountValue ?? []).some((v) => v.source === "reported") && <Provenance />}
      {allMode && shown.some((r) => r.cad?.dayChange?.estimated) && <small class="w-muted">The CAD day change includes the day's currency move; the percent is the price move.</small>}
      {shown.length > 0 && <small class="w-muted">{allMode ? "Weight is of holdings, cash excluded" : `Weight is of ${currency} holdings, cash excluded`}</small>}
      {unweighted > 0 && <small class="w-muted">{`${unweighted} ${unweighted === 1 ? "holding" : "holdings"} without a value ${unweighted === 1 ? "is" : "are"} not weighted`}</small>}
      {page.omitted > 0 && <Banner tone="info">{`Showing the largest ${page.rows.length} of ${total} holdings — filter by account or currency to see the rest`}</Banner>}
      <div aria-busy={loading ? "true" : "false"}>
        {shown.length === 0
          ? <div class="w-muted">No holdings in this view</div>
          : (
            <DataTable key={sortEpoch} label="Holdings" pageSize={10} rows={shown} columns={columns} rowKey={(r) => r.key} initialSort={{ key: SORT_KEYS[view.sort] ?? "weight", dir: view.sort === "symbol" ? "asc" : "desc" }}
              extraSorts={percentSorts} tieBreak={(r) => `${r.symbol}|${r.currency}`}
              onRowClick={onRowClick} canExpand={(r) => r.accounts.length > 0}
              onSortChange={(key) => { setTableSort(key); const sort = SORT_KEYS[key]; if (sort) void load({ sort }); }}
              expand={(r) => (
                <ul class="w-muted" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {r.accounts.map((a) => (
                    <li key={a.accountId} class="w-row" style={{ justifyContent: "space-between" }}>
                      <span>{a.label}</span>
                      <span>
                        <Units units={a.units} privacy={privacy} />
                        {a.marketValue !== null && <> · <Money amount={a.marketValue} currency={r.currency} privacy={privacy} /></>}
                        {a.bookCost !== null && <> · {"cost "}<Money amount={a.bookCost} currency={r.currency} privacy={privacy} /></>}
                        {a.totalReturn !== null && <> · {"gain "}{maskedReturn(r, a.totalReturn, null)}</>}
                      </span>
                    </li>
                  ))}
                </ul>
              )} />
          )}
      </div>
      {notice && <Banner tone="info">{notice}</Banner>}
      <BrandFooter />
    </main>
  );
}

export function Holdings({ bridge }: { bridge: Bridge }) {
  return <WidgetGuard bridge={bridge} showTool="show_holdings">{(seed) => <HoldingsView bridge={bridge} seed={seed} />}</WidgetGuard>;
}
