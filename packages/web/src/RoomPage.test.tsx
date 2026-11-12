// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PortfolioExperience } from "./App";
import type { FhsaRoomView, LedgerRowView, RrspRoomView, RrspYearView, TfsaRoomView } from "./apiErrors";
import { RoomPage } from "./RoomPage";
import { ledgerAmount } from "./roomFormat";

// Synthetic amounts and labels only.
const noFx = { contributions: { estimated: false, rateDates: [], native: [] }, withdrawals: { estimated: false, rateDates: [], native: [] } };
const CRA = "Room from CRA My Account (you entered)";
const row = (over: Partial<LedgerRowView>): LedgerRowView => ({
  date: "2026-03-01", kind: "contribution", label: "Synthetic TFSA", amountCad: 1000, estimated: false, rateDate: null, native: null,
  roomLeftCad: 0, excessCad: 0, wentOver: false, ...over,
});
const craRow = (room: number | null) => row({ date: "2026-01-01", kind: "cra_room", label: CRA, amountCad: room, roomLeftCad: room });

const view = (over: Record<string, unknown>): TfsaRoomView => ({
  status: "known", year: 2026, roomLeftCad: 0, contributedCad: 0, craRoomCad: 0, withdrawnCad: 0, estimated: false, overLimitCad: 0,
  basis: [], fx: noFx, alert: null, activityAsOf: "2026-10-24T20:00:00.000Z", accounts: [], outcomes: {},
  ledger: { rows: [], overSince: null, undatedExcess: false }, ...over,
} as TfsaRoomView);

// The −500 withdrawal is made while over by 4,000, so all of it reduces the excess (ITA 207.01(1)): 3,500 over at the end.
const owner = (): TfsaRoomView => view({
  roomLeftCad: -3500, overLimitCad: 3500, craRoomCad: 7000, contributedCad: 11000, withdrawnCad: 500, returningCad: 0,
  ledger: {
    overSince: "2026-03-14", undatedExcess: false,
    rows: [
      craRow(7000),
      row({ date: "2026-02-01", amountCad: 5000, roomLeftCad: 2000 }),
      row({ date: "2026-03-14", amountCad: 6000, roomLeftCad: -4000, excessCad: 4000, wentOver: true }),
      row({ date: "2026-05-02", kind: "withdrawal", amountCad: -500, roomLeftCad: -3500, excessCad: 3500, qualifyingCad: 500, returnsCad: 0 }),
    ],
  },
  accounts: [{ accountKey: "a".repeat(64), label: "Synthetic TFSA", neutral: false, inSet: true }],
});

const page = (room: TfsaRoomView, onSetup = vi.fn(), onBack = vi.fn()) => {
  render(<RoomPage api={{ getTfsaRoom: async () => room } as never} onBack={onBack} onSetup={onSetup} />);
  return { onSetup, onBack };
};

afterEach(cleanup);

describe("RoomPage", () => {
  it("the owner fixture agrees with itself: the headline figures are the final ledger row's", () => {
    const room = owner();
    if (room.status !== "known") throw new Error("expected known");
    const last = room.ledger.rows[room.ledger.rows.length - 1]!;
    expect(room.overLimitCad).toBe(last.excessCad);
    expect(room.roomLeftCad).toBe(last.roomLeftCad);
  });

  it("headline for the over case names the date it went over", async () => {
    page(owner());
    expect(await screen.findByText("About $3,500 over your TFSA room since 14 March")).toBeInTheDocument();
  });

  it("headline for room left, with the freshness line", async () => {
    page(view({ roomLeftCad: 1500, craRoomCad: 7000, contributedCad: 5500, ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000), row({ amountCad: 5500, roomLeftCad: 1500 })] } }));
    expect(await screen.findByText("About $1,500 of TFSA room left this year")).toBeInTheDocument();
    expect(screen.getByText("Based on activity up to 24 October 2026; deposits made since then aren't included")).toBeInTheDocument();
  });

  it("undated excess gives the amount, the account and no date", async () => {
    page(view({
      roomLeftCad: -300, overLimitCad: 300,
      ledger: { overSince: null, undatedExcess: true, rows: [craRow(1000), row({ kind: "outside_total", label: "Synthetic Bank TFSA", amountCad: 1300, roomLeftCad: -300, excessCad: 300 })] },
    }));
    expect(await screen.findByText("About $300 over your TFSA room; the date can't be told because Synthetic Bank TFSA has a total, not dated deposits")).toBeInTheDocument();
  });

  it("missing state lists the items, each with a setup link, and '?' from the first gap", async () => {
    const { onSetup } = page(view({
      status: "missing", missing: [{ kind: "cra_room" }], roomLeftCad: undefined,
      ledger: { overSince: null, undatedExcess: false, rows: [craRow(null), row({ roomLeftCad: null, excessCad: null })] },
    }));
    expect(await screen.findByText("I can't give a number yet")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Still needed" });
    expect(list).toHaveTextContent("Your TFSA contribution room on 1 January 2026, from CRA My Account");
    fireEvent.click(within(list).getByRole("button", { name: "Set up" }));
    expect(onSetup).toHaveBeenCalledWith(1);
    const cells = screen.getAllByTestId("ledger-row").map((r) => r.lastElementChild!.textContent);
    expect(cells).toEqual(["?", "?"]);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("ledger: withdrawal wording, went-over highlight and edit links", async () => {
    const { onSetup } = page(owner());
    await screen.findByRole("table");
    expect(screen.getByText("This reduced the amount over by $500")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("comes back");
    const over = screen.getByText("This went over by $4,000");
    expect(over.closest("tr")).toHaveClass("tfsa-ledger-over");
    const first = screen.getAllByTestId("ledger-row")[0]!;
    fireEvent.click(within(first).getByRole("button", { name: "Edit" }));
    expect(onSetup).toHaveBeenLastCalledWith(1);
    const accounts = screen.getByRole("region", { name: "Your TFSAs" });
    fireEvent.click(within(accounts).getByRole("button", { name: "Add or remove accounts" }));
    expect(onSetup).toHaveBeenLastCalledWith(2);
    fireEvent.click(within(accounts).getByRole("button", { name: "TFSAs at other institutions" }));
    expect(onSetup).toHaveBeenLastCalledWith(3);
  });

  it("a carried outside TFSA: the headline basis under the headline, and last year's outside TFSAs listed", async () => {
    page(view({ roomLeftCad: 2000, craRoomCad: 7000, headlineBasis: "Based on your connected TFSAs and what you entered", accountSet: null, previousAccountSet: { connected: [], notTfsa: [], outside: [{ label: "Synthetic Bank" }] } }));
    const head = await screen.findByRole("heading", { name: "About $2,000 of TFSA room left this year" });
    expect(head.nextElementSibling).toHaveTextContent("Based on your connected TFSAs and what you entered");
    expect(screen.getByRole("list", { name: "TFSAs at other institutions" })).toHaveTextContent("Synthetic Bank: at another institution");
    cleanup();
    page(view({ roomLeftCad: 2000, craRoomCad: 7000 }));
    await screen.findByRole("heading", { name: "About $2,000 of TFSA room left this year" });
    expect(screen.queryByText("Based on your connected TFSAs and what you entered")).toBeNull();
  });

  it("Your TFSAs: what counts, an unknown-type account, and outside TFSAs; the links show even with no connected account", async () => {
    page(view({
      accounts: [
        { accountKey: "a".repeat(64), label: "Synthetic TFSA", neutral: false, inSet: true },
        { accountKey: "b".repeat(64), label: "Synthetic Unlabelled", neutral: true, inSet: false },
        { accountKey: "c".repeat(64), label: "Synthetic Excluded", neutral: false, inSet: false },
      ],
      accountSet: { connected: [], notTfsa: ["c".repeat(64)], outside: [{ label: "Synthetic Bank" }] },
    }));
    const accounts = await screen.findByRole("region", { name: "Your TFSAs" });
    expect(accounts).toHaveTextContent("Synthetic TFSA: counted as a TFSA");
    expect(accounts).toHaveTextContent("Synthetic Unlabelled: unknown type, not counted");
    expect(accounts).toHaveTextContent("Synthetic Excluded: not counted");
    expect(within(accounts).getByRole("list", { name: "TFSAs at other institutions" })).toHaveTextContent("Synthetic Bank: at another institution");
    cleanup();
    page(view({ accounts: [] }));
    const empty = await screen.findByRole("region", { name: "Your TFSAs" });
    expect(within(empty).getByRole("button", { name: "Add or remove accounts" })).toBeInTheDocument();
    expect(within(empty).getByRole("button", { name: "TFSAs at other institutions" })).toBeInTheDocument();
  });

  it("withdrawal rows: returning only, both parts, and no comes-back clause without a date", async () => {
    page(view({
      roomLeftCad: 0, withdrawnCad: 3600, returningCad: 2100,
      ledger: { overSince: null, undatedExcess: false, rows: [
        craRow(5000),
        row({ date: "2026-01-05", amountCad: 6000, roomLeftCad: -1000, excessCad: 1000 }),
        row({ date: "2026-02-01", kind: "withdrawal", label: "Mixed TFSA", amountCad: -3000, roomLeftCad: 0, qualifyingCad: 1000, returnsCad: 2000, returnsOn: "2027-01-01" }),
        row({ date: "2026-03-01", kind: "withdrawal", label: "Back TFSA", amountCad: -100, roomLeftCad: 0, qualifyingCad: 0, returnsCad: 100, returnsOn: "2027-01-01" }),
        row({ date: "2026-04-01", kind: "withdrawal", label: "Dateless TFSA", amountCad: -500, roomLeftCad: 0, qualifyingCad: 0, returnsCad: 500 }),
      ] },
    }));
    await screen.findByRole("table");
    expect(screen.getByText("This reduced the amount over by $1,000; the other $2,000 comes back on 1 January 2027, not now")).toBeInTheDocument();
    expect(screen.getByText("This room comes back on 1 January 2027, not now")).toBeInTheDocument();
    expect(screen.getByText("Dateless TFSA withdrawal")).toBeInTheDocument();
  });

  it("chart: CRA room entered with stale activity stops at the 1 January point", async () => {
    page(view({
      status: "missing", missing: [{ kind: "stale_activity", label: "Synthetic TFSA", accountKey: "1".repeat(16), lastSyncedAt: null }],
      ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000), row({ date: "2026-03-01", roomLeftCad: null, excessCad: null })] },
    }));
    const chart = await screen.findByRole("img");
    expect(chart).toHaveAccessibleName("Room left over the year: started at $7,000, not known after 1 January.");
    const line = screen.getByTestId("room-chart-line").getAttribute("d")!;
    expect(line).not.toContain("H");
    expect(chart.querySelectorAll("circle")).toHaveLength(1);
  });

  it("chart: an unclear transfer stops the line at the row before it", async () => {
    page(view({
      status: "missing", missing: [{ kind: "ambiguous", count: 1, rows: [] }],
      ledger: { overSince: null, undatedExcess: false, rows: [
        craRow(7000), row({ date: "2026-03-01", roomLeftCad: 6000 }),
        row({ date: "2026-04-01", kind: "ambiguous", activityKey: "k1", roomLeftCad: null, excessCad: null }),
        row({ date: "2026-05-01", roomLeftCad: null, excessCad: null }),
      ] },
    }));
    const chart = await screen.findByRole("img");
    expect(chart).toHaveAccessibleName("Room left over the year: started at $7,000, not known after 1 March.");
    expect(chart.querySelectorAll("circle")).toHaveLength(2);
    // Two points: one step to 1 March and its drop, nothing after it.
    expect(screen.getByTestId("room-chart-line").getAttribute("d")!.match(/H/g)).toHaveLength(1);
    expect(screen.getByTestId("room-chart-line").getAttribute("d")!.trim().endsWith("H")).toBe(false);
  });

  it("an answered 'moved from another TFSA' row links to step 4 so it can be answered again", async () => {
    const { onSetup } = page(view({
      roomLeftCad: 7000,
      ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000), row({ kind: "none", activityKey: "k9", amountCad: 2500, roomLeftCad: 7000, answered: true })] },
    }));
    const rows = await screen.findAllByTestId("ledger-row");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Edit" }));
    expect(onSetup).toHaveBeenLastCalledWith(4, "k9");
  });

  it("a matched transfer says what it was matched to and links to step 4 on it, so the match can be overridden", async () => {
    const cash = "Synthetic Cash";
    const { onSetup } = page(view({
      roomLeftCad: 6000,
      ledger: { overSince: null, undatedExcess: false, rows: [
        craRow(7000),
        row({ date: "2026-03-01", activityKey: "k1", amountCad: 1000, roomLeftCad: 6000, inferred: true, matchedWith: { label: cash, date: "2026-02-28" } }),
        row({ date: "2026-04-01", kind: "none", activityKey: "k2", amountCad: 300, roomLeftCad: 6000, inferred: true, matchedWith: { label: "Synthetic second TFSA", date: "2026-04-01" } }),
        row({ date: "2026-05-02", kind: "withdrawal", activityKey: "k3", amountCad: -500, roomLeftCad: 6000, qualifyingCad: 0, returnsCad: 500, returnsOn: "2027-01-01", inferred: true, matchedWith: { label: cash, date: "2026-05-02" } }),
      ] },
    }));
    const rows = await screen.findAllByTestId("ledger-row");
    expect(rows[1]).toHaveTextContent("Synthetic TFSA contribution Matched to a transfer from Synthetic Cash on 28 February");
    expect(rows[2]).toHaveTextContent("Synthetic TFSA transfer Moved from another TFSA, no effect on room; matched to a transfer from Synthetic second TFSA on 1 April");
    expect(rows[3]).toHaveTextContent("Synthetic TFSA withdrawal This room comes back on 1 January 2027, not now; matched to a transfer to Synthetic Cash on 2 May");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Edit" }));
    expect(onSetup).toHaveBeenLastCalledWith(4, "k1");
    fireEvent.click(within(rows[3]!).getByRole("button", { name: "Edit" }));
    expect(onSetup).toHaveBeenLastCalledWith(4, "k3");
    // A contribution that wasn't matched (a CONTRIBUTION row) keeps no edit link.
    expect(within(rows[1]!).queryByText(/Answer/)).toBeNull();
  });

  it("a row the route would refuse gets no step-4 link: a none or contribution row with neither answered nor inferred", async () => {
    page(view({
      roomLeftCad: 6000,
      ledger: { overSince: null, undatedExcess: false, rows: [
        craRow(7000),
        row({ date: "2026-03-01", kind: "none", activityKey: "n1", amountCad: 500, roomLeftCad: 7000 }),
        row({ date: "2026-03-02", kind: "contribution", activityKey: "c1", amountCad: 1000, roomLeftCad: 6000 }),
      ] },
    }));
    const rows = await screen.findAllByTestId("ledger-row");
    expect(within(rows[1]!).queryByRole("button")).toBeNull();
    expect(within(rows[2]!).queryByRole("button")).toBeNull();
  });

  it("answered rows of any kind keep a step-4 edit link; an unanswered table row with an activityKey has none", async () => {
    const { onSetup } = page(view({
      roomLeftCad: 6000,
      ledger: { overSince: null, undatedExcess: false, rows: [
        craRow(7000),
        row({ date: "2026-03-01", activityKey: "a1", amountCad: 1000, roomLeftCad: 6000, answered: true }),
        row({ date: "2026-04-01", kind: "withdrawal", activityKey: "a2", amountCad: -200, roomLeftCad: 6000, qualifyingCad: 0, returnsCad: 200, returnsOn: "2027-01-01", answered: true }),
        row({ date: "2026-05-01", activityKey: "a3", amountCad: 10, roomLeftCad: 5990 }),
      ] },
    }));
    const rows = await screen.findAllByTestId("ledger-row");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Edit" }));
    expect(onSetup).toHaveBeenLastCalledWith(4, "a1");
    fireEvent.click(within(rows[2]!).getByRole("button", { name: "Edit" }));
    expect(onSetup).toHaveBeenLastCalledWith(4, "a2");
    expect(within(rows[3]!).queryByRole("button")).toBeNull();
  });

  it("the outgoing side of a move between TFSAs reads 'moved to another TFSA'", async () => {
    page(view({
      roomLeftCad: 7000,
      ledger: { overSince: null, undatedExcess: false, rows: [
        craRow(7000),
        row({ date: "2026-04-01", kind: "none", activityKey: "k5", amountCad: -300, roomLeftCad: 7000, inferred: true, matchedWith: { label: "Synthetic second TFSA", date: "2026-04-01" } }),
      ] },
    }));
    const rows = await screen.findAllByTestId("ledger-row");
    expect(rows[1]).toHaveTextContent("Synthetic TFSA transfer Moved to another TFSA, no effect on room; matched to a transfer to Synthetic second TFSA on 1 April");
  });

  it("dated_entries: outside links to step 3; connected says to give it in chat, with no link", async () => {
    const { onSetup } = page(view({
      status: "missing", missing: [
        { kind: "dated_entries", label: "Other Bank", accountKey: "outside:other-bank" },
        { kind: "dated_entries", label: "Old TFSA", accountKey: "2".repeat(16) },
      ],
      ledger: { overSince: null, undatedExcess: false, rows: [craRow(5000)] },
    }));
    const list = await screen.findByRole("list", { name: "Still needed" });
    const [outside, connected] = within(list).getAllByRole("listitem");
    expect(outside).toHaveTextContent("Other Bank's contributions this year as dated deposits, so withdrawals can be placed correctly");
    fireEvent.click(within(outside!).getByRole("button", { name: "Set up" }));
    expect(onSetup).toHaveBeenLastCalledWith(3);
    expect(connected).toHaveTextContent("You can give this figure in Claude or ChatGPT through VestLens; the dashboard doesn't take it yet.");
    expect(within(connected!).queryByRole("button")).toBeNull();
  });

  it("coverage and disconnected items have no Set up link, only the chat line; a managed item takes its figure here (review 6)", async () => {
    const managedKey = "5".repeat(16);
    const putRoomManagedFigure = vi.fn(async () => view({ roomLeftCad: 4000, craRoomCad: 7000, contributedCad: 3000, ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000)] } }));
    const room = view({
      status: "missing", missing: [
        { kind: "coverage", label: "Gap TFSA", accountKey: "3".repeat(16) },
        { kind: "disconnected_account", accountKey: "4".repeat(16) },
        { kind: "managed_account", label: "Managed TFSA", accountKey: managedKey },
        { kind: "cra_room" },
      ],
      ledger: { overSince: null, undatedExcess: false, rows: [craRow(null)] },
    });
    render(<RoomPage api={{ getTfsaRoom: async () => room, putRoomManagedFigure } as never} onBack={vi.fn()} onSetup={vi.fn()} />);
    const list = await screen.findByRole("list", { name: "Still needed" });
    const items = within(list).getAllByRole("listitem");
    const cra = items.find((i) => i.textContent!.includes("CRA My Account"))!;
    const managed = items.find((i) => i.textContent!.includes("Managed TFSA"))!;
    const others = items.filter((i) => i !== cra && i !== managed);
    expect(others).toHaveLength(2);
    for (const item of others) {
      expect(within(item).queryByRole("button")).toBeNull();
      expect(item).toHaveTextContent("You can give this figure in Claude or ChatGPT through VestLens; the dashboard doesn't take it yet.");
    }
    expect(within(cra).getByRole("button", { name: "Set up" })).toBeInTheDocument();
    // The managed line names the account and why (A9), says not to double count, and takes the figure through the room routes.
    expect(managed).toHaveTextContent("What you have contributed to Managed TFSA this year, and as of what date (contributions to it aren't visible through SnapTrade). Don't include amounts already entered elsewhere.");
    expect(managed).not.toHaveTextContent("the dashboard doesn't take it yet");
    fireEvent.click(within(managed).getByRole("button", { name: "Add figure" }));
    const form = within(managed).getByRole("form", { name: "Contributions to Managed TFSA this year" });
    fireEvent.change(within(form).getByLabelText("Contributed to Managed TFSA this year (CAD)"), { target: { value: "3,000" } });
    fireEvent.change(within(form).getByLabelText("As of (YYYY-MM-DD)"), { target: { value: "2026-10-15" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putRoomManagedFigure).toHaveBeenCalledWith(managedKey, { year: 2026, amountCad: 3000, asOf: "2026-10-15" }));
    expect(await screen.findByText("About $4,000 of TFSA room left this year")).toBeInTheDocument();
  });

  it("a known number with a managed TFSA not counted: the headline, the line beneath it, the chart, and a figure form beside it; saving counts it (owner ruling 2026-10-31)", async () => {
    const [a, b] = ["5".repeat(16), "6".repeat(16)];
    const notCounted = [{ accountKey: a, label: "Wealthsimple TFSA ••Cs5Q" }, { accountKey: b, label: "Wealthsimple TFSA ••KgtA" }];
    const rows = { overSince: null, undatedExcess: false, rows: [craRow(7000)] };
    const putRoomManagedFigure = vi.fn(async () => view({ roomLeftCad: 4000, craRoomCad: 7000, contributedCad: 3000, ledger: rows, notCounted: [notCounted[1]] }));
    render(<RoomPage api={{ getTfsaRoom: async () => view({ roomLeftCad: 7000, craRoomCad: 7000, contributedCad: 0, ledger: rows, notCounted }), putRoomManagedFigure } as never} onBack={vi.fn()} onSetup={vi.fn()} />);
    expect(await screen.findByText("About $7,000 of TFSA room left this year")).toBeInTheDocument();
    expect(screen.getByText("Not counted: Wealthsimple TFSA ••Cs5Q and ••KgtA. Contributions to them aren't visible through SnapTrade. If you contributed to them this year, your room is lower than this.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Still needed" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Room left over the year" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add figure for Wealthsimple TFSA ••Cs5Q" }));
    fireEvent.change(screen.getByLabelText("Contributed to Wealthsimple TFSA ••Cs5Q this year (CAD)"), { target: { value: "3000" } });
    fireEvent.change(screen.getByLabelText("As of (YYYY-MM-DD)"), { target: { value: "2026-10-15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putRoomManagedFigure).toHaveBeenCalledWith(a, { year: 2026, amountCad: 3000, asOf: "2026-10-15" }));
    expect(await screen.findByText("About $4,000 of TFSA room left this year")).toBeInTheDocument();
    expect(screen.getByText(/Not counted: Wealthsimple TFSA ••KgtA\. Contributions to it/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add figure for Wealthsimple TFSA ••Cs5Q" })).toBeNull();
  });

  it("over the limit, the line says the amount over is higher; with no notCounted (the old shape) there is no line", async () => {
    const rows = { overSince: null, undatedExcess: false, rows: [craRow(1000)] };
    page(view({ roomLeftCad: -500, craRoomCad: 1000, contributedCad: 1500, overLimitCad: 500, ledger: rows, notCounted: [{ accountKey: "5".repeat(16), label: "Managed TFSA" }] }));
    expect(await screen.findByText(/If you contributed to it this year, the amount over is higher than this\./)).toBeInTheDocument();
    cleanup();
    page(view({ roomLeftCad: 7000, craRoomCad: 7000, contributedCad: 0, ledger: rows }));
    await screen.findByText("About $7,000 of TFSA room left this year");
    expect(screen.queryByText(/Not counted/)).toBeNull();
  });

  it("a managed item's form refuses a blank amount or a date after today, and sends nothing", async () => {
    const putRoomManagedFigure = vi.fn();
    const room = view({ status: "missing", missing: [{ kind: "managed_account", label: "Managed TFSA", accountKey: "5".repeat(16) }], ledger: { overSince: null, undatedExcess: false, rows: [craRow(null)] } });
    render(<RoomPage api={{ getTfsaRoom: async () => room, putRoomManagedFigure } as never} onBack={vi.fn()} onSetup={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add figure" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the amount in dollars, 0 or more, and the date as YYYY-MM-DD, not after today.");
    fireEvent.change(screen.getByLabelText("Contributed to Managed TFSA this year (CAD)"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("As of (YYYY-MM-DD)"), { target: { value: "2999-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(putRoomManagedFigure).not.toHaveBeenCalled();
  });

  it("without the client method a managed item says where to enter the figure", async () => {
    page(view({ status: "missing", missing: [{ kind: "managed_account", label: "Managed TFSA", accountKey: "5".repeat(16) }], ledger: { overSince: null, undatedExcess: false, rows: [craRow(null)] } }));
    const list = await screen.findByRole("list", { name: "Still needed" });
    expect(list).toHaveTextContent("You can enter this on the contribution room page, or in Claude or ChatGPT through VestLens.");
    expect(within(list).queryByRole("button")).toBeNull();
  });

  it("an assumed transfer says so and links to step 4 on that row", async () => {
    const { onSetup } = page(view({
      roomLeftCad: 4500, craRoomCad: 7000,
      ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000), row({ label: "Synthetic TFSA", activityKey: "k7", amountCad: 2500, roomLeftCad: 4500, excessCad: 0, assumed: true })] },
    }));
    const rows = await screen.findAllByTestId("ledger-row");
    expect(rows[1]).toHaveTextContent("Synthetic TFSA contribution Assumed; you can change this");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Edit" }));
    expect(onSetup).toHaveBeenLastCalledWith(4, "k7");
  });

  it("an unclear row is highlighted and links to step 4 on that row (no queue); outside rows link to step 3", async () => {
    const { onSetup } = page(view({
      status: "missing", missing: [{ kind: "ambiguous", count: 1, rows: [] }],
      ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000), row({ kind: "ambiguous", label: "Synthetic TFSA", activityKey: "k1", roomLeftCad: null, excessCad: null }), row({ label: "Other Bank", roomLeftCad: null, excessCad: null })] },
    }));
    const rows = await screen.findAllByTestId("ledger-row");
    expect(rows[1]).toHaveClass("tfsa-ledger-open");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Answer" }));
    expect(onSetup).toHaveBeenLastCalledWith(4, "k1");
    fireEvent.click(within(rows[2]!).getByRole("button", { name: "Edit" }));
    expect(onSetup).toHaveBeenLastCalledWith(3);
  });

  it("a USD row shows est., the Bank of Canada date and the US$ amount", async () => {
    page(view({
      roomLeftCad: 1600,
      ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000), row({ amountCad: 5400, estimated: true, rateDate: "2026-06-01", native: { amount: 4000, currency: "USD" }, roomLeftCad: 1600 })] },
    }));
    await screen.findByRole("table");
    expect(screen.getByText(/\+\$5,400 \(est\., BoC 2026-06-01; US\$4,000\)/)).toBeInTheDocument();
    expect(ledgerAmount(row({ kind: "withdrawal", amountCad: -50, native: { amount: 40, currency: "USD" }, estimated: true, rateDate: "2026-06-01" }))).toBe("-$50 (est., BoC 2026-06-01; -US$40)");
  });

  it("the chart's text alternative has start, end and the over-since date; the CRA fact is verbatim", async () => {
    page(owner());
    const chart = await screen.findByRole("img");
    expect(chart).toHaveAccessibleName("Room left over the year: started at $7,000, ended over by $3,500 since 14 March.");
    expect(screen.getByTestId("room-chart-over")).toBeInTheDocument();
    expect(screen.getByText("CRA charges 1% a month on the highest amount over in each month, until it's withdrawn or new room arrives. Check your figures in CRA My Account.")).toBeInTheDocument();
  });

  it("uses no advice language", async () => {
    page(owner());
    await screen.findByRole("table");
    expect(document.body.textContent).not.toMatch(/\b(should|consider|we recommend)\b/i);
  });

  it("shows a fixed line when the room can't be loaded", async () => {
    render(<RoomPage api={{ getTfsaRoom: async () => { throw new Error("boom <b>"); } } as never} onBack={() => undefined} onSetup={() => undefined} />);
    expect(await screen.findByText("TFSA room is unavailable right now.")).toBeInTheDocument();
  });
});

describe("App routing", () => {
  const auth = { isLoading: false, isAuthenticated: true, userName: "Sam", login: async () => undefined, logout: () => undefined };
  const api = { getPortfolio: async () => ({ connectionRequired: false, generatedAt: "2026-10-24T20:00:00.000Z", totals: [], accounts: [], errors: [] }), getConnections: async () => [], createConnectionSession: async () => ({ portalUrl: "https://x.invalid" }), getTfsaRoom: async () => owner() };

  it("opens the room page when ?view=room is set", async () => {
    window.history.pushState({}, "", "/?view=room");
    render(<PortfolioExperience auth={auth} api={api} />);
    expect(await screen.findByText("About $3,500 over your TFSA room since 14 March")).toBeInTheDocument();
    window.history.pushState({}, "", "/");
  });

  it("the TFSA tile's button opens the room page", async () => {
    render(<PortfolioExperience auth={auth} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Contribution room" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });
});

// The RRSP section: synthetic tax years as GET /api/room/rrsp gives them on 2026-02-10 (two windows open, 2025 first).
const LIMIT_PROMPT = "Enter your RRSP deduction limit from CRA My Account or your notice of assessment to see room left.";
const DEDUCT_LATER = "Unused contributions can be deducted in a later year; VestLens doesn't choose the year for you.";
const RRSP_FACT = "CRA charges 1% a month on contributions more than $2,000 over your RRSP deduction limit. Check your figures in CRA My Account.";
const ROOM_LABEL = "RRSP deduction limit less unused contributions (you entered)";
const rrspRow = (over: Partial<LedgerRowView>) => row({ label: "Synthetic RRSP", ...over });
const WINDOWS = { 2025: { taxYear: 2025, from: "2025-03-04", to: "2026-03-02" }, 2026: { taxYear: 2026, from: "2026-03-03", to: null } } as const;
const rrspYear = (Y: 2025 | 2026, over: Partial<RrspYearView> = {}): RrspYearView => {
  const w = WINDOWS[Y];
  return {
    window: w, contributedCad: 4000, limitCad: null, unusedCad: null, elsewhereCad: null, roomLeftCad: null, overLimitCad: null,
    estimated: false, missing: [{ kind: "deduction_limit" }], fx: noFx, fxDates: [],
    basis: [`Contributions for ${Y}: ${w.from} to ${w.to ?? "CRA's deadline (not yet published)"}`, "VestLens counts Home Buyers' Plan and Lifelong Learning Plan repayments as contributions", DEDUCT_LATER],
    ledger: { overSince: null, undatedExcess: false, rows: [
      rrspRow({ date: w.from, kind: "cra_room", label: ROOM_LABEL, amountCad: null, roomLeftCad: null }),
      rrspRow({ date: Y === 2025 ? "2025-05-01" : "2026-04-01", amountCad: 4000, roomLeftCad: null, excessCad: null }),
    ] },
    ...over,
  };
};
const rrspShown = (years: RrspYearView[], accounts: Extract<RrspRoomView, { status: "shown" }>["accounts"] = [
  { accountKey: "r".repeat(64), label: "Synthetic RRSP", maskedNumber: null, value: null, managed: false, closed: false },
]): RrspRoomView => ({ status: "shown", years, activityAsOf: "2026-02-09T08:00:00.000Z", accounts });
const fhsaKnown = {
  status: "known", year: 2026, roomLeftCad: 3000, contributedCad: 5000, participationRoomCad: 8000, withdrawnCad: 0, estimated: false, overLimitCad: 0,
  basis: [], fx: noFx, fxDates: [], alert: null, activityAsOf: null, headlineBasis: "Based on your connected FHSAs",
  accounts: [{ accountKey: "f".repeat(64), label: "Synthetic FHSA", maskedNumber: null, value: null }],
  ledger: { overSince: null, undatedExcess: false, rows: [row({ date: "2026-01-01", kind: "cra_room", label: "FHSA participation room from CRA (you entered)", amountCad: 8000, roomLeftCad: 8000 })] },
} as FhsaRoomView;
const tfsaKnown = () => view({ roomLeftCad: 1500, craRoomCad: 7000, ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000)] } });

const rrspPage = (rrsp: RrspRoomView | Error, o: { fhsa?: FhsaRoomView; initialTab?: "tfsa" | "fhsa" | "rrsp" } = {}) => {
  const onRrspSetup = vi.fn();
  const api = {
    getTfsaRoom: async () => tfsaKnown(), getFhsaRoom: async () => o.fhsa ?? { status: "none" },
    getRrspRoom: async () => { if (rrsp instanceof Error) throw rrsp; return rrsp; },
  };
  render(<RoomPage api={api as never} onBack={() => undefined} onSetup={() => undefined} onRrspSetup={onRrspSetup} initialTab={o.initialTab} />);
  return { onRrspSetup };
};

describe("RoomPage: the contribution room page with an RRSP", () => {
  it("with TFSA, FHSA and RRSP the glance strip shows three headlines; clicking RRSP shows the RRSP section", async () => {
    rrspPage(rrspShown([rrspYear(2026)]), { fhsa: fhsaKnown });
    const glance = await screen.findByRole("region", { name: "Contribution room at a glance" });
    await within(glance).findByText("$4,000 contributed for the 2026 tax year");
    const entries = within(glance).getAllByRole("button");
    expect(entries.map((b) => b.textContent)).toEqual([
      "TFSAAbout $1,500 of TFSA room left this year",
      "FHSAAbout $3,000 of FHSA room left this year",
      "RRSP$4,000 contributed for the 2026 tax year",
    ]);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Contribution room");
    const tabs = screen.getByRole("tablist", { name: "Registered account" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["TFSA", "FHSA", "RRSP"]);
    fireEvent.click(within(glance).getByRole("button", { name: /^RRSP/ }));
    expect(within(tabs).getByRole("tab", { name: "RRSP" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "RRSP 2026 tax year" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your RRSPs" })).toBeInTheDocument();
    expect(screen.queryByText("About $1,500 of TFSA room left this year", { selector: "h2" })).not.toBeInTheDocument();
  });

  it("on 2026-02-10 two tax-year blocks appear, 2025 first, each with its window and the deduct-later line", async () => {
    rrspPage(rrspShown([rrspYear(2025), rrspYear(2026)]), { initialTab: "rrsp" });
    const blocks = await screen.findAllByRole("region", { name: /^RRSP \d{4} tax year$/ });
    expect(blocks.map((b) => b.getAttribute("aria-label"))).toEqual(["RRSP 2025 tax year", "RRSP 2026 tax year"]);
    expect(blocks[0]).toHaveTextContent("Contributions for 2025: 4 March 2025 to 2 March 2026");
    expect(blocks[1]).toHaveTextContent("Contributions for 2026: 3 March 2026 to CRA's deadline (not yet published)");
    for (const b of blocks) expect(within(b).getByRole("list", { name: "Based on" })).toHaveTextContent(DEDUCT_LATER);
    // The window line isn't repeated in the basis.
    expect(within(blocks[0]!).getByRole("list", { name: "Based on" })).not.toHaveTextContent("Contributions for 2025");
    expect(screen.getByText("Based on activity up to 9 February 2026; deposits made since then aren't included")).toBeInTheDocument();
  });

  it("with no limit: the limit prompt and an Add your deduction limit button, and no room-left figure", async () => {
    const { onRrspSetup } = rrspPage(rrspShown([rrspYear(2026)]), { initialTab: "rrsp" });
    const block = await screen.findByRole("region", { name: "RRSP 2026 tax year" });
    expect(within(block).getByRole("heading", { name: "$4,000 contributed for the 2026 tax year" })).toBeInTheDocument();
    const needed = within(block).getByRole("list", { name: "Still needed" });
    expect(needed).toHaveTextContent(LIMIT_PROMPT);
    fireEvent.click(within(needed).getByRole("button", { name: "Add your deduction limit" }));
    expect(onRrspSetup).toHaveBeenLastCalledWith(2026, 1);
    expect(document.body.textContent).not.toMatch(/room left for|over your RRSP deduction limit/);
    expect(screen.queryByText(RRSP_FACT)).not.toBeInTheDocument();
    // No limit: no line to draw.
    expect(within(block).queryByRole("img")).not.toBeInTheDocument();
    // The limit row's edit link and the block's own button open the same year's setup.
    fireEvent.click(within(within(block).getAllByTestId("ledger-row")[0]!).getByRole("button", { name: "Edit" }));
    expect(onRrspSetup).toHaveBeenLastCalledWith(2026, 1, undefined);
    fireEvent.click(within(block).getByRole("button", { name: "Edit figures for 2026" }));
    expect(onRrspSetup).toHaveBeenLastCalledWith(2026);
    expect(onRrspSetup).toHaveBeenCalledTimes(3);
  });

  it("over the limit: the amount over, the CRA fact once, and a withdrawal that doesn't change deduction room", async () => {
    const over = rrspYear(2026, {
      contributedCad: 12500, limitCad: 10000, unusedCad: 0, elsewhereCad: 0, roomLeftCad: 0, overLimitCad: 2500, missing: [],
      basis: ["Contributions for 2026: 2026-03-03 to CRA's deadline (not yet published)", "RRSP deduction limit for 2026: $10,000 (you said)", RRSP_FACT, DEDUCT_LATER],
      ledger: { overSince: "2026-06-01", undatedExcess: false, rows: [
        rrspRow({ date: "2026-03-03", kind: "cra_room", label: ROOM_LABEL, amountCad: 10000, roomLeftCad: 10000 }),
        rrspRow({ date: "2026-06-01", amountCad: 12500, roomLeftCad: 0, excessCad: 2500, wentOver: true }),
        rrspRow({ date: "2026-07-01", kind: "withdrawal", amountCad: -500, roomLeftCad: 0, excessCad: 2500 }),
      ] },
    });
    rrspPage(rrspShown([over]), { initialTab: "rrsp" });
    const block = await screen.findByRole("region", { name: "RRSP 2026 tax year" });
    expect(within(block).getByRole("heading", { name: "$2,500 over your RRSP deduction limit for 2026" })).toHaveClass("over");
    expect(screen.getAllByText(RRSP_FACT)).toHaveLength(1);
    const rows = within(block).getAllByTestId("ledger-row");
    expect(rows[0]).toHaveTextContent(ROOM_LABEL);
    expect(rows[2]).toHaveTextContent("Synthetic RRSP withdrawal (doesn't change deduction room)");
    expect(within(block).getByRole("img")).toHaveAccessibleName("Deduction room left over the 2026 tax year: started at $10,000, ended over by $2,500 since 1 June.");
    expect(document.body.textContent).not.toMatch(/\b(should|consider|we recommend|you can contribute)\b/i);
  });

  it("room left, with the contributions entered elsewhere beside the connected ones", async () => {
    rrspPage(rrspShown([rrspYear(2026, { contributedCad: 4000, limitCad: 10000, unusedCad: 0, elsewhereCad: 1000, roomLeftCad: 5000, overLimitCad: 0, missing: [] })]), { initialTab: "rrsp" });
    const block = await screen.findByRole("region", { name: "RRSP 2026 tax year" });
    expect(within(block).getByRole("heading", { name: "$5,000 of RRSP deduction room left for 2026" })).toBeInTheDocument();
    expect(block).toHaveTextContent("$4,000 contributed plus $1,000 you entered as contributions not in VestLens");
  });

  it("with the limit only: the unused and elsewhere questions, each with a button to the year's setup, and no room-left figure (R11)", async () => {
    const limitOnly = rrspYear(2026, {
      limitCad: 2000, missing: [{ kind: "unused_contributions" }, { kind: "elsewhere" }],
      ledger: { overSince: null, undatedExcess: false, rows: [
        rrspRow({ date: "2026-03-03", kind: "cra_room", label: ROOM_LABEL, amountCad: null, roomLeftCad: null }),
        rrspRow({ date: "2026-04-01", amountCad: 4000, roomLeftCad: null, excessCad: null }),
      ] },
    });
    const { onRrspSetup } = rrspPage(rrspShown([limitOnly]), { initialTab: "rrsp" });
    const block = await screen.findByRole("region", { name: "RRSP 2026 tax year" });
    expect(within(block).getByRole("heading", { name: "$4,000 contributed for the 2026 tax year" })).toBeInTheDocument();
    const needed = within(block).getByRole("list", { name: "Still needed" });
    const lines = within(needed).getAllByRole("listitem");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent("What unused RRSP contributions does CRA show for 2026? It's next to your deduction limit on your notice of assessment and in CRA My Account; enter 0 if there are none.");
    expect(lines[1]).toHaveTextContent("Did you contribute to an RRSP VestLens doesn't see for the 2026 tax year, such as a group RRSP at work, an account at another institution, or a spousal RRSP for your spouse? Enter the total, or 0 if none.");
    expect(needed).not.toHaveTextContent(LIMIT_PROMPT);
    fireEvent.click(within(lines[0]!).getByRole("button", { name: "Add unused contributions" }));
    expect(onRrspSetup).toHaveBeenLastCalledWith(2026, 1);
    fireEvent.click(within(lines[1]!).getByRole("button", { name: "Add contributions not in VestLens" }));
    expect(onRrspSetup).toHaveBeenLastCalledWith(2026, 1);
    expect(onRrspSetup).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toMatch(/room left for|over your RRSP deduction limit/);
    expect(screen.queryByText(RRSP_FACT)).not.toBeInTheDocument();
    expect(within(block).queryByRole("img")).not.toBeInTheDocument();
  });

  it("an estimated year: the glance line and the year block are marked (est.) even without a conversion note", async () => {
    rrspPage(rrspShown([rrspYear(2026, { estimated: true })]), { fhsa: fhsaKnown, initialTab: "rrsp" });
    const glance = await screen.findByRole("region", { name: "Contribution room at a glance" });
    expect(within(glance).getByRole("button", { name: /^RRSP/ })).toHaveTextContent("RRSP$4,000 contributed for the 2026 tax year (est.)");
    const block = screen.getByRole("region", { name: "RRSP 2026 tax year" });
    expect(within(block).getByText("(est.)")).toBeInTheDocument();
  });

  it("a converted year: the block's note is the conversion note; the glance line is marked (est.)", async () => {
    const fx = { contributions: { estimated: true, rateDates: ["2026-05-01"], native: [{ amount: 1000, currency: "USD" }] }, withdrawals: noFx.withdrawals };
    rrspPage(rrspShown([rrspYear(2026, { estimated: true, fx, fxDates: ["2026-05-01"] })]), { fhsa: fhsaKnown, initialTab: "rrsp" });
    const glance = await screen.findByRole("region", { name: "Contribution room at a glance" });
    expect(within(glance).getByRole("button", { name: /^RRSP/ })).toHaveTextContent("(est.)");
    const block = screen.getByRole("region", { name: "RRSP 2026 tax year" });
    expect(within(block).getByText("(est.; includes US$1,000 converted at the Bank of Canada rate of 2026-05-01)")).toBeInTheDocument();
    expect(within(block).queryByText("(est.)")).not.toBeInTheDocument();
  });

  it("a year with an unpublished deadline: the chart ends on the Toronto date, not the UTC one", async () => {
    // 22:00 on 29 October in Toronto is already 30 October in UTC.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T02:00:00.000Z"));
    try {
      rrspPage(rrspShown([rrspYear(2026, {
        limitCad: 10000, unusedCad: 0, elsewhereCad: 0, roomLeftCad: 6000, overLimitCad: 0, missing: [],
        ledger: { overSince: null, undatedExcess: false, rows: [
          rrspRow({ date: "2026-03-03", kind: "cra_room", label: ROOM_LABEL, amountCad: 10000, roomLeftCad: 10000 }),
          rrspRow({ date: "2026-04-01", amountCad: 4000, roomLeftCad: 6000, excessCad: 0 }),
        ] },
      })]), { initialTab: "rrsp" });
      const block = await screen.findByRole("region", { name: "RRSP 2026 tax year" });
      const chart = within(block).getByRole("img");
      expect(chart).toHaveTextContent("29 Oct 2026");
      expect(chart).not.toHaveTextContent("30 Oct 2026");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unestimated year: no (est.) in the glance or the block", async () => {
    rrspPage(rrspShown([rrspYear(2026)]), { fhsa: fhsaKnown, initialTab: "rrsp" });
    const glance = await screen.findByRole("region", { name: "Contribution room at a glance" });
    await within(glance).findByText("$4,000 contributed for the 2026 tax year");
    expect(document.body.textContent).not.toContain("(est.");
  });

  it("a managed RRSP: the SnapTrade sentence with a button to the year's setup; closed accounts are marked", async () => {
    const { onRrspSetup } = rrspPage(rrspShown([rrspYear(2026, { missing: [{ kind: "deduction_limit" }, { kind: "managed_rrsp", labels: ["Synthetic Managed RRSP"] }], contributedCad: 4000 })], [
      { accountKey: "r".repeat(64), label: "Synthetic RRSP", maskedNumber: null, value: null, managed: false, closed: true },
      { accountKey: "m".repeat(64), label: "Synthetic Managed RRSP", maskedNumber: null, value: null, managed: true, closed: false },
    ]), { initialTab: "rrsp" });
    const block = await screen.findByRole("region", { name: "RRSP 2026 tax year" });
    expect(within(block).getByRole("heading", { name: "I can't give a number for 2026 yet" })).toBeInTheDocument();
    const needed = within(block).getByRole("list", { name: "Still needed" });
    expect(needed).toHaveTextContent("Contributions to Synthetic Managed RRSP aren't visible through SnapTrade. Add them, plus any other RRSP contributions VestLens doesn't see for the 2026 tax year (a group RRSP at work, an account at another institution, a spousal RRSP for your spouse), to 'Contributions not in VestLens'; enter 0 if there are none.");
    fireEvent.click(within(needed).getByRole("button", { name: "Add contributions not in VestLens" }));
    expect(onRrspSetup).toHaveBeenLastCalledWith(2026, 1);
    const accounts = screen.getByRole("region", { name: "Your RRSPs" });
    expect(accounts).toHaveTextContent("Synthetic RRSP (closed): counted as an RRSP");
    expect(accounts).toHaveTextContent("Synthetic Managed RRSP: a managed portfolio; its contributions aren't visible through SnapTrade");
  });

  it("an unclear RRSP transfer: the question with a Set up button to step 4; unclear and matched rows link to step 4 on that row", async () => {
    const UNCLEAR = "5".repeat(16);
    const MATCHED = "6".repeat(16);
    const unclear = rrspYear(2026, {
      contributedCad: null,
      missing: [{ kind: "deduction_limit" }, { kind: "ambiguous", count: 1, rows: [{ activityKey: UNCLEAR, date: "2026-05-01", amountCad: 700, estimated: false, rateDate: null, native: null, type: "TRANSFER_IN", label: "Synthetic RRSP" }] }],
      ledger: { overSince: null, undatedExcess: false, rows: [
        rrspRow({ date: "2026-03-03", kind: "cra_room", label: ROOM_LABEL, amountCad: null, roomLeftCad: null }),
        rrspRow({ date: "2026-04-01", amountCad: 2000, roomLeftCad: null, excessCad: null, matchedWith: { label: "Synthetic TFSA", date: "2026-03-31" }, inferred: true, activityKey: MATCHED }),
        rrspRow({ date: "2026-05-01", kind: "ambiguous", amountCad: 700, roomLeftCad: null, excessCad: null, activityKey: UNCLEAR }),
        rrspRow({ date: "2026-06-01", amountCad: 300, roomLeftCad: null, excessCad: null }),
      ] },
    });
    const { onRrspSetup } = rrspPage(rrspShown([unclear]), { initialTab: "rrsp" });
    const block = await screen.findByRole("region", { name: "RRSP 2026 tax year" });
    expect(within(block).getByRole("heading", { name: "I can't give a number for 2026 yet" })).toBeInTheDocument();
    const needed = within(block).getByRole("list", { name: "Still needed" });
    expect(needed).toHaveTextContent("Was the TRANSFER_IN of $700 on 2026-05-01 (Synthetic RRSP) a contribution to your RRSP?");
    fireEvent.click(within(needed).getByRole("button", { name: "Set up" }));
    expect(onRrspSetup).toHaveBeenLastCalledWith(2026, 4);
    const rows = within(block).getAllByTestId("ledger-row");
    fireEvent.click(within(rows[2]!).getByRole("button", { name: "Answer" }));
    expect(onRrspSetup).toHaveBeenLastCalledWith(2026, 4, UNCLEAR);
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Edit" }));
    expect(onRrspSetup).toHaveBeenLastCalledWith(2026, 4, MATCHED);
    // A plain contribution takes no answer.
    expect(within(rows[3]!).queryByRole("button")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/dashboard doesn't take it yet/);
  });

  it("a user without an RRSP, or whose RRSP fails to load, sees no RRSP tab or glance entry", async () => {
    rrspPage({ status: "none" }, { fhsa: fhsaKnown });
    const tabs = await screen.findByRole("tablist", { name: "Registered account" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["TFSA", "FHSA"]);
    expect(within(screen.getByRole("region", { name: "Contribution room at a glance" })).getAllByRole("button")).toHaveLength(2);
    cleanup();
    rrspPage(new Error("boom <b>"));
    expect(await screen.findByText("About $1,500 of TFSA room left this year")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Contribution room at a glance" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("RRSP");
  });
});

describe("App: the RRSP setup returns to the RRSP tab", () => {
  const auth = { isLoading: false, isAuthenticated: true, userName: "Synthetic", login: async () => undefined, logout: () => undefined };
  it("Add your deduction limit opens the year's setup; Save returns to the page on the RRSP tab", async () => {
    let current: RrspRoomView = rrspShown([rrspYear(2026)]);
    const api = {
      getPortfolio: async () => ({ connectionRequired: false, generatedAt: "2026-10-24T20:00:00.000Z", totals: [], accounts: [], errors: [] }),
      getConnections: async () => [], createConnectionSession: async () => ({ portalUrl: "https://x.invalid" }),
      getTfsaRoom: async () => tfsaKnown(), getFhsaRoom: async () => ({ status: "none" }), getRrspRoom: async () => current,
      putRrspLimit: vi.fn(async () => {
        current = rrspShown([rrspYear(2026, { limitCad: 10000, unusedCad: 0, missing: [{ kind: "elsewhere" }] })]);
        return current;
      }),
      // Room left needs all three figures: it comes with the elsewhere figure.
      putRrspElsewhere: vi.fn(async () => {
        current = rrspShown([rrspYear(2026, { limitCad: 10000, unusedCad: 0, elsewhereCad: 0, roomLeftCad: 6000, overLimitCad: 0, missing: [] })]);
        return current;
      }),
    };
    window.history.pushState({}, "", "/?view=room");
    render(<PortfolioExperience auth={auth} api={api as never} />);
    fireEvent.click(await screen.findByRole("tab", { name: "RRSP" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add your deduction limit" }));
    fireEvent.change(await screen.findByLabelText("RRSP deduction limit for 2026"), { target: { value: "10000" } });
    fireEvent.change(screen.getByLabelText("Unused RRSP contributions"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Contributions not in VestLens for the 2026 tax year"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { name: "$6,000 of RRSP deduction room left for 2026" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "RRSP" })).toHaveAttribute("aria-selected", "true");
    expect(api.putRrspLimit).toHaveBeenCalledWith({ year: 2026, amountCad: 10000, unusedCad: 0 });
    expect(api.putRrspElsewhere).toHaveBeenCalledWith({ year: 2026, amountCad: 0 });
    window.history.pushState({}, "", "/");
  });

  it("an unclear RRSP transfer's Set up opens step 4; answering PUTs to the RRSP route and returns to the RRSP tab", async () => {
    const KEY = "7".repeat(16);
    const asked = rrspYear(2026, {
      contributedCad: null,
      missing: [{ kind: "ambiguous", count: 1, rows: [{ activityKey: KEY, date: "2026-05-01", amountCad: 700, estimated: false, rateDate: null, native: null, type: "TRANSFER_IN", label: "Synthetic RRSP" }] }],
    });
    let current: RrspRoomView = rrspShown([asked]);
    const api = {
      getPortfolio: async () => ({ connectionRequired: false, generatedAt: "2026-10-24T20:00:00.000Z", totals: [], accounts: [], errors: [] }),
      getConnections: async () => [], createConnectionSession: async () => ({ portalUrl: "https://x.invalid" }),
      getTfsaRoom: async () => tfsaKnown(), getFhsaRoom: async () => ({ status: "none" }), getRrspRoom: async () => current,
      putRrspRoomActivity: vi.fn(async () => { current = rrspShown([rrspYear(2026, { contributedCad: 4700 })]); return current; }),
    };
    window.history.pushState({}, "", "/?view=room");
    render(<PortfolioExperience auth={auth} api={api as never} />);
    fireEvent.click(await screen.findByRole("tab", { name: "RRSP" }));
    fireEvent.click(within(await screen.findByRole("list", { name: "Still needed" })).getByRole("button", { name: "Set up" }));
    const step = await screen.findByRole("region", { name: "Unclear transfer on 1 May 2026" });
    fireEvent.click(within(step).getByRole("button", { name: "Moved from my FHSA" }));
    expect(await screen.findByRole("heading", { name: "$4,700 contributed for the 2026 tax year" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "RRSP" })).toHaveAttribute("aria-selected", "true");
    expect(api.putRrspRoomActivity).toHaveBeenCalledWith(KEY, { effect: "none" });
    window.history.pushState({}, "", "/");
  });
});
