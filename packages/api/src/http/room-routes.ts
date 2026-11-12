import type { Express, RequestHandler, Response } from "express";
import { z } from "zod";

import { cad, isOutgoing, newYearText, roomAccounts, type RoomDeps } from "../mcp/room-tools.js";
import { HASH_KEY_PATTERN, outsideAccountKey } from "../memory/keys.js";
import type { MemoryService } from "../memory/memory-service.js";
import { PROPERTY_REGISTRY, type MemoryFactInput } from "../memory/memory-types.js";
import { computeFhsaRoom, countedFhsas, type FhsaRoomInput, type FhsaRoomResult } from "../room/fhsa-room.js";
import { loadFhsaRoomInput, loadRoomInput, loadRrspRoomInput, torontoToday } from "../room/room-loader.js";
import { computeRrspRoom, type RrspRoomInput, type RrspRoomResult } from "../room/rrsp-room.js";
import type { RoomActivity, RoomFxPort } from "../room/room-common.js";
import { answerable, computeTfsaRoom, countedTfsas, MAX_AMBIGUOUS_ROWS, type RoomInput, type RoomResult } from "../room/tfsa-room.js";
import type { UserRoomEffect } from "../room/tfsa-rules.js";
import { INVALID_MEMORY_EDIT, memoryOutcome } from "./memory-outcome.js";

export interface RoomRoutesDeps {
  room: RoomDeps;
  /** Without it only the read route is mounted. */
  memory?: MemoryService;
  /** authenticateManage(). */
  guards: RequestHandler[];
  now: () => Date;
  /** Counts and constant codes only. */
  log: (event: { event: "room_dashboard"; status: RoomResult["status"]; alert: boolean } | { event: "fhsa_room_dashboard"; status: FhsaRoomResult["status"] }
    | { event: "rrsp_room_dashboard"; status: RrspRoomResult["status"] }
    | { event: "room_input_saved" | "room_input_cleared"; input: string }) => void;
}

type Outcome = { roomLeftCad: number | null; excessCad: number | null };
/** Incoming rows are previewed as a contribution or not; outgoing ones (a negative amount) as a withdrawal or not. */
export type RoomOutcomes = Record<string, { asContribution: Outcome; asNone: Outcome } | { asWithdrawal: Outcome; asNone: Outcome }>;

const year = z.number().int().min(2009).max(2100);
const amountCad = z.number().finite().min(0);
const hashKey = z.string().regex(HASH_KEY_PATTERN);
const craBody = z.strictObject({ year, amountCad });
/** The FHSA began in 2023: no participation room before then. */
const fhsaBody = z.strictObject({ year: year.min(2023), amountCad });
const accountsBody = z.strictObject({
  year,
  connected: z.array(hashKey).max(100),
  notTfsa: z.array(hashKey).max(100).default([]),
  outside: z.array(z.strictObject({ label: z.string().min(1).max(60) })).max(20),
});
const movesBody = z.strictObject({
  year,
  entries: z.array(z.strictObject({ date: z.iso.date(), amountCad, kind: z.enum(["deposit", "withdrawal"]) })).max(200),
});
/** The RRSP deduction limit, and optionally the unused contributions CRA shows beside it. */
const rrspLimitBody = z.strictObject({ year, amountCad, unusedCad: amountCad.optional() });
const effectBody = z.strictObject({ effect: z.enum(["contribution", "withdrawal", "none"]) });
/** A managed portfolio's year-to-date contributions, as of a date (account.ytd_contributions; review 6). */
const managedBody = z.strictObject({ year, amountCad, asOf: z.iso.date() });
const labelParam = z.string().min(1).max(60);

const NOT_FOUND = { error: "not_found" } as const;
const SET_SCHEMA = PROPERTY_REGISTRY["tax_year.account_set"]!.schema!;

/** The stored account set as the user confirmed it (this year's, or the latest earlier one), or null when none parses. */
export function roomAccountSet(input: RoomInput, which: "current" | "previous" = "current"): { connected: string[]; notTfsa: string[]; outside: { label: string }[] } | null {
  const fact = which === "current" ? input.memory.accountSet : input.previousAccountSet ?? null;
  const parsed = fact ? SET_SCHEMA.safeParse(fact.value) : null;
  if (!parsed?.success) return null;
  const { connected, notTfsa, outside } = parsed.data as { connected: string[]; notTfsa: string[]; outside: { label: string }[] };
  return { connected, notTfsa, outside: outside.map(({ label }) => ({ label })) };
}

/**
 * The caller's own activity row that step 4 may answer: one the engine's `answerable` rule accepts (a BUY or a DIVIDEND
 * never), among the room's own accounts (the TFSA room's or the FHSA room's).
 */
function answerableRow(input: { activities: RoomActivity[]; fx: RoomFxPort }, key: string): RoomActivity | null {
  const row = input.activities.find((a) => a.activityKey === key);
  return row && answerable(row, input.fx) ? row : null;
}

type Account = "TFSA" | "FHSA" | "RRSP";
const an = (account: Account) => (account === "TFSA" ? "a TFSA" : `an ${account}`);
/** The stored text for a transfer answer, worded by direction and account type. */
function effectText(effect: UserRoomEffect, out: boolean, account: Account = "TFSA"): string {
  // An FHSA's outgoing "none" covers both "Moved to another FHSA" and "Moved to my RRSP": neither changes FHSA room.
  if (out) return `A transfer out of ${an(account)}, as you answered: ${effect === "none" ? (account === "FHSA" ? "moved to another FHSA or an RRSP" : account === "RRSP" ? "moved to another RRSP" : "moved to another TFSA") : "withdrawal"}.`;
  return effect === "none" ? `A transfer into ${an(account)}, as you answered: it is not a contribution.` : `A transfer into ${an(account)}, as you answered: it counts as a contribution.`;
}

/** The final ledger row's running values: null where another input is still missing. */
function finalOutcome(result: RoomResult): Outcome {
  const last = result.ledger.rows.at(-1);
  return { roomLeftCad: last?.roomLeftCad ?? null, excessCad: last?.excessCad ?? null };
}

/** For each unanswered unclear row (at most MAX_AMBIGUOUS_ROWS): the final room and excess under each answer. */
export function roomOutcomes(input: RoomInput, result: RoomResult): RoomOutcomes {
  const outcomes: RoomOutcomes = {};
  const rows = result.ledger.rows.filter((r) => r.kind === "ambiguous" && r.activityKey).slice(0, MAX_AMBIGUOUS_ROWS);
  const run = (key: string, effect: UserRoomEffect) => {
    const classifications = new Map(input.memory.classifications);
    classifications.set(key, effect);
    return finalOutcome(computeTfsaRoom({ ...input, memory: { ...input.memory, classifications } }));
  };
  for (const r of rows) {
    const key = r.activityKey!;
    outcomes[key] = isOutgoing(r) ? { asWithdrawal: run(key, "withdrawal"), asNone: run(key, "none") } : { asContribution: run(key, "contribution"), asNone: run(key, "none") };
  }
  return outcomes;
}

/** The connected FHSAs the FHSA room counts, with what tells them apart on screen (no keys of other account types). */
export function fhsaAccounts(input: FhsaRoomInput): Array<{ accountKey: string; label: string; maskedNumber: string | null; value: { amount: number; currency: string } | null }> {
  const counted = countedFhsas(input);
  return input.accounts.filter((a) => counted.has(a.accountKey))
    .map((a) => ({ accountKey: a.accountKey, label: a.label, maskedNumber: a.maskedNumber ?? null, value: a.value ?? null }));
}

/** GET /api/room/fhsa's body: `{ status: "none" }` without an FHSA, else the result, its FHSAs and no alert (none yet). */
export function fhsaPayload(input: FhsaRoomInput) {
  const result = computeFhsaRoom(input);
  if (result.status === "none") return result;
  const newYearNote = newYearText(result.newYear, "FHSA", result.year);
  return { ...result, accounts: fhsaAccounts(input), alert: null, ...(newYearNote ? { newYearNote } : {}) };
}

/**
 * GET /api/room/rrsp's body: `{ status: "none" }` without an RRSP, else the result and the RRSP-bucket accounts
 * (managed and closed ones flagged) that tell them apart on screen. No keys of other account types.
 */
export function rrspPayload(input: RrspRoomInput) {
  const result = computeRrspRoom(input);
  return result.status === "none" ? result : {
    ...result,
    accounts: input.accounts.filter((a) => a.bucket === "rrsp")
      .map((a) => ({ accountKey: a.accountKey, label: a.label, maskedNumber: a.maskedNumber ?? null, value: a.value ?? null, managed: a.managed, closed: a.closed === true })),
  };
}

export function registerRoomRoutes(app: Express, deps: RoomRoutesDeps): void {
  const { room, memory, guards, now } = deps;
  const loadInput = (subject: string) => {
    const at = now();
    return loadRoomInput(room.loader, subject, torontoToday(at), at);
  };

  const payload = async (subject: string) => {
    const at = now();
    const input = await loadInput(subject);
    const result = computeTfsaRoom(input);
    const alert = room.alerts ? await room.alerts.openRoomAlert(subject, at) : null;
    deps.log({ event: "room_dashboard", status: result.status, alert: alert !== null });
    // The sets follow the engine's choice: this year's when it is usable; otherwise the latest earlier one, which the
    // engine carries forward and steps 2 and 3 pre-fill from. Not part of the room result.
    const { current } = countedTfsas(input);
    const newYearNote = newYearText(result.newYear, "TFSA", result.year);
    return { ...result, alert, accounts: roomAccounts(input), accountSet: current ? roomAccountSet(input) : null,
      previousAccountSet: current ? null : roomAccountSet(input, "previous"), outcomes: roomOutcomes(input, result), ...(newYearNote ? { newYearNote } : {}) };
  };

  app.get("/api/room/tfsa", ...guards, async (_request, response) => {
    response.json(await payload(response.locals.authSubject));
  });

  const fhsa = async (subject: string) => {
    const at = now();
    const body = fhsaPayload(await loadFhsaRoomInput(room.loader, subject, torontoToday(at), at));
    deps.log({ event: "fhsa_room_dashboard", status: body.status });
    return body;
  };
  app.get("/api/room/fhsa", ...guards, async (_request, response) => {
    response.json(await fhsa(response.locals.authSubject));
  });

  const rrspInput = (subject: string) => { const at = now(); return loadRrspRoomInput(room.loader, subject, torontoToday(at), at); };
  const rrsp = async (subject: string) => {
    const body = rrspPayload(await rrspInput(subject));
    deps.log({ event: "rrsp_room_dashboard", status: body.status });
    return body;
  };
  app.get("/api/room/rrsp", ...guards, async (_request, response) => {
    response.json(await rrsp(response.locals.authSubject));
  });

  if (!memory) return;

  const bad = (response: Response) => response.status(400).json(INVALID_MEMORY_EDIT);
  type Saved = { input: Omit<MemoryFactInput, "kind" | "provenance" | "source">; name: string };
  /** Remembers each entry in order, then answers once: one memoryOutcome, so a failure on any write is the one answer. */
  const saveAll = (response: Response, entries: Saved[], answer: (subject: string) => Promise<unknown> = payload) =>
    memoryOutcome(
      response,
      async () => {
        for (const { input } of entries) {
          await memory.remember(response.locals.authSubject, { ...input, kind: "fact", provenance: "stated", source: "dashboard" }, undefined, "dashboard");
        }
        return answer(response.locals.authSubject);
      },
      () => { for (const { name } of entries) deps.log({ event: "room_input_saved", input: name }); },
    );
  const save = (response: Response, input: Saved["input"], name: string, answer?: (subject: string) => Promise<unknown>) => saveAll(response, [{ input, name }], answer);
  app.put("/api/room/tfsa/cra-room", ...guards, async (request, response) => {
    const body = craBody.safeParse(request.body ?? {});
    if (!body.success) { bad(response); return; }
    const { year: y, amountCad: amount } = body.data;
    await save(response, {
      node: { type: "tax_year", key: `${y}:tfsa` }, property: "tax_year.cra_room_jan1", value: { amountCad: amount },
      text: `TFSA room of ${cad(amount)} on 1 January ${y}, from CRA My Account.`,
    }, "cra_room");
  });

  // The FHSA room's one question, validated like the CRA room; answers with GET /api/room/fhsa's body.
  app.put("/api/room/fhsa/participation-room", ...guards, async (request, response) => {
    const body = fhsaBody.safeParse(request.body ?? {});
    if (!body.success) { bad(response); return; }
    const { year: y, amountCad: amount } = body.data;
    await save(response, {
      node: { type: "tax_year", key: `${y}:fhsa` }, property: "tax_year.fhsa_room", value: { amountCad: amount },
      text: `FHSA participation room of ${cad(amount)} for ${y}, from CRA.`,
    }, "fhsa_room", fhsa);
  });

  // The RRSP room's questions: the CRA deduction limit (with the unused contributions CRA shows beside it, when given)
  // and the tax year's contributions VestLens can't see. Both answer with GET /api/room/rrsp's body.
  app.put("/api/room/rrsp/deduction-limit", ...guards, async (request, response) => {
    const body = rrspLimitBody.safeParse(request.body ?? {});
    if (!body.success) { bad(response); return; }
    const { year: y, amountCad: amount, unusedCad } = body.data;
    const node = { type: "tax_year" as const, key: `${y}:rrsp` };
    await saveAll(response, [
      { input: { node, property: "tax_year.rrsp_deduction_limit", value: { amountCad: amount }, text: `RRSP deduction limit of ${cad(amount)} for ${y}, from CRA.` }, name: "rrsp_limit" },
      ...(unusedCad === undefined ? [] : [{ input: { node, property: "tax_year.rrsp_unused_contributions", value: { amountCad: unusedCad }, text: `Unused RRSP contributions of ${cad(unusedCad)} for ${y}, from CRA.` }, name: "rrsp_unused" }]),
    ], rrsp);
  });

  app.put("/api/room/rrsp/elsewhere", ...guards, async (request, response) => {
    const body = craBody.safeParse(request.body ?? {});
    if (!body.success) { bad(response); return; }
    const { year: y, amountCad: amount } = body.data;
    await save(response, {
      node: { type: "tax_year", key: `${y}:rrsp` }, property: "tax_year.rrsp_elsewhere", value: { amountCad: amount },
      text: `RRSP contributions of ${cad(amount)} for the ${y} tax year not in VestLens.`,
    }, "rrsp_elsewhere", rrsp);
  });

  app.put("/api/room/tfsa/accounts", ...guards, async (request, response) => {
    const body = accountsBody.safeParse(request.body ?? {});
    if (!body.success) { bad(response); return; }
    const { year: y, connected, notTfsa, outside } = body.data;
    // Only the caller's own connected accounts: anything else is refused, and nothing is stored.
    const own = new Set((await loadInput(response.locals.authSubject)).connectedAccountKeys);
    if (![...connected, ...notTfsa].every((k) => own.has(k))) { response.status(404).json(NOT_FOUND); return; }
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    await save(response, {
      node: { type: "tax_year", key: `${y}:tfsa` }, property: "tax_year.account_set",
      value: { connected, outside, confirmedAt: now().toISOString(), notTfsa },
      text: `TFSA accounts for ${y}, as you confirmed them: ${plural(connected.length, "connected account", "connected accounts")}, `
        + `${plural(outside.length, "account elsewhere", "accounts elsewhere")}, ${plural(notTfsa.length, "connected account", "connected accounts")} that ${notTfsa.length === 1 ? "is" : "are"} not a TFSA.`,
    }, "account_set");
  });

  app.put("/api/room/tfsa/outside/:label/moves", ...guards, async (request, response) => {
    const label = labelParam.safeParse(request.params.label);
    const body = movesBody.safeParse(request.body ?? {});
    if (!label.success || !body.success) { bad(response); return; }
    const { year: y, entries } = body.data;
    // A move can't be entered before it happens: no entry after today's Toronto date.
    const today = torontoToday(now());
    if (entries.some((e) => e.date > today)) { bad(response); return; }
    await save(response, {
      node: { type: "account", key: outsideAccountKey(label.data) }, property: "account.tfsa_moves", value: { year: y, entries },
      text: `Dated TFSA deposits and withdrawals at ${label.data} in ${y}, as you entered them: ${entries.length} ${entries.length === 1 ? "entry" : "entries"}.`,
    }, "tfsa_moves");
  });

  /**
   * Step 4 for one room: PUT answers one of the caller's own transfers (or unclear rows) in that room's accounts, and
   * DELETE goes back to the automatic match or assumption. Activity keys are unique, so one property (activity.room_effect)
   * serves both rooms; each route only takes rows in its own room's accounts.
   */
  const answerRoutes = (path: string, account: Account, load: (subject: string) => Promise<{ activities: RoomActivity[]; fx: RoomFxPort }>, answer: (subject: string) => Promise<unknown>) => {
    app.put(`${path}/:activityKey`, ...guards, async (request, response) => {
      const key = hashKey.safeParse(request.params.activityKey);
      const body = effectBody.safeParse(request.body ?? {});
      if (!key.success) { response.status(404).json(NOT_FOUND); return; }
      if (!body.success) { bad(response); return; }
      // Only a transfer (or an unclear row) in the caller's own stored activity this year, in this room's accounts.
      const row = answerableRow(await load(response.locals.authSubject), key.data);
      if (!row) { response.status(404).json(NOT_FOUND); return; }
      // The answer must fit the direction: a withdrawal only for money leaving, a contribution only for money arriving.
      const out = typeof row.amount === "number" && row.amount < 0;
      if ((body.data.effect === "withdrawal" && !out) || (body.data.effect === "contribution" && out)) { bad(response); return; }
      await save(response, {
        node: { type: "activity", key: key.data }, property: "activity.room_effect", value: { effect: body.data.effect },
        text: effectText(body.data.effect, out, account),
      }, "room_effect", answer);
    });

    // Back to the automatic match: forgets the caller's stored answer for one of their own transfers.
    app.delete(`${path}/:activityKey`, ...guards, async (request, response) => {
      const key = hashKey.safeParse(request.params.activityKey);
      if (!key.success) { response.status(404).json(NOT_FOUND); return; }
      if (!answerableRow(await load(response.locals.authSubject), key.data)) { response.status(404).json(NOT_FOUND); return; }
      await memoryOutcome(
        response,
        async () => {
          await memory.forget(response.locals.authSubject, { node: { type: "activity", key: key.data }, property: "activity.room_effect" });
          return answer(response.locals.authSubject);
        },
        () => deps.log({ event: "room_input_cleared", input: "room_effect" }),
      );
    });
  };
  const fhsaInput = (subject: string) => { const at = now(); return loadFhsaRoomInput(room.loader, subject, torontoToday(at), at); };
  answerRoutes("/api/room/tfsa/activities", "TFSA", loadInput, payload);
  answerRoutes("/api/room/fhsa/activities", "FHSA", fhsaInput, fhsa);
  answerRoutes("/api/room/rrsp/activities", "RRSP", rrspInput, rrsp);

  /**
   * A managed TFSA's or FHSA's year-to-date contributions (review 6): SnapTrade shows no activity for a managed
   * portfolio, so the room waits for this figure (A9); the dashboard takes it here, as the RRSP's "contributions not
   * in VestLens" are taken. Only one of the caller's own managed accounts of that room; the as-of date must be in the
   * year and not after today (Toronto). The same fact chat stores (account.ytd_contributions on the account's key).
   */
  const managedRoutes = (path: string, program: Account, managedOf: (subject: string) => Promise<Array<{ accountKey: string; label: string }>>, answer: (subject: string) => Promise<unknown>) => {
    app.put(`${path}/:accountKey`, ...guards, async (request, response) => {
      const key = hashKey.safeParse(request.params.accountKey);
      const body = managedBody.safeParse(request.body ?? {});
      if (!key.success) { response.status(404).json(NOT_FOUND); return; }
      if (!body.success) { bad(response); return; }
      const { year: y, amountCad: amount, asOf } = body.data;
      if (!asOf.startsWith(`${y}-`) || asOf > torontoToday(now())) { bad(response); return; }
      const account = (await managedOf(response.locals.authSubject)).find((a) => a.accountKey === key.data);
      if (!account) { response.status(404).json(NOT_FOUND); return; }
      await save(response, {
        node: { type: "account", key: key.data }, property: "account.ytd_contributions", value: { year: y, amountCad: amount, asOf },
        text: `${program} contributions of ${cad(amount)} to ${account.label} in ${y} as of ${asOf}, entered on the dashboard.`,
      }, "managed_figure", answer);
    });
  };
  managedRoutes("/api/room/tfsa/managed", "TFSA", async (subject) => countedTfsas(await loadInput(subject)).managed, payload);
  managedRoutes("/api/room/fhsa/managed", "FHSA", async (subject) => (await fhsaInput(subject)).accounts.filter((a) => a.bucket === "fhsa" && a.managed === true), fhsa);
}
