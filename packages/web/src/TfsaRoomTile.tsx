import type { ReactNode } from "react";
import type { RoomAmbiguousRow, RoomMissingItem, TfsaRoomView } from "./apiErrors";
import { ambiguousAmount, cad, fxNote, inKindWayOut, notCountedLine, returningNote, storedAlertText, torontoDate, torontoDateTime } from "./roomFormat";

export type TfsaRoomState = { status: "loading" } | { status: "error" } | { status: "ready"; room: TfsaRoomView };

/** "INTERNAL_CASH_TRANSFER_IN" -> "internal cash transfer in". Text only. */
export const plainType = (type: string) => type.replace(/_/g, " ").toLowerCase();

export function AmbiguousLine({ row }: { row: RoomAmbiguousRow }) {
  const date = row.date === "unknown" ? "unknown date" : row.date;
  // The move, with its date and amount on a small line beneath (the widgets' room rows); shares in kind with no value say the way out.
  return (
    <li className="move-line">
      {`${row.label} ${plainType(row.type)}`}<small>{` ${date}, ${ambiguousAmount(row)}`}</small>
      {row.inKind && row.amountCad === null && <small className="tfsa-chat-only">{` ${inKindWayOut(row)}`}</small>}
    </li>
  );
}

/** The same words as the TFSA card's checklist and the assistant's questions: plain items, never advice. */
export type SetupStep = 1 | 2 | 3 | 4;
/** A figure for a connected or disconnected account: the setup has no field for it (spec §6), chat does. */
export const CHAT_ONLY_LINE = "You can give this figure in Claude or ChatGPT through VestLens; the dashboard doesn't take it yet.";
/** A managed account's figure: the contribution room page takes it (review 6), as does chat. */
export const MANAGED_ENTRY_LINE = "You can enter this on the contribution room page, or in Claude or ChatGPT through VestLens.";
/** The managed account's line, the assistant's words: what to give, why, and not to count anything twice. */
export const managedLine = (label: string) =>
  `What you have contributed to ${label} this year, and as of what date (contributions to it aren't visible through SnapTrade). Don't include amounts already entered elsewhere.`;

/** A year-to-date total on an outside TFSA (step 3 takes its dated entries) rather than on a connected one. */
const isOutsideKey = (accountKey: string) => accountKey.startsWith("outside:");

/** The setup step that answers a missing item, or null when only a refresh, or an answer in chat, does. */
export function missingStep(item: RoomMissingItem): SetupStep | null {
  switch (item.kind) {
    case "cra_room": return 1;
    case "outside_contributions": return 3;
    case "dated_entries": return isOutsideKey(item.accountKey) ? 3 : null;
    case "ambiguous": return 4;
    case "coverage": case "disconnected_account": case "managed_account": case "stale_activity": return null;
  }
}

/** True when the item's figure can be given only in chat (no setup field takes it yet). */
const chatOnly = (item: RoomMissingItem) =>
  item.kind === "coverage" || item.kind === "disconnected_account" || (item.kind === "dated_entries" && !isOutsideKey(item.accountKey));

type ManagedItem = Extract<RoomMissingItem, { kind: "managed_account" }>;

/**
 * The same words as the TFSA card's checklist and the assistant's questions: plain items, never advice. `renderManaged`
 * is the room page's own entry for a managed account's figure (review 6); without it the line says where to enter it.
 */
export function MissingLine({ item, year, onSetup, renderManaged }: { item: RoomMissingItem; year: number; onSetup?: (step: SetupStep) => void; renderManaged?: (item: ManagedItem) => ReactNode }) {
  const step = missingStep(item);
  const Li = ({ children }: { children: ReactNode }) => (
    <li>
      {children}{onSetup && step !== null && <> <button type="button" className="link-button" onClick={() => onSetup(step)}>Set up</button></>}
      {chatOnly(item) && <small className="tfsa-chat-only">{` ${CHAT_ONLY_LINE}`}</small>}
      {item.kind === "managed_account" && (renderManaged ? renderManaged(item) : <small className="tfsa-chat-only">{` ${MANAGED_ENTRY_LINE}`}</small>)}
    </li>
  );
  switch (item.kind) {
    case "cra_room": return <Li>{`Your TFSA contribution room on 1 January ${year}, from CRA My Account`}</Li>;
    case "coverage": return <Li>{`What you have contributed to ${item.label} this year (its stored activity doesn't go back to 1 January)`}</Li>;
    case "outside_contributions": return <Li>{`What you have contributed to ${item.label} this year, and as of what date`}</Li>;
    case "stale_activity": return <Li>{item.lastSyncedAt === null
      ? `${item.label}'s activity hasn't been loaded yet; there'll be a number after it refreshes`
      : `${item.label}'s activity was last updated ${torontoDateTime(item.lastSyncedAt)}; there'll be a number after it refreshes`}</Li>;
    case "disconnected_account": return <Li>{`What you contributed this year to a TFSA you confirmed that is no longer connected (key ${item.accountKey})`}</Li>;
    case "managed_account": return <Li>{managedLine(item.label)}</Li>;
    case "dated_entries": return <Li>{`${item.label}'s contributions this year as dated deposits, so withdrawals can be placed correctly`}</Li>;
    case "ambiguous": {
      const more = item.count - item.rows.length;
      return (
        <Li>
          {`${item.count} ${item.count === 1 ? "transfer needs" : "transfers need"} checking`}
          {item.rows.length > 0 && <ul>{item.rows.map((row) => <AmbiguousLine key={row.activityKey} row={row} />)}</ul>}
          {more > 0 && <small>{`${more} more need checking after these.`}</small>}
        </Li>
      );
    }
  }
}

/** Shown only while the read alert is open; the sentence is built from the stored excess and note, verbatim. */
export function TfsaOverLimitBanner({ state }: { state: TfsaRoomState }) {
  if (state.status !== "ready" || !state.room.alert) return null;
  return (
    <div className="warning-banner tfsa-banner" role="status" data-testid="tfsa-over-limit-banner">
      {storedAlertText(state.room.alert)}
    </div>
  );
}

export function TfsaRoomTile({ state, onOpenRoom }: { state: TfsaRoomState; onOpenRoom?: () => void }) {
  return (
    <section className="section-block tfsa-tile" aria-labelledby="tfsa-room-heading">
      <div className="section-kicker">Registered accounts</div>
      <h2 id="tfsa-room-heading">TFSA room</h2>
      {state.status === "loading" && <p className="data-controls-copy" role="status">Loading…</p>}
      {state.status === "error" && <p className="data-controls-copy">TFSA room is unavailable right now.</p>}
      {state.status === "ready" && <TfsaRoomBody room={state.room} />}
      {state.status === "ready" && onOpenRoom && (
        <button type="button" className="secondary-button tfsa-open" onClick={onOpenRoom}>Contribution room</button>
      )}
    </section>
  );
}

function TfsaRoomBody({ room }: { room: TfsaRoomView }) {
  return (
    <>
      {room.status === "known" ? <Known room={room} /> : (
        <>
          <p className="tfsa-lead">I can't give a number yet:</p>
          <ul className="tfsa-list" aria-label="Still needed">
            {room.missing.map((item, index) => <MissingLine key={index} item={item} year={room.year} />)}
          </ul>
        </>
      )}
      {returningNote(room) && <p className="tfsa-note">{returningNote(room)}</p>}
      {room.basis.length > 0 && (
        <ul className="tfsa-basis" aria-label="Based on">
          {room.basis.map((line, index) => <li key={index}>{line}</li>)}
        </ul>
      )}
    </>
  );
}

/** Room used, from the ledger: the CRA room less the room left (a qualifying withdrawal gives room back; spec §5). */
export const roomUsed = (room: { craRoomCad: number; roomLeftCad: number }) => Math.round((room.craRoomCad - room.roomLeftCad) * 100) / 100;

function Known({ room }: { room: Extract<TfsaRoomView, { status: "known" }> }) {
  const over = room.overLimitCad > 0 || room.roomLeftCad < 0;
  const note = fxNote(room.fx.contributions).trim();
  // As in the API text: the converted rows' note carries "est."; otherwise a bare "(est.)" goes on the headline. Never both.
  const est = !note && room.estimated ? " (est.)" : "";
  const headline = over
    ? `About ${cad(room.overLimitCad > 0 ? room.overLimitCad : -room.roomLeftCad)} over your TFSA room this year${est}`
    : `About ${cad(Math.max(0, room.roomLeftCad))} of TFSA room left this year${est}`;
  return (
    <>
      <p className={`tfsa-headline${over ? " over" : ""}`}>{headline}</p>
      {room.headlineBasis && <p className="data-controls-copy">{room.headlineBasis}</p>}
      {room.notCounted?.length ? <p className="data-controls-copy">{notCountedLine(room.notCounted, over)}</p> : null}
      {note && <p className="data-controls-copy">{note}</p>}
      <p className="data-controls-copy">{`Used ${cad(roomUsed(room))} of ${cad(room.craRoomCad)} CRA room`}</p>
      {/* The freshness line, verbatim as on the room page, the card and in the tool text (owner ruling 2026-10-26). */}
      {room.activityAsOf && <p className="data-controls-copy">{`Based on activity up to ${torontoDate(room.activityAsOf)}; deposits made since then aren't included`}</p>}
    </>
  );
}
