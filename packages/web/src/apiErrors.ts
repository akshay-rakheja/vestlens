/** An error whose message is fixed client copy, safe to show; any other error is shown as a generic message. */
export class FixedMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixedMessageError";
  }
}

export interface AiApp {
  clientKey: string;
  name: string;
  host: string;
  grantedAt: string;
}

/** One current entry of "What VestLens remembers". Every string is data to render as text, never markup. */
export interface MemoryFactView {
  id: string;
  nodeType: string;
  nodeKey: string;
  property: string;
  value: unknown;
  text: string;
  kind: string;
  provenance: "stated" | "inferred" | "imported" | "derived";
  source: string | null;
  validFrom: string | null;
  validTo: string | null;
  recordedAt: string;
}

export interface MemoryGroupView {
  nodeType: string;
  facts: MemoryFactView[];
}

export interface RoomNative { amount: number; currency: string }
export interface FxSummary { estimated: boolean; rateDates: string[]; native: RoomNative[] }
export interface RoomAmbiguousRow {
  activityKey: string;
  date: string;
  amountCad: number | null;
  estimated: boolean;
  rateDate: string | null;
  native: RoomNative | null;
  type: string;
  label: string;
  /** Shares moved in kind with no price and no close: no amount; the account's stated year-to-date figure as of a later date stands in for it. */
  inKind?: true;
  accountKey?: string;
}
export type RoomMissingItem =
  | { kind: "cra_room" }
  | { kind: "coverage"; label: string; accountKey: string }
  | { kind: "outside_contributions"; label: string; accountKey: string }
  | { kind: "stale_activity"; label: string; accountKey: string; lastSyncedAt: string | null }
  | { kind: "disconnected_account"; accountKey: string }
  /** A managed TFSA: its contributions aren't visible through SnapTrade, so its year-to-date figure is asked for (A9). */
  | { kind: "managed_account"; label: string; accountKey: string }
  | { kind: "dated_entries"; label: string; accountKey: string }
  | { kind: "ambiguous"; count: number; rows: RoomAmbiguousRow[] };

/** One move in the room ledger (mirrors the API's LedgerRow). A null running value renders as "?". */
export interface LedgerRowView {
  date: string | null;
  kind: "cra_room" | "contribution" | "withdrawal" | "none" | "ambiguous" | "outside_total";
  label: string;
  amountCad: number | null;
  estimated: boolean;
  rateDate: string | null;
  native: RoomNative | null;
  activityKey?: string;
  accountKey?: string;
  /** Withdrawals: the part that reduced an amount over (never comes back) and the rest; null while unknown. */
  qualifyingCad?: number | null;
  returnsCad?: number | null;
  /** Only when returnsCad is above 0. */
  returnsOn?: string;
  /** A transfer matched to the other side of the move in another of the user's accounts (its kind is inferred). */
  matchedWith?: { label: string; date: string };
  inferred?: true;
  /** A row the user answered (its kind is their answer); automaticMatch: clearing the answer would match it again. */
  answered?: true;
  automaticMatch?: true;
  /** An unmatched, unanswered transfer whose kind is assumed (in: contribution; out: none); step 4 changes it. */
  assumed?: true;
  /** FHSA withdrawals: made while not over (or beyond the excess then), it lowers a later excess this year. */
  offsetsLater?: true;
  /** A fixed engine note (FHSA: a transfer from an RRSP). */
  note?: string;
  roomLeftCad: number | null;
  excessCad: number | null;
  wentOver: boolean;
}
export interface RoomLedgerView { rows: LedgerRowView[]; overSince: string | null; undatedExcess: boolean }
export interface RoomAccountView {
  /** inSet: counted as a TFSA this year (broker-labelled and not excluded, or added in step 2). */
  accountKey: string; label: string; neutral: boolean; inSet: boolean;
  /** The last 4 characters of the brokerage's masked account number. */
  maskedNumber?: string | null;
  /** The brokerage-reported total in its own currency. */
  value?: { amount: number; currency: string } | null;
}
export interface RoomAccountSetView { connected: string[]; notTfsa: string[]; outside: { label: string }[] }
type RoomOutcome = { roomLeftCad: number | null; excessCad: number | null };
/** Per unclear transfer: incoming ones carry asContribution, outgoing ones (a negative amount) asWithdrawal. */
export type RoomOutcomesView = Record<string, { asContribution?: RoomOutcome; asWithdrawal?: RoomOutcome; asNone: RoomOutcome }>;

interface RoomCommon {
  /** Set while an outside TFSA carried from an earlier year has no figure this year: shown under the headline. */
  headlineBasis?: string;
  ledger: RoomLedgerView;
  accounts: RoomAccountView[];
  outcomes: RoomOutcomesView;
  /** This year's account set when the engine applies it (stated or imported, well formed), else null. */
  accountSet?: RoomAccountSetView | null;
  /** While this year has no usable set: the latest earlier one, which the engine carries forward and steps 2 and 3 pre-fill from. */
  previousAccountSet?: RoomAccountSetView | null;
  year: number;
  withdrawnCad: number;
  /** The withdrawals' parts that come back next 1 January; null while that can't be told. */
  returningCad?: number | null;
  basis: string[];
  fx: { contributions: FxSummary; withdrawals: FxSummary };
  /** The stored open over-limit alert for this year (its note is the room text's conversion note), or null. */
  alert: { year: number; excessCad: number; estimated: boolean; note: string | null } | null;
  /** The New Year check's sentence (the API's words): contributions near New Year the brokerage may record in the other year. */
  newYearNote?: string;
}

/** A managed account with no saved figure: the number leaves it out and says so. */
export interface NotCountedAccount { accountKey: string; label: string }
/** GET /api/room/tfsa. */
export type TfsaRoomView =
  | (RoomCommon & { status: "known"; roomLeftCad: number; contributedCad: number; craRoomCad: number; estimated: boolean; overLimitCad: number; activityAsOf?: string | null; notCounted?: NotCountedAccount[] })
  | (RoomCommon & { status: "missing"; missing: RoomMissingItem[] });

export type FhsaMissingItem =
  | { kind: "fhsa_room" }
  | { kind: "managed_account"; label: string; accountKey: string }
  | { kind: "coverage"; label: string; accountKey: string }
  | { kind: "stale_activity"; label: string; accountKey: string; lastSyncedAt: string | null }
  | { kind: "ambiguous"; count: number; rows: RoomAmbiguousRow[] };
export interface FhsaAccountView { accountKey: string; label: string; maskedNumber: string | null; value: { amount: number; currency: string } | null }
interface FhsaCommon {
  year: number;
  ledger: RoomLedgerView;
  accounts: FhsaAccountView[];
  withdrawnCad: number;
  basis: string[];
  fx: { contributions: FxSummary; withdrawals: FxSummary };
  fxDates: string[];
  /** No FHSA alert yet: always null. */
  alert: null;
  /** The New Year check's sentence (the API's words), when an FHSA contribution is near New Year. */
  newYearNote?: string;
}
/** GET /api/room/fhsa: "none" when the user has no broker-labelled FHSA. */
export type FhsaRoomView =
  | { status: "none" }
  | (FhsaCommon & {
    status: "known"; roomLeftCad: number; contributedCad: number; participationRoomCad: number; estimated: boolean; overLimitCad: number;
    activityAsOf: string | null; headlineBasis: string; notCounted?: NotCountedAccount[];
  })
  | (FhsaCommon & { status: "missing"; missing: FhsaMissingItem[] });

export type RrspMissingItem =
  | { kind: "deduction_limit" }
  | { kind: "unused_contributions" }
  | { kind: "elsewhere" }
  | { kind: "managed_rrsp"; labels: string[] }
  | { kind: "coverage"; label: string; accountKey: string }
  | { kind: "stale_activity"; label: string; accountKey: string; lastSyncedAt: string | null }
  | { kind: "ambiguous"; count: number; rows: RoomAmbiguousRow[] };
/** One open RRSP tax year (mirrors the API's RrspYear): CRA's contribution window, `to` null while unpublished. */
export interface RrspYearView {
  window: { taxYear: number; from: string; to: string | null };
  /** Null when moves may be missing (a coverage, freshness or unclear-row item). */
  contributedCad: number | null;
  limitCad: number | null; unusedCad: number | null; elsewhereCad: number | null;
  /** Only with the limit, unused contributions and contributions not in VestLens all stated (0 counts) and nothing missing. */
  roomLeftCad: number | null; overLimitCad: number | null;
  estimated: boolean; missing: RrspMissingItem[]; basis: string[]; ledger: RoomLedgerView;
  fx: { contributions: FxSummary; withdrawals: FxSummary }; fxDates: string[];
}
export interface RrspAccountView {
  accountKey: string; label: string; maskedNumber: string | null; value: { amount: number; currency: string } | null; managed: boolean; closed: boolean;
}
/** GET /api/room/rrsp: "none" when the user has no broker-labelled RRSP; else each open tax year, oldest first. */
export type RrspRoomView =
  | { status: "none" }
  | { status: "shown"; years: RrspYearView[]; activityAsOf: string | null; accounts: RrspAccountView[] };

/** GET /api/theses, /api/theses/:ticker, /api/limits, /api/goals, /api/nudges. Every string is data to render as text. */
export interface ThesisConditionView {
  id: string;
  text: string;
  kind: string;
  status: "held" | "broken" | "cant_tell";
  evidence?: { value: string; asOf: string };
  note?: string;
}
export interface ThesisPlayedOutView {
  returnPct: number | null;
  vsSp500Pct: number | null;
  vsTsxPct: number | null;
  estimated: boolean;
  excluded: string[];
  reason?: string;
  startDate: string | null;
  endDate: string | null;
  notes: string[];
}
export interface ThesisSummaryView {
  ticker: string;
  reasons: string;
  boughtAround: string | null;
  writtenAt: string;
  timeFrame: { label: string; ended: boolean } | null;
  conditions: ThesisConditionView[];
  playedOut: ThesisPlayedOutView;
}
export interface ThesisCheckView {
  ticker: string;
  writtenAt: string;
  timeFrame: { label: string; ended: boolean } | null;
  conditions: ThesisConditionView[];
  news: Array<{ title: string; source: string; publishedAt: string; tone: string | null }>;
  earnings: Array<{ date: string }>;
  playedOut: ThesisPlayedOutView;
}
export interface ThesisFullView {
  ticker: string;
  thesis: { reasons: string; boughtAround: string | null; history: number; check: ThesisCheckView };
}

export interface LimitRowView {
  label: string;
  currentPct: number | null;
  status: "within" | "over" | "cant_tell";
  /** One listing of a company evaluated on its combined row: a breakdown with no verdict of its own. */
  informational?: boolean;
  line: string;
  text: string;
  unclassifiedPct: number | null;
  fxDate: string | null;
}
export interface LimitView {
  slug: string;
  kind: string;
  target: string | null;
  maxPct: number;
  label: string;
  rows: LimitRowView[];
}

export interface GoalView {
  slug: string;
  name: string;
  targetCad: number;
  targetDate: string;
  savedCad: number | null;
  /** savedCad is a lower bound (a managed account's value is unknown): "at least", no percentage or projection. */
  savedAtLeast?: true;
  savedPct: number | null;
  remainingCad: number | null;
  estimated: boolean;
  savedFxDate: string | null;
  paceEstimated: boolean;
  paceFxDate: string | null;
  monthsLeft: number;
  dateStatus: "future" | "under_month" | "passed";
  neededPerMonthFlatCad: number | null;
  recentPacePerMonthCad: number | null;
  paceSince?: string;
  projectedAtPaceCad: number | null;
  projectedWithRateCad: number | null;
  growthRatePct: number | null;
  notes: string[];
}

export interface NudgeView {
  kind: string;
  target: string;
  text: string;
  raisedAt: string;
}

/** The four room input writes; each answers with the same JSON as GET /api/room/tfsa. */
export type RoomOutsideEntry = { date: string; amountCad: number; kind: "deposit" | "withdrawal" };
