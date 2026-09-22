import { describe, expect, it } from "vitest";
import { extractMessageText } from "./messageText";

describe("extractMessageText", () => {
  it("reads the text blocks of a user message", () => {
    expect(
      extractMessageText({
        type: "user_message",
        payload: {
          content: [
            { kind: "text", text: "первая строка" },
            { kind: "image", url: "file:///tmp/a.png" },
            { kind: "text", text: "вторая строка" },
          ],
        },
        streams: {},
      }),
    ).toEqual({ role: "user", text: "первая строка\nвторая строка" });
  });

  it("reads the assistant text stream", () => {
    expect(
      extractMessageText({
        type: "assistant_message",
        streams: { assistant_text: "Готово.", reasoning_text: "ignored" },
      }),
    ).toEqual({ role: "assistant", text: "Готово." });
  });

  it("returns null for a type that is not indexed", () => {
    expect(
      extractMessageText({ type: "command_execution", payload: { command: "ls" }, streams: {} }),
    ).toBeNull();
  });

  it("returns null when a message carries no text", () => {
    expect(extractMessageText({ type: "assistant_message", streams: {} })).toBeNull();
    expect(
      extractMessageText({ type: "user_message", payload: { content: [] }, streams: {} }),
    ).toBeNull();
    expect(
      extractMessageText({ type: "user_message", payload: undefined, streams: {} }),
    ).toBeNull();
  });

  it("survives a payload that is not the expected shape", () => {
    expect(
      extractMessageText({ type: "user_message", payload: "nonsense", streams: {} }),
    ).toBeNull();
  });
});
