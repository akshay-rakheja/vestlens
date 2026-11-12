import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const kit = join(process.cwd(), "src", "kit");
const widgets = join(kit, "..", "widgets");
const theme = readFileSync(join(kit, "theme.css"), "utf8");

test("the interaction accent is VestLens aperture teal in both themes", () => {
  expect(theme).toContain("--accent: light-dark(#0e6b6b, #5cbdb5);");
});

test("warnings use the attention colour, not the loss colour", () => {
  expect(theme).toContain(".w-banner.warning { background: var(--attn-bg); color: var(--attn); }");
});

test("buys and sells are not coloured as gains or losses", () => {
  expect(theme).not.toMatch(/\.w-act-ic\.(buy|sell)\s*\{/);
});

test("every widget ends with the brand footer", () => {
  const names = readdirSync(widgets);
  expect(names).toHaveLength(13);
  for (const name of names) {
    const file = readdirSync(join(widgets, name)).find((f) => /^[A-Z]\w+\.tsx$/.test(f) && !f.includes(".test."));
    expect(file, name).toBeDefined();
    expect(readFileSync(join(widgets, name, file!), "utf8"), name).toMatch(/<BrandFooter( advice=\{false\})? \/>/);
  }
});

test("news tone uses one neutral ramp, symmetric about neutral, so no tone reads as good or bad", () => {
  const ramp = (n: number) => theme.match(new RegExp(`--d${n}: (light-dark\\([^)]*\\));`))?.[1];
  expect(ramp(1)).toBeDefined();
  expect(ramp(1)).toBe(ramp(5));
  expect(ramp(2)).toBe(ramp(4));
});
