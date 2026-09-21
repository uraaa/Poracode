# Import Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the twelve defects found reviewing the session-import feature, worst-visible first, each with a test that fails before the fix.

**Architecture:** No new subsystems. Every fix is local to one of four areas — the transcript parsers, the discovery scan, the import flow, and the panel — and the tasks are grouped so two tasks never edit the same file.

**Tech Stack:** TypeScript, Electron main/renderer split, zod IPC contracts, React, Vitest.

**Review source:** measurements in this plan come from a real store — 937 Codex rollouts, 20 threads, an imported Claude thread of 720 user messages.

## Global Constraints

- Work in the `feat/import-sessions` worktree at `F:\STORM_PROJECTS\_MY\poracode-import`. The main checkout is another session's and must not be touched.
- TDD: write the failing test, run it, watch it fail for the stated reason, then implement. A test that passes before the fix proves nothing.
- Verification per task: `pnpm exec vitest run <touched test files>`, then `pnpm lint` and `pnpm typecheck`. The full suite has 36 pre-existing failures unrelated to import (`remote/config`, `providers/usageFormat`, `agents/cursor` and others); do not chase them.
- Discovery reads transcripts but never writes to them. Any fix that would modify a provider's file is wrong.
- Preview reads are 512 KB per session and happen only for the returned page. No fix may move a preview read into the candidate or facet pass.
- Conventional Commits, one commit per task.

## Task Groups

| Stream      | Files owned                                                          | Tasks      |
| ----------- | -------------------------------------------------------------------- | ---------- |
| Parsers     | `transcript.ts`, `claudeTranscript.ts`, `codexTranscript.ts` + tests | 1, 11, 12  |
| Scan        | `scan.ts` + test                                                     | 2, 3, 4, 8 |
| Import flow | `index.ts`, `importSessionsActions.ts` + tests                       | 5, 6, 9    |
| Panel       | `ImportSessionsPanel.tsx`, `importFilters.ts`, contracts + tests     | 7, 10      |

Streams may run in parallel; tasks inside a stream are sequential.

---

### Task 1: Strip injected blocks out of replayed Claude messages

**Severity:** highest — visible in every imported Claude thread.

**Files:**

- Modify: `src/main/sessionImport/transcript.ts`, `src/main/sessionImport/claudeTranscript.ts`
- Test: `src/main/sessionImport/claudeTranscript.test.ts`

**Defect:** `codexTranscript.messageFrom` calls `stripInjectedContext` on user turns; `claudeTranscript.messageFrom` does not strip anything. Claude Code writes machine blocks into the `user` role, so they are replayed as if the user typed them. Measured on one imported thread: 90 of 720 user messages begin with such a block — `<task-notification>` 75, `<command-name>` 8, `<local-command-stdout>` 7.

`INJECTED_WRAPPER_RE` in `transcript.ts` also does not know Claude's tags.

- [ ] **Step 1: Write the failing test**

```ts
it("drops a user turn that is only a task notification", () => {
  const path = writeClaudeTranscript([
    {
      type: "user",
      sessionId: "s1",
      message: {
        role: "user",
        content:
          "<task-notification>\n<task-id>b6v1</task-id>\n<status>completed</status>\n</task-notification>",
      },
    },
    { type: "user", sessionId: "s1", message: { role: "user", content: "теперь почини импорт" } },
  ]);

  expect(parseClaudeTranscript(path).messages.map((m) => m.text)).toEqual(["теперь почини импорт"]);
});

it("keeps what the user typed around a system reminder", () => {
  const path = writeClaudeTranscript([
    {
      type: "user",
      sessionId: "s1",
      message: {
        role: "user",
        content: "проверь ветку<system-reminder>Codebase instructions…</system-reminder>",
      },
    },
  ]);

  expect(parseClaudeTranscript(path).messages.map((m) => m.text)).toEqual(["проверь ветку"]);
});
```

Reuse the file's existing transcript-writing helper; add one if it has none.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run src/main/sessionImport/claudeTranscript.test.ts`
Expected: FAIL — the notification survives as its own message.

- [ ] **Step 3: Teach `stripInjectedContext` Claude's tags**

Extend `INJECTED_WRAPPER_RE` with the wrappers Claude Code injects, keeping the existing alternatives:

```ts
const INJECTED_WRAPPER_RE =
  /<(app-context|recommended_plugins|environment_context|user_instructions|INSTRUCTIONS|system-reminder|task-notification|local-command-stdout|local-command-stderr|command-name|command-message|command-args)>[\s\S]*?<\/\1>/gu;
```

- [ ] **Step 4: Strip user turns in the Claude parser**

In `claudeTranscript.messageFrom`, mirror the Codex parser: strip on the `user`
role only, keep assistant text verbatim, and drop the message when nothing
survives. The existing interruption-marker check stays.

- [ ] **Step 5: Run the parser tests**

Run: `pnpm exec vitest run src/main/sessionImport`
Expected: PASS. The Codex cases must stay green — the shared regex changed.

- [ ] **Step 6: Commit**

```bash
git commit -am "fix(import): strip Claude's injected blocks out of replayed turns"
```

---

### Task 2: List a session even when no preview is found

**Severity:** high — the session is invisible, not merely unlabelled.

**Files:**

- Modify: `src/main/sessionImport/scan.ts`
- Test: `src/main/sessionImport/scan.test.ts`

**Defect:** `if (preview.length === 0) continue;` drops the session from the result entirely. Real case in the reviewed store: a 5.3 MB rollout whose first user message starts 5,331 KB in — past the 512 KB preview window — and is itself pure `<recommended_plugins>`, so it strips to nothing. The session has a title in Codex's index and is perfectly importable, but the panel never shows it.

- [ ] **Step 1: Write the failing test**

```ts
it("lists a session whose first user text is beyond the preview window", () => {
  const dir = mkdtempSync(join(tmpdir(), "poracode-scan-nopreview-"));
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, "rollout-cx-quiet.jsonl"),
    [
      JSON.stringify({
        type: "session_meta",
        payload: { session_id: "cx-quiet", cwd: "F:\\repo", timestamp: "2026-09-20T04:43:18.000Z" },
      }),
      // A turn of pure injected context: stripping leaves nothing.
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<recommended_plugins>catalogue</recommended_plugins>" },
          ],
        },
      }),
    ].join("\n"),
    "utf8",
  );

  const { sessions } = scanImportableSessions({
    homes: [{ provider: "codex", agentKind: "codex", dir }],
  });

  expect(sessions.map((s) => s.providerSessionId)).toEqual(["cx-quiet"]);
  expect(sessions[0]?.preview).toBe("");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run src/main/sessionImport/scan.test.ts`
Expected: FAIL — the session list is empty.

- [ ] **Step 3: Keep the session, drop only the preview**

Remove the `continue`. `preview` stays a string and is `""` when nothing was
found; everything else about the row is already known from the head. The panel
falls back to the title, and `importSessionsActions.titleFor` already falls back
to `Imported session` when both are empty, so no renderer change is needed.

- [ ] **Step 4: Run the scan and renderer tests**

Run: `pnpm exec vitest run src/main/sessionImport src/renderer/components/sessionImport`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "fix(import): keep a session whose preview could not be read"
```

---

### Task 3: Cache the folder-exists check per path

**Severity:** performance — seconds per scan on network paths.

**Files:**

- Modify: `src/main/sessionImport/scan.ts`
- Test: `src/main/sessionImport/scan.test.ts`

**Defect:** `cwdExists: existsSync(head.cwd)` runs once per listed session. Measured: 452 ms for a reachable `//wsl.localhost/ubuntu/...` path, 1,148 ms for an unreachable one; the OS caches repeats (ten calls, 21 ms), so the cost is roughly one second per _distinct_ unreachable folder per scan. The reviewed store has 71 rollouts under WSL paths.

- [ ] **Step 1: Write the failing test**

Inject the check so the test can count calls. Add an optional `exists` to the
scan input, defaulting to `existsSync`:

```ts
it("checks a folder once however many sessions share it", () => {
  const calls: string[] = [];
  const homes: ImportHome[] = [
    {
      provider: "codex",
      agentKind: "codex",
      dir: codexHome([
        { id: "cx-1", cwd: "F:\\repo", prompt: "one" },
        { id: "cx-2", cwd: "F:\\repo", prompt: "two" },
        { id: "cx-3", cwd: "F:\\other", prompt: "three" },
      ]),
    },
  ];

  scanImportableSessions({
    homes,
    exists: (path) => {
      calls.push(path);
      return true;
    },
  });

  expect(calls.toSorted()).toEqual(["F:\\other", "F:\\repo"]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run src/main/sessionImport/scan.test.ts`
Expected: FAIL — three calls, one per session.

- [ ] **Step 3: Memoise inside one scan**

Add `exists?: (path: string) => boolean` to the input, default `existsSync`, and
wrap it in a `Map<string, boolean>` local to the call so the cache never
outlives a scan — a folder created between scans must be seen.

- [ ] **Step 4: Run and commit**

Run: `pnpm exec vitest run src/main/sessionImport`
Expected: PASS.

```bash
git commit -am "perf(import): check each session folder once per scan"
```

---

### Task 4: Read session fields from their own record

**Severity:** correctness, low frequency.

**Files:**

- Modify: `src/main/sessionImport/scan.ts`
- Test: `src/main/sessionImport/scan.test.ts`

**Defect:** `rawField` regex-scans the whole 128 KB head for `"cwd"`, `"timestamp"`, `"session_id"` and `"ownerAccountUuid"`, taking the first match anywhere. A user who pasted JSON containing `"cwd"` into their first message can give the session a wrong folder, which then decides its project on import.

The head-chunk design exists because Codex's `session_meta` line can exceed any
sane chunk — so the fix is not "parse the whole file", it is "scan only the
records that may carry the field".

- [ ] **Step 1: Write the failing test**

```ts
it("ignores a cwd pasted inside a user message", () => {
  const dir = mkdtempSync(join(tmpdir(), "poracode-scan-paste-"));
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, "rollout-cx-paste.jsonl"),
    [
      JSON.stringify({
        type: "session_meta",
        payload: { session_id: "cx-paste", cwd: "F:\\real", timestamp: "2026-09-20T04:43:18.000Z" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: '{"cwd":"F:\\\\pasted"}' }],
        },
      }),
    ].join("\n"),
    "utf8",
  );

  const { sessions } = scanImportableSessions({
    homes: [{ provider: "codex", agentKind: "codex", dir }],
  });

  expect(sessions[0]?.cwd).toBe("F:\\real");
});
```

This passes today only by luck of ordering — make the pasted value come first in
a second case where the head's own `cwd` appears later on the same line, and
assert the real one still wins.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run src/main/sessionImport/scan.test.ts`

- [ ] **Step 3: Narrow the search**

For Codex, restrict the field scan to the first line of the head (the
`session_meta` record) — it is the only record carrying those fields, and it is
what the head chunk was sized for. For Claude, restrict it to records whose
`"type"` is `"user"`, `"assistant"`, `"bridge-session"` or `"summary"`, scanning
line by line and stopping once both `cwd` and the timestamp are known. Keep the
regex approach within a line: a line may still be cut by the chunk boundary.

- [ ] **Step 4: Run and commit**

Run: `pnpm exec vitest run src/main/sessionImport`

```bash
git commit -am "fix(import): read a session's fields from its own record"
```

---

### Task 5: Refuse a second import of the same session

**Severity:** data integrity.

**Files:**

- Modify: `src/main/sessionImport/index.ts`
- Test: `src/main/sessionImport/index.test.ts`

**Defect:** the panel disables rows whose `importedThreadId` is set, and that is
the only guard. The flag is computed when the list was scanned, so a stale
panel, a second window, or a retry after a partial failure creates a duplicate
thread against the same provider session — two threads then resume the same
conversation.

- [ ] **Step 1: Write the failing test**

```ts
it("refuses to import a session a thread already holds", () => {
  const { dir, path } = codexHomeWith("cx-dup", "F:\\repo", "hello");
  const existing = thread({
    id: "already",
    config: {
      model: "gpt-5.5",
      importedFrom: { provider: "codex", path, importedAt: "2026-09-20T06:00:00.000Z" },
    },
  });

  expect(() =>
    importSessionTranscript(
      { threadId: "t1", provider: "codex", path },
      {
        readSharedSettings: () => settingsWithHome(dir),
        getThreads: () => [existing, thread({ id: "t1" })],
        applyRuntimeEvents: vi.fn<(threadId: string, events: readonly RuntimeEvent[]) => void>(),
        flushRuntimeWrites: vi.fn<(threadId: string) => void>(),
      },
    ),
  ).toThrow(/already imported/iu);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run src/main/sessionImport/index.test.ts`
Expected: FAIL — no error is thrown.

- [ ] **Step 3: Check before replaying**

In `importSessionTranscript`, after the unknown-thread check, reuse
`importedThreads(deps.getThreads())` and throw when the path or the provider
session id already belongs to another thread. The renderer's catch already
deletes the half-built thread and reports the message, so the caller needs no
change.

- [ ] **Step 4: Run and commit**

Run: `pnpm exec vitest run src/main/sessionImport`

```bash
git commit -am "fix(import): refuse a session another thread already imported"
```

---

### Task 6: Do not leave a project behind when an import fails

**Severity:** data integrity, low.

**Files:**

- Modify: `src/renderer/components/sessionImport/importSessionsActions.ts`
- Test: `src/renderer/components/sessionImport/ImportSessionsPanel.test.tsx`

**Defect:** `resolveImportProjectId` calls `addProjectWithResult` before the
thread exists. When the replay then fails, the catch deletes the thread and the
new project stays in the sidebar, empty, filed into the active workspace.

- [ ] **Step 1: Write the failing test**

Extend the panel's failure case: make `importSessionTranscript` reject, have
`addProjectWithResult` report `created: true`, and assert the store's
`deleteProject` is called for the project it created. Mock `deleteProject`
alongside the existing store mocks.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run src/renderer/components/sessionImport/ImportSessionsPanel.test.tsx`
Expected: FAIL — `deleteProject` is never called.

- [ ] **Step 3: Roll the project back**

Have `resolveImportProjectId` return both the id and whether it created the
project, and in the catch delete a project this import created and no thread now
uses. Do not delete a project that already existed — `addProjectWithResult`
reports that as `created: false`.

- [ ] **Step 4: Run and commit**

Run: `pnpm exec vitest run src/renderer/components/sessionImport`

```bash
git commit -am "fix(import): remove a project created for an import that failed"
```

---

### Task 7: Say when the list is cut short

**Severity:** UX.

**Files:**

- Modify: `src/main/sessionImport/scan.ts`, `src/shared/contracts/sessionImport.ts`, `src/renderer/components/sessionImport/ImportSessionsPanel.tsx`
- Test: `src/main/sessionImport/scan.test.ts`, `src/renderer/components/sessionImport/ImportSessionsPanel.test.tsx`

**Defect:** the scan returns at most 200 sessions and says nothing about it. With
"All folders" selected on a store of 937 rollouts, the user sees a list that
looks complete and is not.

- [ ] **Step 1: Write the failing tests**

Scan: with `limit: 2` over four matching sessions, `result.truncated` is `true`
and is `false` when everything fitted. Panel: when the result reports
`truncated`, a line reading like "Showing the 200 most recent — narrow the
filters to see more" is rendered; when it does not, that line is absent.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run src/main/sessionImport/scan.test.ts src/renderer/components/sessionImport/ImportSessionsPanel.test.tsx`

- [ ] **Step 3: Report it and show it**

Add `truncated: boolean` to `ImportScanResult` and to
`ListImportableSessionsResult`, set when the page filled before the candidates
ran out. Render the notice above the list, with Lingui macros like the rest of
the panel, then run `pnpm i18n:extract` and translate the Russian catalogue.

- [ ] **Step 4: Run and commit**

Run: `pnpm exec vitest run src/main/sessionImport src/renderer/components/sessionImport && pnpm typecheck`

```bash
git commit -am "feat(import): say when the session list was cut at the page limit"
```

---

### Task 8: Search titles and folders across every session, not the page

**Severity:** UX.

**Files:**

- Modify: `src/main/sessionImport/scan.ts`, `src/shared/contracts/sessionImport.ts`
- Test: `src/main/sessionImport/scan.test.ts`

**Defect:** the search box filters client-side over the returned page, so in a
folder with more sessions than the limit it silently searches a subset.

**Constraint:** a preview cannot be searched without reading 512 KB per session,
which is the cost the page limit exists to avoid. So the scan matches what it
already knows — title and folder — and the renderer keeps matching the preview
within the page. Say so in the panel's placeholder text.

- [ ] **Step 1: Write the failing test**

With `limit: 1` and two matching sessions where only the older one's title
contains "deploy", `scanImportableSessions({ homes, query: "deploy", limit: 1 })`
returns that older session.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run src/main/sessionImport/scan.test.ts`

- [ ] **Step 3: Filter candidates by the query**

Add `query?: string` to the scan input and to the IPC payload. Match
case-insensitively against the title (read from the provider's index, already
cheap) and the folder, as a predicate alongside provider, account and folder —
before the page is cut, and outside the facet computation so the dropdowns do
not collapse while the user types. Have the panel pass it, debounced 200 ms.

- [ ] **Step 4: Run and commit**

Run: `pnpm exec vitest run src/main/sessionImport src/renderer/components/sessionImport`

```bash
git commit -am "feat(import): search titles and folders across every session"
```

---

### Task 9: Record the transcript the thread actually resumes

**Severity:** correctness, latent.

**Files:**

- Modify: `src/renderer/components/sessionImport/importSessionsActions.ts`
- Test: `src/renderer/components/sessionImport/ImportSessionsPanel.test.tsx`

**Defect:** importing under another account copies the transcript into that
account's home and resumes the copy, but the thread stores
`importedFrom.path` = the original. `importSessionTranscript` already returns
the real path; nobody writes it back. The duplicate check then works only
through the session id, and the `byPath` half of it is dead for copies.

- [ ] **Step 1: Write the failing test**

In the existing "imports under another account" case, have the mocked
`importSessionTranscript` resolve a different `path` and assert the thread is
updated to hold it.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run src/renderer/components/sessionImport/ImportSessionsPanel.test.tsx`

- [ ] **Step 3: Write the returned path back**

After a successful `importSessionTranscript`, if the returned path differs from
the one sent, update the thread's `config.importedFrom.path` through the store's
normal update path.

- [ ] **Step 4: Run and commit**

Run: `pnpm exec vitest run src/renderer/components/sessionImport`

```bash
git commit -am "fix(import): record the transcript path the thread resumes"
```

---

### Task 10: Compare folders the way the platform does

**Severity:** correctness on POSIX.

**Files:**

- Modify: `src/main/sessionImport/scan.ts`
- Test: `src/main/sessionImport/scan.test.ts`

**Defect:** `samePath` compares with `localeCompare(..., { sensitivity: "accent" })`,
which ignores case everywhere. On Linux and macOS with a case-sensitive volume,
`/home/u/Repo` and `/home/u/repo` are different folders and would be merged.

- [ ] **Step 1: Write the failing test**

Assert that on `process.platform === "win32"` the comparison stays
case-insensitive, and that a case-sensitive comparison is used otherwise —
inject the platform rather than branching on the real one, so both cases run on
any machine.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run src/main/sessionImport/scan.test.ts`

- [ ] **Step 3: Branch on the platform**

Keep separator normalisation and trailing-separator trimming for both. Fold case
only on Windows. The existing case-insensitive test ("filters by cwd
case-insensitively") uses Windows-style paths, so it must keep passing.

- [ ] **Step 4: Run and commit**

Run: `pnpm exec vitest run src/main/sessionImport`

```bash
git commit -am "fix(import): compare session folders case-sensitively off Windows"
```

---

### Task 11: Read transcripts line by line

**Severity:** memory.

**Files:**

- Modify: `src/main/sessionImport/claudeTranscript.ts`, `src/main/sessionImport/codexTranscript.ts`
- Test: `src/main/sessionImport/claudeTranscript.test.ts`

**Defect:** both parsers do `readFileSync(path, "utf8")` and then `split` — two
full copies of a transcript in memory, and rollouts of several megabytes are
ordinary (5.3 MB seen in the reviewed store; Claude project logs run larger).

- [ ] **Step 1: Write the failing test**

Assert the parser handles a transcript with no trailing newline and with CRLF
endings, and that parsing a file of a few thousand lines yields every message —
a regression net for the rewrite rather than a memory assertion, which Vitest
cannot make honestly.

- [ ] **Step 2: Run it and watch it fail**

Write the test so it fails against the current code if any case is mishandled;
if all pass, extend the cases until one fails or record in the commit message
that this task is a refactor covered by existing behaviour tests.

- [ ] **Step 3: Stream the file**

Read through a buffered descriptor, splitting on newlines and carrying the
remainder between chunks, so at most one chunk plus one line is held. Keep the
parsers' signatures and return shapes exactly as they are.

- [ ] **Step 4: Run and commit**

Run: `pnpm exec vitest run src/main/sessionImport`

```bash
git commit -am "perf(import): parse transcripts without loading the whole file"
```

---

### Task 12: Delete the unused head readers

**Severity:** cleanliness, plus one trap.

**Files:**

- Modify: `src/main/sessionImport/claudeTranscript.ts`, `src/main/sessionImport/codexTranscript.ts`
- Test: `src/main/sessionImport/claudeTranscript.test.ts`, `src/main/sessionImport/codexTranscript.test.ts`

**Defect:** `readClaudeSessionHead` and `readCodexSessionHead` are referenced
only by their own tests — the scan has its own head reader. `readClaudeSessionHead`
reads an entire multi-megabyte file to find a `cwd`, so leaving it around invites
someone to call it.

- [ ] **Step 1: Confirm they are unused**

Run: `rg "readClaudeSessionHead|readCodexSessionHead" src`
Expected: only their definitions and their own tests.

- [ ] **Step 2: Delete them with their tests and their types**

Remove the functions, the now-unused `ClaudeHead` / `CodexHead` interfaces if
nothing else uses them, and the test cases that only covered them.

- [ ] **Step 3: Run and commit**

Run: `pnpm exec vitest run src/main/sessionImport && pnpm lint && pnpm typecheck`

```bash
git commit -am "refactor(import): drop the unused transcript head readers"
```

---

## Notes for the implementer

- Task 1 edits a regex shared with the Codex parser. Run the whole
  `src/main/sessionImport` folder, not just the Claude test.
- Tasks 2, 3, 4, 7, 8 and 10 all edit `scan.ts`. Run them one after another, never
  in parallel.
- Task 7 adds a field to the same result type Task 8 adds a payload field to.
  Whichever lands second rebases onto the first rather than reverting it.
- The panel's `load` callback depends on the three filter fields. Task 8 adds the
  query to that payload — debounce it, or every keystroke rescans.
