import { useEffect, useState } from "react";

import type { PortfolioApiClient } from "./App";
import type { FhsaAccountView, FhsaMissingItem, FhsaRoomView, LedgerRowView, RoomAccountView, RrspAccountView, RrspMissingItem, RrspRoomView, RrspYearView, TfsaRoomView } from "./apiErrors";
import { AppHeader } from "./AppHeader";
import { RoomChart } from "./RoomChart";
import { AmbiguousLine, MissingLine, type SetupStep } from "./TfsaRoomTile";
import {
  assumedNote, cad, calendarDate, fhsaHeadline, fhsaWithdrawalNote, fxNote, isOutgoing, ledgerAmount, matchedNote, notCountedLine, RRSP_CRA_FACT,
  rrspContributedLine, rrspHeadline, rrspHeadlinePlus, rrspMissingLine, torontoDate, torontoToday, withdrawalRowNote,
} from "./roomFormat";

type ManagedFigureBody = { year: number; amountCad: number; asOf: string };
const NOT_AN_AMOUNT = "Enter the amount in dollars, 0 or more, and the date as YYYY-MM-DD, not after today.";

/**
 * The room page's entry for a managed account's year-to-date contributions (review 6): SnapTrade shows no activity for a
 * managed portfolio, so this figure, optional, is the only way to count it; the dashboard takes it here through the room
 * routes, as the RRSP's "contributions not in VestLens" are taken. The answer is the recomputed room, handed back through `onSaved`.
 */
export function ManagedFigureForm<R>({ item, year, save, onSaved, action = "Add figure" }: {
  item: { label: string; accountKey: string }; year: number; save(accountKey: string, body: ManagedFigureBody): Promise<R>; onSaved(room: R): void; action?: string;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [asOf, setAsOf] = useState(torontoToday());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return <> <button type="button" className="link-button" onClick={() => setOpen(true)}>{action}</button></>;
  const submit = async () => {
    const amountCad = Number(amount.replace(/[$,\s]/g, ""));
    if (amount.trim() === "" || !Number.isFinite(amountCad) || amountCad < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(asOf) || asOf > torontoToday()) { setError(NOT_AN_AMOUNT); return; }
    setBusy(true); setError(null);
    try {
      onSaved(await save(item.accountKey, { year, amountCad, asOf }));
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "That change could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  const id = `managed-${item.accountKey.slice(0, 8)}`;
  return (
    <form className="room-setup-outside" aria-label={`Contributions to ${item.label} this year`} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label htmlFor={`${id}-amount`}>{`Contributed to ${item.label} this year (CAD)`}</label>
      <input id={`${id}-amount`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
      <label htmlFor={`${id}-asof`}>As of (YYYY-MM-DD)</label>
      <input id={`${id}-asof`} value={asOf} onChange={(e) => setAsOf(e.target.value)} disabled={busy} />
      {error && <p className="data-controls-copy" role="alert">{error}</p>}
      <div className="room-setup-actions">
        <button type="submit" className="primary-button" disabled={busy}>Save</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
      </div>
    </form>
  );
}

/** A number that leaves out managed accounts: the line saying so, and beside it an optional figure for each (owner ruling 2026-10-31). */
function NotCountedNote<R>({ items, over, year, save, onSaved }: {
  items: Array<{ label: string; accountKey: string }>; over: boolean; year: number; save?: (accountKey: string, body: ManagedFigureBody) => Promise<R>; onSaved(room: R): void;
}) {
  return (
    <div data-testid="not-counted">
      <p className="data-controls-copy">{notCountedLine(items, over)}</p>
      {save && items.map((item) => (
        <ManagedFigureForm key={item.accountKey} item={item} year={year} save={save} onSaved={onSaved} action={`Add figure for ${item.label}`} />
      ))}
    </div>
  );
}

export const CRA_FACT = "CRA charges 1% a month on the highest amount over in each month, until it's withdrawn or new room arrives. Check your figures in CRA My Account.";
/** The FHSA penalty fact, in the TFSA style. */
export const FHSA_CRA_FACT = "CRA charges 1% a month on the highest amount over in each month. Check your figures in CRA My Account.";

/** Which registered account's room a ledger shows. */
export type RoomProgram = "tfsa" | "fhsa" | "rrsp";
const PROGRAM_NAME: Record<RoomProgram, string> = { tfsa: "TFSA", fhsa: "FHSA", rrsp: "RRSP" };

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; room: TfsaRoomView };

function headline(room: Extract<TfsaRoomView, { status: "known" }>): { text: string; over: boolean } {
  const { overSince, undatedExcess, rows } = room.ledger;
  if (room.overLimitCad > 0) {
    const amount = cad(room.overLimitCad);
    if (undatedExcess) {
      const total = rows.find((r) => r.kind === "outside_total")?.label ?? "an account";
      return { text: `About ${amount} over your TFSA room; the date can't be told because ${total} has a total, not dated deposits`, over: true };
    }
    return { text: overSince ? `About ${amount} over your TFSA room since ${calendarDate(overSince, false)}` : `About ${amount} over your TFSA room`, over: true };
  }
  return { text: `About ${cad(Math.max(0, room.roomLeftCad))} of TFSA room left this year`, over: false };
}

function stepFor(row: LedgerRowView, program: RoomProgram): SetupStep | null {
  // The RRSP's limit row and its "not in VestLens" row open the year's figures (step 1); transfers take step 4, as below.
  if (row.kind === "cra_room" || (program === "rrsp" && row.kind === "outside_total")) return 1;
  // Step 4 takes exactly the rows the server accepts an answer for: unclear ones, matched transfers and answered rows.
  if (row.kind === "ambiguous" || (row.activityKey !== undefined && (row.inferred === true || row.answered === true || row.assumed === true))) return 4;
  // The FHSA and RRSP have no outside accounts or year-to-date totals to edit on the dashboard.
  if (program !== "tfsa") return null;
  if (row.kind === "outside_total") return 3;
  if ((row.kind === "contribution" || row.kind === "withdrawal") && row.activityKey === undefined) return 3;
  return null;
}

/** An FHSA or RRSP move with its own engine note in place of the kind text (FHSA: a transfer out to an RRSP; RRSP: one in from an FHSA). */
const noteAsKind = (row: LedgerRowView, program: RoomProgram) => program !== "tfsa" && row.kind === "none" && row.note !== undefined;

/**
 * A ledger row's move, with its notes on their own small line beneath (the widgets' room rows): the kind, then what it
 * did to the room, any matched or assumed note and the engine's note, as one sentence.
 */
function WhatHappened({ row, program }: { row: LedgerRowView; program: RoomProgram }) {
  const { kind, own } = kindParts(row, program);
  const notes = [own, matchedNote(row), assumedNote(row), noteAsKind(row, program) ? null : row.note ?? null].filter((n): n is string => !!n);
  const text = notes.join("; ");
  return (
    <>
      <span className="ledger-kind">{kind}</span>
      {text && <small className="ledger-note">{` ${text.charAt(0).toUpperCase()}${text.slice(1)}`}</small>}
    </>
  );
}

/** The move in a few words, and what it did to the room (null when the kind says it all). */
function kindParts(row: LedgerRowView, program: RoomProgram): { kind: string; own: string | null } {
  if (program === "fhsa") {
    // FHSA withdrawals never give room back; a move between FHSAs has no effect.
    if (row.kind === "cra_room") return { kind: "FHSA participation room", own: "from CRA (you entered)" };
    if (row.kind === "withdrawal") return { kind: `${row.label} withdrawal`, own: fhsaWithdrawalNote(row) };
    if (noteAsKind(row, program)) return { kind: `${row.label} transfer`, own: row.note ?? null };
    // Money out with no effect: moved to another FHSA or the user's RRSP (one answer, none, covers both).
    if (row.kind === "none") return { kind: `${row.label} transfer`, own: `${isOutgoing(row) ? "moved to another FHSA or your RRSP" : "moved from another FHSA"}, no effect on room` };
  }
  if (program === "rrsp") {
    // The limit and "not in VestLens" rows carry their own labels; withdrawals never change deduction room.
    if (row.kind === "cra_room" || row.kind === "outside_total") return { kind: row.label, own: null };
    if (row.kind === "withdrawal") return { kind: `${row.label} withdrawal (doesn't change deduction room)`, own: null };
    if (noteAsKind(row, program)) return { kind: `${row.label} transfer`, own: row.note ?? null };
    if (row.kind === "none") return { kind: `${row.label} transfer`, own: `${isOutgoing(row) ? "moved to another RRSP or your FHSA" : "moved from another RRSP"}, no effect on deduction room` };
  }
  switch (row.kind) {
    case "cra_room": return { kind: "Room on 1 January", own: "from CRA My Account (you entered)" };
    case "contribution": return { kind: `${row.label} contribution`, own: null };
    case "withdrawal": return { kind: `${row.label} withdrawal`, own: withdrawalRowNote(row) || null };
    case "none": return { kind: `${row.label} transfer`, own: `moved ${isOutgoing(row) ? "to" : "from"} another TFSA, no effect on room` };
    case "ambiguous": return { kind: `${row.label} transfer`, own: "needs checking: was it new money?" };
    case "outside_total": return { kind: `${row.label} total`, own: "a total, not dated deposits" };
  }
}

function LedgerRowLine({ row, onSetup, program }: { row: LedgerRowView; onSetup?: (step: SetupStep, activityKey?: string) => void; program: RoomProgram }) {
  const step = onSetup ? stepFor(row, program) : null;
  const cls = ["tfsa-ledger-row", row.wentOver ? "tfsa-ledger-over" : "", row.kind === "ambiguous" ? "tfsa-ledger-open" : ""].filter(Boolean).join(" ");
  return (
    <tr className={cls} data-testid="ledger-row">
      <td>{row.date ? calendarDate(row.date) : "unknown date"}</td>
      <td>
        <WhatHappened row={row} program={program} />
        {step !== null && <> <button type="button" className="link-button" onClick={() => (step === 4 && row.activityKey ? onSetup?.(step, row.activityKey) : onSetup?.(step))}>{row.kind === "ambiguous" ? "Answer" : "Edit"}</button></>}
        {row.wentOver && <div className="tfsa-ledger-flag">{`This went over by ${cad(row.excessCad ?? 0)}`}</div>}
      </td>
      <td>{row.kind === "cra_room" ? (row.amountCad === null ? "?" : cad(row.amountCad)) : row.kind === "none" ? `${ledgerAmount(row)} (no effect)` : ledgerAmount(row)}</td>
      <td>{row.roomLeftCad === null ? "?" : cad(row.roomLeftCad)}</td>
    </tr>
  );
}

/** The room ledger, shared by the room page and the setup preview (which passes no onSetup, so no edit links), TFSA or FHSA. */
export function LedgerTable({ rows, onSetup, program = "tfsa" }: { rows: LedgerRowView[]; onSetup?: (step: SetupStep, activityKey?: string) => void; program?: RoomProgram }) {
  return (
    <table className="tfsa-ledger">
      <thead><tr><th scope="col">Date</th><th scope="col">What happened</th><th scope="col">Amount</th><th scope="col">Room left</th></tr></thead>
      <tbody>{rows.map((row, i) => <LedgerRowLine key={i} row={row} onSetup={onSetup} program={program} />)}</tbody>
    </table>
  );
}

/** Which connected accounts count (the broker's TFSA label, adjusted in step 2), and the links to steps 2 and 3. */
function Accounts({ accounts, outside, onSetup }: { accounts: RoomAccountView[]; outside: { label: string }[]; onSetup(step: SetupStep): void }) {
  return (
    <section aria-labelledby="room-accounts-heading" className="tfsa-accounts">
      <h2 id="room-accounts-heading">Your TFSAs</h2>
      {accounts.length > 0 && (
        <ul className="tfsa-list">
          {accounts.map((a) => <li key={a.accountKey}>{`${a.label}: ${a.inSet ? "counted as a TFSA" : a.neutral ? "unknown type, not counted" : "not counted"}`}</li>)}
        </ul>
      )}
      <button type="button" className="link-button" onClick={() => onSetup(2)}>Add or remove accounts</button>
      {outside.length > 0 && (
        <ul className="tfsa-list" aria-label="TFSAs at other institutions">{outside.map((o) => <li key={o.label}>{`${o.label}: at another institution`}</li>)}</ul>
      )}
      <button type="button" className="link-button" onClick={() => onSetup(3)}>TFSAs at other institutions</button>
    </section>
  );
}

/** onSetup opens one step (edit links, missing items); onStartSetup opens the setup, which is step 1 alone. */
/** onSetup's activityKey names a transfer (unclear, matched or answered), so step 4 opens on that one row. */
/**
 * The contribution room page: TFSA, FHSA and RRSP tabs, each shown only when that account exists (GET /api/room/fhsa
 * not "none", GET /api/room/rrsp "shown"; the TFSA is always there), under a strip of every program's headline.
 * onFhsaSetup opens the FHSA's setup: step 1, its one question (the participation room), or step 4 on one transfer
 * (the activityKey its edit link names). onRrspSetup opens one RRSP tax year's figures (step 1) or step 4 on one transfer.
 */
export function RoomPage({ api, onBack, onSetup, onStartSetup, onFhsaSetup, onRrspSetup, initialTab = "tfsa" }: {
  api: PortfolioApiClient; onBack(): void; onSetup(step: 1 | 2 | 3 | 4, activityKey?: string): void; onStartSetup?: () => void;
  onFhsaSetup?: (step: 1 | 4, activityKey?: string) => void; onRrspSetup?: RrspSetupOpener; initialTab?: RoomProgram;
}) {
  const [state, setState] = useState<Load>({ status: "loading" });
  const [fhsa, setFhsa] = useState<Exclude<FhsaRoomView, { status: "none" }> | null>(null);
  const [rrsp, setRrsp] = useState<RrspShown | null>(null);
  const [tab, setTab] = useState<RoomProgram>(initialTab);
  const { getTfsaRoom, getFhsaRoom, getRrspRoom } = api;
  useEffect(() => {
    if (!getTfsaRoom) { setState({ status: "error" }); return; }
    let active = true;
    getTfsaRoom().then(
      (room) => { if (active) setState({ status: "ready", room }); },
      () => { if (active) setState({ status: "error" }); },
    );
    return () => { active = false; };
  }, [getTfsaRoom]);
  useEffect(() => {
    if (!getFhsaRoom) return;
    let active = true;
    // No FHSA, or a failed read: the page stays the TFSA room alone.
    getFhsaRoom().then((room) => { if (active) setFhsa(room.status === "none" ? null : room); }, () => { if (active) setFhsa(null); });
    return () => { active = false; };
  }, [getFhsaRoom]);
  useEffect(() => {
    if (!getRrspRoom) return;
    let active = true;
    // No RRSP, or a failed read: the page goes on without its RRSP tab.
    getRrspRoom().then((room) => { if (active) setRrsp(room.status === "shown" ? room : null); }, () => { if (active) setRrsp(null); });
    return () => { active = false; };
  }, [getRrspRoom]);
  const programs: RoomProgram[] = ["tfsa", ...(fhsa ? ["fhsa" as const] : []), ...(rrsp ? ["rrsp" as const] : [])];
  const shown: RoomProgram = programs.includes(tab) ? tab : "tfsa";
  const tabbed = programs.length > 1;

  return (
    <div className="app-shell">
      <AppHeader>
        <button type="button" className="topbar-link" onClick={onBack}>Back</button>
      </AppHeader>
      <main className="dashboard account-page room-page">
        <section className="dashboard-heading"><div><h1>Contribution room</h1></div></section>
        {tabbed && (
          <RoomGlance shown={shown} onSelect={setTab} entries={programs.map((p) => ({
            program: p, lines: p === "fhsa" && fhsa ? [fhsaHeadline(fhsa)] : p === "rrsp" && rrsp ? rrsp.years.map(rrspGlance) : [tfsaGlance(state)],
          }))} />
        )}
        {tabbed && (
          <div className="room-tabs" role="tablist" aria-label="Registered account">
            {programs.map((p) => (
              <button key={p} type="button" role="tab" id={`room-tab-${p}`} aria-controls="room-tabpanel" aria-selected={shown === p}
                className={`room-tab${shown === p ? " active" : ""}`} onClick={() => setTab(p)}>{PROGRAM_NAME[p]}</button>
            ))}
          </div>
        )}
        <div id="room-tabpanel" {...(tabbed ? { role: "tabpanel", "aria-labelledby": `room-tab-${shown}` } : {})}>
          {shown === "rrsp" && rrsp ? <RrspBody room={rrsp} onSetup={onRrspSetup} />
            : shown === "fhsa" && fhsa ? <FhsaBody room={fhsa} onSetup={onFhsaSetup} api={api} onRoom={(room) => setFhsa(room.status === "none" ? null : room)} /> : (
            <>
              {state.status === "loading" && <p className="data-controls-copy" role="status">Loading…</p>}
              {state.status === "error" && <p className="data-controls-copy">TFSA room is unavailable right now.</p>}
              {state.status === "ready" && <RoomBody room={state.room} onSetup={onSetup} onStartSetup={onStartSetup} api={api} onRoom={(room) => setState({ status: "ready", room })} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

/** The TFSA's line in the glance strip: the TFSA tab's headline, or what stands in for it. */
function tfsaGlance(state: Load): string {
  if (state.status === "loading") return "Loading…";
  if (state.status === "error") return "TFSA room is unavailable right now.";
  return state.room.status === "known" ? headline(state.room).text : "I can't give a number yet";
}

/** An RRSP year's line in the glance strip: its headline, marked est. when converted amounts are in it. */
const rrspGlance = (year: RrspYearView): string => `${rrspHeadline(year)}${year.estimated ? " (est.)" : ""}`;

/** Every program's headline in one strip above the tabs; each entry is a button that selects its tab. */
function RoomGlance({ entries, shown, onSelect }: { entries: Array<{ program: RoomProgram; lines: string[] }>; shown: RoomProgram; onSelect(p: RoomProgram): void }) {
  return (
    <section className="room-glance" aria-label="Contribution room at a glance">
      {entries.map(({ program, lines }) => (
        <button key={program} type="button" className={`room-glance-entry${shown === program ? " active" : ""}`} aria-current={shown === program ? "true" : undefined}
          onClick={() => onSelect(program)}>
          <span className="room-glance-name">{PROGRAM_NAME[program]}</span>
          {lines.map((line, i) => <span key={i} className="room-glance-line">{line}</span>)}
        </button>
      ))}
    </section>
  );
}

type RrspShown = Extract<RrspRoomView, { status: "shown" }>;
/** Opens one RRSP tax year's setup: its figures (step 1), or step 4 on one transfer (the first unclear one without a key). */
export type RrspSetupOpener = (year: number, step?: 1 | 4, activityKey?: string) => void;
const UNPUBLISHED = "CRA's deadline (not yet published)";

/** The RRSP tab: one block per open tax year, oldest first, then the freshness line and the RRSPs that count. */
function RrspBody({ room, onSetup }: { room: RrspShown; onSetup?: RrspSetupOpener }) {
  return (
    <>
      {room.years.map((year) => <RrspYearBlock key={year.window.taxYear} year={year} onSetup={onSetup} />)}
      {room.activityAsOf && <p className="data-controls-copy">{`Based on activity up to ${torontoDate(room.activityAsOf)}; deposits made since then aren't included`}</p>}
      <RrspAccounts accounts={room.accounts} />
    </>
  );
}

const RRSP_ACTION: Partial<Record<RrspMissingItem["kind"], string>> = {
  deduction_limit: "Add your deduction limit", unused_contributions: "Add unused contributions", elsewhere: "Add contributions not in VestLens",
  managed_rrsp: "Add contributions not in VestLens", ambiguous: "Set up",
};

/**
 * One RRSP missing item in the assistant's words; the year's figures (the limit, unused contributions, contributions not
 * in VestLens, a managed RRSP's figure) open the year's figures, an unclear transfer step 4.
 */
function RrspMissingLine({ item, year, onSetup }: { item: RrspMissingItem; year: RrspYearView; onSetup?: RrspSetupOpener }) {
  const action = RRSP_ACTION[item.kind] ?? null;
  const step = item.kind === "ambiguous" ? 4 : 1;
  return (
    <li>
      {rrspMissingLine(item, year)}
      {action && onSetup && <> <button type="button" className="link-button" onClick={() => onSetup(year.window.taxYear, step)}>{action}</button></>}
    </li>
  );
}

/**
 * One tax year: the headline, CRA's window, what's missing, the chart (deduction room left never goes below 0, so the
 * amount over is drawn below zero, as on the FHSA tab) and ledger, the basis, and CRA's fact when over the limit.
 */
function RrspYearBlock({ year, onSetup }: { year: RrspYearView; onSetup?: RrspSetupOpener }) {
  const Y = year.window.taxYear;
  const over = (year.overLimitCad ?? 0) > 0;
  // The chat's and widget's fallback: the conversion note, or "(est.)" when the year is estimated without one.
  const note = fxNote(year.fx.contributions).trim() || (year.estimated ? "(est.)" : "");
  const contributed = rrspContributedLine(year);
  // The engine's own window line (raw dates) and CRA fact are shown on their own, not again in the basis.
  const rawWindow = `Contributions for ${Y}: ${year.window.from} to ${year.window.to ?? UNPUBLISHED}`;
  const basis = year.basis.filter((line) => line !== rawWindow && line !== RRSP_CRA_FACT);
  const charted = year.ledger.rows[0]?.roomLeftCad !== null && year.ledger.rows[0]?.roomLeftCad !== undefined;
  const open = onSetup ? () => onSetup(Y) : undefined;
  return (
    <section className="section-block rrsp-year" aria-label={`RRSP ${Y} tax year`}>
      <h2 className={`tfsa-headline${over ? " over" : ""}`}>{`${rrspHeadline(year)}${rrspHeadlinePlus(year)}`}</h2>
      {contributed && <p className="data-controls-copy">{contributed}</p>}
      {note && <p className="data-controls-copy">{note}</p>}
      <p className="data-controls-copy">{`Contributions for ${Y}: ${calendarDate(year.window.from)} to ${year.window.to ? calendarDate(year.window.to) : UNPUBLISHED}`}</p>
      {year.missing.length > 0 && (
        <ul className="tfsa-list" aria-label="Still needed">
          {year.missing.map((item, i) => <RrspMissingLine key={i} item={item} year={year} onSetup={onSetup} />)}
        </ul>
      )}
      {open && <button type="button" className="secondary-button rrsp-edit" onClick={open}>{`Edit figures for ${Y}`}</button>}
      {charted && (
        <>
          <h3>{`Deduction room left over the ${Y} tax year`}</h3>
          <RoomChart rows={fhsaChartRows(year.ledger.rows)} overSince={year.ledger.overSince}
            span={{ from: year.window.from, to: year.window.to ?? torontoToday() }} name={`Deduction room left over the ${Y} tax year`} />
        </>
      )}
      <h3>{`Every move in the ${Y} tax year`}</h3>
      <LedgerTable rows={year.ledger.rows} program="rrsp" onSetup={onSetup ? (step, activityKey) => onSetup(Y, step === 4 ? 4 : 1, activityKey) : undefined} />
      {basis.length > 0 && <ul className="tfsa-basis" aria-label="Based on">{basis.map((line, i) => <li key={i}>{line}</li>)}</ul>}
      {over && <p className="tfsa-note">{RRSP_CRA_FACT}</p>}
    </section>
  );
}

/** The connected RRSPs: the broker's RRSP label decides; a managed portfolio's contributions can't be seen. */
function RrspAccounts({ accounts }: { accounts: RrspAccountView[] }) {
  return (
    <section aria-labelledby="room-rrsp-accounts-heading" className="tfsa-accounts">
      <h2 id="room-rrsp-accounts-heading">Your RRSPs</h2>
      <ul className="tfsa-list">{accounts.map((a) => (
        <li key={a.accountKey}>{`${a.label}${a.closed ? " (closed)" : ""}: ${a.managed ? "a managed portfolio; its contributions aren't visible through SnapTrade" : "counted as an RRSP"}`}</li>
      ))}</ul>
    </section>
  );
}

/** One FHSA missing item, in the same words as the assistant's line; the participation room has a setup step, a managed FHSA's figure its own form. */
function FhsaMissingLine({ item, year, onSetup, api, onRoom }: {
  item: FhsaMissingItem; year: number; onSetup?: (step: 1 | 4) => void; api: PortfolioApiClient; onRoom(room: FhsaRoomView): void;
}) {
  const save = api.putFhsaManagedFigure;
  switch (item.kind) {
    case "fhsa_room": return (
      <li>
        {`Your FHSA participation room for ${year}, from CRA My Account or your notice of assessment`}
        {onSetup && <> <button type="button" className="link-button" onClick={() => onSetup(1)}>Set up</button></>}
      </li>
    );
    case "coverage": case "stale_activity": return <MissingLine item={item} year={year} />;
    case "managed_account": return (
      <MissingLine item={item} year={year} renderManaged={save ? (m) => <ManagedFigureForm item={m} year={year} save={(key, body) => save(key, body)} onSaved={onRoom} /> : undefined} />
    );
    case "ambiguous": return (
      <li>
        {`${item.count} ${item.count === 1 ? "transfer needs" : "transfers need"} checking`}
        {item.rows.length > 0 && (
          <ul>{item.rows.map((r) => <AmbiguousLine key={r.activityKey} row={r} />)}</ul>
        )}
        {onSetup && <button type="button" className="link-button" onClick={() => onSetup(4)}>Set up</button>}
      </li>
    );
  }
}

/**
 * The chart's line for an FHSA ledger. FHSA room left never goes below 0 (CRA's formula keeps the excess apart), so the
 * line shows room left, or the amount over as a negative value while over, the TFSA chart's convention.
 */
export function fhsaChartRows(rows: LedgerRowView[]): LedgerRowView[] {
  return rows.map((r) => (r.roomLeftCad !== null && (r.excessCad ?? 0) > 0 ? { ...r, roomLeftCad: -r.excessCad! } : r));
}

/** The FHSA tab: the same headline, chart and ledger as the TFSA room, with the FHSA rule's words. */
function FhsaBody({ room, onSetup, api, onRoom }: {
  room: Exclude<FhsaRoomView, { status: "none" }>; onSetup?: (step: 1 | 4, activityKey?: string) => void; api: PortfolioApiClient; onRoom(room: FhsaRoomView): void;
}) {
  const known = room.status === "known" ? room : null;
  const note = known ? fxNote(known.fx.contributions).trim() : "";
  const over = known !== null && known.overLimitCad > 0;
  return (
    <>
      <section className="section-block" aria-labelledby="room-headline">
        <h2 id="room-headline" className={`tfsa-headline${over ? " over" : ""}`}>{fhsaHeadline(room)}</h2>
        {known && (
          <>
            <p className="data-controls-copy">{known.headlineBasis}</p>
            {known.notCounted?.length ? <NotCountedNote items={known.notCounted} over={over} year={known.year} save={api.putFhsaManagedFigure} onSaved={onRoom} /> : null}
            {note && <p className="data-controls-copy">{note}</p>}
            {known.newYearNote && <p className="data-controls-copy">{known.newYearNote}</p>}
            {known.activityAsOf && <p className="data-controls-copy">{`Based on activity up to ${torontoDate(known.activityAsOf)}; deposits made since then aren't included`}</p>}
          </>
        )}
        {room.status === "missing" && (
          <ul className="tfsa-list" aria-label="Still needed">
            {room.missing.map((item, i) => <FhsaMissingLine key={i} item={item} year={room.year} onSetup={onSetup} api={api} onRoom={onRoom} />)}
          </ul>
        )}
      </section>

      <section className="section-block" aria-labelledby="room-chart-heading">
        <h2 id="room-chart-heading">Room left over the year</h2>
        <RoomChart rows={fhsaChartRows(room.ledger.rows)} overSince={room.ledger.overSince} />
      </section>

      <section className="section-block" aria-labelledby="room-ledger-heading">
        <h2 id="room-ledger-heading">Every move this year</h2>
        <LedgerTable rows={room.ledger.rows} program="fhsa" onSetup={onSetup ? (step, activityKey) => onSetup(step === 4 ? 4 : 1, activityKey) : undefined} />
      </section>

      <FhsaAccounts accounts={room.accounts} />
      {room.basis.length > 0 && (
        <ul className="tfsa-basis" aria-label="Based on">{room.basis.map((line, i) => <li key={i}>{line}</li>)}</ul>
      )}
      <p className="tfsa-note">{FHSA_CRA_FACT}</p>
    </>
  );
}

/** The connected FHSAs: the broker's FHSA label decides, so there is nothing to add or remove. */
function FhsaAccounts({ accounts }: { accounts: FhsaAccountView[] }) {
  return (
    <section aria-labelledby="room-fhsa-accounts-heading" className="tfsa-accounts">
      <h2 id="room-fhsa-accounts-heading">Your FHSAs</h2>
      <ul className="tfsa-list">{accounts.map((a) => <li key={a.accountKey}>{`${a.label}: counted as an FHSA`}</li>)}</ul>
    </section>
  );
}

function RoomBody({ room, onSetup, onStartSetup, api, onRoom }: {
  room: TfsaRoomView; onSetup(step: SetupStep, activityKey?: string): void; onStartSetup?: () => void; api: PortfolioApiClient; onRoom(room: TfsaRoomView): void;
}) {
  const known = room.status === "known" ? room : null;
  const head = known ? headline(known) : null;
  const note = known ? fxNote(known.fx.contributions).trim() : "";
  // A managed TFSA's figure is entered here (review 6); without the client method the line says where else to give it.
  const save = api.putRoomManagedFigure;
  const renderManaged = save ? (m: { label: string; accountKey: string }) => <ManagedFigureForm item={m} year={room.year} save={(key, body) => save(key, body)} onSaved={onRoom} /> : undefined;
  return (
    <>
      <section className="section-block" aria-labelledby="room-headline">
        {known && head ? (
          <>
            <h2 id="room-headline" className={`tfsa-headline${head.over ? " over" : ""}`}>{head.text}</h2>
            {known.headlineBasis && <p className="data-controls-copy">{known.headlineBasis}</p>}
            {known.notCounted?.length ? <NotCountedNote items={known.notCounted} over={head.over} year={known.year} save={save} onSaved={onRoom} /> : null}
            {note && <p className="data-controls-copy">{note}</p>}
            {known.newYearNote && <p className="data-controls-copy">{known.newYearNote}</p>}
            {known.activityAsOf && <p className="data-controls-copy">{`Based on activity up to ${torontoDate(known.activityAsOf)}; deposits made since then aren't included`}</p>}
          </>
        ) : room.status === "missing" ? (
          <>
            <h2 id="room-headline" className="tfsa-headline">I can't give a number yet</h2>
            <ul className="tfsa-list" aria-label="Still needed">
              {room.missing.map((item, i) => <MissingLine key={i} item={item} year={room.year} onSetup={onSetup} renderManaged={renderManaged} />)}
            </ul>
            {onStartSetup && <button type="button" className="secondary-button" onClick={onStartSetup}>Start setup</button>}
          </>
        ) : null}
      </section>

      <section className="section-block" aria-labelledby="room-chart-heading">
        <h2 id="room-chart-heading">Room left over the year</h2>
        <RoomChart rows={room.ledger.rows} overSince={room.ledger.overSince} />
      </section>

      <section className="section-block" aria-labelledby="room-ledger-heading">
        <h2 id="room-ledger-heading">Every move this year</h2>
        <LedgerTable rows={room.ledger.rows} onSetup={onSetup} />
      </section>

      <Accounts accounts={room.accounts} outside={room.accountSet?.outside ?? room.previousAccountSet?.outside ?? []} onSetup={onSetup} />
      <p className="tfsa-note">{CRA_FACT}</p>
    </>
  );
}
