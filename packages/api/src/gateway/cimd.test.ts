import { describe, expect, it, vi } from "vitest";

import { CimdResolver, createPinnedHttpsFetch, isBlockedAddress, pinnedLookup, type CimdLookup } from "./cimd.js";
import { MemoryGatewayStore } from "./store.js";

const URL_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";

const doc = (over: Record<string, unknown> = {}) => ({
  client_id: URL_ID,
  client_name: "Claude",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  ...over,
});

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });

const publicLookup: CimdLookup = async () => [{ address: "160.79.104.10", family: 4 }];

function setup(o: { fetch?: typeof fetch; lookup?: CimdLookup; now?: () => Date; timeoutMs?: number; maxConcurrent?: number } = {}) {
  const store = new MemoryGatewayStore();
  const fetchFn = vi.fn(o.fetch ?? (async () => jsonResponse(doc())));
  const lookup = vi.fn(o.lookup ?? publicLookup);
  const resolver = new CimdResolver({
    store,
    fetch: fetchFn as unknown as typeof fetch,
    lookup,
    now: o.now,
    timeoutMs: o.timeoutMs,
    maxConcurrent: o.maxConcurrent,
  });
  return { store, fetchFn, lookup, resolver };
}

describe("isBlockedAddress", () => {
  it("blocks private, loopback, link-local, CGNAT, metadata, multicast and reserved IPv4", () => {
    for (const a of [
      "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255",
      "127.0.0.1", "127.9.9.9", "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255",
      "192.168.0.1", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
      "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    ]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
  });

  it("blocks IPv6 loopback, unspecified, ULA, link-local, multicast and embedded private IPv4", () => {
    for (const a of [
      "::", "::1", "0:0:0:0:0:0:0:1", "fc00::1", "fd00::1", "fd12:3456::1", "fe80::1", "fe80::1%en0",
      "febf::1", "ff02::1", "ff00::", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:169.254.169.254",
      "::ffff:a00:1", "::ffff:0:a00:1", "::10.0.0.1", "64:ff9b::10.0.0.1", "64:ff9b::a9fe:a9fe",
      "2002:0a00:0001::1", "2001:db8::1", "2001::1", "fec0::1", "100::1",
    ]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const a of ["160.79.104.10", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::6810:84e5", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
      expect(isBlockedAddress(a), a).toBe(false);
    }
  });

  it("treats unparseable input as blocked", () => {
    for (const a of ["", "localhost", "1.2.3", "1.2.3.4.5", "256.0.0.1", "::g", "1:2:3:4:5:6:7:8:9", "01.2.3.4"]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
  });
});

describe("CimdResolver", () => {
  it("resolves a valid document and marks claude.ai as a verified host", async () => {
    const { resolver, fetchFn } = setup();
    const c = await resolver.resolve(URL_ID);
    expect(c).toEqual({
      clientKey: URL_ID,
      kind: "cimd",
      name: "Claude",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      clientSecretHash: null,
      verifiedHost: true,
    });
    const [calledUrl, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe(URL_ID);
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("verifiedHost is true only for exactly claude.ai or chatgpt.com", async () => {
    const cases: Array<[string, boolean]> = [
      ["https://chatgpt.com/oauth/client.json", true],
      ["https://claude.ai/x/meta", true],
      ["https://evil.claude.ai/x/meta", false],
      ["https://claude.ai.evil.com/x/meta", false],
      ["https://notchatgpt.com/x/meta", false],
      ["https://client.example.com/meta", false],
    ];
    for (const [url, expected] of cases) {
      const { resolver } = setup({ fetch: (async () => jsonResponse(doc({ client_id: url }))) as typeof fetch });
      const c = await resolver.resolve(url);
      expect(c?.verifiedHost, url).toBe(expected);
    }
  });

  it("Review Focus 2: rejects hosts resolving to blocked addresses without calling fetch", async () => {
    const bad: Array<Array<{ address: string; family: 4 | 6 }>> = [
      [{ address: "169.254.169.254", family: 4 }],
      [{ address: "10.0.0.5", family: 4 }],
      [{ address: "192.168.1.1", family: 4 }],
      [{ address: "127.0.0.1", family: 4 }],
      [{ address: "::1", family: 6 }],
      [{ address: "fd00::1", family: 6 }],
      [{ address: "fe80::1", family: 6 }],
      [{ address: "::ffff:10.0.0.1", family: 6 }],
      [{ address: "100.64.0.1", family: 4 }],
      // A single blocked address among public ones is enough to reject.
      [{ address: "160.79.104.10", family: 4 }, { address: "10.0.0.1", family: 4 }],
      [],
    ];
    for (const addrs of bad) {
      const { resolver, fetchFn } = setup({ lookup: async () => addrs });
      expect(await resolver.resolve(URL_ID), JSON.stringify(addrs)).toBeNull();
      expect(fetchFn).not.toHaveBeenCalled();
    }
  });

  it("rejects when DNS lookup fails, without calling fetch", async () => {
    const { resolver, fetchFn } = setup({ lookup: async () => { throw new Error("ENOTFOUND"); } });
    expect(await resolver.resolve(URL_ID)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects malformed client_id URLs without lookup or fetch", async () => {
    for (const url of [
      "http://claude.ai/meta",
      "https://10.0.0.1/meta",
      "https://[::1]/meta",
      "https://[fd00::1]/meta",
      "https://0x7f000001/meta",
      "https://localhost/meta",
      "https://claude.ai",
      "https://claude.ai/",
      "https://claude.ai/meta#frag",
      "https://user:pw@claude.ai/meta",
      "https://claude.ai/a/../meta",
      "https://claude.ai/a/./meta",
      "https://CLAUDE.ai/meta",
      "https://claude.ai./meta",
      "https://localhost./meta",
      "not a url",
    ]) {
      const { resolver, fetchFn, lookup } = setup();
      expect(await resolver.resolve(url), url).toBeNull();
      expect(lookup, url).not.toHaveBeenCalled();
      expect(fetchFn, url).not.toHaveBeenCalled();
    }
  });

  it("Review Focus 2: rejects any 3xx response without following it", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { resolver, fetchFn } = setup({
        fetch: (async () => new Response(null, { status, headers: { location: "http://169.254.169.254/latest" } })) as typeof fetch,
      });
      expect(await resolver.resolve(URL_ID), String(status)).toBeNull();
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects non-2xx responses", async () => {
    const { resolver } = setup({ fetch: (async () => jsonResponse(doc(), { status: 404 })) as typeof fetch });
    expect(await resolver.resolve(URL_ID)).toBeNull();
  });

  it("rejects a body over 64 KB (streamed, no content-length)", async () => {
    const big = JSON.stringify(doc({ client_name: "x".repeat(70 * 1024) }));
    const { resolver } = setup({ fetch: (async () => jsonResponse(big)) as typeof fetch });
    expect(await resolver.resolve(URL_ID)).toBeNull();
  });

  it("stops reading an unbounded stream once past the cap", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(16 * 1024).fill(0x20));
      },
    });
    const { resolver } = setup({
      fetch: (async () => new Response(stream, { headers: { "content-type": "application/json" } })) as typeof fetch,
    });
    expect(await resolver.resolve(URL_ID)).toBeNull();
    expect(pulls).toBeLessThan(10);
  });

  it("rejects a declared content-length over 64 KB", async () => {
    const { resolver } = setup({
      fetch: (async () => jsonResponse(doc(), { headers: { "content-length": String(65 * 1024) } })) as typeof fetch,
    });
    expect(await resolver.resolve(URL_ID)).toBeNull();
  });

  it("accepts a body of exactly 64 KB", async () => {
    const base = JSON.stringify(doc());
    const body = base + " ".repeat(64 * 1024 - Buffer.byteLength(base));
    const { resolver } = setup({ fetch: (async () => jsonResponse(body)) as typeof fetch });
    expect(await resolver.resolve(URL_ID)).not.toBeNull();
  });

  it("rejects non-JSON content types and invalid JSON", async () => {
    for (const [ct, body] of [
      ["text/html", JSON.stringify(doc())],
      ["text/plain", JSON.stringify(doc())],
      ["application/jsonp", JSON.stringify(doc())],
      ["", JSON.stringify(doc())],
      ["application/json", "{not json"],
      ["application/json", "[]"],
      ["application/json", "\"str\""],
    ]) {
      const { resolver } = setup({
        fetch: (async () => new Response(body, { headers: ct ? { "content-type": ct } : {} })) as typeof fetch,
      });
      expect(await resolver.resolve(URL_ID), `${ct} ${body.slice(0, 10)}`).toBeNull();
    }
  });

  it("accepts application/json with parameters", async () => {
    const { resolver } = setup({
      fetch: (async () => jsonResponse(doc(), { headers: { "content-type": "Application/JSON; charset=utf-8" } })) as typeof fetch,
    });
    expect(await resolver.resolve(URL_ID)).not.toBeNull();
  });

  it("rejects a client_id mismatch", async () => {
    for (const id of [URL_ID + "/", "https://claude.ai/oauth/other", undefined, 42]) {
      const { resolver } = setup({ fetch: (async () => jsonResponse(doc({ client_id: id }))) as typeof fetch });
      expect(await resolver.resolve(URL_ID), String(id)).toBeNull();
    }
  });

  it("rejects documents with missing, empty or disallowed redirect_uris", async () => {
    for (const redirect_uris of [undefined, [], ["http://example.com/cb"], ["javascript:alert(1)"], ["https://ok.example/cb#f"]]) {
      const { resolver } = setup({ fetch: (async () => jsonResponse(doc({ redirect_uris }))) as typeof fetch });
      expect(await resolver.resolve(URL_ID), JSON.stringify(redirect_uris)).toBeNull();
    }
  });

  it("rejects clients with no public auth method and documents lacking authorization_code/code", async () => {
    for (const over of [
      { token_endpoint_auth_method: "client_secret_basic" },
      { token_endpoint_auth_method: "client_secret_post" },
      { token_endpoint_auth_method: "private_key_jwt" },
      { token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["private_key_jwt"] },
      { token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: "none" },
      { grant_types: ["implicit"] },
      { grant_types: ["refresh_token"] },
      { grant_types: [] },
      { response_types: ["token"] },
      { response_types: [] },
    ]) {
      const { resolver } = setup({ fetch: (async () => jsonResponse(doc(over))) as typeof fetch });
      expect(await resolver.resolve(URL_ID), JSON.stringify(over)).toBeNull();
    }
  });

  it("ignores extra grants, extra response types and unknown members in CIMD documents", async () => {
    for (const over of [
      { grant_types: ["authorization_code", "client_credentials"] },
      { grant_types: ["authorization_code", "urn:ietf:params:oauth:grant-type:jwt-bearer"] },
      { grant_types: undefined },
      { response_types: ["code", "token"] },
      { response_types: undefined },
      { software_id: "x", some_vendor_extension: { a: 1 } },
      { token_endpoint_auth_method: undefined },
    ]) {
      const { resolver } = setup({ fetch: (async () => jsonResponse(doc(over))) as typeof fetch });
      const c = await resolver.resolve(URL_ID);
      expect(c?.tokenEndpointAuthMethod, JSON.stringify(over)).toBe("none");
    }
  });

  it("keeps the document's supported grant types, defaulting to both", async () => {
    for (const [over, expected] of [
      [{ grant_types: ["authorization_code"] }, ["authorization_code"]],
      [{ grant_types: ["authorization_code", "client_credentials"] }, ["authorization_code"]],
      [{ grant_types: undefined }, ["authorization_code", "refresh_token"]],
    ] as const) {
      const { resolver } = setup({ fetch: (async () => jsonResponse(doc(over))) as typeof fetch });
      expect((await resolver.resolve(URL_ID))?.grantTypes, JSON.stringify(over)).toEqual(expected);
    }
  });

  it("treats a client as public when token_endpoint_auth_methods_supported includes none", async () => {
    const { resolver } = setup({
      fetch: (async () =>
        jsonResponse(doc({ token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["none", "private_key_jwt"] }))) as typeof fetch,
    });
    const c = await resolver.resolve(URL_ID);
    expect(c?.tokenEndpointAuthMethod).toBe("none");
    expect(c?.clientSecretHash).toBeNull();
  });

  describe("real public CIMD documents (synthetic fixtures copied verbatim)", () => {
    const CLAUDE_URL = "https://claude.ai/oauth/mcp-oauth-client-metadata";
    const CLAUDE_DOC =
      '{"client_id":"https://claude.ai/oauth/mcp-oauth-client-metadata","client_name":"Claude","client_uri":"https://claude.ai","redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"grant_types":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"],"response_types":["code"],"token_endpoint_auth_method":"none"}';
    const CHATGPT_URL = "https://chatgpt.com/oauth/QHWVc7o0A9ib/client.json";
    const CHATGPT_DOC =
      '{"client_id":"https://chatgpt.com/oauth/QHWVc7o0A9ib/client.json","client_uri":"https://chatgpt.com/","redirect_uris":["https://chatgpt.com/connector/oauth/QHWVc7o0A9ib"],"token_endpoint_auth_method":"private_key_jwt","token_endpoint_auth_methods_supported":["none","private_key_jwt"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"client_name":"ChatGPT","logo_uri":"https://persistent.oaistatic.com/sonic/misc/openai-logo.png","token_endpoint_auth_signing_alg":"RS256","jwks_uri":"https://chatgpt.com/oauth/jwks.json"}';

    it("resolves the Claude document", async () => {
      const { resolver } = setup({
        fetch: (async () =>
          new Response(CLAUDE_DOC, { headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } })) as typeof fetch,
      });
      expect(await resolver.resolve(CLAUDE_URL)).toEqual({
        clientKey: CLAUDE_URL,
        kind: "cimd",
        name: "Claude",
        redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
        tokenEndpointAuthMethod: "none",
        grantTypes: ["authorization_code", "refresh_token"],
        clientSecretHash: null,
        verifiedHost: true,
      });
    });

    it("resolves the ChatGPT document", async () => {
      const { resolver } = setup({
        fetch: (async () => new Response(CHATGPT_DOC, { headers: { "content-type": "application/json; charset=utf-8" } })) as typeof fetch,
      });
      expect(await resolver.resolve(CHATGPT_URL)).toEqual({
        clientKey: CHATGPT_URL,
        kind: "cimd",
        name: "ChatGPT",
        redirectUris: ["https://chatgpt.com/connector/oauth/QHWVc7o0A9ib"],
        tokenEndpointAuthMethod: "none",
        grantTypes: ["authorization_code", "refresh_token"],
        clientSecretHash: null,
        verifiedHost: true,
      });
    });
  });

  it("caches only the validated client fields, never the raw document", async () => {
    const { resolver, store } = setup({
      fetch: (async () =>
        jsonResponse(
          doc({
            grant_types: ["authorization_code", "refresh_token", "client_credentials"],
            response_types: ["code", "token"],
            token_endpoint_auth_method: "private_key_jwt",
            token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
            padding: "x".repeat(40_000),
            jwks_uri: "https://claude.ai/jwks.json",
          }),
        )) as typeof fetch,
    });
    const first = await resolver.resolve(URL_ID);
    expect((await store.getCimd(URL_ID))?.document).toEqual({
      client_id: URL_ID,
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    // The stored subset resolves to the same client.
    const fromCache = new CimdResolver({ store, fetch: vi.fn() as unknown as typeof fetch, lookup: publicLookup });
    expect(await fromCache.resolve(URL_ID)).toEqual(first);
  });

  it("omits client_name from the cached fields when the document has none", async () => {
    const { resolver, store } = setup({ fetch: (async () => jsonResponse(doc({ client_name: undefined }))) as typeof fetch });
    await resolver.resolve(URL_ID);
    expect((await store.getCimd(URL_ID))?.document).not.toHaveProperty("client_name");
  });

  it("falls back to the host name when client_name is missing", async () => {
    const { resolver } = setup({ fetch: (async () => jsonResponse(doc({ client_name: undefined }))) as typeof fetch });
    expect((await resolver.resolve(URL_ID))?.name).toBe("claude.ai");
  });

  it("serves a fresh cache hit without lookup or fetch", async () => {
    let t = new Date("2026-10-20T00:00:00Z");
    const { resolver, fetchFn, lookup } = setup({ now: () => t });
    expect(await resolver.resolve(URL_ID)).not.toBeNull();
    t = new Date(t.getTime() + 4 * 60 * 1000);
    expect(await resolver.resolve(URL_ID)).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("clamps max-age to between 5 min and 24 h", async () => {
    const t0 = new Date("2026-10-20T00:00:00Z");
    const cases: Array<[string | null, number]> = [
      [null, 5 * 60],
      ["max-age=0", 5 * 60],
      ["no-store", 5 * 60],
      ["public, max-age=3600", 3600],
      ["max-age=999999999", 24 * 3600],
    ];
    for (const [cc, expectedSeconds] of cases) {
      const { resolver, store } = setup({
        now: () => t0,
        fetch: (async () => jsonResponse(doc(), { headers: cc ? { "cache-control": cc } : {} })) as typeof fetch,
      });
      await resolver.resolve(URL_ID);
      const entry = await store.getCimd(URL_ID);
      expect(entry?.freshUntil.getTime(), String(cc)).toBe(t0.getTime() + expectedSeconds * 1000);
      expect(entry?.staleUntil.getTime(), String(cc)).toBe(t0.getTime() + (expectedSeconds + 24 * 3600) * 1000);
    }
  });

  it("refetches once the cache entry is no longer fresh", async () => {
    let t = new Date("2026-10-20T00:00:00Z");
    const { resolver, fetchFn } = setup({ now: () => t });
    await resolver.resolve(URL_ID);
    t = new Date(t.getTime() + 6 * 60 * 1000);
    await resolver.resolve(URL_ID);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("serves a stale entry when fetch errors, within the 24 h stale window", async () => {
    let t = new Date("2026-10-20T00:00:00Z");
    let fail = false;
    const { resolver } = setup({
      now: () => t,
      fetch: (async () => {
        if (fail) throw new TypeError("network down");
        return jsonResponse(doc());
      }) as typeof fetch,
    });
    expect(await resolver.resolve(URL_ID)).not.toBeNull();
    fail = true;
    t = new Date(t.getTime() + 23 * 3600 * 1000);
    expect((await resolver.resolve(URL_ID))?.clientKey).toBe(URL_ID);
    t = new Date(t.getTime() + 2 * 3600 * 1000); // 25h after fresh window expired at +5min
    expect(await resolver.resolve(URL_ID)).toBeNull();
  });

  it("serves stale on a 5xx but not when the host now resolves to a blocked address", async () => {
    let t = new Date("2026-10-20T00:00:00Z");
    let mode: "ok" | "500" | "ssrf" = "ok";
    const { resolver } = setup({
      now: () => t,
      lookup: async () => [{ address: mode === "ssrf" ? "10.0.0.1" : "160.79.104.10", family: 4 }],
      fetch: (async () => (mode === "500" ? new Response("x", { status: 503 }) : jsonResponse(doc()))) as typeof fetch,
    });
    await resolver.resolve(URL_ID);
    t = new Date(t.getTime() + 3600 * 1000);
    mode = "500";
    expect(await resolver.resolve(URL_ID)).not.toBeNull();
    t = new Date(t.getTime() + 61 * 1000); // past the negative-cache window
    mode = "ssrf";
    expect(await resolver.resolve(URL_ID)).toBeNull();
  });

  it("does not serve stale when the refreshed document is invalid", async () => {
    let t = new Date("2026-10-20T00:00:00Z");
    let bad = false;
    const { resolver } = setup({
      now: () => t,
      fetch: (async () => jsonResponse(bad ? doc({ client_id: "https://other.example/x" }) : doc())) as typeof fetch,
    });
    await resolver.resolve(URL_ID);
    t = new Date(t.getTime() + 3600 * 1000);
    bad = true;
    expect(await resolver.resolve(URL_ID)).toBeNull();
  });

  it("treats a connect-time ECIMDBLOCKED (DNS rebinding) as a policy failure: no stale fallback", async () => {
    let t = new Date("2026-10-20T00:00:00Z");
    let rebind = false;
    const { resolver } = setup({
      now: () => t,
      fetch: (async () => {
        if (rebind) throw new TypeError("fetch failed", { cause: Object.assign(new Error("blocked"), { code: "ECIMDBLOCKED" }) });
        return jsonResponse(doc());
      }) as typeof fetch,
    });
    expect(await resolver.resolve(URL_ID)).not.toBeNull();
    t = new Date(t.getTime() + 3600 * 1000);
    rebind = true;
    expect(await resolver.resolve(URL_ID)).toBeNull();
  });

  it("treats a directly thrown ECIMDBLOCKED as a policy failure too", async () => {
    let t = new Date("2026-10-20T00:00:00Z");
    let rebind = false;
    const { resolver } = setup({
      now: () => t,
      fetch: (async () => {
        if (rebind) throw Object.assign(new Error("blocked"), { code: "ECIMDBLOCKED" });
        return jsonResponse(doc());
      }) as typeof fetch,
    });
    await resolver.resolve(URL_ID);
    t = new Date(t.getTime() + 3600 * 1000);
    rebind = true;
    expect(await resolver.resolve(URL_ID)).toBeNull();
  });

  it("dedupes concurrent resolves of the same URL into one fetch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { resolver, fetchFn, lookup } = setup({
      fetch: (async () => {
        await gate;
        return jsonResponse(doc());
      }) as typeof fetch,
    });
    const ps = [resolver.resolve(URL_ID), resolver.resolve(URL_ID), resolver.resolve(URL_ID)];
    await new Promise((r) => setTimeout(r, 5));
    release();
    const results = await Promise.all(ps);
    expect(results.every((r) => r?.clientKey === URL_ID)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    // Once settled, the in-flight entry is gone (fresh cache now serves it).
    expect(await resolver.resolve(URL_ID)).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("negatively caches failures for 60 s", async () => {
    let t = new Date("2026-10-20T00:00:00Z");
    const { resolver, fetchFn, lookup } = setup({
      now: () => t,
      fetch: (async () => jsonResponse(doc(), { status: 404 })) as typeof fetch,
    });
    expect(await resolver.resolve(URL_ID)).toBeNull();
    t = new Date(t.getTime() + 59 * 1000);
    expect(await resolver.resolve(URL_ID)).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    t = new Date(t.getTime() + 2 * 1000);
    expect(await resolver.resolve(URL_ID)).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("negatively caches blocked-address and network failures without calling fetch again", async () => {
    let t = new Date("2026-10-20T00:00:00Z");
    const ssrf = setup({ now: () => t, lookup: async () => [{ address: "10.0.0.1", family: 4 }] });
    await ssrf.resolver.resolve(URL_ID);
    await ssrf.resolver.resolve(URL_ID);
    expect(ssrf.lookup).toHaveBeenCalledTimes(1);
    const net = setup({ now: () => t, fetch: (async () => { throw new TypeError("down"); }) as typeof fetch });
    await net.resolver.resolve(URL_ID);
    await net.resolver.resolve(URL_ID);
    expect(net.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("serves the stale entry during the negative-cache window after a transient failure", async () => {
    let t = new Date("2026-10-20T00:00:00Z");
    let fail = false;
    const { resolver, fetchFn } = setup({
      now: () => t,
      fetch: (async () => {
        if (fail) throw new TypeError("down");
        return jsonResponse(doc());
      }) as typeof fetch,
    });
    await resolver.resolve(URL_ID);
    t = new Date(t.getTime() + 3600 * 1000);
    fail = true;
    expect(await resolver.resolve(URL_ID)).not.toBeNull();
    expect(await resolver.resolve(URL_ID)).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("returns null without fetching once 8 CIMD fetches are already in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { resolver, fetchFn } = setup({
      fetch: (async (u: string) => {
        await gate;
        return jsonResponse(doc({ client_id: u }));
      }) as unknown as typeof fetch,
    });
    const urls = Array.from({ length: 9 }, (_, i) => `https://client${i}.example.com/meta`);
    const first8 = urls.slice(0, 8).map((u) => resolver.resolve(u));
    await new Promise((r) => setTimeout(r, 5));
    expect(await resolver.resolve(urls[8]!)).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(8);
    release();
    expect((await Promise.all(first8)).every((r) => r !== null)).toBe(true);
    // Capacity is released, and saturation was not negatively cached.
    expect(await resolver.resolve(urls[8]!)).not.toBeNull();
  });

  it("strips control and bidi characters from client_name and caps it at 100 chars", async () => {
    const cases: Array<[string, string | undefined]> = [
      ["Cla\u202Eude\u0000\u0007", "Claude"],
      ["\u2066Evil\u2069 \u200FApp\u009B", "Evil App"],
      ["x".repeat(150), "x".repeat(100)],
      ["\u202E\u0000", undefined],
    ];
    for (const [client_name, expected] of cases) {
      const { resolver } = setup({ fetch: (async () => jsonResponse(doc({ client_name }))) as typeof fetch });
      expect((await resolver.resolve(URL_ID))?.name, JSON.stringify(client_name)).toBe(expected ?? "claude.ai");
    }
  });

  it("aborts a fetch that exceeds the timeout", async () => {
    const { resolver } = setup({
      timeoutMs: 20,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })) as unknown as typeof fetch,
    });
    expect(await resolver.resolve(URL_ID)).toBeNull();
  });

  it("uses a 5 s timeout by default", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const { resolver } = setup({
        fetch: ((_url: string, init: RequestInit) => {
          signal = init.signal ?? undefined;
          return new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(signal?.reason)));
        }) as unknown as typeof fetch,
      });
      const p = resolver.resolve(URL_ID);
      await vi.advanceTimersByTimeAsync(4999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(signal?.aborted).toBe(true);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pinnedLookup (connect-time DNS guard)", () => {
  const call = (
    lookup: CimdLookup,
    opts: { all?: boolean; family?: number },
  ): Promise<{ err: NodeJS.ErrnoException | null; address?: unknown; family?: number }> =>
    new Promise((resolve) => {
      pinnedLookup(lookup)("client.example.com", opts, (err, address, family) => resolve({ err, address, family }));
    });

  it("returns only vetted addresses, in both callback shapes", async () => {
    const lookup: CimdLookup = async () => [{ address: "160.79.104.10", family: 4 }, { address: "2606:4700::1", family: 6 }];
    const single = await call(lookup, {});
    expect(single).toEqual({ err: null, address: "160.79.104.10", family: 4 });
    const all = await call(lookup, { all: true });
    expect(all.err).toBeNull();
    expect(all.address).toEqual([{ address: "160.79.104.10", family: 4 }, { address: "2606:4700::1", family: 6 }]);
  });

  it("fails the connection if any resolved address is blocked (DNS rebinding)", async () => {
    const lookup: CimdLookup = async () => [{ address: "160.79.104.10", family: 4 }, { address: "169.254.169.254", family: 4 }];
    const r = await call(lookup, { all: true });
    expect(r.err?.code).toBe("ECIMDBLOCKED");
    expect(r.address).toBeUndefined();
  });

  it("propagates lookup errors", async () => {
    const r = await call(async () => { throw Object.assign(new Error("nope"), { code: "ENOTFOUND" }); }, {});
    expect(r.err?.code).toBe("ENOTFOUND");
  });
});

describe("createPinnedHttpsFetch", () => {
  it("refuses non-https URLs and IP-literal hosts (which would bypass socket lookup)", async () => {
    const lookup = vi.fn(publicLookup);
    const f = createPinnedHttpsFetch(lookup);
    for (const u of ["http://client.example.com/meta", "https://10.0.0.1/meta", "https://[::1]/meta", "https://169.254.169.254/latest"]) {
      await expect(f(u), u).rejects.toThrow();
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("fails the request at connect time when the host resolves to a blocked address", async () => {
    const lookup = vi.fn<CimdLookup>(async () => [{ address: "169.254.169.254", family: 4 }]);
    const f = createPinnedHttpsFetch(lookup);
    await expect(f("https://rebind.example.com/meta", { signal: AbortSignal.timeout(2000) })).rejects.toMatchObject({
      code: "ECIMDBLOCKED",
    });
    expect(lookup).toHaveBeenCalledWith("rebind.example.com");
  });
});
