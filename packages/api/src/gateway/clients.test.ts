import { describe, expect, it, vi } from "vitest";

import { CimdResolver } from "./cimd.js";
import { ClientRegistry, VERIFIED_HOSTS, type ResolvedClient } from "./clients.js";
import { sha256 } from "./crypto.js";
import { MemoryGatewayStore } from "./store.js";

const IP = "iphash-1";

function setup(o: { maxClients?: number; now?: () => Date } = {}) {
  const store = new MemoryGatewayStore();
  const cimd = new CimdResolver({
    store,
    fetch: vi.fn(async () => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    lookup: async () => [{ address: "160.79.104.10", family: 4 }],
  });
  const registry = new ClientRegistry({ store, cimd, now: o.now, maxClients: o.maxClients });
  return { store, cimd, registry };
}

const good = { redirect_uris: ["http://127.0.0.1:8080/callback"], client_name: "Codex" };

describe("VERIFIED_HOSTS", () => {
  it("lists exactly claude.ai and chatgpt.com", () => {
    expect([...VERIFIED_HOSTS]).toEqual(["claude.ai", "chatgpt.com"]);
  });
});

describe("ClientRegistry.register", () => {
  it("registers a public client with defaults", async () => {
    const t = new Date("2026-10-20T12:00:00Z");
    const { registry, store } = setup({ now: () => t });
    const res = await registry.register(good, IP);
    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(typeof body.client_id).toBe("string");
    expect((body.client_id as string).startsWith("https://")).toBe(false);
    expect(body).toEqual({
      client_id: body.client_id,
      client_id_issued_at: Math.floor(t.getTime() / 1000),
      redirect_uris: ["http://127.0.0.1:8080/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Codex",
    });
    expect(body).not.toHaveProperty("client_secret");
    expect(body).not.toHaveProperty("client_secret_expires_at");
    const stored = await store.getClient(body.client_id as string);
    expect(stored).toMatchObject({ clientSecretHash: null, tokenEndpointAuthMethod: "none", clientName: "Codex", createdAt: t });
  });

  it("issues a one-time secret for client_secret_post and stores only its hash", async () => {
    const { registry, store } = setup();
    const res = await registry.register({ ...good, token_endpoint_auth_method: "client_secret_post" }, IP);
    expect(res.status).toBe(201);
    const body = res.body as Record<string, string>;
    expect(body.token_endpoint_auth_method).toBe("client_secret_post");
    expect(body.client_secret.length).toBeGreaterThanOrEqual(43);
    expect((res.body as Record<string, unknown>).client_secret_expires_at).toBe(0);
    const stored = await store.getClient(body.client_id);
    expect(stored?.clientSecretHash).toBe(sha256(body.client_secret));
    expect(JSON.stringify(stored)).not.toContain(body.client_secret);
    const resolved = await registry.resolve(body.client_id);
    expect(resolved?.clientSecretHash).toBe(sha256(body.client_secret));
  });

  it("issues distinct client ids", async () => {
    const { registry } = setup();
    const a = await registry.register(good, IP);
    const b = await registry.register(good, IP);
    expect((a.body as Record<string, unknown>).client_id).not.toBe((b.body as Record<string, unknown>).client_id);
  });

  it("accepts explicit allowed grant/response types and echoes them", async () => {
    const { registry } = setup();
    const res = await registry.register({ ...good, grant_types: ["authorization_code"], response_types: ["code"] }, IP);
    expect(res.status).toBe(201);
    expect((res.body as Record<string, unknown>).grant_types).toEqual(["authorization_code"]);
  });

  const invalid: Array<[string, unknown, string]> = [
    ["non-object", "nope", "invalid_client_metadata"],
    ["null", null, "invalid_client_metadata"],
    ["missing redirect_uris", { client_name: "x" }, "invalid_redirect_uri"],
    ["empty redirect_uris", { redirect_uris: [] }, "invalid_redirect_uri"],
    ["non-loopback http", { redirect_uris: ["http://example.com/cb"] }, "invalid_redirect_uri"],
    ["loopback lookalike", { redirect_uris: ["http://127.0.0.1.evil.com/cb"] }, "invalid_redirect_uri"],
    ["custom scheme", { redirect_uris: ["cursor://cb"] }, "invalid_redirect_uri"],
    ["javascript", { redirect_uris: ["javascript:alert(1)"] }, "invalid_redirect_uri"],
    ["fragment", { redirect_uris: ["https://ok.example/cb#x"] }, "invalid_redirect_uri"],
    ["one bad among good", { redirect_uris: ["https://ok.example/cb", "http://evil.example/cb"] }, "invalid_redirect_uri"],
    ["too many redirect_uris", { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://ok.example/cb${i}`) }, "invalid_redirect_uri"],
    ["very long redirect_uri", { redirect_uris: [`https://ok.example/${"a".repeat(2100)}`] }, "invalid_redirect_uri"],
    ["client_credentials grant", { ...good, grant_types: ["authorization_code", "client_credentials"] }, "invalid_client_metadata"],
    ["implicit grant", { ...good, grant_types: ["implicit"] }, "invalid_client_metadata"],
    ["empty grant_types", { ...good, grant_types: [] }, "invalid_client_metadata"],
    ["token response type", { ...good, response_types: ["code", "token"] }, "invalid_client_metadata"],
    ["client_secret_basic", { ...good, token_endpoint_auth_method: "client_secret_basic" }, "invalid_client_metadata"],
    ["private_key_jwt", { ...good, token_endpoint_auth_method: "private_key_jwt" }, "invalid_client_metadata"],
    ["non-string client_name", { ...good, client_name: 5 }, "invalid_client_metadata"],
    ["non-canonical https redirect", { redirect_uris: ["https:///x"] }, "invalid_redirect_uri"],
    ["redirect with empty fragment", { redirect_uris: ["https://ok.example/cb#"] }, "invalid_redirect_uri"],
    ["redirect with dot segments", { redirect_uris: ["https://ok.example/a/../cb"] }, "invalid_redirect_uri"],
  ];
  for (const [label, body, error] of invalid) {
    it(`rejects ${label} with 400 ${error}`, async () => {
      const { registry, store } = setup();
      const res = await registry.register(body, IP);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error });
      expect(typeof (res.body as { error_description: string }).error_description).toBe("string");
      expect(await store.countClients()).toBe(0);
    });
  }

  it("strips control/bidi characters from client_name and caps it at 100 chars", async () => {
    const { registry, store } = setup();
    const cases: Array<[string, string | undefined]> = [
      ["Co\u202Edex\u0000\u001F\u007F", "Codex"],
      ["\u2067My\u200E App\u0085", "My App"],
      ["y".repeat(150), "y".repeat(100)],
      ["\u202E\u0001", undefined],
    ];
    for (const [client_name, expected] of cases) {
      const res = await registry.register({ ...good, client_name }, `ip-${client_name.length}-${expected}`);
      expect(res.status).toBe(201);
      const body = res.body as Record<string, unknown>;
      expect(body.client_name, JSON.stringify(client_name)).toBe(expected);
      const stored = await store.getClient(body.client_id as string);
      expect(stored?.clientName ?? undefined).toBe(expected);
    }
  });

  it("rate limits to 20 registrations per IP hash per hour (sliding window)", async () => {
    let t = new Date("2026-10-20T12:00:00Z");
    const { registry } = setup({ now: () => t });
    for (let i = 0; i < 20; i += 1) {
      expect((await registry.register(good, IP)).status).toBe(201);
      t = new Date(t.getTime() + 60 * 1000);
    }
    const limited = await registry.register(good, IP);
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: "temporarily_unavailable" });
    // A different IP hash is unaffected.
    expect((await registry.register(good, "iphash-2")).status).toBe(201);
    // One hour after the first registration, one slot frees up.
    t = new Date("2026-10-20T13:00:00.001Z");
    expect((await registry.register(good, IP)).status).toBe(201);
    expect((await registry.register(good, IP)).status).toBe(429);
  });

  it("also limits each IPv6 /48 prefix hash to 100 registrations per hour", async () => {
    let t = new Date("2026-10-20T12:00:00Z");
    const { registry } = setup({ now: () => t });
    for (let i = 0; i < 100; i += 1) {
      expect((await registry.register(good, `slash64-${i}`, "slash48-a")).status).toBe(201);
    }
    const limited = await registry.register(good, "slash64-new", "slash48-a");
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: "temporarily_unavailable" });
    expect((await registry.register(good, "slash64-new", "slash48-b")).status).toBe(201);
    expect((await registry.register(good, "slash64-other", null)).status).toBe(201);
    t = new Date("2026-10-20T13:00:00.001Z");
    expect((await registry.register(good, "slash64-later", "slash48-a")).status).toBe(201);
  });

  it("caps the rate-limit map at 50k keys, evicting the oldest", async () => {
    const t = new Date("2026-10-20T12:00:00Z");
    const { registry } = setup({ now: () => t });
    const r = registry as unknown as { attempts: Map<string, number[]> };
    for (let i = 0; i < 50_000; i += 1) r.attempts.set(`k${i}`, [t.getTime()]);
    await registry.register({ redirect_uris: [] }, "newcomer");
    expect(r.attempts.size).toBe(50_000);
    expect(r.attempts.has("k0")).toBe(false);
    expect(r.attempts.has("newcomer")).toBe(true);
  });

  it("sweeps expired keys at most once per minute", async () => {
    let t = new Date("2026-10-20T12:00:00Z");
    const { registry } = setup({ now: () => t });
    const r = registry as unknown as { attempts: Map<string, number[]> };
    await registry.register({ redirect_uris: [] }, "a"); // first call sweeps (nothing to sweep)
    r.attempts.set("expired", [t.getTime() - 2 * 3600 * 1000]);
    t = new Date(t.getTime() + 30 * 1000);
    await registry.register({ redirect_uris: [] }, "b");
    expect(r.attempts.has("expired")).toBe(true);
    t = new Date(t.getTime() + 31 * 1000);
    await registry.register({ redirect_uris: [] }, "c");
    expect(r.attempts.has("expired")).toBe(false);
  });

  it("counts invalid attempts toward the per-IP limit", async () => {
    const { registry } = setup();
    for (let i = 0; i < 20; i += 1) await registry.register({ redirect_uris: [] }, IP);
    expect((await registry.register(good, IP)).status).toBe(429);
  });

  it("returns 429 once the global client cap is reached", async () => {
    const { registry } = setup({ maxClients: 2 });
    expect((await registry.register(good, "a")).status).toBe(201);
    expect((await registry.register(good, "b")).status).toBe(201);
    const res = await registry.register(good, "c");
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "temporarily_unavailable" });
  });

  it("defaults the global cap to 5000", async () => {
    const { registry, store } = setup();
    vi.spyOn(store, "countClients").mockResolvedValue(5000);
    expect((await registry.register(good, IP)).status).toBe(429);
    vi.spyOn(store, "countClients").mockResolvedValue(4999);
    expect((await registry.register(good, IP)).status).toBe(201);
  });
});

describe("ClientRegistry.resolve", () => {
  it("resolves a DCR client id", async () => {
    const { registry } = setup();
    const res = await registry.register(good, IP);
    const id = (res.body as Record<string, string>).client_id;
    const c = await registry.resolve(id);
    expect(c).toEqual<ResolvedClient>({
      clientKey: id,
      kind: "dcr",
      name: "Codex",
      redirectUris: ["http://127.0.0.1:8080/callback"],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      clientSecretHash: null,
      verifiedHost: false,
    });
  });

  it("stores and resolves the registered grant types", async () => {
    const { registry, store } = setup();
    const res = await registry.register({ ...good, grant_types: ["authorization_code"] }, IP);
    const id = (res.body as Record<string, string>).client_id;
    expect((await store.getClient(id))?.grantTypes).toEqual(["authorization_code"]);
    expect((await registry.resolve(id))?.grantTypes).toEqual(["authorization_code"]);
  });

  it("returns null for unknown ids", async () => {
    const { registry } = setup();
    expect(await registry.resolve("nope")).toBeNull();
    expect(await registry.resolve("")).toBeNull();
  });

  it("routes https URLs to the CIMD resolver, never to the DCR store", async () => {
    const { registry, cimd, store } = setup();
    const resolved: ResolvedClient = {
      clientKey: "https://claude.ai/meta",
      kind: "cimd",
      name: "Claude",
      redirectUris: ["https://claude.ai/cb"],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      clientSecretHash: null,
      verifiedHost: true,
    };
    const spy = vi.spyOn(cimd, "resolve").mockResolvedValue(resolved);
    const getClient = vi.spyOn(store, "getClient");
    expect(await registry.resolve("https://claude.ai/meta")).toBe(resolved);
    expect(spy).toHaveBeenCalledWith("https://claude.ai/meta");
    expect(getClient).not.toHaveBeenCalled();
  });

  it("does not treat http URLs as CIMD", async () => {
    const { registry, cimd } = setup();
    const spy = vi.spyOn(cimd, "resolve");
    expect(await registry.resolve("http://claude.ai/meta")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
