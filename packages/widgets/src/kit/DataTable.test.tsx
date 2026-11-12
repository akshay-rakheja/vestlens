import { fireEvent, render, screen } from "@testing-library/preact";
import { DataTable, type Column } from "./DataTable";

interface Row { id: string; name: string; qty: number | null }
const rows: Row[] = [
  { id: "a", name: "Alpha", qty: 5 },
  { id: "b", name: "Bravo", qty: null },
  { id: "c", name: "Charlie", qty: 9 },
  { id: "d", name: "Delta", qty: 1 },
];
const columns: Column<Row>[] = [
  { key: "name", label: "Name", sortValue: (r) => r.name, render: (r) => r.name, mobile: "primary" },
  { key: "qty", label: "Qty", align: "right", sortValue: (r) => r.qty, render: (r) => (r.qty === null ? "—" : String(r.qty)), mobile: "secondary" },
  { key: "note", label: "Note", render: () => "note-cell", mobile: "hidden" },
];
const names = (c: Element) => [...c.querySelectorAll("tbody tr[data-row]")].map((r) => r.querySelector("td")!.textContent);
const header = (label: string) => screen.getByRole("button", { name: new RegExp(label) });

test("clicking a number header sorts highest first then lowest first, nulls always last, announced by aria-sort", () => {
  const { container } = render(<DataTable label="Holdings" rows={rows} columns={columns} rowKey={(r) => r.id} />);
  const qtyTh = screen.getByRole("columnheader", { name: /Qty/ });
  expect(qtyTh.getAttribute("aria-sort")).toBe("none");
  fireEvent.click(header("Qty"));
  expect(names(container)).toEqual(["Charlie", "Alpha", "Delta", "Bravo"]);
  expect(qtyTh.getAttribute("aria-sort")).toBe("descending");
  fireEvent.click(header("Qty"));
  expect(names(container)).toEqual(["Delta", "Alpha", "Charlie", "Bravo"]);
  expect(qtyTh.getAttribute("aria-sort")).toBe("ascending");
  expect(screen.getByRole("columnheader", { name: /Name/ }).getAttribute("aria-sort")).toBe("none");
});

test("initialSort applies and columns without sortValue are not sortable", () => {
  const { container } = render(<DataTable label="Holdings" rows={rows} columns={columns} rowKey={(r) => r.id} initialSort={{ key: "name", dir: "desc" }} />);
  expect(names(container)).toEqual(["Delta", "Charlie", "Bravo", "Alpha"]);
  expect(screen.queryByRole("button", { name: /Note/ })).toBeNull();
  expect(screen.getByRole("columnheader", { name: /Note/ }).hasAttribute("aria-sort")).toBe(false);
});

test("onRowClick fires on click and on Enter", () => {
  const seen: string[] = [];
  const { container } = render(<DataTable label="Holdings" rows={rows} columns={columns} rowKey={(r) => r.id} onRowClick={(r) => seen.push(r.id)} />);
  const first = container.querySelector("tr[data-row]") as HTMLElement;
  fireEvent.click(first);
  fireEvent.keyDown(first, { key: "Enter" });
  expect(seen).toEqual(["a", "a"]);
});

test("the expand chevron toggles the expanded content without firing onRowClick", () => {
  const seen: string[] = [];
  render(<DataTable label="Holdings" rows={rows} columns={columns} rowKey={(r) => r.id} onRowClick={(r) => seen.push(r.id)} expand={(r) => <span>detail for {r.name}</span>} />);
  const chevron = screen.getAllByRole("button", { name: /Show details/ })[0];
  expect(chevron.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(chevron);
  expect(screen.getByText("detail for Alpha")).toBeInTheDocument();
  expect(chevron.getAttribute("aria-expanded")).toBe("true");
  expect(seen).toEqual([]);
  fireEvent.click(chevron);
  expect(screen.queryByText("detail for Alpha")).toBeNull();
});

test("narrow containers drop columns marked mobile hidden", () => {
  const wide = render(<DataTable label="Holdings" rows={rows} columns={columns} rowKey={(r) => r.id} />);
  expect(wide.container.textContent).toContain("note-cell");
  wide.unmount();
  const narrow = render(<DataTable label="Holdings" rows={rows} columns={columns} rowKey={(r) => r.id} narrow />);
  expect(narrow.container.textContent).not.toContain("note-cell");
  expect(screen.queryByRole("columnheader", { name: /Note/ })).toBeNull();
  expect(narrow.container.textContent).toContain("Alpha");
});

test("the table carries its accessible label", () => {
  render(<DataTable label="Holdings" rows={rows} columns={columns} rowKey={(r) => r.id} />);
  expect(screen.getByRole("table", { name: "Holdings" })).toBeInTheDocument();
});

test("Space activates a row; events from interactive descendants do not", () => {
  const seen: string[] = [];
  const cols: Column<Row>[] = [...columns, { key: "act", label: "Act", render: (r) => <button type="button">act {r.id}</button> }];
  const { container } = render(<DataTable label="Holdings" rows={rows} columns={cols} rowKey={(r) => r.id} onRowClick={(r) => seen.push(r.id)} />);
  const first = container.querySelector("tr[data-row]") as HTMLElement;
  fireEvent.keyDown(first, { key: " " });
  expect(seen).toEqual(["a"]);
  fireEvent.click(screen.getByRole("button", { name: "act a" }));
  fireEvent.keyDown(screen.getByRole("button", { name: "act a" }), { key: "Enter" });
  expect(seen).toEqual(["a"]);
});

test("undefined sort values sort last like null", () => {
  const data = [{ id: "u", name: "U", qty: undefined as unknown as number | null }, { id: "v", name: "V", qty: 2 }];
  const { container } = render(<DataTable label="H" rows={data} columns={columns} rowKey={(r) => r.id} initialSort={{ key: "qty", dir: "desc" }} />);
  expect(names(container)).toEqual(["V", "U"]);
});

test("onSortChange reports header clicks: a number column starts highest first, text A to Z; canExpand hides the chevron per row", () => {
  const onSortChange = vi.fn();
  render(<DataTable label="Holdings" rows={rows} columns={columns} rowKey={(r) => r.id} onSortChange={onSortChange}
    expand={(r) => r.name} canExpand={(r) => r.id !== "b"} />);
  fireEvent.click(header("Qty"));
  fireEvent.click(header("Qty"));
  fireEvent.click(header("Name"));
  expect(onSortChange.mock.calls).toEqual([["qty", "desc"], ["qty", "asc"], ["name", "asc"]]);
  expect(screen.getAllByRole("button", { name: /Show details/ })).toHaveLength(3);
});

test("pageSize pages the sorted rows 10 at a time and a sort change returns to page 1", () => {
  const many: Row[] = Array.from({ length: 15 }, (_, i) => ({ id: `r${i}`, name: `Name ${String(i).padStart(2, "0")}`, qty: i }));
  const { container } = render(<DataTable label="Holdings" rows={many} columns={columns} rowKey={(r) => r.id} pageSize={10} initialSort={{ key: "qty", dir: "desc" }} />);
  expect(names(container)).toHaveLength(10);
  expect(names(container)[0]).toBe("Name 14");
  expect(screen.getByText("1–10 of 15")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(names(container)).toEqual(["Name 04", "Name 03", "Name 02", "Name 01", "Name 00"]);
  fireEvent.click(header("Name"));
  expect(screen.getByText("1–10 of 15")).toBeInTheDocument();
  expect(names(container)[0]).toBe("Name 00");
});

test("without pageSize every row renders and there is no pager", () => {
  const many: Row[] = Array.from({ length: 15 }, (_, i) => ({ id: `r${i}`, name: `N${i}`, qty: i }));
  const { container } = render(<DataTable label="Holdings" rows={many} columns={columns} rowKey={(r) => r.id} />);
  expect(names(container)).toHaveLength(15);
  expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
});

describe("sort control, ties and mixed units", () => {
  interface Px { id: string; ccy: string; price: number | null; pct: number | null }
  const px: Px[] = [
    { id: "ZZZ", ccy: "USD", price: 400, pct: 0.1 }, { id: "BBB", ccy: "CAD", price: 20, pct: 0.1 },
    { id: "AAA", ccy: "CAD", price: 20, pct: null }, { id: "CCC", ccy: "CAD", price: null, pct: 0.3 }, { id: "DDD", ccy: "USD", price: 30, pct: 0.2 },
  ];
  const cols: Column<Px>[] = [
    { key: "id", label: "Symbol", sortValue: (r) => r.id, render: (r) => r.id, mobile: "primary" },
    { key: "price", label: "Price", align: "right", sortValue: (r) => r.price, within: { by: (r) => r.ccy, note: "Price is sorted within each currency." }, render: (r) => String(r.price), mobile: "hidden" },
  ];
  const extra = [{ key: "pct", label: "Gain %", sortValue: (r: Px) => r.pct }];
  const order = (c: Element) => [...c.querySelectorAll("tbody tr[data-row]")].map((r) => r.getAttribute("data-row"));

  test("ties follow the tie-break key ascending whichever way the column is sorted", () => {
    const { container } = render(<DataTable label="T" rows={px} columns={cols} rowKey={(r) => r.id} tieBreak={(r) => r.id} extraSorts={extra} initialSort={{ key: "pct", dir: "desc" }} />);
    expect(order(container)).toEqual(["CCC", "DDD", "BBB", "ZZZ", "AAA"]);
    fireEvent.click(screen.getByRole("button", { name: /Sort order/ }));
    expect(order(container)).toEqual(["BBB", "ZZZ", "DDD", "CCC", "AAA"]);
  });

  test("a column with a within key sorts inside each group, says so, and keeps nulls last", () => {
    const { container } = render(<DataTable label="T" rows={px} columns={cols} rowKey={(r) => r.id} tieBreak={(r) => r.id} narrow={false} />);
    expect(screen.queryByText("Price is sorted within each currency.")).toBeNull();
    fireEvent.click(header("Price"));
    expect(order(container)).toEqual(["AAA", "BBB", "CCC", "ZZZ", "DDD"]);
    expect(screen.getByText("Price is sorted within each currency.")).toBeInTheDocument();
    fireEvent.click(header("Price"));
    expect(order(container)).toEqual(["AAA", "BBB", "CCC", "DDD", "ZZZ"]);
    fireEvent.click(header("Symbol"));
    expect(screen.queryByText("Price is sorted within each currency.")).toBeNull();
  });

  test("the within note is left out when the rows share one group", () => {
    render(<DataTable label="T" rows={px.filter((r) => r.ccy === "CAD")} columns={cols} rowKey={(r) => r.id} />);
    fireEvent.click(header("Price"));
    expect(screen.queryByText("Price is sorted within each currency.")).toBeNull();
  });

  test("extra sorts get a labelled control with the direction button; picking one sorts and reports it", () => {
    const onSortChange = vi.fn();
    const { container } = render(<DataTable label="T" rows={px} columns={cols} rowKey={(r) => r.id} extraSorts={extra} onSortChange={onSortChange} narrow={false} />);
    const select = screen.getByRole("combobox", { name: "Sort by" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Sort by…", "Symbol", "Price", "Gain %"]);
    fireEvent.change(select, { target: { value: "pct" } });
    // A number key starts highest first.
    expect(onSortChange).toHaveBeenLastCalledWith("pct", "desc");
    expect(order(container)).toEqual(["CCC", "DDD", "ZZZ", "BBB", "AAA"]);
    expect(screen.getByRole("button", { name: "Sort order: descending. Switch to ascending" })).toHaveTextContent("Descending");
    fireEvent.click(screen.getByRole("button", { name: "Sort order: descending. Switch to ascending" }));
    expect(onSortChange).toHaveBeenLastCalledWith("pct", "asc");
    expect(order(container).slice(-1)).toEqual(["AAA"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort order: ascending. Switch to descending" }));
    expect((screen.getByRole("combobox", { name: "Sort by" }) as HTMLSelectElement).value).toBe("pct");
    // No header carries this sort, and none claims to.
    expect(screen.getByRole("columnheader", { name: /Price/ }).getAttribute("aria-sort")).toBe("none");
  });

  test("a narrow table that hides a sortable column still offers every sort through the control", () => {
    const { container } = render(<DataTable label="T" rows={px} columns={cols} rowKey={(r) => r.id} tieBreak={(r) => r.id} narrow />);
    expect(screen.queryByRole("columnheader", { name: /Price/ })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "price" } });
    expect(order(container)).toEqual(["AAA", "BBB", "CCC", "ZZZ", "DDD"]);
  });

  test("no control without extra sorts or a hidden sortable column", () => {
    const visible = cols.map((c) => ({ ...c, mobile: "secondary" as const }));
    render(<DataTable label="T" rows={px} columns={visible} rowKey={(r) => r.id} narrow />);
    expect(screen.queryByRole("combobox", { name: "Sort by" })).toBeNull();
  });
});
