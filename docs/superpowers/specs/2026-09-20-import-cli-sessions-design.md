# Import existing CLI sessions into Poracode threads

**Date:** 2026-09-20
**Status:** Draft

## Problem

Codex CLI and Claude Code write every conversation to disk (`~/.codex/sessions/**`,
`<claude home>/projects/**`). Poracode reads those files today only to discover the id
of a session it started itself. A user who has been working in the terminal — or who
adds a second account as a profile, whose `CODEX_HOME` starts empty — cannot bring any
of that history into the app. The only workaround is to start a fresh thread and ask the
agent to read the transcript file, which is not a resume and loses the conversation view.

## Decisions

- An imported thread carries **both** the provider session id (so the next message
  resumes the real CLI session with its full context) **and** a replayed transcript, so
  the chat pane is not empty.
- The replay is **text only**: `user` and `assistant` messages. Tool calls, reasoning,
  attachments, and sub-agent activity are skipped in v1. A chat pane full of
  half-mapped tool rows is worse than a clean text transcript.
- Import is **non-destructive**: the source `.jsonl` is never modified or moved, and
  importing the same session twice is refused rather than duplicated.
- Transcripts are **replayed through the canonical runtime-event pipeline**
  (`dbApplyThreadRuntimeEvents`), not written into `thread_runtime_items` directly, so
  the importer inherits the existing persistence, ordering, and schema handling.
- Session discovery reuses the **profile-aware home directories** already resolved by
  the Codex and Claude adapters, so a profile's sessions are importable and are labeled
  with the profile they belong to.

## Design

### Shared contracts

New `src/shared/contracts/sessionImport.ts`:

```ts
export const importableSessionSchema = z.object({
  /** Stable id for this discovery result: `<provider>:<sessionId>`. */
  id: z.string().min(1),
  provider: z.enum(["codex", "claude"]),
  /** Agent kind that owns the home this was found in (`codex`, `codex:work`, …). */
  agentKind: z.string().min(1),
  providerSessionId: z.string().min(1),
  /** Absolute path of the transcript file, shown in the UI and used for replay. */
  path: z.string().min(1),
  /** Working directory recorded in the transcript, when present. */
  cwd: z.string().optional(),
  startedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  messageCount: z.number().int().nonnegative(),
  /** First user message, trimmed — the list's title line. */
  preview: z.string(),
  /** A thread already imported from this session, if any. */
  importedThreadId: z.string().optional(),
});
```

`Thread` gains one optional field, stored in the existing `config` JSON column (no DB
migration):

```ts
importedFrom?: { provider: "codex" | "claude"; path: string; importedAt: string };
```

The chat pane header renders a single muted line from it ("Imported from Codex CLI") and
the importer uses it to detect an already-imported session.

### Discovery (supervisor)

`src/supervisor/sessionImport/scan.ts` exports
`scanImportableSessions(input: { homes: ImportHome[]; cwd?: string })`, where an
`ImportHome` is `{ agentKind, provider, dir }`. The adapters already know how to list
their homes — the base home plus each profile's — so the scan is driven by the registry
rather than hardcoded paths.

For each home:

- **Codex**: walk `<home>/sessions/**/rollout-*.jsonl`. The first line is `session_meta`
  and carries `session_id`, `cwd`, and `timestamp` — enough for the list without reading
  the rest of the file. `messageCount` and `preview` need a scan of the file, so the
  scan reads at most the first 256 KB for the preview and counts messages lazily
  (`messageCount` is `0` until the file is fully parsed at import time; the list shows a
  size-derived estimate instead).
- **Claude**: walk `<home>/projects/*/*.jsonl`. The directory name encodes the cwd
  (`F--claude`), but the per-line `cwd` field is authoritative when present.

Results are sorted newest first and deduped by `providerSessionId`. When `cwd` is
supplied, sessions whose recorded cwd does not match are dropped (path comparison is
case-insensitive on Windows, and WSL paths are compared after normalization).

WSL homes are out of scope for v1: the scan runs on the host only.

### Parsing

`codexTranscript.ts` and `claudeTranscript.ts` each export
`parseTranscript(path): ImportedTranscript`, returning:

```ts
interface ImportedTranscript {
  providerSessionId: string;
  cwd?: string;
  startedAt?: string;
  messages: Array<{ role: "user" | "assistant"; text: string; at?: string }>;
}
```

Codex: lines with `type === "response_item"` and `payload.type === "message"`. Role
`developer` is dropped. Content is the concatenation of `input_text` / `output_text`
parts. A `user` message whose text is entirely a synthetic wrapper
(`<app-context>`, `<recommended_plugins>`, `<environment_context>`, `<user_instructions>`)
is dropped — those are injected context, not something the user typed.

Claude: lines with `type === "user"` or `type === "assistant"`. `message.content` is
either a string or an array; from an array only `{ type: "text" }` parts are kept, so
`thinking`, `tool_use`, and `tool_result` are skipped. A `user` line whose content is
only `tool_result` parts yields no message. Lines with `isSidechain: true` are dropped
(sub-agent traffic). Meta line types (`bridge-session`, `queue-operation`, `attachment`,
`system`, `mode`, `last-prompt`, `custom-title`, `atis-latch`) are ignored.

Both parsers stream the file line by line and cap a single message at 100 KB of text,
truncating with a trailing marker — a runaway paste should not put megabytes into one
chat row.

### Import (main)

`importSessions` is a main-local IPC (it writes to SQLite, like the other thread
mutations). For each requested session:

1. Refuse if a thread already records this `providerSessionId` in `importedFrom`, and
   return that thread's id so the UI can focus it instead.
2. Create the thread via `dbUpsertThread`: `agentKind` from the discovery result (so a
   profile's session lands on that profile), `title` from the transcript's first user
   message (trimmed to the normal title length), `session_ref` set to
   `{ providerSessionId, discoveredAt: <now> }`, `status: "idle"`, and `config.importedFrom`.
3. Parse the transcript and replay it: for each message, three canonical events —
   `item.started` (`user_message` with content blocks, or `assistant_message`),
   `content.delta` on the `assistant_text` stream for assistant text, and
   `item.completed`. Events are applied in batches of 200 through
   `dbApplyThreadRuntimeEvents`, then flushed with `dbFlushThreadRuntimeWrites`.
4. Emit the normal thread-created / thread-updated broadcasts so every open client
   (including remote) sees the new thread.

Import is sequential across sessions and reports progress per session, so a bulk import
of a large backlog shows movement instead of a frozen dialog. A parse failure aborts
that one session (the half-built thread is deleted) and continues with the rest; the
result lists successes and failures.

### UI

Two entry points share one component, `ImportSessionsPanel`:

- **Sidebar**: an "Import session" item next to "New thread" in the project section.
  Opens a dialog scoped to that project's directory, listing only matching sessions.
- **Settings → Import**: the same list without the cwd filter, plus a provider filter
  and a project picker (an imported thread needs a project to live in; the picker
  defaults to the project whose path matches the session's cwd, when there is one).

A row shows: provider icon with profile badge, preview text, cwd, relative date, and
message count. Rows for already-imported sessions are disabled and labeled "Imported",
with a link that focuses the existing thread. Selection is multi-select with a
select-all; the confirm button reports how many threads will be created.

### Error handling

- A home directory that does not exist is skipped silently (a fresh profile).
- An unreadable or malformed transcript is reported as one row-level error; the scan
  never throws.
- Importing into a project whose directory no longer exists is refused with a message —
  the resumed session would fail on its first message anyway.

### Testing

- `scan.test.ts`: fixture homes for both providers, cwd filtering, dedupe, profile
  attribution, missing directories.
- `codexTranscript.test.ts` / `claudeTranscript.test.ts`: role mapping, synthetic-wrapper
  and tool-part filtering, sidechain exclusion, string vs array content, truncation,
  malformed lines.
- `importer.test.ts`: thread shape (session ref, title, `importedFrom`), emitted event
  sequence, duplicate refusal, partial failure handling.
- `ImportSessionsPanel.test.tsx`: list rendering, disabled imported rows, multi-select,
  confirm payload.

## Out of scope

- Tool calls, reasoning, attachments, and sub-agent rows in the replayed transcript.
- WSL and remote-machine homes.
- Other providers (Cursor, Copilot, Gemini, …) — the scan and IPC are provider-keyed, so
  adding one later is a parser plus a registry entry.
- Two-way sync: Poracode threads are never written back into the CLI's session store.
