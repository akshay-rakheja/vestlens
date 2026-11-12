import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JevClient, JevError, JEV_URL } from "./jev.js";

const KEY = "ts_secret_key_ZZTEST_0123456789";
const STATE = {
  ticker: "ZZTEST",
  company: "Zz Test Corp",
  article: { headline: "Zz Test Corp reports results", snippet: "Revenue rose.", source: "example.com", published_at: "2026-10-20T12:00:00.000Z" },
  candidates: { c1: { headline: "Zz Test Corp results out", source: "other.example", published_at: "2026-10-20T13:00:00.000Z" } },
};

const ANSWERS = {
  relevant: { type: "noul", noul: 0.91 },
  sentiment: { type: "score", score: 3.2, confidence: 0.7, probabilities: [0, 0.05, 0.1, 0.45, 0.4] },
  materiality: { type: "score", score: 2.1, confidence: 0.6, probabilities: [0.05, 0.1, 0.55, 0.3] },
  event_type: { type: "choice", choice: "earnings", confidence: 0.83, probabilities: { earnings: 0.83, other: 0.17 } },
  credible: { type: "noul", noul: 0.8 },
  clickbait: { type: "noul", noul: 0.1 },
  dup_c1: { type: "noul", noul: 0.75 },
};

type Call = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } };

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  };
}

function client(responses: Array<ReturnType<typeof response> | "hang">, log = vi.fn()) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: Call["init"]) => {
    calls.push({ url, init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("no more responses");
    if (next === "hang") {
      return new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    return next;
  });
  return { jev: new JevClient({ apiKey: KEY, model: "jev-1.13.0", fetch, log }), calls, fetch, log };
}

const ok = () => response(200, { model: "jev-1.13.0", answers: ANSWERS, usage: { input_tokens: 100 } });

describe("JevClient", () => {
  afterEach(() => vi.useRealTimers());

  it("posts model, state and every question in one request with the bearer key", async () => {
    const { jev, calls } = client([ok()]);
    await jev.rate(STATE, ["c1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(JEV_URL);
    expect(JEV_URL).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" });
    const body = JSON.parse(calls[0].init.body!);
    expect(body.model).toBe("jev-1.13.0");
    expect(body.state).toEqual(STATE);
    expect(Object.keys(body.questions)).toEqual(["relevant", "sentiment", "materiality", "event_type", "credible", "clickbait", "dup_c1"]);
    expect(body.questions.relevant.type).toBe("noul");
    expect(body.questions.sentiment.type).toBe("score");
    expect(body.questions.event_type.type).toBe("choice");
  });

  it("parses noul, score and choice answers", async () => {
    const { jev } = client([ok()]);
    await expect(jev.rate(STATE, ["c1"])).resolves.toEqual({
      relevant: 0.91,
      sentiment: { score: 3.2, confidence: 0.7 },
      materiality: { score: 2.1, confidence: 0.6 },
      eventType: { choice: "earnings", confidence: 0.83 },
      credible: 0.8,
      clickbait: 0.1,
      duplicates: { c1: 0.75 },
    });
  });

  it("rejects a malformed or incomplete response", async () => {
    const { relevant: _r, ...missing } = ANSWERS;
    const { jev } = client([response(200, { model: "jev-1.13.0", answers: missing })]);
    await expect(jev.rate(STATE, ["c1"])).rejects.toMatchObject({ name: "JevError", reason: "malformed" });
    const { jev: jev2 } = client([response(200, { model: "x", answers: { ...ANSWERS, sentiment: { type: "noul", noul: 1 } } })]);
    await expect(jev2.rate(STATE, ["c1"])).rejects.toBeInstanceOf(JevError);
  });

  it("retries 429 honouring retry-after seconds", async () => {
    vi.useFakeTimers();
    const { jev, fetch } = client([response(429, {}, { "retry-after": "3" }), ok()]);
    const done = jev.rate(STATE, ["c1"]);
    await vi.advanceTimersByTimeAsync(2_900);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(done).resolves.toMatchObject({ relevant: 0.91 });
  });

  it("caps retry-after at 30 seconds", async () => {
    vi.useFakeTimers();
    const { jev, fetch } = client([response(429, {}, { "retry-after": "120" }), ok()]);
    const done = jev.rate(STATE, ["c1"]);
    await vi.advanceTimersByTimeAsync(29_900);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(done).resolves.toMatchObject({ relevant: 0.91 });
  });

  it("falls back to 1 s then 2 s backoff when retry-after is not numeric", async () => {
    vi.useFakeTimers();
    const { jev, fetch } = client([response(429, {}, { "retry-after": "soon" }), response(529, {}, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }), ok()]);
    const done = jev.rate(STATE, ["c1"]);
    await vi.advanceTimersByTimeAsync(990);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_980);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(fetch).toHaveBeenCalledTimes(3);
    await expect(done).resolves.toMatchObject({ relevant: 0.91 });
  });

  it("drains non-OK response bodies before throwing or retrying", async () => {
    vi.useFakeTimers();
    const limited = response(429, {}, { "retry-after": "1" });
    const denied = response(401, {});
    const texts = [vi.spyOn(limited, "text"), vi.spyOn(denied, "text")];
    const { jev } = client([limited, denied]);
    const settled = jev.rate(STATE, []).catch((e) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await settled).toMatchObject({ reason: "http_401" });
    for (const t of texts) expect(t).toHaveBeenCalledTimes(1);
  });

  it("truncates headlines to 300 and the snippet to 200 characters before sending", async () => {
    const { jev, calls } = client([ok()]);
    const long = {
      ...STATE,
      article: { ...STATE.article, headline: "h".repeat(400), snippet: "s".repeat(300) },
      candidates: { c1: { ...STATE.candidates.c1, headline: "c".repeat(400) } },
    };
    await jev.rate(long, ["c1"]);
    const sent = JSON.parse(calls[0].init.body!).state;
    expect(sent.article.headline).toBe("h".repeat(300));
    expect(sent.article.snippet).toBe("s".repeat(200));
    expect(sent.candidates.c1.headline).toBe("c".repeat(300));
    expect(sent.article.source).toBe(STATE.article.source);
    const { jev: nullSnippet, calls: c2 } = client([ok()]);
    await nullSnippet.rate({ ...STATE, article: { ...STATE.article, snippet: null } }, ["c1"]);
    expect(JSON.parse(c2[0].init.body!).state.article.snippet).toBeNull();
  });

  it("rejects response bodies over 256 KB as malformed", async () => {
    const declared = response(200, { model: "jev-1.13.0", answers: ANSWERS }, { "content-length": String(256 * 1024 + 1) });
    const declaredText = vi.spyOn(declared, "text");
    const { jev } = client([declared]);
    await expect(jev.rate(STATE, ["c1"])).rejects.toMatchObject({ reason: "malformed" });
    expect(declaredText).not.toHaveBeenCalled();
    const huge = response(200, { model: "jev-1.13.0", answers: ANSWERS, pad: "x".repeat(256 * 1024) });
    const { jev: jev2 } = client([huge]);
    await expect(jev2.rate(STATE, ["c1"])).rejects.toMatchObject({ reason: "malformed" });
    const { jev: jev3 } = client([{ ...ok(), text: async () => "{not json" }]);
    await expect(jev3.rate(STATE, ["c1"])).rejects.toMatchObject({ reason: "malformed" });
  });

  it("retries 529 with backoff and gives up after three attempts", async () => {
    vi.useFakeTimers();
    const { jev, fetch } = client([response(529, {}), response(529, {}), response(529, {}), ok()]);
    const done = jev.rate(STATE, ["c1"]);
    const settled = done.catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await settled).toMatchObject({ name: "JevError", reason: "http_529" });
  });

  it.each([400, 401, 413, 422, 500])("does not retry %i", async (status) => {
    const { jev, fetch } = client([response(status, { error: "bad" }), ok()]);
    await expect(jev.rate(STATE, [])).rejects.toMatchObject({ reason: `http_${status}` });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("times out each attempt after 10 seconds", async () => {
    vi.useFakeTimers();
    const { jev, fetch, calls } = client(["hang", ok()]);
    const settled = jev.rate(STATE, ["c1"]).catch((e) => e);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls[0].init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toMatchObject({ name: "JevError", reason: "timeout" });
    expect(calls[0].init.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never puts the key in logs or errors", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const { jev } = client([response(429, { echo: KEY }, { "retry-after": "1" }), response(401, { echo: KEY })], log);
      const settled = jev.rate(STATE, []).catch((e) => e);
      await vi.advanceTimersByTimeAsync(5_000);
      const err = await settled;
      expect(err).toBeInstanceOf(JevError);
      const thrown = `${err.message} ${err.stack} ${JSON.stringify(err)} ${String(err)}`;
      expect(thrown).not.toContain(KEY);
      const { jev: net } = client([], log);
      const netErr = await net.rate(STATE, []).catch((e) => e);
      expect(`${netErr.message} ${netErr.stack} ${JSON.stringify(netErr)}`).not.toContain(KEY);
      expect(log).toHaveBeenCalled();
      const logged = JSON.stringify([log.mock.calls, ...spies.map((s) => s.mock.calls)]);
      expect(logged).not.toContain(KEY);
      expect(logged).not.toContain("Zz Test Corp");
      expect(JSON.stringify(jev)).not.toContain(KEY);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
