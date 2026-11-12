import { formatRelativeTime } from "./format";
import { diverging } from "./charts/palette";

export type MoodLevel = "strongly_negative" | "negative" | "neutral" | "positive" | "strongly_positive" | "not_enough_news";

const LEVELS: MoodLevel[] = ["strongly_negative", "negative", "neutral", "positive", "strongly_positive"];
export const MOOD_WORDS: Record<MoodLevel, string> = {
  strongly_negative: "Strongly negative", negative: "Negative", neutral: "Neutral", positive: "Positive",
  strongly_positive: "Strongly positive", not_enough_news: "Not enough news",
};
/** The ramp colour for a news tone level; the muted neutral for "not enough news". */
export const moodColor = (level: MoodLevel) => {
  const i = LEVELS.indexOf(level);
  return i < 0 ? "var(--c-other)" : diverging[i];
};

const R_OUT = 46, R_IN = 32, CX = 50, CY = 50, GAP = 0.04;
const pt = (r: number, a: number) => `${(CX + r * Math.cos(a)).toFixed(2)},${(CY - r * Math.sin(a)).toFixed(2)}`;
/** Segment i of five across the upper half circle, strongly negative on the left to strongly positive on the right. */
function segment(i: number): string {
  const a0 = Math.PI - (i * Math.PI) / 5 - GAP, a1 = Math.PI - ((i + 1) * Math.PI) / 5 + GAP;
  return `M${pt(R_OUT, a0)} A${R_OUT},${R_OUT} 0 0 1 ${pt(R_OUT, a1)} L${pt(R_IN, a1)} A${R_IN},${R_IN} 0 0 0 ${pt(R_IN, a0)} Z`;
}

/** Five-segment news tone arc. The active segment is filled from the neutral tone ramp; the level is always also written in words. */
export function MoodDial(props: { level: MoodLevel; value: number | null; articles: number; mostRecentAt: string | null; size?: "sm" | "lg"; label: string; unit?: "articles" | "ratings" }) {
  const word = MOOD_WORDS[props.level];
  const active = LEVELS.indexOf(props.level);
  // "ratings" when the count is a sum over symbols, where one article tied to two symbols counts twice.
  const noun = props.unit === "ratings" ? (props.articles === 1 ? "article rating" : "article ratings") : props.articles === 1 ? "article" : "articles";
  const basis = `based on ${props.articles} ${noun}${props.mostRecentAt ? ` · most recent ${formatRelativeTime(props.mostRecentAt)}` : ""}`;
  return (
    <div class="w-dial" data-size={props.size ?? "sm"} data-level={props.level} role="img" aria-label={`${props.label}: ${word}`}>
      <svg viewBox="0 0 100 54" aria-hidden="true" focusable="false">
        {LEVELS.map((lvl, i) => (
          <path key={lvl} data-segment={lvl} data-active={i === active ? "true" : "false"} d={segment(i)}
            fill={i === active ? diverging[i] : "var(--dial-off)"}
            {...(i === active ? { stroke: "var(--ink)", "stroke-width": "1" } : {})} />
        ))}
      </svg>
      <span class="w-dial-word">{word}</span>
      <span class="w-dial-sub">{basis}</span>
    </div>
  );
}
