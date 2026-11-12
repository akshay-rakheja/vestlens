import { describe, expect, it } from "vitest";

import { ADVICE } from "../testing/copy-rules.js";
import { focusedInstructions, PLAYBOOK_MAX_CHARS, PLAYBOOK_SECTIONS } from "./playbook.js";

// The model-visible tools the everything-enabled harness lists on the focused surface (app-only tools never appear).
const ALL = [
  "get_portfolio_snapshot", "list_portfolio_accounts", "get_account_positions", "get_account_history", "show_portfolio",
  "show_performance", "show_activity", "show_holdings", "show_allocation", "show_income", "show_news", "show_calendar",
  "get_portfolio_alerts", "remember", "get_contribution_room", "show_thesis", "set_portfolio_limit", "show_limits",
  "show_report_card",
];
// No news, calendar, report card or fact tools (no facts dep either).
const REDUCED = ALL.filter((n) => !["show_news", "show_calendar", "show_report_card", "show_thesis", "set_portfolio_limit", "show_limits"].includes(n));
const READ_ONLY = "must never be represented as trading or account-management capabilities";
const TOOL_TOKEN = /\b(show|get|set|list)_[a-z_]+/g;

const named = (text: string) => [...text.matchAll(TOOL_TOKEN)].map((m) => m[0]);

describe("focusedInstructions (spec D7)", () => {
  const all = focusedInstructions(new Set(ALL), { factDeps: true });
  const reduced = focusedInstructions(new Set(REDUCED), { factDeps: false });

  it("has sections 1-7 in order", () => {
    const at = PLAYBOOK_SECTIONS.map((heading) => all.indexOf(heading));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(all.startsWith(PLAYBOOK_SECTIONS[0])).toBe(true);
  });

  it("names every listed show_ tool and get_contribution_room, with the accountType filter", () => {
    for (const name of ALL.filter((n) => n.startsWith("show_")).concat("get_contribution_room")) {
      expect(all).toMatch(new RegExp(`\\b${name}\\b`));
    }
    expect(all).toContain("accountType");
    for (const value of ["tfsa", "fhsa", "rrsp", "non_registered", "crypto", "cash_account"]) expect(all).toContain(value);
  });

  it("keeps the read-only sentence and the memory-write clarification", () => {
    expect(all).toContain(READ_ONLY);
    expect(all).toContain("(remember and set_portfolio_limit write only to VestLens's own memory)");
    expect(reduced).toContain(READ_ONLY);
    expect(reduced).toContain("(remember writes only to VestLens's own memory)");
    expect(focusedInstructions(new Set(["show_portfolio"]), { factDeps: false })).toContain(`All tools are read-only and ${READ_ONLY}.`);
  });

  it("routes generic cash questions to show_holdings / show_portfolio, not the Cash account", () => {
    expect(all).toContain("\"how much cash do I have\": show_holdings or show_portfolio, which include cash held in every account");
    // The verb agrees with the number of tools listed (M9).
    expect(focusedInstructions(new Set(["show_portfolio"]), { factDeps: false })).toContain("\"how much cash do I have\": show_portfolio, which includes cash held in every account.");
    expect(focusedInstructions(new Set(["show_holdings"]), { factDeps: false })).toContain("\"how much cash do I have\": show_holdings, which includes cash held in every account.");
  });

  it("states the answering rule and the data's limits", () => {
    expect(all).toContain("Every show_ tool renders a widget and returns its figures as text: answer from that text, quoting amounts as given (est. figures stay est.).");
    expect(all).toContain("Limits: holdings and balances update once a day through SnapTrade. Wealthsimple managed portfolios are never in returns, and the total leaves out those SnapTrade gives no value (the text names them). Converted amounts are est.");
    expect(all).toContain("Converted amounts are est.");
    expect(reduced).toContain("Converted amounts are est.");
    expect(all.match(/once a day|updated daily/g)).toHaveLength(1);
  });

  it("never says managed portfolios are in totals (R10: the tools say the total leaves out those with no value)", () => {
    for (const text of [all, reduced]) {
      expect(text).not.toMatch(/in totals/);
      expect(text).toContain("the total leaves out");
    }
  });

  it("scopes accountType and accountId to the listed tools that take them", () => {
    expect(all).toContain("accountType (performance, holdings, allocation, income, activity) tfsa, fhsa, rrsp, non_registered, crypto, cash_account.");
    expect(all).toContain("A named account: accountId (from list_portfolio_accounts; not show_portfolio).");
    const some = focusedInstructions(new Set(["show_portfolio", "show_holdings", "show_income"]), { factDeps: false });
    expect(some).toContain("accountType (holdings, income) tfsa");
    expect(some).toContain("A named account: accountId (not show_portfolio).");
    const none = focusedInstructions(new Set(["show_portfolio", "show_news"]), { factDeps: false });
    expect(none).not.toContain("accountType");
  });

  it("is under 2,000 characters with every tool listed", () => {
    expect(all.length).toBeLessThan(PLAYBOOK_MAX_CHARS);
    expect(PLAYBOOK_MAX_CHARS).toBe(2000);
  });

  it("a reduced list names no unlisted tool", () => {
    const listed = new Set(REDUCED);
    expect(named(reduced).filter((n) => !listed.has(n))).toEqual([]);
    for (const gone of ["show_news", "show_calendar", "show_report_card", "show_thesis", "set_portfolio_limit", "show_limits"]) {
      expect(reduced).not.toContain(gone);
    }
  });

  it("with any one tool left out, names no unlisted tool", () => {
    for (const out of ALL) {
      const listed = new Set(ALL.filter((n) => n !== out));
      for (const factDeps of [true, false]) {
        expect(named(focusedInstructions(listed, { factDeps })).filter((n) => !listed.has(n)), out).toEqual([]);
      }
    }
  });

  it("without facts, names no fact tool even when listed", () => {
    const text = focusedInstructions(new Set(ALL), { factDeps: false });
    for (const name of ["show_thesis", "set_portfolio_limit", "show_limits"]) expect(text).not.toContain(name);
  });

  it("gives no advice", () => {
    for (const text of [all, reduced]) {
      expect(text).not.toMatch(ADVICE);
      expect(text).not.toMatch(/\b(sell|buy)\b/i);
    }
    expect(all).toContain("VestLens states facts, not advice.");
  });
});
