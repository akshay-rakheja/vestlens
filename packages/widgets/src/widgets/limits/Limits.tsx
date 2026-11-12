import type { Bridge } from "../../kit/bridge";
import { BrandFooter } from "../../kit/components";
import { HydratedCard } from "../../kit/hydrated";
import type { LimitGroup, LimitRow, LimitStatus, LimitsPayload } from "./types";

const STATUS_WORD: Record<LimitStatus, string> = { within: "Within", over: "Over", cant_tell: "Can't tell" };
/** The same sentences as the API text (packages/api/src/mcp/limit-tools.ts PORTFOLIO_BASIS, SUBSET_BASIS), without the brackets. */
const PORTFOLIO_BASIS = "of your portfolio, cash included";
const SUBSET_BASIS = "of the chosen accounts, cash included";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const goodRow = (r: unknown) => isObj(r) && typeof r.line === "string" && typeof r.status === "string" && r.status in STATUS_WORD
  && (r.currentPct === null || typeof r.currentPct === "number") && typeof r.maxPct === "number" && typeof r.label === "string";
const isPayload = (c: unknown): c is LimitsPayload =>
  isObj(c) && Array.isArray(c.limits) && c.limits.every((l) => isObj(l) && typeof l.slug === "string" && typeof l.label === "string"
    && typeof l.maxPct === "number" && Array.isArray(l.rows) && l.rows.every(goodRow));

/** A percentage: one decimal at most, no trailing ".0" (the API's formatPct). */
const pct = (n: number) => String(Math.round(n * 10) / 10);
const sentence = (s: string) => (s.length === 0 ? s : `${s[0]!.toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? "" : "."}`);

/** The row's note is "<basis>; <other notes>": the basis becomes its own sentence, the rest are notes (the unclassified one among them). */
function splitNote(note: string | undefined): { basis: string; notes: string[] } {
  const [first, ...rest] = (note ?? "").split("; ").filter((s) => s.length > 0);
  return { basis: first?.startsWith("Share of the chosen accounts") ? SUBSET_BASIS : PORTFOLIO_BASIS, notes: rest };
}

function Bar({ row }: { row: LimitRow }) {
  if (row.currentPct === null) return null;
  const scale = Math.max(row.currentPct, row.maxPct, 1);
  const fill = Math.min(100, Math.max(0, (row.currentPct / scale) * 100));
  const mark = Math.min(100, (row.maxPct / scale) * 100);
  return (
    <div class={`lm-bar ${row.status}`} role="img" aria-label={`${row.label} is ${pct(row.currentPct)}% against a ${pct(row.maxPct)}% limit`}>
      <span class="fill" style={{ width: `${fill}%` }} />
      <span class="mark" style={{ left: `${mark}%` }} />
    </div>
  );
}

function Row({ row }: { row: LimitRow }) {
  const { basis, notes } = splitNote(row.note);
  // One listing of a company: the combined row above carries the status, the bar and the notes.
  if (row.informational) return <li class="lm-row"><span class="w-muted">{row.line}</span></li>;
  return (
    <li class="lm-row">
      <div class="lm-top">
        <span class={`lm-status ${row.status}`}>{STATUS_WORD[row.status]}</span>
        <span class="lm-line">{row.line}</span>
      </div>
      <Bar row={row} />
      <div class="w-muted">{basis}</div>
      {notes.map((n, i) => <div key={i} class="w-muted">{sentence(n)}</div>)}
    </li>
  );
}

export function Limits({ bridge }: { bridge: Bridge }) {
  return (
    <HydratedCard bridge={bridge} showTool="show_limits" isPayload={isPayload} loadingText="Loading your limits…" unavailableText="Limits unavailable right now">
      {(p) => (
        <section class="w-shell" role="region" aria-label="Portfolio limits">
          <style>{`
            .lm-group{display:grid;gap:8px}
            .lm-title{margin:0;font-family:var(--display);font-size:13.5px;color:var(--ink);font-weight:600;overflow-wrap:anywhere}
            .lm-rows{margin:0;padding:0;list-style:none;display:grid;gap:12px}
            .lm-row{display:grid;gap:5px;min-width:0}
            .lm-top{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline}
            .lm-line{font-size:14px;font-weight:600;overflow-wrap:anywhere}
            .lm-status{font-size:11px;font-weight:600;padding:1px 8px;border-radius:99px;background:var(--card);color:var(--muted);border:1px solid var(--line)}
            .lm-status.over{background:var(--attn-bg);color:var(--attn);border-color:transparent}
            .lm-status.within{background:var(--up-bg);color:var(--up);border-color:transparent}
            .lm-bar{position:relative;height:10px;border-radius:6px;background:var(--line)}
            .lm-bar .fill{position:absolute;left:0;top:0;bottom:0;border-radius:6px;background:var(--accent)}
            .lm-bar.over .fill{background:var(--attn)}
            .lm-bar .mark{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;background:var(--ink)}
            .w-muted{overflow-wrap:anywhere}
          `}</style>
          {p.limits.length === 0 ? <p class="w-muted">No limits are saved yet.</p> : p.limits.map((g) => (
            <div key={g.slug} class="lm-group" role="group" aria-label={`${pct(g.maxPct)}% limit on ${g.label}`}>
              <h2 class="lm-title">{`${pct(g.maxPct)}% limit on ${g.label}`}</h2>
              <ul class="lm-rows">{g.rows.map((r, i) => <Row key={i} row={r} />)}</ul>
            </div>
          ))}
          <BrandFooter advice={false} />
        </section>
      )}
    </HydratedCard>
  );
}
