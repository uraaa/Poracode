# Full-text search over thread messages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find a thread by a phrase someone typed inside it, from the search overlay the sidebar button and Ctrl+G already open.

**Architecture:** Message text is extracted out of the JSON columns of `thread_runtime_items` into a shadow table `thread_message_text`, indexed by an FTS5 external-content table `thread_message_fts`. The shadow table is written when a message item is touched by the runtime event pipeline — user messages as soon as they appear, assistant messages only once completed, so streaming deltas never rewrite the index. The search overlay gains a second section fed by a new IPC procedure.

**Tech Stack:** TypeScript, Electron (main/renderer split), better-sqlite3 13 with SQLite 3.53 and FTS5, zod for IPC schemas, React + zustand, Lingui for strings, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-21-thread-message-search-design.md`

## Global Constraints

- SQLite `LIKE` and `lower()` fold case for ASCII only. Never use them for matching user text. All matching goes through FTS5 with `tokenize='unicode61'`.
- User input never reaches `MATCH` by interpolation. It is passed as a bound parameter, built by `buildPhraseQuery`.
- Indexed item types: `user_message` and `assistant_message`. Nothing else.
- Search results exclude threads where `threads.archived = 1`.
- The next free migration version is **43**; `LATEST_SCHEMA_VERSION` is derived from the last entry, do not edit it by hand.
- Migration entries are append-only: never renumber or edit a released one.
- Every user-visible string uses Lingui macros (`t`, `Trans`), like the rest of `ThreadSearchOverlay`.
- Verification commands: `pnpm test`, `pnpm lint`, `pnpm typecheck`. A task is done when all three pass.
- Commit messages follow Conventional Commits, as the repo already does.

## File Structure

| File                                                                               | Responsibility                                              |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `src/main/db/messageText.ts` (create)                                              | Pure extraction of plain text from a persisted runtime item |
| `src/main/db/messageText.test.ts` (create)                                         | Tests for the above                                         |
| `src/main/db/messageSearchQuery.ts` (create)                                       | Pure translation of user input into an FTS5 phrase query    |
| `src/main/db/messageSearchQuery.test.ts` (create)                                  | Tests for the above                                         |
| `src/main/db/messageSearchStore.ts` (create)                                       | Read and write access to the shadow table and the index     |
| `src/main/db/messageSearchStore.test.ts` (create)                                  | Tests against a temporary database                          |
| `src/main/db/migrations.ts` (modify)                                               | Migration 43: tables, triggers, backfill                    |
| `src/main/db/migrations.test.ts` (modify)                                          | Backfill test                                               |
| `src/main/db/runtimeItems.ts` (modify)                                             | Call the index writers from the existing write paths        |
| `src/main/db/runtimeItems.test.ts` (modify)                                        | Index-stays-in-step tests                                   |
| `src/shared/contracts/messageSearch.ts` (create)                                   | Payload and hit schemas                                     |
| `src/shared/ipc/procedures/messageSearch.ts` (create)                              | Procedure definition                                        |
| `src/shared/ipc/procedureMap.ts` (modify)                                          | Register the procedure                                      |
| `src/main/ipc/localHandlers.ts` (modify)                                           | Handler wiring                                              |
| `src/renderer/views/ThreadSearchOverlay/parts/useMessageSearch.ts` (create)        | Debounced query hook, stale-response handling               |
| `src/renderer/views/ThreadSearchOverlay/parts/MessageSearchResultRow.tsx` (create) | One message hit, snippet with highlight                     |
| `src/renderer/views/ThreadSearchOverlay/ThreadSearchOverlay.tsx` (modify)          | Second section, one keyboard selection across both          |

---

### Task 1: Extract message text from a persisted item

**Files:**

- Create: `src/main/db/messageText.ts`
- Test: `src/main/db/messageText.test.ts`

**Interfaces:**

- Consumes: `PersistedRuntimeItem` from `src/main/db/runtimeItems.ts` (`{ id, type, state, payload?, streams }`).
- Produces: `extractMessageText(item: Pick<PersistedRuntimeItem, "type" | "payload" | "streams">): { role: "user" | "assistant"; text: string } | null`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/db/messageText.test.ts
import { describe, expect, it } from "vitest";
import { extractMessageText } from "./messageText";

describe("extractMessageText", () => {
  it("reads the text blocks of a user message", () => {
    expect(
      extractMessageText({
        type: "user_message",
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
        streams: { assistant_text: "Готово.", reasoning_text: "ignored" },
      }),
    ).toEqual({ role: "assistant", text: "Готово." });
  });

  it("returns null for a type that is not indexed", () => {
    expect(
      extractMessageText({ type: "command_execution", payload: { command: "ls" }, streams: {} }),
    ).toBeNull();
  });

  it("returns null when a message carries no text", () => {
    expect(extractMessageText({ type: "assistant_message", streams: {} })).toBeNull();
    expect(
      extractMessageText({ type: "user_message", payload: { content: [] }, streams: {} }),
    ).toBeNull();
    expect(
      extractMessageText({ type: "user_message", payload: undefined, streams: {} }),
    ).toBeNull();
  });

  it("survives a payload that is not the expected shape", () => {
    expect(
      extractMessageText({ type: "user_message", payload: "nonsense", streams: {} }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/main/db/messageText.test.ts`
Expected: FAIL — cannot resolve `./messageText`.

- [ ] **Step 3: Write the implementation**

```ts
// src/main/db/messageText.ts
import type { PersistedRuntimeItem } from "./runtimeItems";

export interface ExtractedMessage {
  role: "user" | "assistant";
  text: string;
}

type ItemForExtraction = Pick<PersistedRuntimeItem, "type" | "streams"> & { payload?: unknown };

function userText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const { kind, text } = block as { kind?: unknown; text?: unknown };
    if (kind === "text" && typeof text === "string" && text.length > 0) parts.push(text);
  }
  return parts.join("\n");
}

/**
 * Plain text of a message item, or null when there is nothing to index —
 * either the type is not a message, or the message carries no text. Keeping
 * both cases as null lets every caller skip on a single check.
 */
export function extractMessageText(item: ItemForExtraction): ExtractedMessage | null {
  if (item.type === "user_message") {
    const text = userText(item.payload);
    return text.length > 0 ? { role: "user", text } : null;
  }
  if (item.type === "assistant_message") {
    const text = item.streams?.assistant_text ?? "";
    return text.length > 0 ? { role: "assistant", text } : null;
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/main/db/messageText.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/db/messageText.ts src/main/db/messageText.test.ts
git commit -m "feat(search): extract plain text from message items"
```

---

### Task 2: Build an FTS5 phrase query from user input

**Files:**

- Create: `src/main/db/messageSearchQuery.ts`
- Test: `src/main/db/messageSearchQuery.test.ts`

**Interfaces:**

- Produces: `MIN_SEARCH_QUERY_CHARS = 2` and `buildPhraseQuery(input: string): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/db/messageSearchQuery.test.ts
import { describe, expect, it } from "vitest";
import { buildPhraseQuery, MIN_SEARCH_QUERY_CHARS } from "./messageSearchQuery";

describe("buildPhraseQuery", () => {
  it("wraps the input in one quoted phrase", () => {
    expect(buildPhraseQuery("импорт сессий")).toBe('"импорт сессий"');
  });

  it("trims and collapses surrounding whitespace", () => {
    expect(buildPhraseQuery("  импорт  ")).toBe('"импорт"');
  });

  it("rejects input shorter than the minimum", () => {
    expect(MIN_SEARCH_QUERY_CHARS).toBe(2);
    expect(buildPhraseQuery("")).toBeNull();
    expect(buildPhraseQuery("   ")).toBeNull();
    expect(buildPhraseQuery("и")).toBeNull();
  });

  it("escapes embedded quotes by doubling them", () => {
    expect(buildPhraseQuery('он сказал "нет"')).toBe('"он сказал ""нет"""');
  });

  it("neutralises FTS5 operators so they match literally", () => {
    expect(buildPhraseQuery("NEAR(a b)")).toBe('"NEAR(a b)"');
    expect(buildPhraseQuery("foo* -bar AND baz:qux")).toBe('"foo* -bar AND baz:qux"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/main/db/messageSearchQuery.test.ts`
Expected: FAIL — cannot resolve `./messageSearchQuery`.

- [ ] **Step 3: Write the implementation**

```ts
// src/main/db/messageSearchQuery.ts

/** Below this, a query matches so much that the result list is noise. */
export const MIN_SEARCH_QUERY_CHARS = 2;

/**
 * An FTS5 phrase query for what the user typed, or null when there is not
 * enough to search for. Everything is quoted: inside a phrase FTS5 treats
 * `*`, `-`, `:`, `AND` and `NEAR` as ordinary text, so a stray operator
 * character cannot turn into a syntax error or a different query.
 */
export function buildPhraseQuery(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length < MIN_SEARCH_QUERY_CHARS) return null;
  return `"${trimmed.replaceAll('"', '""')}"`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/main/db/messageSearchQuery.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/db/messageSearchQuery.ts src/main/db/messageSearchQuery.test.ts
git commit -m "feat(search): build FTS5 phrase queries from user input"
```

---

### Task 3: Migration 43 — index tables, triggers, backfill

**Files:**

- Modify: `src/main/db/migrations.ts` (append a migration entry after `version: 42`; add the helper above `DATABASE_MIGRATIONS`)
- Test: `src/main/db/migrations.test.ts`

**Interfaces:**

- Consumes: `extractMessageText` (Task 1).
- Produces: tables `thread_message_text` and `thread_message_fts`, triggers `thread_message_text_ai` / `_ad` / `_au`, and the exported helper `createMessageSearchSchema(sqlite)` used by both the migration and `connection.ts` bootstrap.

- [ ] **Step 1: Write the failing test**

Add to `src/main/db/migrations.test.ts`, following the file's existing `new Database(":memory:")` style:

```ts
it("backfills message text for threads that already exist", () => {
  const sqlite = new Database(":memory:");
  try {
    applyMigrationsUpTo(sqlite, 42);
    sqlite.exec(`
      INSERT INTO projects (id, name, location, created_at)
        VALUES ('p1', 'P', '{"kind":"posix","path":"/tmp/p"}', '2026-01-01T00:00:00.000Z');
      INSERT INTO threads (id, project_id, title, agent_kind, config, status, attention,
                           archived, created_at, updated_at)
        VALUES ('t1', 'p1', 'T', 'codex', '{}', 'idle', 'none', 0,
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO thread_runtime_items (thread_id, item_id, position, type, state, payload, streams)
        VALUES ('t1', 'i1', 0, 'user_message', 'completed',
                '{"content":[{"kind":"text","text":"Импорт сессий"}]}', '{}'),
               ('t1', 'i2', 1, 'assistant_message', 'completed', NULL,
                '{"assistant_text":"Готово"}'),
               ('t1', 'i3', 2, 'command_execution', 'completed', '{"command":"ls"}', '{}');
    `);

    applyMigrationsUpTo(sqlite, 43);

    const rows = sqlite
      .prepare("SELECT item_id, role, text FROM thread_message_text ORDER BY position")
      .all();
    expect(rows).toEqual([
      { item_id: "i1", role: "user", text: "Импорт сессий" },
      { item_id: "i2", role: "assistant", text: "Готово" },
    ]);

    const hit = sqlite
      .prepare(
        `SELECT m.item_id FROM thread_message_fts f
         JOIN thread_message_text m ON m.rowid = f.rowid
         WHERE thread_message_fts MATCH ?`,
      )
      .all('"импорт"');
    expect(hit).toEqual([{ item_id: "i1" }]);
  } finally {
    sqlite.close();
  }
});
```

If `migrations.test.ts` has no `applyMigrationsUpTo` helper yet, add it at the top of the file:

```ts
function applyMigrationsUpTo(sqlite: Database.Database, version: number): void {
  for (const migration of DATABASE_MIGRATIONS) {
    if (migration.version <= version) migration.migrate(sqlite);
  }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/main/db/migrations.test.ts`
Expected: FAIL — `no such table: thread_message_text`.

- [ ] **Step 3: Write the implementation**

In `src/main/db/migrations.ts`, above `DATABASE_MIGRATIONS`:

```ts
/**
 * Message text is extracted out of the JSON columns because neither `payload`
 * nor `streams` can be indexed as-is. The FTS table is external content over
 * the extracted rows, so the text is stored once and the triggers below keep
 * the index in step.
 */
export function createMessageSearchSchema(sqlite: SqliteDatabase): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS thread_message_text (
      rowid     INTEGER PRIMARY KEY,
      thread_id TEXT    NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      item_id   TEXT    NOT NULL,
      position  INTEGER NOT NULL,
      role      TEXT    NOT NULL,
      text      TEXT    NOT NULL,
      UNIQUE (thread_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_thread_message_text_thread
      ON thread_message_text (thread_id, position);

    CREATE VIRTUAL TABLE IF NOT EXISTS thread_message_fts USING fts5(
      text,
      content='thread_message_text',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS thread_message_text_ai
    AFTER INSERT ON thread_message_text BEGIN
      INSERT INTO thread_message_fts (rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS thread_message_text_ad
    AFTER DELETE ON thread_message_text BEGIN
      INSERT INTO thread_message_fts (thread_message_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS thread_message_text_au
    AFTER UPDATE ON thread_message_text BEGIN
      INSERT INTO thread_message_fts (thread_message_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
      INSERT INTO thread_message_fts (rowid, text) VALUES (new.rowid, new.text);
    END;
  `);
}

const BACKFILL_BATCH = 500;

function backfillMessageSearchIndex(sqlite: SqliteDatabase): void {
  createMessageSearchSchema(sqlite);
  const insert = sqlite.prepare(
    `INSERT OR REPLACE INTO thread_message_text (thread_id, item_id, position, role, text)
     VALUES (?, ?, ?, ?, ?)`,
  );
  // `rowid` paging keeps memory flat on a database with a long history.
  const page = sqlite.prepare(
    `SELECT rowid AS row_id, thread_id, item_id, position, type, payload, streams
     FROM thread_runtime_items
     WHERE type IN ('user_message', 'assistant_message') AND rowid > ?
     ORDER BY rowid
     LIMIT ${BACKFILL_BATCH}`,
  );
  let cursor = 0;
  for (;;) {
    const rows = page.all(cursor) as Array<{
      row_id: number;
      thread_id: string;
      item_id: string;
      position: number;
      type: string;
      payload: string | null;
      streams: string | null;
    }>;
    if (rows.length === 0) break;
    sqlite.transaction(() => {
      for (const row of rows) {
        const extracted = extractMessageText({
          type: row.type,
          payload: row.payload ? (JSON.parse(row.payload) as unknown) : undefined,
          streams: row.streams ? (JSON.parse(row.streams) as Record<string, string>) : {},
        });
        if (!extracted) continue;
        insert.run(row.thread_id, row.item_id, row.position, extracted.role, extracted.text);
      }
    })();
    cursor = rows[rows.length - 1]!.row_id;
  }
}
```

Append the migration entry after `version: 42`:

```ts
  {
    version: 43,
    name: "message search index",
    migrate: backfillMessageSearchIndex,
  },
```

Import `extractMessageText` at the top of the file:

```ts
import { extractMessageText } from "./messageText";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/main/db/migrations.test.ts`
Expected: PASS, including the existing registry-validation tests.

- [ ] **Step 5: Verify a fresh database also gets the schema**

`src/main/db/connection.ts` creates the base schema for a new profile before migrations run. Confirm a brand-new database ends up with the tables — the migration runs on a fresh database too, so no change should be needed:

```bash
pnpm exec vitest run src/main/db
```

Expected: PASS. If any test reports `no such table: thread_message_fts` on a fresh database, call `createMessageSearchSchema(sqlite)` from the bootstrap in `connection.ts` next to the other `CREATE TABLE` statements.

- [ ] **Step 6: Commit**

```bash
git add src/main/db/migrations.ts src/main/db/migrations.test.ts
git commit -m "feat(search): add the message search schema and backfill it"
```

---

### Task 4: Keep the index current from the runtime write paths

**Files:**

- Create: `src/main/db/messageSearchStore.ts`
- Modify: `src/main/db/runtimeItems.ts`
- Test: `src/main/db/runtimeItems.test.ts`

**Interfaces:**

- Consumes: `extractMessageText` (Task 1); the schema from Task 3.
- Produces:
  - `indexThreadMessages(sqlite: SqliteDatabase, threadId: string, itemIds: readonly string[]): void`
  - `removeThreadMessages(sqlite: SqliteDatabase, threadId: string, itemIds: readonly string[]): void`
  - `clearThreadMessages(sqlite: SqliteDatabase, threadId: string): void`
  - `removeThreadMessagesAfter(sqlite: SqliteDatabase, threadId: string, position: number): void`

**Rule the implementation must follow:** a `user_message` is indexed as soon as it is touched (its text arrives complete with the item and it may never receive a separate completion), an `assistant_message` only when its row state is `completed` (its text arrives as deltas, and indexing earlier would rewrite the row on every flush).

- [ ] **Step 1: Write the failing test**

Add to `src/main/db/runtimeItems.test.ts`, inside the existing `describe.skipIf(!sqliteAvailable)` block:

```ts
function indexedRows(threadId: string) {
  return getSqlite()
    .prepare(
      "SELECT item_id, role, text FROM thread_message_text WHERE thread_id = ? ORDER BY position",
    )
    .all(threadId);
}

it("indexes a user message as soon as it arrives", () => {
  dbApplyThreadRuntimeEvents("thread-1", [
    {
      type: "item.started",
      threadId: "thread-1",
      itemId: "u1",
      itemType: "user_message",
      payload: { content: [{ kind: "text", text: "Импорт сессий" }] },
    },
  ]);
  dbFlushThreadRuntimeWrites("thread-1");
  expect(indexedRows("thread-1")).toEqual([{ item_id: "u1", role: "user", text: "Импорт сессий" }]);
});

it("indexes an assistant message only once it completes", () => {
  dbApplyThreadRuntimeEvents("thread-1", [
    { type: "item.started", threadId: "thread-1", itemId: "a1", itemType: "assistant_message" },
    {
      type: "content.delta",
      threadId: "thread-1",
      itemId: "a1",
      stream: "assistant_text",
      delta: "Готово",
    },
  ]);
  dbFlushThreadRuntimeWrites("thread-1");
  expect(indexedRows("thread-1")).toEqual([]);

  dbApplyThreadRuntimeEvents("thread-1", [
    { type: "item.completed", threadId: "thread-1", itemId: "a1" },
  ]);
  dbFlushThreadRuntimeWrites("thread-1");
  expect(indexedRows("thread-1")).toEqual([{ item_id: "a1", role: "assistant", text: "Готово" }]);
});

it("does not index command output", () => {
  dbApplyThreadRuntimeEvents("thread-1", [
    {
      type: "item.started",
      threadId: "thread-1",
      itemId: "c1",
      itemType: "command_execution",
      payload: { command: "ls" },
    },
    { type: "item.completed", threadId: "thread-1", itemId: "c1" },
  ]);
  dbFlushThreadRuntimeWrites("thread-1");
  expect(indexedRows("thread-1")).toEqual([]);
});

it("drops indexed rows when the thread is deleted", () => {
  dbApplyThreadRuntimeEvents("thread-1", [
    {
      type: "item.started",
      threadId: "thread-1",
      itemId: "u1",
      itemType: "user_message",
      payload: { content: [{ kind: "text", text: "Импорт" }] },
    },
  ]);
  dbFlushThreadRuntimeWrites("thread-1");
  dbDeleteThread("thread-1");
  expect(indexedRows("thread-1")).toEqual([]);
  expect(getSqlite().prepare("SELECT COUNT(*) AS c FROM thread_message_fts").get()).toEqual({
    c: 0,
  });
});

it("re-indexes a thread when its items are replaced", () => {
  dbReplaceThreadRuntimeItems("thread-1", [
    {
      id: "u1",
      type: "user_message",
      state: "completed",
      payload: { content: [{ kind: "text", text: "Старый текст" }] },
      streams: {},
    },
  ]);
  expect(indexedRows("thread-1")).toEqual([{ item_id: "u1", role: "user", text: "Старый текст" }]);

  dbReplaceThreadRuntimeItems("thread-1", [
    {
      id: "u2",
      type: "user_message",
      state: "completed",
      payload: { content: [{ kind: "text", text: "Новый текст" }] },
      streams: {},
    },
  ]);
  expect(indexedRows("thread-1")).toEqual([{ item_id: "u2", role: "user", text: "Новый текст" }]);
});
```

Add `dbDeleteThread` to the existing import from `./projectsThreads` if it is not already there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/main/db/runtimeItems.test.ts`
Expected: FAIL — `no such table: thread_message_text` or empty result arrays.

- [ ] **Step 3: Write the store**

```ts
// src/main/db/messageSearchStore.ts
import type Database from "better-sqlite3";
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
```

- [ ] **Step 4: Wire the store into `runtimeItems.ts`**

In `applyThreadRuntimeEventsNow`, collect the items each event touches and index them once, at the end of the same transaction — one pass instead of a write per event:

```ts
const touched = new Set<string>();
const removed = new Set<string>();
```

- `item.started`, `item.updated`, `item.completed`, `content.delta`: `touched.add(event.itemId)`.
- the `deleteItem.run(...)` branch inside `item.completed`: `removed.add(event.itemId)` and `touched.delete(event.itemId)`.

After the event loop, still inside the transaction:

```ts
removeThreadMessages(sqlite, threadId, [...removed]);
indexThreadMessages(sqlite, threadId, [...touched]);
```

In `replaceThreadRuntimeItemsInSqlite` (used by `dbReplaceThreadRuntimeItems`), after the rows are rewritten:

```ts
clearThreadMessages(sqlite, threadId);
indexThreadMessages(
  sqlite,
  threadId,
  items.map((item) => item.id),
);
```

In `dbClearThreadRuntimeItems`, next to the existing delete:

```ts
clearThreadMessages(getSqlite(), threadId);
```

In `dbTruncateThreadRuntimeAfter`, after the existing `DELETE ... WHERE position > ?`, using the same position value:

```ts
removeThreadMessagesAfter(sqlite, threadId, position);
```

Import at the top of `runtimeItems.ts`:

```ts
import {
  clearThreadMessages,
  indexThreadMessages,
  removeThreadMessages,
  removeThreadMessagesAfter,
} from "./messageSearchStore";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/main/db`
Expected: PASS, including the five new cases.

- [ ] **Step 6: Commit**

```bash
git add src/main/db/messageSearchStore.ts src/main/db/runtimeItems.ts src/main/db/runtimeItems.test.ts
git commit -m "feat(search): index message text as runtime items are written"
```

---

### Task 5: Query the index

**Files:**

- Modify: `src/main/db/messageSearchStore.ts`
- Test: `src/main/db/messageSearchStore.test.ts` (create)

**Interfaces:**

- Consumes: `buildPhraseQuery` (Task 2), the schema (Task 3), the writers (Task 4).
- Produces:

```ts
export interface ThreadMessageSearchHit {
  threadId: string;
  threadTitle: string;
  projectId: string;
  itemId: string;
  position: number;
  role: "user" | "assistant";
  snippet: string;
  updatedAt: string;
}
export function dbSearchThreadMessages(query: string, limit: number): ThreadMessageSearchHit[];
export const SNIPPET_MARK_START = "\u0001";
export const SNIPPET_MARK_END = "\u0002";
```

- [ ] **Step 1: Write the failing test**

```ts
// src/main/db/messageSearchStore.test.ts
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Thread } from "@/shared/contracts";
import { closeDatabase, initDatabase } from "./connection";
import { dbUpsertProject, dbUpsertThread } from "./projectsThreads";
import { dbReplaceThreadRuntimeItems } from "./runtimeItems";
import { dbSearchThreadMessages, SNIPPET_MARK_END, SNIPPET_MARK_START } from "./messageSearchStore";

const serverNativeBinding = join(process.cwd(), "dist", "server-native", "better_sqlite3.node");
let nativeBindingEnv: string | undefined;
let sqliteAvailable = true;
try {
  new Database(":memory:").close();
} catch {
  if (existsSync(serverNativeBinding)) nativeBindingEnv = serverNativeBinding;
  else sqliteAvailable = false;
}

function thread(id: string, title: string, archived = false): Thread {
  return {
    id,
    projectId: "project-1",
    title,
    agentKind: "codex",
    config: { model: "gpt-5" },
    status: "idle",
    attention: "none",
    canResumeWithConfig: false,
    archived,
    done: false,
    starred: false,
    presentationMode: "gui",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function userItem(id: string, text: string) {
  return {
    id,
    type: "user_message",
    state: "completed" as const,
    payload: { content: [{ kind: "text", text }] },
    streams: {},
  };
}

describe.skipIf(!sqliteAvailable)("dbSearchThreadMessages", () => {
  let dir: string;

  beforeEach(() => {
    if (nativeBindingEnv) process.env.PORACODE_BETTER_SQLITE3_NATIVE_BINDING = nativeBindingEnv;
    dir = mkdtempSync(join(tmpdir(), "poracode-search-db-test-"));
    initDatabase(join(dir, "state.sqlite"));
    dbUpsertProject(
      {
        id: "project-1",
        name: "Test project",
        location: { kind: "posix", path: "/tmp/project" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      0,
    );
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PORACODE_BETTER_SQLITE3_NATIVE_BINDING;
  });

  it("matches a lowercase Cyrillic query against capitalised text", () => {
    dbUpsertThread(thread("t1", "Первый"), 0);
    dbReplaceThreadRuntimeItems("t1", [userItem("i1", "Импорт Сессий работает")]);

    const hits = dbSearchThreadMessages("импорт", 50);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      threadId: "t1",
      threadTitle: "Первый",
      itemId: "i1",
      role: "user",
    });
  });

  it("marks the match inside the snippet", () => {
    dbUpsertThread(thread("t1", "Первый"), 0);
    dbReplaceThreadRuntimeItems("t1", [userItem("i1", "Импорт сессий работает")]);

    const [hit] = dbSearchThreadMessages("сессий", 50);
    expect(hit!.snippet).toContain(`${SNIPPET_MARK_START}сессий${SNIPPET_MARK_END}`);
  });

  it("requires the words to be adjacent and in order", () => {
    dbUpsertThread(thread("t1", "Первый"), 0);
    dbReplaceThreadRuntimeItems("t1", [userItem("i1", "импорт сессий работает")]);

    expect(dbSearchThreadMessages("импорт сессий", 50)).toHaveLength(1);
    expect(dbSearchThreadMessages("сессий импорт", 50)).toHaveLength(0);
  });

  it("skips archived threads", () => {
    dbUpsertThread(thread("t1", "Архив", true), 0);
    dbReplaceThreadRuntimeItems("t1", [userItem("i1", "импорт сессий")]);

    expect(dbSearchThreadMessages("импорт", 50)).toHaveLength(0);
  });

  it("returns nothing for a query below the minimum length", () => {
    dbUpsertThread(thread("t1", "Первый"), 0);
    dbReplaceThreadRuntimeItems("t1", [userItem("i1", "импорт")]);

    expect(dbSearchThreadMessages("и", 50)).toEqual([]);
    expect(dbSearchThreadMessages("   ", 50)).toEqual([]);
  });

  it("does not throw on input full of FTS5 operators", () => {
    dbUpsertThread(thread("t1", "Первый"), 0);
    dbReplaceThreadRuntimeItems("t1", [userItem("i1", 'он сказал "нет" NEAR(a b)')]);

    expect(() => dbSearchThreadMessages('"нет" NEAR(a', 50)).not.toThrow();
    expect(dbSearchThreadMessages('сказал "нет"', 50)).toHaveLength(1);
  });

  it("honours the limit", () => {
    dbUpsertThread(thread("t1", "Первый"), 0);
    dbReplaceThreadRuntimeItems(
      "t1",
      Array.from({ length: 5 }, (_, index) => userItem(`i${index}`, "импорт сессий")),
    );

    expect(dbSearchThreadMessages("импорт", 3)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/main/db/messageSearchStore.test.ts`
Expected: FAIL — `dbSearchThreadMessages` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/main/db/messageSearchStore.ts`:

```ts
import { getSqlite } from "./connection";
import { buildPhraseQuery } from "./messageSearchQuery";

/**
 * Control characters, not markup: the renderer splits on them to highlight the
 * match, so nothing the user typed can be interpreted as HTML on the way out.
 */
export const SNIPPET_MARK_START = "\u0001";
export const SNIPPET_MARK_END = "\u0002";

const SNIPPET_TOKENS = 12;

export interface ThreadMessageSearchHit {
  threadId: string;
  threadTitle: string;
  projectId: string;
  itemId: string;
  position: number;
  role: "user" | "assistant";
  snippet: string;
  updatedAt: string;
}

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
              snippet(thread_message_fts, 0, ?, ?, '…', ${SNIPPET_TOKENS}) AS snippet
       FROM thread_message_fts
       JOIN thread_message_text m ON m.rowid = thread_message_fts.rowid
       JOIN threads th            ON th.id = m.thread_id
       WHERE thread_message_fts MATCH ?
         AND th.archived = 0
       ORDER BY bm25(thread_message_fts), th.updated_at DESC
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/main/db/messageSearchStore.test.ts`
Expected: PASS, 7 tests.

If SQLite rejects `bm25()` in `ORDER BY` alongside the join, select it as a column (`bm25(thread_message_fts) AS rank`) and order by `rank` instead.

- [ ] **Step 5: Commit**

```bash
git add src/main/db/messageSearchStore.ts src/main/db/messageSearchStore.test.ts
git commit -m "feat(search): query the message index"
```

---

### Task 6: Expose the search over IPC

**Files:**

- Create: `src/shared/contracts/messageSearch.ts`
- Create: `src/shared/ipc/procedures/messageSearch.ts`
- Modify: `src/shared/contracts.ts` (re-export), `src/shared/ipc/procedureMap.ts`, `src/main/ipc/localHandlers.ts`
- Test: `src/shared/contracts/messageSearch.test.ts` (create)

**Interfaces:**

- Consumes: `dbSearchThreadMessages`, `ThreadMessageSearchHit` (Task 5).
- Produces: procedure `searchThreadMessages` on the `main-local` channel, payload `{ query: string; limit?: number }`, result `ThreadMessageSearchHit[]`; renderer calls it as `readBridge().searchThreadMessages({ query })`.

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/contracts/messageSearch.test.ts
import { describe, expect, it } from "vitest";
import { searchThreadMessagesPayloadSchema } from "./messageSearch";

describe("searchThreadMessagesPayloadSchema", () => {
  it("defaults the limit", () => {
    expect(searchThreadMessagesPayloadSchema.parse({ query: "импорт" })).toEqual({
      query: "импорт",
      limit: 50,
    });
  });

  it("keeps an explicit limit within bounds", () => {
    expect(searchThreadMessagesPayloadSchema.parse({ query: "a", limit: 10 }).limit).toBe(10);
    expect(() => searchThreadMessagesPayloadSchema.parse({ query: "a", limit: 0 })).toThrow();
    expect(() => searchThreadMessagesPayloadSchema.parse({ query: "a", limit: 500 })).toThrow();
  });

  it("accepts an empty query and lets the store decide", () => {
    expect(searchThreadMessagesPayloadSchema.parse({ query: "" }).query).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/shared/contracts/messageSearch.test.ts`
Expected: FAIL — cannot resolve `./messageSearch`.

- [ ] **Step 3: Write the contract**

```ts
// src/shared/contracts/messageSearch.ts
import { z } from "zod";

export const MAX_MESSAGE_SEARCH_RESULTS = 200;

export const searchThreadMessagesPayloadSchema = z.object({
  /** Raw user input; the main process decides what is too short to run. */
  query: z.string(),
  limit: z.number().int().min(1).max(MAX_MESSAGE_SEARCH_RESULTS).default(50),
});
export type SearchThreadMessagesPayload = z.infer<typeof searchThreadMessagesPayloadSchema>;

export interface ThreadMessageSearchHit {
  threadId: string;
  threadTitle: string;
  projectId: string;
  itemId: string;
  position: number;
  role: "user" | "assistant";
  /** Match wrapped in SNIPPET_MARK_START / SNIPPET_MARK_END. */
  snippet: string;
  updatedAt: string;
}
```

Re-export it from `src/shared/contracts.ts` next to the `sessionImport` re-export.

`ThreadMessageSearchHit` now lives here. Delete the copy declared in `messageSearchStore.ts` (Task 5) and import the shared one instead — two structurally identical interfaces would drift.

Move `SNIPPET_MARK_START` / `SNIPPET_MARK_END` here from `messageSearchStore.ts` too, so the renderer imports them from shared rather than reaching into `src/main`. Their values do not change:

```ts
export const SNIPPET_MARK_START = "\u0001";
export const SNIPPET_MARK_END = "\u0002";
```

After the move, `messageSearchStore.ts` starts with:

```ts
import {
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
  type ThreadMessageSearchHit,
} from "@/shared/contracts";
```

- [ ] **Step 4: Define the procedure**

```ts
// src/shared/ipc/procedures/messageSearch.ts
import {
  searchThreadMessagesPayloadSchema,
  type SearchThreadMessagesPayload,
  type ThreadMessageSearchHit,
} from "../../contracts";
import { definePayloadProcedure } from "../core";

export const messageSearchProcedures = {
  searchThreadMessages: definePayloadProcedure<
    SearchThreadMessagesPayload,
    ThreadMessageSearchHit[],
    "main-local"
  >("searchThreadMessages", "main-local", searchThreadMessagesPayloadSchema),
} as const;
```

Register it in `src/shared/ipc/procedureMap.ts` in both places `sessionImportProcedures` appears — the grouped map and the flat `ipcProcedureMap` spread.

- [ ] **Step 5: Wire the handler**

In `src/main/ipc/localHandlers.ts`, next to `listImportableSessions`:

```ts
    searchThreadMessages: async (payload) =>
      dbSearchThreadMessages(payload.query, payload.limit),
```

with `import { dbSearchThreadMessages } from "@/main/db/messageSearchStore";` added to the imports.

- [ ] **Step 6: Run the checks**

Run: `pnpm exec vitest run src/shared && pnpm typecheck`
Expected: PASS. Typecheck catches a procedure registered in one map but not the other.

- [ ] **Step 7: Commit**

```bash
git add src/shared/contracts/messageSearch.ts src/shared/contracts/messageSearch.test.ts \
        src/shared/contracts.ts src/shared/ipc/procedures/messageSearch.ts \
        src/shared/ipc/procedureMap.ts src/main/ipc/localHandlers.ts \
        src/main/db/messageSearchStore.ts
git commit -m "feat(search): expose thread message search over IPC"
```

---

### Task 7: Show message matches in the search overlay

**Files:**

- Create: `src/renderer/views/ThreadSearchOverlay/parts/useMessageSearch.ts`
- Create: `src/renderer/views/ThreadSearchOverlay/parts/MessageSearchResultRow.tsx`
- Modify: `src/renderer/views/ThreadSearchOverlay/ThreadSearchOverlay.tsx`
- Test: `src/renderer/views/ThreadSearchOverlay/parts/useMessageSearch.test.ts` (create)

**Interfaces:**

- Consumes: `readBridge().searchThreadMessages`, `ThreadMessageSearchHit`, `SNIPPET_MARK_START`, `SNIPPET_MARK_END` (Task 6).
- Produces: `useMessageSearch(query: string): { hits: ThreadMessageSearchHit[]; status: "idle" | "loading" | "ready" | "failed" }` and `splitSnippet(snippet: string): Array<{ text: string; match: boolean }>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/views/ThreadSearchOverlay/parts/useMessageSearch.test.ts
import { describe, expect, it } from "vitest";
import { SNIPPET_MARK_END, SNIPPET_MARK_START } from "@/shared/contracts";
import { splitSnippet } from "./useMessageSearch";

describe("splitSnippet", () => {
  it("splits a marked snippet into plain and matched parts", () => {
    const snippet = `…видит ${SNIPPET_MARK_START}импорт${SNIPPET_MARK_END} сессий…`;
    expect(splitSnippet(snippet)).toEqual([
      { text: "…видит ", match: false },
      { text: "импорт", match: true },
      { text: " сессий…", match: false },
    ]);
  });

  it("handles several matches and a snippet with none", () => {
    const snippet = `${SNIPPET_MARK_START}a${SNIPPET_MARK_END}b${SNIPPET_MARK_START}c${SNIPPET_MARK_END}`;
    expect(splitSnippet(snippet)).toEqual([
      { text: "a", match: true },
      { text: "b", match: false },
      { text: "c", match: true },
    ]);
    expect(splitSnippet("ничего")).toEqual([{ text: "ничего", match: false }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/renderer/views/ThreadSearchOverlay`
Expected: FAIL — cannot resolve `./useMessageSearch`.

- [ ] **Step 3: Write the hook and the splitter**

```ts
// src/renderer/views/ThreadSearchOverlay/parts/useMessageSearch.ts
import { useEffect, useRef, useState } from "react";
import {
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
  type ThreadMessageSearchHit,
} from "@/shared/contracts";
import { readBridge } from "@/renderer/bridge";

const DEBOUNCE_MS = 150;
/** Mirrors MIN_SEARCH_QUERY_CHARS in the main process. */
const MIN_QUERY_CHARS = 2;

export type MessageSearchStatus = "idle" | "loading" | "ready" | "failed";

export function splitSnippet(snippet: string): Array<{ text: string; match: boolean }> {
  const parts: Array<{ text: string; match: boolean }> = [];
  let rest = snippet;
  while (rest.length > 0) {
    const start = rest.indexOf(SNIPPET_MARK_START);
    if (start === -1) {
      parts.push({ text: rest, match: false });
      break;
    }
    if (start > 0) parts.push({ text: rest.slice(0, start), match: false });
    const end = rest.indexOf(SNIPPET_MARK_END, start + 1);
    if (end === -1) {
      parts.push({ text: rest.slice(start + 1), match: true });
      break;
    }
    parts.push({ text: rest.slice(start + 1, end), match: true });
    rest = rest.slice(end + 1);
  }
  return parts;
}

/**
 * Message hits for the current query. A response that arrives after the query
 * moved on is discarded, so a slow request cannot overwrite newer results.
 */
export function useMessageSearch(query: string): {
  hits: ThreadMessageSearchHit[];
  status: MessageSearchStatus;
} {
  const [hits, setHits] = useState<ThreadMessageSearchHit[]>([]);
  const [status, setStatus] = useState<MessageSearchStatus>("idle");
  const latestQuery = useRef(query);

  useEffect(() => {
    latestQuery.current = query;
    if (query.trim().length < MIN_QUERY_CHARS) {
      setHits([]);
      setStatus("idle");
      return;
    }
    setStatus("loading");
    const timer = window.setTimeout(() => {
      void readBridge()
        .searchThreadMessages({ query })
        .then((result) => {
          if (latestQuery.current !== query) return;
          setHits(result);
          setStatus("ready");
        })
        .catch(() => {
          if (latestQuery.current !== query) return;
          setHits([]);
          setStatus("failed");
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  return { hits, status };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/renderer/views/ThreadSearchOverlay`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the result row**

```tsx
// src/renderer/views/ThreadSearchOverlay/parts/MessageSearchResultRow.tsx
import { useLingui } from "@lingui/react/macro";
import type { ThreadMessageSearchHit } from "@/shared/contracts";
import { splitSnippet } from "./useMessageSearch";

export function MessageSearchResultRow(props: {
  hit: ThreadMessageSearchHit;
  selected: boolean;
  onActivate: () => void;
}) {
  const { hit, selected, onActivate } = props;
  const { t } = useLingui();
  const who = hit.role === "user" ? t`You` : t`Agent`;
  return (
    <button
      type="button"
      onClick={onActivate}
      className={`flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left ${
        selected ? "bg-[var(--surface-hover)]" : ""
      }`}
    >
      <span className="truncate text-sm">{hit.threadTitle}</span>
      <span className="line-clamp-2 text-xs text-foreground-500">
        <span className="mr-1 uppercase">{who}</span>
        {splitSnippet(hit.snippet).map((part, index) =>
          part.match ? (
            <mark key={index} className="bg-warning-200 text-foreground">
              {part.text}
            </mark>
          ) : (
            <span key={index}>{part.text}</span>
          ),
        )}
      </span>
    </button>
  );
}
```

- [ ] **Step 6: Add the section to the overlay**

In `ThreadSearchOverlay.tsx`:

1. `const { hits, status } = useMessageSearch(query);`
2. Keep `results` (title matches) as it is. Build one selection space so the keyboard runs through both lists:

```ts
const selectable = useMemo(
  () => [
    ...results.map((thread) => ({ kind: "thread" as const, threadId: thread.id })),
    ...hits.map((hit) => ({ kind: "message" as const, threadId: hit.threadId })),
  ],
  [results, hits],
);
```

3. `activateAt(index)` reads `selectable[index]` and calls `openThread(entry.threadId)` — both kinds open a thread, so there is one branch, not two.
4. Bound the arrow keys by `selectable.length` instead of `results.length`.
5. Render the message section below the title list, with a heading and the empty and failed states:

```tsx
{
  query.trim().length >= 2 && (
    <div className="border-t border-[var(--hairline)]">
      <div className="px-4 py-1.5 text-xs uppercase text-foreground-500">
        <Trans>In messages</Trans>
      </div>
      {status === "failed" ? (
        <div className="px-4 py-2 text-xs text-danger">
          <Trans>Could not search messages.</Trans>
        </div>
      ) : hits.length === 0 && status === "ready" ? (
        <div className="px-4 py-2 text-xs text-foreground-500">
          <Trans>No messages match.</Trans>
        </div>
      ) : (
        hits.map((hit, index) => (
          <MessageSearchResultRow
            key={`${hit.threadId}:${hit.itemId}`}
            hit={hit}
            selected={selectedIndex === results.length + index}
            onActivate={() => activateAt(results.length + index)}
          />
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 7: Extract the new strings**

Run: `pnpm i18n:extract`
Expected: the new `In messages`, `Could not search messages.`, `No messages match.`, `You`, `Agent` entries appear in `src/renderer/locales/*/messages.po`. Translate the Russian catalogue at minimum, following what the import work did in `fc98473fa`.

- [ ] **Step 8: Run the full check**

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/views/ThreadSearchOverlay src/renderer/locales
git commit -m "feat(search): show message matches in the thread search overlay"
```

---

### Task 8: Verify against real data

**Files:** none — this task produces evidence, not code.

- [ ] **Step 1: Start the dev app**

Run: `pnpm dev`

- [ ] **Step 2: Confirm the backfill ran**

With the app running, against the profile database (`~/.poracode/state.sqlite`), read-only:

```bash
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os'; import path from 'node:path';
const db = new DatabaseSync(path.join(os.homedir(), '.poracode', 'state.sqlite'), { readOnly: true });
console.log(db.prepare('SELECT COUNT(*) c FROM thread_message_text').get());
console.log(db.prepare('SELECT COUNT(*) c FROM thread_runtime_items WHERE type IN (\'user_message\',\'assistant_message\')').get());
"
```

Expected: the two counts are close — the difference is messages with no text.

- [ ] **Step 3: Search from the UI**

Open the overlay with the sidebar search button and with Ctrl+G. Type a lowercase Russian phrase you know appears mid-conversation in an imported thread, capitalised in the original. Expected: it appears under "In messages" with the phrase highlighted, and clicking opens that thread.

- [ ] **Step 4: Confirm streaming does not churn the index**

Send a message in a live thread and watch `thread_message_text` while the answer streams: the assistant row appears once, after the answer completes, not repeatedly during it.

- [ ] **Step 5: Record the result**

Note the measured counts and timings in the pull request description. No commit.

---

## Notes for the implementer

- `PersistedRuntimeItem` has no `position` field — position is assigned by the database layer. That is why `indexThreadMessages` reads the row back rather than taking the item object.
- Very long assistant answers are stored head-plus-tail in `streams` with the middle in `thread_runtime_item_stream_chunks` (see `runtimeStreamCap.ts`). Indexing uses what is in `streams`, so the elided middle of an unusually long answer is not searchable. This is accepted for now; on the measured database no message had been elided.
- The write queue (`runtimeWriteQueue`) batches events, so tests must call `dbFlushThreadRuntimeWrites(threadId)` before reading the index.
