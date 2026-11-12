import { describe, expect, it } from "vitest";

import { isAllowedRedirectForm, redirectUriAllowed } from "./redirects.js";

describe("redirectUriAllowed", () => {
  it("accepts an exact string match", () => {
    expect(redirectUriAllowed(["https://claude.ai/api/mcp/auth_callback"], "https://claude.ai/api/mcp/auth_callback")).toBe(true);
  });

  it("rejects https near-misses (no prefix, substring or normalisation matching)", () => {
    const reg = ["https://claude.ai/api/mcp/auth_callback"];
    for (const c of [
      "https://claude.ai/api/mcp/auth_callback/extra",
      "https://claude.ai/api/mcp/auth_callback?x=1",
      "https://claude.ai/api/mcp/auth_callback#f",
      "https://claude.ai:8443/api/mcp/auth_callback",
      "https://claude.ai.evil.com/api/mcp/auth_callback",
      "https://CLAUDE.ai/api/mcp/auth_callback",
      "https://claude.ai/api/mcp/x/../auth_callback",
      "https://claude.ai/api/mcp/auth_callbac",
      "http://claude.ai/api/mcp/auth_callback",
    ]) {
      expect(redirectUriAllowed(reg, c), c).toBe(false);
    }
  });

  it("Review Focus 5: loopback matches any port, same scheme/host/path/query", () => {
    expect(redirectUriAllowed(["http://127.0.0.1:8080/callback"], "http://127.0.0.1:53123/callback")).toBe(true);
    expect(redirectUriAllowed(["http://127.0.0.1:8080/callback"], "http://127.0.0.1/callback")).toBe(true);
    expect(redirectUriAllowed(["http://localhost:8080/cb?a=1"], "http://localhost:9999/cb?a=1")).toBe(true);
    // Global Constraints list only 127.0.0.1 and localhost as loopback hosts.
    expect(redirectUriAllowed(["http://[::1]:8080/cb"], "http://[::1]:4000/cb")).toBe(false);
  });

  it("Review Focus 5: loopback lookalikes and differences are rejected", () => {
    const reg = ["http://127.0.0.1:8080/callback"];
    for (const c of [
      "http://127.0.0.2/callback",
      "http://127.0.0.2:8080/callback",
      "http://127.0.0.1.evil.com/callback",
      "http://127.0.0.1.evil.com:8080/callback",
      "http://localhost:53123/callback",
      "http://[::1]:53123/callback",
      "https://127.0.0.1:53123/callback",
      "http://127.0.0.1:53123/callback/",
      "http://127.0.0.1:53123/callbackx",
      "http://127.0.0.1:53123/callback?x=1",
      "http://127.0.0.1:53123/callback#frag",
      "http://127.0.0.1:53123/callback#",
      "http://user@127.0.0.1:53123/callback",
      "http://evil.com@127.0.0.1:53123/callback",
      "http://127.0.0.1:53123/x/../callback",
      "http://0x7f.0.0.1:53123/callback",
      "http://2130706433:53123/callback",
      "not a url",
      "",
    ]) {
      expect(redirectUriAllowed(reg, c), c).toBe(false);
    }
  });

  it("does not apply any-port matching to non-loopback http or https entries", () => {
    expect(redirectUriAllowed(["https://app.example.com:8443/cb"], "https://app.example.com:9443/cb")).toBe(false);
    expect(redirectUriAllowed(["http://192.168.1.5:8080/cb"], "http://192.168.1.5:9090/cb")).toBe(false);
  });

  it("rejects any candidate containing '#', even an exact match of a registered entry", () => {
    expect(redirectUriAllowed(["http://127.0.0.1:8080/callback"], "http://127.0.0.1:53123/callback#")).toBe(false);
    expect(redirectUriAllowed(["http://127.0.0.1:8080/callback#"], "http://127.0.0.1:8080/callback#")).toBe(false);
    expect(redirectUriAllowed(["https://a.example/cb#"], "https://a.example/cb#")).toBe(false);
  });

  it("rejects everything against an empty registration", () => {
    expect(redirectUriAllowed([], "http://127.0.0.1:1/cb")).toBe(false);
  });
});

describe("isAllowedRedirectForm", () => {
  it("allows https and loopback http", () => {
    for (const u of [
      "https://claude.ai/api/mcp/auth_callback",
      "http://127.0.0.1:8080/callback",
      "http://localhost/callback",
      "http://localhost:8080/cb",
      "https://xn--bcher-kva.de/cb",
      "https://a-b.example.com:8443/cb?x=1",
    ]) {
      expect(isAllowedRedirectForm(u), u).toBe(true);
    }
  });

  it("rejects other schemes, non-loopback http, fragments and userinfo", () => {
    for (const u of [
      "http://example.com/cb",
      "http://127.0.0.2/cb",
      "http://127.0.0.1.evil.com/cb",
      "javascript:alert(1)",
      "data:text/html,hi",
      "cursor://callback",
      "https://claude.ai/cb#frag",
      "https://user:pw@claude.ai/cb",
      "https://claude.ai/cb#",
      "https:///x",
      "https://claude.ai",
      "https://Claude.ai/cb",
      "http://127.0.0.1:80/cb",
      "https://claude.ai/a/../cb",
      "ftp://claude.ai/cb",
      "http://[::1]:3000/cb",
      "https://a;b.com/cb",
      "https://a_b.com/cb",
      "https://a!b.com/cb",
      "https://a*b.com/cb",
      "https://a'b.com/cb",
      "https://[2001:db8::1]/cb",
      "https://claude.ai./cb",
      "https://.claude.ai/cb",
      "nope",
      "",
    ]) {
      expect(isAllowedRedirectForm(u), u).toBe(false);
    }
  });
});
