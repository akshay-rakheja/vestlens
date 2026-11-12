import { act, cleanup, render, screen, within } from "@testing-library/preact";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { TfsaRoom } from "./TfsaRoom";
import type { RoomPayload } from "./types";

const noFx = { estimated: false, rateDates: [], native: [] };
const base = { year: 2026, withdrawnCad: 0, basis: ["CRA room of $7,000 you stated", "2 contributions this year"], fxDates: [], fx: { contributions: noFx, withdrawals: noFx }, accounts: [], context: { facts: [] } };
const known = (over: Record<string, unknown> = {}): RoomPayload => ({ ...base, status: "known", roomLeftCad: 1500, contributedCad: 5500, craRoomCad: 7000, estimated: false, overLimitCad: 0, ...over }) as RoomPayload;
const missing = (items: unknown[], over: Record<string, unknown> = {}): RoomPayload => ({ ...base, status: "missing", missing: items, ...over }) as RoomPayload;

function fakeBridge() {
  let listener: (r: ToolResult) => void = () => {};
  const bridge: Bridge = {
    ready: Promise.resolve({ hostTools: true, context: {} }),
    onToolResult: (fn) => { listener = fn; return () => {}; },
    onContext: () => () => {}, toolArguments: () => ({}), openLink: async () => true,
    callTool: vi.fn(async () => ({ structuredContent: known() })), sendMessage: vi.fn(async () => {}), updateModelContext: vi.fn(async () => {}), destroy: () => {},
  };
  return { bridge, push: (p: unknown) => listener({ structuredContent: p }) };
}
async function open(p: RoomPayload) {
  const f = fakeBridge();
  render(<TfsaRoom bridge={f.bridge} />);
  expect(screen.getByText(/loading/i)).toBeInTheDocument();
  act(() => f.push(p));
  await screen.findByRole("region", { name: "TFSA room" });
  return f;
}
afterEach(cleanup);

test("known: headline, bar, no withdrawal line", async () => {
  await open(known());
  expect(screen.getByText("About $1,500 of TFSA room left this year")).toBeInTheDocument();
  const bar = screen.getByRole("img", { name: "Used $5,500 of $7,000 CRA room this year" });
  expect(bar).toBeInTheDocument();
  expect(screen.queryByText(/withdrew/)).toBeNull();
  expect(screen.queryByText(/over/i)).toBeNull();
});

test("known with a managed TFSA not counted: the number stands and the line says what isn't in it", async () => {
  await open(known({ notCounted: [{ accountKey: "4".repeat(16), label: "Wealthsimple TFSA ••Cs5Q" }, { accountKey: "5".repeat(16), label: "Wealthsimple TFSA ••KgtA" }] }));
  expect(screen.getByText("About $1,500 of TFSA room left this year")).toBeInTheDocument();
  expect(screen.getByText("Not counted: Wealthsimple TFSA ••Cs5Q and ••KgtA. Contributions to them aren't visible through SnapTrade. If you contributed to them this year, your room is lower than this.")).toBeInTheDocument();
  cleanup();
  await open(known({ overLimitCad: 500, roomLeftCad: -500, notCounted: [{ accountKey: "4".repeat(16), label: "Managed TFSA" }] }));
  expect(screen.getByText(/the amount over is higher than this\./)).toBeInTheDocument();
  cleanup();
  // A payload without it, or with something unexpected, shows the number and no line.
  for (const notCounted of [undefined, null, "x", []]) {
    await open(known({ notCounted }));
    expect(screen.getByText("About $1,500 of TFSA room left this year")).toBeInTheDocument();
    expect(screen.queryByText(/Not counted/)).toBeNull();
    cleanup();
  }
});

test("known with a carried outside TFSA: the headline basis sits under the headline", async () => {
  await open(known({ headlineBasis: "Based on your connected TFSAs and what you entered" }));
  const basis = screen.getByText("Based on your connected TFSAs and what you entered");
  expect(basis.previousElementSibling?.textContent).toBe("About $1,500 of TFSA room left this year");
  cleanup();
  await open(known());
  expect(screen.queryByText("Based on your connected TFSAs and what you entered")).toBeNull();
});

test("known estimated: headline carries (est.) and the Bank of Canada range", async () => {
  await open(known({ estimated: true, fx: { contributions: { estimated: true, rateDates: ["2026-03-02", "2026-06-01"], native: [{ amount: 1500, currency: "USD" }] }, withdrawals: noFx }, fxDates: ["2026-03-02", "2026-06-01"] }));
  expect(screen.getByText("About $1,500 of TFSA room left this year")).toBeInTheDocument();
  expect(document.body.textContent!.match(/est\./g)).toHaveLength(1);
  expect(screen.getByText(/est\.; includes US\$1,500 converted at Bank of Canada rates from 2026-03-02–2026-06-01/)).toBeInTheDocument();
});

test("estimated without a converted-row note: the headline carries (est.) once", async () => {
  await open(known({ estimated: true }));
  expect(screen.getByText("About $1,500 of TFSA room left this year (est.)")).toBeInTheDocument();
  expect(document.body.textContent!.match(/est\./g)).toHaveLength(1);
});

test("over the limit with converted rows: amount, fx note once, attention bar", async () => {
  await open(known({ roomLeftCad: -350, contributedCad: 7350, overLimitCad: 350, estimated: true, fx: { contributions: { estimated: true, rateDates: ["2026-03-02"], native: [{ amount: 1000, currency: "USD" }] }, withdrawals: noFx } }));
  expect(screen.getByText("About $350 over your TFSA room this year")).toBeInTheDocument();
  expect(screen.getByText("(est.; includes US$1,000 converted at the Bank of Canada rate of 2026-03-02)")).toBeInTheDocument();
  expect(document.body.textContent!.match(/est\./g)).toHaveLength(1);
  expect(screen.getByRole("img", { name: "Used $7,350 of $7,000 CRA room this year" }).className).toContain("over");
});

test("known with broker-rate conversion shows the native amount and no est.", async () => {
  await open(known({ fx: { contributions: { estimated: false, rateDates: [], native: [{ amount: 1000, currency: "USD" }] }, withdrawals: noFx } }));
  expect(screen.getByText(/includes US\$1,000 converted at the broker's rate/)).toBeInTheDocument();
  expect(screen.queryByText(/est\./)).toBeNull();
});

test("withdrawal line is verbatim, with converted total; over-contribution only when the room left is less than the withdrawal (B4)", async () => {
  // Room left 1,500 covers re-depositing $1,350: not an over-contribution.
  await open(known({ withdrawnCad: 1350, fx: { contributions: noFx, withdrawals: { estimated: true, rateDates: ["2026-03-02"], native: [{ amount: 1000, currency: "USD" }] } } }));
  expect(screen.getByText("You withdrew $1,350 (est.; includes US$1,000 converted at the Bank of Canada rate of 2026-03-02) this year. That room comes back on 1 January 2027. Putting it back before then would count as a new contribution against your remaining room.")).toBeInTheDocument();
  cleanup();
  await open(known({ withdrawnCad: 1350, roomLeftCad: 150, fx: { contributions: noFx, withdrawals: { estimated: true, rateDates: ["2026-03-02"], native: [{ amount: 1000, currency: "USD" }] } } }));
  expect(screen.getByText("You withdrew $1,350 (est.; includes US$1,000 converted at the Bank of Canada rate of 2026-03-02) this year. That room comes back on 1 January 2027. Putting it back before then would be an over-contribution.")).toBeInTheDocument();
});

test("over the limit: says about $X over, in the attention colour", async () => {
  await open(known({ roomLeftCad: -250, contributedCad: 7250, overLimitCad: 250 }));
  expect(screen.getByText("About $250 over your TFSA room this year")).toBeInTheDocument();
  expect(screen.queryByText(/room left/)).toBeNull();
  expect(screen.getByRole("img", { name: "Used $7,250 of $7,000 CRA room this year" }).className).toContain("over");
});

test("missing: lead-in and a plain checklist, nothing interactive", async () => {
  await open(missing([
    { kind: "cra_room" },
    { kind: "coverage", label: "TFSA 1", accountKey: "a3" }, { kind: "outside_contributions", label: "Bank TFSA", accountKey: "outside:bank" },
  ]));
  expect(screen.getByText("I can't give a number yet:")).toBeInTheDocument();
  expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(3);
  expect(screen.getByText(/room on 1 January 2026/)).toBeInTheDocument();
  expect(screen.getByText(/TFSA 1/)).toBeInTheDocument();
  expect(screen.getByText(/Bank TFSA/)).toBeInTheDocument();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
});

test("missing: ambiguous rows show date, amount with est. formatting, type and account", async () => {
  await open(missing([{ kind: "ambiguous", count: 7, rows: [
    { activityKey: "k1", date: "2026-03-03", amountCad: 1350, estimated: true, rateDate: "2026-03-02", native: { amount: 1000, currency: "USD" }, type: "INTERNAL_CASH_TRANSFER_IN", label: "TFSA 1" },
    { activityKey: "k2", date: "2026-04-01", amountCad: 5000, estimated: false, rateDate: null, native: { amount: 5000, currency: "CAD" }, type: "TRANSFER_OUT", label: "TFSA 1" },
    { activityKey: "k3", date: "unknown", amountCad: null, estimated: false, rateDate: null, native: null, type: "UNKNOWN", label: "TFSA 2" },
  ] }], { withdrawnCad: 0 }));
  expect(screen.getByText(/2026-03-03/)).toBeInTheDocument();
  expect(screen.getByText(/\$1,350 \(est\., BoC 2026-03-02; US\$1,000\)/)).toBeInTheDocument();
  expect(screen.getByText(/\$5,000/)).toBeInTheDocument();
  expect(screen.getByText(/internal cash transfer in/i)).toBeInTheDocument();
  expect(screen.getByText(/unknown date/i)).toBeInTheDocument();
  expect(screen.getByText(/amount not known in CAD/)).toBeInTheDocument();
  expect(screen.getByText(/4 more need checking/)).toBeInTheDocument();
});

test("missing: shares moved in kind with no price say so and say the way out (review 3)", async () => {
  await open(missing([{ kind: "ambiguous", count: 1, rows: [
    { activityKey: "k4", date: "2026-03-15", amountCad: null, estimated: false, rateDate: null, native: null, type: "TRANSFER", label: "TFSA 1", inKind: true, accountKey: "1".repeat(16) },
  ] }], { withdrawnCad: 0 }));
  expect(screen.getByText("shares moved in kind, no price or close found")).toBeInTheDocument();
  expect(screen.getByText(/Give what you have contributed to TFSA 1 this year as of a date on or after 2026-03-15, these shares at their value that day included, and don't include amounts already entered elsewhere/)).toBeInTheDocument();
  expect(screen.queryByText(/amount not known in CAD/)).toBeNull();
});

test("missing also shows a withdrawal line when there were withdrawals", async () => {
  await open(missing([{ kind: "cra_room" }], { withdrawnCad: 2000 }));
  expect(screen.getByText(/You withdrew \$2,000 this year\. Some or all of that room comes back on 1 January 2027;/)).toBeInTheDocument();
});

test("a known number keeps the inputs list off the card; a missing state still shows it", async () => {
  await open(known());
  expect(screen.queryByText("Based on")).toBeNull();
  expect(screen.queryByText("CRA room of $7,000 you stated")).toBeNull();
  cleanup();
  await open(missing([{ kind: "cra_room" }]));
  expect(screen.getByText("Based on")).toBeInTheDocument();
  expect(screen.getByText("CRA room of $7,000 you stated")).toBeInTheDocument();
});

test("every string renders as text: HTML and markdown links stay literal", async () => {
  await open(missing([{ kind: "cra_room" }], { basis: ["note: <b>x</b> and [a](b)"] }));
  expect(screen.getByText("note: <b>x</b> and [a](b)")).toBeInTheDocument();
  expect(document.querySelectorAll("b:not(.w-brand b)").length).toBe(0);
  expect(document.querySelector("a")).toBeNull();
  cleanup();
  await open(missing([{ kind: "coverage", label: "<b>x</b> [a](b)", accountKey: "k" }, { kind: "ambiguous", count: 1, rows: [{ activityKey: "k", date: "2026-01-02", amountCad: 10, estimated: false, rateDate: null, native: null, type: "<i>t</i>", label: "<b>L</b>" }] }]));
  expect(screen.getByText(/<b>x<\/b> \[a\]\(b\)/)).toBeInTheDocument();
  expect(screen.getByText(/<b>L<\/b>/)).toBeInTheDocument();
  expect(document.querySelector("a")).toBeNull();
  expect(document.querySelectorAll("b:not(.w-brand b), i").length).toBe(0);
});

test("no advice copy anywhere", async () => {
  for (const p of [known({ withdrawnCad: 100 }), known({ roomLeftCad: -5, overLimitCad: 5, contributedCad: 7005 }), missing([{ kind: "cra_room" }, { kind: "ambiguous", count: 1, rows: [] }])]) {
    await open(p);
    expect(document.body.textContent).not.toMatch(/\b(should|buy|sell)\b/i);
    cleanup();
  }
});

test("a failed or malformed result shows a calm message, not numbers", async () => {
  const f = fakeBridge();
  render(<TfsaRoom bridge={f.bridge} />);
  act(() => f.push({ nope: true }));
  expect(await screen.findByText(/TFSA room unavailable right now/)).toBeInTheDocument();
});

test("known: says how current the activity is, in Toronto time", async () => {
  await open(known({ activityAsOf: "2026-10-24T08:00:00.000Z" }));
  expect(screen.getByText("Based on activity up to 24 October 2026; deposits made since then aren't included")).toBeInTheDocument();
});

test("known without activityAsOf (outside accounts only): no as-of line", async () => {
  await open(known({ activityAsOf: null }));
  expect(screen.queryByText(/Based on activity up to/)).toBeNull();
});

test("missing: stale activity, a disconnected TFSA and a managed TFSA are listed as text", async () => {
  await open(missing([
    { kind: "stale_activity", accountKey: "1111111111111111", label: "Main TFSA", lastSyncedAt: "2026-10-22T15:00:00.000Z" },
    { kind: "stale_activity", accountKey: "2222222222222222", label: "Other TFSA", lastSyncedAt: null },
    { kind: "disconnected_account", accountKey: "3333333333333333" },
    { kind: "managed_account", accountKey: "4444444444444444", label: "Managed TFSA" },
  ]));
  expect(screen.getByText("Main TFSA's activity was last updated 22 October 2026, 11:00 a.m. Toronto time; there'll be a number after it refreshes")).toBeInTheDocument();
  expect(screen.getByText("Other TFSA's activity hasn't been loaded yet; there'll be a number after it refreshes")).toBeInTheDocument();
  expect(screen.getByText("What you contributed this year to a TFSA you confirmed that is no longer connected (key 3333333333333333)")).toBeInTheDocument();
  // The same words as the dashboard's line (A9).
  expect(screen.getByText("What you have contributed to Managed TFSA this year, and as of what date (contributions to it aren't visible through SnapTrade). Don't include amounts already entered elsewhere.")).toBeInTheDocument();
});

test("tolerates the memory block on the result (structuredContent.memory) and doesn't render it", async () => {
  await open({ ...known(), memory: { facts: [{ id: "synthetic-id", node: { type: "goal", key: "house" }, property: "goal.target_date", text: "Saving for a house in 2028.", kind: "plan", provenance: "stated", ageDays: 3 }] } } as unknown as RoomPayload);
  expect(screen.getByText("About $1,500 of TFSA room left this year")).toBeInTheDocument();
  expect(screen.queryByText(/house/)).toBeNull();
});

const lrow = (o: Record<string, unknown>) => ({ date: "2026-03-14", kind: "contribution", label: "Synthetic TFSA", amountCad: 5000, estimated: false, rateDate: null, native: null, roomLeftCad: -4000, excessCad: 4000, wentOver: false, ...o });
const URL_ROOM = "https://app.example.test/?view=room";
const ledgerOver = (rows: unknown[]) => known({
  roomLeftCad: -4000, contributedCad: 11000, overLimitCad: 4000, dashboardUrl: URL_ROOM, activityAsOf: "2026-10-24T08:00:00.000Z",
  ledger: { rows, overSince: "2026-03-14", undatedExcess: false },
});

test("ledger: over-since headline, the went-over row, freshness label and chart text", async () => {
  await open(ledgerOver([
    lrow({ date: "2026-01-01", kind: "cra_room", label: "CRA", amountCad: 7000, roomLeftCad: 7000, excessCad: 0 }),
    lrow({ wentOver: true, label: "<b>Synthetic</b> TFSA" }),
    lrow({ date: "2026-05-01", kind: "withdrawal", amountCad: -500, roomLeftCad: -4000, returnsOn: "2027-01-01" }),
    lrow({ date: "2026-06-01", kind: "contribution", amountCad: 0, roomLeftCad: -4000 }),
    lrow({ date: "2026-07-01", kind: "none", amountCad: 0, roomLeftCad: -4000 }),
  ]));
  expect(screen.getByText("About $4,000 over your TFSA room since 14 March")).toBeInTheDocument();
  expect(screen.getByText(/This went over by \$4,000/)).toBeInTheDocument();
  expect(screen.getByText(/<b>Synthetic<\/b> TFSA/)).toBeInTheDocument();
  expect(screen.getByText("Based on activity up to 24 October 2026; deposits made since then aren't included")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /started at \$7,000, ended over by \$4,000 since 14 March/ })).toBeInTheDocument();
  expect(screen.getAllByRole("listitem").filter((li) => li.closest(".tr-ledger"))).toHaveLength(3);
});

test("ledger: a matched transfer says what it was matched to, after its kind text", async () => {
  await open(ledgerOver([
    lrow({ date: "2026-02-01", label: "In TFSA", amountCad: 1000, roomLeftCad: 6000, excessCad: 0, inferred: true, matchedWith: { label: "Synthetic Cash", date: "2026-01-31" } }),
    lrow({ date: "2026-03-01", kind: "withdrawal", label: "Out TFSA", amountCad: -500, qualifyingCad: 0, returnsCad: 500, returnsOn: "2027-01-01", inferred: true, matchedWith: { label: "Synthetic Cash", date: "2026-03-02" } }),
    lrow({ date: "2026-04-01", kind: "none", label: "Moved TFSA", amountCad: 300, inferred: true, matchedWith: { label: "Synthetic second TFSA", date: "2026-04-01" }, wentOver: true }),
  ]));
  const move = (kind: string) => screen.getByText(kind).closest("li")!;
  expect(move("In TFSA contribution")).toHaveTextContent("Matched to a transfer from Synthetic Cash on 31 January");
  expect(move("Out TFSA withdrawal")).toHaveTextContent("This room comes back on 1 January 2027, not now; matched to a transfer to Synthetic Cash on 2 March");
  expect(move("Moved TFSA transfer")).toHaveTextContent("Moved from another TFSA, no effect on room; matched to a transfer from Synthetic second TFSA on 1 April");
});

test("ledger: an assumed transfer says it is assumed", async () => {
  await open(ledgerOver([lrow({ date: "2026-04-01", label: "In TFSA", amountCad: 300, assumed: true, wentOver: true })]));
  expect(screen.getByText("In TFSA contribution").closest("li")).toHaveTextContent("Assumed; you can change this");
});

test("ledger: the outgoing side of a move between TFSAs reads 'moved to another TFSA'", async () => {
  await open(ledgerOver([
    lrow({ date: "2026-04-01", kind: "none", label: "Out TFSA", amountCad: -300, inferred: true, matchedWith: { label: "In TFSA", date: "2026-04-01" }, wentOver: true }),
  ]));
  expect(screen.getByText("Out TFSA transfer").closest("li")).toHaveTextContent("Moved to another TFSA, no effect on room; matched to a transfer to In TFSA on 1 April");
});

test("ledger: a withdrawal row says its room comes back next 1 January", async () => {
  await open(ledgerOver([lrow({ kind: "withdrawal", amountCad: -500, qualifyingCad: 0, returnsCad: 500, returnsOn: "2027-01-01", wentOver: true })]));
  expect(screen.getByText(/This room comes back on 1 January 2027, not now/)).toBeInTheDocument();
});

test("ledger: a qualifying withdrawal reduced the amount over; a mixed one says both; no clause without a date", async () => {
  await open(ledgerOver([
    lrow({ date: "2026-02-01", kind: "withdrawal", label: "Q TFSA", amountCad: -2000, qualifyingCad: 2000, returnsCad: 0 }),
    lrow({ date: "2026-03-01", kind: "withdrawal", label: "M TFSA", amountCad: -3000, qualifyingCad: 1000, returnsCad: 2000, returnsOn: "2027-01-01" }),
    lrow({ date: "2026-04-01", kind: "withdrawal", label: "D TFSA", amountCad: -500, qualifyingCad: 0, returnsCad: 500, wentOver: true }),
  ]));
  const move = (kind: string) => screen.getByText(kind).closest("li")!;
  expect(within(move("Q TFSA withdrawal")).getByText("This reduced the amount over by $2,000")).toBeInTheDocument();
  expect(within(move("M TFSA withdrawal")).getByText("This reduced the amount over by $1,000; the other $2,000 comes back on 1 January 2027, not now")).toBeInTheDocument();
  expect(move("D TFSA withdrawal").querySelector(".tr-mv-note")).toBeNull();
});

test("the withdrawal sentence counts only the returning part, and is absent when none returns", async () => {
  await open(known({ withdrawnCad: 3000, returningCad: 2000 }));
  expect(screen.getByText("You withdrew $2,000 this year. That room comes back on 1 January 2027. Putting it back before then would be an over-contribution.")).toBeInTheDocument();
  cleanup();
  await open(known({ withdrawnCad: 2000, returningCad: 0, roomLeftCad: -1000, craRoomCad: 5000, contributedCad: 8000, overLimitCad: 1000 }));
  expect(screen.queryByText(/comes back/)).toBeNull();
  // Spec example: room 5,000; +7,000; −2,000 (qualifying); +1,000 → 6,000 used of 5,000, matching the headline.
  expect(screen.getByRole("img", { name: "Used $6,000 of $5,000 CRA room this year" })).toBeInTheDocument();
});

test("chart: the line stops at the last known row, and its label says where", async () => {
  await open(known({ ledger: { overSince: null, undatedExcess: false, rows: [
    lrow({ date: "2026-01-01", kind: "cra_room", label: "CRA", amountCad: 7000, roomLeftCad: 7000, excessCad: 0 }),
    lrow({ date: "2026-03-01", amountCad: 1000, roomLeftCad: 6000, excessCad: 0 }),
    lrow({ date: "2026-04-01", kind: "ambiguous", roomLeftCad: null, excessCad: null }),
  ] } }));
  expect(screen.getByRole("img", { name: "Room left over the year: started at $7,000, not known after 1 March." })).toBeInTheDocument();
  expect(screen.getByTestId("room-chart-line").getAttribute("d")!.match(/H/g)).toHaveLength(1);
});

test("missing: dated_entries asks for dated deposits", async () => {
  await open(missing([{ kind: "dated_entries", label: "Other bank", accountKey: "outside:other-bank" }]));
  expect(screen.getByText("Other bank's contributions this year as dated deposits, so withdrawals can be placed correctly")).toBeInTheDocument();
});

test("ledger: a USD row shows est., the rate date and the native amount", async () => {
  await open(ledgerOver([lrow({ wentOver: true, amountCad: 1350, estimated: true, rateDate: "2026-03-13", native: { amount: 1000, currency: "USD" } })]));
  expect(screen.getByText(/\+\$1,350 \(est\., BoC 2026-03-13; US\$1,000\)/)).toBeInTheDocument();
});

test("See every move opens the dashboard room page", async () => {
  const f = await open(ledgerOver([lrow({ wentOver: true })]));
  const spy = vi.spyOn(f.bridge, "openLink");
  act(() => screen.getByRole("button", { name: "See every move" }).click());
  expect(spy).toHaveBeenCalledWith(URL_ROOM);
});

test("no dashboard url: no link", async () => {
  await open(ledgerOver([lrow({ wentOver: true })]) && { ...ledgerOver([lrow({ wentOver: true })]), dashboardUrl: undefined } as RoomPayload);
  expect(screen.queryByRole("button", { name: "See every move" })).toBeNull();
});

test("undated excess: the date can't be told", async () => {
  await open(known({ roomLeftCad: -100, overLimitCad: 100, ledger: { rows: [lrow({ kind: "outside_total", label: "Other bank" })], overSince: null, undatedExcess: true } }));
  expect(screen.getByText("About $100 over your TFSA room; the date can't be told because Other bank has a total, not dated deposits")).toBeInTheDocument();
});

test("missing: points to the dashboard", async () => {
  const f = await open(missing([{ kind: "cra_room" }], { dashboardUrl: URL_ROOM }));
  const spy = vi.spyOn(f.bridge, "openLink");
  expect(screen.getByText("Enter these on the VestLens dashboard")).toBeInTheDocument();
  act(() => screen.getByRole("button", { name: /dashboard/i }).click());
  expect(spy).toHaveBeenCalledWith(URL_ROOM);
});

test("missing state: the withdrawal sentence doesn't say how much room comes back", async () => {
  await open(missing([{ kind: "cra_room" }], { withdrawnCad: 2000, returningCad: 0 }));
  expect(screen.getByText("You withdrew $2,000 this year. Some or all of that room comes back on 1 January 2027; the exact amount needs the missing items above.")).toBeInTheDocument();
  expect(screen.queryByText(/That room comes back/)).toBeNull();
});

test("dashboard line: every item enterable, some enterable, none enterable", async () => {
  await open(missing([{ kind: "cra_room" }, { kind: "outside_contributions", label: "O", accountKey: "outside:o" }], { dashboardUrl: URL_ROOM }));
  expect(screen.getByText("Enter these on the VestLens dashboard")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /dashboard/i })).toBeInTheDocument();
  cleanup();
  await open(missing([{ kind: "cra_room" }, { kind: "coverage", label: "A", accountKey: "k" }], { dashboardUrl: URL_ROOM }));
  expect(screen.getByText("You can enter some of these on the VestLens dashboard")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /dashboard/i })).toBeInTheDocument();
  cleanup();
  await open(missing([{ kind: "coverage", label: "A", accountKey: "k" }, { kind: "stale_activity", label: "B", accountKey: "j", lastSyncedAt: null }], { dashboardUrl: URL_ROOM }));
  expect(screen.queryByText(/on the VestLens dashboard/)).toBeNull();
  expect(screen.queryByRole("button", { name: /dashboard/i })).toBeNull();
});

// RRSP: one headline per open tax year under the TFSA card (and the FHSA line), in the server's words.
const rrspYear = (taxYear: number, over: Record<string, unknown> = {}) => ({
  window: { taxYear, from: `${taxYear - 1}-03-03`, to: null }, contributedCad: 3000, limitCad: 10000, unusedCad: null, elsewhereCad: null, roomLeftCad: 7000, overLimitCad: 0,
  estimated: false, missing: [], basis: [], fx: { contributions: noFx, withdrawals: noFx }, fxDates: [], headline: `$7,000 of RRSP deduction room left for ${taxYear}`, ...over,
});
const rrsp = (years: unknown[]) => ({ status: "shown", years, line: "RRSP: synthetic" });
const DEDUCT_LATER = "Unused contributions can be deducted in a later year; VestLens doesn't choose the year for you.";

test("no RRSP: no RRSP block", async () => {
  await open(known());
  expect(screen.queryByRole("group", { name: "RRSP room" })).toBeNull();
  expect(document.body.textContent).not.toContain("RRSP");
});

test("an RRSP: the RRSP label and each year's headline, previous year first, under the TFSA card", async () => {
  await open(known({ fhsa: { status: "known", year: 2026, headline: "About $5,000 of FHSA room left this year" }, rrsp: rrsp([
    rrspYear(2025, { headline: "$500 of RRSP deduction room left for 2025" }), rrspYear(2026),
  ]) }));
  const block = screen.getByRole("group", { name: "RRSP room" });
  expect(within(block).getByText("RRSP")).toHaveClass("tr-fhsa-label");
  const first = within(block).getByText("$500 of RRSP deduction room left for 2025");
  const second = within(block).getByText("$7,000 of RRSP deduction room left for 2026");
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(block).getByText(DEDUCT_LATER)).toBeInTheDocument();
  const tfsa = screen.getByText("About $1,500 of TFSA room left this year");
  expect(tfsa.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole("group", { name: "FHSA room" }).compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("an RRSP over its limit shows the CRA fact once; one under it does not", async () => {
  await open(known({ rrsp: rrsp([rrspYear(2026, { overLimitCad: 1000, roomLeftCad: 0, headline: "$1,000 over your RRSP deduction limit for 2026" })]) }));
  expect(screen.getByText("$1,000 over your RRSP deduction limit for 2026")).toBeInTheDocument();
  expect(screen.getAllByText("CRA charges 1% a month on contributions more than $2,000 over your RRSP deduction limit. Check your figures in CRA My Account.")).toHaveLength(1);
  cleanup();
  await open(known({ rrsp: rrsp([rrspYear(2026)]) }));
  expect(screen.queryByText(/CRA charges 1% a month on contributions/)).toBeNull();
});

test("an RRSP with no limit asks for it; a managed RRSP names what isn't visible; a converted year carries its note", async () => {
  await open(known({ rrsp: rrsp([rrspYear(2026, {
    limitCad: null, roomLeftCad: null, overLimitCad: null, headline: "$3,000 contributed for the 2026 tax year", missing: [{ kind: "deduction_limit" }],
    estimated: true, fx: { contributions: { estimated: true, rateDates: ["2026-05-01"], native: [{ amount: 1000, currency: "USD" }] }, withdrawals: noFx },
  })]) }));
  const block = screen.getByRole("group", { name: "RRSP room" });
  expect(within(block).getByText("Enter your RRSP deduction limit from CRA My Account or your notice of assessment to see room left.")).toBeInTheDocument();
  expect(block).toHaveTextContent("(est.; includes US$1,000 converted at the Bank of Canada rate of 2026-05-01)");
  cleanup();
  await open(known({ rrsp: rrsp([rrspYear(2026, {
    roomLeftCad: null, overLimitCad: null, headline: "I can't give a number for 2026 yet", missing: [{ kind: "managed_rrsp", labels: ["Synthetic Managed A", "Synthetic Managed B"] }],
  })]) }));
  expect(screen.getByText("I can't give a number for 2026 yet")).toBeInTheDocument();
  expect(screen.getByText("Contributions to Synthetic Managed A, Synthetic Managed B aren't visible through SnapTrade. Add them, plus any other RRSP contributions VestLens doesn't see for the 2026 tax year (a group RRSP at work, an account at another institution, a spousal RRSP for your spouse), to 'Contributions not in VestLens'; enter 0 if there are none.")).toBeInTheDocument();
  expect(screen.queryByText(/Enter your RRSP deduction limit/)).toBeNull();
});

test("the RRSP headline carries the entered 'not in VestLens' figure beside the connected contributions, as the dashboard and text do (B12)", async () => {
  // Contributions headline (the limit missing): the figure follows the headline.
  await open(known({ rrsp: rrsp([rrspYear(2026, {
    limitCad: null, roomLeftCad: null, overLimitCad: null, elsewhereCad: 800, headline: "$3,000 contributed for the 2026 tax year", missing: [{ kind: "deduction_limit" }],
  })]) }));
  expect(screen.getByText("$3,000 contributed for the 2026 tax year plus $800 you entered as contributions not in VestLens")).toBeInTheDocument();
  cleanup();
  // Room-left headline: a line beneath names both; nothing is added into the headline.
  await open(known({ rrsp: rrsp([rrspYear(2026, { elsewhereCad: 2000, roomLeftCad: 5000, headline: "$5,000 of RRSP deduction room left for 2026" })]) }));
  expect(screen.getByText("$5,000 of RRSP deduction room left for 2026")).toBeInTheDocument();
  expect(screen.getByText("$3,000 contributed plus $2,000 you entered as contributions not in VestLens")).toBeInTheDocument();
  cleanup();
  // Nothing entered: nothing added.
  await open(known({ rrsp: rrsp([rrspYear(2026)]) }));
  expect(document.body.textContent).not.toContain("not in VestLens");
});

test("an RRSP with the limit only asks for the unused and elsewhere figures, with the year, and shows no room left", async () => {
  await open(known({ rrsp: rrsp([rrspYear(2025, {
    window: { taxYear: 2025, from: "2025-03-04", to: "2026-03-02" }, limitCad: 10000, roomLeftCad: null, overLimitCad: null,
    headline: "$3,000 contributed for the 2025 tax year", missing: [{ kind: "unused_contributions" }, { kind: "elsewhere" }],
  })]) }));
  const block = screen.getByRole("group", { name: "RRSP room" });
  expect(within(block).getByText("What unused RRSP contributions does CRA show for 2025? It's next to your deduction limit on your notice of assessment and in CRA My Account; enter 0 if there are none.")).toBeInTheDocument();
  expect(within(block).getByText("Did you contribute to an RRSP VestLens doesn't see for the 2025 tax year, such as a group RRSP at work, an account at another institution, or a spousal RRSP for your spouse? Enter the total, or 0 if none.")).toBeInTheDocument();
  expect(block.textContent).not.toMatch(/room left for 2025|Enter your RRSP deduction limit/);
});

test("an RRSP coverage gap is a fact with the window start, not a question", async () => {
  await open(known({ rrsp: rrsp([rrspYear(2026, {
    window: { taxYear: 2026, from: "2026-03-03", to: null }, contributedCad: null, roomLeftCad: null, overLimitCad: null, headline: "I can't give a number for 2026 yet",
    missing: [{ kind: "coverage", label: "Synthetic RRSP", accountKey: "1111111111111111" }],
  })]) }));
  const block = screen.getByRole("group", { name: "RRSP room" });
  expect(within(block).getByText("Synthetic RRSP's stored activity doesn't reach 3 March 2026 yet; I'll have a number once its full history has loaded.")).toBeInTheDocument();
  expect(block.textContent).not.toContain("How much have you contributed");
});

describe("the New Year check (owner ruling 2026-11-03)", () => {
  const sentence = "Near New Year: 29 December 2026 · Synthetic TFSA · +$180 is counted in 2026 here, but your brokerage may record it in 2027. If it does, your 2027 TFSA room is up to $180 lower than shown. Check the date your brokerage shows for it.";
  it("shows the server's sentence on a known card and a missing one", async () => {
    await open(known({ newYearNote: sentence }));
    expect(screen.getByText(sentence)).toBeInTheDocument();
    cleanup();
    await open(missing([{ kind: "cra_room" }], { newYearNote: sentence }));
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });
  it("shows the FHSA one under the FHSA line, and nothing without a note", async () => {
    const fhsaSentence = "Near New Year: 30 December 2026 · Synthetic FHSA · +$2,000 is counted in 2026 here, but your brokerage may record it in 2027. If it does, your 2027 FHSA room is up to $2,000 lower than shown. Check the date your brokerage shows for it.";
    await open(known({ fhsa: { status: "known", year: 2027, headline: "About $8,000 of FHSA room left this year", disclosures: [], newYearNote: fhsaSentence } }));
    expect(within(screen.getByRole("group", { name: "FHSA room" })).getByText(fhsaSentence)).toBeInTheDocument();
    expect(screen.queryByText(/Near New Year: 29 December/)).toBeNull();
  });
});
