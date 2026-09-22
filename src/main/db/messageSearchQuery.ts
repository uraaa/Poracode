/** Below this, a query matches so much that the result list is noise. */
export const MIN_SEARCH_QUERY_CHARS = 2;

/**
 * An FTS5 phrase query for what the user typed, or null when there is not
 * enough to search for. Everything is quoted: inside a phrase FTS5 treats
 * `*`, `-`, `:`, `AND` and `NEAR` as ordinary text, so a stray operator
 * character cannot turn into a syntax error or a different query.
 */
export function buildPhraseQuery(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length < MIN_SEARCH_QUERY_CHARS) return null;
  return `"${trimmed.replaceAll('"', '""')}"`;
}
