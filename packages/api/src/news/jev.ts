// TypeSafe Jev (System One) client. The @typesafe-ai/sdk package is not used (it could not be
// installed offline); this calls the documented HTTP API through the injected fetch.
// The API key is held in a #private field: it never appears in logs, errors or serialisation.
import type { FetchLike } from "../market-data/types.js";
import { buildQuestions, dupQuestionId } from "./questions.js";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-1.13.0";
const ATTEMPT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000;
const MAX_RETRY_AFTER_MS = 30_000;
export const MAX_HEADLINE_CHARS = 300;
export const MAX_SNIPPET_CHARS = 200;
export const MAX_RESPONSE_BYTES = 256 * 1024;

export interface JevAnswers {
  relevant: number;
  sentiment: { score: number; confidence: number };
  materiality: { score: number; confidence: number };
  eventType: { choice: string; confidence: number };
  credible: number;
  clickbait: number;
  duplicates: Record<string, number>;
}

export interface JevState {
  ticker: string;
  company: string;
  article: { headline: string; snippet: string | null; source: string; published_at: string };
  candidates: Record<string, { headline: string; source: string; published_at: string }>;
}

/** FetchLike plus the POST fields this client sends; any FetchLike (and the global fetch) is assignable. */
export type JevFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => ReturnType<FetchLike>;

export type JevLogEvent =
  | { event: "jev_request"; model: string; attempts: number; latencyMs: number; outcome: "ok" | JevFailure }
  | { event: "jev_rate_limited"; model: string; status: number; attempt: number; waitMs: number };

export type JevFailure = "timeout" | "network" | "malformed" | `http_${number}`;

export class JevError extends Error {
  constructor(readonly reason: JevFailure) {
    super(`TypeSafe Jev request failed: ${reason}`);
    this.name = "JevError";
  }
  toJSON() {
    return { name: this.name, reason: this.reason };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function noul(answers: Record<string, unknown>, id: string): number {
  const a = answers[id];
  if (!isObj(a) || a.type !== "noul" || !isNum(a.noul)) throw new JevError("malformed");
  return a.noul;
}
function score(answers: Record<string, unknown>, id: string): { score: number; confidence: number } {
  const a = answers[id];
  if (!isObj(a) || a.type !== "score" || !isNum(a.score) || !isNum(a.confidence)) throw new JevError("malformed");
  return { score: a.score, confidence: a.confidence };
}
function choice(answers: Record<string, unknown>, id: string): { choice: string; confidence: number } {
  const a = answers[id];
  if (!isObj(a) || a.type !== "choice" || typeof a.choice !== "string" || !isNum(a.confidence)) throw new JevError("malformed");
  return { choice: a.choice, confidence: a.confidence };
}

function parse(body: unknown, candidateIds: string[]): JevAnswers {
  if (!isObj(body) || !isObj(body.answers)) throw new JevError("malformed");
  const answers = body.answers;
  return {
    relevant: noul(answers, "relevant"),
    sentiment: score(answers, "sentiment"),
    materiality: score(answers, "materiality"),
    eventType: choice(answers, "event_type"),
    credible: noul(answers, "credible"),
    clickbait: noul(answers, "clickbait"),
    duplicates: Object.fromEntries(candidateIds.map((id) => [id, noul(answers, dupQuestionId(id))])),
  };
}

/** Bounds what leaves the server: headlines to 300 characters, the snippet to 200. */
function boundState(state: JevState): JevState {
  return {
    ticker: state.ticker,
    company: state.company,
    article: {
      headline: state.article.headline.slice(0, MAX_HEADLINE_CHARS),
      snippet: state.article.snippet === null ? null : state.article.snippet.slice(0, MAX_SNIPPET_CHARS),
      source: state.article.source,
      published_at: state.article.published_at,
    },
    candidates: Object.fromEntries(
      Object.entries(state.candidates).map(([id, c]) => [id, { headline: c.headline.slice(0, MAX_HEADLINE_CHARS), source: c.source, published_at: c.published_at }]),
    ),
  };
}

function retryAfterMs(res: Awaited<ReturnType<FetchLike>>, attempt: number): number {
  const header = res.headers?.get("retry-after");
  const seconds = header == null ? NaN : Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

export class JevClient {
  readonly #apiKey: string;
  readonly #fetch: JevFetch;
  readonly #now: () => Date;
  readonly #log: (e: JevLogEvent) => void;
  readonly model: string;

  constructor(o: { apiKey: string; model: string; fetch: FetchLike | JevFetch; now?: () => Date; log?: (e: JevLogEvent) => void }) {
    this.#apiKey = o.apiKey;
    this.model = o.model;
    this.#fetch = o.fetch as JevFetch;
    this.#now = o.now ?? (() => new Date());
    this.#log = o.log ?? ((e) => console.info(JSON.stringify(e)));
  }

  /** One request carrying every question. Retries only 429/529 (max 3 attempts); 10 s per attempt. */
  async rate(state: JevState, candidateIds: string[]): Promise<JevAnswers> {
    const body = JSON.stringify({ model: this.model, state: boundState(state), questions: buildQuestions(candidateIds) });
    const started = this.#now().getTime();
    let attempt = 0;
    const finish = (outcome: "ok" | JevFailure) =>
      this.#log({ event: "jev_request", model: this.model, attempts: attempt, latencyMs: this.#now().getTime() - started, outcome });
    try {
      for (;;) {
        attempt += 1;
        const { res, json } = await this.#attempt(body);
        if (res.ok) {
          const parsed = parse(json, candidateIds);
          finish("ok");
          return parsed;
        }
        if ((res.status === 429 || res.status === 529) && attempt < MAX_ATTEMPTS) {
          const waitMs = retryAfterMs(res, attempt);
          this.#log({ event: "jev_rate_limited", model: this.model, status: res.status, attempt, waitMs });
          await sleep(waitMs);
          continue;
        }
        throw new JevError(`http_${res.status}`);
      }
    } catch (error) {
      const reason = error instanceof JevError ? error.reason : "network";
      finish(reason);
      throw error instanceof JevError ? error : new JevError("network");
    }
  }

  /** One attempt; the deadline covers the headers and, on success, the body. */
  #attempt(body: string): Promise<{ res: Awaited<ReturnType<FetchLike>>; json: unknown }> {
    return this.#withDeadline(async (signal) => {
      const res = await this.#fetch(JEV_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body,
        signal,
      });
      if (!res.ok) {
        // Drain the body so the connection can be reused; its content is never read or reported.
        await res.text().catch(() => {});
        return { res, json: undefined };
      }
      // FetchLike exposes no body stream: a declared Content-Length over the cap is rejected unread;
      // otherwise the text is read and its byte length checked before parsing.
      const declared = Number(res.headers?.get("content-length") ?? NaN);
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new JevError("malformed");
      let json: unknown;
      try {
        const text = await res.text();
        if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new JevError("malformed");
        json = JSON.parse(text);
      } catch (error) {
        if (signal.aborted) throw new JevError("timeout");
        if (error instanceof JevError) throw error;
        throw new JevError("malformed");
      }
      return { res, json };
    });
  }

  async #withDeadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new JevError("timeout"));
      }, ATTEMPT_TIMEOUT_MS);
    });
    try {
      return await Promise.race([run(controller.signal), deadline]);
    } catch (error) {
      if (error instanceof JevError) throw error;
      throw new JevError("network");
    } finally {
      clearTimeout(timer);
    }
  }
}
