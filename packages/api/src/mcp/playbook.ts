/**
 * The focused-surface server `instructions` (spec 2026-10-29-agent-query-surface-design.md D7): a routing playbook
 * Claude and ChatGPT read at connect time. It is generated from the listed model-visible tool names, so it never names
 * a tool the host can't call. Sections, in order: what VestLens is, choosing a tool, filters, answering, limits, room,
 * no advice. Under PLAYBOOK_MAX_CHARS with every tool listed.
 */

export const PLAYBOOK_MAX_CHARS = 2000;

/** Each section's opening words, in spec order (tests check the order). */
export const PLAYBOOK_SECTIONS = ["VestLens is", "Choosing a tool:", "Filters:", "Answering:", "Limits:", "Room:", "No advice:"] as const;

const READ_ONLY = "must never be represented as trading or account-management capabilities";

/** The tools that write, all to VestLens's own memory only. */
const WRITERS = ["remember", "set_portfolio_limit"];
/** Tools that need the fact deps (theses and limits). */
const FACT_TOOLS = new Set(["show_thesis", "set_portfolio_limit", "show_limits"]);
/** Tools that take the shared accountType filter. */
const ACCOUNT_TYPE_TOOLS = ["show_performance", "show_holdings", "show_allocation", "show_income", "show_activity"];
/** Tools that take the shared symbol filter. */
const SYMBOL_TOOLS = ["show_holdings", "show_income", "show_activity", "show_news"];

/**
 * One "Choosing a tool" line per show_ tool family, naming the questions it answers; each line names only its own
 * tools. The other model-visible tools (snapshot, accounts, positions, history, alerts) route through their own
 * descriptions; list_portfolio_accounts is named under Filters.
 */
const ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["show_portfolio", "total value, accounts, overview, period return"],
  ["show_performance", "returns, gains, drawdown over a period vs a benchmark"],
  ["show_holdings", "what they own, values, shares, cash"],
  ["show_allocation", "diversification, exposure by sector, region, currency or account"],
  ["show_income", "dividends, interest, withholding tax by year"],
  ["show_activity", "trades, deposits, withdrawals, transactions"],
  ["show_news", "what moved and why, holding news"],
  ["show_calendar", "upcoming earnings and dividend dates"],
  ["show_thesis", "how one stock or ETF has done against the S&P 500 and TSX"],
  ["show_limits", "the user's limits against their holdings"],
  ["set_portfolio_limit", "save a limit the user states"],
  ["show_report_card", "how their investing has gone"],
];

const short = (name: string) => name.replace(/^show_/, "");
const either = (names: string[]) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;

export function focusedInstructions(listed: ReadonlySet<string>, opts: { factDeps: boolean }): string {
  const has = (name: string) => listed.has(name) && (opts.factDeps || !FACT_TOOLS.has(name));
  const lines: string[] = [];

  // 1. What VestLens is, with the read-only and safety sentence.
  const writers = WRITERS.filter(has);
  lines.push(
    "VestLens is a read-only view of the user's Wealthsimple accounts through SnapTrade. " +
    (writers.length > 0
      ? `Tools are read-only toward the brokerage (${writers.join(" and ")} write${writers.length === 1 ? "s" : ""} only to VestLens's own memory) and ${READ_ONLY}.`
      : `All tools are read-only and ${READ_ONLY}.`),
  );

  // 2. Choosing a tool: a line only for each listed tool.
  const routes = ROUTES.filter(([name]) => has(name) && !(name === "set_portfolio_limit" && has("show_limits")))
    .map(([name, questions]) => name === "show_limits" && has("set_portfolio_limit")
      ? `${name}: ${questions} (set_portfolio_limit saves one they state).` : `${name}: ${questions}.`);
  if (routes.length > 0) lines.push("Choosing a tool:", ...routes);

  // 3. Filters: one vocabulary across tools.
  const filters: string[] = [];
  // Scoped to the listed tools that take each filter, by short name (show_ dropped), so no unlisted tool is named.
  const accountTypeTools = ACCOUNT_TYPE_TOOLS.filter(has).map(short);
  if (accountTypeTools.length > 0) {
    filters.push(`"my TFSA/FHSA/RRSP/non-registered/crypto/Cash account": accountType (${accountTypeTools.join(", ")}) tfsa, fhsa, rrsp, non_registered, crypto, cash_account.`);
  }
  // Generic cash questions go to the tools that count cash in every account, not to the Cash account (spec D1).
  const cash = ["show_holdings", "show_portfolio"].filter(has);
  if (cash.length > 0) filters.push(`"how much cash do I have": ${either(cash)}, which ${cash.length === 1 ? "includes" : "include"} cash held in every account.`);
  const accountIdNotes = [has("list_portfolio_accounts") ? "from list_portfolio_accounts" : "", has("show_portfolio") ? "not show_portfolio" : ""].filter(Boolean);
  filters.push(`A named account: accountId${accountIdNotes.length > 0 ? ` (${accountIdNotes.join("; ")})` : ""}.`);
  const stock = [SYMBOL_TOOLS.some(has) ? "symbol" : "", has("show_thesis") ? "show_thesis for one holding's story" : ""].filter(Boolean);
  if (stock.length > 0) filters.push(`A stock or ETF: ${stock.join(", or ")}.`);
  if (has("show_activity")) filters.push("Dates: show_activity's from and to.");
  lines.push("Filters:", ...filters);

  // 4. Answering (spec D7, verbatim).
  lines.push("Answering: Every show_ tool renders a widget and returns its figures as text: answer from that text, quoting amounts as given (est. figures stay est.).");

  // 5. Limits of the data.
  lines.push(
    "Limits: holdings and balances update once a day through SnapTrade. Wealthsimple managed portfolios are never in returns, " +
    "and the total leaves out those SnapTrade gives no value (the text names them). Converted amounts are est.",
  );

  // 6. Room.
  if (has("get_contribution_room")) {
    lines.push(`Room: get_contribution_room for TFSA, FHSA and RRSP room${has("remember") ? "; save the inputs it asks for with remember." : "."}`);
  }

  // 7. No advice.
  lines.push("No advice: VestLens states facts, not advice.");
  return lines.join("\n");
}
