import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import type { Bridge, ToolResult } from "./bridge";
import { CurrencySwitch, useCadView } from "./currency-switch";

function bridgeWith(callTool: Bridge["callTool"]): Bridge {
  return {
    ready: Promise.resolve({ hostTools: true, context: {} }),
    onToolResult: () => () => {}, onContext: () => () => {}, toolArguments: () => ({}), openLink: async () => true,
    callTool, sendMessage: async () => {}, updateModelContext: async () => {}, destroy: () => {},
  };
}

function Probe({ bridge, settings }: { bridge: Bridge; settings: { cadView?: boolean } | undefined }) {
  const [on, setOn] = useCadView(bridge, settings);
  return <div><span data-testid="state">{String(on)}</span><CurrencySwitch on={on} onChange={setOn} /></div>;
}

test("defaults to on when settings lack the field", () => {
  render(<Probe bridge={bridgeWith(vi.fn(async () => ({})))} settings={{}} />);
  expect(screen.getByTestId("state")).toHaveTextContent("true");
  expect(screen.getByRole("button", { name: "Show original currencies" })).toHaveAttribute("aria-pressed", "false");
});

test("defaults to on when settings are missing, and honours an explicit false", () => {
  const { unmount } = render(<Probe bridge={bridgeWith(vi.fn(async () => ({})))} settings={undefined} />);
  expect(screen.getByTestId("state")).toHaveTextContent("true");
  unmount();
  render(<Probe bridge={bridgeWith(vi.fn(async () => ({})))} settings={{ cadView: false }} />);
  expect(screen.getByTestId("state")).toHaveTextContent("false");
});

test("clicking saves cadView false and the label shows pressed", async () => {
  const callTool = vi.fn(async (): Promise<ToolResult> => ({}));
  render(<Probe bridge={bridgeWith(callTool)} settings={{}} />);
  fireEvent.click(screen.getByRole("button", { name: "Show original currencies" }));
  expect(callTool).toHaveBeenCalledWith("save_portfolio_settings", { cadView: false });
  expect(screen.getByTestId("state")).toHaveTextContent("false");
  expect(screen.getByRole("button", { name: "Show original currencies" })).toHaveAttribute("aria-pressed", "true");
});

test("a rejected call reverts to on", async () => {
  const callTool = vi.fn(async (): Promise<ToolResult> => { throw new Error("nope"); });
  render(<Probe bridge={bridgeWith(callTool)} settings={{}} />);
  fireEvent.click(screen.getByRole("button", { name: "Show original currencies" }));
  await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("true"));
});

test("an isError result reverts like a rejection", async () => {
  const callTool = vi.fn(async (): Promise<ToolResult> => ({ isError: true }));
  render(<Probe bridge={bridgeWith(callTool)} settings={{}} />);
  fireEvent.click(screen.getByRole("button", { name: "Show original currencies" }));
  await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("true"));
});

function deferred() {
  let resolve!: (r: ToolResult) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<ToolResult>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function twoClicks(outcomes: Array<"ok" | "fail">) {
  const calls = outcomes.map(() => deferred());
  let i = 0;
  const callTool = vi.fn(() => calls[i++]!.promise);
  render(<Probe bridge={bridgeWith(callTool)} settings={{}} />);
  const button = () => screen.getByRole("button", { name: "Show original currencies" });
  fireEvent.click(button()); fireEvent.click(button());
  expect(screen.getByTestId("state")).toHaveTextContent("true");
  for (let k = 0; k < calls.length; k++) {
    if (outcomes[k] === "ok") calls[k]!.resolve({}); else calls[k]!.reject(new Error("x"));
    await Promise.resolve(); await Promise.resolve();
  }
}

test("two failing clicks end at the server-confirmed value", async () => {
  await twoClicks(["fail", "fail"]);
  await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("true"));
});
test("first fails, second succeeds: ends at the second value", async () => {
  await twoClicks(["fail", "ok"]);
  await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("true"));
});
test("first succeeds, second fails: ends at the first value", async () => {
  await twoClicks(["ok", "fail"]);
  await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("false"));
});

test("adopts settings that arrive after mount, but a stale object does not undo a local toggle", async () => {
  const bridge = bridgeWith(vi.fn(async () => ({})));
  const { rerender } = render(<Probe bridge={bridge} settings={undefined} />);
  expect(screen.getByTestId("state")).toHaveTextContent("true");
  const arrived = { cadView: false };
  rerender(<Probe bridge={bridge} settings={arrived} />);
  await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("false"));
  fireEvent.click(screen.getByRole("button", { name: "Show original currencies" }));
  expect(screen.getByTestId("state")).toHaveTextContent("true");
  rerender(<Probe bridge={bridge} settings={arrived} />);
  rerender(<Probe bridge={bridge} settings={{ cadView: false }} />);
  await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("true"));
});

test("the setter resolves true on success and false on a rejection or isError", async () => {
  let set!: (next: boolean) => Promise<boolean>;
  const Grab = ({ bridge }: { bridge: Bridge }) => { [, set] = useCadView(bridge, {}); return null; };
  for (const [impl, want] of [
    [async (): Promise<ToolResult> => ({}), true],
    [async (): Promise<ToolResult> => { throw new Error("nope"); }, false],
    [async (): Promise<ToolResult> => ({ isError: true }), false],
  ] as const) {
    const { unmount } = render(<Grab bridge={bridgeWith(vi.fn(impl))} />);
    expect(await set(false)).toBe(want);
    unmount();
  }
});
