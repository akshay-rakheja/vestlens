import { describe, expect, it, vi } from "vitest";

import { MemoryFactRepository } from "../testing/memory-fact-repository.js";
import { PrismaBrokerageLinks, buildContext, linkedNodes, type BrokerageLinks, type BrokerageLinksPrismaPort } from "./context-builder.js";
import { accountKey, activityKey } from "./keys.js";
import { MemoryService } from "./memory-service.js";
import type { MemoryFactInput } from "./memory-types.js";

// Synthetic ids and symbols only.
const ME = "subject|synthetic-context-me";
const T0 = new Date("2026-06-01T12:00:00.000Z");
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);
const TFSA = "synthetic-tfsa-1";
const CASH = "synthetic-cash-1";

const note = (type: MemoryFactInput["node"]["type"], key: string, text: string, provenance: "stated" | "inferred" = "stated"): MemoryFactInput => ({
  node: { type, key }, property: `${type}.note`, value: null, text, kind: "note", provenance,
});
const effect = (dedupe: string, e: "contribution" | "none"): MemoryFactInput => ({
  node: { type: "activity", key: activityKey(dedupe) }, property: "activity.room_effect", value: { effect: e },
  text: "Classified by the user.", kind: "fact", provenance: "stated",
});

function fakeLinks(): BrokerageLinks & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    accountsHoldingSecurity: vi.fn(async (_s: string, symbol: string) => { calls.push("holding"); return symbol === "SYN" ? [TFSA, CASH] : []; }),
    tfsaAccounts: vi.fn(async () => { calls.push("tfsa"); return [TFSA]; }),
    accountIds: vi.fn(async () => { calls.push("accounts"); return [TFSA, CASH]; }),
    activityDedupeKeys: vi.fn(async (_s: string, ids: string[], year?: number) => {
      calls.push(`activity:${ids.join(",")}:${year ?? "all"}`);
      return ids.includes(TFSA) ? (year === 2026 ? ["d-2026-a", "d-2026-b"] : ["d-2025-a", "d-2026-a", "d-2026-b"]) : ["d-cash"];
    }),
  };
}

async function seeded() {
  const repository = new MemoryFactRepository();
  const links = fakeLinks();
  const service = new MemoryService({ repository, links, now: () => day(10) });
  await service.remember(ME, note("security", "SYN", "Watching SYN."), day(0));
  await service.remember(ME, note("account", accountKey(TFSA), "Main TFSA.", "inferred"), day(5));
  await service.remember(ME, note("account", accountKey(CASH), "Cash account."), day(6));
  await service.remember(ME, { node: { type: "tax_year", key: "2026:tfsa" }, property: "tax_year.cra_room_jan1", value: { amountCad: 7000 },
    text: "Room on 1 January 2026.", kind: "fact", provenance: "stated" }, day(1));
  await service.remember(ME, effect("d-2026-a", "contribution"), day(7));
  await service.remember(ME, effect("d-2025-a", "none"), day(8));
  await service.remember(ME, effect("d-cash", "none"), day(9));
  links.calls.length = 0;
  return { repository, links, deps: { repository, links, now: () => day(10) } };
}

describe("linkedNodes (hop-1 rules)", () => {
  it("security -> accounts holding it", async () => {
    const links = fakeLinks();
    expect(await linkedNodes(links, ME, { type: "security", key: "SYN" }, { activity: true })).toEqual([
      { type: "account", key: accountKey(TFSA) }, { type: "account", key: accountKey(CASH) },
    ]);
  });

  it("tax_year:<y>:tfsa -> TFSA accounts and their activity in that year", async () => {
    const links = fakeLinks();
    expect(await linkedNodes(links, ME, { type: "tax_year", key: "2026:tfsa" }, { activity: true })).toEqual([
      { type: "account", key: accountKey(TFSA) },
      { type: "activity", key: activityKey("d-2026-a") }, { type: "activity", key: activityKey("d-2026-b") },
    ]);
    expect(links.calls).toEqual(["tfsa", `activity:${TFSA}:2026`]);
  });

  it("skips the activity scan when the subject has no activity facts", async () => {
    const links = fakeLinks();
    expect(await linkedNodes(links, ME, { type: "tax_year", key: "2026:tfsa" }, { activity: false })).toEqual([{ type: "account", key: accountKey(TFSA) }]);
    expect(links.calls).toEqual(["tfsa"]);
  });

  it("tax_year:<y>:tfsa also links neutral accounts the user confirmed as TFSAs in the account set", async () => {
    const links = fakeLinks();
    const nodes = await linkedNodes(links, ME, { type: "tax_year", key: "2026:tfsa" }, {
      activity: true, confirmedTfsa: async () => [accountKey(CASH), accountKey(TFSA), "0123456789abcdef"],
    });
    expect(nodes).toEqual([
      { type: "account", key: accountKey(TFSA) }, { type: "account", key: accountKey(CASH) },
      { type: "activity", key: activityKey("d-2026-a") }, { type: "activity", key: activityKey("d-2026-b") },
    ]);
    expect(links.calls).toEqual(["tfsa", "accounts", `activity:${TFSA},${CASH}:2026`]);
  });

  it("account -> its activity; outside or unknown accounts and other node types -> nothing", async () => {
    const links = fakeLinks();
    expect(await linkedNodes(links, ME, { type: "account", key: accountKey(CASH) }, { activity: true })).toEqual([{ type: "activity", key: activityKey("d-cash") }]);
    expect(await linkedNodes(links, ME, { type: "account", key: accountKey("synthetic-unknown") }, { activity: true })).toEqual([]);
    expect(await linkedNodes(links, ME, { type: "account", key: "outside:other-bank" }, { activity: true })).toEqual([]);
    for (const focus of [{ type: "goal", key: "house" }, { type: "sector", key: "Financials" }, { type: "user", key: "me" },
      { type: "rule", key: "cap" }, { type: "activity", key: activityKey("x") }, { type: "tax_year", key: "2026:rrsp" }] as const) {
      expect(await linkedNodes(links, ME, focus, { activity: true })).toEqual([]);
    }
  });
});

describe("buildContext", () => {
  it("security focus: hop 0 then the holding accounts' facts, newest first, with provenance and age", async () => {
    const { deps } = await seeded();
    const bundle = await buildContext(deps, ME, { type: "security", key: "syn" });
    expect(bundle.focus).toEqual({ type: "security", key: "SYN" });
    expect(bundle.truncated).toBe(false);
    expect(bundle.facts.map((f) => [f.text, f.hop, f.provenance, f.ageDays])).toEqual([
      ["Watching SYN.", 0, "stated", 10],
      ["Cash account.", 1, "stated", 4],
      ["Main TFSA.", 1, "inferred", 5],
    ]);
  });

  it("tax_year focus: the room fact, then TFSA accounts and this year's activity facts only", async () => {
    const { deps } = await seeded();
    const bundle = await buildContext(deps, ME, { type: "tax_year", key: "2026:tfsa" });
    expect(bundle.facts.map((f) => [f.property, f.hop])).toEqual([
      ["tax_year.cra_room_jan1", 0],
      ["activity.room_effect", 1],
      ["account.note", 1],
    ]);
    expect(bundle.facts[1]!.node.key).toBe(activityKey("d-2026-a"));
  });

  it("tax_year focus includes a neutral account confirmed in a stated account set, not one from an inferred set", async () => {
    const { repository, deps } = await seeded();
    const service = new MemoryService({ repository, now: () => day(10) });
    const set = (provenance: "stated" | "inferred"): MemoryFactInput => ({
      node: { type: "tax_year", key: "2026:tfsa" }, property: "tax_year.account_set",
      value: { connected: [accountKey(TFSA), accountKey(CASH)], outside: [], confirmedAt: "2026-06-01T12:00:00.000Z" },
      text: "My TFSAs.", kind: "fact", provenance,
    });
    // An inferred set can no longer be saved; a row stored before that rule must still not widen the focus.
    await expect(service.remember(ME, set("inferred"), day(2))).rejects.toThrow("This needs to come from the user");
    const legacy = set("inferred");
    await repository.supersedeAndInsert({
      subject: ME, nodeType: "tax_year", nodeKey: "2026:tfsa", property: legacy.property, value: legacy.value, text: legacy.text, kind: "fact",
      provenance: "inferred", validFrom: new Date(Date.UTC(2026, 0, 1)), validTo: null, recordedAt: day(2), source: "claude",
    }, { sameValidFrom: true });
    let bundle = await buildContext(deps, ME, { type: "tax_year", key: "2026:tfsa" });
    expect(bundle.facts.some((f) => f.text === "Cash account.")).toBe(false);

    await service.remember(ME, set("stated"), day(3));
    bundle = await buildContext(deps, ME, { type: "tax_year", key: "2026:tfsa" });
    expect(bundle.facts.filter((f) => f.hop === 1).map((f) => f.text)).toEqual(["Classified by the user.", "Cash account.", "Main TFSA."]);
  });

  it("account focus: its activity facts", async () => {
    const { deps } = await seeded();
    const bundle = await buildContext(deps, ME, { type: "account", key: accountKey(TFSA) });
    expect(bundle.facts.map((f) => [f.text, f.hop])).toEqual([
      ["Main TFSA.", 0],
      ["Classified by the user.", 1],
      ["Classified by the user.", 1],
    ]);
  });

  it("caps at the limit and reports truncation", async () => {
    const { deps } = await seeded();
    const bundle = await buildContext(deps, ME, { type: "security", key: "SYN" }, 2);
    expect(bundle.facts).toHaveLength(2);
    expect(bundle.truncated).toBe(true);
    expect(bundle.facts[0]!.hop).toBe(0);
  });

  it("is hop 0 only without links", async () => {
    const { repository } = await seeded();
    const bundle = await buildContext({ repository, now: () => day(10) }, ME, { type: "security", key: "SYN" });
    expect(bundle.facts.map((f) => f.hop)).toEqual([0]);
  });

  it("another subject sees nothing", async () => {
    const { deps } = await seeded();
    expect((await buildContext(deps, "subject|synthetic-context-other", { type: "security", key: "SYN" })).facts).toEqual([]);
  });
});

describe("PrismaBrokerageLinks", () => {
  const snapshot = (type: string | null, symbols: string[], extra: Record<string, unknown> = {}) => ({
    payload: { account: { type, metaType: null, unifiedType: null, status: null, ...extra }, positions: symbols.map((symbol) => ({ instrumentId: symbol, symbol })) },
  });
  function port(): BrokerageLinksPrismaPort & { brokerageAccount: { findMany: ReturnType<typeof vi.fn> }; activity: { findMany: ReturnType<typeof vi.fn> } } {
    return {
      brokerageAccount: {
        findMany: vi.fn(async () => [
          { snapTradeAccountId: TFSA, rawType: "TFSA", status: null, snapshots: [snapshot("TFSA", ["SYN", "ABC"])] },
          { snapTradeAccountId: CASH, rawType: "PERSONAL", status: null, snapshots: [snapshot("PERSONAL", ["syn"])] },
          { snapTradeAccountId: "synthetic-closed-tfsa", rawType: "TFSA", status: "CLOSED", snapshots: [] },
          { snapTradeAccountId: "synthetic-bad", rawType: null, status: null, snapshots: [{ payload: "garbage" }] },
        ]),
      },
      activity: { findMany: vi.fn(async () => [{ dedupeKey: "d1" }, { dedupeKey: "d2" }]) },
    };
  }

  it("reads the caller's accounts with each latest snapshot, by subject", async () => {
    const p = port();
    const links = new PrismaBrokerageLinks(p);
    expect(await links.accountsHoldingSecurity(ME, "SYN")).toEqual([TFSA, CASH]);
    expect(p.brokerageAccount.findMany).toHaveBeenCalledWith({
      where: { appUser: { authSubject: ME } },
      orderBy: { snapTradeAccountId: "asc" },
      select: {
        snapTradeAccountId: true, rawType: true, status: true,
        snapshots: { orderBy: { capturedAt: "desc" }, take: 1, select: { payload: true } },
      },
    });
    expect(await links.accountIds(ME)).toEqual([TFSA, CASH, "synthetic-closed-tfsa", "synthetic-bad"]);
  });

  it("finds TFSA-bucket accounts through the taxonomy, including closed ones", async () => {
    expect(await new PrismaBrokerageLinks(port()).tfsaAccounts(ME)).toEqual([TFSA, "synthetic-closed-tfsa"]);
  });

  it("reads activity dedupe keys only, optionally within a calendar year", async () => {
    const p = port();
    const links = new PrismaBrokerageLinks(p);
    expect(await links.activityDedupeKeys(ME, [TFSA], 2026)).toEqual(["d1", "d2"]);
    expect(p.activity.findMany).toHaveBeenCalledWith({
      where: {
        appUser: { authSubject: ME }, snapTradeAccountId: { in: [TFSA] },
        tradeDate: { gte: new Date("2026-01-01T00:00:00.000Z"), lt: new Date("2027-01-01T00:00:00.000Z") },
      },
      select: { dedupeKey: true },
    });
    await links.activityDedupeKeys(ME, [TFSA]);
    expect(p.activity.findMany).toHaveBeenLastCalledWith({
      where: { appUser: { authSubject: ME }, snapTradeAccountId: { in: [TFSA] } }, select: { dedupeKey: true },
    });
    p.activity.findMany.mockClear();
    expect(await links.activityDedupeKeys(ME, [])).toEqual([]);
    expect(p.activity.findMany).not.toHaveBeenCalled();
  });
});
