import type Database from "better-sqlite3";
import {
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
  type ThreadMessageSearchHit,
} from "@/shared/contracts";
import { getSqlite } from "./connection";
import { buildPhraseQuery } from "./messageSearchQuery";
import { extractMessageText } from "./messageText";

type SqliteDatabase = InstanceType<typeof Database>;

interface IndexableRow {
  type: string;
  state: string;
  position: number;
  payload: string | null;
  streams: string | null;
}

/**
 * A user message carries its whole text the moment it appears and may never
 * be completed separately; an assistant message fills in through deltas, so
 * indexing before completion would rewrite the same row on every flush.
 */
function isReadyToIndex(row: IndexableRow): boolean {
  if (row.type === "user_message") return true;
  return row.type === "assistant_message" && row.state === "completed";
}

export function indexThreadMessages(
  sqlite: SqliteDatabase,
  threadId: string,
  itemIds: readonly string[],
): void {
  if (itemIds.length === 0) return;
  const read = sqlite.prepare(
    `SELECT type, state, position, payload, streams
     FROM thread_runtime_items WHERE thread_id = ? AND item_id = ?`,
  );
  const upsert = sqlite.prepare(
    `INSERT INTO thread_message_text (thread_id, item_id, position, role, text)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (thread_id, item_id)
     DO UPDATE SET position = excluded.position, role = excluded.role, text = excluded.text`,
  );
  for (const itemId of new Set(itemIds)) {
    const row = read.get(threadId, itemId) as IndexableRow | undefined;
    if (!row || !isReadyToIndex(row)) continue;
    const extracted = extractMessageText({
      type: row.type,
      payload: row.payload ? (JSON.parse(row.payload) as unknown) : undefined,
      streams: row.streams ? (JSON.parse(row.streams) as Record<string, string>) : {},
    });
    if (!extracted) continue;
    upsert.run(threadId, itemId, row.position, extracted.role, extracted.text);
  }
}

export function removeThreadMessages(
  sqlite: SqliteDatabase,
  threadId: string,
  itemIds: readonly string[],
): void {
  if (itemIds.length === 0) return;
  const remove = sqlite.prepare(
    "DELETE FROM thread_message_text WHERE thread_id = ? AND item_id = ?",
  );
  for (const itemId of new Set(itemIds)) remove.run(threadId, itemId);
}

export function clearThreadMessages(sqlite: SqliteDatabase, threadId: string): void {
  sqlite.prepare("DELETE FROM thread_message_text WHERE thread_id = ?").run(threadId);
}

export function removeThreadMessagesAfter(
  sqlite: SqliteDatabase,
  threadId: string,
  position: number,
): void {
  sqlite
    .prepare("DELETE FROM thread_message_text WHERE thread_id = ? AND position > ?")
    .run(threadId, position);
}

const SNIPPET_TOKENS = 12;

interface SearchRow {
  thread_id: string;
  title: string;
  project_id: string;
  updated_at: string;
  item_id: string;
  position: number;
  role: string;
  snippet: string;
}

export function dbSearchThreadMessages(query: string, limit: number): ThreadMessageSearchHit[] {
  const match = buildPhraseQuery(query);
  if (!match) return [];
  const rows = getSqlite()
    .prepare(
      `SELECT th.id AS thread_id, th.title, th.project_id, th.updated_at,
              m.item_id, m.position, m.role,
              snippet(thread_message_fts, 0, ?, ?, '…', ${SNIPPET_TOKENS}) AS snippet,
              bm25(thread_message_fts) AS rank
       FROM thread_message_fts
       JOIN thread_message_text m ON m.rowid = thread_message_fts.rowid
       JOIN threads th            ON th.id = m.thread_id
       WHERE thread_message_fts MATCH ?
         AND th.archived = 0
       ORDER BY rank, th.updated_at DESC
       LIMIT ?`,
    )
    .all(SNIPPET_MARK_START, SNIPPET_MARK_END, match, limit) as SearchRow[];
  return rows.map((row) => ({
    threadId: row.thread_id,
    threadTitle: row.title,
    projectId: row.project_id,
    itemId: row.item_id,
    position: row.position,
    role: row.role === "assistant" ? "assistant" : "user",
    snippet: row.snippet,
    updatedAt: row.updated_at,
  }));
}
