import { compareSortValues, hasGroups, nextSortDir, sortRows } from "./sort";

interface Row { id: string; n: number | null; ccy?: string }
const ids = (rows: Row[]) => rows.map((r) => r.id);

test("numbers order numerically and strings by locale, in both directions", () => {
  expect(compareSortValues(2, 10, "asc")).toBeLessThan(0);
  expect(compareSortValues(2, 10, "desc")).toBeGreaterThan(0);
  expect(compareSortValues("b", "a", "asc")).toBeGreaterThan(0);
  expect(compareSortValues("b", "a", "desc")).toBeLessThan(0);
  expect(compareSortValues(3, 3, "asc")).toBe(0);
});

test("missing values (null, undefined, NaN, infinity) sort after real ones in both directions", () => {
  for (const dir of ["asc", "desc"] as const) {
    for (const gap of [null, undefined, NaN, Infinity]) {
      expect(compareSortValues(gap, 5, dir)).toBeGreaterThan(0);
      expect(compareSortValues(5, gap, dir)).toBeLessThan(0);
    }
    expect(compareSortValues(null, undefined, dir)).toBe(0);
  }
});

test("sortRows puts nulls last both ways and does not touch its input", () => {
  const rows: Row[] = [{ id: "a", n: 5 }, { id: "b", n: null }, { id: "c", n: 9 }, { id: "d", n: 1 }];
  const before = ids(rows);
  expect(ids(sortRows(rows, { value: (r) => r.n, dir: "asc" }))).toEqual(["d", "a", "c", "b"]);
  expect(ids(sortRows(rows, { value: (r) => r.n, dir: "desc" }))).toEqual(["c", "a", "d", "b"]);
  expect(ids(rows)).toEqual(before);
});

test("ties fall back to the tie-break key ascending in both directions, then to the incoming order", () => {
  const rows: Row[] = [{ id: "z", n: 1 }, { id: "m", n: 1 }, { id: "a", n: 1 }, { id: "q", n: 2 }];
  const tieBreak = (r: Row) => r.id;
  expect(ids(sortRows(rows, { value: (r) => r.n, dir: "asc", tieBreak }))).toEqual(["a", "m", "z", "q"]);
  expect(ids(sortRows(rows, { value: (r) => r.n, dir: "desc", tieBreak }))).toEqual(["q", "a", "m", "z"]);
  // Without a tie-break the incoming order is kept.
  expect(ids(sortRows(rows, { value: (r) => r.n, dir: "asc" }))).toEqual(["z", "m", "a", "q"]);
  // Equal tie-break keys keep the incoming order too.
  const same: Row[] = [{ id: "x", n: 1 }, { id: "x", n: 1 }];
  const tagged = same.map((r, i) => ({ ...r, i }));
  expect(sortRows(tagged, { value: (r) => r.n, dir: "desc", tieBreak }).map((r) => r.i)).toEqual([0, 1]);
});

test("a group key keeps rows in groups (ascending) and sorts inside each, whichever the direction", () => {
  const rows: Row[] = [
    { id: "usd-big", n: 500, ccy: "USD" }, { id: "cad-small", n: 10, ccy: "CAD" }, { id: "usd-small", n: 20, ccy: "USD" },
    { id: "cad-big", n: 90, ccy: "CAD" }, { id: "cad-none", n: null, ccy: "CAD" },
  ];
  const group = (r: Row) => r.ccy!;
  expect(ids(sortRows(rows, { value: (r) => r.n, dir: "asc", group }))).toEqual(["cad-small", "cad-big", "cad-none", "usd-small", "usd-big"]);
  expect(ids(sortRows(rows, { value: (r) => r.n, dir: "desc", group }))).toEqual(["cad-big", "cad-small", "cad-none", "usd-big", "usd-small"]);
  expect(hasGroups(rows, group)).toBe(true);
  expect(hasGroups(rows.filter((r) => r.ccy === "CAD"), group)).toBe(false);
  expect(hasGroups([], group)).toBe(false);
});

test("nextSortDir flips the active key and starts any other key at the first direction", () => {
  expect(nextSortDir(null, "price")).toBe("asc");
  expect(nextSortDir({ key: "price", dir: "asc" }, "price")).toBe("desc");
  expect(nextSortDir({ key: "price", dir: "desc" }, "price")).toBe("asc");
  expect(nextSortDir({ key: "price", dir: "desc" }, "value")).toBe("asc");
  expect(nextSortDir({ key: "price", dir: "asc" }, "value", "desc")).toBe("desc");
});
