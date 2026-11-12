import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { Goal } from "./Goal";

function fakeBridge() {
  let listener: (r: ToolResult) => void = () => {};
  const bridge: Bridge = {
    ready: Promise.resolve({ hostTools: true, context: {} }),
    onToolResult: (fn) => { listener = fn; return () => {}; },
    onContext: () => () => {}, toolArguments: () => ({}), openLink: async () => true,
    callTool: vi.fn(async () => ({ structuredContent: payload() })), sendMessage: vi.fn(async () => {}), updateModelContext: vi.fn(async () => {}), destroy: () => {},
  };
  return { bridge, push: (p: unknown) => listener({ structuredContent: p }) };
}
const goal = (over: Record<string, unknown> = {}) => ({
  slug: "house", name: "House deposit", targetCad: 50000, targetDate: "2027-10-24", savedCad: 20000.4, savedPct: 40.0008, remainingCad: 29999.6,
  estimated: false, monthsLeft: 12.3, dateStatus: "future", neededPerMonthFlatCad: 2437.5, recentPacePerMonthCad: 1500, projectedAtPaceCad: 38450,
  projectedWithRateCad: null, growthRatePct: null, savedFxDate: null, paceEstimated: false, paceFxDate: null,
  series: [{ date: "2026-08-02", valueCad: 15000 }, { date: "2026-09-06", valueCad: 17500 }, { date: "2026-10-04", valueCad: 20000.4 }], notes: [], ...over,
});
const payload = (goals: unknown[] = [goal()]) => ({ goals });
async function open(p: unknown) {
  const f = fakeBridge();
  render(<Goal bridge={f.bridge} />);
  expect(screen.getByText(/loading/i)).toBeInTheDocument();
  act(() => f.push(p));
  await screen.findByRole("region", { name: "Savings goal" });
  return f;
}
afterEach(cleanup);

test("name, target, saved, a progress bar and months left", async () => {
  await open(payload());
  expect(screen.getByText("House deposit")).toBeInTheDocument();
  expect(screen.getByText(/\$50,000 by 2027-10-24/)).toBeInTheDocument();
  expect(screen.getByText("About $20,000 saved, 40% of the target")).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "Saved so far" })).toHaveAttribute("aria-valuenow", "40");
  expect(screen.getByText("12 months left")).toBeInTheDocument();
});

test("a lower bound reads 'at least' with no percentage, bar or projection (review 7)", async () => {
  await open(payload([goal({ savedCad: 40000, savedAtLeast: true, savedPct: null, remainingCad: null, neededPerMonthFlatCad: null, projectedAtPaceCad: null, notes: ["Not included in the total: Managed RRSP. SnapTrade doesn't provide the value of Wealthsimple managed portfolios, so saved so far is a lower bound"] })]));
  expect(screen.getByText("At least $40,000 saved; an account's value is unknown, so there is no percentage of the target")).toBeInTheDocument();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText(/At that pace/)).toBeNull();
  expect(screen.getByText(/Not included in the total: Managed RRSP/)).toBeInTheDocument();
});

test("estimated figures carry (est.)", async () => {
  await open(payload([goal({ estimated: true })]));
  expect(screen.getByText("About $20,000 (est.) saved, 40% of the target")).toBeInTheDocument();
});

const lbl = (d: string) => `(est., Bank of Canada rate ${d})`;
test("every converted figure carries its own estimate label and rate date", async () => {
  await open(payload([goal({ estimated: true, savedFxDate: "2026-10-22", paceEstimated: true, paceFxDate: "2026-09-01", growthRatePct: 5, projectedWithRateCad: 41200 })]));
  expect(screen.getByText(`About $20,000 ${lbl("2026-10-22")} saved, 40% of the target`)).toBeInTheDocument();
  expect(screen.getByText(`About $2,438 ${lbl("2026-10-22")} a month from here reaches the target if values stay flat`)).toBeInTheDocument();
  expect(screen.getByText(`About $1,500 ${lbl("2026-09-01")} a month in net contributions over the last 6 months`)).toBeInTheDocument();
  expect(screen.getByText(`At that pace, about $38,450 ${lbl("2026-10-22")} by 2027-10-24 with no growth`)).toBeInTheDocument();
  expect(screen.getByText(`With your 5% yearly growth rate (your assumption): about $41,200 ${lbl("2026-10-22")} by 2027-10-24`)).toBeInTheDocument();
});

test("a converted pace alone labels the pace and projections, not the saved figures", async () => {
  await open(payload([goal({ paceEstimated: true, paceFxDate: "2026-09-01" })]));
  expect(screen.getByText("About $20,000 saved, 40% of the target")).toBeInTheDocument();
  expect(screen.getByText("About $2,438 a month from here reaches the target if values stay flat")).toBeInTheDocument();
  expect(screen.getByText(`About $1,500 ${lbl("2026-09-01")} a month in net contributions over the last 6 months`)).toBeInTheDocument();
  expect(screen.getByText(`At that pace, about $38,450 ${lbl("2026-09-01")} by 2027-10-24 with no growth`)).toBeInTheDocument();
});

test("still to go is labelled when the saved total is converted", async () => {
  await open(payload([goal({ estimated: true, savedFxDate: "2026-10-22", dateStatus: "passed", neededPerMonthFlatCad: null })]));
  expect(screen.getByText(`About $30,000 ${lbl("2026-10-22")} still to go`)).toBeInTheDocument();
});

test("estimated with no date keeps the bare (est.)", async () => {
  await open(payload([goal({ estimated: true, paceEstimated: true })]));
  expect(screen.getByText("About $20,000 (est.) saved, 40% of the target")).toBeInTheDocument();
  expect(screen.getByText("About $1,500 (est.) a month in net contributions over the last 6 months")).toBeInTheDocument();
});

test("an unconverted goal carries no rate label", async () => {
  await open(payload([goal()]));
  expect(document.body.textContent).not.toMatch(/Bank of Canada|est\./);
});

test("a one-point series draws no chart", async () => {
  await open(payload([goal({ series: [{ date: "2026-10-04", valueCad: 20000 }] })]));
  expect(screen.queryByRole("img")).toBeNull();
});

test("a passed target date draws the actual line only, with no NaN and no straight line", async () => {
  await open(payload([goal({ dateStatus: "passed", targetDate: "2026-07-01", monthsLeft: 0 })]));
  const chart = screen.getByRole("img", { name: /Saved value by week/ });
  expect(chart.querySelectorAll("polyline")).toHaveLength(1);
  expect(chart.innerHTML).not.toMatch(/NaN|Infinity/);
  expect(screen.queryByText("Straight line to target")).toBeNull();
  expect(screen.getByText("Actual")).toBeInTheDocument();
});

test("a target date that passed inside the series ends the straight line there", async () => {
  await open(payload([goal({ dateStatus: "passed", targetDate: "2026-09-10", monthsLeft: 0 })]));
  const chart = screen.getByRole("img", { name: /Saved value by week/ });
  expect(chart.querySelectorAll("polyline")).toHaveLength(2);
  expect(chart.innerHTML).not.toMatch(/NaN|Infinity/);
});

test("a series with an unreadable date draws nothing and does not crash", async () => {
  await open(payload([goal({ series: [{ date: "soon", valueCad: 1 }, { date: "later", valueCad: 2 }] })]));
  expect(screen.queryByRole("img")).toBeNull();
});

test.each([
  ["goals with a non-object", { goals: [null] }],
  ["a goal with no name", { goals: [goal({ name: undefined })] }],
  ["a goal with a bad dateStatus", { goals: [goal({ dateStatus: "soon" })] }],
  ["a series point with no value", { goals: [goal({ series: [{ date: "2026-01-01" }] })] }],
  ["notes that are not text", { goals: [goal({ notes: [1] })] }],
])("%s shows the calm message", async (_name, p) => {
  const f = fakeBridge();
  render(<Goal bridge={f.bridge} />);
  act(() => f.push(p));
  expect(await screen.findByText("Savings goal unavailable right now")).toBeInTheDocument();
});

test("pace chart: actual against a straight line to the target, both described", async () => {
  await open(payload());
  const chart = screen.getByRole("img", { name: /Saved value by week against a straight line to the target/ });
  expect(chart.querySelectorAll("polyline")).toHaveLength(2);
  expect(screen.getByText("Actual")).toBeInTheDocument();
  expect(screen.getByText("Straight line to target")).toBeInTheDocument();
});

test("no chart when the series is empty", async () => {
  await open(payload([goal({ series: [] })]));
  expect(screen.queryByRole("img")).toBeNull();
});

test("about $X a month, recent pace and projection without a rate", async () => {
  await open(payload());
  expect(screen.getByText("About $2,438 a month from here reaches the target if values stay flat")).toBeInTheDocument();
  expect(screen.getByText("About $1,500 a month in net contributions over the last 6 months")).toBeInTheDocument();
  expect(screen.getByText("At that pace, about $38,450 by 2027-10-24 with no growth")).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/your assumption/);
});

test("a rate is labelled as the user's assumption", async () => {
  await open(payload([goal({ growthRatePct: 5, projectedWithRateCad: 41200 })]));
  expect(screen.getByText("With your 5% yearly growth rate (your assumption): about $41,200 by 2027-10-24")).toBeInTheDocument();
});

test("a rate with no projection shows no assumption line", async () => {
  await open(payload([goal({ growthRatePct: 5, projectedWithRateCad: null, recentPacePerMonthCad: null, projectedAtPaceCad: null })]));
  expect(document.body.textContent).not.toMatch(/your assumption/);
  expect(screen.getByText("Recent pace: can't tell")).toBeInTheDocument();
});

test("pace since a date is shown with the pace", async () => {
  await open(payload([goal({ notes: ["pace since 2026-06-15"] })]));
  expect(screen.getByText(/a month in net contributions since 2026-06-15$/)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("last 6 months");
});

test("under a month: still to go, no per-month figure", async () => {
  await open(payload([goal({ dateStatus: "under_month", monthsLeft: 0.4, neededPerMonthFlatCad: null, notes: ["less than a month left"] })]));
  expect(screen.getByText("Less than a month left")).toBeInTheDocument();
  expect(screen.getByText("About $30,000 still to go")).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/a month from here/);
});

test("past date: target date passed, still to go, pace still shown", async () => {
  await open(payload([goal({ dateStatus: "passed", monthsLeft: 0, neededPerMonthFlatCad: null, projectedAtPaceCad: null, notes: ["target date passed"] })]));
  expect(screen.getByText("Target date passed")).toBeInTheDocument();
  expect(screen.getByText("About $30,000 still to go")).toBeInTheDocument();
  expect(screen.getByText("About $1,500 a month in net contributions over the last 6 months")).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/-\$/);
});

test("saved unknown: says so and lists the notes, no bar", async () => {
  await open(payload([goal({ savedCad: null, savedPct: null, remainingCad: null, neededPerMonthFlatCad: null, projectedAtPaceCad: null, series: [], notes: ["an account in this goal is no longer connected, so saved so far can't be totalled"] })]));
  expect(screen.getByText("Saved so far: can't tell")).toBeInTheDocument();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByText("An account in this goal is no longer connected, so saved so far can't be totalled.")).toBeInTheDocument();
});

test("a bar over 100% is clamped but the percent is honest", async () => {
  await open(payload([goal({ savedCad: 60000, savedPct: 120, remainingCad: 0, neededPerMonthFlatCad: 0 })]));
  expect(screen.getByRole("progressbar", { name: "Saved so far" })).toHaveAttribute("aria-valuenow", "100");
  expect(screen.getByText("About $60,000 saved, 120% of the target")).toBeInTheDocument();
  expect(screen.getByText("Target reached")).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("$0");
});

test("no goals: a plain line", async () => {
  await open(payload([]));
  expect(screen.getByText("No savings goals are saved yet.")).toBeInTheDocument();
});

test("every string renders as text", async () => {
  await open(payload([goal({ name: "<b>x</b> [a](b)", notes: ["<i>n</i> [l](u)"] })]));
  expect(screen.getByText("<b>x</b> [a](b)")).toBeInTheDocument();
  expect(screen.getByText("<i>n</i> [l](u).")).toBeInTheDocument();
  expect(document.querySelector("a")).toBeNull();
  expect(document.querySelectorAll("b:not(.w-brand b), i").length).toBe(0);
});

test("no advice words", async () => {
  await open(payload([goal({ growthRatePct: 5, projectedWithRateCad: 41200 })]));
  expect(document.body.textContent).not.toMatch(/\b(should|buy|sell|recommend)\b/i);
});

test("phone width: wraps long text, no fixed widths, chart scales", async () => {
  await open(payload());
  const css = document.querySelector("style")!.textContent!;
  expect(css).toMatch(/overflow-wrap:anywhere/);
  expect(css).not.toMatch(/(^|[;{\s])(min-)?width:\s*\d{3,}px/);
  expect(document.querySelector("svg[role=img]")!.getAttribute("viewBox")).toBeTruthy();
});

test("a malformed result shows a calm message", async () => {
  const f = fakeBridge();
  render(<Goal bridge={f.bridge} />);
  act(() => f.push({ goals: 3 }));
  expect(await screen.findByText("Savings goal unavailable right now")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("region", { name: "Savings goal" });
});
