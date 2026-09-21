import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./claudeTranscript";
import { MAX_IMPORTED_MESSAGE_CHARS } from "./transcript";

function writeLog(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "poracode-claude-transcript-"));
  const path = join(dir, "9f1c6b22-0000-4000-8000-000000000001.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return path;
}

const USER_TEXT = {
  type: "user",
  sessionId: "9f1c6b22-0000-4000-8000-000000000001",
  cwd: "F:\\repo",
  timestamp: "2026-09-20T05:00:00.000Z",
  message: { role: "user", content: "fix the bug" },
};

const ASSISTANT_TEXT = {
  type: "assistant",
  timestamp: "2026-09-20T05:00:10.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "on it" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
    ],
  },
};

describe("parseClaudeTranscript", () => {
  it("keeps string and text-array content, dropping thinking and tool_use", () => {
    const path = writeLog([USER_TEXT, ASSISTANT_TEXT]);
    expect(parseClaudeTranscript(path).messages).toEqual([
      { role: "user", text: "fix the bug", at: "2026-09-20T05:00:00.000Z" },
      { role: "assistant", text: "on it", at: "2026-09-20T05:00:10.000Z" },
    ]);
  });

  it("drops Claude Code's own interruption markers", () => {
    const path = writeLog([
      { type: "user", message: { role: "user", content: "[Request interrupted by user]" } },
      {
        type: "user",
        message: { role: "user", content: "[Request interrupted by user for tool use]" },
      },
      USER_TEXT,
    ]);
    expect(parseClaudeTranscript(path).messages.map((m) => m.text)).toEqual(["fix the bug"]);
  });

  it("drops a user line that only carries tool results", () => {
    const path = writeLog([
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
        },
      },
      USER_TEXT,
    ]);
    expect(parseClaudeTranscript(path).messages.map((m) => m.text)).toEqual(["fix the bug"]);
  });

  it("drops sub-agent lines and meta line types", () => {
    const path = writeLog([
      { type: "bridge-session", sessionId: "x" },
      { type: "queue-operation", operation: "enqueue" },
      { type: "system", subtype: "stop_hook_summary" },
      { type: "attachment", attachment: { type: "hook_success" } },
      {
        type: "assistant",
        isSidechain: true,
        message: { content: [{ type: "text", text: "sub" }] },
      },
      USER_TEXT,
    ]);
    expect(parseClaudeTranscript(path).messages.map((m) => m.text)).toEqual(["fix the bug"]);
  });

  it("drops a user turn that is only a task notification", () => {
    const path = writeLog([
      {
        type: "user",
        sessionId: "9f1c6b22-0000-4000-8000-000000000001",
        message: {
          role: "user",
          content:
            "<task-notification>\n<task-id>b6v1</task-id>\n<status>completed</status>\n</task-notification>",
        },
      },
      {
        type: "user",
        sessionId: "9f1c6b22-0000-4000-8000-000000000001",
        message: { role: "user", content: "теперь почини импорт" },
      },
    ]);

    expect(parseClaudeTranscript(path).messages.map((m) => m.text)).toEqual([
      "теперь почини импорт",
    ]);
  });

  it("keeps what the user typed around a system reminder", () => {
    const path = writeLog([
      {
        type: "user",
        sessionId: "9f1c6b22-0000-4000-8000-000000000001",
        message: {
          role: "user",
          content: "проверь ветку<system-reminder>Codebase instructions…</system-reminder>",
        },
      },
    ]);

    expect(parseClaudeTranscript(path).messages.map((m) => m.text)).toEqual(["проверь ветку"]);
  });

  it("skips malformed lines and caps a runaway message", () => {
    const dir = mkdtempSync(join(tmpdir(), "poracode-claude-transcript-"));
    const path = join(dir, "sess.jsonl");
    writeFileSync(
      path,
      [
        "{ not json",
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "y".repeat(MAX_IMPORTED_MESSAGE_CHARS + 500) },
        }),
      ].join("\n"),
      "utf8",
    );
    const [only] = parseClaudeTranscript(path).messages;
    expect(only?.text.length).toBeLessThanOrEqual(MAX_IMPORTED_MESSAGE_CHARS);
    expect(only?.text.endsWith("[… truncated on import]")).toBe(true);
  });

  it("handles CRLF line endings and a file with no trailing newline", () => {
    const dir = mkdtempSync(join(tmpdir(), "poracode-claude-transcript-"));
    const path = join(dir, "sess.jsonl");
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "first" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "second" } }),
    ];
    // Joined with CRLF, and no trailing newline after the last line.
    writeFileSync(path, lines.join("\r\n"), "utf8");
    expect(parseClaudeTranscript(path).messages.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("yields every message from a transcript of a few thousand lines, read across chunk boundaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "poracode-claude-transcript-"));
    const path = join(dir, "sess.jsonl");
    const lineCount = 4000;
    const lines: string[] = [];
    for (let i = 0; i < lineCount; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      lines.push(JSON.stringify({ type: role, message: { role, content: `msg-${i}` } }));
    }
    writeFileSync(path, lines.join("\n"), "utf8");
    const messages = parseClaudeTranscript(path).messages;
    expect(messages).toHaveLength(lineCount);
    expect(messages[0]?.text).toBe("msg-0");
    expect(messages[lineCount - 1]?.text).toBe(`msg-${lineCount - 1}`);
  });
});
