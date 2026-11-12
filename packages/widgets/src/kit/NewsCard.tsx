import { useState } from "preact/hooks";
import { formatRelativeTime } from "./format";
import { MOOD_WORDS, moodColor, type MoodLevel } from "./MoodDial";

export interface NewsCardData {
  articleId: string; headline: string; snippet: string | null; source: string; publishedAt: string; imageUrl: string | null; url: string;
  /** Null while the article is not yet rated. */
  tags: { eventType: string | null; impactLevel: 0 | 1 | 2 | 3; mood: MoodLevel | null; credible: boolean } | null;
  alsoReportedBy: string[]; via: string | null;
}

const IMPACT = ["Low", "Medium", "High", "Major"] as const;
const titleCase = (s: string) => s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * One article: thumbnail, linked headline, source and age, tag chips, duplicates note and a Summarize button. Holds no amounts, so `privacy` changes nothing.
 * `imageBase` is prefixed to the relative proxy path (the widget frame has its own origin). `compact` shows only the headline, source, age and the via constituent.
 */
export function NewsCard(props: { card: NewsCardData; privacy: boolean; onSummarize(url: string): void; imageBase?: string; compact?: boolean; onOpen?(url: string): void }) {
  const { card } = props;
  const { tags } = card;
  const [broken, setBroken] = useState(false);
  // Sandboxed widget frames cannot open windows, so a plain link does nothing; ask the host instead.
  const open = props.onOpen ? (e: MouseEvent) => { e.preventDefault(); props.onOpen!(card.url); } : undefined;
  const n = card.alsoReportedBy.length;
  if (props.compact) {
    return (
      <div class="w-news-compact" data-article={card.articleId}>
        <a href={card.url} target="_blank" rel="noopener noreferrer" onClick={open}>{card.headline}</a>
        <span class="w-news-meta">{card.source} · {formatRelativeTime(card.publishedAt)}{card.via ? <> · <span data-via>via {card.via}</span></> : null}</span>
      </div>
    );
  }
  return (
    <article class="w-news-card" data-article={card.articleId}>
      {card.imageUrl && !broken
        ? <img class="w-news-thumb" src={(props.imageBase ?? "") + card.imageUrl} alt="" loading="lazy" onError={() => setBroken(true)} />
        : <div class="w-news-thumb" data-placeholder="true" aria-hidden="true" />}
      <a href={card.url} target="_blank" rel="noopener noreferrer" onClick={open}>{card.headline}</a>
      <div class="w-news-meta">
        {card.source} · {formatRelativeTime(card.publishedAt)}
        {card.via ? <> · <span data-via>via {card.via}</span></> : null}
      </div>
      <div class="w-news-tags">
        {tags === null ? <span class="w-chip" data-unrated>Not yet rated</span> : <>
          {tags.eventType ? <span class="w-chip">{titleCase(tags.eventType)}</span> : null}
          <span class="w-chip">{IMPACT[tags.impactLevel]}</span>
          {tags.mood ? <span class="w-chip" data-mood={tags.mood} style={{ "--mood": moodColor(tags.mood) }}>{MOOD_WORDS[tags.mood]}</span> : null}
          {!tags.credible ? <span class="w-chip">Low-confidence source (AI-rated)</span> : null}
        </>}
      </div>
      {n > 0 ? <div class="w-news-meta">also reported by {n} {n === 1 ? "source" : "sources"}</div> : null}
      <button type="button" class="w-news-sum" onClick={() => props.onSummarize(card.url)}>Summarize</button>
    </article>
  );
}
