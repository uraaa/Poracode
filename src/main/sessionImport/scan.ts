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
import { isSameFolderPath } from "@/shared/pathUtils";
import type { ImportHome } from "./homes";
import { readClaudeTitle, readCodexTitles } from "./titles";
import { CLAUDE_METADATA_RECORD_TYPES, stripInjectedContext } from "./transcript";

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
/**
 * Cap on each of the module-level memos below. Everything a scan reads off
 * disk — a head, a preview, a title — is memoised per transcript, so bounding
 * by entry count keeps a long-running main process from holding one entry per
 * transcript it has ever seen. The values are small (a head is a handful of
 * strings, a preview at most {@link PREVIEW_MAX_CHARS}); the file *bytes*
 * they were derived from are never kept.
 */
const SCAN_MEMO_LIMIT = 4000;

interface ScanMemo<T> {
  /** `hit` distinguishes "not memoised" from "memoised as `undefined`". */
  recall: (key: string) => { hit: boolean; value: T | undefined };
  remember: (key: string, value: T) => void;
}

/**
 * A bounded memo scoped to the module rather than one
 * `scanImportableSessions` call, so a rescan — which a query triggers on
 * every debounced keystroke — reuses what the previous scan already paid to
 * read instead of re-reading the same files on the Electron main thread.
 * Insertion order doubles as recency: a hit is moved to the end, so evicting
 * from the front is an LRU eviction.
 */
function createScanMemo<T>(limit: number): ScanMemo<T> {
  const entries = new Map<string, T>();
  return {
    recall: (key) => {
      if (!entries.has(key)) return { hit: false, value: undefined };
      const value = entries.get(key) as T;
      entries.delete(key);
      entries.set(key, value);
      return { hit: true, value };
    },
    remember: (key, value) => {
      entries.delete(key);
      entries.set(key, value);
      if (entries.size > limit) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey !== undefined) entries.delete(oldestKey);
      }
    },
  };
}

/**
 * Keyed by file path + `mtimeMs` + size, so a rewritten transcript is a new
 * key and is read again rather than serving whatever the old bytes said for
 * the life of the main process. Size as well as mtime because a filesystem
 * with a coarse timestamp can report the same tick for two writes close
 * together, and it costs nothing: the `stat` that reports the mtime reports
 * the size in the same call.
 */
function memoKey(file: DiscoveredFile): string {
  return `${file.path}:${file.mtimeMs}:${file.size}`;
}

/** One head per transcript, the candidate pass's whole per-file disk cost. */
const headCache = createScanMemo<SessionHead | undefined>(SCAN_MEMO_LIMIT);
/** One preview per transcript, read only for sessions that reach the page. */
const previewCache = createScanMemo<string>(SCAN_MEMO_LIMIT);
/** A title read is a real file read for Claude (`readClaudeTitle`'s tail seek). */
const titleCache = createScanMemo<string | undefined>(SCAN_MEMO_LIMIT);

interface DiscoveredFile {
  readonly home: ImportHome;
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
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

interface FilePrefix {
  readonly text: string;
  /** Whether the file continues past what was read — worth a deeper read. */
  readonly cut: boolean;
}

/**
 * First `maxBytes` of a file, truncated back to the last complete line so a
 * caller can `JSON.parse` what it gets without meeting half an object.
 */
function readPrefix(path: string, maxBytes: number): FilePrefix {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    if (length === 0) return { text: "", cut: false };
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, 0);
    const text = buffer.toString("utf8");
    if (length >= size) return { text, cut: false };
    const lastNewline = text.lastIndexOf("\n");
    return { text: lastNewline >= 0 ? text.slice(0, lastNewline) : text, cut: true };
  } catch {
    return { text: "", cut: false };
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
 * Pull a JSON string field out of raw text with a regex rather than
 * `JSON.parse`. Used only as the fallback for a head chunk's final line when
 * that line fails to parse — either because the chunk boundary cut it in
 * half (Codex's `session_meta` carries the whole system prompt and can run
 * past any sane chunk size) or because the file itself ends mid-write. The
 * closing-quote requirement means a value cut mid-string comes back
 * `undefined` rather than a partial value either way.
 */
function rawField(text: string, field: string): string | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "u").exec(text);
  return match?.[1] === undefined ? undefined : unescapeJsonString(match[1]);
}

/** A line's parsed JSON, only when it's a non-null, non-array object. */
function parseJsonRecord(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface SessionHead {
  readonly providerSessionId: string;
  readonly cwd?: string;
  readonly startedAt?: string;
  readonly originator?: string;
  readonly source?: string;
  readonly threadSource?: string;
  /** Claude: account the conversation belongs to (`ownerAccountUuid`). */
  readonly accountId?: string;
  /**
   * Model the provider recorded, when the head chunk carries one. Neither
   * provider puts it on the meta line: Codex writes it to `turn_context`,
   * Claude to `message.model` on `assistant` records.
   */
  readonly model?: string;
}

interface RawHeadFields {
  readonly id?: string | undefined;
  readonly cwd?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly originator?: string | undefined;
  readonly source?: string | undefined;
  readonly threadSource?: string | undefined;
  readonly accountId?: string | undefined;
  readonly model?: string | undefined;
}

/**
 * Codex's `session_meta` is always the first line of a rollout and is the
 * only record carrying `session_id` / `cwd` / `timestamp` / `originator` /
 * `source` / `thread_source`. Each complete line is `JSON.parse`d and fields
 * are read by key path off the record's own `type` — structural access means
 * nothing a user typed in a later message (which can itself look like JSON)
 * can be mistaken for one of these fields purely by appearing first in the
 * text, the way a plain text search could be fooled.
 *
 * The model can live on any of three record kinds, and the first one found
 * (in file order) wins, since the earliest record reflects how the session
 * started: `session_meta.payload.model`, `turn_context.payload.model`, or
 * `event_msg.payload.thread_settings.model` on the `event_msg` whose
 * `payload.type` is `thread_settings_applied`. All are always within the
 * first few lines of the file. Everything except the model only ever comes
 * from `session_meta`, and Codex always writes that first, so scanning stops
 * once `session_meta` has been seen and the model is known — not once every
 * field this function returns is known, which a `session_meta` missing one
 * field (a different CLI version, say) could otherwise never satisfy,
 * chasing a field that can no longer arrive through the rest of the chunk.
 *
 * The head chunk can still cut a line in half — a `session_meta` line can
 * carry the whole system prompt and run past `HEAD_CHUNK_BYTES` on its own —
 * so a line that fails to parse only gets the old regex-based extraction
 * when it is the final line of the chunk. Every other unparseable line (real
 * corruption, not a boundary cut) is simply skipped. The `session_meta`
 * fallback fields are further gated on `index === 0`: Codex only ever writes
 * `session_meta` as the very first line, so a later, corrupted line whose
 * regex-read `type` merely *says* `session_meta` (text inside a truncated
 * value can say anything) must not be trusted for those fields the way the
 * structural path and the old pre-Task-14 code never did either. `model`
 * has no such position: it can legitimately come from a `turn_context` (or,
 * structurally, an `event_msg`) at any line, so that half stays unrestricted.
 */
function codexHeadFields(prefix: string): RawHeadFields {
  const lines = prefix.split(/\r?\n/u).filter((line) => line.length > 0);
  let id: string | undefined;
  let cwd: string | undefined;
  let startedAt: string | undefined;
  let originator: string | undefined;
  let source: string | undefined;
  let threadSource: string | undefined;
  let model: string | undefined;
  let sawSessionMeta = false;

  for (let index = 0; index < lines.length; index++) {
    if (sawSessionMeta && model !== undefined) break;
    const line = lines[index] as string;
    const record = parseJsonRecord(line);
    if (record) {
      const type = record["type"];
      if (type === "session_meta") {
        sawSessionMeta = true;
        const payload = objectField(record["payload"]);
        if (payload) {
          id ??= stringField(payload["session_id"]);
          cwd ??= stringField(payload["cwd"]);
          startedAt ??= stringField(payload["timestamp"]);
          originator ??= stringField(payload["originator"]);
          source ??= stringField(payload["source"]);
          threadSource ??= stringField(payload["thread_source"]);
          model ??= stringField(payload["model"]);
        }
      } else if (type === "turn_context") {
        const payload = objectField(record["payload"]);
        if (payload) model ??= stringField(payload["model"]);
      } else if (type === "event_msg") {
        const payload = objectField(record["payload"]);
        if (payload?.["type"] === "thread_settings_applied") {
          const settings = objectField(payload["thread_settings"]);
          if (settings) model ??= stringField(settings["model"]);
        }
      }
      continue;
    }
    if (index !== lines.length - 1) continue;
    // Final line only, and only because it failed to parse.
    const fallbackType = rawField(line, "type");
    if (fallbackType === "session_meta" && index === 0) {
      sawSessionMeta = true;
      id ??= rawField(line, "session_id");
      cwd ??= rawField(line, "cwd");
      startedAt ??= rawField(line, "timestamp");
      originator ??= rawField(line, "originator");
      source ??= rawField(line, "source");
      threadSource ??= rawField(line, "thread_source");
    }
    if (fallbackType === "session_meta" || fallbackType === "turn_context") {
      model ??= rawField(line, "model");
    }
  }

  return { id, cwd, startedAt, originator, source, threadSource, model };
}

/**
 * `message.model` scoped to the `message` object's own keys, used only by
 * `claudeHeadFields`'s truncated-final-line fallback (structural access
 * handles every complete line via `record["message"]` directly). The
 * `type === "assistant"` gate alone is not enough even there: an assistant's
 * own `content` can carry a tool call whose arguments are real, unescaped
 * JSON — a call to a completion tool with a `model` argument, say — and a
 * bare `rawField(line, "model")` over the whole line would happily match
 * that instead of the record's real `message.model`. Slicing from
 * `"message":{` to the `content` key excludes `content` (and everything
 * nested inside it) entirely, so only the message's own sibling fields —
 * `id` / `type` / `role` / `model`, always serialised ahead of `content` —
 * are ever in play. A record cut short before reaching `content` searches to
 * the end of what was read instead, which is still safe: everything up to
 * that point is still the message's own fields, never `content`'s.
 */
function claudeAssistantModel(line: string): string | undefined {
  const messageStart = line.indexOf('"message":{');
  if (messageStart === -1) return undefined;
  const contentStart = line.indexOf('"content"', messageStart);
  const scope =
    contentStart === -1 ? line.slice(messageStart) : line.slice(messageStart, contentStart);
  return rawField(scope, "model");
}

/**
 * Claude has no single meta line — `sessionId` / `cwd` / `timestamp` /
 * `ownerAccountUuid` are spread across ordinary conversation records. Each
 * complete line is `JSON.parse`d and gated on the record's own `type` key,
 * read structurally rather than by text search: real Claude records order
 * their keys `parentUuid, isSidechain, message, …, type, uuid, timestamp, …`,
 * so on an `assistant` record a plain first-`"type"`-in-the-line search finds
 * `message.type` ("message") before the record's own `type` — which isn't in
 * `CLAUDE_METADATA_RECORD_TYPES` — and silently skips the whole line. Reading
 * `record["type"]` off the parsed object can't be fooled by key order.
 *
 * `message.model` is narrower still: it only ever appears on an `assistant`
 * record, read structurally off `record["message"]`. Keep scanning until
 * every field — including the model — is known or the head chunk runs out; a
 * session whose first assistant reply sits later in the file (a long opening
 * user turn) still finds it as long as it's inside the chunk already read.
 * The cost of that is bounded: at most the {@link HEAD_CHUNK_BYTES} already
 * in memory, on a scan that already runs synchronously on the main thread
 * once per candidate file, so a chunk with no assistant record simply gets
 * scanned in full instead of stopping at `cwd`/`startedAt` — no new I/O.
 *
 * The head chunk can still cut the final line in half (or the file itself
 * can end mid-write); only that line, and only when it fails to parse, falls
 * back to the old regex-based extraction, still gated on the same type set —
 * read via regex here since there is no parsed object to read a key off.
 */
function claudeHeadFields(prefix: string): RawHeadFields {
  const lines = prefix.split(/\r?\n/u).filter((line) => line.length > 0);
  let id: string | undefined;
  let cwd: string | undefined;
  let startedAt: string | undefined;
  let accountId: string | undefined;
  let model: string | undefined;

  for (let index = 0; index < lines.length; index++) {
    if (cwd !== undefined && startedAt !== undefined && model !== undefined) break;
    const line = lines[index] as string;
    const record = parseJsonRecord(line);
    if (record) {
      const type = record["type"];
      if (typeof type === "string" && CLAUDE_METADATA_RECORD_TYPES.has(type)) {
        id ??= stringField(record["sessionId"]);
        cwd ??= stringField(record["cwd"]);
        startedAt ??= stringField(record["timestamp"]);
        accountId ??= stringField(record["ownerAccountUuid"]);
        if (type === "assistant") {
          const message = objectField(record["message"]);
          if (message) model ??= stringField(message["model"]);
        }
      }
      continue;
    }
    if (index !== lines.length - 1) continue;
    // Final line only, and only because it failed to parse.
    const fallbackType = rawField(line, "type");
    if (fallbackType && CLAUDE_METADATA_RECORD_TYPES.has(fallbackType)) {
      id ??= rawField(line, "sessionId");
      cwd ??= rawField(line, "cwd");
      startedAt ??= rawField(line, "timestamp");
      accountId ??= rawField(line, "ownerAccountUuid");
      if (fallbackType === "assistant") model ??= claudeAssistantModel(line);
    }
  }

  return { id, cwd, startedAt, accountId, model };
}

function parseHead(file: DiscoveredFile): SessionHead | undefined {
  const prefix = readPrefix(file.path, HEAD_CHUNK_BYTES).text;
  if (prefix.length === 0) return undefined;
  const fields =
    file.home.provider === "codex" ? codexHeadFields(prefix) : claudeHeadFields(prefix);
  // The filename fallback below exists for a real transcript whose id simply
  // isn't repeated inside the head (Claude names the file after the session;
  // Codex embeds the id in the name too). It must not be the ONLY thing that
  // makes a file look like a session: a file whose head is outright garbage —
  // unparseable content, no id, no cwd, no timestamp, nothing — still fails
  // every field regex and would otherwise inherit a plausible-looking id from
  // its own filename alone. Require at least one field to have actually been
  // read out of the content before trusting the filename for the rest.
  const hasContentField =
    fields.id !== undefined ||
    fields.cwd !== undefined ||
    fields.startedAt !== undefined ||
    fields.originator !== undefined ||
    fields.source !== undefined ||
    fields.threadSource !== undefined ||
    fields.accountId !== undefined ||
    fields.model !== undefined;
  if (!hasContentField) return undefined;
  const id =
    fields.id ??
    basename(file.path)
      .replace(/\.jsonl$/iu, "")
      .replace(/^rollout-[\dT-]*?-/u, "");
  if (!id) return undefined;
  return {
    providerSessionId: id,
    ...(fields.cwd ? { cwd: fields.cwd } : {}),
    ...(fields.startedAt ? { startedAt: fields.startedAt } : {}),
    ...(fields.originator ? { originator: fields.originator } : {}),
    ...(fields.source ? { source: fields.source } : {}),
    ...(fields.threadSource ? { threadSource: fields.threadSource } : {}),
    ...(file.home.provider === "claude" && fields.accountId ? { accountId: fields.accountId } : {}),
    ...(fields.model ? { model: fields.model } : {}),
  };
}

/**
 * The candidate pass's one read per transcript — the single biggest cost of a
 * scan at a few hundred files, and repaid in full on every debounced
 * keystroke before this memo existed.
 */
function readHead(file: DiscoveredFile): SessionHead | undefined {
  const key = memoKey(file);
  const cached = headCache.recall(key);
  if (cached.hit) return cached.value;
  const head = parseHead(file);
  headCache.remember(key, head);
  return head;
}

/**
 * The account a session belongs to. Normally the home it was found in — but a
 * Claude transcript names its owner, and Claude Desktop writes every
 * conversation to the base home whatever login it holds. When that owner is a
 * configured profile, the session is that profile's: it is listed under it and
 * imports there (the transcript gets copied into the profile's home). The home
 * the file sits in wins a tie, so a base-home session whose login also has a
 * profile stays with the base home.
 */
function ownerAgentKind(
  file: DiscoveredFile,
  head: SessionHead,
  homes: readonly ImportHome[],
): string {
  if (!head.accountId || file.home.accountId === head.accountId) return file.home.agentKind;
  const owner = homes.find(
    (home) => home.provider === file.home.provider && home.accountId === head.accountId,
  );
  return owner?.agentKind ?? file.home.agentKind;
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

/**
 * First thing the user actually typed inside `prefix`, or `undefined` when
 * this much of the file held nothing — which is what tells the caller a
 * deeper read might still find something.
 */
function firstUserText(prefix: string, provider: ImportedSessionProvider): string | undefined {
  for (const line of prefix.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const raw = provider === "codex" ? codexUserText(entry) : claudeUserText(entry);
    if (raw === undefined) continue;
    const text = stripInjectedContext(raw).replace(/\s+/gu, " ").trim();
    if (text.length === 0) continue;
    return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text;
  }
  return undefined;
}

/**
 * First thing the user actually typed, read from the head of the file only.
 *
 * Reads the same 128 KB the candidate pass read rather than 512 KB outright:
 * a session's first user turn is almost always inside it, so the deep read
 * that exists for the rare transcript whose injected preamble runs past the
 * head chunk is paid only by that transcript. Memoised per transcript so a
 * rescan does not repeat either read.
 */
function readPreview(file: DiscoveredFile): string {
  const key = memoKey(file);
  const cached = previewCache.recall(key);
  if (cached.hit) return cached.value ?? "";
  const head = readPrefix(file.path, HEAD_CHUNK_BYTES);
  let text = firstUserText(head.text, file.home.provider);
  if (text === undefined && head.cut) {
    text = firstUserText(readPrefix(file.path, PREVIEW_CHUNK_BYTES).text, file.home.provider);
  }
  const preview = text ?? "";
  previewCache.remember(key, preview);
  return preview;
}

/**
 * Discover importable transcripts across the given homes, newest first. Never
 * throws: an unreadable file or a missing home is skipped so one bad session
 * cannot hide the rest of a user's history.
 */
export interface ImportScanFacets {
  /** Every provider, account and folder the scan saw, page limit or not. */
  readonly providers: ImportedSessionProvider[];
  readonly accounts: string[];
  readonly folders: string[];
}

export interface ImportScanResult {
  readonly sessions: ImportableSession[];
  readonly facets: ImportScanFacets;
  /** Whether more sessions survived the filters than the page limit could hold. */
  readonly truncated: boolean;
}

interface SessionCandidate {
  readonly file: DiscoveredFile;
  readonly head: SessionHead;
  readonly id: string;
  readonly agentKind: string;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
}

export function scanImportableSessions(input: {
  homes: readonly ImportHome[];
  cwd?: string;
  provider?: ImportedSessionProvider;
  agentKind?: string;
  /**
   * Matched case-insensitively against the title (the provider's own index,
   * already cheap) and the folder — never the preview, which would cost a
   * 512 KB read per candidate. Applied before the page is cut so it searches
   * every session the filters allow, not just the returned page.
   */
  query?: string;
  limit?: number;
  /** Injectable so a scan can memoise or fake folder checks. Defaults to `existsSync`. */
  exists?: (path: string) => boolean;
  /** Injectable so folder comparison is testable on any machine. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}): ImportScanResult {
  const exists = input.exists ?? existsSync;
  const platform = input.platform ?? process.platform;
  // A scan checks the same cwd repeatedly across sessions that share a
  // folder; the cache is local to this call so a folder created between
  // scans is still seen next time.
  const existsCache = new Map<string, boolean>();
  const cachedExists = (path: string): boolean => {
    let value = existsCache.get(path);
    if (value === undefined) {
      value = exists(path);
      existsCache.set(path, value);
    }
    return value;
  };
  // Codex titles come from one index per home; opened on first use so a
  // scan that never reaches a home's files never touches its database.
  const codexTitlesByHome = new Map<string, Map<string, string>>();
  const titleFor = (file: DiscoveredFile, providerSessionId: string): string | undefined => {
    if (file.home.provider === "claude") return readClaudeTitle(file.path);
    let titles = codexTitlesByHome.get(file.home.dir);
    if (!titles) {
      titles = readCodexTitles(file.home.dir);
      codexTitlesByHome.set(file.home.dir, titles);
    }
    return titles.get(providerSessionId);
  };
  // The query predicate and the page-building loop below both want a
  // candidate's title; the module-level cache above means a title already
  // read by an earlier scan (or earlier in this one) is never read twice.
  const cachedTitleFor = (candidate: SessionCandidate): string | undefined => {
    // Claude only. A Claude title is read out of the transcript's own tail, so
    // the transcript's `mtimeMs` is exactly the right thing to key it on. A
    // Codex title lives in `state_<n>.sqlite`, which that mtime knows nothing
    // about: keying it there would mean a thread renamed in Codex Desktop
    // never reaching the panel for the life of the main process. It would buy
    // nothing anyway — `readCodexTitles` is one map per home per scan, and
    // `codexTitlesByHome` above already keeps it to one read.
    if (candidate.file.home.provider !== "claude") {
      return titleFor(candidate.file, candidate.head.providerSessionId);
    }
    const key = memoKey(candidate.file);
    const cached = titleCache.recall(key);
    if (cached.hit) return cached.value;
    const title = titleFor(candidate.file, candidate.head.providerSessionId);
    titleCache.remember(key, title);
    return title;
  };
  const files: DiscoveredFile[] = [];
  for (const home of input.homes) {
    if (input.provider && home.provider !== input.provider) continue;
    for (const path of sessionFilesFor(home)) {
      let stats: import("node:fs").Stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      files.push({ home, path, mtimeMs: stats.mtimeMs, size: stats.size });
    }
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);

  // Heads first, for every file: they cost a small read each and are what the
  // filters and the facet lists are made of. Reading them all is what lets a
  // folder whose sessions are old still be offered and still be listed — the
  // page limit below counts sessions that survived the filters, so cutting
  // before them would hide most of a quiet folder's history.
  const candidates: SessionCandidate[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const head = readHead(file);
    if (!head) continue;
    if (isMachineSession(head)) continue;
    const id = `${file.home.provider}:${head.providerSessionId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    candidates.push({ file, head, id, agentKind: ownerAgentKind(file, head, input.homes) });
  }

  const matchesProvider = (candidate: SessionCandidate) =>
    !input.provider || candidate.file.home.provider === input.provider;
  const matchesAccount = (candidate: SessionCandidate) =>
    !input.agentKind || candidate.agentKind === input.agentKind;
  const matchesCwd = (candidate: SessionCandidate) =>
    !input.cwd || isSameFolderPath(candidate.head.cwd, input.cwd, platform === "win32");
  const query = input.query?.trim().toLowerCase();
  // The folder is already in memory — free to test. Only fall through to the
  // title, a real file read for Claude, when the folder didn't already match.
  const matchesQuery = (candidate: SessionCandidate) =>
    !query ||
    (candidate.head.cwd ?? "").toLowerCase().includes(query) ||
    (cachedTitleFor(candidate) ?? "").toLowerCase().includes(query);

  // Each facet offers the values that still have sessions under the *other*
  // filters, so picking a provider never leaves an unreachable folder listed.
  const under = (...predicates: Array<(candidate: SessionCandidate) => boolean>) =>
    candidates.filter((candidate) => predicates.every((predicate) => predicate(candidate)));
  const facets: ImportScanFacets = {
    providers: sortedUnique(
      under(matchesAccount, matchesCwd).map((candidate) => candidate.file.home.provider),
    ) as ImportedSessionProvider[],
    accounts: sortedUnique(
      under(matchesProvider, matchesCwd).map((candidate) => candidate.agentKind),
    ),
    folders: sortedUnique(
      under(matchesProvider, matchesAccount)
        .map((candidate) => candidate.head.cwd)
        .filter((cwd): cwd is string => cwd !== undefined),
    ),
  };

  const limit = input.limit ?? DEFAULT_LIMIT;
  const survivors = under(matchesProvider, matchesAccount, matchesCwd, matchesQuery);
  const truncated = survivors.length > limit;
  const sessions: ImportableSession[] = [];
  for (const candidate of survivors.slice(0, limit)) {
    const { file, head } = candidate;
    const preview = readPreview(file);
    const title = cachedTitleFor(candidate);
    sessions.push({
      id: candidate.id,
      provider: file.home.provider,
      agentKind: candidate.agentKind,
      providerSessionId: head.providerSessionId,
      path: file.path,
      ...(head.cwd ? { cwd: head.cwd } : {}),
      ...(head.startedAt ? { startedAt: head.startedAt } : {}),
      updatedAt: new Date(file.mtimeMs).toISOString(),
      preview,
      ...(title ? { title } : {}),
      ...(head.model ? { model: head.model } : {}),
      cwdExists: head.cwd !== undefined && cachedExists(head.cwd),
    });
  }
  return { sessions, facets, truncated };
}
