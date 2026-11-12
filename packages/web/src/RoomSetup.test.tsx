// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PortfolioExperience } from "./App";
import type { LedgerRowView, RoomAmbiguousRow, RoomMissingItem, TfsaRoomView } from "./apiErrors";
import { RoomSetup } from "./RoomSetup";

// Synthetic amounts, labels and keys only.
const noFx = { contributions: { estimated: false, rateDates: [], native: [] }, withdrawals: { estimated: false, rateDates: [], native: [] } };
const TFSA = "a".repeat(64);
const NEUTRAL = "b".repeat(64);
const T1 = "c".repeat(64);
const T2 = "d".repeat(64);
const row = (over: Partial<LedgerRowView>): LedgerRowView => ({
  date: "2026-03-01", kind: "contribution", label: "Synthetic TFSA", amountCad: 1000, estimated: false, rateDate: null, native: null,
  roomLeftCad: null, excessCad: null, wentOver: false, ...over,
});
const craRow = (room: number | null) => row({ date: "2026-01-01", kind: "cra_room", label: "Room", amountCad: room, roomLeftCad: room });
const amb = (key: string, over: Partial<RoomAmbiguousRow> = {}): RoomAmbiguousRow => ({
  activityKey: key, date: "2026-03-03", amountCad: 5000, estimated: false, rateDate: null, native: null,
  type: "INTERNAL_CASH_TRANSFER_IN", label: "Synthetic TFSA", ...over,
});

const accounts = [
  { accountKey: TFSA, label: "Synthetic TFSA", neutral: false, inSet: false },
  { accountKey: NEUTRAL, label: "Synthetic Unlabelled", neutral: true, inSet: false },
];

const missing = (items: RoomMissingItem[], over: Record<string, unknown> = {}): TfsaRoomView => ({
  status: "missing", missing: items, year: 2026, withdrawnCad: 0, basis: [], fx: noFx, alert: null, accounts, outcomes: {}, accountSet: null,
  ledger: { rows: [craRow(null)], overSince: null, undatedExcess: false }, ...over,
} as TfsaRoomView);

const known = (over: Record<string, unknown> = {}): TfsaRoomView => ({
  status: "known", year: 2026, roomLeftCad: 2000, contributedCad: 5000, craRoomCad: 7000, withdrawnCad: 0, estimated: false, overLimitCad: 0,
  basis: [], fx: noFx, alert: null, activityAsOf: "2026-10-24T20:00:00.000Z", outcomes: {},
  accounts: [{ ...accounts[0]!, inSet: true }], accountSet: { connected: [TFSA], notTfsa: [], outside: [] },
  ledger: { rows: [craRow(7000), row({ amountCad: 5000, roomLeftCad: 2000, excessCad: 0 })], overSince: null, undatedExcess: false }, ...over,
} as TfsaRoomView);

const ledgerCells = () => screen.getAllByTestId("ledger-row").map((r) => r.lastElementChild!.textContent);

function mount(first: TfsaRoomView, o: { initialStep?: 1 | 2 | 3 | 4; activityKey?: string; api?: Record<string, unknown> } = {}) {
  const api = {
    getTfsaRoom: vi.fn(async () => first),
    putRoomCra: vi.fn(async () => first),
    putRoomAccounts: vi.fn(async () => first),
    putRoomOutsideMoves: vi.fn(async () => first),
    putRoomActivity: vi.fn(async () => first),
    ...o.api,
  };
  const onDone = vi.fn();
  render(<RoomSetup api={api as never} initialStep={o.initialStep} activityKey={o.activityKey} onDone={onDone} />);
  return { api, onDone };
}

afterEach(cleanup);

describe("RoomSetup step 1", () => {
  it("asks for the CRA figure, saves it and returns to the room page: the full flow is this one step", async () => {
    const after = known({ accountSet: null });
    const { api, onDone } = mount(missing([{ kind: "cra_room" }]), { api: { putRoomCra: vi.fn(async () => after) } });
    const input = await screen.findByLabelText("Contribution room on January 1, 2026");
    expect(screen.getByText(/not one you've worked out/)).toBeInTheDocument();
    expect(screen.getByText(/“Contribution room on January 1, 2026”/)).toBeInTheDocument();
    expect(screen.queryByText(/Step \d of/)).toBeNull();
    expect(ledgerCells()).toEqual(["?"]);
    fireEvent.change(input, { target: { value: "7000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.putRoomCra).toHaveBeenCalledWith({ year: 2026, amountCad: 7000 }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    // No account question follows, and with no set last year nothing else is written.
    expect(screen.queryByRole("heading", { name: /Your TFSAs/ })).toBeNull();
    expect(api.putRoomAccounts).not.toHaveBeenCalled();
  });

  it("'Later' returns to the page without saving anything", async () => {
    const { api, onDone } = mount(missing([{ kind: "cra_room" }]));
    await screen.findByRole("heading", { name: /Room on 1 January 2026/ });
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    for (const put of [api.putRoomCra, api.putRoomAccounts, api.putRoomOutsideMoves, api.putRoomActivity]) expect(put).not.toHaveBeenCalled();
  });

  it("refuses a negative or empty figure without saving", async () => {
    const { api } = mount(missing([{ kind: "cra_room" }]));
    const input = await screen.findByLabelText("Contribution room on January 1, 2026");
    fireEvent.change(input, { target: { value: "-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the figure as a dollar amount");
    expect(api.putRoomCra).not.toHaveBeenCalled();
  });
});

describe("RoomSetup step 2 (from its edit link)", () => {
  it("is titled 'Your TFSAs: add or remove accounts', ticks broker-labelled TFSAs, leaves neutral ones unticked, saves and returns", async () => {
    const { api, onDone } = mount(missing([{ kind: "cra_room" }]), { initialStep: 2 });
    expect(await screen.findByRole("heading", { name: "Your TFSAs: add or remove accounts" })).toBeInTheDocument();
    const tfsa = screen.getByRole("checkbox", { name: /Synthetic TFSA/ });
    const neutral = screen.getByRole("checkbox", { name: /Synthetic Unlabelled/ });
    expect(tfsa).toBeChecked();
    expect(neutral).not.toBeChecked();
    fireEvent.click(neutral);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // Only the neutral account the user ticked goes in connected; the broker-labelled TFSA counts without it.
    await waitFor(() => expect(api.putRoomAccounts).toHaveBeenCalledWith({ year: 2026, connected: [NEUTRAL], notTfsa: [], outside: [] }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("says the preview isn't final while an account's history is still being read", async () => {
    mount(missing([{ kind: "coverage", label: "Synthetic TFSA", accountKey: TFSA }]));
    expect(await screen.findByText(/still reading this year's deposits and withdrawals/i)).toBeInTheDocument();
    cleanup();
    mount(missing([{ kind: "cra_room" }]));
    expect(await screen.findByRole("heading", { name: "Preview" })).toBeInTheDocument();
    expect(screen.queryByText(/still reading this year's deposits/i)).toBeNull();
  });

  it("keeps a neutral account's stored notTfsa entry on re-save, and never writes a broker TFSA into connected", async () => {
    const room = missing([{ kind: "cra_room" }], {
      accounts: [{ ...accounts[0]!, inSet: true }, { ...accounts[1]!, inSet: false }],
      accountSet: { connected: [TFSA], notTfsa: [NEUTRAL], outside: [] },
    });
    const { api } = mount(room, { initialStep: 2 });
    expect(await screen.findByRole("checkbox", { name: /Synthetic TFSA/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Synthetic Unlabelled/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.putRoomAccounts).toHaveBeenCalledWith({ year: 2026, connected: [], notTfsa: [NEUTRAL], outside: [] }));
  });

  it("stores notTfsa only for broker-labelled TFSAs unticked: an unknown-type account left unticked isn't listed", async () => {
    const { api } = mount(missing([{ kind: "cra_room" }]), { initialStep: 2 });
    fireEvent.click(await screen.findByRole("checkbox", { name: /Synthetic TFSA/ }));
    expect(screen.getByRole("checkbox", { name: /Synthetic Unlabelled/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.putRoomAccounts).toHaveBeenCalledWith({ year: 2026, connected: [], notTfsa: [TFSA], outside: [] }));
  });

  it("links to step 3 for TFSAs at other institutions", async () => {
    mount(missing([{ kind: "cra_room" }]), { initialStep: 2 });
    fireEvent.click(await screen.findByRole("button", { name: "TFSAs at other institutions" }));
    expect(await screen.findByRole("heading", { name: "TFSAs at other institutions" })).toBeInTheDocument();
  });

  it("shows each account's last 4 and value; nothing extra when they're null, and no doubled suffix", async () => {
    const room = missing([{ kind: "cra_room" }], {
      accounts: [
        { ...accounts[0]!, maskedNumber: "1234", value: { amount: 12345.6, currency: "CAD" } },
        { ...accounts[1]!, maskedNumber: null, value: null },
        { accountKey: T1, label: "Synthetic Twin ••9876", neutral: false, inSet: false, maskedNumber: "9876", value: { amount: 50, currency: "USD" } },
        { accountKey: T2, label: "Synthetic No Number", neutral: false, inSet: false, maskedNumber: null, value: { amount: 10, currency: "CAD" } },
      ],
    });
    mount(room, { initialStep: 2 });
    expect(await screen.findByRole("checkbox", { name: "Synthetic TFSA ••1234, $12,345.60 CAD" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Synthetic Unlabelled (your broker doesn't label its type)" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Synthetic Twin ••9876, $50 USD" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Synthetic No Number, $10 CAD" })).toBeInTheDocument();
  });

  it("with a confirmed set, ticks what's in it and keeps its outside TFSAs", async () => {
    const room = missing([{ kind: "cra_room" }], {
      accounts: [{ ...accounts[0]!, inSet: false }, { ...accounts[1]!, inSet: true }],
      accountSet: { connected: [NEUTRAL], notTfsa: [TFSA], outside: [{ label: "Synthetic Bank" }] },
    });
    const { api } = mount(room, { initialStep: 2 });
    expect(await screen.findByRole("checkbox", { name: /Synthetic TFSA/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Synthetic Unlabelled/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.putRoomAccounts).toHaveBeenCalledWith({ year: 2026, connected: [NEUTRAL], notTfsa: [TFSA], outside: [{ label: "Synthetic Bank" }] }));
  });
});

describe("RoomSetup step 3", () => {
  it("adds an outside TFSA (writing the account set) and saves a dated deposit and a dated withdrawal", async () => {
    const withBank = known({ accountSet: { connected: [TFSA], notTfsa: [], outside: [{ label: "Synthetic Bank" }] } });
    const { api } = mount(known(), { initialStep: 3, api: { putRoomAccounts: vi.fn(async () => withBank) } });
    fireEvent.change(await screen.findByLabelText("Name of the institution or account"), { target: { value: "Synthetic Bank" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    // The stored set lists the broker TFSA in connected (an older save): it isn't passed through, so no key is promoted.
    await waitFor(() => expect(api.putRoomAccounts).toHaveBeenCalledWith({ year: 2026, connected: [], notTfsa: [], outside: [{ label: "Synthetic Bank" }] }));
    const bank = await screen.findByRole("group", { name: "Synthetic Bank" });
    expect(within(bank).queryByLabelText(/total/i)).toBeNull();
    fireEvent.click(within(bank).getByRole("button", { name: "Add a deposit or withdrawal" }));
    fireEvent.click(within(bank).getByRole("button", { name: "Add a deposit or withdrawal" }));
    const dates = within(bank).getAllByLabelText("Date");
    const kinds = within(bank).getAllByLabelText("Deposit or withdrawal");
    const amounts = within(bank).getAllByLabelText("Amount (CAD)");
    fireEvent.change(dates[0]!, { target: { value: "2026-02-10" } });
    fireEvent.change(amounts[0]!, { target: { value: "3000" } });
    fireEvent.change(dates[1]!, { target: { value: "2026-04-01" } });
    fireEvent.change(kinds[1]!, { target: { value: "withdrawal" } });
    fireEvent.change(amounts[1]!, { target: { value: "500" } });
    fireEvent.click(within(bank).getByRole("button", { name: "Save Synthetic Bank" }));
    await waitFor(() => expect(api.putRoomOutsideMoves).toHaveBeenCalledWith("Synthetic Bank", {
      year: 2026,
      entries: [{ date: "2026-02-10", amountCad: 3000, kind: "deposit" }, { date: "2026-04-01", amountCad: 500, kind: "withdrawal" }],
    }));
  });

  it("refuses a date outside the year", async () => {
    const room = known({ accountSet: { connected: [TFSA], notTfsa: [], outside: [{ label: "Synthetic Bank" }] } });
    const { api } = mount(room, { initialStep: 3 });
    const bank = await screen.findByRole("group", { name: "Synthetic Bank" });
    fireEvent.click(within(bank).getByRole("button", { name: "Add a deposit or withdrawal" }));
    fireEvent.change(within(bank).getByLabelText("Date"), { target: { value: "2025-12-31" } });
    fireEvent.change(within(bank).getByLabelText("Amount (CAD)"), { target: { value: "100" } });
    fireEvent.click(within(bank).getByRole("button", { name: "Save Synthetic Bank" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Each entry needs a date in 2026, no later than today, and an amount");
    expect(api.putRoomOutsideMoves).not.toHaveBeenCalled();
  });

  it("caps entry dates at today's Toronto date: the field's max, and a later date is refused without saving", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T03:30:00Z")); // still 24 October in Toronto
    try {
      const room = known({ accountSet: { connected: [TFSA], notTfsa: [], outside: [{ label: "Synthetic Bank" }] } });
      const { api } = mount(room, { initialStep: 3 });
      const bank = await screen.findByRole("group", { name: "Synthetic Bank" });
      fireEvent.click(within(bank).getByRole("button", { name: "Add a deposit or withdrawal" }));
      const date = within(bank).getByLabelText("Date");
      expect(date).toHaveAttribute("max", "2026-10-24");
      fireEvent.change(date, { target: { value: "2026-10-25" } });
      fireEvent.change(within(bank).getByLabelText("Amount (CAD)"), { target: { value: "100" } });
      fireEvent.click(within(bank).getByRole("button", { name: "Save Synthetic Bank" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("no later than today");
      expect(api.putRoomOutsideMoves).not.toHaveBeenCalled();
      fireEvent.change(date, { target: { value: "2026-10-24" } });
      fireEvent.click(within(bank).getByRole("button", { name: "Save Synthetic Bank" }));
      await waitFor(() => expect(api.putRoomOutsideMoves).toHaveBeenCalledWith("Synthetic Bank", { year: 2026, entries: [{ date: "2026-10-24", amountCad: 100, kind: "deposit" }] }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("'Remove <label>' asks once; Cancel keeps it, confirming removes it", async () => {
    const room = known({ accountSet: { connected: [TFSA], notTfsa: [], outside: [{ label: "Synthetic Bank" }] } });
    const { api } = mount(room, { initialStep: 3 });
    const bank = await screen.findByRole("group", { name: "Synthetic Bank" });
    fireEvent.click(within(bank).getByRole("button", { name: "Remove Synthetic Bank" }));
    expect(api.putRoomAccounts).not.toHaveBeenCalled();
    const confirm = screen.getByRole("group", { name: "Remove Synthetic Bank" });
    expect(confirm).toHaveTextContent("Remove Synthetic Bank and its entries? This can't be undone.");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Remove Synthetic Bank and its entries? This can't be undone.")).toBeNull();
    expect(api.putRoomAccounts).not.toHaveBeenCalled();
    fireEvent.click(within(bank).getByRole("button", { name: "Remove Synthetic Bank" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Remove Synthetic Bank" })).getByRole("button", { name: "Remove Synthetic Bank" }));
    await waitFor(() => expect(api.putRoomAccounts).toHaveBeenCalledWith({ year: 2026, connected: [], notTfsa: [], outside: [] }));
  });

  it("pre-fills an outside TFSA's saved entries from the ledger", async () => {
    const room = known({
      accountSet: { connected: [TFSA], notTfsa: [], outside: [{ label: "Synthetic Bank" }] },
      ledger: { overSince: null, undatedExcess: false, rows: [
        craRow(7000),
        row({ date: "2026-02-10", label: "Synthetic Bank", accountKey: "outside:synthetic-bank", amountCad: 3000 }),
        row({ date: "2026-04-01", kind: "withdrawal", label: "Synthetic Bank", accountKey: "outside:synthetic-bank", amountCad: -500, returnsOn: "2027-01-01" }),
      ] },
    });
    mount(room, { initialStep: 3 });
    const bank = await screen.findByRole("group", { name: "Synthetic Bank" });
    expect(within(bank).getAllByLabelText("Date").map((i) => (i as HTMLInputElement).value)).toEqual(["2026-02-10", "2026-04-01"]);
    expect(within(bank).getAllByLabelText("Deposit or withdrawal").map((i) => (i as HTMLSelectElement).value)).toEqual(["deposit", "withdrawal"]);
    expect(within(bank).getAllByLabelText("Amount (CAD)").map((i) => (i as HTMLInputElement).value)).toEqual(["3000", "500"]);
  });

  it("a step-3 save passes through only the set's own neutral adds, notTfsa and outside labels", async () => {
    const room = known({
      accounts: [{ ...accounts[0]!, inSet: true }, { ...accounts[1]!, inSet: true }],
      accountSet: { connected: [TFSA, NEUTRAL], notTfsa: [], outside: [] },
    });
    const { api } = mount(room, { initialStep: 3 });
    fireEvent.change(await screen.findByLabelText("Name of the institution or account"), { target: { value: "Synthetic Bank" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.putRoomAccounts).toHaveBeenCalledWith({ year: 2026, connected: [NEUTRAL], notTfsa: [], outside: [{ label: "Synthetic Bank" }] }));
  });

  it("without a confirmed set, adds an outside TFSA on top of the broker's labels (no step 2 first)", async () => {
    const { api } = mount(missing([{ kind: "cra_room" }], { accountSet: null }), { initialStep: 3 });
    fireEvent.change(await screen.findByLabelText("Name of the institution or account"), { target: { value: "Synthetic Bank" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.putRoomAccounts).toHaveBeenCalledWith({ year: 2026, connected: [], notTfsa: [], outside: [{ label: "Synthetic Bank" }] }));
  });

  it("Continue returns to the page", async () => {
    const { onDone } = mount(known(), { initialStep: 3 });
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });
});

describe("RoomSetup step 4", () => {
  const ambiguous = (rows: RoomAmbiguousRow[], outcomes: Record<string, unknown>) => known({
    status: "missing", missing: [{ kind: "ambiguous", count: rows.length, rows }], outcomes,
    ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000), ...rows.map((r) => row({ kind: "ambiguous", activityKey: r.activityKey, date: r.date, amountCad: r.amountCad }))] },
  });

  it("opens on the unclear transfer its row names, with both outcomes; the answer is saved and the page returns (no queue)", async () => {
    const both = ambiguous([amb(T1), amb(T2, { date: "2026-06-01", amountCad: 2000 })], {
      [T1]: { asContribution: { roomLeftCad: -4000, excessCad: 4000 }, asNone: { roomLeftCad: 1000, excessCad: 0 } },
      [T2]: { asContribution: { roomLeftCad: 3000, excessCad: 0 }, asNone: { roomLeftCad: 5000, excessCad: 0 } },
    });
    const putRoomActivity = vi.fn(async () => ambiguous([amb(T1)], {}));
    const { onDone } = mount(both, { initialStep: 4, activityKey: T2, api: { putRoomActivity } });
    const q = await screen.findByRole("region", { name: "Unclear transfer on 1 June 2026" });
    expect(q).toHaveTextContent("1 June 2026");
    expect(q).toHaveTextContent("$2,000");
    expect(q).toHaveTextContent("internal cash transfer in");
    expect(q).toHaveTextContent("Synthetic TFSA");
    expect(q).not.toHaveTextContent(/of 2/);
    expect(screen.getByText("Room left at the end of the year so far: $3,000 or $5,000")).toBeInTheDocument();
    fireEvent.click(within(q).getByRole("button", { name: "Moved from another TFSA" }));
    await waitFor(() => expect(putRoomActivity).toHaveBeenCalledWith(T2, { effect: "none" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    // The other unclear transfer is not walked to: it stays a row on the page.
    expect(screen.queryByRole("region", { name: /Unclear transfer on 3 March/ })).toBeNull();
  });

  it("an unclear row beyond the missing list's cap opens from its ledger row", async () => {
    const room = known({
      status: "missing", missing: [{ kind: "ambiguous", count: 6, rows: [] }], outcomes: {},
      ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000), row({ kind: "ambiguous", activityKey: T1, date: "2026-08-08", amountCad: 900 })] },
    });
    mount(room, { initialStep: 4, activityKey: T1 });
    const q = await screen.findByRole("region", { name: "Unclear transfer on 8 August 2026" });
    expect(q).toHaveTextContent("Synthetic TFSA"); expect(q).toHaveTextContent("8 August 2026, $900");
  });

  it("a transfer already answered 'moved from another TFSA' can be answered again from its edit link", async () => {
    const room = known({ ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000), row({ kind: "none", activityKey: T1, date: "2026-03-03", amountCad: 2500, roomLeftCad: 7000, excessCad: 0, answered: true })] } });
    const { api, onDone } = mount(room, { initialStep: 4, activityKey: T1 });
    const q = await screen.findByRole("region", { name: "Transfer on 3 March 2026" });
    expect(q).toHaveTextContent("Synthetic TFSA"); expect(q).toHaveTextContent("3 March 2026, $2,500");
    expect(q).toHaveTextContent("You answered: moved from another TFSA.");
    expect(screen.queryByText("No transfers need checking.")).toBeNull();
    fireEvent.click(within(q).getByRole("button", { name: "New money (a contribution)" }));
    await waitFor(() => expect(api.putRoomActivity).toHaveBeenCalledWith(T1, { effect: "contribution" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("a matched transfer opens from its edit link, says what it was matched to, and the answer is stored", async () => {
    const matched = row({ activityKey: T1, date: "2026-03-03", amountCad: 2500, roomLeftCad: 4500, excessCad: 0, inferred: true, matchedWith: { label: "Synthetic Cash", date: "2026-03-02" } });
    const room = known({ ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000), matched] } });
    const { api, onDone } = mount(room, { initialStep: 4, activityKey: T1 });
    const q = await screen.findByRole("region", { name: "Transfer on 3 March 2026" });
    expect(q).toHaveTextContent("Synthetic TFSA"); expect(q).toHaveTextContent("3 March 2026, $2,500");
    expect(q).toHaveTextContent("Matched to a transfer from Synthetic Cash on 2 March.");
    expect(within(q).getByRole("button", { name: "New money (a contribution)" })).toBeInTheDocument();
    expect(q).not.toHaveTextContent("You answered");
    fireEvent.click(within(q).getByRole("button", { name: "Moved from another TFSA" }));
    await waitFor(() => expect(api.putRoomActivity).toHaveBeenCalledWith(T1, { effect: "none" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  const outMatched = (over: Partial<LedgerRowView> = {}) => row({
    kind: "withdrawal", activityKey: T1, date: "2026-04-03", amountCad: -800, roomLeftCad: 2000, excessCad: 0, qualifyingCad: 0, returnsCad: 800, returnsOn: "2027-01-01",
    inferred: true, matchedWith: { label: "Synthetic Cash", date: "2026-04-03" }, ...over,
  });
  const outRoom = (r: LedgerRowView) => known({ ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000), row({ amountCad: 5000, roomLeftCad: 2000, excessCad: 0 }), r] } });

  it("an outgoing matched transfer is worded as money leaving the TFSAs; 'Taken out' stores withdrawal and the room stays known", async () => {
    const after = outRoom(outMatched({ inferred: undefined, matchedWith: undefined }));
    const { api, onDone } = mount(outRoom(outMatched()), { initialStep: 4, activityKey: T1, api: { putRoomActivity: vi.fn(async () => after) } });
    const q = await screen.findByRole("region", { name: "Transfer on 3 April 2026" });
    expect(q).toHaveTextContent("Synthetic TFSA"); expect(q).toHaveTextContent("3 April 2026, -$800");
    expect(q).toHaveTextContent("Matched to a transfer to Synthetic Cash on 3 April.");
    expect(q).toHaveTextContent("Did this money leave your TFSAs?");
    expect(q).toHaveTextContent("Taking money out gives the room back on 1 January next year; moving it directly to another TFSA doesn't.");
    expect(q).not.toHaveTextContent("Was it new money?");
    expect(within(q).queryByRole("button", { name: "New money (a contribution)" })).toBeNull();
    expect(within(q).getByRole("button", { name: "Moved to another TFSA" })).toBeInTheDocument();
    fireEvent.click(within(q).getByRole("button", { name: "Taken out (a withdrawal)" }));
    await waitFor(() => expect(api.putRoomActivity).toHaveBeenCalledWith(T1, { effect: "withdrawal" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(after.status).toBe("known");
  });

  it("'Use the automatic match' removes the stored answer; the match applies again", async () => {
    const answered = outMatched({ kind: "none", roomLeftCad: 2000, inferred: undefined, matchedWith: undefined, qualifyingCad: undefined, returnsCad: undefined, returnsOn: undefined, answered: true, automaticMatch: true });
    const rematched = outRoom(outMatched());
    const deleteRoomActivity = vi.fn(async () => rematched);
    const { api, onDone } = mount(outRoom(answered), { initialStep: 4, activityKey: T1, api: { deleteRoomActivity } });
    const q = await screen.findByRole("region", { name: "Transfer on 3 April 2026" });
    expect(q).toHaveTextContent("You answered: moved to another TFSA.");
    fireEvent.click(within(q).getByRole("button", { name: "Use the automatic match" }));
    await waitFor(() => expect(deleteRoomActivity).toHaveBeenCalledWith(T1));
    expect(api.putRoomActivity).not.toHaveBeenCalled();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("an answered row with no automatic match offers 'Clear my answer'; contribution and withdrawal answers say what was answered", async () => {
    const contribution = row({ activityKey: T1, date: "2026-03-03", amountCad: 2500, roomLeftCad: 4500, excessCad: 0, answered: true });
    const deleteRoomActivity = vi.fn(async () => known());
    const { onDone } = mount(known({ ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000), contribution] } }), { initialStep: 4, activityKey: T1, api: { deleteRoomActivity } });
    const q = await screen.findByRole("region", { name: "Transfer on 3 March 2026" });
    expect(q).toHaveTextContent("You answered: new money (a contribution).");
    expect(within(q).queryByRole("button", { name: "Use the automatic match" })).toBeNull();
    fireEvent.click(within(q).getByRole("button", { name: "Clear my answer" }));
    await waitFor(() => expect(deleteRoomActivity).toHaveBeenCalledWith(T1));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    cleanup();

    const withdrawal = outMatched({ inferred: undefined, matchedWith: undefined, answered: true });
    mount(outRoom(withdrawal), { initialStep: 4, activityKey: T1 });
    const w = await screen.findByRole("region", { name: "Transfer on 3 April 2026" });
    expect(w).toHaveTextContent("You answered: taken out (a withdrawal).");
    expect(within(w).getByRole("button", { name: "Clear my answer" })).toBeInTheDocument();
  });

  it("an assumed transfer opens from its edit link, says it is assumed, has nothing to clear, and an answer is stored", async () => {
    const assumed = row({ activityKey: T1, date: "2026-03-03", amountCad: 2500, roomLeftCad: 4500, excessCad: 0, assumed: true });
    const { api, onDone } = mount(known({ ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000), assumed] } }), { initialStep: 4, activityKey: T1 });
    const q = await screen.findByRole("region", { name: "Transfer on 3 March 2026" });
    expect(q).toHaveTextContent("Assumed to be new money (a contribution); you can change this.");
    expect(within(q).queryByRole("button", { name: "Clear my answer" })).toBeNull();
    expect(within(q).queryByRole("button", { name: "Use the automatic match" })).toBeNull();
    fireEvent.click(within(q).getByRole("button", { name: "Moved from another TFSA" }));
    await waitFor(() => expect(api.putRoomActivity).toHaveBeenCalledWith(T1, { effect: "none" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    cleanup();
    const out = row({ kind: "none", activityKey: T2, date: "2026-04-03", amountCad: -800, roomLeftCad: 7000, excessCad: 0, assumed: true });
    mount(known({ ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000), out] } }), { initialStep: 4, activityKey: T2 });
    expect(await screen.findByRole("region", { name: "Transfer on 3 April 2026" })).toHaveTextContent("Assumed to give no room back (moved to another TFSA); you can change this.");
  });

  it("a matched row (nothing stored) keeps 'Use the automatic match'", async () => {
    mount(outRoom(outMatched()), { initialStep: 4, activityKey: T1 });
    const q = await screen.findByRole("region", { name: "Transfer on 3 April 2026" });
    expect(within(q).getByRole("button", { name: "Use the automatic match" })).toBeInTheDocument();
    expect(within(q).queryByRole("button", { name: "Clear my answer" })).toBeNull();
  });

  it("an unanswered outgoing transfer: outgoing wording, its withdrawal outcome first, and no undo", async () => {
    const out = amb(T1, { amountCad: -800, type: "INTERNAL_CASH_TRANSFER_OUT" });
    mount(ambiguous([out], { [T1]: { asWithdrawal: { roomLeftCad: 2000, excessCad: 0 }, asNone: { roomLeftCad: 2000, excessCad: 0 } } }), { initialStep: 4 });
    const q = await screen.findByRole("region", { name: "Unclear transfer on 3 March 2026" });
    expect(q).toHaveTextContent("Did this money leave your TFSAs?");
    expect(within(q).queryByRole("button", { name: "Use the automatic match" })).toBeNull();
    expect(screen.getByText("Room left at the end of the year so far: $2,000 or $2,000")).toBeInTheDocument();
    expect(screen.getByText("The first if it was taken out, the second if it was moved to another TFSA.")).toBeInTheDocument();
  });

  it("a matched transfer is never offered as unclear on its own", async () => {
    const matched = row({ activityKey: T1, date: "2026-03-03", amountCad: 2500, roomLeftCad: 4500, excessCad: 0, inferred: true, matchedWith: { label: "Synthetic Cash", date: "2026-03-02" } });
    mount(known({ ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000), matched] } }), { initialStep: 4 });
    expect(await screen.findByText("No transfers need checking.")).toBeInTheDocument();
  });

  it("an absent outcomes entry shows ? for both", async () => {
    mount(ambiguous([amb(T1)], {}), { initialStep: 4 });
    expect(await screen.findByText("Room left at the end of the year so far: ? or ?")).toBeInTheDocument();
  });
});

describe("RoomSetup flow", () => {
  it("new year: asks only step 1 and writes only the room (the engine carries last year's overrides forward)", async () => {
    const previousAccountSet = { connected: [NEUTRAL], notTfsa: [TFSA], outside: [{ label: "Synthetic Bank" }] };
    const newYear = missing([{ kind: "cra_room" }], { year: 2027, accountSet: null, previousAccountSet, ledger: { rows: [craRow(null)], overSince: null, undatedExcess: false } });
    const { api, onDone } = mount(newYear, { api: { putRoomCra: vi.fn(async () => known({ year: 2027, accountSet: null, previousAccountSet })) } });
    fireEvent.change(await screen.findByLabelText("Contribution room on January 1, 2027"), { target: { value: "7000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.putRoomCra).toHaveBeenCalledWith({ year: 2027, amountCad: 7000 }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(api.putRoomAccounts).not.toHaveBeenCalled();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("new year, step 1 left for later: nothing is written", async () => {
    const newYear = missing([{ kind: "cra_room" }], { year: 2027, accountSet: null, previousAccountSet: { connected: [NEUTRAL], notTfsa: [], outside: [] } });
    const { api, onDone } = mount(newYear);
    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    for (const put of [api.putRoomCra, api.putRoomAccounts]) expect(put).not.toHaveBeenCalled();
  });

  it("new year: step 2 from its edit link starts from last year's overrides (carried forward)", async () => {
    const newYear = missing([{ kind: "cra_room" }], {
      year: 2027, accountSet: null, previousAccountSet: { connected: [NEUTRAL], notTfsa: [TFSA], outside: [{ label: "Synthetic Bank" }] },
    });
    const { api } = mount(newYear, { initialStep: 2 });
    expect(await screen.findByRole("checkbox", { name: /Synthetic Unlabelled/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Synthetic TFSA/ })).not.toBeChecked();
    expect(screen.getByRole("list", { name: "TFSAs at other institutions" })).toHaveTextContent("Synthetic Bank");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.putRoomAccounts).toHaveBeenCalledWith({ year: 2027, connected: [NEUTRAL], notTfsa: [TFSA], outside: [{ label: "Synthetic Bank" }] }));
  });

  it("steps 2, 3 and 4 open only from edit links: each is its own screen and returns to the page", async () => {
    for (const [step, heading, leave] of [[2, "Your TFSAs: add or remove accounts", "Later"], [3, "TFSAs at other institutions", "Later"], [4, "Unclear transfer", "Continue"]] as const) {
      const { onDone } = mount(known(), { initialStep: step });
      expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
      expect(screen.queryByText(/Step \d of/)).toBeNull();
      fireEvent.click(screen.getAllByRole("button", { name: leave })[0]!);
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      cleanup();
    }
  });

  it("an edit link opens a single step that returns to the page after saving", async () => {
    const { api, onDone } = mount(known(), { initialStep: 1 });
    const input = await screen.findByLabelText("Contribution room on January 1, 2026");
    expect(input).toHaveValue(7000);
    expect(screen.queryByText(/Step \d of/)).toBeNull();
    fireEvent.change(input, { target: { value: "7500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.putRoomCra).toHaveBeenCalledWith({ year: 2026, amountCad: 7500 }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("a failed save shows a fixed line and stays on the step", async () => {
    const { onDone } = mount(known(), { initialStep: 1, api: { putRoomCra: vi.fn(async () => { throw new Error("boom <b>"); }) } });
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That change could not be saved.");
    expect(screen.queryByText(/boom/)).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("keyboard: each step's first control receives focus", async () => {
    mount(missing([{ kind: "cra_room" }]));
    await waitFor(() => expect(screen.getByLabelText("Contribution room on January 1, 2026")).toHaveFocus());
    cleanup();
    mount(missing([{ kind: "cra_room" }]), { initialStep: 2 });
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Synthetic TFSA/ })).toHaveFocus());
    cleanup();
    mount(known(), { initialStep: 3 });
    await waitFor(() => expect(screen.getByLabelText("Name of the institution or account")).toHaveFocus());
    cleanup();
    mount(missing([{ kind: "ambiguous", count: 1, rows: [amb(T1)] }]), { initialStep: 4, activityKey: T1 });
    await waitFor(() => expect(screen.getByRole("button", { name: "New money (a contribution)" })).toHaveFocus());
  });

  it("uses no advice language", async () => {
    for (const step of [1, 2, 3, 4] as const) {
      mount(missing([{ kind: "cra_room" }, { kind: "ambiguous", count: 1, rows: [amb(T1)] }]), { initialStep: step });
      await screen.findByRole("heading", { level: 2, name: /Room on|Your TFSAs|other institutions|Unclear transfer/ });
      expect(document.body.textContent).not.toMatch(/\bshould\b|\bconsider\b|you can contribute|we recommend/i);
      cleanup();
    }
  });
});

describe("App wiring", () => {
  const auth = { isLoading: false, isAuthenticated: true, userName: "Synthetic", login: async () => undefined, logout: () => undefined };
  const base = { getPortfolio: async () => ({ connectionRequired: false, generatedAt: "2026-10-24T20:00:00.000Z", totals: [], accounts: [], errors: [] }), getConnections: async () => [], createConnectionSession: async () => ({ portalUrl: "https://x.invalid" }) };
  it("an edit link on the room page opens that step alone and returns to the page", async () => {
    window.history.replaceState(null, "", "/?view=room");
    const room = known();
    const api = { ...base, getTfsaRoom: vi.fn(async () => room), putRoomCra: vi.fn(async () => room) };
    render(<PortfolioExperience auth={auth} api={api as never} />);
    const first = (await screen.findAllByTestId("ledger-row"))[0]!;
    fireEvent.click(within(first).getByRole("button", { name: "Edit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.putRoomCra).toHaveBeenCalled());
    expect(await screen.findByRole("heading", { name: "Contribution room", level: 1 })).toBeInTheDocument();
    window.history.replaceState(null, "", "/");
  });

  it("an answered transfer's edit link on the room page opens step 4 on it", async () => {
    window.history.replaceState(null, "", "/?view=room");
    const room = known({ ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000), row({ kind: "none", activityKey: T1, date: "2026-03-03", amountCad: 2500, roomLeftCad: 7000, excessCad: 0, answered: true })] } });
    const api = { ...base, getTfsaRoom: vi.fn(async () => room), putRoomActivity: vi.fn(async () => room) };
    render(<PortfolioExperience auth={auth} api={api as never} />);
    const rows = await screen.findAllByTestId("ledger-row");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Edit" }));
    expect(await screen.findByText("You answered: moved from another TFSA.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Moved from another TFSA" }));
    await waitFor(() => expect(api.putRoomActivity).toHaveBeenCalledWith(T1, { effect: "none" }));
    expect(await screen.findByRole("heading", { name: "Contribution room", level: 1 })).toBeInTheDocument();
    window.history.replaceState(null, "", "/");
  });

  it("the missing state offers the setup: step 1 alone, then back to the page", async () => {
    window.history.replaceState(null, "", "/?view=room");
    const after = known();
    const api = { ...base, getTfsaRoom: vi.fn(async () => missing([{ kind: "cra_room" }])), putRoomCra: vi.fn(async () => after) };
    render(<PortfolioExperience auth={auth} api={api as never} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start setup" }));
    fireEvent.change(await screen.findByLabelText("Contribution room on January 1, 2026"), { target: { value: "7000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.putRoomCra).toHaveBeenCalledWith({ year: 2026, amountCad: 7000 }));
    expect(await screen.findByRole("heading", { name: "Contribution room", level: 1 })).toBeInTheDocument();
    window.history.replaceState(null, "", "/");
  });

  it("an unclear row's Answer link on the room page opens step 4 on that row", async () => {
    window.history.replaceState(null, "", "/?view=room");
    const room = missing([{ kind: "ambiguous", count: 2, rows: [amb(T1), amb(T2, { date: "2026-06-01" })] }], {
      ledger: { overSince: null, undatedExcess: false, rows: [craRow(7000), row({ kind: "ambiguous", activityKey: T1, date: "2026-03-03" }), row({ kind: "ambiguous", activityKey: T2, date: "2026-06-01" })] },
    });
    const api = { ...base, getTfsaRoom: vi.fn(async () => room) };
    render(<PortfolioExperience auth={auth} api={api as never} />);
    const rows = await screen.findAllByTestId("ledger-row");
    fireEvent.click(within(rows[2]!).getByRole("button", { name: "Answer" }));
    expect(await screen.findByRole("region", { name: "Unclear transfer on 1 June 2026" })).toBeInTheDocument();
    window.history.replaceState(null, "", "/");
  });
});
