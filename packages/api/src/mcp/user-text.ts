/**
 * User text shown back inside a result (thesis reasons and conditions, saved memory facts, nudges): one line,
 * JSON-quoted, so it can't end its quotes or forge lines of its own. Control characters (Cc, newlines and tabs
 * included) become spaces and format characters (Cf: zero-width, bidi overrides and isolates) are dropped first, so
 * the text can't hide or reorder what the reader sees.
 */

export const stripControlAndFormat = (s: string): string => s.replace(/\p{Cc}/gu, " ").replace(/\p{Cf}/gu, "");

/** Stripped, whitespace collapsed, cut to `max` (ending "…"), then JSON-quoted. */
export function quoteUserText(text: string, max = Infinity): string {
  const one = stripControlAndFormat(text).replace(/\s+/g, " ").trim();
  return JSON.stringify(one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one);
}

/** Stripped and whitespace collapsed to one trimmed line, unquoted: user text placed inside VestLens's own sentences. */
export const oneLineUserText = (text: string): string => stripControlAndFormat(text).replace(/\s+/g, " ").trim();
