/**
 * IP address parsing for the gateway: the CIMD SSRF guard and rate-limit keys.
 */


export function parseIPv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0;
  for (const part of m.slice(1)) {
    if (part.length > 1 && part.startsWith("0")) return null; // ambiguous octal
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

export function parseIPv6(s: string): bigint | null {
  if (s.includes("%")) return null; // zoned addresses are link-scoped: never allowed
  let text = s.toLowerCase();
  const lastColon = text.lastIndexOf(":");
  if (lastColon < 0) return null;
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    // Embedded dotted quad (e.g. ::ffff:10.0.0.1): rewrite as two hex groups.
    const v4 = parseIPv4(last);
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = toGroups(halves[0]!);
  let groups: string[];
  if (halves.length === 2) {
    const tail = toGroups(halves[1]!);
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. 169.254.169.254 metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];
const V4_RANGES = V4_BLOCKED.map(([base, len]) => {
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return { net: (parseIPv4(base)! & mask) >>> 0, mask };
});

function blockedV4(n: number): boolean {
  return V4_RANGES.some(({ net, mask }) => ((n & mask) >>> 0) === net);
}

const v6 = (hex: string): bigint => parseIPv6(hex)!;
const inV6 = (x: bigint, base: bigint, len: number): boolean => x >> BigInt(128 - len) === base >> BigInt(128 - len);
const low32 = (x: bigint): number => Number(x & 0xffffffffn);

function blockedV6(x: bigint): boolean {
  if (inV6(x, v6("::ffff:0:0"), 96)) return blockedV4(low32(x)); // IPv4-mapped
  if (inV6(x, v6("64:ff9b::"), 96)) return blockedV4(low32(x)); // NAT64 well-known
  if (inV6(x, v6("2002::"), 16)) return blockedV4(Number((x >> 80n) & 0xffffffffn)); // 6to4
  if (inV6(x, v6("::"), 96)) return true; // ::, ::1, IPv4-compatible
  if (inV6(x, v6("::ffff:0:0:0"), 96)) return true; // IPv4-translated (SIIT)
  if (inV6(x, v6("64:ff9b:1::"), 48)) return true; // local-use NAT64
  if (inV6(x, v6("100::"), 64)) return true; // discard-only
  if (inV6(x, v6("2001::"), 23)) return true; // IETF protocol assignments, incl. Teredo
  if (inV6(x, v6("2001:db8::"), 32)) return true; // documentation
  if (inV6(x, v6("3fff::"), 20)) return true; // documentation
  if (inV6(x, v6("fc00::"), 7)) return true; // unique local
  if (inV6(x, v6("fe80::"), 10)) return true; // link-local
  if (inV6(x, v6("fec0::"), 10)) return true; // site-local (deprecated)
  if (inV6(x, v6("ff00::"), 8)) return true; // multicast
  return !inV6(x, v6("2000::"), 3); // only global unicast remains allowed
}

/** True unless `address` is a parseable, publicly routable IPv4/IPv6 address. */
export function isBlockedAddress(address: string): boolean {
  if (typeof address !== "string") return true;
  const a = parseIPv4(address);
  if (a !== null) return blockedV4(a);
  if (!address.includes(":")) return true;
  const b = parseIPv6(address);
  if (b === null) return true;
  return blockedV6(b);
}


/**
 * Rate-limit key for a client IP (hash the result before storing/logging).
 * IPv4 (and IPv4-mapped IPv6) stay whole; other IPv6 addresses collapse to
 * their /64 prefix, since a single host commonly controls a whole /64.
 */
export function rateLimitKeyForIp(ip: string): string {
  const raw = typeof ip === "string" ? ip.trim().toLowerCase() : "";
  if (parseIPv4(raw) !== null) return raw;
  const unzoned = raw.split("%")[0]!;
  const x = unzoned.includes(":") ? parseIPv6(unzoned) : null;
  if (x === null) return raw;
  if (x >> 32n === 0xffffn) {
    const v4 = Number(x & 0xffffffffn);
    return [24, 16, 8, 0].map((sh) => (v4 >>> sh) & 255).join(".");
  }
  const groups = [48n, 32n, 16n, 0n].map((sh) => (((x >> 64n) >> sh) & 0xffffn).toString(16));
  return `${groups.join(":")}::/64`;
}

/**
 * Wider rate-limit key: the /48 prefix of a (non-IPv4-mapped) IPv6 address,
 * since one site commonly holds a /48 (65k /64s). Null for IPv4, mapped IPv4
 * and unparseable input, which have no wider key.
 */
export function rateLimitPrefixKeyForIp(ip: string): string | null {
  const raw = typeof ip === "string" ? ip.trim().toLowerCase().split("%")[0]! : "";
  if (!raw.includes(":")) return null;
  const x = parseIPv6(raw);
  if (x === null || x >> 32n === 0xffffn) return null;
  const groups = [112n, 96n, 80n].map((sh) => ((x >> sh) & 0xffffn).toString(16));
  return `${groups.join(":")}::/48`;
}
