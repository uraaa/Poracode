import { MIN_SEARCH_QUERY_CHARS } from "@/shared/contracts";

export { MIN_SEARCH_QUERY_CHARS };

/**
 * C0 controls and DEL. A NUL truncates the bound string on its way into SQLite
 * and FTS5 then reports an unterminated string; U+0001 and U+0002 are the
 * snippet markers. Pasted terminal output carries both.
 */
// eslint-disable-next-line no-control-regex -- matching them is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const WHITESPACE_RUN = /\s+/g;

/**
 * An FTS5 phrase query for what the user typed, or null when there is not
 * enough to search for. Everything is quoted: inside a phrase FTS5 treats
 * `*`, `-`, `:`, `AND` and `NEAR` as ordinary text, so a stray operator
 * character cannot turn into a syntax error or a different query.
 */
export function buildPhraseQuery(input: string): string | null {
  const trimmed = input.replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE_RUN, " ").trim();
  if (trimmed.length < MIN_SEARCH_QUERY_CHARS) return null;
  return `"${trimmed.replaceAll('"', '""')}"`;
}
