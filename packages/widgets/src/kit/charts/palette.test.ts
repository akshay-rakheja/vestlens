import { OTHER_COLOR, SLOTS, UNCLASSIFIED_COLOR, assignColors, slotColor } from "./palette";

test("there are eight fixed slots named --c1..--c8", () => {
  expect(SLOTS).toBe(8);
  expect(Array.from({ length: SLOTS }, (_, i) => slotColor(i))).toEqual(["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c7)", "var(--c8)"]);
});

test("keys get sequential slots and never cycle: the ninth key falls back to Other", () => {
  const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
  const colors = assignColors(keys);
  expect(keys.slice(0, 8).map((k) => colors.get(k))).toEqual(Array.from({ length: 8 }, (_, i) => slotColor(i)));
  expect(colors.get("k8")).toBe(OTHER_COLOR);
  expect(colors.get("k9")).toBe(OTHER_COLOR);
});

test("a preferred slot is kept when free; a taken preference moves to the first free slot, so no two keys share a colour", () => {
  const prefs: Record<string, number> = { a: 3, b: 3, c: 0 };
  const colors = assignColors(["a", "b", "c", "d"], (k) => prefs[k]);
  expect(colors.get("a")).toBe(slotColor(3));
  expect(colors.get("c")).toBe(slotColor(0));
  expect(colors.get("b")).toBe(slotColor(1));
  expect(colors.get("d")).toBe(slotColor(2));
  expect(new Set(colors.values()).size).toBe(4);
});

test("preferences may name the neutral Other and Unclassified colours, which take no slot", () => {
  const colors = assignColors(["x", "other", "unclassified"], (k) => (k === "other" ? "other" : k === "unclassified" ? "unclassified" : undefined));
  expect(colors.get("x")).toBe(slotColor(0));
  expect(colors.get("other")).toBe(OTHER_COLOR);
  expect(colors.get("unclassified")).toBe(UNCLASSIFIED_COLOR);
});

test("the diverging ramp has five distinct steps from --d1 to --d5", async () => {
  const { diverging } = await import("./palette");
  expect(diverging).toEqual(["var(--d1)", "var(--d2)", "var(--d3)", "var(--d4)", "var(--d5)"]);
  expect(new Set(diverging).size).toBe(5);
});
