import { render, screen } from "@testing-library/preact";
import { AllocationBar } from "./AllocationBar";
import { AreaChart } from "./AreaChart";
import { IntradayChart } from "./IntradayChart";
import { PriceMarkerChart } from "./PriceMarkerChart";

const points = [
  { date: "2026-01-02", value: 100, source: "reported" as const },
  { date: "2026-06-01", value: 110, source: "reconstructed" as const },
  { date: "2026-10-14", value: 120, source: "reported" as const },
];

test("area chart draws the portfolio and benchmark paths with a text alternative", () => {
  const { container } = render(<AreaChart label="Value YTD" points={points} benchmark={[{ date: "2026-01-02", returnFraction: 0 }, { date: "2026-10-14", returnFraction: 0.1 }]} />);
  expect(screen.getByRole("img", { name: /Value YTD: \+20\.0%.*benchmark \+10\.0%/ })).toBeInTheDocument();
  expect(container.querySelectorAll("path[data-series='portfolio']").length).toBe(1);
  expect(container.querySelectorAll("path[data-series='benchmark']").length).toBe(1);
  expect(container.querySelectorAll("circle[data-source='reconstructed']").length).toBe(1);
});

test("area chart with a single point renders an empty state, not a line", () => {
  render(<AreaChart label="Value YTD" points={[points[0]]} />);
  expect(screen.getByText(/not enough value history for this period/i)).toBeInTheDocument();
});

test("allocation bar renders proportional segments and a legend", () => {
  const { container } = render(<AllocationBar label="Allocation" slices={[{ key: "etf", label: "ETFs", fraction: 0.58 }, { key: "cash", label: "Cash", fraction: 0.42 }]} />);
  const segments = container.querySelectorAll("[data-slice]");
  expect((segments[0] as HTMLElement).style.width).toBe("58%");
  expect(screen.getByText("ETFs 58%")).toBeInTheDocument();
});

const benchmarkEnds = [{ date: "2026-01-02", returnFraction: 0 }, { date: "2026-10-14", returnFraction: 0.1 }];

test("benchmark is rebased to its first in-range point", () => {
  render(<AreaChart label="Value YTD" points={points} benchmark={[{ date: "2026-01-02", returnFraction: 0.05 }, { date: "2026-10-14", returnFraction: 0.15 }]} />);
  expect(screen.getByRole("img", { name: /benchmark \+9\.5%/ })).toBeInTheDocument();
});

test("benchmark points outside the portfolio range are dropped", () => {
  render(<AreaChart label="Value YTD" points={points} benchmark={[{ date: "2025-12-01", returnFraction: 0.5 }, { date: "2026-01-02", returnFraction: 0 }, { date: "2026-10-14", returnFraction: 0.1 }, { date: "2027-01-01", returnFraction: 0.9 }]} />);
  expect(screen.getByRole("img", { name: /benchmark \+10\.0%/ })).toBeInTheDocument();
});

test("a benchmark with fewer than two in-range points is not drawn", () => {
  const { container } = render(<AreaChart label="Value YTD" points={points} benchmark={[{ date: "2025-12-01", returnFraction: 0.5 }, { date: "2026-10-14", returnFraction: 0.1 }]} />);
  expect(container.querySelectorAll("path[data-series='benchmark']").length).toBe(0);
});

test("unsorted points are sorted by date before plotting", () => {
  render(<AreaChart label="Value YTD" points={[points[2], points[0], points[1]]} />);
  expect(screen.getByRole("img", { name: /Value YTD: \+20\.0%.*\(2026-01-02 to 2026-10-14\)/ })).toBeInTheDocument();
});

test("points with a non-finite value are dropped", () => {
  const { container } = render(<AreaChart label="Value YTD" points={[points[0], { date: "2026-06-01", value: Number.NaN, source: "reported" }, points[2]]} />);
  expect(container.querySelector("path[data-series='portfolio']")?.getAttribute("d")).not.toMatch(/NaN/);
  expect(screen.getByRole("img", { name: /Value YTD: \+20\.0%/ })).toBeInTheDocument();
});

test("an estimated point gets a dashed marker and a legend entry", () => {
  const { container } = render(<AreaChart label="Value YTD" points={[points[0], { date: "2026-06-01", value: 110, source: "estimated" }, points[2]]} />);
  const marker = container.querySelector("circle[data-source='estimated']");
  expect(marker?.getAttribute("stroke-dasharray")).toBe("2 2");
  expect(screen.getByText(/◌ estimated/)).toBeInTheDocument();
  expect(screen.getByText(/values rebuilt from activity\/prices, not brokerage-reported/)).toBeInTheDocument();
});

test("the chart is keyboard focusable", () => {
  const { container } = render(<AreaChart label="Value YTD" points={points} />);
  expect(container.querySelector("svg")?.getAttribute("tabindex")).toBe("0");
});

test("allocation bar normalises fractions to sum to one", () => {
  const { container } = render(<AllocationBar label="Allocation" slices={[{ key: "a", label: "A", fraction: 0.5 }, { key: "b", label: "B", fraction: 0.25 }]} />);
  const segments = container.querySelectorAll("[data-slice]");
  expect((segments[0] as HTMLElement).style.width).toBe("67%");
  expect((segments[1] as HTMLElement).style.width).toBe("33%");
});

test("allocation bar renders nothing without slices", () => {
  const { container } = render(<AllocationBar label="Allocation" slices={[]} />);
  expect(container.innerHTML).toBe("");
});

test("allocation bar swatches are hidden from assistive technology", () => {
  const { container } = render(<AllocationBar label="Allocation" slices={[{ key: "a", label: "A", fraction: 0.5 }, { key: "b", label: "B", fraction: 0.5 }]} />);
  expect(container.querySelectorAll("i[aria-hidden='true']").length).toBe(2);
});

import { DrawdownChart } from "./DrawdownChart";
import { GrowthChart } from "./GrowthChart";
import { Heatmap } from "./Heatmap";

const growthValue = [
  { date: "2026-01-02", value: 1000, source: "reported" as const },
  { date: "2026-06-01", value: 1500, source: "reported" as const },
  { date: "2026-10-14", value: 1800, source: "reported" as const },
];

test("growth chart draws value and deposits paths with a currency-free label", () => {
  const { container } = render(<GrowthChart label="Growth YTD" value={growthValue} baseline={1000} deposits={[{ date: "2026-03-01", value: 200 }]} />);
  expect(container.querySelectorAll("path[data-series='value']").length).toBe(1);
  expect(container.querySelectorAll("path[data-series='deposits']").length).toBe(1);
  const label = container.querySelector("svg")?.getAttribute("aria-label") ?? "";
  expect(label).toContain("Growth YTD");
  expect(label).toContain("2026-01-02 to 2026-10-14");
  expect(label).not.toMatch(/[$]|\d{4},|1000|1800|1200/);
  expect(container.querySelector("path[data-series='deposits']")?.getAttribute("d")).not.toMatch(/NaN/);
});

test("growth chart with fewer than two points shows an empty state", () => {
  render(<GrowthChart label="Growth YTD" value={[growthValue[0]]} baseline={1000} deposits={[]} />);
  expect(screen.getByText(/not enough value history for this period/i)).toBeInTheDocument();
});

test("drawdown chart reports the deepest drawdown from the running peak", () => {
  const index = [1, 1.1, 0.99, 1.05].map((value, i) => ({ date: `2026-01-0${i + 1}`, value }));
  render(<DrawdownChart label="Drawdown" index={index} />);
  expect(screen.getByRole("img", { name: /Drawdown.*−10\.0%/ })).toBeInTheDocument();
});

test("drawdown chart of a flat index shows 0%", () => {
  const index = [1, 1, 1].map((value, i) => ({ date: `2026-01-0${i + 1}`, value }));
  const { container } = render(<DrawdownChart label="Drawdown" index={index} />);
  expect(screen.getByRole("img", { name: /0\.0%/ })).toBeInTheDocument();
  expect(container.querySelector("path")?.getAttribute("d")).not.toMatch(/NaN/);
});

test("heatmap renders a cell per month, a row per year and flags partial cells", () => {
  const months = [
    { month: "2025-12", return: 0.02, partial: false, estimated: false },
    { month: "2026-01", return: 0.031, partial: false, estimated: false },
    { month: "2026-02", return: -0.1, partial: true, estimated: false },
    { month: "2026-03", return: null, partial: false, estimated: false },
  ];
  const { container } = render(<Heatmap label="Monthly returns" months={months} />);
  expect(container.querySelectorAll("[data-year]").length).toBe(2);
  expect(screen.getByLabelText("Feb 2026: −10.0%")).toHaveAttribute("data-partial", "true");
  expect(screen.getByLabelText("Jan 2026: +3.1%")).toHaveAttribute("data-partial", "false");
  expect(screen.getByLabelText("Feb 2026: −10.0%")).toHaveTextContent("−10%");
  expect(container.querySelectorAll("[data-month]").length).toBe(4);
  expect(screen.getByRole("group", { name: "Monthly returns" })).toBeInTheDocument();
});

test("GrowthChart with null deposits draws no deposits line and no money-put-in text", () => {
  const { container } = render(<GrowthChart label="Growth YTD" value={growthValue} baseline={1000} deposits={null} />);
  expect(container.querySelector('[data-series="deposits"]')).toBeNull();
  expect(screen.getByRole("img").getAttribute("aria-label")).not.toMatch(/money put in/);
  expect(container.querySelector('[data-series="value"]')).not.toBeNull();
});

test("long rebuilt history draws no per-point markers but keeps the legend", () => {
  const points = Array.from({ length: 200 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), value: 100 + i, source: "reconstructed" as const }));
  const { container } = render(<AreaChart label="Value" points={[...points, { date: "2026-07-20", value: 400, source: "reported" }]} />);
  expect(container.querySelectorAll("circle[data-source]").length).toBe(0);
  expect(container.textContent).toContain("reconstructed");
});

const prices = [
  { date: "2026-09-01", close: 10 }, { date: "2026-09-02", close: 11 }, { date: "2026-09-03", close: 12 }, { date: "2026-09-04", close: 11 },
];

test("PriceMarkerChart draws the price line, average-cost path and one marker per trade", () => {
  const { container } = render(<PriceMarkerChart label="XEQT trades" prices={prices}
    avgCost={[{ date: "2026-09-01", avgCost: null }, { date: "2026-09-02", avgCost: 10.5 }, { date: "2026-09-04", avgCost: 11.2 }]}
    markers={[{ date: "2026-09-02", side: "buy", units: 5, price: 10.9 }, { date: "2026-09-03", side: "buy", units: 2, price: null }, { date: "2026-09-04", side: "sell", units: 3, price: 11 }]} />);
  expect(container.querySelectorAll("path[data-series='price']").length).toBe(1);
  expect(container.querySelectorAll("path[data-series='avg-cost']").length).toBe(1);
  expect(container.querySelectorAll("circle[data-side='buy']").length).toBe(2);
  expect(container.querySelectorAll("circle[data-side='sell']").length).toBe(1);
  const label = screen.getByRole("img").getAttribute("aria-label")!;
  expect(label).toBe("XEQT trades: 2 buys, 1 sell (2026-09-01 to 2026-09-04); dashed line shows average cost");
  expect(label).not.toMatch(/\$|10\.9|12/);
});

const manyMarkers = (n: number) => Array.from({ length: n }, () => ({ date: "2026-09-02", side: "buy" as const, units: 1, price: null }));

test("PriceMarkerChart draws all 20 markers at the normal radius", () => {
  const { container } = render(<PriceMarkerChart label="Trades" prices={prices} avgCost={[]} markers={manyMarkers(20)} />);
  const dots = container.querySelectorAll("circle[data-side]");
  expect(dots.length).toBe(20);
  expect(dots[0].getAttribute("r")).toBe("3.2");
  expect(container.querySelector("path[data-series='avg-cost']")).toBeNull();
});

test("PriceMarkerChart draws all 50 markers with a smaller radius", () => {
  const { container } = render(<PriceMarkerChart label="Trades" prices={prices} avgCost={[]} markers={manyMarkers(50)} />);
  const dots = container.querySelectorAll("circle[data-side]");
  expect(dots.length).toBe(50);
  expect(dots[0].getAttribute("r")).toBe("2");
  expect(screen.getByRole("img").getAttribute("aria-label")).not.toMatch(/latest/);
});

test("PriceMarkerChart puts a marker on the price line at its date, ignoring the trade price", () => {
  const { container } = render(<PriceMarkerChart label="Trades" height={110} prices={prices} avgCost={[]} markers={[{ date: "2026-09-03", side: "sell", units: 1, price: 500 }]} />);
  const dot = container.querySelector("circle[data-side='sell']")!;
  const d = container.querySelector("path[data-series='price']")!.getAttribute("d")!;
  const third = d.split(" ")[2]; // L{x},{y} for 2026-09-03
  const [lx, ly] = third.slice(1).split(",").map(Number);
  expect(Number(dot.getAttribute("cy"))).toBeCloseTo(ly, 1);
  expect(parseFloat(dot.getAttribute("cx")!)).toBeCloseTo((lx / 300) * 100, 1);
  // The y range is the price range only: the 500 trade price does not flatten the line.
  expect(ly).toBeLessThan(7);
});

test("PriceMarkerChart breaks the average-cost line where cost is unknown", () => {
  const { container } = render(<PriceMarkerChart label="Trades" prices={prices} markers={[]}
    avgCost={[{ date: "2026-09-01", avgCost: 10 }, { date: "2026-09-02", avgCost: null }, { date: "2026-09-03", avgCost: 11 }]} />);
  const d = container.querySelector("path[data-series='avg-cost']")!.getAttribute("d")!;
  expect(d.match(/M/g)!.length).toBe(2);
});

test("PriceMarkerChart clamps an average-cost entry dated before the series start", () => {
  const { container } = render(<PriceMarkerChart label="Trades" prices={prices} markers={[]}
    avgCost={[{ date: "2026-08-01", avgCost: 9 }, { date: "2026-08-15", avgCost: 9.5 }, { date: "2026-09-02", avgCost: 10 }]} />);
  const d = container.querySelector("path[data-series='avg-cost']")!.getAttribute("d")!;
  expect(d).not.toMatch(/-\d/);
  expect(d.startsWith("M0.0,")).toBe(true);
});

test("PriceMarkerChart with fewer than two prices renders an empty state", () => {
  render(<PriceMarkerChart label="Trades" prices={[prices[0]]} avgCost={[]} markers={[]} />);
  expect(screen.getByText(/price history is not available/i)).toBeInTheDocument();
});

test("IntradayChart aria-label carries the percentage change only", () => {
  const { container } = render(<IntradayChart label="Today (estimated)" points={[{ t: "2026-10-15T14:30:00Z", value: 1000 }, { t: "2026-10-15T15:00:00Z", value: 1010 }, { t: "2026-10-15T15:30:00Z", value: 1020 }]} />);
  expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Today (estimated): +2.0%");
  expect(container.querySelectorAll("path[data-series='intraday']").length).toBe(1);
});

test("IntradayChart with fewer than two points renders an empty state", () => {
  render(<IntradayChart label="Today" points={[{ t: "2026-10-15T14:30:00Z", value: 1 }]} />);
  expect(screen.getByText(/live prices are not available/i)).toBeInTheDocument();
});

test("PriceMarkerChart marker overlay does not clip markers at the first and last date", () => {
  const { container } = render(<PriceMarkerChart label="Trades" prices={prices} avgCost={[]}
    markers={[{ date: "2026-09-01", side: "buy", units: 1, price: null }, { date: "2026-09-04", side: "sell", units: 1, price: null }]} />);
  const overlay = container.querySelector("svg[aria-hidden='true']") as SVGElement;
  expect(overlay.style.overflow).toBe("visible");
});

// ---- DonutChart and StackedBarChart ----
import { cleanup, fireEvent } from "@testing-library/preact";
import { DonutChart } from "./DonutChart";
import { StackedBarChart } from "./StackedBarChart";

const slices = [
  { key: "etf", label: "ETFs", fraction: 0.5, value: 5000, currency: "CAD" },
  { key: "eq", label: "Stocks", fraction: 0.3, value: 3000, currency: "CAD", estimated: true },
  { key: "cash", label: "Cash", fraction: 0.2, value: null },
];
const donutTip = (c: Element) => c.querySelector("[data-chart-tip]") as HTMLElement | null;

test("donut renders one arc per slice with fractions summing to 1, and a legend with percentages", () => {
  const { container } = render(<DonutChart label="Allocation" slices={slices} privacy={false} />);
  const arcs = [...container.querySelectorAll("path[data-slice]")];
  expect(arcs.length).toBe(3);
  const sum = arcs.reduce((s, a) => s + Number(a.getAttribute("data-fraction")), 0);
  expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
  expect(container.querySelector("svg")!.getAttribute("preserveAspectRatio")).not.toBe("none");
  expect([...container.querySelectorAll("[data-chart-legend] [data-legend]")].map((e) => e.textContent)).toEqual(["ETFs 50.0%", "Stocks 30.0%", "Cash 20.0%"]);
  expect(screen.getByRole("group", { name: /Allocation.*ETFs 50\.0%/ })).toBeInTheDocument();
});

test("donut fractions that do not sum to 1 are normalised", () => {
  const { container } = render(<DonutChart label="Allocation" privacy={false} slices={[{ key: "a", label: "A", fraction: 2 }, { key: "b", label: "B", fraction: 2 }]} />);
  const sum = [...container.querySelectorAll("path[data-slice]")].reduce((s, a) => s + Number(a.getAttribute("data-fraction")), 0);
  expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
});

test("a single 100% slice still draws a full ring", () => {
  const { container } = render(<DonutChart label="Allocation" privacy={false} slices={[{ key: "a", label: "A", fraction: 1 }]} />);
  expect(container.querySelector("path[data-slice]")!.getAttribute("d")).not.toMatch(/NaN/);
});

test("hovering or tapping an arc shows label, percent and value; est. is flagged; privacy hides the value", () => {
  const { container } = render(<DonutChart label="Allocation" slices={slices} privacy={false} />);
  expect(donutTip(container)).toBeNull();
  fireEvent.pointerEnter(container.querySelector("path[data-slice='etf']")!, { pointerType: "mouse" });
  expect(donutTip(container)!.textContent).toContain("ETFs");
  expect(donutTip(container)!.textContent).toContain("50.0%");
  expect(donutTip(container)!.textContent).toContain("$5,000.00");
  expect(donutTip(container)!.textContent).not.toContain("est.");
  fireEvent.pointerDown(container.querySelector("path[data-slice='eq']")!, { pointerType: "touch" });
  expect(donutTip(container)!.textContent).toContain("est.");
  fireEvent.pointerLeave(container.querySelector("path[data-slice='eq']")!, { pointerType: "mouse" });
  expect(donutTip(container)).toBeNull();
});

test("donut tooltip hides money when private but keeps the percent", () => {
  const { container } = render(<DonutChart label="Allocation" slices={slices} privacy />);
  fireEvent.pointerEnter(container.querySelector("path[data-slice='etf']")!, { pointerType: "mouse" });
  expect(donutTip(container)!.textContent).toContain("••••");
  expect(donutTip(container)!.textContent).toContain("50.0%");
  expect(donutTip(container)!.textContent).not.toMatch(/\$/);
});

test("donut onSlice fires on click and Enter, and the arcs are keyboard reachable", () => {
  const seen: string[] = [];
  const { container } = render(<DonutChart label="Allocation" slices={slices} privacy={false} onSlice={(k) => seen.push(k)} />);
  const arc = container.querySelector("path[data-slice='cash']")!;
  fireEvent.click(arc);
  fireEvent.keyDown(arc, { key: "Enter" });
  expect(seen).toEqual(["cash", "cash"]);
  fireEvent.focus(arc);
  expect(donutTip(container)!.textContent).toContain("Cash");
  expect(arc.getAttribute("tabindex")).toBe("0");
});

const bars = [
  { key: "2026-01", label: "Jan", parts: [{ series: "ca", value: 30 }, { series: "us", value: 10 }] },
  { key: "2026-02", label: "Feb", parts: [{ series: "ca", value: 60 }, { series: "us", value: 20 }] },
  { key: "2026-03", label: "Mar", parts: [{ series: "ca", value: 15 }] },
];
const series = [{ key: "ca", label: "Canadian" }, { key: "us", label: "US" }];

test("stacked bars draw one stack per bar with heights proportional to value, and axis labels", () => {
  const { container } = render(<StackedBarChart label="Income by month" bars={bars} series={series} currency="CAD" privacy={false} />);
  expect(container.querySelectorAll("g[data-bar]").length).toBe(3);
  const h = (bar: string, s: string) => Number(container.querySelector(`g[data-bar='${bar}'] [data-series='${s}']`)!.getAttribute("data-height"));
  expect(h("2026-02", "ca") / h("2026-01", "ca")).toBeCloseTo(2, 5);
  expect(h("2026-02", "us") / h("2026-01", "us")).toBeCloseTo(2, 5);
  expect(h("2026-01", "ca") / h("2026-01", "us")).toBeCloseTo(3, 5);
  expect([...container.querySelectorAll("[data-axis='y'] span")].map((e) => e.textContent)).toEqual(["$80.00", "$40.00", "$0.00"]);
  expect([...container.querySelectorAll("[data-axis='x'] span")].map((e) => e.textContent)).toEqual(["Jan", "Feb", "Mar"]);
  expect([...container.querySelectorAll("[data-chart-legend] [data-legend]")].map((e) => e.textContent)).toEqual(["Canadian", "US"]);
});

test("stacked bar tooltip lists each part and the total; private hides money", () => {
  const { container } = render(<StackedBarChart label="Income by month" bars={bars} series={series} currency="CAD" privacy={false} />);
  const plotEl = container.querySelector("[data-chart-plot]") as HTMLElement;
  fireEvent.pointerMove(plotEl, { clientX: 150, pointerType: "mouse" });
  const text = (container.querySelector("[data-chart-tip]") as HTMLElement).textContent!;
  expect(text).toContain("Feb");
  expect(text).toContain("Canadian $60.00");
  expect(text).toContain("US $20.00");
  expect(text).toContain("Total $80.00");
  const priv = render(<StackedBarChart label="Income by month" bars={bars} series={series} currency="CAD" privacy />);
  fireEvent.pointerMove(priv.container.querySelector("[data-chart-plot]") as HTMLElement, { clientX: 150, pointerType: "mouse" });
  const ptext = (priv.container.querySelector("[data-chart-tip]") as HTMLElement).textContent!;
  expect(ptext).toContain("Total ••••");
  expect(ptext).not.toMatch(/\$/);
});

test("stacked bar onBar fires on click and on Enter after keyboard navigation", () => {
  const seen: string[] = [];
  const { container } = render(<StackedBarChart label="Income by month" bars={bars} series={series} currency="CAD" privacy={false} onBar={(k) => seen.push(k)} />);
  fireEvent.click(container.querySelector("g[data-bar='2026-03']")!);
  const svg = container.querySelector("svg[role='img']")!;
  fireEvent.keyDown(svg, { key: "ArrowRight" });
  fireEvent.keyDown(svg, { key: "Enter" });
  expect(seen).toEqual(["2026-03", "2026-01"]);
});

test("stacked bars with no data render an empty state", () => {
  render(<StackedBarChart label="Income by month" bars={[]} series={series} currency="CAD" privacy={false} />);
  expect(screen.getByText(/nothing to chart/i)).toBeInTheDocument();
});

test("donut arcs are plain graphics (no button role or tab stop) without onSlice, and the svg is a group", () => {
  const { container } = render(<DonutChart label="Allocation" slices={slices} privacy={false} />);
  const arc = container.querySelector("path[data-slice='etf']")!;
  expect(arc.getAttribute("role")).toBeNull();
  expect(arc.getAttribute("tabindex")).toBeNull();
  expect(container.querySelector("svg")!.getAttribute("role")).toBe("group");
});

// ---- palette-driven donut ----
test("donut centre shows the largest slice, the selected slice, or the hovered slice; never a bare 100%", () => {
  const { container, rerender } = render(<DonutChart label="Allocation" slices={slices} privacy={false} />);
  const center = () => (container.querySelector(".w-donut-center") as HTMLElement).textContent;
  expect(center()).toBe("ETFs50.0%");
  expect(container.querySelector("path[data-slice='eq']")!.getAttribute("style")).toContain("opacity: 1");
  rerender(<DonutChart label="Allocation" slices={slices} privacy={false} selected="eq" />);
  expect(center()).toBe("Stocks30.0%");
  expect(container.querySelector("path[data-slice='etf']")!.getAttribute("style")).toContain("opacity: 0.4");
  expect(container.querySelector("path[data-slice='eq']")!.getAttribute("style")).toContain("opacity: 1");
  fireEvent.pointerEnter(container.querySelector("path[data-slice='etf']")!, { pointerType: "mouse" });
  expect(center()).toContain("ETFs");
  expect(center()).toContain("$5,000.00");
});

test("donut legend can be turned off when a list names the slices", () => {
  const { container } = render(<DonutChart label="Allocation" slices={slices} privacy={false} legend={false} />);
  expect(container.querySelector("[data-chart-legend]")).toBeNull();
});

test("donut colours never cycle: a ninth slice is Other grey; unclassified is hatched; given colours win", () => {
  const nine = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, label: `K${i}`, fraction: 1 }));
  const { container } = render(<DonutChart label="Allocation" privacy={false} slices={[...nine, { key: "unclassified", label: "Unclassified", fraction: 1 }]} />);
  const color = (k: string) => container.querySelector(`path[data-slice='${k}']`)!.getAttribute("data-color");
  expect(color("k0")).toBe("var(--c1)");
  expect(color("k7")).toBe("var(--c8)");
  expect(color("k8")).toBe("var(--c-other)");
  expect(color("unclassified")).toBe("var(--c-unclassified)");
  expect(container.querySelector("path[data-slice='unclassified']")!.getAttribute("fill")).toMatch(/^url\(#.+\)$/);
  expect(container.querySelector("pattern")).not.toBeNull();
  cleanup();
  const given = render(<DonutChart label="Allocation" privacy={false} slices={[{ key: "a", label: "A", fraction: 1, color: "var(--c5)" }, { key: "b", label: "B", fraction: 1 }]} />);
  expect(given.container.querySelector("path[data-slice='a']")!.getAttribute("fill")).toBe("var(--c5)");
});

test("donut slices are separated by a surface-coloured gap; a single slice has none", () => {
  const { container } = render(<DonutChart label="Allocation" slices={slices} privacy={false} />);
  expect(container.querySelector("path[data-slice='etf']")!.getAttribute("stroke")).toBe("var(--bg)");
  cleanup();
  const one = render(<DonutChart label="Allocation" privacy={false} slices={[{ key: "a", label: "A", fraction: 1 }]} />);
  expect(one.container.querySelector("path[data-slice='a']")!.getAttribute("stroke")).toBe("none");
});

// ---- stacked bars: spacing, selection, colours ----
test("stacked bars: only the top segment is rounded, segments after the first leave a gap, and series colours can be given", () => {
  const { container } = render(<StackedBarChart label="Income by month" bars={bars} currency="CAD" privacy={false}
    series={[{ key: "ca", label: "Canadian", color: "var(--c7)" }, { key: "us", label: "US" }]} />);
  const seg = (bar: string, s: string) => container.querySelector(`g[data-bar='${bar}'] [data-series='${s}']`)!;
  expect(seg("2026-01", "ca").getAttribute("data-top")).toBeNull();
  expect(seg("2026-01", "us").getAttribute("data-top")).toBe("true");
  expect(seg("2026-03", "ca").getAttribute("data-top")).toBe("true");
  expect(seg("2026-01", "ca").getAttribute("fill")).toBe("var(--c7)");
  expect(seg("2026-01", "us").getAttribute("fill")).toBe("var(--c2)");
  const legendColors = [...container.querySelectorAll("[data-chart-legend] [data-legend] i")].map((i) => (i as HTMLElement).style.color);
  expect(legendColors).toEqual(["var(--c7)", "var(--c2)"]);
});

test("stacked bars: bars are at most 60% of their band", () => {
  const { container } = render(<StackedBarChart label="Income by month" bars={bars} series={series} currency="CAD" privacy={false} />);
  const width = Number(container.querySelector("g[data-bar='2026-01']")!.getAttribute("data-width"));
  expect(width).toBeGreaterThan(0);
  expect(width).toBeLessThanOrEqual((300 / 3) * 0.6 + 1e-9);
});

test("stacked bars: a selected bar stays opaque and the others dim; selection is exposed to assistive tech", () => {
  const { container } = render(<StackedBarChart label="Income by month" bars={bars} series={series} currency="CAD" privacy={false} selected="2026-02" onBar={() => {}} />);
  const op = (k: string) => container.querySelector(`g[data-bar='${k}']`)!.getAttribute("opacity");
  expect(op("2026-02")).toBe("1");
  expect(op("2026-01")).toBe("0.4");
  expect(container.querySelector("g[data-bar='2026-02']")!.getAttribute("data-selected")).toBe("true");
  expect(screen.getByRole("img", { name: /Income by month.*Selected: Feb/ })).toBeInTheDocument();
});

test("AllocationBar: a negative slice isn't drawn and isn't dropped: the legend states it and the other shares as given (A13)", () => {
  const { container } = render(<AllocationBar label="Allocation" slices={[{ key: "stock", label: "Stocks", fraction: 5 / 3 }, { key: "cash", label: "Cash", fraction: -2 / 3 }]} />);
  expect(container.querySelector("[data-slice='cash']")).toBeNull();
  expect((container.querySelector("[data-slice='stock']") as HTMLElement).style.width).toBe("100%");
  expect(container.textContent).toContain("Stocks 167%");
  expect(container.textContent).toContain("Cash −67% (margin debit, not drawn)");
});
