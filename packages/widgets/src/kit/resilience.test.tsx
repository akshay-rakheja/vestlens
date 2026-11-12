import { act, fireEvent, render, screen } from "@testing-library/preact";
import type { Bridge, ToolResult } from "./bridge";
import { HYDRATE_WATCHDOG_MS, WidgetGuard, useHydrateWatchdog } from "./resilience";

function bridgeWith(callTool: Bridge["callTool"]): Bridge {
  return {
    ready: Promise.resolve({ hostTools: true, context: {} }),
    onToolResult: () => () => {}, onContext: () => () => {}, toolArguments: () => ({}), openLink: async () => true,
    callTool, sendMessage: async () => {}, updateModelContext: async () => {}, destroy: () => {},
  };
}

test("the error boundary shows a value-free fallback when a child throws", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const bridge = bridgeWith(vi.fn(async () => ({})));
  function Bomb(): never { throw new Error("balance 12345.67 acct-secret"); }
  render(<WidgetGuard bridge={bridge} showTool="show_x">{() => <Bomb />}</WidgetGuard>);
  expect(screen.getByText("Couldn't display this view.")).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("12345.67");
  spy.mockRestore();
});

test("Try again re-runs the show tool with the model's original arguments and remounts the child with the result", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const result: ToolResult = { structuredContent: { ok: true } };
  const callTool = vi.fn(async () => result);
  const bridge = { ...bridgeWith(callTool), toolArguments: () => ({ symbol: "GOOG" }) };
  let first = true;
  function Child({ seed }: { seed: ToolResult | null }) {
    if (first) { first = false; throw new Error("boom"); }
    return <div>{seed ? "recovered" : "no seed"}</div>;
  }
  render(<WidgetGuard bridge={bridge} showTool="show_x">{(seed) => <Child seed={seed} />}</WidgetGuard>);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(callTool).toHaveBeenCalledWith("show_x", { symbol: "GOOG" });
  expect(await screen.findByText("recovered")).toBeInTheDocument();
  spy.mockRestore();
});

describe("hydrate watchdog", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  function Probe({ bridge, has }: { bridge: Bridge; has: () => boolean }) {
    return <div>{useHydrateWatchdog(bridge, has) ? "stalled" : "waiting"}</div>;
  }
  test("flags a stall 30 s after initialize when nothing has hydrated (slow tools are not failures)", async () => {
    expect(HYDRATE_WATCHDOG_MS).toBe(30_000);
    render(<Probe bridge={bridgeWith(vi.fn())} has={() => false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(screen.getByText("waiting")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(21_900); });
    expect(screen.getByText("waiting")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(screen.getByText("stalled")).toBeInTheDocument();
  });
  test("does not flag when data arrived in time", async () => {
    render(<Probe bridge={bridgeWith(vi.fn())} has={() => true} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(screen.getByText("waiting")).toBeInTheDocument();
  });
});
