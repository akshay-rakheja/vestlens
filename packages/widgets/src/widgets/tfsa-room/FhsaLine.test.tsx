import { act, cleanup, render, screen, within } from "@testing-library/preact";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { TfsaRoom } from "./TfsaRoom";
import type { RoomPayload } from "./types";

// Synthetic amounts and labels only.
const noFx = { estimated: false, rateDates: [], native: [] };
const known = (over: Record<string, unknown> = {}): RoomPayload => ({
  year: 2026, withdrawnCad: 0, basis: [], fxDates: [], fx: { contributions: noFx, withdrawals: noFx },
  status: "known", roomLeftCad: 1500, contributedCad: 5500, craRoomCad: 7000, estimated: false, overLimitCad: 0, ...over,
}) as RoomPayload;

async function open(p: RoomPayload) {
  let listener: (r: ToolResult) => void = () => {};
  const bridge: Bridge = {
    ready: Promise.resolve({ hostTools: true, context: {} }),
    onToolResult: (fn) => { listener = fn; return () => {}; },
    onContext: () => () => {}, toolArguments: () => ({}), openLink: async () => true,
    callTool: vi.fn(async () => ({ structuredContent: p })), sendMessage: vi.fn(async () => {}), updateModelContext: vi.fn(async () => {}), destroy: () => {},
  };
  render(<TfsaRoom bridge={bridge} />);
  act(() => listener({ structuredContent: p }));
  return screen.findByRole("region", { name: "TFSA room" });
}
afterEach(cleanup);

test("no FHSA: no FHSA line", async () => {
  await open(known());
  expect(document.body.textContent).not.toContain("FHSA");
});

test("an FHSA: one headline line under the TFSA card, with its conversion note", async () => {
  await open(known({ fhsa: {
    status: "known", year: 2026, headline: "About $5,000 of FHSA room left this year", note: "(est.; includes US$1,000 converted at the Bank of Canada rate of 2026-03-02)",
    disclosures: ["Based on activity up to 24 October 2026; deposits made since then aren't included", "Withdrawals are counted as taxable withdrawals", "An amount over from last year isn't included; CRA My Account shows it."],
  } }));
  const line = screen.getByRole("group", { name: "FHSA room" });
  expect(within(line).getByText("FHSA")).toHaveClass("tr-fhsa-label");
  expect(within(line).getByText("About $5,000 of FHSA room left this year")).toBeInTheDocument();
  expect(line.textContent).not.toContain(" · ");
  expect(line).toHaveTextContent("(est.; includes US$1,000 converted at the Bank of Canada rate of 2026-03-02)");
  for (const d of ["Based on activity up to 24 October 2026; deposits made since then aren't included", "Withdrawals are counted as taxable withdrawals", "An amount over from last year isn't included; CRA My Account shows it."]) {
    expect(line).toHaveTextContent(d);
  }
  // Under the TFSA card's own lines.
  const tfsa = screen.getByText("About $1,500 of TFSA room left this year");
  expect(tfsa.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("an FHSA with a managed account not counted says so under its headline", async () => {
  await open(known({ fhsa: { status: "known", year: 2026, headline: "About $8,000 of FHSA room left this year", notCounted: [{ accountKey: "4".repeat(16), label: "Managed FHSA" }] } }));
  expect(screen.getByRole("group", { name: "FHSA room" })).toHaveTextContent("Not counted: Managed FHSA. Contributions to it aren't visible through SnapTrade. If you contributed to it this year, your room is lower than this.");
});

test("an FHSA over its room, or missing its room", async () => {
  await open(known({ fhsa: { status: "known", year: 2026, headline: "About $1,000 over your FHSA room since 10 June", overLimitCad: 1000 } }));
  expect(within(screen.getByRole("group", { name: "FHSA room" })).getByText("About $1,000 over your FHSA room since 10 June")).toBeInTheDocument();
  expect(screen.getByText("CRA charges 1% a month on the highest amount over in each month. Check your figures in CRA My Account.")).toBeInTheDocument();
  cleanup();
  await open(known({ fhsa: { status: "missing", year: 2026, headline: "I can't give a number yet", missing: [{ kind: "fhsa_room" }] } }));
  expect(within(screen.getByRole("group", { name: "FHSA room" })).getByText("I can't give a number yet: your FHSA participation room for 2026, from CRA My Account or your notice of assessment")).toBeInTheDocument();
});
