import { Fragment, type ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { Bridge } from "../../kit/bridge";
import { CompareBars } from "../../kit/CompareBars";
import { BrandFooter, InfoPopover, Segmented, SymbolText, ViewControls, shortSymbol } from "../../kit/components";
import { HydratedCard } from "../../kit/hydrated";
import { calendarDate } from "../tfsa-room/format";
import {
  afterSoldHeadline, callsHeadline, HIDDEN, HIDDEN_FMT, LOADING_COPY, OVERALL_MISSING, pct, SHOWN,
  storedSinceNote, tradingCostHeadline, type Fmt,
} from "./headlines";
import { copyText } from "./share";
import type { CantTell, OverallSection, ReportCardPayload } from "./types";
import {
  barGeometry, BENCHES, callBars, INFO, keptVsSoldLine, callTally, costBasisLine, costMeter, costTiles, overallGap, overallYear, saleBars, scaleMax, SHARE_FOOTER, shareFigures,
  shareText, shareTitle, TAP_HINT, type BarRow, type Bench, type Mark,
} from "./visual";

/** Chart rows shown before "Show all". */
export const LIST_LIMIT = 8;
/** Holdings drawn as dots; past this the big count says it alone. */
export const DOT_LIMIT = 30;

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null;
const isCantTell = (c: unknown) => isObj(c) && typeof c.count === "number" && Array.isArray(c.reasons);
const isPayload = (c: unknown): c is ReportCardPayload =>
  isObj(c) && typeof c.asOf === "string" && (c.activityFrom === null || typeof c.activityFrom === "string")
  && isObj(c.calls) && Array.isArray(c.calls.items) && isObj(c.calls.summary) && Array.isArray(c.calls.summary.aheadUnmeasured) && isCantTell(c.calls.cantTell)
  && isObj(c.afterSold) && Array.isArray(c.afterSold.items) && isObj(c.afterSold.summary) && isCantTell(c.afterSold.cantTell)
  && isObj(c.tradingCost) && isObj(c.tradingCost.conversion) && isObj(c.tradingCost.conversion.estimate) && isObj(c.tradingCost.fees)
  && isCantTell(c.tradingCost.conversion.cantTell) && isCantTell(c.tradingCost.conversion.estimate.cantTell) && isCantTell(c.tradingCost.fees.cantTell)
  && (c.overall === null || isObj(c.overall));

/** A line with its hidden amounts drawn as the blurred mark. */
function Text({ text }: { text: string }) {
  if (!text.includes(HIDDEN)) return <>{text}</>;
  const parts = text.split(HIDDEN);
  return <>{parts.map((part, i) => <Fragment key={i}>{part}{i < parts.length - 1 && <span class="w-blur" role="img" aria-label="Hidden amount">••••••</span>}</Fragment>)}</>;
}
const monthYear = (ymd: string) => new Intl.DateTimeFormat("en-CA", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${ymd}T00:00:00Z`));
const spoken = (text: string) => text.split(HIDDEN).join("hidden amount");

function Section({ id, title, info, children }: { id: string; title: string; info: string; children?: ComponentChildren }) {
  return (
    <section class="rc-sec" aria-labelledby={`rc-${id}`}>
      <div class="rc-th"><h2 class="rc-title" id={`rc-${id}`}>{title}</h2><InfoPopover title={title} label={`How "${title}" is worked out`} body={info} /></div>
      {children}
    </section>
  );
}

/** The big count with its words, or the section's plain sentence when there is nothing to count. */
const Big = ({ value, words }: { value: string; words: string }) => <p class="rc-big"><b>{value}</b> <span>{words}</span></p>;
const Head = ({ text }: { text: string }) => <p class="rc-head"><Text text={text} /></p>;
const Note = ({ text }: { text: string | null }) => (text ? <p class="rc-note"><Text text={text} /></p> : null);

/** "Couldn't tell for N", collapsed; opens to each reason with its count and symbols. */
function CantTellLine({ cantTell, label = (n) => `Couldn't tell for ${n}` }: { cantTell: CantTell; label?: (n: number) => string }) {
  const [open, setOpen] = useState(false);
  if (cantTell.count === 0) return null;
  const text = label(cantTell.count);
  return (
    <div class="rc-ct">
      <button type="button" class="w-tgl" aria-expanded={open} onClick={() => setOpen(!open)}>{text}</button>
      {open && (
        <ul class="rc-reasons" aria-label={text}>
          {cantTell.reasons.map((r) => <li key={r.reason}>{`${r.count}: ${r.reason}${r.symbols.length > 0 ? ` (${r.symbols.map(shortSymbol).join(", ")})` : ""}`}</li>)}
        </ul>
      )}
    </div>
  );
}

/**
 * A diverging bar chart around a zero line. Each row is a button: tapping it puts its full line under the chart.
 * Colour is never the only cue: the bar's side and the axis words say ahead or behind too.
 */
function BarChart({ rows, label, axis }: { rows: BarRow[]; label: string; axis: [string, string, string] }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  if (rows.length === 0) return null;
  const max = scaleMax(rows.map((r) => r.value));
  const shown = all ? rows : rows.slice(0, LIST_LIMIT);
  return (
    <div class="rc-chart">
      <ul class="rc-bars" aria-label={label}>
        {shown.map((r, i) => {
          const g = r.unmeasured ? { left: 50, width: 50 } : r.value === null ? null : barGeometry(r.value, max);
          const tone = r.unmeasured || (r.value ?? 0) > 0 ? "a" : (r.value ?? 0) < 0 ? "b" : "l";
          return (
            <li key={r.symbol + i}>
              <button type="button" class="rc-bar" aria-pressed={selected === i} aria-label={spoken(r.detail)} onClick={() => setSelected(selected === i ? null : i)}>
                <span class="rc-sym"><SymbolText symbol={r.symbol} /></span>
                <span class="rc-trk" aria-hidden="true">
                  <span class="rc-zero" />
                  {g && <span class={`rc-fill rc-${tone}${r.unmeasured ? " rc-faded" : ""}`} style={{ left: `${g.left}%`, width: `max(${g.width}%, 2px)` }} />}
                </span>
                <span class="rc-fig">{r.figure}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div class="rc-axis" aria-hidden="true"><span>{axis[0]}</span><span>{axis[1]}</span><span>{axis[2]}</span></div>
      <p class="rc-det" aria-live="polite"><Text text={selected === null ? TAP_HINT : shown[selected]!.detail} /></p>
      {!all && rows.length > LIST_LIMIT && <button type="button" class="w-tgl rc-all" onClick={() => setAll(true)}>{`Show all ${rows.length}`}</button>}
    </div>
  );
}

function Dots({ marks }: { marks: Mark[] }) {
  if (marks.length === 0 || marks.length > DOT_LIMIT) return null;
  const n = (m: Mark) => marks.filter((x) => x === m).length;
  const name = `${n("ahead")} ahead, ${n("behind")} behind${n("level") > 0 ? `, ${n("level")} level` : ""}`;
  return <div class="rc-dots" role="img" aria-label={name}>{marks.map((m, i) => <span key={i} class={`rc-dot rc-dot-${m}`} />)}</div>;
}

/* Sections ----------------------------------------------------------------------------------------------------- */

function Race({ o }: { o: OverallSection }) {
  const since = o.sinceStart;
  return (
    <>
      <CompareBars label={`You ${pct(o.returnPct)}, S&P 500 ${pct(o.sp500Pct)}`} rows={[
        { label: "You", value: o.returnPct, figure: pct(o.returnPct), tone: "you" },
        { label: "S&P 500", value: o.sp500Pct, figure: pct(o.sp500Pct), tone: "index" },
      ]} />
      <Note text={overallGap(o)} />
      {since && (
        <>
          <p class="rc-sub">{`Per year since ${monthYear(since.from)}`}</p>
          <CompareBars label={`Per year since ${monthYear(since.from)}: you ${pct(since.cagrPct)}, S&P 500 ${pct(since.sp500CagrPct)}`} rows={[
            { label: "You", value: since.cagrPct, figure: `${pct(since.cagrPct)}`, tone: "you" },
            { label: "S&P 500", value: since.sp500CagrPct, figure: `${pct(since.sp500CagrPct)}`, tone: "index" },
          ]} />
          <Note text={`A year, over ${since.years.toFixed(1)} years (est.)`} />
        </>
      )}
    </>
  );
}

function Overall({ p }: { p: ReportCardPayload }) {
  return (
    <Section id="overall" title={`${overallYear(p)} so far`} info={INFO.overall}>
      {p.overall ? <Race o={p.overall} /> : <Head text={OVERALL_MISSING} />}
    </Section>
  );
}

function Calls({ p }: { p: ReportCardPayload }) {
  const [bench, setBench] = useState<Bench>("S&P 500");
  const { calls } = p;
  const tally = callTally(calls, bench);
  const rows = callBars(calls, bench);
  return (
    <Section id="calls" title="Your holdings against the market" info={INFO.calls}>
      {calls.summary.compared === 0 ? <Head text={callsHeadline(calls)} /> : (
        <>
          <div class="rc-bench"><Segmented<Bench> options={BENCHES} value={bench} onChange={setBench} label="Compare with" /></div>
          {tally.total > 0 ? <Big value={`${tally.ahead} of ${tally.total}`} words={`came out ahead of the ${bench}`} /> : <Head text="None of these holdings has a TSX figure yet" />}
          <Dots marks={tally.marks} />
          <BarChart key={bench} rows={rows} label={`Holdings against the ${bench}`} axis={["behind", bench, "ahead"]} />
        </>
      )}
      <CantTellLine cantTell={calls.cantTell} />
    </Section>
  );
}

function AfterSold({ p, f }: { p: ReportCardPayload; f: Fmt }) {
  const { afterSold } = p;
  const kept = keptVsSoldLine(afterSold, f);
  return (
    <Section id="sold" title="After you sold" info={INFO.sold}>
      {afterSold.summary.sells === 0 ? <Head text={afterSoldHeadline(afterSold)} /> : (
        <>
          <Big value={`${afterSold.summary.rose} of ${afterSold.summary.sells}`} words="rose since you sold" />
          <BarChart rows={saleBars(afterSold, f)} label="Sales against the latest close" axis={["fell", "price at sale", "rose"]} />
          <Note text={kept} />
        </>
      )}
      <CantTellLine cantTell={afterSold.cantTell} />
    </Section>
  );
}

function TradingCost({ p, f }: { p: ReportCardPayload; f: Fmt }) {
  const cost = p.tradingCost;
  const meter = costMeter(cost);
  return (
    <Section id="cost" title="What trading cost you" info={INFO.cost}>
      <div class="w-tiles rc-tiles">
        {costTiles(cost, f).map((t) => (
          <div class="w-tile" key={t.label}>{t.label}<b><Text text={t.value} /></b><small><Text text={t.sub} /></small></div>
        ))}
      </div>
      {meter && (
        <>
          <div class="rc-meter" role="img" aria-label={meter.line}><span style={{ width: `max(${Math.min(meter.share, 100)}%, 3px)` }} /></div>
          <p class="rc-cap">{meter.line}</p>
        </>
      )}
      <Note text={[costBasisLine(cost), tradingCostHeadline(cost, f) + ".", storedSinceNote(p.activityFrom)].filter(Boolean).join(" ")} />
      <CantTellLine cantTell={cost.conversion.cantTell} />
      <CantTellLine cantTell={cost.conversion.estimate.cantTell} label={(n) => `Left out of the cost estimate: ${n}`} />
      <CantTellLine cantTell={cost.fees.cantTell} />
    </Section>
  );
}

/**
 * The share card: percentages and counts only, never amounts or symbols, made only when the person opens it. Hosts
 * block downloads from the widget, so sharing is a screenshot of the card or its text.
 */
function Share({ p }: { p: ReportCardPayload }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const figures = shareFigures(p);
  const text = shareText(p)!;
  return (
    <section class="rc-share" aria-label="Share card">
      <p class="rc-cap">Percentages only: no dollar amounts or tickers. Take a screenshot to share it.</p>
      <div class="rc-sc">
        <div class="rc-sch"><b>{shareTitle(p)}</b><span class="rc-chip">VestLens</span></div>
        <div class="rc-scf">{figures.map((fig) => <div key={fig.label}><b>{fig.value}</b><span>{fig.label}</span></div>)}</div>
        <p>{SHARE_FOOTER}</p>
      </div>
      <div class="rc-sa">
        <button type="button" class="w-tgl" onClick={async () => setCopied(await copyText(text))}>Copy text</button>
        {copied === true && <span class="rc-cap" role="status">Copied</span>}
      </div>
      {copied === false && (
        <>
          <p class="rc-cap" role="status">Copying isn't allowed here. Select the text and copy it.</p>
          <textarea class="rc-txt" readOnly rows={5} value={text} onFocus={(e) => (e.currentTarget as HTMLTextAreaElement).select()} />
        </>
      )}
    </section>
  );
}

const STYLE = `
  .rc-top{display:flex;align-items:center;gap:12px;justify-content:space-between}
  .rc-top .w-controls{flex:1}
  .rc-sec{display:grid;gap:8px;min-width:0;padding-top:14px;border-top:1px solid var(--line)}
  .rc-sec:first-of-type{padding-top:0;border-top:0}
  .rc-th{display:flex;align-items:center;gap:6px}
  .rc-sub{margin:6px 0 0;font-size:12px;font-weight:600;color:var(--muted)}
  .rc-asof{margin:0;font-size:11px;line-height:1.45;color:var(--muted)}
  .rc-title{margin:0;font-size:12px;font-weight:600;color:var(--muted)}
  .rc-head{margin:0;font-family:var(--display);font-size:16px;font-weight:650;letter-spacing:-.01em;line-height:1.3;color:var(--ink);overflow-wrap:anywhere}
  .rc-big{margin:0;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
  .rc-big b{font-family:var(--display);font-size:32px;font-weight:650;letter-spacing:-.025em;line-height:1;color:var(--ink)}
  .rc-big span{font-size:12.5px;color:var(--muted)}
  .rc-note,.rc-cap{margin:0;font-size:12px;line-height:1.45;color:var(--muted);overflow-wrap:anywhere}
  .rc-cap{font-size:11.5px}
  .rc-bench{display:flex}
  .rc-dots{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
  .rc-dot{width:12px;height:12px;border-radius:50%;box-sizing:border-box}
  .rc-dot-ahead{background:var(--c1)} .rc-dot-behind{border:2px solid var(--c2)} .rc-dot-level{height:4px;align-self:center;border-radius:2px;background:var(--c-other)}
  .rc-chart{display:grid;gap:2px}
  .rc-bars{margin:4px 0 0;padding:0;list-style:none;display:grid;gap:1px}
  .rc-bar{all:unset;box-sizing:border-box;width:100%;display:grid;grid-template-columns:62px minmax(0,1fr) minmax(64px,auto);gap:10px;align-items:center;padding:4px 6px;margin:0 -6px;border-radius:6px;cursor:pointer}
  .rc-bar:hover{background:var(--card)}
  .rc-bar[aria-pressed="true"]{background:var(--accent-soft)}
  .rc-bar:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  .rc-sym{font-size:12.5px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .rc-trk{position:relative;height:14px}
  .rc-zero{position:absolute;left:50%;top:-3px;bottom:-3px;width:1px;background:var(--muted);opacity:.55}
  .rc-fill{position:absolute;top:2px;bottom:2px;border-radius:3px}
  .rc-a{background:var(--c1)} .rc-b{background:var(--c2)} .rc-l{background:var(--c-other)} .rc-faded{opacity:.4}
  .rc-fig{font-size:12px;font-weight:600;text-align:right;white-space:nowrap;color:var(--ink);font-variant-numeric:tabular-nums}
  .rc-axis{display:grid;grid-template-columns:62px minmax(0,1fr) 64px;gap:10px;font-size:11px;color:var(--muted)}
  .rc-axis span:first-child{grid-column:2;grid-row:1;justify-self:start}
  .rc-axis span:nth-child(2){grid-column:2;grid-row:1;justify-self:center}
  .rc-axis span:last-child{grid-column:2;grid-row:1;justify-self:end}
  .rc-det{margin:6px 0 0;min-height:17px;font-size:12px;line-height:1.45;color:var(--ink);overflow-wrap:anywhere}
  .rc-all{justify-self:start}
  .rc-tiles .w-tile small{display:block;margin-top:2px;font-size:11px;line-height:1.35;color:var(--muted);overflow-wrap:anywhere}
  .rc-tiles .w-tile b{font-size:20px}
  .rc-meter{height:10px;border-radius:5px;background:var(--card);overflow:hidden}
  .rc-meter span{display:block;height:100%;background:var(--c2);border-radius:5px}
  .rc-ct{display:grid;gap:4px;justify-items:start}
  .rc-reasons{margin:0;padding-left:18px;display:grid;gap:3px;font-size:12px;line-height:1.4;color:var(--muted);overflow-wrap:anywhere}
  .rc-share{display:grid;gap:8px;min-width:0}
  .rc-share>*{min-width:0}
  .rc-sc{background:var(--card);border-radius:14px;padding:16px;display:grid;gap:14px}
  .rc-sch{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .rc-sch b{font-family:var(--display);font-size:17px;font-weight:650;color:var(--ink)}
  .rc-chip{font-size:11px;color:var(--accent);border:1px solid currentColor;border-radius:99px;padding:1px 8px}
  .rc-scf{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:10px}
  .rc-scf div{display:grid;gap:2px}
  .rc-scf b{font-family:var(--display);font-size:26px;font-weight:650;letter-spacing:-.02em;color:var(--ink)}
  .rc-scf div:first-child b{color:var(--accent)}
  .rc-scf span{font-size:11.5px;line-height:1.3;color:var(--muted)}
  .rc-sc p{margin:0;font-size:11px;color:var(--muted)}
  .rc-sa{display:flex;gap:14px;align-items:center}
  .rc-txt{width:100%;box-sizing:border-box;font:inherit;font-size:12px;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px}
`;

function Card({ p }: { p: ReportCardPayload }) {
  const [privacy, setPrivacy] = useState(false);
  const [sharing, setSharing] = useState(false);
  const f = privacy ? HIDDEN_FMT : SHOWN;
  const canShare = shareFigures(p).length > 0;
  return (
    <section class="w-shell" role="region" aria-label="Investing report card">
      <style>{STYLE}</style>
      <div class="rc-top">
        <ViewControls privacy={privacy} onPrivacy={setPrivacy} />
        {canShare && <button type="button" class="w-tgl" aria-pressed={sharing} onClick={() => setSharing(!sharing)}>Share card</button>}
      </div>
      {sharing && canShare && <Share p={p} />}
      <Overall p={p} />
      <Calls p={p} />
      <AfterSold p={p} f={f} />
      <TradingCost p={p} f={f} />
      <p class="rc-asof">{`As of ${calendarDate(p.asOf)}. From your stored activity and cached market closes. Facts only, not advice.`}</p>
      <BrandFooter advice={false} />
    </section>
  );
}

export function ReportCard({ bridge }: { bridge: Bridge }) {
  return (
    <HydratedCard bridge={bridge} showTool="show_report_card" isPayload={isPayload} loadingText={LOADING_COPY} unavailableText="Report card unavailable right now">
      {(p) => <Card p={p} />}
    </HydratedCard>
  );
}
