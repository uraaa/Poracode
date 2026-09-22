import { describe, expect, it } from "vitest";
import { SNIPPET_MARK_END, SNIPPET_MARK_START } from "@/shared/contracts";
import { splitSnippet } from "./useMessageSearch";

describe("splitSnippet", () => {
  it("splits a marked snippet into plain and matched parts", () => {
    const snippet = `…видит ${SNIPPET_MARK_START}импорт${SNIPPET_MARK_END} сессий…`;
    expect(splitSnippet(snippet)).toEqual([
      { text: "…видит ", match: false },
      { text: "импорт", match: true },
      { text: " сессий…", match: false },
    ]);
  });

  it("handles several matches and a snippet with none", () => {
    const snippet = `${SNIPPET_MARK_START}a${SNIPPET_MARK_END}b${SNIPPET_MARK_START}c${SNIPPET_MARK_END}`;
    expect(splitSnippet(snippet)).toEqual([
      { text: "a", match: true },
      { text: "b", match: false },
      { text: "c", match: true },
    ]);
    expect(splitSnippet("ничего")).toEqual([{ text: "ничего", match: false }]);
  });
});
