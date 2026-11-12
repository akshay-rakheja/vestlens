import { render, screen } from "@testing-library/preact";
import { MoodDial, type MoodLevel } from "./MoodDial";

const words: Array<[MoodLevel, string]> = [
  ["strongly_negative", "Strongly negative"], ["negative", "Negative"], ["neutral", "Neutral"],
  ["positive", "Positive"], ["strongly_positive", "Strongly positive"], ["not_enough_news", "Not enough news"],
];
const recent = new Date(Date.now() - 3 * 3600_000).toISOString();

test.each(words)("%s renders the word and an aria-label", (level, word) => {
  const { container } = render(<MoodDial level={level} value={0} articles={4} mostRecentAt={recent} label="Portfolio mood" />);
  expect(screen.getByText(word)).toBeInTheDocument();
  expect(screen.getByRole("img", { name: `Portfolio mood: ${word}` })).toBeInTheDocument();
  expect(container.querySelectorAll("path[data-segment]").length).toBe(5);
});

test("only the active segment is filled from the ramp; not_enough_news fills none", () => {
  const { container, rerender } = render(<MoodDial level="positive" value={0.3} articles={4} mostRecentAt={recent} label="m" />);
  const filled = () => Array.from(container.querySelectorAll("path[data-segment]")).filter((p) => /^var\(--d[1-5]\)$/.test(p.getAttribute("fill") ?? ""));
  expect(filled().map((p) => p.getAttribute("data-segment"))).toEqual(["positive"]);
  rerender(<MoodDial level="not_enough_news" value={null} articles={1} mostRecentAt={null} label="m" />);
  expect(filled().length).toBe(0);
});

test("the muted basis line gives the article count and relative time", () => {
  render(<MoodDial level="neutral" value={0} articles={7} mostRecentAt={recent} label="m" />);
  expect(screen.getByText("based on 7 articles · most recent 3 h ago")).toBeInTheDocument();
});

test("every level carries its word as text, independent of colour", () => {
  for (const [level, word] of words) {
    const { container, unmount } = render(<MoodDial level={level} value={0} articles={2} mostRecentAt={null} label="m" />);
    expect(container.querySelector(".w-dial-word")?.textContent).toBe(word);
    unmount();
  }
});

test("the singular wording is 'article'", () => {
  render(<MoodDial level="neutral" value={0} articles={1} mostRecentAt={null} label="m" />);
  expect(screen.getByText("based on 1 article")).toBeInTheDocument();
});

test("the basis can count article ratings instead of articles", () => {
  const { rerender } = render(<MoodDial level="neutral" value={0} articles={7} mostRecentAt={null} unit="ratings" label="m" />);
  expect(screen.getByText("based on 7 article ratings")).toBeInTheDocument();
  rerender(<MoodDial level="neutral" value={0} articles={1} mostRecentAt={null} unit="ratings" label="m" />);
  expect(screen.getByText("based on 1 article rating")).toBeInTheDocument();
});

test("inactive segments use --dial-off; the active one has an ink stroke", () => {
  const { container } = render(<MoodDial level="negative" value={-0.3} articles={2} mostRecentAt={null} label="m" />);
  const active = container.querySelector('[data-active="true"]')!;
  expect(active).toHaveAttribute("stroke", "var(--ink)");
  for (const p of container.querySelectorAll('[data-active="false"]')) { expect(p).toHaveAttribute("fill", "var(--dial-off)"); expect(p).not.toHaveAttribute("stroke"); }
});
