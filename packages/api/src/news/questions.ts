// TypeSafe Jev (System One) question set for rating one news article for one held symbol.
// Question ids are code-only; the model sees instructions and criteria, which reference the request
// state by backticked paths (`article`, `company`, `ticker`, `candidates.<id>`).
// Writing follows TypeSafe's guidance: describe situations, not degrees; one dimension per question.

export const EVENT_TYPES = [
  "earnings",
  "guidance",
  "m_and_a",
  "regulatory",
  "legal",
  "product",
  "macro",
  "analyst_rating",
  "insider",
  "dividend",
  "other",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const EVENT_OPTIONS: Record<EventType, { what: string; not_for: string }> = {
  earnings: {
    what: "Reported results for a completed period",
    not_for: "Forward outlook changes, which are guidance",
  },
  guidance: {
    what: "A change to the company's own forward outlook or targets",
    not_for: "Reported results",
  },
  m_and_a: {
    what: "A merger, acquisition, divestiture, spin-off or takeover bid involving the company",
    not_for: "Partnerships or supply agreements that change no ownership",
  },
  regulatory: {
    what: "Action by a government agency or regulator (approval, ban, fine, investigation, warning letter)",
    not_for: "Private lawsuits or settlements between companies",
  },
  legal: {
    what: "Lawsuits, court rulings, settlements, arbitration between private parties",
    not_for: "Regulator or agency actions",
  },
  product: {
    what: "A product launch, recall, contract win, partnership or operational milestone",
    not_for: "Financial results, or deals that change ownership",
  },
  macro: {
    what: "Interest rates, inflation, commodity prices, currencies, or the broad economy or market",
    not_for: "Events specific to the company itself",
  },
  analyst_rating: {
    what: "An analyst or research firm changes its rating or price target on the company",
    not_for: "The company's own outlook",
  },
  insider: {
    what: "Executives, directors or major shareholders buy or sell the company's shares",
    not_for: "Share buybacks by the company itself",
  },
  dividend: {
    what: "The company declares, changes or suspends a dividend, or announces a share buyback",
    not_for: "Results that mention the dividend only in passing",
  },
  other: {
    what: "None of the other categories describes the primary event",
    not_for: "Articles where one of the other categories fits",
  },
};

export const dupQuestionId = (candidateId: string) => `dup_${candidateId}`;

/**
 * The full question set for one Jev request. Candidate ids must be simple identifiers (the rater
 * uses short aliases such as `c1`) because they appear in the `candidates.<id>` state path.
 */
export function buildQuestions(candidateDuplicateIds: string[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {
    relevant: {
      type: "noul",
      instructions: "Is `article` primarily about `company` (`ticker`), or an event that directly affects it?",
      criteria: {
        true: "The company is a main subject or a directly affected party",
        false: "The company is only mentioned in passing, in a list, or as a comparison",
      },
    },
    sentiment: {
      type: "score",
      instructions: "For someone who holds shares of `company`, how favorable is the news in `article`?",
      criteria: [
        "Serious bad news for the shareholder: losses, failure, major setback, enforcement",
        "Mildly negative: a small miss, a minor risk or delay",
        "Neutral or no clear direction for the shareholder",
        "Mildly positive: a small beat, incremental good news",
        "Strongly positive: a major win, a large upgrade, a transformative deal",
      ],
    },
    materiality: {
      type: "score",
      instructions: "How much could the event in `article` change `company`'s financial outlook?",
      criteria: [
        "No financial consequence",
        "Minor; routine operations or commentary",
        "Meaningful; affects a quarter's results or a product line",
        "Major; changes the company's trajectory (deal, ban, restatement, guidance cut)",
      ],
    },
    event_type: {
      type: "choice",
      instructions: "What is the primary event reported in `article` about `company`?",
      criteria: Object.fromEntries(EVENT_TYPES.map((t) => [t, { ...EVENT_OPTIONS[t] }])),
    },
    credible: {
      type: "noul",
      instructions: "Does `article` read like factual reporting with attributed facts rather than speculation or promotion?",
      criteria: {
        true: "Named sources, figures, filings or official statements",
        false: "Rumour, opinion, promotional or anonymous claims",
      },
    },
    clickbait: {
      type: "noul",
      instructions: "Does `article.headline` overstate or sensationalise what `article.snippet` supports?",
      criteria: {
        true: "The headline claims more, or more dramatically, than the snippet reports",
        false: "The headline fairly reflects what the snippet reports",
      },
    },
  };
  for (const id of candidateDuplicateIds) {
    questions[dupQuestionId(id)] = {
      type: "noul",
      instructions: `Does \`article\` report the same underlying event as \`candidates.${id}\`?`,
      criteria: {
        true: "Same event and facts, possibly reworded",
        false: "A different event or a later development",
      },
    };
  }
  return questions;
}
