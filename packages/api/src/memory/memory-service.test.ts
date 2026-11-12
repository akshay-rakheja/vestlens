import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryFactRepository } from "../testing/memory-fact-repository.js";
import type { BrokerageLinks } from "./context-builder.js";
import { accountKey, activityKey } from "./keys.js";
import { MemoryConflictError, MemoryNotFoundError, MemoryService, MemoryValidationError, type MemoryLogEvent } from "./memory-service.js";
import { queryTokens } from "./search.js";
import type { MemoryFactInput } from "./memory-types.js";

// Synthetic subjects, accounts and symbols only.
const ME = "subject|synthetic-memory-me";
const OTHER = "subject|synthetic-memory-other";
const T0 = new Date("2026-05-01T12:00:00.000Z");
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

const room = (amountCad: number, year = 2026, over: Partial<MemoryFactInput> = {}): MemoryFactInput => ({
  node: { type: "tax_year", key: `${year}:tfsa` }, property: "tax_year.cra_room_jan1", value: { amountCad },
  text: `My TFSA room on 1 January ${year}.`, kind: "fact", provenance: "stated", source: "claude", ...over,
});
const reason = (text: string, key = "SYN", over: Partial<MemoryFactInput> = {}): MemoryFactInput => ({
  node: { type: "security", key }, property: "security.reason", value: null, text, kind: "reason", provenance: "stated", ...over,
});

const noLinks: BrokerageLinks = {
  accountsHoldingSecurity: async () => [], tfsaAccounts: async () => [], accountIds: async () => [], activityDedupeKeys: async () => [],
};

function setup(links: BrokerageLinks = noLinks, now = () => day(30)) {
  const repository = new MemoryFactRepository();
  const events: MemoryLogEvent[] = [];
  const service = new MemoryService({ repository, links, now, log: (e) => events.push(e) });
  return { repository, service, events };
}

describe("MemoryService.remember", () => {
  it("supersedes per (node, property): only the newest is current and history keeps both", async () => {
    const { service } = setup();
    const first = await service.remember(ME, reason("For the dividend."), day(0));
    expect(first.superseded).toBe(0);
    const second = await service.remember(ME, reason("For growth now."), day(1));
    expect(second.superseded).toBe(1);

    const current = await service.recall(ME, { node: { type: "security", key: "SYN" } });
    expect(current.map((f) => f.text)).toEqual(["For growth now."]);
    const history = await service.recall(ME, { node: { type: "security", key: "SYN" }, includeHistory: true });
    expect(history.map((f) => f.text)).toEqual(["For growth now.", "For the dividend."]);
    expect(history[1]!.supersededAt?.toISOString()).toBe(day(1).toISOString());
    expect((await service.current(ME, { type: "security", key: "syn" }, "security.reason"))?.text).toBe("For growth now.");
  });

  it("supersedes reserved properties per validFrom too: a same-year correction replaces, another year does not", async () => {
    const { service } = setup();
    await service.remember(ME, room(7000), day(0));
    await service.remember(ME, room(14000, 2025), day(1));
    const correction = await service.remember(ME, room(6500), day(2));
    expect(correction.superseded).toBe(1);

    expect((await service.current(ME, { type: "tax_year", key: "2026:tfsa" }, "tax_year.cra_room_jan1", new Date("2026-01-01")))?.value).toEqual({ amountCad: 6500 });
    // The 2025 node is a different node; on the same node a different validFrom would also be kept.
    expect((await service.current(ME, { type: "tax_year", key: "2025:tfsa" }, "tax_year.cra_room_jan1"))?.value).toEqual({ amountCad: 14000 });
  });

  it("keeps an outside account's contributions per year (validFrom) and replaces within the year", async () => {
    const { service } = setup();
    const ytd = (year: number, amountCad: number): MemoryFactInput => ({
      node: { type: "account", key: "outside:other-bank" }, property: "account.ytd_contributions",
      value: { year, amountCad, asOf: `${year}-10-01` }, text: "Outside TFSA contributions.", kind: "fact", provenance: "stated",
    });
    await service.remember(ME, ytd(2025, 1000), day(0));
    await service.remember(ME, ytd(2026, 2000), day(1));
    expect((await service.remember(ME, ytd(2026, 2500), day(2))).superseded).toBe(1);
    const current = await service.recall(ME, { node: { type: "account", key: "outside:other-bank" } });
    expect(current.map((f) => (f.value as { amountCad: number }).amountCad)).toEqual([2500, 1000]);
  });

  it("throws MemoryValidationError with a plain message and stores nothing", async () => {
    const { service, repository } = setup();
    await expect(service.remember(ME, { ...room(1), property: "goal.cra_room_jan1", node: { type: "goal", key: "house" } }, day(0)))
      .rejects.toBeInstanceOf(MemoryValidationError);
    await expect(service.remember(ME, room(1, 2026, { provenance: "imported" }), day(0))).rejects.toThrow(/stated or inferred/);
    expect(repository.rows).toHaveLength(0);
  });

  it("lets a system caller record imported facts", async () => {
    const { service } = setup();
    const { fact } = await service.remember(ME, room(7000, 2026, { provenance: "imported" }), day(0), "system");
    expect(fact.provenance).toBe("imported");
  });

  it("two parallel remembers on the same (node, property, validFrom) leave exactly one current fact", async () => {
    const { service, repository, events } = setup();
    // Both writes take their supersede step before either inserts, as two racing transactions would.
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    repository.beforeInsert = async () => {
      arrived++;
      if (arrived === 2) release();
      if (arrived <= 2) await gate;
    };
    const results = await Promise.all([
      service.remember(ME, room(7000), day(0)),
      service.remember(ME, room(6500), day(0)),
    ]);
    const current = repository.rows.filter((r) => r.supersededAt === null && r.property === "tax_year.cra_room_jan1");
    expect(current).toHaveLength(1);
    expect(repository.rows).toHaveLength(2);
    expect(results.map((r) => r.superseded).sort()).toEqual([0, 1]);
    expect(events.filter((e) => e.event === "memory_conflict_retry")).toHaveLength(1);
  });

  it("gives up with MemoryConflictError after one retry", async () => {
    const { service, repository } = setup();
    repository.supersedeAndInsert = async () => { throw new MemoryConflictError(); };
    await expect(service.remember(ME, room(1), day(0))).rejects.toBeInstanceOf(MemoryConflictError);
  });
});

describe("MemoryService.recall", () => {
  const SYN_ACCT = "synthetic-account-tfsa";
  const links: BrokerageLinks = {
    accountsHoldingSecurity: async (subject, symbol) => (subject === ME && symbol === "SYN" ? [SYN_ACCT] : []),
    tfsaAccounts: async () => [SYN_ACCT],
    accountIds: async () => [SYN_ACCT],
    activityDedupeKeys: async () => ["synthetic-dedupe-1"],
  };

  it("by node includes hop-1 facts, hop 0 first then newest first, with age and provenance", async () => {
    const { service } = setup(links, () => day(30));
    await service.remember(ME, reason("Long-term hold."), day(0));
    await service.remember(ME, { node: { type: "account", key: accountKey(SYN_ACCT) }, property: "account.note", value: null,
      text: "Main TFSA.", kind: "note", provenance: "inferred" }, day(20));
    await service.remember(ME, reason("Unrelated.", "OTHR"), day(25));

    const facts = await service.recall(ME, { node: { type: "security", key: "SYN" } });
    expect(facts.map((f) => [f.text, f.hop, f.provenance, f.ageDays])).toEqual([
      ["Long-term hold.", 0, "stated", 30],
      ["Main TFSA.", 1, "inferred", 10],
    ]);
  });

  it("is capped and returns newest first without a node", async () => {
    const { service } = setup();
    for (let i = 0; i < 30; i++) await service.remember(ME, reason(`Reason ${i}.`, `S${i}`), day(i));
    const facts = await service.recall(ME, {});
    expect(facts).toHaveLength(20);
    expect(facts[0]!.text).toBe("Reason 29.");
    expect(await service.recall(ME, { limit: 3 })).toHaveLength(3);
    expect(await service.recall(ME, { limit: 500 })).toHaveLength(30);
  });

  it("filters by property prefix and simple text match", async () => {
    const { service } = setup();
    await service.remember(ME, reason("Bought for the DIVIDEND."), day(0));
    await service.remember(ME, room(7000), day(1));
    expect((await service.recall(ME, { text: "dividend" })).map((f) => f.property)).toEqual(["security.reason"]);
    expect((await service.recall(ME, { property: "tax_year." })).map((f) => f.property)).toEqual(["tax_year.cra_room_jan1"]);
  });

  it("is scoped by subject", async () => {
    const { service } = setup(links);
    await service.remember(OTHER, reason("Someone else's reason."), day(0));
    await service.remember(OTHER, { node: { type: "account", key: accountKey(SYN_ACCT) }, property: "account.note", value: null,
      text: "Other's account.", kind: "note", provenance: "stated" }, day(0));
    expect(await service.recall(ME, {})).toEqual([]);
    expect(await service.recall(ME, { node: { type: "security", key: "SYN" } })).toEqual([]);
    expect(await service.current(ME, { type: "security", key: "SYN" }, "security.reason")).toBeNull();
  });

  it("rejects a malformed node", async () => {
    const { service } = setup();
    await expect(service.recall(ME, { node: { type: "nope" as never, key: "x" } })).rejects.toBeInstanceOf(MemoryValidationError);
  });
});

describe("MemoryService.promote, forget and deleteSubject", () => {
  it("promote re-records an inferred fact as stated, superseding the old one", async () => {
    const { service, repository } = setup();
    const { fact } = await service.remember(ME, reason("Seems cautious about tech.", "SYN", { provenance: "inferred", source: "claude" }), day(0));
    const promoted = await service.promote(ME, fact.id);
    expect(promoted.provenance).toBe("stated");
    expect(promoted.source).toBe("dashboard");
    expect(promoted.text).toBe(fact.text);
    expect(promoted.id).not.toBe(fact.id);
    expect(repository.rows.find((r) => r.id === fact.id)?.supersededAt).not.toBeNull();
    expect((await service.current(ME, { type: "security", key: "SYN" }, "security.reason"))?.id).toBe(promoted.id);
    expect((await service.promote(ME, (await service.remember(ME, reason("x", "ABC", { provenance: "inferred" }))).fact.id, "chatgpt")).source).toBe("chatgpt");
  });

  it("promote refuses another subject's fact, a stated fact and a superseded fact", async () => {
    const { service } = setup();
    const { fact } = await service.remember(ME, reason("Inferred.", "SYN", { provenance: "inferred" }), day(0));
    await expect(service.promote(OTHER, fact.id)).rejects.toBeInstanceOf(MemoryNotFoundError);
    const stated = await service.remember(ME, reason("Stated.", "ABC"), day(0));
    await expect(service.promote(ME, stated.fact.id)).rejects.toBeInstanceOf(MemoryValidationError);
    await service.remember(ME, reason("Newer.", "SYN", { provenance: "inferred" }), day(1));
    await expect(service.promote(ME, fact.id)).rejects.toBeInstanceOf(MemoryValidationError);
  });

  it("forget by id removes the whole topic: the entry and every earlier version; by topic does the same; only the caller's", async () => {
    const { service, repository } = setup();
    const a = await service.remember(ME, reason("One."), day(0));
    await service.remember(ME, reason("Two."), day(1));
    await service.remember(ME, reason("Other topic.", "ABC"), day(1));
    await service.remember(OTHER, reason("Theirs."), day(1));
    expect(await service.forget(OTHER, { id: a.fact.id })).toBe(0);
    // The id of a superseded version reaches the same topic.
    expect(await service.forget(ME, { id: a.fact.id })).toBe(2);
    expect(repository.rows.map((r) => r.text).sort()).toEqual(["Other topic.", "Theirs."]);
    await service.remember(ME, reason("Three."), day(2));
    expect(await service.forget(ME, { node: { type: "security", key: "syn" }, property: "security.reason" })).toBe(1);
    expect(repository.rows.map((r) => r.text).sort()).toEqual(["Other topic.", "Theirs."]);
  });

  it("deleting the current fact by id leaves neither version in recall with history or in the export", async () => {
    const { service } = setup();
    await service.remember(ME, reason("First wording."), day(0));
    const current = await service.remember(ME, reason("Second wording."), day(1));
    expect(await service.forget(ME, { id: current.fact.id })).toBe(2);
    expect(await service.recall(ME, { includeHistory: true })).toEqual([]);
    expect(await service.listForExport(ME)).toEqual([]);
  });

  it("deleteSubject removes every fact for the subject only", async () => {
    const { service, repository } = setup();
    await service.remember(ME, reason("One."), day(0));
    await service.remember(ME, room(1), day(0));
    await service.remember(OTHER, reason("Theirs."), day(0));
    expect(await service.deleteSubject(ME)).toBe(2);
    expect(repository.rows.map((r) => r.subject)).toEqual([OTHER]);
  });

  it("lists current and superseded facts for export, flat, with no subject or id", async () => {
    const { service } = setup();
    await service.remember(ME, reason("One."), day(0));
    await service.remember(ME, reason("Two."), day(1));
    const rows = await service.listForExport(ME);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ nodeType: "security", nodeKey: "SYN", property: "security.reason", text: "One.", supersededAt: day(1) });
    expect(rows[1]).toMatchObject({ text: "Two.", supersededAt: null });
    for (const r of rows) {
      expect(r).not.toHaveProperty("subject");
      expect(r).not.toHaveProperty("id");
    }
  });
});

describe("MemoryService logs", () => {
  it("carry counts and constant codes only, never text, values, keys or subjects", async () => {
    const { service, events } = setup({ ...noLinks, accountsHoldingSecurity: async () => ["synthetic-account-x"] });
    await service.remember(ME, reason("SECRET-TEXT about it.", "SECRETSYM", { value: { note: "SECRET-VALUE" } }), day(0));
    await service.remember(ME, room(98765), day(0));
    await service.remember(ME, { node: { type: "activity", key: activityKey("synthetic-dedupe") }, property: "activity.room_effect",
      value: { effect: "none" }, text: "Not a contribution.", kind: "fact", provenance: "stated" }, day(0));
    await service.recall(ME, { node: { type: "security", key: "SECRETSYM" }, text: "SECRET" });
    await expect(service.remember(ME, reason("SECRET-TEXT", "SECRETSYM", { provenance: "derived" }), day(0))).rejects.toThrow();
    await service.forget(ME, { node: { type: "security", key: "SECRETSYM" }, property: "security.reason" });
    await service.deleteSubject(ME);

    expect(events.length).toBeGreaterThan(0);
    const logged = JSON.stringify(events);
    for (const leak of ["SECRET", "98765", ME, "synthetic", accountKey("synthetic-account-x"), activityKey("synthetic-dedupe"), "2026:tfsa"]) {
      expect(logged).not.toContain(leak);
    }
    for (const e of events) {
      for (const v of Object.values(e)) expect(["string", "number", "boolean"]).toContain(typeof v);
    }
  });
});

describe("MemoryService reserved-change hook (room alert re-evaluation)", () => {
  function hooked(fail = false) {
    const repository = new MemoryFactRepository();
    const events: MemoryLogEvent[] = [];
    const calls: string[] = [];
    const service = new MemoryService({
      repository, links: noLinks, now: () => day(30), log: (e) => events.push(e),
      onReservedChange: async (subject) => { calls.push(subject); if (fail) throw new Error(`synthetic failure ${subject}`); },
    });
    return { repository, service, events, calls };
  }
  const setFact: MemoryFactInput = {
    node: { type: "tax_year", key: "2026:tfsa" }, property: "tax_year.account_set",
    value: { connected: [accountKey("synthetic-acct")], outside: [], confirmedAt: "2026-02-01T15:00:00.000Z" }, text: "My TFSAs.", kind: "fact", provenance: "stated",
  };
  const ytd: MemoryFactInput = {
    node: { type: "account", key: "outside:other-bank" }, property: "account.ytd_contributions", value: { year: 2026, amountCad: 100, asOf: "2026-04-01" },
    text: "Other bank TFSA.", kind: "fact", provenance: "stated",
  };
  const effect: MemoryFactInput = {
    node: { type: "activity", key: activityKey("synthetic-dedupe") }, property: "activity.room_effect", value: { effect: "none" }, text: "Not a contribution.", kind: "fact", provenance: "stated",
  };

  it("runs in the same call for each reserved TFSA property remembered, and never for other properties", async () => {
    const { service, calls } = hooked();
    await service.remember(ME, room(7000), day(0));
    await service.remember(ME, setFact, day(0));
    await service.remember(ME, ytd, day(0));
    await service.remember(ME, effect, day(0));
    expect(calls).toEqual([ME, ME, ME, ME]);
    await service.remember(ME, reason("For the dividend."), day(0));
    expect(calls).toHaveLength(4);
  });

  it("runs when forget removes a reserved topic or a reserved entry by id, not for other entries", async () => {
    const { service, calls } = hooked();
    const cra = await service.remember(ME, room(7000), day(0));
    const note = await service.remember(ME, reason("For the dividend."), day(0));
    calls.length = 0;
    await service.forget(ME, { id: note.fact.id });
    await service.forget(ME, { node: { type: "security", key: "SYN" }, property: "security.reason" });
    expect(calls).toEqual([]);
    await service.forget(ME, { id: cra.fact.id });
    expect(calls).toEqual([ME]);
    await service.remember(ME, room(7000), day(1));
    calls.length = 0;
    await service.forget(ME, { node: { type: "tax_year", key: "2026:tfsa" }, property: "tax_year.cra_room_jan1" });
    expect(calls).toEqual([ME]);
  });

  it("is best effort: a failure never fails the memory call and is logged as a code only", async () => {
    const { service, events, repository } = hooked(true);
    const saved = await service.remember(ME, room(7000), day(0));
    expect(saved.fact.value).toEqual({ amountCad: 7000 });
    expect(await service.forget(ME, { id: saved.fact.id })).toBe(1);
    expect(repository.rows).toHaveLength(0);
    const failures = events.filter((e) => e.event === "memory_hook_failed");
    expect(failures).toEqual([{ event: "memory_hook_failed", code: "room_alert_reevaluate" }, { event: "memory_hook_failed", code: "room_alert_reevaluate" }]);
    expect(JSON.stringify(events)).not.toContain(ME);
    expect(JSON.stringify(events)).not.toContain("synthetic failure");
  });
});

describe("MemoryService.listCurrent and edit (dashboard)", () => {
  it("lists only the caller's current facts, newest first, without history", async () => {
    const { service } = setup();
    await service.remember(ME, reason("Old."), day(0));
    await service.remember(ME, reason("New."), day(1));
    await service.remember(ME, room(7000), day(2));
    await service.remember(OTHER, reason("Theirs."), day(2));
    const facts = await service.listCurrent(ME);
    expect(facts.map((f) => f.text)).toEqual(["My TFSA room on 1 January 2026.", "New."]);
  });

  it("edit keeps a thesis's server-set writtenAt whatever value the dashboard sends", async () => {
    const { service } = setup();
    const value = { reasons: "Synthetic.", timeFrame: null, conditions: [], writtenAt: day(0).toISOString() };
    const { fact } = await service.remember(ME, { node: { type: "security", key: "SYN" }, property: "security.thesis", value, text: "Thesis.", kind: "reason", provenance: "stated" }, day(0));
    const edited = await service.edit(ME, fact.id, { value: { ...value, reasons: "Synthetic, edited.", writtenAt: day(9).toISOString() } }, day(3));
    expect((edited.value as { writtenAt: string }).writtenAt).toBe(day(0).toISOString());
    // An older row without one keeps its version's recordedAt.
    const { fact: old } = await service.remember(ME, { node: { type: "security", key: "OLD" }, property: "security.thesis", value: { reasons: "Old.", timeFrame: null }, text: "Thesis.", kind: "reason", provenance: "stated" }, day(1));
    const oldEdited = await service.edit(ME, old.id, { value: { reasons: "Old, edited.", timeFrame: null, writtenAt: day(9).toISOString() } }, day(4));
    expect((oldEdited.value as { writtenAt: string }).writtenAt).toBe(day(1).toISOString());
  });

  it("edit saves a superseding stated fact sourced to the dashboard; the old text stays as history", async () => {
    const { service, repository } = setup();
    const { fact } = await service.remember(ME, reason("Seems cautious.", "SYN", { provenance: "inferred", source: "claude" }), day(0));
    const edited = await service.edit(ME, fact.id, { text: "I am cautious about tech." }, day(1));
    expect(edited).toMatchObject({ text: "I am cautious about tech.", provenance: "stated", source: "dashboard", property: "security.reason" });
    expect(edited.id).not.toBe(fact.id);
    expect(repository.rows.find((r) => r.id === fact.id)?.supersededAt).not.toBeNull();
    expect((await service.listCurrent(ME)).map((f) => f.id)).toEqual([edited.id]);
  });

  it("edit of a reserved value is validated and re-fires the reserved-change hook; an invalid value saves nothing", async () => {
    const hook: string[] = [];
    const repository = new MemoryFactRepository();
    const service = new MemoryService({ repository, links: noLinks, now: () => day(30), log: () => {}, onReservedChange: async (s) => { hook.push(s); } });
    const { fact } = await service.remember(ME, room(7000), day(0));
    hook.length = 0;
    const edited = await service.edit(ME, fact.id, { value: { amountCad: 6500 } }, day(1));
    expect(edited.value).toEqual({ amountCad: 6500 });
    expect(edited.text).toBe(fact.text);
    expect(edited.validFrom?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(hook).toEqual([ME]);
    await expect(service.edit(ME, edited.id, { value: { amountCad: -1 } }, day(2))).rejects.toBeInstanceOf(MemoryValidationError);
    await expect(service.edit(ME, edited.id, { text: "   " }, day(2))).rejects.toBeInstanceOf(MemoryValidationError);
    expect(repository.rows.filter((r) => r.supersededAt === null)).toHaveLength(1);
  });

  it("edit refuses another subject's, an unknown and a superseded entry", async () => {
    const { service } = setup();
    const a = await service.remember(ME, reason("One."), day(0));
    await service.remember(ME, reason("Two."), day(1));
    await expect(service.edit(OTHER, a.fact.id, { text: "x" })).rejects.toBeInstanceOf(MemoryNotFoundError);
    await expect(service.edit(ME, "no-such-id", { text: "x" })).rejects.toBeInstanceOf(MemoryNotFoundError);
    await expect(service.edit(ME, a.fact.id, { text: "x" })).rejects.toBeInstanceOf(MemoryNotFoundError);
  });
});

describe("the reserved-change hook deadline", () => {
  afterEach(() => vi.useRealTimers());
  const never = () => new Promise<never>(() => undefined);

  it("gives up after 2 seconds, logs a code, and the memory call still succeeds", async () => {
    vi.useFakeTimers();
    const events: MemoryLogEvent[] = [];
    const repository = new MemoryFactRepository();
    const service = new MemoryService({ repository, links: noLinks, now: () => day(30), log: (e) => events.push(e), onReservedChange: never });
    let settled = false;
    const saved = service.remember(ME, room(7000), day(0)).then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const { fact } = await saved;
    expect(fact.text).toContain("TFSA room");
    expect(events).toContainEqual({ event: "room_alert_hook_timeout" });
    expect(events.find((e) => e.event === "memory_hook_failed")).toBeUndefined();
    expect(repository.rows).toHaveLength(1);
  });

  it("applies to forget too, and a late failure after the timeout is swallowed", async () => {
    vi.useFakeTimers();
    const events: MemoryLogEvent[] = [];
    let fail: (e: Error) => void = () => undefined;
    let first = true;
    const hook = () => (first ? ((first = false), Promise.resolve()) : new Promise<never>((_, reject) => { fail = reject; }));
    const service = new MemoryService({ repository: new MemoryFactRepository(), links: noLinks, now: () => day(30), log: (e) => events.push(e), onReservedChange: hook });
    const { fact } = await service.remember(ME, room(7000), day(0));
    const forgotten = service.forget(ME, { id: fact.id });
    await vi.advanceTimersByTimeAsync(2001);
    expect(await forgotten).toBe(1);
    expect(events).toContainEqual({ event: "room_alert_hook_timeout" });
    fail(new Error("late"));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("a fast hook is not a timeout", async () => {
    const events: MemoryLogEvent[] = [];
    const service = new MemoryService({ repository: new MemoryFactRepository(), links: noLinks, now: () => day(30), log: (e) => events.push(e), onReservedChange: async () => undefined });
    await service.remember(ME, room(7000), day(0));
    expect(events.find((e) => e.event === "room_alert_hook_timeout")).toBeUndefined();
  });
});

describe("MemoryService.recall is forgiving (staging, 2026-10-24)", () => {
  const house = (over: Partial<MemoryFactInput> = {}): MemoryFactInput => ({
    node: { type: "goal", key: "house" }, property: "goal.target_date", value: "2028", text: "Saving for a house in 2028.",
    kind: "plan", provenance: "stated", source: "claude", ...over,
  });

  it("the staging scenario: a saved house goal is found by loose text, a guessed key, and no arguments", async () => {
    const { service } = setup();
    await service.remember(ME, house(), day(0));
    for (const q of [{ text: "house plans" }, { node: { type: "goal" as const, key: "house-2028" } }, {}]) {
      const facts = await service.recall(ME, q);
      expect(facts.map((f) => f.text), JSON.stringify(q)).toEqual(["Saving for a house in 2028."]);
    }
  });

  it("node recall marks exact matches exact and falls back to the node type, marked type", async () => {
    const { service } = setup();
    await service.remember(ME, house(), day(0));
    await service.remember(ME, house({ node: { type: "goal", key: "retirement" }, property: "goal.note", text: "Retire at 60." }), day(1));
    await service.remember(ME, reason("For the dividend."), day(2));
    const exact = await service.recall(ME, { node: { type: "goal", key: "house" } });
    expect(exact.map((f) => [f.text, f.matched])).toEqual([["Saving for a house in 2028.", "exact"]]);
    const fallback = await service.recall(ME, { node: { type: "goal", key: "house-2028" } });
    expect(fallback.map((f) => [f.text, f.matched])).toEqual([["Retire at 60.", "type"], ["Saving for a house in 2028.", "type"]]);
    // Another subject's goals never appear in the fallback.
    expect(await service.recall(OTHER, { node: { type: "goal", key: "house" } })).toEqual([]);
  });

  it("text is tokenised: any token in text, node key or property matches; ranked by matching tokens, then newest", async () => {
    const { service } = setup();
    await service.remember(ME, house(), day(0));
    await service.remember(ME, reason("Bought it for the dividend.", "SYN"), day(1));
    await service.remember(ME, house({ node: { type: "goal", key: "cottage" }, property: "goal.note", text: "A cottage by 2030, after the house." }), day(2));
    await service.remember(ME, room(7000), day(3));
    // "house" + "2028" both match the first; "house" alone matches the cottage note (newer, but fewer tokens).
    expect((await service.recall(ME, { text: "What are my house plans for 2028?" })).map((f) => f.node.key)).toEqual(["house", "cottage"]);
    // Node key and property match too, case-insensitively.
    expect((await service.recall(ME, { text: "SYN" })).map((f) => f.node.key)).toEqual(["SYN"]);
    expect((await service.recall(ME, { text: "target_date" })).map((f) => f.node.key)).toEqual(["house"]);
    // Stopwords and short tokens alone do not filter; nothing matching returns nothing.
    expect(await service.recall(ME, { text: "what are my" })).toHaveLength(4);
    expect(await service.recall(ME, { text: "boat" })).toEqual([]);
  });

  it("accented words match accented text, case-insensitively; plain words still work", async () => {
    const { service } = setup();
    await service.remember(ME, house({ node: { type: "goal", key: "fr-savings" }, property: "goal.note", text: "Mon épargne pour la maison." }), day(0));
    await service.remember(ME, house(), day(1));
    expect((await service.recall(ME, { text: "épargne" })).map((f) => f.text)).toEqual(["Mon épargne pour la maison."]);
    expect((await service.recall(ME, { text: "ÉPARGNE" })).map((f) => f.text)).toEqual(["Mon épargne pour la maison."]);
    expect((await service.recall(ME, { text: "house" })).map((f) => f.text)).toEqual(["Saving for a house in 2028."]);
  });

  it("a hex-only token never matches a hashed account or activity key", async () => {
    const { service } = setup({ ...noLinks, accountIds: async () => ["synthetic-acct"] });
    const key = accountKey("synthetic-acct");
    await service.remember(ME, { node: { type: "account", key }, property: "account.note", value: null, text: "Main account.", kind: "note", provenance: "stated" }, day(0));
    expect(await service.recall(ME, { text: key.slice(0, 6) })).toEqual([]);
  });

  it("inferred facts stay labelled in every recall", async () => {
    const { service } = setup();
    await service.remember(ME, house({ provenance: "inferred" }), day(0));
    for (const q of [{ text: "house" }, { node: { type: "goal" as const, key: "nope" } }, {}]) {
      expect((await service.recall(ME, q))[0]!.provenance).toBe("inferred");
    }
  });
});

describe("queryTokens", () => {
  it("lower-cases, splits on non-alphanumerics, drops short tokens and stopwords, dedupes", () => {
    expect(queryTokens("What are my HOUSE plans, for the house in 2028?")).toEqual(["house", "plans", "2028"]);
    expect(queryTokens("a an to of my")).toEqual([]);
    expect(queryTokens("tax_year.cra_room_jan1")).toEqual(["tax", "year", "cra", "room", "jan1"]);
    // Accents are kept: letters in any script are token characters, and case folds.
    expect(queryTokens("Mon ÉPARGNE pour la maison")).toEqual(["mon", "épargne", "pour", "maison"]);
  });
});

describe("MemoryService.recent (memory in portfolio results)", () => {
  it("returns current facts newest first, capped at 8, with age, and logs a count only", async () => {
    const { service, events } = setup();
    for (let i = 0; i < 10; i++) await service.remember(ME, reason(`Reason ${i}.`, `S${i}`), day(i));
    const facts = await service.recent(ME);
    expect(facts).toHaveLength(8);
    expect(facts[0]).toMatchObject({ text: "Reason 9.", ageDays: 21 });
    expect(events.at(-1)).toEqual({ event: "memory_attached", count: 8 });
  });
});

describe("MemoryService caps on typed portfolio facts", () => {
  const thesis = (ticker: string, reasons = "Synthetic reasons."): MemoryFactInput => ({
    node: { type: "security", key: ticker }, property: "security.thesis", value: { reasons, timeFrame: null, conditions: [] },
    text: `Thesis on ${ticker}.`, kind: "reason", provenance: "stated",
  });
  const limit = (slug: string): MemoryFactInput => ({
    node: { type: "rule", key: slug }, property: "rule.concentration_limit", value: { kind: "single_holding", maxPct: 10 },
    text: "Limit.", kind: "plan", provenance: "stated",
  });
  const goal = (slug: string): MemoryFactInput => ({
    node: { type: "goal", key: slug }, property: "goal.savings_target",
    value: { name: slug, targetCad: 1000, targetDate: "2028-01-01", accounts: ["outside:other-bank"] },
    text: "Goal.", kind: "plan", provenance: "stated",
  });

  const cases = [
    { make: thesis, max: 50, key: (i: number) => `SYN${i}`, message: "You already have 50 theses saved. Remove one before adding another." },
    { make: limit, max: 20, key: (i: number) => `limit-${i}`, message: "You already have 20 limits saved. Remove one before adding another." },
    { make: goal, max: 10, key: (i: number) => `goal-${i}`, message: "You already have 10 goals saved. Remove one before adding another." },
  ];

  for (const c of cases) {
    it(`rejects fact ${c.max + 1} for ${c.message.split(" ")[4]} with plain text; superseding does not count`, async () => {
      const { service, events } = setup();
      for (let i = 0; i < c.max; i++) await service.remember(ME, c.make(c.key(i)), day(0));
      await expect(service.remember(ME, c.make(c.key(c.max)), day(1))).rejects.toThrow(new MemoryValidationError(c.message));
      expect(events.at(-1)).toEqual({ event: "memory_rejected", code: "cap_reached" });
      // Re-saving an existing topic supersedes it and is allowed at the cap.
      const again = await service.remember(ME, c.make(c.key(0)), day(2));
      expect(again.superseded).toBe(1);
      // Another subject has its own cap; superseded history does not count either.
      expect((await service.remember(OTHER, c.make(c.key(c.max)), day(2))).superseded).toBe(0);
      // Removing one frees a slot.
      await service.forget(ME, { node: c.make(c.key(1)).node, property: c.make(c.key(1)).property });
      expect((await service.remember(ME, c.make(c.key(c.max)), day(3))).superseded).toBe(0);
    });
  }

  it("does not apply caps to other properties", async () => {
    const { service } = setup();
    for (let i = 0; i < 60; i++) await service.remember(ME, reason(`Reason ${i}.`, `SYN${i}`), day(0));
    expect((await service.listCurrent(ME)).length).toBe(60);
  });
});
