import { describe, expect, it } from "vitest";
import { extractMessageText } from "./messageText";

describe("extractMessageText", () => {
  it("reads the text blocks of a user message", () => {
    expect(
      extractMessageText({
        type: "user_message",
        state: "completed",
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
        state: "completed",
        streams: { assistant_text: "Готово.", reasoning_text: "ignored" },
      }),
    ).toEqual({ role: "assistant", text: "Готово." });
  });

  it("indexes what an authoritative payload displays, not the streamed text", () => {
    expect(
      extractMessageText({
        type: "assistant_message",
        state: "completed",
        payload: {
          displayAuthoritative: true,
          content: [{ kind: "text", text: "секрет вырезан" }],
        },
        streams: { assistant_text: "пароль hunter2" },
      }),
    ).toEqual({ role: "assistant", text: "секрет вырезан" });
  });

  it("indexes nothing when an authoritative payload suppresses the message", () => {
    expect(
      extractMessageText({
        type: "assistant_message",
        state: "completed",
        payload: { displayAuthoritative: true, content: [{ kind: "text", text: "" }] },
        streams: { assistant_text: "пароль hunter2" },
      }),
    ).toBeNull();
  });

  it("returns null for a type that is not indexed", () => {
    expect(
      extractMessageText({
        type: "command_execution",
        state: "completed",
        payload: { command: "ls" },
        streams: {},
      }),
    ).toBeNull();
  });

  it("returns null when a message carries no text", () => {
    expect(
      extractMessageText({ type: "assistant_message", state: "completed", streams: {} }),
    ).toBeNull();
    expect(
      extractMessageText({
        type: "user_message",
        state: "completed",
        payload: { content: [] },
        streams: {},
      }),
    ).toBeNull();
    expect(
      extractMessageText({
        type: "user_message",
        state: "completed",
        payload: undefined,
        streams: {},
      }),
    ).toBeNull();
  });

  it("survives a payload that is not the expected shape", () => {
    expect(
      extractMessageText({
        type: "user_message",
        state: "completed",
        payload: "nonsense",
        streams: {},
      }),
    ).toBeNull();
  });
});
