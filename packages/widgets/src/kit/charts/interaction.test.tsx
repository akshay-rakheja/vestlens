import { fireEvent, render } from "@testing-library/preact";
import { AreaChart } from "./AreaChart";
import { DrawdownChart } from "./DrawdownChart";
import { GrowthChart } from "./GrowthChart";
import { IntradayChart } from "./IntradayChart";
import { PriceMarkerChart } from "./PriceMarkerChart";

// jsdom reports a zero-sized plot, so the frame maps clientX straight onto the 300-unit viewBox.
const plot = (c: Element) => c.querySelector("[data-chart-plot]") as HTMLElement;
const tip = (c: Element) => c.querySelector("[data-chart-tip]") as HTMLElement | null;
const hover = (c: Element, x: number, pointerType = "mouse") => fireEvent.pointerMove(plot(c), { clientX: x, pointerType });
const yLabels = (c: Element) => [...c.querySelectorAll("[data-axis='y'] span")].map((e) => e.textContent);
const xLabels = (c: Element) => [...c.querySelectorAll("[data-axis='x'] span")].map((e) => e.textContent);
const legend = (c: Element) => [...c.querySelectorAll("[data-chart-legend] [data-legend]")].map((e) => e.textContent);
const live = (c: Element) => c.querySelector("[aria-live='polite']")?.textContent ?? "";

const values = [
  { date: "2026-01-02", value: 100000, source: "reported" as const },
  { date: "2026-06-01", value: 110000, source: "estimated" as const },
  { date: "2026-10-14", value: 200000, source: "reported" as const },
];

test("value chart labels the y axis with compact money at max, mid and min, and the x axis at start, mid and end", () => {
  const { container } = render(<AreaChart label="Value YTD" points={values} currency="CAD" seriesLabel="Your portfolio value (includes deposits)" />);
  expect(yLabels(container)).toEqual(["$200k", "$150k", "$100k"]);
  expect(xLabels(container)).toEqual(["Jan 2", "Jun 1", "Oct 14"]);
  expect(container.querySelector("[data-axis='x'] span.w-ax-mid")).not.toBeNull();
  expect(container.querySelectorAll("line[data-grid]").length).toBe(3);
});

test("the legend names every series", () => {
  const { container } = render(<AreaChart label="Return" mode="return" points={values} seriesLabel="Your investment return" benchmarkLabel="S&P 500"
    benchmark={[{ date: "2026-01-02", returnFraction: 0 }, { date: "2026-10-14", returnFraction: 0.1 }]} />);
  expect(legend(container)).toEqual(["Your investment return", "S&P 500"]);
  expect(container.querySelector("[data-legend='benchmark'] i")?.getAttribute("data-dash")).toBe("dashed");
});

test("pointermove shows the date, value and change for the nearest point, and says est. for a non-reported point", () => {
  const { container } = render(<AreaChart label="Value YTD" points={values} currency="CAD" />);
  expect(tip(container)).toBeNull();
  hover(container, 150);
  const text = tip(container)!.textContent!;
  expect(text).toContain("Jun 1");
  expect(text).toContain("Value $110,000.00 est.");
  expect(text).toContain("Since start +10.0% (+$10,000.00)");
  expect(live(container)).toContain("Value $110,000.00 est.");
  expect(container.querySelector("line[data-crosshair]")).not.toBeNull();
  expect(container.querySelectorAll("circle[data-crosshair-dot]").length).toBe(1);
});

test("a reported point carries no est. tag", () => {
  const { container } = render(<AreaChart label="Value YTD" points={values} currency="CAD" />);
  hover(container, 299);
  expect(tip(container)!.textContent).toContain("Oct 14");
  expect(tip(container)!.textContent).not.toContain("est.");
});

test("privacy hides money in the tooltip and on the axis but keeps percentages", () => {
  const { container } = render(<AreaChart label="Value YTD" points={values} currency="CAD" privacy />);
  hover(container, 299);
  const text = tip(container)!.textContent!;
  expect(text).toContain("Value ••••");
  expect(text).toContain("Since start +100.0%");
  expect(text).not.toMatch(/\$/);
  expect(yLabels(container)).toEqual(["••••", "••••", "••••"]);
  expect(live(container)).not.toMatch(/\$/);
});

test("touch works and survives the pointerleave that follows a tap; a tap outside hides it", () => {
  const { container } = render(<div><AreaChart label="Value YTD" points={values} currency="CAD" /><button type="button">elsewhere</button></div>);
  fireEvent.pointerDown(plot(container), { clientX: 2, pointerType: "touch" });
  expect(tip(container)!.textContent).toContain("Jan 2");
  fireEvent.pointerLeave(plot(container), { pointerType: "touch" });
  expect(tip(container)).not.toBeNull();
  fireEvent.pointerDown(container.querySelector("button")!, { pointerType: "touch" });
  expect(tip(container)).toBeNull();
});

test("pointerleave hides the tooltip", () => {
  const { container } = render(<AreaChart label="Value YTD" points={values} currency="CAD" />);
  hover(container, 150);
  expect(tip(container)).not.toBeNull();
  fireEvent.pointerLeave(plot(container), { pointerType: "mouse" });
  expect(tip(container)).toBeNull();
  expect(live(container)).toBe("");
});

test("arrow keys move the crosshair and Escape hides it", () => {
  const { container } = render(<AreaChart label="Value YTD" points={values} currency="CAD" />);
  const svg = container.querySelector("svg[role='img']")!;
  fireEvent.keyDown(svg, { key: "ArrowRight" });
  expect(tip(container)!.textContent).toContain("Jan 2");
  fireEvent.keyDown(svg, { key: "ArrowRight" });
  expect(tip(container)!.textContent).toContain("Jun 1");
  fireEvent.keyDown(svg, { key: "ArrowLeft" });
  expect(tip(container)!.textContent).toContain("Jan 2");
  fireEvent.keyDown(svg, { key: "End" });
  expect(tip(container)!.textContent).toContain("Oct 14");
  fireEvent.keyDown(svg, { key: "Escape" });
  expect(tip(container)).toBeNull();
});

test("the tooltip stays inside the chart at both edges", () => {
  const { container } = render(<AreaChart label="Value YTD" points={values} currency="CAD" />);
  hover(container, 0);
  expect(tip(container)!.style.left).toBe("0%");
  hover(container, 300);
  expect(tip(container)!.style.left).toBe("100%");
  expect(tip(container)!.style.transform).toBe("translateX(-100%)");
});

test("return chart tooltip shows both returns since the start", () => {
  const index = [
    { date: "2026-01-02", value: 1, source: "reported" as const },
    { date: "2026-06-01", value: 1.05, source: "reported" as const },
    { date: "2026-10-14", value: 1.2, source: "reported" as const },
  ];
  const { container } = render(<AreaChart label="Return" mode="return" points={index} seriesLabel="Your investment return" benchmarkLabel="S&P 500"
    benchmark={[{ date: "2026-01-02", returnFraction: 0 }, { date: "2026-06-01", returnFraction: 0.03 }, { date: "2026-10-14", returnFraction: 0.1 }]} />);
  expect(yLabels(container)).toEqual(["+20.0%", "+10.0%", "0.0%"]);
  hover(container, 150);
  const text = tip(container)!.textContent!;
  expect(text).toContain("Your investment return +5.0%");
  expect(text).toContain("S&P 500 +3.0%");
  expect(container.querySelectorAll("circle[data-crosshair-dot]").length).toBe(2);
});

test("growth chart tooltip shows value, money put in and the market gain", () => {
  const value = [
    { date: "2026-01-02", value: 1000, source: "reported" as const },
    { date: "2026-06-01", value: 1500, source: "reported" as const },
    { date: "2026-10-14", value: 1800, source: "reported" as const },
  ];
  const { container } = render(<GrowthChart label="Growth" value={value} baseline={1000} deposits={[{ date: "2026-03-01", value: 200 }]} currency="CAD" />);
  expect(legend(container)).toEqual(["Your portfolio value", "Money you put in"]);
  hover(container, 150);
  const text = tip(container)!.textContent!;
  expect(text).toContain("Jun 1");
  expect(text).toContain("Value $1,500.00");
  expect(text).toContain("Money put in $1,200.00");
  expect(text).toContain("Market gain +$300.00");
  expect(text).toContain("Since start +50.0%");
});

test("growth chart without deposit history has a single legend entry and no money-put-in line in the tooltip", () => {
  const value = [{ date: "2026-01-02", value: 1000, source: "reported" as const }, { date: "2026-10-14", value: 1800, source: "reported" as const }];
  const { container } = render(<GrowthChart label="Growth" value={value} baseline={1000} deposits={null} currency="CAD" privacy />);
  expect(legend(container)).toEqual(["Your portfolio value"]);
  hover(container, 300);
  expect(tip(container)!.textContent).not.toMatch(/Money put in|\$/);
});

test("drawdown chart tooltip shows the drawdown at that date", () => {
  const index = [1, 1.1, 0.99, 1.05].map((value, i) => ({ date: `2026-01-0${i + 1}`, value }));
  const { container } = render(<DrawdownChart label="Drawdown" index={index} />);
  expect(yLabels(container)).toEqual(["0.0%", "−5.0%", "−10.0%"]);
  hover(container, 200);
  expect(tip(container)!.textContent).toContain("Jan 3");
  expect(tip(container)!.textContent).toContain("Drawdown −10.0%");
});

test("intraday chart shows times on the axis and the estimated value and change since the open", () => {
  const pts = [{ t: "2026-10-15T13:30:00Z", value: 1000 }, { t: "2026-10-15T16:45:00Z", value: 1010 }, { t: "2026-10-15T20:00:00Z", value: 1020 }];
  const { container } = render(<IntradayChart label="Today" points={pts} currency="CAD" />);
  expect(xLabels(container)).toEqual(["9:30 a.m.", "12:45 p.m.", "4:00 p.m."]);
  expect(legend(container)).toEqual(["Your portfolio value (estimated)"]);
  hover(container, 150);
  const text = tip(container)!.textContent!;
  expect(text).toContain("12:45 p.m.");
  expect(text).toContain("Est. value $1,010.00");
  expect(text).toContain("Since open +1.0% (+$10.00)");
});

const prices = [{ date: "2026-09-01", close: 10 }, { date: "2026-09-02", close: 11 }, { date: "2026-09-03", close: 12 }, { date: "2026-09-04", close: 11 }];
const markers = [{ date: "2026-09-02", side: "buy" as const, units: 5, price: 10.9 }, { date: "2026-09-04", side: "sell" as const, units: 3, price: null }];
const cost = [{ date: "2026-09-01", avgCost: null }, { date: "2026-09-02", avgCost: 10.5 }];

test("price chart tooltip shows the close, a trade on that date and the average cost", () => {
  const { container } = render(<PriceMarkerChart label="XEQT trades" prices={prices} avgCost={cost} markers={markers} currency="CAD" />);
  expect(legend(container)).toEqual(["Price (close)", "Average cost", "Buy", "Sell"]);
  hover(container, 100);
  const text = tip(container)!.textContent!;
  expect(text).toContain("Sep 2");
  expect(text).toContain("Close $11.00");
  expect(text).toContain("Bought 5 at $10.90");
  expect(text).toContain("Avg cost $10.50");
  expect(text).not.toContain("XEQT");
  hover(container, 300);
  expect(tip(container)!.textContent).toContain("Sold 3");
});

test("price chart tooltip hides units, trade prices and average cost in privacy mode", () => {
  const { container } = render(<PriceMarkerChart label="XEQT trades" prices={prices} avgCost={cost} markers={markers} currency="CAD" privacy />);
  hover(container, 100);
  const text = tip(container)!.textContent!;
  expect(text).toContain("Close $11.00");
  expect(text).toContain("Bought •••• at ••••");
  expect(text).toContain("Avg cost ••••");
  expect(text).not.toMatch(/10\.90|10\.50|Bought 5/);
});
