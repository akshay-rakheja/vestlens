import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { DashboardPerformance, PortfolioApiClient } from "./App";

/**
 * The dashboard's return chart: the caller's time-weighted return (deposits taken out) against a benchmark,
 * from GET /api/performance, the same computation as show_performance in Claude and ChatGPT. Nothing is computed here
 * beyond drawing it.
 */

/** Drawn at the container's real width so the 12 px labels stay 12 px on a phone; taller on narrow screens. */
const DEFAULT_W = 720;
const heightFor = (w: number) => (w < 480 ? 200 : 240);
const PAD = { l: 52, r: 14, t: 14, b: 26 };
const PERIOD_LABEL: Record<string, string> = { "1M": "1M", "3M": "3M", YTD: "YTD", "1Y": "1Y", "3Y": "3Y", ALL: "All" };

type Point = { date: string; value: number };
type Load = { status: "loading" } | { status: "ready"; view: DashboardPerformance } | { status: "error" } | { status: "hidden" };

const pct = (fraction: number) => `${fraction >= 0 ? "+" : "−"}${Math.abs(fraction * 100).toFixed(1)}%`;
const dayMs = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
const shortDate = (ymd: string) =>
  new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(dayMs(ymd)));
const money = (amount: number, currency: string) =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
/** To the cent, so the breakdown's rows add up to its net exactly. */
const exact = (amount: number, currency: string) =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);

/** The point at or before `date` (series are sorted by date). */
function atOrBefore(points: Point[], date: string): Point | undefined {
  let hit: Point | undefined;
  for (const p of points) {
    if (p.date > date) break;
    hit = p;
  }
  return hit;
}

export function PerformanceChart({ you, benchmark, benchmarkName }: { you: Point[]; benchmark: Point[]; benchmarkName: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [W, setW] = useState(DEFAULT_W);
  const svg = useRef<SVGSVGElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry?.contentRect.width ?? 0);
      if (width > 0) setW(Math.max(260, width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const H = heightFor(W);
  const geometry = useMemo(() => {
    const all = [...you, ...benchmark].map((p) => p.value - 1);
    let lo = Math.min(0, ...all);
    let hi = Math.max(0, ...all);
    const pad = Math.max((hi - lo) * 0.08, 0.005);
    lo -= pad;
    hi += pad;
    const t0 = dayMs(you[0]!.date);
    const t1 = Math.max(dayMs(you[you.length - 1]!.date), t0 + 1);
    const x = (date: string) => PAD.l + ((dayMs(date) - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
    const y = (fraction: number) => PAD.t + (1 - (fraction - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    const path = (points: Point[]) => points.map((p, i) => `${i ? "L" : "M"}${x(p.date).toFixed(1)},${y(p.value - 1).toFixed(1)}`).join("");
    return { lo, hi, x, y, path, t0, t1 };
  }, [you, benchmark, W, H]);

  const last = you[you.length - 1]!;
  const lastBench = atOrBefore(benchmark, last.date);
  const label = `Investment return ${pct(last.value - 1)} from ${shortDate(you[0]!.date)} to ${shortDate(last.date)}` +
    (lastBench ? `; ${benchmarkName} ${pct(lastBench.value - 1)} over the same dates.` : ".");
  const ticks = [geometry.hi, (geometry.hi + geometry.lo) / 2, geometry.lo];
  const hovered = hover === null ? null : you[hover]!;
  const hoveredBench = hovered ? atOrBefore(benchmark, hovered.date) : undefined;

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const sx = ((event.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < you.length; i++) if (Math.abs(geometry.x(you[i]!.date) - sx) < Math.abs(geometry.x(you[best]!.date) - sx)) best = i;
    setHover(best);
  };

  return (
    <div className="perf-chart" ref={wrap}>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-labelledby={titleId} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <title id={titleId}>{label}</title>
        {ticks.map((t) => (
          <g key={t} className="perf-grid">
            <line x1={PAD.l} x2={W - PAD.r} y1={geometry.y(t)} y2={geometry.y(t)} />
            <text x={PAD.l - 8} y={geometry.y(t) + 4} textAnchor="end">{pct(t)}</text>
          </g>
        ))}
        <line className="perf-zero" x1={PAD.l} x2={W - PAD.r} y1={geometry.y(0)} y2={geometry.y(0)} />
        <text className="perf-axis" x={PAD.l} y={H - 6}>{shortDate(you[0]!.date)}</text>
        <text className="perf-axis" x={W - PAD.r} y={H - 6} textAnchor="end">{shortDate(last.date)}</text>
        {benchmark.length > 1 && <path className="perf-line perf-bench" d={geometry.path(benchmark)} />}
        <path className="perf-line perf-you" d={geometry.path(you)} />
        <circle className="perf-dot" cx={geometry.x(last.date)} cy={geometry.y(last.value - 1)} r={4} />
        {hovered && (
          <g className="perf-hover" aria-hidden="true">
            <line x1={geometry.x(hovered.date)} x2={geometry.x(hovered.date)} y1={PAD.t} y2={H - PAD.b} />
            <circle cx={geometry.x(hovered.date)} cy={geometry.y(hovered.value - 1)} r={4} />
          </g>
        )}
      </svg>
      {hovered && (
        <p className="perf-tip" aria-hidden="true">
          <b>{shortDate(hovered.date)}</b> You {pct(hovered.value - 1)}
          {hoveredBench && <> <span>{benchmarkName} {pct(hoveredBench.value - 1)}</span></>}
        </p>
      )}
    </div>
  );
}

export function PerformancePanel({ api }: { api: Pick<PortfolioApiClient, "getPerformance"> }) {
  const [period, setPeriod] = useState<string>("YTD");
  const [benchmark, setBenchmark] = useState<string | undefined>(undefined);
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    if (!api.getPerformance) return;
    let live = true;
    setLoad((current) => (current.status === "ready" ? current : { status: "loading" }));
    api.getPerformance({ period, ...(benchmark ? { benchmark } : {}) })
      .then((view) => { if (live) setLoad(view ? { status: "ready", view } : { status: "hidden" }); })
      .catch(() => { if (live) setLoad({ status: "error" }); });
    return () => { live = false; };
  }, [api, period, benchmark]);

  if (load.status === "hidden") return null;
  const view = load.status === "ready" ? load.view : null;
  const name = view?.benchmark.label ?? view?.benchmark.name ?? "the S&P 500";
  const you = view?.series.you ?? [];
  const bench = view?.series.benchmark ?? [];
  const { investmentReturn, benchmarkReturn, netDeposits, marketGain } = view?.figures ?? {};

  return (
    <section className="perf-panel" aria-labelledby="perf-heading" aria-busy={load.status === "loading"}>
      <div className="perf-head">
        <div>
          <div className="section-kicker">Performance</div>
          <h2 id="perf-heading">{`Investment return vs ${name}`}</h2>
          <p className="perf-sub">{`Time-weighted, with your deposits taken out.${view?.benchmark.basis && !view.benchmark.label ? ` ${name}: ${view.benchmark.basis}.` : ""}`}</p>
        </div>
        <div className="perf-controls">
          <div className="perf-periods" role="group" aria-label="Period">
            {(view?.periods ?? Object.keys(PERIOD_LABEL)).map((p) => (
              <button key={p} type="button" aria-pressed={p === period} onClick={() => setPeriod(p)}>{PERIOD_LABEL[p] ?? p}</button>
            ))}
          </div>
          <label className="perf-bench-select">
            <span>Compare with</span>
            <select value={view?.benchmark.key ?? ""} onChange={(e) => setBenchmark(e.target.value)} disabled={!view}>
              {(view?.benchmarks ?? []).map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
            </select>
          </label>
        </div>
      </div>

      {load.status === "error" && <p className="perf-empty" role="status">Performance is unavailable right now. Your totals above are unaffected.</p>}
      {load.status === "loading" && <p className="perf-empty" role="status">Loading your return…</p>}
      {view && (
        <>
          <div className="perf-figures">
            <div className="perf-figure perf-figure-you">
              <span>Investment return</span>
              <strong>{investmentReturn?.value !== null && investmentReturn ? pct(investmentReturn.value) : "—"}</strong>
              {investmentReturn?.estimated && <span className="est-tag">est.</span>}
            </div>
            <div className="perf-figure">
              <span>{name}</span>
              <strong>{benchmarkReturn?.value !== null && benchmarkReturn ? pct(benchmarkReturn.value) : "—"}</strong>
              {benchmarkReturn?.estimated && <span className="est-tag">est.</span>}
            </div>
            {view.deposits ? (
              <>
                <div className="perf-figure perf-figure-small"><span>Put in</span><strong>{money(view.deposits.putIn, view.currency)}</strong></div>
                {view.deposits.takenOut !== 0 && (
                  <div className="perf-figure perf-figure-small"><span>Taken out</span><strong>{money(view.deposits.takenOut, view.currency)}</strong></div>
                )}
              </>
            ) : netDeposits?.value !== null && netDeposits && (
              <div className="perf-figure perf-figure-small"><span>Net deposits</span><strong>{money(netDeposits.value, view.currency)}</strong></div>
            )}
            {marketGain?.value !== null && marketGain && (
              <div className="perf-figure perf-figure-small"><span>Market gain</span><strong>{money(marketGain.value, view.currency)}</strong></div>
            )}
          </div>
          <MatchedPair figures={view.figures} name={name} currency={view.currency} />
          {you.length > 1
            ? <PerformanceChart you={you} benchmark={bench} benchmarkName={name} />
            : <p className="perf-empty" role="status">Not enough history for this period yet. A new link fills in about 10 minutes after you connect.</p>}
          <div className="perf-legend" aria-hidden="true">
            <span className="perf-key perf-key-you">You</span>
            <span className="perf-key perf-key-bench">{name}</span>
          </div>
          {view.deposits && <DepositsBreakdown deposits={view.deposits} net={netDeposits?.value ?? null} currency={view.currency} start={view.span.start} />}
          {view.benchmark.unavailableReason && <p className="perf-note">{view.benchmark.unavailableReason}</p>}
          {view.benchmark.note && <p className="perf-note">{view.benchmark.note}</p>}
          {view.estimated && <p className="perf-note">{view.fxEstimated === false ? "Includes estimated values." : "Includes estimated values: US dollar amounts use the Bank of Canada rate of each day."}</p>}
          {view.unrecordedNote ? <p className="perf-note" role="note">{view.unrecordedNote}</p> : null}
          {view.notInFigures?.length ? <p className="perf-note" role="note">{notInFiguresNote(view.notInFigures)}</p> : null}
        </>
      )}
    </section>
  );
}

/** Your money-weighted return beside the same money in the index: both counted the same way, so they compare directly. */
function MatchedPair({ figures, name, currency }: { figures: DashboardPerformance["figures"]; name: string; currency: string }) {
  const you = figures.personalReturn, m = figures.matchedBenchmarkReturn;
  if (!you || !m || (m.value === null && !m.exhausted)) return null;
  const yr = (annualised: boolean) => (annualised ? " /yr" : "");
  const worth = figures.matchedBenchmarkValue?.value;
  return (
    <div className="perf-figures perf-matched" role="group" aria-label="Your return against the same money in the index">
      <div className="perf-figure perf-figure-you">
        <span>Your return</span>
        <strong>{you.value === null ? "—" : `${pct(you.value)}${yr(you.annualised)}`}</strong>
        {you.estimated && <span className="est-tag">est.</span>}
      </div>
      <div className="perf-figure">
        <span>{`Same money in ${name}`}</span>
        {m.exhausted
          ? <strong className="perf-figure-note">You took out more than it would have held</strong>
          : <strong>{`${pct(m.value!)}${yr(m.annualised)}`}</strong>}
        {!m.exhausted && worth != null && <span className="perf-figure-worth">{`worth ${money(worth, currency)}`}</span>}
        {m.estimated && <span className="est-tag">est.</span>}
      </div>
      <p className="perf-note">Your return counts when you added money. Beside it: what the same money would have made if every dollar you added had gone into the index on the same day.</p>
    </div>
  );
}

/** Accounts left out of every figure (spec 2026-10-29-incomplete-history): named, never with amounts. */
export function notInFiguresNote(left: NonNullable<DashboardPerformance["notInFigures"]>): string {
  const names = (reason: string) => [...new Set(left.filter((a) => a.reason === reason).map((a) => a.label))];
  const managed = names("managed"), gaps = names("history_gaps");
  return "These figures count only accounts whose numbers SnapTrade provides in full."
    + (managed.length ? ` Not included: ${managed.join(", ")} (managed portfolios, whose holdings history SnapTrade doesn't provide).` : "")
    + (gaps.length ? ` Not included for this period: ${gaps.join(", ")} (gaps in its value history).` : "");
}

/** The working behind "Put in": per account, adding up to the net, and what is left out (spec 2026-10-29-investment-scope). */
function DepositsBreakdown({ deposits, net, currency, start }: { deposits: NonNullable<DashboardPerformance["deposits"]>; net: number | null; currency: string; start: string }) {
  const leftOut = [...new Set(deposits.leftOut)];
  return (
    <details className="perf-deposits">
      <summary>Where the money went in</summary>
      <table>
        <thead><tr><th scope="col">Account</th><th scope="col">Put in</th><th scope="col">Taken out</th></tr></thead>
        <tbody>
          {deposits.byAccount.map((row) => (
            <tr key={row.accountId}>
              <th scope="row">
                {row.label}
                {(row.name || row.value) && (
                  <span className="perf-deposits-account">
                    {[row.name && row.name !== row.label ? row.name : null, row.value ? `${exact(row.value.amount, row.value.currency)} now` : null].filter(Boolean).join(", ")}
                  </span>
                )}
              </th>
              <td>{row.putIn ? exact(row.putIn, currency) : "—"}</td><td>{row.takenOut ? exact(row.takenOut, currency) : "—"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><th scope="row">Net</th><td colSpan={2}>{net === null ? "—" : exact(net, currency)}{deposits.estimated ? " est." : ""}</td></tr></tfoot>
      </table>
      <p className="perf-note">
        Deposits, withdrawals and transfers from other institutions into your investment accounts, over the period shown.
        Moves between your investment accounts cancel out.
        {` Money already invested on ${shortDate(start)} is the starting value, not money put in.`}
        {leftOut.length > 0 && ` ${leftOut.join(", ")} isn't counted: it's where pay lands and spending leaves, so money moved from it into an investment account counts as put in.`}
      </p>
      {deposits.byAccount.some((r) => r.bucket === "rrsp") && (
        <p className="perf-note">RRSP rows are money put in on these dates. For your tax deduction, contributions in the first 60 days of a year can count toward the year before, so they won't line up with an RRSP contribution year.</p>
      )}
    </details>
  );
}
