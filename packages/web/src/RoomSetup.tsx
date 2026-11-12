import { useEffect, useRef, useState } from "react";

import type { PortfolioApiClient } from "./App";
import type { RoomAccountSetView, RoomAccountView, RoomAmbiguousRow, RoomLedgerView, RoomOutsideEntry, TfsaRoomView } from "./apiErrors";
import { AppHeader } from "./AppHeader";
import { RoomChart } from "./RoomChart";
import { LedgerTable } from "./RoomPage";
import { plainType, type SetupStep } from "./TfsaRoomTile";
import { HISTORY_READING, ambiguousAmount, cad, calendarDate, inKindWayOut, isOutgoing, matchedNote, nativeMoney, readingHistory, torontoToday } from "./roomFormat";

/**
 * The TFSA room setup: one screen at a time, with the room page's chart and ledger beside it. The preview is always the
 * server's latest response (GET, then each PUT's answer), so nothing about room is computed here.
 *
 * The only question is the 1 January room (owner ruling 2026-10-26): the full flow is step 1, then the room page.
 * Steps 2-4 open only from the room page's edit links, and each returns to the page: 2 adjusts which connected accounts
 * count (the broker's TFSA label decides by default), 3 lists TFSAs at other institutions, 4 answers one unclear
 * transfer. In a new year the engine carries the latest earlier overrides forward, so step 1 writes only the room.
 */

const SAVE_FAILED = "That change could not be saved.";
const UNAVAILABLE = "TFSA room setup is unavailable right now.";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; room: TfsaRoomView };
type Draft = { date: string; kind: "deposit" | "withdrawal"; amount: string };

const TITLES: Record<SetupStep, (year: number) => string> = {
  1: (year) => `Room on 1 January ${year}`,
  2: () => "Your TFSAs: add or remove accounts",
  3: () => "TFSAs at other institutions",
  4: () => "Unclear transfer",
};

/** What step 4 reads from a room (the TFSA's, the FHSA's or one RRSP tax year's): its ledger and, while missing, its unclear rows. */
export type AnswerableRoom = { status: string; ledger: RoomLedgerView; missing?: ReadonlyArray<{ kind: string; count?: number; rows?: RoomAmbiguousRow[] }> };

/** This year's unanswered unclear transfers, from the missing list (capped by the server), and their total count. */
function ambiguousOf(room: AnswerableRoom): { rows: RoomAmbiguousRow[]; count: number } {
  const item = room.status === "missing" ? room.missing?.find((m) => m.kind === "ambiguous") : undefined;
  return item && item.rows ? { rows: item.rows, count: item.count ?? item.rows.length } : { rows: [], count: 0 };
}

/**
 * The overrides steps 2 and 3 write on top of: this year's set, else the latest earlier one (which the engine already
 * carries forward; its account keys kept only while still listed here, so a key that is gone is never re-asked), else none.
 */
export function baseSet(room: TfsaRoomView): RoomAccountSetView {
  if (room.accountSet) return room.accountSet;
  const last = room.previousAccountSet;
  if (!last) return { connected: [], notTfsa: [], outside: [] };
  const here = new Set(room.accounts.map((a) => a.accountKey));
  return { connected: last.connected.filter((k) => here.has(k)), notTfsa: last.notTfsa.filter((k) => here.has(k)), outside: last.outside };
}

/**
 * What steps 2 and 3 write: exceptions only. `connected` holds only neutral accounts added (a broker-labelled TFSA counts
 * without being listed, so it never becomes a confirmed key that would be asked about once gone); `notTfsa` holds
 * broker-labelled TFSAs excluded and any neutral account's stored entry.
 */
function overrides(room: TfsaRoomView, ticked?: Set<string>): { connected: string[]; notTfsa: string[] } {
  const set = baseSet(room);
  const isTicked = (key: string) => (ticked ? ticked.has(key) : preTicked(room).has(key));
  const neutral = room.accounts.filter((a) => a.neutral);
  const broker = room.accounts.filter((a) => !a.neutral);
  return {
    connected: neutral.filter((a) => isTicked(a.accountKey)).map((a) => a.accountKey),
    notTfsa: [
      ...broker.filter((a) => !isTicked(a.accountKey)).map((a) => a.accountKey),
      ...neutral.filter((a) => !isTicked(a.accountKey) && set.notTfsa.includes(a.accountKey)).map((a) => a.accountKey),
    ],
  };
}

/** Ticked: counted as a TFSA. Broker-labelled TFSAs unless the overrides exclude them; neutral ones once added. */
function preTicked(room: TfsaRoomView): Set<string> {
  const set = baseSet(room);
  const added = new Set(set.connected);
  const excluded = new Set(set.notTfsa.filter((k) => !added.has(k)));
  return new Set(room.accounts.filter((a) => added.has(a.accountKey) || (!a.neutral && !excluded.has(a.accountKey))).map((a) => a.accountKey));
}

/** The outside TFSAs on file: this year's, else the latest earlier year's (carried forward). */
const outsideOf = (room: TfsaRoomView) => baseSet(room).outside;

/** An outside TFSA's saved dated entries, read back from its ledger rows. */
function savedEntries(room: TfsaRoomView, label: string): Draft[] {
  return room.ledger.rows
    .filter((r) => r.label === label && r.accountKey?.startsWith("outside:") && r.activityKey === undefined
      && (r.kind === "contribution" || r.kind === "withdrawal") && r.date !== null && r.amountCad !== null)
    .map((r) => ({ date: r.date!, kind: r.kind === "withdrawal" ? "withdrawal" : "deposit", amount: String(Math.abs(r.amountCad!)) }));
}

const outcomeText = (n: number | null | undefined) => (n === null || n === undefined ? "?" : cad(n));


/**
 * A row the user answered, or a transfer matched to the other side of the move, read back from its ledger row so step 4
 * can answer it (again). `note` says which: the earlier answer, or what it was matched to.
 */
export function answeredRow(room: AnswerableRoom, activityKey: string | undefined, account: Account = "TFSA"): (RoomAmbiguousRow & { note: string; undo: string | undefined }) | undefined {
  if (!activityKey) return undefined;
  const r = room.ledger.rows.find((x) => x.activityKey === activityKey && x.kind !== "ambiguous" && (x.inferred === true || x.answered === true || x.assumed === true));
  if (!r) return undefined;
  const base = { activityKey, date: r.date ?? "unknown", amountCad: r.amountCad, estimated: r.estimated, rateDate: r.rateDate, native: r.native, type: "", label: r.label };
  // An assumed transfer has nothing stored, so there is nothing to clear: an answer replaces the assumption.
  if (r.assumed === true) {
    const assumed = !isOutgoing(r) ? "to be new money (a contribution)"
      : account === "FHSA" ? "to have no effect (moved to another FHSA or your RRSP)"
        : account === "RRSP" ? "to have no effect (moved to another RRSP or your FHSA)" : "to give no room back (moved to another TFSA)";
    return { ...base, note: `Assumed ${assumed}; you can change this.`, undo: undefined };
  }
  const match = matchedNote(r);
  const said = r.kind === "contribution" ? "new money (a contribution)" : r.kind === "withdrawal" ? "taken out (a withdrawal)"
    : isOutgoing(r) ? (account === "FHSA" ? "moved to another FHSA or your RRSP" : account === "RRSP" ? "moved to another RRSP or your FHSA" : `moved to another ${account}`)
      : account === "RRSP" ? "moved from another RRSP or your FHSA" : `moved from another ${account}`;
  return {
    ...base,
    note: match ? `${match.charAt(0).toUpperCase()}${match.slice(1)}.` : `You answered: ${said}.`,
    // A matched row, or an answer whose clearing brings the match back, goes back to the match; otherwise the answer is
    // cleared (an unmatched transfer then returns to its assumption).
    undo: r.inferred === true || r.automaticMatch === true ? "Use the automatic match" : "Clear my answer",
  };
}

/** An unanswered unclear transfer by key: from the missing list (with its type), else its ledger row (beyond the cap). */
export function unclearRow(room: AnswerableRoom, activityKey: string | undefined): RoomAmbiguousRow | undefined {
  const rows = ambiguousOf(room).rows;
  if (!activityKey) return rows[0];
  const listed = rows.find((r) => r.activityKey === activityKey);
  if (listed) return listed;
  const r = room.ledger.rows.find((x) => x.activityKey === activityKey && x.kind === "ambiguous");
  return r && { activityKey, date: r.date ?? "unknown", amountCad: r.amountCad, estimated: r.estimated, rateDate: r.rateDate, native: r.native, type: "", label: r.label };
}

/** Step 2's account line: "<label> ••<last 4>, <value with currency>", leaving out either part that is null. */
export function accountLine(a: RoomAccountView): string {
  const suffix = a.maskedNumber ? ` ••${a.maskedNumber}` : "";
  // A label already carries the suffix when another account shares its name (the server adds it).
  const named = suffix && !a.label.endsWith(suffix) ? `${a.label}${suffix}` : a.label;
  const value = a.value ? `, ${a.value.currency === "CAD" || a.value.currency === "USD" ? `${cad(a.value.amount)} ${a.value.currency}` : nativeMoney(a.value.amount, a.value.currency)}` : "";
  return `${named}${value}`;
}

export function RoomSetup({ api, initialStep = 1, activityKey, onDone }: {
  api: PortfolioApiClient;
  initialStep?: SetupStep;
  /** Step 4 on this transfer (its ledger link): an unclear one to answer, or a matched or answered one to answer again. */
  activityKey?: string;
  onDone(): void;
}) {
  const [state, setState] = useState<Load>({ status: "loading" });
  const [step, setStep] = useState<SetupStep>(initialStep);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controls = useRef<HTMLDivElement>(null);

  const { getTfsaRoom } = api;
  useEffect(() => {
    if (!getTfsaRoom) { setState({ status: "error" }); return; }
    let active = true;
    getTfsaRoom().then(
      (room) => { if (active) setState({ status: "ready", room }); },
      () => { if (active) setState({ status: "error" }); },
    );
    return () => { active = false; };
  }, [getTfsaRoom]);

  const room = state.status === "ready" ? state.room : null;
  // Step 4 is one transfer: the one its link names (answered or not), else the first unclear one. Never a queue.
  const answered = room && step === 4 ? answeredRow(room, activityKey) : undefined;
  const current = room && step === 4 ? answered ?? unclearRow(room, activityKey) : undefined;
  const focusKey = state.status === "ready" ? `${step}:${current?.activityKey ?? ""}` : "";

  // Each screen's first control takes focus.
  useEffect(() => {
    if (!focusKey) return;
    controls.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
  }, [focusKey]);

  /** Every screen returns to the room page once it is saved or left (the full flow is step 1 alone). */
  const done = () => { setError(null); onDone(); };

  /** Runs a write; the response replaces the preview. Returns it, or null after showing the fixed failure line. */
  const write = async (run: () => Promise<TfsaRoomView> | undefined): Promise<TfsaRoomView | null> => {
    setBusy(true);
    setError(null);
    try {
      const pendingWrite = run();
      if (!pendingWrite) throw new Error("unavailable");
      const next = await pendingWrite;
      setState({ status: "ready", room: next });
      return next;
    } catch {
      setError(SAVE_FAILED);
      return null;
    } finally {
      setBusy(false);
    }
  };

  /** Step 1 writes only the room: earlier overrides already carry forward in the engine. */
  const saveCra = async (amountCad: number) => {
    if (room && await write(() => api.putRoomCra?.({ year: room.year, amountCad }))) done();
  };

  return (
    <div className="app-shell">
      <AppHeader>
        <button type="button" className="topbar-link" onClick={onDone}>Close</button>
      </AppHeader>
      <main className="dashboard account-page room-page">
        <section className="dashboard-heading"><div><h1>TFSA room setup</h1></div></section>
        {state.status === "loading" && <p className="data-controls-copy" role="status">Loading…</p>}
        {state.status === "error" && <p className="data-controls-copy">{UNAVAILABLE}</p>}
        {room && (
          <div className="room-setup">
            <section className="section-block room-setup-question" aria-labelledby="room-setup-step">
              <h2 id="room-setup-step">{TITLES[step](room.year)}</h2>
              <div ref={controls} className="room-setup-controls">
                {step === 1 && <CraStep key="1" room={room} busy={busy} onError={setError} onLater={done} onSave={saveCra} />}
                {step === 2 && <AccountsStep key="2" room={room} busy={busy} onLater={done}
                  onGoToOutside={() => { setError(null); setStep(3); }}
                  onSave={async (ticked) => {
                    const { connected, notTfsa } = overrides(room, ticked);
                    if (await write(() => api.putRoomAccounts?.({ year: room.year, connected, notTfsa, outside: outsideOf(room) }))) done();
                  }} />}
                {step === 3 && <OutsideStep key="3" room={room} busy={busy} onError={setError} onLater={done} onContinue={done}
                  onSetLabels={(outside) => {
                    // The set's own neutral adds and exclusions, unchanged: step 3 never adds a connected key.
                    const { connected, notTfsa } = overrides(room);
                    return write(() => api.putRoomAccounts?.({ year: room.year, connected, notTfsa, outside }));
                  }}
                  onSaveMoves={(label, entries) => write(() => api.putRoomOutsideMoves?.(label, { year: room.year, entries }))} />}
                {step === 4 && (current
                  ? <TransferStep key={current.activityKey} row={current} answered={current === answered}
                    note={answered?.note} undoLabel={answered?.undo} busy={busy} onLater={done}
                    onAnswer={async (effect) => {
                      const key = current.activityKey;
                      if (await write(() => api.putRoomActivity?.(key, { effect }))) done();
                    }}
                    onUndo={async () => {
                      const key = current.activityKey;
                      if (await write(() => api.deleteRoomActivity?.(key))) done();
                    }} />
                  : <>
                    <p>No transfers need checking.</p>
                    <button type="button" className="primary-button" onClick={done}>Continue</button>
                  </>)}
              </div>
              {error && <p className="room-setup-error" role="alert">{error}</p>}
            </section>
            <Preview room={room} current={current === answered ? undefined : current} />
          </div>
        )}
      </main>
    </div>
  );
}

function Preview({ room, current }: { room: TfsaRoomView; current?: RoomAmbiguousRow }) {
  const outcome = current ? room.outcomes[current.activityKey] : undefined;
  const out = current ? isOutgoing(current) : false;
  return (
    <aside className="section-block room-setup-preview" aria-labelledby="room-preview-heading">
      <h2 id="room-preview-heading">Preview</h2>
      <p className="data-controls-copy">Built from what's entered so far; ? means not known yet.</p>
      {readingHistory(room) && <p className="data-controls-copy" role="status">{HISTORY_READING}</p>}
      {current && (
        <div className="room-setup-outcomes">
          <p className="tfsa-headline">{`Room left at the end of the year so far: ${outcomeText((out ? outcome?.asWithdrawal : outcome?.asContribution)?.roomLeftCad)} or ${outcomeText(outcome?.asNone.roomLeftCad)}`}</p>
          <p className="data-controls-copy">{out
            ? "The first if it was taken out, the second if it was moved to another TFSA."
            : "The first if it was new money, the second if it was moved from another TFSA."}</p>
        </div>
      )}
      <RoomChart rows={room.ledger.rows} overSince={room.ledger.overSince} />
      <LedgerTable rows={room.ledger.rows} />
    </aside>
  );
}

function Actions({ busy, primary, onLater }: { busy: boolean; primary?: string; onLater(): void }) {
  return (
    <div className="room-setup-actions">
      {primary && <button type="submit" className="primary-button" disabled={busy}>{primary}</button>}
      <button type="button" className="secondary-button" disabled={busy} onClick={onLater}>Later</button>
    </div>
  );
}

function CraStep({ room, busy, onSave, onLater, onError }: {
  room: TfsaRoomView; busy: boolean; onSave(amountCad: number): void; onLater(): void; onError(message: string | null): void;
}) {
  const saved = room.ledger.rows.find((r) => r.kind === "cra_room")?.amountCad;
  const [value, setValue] = useState(saved === null || saved === undefined ? "" : String(saved));
  const label = `Contribution room on January 1, ${room.year}`;
  return (
    <form noValidate onSubmit={(e) => {
      e.preventDefault();
      const amount = Number(value);
      if (value.trim() === "" || !Number.isFinite(amount) || amount < 0) { onError("Enter the figure as a dollar amount, 0 or more."); return; }
      onSave(amount);
    }}>
      <p>{`In CRA My Account, your TFSA page shows “${label}”. Enter that figure as CRA shows it, not one you've worked out.`}</p>
      <label className="room-setup-field">
        <span>{label}</span>
        <input type="number" inputMode="decimal" min={0} step="0.01" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <Actions busy={busy} primary="Save" onLater={onLater} />
    </form>
  );
}

function AccountsStep({ room, busy, onSave, onLater, onGoToOutside }: {
  room: TfsaRoomView; busy: boolean; onSave(ticked: Set<string>): void; onLater(): void; onGoToOutside(): void;
}) {
  const outside = outsideOf(room);
  const [ticked, setTicked] = useState<Set<string>>(() => preTicked(room));
  const toggle = (key: string) => setTicked((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return (
    <form noValidate onSubmit={(e) => {
      e.preventDefault();
      // An unknown-type account left unticked is not a "you said" claim: it stays "unknown type, not counted" (overrides).
      onSave(ticked);
    }}>
      <p>{`Ticked accounts count as TFSAs in ${room.year}. Accounts your broker labels TFSA count automatically; an account of unknown type counts once it is ticked.`}</p>
      {room.accounts.length === 0
        ? <p>No connected account is labelled TFSA or left unlabelled.</p>
        : (
          <ul className="room-setup-accounts">
            {room.accounts.map((a) => (
              <li key={a.accountKey}>
                <label>
                  <input type="checkbox" checked={ticked.has(a.accountKey)} onChange={() => toggle(a.accountKey)} />
                  {` ${accountLine(a)}${a.neutral ? " (your broker doesn't label its type)" : ""}`}
                </label>
              </li>
            ))}
          </ul>
        )}
      {outside.length > 0 && (
        <>
          <p>TFSAs at other institutions, kept with this list:</p>
          <ul className="tfsa-list" aria-label="TFSAs at other institutions">{outside.map((o) => <li key={o.label}>{o.label}</li>)}</ul>
        </>
      )}
      <button type="button" className="link-button" disabled={busy} onClick={onGoToOutside}>TFSAs at other institutions</button>
      <Actions busy={busy} primary="Save" onLater={onLater} />
    </form>
  );
}

function OutsideStep({ room, busy, onSetLabels, onSaveMoves, onContinue, onLater, onError }: {
  room: TfsaRoomView; busy: boolean;
  onSetLabels(outside: { label: string }[]): Promise<TfsaRoomView | null>;
  onSaveMoves(label: string, entries: RoomOutsideEntry[]): Promise<TfsaRoomView | null>;
  onContinue(): void; onLater(): void; onError(message: string | null): void;
}) {
  const [name, setName] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft[]>>({});
  // "Remove <label>" asks once before it removes the account and its entries.
  const [removing, setRemoving] = useState<string | null>(null);
  const today = torontoToday();
  const lastDay = `${room.year}-12-31` < today ? `${room.year}-12-31` : today;
  // Saved with this year's overrides (last year's carried forward when there are none yet).
  const set = baseSet(room);
  const intro = `Each TFSA you hold at another institution, with the dated deposits and withdrawals made there in ${room.year}. A total on its own can't say when room ran out.`;
  const labels = set.outside.map((o) => o.label);
  const entriesOf = (label: string) => drafts[label] ?? savedEntries(room, label);
  const update = (label: string, next: Draft[]) => setDrafts((prev) => ({ ...prev, [label]: next }));

  const add = async () => {
    const label = name.trim();
    if (label === "" || label.length > 60) { onError("Enter a name of up to 60 characters."); return; }
    if (labels.some((l) => l.toLowerCase() === label.toLowerCase())) { onError("That name is already in the list."); return; }
    if (await onSetLabels([...set.outside, { label }])) setName("");
  };
  const save = (label: string) => {
    const list = entriesOf(label);
    const entries = list.map((d) => ({ date: d.date, kind: d.kind, amountCad: Number(d.amount) }));
    const valid = entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.date.startsWith(`${room.year}-`) && e.date <= lastDay
      && !Number.isNaN(Date.parse(`${e.date}T00:00:00Z`)) && list.every((d) => d.amount.trim() !== "") && Number.isFinite(e.amountCad) && e.amountCad > 0);
    if (!valid) { onError(`Each entry needs a date in ${room.year}, no later than today, and an amount above $0.`); return; }
    void onSaveMoves(label, entries.map(({ date, amountCad, kind }) => ({ date, amountCad, kind })));
  };

  return (
    <>
      <p>{intro}</p>
      {labels.map((label) => {
        const list = entriesOf(label);
        return (
          <fieldset key={label} className="room-setup-outside">
            <legend>{label}</legend>
            {list.length === 0 && <p className="data-controls-copy">{`No deposits or withdrawals entered for ${room.year}.`}</p>}
            {list.map((d, i) => {
              const change = (patch: Partial<Draft>) => update(label, list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              return (
                <div key={i} className="room-setup-entry">
                  <label><span>Date</span>
                    <input type="date" min={`${room.year}-01-01`} max={lastDay} value={d.date} onChange={(e) => change({ date: e.target.value })} />
                  </label>
                  <label><span>Deposit or withdrawal</span>
                    <select value={d.kind} onChange={(e) => change({ kind: e.target.value === "withdrawal" ? "withdrawal" : "deposit" })}>
                      <option value="deposit">Deposit</option>
                      <option value="withdrawal">Withdrawal</option>
                    </select>
                  </label>
                  <label><span>Amount (CAD)</span>
                    <input type="number" inputMode="decimal" min={0} step="0.01" value={d.amount} onChange={(e) => change({ amount: e.target.value })} />
                  </label>
                  <button type="button" className="link-button" onClick={() => update(label, list.filter((_, j) => j !== i))}>Remove entry</button>
                </div>
              );
            })}
            <div className="room-setup-actions">
              <button type="button" className="secondary-button" disabled={busy}
                onClick={() => update(label, [...list, { date: "", kind: "deposit", amount: "" }])}>Add a deposit or withdrawal</button>
              <button type="button" className="primary-button" disabled={busy} onClick={() => save(label)}>{`Save ${label}`}</button>
              {removing !== label && (
                <button type="button" className="link-button" disabled={busy} onClick={() => setRemoving(label)}>{`Remove ${label}`}</button>
              )}
            </div>
            {removing === label && (
              <div className="room-setup-confirm" role="group" aria-label={`Remove ${label}`}>
                <p>{`Remove ${label} and its entries? This can't be undone.`}</p>
                <div className="room-setup-actions">
                  <button type="button" className="primary-button" disabled={busy}
                    onClick={async () => { if (await onSetLabels(set.outside.filter((o) => o.label !== label))) setRemoving(null); }}>{`Remove ${label}`}</button>
                  <button type="button" className="secondary-button" disabled={busy} onClick={() => setRemoving(null)}>Cancel</button>
                </div>
              </div>
            )}
          </fieldset>
        );
      })}
      <form noValidate className="room-setup-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="room-setup-field">
          <span>Name of the institution or account</span>
          <input type="text" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" className="secondary-button" disabled={busy}>Add</button>
      </form>
      <div className="room-setup-actions">
        <button type="button" className="primary-button" disabled={busy} onClick={onContinue}>Continue</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={onLater}>Later</button>
      </div>
    </>
  );
}

/** Which registered account's transfer step 4 answers. */
export type Account = "TFSA" | "FHSA" | "RRSP";

/** Step 4's question and answers by direction: money coming into a TFSA (or FHSA or RRSP), or leaving one. */
const COPY = {
  TFSA: {
    in: {
      question: "Was it new money?",
      explanation: "New money counts against your room; money moved directly from another TFSA doesn't.",
      answers: [["New money (a contribution)", "contribution"], ["Moved from another TFSA", "none"]],
    },
    out: {
      question: "Did this money leave your TFSAs?",
      explanation: "Taking money out gives the room back on 1 January next year; moving it directly to another TFSA doesn't.",
      answers: [["Taken out (a withdrawal)", "withdrawal"], ["Moved to another TFSA", "none"]],
    },
  },
  FHSA: {
    in: {
      question: "Was it new money?",
      explanation: "New money and transfers from your RRSP use FHSA room; money moved directly from another FHSA doesn't.",
      answers: [["New money (a contribution)", "contribution"], ["Moved from another FHSA", "none"]],
    },
    out: {
      question: "Did this money leave your FHSAs?",
      explanation: "Taking money out never gives FHSA room back, though it counts against an amount over this year; moving it directly to another FHSA or to your RRSP has no effect.",
      // Both moves store none: neither changes FHSA room or the amount over (only a designated transfer would).
      answers: [["Taken out (a withdrawal)", "withdrawal"], ["Moved to another FHSA", "none"], ["Moved to my RRSP", "none"]],
    },
  },
  // Ruling R10 (verbatim). Both "moved" answers store none: neither changes RRSP deduction room.
  RRSP: {
    in: {
      question: "Was it new money?",
      explanation: "New money counts against your RRSP deduction room; money moved directly from another of your RRSPs or from your FHSA doesn't.",
      answers: [["New money (a contribution)", "contribution"], ["Moved from another RRSP", "none"], ["Moved from my FHSA", "none"]],
    },
    out: {
      question: "Did this money leave your RRSPs?",
      explanation: "Taking money out never gives RRSP deduction room back; moving it directly to another RRSP or to your FHSA has no effect on it.",
      answers: [["Taken out (a withdrawal)", "withdrawal"], ["Moved to another RRSP", "none"], ["Moved to my FHSA", "none"]],
    },
  },
} as const;

/** `answered`: a matched or already answered transfer opened from its edit link; it can go back to the automatic match. */
export function TransferStep({ row, answered = false, note, undoLabel, busy, onAnswer, onUndo, onLater, account = "TFSA" }: {
  row: RoomAmbiguousRow; answered?: boolean; note?: string; undoLabel?: string; busy: boolean;
  onAnswer(effect: "contribution" | "withdrawal" | "none"): void; onUndo(): void; onLater(): void; account?: Account;
}) {
  const date = row.date === "unknown" ? "unknown date" : calendarDate(row.date);
  const amount = ambiguousAmount(row);
  const copy = COPY[account][isOutgoing(row) ? "out" : "in"];
  return (
    <section aria-label={answered ? `Transfer on ${date}` : `Unclear transfer on ${date}`}>
      <p className="move-line">{answered || row.type === "" ? row.label : `${row.label} ${plainType(row.type)}`}<small>{` ${date}, ${amount}`}</small></p>
      {row.inKind && row.amountCad === null && <p className="data-controls-copy">{inKindWayOut(row)}</p>}
      {answered && <p className="data-controls-copy">{note ?? `You answered: moved from another ${account}.`}</p>}
      <p><strong>{copy.question}</strong></p>
      <p className="data-controls-copy">{copy.explanation}</p>
      <div className="room-setup-actions">
        {copy.answers.map(([text, effect]) => (
          <button key={text} type="button" className="primary-button" disabled={busy} onClick={() => onAnswer(effect)}>{text}</button>
        ))}
        {answered && undoLabel && <button type="button" className="secondary-button" disabled={busy} onClick={onUndo}>{undoLabel}</button>}
        <button type="button" className="secondary-button" disabled={busy} onClick={onLater}>Later</button>
      </div>
    </section>
  );
}
