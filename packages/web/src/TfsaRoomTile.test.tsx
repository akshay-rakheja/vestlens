// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PortfolioExperience, type PortfolioResponse } from "./App";
import type { TfsaRoomView } from "./apiErrors";

// Synthetic amounts and labels only.
const portfolio: PortfolioResponse = { connectionRequired: false, generatedAt: "2026-10-24T20:00:00.000Z", totals: [], accounts: [], errors: [] };
const noFx = { contributions: { estimated: false, rateDates: [], native: [] }, withdrawals: { estimated: false, rateDates: [], native: [] } };
const auth = { isLoading: false, isAuthenticated: true, userName: "Sam", login: async () => undefined, logout: () => undefined };
const ALERT_NOTE = "(est.; includes US$4,000 converted at the Bank of Canada rate of 2026-06-01)";

const known = (over: Record<string, unknown> = {}): TfsaRoomView => ({
  status: "known", year: 2026, roomLeftCad: 1000, contributedCad: 6000, craRoomCad: 7000, withdrawnCad: 0, estimated: false, overLimitCad: 0,
  basis: ["CRA room on 1 January 2026: $7,000"], fx: noFx, alert: null, ledger: { rows: [], overSince: null, undatedExcess: false }, accounts: [], outcomes: {}, ...over,
} as TfsaRoomView);
const missing = (items: unknown[], over: Record<string, unknown> = {}): TfsaRoomView => ({
  status: "missing", year: 2026, missing: items, withdrawnCad: 0, basis: [], fx: noFx, alert: null, ledger: { rows: [], overSince: null, undatedExcess: false }, accounts: [], outcomes: {}, ...over,
} as TfsaRoomView);

function show(getTfsaRoom?: () => Promise<TfsaRoomView>) {
  render(
    <PortfolioExperience
      auth={auth}
      api={{
        getPortfolio: async () => portfolio, getConnections: async () => [], createConnectionSession: async () => ({ portalUrl: "https://x.invalid" }),
        ...(getTfsaRoom ? { getTfsaRoom } : {}),
      }}
    />,
  );
}
const tile = async () => screen.findByRole("region", { name: /tfsa room/i });

afterEach(cleanup);

describe("TFSA room tile", () => {
  it("shows the number with the basis, and no banner without an open alert", async () => {
    show(async () => known());
    const t = await tile();
    expect(await within(t).findByText("About $1,000 of TFSA room left this year")).toBeInTheDocument();
    expect(t).toHaveTextContent("CRA room on 1 January 2026: $7,000");
    expect(screen.queryByTestId("tfsa-over-limit-banner")).not.toBeInTheDocument();
  });

  it("formats converted contributions like the API text: est., Bank of Canada date, native amount", async () => {
    show(async () => known({ estimated: true, fx: { ...noFx, contributions: { estimated: true, rateDates: ["2026-06-01"], native: [{ amount: 4000, currency: "USD" }] } } }));
    const t = await tile();
    expect(await within(t).findByText(ALERT_NOTE)).toBeInTheDocument();
    expect(t).not.toHaveTextContent("(est.) ");
  });

  it("lists what is missing after the lead-in, as text", async () => {
    show(async () => missing([
      { kind: "cra_room" },
      { kind: "ambiguous", count: 2, rows: [{ activityKey: "k1", date: "2026-03-03", amountCad: 5000, estimated: false, rateDate: null, native: null, type: "INTERNAL_CASH_TRANSFER_IN", label: "<b>TFSA</b>" }] },
    ]));
    const t = await tile();
    expect(await within(t).findByText("I can't give a number yet:")).toBeInTheDocument();
    expect(t).toHaveTextContent("Your TFSA contribution room on 1 January 2026, from CRA My Account");
    expect(t).toHaveTextContent("2 transfers need checking");
    expect(t).toHaveTextContent("<b>TFSA</b> internal cash transfer in 2026-03-03, $5,000");
    expect(t.querySelector("b")).toBeNull();
  });

  it("says how current the activity is, and lists stale and disconnected items", async () => {
    show(async () => known({ activityAsOf: "2026-10-24T08:00:00.000Z" }));
    const t = await tile();
    // The same freshness line as the room page, the card and the tool text (B12).
    expect(await within(t).findByText("Based on activity up to 24 October 2026; deposits made since then aren't included")).toBeInTheDocument();
    cleanup();
    show(async () => missing([
      { kind: "stale_activity", accountKey: "1111111111111111", label: "Main TFSA", lastSyncedAt: "2026-10-22T15:00:00.000Z" },
      { kind: "disconnected_account", accountKey: "3333333333333333" },
    ]));
    const m = await tile();
    expect(await within(m).findByText("Main TFSA's activity was last updated 22 October 2026, 11:00 a.m. Toronto time; there'll be a number after it refreshes")).toBeInTheDocument();
    expect(m).toHaveTextContent("What you contributed this year to a TFSA you confirmed that is no longer connected (key 3333333333333333)");
  });

  it("shows the withdrawal note when there were withdrawals; over-contribution only when the room left is less (B4)", async () => {
    show(async () => known({ withdrawnCad: 5000 }));
    expect(await within(await tile()).findByText("You withdrew $5,000 this year. That room comes back on 1 January 2027. Putting it back before then would be an over-contribution.")).toBeInTheDocument();
    cleanup();
    show(async () => known({ withdrawnCad: 500, returningCad: 500, roomLeftCad: 6000 }));
    expect(await within(await tile()).findByText("You withdrew $500 this year. That room comes back on 1 January 2027. Putting it back before then would count as a new contribution against your remaining room.")).toBeInTheDocument();
  });

  it("the withdrawal note counts only the part that comes back; none when it all reduced an amount over", async () => {
    show(async () => known({ withdrawnCad: 3000, returningCad: 2000 }));
    expect(await within(await tile()).findByText("You withdrew $2,000 this year. That room comes back on 1 January 2027. Putting it back before then would be an over-contribution.")).toBeInTheDocument();
    cleanup();
    show(async () => known({ withdrawnCad: 2000, returningCad: 0 }));
    const t = await tile();
    await within(t).findByText("About $1,000 of TFSA room left this year");
    expect(t).not.toHaveTextContent("comes back");
  });

  it("missing state: the withdrawal sentence doesn't say how much room comes back", async () => {
    show(async () => missing([{ kind: "cra_room" }], { withdrawnCad: 2000, returningCad: 0 }));
    const t = await tile();
    expect(await within(t).findByText("You withdrew $2,000 this year. Some or all of that room comes back on 1 January 2027; the exact amount needs the missing items above.")).toBeInTheDocument();
    expect(t).not.toHaveTextContent("That room comes back");
  });

  it("the used figure comes from the ledger (CRA room less room left), not the contributions", async () => {
    // Room 5,000; +7,000; −2,000 (all of it reduced the excess); +1,000: 1,000 over, so 6,000 used of 5,000.
    show(async () => known({ craRoomCad: 5000, contributedCad: 8000, roomLeftCad: -1000, overLimitCad: 1000, withdrawnCad: 2000, returningCad: 0 }));
    const t = await tile();
    expect(await within(t).findByText("Used $6,000 of $5,000 CRA room")).toBeInTheDocument();
    expect(t).not.toHaveTextContent("Contributed");
  });

  it("shares moved in kind with no price say so and say the way out (review 3)", async () => {
    show(async () => missing([{ kind: "ambiguous", count: 1, rows: [
      { activityKey: "k4", date: "2026-03-15", amountCad: null, estimated: false, rateDate: null, native: null, type: "TRANSFER", label: "TFSA 1", inKind: true, accountKey: "1".repeat(16) },
    ] }]));
    const t = await tile();
    expect(await within(t).findByText(/shares moved in kind, no price or close found/)).toBeInTheDocument();
    expect(within(t).getByText(/Give what you have contributed to TFSA 1 this year as of a date on or after 2026-03-15, these shares at their value that day included, in Claude or ChatGPT through VestLens, and don't include amounts already entered elsewhere/)).toBeInTheDocument();
    expect(t).not.toHaveTextContent("amount not known in CAD");
  });

  it("a managed TFSA's line points to the contribution room page, not chat alone, and says not to double count (review 6)", async () => {
    show(async () => missing([{ kind: "managed_account", label: "Managed TFSA", accountKey: "5".repeat(16) }]));
    const t = await tile();
    expect(await within(t).findByText(/What you have contributed to Managed TFSA this year, and as of what date \(contributions to it aren't visible through SnapTrade\)\. Don't include amounts already entered elsewhere\./)).toBeInTheDocument();
    expect(t).toHaveTextContent("You can enter this on the contribution room page, or in Claude or ChatGPT through VestLens.");
    expect(t).not.toHaveTextContent("the dashboard doesn't take it yet");
  });

  it("a known number says beneath it what isn't counted, and says nothing without the field", async () => {
    show(async () => known({ notCounted: [{ accountKey: "5".repeat(16), label: "Managed TFSA" }] }));
    const t = await tile();
    expect(await within(t).findByText("Not counted: Managed TFSA. Contributions to it aren't visible through SnapTrade. If you contributed to it this year, your room is lower than this.")).toBeInTheDocument();
  });

  it("coverage and disconnected items say the figure can be given in Claude or ChatGPT", async () => {
    show(async () => missing([{ kind: "coverage", label: "Gap TFSA", accountKey: "3333333333333333" }, { kind: "disconnected_account", accountKey: "4444444444444444" }]));
    const t = await tile();
    await within(t).findByText("I can't give a number yet:");
    expect(within(t).getAllByText(/You can give this figure in Claude or ChatGPT through VestLens; the dashboard doesn't take it yet\./)).toHaveLength(2);
  });

  it("shows the over-limit banner only with an open alert, using the stored note verbatim", async () => {
    show(async () => known({ roomLeftCad: -400, overLimitCad: 400, estimated: true, alert: { year: 2026, excessCad: 400, estimated: true, note: ALERT_NOTE } }));
    const banner = await screen.findByTestId("tfsa-over-limit-banner");
    expect(banner).toHaveTextContent(`Your TFSA contributions this year are about $400 ${ALERT_NOTE} over your room. CRA charges 1% a month on the excess.`);
  });

  it("carries no advice copy", async () => {
    show(async () => known({ roomLeftCad: -400, overLimitCad: 400, withdrawnCad: 5000, alert: { year: 2026, excessCad: 400, estimated: false, note: null } }));
    await screen.findByTestId("tfsa-over-limit-banner");
    expect(document.body.textContent).not.toMatch(/\byou should\b|\bwe recommend\b|\bconsider (withdrawing|contributing)\b/i);
  });

  it("says it is unavailable with a fixed line when the read fails, and never shows server text", async () => {
    show(async () => { throw new Error("SERVER-DETAIL"); });
    expect(await within(await tile()).findByText(/TFSA room is unavailable right now/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("SERVER-DETAIL");
    expect(screen.queryByTestId("tfsa-over-limit-banner")).not.toBeInTheDocument();
  });

  it("renders no tile when the client has no room method", async () => {
    show();
    await screen.findByLabelText("Portfolio totals");
    expect(screen.queryByRole("region", { name: /tfsa room/i })).not.toBeInTheDocument();
  });

  it("does not block the dashboard while the room loads", async () => {
    const pending = vi.fn(() => new Promise<TfsaRoomView>(() => undefined));
    show(pending);
    await screen.findByLabelText("Portfolio totals");
    await waitFor(() => expect(pending).toHaveBeenCalled());
  });
});
