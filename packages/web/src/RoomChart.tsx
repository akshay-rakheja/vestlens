import { useId } from "react";

import type { LedgerRowView } from "./apiErrors";
import { cad, calendarDate } from "./roomFormat";

const W = 640;
const H = 200;
const PAD = { l: 12, r: 12, t: 14, b: 22 };

/** Whole days since 1970-01-01 for a YYYY-MM-DD date. */
const dayNumber = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "4 Mar 2025": an axis end of a span that isn't a calendar year. */
const shortDate = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number) as [number, number, number]; return `${d} ${MONTHS[m - 1]} ${y}`; };

/** The rows the line can draw: from 1 January up to the last row before the first unknown running value. */
function knownPrefix(rows: LedgerRowView[]): { points: LedgerRowView[]; complete: boolean } {
  const points: LedgerRowView[] = [];
  for (const r of rows) {
    if (r.roomLeftCad === null || !r.date) return { points, complete: false };
    points.push(r);
  }
  return { points, complete: true };
}

/** The chart's text alternative: start room, final room or excess and the over-since date, or where it stops being known. */
export function roomChartLabel(rows: LedgerRowView[], overSince: string | null, name = "Room left over the year"): string {
  const start = rows[0]?.roomLeftCad;
  if (start === null || start === undefined) return `${name}: not known yet.`;
  const { points, complete } = knownPrefix(rows);
  if (!complete) return `${name}: started at ${cad(start)}, not known after ${calendarDate(points[points.length - 1]!.date!, false)}.`;
  const last = points[points.length - 1]!.roomLeftCad!;
  const end = last < 0
    ? `ended over by ${cad(-last)}${overSince ? ` since ${calendarDate(overSince, false)}` : ""}`
    : `ended with ${cad(last)} left`;
  return `${name}: started at ${cad(start)}, ${end}.`;
}

/**
 * A step line of room left from 1 January (or, with `span`, from its first day, such as an RRSP tax year's window):
 * dashed zero line, the stretch below zero shaded, a point at each move. `name` begins the text alternative.
 */
export function RoomChart({ rows, overSince, span, name }: { rows: LedgerRowView[]; overSince: string | null; span?: { from: string; to: string }; name?: string }) {
  // Several charts can share a page (one per RRSP tax year): each needs its own clip path id.
  const clip = `room-chart-below-zero-${useId().replace(/:/g, "")}`;
  const first = rows[0];
  if (!first || first.roomLeftCad === null || !first.date) return null;
  // The line stops at the last row before the first unknown running value; only a fully known line runs on to today.
  const prefix = knownPrefix(rows);
  const year = Number(first.date.slice(0, 4));
  const origin = dayNumber(span?.from ?? `${year}-01-01`);
  const totalDays = dayNumber(span?.to ?? `${year}-12-31`) - origin;
  const points = prefix.points.map((r) => ({ day: dayNumber(r.date!) - origin, value: r.roomLeftCad! }));
  const todayDay = dayNumber(new Date().toISOString().slice(0, 10)) - origin;
  const lastDay = points[points.length - 1]!.day;
  const endDay = !prefix.complete ? lastDay : todayDay >= 0 && todayDay <= totalDays ? Math.max(todayDay, lastDay) : totalDays;

  const values = points.map((p) => p.value);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const range = max - min || 1;
  const x = (day: number) => PAD.l + (day / (totalDays || 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + ((max - v) / range) * (H - PAD.t - PAD.b);
  const zeroY = y(0);

  let d = `M ${x(points[0]!.day)} ${y(points[0]!.value)}`;
  for (let i = 1; i < points.length; i++) d += ` H ${x(points[i]!.day)} V ${y(points[i]!.value)}`;
  if (endDay > lastDay) d += ` H ${x(endDay)}`;
  const area = `${d} V ${zeroY} H ${x(points[0]!.day)} Z`;
  const label = roomChartLabel(rows, overSince, name);

  return (
    <figure className="tfsa-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="xMidYMid meet" style={{ width: "100%", height: "auto" }}>
        <defs>
          <clipPath id={clip}><rect x={0} y={zeroY} width={W} height={Math.max(0, H - zeroY)} /></clipPath>
        </defs>
        <path d={area} clipPath={`url(#${clip})`} style={{ fill: "var(--attn)", opacity: 0.22 }} data-testid="room-chart-over" />
        <line x1={PAD.l} x2={W - PAD.r} y1={zeroY} y2={zeroY} strokeDasharray="5 4" style={{ stroke: "var(--muted)" }} strokeWidth={1} />
        <path d={d} fill="none" style={{ stroke: "var(--accent)" }} strokeWidth={2} data-testid="room-chart-line" />
        {points.map((p, i) => <circle key={i} cx={x(p.day)} cy={y(p.value)} r={3} style={{ fill: "var(--accent-deep)" }} />)}
        <text x={PAD.l} y={H - 6} fontSize={11} style={{ fill: "var(--muted)" }}>{span ? shortDate(span.from) : "1 Jan"}</text>
        <text x={W - PAD.r} y={H - 6} fontSize={11} textAnchor="end" style={{ fill: "var(--muted)" }}>{span ? shortDate(span.to) : "31 Dec"}</text>
        <text x={W - PAD.r} y={zeroY - 4} fontSize={11} textAnchor="end" style={{ fill: "var(--muted)" }}>$0</text>
      </svg>
      {overSince && min < 0 && <figcaption className="data-controls-copy">{`over by ${cad(-values[values.length - 1]!)} since ${calendarDate(overSince, false)}`}</figcaption>}
    </figure>
  );
}
