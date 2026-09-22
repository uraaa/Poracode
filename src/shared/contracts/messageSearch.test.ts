import { describe, expect, it } from "vitest";
import { searchThreadMessagesPayloadSchema } from "./messageSearch";

describe("searchThreadMessagesPayloadSchema", () => {
  it("defaults the limit", () => {
    expect(searchThreadMessagesPayloadSchema.parse({ query: "импорт" })).toEqual({
      query: "импорт",
      limit: 50,
    });
  });

  it("keeps an explicit limit within bounds", () => {
    expect(searchThreadMessagesPayloadSchema.parse({ query: "a", limit: 10 }).limit).toBe(10);
    expect(() => searchThreadMessagesPayloadSchema.parse({ query: "a", limit: 0 })).toThrow(
      /too small/i,
    );
    expect(() => searchThreadMessagesPayloadSchema.parse({ query: "a", limit: 500 })).toThrow(
      /too big/i,
    );
  });

  it("accepts an empty query and lets the store decide", () => {
    expect(searchThreadMessagesPayloadSchema.parse({ query: "" }).query).toBe("");
  });
});
