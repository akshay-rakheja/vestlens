/** show_goal's structuredContent (packages/api/src/mcp/goal-tools.ts buildShowGoal; each goal is goals/goal-check.ts GoalCheck). */
export interface GoalCheck {
  slug: string; name: string; targetCad: number; targetDate: string;
  savedCad: number | null; savedPct: number | null; remainingCad: number | null; estimated: boolean;
  /** savedCad is a lower bound (a managed account's value is unknown): "at least", no percentage or projection. */
  savedAtLeast?: true;
  /** Latest Bank of Canada rate date behind the saved total; null when it was not converted. */
  savedFxDate: string | null;
  /** The recent pace is shown and rests on converted flows, with its own rate date. */
  paceEstimated: boolean;
  paceFxDate: string | null;
  monthsLeft: number; dateStatus: "future" | "under_month" | "passed";
  neededPerMonthFlatCad: number | null; recentPacePerMonthCad: number | null;
  projectedAtPaceCad: number | null; projectedWithRateCad: number | null; growthRatePct: number | null;
  series: Array<{ date: string; valueCad: number }>;
  notes: string[];
}
export interface GoalPayload { goals: GoalCheck[] }
