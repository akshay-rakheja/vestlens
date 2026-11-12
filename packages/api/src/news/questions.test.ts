import { describe, expect, it } from "vitest";
import { buildQuestions, EVENT_TYPES } from "./questions.js";

describe("buildQuestions", () => {
  it("carries every fixed question plus one duplicate question per candidate", () => {
    const q = buildQuestions(["c1", "c2"]);
    expect(Object.keys(q)).toEqual(["relevant", "sentiment", "materiality", "event_type", "credible", "clickbait", "dup_c1", "dup_c2"]);
    expect(Object.keys(buildQuestions([]))).toEqual(["relevant", "sentiment", "materiality", "event_type", "credible", "clickbait"]);
  });

  it("uses the eleven event types in order", () => {
    expect(EVENT_TYPES).toEqual(["earnings", "guidance", "m_and_a", "regulatory", "legal", "product", "macro", "analyst_rating", "insider", "dividend", "other"]);
  });

  it("pins the exact question text", () => {
    expect(buildQuestions(["c1"])).toMatchInlineSnapshot(`
      {
        "clickbait": {
          "criteria": {
            "false": "The headline fairly reflects what the snippet reports",
            "true": "The headline claims more, or more dramatically, than the snippet reports",
          },
          "instructions": "Does \`article.headline\` overstate or sensationalise what \`article.snippet\` supports?",
          "type": "noul",
        },
        "credible": {
          "criteria": {
            "false": "Rumour, opinion, promotional or anonymous claims",
            "true": "Named sources, figures, filings or official statements",
          },
          "instructions": "Does \`article\` read like factual reporting with attributed facts rather than speculation or promotion?",
          "type": "noul",
        },
        "dup_c1": {
          "criteria": {
            "false": "A different event or a later development",
            "true": "Same event and facts, possibly reworded",
          },
          "instructions": "Does \`article\` report the same underlying event as \`candidates.c1\`?",
          "type": "noul",
        },
        "event_type": {
          "criteria": {
            "analyst_rating": {
              "not_for": "The company's own outlook",
              "what": "An analyst or research firm changes its rating or price target on the company",
            },
            "dividend": {
              "not_for": "Results that mention the dividend only in passing",
              "what": "The company declares, changes or suspends a dividend, or announces a share buyback",
            },
            "earnings": {
              "not_for": "Forward outlook changes, which are guidance",
              "what": "Reported results for a completed period",
            },
            "guidance": {
              "not_for": "Reported results",
              "what": "A change to the company's own forward outlook or targets",
            },
            "insider": {
              "not_for": "Share buybacks by the company itself",
              "what": "Executives, directors or major shareholders buy or sell the company's shares",
            },
            "legal": {
              "not_for": "Regulator or agency actions",
              "what": "Lawsuits, court rulings, settlements, arbitration between private parties",
            },
            "m_and_a": {
              "not_for": "Partnerships or supply agreements that change no ownership",
              "what": "A merger, acquisition, divestiture, spin-off or takeover bid involving the company",
            },
            "macro": {
              "not_for": "Events specific to the company itself",
              "what": "Interest rates, inflation, commodity prices, currencies, or the broad economy or market",
            },
            "other": {
              "not_for": "Articles where one of the other categories fits",
              "what": "None of the other categories describes the primary event",
            },
            "product": {
              "not_for": "Financial results, or deals that change ownership",
              "what": "A product launch, recall, contract win, partnership or operational milestone",
            },
            "regulatory": {
              "not_for": "Private lawsuits or settlements between companies",
              "what": "Action by a government agency or regulator (approval, ban, fine, investigation, warning letter)",
            },
          },
          "instructions": "What is the primary event reported in \`article\` about \`company\`?",
          "type": "choice",
        },
        "materiality": {
          "criteria": [
            "No financial consequence",
            "Minor; routine operations or commentary",
            "Meaningful; affects a quarter's results or a product line",
            "Major; changes the company's trajectory (deal, ban, restatement, guidance cut)",
          ],
          "instructions": "How much could the event in \`article\` change \`company\`'s financial outlook?",
          "type": "score",
        },
        "relevant": {
          "criteria": {
            "false": "The company is only mentioned in passing, in a list, or as a comparison",
            "true": "The company is a main subject or a directly affected party",
          },
          "instructions": "Is \`article\` primarily about \`company\` (\`ticker\`), or an event that directly affects it?",
          "type": "noul",
        },
        "sentiment": {
          "criteria": [
            "Serious bad news for the shareholder: losses, failure, major setback, enforcement",
            "Mildly negative: a small miss, a minor risk or delay",
            "Neutral or no clear direction for the shareholder",
            "Mildly positive: a small beat, incremental good news",
            "Strongly positive: a major win, a large upgrade, a transformative deal",
          ],
          "instructions": "For someone who holds shares of \`company\`, how favorable is the news in \`article\`?",
          "type": "score",
        },
      }
    `);
  });
});
