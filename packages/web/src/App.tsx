import { useEffect, useMemo, useState } from "react";
import { AccountPage, downloadBlob } from "./AccountPage";
import { FixedMessageError, type AiApp, type FhsaRoomView, type RrspRoomView, type MemoryFactView, type MemoryGroupView, type RoomOutsideEntry, type TfsaRoomView, type ThesisSummaryView, type ThesisFullView, type LimitView, type GoalView, type NudgeView } from "./apiErrors";
import { NudgeBanner, PlansPage, type NudgeState } from "./PortfolioPlans";
import { ReportCardPage, type ReportCardView } from "./ReportCard";
import { PerformancePanel } from "./PerformancePanel";
import { FhsaSetup } from "./FhsaSetup";
import { RoomPage, type RoomProgram } from "./RoomPage";
import { RoomSetup } from "./RoomSetup";
import { RrspSetup } from "./RrspSetup";
import { TfsaOverLimitBanner, TfsaRoomTile, type TfsaRoomState } from "./TfsaRoomTile";
import { LensMark } from "./LensMark";
import { apiFetch, signIn as goToSignIn, signOut, useOwnerSession } from "./session";
import { pricesAsOf } from "./pricesAsOf";
import { ReadOnlyLock } from "./AppHeader";
import {
  Building2,
  CheckCircle2,
  Clock3,
  Link2,
  Loader2,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

export interface PortfolioPosition {
  instrumentId: string;
  kind: string;
  symbol: string;
  description: string | null;
  units: number | null;
  price: number | null;
  costBasis: number | null;
  marketValue: number | null;
  unrealizedGain: number | null;
  currency: string | null;
  cashEquivalent: boolean;
}

export type PortfolioAccountGroup =
  | "registered"
  | "non_registered"
  | "digital_assets"
  | "credit_products"
  | "closed"
  | "other";

export type PortfolioAccountBucket =
  | "tfsa"
  | "fhsa"
  | "rrsp"
  | "margin"
  | "automated_portfolio"
  | "custom_portfolio"
  | "predictions"
  | "money_market"
  | "crypto"
  | "credit_card"
  | "line_of_credit"
  | "other";

/**
 * Managed portfolios the total leaves out: SnapTrade reports no value (or zero) for Wealthsimple's managed accounts.
 * The API's managedNotInTotal (portfolio-presentation.ts) applies the same rule to the chat text.
 */
export function managedNotInTotal(accounts: PortfolioAccount[]): string[] {
  return [...new Set(accounts
    .filter((a) => a.classification.includedInPortfolioTotal && (a.unifiedType ?? "").toUpperCase().startsWith("MANAGED_") && !(a.value && a.value.amount !== 0))
    .map((a) => a.classification.label))];
}

/** Other counted accounts with no brokerage total: the total above leaves them out (the chat widgets value them from holdings). */
export function unreportedNotInTotal(accounts: PortfolioAccount[]): string[] {
  const managed = new Set(managedNotInTotal(accounts));
  return [...new Set(accounts.filter((a) => a.classification.includedInPortfolioTotal && !a.value && !managed.has(a.classification.label)).map((a) => a.name || a.classification.label))];
}

export const notInTotalNote = (labels: string[]) =>
  `Not included: ${labels.join(", ")}. SnapTrade doesn't provide the value of Wealthsimple managed portfolios, so this total leaves them out; their value is in the Wealthsimple app.`;

export interface PortfolioAccount {
  id: string;
  name: string;
  institution: string;
  rawType: string | null;
  metaType: string | null;
  unifiedType: string | null;
  status: string | null;
  isPaper: boolean;
  classification: {
    group: PortfolioAccountGroup;
    groupLabel: string;
    bucket: PortfolioAccountBucket;
    bucketLabel: string;
    label: string;
    includedInPortfolioTotal: boolean;
    isClosed: boolean;
  };
  value: {
    amount: number;
    currency: string;
    source: "brokerage_reported";
  } | null;
  balances: Array<{
    currency: string;
    cash: number | null;
    buyingPower: number | null;
  }>;
  positions: PortfolioPosition[];
  positionCount: number;
  reconciliation: {
    calculatedByCurrency: Array<{ currency: string; amount: number }>;
  };
  freshness: {
    positionsAsOf: string | null;
    holdingsLastSyncedAt: string | null;
    initialSyncCompleted: boolean;
    holdingsUnavailable: boolean;
  };
  warnings: string[];
}

/** GET /api/performance (packages/api/src/http/performance-route.ts). */
export interface DashboardPerformance {
  period: string;
  periods: string[];
  span: { start: string; end: string; partial: boolean; since?: string };
  asOf: string;
  currency: string;
  estimated: boolean;
  /** label: the name with its basis ("S&P 500 (total return)"); absent on older responses. */
  benchmark: { key: string; name: string; label?: string; basis?: string; note: string | null; unavailableReason: string | null };
  benchmarks: Array<{ key: string; name: string }>;
  figures: Record<"investmentReturn" | "benchmarkReturn" | "netDeposits" | "marketGain" | "valueChange", { value: number | null; estimated: boolean }> & {
    /** Money-weighted, and the same money in the index (start value and every flow replayed into it); absent on older responses. */
    personalReturn?: { value: number | null; estimated: boolean; annualised: boolean };
    matchedBenchmarkReturn?: { value: number | null; estimated: boolean; annualised: boolean; exhausted?: boolean };
    matchedBenchmarkValue?: { value: number | null; estimated: boolean };
  };
  series: { you: Array<{ date: string; value: number }>; benchmark: Array<{ date: string; value: number }> };
  /** Put in, taken out (negative) and per account; they add up to figures.netDeposits. leftOut: Cash accounts not counted. */
  deposits: {
    putIn: number; takenOut: number; estimated: boolean;
    byAccount: Array<{ accountId: string; label: string; name: string; bucket: string; value: { amount: number; currency: string } | null; putIn: number; takenOut: number }>;
    leftOut: string[];
  } | null;
  /** Accounts left out of every figure, named without amounts: managed portfolios, and gaps in value history this period. */
  notInFigures?: Array<{ accountId: string; label: string; name: string; reason: "managed" | "history_gaps" }>;
  /** Estimated because a USD account was converted to CAD. */
  fxEstimated?: boolean;
  /** Sentences for value steps SnapTrade's records don't explain, or null. */
  unrecordedNote?: string | null;
}

export interface PortfolioResponse {
  connectionRequired: boolean;
  /** The brokerage connection must be reconnected before accounts show. */
  relinkRequired?: true;
  generatedAt: string;
  totals: Array<{
    currency: string;
    amount: number;
    source: "brokerage_reported";
  }>;
  accounts: PortfolioAccount[];
  errors: Array<{
    accountId: string;
    code: "account_data_unavailable";
  }>;
  /** Combined total in CAD for a portfolio in more than one currency (USD at the Bank of Canada rate, est.). */
  homeTotal?: { currency: "CAD"; amount: number; estimated: boolean; rateDate: string | null; notConverted: Array<{ amount: number; currency: string }> };
}

export interface ConnectionHealth {
  id: string;
  name: string | null;
  brokerageSlug: string | null;
  brokerageName: string | null;
  readOnly: boolean;
  disabled: boolean;
  disabledAt: string | null;
  degraded: boolean;
  maintenance: boolean;
  dataFreshnessMode: string | null;
}

export { FixedMessageError } from "./apiErrors";

export interface PortfolioApiClient {
  getPortfolio(): Promise<PortfolioResponse>;
  /**
   * "Refresh now": asks the server to start one sync and snapshot run (it answers at once), then polls until the run
   * finishes. Resolves with the failure count; rejects with a fixed message (busy, rate limited, key rejected, failed).
   */
  refreshNow?(): Promise<{ failures: number } | void>;
  getConnections(): Promise<ConnectionHealth[]>;
  createConnectionSession(reconnect?: string): Promise<{ portalUrl: string }>;
  /** Revokes the connection at SnapTrade and removes its stored data here. */
  disconnectConnection?(connectionId: string): Promise<void>;
  /** Account page: connected AI apps, revoke and data export. */
  getAiApps?(): Promise<AiApp[]>;
  revokeAiApp?(clientKey: string): Promise<void>;
  exportMyData?(): Promise<{ blob: Blob; filename: string }>;
  /** Account page, "What VestLens remembers": current entries grouped by node type, a superseding edit, promote and delete. */
  getMemory?(): Promise<{ groups: MemoryGroupView[] }>;
  editMemory?(id: string, change: { text?: string; value?: unknown }): Promise<MemoryFactView>;
  promoteMemory?(id: string): Promise<MemoryFactView>;
  deleteMemory?(id: string): Promise<void>;
  /** Dashboard TFSA room tile and over-limit banner. */
  getTfsaRoom?(): Promise<TfsaRoomView>;
  /** Room page input writes; each answers with the same JSON as getTfsaRoom. */
  putRoomCra?(body: { year: number; amountCad: number }): Promise<TfsaRoomView>;
  putRoomAccounts?(body: { year: number; connected: string[]; notTfsa: string[]; outside: { label: string }[] }): Promise<TfsaRoomView>;
  putRoomOutsideMoves?(label: string, body: { year: number; entries: RoomOutsideEntry[] }): Promise<TfsaRoomView>;
  putRoomActivity?(activityKey: string, body: { effect: "contribution" | "withdrawal" | "none" }): Promise<TfsaRoomView>;
  /** Removes the stored answer for one transfer, so the automatic match (or the open question) applies again. */
  deleteRoomActivity?(activityKey: string): Promise<TfsaRoomView>;
  /** A managed TFSA's (or FHSA's) contributions this year as of a date, which SnapTrade doesn't show (review 6). */
  putRoomManagedFigure?(accountKey: string, body: { year: number; amountCad: number; asOf: string }): Promise<TfsaRoomView>;
  putFhsaManagedFigure?(accountKey: string, body: { year: number; amountCad: number; asOf: string }): Promise<FhsaRoomView>;
  /** The room page's FHSA tab ("none" without a broker-labelled FHSA) and its one setup write. */
  getFhsaRoom?(): Promise<FhsaRoomView>;
  putFhsaRoom?(body: { year: number; amountCad: number }): Promise<FhsaRoomView>;
  /** The FHSA tab's transfer answers (step 4): the same activity.room_effect as the TFSA's, through the FHSA routes. */
  putFhsaRoomActivity?(activityKey: string, body: { effect: "contribution" | "withdrawal" | "none" }): Promise<FhsaRoomView>;
  deleteFhsaRoomActivity?(activityKey: string): Promise<FhsaRoomView>;
  /** The room page's RRSP tab ("none" without a broker-labelled RRSP) and its setup writes for one tax year. */
  getRrspRoom?(): Promise<RrspRoomView>;
  putRrspLimit?(body: { year: number; amountCad: number; unusedCad?: number }): Promise<RrspRoomView>;
  putRrspElsewhere?(body: { year: number; amountCad: number }): Promise<RrspRoomView>;
  putRrspRoomActivity?(activityKey: string, body: { effect: "contribution" | "withdrawal" | "none" }): Promise<RrspRoomView>;
  deleteRrspRoomActivity?(activityKey: string): Promise<RrspRoomView>;
  /** Plans page and the nudge banner: the caller's theses, limits and goals as checked against stored positions. */
  getTheses?(): Promise<{ theses: ThesisSummaryView[] }>;
  getThesis?(ticker: string): Promise<ThesisFullView>;
  getLimits?(): Promise<{ limits: LimitView[] }>;
  getGoals?(): Promise<{ goals: GoalView[] }>;
  getNudges?(): Promise<{ nudges: NudgeView[] }>;
  /** The report card page (?view=report): calls against the market, sales since, and trading costs, from stored data. */
  getReportCard?(): Promise<ReportCardView>;
  /** The dashboard's return chart (GET /api/performance); null when nothing is linked yet. */
  getPerformance?(input: { period: string; benchmark?: string }): Promise<DashboardPerformance | null>;
  /** Plans page edits and deletes: values only; the server derives the saved wording and re-checks nudges. */
  editLimit?(slug: string, change: { maxPct: number }): Promise<void>;
  editGoal?(slug: string, change: { targetCad?: number; targetDate?: string; growthRatePct?: number | null }): Promise<void>;
  editThesis?(ticker: string, change: { timeFrame?: { kind: "short"; endDate: string } | { kind: "long"; years: number } | null }): Promise<void>;
  deleteLimit?(slug: string): Promise<void>;
  deleteGoal?(slug: string): Promise<void>;
  deleteThesis?(ticker: string): Promise<void>;
}

export interface PortfolioAuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
  userName: string | null;
  login(): Promise<void>;
  logout(): void;
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Shown whenever SnapTrade answers 401 or 403: a wrong or revoked key is the owner's to fix in `.env`. */
export const KEY_REJECTED_MESSAGE =
  "SnapTrade rejected your API key. Check SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY in your .env, then restart the app (for Docker: docker compose up -d).";

async function errorCode(response: Response): Promise<string | null> {
  const body = (await response.clone().json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : null;
}

export function createPortfolioApiClient(options: {
  fetchImpl?: FetchLike;
  /** Milliseconds between refresh status polls (tests pass 0). */
  pollIntervalMs?: number;
} = {}): PortfolioApiClient {
  // Every call rides the owner's session cookie (see session.ts); there is no bearer token on this side.
  const send = (path: string, init?: RequestInit): Promise<Response> =>
    apiFetch(path, init, options.fetchImpl);

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await send(path, init);

    if (!response.ok) {
      if (response.status === 502 && (await errorCode(response)) === "snaptrade_key_rejected") {
        throw new FixedMessageError(KEY_REJECTED_MESSAGE);
      }
      throw new FixedMessageError(
        response.status === 401
          ? "Your session has expired. Please sign in again."
          : "The portfolio service is temporarily unavailable.",
      );
    }

    return (await response.json()) as T;
  }

  async function remove(path: string, body?: unknown): Promise<void> {
    const response = await send(path, {
      method: "DELETE",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (response.ok) return;
    throw new FixedMessageError(
      response.status === 401
        ? "Your session has expired. Please sign in again."
        : response.status === 404
          ? "That connection was not found. It may already be disconnected."
          : response.status === 429
            ? "Too many disconnects are still being processed. Try again later."
            : response.status === 502
              ? "SnapTrade could not be reached, so nothing was removed. Please try again."
              : "The request did not finish. Part of it may already be done; trying again is safe and completes it.",
    );
  }

  async function revoke(clientKey: string): Promise<void> {
    const response = await send(`/api/ai-apps/${encodeURIComponent(clientKey)}/revoke`, { method: "POST" });
    if (response.ok) return;
    throw new FixedMessageError(
      response.status === 401
        ? "Your session has expired. Please sign in again."
        : response.status === 404
          ? "That app was not found. It may already be revoked."
          : "The app could not be revoked. Please try again.",
    );
  }

  async function exportData(): Promise<{ blob: Blob; filename: string }> {
    const response = await send("/api/account/export");
    if (!response.ok) {
      throw new FixedMessageError(
        response.status === 401
          ? "Your session has expired. Please sign in again."
          : "Your data could not be prepared. Please try again.",
      );
    }
    const name = /filename="?([^";]+)"?/i.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "";
    // The name comes from the server; keep only a plain file name.
    const filename = /^[A-Za-z0-9._-]{1,100}$/.test(name) && !name.includes("..") ? name : "vestlens-export.json";
    return { blob: await response.blob(), filename };
  }

  const REFRESH_FAILED = "The refresh did not finish. Please try again.";
  const REFRESH_BUSY = "A refresh is already running.";
  const REFRESH_LIMITED = "Try again in a minute.";
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  // The server's pipeline budget is 240 s; give up a little after that.
  const maxPolls = pollIntervalMs > 0 ? Math.ceil(300_000 / pollIntervalMs) : 1000;

  async function refreshNow(): Promise<{ failures: number }> {
    const response = await send("/api/refresh", { method: "POST" });
    if (response.status !== 202) {
      throw new FixedMessageError(
        response.status === 401 ? "Your session has expired. Please sign in again."
          : response.status === 409 ? REFRESH_BUSY
            : response.status === 429 ? REFRESH_LIMITED
              : REFRESH_FAILED,
      );
    }
    for (let poll = 0; poll < maxPolls; poll += 1) {
      if (pollIntervalMs > 0) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const status = await send("/api/refresh/status");
      if (!status.ok) {
        throw new FixedMessageError(status.status === 401 ? "Your session has expired. Please sign in again." : REFRESH_FAILED);
      }
      const body = (await status.json().catch(() => null)) as { state?: string; error?: string; failures?: number } | null;
      if (body?.state === "running") continue;
      if (body?.state === "succeeded") return { failures: typeof body.failures === "number" ? body.failures : 0 };
      throw new FixedMessageError(
        body?.error === "snaptrade_key_rejected" ? KEY_REJECTED_MESSAGE
          : body?.error === "busy" ? REFRESH_BUSY
            : body?.error === "rate_limited" ? REFRESH_LIMITED
              : REFRESH_FAILED,
      );
    }
    throw new FixedMessageError("The refresh is taking longer than expected. Reload in a few minutes to see what it stored.");
  }

  const SESSION_EXPIRED = "Your session has expired. Please sign in again.";
  /** Memory writes: fixed client messages only, never the server's. */
  async function memoryWrite<T>(path: string, init: RequestInit, saveFailed: string): Promise<T> {
    const response = await send(path, init);
    if (response.ok) return (response.status === 204 ? undefined : await response.json()) as T;
    if (response.status === 400) {
      const body = (await response.clone().json().catch(() => null)) as { error?: unknown } | null;
      if (body?.error === "use_plans_page") throw new FixedMessageError("Edit theses, limits and goals on the Plans page.");
    }
    throw new FixedMessageError(
      response.status === 401 ? SESSION_EXPIRED
        : response.status === 404 ? "That entry is no longer there."
          : response.status === 400 ? saveFailed
            : "The request did not finish. Please try again.",
    );
  }
  const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const itemPath = (id: string) => `/api/memory/${encodeURIComponent(id)}`;

  return {
    getMemory: () => request<{ groups: MemoryGroupView[] }>("/api/memory"),
    editMemory: (id, change) => memoryWrite<MemoryFactView>(itemPath(id), {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change),
    }, "That change could not be saved."),
    promoteMemory: (id) => memoryWrite<MemoryFactView>(`${itemPath(id)}/promote`, { method: "POST" }, "That entry can't be confirmed."),
    deleteMemory: (id) => memoryWrite<void>(itemPath(id), { method: "DELETE" }, "That entry could not be deleted."),
    getTfsaRoom: () => request<TfsaRoomView>("/api/room/tfsa"),
    putRoomCra: (body) => memoryWrite<TfsaRoomView>("/api/room/tfsa/cra-room", jsonInit("PUT", body), "That change could not be saved."),
    putRoomAccounts: (body) => memoryWrite<TfsaRoomView>("/api/room/tfsa/accounts", jsonInit("PUT", body), "That change could not be saved."),
    putRoomOutsideMoves: (label, body) => memoryWrite<TfsaRoomView>(`/api/room/tfsa/outside/${encodeURIComponent(label)}/moves`, jsonInit("PUT", body), "That change could not be saved."),
    putRoomActivity: (activityKey, body) => memoryWrite<TfsaRoomView>(`/api/room/tfsa/activities/${encodeURIComponent(activityKey)}`, jsonInit("PUT", body), "That change could not be saved."),
    deleteRoomActivity: (activityKey) => memoryWrite<TfsaRoomView>(`/api/room/tfsa/activities/${encodeURIComponent(activityKey)}`, { method: "DELETE" }, "That change could not be saved."),
    putRoomManagedFigure: (accountKey, body) => memoryWrite<TfsaRoomView>(`/api/room/tfsa/managed/${encodeURIComponent(accountKey)}`, jsonInit("PUT", body), "That change could not be saved."),
    putFhsaManagedFigure: (accountKey, body) => memoryWrite<FhsaRoomView>(`/api/room/fhsa/managed/${encodeURIComponent(accountKey)}`, jsonInit("PUT", body), "That change could not be saved."),
    getFhsaRoom: () => request<FhsaRoomView>("/api/room/fhsa"),
    putFhsaRoom: (body) => memoryWrite<FhsaRoomView>("/api/room/fhsa/participation-room", jsonInit("PUT", body), "That change could not be saved."),
    putFhsaRoomActivity: (activityKey, body) => memoryWrite<FhsaRoomView>(`/api/room/fhsa/activities/${encodeURIComponent(activityKey)}`, jsonInit("PUT", body), "That change could not be saved."),
    deleteFhsaRoomActivity: (activityKey) => memoryWrite<FhsaRoomView>(`/api/room/fhsa/activities/${encodeURIComponent(activityKey)}`, { method: "DELETE" }, "That change could not be saved."),
    getRrspRoom: () => request<RrspRoomView>("/api/room/rrsp"),
    putRrspLimit: (body) => memoryWrite<RrspRoomView>("/api/room/rrsp/deduction-limit", jsonInit("PUT", body), "That change could not be saved."),
    putRrspElsewhere: (body) => memoryWrite<RrspRoomView>("/api/room/rrsp/elsewhere", jsonInit("PUT", body), "That change could not be saved."),
    putRrspRoomActivity: (activityKey, body) => memoryWrite<RrspRoomView>(`/api/room/rrsp/activities/${encodeURIComponent(activityKey)}`, jsonInit("PUT", body), "That change could not be saved."),
    deleteRrspRoomActivity: (activityKey) => memoryWrite<RrspRoomView>(`/api/room/rrsp/activities/${encodeURIComponent(activityKey)}`, { method: "DELETE" }, "That change could not be saved."),
    getTheses: () => request<{ theses: ThesisSummaryView[] }>("/api/theses"),
    getThesis: (ticker) => request<ThesisFullView>(`/api/theses/${encodeURIComponent(ticker)}`),
    getLimits: () => request<{ limits: LimitView[] }>("/api/limits"),
    getGoals: () => request<{ goals: GoalView[] }>("/api/goals"),
    getNudges: () => request<{ nudges: NudgeView[] }>("/api/nudges"),
    getReportCard: () => request<ReportCardView>("/api/report-card"),
    getPerformance: async ({ period, benchmark }) => {
      const query = new URLSearchParams({ period, ...(benchmark ? { benchmark } : {}) });
      const response = await send(`/api/performance?${query}`);
      if (response.status === 409) return null;
      if (!response.ok) throw new FixedMessageError("The portfolio service is temporarily unavailable.");
      return (await response.json()) as DashboardPerformance;
    },
    editLimit: (slug, change) => memoryWrite<void>(`/api/limits/${encodeURIComponent(slug)}`, jsonInit("PATCH", change), "That change could not be saved."),
    editGoal: (slug, change) => memoryWrite<void>(`/api/goals/${encodeURIComponent(slug)}`, jsonInit("PATCH", change), "That change could not be saved."),
    editThesis: (ticker, change) => memoryWrite<void>(`/api/theses/${encodeURIComponent(ticker)}`, jsonInit("PATCH", change), "That change could not be saved."),
    deleteLimit: (slug) => memoryWrite<void>(`/api/limits/${encodeURIComponent(slug)}`, { method: "DELETE" }, "That entry could not be deleted."),
    deleteGoal: (slug) => memoryWrite<void>(`/api/goals/${encodeURIComponent(slug)}`, { method: "DELETE" }, "That entry could not be deleted."),
    deleteThesis: (ticker) => memoryWrite<void>(`/api/theses/${encodeURIComponent(ticker)}`, { method: "DELETE" }, "That entry could not be deleted."),
    getAiApps: () => request<AiApp[]>("/api/ai-apps"),
    revokeAiApp: revoke,
    exportMyData: exportData,
    getPortfolio: () => request<PortfolioResponse>("/api/portfolio"),
    refreshNow,
    getConnections: () => request<ConnectionHealth[]>("/api/connections"),
    createConnectionSession: (reconnect) =>
      request<{ portalUrl: string }>(
        "/api/connections/session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reconnect ? { reconnect } : {}),
        },
      ),
    disconnectConnection: (connectionId) =>
      remove(`/api/connections/${encodeURIComponent(connectionId)}`),
  };
}

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

const GROUP_LAYOUT: Array<{
  id: Exclude<PortfolioAccountGroup, "closed">;
  label: string;
  kicker: string;
}> = [
  { id: "registered", label: "Registered", kicker: "Tax-advantaged" },
  {
    id: "non_registered",
    label: "Non-registered",
    kicker: "Taxable and cash",
  },
  { id: "digital_assets", label: "Digital assets", kicker: "Crypto" },
  { id: "other", label: "Other accounts", kicker: "Other" },
  {
    id: "credit_products",
    label: "Credit products",
    kicker: "Excluded from investment totals",
  },
];

function AccountCard({ account }: { account: PortfolioAccount }) {
  const cashBalances = account.balances.filter(
    (balance) => balance.cash !== null,
  );

  return (
    <article
      className="account-card"
      data-testid={`portfolio-account-${account.id}`}
    >
      <div className="account-icon"><Building2 size={19} /></div>
      <div className="account-card-copy">
        <div className="institution">{account.institution}</div>
        <h4>{account.classification.label}</h4>
        {account.name !== account.classification.label && <p>{account.name}</p>}
        <p>
          {account.positionCount} position
          {account.positionCount === 1 ? "" : "s"}
        </p>
      </div>
      <div className="account-value">
        <span>Brokerage value</span>
        <strong>
          {account.value
            ? formatCurrency(account.value.amount, account.value.currency)
            : "Unavailable"}
        </strong>
        {account.value && <small>{account.value.currency}</small>}
      </div>
      {cashBalances.length > 0 && (
        <dl className="account-cash-lines">
          {cashBalances.map((balance) => (
            <div key={balance.currency}>
              <dt>Cash {balance.currency}</dt>
              <dd>{formatCurrency(balance.cash!, balance.currency)}</dd>
            </div>
          ))}
        </dl>
      )}
      {account.warnings.length > 0 && (
        <ul className="account-warnings">
          {account.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function AccountBuckets({ accounts }: { accounts: PortfolioAccount[] }) {
  const buckets = Array.from(
    accounts.reduce((grouped, account) => {
      const existing = grouped.get(account.classification.bucket);
      if (existing) existing.push(account);
      else grouped.set(account.classification.bucket, [account]);
      return grouped;
    }, new Map<PortfolioAccountBucket, PortfolioAccount[]>()),
  );

  return (
    <div className="account-buckets">
      {buckets.map(([bucket, bucketAccounts]) => (
        <section
          className="account-bucket"
          data-testid={`portfolio-bucket-${bucket}`}
          key={bucket}
        >
          <div className="bucket-heading">
            <h3>{bucketAccounts[0].classification.bucketLabel}</h3>
            <span>{bucketAccounts.length}</span>
          </div>
          <div className="account-grid">
            {bucketAccounts.map((account) => (
              <AccountCard account={account} key={account.id} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function PortfolioExperience(props: {
  auth: PortfolioAuthState; api: PortfolioApiClient; openPortal?: (url: string) => void;
}) {
  const [view, setView] = useState<"home" | "account" | "plans" | "room" | "report">(() => {
    const requested = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("view") : null;
    // Deep links only: ?view=room opens the TFSA room, ?view=report the report card (no link from home yet).
    return requested === "room" ? "room" : requested === "report" ? "report" : "home";
  });
  // Within the room view: the setup (step 1) or the step an edit link names; each returns to the page. Null shows the page.
  // An RRSP setup is for the tax year of the block it was opened from: its figures (step 1) or one transfer (step 4).
  const [roomSetup, setRoomSetup] = useState<{ step: 1 | 2 | 3 | 4; activityKey?: string } | { fhsa: 1 | 4; activityKey?: string } | { rrsp: number; rrspStep: 1 | 4; activityKey?: string } | null>(null);
  // The room page's tab: the FHSA and RRSP setups return to their own tab.
  const [roomTab, setRoomTab] = useState<RoomProgram>("tfsa");
  if (view === "account" && props.auth.isAuthenticated && !props.auth.isLoading) {
    return (
      <AccountPage
        api={props.api}
        onBack={() => setView("home")}
        onSignOut={props.auth.logout}
        saveFile={downloadBlob}
      />
    );
  }
  return (
    <>
      {view === "room" && props.auth.isAuthenticated && !props.auth.isLoading
        ? roomSetup && "rrsp" in roomSetup
          ? <RrspSetup api={props.api} year={roomSetup.rrsp} step={roomSetup.rrspStep} activityKey={roomSetup.activityKey} onDone={() => setRoomSetup(null)} />
          : roomSetup && "fhsa" in roomSetup
          ? <FhsaSetup api={props.api} step={roomSetup.fhsa} activityKey={roomSetup.activityKey} onDone={() => setRoomSetup(null)} />
          : roomSetup
          ? <RoomSetup api={props.api} initialStep={roomSetup.step} activityKey={roomSetup.activityKey} onDone={() => { setRoomTab("tfsa"); setRoomSetup(null); }} />
          : <RoomPage api={props.api} onBack={() => setView("home")} initialTab={roomTab}
            onSetup={(step, activityKey) => setRoomSetup({ step, ...(activityKey ? { activityKey } : {}) })} onStartSetup={() => setRoomSetup({ step: 1 })}
            onFhsaSetup={(step, activityKey) => { setRoomTab("fhsa"); setRoomSetup({ fhsa: step, ...(activityKey ? { activityKey } : {}) }); }}
            onRrspSetup={(year, step = 1, activityKey) => { setRoomTab("rrsp"); setRoomSetup({ rrsp: year, rrspStep: step, ...(activityKey ? { activityKey } : {}) }); }} />
        : view === "report" && props.auth.isAuthenticated && !props.auth.isLoading
        ? <ReportCardPage api={props.api} onBack={() => setView("home")} />
        : view === "plans" && props.auth.isAuthenticated && !props.auth.isLoading
        ? <PlansPage api={props.api} onBack={() => setView("home")} onSignOut={props.auth.logout} />
        : <StandardPortfolioExperience {...props} onOpenAccount={() => setView("account")} onOpenPlans={() => setView("plans")} onOpenRoom={() => setView("room")} />}
    </>
  );
}

function StandardPortfolioExperience({
  auth,
  api,
  openPortal = (url) => window.location.assign(url),
  onOpenAccount,
  onOpenPlans,
  onOpenRoom,
}: {
  auth: PortfolioAuthState;
  api: PortfolioApiClient;
  openPortal?: (url: string) => void;
  onOpenAccount?: () => void;
  onOpenPlans?: () => void;
  onOpenRoom?: () => void;
}) {
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null);
  const [connections, setConnections] = useState<ConnectionHealth[]>([]);
  const [connectionsUnavailable, setConnectionsUnavailable] = useState(false);
  const [loadingPortfolio, setLoadingPortfolio] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [room, setRoom] = useState<TfsaRoomState>({ status: "loading" });
  const [nudges, setNudges] = useState<NudgeState>({ status: "loading" });

  const signIn = () => { if (!auth.isLoading) void auth.login(); };
  const refreshNow = api.refreshNow;
  const runRefresh = () => {
    if (!refreshNow || refreshing) return;
    setRefreshing(true);
    setRefreshNotice(null);
    refreshNow()
      .then((result) => {
        if (result && result.failures > 0) {
          setRefreshNotice("The refresh finished, but some data could not be updated. The server logs say which part.");
        }
        setReloadKey((key) => key + 1);
      })
      .catch((cause: unknown) => {
        const message = cause instanceof FixedMessageError ? cause.message : "The refresh did not finish. Please try again.";
        setRefreshNotice(message);
        // A rejected key also fails the portfolio read: reload so the dashboard states the cause instead of old numbers.
        if (message === KEY_REJECTED_MESSAGE) setReloadKey((key) => key + 1);
      })
      .finally(() => setRefreshing(false));
  };

  useEffect(() => {
    if (auth.isLoading || !auth.isAuthenticated) return;

    let active = true;
    setLoadingPortfolio(true);
    setError(null);
    // Connection health is advisory; it must not hide a portfolio that loaded.
    Promise.all([api.getPortfolio(), api.getConnections().catch(() => null)])
      .then(([nextPortfolio, nextConnections]) => {
        if (active) {
          setPortfolio(nextPortfolio);
          setConnections(nextConnections ?? []);
          setConnectionsUnavailable(nextConnections === null);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(
            cause instanceof Error
              ? cause.message
              : "The portfolio service is temporarily unavailable.",
          );
        }
      })
      .finally(() => {
        if (active) setLoadingPortfolio(false);
      });

    return () => {
      active = false;
    };
  }, [api, auth.isAuthenticated, auth.isLoading, reloadKey]);

  // The TFSA room tile and banner read stored inputs only and never hold the dashboard back: a failure is a fixed line.
  const { getTfsaRoom } = api;
  useEffect(() => {
    if (!getTfsaRoom || auth.isLoading || !auth.isAuthenticated) return;
    let active = true;
    setRoom({ status: "loading" });
    getTfsaRoom().then(
      (next) => { if (active) setRoom({ status: "ready", room: next }); },
      () => { if (active) setRoom({ status: "error" }); },
    );
    return () => { active = false; };
  }, [getTfsaRoom, auth.isAuthenticated, auth.isLoading, reloadKey]);

  // Open thesis and limit alerts, as stored: a failure shows nothing and never holds the dashboard back.
  const { getNudges } = api;
  useEffect(() => {
    if (!getNudges || auth.isLoading || !auth.isAuthenticated) return;
    let active = true;
    setNudges({ status: "loading" });
    getNudges().then(
      (next) => { if (active) setNudges({ status: "ready", nudges: next.nudges }); },
      () => { if (active) setNudges({ status: "error" }); },
    );
    return () => { active = false; };
  }, [getNudges, auth.isAuthenticated, auth.isLoading, reloadKey]);

  const connectBrokerage = async (reconnect?: string) => {
    setConnecting(true);
    setError(null);
    try {
      const { portalUrl } = await api.createConnectionSession(reconnect);
      openPortal(portalUrl);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to start the secure connection.",
      );
      setConnecting(false);
    }
  };

  const totals = portfolio?.totals ?? [];
  const syncedAt = portfolio ? pricesAsOf(portfolio.accounts) : null;
  const connectionNeedsAttention = connections.find(
    (connection) => connection.disabled || connection.maintenance,
  );
  const degradedConnection = connections.find(
    (connection) => connection.degraded,
  );
  const delayedConnection = connections.find(
    (connection) => connection.dataFreshnessMode === "delayed",
  );
  const positions =
    portfolio?.accounts
      .filter((account) => account.classification.includedInPortfolioTotal)
      .flatMap((account) =>
        account.positions.map((position) => ({
          ...position,
          accountName: account.classification.label,
        })),
      ) ?? [];
  const accountGroups = portfolio
    ? GROUP_LAYOUT.map((group) => ({
        ...group,
        accounts: portfolio.accounts.filter(
          (account) => account.classification.group === group.id,
        ),
      })).filter((group) => group.accounts.length > 0)
    : [];
  const closedAccounts =
    portfolio?.accounts.filter(
      (account) => account.classification.group === "closed",
    ) ?? [];

  return (
    <div className="app-shell">
      {!auth.isAuthenticated ? <header className="topbar vl-topbar">
        <a className="brand vl-brand" href="/" aria-label="VestLens home">
          <LensMark size={30} />
          <span>VestLens</span>
        </a>
        <div className="topbar-actions">
          {!auth.isLoading && <button type="button" className="vl-button vl-button-sm" onClick={signIn}>Sign in</button>}
        </div>
      </header> : <header className="topbar vl-topbar app-topbar">
        <a className="brand vl-brand" href="/" aria-label="VestLens home">
          <LensMark size={30} />
          <span>VestLens</span>
        </a>
        <div className="topbar-actions">
          <span className="read-only-label">
            <ReadOnlyLock /> Read-only
          </span>
          {auth.isAuthenticated && (
            <>
              {onOpenPlans && (api.getTheses || api.getLimits || api.getGoals) && (
                <button type="button" className="topbar-link" onClick={onOpenPlans}>Plans</button>
              )}
              {onOpenAccount && (
                <button type="button" className="topbar-link" onClick={onOpenAccount}>Account</button>
              )}
              <span className="user-name">{auth.userName ?? "Signed in"}</span>
              <button type="button" className="topbar-link" onClick={auth.logout}>Sign out</button>
            </>
          )}
        </div>
      </header>}

      {/* Signed out. While the session is checked (or the browser is on its way to the sign-in page) the loading
          state shows instead, and sign-in is ignored until the check finishes. */}
      {!auth.isAuthenticated && !auth.isLoading && (
        <main className="center-state">
          <h1>Your portfolio, read-only.</h1>
          <p>Sign in to see your accounts.</p>
        </main>
      )}

      {(auth.isLoading || (auth.isAuthenticated && loadingPortfolio && !portfolio)) && (
        <main className="center-state" aria-live="polite">
          <Loader2 className="spin" size={26} />
          <p>Opening your secure portfolio…</p>
        </main>
      )}

      {auth.isAuthenticated && error && !loadingPortfolio && (
        <main className="center-state error-state">
          <div className="state-icon"><RefreshCw size={22} /></div>
          <h1>We couldn’t load your portfolio.</h1>
          <p>{error}</p>
          <button className="secondary-button" onClick={() => setReloadKey((key) => key + 1)}>
            Try again
          </button>
        </main>
      )}

      {auth.isAuthenticated && portfolio?.connectionRequired && !error && (
        <main className="connection-layout">
          <section className="connection-card">
            <div className="state-icon"><Link2 size={23} /></div>
            <div className="eyebrow">One secure step</div>
            {portfolio.relinkRequired ? (
              <>
                <h1>Reconnect your brokerage</h1>
                <p>
                  Your SnapTrade connection needs to be reconnected, so no accounts are showing. Your settings, goals and
                  contribution room are still here. Reconnect and your accounts come back; you sign in to your
                  brokerage on SnapTrade&apos;s page, and VestLens never sees your password.
                </p>
              </>
            ) : (
              <>
                <h1>Connect your brokerage</h1>
                <p>
                  SnapTrade links your brokerage accounts to VestLens with read-only access. You sign in on
                  SnapTrade&apos;s page; VestLens never sees your password.
                </p>
              </>
            )}
            <button
              className="primary-button"
              onClick={() => void connectBrokerage()}
              disabled={connecting}
            >
              {connecting ? <><Loader2 className="spin" size={17} /> Opening SnapTrade…</> : <>Continue to SnapTrade</>}
            </button>
            <div className="permission-list">
              <span><CheckCircle2 size={15} /> View account balances</span>
              <span><CheckCircle2 size={15} /> View holdings and freshness</span>
              <span><LockKeyhole size={15} /> No orders, transfers, or recurring buys</span>
            </div>
          </section>
        </main>
      )}

      {auth.isAuthenticated && portfolio && !portfolio.connectionRequired && !error && (
        <main className="dashboard">
          <section className="dashboard-heading">
            <div>
              <div className="eyebrow"><ShieldCheck size={15} /> Live, read-only portfolio</div>
              <h1>Good to see you{auth.userName ? `, ${auth.userName.split(" ")[0]}` : ""}.</h1>
              <p>{portfolio.homeTotal
                ? "Your total in Canadian dollars, with each currency as your brokerage reports it."
                : "Your accounts as your brokerage reports them."}</p>
            </div>
            <div className="refresh-control">
              <button
                className="secondary-button"
                onClick={() => setReloadKey((key) => key + 1)}
                disabled={loadingPortfolio}
              >
                {loadingPortfolio ? (
                  <><Loader2 className="spin" size={16} /> Reloading…</>
                ) : (
                  <><RefreshCw size={16} /> Reload data</>
                )}
              </button>
              {refreshNow && (
                <button className="secondary-button" onClick={runRefresh} disabled={refreshing || loadingPortfolio}>
                  {refreshing ? (
                    <><Loader2 className="spin" size={16} /> Refreshing…</>
                  ) : (
                    <><RefreshCw size={16} /> Refresh now</>
                  )}
                </button>
              )}
              <span>
                Reload data shows what VestLens has stored; Refresh now asks your brokerage for a fresh sync.
              </span>
              {refreshNotice && <span role="status">{refreshNotice}</span>}
            </div>
          </section>

          {(connectionNeedsAttention || degradedConnection || delayedConnection) && (
            <section className="connection-health-card" role="status">
              <div className="connection-health-copy">
                <div className="section-kicker">Connection health</div>
                <h2>
                  {connectionNeedsAttention
                    ? "Connection needs attention"
                    : "Your brokerage's data may be delayed"}
                </h2>
                {connectionNeedsAttention && (
                  <p>
                    SnapTrade cannot currently retrieve fresh Wealthsimple data.
                    Cached portfolio values may still be visible.
                  </p>
                )}
                {degradedConnection && (
                  <p>The brokerage is reporting degraded service.</p>
                )}
                {delayedConnection && (
                  <p>
                    This connection uses daily or delayed data rather than real-time retrieval.
                  </p>
                )}
              </div>
              {connectionNeedsAttention?.disabled && (
                <button
                  className="primary-button"
                  onClick={() =>
                    void connectBrokerage(connectionNeedsAttention.id)
                  }
                  disabled={connecting}
                >
                  {connecting ? (
                    <><Loader2 className="spin" size={17} /> Opening SnapTrade…</>
                  ) : (
                    <>Reconnect brokerage</>
                  )}
                </button>
              )}
            </section>
          )}

          {api.getTfsaRoom && <TfsaOverLimitBanner state={room} />}
          {api.getNudges && <NudgeBanner state={nudges} />}

          <section className="value-strip" aria-label="Portfolio totals">
            {portfolio.homeTotal && (
              <div className="home-total">
                <div className="value-label">Total in Canadian dollars</div>
                <div className="home-total-row">
                  <strong>{formatCurrency(portfolio.homeTotal.amount, "CAD")}</strong>
                  {portfolio.homeTotal.estimated && <span className="est-tag">est.</span>}
                </div>
                {portfolio.homeTotal.rateDate && (
                  <p className="home-total-note">{`US dollars converted at the Bank of Canada rate of ${portfolio.homeTotal.rateDate}.`}</p>
                )}
              </div>
            )}
            <div className="value-label">{portfolio.homeTotal ? "As your brokerage reports it" : "Brokerage-reported portfolio value"}</div>
            <div className="currency-values">
              {totals.length > 0 ? totals.map((total) => (
                <div key={total.currency}>
                  <strong>{formatCurrency(total.amount, total.currency)}</strong>
                  <span>{total.currency}</span>
                </div>
              )) : <strong>Value unavailable</strong>}
            </div>
            {managedNotInTotal(portfolio.accounts).length > 0 && (
              <p className="home-total-note not-in-total">{notInTotalNote(managedNotInTotal(portfolio.accounts))}</p>
            )}
            {unreportedNotInTotal(portfolio.accounts).length > 0 && (
              <p className="home-total-note not-in-total">{`Not included: ${unreportedNotInTotal(portfolio.accounts).join(", ")}. The brokerage reports no total for it, so this total leaves it out; chat views value it from its holdings.`}</p>
            )}
            <div className="freshness-line">
              <Clock3 size={14} />{" "}
              {syncedAt
                ? `Prices as of ${formatTimestamp(syncedAt)}, SnapTrade's last sync with your brokerage. Your brokerage's app shows live prices, so its total can differ during market hours.`
                : `As of ${formatTimestamp(portfolio.generatedAt)}`}
            </div>
          </section>

          {api.getPerformance && <PerformancePanel api={api} />}

          {api.getTfsaRoom && <TfsaRoomTile state={room} onOpenRoom={onOpenRoom} />}

          {connectionsUnavailable && (
            <div className="warning-banner" role="status">
              Connection status is unavailable right now. Portfolio values are shown below.
            </div>
          )}

          {portfolio.errors.length > 0 && (
            <div className="warning-banner" role="status">
              Some account data is temporarily unavailable. Healthy accounts are shown below.
            </div>
          )}

          <section className="section-block account-overview">
            <div className="section-title-row">
              <div>
                <div className="section-kicker">Accounts</div>
                <h2>Portfolio structure</h2>
              </div>
              <span>{portfolio.accounts.length} account{portfolio.accounts.length === 1 ? "" : "s"}</span>
            </div>

            {accountGroups.map((group) => (
              <section
                className={`account-group group-${group.id}`}
                data-testid={`portfolio-group-${group.id}`}
                key={group.id}
              >
                <div className="group-heading">
                  <div>
                    <div className="section-kicker">{group.kicker}</div>
                    <h2>{group.label}</h2>
                  </div>
                  <span>{group.accounts.length}</span>
                </div>
                <AccountBuckets accounts={group.accounts} />
              </section>
            ))}

            {closedAccounts.length > 0 && (
              <details className="closed-accounts">
                <summary>
                  <span>Closed accounts</span>
                  <small>
                    {closedAccounts.length} excluded from current totals
                  </small>
                </summary>
                <AccountBuckets accounts={closedAccounts} />
              </details>
            )}
          </section>

          <section className="section-block holdings-section">
            <div className="section-title-row">
              <div>
                <div className="section-kicker">Holdings</div>
                <h2>What you own</h2>
              </div>
              <span>{positions.length} position{positions.length === 1 ? "" : "s"}</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Account</th>
                    <th>Units</th>
                    <th>Price</th>
                    <th>Market value</th>
                    <th>Unrealized</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((position) => (
                    <tr key={`${position.accountName}-${position.instrumentId}`}>
                      <td>
                        <strong>{position.symbol}</strong>
                        <span>{position.description ?? position.kind}</span>
                      </td>
                      <td>{position.accountName}</td>
                      <td>{position.units ?? "—"}</td>
                      <td>{position.price !== null && position.currency ? formatCurrency(position.price, position.currency) : "—"}</td>
                      <td>{position.marketValue !== null && position.currency ? formatCurrency(position.marketValue, position.currency) : "—"}</td>
                      <td className={(position.unrealizedGain ?? 0) >= 0 ? "positive" : "negative"}>
                        {position.unrealizedGain !== null && position.currency ? formatCurrency(position.unrealizedGain, position.currency) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {positions.length === 0 && <div className="empty-table">No positions are currently available.</div>}
            </div>
          </section>

          <section className="boundary-card">
            <div className="boundary-icon"><LockKeyhole size={20} /></div>
            <div>
              <div className="section-kicker">Read-only</div>
              <h2>VestLens can read your accounts</h2>
              <p>It can&apos;t place a trade or move money. Trades, transfers and recurring buys stay with you, in Wealthsimple.</p>
            </div>
          </section>
        </main>
      )}
    </div>
  );
}

function App() {
  const { status } = useOwnerSession();

  // Signed out (or the session ended mid-use): the sign-in page, which returns here afterwards.
  useEffect(() => {
    if (status === "signedOut") goToSignIn();
  }, [status]);

  const api = useMemo(() => createPortfolioApiClient(), []);

  return (
    <PortfolioExperience
      auth={{
        isAuthenticated: status === "signedIn",
        // Signed out counts as loading: the browser is already on its way to /login, so no sign-in screen flashes.
        isLoading: status !== "signedIn",
        userName: null,
        login: async () => goToSignIn(),
        logout: () => { void signOut(); },
      }}
      api={api}
    />
  );
}

export default App;
