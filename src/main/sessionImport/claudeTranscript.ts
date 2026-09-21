import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  capMessageText,
  stripInjectedContext,
  type ImportedMessage,
  type ImportedTranscript,
} from "./transcript";

/**
 * Claude Code writes one JSONL file per session under
 * `<home>/projects/<encoded cwd>/<session id>.jsonl`. Conversation lines are
 * `type: "user" | "assistant"`; everything else on the stream (hooks, queue
 * operations, bridge/session bookkeeping) is machinery. `isSidechain` marks
 * sub-agent traffic, which the import drops so the transcript matches what the
 * user actually saw in their own pane.
 */

interface ClaudeHead {
  providerSessionId?: string;
  cwd?: string;
  startedAt?: string;
}

/**
 * Claude Code writes its own bracketed notes into the `user` role when a turn
 * is cut short. They are transcript bookkeeping, not something the user typed,
 * so a message consisting only of one is dropped.
 */
const INTERRUPTION_MARKER_RE = /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/u;

function parseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function sessionIdFromFileName(path: string): string {
  return basename(path).replace(/\.jsonl$/iu, "");
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as Record<string, unknown>;
      if (block["type"] !== "text") return "";
      return typeof block["text"] === "string" ? block["text"] : "";
    })
    .join("");
}

function messageFrom(entry: Record<string, unknown>): ImportedMessage | undefined {
  const role = entry["type"];
  if (role !== "user" && role !== "assistant") return undefined;
  if (entry["isSidechain"] === true) return undefined;
  const message = entry["message"];
  if (!message || typeof message !== "object") return undefined;
  const raw = textFromContent((message as Record<string, unknown>)["content"]);
  if (raw.trim().length === 0) return undefined;
  if (role === "user" && INTERRUPTION_MARKER_RE.test(raw)) return undefined;
  // Claude Code writes machine blocks (task notifications, slash-command
  // echoes, system reminders) into the user role as plain text. Strip them so
  // only what the user actually typed is replayed.
  const text = role === "user" ? stripInjectedContext(raw) : raw;
  if (text.trim().length === 0) return undefined;
  const at = entry["timestamp"];
  return {
    role,
    text: capMessageText(text),
    ...(typeof at === "string" ? { at } : {}),
  };
}

export function readClaudeSessionHead(path: string): ClaudeHead | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const head: ClaudeHead = { providerSessionId: sessionIdFromFileName(path) };
  for (const line of raw.split(/\r?\n/u)) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (typeof entry["sessionId"] === "string") head.providerSessionId = entry["sessionId"];
    if (!head.cwd && typeof entry["cwd"] === "string") head.cwd = entry["cwd"];
    if (!head.startedAt && typeof entry["timestamp"] === "string") {
      head.startedAt = entry["timestamp"];
    }
    if (head.cwd && head.startedAt) break;
  }
  return head;
}

export function parseClaudeTranscript(path: string): ImportedTranscript {
  const raw = readFileSync(path, "utf8");
  const transcript: ImportedTranscript = {
    providerSessionId: sessionIdFromFileName(path),
    messages: [],
  };
  for (const line of raw.split(/\r?\n/u)) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (typeof entry["sessionId"] === "string") transcript.providerSessionId = entry["sessionId"];
    if (!transcript.cwd && typeof entry["cwd"] === "string") transcript.cwd = entry["cwd"];
    if (!transcript.startedAt && typeof entry["timestamp"] === "string") {
      transcript.startedAt = entry["timestamp"];
    }
    const message = messageFrom(entry);
    if (message) transcript.messages.push(message);
  }
  return transcript;
}
