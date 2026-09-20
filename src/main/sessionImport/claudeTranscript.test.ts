import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeTranscript, readClaudeSessionHead } from "./claudeTranscript";
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

describe("readClaudeSessionHead", () => {
  it("takes the session id from the first line that carries one", () => {
    const path = writeLog([{ type: "mode", mode: "normal" }, USER_TEXT]);
    expect(readClaudeSessionHead(path)).toEqual({
      providerSessionId: "9f1c6b22-0000-4000-8000-000000000001",
      cwd: "F:\\repo",
      startedAt: "2026-09-20T05:00:00.000Z",
    });
  });

  it("falls back to the file name when no line carries a session id", () => {
    const path = writeLog([{ type: "mode", mode: "normal" }]);
    expect(readClaudeSessionHead(path)?.providerSessionId).toBe(
      "9f1c6b22-0000-4000-8000-000000000001",
    );
  });
});

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
});
