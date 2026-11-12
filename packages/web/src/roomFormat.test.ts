import { describe, expect, it } from "vitest";

import { storedAlertText } from "./roomFormat";

// The shared currency-format fixture check for this file lives in the API package
// (packages/api/src/room/web-format-drift.test.ts): the web build installs only web dependencies,
// so web sources and tests must not read files outside packages/web or use Node built-ins.
describe("room format (dashboard side)", () => {
  it("states a stored note verbatim", () => {
    expect(storedAlertText({ excessCad: 400, note: "(est.; includes US$4,000 converted at the Bank of Canada rate of 2026-06-01)" }))
      .toBe("Your TFSA contributions this year are about $400 (est.; includes US$4,000 converted at the Bank of Canada rate of 2026-06-01) over your room. CRA charges 1% a month on the excess.");
  });
});
