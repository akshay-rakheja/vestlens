import { describe, expect, it } from "vitest";

import { GRANTED_SCOPES, hasScope, isGrantedScope, normalizeScope } from "./scope.js";

describe("normalizeScope", () => {
  it("grants exactly portfolio:read memory to new authorizations", () => {
    expect(GRANTED_SCOPES).toBe("portfolio:read memory");
  });

  it.each([
    undefined,
    "",
    "portfolio:read",
    "portfolio:read portfolio:read",
    "portfolio:read memory",
    "memory portfolio:read",
    "openid portfolio:read offline_access email profile",
    "portfolio:read offline_access memory",
  ])("%j → portfolio:read memory", (scope) => {
    expect(normalizeScope(scope)).toBe("portfolio:read memory");
  });

  it.each([
    "memory",
    "memory offline_access",
    "openid offline_access",
    "portfolio:read connections:manage",
    "portfolio:read memory connections:manage",
    "memory:write portfolio:read",
    "x",
  ])("%j → null (invalid_scope)", (scope) => {
    expect(normalizeScope(scope)).toBeNull();
  });
});

describe("hasScope", () => {
  it("reads a space-separated grant", () => {
    expect(hasScope("portfolio:read memory", "portfolio:read")).toBe(true);
    expect(hasScope("portfolio:read memory", "memory")).toBe(true);
    expect(hasScope("portfolio:read", "portfolio:read")).toBe(true);
    expect(hasScope("portfolio:read", "memory")).toBe(false);
    expect(hasScope("", "memory")).toBe(false);
    expect(hasScope("portfolio:readmemory", "memory")).toBe(false);
    expect(hasScope("memoryx portfolio:read", "memory")).toBe(false);
  });

  it("reads a list of granted scopes (the verified identity's scopes)", () => {
    expect(hasScope(["portfolio:read", "memory"], "memory")).toBe(true);
    expect(hasScope(["portfolio:read"], "memory")).toBe(false);
    expect(hasScope([], "portfolio:read")).toBe(false);
  });
});

describe("isGrantedScope", () => {
  it("accepts only the stored grants a family can carry", () => {
    expect(isGrantedScope("portfolio:read memory")).toBe(true);
    // Families and codes created before the memory scope existed.
    expect(isGrantedScope("portfolio:read")).toBe(true);
    expect(isGrantedScope("memory")).toBe(false);
    expect(isGrantedScope("memory portfolio:read")).toBe(false);
    expect(isGrantedScope("portfolio:read connections:manage")).toBe(false);
    expect(isGrantedScope("")).toBe(false);
  });
});
