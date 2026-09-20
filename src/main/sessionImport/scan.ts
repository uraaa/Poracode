import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { ImportableSession, ImportedSessionProvider } from "@/shared/contracts";
import type { ImportHome } from "./homes";
import { stripInjectedContext } from "./transcript";

/**
 * Discovery reads as little of each transcript as it can get away with. A real
 * store is large — a developer's `~/.codex/sessions` alone runs to gigabytes
 * across thousands of rollouts — so parsing every file to build a list costs
 * tens of seconds and re-reads the whole store on each open. Instead:
 *
 *   1. enumerate + `stat` (no file bodies) and sort by recency,
 *   2. pull id / cwd / start time out of a small head chunk,
 *   3. read a preview only for the sessions that survive the filters and fall
 *      inside the returned page.
 *
 * Message counts are deliberately absent: an exact count needs the whole file,
 * which is the cost this design exists to avoid. The count is reported after an
 * import instead, when the transcript is parsed anyway.
 */

/** Enough for `session_meta` / the first conversation lines, never a whole file. */
const HEAD_CHUNK_BYTES = 128 * 1024;
/** Codex prefixes a session with injected context that can itself be tens of KB. */
const PREVIEW_CHUNK_BYTES = 512 * 1024;
/** Preview lines are a list affordance, not a document. */
const PREVIEW_MAX_CHARS = 200;
/** Sessions returned per scan. The UI pages; the disk does not. */
const DEFAULT_LIMIT = 200;

interface DiscoveredFile {
  readonly home: ImportHome;
  readonly path: string;
  readonly mtimeMs: number;
}

function walkFiles(root: string, accept: (name: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && accept(entry.name)) found.push(path);
    }
  };
  walk(root);
  return found;
}

function sessionFilesFor(home: ImportHome): string[] {
  return home.provider === "codex"
    ? walkFiles(
        join(home.dir, "sessions"),
        (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
      )
    : walkFiles(join(home.dir, "projects"), (name) => name.endsWith(".jsonl"));
}

/**
 * First `maxBytes` of a file, truncated back to the last complete line so a
 * caller can `JSON.parse` what it gets without meeting half an object.
 */
function readPrefix(path: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    if (length === 0) return "";
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, 0);
    const text = buffer.toString("utf8");
    if (length >= size) return text;
    const lastNewline = text.lastIndexOf("\n");
    return lastNewline >= 0 ? text.slice(0, lastNewline) : text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The descriptor is going away with the process anyway.
      }
    }
  }
}

function unescapeJsonString(raw: string): string | undefined {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return undefined;
  }
}

/**
 * Pull a JSON string field out of raw text. Regex rather than `JSON.parse`
 * because a head chunk can cut a line in half — Codex's `session_meta` carries
 * the whole system prompt and runs past any sane chunk size.
 */
function rawField(text: string, field: string): string | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "u").exec(text);
  return match?.[1] === undefined ? undefined : unescapeJsonString(match[1]);
}

interface SessionHead {
  readonly providerSessionId: string;
  readonly cwd?: string;
  readonly startedAt?: string;
  readonly originator?: string;
  readonly source?: string;
  readonly threadSource?: string;
}

function readHead(file: DiscoveredFile): SessionHead | undefined {
  const prefix = readPrefix(file.path, HEAD_CHUNK_BYTES);
  if (prefix.length === 0) return undefined;
  const id =
    rawField(prefix, file.home.provider === "codex" ? "session_id" : "sessionId") ??
    // Claude names the file after the session; Codex embeds the id in the name.
    basename(file.path)
      .replace(/\.jsonl$/iu, "")
      .replace(/^rollout-[\dT-]*?-/u, "");
  if (!id) return undefined;
  const cwd = rawField(prefix, "cwd");
  const startedAt = rawField(prefix, "timestamp");
  const originator = rawField(prefix, "originator");
  const source = rawField(prefix, "source");
  const threadSource = rawField(prefix, "thread_source");
  return {
    providerSessionId: id,
    ...(cwd ? { cwd } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(originator ? { originator } : {}),
    ...(source ? { source } : {}),
    ...(threadSource ? { threadSource } : {}),
  };
}

/**
 * Sessions Poracode or Codex spawned for their own purposes — a `codex exec`
 * one-shot (thread titles, commit messages) or a sub-agent fan-out. They are
 * real rollout files but were never a conversation the user had, so listing
 * them as importable would bury the sessions that were.
 */
function isMachineSession(head: { originator?: string; source?: string; threadSource?: string }) {
  return (
    head.threadSource === "subagent" || head.source === "exec" || head.originator === "codex_exec"
  );
}

function codexUserText(entry: Record<string, unknown>): string | undefined {
  if (entry["type"] !== "response_item") return undefined;
  const payload = entry["payload"];
  if (!payload || typeof payload !== "object") return undefined;
  const item = payload as Record<string, unknown>;
  if (item["type"] !== "message" || item["role"] !== "user") return undefined;
  const content = item["content"];
  if (!Array.isArray(content)) return undefined;
  return content
    .map((part) =>
      part && typeof part === "object" && (part as Record<string, unknown>)["type"] === "input_text"
        ? String((part as Record<string, unknown>)["text"] ?? "")
        : "",
    )
    .join("");
}

function claudeUserText(entry: Record<string, unknown>): string | undefined {
  if (entry["type"] !== "user" || entry["isSidechain"] === true) return undefined;
  const message = entry["message"];
  if (!message || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((part) =>
      part && typeof part === "object" && (part as Record<string, unknown>)["type"] === "text"
        ? String((part as Record<string, unknown>)["text"] ?? "")
        : "",
    )
    .join("");
}

/** First thing the user actually typed, read from the head of the file only. */
function readPreview(file: DiscoveredFile): string {
  const prefix = readPrefix(file.path, PREVIEW_CHUNK_BYTES);
  for (const line of prefix.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const raw = file.home.provider === "codex" ? codexUserText(entry) : claudeUserText(entry);
    if (raw === undefined) continue;
    const text = stripInjectedContext(raw).replace(/\s+/gu, " ").trim();
    if (text.length === 0) continue;
    return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text;
  }
  return "";
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const normalize = (value: string) => value.replace(/[\\/]+$/u, "").replace(/\\/gu, "/");
  return (
    normalize(left).localeCompare(normalize(right), undefined, { sensitivity: "accent" }) === 0
  );
}

/**
 * Discover importable transcripts across the given homes, newest first. Never
 * throws: an unreadable file or a missing home is skipped so one bad session
 * cannot hide the rest of a user's history.
 */
export function scanImportableSessions(input: {
  homes: readonly ImportHome[];
  cwd?: string;
  provider?: ImportedSessionProvider;
  limit?: number;
}): ImportableSession[] {
  const files: DiscoveredFile[] = [];
  for (const home of input.homes) {
    if (input.provider && home.provider !== input.provider) continue;
    for (const path of sessionFilesFor(home)) {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      files.push({ home, path, mtimeMs });
    }
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const limit = input.limit ?? DEFAULT_LIMIT;
  const sessions: ImportableSession[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (sessions.length >= limit) break;
    const head = readHead(file);
    if (!head) continue;
    if (isMachineSession(head)) continue;
    const id = `${file.home.provider}:${head.providerSessionId}`;
    if (seen.has(id)) continue;
    if (input.cwd && !samePath(head.cwd, input.cwd)) continue;
    const preview = readPreview(file);
    if (preview.length === 0) continue;
    seen.add(id);
    sessions.push({
      id,
      provider: file.home.provider,
      agentKind: file.home.agentKind,
      providerSessionId: head.providerSessionId,
      path: file.path,
      ...(head.cwd ? { cwd: head.cwd } : {}),
      ...(head.startedAt ? { startedAt: head.startedAt } : {}),
      updatedAt: new Date(file.mtimeMs).toISOString(),
      preview,
      cwdExists: head.cwd !== undefined && existsSync(head.cwd),
    });
  }
  return sessions;
}
