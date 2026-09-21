# Full-text search over thread messages

**Date:** 2026-09-21
**Status:** Draft

## Problem

Thread search finds nothing that is not in a title. The search overlay filters on
`thread.title` (`src/renderer/views/ThreadSearchOverlay/ThreadSearchOverlay.tsx`), the
MCP `search` tool documents itself as "matches thread titles", and there is no
full-text index anywhere in `src/main/db`. A phrase the user remembers typing three
weeks ago is unreachable unless it happens to be in the title — and titles are
generated, so it rarely is.

In-thread find (Ctrl+F, `components/find/ChatFindBar.tsx`) does search message text,
but only across the timeline entries currently loaded. The chat pane pages 40 entries
at a time (`state/chatRuntimePersister.ts`), so in a long or imported thread it sees
the tail and nothing else. This reinforces the impression that search is broken.

Imported threads make it sharper: they arrive with hundreds of messages of history
that the user knows is in there.

## Decisions

- **FTS5, not `LIKE`.** SQLite's `LIKE` and `lower()` are case-insensitive for ASCII
  only. Measured on a real database: `LIKE '%импорт%'` returns 107 rows, `'%Импорт%'`
  34, `'%ИМПОРТ%'` 1, while all three ASCII spellings of `import` return the same 118.
  `lower('ИМПОРТ')` returns the string unchanged. A naive scan is therefore unusable
  for Russian. FTS5's `unicode61` tokenizer folds case correctly. FTS5 is compiled in
  (`node_modules/better-sqlite3/deps/defines.gypi`), SQLite is 3.53.0.
- **A shadow text table, indexed by FTS5 as external content.** Message text lives
  inside JSON — user text in `thread_runtime_items.payload`, assistant text in
  `thread_runtime_items.streams` — so no existing column can be indexed directly. The
  extracted plain text gets its own table, and the FTS index is built over that.
- **Index on completion, not per delta.** Streaming rewrites `streams` on every flush.
  Indexing there would rebuild the same row dozens of times per answer. A message is
  indexed once, when its item completes.
- **Exact phrase matching.** A multi-word query matches messages containing those
  words adjacent and in order. Chosen over "all words anywhere" because it is
  predictable; the words the user types are usually a remembered fragment.
- **Messages only.** `user_message` and `assistant_message`. Command output,
  reasoning, file changes and web search results are not indexed — they are the bulk
  of the noise and rarely what someone searches for.
- **Non-archived threads only**, across all projects, matching what the title search
  in the same overlay already does.
- **A result opens its thread**, at the position the thread would normally open. It
  does not scroll to the matched message: that needs a "load the window around
  position N" path in chat pagination which does not exist yet, and it is worth its
  own change.
- **No new entry point.** The existing sidebar search button and Ctrl+G
  (`thread.search.open`) open the same overlay; it grows a second section.

## Design

### Schema

One migration in `src/main/db/migrations.ts` adds a shadow table and an external
content FTS index over it:

```sql
CREATE TABLE IF NOT EXISTS thread_message_text (
  rowid     INTEGER PRIMARY KEY,
  thread_id TEXT    NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  item_id   TEXT    NOT NULL,
  position  INTEGER NOT NULL,
  role      TEXT    NOT NULL,          -- 'user' | 'assistant'
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
```

Three triggers keep the index in step with the shadow table — the standard external
content pattern, where delete and update first push the old row out of the index:

```sql
CREATE TRIGGER thread_message_text_ai AFTER INSERT ON thread_message_text BEGIN
  INSERT INTO thread_message_fts (rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER thread_message_text_ad AFTER DELETE ON thread_message_text BEGIN
  INSERT INTO thread_message_fts (thread_message_fts, rowid, text)
    VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER thread_message_text_au AFTER UPDATE ON thread_message_text BEGIN
  INSERT INTO thread_message_fts (thread_message_fts, rowid, text)
    VALUES ('delete', old.rowid, old.text);
  INSERT INTO thread_message_fts (rowid, text) VALUES (new.rowid, new.text);
END;
```

Because deletes cascade from `threads`, deleting a thread empties its index rows
through the delete trigger without extra code.

The same migration backfills existing threads, reading `thread_runtime_items` in
batches and inserting the extracted text. Measured shape of a real database: 2679
items across 20 threads, ~2.5 MB of text — backfill is a one-off pass of a few
hundred milliseconds. The index adds roughly the size of the indexed text again.

### Extracting message text

A pure function in a new `src/main/db/messageText.ts`:

```ts
export function extractMessageText(item: PersistedRuntimeItem): string | null;
```

- `user_message` → the `text` of each `kind: "text"` block in `payload.content`,
  joined by newlines.
- `assistant_message` → `streams.assistant_text`.
- Anything else → `null`, meaning "not indexed".

Returning `null` rather than `""` keeps "this type is not indexed" distinct from "this
message is empty", so the writer can skip both without a second rule.

### Keeping the index current

`src/main/db/messageSearchStore.ts` exposes writes used by the runtime layer:

```ts
export function dbIndexThreadMessage(item: PersistedRuntimeItem, threadId: string): void;
export function dbRemoveThreadMessage(threadId: string, itemId: string): void;
export function dbReindexThread(threadId: string, items: PersistedRuntimeItem[]): void;
export function dbClearThreadMessages(threadId: string): void;
```

Call sites in `src/main/db/runtimeItems.ts`:

| Existing path                                          | Index effect                                              |
| ------------------------------------------------------ | --------------------------------------------------------- |
| `dbApplyThreadRuntimeEvents`, item reaches `completed` | `dbIndexThreadMessage` (upsert on `(thread_id, item_id)`) |
| item deleted                                           | `dbRemoveThreadMessage`                                   |
| `dbReplaceThreadRuntimeItems`                          | `dbReindexThread`                                         |
| `dbClearThreadRuntimeItems`                            | `dbClearThreadMessages`                                   |
| `dbTruncateThreadRuntimeAfter`                         | delete indexed rows past the truncation position          |

Imports need no special handling: `sessionImport/replay.ts` emits the same canonical
events, so a replayed message completes and is indexed like a live one.

### Querying

`dbSearchThreadMessages` in the same module:

```ts
interface ThreadMessageSearchHit {
  threadId: string;
  threadTitle: string;
  projectId: string;
  itemId: string;
  position: number;
  role: "user" | "assistant";
  snippet: string; // match wrapped in the delimiters below
  updatedAt: string;
}
```

```sql
SELECT th.id AS thread_id, th.title, th.project_id, th.updated_at,
       m.item_id, m.position, m.role,
       snippet(thread_message_fts, 0, '<<', '>>', '…', 12) AS snippet,
       bm25(thread_message_fts) AS rank
FROM thread_message_fts
JOIN thread_message_text m ON m.rowid = thread_message_fts.rowid
JOIN threads th            ON th.id = m.thread_id
WHERE thread_message_fts MATCH ?
  AND th.archived = 0
ORDER BY rank, th.updated_at DESC
LIMIT ?
```

The query string is built by a pure function, not by interpolation:

```ts
export function buildPhraseQuery(input: string): string | null;
```

It trims, returns `null` for anything shorter than two characters, doubles any `"` in
the input and wraps the whole thing in quotes, so FTS5 reads it as one phrase and
every operator character (`*`, `-`, `:`, `NEAR`, `AND`) is literal. Feeding raw user
input to `MATCH` would otherwise turn a stray quote or colon into a syntax error.

Snippet delimiters are markers, not markup: the renderer splits on them and applies
its own highlight, so nothing user-typed is interpreted as HTML.

### IPC

A new procedure alongside the existing ones (`src/shared/ipc/procedures/`), registered
in `procedureMap.ts`, with a zod schema for `{ query, limit }` and for the hit array.
`limit` defaults to 50. The handler lives with the other local handlers in
`src/main/ipc/localHandlers.ts`.

### UI

`ThreadSearchOverlay` keeps its current behaviour and gains a second section:

- **Titles** — unchanged: filtered locally from the store, instant, always first.
- **In messages** — results from the IPC call, debounced 150 ms after the last
  keystroke, each row showing thread title, role, and the snippet with the match
  highlighted.

Keyboard selection runs through both sections as one list, so ↓ from the last title
result lands on the first message result. Enter and click both call the existing
`openThread`. An in-flight request whose query is stale is discarded on arrival.

Empty state distinguishes "no matches" from "keep typing" (query shorter than two
characters).

### Error handling

- A malformed query cannot reach SQLite: `buildPhraseQuery` returns `null` and the
  section renders the "keep typing" state.
- A failed IPC call leaves the titles section working and shows the message section as
  failed rather than emptying the overlay.
- If the FTS table is missing or corrupt (an interrupted migration), search returns no
  results and logs; the app keeps running. The index is derived data and the migration
  can rebuild it.

### Testing

Pure functions, no database needed:

- `extractMessageText` — user blocks, assistant stream, mixed blocks, empty content,
  non-message types.
- `buildPhraseQuery` — empty and one-character input, embedded quotes, FTS5 operator
  characters, Cyrillic, leading and trailing whitespace.

Against a temporary database:

- Indexing on completion; re-indexing an item updates rather than duplicates.
- Deleting a thread removes its rows from both tables.
- Truncation removes only the rows past the position.
- Case folding: a lowercase Cyrillic query matches capitalised text — the case that
  `LIKE` fails.
- Phrase semantics: adjacent words match, the same words reordered do not.
- Archived threads are excluded.
- Migration backfill over pre-existing items.

## Out of scope

- Scrolling to the matched message inside the thread.
- Indexing command output, reasoning, file changes, web search results.
- Substring matching inside a word (`trigram`), regular expressions, fuzzy matching.
- Searching archived threads.
- Exposing message search through the MCP `search` tool.
