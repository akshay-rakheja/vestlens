import { describe, expect, it } from "vitest";

import { thesisNudgeText } from "../nudges/nudge-service.js";
import { connectFacts, firstText } from "../testing/fact-tools-harness.js";
import { quotedUserText } from "./portfolio-fact-tools.js";
import { quoteUserText, stripControlAndFormat } from "./user-text.js";

// Synthetic text only.
const HOSTILE = "Growth‮ story​,\nsee 'x'\t\"y\"\u0007⁦";

describe("quoted user text", () => {
  it("drops format characters, turns control characters into spaces, collapses whitespace and JSON-quotes", () => {
    expect(stripControlAndFormat("a​b‮c\nd")).toBe("abc d");
    const q = quoteUserText(HOSTILE);
    expect(q).toBe(`"Growth story, see 'x' \\"y\\""`);
    expect(q).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(JSON.parse(q)).toBe(`Growth story, see 'x' "y"`);
    expect(quotedUserText(HOSTILE)).toBe(q);
    expect(quoteUserText("x".repeat(10), 5)).toBe(`"xxxx…"`);
  });

  it("show_thesis shows the user's reasons and condition text without control or format characters", async () => {
    const { client } = await connectFacts();
    await client.callTool({ name: "log_thesis", arguments: {
      ticker: "SHOP.TO", reasons: HOSTILE, timeFrame: null,
      conditions: [{ kind: "price_below", text: "Above‮ 100​", price: 100, currency: "CAD" }],
    } });
    const text = firstText(await client.callTool({ name: "show_thesis", arguments: { ticker: "SHOP.TO" } }));
    expect(text).toContain(`"Growth story, see 'x' \\"y\\""`);
    expect(text).toContain(`- "Above 100": held`);
    for (const line of text.split("\n")) expect(line).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it("a thesis nudge quotes the condition the same way", () => {
    expect(thesisNudgeText("SHOP.TO", HOSTILE, "90.00 CAD as of 2026-10-22"))
      .toBe(`Your SHOP.TO thesis condition ${quoteUserText(HOSTILE)} looks broken (90.00 CAD as of 2026-10-22).`);
  });
});
