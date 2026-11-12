import { useCallback, useMemo, useEffect, useState, type ReactNode } from "react";
import { Loader2, Pencil, Trash2 } from "lucide-react";

import {
  FixedMessageError,
  type GoalView, type LimitRowView, type LimitView, type NudgeView, type ThesisConditionView,
  type ThesisFullView, type ThesisPlayedOutView, type ThesisSummaryView,
} from "./apiErrors";
import type { PortfolioApiClient } from "./App";
import { AppHeader } from "./AppHeader";
import { dollars, estLabel } from "./roomFormat";

/**
 * The Plans page: the user's own theses, limits and goals checked against their stored positions. Every string here
 * comes from the user, an assistant or the API and renders as text only, never as HTML or a link. Section errors are
 * fixed lines; edits and deletes go through the memory routes. Facts only: no verdicts, no advice.
 */

const GENERIC_ERROR = "The request did not finish. Please try again.";
const fixedMessage = (cause: unknown): string => (cause instanceof FixedMessageError ? cause.message : GENERIC_ERROR);

type Load<T> = { status: "loading" } | { status: "error" } | { status: "ready"; items: T };

function useSection<T>(loader: (() => Promise<T>) | undefined, reloadKey: number): Load<T> {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  useEffect(() => {
    if (!loader) return;
    let active = true;
    loader().then(
      (items) => { if (active) setState({ status: "ready", items }); },
      () => { if (active) setState({ status: "error" }); },
    );
    return () => { active = false; };
  }, [loader, reloadKey]);
  return state;
}

const formatPct = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));
const pct1 = (n: number) => `${(Math.round(n * 10) / 10).toFixed(1)}%`;
const signedPts = (n: number) => `${n >= 0 ? "+" : ""}${(Math.round(n * 10) / 10).toFixed(1)} pts`;
const sentence = (s: string) => (s.length === 0 ? s : `${s[0]!.toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? "" : "."}`);
const clampPct = (n: number) => Math.min(100, Math.max(0, n));

interface Field {
  id: string;
  label: string;
  type: "number" | "date" | "select";
  options?: Array<{ value: string; label: string }>;
  initial: string;
  valid(value: string, all: Record<string, string>): boolean;
  showWhen?(all: Record<string, string>): boolean;
}

/** Edit and delete for one entry through the typed routes: values only; the server derives the text. Delete has a confirm. */
function PlanActions({ fields, submit, remove, deleteLabel, deleteExplanation, onChanged }: {
  /** Absent when the client can't edit (or the thesis's reasons, which only the assistant changes). */
  fields: Field[];
  submit?(values: Record<string, string>): Promise<unknown>;
  remove?(): Promise<unknown>;
  deleteLabel: string;
  deleteExplanation: string;
  onChanged(): void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const initial = () => Object.fromEntries(fields.map((f) => [f.id, f.initial]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMode("view");
      onChanged();
    } catch (cause) {
      setError(fixedMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const valid = fields.every((f) => f.valid(values[f.id] ?? "", values));
  const shown = (f: Field) => !f.showWhen || f.showWhen(values);
  return (
    <div className="plan-actions">
      {mode === "view" && (
        <div className="memory-actions">
          {submit && (
            <button type="button" className="secondary-button" onClick={() => { setValues(initial()); setError(null); setMode("edit"); }}>
              <Pencil size={16} /> Edit
            </button>
          )}
          {remove && (
            <button type="button" className="secondary-button danger-outline" onClick={() => { setError(null); setMode("delete"); }}>
              <Trash2 size={16} /> Delete
            </button>
          )}
        </div>
      )}
      {mode === "edit" && submit && (
        <div className="confirm-panel memory-edit">
          {fields.filter(shown).map((f) => (
            <label key={f.id}>
              <span>{f.label}</span>
              {f.type === "select"
                ? (
                  <select value={values[f.id] ?? ""} disabled={busy} onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}>
                    {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                )
                : <input type={f.type} {...(f.type === "number" ? { step: "any", inputMode: "decimal" as const } : {})} value={values[f.id] ?? ""} disabled={busy} onChange={(e) => setValues({ ...values, [f.id]: e.target.value })} />}
            </label>
          ))}
          <div className="confirm-actions">
            <button type="button" className="primary-button" disabled={busy || !valid} onClick={() => void run(() => submit(values))}>
              {busy ? <Loader2 className="spin" size={16} /> : null} Save
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => { setMode("view"); setError(null); }}>Cancel</button>
          </div>
        </div>
      )}
      {mode === "delete" && remove && (
        <div className="confirm-panel" role="alertdialog" aria-label={`Confirm deleting ${deleteLabel}`}>
          <p>{deleteExplanation}</p>
          <div className="confirm-actions">
            <button type="button" className="danger-button" disabled={busy} onClick={() => void run(remove)}>
              {busy ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />} Delete {deleteLabel}
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => { setMode("view"); setError(null); }}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="data-controls-error" role="alert">{error}</p>}
    </div>
  );
}

const STATUS_WORD: Record<ThesisConditionView["status"], string> = { held: "held", broken: "broken", cant_tell: "can't tell" };

function ConditionChips({ ticker, conditions }: { ticker: string; conditions: ThesisConditionView[] }) {
  if (conditions.length === 0) return <p className="data-controls-copy">No conditions saved.</p>;
  return (
    <ul className="plan-chips" aria-label={`Conditions for ${ticker}`}>
      {conditions.map((c) => (
        <li key={c.id} className={`plan-chip ${c.status}`}>
          <span>{`${c.text}: ${STATUS_WORD[c.status]}`}</span>
          {c.evidence && <small>{`${c.evidence.value}, ${c.evidence.asOf}`}</small>}
          {c.note && <small>{c.note}</small>}
        </li>
      ))}
    </ul>
  );
}

function PlayedOut({ p }: { p: ThesisPlayedOutView }) {
  let headline: string;
  if (p.returnPct !== null) {
    const vs = [
      p.vsSp500Pct !== null ? `${signedPts(p.vsSp500Pct)} vs the same money in the S&P 500` : null,
      p.vsTsxPct !== null ? `${signedPts(p.vsTsxPct)} vs the TSX` : null,
    ].filter(Boolean);
    headline = `How it played out (${p.startDate} to ${p.endDate}${p.estimated ? ", est." : ""}): your return ${pct1(p.returnPct)}${vs.length > 0 ? `; ${vs.join("; ")}` : ""}.`;
  } else {
    headline = `How it played out: ${p.reason ?? "no comparison"}.`;
  }
  return (
    <div className="plan-played-out">
      <p>{headline}</p>
      {p.excluded.length > 0 && <p>{`Left out: ${p.excluded.join("; ")}.`}</p>}
      {p.notes.map((note, index) => <p key={index}>{note}</p>)}
    </div>
  );
}

function FullCheck({ full }: { full: ThesisFullView }) {
  const { check } = full.thesis;
  return (
    <div className="plan-full" aria-label={`Full check for ${full.ticker}`}>
      <PlayedOut p={check.playedOut} />
      {check.news.length > 0 ? (
        <>
          <p className="plan-sub">News since you wrote it:</p>
          <ul className="plan-news">
            {check.news.map((n, index) => <li key={index}>{`${n.publishedAt.slice(0, 10)} ${n.title} (${n.source}${n.tone ? `; ${n.tone}` : ""})`}</li>)}
          </ul>
        </>
      ) : <p>No news found since you wrote it.</p>}
      {check.earnings.length > 0 && <p>{`Earnings report dates since then: ${check.earnings.map((e) => e.date).join(", ")}.`}</p>}
    </div>
  );
}

function ThesisCard({ thesis, api, onChanged }: { thesis: ThesisSummaryView; api: PortfolioApiClient; onChanged(): void }) {
  const [full, setFull] = useState<{ status: "idle" } | { status: "loading" } | { status: "error" } | { status: "ready"; view: ThesisFullView }>({ status: "idle" });
  const openFull = () => {
    if (!api.getThesis) return;
    setFull({ status: "loading" });
    api.getThesis(thesis.ticker).then((view) => setFull({ status: "ready", view }), () => setFull({ status: "error" }));
  };
  return (
    <li className="plan-card">
      <h3>{thesis.ticker}</h3>
      <p className="plan-meta">{`Written ${thesis.writtenAt.slice(0, 10)}, ${thesis.timeFrame?.label ?? "no time frame"}${thesis.boughtAround ? `, bought around ${thesis.boughtAround}` : ""}`}</p>
      <p className="plan-reasons">{thesis.reasons}</p>
      <p className="plan-note">To change your reasons, tell your assistant; that starts a new thesis.</p>
      {/* Once the full check is open, its conditions (return included) replace the quick pass's (I-3). */}
      <ConditionChips ticker={thesis.ticker} conditions={full.status === "ready" ? full.view.thesis.check.conditions : thesis.conditions} />
      {full.status === "ready" ? <FullCheck full={full.view} /> : <PlayedOut p={thesis.playedOut} />}
      {api.getThesis && full.status !== "ready" && (
        <button type="button" className="secondary-button" disabled={full.status === "loading"} onClick={openFull}>
          {full.status === "loading" ? <Loader2 className="spin" size={16} /> : null} Open full check
        </button>
      )}
      {full.status === "error" && <p className="data-controls-error" role="alert">The full check is unavailable right now.</p>}
      <PlanActions
        onChanged={onChanged}
        fields={[
          { id: "frame", label: "Time frame", type: "select", initial: "keep", valid: () => true, options: [
            { value: "keep", label: "Keep as is" }, { value: "none", label: "No time frame" },
            { value: "short", label: "Short-term (end date)" }, { value: "long", label: "Long-term (years)" },
          ] },
          { id: "endDate", label: "End date", type: "date", initial: "", showWhen: (a) => a.frame === "short", valid: (v, a) => a.frame !== "short" || /^\d{4}-\d{2}-\d{2}$/.test(v) },
          { id: "years", label: "Years", type: "number", initial: "", showWhen: (a) => a.frame === "long", valid: (v, a) => a.frame !== "long" || (v.trim() !== "" && Number(v) > 0) },
        ]}
        submit={api.editThesis ? (v) => api.editThesis!(thesis.ticker, {
          timeFrame: v.frame === "none" ? null : v.frame === "short" ? { kind: "short", endDate: v.endDate! } : v.frame === "long" ? { kind: "long", years: Number(v.years) } : undefined,
        }) : undefined}
        remove={api.deleteThesis ? () => api.deleteThesis!(thesis.ticker) : undefined}
        deleteLabel="thesis"
        deleteExplanation={`This removes your thesis on ${thesis.ticker} from what VestLens remembers, including its earlier wording. Your brokerage is not changed.`}
      />
    </li>
  );
}

function LimitRow({ limit, row }: { limit: LimitView; row: LimitRowView }) {
  // One listing of a company: the combined row above carries the status and the bar.
  if (row.informational) return <div className="plan-row"><p className="data-controls-copy">{row.line}</p></div>;
  return (
    <div className="plan-row">
      {row.currentPct !== null && (
        <div
          className={`plan-bar ${row.status}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.currentPct}
          aria-label={`${row.label} at ${formatPct(row.currentPct)}% against your ${formatPct(limit.maxPct)}% limit`}
        >
          <span style={{ width: `${clampPct(row.currentPct)}%` }} />
          <span className="plan-bar-max" style={{ left: `${clampPct(limit.maxPct)}%` }} aria-hidden="true" />
        </div>
      )}
      <p>{row.text}</p>
    </div>
  );
}

function LimitCard({ limit, api, onChanged }: { limit: LimitView; api: PortfolioApiClient; onChanged(): void }) {
  return (
    <li className="plan-card">
      <h3>{`${formatPct(limit.maxPct)}% limit on ${limit.label}`}</h3>
      {limit.rows.length === 0 && <p className="data-controls-copy">Nothing to measure yet.</p>}
      {limit.rows.map((row, index) => <LimitRow key={index} limit={limit} row={row} />)}
      <PlanActions
        onChanged={onChanged}
        fields={[{ id: "maxPct", label: "Maximum share (%)", type: "number", initial: String(limit.maxPct), valid: (v) => v.trim() !== "" && Number(v) >= 0 && Number(v) <= 100 }]}
        submit={api.editLimit ? (v) => api.editLimit!(limit.slug, { maxPct: Number(v.maxPct) }) : undefined}
        remove={api.deleteLimit ? () => api.deleteLimit!(limit.slug) : undefined}
        deleteLabel="limit"
        deleteExplanation={`This removes your ${formatPct(limit.maxPct)}% limit on ${limit.label} from what VestLens remembers, including its earlier wording. Your brokerage is not changed.`}
      />
    </li>
  );
}

const monthsText = (n: number) => { const whole = Math.floor(n); return whole === 1 ? "1 month" : `${whole} months`; };

function GoalLines({ g }: { g: GoalView }) {
  const est = estLabel(g.estimated, g.savedFxDate);
  const paceEst = estLabel(g.paceEstimated, g.paceFxDate);
  const rateDates = [g.savedFxDate, g.paceFxDate].filter((d): d is string => d !== null).sort();
  const proj = estLabel(g.estimated || g.paceEstimated, rateDates[rateDates.length - 1] ?? null);
  const lines: string[] = [];
  lines.push(g.savedCad === null
    ? "Saved so far: can't tell (see the notes)."
    : g.savedAtLeast
    ? `Saved so far: at least ${dollars(g.savedCad)}${est}; an account's value is unknown (see the notes), so there is no percentage of the target.`
    : `Saved so far: about ${dollars(g.savedCad)}${est}, ${Math.round(g.savedPct ?? 0)}% of the target.`);
  lines.push(g.dateStatus === "passed" ? "Time left: target date passed." : g.dateStatus === "under_month" ? "Time left: less than a month left." : `Time left: ${monthsText(g.monthsLeft)}.`);
  if (g.remainingCad === 0) lines.push("What it takes: target reached.");
  else if (g.neededPerMonthFlatCad !== null) lines.push(`What it takes: about ${dollars(g.neededPerMonthFlatCad)}${est} a month from here reaches the target if values stay flat.`);
  else if (g.remainingCad !== null) lines.push(`What it takes: about ${dollars(g.remainingCad)}${est} still to go.`);
  if (g.recentPacePerMonthCad !== null) {
    const pace = `Recent pace: about ${dollars(g.recentPacePerMonthCad)}${paceEst} a month in net contributions ${g.paceSince ? `since ${g.paceSince}` : "over the last 6 months"}`;
    lines.push(g.projectedAtPaceCad !== null ? `${pace}; at that pace, about ${dollars(g.projectedAtPaceCad)}${proj} by ${g.targetDate} with no growth.` : `${pace}.`);
  } else {
    lines.push("Recent pace: can't tell (see the notes).");
  }
  if (g.growthRatePct !== null && g.projectedWithRateCad !== null) {
    lines.push(`With your ${formatPct(g.growthRatePct)}% yearly growth rate (your assumption): about ${dollars(g.projectedWithRateCad)}${proj} by ${g.targetDate}.`);
  }
  return (
    <>
      {lines.map((line, index) => <p key={index}>{line}</p>)}
      {g.notes.map((note, index) => <p key={`n${index}`} className="plan-note">{sentence(note)}</p>)}
    </>
  );
}

function GoalCard({ goal, api, onChanged }: { goal: GoalView; api: PortfolioApiClient; onChanged(): void }) {
  return (
    <li className="plan-card">
      <h3>{goal.name}</h3>
      <p className="plan-meta">{`${dollars(goal.targetCad)} by ${goal.targetDate}`}</p>
      {goal.savedCad !== null && goal.savedPct !== null && (
        <div
          className="plan-bar goal" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={goal.savedPct}
          aria-label={`${goal.name}: ${Math.round(goal.savedPct)}% of the target`}
        >
          <span style={{ width: `${clampPct(goal.savedPct)}%` }} />
        </div>
      )}
      <GoalLines g={goal} />
      <PlanActions
        onChanged={onChanged}
        fields={[
          { id: "targetCad", label: "Target amount (CAD)", type: "number", initial: String(goal.targetCad), valid: (v) => v.trim() !== "" && Number(v) > 0 },
          { id: "targetDate", label: "Target date", type: "date", initial: goal.targetDate, valid: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) },
          { id: "growthRatePct", label: "Yearly growth rate (%), optional", type: "number", initial: goal.growthRatePct === null ? "" : String(goal.growthRatePct), valid: (v) => v.trim() === "" || (Number(v) >= 0 && Number(v) <= 20) },
        ]}
        submit={api.editGoal ? (v) => api.editGoal!(goal.slug, {
          targetCad: Number(v.targetCad), targetDate: v.targetDate!, growthRatePct: v.growthRatePct!.trim() === "" ? null : Number(v.growthRatePct),
        }) : undefined}
        remove={api.deleteGoal ? () => api.deleteGoal!(goal.slug) : undefined}
        deleteLabel="goal"
        deleteExplanation={`This removes your goal ${goal.name} from what VestLens remembers, including its earlier wording. Your brokerage is not changed.`}
      />
    </li>
  );
}

function PlanSection<T>({ id, title, intro, state, errorText, emptyText, children }: {
  id: string; title: string; intro: string; state: Load<T[]>; errorText: string; emptyText: string; children(items: T[]): ReactNode;
}) {
  return (
    <section className="section-block data-controls" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <p className="data-controls-copy">{intro}</p>
      {state.status === "loading" && <p className="data-controls-copy" role="status">Loading…</p>}
      {state.status === "error" && <p className="data-controls-copy" role="alert">{errorText}</p>}
      {state.status === "ready" && state.items.length === 0 && <p className="data-controls-copy">{emptyText}</p>}
      {state.status === "ready" && state.items.length > 0 && <ul className="plan-list">{children(state.items)}</ul>}
    </section>
  );
}

export function PlansPage({ api, onBack, onSignOut }: { api: PortfolioApiClient; onBack(): void; onSignOut(): void }) {
  const [key, setKey] = useState(0);
  const reload = useCallback(() => setKey((n) => n + 1), []);
  const { getTheses, getLimits, getGoals } = api;
  const loadTheses = useMemo(() => getTheses && (async () => (await getTheses()).theses), [getTheses]);
  const loadLimits = useMemo(() => getLimits && (async () => (await getLimits()).limits), [getLimits]);
  const loadGoals = useMemo(() => getGoals && (async () => (await getGoals()).goals), [getGoals]);
  const theses = useSection<ThesisSummaryView[]>(loadTheses, key);
  const limits = useSection<LimitView[]>(loadLimits, key);
  const goals = useSection<GoalView[]>(loadGoals, key);
  return (
    <div className="app-shell">
      <AppHeader>
        <button type="button" className="topbar-link" onClick={onBack}>Back</button>
        <button type="button" className="topbar-link" onClick={onSignOut}>Sign out</button>
      </AppHeader>
      <main className="dashboard account-page plans-page">
        <section className="dashboard-heading">
          <div>
            <h1>Plans</h1>
            <p className="data-controls-copy">
              Your theses, limits and goals, checked against your latest stored positions. These are facts, not advice, and nothing here
              changes your brokerage.
            </p>
          </div>
        </section>

        {api.getTheses && (
          <PlanSection
            id="plans-theses" title="Your theses" state={theses}
            intro="Why you hold something, and whether the conditions you set still hold."
            errorText="Your theses are unavailable right now."
            emptyText="No theses saved yet. When you tell a connected assistant why you bought or hold something, it can save the thesis here."
          >
            {(items) => items.map((t) => <ThesisCard key={t.ticker} thesis={t} api={api} onChanged={reload} />)}
          </PlanSection>
        )}

        {api.getLimits && (
          <PlanSection
            id="plans-limits" title="Your limits" state={limits}
            intro="The most you want in one holding, sector or asset class, against where you are now."
            errorText="Your limits are unavailable right now."
            emptyText="No limits saved yet. When you tell a connected assistant a limit, like no more than 10% in one stock, it can save it here."
          >
            {(items) => items.map((l) => <LimitCard key={l.slug} limit={l} api={api} onChanged={reload} />)}
          </PlanSection>
        )}

        {api.getGoals && (
          <PlanSection
            id="plans-goals" title="Your goals" state={goals}
            intro="Savings targets, your pace so far, and where that pace leads."
            errorText="Your goals are unavailable right now."
            emptyText="No goals saved yet. When you describe a savings goal to a connected assistant, it can save it here."
          >
            {(items) => items.map((g) => <GoalCard key={g.slug} goal={g} api={api} onChanged={reload} />)}
          </PlanSection>
        )}
      </main>
    </div>
  );
}

export type NudgeState = { status: "loading" } | { status: "error" } | { status: "ready"; nudges: NudgeView[] };

/** Open thesis-condition and limit alerts as VestLens stored them; shown under the TFSA alert. Nothing when there are none. */
export function NudgeBanner({ state }: { state: NudgeState }) {
  if (state.status !== "ready" || state.nudges.length === 0) return null;
  return (
    <div className="warning-banner nudge-banner" role="status" data-testid="nudge-banner">
      {state.nudges.map((n, index) => <p key={`${n.kind}:${n.target}:${index}`}>{n.text}</p>)}
    </div>
  );
}
