import { fireEvent, render, screen } from "@testing-library/preact";
import { BrandFooter, InfoPopover, Money, Segmented, Tile, ViewControls, shortSymbol } from "./components";

test("segmented control reports changes and marks the active option", () => {
  const changes: string[] = [];
  render(<Segmented label="Period" options={["1M", "YTD"] as const} value="YTD" onChange={(v) => changes.push(v)} />);
  expect(screen.getByRole("radio", { name: "YTD" })).toHaveAttribute("aria-checked", "true");
  fireEvent.click(screen.getByRole("radio", { name: "1M" }));
  expect(changes).toEqual(["1M"]);
});
test("segmented control uses roving tabindex and arrow-key selection", () => {
  const changes: string[] = [];
  render(
    <Segmented label="Period" options={["1M", "YTD", "1Y"] as const} value="YTD" onChange={(v) => changes.push(v)} />,
  );
  const ytd = screen.getByRole("radio", { name: "YTD" });
  const oneM = screen.getByRole("radio", { name: "1M" });
  const oneY = screen.getByRole("radio", { name: "1Y" });
  expect(ytd).toHaveAttribute("tabindex", "0");
  expect(oneM).toHaveAttribute("tabindex", "-1");
  expect(oneM).toHaveAttribute("aria-checked", "false");
  expect(oneY).toHaveAttribute("tabindex", "-1");
  expect(oneY).toHaveAttribute("aria-checked", "false");
  fireEvent.keyDown(ytd, { key: "ArrowRight" });
  expect(changes).toEqual(["1Y"]);
  expect(document.activeElement).toBe(oneY);
  fireEvent.keyDown(ytd, { key: "End" });
  expect(changes).toEqual(["1Y", "1Y"]);
  fireEvent.keyDown(ytd, { key: "Home" });
  expect(changes).toEqual(["1Y", "1Y", "1M"]);
  fireEvent.keyDown(ytd, { key: "ArrowLeft" });
  expect(changes).toEqual(["1Y", "1Y", "1M", "1M"]);
  fireEvent.keyDown(oneM, { key: "ArrowLeft" });
  expect(changes).toEqual(["1Y", "1Y", "1M", "1M", "1Y"]);
});
test("info popover toggles its explanation", () => {
  render(<InfoPopover title="S&P 500" body="US large-cap price index, in CAD terms." />);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /about s&p 500/i }));
  expect(screen.getByRole("dialog")).toHaveTextContent("US large-cap price index");
});
test("info popover links button and dialog and closes on Escape with focus return", () => {
  render(<InfoPopover title="S&P 500" body="US large-cap price index, in CAD terms." />);
  const button = screen.getByRole("button", { name: /about s&p 500/i });
  fireEvent.click(button);
  const dialog = screen.getByRole("dialog");
  expect(button.getAttribute("aria-controls")).toBeTruthy();
  expect(dialog.id).toBe(button.getAttribute("aria-controls"));
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(button);
});
test("info popover closes on Escape pressed anywhere and on a click outside", () => {
  render(<><InfoPopover title="S&P 500" body="US large-cap price index." /><p>outside</p></>);
  const button = screen.getByRole("button", { name: /about s&p 500/i });
  fireEvent.click(button);
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(button);
  fireEvent.pointerDown(screen.getByText("outside"));
  expect(screen.queryByRole("dialog")).toBeNull();
});
test("money blurs amounts in privacy mode but keeps an accessible label", () => {
  render(<Money amount={1204.18} currency="CAD" privacy />);
  const el = screen.getByLabelText("Hidden amount");
  expect(el).not.toHaveTextContent("1,204");
  expect(screen.getByRole("img", { name: "Hidden amount" })).toBe(el);
});
test("tile renders label and value", () => {
  render(<Tile label="Cash" value="$7,710" />);
  expect(screen.getByText("Cash")).toBeInTheDocument();
});

test("a disabled segmented control never reports changes", () => {
  const changes: string[] = [];
  render(<Segmented label="Period" disabled options={["1M", "YTD", "1Y"] as const} value="YTD" onChange={(v) => changes.push(v)} />);
  const ytd = screen.getByRole("radio", { name: "YTD" });
  fireEvent.click(screen.getByRole("radio", { name: "1M" }));
  fireEvent.keyDown(ytd, { key: "ArrowRight" });
  fireEvent.keyDown(ytd, { key: "End" });
  expect(changes).toEqual([]);
});

import { Tabs } from "./components";

test("tabs select on click and arrow keys with correct aria-selected", () => {
  const changes: string[] = [];
  render(<Tabs label="View" options={["Growth", "Drawdown", "Months"] as const} value="Growth" onChange={(v) => changes.push(v)} />);
  expect(screen.getByRole("tablist", { name: "View" })).toBeInTheDocument();
  const growth = screen.getByRole("tab", { name: "Growth" });
  expect(growth).toHaveAttribute("aria-selected", "true");
  expect(growth).toHaveAttribute("tabindex", "0");
  expect(screen.getByRole("tab", { name: "Months" })).toHaveAttribute("aria-selected", "false");
  expect(screen.getByRole("tab", { name: "Months" })).toHaveAttribute("tabindex", "-1");
  fireEvent.click(screen.getByRole("tab", { name: "Months" }));
  fireEvent.keyDown(growth, { key: "ArrowRight" });
  fireEvent.keyDown(growth, { key: "ArrowLeft" });
  expect(changes).toEqual(["Months", "Drawdown", "Months"]);
});

test("tabs expose ids and aria-controls only when idPrefix is given", () => {
  const { unmount } = render(<Tabs label="View" idPrefix="p1" options={["A", "B"] as const} value="A" onChange={() => {}} />);
  expect(screen.getByRole("tab", { name: "B" })).toHaveAttribute("id", "p1-tab-1");
  expect(screen.getByRole("tab", { name: "B" })).toHaveAttribute("aria-controls", "p1-panel-1");
  unmount();
  render(<Tabs label="View" options={["A", "B"] as const} value="A" onChange={() => {}} />);
  expect(screen.getByRole("tab", { name: "B" })).not.toHaveAttribute("id");
});

test("InfoPopover shifts back inside the widget when it would overflow the left edge", async () => {
  const proto = HTMLElement.prototype as any;
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    return this.getAttribute("role") === "dialog" ? { left: -120, right: 160, top: 0, bottom: 80, width: 280, height: 80 } : original.call(this);
  };
  try {
    render(<InfoPopover title="Investment return" body="How your investments performed." />);
    fireEvent.click(screen.getByRole("button", { name: "About Investment return" }));
    expect(screen.getByRole("dialog").style.transform).toBe("translateX(128px)");
  } finally {
    proto.getBoundingClientRect = original;
  }
});

test("a disabled option can be neither clicked nor reached by keyboard", () => {
  const changes: string[] = [];
  render(<Segmented label="Currency" disabledOptions={["All"] as const} options={["CAD", "All"] as const} value="CAD" onChange={(v) => changes.push(v)} />);
  expect(screen.getByRole("radio", { name: "All" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("radio", { name: "CAD" }), { key: "ArrowRight" });
  expect(changes).toEqual([]);
});

test("brand footer names VestLens, says read-only and carries the advice disclaimer by default", () => {
  const { container } = render(<BrandFooter />);
  expect(container.querySelector(".w-brand")).toHaveTextContent("VestLens Read-only. Not investment advice.");
});
test("brand footer drops its advice line when the widget has its own", () => {
  const { container } = render(<BrandFooter advice={false} />);
  expect(container.querySelector(".w-brand")).toHaveTextContent(/^VestLens Read-only\.$/);
});

test("shortSymbol drops only Canadian exchange suffixes", () => {
  expect(["XEQT.TO", "ABC.V", "XYZ.NE", "QQQ.CN", "AAPL", "BRK.B"].map(shortSymbol)).toEqual(["XEQT", "ABC", "XYZ", "QQQ", "AAPL", "BRK.B"]);
});

test("ViewControls: a lock with Read-only (no emoji) and text toggles with the same accessible names", () => {
  const onPrivacy = vi.fn(); const onCad = vi.fn();
  const { container } = render(<ViewControls privacy={false} onPrivacy={onPrivacy} cadOn={true} onCadChange={onCad} />);
  expect(container.querySelector(".w-ro")).toHaveTextContent(/^Read-only$/);
  expect(container.querySelector(".w-ro svg")).toHaveAttribute("aria-hidden", "true");
  expect(container.textContent).not.toMatch(/\u{1F512}/u);
  fireEvent.click(screen.getByRole("button", { name: "Hide amounts" }));
  expect(onPrivacy).toHaveBeenCalledWith(true);
  const cur = screen.getByRole("button", { name: "Show original currencies" });
  expect(cur).toHaveTextContent("Original currencies");
  expect(cur).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(cur);
  expect(onCad).toHaveBeenCalledWith(false);
});

test("ViewControls without a currency view: Hide amounts only", () => {
  const onPrivacy = vi.fn();
  render(<ViewControls privacy={true} onPrivacy={onPrivacy} />);
  expect(screen.queryByRole("button", { name: "Show original currencies" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show amounts" }));
  expect(onPrivacy).toHaveBeenCalledWith(false);
});
