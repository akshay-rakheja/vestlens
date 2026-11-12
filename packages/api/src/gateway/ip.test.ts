import { describe, expect, it } from "vitest";

import { rateLimitKeyForIp, rateLimitPrefixKeyForIp } from "./ip.js";

describe("rateLimitKeyForIp", () => {
  it("keeps IPv4 addresses whole", () => {
    expect(rateLimitKeyForIp("203.0.113.7")).toBe("203.0.113.7");
  });

  it("unwraps IPv4-mapped IPv6", () => {
    expect(rateLimitKeyForIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitKeyForIp("::FFFF:cb00:7107")).toBe("203.0.113.7");
  });

  it("keys IPv6 by its /64 prefix, in canonical form", () => {
    const a = rateLimitKeyForIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(a).toBe("2001:db8:1:2::/64");
    expect(rateLimitKeyForIp("2001:0DB8:0001:0002::1")).toBe(a);
    expect(rateLimitKeyForIp("2001:db8:1:2::ffff%eth0")).toBe(a);
    expect(rateLimitKeyForIp("2001:db8:1:3::1")).not.toBe(a);
    expect(rateLimitKeyForIp("::1")).toBe("0:0:0:0::/64");
  });

  it("falls back to the trimmed, lower-cased input when unparseable", () => {
    expect(rateLimitKeyForIp(" Unknown ")).toBe("unknown");
    expect(rateLimitKeyForIp("")).toBe("");
  });
});

describe("rateLimitPrefixKeyForIp", () => {
  it("keys IPv6 by its /48 prefix", () => {
    const a = rateLimitPrefixKeyForIp("2001:db8:1:2:aaaa::1");
    expect(a).toBe("2001:db8:1::/48");
    expect(rateLimitPrefixKeyForIp("2001:0DB8:0001:ffff::9%eth0")).toBe(a);
    expect(rateLimitPrefixKeyForIp("2001:db8:2::1")).not.toBe(a);
  });

  it("has no wider key for IPv4, IPv4-mapped IPv6 or unparseable input", () => {
    expect(rateLimitPrefixKeyForIp("203.0.113.7")).toBeNull();
    expect(rateLimitPrefixKeyForIp("::ffff:203.0.113.7")).toBeNull();
    expect(rateLimitPrefixKeyForIp("unknown")).toBeNull();
  });
});
