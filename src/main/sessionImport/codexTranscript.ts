import { readFileSync } from "node:fs";
import {
  capMessageText,
  stripInjectedContext,
  type ImportedMessage,
  type ImportedTranscript,
} from "./transcript";

/**
 * Codex rollout files are JSONL. The first line is `session_meta`; conversation
 * turns are `response_item` lines whose payload is a `message`. Everything else
 * (`reasoning`, `*_tool_call*`, `event_msg`, `turn_context`, `world_state`) is
 * machinery the import deliberately drops.
 */

interface CodexHead {
  providerSessionId?: string;
  cwd?: string;
  startedAt?: string;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function headFrom(entry: Record<string, unknown>): CodexHead | undefined {
  if (entry["type"] !== "session_meta") return undefined;
  const payload = entry["payload"];
  if (!payload || typeof payload !== "object") return undefined;
  const meta = payload as Record<string, unknown>;
  const head: CodexHead = {};
  if (typeof meta["session_id"] === "string") head.providerSessionId = meta["session_id"];
  if (typeof meta["cwd"] === "string") head.cwd = meta["cwd"];
  if (typeof meta["timestamp"] === "string") head.startedAt = meta["timestamp"];
  return head;
}

/** Read only the first line — enough to list a session without parsing it all. */
export function readCodexSessionHead(path: string): CodexHead | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const [firstLine = ""] = raw.split(/\r?\n/u, 1);
  const entry = parseLine(firstLine);
  return entry ? headFrom(entry) : undefined;
}

function messageFrom(entry: Record<string, unknown>): ImportedMessage | undefined {
  if (entry["type"] !== "response_item") return undefined;
  const payload = entry["payload"];
  if (!payload || typeof payload !== "object") return undefined;
  const item = payload as Record<string, unknown>;
  if (item["type"] !== "message") return undefined;
  const role = item["role"];
  if (role !== "user" && role !== "assistant") return undefined;

  const content = item["content"];
  if (!Array.isArray(content)) return undefined;
  const raw = content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as Record<string, unknown>;
      const kind = block["type"];
      if (kind !== "input_text" && kind !== "output_text") return "";
      return typeof block["text"] === "string" ? block["text"] : "";
    })
    .join("");
  // Codex prefixes a turn with plugin catalogues, environment dumps, and
  // AGENTS.md — words the user never typed. What survives stripping is the
  // real message, and a turn that was pure context leaves nothing.
  const text = role === "user" ? stripInjectedContext(raw) : raw;
  if (text.trim().length === 0) return undefined;

  const at = entry["timestamp"];
  return {
    role,
    text: capMessageText(text),
    ...(typeof at === "string" ? { at } : {}),
  };
}

export function parseCodexTranscript(path: string): ImportedTranscript {
  const raw = readFileSync(path, "utf8");
  const transcript: ImportedTranscript = { messages: [] };
  for (const line of raw.split(/\r?\n/u)) {
    const entry = parseLine(line);
    if (!entry) continue;
    const head = headFrom(entry);
    if (head) {
      Object.assign(transcript, head);
      continue;
    }
    const message = messageFrom(entry);
    if (message) transcript.messages.push(message);
  }
  return transcript;
}
