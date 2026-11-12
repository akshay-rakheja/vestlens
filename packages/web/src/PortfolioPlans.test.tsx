// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPortfolioApiClient, PortfolioExperience, type PortfolioApiClient, type PortfolioResponse } from "./App";
import { FixedMessageError, type GoalView, type LimitView, type ThesisFullView, type ThesisSummaryView } from "./apiErrors";
import { NudgeBanner, PlansPage } from "./PortfolioPlans";

// Synthetic tickers, names and amounts only.
const HOSTILE = "<b>bold</b> [link](https://x.invalid) <img src=x onerror=alert(1)>";
const noPlayed = { returnPct: null, vsSp500Pct: null, vsTsxPct: null, estimated: false, excluded: [], reason: "can't compare: no purchase date", startDate: null, endDate: null, notes: [] };

const thesis = (over: Partial<ThesisSummaryView> = {}): ThesisSummaryView => ({
  ticker: "SYN.TO", reasons: HOSTILE, boughtAround: null, writtenAt: "2026-06-01T12:00:00.000Z",
  timeFrame: { label: "4 months into a time frame ending 2027-06-01", ended: false },
  conditions: [
    { id: "c1", text: "Falls below 100", kind: "price_below", status: "held", evidence: { value: "CAD 120", asOf: "2026-10-22" } },
    { id: "c2", text: "Over 30% of the portfolio", kind: "weight_above", status: "broken", evidence: { value: "40% (est.)", asOf: "2026-10-22" } },
    { id: "c3", text: "Revenue growth above 20%", kind: "fundamental", status: "cant_tell", note: "can't check automatically yet" },
  ],
  playedOut: noPlayed, ...over,
});
const full = (): ThesisFullView => ({
  ticker: "SYN.TO",
  thesis: {
    reasons: HOSTILE, boughtAround: null, history: 0,
    check: {
      ticker: "SYN.TO", writtenAt: "2026-06-01T12:00:00.000Z", timeFrame: null, conditions: thesis().conditions,
      news: [{ title: "<i>Synthetic</i> headline", source: "Synthetic Wire", publishedAt: "2026-09-01T00:00:00.000Z", tone: "neutral" }],
      earnings: [{ date: "2026-11-05" }],
      playedOut: { returnPct: 12.34, vsSp500Pct: 2.5, vsTsxPct: -1.3, estimated: true, excluded: [], startDate: "2026-06-01", endDate: "2026-10-22", notes: ["Benchmarks are price indexes: dividends are left out."] },
    },
  },
});
const limit = (over: Partial<LimitView> = {}): LimitView => ({
  slug: "single-holding-syn-to", kind: "single_holding", target: "SYN.TO", maxPct: 10, label: "SYN.TO",
  rows: [{ label: "SYN.TO", currentPct: 40, status: "over", line: "SYN.TO 40% (est.), over your 10% limit", text: "SYN.TO 40% (est.), over your 10% limit. (of your portfolio, cash included) Other listings not combined.", unclassifiedPct: null, fxDate: null }],
  ...over,
});
const goal = (over: Partial<GoalView> = {}): GoalView => ({
  slug: "house", name: "House", targetCad: 50_000, targetDate: "2028-06-30", savedCad: 1300, savedPct: 2.6, remainingCad: 48_700,
  estimated: false, savedFxDate: null, paceEstimated: false, paceFxDate: null, monthsLeft: 20.5, dateStatus: "future",
  neededPerMonthFlatCad: 2400, recentPacePerMonthCad: 100, projectedAtPaceCad: 3300, projectedWithRateCad: null, growthRatePct: null, notes: ["the recent pace counts connected accounts only"], ...over,
});

function plansApi(over: Partial<PortfolioApiClient> = {}): PortfolioApiClient {
  return {
    getPortfolio: async () => ({}) as never, getConnections: async () => [], createConnectionSession: async () => ({ portalUrl: "https://x.invalid" }),
    getTheses: vi.fn(async () => ({ theses: [thesis()] })), getThesis: vi.fn(async () => full()),
    getLimits: vi.fn(async () => ({ limits: [limit()] })), getGoals: vi.fn(async () => ({ goals: [goal()] })),
    editThesis: vi.fn(async () => undefined), editLimit: vi.fn(async () => undefined), editGoal: vi.fn(async () => undefined),
    deleteThesis: vi.fn(async () => undefined), deleteLimit: vi.fn(async () => undefined), deleteGoal: vi.fn(async () => undefined),
    ...over,
  };
}
const open = (api: PortfolioApiClient) => render(<PlansPage api={api} onBack={() => undefined} onSignOut={() => undefined} />);
const section = (name: RegExp) => screen.findByRole("region", { name });

afterEach(cleanup);

describe("Your theses", () => {
  it("shows ticker, reasons, condition chips with status, and the played-out row, all as literal text", async () => {
    const { container } = open(plansApi());
    const s = await section(/your theses/i);
    expect(within(s).getByRole("heading", { name: "SYN.TO" })).toBeInTheDocument();
    expect(within(s).getByText(HOSTILE)).toBeInTheDocument();
    expect(container.querySelector("img, b, i, a[href*='x.invalid']")).toBeNull();
    const chips = within(s).getByRole("list", { name: /conditions for SYN\.TO/i });
    expect(chips).toHaveTextContent("Falls below 100: held");
    expect(chips).toHaveTextContent("Over 30% of the portfolio: broken");
    expect(chips).toHaveTextContent("Revenue growth above 20%: can't tell");
    expect(chips).toHaveTextContent("CAD 120, 2026-10-22");
    expect(within(s).getByText("How it played out: can't compare: no purchase date.")).toBeInTheDocument();
  });

  it("opens the full check on request: return against the S&P 500 and TSX, news, earnings and the price-index note", async () => {
    const api = plansApi();
    const { container } = open(api);
    const s = await section(/your theses/i);
    fireEvent.click(await within(s).findByRole("button", { name: /open full check/i }));
    await waitFor(() => expect(api.getThesis).toHaveBeenCalledWith("SYN.TO"));
    expect(await within(s).findByText(/How it played out \(2026-06-01 to 2026-10-22, est\.\): your return 12\.3%; \+2\.5 pts vs the same money in the S&P 500; -1\.3 pts vs the TSX\./)).toBeInTheDocument();
    expect(within(s).getByText("Benchmarks are price indexes: dividends are left out.")).toBeInTheDocument();
    expect(within(s).getByText(/<i>Synthetic<\/i> headline/)).toBeInTheDocument();
    expect(within(s).getByText(/2026-11-05/)).toBeInTheDocument();
    expect(container.querySelector("i")).toBeNull();
  });

  it("the cheap card says return and played out are checked in the full view; the full check then updates the chips (I-3)", async () => {
    const quick = thesis({
      conditions: [{ id: "r1", text: "Down 20%", kind: "return_below", status: "cant_tell", note: "checked in the full view" }],
      playedOut: { ...noPlayed, reason: "checked in the full view" },
    });
    const view = full();
    view.thesis.check.conditions = [{ id: "r1", text: "Down 20%", kind: "return_below", status: "held", evidence: { value: "12.3% (est.)", asOf: "2026-10-22" } }];
    const api = plansApi({ getTheses: vi.fn(async () => ({ theses: [quick] })), getThesis: vi.fn(async () => view) });
    open(api);
    const s = await section(/your theses/i);
    expect(await within(s).findByText("How it played out: checked in the full view.")).toBeInTheDocument();
    const chips = within(s).getByRole("list", { name: /conditions for SYN\.TO/i });
    expect(chips).toHaveTextContent("Down 20%: can't tell");
    expect(chips).toHaveTextContent("checked in the full view");
    fireEvent.click(within(s).getByRole("button", { name: /open full check/i }));
    await within(s).findByText(/your return 12\.3%/);
    const updated = within(s).getByRole("list", { name: /conditions for SYN\.TO/i });
    expect(updated).toHaveTextContent("Down 20%: held");
    expect(updated).toHaveTextContent("12.3% (est.), 2026-10-22");
    expect(updated).not.toHaveTextContent("checked in the full view");
  });

  it("a failed full check is a fixed line, not the server's text", async () => {
    open(plansApi({ getThesis: vi.fn(async () => { throw new Error("SERVER-DETAIL secret|x"); }) }));
    const s = await section(/your theses/i);
    fireEvent.click(await within(s).findByRole("button", { name: /open full check/i }));
    expect(await within(s).findByText("The full check is unavailable right now.")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("SERVER-DETAIL");
  });

  it("changes the time frame by value only, with no reasons field and no wording sent", async () => {
    const api = plansApi();
    open(api);
    const s = await section(/your theses/i);
    fireEvent.click(await within(s).findByRole("button", { name: /edit/i }));
    expect(within(s).queryByLabelText(/reasons/i)).not.toBeInTheDocument();
    fireEvent.change(within(s).getByLabelText(/time frame/i), { target: { value: "short" } });
    fireEvent.change(within(s).getByLabelText(/end date/i), { target: { value: "2027-06-01" } });
    fireEvent.click(within(s).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.editThesis).toHaveBeenCalledWith("SYN.TO", { timeFrame: { kind: "short", endDate: "2027-06-01" } }));
    await waitFor(() => expect(api.getTheses).toHaveBeenCalledTimes(2));
  });

  it("deletes only after a confirm; cancel changes nothing", async () => {
    const api = plansApi();
    open(api);
    const s = await section(/your theses/i);
    fireEvent.click(await within(s).findByRole("button", { name: /delete/i }));
    const dialog = within(s).getByRole("alertdialog");
    expect(dialog).toHaveTextContent(/removes your thesis on SYN\.TO/i);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.deleteThesis).not.toHaveBeenCalled();
    fireEvent.click(within(s).getByRole("button", { name: /delete/i }));
    fireEvent.click(within(within(s).getByRole("alertdialog")).getByRole("button", { name: /delete thesis/i }));
    await waitFor(() => expect(api.deleteThesis).toHaveBeenCalledWith("SYN.TO"));
    await waitFor(() => expect(api.getTheses).toHaveBeenCalledTimes(2));
  });

  it("says plainly when there are none, and a save failure shows the client's fixed message", async () => {
    open(plansApi({ getTheses: vi.fn(async () => ({ theses: [] })) }));
    expect(await within(await section(/your theses/i)).findByText(/no theses saved yet/i)).toBeInTheDocument();
    cleanup();
    open(plansApi({ editThesis: vi.fn(async () => { throw new FixedMessageError("That change could not be saved."); }) }));
    const s = await section(/your theses/i);
    fireEvent.click(await within(s).findByRole("button", { name: /edit/i }));
    fireEvent.click(within(s).getByRole("button", { name: "Save" }));
    expect(await within(s).findByRole("alert")).toHaveTextContent("That change could not be saved.");
  });
});

describe("Your limits", () => {
  it("shows the current-versus-max bar and the basis sentence", async () => {
    open(plansApi());
    const s = await section(/your limits/i);
    expect(within(s).getByText("10% limit on SYN.TO")).toBeInTheDocument();
    const bar = within(s).getByRole("progressbar", { name: /SYN\.TO.*40%.*10% limit/i });
    expect(bar).toHaveAttribute("aria-valuenow", "40");
    expect(within(s).getByText(/\(of your portfolio, cash included\) Other listings not combined\./)).toBeInTheDocument();
  });

  it("a company's listing row is a breakdown with no bar (A5)", async () => {
    const rows = [
      { label: "SYN (all listings)", currentPct: 12, status: "over" as const, line: "SYN (all listings) 12%, over your 10% limit", text: "SYN (all listings) 12%, over your 10% limit.", unclassifiedPct: null, fxDate: null },
      { label: "SYN (USD)", currentPct: 6, status: "over" as const, informational: true, line: "SYN (USD) 6%, counted in SYN (all listings)", text: "x", unclassifiedPct: null, fxDate: null },
    ];
    open(plansApi({ getLimits: async () => ({ limits: [{ slug: "l", kind: "single_holding", target: "SYN", maxPct: 10, label: "SYN", rows }] }) } as never));
    const s = await section(/your limits/i);
    expect(within(s).getAllByRole("progressbar")).toHaveLength(1);
    expect(within(s).getByText("SYN (USD) 6%, counted in SYN (all listings)")).toBeInTheDocument();
  });

  it("a row with no number shows its text and no bar; the bar never exceeds the track", async () => {
    const rows = [
      { label: "Technology", currentPct: null, status: "cant_tell" as const, line: "Technology: can't tell", text: "Technology: can't tell. (of your portfolio, cash included)", unclassifiedPct: null, fxDate: null },
      { label: "SYN.TO", currentPct: 140, status: "over" as const, line: "x", text: "x", unclassifiedPct: null, fxDate: null },
    ];
    open(plansApi({ getLimits: vi.fn(async () => ({ limits: [limit({ rows })] })) }));
    const s = await section(/your limits/i);
    expect(within(s).getAllByRole("progressbar")).toHaveLength(1);
    expect(within(s).getByRole("progressbar").querySelector("span")).toHaveStyle({ width: "100%" });
    expect(within(s).getByText(/Technology: can't tell/)).toBeInTheDocument();
  });

  it("edits the maximum through the memory route", async () => {
    const api = plansApi();
    open(api);
    const s = await section(/your limits/i);
    fireEvent.click(await within(s).findByRole("button", { name: /edit/i }));
    fireEvent.change(within(s).getByLabelText(/maximum share/i), { target: { value: "15" } });
    fireEvent.click(within(s).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.editLimit).toHaveBeenCalledWith("single-holding-syn-to", { maxPct: 15 }));
  });

  it("deletes after a confirm", async () => {
    const api = plansApi();
    open(api);
    const s = await section(/your limits/i);
    fireEvent.click(await within(s).findByRole("button", { name: /delete/i }));
    expect(api.deleteLimit).not.toHaveBeenCalled();
    fireEvent.click(within(within(s).getByRole("alertdialog")).getByRole("button", { name: /delete limit/i }));
    await waitFor(() => expect(api.deleteLimit).toHaveBeenCalledWith("single-holding-syn-to"));
  });
});

describe("Your goals", () => {
  it("a met goal says the target is reached; a prorated pace says since when (B10)", async () => {
    open(plansApi({ getGoals: vi.fn(async () => ({ goals: [goal({ savedCad: 12_000, savedPct: 120, remainingCad: 0, neededPerMonthFlatCad: 0, recentPacePerMonthCad: 2_013, paceSince: "2026-08-15" })] })) }));
    const s = await section(/your goals/i);
    expect(s).toHaveTextContent("What it takes: target reached.");
    expect(s).toHaveTextContent("a month in net contributions since 2026-08-15");
    expect(s).not.toHaveTextContent("last 6 months");
  });

  it("shows progress, time left, what it takes, the pace and its projection", async () => {
    open(plansApi());
    const s = await section(/your goals/i);
    expect(within(s).getByRole("heading", { name: "House" })).toBeInTheDocument();
    expect(within(s).getByRole("progressbar", { name: /House.*3% of the target/i })).toHaveAttribute("aria-valuenow", "2.6");
    expect(s).toHaveTextContent("Saved so far: about $1,300, 3% of the target.");
    expect(s).toHaveTextContent("Time left: 20 months.");
    expect(s).toHaveTextContent("What it takes: about $2,400 a month from here reaches the target if values stay flat.");
    expect(s).toHaveTextContent("Recent pace: about $100 a month in net contributions over the last 6 months; at that pace, about $3,300 by 2028-06-30 with no growth.");
    expect(s).toHaveTextContent("The recent pace counts connected accounts only.");
    expect(s).not.toHaveTextContent("(your assumption)");
  });

  it("labels the growth projection as the user's assumption, only when a rate is set", async () => {
    open(plansApi({ getGoals: vi.fn(async () => ({ goals: [goal({ growthRatePct: 5, projectedWithRateCad: 4100 })] })) }));
    const s = await section(/your goals/i);
    expect(s).toHaveTextContent("With your 5% yearly growth rate (your assumption): about $4,100 by 2028-06-30.");
  });

  it("converted figures carry est. and the Bank of Canada date", async () => {
    open(plansApi({ getGoals: vi.fn(async () => ({ goals: [goal({ estimated: true, savedFxDate: "2026-10-22" })] })) }));
    expect(await section(/your goals/i)).toHaveTextContent("Saved so far: about $1,300 (est., Bank of Canada rate 2026-10-22), 3% of the target.");
  });

  it("a passed or nearly-passed date shows that, with the pace and no negative monthly amount", async () => {
    open(plansApi({ getGoals: vi.fn(async () => ({ goals: [goal({ dateStatus: "passed", monthsLeft: 0, neededPerMonthFlatCad: null })] })) }));
    const s = await section(/your goals/i);
    expect(s).toHaveTextContent("Time left: target date passed.");
    expect(s).toHaveTextContent("Recent pace: about $100 a month");
    expect(s.textContent).not.toMatch(/-\$/);
    cleanup();
    open(plansApi({ getGoals: vi.fn(async () => ({ goals: [goal({ dateStatus: "under_month", monthsLeft: 0.4 })] })) }));
    expect(await section(/your goals/i)).toHaveTextContent("Time left: less than a month left.");
  });

  it("a lower bound reads 'at least', with no percentage and no bar (review 7)", async () => {
    open(plansApi({ getGoals: vi.fn(async () => ({ goals: [goal({ savedCad: 40_000, savedAtLeast: true, savedPct: null, remainingCad: null, neededPerMonthFlatCad: null, projectedAtPaceCad: null })] })) }));
    const s = await section(/your goals/i);
    expect(s).toHaveTextContent("Saved so far: at least $40,000; an account's value is unknown (see the notes), so there is no percentage of the target.");
    expect(s).not.toHaveTextContent("What it takes");
    expect(within(s).queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("unknown saved total reads as can't tell, with no bar", async () => {
    open(plansApi({ getGoals: vi.fn(async () => ({ goals: [goal({ savedCad: null, savedPct: null, remainingCad: null, neededPerMonthFlatCad: null, recentPacePerMonthCad: null, projectedAtPaceCad: null })] })) }));
    const s = await section(/your goals/i);
    expect(s).toHaveTextContent("Saved so far: can't tell (see the notes).");
    expect(within(s).queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("edits the target, date and growth rate by value; a blank rate is sent as null", async () => {
    const api = plansApi();
    open(api);
    const s = await section(/your goals/i);
    fireEvent.click(await within(s).findByRole("button", { name: /edit/i }));
    fireEvent.change(within(s).getByLabelText(/target amount/i), { target: { value: "60000" } });
    fireEvent.change(within(s).getByLabelText(/growth rate/i), { target: { value: "" } });
    fireEvent.click(within(s).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.editGoal).toHaveBeenCalledWith("house", { targetCad: 60_000, targetDate: "2028-06-30", growthRatePct: null }));
  });
});

describe("Plans page", () => {
  it("each section fails on its own with a fixed line", async () => {
    open(plansApi({ getLimits: vi.fn(async () => { throw new Error("SERVER-DETAIL"); }), getGoals: vi.fn(async () => { throw new FixedMessageError("Your session has expired. Please sign in again."); }) }));
    expect(await within(await section(/your limits/i)).findByRole("alert")).toHaveTextContent("Your limits are unavailable right now.");
    expect(await within(await section(/your goals/i)).findByRole("alert")).toHaveTextContent("Your goals are unavailable right now.");
    expect(await within(await section(/your theses/i)).findByRole("heading", { name: "SYN.TO" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("SERVER-DETAIL");
  });

  it("offers no edit or delete when the client has none, and carries no advice copy", async () => {
    open(plansApi({ editThesis: undefined, deleteThesis: undefined, editLimit: undefined, deleteLimit: undefined, editGoal: undefined, deleteGoal: undefined }));
    const s = await section(/your theses/i);
    await within(s).findByRole("heading", { name: "SYN.TO" });
    expect(screen.queryByRole("button", { name: /edit|delete/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\byou should\b|\bwe recommend\b|\bconsider (selling|buying|trimming)\b|\b(sell|buy) (it|now)\b/i);
  });
});

describe("Nudge banner", () => {
  it("shows each open nudge as literal text, none when there are none", () => {
    const { container, rerender } = render(<NudgeBanner state={{ status: "ready", nudges: [{ kind: "limit", target: "x", text: HOSTILE, raisedAt: "2026-10-24T08:00:00.000Z" }] }} />);
    expect(screen.getByText(HOSTILE)).toBeInTheDocument();
    expect(container.querySelector("img, b")).toBeNull();
    rerender(<NudgeBanner state={{ status: "ready", nudges: [] }} />);
    expect(screen.queryByTestId("nudge-banner")).not.toBeInTheDocument();
    rerender(<NudgeBanner state={{ status: "error" }} />);
    expect(screen.queryByTestId("nudge-banner")).not.toBeInTheDocument();
  });
});

describe("dashboard integration", () => {
  const portfolio: PortfolioResponse = { connectionRequired: false, generatedAt: "2026-10-24T20:00:00.000Z", totals: [], accounts: [], errors: [] };
  const auth = { isLoading: false, isAuthenticated: true, userName: "Sam", login: async () => undefined, logout: () => undefined };
  const dash = (api: Partial<PortfolioApiClient>) => render(
    <PortfolioExperience auth={auth} api={{ getPortfolio: async () => portfolio, getConnections: async () => [], createConnectionSession: async () => ({ portalUrl: "https://x.invalid" }), ...api }} />,
  );

  it("shows open nudges in the banner area, under the TFSA alert", async () => {
    dash({
      getTfsaRoom: async () => ({ status: "known", year: 2026, roomLeftCad: -100, contributedCad: 7100, craRoomCad: 7000, withdrawnCad: 0, estimated: false, overLimitCad: 100, basis: [], fx: { contributions: { estimated: false, rateDates: [], native: [] }, withdrawals: { estimated: false, rateDates: [], native: [] } }, alert: { year: 2026, excessCad: 100, estimated: false, note: null }, ledger: { rows: [], overSince: null, undatedExcess: false }, accounts: [], outcomes: {} }),
      getNudges: async () => ({ nudges: [{ kind: "limit", target: "x", text: "SYN is 40% (est.) of your portfolio, over your 10% limit.", raisedAt: "2026-10-24T08:00:00.000Z" }] }),
    });
    const nudge = await screen.findByTestId("nudge-banner");
    const tfsa = await screen.findByTestId("tfsa-over-limit-banner");
    expect(nudge).toHaveTextContent("SYN is 40% (est.) of your portfolio, over your 10% limit.");
    expect(tfsa.compareDocumentPosition(nudge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a failed nudge read never holds the dashboard back", async () => {
    dash({ getNudges: async () => { throw new Error("SERVER-DETAIL"); } });
    expect(await screen.findByText(/Brokerage-reported portfolio value/)).toBeInTheDocument();
    expect(screen.queryByTestId("nudge-banner")).not.toBeInTheDocument();
  });

  it("reaches the Plans page from the dashboard and back", async () => {
    const api = plansApi();
    render(<PortfolioExperience auth={auth} api={{ ...api, getPortfolio: async () => portfolio }} />);
    fireEvent.click(await screen.findByRole("button", { name: /plans/i }));
    expect(await screen.findByRole("heading", { name: "Plans" })).toBeInTheDocument();
    expect(await within(await section(/your theses/i)).findByRole("heading", { name: "SYN.TO" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(await screen.findByText(/Brokerage-reported portfolio value/)).toBeInTheDocument();
  });

  it("has no Plans button when the client has no plan methods", async () => {
    dash({});
    await screen.findByText(/Brokerage-reported portfolio value/);
    expect(screen.queryByRole("button", { name: /plans/i })).not.toBeInTheDocument();
  });
});

describe("plans API client", () => {
  it("calls the plan routes on the session cookie and encodes the ticker", async () => {
    const requests: Array<[string, string | null]> = [];
    const client = createPortfolioApiClient({
      fetchImpl: async (input, init) => { requests.push([String(input), new Headers(init?.headers).get("Authorization")]); return new Response("{}"); },
    });
    await client.getTheses!(); await client.getThesis!("SYN.TO/x"); await client.getLimits!(); await client.getGoals!(); await client.getNudges!();
    expect(requests).toEqual([
      ["/api/theses", null], ["/api/theses/SYN.TO%2Fx", null], ["/api/limits", null],
      ["/api/goals", null], ["/api/nudges", null],
    ]);
  });

  it("sends typed edits and deletes to the plan routes, values only", async () => {
    const requests: Array<[string, string | undefined, string | undefined]> = [];
    const client = createPortfolioApiClient({
      fetchImpl: async (input, init) => { requests.push([String(input), init?.method, init?.body as string | undefined]); return init?.method === "DELETE" ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ saved: true })); },
    });
    await client.editLimit!("a/b", { maxPct: 15 }); await client.editGoal!("house", { growthRatePct: null }); await client.editThesis!("SYN.TO", { timeFrame: null });
    await client.deleteLimit!("a/b"); await client.deleteGoal!("house"); await client.deleteThesis!("SYN.TO");
    expect(requests).toEqual([
      ["/api/limits/a%2Fb", "PATCH", '{"maxPct":15}'], ["/api/goals/house", "PATCH", '{"growthRatePct":null}'], ["/api/theses/SYN.TO", "PATCH", '{"timeFrame":null}'],
      ["/api/limits/a%2Fb", "DELETE", undefined], ["/api/goals/house", "DELETE", undefined], ["/api/theses/SYN.TO", "DELETE", undefined],
    ]);
  });

  it("points a refused generic edit to the Plans page", async () => {
    const client = createPortfolioApiClient({ fetchImpl: async () => new Response(JSON.stringify({ error: "use_plans_page", message: "SERVER-DETAIL" }), { status: 400 }) });
    await expect(client.editMemory!("x", { text: "y" })).rejects.toThrow("Edit theses, limits and goals on the Plans page.");
  });

  it("throws a fixed message, never the server's text", async () => {
    const client = createPortfolioApiClient({ fetchImpl: async () => new Response("SERVER-DETAIL", { status: 503 }) });
    await expect(client.getLimits!()).rejects.toBeInstanceOf(FixedMessageError);
    await expect(client.getLimits!()).rejects.not.toThrow(/SERVER-DETAIL/);
  });
});
