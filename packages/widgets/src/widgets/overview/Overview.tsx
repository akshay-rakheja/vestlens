import { useEffect, useRef, useState } from "preact/hooks";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { WidgetGuard, useHydrateWatchdog } from "../../kit/resilience";
import { AllocationBar } from "../../kit/charts/AllocationBar";
import { AreaChart } from "../../kit/charts/AreaChart";
import { IntradayChart } from "../../kit/charts/IntradayChart";
import { Banner, BrandFooter, Chip, InfoPopover, Money, Pill, Segmented, SymbolText, Tile, ViewControls } from "../../kit/components";
import { formatDateTime, formatMoney, formatPercent, formatPoints, formatShortDate, formatSignedMoney, formatSignedPercent } from "../../kit/format";
import { HISTORY_BUILDING, historyNotes } from "../../kit/history-notes";
import { useCadView } from "../../kit/currency-switch";
import { SeriesCaption, flowNotConvertedText, HomeCaption, HomeMoney, NOT_CONVERTED, NativeAmounts, byCurrency, cadValue, notConverted, type HomeTotalView } from "../../kit/home-money";
import type { IntradayPayload, OverviewPayload, OverviewSeries, Period } from "./types";

const PERIOD_LABELS = ["1D", "1W", "1M", "3M", "YTD", "1Y", "All"] as const;

const toPeriod = (label: (typeof PERIOD_LABELS)[number]): Period => (label === "All" ? "ALL" : label);
const toLabel = (period: Period) => (period === "ALL" ? "All" : period) as (typeof PERIOD_LABELS)[number];

// The performance widget has no 1D/1W; map those to its shortest period.
const performanceLabel = (period: Period) => (period === "1D" || period === "1W" ? "1M" : toLabel(period));

// Toronto calendar date, to tell a live session from the last session shown after hours.
const torontoToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/** The CAD bar's basis (every holding and cash line converted): with a negative cash slice the shares are of net value and can be over 100%. */
const allocationBasis = (slices: Array<{ fraction: number }>) => (slices.some((s) => s.fraction < 0)
  ? "Shares of net value after a margin debit (the brokerage total), so they can be over 100%."
  : "Shares of total value, cash included.");
/**
 * The native bar covers only the holdings and cash in its currency, in accounts with a brokerage total (the API's
 * summary.allocation), so its caption says that rather than "total value" (review 8).
 */
const nativeAllocationBasis = (currency: string | null, slices: Array<{ fraction: number }>) => {
  const cur = currency ?? "its currency's";
  const scope = `${cur} holdings and ${cur} cash in accounts with a brokerage total; other currencies aren't in this bar.`;
  return slices.some((s) => s.fraction < 0)
    ? `Shares of net ${cur} value after a margin debit (the brokerage total), so they can be over 100%: ${scope}`
    : `Shares of ${scope}`;
};

// null = not loaded (or not 1D); "unavailable" = fall back to the daily chart with a note.
type IntradayState = IntradayPayload | "unavailable" | null;

function OverviewView({ bridge, seed }: { bridge: Bridge; seed: ToolResult | null }) {
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [series, setSeries] = useState<OverviewSeries | null>(null);
  const [privacy, setPrivacy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [intraday, setIntraday] = useState<IntradayState>(null);
  const [cadOn, setCadOn] = useCadView(bridge, data?.settings);

  const [pending, setPending] = useState<{ period: Period; benchmark: string } | null>(null);
  const requestId = useRef(0);
  const userLoaded = useRef(false);
  const hydrated = useRef(false);
  const view = useRef<{ period: Period; benchmark: string } | null>(null);
  const applied = useRef<{ period: Period; benchmark: string } | null>(null);

  const hasData = useRef(false);
  // Returns false when the result carries no usable overview payload.
  function hydrate(result: ToolResult): boolean {
    const content = result.structuredContent as OverviewPayload | undefined;
    if (result.isError || !content || !content.summary || !content.series) {
      // Before any data the widget would otherwise wait forever; afterwards keep the current view.
      if (!hasData.current) setLoadFailed(true);
      return false;
    }
    hasData.current = true;
    setLoadFailed(false);
    setData(content);
    if (!hydrated.current) { hydrated.current = true; setPrivacy(content.settings?.privacyDefault ?? false); }
    if (!userLoaded.current) {
      const next = { period: content.series.period, benchmark: content.series.benchmark.key };
      view.current = next; applied.current = next;
      setSeries(content.series);
      setIntraday(null);
      if (content.series.period === "1D") void loadIntraday(requestId.current);
    }
    return true;
  }
  // A response for an older request (the user moved to another view meanwhile) is discarded.
  async function loadIntraday(id: number) {
    let next: IntradayState = "unavailable";
    try {
      const result = await bridge.callTool("get_intraday", {});
      const content = result.structuredContent as IntradayPayload | undefined;
      if (!result.isError && content && content.drawn && Array.isArray(content.points) && content.points.length >= 2) next = content;
    } catch { /* behaves like drawn: false */ }
    if (id === requestId.current) setIntraday(next);
  }
  useEffect(() => bridge.onToolResult((result) => { hydrate(result); }), [bridge]);
  useEffect(() => { if (seed) hydrate(seed); }, []);
  const stalled = useHydrateWatchdog(bridge, () => hasData.current);
  async function retryLoad() {
    setRetrying(true);
    try {
      hydrate(await bridge.callTool("show_portfolio", bridge.toolArguments()));
    } catch {
      if (!hasData.current) setLoadFailed(true);
    } finally {
      setRetrying(false);
    }
  }
  useEffect(() => {
    if (series) void bridge.updateModelContext(`Viewing portfolio overview: period ${series.period}, benchmark ${series.benchmark.name}.`).catch(() => {});
  }, [bridge, series?.period, series?.benchmark.key]);

  if ((!data || !series) && loadFailed) {
    return (
      <div class="w-shell">
        <Banner tone="warning">Couldn't load your portfolio.</Banner>
        <button type="button" class="w-chip" disabled={retrying} onClick={() => void retryLoad()}>Try again</button>
      </div>
    );
  }
  if ((!data || !series) && stalled) return (
      <div class="w-shell">
        <Banner tone="info">Still loading…</Banner>
        <button type="button" class="w-chip" disabled={retrying} onClick={() => void retryLoad()}>Try again</button>
      </div>
    );
  if (!data || !series) return <div class="w-shell w-muted">Loading your portfolio…</div>;
  if (data.portfolio.connectionRequired) return <div class="w-shell">Connect Wealthsimple in the portfolio dashboard to see your accounts here.</div>;

  const { summary } = data;
  const notInTotal = managedNotInTotal(data.portfolio.accounts);
  // With the switch off, or on an older payload without CAD figures, the overview renders as before.
  const home = cadOn ? summary.home : undefined;
  const primary = summary.primaryCurrency ?? "CAD";
  const total = summary.totals.find((t) => t.currency === primary);
  const others = summary.totals.filter((t) => t.currency !== primary);
  const change = summary.dayChange.find((d) => d.currency === primary);
  // Day changes of holdings in other currencies (e.g. US stocks in a CAD account) get their own line.
  const otherChanges = summary.dayChange.filter((d) => d.currency !== primary && d.fraction !== null);
  const unrealized = summary.unrealizedGain.find((u) => u.currency === primary);
  const otherUnrealized = summary.unrealizedGain.filter((u) => u.currency !== primary);
  const costCoverage = summary.unrealizedCoverage;
  const unrealizedPartial = !!costCoverage && costCoverage.withCostBasis < costCoverage.holdings;
  // Prefer the time-weighted return (excludes deposits); otherwise the value change.
  const twrValue = series.investmentReturn?.value ?? null;
  const twrBenchmark = series.benchmarkReturnTwr?.value ?? null;
  const twrEstimated = twrValue !== null && (!!series.investmentReturn?.estimated || (twrBenchmark !== null && !!series.benchmarkReturnTwr?.estimated));
  // With a time-weighted return the tile never mixes bases: a missing time-weighted benchmark shows "—".
  // A value change includes deposits, so it is never compared with an index: without a
  // time-weighted return the tile shows "—" and says why.
  const diff = twrValue !== null && twrBenchmark !== null ? twrValue - twrBenchmark : null;
  const currentYear = (series.points.at(-1)?.date ?? data.portfolio.generatedAt).slice(0, 4);
  // A late first point is labelled "since". The time-weighted return carries its own span.
  const valueSpanLabel = series.spanIsPartial && series.spanStart ? `since ${formatShortDate(series.spanStart, currentYear)}` : toLabel(series.period);
  const twrSpanLabel = series.returnSpan
    ? (series.returnSpan.partial && series.returnSpan.since ? `since ${formatShortDate(series.returnSpan.since, currentYear)}` : toLabel(series.period))
    : valueSpanLabel;
  const spanLabel = twrValue !== null ? twrSpanLabel : valueSpanLabel;
  const tilePoints = diff === null ? "—" : `${formatPoints(diff)}${twrValue !== null && twrEstimated ? " est." : ""}`;
  // A payload that carries the time-weighted fields but no value says plainly that the chip is a value change.
  const valueChangeLabel = series.investmentReturn ? (spanLabel.startsWith("since") ? `Value change ${spanLabel}` : `${spanLabel} value change`) : spanLabel;
  const notes = historyNotes({
    qualities: data.history?.qualities ?? [],
    earliest: data.history?.earliest ?? null,
    accounts: data.portfolio.accounts.flatMap((a) => (a.id ? [{ id: a.id, label: a.classification?.label }] : [])),
    points: series.points,
    currentYear: (series.points.at(-1)?.date ?? data.portfolio.generatedAt).slice(0, 4),
  });
  const latestSync = data.portfolio.accounts.map((a) => a.freshness?.holdingsLastSyncedAt).filter((v): v is string => !!v).sort().at(-1);
  // A just-linked account's first history read is still running (the 10-minute catch-up).
  const building = data.history?.building === true;
  const syncNote = latestSync ? `Holdings update once a day, last ${formatDateTime(latestSync)} · ` : "";

  async function loadSeries(period?: Period, benchmark?: string): Promise<boolean> {
    const base = view.current ?? { period: series!.period, benchmark: series!.benchmark.key };
    const next = { period: period ?? base.period, benchmark: benchmark ?? base.benchmark };
    view.current = next;
    const id = ++requestId.current;
    setIntraday(null);
    setPending(next);
    try {
      const result = await bridge.callTool("get_overview_series", next);
      if (id !== requestId.current) return false;
      if (result.isError || !result.structuredContent) throw new Error("failed");
      applied.current = next; userLoaded.current = true;
      setSeries(result.structuredContent as OverviewSeries); setPending(null); setNotice(null);
      if (next.period === "1D") void loadIntraday(id);
      return true;
    } catch {
      if (id !== requestId.current) return false;
      view.current = applied.current; setPending(null);
      setNotice("Couldn't load that view. Showing the previous one.");
      return false;
    }
  }
  async function changeBenchmark(key: string) {
    if (!(await loadSeries(undefined, key))) return;
    const saveFailed = () => setNotice("Couldn't save default benchmark.");
    bridge.callTool("save_portfolio_settings", { benchmark: key }).then((r) => { if (r.isError) saveFailed(); }, saveFailed);
  }
  // The series follows the saved setting: CAD charts (`series.home`) only with a USD account. Switching
  // reloads it once the setting is saved, and only when the shown series was built the other way.
  function onCadChange(next: boolean) {
    const saved = setCadOn(next);
    const stale = next ? !series!.home && summary.totals.some((t) => t.currency === "USD") : !!series!.home;
    if (stale) void saved.then((ok) => { if (ok) void loadSeries(); });
  }
  const homeAllocation = home?.allocation && home.allocation.length > 0 ? home.allocation : null;
  const loading = pending !== null;
  const todayIso = torontoToday();
  // A weekend or holiday quote is the last session's move: say which session.
  const dayWord = summary.dayChangeSession && summary.dayChangeSession !== todayIso ? `on ${formatShortDate(summary.dayChangeSession, todayIso.slice(0, 4))}` : "today";
  const live = series.period === "1D" && intraday && intraday !== "unavailable" ? intraday : null;
  const liveNote = live
    ? `${live.label || "Estimated from live prices"}${live.sessionDate && live.sessionDate !== todayIso ? ` · ${formatShortDate(live.sessionDate, todayIso.slice(0, 4))}` : ""}${live.coverage < 1 ? ` · ${Math.round(live.coverage * 100)}% of holdings priced live` : ""}`
    : series.period === "1D" && intraday === "unavailable" ? "Live prices unavailable" : null;
  const shownPeriod = pending?.period ?? series.period;
  const shownBenchmark = pending?.benchmark ?? series.benchmark.key;

  return (
    <main class="w-shell">
      <ViewControls privacy={privacy} onPrivacy={setPrivacy} cadOn={cadOn} onCadChange={onCadChange} />
      <div class="w-row" style={{ justifyContent: "space-between" }}>
        <span class="w-muted">{home ? "Total value in CAD" : "Total value as your brokerage reports it"}</span>
      </div>
      {data.portfolio.cache?.stale && <Banner tone="warning">The brokerage could not be reached. Showing data last read {formatDateTime(data.portfolio.cache.loadedAt)}.</Banner>}
      <div class="w-big">{home && notConverted(home.total) ? byCurrency(home.total.excluded).map((p, i) => <span key={p.currency}>{i > 0 ? " · " : ""}<Money amount={p.amount} currency={p.currency} privacy={privacy} /></span>)
        : home ? <HomeMoney value={cadValue(home.total)} privacy={privacy} />
        : total ? <Money amount={total.amount} currency={total.currency} privacy={privacy} /> : "Value unavailable"}</div>
      {home && notConverted(home.total) && <p class="w-caption">{NOT_CONVERTED}</p>}
      {home?.includesUnreported && <p class="w-caption">Includes accounts without a brokerage total (valued from holdings)</p>}
      {notInTotal.length > 0 && <p class="w-caption">{notInTotalNote(notInTotal)}</p>}
      <div class="w-row">
        {home && notConverted(home.dayChange)
          ? <span><Pill tone="neutral">{privacy ? "" : `${byCurrency(home.dayChange.excluded).map((p) => formatSignedMoney(p.amount, p.currency)).join(" · ")} `}{dayWord} est.</Pill>
            <small class="w-muted" style={{ display: "block" }}>{NOT_CONVERTED}</small></span>
        : home ? (home.dayChangeFraction !== null
          ? <Pill tone={home.dayChange.amount < 0 ? "down" : home.dayChange.amount > 0 ? "up" : "neutral"}>{home.dayChange.amount < 0 ? "▼ " : home.dayChange.amount > 0 ? "▲ " : ""}{privacy ? "" : `${formatSignedMoney(home.dayChange.amount, "CAD")} · `}{formatPercent(Math.abs(home.dayChangeFraction))} {dayWord} est.{home.dayChangeCoverage < 1 ? " · partial" : ""}</Pill>
          : <Pill tone="neutral">Today's change unavailable</Pill>)
        : change && change.fraction !== null
          ? <Pill tone={change.amount < 0 ? "down" : change.amount > 0 ? "up" : "neutral"}>{change.amount < 0 ? "▼ " : change.amount > 0 ? "▲ " : ""}{privacy ? "" : `${formatSignedMoney(change.amount, primary)} · `}{formatPercent(Math.abs(change.fraction))} {dayWord} est.{change.coverage < 1 ? " · partial" : ""}</Pill>
          : <Pill tone="neutral">Today's change unavailable</Pill>}
        {twrValue !== null
          ? <><Chip>{spanLabel.startsWith("since") ? `Return ${spanLabel}` : `${spanLabel} return`} {formatSignedPercent(twrValue, 1)}{series.investmentReturn?.estimated ? " est." : ""}</Chip>
            <InfoPopover title="Time-weighted return" body="How your investments performed, excluding money you added or withdrew. The chart shows total value, which includes deposits." /></>
          : series.portfolioReturn !== null && <Chip>{valueChangeLabel} {formatSignedPercent(series.portfolioReturn, 1)}</Chip>}
        {!home && others.map((t) => <Chip key={t.currency}>+ {privacy ? "••••" : formatMoney(t.amount, t.currency)} in {t.currency}</Chip>)}
        {!home && otherChanges.map((d) => <Chip key={`day-${d.currency}`}>{d.amount < 0 ? "▼ " : d.amount > 0 ? "▲ " : ""}{privacy ? "" : `${formatSignedMoney(d.amount, d.currency)} · `}{formatPercent(Math.abs(d.fraction!))} {dayWord} in {d.currency} est.{d.coverage < 1 ? " · partial" : ""}</Chip>)}
      </div>
      {home?.dayChangeIncludesFx && home.dayChangeFraction !== null && <p class="w-caption">{`The CAD change includes the day's currency move; the breakdown shows each currency's own move.`}</p>}
      {home && <details class="w-breakdown">
        <summary>Breakdown by currency</summary>
        <div>
          {summary.totals.map((t) => {
            const day = summary.dayChange.find((d) => d.currency === t.currency && d.fraction !== null);
            return <div key={t.currency} class="w-list-row"><span>{t.currency}</span><span class="v"><Money amount={t.amount} currency={t.currency} privacy={privacy} /></span>
              {day && <small>{privacy ? "" : `${formatSignedMoney(day.amount, day.currency)} · `}{formatSignedPercent(day.fraction!, 1)} {dayWord} est.{day.coverage < 1 ? " · partial" : ""}</small>}</div>;
          })}
          {summary.dayChange.filter((d) => d.fraction !== null && !summary.totals.some((t) => t.currency === d.currency)).map((d) =>
            <div key={`day-${d.currency}`} class="w-list-row"><span>{d.currency} holdings</span><small>{privacy ? "" : `${formatSignedMoney(d.amount, d.currency)} · `}{formatSignedPercent(d.fraction!, 1)} {dayWord} est.{d.coverage < 1 ? " · partial" : ""}</small></div>)}
          {summary.unrealizedGain.length > 0 && <div class="w-list-row"><span>Unrealized gain</span><small>{summary.unrealizedGain.map((u) => privacy ? "••••" : formatSignedMoney(u.amount, u.currency)).join(" · ")}</small></div>}
          {summary.cash.length > 0 && <div class="w-list-row"><span>Cash</span><small>{privacy ? "••••" : summary.cash.map((c) => formatMoney(c.amount, c.currency)).join(" · ")}</small></div>}
        </div>
      </details>}
      <Segmented label="Period" options={PERIOD_LABELS} value={toLabel(shownPeriod)} onChange={(label) => void loadSeries(toPeriod(label))} />
      <div class="w-row w-muted">
        <label>Compare with <select aria-label="Compare with" value={shownBenchmark} onChange={(e) => void changeBenchmark((e.target as HTMLSelectElement).value)}>
          {data.benchmarks.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
        </select></label>
        <InfoPopover title={series.benchmark.name} body={`${series.benchmark.explainer}${series.fxNote ? ` ${series.fxNote}` : ""}`} />
      </div>
      <div aria-busy={loading ? "true" : "false"}>
        {live
          ? <IntradayChart label="Value today (estimated)" points={live.points} currency={live.currency ?? primary} privacy={privacy} />
          : <AreaChart label={`Value ${toLabel(series.period)}`} points={series.points} currency={series.currency ?? primary} privacy={privacy} seriesLabel="Your investments’ value (includes deposits; Cash left out)" {...(building ? { emptyText: HISTORY_BUILDING } : {})} />}
      </div>
      {series.home && (series.home.estimated
        ? <>
          <SeriesCaption estimated={series.home.estimated} days={series.home.notConvertedDays} accounts={series.home.notConvertedAccounts} />
          <span class="w-muted">USD values use each day's Bank of Canada rate{series.home.notConvertedDays > 0 ? "; days without a recent rate are left out of the chart" : ""}.</span>
        </>
        : series.home.notConvertedAccounts > 0 && <p class="w-caption">{`${NOT_CONVERTED}: the chart shows ${series.currency} accounts only`}</p>)}
      {series.home?.flowNotConverted && <span class="w-muted">{flowNotConvertedText(series.home.flowNotConverted)}</span>}
      {/* Value includes deposits, so it is never drawn against an index; the fair comparison is the time-weighted tile. */}
      {!live && <span class="w-muted">Compare your return with the index in the tile below or under vs Benchmark in Performance.</span>}
      {liveNote && <span class="w-muted">{liveNote}</span>}
      {notes.earliest && <span class="w-muted">History rebuilt from your activity since {formatShortDate(notes.earliest, notes.currentYear)}</span>}
      {notes.snapshotsOnly && <div class="w-row w-muted"><span>Some accounts show history only since their first snapshot</span><InfoPopover title="History coverage" body={notes.details} /></div>}
      {notes.estimated && <div class="w-row w-muted"><span>Some history is estimated</span>{notes.drift && <span>· rebuilt value {notes.drift}</span>}{!notes.snapshotsOnly && notes.details && <InfoPopover title="History coverage" body={notes.details} />}</div>}
      {series.benchmark.unavailableReason && <span class="w-muted">{series.benchmark.unavailableReason}</span>}
      {notice && <Banner tone="info">{notice}</Banner>}
      <div class="w-tiles">
        {home ? <Tile label="Unrealized gain (at today's rate)" tone={(notConverted(home.unrealizedGain) ? byCurrency(home.unrealizedGain.excluded).reduce((s, p) => s + p.amount, 0) : home.unrealizedGain.amount) < 0 ? "down" : "up"} value={<>
          {notConverted(home.unrealizedGain) ? <NativeAmounts total={home.unrealizedGain} privacy={privacy} signed />
            : summary.unrealizedGain.length > 0 || home.unrealizedGain.excluded.length > 0 ? <HomeMoney value={cadValue(home.unrealizedGain)} privacy={privacy} signed /> : "—"}
          <small class="w-muted">Excludes currency movement since purchase.</small>
          {unrealizedPartial && <small class="w-muted">{`from ${costCoverage!.withCostBasis} of ${costCoverage!.holdings} holdings · partial`}</small>}
        </>} />
        : <Tile label="Unrealized gain" tone={unrealized && unrealized.amount < 0 ? "down" : "up"} value={<>
          {unrealized ? <Money amount={unrealized.amount} currency={primary} signed privacy={privacy} /> : "—"}
          {otherUnrealized.map((u) => <small key={u.currency} class="w-muted">{`${u.amount < 0 ? "−" : "+"} ${privacy ? "••••" : formatMoney(Math.abs(u.amount), u.currency)} in ${u.currency}`}</small>)}
          {unrealizedPartial && <small class="w-muted">{`from ${costCoverage!.withCostBasis} of ${costCoverage!.holdings} holdings · partial`}</small>}
        </>} />}
        <Tile label={`vs ${series.benchmark.name} (${spanLabel})`} tone={diff === null ? "neutral" : diff < 0 ? "down" : "up"} value={<>{tilePoints}{twrValue === null && <small class="w-muted">{building ? "history still loading" : "needs deposit history"}</small>}{series.benchmark.basis && <small class="w-muted">{series.benchmark.basis}</small>}</>} />
        <Tile label={summary.cashNetOfMargin ? "Cash, net of margin" : "Cash"} value={home ? (notConverted(home.cash) ? <NativeAmounts total={home.cash} privacy={privacy} /> : summary.cash.length ? <HomeMoney value={cadValue(home.cash)} privacy={privacy} /> : "—") : summary.cash.length ? (privacy ? "••••" : summary.cash.map((c) => formatMoney(c.amount, c.currency)).join(" · ")) : "—"} />
        <Tile label="Largest holding" value={summary.largestHolding ? <><SymbolText symbol={summary.largestHolding.symbol} />{` ${formatPercent(summary.largestHolding.fraction, 1)}${summary.largestHolding.estimated ? " est." : ""}`}{summary.largestHolding.basis && <small class="w-muted">{summary.largestHolding.basis}</small>}</> : "—"} />
      </div>
      <div class="w-row">
        <button type="button" class="w-chip w-nav" onClick={() => void bridge.sendMessage(`Show my performance for ${performanceLabel(series.period)}`).catch(() => setNotice("Couldn't send that to the chat."))}>Performance</button>
        <button type="button" class="w-chip w-nav" onClick={() => void bridge.sendMessage("Show my recent activity").catch(() => setNotice("Couldn't send that to the chat."))}>Activity</button>
        <button type="button" class="w-chip w-nav" onClick={() => void bridge.sendMessage("Show my holdings").catch(() => setNotice("Couldn't send that to the chat."))}>Holdings</button>
        <button type="button" class="w-chip w-nav" onClick={() => void bridge.sendMessage("Show my allocation").catch(() => setNotice("Couldn't send that to the chat."))}>Allocation</button>
        <button type="button" class="w-chip w-nav" onClick={() => void bridge.sendMessage("Show my dividend income").catch(() => setNotice("Couldn't send that to the chat."))}>Income</button>
      </div>
      {homeAllocation ? <><h2 class="w-h">{`Allocation (CAD, all holdings)${home!.allocationEstimated ? " est." : ""}`}</h2><AllocationBar label="Allocation" slices={homeAllocation} /><p class="w-caption">{allocationBasis(homeAllocation)}</p>
        {(home!.allocationNotConverted ?? 0) > 0 && <p class="w-caption">{`${home!.allocationNotConverted} not converted`}</p>}</>
      : summary.allocation.length > 0 && <><h2 class="w-h">{summary.allocationCurrency ? `Allocation (${summary.allocationCurrency} holdings)` : "Allocation"}</h2><AllocationBar label="Allocation" slices={summary.allocation} /><p class="w-caption">{nativeAllocationBasis(summary.allocationCurrency, summary.allocation)}</p></>}
      {summary.groups.length > 0 && <h2 class="w-h">Accounts</h2>}
      <div>
        {summary.groups.map((group) => {
          const unavailable = group.unavailableCount ?? 0;
          const found = home?.groups.find((g) => g.key === group.key)?.value;
          // A group with nothing converted keeps its native value.
          const groupHome = found && !notConverted(found) ? found : undefined;
          const dayFraction = group.dayChangeCoverage !== undefined && group.dayChangeCoverage < 0.8 ? null : group.dayChangeFraction;
          return (
          <button key={group.key} type="button" class="w-list-row" style={{ width: "100%", background: "transparent", border: 0, borderTop: "1px solid var(--line)", textAlign: "left", cursor: "pointer" }} onClick={() => void bridge.sendMessage(`Show me my ${group.label} accounts`).catch(() => setNotice("Couldn't send that to the chat."))}>
            <span>{group.label}</span><span class="v">{groupHome ? <HomeMoney value={cadValue(groupHome)} privacy={privacy} /> : unavailable >= group.accountCount ? "—" : <Money amount={group.value} currency={group.currency} privacy={privacy} />}</span>
            <small>{group.accountCount} account{group.accountCount === 1 ? "" : "s"} · {group.holdingCount} holdings{group.currency !== (groupHome ? "CAD" : primary) ? ` · ${group.currency}` : ""}{unavailable > 0 && !groupHome ? ` · value unavailable for ${unavailable} account${unavailable === 1 ? "" : "s"}` : ""}</small>
            <span class={`d ${dayFraction === null ? "" : dayFraction < 0 ? "down" : "up"}`}>{dayFraction === null ? "—" : `${dayFraction < 0 ? "▼" : "▲"} ${formatPercent(Math.abs(dayFraction), 1)} est.`}</span>
          </button>
          );
        })}
      </div>
      {home
        ? <div class="w-foot">{syncNote}View built {formatDateTime(data.portfolio.generatedAt)}<HomeCaption total={home.total} /></div>
        : <div class="w-foot">{syncNote}View built {formatDateTime(data.portfolio.generatedAt)} · Values stay in their own currency.</div>}
      <BrandFooter />
    </main>
  );
}

export function Overview({ bridge }: { bridge: Bridge }) {
  return <WidgetGuard bridge={bridge} showTool="show_portfolio">{(seed) => <OverviewView bridge={bridge} seed={seed} />}</WidgetGuard>;
}

/** Managed portfolios SnapTrade reports without a value: the total leaves them out (managedNotInTotal in the API). */
export function managedNotInTotal(accounts: OverviewPayload["portfolio"]["accounts"]): string[] {
  return [...new Set(accounts
    .filter((a) => a.classification?.includedInPortfolioTotal && (a.unifiedType ?? "").toUpperCase().startsWith("MANAGED_") && !(a.value && a.value.amount !== 0))
    .map((a) => a.classification!.label))];
}

const notInTotalNote = (labels: string[]) =>
  `Not included: ${labels.join(", ")}. SnapTrade doesn't provide the value of Wealthsimple managed portfolios, so this total leaves them out; their value is in the Wealthsimple app.`;
