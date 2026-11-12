/** show_limits's structuredContent (packages/api/src/mcp/limit-tools.ts buildShowLimits; rows are limits/limit-check.ts LimitCheck). */
export type LimitStatus = "within" | "over" | "cant_tell";
export interface LimitRow {
  slug: string; label: string; kind: string; maxPct: number; currentPct: number | null; status: LimitStatus;
  line: string; unclassifiedPct?: number; note?: string; fxDate?: string; estimated?: boolean;
  /** One listing of a company evaluated on its combined row: a breakdown with no verdict of its own. */
  informational?: boolean;
}
export interface LimitGroup { slug: string; kind: string; target: string | null; maxPct: number; label: string; rows: LimitRow[] }
export interface LimitsPayload { limits: LimitGroup[] }
