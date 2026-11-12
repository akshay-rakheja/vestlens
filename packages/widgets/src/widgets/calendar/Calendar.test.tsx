import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { HYDRATE_WATCHDOG_MS } from "../../kit/resilience";
import { Calendar } from "./Calendar";
import type { CalendarEventView, CalendarPayload } from "./types";

const DAY = 86_400_000;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const t0 = Date.parse(`${today}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const monday = t0 - ((new Date(t0).getUTCDay() + 6) % 7) * DAY;
const at = (offsetDays: number) => iso(t0 + offsetDays * DAY);
const weekOf = (d: string) => { const t = Date.parse(`${d}T00:00:00Z`); return iso(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY); };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

const ev = (over: Partial<CalendarEventView>): CalendarEventView => ({
  id: "e", symbol: "ZZTEST", kind: "earnings", date: at(0), status: "expected", estimated: true, amount: null, outcome: null, ...over,
});
function payload(over: Partial<CalendarPayload> = {}): CalendarPayload {
  const events = [
    ev({ id: "past", symbol: "ZZTEST", date: iso(monday - 4 * DAY), status: "confirmed", estimated: false, outcome: { headline: "ZZTEST invented quarter beats", source: "wire.example", mood: "strongly_positive" } }),
    ev({ id: "this", symbol: "ZZUSD", date: iso(monday + 4 * DAY) }),
    ev({ id: "div", symbol: "ZZDIV", kind: "dividend_pay", date: iso(monday + 10 * DAY), amount: { perUnit: 0.25, units: 200, total: 50, currency: "CAD" } }),
    ev({ id: "later", symbol: "ZZLATE", date: iso(monday + 17 * DAY), status: "confirmed", estimated: false }),
  ];
  const weeks = new Map<string, CalendarEventView[]>();
  for (const e of events) weeks.set(weekOf(e.date), [...(weeks.get(weekOf(e.date)) ?? []), e]);
  return {
    range: "1m", asOf: new Date().toISOString(),
    weeks: [...weeks.entries()].map(([weekStart, list]) => ({ weekStart, events: list })),
    thisWeek: { earnings: 1, dividends: 0 },
    accounts: [{ id: "acct-secret-1", label: "TFSA 2" }, { id: "acct-secret-2", label: "RRSP" }],
    filters: { range: "1m" }, settings: { benchmark: "sp500", cadView: false, privacyDefault: false }, ...over,
  };
}
type Impl = (name: string, args: any) => Promise<ToolResult> | ToolResult;
function fakeBridge(impl?: Impl) {
  let listener: (r: ToolResult) => void = () => {};
  const callTool = vi.fn(async (name: string, args: any) => (impl ? impl(name, args) : { structuredContent: payload() }));
  const sendMessage = vi.fn(async (_text: string) => {});
  const updateModelContext = vi.fn(async (_text: string) => {});
  const bridge: Bridge = {
    ready: Promise.resolve({ hostTools: true, context: {} }),
    onToolResult: (fn) => { listener = fn; return () => {}; },
    onContext: () => () => {},
    toolArguments: () => ({}), openLink: async () => true,
    callTool, sendMessage, updateModelContext, destroy: () => {},
  };
  return { bridge, callTool, sendMessage, updateModelContext, push: (r: ToolResult) => listener(r) };
}
const ESTIMATE = "Dates marked est. are projected from past filings and payments and may be wrong.";
async function open(p = payload(), impl?: Impl) {
  const f = fakeBridge(impl);
  render(<Calendar bridge={f.bridge} />);
  expect(screen.getByText(/loading your calendar/i)).toBeInTheDocument();
  act(() => f.push({ structuredContent: p }));
  await screen.findByText(ESTIMATE);
  return f;
}
const week = (label: string) => screen.getByRole("region", { name: label });
afterEach(() => { cleanup(); vi.useRealTimers(); });

test("groups events into weekly sections labelled This week, Next week, or the week's date", async () => {
  await open();
  const labels = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
  expect(labels).toEqual([`Week of ${short(iso(monday - 7 * DAY))}`, "This week", "Next week", `Week of ${short(iso(monday + 14 * DAY))}`]);
  expect(within(week("This week")).getByText("ZZUSD")).toBeInTheDocument();
  expect(within(week("Next week")).getByText("ZZDIV")).toBeInTheDocument();
});

test("cards show symbol, kind, date and an est. badge only for estimated dates", async () => {
  await open();
  const usd = within(week("This week")).getByRole("listitem");
  expect(usd).toHaveTextContent("ZZUSD");
  expect(usd).toHaveTextContent("Earnings");
  expect(usd).toHaveTextContent(short(iso(monday + 4 * DAY)));
  expect(within(usd).getByText("est.")).toBeInTheDocument();
  const late = within(week(`Week of ${short(iso(monday + 14 * DAY))}`)).getByRole("listitem");
  expect(within(late).queryByText("est.")).toBeNull();
  const div = within(week("Next week")).getByRole("listitem");
  expect(div).toHaveTextContent("Dividend");
  expect(div).toHaveTextContent("$50.00");
});

test("a passed earnings date shows its outcome line from the top article's mood", async () => {
  await open();
  const past = within(week(`Week of ${short(iso(monday - 7 * DAY))}`)).getByRole("listitem");
  expect(past).toHaveTextContent("Reported · news tone strongly positive · wire.example");
  expect(screen.getByText(/News tone is AI-rated from the headline and summary\. It describes the news, not the stock, and may be wrong\./)).toBeInTheDocument();
});

test("privacy hides dividend amounts; the saved default applies on first load", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  expect(screen.queryByText("$50.00")).toBeNull();
  expect(screen.getAllByLabelText("Hidden amount").length).toBeGreaterThan(0);
  cleanup();
  await open(payload({ settings: { benchmark: "sp500", cadView: false, privacyDefault: true } }));
  expect(screen.queryByText("$50.00")).toBeNull();
  expect(screen.getByRole("button", { name: "Show amounts" })).toHaveAttribute("aria-pressed", "true");
});

test("tapping an earnings card asks the chat for that symbol's news; dividends are not buttons; failures show a neutral notice", async () => {
  const f = await open();
  fireEvent.click(screen.getByRole("button", { name: /ZZUSD/ }));
  expect(f.sendMessage).toHaveBeenCalledWith("Show news for ZZUSD");
  expect(screen.queryByRole("button", { name: /ZZDIV/ })).toBeNull();
  f.sendMessage.mockRejectedValueOnce(new Error("declined"));
  fireEvent.click(screen.getByRole("button", { name: /ZZLATE/ }));
  expect(await screen.findByText("Couldn't send that to the chat.")).toBeInTheDocument();
});

test("range and account controls call get_calendar; a failure keeps the previous view", async () => {
  let fail = false;
  const f = await open(payload(), (_n, args) => {
    if (fail) throw new Error("x");
    return { structuredContent: payload({ range: args.range, filters: { range: args.range, ...(args.accountId ? { accountId: args.accountId } : {}) } }) };
  });
  fireEvent.click(screen.getByRole("radio", { name: "3m" }));
  await waitFor(() => expect(f.callTool).toHaveBeenCalledWith("get_calendar", { range: "3m" }));
  await waitFor(() => expect(screen.getByRole("radio", { name: "3m" })).toHaveAttribute("aria-checked", "true"));
  fireEvent.change(screen.getByRole("combobox", { name: "Account" }), { target: { value: "acct-secret-2" } });
  await waitFor(() => expect(f.callTool).toHaveBeenCalledWith("get_calendar", { range: "3m", accountId: "acct-secret-2" }));
  fail = true;
  fireEvent.click(screen.getByRole("radio", { name: "2w" }));
  expect(await screen.findByText("Couldn't load that view. Showing the previous one.")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "3m" })).toHaveAttribute("aria-checked", "true");
});

test("footer notes, read-only lock and the model context (range and count only)", async () => {
  const f = await open();
  expect(screen.getByText(ESTIMATE)).toBeInTheDocument();
  expect(screen.getByText("News and ratings are for information only, not investment advice.")).toBeInTheDocument();
  expect(screen.queryByText("Not investment advice.")).toBeNull();
  expect(screen.getByText("Read-only")).toBeInTheDocument();
  await waitFor(() => expect(f.updateModelContext).toHaveBeenCalledWith("Viewing calendar: 1m, 4 events"));
  for (const [text] of f.updateModelContext.mock.calls) expect(text).not.toMatch(/ZZ|acct|TFSA|\$/);
});

test("an empty range says so", async () => {
  await open(payload({ weeks: [], thisWeek: { earnings: 0, dividends: 0 } }));
  expect(screen.getByText("No earnings or dividend dates in this range.")).toBeInTheDocument();
});

test("an error result offers a retry through show_calendar; a silent host shows the watchdog", async () => {
  const f = fakeBridge();
  render(<Calendar bridge={f.bridge} />);
  act(() => f.push({ isError: true }));
  expect(await screen.findByText("Calendar unavailable right now")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(f.callTool).toHaveBeenCalledWith("show_calendar", {}));
  expect(await screen.findByText(ESTIMATE)).toBeInTheDocument();
  cleanup();
  vi.useFakeTimers();
  const g = fakeBridge();
  render(<Calendar bridge={g.bridge} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(HYDRATE_WATCHDOG_MS + 10); });
  expect(screen.getByText("Still loading…")).toBeInTheDocument();
});

// ---- CAD view ----
const usdDiv = (over: Partial<CalendarEventView> = {}) => ev({
  id: "udiv", symbol: "ZZUSD", kind: "dividend_pay", date: iso(monday + 11 * DAY),
  amount: { perUnit: 0.5, units: 10, total: 5, currency: "USD", home: { amount: 7, estimated: true, rate: 1.4, rateDate: "2026-10-20", native: { amount: 5, currency: "USD" } } }, ...over,
});
function cadPayload(over: Partial<CalendarPayload> = {}): CalendarPayload {
  const base = payload();
  const div = base.weeks.flatMap((w) => w.events).find((e) => e.id === "div")!;
  div.amount = { ...div.amount!, home: { amount: 50, estimated: false, rate: null, rateDate: null, native: { amount: 50, currency: "CAD" } } };
  const next = base.weeks.find((w) => w.events.some((e) => e.id === "div"))!;
  next.events.push(usdDiv());
  return {
    ...base,
    home: { dividends: { amount: 57, estimated: true, rateDates: ["2026-10-20"], excluded: [], excludedCount: 0 } },
    settings: { benchmark: "sp500", cadView: true, privacyDefault: false },
    ...over,
  };
}

test("cadView on: a USD dividend shows its CAD total est. with the native total and per-unit amount kept", async () => {
  await open(cadPayload());
  const row = within(week("Next week")).getAllByRole("listitem").find((li) => li.textContent!.includes("ZZUSD"))!;
  expect(row.textContent).toContain("$7.00");
  expect(row.textContent).toContain("est.");
  expect(row.textContent).toContain("US$5.00");
  expect(row.textContent).toContain("US$0.50 per unit");
});

test("cadView on: the projected dividend total in CAD est. with its rate caption", async () => {
  await open(cadPayload());
  const total = screen.getByText("Projected dividends").closest("div")!;
  expect(total.textContent).toContain("$57.00");
  expect(total.textContent).toContain("est. · at the latest BoC rate (Oct 20)");
});

test("a total with nothing converted shows native amounts with the not-converted note, never CAD $0.00", async () => {
  const p = cadPayload({ home: { dividends: { amount: 0, estimated: false, rateDates: [], excluded: [{ amount: 5, currency: "USD" }], excludedCount: 1 } } });
  p.weeks.flatMap((w) => w.events).find((e) => e.id === "udiv")!.amount!.home = { amount: null, estimated: false, rate: null, rateDate: null, native: { amount: 5, currency: "USD" } };
  await open(p);
  const total = screen.getByText("Projected dividends").closest("div")!;
  expect(total.textContent).toContain("US$5.00");
  expect(total.textContent).toContain("Not converted (no recent Bank of Canada rate)");
  expect(total.textContent).not.toContain("$0.00");
});

test("a dividend with no amount says why, and the CAD total says it is left out (A4)", async () => {
  const p = cadPayload();
  p.weeks.flatMap((w) => w.events).find((e) => e.id === "udiv")!.amount = null;
  await open(p);
  expect(await screen.findByText("Amount left out: units changed around the last payment")).toBeInTheDocument();
  expect(screen.getByText("1 payment without an amount not included")).toBeInTheDocument();
});

test("privacy hides the CAD and native amounts alike", async () => {
  await open(cadPayload());
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  expect(screen.queryByText("$7.00")).toBeNull();
  expect(screen.queryByText("US$5.00")).toBeNull();
  expect(screen.queryByText("$57.00")).toBeNull();
});

test("the switch shows original currencies and saves the setting; on again over a payload without CAD data reloads", async () => {
  const f = await open(cadPayload(), (name) => (name === "save_portfolio_settings" ? { structuredContent: {} } : { structuredContent: cadPayload() }));
  fireEvent.click(screen.getByRole("button", { name: "Show original currencies" }));
  expect(f.callTool).toHaveBeenCalledWith("save_portfolio_settings", { cadView: false });
  expect(screen.queryByText("Projected dividends")).toBeNull();
  const row = within(week("Next week")).getAllByRole("listitem").find((li) => li.textContent!.includes("ZZUSD"))!;
  expect(row.textContent).toContain("US$5.00");
  expect(row.textContent).not.toContain("$7.00");
  cleanup();
  const g = await open(payload(), (name) => (name === "save_portfolio_settings" ? { structuredContent: {} } : { structuredContent: cadPayload() }));
  const sw = screen.getByRole("button", { name: "Show original currencies" });
  await waitFor(() => expect(sw).toHaveAttribute("aria-pressed", "true"));
  fireEvent.click(sw);
  await waitFor(() => expect(g.callTool).toHaveBeenCalledWith("get_calendar", { range: "1m" }));
  expect(await screen.findByText("Projected dividends")).toBeInTheDocument();
});

test("fix 2: projected CAD totals say they use the latest BoC rate; past events keep the plain caption", async () => {
  const p = cadPayload();
  const past = ev({ id: "pastdiv", symbol: "ZZPAST", kind: "dividend_pay", date: iso(monday - 2 * DAY),
    amount: { perUnit: 0.5, units: 10, total: 5, currency: "USD", home: { amount: 7, estimated: true, rate: 1.4, rateDate: "2026-10-20", native: { amount: 5, currency: "USD" } } } });
  p.weeks.unshift({ weekStart: weekOf(past.date), events: [past] });
  await open(p);
  const total = screen.getByText("Projected dividends").closest("div")!;
  expect(total.textContent).toContain("est. · at the latest BoC rate (Oct 20)");
  const proj = within(week("Next week")).getAllByRole("listitem").find((li) => li.textContent!.includes("ZZUSD"))!;
  expect(proj.textContent).toContain("est. · at the latest BoC rate (Oct 20)");
  const old = screen.getAllByRole("listitem").find((li) => li.textContent!.includes("ZZPAST"))!;
  expect(old.textContent).toContain("est. · BoC Oct 20");
  expect(old.textContent).not.toContain("latest BoC rate");
});
