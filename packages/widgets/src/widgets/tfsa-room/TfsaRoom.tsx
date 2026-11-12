import { useEffect, useRef, useState } from "preact/hooks";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { WidgetGuard, useHydrateWatchdog } from "../../kit/resilience";
import { Banner, BrandFooter } from "../../kit/components";
import { assumedNote, cad, calendarDate, dashboardEnterable, convertedMoney, fxNote, isOutgoing, ledgerAmount, matchedNote, notCountedLine, returningNote, torontoDate, torontoDateTime, withdrawalRowNote } from "./format";
import type { AmbiguousRow, FhsaSummary, LedgerRow, MissingItem, RoomLedger, RoomPayload, RrspSummary, RrspYearSummary } from "./types";

const FHSA_CRA_FACT = "CRA charges 1% a month on the highest amount over in each month. Check your figures in CRA My Account.";

/** The FHSA headline line under the TFSA card (the server's words); with the participation room missing, the one question. */
function FhsaLine({ f }: { f: FhsaSummary }) {
  const asks = f.status === "missing" && f.missing?.some((m) => m.kind === "fhsa_room");
  return (
    <div class="tr-fhsa" role="group" aria-label="FHSA room">
      <p class="tr-fhsa-label">FHSA</p>
      <p class={`tr-fhsa-head${(f.overLimitCad ?? 0) > 0 ? " over" : ""}`}>
        {`${f.headline}${asks ? `: your FHSA participation room for ${f.year}, from CRA My Account or your notice of assessment` : ""}`}
      </p>
      {Array.isArray(f.notCounted) && f.notCounted.length > 0 && <p class="w-caption">{notCountedLine(f.notCounted, (f.overLimitCad ?? 0) > 0)}</p>}
      {f.note && <p class="w-caption">{f.note}</p>}
      {(f.overLimitCad ?? 0) > 0 && <p class="w-caption">{FHSA_CRA_FACT}</p>}
      {f.newYearNote && <p class="w-caption">{f.newYearNote}</p>}
      {(f.disclosures ?? []).map((d, i) => <p key={i} class="w-caption">{d}</p>)}
    </div>
  );
}

// Verbatim copy (packages/api/src/room/rrsp-room.ts); the server words each year's headline.
const RRSP_CRA_FACT = "CRA charges 1% a month on contributions more than $2,000 over your RRSP deduction limit. Check your figures in CRA My Account.";
const RRSP_LIMIT_PROMPT = "Enter your RRSP deduction limit from CRA My Account or your notice of assessment to see room left.";
const RRSP_DEDUCT_LATER = "Unused contributions can be deducted in a later year; VestLens doesn't choose the year for you.";
// The year's other figures, asked once the limit is entered (pinned to the API's by web-format-drift.test.ts).
const RRSP_UNUSED_QUESTION = (Y: number) =>
  `What unused RRSP contributions does CRA show for ${Y}? It's next to your deduction limit on your notice of assessment and in CRA My Account; enter 0 if there are none.`;
const RRSP_ELSEWHERE_QUESTION = (Y: number) =>
  `Did you contribute to an RRSP VestLens doesn't see for the ${Y} tax year, such as a group RRSP at work, an account at another institution, or a spousal RRSP for your spouse? Enter the total, or 0 if none.`;

const RRSP_MANAGED_QUESTION = (labels: string, Y: number) =>
  `Contributions to ${labels} aren't visible through SnapTrade. Add them, plus any other RRSP contributions VestLens doesn't see for the ${Y} tax year (a group RRSP at work, an account at another institution, a spousal RRSP for your spouse), to 'Contributions not in VestLens'; enter 0 if there are none.`;

/** The year's own figures (the API's RRSP_FIGURE_KINDS): while only these are missing, the headline is the contributions. */
const RRSP_FIGURE_KINDS: ReadonlySet<string> = new Set(["deduction_limit", "unused_contributions", "elsewhere"]);
const contributedHeadline = (y: RrspYearSummary) => (y.missing ?? []).length > 0 && (y.missing ?? []).every((m) => RRSP_FIGURE_KINDS.has(m.kind));
/** The figure entered for RRSPs VestLens can't see, named beside the connected contributions and never added in (the API's rrspYearText words). */
const rrspPlus = (y: RrspYearSummary) => (y.elsewhereCad === null || y.elsewhereCad === undefined ? "" : ` plus ${cad(y.elsewhereCad)} you entered as contributions not in VestLens`);

/** The RRSP block under the TFSA and FHSA lines: one headline per open tax year (previous year first), then the shared facts. */
function RrspBlock({ r }: { r: RrspSummary }) {
  const anyOver = r.years.some((y) => (y.overLimitCad ?? 0) > 0);
  return (
    <div class="tr-fhsa" role="group" aria-label="RRSP room">
      <p class="tr-fhsa-label">RRSP</p>
      {r.years.map((y) => {
        const note = (y.fx ? fxNote(y.fx.contributions).trim() : "") || (y.estimated ? "(est.)" : "");
        // A contributions headline carries the entered figure; any other headline gets a line naming both (B12).
        const plus = contributedHeadline(y);
        const contributed = !plus && typeof y.contributedCad === "number" && rrspPlus(y) ? `${cad(y.contributedCad)} contributed${rrspPlus(y)}` : null;
        return (
          <div key={y.window.taxYear} class="tr-rrsp-year">
            <p class={`tr-fhsa-head${(y.overLimitCad ?? 0) > 0 ? " over" : ""}`}>{`${y.headline}${plus ? rrspPlus(y) : ""}`}</p>
            {contributed && <p class="w-caption">{contributed}</p>}
            {note && <p class="w-caption">{note}</p>}
            {(y.missing ?? []).map((m, i) => {
              if (m.kind === "deduction_limit") return <p key={i} class="w-caption">{RRSP_LIMIT_PROMPT}</p>;
              if (m.kind === "unused_contributions") return <p key={i} class="w-caption">{RRSP_UNUSED_QUESTION(y.window.taxYear)}</p>;
              if (m.kind === "elsewhere") return <p key={i} class="w-caption">{RRSP_ELSEWHERE_QUESTION(y.window.taxYear)}</p>;
              if (m.kind === "managed_rrsp") return <p key={i} class="w-caption">{RRSP_MANAGED_QUESTION((m.labels ?? []).join(", "), y.window.taxYear)}</p>;
              // A fact, not a question: only the full history loading clears it.
              if (m.kind === "coverage") return <p key={i} class="w-caption">{`${m.label ?? "An RRSP"}'s stored activity doesn't reach ${calendarDate(y.window.from)} yet; I'll have a number once its full history has loaded.`}</p>;
              return null;
            })}
          </div>
        );
      })}
      {anyOver && <p class="w-caption">{RRSP_CRA_FACT}</p>}
      <p class="w-caption">{RRSP_DEDUCT_LATER}</p>
    </div>
  );
}

const isPayload = (c: unknown): c is RoomPayload => {
  const p = c as Partial<RoomPayload> | null | undefined;
  if (!p || typeof p !== "object" || typeof p.year !== "number" || !Array.isArray(p.basis) || !p.fx) return false;
  if (p.status === "known") return typeof p.roomLeftCad === "number" && typeof p.contributedCad === "number" && typeof p.craRoomCad === "number";
  return p.status === "missing" && Array.isArray(p.missing);
};

/** "INTERNAL_CASH_TRANSFER_IN" -> "internal cash transfer in". Text only. */
const plainType = (type: string) => type.replace(/_/g, " ").toLowerCase();

/** A transfer that needs checking, as a two-line row: account and type over the date, the amount on the right. */
function Row({ row }: { row: AmbiguousRow }) {
  const date = row.date === "unknown" ? "unknown date" : row.date;
  const amount = row.amountCad === null ? (row.inKind ? "shares moved in kind, no price or close found" : "amount not known in CAD") : convertedMoney(cad(row.amountCad), row);
  return (
    <li>
      <span class="tr-mv-l"><span class="tr-mv-kind">{`${row.label} ${plainType(row.type)}`}</span><small>{date}</small></span>
      <span class="tr-mv-r"><span class="tr-mv-amt">{amount}</span></span>
      {row.inKind && row.amountCad === null && <small class="w-muted">{`No price or close was found for these shares, so answering alone can't give an amount. Give what you have contributed to ${row.label} this year as of a date on or after ${date}, these shares at their value that day included, and don't include amounts already entered elsewhere; that figure then stands in for this row.`}</small>}
    </li>
  );
}

function Item({ item, year }: { item: MissingItem; year: number }) {
  switch (item.kind) {
    case "cra_room": return <li>{`Your TFSA contribution room on 1 January ${year}, from CRA My Account`}</li>;
    case "coverage": return <li>{`What you have contributed to ${item.label} this year (its stored activity doesn't go back to 1 January)`}</li>;
    case "outside_contributions": return <li>{`What you have contributed to ${item.label} this year, and as of what date`}</li>;
    case "stale_activity": return <li>{item.lastSyncedAt === null
      ? `${item.label}'s activity hasn't been loaded yet; there'll be a number after it refreshes`
      : `${item.label}'s activity was last updated ${torontoDateTime(item.lastSyncedAt)}; there'll be a number after it refreshes`}</li>;
    case "disconnected_account": return <li>{`What you contributed this year to a TFSA you confirmed that is no longer connected (key ${item.accountKey})`}</li>;
    case "managed_account": return <li>{`What you have contributed to ${item.label} this year, and as of what date (contributions to it aren't visible through SnapTrade). Don't include amounts already entered elsewhere.`}</li>;
    case "dated_entries": return <li>{`${item.label}'s contributions this year as dated deposits, so withdrawals can be placed correctly`}</li>;
    case "ambiguous": {
      const more = item.count - item.rows.length;
      return (
        <li>
          {`${item.count} ${item.count === 1 ? "transfer needs" : "transfers need"} checking`}
          {item.rows.length > 0 && <ul class="tr-moves" aria-label="Transfers to check">{item.rows.map((r) => <Row key={r.activityKey} row={r} />)}</ul>}
          {more > 0 && <div class="w-muted">{`${more} more need checking after these.`}</div>}
        </li>
      );
    }
  }
}

const VW = 320;
const VH = 110;
const PAD = { l: 8, r: 8, t: 10, b: 16 };
const dayOfYear = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000);
};

/** The rows the line can draw: from 1 January up to the last row before the first unknown running value. */
function knownPrefix(rows: LedgerRow[]): { points: LedgerRow[]; complete: boolean } {
  const points: LedgerRow[] = [];
  for (const r of rows) {
    if (r.roomLeftCad === null || !r.date) return { points, complete: false };
    points.push(r);
  }
  return { points, complete: true };
}

/** The chart's text alternative: start room, final room or excess and the over-since date, or where it stops being known. */
export function chartLabel(ledger: RoomLedger): string {
  const rows = ledger.rows;
  const start = rows[0]?.roomLeftCad;
  if (start === null || start === undefined) return "Room left over the year: not known yet.";
  const { points, complete } = knownPrefix(rows);
  if (!complete) return `Room left over the year: started at ${cad(start)}, not known after ${calendarDate(points[points.length - 1]!.date!, false)}.`;
  const last = points[points.length - 1]!.roomLeftCad!;
  const end = last < 0
    ? `ended over by ${cad(-last)}${ledger.overSince ? ` since ${calendarDate(ledger.overSince, false)}` : ""}`
    : `ended with ${cad(last)} left`;
  return `Room left over the year: started at ${cad(start)}, ${end}.`;
}

/** The same rules as the dashboard's RoomChart: a step line of room left, a dashed zero line, the stretch below zero shaded. */
function RoomChart({ ledger }: { ledger: RoomLedger }) {
  const first = ledger.rows[0];
  if (!first || first.roomLeftCad === null || !first.date) return null;
  // A known result has no unknown row today; the line still stops at the first one, and only a full line runs to today.
  const prefix = knownPrefix(ledger.rows);
  const points = prefix.points.map((r) => ({ day: dayOfYear(r.date!), value: r.roomLeftCad! }));
  const year = Number(first.date.slice(0, 4));
  const yearDays = new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1 ? 365 : 364;
  const nowYear = new Date().getUTCFullYear();
  const today = Math.min(yearDays, Math.max(0, dayOfYear(new Date().toISOString().slice(0, 10))));
  const lastDay = points[points.length - 1]!.day;
  const endDay = !prefix.complete ? lastDay : nowYear === year ? Math.max(today, lastDay) : yearDays;
  const values = points.map((p) => p.value);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const x = (day: number) => PAD.l + (day / yearDays) * (VW - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + ((max - v) / span) * (VH - PAD.t - PAD.b);
  const zeroY = y(0);
  let d = `M ${x(points[0]!.day)} ${y(points[0]!.value)}`;
  for (let i = 1; i < points.length; i++) d += ` H ${x(points[i]!.day)} V ${y(points[i]!.value)}`;
  if (endDay > lastDay) d += ` H ${x(endDay)}`;
  const area = `${d} V ${zeroY} H ${x(points[0]!.day)} Z`;
  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label={chartLabel(ledger)} preserveAspectRatio="xMidYMid meet" style={{ width: "100%", height: "auto" }}>
      <defs><clipPath id="tr-below-zero"><rect x={0} y={zeroY} width={VW} height={Math.max(0, VH - zeroY)} /></clipPath></defs>
      <path d={area} clip-path="url(#tr-below-zero)" fill="var(--attn)" fill-opacity="0.22" data-testid="room-chart-over" />
      <line x1={PAD.l} x2={VW - PAD.r} y1={zeroY} y2={zeroY} stroke="var(--muted)" stroke-width="1" stroke-dasharray="5 4" />
      <path d={d} fill="none" stroke="var(--accent)" stroke-width="2" data-testid="room-chart-line" />
      {points.map((pt, i) => <circle key={i} cx={x(pt.day)} cy={y(pt.value)} r="2.5" fill="var(--accent)" />)}
      <text x={PAD.l} y={VH - 3} font-size="10" fill="var(--muted)">1 Jan</text>
      <text x={VW - PAD.r} y={VH - 3} font-size="10" text-anchor="end" fill="var(--muted)">31 Dec</text>
    </svg>
  );
}

/** The last 3 rows; a went-over row is always among them (it replaces the earliest of the three when older). */
export function compactRows(rows: LedgerRow[]): LedgerRow[] {
  const last = rows.slice(-3);
  if (last.some((r) => r.wentOver)) return last;
  const idx = rows.map((r) => r.wentOver).lastIndexOf(true);
  return idx < 0 ? last : [rows[idx]!, ...rows.slice(-2)];
}

/** What the move was, in words: "TFSA contribution", "TFSA withdrawal", "TFSA transfer". */
function kindText(row: LedgerRow): string {
  switch (row.kind) {
    case "cra_room": return "Room on 1 January";
    case "contribution": return `${row.label} contribution`;
    case "withdrawal": return `${row.label} withdrawal`;
    case "none": case "ambiguous": return `${row.label} transfer`;
    case "outside_total": return `${row.label} total`;
  }
}

/** The move's own note (what it did to the room) and any matched or assumed note, as one sentence. */
function moveNote(row: LedgerRow): string | null {
  const own = (() => {
    switch (row.kind) {
      case "cra_room": return "from CRA My Account (you entered)";
      case "withdrawal": return withdrawalRowNote(row);
      case "none": return `moved ${isOutgoing(row) ? "to" : "from"} another TFSA, no effect on room`;
      case "ambiguous": return "needs checking: was it new money?";
      case "outside_total": return "a total, not dated deposits";
      default: return null;
    }
  })();
  const notes = [own, matchedNote(row), assumedNote(row)].filter((n): n is string => n !== null);
  if (notes.length === 0) return null;
  const text = notes.join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Two-line rows: the move and its date on the left; the signed amount with the room left beneath it on the right. */
function LedgerRows({ rows }: { rows: LedgerRow[] }) {
  return (
    <ul class="tr-moves tr-ledger" aria-label="Latest moves">
      {compactRows(rows).map((row, i) => {
        const note = moveNote(row);
        return (
          <li key={i} class={row.wentOver ? "over" : ""}>
            <span class="tr-mv-l">
              <span class="tr-mv-kind">{kindText(row)}</span>
              <small>{row.date ? calendarDate(row.date) : "unknown date"}</small>
              {note && <small class="tr-mv-note">{note}</small>}
            </span>
            <span class="tr-mv-r">
              <span class="tr-mv-amt">{row.kind === "cra_room" ? (row.amountCad === null ? "?" : cad(row.amountCad)) : ledgerAmount(row)}</span>
              <small>{`room left ${row.roomLeftCad === null ? "?" : cad(row.roomLeftCad)}`}</small>
            </span>
            {row.wentOver && <div class="tr-flag">{`This went over by ${cad(row.excessCad ?? 0)}`}</div>}
          </li>
        );
      })}
    </ul>
  );
}

function headline(p: Extract<RoomPayload, { status: "known" }>, est: string): { text: string; over: boolean } {
  const over = p.overLimitCad > 0 || p.roomLeftCad < 0;
  if (!over) return { text: `About ${cad(Math.max(0, p.roomLeftCad))} of TFSA room left this year${est}`, over };
  const amount = cad(p.overLimitCad > 0 ? p.overLimitCad : -p.roomLeftCad);
  const l = p.ledger;
  if (!l) return { text: `About ${amount} over your TFSA room this year${est}`, over };
  if (l.undatedExcess) {
    const total = l.rows.find((r) => r.kind === "outside_total")?.label ?? "an account";
    return { text: `About ${amount} over your TFSA room; the date can't be told because ${total} has a total, not dated deposits${est}`, over };
  }
  return { text: l.overSince ? `About ${amount} over your TFSA room since ${calendarDate(l.overSince, false)}${est}` : `About ${amount} over your TFSA room${est}`, over };
}

function Known({ p, bridge }: { p: Extract<RoomPayload, { status: "known" }>; bridge: Bridge }) {
  const note = fxNote(p.fx.contributions).trim();
  // As in the API text: the converted rows' note carries "est."; otherwise a bare "(est.)" goes on the headline. Never both.
  const est = !note && p.estimated ? " (est.)" : "";
  const { text, over } = headline(p, est);
  // Used comes from the ledger (CRA room less room left), so a withdrawal that reduced an excess shows here too.
  const usedCad = Math.round((p.craRoomCad - p.roomLeftCad) * 100) / 100;
  const used = p.craRoomCad > 0 ? Math.min(100, Math.max(0, (usedCad / p.craRoomCad) * 100)) : usedCad > 0 ? 100 : 0;
  return (
    <>
      <h2 class={`tr-head${over ? " over" : ""}`}>
        {text}
      </h2>
      {p.headlineBasis && <p class="w-caption">{p.headlineBasis}</p>}
      {Array.isArray(p.notCounted) && p.notCounted.length > 0 && <p class="w-caption">{notCountedLine(p.notCounted, over)}</p>}
      {note && <p class="w-caption">{note}</p>}
      <div class={`tr-bar${over ? " over" : ""}`} role="img" aria-label={`Used ${cad(usedCad)} of ${cad(p.craRoomCad)} CRA room this year`}>
        <span style={{ width: `${used}%` }} />
      </div>
      <div class="tr-scale w-muted">
        <span>{`Used ${cad(usedCad)} of ${cad(p.craRoomCad)} CRA room`}</span>
      </div>
      {p.ledger && <RoomChart ledger={p.ledger} />}
      {p.ledger && p.ledger.rows.length > 0 && <LedgerRows rows={p.ledger.rows} />}
      {p.activityAsOf && <p class="w-caption">{`Based on activity up to ${torontoDate(p.activityAsOf)}; deposits made since then aren't included`}</p>}
      <SeeEveryMove bridge={bridge} url={p.dashboardUrl} />
    </>
  );
}

function SeeEveryMove({ bridge, url, label = "See every move" }: { bridge: Bridge; url?: string; label?: string }) {
  if (!url) return null;
  return <button type="button" class="w-chip w-nav tr-link" onClick={() => void bridge.openLink(url)}>{label}</button>;
}

function Card({ p, bridge }: { p: RoomPayload; bridge: Bridge }) {
  return (
    <section class="w-shell" role="region" aria-label="TFSA room">
      <style>{`
        .tr-head{margin:0;font-family:var(--display);font-size:23px;font-weight:700;letter-spacing:-.02em;line-height:1.25;overflow-wrap:anywhere}
        .tr-head.over{color:var(--attn)}
        .tr-bar{height:10px;border-radius:6px;background:var(--line);overflow:hidden}
        .tr-bar span{display:block;height:100%;background:var(--accent);border-radius:6px}
        .tr-bar.over span{background:var(--attn)}
        .tr-scale{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px}
        .tr-list{margin:0;padding-left:18px;display:grid;gap:6px;font-size:13px;overflow-wrap:anywhere}
        .tr-note{background:var(--attn-bg);color:var(--attn);border-radius:10px;padding:8px 10px;font-size:12px;line-height:1.45;overflow-wrap:anywhere}
        .tr-moves{margin:4px 0 0;padding:0;list-style:none;display:grid}
        .tr-moves li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:8px 0;border-top:1px solid var(--line);font-size:13px;color:var(--ink)}
        .tr-moves li:first-child{border-top:0}
        .tr-mv-l,.tr-mv-r{display:grid;gap:1px;align-content:start;min-width:0}
        .tr-mv-r{text-align:right;max-width:15em}
        .tr-moves small{font-size:11px;color:var(--muted);line-height:1.4;overflow-wrap:anywhere}
        .tr-mv-amt{font-weight:600;overflow-wrap:anywhere}
        .tr-ledger li.over .tr-mv-kind,.tr-ledger li.over .tr-mv-amt{color:var(--attn)}
        .tr-flag{grid-column:1/-1;font-size:12px;font-weight:600;color:var(--attn)}
        .tr-link{justify-self:start}
        .tr-fhsa-label{margin:0;font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--muted)}
        .tr-fhsa{border-top:1px solid var(--line);padding-top:8px;display:grid;gap:2px}
        .tr-fhsa-head{margin:0;font-size:14px;font-weight:600;overflow-wrap:anywhere}
        .tr-fhsa-head.over{color:var(--attn)}
        .tr-rrsp-year{display:grid;gap:2px}
        .tr-sub{margin:0;font-family:var(--display);font-size:13.5px;color:var(--ink);font-weight:600}
      `}</style>
      {p.status === "known" ? <Known p={p} bridge={bridge} /> : (
        <>
          <h2 class="tr-head">I can't give a number yet:</h2>
          {p.dashboardUrl && p.missing.some(dashboardEnterable) && (
            <>
              <p class="w-caption">{p.missing.every(dashboardEnterable) ? "Enter these on the VestLens dashboard" : "You can enter some of these on the VestLens dashboard"}</p>
              <SeeEveryMove bridge={bridge} url={p.dashboardUrl} label="Open the VestLens dashboard" />
            </>
          )}
          <ul class="tr-list" aria-label="Still needed">{p.missing.map((item, i) => <Item key={i} item={item} year={p.year} />)}</ul>
        </>
      )}
      {p.newYearNote && <div class="tr-note">{p.newYearNote}</div>}
      {returningNote(p) && <div class="tr-note">{returningNote(p)}</div>}
      {/* With a number, the headline basis and "See every move" carry the inputs; the full list lives on the dashboard. */}
      {p.status !== "known" && p.basis.length > 0 && (
        <div>
          <h3 class="tr-sub">Based on</h3>
          <ul class="tr-list">{p.basis.map((line, i) => <li key={i}>{line}</li>)}</ul>
        </div>
      )}
      {p.fhsa && <FhsaLine f={p.fhsa} />}
      {p.rrsp && p.rrsp.years.length > 0 && <RrspBlock r={p.rrsp} />}
      <BrandFooter advice={false} />
    </section>
  );
}

function TfsaRoomView({ bridge, seed }: { bridge: Bridge; seed: ToolResult | null }) {
  const [page, setPage] = useState<RoomPayload | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const hasData = useRef(false);

  function hydrate(result: ToolResult): boolean {
    const content = result.structuredContent;
    if (result.isError || !isPayload(content)) {
      if (!hasData.current) setLoadFailed(true);
      return false;
    }
    hasData.current = true;
    setPage(content); setLoadFailed(false);
    return true;
  }
  useEffect(() => bridge.onToolResult((result) => { hydrate(result); }), [bridge]);
  useEffect(() => { if (seed) hydrate(seed); }, []);
  const stalled = useHydrateWatchdog(bridge, () => hasData.current);
  async function retry() {
    setRetrying(true);
    try { hydrate(await bridge.callTool("get_contribution_room", {})); } catch { if (!hasData.current) setLoadFailed(true); } finally { setRetrying(false); }
  }

  if (!page) {
    if (loadFailed || stalled) {
      return (
        <div class="w-shell">
          <Banner tone={loadFailed ? "warning" : "info"}>{loadFailed ? "TFSA room unavailable right now" : "Still loading…"}</Banner>
          <button type="button" class="w-chip w-toggle" disabled={retrying} onClick={() => void retry()}>Try again</button>
        </div>
      );
    }
    return <div class="w-shell w-muted">Loading your TFSA room…</div>;
  }
  return <Card p={page} bridge={bridge} />;
}

export function TfsaRoom({ bridge }: { bridge: Bridge }) {
  return <WidgetGuard bridge={bridge} showTool="get_contribution_room">{(seed) => <TfsaRoomView bridge={bridge} seed={seed} />}</WidgetGuard>;
}
