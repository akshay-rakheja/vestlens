import { fireEvent, render, screen } from "@testing-library/preact";
import { NewsCard, type NewsCardData } from "./NewsCard";

const card = (over: Partial<NewsCardData> = {}): NewsCardData => ({
  articleId: "a1", headline: "ZZTEST posts results", snippet: "s", source: "Example Wire", publishedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  imageUrl: "/api/news/image/a1", url: "https://example.com/a1",
  tags: { eventType: "earnings_report", impactLevel: 2, mood: "positive", credible: true }, alsoReportedBy: [], via: null, ...over,
});

test("headline links out safely", () => {
  render(<NewsCard card={card()} privacy={false} onSummarize={() => {}} />);
  const a = screen.getByRole("link", { name: "ZZTEST posts results" });
  expect(a).toHaveAttribute("href", "https://example.com/a1");
  expect(a).toHaveAttribute("target", "_blank");
  expect(a).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.getByText(/Example Wire · 2 h ago/)).toBeInTheDocument();
});

test("thumbnail is lazy; a placeholder replaces it when missing or on error", () => {
  const { container, unmount } = render(<NewsCard card={card()} privacy={false} onSummarize={() => {}} />);
  const img = container.querySelector("img")!;
  expect(img).toHaveAttribute("loading", "lazy");
  fireEvent.error(img);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("[data-placeholder]")).not.toBeNull();
  unmount();
  const second = render(<NewsCard card={card({ imageUrl: null })} privacy={false} onSummarize={() => {}} />);
  expect(second.container.querySelector("img")).toBeNull();
  expect(second.container.querySelector("[data-placeholder]")).not.toBeNull();
});

test("chips: event type, impact, mood word, unverified", () => {
  const { rerender } = render(<NewsCard card={card()} privacy={false} onSummarize={() => {}} />);
  expect(screen.getByText("Earnings Report")).toBeInTheDocument();
  expect(screen.getByText("High")).toBeInTheDocument();
  expect(screen.getByText("Positive")).toBeInTheDocument();
  expect(screen.queryByText("Low-confidence source (AI-rated)")).toBeNull();
  rerender(<NewsCard card={card({ tags: { eventType: null, impactLevel: 3, mood: "negative", credible: false } })} privacy={false} onSummarize={() => {}} />);
  expect(screen.getByText("Major")).toBeInTheDocument();
  expect(screen.getByText("Low-confidence source (AI-rated)")).toBeInTheDocument();
  expect(screen.queryByText("Unverified source")).toBeNull();
  expect(screen.queryByText("Earnings Report")).toBeNull();
});

test("an unrated card shows only a \"Not yet rated\" chip: no impact, mood or credibility", () => {
  render(<NewsCard card={card({ tags: null })} privacy={false} onSummarize={() => {}} />);
  expect(screen.getByText("Not yet rated")).toBeInTheDocument();
  for (const word of ["Low", "Medium", "High", "Major", "Positive", "Earnings Report"]) expect(screen.queryByText(word)).toBeNull();
  expect(screen.getByRole("button", { name: "Summarize" })).toBeInTheDocument();
});

test("duplicates and via notes", () => {
  render(<NewsCard card={card({ alsoReportedBy: ["A", "B"], via: "ZZTEST" })} privacy={true} onSummarize={() => {}} />);
  expect(screen.getByText("also reported by 2 sources")).toBeInTheDocument();
  expect(screen.getByText("via ZZTEST")).toBeInTheDocument();
});

test("a compact card keeps the via constituent", () => {
  render(<NewsCard compact card={card({ via: "ZZCON" })} privacy={false} onSummarize={() => {}} />);
  expect(screen.getByText("via ZZCON")).toBeInTheDocument();
});

test("Summarize passes the article url", () => {
  const onSummarize = vi.fn();
  render(<NewsCard card={card()} privacy={false} onSummarize={onSummarize} />);
  fireEvent.click(screen.getByRole("button", { name: "Summarize" }));
  expect(onSummarize).toHaveBeenCalledWith("https://example.com/a1");
});

test("singular duplicate wording and mood word on every level", () => {
  const { unmount } = render(<NewsCard card={card({ alsoReportedBy: ["A"] })} privacy={false} onSummarize={() => {}} />);
  expect(screen.getByText("also reported by 1 source")).toBeInTheDocument();
  unmount();
  for (const [mood, word] of [["strongly_negative", "Strongly negative"], ["negative", "Negative"], ["neutral", "Neutral"], ["positive", "Positive"], ["strongly_positive", "Strongly positive"]] as const) {
    const r = render(<NewsCard card={card({ tags: { eventType: null, impactLevel: 0, mood, credible: true } })} privacy={false} onSummarize={() => {}} />);
    expect(r.container.querySelector("[data-mood]")?.textContent).toBe(word);
    r.unmount();
  }
});

test("imageBase prefixes the proxy path; a null mood shows no mood chip", () => {
  const { container } = render(<NewsCard card={card({ tags: { eventType: null, impactLevel: 1, mood: null, credible: true }, snippet: null })} imageBase="https://app.example.test" privacy={false} onSummarize={() => {}} />);
  expect(container.querySelector("img")).toHaveAttribute("src", "https://app.example.test/api/news/image/a1");
  expect(container.querySelector("[data-mood]")).toBeNull();
});

test("compact shows only the safe link, source and age", () => {
  const { container } = render(<NewsCard compact card={card()} privacy={false} onSummarize={() => {}} />);
  const a = screen.getByRole("link", { name: "ZZTEST posts results" });
  expect(a).toHaveAttribute("target", "_blank");
  expect(a).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.getByText(/Example Wire · 2 h ago/)).toBeInTheDocument();
  expect(container.querySelector("img, [data-placeholder]")).toBeNull();
  expect(screen.queryByRole("button", { name: "Summarize" })).toBeNull();
});

test("clicking a headline asks the host to open it (sandboxed frames block target=_blank)", () => {
  const onOpen = vi.fn();
  const c = { articleId: "a1", headline: "ZZTEST invented open-link headline", url: "https://news.example.test/a1", source: "Example Wire", publishedAt: new Date().toISOString(), imageUrl: null, snippet: null, symbols: ["ZZTEST"], via: null, alsoReportedBy: [], tags: null, rated: false } as any;
  for (const compact of [false, true]) {
    const { unmount } = render(<NewsCard card={c} privacy={false} onSummarize={() => {}} onOpen={onOpen} compact={compact} />);
    const link = screen.getByRole("link", { name: "ZZTEST invented open-link headline" });
    const clicked = fireEvent.click(link);
    expect(clicked).toBe(false); // default navigation prevented
    unmount();
  }
  expect(onOpen).toHaveBeenCalledTimes(2);
  expect(onOpen).toHaveBeenCalledWith("https://news.example.test/a1");
});
