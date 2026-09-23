import { describe, expect, it } from "vitest";
import { buildPhraseQuery, MIN_SEARCH_QUERY_CHARS } from "./messageSearchQuery";

describe("buildPhraseQuery", () => {
  it("wraps the input in one quoted phrase", () => {
    expect(buildPhraseQuery("импорт сессий")).toBe('"импорт сессий"');
  });

  it("trims and collapses surrounding whitespace", () => {
    expect(buildPhraseQuery("  импорт  ")).toBe('"импорт"');
  });

  it("rejects input shorter than the minimum", () => {
    expect(MIN_SEARCH_QUERY_CHARS).toBe(2);
    expect(buildPhraseQuery("")).toBeNull();
    expect(buildPhraseQuery("   ")).toBeNull();
    expect(buildPhraseQuery("и")).toBeNull();
  });

  it("escapes embedded quotes by doubling them", () => {
    expect(buildPhraseQuery('он сказал "нет"')).toBe('"он сказал ""нет"""');
  });

  it("strips control characters, which FTS5 reads as an unterminated string", () => {
    const withNul = `импорт${String.fromCharCode(0)} сессий`;
    expect(buildPhraseQuery(withNul)).toBe('"импорт сессий"');
    expect(buildPhraseQuery(String.fromCharCode(1, 2))).toBeNull();
  });

  it("neutralises FTS5 operators so they match literally", () => {
    expect(buildPhraseQuery("NEAR(a b)")).toBe('"NEAR(a b)"');
    expect(buildPhraseQuery("foo* -bar AND baz:qux")).toBe('"foo* -bar AND baz:qux"');
  });
});
