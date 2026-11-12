// @vitest-environment node
// Plain JS so the web typecheck (no Node types) skips it; jsdom has no layout, so this reads the stylesheet.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

// The global `table` rule sets a 720px floor for the tables that sit in `.table-scroll`. Without an override the
// deposits table forces the performance panel's one grid column to 720px when "Where the money went in" opens,
// and every part of the card overflows on a phone.
describe("deposits table on a narrow screen", () => {
  it("drops the global 720px table floor so the open breakdown fits the card", () => {
    expect(css).toMatch(/^table \{[^}]*min-width: 720px/m);
    expect(css).toMatch(/^\.perf-deposits table \{[^}]*min-width: 0;/m);
  });
});
