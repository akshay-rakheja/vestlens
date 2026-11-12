// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PortfolioExperience } from "./App";
import type { FhsaRoomView, LedgerRowView, TfsaRoomView } from "./apiErrors";
import { FhsaSetup } from "./FhsaSetup";
import { RoomPage } from "./RoomPage";

// Synthetic amounts and labels only.
const noFx = { contributions: { estimated: false, rateDates: [], native: [] }, withdrawals: { estimated: false, rateDates: [], native: [] } };
const row = (over: Partial<LedgerRowView>): LedgerRowView => ({
  date: "2026-03-01", kind: "contribution", label: "Synthetic FHSA", amountCad: 1000, estimated: false, rateDate: null, native: null,
  roomLeftCad: 0, excessCad: 0, wentOver: false, ...over,
});
const MATCHED_KEY = "1".repeat(16);
const ASSUMED_KEY = "3".repeat(16);
const FHSA_FACT = "CRA charges 1% a month on the highest amount over in each month. Check your figures in CRA My Account.";

const tfsa: TfsaRoomView = {
  status: "known", year: 2026, roomLeftCad: 2000, contributedCad: 5000, craRoomCad: 7000, withdrawnCad: 0, estimated: false, overLimitCad: 0,
  basis: [], fx: noFx, alert: null, activityAsOf: null, accounts: [], outcomes: {},
  ledger: { rows: [row({ date: "2026-01-01", kind: "cra_room", label: "Room from CRA My Account (you entered)", amountCad: 7000, roomLeftCad: 7000 })], overSince: null, undatedExcess: false },
} as TfsaRoomView;

const fhsaOver: FhsaRoomView = {
  status: "known", year: 2026, roomLeftCad: 0, contributedCad: 9500, participationRoomCad: 8000, withdrawnCad: 500, estimated: false, overLimitCad: 1000,
  basis: ["FHSA participation room for 2026: $8,000 (you said)", "Withdrawals are counted as taxable withdrawals", "An amount over from last year isn't included; CRA My Account shows it."], fx: noFx, fxDates: [], alert: null, activityAsOf: "2026-10-24T08:00:00.000Z",
  headlineBasis: "Based on your connected FHSAs",
  accounts: [{ accountKey: "f".repeat(64), label: "Synthetic FHSA", maskedNumber: null, value: null }],
  ledger: {
    overSince: "2026-06-10", undatedExcess: false,
    rows: [
      row({ date: "2026-01-01", kind: "cra_room", label: "FHSA participation room from CRA (you entered)", amountCad: 8000, roomLeftCad: 8000 }),
      row({ date: "2026-02-03", amountCad: 5000, roomLeftCad: 3000 }),
      row({ date: "2026-02-10", kind: "withdrawal", amountCad: -500, roomLeftCad: 3000, excessCad: 0, qualifyingCad: 0, offsetsLater: true, activityKey: "2".repeat(16) }),
      // CRA's formula: 5,000 + 4,500 − 8,000 − 500 withdrawn = 1,000 over.
      row({ date: "2026-06-10", amountCad: 4500, roomLeftCad: 0, excessCad: 1000, wentOver: true, matchedWith: { label: "Synthetic RRSP", date: "2026-06-09" }, inferred: true, note: "transfer from your RRSP uses FHSA room", activityKey: MATCHED_KEY }),
    ],
  },
};
const fhsaMissing: FhsaRoomView = {
  status: "missing", year: 2026, missing: [{ kind: "fhsa_room" }], withdrawnCad: 0, basis: [], fx: noFx, fxDates: [], alert: null,
  accounts: [{ accountKey: "f".repeat(64), label: "Synthetic FHSA", maskedNumber: null, value: null }],
  ledger: { rows: [row({ date: "2026-01-01", kind: "cra_room", label: "FHSA participation room from CRA (you entered)", amountCad: null, roomLeftCad: null }), row({ roomLeftCad: null, excessCad: null })], overSince: null, undatedExcess: false },
};

const page = (fhsa: FhsaRoomView | Error, onFhsaSetup = vi.fn(), onSetup = vi.fn()) => {
  const api = { getTfsaRoom: async () => tfsa, getFhsaRoom: async () => { if (fhsa instanceof Error) throw fhsa; return fhsa; } };
  render(<RoomPage api={api as never} onBack={() => undefined} onSetup={onSetup} onFhsaSetup={onFhsaSetup} />);
  return { onFhsaSetup, onSetup };
};

afterEach(cleanup);

describe("RoomPage: TFSA | FHSA tabs", () => {
  it("a known FHSA number with a managed FHSA not counted: the line, the chart and an optional figure beside it", async () => {
    const after: FhsaRoomView = { ...fhsaOver, overLimitCad: 0, roomLeftCad: 3000, ledger: { ...fhsaOver.ledger, overSince: null } } as FhsaRoomView;
    const putFhsaManagedFigure = vi.fn(async () => after);
    const key = "e".repeat(64);
    const room = { ...after, roomLeftCad: 6000, notCounted: [{ accountKey: key, label: "Managed FHSA" }] } as FhsaRoomView;
    render(<RoomPage api={{ getTfsaRoom: async () => tfsa, getFhsaRoom: async () => room, putFhsaManagedFigure } as never} onBack={() => undefined} onSetup={() => undefined} initialTab="fhsa" />);
    expect(await screen.findByText("Not counted: Managed FHSA. Contributions to it aren't visible through SnapTrade. If you contributed to it this year, your room is lower than this.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Room left over the year" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add figure for Managed FHSA" }));
    fireEvent.change(screen.getByLabelText("Contributed to Managed FHSA this year (CAD)"), { target: { value: "3000" } });
    fireEvent.change(screen.getByLabelText("As of (YYYY-MM-DD)"), { target: { value: "2026-10-15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putFhsaManagedFigure).toHaveBeenCalledWith(key, { year: 2026, amountCad: 3000, asOf: "2026-10-15" }));
    await waitFor(() => expect(screen.queryByText(/Not counted/)).toBeNull());
  });

  it("no FHSA: no tabs, the TFSA room as before", async () => {
    page({ status: "none" });
    expect(await screen.findByText("About $2,000 of TFSA room left this year")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("an FHSA failing to load leaves the TFSA room with no tabs", async () => {
    page(new Error("boom <b>"));
    expect(await screen.findByText("About $2,000 of TFSA room left this year")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("with an FHSA: tabs, and the FHSA tab's headline, chart, ledger notes and CRA fact", async () => {
    page(fhsaOver);
    const tabs = await screen.findByRole("tablist", { name: "Registered account" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["TFSA", "FHSA"]);
    expect(within(tabs).getByRole("tab", { name: "TFSA" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(tabs).getByRole("tab", { name: "FHSA" }));
    expect(await screen.findByRole("heading", { name: "About $1,000 over your FHSA room since 10 June" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Contribution room");
    expect(screen.getByText("Based on your connected FHSAs")).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAccessibleName("Room left over the year: started at $8,000, ended over by $1,000 since 10 June.");
    const rows = screen.getAllByTestId("ledger-row");
    expect(rows[0]).toHaveTextContent("FHSA participation room From CRA (you entered)");
    expect(rows[2]).toHaveTextContent("Synthetic FHSA withdrawal Withdrawals don't give FHSA room back; this one counts against any amount over later this year");
    expect(rows[3]).toHaveTextContent("Synthetic FHSA contribution Matched to a transfer from Synthetic RRSP on 9 June; transfer from your RRSP uses FHSA room");
    expect(document.body.textContent).not.toMatch(/designat/i);
    // A plain withdrawal takes no answer; a matched transfer's edit link opens step 4 on that row.
    expect(within(rows[2]!).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(FHSA_FACT)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your FHSAs" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Based on" })).getByText("An amount over from last year isn't included; CRA My Account shows it.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b(should|consider|we recommend|you can contribute)\b/i);
  });

  it("edit links on matched, assumed and unclear FHSA rows open step 4 on that row; a withdrawal that reduced an excess says so", async () => {
    const view: FhsaRoomView = {
      ...fhsaOver,
      ledger: {
        ...(fhsaOver as Extract<FhsaRoomView, { status: "known" }>).ledger,
        rows: [
          ...(fhsaOver as Extract<FhsaRoomView, { status: "known" }>).ledger.rows,
          row({ date: "2026-07-01", kind: "withdrawal", amountCad: -600, roomLeftCad: 0, excessCad: 400, qualifyingCad: 600 }),
          row({ date: "2026-08-01", kind: "contribution", amountCad: 100, roomLeftCad: 0, excessCad: 500, assumed: true, activityKey: ASSUMED_KEY }),
          row({ date: "2026-08-02", kind: "withdrawal", amountCad: -50, roomLeftCad: 0, excessCad: 450, qualifyingCad: 50 }),
          row({ date: "2026-09-02", kind: "none", amountCad: -700, roomLeftCad: 0, excessCad: 450, matchedWith: { label: "Synthetic RRSP", date: "2026-09-02" }, inferred: true, note: "transfer to your RRSP; doesn't change your FHSA room or the amount over unless you designated it", activityKey: "4".repeat(16) }),
        ],
      },
    } as FhsaRoomView;
    const { onFhsaSetup } = page(view);
    fireEvent.click(await screen.findByRole("tab", { name: "FHSA" }));
    const rows = await screen.findAllByTestId("ledger-row");
    expect(rows[4]).toHaveTextContent("Synthetic FHSA withdrawal This reduced the amount over by $600");
    expect(rows[5]).toHaveTextContent("Synthetic FHSA contribution Assumed; you can change this");
    expect(rows[7]).toHaveTextContent("Synthetic FHSA transfer Transfer to your RRSP; doesn't change your FHSA room or the amount over unless you designated it; matched to a transfer to Synthetic RRSP on 2 September");
    // Room left never goes below $0; the amount over shows in the flag and the chart.
    expect(rows[3]!.textContent).toMatch(/\$0$/);
    expect(screen.getByRole("img")).toHaveAccessibleName("Room left over the year: started at $8,000, ended over by $450 since 10 June.");
    fireEvent.click(within(rows[3]!).getByRole("button", { name: "Edit" }));
    expect(onFhsaSetup).toHaveBeenLastCalledWith(4, MATCHED_KEY);
    fireEvent.click(within(rows[5]!).getByRole("button", { name: "Edit" }));
    expect(onFhsaSetup).toHaveBeenLastCalledWith(4, ASSUMED_KEY);
  });

  it("the FHSA missing state asks the one question, with a link to the one-step setup", async () => {
    const { onFhsaSetup, onSetup } = page(fhsaMissing);
    fireEvent.click(await screen.findByRole("tab", { name: "FHSA" }));
    expect(await screen.findByRole("heading", { name: "I can't give a number yet" })).toBeInTheDocument();
    const needed = screen.getByRole("list", { name: "Still needed" });
    expect(needed).toHaveTextContent("Your FHSA participation room for 2026, from CRA My Account or your notice of assessment");
    fireEvent.click(within(needed).getByRole("button", { name: "Set up" }));
    expect(onFhsaSetup).toHaveBeenLastCalledWith(1);
    fireEvent.click(within(screen.getAllByTestId("ledger-row")[0]!).getByRole("button", { name: "Edit" }));
    expect(onFhsaSetup).toHaveBeenCalledTimes(2);
    expect(onFhsaSetup).toHaveBeenLastCalledWith(1, undefined);
    expect(onSetup).not.toHaveBeenCalled();
  });

  it("opens on the FHSA tab when asked", async () => {
    const api = { getTfsaRoom: async () => tfsa, getFhsaRoom: async () => fhsaOver };
    render(<RoomPage api={api as never} onBack={() => undefined} onSetup={() => undefined} initialTab="fhsa" />);
    expect(await screen.findByRole("heading", { name: "About $1,000 over your FHSA room since 10 June" })).toBeInTheDocument();
  });
});

describe("FhsaSetup: one step", () => {
  const known: FhsaRoomView = { ...fhsaOver, roomLeftCad: 3000, overLimitCad: 0 } as FhsaRoomView;

  it("asks for the participation room as CRA shows it and saves it", async () => {
    const putFhsaRoom = vi.fn(async () => known);
    const onDone = vi.fn();
    render(<FhsaSetup api={{ getFhsaRoom: async () => fhsaMissing, putFhsaRoom } as never} onDone={onDone} />);
    expect(await screen.findByRole("heading", { name: "FHSA room for 2026" })).toBeInTheDocument();
    expect(screen.getByText("Your FHSA participation room for 2026, from CRA My Account or your notice of assessment. Enter that figure as CRA shows it, not one you've worked out.")).toBeInTheDocument();
    const input = screen.getByLabelText("FHSA participation room for 2026");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "8000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(putFhsaRoom).toHaveBeenCalledWith({ year: 2026, amountCad: 8000 });
    expect(document.body.textContent).not.toMatch(/\b(should|consider|we recommend)\b/i);
  });

  it("refuses a negative or empty figure, and Later writes nothing", async () => {
    const putFhsaRoom = vi.fn(async () => known);
    const onDone = vi.fn();
    render(<FhsaSetup api={{ getFhsaRoom: async () => fhsaMissing, putFhsaRoom } as never} onDone={onDone} />);
    fireEvent.change(await screen.findByLabelText("FHSA participation room for 2026"), { target: { value: "-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the figure as a dollar amount, 0 or more.");
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(onDone).toHaveBeenCalled();
    expect(putFhsaRoom).not.toHaveBeenCalled();
  });

  it("pre-fills a saved figure", async () => {
    render(<FhsaSetup api={{ getFhsaRoom: async () => fhsaOver } as never} onDone={() => undefined} />);
    expect(await screen.findByLabelText("FHSA participation room for 2026")).toHaveValue(8000);
  });
});

describe("FhsaSetup: step 4 on one FHSA transfer", () => {
  it("a matched transfer: the match line, FHSA answers, and Use the automatic match", async () => {
    const putFhsaRoomActivity = vi.fn(async () => fhsaOver);
    const deleteFhsaRoomActivity = vi.fn(async () => fhsaOver);
    const onDone = vi.fn();
    render(<FhsaSetup api={{ getFhsaRoom: async () => fhsaOver, putFhsaRoomActivity, deleteFhsaRoomActivity } as never} step={4} activityKey={MATCHED_KEY} onDone={onDone} />);
    const step = await screen.findByRole("region", { name: "Transfer on 10 June 2026" });
    expect(step).toHaveTextContent("Matched to a transfer from Synthetic RRSP on 9 June.");
    expect(step).toHaveTextContent("New money and transfers from your RRSP use FHSA room; money moved directly from another FHSA doesn't.");
    expect(within(step).getByRole("button", { name: "New money (a contribution)" })).toHaveFocus();
    fireEvent.click(within(step).getByRole("button", { name: "Moved from another FHSA" }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(putFhsaRoomActivity).toHaveBeenCalledWith(MATCHED_KEY, { effect: "none" });
    fireEvent.click(within(step).getByRole("button", { name: "Use the automatic match" }));
    await vi.waitFor(() => expect(deleteFhsaRoomActivity).toHaveBeenCalledWith(MATCHED_KEY));
    expect(document.body.textContent).not.toMatch(/\bTFSA\b|\b(should|consider|we recommend)\b/);
  });

  it("an outgoing assumed transfer is worded for money leaving the FHSAs, with no undo", async () => {
    const out = { ...fhsaOver, ledger: { ...(fhsaOver as Extract<FhsaRoomView, { status: "known" }>).ledger, rows: [row({ date: "2026-09-01", kind: "none", amountCad: -300, assumed: true, activityKey: ASSUMED_KEY })] } } as FhsaRoomView;
    render(<FhsaSetup api={{ getFhsaRoom: async () => out } as never} step={4} activityKey={ASSUMED_KEY} onDone={() => undefined} />);
    const step = await screen.findByRole("region", { name: "Transfer on 1 September 2026" });
    expect(step).toHaveTextContent("Assumed to have no effect (moved to another FHSA or your RRSP); you can change this.");
    expect(step).toHaveTextContent("Did this money leave your FHSAs?");
    expect(within(step).getAllByRole("button").map((b) => b.textContent).slice(0, 3)).toEqual(["Taken out (a withdrawal)", "Moved to another FHSA", "Moved to my RRSP"]);
    expect(within(step).queryByRole("button", { name: /automatic match|Clear my answer/ })).not.toBeInTheDocument();
  });
});

describe("FhsaSetup: the third outgoing answer", () => {
  it("Moved to my RRSP stores none (no effect on FHSA room or the amount over)", async () => {
    const out = { ...fhsaOver, ledger: { ...(fhsaOver as Extract<FhsaRoomView, { status: "known" }>).ledger, rows: [row({ date: "2026-09-01", kind: "none", amountCad: -300, assumed: true, activityKey: ASSUMED_KEY })] } } as FhsaRoomView;
    const putFhsaRoomActivity = vi.fn(async () => out);
    const onDone = vi.fn();
    render(<FhsaSetup api={{ getFhsaRoom: async () => out, putFhsaRoomActivity } as never} step={4} activityKey={ASSUMED_KEY} onDone={onDone} />);
    const step = await screen.findByRole("region", { name: "Transfer on 1 September 2026" });
    expect(step).toHaveTextContent("Taking money out never gives FHSA room back, though it counts against an amount over this year; moving it directly to another FHSA or to your RRSP has no effect.");
    fireEvent.click(within(step).getByRole("button", { name: "Moved to my RRSP" }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(putFhsaRoomActivity).toHaveBeenCalledWith(ASSUMED_KEY, { effect: "none" });
  });
});

describe("App: the FHSA setup returns to the FHSA tab", () => {
  const auth = { isLoading: false, isAuthenticated: true, userName: "Synthetic", login: async () => undefined, logout: () => undefined };
  it("Set up opens the one step, Save returns to the room page on the FHSA tab", async () => {
    let current: FhsaRoomView = fhsaMissing;
    const api = {
      getPortfolio: async () => ({ connectionRequired: false, generatedAt: "2026-10-24T20:00:00.000Z", totals: [], accounts: [], errors: [] }),
      getConnections: async () => [], createConnectionSession: async () => ({ portalUrl: "https://x.invalid" }),
      getTfsaRoom: async () => tfsa, getFhsaRoom: async () => current,
      putFhsaRoom: vi.fn(async () => { current = fhsaOver; return current; }),
    };
    window.history.pushState({}, "", "/?view=room");
    render(<PortfolioExperience auth={auth} api={api as never} />);
    fireEvent.click(await screen.findByRole("tab", { name: "FHSA" }));
    fireEvent.click(within(await screen.findByRole("list", { name: "Still needed" })).getByRole("button", { name: "Set up" }));
    fireEvent.change(await screen.findByLabelText("FHSA participation room for 2026"), { target: { value: "8000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { name: "About $1,000 over your FHSA room since 10 June" })).toBeInTheDocument();
    expect(api.putFhsaRoom).toHaveBeenCalledWith({ year: 2026, amountCad: 8000 });
    window.history.pushState({}, "", "/");
  });
});

describe("App: an FHSA edit link opens step 4", () => {
  const auth = { isLoading: false, isAuthenticated: true, userName: "Synthetic", login: async () => undefined, logout: () => undefined };
  it("the matched row's edit link opens the transfer step, and answering returns to the FHSA tab", async () => {
    const api = {
      getPortfolio: async () => ({ connectionRequired: false, generatedAt: "2026-10-24T20:00:00.000Z", totals: [], accounts: [], errors: [] }),
      getConnections: async () => [], createConnectionSession: async () => ({ portalUrl: "https://x.invalid" }),
      getTfsaRoom: async () => tfsa, getFhsaRoom: async () => fhsaOver, putFhsaRoomActivity: vi.fn(async () => fhsaOver),
    };
    window.history.pushState({}, "", "/?view=room");
    render(<PortfolioExperience auth={auth} api={api as never} />);
    fireEvent.click(await screen.findByRole("tab", { name: "FHSA" }));
    const rows = await screen.findAllByTestId("ledger-row");
    fireEvent.click(within(rows[3]!).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(await screen.findByRole("region", { name: "Transfer on 10 June 2026" })).getByRole("button", { name: "Moved from another FHSA" }));
    expect(await screen.findByRole("heading", { name: "About $1,000 over your FHSA room since 10 June" })).toBeInTheDocument();
    expect(api.putFhsaRoomActivity).toHaveBeenCalledWith(MATCHED_KEY, { effect: "none" });
    window.history.pushState({}, "", "/");
  });
});
