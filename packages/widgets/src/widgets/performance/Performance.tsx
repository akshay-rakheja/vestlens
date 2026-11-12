import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { WidgetGuard, useHydrateWatchdog } from "../../kit/resilience";
import { AreaChart } from "../../kit/charts/AreaChart";
import { DrawdownChart } from "../../kit/charts/DrawdownChart";
import { GrowthChart } from "../../kit/charts/GrowthChart";
import { Heatmap } from "../../kit/charts/Heatmap";
import { CompareBars, type CompareRow } from "../../kit/CompareBars";
import { Banner, BrandFooter, Chip, InfoPopover, Money, Segmented, Tabs, Tile, ViewControls } from "../../kit/components";
import { formatDateTime, formatPercent, formatShortDate, formatSignedPercent } from "../../kit/format";
import { historyNotes } from "../../kit/history-notes";
import { useCadView } from "../../kit/currency-switch";
import { NOT_CONVERTED, SeriesCaption, flowNotConvertedText } from "../../kit/home-money";
import type { Figure, PerformancePayload, PerformancePeriod, SeriesPoint } from "./types";

const PERIOD_LABELS = ["1M", "3M", "YTD", "1Y", "3Y", "All"] as const;
const TABS = ["Growth", "vs Benchmark", "Monthly", "Risk"] as const;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const REASONS: Record<string, string> = {
  insufficient_history: "not enough history yet",
  no_solution: "can't be calculated for these cash flows",
  flows_unavailable: "deposits unavailable right now",
  benchmark_unavailable: "benchmark unavailable",
  flow_not_converted: "a USD deposit or withdrawal could not be converted",
  under_a_year: "under a year of history",
};
/** Periods that show the per-year block (the API's YEARLY_PERIODS). */
const YEARLY_PERIODS: readonly PerformancePeriod[] = ["3Y", "ALL"];
export const YEARLY_INFO = "Compound annual growth rate (CAGR): your time-weighted return, with deposits and withdrawals taken out, spread evenly over the years as if it grew at one steady rate. The benchmark is its index over the same dates.\n\nShown once there is a year or more of history: a shorter span would exaggerate it.";

/** The per-year rates for 3Y and All: you against the selected benchmark, on one scale. */
function YearlyRate({ data }: { data: PerformancePayload }) {
  const r = data.figures.investmentCagr, b = data.figures.benchmarkCagr;
  if (!r || !YEARLY_PERIODS.includes(data.period)) return null;
  if (r.value === null) return r.reason === "under_a_year" ? <div class="w-muted pf-yr-note">Under a year of history, so no yearly rate yet</div> : null;
  const pct = (f: Figure) => `${formatSignedPercent(f.value!, 1)}`;
  const rows: CompareRow[] = [{ label: "You", value: r.value, figure: pct(r), tone: "you" }];
  if (b && b.value !== null) rows.push({ label: data.benchmark.name, value: b.value, figure: pct(b), tone: "index" });
  const est = r.estimated || (b?.estimated ?? false) ? " (est.)" : "";
  return (
    <section class="pf-yr" aria-label="Per year">
      <div class="w-row w-muted"><span>Per year</span><InfoPopover title="Per year (CAGR)" label="About the yearly rate" body={YEARLY_INFO} /></div>
      <CompareBars label={rows.map((x) => `${x.label} ${x.figure} a year`).join(", ")} rows={rows} />
      <div class="w-muted pf-yr-note">{`A year, over ${(r.years ?? 0).toFixed(1)} years since ${formatShortDate(data.span.start, "")}${est}`}</div>
    </section>
  );
}
const HIDDEN = "••••";
export const MATCHED_INFO = "What your money would be worth if every dollar you added had gone into the index on the same day: your starting value, then each deposit and withdrawal on its date. It is measured the same way as your return (money-weighted), so the two compare directly.";
const MINUS = "−";
const points = (you: number, index: number) => { const d = (you - index) * 100; return `${d < 0 ? MINUS : "+"}${Math.abs(d).toFixed(2)} pts`; };

/** Same money in the index, right under your return and on its scale (spec: returns vs benchmark audit, 2026-11-03). */
function MatchedLine({ data, privacy }: { data: PerformancePayload; privacy: boolean }) {
  const m = data.figures.matchedBenchmarkReturn, you = data.figures.personalReturn;
  if (!m || (m.value === null && !m.exhausted)) return null;
  const label = data.benchmark.label ?? data.benchmark.name;
  const worth = data.figures.matchedBenchmarkValue;
  return (
    <div class="w-row w-muted pf-matched" role="group" aria-label="Same money in the index">
      <span>{`Same money in ${label}`}</span>
      {m.exhausted
        ? <span>You took out more than the same money in the index would have held</span>
        : <>
          <strong>{formatSignedPercent(m.value!, 2)}{m.annualised && <small> /yr</small>}{m.estimated && <small> est.</small>}</strong>
          {you.value !== null && <span class={tone(you.value - m.value!) === "neutral" ? undefined : tone(you.value - m.value!)}>{`You ${points(you.value, m.value!)}`}</span>}
          {worth && worth.value !== null && <span>· worth <Money amount={worth.value} currency={data.scope.currency} privacy={privacy} /></span>}
        </>}
      <InfoPopover title="Same money in the index" label="About same money in the index" body={MATCHED_INFO} />
    </div>
  );
}

const toPeriod = (label: (typeof PERIOD_LABELS)[number]): PerformancePeriod => (label === "All" ? "ALL" : label);
const toLabel = (period: PerformancePeriod) => (period === "ALL" ? "All" : period) as (typeof PERIOD_LABELS)[number];
const reasonOf = (f: Figure) => (f.reason ? REASONS[f.reason] ?? "" : "");
const monthLabel = (month: string | undefined) => {
  if (!month) return "—";
  const [year, mm] = month.split("-");
  const name = MONTH_NAMES[Number(mm) - 1];
  return name ? `${name} ${year}` : "—";
};
const tone = (v: number | null) => (v === null || v === 0 ? "neutral" : v < 0 ? "down" : "up");

/** Cumulative net deposits -> per-date deltas (the chart ignores flows on the first date); baseline is the first value. */
export function growthInputs(value: SeriesPoint[], cumulative: Array<{ date: string; value: number }>) {
  return {
    baseline: value[0]?.value ?? 0,
    deposits: cumulative.slice(1).map((p, i) => ({ date: p.date, value: p.value - cumulative[i].value })),
  };
}

interface View { period: PerformancePeriod; accountId: string; benchmark: string }

/** The drawdown chart skips days the deposit-lag rule merged away, matching the Max drawdown figure. */
export function drawdownIndex(series: PerformancePayload["series"]) {
  const merged = new Set(series.riskMergedDates ?? []);
  return merged.size ? series.twrIndex.filter((p) => !merged.has(p.date)) : series.twrIndex;
}

function PerformanceView({ bridge, seed }: { bridge: Bridge; seed: ToolResult | null }) {
  const [data, setData] = useState<PerformancePayload | null>(null);
  const [privacy, setPrivacy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Growth");
  const [pending, setPending] = useState<View | null>(null);
  const idPrefix = useId();
  const [cadOn, setCadOn] = useCadView(bridge, data?.settings);

  const requestId = useRef(0);
  const userLoaded = useRef(false);
  const hydrated = useRef(false);
  const hasData = useRef(false);
  const savedBenchmark = useRef<string | null>(null);
  const view = useRef<View | null>(null);
  const applied = useRef<View | null>(null);

  function hydrate(result: ToolResult): boolean {
    const content = result.structuredContent as PerformancePayload | undefined;
    if (result.isError || !content || !content.figures || !content.series) {
      if (!hasData.current) setLoadFailed(true);
      return false;
    }
    hasData.current = true;
    // The shown benchmark counts as saved: a model-supplied override is only saved when the user
    // explicitly picks a benchmark, never by a later period or account change.
    savedBenchmark.current ??= content.benchmark.key;
    setLoadFailed(false);
    if (!hydrated.current) { hydrated.current = true; setPrivacy(content.settings?.privacyDefault ?? false); }
    if (!userLoaded.current) {
      const next = { period: content.period, accountId: content.scope.accountId ?? "", benchmark: content.benchmark.key };
      view.current = next; applied.current = next;
      savedBenchmark.current = content.benchmark.key;
      setData(content);
    }
    return true;
  }
  useEffect(() => bridge.onToolResult((result) => { hydrate(result); }), [bridge]);
  useEffect(() => { if (seed) hydrate(seed); }, []);
  const stalled = useHydrateWatchdog(bridge, () => hasData.current);
  async function retryLoad() {
    setRetrying(true);
    try {
      hydrate(await bridge.callTool("show_performance", bridge.toolArguments()));
    } catch {
      if (!hasData.current) setLoadFailed(true);
    } finally {
      setRetrying(false);
    }
  }
  useEffect(() => {
    if (data) void bridge.updateModelContext(`Viewing performance: ${data.scope.label}, period ${data.period}, benchmark ${data.benchmark.name}.`).catch(() => {});
  }, [bridge, data?.period, data?.scope.label, data?.benchmark.key]);

  if (!data && loadFailed) {
    return (
      <div class="w-shell">
        <Banner tone="warning">Couldn't load your performance.</Banner>
        <button type="button" class="w-chip" disabled={retrying} onClick={() => void retryLoad()}>Try again</button>
      </div>
    );
  }
  if (!data && stalled) return (
      <div class="w-shell">
        <Banner tone="info">Still loading…</Banner>
        <button type="button" class="w-chip" disabled={retrying} onClick={() => void retryLoad()}>Try again</button>
      </div>
    );
  if (!data) return <div class="w-shell w-muted">Loading your performance…</div>;

  async function loadView(change: Partial<View>): Promise<boolean> {
    const base = view.current!;
    const next = { ...base, ...change };
    view.current = next;
    const id = ++requestId.current;
    setPending(next);
    try {
      const args: Record<string, string> = { period: next.period, benchmark: next.benchmark };
      if (next.accountId) args.accountId = next.accountId;
      const result = await bridge.callTool("get_performance", args);
      if (id !== requestId.current) return false;
      const content = result.structuredContent as PerformancePayload | undefined;
      if (result.isError || !content || !content.figures || !content.series) throw new Error("failed");
      applied.current = next; userLoaded.current = true;
      setData(content); setPending(null); setNotice(null);
      // Save from whichever request wins, so a superseded benchmark change is not lost.
      if (next.benchmark !== savedBenchmark.current) {
        const previous = savedBenchmark.current;
        savedBenchmark.current = next.benchmark;
        const saveFailed = () => { savedBenchmark.current = previous; setNotice("Couldn't save default benchmark."); };
        bridge.callTool("save_portfolio_settings", { benchmark: next.benchmark }).then((r) => { if (r.isError) saveFailed(); }, saveFailed);
      }
      return true;
    } catch {
      if (id !== requestId.current) return false;
      view.current = applied.current; setPending(null);
      setNotice("Couldn't load that view. Showing the previous one.");
      return false;
    }
  }
  const changeBenchmark = (key: string) => void loadView({ benchmark: key });
  // The payload follows the saved setting; switching reloads the view once saved, when it was built the other way.
  function onCadChange(next: boolean) {
    const saved = setCadOn(next);
    if (data!.settings?.cadView !== next) void saved.then((ok) => { if (ok) void loadView({}); });
  }

  const { figures, series, span } = data;
  const shown = pending ?? view.current!;
  const loading = pending !== null;
  const year = data.asOf.slice(0, 4);
  const spanLabel = span.partial && span.since ? `since ${formatShortDate(span.since, year)}` : toLabel(data.period);
  const personal = figures.personalReturn;
  // A yearly headline puts the time-weighted pair on the same yearly scale (the CAGR over the same span).
  const yearly = personal.annualised && personal.value !== null && figures.investmentCagr?.value != null;
  const investment = yearly ? figures.investmentCagr! : figures.investmentReturn;
  const bench = yearly && figures.benchmarkCagr ? figures.benchmarkCagr : figures.benchmarkReturn;
  const chipValue = (f: Figure) => (f.value === null ? `— ${reasonOf(f)}` : `${formatSignedPercent(f.value, 1)}${yearly ? " /yr" : ""}`);
  const anyEstimated = Object.values(figures).some((f) => f.estimated);

  const valueSources = new Map(series.value.map((p) => [p.date, p.source] as const));
  const twrPoints = series.twrIndex.map((p) => ({ date: p.date, value: p.value, source: valueSources.get(p.date) ?? "reported" as const }));
  const benchmarkPoints = series.benchmarkIndex.map((p) => ({ date: p.date, returnFraction: p.value - 1 }));
  const depositsUnknown = (figures.netDeposits.reason === "flows_unavailable" || figures.netDeposits.reason === "flow_not_converted") && series.netDeposits.length === 0;
  const growth = growthInputs(series.value, series.netDeposits);
  const benchmarkUnavailable = !!data.benchmark.unavailableReason || figures.benchmarkReturn.reason === "benchmark_unavailable";

  const notes = historyNotes({
    qualities: data.history?.qualities ?? [],
    earliest: data.history?.earliest ?? null,
    accounts: data.accounts.map((a) => ({ id: a.id, label: a.label })),
    points: series.value,
    currentYear: year,
  });
  const showEarliest = !!notes.earliest && (data.period === "ALL" || (notes.earliest >= span.start && notes.earliest <= span.end));

  const money = (f: Figure) => (f.value === null ? "—" : <Money amount={f.value} currency={data.scope.currency} signed privacy={privacy} />);
  const est = (f: Figure) => (f.value !== null && f.estimated ? " est." : "");
  const estTag = (f: Figure) => (f.value !== null && f.estimated ? <small class="w-muted w-est"> est.</small> : null);
  const added = figures.accountsAddedToTracking;
  // Older payloads carry only the net value: show it as one join or leave line.
  const tracking = added && added.value !== null
    ? (added.joined !== undefined ? { joined: added.joined, left: added.left ?? 0, moved: added.movedFromTracked ?? 0 }
      : added.value >= 0 ? { joined: added.value, left: 0, moved: 0 } : { joined: 0, left: added.value, moved: 0 })
    : null;
  const trackingChanged = !!tracking && (tracking.joined !== 0 || tracking.left !== 0 || tracking.moved !== 0);
  const plain = (v: number) => <Money amount={Math.abs(v)} currency={data.scope.currency} privacy={privacy} />;
  const dd = figures.maxDrawdown;
  const home = data.home ?? null;
  const cadShown = !!home?.converted;
  // One USD account in the CAD view: its own-currency figure under the CAD one.
  const nativeLine = (f: Figure | undefined) => home?.native && f && f.value !== null
    ? <small class="w-muted" style={{ display: "block" }}><Money amount={f.value} currency={home.native.currency} signed privacy={privacy} /></small>
    : null;

  return (
    <main class="w-shell">
      <ViewControls privacy={privacy} onPrivacy={setPrivacy} cadOn={cadOn} onCadChange={onCadChange} />
      <div class="w-row" style={{ justifyContent: "space-between" }}>
        <select aria-label="Account" value={shown.accountId} onChange={(e) => void loadView({ accountId: (e.target as HTMLSelectElement).value })}>
          <option value="">All accounts</option>
          {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.label} · {a.currency}</option>)}
        </select>
      </div>
      <div class="w-row w-muted">
        <span>Your return, {spanLabel}</span>
        <InfoPopover title="Your return" label="About your return" body={"Money-weighted return (XIRR): how your money grew, counting when you added or withdrew it. Compare it with the same money in the index, below.\n\nPeriods under a year show the return for the period; a year or more shows it per year."} />
      </div>
      <div class="w-big" aria-busy={loading ? "true" : "false"}>
        {personal.value === null
          ? <>—<small class="w-muted"> {reasonOf(personal)}</small></>
          : <span class={tone(personal.value) === "neutral" ? undefined : tone(personal.value)}>{formatSignedPercent(personal.value, 2)}{personal.annualised && <small class="w-muted"> /yr</small>}{personal.estimated && <small class="w-muted"> <span>est.</span></small>}</span>}
      </div>
      <MatchedLine data={data} privacy={privacy} />
      <div class="w-row">
        <Chip>{`Investment return ${chipValue(investment)}${est(investment)}`}</Chip>
        <InfoPopover title="Investment return" label="About investment return" body="Time-weighted return: how your investments performed, with deposits and withdrawals taken out. It compares with the index's own return, next to it." />
        <Chip>{`${data.benchmark.label ?? data.benchmark.name} ${chipValue(bench)}${est(bench)}`}</Chip>
      </div>
      {data.benchmark.basis && !data.benchmark.label && <small class="w-muted">{`${data.benchmark.name}: ${data.benchmark.basis}`}</small>}
      <YearlyRate data={data} />
      {home?.flowNotConverted && <Banner tone="info">{flowNotConvertedText(home.flowNotConverted)}</Banner>}
      <Segmented label="Period" options={PERIOD_LABELS} value={toLabel(shown.period)} onChange={(label) => void loadView({ period: toPeriod(label) })} />
      <Tabs label="Performance view" options={TABS} value={tab} onChange={(t) => setTab(t)} idPrefix={idPrefix} />
      <div role="tabpanel" id={`${idPrefix}-panel-${TABS.indexOf(tab)}`} aria-labelledby={`${idPrefix}-tab-${TABS.indexOf(tab)}`}>
        {tab === "Growth" && (
          <>
            <GrowthChart label={`Value ${toLabel(data.period)}`} value={series.value} deposits={depositsUnknown ? null : growth.deposits} baseline={growth.baseline} includesTracking={trackingChanged} currency={data.scope.currency} privacy={privacy} />
            {depositsUnknown && <div class="w-muted w-deposits-note">Deposits unavailable right now</div>}
            <div class="w-tiles">
              <Tile label="Market gain" tone={tone(figures.marketGain.value)} value={<>{money(figures.marketGain)}{estTag(figures.marketGain)}{figures.marketGain.value === null && <small class="w-muted"> {reasonOf(figures.marketGain)}</small>}{nativeLine(home?.native?.marketGain)}</>} />
              <Tile label="Net deposits" value={<>{money(figures.netDeposits)}{estTag(figures.netDeposits)}{figures.netDeposits.value === null && <small class="w-muted"> {reasonOf(figures.netDeposits)}</small>}{nativeLine(home?.native?.netDeposits)}
                {tracking && tracking.joined !== 0 && <small class="w-muted w-added">Accounts added to tracking {money({ value: tracking.joined, estimated: false })}{added!.estimated ? " est." : ""}</small>}
                {tracking && tracking.moved < 0 && <small class="w-muted w-added">{tracking.joined !== 0 ? "of which " : ""}{plain(tracking.moved)} moved from your other accounts</small>}
                {tracking && tracking.moved > 0 && <small class="w-muted w-added">{plain(tracking.moved)} moved in from accounts not tracked then</small>}
                {tracking && tracking.left !== 0 && <small class="w-muted w-added">Accounts no longer tracked {money({ value: tracking.left, estimated: false })}{added!.estimated ? " est." : ""}</small>}</>} />
            </div>
          </>
        )}
        {tab === "vs Benchmark" && (
          <>
            <div class="w-row w-muted">
              <label>Benchmark <select aria-label="Benchmark" value={shown.benchmark} onChange={(e) => changeBenchmark((e.target as HTMLSelectElement).value)}>
                {data.benchmarks.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
              </select></label>
              <InfoPopover title={data.benchmark.name} body={`${data.benchmark.explainer}${data.benchmark.note ? ` ${data.benchmark.note}` : ""}`} />
            </div>
            {benchmarkUnavailable
              ? <div class="w-muted">Benchmark unavailable right now</div>
              : <AreaChart label={`Investment return vs ${data.benchmark.name}`} mode="return" points={twrPoints} benchmark={benchmarkPoints} seriesLabel="Your investment return" benchmarkLabel={data.benchmark.name} />}
          </>
        )}
        {tab === "Monthly" && (
          data.monthly.length === 0
            ? <div class="w-muted">Not enough history for monthly returns yet</div>
            : (
              <>
                <Heatmap label="Monthly returns" months={data.monthly} />
                <div class="w-muted">
                  Best month {monthLabel(figures.bestMonth.month)} {figures.bestMonth.value === null ? "—" : formatSignedPercent(figures.bestMonth.value, 1)}{est(figures.bestMonth)}
                  {" · "}Worst month {monthLabel(figures.worstMonth.month)} {figures.worstMonth.value === null ? "—" : formatSignedPercent(figures.worstMonth.value, 1)}{est(figures.worstMonth)}
                </div>
              </>
            )
        )}
        {tab === "Risk" && (
          <>
            <DrawdownChart label="Drawdown" index={drawdownIndex(series)} />
            <div class="w-tiles">
              <Tile label="Max drawdown" tone={tone(dd.value)} value={dd.value === null
                ? <>—<small class="w-muted"> {reasonOf(dd)}</small></>
                : <>{formatSignedPercent(dd.value, 1)}{dd.peak && dd.trough && <small class="w-muted"> {formatShortDate(dd.peak, year)} → {formatShortDate(dd.trough, year)}</small>}{dd.estimated && <small class="w-muted"> est.</small>}</>} />
              <Tile label="Volatility (annualised)" value={figures.volatility.value === null
                ? <>—<small class="w-muted"> {reasonOf(figures.volatility)}</small></>
                : <>{formatPercent(figures.volatility.value, 1)}{figures.volatility.estimated && <small class="w-muted"> est.</small>}</>} />
            </div>
          </>
        )}
      </div>
      {showEarliest && notes.earliest && <span class="w-muted">History rebuilt from your activity since {formatShortDate(notes.earliest, notes.currentYear)}</span>}
      {notes.snapshotsOnly && <div class="w-row w-muted"><span>Some accounts show history only since their first snapshot</span><InfoPopover title="History coverage" body={notes.details} /></div>}
      {notes.estimated && <div class="w-row w-muted"><span>Some history is estimated</span>{notes.drift && <span>· rebuilt value {notes.drift}</span>}{!notes.snapshotsOnly && notes.details && <InfoPopover title="History coverage" body={notes.details} />}</div>}
      {anyEstimated && <span class="w-muted">Includes estimated values</span>}
      {cadShown && <>
        <SeriesCaption estimated={home!.estimated} days={home!.notConvertedDays} accounts={home!.notConvertedAccounts} />
        <span class="w-muted">USD values use each day's Bank of Canada rate; returns are computed on CAD values{home!.notConvertedDays > 0 ? "; days without a recent rate are left out of the chart" : ""}.</span>
      </>}
      {home && !home.converted && <p class="w-caption">{NOT_CONVERTED}</p>}
      {data.otherCurrencies.length > 0 && <span class="w-muted">{data.otherCurrencies.join(", ")} accounts are {cadShown ? "not converted and not included" : "shown separately"}</span>}
      {notice && <Banner tone="info">{notice}</Banner>}
      <div class="w-foot">{data.scope.currency} · as of {formatDateTime(data.asOf)}</div>
      <BrandFooter />
    </main>
  );
}

export function Performance({ bridge }: { bridge: Bridge }) {
  return <WidgetGuard bridge={bridge} showTool="show_performance">{(seed) => <PerformanceView bridge={bridge} seed={seed} />}</WidgetGuard>;
}
