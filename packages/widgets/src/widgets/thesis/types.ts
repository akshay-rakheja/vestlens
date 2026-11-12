/** show_thesis's structuredContent (packages/api/src/mcp/thesis-tools.ts buildShowThesis; the check is theses/thesis-check.ts ThesisCheck). */
export type ConditionStatus = "held" | "broken" | "cant_tell";
export interface ConditionCheck {
  id: string; text: string; kind: string; status: ConditionStatus;
  evidence?: { value: string; asOf: string };
  note?: string;
}
export interface NewsItem {
  title: string; source: string; publishedAt: string; tone: string | null;
  /** An https address opens through the host's link bridge. */
  url?: string;
}
export interface PlayedOut {
  returnPct: number | null; vsSp500Pct: number | null; vsTsxPct: number | null; estimated: boolean;
  excluded: string[]; reason?: string; startDate: string | null; endDate: string | null; notes: string[];
}
export interface ThesisCheck {
  ticker: string;
  writtenAt: string;
  timeFrame: { label: string; ended: boolean } | null;
  conditions: ConditionCheck[];
  news: NewsItem[];
  earnings: Array<{ date: string }>;
  playedOut: PlayedOut;
}
/** One limit that touches the holding (show_limits' line and text, labelled). */
export interface HoldingLimit { label: string; status: string; currentPct: number | null; line: string; text: string }
/** The holding view with no thesis: since first bought, weight, limits and the last 30 days of news. */
/** The holding view: since the first recorded purchase, weight, limits and news (with or without a thesis). */
export interface HoldingBlock {
  sinceFirstBought: PlayedOut;
  weight: { pct: number; estimated: boolean; asOf: string; netOfMargin?: boolean; notInTotal?: string[] } | null;
  weightNote?: string;
  limits: HoldingLimit[];
  news: NewsItem[];
  /** "News since you wrote it" or "News in the last 30 days". */
  newsLabel: string;
}
/** No thesis: the block plus the no-reasons line. */
export interface HoldingView extends HoldingBlock {
  /** "No reasons saved for this holding." */
  noReasons: string;
}
export type ThesisPayload =
  /** Never held (holding null), or an older result with no holding view (holding absent). */
  | { mode: "one"; ticker: string; thesis: null; holding?: null }
  | { mode: "one"; ticker: string; thesis: null; holding: HoldingView }
  /** With a thesis: the holding block (an older result carries only `sinceFirstBought`). */
  | { mode: "one"; ticker: string; thesis: { reasons: string; boughtAround: string | null; check: ThesisCheck }; holding?: HoldingBlock | { sinceFirstBought: PlayedOut } | null }
  | { mode: "list"; theses: Array<{ ticker: string; reasons: string; writtenAt: string; timeFrame: ThesisCheck["timeFrame"]; conditions: ConditionCheck[] }> };
