import { render } from "@testing-library/preact";
import { HomeCaption, HomeMoney, type HomeAmountView, type HomeTotalView } from "./home-money";

const exactCad: HomeAmountView = { amount: 100, estimated: false, rate: null, rateDate: null, native: { amount: 100, currency: "CAD" } };
const estUsd: HomeAmountView = { amount: 6362.37, estimated: true, rate: 1.3712, rateDate: "2026-05-26", native: { amount: 4640, currency: "USD" } };

test("exact CAD renders the amount with no est.", () => {
  const { container } = render(<HomeMoney value={exactCad} privacy={false} />);
  expect(container.textContent).toContain("$100.00");
  expect(container.textContent).not.toContain("est.");
  expect(container.textContent).not.toContain("US$");
});

test("est. USD renders CAD, est., and the original amount as a second line with the rate in the title", () => {
  const { container } = render(<HomeMoney value={estUsd} privacy={false} />);
  expect(container.textContent).toContain("$6,362.37");
  expect(container.textContent).toContain(" est.");
  const native = container.querySelector(".w-home-native");
  expect(native?.textContent).toBe("US$4,640.00");
  expect(container.querySelector("[title]")?.getAttribute("title")).toBe("US$4,640.00 at 1.3712 (BoC May 26)");
});

test("showNative={false} hides the second line", () => {
  const { container } = render(<HomeMoney value={estUsd} privacy={false} showNative={false} />);
  expect(container.querySelector(".w-home-native")).toBeNull();
  expect(container.textContent).not.toContain("US$");
});

test("signed renders a sign on the CAD line", () => {
  const { container } = render(<HomeMoney value={{ ...estUsd, amount: -6362.37, native: { amount: -4640, currency: "USD" } }} privacy={false} signed />);
  expect(container.textContent).toContain("−$6,362.37");
  expect(container.textContent).toContain("−US$4,640.00");
});

test("not converted shows the original amount only", () => {
  const eur: HomeAmountView = { amount: null, estimated: false, rate: null, rateDate: null, native: { amount: 5, currency: "EUR" } };
  const { container } = render(<HomeMoney value={eur} privacy={false} />);
  expect(container.textContent).toContain("€5.00");
  expect(container.textContent).not.toContain("est.");
});

test("privacy replaces both lines with the blurred placeholder and leaks no digits", () => {
  const { container } = render(<HomeMoney value={estUsd} privacy={true} />);
  expect(container.querySelectorAll('[role="img"]').length).toBe(2);
  expect(container.textContent).not.toMatch(/\d/);
  expect(container.querySelector("[title]")).toBeNull();
});

const total = (t: Partial<HomeTotalView>): HomeTotalView => ({ amount: 1, estimated: true, rateDates: [], excluded: [], ...t });

test("caption names a single BoC rate date", () => {
  const { container } = render(<HomeCaption total={total({ rateDates: ["2026-05-26"] })} />);
  expect(container.textContent).toBe("est. · BoC May 26");
});

test("caption says rates by trade date when several dates apply", () => {
  const { container } = render(<HomeCaption total={total({ rateDates: ["2026-05-22", "2026-05-26"] })} />);
  expect(container.textContent).toBe("est. · rates by trade date");
});

test("caption counts exclusions", () => {
  const { container } = render(<HomeCaption total={total({ estimated: false, excluded: [{ amount: 5, currency: "EUR" }] })} />);
  expect(container.textContent).toContain("1 not converted");
});

test("caption shows the count of unconverted parts, not of currencies", () => {
  const { container } = render(<HomeCaption total={total({ estimated: false, excluded: [{ amount: 9, currency: "EUR" }, { amount: 30, currency: "USD" }], excludedCount: 3 })} />);
  expect(container.textContent).toContain("3 not converted");
});

test("exact total renders nothing", () => {
  const { container } = render(<HomeCaption total={total({ estimated: false })} />);
  expect(container.textContent).toBe("");
  expect(container.firstChild).toBeNull();
});
