import { z } from "zod";

import { classifyPortfolioAccount } from "../portfolio/account-taxonomy.js";
import { accountKey, activityKey, isHashKey } from "./keys.js";
import type { FactFilter, MemoryRepository } from "./memory-service.js";
import { MemoryValidationError, feedsNumbers, parseNodeRef, withAge, type ContextFact, type NodeRef, type Provenance } from "./memory-types.js";

/**
 * The context builder (spec §5.3): given a focus node, the current facts on it (hop 0) and on the nodes the
 * brokerage data links to it (hop 1), hop 0 first, then newest first, capped. v1 hop-1 rules use only what
 * VestLens already stores:
 *   security:<ticker>        -> account:<accountKey> for each account whose latest snapshot holds it
 *   tax_year:<year>:tfsa     -> account:<accountKey> for each TFSA-bucket account (closed ones included) and each
 *                               account the user confirmed as a TFSA in that year's account set (e.g. a neutral
 *                               one), and activity:<activityKey> for those accounts' activity traded in that year
 *   account:<accountKey>     -> activity:<activityKey> for that account's activity
 * Every other focus is hop 0 only.
 */

/** What the brokerage data says about a subject's accounts and activity: provider ids and dedupe keys only. */
export interface BrokerageLinks {
  /** snapTradeAccountIds whose latest snapshot holds `symbol` (case-insensitive). */
  accountsHoldingSecurity(subject: string, symbol: string): Promise<string[]>;
  /** snapTradeAccountIds the account taxonomy puts in the TFSA bucket. */
  tfsaAccounts(subject: string): Promise<string[]>;
  accountIds(subject: string): Promise<string[]>;
  /** Stored activity dedupe keys for these accounts; with `year`, trade dates in that calendar year only. */
  activityDedupeKeys(subject: string, snapTradeAccountIds: string[], year?: number): Promise<string[]>;
}

export interface ContextDeps {
  repository: MemoryRepository;
  links?: BrokerageLinks;
  now?: () => Date;
}

export interface ContextBundle {
  focus: NodeRef;
  facts: ContextFact[];
  truncated: boolean;
}

export const DEFAULT_CONTEXT_LIMIT = 20;
const TFSA_FOCUS = /^(\d{4}):tfsa$/;

/**
 * Hop-1 nodes for a focus. `activity` says whether the subject has any activity facts (or how to find out);
 * when not, the activity scan is skipped, since no activity node could carry a fact.
 */
export async function linkedNodes(
  links: BrokerageLinks,
  subject: string,
  focus: NodeRef,
  opts: {
    activity: boolean | (() => Promise<boolean>);
    /** accountKeys in the focus year's account set; connected accounts among them count as TFSAs. */
    confirmedTfsa?: string[] | (() => Promise<string[]>);
  },
): Promise<NodeRef[]> {
  const wantActivity = async () => (typeof opts.activity === "function" ? opts.activity() : opts.activity);
  const activityNodes = async (ids: string[], year?: number): Promise<NodeRef[]> =>
    ids.length > 0 && await wantActivity()
      ? (await links.activityDedupeKeys(subject, ids, year)).map((k) => ({ type: "activity", key: activityKey(k) }))
      : [];
  const accounts = (ids: string[]): NodeRef[] => ids.map((id) => ({ type: "account", key: accountKey(id) }));

  let nodes: NodeRef[] = [];
  if (focus.type === "security") {
    nodes = accounts(await links.accountsHoldingSecurity(subject, focus.key));
  } else if (focus.type === "tax_year") {
    const m = TFSA_FOCUS.exec(focus.key);
    if (m) {
      const tfsa = await links.tfsaAccounts(subject);
      const confirmed = new Set(typeof opts.confirmedTfsa === "function" ? await opts.confirmedTfsa() : opts.confirmedTfsa ?? []);
      for (const k of tfsa) confirmed.delete(accountKey(k));
      if (confirmed.size > 0) {
        for (const id of await links.accountIds(subject)) if (confirmed.has(accountKey(id)) && !tfsa.includes(id)) tfsa.push(id);
      }
      nodes = [...accounts(tfsa), ...await activityNodes(tfsa, Number(m[1]))];
    }
  } else if (focus.type === "account" && isHashKey(focus.key) && await wantActivity()) {
    const id = (await links.accountIds(subject)).find((a) => accountKey(a) === focus.key);
    if (id !== undefined) nodes = await activityNodes([id]);
  }
  const seen = new Set<string>([`${focus.type}\u0000${focus.key}`]);
  return nodes.filter((n) => {
    const k = `${n.type}\u0000${n.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The neighbourhood with optional property/text/history filters (shared by buildContext and recall). */
export async function neighbourhood(
  deps: ContextDeps,
  subject: string,
  focus: NodeRef,
  limit: number,
  filter: Omit<FactFilter, "nodes" | "take" | "nodeType" | "validFrom"> = {},
): Promise<ContextBundle> {
  const now = (deps.now ?? (() => new Date()))();
  const hop0 = await deps.repository.find(subject, { ...filter, nodes: [focus], take: limit + 1 });
  if (hop0.length > limit) return { focus, facts: hop0.slice(0, limit).map((r) => withAge(r, 0, now)), truncated: true };

  let hop1: ContextFact[] = [];
  let truncated = false;
  if (deps.links) {
    const linked = await linkedNodes(deps.links, subject, focus, {
      activity: async () => (await deps.repository.find(subject, { nodeType: "activity", take: 1 })).length > 0,
      confirmedTfsa: async () => confirmedTfsaKeys(deps.repository, subject, focus),
    });
    if (linked.length > 0) {
      const remaining = limit - hop0.length;
      const rows = await deps.repository.find(subject, { ...filter, nodes: linked, take: remaining + 1 });
      truncated = rows.length > remaining;
      hop1 = rows.slice(0, remaining).map((r) => withAge(r, 1, now));
    }
  }
  return { focus, facts: [...hop0.map((r) => withAge(r, 0, now)), ...hop1], truncated };
}

/** accountKeys in the current account set on a tax_year:<y>:tfsa focus, from facts that may feed numbers only. */
async function confirmedTfsaKeys(repository: MemoryRepository, subject: string, focus: NodeRef): Promise<string[]> {
  if (focus.type !== "tax_year" || !TFSA_FOCUS.test(focus.key)) return [];
  const [set] = await repository.find(subject, { nodes: [focus], property: "tax_year.account_set", take: 1 });
  if (!set || set.property !== "tax_year.account_set" || !feedsNumbers(set.provenance as Provenance)) return [];
  const connected = (set.value as { connected?: unknown } | null)?.connected;
  return Array.isArray(connected) ? connected.filter((k): k is string => typeof k === "string" && isHashKey(k)) : [];
}

/** Current facts on `focus` and one hop away, each with provenance and age; hop 0 first, then newest first. */
export async function buildContext(deps: ContextDeps, subject: string, focus: NodeRef, limit = DEFAULT_CONTEXT_LIMIT): Promise<ContextBundle> {
  const parsed = parseNodeRef(focus);
  if (!parsed.ok) throw new MemoryValidationError(parsed.message);
  return neighbourhood(deps, subject, parsed.node, Math.max(1, Math.floor(limit)));
}

type AccountRow = { snapTradeAccountId: string; rawType: string | null; status: string | null; snapshots: Array<{ payload: unknown }> };

export interface BrokerageLinksPrismaPort {
  brokerageAccount: {
    findMany(input: {
      where: { appUser: { authSubject: string } };
      orderBy: { snapTradeAccountId: "asc" };
      select: {
        snapTradeAccountId: true;
        rawType: true;
        status: true;
        snapshots: { orderBy: { capturedAt: "desc" }; take: 1; select: { payload: true } };
      };
    }): Promise<AccountRow[]>;
  };
  activity: {
    findMany(input: {
      where: { appUser: { authSubject: string }; snapTradeAccountId: { in: string[] }; tradeDate?: { gte: Date; lt: Date } };
      select: { dedupeKey: true };
    }): Promise<Array<{ dedupeKey: string }>>;
  };
}

const nullableString = z.string().nullable().optional();
// The parts of snapshotPayload() (prisma-portfolio-state-repository.ts) the links need.
const snapshotLinks = z.looseObject({
  account: z.looseObject({ type: nullableString, metaType: nullableString, unifiedType: nullableString, status: nullableString }),
  positions: z.array(z.looseObject({ symbol: z.string().optional() })),
});

/** BrokerageLinks over stored accounts, their latest snapshots and stored activity, always by auth subject. */
export class PrismaBrokerageLinks implements BrokerageLinks {
  constructor(private readonly prisma: BrokerageLinksPrismaPort) {}

  private async accounts(subject: string): Promise<Array<{ id: string; tfsa: boolean; symbols: Set<string> }>> {
    const rows = await this.prisma.brokerageAccount.findMany({
      where: { appUser: { authSubject: subject } },
      orderBy: { snapTradeAccountId: "asc" },
      select: {
        snapTradeAccountId: true, rawType: true, status: true,
        snapshots: { orderBy: { capturedAt: "desc" }, take: 1, select: { payload: true } },
      },
    });
    return rows.map((row) => {
      const parsed = row.snapshots[0] ? snapshotLinks.safeParse(row.snapshots[0].payload) : undefined;
      const account = parsed?.success ? parsed.data.account : undefined;
      const bucket = classifyPortfolioAccount({
        unifiedType: account?.unifiedType ?? null,
        rawType: account?.type ?? row.rawType,
        metaType: account?.metaType ?? null,
        status: account?.status ?? row.status,
      }).bucket;
      const symbols = new Set((parsed?.success ? parsed.data.positions : []).flatMap((p) => (p.symbol ? [p.symbol.toUpperCase()] : [])));
      return { id: row.snapTradeAccountId, tfsa: bucket === "tfsa", symbols };
    });
  }

  async accountsHoldingSecurity(subject: string, symbol: string): Promise<string[]> {
    const wanted = symbol.toUpperCase();
    return (await this.accounts(subject)).filter((a) => a.symbols.has(wanted)).map((a) => a.id);
  }

  async tfsaAccounts(subject: string): Promise<string[]> {
    return (await this.accounts(subject)).filter((a) => a.tfsa).map((a) => a.id);
  }

  async accountIds(subject: string): Promise<string[]> {
    return (await this.accounts(subject)).map((a) => a.id);
  }

  async activityDedupeKeys(subject: string, snapTradeAccountIds: string[], year?: number): Promise<string[]> {
    if (snapTradeAccountIds.length === 0) return [];
    const rows = await this.prisma.activity.findMany({
      where: {
        appUser: { authSubject: subject },
        snapTradeAccountId: { in: snapTradeAccountIds },
        // tradeDate is a calendar date (no time zone), so the calendar year is [Jan 1, next Jan 1).
        ...(year !== undefined ? { tradeDate: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } } : {}),
      },
      select: { dedupeKey: true },
    });
    return rows.map((r) => r.dedupeKey);
  }
}
