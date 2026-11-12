/** get_contribution_room's structuredContent (packages/api/src/room/tfsa-room.ts RoomResult plus accounts and context). */
export interface FxSummary { estimated: boolean; rateDates: string[]; native: Array<{ amount: number; currency: string }> }
export interface Native { amount: number; currency: string }
export interface AmbiguousRow {
  activityKey: string;
  date: string;
  amountCad: number | null;
  estimated: boolean;
  rateDate: string | null;
  native: Native | null;
  type: string;
  label: string;
  /** Shares moved in kind with no price and no close: no amount; the account's stated year-to-date figure as of a later date stands in for it. */
  inKind?: true;
  accountKey?: string;
}
export type MissingItem =
  | { kind: "cra_room" }
  | { kind: "coverage"; label: string; accountKey: string }
  | { kind: "outside_contributions"; label: string; accountKey: string }
  | { kind: "stale_activity"; label: string; accountKey: string; lastSyncedAt: string | null }
  | { kind: "disconnected_account"; accountKey: string }
  /** A managed TFSA: its contributions aren't visible through SnapTrade, so its year-to-date figure is asked for (A9). */
  | { kind: "managed_account"; label: string; accountKey: string }
  | { kind: "dated_entries"; label: string; accountKey: string }
  | { kind: "ambiguous"; count: number; rows: AmbiguousRow[] };

export interface LedgerRow {
  date: string | null;
  kind: "cra_room" | "contribution" | "withdrawal" | "none" | "ambiguous" | "outside_total";
  label: string;
  amountCad: number | null;
  estimated: boolean;
  rateDate: string | null;
  native: Native | null;
  /** Withdrawals: the part that reduced an amount over (never comes back) and the rest; null while unknown. */
  qualifyingCad?: number | null;
  returnsCad?: number | null;
  /** Only when returnsCad is above 0. */
  returnsOn?: string;
  /** A transfer matched to the other side of the move in another of the user's accounts (its kind is inferred). */
  matchedWith?: { label: string; date: string };
  /** An unmatched, unanswered transfer whose kind is assumed (in: contribution; out: none). */
  assumed?: true;
  inferred?: true;
  /** A row the user answered (its kind is their answer); automaticMatch: clearing the answer would match it again. */
  answered?: true;
  automaticMatch?: true;
  roomLeftCad: number | null;
  excessCad: number | null;
  wentOver: boolean;
}
export interface RoomLedger { rows: LedgerRow[]; overSince: string | null; undatedExcess: boolean }

interface Common {
  /** Set while an outside TFSA carried from an earlier year has no figure this year. */
  headlineBasis?: string;
  ledger?: RoomLedger;
  /** The dashboard room page; absent when the server doesn't know its base URL. */
  dashboardUrl?: string;
  year: number;
  withdrawnCad: number;
  /** The withdrawals' parts that come back next 1 January; null while that can't be told. */
  returningCad?: number | null;
  basis: string[];
  fx: { contributions: FxSummary; withdrawals: FxSummary };
  fxDates: string[];
  /** Present only when the user has a broker-labelled FHSA. */
  fhsa?: FhsaSummary;
  /** Present only when the user has a broker-labelled RRSP; older payloads omit it. */
  rrsp?: RrspSummary;
  /** The New Year check's sentence (the server's words), when a contribution is near New Year. */
  newYearNote?: string;
}
/** A managed account with no saved figure: the number leaves it out and says so. */
export interface NotCounted { accountKey: string; label: string }
/** One open RRSP tax year as get_contribution_room sends it: the headline is the server's words, the rest is what the block reads. */
export interface RrspYearSummary {
  window: { taxYear: number; from: string; to: string | null };
  headline: string;
  /** The connected RRSPs' contributions (null while moves may be missing) and the figure entered for RRSPs VestLens can't see. */
  contributedCad?: number | null;
  elsewhereCad?: number | null;
  overLimitCad?: number | null;
  estimated?: boolean;
  fx?: { contributions: FxSummary; withdrawals: FxSummary };
  missing?: Array<{ kind: string; labels?: string[]; label?: string }>;
}
/** The RRSP summary: one entry per open tax year, previous year first. */
export interface RrspSummary { status: "shown"; years: RrspYearSummary[]; line?: string }
/** The one FHSA summary get_contribution_room adds when the user has an FHSA: its headline in the dashboard's words. */
export interface FhsaSummary {
  status: "known" | "missing";
  year: number;
  headline: string;
  /** Managed FHSAs the number leaves out; absent when there are none. */
  notCounted?: NotCounted[];
  overLimitCad?: number;
  /** The converted contributions' note (est., Bank of Canada rate dates, native amounts), or null. */
  note?: string | null;
  missing?: Array<{ kind: string }>;
  /** The freshness label, "Withdrawals are counted as taxable withdrawals" and the last-year line, as on the dashboard. */
  disclosures?: string[];
  /** The New Year check's sentence (the server's words), when an FHSA contribution is near New Year. */
  newYearNote?: string;
}

export type RoomPayload =
  | (Common & { status: "known"; roomLeftCad: number; contributedCad: number; craRoomCad: number; estimated: boolean; overLimitCad: number; activityAsOf?: string | null; notCounted?: NotCounted[] })
  | (Common & { status: "missing"; missing: MissingItem[] });
