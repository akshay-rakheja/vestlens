import { describe, expect, it } from "vitest";
import type { Request } from "express";

import { readCookies } from "./cookies.js";

const req = (cookie?: unknown) => ({ headers: cookie === undefined ? {} : { cookie } }) as unknown as Request;

describe("readCookies", () => {
  it("returns every value for the exact name, trimmed", () => {
    expect(readCookies(req("a=1; b=2;  a = 3 ; ab=4"), "a")).toEqual(["1", "3"]);
    expect(readCookies(req("x=y=z"), "x")).toEqual(["y=z"]);
  });
  it("returns [] for a missing or non-string header and parts without '='", () => {
    expect(readCookies(req(), "a")).toEqual([]);
    expect(readCookies(req(["a=1"]), "a")).toEqual([]);
    expect(readCookies(req("a"), "a")).toEqual([]);
  });
});
