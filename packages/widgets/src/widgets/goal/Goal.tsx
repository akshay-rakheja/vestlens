import type { Bridge } from "../../kit/bridge";
import { BrandFooter } from "../../kit/components";
import { HydratedCard } from "../../kit/hydrated";
import { dollars, estLabel } from "../tfsa-room/format";
import type { GoalCheck, GoalPayload } from "./types";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const numOrNull = (v: unknown) => v === null || typeof v === "number";
const DATE_STATUS = new Set(["future", "under_month", "passed"]);
const goodGoal = (g: unknown) => isObj(g) && typeof g.name === "string" && typeof g.slug === "string" && typeof g.targetCad === "number" && typeof g.targetDate === "string"
  && typeof g.dateStatus === "string" && DATE_STATUS.has(g.dateStatus) && typeof g.monthsLeft === "number" && typeof g.estimated === "boolean"
  && [g.savedCad, g.savedPct, g.remainingCad, g.neededPerMonthFlatCad, g.recentPacePerMonthCad, g.projectedAtPaceCad, g.projectedWithRateCad, g.growthRatePct].every(numOrNull)
  && (g.savedFxDate === null || typeof g.savedFxDate === "string") && (g.paceFxDate === null || typeof g.paceFxDate === "string") && typeof g.paceEstimated === "boolean"
  && Array.isArray(g.series) && g.series.every((p) => isObj(p) && typeof p.date === "string" && typeof p.valueCad === "number")
  && Array.isArray(g.notes) && g.notes.every((n) => typeof n === "string");
const isPayload = (c: unknown): c is GoalPayload => isObj(c) && Array.isArray(c.goals) && c.goals.every(goodGoal);

const sentence = (s: string) => (s.length === 0 ? s : `${s[0]!.toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? "" : "."}`);
const PACE_SINCE = /^pace since (\d{4}-\d{2}-\d{2})$/;
/** Notes the card shows in their own place, not in the notes list. */
const STATUS_NOTES = new Set(["target date passed", "less than a month left"]);

function monthsLeft(g: GoalCheck): string {
  if (g.dateStatus === "passed") return "Target date passed";
  if (g.dateStatus === "under_month") return "Less than a month left";
  const whole = Math.floor(g.monthsLeft);
  return whole === 1 ? "1 month left" : `${whole} months left`;
}

const W = 300, H = 110, PAD = 6;

/**
 * Saved value by week (solid) against a straight line from the first point to the target on its date. Points with an
 * unreadable date are dropped; fewer than two readable points draw nothing. A target on or before the first point has
 * no line to draw, and one before the last point ends the line there.
 */
function PaceChart({ g }: { g: GoalCheck }) {
  const points = g.series.map((s) => ({ d: s.date, t: Date.parse(s.date), v: s.valueCad })).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
  if (points.length < 2) return null;
  const first = points[0]!, last = points[points.length - 1]!;
  const target = Date.parse(g.targetDate);
  const hasLine = Number.isFinite(target) && target > first.t;
  const t0 = first.t, t1 = Math.max(hasLine ? target : last.t, last.t);
  const top = Math.max(hasLine ? g.targetCad : 0, ...points.map((p) => p.v), 1);
  const x = (t: number) => PAD + (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * (W - 2 * PAD));
  const y = (v: number) => H - PAD - (Math.max(0, v) / top) * (H - 2 * PAD);
  const actual = points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const line = `${x(t0).toFixed(1)},${y(first.v).toFixed(1)} ${x(target).toFixed(1)},${y(g.targetCad).toFixed(1)}`;
  return (
    <div>
      <svg class="gl-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={hasLine ? `Saved value by week against a straight line to the target of ${dollars(g.targetCad)} by ${g.targetDate}` : "Saved value by week"}>
        {hasLine && <polyline points={line} fill="none" stroke="var(--muted)" stroke-width="2" stroke-dasharray="5 4" vector-effect="non-scaling-stroke" />}
        <polyline points={actual} fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
      </svg>
      <div class="gl-legend w-muted">
        <span><span class="gl-key actual" />Actual</span>
        {hasLine && <span><span class="gl-key line" />Straight line to target</span>}
        <span>{`${first.d} to ${hasLine ? g.targetDate : last.d}`}</span>
      </div>
    </div>
  );
}

function Card({ g }: { g: GoalCheck }) {
  const est = estLabel(g.estimated, g.savedFxDate);
  const paceEst = estLabel(g.paceEstimated, g.paceFxDate);
  // A projection rests on the saved total and the pace: estimated if either is, dated by the later rate.
  const proj = estLabel(g.estimated || g.paceEstimated, [g.savedFxDate, g.paceFxDate].filter((d): d is string => d !== null).sort().at(-1) ?? null);
  const paceSince = g.notes.map((n) => PACE_SINCE.exec(n)?.[1]).find((d) => d !== undefined);
  const notes = g.notes.filter((n) => !PACE_SINCE.test(n) && !STATUS_NOTES.has(n));
  const bar = g.savedPct === null ? null : Math.min(100, Math.max(0, g.savedPct));
  return (
    <div class="gl-card">
      <h2 class="gl-name">{g.name}</h2>
      <p class="w-muted">{`${dollars(g.targetCad)} by ${g.targetDate}`}</p>
      {g.savedCad === null ? <p class="gl-line">Saved so far: can't tell</p> : g.savedAtLeast ? (
        <p class="gl-line">{`At least ${dollars(g.savedCad)}${est} saved; an account's value is unknown, so there is no percentage of the target`}</p>
      ) : (
        <>
          <p class="gl-line">{`About ${dollars(g.savedCad)}${est} saved, ${Math.round(g.savedPct ?? 0)}% of the target`}</p>
          <div class="gl-bar" role="progressbar" aria-label="Saved so far" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(bar ?? 0)}>
            <span style={{ width: `${bar}%` }} />
          </div>
        </>
      )}
      <p class="gl-line">{monthsLeft(g)}</p>
      {g.series.length > 0 && <PaceChart g={g} />}
      {g.remainingCad === 0 ? <p class="gl-line">Target reached</p>
        : g.remainingCad !== null && g.neededPerMonthFlatCad === null
        ? <p class="gl-line">{`About ${dollars(g.remainingCad)}${est} still to go`}</p>
        : g.neededPerMonthFlatCad !== null && <p class="gl-line">{`About ${dollars(g.neededPerMonthFlatCad)}${est} a month from here reaches the target if values stay flat`}</p>}
      {g.recentPacePerMonthCad === null ? <p class="gl-line">Recent pace: can't tell</p> : (
        <>
          <p class="gl-line">{`About ${dollars(g.recentPacePerMonthCad)}${paceEst} a month in net contributions ${paceSince ? `since ${paceSince}` : "over the last 6 months"}`}</p>
          {g.projectedAtPaceCad !== null && <p class="gl-line">{`At that pace, about ${dollars(g.projectedAtPaceCad)}${proj} by ${g.targetDate} with no growth`}</p>}
        </>
      )}
      {g.growthRatePct !== null && g.projectedWithRateCad !== null && (
        <p class="gl-line">{`With your ${g.growthRatePct}% yearly growth rate (your assumption): about ${dollars(g.projectedWithRateCad)}${proj} by ${g.targetDate}`}</p>
      )}
      {notes.length > 0 && <ul class="gl-notes">{notes.map((n, i) => <li key={i}>{sentence(n)}</li>)}</ul>}
    </div>
  );
}

export function Goal({ bridge }: { bridge: Bridge }) {
  return (
    <HydratedCard bridge={bridge} showTool="show_goal" isPayload={isPayload} loadingText="Loading your goal…" unavailableText="Savings goal unavailable right now">
      {(p) => (
        <section class="w-shell" role="region" aria-label="Savings goal">
          <style>{`
            .gl-card{display:grid;gap:8px;min-width:0}
            .gl-card + .gl-card{border-top:1px solid var(--line);padding-top:14px}
            .gl-name{margin:0;font-family:var(--display);font-size:21px;font-weight:700;letter-spacing:-.02em;overflow-wrap:anywhere}
            .gl-card p{margin:0}
            .gl-line{font-size:14px;line-height:1.4;overflow-wrap:anywhere}
            .gl-bar{height:10px;border-radius:6px;background:var(--line);overflow:hidden}
            .gl-bar span{display:block;height:100%;background:var(--accent);border-radius:6px}
            .gl-chart{display:block;width:100%;height:110px}
            .gl-legend{display:flex;flex-wrap:wrap;gap:2px 12px;margin-top:4px}
            .gl-key{display:inline-block;width:14px;height:0;margin-right:5px;vertical-align:middle;border-top:2px solid var(--accent)}
            .gl-key.line{border-top:2px dashed var(--muted)}
            .gl-notes{margin:0;padding-left:16px;display:grid;gap:3px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
            .w-muted{overflow-wrap:anywhere}
          `}</style>
          {p.goals.length === 0 ? <p class="w-muted">No savings goals are saved yet.</p> : p.goals.map((g) => <Card key={g.slug} g={g} />)}
          <BrandFooter advice={false} />
        </section>
      )}
    </HydratedCard>
  );
}
