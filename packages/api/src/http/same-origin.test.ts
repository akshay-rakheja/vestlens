import { describe, expect, it } from "vitest";

import { isSameOriginRequest } from "./same-origin.js";

const EXPECTED = "https://vestlens.example.com";
const req = (headers: Record<string, string>) =>
  ({ get: ((name: string) => headers[name.toLowerCase()]) as never });

describe("isSameOriginRequest", () => {
  it("accepts the expected origin and refuses any other", () => {
    expect(isSameOriginRequest(req({ origin: EXPECTED }), EXPECTED)).toBe(true);
    expect(isSameOriginRequest(req({ origin: "https://evil.example" }), EXPECTED)).toBe(false);
    expect(isSameOriginRequest(req({ origin: "http://vestlens.example.com" }), EXPECTED)).toBe(false);
  });
  it("refuses Sec-Fetch-Site: cross-site even with a matching Origin", () => {
    expect(isSameOriginRequest(req({ origin: EXPECTED, "sec-fetch-site": "cross-site" }), EXPECTED)).toBe(false);
    expect(isSameOriginRequest(req({ origin: EXPECTED, "sec-fetch-site": "same-origin" }), EXPECTED)).toBe(true);
  });
  it("treats a missing Origin as allowed only when it is not required", () => {
    expect(isSameOriginRequest(req({}), EXPECTED)).toBe(true);
    expect(isSameOriginRequest(req({}), EXPECTED, { requireOrigin: true })).toBe(false);
  });
});
