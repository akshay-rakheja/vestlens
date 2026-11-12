import type { Bridge } from "../../kit/bridge";
import { BrandFooter } from "../../kit/components";
import { HydratedCard } from "../../kit/hydrated";
import type { ConditionCheck, ConditionStatus, HoldingBlock, HoldingView, NewsItem, PlayedOut, ThesisCheck, ThesisPayload } from "./types";

const NEWS_LIMIT = 5;
const STATUS_WORD: Record<ConditionStatus, string> = { held: "Held", broken: "Broken", cant_tell: "Can't tell" };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStr = (v: unknown) => typeof v === "string";
const STATUSES = new Set(["held", "broken", "cant_tell"]);
const goodCondition = (c: unknown) => isObj(c) && isStr(c.id) && isStr(c.text) && typeof c.status === "string" && STATUSES.has(c.status);
const goodNews = (n: unknown) => isObj(n) && isStr(n.title) && isStr(n.source) && isStr(n.publishedAt);
const goodTimeFrame = (t: unknown) => t === null || (isObj(t) && isStr(t.label));
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const goodPlayedOut = (p: unknown) => isObj(p) && Array.isArray(p.excluded) && p.excluded.every(isStr) && Array.isArray(p.notes) && p.notes.every(isStr)
  && (p.returnPct === null || isNum(p.returnPct));
const goodBlock = (h: unknown) => isObj(h) && goodPlayedOut(h.sinceFirstBought)
  && (h.weight === null || (isObj(h.weight) && isNum(h.weight.pct) && isStr(h.weight.asOf)))
  && (h.weightNote === undefined || isStr(h.weightNote))
  && Array.isArray(h.limits) && h.limits.every((l) => isObj(l) && isStr(l.text) && isStr(l.status))
  && Array.isArray(h.news) && h.news.every(goodNews) && isStr(h.newsLabel);
const goodHolding = (h: unknown) => goodBlock(h) && isStr((h as Record<string, unknown>).noReasons);
/** With a thesis: the full block, or an older result's since row only. */
const goodThesisHolding = (h: unknown) => isObj(h) && (h.limits === undefined ? goodPlayedOut(h.sinceFirstBought) : goodBlock(h));
const isBlock = (h: HoldingBlock | { sinceFirstBought: PlayedOut }): h is HoldingBlock => "limits" in h;
const isPayload = (c: unknown): c is ThesisPayload => {
  if (!isObj(c)) return false;
  if (c.mode === "list") {
    return Array.isArray(c.theses) && c.theses.every((t) => isObj(t) && isStr(t.ticker) && isStr(t.reasons) && isStr(t.writtenAt)
      && goodTimeFrame(t.timeFrame) && Array.isArray(t.conditions) && t.conditions.every(goodCondition));
  }
  if (c.mode !== "one" || !isStr(c.ticker)) return false;
  if (c.thesis === null) return c.holding === undefined || c.holding === null || goodHolding(c.holding);
  if (c.holding !== undefined && c.holding !== null && !goodThesisHolding(c.holding)) return false;
  const t = c.thesis;
  if (!isObj(t) || !isStr(t.reasons) || !isObj(t.check)) return false;
  const k = t.check;
  return isStr(k.ticker) && isStr(k.writtenAt) && goodTimeFrame(k.timeFrame)
    && Array.isArray(k.conditions) && k.conditions.every(goodCondition)
    && Array.isArray(k.news) && k.news.every(goodNews)
    && Array.isArray(k.earnings) && k.earnings.every((e) => isObj(e) && isStr(e.date))
    && isObj(k.playedOut) && Array.isArray(k.playedOut.excluded) && Array.isArray(k.playedOut.notes);
};

/** One decimal, as the API's text does. Percentages only: money never goes through here. */
const pct1 = (n: number) => `${(Math.round(n * 10) / 10).toFixed(1)}%`;
const signedPts = (n: number) => `${n >= 0 ? "+" : ""}${(Math.round(n * 10) / 10).toFixed(1)} pts`;

function Chip({ status }: { status: ConditionStatus }) {
  return <span class={`th-chip ${status}`}>{STATUS_WORD[status]}</span>;
}

function Condition({ c }: { c: ConditionCheck }) {
  return (
    <li>
      <Chip status={c.status} />
      <span class="th-text">{c.text}</span>
      {c.evidence && <span class="w-muted">{` (${c.evidence.value}, ${c.evidence.asOf})`}</span>}
      {c.note && <div class="w-muted">{c.note}</div>}
    </li>
  );
}

function News({ item, bridge }: { item: NewsItem; bridge: Bridge }) {
  // Only an https address is handed to the host; anything else is shown as plain text.
  const link = typeof item.url === "string" && /^https:\/\//i.test(item.url) ? item.url : null;
  return (
    <li>
      {link ? <button type="button" class="th-link" onClick={() => void bridge.openLink(link)}>{item.title}</button> : <span class="th-text">{item.title}</span>}
      <div class="w-muted">{`${item.publishedAt.slice(0, 10)} · ${item.source}${item.tone ? ` · ${item.tone}` : ""}`}</div>
    </li>
  );
}

function Cell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div class="th-cell">
      <span class="w-muted">{label}</span>
      <span class="th-val">{value}</span>
      {sub && <span class="w-muted">{sub}</span>}
    </div>
  );
}

function PlayedOutRow({ p, label = "How it played out" }: { p: PlayedOut; label?: string }) {
  if (p.returnPct === null) {
    return (
      <div class="th-box" role="group" aria-label={label}>
        <h3 class="th-sub">{label}</h3>
        <p class="th-text">{p.reason ?? "no comparison"}</p>
      </div>
    );
  }
  const you = p.returnPct;
  const est = p.estimated ? ", est." : "";
  const span = !p.startDate || !p.endDate ? "" : label === SINCE_FIRST_RECORDED ? ` (${p.startDate}) to ${p.endDate}${est}` : ` (${p.startDate} to ${p.endDate}${est})`;
  return (
    <div class="th-box" role="group" aria-label={label}>
      <h3 class="th-sub">{`${label}${span}`}</h3>
      <div class="th-cells">
        <Cell label="You" value={pct1(you)} />
        {p.vsSp500Pct !== null && <Cell label="S&P 500" value={pct1(you - p.vsSp500Pct)} sub={`you ${signedPts(p.vsSp500Pct)}`} />}
        {p.vsTsxPct !== null && <Cell label="TSX" value={pct1(you - p.vsTsxPct)} sub={`you ${signedPts(p.vsTsxPct)}`} />}
      </div>
    </div>
  );
}

/** A comparison row with its notes (less any already shown, M-4) and what it left out. */
function Comparison({ p, label, skipNotes = [] }: { p: PlayedOut; label: string; skipNotes?: string[] }) {
  const notes = p.notes.filter((n) => !skipNotes.includes(n));
  return (
    <>
      <PlayedOutRow p={p} label={label} />
      {notes.length > 0 && <ul class="th-notes">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {p.excluded.length > 0 && (
        <section>
          <h3 class="th-sub">Left out of the comparison</h3>
          <ul class="th-list" aria-label={label === SINCE_FIRST_RECORDED ? "Left out since your first recorded purchase" : "Left out of the comparison"}>{p.excluded.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </section>
      )}
    </>
  );
}

const SINCE_FIRST_RECORDED = "Since your first recorded purchase";

/** Weight, the limits touching the holding, and its news (one list). */
function Block({ h, bridge }: { h: HoldingBlock; bridge: Bridge }) {
  const news = h.news.slice(0, NEWS_LIMIT);
  return (
    <>
      <section>
        <h3 class="th-sub">Share of your portfolio</h3>
        <p class="th-text">{h.weight ? `${pct1(h.weight.pct)}${h.weight.estimated === false ? "" : " (est.)"}, cash included, as of ${h.weight.asOf}` : `can't tell: ${h.weightNote ?? "portfolio weight not available"}`}</p>
        {h.weight?.netOfMargin && <p class="th-text">The total is net of a margin debit (the brokerage total), so a share can be over 100%.</p>}
        {h.weight?.notInTotal && h.weight.notInTotal.length > 0 && <p class="th-text">{`Not included in the total: ${h.weight.notInTotal.join(", ")}. SnapTrade doesn't provide the value of Wealthsimple managed portfolios.`}</p>}
      </section>
      {h.limits.length > 0 && (
        <section>
          <h3 class="th-sub">Your limits</h3>
          <ul class="th-list" aria-label="Your limits on it">{h.limits.map((l, i) => <li key={i}>{l.text}</li>)}</ul>
        </section>
      )}
      <section>
        <h3 class="th-sub">{h.newsLabel}</h3>
        {news.length > 0
          ? <ul class="th-list" aria-label={h.newsLabel}>{news.map((n, i) => <News key={i} item={n} bridge={bridge} />)}</ul>
          : <p class="w-muted">{h.newsLabel === "News since you wrote it" ? "No news found since you wrote it." : "No news found in the last 30 days."}</p>}
      </section>
    </>
  );
}

/** No thesis: how the holding has done since the first recorded purchase, its weight and limits, recent news. */
function HoldingDetail({ ticker, h, bridge }: { ticker: string; h: HoldingView; bridge: Bridge }) {
  return (
    <>
      <h2 class="th-head">{ticker}</h2>
      <Comparison p={h.sinceFirstBought} label={SINCE_FIRST_RECORDED} />
      <Block h={h} bridge={bridge} />
      <p class="th-text">{h.noReasons}</p>
    </>
  );
}

function Detail({ reasons, boughtAround, check, holding, bridge }: {
  reasons: string; boughtAround: string | null; check: ThesisCheck; holding: HoldingBlock | { sinceFirstBought: PlayedOut } | null; bridge: Bridge;
}) {
  const block = holding && isBlock(holding) ? holding : null;
  const news = check.news.slice(0, NEWS_LIMIT);
  const p = check.playedOut;
  return (
    <>
      <h2 class="th-head">{check.ticker}</h2>
      <section>
        <h3 class="th-sub">Your reasons</h3>
        <p class="th-reasons">{reasons}</p>
      </section>
      <p class="th-frame">
        {check.timeFrame ? check.timeFrame.label : "No time frame"}
        <span class="w-muted">{` · written ${check.writtenAt.slice(0, 10)}${boughtAround ? ` · bought around ${boughtAround}` : ""}`}</span>
      </p>
      {check.conditions.length > 0 ? (
        <section>
          <h3 class="th-sub">Conditions</h3>
          <ul class="th-list" aria-label="Conditions">{check.conditions.map((c) => <Condition key={c.id} c={c} />)}</ul>
        </section>
      ) : <p class="w-muted">No conditions saved.</p>}
      {!block && <section>
        <h3 class="th-sub">News since you wrote it</h3>
        {news.length > 0
          ? <ul class="th-list" aria-label="News since you wrote it">{news.map((n, i) => <News key={i} item={n} bridge={bridge} />)}</ul>
          : <p class="w-muted">No news found since you wrote it.</p>}
      </section>}
      {check.earnings.length > 0 && <p class="th-text">{`Earnings reports: ${check.earnings.map((e) => e.date).join(", ")}`}</p>}
      <Comparison p={p} label="How it played out" />
      {holding && <Comparison p={holding.sinceFirstBought} label={SINCE_FIRST_RECORDED} skipNotes={p.notes} />}
      {block && <Block h={block} bridge={bridge} />}
    </>
  );
}

function counts(conditions: ConditionCheck[]): string {
  if (conditions.length === 0) return "No conditions";
  const n = (s: ConditionStatus) => conditions.filter((c) => c.status === s).length;
  return `${n("held")} held · ${n("broken")} broken · ${n("cant_tell")} can't tell`;
}

function Body({ p, bridge }: { p: ThesisPayload; bridge: Bridge }) {
  if (p.mode === "list") {
    if (p.theses.length === 0) return <p class="th-text">No theses are saved yet.</p>;
    return (
      <ul class="th-list th-theses" aria-label="Saved theses">
        {p.theses.map((t) => (
          <li key={t.ticker}>
            <span class="th-val">{t.ticker}</span>
            <span class="w-muted">{` · ${t.timeFrame ? t.timeFrame.label : "no time frame"} · written ${t.writtenAt.slice(0, 10)}`}</span>
            <div class="th-reasons">{t.reasons}</div>
            <div class="w-muted">{counts(t.conditions)}</div>
          </li>
        ))}
      </ul>
    );
  }
  if (p.thesis === null) {
    if (p.holding) return <HoldingDetail ticker={p.ticker} h={p.holding} bridge={bridge} />;
    // Never held; an older result without the holding view keeps its own message.
    return <p class="th-text">{p.holding === null ? `You don't hold ${p.ticker} in a connected account.` : `No thesis is saved on ${p.ticker}.`}</p>;
  }
  return <Detail reasons={p.thesis.reasons} boughtAround={p.thesis.boughtAround} check={p.thesis.check} holding={p.holding ?? null} bridge={bridge} />;
}

export function Thesis({ bridge }: { bridge: Bridge }) {
  return (
    <HydratedCard bridge={bridge} showTool="show_thesis" isPayload={isPayload} loadingText="Loading your holding…" unavailableText="Holding unavailable right now">
      {(p) => (
        <section class="w-shell" role="region" aria-label="Holding check">
          <style>{`
            .th-head{margin:0;font-family:var(--display);font-size:23px;font-weight:700;letter-spacing:-.02em;overflow-wrap:anywhere}
            .th-sub{margin:0 0 4px;font-family:var(--display);font-size:13.5px;color:var(--ink);font-weight:600}
            .th-reasons{margin:0;font-size:14px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
            .th-text{margin:0;font-size:13px;line-height:1.45;overflow-wrap:anywhere}
            .th-frame{margin:0;font-size:13px;font-weight:600;overflow-wrap:anywhere}
            .th-list{margin:0;padding:0;list-style:none;display:grid;gap:8px;font-size:13px;overflow-wrap:anywhere}
            .th-list li{min-width:0}
            .th-theses li{border-top:1px solid var(--line);padding-top:8px}
            .th-chip{display:inline-block;margin-right:6px;padding:1px 8px;border-radius:99px;font-size:11px;font-weight:600;background:var(--card);color:var(--muted);border:1px solid var(--line)}
            .th-chip.held{background:var(--up-bg);color:var(--up);border-color:transparent}
            .th-chip.broken{background:var(--attn-bg);color:var(--attn);border-color:transparent}
            .th-link{all:unset;cursor:pointer;color:var(--accent);text-decoration:underline;overflow-wrap:anywhere}
            .th-link:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
            .th-box{background:var(--card);border-radius:12px;padding:10px 12px}
            .th-cells{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:8px}
            .th-cell{display:grid;gap:2px;font-size:11px}
            .th-val{font-family:var(--display);font-size:17px;font-weight:650;color:var(--ink)}
            .th-notes{margin:0;padding-left:16px;display:grid;gap:3px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
          `}</style>
          <Body p={p} bridge={bridge} />
          <BrandFooter advice={false} />
        </section>
      )}
    </HydratedCard>
  );
}
