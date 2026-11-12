import { useEffect, useRef, useState } from "react";

import type { PortfolioApiClient } from "./App";
import type { FhsaRoomView } from "./apiErrors";
import { AppHeader } from "./AppHeader";
import { RoomChart } from "./RoomChart";
import { HISTORY_READING, readingHistory } from "./roomFormat";
import { fhsaChartRows, LedgerTable } from "./RoomPage";
import { answeredRow, TransferStep, unclearRow } from "./RoomSetup";

/**
 * The FHSA room setup: one question, the year's participation room as CRA reports it (CRA My Account or the notice of
 * assessment). Everything else is automatic: the broker's FHSA label decides which accounts count, and transfers are
 * matched or assumed. Step 4 (from an edit link) answers one transfer with the TFSA's own step, worded for the FHSA.
 * The preview is always the server's latest response; nothing about room is computed here.
 */

const SAVE_FAILED = "That change could not be saved.";
const UNAVAILABLE = "FHSA room setup is unavailable right now.";

type Shown = Exclude<FhsaRoomView, { status: "none" }>;
type Load = { status: "loading" } | { status: "error" } | { status: "ready"; room: Shown };

export function FhsaSetup({ api, onDone, step = 1, activityKey }: { api: PortfolioApiClient; onDone(): void; step?: 1 | 4; activityKey?: string }) {
  const [state, setState] = useState<Load>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const { getFhsaRoom } = api;
  useEffect(() => {
    if (!getFhsaRoom) { setState({ status: "error" }); return; }
    let active = true;
    getFhsaRoom().then(
      (room) => {
        if (!active) return;
        if (room.status === "none") { setState({ status: "error" }); return; }
        const saved = room.ledger.rows.find((r) => r.kind === "cra_room")?.amountCad;
        setValue(saved === null || saved === undefined ? "" : String(saved));
        setState({ status: "ready", room });
      },
      () => { if (active) setState({ status: "error" }); },
    );
    return () => { active = false; };
  }, [getFhsaRoom]);

  const ready = state.status === "ready";
  const transfers = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ready) return;
    if (step === 1) input.current?.focus();
    else transfers.current?.querySelector<HTMLElement>("button")?.focus();
  }, [ready, step]);

  const room = state.status === "ready" ? state.room : null;
  const label = room ? `FHSA participation room for ${room.year}` : "";
  // Step 4 is one transfer: the one its link names (answered, matched or assumed), else the first unclear one.
  const answered = room && step === 4 ? answeredRow(room, activityKey, "FHSA") : undefined;
  const current = room && step === 4 ? answered ?? unclearRow(room, activityKey) : undefined;

  /** Runs a write; the response replaces the preview, then the page comes back. */
  const write = async (run: () => Promise<FhsaRoomView> | undefined) => {
    setBusy(true);
    setError(null);
    try {
      const pending = run();
      if (!pending) throw new Error("unavailable");
      const next = await pending;
      if (next.status !== "none") setState({ status: "ready", room: next });
      onDone();
    } catch {
      setError(SAVE_FAILED);
    } finally {
      setBusy(false);
    }
  };
  const save = (amountCad: number) => room && write(() => api.putFhsaRoom?.({ year: room.year, amountCad }));

  return (
    <div className="app-shell">
      <AppHeader>
        <button type="button" className="topbar-link" onClick={onDone}>Close</button>
      </AppHeader>
      <main className="dashboard account-page room-page">
        <section className="dashboard-heading"><div><h1>FHSA room setup</h1></div></section>
        {state.status === "loading" && <p className="data-controls-copy" role="status">Loading…</p>}
        {state.status === "error" && <p className="data-controls-copy">{UNAVAILABLE}</p>}
        {room && (
          <div className="room-setup">
            <section className="section-block room-setup-question" aria-labelledby="fhsa-setup-step">
              <h2 id="fhsa-setup-step">{step === 4 ? "FHSA transfer" : `FHSA room for ${room.year}`}</h2>
              {step === 4 && (
                <div ref={transfers} className="room-setup-controls">
                  {current
                    ? <TransferStep key={current.activityKey} account="FHSA" row={current} answered={current === answered}
                      note={answered?.note} undoLabel={answered?.undo} busy={busy} onLater={onDone}
                      onAnswer={(effect) => void write(() => api.putFhsaRoomActivity?.(current.activityKey, { effect }))}
                      onUndo={() => void write(() => api.deleteFhsaRoomActivity?.(current.activityKey))} />
                    : <>
                      <p>No transfers need checking.</p>
                      <button type="button" className="primary-button" onClick={onDone}>Continue</button>
                    </>}
                </div>
              )}
              {step === 1 && <form noValidate className="room-setup-controls" onSubmit={(e) => {
                e.preventDefault();
                const amount = Number(value);
                if (value.trim() === "" || !Number.isFinite(amount) || amount < 0) { setError("Enter the figure as a dollar amount, 0 or more."); return; }
                void save(amount);
              }}>
                <p>{`Your FHSA participation room for ${room.year}, from CRA My Account or your notice of assessment. Enter that figure as CRA shows it, not one you've worked out.`}</p>
                <label className="room-setup-field">
                  <span>{label}</span>
                  <input ref={input} type="number" inputMode="decimal" min={0} step="0.01" value={value} onChange={(e) => setValue(e.target.value)} />
                </label>
                <div className="room-setup-actions">
                  <button type="submit" className="primary-button" disabled={busy}>Save</button>
                  <button type="button" className="secondary-button" disabled={busy} onClick={onDone}>Later</button>
                </div>
              </form>}
              {error && <p className="room-setup-error" role="alert">{error}</p>}
            </section>
            <aside className="section-block room-setup-preview" aria-labelledby="fhsa-preview-heading">
              <h2 id="fhsa-preview-heading">Preview</h2>
              <p className="data-controls-copy">Built from what's entered so far; ? means not known yet.</p>
              {readingHistory(room) && <p className="data-controls-copy" role="status">{HISTORY_READING}</p>}
              <RoomChart rows={fhsaChartRows(room.ledger.rows)} overSince={room.ledger.overSince} />
              <LedgerTable rows={room.ledger.rows} program="fhsa" />
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}
