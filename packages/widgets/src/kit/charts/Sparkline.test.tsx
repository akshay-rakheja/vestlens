import { render, screen } from "@testing-library/preact";
import { Sparkline } from "./Sparkline";

test("draws a path and a dotted last point with a label", () => {
  const { container } = render(<Sparkline values={[1, 3, 2, 4]} label="Price trend" />);
  expect(screen.getByRole("img", { name: "Price trend" })).toBeInTheDocument();
  expect(container.querySelectorAll("path").length).toBe(1);
  expect(container.querySelectorAll("circle").length).toBe(1);
});

test("renders nothing for fewer than two values", () => {
  const { container } = render(<Sparkline values={[1]} label="x" />);
  expect(container.querySelector("svg")).toBeNull();
});
