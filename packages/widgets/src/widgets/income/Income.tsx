import { useEffect, useRef, useState } from "preact/hooks";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { WidgetGuard, useHydrateWatchdog } from "../../kit/resilience";
import { Banner, BrandFooter, FilterChip, Money, Segmented, Tile, ViewControls } from "../../kit/components";
import { ACCOUNT_TYPE_OPTION, accountTypeChip, knownAccountType, type AccountType } from "../../kit/account-types";
import { DataTable, type Column } from "../../kit/DataTable";
import { StackedBarChart } from "../../kit/charts/StackedBarChart";
import { OTHER_COLOR, assignColors } from "../../kit/charts/palette";
import { formatPercent } from "../../kit/format";
import { useCadView } from "../../kit/currency-switch";
import { HomeCaption, HomeMoney, NativeAmounts, cadValue, notConverted, type HomeTotalView } from "../../kit/home-money";
import type { ForwardUncovered, IncomeHome, IncomeMonth, IncomePayload } from "./types";

const LOAD_FAILED = "Couldn't load that view. Showing the previous one.";
const NOT_ADVICE = "Estimates for information only, not tax or investment advice.";
const CAD_CAPTION = "CAD figures: CAD amounts as reported; USD converted at the Bank of Canada rate on each payment date (est.).";
const CAPTION = "Net dividends, withholding and interest are brokerage reported · forward and yields are est., after withholding";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SERIES_ACCOUNTS = 5;
const OTHER = "__other";
const TOP_PAYERS = 10;

/** `accountType` (a chip) and `accountId` (the picker) are never both set; `symbol` is its own chip. */
interface View { year: number; accountId: string; accountType: AccountType | null; symbol: string }
type Totals = IncomePayload["currencyTotals"][number];

const isPayload = (c: unknown): c is IncomePayload =>
  !!c && Array.isArray((c as IncomePayload).currencyTotals) && Array.isArray((c as IncomePayload).months) && !!(c as IncomePayload).filters && typeof (c as IncomePayload).year === "number";
const payloadOf = (r: ToolResult): IncomePayload => {
  if (r.isError || !isPayload(r.structuredContent)) throw new Error("failed");
  return r.structuredContent;
};

/** The view a payload was built for. An account-type scope is kept as the type, even when the one matched account is echoed. */
function viewOf(p: IncomePayload): View {
  const accountType = knownAccountType(p.filters.accountType);
  return { year: p.year, accountId: accountType ? "" : p.filters.accountId ?? "", accountType, symbol: p.filters.symbol ?? "" };
}

const pctText = (f: number, digits: number) => formatPercent(f, digits);
/** 15% not 15.0%; 4.1% keeps its decimal. */
const rateText = (f: number) => { const r = Math.round(f * 1000) / 10; return `${Number.isInteger(r) ? r : r.toFixed(1)}%`; };
const monthNum = (month: string) => Number(month.slice(5, 7));

function MonthDetail(p: { currency: string; month: IncomeMonth; year: number; privacy: boolean; labelOf: (id: string) => string; colorOf: (id: string) => string; onPayer: (symbol: string) => void }) {
  const { currency, month, privacy } = p;
  const name = `${MONTHS[monthNum(month.month) - 1]} ${p.year}`;
  const rows = Object.entries(month.byAccount).sort((a, b) => b[1] - a[1]);
  const money = (amount: number) => <Money amount={amount} currency={currency} privacy={privacy} />;
  return (
    <section aria-label={`${currency} income in ${name}`} class="w-month">
      <h3 class="w-sub">{name}</h3>
      <ul class="w-items">
        <li class="w-item"><span class="lbl">Net dividends</span><span class="num"><b>{money(month.net)}</b></span></li>
        {month.withholding > 0 && <li class="w-item"><span class="lbl">Withheld</span><span class="num">{money(month.withholding)}</span></li>}
        {month.interest > 0 && <li class="w-item"><span class="lbl">Interest</span><span class="num">{money(month.interest)}</span></li>}
      </ul>
      {month.payers.length > 0 && (
        <>
          <h4 class="w-h" style={{ padding: "0 10px" }}>Payers</h4>
          <ul aria-label="Payers" class="w-items">
            {month.payers.map((x) => (
              <li key={x.symbol} class="w-item">
                <span class="lbl">{x.symbol === "Other" ? <span>Other</span> : <button type="button" class="w-link" onClick={() => p.onPayer(x.symbol)}>{x.symbol}</button>}</span>
                <span class="num"><b>{money(x.net)}</b>{month.net > 0 && ` · ${pctText(x.net / month.net, 0)}`}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4 class="w-h" style={{ padding: "0 10px" }}>By account</h4>
      <ul aria-label="By account" class="w-items">
        {rows.map(([id, v]) => (
          <li key={id} class="w-item">
            <span class="lbl"><i aria-hidden="true" class="w-swatch" style={{ backgroundColor: p.colorOf(id) }} /><span>{p.labelOf(id)}</span></span>
            <span class="num">{money(v)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const FORWARD_REASONS: Record<string, string> = {
  units_changed: "units changed around a payment",
  history_mismatch: "its activity doesn't add up to the units held",
  partial_year: "held under a year",
};

/** Under a partial forward tile: what "holdings" counts, and which are left out and why (the tool text's words). */
function ForwardNote({ uncovered }: { uncovered: ForwardUncovered[] }) {
  const named = uncovered.map((u) => `${u.symbol} in ${u.account}${FORWARD_REASONS[u.reason] ? ` (${FORWARD_REASONS[u.reason]})` : ""}`).join(", ");
  return <div class="w-caption">{`A holding in each account counts once.${named ? ` Left out: ${named}.` : ""}`}</div>;
}

function Tiles({ t, privacy }: { t: Totals; privacy: boolean }) {
  const partial = t.forwardCoverage.covered < t.forwardCoverage.payers;
  return (
    <div>
      <div class="w-tiles three-up">
        <Tile label="Net dividends" value={<Money amount={t.net} currency={t.currency} privacy={privacy} />} />
        <Tile label="Withholding" value={<Money amount={t.withholding} currency={t.currency} privacy={privacy} />} />
        <Tile label="Interest" value={<Money amount={t.interest} currency={t.currency} privacy={privacy} />} />
        <Tile label="Forward 12 months (est.)" value={<><Money amount={t.forward12m} currency={t.currency} privacy={privacy} />
          {partial && <small>{`est. from ${t.forwardCoverage.covered} of ${t.forwardCoverage.payers} holdings`}</small>}</>} />
        <Tile label="Yield on cost (est.)" value={t.yieldOnCost === null ? "—" : pctText(t.yieldOnCost, 1)} />
        <Tile label="Current yield (est.)" value={t.currentYield === null ? "—" : pctText(t.currentYield, 1)} />
      </div>
      <div class="w-caption">{CAPTION}</div>
      {partial && <ForwardNote uncovered={t.forwardUncovered ?? []} />}
    </div>
  );
}

function HomeTile({ label, total, privacy, extra }: { label: string; total: HomeTotalView; privacy: boolean; extra?: preact.ComponentChildren }) {
  const none = notConverted(total);
  return (
    <Tile label={label} value={<>
      {none ? <NativeAmounts total={total} privacy={privacy} /> : <HomeMoney value={cadValue(total)} privacy={privacy} />}
      {!none && <HomeCaption total={total} />}
      {extra}
    </>} />
  );
}

function HomeTiles({ home, uncovered, privacy }: { home: IncomeHome; uncovered: ForwardUncovered[]; privacy: boolean }) {
  const partial = home.forwardCoverage.covered < home.forwardCoverage.payers;
  const y = home.yields;
  return (
    <div>
      <div class="w-tiles three-up">
        <HomeTile label="Net dividends" total={home.tiles.net} privacy={privacy} />
        <HomeTile label="Withholding" total={home.tiles.withholding} privacy={privacy} />
        <HomeTile label="Interest" total={home.tiles.interest} privacy={privacy} />
        <HomeTile label="Forward 12 months (est.)" total={home.tiles.forward12m} privacy={privacy}
          extra={partial ? <small>{`est. from ${home.forwardCoverage.covered} of ${home.forwardCoverage.payers} holdings`}</small> : undefined} />
        {y && <Tile label="Yield on cost (est.)" value={y.yieldOnCost === null ? "—" : pctText(y.yieldOnCost, 1)} />}
        {y && <Tile label="Current yield (est.)" value={y.currentYield === null ? "—" : pctText(y.currentYield, 1)} />}
      </div>
      <div class="w-caption">{CAD_CAPTION}</div>
      <div class="w-caption">Forward and yields are est., after withholding.</div>
      {partial && <ForwardNote uncovered={uncovered} />}
      {!y && <div class="w-caption">Yields are per currency. Show original currencies to see them.</div>}
    </div>
  );
}

function Unmatched({ t, privacy }: { t: Totals; privacy: boolean }) {
  const n = t.unmatchedWithholding.count;
  return (
    <div>
      {`${n} withholding ${n === 1 ? "row" : "rows"} not matched to a dividend (`}
      <Money amount={t.unmatchedWithholding.amount} currency={t.currency} privacy={privacy} />
      {`) ${n === 1 ? "is" : "are"} not included`}
    </div>
  );
}

function YieldsLeftOut({ count }: { count: number }) {
  return <div>{`Yields leave out ${count} ${count === 1 ? "holding" : "holdings"}: a yield can't be told when units changed around a payment, for a holding with under a year of payments, or for dividends in another currency with no rate`}</div>;
}

function IncomeView({ bridge, seed }: { bridge: Bridge; seed: ToolResult | null }) {
  const [page, setPage] = useState<IncomePayload | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [applied, setApplied] = useState<View | null>(null);
  const [privacy, setPrivacy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<{ currency: string; month: string } | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [cadOn, setCadOn] = useCadView(bridge, page?.settings);

  const req = useRef(0);
  const hasData = useRef(false);
  const userLoaded = useRef(false);
  const viewRef = useRef<View | null>(null);
  const appliedRef = useRef<View | null>(null);

  function hydrate(result: ToolResult): boolean {
    const content = result.structuredContent;
    if (result.isError || !isPayload(content)) {
      if (!hasData.current) setLoadFailed(true);
      return false;
    }
    if (userLoaded.current) return true;
    const first = !hasData.current;
    hasData.current = true;
    const next = viewOf(content);
    viewRef.current = next; appliedRef.current = next;
    setView(next); setApplied(next); setPage(content); setLoadFailed(false); setPicked(null);
    if (first) setPrivacy(content.settings?.privacyDefault ?? false);
    return true;
  }
  useEffect(() => bridge.onToolResult((result) => { hydrate(result); }), [bridge]);
  useEffect(() => { if (seed) hydrate(seed); }, []);
  const stalled = useHydrateWatchdog(bridge, () => hasData.current);
  async function retryLoad() {
    setRetrying(true);
    try { hydrate(await bridge.callTool("show_income", bridge.toolArguments())); } catch { if (!hasData.current) setLoadFailed(true); } finally { setRetrying(false); }
  }

  useEffect(() => {
    if (!applied || !page) return;
    // Only the year and the scope kind are shared: no amounts, symbols, ids or account labels.
    const scope = applied.accountType ? accountTypeChip(applied.accountType) : applied.accountId ? "one account" : "all accounts";
    void bridge.updateModelContext(`Viewing income for ${applied.year}: ${scope}${applied.symbol ? `, symbol ${applied.symbol}` : ""}`).catch(() => {});
  }, [bridge, page !== null, applied]);

  if (!page || !view || !applied) {
    if (loadFailed) {
      return (
        <div class="w-shell">
          <Banner tone="warning">Income unavailable right now</Banner>
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
    return <div class="w-shell w-muted">Loading your income…</div>;
  }

  async function load(change: Partial<View>) {
    const next = { ...viewRef.current!, ...change };
    viewRef.current = next; setView(next);
    const id = ++req.current;
    setLoading(true);
    const args: Record<string, unknown> = { year: next.year };
    if (next.accountType) args.accountType = next.accountType;
    else if (next.accountId) args.accountId = next.accountId;
    if (next.symbol) args.symbol = next.symbol;
    try {
      const content = payloadOf(await bridge.callTool("get_income", args));
      if (id !== req.current) return;
      userLoaded.current = true;
      const settled = viewOf(content);
      viewRef.current = settled; appliedRef.current = settled;
      setView(settled); setApplied(settled); setPage(content); setNotice(null); setLoading(false); setPicked(null);
    } catch {
      if (id !== req.current) return;
      const back = appliedRef.current!;
      viewRef.current = back; setView(back);
      setLoading(false); setNotice(LOAD_FAILED);
    }
  }

  const cadMode = cadOn && !!page.home;
  // Turning CAD on over a payload built with it off needs the CAD fields from the server, after the setting is saved.
  function onCadChange(next: boolean) {
    const saved = setCadOn(next);
    if (next && !page!.home) void saved.then((ok) => { if (ok) void load({}); });
  }
  const labelOf = (id: string) => page.accounts.find((a) => a.id === id)?.label ?? "Account";
  // An account keeps its colour across currencies, years and filters: slot = its place in the account list.
  const order = page.accounts.map((a) => a.id);
  const accountColors = assignColors(order, (id) => order.indexOf(id));
  const colorOf = (id: string) => accountColors.get(id) ?? OTHER_COLOR;
  const sendHistory = (symbol: string) => { bridge.sendMessage(`Show my history with ${symbol}`).catch(() => setNotice("Couldn't send that to the chat.")); };
  const years = page.years.includes(page.year) ? page.years : [...page.years, page.year].sort((a, b) => a - b);

  function chartFor(currency: string) {
    const months = cadMode ? page!.home!.months : page!.months.filter((m) => m.currency === currency);
    // The five largest accounts by the year's income keep their own colour; the rest share one.
    const totals = new Map<string, number>();
    for (const m of months) for (const [id, v] of Object.entries(m.byAccount)) totals.set(id, (totals.get(id) ?? 0) + v);
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
    const head = ranked.slice(0, SERIES_ACCOUNTS);
    const grouped = ranked.length > head.length;
    const series: Array<{ key: string; label: string; color: string }> = head.map((id) => ({ key: id, label: labelOf(id), color: colorOf(id) }));
    if (grouped) series.push({ key: OTHER, label: "Other accounts", color: OTHER_COLOR });
    const seriesOf = (id: string) => (head.includes(id) ? id : OTHER);
    const bars = MONTHS.map((name, i) => {
      const key = `${page!.year}-${String(i + 1).padStart(2, "0")}`;
      const m = months.find((x) => x.month === key);
      return { key, label: name.slice(0, 3), parts: m ? Object.entries(m.byAccount).map(([id, value]) => ({ series: seriesOf(id), value })) : [] };
    });
    return { months, series, bars };
  }

  const homePayerColumns: Column<IncomeHome["topPayers"][number]>[] = [
    { key: "symbol", label: "Payer", mobile: "primary", sortValue: (r) => r.symbol, render: (r) => <button type="button" class="w-link" onClick={() => sendHistory(r.symbol)}>{r.symbol}</button> },
    { key: "net", label: "Net (CAD)", align: "right", sortValue: (r) => r.net, render: (r) => <HomeMoney value={{ amount: r.net, estimated: r.estimated, rate: null, rateDate: null, native: { amount: r.net, currency: "CAD" } }} privacy={privacy} /> },
    { key: "yoc", label: "Yield on cost (est.)", align: "right", sortValue: (r) => r.yieldOnCost, render: (r) => (r.yieldOnCost === null ? "—" : pctText(r.yieldOnCost, 1)) },
  ];
  const payerColumns: Column<IncomePayload["topPayers"][number]>[] = [
    { key: "symbol", label: "Payer", mobile: "primary", sortValue: (r) => r.symbol, render: (r) => <button type="button" class="w-link" onClick={() => sendHistory(r.symbol)}>{r.symbol}</button> },
    { key: "currency", label: "Currency", sortValue: (r) => r.currency, render: (r) => r.currency },
    // Native amounts: a CAD net and a USD net are different units, so they are sorted within each currency.
    { key: "net", label: "Net", align: "right", sortValue: (r) => r.net, within: { by: (r) => r.currency, note: "Net is sorted within each currency, not across them." }, render: (r) => <Money amount={r.net} currency={r.currency} privacy={privacy} /> },
    { key: "yoc", label: "Yield on cost (est.)", align: "right", sortValue: (r) => r.yieldOnCost, render: (r) => (r.yieldOnCost === null ? "—" : pctText(r.yieldOnCost, 1)) },
  ];
  const depositColumns: Column<IncomePayload["contributions"][number]>[] = [
    { key: "type", label: "Account type", mobile: "primary", render: (r) => r.accountType },
    { key: "currency", label: "Currency", render: (r) => r.currency },
    { key: "amount", label: "Deposits", align: "right", render: (r) => <Money amount={r.amount} currency={r.currency} privacy={privacy} /> },
  ];
  const withheld = page.withholding.filter((w) => w.rate !== null && w.withholding > 0);
  const empty = page.months.length === 0;
  const currencies = page.currencyTotals.map((t) => t.currency);
  const shown = cadMode ? ({ currency: "CAD" } as Totals) : (page.currencyTotals.find((t) => t.currency === currency) ?? page.currencyTotals[0] ?? null);
  const topPayers = cadMode ? page.home!.topPayers : page.topPayers;
  const unmatched = page.currencyTotals.filter((t) => t.unmatchedWithholding.count > 0);
  const yieldsLeftOut = cadMode ? page.currencyTotals.reduce((sum, t) => sum + (t.yieldsLeftOut ?? 0), 0) : shown?.yieldsLeftOut ?? 0;
  const yieldsConverted = cadMode ? page.currencyTotals.reduce((sum, t) => sum + (t.yieldsConverted ?? 0), 0) : shown?.yieldsConverted ?? 0;

  return (
    <main class="w-shell">
      <h2 class="w-sr">Income</h2>
      <ViewControls privacy={privacy} onPrivacy={setPrivacy} cadOn={cadOn} onCadChange={onCadChange} />
      <div class="w-row" style={{ justifyContent: "space-between" }}>
        <span class="w-row">
          <select aria-label="Year" value={String(view.year)} disabled={loading} onChange={(e) => void load({ year: Number((e.target as HTMLSelectElement).value) })}>
            {years.map((y) => <option key={y} value={String(y)}>{y}</option>)}
          </select>
          <select aria-label="Account" value={view.accountType ? ACCOUNT_TYPE_OPTION : view.accountId} disabled={loading} onChange={(e) => {
            const accountId = (e.target as HTMLSelectElement).value;
            if (accountId !== ACCOUNT_TYPE_OPTION) void load({ accountId, accountType: null });
          }}>
            <option value="">All accounts</option>
            {view.accountType && <option value={ACCOUNT_TYPE_OPTION}>{accountTypeChip(view.accountType)}</option>}
            {page.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </span>
      </div>
      {(view.accountType || view.symbol) && (
        <div class="w-row">
          {view.accountType && <FilterChip text={accountTypeChip(view.accountType)} disabled={loading} onRemove={() => void load({ accountType: null })} />}
          {view.symbol && <FilterChip text={view.symbol} disabled={loading} onRemove={() => void load({ symbol: "" })} />}
        </div>
      )}
      <div aria-busy={loading ? "true" : "false"} style={{ display: "grid", gap: "12px" }}>
        {empty && <div class="w-muted">{`No dividends recorded in ${page.year}`}</div>}
        {!cadMode && currencies.length > 1 && shown && <div><Segmented label="Currency" options={currencies} value={shown.currency} onChange={(c) => { setCurrency(c); setPicked(null); }} /></div>}
        {shown && (() => {
          const t = shown;
          const { months, series, bars } = chartFor(t.currency);
          const chosen = picked?.currency === t.currency ? months.find((m) => m.month === picked.month) : undefined;
          const pick = (key: string) => setPicked(chosen?.month === key || !months.some((m) => m.month === key) ? null : { currency: t.currency, month: key });
          return (
            <div key={t.currency} role="group" aria-label={`${t.currency} income`} style={{ display: "grid", gap: "14px" }}>
              {cadMode ? <HomeTiles home={page.home!} uncovered={page.currencyTotals.flatMap((c) => c.forwardUncovered ?? [])} privacy={privacy} /> : <Tiles t={t} privacy={privacy} />}
              {months.length > 0 && (
                <div>
                  <h3 class="w-h" style={{ marginBottom: "6px" }}>By month</h3>
                  <StackedBarChart bars={bars} series={series} currency={t.currency} privacy={privacy} label={`${t.currency} income by month`} height={140}
                    selected={chosen?.month ?? null} onBar={pick} />
                  {!chosen && <div class="w-caption">Select a month for its payers and accounts</div>}
                </div>
              )}
              {chosen && <MonthDetail currency={t.currency} month={chosen} year={page.year} privacy={privacy} labelOf={labelOf} colorOf={colorOf} onPayer={sendHistory} />}
            </div>
          );
        })()}
      </div>
      {topPayers.length > 0 && (
        <section aria-label="Top payers">
          <h3 class="w-h">Top payers</h3>
          {cadMode
            ? <DataTable label="Top payers" rows={page.home!.topPayers.slice(0, TOP_PAYERS)} columns={homePayerColumns} rowKey={(r) => r.symbol} tieBreak={(r) => r.symbol} />
            : <DataTable label="Top payers" rows={page.topPayers.slice(0, TOP_PAYERS)} columns={payerColumns} rowKey={(r) => `${r.symbol}|${r.currency}`} tieBreak={(r) => `${r.symbol}|${r.currency}`} />}
          {topPayers.length > TOP_PAYERS && <small class="w-muted">{`Top ${TOP_PAYERS} of ${topPayers.length} payers`}</small>}
        </section>
      )}
      {withheld.length > 0 && (
        <section aria-label="Withholding">
          <h3 class="w-h">Withholding by account type</h3>
          <ul aria-label="Withholding by account type" class="w-items">
            {withheld.map((w) => (
              <li key={`${w.accountType}|${w.currency}`} class="w-item">
                <span class="lbl" style={{ whiteSpace: "normal" }}>{`${w.accountType}: ${rateText(w.rate!)} withheld on ${w.currency} dividends`}</span>
                <small class="num"><Money amount={w.withholding} currency={w.currency} privacy={privacy} />{" of "}<Money amount={w.gross} currency={w.currency} privacy={privacy} /></small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {page.contributions.length > 0 && (
        <section aria-label="Deposits">
          <h3 class="w-h">Deposits this year</h3>
          <DataTable label="Deposits this year" rows={page.contributions} columns={depositColumns} rowKey={(r) => `${r.accountType}|${r.currency}`} />
        </section>
      )}
      <footer class="w-notes">
        {page.syncing.length > 0 && <div>Some accounts are still syncing, so these figures may be incomplete.</div>}
        {cadMode ? unmatched.map((t) => <Unmatched key={t.currency} t={t} privacy={privacy} />) : shown && shown.unmatchedWithholding.count > 0 && <Unmatched t={shown} privacy={privacy} />}
        {yieldsLeftOut > 0 && <YieldsLeftOut count={yieldsLeftOut} />}
        {yieldsConverted > 0 && <div>Yields use dividends paid in another currency, converted at the Bank of Canada rate on each pay date (est.)</div>}
        <div>{NOT_ADVICE}</div>
      </footer>
      {notice && <Banner tone="info">{notice}</Banner>}
      <BrandFooter advice={false} />
    </main>
  );
}

export function Income({ bridge }: { bridge: Bridge }) {
  return <WidgetGuard bridge={bridge} showTool="show_income">{(seed) => <IncomeView bridge={bridge} seed={seed} />}</WidgetGuard>;
}
