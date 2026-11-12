import { useCallback, useEffect, useState } from "react";
import { Check, Download, Loader2, Pencil, Trash2, Unlink } from "lucide-react";

import { FixedMessageError, type AiApp, type MemoryFactView, type MemoryGroupView } from "./apiErrors";
import type { ConnectionHealth, PortfolioApiClient } from "./App";
import { AppHeader } from "./AppHeader";
import { retentionCopy } from "./retention";

const GENERIC_ERROR = "The request did not finish. Please try again.";

/** Only client-authored messages are shown; anything else becomes the generic line. */
function fixedMessage(cause: unknown): string {
  return cause instanceof FixedMessageError ? cause.message : GENERIC_ERROR;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
}

/** Saves a Blob through a temporary link; the name is the server's, already reduced to a plain file name. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

type Load<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; items: T };

function useLoad<T>(loader: (() => Promise<T>) | undefined, reloadKey: number): Load<T> {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  useEffect(() => {
    if (!loader) return;
    let active = true;
    loader().then(
      (items) => { if (active) setState({ status: "ready", items }); },
      (cause) => {
        if (!active) return;
        setState({
          status: "error",
          message: fixedMessage(cause),
        });
      },
    );
    return () => { active = false; };
  }, [loader, reloadKey]);
  return state;
}

/** Disconnect / revoke row with a confirm dialog; one action in flight at a time. */
function ConfirmRow({
  title,
  detail,
  actionLabel,
  confirmLabel,
  dialogLabel,
  explanation,
  onConfirm,
}: {
  title: string;
  detail: string;
  actionLabel: string;
  confirmLabel: string;
  dialogLabel: string;
  explanation: string;
  onConfirm(): Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setConfirming(false);
    } catch (cause) {
      setError(fixedMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li>
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      {confirming ? (
        <div className="confirm-panel" role="alertdialog" aria-label={dialogLabel}>
          <p>{explanation}</p>
          <div className="confirm-actions">
            <button type="button" className="danger-button" disabled={busy} onClick={() => void run()}>
              {busy ? <Loader2 className="spin" size={16} /> : <Unlink size={16} />} {confirmLabel}
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => { setConfirming(false); setError(null); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="secondary-button" onClick={() => setConfirming(true)}>
          <Unlink size={16} /> {actionLabel}
        </button>
      )}
      {error && <p className="data-controls-error" role="alert">{error}</p>}
    </li>
  );
}


/** The Account page's groups, by what a fact is about. Node types the API may add later fall into "More". */
const MEMORY_GROUPS: ReadonlyArray<{ id: string; label: string; nodeTypes: readonly string[] }> = [
  { id: "accounts", label: "Accounts", nodeTypes: ["account", "activity"] },
  { id: "holdings", label: "Holdings", nodeTypes: ["security", "sector"] },
  { id: "goals", label: "Goals", nodeTypes: ["goal"] },
  { id: "rules", label: "Rules", nodeTypes: ["rule"] },
  { id: "tax-years", label: "Tax years", nodeTypes: ["tax_year"] },
  { id: "you", label: "You", nodeTypes: ["user"] },
];
const PROVENANCE_LABEL: Readonly<Record<string, string>> = { stated: "Stated", inferred: "Inferred", imported: "Imported", derived: "Derived" };
/** Human-written node keys worth showing; hashed account and activity keys are not. */
const NAMED_NODE_TYPES = new Set(["security", "sector", "goal", "rule"]);
/** Reserved TFSA values that are one amount: a plain number field, no JSON. */
const AMOUNT_PROPERTIES = new Set(["tax_year.cra_room_jan1", "account.ytd_contributions"]);

function amountOf(fact: MemoryFactView): number | null {
  const value = fact.value as { amountCad?: unknown } | null;
  return AMOUNT_PROPERTIES.has(fact.property) && value && typeof value.amountCad === "number" ? value.amountCad : null;
}

/**
 * One remembered entry. Every string here comes from an assistant or the user and renders as text only: never as
 * HTML or a link. Edit saves a new stated entry; the old wording stays as history until the entry is deleted.
 */
function MemoryFactRow({ fact, api, onChanged }: { fact: MemoryFactView; api: PortfolioApiClient; onChanged(): void }) {
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const [text, setText] = useState(fact.text);
  const originalAmount = amountOf(fact);
  const [amount, setAmount] = useState(originalAmount === null ? "" : String(originalAmount));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      after?.();
      onChanged();
    } catch (cause) {
      setError(fixedMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    const change: { text: string; value?: unknown } = { text };
    if (originalAmount !== null) change.value = { ...(fact.value as object), amountCad: Number(amount) };
    return run(() => api.editMemory!(fact.id, change), () => setMode("view"));
  };

  const named = NAMED_NODE_TYPES.has(fact.nodeType) ? fact.nodeKey : null;
  const added = formatDate(fact.recordedAt);
  const inferred = fact.provenance === "inferred";
  return (
    <li>
      <div>
        <strong>{fact.text}</strong>
        {/* Each fact on its own small line, never joined with dots. */}
        <span className="memory-meta">
          {named && <span>{named}</span>}
          <span>{`${added ? `Added ${added} from` : "From"} ${fact.source ?? "an unknown source"}`}</span>
          {!inferred && <span>{PROVENANCE_LABEL[fact.provenance] ?? fact.provenance}</span>}
        </span>
        {inferred && <span className="memory-inferred">Inferred</span>}
      </div>
      {mode === "view" && (
        <div className="memory-actions">
          {inferred && api.promoteMemory && (
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void run(() => api.promoteMemory!(fact.id))}>
              <Check size={16} /> That&apos;s right
            </button>
          )}
          {api.editMemory && (
            <button type="button" className="secondary-button" onClick={() => { setText(fact.text); setError(null); setMode("edit"); }}>
              <Pencil size={16} /> Edit
            </button>
          )}
          {api.deleteMemory && (
            <button type="button" className="secondary-button danger-outline" onClick={() => { setError(null); setMode("delete"); }}>
              <Trash2 size={16} /> Delete
            </button>
          )}
        </div>
      )}
      {mode === "edit" && (
        <div className="confirm-panel memory-edit">
          <label>
            <span>Entry text</span>
            <textarea value={text} maxLength={2000} rows={3} onChange={(event) => setText(event.target.value)} disabled={busy} />
          </label>
          {originalAmount !== null && (
            <label>
              <span>Amount in CAD</span>
              <input type="number" min={0} step="0.01" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy} />
            </label>
          )}
          <div className="confirm-actions">
            <button type="button" className="primary-button" disabled={busy || text.trim() === "" || (originalAmount !== null && (amount.trim() === "" || !(Number(amount) >= 0)))} onClick={() => void save()}>
              {busy ? <Loader2 className="spin" size={16} /> : null} Save
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => { setMode("view"); setError(null); }}>Cancel</button>
          </div>
        </div>
      )}
      {mode === "delete" && (
        <div className="confirm-panel" role="alertdialog" aria-label="Confirm deleting this entry">
          <p>This removes this from what VestLens remembers, including its earlier wording. Your brokerage is not changed.</p>
          <div className="confirm-actions">
            <button type="button" className="danger-button" disabled={busy} onClick={() => void run(() => api.deleteMemory!(fact.id), () => setMode("view"))}>
              {busy ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />} Delete entry
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => { setMode("view"); setError(null); }}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="data-controls-error" role="alert">{error}</p>}
    </li>
  );
}

/** "What VestLens remembers": facts and plans shared with connected assistants, grouped by what they are about. */
function MemorySection({ api }: { api: PortfolioApiClient }) {
  const [key, setKey] = useState(0);
  const loadMemory = useCallback(async () => (await api.getMemory!()).groups, [api]);
  const memory = useLoad<MemoryGroupView[]>(loadMemory, key);
  const reload = () => setKey((value) => value + 1);
  const facts = memory.status === "ready" ? memory.items.flatMap((group) => group.facts.map((fact) => ({ ...fact, nodeType: group.nodeType }))) : [];
  const claimed = new Set(MEMORY_GROUPS.flatMap((group) => group.nodeTypes));
  const groups = [
    ...MEMORY_GROUPS.map((group) => ({ ...group, facts: facts.filter((fact) => group.nodeTypes.includes(fact.nodeType)) })),
    { id: "more", label: "More", nodeTypes: [], facts: facts.filter((fact) => !claimed.has(fact.nodeType)) },
  ].filter((group) => group.facts.length > 0);
  return (
    <section className="section-block data-controls" aria-labelledby="account-memory">
      <h2 id="account-memory">What VestLens remembers</h2>
      <p className="data-controls-copy">
        Facts and plans you share with a connected assistant, so any of them can use them. Edit or delete anything here. Entries marked
        Inferred are an assistant&apos;s guess and never feed a number until you confirm them.
      </p>
      {memory.status === "loading" && <p className="data-controls-copy" role="status">Loading…</p>}
      {memory.status === "error" && <p className="data-controls-copy" role="alert">{memory.message}</p>}
      {memory.status === "ready" && groups.length === 0 && (
        <p className="data-controls-copy">VestLens hasn&apos;t remembered anything yet. Facts and plans you share with a connected assistant will appear here.</p>
      )}
      {memory.status === "ready" && groups.map((group) => (
        <section key={group.id} className="memory-group" aria-labelledby={`memory-${group.id}`}>
          <h3 id={`memory-${group.id}`}>{group.label}</h3>
          <ul className="data-connection-list">
            {group.facts.map((fact) => <MemoryFactRow key={fact.id} fact={fact} api={api} onChanged={reload} />)}
          </ul>
        </section>
      ))}
    </section>
  );
}

/**
 * Account page: connected brokerages and AI apps, and data export.
 * Errors show fixed client messages, never server text; names and hosts are rendered as text.
 */
export function AccountPage({
  api,
  onBack,
  onSignOut,
  saveFile,
}: {
  api: PortfolioApiClient;
  onBack(): void;
  onSignOut(): void;
  saveFile(blob: Blob, filename: string): void;
}) {
  const [connectionsKey, setConnectionsKey] = useState(0);
  const [appsKey, setAppsKey] = useState(0);
  const connections = useLoad<ConnectionHealth[]>(api.disconnectConnection ? api.getConnections : undefined, connectionsKey);
  const apps = useLoad<AiApp[]>(api.revokeAiApp ? api.getAiApps : undefined, appsKey);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const download = useCallback(async () => {
    if (!api.exportMyData) return;
    setExporting(true);
    setExportError(null);
    try {
      const { blob, filename } = await api.exportMyData();
      saveFile(blob, filename);
    } catch (cause) {
      setExportError(fixedMessage(cause));
    } finally {
      setExporting(false);
    }
  }, [api, saveFile]);

  return (
    <div className="app-shell">
      <AppHeader>
        <button type="button" className="topbar-link" onClick={onBack}>Back</button>
        <button type="button" className="topbar-link" onClick={onSignOut}>Sign out</button>
      </AppHeader>
      <main className="dashboard account-page">
        <section className="dashboard-heading">
          <div>
            <h1>Account</h1>
            <p className="data-controls-copy">{retentionCopy()}</p>
          </div>
        </section>

        {api.disconnectConnection && (
          <section className="section-block data-controls" aria-labelledby="account-brokerages">
            <h2 id="account-brokerages">Connected brokerages</h2>
            {connections.status === "loading" && <p className="data-controls-copy" role="status">Loading…</p>}
            {connections.status === "error" && <p className="data-controls-copy" role="alert">{connections.message}</p>}
            {connections.status === "ready" && connections.items.length === 0 && <p className="data-controls-copy">No brokerage is connected.</p>}
            {connections.status === "ready" && connections.items.length > 0 && (
              <ul className="data-connection-list">
                {connections.items.map((connection) => {
                  const label = connection.brokerageName ?? connection.name ?? "Brokerage connection";
                  return (
                    <ConfirmRow
                      key={connection.id}
                      title={label}
                      detail={`${connection.readOnly ? "Read-only" : "Connected"}${connection.disabled ? ", needs repair" : ""}`}
                      actionLabel="Disconnect"
                      confirmLabel={`Disconnect ${label}`}
                      dialogLabel={`Confirm disconnecting ${label}`}
                      explanation="This asks SnapTrade to remove the connection and deletes its accounts, snapshots and history here. You can connect again later."
                      onConfirm={async () => {
                        await api.disconnectConnection!(connection.id);
                        setConnectionsKey((key) => key + 1);
                      }}
                    />
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {api.revokeAiApp && (
          <section className="section-block data-controls" aria-labelledby="account-apps">
            <h2 id="account-apps">Connected AI apps</h2>
            {apps.status === "loading" && <p className="data-controls-copy" role="status">Loading…</p>}
            {apps.status === "error" && <p className="data-controls-copy" role="alert">{apps.message}</p>}
            {apps.status === "ready" && apps.items.length === 0 && <p className="data-controls-copy">No AI app is connected.</p>}
            {apps.status === "ready" && apps.items.length > 0 && (
              <ul className="data-connection-list">
                {apps.items.map((app) => (
                  <ConfirmRow
                    key={app.clientKey}
                    title={app.name}
                    detail={`${app.host}, connected ${formatDate(app.grantedAt)}`}
                    actionLabel="Revoke"
                    confirmLabel="Revoke access"
                    dialogLabel={`Confirm revoking ${app.name}`}
                    explanation="This app will be signed out of VestLens and will no longer be able to read your portfolio. Your data in VestLens and at your brokerage is not changed. You can connect it again later."
                    onConfirm={async () => {
                      await api.revokeAiApp!(app.clientKey);
                      setAppsKey((key) => key + 1);
                    }}
                  />
                ))}
              </ul>
            )}
          </section>
        )}

        {api.getMemory && <MemorySection api={api} />}

        {api.exportMyData && (
          <section className="section-block data-controls" aria-labelledby="account-export">
            <h2 id="account-export">Download my data</h2>
            <p className="data-controls-copy">A JSON file with everything VestLens stores for you.</p>
            <button type="button" className="secondary-button" disabled={exporting} onClick={() => void download()}>
              {exporting ? <Loader2 className="spin" size={16} /> : <Download size={16} />} Download my data
            </button>
            {exportError && <p className="data-controls-error" role="alert">{exportError}</p>}
          </section>
        )}
      </main>
    </div>
  );
}
