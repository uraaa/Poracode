import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { resolveBetterSqliteNativeBindingOptions } from "../db/connection";
import { stripInjectedContext } from "./transcript";

/**
 * Titles the provider's own UI shows for a session. Both providers name a
 * conversation after the fact — Claude Desktop appends `custom-title` records
 * to the transcript, Codex Desktop keeps a `name` / `title` in its state
 * database — so the first prompt is only a fallback, not what the user
 * recognises the chat by.
 */

/** Claude re-appends the title as it changes; the newest sits near the end. */
const CLAUDE_TITLE_TAIL_BYTES = 128 * 1024;
/** A title is a list line; anything longer is a pasted prompt, not a name. */
const TITLE_MAX_CHARS = 200;

/**
 * A generated Codex title can be the first prompt verbatim, injected context
 * and all; a user-typed one can carry stray whitespace. One line either way.
 */
function cleanTitle(raw: string): string | undefined {
  const text = stripInjectedContext(raw).replace(/\s+/gu, " ").trim();
  if (text.length === 0) return undefined;
  return text.length > TITLE_MAX_CHARS ? `${text.slice(0, TITLE_MAX_CHARS)}…` : text;
}

/**
 * Last `maxBytes` of a file, trimmed forward to the first complete line so
 * every remaining line can be parsed on its own.
 */
function readSuffix(path: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    if (length === 0) return "";
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    if (length >= size) return text;
    const firstNewline = text.indexOf("\n");
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
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

/** The title Claude Desktop last gave this transcript, when it gave one. */
export function readClaudeTitle(path: string): string | undefined {
  const tail = readSuffix(path, CLAUDE_TITLE_TAIL_BYTES);
  if (!tail.includes('"custom-title"')) return undefined;
  const lines = tail.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.includes('"custom-title"')) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry["type"] !== "custom-title") continue;
      const title = entry["customTitle"];
      if (typeof title === "string") {
        const cleaned = cleanTitle(title);
        if (cleaned) return cleaned;
      }
    } catch {
      // A cut or corrupt line; keep looking at older records.
    }
  }
  return undefined;
}

/**
 * Codex Desktop's thread index (`state_<n>.sqlite`) keyed by thread id. `name`
 * is what the user typed, `title` what Codex generated; both beat the first
 * prompt. Read-only, and any failure — Codex mid-migration, a locked WAL, an
 * older schema — just means no titles.
 */
export function readCodexTitles(homeDir: string): Map<string, string> {
  const titles = new Map<string, string>();
  let database: InstanceType<typeof Database> | undefined;
  try {
    const stateFile = readdirSync(homeDir)
      .filter((name) => /^state_\d+\.sqlite$/u.test(name))
      .sort((left, right) => Number(left.slice(6, -7)) - Number(right.slice(6, -7)))
      .at(-1);
    if (!stateFile) return titles;
    database = new Database(join(homeDir, stateFile), {
      ...resolveBetterSqliteNativeBindingOptions(),
      readonly: true,
      fileMustExist: true,
    });
    const rows = database.prepare("SELECT id, name, title FROM threads").all() as Array<{
      id: string;
      name: string | null;
      title: string | null;
    }>;
    for (const row of rows) {
      const title = cleanTitle(row.name ?? "") ?? cleanTitle(row.title ?? "");
      if (title) titles.set(row.id, title);
    }
  } catch {
    // No index, or one this build cannot read: the first prompt stands in.
  } finally {
    database?.close();
  }
  return titles;
}
