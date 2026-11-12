import { useEffect, useRef, useState, type Ref } from "react";

import type { PortfolioApiClient } from "./App";
import type { RrspRoomView, RrspYearView } from "./apiErrors";
import { AppHeader } from "./AppHeader";
import { RoomChart } from "./RoomChart";
import { fhsaChartRows, LedgerTable } from "./RoomPage";
import { answeredRow, TransferStep, unclearRow, type AnswerableRoom } from "./RoomSetup";
import { torontoToday } from "./roomFormat";

/**
 * One RRSP tax year's figures, for the year of the block it was opened from: the deduction limit and any unused
 * contributions as CRA shows them (CRA My Account or the notice of assessment), and contributions VestLens can't see.
 * The limit alone shows the contributions; room left needs all three (0 counts). A blank field leaves what's saved.
 * The limit and unused contributions save together (one route), the "not in VestLens" figure on its own (0 is a
 * figure: it clears the elsewhere item, or a managed RRSP's). Step 4 (from an edit link
 * or an unclear-transfer item) answers one of the year's transfers with the TFSA's own step, worded for the RRSP.
 * The preview is the server's.
 */

const SAVE_FAILED = "That change could not be saved.";
const UNAVAILABLE = "RRSP setup is unavailable right now.";
const NOT_AMOUNT = "Enter each figure as a dollar amount, 0 or more.";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; year: RrspYearView };
type Fields = { limit: string; unused: string; elsewhere: string };

const text = (n: number | null) => (n === null ? "" : String(n));
const fieldsOf = (y: RrspYearView): Fields => ({ limit: text(y.limitCad), unused: text(y.unusedCad), elsewhere: text(y.elsewhereCad) });
/** A field as a figure: null when blank, NaN when not a dollar amount of 0 or more. */
const amountOf = (value: string) => {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

export function RrspSetup({ api, year: Y, onDone, step = 1, activityKey }: { api: PortfolioApiClient; year: number; onDone(): void; step?: 1 | 4; activityKey?: string }) {
  const [state, setState] = useState<Load>({ status: "loading" });
  const [fields, setFields] = useState<Fields>({ limit: "", unused: "", elsewhere: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const saved = useRef<Fields>(fields);

  const { getRrspRoom } = api;
  useEffect(() => {
    if (!getRrspRoom) { setState({ status: "error" }); return; }
    let active = true;
    getRrspRoom().then(
      (room) => {
        if (!active) return;
        const year = room.status === "shown" ? room.years.find((y) => y.window.taxYear === Y) : undefined;
        if (!year) { setState({ status: "error" }); return; }
        saved.current = fieldsOf(year);
        setFields(saved.current);
        setState({ status: "ready", year });
      },
      () => { if (active) setState({ status: "error" }); },
    );
    return () => { active = false; };
  }, [getRrspRoom, Y]);

  const ready = state.status === "ready";
  const transfers = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ready) return;
    if (step === 1) first.current?.focus();
    else transfers.current?.querySelector<HTMLElement>("button")?.focus();
  }, [ready, step]);

  /** Runs one transfer write; the response replaces the preview, then the page comes back. */
  const answer = async (run: () => Promise<RrspRoomView> | undefined) => {
    setBusy(true);
    setError(null);
    try {
      const pending = run();
      if (!pending) throw new Error("unavailable");
      const next = await pending;
      const year = next.status === "shown" ? next.years.find((y) => y.window.taxYear === Y) : undefined;
      if (year) setState({ status: "ready", year });
      onDone();
    } catch {
      setError(SAVE_FAILED);
    } finally {
      setBusy(false);
    }
  };

  /** The writes, in order; the last response replaces the preview, then the page comes back. */
  const save = async () => {
    const limit = amountOf(fields.limit);
    const unused = amountOf(fields.unused);
    const elsewhere = amountOf(fields.elsewhere);
    if ([limit, unused, elsewhere].some((n) => Number.isNaN(n))) { setError(NOT_AMOUNT); return; }
    if (unused !== null && limit === null) { setError("Enter the deduction limit with the unused contributions; CRA shows them together."); return; }
    const was = saved.current;
    const writes: Array<() => Promise<RrspRoomView> | undefined> = [];
    if (limit !== null && (fields.limit !== was.limit || fields.unused !== was.unused)) {
      writes.push(() => api.putRrspLimit?.({ year: Y, amountCad: limit, ...(unused === null ? {} : { unusedCad: unused }) }));
    }
    if (elsewhere !== null && fields.elsewhere !== was.elsewhere) writes.push(() => api.putRrspElsewhere?.({ year: Y, amountCad: elsewhere }));
    setBusy(true);
    setError(null);
    try {
      let next: RrspRoomView | undefined;
      for (const run of writes) {
        const pending = run();
        if (!pending) throw new Error("unavailable");
        next = await pending;
      }
      const year = next?.status === "shown" ? next.years.find((y) => y.window.taxYear === Y) : undefined;
      if (year) setState({ status: "ready", year });
      onDone();
    } catch {
      setError(SAVE_FAILED);
    } finally {
      setBusy(false);
    }
  };

  const year = state.status === "ready" ? state.year : null;
  // Step 4 is one transfer: the one its link names (answered, matched or assumed), else the first unclear one.
  const room: AnswerableRoom | null = year && { status: "missing", ledger: year.ledger, missing: year.missing };
  const answered = room && step === 4 ? answeredRow(room, activityKey, "RRSP") : undefined;
  const current = room && step === 4 ? answered ?? unclearRow(room, activityKey) : undefined;
  // The hint sits beside the label, not in it, so the field's name is the label alone.
  const field = (key: keyof Fields, label: string, hint: string, ref?: Ref<HTMLInputElement>) => (
    <div>
      <label className="room-setup-field">
        <span>{label}</span>
        <input ref={ref} type="number" inputMode="decimal" min={0} step="0.01" value={fields[key]} aria-describedby={`rrsp-${key}-hint`}
          onChange={(e) => setFields((f) => ({ ...f, [key]: e.target.value }))} />
      </label>
      <p id={`rrsp-${key}-hint`} className="data-controls-copy rrsp-hint">{hint}</p>
    </div>
  );

  return (
    <div className="app-shell">
      <AppHeader>
        <button type="button" className="topbar-link" onClick={onDone}>Close</button>
      </AppHeader>
      <main className="dashboard account-page room-page">
        <section className="dashboard-heading"><div><h1>RRSP setup</h1></div></section>
        {state.status === "loading" && <p className="data-controls-copy" role="status">Loading…</p>}
        {state.status === "error" && <p className="data-controls-copy">{UNAVAILABLE}</p>}
        {year && (
          <div className="room-setup">
            <section className="section-block room-setup-question" aria-labelledby="rrsp-setup-step">
              <h2 id="rrsp-setup-step">{step === 4 ? `RRSP transfer, ${Y} tax year` : `RRSP figures for ${Y}`}</h2>
              {step === 4 && (
                <div ref={transfers} className="room-setup-controls">
                  {current
                    ? <TransferStep key={current.activityKey} account="RRSP" row={current} answered={current === answered}
                      note={answered?.note} undoLabel={answered?.undo} busy={busy} onLater={onDone}
                      onAnswer={(effect) => void answer(() => api.putRrspRoomActivity?.(current.activityKey, { effect }))}
                      onUndo={() => void answer(() => api.deleteRrspRoomActivity?.(current.activityKey))} />
                    : <>
                      <p>No transfers need checking.</p>
                      <button type="button" className="primary-button" onClick={onDone}>Continue</button>
                    </>}
                </div>
              )}
              {step === 1 && <form noValidate className="room-setup-controls" onSubmit={(e) => { e.preventDefault(); void save(); }}>
                <p>{`Enter the figures as CRA shows them, not ones you've worked out. The limit alone shows your contributions; room left needs all three, and 0 counts. A blank field keeps what's saved.`}</p>
                {field("limit", `RRSP deduction limit for ${Y}`, "Needed for room left. From CRA My Account or your notice of assessment.", first)}
                {field("unused", "Unused RRSP contributions", "Needed for room left. Carried forward, beside the limit in CRA My Account or your notice of assessment. 0 counts.")}
                {field("elsewhere", `Contributions not in VestLens for the ${Y} tax year`,
                  "Needed for room left. Contributions to RRSPs VestLens can't see, such as a group RRSP at work, a managed portfolio or a spousal RRSP you contributed to for your spouse, from your RRSP contribution receipts. 0 counts.")}
                <div className="room-setup-actions">
                  <button type="submit" className="primary-button" disabled={busy}>Save</button>
                  <button type="button" className="secondary-button" disabled={busy} onClick={onDone}>Later</button>
                </div>
              </form>}
              {error && <p className="room-setup-error" role="alert">{error}</p>}
            </section>
            <aside className="section-block room-setup-preview" aria-labelledby="rrsp-preview-heading">
              <h2 id="rrsp-preview-heading">Preview</h2>
              <p className="data-controls-copy">Built from what's entered so far; ? means not known yet.</p>
              <RoomChart rows={fhsaChartRows(year.ledger.rows)} overSince={year.ledger.overSince}
                span={{ from: year.window.from, to: year.window.to ?? torontoToday() }} name={`Deduction room left over the ${Y} tax year`} />
              <LedgerTable rows={year.ledger.rows} program="rrsp" />
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}
