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
 * Keyed by file path + `mtimeMs` so a rewritten transcript (new mtime) is a
 * new key and is read again, rather than serving whatever the old bytes said
 * for the life of the main process.
 */
function memoKey(path: string, mtimeMs: number): string {
  return `${path}:${mtimeMs}`;
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
  /** Claude: account the conversation belongs to (`ownerAccountUuid`). */
  readonly accountId?: string;
}

interface RawHeadFields {
  readonly id?: string | undefined;
  readonly cwd?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly originator?: string | undefined;
  readonly source?: string | undefined;
  readonly threadSource?: string | undefined;
  readonly accountId?: string | undefined;
}

/**
 * Codex's `session_meta` is always the first line of a rollout and is the
 * only record carrying `session_id` / `cwd` / `timestamp` / `originator` /
 * `source` / `thread_source`. Scanning only that line — rather than the whole
 * head chunk — means nothing a user typed in a later message (which can
 * itself look like JSON) can be mistaken for one of these fields.
 */
function codexHeadFields(prefix: string): RawHeadFields {
  const metaLine = prefix.split(/\r?\n/u)[0] ?? "";
  return {
    id: rawField(metaLine, "session_id"),
    cwd: rawField(metaLine, "cwd"),
    startedAt: rawField(metaLine, "timestamp"),
    originator: rawField(metaLine, "originator"),
    source: rawField(metaLine, "source"),
    threadSource: rawField(metaLine, "thread_source"),
  };
}

/** Claude record types that legitimately carry the session's own metadata. */
const CLAUDE_HEAD_RECORD_TYPES = new Set(["user", "assistant", "bridge-session", "summary"]);

/**
 * Claude has no single meta line — `sessionId` / `cwd` / `timestamp` /
 * `ownerAccountUuid` are spread across ordinary conversation records. Scan
 * line by line, skipping any record whose `type` isn't one of the ones that
 * legitimately carries them (a `user` record's own message text can't fool
 * this: it's read from the same line, but only after that line's `type` is
 * confirmed to be one of the safe kinds), and stop once both `cwd` and the
 * timestamp are known.
 */
function claudeHeadFields(prefix: string): RawHeadFields {
  let id: string | undefined;
  let cwd: string | undefined;
  let startedAt: string | undefined;
  let accountId: string | undefined;
  for (const line of prefix.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const type = rawField(line, "type");
    if (!type || !CLAUDE_HEAD_RECORD_TYPES.has(type)) continue;
    id ??= rawField(line, "sessionId");
    cwd ??= rawField(line, "cwd");
    startedAt ??= rawField(line, "timestamp");
    accountId ??= rawField(line, "ownerAccountUuid");
    if (cwd !== undefined && startedAt !== undefined) break;
  }
  return { id, cwd, startedAt, accountId };
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
    fields.accountId !== undefined;
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
  };
}

/**
 * The candidate pass's one read per transcript — the single biggest cost of a
 * scan at a few hundred files, and repaid in full on every debounced
 * keystroke before this memo existed.
 */
function readHead(file: DiscoveredFile): SessionHead | undefined {
  const key = memoKey(file.path, file.mtimeMs);
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
  const key = memoKey(file.path, file.mtimeMs);
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
    const key = memoKey(candidate.file.path, candidate.file.mtimeMs);
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
      cwdExists: head.cwd !== undefined && cachedExists(head.cwd),
    });
  }
  return { sessions, facets, truncated };
}
