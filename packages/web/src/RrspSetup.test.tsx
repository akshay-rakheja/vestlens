// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LedgerRowView, RrspRoomView, RrspYearView } from "./apiErrors";
import { RrspSetup } from "./RrspSetup";

// Synthetic amounts and labels only.
const noFx = { contributions: { estimated: false, rateDates: [], native: [] }, withdrawals: { estimated: false, rateDates: [], native: [] } };
const row = (over: Partial<LedgerRowView>): LedgerRowView => ({
  date: "2026-04-01", kind: "contribution", label: "Synthetic RRSP", amountCad: 4000, estimated: false, rateDate: null, native: null,
  roomLeftCad: null, excessCad: null, wentOver: false, ...over,
});
const year = (over: Partial<RrspYearView> = {}): RrspYearView => ({
  window: { taxYear: 2026, from: "2026-03-03", to: null }, contributedCad: 4000, limitCad: null, unusedCad: null, elsewhereCad: null,
  roomLeftCad: null, overLimitCad: null, estimated: false, missing: [{ kind: "deduction_limit" }], fx: noFx, fxDates: [], basis: [],
  ledger: { overSince: null, undatedExcess: false, rows: [row({ date: "2026-03-03", kind: "cra_room", label: "RRSP deduction limit less unused contributions (you entered)", amountCad: null }), row({})] },
  ...over,
});
const shown = (y: RrspYearView = year()): RrspRoomView => ({
  status: "shown", activityAsOf: null, accounts: [{ accountKey: "r".repeat(64), label: "Synthetic RRSP", maskedNumber: null, value: null, managed: false, closed: false }],
  years: [{ ...y, window: { taxYear: 2025, from: "2025-03-04", to: "2026-03-02" } }, y],
});

afterEach(cleanup);

describe("RrspSetup: one tax year's figures", () => {
  it("names where each CRA figure is, refuses a negative amount, then PUTs the limit for the year it was opened from", async () => {
    const putRrspLimit = vi.fn(async () => shown(year({ limitCad: 10000, missing: [] })));
    const putRrspElsewhere = vi.fn(async () => shown());
    const onDone = vi.fn();
    render(<RrspSetup api={{ getRrspRoom: async () => shown(), putRrspLimit, putRrspElsewhere } as never} year={2026} onDone={onDone} />);
    expect(await screen.findByRole("heading", { name: "RRSP figures for 2026" })).toBeInTheDocument();
    expect(document.body.textContent).toContain("CRA My Account or your notice of assessment");
    const limit = screen.getByLabelText("RRSP deduction limit for 2026");
    expect(limit).toHaveFocus();
    expect(screen.getByLabelText("Unused RRSP contributions")).toHaveValue(null);
    expect(screen.getByLabelText("Contributions not in VestLens for the 2026 tax year")).toHaveValue(null);
    fireEvent.change(limit, { target: { value: "-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter each figure as a dollar amount, 0 or more.");
    expect(putRrspLimit).not.toHaveBeenCalled();
    fireEvent.change(limit, { target: { value: "10000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(putRrspLimit).toHaveBeenCalledWith({ year: 2026, amountCad: 10000 });
    expect(putRrspElsewhere).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/\b(should|consider|we recommend|you can contribute)\b/i);
  });

  it("says the limit alone shows contributions, room left needs all three and 0 counts; elsewhere names a spousal RRSP", async () => {
    render(<RrspSetup api={{ getRrspRoom: async () => shown() } as never} year={2026} onDone={() => undefined} />);
    await screen.findByRole("heading", { name: "RRSP figures for 2026" });
    expect(document.body.textContent).toContain("The limit alone shows your contributions; room left needs all three, and 0 counts.");
    expect(document.body.textContent).not.toContain("Each is optional");
    expect(screen.getByLabelText("Unused RRSP contributions")).toHaveAccessibleDescription(/^Needed for room left\..*0 counts\.$/);
    expect(screen.getByLabelText("Contributions not in VestLens for the 2026 tax year")).toHaveAccessibleDescription(
      "Needed for room left. Contributions to RRSPs VestLens can't see, such as a group RRSP at work, a managed portfolio or a spousal RRSP you contributed to for your spouse, from your RRSP contribution receipts. 0 counts.",
    );
  });

  it("the preview chart of a year with an unpublished deadline ends on the Toronto date, not the UTC one", async () => {
    // 22:00 on 29 October in Toronto is already 30 October in UTC.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T02:00:00.000Z"));
    try {
      const known = year({
        limitCad: 10000, unusedCad: 0, elsewhereCad: 0, roomLeftCad: 6000, overLimitCad: 0, missing: [],
        ledger: { overSince: null, undatedExcess: false, rows: [
          row({ date: "2026-03-03", kind: "cra_room", label: "RRSP deduction limit less unused contributions (you entered)", amountCad: 10000, roomLeftCad: 10000 }),
          row({ roomLeftCad: 6000, excessCad: 0 }),
        ] },
      });
      render(<RrspSetup api={{ getRrspRoom: async () => shown(known) } as never} year={2026} onDone={() => undefined} />);
      const chart = await screen.findByRole("img");
      expect(chart).toHaveTextContent("29 Oct 2026");
      expect(chart).not.toHaveTextContent("30 Oct 2026");
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves the unused contributions with the limit, and contributions not in VestLens (0 is a figure) on their own route", async () => {
    const putRrspLimit = vi.fn(async () => shown());
    const putRrspElsewhere = vi.fn(async () => shown());
    const onDone = vi.fn();
    render(<RrspSetup api={{ getRrspRoom: async () => shown(), putRrspLimit, putRrspElsewhere } as never} year={2025} onDone={onDone} />);
    fireEvent.change(await screen.findByLabelText("RRSP deduction limit for 2025"), { target: { value: "18000" } });
    fireEvent.change(screen.getByLabelText("Unused RRSP contributions"), { target: { value: "1200.50" } });
    fireEvent.change(screen.getByLabelText("Contributions not in VestLens for the 2025 tax year"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(putRrspLimit).toHaveBeenCalledWith({ year: 2025, amountCad: 18000, unusedCad: 1200.5 });
    expect(putRrspElsewhere).toHaveBeenCalledWith({ year: 2025, amountCad: 0 });
  });

  it("only contributions not in VestLens: no limit write; unused contributions alone are refused", async () => {
    const putRrspLimit = vi.fn(async () => shown());
    const putRrspElsewhere = vi.fn(async () => shown());
    const onDone = vi.fn();
    render(<RrspSetup api={{ getRrspRoom: async () => shown(), putRrspLimit, putRrspElsewhere } as never} year={2026} onDone={onDone} />);
    fireEvent.change(await screen.findByLabelText("Unused RRSP contributions"), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the deduction limit with the unused contributions; CRA shows them together.");
    fireEvent.change(screen.getByLabelText("Unused RRSP contributions"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Contributions not in VestLens for the 2026 tax year"), { target: { value: "2500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(putRrspElsewhere).toHaveBeenCalledWith({ year: 2026, amountCad: 2500 });
    expect(putRrspLimit).not.toHaveBeenCalled();
  });

  it("pre-fills saved figures; saving them unchanged writes nothing, and Later writes nothing", async () => {
    const putRrspLimit = vi.fn(async () => shown());
    const putRrspElsewhere = vi.fn(async () => shown());
    const onDone = vi.fn();
    const saved = year({ limitCad: 10000, unusedCad: 500, elsewhereCad: 0, missing: [] });
    render(<RrspSetup api={{ getRrspRoom: async () => shown(saved), putRrspLimit, putRrspElsewhere } as never} year={2026} onDone={onDone} />);
    expect(await screen.findByLabelText("RRSP deduction limit for 2026")).toHaveValue(10000);
    expect(screen.getByLabelText("Unused RRSP contributions")).toHaveValue(500);
    expect(screen.getByLabelText("Contributions not in VestLens for the 2026 tax year")).toHaveValue(0);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(onDone).toHaveBeenCalledTimes(2);
    expect(putRrspLimit).not.toHaveBeenCalled();
    expect(putRrspElsewhere).not.toHaveBeenCalled();
  });

  it("a failed save keeps the form with a fixed line; a missing year or a failed read is a fixed line", async () => {
    const onDone = vi.fn();
    render(<RrspSetup api={{ getRrspRoom: async () => shown(), putRrspLimit: async () => { throw new Error("boom <b>"); } } as never} year={2026} onDone={onDone} />);
    fireEvent.change(await screen.findByLabelText("RRSP deduction limit for 2026"), { target: { value: "10000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That change could not be saved.");
    expect(onDone).not.toHaveBeenCalled();
    cleanup();
    render(<RrspSetup api={{ getRrspRoom: async () => shown() } as never} year={2024} onDone={onDone} />);
    expect(await screen.findByText("RRSP setup is unavailable right now.")).toBeInTheDocument();
    cleanup();
    render(<RrspSetup api={{ getRrspRoom: async () => { throw new Error("boom"); } } as never} year={2026} onDone={onDone} />);
    expect(await screen.findByText("RRSP setup is unavailable right now.")).toBeInTheDocument();
  });
});

describe("RrspSetup: step 4 on one RRSP transfer", () => {
  const UNCLEAR = "5".repeat(16);
  const MATCHED = "6".repeat(16);
  const withTransfers = year({
    missing: [{ kind: "deduction_limit" }, { kind: "ambiguous", count: 1, rows: [{ activityKey: UNCLEAR, date: "2026-05-01", amountCad: 700, estimated: false, rateDate: null, native: null, type: "TRANSFER_IN", label: "Synthetic RRSP" }] }],
    ledger: { overSince: null, undatedExcess: false, rows: [
      row({ date: "2026-03-03", kind: "cra_room", label: "RRSP deduction limit less unused contributions (you entered)", amountCad: null }),
      row({ date: "2026-04-01", amountCad: -900, kind: "none", matchedWith: { label: "Synthetic FHSA", date: "2026-04-01" }, inferred: true, activityKey: MATCHED }),
      row({ date: "2026-05-01", kind: "ambiguous", amountCad: 700, activityKey: UNCLEAR }),
    ] },
  });

  it("an unclear transfer in: the RRSP question and answers; an answer PUTs { effect } to the RRSP route", async () => {
    const putRrspRoomActivity = vi.fn(async () => shown());
    const onDone = vi.fn();
    render(<RrspSetup api={{ getRrspRoom: async () => shown(withTransfers), putRrspRoomActivity } as never} year={2026} step={4} onDone={onDone} />);
    const step = await screen.findByRole("region", { name: "Unclear transfer on 1 May 2026" });
    expect(step).toHaveTextContent("Was it new money?");
    expect(step).toHaveTextContent("New money counts against your RRSP deduction room; money moved directly from another of your RRSPs or from your FHSA doesn't.");
    expect(within(step).getAllByRole("button").map((b) => b.textContent)).toEqual(["New money (a contribution)", "Moved from another RRSP", "Moved from my FHSA", "Later"]);
    expect(within(step).getByRole("button", { name: "New money (a contribution)" })).toHaveFocus();
    fireEvent.click(within(step).getByRole("button", { name: "New money (a contribution)" }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(putRrspRoomActivity).toHaveBeenCalledWith(UNCLEAR, { effect: "contribution" });
    expect(document.body.textContent).not.toMatch(/\bTFSA\b|\b(should|consider|we recommend)\b|dashboard doesn't take it yet/);
  });

  it("a matched transfer out: the match line, the RRSP answers, and Use the automatic match calls DELETE", async () => {
    const putRrspRoomActivity = vi.fn(async () => shown(withTransfers));
    const deleteRrspRoomActivity = vi.fn(async () => shown(withTransfers));
    const onDone = vi.fn();
    render(<RrspSetup api={{ getRrspRoom: async () => shown(withTransfers), putRrspRoomActivity, deleteRrspRoomActivity } as never} year={2026} step={4} activityKey={MATCHED} onDone={onDone} />);
    const step = await screen.findByRole("region", { name: "Transfer on 1 April 2026" });
    expect(step).toHaveTextContent("Matched to a transfer to Synthetic FHSA on 1 April.");
    expect(step).toHaveTextContent("Did this money leave your RRSPs?");
    expect(step).toHaveTextContent("Taking money out never gives RRSP deduction room back; moving it directly to another RRSP or to your FHSA has no effect on it.");
    expect(within(step).getAllByRole("button").map((b) => b.textContent).slice(0, 3)).toEqual(["Taken out (a withdrawal)", "Moved to another RRSP", "Moved to my FHSA"]);
    fireEvent.click(within(step).getByRole("button", { name: "Taken out (a withdrawal)" }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(putRrspRoomActivity).toHaveBeenCalledWith(MATCHED, { effect: "withdrawal" });
    fireEvent.click(within(step).getByRole("button", { name: "Use the automatic match" }));
    await vi.waitFor(() => expect(deleteRrspRoomActivity).toHaveBeenCalledWith(MATCHED));
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it("with nothing to answer, step 4 says so", async () => {
    const onDone = vi.fn();
    render(<RrspSetup api={{ getRrspRoom: async () => shown() } as never} year={2026} step={4} onDone={onDone} />);
    expect(await screen.findByText("No transfers need checking.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onDone).toHaveBeenCalled();
  });
});
