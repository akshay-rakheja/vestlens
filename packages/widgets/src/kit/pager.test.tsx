import { act, fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { PAGE_SIZE, Pager, usePager } from "./pager";

function Harness(props: { initial: number; more?: number; resetKey?: string }) {
  const [rows, setRows] = useState(Array.from({ length: props.initial }, (_, i) => i + 1));
  const [left, setLeft] = useState(props.more ?? 0);
  const fetchMore = async () => {
    const start = rows.length;
    setRows((r) => [...r, ...Array.from({ length: Math.min(50, left) }, (_, i) => start + i + 1)]);
    setLeft((l) => Math.max(0, l - 50));
  };
  const pager = usePager(rows, left > 0, fetchMore, props.resetKey ?? "k");
  return (
    <div>
      <ol>{pager.visible.map((n) => <li key={n}>{`row ${n}`}</li>)}</ol>
      <Pager pager={pager} />
    </div>
  );
}

test("shows 10 rows per page and moves through the loaded rows", () => {
  expect(PAGE_SIZE).toBe(10);
  render(<Harness initial={23} />);
  expect(screen.getAllByRole("listitem")).toHaveLength(10);
  expect(screen.getByText("1–10 of 23")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getByText("row 11")).toBeInTheDocument();
  expect(screen.getByText("11–20 of 23")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  expect(screen.getByText("21–23 of 23")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
  expect(screen.getByText("11–20 of 23")).toBeInTheDocument();
});

test("fetches the next server page only at the end of the loaded rows, and says 'of N+' while more exist", async () => {
  render(<Harness initial={20} more={7} />);
  expect(screen.getByText("1–10 of 20+")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getByText("11–20 of 20+")).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Next page" })); });
  expect(screen.getByText("row 21")).toBeInTheDocument();
  expect(screen.getByText("21–27 of 27")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
});

test("returns to the first page when the list is reset (new filters or symbol)", () => {
  const { rerender } = render(<Harness initial={23} resetKey="a" />);
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getByText("11–20 of 23")).toBeInTheDocument();
  rerender(<Harness initial={23} resetKey="b" />);
  expect(screen.getByText("1–10 of 23")).toBeInTheDocument();
});

test("renders no pager when everything fits on one page", () => {
  render(<Harness initial={7} />);
  expect(screen.getAllByRole("listitem")).toHaveLength(7);
  expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
});
