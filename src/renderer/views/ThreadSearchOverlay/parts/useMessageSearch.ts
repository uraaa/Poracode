import { useEffect, useRef, useState } from "react";
import { readBridge } from "@/renderer/bridge";
import {
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
  type ThreadMessageSearchHit,
} from "@/shared/contracts";

const DEBOUNCE_MS = 150;
/** Mirrors MIN_SEARCH_QUERY_CHARS in the main process. */
const MIN_QUERY_CHARS = 2;

export type MessageSearchStatus = "idle" | "loading" | "ready" | "failed";

const EMPTY_HITS: ThreadMessageSearchHit[] = [];

export function splitSnippet(snippet: string): Array<{ text: string; match: boolean }> {
  const parts: Array<{ text: string; match: boolean }> = [];
  let rest = snippet;
  while (rest.length > 0) {
    const start = rest.indexOf(SNIPPET_MARK_START);
    if (start === -1) {
      parts.push({ text: rest, match: false });
      break;
    }
    if (start > 0) parts.push({ text: rest.slice(0, start), match: false });
    const end = rest.indexOf(SNIPPET_MARK_END, start + 1);
    if (end === -1) {
      parts.push({ text: rest.slice(start + 1), match: true });
      break;
    }
    parts.push({ text: rest.slice(start + 1, end), match: true });
    rest = rest.slice(end + 1);
  }
  return parts;
}

/**
 * Message hits for the current query. A reply is dropped on arrival when the
 * query has already moved on, so a slow request can neither overwrite newer
 * results nor pull the list back into a loading state.
 */
export function useMessageSearch(query: string): {
  hits: ThreadMessageSearchHit[];
  status: MessageSearchStatus;
} {
  const enabled = query.trim().length >= MIN_QUERY_CHARS;
  const [answer, setAnswer] = useState<{
    query: string;
    hits: ThreadMessageSearchHit[];
    status: "ready" | "failed";
  } | null>(null);
  const latestQuery = useRef(query);

  useEffect(() => {
    latestQuery.current = query;
    if (!enabled) return;
    const timer = window.setTimeout(() => {
      void readBridge()
        .searchThreadMessages({ query })
        .then((hits) => {
          if (latestQuery.current !== query) return;
          setAnswer({ query, hits, status: "ready" });
        })
        .catch(() => {
          if (latestQuery.current !== query) return;
          setAnswer({ query, hits: [], status: "failed" });
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, enabled]);

  if (!enabled) return { hits: EMPTY_HITS, status: "idle" };
  if (answer?.query !== query) return { hits: EMPTY_HITS, status: "loading" };
  return { hits: answer.hits, status: answer.status };
}
