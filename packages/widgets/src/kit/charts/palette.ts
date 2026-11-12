/** Categorical series colours: eight fixed slots (theme.css --c1..--c8) plus two neutrals. Slots never cycle. */
export const SLOTS = 8;
export const slotColor = (slot: number) => `var(--c${slot + 1})`;
export const OTHER_COLOR = "var(--c-other)";
export const UNCLASSIFIED_COLOR = "var(--c-unclassified)";

export type Preference = number | "other" | "unclassified" | undefined;

/**
 * Colour per key, in the given order: a key keeps its preferred slot when that slot is free, otherwise it takes the
 * first free slot; once all eight are used the rest are Other. No two keys ever share a slot colour.
 */
export function assignColors(keys: readonly string[], prefer: (key: string) => Preference = () => undefined): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<number>();
  const wants = keys.map((k) => [k, prefer(k)] as const);
  // Claim free preferred slots first so an earlier key without a preference cannot take a later key's slot.
  for (const [k, p] of wants) {
    if (p === "other") out.set(k, OTHER_COLOR);
    else if (p === "unclassified") out.set(k, UNCLASSIFIED_COLOR);
    else if (typeof p === "number" && p >= 0 && p < SLOTS && !used.has(p)) { used.add(p); out.set(k, slotColor(p)); }
  }
  for (const [k] of wants) {
    if (out.has(k)) continue;
    let slot = 0;
    while (slot < SLOTS && used.has(slot)) slot++;
    if (slot < SLOTS) { used.add(slot); out.set(k, slotColor(slot)); } else out.set(k, OTHER_COLOR);
  }
  return out;
}

/**
 * News tone ramp, five steps (theme.css --d1..--d5). One neutral slate whose depth grows with distance from
 * neutral, the same on both sides, so tone is never coloured as good or bad (VestLens brand, #25). Hex values
 * (light / dark): d1 and d5 strong #2f4a55 / #c9d6d9, d2 and d4 mild #7f949c / #8fa2a9, d3 neutral #c7d0d3 / #46555b.
 * The ramp is never the only cue: consumers always render the level in words, and the dial shows direction.
 */
export const diverging = [
  "var(--d1)", "var(--d2)", "var(--d3)", "var(--d4)", "var(--d5)",
] as const;
